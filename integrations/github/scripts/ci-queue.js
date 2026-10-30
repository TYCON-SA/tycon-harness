'use strict';
// ci-queue.js — la CI de un repo de GitHub (`ci.read`) y la cola de las Actions de los repos del equipo (`queue.read`).
//
// La CI: cada control de la punta (check-runs y estados de commit, de cada contexto el más nuevo) es una etapa, con su
// conclusión tal como la da GitHub; `running` si alguno no terminó, `failed` si alguno terminó mal, `none` sin ninguno.
// El valor no dice «desplegado»: un control verde no es un despliegue.
//
// La cola: las corridas `queued` e `in_progress` de cada repo (`args.repos`, o los repos de GitHub de team-repos.json),
// con quién las disparó y desde cuándo. Un repo que no se lee hace no_medido la cola entera: una cola a medias se lee
// como «hay lugar».

const path = require('path');
const { esRepoGithub } = require('./gh-api.js');
const { todas, controles, repoDe, MALOS } = require('./change-requests.js');

const no = (reason, detail) => ({ ok: false, reason, detail });
// en una lectura, lo que gh-api llama «rechazado» (un 5xx, un tope) es una lectura que no se hizo
const comoLectura = (p) => (p.reason === 'rechazado' ? no('no_medido', p.detail) : p);

function leerCi(args, ctx) {
  const repo = repoDe(ctx);
  if (!repo) return no('rechazado', 'el repo no tiene forma de repo de GitHub (dueño/nombre)');
  const punta = String(args.commit || args.branch || '');
  if (!/^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/.test(punta)) return no('rechazado', 'falta el commit o la rama, o no tiene forma de commit o de rama');
  const c = controles(ctx, repo, encodeURIComponent(punta));
  if (c.problem) return comoLectura(c.problem);
  const stages = c.value.map((x) => ({ pipeline: null, name: String(x.name || ''), result: x.status === 'completed' && x.conclusion ? String(x.conclusion) : null }));
  if (!stages.length) return { ok: true, value: { state: 'none', stages } };
  const corriendo = c.value.some((x) => x.status !== 'completed');
  const mal = c.value.some((x) => MALOS.has(x.conclusion));
  return { ok: true, value: { state: corriendo ? 'running' : (mal ? 'failed' : 'succeeded'), stages } };
}

/**
 * Los repos de GitHub de team-repos.json, sin repetir: `{value}` o `{problem}`. Cuenta los de cada clave, las copias del
 * arnés y los de las suites del merge, los mismos que la capa de plataforma toma como declarados. Ninguno declarado no
 * es «la cola está libre»: es una cola que no se midió. Un repo sin forma de `dueño/nombre` tampoco se pregunta.
 */
function reposDelEquipo(ctx) {
  const TR = require(path.join(ctx.root, 'scripts', 'lib', 'team-repos.js'));
  const archivo = path.join(ctx.env.TYCON_TREE || ctx.root, 'team-repos.json');
  const t = TR.load(archivo);
  if (!t.ok || !t.data) return { problem: no('no_medido', `no pude leer los repos del equipo: ${((t.problems || [])[0] || {}).message || archivo}`) };
  const d = t.data;
  const declarados = [
    ...TR.KEYS.map((k) => [k, d[k]]),
    ...(Array.isArray(d.harness_copies) ? d.harness_copies : []).map((r, i) => [`harness_copies[${i}]`, r]),
    ...((d.merge_suites && Array.isArray(d.merge_suites.repos)) ? d.merge_suites.repos : []).map((s, i) => [`merge_suites.repos[${i}]`, s && s.repo]),
  ];
  const vistos = new Map();
  for (const [k, r] of declarados) {
    if (!r || typeof r !== 'object' || r.platform !== 'github') continue;
    const id = `${r.org}/${r.repo}`;
    if (!esRepoGithub(id)) return { problem: no('no_medido', `el repo «${id}» de team-repos.json (${k}) no tiene forma de repo de GitHub (dueño/nombre)`) };
    vistos.set(id.toLowerCase(), id);
  }
  if (!vistos.size) return { problem: no('no_medido', `team-repos.json no declara ningún repo de GitHub: no hay cola que leer (pasá los repos con repos, o declaralos en ${archivo})`) };
  return { value: [...vistos.values()] };
}

function leerCola(args, ctx) {
  let repos;
  if (args.repos !== undefined) {
    if (!Array.isArray(args.repos) || !args.repos.every((r) => esRepoGithub(String(r)))) return no('rechazado', 'repos tiene que ser una lista de repos de GitHub (dueño/nombre)');
    repos = args.repos.map(String);
  } else {
    const r = reposDelEquipo(ctx);
    if (r.problem) return r.problem;
    repos = r.value;
  }
  // una corrida que arranca entre las dos lecturas sale en las dos: cuenta una vez, en curso (la segunda lectura pisa)
  const value = new Map();
  for (const repo of repos) {
    for (const [estado, state] of [['queued', 'queued'], ['in_progress', 'running']]) {
      const l = todas(ctx, `repos/${repo}/actions/runs?status=${estado}`, (v) => v && v.workflow_runs);
      if (l.problem) { const p = comoLectura(l.problem); return no(p.reason, `las corridas de ${repo}: ${p.detail}`); }
      for (const w of l.value) {
        if (!w || w.status !== estado) continue;
        const quien = (w.triggering_actor && w.triggering_actor.login) || (w.actor && w.actor.login);
        value.set(`${repo.toLowerCase()}#${w.id}`, { id: w.id, requestedBy: quien ? String(quien).toLowerCase() : null, repo, since: w.created_at || null, state });
      }
    }
  }
  return { ok: true, value: [...value.values()] };
}

module.exports = { 'ci.read': leerCi, 'queue.read': leerCola };
