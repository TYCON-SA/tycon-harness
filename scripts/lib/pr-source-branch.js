'use strict';
/**
 * pr-source-branch.js — la rama de origen de un pedido, preguntada a su plataforma, para el freno de pedidos.
 *
 * Actualizar un pedido lo nombra por número y no dice su rama: sin ella, el freno no puede saber si
 * `--delete-source-branch true` borraría `dev`. Esto la pregunta con la operación `change-request.read` del conector
 * de la plataforma del repo donde corre el comando (el de su `origin`), con un tope de tiempo. Lo que no pudo leer
 * —sin remoto de una plataforma, sin credencial, otro repo, se acabó el tiempo— es `null` con su motivo: quien llama
 * decide como si no la tuviera.
 *
 *   ramaDeOrigen({ number, cwd, org, platform, timeoutMs, env }) → { rama: string|null, motivo: string|null }
 *
 * `platform`: la plataforma a la que va el comando. Si el `origin` es de otra, no se pregunta: el pedido con ese número
 * sería de otro lado.
 *
 * `org`: la organización que nombra el comando, si nombra una. Si no se ve que es la del remoto, no se pregunta: el
 * mismo número puede ser otro pedido en otra organización.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const TOPE_MS = 8000;
const PLATFORM = path.join(__dirname, 'platform', 'platform.js');

// ¿La organización escrita en el comando es la del remoto? El nombre solo, o una dirección que termina en él. Cualquier
// otra forma no se da por la misma: sin verlo, no se pregunta.
function mismaOrg(texto, org) {
  const t = String(texto || '').trim().replace(/\/+$/, '').toLowerCase();
  const o = String(org || '').toLowerCase();
  return Boolean(o) && (t === o || t.endsWith(`/${o}`));
}

function ramaDeOrigen({ number, cwd, org = null, platform = null, timeoutMs = TOPE_MS, env = process.env } = {}) {
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) return { rama: null, motivo: 'el número del pedido no se puede leer' };
  let repo;
  try {
    const { hostOf } = require(path.join(__dirname, '..', 'tools', 'merge-pr.js'));
    const { identityFromRemote } = require(PLATFORM);
    const donde = hostOf(cwd || process.cwd());
    if (donde.problem) return { rama: null, motivo: donde.problem };
    repo = identityFromRemote(donde);
  } catch (e) {
    return { rama: null, motivo: `no pude leer el remoto: ${(e && e.message) || e}` };
  }
  if (!repo) return { rama: null, motivo: 'el repo de esta carpeta no es de una plataforma conocida' };
  if (platform && repo.platform !== platform) return { rama: null, motivo: `el origin de esta carpeta es de ${repo.platform}, no de la plataforma del comando` };
  if (org !== null && !mismaOrg(org, repo.org)) {
    return { rama: null, motivo: `no veo que la organización del comando (${org}) sea la del repo de esta carpeta (${repo.org})` };
  }
  // stable-data: el tope de la lectura cuenta desde ahora; no se compara con nada guardado
  const args = JSON.stringify({ number: n, deadlineMs: Date.now() + timeoutMs - 500 });
  const r = spawnSync(process.execPath, [PLATFORM, 'change-request.read', '--repo', JSON.stringify(repo), '--args', args],
    { cwd: cwd || process.cwd(), env, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (r.error) return { rama: null, motivo: r.error.code === 'ETIMEDOUT' ? 'se acabó el tiempo' : r.error.message };
  let res = null;
  try { res = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch (_) { /* abajo */ }
  if (!res || typeof res !== 'object') return { rama: null, motivo: 'la plataforma no contestó' };
  if (!res.ok) return { rama: null, motivo: String(res.detail || res.reason || 'la plataforma dijo que no') };
  const rama = res.value && typeof res.value.sourceBranch === 'string' && res.value.sourceBranch.trim() ? res.value.sourceBranch : null;
  return rama ? { rama, motivo: null } : { rama: null, motivo: 'la plataforma no dio la rama' };
}

module.exports = { ramaDeOrigen, mismaOrg, TOPE_MS };
