#!/usr/bin/env node
'use strict';
// operations-config.js — la configuración de los nocturnos de una organización (story 8.26, tanda J · 2026-10-13).
//
// POR QUÉ EXISTE: a quién se asigna un Bug de dependencias y quiénes revisan los pedidos que abren los nocturnos estaba
// a mano —un mail de respaldo escrito en el código y dos variables de las definiciones de Azure—, y una organización
// nueva no tenía dónde decir los suyos. `operations.json`, en la raíz del repo de operaciones de la organización, lo
// declara. Ese repo NO se instala en las máquinas: la lista de personas no le llega a todo el equipo (decisión del
// dueño). La leen los pipelines de operaciones y el sitio de la organización. Quién puede cambiarla lo deciden los
// permisos de ese repo.
//
// LA FORMA (versión 1):
//   { "version": 1,
//     "owners": { "default": <identidad>,                    obligatorio — a quién, cuando no se deduce un dueño
//                 "by_project": { "<proyecto>": <identidad> } },  opcional — el responsable de cada proyecto
//     "reviewers": { "dependencies": [<identidad>, …],      opcional — quiénes revisan los pedidos de dependencias
//                    "watcher": [<identidad>, …] },         opcional — y los del vigilante
//     "site": { "maintainers": [<correo>, …],                opcional — quiénes mantienen el sitio de la organización
//               "mailbox": { "provider": "azure-blob",        opcional — el buzón de corridas que lee el sitio
//                            "account": <texto>, "container": <texto>, "threads": <bool> },  threads: true baja también
//                                                            las conversaciones y los cambios de git para el detalle de
//                                                            la pestaña Corridas, si el sitio tiene disco (story 2.27)
//               "refresh_minutes": <5 a 120>,              opcional — cada cuánto se releen las fuentes
//               "url": "https://…",                           opcional — la dirección del sitio, sólo https y sin usuario
//                                                            ni clave: va en el aviso de la mañana
//               "auto_apply": <bool>,                       opcional — true: «Proponer» de quien mantiene el sitio
//                                                            aprueba y completa el pedido con la identidad del sitio, si
//                                                            las políticas de main lo dejan; sin la clave, false
//               "brand": { "name": <texto>,                 opcional — la marca del sitio: el nombre de la organización,
//                          "logo": <ruta en este repo, .png o .svg>, el logo (vive acá, en el repo de operaciones) y
//                          "dark": "invert" | "keep" } },     qué hacer con él en el tema oscuro (por defecto, invertirlo)
//     "notify": { "channel": "telegram" | "slack" | "teams" }, opcional — por dónde sale el aviso de los nocturnos
//                                                            Sin `notify` no se manda nada. El destino
//                                                            (el chat, el token, la dirección del webhook) va en los
//                                                            secretos del pipeline, nunca acá.
//     "people": {                                            opcional — quién es quién (story 2.28)
//       "machines": { "<máquina>": {                         opcional — cada máquina confirmada por un mantenedor
//           "person": <correo>,                              la persona dueña de las corridas de esa máquina
//           "reported_sha256": <64 hexadecimales> | null,    la huella del correo que informaba la máquina al confirmar
//           "confirmed_by": <correo>,                        quién la confirmó
//           "confirmed_on": "AAAA-MM-DD" } },                y qué día
//       "projects": { "<correo>": {                          opcional — corrige «dónde trabaja» cada persona
//           "add": [<producto>, …],                          productos que se suman a los deducidos
//           "remove": [<producto>, …] } } } }              y los que se sacan (un producto no va en las dos)
//   En `site`, una clave con forma de secreto (token, secret, sas, password, key…) es un problema en cualquier nivel: los
//   secretos del sitio van en las variables de su plataforma.
//   <identidad> = el nombre único de la plataforma: el principalName de Azure (el que viaja en System.AssignedTo) o
//   el usuario de GitHub. Nunca un chat de Telegram ni un token: esos siguen en el grupo de variables secreto.
//   <máquina> = la carpeta de la máquina en el buzón de corridas, con la forma FORMA_MAQUINA (minúsculas, sin espacios).
//   <correo> = un correo con forma de correo; se compara sin mayúsculas ni espacios alrededor (lo hace people.js).
//   `reported_sha256` es el sha256 del correo informado, en minúsculas y sin espacios alrededor; NUNCA el correo en
//   claro: el archivo queda en la historia de git del repo de operaciones para siempre. `null` si la máquina no
//   informaba correo al confirmarla.
//     "deployments": {                                       opcional — de qué sistema se leen los despliegues (story 2.22)
//       "provider": "azure" | "github",
//       "products": { "<producto>": { "staging": [<entrada>…], "production": [<entrada>…] } } }   listas no vacías
//   Una entrada de Azure: { "pipeline": "<proyecto>/<nombre exacto de la definición>", "stages": ["<identificador>", …] }
//   (el identificador del YAML, exacto: nunca el nombre visible ni un pedazo de texto). Una de GitHub: { "repo":
//   "<dueño>/<repo>", "environment": "<nombre>", "workflow": "<archivo>" } (`workflow` opcional, sólo en staging). Un
//   proveedor desconocido es un problema, no se ignora.
//   Las claves que empiezan con `__` son comentarios; cualquier otra desconocida es un problema en su ruta.
//
// EL CONTRATO: el mismo de scripts/lib/team-repos.js — `parse(text)` → `{ ok, data, problems: [{ path, message }] }`,
// sin datos a medias; `load(file)` suma `couldNotRead`.
//
// A mano: node scripts/lib/operations-config.js <archivo> [--json]   → exit 0 válido · 1 con problemas · 2 no pude leer

const fs = require('fs');

const VERSION = 1;
const KEYS = ['version', 'owners', 'reviewers', 'site', 'people', 'deployments', 'notify'];
// story 2.22: de qué sistema se leen los despliegues de cada producto. Sin nombres por defecto: todo lo declara la
// organización (el identificador EXACTO de cada stage, o el environment de GitHub).
const DEPLOYMENT_PROVIDERS = ['azure', 'github'];
const DEPLOYMENT_SIDES = ['staging', 'production'];
const AZURE_ENTRY_KEYS = ['pipeline', 'stages'];
const GITHUB_ENTRY_KEYS = ['repo', 'environment', 'workflow'];
// sin segmentos hechos sólo de puntos: «../..» desviaría la ruta de la API adonde va el token
const GITHUB_REPO = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/;
const OWNER_KEYS = ['default', 'by_project'];
const REVIEWER_KEYS = ['dependencies', 'watcher'];
// el sitio de la organización. Todas opcionales; la pestaña Configuración del sitio la edita.
const SITE_KEYS = ['maintainers', 'mailbox', 'refresh_minutes', 'url', 'brand', 'auto_apply', 'hidden_cards'];
const BRAND_KEYS = ['name', 'logo', 'dark'];
const BRAND_THEME_OPTIONS = ['invert', 'keep'];
// el logo: una ruta relativa dentro del repo de operaciones, sin subir de carpeta, a un .png o un .svg
const BRAND_LOGO = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\/-]{1,200}\.(png|svg)$/;
const BRAND_NAME_MAX = 80;
// el canal del aviso. Sin canal por defecto: sin `notify`, no se manda (un canal por defecto sería un valor de
// una organización en el código). Lo lee scripts/lib/notify.js (`canalDe`).
const NOTIFY_KEYS = ['channel'];
const NOTIFY_CHANNELS = ['telegram', 'slack', 'teams'];
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
// story 2.28: quién es quién
const PEOPLE_KEYS = ['machines', 'projects'];
const MACHINE_KEYS = ['person', 'reported_sha256', 'confirmed_by', 'confirmed_on'];
const PROJECT_KEYS = ['add', 'remove'];
// El nombre de la carpeta de una máquina en el buzón. COPIADA de scripts/metrics/upload-runs.js (no se importa: este
// lector viaja solo y no carga nada fuera de fs). T23 de scripts/tests/team-repos.test.js exige que las dos sean iguales.
const FORMA_MAQUINA = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

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
  if (site.url !== undefined && !siteUrlOk(site.url)) {
    problems.push({ path: 'site.url', message: 'tiene que ser una dirección https://, sin usuario ni clave' });
  }
  if (site.auto_apply !== undefined && typeof site.auto_apply !== 'boolean') problems.push({ path: 'site.auto_apply', message: 'tiene que ser true o false' });
  // las fichas del tablero que el sitio no muestra: una lista de identificadores de scripts/site/tabs/cards.js
  if (site.hidden_cards !== undefined) problems.push(...hiddenCardsProblems(site.hidden_cards));
  const b = site.brand;
  if (b !== undefined) {
    if (!isObject(b)) problems.push({ path: 'site.brand', message: 'tiene que ser un objeto { name, logo, dark }' });
    else {
      problems.push(...siteKeyProblems(b, BRAND_KEYS, 'site.brand'));
      if (b.name !== undefined && !(typeof b.name === 'string' && b.name.trim() && b.name.length <= BRAND_NAME_MAX)) problems.push({ path: 'site.brand.name', message: `tiene que ser el nombre de la organización (hasta ${BRAND_NAME_MAX} caracteres)` });
      if (b.logo !== undefined && !(typeof b.logo === 'string' && BRAND_LOGO.test(b.logo))) problems.push({ path: 'site.brand.logo', message: 'tiene que ser la ruta de un .png o un .svg dentro del repo de operaciones (sin «..» ni «/» al principio)' });
      if (b.dark !== undefined && !BRAND_THEME_OPTIONS.includes(b.dark)) problems.push({ path: 'site.brand.dark', message: 'tiene que ser «invert» (invertir el logo en el tema oscuro) o «keep» (dejarlo como está)' });
    }
  }
  return problems;
}

/** Los identificadores de ficha que el sitio sabe mostrar; sin la lista del sitio en este árbol, no se juzga cuáles hay. */
function fichaIds() {
  try { return require('../site/tabs/cards.js').FICHAS.map((f) => f.id); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes('cards.js')) return null;
    throw e;
  }
}

function hiddenCardsProblems(v) {
  if (!Array.isArray(v)) return [{ path: 'site.hidden_cards', message: 'tiene que ser una lista de identificadores de ficha' }];
  const ids = fichaIds();
  const problems = [];
  const vistas = new Set();
  v.forEach((id, i) => {
    const at = `site.hidden_cards.${i}`;
    if (typeof id !== 'string' || !id) problems.push({ path: at, message: 'tiene que ser el identificador de una ficha (un texto)' });
    else if (ids && !ids.includes(id)) problems.push({ path: at, message: `«${id.slice(0, 60)}» no es una ficha del sitio` });
    else if (vistas.has(id)) problems.push({ path: at, message: `«${id}» está repetida` });
    else vistas.add(id);
  });
  return problems;
}

/** La dirección del sitio: https, con host, sin usuario ni clave (viaja en un aviso que lee cualquiera del chat). */
function siteUrlOk(v) {
  if (typeof v !== 'string') return false;
  let u;
  try { u = new URL(v); } catch { return false; }
  return u.protocol === 'https:' && Boolean(u.hostname) && !u.username && !u.password;
}

function notifyProblems(notify) {
  if (!isObject(notify)) return [{ path: 'notify', message: 'tiene que ser un objeto { "channel": … }' }];
  const problems = [];
  for (const k of Object.keys(notify)) {
    if (comment(k) || NOTIFY_KEYS.includes(k)) continue;
    // el chat, el token o la dirección del webhook: el destino es una credencial y va en los secretos del pipeline
    if (SECRET_KEY.test(k) || /webhook|chat|url/i.test(k)) problems.push({ path: `notify.${k}`, message: 'clave con forma de secreto: el destino del aviso va en los secretos del pipeline, nunca en operations.json' });
    else problems.push({ path: `notify.${k}`, message: 'clave desconocida' });
  }
  if (!NOTIFY_CHANNELS.includes(notify.channel)) problems.push({ path: 'notify.channel', message: `tiene que ser uno de: ${NOTIFY_CHANNELS.join(', ')}` });
  return problems;
}

function emailProblems(v, at) {
  if (typeof v !== 'string' || !v.trim()) return [{ path: at, message: 'tiene que ser un correo (un texto no vacío)' }];
  if (!EMAIL.test(v)) return [{ path: at, message: `«${v}» no tiene forma de correo (usuario@dominio, sin espacios)` }];
  return [];
}

function dayProblems(v, at) {
  const m = typeof v === 'string' ? DAY.exec(v) : null;
  if (!m) return [{ path: at, message: 'tiene que ser un día con la forma AAAA-MM-DD' }];
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return [{ path: at, message: `«${v}» no es un día que exista` }];
  return [];
}

// Quién es quién (story 2.28). Una máquina con nombre mal formado se marca y su entrada se revisa igual.
function peopleProblems(people) {
  if (!isObject(people)) return [{ path: 'people', message: 'tiene que ser un objeto { "machines": …, "projects": … }' }];
  const problems = [...unknownKeys(people, PEOPLE_KEYS, 'people')];
  const { machines, projects } = people;
  if (machines !== undefined) {
    if (!isObject(machines)) problems.push({ path: 'people.machines', message: 'tiene que ser un objeto { "<máquina>": { person, reported_sha256, confirmed_by, confirmed_on } }' });
    else for (const [name, entry] of Object.entries(machines)) {
      if (comment(name)) continue;
      const at = `people.machines.${name}`;
      if (!FORMA_MAQUINA.test(name)) problems.push({ path: at, message: `«${name}» no es un nombre de máquina: el de su carpeta en el buzón, en minúsculas, sin espacios` });
      if (!isObject(entry)) { problems.push({ path: at, message: 'tiene que ser un objeto { person, reported_sha256, confirmed_by, confirmed_on }' }); continue; }
      problems.push(...unknownKeys(entry, MACHINE_KEYS, at));
      for (const k of MACHINE_KEYS) if (entry[k] === undefined) problems.push({ path: `${at}.${k}`, message: k === 'reported_sha256' ? 'falta (null si la máquina no informaba correo)' : 'falta' });
      if (entry.person !== undefined) problems.push(...emailProblems(entry.person, `${at}.person`));
      if (entry.confirmed_by !== undefined) problems.push(...emailProblems(entry.confirmed_by, `${at}.confirmed_by`));
      if (entry.confirmed_on !== undefined) problems.push(...dayProblems(entry.confirmed_on, `${at}.confirmed_on`));
      const sha = entry.reported_sha256;
      // el mensaje no repite el valor: si alguien pegó el correo en claro, no se copia a la salida ni al registro
      if (sha !== undefined && sha !== null && (typeof sha !== 'string' || !SHA256.test(sha))) problems.push({ path: `${at}.reported_sha256`, message: 'tiene que ser la huella del correo informado (64 hexadecimales en minúsculas) o null; nunca el correo en claro' });
    }
  }
  if (projects !== undefined) {
    if (!isObject(projects)) problems.push({ path: 'people.projects', message: 'tiene que ser un objeto { "<correo>": { "add": […], "remove": […] } }' });
    else {
      // los correos se comparan sin mayúsculas ni espacios (decisión 7): dos claves que son el mismo correo se pisarían
      const vistas = new Map();
      for (const who of Object.keys(projects)) {
        if (comment(who)) continue;
        const norm = who.trim().toLowerCase();
        if (vistas.has(norm)) problems.push({ path: `people.projects.${who}`, message: `es el mismo correo que «${vistas.get(norm)}» (sin distinguir mayúsculas): va en una sola clave` });
        else vistas.set(norm, who);
      }
    }
    if (isObject(projects)) for (const [who, fix] of Object.entries(projects)) {
      if (comment(who)) continue;
      const at = `people.projects.${who}`;
      if (!EMAIL.test(who)) { problems.push({ path: at, message: `«${who}» no tiene forma de correo (usuario@dominio, sin espacios)` }); continue; }
      if (!isObject(fix)) { problems.push({ path: at, message: 'tiene que ser un objeto { "add": […], "remove": […] }' }); continue; }
      problems.push(...unknownKeys(fix, PROJECT_KEYS, at));
      for (const k of PROJECT_KEYS) {
        const list = fix[k];
        if (list === undefined) continue;
        if (!Array.isArray(list)) { problems.push({ path: `${at}.${k}`, message: 'tiene que ser una lista de productos' }); continue; }
        list.forEach((p, i) => { if (typeof p !== 'string' || !p.trim()) problems.push({ path: `${at}.${k}.${i}`, message: 'tiene que ser el nombre de un producto (un texto no vacío)' }); });
      }
      if (Array.isArray(fix.add) && Array.isArray(fix.remove)) {
        fix.remove.forEach((p, i) => { if (typeof p === 'string' && p.trim() && fix.add.includes(p)) problems.push({ path: `${at}.remove.${i}`, message: `«${p}» está en add y en remove: va en una sola` }); });
      }
    }
  }
  return problems;
}

const texto = (v) => typeof v === 'string' && v.trim() !== '';

// story 2.22: { provider, products: { "<producto>": { staging: [entrada…], production: [entrada…] } } }
function deploymentsProblems(dep) {
  if (!isObject(dep)) return [{ path: 'deployments', message: 'tiene que ser un objeto { "provider": …, "products": … }' }];
  const problems = [...unknownKeys(dep, ['provider', 'products'], 'deployments')];
  const prov = dep.provider;
  if (!DEPLOYMENT_PROVIDERS.includes(prov)) problems.push({ path: 'deployments.provider', message: `tiene que ser uno de: ${DEPLOYMENT_PROVIDERS.join(', ')}` });
  if (!isObject(dep.products)) { problems.push({ path: 'deployments.products', message: 'tiene que ser un objeto { "<producto>": { "staging": […], "production": […] } }' }); return problems; }
  for (const [prod, sides] of Object.entries(dep.products)) {
    if (comment(prod)) continue;
    const at = `deployments.products.${prod}`;
    if (!prod.trim()) { problems.push({ path: at, message: 'un producto sin nombre' }); continue; }
    if (!isObject(sides)) { problems.push({ path: at, message: 'tiene que ser un objeto { "staging": […], "production": […] }' }); continue; }
    problems.push(...unknownKeys(sides, DEPLOYMENT_SIDES, at));
    if (sides.staging === undefined && sides.production === undefined) problems.push({ path: at, message: 'tiene que declarar staging, production o los dos' });
    for (const side of DEPLOYMENT_SIDES) {
      const list = sides[side];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.length === 0) { problems.push({ path: `${at}.${side}`, message: 'tiene que ser una lista no vacía de entradas' }); continue; }
      list.forEach((e, i) => {
        const ea = `${at}.${side}.${i}`;
        if (!isObject(e)) { problems.push({ path: ea, message: 'tiene que ser un objeto' }); return; }
        if (prov === 'azure') {
          problems.push(...unknownKeys(e, AZURE_ENTRY_KEYS, ea));
          const p = e.pipeline;
          if (!texto(p) || p.indexOf('/') <= 0 || p.indexOf('/') === p.length - 1) problems.push({ path: `${ea}.pipeline`, message: 'tiene que ser "<proyecto>/<nombre exacto de la definición>"' });
          if (!Array.isArray(e.stages) || e.stages.length === 0) problems.push({ path: `${ea}.stages`, message: 'tiene que ser una lista no vacía de identificadores de stage (el nombre del YAML, exacto)' });
          else e.stages.forEach((s, j) => { if (!texto(s)) problems.push({ path: `${ea}.stages.${j}`, message: 'tiene que ser un identificador de stage (un texto no vacío)' }); });
        } else if (prov === 'github') {
          problems.push(...unknownKeys(e, GITHUB_ENTRY_KEYS, ea));
          if (!texto(e.repo) || !GITHUB_REPO.test(e.repo)) problems.push({ path: `${ea}.repo`, message: 'tiene que ser "<dueño>/<repo>"' });
          if (!texto(e.environment)) problems.push({ path: `${ea}.environment`, message: 'tiene que ser el nombre del environment (un texto no vacío)' });
          if (e.workflow !== undefined) {
            if (side !== 'staging') problems.push({ path: `${ea}.workflow`, message: 'sólo va en staging: de ahí sale «main roto»' });
            else if (!texto(e.workflow)) problems.push({ path: `${ea}.workflow`, message: 'tiene que ser el archivo del workflow (un texto no vacío)' });
          }
        }
      });
    }
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
  if (doc.people !== undefined) problems.push(...peopleProblems(doc.people));
  if (doc.deployments !== undefined) problems.push(...deploymentsProblems(doc.deployments));
  if (doc.notify !== undefined) problems.push(...notifyProblems(doc.notify));
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

module.exports = { VERSION, KEYS, OWNER_KEYS, REVIEWER_KEYS, SITE_KEYS, BRAND_KEYS, BRAND_LOGO, NOTIFY_CHANNELS, MAILBOX_PROVIDERS, REFRESH_MIN, REFRESH_MAX, EMAIL, ACCOUNT, CONTAINER, PEOPLE_KEYS, MACHINE_KEYS, PROJECT_KEYS, FORMA_MAQUINA, DEPLOYMENT_PROVIDERS, DEPLOYMENT_SIDES, GITHUB_REPO, parse, load, ownerFor };

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
