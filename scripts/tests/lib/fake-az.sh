#!/usr/bin/env bash
# fake-az.sh — el `az` de mentira de las suites que hablan con Azure DevOps.
#
# Vive en `lib/` para que las suites lo reusen en vez de copiarlo: dos dobles del mismo CLI se separan solos, igual que dos copias de un guion.
# La suite lo elige con `TYCON_ADO_CMD`. NUNCA habla con la red.
#
# ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────
# · Decide qué le pidieron por los ARGUMENTOS (no por el orden de las llamadas) y contesta desde
#   fixtures en `$FIXAZ/`, con la forma que devuelve Azure.
# · Anota CADA llamada en `$FIXAZ/llamadas.log`: `<paso>\t{"args":[…],"archivos":{ruta: contenido}}`.
#   Los archivos son los que el comando lee (`@archivo`, `Campo=@archivo`, `--in-file`), para poder
#   afirmar sobre el cuerpo de un Bug o de un comentario.
# · RECUERDA lo que crea (`$FIXAZ/creados/<id>.json`): la WIQL y `work-item show` lo devuelven igual
#   que Azure. Sin eso no se puede probar la segunda noche después de un push perdido.
#
# ── LAS TRAMPAS DE AZURE QUE REPRODUCE A PROPÓSITO ───────────────────────────────────────────────
# · Sin `--org`/`--organization` sale 1: el default de `az devops configure` apunta a un proyecto
#   que ya no existe (el de formularios), así que todo comando sin org explícita falla de verdad.
# · Sin `-o json`/`--output json` sale 1: la salida por defecto depende de la config de cada máquina.
# · Una WIQL sin `[System.TeamProject] = @project` sale 1: la ruta /{proyecto}/ NO acota (medido:
#   183 work items sin la cláusula, 0 con ella).
# · `--fields` repetido: gana el ÚLTIMO, como argparse con nargs='*'. Mandar las etiquetas en un
#   `--fields` y el texto en otro pierde las etiquetas en silencio.
#
# ── LOS DOS SABOTAJES ────────────────────────────────────────────────────────────────────────────
#   TYCON_AZ_FAIL=<paso>[:<patrón>][,…]   ese paso sale 1 (con el patrón: sólo si aparece en los
#                                          argumentos o en los archivos leídos)
#   TYCON_AZ_GARBAGE=<paso>[:<patrón>][,…]  ese paso sale 0 con texto que no es JSON
# Pasos: version identidad wiql wi revisiones estados categorias campos grupo miembros equipo iteracion crear comentario actualizar prs lote
#        grupos-agentes pedidos-agentes (la cola de la organización)
#        pr-listar pr-crear pr-actualizar pr-ver (los pedidos de cambio de un repo: `repos pr list|create|update|show`)
#
# · `categorias`: `devops invoke --area wit --resource workitemtypecategories --route-parameters project=P` →
#   `categorias-P.json`; sin fixture, un proceso cuyo elemento de backlog por defecto es el Bug.
# · `campos`: `devops invoke --area wit --resource workitemtypesfield --route-parameters project=P type=T` →
#   `campos-P-T.json`; sin fixture, el Bug de siempre (con Severity y ReproSteps) y cualquier otro tipo no existe.
#
# ── LOS PEDIDOS ASIGNADOS, PARA EL SITIO DE LA ORGANIZACIÓN ───────────────────────────────
# · `lote`: `devops invoke --area wit --resource workitemsbatch --in-file <{ids, fields}>` → `{ count, value }` con el
#   `wi-<id>.json` de cada id que tenga fixture (los que no, no vuelven: como Azure con un id borrado).
#
# ── EL ESTADO DE CADA PEDIDO ────────────────────────────────────────────────
# · `revisiones`: `devops invoke --area wit --resource revisions --route-parameters id=N` → `revisiones-N.json`
#   (sin fixture sale 1 con TF401232, como el `show` de un id que no existe).
# · `estados`: `devops invoke --area wit --resource workItemTypeStates --route-parameters project=P type=Bug`
#   → `estados-P.json` (sin fixture sale 1: el tipo o el proyecto no existe). Por tipo:
#   `estados-P-<tipo>.json`; el `estados-P.json` de siempre vale sólo para `type=Bug`.
#
# ── LOS PR ABIERTOS DE LA ORGANIZACIÓN ──────────────────────────────────────
# · `prs`: `devops invoke --area git --resource pullRequests --query-parameters … $skip=N` → `prs-N.json`
#   (sin fixture: una página vacía, `{count:0,value:[]}` — como Azure pasada la última página).
#
# ── LA FOTO DE DESPLIEGUES ─────────────────────────────────────────────────
# · `definiciones`: `pipelines list --name N --project P` → `definiciones-P.json` filtrada por PREFIJO de nombre, sin
#   distinguir mayúsculas (como Azure: «Acme Backend» también trae «Acme Backend Prod»).
# · `builds`: `pipelines runs list --pipeline-ids ID --project P [--top N]` → `builds-ID.json`, cortada en N. El orden
#   del fixture es el que llega: el guion no puede confiar en él.
# · `corrida`: `pipelines runs show --id N --project P` → `corrida-N.json` (sin fixture sale 1).
# · `timeline`: `devops invoke --area build --resource timeline --route-parameters project=P buildId=N`
#   → `timeline-N.json` (sin fixture: `{records:[]}`, como una corrida que no llegó a correr nada).
#
# ── LA CI Y LA COLA ─────────────────────────────────────────────────────────────────────────────
# · `builds` sin `--pipeline-ids`: `pipelines runs list --project P [--branch B] [--top N]` → `runs-P.json`, filtrada por
#   rama (con o sin `refs/heads/`) y cortada en N.
# · `grupos-agentes`: `devops invoke --area distributedtask --resource pools` → `pools.json` (sin fixture: ninguno).
# · `pedidos-agentes`: `devops invoke --area distributedtask --resource jobrequests --route-parameters poolId=N` →
#   `jobrequests-N.json` (sin fixture sale 1, como un grupo que no existe).
#
# ── LA FAMILIA DE LA INSTALACIÓN DEL SITIO EN AZURE CONTAINER APPS ──────────────────────────────────────
# Una familia aparte, que NO pasa por las trampas de `--org` ni de `-o json` (son de `devops`/`boards`): `account`,
# `provider`, `group`, `monitor`, `storage`, `containerapp`, `role` y `rest`. Recuerda lo que crea en
# `$FIXAZ/azure.json` (la segunda corrida tiene que saltear lo que ya existe) y contesta las consultas `--query … -o tsv`
# con valores fijos de mentira (las llaves con un marcador que ninguna salida puede traer).
#   Pasos: sesion proveedor grupo-recursos area ambiente almacen recurso-compartido llaves aplicacion rol inicio entrada rest
#   TYCON_AZ_WITHOUT_SESSION=1   `account show` sale 1 con «Please run 'az login'» (como az sin sesión)
#   TYCON_AZ_FAIL=rol       el rol sale 1 con un 403 de AuthorizationFailed (como sin Owner ni User Access Administrator)
#   TYCON_AZ_GRAPH_DELAY=N  las N primeras veces el rol sale 1 con «Cannot find user or service principal in graph
#                           database» (la identidad recién creada que Entra ID todavía no ve)
#   Siempre: `containerapp auth microsoft update` con --issuer y --tenant-id juntos sale 1, como az 2.71
exec node - "$@" <<'JS'
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const FIX = process.env.FIXAZ;
if (!FIX) { process.stderr.write('doble-az: falta la variable FIXAZ\n'); process.exit(97); }

const tiene = (...ks) => ks.every((k) => args.includes(k));
// Como argparse con action=store: si la opción aparece dos veces, gana la ÚLTIMA.
const arg = (k) => { const i = args.lastIndexOf(k); return i < 0 ? undefined : args[i + 1]; };
const valores = (k) => {
  const i = args.lastIndexOf(k);
  if (i < 0) return [];
  const r = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) r.push(args[j]);
  return r;
};
const kv = (k) => Object.fromEntries(valores(k).map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
const leerFix = (nombre) => { try { return fs.readFileSync(path.join(FIX, nombre), 'utf8'); } catch { return null; } };
const fixJson = (nombre, def) => { const t = leerFix(nombre); return t === null ? def : JSON.parse(t); };

// Los archivos que el comando leería, con la MISMA regla que `_expand_file_prefix` de az 2.79: se
// parte en el primer '=' y se lee lo que empiece con '@'. `--in-file` recibe la ruta pelada.
const archivos = {};
args.forEach((x, i) => {
  let ruta = null;
  const eq = x.indexOf('=');
  if (x.startsWith('@')) ruta = x.slice(1);
  else if (eq >= 0 && x[eq + 1] === '@') ruta = x.slice(eq + 2);
  else if (args[i - 1] === '--in-file' || args[i - 1] === '--yaml') ruta = x;
  if (ruta) {
    try { archivos[ruta] = fs.readFileSync(ruta, 'utf8'); }
    catch (e) { archivos[ruta] = `<<no se pudo leer: ${e.message}>>`; }
  }
});

let paso = 'desconocido';
// story 2.30: la familia de la instalación del sitio (sin las trampas de `--org` ni de `-o json`: son de devops/boards)
// story 2.40: `ad` (el registro de Entra ID: `ad app show` lee sus claims opcionales, `ad sp update` cambia su principal
// de servicio). Las claims que «tiene» el registro: TYCON_AZ_CLAIMS (separadas por coma; por defecto email y xms_edov)
const AZURE = { account: 'sesion', provider: 'proveedor', group: 'grupo-recursos', monitor: 'area', storage: 'almacen', containerapp: 'aplicacion', role: 'rol', rest: 'rest', ad: 'registro' };
const familia = Object.prototype.hasOwnProperty.call(AZURE, args[0]);
if (args[0] === '--version') paso = 'version';
else if (familia) {
  paso = AZURE[args[0]];
  if (args[0] === 'containerapp' && args[1] === 'env') paso = 'ambiente';
  if (args[0] === 'containerapp' && args[1] === 'auth') paso = 'inicio';
  if (args[0] === 'containerapp' && args[1] === 'ingress') paso = 'entrada';
  if (args[0] === 'storage' && args[1] === 'share-rm') paso = 'recurso-compartido';
  if (args[0] === 'storage' && args[2] === 'keys') paso = 'llaves';
  if (args[0] === 'monitor' && args.includes('get-shared-keys')) paso = 'llaves';
}
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'ims') paso = 'identidad';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'wit' && String(arg('--resource')).toLowerCase() === 'wiql') paso = 'wiql';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'wit' && String(arg('--resource')).toLowerCase() === 'revisions') paso = 'revisiones';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'wit' && String(arg('--resource')).toLowerCase() === 'workitemtypestates') paso = 'estados';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'wit' && String(arg('--resource')).toLowerCase() === 'workitemtypecategories') paso = 'categorias';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'wit' && String(arg('--resource')).toLowerCase() === 'workitemtypesfield') paso = 'campos';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'git' && String(arg('--resource')).toLowerCase() === 'pullrequests') paso = 'prs';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'wit' && String(arg('--resource')).toLowerCase() === 'workitemsbatch') paso = 'lote';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'build' && String(arg('--resource')).toLowerCase() === 'timeline') paso = 'timeline';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'distributedtask' && String(arg('--resource')).toLowerCase() === 'pools') paso = 'grupos-agentes';
else if (tiene('devops', 'invoke') && String(arg('--area')).toLowerCase() === 'distributedtask' && String(arg('--resource')).toLowerCase() === 'jobrequests') paso = 'pedidos-agentes';
else if (tiene('repos', 'pr', 'list')) paso = 'pr-listar';
else if (tiene('repos', 'pr', 'create')) paso = 'pr-crear';
else if (tiene('repos', 'pr', 'update')) paso = 'pr-actualizar';
else if (tiene('repos', 'pr', 'show')) paso = 'pr-ver';
else if (tiene('pipelines', 'runs', 'list')) paso = 'builds';
else if (tiene('pipelines', 'runs', 'show')) paso = 'corrida';
else if (tiene('pipelines', 'list')) paso = 'definiciones';
else if (tiene('devops', 'security', 'group', 'membership', 'list')) paso = 'miembros';
else if (tiene('devops', 'security', 'group', 'list')) paso = 'grupo';
else if (tiene('devops', 'project', 'show')) paso = 'equipo';
else if (tiene('boards', 'iteration', 'team', 'list')) paso = 'iteracion';
else if (tiene('boards', 'work-item', 'relation', 'add')) paso = 'relacion';
else if (tiene('boards', 'work-item', 'show')) paso = 'wi';
else if (tiene('boards', 'work-item', 'create')) paso = 'crear';
else if (tiene('boards', 'work-item', 'update')) paso = args.includes('--discussion') ? 'comentario' : 'actualizar';

// los nombres de las variables SITE_* que le llegaron (az no las necesita: el alta no se las pasa)
const siteEnv = Object.keys(process.env).filter((k) => k.startsWith('SITE_'));
fs.appendFileSync(path.join(FIX, 'llamadas.log'), `${paso}\t${JSON.stringify({ args, archivos, siteEnv })}\n`);
// con TYCON_AZ_SNAPSHOT, cada llamada también va a ese archivo: la foto de lo que el arnés le pide a Azure DevOps, que
// scripts/tests/lib/record-platform-golden.js compara antes y después de un cambio
if (process.env.TYCON_AZ_SNAPSHOT) fs.appendFileSync(process.env.TYCON_AZ_SNAPSHOT, `${paso}\t${JSON.stringify(args)}\n`);

const falla = (msg, code = 1) => { process.stderr.write(`ERROR: ${msg}\n`); process.exit(code); };
// Escritura SINCRÓNICA: `process.stdout.write` + `process.exit` corta la salida a un pipe pasados ~64 KB
// (lo destapó la 4.6: una página de 100 PR llegaba truncada y el JSON era ilegible).
const out = (o) => {
  const buf = Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
  for (let off = 0; off < buf.length;) {
    try { off += fs.writeSync(1, buf, off); } catch (e) { if (e.code !== 'EAGAIN') throw e; }
  }
  process.exit(0);
};

const coincide = (spec) => String(spec || '').split(',').map((s) => s.trim()).filter(Boolean).some((s) => {
  const [p, ...resto] = s.split(':');
  if (p !== paso) return false;
  const patron = resto.join(':');
  return !patron || JSON.stringify(args).includes(patron) || Object.values(archivos).some((t) => t.includes(patron));
});
if (coincide(process.env.TYCON_AZ_FAIL)) {
  // story 2.30: el rol sin Owner ni User Access Administrator falla como Azure, con el 403
  if (paso === 'rol') falla("(AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Authorization/roleAssignments/write' over scope (403)");
  falla(`falla fabricada en el paso ${paso}`);
}
// sin sesión, los comandos de boards fallan como az sin `az login`
if (process.env.TYCON_AZ_WITHOUT_SESSION === '1' && ['wi', 'crear', 'comentario', 'actualizar', 'relacion'].includes(paso)) falla("Please run 'az login' to setup account.");
if (coincide(process.env.TYCON_AZ_GARBAGE)) { process.stdout.write('esto no es JSON, es lo que devuelve un proxy caído\n'); process.exit(0); }

if (paso === 'version') { process.stdout.write('azure-cli 2.79.0 (doble de pruebas)\n'); process.exit(0); }

if (familia) {
  const EST = path.join(FIX, 'azure.json');
  const estado = (() => { try { return JSON.parse(fs.readFileSync(EST, 'utf8')); } catch { return {}; } })();
  const guardar = () => fs.writeFileSync(EST, JSON.stringify(estado, null, 2));
  const tsv = (v) => { process.stdout.write(`${v}\n`); process.exit(0); };
  const nombre = arg('--name') || arg('-n');
  const verbo = args.find((x) => ['show', 'create', 'register', 'update', 'set', 'list', 'put'].includes(x)) || args[args.length - 1];
  const clave = `${args.slice(0, args.indexOf(verbo)).join(' ')}|${nombre || arg('--url') || ''}`;
  if (paso === 'sesion') {
    if (process.env.TYCON_AZ_WITHOUT_SESSION === '1') falla("Please run 'az login' to setup account.");
    out({ id: 'suscripcion-de-mentira', tenantId: 'inquilino-de-mentira', user: { name: 'quien-instala' } });
  }
  if (paso === 'proveedor') {
    if (verbo === 'show') tsv(estado[clave] ? 'Registered' : (fs.existsSync(path.join(FIX, `sin-registrar-${nombre}`)) ? 'NotRegistered' : 'Registered'));
    estado[clave.replace(' register', ' show')] = true; guardar(); process.exit(0);
  }
  if (paso === 'llaves') {
    // TYCON_AZ_EMPTY_KEY=1: la llave vuelve como «None» (lo que imprime -o tsv para un null) con salida 0
    if (process.env.TYCON_AZ_EMPTY_KEY === '1') tsv('None');
    const q = String(arg('--query') || '');
    if (/primarySharedKey/.test(q)) tsv('LLAVE-DEL-AREA-QUE-NO-DEBE-APARECER');
    tsv('LLAVE-DE-LA-CUENTA-QUE-NO-DEBE-APARECER');
  }
  if (paso === 'registro' && args[1] === 'app' && args[2] === 'show') tsv((process.env.TYCON_AZ_CLAIMS || 'email,xms_edov').split(',').filter(Boolean).join('\t'));
  // invitar desde el sitio: el principal de Graph y el id de su rol User.Invite.All; las asignaciones y la política del código por
  // correo, por Graph. TYCON_AZ_NOT_ADMIN=1: la asignación sale con el 403 de Graph (la sesión no es de un administrador
  // del directorio); TYCON_AZ_EMAIL_CODE_POLICY=enabled|default|disabled|denied (denied: la lectura de la política sale 403)
  if (paso === 'registro' && args[1] === 'sp' && args[2] === 'show') tsv(/appRoles/.test(String(arg('--query'))) ? 'rol-de-invitar' : 'principal-de-graph');
  if (paso === 'rest' && /graph\.microsoft\.com/.test(String(arg('--url')))) {
    const u = String(arg('--url'));
    const metodo = String(arg('--method') || 'get').toLowerCase();
    if (/appRoleAssignments$/.test(u) && metodo === 'post') {
      if (process.env.TYCON_AZ_NOT_ADMIN === '1') falla('Forbidden({"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation."}})');
      out({ id: 'asignacion-1' });
    }
    if (/appRoleAssignments$/.test(u)) out({ value: [] });
    if (/authenticationMethodConfigurations\/email$/i.test(u)) {
      const p = process.env.TYCON_AZ_EMAIL_CODE_POLICY || 'default';
      if (p === 'denied') falla('Forbidden({"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation."}})');
      out({ id: 'Email', allowExternalIdToUseEmailOtp: p });
    }
    out({});
  }
  if (paso === 'rest') {
    const u = String(arg('--url') || '');
    estado[`rest|${u.replace(/\?.*$/, '')}`] = true; guardar(); out({ properties: { provisioningState: 'Succeeded' } });
  }
  const consulta = (q) => {
    // lo que tiene la aplicación: sale del último --yaml que la creó o la actualizó (nombres, nunca valores)
    const apl = estado.apl || {};
    if (q === 'properties.template.containers[0].image') return apl.imagen || '';
    // el valor que dejó la fase permiso-de-invitar (`--set-env-vars SITE_INVITE_EMAIL_CODE=…`)
    if (/SITE_INVITE_EMAIL_CODE/.test(q)) return estado.codigoPorCorreo || 'None';
    // story 2.76: la marca de la instancia demo (el valor de SITE_DEMO de la aplicación; None si no la tiene)
    if (/SITE_DEMO/.test(q)) return apl.demo || 'None';
    if (q === 'properties.configuration.secrets[].name') return (apl.secretos || []).join('\n');
    if (q === 'properties.template.containers[0].env[].name') return (apl.variables || []).join('\n');
    if (q === 'properties.configuration.ingress.external') return apl.externa ? 'true' : 'false';
    if (/customerId/.test(q)) return 'cliente-del-area';
    if (/defaultDomain/.test(q)) return 'cielo-verde-1a2b3c4d.eastus2.azurecontainerapps.io';
    if (/provisioningState/.test(q)) return 'Succeeded';
    if (/principalId/.test(q)) return 'principal-del-sitio';
    // el rol se recuerda por su alcance (el del buzón no tapa el de la copia)
    if (/length\(@\)/.test(q)) return estado[`rol|${arg('--scope')}`] ? '1' : '0';
    if (q === 'id') return `/subscriptions/suscripcion-de-mentira/resourceGroups/${arg('--resource-group') || arg('-g') || 'rg'}/providers/x/${nombre}`;
    return 'valor-de-mentira';
  };
  // el valor de un secreto que la aplicación ya tiene (`containerapp secret show`): uno fijo por nombre, nunca el real
  if (paso === 'aplicacion' && args[1] === 'secret' && verbo === 'show') {
    const s = String(arg('--secret-name') || '');
    if (!estado[`containerapp|${nombre}`] || !((estado.apl || {}).secretos || []).includes(s)) falla(`(SecretNotFound) ${s} no existe`, 3);
    // uno que vive en un almacén de claves trae su dirección y su identidad, y el valor vacío (como Azure)
    const ref = ((estado.apl || {}).boveda || {})[s];
    const q = String(arg('--query') || 'value');
    if (q === 'keyVaultUrl' || q === 'identity') { tsv(ref ? ref[q] : ''); process.exit(0); }
    tsv(ref ? '' : `valor-guardado-${s}`); process.exit(0);
  }
  if (verbo === 'show' || verbo === 'list') {
    // un ambiente creado por `rest` existe para `containerapp env show`
    const porRest = paso === 'ambiente' && Object.keys(estado).some((k) => k.startsWith('rest|') && k.endsWith(`/managedEnvironments/${nombre}`));
    // el recurso compartido que no existe lo dice como lo dice Azure Files (ShareNotFound), no como ResourceNotFound
    if (!(estado[clave] || porRest) && paso === 'recurso-compartido') falla(`ErrorCode:ShareNotFound — The specified share ${nombre || ''} does not exist.`, 3);
    if (!(estado[clave] || porRest) && !(paso === 'rol' && verbo === 'list')) falla(`(ResourceNotFound) ${args[0]} ${nombre || ''} no existe`, 3);
    const q = arg('--query');
    if (q) tsv(consulta(String(q)));
    process.exit(0);
  }
  if (paso === 'rol' && verbo === 'create') {
    const demora = Number(process.env.TYCON_AZ_GRAPH_DELAY) || 0;
    estado.rolIntentos = (estado.rolIntentos || 0) + 1; guardar();
    if (estado.rolIntentos <= demora) falla(`(PrincipalNotFound) Cannot find user or service principal in graph database for '${arg('--assignee-object-id')}'.`);
    estado.rol = true; estado[`rol|${arg('--scope')}`] = true; guardar(); process.exit(0);
  }
  // la aplicación creada o actualizada con --yaml: se recuerda lo que lleva (sin los valores de los secretos)
  if (paso === 'aplicacion' && (verbo === 'create' || verbo === 'update') && args.includes('--yaml')) {
    const y = JSON.parse(Object.values(archivos)[0] || '{}');
    const cfg = (y.properties || {}).configuration || {};
    const cont = (((y.properties || {}).template || {}).containers || [])[0] || {};
    estado.apl = { demo: ((cont.env || []).find((e) => e.name === 'SITE_DEMO') || {}).value, imagen: cont.image, secretos: (cfg.secrets || []).map((s) => s.name), variables: (cont.env || []).map((e) => e.name), externa: Boolean((cfg.ingress || {}).external),
      boveda: Object.fromEntries((cfg.secrets || []).filter((s) => s.keyVaultUrl).map((s) => [s.name, { keyVaultUrl: s.keyVaultUrl, identity: s.identity }])) };
  }
  if (paso === 'entrada' && args.includes('external')) estado.apl = { ...(estado.apl || {}), externa: true };
  if (paso === 'aplicacion' && verbo === 'update' && args.includes('--set-env-vars')) {
    const v = valores('--set-env-vars').find((x) => x.startsWith('SITE_INVITE_EMAIL_CODE='));
    if (v) estado.codigoPorCorreo = v.split('=')[1];
  }
  // az 2.71 (extensión containerapp 1.2.0b4) no acepta el emisor y el inquilino juntos
  if (paso === 'inicio' && args.includes('--issuer') && args.includes('--tenant-id')) falla('--issuer and --tenant-id cannot be configured to non empty strings at the same time.');
  // create / update / set: queda creado (la clave no lleva el verbo: `show` la encuentra)
  estado[clave] = true; guardar(); process.exit(0);
}
// Los pedidos de cambio de un repo (`repos pr`): `list`, `create`, `update` y `show`. Recuerda los pedidos en
// `$FIXAZ/repos-pr.json` (`[{pullRequestId, sourceRefName, targetRefName, status, title, description, mergeStatus,
// autoCompleteSetBy, completionOptions}]`; una suite lo siembra con uno ya abierto o en conflicto). `update` y `show`
// van sin `--org`, como el az de verdad dentro del clon (la organización sale del remoto); `list` y `create`, con ella.
//   TYCON_AZ_PR_WITHOUT_AUTO=1   `update` no deja el auto-completar puesto (la verificación con `show` lo ve)
if (/^pr-/.test(paso)) {
  const EST = path.join(FIX, 'repos-pr.json');
  const pedidos = (() => { try { return JSON.parse(fs.readFileSync(EST, 'utf8')); } catch { return []; } })();
  const guardar = () => fs.writeFileSync(EST, JSON.stringify(pedidos, null, 2));
  if ((paso === 'pr-listar' || paso === 'pr-crear') && !args.includes('--org') && !args.includes('--organization')) falla('sin --org: el default de `az devops configure` apunta a un proyecto que ya no existe');
  if (arg('-o') !== 'json' && arg('--output') !== 'json') falla('sin -o json: la salida por defecto depende de la configuración de cada máquina');
  const ref = (r) => `refs/heads/${r}`;
  const conUrl = (p) => ({ ...p, url: `https://dev.azure.com/acme/_apis/git/pullRequests/${p.pullRequestId}` });
  if (paso === 'pr-listar') {
    out(pedidos.filter((p) => p.status === (arg('--status') || 'active') && p.sourceRefName === ref(arg('--source-branch'))
      && p.targetRefName === ref(arg('--target-branch'))).map(conUrl));
  }
  if (paso === 'pr-crear') {
    const p = { pullRequestId: 100 + pedidos.length + 1, status: 'active', sourceRefName: ref(arg('--source-branch')), targetRefName: ref(arg('--target-branch')),
      title: arg('--title'), description: arg('--description'), mergeStatus: 'queued', autoCompleteSetBy: null, completionOptions: {} };
    pedidos.push(p); guardar(); out(conUrl(p));
  }
  const p = pedidos.find((x) => String(x.pullRequestId) === String(arg('--id')));
  if (!p) falla(`TF401180: The requested pull request was not found (${arg('--id')})`);
  if (paso === 'pr-actualizar') {
    if (arg('--title') !== undefined) p.title = arg('--title');
    if (arg('--description') !== undefined) p.description = arg('--description');
    if (arg('--merge-commit-message') !== undefined) p.completionOptions = { ...p.completionOptions, mergeCommitMessage: arg('--merge-commit-message') };
    if (arg('--auto-complete') === 'true' && process.env.TYCON_AZ_PR_WITHOUT_AUTO !== '1') p.autoCompleteSetBy = { id: 'quien-pide' };
    guardar(); out(conUrl(p));
  }
  // `show --query "{ac:autoCompleteSetBy.id, msg:completionOptions.mergeCommitMessage}"`: lo que verifica el paso
  if (/ac:autoCompleteSetBy\.id/.test(String(arg('--query') || ''))) out({ ac: (p.autoCompleteSetBy && p.autoCompleteSetBy.id) || null, msg: p.completionOptions.mergeCommitMessage || null });
  out(conUrl(p));
}
if (paso === 'desconocido') falla(`doble-az: comando no reconocido: ${args.join(' ')}`, 2);
if (!args.includes('--org') && !args.includes('--organization')) {
  falla('sin --org: el default de `az devops configure` apunta a un proyecto que ya no existe');
}
const salida = arg('-o') || arg('--output');
// la única consulta en texto plano que usa el arnés: el estado de un pedido de trabajo (`--query … -o tsv`)
const estadoEnTexto = paso === 'wi' && salida === 'tsv' && /System\.State/.test(String(arg('--query') || ''));
if (salida !== 'json' && !estadoEnTexto) falla('sin -o json: la salida por defecto depende de la configuración de cada máquina');

const dirCreados = path.join(FIX, 'creados');
const creados = () => {
  try { return fs.readdirSync(dirCreados).map((f) => JSON.parse(fs.readFileSync(path.join(dirCreados, f), 'utf8'))); }
  catch { return []; }
};

switch (paso) {
  case 'identidad': {
    const mail = kv('--query-parameters').filterValue;
    out(fixJson(`identidades-${mail}.json`, { count: 0, value: [] }));
    break;
  }
  case 'wiql': {
    const proyecto = kv('--route-parameters').project;
    let cuerpo;
    try { cuerpo = JSON.parse(archivos[arg('--in-file')] || ''); } catch { falla('--in-file no es JSON'); }
    const q = String(cuerpo.query || '');
    if (!/\[System\.TeamProject\]\s*=\s*@project/i.test(q)) {
      falla('consulta sin [System.TeamProject] = @project: la ruta /{proyecto}/ NO acota (medido: 183 contra 0)');
    }
    const etiqueta = (q.match(/'(arnes:[^']+)'/) || [])[1];
    const base = fixJson(`wiql-${proyecto}.json`, { workItems: [] });
    const recordados = creados()
      .filter((c) => c.proyecto === proyecto && etiqueta && String(c.tags).includes(etiqueta))
      .map((c) => ({ id: c.id }));
    out({ queryType: 'flat', ...base, workItems: [...(base.workItems || []), ...recordados] });
    break;
  }
  case 'wi': {
    const id = arg('--id');
    // el estado en texto: el último que le puso un update, si no `estado-<id>` del escenario, si no «New»
    if (estadoEnTexto) { process.stdout.write(`${String(leerFix(`estado-${id}`) || 'New').trim()}\n`); process.exit(0); }
    const f = fixJson(`wi-${id}.json`, null);
    if (f) out(f);
    const c = creados().find((x) => String(x.id) === String(id));
    if (c) out({ id: c.id, fields: { 'System.Tags': c.tags, 'System.TeamProject': c.proyecto } });
    falla(`TF401232: el work item ${id} no existe o no tenés permiso para leerlo`);
    break;
  }
  case 'revisiones': {
    const id = kv('--route-parameters').id;
    const f = fixJson(`revisiones-${id}.json`, null);
    if (f) out(f);
    falla(`TF401232: el work item ${id} no existe o no tenés permiso para leerlo`);
    break;
  }
  case 'categorias': {
    // las categorías de tipos de un proyecto. Sin fixture, el mundo de las suites de antes: un proceso cuyo elemento
    // de backlog por defecto es el Bug (así esas suites crean Bugs sin cambiar sus fixtures)
    const rp = kv('--route-parameters');
    out(fixJson(`categorias-${rp.project}.json`, null) || { count: 1, value: [{ referenceName: 'Microsoft.RequirementCategory', defaultWorkItemType: { name: 'Bug' } }] });
    break;
  }
  case 'campos': {
    // los campos de un tipo en un proyecto (`campos-<proyecto>-<tipo>.json`). Sin fixture: el Bug de siempre, con
    // Severity y ReproSteps; cualquier otro tipo no existe (sale 1 con VS402323, como Azure)
    const rp = kv('--route-parameters');
    const f = fixJson(`campos-${rp.project}-${rp.type}.json`, null);
    if (f) out(f);
    if (rp.type === 'Bug') out({ count: 4, value: ['System.Title', 'System.Description', 'Microsoft.VSTS.TCM.ReproSteps', 'Microsoft.VSTS.Common.Severity'].map((referenceName) => ({ referenceName, alwaysRequired: referenceName === 'System.Title' })) });
    falla(`VS402323: el tipo ${rp.type} no existe en el proyecto ${rp.project}`);
    break;
  }
  case 'estados': {
    const rp = kv('--route-parameters');
    // por tipo: `estados-<proyecto>-<tipo>.json`; el de siempre, sin tipo, es el del Bug
    const f = fixJson(`estados-${rp.project}-${rp.type}.json`, null) || (rp.type === 'Bug' ? fixJson(`estados-${rp.project}.json`, null) : null);
    if (f) out(f);
    falla(`VS402323: el tipo ${rp.type} no existe en el proyecto ${rp.project}`);
    break;
  }
  case 'prs': {
    const skip = Number(kv('--query-parameters').$skip || 0);
    out(fixJson(`prs-${skip}.json`, { count: 0, value: [] }));
    break;
  }
  case 'lote': {
    // story 2.23: los campos de varios work items en un pedido (POST wit/workitemsbatch, como Azure: hasta 200 ids)
    let cuerpo;
    try { cuerpo = JSON.parse(archivos[arg('--in-file')] || ''); } catch { falla('--in-file no es JSON'); }
    if (!Array.isArray(cuerpo.ids) || cuerpo.ids.length > 200) falla('workitemsbatch: ids tiene que ser una lista de hasta 200');
    out({ count: cuerpo.ids.length, value: cuerpo.ids.map((id) => fixJson(`wi-${id}.json`, null)).filter(Boolean) });
    break;
  }
  case 'definiciones': {
    const n = String(arg('--name') || '').toLowerCase();
    out(fixJson(`definiciones-${arg('--project')}.json`, []).filter((d) => String(d.name).toLowerCase().startsWith(n)));
    break;
  }
  case 'builds': {
    const top = Number(arg('--top') || 100);
    if (arg('--pipeline-ids')) out(fixJson(`builds-${arg('--pipeline-ids')}.json`, []).slice(0, top));
    const rama = String(arg('--branch') || '').replace(/^refs\/heads\//, '');
    // una respuesta que no es lista sale tal cual: es lo que la prueba quiere ver leído
    const corridas = fixJson(`runs-${arg('--project')}.json`, []);
    if (!Array.isArray(corridas)) out(corridas);
    out(corridas.filter((r) => !rama || String(r.sourceBranch).replace(/^refs\/heads\//, '') === rama).slice(0, top));
    break;
  }
  case 'grupos-agentes': {
    out(fixJson('pools.json', { count: 0, value: [] }));
    break;
  }
  case 'pedidos-agentes': {
    const id = kv('--route-parameters').poolId;
    const f = fixJson(`jobrequests-${id}.json`, null);
    if (f) out(f);
    falla(`el grupo de agentes ${id} no existe`);
    break;
  }
  case 'corrida': {
    const f = fixJson(`corrida-${arg('--id')}.json`, null);
    if (f) out(f);
    falla(`la corrida ${arg('--id')} no existe`);
    break;
  }
  case 'timeline': {
    // un fixture vacío contesta vacío con salida 0: como Azure con una corrida cancelada antes de correr (2026-10-16)
    if (leerFix(`timeline-${kv('--route-parameters').buildId}.json`) === '') process.exit(0);
    out(fixJson(`timeline-${kv('--route-parameters').buildId}.json`, { records: [] }));
    break;
  }
  case 'grupo': {
    const p = arg('--project');
    out(fixJson(`grupo-${p}.json`, { graphGroups: [
      { displayName: 'Contributors', descriptor: 'vssgp.contrib', principalName: `[${p}]\\Contributors`, subjectKind: 'group' },
      { displayName: 'Project Administrators', descriptor: `vssgp.${p}`, principalName: `[${p}]\\Project Administrators`, subjectKind: 'group' },
    ] }));
    break;
  }
  case 'miembros': {
    const d = arg('--id');
    out(fixJson(`miembros-${d}.json`, fixJson('miembros.json', {})));
    break;
  }
  case 'equipo': {
    const p = arg('--project');
    out(fixJson(`proyecto-${p}.json`, { name: p, defaultTeam: { name: `${p} Team` } }));
    break;
  }
  case 'iteracion': {
    if (!arg('--team')) falla('az boards iteration team list: falta --team');
    out(fixJson(`iteracion-${arg('--project')}.json`, []));
    break;
  }
  case 'crear': {
    for (const k of ['--project', '--type', '--title']) if (!arg(k)) falla(`work-item create: falta ${k}`);
    const n = Number(String(leerFix('contador') || '100').trim()) + 1;
    fs.writeFileSync(path.join(FIX, 'contador'), String(n));
    const campos = kv('--fields');
    const tags = campos['System.Tags'] || '';
    fs.mkdirSync(dirCreados, { recursive: true });
    fs.writeFileSync(path.join(dirCreados, `${n}.json`), JSON.stringify({ id: n, proyecto: arg('--project'), tags }));
    out({ id: n, fields: { 'System.Title': arg('--title'), 'System.Tags': tags, 'System.TeamProject': arg('--project') } });
    break;
  }
  case 'relacion': {
    for (const k of ['--id', '--relation-type', '--target-id']) if (!arg(k)) falla(`work-item relation add: falta ${k}`);
    out({ id: Number(arg('--id')), relations: [{ rel: arg('--relation-type'), target: Number(arg('--target-id')) }] });
    break;
  }
  case 'comentario': {
    if (!arg('--id')) falla('work-item update: falta --id');
    out({ id: Number(arg('--id')), fields: {} });
    break;
  }
  case 'actualizar': {
    // Un cierre (`--state`) contesta el estado nuevo y el motivo que Azure pone por defecto al no mandarlo
    // (medido el 2026-09-15 con validateOnly: «Fixed and verified» desde New en Agile).
    if (!arg('--id')) falla('work-item update: falta --id');
    const st = arg('--state');
    if (st) fs.writeFileSync(path.join(FIX, `estado-${arg('--id')}`), st);
    out({ id: Number(arg('--id')), fields: st ? { 'System.State': st, 'System.Reason': String(leerFix(`motivo-${arg('--id')}`) || 'Fixed and verified').trim() } : {} });
    break;
  }
  default: falla(`doble-az: paso sin respuesta: ${paso}`, 2);
}
JS
