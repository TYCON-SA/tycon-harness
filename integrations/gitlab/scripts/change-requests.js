'use strict';
// change-requests.js — los pedidos de cambio de un repo de GitLab (merge requests): abrir uno que entra solo
// (`change-request.open`), aprobarlo (`change-request.vote`), los abiertos (`change-request.list`), uno por su número
// (`change-request.read`) y lo asignado (`assigned.list`).
//
// Abrir:
//   1. el freno de publicación lee el título y el texto antes de que salgan: si frena, no sale nada;
//   2. con uno abierto para el mismo par de ramas se le cambian el título y el texto, si no se crea; en los dos casos con
//      el borrado de la rama que se pidió;
//   3. si choca con su destino, vuelve con `conflict: true` y no se pide la entrada;
//   4. con un pipeline corriendo en la punta, se pide la entrada automática: GitLab lo mergea cuando el pipeline da verde;
//   5. sin pipeline, se esperan los estados de commit de la punta (sólo el que nombra `check`, si viene) y se mergea
//      atado a esa punta. Un estado que falla o un merge que GitLab rechaza es un «no» con el número del pedido; los que
//      no terminan en `waitMinutes` son no_medido.
// Siempre con commit de merge: nunca aplastado.
//
// Listar: los abiertos, con su autor y si la validación de su punta está corriendo (`ciRunning`: null si los estados no
// se pudieron leer). Una lectura que no terminó es un «no», nunca una lista vacía ni una cortada.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { glab, todas, no, servidorDe, projectPath } = require('./glab-api.js');

// Los estados de commit que todavía no terminaron, y los que terminaron mal. Un trabajo manual queda en `manual` hasta
// que alguien lo dispare, con el pipeline ya en verde: no es uno en curso. Y uno que GitLab deja fallar
// (`allow_failure`) no pone en rojo a su pipeline: tampoco a la punta.
const EN_CURSO = new Set(['created', 'pending', 'running', 'waiting_for_resource', 'preparing', 'scheduled']);
const MALOS = new Set(['failed', 'canceled']);
const sinTerminar = (s) => EN_CURSO.has(s.status);
const terminoMal = (s) => MALOS.has(s.status) && s.allowFailure !== true;
// mientras GitLab calcula si el pedido choca con su destino, todavía no se sabe
const CALCULANDO = new Set(['unchecked', 'checking', 'preparing', 'approvals_syncing']);
// los marcadores con que una CI saltea un commit: en el mensaje de un merge dejan a la destino sin construir
const SALTEOS = [/\[(skip ci|ci skip|no ci|skip actions|actions skip|skip azurepipelines|azurepipelines skip|skip azpipelines|azpipelines skip|skip azp|azp skip)\]/gi, /skip-checks: ?true/gi, /\*\*\*NO_CI\*\*\*/gi];
// hasta que no quede ninguno: sacar uno puede armar otro con lo que lo rodeaba
function sinSalteos(t) {
  for (let antes = null; antes !== t;) { antes = t; t = SALTEOS.reduce((x, re) => x.replace(re, ''), t); }
  return t;
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** El servidor y la ruta del proyecto de la identidad del repo: `{host, p}`, o `{problem}`. */
function repoDe(ctx) {
  const p = projectPath(ctx.repo);
  if (!p) return { problem: no('rechazado', 'el repo no trae namespace y repo de GitLab (team-repos.json)') };
  const s = servidorDe(ctx, ctx.repo);
  if (s.problem) return { problem: s.problem };
  return { host: s.host, p };
}

/**
 * Los estados de commit de una punta (un commit o una rama), de cada contexto el más nuevo por fecha y, a igual fecha,
 * por id: `{value: [{ name, status, allowFailure }]}` o `{problem}`. Lo que no se leyó nunca es verde.
 */
function estados(ctx, t, punta) {
  const l = todas(ctx, t.host, `${t.p}/repository/commits/${encodeURIComponent(punta)}/statuses`);
  if (l.problem) return l;
  const cuando = (s) => { const x = Date.parse((s && s.created_at) || ''); return Number.isNaN(x) ? 0 : x; };
  const id = (s) => (Number.isFinite(Number(s && s.id)) ? Number(s.id) : 0);
  const ultimo = new Map();
  for (const s of l.value) {
    if (!s || typeof s.name !== 'string') continue;
    const previo = ultimo.get(s.name);
    if (!previo || cuando(s) > cuando(previo) || (cuando(s) === cuando(previo) && id(s) > id(previo))) ultimo.set(s.name, s);
  }
  return { value: [...ultimo.values()].map((s) => ({ name: s.name, status: String(s.status || ''), allowFailure: s.allow_failure === true })) };
}

/** El freno de publicación sobre el pedido, antes de que salga: null si pasa, o el «no». */
function frenoDePublicacion(ctx, args, titulo, texto) {
  let guard;
  try { guard = require(path.join(ctx.root, 'scripts', 'hooks', 'public-push-guard.js')); } catch (e) {
    return no('no_medido', `no pude cargar el freno de publicación (${(e && e.code) || 'error'}): el pedido no sale sin pasar por él`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedido-'));
  try {
    const cuerpo = path.join(dir, 'cuerpo.md');
    fs.writeFileSync(cuerpo, texto);
    const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    // el freno lee pedidos con la forma del comando que conoce. Esta línea no nombra un repo que él reconozca, así que
    // decide por la carpeta (`repoDir`): mira el texto si es un clon del arnés con un remoto público, o si no puede
    // saber de quién es; en la carpeta de un repo de producto lo deja pasar sin mirarlo
    const cmd = `gh pr create --base ${q(args.targetBranch)} --head ${q(args.sourceBranch)} --title ${q(titulo)} --body-file ${q(cuerpo)}`;
    const r = guard.reviewGhCommand(cmd, { cwd: args.repoDir || process.cwd(), env: ctx.env });
    return r && r.code === 2 ? no('rechazado', 'el freno de publicación no deja salir este pedido: corregí el título o el texto (correr el freno a mano dice dónde está el problema)') : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function abrirPedido(args, ctx) {
  const t = repoDe(ctx);
  if (t.problem) return t.problem;
  const texto = String(args.text).replace(/\n+$/, '');
  const titulo = args.title || texto.split('\n', 1)[0];
  const frenado = frenoDePublicacion(ctx, args, titulo, texto);
  if (frenado) return frenado;

  const abiertos = () => glab(ctx, t.host, 'GET', `${t.p}/merge_requests?state=opened&source_branch=${encodeURIComponent(args.sourceBranch)}&target_branch=${encodeURIComponent(args.targetBranch)}&per_page=100`);
  const deLaRama = (lista) => (Array.isArray(lista) ? lista : []).find((p) => p && p.source_branch === args.sourceBranch && p.target_branch === args.targetBranch);
  const l = abiertos();
  if (l.problem) return l.problem;
  const previo = deLaRama(l.value);
  const escrito = previo
    ? glab(ctx, t.host, 'PUT', `${t.p}/merge_requests/${previo.iid}`, { title: titulo, description: texto, remove_source_branch: args.deleteSourceBranch })
    : glab(ctx, t.host, 'POST', `${t.p}/merge_requests`, { source_branch: args.sourceBranch, target_branch: args.targetBranch, title: titulo, description: texto, remove_source_branch: args.deleteSourceBranch });
  if (escrito.problem) return previo ? no(escrito.problem.reason, `pedido !${previo.iid}: ${escrito.problem.detail}`) : escrito.problem;
  let mr = escrito.value || previo;
  // creado, pero su respuesta no se pudo leer: se busca por su rama antes de decir que no hay número
  if (!previo && !(Number(mr && mr.iid) > 0)) {
    const otra = abiertos();
    mr = (!otra.problem && deLaRama(otra.value)) || mr;
  }
  const n = Number(mr && mr.iid);
  if (!Number.isInteger(n) || n <= 0) return no('no_medido', 'GitLab no devolvió el número del pedido');
  const base = { id: n, url: String(mr.web_url || ''), reused: Boolean(previo), deleteSourceBranch: args.deleteSourceBranch };
  const warnings = [];
  const mergear = (sha, extra) => {
    const [asunto, ...resto] = sinSalteos(texto).split('\n');
    return glab(ctx, t.host, 'PUT', `${t.p}/merge_requests/${n}/merge`, {
      sha, squash: false, should_remove_source_branch: args.deleteSourceBranch,
      merge_commit_message: `${asunto.replace(/^merge: \S+ -> \S+ — /, '').replace(/ {2,}/g, ' ').trim()} (!${n})\n\n${resto.join('\n').trim()}`.trim(),
      ...extra,
    });
  };

  const espera = Number.isFinite(args.waitMinutes) ? args.waitMinutes : 30;
  const cada = Number.isFinite(args.pollSeconds) ? args.pollSeconds : 30;
  const tope = Date.now() + espera * 60000;
  let pedida = false;
  for (;;) {
    const g = glab(ctx, t.host, 'GET', `${t.p}/merge_requests/${n}`);
    if (g.problem) return no(g.problem.reason, `pedido !${n}: ${g.problem.detail}`);
    const v = g.value || {};
    if (v.state === 'merged') return { ok: true, value: { ...base, modo: pedida ? 'auto' : 'espera-y-mergea', merged: true, warnings } };
    if (v.state && v.state !== 'opened') return no('rechazado', `pedido !${n}: ya no está abierto`);
    if (v.merge_when_pipeline_succeeds === true) return { ok: true, value: { ...base, modo: 'auto', merged: false, ...(v.has_conflicts === true ? { conflict: true } : {}), warnings } };
    // choca con su destino: queda abierto y sin entrada pedida, para que alguien resuelva el choque
    if (v.has_conflicts === true) return { ok: true, value: { ...base, modo: 'sin-entrada', merged: false, conflict: true, warnings } };
    const sha = String(v.sha || '');
    const calculando = CALCULANDO.has(String(v.detailed_merge_status || ''));
    const pipeline = v.head_pipeline && typeof v.head_pipeline === 'object' ? String(v.head_pipeline.status || '') : '';
    if (!calculando && !pedida && EN_CURSO.has(pipeline)) {
      // un pipeline corriendo en la punta: GitLab mergea solo cuando da verde
      pedida = true;
      const m = mergear(sha, { merge_when_pipeline_succeeds: true });
      if (m.problem && m.problem.reason === 'red') return no('red', `pedido !${n}: no pude pedir la entrada automática (${m.problem.detail})`);
      if (m.problem) warnings.push(`pedido !${n}: GitLab no dejó puesta la entrada automática (${m.problem.detail}); se esperan los estados de la punta y se mergea`);
      else continue;
    }
    if (!calculando && sha) {
      const c = estados(ctx, t, sha);
      if (c.problem) return no(c.problem.reason, `pedido !${n}: no pude leer los estados de su punta (${c.problem.detail})`);
      const cuentan = c.value.filter((x) => !args.check || x.name === args.check);
      const malo = cuentan.find(terminoMal);
      if (malo) return no('rechazado', `pedido !${n}: el control ${malo.name} terminó en ${malo.status}`);
      if (cuentan.length && !cuentan.some(sinTerminar)) {
        const m = mergear(sha);
        if (m.problem) return no(m.problem.reason === 'red' ? 'red' : 'rechazado', `pedido !${n}: GitLab no lo mergeó (${m.problem.detail})`);
        return { ok: true, value: { ...base, modo: 'espera-y-mergea', merged: true, warnings } };
      }
      if (Date.now() >= tope) {
        const falta = args.check && !cuentan.length ? `el control ${args.check} no apareció` : 'el control no terminó';
        return no('no_medido', `pedido !${n}: ${falta} en ${espera} min; queda abierto`);
      }
    } else if (Date.now() >= tope) return no('no_medido', `pedido !${n}: GitLab no terminó de calcular si se puede mergear en ${espera} min; queda abierto`);
    await esperar(cada * 1000);
  }
}

/** Aprobar un pedido. GitLab registra la aprobación de quien tiene la sesión; otro voto no tiene equivalente. */
function votar(args, ctx) {
  const t = repoDe(ctx);
  if (t.problem) return t.problem;
  const n = Number(args && (args.number !== undefined ? args.number : args.id));
  if (!Number.isInteger(n) || n <= 0) return no('rechazado', `el número del pedido no se puede leer: ${JSON.stringify(args && (args.number !== undefined ? args.number : args.id))}`);
  const voto = String((args && (args.vote !== undefined ? args.vote : args.voto)) || 'approve');
  if (voto !== 'approve') return no('no_soportado', `GitLab sólo registra la aprobación de un pedido (approve), no el voto «${voto.slice(0, 40)}»`);
  const r = glab(ctx, t.host, 'POST', `${t.p}/merge_requests/${n}/approve`, {});
  if (r.problem) return no(r.problem.reason, `pedido !${n}: ${r.problem.detail}`);
  return { ok: true, value: { number: n, vote: 'approve' } };
}

/**
 * Un pedido por su número, abierto o cerrado: `{ number, state: open|merged|closed, draft, autoComplete, inQueue, mergedAt,
 * mergeCommit, title }`. Uno que no existe es no_encontrado, nunca «entró».
 */
function leerPedido(args, ctx) {
  const t = repoDe(ctx);
  if (t.problem) return t.problem;
  const n = Number(args && args.number);
  if (!Number.isInteger(n) || n <= 0) return no('rechazado', `el número del pedido no se puede leer: ${JSON.stringify(args && args.number)}`);
  const g = glab(ctx, t.host, 'GET', `${t.p}/merge_requests/${n}`);
  if (g.problem) return g.problem;
  const p = g.value;
  if (!p || typeof p !== 'object' || Number(p.iid) !== n || typeof p.state !== 'string') return no('no_medido', `GitLab contestó el pedido !${n} sin forma`);
  const entro = p.state === 'merged';
  return {
    ok: true,
    value: {
      number: n,
      state: p.state === 'opened' ? 'open' : (entro ? 'merged' : 'closed'),
      draft: p.draft === true,
      autoComplete: p.merge_when_pipeline_succeeds === true,
      // el conector no usa una cola de merge: un pedido nunca está en una
      inQueue: false,
      mergedAt: entro && p.merged_at ? String(p.merged_at) : null,
      mergeCommit: entro && /^[0-9a-f]{40}$/i.test(String(p.merge_commit_sha || '')) ? String(p.merge_commit_sha).toLowerCase() : null,
      title: String(p.title || ''),
    },
  };
}

/** Si la validación de una punta está corriendo: true, false, o null si los estados no se pudieron leer. */
function corriendo(ctx, t, sha) {
  if (!sha) return null;
  const c = estados(ctx, t, sha);
  return c.problem ? null : c.value.some(sinTerminar);
}

function listarPedidos(args, ctx) {
  const t = repoDe(ctx);
  if (t.problem) return t.problem;
  const rama = args.sourceBranch ? String(args.sourceBranch) : null;
  const l = todas(ctx, t.host, `${t.p}/merge_requests?state=opened${rama ? `&source_branch=${encodeURIComponent(rama)}` : ''}`);
  if (l.problem) return l.problem;
  const value = l.value.filter((p) => p && p.state === 'opened' && (!rama || p.source_branch === rama)).map((p) => {
    const sha = String(p.sha || '');
    const estado = String(p.detailed_merge_status || '');
    return {
      number: Number(p.iid),
      draft: p.draft === true,
      autoComplete: p.merge_when_pipeline_succeeds === true,
      ...(rama ? { inQueue: false } : {}),
      mergeState: p.has_conflicts === true ? 'conflict' : (estado === 'mergeable' ? 'clean' : (CALCULANDO.has(estado) || !estado ? 'unknown' : 'pending')),
      sourceBranch: String(p.source_branch || ''),
      sourceCommit: sha,
      createdAt: String(p.created_at || ''),
      title: String(p.title || ''),
      author: p.author && p.author.username ? String(p.author.username).toLowerCase() : null,
      // `checks: false`: quien sólo cuenta pedidos no paga una lectura de estados por cada uno
      ciRunning: args.checks === false ? null : corriendo(ctx, t, sha),
    };
  });
  return { ok: true, value };
}

/** Los issues y merge requests abiertos con alguien asignado: una fila por persona. */
function asignados(args, ctx) {
  const t = repoDe(ctx);
  if (t.problem) return t.problem;
  const value = [];
  for (const [tipo, lista] of [['issue', 'issues'], ['merge request', 'merge_requests']]) {
    const l = todas(ctx, t.host, `${t.p}/${lista}?state=opened`);
    if (l.problem) return l.problem;
    for (const i of l.value) {
      if (!i || i.state !== 'opened') continue;
      for (const a of Array.isArray(i.assignees) ? i.assignees : []) {
        if (!a || !a.username) continue;
        value.push({ tipo, id: Number(i.iid), titulo: String(i.title || ''), estado: 'open', asignado: String(a.username).toLowerCase(), enlace: String(i.web_url || '') });
      }
    }
  }
  return { ok: true, value };
}

module.exports = { 'change-request.open': abrirPedido, 'change-request.vote': votar, 'change-request.list': listarPedidos, 'change-request.read': leerPedido, 'assigned.list': asignados };
// los ayudantes que reusa la lectura de la CI, fuera del mapa de operaciones
for (const [k, v] of Object.entries({ estados, repoDe, sinTerminar, terminoMal })) Object.defineProperty(module.exports, k, { value: v, enumerable: false });
