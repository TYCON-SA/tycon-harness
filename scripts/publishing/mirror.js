#!/usr/bin/env node
'use strict';
// mirror.js — la sincronización de los repos internos con el repo público (épica 8, story 8.8 · 2026-10-03)
//
// POR QUÉ EXISTE: el arnés se publica como ESPEJO. Los repos internos son la fuente y el repo público es una copia que
// arma el exportador (`export.js`). Faltaba la mitad de afuera: llevar esa copia a GitHub sin que nadie empuje a mano,
// sin pisar lo que alguien mergeó allá, y pudiendo comprobar después —con la lista privada— que lo publicado no nombra
// a nadie. Este guion hace eso y nada más: la forma de la copia es del exportador, acá no se arma ningún árbol.
//
//   plan    dice qué pasaría, sin escribir nada: «no publicado», «sin cambios», «cambios» (con la cuenta y hasta 50
//           rutas) o «cambios ajenos sin traer».
//   first   la primera publicación: un commit raíz en `main` de un repo SIN refs, y después `verify --strict`.
//   sync    todo lo demás: un commit sobre la punta pública, empujado SÓLO a la rama `mirror/sync`, y UN pull request
//           hacia `main` que se va actualizando. Fuera de `first`, ningún camino de este archivo empuja a `main`.
//   verify  clona lo publicado y lo revisa con el detector y la lista privada.
//
// Antes de escribir, siempre: el exportador en 0, sus precondiciones (sin pendientes, un solo repo, los papeles, la
// licencia, las carpetas que no salen) y ninguna forma de secreto de proveedor en lo que se publicaría. Empujar ES
// publicar: en un repo público la rama se lee apenas llega; la aprobación del pull request decide qué entra a `main`,
// no qué se hace público.
//
// Lo que `sync` hace con lo que encuentra: sin refs, «todavía no publicado» (0) · un cambio ajeno sin absorber, 1 sin
// tocar nada · una sincronización más nueva en la rama, 0 sin tocar nada (una corrida vieja nunca retrocede el pull
// request) · el mismo árbol que `main`, «sin cambios» (0), y cierra el pull request que hubiera abierto · con cambios,
// empuja con `--force-with-lease` (si otra corrida empujó antes, relee UNA vez) y crea o actualiza el pull request.
// Antes de empujar lee las reglas de `main`: GitHub tiene que impedir, él también, lo que este guion nunca hace.
//
// LA VERSIÓN (story 8.13): el commit que se publica lleva `version.json` en su raíz —`YYYY.MM.DD.N` y el commit de cada
// fuente interna—. Lo agrega este guion sobre el árbol del exportador, que nunca lo trae: por eso el público se compara
// SIN ese archivo («sin cambios» no numera ni empuja), y el árbol del commit —y su trailer `Mirror-Tree`— es el final.
// El número sale de lo publicado y de los commits internos, nunca del reloj: un reintento da el mismo commit.
//
// UN SOLO REPO INTERNO (story 8.18): el arnés y agent-skills pasaron a ser un repo, con las dos historias unidas. Si el
// commit del arnés que se publica es de ese repo —lo dice su árbol, con el criterio del exportador—, la copia sale de
// UN commit y los dos trailers nombran ese mismo: lo publicado no cambia de forma (`version.json` con sus dos claves,
// `isSyncCommit` y `verify` leyendo dos trailers), así la primera sincronización después de la unión sigue la cadena
// de las que salieron de dos repos. Para eso el repo tiene que traer la historia de los dos: si la sincronización
// anterior nombra un commit que este repo no tiene en su historia, sale 2 nombrándolo, sin empujar — ahí viven las
// marcas de los cambios ajenos, y lo que no se ve no es «no hay». Con dos repos físicos todo sigue como estaba.
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
//   --direct           el público es la FUENTE (después del corte): las tres partes atadas a la sincronización desde
//                      lo interno —cambios ajenos, número de versión, transformados— dicen «no aplica», y los internos
//                      no se leen. Sólo `verify` lo acepta: los subcomandos que escriben se niegan.
//   --report <archivo> deja además el informe —lo mismo que `--json`— en ese archivo, también si frenó antes de mirar:
//                      de ahí arma su aviso el pipeline (scripts/ci/verify-notice.js). Nunca trae el texto hallado.
// Quedan afuera, a sabiendas: las discusiones y la wiki del repo (no se usan; se apagan en la configuración del repo).
//
// CÓMO FALLA: exit 0 = bien · 1 = hallazgos (los del exportador, cambios ajenos sin traer, un término de la lista en un
// texto que se iba a escribir, un push que GitHub rechazó —con su mensaje tal cual, sin reintentar—, o los de `verify`)
// · 2 = no pude, o falta una precondición. «No pude leer» nunca es «no hay nada»: sale 2 sin escribir. El repo público
// se nombra siempre como «el de public-repos.json» —su nombre vive sólo en ese archivo, que se lee con el lector del
// exportador—, y el token no aparece en ninguna salida.
//
// A mano:
//   node scripts/publishing/mirror.js plan|first|sync|verify [--harness <ref>] [--agent-skills <ref>] [--json]
//        [--strict] [--direct] [--report <archivo>]                    (sólo verify)
//        [--allowlist <f>] [--replacements <f>] [--denied <f>] [--public-repos <f>]   (pasan tal cual al exportador)
//   Los repos internos se ubican como los ubica el exportador (TYCON_GUIDES_DIR y TYCON_SKILLS_DIR). Por defecto, el
//   arnés en su HEAD y agent-skills en origin/main. En un solo repo interno hay UN commit, el del arnés: --agent-skills
//   sobra, y si nombra otro commit sale 2.
//   TYCON_MIRROR_TOKEN     el token (el único lugar de donde se toma). Sin él, `plan` y `verify` leen lo que es público.
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
const EXPORTER = path.join(__dirname, 'export.js');
const CONFIG_DIR = 'scripts/publishing';
const GUIDE = 'guides/publicacion-espejo.md';
const PUBLIC_REPO = 'el repo de public-repos.json';

// ── Constantes, nunca configurables ─────────────────────────────────────────────────────────────────────────────
const COMMANDS = Object.freeze(['plan', 'first', 'sync', 'verify']);
// la exportación que se publica: el núcleo y el paquete del stack, las dos fuentes en UN repo
const EXPORT = Object.freeze(['--package', 'core,bizuit', '--single-repo']);
const MAIN = 'refs/heads/main';
// la rama de la sincronización: fuera de `first`, lo único que este guion empuja
const SYNC_BRANCH = 'mirror/sync';
const SYNC = `refs/heads/${SYNC_BRANCH}`;
const CREDENTIAL_VARIABLE = 'TYCON_MIRROR_TOKEN';
const API_VARIABLE = 'TYCON_MIRROR_API_URL';
const DEFAULT_API = 'https://api.github.com';
const GIT_BASE_VARIABLE = 'TYCON_MIRROR_GIT_BASE';
const DEFAULT_GIT_BASE = 'https://github.com';
// sin cifrar sólo hacia la propia máquina: por http:// el token viajaría a la vista de cualquiera en el camino
const LOCAL_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);
// los trailers que escribe la sincronización, y las marcas que lee en la historia interna
const TRAILERS = Object.freeze({ harness: 'Mirror-Harness-Commit', skills: 'Mirror-Agent-Skills-Commit', tree: 'Mirror-Tree' });
const MARKS = Object.freeze({ absorbed: 'Public-Commit', discarded: 'Public-Commit-Discarded' });
// story 8.13 (AC 24): las fuentes de `source` en `version.json`, cada una con SU trailer. La parte (i) de `verify`
// compara clave por clave y exige que el conjunto sea el de los trailers que el commit trae: no cuenta cuántas son.
const VERSION_SOURCES = Object.freeze({ harness: TRAILERS.harness, agent_skills: TRAILERS.skills });
// las opciones de configuración: pasan tal cual al exportador; su archivo por defecto vive al lado de este guion
const CONFIG = Object.freeze([
  { option: '--allowlist', key: 'allowlist', file: 'allowlist.json' },
  { option: '--replacements', key: 'replacements', file: 'replacements.json' },
  { option: '--denied', key: 'denied', file: 'denylist.json' },
  { option: '--public-repos', key: 'publicRepos', file: 'public-repos.json' },
]);
const NAME_OK = /^[A-Za-z0-9._-]+$/;
const MAX_PATHS = 50;
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

// ── Lo que tiene que estar antes de publicar ────────────────────────────────────────────────────────────────────
const PAPERS = Object.freeze(['LICENSE', 'NOTICE', '.github/README.md', '.github/README.es.md', '.github/CONTRIBUTING.md',
  '.github/CODE_OF_CONDUCT.md', '.github/SECURITY.md']);
const LICENSE_MARKS = Object.freeze(['Apache License', 'Version 2.0']);
// Dos carpetas que no pueden salir con ese nombre. El de la segunda va por partes: es el nombre de ADENTRO de una skill
// que la copia publica con otro, y el exportador reescribe ese nombre en cada archivo de texto que sale (éste también).
const FORBIDDEN_FOLDERS = Object.freeze([
  { folder: 'skills/bizuit-sdd', why: 'no se publica' },
  { folder: ['skills/bmad', 'create', 'story'].join('-'), why: 'sale con otro nombre: la lista blanca la renombra (skillRenames)' },
]);
// Las formas de secreto de PROVEEDOR: las reglas del detector que reconocen un valor por su forma, elegidas por nombre.
// Se miran SIN las excepciones del equipo (`permitidos`): el escaneo de secretos de GitHub no las lee, y el primer
// escaneo llega cuando el repo pasa a público, que no tiene vuelta. Las reglas que reconocen un secreto por el nombre
// de la variable o por la forma de una cadena de conexión quedan afuera: frenan donde siempre, en el exportador.
const PROVIDER_RULES = Object.freeze(['sas-azure', 'token-github', 'llave-anthropic', 'llave-openai', 'token-telegram', 'llave-aws', 'llave-privada', 'jwt']);
// Una forma de proveedor que el detector no tiene: los tokens de Slack empiezan con xox y una letra que dice de qué
// tipo son (bot, usuario, aplicación…), y GitHub los escanea igual que los suyos.
const EXTRA_PROVIDER_RULES = Object.freeze([
  { nombre: 'token-slack', categoria: 'secreto', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
]);

const STATES = Object.freeze({
  unpublished: 'no publicado',
  unchanged: 'sin cambios',
  changes: 'cambios',
  'foreign-changes': 'cambios ajenos sin traer',
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
/** La fecha y el número que sigue de una versión: la librería que comparten esta sincronización y el merge por pedido. */
function versionOrder() {
  try {
    return require('../setup/harness/version-order.js');
  } catch (e) {
    throw couldNot(`no pude cargar la regla del número de versión, scripts/setup/harness/version-order.js (${(e && e.code) || (e && e.message) || e})`);
  }
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
  if (!COMMANDS.includes(command)) {
    throw couldNot(`subcomando desconocido: «${command === undefined ? '' : command}» (los que hay: ${COMMANDS.join(', ')})`);
  }
  const valued = new Map([['--harness', 'harness'], ['--agent-skills', 'agentSkills'], ...CONFIG.map((c) => [c.option, c.key])]);
  const args = { command };
  for (let i = 1; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') args.json = true;
    else if (x === '--strict') {
      if (command !== 'verify') throw couldNot('--strict es sólo de verify');
      args.strict = true;
    } else if (x === '--direct') {
      // story 8.26, tanda F2 (AC 24): el público es la fuente. Sólo `verify` lo entiende: los que escriben
      // (`first`, `sync`) arman la copia desde lo interno, y con el público como fuente eso sería pisarlo.
      if (command !== 'verify') throw couldNot('--direct es sólo de verify: con el público como fuente no se sincroniza desde lo interno');
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
      // ahí queda el listado privado de reemplazos del exportador: se dice, no se traga
      process.stderr.write(`⚠️ mirror: no pude borrar el temporal ${d} (${(e && e.code) || e}) — borralo a mano\n`);
    }
  }
}

// ── Los repos internos y sus commits ────────────────────────────────────────────────────────────────────────────
/** Un repo interno, en su carpeta: tiene que estar y ser un repo de git. */
function internalRepo(name, dir) {
  if (!fs.existsSync(dir)) throw couldNot(`el repo interno de ${name} no está en ${dir}`);
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) throw couldNot(`${dir} no es un repo de git (${name}): ${String(r.stderr).trim()}`);
  return { name, dir };
}

/** Los repos internos, ubicados como los ubica el exportador (que no exporta esa función: es la misma regla). */
function locateHarness() {
  const given = process.env.TYCON_GUIDES_DIR && process.env.TYCON_GUIDES_DIR.trim();
  return internalRepo('el arnés', given ? path.resolve(given.replace(/^~(?=$|[\\/])/, os.homedir())) : OWN_ROOT);
}
function locateSkills() {
  let dir;
  try {
    dir = require('../lib/skills-dir.js').resolveSkillsDirs(process.env.TYCON_SKILLS_DIR).repo;
  } catch (e) {
    throw couldNot(`no pude ubicar agent-skills (scripts/lib/skills-dir.js: ${(e && e.code) || (e && e.message) || e})`);
  }
  return internalRepo('agent-skills', dir);
}

// story 8.18: qué es «el repo único». Lo dice el ÁRBOL del commit del arnés que se publica, no el disco: si trae las
// skills del pipeline, los revisores y la lista blanca del equipo en la misma raíz, el arnés y agent-skills son ese
// repo, y el otro clon ni se busca (en una máquina en transición sigue ahí, en otro commit, y no es de donde sale la
// copia). Es el criterio del exportador —`unifiedTree` de new-names.js, que desde acá no se puede cargar sin traer
// medio arnés—: los dos tienen que decir lo mismo del mismo commit, y `mirror.test.js` los cruza. Un commit de antes de
// la unión, o el arnés de juguete de las pruebas, no tiene esa forma: ahí hay dos repos, como siempre.
const SINGLE_REPO_SHAPE = Object.freeze({ pipeline: 'skills/tycon-pipeline/', reviewers: 'agents/', list: `${CONFIG_DIR}/allowlist.json` });
function isSingleRepoTree(paths) {
  const has = { pipeline: false, reviewers: false, list: false };
  for (const p of paths) {
    if (p.startsWith(SINGLE_REPO_SHAPE.pipeline)) has.pipeline = true;
    else if (p.startsWith(SINGLE_REPO_SHAPE.reviewers)) has.reviewers = true;
    else if (p === SINGLE_REPO_SHAPE.list) has.list = true;
  }
  return has.pipeline && has.reviewers && has.list;
}

/** Una referencia, resuelta UNA vez a un sha: de ahí en más la corrida usa el sha. */
function resolveRef(repo, ref) {
  const r = git(repo.dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = String(r.stdout).trim();
  if (r.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw couldNot(`no encuentro el commit «${ref}» en ${repo.name} (${repo.dir})`);
  const date = Number(gitOut(repo.dir, ['log', '-1', '--format=%ct', sha]).trim());
  if (!Number.isInteger(date)) throw couldNot(`no pude leer la fecha del commit ${short(sha)} de ${repo.name}`);
  return { ref, sha, date };
}

/**
 * Contenido y configuración tienen que salir del mismo commit: el exportador lee su configuración del disco y el
 * contenido de un sha. Devuelve lo que no cierra; `plan` lo avisa, y lo que escribe (`first`, `sync`) no arranca.
 * La regla vale para los archivos de configuración POR DEFECTO: uno pasado por opción no se compara.
 */
function sameCommitProblems(ctx) {
  const problems = [];
  const head = git(ctx.repos.harness.dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const headSha = head.status === 0 ? String(head.stdout).trim() : '';
  if (headSha !== ctx.harness.sha) {
    problems.push(`el commit del arnés que se exportaría (${short(ctx.harness.sha)}) no es el HEAD de su clon (${headSha ? short(headSha) : 'no tiene'}): `
      + 'el exportador y su configuración se leen del árbol de trabajo, y el contenido saldría de otro commit');
  }
  for (const c of CONFIG) {
    if (ctx.args[c.key]) continue;
    const rel = `${CONFIG_DIR}/${c.file}`;
    let disk = null;
    try {
      disk = fs.readFileSync(path.join(OWN_ROOT, rel));
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw couldNot(`no pude leer ${rel} (${(e && e.code) || e})`);
    }
    const blob = git(ctx.repos.harness.dir, ['cat-file', 'blob', `${ctx.harness.sha}:${rel}`], { binario: true });
    const committed = blob.status === 0 ? blob.stdout : null;
    if (disk === null && committed === null) continue;   // no está en ningún lado: lo dice quien lo necesite
    if (disk === null || committed === null || !disk.equals(committed)) {
      problems.push(`${rel} del árbol de trabajo difiere del que trae el commit ${short(ctx.harness.sha)}: la configuración y el contenido saldrían de commits distintos`);
    }
  }
  return problems;
}

/**
 * Los dos internos y el commit de cada uno: por defecto, el arnés en su HEAD y agent-skills en origin/main.
 *
 * story 8.18 (AC 23): si el commit del arnés es del repo único (`isSingleRepoTree`), hay UN commit, y es también el de
 * agent-skills —los dos trailers lo nombran—. Ahí «origin/main» no es el commit de agent-skills: es otro commit del
 * mismo repo. Si `--agent-skills` viene, tiene que nombrar ese mismo commit: de un repo no salen dos.
 */
function resolveCommits(ctx) {
  if (ctx.repos) return;
  const harness = locateHarness();
  ctx.harness = resolveRef(harness, ctx.args.harness || 'HEAD');
  const single = isSingleRepoTree(exporter().listarArbol(harness, ctx.harness.sha).map((e) => e.ruta));
  if (!single) {
    ctx.repos = { harness, skills: locateSkills(), single };
    ctx.skills = resolveRef(ctx.repos.skills, ctx.args.agentSkills || 'origin/main');
    return;
  }
  // la parte de agent-skills se lee del mismo repo que el arnés, y de ese mismo commit
  ctx.repos = { harness, skills: { name: 'agent-skills', dir: harness.dir }, single };
  if (ctx.args.agentSkills) {
    const asked = resolveRef(ctx.repos.skills, ctx.args.agentSkills);
    if (asked.sha !== ctx.harness.sha) {
      throw couldNot(`el arnés y agent-skills son un solo repo interno (${harness.dir}): la copia sale de UN commit, y --agent-skills `
        + `(«${ctx.args.agentSkills}», ${short(asked.sha)}) nombra otro que el del arnés (${short(ctx.harness.sha)}). Sacá --agent-skills, o pasale el mismo commit`);
    }
  }
  ctx.skills = { ...ctx.harness, ref: ctx.args.agentSkills || ctx.harness.ref };
}

function resolveInternal(ctx) {
  resolveCommits(ctx);
  ctx.warnings = sameCommitProblems(ctx);
}

/** Lo que escribe no arranca si contenido y configuración no salen del mismo commit. */
function refuseOtherCommit(ctx) {
  if (ctx.warnings.length) throw couldNot(`no publico así:\n  · ${ctx.warnings.join('\n  · ')}`);
}

function requireToken(ctx) {
  if (!ctx.token) throw couldNot(`${ctx.args.command} escribe en ${PUBLIC_REPO} y falta el token (${CREDENTIAL_VARIABLE}): no se toma de ningún otro lado`);
}

// ── El exportador, una vez ──────────────────────────────────────────────────────────────────────────────────────
/** Los hallazgos del exportador, por dónde están: nunca el texto hallado (la salida no es un canal privado). */
function exporterFindings(ctx, json) {
  const found = [];
  // Una ruta con un hallazgo ES lo hallado: se cuenta, no se imprime — tampoco cuando ese archivo tiene además OTRO
  // hallazgo adentro. Sin la lista no se puede saber cuál es: no se imprime ninguna.
  const hidden = (file) => {
    try {
      return isFinding(ctx, file, ROUTES.paths);
    } catch (e) {
      if (e instanceof Stop) return true;
      throw e;
    }
  };
  const add = (section, list, conFile = true) => {
    for (const h of Array.isArray(list) ? list : []) {
      const file = h && (h.archivo || h.file);
      const shown = conFile && typeof file === 'string' && !file.startsWith('(ruta)') && !hidden(file) ? publicText(file) : null;
      found.push({ section, file: shown, line: Number((h && (h.linea || h.line)) || 0), category: (h && h.categoria) || null });
    }
  };
  for (const [name, list] of Object.entries((json && json.controles) || {})) add(name, list);
  for (const [name, r] of Object.entries((json && json.detector) || {})) {
    if (name === 'metadatos') for (const m of Object.values(r || {})) add('detector: metadatos del commit', m && m.hallazgos, false);
    else if (name === 'rutas') add('detector: rutas de la copia', r && r.hallazgos, false);
    else add('detector', r && r.hallazgos);
  }
  return found;
}

const REASON_MAX = 240;
/** Por qué murió un proceso hijo, en UNA línea recortada: la del error si la hay (no la pila), o la última que escribió. */
function childReason(stderr) {
  const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /^[A-Za-z]*Error(?: \[[^\]]+\])?: /.test(l)) || lines[lines.length - 1] || '';
  return publicText(line, REASON_MAX);
}

function exporterSummary(findings) {
  const sections = new Map();
  for (const f of findings) sections.set(f.section, [...(sections.get(f.section) || []), f]);
  const lines = [];
  for (const [section, list] of sections) {
    const places = list.filter((f) => f.file).slice(0, 10).map((f) => `${f.file}${f.line ? `:${f.line}` : ''}${f.category ? ` [${f.category}]` : ''}`);
    lines.push(`  · ${section}: ${list.length}${places.length ? ` — ${places.join(', ')}${list.length > places.length ? ', …' : ''}` : ''}`);
  }
  return lines;
}

/**
 * Corre el exportador UNA vez, con los shas ya resueltos. Con 1 (hallazgos) o 2 (no pudo) la corrida termina con ese
 * mismo código y su resumen. El listado privado de reemplazos queda en el temporal de la corrida y se va con él.
 */
function runExporter(ctx) {
  const dir = path.join(ctx.tmp, 'copy');
  const argv = [EXPORTER, ...EXPORT, '--output', dir, '--report', path.join(ctx.tmp, 'export-report.md'),
    '--harness', ctx.harness.sha, '--agent-skills', ctx.skills.sha, '--json'];
  for (const c of CONFIG) if (ctx.args[c.key]) argv.push(c.option, path.resolve(ctx.args[c.key]));
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) throw couldNot(`no pude correr el exportador (${r.error.code || r.error.message})`);
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch (_) {
    json = null;
  }
  // Un 1 es «hallazgos» sólo si los trae: un exportador que muere con 1 sin un JSON que se entienda, o sin ningún
  // hallazgo adentro (node sale 1 ante un error que nadie atajó), no encontró nada — no pudo. Es un 2, con su motivo.
  const findings = r.status === 1 ? exporterFindings(ctx, json) : [];
  if (findings.length) {
    throw new Stop(1, [`el exportador salió 1: ${findings.length} hallazgo(s) en lo que se publicaría — no se escribió nada en ${PUBLIC_REPO}`,
      ...exporterSummary(findings),
      `  El detalle, a mano: node ${CONFIG_DIR}/export.js ${EXPORT.join(' ')} --output <carpeta nueva>`].join('\n'),
    { exporter: { exit: 1, findings } });
  }
  if (r.status !== 0 || !json) {
    const said = r.status === 1 ? childReason(r.stderr) : String(r.stderr || '').trim().split('\n').slice(-5).join(' | ');
    const reason = (json && typeof json.motivo === 'string' && json.motivo) || said || `salió ${r.status} sin decir por qué`;
    throw couldNot(`el exportador no pudo armar la copia (salió ${r.status}) — no se escribió nada en ${PUBLIC_REPO}:\n  ${reason}`,
      { exporter: { exit: r.status === 0 ? 2 : r.status, reason } });
  }
  return { dir, json };
}

/** Las precondiciones de la publicación (AC 2): se dicen todas juntas, cada una por su nombre. */
function checkPreconditions(copy) {
  const { json } = copy;
  const problems = [];
  const pending = Array.isArray(json.pendientes) ? json.pendientes : null;
  if (!pending) problems.push('el --json del exportador no trae «pendientes»: no sé si queda algo de otra story');
  else if (pending.length) {
    problems.push(`${pending.length} pendiente(s) de otra story — con pendientes no se publica: ${pending.map((p) => `${p.ruta} (hasta ${p.hasta})`).join(', ')}`);
  }
  const repos = Object.keys(json.repos || {});
  if (repos.length !== 1) {
    problems.push(`la exportación trae ${repos.length} repos: el público es uno solo`);
    throw couldNot(`faltan precondiciones de la publicación:\n  · ${problems.join('\n  · ')}`);
  }
  const tree = exporter().listarArbol({ dir: copy.dir }, 'HEAD');
  const paths = new Set(tree.map((e) => e.ruta));
  for (const p of PAPERS) if (!paths.has(p)) problems.push(`falta ${p} en lo que se publicaría`);
  if (paths.has('LICENSE')) {
    const text = fs.readFileSync(path.join(copy.dir, 'LICENSE'), 'utf8');
    const absent = LICENSE_MARKS.filter((m) => !text.includes(m));
    if (absent.length) problems.push(`el LICENSE no es Apache-2.0 (no dice ${absent.map((m) => `«${m}»`).join(' ni ')})`);
  }
  for (const f of FORBIDDEN_FOLDERS) {
    if (tree.some((e) => e.ruta.startsWith(`${f.folder}/`))) problems.push(`lo que se publicaría trae ${f.folder}/: ${f.why}`);
  }
  // story 8.13 (AC 24): el archivo de la versión lo agrega la sincronización encima de esta copia. Si la copia ya lo
  // trae, salió de una fuente, y agregarlo lo pisaría sin avisar
  const versionName = versionFile();
  if (tree.some((e) => e.ruta === versionName || e.ruta.startsWith(`${versionName}/`))) {
    problems.push(`lo que se publicaría ya trae ${versionName}: lo agrega la sincronización, no sale de una fuente (la lista blanca lo declara en «generated»)`);
  }
  if (problems.length) throw couldNot(`faltan precondiciones de la publicación:\n  · ${problems.join('\n  · ')}`);
  copy.paths = tree.map((e) => e.ruta);
  copy.tree = gitOut(copy.dir, ['rev-parse', '--verify', 'HEAD^{tree}']).trim();
}

/** Las formas de secreto de proveedor en lo que se publicaría (AC 3), sin las excepciones del equipo. */
function checkProviderShapes(copy) {
  const d = detector();
  const known = new Map((d.PATRONES_GENERICOS || []).map((p) => [p.nombre, p]));
  const gone = PROVIDER_RULES.filter((n) => !known.has(n));
  if (gone.length) throw couldNot(`el detector ya no trae la regla ${gone.join(', ')}: sin ella no puedo decir que lo que se publica no tiene esa forma de secreto`);
  const cfg = { reglas: [...PROVIDER_RULES.map((n) => known.get(n)), ...EXTRA_PROVIDER_RULES], permitidos: [], emailsPermitidos: new Set() };
  const found = [];
  for (const rel of copy.paths) {
    const data = fs.readFileSync(path.join(copy.dir, rel));
    if (d.esBinario(data)) continue;
    // el detector ya devuelve enmascarado el texto de esta categoría (4 caracteres y ***)
    for (const h of d.reviewText(cfg, data.toString('utf8'), rel).hallazgos) found.push({ file: h.archivo, line: h.linea, rule: h.regla, masked: h.texto });
  }
  if (!found.length) return;
  throw couldNot([`${found.length} valor(es) con forma de secreto de proveedor en lo que se publicaría — el escaneo de GitHub no lee las excepciones del equipo:`,
    ...found.map((h) => `  · ${h.file}:${h.line}  [${h.rule}]  ${h.masked}`),
    '  Armalo por partes en el interno (que ninguna línea traiga el valor entero) y volvé a correr.'].join('\n'), { secretShapes: found });
}

function exportAndCheck(ctx) {
  const copy = runExporter(ctx);
  checkPreconditions(copy);
  checkProviderShapes(copy);
  copy.replacements = Object.values(copy.json.reemplazos || {}).reduce((n, x) => n + Number(x || 0), 0);
  return copy;
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

/** Las refs del público, con UNA pregunta. Un repo recién creado no tiene ninguna. */
function remoteRefs(ctx) {
  const r = remoteGit(ctx, ctx.tmp, ['ls-remote', ctx.remote]);
  if (r.status !== 0) throw couldNot(unreadable(ctx, r.stderr));
  const refs = new Map();
  for (const line of String(r.stdout).split('\n')) {
    const m = /^([0-9a-f]{40,64})\t(refs\/\S+)$/.exec(line);
    if (m) refs.set(m[2], m[1]);
  }
  return refs;
}

/** Trae `main` del público (y la rama de la sincronización, si está) al repo de la copia, bajo refs propias. */
function fetchPublic(ctx, dir, refs) {
  const specs = [`+${MAIN}:refs/mirror/main`];
  if (refs.has(SYNC)) specs.push(`+${SYNC}:refs/mirror/sync`);
  const r = remoteGit(ctx, dir, ['fetch', '--quiet', '--no-tags', ctx.remote, ...specs]);
  if (r.status !== 0) throw couldNot(unreadable(ctx, r.stderr));
  const tip = (ref) => gitOut(dir, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  return { main: tip('refs/mirror/main'), sync: refs.has(SYNC) ? tip('refs/mirror/sync') : null };
}

// ── Cambios ajenos (AC 8) ───────────────────────────────────────────────────────────────────────────────────────
const trailer = (body, key) => {
  const m = new RegExp(`^${key}:[ \\t]*(\\S+)[ \\t]*$`, 'm').exec(String(body));
  return m ? m[1] : null;
};
const treeOf = (dir, sha) => gitOut(dir, ['rev-parse', '--verify', `${sha}^{tree}`]).trim();
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

/**
 * ¿Es un commit de la sincronización? Devuelve el commit, o null. Tiene que ser lo que arma `makeCommit`: la identidad
 * fija de la copia como autor y como committer, a lo sumo UN padre, los tres trailers —los dos de los commits internos,
 * con forma de sha—, y el del árbol igual a su árbol de verdad.
 *
 * OJO, esto NO es una prueba de origen: la identidad y los trailers son públicos y quien quiera los copia. Sirve contra
 * el descuido y contra el trailer suelto; un commit armado a propósito con los cuatro datos pasa igual. La prueba de
 * verdad —que el árbol sea la exportación de esos dos commits internos, o que el pull request mergeado haya salido de
 * la rama de la sincronización del propio repo— queda para la tanda de las contribuciones.
 */
function isSyncCommit(dir, sha) {
  const [commit] = readCommits(dir, [sha]);
  const id = commitIdentity();
  const fixed = `${id.nombre} <${id.email}>`;
  if (commit.parents.length > 1 || commit.author !== fixed || commit.committer !== fixed) return null;
  if (![TRAILERS.harness, TRAILERS.skills].every((key) => SHA.test(trailer(commit.message, key) || ''))) return null;
  return trailer(commit.message, TRAILERS.tree) === commit.tree ? commit : null;
}

/** La historia interna tiene que estar entera: en un clon superficial, lo que no se trajo no es «no hay marca». */
function requireFullHistory(repo) {
  const r = git(repo.dir, ['rev-parse', '--is-shallow-repository']);
  const answer = r.status === 0 ? String(r.stdout).trim() : '';
  if (answer === 'false') return;
  throw couldNot(answer === 'true'
    ? `no pude leer la historia de ${repo.name}: el clon de ${repo.dir} es superficial (shallow), y una marca ${MARKS.absorbed} o un commit `
      + 'con el que comparar pueden estar en lo que no trajo. Traé la historia completa (un clon entero, sin profundidad recortada) y volvé a correr'
    : `no pude leer la historia de ${repo.name} (${repo.dir}): git no dijo si el clon está completo`);
}

/** Los shas del público que la historia interna ya absorbió: los que nombra una marca, la haya escrito quien la haya escrito. */
function internalMarks(ctx) {
  // en un solo repo interno (story 8.18) hay una historia que leer, y trae las de los dos: se lee una vez
  const sources = ctx.repos.single ? [[ctx.repos.harness, ctx.harness.sha]] : [[ctx.repos.harness, ctx.harness.sha], [ctx.repos.skills, ctx.skills.sha]];
  for (const [repo] of sources) requireFullHistory(repo);
  const marks = new Map();
  const absorbed = new RegExp(`^${MARKS.absorbed}:[ \\t]*([0-9a-f]{40,64})[ \\t]*$`, 'gm');
  const discarded = new RegExp(`^${MARKS.discarded}:`, 'm');
  for (const [repo, at] of sources) {
    // git elige los commits, y cada mensaje se lee del objeto: sin un separador que el mensaje pueda traer adentro
    const shas = gitOut(repo.dir, ['rev-list', `--grep=^${MARKS.absorbed}:`, at]).split('\n').filter(Boolean);
    for (const { message } of readCommits(repo.dir, shas)) {
      for (const m of message.matchAll(absorbed)) marks.set(m[1], { discarded: discarded.test(message) || Boolean(marks.get(m[1]) && marks.get(m[1]).discarded) });
    }
  }
  return marks;
}

/**
 * La cadena de primer padre del `main` público y su última sincronización mergeada (`anchor`: el commit, o null): el
 * commit hasta el que el público es lo que publicó el interno. Una sincronización mergeada es un merge cuyo segundo
 * padre es un commit de la sincronización; la primera publicación es la raíz.
 */
function syncChain(dir, tip) {
  // la cadena, una línea por commit con sus padres y SIN su mensaje: nada que un mensaje pueda partir
  const records = gitOut(dir, ['log', '--first-parent', '--format=%H %P', tip]).split('\n').filter(Boolean).map((line) => {
    const [sha, ...parents] = line.split(' ').filter(Boolean);
    return { sha, parents };
  });
  const seen = new Map();   // cada merge de la cadena se mira una vez
  const mergedSync = (c) => {
    if (!seen.has(c.sha)) seen.set(c.sha, c.parents.length >= 2 ? isSyncCommit(dir, c.parents[1]) : null);
    return seen.get(c.sha);
  };
  let anchor = null;
  for (const c of records) {
    anchor = mergedSync(c) || (!c.parents.length ? isSyncCommit(dir, c.sha) : null);
    if (anchor) break;
  }
  return { records, mergedSync, anchor };
}

/**
 * story 8.18 (AC 24): en un solo repo interno, la sincronización anterior tiene que haber salido de commits que ESTE
 * repo tiene en su historia. La que se publicó desde dos repos nombra dos commits distintos —el del arnés y el de
 * agent-skills—, y los dos están en la historia unida: con eso el commit nuevo sigue la cadena, sobre la punta pública.
 * Si este repo no conoce alguno (un clon recortado, o la historia de agent-skills sin unir), las marcas de los cambios
 * ajenos que viven en esa historia tampoco se ven: sale 2 nombrando el commit y la causa, antes de decidir nada.
 *
 * Pasa lo que ya pasaba: el mismo commit, uno anterior al que se publica (lo normal) y uno posterior (una corrida vieja:
 * la decide lo de siempre, más abajo). Con dos repos físicos no se mira: sigue como estaba.
 */
function requirePreviousSync(ctx, anchor) {
  if (!ctx.repos.single || !anchor) return;
  const repo = ctx.repos.harness;
  const own = ctx.harness.sha;
  const isAncestor = (older, newer) => git(repo.dir, ['merge-base', '--is-ancestor', older, newer]).status;
  for (const [source, key] of [['el arnés', TRAILERS.harness], ['agent-skills', TRAILERS.skills]]) {
    const theirs = trailer(anchor.message, key);
    if (theirs === own) continue;
    const before = isAncestor(theirs, own);
    if (before === 0 || (before === 1 && isAncestor(own, theirs) === 0)) continue;
    const previous = `la sincronización anterior (el commit ${short(anchor.sha)} de main, en ${PUBLIC_REPO}) salió del commit ${theirs} de ${source}`;
    if (before === 1) {
      throw couldNot(`${previous}, que no está en la historia del commit que se publicaría (${short(own)}): se estaría publicando desde una rama `
        + `que no trae lo ya publicado. No empujo nada. Qué hacer: ${GUIDE}, §«Un solo repo interno»`);
    }
    const shallow = String(git(repo.dir, ['rev-parse', '--is-shallow-repository']).stdout).trim() === 'true';
    const cause = shallow ? 'el clon es superficial (shallow): traé la historia completa y volvé a correr'
      : source === 'agent-skills' ? 'la historia de agent-skills no está unida en este repo'
        : 'a este clon le falta esa parte de la historia';
    throw couldNot(`${previous}, y este repo (${repo.dir}) no lo conoce: ${cause}. Sin ese commit no se ven las marcas ${MARKS.absorbed} `
      + `de esa historia, y lo que no se ve no es «no hay»: no empujo nada. Qué hacer: ${GUIDE}, §«Un solo repo interno»`);
  }
}

/**
 * Los cambios ajenos del `main` público: cada commit de su cadena de primer padre que la última sincronización
 * mergeada no contiene y que no es él mismo una sincronización mergeada (`syncChain`). Cada uno dice si la historia
 * interna ya lo absorbió (con la marca `Public-Commit: <sha>`), y si fue para descartarlo.
 */
function foreignChanges(ctx, dir, tip, chain = syncChain(dir, tip)) {
  const { records, mergedSync } = chain;
  const anchor = chain.anchor && chain.anchor.sha;
  const outside = new Set(gitOut(dir, ['rev-list', '--first-parent', tip, ...(anchor ? ['--not', anchor] : [])]).split('\n').filter(Boolean));
  const marks = internalMarks(ctx);
  return records.filter((c) => outside.has(c.sha) && !mergedSync(c)).map((c) => {
    // con -z: sin él, git escribe entre comillas y con escapes una ruta que no es ASCII, y no es la que da `treeDiff`
    const names = c.parents.length
      ? gitOut(dir, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', c.parents[0], c.sha])
      : gitOut(dir, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--root', '--no-commit-id', c.sha]);
    const mark = marks.get(c.sha);
    const paths = names.split('\0').filter(Boolean).slice(0, MAX_PATHS).map((p) => printablePath(ctx, p));
    return { commit: c.sha, paths, absorbed: Boolean(mark), discarded: Boolean(mark && mark.discarded) };
  });
}

/** El mensaje de «cambios ajenos sin traer»: el sha, las rutas y la marca que lo resuelve. */
function foreignMessage(pending) {
  return [`${STATES['foreign-changes']}: ${pending.length} commit(s) de main, en ${PUBLIC_REPO}, que la historia interna no absorbió`,
    ...pending.flatMap((f) => [`  · ${f.commit} — ${f.paths.join(', ') || '(sin rutas)'}`, `    la marca que lo resuelve, en un commit del interno: ${MARKS.absorbed}: ${f.commit}`]),
    '  Los dos comandos que escriben esa marca —`import --commit <sha>` para traer el cambio, y con `--discard "<motivo>"`',
    '  para descartarlo— llegan con la tanda C de la story 8.8: todavía no existen.',
    `  Hasta entonces la marca se pone a mano: ${GUIDE}, §«Cambios ajenos».`].join('\n');
}

// ── Qué pasaría: el estado ──────────────────────────────────────────────────────────────────────────────────────
const DIFF_STATUS = Object.freeze({ A: 'added', M: 'modified', D: 'deleted', T: 'modified' });
function treeDiff(dir, from, to) {
  const parts = gitOut(dir, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to]).split('\0');
  const all = [];
  for (let i = 0; i + 1 < parts.length; i += 2) all.push({ status: DIFF_STATUS[parts[i][0]] || 'modified', path: parts[i + 1] });
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const p of all) counts[p.status] += 1;
  return { counts, paths: all.slice(0, MAX_PATHS), pathsOmitted: Math.max(0, all.length - MAX_PATHS) };
}

// Una ruta que ES un hallazgo no se imprime: se cuenta, y en su lugar va esto. Una ruta BORRADA sale del árbol público,
// no del interno: si lleva un nombre que la lista aprendió después de publicarla, sacarla es justamente el arreglo.
const HIDDEN_PATH = '(una ruta con un hallazgo: no se imprime)';

/** ¿Este texto trae algo de la lista, mirado bajo esa ruta ficticia? (una ruta, o la línea que la nombra) */
function isFinding(ctx, text, route) {
  const cfg = loadList(ctx, 'no puedo decir qué rutas se pueden imprimir: se revisan con la lista privada');
  return detector().reviewText(cfg, String(text), route).hallazgos.length > 0;
}
/** La ruta como se puede imprimir: ella misma —en una línea—, o el aviso de que no se imprime. */
const printablePath = (ctx, rel) => (isFinding(ctx, rel, ROUTES.paths) ? HIDDEN_PATH : publicText(rel));

// ── La versión numerada (story 8.13, AC 24) ─────────────────────────────────────────────────────────────────────
// `version.json` va en la raíz de lo publicado: `YYYY.MM.DD.N` y el commit de cada fuente interna. Lo agrega ESTE guion
// y no el exportador, porque el número depende de lo que el público tiene y el exportador corre antes de leerlo. La
// forma del archivo sí es del exportador: su nombre, la forma del número y la función que arma sus bytes salen de ahí.
//
// La regla del número (decisión D1): la fecha es la del commit de la sincronización —la mayor fecha de committer de los
// commits internos, en UTC—, y `N` es 1 más el mayor `N` entre el de la punta de `main` y el de la punta de la rama de
// la sincronización, contando sólo los de esa misma fecha; si ninguno es de esa fecha, 1. Nada de esto mira el reloj ni
// el huso de la máquina: las mismas entradas dan el mismo número, corran cuando corran.

/** El nombre del archivo de la versión: la constante del exportador, que no se copia en este archivo. */
function versionFile() {
  const name = exporter().VERSION_FILE;
  if (typeof name !== 'string' || !name) throw couldNot('el exportador no exporta el nombre del archivo de la versión (VERSION_FILE)');
  return name;
}

/**
 * La fecha UTC de un instante (segundos desde 1970) como `YYYY.MM.DD`. Sale por aritmética —de días desde 1970 a año,
 * mes y día del calendario gregoriano—: no pregunta la hora ni el huso a la máquina.
 */
// La cuenta vive en scripts/setup/harness/version-order.js, que viaja en la copia: el merge por pedido también numera
// y este archivo no viaja. Acá sólo se le pone el código de salida de la sincronización (2, «no pude») a lo que tira.
function versionDay(epoch) {
  try { return versionOrder().day(epoch); } catch (e) { throw couldNot(e.message); }
}

/** La fecha (`YYYY.MM.DD`) y el orden en el día (`N`) de una versión con forma. */
function versionParts(version) {
  return versionOrder().parts(version);
}

/**
 * La versión que sigue (D1): `day` y 1 más el mayor orden de las publicadas con ESA fecha; si ninguna es de esa fecha,
 * 1. `published` trae la de `main` y la de la rama de la sincronización (`null` = esa punta no trae el archivo). Una
 * publicada sin forma no cuenta como «no hay»: tira.
 */
function nextVersion(day, published) {
  try { return versionOrder().next(day, published); } catch (e) { throw couldNot(e.message); }
}

/**
 * El `version.json` del árbol de un commit, tal como está: `{ present: false }` si no lo trae; con `problem` si está y no
 * se deja leer (no es un archivo regular, no es JSON, su versión no tiene forma o `source` no es un mapa de fuente a
 * commit); y si no, su blob, su texto, la versión y `source`. No cuenta cuántas fuentes trae `source`.
 */
function versionFileAt(dir, commit) {
  const ex = exporter();
  const entry = gitOut(dir, ['ls-tree', '-z', commit, '--', versionFile()]).split('\0').filter(Boolean)[0];
  if (!entry) return { present: false };
  const m = /^(\d{6}) (\S+) ([0-9a-f]{40,64})\t/.exec(entry);
  if (!m || m[2] !== 'blob' || m[1] === '120000') return { present: true, blob: m ? m[3] : null, problem: 'no es un archivo regular' };
  const text = ex.leerObjetos({ dir }, [m[3]]).get(m[3]).toString('utf8');
  const broken = (problem) => ({ present: true, blob: m[3], problem });
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    return broken('no es JSON');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return broken('no es un objeto');
  if (typeof json.version !== 'string' || !ex.VERSION_SHAPE.test(json.version)) return broken('su versión no tiene la forma YYYY.MM.DD.N');
  const source = json.source;
  if (!source || typeof source !== 'object' || Array.isArray(source) || !Object.keys(source).length
    || !Object.values(source).every((sha) => typeof sha === 'string' && SHA.test(sha))) return broken('su «source» no es un mapa de fuente a commit');
  // story 8.13.1 (AC 6): la lista de transformados, tal como viene (undefined si el archivo es de antes); la mira verify (j)
  return { present: true, blob: m[3], text, version: json.version, source, transformed: json.transformed };
}

/**
 * El `version.json` de una punta del público, para numerar: `null` si no lo trae. Si está y no se deja leer es un 2:
 * numerar como si no estuviera repetiría un número ya publicado.
 */
function readVersionFile(dir, commit, where) {
  const file = versionFileAt(dir, commit);
  if (!file.present) return null;
  if (file.problem) {
    throw couldNot(`el ${versionFile()} de ${where}, en ${PUBLIC_REPO}, no se deja leer (${file.problem}): sin leerlo no se numera — `
      + `empezar de nuevo en .1 repetiría un número ya publicado. Qué hacer: ${GUIDE}, §«La publicación»`);
  }
  return file;
}

let indexSerial = 0;
/**
 * Un árbol armado por plomería a partir de otro, en el repo de la copia: se lee a un índice propio de la corrida (el del
 * repo no se toca), `change` lo cambia y se escribe el árbol. No pasa por ningún árbol de trabajo.
 */
function rebuildTree(ctx, dir, tree, change) {
  const index = path.join(ctx.tmp, `index-${++indexSerial}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    gitOut(dir, ['read-tree', tree], { env });
    change(env);
    return gitOut(dir, ['write-tree'], { env }).trim();
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** Ese árbol sin `version.json`: con lo que se compara una exportación, que nunca lo trae. */
function withoutVersionFile(ctx, dir, tree) {
  // con modo 0, `--index-info` saca la ruta del índice, y no pide un árbol de trabajo (`--force-remove` sí)
  return rebuildTree(ctx, dir, tree, (env) => gitOut(dir, ['update-index', '--index-info'], { env, input: `0 ${'0'.repeat(tree.length)}\t${versionFile()}\n` }));
}

/** Ese árbol con `version.json` en su raíz: el árbol final de una sincronización. */
function withVersionFile(ctx, dir, tree, text) {
  const blob = gitOut(dir, ['hash-object', '-w', '--stdin'], { input: text }).trim();
  if (!SHA.test(blob)) throw couldNot(`git no devolvió el objeto de ${versionFile()}`);
  return rebuildTree(ctx, dir, tree, (env) => gitOut(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${versionFile()}`], { env }));
}

/**
 * Lo que ESTA pasada publicaría sobre lo que el público tiene ahora: la versión y el texto de su `version.json`. Se
 * calcula en cada pasada —si el push pierde contra otra corrida, la siguiente relee el público y vuelve a numerar— y por
 * eso vive en `status`, nunca en `copy`, que es la misma en las dos.
 *
 * El atajo, antes de numerar: si la punta de la rama es una sincronización de estos mismos commits internos, sobre este
 * mismo padre y con este mismo árbol exportado, es esta misma corrida. No se renumera —el número saldría uno más alto
 * por contarse a sí misma— ni se arma otro commit: `commit` y `tree` son los de la rama, y quien llama no empuja.
 */
function numberRun(ctx, copy, status) {
  const tip = status.syncTip;
  const onBranch = tip ? isSyncCommit(copy.dir, tip) : null;
  // el de la rama cuenta sólo si su punta es una sincronización: otra cosa empujada ahí se reemplaza, no numera
  const branchVersion = onBranch ? readVersionFile(copy.dir, tip, SYNC_BRANCH) : null;
  if (onBranch && branchVersion && onBranch.parents.length === 1 && onBranch.parents[0] === status.publicTip
    && trailer(onBranch.message, TRAILERS.harness) === ctx.harness.sha && trailer(onBranch.message, TRAILERS.skills) === ctx.skills.sha
    && withoutVersionFile(ctx, copy.dir, onBranch.tree) === copy.tree) {
    return { version: branchVersion.version, text: branchVersion.text, tree: onBranch.tree, commit: tip };
  }
  const day = versionDay(Math.max(ctx.harness.date, ctx.skills.date));
  const version = nextVersion(day, [status.mainVersion && status.mainVersion.version, branchVersion && branchVersion.version]);
  // story 8.13.1 (AC 6): con la lista de transformados de ESTA exportación (la del --json del exportador): sin ella, cada
  // máquina con la capa privada vería «capa de otra versión»
  const transformed = copy.json && copy.json.transformed;
  if (!Array.isArray(transformed)) throw couldNot(`el --json del exportador no trae «transformed»: sin la lista de transformados no se escribe ${versionFile()}`);
  const text = exporter().versionFileBytes({ version, source: { harness: ctx.harness.sha, agent_skills: ctx.skills.sha }, transformed }).toString('utf8');
  return { version, text, tree: null, commit: null };
}

/** El árbol final de una pasada: el de la exportación más su `version.json` (o el de la rama, si es esta misma corrida). */
const finalTree = (ctx, copy, run) => run.tree || withVersionFile(ctx, copy.dir, copy.tree, run.text);

/**
 * La versión y el árbol final según el estado, para decirlos: lo que se publicaría («no publicado», «cambios»), lo que ya
 * está publicado («sin cambios»: la versión de `main`, o ninguna si salió sin el archivo), o nada («cambios ajenos»).
 */
function versionOutlook(ctx, copy, status) {
  if (status.state === 'foreign-changes') return { version: null, tree: null };
  if (status.state === 'unchanged') return { version: status.mainVersion ? status.mainVersion.version : null, tree: status.publicTree };
  const run = numberRun(ctx, copy, status);
  return { version: run.version, tree: finalTree(ctx, copy, run) };
}

/** El estado del público frente a la copia: uno de los cuatro de `STATES`, con lo que hace falta para decirlo. */
function publicStatus(ctx, copy, refs) {
  const status = {
    state: null, publicTip: null, syncTip: null, counts: null, paths: [], pathsOmitted: 0, pathsHidden: 0, rawPaths: [], foreign: [],
    publicTree: null, mainVersion: null,
  };
  if (!refs.size) return { ...status, state: 'unpublished' };
  if (!refs.has(MAIN)) throw couldNot(`${PUBLIC_REPO} tiene refs pero no tiene main: no sé contra qué comparar`);
  const tips = fetchPublic(ctx, copy.dir, refs);
  status.publicTip = tips.main;
  status.syncTip = tips.sync;
  const chain = syncChain(copy.dir, tips.main);
  // story 8.18 (AC 24): antes de leer las marcas, que este repo conozca la sincronización anterior
  requirePreviousSync(ctx, chain.anchor);
  status.foreign = foreignChanges(ctx, copy.dir, tips.main, chain);
  if (status.foreign.some((f) => !f.absorbed)) return { ...status, state: 'foreign-changes' };
  // story 8.13 (AC 24): la exportación nunca trae `version.json` —lo agrega la sincronización—, así que el árbol de
  // `main` se compara SIN ese archivo, y las cuentas de abajo tampoco lo cuentan
  status.publicTree = treeOf(copy.dir, tips.main);
  status.mainVersion = readVersionFile(copy.dir, tips.main, 'main');
  const publicTree = status.mainVersion ? withoutVersionFile(ctx, copy.dir, status.publicTree) : status.publicTree;
  if (publicTree === copy.tree) return { ...status, state: 'unchanged' };
  const diff = treeDiff(copy.dir, publicTree, copy.tree);
  // `rawPaths` es para armar el cuerpo del pull request (que decide por su cuenta qué escribe); lo que se imprime es `paths`
  const paths = diff.paths.map((p) => ({ status: p.status, path: printablePath(ctx, p.path) }));
  return { ...status, state: 'changes', ...diff, rawPaths: diff.paths, paths, pathsHidden: paths.filter((p) => p.path === HIDDEN_PATH).length };
}

const countsText = (c) => `${c.added} agregado(s), ${c.modified} modificado(s), ${c.deleted} borrado(s)`;
const pathLines = (status) => [
  ...status.paths.map((p) => `    ${{ added: '+', modified: '~', deleted: '-' }[p.status]} ${p.path}`),
  ...(status.pathsOmitted ? [`    … y ${status.pathsOmitted} más`] : []),
];
const replacementsNotice = (n) => `${n} reemplazo(s): un nombre pasó el freno y se arregla en el interno`;

// ── plan ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function plan(ctx) {
  resolveInternal(ctx);
  const refs = remoteRefs(ctx);
  const copy = exportAndCheck(ctx);
  const status = publicStatus(ctx, copy, refs);
  const pending = status.foreign.filter((f) => !f.absorbed);
  const message = STATES[status.state];
  // lo mismo que calcularían `first` y `sync`: la versión y el árbol final (el de la exportación más version.json)
  const outlook = versionOutlook(ctx, copy, status);
  const lines = [`mirror plan: ${message}`,
    internalLine(ctx),
    `  árbol de la exportación: ${short(copy.tree)}${status.publicTip ? ` · punta de main del público: ${short(status.publicTip)}` : ''}`];
  if (status.state === 'unchanged') lines.push(outlook.version ? `  versión publicada: ${outlook.version}` : '  main del público no trae version.json: salió antes de que se numerara');
  else if (outlook.version) lines.push(`  versión que se publicaría: ${outlook.version} · árbol final (con version.json): ${short(outlook.tree)}`);
  if (status.state === 'changes') lines.push(`  ${countsText(status.counts)}`, ...pathLines(status));
  if (pending.length) lines.push(foreignMessage(pending));
  for (const w of ctx.warnings) lines.push(`  ⚠️ ${w} — first y sync no arrancan así`);
  if (copy.replacements) lines.push(`  ⚠️ ${replacementsNotice(copy.replacements)}`);
  return {
    exit: pending.length ? 1 : 0,
    lines,
    data: {
      state: status.state, message,
      ...internalData(ctx),
      warnings: ctx.warnings,
      tree: outlook.tree, version: outlook.version, exportedTree: copy.tree, publicTip: status.publicTip,
      counts: status.counts, paths: status.paths, pathsOmitted: status.pathsOmitted, pathsHidden: status.pathsHidden,
      foreign: status.foreign, replacements: copy.replacements,
    },
  };
}

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

/**
 * El mensaje del commit: el asunto y los tres trailers, que dicen de qué commits internos salió y qué árbol trae. `tree`
 * es el árbol FINAL del commit —el de la exportación más `version.json`—: `isSyncCommit` exige que el trailer sea el
 * árbol de verdad.
 */
function commitMessage(ctx, tree, subject) {
  return `${subject}\n\n${TRAILERS.harness}: ${ctx.harness.sha}\n${TRAILERS.skills}: ${ctx.skills.sha}\n${TRAILERS.tree}: ${tree}\n`;
}

/** La identidad fija de la copia: la constante del exportador, que no se copia en este archivo. */
function commitIdentity() {
  const id = exporter().COMMIT_IDENTITY;
  if (!id || typeof id.nombre !== 'string' || typeof id.email !== 'string') throw couldNot('el exportador no exporta la identidad fija del commit (COMMIT_IDENTITY)');
  return id;
}

/**
 * Un commit por plomería en el repo de la copia, con la técnica del exportador: git aislado de la máquina, sin firma,
 * la identidad fija, y como fecha la del commit interno más reciente. Sin `parent` es un commit raíz. Los mismos commits
 * internos sobre el mismo padre dan el mismo commit: un reintento no cambia nada. `tree` es el árbol final de la pasada.
 */
function makeCommit(ctx, copy, tree, parent, message) {
  const id = commitIdentity();
  const date = `@${Math.max(ctx.harness.date, ctx.skills.date)} +0000`;
  const env = {
    GIT_AUTHOR_NAME: id.nombre, GIT_AUTHOR_EMAIL: id.email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: id.nombre, GIT_COMMITTER_EMAIL: id.email, GIT_COMMITTER_DATE: date,
  };
  const sha = gitOut(copy.dir, ['-c', 'commit.gpgsign=false', '-c', 'i18n.commitEncoding=UTF-8', 'commit-tree', tree,
    ...(parent ? ['-p', parent] : []), '-m', message], { env }).trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw couldNot('git no devolvió el commit que armó');
  return sha;
}

/** Los textos del commit, cada uno bajo su ruta ficticia. */
function commitTexts(message) {
  const id = commitIdentity();
  return [['el mensaje del commit', message, ROUTES.message], ['la identidad del commit', `${id.nombre} <${id.email}>`, ROUTES.identity]];
}

/**
 * Los textos que la corrida va a escribir en el público —`[qué es, el texto, su ruta ficticia]`—, revisados con la lista
 * privada ANTES de cualquier escritura. Un hallazgo es un 1 sin escribir nada; se dice dónde, nunca qué.
 */
function reviewPublicTexts(ctx, texts) {
  const d = detector();
  const cfg = loadList(ctx, 'no escribo: los textos que van al público se revisan antes con la lista privada');
  const found = [];
  for (const [what, text, route] of texts) {
    for (const h of d.reviewText(cfg, String(text), route).hallazgos) found.push({ what, line: h.linea, category: h.categoria });
  }
  if (!found.length) return;
  throw new Stop(1, [`${found.length} hallazgo(s) en los textos que se iban a escribir en ${PUBLIC_REPO} — no se escribió nada:`,
    ...found.map((f) => `  · ${f.what}, línea ${f.line} [${f.category}]`),
    '  Sale de un nombre de los internos (una ruta, un asunto): se arregla ahí y se vuelve a correr.'].join('\n'), { textFindings: found });
}

// ── Empujar ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Dos funciones, cada una con su ref escrita adentro: no hay una que reciba la ref a empujar. `main` aparece sólo en la
// de la primera publicación.
/** La primera publicación: el commit raíz a `main`, sin forzar. Un repo que ya tiene `main` lo rechaza. */
function pushFirst(ctx, copy, commit) {
  return remoteGit(ctx, copy.dir, ['push', '--porcelain', ctx.remote, `${commit}:${MAIN}`]);
}

/** Lo que contestó un push: llegó, perdió el lease, lo rechazaron (con lo que dijo el otro lado), o no se pudo hablar. */
function pushOutcome(r) {
  if (r.status === 0) return { ok: true };
  // lo que dijo el otro lado sale tal cual, línea por línea: sólo sin caracteres de control (y `redact` le saca las órdenes)
  const flagged = String(r.stdout).split('\n').filter((l) => l.startsWith('!\t')).map((l) => publicText(l.split('\t').slice(2).join(' ').trim(), 1000));
  const remote = String(r.stderr).split('\n').filter((l) => /^remote:/.test(l)).map((l) => publicText(l.trimEnd(), 1000));
  if (flagged.some((l) => /\(stale info\)/.test(l))) return { stale: true };
  if (flagged.length) return { rejected: true, lines: [...remote, ...flagged] };
  return { failed: true, stderr: r.stderr };
}

/** Un push que no llegó a hablar con el público (sin red, sin permiso): «no pude», con el motivo y sin la URL del repo. */
function unpushable(ctx, stderr) {
  const s = String(stderr || '').toLowerCase();
  if (/could not read username|terminal prompts disabled|authentication failed|repository not found|returned error: 40[134]/.test(s)) {
    return `no pude empujar a GitHub (${PUBLIC_REPO}): no aceptó el token (¿venció, o la App no puede escribir en ese repo?)`;
  }
  const last = String(stderr || '').trim().split('\n').pop() || 'git no dijo por qué';
  return `no pude empujar a GitHub (${PUBLIC_REPO}): ${publicText(withoutRepo(ctx, last), 500)}`;
}

/** El rechazo de un push, tal cual lo dijo GitHub (sin el token: toda salida pasa por `redact`). No se reintenta. */
function rejectedPush(branch, outcome, data = {}) {
  const text = outcome.lines.join('\n');
  // la protección contra secretos de GitHub nombra el archivo: «path: <archivo>:<línea>»
  const secrets = /push protection|push cannot contain secrets|secret[- ]scanning/i.test(text);
  const files = secrets ? [...new Set([...text.matchAll(/^remote:\s+(?:-\s+)?path:\s+(.+?)(?::\d+)?\s*$/gm)].map((m) => m[1]))] : [];
  const lines = [`GitHub rechazó el push a ${branch} — no reintento. Lo que dijo, tal cual:`, ...outcome.lines.map((l) => `  ${l}`)];
  if (secrets) {
    lines.push(`  Es la protección contra secretos de GitHub${files.length ? `, por ${files.join(', ')}` : ''}: el valor se arma por partes en el interno.`,
      `  ${GUIDE}, §«Alertas de prueba en GitHub».`);
  }
  return new Stop(1, lines.join('\n'), { ...data, push: { rejected: true, lines: outcome.lines, secretProtection: secrets, files } });
}

// De qué commits internos sale la corrida. En un solo repo interno (story 8.18) los dos son el mismo, y se dice: las
// claves del --json y los dos trailers no cambian de forma.
const internalLine = (ctx) => `  arnés ${short(ctx.harness.sha)} (${ctx.harness.ref}) · agent-skills ${short(ctx.skills.sha)} (${ctx.skills.ref})`
  + `${ctx.repos.single ? ' — un solo repo interno: el mismo commit en los dos trailers' : ''}`;
const internalData = (ctx) => ({
  harness: { ref: ctx.harness.ref, sha: ctx.harness.sha },
  agentSkills: { ref: ctx.skills.ref, sha: ctx.skills.sha },
  singleRepo: Boolean(ctx.repos.single),
});

// ── first: la primera publicación ───────────────────────────────────────────────────────────────────────────────
const SUBJECTS = Object.freeze({ first: 'Primera publicación', sync: 'Sincronización' });

async function first(ctx) {
  requireToken(ctx);
  resolveInternal(ctx);
  refuseOtherCommit(ctx);
  const refs = remoteRefs(ctx);
  if (refs.size) throw couldNot(`${PUBLIC_REPO} ya tiene ${refs.size} ref(s): first es sólo para un repo sin ninguna. Lo que sigue es sync`);
  const copy = exportAndCheck(ctx);
  // sin nada publicado, la versión es la primera de su fecha: el .1 (lo mismo que anuncia `plan`)
  const run = numberRun(ctx, copy, { syncTip: null, publicTip: null, mainVersion: null });
  reviewPublicTexts(ctx, [[`el ${versionFile()}`, run.text, versionFile()]]);
  const tree = finalTree(ctx, copy, run);
  const message = commitMessage(ctx, tree, SUBJECTS.first);
  reviewPublicTexts(ctx, commitTexts(message));
  const commit = makeCommit(ctx, copy, tree, null, message);
  const data = { outcome: 'published', ...internalData(ctx), commit, tree, version: run.version, exportedTree: copy.tree, replacements: copy.replacements };
  const pushed = pushOutcome(pushFirst(ctx, copy, commit));
  // sin forzar, un `main` que apareció mientras tanto rechaza el push de este lado: no hay nada que pisar
  if (pushed.rejected && !pushed.lines.some((l) => /^remote:|\[remote rejected\]/.test(l))) {
    throw couldNot(`${PUBLIC_REPO} dejó de estar vacío mientras se armaba la publicación: no se pisa. Lo que sigue es sync`);
  }
  if (pushed.rejected) throw rejectedPush('main', pushed, { ...data, outcome: 'rejected' });
  if (!pushed.ok) throw couldNot(unpushable(ctx, pushed.stderr));

  // Lo publicado se revisa tal como lo sirve GitHub, en estricto: ese código es el de `first`.
  const checked = await verify({ ...ctx, args: { ...ctx.args, strict: true } });
  const lines = [`mirror first: publicado — el commit ${short(commit)}, en main, en ${PUBLIC_REPO}`,
    internalLine(ctx), `  versión ${run.version} · árbol: ${short(tree)}`];
  if (copy.replacements) lines.push(`  ⚠️ ${replacementsNotice(copy.replacements)}`);
  return {
    exit: checked.exit,
    lines: [...lines, ...checked.lines],
    message: checked.exit === 0 ? 'la primera publicación está hecha: main quedó publicado, y verify --strict salió 0'
      : `la primera publicación está hecha (main quedó publicado), y verify --strict salió ${checked.exit}: ${checked.message}`,
    data: { ...data, verify: { exit: checked.exit, message: checked.message, ...checked.data } },
  };
}

// ── sync: la rama de la sincronización y su único pull request ──────────────────────────────────────────────────
const UNPUBLISHED = 'todavía no publicado: corré `first`';
const NEWER = 'hay una sincronización más nueva';
// Los textos que quedan en el público. Todos pasan por la lista privada antes de escribirse.
const PULL_TITLE = 'Sincronización con los repos internos';
const PULL_INTRO = 'Sincronización automática desde los repos internos. Este pull request se actualiza solo con cada cambio; lo aprueba y lo mergea una persona, con commit de merge.';
const CLOSE_COMMENT = 'Se cierra solo: ya no hay diferencias con el interno.';
const HIDDEN_IN_BODY = '(una ruta que no se nombra)';

/**
 * Las reglas de `main` (antes de empujar): GitHub tiene que impedir, él también, lo que este guion nunca hace. Varias
 * reglas del mismo tipo —dos rulesets activos— valen juntas. Lo que la respuesta no trae no se da por bueno.
 */
async function checkMainRules(ctx) {
  const repo = await apiRead(ctx, '', 'los datos del repo');
  // Con el repo PRIVADO no se exige nada (decisión del dueño, 2026-10-06): GitHub Free no admite reglas ni protección
  // de rama en un privado —la API contesta 403— y el único que escribe es el dueño. Exigirlas frenaba toda
  // sincronización y obligaba a recrear el repo por cualquier cambio. Si el repo pasa a público, vuelven a exigirse.
  if (repo.private === true) return;
  const rules = await apiRead(ctx, '/rules/branches/main?per_page=100', 'las reglas de main');
  if (!Array.isArray(rules)) throw couldNot('la API no contestó una lista al leer las reglas de main');
  if (!rules.length) {
    throw couldNot(`main, en ${PUBLIC_REPO}, está sin ruleset: una protección clásica de rama no cuenta, hace falta un ruleset (TH6) — no empujo`, { rules: { missing: ['ruleset'] } });
  }
  const missing = [];
  const parameters = (type) => rules.filter((r) => r && r.type === type).map((r) => r.parameters || {});
  const pulls = parameters('pull_request');
  if (!pulls.length) missing.push('falta la regla pull_request: que main cambie sólo por pull request');
  else {
    if (!pulls.some((p) => Number.isInteger(p.required_approving_review_count) && p.required_approving_review_count >= 1)) {
      missing.push('pull_request: required_approving_review_count tiene que ser 1 o más (al menos una aprobación)');
    }
    for (const key of ['dismiss_stale_reviews_on_push', 'require_last_push_approval']) {
      if (!pulls.some((p) => p[key] === true)) missing.push(`pull_request: ${key} tiene que estar prendido`);
    }
  }
  for (const [type, why] of [['non_fast_forward', 'que nadie pueda forzar un push'], ['deletion', 'que nadie pueda borrar la rama']]) {
    if (!parameters(type).length) missing.push(`falta la regla ${type}: ${why}`);
  }
  if (!parameters('required_status_checks').some((p) => Array.isArray(p.required_status_checks) && p.required_status_checks.length > 0)) {
    missing.push('falta la regla required_status_checks con al menos un chequeo');
  }
  for (const [key, wanted] of [['allow_merge_commit', true], ['allow_squash_merge', false], ['allow_rebase_merge', false]]) {
    if (typeof repo[key] !== 'boolean') missing.push(`la respuesta del repo no trae ${key} (¿el token puede leer la administración del repo?)`);
    else if (repo[key] !== wanted) missing.push(`${key} tiene que estar ${wanted ? 'prendido' : 'apagado'}: el repo permite sólo commits de merge`);
  }
  if (typeof repo.default_branch !== 'string' || !repo.default_branch) missing.push('la respuesta del repo no trae default_branch');
  else if (repo.default_branch === SYNC_BRANCH) missing.push(`la rama por defecto del repo no puede ser ${SYNC_BRANCH}`);
  if (missing.length) {
    throw couldNot(`las reglas de main, en ${PUBLIC_REPO}, no alcanzan — no empujo:\n  · ${missing.join('\n  · ')}`, { rules: { missing } });
  }
}

/**
 * Lo que trae hoy la rama de la sincronización, frente a los commits de esta corrida: si es una sincronización de
 * commits internos iguales o posteriores a los propios, y alguno posterior, es MÁS NUEVA y no se pisa (una corrida
 * vieja nunca retrocede el pull request). Si no es una sincronización, la rama se reemplaza: es de este guion.
 */
function newerOnBranch(ctx, dir, tip) {
  const commit = tip ? isSyncCommit(dir, tip) : null;
  if (!commit) return false;
  const body = commit.message;
  const position = (repo, own, theirs) => {
    if (!theirs || !SHA.test(theirs)) return 'other';
    if (theirs === own) return 'same';
    requireFullHistory(repo);
    if (git(repo.dir, ['cat-file', '-e', `${theirs}^{commit}`]).status !== 0) {
      // no saber no es «es vieja»: sin ese commit no se puede decidir, y pisarla podría retroceder el pull request
      throw couldNot(`${SYNC_BRANCH} trae una sincronización del commit ${short(theirs)} de ${repo.name}, que este clon no conoce: `
        + 'no puedo saber si es más nueva, y no la piso. Traé la historia del interno y volvé a correr');
    }
    const r = git(repo.dir, ['merge-base', '--is-ancestor', own, theirs]);
    if (r.status > 1) throw couldNot(`no pude comparar ${short(own)} con ${short(theirs)} en ${repo.name}: ${String(r.stderr).trim()}`);
    return r.status === 0 ? 'newer' : 'other';
  };
  const positions = [position(ctx.repos.harness, ctx.harness.sha, trailer(body, TRAILERS.harness)),
    position(ctx.repos.skills, ctx.skills.sha, trailer(body, TRAILERS.skills))];
  return !positions.includes('other') && positions.includes('newer');
}

/** La rama de la sincronización: lo único que se empuja fuera de `first`, y sólo si sigue como se la leyó. */
function pushSync(ctx, copy, commit, expected) {
  return remoteGit(ctx, copy.dir, ['push', '--porcelain', `--force-with-lease=${SYNC}:${expected || ''}`, ctx.remote, `${commit}:${SYNC}`]);
}

/** Los pull requests abiertos de la rama de la sincronización hacia `main`. Si no se pueden leer, no se decide nada. */
async function openSyncPulls(ctx) {
  const own = `${ctx.target.org}:${SYNC_BRANCH}`;
  const pulls = await apiRead(ctx, `/pulls?state=open&head=${encodeURIComponent(own)}&base=main&per_page=100`, 'los pull requests abiertos');
  if (!Array.isArray(pulls)) throw couldNot('la API no contestó una lista al leer los pull requests abiertos');
  // se vuelve a mirar cada uno: un filtro que la API no aplicó no puede terminar tocando el pull request de otro
  return pulls.filter((p) => p && Number.isInteger(p.number) && p.state !== 'closed' && p.head && p.head.ref === SYNC_BRANCH
    && (typeof p.head.label !== 'string' || p.head.label.toLowerCase() === own.toLowerCase())
    && (!p.base || p.base.ref === 'main')).sort((a, b) => a.number - b.number);
}

async function apiWrite(ctx, method, rest, body, expected, what) {
  const r = await apiCall(ctx, method, rest, body);
  if (r.status !== expected) throw couldNot(`la API contestó ${r.status} al ${what}`);
  return r.json;
}

/** Un paso que escribe en un pull request: si no se pudo, el «no pude» lleva cuál era y cómo quedó, para quien lo ataje. */
async function touching(pullRequest, step) {
  try {
    return await step();
  } catch (e) {
    if (e instanceof Stop) e.data = { ...e.data, pullRequest };
    throw e;
  }
}

/** El único pull request: si no hay ninguno abierto se crea; si hay, se actualiza —sólo si dice otra cosa—. */
async function ensurePull(ctx, open, title, body, retried = false) {
  if (open.length) {
    const pr = open[0];
    if (pr.title === title && pr.body === body) return { number: pr.number, action: 'unchanged' };
    await touching({ number: pr.number, action: 'not-updated' },
      () => apiWrite(ctx, 'PATCH', `/pulls/${pr.number}`, { title, body }, 200, `actualizar el pull request nº ${pr.number}`));
    return { number: pr.number, action: 'updated' };
  }
  const r = await apiCall(ctx, 'POST', '/pulls', { title, head: SYNC_BRANCH, base: 'main', body });
  if (r.status === 201 && r.json && Number.isInteger(r.json.number)) return { number: r.json.number, action: 'created' };
  if (r.status === 422 && !retried) {
    // otra corrida pudo abrirlo entre la lista y este pedido: se vuelve a leer, nunca se crea un segundo
    const again = await openSyncPulls(ctx);
    if (again.length) return ensurePull(ctx, again, title, body, true);
  }
  throw couldNot(`la API contestó ${r.status} al crear el pull request (la rama ${SYNC_BRANCH} ya está empujada: la corrida siguiente lo crea)`);
}

/**
 * El cuerpo del pull request: de qué commits internos sale y qué cambia. Es público: no lleva la cuenta de reemplazos.
 *
 * Una ruta BORRADA que trae algo de la lista no se escribe: va su lugar, y se cuenta en la línea de arriba. Esa ruta
 * sale del árbol público —el interno ya la sacó o la renombró—, y el pull request que la borra es la única manera de
 * que deje de estar en `main`: si su nombre frenara la revisión de este texto, el arreglo no se podría publicar nunca.
 * Una ruta agregada o modificada con un nombre de la lista sí frena (sale del interno, y ahí se arregla).
 *
 * Lleva la versión con que sale (story 8.13): quien aprueba el pull request está marcando ESA como estable. La cuenta y
 * las rutas no incluyen `version.json`: cambia en toda sincronización, y no es un cambio de los internos.
 */
function pullBody(ctx, status, version) {
  const lines = status.rawPaths.map((p) => {
    // cada ruta en UNA línea: una con un salto de línea adentro cerraría el bloque y escribiría lo que quisiera
    const line = `${{ added: '+', modified: '~', deleted: '-' }[p.status]} ${publicText(p.path)}`;
    return p.status === 'deleted' && isFinding(ctx, line, ROUTES.pullRequest) ? `- ${HIDDEN_IN_BODY}` : line;
  });
  return [PULL_INTRO, '',
    `Arnés \`${short(ctx.harness.sha)}\` · agent-skills \`${short(ctx.skills.sha)}\``, '',
    `Versión \`${version}\``, '',
    `Cambios: ${countsText(status.counts)}`, '',
    '```text',
    ...lines,
    ...(status.pathsOmitted ? [`… y ${status.pathsOmitted} más`] : []),
    '```', ''].join('\n');
}

/**
 * Una vuelta de la sincronización sobre lo que el público tiene AHORA. Devuelve el reporte, o `null` si el push perdió
 * el lease (otra corrida empujó la rama entre la lectura y el push): quien llama relee una vez.
 */
async function syncOnce(ctx, copy, refs) {
  const status = publicStatus(ctx, copy, refs);
  // `tree` y `version` son los de lo publicado: en «sin cambios», los de `main`; con cambios se completan abajo, cuando
  // esta pasada numera; si la corrida termina antes (nada publicado, cambios ajenos, una sincronización más nueva), nada
  const data = {
    state: status.state, ...internalData(ctx),
    tree: status.state === 'unchanged' ? status.publicTree : null,
    version: status.state === 'unchanged' && status.mainVersion ? status.mainVersion.version : null,
    exportedTree: copy.tree, publicTip: status.publicTip, syncTip: status.syncTip,
    counts: status.counts, paths: status.paths, pathsOmitted: status.pathsOmitted, pathsHidden: status.pathsHidden,
    foreign: status.foreign, replacements: copy.replacements,
  };
  const notice = copy.replacements ? [`  ⚠️ ${replacementsNotice(copy.replacements)}`] : [];
  if (status.state === 'unpublished') return { exit: 0, lines: [`mirror sync: ${UNPUBLISHED}`], data: { outcome: 'unpublished', message: UNPUBLISHED, ...data } };

  const pending = status.foreign.filter((f) => !f.absorbed);
  if (pending.length) throw new Stop(1, foreignMessage(pending), { outcome: 'foreign-changes', ...data });

  if (newerOnBranch(ctx, copy.dir, status.syncTip)) {
    return {
      exit: 0,
      lines: [`mirror sync: ${NEWER}`, internalLine(ctx),
        `  ${SYNC_BRANCH} (${short(status.syncTip)}) ya trae una sincronización de commits internos posteriores a éstos: no se empuja ni se toca el pull request`],
      data: { outcome: 'newer-sync', message: NEWER, ...data },
    };
  }

  if (status.state === 'unchanged') {
    reviewPublicTexts(ctx, [['el comentario con que se cierra el pull request', CLOSE_COMMENT, ROUTES.pullRequest]]);
    const closed = [];
    for (const pr of await openSyncPulls(ctx)) {
      let action = 'not-closed';
      try {
        await apiWrite(ctx, 'POST', `/issues/${pr.number}/comments`, { body: CLOSE_COMMENT }, 201, `comentar el pull request nº ${pr.number}`);
        action = 'commented';
        await apiWrite(ctx, 'PATCH', `/pulls/${pr.number}`, { state: 'closed' }, 200, `cerrar el pull request nº ${pr.number}`);
      } catch (e) {
        if (!(e instanceof Stop)) throw e;
        // a mitad de camino: el «no pude» dice qué quedó escrito en el público, no sólo qué falló
        const left = action === 'commented'
          ? `el comentario ya quedó escrito en el pull request nº ${pr.number}, que sigue abierto: la corrida siguiente vuelve a comentarlo y lo cierra`
          : `el pull request nº ${pr.number} quedó sin tocar: la corrida siguiente lo comenta y lo cierra`;
        throw new Stop(e.exit, [e.message,
          `  Lo que quedó hecho: ${closed.length ? `se cerró el pull request nº ${closed.join(', nº ')}; ` : ''}${left}. No se empujó nada.`].join('\n'),
        { outcome: 'incomplete', ...data, pushed: false, pullRequest: { number: pr.number, action }, closed: [...closed] });
      }
      closed.push(pr.number);
    }
    return {
      exit: 0,
      lines: [`mirror sync: ${STATES.unchanged}`, internalLine(ctx),
        `  el árbol de la exportación (${short(copy.tree)}) es el de main del público (${short(status.publicTip)})${status.mainVersion
          ? `, sin contar su ${versionFile()}: no se numera ni se empuja — la versión publicada sigue siendo ${status.mainVersion.version}` : ': no se empuja'}`,
        ...closed.map((n) => `  pull request nº ${n}: cerrado, con el comentario «${CLOSE_COMMENT}»`), ...notice],
      data: { outcome: 'unchanged', message: STATES.unchanged, ...data, ...(closed.length ? { pullRequest: { number: closed[0], action: 'closed' } } : {}) },
    };
  }

  // Con cambios: el commit sobre la punta pública —que ya contiene lo ajeno absorbido—, con el árbol final: el de la
  // exportación más `version.json`, con el número de ESTA pasada (story 8.13, AC 24).
  const run = numberRun(ctx, copy, status);
  status.version = run.version;
  const body = pullBody(ctx, status, run.version);
  // el texto de `version.json` se revisa antes de escribirlo, como todo lo que va al público
  reviewPublicTexts(ctx, [
    ['el título del pull request', PULL_TITLE, ROUTES.pullRequest],
    ['el cuerpo del pull request', body, ROUTES.pullRequest],
    ['el nombre de la rama', SYNC_BRANCH, ROUTES.pullRequest],
    [`el ${versionFile()}`, run.text, versionFile()],
  ]);
  status.tree = finalTree(ctx, copy, run);
  Object.assign(data, { tree: status.tree, version: status.version });
  const message = commitMessage(ctx, status.tree, SUBJECTS.sync);
  reviewPublicTexts(ctx, [['el mensaje del commit', message, ROUTES.pullRequest], ...commitTexts(message)]);
  // si la rama ya trae esta misma corrida, su commit es ése: ni se arma otro ni se empuja
  const commit = run.commit || makeCommit(ctx, copy, status.tree, status.publicTip, message);
  // se leen ANTES de empujar: si no se puede saber qué hay abierto, no se escribe nada
  const open = await openSyncPulls(ctx);
  let pushed = false;
  if (status.syncTip !== commit) {
    const outcome = pushOutcome(pushSync(ctx, copy, commit, status.syncTip));
    if (outcome.stale) return null;
    if (outcome.rejected) throw rejectedPush(SYNC_BRANCH, outcome, { outcome: 'rejected', ...data, commit });
    if (!outcome.ok) throw couldNot(unpushable(ctx, outcome.stderr));
    pushed = true;
  }
  let pullRequest;
  try {
    pullRequest = await ensurePull(ctx, open, PULL_TITLE, body);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    // La rama ya está en el público y el pull request no quedó como tenía que quedar: el «no pude» lo dice entero —qué
    // commit, si se empujó y qué pull request quedó a medias—, en el texto y en el --json.
    const target = (e.data && e.data.pullRequest) || null;
    throw new Stop(e.exit, [e.message,
      `  Lo que quedó hecho: el commit ${short(commit)} ${pushed ? 'se empujó a' : 'ya estaba en'} ${SYNC_BRANCH}; ${target
        ? `el pull request nº ${target.number} quedó con el texto de antes` : 'no quedó ningún pull request abierto'}.`,
      `  La corrida siguiente lo ${target ? 'actualiza' : 'crea'} sin volver a empujar.`].join('\n'),
    { outcome: 'incomplete', ...data, commit, pushed, pullRequest: target });
  }
  const did ={ created: 'creado', updated: 'actualizado', unchanged: 'ya decía esto: sin tocar' }[pullRequest.action];
  return {
    exit: 0,
    lines: [`mirror sync: ${STATES.changes} — pull request nº ${pullRequest.number} (${did})`, internalLine(ctx),
      `  el commit ${short(commit)}, sobre la punta de main del público (${short(status.publicTip)}): ${pushed ? `empujado a ${SYNC_BRANCH}` : `${SYNC_BRANCH} ya lo tenía, no se empuja`}`,
      `  versión ${run.version}${run.commit ? ' (la rama ya traía esta misma corrida: no se renumera)' : ''}`,
      `  ${countsText(status.counts)}`, ...pathLines(status), ...notice],
    data: { outcome: 'synced', message: STATES.changes, ...data, commit, pushed, pullRequest },
  };
}

async function sync(ctx) {
  requireToken(ctx);
  resolveInternal(ctx);
  refuseOtherCommit(ctx);
  const refs = remoteRefs(ctx);
  if (!refs.size) return { exit: 0, lines: [`mirror sync: ${UNPUBLISHED}`], data: { outcome: 'unpublished', state: 'unpublished', message: UNPUBLISHED, ...internalData(ctx) } };
  await checkMainRules(ctx);
  const copy = exportAndCheck(ctx);
  const report = await syncOnce(ctx, copy, refs);
  if (report) return report;
  // el lease se perdió: se relee UNA vez, y lo que haya ahora decide (sin cambios, más nueva, o empujar de nuevo)
  const again = await syncOnce(ctx, copy, remoteRefs(ctx));
  if (again) return again;
  throw couldNot(`otra corrida está empujando ${SYNC_BRANCH} al mismo tiempo: el push perdió dos veces contra lo que acababa de leer. No insisto: volvé a correr`);
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
const DIRECT_REASON = 'el público es la fuente (--direct): no hay una sincronización contra la cual comparar';

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

/**
 * La parte (i) (story 8.13, AC 24): el `version.json` publicado, contra SU sincronización. No se exporta nada ni se
 * comparan árboles: todo sale del clon.
 *
 *   · En `main`, «su sincronización» es la última mergeada (la misma ancla que usa `foreignChanges`: el segundo padre del
 *     merge, o la raíz si es la primera publicación), y el archivo de la punta tiene que ser EL MISMO objeto que el de
 *     ese commit: el merge del pull request no cambia el número, y nadie lo toca en `main`.
 *   · En la rama de la sincronización, su punta —si es una sincronización: otra cosa empujada ahí no es de la cadena—.
 *
 * De cada sincronización se mira que cada fuente de `source` sea el commit de SU trailer y que las fuentes sean las de
 * los trailers que ese commit trae (ni una más, ni una menos); que la fecha de la versión sea la del commit; y que el
 * orden cumpla la regla: 1 en una raíz, y mayor que el del commit sobre el que se armó si es de la misma fecha (el
 * número exacto no se puede comprobar: pudo contar una punta de la rama que ya fue reemplazada).
 *
 * Que el archivo NO esté es un hallazgo sólo si esa cadena ya lo traía: la primera publicación salió sin él.
 */
function verifyVersionFiles(dir, tip, found, looked) {
  const name = versionFile();
  const checked = new Set();
  let files = 0;

  /** El archivo de UNA sincronización, contra sus trailers, su fecha y el commit sobre el que se armó. */
  const checkSync = (commit, where) => {
    if (checked.has(commit.sha)) return;
    checked.add(commit.sha);
    const file = versionFileAt(dir, commit.sha);
    const parent = commit.parents[0] || null;
    const before = parent ? versionFileAt(dir, parent) : { present: false };
    if (!file.present) {
      if (before.present) found('i', 'version-missing', `${where}: el commit ${commit.sha} no trae ${name}, y el commit sobre el que se armó sí`);
      return;
    }
    files += 1;
    if (file.problem) {
      found('i', 'version-file', `${where}: el ${name} del commit ${commit.sha} no se deja leer (${file.problem})`);
      return;
    }
    // cada fuente, contra SU trailer; y el conjunto, el de los trailers que el commit trae
    const carried = Object.entries(VERSION_SOURCES).filter(([, key]) => SHA.test(trailer(commit.message, key) || ''));
    const wrong = [];
    for (const [source, key] of carried) {
      if (!(source in file.source)) wrong.push(`falta «${source}», que el commit trae en ${key}`);
      else if (file.source[source] !== trailer(commit.message, key)) wrong.push(`«${source}» no es el commit de su trailer ${key}`);
    }
    const extra = Object.keys(file.source).filter((source) => !carried.some(([known]) => known === source)).length;
    if (extra) wrong.push(`${extra} fuente(s) de más, sin trailer en ese commit`);
    if (wrong.length) found('i', 'version-source', `${where}: el ${name} del commit ${commit.sha}: ${wrong.join('; ')}`);
    // el número: la fecha del commit (la del interno más reciente, por construcción) y el orden en ese día
    const { day, order } = versionParts(file.version);
    const date = Number(gitOut(dir, ['log', '-1', '--format=%ct', commit.sha]).trim());
    const expected = versionDay(date);
    if (day !== expected) {
      found('i', 'version-number', `${where}: el ${name} del commit ${commit.sha} dice ${file.version}, y la fecha de ese commit es ${expected}`);
    } else if (!parent && order !== 1) {
      found('i', 'version-number', `${where}: el ${name} del commit ${commit.sha} dice ${file.version}, y una primera publicación lleva el .1`);
    } else if (before.present && !before.problem && versionParts(before.version).day === day && order <= versionParts(before.version).order) {
      found('i', 'version-number', `${where}: el ${name} del commit ${commit.sha} dice ${file.version}, y el commit sobre el que se armó ya traía ${before.version}: el orden en el día tiene que subir`);
    }
  };

  // main: la punta, contra su última sincronización mergeada
  const { anchor, pending } = syncsToVerify(dir, tip);
  const published = versionFileAt(dir, tip);
  if (!published.present) {
    // ¿la cadena de main lo trajo alguna vez? (con la ruta, git deja sólo los commits que lo cambian frente a su primer padre)
    const touched = gitOut(dir, ['rev-list', '--first-parent', '-1', tip, '--', name]).trim();
    if (touched) found('i', 'version-missing', `main no trae ${name}, y antes lo traía: el último commit de su cadena que lo tocó es ${touched}`);
  } else if (published.problem) {
    files += 1;
    found('i', 'version-file', `main: su ${name} no se deja leer (${published.problem})`);
  } else if (!anchor) {
    files += 1;
    found('i', 'version-file', `main trae ${name} y en su cadena no hay ninguna sincronización de la que sea`);
  } else {
    const merged = versionFileAt(dir, anchor.sha);
    if (!merged.present || merged.blob !== published.blob) {
      files += 1;
      found('i', 'version-file', `main: su ${name} no es el de su última sincronización mergeada (el commit ${anchor.sha}): alguien lo cambió en main`);
    }
    checkSync(anchor, 'main');
  }

  // la rama de la sincronización: su punta, si es una sincronización
  if (pending) checkSync(pending, SYNC_BRANCH);
  looked.i = files;
}

/**
 * Las sincronizaciones que `verify` mira: la última mergeada en la cadena de `main` (la raíz, si es la primera
 * publicación) y la punta de la rama de la sincronización, si es una. `null` la que no hay.
 */
function syncsToVerify(dir, tip) {
  const chain = gitOut(dir, ['log', '--first-parent', '--format=%H %P', tip]).split('\n').filter(Boolean).map((line) => {
    const [commit, ...parents] = line.split(' ').filter(Boolean);
    return { commit, parents };
  });
  const mergedSync = (c) => (c.parents.length >= 2 ? isSyncCommit(dir, c.parents[1]) : null);
  let anchor = null;
  for (const c of chain) {
    anchor = mergedSync(c) || (!c.parents.length ? isSyncCommit(dir, c.commit) : null);
    if (anchor || !c.parents.length) break;
  }
  const branch = git(dir, ['rev-parse', '--verify', '--quiet', `${SYNC}^{commit}`]);
  const pending = branch.status === 0 ? isSyncCommit(dir, String(branch.stdout).trim()) : null;
  return { anchor, pending };
}

/**
 * La parte (j), story 8.13.1 (AC 6): en cada sincronización que se mira, la lista `transformed` de su version.json
 * nombra EXACTAMENTE las rutas de su árbol (sin version.json) que el commit interno de sus trailers también trae, en esa
 * misma ruta, con otro blob —con la regla del exportador: `internalBlobs`—; lo que sólo está en el público no difiere de
 * nada interno y no cuenta. Una ruta que difiere y la lista no nombra es un
 * hallazgo (`transformed-undeclared`), y una nombrada que no difiere también (`transformed-extra`). Un archivo sin la
 * lista es un hallazgo sólo si el commit sobre el que se armó ya la traía (`transformed-missing`): una versión de antes
 * de esta story no la tiene. Lo que no se deja leer del archivo lo dice la parte (i). Lee los internos: sin ellos, «no
 * pude mirar».
 */
function verifyTransformed(ctx, dir, tip, found, looked) {
  const ex = exporter();
  const name = versionFile();
  const internals = new Map();
  const internalOf = (harness, skills) => {
    const key = `${harness} ${skills}`;
    if (!internals.has(key)) {
      const trees = [ex.listarArbol({ dir: ctx.repos.harness.dir }, harness)];
      if (skills !== harness) trees.push(ex.listarArbol({ dir: ctx.repos.skills.dir }, skills));
      internals.set(key, ex.internalBlobs(trees));
    }
    return internals.get(key);
  };
  const isList = (list) => Array.isArray(list) && list.every((t) => t && typeof t === 'object' && typeof t.path === 'string' && t.path
    && typeof t.transform === 'string' && t.transform.trim());
  let files = 0;
  const check = (commit, where) => {
    const file = versionFileAt(dir, commit.sha);
    if (!file.present || file.problem) return;
    if (file.transformed === undefined) {
      const before = commit.parents[0] ? versionFileAt(dir, commit.parents[0]) : { present: false };
      if (before.present && !before.problem && before.transformed !== undefined) {
        found('j', 'transformed-missing', `${where}: el ${name} del commit ${commit.sha} no trae «transformed», y el commit sobre el que se armó sí`);
      }
      return;
    }
    files += 1;
    if (!isList(file.transformed)) {
      found('j', 'transformed-file', `${where}: el «transformed» del ${name} del commit ${commit.sha} no es una lista de rutas con el nombre de su transformación`);
      return;
    }
    const harness = trailer(commit.message, TRAILERS.harness);
    const internal = internalOf(harness, trailer(commit.message, TRAILERS.skills));
    const differ = ex.listarArbol({ dir }, commit.sha).filter((e) => e.tipo === 'blob' && e.ruta !== name && internal.has(e.ruta) && internal.get(e.ruta) !== e.obj).map((e) => e.ruta);
    const listed = new Set(file.transformed.map((t) => t.path));
    const differs = new Set(differ);
    for (const rel of differ.filter((p) => !listed.has(p)).sort(byCode)) {
      found('j', 'transformed-undeclared', `${where}: ${printablePath(ctx, rel)} difiere del commit interno ${harness} y el ${name} del commit ${commit.sha} no la nombra en «transformed»`);
    }
    for (const rel of [...listed].filter((p) => !differs.has(p)).sort(byCode)) {
      found('j', 'transformed-extra', `${where}: ${printablePath(ctx, rel)} está en el «transformed» del ${name} del commit ${commit.sha} y no difiere del commit interno ${harness}`);
    }
  };
  const { anchor, pending } = syncsToVerify(dir, tip);
  if (anchor) check(anchor, 'main');
  if (pending && (!anchor || pending.sha !== anchor.sha)) check(pending, SYNC_BRANCH);
  looked.j = files;
}

async function verify(ctx) {
  const d = detector();
  const cfg = loadList(ctx, 'no pude mirar: lo publicado se revisa con la lista privada');
  const result = { findings: [], notMeasured: [], notApplicable: [], couldNotLook: [] };
  const looked = {};
  const direct = Boolean(ctx.args.direct);
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
  if (direct) for (const part of SYNC_PARTS) result.notApplicable.push({ part, reason: DIRECT_REASON });
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
  await look(IN_THE_CLONE.filter((part) => !direct || !SYNC_PARTS.includes(part)), () => {
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
  // Las tres partes atadas a la sincronización desde lo interno. Con `--direct` no corren (ya dijeron «no aplica»): ni
  // se leen los internos —la corrida no los necesita— ni un commit escrito directo en `main` cuenta como ajeno.
  if (tip && !direct) {
    // (f) con los mismos commits internos que `plan`: las mismas opciones y los mismos valores por defecto
    await look(['f'], () => {
      resolveCommits(ctx);
      // como `plan` y `sync` (story 8.18, pase adversarial del tramo 2, clase 16): desde un solo repo interno, antes de
      // leer las marcas, que el repo conozca la sincronización anterior. Si no, las marcas de la historia que le falta
      // no se ven y un cambio ajeno ya descartado salía como hallazgo: es «no pude mirar», nombrando el commit y la causa
      const chain = syncChain(dir, tip);
      requirePreviousSync(ctx, chain.anchor);
      for (const f of foreignChanges(ctx, dir, tip, chain).filter((x) => !x.absorbed)) found('f', 'foreign-change', `el commit ${f.commit} de main (${GUIDE}, §«Cambios ajenos»)`);
    });
    // (i) el número de versión, contra su sincronización: sale del clon, sin los internos y sin exportar nada
    await look(['i'], () => verifyVersionFiles(dir, tip, found, looked));
    // (j) la lista de transformados, contra el commit interno de cada sincronización (story 8.13.1, AC 6)
    await look(['j'], () => {
      resolveCommits(ctx);
      verifyTransformed(ctx, dir, tip, found, looked);
    });
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

const RUN = Object.freeze({ plan, first, sync, verify });

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
  COMMANDS, STATES, TRAILERS, MARKS, PROVIDER_RULES, EXTRA_PROVIDER_RULES, gitAuth,
  // story 8.13 (AC 24): la regla del número, sola — la fecha por aritmética y el orden en el día (su prueba la barre)
  versionDay, nextVersion,
  // story 8.18 (AC 23): qué árbol es el del repo único — su prueba lo cruza con el criterio del exportador
  isSingleRepoTree,
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
