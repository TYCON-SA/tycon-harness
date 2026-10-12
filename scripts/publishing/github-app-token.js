#!/usr/bin/env node
'use strict';
// github-app-token.js — el token de instalación de la App de GitHub, uno por corrida (épica 8, story 8.8 · 2026-10-03)
//
// POR QUÉ EXISTE: la sincronización con el repo público (`mirror.js`) escribe en GitHub con la identidad de una GitHub
// App de la organización, nunca con el token personal de alguien. Una App no tiene un token fijo: tiene una llave
// privada, y con ella se le pide a GitHub un token de instalación que vence solo. Este guion hace ese pedido, una vez
// por corrida:
//   1. lee de tres variables de entorno el id de la App, el de su instalación y el archivo de la llave privada;
//   2. lee el nombre del repo público con el lector del exportador (`readPublicRepo`): ese nombre no está escrito acá;
//   3. firma un JWT RS256 con el `crypto` de node (sin dependencias), que vence a los 9 minutos;
//   4. pide el token limitado a ESE repo y a los permisos que usa la sincronización, ni uno más;
//   5. sólo con respuesta 201 imprime el token y un salto de línea por la salida estándar. Por ahí no sale nada más:
//      quien lo llama lo captura (`TOKEN=$(node …)`) y lo registra como secreto antes de cualquier eco.
//
// CÓMO FALLA: exit 0 = el token, solo, en la salida estándar · 2 = no pude (falta una variable, la llave o el nombre
// público no se dejan leer, la API no contestó 201, el 201 no trae un token…), con el motivo por la salida de error y la
// salida estándar vacía. No hay exit 1: acá no hay «hallazgos». En ningún caso se imprimen la llave, el JWT ni el token:
// de una respuesta que no es 201 sale el código, nunca el cuerpo; de un error, su código, nunca su texto (el de quien
// lee un JSON cita el cuerpo). No mira las credenciales de la máquina (`GH_TOKEN`, `GITHUB_TOKEN`, el llavero de `gh`),
// no sigue redirecciones —el JWT no viaja a otro servidor— y no escribe ningún archivo.
//
// En la copia pública `public-repos.json` no viaja: ahí, sin `--public-repos <f>`, sale 2 diciendo qué archivo falta.
//
// A mano:
//   TYCON_MIRROR_APP_ID=<id> TYCON_MIRROR_INSTALLATION_ID=<id> TYCON_MIRROR_APP_KEY_FILE=<llave.pem> \
//     node scripts/publishing/github-app-token.js [--public-repos <f>]   (default: scripts/publishing/public-repos.json)
//   TYCON_MIRROR_API_URL cambia la base de la API (default https://api.github.com). Va con https://; sin cifrar
//   (http://) sólo hacia la propia máquina —127.0.0.1, localhost, ::1—, que es donde las pruebas levantan una API de
//   mentira. Con http:// hacia otro servidor sale 2 antes de leer la llave: no firma ni manda nada.
// Guía: guides/publicacion-espejo.md

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VARIABLES = Object.freeze({
  appId: 'TYCON_MIRROR_APP_ID',
  installationId: 'TYCON_MIRROR_INSTALLATION_ID',
  keyFile: 'TYCON_MIRROR_APP_KEY_FILE',
});
const API_VARIABLE = 'TYCON_MIRROR_API_URL';
const DEFAULT_API = 'https://api.github.com';
// Sin cifrar sólo hacia la propia máquina (la API de mentira de las pruebas): por `http://` el JWT firmado viajaría a
// la vista de cualquiera en el camino. Tres nombres exactos, como los deja `URL` (que ya normaliza `127.1` o
// `0:0:0:0:0:0:0:1`); cualquier otro —también `0.0.0.0` o el resto de 127.x— pide `https://`.
const LOCAL_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);
const LOCAL_NAMES = '127.0.0.1, localhost, ::1';
// Los permisos de la instalación (la tarea humana TH2 de la story): los que usa la sincronización. El token los pide
// por nombre, así una App a la que le sumen un permiso no se lo pasa a la corrida.
// 🔴 La contracara: un permiso que la App YA tiene tampoco llega a la corrida si no está en esta lista. `issues` es de
// la verificación de lo publicado (story 8.26, tanda F3 · AC 59): la lista de issues y su línea de tiempo no entran
// con ningún otro permiso, y sin él las partes de pedidos, issues y comentarios quedan en «no pude mirar» (un 403).
// Qué permiso pide cada dirección que `verify` lee lo fija la prueba T72 de scripts/tests/mirror.test.js.
const PERMISSIONS = Object.freeze({
  contents: 'write',
  pull_requests: 'write',
  workflows: 'write',
  metadata: 'read',
  administration: 'read',
  secret_scanning_alerts: 'read',
  issues: 'read',
});
// GitHub rechaza un JWT emitido «en el futuro» o que venza a más de 10 minutos: se emite un minuto atrás (los relojes
// de dos máquinas nunca coinciden) y vence 9 minutos adelante. Vida total: 10 minutos.
const CLOCK_DRIFT_SECONDS = 60;
const SECONDS_AHEAD = 540;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_ANSWER_BYTES = 64 * 1024;
const PREFIX = '⛔ token de la App: no pude pedirlo — ';

/** «No pude», con un motivo que se puede imprimir: nunca lleva la llave, el JWT, el token ni el cuerpo de una respuesta. */
class CouldNot extends Error {}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--public-repos') {
      const v = argv[++i];
      if (v === undefined || v === '' || v.startsWith('--')) throw new CouldNot(`${x} necesita un valor (vacío no es un valor: no cae al default)`);
      args.publicRepos = v;   // la última vez que aparece manda
    } else throw new CouldNot(`opción desconocida: ${x}`);
  }
  return args;
}

/** Las tres variables, todas o ninguna: las que faltan se nombran juntas. Vacío no es un valor. */
function readSettings(env) {
  const value = (name) => String(env[name] == null ? '' : env[name]).trim();
  const missing = Object.values(VARIABLES).filter((name) => !value(name));
  if (missing.length) {
    throw new CouldNot(`${missing.length > 1 ? 'faltan las variables' : 'falta la variable'} ${missing.join(', ')} `
      + '(el id de la App, el de su instalación y el archivo de su llave privada)');
  }
  const settings = { appId: value(VARIABLES.appId), installationId: value(VARIABLES.installationId), keyFile: value(VARIABLES.keyFile) };
  // el id de la instalación va en la ruta del pedido: sólo dígitos. El de la App, el número o su id de cliente.
  if (!/^[A-Za-z0-9._-]+$/.test(settings.appId)) throw new CouldNot(`${VARIABLES.appId} no tiene la forma del id de una App`);
  if (!/^[0-9]+$/.test(settings.installationId)) throw new CouldNot(`${VARIABLES.installationId} no es un número`);
  return settings;
}

/** La base de la API: `https://` (o `http://` hacia la propia máquina), sin credenciales adentro. La URL entera no se
 *  repite en el motivo. Se mira antes de leer la llave: lo que frena acá no llega a firmar. */
function apiBase(env) {
  const raw = String(env[API_VARIABLE] == null ? '' : env[API_VARIABLE]).trim() || DEFAULT_API;
  let base;
  try {
    base = new URL(raw);
  } catch (_) {
    throw new CouldNot(`${API_VARIABLE} no es una URL`);
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new CouldNot(`${API_VARIABLE}: la base de la API es http:// o https://, no ${base.protocol}//`);
  if (base.protocol === 'http:' && !LOCAL_HOSTS.includes(base.hostname)) {
    throw new CouldNot(`${API_VARIABLE}: sin cifrar (http://) sólo se habla con la propia máquina (${LOCAL_NAMES}); `
      + `para ${base.host} la base va con https://. No se firmó ni se mandó nada`);
  }
  if (base.username || base.password) throw new CouldNot(`${API_VARIABLE} no lleva usuario ni clave`);
  if (base.search || base.hash) throw new CouldNot(`${API_VARIABLE} es una base: no lleva «?» ni «#»`);
  return base;
}

/** El nombre del repo público, con el lector del exportador: el único que conoce esas claves. */
function publicRepo(file) {
  let exporter;
  try {
    exporter = require('./export.js');
  } catch (e) {
    throw new CouldNot(`no pude cargar el lector del nombre público, scripts/publishing/export.js (${(e && e.code) || 'error'})`);
  }
  try {
    return file ? exporter.readPublicRepo(path.resolve(file)) : exporter.readPublicRepo();
  } catch (e) {
    if (!(e instanceof exporter.NoPudo)) throw e;
    throw new CouldNot(`${e.message} — el token se pide para el repo de ese archivo (o del que diga --public-repos <f>)`);
  }
}

/** La llave privada de la App. De un error sale su código, nunca su texto. */
function readKey(file) {
  let pem;
  try {
    pem = fs.readFileSync(file);
  } catch (e) {
    throw new CouldNot(`no pude leer la llave de la App ${file} (${(e && e.code) || 'error'})`);
  }
  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch (e) {
    throw new CouldNot(`la llave de la App ${file} no es una llave privada que se deje leer (${(e && e.code) || 'formato'})`);
  }
  if (key.asymmetricKeyType !== 'rsa') throw new CouldNot(`la llave de la App ${file} no es RSA: el JWT se firma con RS256`);
  return key;
}

const base64url = (x) => Buffer.from(x).toString('base64url');

/** El JWT con el que la App se presenta: RS256, emitido por ella, con 10 minutos de vida. */
function signJwt(appId, key, now) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iat: now - CLOCK_DRIFT_SECONDS, exp: now + SECONDS_AHEAD, iss: appId }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), key).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

/** El pedido. Devuelve el código y, sólo si es 201, el cuerpo: el de cualquier otra respuesta ni se guarda. */
function post(base, route, jwt, body) {
  const client = base.protocol === 'https:' ? require('https') : require('http');
  const payload = Buffer.from(JSON.stringify(body));
  const where = `${base.protocol}//${base.host}`;
  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: base.protocol,
      hostname: base.hostname.replace(/^\[|\]$/g, ''),
      port: base.port || undefined,
      path: `${base.pathname.replace(/\/+$/, '')}${route}`,
      method: 'POST',
      agent: false,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-app-token.js',
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
    }, (answer) => {
      if (answer.statusCode !== 201) {
        // el cuerpo no se lee: se corta la conexión, así un servidor que no termina nunca no deja la corrida colgada
        resolve({ status: answer.statusCode });
        answer.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      answer.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_ANSWER_BYTES) {
          reject(new CouldNot(`la API contestó 201 con más de ${MAX_ANSWER_BYTES} bytes: eso no es un token`));
          answer.destroy();
          return;
        }
        chunks.push(chunk);
      });
      answer.on('end', () => resolve({ status: 201, text: Buffer.concat(chunks).toString('utf8') }));
      answer.on('error', (e) => reject(new CouldNot(`la respuesta de la API ${where} se cortó (${(e && e.code) || 'error de red'})`)));
    });
    request.on('timeout', () => {
      reject(new CouldNot(`la API ${where} no contestó en ${REQUEST_TIMEOUT_MS / 1000} segundos`));
      request.destroy();
    });
    request.on('error', (e) => reject(new CouldNot(`no pude hablar con la API ${where} (${(e && e.code) || 'error de red'})`)));
    request.end(payload);
  });
}

/** El token de un 201. Lo que no se entiende no se imprime: el error de quien lee un JSON cita el cuerpo. */
function tokenOf(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new CouldNot('la API contestó 201 con un cuerpo que no es JSON');
  }
  const token = data && typeof data === 'object' ? data.token : undefined;
  // un token es una sola palabra imprimible: con un espacio o un salto de línea, quien lo captura se lleva otra cosa
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) throw new CouldNot('la API contestó 201 sin un token que se pueda usar');
  return token;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const settings = readSettings(process.env);
  const base = apiBase(process.env);
  const { repo } = publicRepo(args.publicRepos);
  const key = readKey(settings.keyFile);
  const jwt = signJwt(settings.appId, key, Math.floor(Date.now() / 1000));
  const answer = await post(base, `/app/installations/${settings.installationId}/access_tokens`, jwt,
    { repositories: [repo], permissions: { ...PERMISSIONS } });
  if (answer.status !== 201) throw new CouldNot(`la API contestó ${answer.status} al pedir el token (se esperaba 201)`);
  return tokenOf(answer.text);
}

function fail(e) {
  const reason = e instanceof CouldNot ? e.message : `error inesperado (${(e && (e.code || e.name)) || 'sin código'})`;
  process.stderr.write(`${PREFIX}${reason}\n`);
  // exitCode y no exit(): no corta lo que la salida de error todavía no escribió
  process.exitCode = 2;
}

if (require.main === module) {
  // lo que nadie atajó también es «no pude»: sin traza (podría citar lo que no se imprime) y sin quedar esperando
  process.on('uncaughtException', (e) => {
    fail(e);
    process.exit(2);
  });
  main().then((token) => {
    process.stdout.write(`${token}\n`);
  }, fail);
}
