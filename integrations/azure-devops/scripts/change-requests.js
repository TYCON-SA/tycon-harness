'use strict';
// change-requests.js — los pedidos de cambio activos de un repo de Azure DevOps (`change-request.list`), con lo que hace
// falta para saber si uno está trabado: borrador, auto-completar, si choca con su destino y la punta de su rama.
//
// Azure devuelve los pedidos de TODO el proyecto aunque la ruta nombre el repo (medido: 35 pedidos de 4 repos con
// `repositoryId` en la ruta y en `searchCriteria.repositoryId`): se lista el proyecto y se filtra por el nombre del
// repo, sin distinguir mayúsculas. Con `deadlineMs`, la lista de cada organización y proyecto se recuerda en el
// proceso: varios repos del mismo proyecto se leen con un solo `az`.
//
// El comando, por página (`$top=100` + `$skip`, hasta una página incompleta; tope de páginas, que es no_medido):
//   az devops invoke --area git --resource pullRequests --route-parameters project=<proyecto>
//     --query-parameters searchCriteria.status=active $top=100 $skip=<n> --api-version 7.1 --org <org> -o json
// Las páginas se pisan en un pedido (`$skip` avanza de a 99): la lista está viva, y si entre una página y la otra se
// cierra un pedido más nuevo, todo corre un lugar y el del borde no aparece en ninguna. Con el pisado, la página
// siguiente tiene que empezar por uno ya visto; si no, la lista cambió y la lectura es no_medido.
// Una lectura que no terminó es no_medido: nunca una lista vacía ni una cortada.

const { spawnSync } = require('child_process');

const POR_PAGINA = 100;
const MAX_PAGINAS = 50;
const ESTADO = { succeeded: 'clean', conflicts: 'conflict', queued: 'pending' };
const recordadas = new Map();

const no = (reason, detail) => ({ ok: false, reason, detail });

// En Windows `az` es az.cmd, que node sólo corre por la consola: cada argumento entre comillas, y sólo con caracteres
// que la consola no interpreta adentro de ellas. Un doble con ruta (TYCON_ADO_CMD) se corre directo.
const seguroEnConsola = (args) => args.every((a) => /^[\p{L}\p{N}_ .:/=$-]+$/u.test(a));
function llamadaAz(cmd, args, plataforma = process.platform) {
  if (plataforma !== 'win32' || cmd !== 'az') return { args, shell: false };
  if (!seguroEnConsola(args)) return { problem: 'az: argumentos con caracteres no seguros para la consola' };
  return { args: args.map((a) => `"${a}"`), shell: true };
}

function pagina(ctx, org, project, skip, deadlineMs) {
  const cmd = ctx.env.TYCON_ADO_CMD || 'az';
  const timeout = deadlineMs ? deadlineMs - Date.now() : 120000;
  if (timeout <= 0) return { problem: no('no_medido', 'tope: se acabó el tiempo antes de leer los pedidos') };
  const llamada = llamadaAz(cmd, ['devops', 'invoke', '--area', 'git', '--resource', 'pullRequests', '--route-parameters', `project=${project}`,
    '--query-parameters', 'searchCriteria.status=active', `$top=${POR_PAGINA}`, `$skip=${skip}`,
    '--api-version', '7.1', '--org', org, '-o', 'json']);
  if (llamada.problem) return { problem: no('no_medido', llamada.problem) };
  const r = spawnSync(cmd, llamada.args, { env: ctx.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout, killSignal: 'SIGKILL', shell: llamada.shell, windowsHide: true });
  if (r.error && r.error.code === 'ETIMEDOUT') return { problem: no('no_medido', `tope: ${cmd} tardó más de lo que había`) };
  if (r.error) return { problem: no('no_medido', `${cmd} no se pudo ejecutar (${r.error.code || r.error.message})`) };
  if (r.status !== 0) {
    const t = `${r.stderr || ''} ${r.stdout || ''}`.trim().replace(/\s+/g, ' ').slice(0, 500);
    if (/please run 'az login'|TF400813|\b(401|403) (Client Error|Unauthorized|Forbidden)\b|\bUnauthorized\b|not authorized/i.test(t)) return { problem: no('sin_credencial', `Azure DevOps no aceptó la sesión de az de esta máquina (az login, o AZURE_DEVOPS_EXT_PAT): ${t}`) };
    if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|Failed to establish a new connection|Max retries exceeded|timed out/i.test(t)) return { problem: no('red', t) };
    return { problem: no('no_medido', `az salió ${r.status}: ${t || 'sin salida'}`) };
  }
  let j;
  try { j = JSON.parse(r.stdout); } catch (_) { return { problem: no('no_medido', 'az contestó algo que no es JSON') }; }
  if (!j || !Array.isArray(j.value)) return { problem: no('no_medido', 'la respuesta no trae la lista de pedidos (value)') };
  return { value: j.value };
}

/** Todos los pedidos activos del proyecto: `{value}` o `{problem}`. */
function delProyecto(ctx, org, project, maxPaginas, deadlineMs) {
  const todos = [];
  const vistos = new Set();
  for (let i = 0; i < maxPaginas; i++) {
    const p = pagina(ctx, org, project, i * (POR_PAGINA - 1), deadlineMs);
    if (p.problem) return p;
    if (i > 0 && !(p.value[0] && vistos.has(p.value[0].pullRequestId))) {
      return { problem: no('no_medido', 'la lista de pedidos cambió mientras se leía (se cerró uno entre dos páginas)') };
    }
    for (const x of p.value) if (x) vistos.add(x.pullRequestId);
    todos.push(...p.value);
    if (p.value.length < POR_PAGINA) return { value: todos };
  }
  return { problem: no('no_medido', `tope de ${maxPaginas} páginas (unos ${maxPaginas * (POR_PAGINA - 1)} pedidos activos): la lista no se leyó entera`) };
}

function normalizar(p) {
  return {
    number: Number(p.pullRequestId),
    draft: p.isDraft === true,
    autoComplete: Boolean(p.autoCompleteSetBy),
    mergeState: ESTADO[p.mergeStatus] || 'unknown',
    sourceBranch: String(p.sourceRefName || '').replace(/^refs\/heads\//, ''),
    sourceCommit: String((p.lastMergeSourceCommit && p.lastMergeSourceCommit.commitId) || ''),
    createdAt: String(p.creationDate || ''),
    title: String(p.title || ''),
  };
}

function listarPedidos(args, ctx) {
  const repo = ctx.repo || {};
  // la organización y el proyecto salen de la identidad del repo (team-repos.json): un nombre, nunca una dirección
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(repo.org || ''))) return no('rechazado', 'el repo no trae una organización de Azure DevOps válida (un nombre)');
  if (!repo.project || !repo.repo) return no('rechazado', 'el repo de Azure DevOps no trae su proyecto y su nombre (team-repos.json)');
  const org = `https://dev.azure.com/${repo.org}`;
  const maxPaginas = Number.isInteger(args.maxPages) && args.maxPages > 0 ? args.maxPages : MAX_PAGINAS;
  const deadlineMs = Number.isFinite(args.deadlineMs) ? args.deadlineMs : null;
  const clave = deadlineMs ? `${ctx.env.TYCON_ADO_CMD || 'az'}|${org}|${String(repo.project).toLowerCase()}|${deadlineMs}|${maxPaginas}` : null;
  let leido = clave && recordadas.get(clave);
  if (!leido) {
    leido = delProyecto(ctx, org, repo.project, maxPaginas, deadlineMs);
    if (clave) recordadas.set(clave, leido);
  }
  if (leido.problem) return leido.problem;
  const nombre = String(repo.repo).toLowerCase();
  const vistos = new Set();
  const value = [];
  for (const p of leido.value) {
    if (!p || String((p.repository && p.repository.name) || '').toLowerCase() !== nombre) continue;
    // el pedido del pisado viene en dos páginas, y uno nuevo puede correr la lista hacia abajo
    if (vistos.has(p.pullRequestId)) continue;
    vistos.add(p.pullRequestId);
    value.push(normalizar(p));
  }
  return { ok: true, value };
}

module.exports = { 'change-request.list': listarPedidos };
// para las pruebas; no enumerable, así el conector no la toma por una operación
Object.defineProperty(module.exports, 'llamadaAz', { value: llamadaAz, enumerable: false });
