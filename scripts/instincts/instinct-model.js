#!/usr/bin/env node
'use strict';
/**
 * instinct-model.js — la llamada al modelo de la noche que propone aprendizajes.
 *
 * Qué modelo y qué proveedor lo dice `resolveNightly` de scripts/lib/nightly-model.js (la organización lo elige en el
 * sitio); acá sólo se lo llama. Dos proveedores:
 *   · `ollama`: una petición HTTPS a la API de Ollama con la llave en `Authorization`. El nombre de la tabla puede traer
 *     el sufijo `-cloud` (el que usa el servicio local para un modelo de la nube); la API directa lo pide sin él.
 *   · `anthropic`: la CLI `claude` con el alias de la tabla (`haiku`), que la CLI resuelve; la llave va en
 *     `ANTHROPIC_API_KEY` del ambiente del proceso hijo, nunca en la línea de comandos.
 *
 * 🔴 LA LLAVE NO SALE NUNCA. Ni en la respuesta, ni en el error: un fallo devuelve un código de la lista cerrada
 *    `FALLOS`, nunca el texto del proveedor (puede repetir la llave o una dirección).
 *
 * Nunca tira: `{ ok: true, texto, tokens }` o `{ ok: false, fallo }`. `tokens` es `{ entrada, salida }` si el proveedor
 * los informa, o `null`.
 *
 * Casos: scripts/tests/instinct-model.test.js
 */

const { spawnSync } = require('child_process');

const OLLAMA_URL = 'https://ollama.com/api/chat';
const TIEMPO_MS = 180000;
const FALLOS = Object.freeze(['http_401', 'http_403', 'http_429', 'http_5xx', 'http_otro', 'tiempo', 'red', 'respuesta_ilegible', 'sin_llave', 'cli_fallo', 'proveedor_desconocido']);

/** El nombre del modelo para la API directa de Ollama: sin el sufijo `-cloud` del servicio local. */
function nombreOllama(model) {
  return String(model || '').replace(/-cloud$/, '');
}

function falloHttp(status) {
  if (status === 401) return 'http_401';
  if (status === 403) return 'http_403';
  if (status === 429) return 'http_429';
  if (status >= 500) return 'http_5xx';
  return 'http_otro';
}

async function llamarOllama({ model, llave, prompt, fetchImpl, timeoutMs }) {
  const ctl = new AbortController();
  const reloj = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llave}` },
      body: JSON.stringify({ model: nombreOllama(model), stream: false, options: { temperature: 0.2 }, messages: [{ role: 'user', content: prompt }] }),
      signal: ctl.signal,
    });
  } catch (e) {
    return { ok: false, fallo: e && e.name === 'AbortError' ? 'tiempo' : 'red' };
  } finally {
    clearTimeout(reloj);
  }
  if (!res || !res.ok) return { ok: false, fallo: falloHttp(res ? res.status : 0) };
  let cuerpo;
  try { cuerpo = JSON.parse(await res.text()); } catch (_) { return { ok: false, fallo: 'respuesta_ilegible' }; }
  const texto = cuerpo && cuerpo.message && typeof cuerpo.message.content === 'string' ? cuerpo.message.content.trim() : null;
  if (texto === null) return { ok: false, fallo: 'respuesta_ilegible' };
  const n = (x) => (Number.isFinite(x) ? x : null);
  const tokens = n(cuerpo.prompt_eval_count) !== null || n(cuerpo.eval_count) !== null ? { entrada: n(cuerpo.prompt_eval_count), salida: n(cuerpo.eval_count) } : null;
  return { ok: true, texto, tokens };
}

function llamarAnthropic({ model, llave, prompt, env, timeoutMs }) {
  // proponer y revisar no usa herramientas ni el contexto del arnés: --safe-mode no carga CLAUDE.md, skills, plugins,
  // ganchos ni MCP, y TYCON_EVAL_SANDBOX calla los avisos de arranque del arnés
  // al hijo le llega sólo su llave: la del otro proveedor de la noche se queda en este proceso
  const { OLLAMA_API_KEY: _otra, ...resto } = env;
  const r = spawnSync('claude', ['--model', model, '--print', '--output-format', 'text', '--safe-mode', '--tools', ''], {
    input: prompt, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs,
    env: { ...resto, ANTHROPIC_API_KEY: llave, TYCON_EVAL_SANDBOX: '1' },
  });
  if (r.error && r.error.code === 'ETIMEDOUT') return { ok: false, fallo: 'tiempo' };
  if (r.error || r.status !== 0) return { ok: false, fallo: 'cli_fallo' };
  return { ok: true, texto: String(r.stdout || '').trim(), tokens: null };
}

/**
 * Llama al modelo que resolvió la noche. opts: nightly (el resultado de `resolveNightly`, con `ok: true`) · prompt ·
 * env (de donde se lee la llave: la variable que nombra `secret.env`) · fetchImpl · timeoutMs.
 */
async function llamar({ nightly, prompt, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = TIEMPO_MS } = {}) {
  try {
    const nombre = nightly && nightly.secret && nightly.secret.env;
    const llave = nombre ? String(env[nombre] || '').trim() : '';
    if (!llave || /^\$\([^)]*\)$/.test(llave)) return { ok: false, fallo: 'sin_llave' };
    if (nightly.provider === 'ollama') return await llamarOllama({ model: nightly.model, llave, prompt, fetchImpl, timeoutMs });
    if (nightly.provider === 'anthropic') return llamarAnthropic({ model: nightly.model, llave, prompt, env, timeoutMs });
    return { ok: false, fallo: 'proveedor_desconocido' };
  } catch (_) {
    return { ok: false, fallo: 'red' };
  }
}

module.exports = { llamar, nombreOllama, FALLOS };
