'use strict';
// work-items.js — el pedido de trabajo de la historia en GitLab: un issue. El tipo va como etiqueta `tipo:<Tipo>` y el
// estado como etiqueta `estado:<estado>`. La estimación y las horas van a los campos nativos del issue: el tiempo
// estimado y el tiempo trabajado. Lo que un issue no tiene en todos los planes (la prioridad, un campo propio, el épico
// padre) no se carga en silencio: vuelve en `unsupported` con su nombre y el motivo `no_soportado`.
//
// Dónde: `repo: grupo/subgrupo/proyecto` en la configuración del repo de historias
// (scripts/lib/platform/work-items-config.js). El servidor es el del repo de GitLab con esa ruta que declara
// team-repos.json; sin declarar, el público sólo si la organización no declara ningún servidor propio (glab-api.js).
// Habla por `glab api` (TYCON_GLAB_CMD lo reemplaza: un ejecutable, o un `.js` que corre con node).

const path = require('path');
const { glab, todas, no, servidorDe, projectPath } = require('./glab-api.js');

const idValido = (id) => /^\d+$/.test(String(id == null ? '' : id).trim());
const noSoportado = (field, detail) => ({ field, reason: 'no_soportado', detail });
const igual = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** El proyecto de los issues y la configuración: `{c, host, p, warnings}` o `{problem}`. */
function destino(args, ctx) {
  const W = require(path.join(ctx.root, 'scripts', 'lib', 'platform', 'work-items-config.js'));
  const leido = W.read(args.repoDir || process.cwd());
  if (leido.problem) return { problem: no('no_medido', `no pude leer la configuración del pedido de trabajo: ${leido.problem}`) };
  const c = leido.config || {};
  // el pedido de la noche trae el suyo (el repo del producto): gana sobre el de la configuración del repo
  const ruta = String(args.repo || c.repo || (String(c.project || '').includes('/') ? c.project : '')).trim().replace(/^\/+|\/+$/g, '');
  const segmentos = ruta.split('/');
  const id = { namespace: segmentos.slice(0, -1).join('/'), repo: segmentos[segmentos.length - 1] };
  const p = projectPath(id);
  if (!p) return { problem: no('sin_plataforma', 'el repo no dice en qué proyecto de GitLab van sus issues: repo: grupo/proyecto en .tycon/work-items.yaml') };
  const s = servidorDe(ctx, id);
  if (s.problem) return { problem: s.problem };
  const { host } = s;
  const warnings = (leido.unknown || []).length ? [`${path.basename(leido.file)} trae claves que no conozco: ${leido.unknown.join(', ')}`] : [];
  return { c, host, p, warnings };
}

// ── la estimación y las horas: duraciones de GitLab ──
/** Horas como duración en minutos enteros («960m»): un número con decimales no depende de cómo lo lea GitLab. */
const enMinutos = (horas) => `${Math.round(horas * 60)}m`;

/** La duración de una estimación, o null si su unidad no es tiempo (los puntos). */
function duracionDe(e) {
  if (typeof e.hours === 'number') return enMinutos(e.hours);
  if (e.unit === 'hours') return enMinutos(e.value);
  // sin las horas por día de la organización, un día es el de GitLab
  if (e.unit === 'days') return Number.isInteger(e.value) ? `${e.value}d` : null;
  return null;
}

/**
 * La estimación vigente al tiempo estimado del issue. Lo anota en `value`; una que no se pudo cargar es un aviso, no un
 * «no»: el pedido ya quedó creado o actualizado.
 */
function estimar(ctx, d, id, e, value) {
  if (!e) return;
  const duracion = duracionDe(e);
  if (!duracion) { value.unsupported = [...(value.unsupported || []), noSoportado('Estimación', 'el tiempo estimado de un issue de GitLab va en horas o en días enteros')]; return; }
  const r = glab(ctx, d.host, 'POST', `${d.p}/issues/${id}/time_estimate`, { duration: duracion });
  if (r.problem) { value.warnings.push(`la estimación no se cargó en el issue #${id}: ${r.problem.detail}`); return; }
  Object.assign(value, { estimateAs: 'field', estimateField: 'el tiempo estimado' });
}

const etiquetas = (issue) => ((issue && issue.labels) || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
const sinEstado = (ls) => ls.filter((l) => !/^estado:/.test(l));
const camposPropios = (fields) => Object.keys(fields && typeof fields === 'object' ? fields : {}).map((k) => noSoportado(k, `GitLab no tiene el campo ${k} en un issue`));
const comentar = (ctx, d, id, texto) => glab(ctx, d.host, 'POST', `${d.p}/issues/${id}/notes`, { body: texto });

function create(args, ctx) {
  if (typeof args.title !== 'string' || !args.title.trim()) return no('rechazado', 'falta el título del pedido de trabajo');
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const { c } = d;
  const tipo = args.type || c.type;
  // una etiqueta no lleva coma: GitLab las recibe separadas por comas
  const labels = [...new Set([...(tipo ? [`tipo:${tipo}`] : []), ...String(c.default_tags || '').split(/[;,]/), ...(Array.isArray(args.tags) ? args.tags : [])]
    .map((t) => String(t).replace(/,/g, ' ').trim()).filter(Boolean))];
  const description = [args.description, args.acceptance ? `## Criterios de aceptación\n\n${args.acceptance}` : null].filter((x) => x && String(x).trim()).join('\n\n');
  const unsupported = [];
  if (args.priority !== undefined && args.priority !== null && String(args.priority) !== '') unsupported.push(noSoportado('Prioridad', 'un issue de GitLab no tiene prioridad'));
  unsupported.push(...camposPropios(args.fields));
  if (args.epic !== undefined && args.epic !== null && String(args.epic) !== '') unsupported.push(noSoportado('Épica', 'el issue no se cuelga de su épica en GitLab'));
  const warnings = [...d.warnings];
  const pedido = { title: args.title, description, labels: labels.join(',') };
  // auto_assign decide si el pedido de una story va a quien la crea; el de la noche va siempre al responsable (forNight)
  const asignar = Boolean(args.assignTo) && (c.auto_assign === true || args.forNight === true);
  let asignado = null;
  if (asignar) {
    // GitLab asigna por el id de la persona: se busca por su usuario, y uno que no está no frena el pedido
    const u = glab(ctx, d.host, 'GET', `users?username=${encodeURIComponent(String(args.assignTo))}`);
    const persona = !u.problem && Array.isArray(u.value) ? u.value.find((x) => x && igual(x.username, args.assignTo)) : null;
    if (persona && Number.isInteger(persona.id)) { pedido.assignee_ids = [persona.id]; asignado = String(args.assignTo); }
  }
  const r = glab(ctx, d.host, 'POST', `${d.p}/issues`, pedido);
  if (r.problem) return r.problem;
  const id = r.value && r.value.iid;
  if (!Number.isInteger(id)) return no('no_medido', 'glab creó algo, pero la respuesta no trae el número');
  const value = { id, url: String(r.value.web_url || ''), warnings, unsupported };
  if (asignar) {
    const quedo = ((r.value && r.value.assignees) || []).map((x) => x && x.username).filter(Boolean);
    value.assigned = asignado && quedo.some((x) => igual(x, asignado)) ? asignado : null;
    if (value.assigned === null) warnings.push(`el issue #${id} quedó sin asignar a ${args.assignTo}: GitLab no encontró a esa persona o no tiene acceso al proyecto`);
  }
  // una etiqueta que no quedó hace que el issue no se encuentre después por ella
  const quedaron = etiquetas(r.value).map((l) => l.toLowerCase());
  value.missingTags = labels.filter((l) => !quedaron.includes(l.toLowerCase()));
  estimar(ctx, d, id, args.estimate, value);
  return { ok: true, value };
}

function update(args, ctx) {
  if (!idValido(args.id)) return no('rechazado', `el número del issue no es un número: ${JSON.stringify(args.id)}`);
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const { c } = d;
  const id = Number(String(args.id).trim());
  // con un comentario y sin estado, sólo se comenta: ni etiquetas ni estado, y uno cerrado no se reabre
  if (typeof args.comment === 'string' && args.comment.trim() && !args.state) {
    const k = comentar(ctx, d, id, args.comment);
    if (k.problem) return k.problem;
    const value = { id, changed: false, commented: true, warnings: [...d.warnings] };
    estimar(ctx, d, id, args.estimate, value);
    return { ok: true, value };
  }
  const g = glab(ctx, d.host, 'GET', `${d.p}/issues/${id}`);
  if (g.problem) return g.problem;
  if (!g.value || typeof g.value.state !== 'string') return no('no_medido', `glab no devolvió el estado del issue #${id}`);
  const cerrado = g.value.state === 'closed';
  const ls = etiquetas(g.value);
  const previa = (ls.find((l) => /^estado:/.test(l)) || '').replace(/^estado:/, '');
  const previo = cerrado ? 'cerrado' : (previa || 'abierto');
  const estado = String(args.state || c.state_active || 'activo');
  const warnings = [...d.warnings];
  if (cerrado && args.reopen !== true) {
    warnings.push(`el issue #${id} está cerrado: reabrirlo lo decide una persona (puede romper la trazabilidad)`);
    if (args.estimate) warnings.push('la estimación no se cargó: el issue está cerrado');
    // el aviso lo dice en texto; el campo es para el núcleo, que pide la confirmación
    return { ok: true, value: { id, estado: previo, previo, changed: false, pideReabrir: true, warnings } };
  }
  if (previa === estado && !cerrado) {
    const value = { id, estado, previo, changed: false, warnings };
    estimar(ctx, d, id, args.estimate, value);
    return { ok: true, value };
  }
  const cuerpo = { labels: [...sinEstado(ls), `estado:${estado}`].join(',') };
  if (cerrado) cuerpo.state_event = 'reopen';
  const p = glab(ctx, d.host, 'PUT', `${d.p}/issues/${id}`, cuerpo);
  if (p.problem) return p.problem;
  const value = { id, estado, previo, changed: true, warnings };
  estimar(ctx, d, id, args.estimate, value);
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
  const { c } = d;
  const id = Number(String(args.id).trim());
  const g = glab(ctx, d.host, 'GET', `${d.p}/issues/${id}`);
  if (g.problem) return g.problem;
  // lo que ya quedó cargado cuando algo falla después: el «no» dice que quedó a medias (reintentar lo duplicaría)
  const hecho = [];
  const aMedias = (p) => (hecho.length ? no(p.reason, `a medias: ya quedó ${hecho.join(' y ')} en el issue #${id}; falló lo siguiente: ${p.detail}`) : p);
  if (typeof args.comment === 'string' && args.comment.trim()) {
    const k = comentar(ctx, d, id, args.comment);
    if (k.problem) return k.problem;
    hecho.push('el comentario');
  }
  // el tiempo trabajado se SUMA al que ya tiene el issue: cero horas no se cargan
  if (horas !== null && Math.round(horas * 60) > 0) {
    const h = glab(ctx, d.host, 'POST', `${d.p}/issues/${id}/add_spent_time`, { duration: enMinutos(horas) });
    if (h.problem) return aMedias(h.problem);
    hecho.push('el tiempo trabajado');
  }
  const p = glab(ctx, d.host, 'PUT', `${d.p}/issues/${id}`, { state_event: 'close', labels: [...sinEstado(etiquetas(g.value)), `estado:${c.state_closed || 'cerrado'}`].join(',') });
  if (p.problem) return aMedias(p.problem);
  return { ok: true, value: { id, hours: horas, hoursAs: 'field', hoursField: 'el tiempo trabajado', unsupported: camposPropios(args.fields), warnings: d.warnings } };
}

/**
 * Los issues con la etiqueta EXACTA, abiertos y cerrados, de todas las páginas. Una búsqueda que no se pudo hacer entera
 * es `no_medido`, nunca una lista vacía.
 */
function find(args, ctx) {
  if (typeof args.tag !== 'string' || !/^[A-Za-z0-9:_.-]{1,100}$/.test(args.tag)) return no('rechazado', `la etiqueta no es válida: ${JSON.stringify(args.tag)}`);
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const l = todas(ctx, d.host, `${d.p}/issues?labels=${encodeURIComponent(args.tag)}&state=all`);
  // sin sesión o sin red se dice como lo que es; cualquier otra falla es una búsqueda que no se hizo
  if (l.problem) return ['sin_credencial', 'red'].includes(l.problem.reason) ? l.problem : no('no_medido', `no se pudo buscar la etiqueta ${args.tag}: ${l.problem.detail}`);
  const ids = l.value.filter((i) => i && Number.isInteger(i.iid) && etiquetas(i).some((x) => igual(x, args.tag))).map((i) => i.iid);
  return { ok: true, value: { tag: args.tag, ids: [...new Set(ids)].sort((a, b) => a - b), warnings: [...d.warnings] } };
}

/** El estado del issue: cerrado es `state: closed`; si no, la etiqueta `estado:` o «abierto». */
function read(args, ctx) {
  if (!idValido(args.id)) return no('rechazado', `el número del issue no es un número: ${JSON.stringify(args.id)}`);
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const id = Number(String(args.id).trim());
  const g = glab(ctx, d.host, 'GET', `${d.p}/issues/${id}`);
  if (g.problem) return g.problem;
  if (!g.value || typeof g.value.state !== 'string') return no('no_medido', `glab no devolvió el estado del issue #${id}`);
  const cerrado = g.value.state === 'closed';
  const etiqueta = (etiquetas(g.value).find((l) => /^estado:/.test(l)) || '').replace(/^estado:/, '');
  return { ok: true, value: { id, estado: cerrado ? 'cerrado' : (etiqueta || 'abierto'), cerrado, warnings: [...d.warnings] } };
}

module.exports = { 'work-item.create': create, 'work-item.update': update, 'work-item.close': close, 'work-item.find': find, 'work-item.read': read };
