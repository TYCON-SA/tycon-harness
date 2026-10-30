#!/usr/bin/env node
'use strict';
// azure-only.js — ¿la organización trabaja en Azure DevOps? Lo preguntan los guiones que sólo existen ahí
// (validate-pipeline-in-ado.sh, label-prs.sh, grant-new-product-permissions.js) antes de consultar nada.
//
// Si la capa de plataforma está (scripts/lib/platform/platform.js) y la cola de la organización (`queue.read`) es de otra
// plataforma, dice en una línea `no_soportado: <guion>: <razón>`. Sin la capa (el artefacto de la CI no la trae) o sin
// elección de nadie, no dice nada: el guion sigue como siempre. Con la elección rota (el perfil dañado, un conector que no
// carga, la capa que lanza) dice `no_medido: <guion>: <razón>` y frena siempre: no saber la plataforma no es Azure.
//
// Uso: node azure-only.js <nombre del guion>
// Salida: 0 = seguir (Azure DevOps, o nadie eligió) · 2 = no_soportado o no_medido, y quien llama frena (lo de fábrica:
// un portón que lee «no lo pude hacer» como verde deja pasar lo que no se miró) · 3 = no_soportado, y quien llama lo
// pidió a propósito con TYCON_ALLOW_UNSUPPORTED=1 (sale 0 con la línea dicha). Cualquier otra salida (node que no
// arranca, este archivo que se rompe) es «no pude preguntar», y quien llama la trata como el 2.

const fs = require('fs');
const path = require('path');

const PLATFORM = path.join(__dirname, '..', 'lib', 'platform', 'platform.js');
// en un renglón: un salto en un motivo dejaría una línea suelta, y en la CI una línea que empieza con ##vso[ es una orden
const renglon = (s) => String(s).replace(/\s+/g, ' ').trim();

/** `null` si el guion sigue; si no, `{ line, code }` con code 2 (frena) o 3 (quien llama lo deja pasar). */
function check(script, { env = process.env } = {}) {
  if (!fs.existsSync(PLATFORM)) return null;
  let r;
  try { r = require(PLATFORM).choose('queue.read', { env }); } catch (e) {
    return { line: renglon(`no_medido: ${script}: no pude preguntar la plataforma de la organización (${(e && (e.code || e.message)) || e})`), code: 2 };
  }
  if (r && r.ok === false && r.sinEleccion) return null;
  if (!r || r.ok !== true || !r.value) {
    return { line: renglon(`no_medido: ${script}: no sé la plataforma de la organización: ${(r && r.detail) || 'la capa no contestó'}`), code: 2 };
  }
  if (r.value.connector === 'azure-devops') return null;
  const line = renglon(`no_soportado: ${script}: sólo existe en Azure DevOps y la cola de esta organización es ${r.value.connector} (${r.value.origin})`);
  return { line, code: env.TYCON_ALLOW_UNSUPPORTED === '1' ? 3 : 2 };
}

if (require.main === module) {
  const r = check(process.argv[2] || 'este guion');
  if (r) process.stdout.write(`${r.line}\n`);
  process.exitCode = r ? r.code : 0;
}

module.exports = { check };
