'use strict';
// work-items.js — el pedido de trabajo de la historia en GitHub: un issue. El tipo va como etiqueta `tipo:<Tipo>`, el
// estado como etiqueta `estado:<estado>` y las horas como un comentario de formato fijo («Horas completadas: N h»),
// porque un issue no tiene esos campos. Lo que GitHub no tiene (la prioridad, un campo propio, el Epic padre) no se
// carga en silencio: vuelve en `unsupported` con su nombre y el motivo `no_soportado`.
//
// Dónde: `repo: dueño/nombre` en la configuración del repo de historias (scripts/lib/platform/work-items-config.js).
// Habla por `gh api` (TYCON_GH_CMD lo reemplaza: un ejecutable, o un `.js` que corre con node).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const no = (reason, detail) => ({ ok: false, reason, detail });
const idValido = (id) => /^\d+$/.test(String(id == null ? '' : id).trim());
const noSoportado = (field, detail) => ({ field, reason: 'no_soportado', detail });

function gh(ctx, method, ruta, body) {
  const cmd = ctx.env.TYCON_GH_CMD || 'gh';
  const [bin, pre] = /\.js$/.test(cmd) ? [process.execPath, [cmd]] : [cmd, []];
  const args = [...pre, 'api', '--method', method, '-H', 'Accept: application/vnd.github+json', ruta];
  let dir = null;
  if (body) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-cuerpo-'));
    fs.writeFileSync(path.join(dir, 'cuerpo.json'), JSON.stringify(body));
    args.push('--input', path.join(dir, 'cuerpo.json'));
  }
  let r;
  try { r = spawnSync(bin, args, { env: ctx.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000 }); } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (r.error) return { problem: no('no_medido', `${cmd} no se pudo ejecutar (${r.error.code || r.error.message})`) };
  if (r.status !== 0) {
    // el texto de gh, recortado: el detalle llega a la salida (la capa lo limpia de credenciales y direcciones)
    const t = `${r.stderr || ''} ${r.stdout || ''}`.trim().replace(/\s+/g, ' ').slice(0, 500);
    // un 403 por el tope de pedidos no es una credencial que falta: se dice como lo que es
    if (/rate limit/i.test(t)) return { problem: no('rechazado', `GitHub frenó por el tope de pedidos; reintentar más tarde: ${t}`) };
    if (/HTTP 401|gh auth login|Bad credentials|HTTP 403.*(SAML|SSO|Resource not accessible)/i.test(t)) return { problem: no('sin_credencial', `GitHub no aceptó la sesión de gh de esta máquina (gh auth login, o GH_TOKEN): ${t}`) };
    if (/HTTP (404|410)/.test(t)) return { problem: no('no_encontrado', t) };
    if (/HTTP (403|422)/.test(t)) return { problem: no('rechazado', t) };
    if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|could not resolve|error connecting to/i.test(t)) return { problem: no('red', t) };
    return { problem: no('rechazado', t || `gh salió ${r.status}`) };
  }
  // una escritura que salió 0 se hizo aunque la respuesta no se entienda (tomarla por fallada invitaría a repetirla)
  try { return { value: JSON.parse(r.stdout) }; } catch (_) { return method === 'GET' ? { problem: no('no_medido', 'gh contestó algo que no es JSON') } : { value: null }; }
}

/** El repo de los issues y la configuración: `{c, repo}` o `{problem}`. */
function destino(args, ctx) {
  const W = require(path.join(ctx.root, 'scripts', 'lib', 'platform', 'work-items-config.js'));
  const leido = W.read(args.repoDir || process.cwd());
  if (leido.problem) return { problem: no('no_medido', `no pude leer la configuración del pedido de trabajo: ${leido.problem}`) };
  const c = leido.config || {};
  // el pedido de la noche trae el suyo (el repo del producto): gana sobre el de la configuración del repo
  const repo = String(args.repo || c.repo || (String(c.project || '').includes('/') ? c.project : '')).trim();
  // dueño/nombre, sin segmentos que empiecen con punto: «../..» armaría otra ruta de la API
  if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(repo)) return { problem: no('sin_plataforma', 'el repo no dice en qué repo de GitHub van sus issues: repo: dueño/nombre en .tycon/work-items.yaml') };
  const warnings = (leido.unknown || []).length ? [`${path.basename(leido.file)} trae claves que no conozco: ${leido.unknown.join(', ')}`] : [];
  return { c, repo, warnings };
}

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
    return { ok: true, value: { id, changed: false, commented: true, warnings: [...d.warnings] } };
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
    // el aviso lo dice en texto; el campo es para el núcleo, que pide la confirmación
    return { ok: true, value: { id, estado: previo, previo, changed: false, pideReabrir: true, warnings } };
  }
  if (previa === estado && g.value.state !== 'closed') return { ok: true, value: { id, estado, previo, changed: false, warnings } };
  const cuerpo = { labels: [...sinEstado(ls), `estado:${estado}`] };
  if (g.value.state === 'closed') cuerpo.state = 'open';
  const p = gh(ctx, 'PATCH', `repos/${repo}/issues/${id}`, cuerpo);
  if (p.problem) return p.problem;
  return { ok: true, value: { id, estado, previo, changed: true, warnings } };
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
