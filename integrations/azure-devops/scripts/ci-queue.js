'use strict';
// ci-queue.js — la CI de un repo de Azure DevOps (`ci.read`) y la cola de la organización (`queue.read`).
//
// La CI, de una rama o de un commit:
//   az pipelines runs list --project <proyecto> [--branch <rama>] --top 100 --org <org> -o json
//   az devops invoke --area build --resource timeline --route-parameters project=<proyecto> buildId=<n>
//     --api-version 7.1 --org <org> -o json
// De las corridas del proyecto valen las de ESTE repo (y de ese commit, si viene); de cada pipeline, la más nueva. Cada
// etapa (`Stage`) de su línea de tiempo es una etapa del resultado, con el resultado tal como lo da Azure: una corrida
// `succeeded` con la etapa de producción `skipped` no desplegó nada, y el valor no dice «desplegado» en ningún lado.
// Una línea de tiempo vacía es «sin etapas» sólo para una corrida que no terminó; la de una terminada no se leyó.
// Sin corridas del repo en una ventana que no se llenó, `none`. Con la ventana llena, no_medido aunque traiga corridas
// del repo: la más nueva de otro pipeline del mismo repo pudo quedar más atrás, y leer sólo las que entraron dice
// «verde» de algo que no se vio. Un commit abreviado vale por su comienzo.
//
// La cola, del grupo de agentes (`args.pool`, por defecto «Azure Pipelines»), con la organización de la máquina:
//   az devops invoke --area distributedtask --resource pools --api-version 7.1 --org <org> -o json
//   az devops invoke --area distributedtask --resource jobrequests --route-parameters poolId=<id> --api-version 7.1
//     --org <org> -o json
//   az pipelines runs show --id <n> --project <proyecto> --org <org> -o json   (por cada pedido sin terminar)
// Un pedido sin `finishTime` ocupa o espera un carril; quién lo pidió y de qué repo salen de su corrida. Cualquier
// lectura que falla hace no_medido la cola entera: una cola a medias se lee como «hay lugar».

const { correrAz, orgDe } = require('./change-requests.js');

const VENTANA = 100;
const POOL = 'Azure Pipelines';
const BIEN = new Set(['succeeded', 'succeededwithissues']);

const no = (reason, detail) => ({ ok: false, reason, detail });
const fecha = (s) => { const t = Date.parse(s || ''); return Number.isNaN(t) ? 0 : t; };
const masNueva = (a, b) => fecha(b.queueTime) - fecha(a.queueTime) || Number(b.id) - Number(a.id);

function leerCi(args, ctx) {
  const repo = ctx.repo || {};
  const o = orgDe(repo);
  if (o.problem) return o.problem;
  const rama = args.branch ? String(args.branch) : null;
  const commit = args.commit ? String(args.commit) : null;
  if ((rama && /^-/.test(rama)) || (commit && !/^[0-9a-f]{7,64}$/i.test(commit))) return no('rechazado', 'la rama o el commit no tienen forma de rama o de commit (un commit va en hexadecimal, de 7 a 64 caracteres)');
  const lista = correrAz(ctx, ['pipelines', 'runs', 'list', '--project', repo.project, ...(rama ? ['--branch', rama] : []), '--top', String(VENTANA), '--org', o.value, '-o', 'json']);
  if (lista.problem) return lista.problem;
  if (!Array.isArray(lista.value)) return no('no_medido', 'la lista de corridas no es una lista');
  if (lista.value.length >= VENTANA) return no('no_medido', `las últimas ${VENTANA} corridas del proyecto no alcanzan: alguna de ${repo.repo} pudo quedar más atrás${rama ? '' : ' (con la rama además del commit, la lista se achica)'}`);
  const nombre = String(repo.repo).toLowerCase();
  const delCommit = (r) => !commit || String(r.sourceVersion || '').toLowerCase().startsWith(commit.toLowerCase());
  const delRepo = lista.value.filter((r) => r && r.repository && String(r.repository.name).toLowerCase() === nombre && delCommit(r));
  if (!delRepo.length) return { ok: true, value: { state: 'none', stages: [] } };
  const porPipeline = new Map();
  for (const r of [...delRepo].sort(masNueva)) {
    const k = String((r.definition && r.definition.id) || '');
    if (!porPipeline.has(k)) porPipeline.set(k, r);
  }
  const stages = [];
  let corriendo = false; let mal = false;
  for (const r of porPipeline.values()) {
    const t = correrAz(ctx, ['devops', 'invoke', '--area', 'build', '--resource', 'timeline', '--route-parameters', `project=${repo.project}`, `buildId=${r.id}`, '--api-version', '7.1', '--org', o.value, '-o', 'json'], { vacio: null });
    if (t.problem) return no('no_medido', `la línea de tiempo de la corrida ${r.id}: ${t.problem.detail}`);
    // sin respuesta: una corrida que no arrancó todavía no tiene etapas; una terminada sí, y no se leyeron
    if (t.value === null && r.status !== 'completed') t.value = { records: [] };
    if (!t.value || !Array.isArray(t.value.records)) return no('no_medido', `la línea de tiempo de la corrida ${r.id} no trae sus registros`);
    const pipeline = r.definition && r.definition.name ? String(r.definition.name) : null;
    const etapas = t.value.records.filter((x) => x && x.type === 'Stage').sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    for (const e of etapas) {
      const hecha = e.state === 'completed';
      if (!hecha) corriendo = true;
      stages.push({ pipeline, name: String(e.name || e.identifier || ''), result: hecha && e.result ? String(e.result) : null });
    }
    if (r.status !== 'completed') corriendo = true;
    else if (!BIEN.has(String(r.result || '').toLowerCase())) mal = true;
  }
  return { ok: true, value: { state: corriendo ? 'running' : (mal ? 'failed' : 'succeeded'), stages } };
}

/** La organización de la máquina como dirección, o el «no». */
function orgDeLaMaquina(ctx) {
  const rota = ctx.configProblem('ado');
  if (rota) return { problem: no('no_medido', `no pude leer la configuración de esta máquina: ${rota}`) };
  const org = String(ctx.configValue('ado.org') || '').trim().replace(/\/+$/, '');
  if (!org) return { problem: no('sin_credencial', 'falta la organización de Azure DevOps de esta máquina: harness.js config set ado.org <organización>') };
  if (/^https:\/\/dev\.azure\.com\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(org)) return { value: org };
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(org)) return { value: `https://dev.azure.com/${org}` };
  return { problem: no('no_medido', 'la organización de Azure DevOps de esta máquina no es un nombre ni una dirección de dev.azure.com') };
}

// la corrida dueña de un pedido: `…/<proyecto>/_apis/build/Builds/<n>`
const CORRIDA = /\/([^/]+)\/_apis\/build\/Builds\/(\d+)\/?$/i;

function leerCola(args, ctx) {
  const o = orgDeLaMaquina(ctx);
  if (o.problem) return o.problem;
  const nombre = String(args.pool || POOL);
  const grupos = correrAz(ctx, ['devops', 'invoke', '--area', 'distributedtask', '--resource', 'pools', '--api-version', '7.1', '--org', o.value, '-o', 'json']);
  if (grupos.problem) return no('no_medido', `los grupos de agentes: ${grupos.problem.detail}`);
  const lista = grupos.value && Array.isArray(grupos.value.value) ? grupos.value.value : null;
  if (!lista) return no('no_medido', 'la lista de grupos de agentes no trae su lista (value)');
  const grupo = lista.find((g) => g && String(g.name).toLowerCase() === nombre.toLowerCase());
  if (!grupo) return no('no_medido', `no hay un grupo de agentes «${nombre}» en la organización`);
  const pedidos = correrAz(ctx, ['devops', 'invoke', '--area', 'distributedtask', '--resource', 'jobrequests', '--route-parameters', `poolId=${grupo.id}`, '--api-version', '7.1', '--org', o.value, '-o', 'json']);
  if (pedidos.problem) return no('no_medido', `los pedidos del grupo «${nombre}»: ${pedidos.problem.detail}`);
  const todos = pedidos.value && Array.isArray(pedidos.value.value) ? pedidos.value.value : null;
  if (!todos) return no('no_medido', 'la lista de pedidos del grupo no trae su lista (value)');
  const value = [];
  for (const p of todos) {
    if (!p || p.finishTime) continue;
    const href = p.owner && p.owner._links && p.owner._links.self && p.owner._links.self.href;
    // un pedido sin corrida reconocible (un release clásico, un enlace raro) no dice quién lo pidió: la cola no se midió
    const m = CORRIDA.exec(String(href || ''));
    if (!m) return no('no_medido', `el pedido ${p.requestId} no es de una corrida de pipeline: no sé quién lo pidió ni de qué repo es`);
    let project;
    try { project = decodeURIComponent(m[1]); } catch (_) { project = ''; }
    if (!project || /^-/.test(project)) return no('no_medido', `el pedido ${p.requestId} trae un proyecto que no es un nombre de proyecto`);
    const run = Number(m[2]);
    const c = correrAz(ctx, ['pipelines', 'runs', 'show', '--id', String(run), '--project', project, '--org', o.value, '-o', 'json']);
    if (c.problem) return no('no_medido', `la corrida ${run} del pedido ${p.requestId}: ${c.problem.detail}`);
    const quien = c.value && c.value.requestedFor && c.value.requestedFor.uniqueName;
    value.push({ id: p.requestId, requestedBy: quien ? String(quien).toLowerCase() : null, project, repo: c.value && c.value.repository ? String(c.value.repository.name) : null, run, since: p.queueTime || null, state: p.assignTime ? 'running' : 'queued' });
  }
  return { ok: true, value };
}

module.exports = { 'ci.read': leerCi, 'queue.read': leerCola };
