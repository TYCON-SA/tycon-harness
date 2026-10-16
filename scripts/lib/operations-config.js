#!/usr/bin/env node
'use strict';
// operations-config.js — la configuración de los nocturnos de una organización (story 8.26, tanda J · 2026-10-13).
//
// POR QUÉ EXISTE: a quién se asigna un Bug de dependencias y quiénes revisan los pedidos que abren los nocturnos estaba
// a mano —un mail de respaldo escrito en el código y dos variables de las definiciones de Azure—, y una organización
// nueva no tenía dónde decir los suyos. `operations.json`, en la raíz del repo de operaciones de la organización, lo
// declara. Ese repo NO se instala en las máquinas: la lista de personas no le llega a todo el equipo (decisión del
// dueño). La leen sólo los pipelines de operaciones. Quién puede cambiarla lo deciden los permisos de ese repo.
//
// LA FORMA (versión 1):
//   { "version": 1,
//     "owners": { "default": <identidad>,                    obligatorio — a quién, cuando no se deduce un dueño
//                 "by_project": { "<proyecto>": <identidad> } },  opcional — el responsable de cada proyecto
//     "reviewers": { "dependencies": [<identidad>, …],      opcional — quiénes revisan los pedidos de dependencias
//                    "watcher": [<identidad>, …] },         opcional — y los del vigilante
//     "site": { "maintainers": [<correo>, …],                opcional — quiénes mantienen el sitio de la organización
//               "mailbox": { "provider": "azure-blob",        opcional — el buzón de corridas que lee el sitio
//                            "account": <texto>, "container": <texto>, "threads": <bool> },
//               "refresh_minutes": <5 a 120> } }              opcional — cada cuánto se releen las fuentes (story 2.23)
//   En `site`, una clave con forma de secreto (token, secret, sas, password, key…) es un problema en cualquier nivel: los
//   secretos del sitio van en las variables de su plataforma.
//   <identidad> = el nombre único de la plataforma: el principalName de Azure (el que viaja en System.AssignedTo) o
//   el usuario de GitHub. Nunca un chat de Telegram ni un token: esos siguen en el grupo de variables secreto.
//   Las claves que empiezan con `__` son comentarios; cualquier otra desconocida es un problema en su ruta.
//
// EL CONTRATO: el mismo de scripts/lib/team-repos.js — `parse(text)` → `{ ok, data, problems: [{ path, message }] }`,
// sin datos a medias; `load(file)` suma `couldNotRead`.
//
// A mano: node scripts/lib/operations-config.js <archivo> [--json]   → exit 0 válido · 1 con problemas · 2 no pude leer

const fs = require('fs');

const VERSION = 1;
const KEYS = ['version', 'owners', 'reviewers', 'site'];
const OWNER_KEYS = ['default', 'by_project'];
const REVIEWER_KEYS = ['dependencies', 'watcher'];
// story 2.23: el sitio de la organización. Todas opcionales; la 2.29 la edita desde el sitio, la 2.30 suma `url`.
const SITE_KEYS = ['maintainers', 'mailbox', 'refresh_minutes'];
const MAILBOX_KEYS = ['provider', 'account', 'container', 'threads'];
const MAILBOX_PROVIDERS = ['azure-blob'];
const REFRESH_MIN = 5;
const REFRESH_MAX = 120;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT = /^[a-z0-9]{3,24}$/;
const CONTAINER = /^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/;
// Una clave con forma de secreto, en cualquier nivel de `site`: los secretos van a las variables de la plataforma, nunca a
// un archivo que cambia por pedido y que leen los nocturnos.
const SECRET_KEY = /token|secret|sas|password|passwd|pwd|key|credential/i;
// Una identidad: sin espacios ni controles; un principalName de Azure (usuario@dominio) o un usuario de GitHub.
const IDENTITY = /^[^\s@]+(@[^\s@]+)?$/;

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const comment = (k) => k.startsWith('__');

function identityProblems(v, at) {
  if (typeof v !== 'string' || !v.trim()) return [{ path: at, message: 'tiene que ser una identidad (un texto no vacío)' }];
  if (!IDENTITY.test(v)) return [{ path: at, message: `«${v}» no es una identidad: el principalName de Azure o el usuario de GitHub, sin espacios` }];
  return [];
}

function unknownKeys(obj, allowed, at) {
  return Object.keys(obj).filter((k) => !comment(k) && !allowed.includes(k)).map((k) => ({ path: at ? `${at}.${k}` : k, message: 'clave desconocida' }));
}

/** Las claves de `obj` (y de sus objetos, en cualquier nivel) que no van: con forma de secreto o desconocidas. */
function siteKeyProblems(obj, allowed, at) {
  const problems = [];
  for (const k of Object.keys(obj)) {
    if (comment(k)) continue;
    const here = `${at}.${k}`;
    if (SECRET_KEY.test(k)) { problems.push({ path: here, message: 'clave con forma de secreto: los secretos van en las variables de la plataforma del sitio, nunca en operations.json' }); continue; }
    if (allowed && allowed.includes(k)) continue;
    problems.push({ path: here, message: 'clave desconocida' });
    if (isObject(obj[k])) problems.push(...siteKeyProblems(obj[k], null, here));
  }
  return problems;
}

function siteProblems(site) {
  if (!isObject(site)) return [{ path: 'site', message: 'tiene que ser un objeto' }];
  const problems = siteKeyProblems(site, SITE_KEYS, 'site');
  if (site.maintainers !== undefined) {
    if (!Array.isArray(site.maintainers)) problems.push({ path: 'site.maintainers', message: 'tiene que ser una lista de correos' });
    else site.maintainers.forEach((m, i) => {
      if (typeof m !== 'string' || !EMAIL.test(m)) problems.push({ path: `site.maintainers.${i}`, message: `«${typeof m === 'string' ? m : JSON.stringify(m)}» no es un correo` });
    });
  }
  const mb = site.mailbox;
  if (mb !== undefined) {
    if (!isObject(mb)) problems.push({ path: 'site.mailbox', message: 'tiene que ser un objeto { provider, account, container }' });
    else {
      problems.push(...siteKeyProblems(mb, MAILBOX_KEYS, 'site.mailbox'));
      if (!MAILBOX_PROVIDERS.includes(mb.provider)) problems.push({ path: 'site.mailbox.provider', message: `tiene que ser uno de: ${MAILBOX_PROVIDERS.join(', ')}` });
      // 🔴 la cuenta y el contenedor arman el host y la ruta adonde va la credencial del buzón: sólo la forma de Azure
      //    Storage (la misma que exige upload-runs.js). Un «host.malo/x?» mandaría la SAS o el token a otro servidor.
      if (typeof mb.account !== 'string' || !ACCOUNT.test(mb.account)) problems.push({ path: 'site.mailbox.account', message: 'tiene que tener la forma de una cuenta de almacenamiento (3 a 24 minúsculas o números)' });
      if (typeof mb.container !== 'string' || !CONTAINER.test(mb.container)) problems.push({ path: 'site.mailbox.container', message: 'tiene que tener la forma de un contenedor (3 a 63 minúsculas, números o guiones)' });
      if (mb.threads !== undefined && typeof mb.threads !== 'boolean') problems.push({ path: 'site.mailbox.threads', message: 'tiene que ser true o false' });
    }
  }
  const rm = site.refresh_minutes;
  if (rm !== undefined && (!Number.isInteger(rm) || rm < REFRESH_MIN || rm > REFRESH_MAX)) {
    problems.push({ path: 'site.refresh_minutes', message: `tiene que ser un entero de ${REFRESH_MIN} a ${REFRESH_MAX} (es ${JSON.stringify(rm)})` });
  }
  return problems;
}

function validate(doc) {
  if (!isObject(doc)) return [{ path: '', message: 'el archivo tiene que ser un objeto JSON' }];
  const problems = [...unknownKeys(doc, KEYS, '')];
  if (doc.version === undefined) problems.push({ path: 'version', message: 'falta' });
  else if (doc.version !== VERSION) problems.push({ path: 'version', message: `tiene que ser ${VERSION} (es ${JSON.stringify(doc.version)})` });

  if (doc.owners === undefined) problems.push({ path: 'owners', message: 'falta' });
  else if (!isObject(doc.owners)) problems.push({ path: 'owners', message: 'tiene que ser un objeto' });
  else {
    problems.push(...unknownKeys(doc.owners, OWNER_KEYS, 'owners'));
    if (doc.owners.default === undefined) problems.push({ path: 'owners.default', message: 'falta' });
    else problems.push(...identityProblems(doc.owners.default, 'owners.default'));
    const bp = doc.owners.by_project;
    if (bp !== undefined) {
      if (!isObject(bp)) problems.push({ path: 'owners.by_project', message: 'tiene que ser un objeto { "<proyecto>": identidad }' });
      else for (const [proj, who] of Object.entries(bp)) {
        if (comment(proj)) continue;
        if (!proj.trim()) problems.push({ path: 'owners.by_project', message: 'un proyecto sin nombre' });
        else problems.push(...identityProblems(who, `owners.by_project.${proj}`));
      }
    }
  }

  if (doc.reviewers !== undefined) {
    if (!isObject(doc.reviewers)) problems.push({ path: 'reviewers', message: 'tiene que ser un objeto' });
    else {
      problems.push(...unknownKeys(doc.reviewers, REVIEWER_KEYS, 'reviewers'));
      for (const k of REVIEWER_KEYS) {
        const list = doc.reviewers[k];
        if (list === undefined) continue;
        if (!Array.isArray(list)) problems.push({ path: `reviewers.${k}`, message: 'tiene que ser una lista de identidades' });
        else list.forEach((who, i) => problems.push(...identityProblems(who, `reviewers.${k}.${i}`)));
      }
    }
  }
  if (doc.site !== undefined) problems.push(...siteProblems(doc.site));
  return problems;
}

/** `{ ok, data, problems }` del texto de un operations.json. */
function parse(text) {
  let doc;
  try { doc = JSON.parse(String(text)); } catch (e) {
    return { ok: false, data: null, problems: [{ path: '', message: `no es JSON válido: ${String((e && e.message) || e).split('\n')[0]}` }] };
  }
  const problems = validate(doc);
  return { ok: problems.length === 0, data: problems.length ? null : doc, problems };
}

/** Lo mismo desde un archivo; si no se pudo leer, `couldNotRead: true` con el motivo. */
function load(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, data: null, couldNotRead: true, problems: [{ path: '', message: `no pude leer ${file}: ${(e && e.code) || (e && e.message) || e}` }] };
  }
  return { ...parse(text), couldNotRead: false };
}

/** El responsable de un proyecto: el declarado para él o, si no hay, el de respaldo. */
function ownerFor(data, project) {
  if (!data || !data.owners) return null;
  const bp = data.owners.by_project || {};
  return Object.prototype.hasOwnProperty.call(bp, project) ? bp[project] : data.owners.default;
}

module.exports = { VERSION, KEYS, OWNER_KEYS, REVIEWER_KEYS, SITE_KEYS, MAILBOX_PROVIDERS, REFRESH_MIN, REFRESH_MAX, EMAIL, ACCOUNT, CONTAINER, parse, load, ownerFor };

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { process.stderr.write('uso: node scripts/lib/operations-config.js <operations.json> [--json]\n'); process.exit(2); }
  const r = load(file);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else if (r.ok) process.stdout.write(`✅ ${file}: válido\n`);
  else for (const p of r.problems) process.stdout.write(`❌ ${p.path || '(el archivo)'}: ${p.message}\n`);
  process.exit(r.ok ? 0 : (r.couldNotRead ? 2 : 1));
}
