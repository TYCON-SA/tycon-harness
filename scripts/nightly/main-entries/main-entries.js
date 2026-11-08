#!/usr/bin/env node
/**
 * main-entries.js — cuántas entradas a la rama principal no pasaron por su CI, en GitHub y en Azure DevOps.
 *
 * POR QUÉ EXISTE. El freno de la sesión (regla GIT-C5) lee el texto de cada comando: no ve un guion que el agente
 * escribe y corre, un `curl` con un permiso, ni lo que alguien hace desde la web. Esto mira la plataforma, cada noche, y
 * cuenta lo que entró a la rama principal sin su CI, haya pasado o no por el freno.
 *
 * QUÉ CUENTA
 *   · github: los commits de primer padre de la rama principal que entraron en las últimas N horas sin una corrida del
 *     flujo con evento `merge_group`, rama `gh-readonly-queue/<rama>/…`, ese mismo `head_sha` y conclusión `success`.
 *     Todo commit cuenta, también un revert o un merge hecho desde la web: en un repo con cola, nada entra a la rama
 *     principal por afuera. La hora de entrada es la de su corrida de cola, nunca la fecha del commit (un commit viejo
 *     empujado hoy trae su fecha vieja). Se camina el primer padre desde la punta hasta el primer commit que entró por la
 *     cola antes de la ventana; un commit sin corrida de cola que aparece en el camino cuenta, aunque su fecha sea vieja.
 *     Lee la API por HTTPS directo, sin clon ni sesión de `gh` (`gh api` pide sesión aun para un repo público); usa
 *     GH_TOKEN o GITHUB_TOKEN si están. El primer padre se arma con los `parents` que devuelve la API; si la cadena no
 *     llega a esa frontera en lo que se leyó, esa parte es `?`.
 *   · azure: los pedidos completados a la rama principal en esas N horas con `completionOptions.bypassPolicy` cierto, y si
 *     cada compilación pedida tiene su política prendida y bloqueante en esa rama («reglas al día») o no («cambiaron»).
 *     Sólo pedidos: los empujes de la cuenta de compilación (la versión, los nocturnos) son legítimos y no cuentan.
 *
 * 🔴 No medido no es cero. Una lectura que falla (la API contesta un error, `az` sale distinto de 0 o contesta algo que
 * no es JSON) deja esa parte en `?`, y el guion sale 1. Nunca escribe 0 por lo que no leyó.
 *
 * LO QUE ESCRIBE: `--out` lleva una sola línea, sólo con números (la pega el resumen diario, que sale a un servicio de
 * afuera): `Main sin su CI (72 h): GitHub <n|?> · Azure <n|?> · reglas <al día|cambiaron|?>`. Los commits, los pedidos y
 * los motivos van a la salida estándar, que queda en el registro del pipeline.
 *
 * No nombra repos, organizaciones ni compilaciones: los recibe como argumentos.
 *
 * USO
 *   node main-entries.js github --repo <dueño>/<repo> --workflow <nombre> [--branch <rama>] \
 *                        azure --org <url> --project <p> --repo <r> --required-builds <id,id> [--branch <rama>] \
 *                        [--hours 72] [--out <archivo>]
 *   Cada parte es opcional; la que no se pide sale `?` en la línea y no cuenta para la salida.
 *   TYCON_GITHUB_API: la dirección base de la API de GitHub (por defecto https://api.github.com).
 *   TYCON_ADO_CMD: el `az` que se corre (por defecto `az`).
 *
 * SALIDA: 0 las partes pedidas se midieron · 1 alguna no se pudo consultar (la línea dice `?`) · 2 uso
 */
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

const POR_PAGINA = 100;
const MAX_PAGINAS_GH = 10;
const MAX_PAGINAS_AZ = 50;
const ESPERA_MS = 30000;

class NoSePudo extends Error {}

const recortar = (t, n = 200) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n) || '(sin salida)';
// texto de afuera antes de imprimirlo: Azure interpreta `##vso[…]` en cualquier línea del registro
const limpio = (t, n) => recortar(String(t || '').replace(/#{2,}/g, '#'), n);

// --- GitHub ------------------------------------------------------------------------------------------------------------

async function pedir(api, ruta, query = {}) {
  const u = new URL(ruta.replace(/^\//, ''), api.endsWith('/') ? api : `${api}/`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), ESPERA_MS);
  let r;
  try {
    r = await fetch(u, { signal: corte.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': 'main-entries', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  } catch (e) {
    throw new NoSePudo(`la API de GitHub no contestó (${e.name === 'AbortError' ? 'pasaron 30 s' : e.code || e.message})`);
  } finally { clearTimeout(reloj); }
  const texto = await r.text();
  if (!r.ok) throw new NoSePudo(`la API de GitHub contestó ${r.status} en ${u.pathname}: ${recortar(texto, 120)}`);
  try { return JSON.parse(texto); } catch (_) { throw new NoSePudo(`la API de GitHub contestó algo que no es JSON en ${u.pathname}`); }
}

/** `{ n, detalle }` de GitHub. Tira NoSePudo si algo no se pudo leer entero. */
async function medirGithub({ repo, workflow, branch, hours, now, api }) {
  const desde = now - hours * 3600000;
  const rama = branch || (await pedir(api, `/repos/${repo}`)).default_branch;
  if (!rama) throw new NoSePudo('la API no dijo cuál es la rama principal');
  const delFlujo = (r) => r.name === workflow || String(r.path || '').split('/').pop() === workflow;
  const deCola = (r) => r.event === 'merge_group' && delFlujo(r) && r.conclusion === 'success'
    && String(r.head_branch || '').startsWith(`gh-readonly-queue/${rama}/`);
  // la hora en que entró: cuando terminó su corrida de cola (el commit entra a la rama al terminar)
  const entro = (r) => Date.parse(r.updated_at || r.created_at);
  // las corridas de cola de la ventana, con un día de margen: una corrida empieza antes de que su commit entre
  const cola = new Map();
  const desdeCorridas = new Date(desde - 24 * 3600000).toISOString();
  for (let page = 1; ; page += 1) {
    if (page > MAX_PAGINAS_GH) throw new NoSePudo(`hay más de ${MAX_PAGINAS_GH * POR_PAGINA} ejecuciones de la cola en la ventana: no las leí todas`);
    const j = await pedir(api, `/repos/${repo}/actions/runs`, { event: 'merge_group', status: 'success', created: `>=${desdeCorridas}`, per_page: POR_PAGINA, page });
    if (!j || !Array.isArray(j.workflow_runs)) throw new NoSePudo('la lista de ejecuciones no trae workflow_runs');
    for (const r of j.workflow_runs.filter(deCola)) cola.set(r.head_sha, Math.max(cola.get(r.head_sha) || 0, entro(r)));
    if (j.workflow_runs.length < POR_PAGINA) break;
  }
  // la entrada de un commit que no está en esa lista: su corrida de cola, de cuando sea; null si no tiene
  const entradaDe = async (sha) => {
    if (cola.has(sha)) return cola.get(sha);
    const j = await pedir(api, `/repos/${repo}/actions/runs`, { event: 'merge_group', head_sha: sha, per_page: POR_PAGINA });
    if (!j || !Array.isArray(j.workflow_runs)) throw new NoSePudo('la lista de ejecuciones no trae workflow_runs');
    const propias = j.workflow_runs.filter((r) => deCola(r) && r.head_sha === sha);
    return propias.length ? Math.max(...propias.map(entro)) : null;
  };
  // los commits de la rama, de a una página, sin cortar por fecha: la fecha de un commit no dice cuándo entró
  const porSha = new Map();
  let pagina = 0;
  const otraPagina = async () => {
    pagina += 1;
    if (pagina > MAX_PAGINAS_GH) throw new NoSePudo(`la cadena de primer padre de ${rama} no llega en ${MAX_PAGINAS_GH * POR_PAGINA} commits a uno que entró por la cola antes de la ventana: no la leí entera`);
    const lista = await pedir(api, `/repos/${repo}/commits`, { sha: rama, per_page: POR_PAGINA, page: pagina });
    if (!Array.isArray(lista)) throw new NoSePudo('la lista de commits no es una lista');
    for (const c of lista) porSha.set(c.sha, c);
    return lista;
  };
  const primera = await otraPagina();
  let cur = primera[0];
  if (!cur) throw new NoSePudo('la API no devolvió ningún commit de la rama');
  const hora = (c) => Date.parse(c && c.commit && c.commit.committer && c.commit.committer.date);
  const sinCola = [];
  let vistos = 0;
  for (;;) {
    const e = await entradaDe(cur.sha);
    // la frontera: entró por la cola antes de la ventana; lo de abajo entró antes que él
    if (e !== null && e < desde) break;
    vistos += 1;
    if (e === null) sinCola.push(cur);
    const padre = cur.parents && cur.parents[0] && cur.parents[0].sha;
    if (!padre) throw new NoSePudo('la cadena de primer padre llega a la raíz sin un commit que entró por la cola antes de la ventana');
    while (!porSha.has(padre)) {
      const lista = await otraPagina();
      if (!lista.length) throw new NoSePudo('la cadena de primer padre se corta antes de la frontera de la ventana: no se leyó entera');
    }
    cur = porSha.get(padre);
  }
  const detalle = [`GitHub ${repo}: ${sinCola.length} de ${vistos} commit(s) de primer padre que entraron a ${rama} en ${hours} h sin su ejecución de la cola (${workflow})`,
    ...sinCola.map((c) => `  ${String(c.sha).slice(0, 12)} ${c.commit && c.commit.committer ? c.commit.committer.date : '?'}${hora(c) < desde ? ' (fecha vieja: entró sin cola, no se sabe a qué hora)' : ''}`)];
  return { n: sinCola.length, detalle };
}

// --- Azure DevOps ------------------------------------------------------------------------------------------------------

function az(args) {
  const cmd = process.env.TYCON_ADO_CMD || 'az';
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, env: process.env });
  if (r.error) throw new NoSePudo(`${cmd} no se pudo ejecutar (${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new NoSePudo(`az salió ${r.status}: ${recortar(r.stderr || r.stdout)}`);
  try { return JSON.parse(r.stdout); } catch (_) { throw new NoSePudo(`la respuesta de az no es JSON: ${recortar(r.stdout, 120)}`); }
}

function pedidosSalteados({ org, project, repo, branch, hours, now }) {
  const desde = now - hours * 3600000;
  const todos = [];
  for (let skip = 0, pagina = 0; ; skip += POR_PAGINA, pagina += 1) {
    if (pagina >= MAX_PAGINAS_AZ) throw new NoSePudo(`más de ${MAX_PAGINAS_AZ * POR_PAGINA} pedidos completados en la ventana: no los leí todos`);
    const j = az(['devops', 'invoke', '--area', 'git', '--resource', 'pullRequests', '--route-parameters', `project=${project}`, `repositoryId=${repo}`,
      '--query-parameters', 'searchCriteria.status=completed', `searchCriteria.targetRefName=refs/heads/${branch}`, 'searchCriteria.queryTimeRangeType=closed',
      `searchCriteria.minTime=${new Date(desde).toISOString()}`, `$top=${POR_PAGINA}`, `$skip=${skip}`, '--api-version', '7.1', '--org', org, '-o', 'json']);
    if (!j || !Array.isArray(j.value)) throw new NoSePudo('la respuesta no trae la lista de pedidos (value)');
    todos.push(...j.value);
    if (j.value.length < POR_PAGINA) break;
  }
  const salteados = todos.filter((p) => Date.parse(p.closedDate) >= desde && p.completionOptions && p.completionOptions.bypassPolicy === true);
  const detalle = [`Azure ${repo}: ${salteados.length} pedido(s) completado(s) a ${branch} en ${hours} h salteando las políticas`,
    ...salteados.map((p) => `  #${p.pullRequestId} ${limpio(p.title, 80)} (cerrado ${p.closedDate})`)];
  return { n: salteados.length, detalle };
}

function reglas({ org, project, repo, branch, builds }) {
  const r = az(['repos', 'show', '--repository', repo, '--project', project, '--org', org, '-o', 'json']);
  if (!r || !r.id) throw new NoSePudo('az no dijo el id del repo');
  const pol = az(['repos', 'policy', 'list', '--repository-id', r.id, '--branch', `refs/heads/${branch}`, '--project', project, '--org', org, '-o', 'json']);
  if (!Array.isArray(pol)) throw new NoSePudo('la lista de políticas no es una lista');
  // la de compilación es la única que nombra una definición de compilación
  const deCompilacion = (p) => p && p.settings && p.settings.buildDefinitionId !== undefined;
  const faltan = builds.filter((id) => !pol.some((p) => deCompilacion(p) && Number(p.settings && p.settings.buildDefinitionId) === id && p.isEnabled === true && p.isBlocking === true));
  return { valor: faltan.length ? 'cambiaron' : 'al día',
    detalle: [`Azure ${repo}: políticas de compilación ${faltan.length ? `que faltan, apagadas o que no bloquean: ${faltan.join(', ')}` : `al día (${builds.join(', ')})`}`] };
}

// --- la línea y el uso ---------------------------------------------------------------------------------------------------

const linea = (hours, g, a, r) => `Main sin su CI (${hours} h): GitHub ${g === null ? '?' : g} · Azure ${a === null ? '?' : a} · reglas ${r === null ? '?' : r}`;

function parseArgs(argv) {
  const a = { github: null, azure: null, hours: 72, out: null, now: null, error: null };
  let parte = null;
  const valor = (i) => (i < argv.length && !String(argv[i]).startsWith('--') ? argv[i] : (a.error = `falta el valor de ${argv[i - 1]}`, null));
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === 'github' || v === 'azure') { parte = a[v] = a[v] || {}; continue; }
    if (v === '--hours') { a.hours = Number(valor(++i)); continue; }
    if (v === '--out') { a.out = valor(++i); continue; }
    if (v === '--now') { a.now = Date.parse(valor(++i)); continue; }
    const clave = { '--repo': 'repo', '--workflow': 'workflow', '--branch': 'branch', '--org': 'org', '--project': 'project', '--required-builds': 'builds' }[v];
    if (clave && parte) { parte[clave] = valor(++i); continue; }
    a.error = a.error || `opción desconocida o fuera de su parte: ${v}`;
  }
  if (!a.error && !(Number.isInteger(a.hours) && a.hours > 0)) a.error = '--hours tiene que ser un entero mayor que 0';
  if (!a.error && a.now !== null && Number.isNaN(a.now)) a.error = '--now no es una fecha';
  if (!a.error && !a.github && !a.azure) a.error = 'falta la parte github o azure';
  if (!a.error && a.github && (!/^[\w.-]+\/[\w.-]+$/.test(a.github.repo || '') || !a.github.workflow)) a.error = 'github lleva --repo <dueño>/<repo> y --workflow <nombre>';
  if (!a.error && a.azure && (!a.azure.org || !a.azure.project || !a.azure.repo || !/^\d+(,\d+)*$/.test(a.azure.builds || ''))) a.error = 'azure lleva --org, --project, --repo y --required-builds <id,id>';
  return a;
}

async function main(argv) {
  const a = parseArgs(argv);
  if (a.error) {
    process.stderr.write(`main-entries: ${a.error}\nuso: main-entries.js github --repo <d>/<r> --workflow <n> [--branch <rama>] azure --org <url> --project <p> --repo <r> --required-builds <id,id> [--branch <rama>] [--hours 72] [--out <archivo>]\n`);
    return 2;
  }
  const now = a.now === null ? Date.now() : a.now;
  let g = null; let az1 = null; let rg = null; let fallo = false;
  const decir = (l) => process.stdout.write(`${l}\n`);
  if (a.github) {
    try {
      const r = await medirGithub({ ...a.github, hours: a.hours, now, api: process.env.TYCON_GITHUB_API || 'https://api.github.com' });
      g = r.n; r.detalle.forEach(decir);
    } catch (e) { fallo = true; decir(`GitHub: ? (no se pudo consultar: ${e instanceof NoSePudo ? e.message : `falla interna, ${e.name}`})`); }
  }
  if (a.azure) {
    const z = { ...a.azure, branch: a.azure.branch || 'main', builds: a.azure.builds.split(',').map(Number) };
    try { const r = pedidosSalteados({ ...z, hours: a.hours, now }); az1 = r.n; r.detalle.forEach(decir); } catch (e) { fallo = true; decir(`Azure: ? (no se pudo consultar: ${e instanceof NoSePudo ? e.message : `falla interna, ${e.name}`})`); }
    try { const r = reglas(z); rg = r.valor; r.detalle.forEach(decir); } catch (e) { fallo = true; decir(`reglas: ? (no se pudo consultar: ${e instanceof NoSePudo ? e.message : `falla interna, ${e.name}`})`); }
  }
  const l = linea(a.hours, g, az1, rg);
  decir(l);
  if (a.out) {
    try { fs.writeFileSync(a.out, `${l}\n`); } catch (e) { process.stderr.write(`main-entries: no pude escribir ${a.out} (${e.code || e.message})\n`); return 1; }
  }
  return fallo ? 1 : 0;
}

module.exports = { linea, parseArgs, medirGithub };

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
