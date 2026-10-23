#!/usr/bin/env node
/**
 * ollama-tools-probe.js — ¿un modelo de Ollama acepta las herramientas que manda Codex?
 *
 * Codex agrupa en herramientas de tipo `namespace` sus subagentes, sus apps y cada servidor MCP. Algunos modelos de
 * Ollama las rechazan (`400 invalid tool type: namespace`) y la sesión de Codex no arranca. La sonda manda dos pedidos
 * mínimos a `/v1/responses`, el mismo camino que usa Codex: primero con una herramienta `namespace`; si la rechaza, con
 * sólo una función con nombre, que es lo que queda en el modo reducido (sin subagentes, sin apps, sin búsqueda web y sin
 * servidores MCP). Dice en una línea qué pasó y sale siempre 0: es un aviso, no un error.
 *
 * Nunca dice «acepta» sin un 2xx legible: una conexión que falla o una respuesta que no sabe leer se dicen como tales.
 *
 * Uso: node scripts/lib/ollama-tools-probe.js --model <modelo> [--host <url>]
 *      La dirección sale de --host, de OLLAMA_HOST o de http://localhost:11434.
 */
'use strict';

const http = require('http');
const https = require('https');

const TIMEOUT_MS = 60000;

// Las opciones del modo reducido de Codex: sacan todo lo que va como `namespace` y la búsqueda web (sin nombre).
const REDUCED_FLAGS = '-c features.multi_agent=false -c features.apps=false -c web_search="disabled", con una CODEX_HOME sin servidores MCP';

const fnTool = (name) => ({ type: 'function', name, description: 'sonda', strict: false, parameters: { type: 'object', properties: {}, additionalProperties: false } });
const FULL_TOOLS = [{ type: 'namespace', name: 'multi_agent_v1', description: 'sonda', tools: [fnTool('close_agent')] }];
const REDUCED_TOOLS = [fnTool('sonda')];

// Sin puerto, Ollama escucha en el suyo (`OLLAMA_HOST=0.0.0.0` es lo que dice su documentación), no en el 80.
const OLLAMA_PORT = '11434';

function hostOf(argvHost, env = process.env) {
  let h = argvHost || env.OLLAMA_HOST || `http://localhost:${OLLAMA_PORT}`;
  if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  h = h.replace(/\/+$/, '');
  try {
    const u = new URL(h);
    if (!u.port) u.port = OLLAMA_PORT;
    return u.toString().replace(/\/+$/, '');
  } catch { return h; }
}

/** Un pedido a `/v1/responses`: `{ status, body }`, o `{ error }` si no se pudo preguntar. */
function ask(host, model, tools) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(`${host}/v1/responses`); } catch (e) { return resolve({ error: e.message }); }
    const payload = JSON.stringify({ model, stream: false, input: 'Respondé sólo: OK', tools, max_output_tokens: 16 });
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, timeout: TIMEOUT_MS }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('timeout', () => req.destroy(new Error(`sin respuesta en ${TIMEOUT_MS / 1000} s`)));
    req.on('error', (e) => resolve({ error: e.message }));
    req.end(payload);
  });
}

/** `acepta` | `namespace` | `ilegible` | `sin-conexion`, con la primera línea de lo que contestó. */
function classify(r) {
  if (r.error) return { kind: 'sin-conexion', detail: r.error };
  const first = String(r.body || '').split('\n')[0].slice(0, 200);
  let json = null;
  try { json = JSON.parse(r.body); } catch { json = null; }
  if (r.status >= 200 && r.status < 300) return json ? { kind: 'acepta' } : { kind: 'ilegible', detail: first };
  const msg = json && json.error ? String(json.error.message || json.error) : '';
  if (r.status === 400 && /invalid tool type: namespace/.test(msg)) return { kind: 'namespace' };
  return { kind: 'ilegible', detail: first || `HTTP ${r.status}` };
}

async function run({ model, host }) {
  const full = classify(await ask(host, model, FULL_TOOLS));
  if (full.kind === 'acepta') return `✅ ${model} acepta las herramientas de Codex: se puede usar con Codex tal cual.`;
  if (full.kind === 'sin-conexion') return `⚠️ no pude preguntarle a Ollama en ${host} (${full.detail}). Sigue sin saberse si ${model} sirve con Codex.`;
  if (full.kind !== 'namespace') return `⚠️ Ollama contestó algo que no sé leer: ${full.detail}. Sigue sin saberse si ${model} sirve con Codex.`;
  const reduced = classify(await ask(host, model, REDUCED_TOOLS));
  const base = `⚠️ ${model}: este modelo de Ollama no acepta las herramientas de Codex (namespace): usalo con Claude Code`;
  if (reduced.kind === 'acepta') return `${base}, o con Codex en modo reducido: sí (${REDUCED_FLAGS}; sin servidores MCP los revisores que los usan no los tienen).`;
  if (reduced.kind === 'namespace') return `${base}.`;
  return `${base}. El modo reducido no se pudo medir: ${reduced.detail}.`;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') a.model = argv[++i];
    else if (argv[i] === '--host') a.host = argv[++i];
  }
  return a;
}

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.model) {
    process.stdout.write('uso: node scripts/lib/ollama-tools-probe.js --model <modelo> [--host <url>]\n');
    process.exit(0);
  }
  run({ model: a.model, host: hostOf(a.host) })
    .then((line) => { process.stdout.write(line + '\n'); process.exit(0); })
    .catch((e) => { process.stdout.write(`⚠️ la sonda falló: ${e.message}. Sigue sin saberse si ${a.model} sirve con Codex.\n`); process.exit(0); });
}

module.exports = { run, classify, hostOf, FULL_TOOLS, REDUCED_TOOLS };
