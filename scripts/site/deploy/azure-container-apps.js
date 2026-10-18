#!/usr/bin/env node
'use strict';
/**
 * azure-container-apps.js — la instalación del sitio de la organización en Azure Container Apps, en dos fases.
 *
 * ── LAS DOS FASES ───────────────────────────────────────────────────────────────────────────────
 * · `ambiente`: registra los proveedores `Microsoft.App` y `Microsoft.OperationalInsights` si faltan; crea el grupo de
 *   recursos propio del sitio, el área de Log Analytics (31 días, tope diario explícito, nunca ilimitado) y el ambiente
 *   (de perfiles de carga, con el perfil Consumption, y los registros en ESA área). Imprime la dirección que tendrá el
 *   sitio (`https://<app>.<defaultDomain>`) y las dos vueltas que una persona agrega al registro de Entra ID.
 * · `sitio`: una cuenta de almacenamiento PROPIA del sitio con un recurso compartido de Azure Files (con cuota),
 *   agregado al ambiente; la aplicación con la imagen por su huella, mínimo 0 y máximo 1 réplica, 0,5 vCPU y 1 GiB,
 *   el disco en `SITE_DATA_DIR`, las dos sondas a `/livez`, los secretos y la identidad del sistema, con la
 *   ENTRADA INTERNA; el rol «Storage Blob Data Reader» sobre el CONTENEDOR del buzón; el inicio integrado de Microsoft
 *   (un inquilino, el secreto por nombre); y por último la entrada externa. Si un paso falla, la entrada sigue interna.
 * Correr una fase de nuevo saltea lo que ya existe (pregunta antes de crear), salvo la aplicación: si ya existe, se
 * actualiza con la configuración de hoy (la imagen, los secretos y las variables), dice qué cambió y deja la entrada como
 * estaba. Así se actualiza el sitio.
 *
 * ── LOS SECRETOS ────────────────────────────────────────────────────────────────────────────────
 * Nunca en el archivo de configuración, en la línea de órdenes ni en el plan impreso. Los valores llegan por variables
 * de entorno de quien corre el alta, con los nombres del sitio (SITE_SESSION_KEY, SITE_OIDC_CLIENT_SECRET, y
 * SITE_OPERATIONS_TOKEN si el repo se lee con una cuenta dedicada; las opcionales de la pestaña Configuración, si
 * vienen). Las llaves que el alta lee de Azure (la del área de registros, la de la cuenta del disco) tampoco se
 * imprimen. Por eso la aplicación se crea con `az containerapp create --yaml <archivo>` y el ambiente y su disco con
 * `az rest --body @<archivo>`: los valores viajan en un archivo temporal con permisos sólo del dueño, que se borra al
 * terminar; `--secrets`, `--logs-workspace-key` y `--azure-file-account-key` los dejarían en la lista de procesos.
 *
 * ── LO QUE DICE MICROSOFT LEARN ──────────────────────────────────────────────────────────────────
 * · `az containerapp create`: `--cpu` 0.25–2.0, `--memory` con «Gi», `--ingress external|internal`, `--secrets` y
 *   `secretref:` en `--env-vars`, `--system-assigned`; `--yaml` toma la configuración entera («All other parameters
 *   will be ignored»). Las sondas sólo se ponen por `--yaml` (`template.containers[].probes`).
 * · `az containerapp env create`: `--logs-destination` (por defecto crea un área sola), `--logs-workspace-id` y
 *   `--logs-workspace-key` (la llave por línea de órdenes): por eso el ambiente va por `az rest`.
 * · `az monitor log-analytics workspace create --retention-time --quota`: el tope mínimo que acepta Azure es 0,023 GB.
 * · `az containerapp auth update`: `--unauthenticated-client-action RedirectToLoginPage`, `--require-https`,
 *   `--excluded-paths`, `--enabled`; `--redirect-provider` sólo hace falta con varios proveedores (acá hay uno).
 * · `az containerapp auth microsoft update`: `--client-id`, `--client-secret-name` (el secreto de la aplicación que lo
 *   guarda), `--issuer` (lleva el inquilino; con `--tenant-id` también, az se niega), `--allowed-audiences`, `--yes`.
 * · `az role assignment create` sobre una identidad recién creada: Entra ID tarda en verla («Cannot find user or service
 *   principal in graph database»); se reintenta con espera, y sólo ese error.
 * · `az containerapp env storage set` toma la llave de la cuenta por línea de órdenes: el disco va por `az rest`
 *   (`managedEnvironments/<ambiente>/storages/<nombre>`, con la api-version de `API`).
 * 🔴 Nada de esto se corrió todavía contra Azure: lo prueba la primera instalación real.
 *
 * ── USO ─────────────────────────────────────────────────────────────────────────────────────────
 *   node scripts/site/deploy/azure-container-apps.js --config <archivo.json> --phase ambiente|sitio --dry-run|--apply
 *   --dry-run imprime, en orden, las órdenes de esa fase y los archivos que mandaría (los secretos tapados), sin llamar
 *   a az. --apply las corre con la sesión de `az` de quien la lanza; sin sesión, sale 1 y lo dice (no abre un login).
 *   SALIDA: 0 hecho · 1 configuración o variable que falta, o un paso que falló (dice qué quedó creado) · 2 uso.
 *   El archivo de configuración (fuera de todo repo; ver guides/organization-site.md): subscription,
 *   resourceGroup, location (la de la cuenta del buzón), environment, app, logAnalyticsWorkspace, logAnalyticsQuotaGb,
 *   storageAccount, fileShare, fileShareQuotaGb, image (por su huella), tenantId, oidcClientId,
 *   mailbox { resourceGroup, account, container }, operationsRepo, operationsIdentity (copy | managed | token; con copy,
 *   operationsCopy { resourceGroup, account, container }: la cuenta de la copia con la llave apagada),
 *   firstMaintainer (opcional), profileRepo (opcional), microsoftAccounts (opcional: organization, por defecto, o any).
 *   Ningún secreto.
 *   Con `microsoftAccounts: any`, después de poner la aplicación: lee que el registro pida `email` y
 *   `xms_edov`, lo pasa a cualquier cuenta de Microsoft con tokens v2 (`az rest` contra Graph, con la sesión de quien
 *   instala, dueña del registro), saca la asignación requerida del principal de servicio y pone el candado en el emisor
 *   común. El sitio no recibe ningún permiso nuevo.
 *   `TYCON_AZ_CMD` cambia el `az` (las pruebas usan un doble).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const API = '2024-03-01';
const CUOTA_MIN = 0.023;
const CUOTA_MAX = 1;
const DISCO = '/data';
const ALMACEN_AMBIENTE = 'sitio-datos';
const SECRETO_EN_CLAVE = /token|secret|sas|password|passwd|pwd|key|credential/i;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOMBRE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const CUENTA = /^[a-z0-9]{3,24}$/;
const IMAGEN = /^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const CORREO = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
// con qué cuentas de Microsoft se entra (el modo del proveedor del sitio)
const MODOS_MICROSOFT = ['organization', 'any'];
const COMUN = 'https://login.microsoftonline.com/common/v2.0';
// el inquilino de las cuentas personales de Microsoft (el emisor de `consumers`): nunca es el de una organización. Lo
// define el proveedor del sitio; acá no se repite
const { PERSONALES } = require('../auth-providers/microsoft.js');
// las rutas que el candado deja pasar sin sesión: la lista la define el sitio, para que no se escriba dos veces
const { RUTAS_SIN_SESION } = require('../server.js');
// Los secretos de la aplicación: la variable del sitio y el nombre del secreto en Container Apps. Los de la pestaña
// Configuración van sólo si vienen en el entorno (apagados por defecto).
const SECRETOS = [['SITE_SESSION_KEY', 'site-session-key'], ['SITE_OIDC_CLIENT_SECRET', 'site-oidc-client-secret']];
const SECRETO_TOKEN = ['SITE_OPERATIONS_TOKEN', 'site-operations-token'];
const OPCIONALES = [['SITE_OPERATIONS_WRITE_TOKEN', 'site-operations-write-token'], ['SITE_PROFILE_TOKEN', 'site-profile-token'],
  ['SITE_PROFILE_WRITE_TOKEN', 'site-profile-write-token'], ['SITE_PIPELINES_TOKEN', 'site-pipelines-token']];

class Falla extends Error {}

/** Las claves con forma de secreto, en cualquier nivel del archivo de configuración. */
function clavesDeSecreto(o, at = '') {
  if (!o || typeof o !== 'object') return [];
  return Object.entries(o).flatMap(([k, v]) => [...(SECRETO_EN_CLAVE.test(k) ? [`${at}${k}`] : []), ...clavesDeSecreto(v, `${at}${k}.`)]);
}

/** Valida la configuración: la lista de problemas (vacía = sirve). */
function problemas(c, fase) {
  const p = [];
  const secretos = clavesDeSecreto(c);
  if (secretos.length) p.push(`el archivo de configuración no lleva secretos (${secretos.join(', ')}): los valores van en variables de entorno`);
  const pide = (k, re, que) => { if (typeof c[k] !== 'string' || !re.test(c[k])) p.push(`${k}: ${que}`); };
  pide('subscription', GUID, 'el identificador de la suscripción');
  pide('resourceGroup', /^[A-Za-z0-9._()-]{1,90}$/, 'el grupo de recursos propio del sitio');
  pide('location', /^[a-z0-9]+$/, 'la región (la de la cuenta del buzón)');
  pide('environment', NOMBRE, 'el nombre del ambiente');
  pide('app', NOMBRE, 'el nombre de la aplicación (minúsculas, números y guiones)');
  pide('logAnalyticsWorkspace', /^[A-Za-z0-9-]{4,63}$/, 'el nombre del área de registros');
  const q = c.logAnalyticsQuotaGb;
  if (typeof q !== 'number' || !(q >= CUOTA_MIN && q <= CUOTA_MAX)) p.push(`logAnalyticsQuotaGb: el tope diario, de ${CUOTA_MIN} (el mínimo que acepta Azure) a ${CUOTA_MAX} GB; nunca ilimitado`);
  if (fase === 'sitio') {
    pide('storageAccount', CUENTA, 'la cuenta de almacenamiento propia del disco del sitio');
    pide('fileShare', /^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/, 'el recurso compartido de Azure Files');
    if (!Number.isInteger(c.fileShareQuotaGb) || c.fileShareQuotaGb < 1 || c.fileShareQuotaGb > 100) p.push('fileShareQuotaGb: la cuota del disco, de 1 a 100 GB');
    pide('image', IMAGEN, 'la imagen por su huella (<registro>/<nombre>@sha256:…), nunca por etiqueta');
    pide('tenantId', GUID, 'el inquilino de Entra ID');
    if (typeof c.tenantId === 'string' && c.tenantId.toLowerCase() === PERSONALES) p.push('tenantId: es el inquilino de las cuentas personales de Microsoft, no el de la organización');
    pide('oidcClientId', GUID, 'el identificador del cliente del registro de Entra ID');
    const mb = c.mailbox;
    if (!mb || typeof mb !== 'object' || !/^[A-Za-z0-9._()-]{1,90}$/.test(mb.resourceGroup || '') || !CUENTA.test(mb.account || '') || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(mb.container || '')) {
      p.push('mailbox: { resourceGroup, account, container } del buzón de corridas');
    } else if (mb.account === c.storageAccount) p.push('storageAccount: el disco va en una cuenta propia del sitio, nunca en la del buzón (su llave abre la cuenta entera)');
    let repo = null;
    try { repo = new URL(c.operationsRepo); } catch { repo = null; }
    if (!repo || repo.protocol !== 'https:' || repo.username || repo.password) p.push('operationsRepo: la dirección https del repo de operaciones, sin credencial');
    if (!['managed', 'token', 'copy'].includes(c.operationsIdentity)) p.push('operationsIdentity: copy (la copia de operaciones en un contenedor), managed (la identidad del sitio en Azure DevOps) o token (una cuenta dedicada)');
    if (c.operationsIdentity === 'copy') {
      // la cuenta de la copia, con la llave apagada; nunca la del disco (su llave está prendida) ni la del buzón
      const oc = c.operationsCopy;
      if (!oc || typeof oc !== 'object' || !/^[A-Za-z0-9._()-]{1,90}$/.test(oc.resourceGroup || '') || !CUENTA.test(oc.account || '') || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(oc.container || '')) {
        p.push('operationsCopy: { resourceGroup, account, container } de la copia de operaciones');
      } else if (oc.account === c.storageAccount || (c.mailbox && oc.account === c.mailbox.account)) {
        p.push('operationsCopy: la copia va en una cuenta propia, ni la del disco del sitio (su llave está prendida) ni la del buzón');
      }
    } else if (c.operationsCopy !== undefined) p.push('operationsCopy: sólo con operationsIdentity «copy»');
    if (c.firstMaintainer !== undefined && !(typeof c.firstMaintainer === 'string' && CORREO.test(c.firstMaintainer))) p.push('firstMaintainer: un correo');
    if (c.microsoftAccounts !== undefined && !MODOS_MICROSOFT.includes(c.microsoftAccounts)) p.push('microsoftAccounts: organization (un solo inquilino, por defecto) o any (cualquier cuenta de Microsoft; quién entra lo decide la lista del sitio)');
    if (c.profileRepo !== undefined) {
      let u = null;
      try { u = new URL(c.profileRepo); } catch { u = null; }
      // como la del repo de operaciones: una credencial adentro viajaría como variable común y en el plan impreso
      if (!u || u.protocol !== 'https:' || u.username || u.password) p.push('profileRepo: una dirección https, sin credencial');
    }
  }
  return p;
}

/** Los secretos que hacen falta en el entorno, y los opcionales que vinieron. */
function secretosDe(c, env) {
  const pedidos = [...SECRETOS, ...(c.operationsIdentity === 'token' ? [SECRETO_TOKEN] : [])];
  const faltan = pedidos.filter(([v]) => !env[v]).map(([v]) => v);
  const vinieron = [...pedidos, ...OPCIONALES.filter(([v]) => env[v])];
  const apagadas = OPCIONALES.filter(([v]) => !env[v]).map(([v]) => v);
  return { faltan, vinieron, apagadas };
}

// ── la conversación con az ─────────────────────────────────────────────────────────────────────
const comillas = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`);
const AZ = () => process.env.TYCON_AZ_CMD || 'az';

/**
 * El que corre (o imprime) cada paso. En ensayo no llama a az: los valores que vendrían de Azure se muestran como
 * `<…>`. Los secretos son `{ secreto: NOMBRE, valor }`: en lo impreso se ven como `<secreto: NOMBRE>`.
 */
function corredor({ ensayo, salida, dirTmp }) {
  const creados = [];
  const tapar = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && v.secreto ? `<secreto: ${v.secreto}>` : v), 2);
  const real = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && v.secreto ? v.valor : v), 2);
  let n = 0;
  /**
   * Corre az: { status, stdout, stderr }. Si `az` no se pudo lanzar (no está, o se cortó por tiempo), el motivo lo dice
   * con su código: nunca «sin motivo», y nunca como si Azure hubiera contestado.
   */
  const az = (args) => {
    const r = spawnSync(AZ(), args, { encoding: 'utf8', timeout: 900000 });
    if (r.error) return { status: null, stdout: '', stderr: `no pude correr az (${r.error.code || r.error.message})` };
    return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
  };
  return {
    creados,
    /** Una consulta que no crea nada: en ensayo devuelve el marcador. */
    leer(args, marcador) {
      if (ensayo) return marcador;
      const r = az(args);
      if (r.status !== 0) throw new Falla(`no pude leer de Azure (az ${args.slice(0, 3).join(' ')}): ${primera(r.stderr)}`);
      return r.stdout.trim();
    },
    /** Un secreto que se lee de Azure: nunca se imprime. Vacío o `None` (un null en -o tsv) frena acá, no después. */
    leerSecreto(args, nombre) {
      if (ensayo) return { secreto: nombre, valor: null };
      const r = az(args);
      if (r.status !== 0) throw new Falla(`no pude leer ${nombre} de Azure: ${primera(r.stderr)}`);
      const valor = r.stdout.trim();
      if (!valor || valor === 'None') throw new Falla(`${nombre} vino vacía de Azure: no la uso`);
      return { secreto: nombre, valor };
    },
    /**
     * ¿Existe? En ensayo, no (el plan muestra lo que crearía). Una salida distinta de 0 es «no existe» SÓLO si Azure dice
     * que no lo encontró; cualquier otra falla (sesión vencida, permiso, red, az que no corre) frena: una salida que no
     * contesta puede ser un comando que falló, y crear de nuevo pisaría lo que capaz ya está.
     */
    existe(args) {
      if (ensayo) return false;
      const r = az([...args, '-o', 'none']);
      if (r.status === 0) return true;
      // cada servicio dice «no existe» a su manera: Azure Resource Manager (ResourceNotFound) y Azure Files (ShareNotFound)
      if (r.status !== null && /ResourceNotFound|ResourceGroupNotFound|ShareNotFound|could not be found|was not found|does not exist/i.test(r.stderr)) return false;
      throw new Falla(`no pude saber si existe (az ${args.slice(0, 3).join(' ')}): ${primera(r.stderr)}`);
    },
    /**
     * Un paso que crea o cambia algo. `archivo`: el cuerpo, con secretos adentro. `reintentar`: `{ si, veces }`, sólo
     * ante un error que se sabe pasajero (`si`, sobre el stderr), con la espera de TYCON_CONTAINER_APPS_POLL_MS entre
     * intentos; cualquier otro error frena en el primero.
     */
    paso({ que, args, archivo = null, nombreArchivo = null, reintentar = null }) {
      let ruta = null;
      if (archivo) {
        n += 1;
        ruta = path.join(dirTmp, nombreArchivo || `cuerpo-${n}.json`);
      }
      const visibles = args.map((a) => (a === '@ARCHIVO' ? `@${path.basename(ruta)}` : a === 'ARCHIVO' ? path.basename(ruta) : a));
      salida(`• ${que}\n  az ${visibles.map(comillas).join(' ')}`);
      if (archivo) salida(`  con el archivo ${path.basename(ruta)}:\n${tapar(archivo).replace(/^/gm, '    ')}`);
      if (ensayo) return;
      if (archivo) fs.writeFileSync(ruta, real(archivo), { mode: 0o600 });
      const correrlo = () => az(args.map((a) => (a === '@ARCHIVO' ? `@${ruta}` : a === 'ARCHIVO' ? ruta : a)));
      let r = correrlo();
      const espera = Number(process.env.TYCON_CONTAINER_APPS_POLL_MS) || 15000;
      for (let i = 1; reintentar && r.status !== 0 && reintentar.si.test(r.stderr || '') && i < reintentar.veces; i++) {
        salida(`  (Azure todavía no lo ve: intento ${i + 1} de ${reintentar.veces} en ${Math.round(espera / 1000)} s)`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, espera);
        r = correrlo();
      }
      if (archivo) fs.rmSync(ruta, { force: true });
      if (r.status !== 0) throw new Falla(`${que}: ${primera(r.stderr)}`, { cause: { que, stderr: r.stderr } });
      creados.push(que);
    },
  };
}
const primera = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || 'sin motivo';

// ── las fases ──────────────────────────────────────────────────────────────────────────────────
const SUB = (c) => ['--subscription', c.subscription];
const urlArm = (c, resto) => `https://management.azure.com/subscriptions/${c.subscription}/resourceGroups/${c.resourceGroup}/providers/Microsoft.App/managedEnvironments/${c.environment}${resto}?api-version=${API}`;

function faseAmbiente(c, run, salida, ensayo) {
  for (const ns of ['Microsoft.App', 'Microsoft.OperationalInsights']) {
    const estado = run.leer(['provider', 'show', '-n', ns, '--query', 'registrationState', '-o', 'tsv', ...SUB(c)], 'NotRegistered');
    if (estado !== 'Registered') run.paso({ que: `registrar el proveedor ${ns}`, args: ['provider', 'register', '-n', ns, '--wait', ...SUB(c)] });
  }
  if (!run.existe(['group', 'show', '-n', c.resourceGroup, ...SUB(c)])) {
    run.paso({ que: 'crear el grupo de recursos propio del sitio', args: ['group', 'create', '-n', c.resourceGroup, '-l', c.location, '-o', 'none', ...SUB(c)] });
  }
  const area = ['monitor', 'log-analytics', 'workspace'];
  if (!run.existe([...area, 'show', '-g', c.resourceGroup, '-n', c.logAnalyticsWorkspace, ...SUB(c)])) {
    run.paso({ que: 'crear el área de registros (31 días, con tope diario)', args: [...area, 'create', '-g', c.resourceGroup, '-n', c.logAnalyticsWorkspace, '-l', c.location,
      '--retention-time', '31', '--quota', String(c.logAnalyticsQuotaGb), '-o', 'none', ...SUB(c)] });
  }
  if (!run.existe(['containerapp', 'env', 'show', '-g', c.resourceGroup, '-n', c.environment, ...SUB(c)])) {
    const cliente = run.leer([...area, 'show', '-g', c.resourceGroup, '-n', c.logAnalyticsWorkspace, '--query', 'customerId', '-o', 'tsv', ...SUB(c)], `<customerId del área ${c.logAnalyticsWorkspace}>`);
    const llave = run.leerSecreto([...area, 'get-shared-keys', '-g', c.resourceGroup, '-n', c.logAnalyticsWorkspace, '--query', 'primarySharedKey', '-o', 'tsv', ...SUB(c)], 'la llave del área de registros');
    run.paso({
      que: 'crear el ambiente (perfiles de carga, con Consumption; los registros en el área de arriba, explícito)',
      args: ['rest', '--method', 'put', '--url', urlArm(c, ''), '--body', '@ARCHIVO', '-o', 'none'],
      archivo: { location: c.location, properties: { appLogsConfiguration: { destination: 'log-analytics', logAnalyticsConfiguration: { customerId: cliente, sharedKey: llave } },
        workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }] } },
      nombreArchivo: 'ambiente.json',
    });
    esperarAmbiente(c, run, ensayo);
  }
  const dominio = run.leer(['containerapp', 'env', 'show', '-g', c.resourceGroup, '-n', c.environment, '--query', 'properties.defaultDomain', '-o', 'tsv', ...SUB(c)], '<defaultDomain del ambiente>');
  const dir = `https://${c.app}.${dominio}`;
  salida(`\nLa dirección que tendrá el sitio: ${dir}`);
  salida(`Agregá al registro de Entra ID estas dos vueltas (Authentication → Web → Redirect URIs):\n  ${dir}/auth/callback\n  ${dir}/.auth/login/aad/callback`);
  salida('Después corré la fase sitio.');
}

function esperarAmbiente(c, run, ensayo) {
  if (ensayo) return;
  const espera = Number(process.env.TYCON_CONTAINER_APPS_POLL_MS) || 15000;
  for (let i = 0; i < 80; i++) {
    const e = run.leer(['containerapp', 'env', 'show', '-g', c.resourceGroup, '-n', c.environment, '--query', 'properties.provisioningState', '-o', 'tsv', ...SUB(c)], 'Succeeded');
    if (e === 'Succeeded') return;
    if (e === 'Failed') throw new Falla('el ambiente quedó en Failed: mirá el registro de actividad del grupo de recursos');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, espera);
  }
  throw new Falla('el ambiente no terminó de crearse a tiempo: corré la fase de nuevo en unos minutos');
}

function faseSitio(c, run, salida, env, sec) {
  const g = ['-g', c.resourceGroup];
  const cualquiera = c.microsoftAccounts === 'any';
  // en minúsculas: Entra publica así el emisor de un inquilino, y el sitio lo compara letra por letra
  const tenant = c.tenantId.toLowerCase();
  const dominio = run.leer(['containerapp', 'env', 'show', ...g, '-n', c.environment, '--query', 'properties.defaultDomain', '-o', 'tsv', ...SUB(c)], '<defaultDomain del ambiente>');
  const idAmbiente = run.leer(['containerapp', 'env', 'show', ...g, '-n', c.environment, '--query', 'id', '-o', 'tsv', ...SUB(c)], `<id del ambiente ${c.environment}>`);
  const publica = `https://${c.app}.${dominio}`;
  // el disco: una cuenta propia, un recurso compartido con cuota, agregado al ambiente
  if (!run.existe(['storage', 'account', 'show', '-n', c.storageAccount, ...g, ...SUB(c)])) {
    run.paso({ que: 'crear la cuenta de almacenamiento propia del disco del sitio', args: ['storage', 'account', 'create', '-n', c.storageAccount, ...g, '-l', c.location,
      '--sku', 'Standard_LRS', '--kind', 'StorageV2', '--min-tls-version', 'TLS1_2', '--allow-blob-public-access', 'false', '-o', 'none', ...SUB(c)] });
  }
  if (!run.existe(['storage', 'share-rm', 'show', '--storage-account', c.storageAccount, ...g, '-n', c.fileShare, ...SUB(c)])) {
    run.paso({ que: 'crear el recurso compartido de Azure Files (el disco)', args: ['storage', 'share-rm', 'create', '--storage-account', c.storageAccount, ...g, '-n', c.fileShare,
      '--quota', String(c.fileShareQuotaGb), '-o', 'none', ...SUB(c)] });
  }
  // la copia de operaciones: una cuenta propia con la LLAVE APAGADA (sólo entran identidades con su rol) y el
  // contenedor por el plano de gestión (`container-rm`: no hace falta un rol de datos para crearlo)
  if (c.operationsIdentity === 'copy') {
    const oc = c.operationsCopy;
    const gc = ['-g', oc.resourceGroup];
    if (!run.existe(['storage', 'account', 'show', '-n', oc.account, ...gc, ...SUB(c)])) {
      run.paso({ que: 'crear la cuenta de la copia de operaciones, con la llave apagada', args: ['storage', 'account', 'create', '-n', oc.account, ...gc, '-l', c.location,
        '--sku', 'Standard_LRS', '--kind', 'StorageV2', '--min-tls-version', 'TLS1_2', '--allow-blob-public-access', 'false', '--allow-shared-key-access', 'false', '-o', 'none', ...SUB(c)] });
    } else {
      // una cuenta que ya existía (o a la que alguien le volvió a prender la llave): cada corrida la deja apagada
      run.paso({ que: 'dejar la llave de la cuenta de la copia apagada (y sin acceso público)', args: ['storage', 'account', 'update', '-n', oc.account, ...gc,
        '--allow-shared-key-access', 'false', '--allow-blob-public-access', 'false', '-o', 'none', ...SUB(c)] });
    }
    if (!run.existe(['storage', 'container-rm', 'show', '--storage-account', oc.account, ...gc, '-n', oc.container, ...SUB(c)])) {
      run.paso({ que: 'crear el contenedor de la copia', args: ['storage', 'container-rm', 'create', '--storage-account', oc.account, ...gc, '-n', oc.container, '--public-access', 'off', '-o', 'none', ...SUB(c)] });
    }
  }
  const llaveCuenta = run.leerSecreto(['storage', 'account', 'keys', 'list', '-n', c.storageAccount, ...g, '--query', '[0].value', '-o', 'tsv', ...SUB(c)], 'la llave de la cuenta del disco');
  run.paso({
    que: 'agregar el disco al ambiente',
    args: ['rest', '--method', 'put', '--url', urlArm(c, `/storages/${ALMACEN_AMBIENTE}`), '--body', '@ARCHIVO', '-o', 'none'],
    archivo: { properties: { azureFile: { accountName: c.storageAccount, accountKey: llaveCuenta, shareName: c.fileShare, accessMode: 'ReadWrite' } } },
    nombreArchivo: 'disco.json',
  });
  // la aplicación: se crea con la entrada interna; si ya existe, se actualiza con la misma configuración (imagen, secretos
  // y variables), así volver a correr la fase aplica los cambios en vez de saltearlos
  const yaExiste = run.existe(['containerapp', 'show', ...g, '-n', c.app, ...SUB(c)]);
  {
    const comunes = [['SITE_PUBLIC_URL', publica], ['SITE_AUTH_PROVIDER', 'microsoft'], ['SITE_OIDC_ISSUER', cualquiera ? COMUN : `https://login.microsoftonline.com/${tenant}/v2.0`],
      ...(cualquiera ? [['SITE_AUTH_MICROSOFT_ACCOUNTS', 'any'], ['SITE_AUTH_MICROSOFT_TENANT', tenant]] : []),
      ['SITE_OIDC_CLIENT_ID', c.oidcClientId], ['SITE_OPERATIONS_REPO', c.operationsRepo], ['SITE_MAILBOX_IDENTITY', 'managed'], ['SITE_DATA_DIR', DISCO],
      ...(c.operationsIdentity === 'managed' ? [['SITE_OPERATIONS_IDENTITY', 'managed']] : []),
      ...(c.operationsIdentity === 'copy' ? [['SITE_OPERATIONS_SOURCE', 'copy'], ['SITE_OPERATIONS_COPY', `${c.operationsCopy.account}/${c.operationsCopy.container}`]] : []),
      ...(c.firstMaintainer ? [['SITE_FIRST_MAINTAINER', c.firstMaintainer]] : []),
      ...(c.profileRepo ? [['SITE_PROFILE_REPO', c.profileRepo]] : [])];
    const yaml = {
      location: c.location,
      identity: { type: 'SystemAssigned' },
      properties: {
        managedEnvironmentId: idAmbiente,
        workloadProfileName: 'Consumption',
        configuration: {
          ingress: { external: false, targetPort: 8080, allowInsecure: false, transport: 'auto' },
          secrets: sec.vinieron.map(([v, nombre]) => ({ name: nombre, value: { secreto: v, valor: env[v] } })),
        },
        template: {
          containers: [{
            name: 'sitio',
            image: c.image,
            resources: { cpu: 0.5, memory: '1Gi' },
            env: [...comunes.map(([name, value]) => ({ name, value })), ...sec.vinieron.map(([v, nombre]) => ({ name: v, secretRef: nombre }))],
            // las dos contra /livez. La vida nunca contra /healthz: con el sitio frenado da 503, y reiniciar no arregla
            // operations.json. La de «lista» tampoco contra /readyz ni /healthz: la plataforma no manda tráfico hasta que
            // pase, y el sitio ya sirve cada pestaña apenas la puede armar (la que espera dice «cargando» y se recarga
            // sola; la frenada explica por qué). El plazo de 5 s deja contestar a un proceso ocupado; la vida tolera
            // 2,5 minutos sin respuesta antes de reiniciar
            probes: [
              { type: 'Liveness', httpGet: { path: '/livez', port: 8080 }, initialDelaySeconds: 10, periodSeconds: 30, timeoutSeconds: 5, failureThreshold: 5 },
              { type: 'Readiness', httpGet: { path: '/livez', port: 8080 }, initialDelaySeconds: 2, periodSeconds: 5, timeoutSeconds: 5, failureThreshold: 3 },
            ],
            volumeMounts: [{ volumeName: 'datos', mountPath: DISCO }],
          }],
          scale: { minReplicas: 0, maxReplicas: 1 },
          volumes: [{ name: 'datos', storageType: 'AzureFile', storageName: ALMACEN_AMBIENTE }],
        },
      },
    };
    if (sec.apagadas.length) salida(`  (quedan apagadas, porque no vinieron en el entorno: ${sec.apagadas.join(', ')})`);
    if (!yaExiste) {
      run.paso({ que: 'crear la aplicación, con la entrada INTERNA (todavía no se ve desde afuera)', args: ['containerapp', 'create', ...g, '-n', c.app, '--yaml', 'ARCHIVO', '-o', 'none', ...SUB(c)], archivo: yaml, nombreArchivo: 'aplicacion.yaml' });
    } else {
      // lo que tiene hoy, para decir qué cambia; la entrada se deja como está (un sitio ya abierto no se cierra al actualizar)
      const q = (consulta, siNo) => run.leer(['containerapp', 'show', ...g, '-n', c.app, '--query', consulta, '-o', 'tsv', ...SUB(c)], siNo);
      const lista = (s) => String(s || '').split(/\s+/).filter(Boolean).sort();
      const antes = {
        imagen: q('properties.template.containers[0].image', '<la imagen de hoy>'),
        secretos: lista(q('properties.configuration.secrets[].name', '')),
        variables: lista(q('properties.template.containers[0].env[].name', '')),
        externa: q('properties.configuration.ingress.external', 'false') === 'true',
      };
      yaml.properties.configuration.ingress.external = antes.externa;
      const ahora = { secretos: yaml.properties.configuration.secrets.map((s) => s.name).sort(), variables: yaml.properties.template.containers[0].env.map((e) => e.name).sort() };
      const dif = (a, b) => ({ mas: b.filter((x) => !a.includes(x)), menos: a.filter((x) => !b.includes(x)) });
      const ds = dif(antes.secretos, ahora.secretos);
      const dv = dif(antes.variables, ahora.variables);
      const cambios = [
        antes.imagen !== c.image ? `imagen: ${antes.imagen} → ${c.image}` : 'imagen: la misma',
        ds.mas.length || ds.menos.length ? `secretos: ${[...ds.mas.map((x) => `+${x}`), ...ds.menos.map((x) => `-${x}`)].join(' ')}` : 'secretos: los mismos nombres (los valores se vuelven a poner con los del entorno)',
        dv.mas.length || dv.menos.length ? `variables: ${[...dv.mas.map((x) => `+${x}`), ...dv.menos.map((x) => `-${x}`)].join(' ')}` : 'variables: los mismos nombres',
        `entrada: ${antes.externa ? 'externa (queda así)' : 'interna (se abre al final)'}`,
      ];
      salida(`La aplicación ya existe: se actualiza.\n${cambios.map((x) => `  · ${x}`).join('\n')}`);
      run.paso({ que: 'actualizar la aplicación (imagen, secretos y variables), con los secretos en el archivo', args: ['containerapp', 'update', ...g, '-n', c.app, '--yaml', 'ARCHIVO', '-o', 'none', ...SUB(c)], archivo: yaml, nombreArchivo: 'aplicacion.yaml' });
    }
  }
  // el rol de lectura del buzón (y, con la copia, el de su contenedor), sobre el contenedor (no sobre la cuenta)
  const principal = run.leer(['containerapp', 'show', ...g, '-n', c.app, '--query', 'identity.principalId', '-o', 'tsv', ...SUB(c)], '<la identidad del sitio>');
  const contenedor = (rg, cuenta, k) => `/subscriptions/${c.subscription}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${cuenta}/blobServices/default/containers/${k}`;
  const lecturas = [['la lectura del contenedor del buzón', contenedor(c.mailbox.resourceGroup, c.mailbox.account, c.mailbox.container)]];
  if (c.operationsIdentity === 'copy') lecturas.push(['la lectura del contenedor de la copia de operaciones', contenedor(c.operationsCopy.resourceGroup, c.operationsCopy.account, c.operationsCopy.container)]);
  for (const [que, alcance] of lecturas) {
    const yaHay = run.leer(['role', 'assignment', 'list', '--assignee', principal, '--role', 'Storage Blob Data Reader', '--scope', alcance, '--query', 'length(@)', '-o', 'tsv', ...SUB(c)], '0');
    if (yaHay !== '0') continue;
    // la identidad recién creada tarda en llegar a Entra ID: «Cannot find user or service principal in graph database»
    // es esa demora, y se reintenta con espera; cualquier otro error frena
    run.paso({ que: `dar a la identidad del sitio ${que}`, args: ['role', 'assignment', 'create', '--assignee-object-id', principal, '--assignee-principal-type', 'ServicePrincipal',
      '--role', 'Storage Blob Data Reader', '--scope', alcance, '-o', 'none', ...SUB(c)], reintentar: { si: /Cannot find user or service principal in graph database/i, veces: 12 } });
  }
  if (c.operationsIdentity === 'copy') {
    // la escritura es del trabajo que copia, con SU identidad (no la del sitio): el alta no la conoce, la da quien la creó
    const alcance = contenedor(c.operationsCopy.resourceGroup, c.operationsCopy.account, c.operationsCopy.container);
    salida(`\nEl trabajo que copia (pipelines/operations/site-copy.yml) escribe con su propia identidad. Dale el rol sobre ESTE contenedor y nada más:\n  az role assignment create --assignee-object-id <la identidad del trabajo que copia> --assignee-principal-type ServicePrincipal --role "Storage Blob Data Contributor" --scope ${alcance}`);
  }
  if (cualquiera) {
    // «cualquier cuenta», después de poner el sitio nuevo: la puerta se abre con la lista ya en la imagen.
    // Lo hace la sesión de quien instala, dueña del registro; el sitio no recibe ningún permiso sobre el directorio.
    // Medido en la parte A: el registro tiene que pedir el correo verificado, y pasar a cuentas personales exige los
    // tokens de acceso v2 en el MISMO cambio.
    const leerClaims = ['ad', 'app', 'show', '--id', c.oidcClientId, '--query', 'optionalClaims.idToken[].name', '-o', 'tsv'];
    salida(`• revisar que el registro pida el correo verificado (email y xms_edov): sólo lee\n  az ${leerClaims.map(comillas).join(' ')}`);
    const claims = run.leer(leerClaims, 'email\txms_edov');
    const pide = String(claims).split(/\s+/).filter(Boolean);
    const faltan = ['email', 'xms_edov'].filter((x) => !pide.includes(x));
    if (faltan.length) throw new Falla(`el registro de Entra ID no pide ${faltan.join(' ni ')} en el token: sin el correo verificado nadie entra. Agregalas (Token configuration → Add optional claim → ID) y volvé a correr`);
    run.paso({ que: 'el registro de Entra ID acepta cualquier cuenta de Microsoft (con los tokens v2)', args: ['rest', '--method', 'patch', '--url', `https://graph.microsoft.com/v1.0/applications(appId='${c.oidcClientId}')`,
      '--headers', 'Content-Type=application/json', '--body', '@ARCHIVO', '-o', 'none'],
    archivo: { api: { requestedAccessTokenVersion: 2 }, signInAudience: 'AzureADandPersonalMicrosoftAccount' }, nombreArchivo: 'registro.json' });
    run.paso({ que: 'sin asignación requerida: quién entra lo decide la lista del sitio', args: ['ad', 'sp', 'update', '--id', c.oidcClientId, '--set', 'appRoleAssignmentRequired=false', '-o', 'none'] });
  }
  // el inicio integrado, el secreto por su nombre. Con un inquilino, el emisor es el suyo; con cualquier cuenta, el común
  // (la plataforma no mira de qué inquilino viene: deja pasar cualquier cuenta de Microsoft y decide el sitio). El
  // inquilino va en el emisor: az no acepta --issuer y --tenant-id juntos («cannot be configured to non empty strings at
  // the same time»)
  run.paso({ que: cualquiera ? 'el inicio integrado de Microsoft (cualquier cuenta)' : 'el inicio integrado de Microsoft (un inquilino)', args: ['containerapp', 'auth', 'microsoft', 'update', ...g, '-n', c.app, '--client-id', c.oidcClientId,
    '--client-secret-name', 'site-oidc-client-secret', '--issuer', cualquiera ? COMUN : `https://login.microsoftonline.com/${tenant}/v2.0`,
    '--allowed-audiences', c.oidcClientId, '--yes', '-o', 'none', ...SUB(c)] });
  run.paso({ que: `el candado delante del sitio (fuera: ${RUTAS_SIN_SESION.join(', ')})`, args: ['containerapp', 'auth', 'update', ...g, '-n', c.app, '--enabled', 'true',
    '--unauthenticated-client-action', 'RedirectToLoginPage', '--require-https', 'true', '--excluded-paths', RUTAS_SIN_SESION.join(','), '-o', 'none', ...SUB(c)] });
  // por último, la entrada externa
  run.paso({ que: 'abrir la entrada externa (sólo HTTPS) — el último paso', args: ['containerapp', 'ingress', 'update', ...g, '-n', c.app, '--type', 'external', '--allow-insecure', 'false', '-o', 'none', ...SUB(c)] });
  salida(`\nEl sitio: ${publica}`);
  salida('Esperá unos diez minutos (lo que tarda en valer el rol) y probalo sin sesión: node scripts/site/check-deploy.js --url ' + publica);
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────
function main(argv) {
  let config = null; let fase = null; let modo = null; let error = null;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--config') config = argv[++i];
    else if (v === '--phase') fase = argv[++i];
    else if (v === '--dry-run' || v === '--apply') modo = modo ? 'ambos' : v.slice(2);
    else error = `opción desconocida: ${v}`;
  }
  const salida = (t) => process.stdout.write(`${t}\n`);
  if (error || !config || !['ambiente', 'sitio'].includes(fase) || !['dry-run', 'apply'].includes(modo)) {
    if (error) process.stderr.write(`${error}\n`);
    process.stderr.write('uso: azure-container-apps.js --config <archivo.json> --phase ambiente|sitio --dry-run|--apply\n');
    return 2;
  }
  let c;
  try { c = JSON.parse(fs.readFileSync(config, 'utf8')); } catch (e) {
    process.stderr.write(`🔴 no pude leer la configuración (${(e && e.code) || 'no es JSON'})\n`);
    return 1;
  }
  const p = problemas(c, fase);
  if (p.length) { for (const x of p) process.stderr.write(`🔴 ${x}\n`); return 1; }
  const sec = fase === 'sitio' ? secretosDe(c, process.env) : { faltan: [], vinieron: [], apagadas: [] };
  if (sec.faltan.length) {
    process.stderr.write(`🔴 faltan en el entorno: ${sec.faltan.join(', ')} (los valores de los secretos llegan por variables de entorno; nada se creó)\n`);
    return 1;
  }
  const ensayo = modo === 'dry-run';
  if (!ensayo) {
    const s = spawnSync(AZ(), ['account', 'show', '-o', 'json'], { encoding: 'utf8', timeout: 60000 });
    // que az no corra (no está, o se cortó) no es «sin sesión»: se dice cuál de las dos es
    if (s.error) {
      process.stderr.write(`🔴 no pude correr az (${s.error.code || s.error.message}): instalalo o revisá el PATH y volvé a lanzarlo\n`);
      return 1;
    }
    if (s.status !== 0) {
      process.stderr.write("🔴 no hay sesión de az: corré «az login» (este guion no abre una) y volvé a lanzarlo\n");
      return 1;
    }
  }
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alta-sitio-'));
  fs.chmodSync(dirTmp, 0o700);
  // los archivos temporales llevan secretos: también se borran si cortan el alta con Ctrl+C
  const borrarAlCortar = (senal) => () => { fs.rmSync(dirTmp, { recursive: true, force: true }); process.exit(senal === 'SIGINT' ? 130 : 143); };
  for (const senal of ['SIGINT', 'SIGTERM']) process.once(senal, borrarAlCortar(senal));
  salida(`${ensayo ? 'Plan (ensayo: no se crea nada)' : 'Alta'} — fase ${fase}\n`);
  const run = corredor({ ensayo, salida, dirTmp });
  try {
    if (fase === 'ambiente') faseAmbiente(c, run, salida, ensayo);
    else faseSitio(c, run, salida, process.env, sec);
    return 0;
  } catch (e) {
    if (!(e instanceof Falla)) throw e;
    process.stderr.write(`\n🔴 falló: ${e.message}\n`);
    if (/roleAssignments|AuthorizationFailed|\b403\b/.test(e.message)) {
      process.stderr.write('   Para asignar el rol hace falta Owner o User Access Administrator sobre la cuenta del buzón (no alcanza Contributor).\n');
    }
    process.stderr.write(`   Lo que quedó creado: ${run.creados.length ? run.creados.join(' · ') : 'nada'}.\n`);
    if (fase === 'sitio') process.stderr.write('   El sitio no es alcanzable desde afuera: la entrada sigue interna. Corré la fase de nuevo: sigue desde donde quedó.\n');
    return 1;
  } finally {
    fs.rmSync(dirTmp, { recursive: true, force: true });
  }
}

module.exports = { problemas, secretosDe, CUOTA_MIN, CUOTA_MAX };

if (require.main === module) process.exit(main(process.argv.slice(2)));
