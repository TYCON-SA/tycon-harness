#!/usr/bin/env node
/**
 * ollama-tools-probe.test.js — antes de perder una sesión, la sonda dice si un modelo de Ollama acepta las herramientas
 * que manda Codex.
 *
 * El caso: minimax-m3.1-flash con Codex no arranca (`400 invalid tool type: namespace`). Codex agrupa en herramientas
 * `namespace` sus subagentes, sus apps y cada servidor MCP. Sin esos tres y sin la búsqueda web, el mismo modelo contesta:
 * la sonda prueba la forma completa y, si la rechaza, la reducida.
 *
 * Ollama de mentira: un servidor HTTP local que contesta lo que pide cada caso.
 *
 * 🔴 Mutaciones que los ponen en rojo: decir «acepta» ante un 400 (T12), ante una conexión cerrada (T14) o ante una
 * respuesta que no se sabe leer (T17); salir distinto de 0 (es un aviso, no un error).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PROBE = path.join(ROOT, 'scripts', 'lib', 'ollama-tools-probe.js');

/** Levanta un Ollama de mentira; `answer(body)` devuelve [status, cuerpo]. Devuelve la URL y los pedidos que recibió. */
function fakeOllama(answer) {
  return new Promise((resolve) => {
    const pedidos = [];
    const srv = http.createServer((q, r) => {
      let b = '';
      q.on('data', (d) => { b += d; });
      q.on('end', () => {
        let body = null; try { body = JSON.parse(b); } catch { body = null; }
        pedidos.push({ url: q.url, body });
        const [st, txt] = answer(body);
        r.writeHead(st, { 'content-type': 'application/json' });
        r.end(txt);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, pedidos, close: () => srv.close() }));
  });
}

function probe(host, model = 'minimax-m3.1-flash:cloud') {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [PROBE, '--model', model, '--host', host], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('close', (code) => resolve({ code, out, err }));
  });
}

const tieneNamespace = (body) => !!(body && Array.isArray(body.tools) && body.tools.some((t) => t.type === 'namespace'));
const ns400 = JSON.stringify({ error: { message: '400 Bad Request: invalid params, invalid tool type: namespace (ref: x)' } });
const ok200 = JSON.stringify({ id: 'resp_1', object: 'response', status: 'completed', output: [] });

test('Probe_NamespaceRejected_SaysUseClaudeCode @story-8.97 @ac-8', async () => {
  // rechaza las dos formas
  const s = await fakeOllama(() => [400, ns400]);
  const r = await probe(s.url);
  s.close();
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /minimax-m3\.1-flash:cloud/);
  assert.match(r.out, /no acepta las herramientas de Codex \(namespace\)/);
  assert.match(r.out, /usalo con Claude Code/);
  assert.doesNotMatch(r.out, /modo reducido: sí/);
  assert.ok(tieneNamespace(s.pedidos[0].body), 'el primer pedido no llevaba una herramienta namespace');

  // rechaza la completa y acepta la reducida: lo dice, con cómo
  const s2 = await fakeOllama((b) => (tieneNamespace(b) ? [400, ns400] : [200, ok200]));
  const r2 = await probe(s2.url);
  s2.close();
  assert.strictEqual(r2.code, 0);
  assert.match(r2.out, /usalo con Claude Code/);
  assert.match(r2.out, /modo reducido/);
  assert.match(r2.out, /features\.multi_agent=false/);
  assert.ok(s2.pedidos.length === 2 && !tieneNamespace(s2.pedidos[1].body), 'la segunda prueba tenía que ir sin namespace');
});

test('Probe_Accepted_SaysSo @story-8.97 @ac-8', async () => {
  const s = await fakeOllama(() => [200, ok200]);
  const r = await probe(s.url, 'kimi-k2.7-code:cloud');
  s.close();
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /kimi-k2\.7-code:cloud acepta las herramientas de Codex/);
});

test('Probe_NoOllama_NeverSaysAccepted @story-8.97 @ac-12', async () => {
  // una dirección sin puerto es el puerto de Ollama, no el 80 (OLLAMA_HOST=0.0.0.0 es lo que dice su documentación)
  const { hostOf } = require(PROBE);
  assert.strictEqual(hostOf(undefined, { OLLAMA_HOST: '0.0.0.0' }), 'http://0.0.0.0:11434');
  assert.strictEqual(hostOf('http://ollama.local', {}), 'http://ollama.local:11434');
  assert.strictEqual(hostOf('127.0.0.1:9999', {}), 'http://127.0.0.1:9999');

  const s = await fakeOllama(() => [200, ok200]);
  const url = s.url;
  await new Promise((res) => { s.close(); setTimeout(res, 50); });
  const r = await probe(url);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /no pude preguntarle a Ollama/);
  assert.ok(r.out.includes(url), 'no dice la dirección que probó');
  assert.doesNotMatch(r.out, / acepta las herramientas/);
});

test('Probe_UnexpectedAnswer_NeverSaysAccepted @story-8.97 @ac-12', async () => {
  for (const [st, txt] of [[400, JSON.stringify({ error: { message: 'model not found' } })], [500, 'Internal error\nmás'], [200, 'esto no es json']]) {
    const s = await fakeOllama(() => [st, txt]);
    const r = await probe(s.url);
    s.close();
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /Ollama contestó algo que no sé leer: /, `${st}: ${r.out}`);
    assert.doesNotMatch(r.out, / acepta las herramientas/);
  }
});

test('Guides_DeclareTheMeasuredCodexVersion @story-8.97 @ac-9', () => {
  for (const g of ['guides/integrations/ollama.md', 'guides/integrations/ollama.en.md', 'guides/maintaining/codex-divergence-inventory.md']) {
    const t = fs.readFileSync(path.join(ROOT, g), 'utf8');
    assert.match(t, /codex-cli 0\.162\.1/, `${g}: no nombra la versión de Codex medida`);
    assert.match(t, /2026-10-23/, `${g}: no nombra la fecha de la medición`);
  }
  const inv = fs.readFileSync(path.join(ROOT, 'guides/maintaining/codex-divergence-inventory.md'), 'utf8');
  assert.match(inv, /namespace[^\n]*③|③[^\n]*namespace/, 'el inventario no declara la asimetría de namespace');
  for (const g of ['guides/integrations/ollama.md', 'guides/integrations/ollama.en.md']) {
    assert.match(fs.readFileSync(path.join(ROOT, g), 'utf8'), /ollama-tools-probe\.js/, `${g}: no nombra la sonda`);
  }
});
