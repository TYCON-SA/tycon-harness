#!/usr/bin/env node
'use strict';

/**
 * queue-validation.js — encola la validación de una rama en Azure y, ANTES, corta las validaciones de esa misma rama
 * que todavía no terminaron.
 *
 * POR QUÉ: la organización tiene 4 carriles y varias sesiones validando ramas a la vez.
 * Cada sesión encola con `az pipelines run --id <validación> --branch <rama>`; si después empuja otro commit y vuelve a
 * encolar, la validación vieja sigue ocupando la fila sobre un código que ya nadie va a mergear (dos
 * validaciones de la misma rama, una de un commit ya superado, ocupan ~40 min de carril cada una). La nueva prueba lo mismo
 * que la vieja y más: la vieja se corta.
 *
 * Sólo corta validaciones de LA MISMA RAMA y del MISMO pipeline. Las de otras ramas no: cada rama tiene sus cambios y
 * la validación de una no prueba la de otra.
 *
 * Cortar una corrida no saca su trabajo de la fila: el pedido de agente queda huérfano hasta que Azure lo limpia, a
 * los minutos. Por eso, además de cancelar la corrida, borra sus pedidos
 * que todavía esperan carril. Uno que ya tiene carril lo termina Azure al cancelar.
 *
 * «No pude mirar» no es «no hay»: si la lista de validaciones de la rama no se puede leer, no se corta nada ni se
 * encola nada (sale 2 y lo dice), para que nadie crea que la vieja ya no está.
 *
 * UN CLON DE GITHUB. Quien mantiene el arnés puede trabajar en un clon del repo público, y la
 * validación es otra definición, atada a ese repo. Este guion viaja en el público: la organización, el proyecto y el
 * número de esa definición NO se escriben acá; salen de las opciones o de la configuración de la máquina
 * (`TYCON_VALIDATION_ORG`, `TYCON_VALIDATION_PROJECT`, `TYCON_VALIDATION_PIPELINE`). Sin definición, sale 2: no inventa
 * la del clon de Azure, que es otra. Y si la rama ya tiene un pedido abierto en GitHub, NO encola: el pedido ya dispara la
 * validación (y Azure corta las corridas viejas de ese pedido), y otra a mano serían dos corridas por cambio sobre los
 * mismos carriles. Lo mira con `gh pr list`; si no puede mirar, sale 2 sin tocar nada.
 *
 * Uso:  node scripts/ci/queue-validation.js [--branch <rama>] [--pipeline <id>] [--org <org>] [--project <proyecto>]
 *                                           [--all] [--dry-run]
 *   --branch     por defecto, la rama actual del clon (`git rev-parse --abbrev-ref HEAD`).
 *   --all        la validación completa: corren todas las suites (parámetro `runAll` de pipelines/azure-pipelines-maintainers-pr.yml).
 *                Sin él, la validación corre lo que la rama toca.
 *   --pipeline   o `TYCON_VALIDATION_PIPELINE` (sólo un clon de GitHub); con un origin de Azure, por defecto la que
 *                declara team-repos.json para ese repo (`merge_suites.repos[].full_tests_pipeline`, el número de la
 *                definición). Sin ninguna, sale 2 con la línea que hay que declarar: el número no se escribe acá.
 *   --org/--project  o `TYCON_VALIDATION_ORG`/`TYCON_VALIDATION_PROJECT`; con un origin de Azure, por defecto los suyos
 *                (https://dev.azure.com/<org>/<proyecto>/_git/<repo>).
 *   --dry-run    dice qué cortaría y qué encolaría, sin tocar nada.
 * Necesita AZURE_DEVOPS_EXT_PAT (y, con un clon de GitHub, `gh` con sesión; `TYCON_GH` lo reemplaza, sólo las pruebas).
 * `TYCON_ADO_BASE_URL` reemplaza https://dev.azure.com (sólo las pruebas).
 * Sale 0 encolada (y las viejas cortadas) · 1 no se pudo encolar · 2 no se pudo mirar (nada cortado ni encolado) ·
 *      3 encolada, pero una vieja no se pudo cortar (se nombra) · 4 la rama tiene un pedido abierto: no se encola.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const POOL_NAME = 'Azure Pipelines';
const EMPTY_LOCK = '00000000-0000-0000-0000-000000000000';

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function git(args) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return ''; }
}

/**
 * org y proyecto del `origin` de Azure DevOps; null si el origin no tiene una de sus formas. Azure tiene cuatro, y el
 * agente de sus propios pipelines usa la segunda:
 *   https://dev.azure.com/<org>/<proyecto>/_git/<repo>         https://<org>.visualstudio.com/[DefaultCollection/]<proyecto>/_git/<repo>
 *   …ssh.dev.azure.com:v3/<org>/<proyecto>/<repo>              …vs-ssh.visualstudio.com:v3/<org>/<proyecto>/<repo>
 */
function fromOrigin(url) {
  const p = partsOfOrigin(url);
  return p && { org: p.org, project: p.project };
}

/** La identidad del repo del `origin` de Azure DevOps, como en team-repos.json (`{ platform, org, project, repo }`), o null. */
function identityOfOrigin(url) {
  const p = partsOfOrigin(url);
  return p && p.repo ? { platform: 'azure', ...p } : null;
}

/** org, proyecto y repo (`''` si la dirección no lo trae) del `origin` de Azure DevOps; null si no tiene una de sus formas. */
function partsOfOrigin(url) {
  const p = serverAndPath(url);
  if (!p) return null;
  let found = null;
  if (p.server === 'dev.azure.com') {
    const m = /^([^/]+)\/([^/]+)\/_git\/([^/?#]*)/.exec(p.path);
    found = m && [m[1], m[2], m[3]];
  } else if (p.server === 'ssh.dev.azure.com' || p.server === 'vs-ssh.visualstudio.com') {
    const m = /^v3\/([^/]+)\/([^/]+)\/([^/?#]*)/.exec(p.path);
    found = m && [m[1], m[2], m[3]];
  } else if (/^[^.]+\.visualstudio\.com$/.test(p.server)) {
    const m = /^(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]*)/.exec(p.path);
    found = m && [p.server.split('.')[0], m[1], m[2]];
  }
  if (!found) return null;
  const [org, project, repo] = found.map(decoded);
  // un `.` o un `..` escondido tras un `%2e` no es un nombre: vuelve a la ruta de la API tal cual y la cambia
  if ([org, project].some((x) => /^\.{1,2}$/.test(x))) return null;
  return { org, project, repo: /^\.{1,2}$/.test(repo) ? '' : repo };
}

/**
 * La definición que valida un repo de Azure según team-repos.json (`merge_suites.repos[].full_tests_pipeline`):
 * `{ value }` con su número, o `{ problem }` con lo que falta declarar. El árbol es `TYCON_TREE` o el de este guion.
 */
function declaredPipeline(identity) {
  const where = `${identity.org}/${identity.project}/${identity.repo}`;
  const line = `team-repos.json → merge_suites.repos[] { "repo": { "platform": "azure", "org": "${identity.org}", "project": "${identity.project}", "repo": "${identity.repo}" }, "full_tests_pipeline": <número de la definición> }, o pasala con --pipeline`;
  let TR;
  try { TR = require('../lib/team-repos.js'); } catch (e) { return { problem: `no pude cargar el lector de team-repos.json (${e.code || e.message}): pasá la definición con --pipeline` }; }
  const file = path.join(process.env.TYCON_TREE || path.join(__dirname, '..', '..'), 'team-repos.json');
  const t = TR.load(file);
  if (t.couldNotRead || !t.data) return { problem: `no sé qué definición de Azure valida ${where}: no pude leer team-repos.json. Declarala: ${line}` };
  const p = TR.mergeSuitesFor(t.data, identity).pipeline;
  if (Number.isInteger(p) && p >= 1) return { value: String(p) };
  if (typeof p === 'string' && /^\d+$/.test(p.trim()) && Number(p) >= 1) return { value: p.trim() };
  if (p !== null && p !== undefined) return { problem: `${where} declara full_tests_pipeline «${p}»: es un nombre, y para encolar hace falta el número de la definición de Azure. Declaralo: ${line}` };
  return { problem: `no sé qué definición de Azure valida ${where}: declarala en ${line}` };
}

/**
 * El servidor y la ruta del `origin`, en sus dos escrituras: una dirección (`https://[usuario@]servidor[:puerto]/ruta`)
 * y la corta de SSH (`[usuario@]servidor:ruta`). null si no es ninguna (una carpeta, por ejemplo). «De qué servidor es»
 * se contesta con esto y no buscando el nombre en el texto: una ruta de otro servidor puede nombrar a Azure.
 */
function serverAndPath(url) {
  const u = String(url || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    // Una dirección entera la parte el lector de direcciones de Node, como la parten git y curl. Partida a mano, lo que
    // hay antes de la arroba pasaría por usuario aunque traiga un `?`, un `#` o una `\`, que cortan el servidor
    // (`https://otro-servidor?@<azure>/…` se lee como de Azure, y git se conecta a `otro-servidor`).
    let parsed;
    try { parsed = new URL(u); } catch (_) { return null; }
    return parsed.hostname ? { server: parsed.hostname.toLowerCase(), path: parsed.pathname.replace(/^\/+/, '') } : null;
  }
  // en la corta, git toma por servidor lo que hay hasta el PRIMER `:`: el usuario no puede traer uno (si no,
  // `otro-servidor:x@<azure>:v3/…` se leería como de Azure, y git se conectaría a `otro-servidor`)
  const m = /^(?:[^@/:]+@)?([^@/:]+):(.*)$/.exec(u);
  return m ? { server: m[1].toLowerCase(), path: m[2] } : null;
}

/** Un tramo de la dirección sin su escape; con un `%` mal escrito queda como vino (no es motivo para caerse). */
function decoded(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }

/** ¿El `origin` es de Azure DevOps? Por su servidor, en cualquiera de sus formas (aunque no se le pueda leer el proyecto). */
const isAzure = (url) => { const p = serverAndPath(url); return !!p && /(^|\.)(dev\.azure\.com|visualstudio\.com)$/.test(p.server); };

/**
 * La dirección del `origin` del clon: `{ ok: true, url }` —`url` vacía fuera de un clon o sin ese remoto, que es «no
 * hay»— o `{ ok: false, reason }` si git no dejó leerla («no pude leer» no es «no hay»: de esa dirección sale si el clon
 * es el del público, y con eso si antes de encolar hay que mirar los pedidos abiertos).
 */
function readOrigin() {
  const env = Object.assign({}, process.env, { LC_ALL: 'C', LANGUAGE: 'C' });
  try {
    return { ok: true, url: execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim() };
  } catch (e) {
    const err = String((e.stderr && e.stderr.toString()) || e.message).trim();
    if (/not a git repository|No such remote/i.test(err)) return { ok: true, url: '' };
    return { ok: false, reason: err.split('\n')[0] };
  }
}


/**
 * Los pedidos abiertos de la rama en GitHub: `{ ok: true, numbers }` o `{ ok: false, reason }` si no se pudo mirar
 * («no pude mirar» no es «no hay»).
 */
function openPrs(branch) {
  const gh = process.env.TYCON_GH || 'gh';
  let out;
  try {
    out = execFileSync(gh, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, reason: String((e.stderr && e.stderr.toString()) || e.message).trim().split('\n')[0] };
  }
  try {
    const list = JSON.parse(out);
    if (!Array.isArray(list)) return { ok: false, reason: 'gh no devolvió una lista' };
    return { ok: true, numbers: list.map((p) => p && p.number).filter(Boolean) };
  } catch (_) { return { ok: false, reason: 'gh no devolvió JSON' }; }
}

async function call(base, auth, method, path, body) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: Object.assign({ Authorization: auth }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, status: 0, reason: `sin respuesta (${e.cause && e.cause.code ? e.cause.code : e.message})` };
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  // un 203 de Azure es la página de inicio de sesión: la llave no sirve, aunque no sea un error HTTP
  const ok = res.status >= 200 && res.status < 300 && res.status !== 203 && (method === 'DELETE' || json !== null);
  return { ok, status: res.status, json, reason: ok ? '' : `HTTP ${res.status}${res.status === 203 ? ' (la llave no sirve: Azure contestó con la página de inicio de sesión)' : ''}` };
}

async function main(argv) {
  const dry = argv.includes('--dry-run');
  // `--all`: la validación completa de la rama — el parámetro `runAll` de la validación corre todas las suites
  const all = argv.includes('--all');
  const allNote = all ? ', corre todo' : '';
  const branch = arg(argv, '--branch') || git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const read = readOrigin();
  if (!read.ok) { process.stderr.write(`queue-validation: no pude leer el origin del clon (${read.reason}): no sé si es el del público, no se cortó ni se encoló nada\n`); return 2; }
  // Sin origin (fuera de un clon, o un clon sin ese remoto) no hay de dónde leer nada: no es el clon del público, y la
  // organización y el proyecto sólo pueden llegar por opción. A propósito: así se encola a mano desde cualquier carpeta.
  const originUrl = read.url;
  // El clon del público es todo clon con un origin que NO es de Azure: reconocer GitHub
  // por su dirección dejaría afuera un origin con usuario antes del servidor (`https://<usuario>` arroba `github.com/…`) o un alias de SSH
  // (`git@github-trabajo:…`, el de varias cuentas), y ese clon se trataría como el interno. Un remoto de otro servidor
  // también cae acá: `gh` no lo encuentra y el guion sale 2 sin tocar nada. «De Azure» es por el servidor, en sus cuatro
  // formas (`isAzure`): el agente de Azure clona con la de `visualstudio.com`, y ese clon es el interno.
  const github = !!originUrl && !isAzure(originUrl);
  // La configuración de la máquina (`TYCON_VALIDATION_*`) es la del PÚBLICO: vale sólo para un clon de GitHub. Desde un
  // clon de Azure manda su origin y la definición que team-repos.json declara para ese repo —si no, una máquina
  // configurada para el público encolaría esa definición sobre una rama del clon de Azure.
  const cfg = (name) => (github ? process.env[name] || '' : '');
  const given = arg(argv, '--pipeline') || cfg('TYCON_VALIDATION_PIPELINE');
  const identity = (given || github) ? null : identityOfOrigin(originUrl);
  const declared = identity ? declaredPipeline(identity) : null;
  const pipeline = given || (declared && declared.value) || '';
  const origin = fromOrigin(originUrl);
  const org = arg(argv, '--org') || cfg('TYCON_VALIDATION_ORG') || (origin && origin.org);
  const project = arg(argv, '--project') || cfg('TYCON_VALIDATION_PROJECT') || (origin && origin.project);
  const pat = process.env.AZURE_DEVOPS_EXT_PAT || '';
  const say = (l) => process.stdout.write(`${l}\n`);
  const fail = (code, l) => { process.stderr.write(`queue-validation: ${l}\n`); return code; };

  if (!branch || branch === 'HEAD') return fail(2, 'no sé qué rama validar (pasala con --branch)');
  if (!pipeline && declared) return fail(2, declared.problem);
  if (!pipeline && github) return fail(2, 'el clon es de GitHub y no sé qué definición de Azure lo valida: pasala con --pipeline o con TYCON_VALIDATION_PIPELINE (la del clon de Azure no es la del público)');
  if (!pipeline) return fail(2, 'no sé qué definición de Azure validar: el origin no es de un repo de Azure DevOps (pasala con --pipeline)');
  if (!/^\d+$/.test(pipeline)) return fail(2, `--pipeline tiene que ser el número del pipeline («${pipeline}»)`);
  if (!org || !project) return fail(2, `no sé la organización o el proyecto de Azure: ${github ? 'el clon es de GitHub' : 'el origin no es de Azure DevOps'} (pasalos con --org y --project, o con TYCON_VALIDATION_ORG y TYCON_VALIDATION_PROJECT)`);
  if (!pat) return fail(2, 'falta AZURE_DEVOPS_EXT_PAT: no pude mirar nada, no se cortó ni se encoló nada');
  if (github) {
    // gh compara con el nombre corto de la rama: con `refs/heads/` adelante no encontraba el pedido abierto
    const prs = openPrs(branch.replace(/^refs\/heads\//, ''));
    if (!prs.ok) return fail(2, `no pude mirar si la rama tiene un pedido abierto en GitHub (${prs.reason}): no se cortó ni se encoló nada`);
    if (prs.numbers.length) return fail(4, `${branch} tiene un pedido abierto (#${prs.numbers.join(', #')}): la validación la dispara el pedido; otra a mano serían dos ejecuciones por el mismo cambio`);
  }

  const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  const root = (process.env.TYCON_ADO_BASE_URL || 'https://dev.azure.com').replace(/\/$/, '');
  const base = `${root}/${encodeURIComponent(org)}`;
  const proj = `/${encodeURIComponent(project)}`;
  const auth = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;

  // 1. las validaciones de esta rama que no terminaron (las dos que importan: esperando y corriendo)
  const old = [];
  for (const status of ['notStarted', 'inProgress']) {
    const r = await call(base, auth, 'GET', `${proj}/_apis/build/builds?definitions=${pipeline}&branchName=${encodeURIComponent(ref)}&statusFilter=${status}&api-version=7.1`);
    if (!r.ok || !Array.isArray(r.json && r.json.value)) return fail(2, `no pude leer las validaciones de ${branch} (${r.reason || 'respuesta sin lista'}): no se cortó ni se encoló nada`);
    old.push(...r.json.value);
  }
  if (dry) {
    say(old.length ? `cortaría: ${old.map((b) => `#${b.id} (${b.status}, ${String(b.sourceVersion || '').slice(0, 8)})`).join(', ')}` : `nada que cortar en ${branch}`);
    say(`encolaría: pipeline ${pipeline} sobre ${branch}${allNote}`);
    return 0;
  }

  // 2. cortarlas: la corrida, y sus pedidos que todavía esperan carril
  const notCut = [];
  const cut = [];
  for (const b of old) {
    const r = await call(base, auth, 'PATCH', `${proj}/_apis/build/builds/${b.id}?api-version=7.1`, { status: 'cancelling' });
    if (r.ok) cut.push(b.id); else notCut.push(`#${b.id} (${r.reason})`);
  }
  if (cut.length) {
    const pools = await call(base, auth, 'GET', `/_apis/distributedtask/pools?poolName=${encodeURIComponent(POOL_NAME)}&api-version=7.1`);
    const pool = pools.ok && pools.json && Array.isArray(pools.json.value) && pools.json.value[0];
    const reqs = pool ? await call(base, auth, 'GET', `/_apis/distributedtask/pools/${pool.id}/jobrequests?api-version=7.1`) : null;
    if (!reqs || !reqs.ok || !Array.isArray(reqs.json && reqs.json.value)) {
      say(`ojo: corté ${cut.map((i) => `#${i}`).join(', ')}, pero no pude leer la fila de agentes: sus pedidos que esperaban carril los limpia Azure en unos minutos`);
    } else {
      const waiting = reqs.json.value.filter((q) => !q.finishTime && !q.assignTime && q.owner && cut.includes(q.owner.id));
      for (const q of waiting) {
        const d = await call(base, auth, 'DELETE', `/_apis/distributedtask/pools/${pool.id}/jobrequests/${q.requestId}?lockToken=${q.lockToken || EMPTY_LOCK}&api-version=7.1`);
        if (!d.ok) say(`ojo: el pedido ${q.requestId} de #${q.owner.id} sigue en la fila (${d.reason}); lo limpia Azure en unos minutos`);
      }
    }
    say(`cortadas: ${cut.map((i) => `#${i}`).join(', ')} (validaciones anteriores de ${branch})`);
  }

  // 3. encolar la nueva
  const body = { definition: { id: Number(pipeline) }, sourceBranch: ref };
  if (all) body.templateParameters = { runAll: 'true' };
  const q = await call(base, auth, 'POST', `${proj}/_apis/build/builds?api-version=7.1`, body);
  if (!q.ok || !q.json || !q.json.id) return fail(1, `no pude encolar la validación de ${branch} (${q.reason || 'respuesta sin id'})${cut.length ? ` — ojo: las viejas ya se cortaron` : ''}`);
  say(`encolada: #${q.json.id} (pipeline ${pipeline}, ${branch}${allNote}) — confirmala con: az pipelines runs show --id ${q.json.id}`);
  if (notCut.length) return fail(3, `encolada, pero no pude cortar: ${notCut.join(', ')}`);
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`queue-validation: ${e.stack || e}\n`); process.exit(2); });
module.exports = { fromOrigin, identityOfOrigin, declaredPipeline, isAzure, main };
