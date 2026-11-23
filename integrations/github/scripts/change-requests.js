'use strict';
// change-requests.js — los pedidos de cambio de un repo de GitHub (pull requests): abrir uno que entra solo
// (`change-request.open`), los abiertos (`change-request.list`) y uno por su número, esté abierto o no
// (`change-request.read`).
//
// Abrir:
//   1. el freno de publicación lee el pedido como si fuera `gh pr create --repo … --title '<título>' --body-file <archivo>`:
//      si frena, no sale nada y el «no» no repite el texto;
//   2. con uno abierto para el mismo par de ramas se le cambia el título y el cuerpo (PATCH), si no se crea (POST);
//   3. si el repo permite la entrada automática, se la pide (GraphQL, un commit de merge) y se relee el pedido;
//   4. si no quedó puesta, se esperan los controles de la punta (sólo el que nombra `check`, si viene) y se mergea con un
//      commit de merge atado a esa punta y titulado «asunto (#N)». Un control que falla, un conflicto o un merge que
//      GitHub rechaza es un «no» con el número del pedido; los controles que no terminan en `waitMinutes` son no_medido.
// La rama no se borra desde acá: lo decide la regla del repo («borrar la rama al mergear»).
//
// Listar: los abiertos, con su autor y si la validación de su punta está corriendo (`ciRunning`: null si los controles
// no se pudieron leer). Con `sourceBranch`, además si cada uno está en la cola de merge (`inQueue`: null si no se supo). Una lectura que no terminó es un «no», nunca una lista vacía ni una cortada. Con `sourceBranch`,
// los abiertos de esa rama (por `head.ref`, también desde un fork), y cada uno se lee entero (`GET pulls/<n>`) para saber si choca con su
// destino: la lista no trae `mergeable`. Sin él, las llamadas de siempre.
// Con `queue: true` (y sin rama), una sola consulta GraphQL por cada 100: si choca, si está en la cola (`inQueue`), si
// GitHub todavía no calculó el choque (`mergeStateComputing`) y la última caída de la cola (`lastQueueDrop`: `{ cause:
// ci | conflict | timeout | other, reason, at, commit? }`, o null), sin leer los controles de cada uno (`ciRunning: null`).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { gh, no, esRepoGithub } = require('./gh-api.js');

const MAX_PAGINAS = 20;
const ESTADO = { dirty: 'conflict', clean: 'clean', unstable: 'clean', has_hooks: 'clean', blocked: 'pending', behind: 'pending', draft: 'pending' };
const MALOS = new Set(['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
// los marcadores con que una CI saltea un commit: en el asunto de un merge dejan a la destino sin construir
const SALTEOS = [/\[(skip ci|ci skip|no ci|skip actions|actions skip|skip azurepipelines|azurepipelines skip|skip azpipelines|azpipelines skip|skip azp|azp skip)\]/gi, /skip-checks: ?true/gi, /\*\*\*NO_CI\*\*\*/gi];
// hasta que no quede ninguno: sacar uno puede armar otro con lo que lo rodeaba («[sk[skip ci]ip ci]»)
function sinSalteos(t) {
  for (let antes = null; antes !== t;) { antes = t; t = SALTEOS.reduce((x, re) => x.replace(re, ''), t); }
  return t;
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** `dueño/nombre` del repo de la identidad, o null. */
function repoDe(ctx) {
  const r = ctx.repo || {};
  const id = `${r.org || ''}/${r.repo || ''}`;
  return esRepoGithub(id) ? id : null;
}

/** Recorre las páginas de una lista: `{value}` o `{problem}`. `de` saca la lista de la respuesta. */
function todas(ctx, ruta, de = (v) => v) {
  const out = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const g = gh(ctx, 'GET', `${ruta}${ruta.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (g.problem) return g;
    const l = de(g.value);
    if (!Array.isArray(l)) return { problem: no('no_medido', 'GitHub contestó una lista sin forma') };
    out.push(...l);
    if (l.length < 100) return { value: out };
  }
  return { problem: no('no_medido', `tope de ${MAX_PAGINAS} páginas: la lista no se leyó entera`) };
}

/**
 * Los controles de una punta, de las dos APIs de GitHub: los check-runs y los estados de commit (una CI que informa por
 * estados —Azure Pipelines por OAuth, Jenkins— no aparece en los check-runs). De cada contexto vale su estado más nuevo
 * por fecha (y por id, a igual fecha) cuando todos la traen; si no, el orden en que GitHub los da, del más nuevo al más viejo. Los
 * check-runs ya vienen de a uno por nombre, el último (`filter=latest`, lo de fábrica de la API). Cada estado se ve como
 * un check-run: `{ name, status, conclusion }`. Si alguna de las dos no se pudo leer es un «no»: lo que no se leyó nunca
 * es verde.
 */
function controles(ctx, repo, sha) {
  const runs = todas(ctx, `repos/${repo}/commits/${sha}/check-runs`, (v) => v && v.check_runs);
  if (runs.problem) return runs;
  const estados = todas(ctx, `repos/${repo}/commits/${sha}/statuses`);
  if (estados.problem) return estados;
  const cuando = (s) => { const t = Date.parse((s && (s.updated_at || s.created_at)) || ''); return Number.isNaN(t) ? null : t; };
  const conFecha = estados.value.every((s) => cuando(s) !== null);
  const id = (s) => (Number.isFinite(Number(s && s.id)) ? Number(s.id) : 0);
  const ordenados = conFecha
    ? estados.value.map((s, i) => ({ s, i })).sort((a, b) => (cuando(b.s) - cuando(a.s)) || (id(b.s) - id(a.s)) || (a.i - b.i)).map((x) => x.s)
    : estados.value;
  const vistos = new Set();
  const comoRun = [];
  for (const s of ordenados) {
    if (!s || typeof s.context !== 'string' || vistos.has(s.context)) continue;
    vistos.add(s.context);
    comoRun.push(s.state === 'pending'
      ? { name: s.context, status: 'in_progress', conclusion: null }
      : { name: s.context, status: 'completed', conclusion: s.state === 'success' ? 'success' : (s.state === 'error' ? 'error' : 'failure') });
  }
  return { value: [...runs.value, ...comoRun] };
}

/** El freno de publicación sobre el pedido, antes de que salga: null si pasa, o el «no». */
function frenoDePublicacion(ctx, repo, args, titulo, texto) {
  let guard;
  try { guard = require(path.join(ctx.root, 'scripts', 'hooks', 'public-push-guard.js')); } catch (e) {
    return no('no_medido', `no pude cargar el freno de publicación (${(e && e.code) || 'error'}): el pedido no sale sin pasar por él`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedido-'));
  try {
    const cuerpo = path.join(dir, 'cuerpo.md');
    fs.writeFileSync(cuerpo, texto);
    const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    const cmd = `gh pr create --repo ${q(repo)} --base ${q(args.targetBranch)} --head ${q(args.sourceBranch)} --title ${q(titulo)} --body-file ${q(cuerpo)}`;
    const r = guard.reviewGhCommand(cmd, { cwd: args.repoDir || process.cwd(), env: ctx.env });
    return r && r.code === 2 ? no('rechazado', 'el freno de publicación no deja salir este pedido: corregí el título o el texto (correr el freno a mano dice dónde está el problema)') : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function abrirPedido(args, ctx) {
  const repo = repoDe(ctx);
  if (!repo) return no('rechazado', 'el repo no trae dueño/nombre de GitHub (team-repos.json)');
  const texto = String(args.text).replace(/\n+$/, '');
  const titulo = args.title || texto.split('\n', 1)[0];
  const frenado = frenoDePublicacion(ctx, repo, args, titulo, texto);
  if (frenado) return frenado;

  const owner = repo.split('/')[0];
  const abiertos = () => gh(ctx, 'GET', `repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${args.sourceBranch}`)}&base=${encodeURIComponent(args.targetBranch)}&state=open&per_page=100`);
  const deLaRama = (lista) => (Array.isArray(lista) ? lista : []).find((p) => p && p.head && p.head.ref === args.sourceBranch && (!p.base || !p.base.ref || p.base.ref === args.targetBranch));
  const l = abiertos();
  if (l.problem) return l.problem;
  const previo = deLaRama(l.value);
  const escrito = previo
    ? gh(ctx, 'PATCH', `repos/${repo}/pulls/${previo.number}`, { title: titulo, body: texto })
    : gh(ctx, 'POST', `repos/${repo}/pulls`, { title: titulo, body: texto, head: args.sourceBranch, base: args.targetBranch });
  if (escrito.problem) return previo ? no(escrito.problem.reason, `pedido #${previo.number}: ${escrito.problem.detail}`) : escrito.problem;
  let pr = escrito.value || previo;
  // creado, pero su respuesta no se pudo leer: se busca por su rama antes de decir que no hay número
  if (!previo && !(Number(pr && pr.number) > 0)) {
    const otra = abiertos();
    pr = (!otra.problem && deLaRama(otra.value)) || pr;
  }
  const n = Number(pr && pr.number);
  if (!Number.isInteger(n) || n <= 0) return no('no_medido', 'GitHub no devolvió el número del pedido');
  const base = { id: n, url: String(pr.html_url || `https://github.com/${repo}/pull/${n}`), reused: Boolean(previo) };
  const warnings = [];

  // la entrada automática, si el repo la permite: GitHub mergea solo cuando los controles que exige la regla dan verde
  // la red caída después de abrir es `red`, con el pedido: seguir esperando sin red sólo demoraría el mismo «no»
  const r = gh(ctx, 'GET', `repos/${repo}`);
  if (r.problem && r.problem.reason === 'red') return no('red', `pedido #${n}: no pude leer el repo (${r.problem.detail})`);
  if (r.value && r.value.allow_auto_merge === true) {
    const q = gh(ctx, 'POST', 'graphql', {
      query: 'mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) { pullRequest { number } } }',
      variables: { pullRequestId: pr.node_id, mergeMethod: 'MERGE' },
    });
    if (q.problem && q.problem.reason === 'red') return no('red', `pedido #${n}: no pude pedir la entrada automática (${q.problem.detail})`);
    const v = gh(ctx, 'GET', `repos/${repo}/pulls/${n}`);
    // sin releerlo no se sabe si la entrada automática quedó puesta: mergearlo a mano encima sería adivinar
    if (v.problem) return no(v.problem.reason, `pedido #${n}: no pude releerlo después de pedir la entrada automática (${v.problem.detail})`);
    if (!q.problem && v.value && v.value.auto_merge) {
      return { ok: true, value: { ...base, modo: 'auto', merged: false, ...(v.value.mergeable === false ? { conflict: true } : {}), warnings } };
    }
    warnings.push(`pedido #${n}: GitHub no dejó puesta la entrada automática (${q.problem ? q.problem.detail : 'sin efecto: la regla de la rama no exige controles'}); se esperan los controles y se mergea`);
  } else if (r.problem && r.problem.reason !== 'no_encontrado') warnings.push(`no pude leer si el repo permite la entrada automática (${r.problem.detail}); se esperan los controles y se mergea`);

  // sin entrada automática: esperar los controles de la punta y mergear esa punta
  const espera = Number.isFinite(args.waitMinutes) ? args.waitMinutes : 30;
  const cada = Number.isFinite(args.pollSeconds) ? args.pollSeconds : 30;
  const tope = Date.now() + espera * 60000;
  for (;;) {
    const p = gh(ctx, 'GET', `repos/${repo}/pulls/${n}`);
    if (p.problem) return no(p.problem.reason, `pedido #${n}: ${p.problem.detail}`);
    if (p.value.state && p.value.state !== 'open') return p.value.merged ? { ok: true, value: { ...base, modo: 'espera-y-mergea', merged: true, warnings } } : no('rechazado', `pedido #${n}: ya no está abierto`);
    if (p.value.mergeable === false) return no('rechazado', `pedido #${n}: tiene conflicto con ${args.targetBranch}`);
    const sha = String((p.value.head && p.value.head.sha) || '');
    const c = controles(ctx, repo, sha);
    if (c.problem) return no(c.problem.reason, `pedido #${n}: no pude leer sus controles (${c.problem.detail})`);
    const cuentan = c.value.filter((x) => x && (!args.check || x.name === args.check));
    const malo = cuentan.find((x) => x.status === 'completed' && MALOS.has(x.conclusion));
    if (malo) return no('rechazado', `pedido #${n}: el control ${malo.name} terminó en ${malo.conclusion}`);
    if (cuentan.length && cuentan.every((x) => x.status === 'completed') && p.value.mergeable !== null) {
      const [asunto, ...resto] = sinSalteos(texto).split('\n');
      const m = gh(ctx, 'PUT', `repos/${repo}/pulls/${n}/merge`, {
        merge_method: 'merge', sha,
        commit_title: `${asunto.replace(/^merge: \S+ -> \S+ — /, '').replace(/ {2,}/g, ' ').trim()} (#${n})`,
        commit_message: resto.join('\n').trim(),
      });
      if (m.problem) return no(m.problem.reason === 'red' ? 'red' : 'rechazado', `pedido #${n}: GitHub no lo mergeó (${m.problem.detail})`);
      return { ok: true, value: { ...base, modo: 'espera-y-mergea', merged: true, warnings } };
    }
    if (Date.now() >= tope) {
      const falta = args.check && !cuentan.length ? `el control ${args.check} no apareció` : 'el control no terminó';
      return no('no_medido', `pedido #${n}: ${falta} en ${espera} min; queda abierto`);
    }
    await esperar(cada * 1000);
  }
}

/** Si la validación de una punta está corriendo: true, false, o null si los controles no se pudieron leer. */
function corriendo(ctx, repo, sha) {
  if (!sha) return null;
  const c = controles(ctx, repo, sha);
  return c.problem ? null : c.value.some((x) => x && x.status !== 'completed');
}

/**
 * Si cada pedido está en la cola de merge, de una sola consulta (la API REST no lo dice): un mapa node_id → true/false.
 * Lo que no se pudo leer no entra al mapa: queda como no sabido, nunca como «fuera de la cola».
 */
function enCola(ctx, prs) {
  const ids = prs.map((p) => String((p && p.node_id) || '')).filter(Boolean);
  const out = new Map();
  if (!ids.length) return out;
  const g = gh(ctx, 'POST', 'graphql', {
    query: 'query($ids:[ID!]!){nodes(ids:$ids){... on PullRequest{id mergeQueueEntry{state}}}}',
    variables: { ids },
  });
  const nodes = g.value && g.value.data && Array.isArray(g.value.data.nodes) ? g.value.data.nodes : [];
  for (const n of nodes) if (n && typeof n.id === 'string' && 'mergeQueueEntry' in n) out.set(n.id, Boolean(n.mergeQueueEntry));
  return out;
}

// Los abiertos con su lugar en la cola y su última caída, de a POR_PAGINA por consulta. La caída es el último evento que
// lo sacó de la cola o le apagó el auto-merge. Cada pedido trae sus reglas y sus controles, y GitHub corta una consulta
// que pasa los 10 s con un 502 o un 504: con unos 110 pedidos abiertos, de a 100 corta siempre, de a 50 a veces y de a 25
// una página ya tarda 7 s. Por eso de a 20, y una página que corta se pide otra vez con la mitad, hasta MIN_POR_PAGINA.
const POR_PAGINA = 20;
const MIN_POR_PAGINA = 5;
// las consultas de una lectura, contando los reintentos: con páginas de 20 alcanza para más de mil pedidos
const MAX_CONSULTAS = 60;
const CONSULTA_ABIERTOS = 'query($owner:String!,$name:String!,$after:String,$first:Int!){repository(owner:$owner,name:$name){'
  + 'pullRequests(states:OPEN,first:$first,after:$after){pageInfo{hasNextPage endCursor} nodes{number isDraft mergeable '
  + 'id reviewDecision baseRefName baseRef{branchProtectionRule{requiredStatusCheckContexts} rules(first:100){totalCount nodes{type parameters{__typename ... on RequiredStatusChecksParameters{requiredStatusChecks{context}}}}}} commits(last:1){nodes{commit{committedDate statusCheckRollup{state contexts(first:100){totalCount '
  + 'nodes{__typename ... on CheckRun{name status conclusion checkSuite{app{slug}}}}}}}}} '
  + 'mergeStateStatus headRefName headRefOid createdAt title author{login} autoMergeRequest{enabledAt} mergeQueueEntry{state} '
  + 'timelineItems(last:1,itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT,AUTO_MERGE_DISABLED_EVENT]){nodes{__typename '
  + '... on RemovedFromMergeQueueEvent{reason createdAt beforeCommit{oid parents(first:3){nodes{oid}}}} ... on AutoMergeDisabledEvent{reason reasonCode createdAt}}} '
  + 'empujes:timelineItems(last:1,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){nodes{... on HeadRefForcePushedEvent{createdAt}}}}}}}';

/**
 * La causa de una caída: `ci` (controles en rojo), `conflict` (choca con su destino), `timeout` (la cola venció esperando
 * sus controles) u `other`. GitHub dice `failed_checks`, `merge_conflict`, `checks_timed_out`, `manual`,
 * `invalid_merge_commit`; un auto-merge apagado, su `reasonCode`.
 */
function causaDeCaida(motivo) {
  if (/conflict/i.test(motivo)) return 'conflict';
  if (/timed?_?out/i.test(motivo)) return 'timeout';
  if (/check|fail/i.test(motivo)) return 'ci';
  return 'other';
}

/**
 * La punta del pedido cuando la cola lo sacó, o null. `beforeCommit` NO es esa punta: es el merge que armó la cola (la
 * destino con el pedido), y la punta es su segundo padre. Sin un merge de exactamente dos padres (un choque o una salida a
 * mano no lo traen, y una cola que aplasta los commits arma uno de un padre) no se sabe.
 */
function puntaAlCaer(ev) {
  const padres = ev && ev.beforeCommit && ev.beforeCommit.parents && Array.isArray(ev.beforeCommit.parents.nodes) ? ev.beforeCommit.parents.nodes : [];
  return padres.length === 2 && padres[1] && padres[1].oid ? String(padres[1].oid) : null;
}

function deGraphql(p) {
  const ev = p.timelineItems && Array.isArray(p.timelineItems.nodes) ? p.timelineItems.nodes[0] : null;
  const motivo = ev ? String(ev.reasonCode || ev.reason || '') : '';
  const punta = p.commits && Array.isArray(p.commits.nodes) && p.commits.nodes[0] ? p.commits.nodes[0].commit : null;
  const empuje = p.empujes && Array.isArray(p.empujes.nodes) ? p.empujes.nodes[0] : null;
  return {
    number: Number(p.number),
    draft: p.isDraft === true,
    autoComplete: Boolean(p.autoMergeRequest),
    inQueue: Boolean(p.mergeQueueEntry),
    mergeState: p.mergeable === 'CONFLICTING' ? 'conflict' : ESTADO[String(p.mergeStateStatus || '').toLowerCase()] || 'unknown',
    // GitHub calcula si choca recién cuando alguien lo pregunta: UNKNOWN es «todavía no lo sé», no un estado
    mergeStateComputing: p.mergeable === 'UNKNOWN',
    sourceBranch: String(p.headRefName || ''),
    sourceCommit: String(p.headRefOid || ''),
    createdAt: String(p.createdAt || ''),
    title: String(p.title || ''),
    author: p.author && p.author.login ? String(p.author.login).toLowerCase() : null,
    ciRunning: null,
    // `commit`: la punta que tenía cuando la cola lo sacó, sólo cuando se sabe (`puntaAlCaer`)
    lastQueueDrop: ev ? { cause: causaDeCaida(motivo), reason: motivo, at: String(ev.createdAt || ''),
      ...(puntaAlCaer(ev) ? { commit: puntaAlCaer(ev) } : {}) } : null,
    // para re-encolar el que quedó afuera después de un empuje: su identificador, la aprobación, el estado tal cual
    // (`unstable` ya cuenta como limpio arriba), las comprobaciones de la punta, cuándo se hizo la punta y desde cuándo
    // tiene el auto-merge
    nodeId: String(p.id || ''),
    reviewDecision: p.reviewDecision || null,
    mergeStatus: String(p.mergeStateStatus || '').toUpperCase(),
    ciState: punta && punta.statusCheckRollup ? String(punta.statusCheckRollup.state || '') : null,
    headCommittedAt: punta ? String(punta.committedDate || '') : '',
    headPushedAt: empuje ? String(empuje.createdAt || '') : '',
    autoMergeSince: p.autoMergeRequest ? String(p.autoMergeRequest.enabledAt || '') : null,
    baseBranch: String(p.baseRefName || ''),
    // si la regla de la rama destino exige los resultados del análisis: viene en la misma consulta
    _exige: exigeElAnalisis(p.baseRef),
    // lo cuenta `analisisDe` y se saca antes de devolver el pedido
    _rollup: punta && punta.statusCheckRollup ? punta.statusCheckRollup.contexts || null : null,
  };
}

// EL ANÁLISIS DE SEGURIDAD (code scanning). GitHub informa cada análisis con un control de la app
// `github-advanced-security`, y ese control no es requerido salvo que la regla de la rama lo pida: sin él, el estado
// del pedido (`mergeStateStatus`) sale CLEAN o UNSTABLE con el análisis en rojo o sin correr, y la cola lo deja entrar.
// Por eso el pedido lleva su propio `codeScanning`: `{ estado, motivo }`, con estado
//   verde        el control está en la punta, terminó en success y el pedido no tiene alertas abiertas
//   rojo         el control falló, o el pedido tiene alertas abiertas
//   corriendo    el control está en la punta y todavía no terminó
//   falta        el repo tiene análisis y la punta no tiene su control (no corrió)
//   no-aplica    el repo no tiene análisis de seguridad
//   no-se-pudo   algo no se pudo leer: nunca es verde
//   sin-mirar    un borrador o uno en choque: no se lee hasta que pueda entrar
// y `codeScanningRequired` (true, false o null si no se supo): si la regla de la rama destino exige sus resultados.
const APP_DEL_ANALISIS = 'github-advanced-security';
// el nombre del control que deja la configuración automática de GitHub: exigido como control requerido, también cuenta
const CONTROL_DEL_ANALISIS = 'CodeQL';

/**
 * Si la rama destino exige el análisis: por la regla de code scanning, o con su control entre los requeridos (de una
 * regla o de la protección clásica). true, false, o null si no se supo (sin rama, o la lista de reglas cortada).
 */
function exigeElAnalisis(ref) {
  if (!ref || !ref.rules || !Array.isArray(ref.rules.nodes) || Number(ref.rules.totalCount) > ref.rules.nodes.length) return null;
  const requeridos = new Set(ref.branchProtectionRule && Array.isArray(ref.branchProtectionRule.requiredStatusCheckContexts) ? ref.branchProtectionRule.requiredStatusCheckContexts : []);
  for (const r of ref.rules.nodes) {
    if (r && r.type === 'CODE_SCANNING') return true;
    const checks = r && r.parameters && Array.isArray(r.parameters.requiredStatusChecks) ? r.parameters.requiredStatusChecks : [];
    for (const c of checks) if (c && c.context) requeridos.add(c.context);
  }
  return requeridos.has(CONTROL_DEL_ANALISIS);
}

/** Si el repo tiene análisis de seguridad: `{ hay: true|false }` o `{ problema }`. */
function analisisDelRepo(ctx, repo, llamar = gh) {
  const d = llamar(ctx, 'GET', `repos/${repo}/code-scanning/default-setup`);
  if (!d.problem && d.value && d.value.state === 'configured') return { hay: true };
  // la configuración avanzada (un flujo propio) no aparece ahí: alcanza con que haya un análisis subido
  const a = llamar(ctx, 'GET', `repos/${repo}/code-scanning/analyses?per_page=1`);
  if (!a.problem) return { hay: Array.isArray(a.value) && a.value.length > 0 };
  // GitHub contesta 404 o 403 «no habilitado» cuando el repo no tiene análisis: eso es no-aplica, no un error
  const texto = String((a.problem && a.problem.detail) || '');
  // un 404 cualquiera no alcanza: también lo da una credencial que no ve los análisis
  if (/no analysis found|not enabled|advanced security must be enabled/i.test(texto)) return { hay: false };
  return { problema: `no pude saber si el repo tiene análisis de seguridad (${texto.slice(0, 120)})` };
}

/** El análisis de un pedido, de los controles de su punta y de sus alertas abiertas. */
function analisisDelPedido(ctx, repo, p, rollup, llamar = gh, { conAlertas = true, sinTiempo = false } = {}) {
  if (!rollup || !Array.isArray(rollup.nodes)) return { estado: 'no-se-pudo', motivo: 'GitHub no dio los controles de la punta' };
  if (Number(rollup.totalCount) > rollup.nodes.length) return { estado: 'no-se-pudo', motivo: `la punta tiene ${rollup.totalCount} controles y se leyeron ${rollup.nodes.length}` };
  const suyos = rollup.nodes.filter((n) => n && n.__typename === 'CheckRun' && n.checkSuite && n.checkSuite.app && n.checkSuite.app.slug === APP_DEL_ANALISIS);
  if (!suyos.length) return { estado: 'falta', motivo: 'el análisis de seguridad no corrió (o todavía no empezó) en la punta' };
  if (suyos.some((n) => String(n.status || '').toUpperCase() !== 'COMPLETED')) return { estado: 'corriendo', motivo: 'el análisis de seguridad todavía corre' };
  const malo = suyos.find((n) => String(n.conclusion || '').toUpperCase() !== 'SUCCESS');
  if (malo) return { estado: 'rojo', motivo: `el análisis de seguridad terminó en ${String(malo.conclusion || 'sin resultado').toLowerCase()}` };
  if (!conAlertas) return { estado: 'sin-mirar', motivo: 'sus alertas no se leen hasta que pueda entrar' };
  if (sinTiempo) return { estado: 'no-se-pudo', motivo: 'no hubo tiempo de leer sus alertas en esta lectura' };
  // las dos referencias del pedido: un análisis anota en la fusión de prueba (/merge) y otro en la punta (/head); una
  // alerta anotada sólo en la punta entró a main con este control en verde
  const abiertas = new Map();
  let cien = false;
  for (const ref of ['merge', 'head']) {
    const alertas = llamar(ctx, 'GET', `repos/${repo}/code-scanning/alerts?ref=${encodeURIComponent(`refs/pull/${p.number}/${ref}`)}&state=open&per_page=100`);
    if (alertas.problem || !Array.isArray(alertas.value)) return { estado: 'no-se-pudo', motivo: 'no pude leer las alertas abiertas del pedido' };
    if (alertas.value.length === 100) cien = true;
    for (const a of alertas.value) abiertas.set(a && a.number != null ? a.number : `${ref}-${abiertas.size}`, a);
  }
  if (abiertas.size) return { estado: 'rojo', motivo: `${cien ? '100 o más' : abiertas.size} alerta(s) del análisis de seguridad abierta(s)` };
  return { estado: 'verde', motivo: null };
}

/** Le pone a cada pedido su `codeScanning` y su `codeScanningRequired`, y le saca lo que se leyó para eso. */
function conAnalisis(ctx, repo, pedidos, llamar = gh, { hasta = Infinity, ahora = Date.now } = {}) {
  // una lectura por repo, y sólo si hay un pedido que no sea borrador; la regla de la rama vino en la consulta
  const delRepo = !pedidos.some((p) => !p.draft) ? { hay: false }
    : ahora() > hasta ? { problema: 'no hubo tiempo de saber si el repo tiene análisis de seguridad' } : analisisDelRepo(ctx, repo, llamar);
  for (const p of pedidos) {
    const rollup = p._rollup;
    const exige = p._exige;
    delete p._rollup;
    delete p._exige;
    if (delRepo.problema) p.codeScanning = { estado: 'no-se-pudo', motivo: delRepo.problema };
    else if (!delRepo.hay) p.codeScanning = { estado: 'no-aplica', motivo: null };
    else if (p.draft) p.codeScanning = { estado: 'sin-mirar', motivo: 'no se mira hasta que pueda entrar' };
    // las alertas (una lectura por pedido) sólo para el que podría estar listo: limpio y fuera de la cola
    // pasado el tope de la lectura no se lee nada más: lo que quedó sin leer nunca es verde
    else p.codeScanning = analisisDelPedido(ctx, repo, p, rollup, llamar, { conAlertas: p.mergeState === 'clean' && p.inQueue !== true, sinTiempo: ahora() > hasta });
    p.codeScanningRequired = delRepo.hay ? exige : null;
  }
  return pedidos;
}

/** Con `queue: true` y sin rama: los abiertos de una sola consulta GraphQL, sin leer los controles de cada uno. */
function listaConCola(ctx, repo, deadlineMs) {
  const desde = Date.now();
  const [owner, name] = repo.split('/');
  const value = [];
  let after = null;
  let first = POR_PAGINA;
  for (let consulta = 1; consulta <= MAX_CONSULTAS; consulta++) {
    const g = gh(ctx, 'POST', 'graphql', { query: CONSULTA_ABIERTOS, variables: { owner, name, after, first } });
    // GitHub cortó por tiempo: la misma página con la mitad; ni de a MIN_POR_PAGINA, no se pudo leer
    if (cortoPorTiempo(g)) {
      if (first <= MIN_POR_PAGINA) return no('no_medido', `GitHub cortó por tiempo la lista de pedidos abiertos aun de a ${first}: ${detalleDe(g)}`);
      first = Math.max(MIN_POR_PAGINA, Math.floor(first / 2));
      continue;
    }
    if (g.problem) return g.problem;
    const prs = g.value && g.value.data && g.value.data.repository && g.value.data.repository.pullRequests;
    if (!prs || !Array.isArray(prs.nodes)) return no('no_medido', 'GitHub contestó los pedidos abiertos sin forma');
    for (const p of prs.nodes) if (p && Number.isInteger(p.number)) value.push(deGraphql(p));
    if (!prs.pageInfo || !prs.pageInfo.hasNextPage) return { ok: true, value: conAnalisis(ctx, repo, value, gh, { hasta: Number(deadlineMs) > 0 ? desde + Number(deadlineMs) * 0.8 : Infinity }) };
    after = prs.pageInfo.endCursor;
  }
  return no('no_medido', `tope de ${MAX_CONSULTAS} consultas: la lista no se leyó entera`);
}

// El corte por tiempo de GitHub: un 502, 503 o 504 de la puerta de entrada, o la respuesta de GraphQL que dice que la
// consulta se pasó de tiempo (llega con 200 y sin datos)
function cortoPorTiempo(g) {
  if (g.problem) return /HTTP 50[234]\b/.test(String(g.problem.detail || ''));
  const errores = g.value && Array.isArray(g.value.errors) ? g.value.errors : [];
  return !(g.value && g.value.data && g.value.data.repository) && errores.some((e) => /timeout|timed out/i.test(String(e && e.message)));
}
const detalleDe = (g) => String(g.problem ? g.problem.detail : JSON.stringify(g.value && g.value.errors)).slice(0, 200);

/**
 * Un pedido por su número, abierto o cerrado: `{ number, state: open|merged|closed, draft, autoComplete, inQueue, mergedAt,
 * mergeCommit, title }`. Uno que no existe es no_encontrado, nunca «entró».
 */
function leerPedido(args, ctx) {
  const repo = repoDe(ctx);
  if (!repo) return no('rechazado', 'el repo no trae dueño/nombre de GitHub (team-repos.json)');
  const n = Number(args && args.number);
  if (!Number.isInteger(n) || n <= 0) return no('rechazado', `el número del pedido no se puede leer: ${JSON.stringify(args && args.number)}`);
  const g = gh(ctx, 'GET', `repos/${repo}/pulls/${n}`);
  if (g.problem) return g.problem;
  const p = g.value;
  if (!p || typeof p !== 'object' || Number(p.number) !== n) return no('no_medido', `GitHub contestó el pedido #${n} sin forma`);
  const abierto = p.state === 'open';
  const cola = abierto ? enCola(ctx, [p]) : new Map();
  return {
    ok: true,
    value: {
      number: n,
      state: abierto ? 'open' : p.merged_at ? 'merged' : 'closed',
      draft: p.draft === true,
      autoComplete: Boolean(p.auto_merge),
      // null: GitHub no lo dijo (quien lee no lo toma por «fuera de la cola»)
      inQueue: abierto ? (cola.has(String(p.node_id)) ? cola.get(String(p.node_id)) : null) : false,
      mergedAt: p.merged_at ? String(p.merged_at) : null,
      // GitHub da `merge_commit_sha` también con el pedido abierto (el commit de prueba): sólo vale el de uno que entró
      mergeCommit: p.merged_at && /^[0-9a-f]{40}$/i.test(String(p.merge_commit_sha || '')) ? String(p.merge_commit_sha).toLowerCase() : null,
      title: String(p.title || ''),
      // la rama de origen; null si GitHub no la dio
      sourceBranch: p.head && typeof p.head.ref === 'string' && p.head.ref ? p.head.ref : null,
    },
  };
}

function listarPedidos(args, ctx) {
  const repo = repoDe(ctx);
  if (!repo) return no('rechazado', 'el repo no trae dueño/nombre de GitHub (team-repos.json)');
  if (args.queue === true && !args.sourceBranch) return listaConCola(ctx, repo, args.deadlineMs);
  // con `sourceBranch`, los abiertos de esa rama, cada uno leído entero: la lista de GitHub no trae `mergeable`. Se
  // filtra por `head.ref` y no con `head=<dueño>:<rama>`: con un repo transferido o una organización renombrada, el
  // dueño del origin es el viejo y GitHub contesta ese filtro con una lista vacía, sin error (la sesión saldría libre);
  // así entran también los abiertos desde un fork con esa rama
  const rama = args.sourceBranch ? String(args.sourceBranch) : null;
  const l = todas(ctx, `repos/${repo}/pulls?state=open`);
  if (l.problem) return l.problem;
  let abiertos = l.value.filter((p) => p && p.state === 'open');
  if (rama) {
    const enteros = [];
    for (const p of abiertos.filter((x) => x.head && x.head.ref === rama)) {
      const g = gh(ctx, 'GET', `repos/${repo}/pulls/${Number(p.number)}`);
      if (g.problem) return g.problem;
      if (!g.value || typeof g.value !== 'object') return no('no_medido', `GitHub contestó el pedido #${p.number} sin forma`);
      enteros.push(g.value);
    }
    abiertos = enteros;
  }
  const cola = rama ? enCola(ctx, abiertos) : null;
  const value = abiertos.map((p) => {
    const sha = String((p.head && p.head.sha) || '');
    return {
      number: Number(p.number),
      draft: p.draft === true,
      autoComplete: Boolean(p.auto_merge),
      // con la rama: si está en la cola de merge (null si GitHub no lo dijo). Uno en la cola puede no tener auto_merge
      ...(cola ? { inQueue: cola.has(String(p.node_id)) ? cola.get(String(p.node_id)) : null } : {}),
      mergeState: p.mergeable === false ? 'conflict' : ESTADO[p.mergeable_state] || 'unknown',
      sourceBranch: String((p.head && p.head.ref) || ''),
      sourceCommit: sha,
      createdAt: String(p.created_at || ''),
      title: String(p.title || ''),
      author: p.user && p.user.login ? String(p.user.login).toLowerCase() : null,
      // `checks: false`: quien sólo cuenta pedidos no paga una lectura de controles por cada uno
      ciRunning: args.checks === false ? null : corriendo(ctx, repo, sha),
    };
  });
  return { ok: true, value };
}

/** Los issues y pull requests abiertos con alguien asignado: una fila por persona. */
function asignados(args, ctx) {
  const repo = repoDe(ctx);
  if (!repo) return no('rechazado', 'el repo no trae dueño/nombre de GitHub (team-repos.json)');
  const l = todas(ctx, `repos/${repo}/issues?state=open`);
  if (l.problem) return l.problem;
  const value = [];
  for (const i of l.value) {
    if (!i || i.state !== 'open') continue;
    for (const a of Array.isArray(i.assignees) ? i.assignees : []) {
      if (!a || !a.login) continue;
      value.push({ tipo: i.pull_request ? 'pull request' : 'issue', id: Number(i.number), titulo: String(i.title || ''), estado: 'open', asignado: String(a.login).toLowerCase(), enlace: String(i.html_url || '') });
    }
  }
  return { ok: true, value };
}

module.exports = { 'change-request.open': abrirPedido, 'change-request.list': listarPedidos, 'change-request.read': leerPedido, 'assigned.list': asignados };
// los ayudantes que reusa la lectura de la CI y de la cola (y la limpieza, para las pruebas), fuera del mapa de operaciones
for (const [k, v] of Object.entries({ todas, controles, repoDe, MALOS, sinSalteos, deGraphql, conAnalisis })) Object.defineProperty(module.exports, k, { value: v, enumerable: false });
