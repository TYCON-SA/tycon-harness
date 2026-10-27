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
//            (--assigned-to va con auto_assign o en el pedido de la noche; la descripción, los criterios y un campo
//            propio que empieza con «@» van por archivo: az lee como archivo un valor que empieza con «@»)
//            az boards work-item relation add --organization <org> --id <id> --relation-type parent --target-id <Epic> --output json
//   activo:  az boards work-item show --organization <org> --id <id> --query fields."System.State" --output tsv
//            az boards work-item update --organization <org> --id <id> --state <activo> --output json
//            az boards work-item update --organization <org> --id <id> --assigned-to <correo> --output json   (con auto_assign)
//   cerrar:  az boards work-item update --organization <org> --id <id> --discussion <comentario> --output json
//            az boards work-item update --organization <org> --id <id> --state <cerrado> --fields Microsoft.VSTS.Scheduling.CompletedWork=<horas> --output json
//   buscar:  az devops invoke --organization <org> --area wit --resource wiql --route-parameters project=<proyecto> --http-method POST --in-file <consulta> --api-version 7.1 --output json
//            az boards work-item show --organization <org> --id <id> --output json   (por cada resultado: la etiqueta exacta)
//   leer:    az boards work-item show --organization <org> --id <id> --output json
//            az devops invoke --organization <org> --area wit --resource workItemTypeStates --route-parameters project=<proyecto> type=<tipo> --api-version 7.1 --output json

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { llamadaAz } = require('./change-requests.js');

// El estado activo según la plantilla de proceso, desde el estado inicial (Basic, Agile, CMMI); en Scrum `New` pasa a
// `Committed`, que se declara con `state_active`. Lo que diga la configuración manda.
const ACTIVO = { 'To Do': 'Doing', New: 'Active', Approved: 'Active', Proposed: 'Active' };
const INICIALES = ['To Do', 'New', 'Approved', 'Proposed'];
// los estados activos de las cuatro plantillas: un pedido que ya está en uno no se mueve (Basic no tiene «Active»)
const ACTIVOS = ['Active', 'Doing', 'Committed', 'In Progress'];
const CERRADOS = ['Closed', 'Resolved', 'Done', 'Removed'];
const HORAS = 'Microsoft.VSTS.Scheduling.CompletedWork';

const no = (reason, detail) => ({ ok: false, reason, detail });

/**
 * La llamada a az: `{ args, shell, cleanup }` o `{ problem, cleanup }`. En Windows `az` es az.cmd y va por la consola
 * (`llamadaAz`): un valor que la consola interpretaría (un título con comillas, «&» o «%», la consulta con comillas del
 * estado) va por archivo, que az lee cuando el argumento empieza con «@». Fuera de Windows, o con un doble con ruta, la
 * llamada no cambia. `cleanup()` borra los archivos.
 */
function azConsoleCall(cmd, args, platform = process.platform) {
  const direct = llamadaAz(cmd, args, platform);
  if (!direct.problem) return { ...direct, cleanup: () => {} };
  let dir = null;
  const cleanup = () => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); };
  const routed = args.map((a, i) => {
    if (!llamadaAz(cmd, [a], platform).problem) return a;
    if (!dir) dir = fs.mkdtempSync(path.join(os.tmpdir(), 'az-arg-'));
    const f = path.join(dir, `arg-${i}.txt`);
    fs.writeFileSync(f, a);
    return `@${f}`;
  });
  const call = llamadaAz(cmd, routed, platform);
  // az parte el argumento en el primer «=»: una carpeta temporal con «=» no se leería como archivo
  const problem = call.problem || (dir && dir.includes('=') ? 'az: la carpeta temporal tiene «=»' : null);
  if (problem) { cleanup(); return { problem: `${problem} (carpeta temporal: ${dir})`, cleanup: () => {} }; }
  return { ...call, cleanup };
}

function az(ctx, args) {
  const cmd = ctx.env.TYCON_ADO_CMD || 'az';
  const call = azConsoleCall(cmd, args);
  // no corrió: nada se creó ni se cambió
  if (call.problem) return { problem: no('rechazado', call.problem) };
  let r;
  try {
    r = spawnSync(cmd, call.args, { env: ctx.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000, shell: call.shell, windowsHide: true });
  } finally { call.cleanup(); }
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
const extras = (fields) => Object.entries(fields && typeof fields === 'object' ? fields : {}).map(([k, v]) => [k, v]);

/**
 * Los campos como argumentos de `--fields`: `porArchivo` (y todo valor que empieza con «@») va como `Campo=@<archivo>`
 * con el texto tal cual, para que az no lea un archivo de la máquina. `limpiar()` borra los archivos.
 */
function camposConArchivos(pares, porArchivo) {
  let dir = null;
  const salida = pares.map(([k, v], i) => {
    const s = String(v);
    if (!porArchivo.includes(k) && !s.startsWith('@')) return `${k}=${s}`;
    if (!dir) dir = fs.mkdtempSync(path.join(os.tmpdir(), 'az-campo-'));
    const f = path.join(dir, `campo-${i}.txt`);
    fs.writeFileSync(f, s);
    return `${k}=@${f}`;
  });
  return { salida, limpiar: () => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } };
}
// el nombre de un campo propio: el nombre de referencia de Azure DevOps (`Custom.Probabilidad`, o el que Azure arma con
// un GUID, con guiones después del punto), nunca algo que az lea como opción
const camposMalos = (fields) => Object.keys(fields && typeof fields === 'object' ? fields : {}).filter((k) => !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)*$/.test(k));

// los obligatorios que el pedido ya trae (o que Azure pone solo); los mismos que el Bug de dependencias
const CAMPOS_PROPIOS = new Set(['System.Title', 'System.State', 'System.AreaId', 'System.AreaPath', 'System.IterationId', 'System.IterationPath',
  'System.TeamProject', 'System.WorkItemType', 'System.Description', 'System.Tags', 'System.AssignedTo', 'System.Reason']);
// una lectura de tipos que no se pudo hacer no se crea; no_medido no vale acá: quien llama lo lee como «pudo crearlo»
const sinCrear = (p, que) => no(p.reason === 'no_medido' ? 'rechazado' : p.reason, `no pude leer ${que}: no se crea (${p.detail})`);
// el nombre de un tipo, como el que el ciclo copia al registro: va en la ruta de la API, nada que la cambie
const tipoConForma = (t) => typeof t === 'string' && /^[\p{L}\p{N} _-]{1,64}$/u.test(t);
// el nombre de un proyecto, con las reglas de Azure DevOps: hasta 64, sin control ni \ / : * ? " ' < > ; # $ % { } , + = [ ] |,
// sin empezar con «_» ni empezar o terminar con «.»
const proyectoConForma = (p) => typeof p === 'string' && /^[^\p{Cc}\\/:*?"'<>;#$%{},+=[\]|]{1,64}$/u.test(p) && !/^[_.]|\.$/.test(p);

/**
 * El tipo con que se crea el pedido de la noche (`typeOrBacklog`), como lo elige dependencias: el configurado si existe
 * en el proyecto; si no existe (VS402323), o sin tipo, su elemento de backlog. `{ tipo, fallback }` o `{ problem }`: sin
 * poder leer los tipos, o con un obligatorio sin valor por defecto que el pedido no trae, no se crea.
 */
function tipoDeLaNoche(ctx, org, project, configurado, fields) {
  const leerCampos = (tipo) => azJson(ctx, ['devops', 'invoke', '--organization', org, '--area', 'wit', '--resource', 'workitemtypesfield',
    '--route-parameters', `project=${project}`, `type=${tipo}`, '--api-version', '7.1', '--output', 'json']);
  if (configurado && !tipoConForma(configurado)) return { problem: no('rechazado', `el tipo configurado no tiene forma de nombre de tipo: no se crea`) };
  let tipo = configurado;
  let fallback = false;
  let campos = configurado ? leerCampos(configurado) : null;
  if (campos && campos.problem && !/VS402323/.test(campos.problem.detail)) return { problem: sinCrear(campos.problem, `los campos del tipo ${configurado} en ${project}`) };
  if (!campos || campos.problem) {
    const cat = azJson(ctx, ['devops', 'invoke', '--organization', org, '--area', 'wit', '--resource', 'workitemtypecategories',
      '--route-parameters', `project=${project}`, '--api-version', '7.1', '--output', 'json']);
    if (cat.problem) return { problem: sinCrear(cat.problem, `la categoría de elemento de backlog de ${project}`) };
    const filas = cat.value && cat.value.value;
    const fila = Array.isArray(filas) ? filas.find((x) => x && x.referenceName === 'Microsoft.RequirementCategory') : null;
    tipo = fila && fila.defaultWorkItemType && tipoConForma(fila.defaultWorkItemType.name) ? fila.defaultWorkItemType.name : null;
    if (!tipo) return { problem: no('rechazado', `${project} no tiene una categoría de elemento de backlog legible: no se inventa un tipo`) };
    fallback = true;
    campos = leerCampos(tipo);
    if (campos.problem) return { problem: sinCrear(campos.problem, `los campos del tipo ${tipo} en ${project}`) };
  }
  const lista = campos.value && campos.value.value;
  if (!Array.isArray(lista)) return { problem: no('rechazado', `no pude leer los campos del tipo ${tipo} en ${project}: la respuesta no trae «value»; no se crea`) };
  const traidos = new Set(Object.keys(fields && typeof fields === 'object' ? fields : {}));
  const sinDefecto = (x) => x.defaultValue === undefined || x.defaultValue === null || x.defaultValue === '';
  const faltan = lista.filter((x) => x && x.alwaysRequired === true && sinDefecto(x) && !CAMPOS_PROPIOS.has(x.referenceName) && !traidos.has(x.referenceName)).map((x) => x.referenceName);
  if (faltan.length) return { problem: no('rechazado', `el tipo ${tipo} de ${project} exige campos que el pedido no trae (${faltan.join(', ')}): no se crea`) };
  return { tipo, fallback };
}

function create(args, ctx) {
  if (typeof args.title !== 'string' || !args.title.trim()) return no('rechazado', 'falta el título del pedido de trabajo');
  const malos = camposMalos(args.fields);
  if (malos.length) return no('rechazado', `un campo propio tiene que ser un nombre de referencia (Custom.Nombre): ${malos.join(', ')}`);
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const { c, org } = d;
  const project = args.project || c.project || ctx.env.TYCON_ADO_PROJECT;
  if (!project) return no('sin_plataforma', 'el repo no dice en qué proyecto de Azure DevOps van sus pedidos: project en .tycon/work-items.yaml');
  let type = args.type || c.type;
  let fallback = false;
  if (args.typeOrBacklog === true) {
    const t = tipoDeLaNoche(ctx, org, String(project), type || null, args.fields);
    if (t.problem) return t.problem;
    ({ tipo: type, fallback } = t);
  }
  if (!type) return no('sin_plataforma', 'el repo no dice el tipo de sus pedidos de trabajo: type en .tycon/work-items.yaml (Agile: "User Story"; Scrum: "Product Backlog Item")');
  const sprint = args.sprint !== undefined && /^\d+$/.test(String(args.sprint)) ? String(args.sprint) : null;
  const iteracion = args.iteration || c.iteration_path || (c.iteration_auto_from_frontmatter === true && sprint ? `${c.iteration_root || project}\\Sprint ${sprint}` : '');
  const tags = [...String(c.default_tags || '').split(/[;,]/), ...(Array.isArray(args.tags) ? args.tags : [])].map((t) => String(t).trim()).filter(Boolean);
  // los campos de la skill de creación, en su orden; uno vacío no se manda
  const campos = [
    ['System.Description', args.description], ['Microsoft.VSTS.Common.AcceptanceCriteria', args.acceptance],
    ['Microsoft.VSTS.Common.Priority', args.priority], ['System.AreaPath', c.area_path], ['System.IterationPath', iteracion],
    ['System.Tags', tags.join('; ')],
  ].filter(([, v]) => v !== undefined && v !== null && String(v) !== '');
  const todos = camposConArchivos([...campos, ...extras(args.fields)], ['System.Description', 'Microsoft.VSTS.Common.AcceptanceCriteria', 'Microsoft.VSTS.TCM.ReproSteps']);
  const pedido = ['boards', 'work-item', 'create', '--organization', org, '--project', valor(project), '--type', valor(type), '--title', valor(args.title)];
  if (todos.salida.length) pedido.push('--fields', ...todos.salida);
  // auto_assign decide si el pedido de una story va a quien la crea; el de la noche no tiene autor y va siempre al
  // responsable que eligió la organización (forNight)
  const asignar = Boolean(args.assignTo) && (c.auto_assign === true || args.forNight === true);
  if (asignar) pedido.push('--assigned-to', valor(args.assignTo));
  pedido.push('--output', 'json');
  let r;
  try { r = azJson(ctx, pedido); } finally { todos.limpiar(); }
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
  if (args.typeOrBacklog === true) {
    value.type = String(type);
    if (fallback) {
      value.typeFallback = true;
      value.typeAsked = args.type || c.type || null;
      warnings.push(args.type || c.type ? `el tipo «${args.type || c.type}» no existe en ${project}: el pedido #${id} va como ${type}, su elemento de backlog` : `sin tipo configurado: el pedido #${id} va como ${type}, el elemento de backlog de ${project}`);
    }
  }
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
  const campos = camposConArchivos([...(horas !== null ? [[HORAS, horas]] : []), ...extras(args.fields)], []);
  const pedido = ['boards', 'work-item', 'update', '--organization', org, '--id', id, '--state', valor(args.state || c.state_closed || 'Closed')];
  if (campos.salida.length) pedido.push('--fields', ...campos.salida);
  pedido.push('--output', 'json');
  let u;
  try { u = azJson(ctx, pedido); } finally { campos.limpiar(); }
  // con el comentario ya publicado, el «no» dice que quedó a medias: reintentar lo publicaría de nuevo
  if (u.problem) return comentado ? no(u.problem.reason, `a medias: el comentario ya quedó en el pedido #${id}; falló el estado y las horas: ${u.problem.detail}`) : u.problem;
  return { ok: true, value: { id: Number(id), hours: horas, hoursAs: 'field', hoursField: 'CompletedWork', unsupported: [], warnings: d.warnings } };
}

// una etiqueta que entra en la consulta sin escaparla: letras, números y «:_.-»
const etiquetaValida = (t) => typeof t === 'string' && /^[A-Za-z0-9:_.-]{1,100}$/.test(t);

/**
 * Los pedidos con la etiqueta EXACTA (`arnes:abc` no es `arnes:abc-1`), acotados al proyecto. La consulta busca por
 * contenido y la etiqueta de cada resultado se relee. Una búsqueda que no se pudo hacer entera es `no_medido`, nunca
 * una lista vacía: quien la usa decide si crear, y crear de más es un duplicado en el tablero.
 */
function find(args, ctx) {
  if (!etiquetaValida(args.tag)) return no('rechazado', `la etiqueta no es segura para la consulta: ${JSON.stringify(args.tag)}`);
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const { c, org } = d;
  const project = args.project || c.project || ctx.env.TYCON_ADO_PROJECT;
  if (!project) return no('sin_plataforma', 'el repo no dice en qué proyecto de Azure DevOps van sus pedidos: project en .tycon/work-items.yaml');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'az-wiql-'));
  const consulta = path.join(dir, 'consulta.json');
  let q;
  try {
    // sin [System.TeamProject] = @project la ruta del proyecto no acota: volverían pedidos de toda la organización
    fs.writeFileSync(consulta, JSON.stringify({ query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS '${args.tag}'` }));
    q = azJson(ctx, ['devops', 'invoke', '--organization', org, '--area', 'wit', '--resource', 'wiql', '--route-parameters', `project=${project}`,
      '--http-method', 'POST', '--in-file', consulta, '--api-version', '7.1', '--output', 'json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  if (q.problem) return no('no_medido', `no se pudo buscar la etiqueta ${args.tag}: ${q.problem.detail}`);
  const lista = q.value && q.value.workItems;
  if (!Array.isArray(lista)) return no('no_medido', 'la búsqueda no devolvió la lista de pedidos');
  const buscada = args.tag.toLowerCase();
  const ids = [];
  for (const id of [...new Set(lista.map((w) => w && w.id).filter(Number.isInteger))]) {
    const s = azJson(ctx, ['boards', 'work-item', 'show', '--organization', org, '--id', String(id), '--output', 'json']);
    if (s.problem) return no('no_medido', `no se pudo releer la etiqueta del pedido #${id}: ${s.problem.detail}`);
    const tags = String((s.value && s.value.fields && s.value.fields['System.Tags']) || '').split(';').map((t) => t.trim().toLowerCase());
    if (tags.includes(buscada)) ids.push(id);
  }
  return { ok: true, value: { tag: args.tag, ids: ids.sort((a, b) => a - b), warnings: [...d.warnings] } };
}

/**
 * El estado del pedido y si está cerrado. Cerrado sale de la categoría del estado en el proyecto y el tipo del pedido
 * (Completed o Removed), no de su nombre: Resolved no es cerrado, y Done lo es en Basic y Scrum.
 */
function read(args, ctx) {
  if (!idValido(args.id)) return no('rechazado', `el id del pedido de trabajo no es un número: ${JSON.stringify(args.id)}`);
  const d = destino(args, ctx);
  if (d.problem) return d.problem;
  const { org } = d;
  const id = String(args.id).trim();
  const s = azJson(ctx, ['boards', 'work-item', 'show', '--organization', org, '--id', id, '--output', 'json']);
  if (s.problem) return s.problem;
  const f = (s.value && s.value.fields) || {};
  const estado = f['System.State'];
  const tipo = f['System.WorkItemType'];
  const proyecto = f['System.TeamProject'];
  if (![estado, tipo, proyecto].every((x) => typeof x === 'string' && x)) return no('no_medido', `az no devolvió el estado, el tipo o el proyecto del pedido #${id}`);
  // van a --route-parameters: un valor con «=» o un espacio de más agregaría otro parámetro de ruta
  if (!tipoConForma(tipo) || !proyectoConForma(proyecto)) return no('no_medido', `az devolvió un tipo o un proyecto sin forma de nombre para el pedido #${id}`);
  const e = azJson(ctx, ['devops', 'invoke', '--organization', org, '--area', 'wit', '--resource', 'workItemTypeStates',
    '--route-parameters', `project=${proyecto}`, `type=${tipo}`, '--api-version', '7.1', '--output', 'json']);
  if (e.problem) return no('no_medido', `no se pudieron leer los estados de ${tipo} en ${proyecto}: ${e.problem.detail}`);
  const fila = ((e.value && e.value.value) || []).find((x) => x && x.name === estado);
  if (!fila) return no('no_medido', `el estado ${estado} no está entre los de ${tipo} en ${proyecto}`);
  return { ok: true, value: { id: Number(id), estado, cerrado: fila.category === 'Completed' || fila.category === 'Removed', warnings: [...d.warnings] } };
}

module.exports = { 'work-item.create': create, 'work-item.update': update, 'work-item.close': close, 'work-item.find': find, 'work-item.read': read };
Object.defineProperty(module.exports, 'azConsoleCall', { value: azConsoleCall, enumerable: false });
