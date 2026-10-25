'use strict';
// work-items.js — el pedido de trabajo de la historia en Azure DevOps: crearlo (hijo de su Epic), marcarlo activo y
// cerrarlo con las horas en CompletedWork (nunca en Effort, que son puntos). Pide a az lo mismo que pedían los pasos del
// pipeline y la skill de creación, comando por comando; lo único que suma es `--output` en cada uno, para leer la
// respuesta sin depender de la configuración de az de cada máquina.
//
// Dónde: la configuración del repo de historias (scripts/lib/platform/work-items-config.js); la organización, la del
// repo y si no la de la máquina (`ado.org`). Un id que no es un número no llega a az.
//
// Los comandos, en el orden en que corren:
//   crear:   az boards work-item create --organization <org> --project <proyecto> --type <tipo> --title <título> --fields <campos> [--assigned-to <correo>] --output json
//            (--assigned-to va con auto_assign o en el pedido de la noche)
//            az boards work-item relation add --organization <org> --id <id> --relation-type parent --target-id <Epic> --output json
//   activo:  az boards work-item show --organization <org> --id <id> --query fields."System.State" --output tsv
//            az boards work-item update --organization <org> --id <id> --state <activo> --output json
//            az boards work-item update --organization <org> --id <id> --assigned-to <correo> --output json   (con auto_assign)
//   cerrar:  az boards work-item update --organization <org> --id <id> --discussion <comentario> --output json
//            az boards work-item update --organization <org> --id <id> --state <cerrado> --fields Microsoft.VSTS.Scheduling.CompletedWork=<horas> --output json

const path = require('path');
const { spawnSync } = require('child_process');

// El estado activo según la plantilla de proceso, desde el estado inicial (Basic, Agile, CMMI); en Scrum `New` pasa a
// `Committed`, que se declara con `state_active`. Lo que diga la configuración manda.
const ACTIVO = { 'To Do': 'Doing', New: 'Active', Approved: 'Active', Proposed: 'Active' };
const INICIALES = ['To Do', 'New', 'Approved', 'Proposed'];
// los estados activos de las cuatro plantillas: un pedido que ya está en uno no se mueve (Basic no tiene «Active»)
const ACTIVOS = ['Active', 'Doing', 'Committed', 'In Progress'];
const CERRADOS = ['Closed', 'Resolved', 'Done', 'Removed'];
const HORAS = 'Microsoft.VSTS.Scheduling.CompletedWork';

const no = (reason, detail) => ({ ok: false, reason, detail });

function az(ctx, args) {
  const cmd = ctx.env.TYCON_ADO_CMD || 'az';
  const r = spawnSync(cmd, args, { env: ctx.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  if (r.error) return { problem: no('no_medido', `${cmd} no se pudo ejecutar (${r.error.code || r.error.message})`) };
  if (r.status !== 0) {
    // el texto de az, recortado: el detalle llega a la salida (la capa lo limpia de credenciales y direcciones)
    const t = `${r.stderr || ''} ${r.stdout || ''}`.trim().replace(/\s+/g, ' ').slice(0, 500);
    // por los mensajes de az y de Azure DevOps, no por un número suelto en el texto (un id o un campo pueden tenerlo)
    if (/please run 'az login'|TF400813|\b(401|403) (Client Error|Unauthorized|Forbidden)\b|\bUnauthorized\b|not authorized/i.test(t)) return { problem: no('sin_credencial', `Azure DevOps no aceptó la sesión de az de esta máquina (az login, o AZURE_DEVOPS_EXT_PAT): ${t}`) };
    if (/TF401232|work item \d+ does not exist|\b404 (Client Error|Not Found)\b/i.test(t)) return { problem: no('no_encontrado', t) };
    if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|Failed to establish a new connection|Max retries exceeded|timed out/i.test(t)) return { problem: no('red', t) };
    return { problem: no('rechazado', t || `az salió ${r.status}`) };
  }
  return { out: r.stdout };
}
function azJson(ctx, args) {
  const r = az(ctx, args);
  if (r.problem) return r;
  try { return { value: JSON.parse(r.out) }; } catch (_) { return { problem: no('no_medido', 'az contestó algo que no es JSON') }; }
}

/** La organización y la configuración del repo: `{c, org}` o `{problem}`. */
function destino(args, ctx) {
  const W = require(path.join(ctx.root, 'scripts', 'lib', 'platform', 'work-items-config.js'));
  const leido = W.read(args.repoDir || process.cwd());
  if (leido.problem) return { problem: no('no_medido', `no pude leer la configuración del pedido de trabajo: ${leido.problem}`) };
  const c = leido.config || {};
  // el pedido de la noche trae los suyos (operations.json): ganan sobre los del repo
  let org = args.org || c.org;
  if (!org) {
    const rota = ctx.configProblem('ado');
    if (rota) return { problem: no('no_medido', `no pude leer la configuración de esta máquina: ${rota}`) };
    org = ctx.configValue('ado.org');
  }
  if (!org) return { problem: no('sin_credencial', 'falta la organización de Azure DevOps: org en .tycon/work-items.yaml del repo, o harness.js config set ado.org <organización>') };
  // la sesión de az va sólo a Azure DevOps: un nombre, o una dirección de dev.azure.com o de <org>.visualstudio.com
  org = String(org).trim().replace(/\/+$/, '');
  // las claves de la configuración que el conector no conoce se dicen: una mal escrita se ignoraría callada
  const warnings = (leido.unknown || []).length ? [`${path.basename(leido.file)} trae claves que no conozco: ${leido.unknown.join(', ')}`] : [];
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(org)) return { c, org: `https://dev.azure.com/${org}`, warnings };
  if (/^https:\/\/(dev\.azure\.com\/[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9-]*\.visualstudio\.com)$/i.test(org)) return { c, org, warnings };
  return { problem: no('rechazado', 'la organización del pedido de trabajo no es de Azure DevOps (un nombre, https://dev.azure.com/<org> o https://<org>.visualstudio.com)') };
}

// un valor que empieza con «-» az lo leería como una opción: va con un espacio adelante, que lo deja como texto
const valor = (v) => { const s = String(v); return s.startsWith('-') ? ` ${s}` : s; };

const idValido = (id) => /^\d+$/.test(String(id == null ? '' : id).trim());
const horasDe = (args) => {
  // las horas, un número o un texto con un número: `' '`, `true` o `[]` no son 0 ni 1 horas
  if (args.hours !== undefined && args.hours !== null && args.hours !== '') {
    return (typeof args.hours === 'number' || (typeof args.hours === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(args.hours))) ? Number(args.hours) : NaN;
  }
  if (Number.isInteger(args.seconds) && args.seconds >= 0) return Math.round((args.seconds / 3600) * 100) / 100;
  // segundos que no son un entero no se toman por «sin horas»: se rechazan
  if (args.seconds !== undefined && args.seconds !== null) return NaN;
  return null;
};
const extras = (fields) => Object.entries(fields && typeof fields === 'object' ? fields : {}).map(([k, v]) => `${k}=${v}`);
// el nombre de un campo propio: el nombre de referencia de Azure DevOps (`Custom.Probabilidad`), nunca algo que az lea
// como opción
const camposMalos = (fields) => Object.keys(fields && typeof fields === 'object' ? fields : {}).filter((k) => !/^[A-Za-z][A-Za-z0-9_.]*$/.test(k));

function create(args, ctx) {
  if (typeof args.title !== 'string' || !args.title.trim()) return no('rechazado', 'falta el título del pedido de trabajo');
  const malos = camposMalos(args.fields);
  if (malos.length) return no('rechazado', `un campo propio tiene que ser un nombre de referencia (Custom.Nombre): ${malos.join(', ')}`);
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const { c, org } = d;
  const project = args.project || c.project || ctx.env.TYCON_ADO_PROJECT;
  if (!project) return no('sin_plataforma', 'el repo no dice en qué proyecto de Azure DevOps van sus pedidos: project en .tycon/work-items.yaml');
  const type = args.type || c.type;
  if (!type) return no('sin_plataforma', 'el repo no dice el tipo de sus pedidos de trabajo: type en .tycon/work-items.yaml (Agile: "User Story"; Scrum: "Product Backlog Item")');
  const sprint = args.sprint !== undefined && /^\d+$/.test(String(args.sprint)) ? String(args.sprint) : null;
  const iteracion = args.iteration || c.iteration_path || (c.iteration_auto_from_frontmatter === true && sprint ? `${c.iteration_root || project}\\Sprint ${sprint}` : '');
  const tags = [...String(c.default_tags || '').split(/[;,]/), ...(Array.isArray(args.tags) ? args.tags : [])].map((t) => String(t).trim()).filter(Boolean);
  // los campos de la skill de creación, en su orden; uno vacío no se manda
  const campos = [
    ['System.Description', args.description], ['Microsoft.VSTS.Common.AcceptanceCriteria', args.acceptance],
    ['Microsoft.VSTS.Common.Priority', args.priority], ['System.AreaPath', c.area_path], ['System.IterationPath', iteracion],
    ['System.Tags', tags.join('; ')],
  ].filter(([, v]) => v !== undefined && v !== null && String(v) !== '').map(([k, v]) => `${k}=${v}`);
  const todos = [...campos, ...extras(args.fields)];
  const pedido = ['boards', 'work-item', 'create', '--organization', org, '--project', valor(project), '--type', valor(type), '--title', valor(args.title)];
  if (todos.length) pedido.push('--fields', ...todos);
  // auto_assign decide si el pedido de una story va a quien la crea; el de la noche no tiene autor y va siempre al
  // responsable que eligió la organización (forNight)
  const asignar = Boolean(args.assignTo) && (c.auto_assign === true || args.forNight === true);
  if (asignar) pedido.push('--assigned-to', valor(args.assignTo));
  pedido.push('--output', 'json');
  const r = azJson(ctx, pedido);
  if (r.problem) return r.problem;
  const id = r.value && r.value.id;
  if (!Number.isInteger(id)) return no('no_medido', 'az creó algo, pero la respuesta no trae el id');
  const warnings = [...d.warnings];
  if (!iteracion && c.iteration_auto_from_frontmatter === true) warnings.push(`la historia no trae un sprint numérico: el pedido #${id} quedó en el backlog, sin iteración`);
  if (args.epic !== undefined && args.epic !== null && String(args.epic) !== '') {
    const epica = (c.epic_links || {})[String(args.epic)];
    if (epica === undefined || !idValido(epica)) warnings.push(`la épica «${args.epic}» no tiene mapeo en epic_links: el pedido #${id} quedó suelto (agregá su Epic a la configuración y vinculalo, o hacelo en el tablero)`);
    else {
      const rel = azJson(ctx, ['boards', 'work-item', 'relation', 'add', '--organization', org, '--id', String(id), '--relation-type', 'parent', '--target-id', String(epica), '--output', 'json']);
      if (rel.problem) warnings.push(`el pedido #${id} se creó, pero no se pudo colgar del Epic ${epica}: ${rel.problem.detail}`);
    }
  }
  const value = { id, url: `${org}/${encodeURIComponent(String(project))}/_workitems/edit/${id}`, warnings, unsupported: [] };
  if (asignar) value.assigned = String(args.assignTo);
  return { ok: true, value };
}

function update(args, ctx) {
  if (!idValido(args.id)) return no('rechazado', `el id del pedido de trabajo no es un número: ${JSON.stringify(args.id)}`);
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const { c, org } = d;
  const id = String(args.id).trim();
  // con un comentario y sin estado, sólo se comenta: el estado no se lee ni se cambia, y uno cerrado no se reabre
  if (typeof args.comment === 'string' && args.comment.trim() && !args.state) {
    const k = azJson(ctx, ['boards', 'work-item', 'update', '--organization', org, '--id', id, '--discussion', valor(args.comment), '--output', 'json']);
    if (k.problem) return k.problem;
    return { ok: true, value: { id: Number(id), changed: false, commented: true, warnings: [...d.warnings] } };
  }
  const s = az(ctx, ['boards', 'work-item', 'show', '--organization', org, '--id', id, '--query', 'fields."System.State"', '--output', 'tsv']);
  if (s.problem) return s.problem;
  const previo = String(s.out).trim();
  // un estado vacío (o el «None» con que az imprime un null) no es un estado: no se inventa a cuál pasar
  if (!previo || previo === 'None') return no('no_medido', `az no devolvió el estado del pedido #${id}`);
  const estado = args.state || c.state_active || ACTIVO[previo] || (ACTIVOS.includes(previo) ? previo : 'Active');
  const warnings = [...d.warnings];
  const base = { id: Number(id), estado: previo, previo };
  if (previo === estado) return { ok: true, value: { ...base, changed: false, warnings } };
  if ((CERRADOS.includes(previo) || previo === c.state_closed) && args.reopen !== true) {
    warnings.push(`el pedido #${id} está en ${previo}: reabrir a ${estado} lo decide una persona (puede romper la trazabilidad)`);
    // el aviso lo dice en texto; el campo es para el núcleo, que pide la confirmación
    return { ok: true, value: { ...base, changed: false, pideReabrir: true, warnings } };
  }
  if (!INICIALES.includes(previo) && !CERRADOS.includes(previo)) warnings.push(`estado ${previo} sin mapeo conocido: pasa a ${estado}; si el proceso usa otro nombre, declaralo en state_active`);
  const u = azJson(ctx, ['boards', 'work-item', 'update', '--organization', org, '--id', id, '--state', valor(estado), '--output', 'json']);
  if (u.problem) return u.problem;
  if (c.auto_assign === true && args.assignTo) {
    const a = azJson(ctx, ['boards', 'work-item', 'update', '--organization', org, '--id', id, '--assigned-to', valor(args.assignTo), '--output', 'json']);
    if (a.problem) warnings.push(`no se pudo asignar el pedido #${id}: ${a.problem.detail}`);
  }
  return { ok: true, value: { id: Number(id), estado, previo, changed: true, warnings } };
}

function close(args, ctx) {
  if (!idValido(args.id)) return no('rechazado', `el id del pedido de trabajo no es un número: ${JSON.stringify(args.id)}`);
  const horas = horasDe(args);
  if (horas !== null && !(Number.isFinite(horas) && horas >= 0)) return no('rechazado', `las horas no son un número: ${JSON.stringify(args.hours !== undefined ? args.hours : args.seconds)}`);
  const malos = camposMalos(args.fields);
  if (malos.length) return no('rechazado', `un campo propio tiene que ser un nombre de referencia (Custom.Nombre): ${malos.join(', ')}`);
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const { c, org } = d;
  const id = String(args.id).trim();
  let comentado = false;
  if (typeof args.comment === 'string' && args.comment.trim()) {
    const k = azJson(ctx, ['boards', 'work-item', 'update', '--organization', org, '--id', id, '--discussion', valor(args.comment), '--output', 'json']);
    if (k.problem) return k.problem;
    comentado = true;
  }
  const campos = [...(horas !== null ? [`${HORAS}=${horas}`] : []), ...extras(args.fields)];
  const pedido = ['boards', 'work-item', 'update', '--organization', org, '--id', id, '--state', valor(args.state || c.state_closed || 'Closed')];
  if (campos.length) pedido.push('--fields', ...campos);
  pedido.push('--output', 'json');
  const u = azJson(ctx, pedido);
  // con el comentario ya publicado, el «no» dice que quedó a medias: reintentar lo publicaría de nuevo
  if (u.problem) return comentado ? no(u.problem.reason, `a medias: el comentario ya quedó en el pedido #${id}; falló el estado y las horas: ${u.problem.detail}`) : u.problem;
  return { ok: true, value: { id: Number(id), hours: horas, hoursAs: 'field', hoursField: 'CompletedWork', unsupported: [], warnings: d.warnings } };
}

module.exports = { 'work-item.create': create, 'work-item.update': update, 'work-item.close': close };
