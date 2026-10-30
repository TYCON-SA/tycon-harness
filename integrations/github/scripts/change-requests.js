'use strict';
// change-requests.js — los pedidos de cambio de un repo de GitHub (pull requests): abrir uno que entra solo
// (`change-request.open`) y los abiertos (`change-request.list`).
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
// no se pudieron leer). Una lectura que no terminó es un «no», nunca una lista vacía ni una cortada.

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

function listarPedidos(args, ctx) {
  const repo = repoDe(ctx);
  if (!repo) return no('rechazado', 'el repo no trae dueño/nombre de GitHub (team-repos.json)');
  const l = todas(ctx, `repos/${repo}/pulls?state=open`);
  if (l.problem) return l.problem;
  const value = l.value.filter((p) => p && p.state === 'open').map((p) => {
    const sha = String((p.head && p.head.sha) || '');
    return {
      number: Number(p.number),
      draft: p.draft === true,
      autoComplete: Boolean(p.auto_merge),
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

module.exports = { 'change-request.open': abrirPedido, 'change-request.list': listarPedidos, 'assigned.list': asignados };
// los ayudantes que reusa la lectura de la CI y de la cola (y la limpieza, para las pruebas), fuera del mapa de operaciones
for (const [k, v] of Object.entries({ todas, controles, repoDe, MALOS, sinSalteos })) Object.defineProperty(module.exports, k, { value: v, enumerable: false });
