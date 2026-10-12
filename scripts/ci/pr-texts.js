#!/usr/bin/env node
'use strict';
// pr-texts.js — el título y el cuerpo de un pedido de GitHub, para que el freno de publicación los mire en la
// validación (story 8.26, tanda F2 · AC 23).
//
// POR QUÉ EXISTE. El título y el cuerpo de un pedido se publican con él y no están en git: el freno
// (scripts/hooks/public-push-guard.js, modo `range`) mira commits, y esos dos textos hay que traérselos. Azure no se los
// da a la corrida en ninguna variable. Este guion los lee de la API de GitHub y los deja en dos archivos; el freno no
// habla con la red.
//
// QUÉ GARANTIZA
//   · «No pude leer» es 2 y NO deja archivos: dos archivos vacíos se leerían como «un título y un cuerpo limpios». Los
//     de un intento anterior se borran antes de pedir nada.
//   · Un pedido sin cuerpo es legítimo: deja el archivo del cuerpo vacío y sale 0.
//   · No imprime ni el título ni el cuerpo (el registro de la validación es público), ni la credencial.
//   · La base de la API es la de GitHub, escrita acá. `--api` la cambia SÓLO hacia la propia máquina (las pruebas
//     levantan ahí una API de mentira): hacia cualquier otro servidor se niega, cifrado o no, porque con ella viaja
//     la credencial del checkout. Ninguna variable de entorno la cambia.
//   · No sigue redirecciones: la credencial no viaja a donde mande la respuesta.
//
// LA CREDENCIAL, en orden: la que el checkout de Azure deja en el clon (`persistCredentials: true`: una cabecera de
// más de git para github.com) si se le dice dónde está el clon con `--credential-from`; sin ella —o si la API la
// rechaza con 401, 403 o 404: sirve para git y puede no servir para la API—, sin credencial: el repo es público. Con
// cuál leyó, lo dice. Sale del clon por una pregunta a git y va derecho a la cabecera del pedido: no pasa por un
// argumento ni por el ambiente de ningún proceso.
//
// USO
//   node scripts/ci/pr-texts.js --repo <dueño>/<repo> --number <N> --out <carpeta> [--credential-from <clon>] [--api <base>]
//   Deja <carpeta>/pr-title.txt y <carpeta>/pr-body.txt. Códigos: 0 leídos · 2 no pude (o los argumentos no valen).
//   PR_TEXTS_TIMEOUT_MS cambia cuánto se espera a la API (30 s): es de las pruebas.
// Casos: scripts/tests/pr-texts.test.js (T64).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_API = 'https://api.github.com';
const LOCAL_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);
const TITLE_FILE = 'pr-title.txt';
const BODY_FILE = 'pr-body.txt';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_BYTES = 2 * 1024 * 1024;   // el cuerpo de un pedido tiene un tope de 65.536 caracteres: esto sobra
const NAME_OK = /^[A-Za-z0-9._-]+$/;
// los códigos con que la API dice «esa credencial no»: con ellos —y sólo con ellos— se prueba sin credencial
const REFUSED = Object.freeze([401, 403, 404]);

class CouldNot extends Error {}

function parseArgs(argv) {
  const valued = new Map([['--repo', 'repo'], ['--number', 'number'], ['--out', 'out'], ['--credential-from', 'credentialFrom'], ['--api', 'api']]);
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = valued.get(argv[i]);
    const value = argv[i + 1];
    if (!key) throw new CouldNot(`opción desconocida: ${argv[i]}`);
    if (value === undefined || value === '' || value.startsWith('--')) throw new CouldNot(`${argv[i]} necesita un valor`);
    args[key] = value;
    i += 1;
  }
  const parts = String(args.repo || '').split('/');
  if (parts.length !== 2 || !parts.every((p) => NAME_OK.test(p) && p !== '.' && p !== '..')) throw new CouldNot('--repo tiene que ser <dueño>/<repo>');
  if (!/^[1-9][0-9]{0,9}$/.test(String(args.number || ''))) throw new CouldNot('--number tiene que ser el número del pedido');
  if (!args.out) throw new CouldNot('falta --out: la carpeta donde dejar el título y el cuerpo');
  return { owner: parts[0], repo: parts[1], number: Number(args.number), out: path.resolve(args.out), credentialFrom: args.credentialFrom || null, api: args.api === undefined ? new URL(DEFAULT_API) : apiBase(args.api) };
}

/**
 * La base de la API que llega por `--api`: sólo la propia máquina (http:// o https://), sin usuario, sin consulta, sin
 * fragmento. La de GitHub no pasa por acá: es la constante de arriba.
 */
function apiBase(text) {
  let url;
  try { url = new URL(text); } catch (_) { throw new CouldNot('la base de la API no es una dirección'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CouldNot('la base de la API va con https:// o http://');
  if (!LOCAL_HOSTS.includes(url.hostname)) throw new CouldNot('la base de la API sólo se cambia hacia la propia máquina: a otro servidor viajaría la credencial del checkout');
  if (url.username || url.password || url.search || url.hash) throw new CouldNot('la base de la API no lleva usuario, clave, consulta ni fragmento');
  return url;
}

/**
 * La credencial que el checkout dejó en el clon para github.com: el valor de su cabecera `AUTHORIZATION`, o null.
 * Cualquier cosa que no sea exactamente eso —otra cabecera, otro servidor, una carpeta que no es un clon— es «no hay».
 */
function credentialFrom(dir) {
  if (!dir) return null;
  const r = spawnSync('git', ['-C', dir, 'config', '--local', '--get-regexp', '^http\\..*\\.extraheader$'], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  for (const line of String(r.stdout || '').split('\n')) {
    const m = /^http\.(\S+)\.extraheader AUTHORIZATION: (\S+ \S+)$/i.exec(line.trim());
    if (!m) continue;
    let host = null;
    try { host = new URL(m[1]).hostname.toLowerCase(); } catch (_) { host = null; }
    if (host === 'github.com') return m[2];
  }
  return null;
}

function timeoutMs(env) {
  const n = Number(env.PR_TEXTS_TIMEOUT_MS);
  return env.PR_TEXTS_TIMEOUT_MS && Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** Un GET: `{ status, json }`. No sigue redirecciones (un 3xx es una respuesta más, que no sirve). */
function get(api, rest, authorization, waitMs) {
  const client = api.protocol === 'https:' ? require('https') : require('http');
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'pr-texts.js' };
  if (authorization) headers.Authorization = authorization;
  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: api.protocol, hostname: api.hostname.replace(/^\[|\]$/g, ''), port: api.port || undefined,
      path: `${api.pathname.replace(/\/+$/, '')}${rest}`, method: 'GET', agent: false, timeout: waitMs, headers,
    }, (answer) => {
      const chunks = [];
      let size = 0;
      answer.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) { reject(new CouldNot('la API contestó más de lo que pesa un pedido')); answer.destroy(); return; }
        chunks.push(chunk);
      });
      answer.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { json = null; }
        resolve({ status: answer.statusCode, json });
      });
      answer.on('error', (e) => reject(new CouldNot(`la respuesta de la API se cortó (${(e && e.code) || 'error de red'})`)));
    });
    request.on('timeout', () => { reject(new CouldNot(`la API no contestó en ${Math.round(waitMs / 100) / 10} segundos`)); request.destroy(); });
    request.on('error', (e) => reject(new CouldNot(`no pude hablar con la API (${(e && e.code) || 'error de red'})`)));
    request.end();
  });
}

async function main(argv, env = process.env) {
  let args;
  try { args = parseArgs(argv); } catch (e) {
    if (!(e instanceof CouldNot)) throw e;
    process.stderr.write(`⛔ pr-texts: ${e.message}\n   uso: pr-texts.js --repo <dueño>/<repo> --number <N> --out <carpeta> [--credential-from <clon>] [--api <base>]\n`);
    return 2;
  }
  const titleFile = path.join(args.out, TITLE_FILE);
  const bodyFile = path.join(args.out, BODY_FILE);
  const drop = () => { for (const f of [titleFile, bodyFile]) fs.rmSync(f, { force: true }); };
  try {
    fs.mkdirSync(args.out, { recursive: true });
    drop();   // lo de un intento anterior no es de este pedido
    const credential = credentialFrom(args.credentialFrom);
    const rest = `/repos/${args.owner}/${args.repo}/pulls/${args.number}`;
    const waitMs = timeoutMs(env);
    let used = credential ? 'con la credencial del checkout' : 'sin credencial';
    let r = await get(args.api, rest, credential, waitMs);
    if (credential && REFUSED.includes(r.status)) {
      used = `sin credencial (con la del checkout la API contestó ${r.status})`;
      r = await get(args.api, rest, null, waitMs);
    }
    if (r.status !== 200) throw new CouldNot(`la API contestó ${r.status}`);
    const pr = r.json;
    if (!pr || typeof pr !== 'object' || Array.isArray(pr) || pr.number !== args.number || typeof pr.title !== 'string') throw new CouldNot('la API contestó algo que no es ese pedido');
    if (pr.body !== null && pr.body !== undefined && typeof pr.body !== 'string') throw new CouldNot('la API contestó un cuerpo que no es texto');
    fs.writeFileSync(bodyFile, pr.body || '');
    fs.writeFileSync(titleFile, pr.title);
    process.stdout.write(`pr-texts: título y cuerpo del pedido nº ${args.number} leídos, ${used}\n`);
    return 0;
  } catch (e) {
    try { drop(); } catch (_) { /* lo que importa es el 2 */ }
    const known = e instanceof CouldNot;
    // un error no previsto se nombra por su clase: su texto puede traer una ruta o un pedazo de la respuesta
    process.stderr.write(`⛔ pr-texts: no pude leer el título y el cuerpo del pedido nº ${args.number} — ${known ? e.message : `error no previsto (${(e && (e.code || e.name)) || 'error'})`}\n`);
    return 2;
  }
}

module.exports = { parseArgs, apiBase, credentialFrom, TITLE_FILE, BODY_FILE, main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => {
    process.stderr.write('⛔ pr-texts: no pude leer el título y el cuerpo del pedido — error no previsto\n');
    process.exitCode = 2;
  });
}
