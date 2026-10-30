'use strict';
// work-items.js — el pedido de trabajo de la historia en GitHub: un issue. El tipo va como etiqueta `tipo:<Tipo>`, el
// estado como etiqueta `estado:<estado>` y las horas como un comentario de formato fijo («Horas completadas: N h»),
// porque un issue no tiene esos campos. Lo que GitHub no tiene (la prioridad, un campo propio, el Epic padre) no se
// carga en silencio: vuelve en `unsupported` con su nombre y el motivo `no_soportado`.
//
// La estimación vigente (`estimate`, en create y update) va al campo numérico del proyecto que declara
// `github.project: { owner, number, field }`, por la API GraphQL (el proyecto del dueño con sus campos, agregar el issue,
// cargar el número). Sin proyecto, o si el proyecto no se puede usar (sin permiso, o el proyecto o el campo no existe),
// va un comentario de formato fijo («Estimación: 16 h (historia, versión 2)») y, en el segundo caso, `estimateFallback`
// dice por qué. En update, una estimación igual a la del último comentario no se comenta otra vez.
//
// Dónde: `repo: dueño/nombre` en la configuración del repo de historias (scripts/lib/platform/work-items-config.js).
// Habla por `gh api` (TYCON_GH_CMD lo reemplaza: un ejecutable, o un `.js` que corre con node).

const path = require('path');
const { gh, no, esRepoGithub } = require('./gh-api.js');

const idValido = (id) => /^\d+$/.test(String(id == null ? '' : id).trim());
const noSoportado = (field, detail) => ({ field, reason: 'no_soportado', detail });

/** El repo de los issues y la configuración: `{c, repo}` o `{problem}`. */
function destino(args, ctx) {
  const W = require(path.join(ctx.root, 'scripts', 'lib', 'platform', 'work-items-config.js'));
  const leido = W.read(args.repoDir || process.cwd());
  if (leido.problem) return { problem: no('no_medido', `no pude leer la configuración del pedido de trabajo: ${leido.problem}`) };
  const c = leido.config || {};
  // el pedido de la noche trae el suyo (el repo del producto): gana sobre el de la configuración del repo
  const repo = String(args.repo || c.repo || (String(c.project || '').includes('/') ? c.project : '')).trim();
  if (!esRepoGithub(repo)) return { problem: no('sin_plataforma', 'el repo no dice en qué repo de GitHub van sus issues: repo: dueño/nombre en .tycon/work-items.yaml') };
  const warnings = (leido.unknown || []).length ? [`${path.basename(leido.file)} trae claves que no conozco: ${leido.unknown.join(', ')}`] : [];
  return { c, repo, warnings };
}

// ── la estimación ──
const CONSULTA_PROYECTO = 'query($owner: String!, $number: Int!) { repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) '
  + '{ id fields(first: 100) { nodes { ... on ProjectV2FieldCommon { id name dataType } } } } } } }';
const AGREGAR_AL_PROYECTO = 'mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }';
const CARGAR_NUMERO = 'mutation($project: ID!, $item: ID!, $field: ID!, $value: Float!) { updateProjectV2ItemFieldValue(input: '
  + '{ projectId: $project, itemId: $item, fieldId: $field, value: { number: $value } }) { projectV2Item { id } } }';
const EN_UNIDAD = {
  hours: (v) => `${v} h`,
  days: (v) => `${v} ${v === 1 ? 'día' : 'días'}`,
  points: (v) => `${v} ${v === 1 ? 'punto' : 'puntos'}`,
};
const ES_ESTIMACION = /^Estimación: /;

/** El comentario de formato fijo: «Estimación: 16 h (historia, versión 2)». */
function comentarioDeEstimacion(e) {
  const de = e.level ? ` (${e.level}${e.version ? `, versión ${e.version}` : ''})` : '';
  return `Estimación: ${EN_UNIDAD[e.unit](e.value)}${de}`;
}

/** Por qué no se pudo usar el proyecto: sin permiso, no encontrado, o el motivo del contrato que trajo gh (red, no_medido). */
function porQue(problem) {
  if (problem.reason === 'sin_credencial' || /INSUFFICIENT_SCOPES|required scopes|read:project|FORBIDDEN/i.test(problem.detail)) return 'sin_credencial';
  if (problem.reason === 'no_encontrado' || /NOT_FOUND|Could not resolve/i.test(problem.detail)) return 'no_encontrado';
  return problem.reason === 'red' ? 'red' : 'no_medido';
}

/** El número en el campo del proyecto: `{ ok: true }` o `{ fallback: { reason, detail } }`. */
function alProyecto(ctx, proyecto, nodo, e) {
  const aparte = (reason, detail) => ({ fallback: { reason, detail } });
  const consulta = (query, variables) => {
    const r = gh(ctx, 'POST', 'graphql', { query, variables });
    return r.problem ? { problem: r.problem } : { data: (r.value && r.value.data) || null };
  };
  const donde = `el proyecto ${proyecto.number} de ${proyecto.owner}`;
  // el issue no se pudo leer: el motivo es el de gh, no la falta del nodo
  if (nodo && typeof nodo === 'object' && nodo.problem) return aparte(porQue(nodo.problem), `no pude leer el issue: ${nodo.problem.detail}`);
  if (!nodo) return aparte('no_encontrado', 'el issue no trae el nodo con que GraphQL lo nombra');
  const q = consulta(CONSULTA_PROYECTO, { owner: proyecto.owner, number: proyecto.number });
  if (q.problem) return aparte(porQue(q.problem), q.problem.detail);
  const p = q.data && q.data.repositoryOwner && q.data.repositoryOwner.projectV2;
  if (!p || !p.id) return aparte('no_encontrado', `${donde} no existe o esta credencial no lo ve`);
  const nodos = (p.fields && Array.isArray(p.fields.nodes)) ? p.fields.nodes : [];
  const campo = nodos.find((n) => n && n.name === proyecto.field);
  if (!campo) return aparte('no_encontrado', `${donde} no tiene el campo «${proyecto.field}»`);
  if (campo.dataType !== 'NUMBER') return aparte('no_encontrado', `el campo «${proyecto.field}» de ${donde} no es numérico`);
  // agregar es idempotente en GitHub: un issue que ya está devuelve su elemento
  const a = consulta(AGREGAR_AL_PROYECTO, { project: p.id, content: nodo });
  if (a.problem) return aparte(porQue(a.problem), a.problem.detail);
  const item = a.data && a.data.addProjectV2ItemById && a.data.addProjectV2ItemById.item;
  if (!item || !item.id) return aparte('no_encontrado', `GitHub no devolvió el elemento del issue en ${donde}`);
  const u = consulta(CARGAR_NUMERO, { project: p.id, item: item.id, field: campo.id, value: e.value });
  if (u.problem) return aparte(porQue(u.problem), u.problem.detail);
  return { ok: true };
}

/** El último comentario de estimación del issue, o null; undefined si no se pudo leer. */
function ultimaEstimacion(ctx, repo, id) {
  let ultima = null;
  for (let pagina = 1; pagina <= 20; pagina++) {
    const g = gh(ctx, 'GET', `repos/${repo}/issues/${id}/comments?per_page=100&page=${pagina}`);
    if (g.problem || !Array.isArray(g.value)) return undefined;
    for (const k of g.value) if (k && typeof k.body === 'string' && ES_ESTIMACION.test(k.body)) ultima = k.body;
    if (g.value.length < 100) return ultima;
  }
  return undefined;
}

/**
 * La estimación vigente al issue: el campo del proyecto, o el comentario. Lo anota en `value`; un comentario que no se
 * pudo publicar es un aviso, no un «no»: el pedido ya quedó creado o actualizado.
 */
function estimar(ctx, c, repo, id, nodo, e, value, enUpdate) {
  if (!e) return;
  const proyecto = c.github && typeof c.github === 'object' ? c.github.project : undefined;
  if (proyecto) {
    const r = alProyecto(ctx, proyecto, nodo, e);
    if (r.ok) { Object.assign(value, { estimateAs: 'project', estimateField: proyecto.field }); return; }
    value.estimateFallback = r.fallback;
  }
  const texto = comentarioDeEstimacion(e);
  if (enUpdate) {
    const ultima = ultimaEstimacion(ctx, repo, id);
    if (ultima === texto) { Object.assign(value, { estimateAs: 'comment', estimateUnchanged: true }); return; }
    if (ultima === undefined) value.warnings.push(`no pude leer los comentarios del issue #${id}: la estimación se comenta sin comprobar si ya estaba`);
  }
  const k = gh(ctx, 'POST', `repos/${repo}/issues/${id}/comments`, { body: texto });
  if (k.problem) { value.warnings.push(`la estimación no se comentó en el issue #${id}: ${k.problem.detail}`); return; }
  value.estimateAs = 'comment';
}
const conProyecto = (c, e) => Boolean(e && c.github && typeof c.github === 'object' && c.github.project);

const etiquetas = (issue) => ((issue && issue.labels) || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
const sinEstado = (ls) => ls.filter((l) => !/^estado:/.test(l));
const camposPropios = (fields) => Object.keys(fields && typeof fields === 'object' ? fields : {}).map((k) => noSoportado(k, `GitHub no tiene el campo ${k} en un issue`));

function create(args, ctx) {
  if (typeof args.title !== 'string' || !args.title.trim()) return no('rechazado', 'falta el título del pedido de trabajo');
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const { c, repo } = d;
  const tipo = args.type || c.type;
  const labels = [...(tipo ? [`tipo:${tipo}`] : []), ...String(c.default_tags || '').split(/[;,]/), ...(Array.isArray(args.tags) ? args.tags : [])]
    .map((t) => String(t).trim()).filter(Boolean);
  const body = [args.description, args.acceptance ? `## Criterios de aceptación\n\n${args.acceptance}` : null].filter((x) => x && String(x).trim()).join('\n\n');
  const unsupported = [];
  if (args.priority !== undefined && args.priority !== null && String(args.priority) !== '') unsupported.push(noSoportado('Prioridad', 'un issue de GitHub no tiene prioridad'));
  unsupported.push(...camposPropios(args.fields));
  // la épica, con o sin mapeo: un issue no se cuelga de ella en GitHub, y se dice en los dos casos
  if (args.epic !== undefined && args.epic !== null && String(args.epic) !== '') unsupported.push(noSoportado('Épica', 'el issue no se cuelga de su épica en GitHub'));
  // auto_assign decide si el pedido de una story va a quien la crea; el de la noche no tiene autor y va siempre al
  // responsable que eligió la organización (forNight)
  const asignar = Boolean(args.assignTo) && (c.auto_assign === true || args.forNight === true);
  const pedido = { title: args.title, body, labels: [...new Set(labels)] };
  if (asignar) pedido.assignees = [String(args.assignTo)];
  const r = gh(ctx, 'POST', `repos/${repo}/issues`, pedido);
  if (r.problem) return r.problem;
  const id = r.value && r.value.number;
  if (!Number.isInteger(id)) return no('no_medido', 'gh creó algo, pero la respuesta no trae el número');
  const warnings = [...d.warnings];
  const value = { id, url: `https://github.com/${repo}/issues/${id}`, warnings, unsupported };
  if (asignar) {
    // GitHub descarta EN SILENCIO a quien no tiene acceso al repo: lo que vale es la respuesta, no el pedido
    const quedo = ((r.value && r.value.assignees) || []).map((u) => (typeof u === 'string' ? u : u && u.login)).filter(Boolean);
    value.assigned = quedo.some((l) => l.toLowerCase() === String(args.assignTo).toLowerCase()) ? String(args.assignTo) : null;
    if (value.assigned === null) warnings.push(`el issue #${id} quedó sin asignar a ${args.assignTo}: GitHub descarta en silencio a quien no tiene acceso al repo`);
  }
  // una etiqueta que no quedó (la cuenta no puede crearlas) hace que el issue no se encuentre después por ella
  const quedaron = etiquetas(r.value).map((l) => l.toLowerCase());
  value.missingTags = pedido.labels.filter((l) => !quedaron.includes(l.toLowerCase()));
  estimar(ctx, c, repo, id, r.value && r.value.node_id, args.estimate, value, false);
  return { ok: true, value };
}

function update(args, ctx) {
  if (!idValido(args.id)) return no('rechazado', `el número del issue no es un número: ${JSON.stringify(args.id)}`);
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const { c, repo } = d;
  const id = Number(String(args.id).trim());
  // con un comentario y sin estado, sólo se comenta: ni etiquetas ni estado, y uno cerrado no se reabre
  if (typeof args.comment === 'string' && args.comment.trim() && !args.state) {
    const k = gh(ctx, 'POST', `repos/${repo}/issues/${id}/comments`, { body: args.comment });
    if (k.problem) return k.problem;
    const value = { id, changed: false, commented: true, warnings: [...d.warnings] };
    // el nodo del issue sólo hace falta para el proyecto: sin él, no se lee el issue; si la lectura falla, va el motivo
    let nodo = null;
    if (conProyecto(c, args.estimate)) {
      const g = gh(ctx, 'GET', `repos/${repo}/issues/${id}`);
      nodo = g.problem ? { problem: g.problem } : g.value && g.value.node_id;
    }
    estimar(ctx, c, repo, id, nodo, args.estimate, value, true);
    return { ok: true, value };
  }
  const g = gh(ctx, 'GET', `repos/${repo}/issues/${id}`);
  if (g.problem) return g.problem;
  const ls = etiquetas(g.value);
  const previa = (ls.find((l) => /^estado:/.test(l)) || '').replace(/^estado:/, '');
  const previo = g.value.state === 'closed' ? 'cerrado' : (previa || 'abierto');
  const estado = String(args.state || c.state_active || 'activo');
  const warnings = [...d.warnings];
  if (g.value.state === 'closed' && args.reopen !== true) {
    warnings.push(`el issue #${id} está cerrado: reabrirlo lo decide una persona (puede romper la trazabilidad)`);
    if (args.estimate) warnings.push('la estimación no se cargó: el issue está cerrado');
    // el aviso lo dice en texto; el campo es para el núcleo, que pide la confirmación
    return { ok: true, value: { id, estado: previo, previo, changed: false, pideReabrir: true, warnings } };
  }
  if (previa === estado && g.value.state !== 'closed') {
    const value = { id, estado, previo, changed: false, warnings };
    estimar(ctx, c, repo, id, g.value.node_id, args.estimate, value, true);
    return { ok: true, value };
  }
  const cuerpo = { labels: [...sinEstado(ls), `estado:${estado}`] };
  if (g.value.state === 'closed') cuerpo.state = 'open';
  const p = gh(ctx, 'PATCH', `repos/${repo}/issues/${id}`, cuerpo);
  if (p.problem) return p.problem;
  const value = { id, estado, previo, changed: true, warnings };
  estimar(ctx, c, repo, id, g.value.node_id, args.estimate, value, true);
  return { ok: true, value };
}

function close(args, ctx) {
  if (!idValido(args.id)) return no('rechazado', `el número del issue no es un número: ${JSON.stringify(args.id)}`);
  let horas = null;
  // las horas, un número o un texto con un número: `' '`, `true` o `[]` no son 0 ni 1 horas
  if (args.hours !== undefined && args.hours !== null && args.hours !== '') {
    horas = (typeof args.hours === 'number' || (typeof args.hours === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(args.hours))) ? Number(args.hours) : NaN;
  } else if (Number.isInteger(args.seconds) && args.seconds >= 0) horas = Math.round((args.seconds / 3600) * 100) / 100;
  // segundos que no son un entero no se toman por «sin horas»: se rechazan
  else if (args.seconds !== undefined && args.seconds !== null) horas = NaN;
  if (horas !== null && !(Number.isFinite(horas) && horas >= 0)) return no('rechazado', `las horas no son un número: ${JSON.stringify(args.hours !== undefined ? args.hours : args.seconds)}`);
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const { c, repo } = d;
  const id = Number(String(args.id).trim());
  const g = gh(ctx, 'GET', `repos/${repo}/issues/${id}`);
  if (g.problem) return g.problem;
  // lo que ya quedó publicado cuando algo falla después: el «no» dice que quedó a medias (reintentar lo duplicaría)
  const hecho = [];
  const aMedias = (p) => (hecho.length ? no(p.reason, `a medias: ya quedó ${hecho.join(' y ')} en el issue #${id}; falló lo siguiente: ${p.detail}`) : p);
  if (typeof args.comment === 'string' && args.comment.trim()) {
    const k = gh(ctx, 'POST', `repos/${repo}/issues/${id}/comments`, { body: args.comment });
    if (k.problem) return k.problem;
    hecho.push('el comentario');
  }
  if (horas !== null) {
    const h = gh(ctx, 'POST', `repos/${repo}/issues/${id}/comments`, { body: `Horas completadas: ${horas} h` });
    if (h.problem) return aMedias(h.problem);
    hecho.push('el comentario de horas');
  }
  const p = gh(ctx, 'PATCH', `repos/${repo}/issues/${id}`, { state: 'closed', state_reason: 'completed', labels: [...sinEstado(etiquetas(g.value)), `estado:${c.state_closed || 'cerrado'}`] });
  if (p.problem) return aMedias(p.problem);
  return { ok: true, value: { id, hours: horas, hoursAs: 'comment', unsupported: camposPropios(args.fields), warnings: d.warnings } };
}

/**
 * Los issues con la etiqueta EXACTA, abiertos y cerrados, de todas las páginas; un pull request no es un pedido. Una
 * búsqueda que no se pudo hacer entera es `no_medido`, nunca una lista vacía.
 */
function find(args, ctx) {
  if (typeof args.tag !== 'string' || !/^[A-Za-z0-9:_.-]{1,100}$/.test(args.tag)) return no('rechazado', `la etiqueta no es válida: ${JSON.stringify(args.tag)}`);
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const ids = [];
  for (let pagina = 1; ; pagina++) {
    const g = gh(ctx, 'GET', `repos/${d.repo}/issues?labels=${encodeURIComponent(args.tag)}&state=all&per_page=100&page=${pagina}`);
    if (g.problem) return no('no_medido', `no se pudo buscar la etiqueta ${args.tag}: ${g.problem.detail}`);
    if (!Array.isArray(g.value)) return no('no_medido', 'la búsqueda no devolvió la lista de issues');
    // GitHub no distingue mayúsculas en las etiquetas: la comparación tampoco
    for (const i of g.value) if (i && !i.pull_request && Number.isInteger(i.number) && etiquetas(i).some((x) => x.toLowerCase() === args.tag.toLowerCase())) ids.push(i.number);
    if (g.value.length < 100) break;
  }
  return { ok: true, value: { tag: args.tag, ids: [...new Set(ids)].sort((a, b) => a - b), warnings: [...d.warnings] } };
}

/** El estado del issue: cerrado es `state: closed`; si no, la etiqueta `estado:` o «abierto». */
function read(args, ctx) {
  if (!idValido(args.id)) return no('rechazado', `el número del issue no es un número: ${JSON.stringify(args.id)}`);
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const id = Number(String(args.id).trim());
  const g = gh(ctx, 'GET', `repos/${d.repo}/issues/${id}`);
  if (g.problem) return g.problem;
  if (!g.value || typeof g.value.state !== 'string') return no('no_medido', `gh no devolvió el estado del issue #${id}`);
  const cerrado = g.value.state === 'closed';
  const etiqueta = (etiquetas(g.value).find((l) => /^estado:/.test(l)) || '').replace(/^estado:/, '');
  return { ok: true, value: { id, estado: cerrado ? 'cerrado' : (etiqueta || 'abierto'), cerrado, warnings: [...d.warnings] } };
}

module.exports = { 'work-item.create': create, 'work-item.update': update, 'work-item.close': close, 'work-item.find': find, 'work-item.read': read };
