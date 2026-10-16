'use strict';
/*
 * cloud/azure.js — LO ÚNICO DE AZURE DEL NÚCLEO DEL SITIO (story 2.23, AC 4 y 13).
 *
 * El núcleo no depende de ninguna nube: corre igual en Azure Container Apps, Render, Google Cloud Run o una máquina con
 * Docker. Lo de Azure vive acá y sólo se usa con `SITE_OPERATIONS_IDENTITY=managed` o `SITE_MAILBOX_IDENTITY=managed`:
 *
 *   · `tokenDeIdentidad(recurso)` pide el token de la IDENTIDAD ADMINISTRADA del contenedor al endpoint que la
 *     plataforma inyecta (`IDENTITY_ENDPOINT` + `IDENTITY_HEADER`, la forma de App Service y Container Apps,
 *     api-version 2019-08-01). Sin esas variables —el sitio no está en Azure— dice por qué y no inventa nada.
 *   · Los recursos: el almacenamiento (`https://storage.azure.com/`, para leer el buzón con el rol de lector de datos) y
 *     Azure DevOps (el id PÚBLICO de la aplicación de Azure DevOps en Entra, el mismo para todas las organizaciones —no
 *     es un valor de ninguna—; leído en Microsoft Learn, «Use service principals & managed identities in Azure DevOps»,
 *     2026-10-15). La identidad se agrega a la organización de Azure DevOps una vez (2.30).
 *   · La lectura de Azure Blob la hace `bajar()` de scripts/metrics/download-runs.js, con la credencial que le pasa el
 *     sitio: la SAS de sólo lectura o este token.
 *
 * El token nunca se escribe en disco ni en el registro: vive en la memoria del proceso lo que dura un refresco.
 */
const { pedir } = require('../oidc.js');

const RECURSO_ALMACENAMIENTO = 'https://storage.azure.com/';
const RECURSO_AZURE_DEVOPS = '499b84ac-1321-427f-aa17-267ca6975798';

/** { token } o { estado, motivo }. Nunca rechaza. */
async function tokenDeIdentidad(recurso, env = process.env) {
  const endpoint = env.IDENTITY_ENDPOINT;
  const cabecera = env.IDENTITY_HEADER;
  if (!endpoint || !cabecera) return { estado: 'sin_configurar', motivo: 'no hay identidad administrada en esta plataforma (faltan IDENTITY_ENDPOINT e IDENTITY_HEADER): fuera de Azure va la credencial por variable' };
  let u;
  try { u = new URL(endpoint); } catch { return { estado: 'sin_configurar', motivo: 'IDENTITY_ENDPOINT no es una dirección' }; }
  u.searchParams.set('resource', recurso);
  u.searchParams.set('api-version', '2019-08-01');
  const r = await pedir(u.toString(), { headers: { 'X-IDENTITY-HEADER': cabecera, accept: 'application/json' }, timeoutMs: 15000 });
  if (r.error) return { estado: 'sin_red', motivo: `el endpoint de la identidad administrada no respondió (${r.error.code || r.error.message})` };
  if (r.status === 401 || r.status === 403) return { estado: 'credencial_rechazada', motivo: `el endpoint de la identidad administrada contestó ${r.status}` };
  let json = null;
  try { json = JSON.parse(r.cuerpo); } catch { /* abajo */ }
  if (r.status !== 200 || !json || typeof json.access_token !== 'string' || !json.access_token) return { estado: 'sin_permiso', motivo: `el endpoint de la identidad administrada contestó ${r.status} sin token` };
  return { token: json.access_token };
}

// ── Lo que el núcleo le pide a una nube (sources.js recorre cloud/ y no nombra a ninguna) ──────────────────────────
/** Los proveedores de buzón (`site.mailbox.provider`) que esta nube sabe leer. */
const PROVEEDORES_DE_BUZON = ['azure-blob'];

/** Baja el buzón con `bajar()` de download-runs.js: { codigo, res }. */
function bajarBuzon({ cuenta, contenedor, credencial, dir, urlBase, log }) {
  const { bajar } = require('../../metrics/download-runs.js');
  return bajar({ cuenta, contenedor, credencial, dir, sinHilos: true, urlBase, budgetMs: 120000, log });
}

/** El token de la identidad administrada para leer el repo de operaciones en Azure DevOps. */
const tokenParaRepo = () => tokenDeIdentidad(RECURSO_AZURE_DEVOPS);

module.exports = { tokenDeIdentidad, tokenParaRepo, bajarBuzon, PROVEEDORES_DE_BUZON, RECURSO_ALMACENAMIENTO, RECURSO_AZURE_DEVOPS };
