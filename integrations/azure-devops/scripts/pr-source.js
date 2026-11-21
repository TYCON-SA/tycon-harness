'use strict';
// pr-source.js — la rama de origen de un pedido de Azure DevOps, para el freno de pedidos (scripts/hooks/
// pr-auto-complete-guard.js): un `update` no dice de qué rama sale el pedido, y con «borrar la rama al completar» desde
// una rama de larga vida la plataforma la borraría. Una lectura:
//   az repos pr show --id <n> [--org <org>] --query sourceRefName -o tsv
// Sin `--project`, que `pr show` no acepta. La organización vale sólo si es una de Azure DevOps (`esOrgValida`): el freno
// corre antes del permiso, y un `--org` ajeno le mandaría la credencial de az a otro servidor.

const path = require('path');

// La organización de una consulta: sólo una de Azure DevOps, con su nombre como en `orgDe` (change-requests.js).
const ORG_DE_AZURE = /^https:\/\/(?:dev\.azure\.com\/[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*\.visualstudio\.com)\/?$/;
// El tope de la consulta: 15 s; la variable sólo lo acorta (un entero de 1 a 15000). Un tope 0 sería «sin tope»
const TOPE_DE_LA_CONSULTA_MS = 15000;
function topeDeLaConsulta(env = process.env) {
  const t = String(env.TYCON_PR_GUARD_AZ_TIMEOUT_MS == null ? '' : env.TYCON_PR_GUARD_AZ_TIMEOUT_MS).trim();
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  return n >= 1 && n <= TOPE_DE_LA_CONSULTA_MS ? n : TOPE_DE_LA_CONSULTA_MS;
}

/** ¿El texto es la dirección de una organización de Azure DevOps? */
const esOrgValida = (texto) => ORG_DE_AZURE.test(String(texto == null ? '' : texto).trim());

/**
 * La rama de origen del pedido `id`, preguntada a Azure con `az repos pr show`: `{ rama }` (sin `refs/heads/`) o
 * `{ problema }`. Sin `--project`, que `pr show` no acepta; con el `--org` del comando, o sin ninguno. Corre en la
 * carpeta de la sesión y con su tope; en Windows, por la consola, con `llamadaAz` del conector de Azure DevOps.
 * `exec` reemplaza a `spawnSync` en las pruebas.
 */
function consultaDeOrigen({ id, org = null, cwd = process.cwd(), plataforma = process.platform, env = process.env, exec = null }) {
  const args = ['repos', 'pr', 'show', '--id', String(id), ...(org ? ['--org', String(org)] : []), '--query', 'sourceRefName', '-o', 'tsv'];
  let llamada;
  try {
    const { llamadaAz } = require(path.join(__dirname, 'change-requests.js'));
    llamada = llamadaAz('az', args, plataforma);
  } catch (e) { return { problema: `no pude cargar el conector de Azure DevOps (${String((e && e.message) || e).split('\n')[0]})` }; }
  if (llamada.problem) return { problema: llamada.problem };
  const correr = exec || require('child_process').spawnSync;
  let r;
  try {
    r = correr(llamada.file, llamada.args, { cwd, env, shell: llamada.shell, encoding: 'utf8', windowsHide: true, timeout: topeDeLaConsulta(env), killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return { problema: `az no corrió (${String((e && e.message) || e).split('\n')[0]})` }; }
  if (!r || r.error) {
    const e = r && r.error;
    if (e && e.code === 'ENOENT') return { problema: 'no encuentro az en esta máquina' };
    if (e && e.code === 'ETIMEDOUT') return { problema: 'az no contestó a tiempo' };
    return { problema: `az no corrió (${(e && (e.code || e.message)) || 'sin respuesta'})` };
  }
  if (r.signal) return { problema: 'az no contestó a tiempo' };
  if (r.status !== 0) return { problema: `az salió con ${r.status}` };
  const rama = String(r.stdout || '').replace(/\s+/g, '').replace(/^refs\/heads\//i, '');
  if (!rama || /^(none|null)$/i.test(rama)) return { problema: 'az no devolvió la rama del pedido' };
  return { rama };
}

module.exports = { consultaDeOrigen, esOrgValida, topeDeLaConsulta };
