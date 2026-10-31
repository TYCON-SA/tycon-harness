'use strict';
// change-requests.js — los pedidos de cambio de un repo de Azure DevOps: abrir uno que entra solo (`change-request.open`)
// y los activos (`change-request.list`), con lo que hace falta para saber si uno está trabado: borrador, auto-completar,
// si choca con su destino, la punta de su rama y quién lo abrió.
//
// Abrir, con las mismas banderas que usaba el paso del merge (la organización sale de la identidad del repo; `update`
// y `show` corren dentro del clon, `repoDir`):
//   az repos pr list --org <org> --project <proyecto> --repository <repo> --source-branch <rama> --target-branch <destino>
//     --status active -o json
//   az repos pr create --org <org> --project <proyecto> --repository <repo> --source-branch <rama> --target-branch <destino>
//     --title <título> --description <texto> --auto-complete true --delete-source-branch <true|false> --squash false -o json
//   az repos pr update --id <n> [--title <título> --description <texto>] --merge-commit-message "Merged PR <n>: <asunto>"
//     --auto-complete true --squash false --delete-source-branch <true|false> -o json
//   az repos pr show --id <n> --query "{ac:autoCompleteSetBy.id, msg:completionOptions.mergeCommitMessage}" -o json
// El update lleva las cuatro opciones juntas: el create de `az` no manda `completionOptions` si ninguna opción es
// verdadera ni hay mensaje (medido con un pedido de prueba: `completionOptions: null` después del create), así que el
// `--squash false` del create no viaja; el que lo fija es el update.
// Con uno activo para el mismo par de ramas se actualiza, no se crea otro. El asunto es la primera línea sin el prefijo
// `merge: <rama> -> <destino> — ` y sin marcadores de salteo de CI: un merge con uno deja a la destino sin construir.
// Si `show` no ve el auto-completar puesto, el pedido quedaría abierto para siempre: es un «no» con su número.
// En Windows `az` pasa por la consola: el título, el texto y el mensaje van como `@archivo`, y `show` sin `--query`.
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
// Con `sourceBranch`, sólo los de esa rama: la búsqueda suma `searchCriteria.sourceRefName=refs/heads/<rama>` y lo que
// vuelve se filtra igual por la rama. Sin él, las llamadas de siempre.
// Una lectura que no terminó es no_medido: nunca una lista vacía ni una cortada.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const POR_PAGINA = 100;
const MAX_PAGINAS = 50;
const ESTADO = { succeeded: 'clean', conflicts: 'conflict', queued: 'pending' };
const recordadas = new Map();

const no = (reason, detail) => ({ ok: false, reason, detail });

// En Windows `az` es az.cmd, que node sólo corre por la consola: cada argumento entre comillas, y sólo con caracteres
// que la consola no interpreta adentro de ellas. Una barra invertida al final escaparía la comilla de cierre. Un doble
// con ruta (TYCON_ADO_CMD) se corre directo; si es un `.js`, con Node, que lo corre igual en Windows.
const seguroEnConsola = (args) => args.every((a) => /^[\p{L}\p{N}_ .:/=$@~\\-]+$/u.test(a) && !a.endsWith('\\'));
function llamadaAz(cmd, args, plataforma = process.platform) {
  if (/\.[cm]?js$/i.test(cmd)) return { file: process.execPath, args: [cmd, ...args], shell: false };
  if (plataforma !== 'win32' || cmd !== 'az') return { file: cmd, args, shell: false };
  if (!seguroEnConsola(args)) return { problem: 'az: argumentos con caracteres no seguros para la consola' };
  return { file: cmd, args: args.map((a) => `"${a}"`), shell: true };
}

/**
 * Corre az y deja su salida en JSON: `{value}` o `{problem}` con el motivo de la capa. `vacio`: lo que vale una salida
 * vacía con salida 0 (la línea de tiempo de una corrida cancelada antes de correr nada vuelve así); sin él, es «no JSON».
 */
function correrAz(ctx, args, { timeout = 120000, cwd, vacio } = {}) {
  const cmd = ctx.env.TYCON_ADO_CMD || 'az';
  const llamada = llamadaAz(cmd, args);
  if (llamada.problem) return { problem: no('no_medido', llamada.problem) };
  const r = spawnSync(llamada.file, llamada.args, { env: ctx.env, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout, killSignal: 'SIGKILL', shell: llamada.shell, windowsHide: true });
  if (r.error && r.error.code === 'ETIMEDOUT') return { problem: no('no_medido', `tope: ${cmd} tardó más de lo que había`) };
  if (r.error) return { problem: no('no_medido', `${cmd} no se pudo ejecutar (${r.error.code || r.error.message})`) };
  if (r.status !== 0) {
    const t = `${r.stderr || ''} ${r.stdout || ''}`.trim().replace(/\s+/g, ' ').slice(0, 500);
    if (/please run 'az login'|TF400813|\b(401|403) (Client Error|Unauthorized|Forbidden)\b|\bUnauthorized\b|not authorized/i.test(t)) return { problem: no('sin_credencial', `Azure DevOps no aceptó la sesión de az de esta máquina (az login, o AZURE_DEVOPS_EXT_PAT): ${t}`) };
    if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|Failed to establish a new connection|Max retries exceeded|timed out/i.test(t)) return { problem: no('red', t) };
    return { problem: no('no_medido', `az salió ${r.status}: ${t || 'sin salida'}`) };
  }
  if (vacio !== undefined && !String(r.stdout || '').trim()) return { value: vacio };
  try { return { value: JSON.parse(r.stdout) }; } catch (_) { return { problem: no('no_medido', 'az contestó algo que no es JSON') }; }
}

function pagina(ctx, org, project, skip, deadlineMs, rama) {
  const timeout = deadlineMs ? deadlineMs - Date.now() : 120000;
  if (timeout <= 0) return { problem: no('no_medido', 'tope: se acabó el tiempo antes de leer los pedidos') };
  const r = correrAz(ctx, ['devops', 'invoke', '--area', 'git', '--resource', 'pullRequests', '--route-parameters', `project=${project}`,
    '--query-parameters', 'searchCriteria.status=active', ...(rama ? [`searchCriteria.sourceRefName=refs/heads/${rama}`] : []), `$top=${POR_PAGINA}`, `$skip=${skip}`,
    '--api-version', '7.1', '--org', org, '-o', 'json'], { timeout });
  if (r.problem) return r;
  if (!r.value || !Array.isArray(r.value.value)) return { problem: no('no_medido', 'la respuesta no trae la lista de pedidos (value)') };
  return { value: r.value.value };
}

/** Todos los pedidos activos del proyecto: `{value}` o `{problem}`. */
function delProyecto(ctx, org, project, maxPaginas, deadlineMs, rama) {
  const todos = [];
  const vistos = new Set();
  for (let i = 0; i < maxPaginas; i++) {
    const p = pagina(ctx, org, project, i * (POR_PAGINA - 1), deadlineMs, rama);
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
    author: p.createdBy && p.createdBy.uniqueName ? String(p.createdBy.uniqueName).toLowerCase() : null,
    // el pedido no dice si su validación está corriendo: no se inventa
    ciRunning: null,
  };
}

/** La organización (como dirección) del repo, o el «no» si su identidad no alcanza. */
function orgDe(repo) {
  // la organización y el proyecto salen de la identidad del repo (team-repos.json): un nombre, nunca una dirección
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(repo.org || ''))) return { problem: no('rechazado', 'el repo no trae una organización de Azure DevOps válida (un nombre)') };
  if (!repo.project || !repo.repo) return { problem: no('rechazado', 'el repo de Azure DevOps no trae su proyecto y su nombre (team-repos.json)') };
  if (/^-/.test(String(repo.project)) || /^-/.test(String(repo.repo))) return { problem: no('rechazado', 'el proyecto o el repo de Azure DevOps empieza con «-» (team-repos.json): az lo tomaría como una opción') };
  return { value: `https://dev.azure.com/${repo.org}` };
}

function listarPedidos(args, ctx) {
  const repo = ctx.repo || {};
  const o = orgDe(repo);
  if (o.problem) return o.problem;
  const org = o.value;
  const maxPaginas = Number.isInteger(args.maxPages) && args.maxPages > 0 ? args.maxPages : MAX_PAGINAS;
  const deadlineMs = Number.isFinite(args.deadlineMs) ? args.deadlineMs : null;
  const rama = args.sourceBranch ? String(args.sourceBranch) : null;
  const clave = deadlineMs ? `${ctx.env.TYCON_ADO_CMD || 'az'}|${org}|${String(repo.project).toLowerCase()}|${deadlineMs}|${maxPaginas}|${rama || ''}` : null;
  let leido = clave && recordadas.get(clave);
  if (!leido) {
    leido = delProyecto(ctx, org, repo.project, maxPaginas, deadlineMs, rama);
    if (clave) recordadas.set(clave, leido);
  }
  if (leido.problem) return leido.problem;
  const nombre = String(repo.repo).toLowerCase();
  const vistos = new Set();
  const value = [];
  for (const p of leido.value) {
    if (!p || String((p.repository && p.repository.name) || '').toLowerCase() !== nombre) continue;
    if (rama && p.sourceRefName !== `refs/heads/${rama}`) continue;
    // el pedido del pisado viene en dos páginas, y uno nuevo puede correr la lista hacia abajo
    if (vistos.has(p.pullRequestId)) continue;
    vistos.add(p.pullRequestId);
    value.push(normalizar(p));
  }
  return { ok: true, value };
}

// los marcadores con que Azure (y GitHub) saltean la CI de un commit: en el asunto de un merge dejan a la destino sin construir
const SALTEOS = [/\[(skip ci|ci skip|skip azurepipelines|azurepipelines skip|skip azpipelines|azpipelines skip|skip azp|azp skip)\]/gi, /skip-checks: ?true/gi, /\*\*\*NO_CI\*\*\*/gi];

/** El asunto del commit de merge: la primera línea, sin el prefijo de un merge entre ramas y sin marcadores de salteo. */
function asunto(texto) {
  let l = String(texto || '').split('\n', 1)[0].replace(/^merge: \S+ -> \S+ — /, '');
  // hasta que no quede ninguno: sacar uno puede armar otro con lo que lo rodeaba («[sk[skip ci]ip ci]»)
  for (let antes = null; antes !== l;) { antes = l; for (const re of SALTEOS) l = l.replace(re, ''); }
  return l.replace(/ {2,}/g, ' ').trim();
}

/** Un texto para un argumento de az: en Windows, `@archivo` con el texto (la consola no lo toca); si no, el texto. */
function textoParaAz(valor, dir, nombre, plataforma = process.platform) {
  if (plataforma !== 'win32') return valor;
  const archivo = path.join(dir, `${nombre}.txt`);
  fs.writeFileSync(archivo, valor);
  return `@${archivo}`;
}

function abrirPedido(args, ctx) {
  const repo = ctx.repo || {};
  const o = orgDe(repo);
  if (o.problem) return o.problem;
  const cwd = args.repoDir || undefined;
  const texto = String(args.text).replace(/\n+$/, '');
  const titulo = args.title || texto.split('\n', 1)[0];
  const borrar = args.deleteSourceBranch ? 'true' : 'false';
  const dir = process.platform === 'win32' ? fs.mkdtempSync(path.join(os.tmpdir(), 'pedido-')) : null;
  try {
    const t = (v, n) => textoParaAz(v, dir, n);
    const lista = correrAz(ctx, ['repos', 'pr', 'list', '--org', o.value, '--project', repo.project, '--repository', repo.repo,
      '--source-branch', args.sourceBranch, '--target-branch', args.targetBranch, '--status', 'active', '-o', 'json'], { cwd });
    if (lista.problem) return lista.problem;
    if (!Array.isArray(lista.value)) return no('no_medido', 'az no devolvió la lista de pedidos abiertos');
    const previo = lista.value[0];
    let id;
    let url = '';
    if (previo) {
      id = Number(previo.pullRequestId);
      url = String(previo.url || '');
    } else {
      const c = correrAz(ctx, ['repos', 'pr', 'create', '--org', o.value, '--project', repo.project, '--repository', repo.repo,
        '--source-branch', args.sourceBranch, '--target-branch', args.targetBranch, '--title', t(titulo, 'titulo'), '--description', t(texto, 'descripcion'),
        '--auto-complete', 'true', '--delete-source-branch', borrar, '--squash', 'false', '-o', 'json'], { cwd });
      if (c.problem) return c.problem;
      id = Number(c.value && c.value.pullRequestId);
      url = String((c.value && c.value.url) || '');
    }
    if (!Number.isInteger(id) || id <= 0) return no('no_medido', 'az no devolvió el número del pedido');
    // el asunto sale del mensaje aprobado, no de un título propio del pedido
    const mensaje = `Merged PR ${id}: ${asunto(texto)}`;
    // el auto-completar va también en el update: uno abierto a mano, o con el auto-completar apagado, no lo tiene
    const u = correrAz(ctx, ['repos', 'pr', 'update', '--id', String(id),
      ...(previo ? ['--title', t(titulo, 'titulo'), '--description', t(texto, 'descripcion')] : []),
      '--merge-commit-message', t(mensaje, 'mensaje'), '--auto-complete', 'true', '--squash', 'false', '--delete-source-branch', borrar, '-o', 'json'], { cwd });
    const s = correrAz(ctx, ['repos', 'pr', 'show', '--id', String(id),
      ...(process.platform === 'win32' ? [] : ['--query', '{ac:autoCompleteSetBy.id, msg:completionOptions.mergeCommitMessage}']), '-o', 'json'], { cwd });
    if (s.problem) return no(s.problem.reason, `pedido #${id}: no pude verificar el auto-completar (${s.problem.detail})`);
    const v = s.value || {};
    const ac = 'ac' in v ? v.ac : v.autoCompleteSetBy && v.autoCompleteSetBy.id;
    const msg = 'msg' in v ? v.msg : v.completionOptions && v.completionOptions.mergeCommitMessage;
    if (!ac) return no('rechazado', `pedido #${id}: quedó abierto sin auto-completar${u.problem ? ` (${u.problem.detail})` : ''}`);
    const value = { id, url, modo: 'auto', reused: Boolean(previo) };
    if (previo && previo.mergeStatus === 'conflicts') value.conflict = true;
    // sin el mensaje el pedido entra igual, pero el merge se titula «Merge pull request N»: se dice
    if (msg !== mensaje) value.warnings = [`pedido #${id}: quedó sin mensaje de merge (entra como «Merge pull request ${id}»)`];
    return { ok: true, value };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { 'change-request.open': abrirPedido, 'change-request.list': listarPedidos };
// para las pruebas; no enumerables, así el conector no las toma por operaciones
for (const [k, v] of Object.entries({ llamadaAz, asunto, textoParaAz, correrAz, orgDe })) Object.defineProperty(module.exports, k, { value: v, enumerable: false });
