'use strict';
/*
 * repo-proposal.js — LA PROPUESTA POR RAMA Y PEDIDO DESDE EL CLON DEL SITIO.
 *
 * Qué resuelve: la pestaña Configuración del sitio guarda un cambio a un archivo del repo de operaciones como lo hace
 * hoy la página local (`team-config.js`: una rama `team-config/<id>-<sello>` y un pedido hacia la rama principal), pero
 * desde el clon temporal que el sitio ya tiene para leer y SIN TOCAR su árbol de trabajo ni su índice: ese clon
 * lo relee `sources.js` en cada refresco, y un cambio a medias ahí se vería como configuración. Por eso el commit se arma
 * con los comandos de bajo nivel de git (`hash-object -w`, `read-tree` / `update-index --cacheinfo` / `write-tree` sobre
 * un índice temporal en `GIT_INDEX_FILE`, `commit-tree -p <punta de main>`) y se empuja por su sha a la rama nueva, sin
 * crear una ref local: después de proponer, `git status` del clon sigue limpio, `HEAD` en main y `git branch` igual.
 *
 * Lo que este módulo garantiza:
 *   · rama y pedido, nunca la rama principal: el empuje va SIN `--force` y SÓLO a `refs/heads/team-config/...`; el
 *        pedido se abre por la API REST del proveedor (la imagen del sitio no trae `gh` ni `az`) sin auto-completar ni
 *        merge; y antes de crear nada se lee la POLÍTICA de la rama principal (al menos un revisor): sin ella, la
 *        identidad de escritura del sitio podría escribir main, y la propuesta se apaga con el motivo.
 *   · si el archivo cambió desde que se abrió la sección (`oidEsperado` distinto del de main recién traída), no se
 *        propone: vuelve `cambio` con el texto y la versión de la punta (`textoActual`, `oidActual`), para que quien
 *        llama ponga la propuesta encima; y si ya hay un pedido abierto de la pestaña sobre ese archivo, se muestra su enlace.
 *   · un pedido por archivo, con todas las secciones cambiadas en el cuerpo.
 *   · una sola credencial de escritura (`SITE_OPERATIONS_WRITE_TOKEN`): va a git SÓLO en una cabecera por variables
 *        `GIT_CONFIG_*` (`http.<origen>/.extraheader`, el patrón de sources.js) y a la API en `Authorization`; nunca en
 *        la dirección, en un argumento, en el disco, en el registro ni en un mensaje (se reemplaza por `[credencial]`).
 *
 * Con la opción de la organización «los cambios de un mantenedor se aplican solos» (`aplicarSolo`), después de abrir el
 * pedido el sitio lo aprueba con su propia identidad (la que lo creó), mira que todas las políticas bloqueantes del
 * pedido queden cumplidas y recién entonces lo completa, sin saltear ninguna (nunca `bypassPolicy`, nunca un empuje a
 * main). Si falta algo que el voto del sitio no da, lo dice y deja el pedido. En GitHub, donde quien abre el pedido no
 * puede aprobarlo, lo mergea directo si el repo lo deja, y si no le prende el auto-merge. Es lo único que este módulo
 * cambia de un pedido; sin la opción, nada de eso ocurre.
 *
 * Sin dependencias fuera de Node: child_process, fs, path, os, crypto y el `fetch` global (Node 20+). Todo lo que habla
 * con afuera (git, fetch, el reloj, el candado) se inyecta para las pruebas (scripts/tests/repo-proposal.test.js).
 */
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Lo que este archivo le dice a una persona, en castellano y en inglés: la tabla de textos del sitio
// (scripts/site/texts.js) la suma a la suya y lo traduce en el idioma de cada pedido. Acá se arma en castellano.
const TEXTOS = {
  'rp.sinPlataforma': { es: 'no reconozco la plataforma del remoto: abrí el pedido a mano', en: 'I do not recognize the remote\'s platform: open the request by hand' },
  'rp.politicaIlegible': { es: 'no pude leer la política de la rama {rama} ({motivo})', en: 'I could not read the policy of the {rama} branch ({motivo})' },
  'rp.sinPolitica': { es: 'el repo no tiene una política que pida revisión en {rama}: sin ella, la identidad del sitio podría escribir {rama}', en: 'the repo has no policy that requires review on {rama}: without it, the site\'s identity could write to {rama}' },
  'rp.autorAprueba': { es: 'la política de {rama} deja que quien crea el pedido lo apruebe, y el pedido lo crea la identidad del sitio: apagá «Allow requestors to approve their own changes» en esa política', en: "the policy of {rama} lets the request's creator approve it, and the request is created by the site's identity: turn off \"Allow requestors to approve their own changes\" in that policy" },
  'rp.noCubre': { es: 'la política de {rama} no cubre {archivo}: su filtro de ruta no lo incluye, y sin revisión la identidad del sitio podría completar el pedido', en: 'the policy of {rama} does not cover {archivo}: its path filter does not include it, and without review the site\'s identity could complete the request' },
  'rp.sinEvaluar': { es: 'No se pudo aplicar solo: la plataforma todavía no terminó de evaluar la revisión después del voto del sitio. El pedido queda para aprobar: {enlace}', en: "It could not be applied automatically: the platform has not finished evaluating the review after the site's vote. The request is waiting for approval: {enlace}" },
  'rp.pideMas': { es: 'No se pudo aplicar solo: además del voto del sitio, la rama principal pide {nombres}. El pedido queda para aprobar: {enlace}', en: "It could not be applied automatically: in addition to the site's vote, the main branch requires {nombres}. The request is waiting for approval: {enlace}" },
  'rp.aplicado': { es: 'Aplicado: el cambio entró en la rama principal. Pedido: {enlace}', en: 'Applied: the change went into the main branch. Request: {enlace}' },
  'rp.sinCredencial': { es: 'el sitio no tiene identidad de escritura: descargá el archivo y abrí el pedido a mano', en: 'the site has no write identity: download the file and open the request by hand' },
  'rp.sinVersion': { es: 'falta la versión del archivo que abriste: recargá', en: 'the version of the file you opened is missing: reload' },
  'rp.faltanDatos': { es: 'faltan datos de la propuesta (clon, archivo, contenido o id corto)', en: 'the proposal is missing data (clone, file, content or short id)' },
  'rp.sinOrigin': { es: 'el clon del sitio no tiene un remoto «origin»: no hay adónde mandar la propuesta', en: "the site's clone has no \"origin\" remote: there is nowhere to send the proposal" },
  'rp.sinPermiso': { es: 'la identidad de escritura del sitio no tiene permiso en {repo}', en: 'the site\'s write identity has no permission on {repo}' },
  'rp.noTraje': { es: 'no pude traer la rama {rama} del repo de operaciones ({error})', en: 'I could not fetch the {rama} branch of the operations repo ({error})' },
  'rp.sinPunta': { es: 'no encontré la punta de {rama} después de traerla ({error})', en: 'I did not find the tip of {rama} after fetching it ({error})' },
  'rp.cambio': { es: 'el archivo cambió desde que lo abriste: recargá', en: 'the file changed since you opened it: reload' },
  'rp.noVerifique': { es: 'no pude verificar si ya hay un pedido abierto sobre este archivo ({error}): no propongo nada; probá de nuevo', en: 'I could not check whether there is already an open request on this file ({error}): nothing was proposed; try again' },
  'rp.yaAbierto': { es: 'ya hay un pedido abierto sobre este archivo: {enlace}; esperá a que se mergee o cerralo', en: 'there is already an open request on this file: {enlace}; wait for it to merge or close it' },
  'rp.noGuarde': { es: 'no pude guardar el contenido en el clon ({error})', en: 'I could not save the content in the clone ({error})' },
  'rp.noCommit': { es: 'no pude armar el commit ({error})', en: 'I could not build the commit ({error})' },
  'rp.noSubi': { es: 'no pude subir la rama {rama} ({error})', en: 'I could not push the {rama} branch ({error})' },
  'rp.noAbri': { es: 'El cambio subió a la rama {rama}, pero no pude abrir el pedido ({motivo}). Abrilo desde: {manual}', en: 'The change was pushed to the {rama} branch, but I could not open the request ({motivo}). Open it from: {manual}' },
  'rp.abierto': { es: 'Pedido abierto: {enlace}', en: 'Request opened: {enlace}' },
  'rp.githubNoAprueba': { es: 'No se pudo aplicar solo: el repo pide una aprobación y no deja el auto-merge ({motivo}). El pedido queda para aprobar: {enlace}', en: 'It could not be applied automatically: the repository requires an approval and does not allow auto-merge ({motivo}). The request is waiting for approval: {enlace}' },
  'rp.githubAutoMerge': { es: 'El repo pide la aprobación de otra persona: el pedido quedó con auto-merge y entra solo en cuanto alguien lo apruebe y pasen sus chequeos: {enlace}', en: 'The repository requires someone else to approve: the request has auto-merge on and goes in as soon as someone approves it and its checks pass: {enlace}' },
  'rp.pipelineNoReconocido': { es: 'no reconozco el pipeline: el número de la definición en Azure DevOps (o proyecto/número si es de otro proyecto), o dueño/repo en GitHub', en: 'I do not recognize the pipeline: the definition number in Azure DevOps (or project/number if it is from another project), or owner/repo on GitHub' },
  'rp.stageAMano': { es: 'no configurado: escribí el stage a mano (el sitio no tiene SITE_PIPELINES_TOKEN)', en: 'not set up: type the stage by hand (the site has no SITE_PIPELINES_TOKEN)' },
  'rp.noEsAzure': { es: 'el repo de operaciones no es de Azure DevOps: escribí el stage a mano', en: 'the operations repo is not on Azure DevOps: type the stage by hand' },
  'rp.sinCorrida': { es: 'el pipeline {pipeline} no tiene una corrida terminada de la rama principal: escribí el stage a mano', en: 'the pipeline {pipeline} has no finished run on the main branch: type the stage by hand' },
  'rp.pipelineIlegible': { es: 'no pude leer el pipeline {pipeline} ({estado}): escribí el stage a mano', en: 'I could not read the pipeline {pipeline} ({estado}): type the stage by hand' },
  'rp.environmentAMano': { es: 'no configurado: escribí el environment a mano (el sitio no tiene SITE_PIPELINES_TOKEN)', en: 'not set up: type the environment by hand (the site has no SITE_PIPELINES_TOKEN)' },
  'rp.environmentsIlegibles': { es: 'no pude leer los environments de {pipeline} ({estado}): escribí el environment a mano', en: 'I could not read the environments of {pipeline} ({estado}): type the environment by hand' },
  'rp.sinRespuesta': { es: 'sin respuesta', en: 'no answer' },
  'rp.faltaOrgProyecto': { es: 'falta la organización o el proyecto del repo: completalos y la lista aparece', en: "the repo's organization or project is missing: fill them in to see the list" },
  'rp.sinPermisoPipelines': { es: 'el sitio no puede leer los pipelines: falta su permiso de lectura de pipelines (SITE_PIPELINES_TOKEN). Mientras tanto, escribí el número del pipeline', en: "the site cannot read the pipelines: it lacks pipeline read permission (SITE_PIPELINES_TOKEN). In the meantime, type the pipeline's number" },
  'rp.azureNoContesto': { es: 'Azure DevOps no contestó: escribí el número del pipeline', en: 'Azure DevOps did not answer: type the pipeline\'s number' },
  'rp.permisoCorto': { es: 'el permiso del sitio no alcanza para leer los pipelines de {proyecto} (necesita lectura de Build): escribí el número del pipeline', en: 'the site\'s permission is not enough to read the pipelines of {proyecto} (it needs Build read): type the pipeline\'s number' },
  'rp.proyectoDesconocido': { es: 'Azure DevOps no conoce el proyecto {proyecto} en {org}: revisá los dos nombres', en: 'Azure DevOps does not know the project {proyecto} in {org}: check both names' },
  'rp.azureContesto': { es: 'Azure DevOps contestó {estado}: escribí el número del pipeline', en: "Azure DevOps responded with {estado}: type the pipeline's number" },
  'rp.respuestaIlegible': { es: 'la respuesta de Azure DevOps no se pudo leer: escribí el número del pipeline', en: 'the answer from Azure DevOps could not be read: type the pipeline\'s number' },  // los tipos de pedido de trabajo y sus campos: sin la lista se escribe a mano, como siempre, y lo valida el lector
  'rp.sinPermisoPedidos': { es: 'el sitio no puede leer los tipos de pedido: falta su permiso de lectura de pedidos de trabajo. Mientras tanto, escribí el nombre', en: 'the site cannot read the work item types: it lacks the work item read permission. Meanwhile, type the name' },
  'rp.permisoPedidos': { es: 'el permiso del sitio no alcanza para leer los tipos de pedido de {proyecto} (necesita lectura de pedidos de trabajo): escribí el nombre', en: 'the site\'s permission is not enough to read the work item types of {proyecto} (it needs work item read): type the name' },
  'rp.pedidosNoContesto': { es: 'Azure DevOps no contestó: escribí el nombre', en: 'Azure DevOps did not answer: type the name' },
  'rp.pedidosContesto': { es: 'Azure DevOps contestó {estado}: escribí el nombre', en: 'Azure DevOps responded with {estado}: type the name' },
  'rp.pedidosIlegible': { es: 'la respuesta de Azure DevOps no se pudo leer: escribí el nombre', en: 'the answer from Azure DevOps could not be read: type the name' },
  'rp.tipoDesconocido': { es: 'el proyecto {proyecto} no tiene el tipo de pedido {tipo}', en: 'the project {proyecto} has no work item type {tipo}' },
};
const M = (clave, valores = {}) => TEXTOS[clave].es.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (m, n) => (Object.prototype.hasOwnProperty.call(valores, n) ? String(valores[n]) : m));

const PLAZO_API_MS = 20000;
const PLAZO_GIT_MS = 180000;
const RAMA_PRINCIPAL = 'main';
const AUTOR = { GIT_AUTHOR_NAME: 'Sitio de la organización', GIT_AUTHOR_EMAIL: 'sitio@localhost', GIT_COMMITTER_NAME: 'Sitio de la organización', GIT_COMMITTER_EMAIL: 'sitio@localhost' };
/**
 * La política de Azure DevOps que pide revisores se reconoce por el nombre de su tipo (`type.displayName`, fijo y sin
 * traducir en la API). Su identificador (un GUID documentado) no va escrito acá: el freno de publicación lo toma por un
 * identificador interno, y el nombre alcanza.
 */
const TIPO_REVISORES_AZURE = 'Minimum number of reviewers';
// la otra forma que vale, con filtro de ruta (`filenamePatterns`): cuenta sólo para el archivo que
// cubre. Se reconoce igual, por el nombre de su tipo.
const TIPO_REQUERIDOS_AZURE = 'Required reviewers';
const URL_BASE = { azure: 'https://dev.azure.com', github: 'https://api.github.com' };
const API_AZURE = 'api-version=7.1';
// la evaluación de las políticas de un pedido todavía sale en la versión preliminar de la API
const API_EVALUACIONES = 'api-version=7.1-preview.1';
// aplicar solo: cuánto se vuelve a mirar la evaluación de los revisores (que tarda un instante en ver el voto) y el
// pedido hasta que queda completado (el merge corre aparte)
const PAUSA_MS = 2000;
const INTENTOS_EVALUACION = 5;
const INTENTOS_COMPLETADO = 15;
const LISTO = ['approved', 'notApplicable'];

/** ¿El rechazo es por permisos? La misma lista que team-config.js (los textos de git, de GitHub y de Azure DevOps). */
const NO_PERMISSION = /\b403\b|permission|denied|not authorized|unauthori[sz]ed|insufficient|TF401027|TF401019|forbidden|Write access/i;

/** La plataforma y la dirección del repo (la misma lectura que team-config.js). */
function remoteOf(url) {
  const u = String(url || '').trim();
  let m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  if (m) return { platform: 'github', org: m[1], repo: m[2], web: `https://github.com/${m[1]}/${m[2]}` };
  m = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/.exec(u.replace(/\/\/[^@/]+@/, '//'))
    || /([^./@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)\/?$/.exec(u.replace(/\/\/[^@/]+@/, '//'));
  if (m) return { platform: 'azure', org: m[1], project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]), web: `https://dev.azure.com/${m[1]}/${m[2]}/_git/${m[3]}` };
  return { platform: null, web: null };
}

/** El sello de la rama: AAAAMMDD-HHMMSS, el mismo de team-config.js. */
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const fechaDe = (now) => { const v = typeof now === 'function' ? now() : now; return v instanceof Date ? v : new Date(v == null ? Date.now() : v); };

/** La credencial: un string (la misma para git y la API) o { git, api }. */
function credenciales(credencial) {
  if (typeof credencial === 'string') return { git: credencial, api: credencial };
  if (credencial && typeof credencial === 'object') return { git: credencial.git || credencial.api || '', api: credencial.api || credencial.git || '' };
  return { git: '', api: '' };
}

/** Lo que nunca puede salir en un texto: la credencial cruda y sus formas codificadas (las cabeceras de git y de la API). */
function secretosDe(cred) {
  const s = [cred.git, cred.api];
  if (cred.git) s.push(Buffer.from(`x-access-token:${cred.git}`).toString('base64'));
  if (cred.api) s.push(Buffer.from(`:${cred.api}`).toString('base64'));
  return s.filter(Boolean);
}

/** Saca la credencial (y sus formas codificadas) de cualquier texto que salga de acá: mensajes, registro, stderr. */
function tapar(texto, secretos) {
  let s = String(texto || '');
  for (const sec of secretos) if (sec) s = s.split(sec).join('[credencial]');
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/** Un proceso git sin bloquear, con entrada opcional: { status, stdout, stderr, error }. Nunca rechaza. */
function correrGit(args, { cwd, env, input, timeout = PLAZO_GIT_MS, git = 'git' } = {}) {
  return new Promise((resolve) => {
    let p;
    try { p = childProcess.spawn(git, args, { cwd, env, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (error) { resolve({ status: null, stdout: '', stderr: '', error }); return; }
    let stdout = ''; let stderr = ''; let error = null;
    const corte = setTimeout(() => { error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); p.kill('SIGKILL'); }, timeout);
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('error', (e) => { error = e; });
    p.on('close', (status) => { clearTimeout(corte); resolve({ status, stdout, stderr, error }); });
    if (input != null) { p.stdin.on('error', () => {}); p.stdin.end(input); }
  });
}

// ── La API del proveedor ───────────────────────────────────────────────────────────────────────────────────────────
function cabecerasApi(remote, cred) {
  if (remote.platform === 'azure') return { Authorization: `Basic ${Buffer.from(`:${cred.api}`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  return { Authorization: `Bearer ${cred.api}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}
const baseDe = (remote, urlBase) => {
  const b = (urlBase && urlBase[remote.platform]) || URL_BASE[remote.platform];
  if (remote.platform === 'azure') return `${b}/${remote.org}/${encodeURIComponent(remote.project)}/_apis`;
  return `${b}/repos/${remote.org}/${remote.repo}`;
};

/** Una llamada a la API: { status, doc, motivo }. Nunca rechaza; el motivo ya viene sin la credencial. */
async function llamar({ method = 'GET', url, remote, cred, cuerpo, fetch: f, secretos }) {
  const hacer = f || globalThis.fetch;
  try {
    const r = await hacer(url, { method, headers: cabecerasApi(remote, cred), body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo), signal: AbortSignal.timeout(PLAZO_API_MS) });
    let doc = null;
    try { doc = await r.json(); } catch { doc = null; }
    const motivo = r.ok ? null : `HTTP ${r.status}${doc && doc.message ? `: ${tapar(doc.message, secretos).slice(0, 200)}` : ''}`;
    return { status: r.status, doc, motivo };
  } catch (e) {
    return { status: 0, doc: null, motivo: tapar((e && (e.code || e.name === 'TimeoutError' ? 'no contestó a tiempo' : e.message)) || 'sin motivo', secretos).slice(0, 200) };
  }
}

const motivoCorto = (r) => (r.status === 401 ? 'la credencial fue rechazada' : r.status === 403 ? 'la identidad no tiene permiso para leerla' : r.status === 404 ? 'no existe o no se ve' : r.motivo || `HTTP ${r.status}`);

// Un patrón del filtro de ruta que se sabe leer: empieza con `/` (o `!/`, una exclusión) y sólo trae letras, números,
// `.`, `_`, `-`, `/` y los dos comodines de Azure DevOps (`*` una secuencia, `?` un carácter; acá ninguno cruza `/`).
// Otro, no se entiende.
const PATRON_CONOCIDO = /^!?\/[A-Za-z0-9._\-/*?]*$/;

/**
 * ¿Se puede PROBAR que el filtro de ruta de una política de Azure DevOps cubre el archivo? Lo que no se
 * puede probar queda apagado: «Proponer» no se ofrece sin revisión segura. Hace falta al menos una inclusión que lo cubra y ninguna exclusión que lo
 * saque: en Azure un filtro hecho sólo de exclusiones no incluye ningún archivo («nothing is included first»). Un patrón
 * que no se sabe leer, o una lista vacía, no prueban nada. Las rutas se comparan sin mayúsculas.
 */
function filtroCubre(patrones, archivo) {
  if (!Array.isArray(patrones) || !patrones.length || !archivo) return false;
  const lista = patrones.map((p) => (typeof p === 'string' ? p.trim() : null));
  if (lista.some((p) => !p || !PATRON_CONOCIDO.test(p))) return false;
  const ruta = `/${String(archivo).replace(/^\/+/, '')}`;
  // `*` y `?` no cruzan carpetas: si en Azure `*` fuera recursivo, el costo es un «no cubre» de más (lado seguro); al revés,
  // `/scripts/*` daría por cubierto un archivo de una subcarpeta que la política capaz no cubre
  const re = (p) => new RegExp(`^${p.replace(/[.^${}()|[\]\\+]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`, 'i');
  const incluye = lista.filter((p) => !p.startsWith('!'));
  const excluye = lista.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  if (excluye.some((p) => re(p).test(ruta))) return false;
  return incluye.some((p) => re(p).test(ruta));
}

/**
 * ¿Se puede probar que esta política exige un revisor que no es el autor para `archivo`? Sólo con valores que se
 * entienden: el voto del autor dicho y apagado (`creatorVoteCounts: false`); en «Required reviewers», además, revisores
 * nombrados, `addedFilesOnly: false` dicho (con `true` sólo pide revisión al AGREGAR el archivo, no al editarlo) y un
 * filtro que lo cubre. «Minimum number of reviewers» vale para toda la rama, salvo que traiga un filtro de ruta: entonces
 * también tiene que cubrirlo.
 */
function exigeRevisor(p, archivo) {
  const s = p.settings;
  if (s.creatorVoteCounts !== false) return false;
  if (p.type.displayName === TIPO_REVISORES_AZURE) return s.filenamePatterns === undefined || filtroCubre(s.filenamePatterns, archivo);
  const revisores = Array.isArray(s.requiredReviewerIds) && s.requiredReviewerIds.length > 0 && s.requiredReviewerIds.every((x) => typeof x === 'string' && x.trim());
  return revisores && s.addedFilesOnly === false && filtroCubre(s.filenamePatterns, archivo);
}

/**
 * ¿La rama principal pide revisión para este archivo? Azure DevOps: una configuración de política habilitada y bloqueante
 * sobre refs/heads/main del repo, con al menos 1 revisor y sin que cuente el voto de quien crea el pedido, de una de estas
 * dos formas (por el nombre del tipo): «Minimum number of reviewers», sobre toda la rama; o «Required reviewers» cuyo
 * filtro de ruta (`filenamePatterns`) cubre `archivo` (con el filtro, «Proponer» va archivo por archivo; sin
 * `archivo`, una política con filtro no alcanza). GitHub: la protección de la rama
 * (`required_pull_request_reviews.required_approving_review_count >= 1`) o una regla `pull_request` que la pida.
 */
async function politicaDeRevision({ remote, credencial, urlBase, fetch: f, archivo = null, aplicarSolo = false }) {
  if (!remote || (remote.platform !== 'azure' && remote.platform !== 'github')) return { ok: false, codigo: 'plataforma_desconocida', message: M('rp.sinPlataforma') };
  const cred = credenciales(credencial);
  const secretos = secretosDe(cred);
  const base = baseDe(remote, urlBase);
  const noLeida = (r) => ({ ok: false, codigo: 'no_se_pudo_leer', message: M('rp.politicaIlegible', { rama: RAMA_PRINCIPAL, motivo: motivoCorto(r) }) });
  const sinPolitica = { ok: false, codigo: 'sin_politica', message: M('rp.sinPolitica', { rama: RAMA_PRINCIPAL }) };
  if (remote.platform === 'azure') {
    const repo = await llamar({ url: `${base}/git/repositories/${encodeURIComponent(remote.repo)}?${API_AZURE}`, remote, cred, fetch: f, secretos });
    if (repo.status !== 200 || !repo.doc || !repo.doc.id) return noLeida(repo);
    const pol = await llamar({ url: `${base}/policy/configurations?repositoryId=${encodeURIComponent(repo.doc.id)}&refName=${encodeURIComponent(`refs/heads/${RAMA_PRINCIPAL}`)}&${API_AZURE}`, remote, cred, fetch: f, secretos });
    if (pol.status !== 200 || !pol.doc || !Array.isArray(pol.doc.value)) return noLeida(pol);
    const validas = pol.doc.value
      .filter((p) => p && p.isEnabled === true && p.isBlocking === true && p.type && [TIPO_REVISORES_AZURE, TIPO_REQUERIDOS_AZURE].includes(p.type.displayName) && p.settings && Number(p.settings.minimumApproverCount) >= 1)
      .filter((p) => Array.isArray(p.settings.scope) && p.settings.scope.some((s) => s && s.refName === `refs/heads/${RAMA_PRINCIPAL}` && (!s.repositoryId || s.repositoryId === repo.doc.id)));
    // el voto de quien crea el pedido no puede contar (si no, la identidad que propone se aprobaría sola), y lo que no se
    // puede probar que exige revisor en este archivo no cuenta
    const cubren = validas.filter((p) => exigeRevisor(p, archivo));
    // con la opción de aplicar solo, la política que deja votar a quien crea el pedido también es revisión: la aprueba el
    // sitio, a pedido de la organización. Se dice antes si su voto alcanza
    if (aplicarSolo) {
      const delAutor = validas.filter((p) => p.settings.creatorVoteCounts === true && exigeRevisor({ ...p, settings: { ...p.settings, creatorVoteCounts: false } }, archivo));
      const todas = [...cubren, ...delAutor];
      if (todas.length) {
        const n = Math.max(...todas.map((p) => Number(p.settings.minimumApproverCount)));
        // el sitio empuja la rama y vota con la misma identidad: «Prohibit the most recent pusher from approving» le anula el voto
        const porQue = todas.some((p) => p.settings.creatorVoteCounts !== true) ? 'la política de main pide un revisor que no sea quien crea el pedido'
          : todas.some((p) => p.settings.blockLastPusherVote === true) ? 'la política de main no deja aprobar a quien empujó el último cambio, y lo empuja el sitio'
          : todas.some((p) => p.type.displayName !== TIPO_REVISORES_AZURE) ? 'la política de main pide revisores nombrados'
            : n > 1 ? `la política de main pide ${n} revisores y el sitio da uno` : null;
        return { ok: true, detalle: `al menos ${n} revisor${n === 1 ? '' : 'es'}`, aplicaSolo: !porQue, motivoAplicar: porQue ? `Con la opción prendida, igual queda el pedido para aprobar: ${porQue}.` : null };
      }
    }
    if (!cubren.length) {
      // hay una política que cubre el archivo, pero deja que quien crea el pedido lo apruebe: ése es el motivo, y va antes
      // que «no cubre» (que sería falso) y que «no hay»
      if (validas.some((p) => p.settings.creatorVoteCounts === true && exigeRevisor({ ...p, settings: { ...p.settings, creatorVoteCounts: false } }, archivo))) {
        return { ok: false, codigo: 'autor_aprueba', message: M('rp.autorAprueba', { rama: RAMA_PRINCIPAL }) };
      }
      if (archivo && validas.some((p) => p.type.displayName === TIPO_REQUERIDOS_AZURE)) {
        return { ok: false, codigo: 'no_cubre', message: M('rp.noCubre', { rama: RAMA_PRINCIPAL, archivo }) };
      }
      return sinPolitica;
    }
    const n = Math.max(...cubren.map((p) => Number(p.settings.minimumApproverCount)));
    return { ok: true, detalle: `al menos ${n} revisor${n === 1 ? '' : 'es'}` };
  }
  const prot = await llamar({ url: `${base}/branches/${RAMA_PRINCIPAL}/protection`, remote, cred, fetch: f, secretos });
  // en GitHub quien abre un pedido no puede aprobarlo: si entra solo depende de que el repo deje mergear a la identidad del
  // sitio sin aprobación, y eso se sabe recién al intentarlo
  const enGithub = (n) => ({ ok: true, detalle: `al menos ${n} revisor${n === 1 ? '' : 'es'}`, ...(aplicarSolo ? { aplicaSolo: false, motivoAplicar: SIN_APLICAR_GITHUB } : {}) });
  if (prot.status === 200) {
    const n = Number((((prot.doc || {}).required_pull_request_reviews || {}).required_approving_review_count) || 0);
    if (n >= 1) return enGithub(n);
  } else if (prot.status !== 404) return noLeida(prot);
  const reglas = await llamar({ url: `${base}/rules/branches/${RAMA_PRINCIPAL}`, remote, cred, fetch: f, secretos });
  if (reglas.status !== 200 || !Array.isArray(reglas.doc)) return noLeida(reglas);
  const n = Math.max(0, ...reglas.doc.filter((r) => r && r.type === 'pull_request' && r.parameters).map((r) => Number(r.parameters.required_approving_review_count) || 0));
  if (n >= 1) return enGithub(n);
  return sinPolitica;
}
const SIN_APLICAR_GITHUB = 'Con la opción prendida, el sitio lo mergea directo si el repo se lo deja; si pide la aprobación de otra persona, el pedido queda con auto-merge y entra cuando alguien lo apruebe.';

/**
 * El pedido activo hacia main desde una rama `team-config/<idCorto>-*`: `{ enlace, rama }`, o null si no hay. Si la API
 * no contesta bien devuelve `{ error }`: «no pude mirar» no es «no hay».
 */
async function pedidoAbierto({ remote, credencial, idCorto, urlBase, fetch: f }) {
  if (!remote || (remote.platform !== 'azure' && remote.platform !== 'github')) return null;
  const cred = credenciales(credencial);
  const secretos = secretosDe(cred);
  const base = baseDe(remote, urlBase);
  const prefijo = `team-config/${idCorto}-`;
  if (remote.platform === 'azure') {
    const r = await llamar({ url: `${base}/git/repositories/${encodeURIComponent(remote.repo)}/pullrequests?searchCriteria.status=active&searchCriteria.targetRefName=${encodeURIComponent(`refs/heads/${RAMA_PRINCIPAL}`)}&${API_AZURE}`, remote, cred, fetch: f, secretos });
    if (r.status !== 200 || !r.doc || !Array.isArray(r.doc.value)) return { error: motivoCorto(r) };
    const p = r.doc.value.find((x) => x && String(x.sourceRefName || '').startsWith(`refs/heads/${prefijo}`));
    return p ? { enlace: `${remote.web}/pullrequest/${p.pullRequestId}`, rama: String(p.sourceRefName).replace(/^refs\/heads\//, '') } : null;
  }
  const r = await llamar({ url: `${base}/pulls?state=open&base=${RAMA_PRINCIPAL}&per_page=100`, remote, cred, fetch: f, secretos });
  if (r.status !== 200 || !Array.isArray(r.doc)) return { error: motivoCorto(r) };
  const p = r.doc.find((x) => x && x.head && String(x.head.ref || '').startsWith(prefijo));
  return p ? { enlace: p.html_url, rama: p.head.ref } : null;
}

// La línea con que el cuerpo de un pedido lleva la marca de su propuesta: `propuesta: <32 hex en minúscula>`.
const LINEA_DE_MARCA = 'propuesta: ';
const FORMA_DE_MARCA = /^[0-9a-f]{32}$/;
const VENTANA_MARCA_MS = 24 * 3600 * 1000;
const lineasDe = (cuerpo) => String(cuerpo || '').split('\n').map((l) => l.replace(/\r$/, ''));

/**
 * El cuerpo del pedido. La marca de la propuesta va en la PRIMERA línea: Azure DevOps corta la descripción al listar
 * pedidos y una marca al final se perdería con un cuerpo largo; quien busca el pedido por su marca la lee de ahí.
 */
function cuerpoDelPedido({ secciones = [], quien, aplicarSolo = false, marca = null }) {
  const resto = `Secciones cambiadas: ${secciones.length ? secciones.join(', ') : 'sin detallar'}. Pedido por ${quien || 'alguien'} desde el sitio.${aplicarSolo ? ' Lo aplica el sitio solo: la organización tiene prendida «los cambios de un mantenedor se aplican solos» (site.auto_apply en operations.json).' : ''}`;
  return marca ? `${LINEA_DE_MARCA}${marca}\n${resto}` : resto;
}

/**
 * El pedido de una propuesta, por su marca: `{ estado: 'abierto' | 'aplicado', enlace }`, null si no hay, o `{ error }`
 * si la API no contesta bien («no pude mirar» no es «no hay»). Mira los pedidos hacia la rama principal que salen de una
 * rama `team-config/…`, activos o completados en las últimas 24 horas (uno cerrado sin mergear no cuenta), y sólo
 * devuelve el que trae EXACTAMENTE la línea `propuesta: <marca>` en su cuerpo: no hay búsqueda por prefijo ni por título.
 * `ahora`: la hora en milisegundos (o un Date); por defecto, la del reloj.
 */
async function pedidoDeMarca({ remote, credencial, marca, urlBase, fetch: f, ahora }) {
  if (!remote || (remote.platform !== 'azure' && remote.platform !== 'github')) return null;
  if (typeof marca !== 'string' || !FORMA_DE_MARCA.test(marca)) return null;
  const cred = credenciales(credencial);
  const secretos = secretosDe(cred);
  const base = baseDe(remote, urlBase);
  const t = ahora instanceof Date ? ahora.getTime() : (Number.isFinite(ahora) ? ahora : Date.now());
  const linea = `${LINEA_DE_MARCA}${marca}`;
  const reciente = (fecha) => { const v = Date.parse(fecha); return Number.isFinite(v) && Math.abs(t - v) <= VENTANA_MARCA_MS; };
  const lleva = (cuerpo) => lineasDe(cuerpo).includes(linea);
  if (remote.platform === 'azure') {
    const r = await llamar({ url: `${base}/git/repositories/${encodeURIComponent(remote.repo)}/pullrequests?searchCriteria.status=all&searchCriteria.targetRefName=${encodeURIComponent(`refs/heads/${RAMA_PRINCIPAL}`)}&$top=100&${API_AZURE}`, remote, cred, fetch: f, secretos });
    if (r.status !== 200 || !r.doc || !Array.isArray(r.doc.value)) return { error: motivoCorto(r) };
    const hallados = r.doc.value.filter((x) => x && x.targetRefName === `refs/heads/${RAMA_PRINCIPAL}` && String(x.sourceRefName || '').startsWith('refs/heads/team-config/') && lleva(x.description));
    const activo = hallados.find((x) => x.status === 'active');
    const hecho = hallados.find((x) => x.status === 'completed' && reciente(x.closedDate));
    const p = activo || hecho;
    return p ? { estado: activo ? 'abierto' : 'aplicado', enlace: `${remote.web}/pullrequest/${p.pullRequestId}` } : null;
  }
  const r = await llamar({ url: `${base}/pulls?state=all&base=${RAMA_PRINCIPAL}&sort=updated&direction=desc&per_page=100`, remote, cred, fetch: f, secretos });
  if (r.status !== 200 || !Array.isArray(r.doc)) return { error: motivoCorto(r) };
  const hallados = r.doc.filter((x) => x && x.base && x.base.ref === RAMA_PRINCIPAL && x.head && String(x.head.ref || '').startsWith('team-config/') && lleva(x.body));
  const activo = hallados.find((x) => x.state === 'open');
  const hecho = hallados.find((x) => x.state === 'closed' && x.merged_at && reciente(x.merged_at));
  const p = activo || hecho;
  return p ? { estado: activo ? 'abierto' : 'aplicado', enlace: p.html_url } : null;
}

/** Abre el pedido por REST: { ok, enlace } | { ok: false, motivo }. Abrirlo no lo completa ni lo mergea */
async function abrirPedido({ remote, cred, urlBase, rama, titulo, cuerpo, fetch: f, secretos }) {
  const base = baseDe(remote, urlBase);
  if (remote.platform === 'azure') {
    const r = await llamar({ method: 'POST', url: `${base}/git/repositories/${encodeURIComponent(remote.repo)}/pullrequests?${API_AZURE}`, remote, cred, fetch: f, secretos, cuerpo: { sourceRefName: `refs/heads/${rama}`, targetRefName: `refs/heads/${RAMA_PRINCIPAL}`, title: titulo, description: cuerpo } });
    if (r.status === 201 && r.doc && r.doc.pullRequestId != null) {
      return { ok: true, enlace: `${remote.web}/pullrequest/${r.doc.pullRequestId}`, id: r.doc.pullRequestId, creador: (r.doc.createdBy || {}).id || null, proyecto: ((r.doc.repository || {}).project || {}).id || null };
    }
    return { ok: false, motivo: motivoDePedido(r) };
  }
  const r = await llamar({ method: 'POST', url: `${base}/pulls`, remote, cred, fetch: f, secretos, cuerpo: { title: titulo, head: rama, base: RAMA_PRINCIPAL, body: cuerpo } });
  if (r.status === 201 && r.doc && r.doc.html_url) return { ok: true, enlace: r.doc.html_url, numero: r.doc.number, nodo: r.doc.node_id || null };
  return { ok: false, motivo: motivoDePedido(r) };
}
const motivoDePedido = (r) => (r.status === 403 || r.status === 401 ? 'la identidad de escritura del sitio no tiene permiso para abrir pedidos en ese repo' : r.motivo || `HTTP ${r.status}`);

const motivoDeEscritura = (r) => (r.status === 401 || r.status === 403 ? 'la identidad del sitio no tiene permiso' : r.motivo || `HTTP ${r.status}`);

/**
 * Aplica solo un pedido de Azure DevOps recién abierto: el voto «aprobado» de la identidad que lo creó, la evaluación de
 * sus políticas y, si todas las bloqueantes quedaron cumplidas, el completar (sin saltear ninguna) y la espera hasta que
 * quede completado. Devuelve { ok: true, codigo: 'aplicado' } · { ok: true, codigo: 'no_aplica_solo' } (falta algo que
 * el sitio no da: el pedido queda) · { ok: false, codigo: 'quedo_abierto' } (algo falló a mitad). Nunca repite un paso.
 */
async function aplicarPedido({ remote, cred, urlBase, fetch: f, secretos, pedido, sha, titulo, quien, rama, esperar }) {
  const base = baseDe(remote, urlBase);
  const { enlace } = pedido;
  const rutaPedido = `${base}/git/repositories/${encodeURIComponent(remote.repo)}/pullrequests/${encodeURIComponent(pedido.id)}`;
  const queda = (message) => ({ ok: false, codigo: 'quedo_abierto', rama, enlace, message });
  if (!pedido.creador || !pedido.proyecto) return queda(`El pedido quedó abierto, sin aprobar: la plataforma no dijo con qué identidad lo creó el sitio. Queda para aprobar: ${enlace}`);

  const voto = await llamar({ method: 'PUT', url: `${rutaPedido}/reviewers/${encodeURIComponent(pedido.creador)}?${API_AZURE}`, remote, cred, fetch: f, secretos, cuerpo: { vote: 10 } });
  if (voto.status !== 200) return queda(`El pedido quedó abierto, sin aprobar: el sitio no pudo aprobarlo (${motivoDeEscritura(voto)}). Queda para aprobar: ${enlace}`);

  const artefacto = `vstfs:///CodeReview/CodeReviewId/${pedido.proyecto}/${pedido.id}`;
  let pendientes = [];
  let soloRevisores = false;
  for (let i = 0; i < INTENTOS_EVALUACION; i += 1) {
    if (i) await esperar(PAUSA_MS);
    const ev = await llamar({ url: `${base}/policy/evaluations?artifactId=${encodeURIComponent(artefacto)}&${API_EVALUACIONES}`, remote, cred, fetch: f, secretos });
    if (ev.status !== 200 || !ev.doc || !Array.isArray(ev.doc.value)) return queda(`El pedido quedó abierto y aprobado por el sitio, pero no pude leer si sus políticas se cumplen (${motivoCorto(ev)}): no lo completé. ${enlace}`);
    pendientes = ev.doc.value.filter((e) => e && e.configuration && e.configuration.isEnabled !== false && e.configuration.isBlocking === true && !LISTO.includes(e.status));
    // la de revisores tarda un instante en ver el voto: se vuelve a mirar sólo si lo único pendiente es eso
    soloRevisores = pendientes.length > 0 && pendientes.every((e) => ['queued', 'running'].includes(e.status) && [TIPO_REVISORES_AZURE, TIPO_REQUERIDOS_AZURE].includes(((e.configuration || {}).type || {}).displayName));
    if (!soloRevisores) break;
  }
  // la revisión todavía evaluándose no es «la rama pide algo más»: puede ser sólo lentitud
  if (soloRevisores) return { ok: true, codigo: 'no_aplica_solo', rama, enlace, message: M('rp.sinEvaluar', { enlace }) };
  if (pendientes.length) {
    const nombres = [...new Set(pendientes.map((e) => ((e.configuration || {}).type || {}).displayName || 'una política sin nombre'))];
    return { ok: true, codigo: 'no_aplica_solo', rama, enlace, message: M('rp.pideMas', { nombres: nombres.map((x) => `«${x}»`).join(', '), enlace }) };
  }

  // 🔴 sin bypassPolicy: si una política no se cumple, la plataforma no completa
  const completar = await llamar({ method: 'PATCH', url: `${rutaPedido}?${API_AZURE}`, remote, cred, fetch: f, secretos, cuerpo: { status: 'completed', lastMergeSourceCommit: { commitId: sha }, completionOptions: { deleteSourceBranch: true, mergeCommitMessage: `${titulo} (aplicado por el sitio)` } } });
  if (completar.status !== 200) return queda(`El pedido quedó abierto y aprobado por el sitio, pero no pude completarlo (${motivoDeEscritura(completar)}): ${enlace}`);
  let estado = completar.doc && completar.doc.status;
  let ultimaLectura = 'leida';
  for (let i = 0; estado !== 'completed' && i < INTENTOS_COMPLETADO; i += 1) {
    await esperar(PAUSA_MS);
    const g = await llamar({ url: `${rutaPedido}?${API_AZURE}`, remote, cred, fetch: f, secretos });
    if (g.status === 200 && g.doc) { estado = g.doc.status; ultimaLectura = 'leida'; } else ultimaLectura = motivoCorto(g);
  }
  // «no pude mirar» no es «no se completó»: si la última lectura falló, se dice eso
  if (estado !== 'completed' && ultimaLectura !== 'leida') return queda(`El pedido quedó aprobado por el sitio y se pidió completarlo, pero no pude confirmar si se completó (${ultimaLectura}): miralo en ${enlace}`);
  if (estado !== 'completed') return queda(`El pedido quedó abierto y aprobado por el sitio, pero todavía no se completó (${estado || 'sin estado'}): miralo en ${enlace}`);
  return { ok: true, codigo: 'aplicado', rama, enlace, message: M('rp.aplicado', { enlace }) };
}

/**
 * Aplica solo un pedido de GitHub recién abierto. En GitHub quien abre un pedido no puede aprobarlo, así que el sitio no
 * vota: primero lo mergea directo, que el repo deja cuando la identidad del sitio puede saltear la revisión; si el repo
 * pide la aprobación de otra persona (o mergea por la cola), le prende el auto-merge y entra cuando alguien lo apruebe.
 * Devuelve { codigo: 'aplicado' } · { codigo: 'no_aplica_solo' } (queda con auto-merge, o para aprobar). Nunca saltea
 * una regla del repo: si GitHub no deja, el pedido queda.
 */
async function aplicarEnGithub({ remote, cred, urlBase, fetch: f, secretos, pedido, sha, titulo, rama }) {
  const base = baseDe(remote, urlBase);
  const { enlace } = pedido;
  const directo = await llamar({ method: 'PUT', url: `${base}/pulls/${encodeURIComponent(pedido.numero)}/merge`, remote, cred, fetch: f, secretos, cuerpo: { merge_method: 'merge', sha, commit_title: `${titulo} (aplicado por el sitio)` } });
  const aplicado = { ok: true, codigo: 'aplicado', rama, enlace, message: M('rp.aplicado', { enlace }) };
  if (directo.status === 200 && directo.doc && directo.doc.merged === true) return aplicado;
  // sin respuesta (o un error del servidor) el merge pudo haber entrado: se mira el pedido antes de seguir
  if (!directo.status || directo.status >= 500) {
    const visto = await llamar({ url: `${base}/pulls/${encodeURIComponent(pedido.numero)}`, remote, cred, fetch: f, secretos });
    if (visto.status === 200 && visto.doc && visto.doc.merged === true) return aplicado;
  }
  const porQue = motivoDeEscritura(directo);
  if (!pedido.nodo) return { ok: true, codigo: 'no_aplica_solo', rama, enlace, message: M('rp.githubNoAprueba', { motivo: porQue, enlace }) };
  // GitHub Enterprise sirve la API en /api/v3 y GraphQL en /api/graphql; github.com, las dos en la raíz
  const raiz = ((urlBase && urlBase.github) || URL_BASE.github).replace(/\/$/, '');
  const graphql = /\/api\/v3$/.test(raiz) ? raiz.replace(/\/v3$/, '/graphql') : `${raiz}/graphql`;
  const auto = await llamar({ method: 'POST', url: graphql, remote, cred, fetch: f, secretos, cuerpo: { query: 'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { number } } }', variables: { id: pedido.nodo } } });
  const errores = auto.doc && Array.isArray(auto.doc.errors) ? auto.doc.errors : [];
  if (auto.status === 200 && !errores.length && auto.doc && auto.doc.data && auto.doc.data.enablePullRequestAutoMerge) {
    return { ok: true, codigo: 'no_aplica_solo', rama, enlace, message: M('rp.githubAutoMerge', { enlace }) };
  }
  const motivo = errores.length && errores[0] && errores[0].message ? tapar(String(errores[0].message).slice(0, 200), secretos) : motivoDeEscritura(auto);
  return { ok: true, codigo: 'no_aplica_solo', rama, enlace, message: M('rp.githubNoAprueba', { motivo: `${porQue}; auto-merge: ${motivo}`, enlace }) };
}

/** El enlace para abrir el pedido a mano (el mismo que `proposalPlan` de team-config.js). */
function enlaceManual(remote, rama) {
  if (remote.platform === 'github') return `${remote.web}/compare/${RAMA_PRINCIPAL}...${rama}?expand=1`;
  if (remote.platform === 'azure') return `${remote.web}/pullrequestcreate?sourceRef=${encodeURIComponent(rama)}&targetRef=${encodeURIComponent(RAMA_PRINCIPAL)}`;
  return null;
}

// ── La propuesta ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Propone `contenido` como el nuevo `archivo` del repo de operaciones: rama + commit + empuje + pedido, dentro de
 * `exclusivo` (el candado compartido con el refresco de sources.js). Devuelve { ok: true, rama, enlace, message } o
 * { ok: false, codigo, message, rama?, manual?, enlace? }. Códigos: plataforma_desconocida · sin_credencial · cambio ·
 * pedido_abierto · sin_politica · no_se_pudo_leer · sin_permiso · git · pedido_no_abierto. Con `aplicarSolo`, además
 * { ok: true, codigo: 'aplicado' | 'no_aplica_solo' } o { ok: false, codigo: 'quedo_abierto' } (ver `aplicarPedido`).
 * `esperar(ms)` se inyecta para las pruebas.
 */
async function proponer({ clon, archivo: archivoSuelto, contenido, oidEsperado, archivos: varios = null, idCorto, secciones = [], quien, credencial, remote, urlBase, exclusivo = (fn) => fn(), now, git = 'git', fetch: f, log = () => {}, aplicarSolo = false, marca = null, esperar = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!remote || (remote.platform !== 'azure' && remote.platform !== 'github')) return { ok: false, codigo: 'plataforma_desconocida', message: M('rp.sinPlataforma') };
  const cred = credenciales(credencial);
  if (!cred.git || !cred.api) return { ok: false, codigo: 'sin_credencial', message: M('rp.sinCredencial') };
  // varios archivos en un mismo pedido (`archivos: [{ archivo, contenido, oidEsperado }]`), o uno suelto como siempre
  const lista = Array.isArray(varios) ? varios : [{ archivo: archivoSuelto, contenido, oidEsperado }];
  // sin la versión del archivo que se abrió no se puede saber si otro lo cambió: null = «no existía»
  if (!lista.length || lista.some((x) => !x || x.oidEsperado === undefined)) return { ok: false, codigo: 'sin_version', message: M('rp.sinVersion') };
  if (!clon || !idCorto || lista.some((x) => !x.archivo || typeof x.contenido !== 'string')) return { ok: false, codigo: 'git', message: M('rp.faltanDatos') };
  const archivo = lista.map((x) => x.archivo).join(', ');
  const cabecera = `Basic ${Buffer.from(`x-access-token:${cred.git}`).toString('base64')}`;
  const secretos = secretosDe(cred);
  const registrar = (l) => log(tapar(l, secretos));
  const correr = typeof git === 'function' ? git : (args, opts) => correrGit(args, { ...opts, git });

  return exclusivo(async () => {
    // el origen del clon, para la cabecera (nunca en la dirección ni en el disco)
    const origenR = await correr(['config', '--get', 'remote.origin.url'], { cwd: clon, env: envDeGit(null, null) });
    if (origenR.status !== 0) return { ok: false, codigo: 'git', message: M('rp.sinOrigin') };
    let origen = null;
    try { origen = new URL(String(origenR.stdout).trim()).origin; } catch { /* una ruta local: sin cabecera */ }
    const env = envDeGit(origen, cabecera);
    const fallaGit = (r, que) => {
      const err = tapar(`${r.stderr || ''}${r.error ? ` ${r.error.code || r.error.message}` : ''}`, secretos).split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' · ').slice(0, 300);
      registrar(`propuesta de ${archivo}: ${que} falló: ${err}`);
      return err;
    };

    // 1. la punta de main, recién traída
    const fetchR = await correr(['fetch', '--depth', '1', '--no-tags', 'origin', RAMA_PRINCIPAL], { cwd: clon, env });
    if (fetchR.status !== 0) {
      const err = fallaGit(fetchR, 'git fetch');
      return NO_PERMISSION.test(err) ? { ok: false, codigo: 'sin_permiso', message: M('rp.sinPermiso', { repo: remote.repo }) } : { ok: false, codigo: 'git', message: M('rp.noTraje', { rama: RAMA_PRINCIPAL, error: err }) };
    }
    const puntaR = await correr(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'], { cwd: clon, env });
    if (puntaR.status !== 0) return { ok: false, codigo: 'git', message: M('rp.sinPunta', { rama: RAMA_PRINCIPAL, error: fallaGit(puntaR, 'git rev-parse') }) };
    const punta = String(puntaR.stdout).trim();

    // 2. ¿cambió algún archivo desde que se abrió la sección?
    for (const x of lista) {
      const oidR = await correr(['rev-parse', '--verify', '--quiet', `${punta}:${x.archivo}`], { cwd: clon, env });
      const oidActual = oidR.status === 0 ? String(oidR.stdout).trim() : null;
      if ((x.oidEsperado || null) === oidActual) continue;
      // con el texto de la punta, quien llama puede poner la propuesta encima en vez de pedir que se recargue
      const actualR = oidActual ? await correr(['cat-file', 'blob', oidActual], { cwd: clon, env }) : null;
      const textoActual = actualR && actualR.status === 0 ? String(actualR.stdout) : null;
      if (actualR && actualR.status !== 0) fallaGit(actualR, 'git cat-file');
      return { ok: false, codigo: 'cambio', message: M('rp.cambio'), oidActual, ...(lista.length > 1 ? { archivo: x.archivo } : {}), ...(oidActual && textoActual === null ? {} : { textoActual }) };
    }

    // 3. ¿ya hay un pedido abierto sobre este archivo?
    const abierto = await pedidoAbierto({ remote, credencial: cred, idCorto, urlBase, fetch: f });
    if (abierto && abierto.error) return { ok: false, codigo: 'no_se_pudo_leer', message: M('rp.noVerifique', { error: abierto.error }) };
    if (abierto) return { ok: false, codigo: 'pedido_abierto', enlace: abierto.enlace, rama: abierto.rama, message: M('rp.yaAbierto', { enlace: abierto.enlace }) };

    // 4. la política de la rama principal, para CADA archivo (un filtro de ruta puede no cubrir alguno)
    let politica = null;
    for (const x of lista) {
      politica = await politicaDeRevision({ remote, credencial: cred, urlBase, fetch: f, archivo: x.archivo, aplicarSolo });
      if (!politica.ok) return { ok: false, codigo: politica.codigo, message: politica.message };
    }

    // 5. el commit, sin tocar el árbol ni el índice del clon
    const rama = `team-config/${idCorto}-${stamp(fechaDe(now))}`;
    const titulo = `Configuración de la organización: ${archivo}`;
    const indice = path.join(os.tmpdir(), `repo-proposal-${process.pid}-${crypto.randomBytes(6).toString('hex')}.index`);
    const envIndice = { ...env, GIT_INDEX_FILE: indice };
    const fecha = fechaDe(now).toISOString();
    const envCommit = { ...envIndice, ...AUTOR, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha };
    let sha;
    try {
      const pasos = [['read-tree', punta]];
      for (const x of lista) {
        const blob = await correr(['hash-object', '-w', '--stdin'], { cwd: clon, env, input: x.contenido });
        if (blob.status !== 0) return { ok: false, codigo: 'git', message: M('rp.noGuarde', { error: fallaGit(blob, 'git hash-object') }) };
        pasos.push(['update-index', '--add', '--cacheinfo', `100644,${String(blob.stdout).trim()},${x.archivo}`]);
      }
      for (const args of pasos) {
        const r = await correr(args, { cwd: clon, env: envIndice });
        if (r.status !== 0) return { ok: false, codigo: 'git', message: M('rp.noCommit', { error: fallaGit(r, `git ${args[0]}`) }) };
      }
      const tree = await correr(['write-tree'], { cwd: clon, env: envIndice });
      if (tree.status !== 0) return { ok: false, codigo: 'git', message: M('rp.noCommit', { error: fallaGit(tree, 'git write-tree') }) };
      const commit = await correr(['commit-tree', String(tree.stdout).trim(), '-p', punta, '-m', titulo], { cwd: clon, env: envCommit });
      if (commit.status !== 0) return { ok: false, codigo: 'git', message: M('rp.noCommit', { error: fallaGit(commit, 'git commit-tree') }) };
      sha = String(commit.stdout).trim();
    } finally {
      fs.rmSync(indice, { force: true });
    }
    // 🔴 sin --force y nunca a la rama principal: el sha va directo a la rama nueva, sin ref local en el clon
    const push = await correr(['push', 'origin', `${sha}:refs/heads/${rama}`], { cwd: clon, env });
    if (push.status !== 0) {
      const err = fallaGit(push, 'git push');
      if (NO_PERMISSION.test(err)) return { ok: false, codigo: 'sin_permiso', message: M('rp.sinPermiso', { repo: remote.repo }) };
      return { ok: false, codigo: 'git', message: M('rp.noSubi', { rama, error: err }) };
    }
    registrar(`propuesta de ${archivo}: rama ${rama} empujada`);

    // 6. el pedido (uno por archivo, con las secciones)
    // con la opción de aplicar solo, el pedido dice quién lo pidió y que lo aplica el sitio (el registro de quién lo hizo)
    const cuerpo = cuerpoDelPedido({ secciones, quien, aplicarSolo, marca });
    const pedido = await abrirPedido({ remote, cred, urlBase, rama, titulo, cuerpo, fetch: f, secretos });
    if (!pedido.ok) {
      const manual = enlaceManual(remote, rama);
      registrar(`propuesta de ${archivo}: el pedido no se abrió (${pedido.motivo})`);
      return { ok: false, codigo: 'pedido_no_abierto', rama, manual, message: M('rp.noAbri', { rama, motivo: tapar(pedido.motivo, secretos), manual }) };
    }
    registrar(`propuesta de ${archivo}: pedido abierto ${pedido.enlace}`);
    if (!aplicarSolo) return { ok: true, rama, enlace: pedido.enlace, message: M('rp.abierto', { enlace: pedido.enlace }) };
    const aplicado = remote.platform === 'github'
      ? await aplicarEnGithub({ remote, cred, urlBase, fetch: f, secretos, pedido, sha, titulo, rama })
      : await aplicarPedido({ remote, cred, urlBase, fetch: f, secretos, pedido, sha, titulo, quien, rama, esperar });
    registrar(aplicado.codigo === 'aplicado' ? `cambio aplicado: ${archivo} por ${quien || 'alguien'}, pedido ${pedido.enlace}` : `propuesta de ${archivo}: no se aplicó sola (${aplicado.codigo}): ${aplicado.message}`);
    return aplicado;
  });
}

/** Un ambiente sin las variables `SITE_*` del sitio (ahí viven sus credenciales). */
const sinVariablesDelSitio = (env) => Object.fromEntries(Object.entries(env || {}).filter(([k]) => !/^SITE_/.test(k)));

/** Las variables de git: la cabecera por GIT_CONFIG_* (el patrón de sources.js), sin ayudantes de credenciales ni prompts. */
function envDeGit(origen, cabecera) {
  const conf = [['core.symlinks', 'false'], ['credential.helper', '']];
  if (origen && cabecera) conf.push([`http.${origen}/.extraheader`, `Authorization: ${cabecera}`]);
  // las variables del sitio (sus credenciales) no viajan al proceso git: no las necesita
  const env = { ...sinVariablesDelSitio(process.env), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: String(conf.length) };
  delete env.GIT_INDEX_FILE; delete env.GIT_DIR; delete env.GIT_WORK_TREE;
  conf.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return env;
}

// ── lo que la pestaña Configuración lee de cada plataforma, sin escribir nada ─────────────────
/** El enlace web a un archivo de la rama principal de un repo, o null si la plataforma no se reconoce. */
function enlaceArchivo(remote, rel) {
  if (!remote || !remote.web) return null;
  if (remote.platform === 'github') return `${remote.web}/blob/main/${rel}`;
  if (remote.platform === 'azure') return `${remote.web}?path=/${rel}`;
  return null;
}

/**
 * La propuesta de stages de un pipeline: sólo lee, con la credencial de sólo lectura de pipelines. En Azure
 * DevOps, `pipeline` es el número de la definición: se leen la última corrida terminada de la rama principal y su
 * timeline, y se proponen los identificadores de stage (el nombre visible va al lado, sólo como ayuda). En GitHub,
 * `pipeline` es `dueño/repo` del producto: se proponen sus environments. `{ ok, propuestos: [{ identificador, nombre,
 * estado: 'propuesto' }] }` o `{ ok: false, message }` — nunca un nombre que no se leyó.
 */
async function stagesPropuestos({ pipeline, remote, token, urlBase = {}, fetch = globalThis.fetch }) {
  const p = String(pipeline || '').trim();
  const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const pedir = async (url, headers) => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw Object.assign(new Error(`respuesta ${r.status}`), { status: r.status });
    return r.json();
  };
  // Azure: «<número>» (en el proyecto del repo de operaciones) o «<proyecto>/<número>» (los ids de definición son por
  // proyecto: un producto que vive en otro proyecto se nombra con el suyo)
  // un segmento hecho sólo de puntos («.», «..») subiría de nivel en la ruta de la API: no es un nombre;
  // los demás van codificados
  const sinPuntos = (s) => !/^\.+$/.test(s);
  const az = /^(?:([^/]+)\/)?(\d+)$/.exec(p);
  if (az && az[1] !== undefined && !sinPuntos(az[1])) return { ok: false, message: M('rp.pipelineNoReconocido') };
  if (az) {
    if (!token) return { ok: false, message: M('rp.stageAMano') };
    if (!remote || remote.platform !== 'azure') return { ok: false, message: M('rp.noEsAzure') };
    const proyecto = az[1] || remote.project;
    const definicion = az[2];
    const base = `${(urlBase.azure || 'https://dev.azure.com').replace(/\/$/, '')}/${encodeURIComponent(remote.org)}/${encodeURIComponent(proyecto)}/_apis`;
    const headers = { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`, Accept: 'application/json' };
    try {
      const b = await pedir(`${base}/build/builds?definitions=${definicion}&branchName=refs/heads/main&$top=1&statusFilter=completed&api-version=7.1`, headers);
      const id = b && Array.isArray(b.value) && b.value[0] ? b.value[0].id : null;
      if (!id) return { ok: false, message: M('rp.sinCorrida', { pipeline: p }) };
      const tl = await pedir(`${base}/build/builds/${id}/timeline?api-version=7.1`, headers);
      return { ok: true, propuestos: (Array.isArray(tl.records) ? tl.records : []).filter((x) => isObject(x) && x.type === 'Stage' && typeof x.identifier === 'string').map((x) => ({ identificador: x.identifier, nombre: typeof x.name === 'string' ? x.name : null, estado: 'propuesto' })) };
    } catch (e) { return { ok: false, message: M('rp.pipelineIlegible', { pipeline: p, estado: e.status ? e.status : M('rp.sinRespuesta') }) }; }
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p) && p.split('/').every(sinPuntos)) {
    if (!token) return { ok: false, message: M('rp.environmentAMano') };
    const base = (urlBase.github || 'https://api.github.com').replace(/\/$/, '');
    try {
      const e = await pedir(`${base}/repos/${p}/environments`, { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
      return { ok: true, propuestos: (Array.isArray(e.environments) ? e.environments : []).filter((x) => isObject(x) && typeof x.name === 'string').map((x) => ({ identificador: x.name, nombre: null, estado: 'propuesto' })) };
    } catch (err) { return { ok: false, message: M('rp.environmentsIlegibles', { pipeline: p, estado: err.status ? err.status : M('rp.sinRespuesta') }) }; }
  }
  return { ok: false, message: M('rp.pipelineNoReconocido') };
}

/**
 * Los pipelines de un proyecto de Azure DevOps, para elegirlos por nombre (sólo lee, con SITE_PIPELINES_TOKEN, que pide
 * lectura de Build): `{ ok: true, pipelines: [{ id, nombre, carpeta }] }` ordenados por nombre, o `{ ok: false, codigo,
 * message }` con lo que la persona tiene que saber. `codigo`: sin_permiso (falta la credencial o no alcanza),
 * no_reconozco (organización o proyecto que no son un nombre) o sin_respuesta.
 */
async function pipelinesDelProyecto({ org, project, token, urlBase = {}, fetch = globalThis.fetch }) {
  const nombre = (x) => typeof x === 'string' && x.trim() !== '' && !/^\.+$/.test(x.trim()) && !/[/\\?#]/.test(x);
  if (!nombre(org) || !nombre(project)) return { ok: false, codigo: 'no_reconozco', message: M('rp.faltaOrgProyecto') };
  if (!token) return { ok: false, codigo: 'sin_permiso', message: M('rp.sinPermisoPipelines') };
  const base = `${(urlBase.azure || 'https://dev.azure.com').replace(/\/$/, '')}/${encodeURIComponent(org.trim())}/${encodeURIComponent(project.trim())}/_apis`;
  const headers = { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`, Accept: 'application/json' };
  let r;
  try { r = await fetch(`${base}/pipelines?$top=1000&api-version=7.1`, { headers, signal: AbortSignal.timeout(20000) }); } catch {
    return { ok: false, codigo: 'sin_respuesta', message: M('rp.azureNoContesto') };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, codigo: 'sin_permiso', message: M('rp.permisoCorto', { proyecto: project.trim() }) };
  if (r.status === 404) return { ok: false, codigo: 'no_reconozco', message: M('rp.proyectoDesconocido', { proyecto: project.trim(), org: org.trim() }) };
  if (!r.ok) return { ok: false, codigo: 'sin_respuesta', message: M('rp.azureContesto', { estado: r.status }) };
  let doc;
  try { doc = await r.json(); } catch { return { ok: false, codigo: 'sin_respuesta', message: M('rp.respuestaIlegible') }; }
  const lista = (doc && Array.isArray(doc.value) ? doc.value : [])
    .filter((x) => x && Number.isInteger(x.id) && x.id >= 1 && typeof x.name === 'string')
    .map((x) => ({ id: x.id, nombre: x.name, carpeta: typeof x.folder === 'string' && x.folder !== '\\' ? x.folder.replace(/^\\/, '') : null }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return { ok: true, pipelines: lista };
}

// ── los tipos de pedido de trabajo de un proyecto y los campos de un tipo, con sus valores permitidos ──
// Lo de cada plataforma vive acá; quien llama recibe siempre la misma forma: { ok, tipos } / { ok, campos }, o
// { ok: false, codigo: sin_permiso | sin_respuesta | no_reconozco, message }. Sólo lee.
const nombreDeRuta = (x) => typeof x === 'string' && x.trim() !== '' && !/^\.+$/.test(x.trim()) && !/[/\\?#]/.test(x);
async function leerPedidos({ org, project, token, urlBase = {}, fetch = globalThis.fetch, ruta }) {
  if (!nombreDeRuta(org) || !nombreDeRuta(project)) return { ok: false, codigo: 'no_reconozco', message: M('rp.faltaOrgProyecto') };
  if (!token) return { ok: false, codigo: 'sin_permiso', message: M('rp.sinPermisoPedidos') };
  const base = `${(urlBase.azure || 'https://dev.azure.com').replace(/\/$/, '')}/${encodeURIComponent(org.trim())}/${encodeURIComponent(project.trim())}/_apis/wit/workitemtypes`;
  const headers = { Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`, Accept: 'application/json' };
  let r;
  try { r = await fetch(`${base}${ruta}`, { headers, signal: AbortSignal.timeout(20000) }); } catch {
    return { ok: false, codigo: 'sin_respuesta', message: M('rp.pedidosNoContesto') };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, codigo: 'sin_permiso', message: M('rp.permisoPedidos', { proyecto: project.trim() }) };
  if (r.status === 404) return { ok: false, codigo: 'no_reconozco', message: M('rp.proyectoDesconocido', { proyecto: project.trim(), org: org.trim() }) };
  if (!r.ok) return { ok: false, codigo: 'sin_respuesta', message: M('rp.pedidosContesto', { estado: r.status }) };
  try { const doc = await r.json(); return { ok: true, value: doc && Array.isArray(doc.value) ? doc.value : [] }; } catch {
    return { ok: false, codigo: 'sin_respuesta', message: M('rp.pedidosIlegible') };
  }
}
/**
 * De qué organización y proyectos leer, según la lista de productos (repos.json del repo de operaciones):
 * `{ org, proyectos }` o null. El proyecto va codificado en la lista («Beta%20Dos/Back»): se decodifica, como la noche.
 */
function dondeLeerPedidos(doc) {
  const esObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const org = esObj(doc) && esObj(doc.azure) && typeof doc.azure.org === 'string' ? doc.azure.org.trim() : '';
  const decodificar = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
  const proyectos = [...new Set((esObj(doc) && Array.isArray(doc.repos) ? doc.repos : [])
    .filter((x) => esObj(x) && x.activo !== false && typeof x.ado === 'string' && x.ado.includes('/'))
    .map((x) => decodificar(x.ado.split('/')[0]).trim()).filter(Boolean))];
  return org && proyectos.length ? { org, proyectos } : null;
}
/** Los tipos de pedido de un proyecto que se pueden crear: `{ ok, tipos: [nombre] }`, en orden alfabético. */
async function tiposDePedido(opts) {
  const r = await leerPedidos({ ...opts, ruta: '?api-version=7.1' });
  if (!r.ok) return r;
  // los tipos internos del proceso (planes de prueba, pasos compartidos, revisiones de código) los declara la propia
  // plataforma en su categoría oculta: no se ofrecen. Si esa lectura falla, van todos (escribir sigue valiendo)
  const ocultos = new Set();
  try {
    const h = await (opts.fetch || globalThis.fetch)(`${(opts.urlBase && opts.urlBase.azure || 'https://dev.azure.com').replace(/\/$/, '')}/${encodeURIComponent(opts.org.trim())}/${encodeURIComponent(opts.project.trim())}/_apis/wit/workitemtypecategories/Microsoft.HiddenCategory?api-version=7.1`,
      { headers: { Authorization: `Basic ${Buffer.from(`:${opts.token}`).toString('base64')}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (h.ok) { const d = await h.json(); for (const t of (d && Array.isArray(d.workItemTypes) ? d.workItemTypes : [])) if (t && typeof t.name === 'string') ocultos.add(t.name); }
  } catch { /* sin la categoría, la lista entera */ }
  const tipos = [...new Set(r.value.filter((x) => x && typeof x.name === 'string' && x.name.trim() && x.isDisabled !== true && !ocultos.has(x.name)).map((x) => x.name))]
    .sort((a, b) => a.localeCompare(b, 'es'));
  return { ok: true, tipos };
}
/** Los campos de un tipo: `{ ok, campos: [{ referencia, nombre, valores: [] }] }`; `valores` vacío = texto libre. */
async function camposDelTipo({ tipo, ...opts }) {
  if (!nombreDeRuta(tipo)) return { ok: false, codigo: 'no_reconozco', message: M('rp.tipoDesconocido', { proyecto: String(opts.project || '').trim(), tipo: String(tipo || '') }) };
  const r = await leerPedidos({ ...opts, ruta: `/${encodeURIComponent(tipo.trim())}/fields?$expand=allowedValues&api-version=7.1` });
  if (!r.ok) return r.codigo === 'no_reconozco' && nombreDeRuta(opts.project) && nombreDeRuta(opts.org) ? { ...r, message: M('rp.tipoDesconocido', { proyecto: opts.project.trim(), tipo: tipo.trim() }) } : r;
  const campos = r.value.filter((x) => x && typeof x.referenceName === 'string' && x.referenceName.trim())
    .map((x) => ({ referencia: x.referenceName, nombre: typeof x.name === 'string' ? x.name : x.referenceName,
      valores: Array.isArray(x.allowedValues) ? x.allowedValues.filter((v) => typeof v === 'string' || typeof v === 'number').map(String) : [] }))
    .sort((a, b) => a.referencia.localeCompare(b.referencia, 'es'));
  return { ok: true, campos };
}

module.exports = {
  TEXTOS, remoteOf, stagesPropuestos, pipelinesDelProyecto, tiposDePedido, camposDelTipo, dondeLeerPedidos, enlaceArchivo, politicaDeRevision, pedidoAbierto, pedidoDeMarca, cuerpoDelPedido, FORMA_DE_MARCA, proponer, correrGit, enlaceManual, stamp, NO_PERMISSION, TIPO_REVISORES_AZURE };
