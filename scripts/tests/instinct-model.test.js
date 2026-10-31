'use strict';

/**
 * instinct-model.test.js — la llamada al modelo de la noche (scripts/instincts/instinct-model.js).
 *
 * Lo que no se puede perder:
 *   · Que la llave no salga nunca: ni en la respuesta, ni en el error, ni en lo que la noche escribe.
 *   · Que un fallo del proveedor sea `fallo` con un código de una lista cerrada, nunca el texto del error.
 *   · Que el modelo vaya como lo dio la tabla de modelos de la noche (sin el sufijo `-cloud` en la API directa de Ollama).
 *
 * Sin red: `fetch` de prueba para Ollama y un `claude` de prueba en el PATH para Anthropic.
 *
 * Uso: node --test scripts/tests/instinct-model.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const M = require(path.join(RAIZ, 'scripts', 'instincts', 'instinct-model.js'));

const LLAVE = 's3cr3t';
const OTRA = ['la', 'del', 'otro', 'proveedor'].join('-');
const ollama = { ok: true, provider: 'ollama', model: 'gemma4:31b-cloud', secret: { env: 'OLLAMA_API_KEY', present: true } };

function respuesta(status, cuerpo) {
  return { ok: status >= 200 && status < 300, status, text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)) };
}

test('T45 Model_Ollama_HttpCall_KeyNeverLogged', async () => {
  const pedidos = [];
  const bueno = async (url, op) => { pedidos.push({ url, op }); return respuesta(200, { message: { content: 'texto del modelo' }, prompt_eval_count: 12, eval_count: 3 }); };
  const r = await M.llamar({ nightly: ollama, prompt: 'hola', env: { OLLAMA_API_KEY: LLAVE }, fetchImpl: bueno });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.texto, 'texto del modelo');
  assert.deepStrictEqual(r.tokens, { entrada: 12, salida: 3 });
  assert.match(pedidos[0].url, /^https:\/\//);
  assert.strictEqual(pedidos[0].op.headers.Authorization, `Bearer ${LLAVE}`);
  assert.strictEqual(JSON.parse(pedidos[0].op.body).model, 'gemma4:31b', 'el sufijo -cloud sale en la API directa (P3)');
  assert.strictEqual(M.nombreOllama('llama3:8b'), 'llama3:8b');

  const casos = [[401, 'http_401'], [429, 'http_429'], [500, 'http_5xx']];
  for (const [status, fallo] of casos) {
    const x = await M.llamar({ nightly: ollama, prompt: 'p', env: { OLLAMA_API_KEY: LLAVE }, fetchImpl: async () => respuesta(status, `error con la llave ${LLAVE}`) });
    assert.deepStrictEqual({ ok: x.ok, fallo: x.fallo }, { ok: false, fallo }, String(status));
    assert.ok(!JSON.stringify(x).includes(LLAVE));
  }
  const noJson = await M.llamar({ nightly: ollama, prompt: 'p', env: { OLLAMA_API_KEY: LLAVE }, fetchImpl: async () => respuesta(200, '<html>no es json</html>') });
  assert.strictEqual(noJson.fallo, 'respuesta_ilegible');
  const colgado = (url, op) => new Promise((_, rej) => { op.signal.addEventListener('abort', () => rej(Object.assign(new Error(`abort ${LLAVE}`), { name: 'AbortError' }))); });
  const t = await M.llamar({ nightly: ollama, prompt: 'p', env: { OLLAMA_API_KEY: LLAVE }, fetchImpl: colgado, timeoutMs: 30 });
  assert.strictEqual(t.fallo, 'tiempo');
  assert.ok(!JSON.stringify(t).includes(LLAVE));
  const red = await M.llamar({ nightly: ollama, prompt: 'p', env: { OLLAMA_API_KEY: LLAVE }, fetchImpl: async () => { throw new Error(`ECONNRESET ${LLAVE}`); } });
  assert.strictEqual(red.fallo, 'red');
  assert.ok(M.FALLOS.includes('red') && M.FALLOS.includes('tiempo'));
});

test('T46 Model_Anthropic_CliCall_AliasFromTable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-claude-'));
  const anota = path.join(dir, 'anota.json');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
let input = ''; process.stdin.on('data', (c) => { input += c; }); process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(anota)}, JSON.stringify({ args: process.argv.slice(2), llave: process.env.ANTHROPIC_API_KEY, otra: process.env.OLLAMA_API_KEY || null, input }));
  if (input.includes('FALLA')) process.exit(3);
  process.stdout.write('respuesta de haiku\\n');
});
`);
  fs.chmodSync(bin, 0o755);
  const nightly = { ok: true, provider: 'anthropic', model: 'haiku', secret: { env: 'ANTHROPIC_API_KEY', present: true } };
  const env = { PATH: `${dir}${path.delimiter}${process.env.PATH}`, ANTHROPIC_API_KEY: LLAVE, OLLAMA_API_KEY: OTRA };
  const r = await M.llamar({ nightly, prompt: 'proponé', env });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.texto, 'respuesta de haiku');
  const a = JSON.parse(fs.readFileSync(anota, 'utf8'));
  assert.deepStrictEqual(a.args.slice(0, 2), ['--model', 'haiku']);
  assert.ok(a.args.includes('--safe-mode'));
  const i = a.args.indexOf('--tools');
  assert.ok(i >= 0 && a.args[i + 1] === '');
  assert.strictEqual(a.llave, LLAVE, 'la llave en el ambiente del hijo');
  assert.strictEqual(a.otra, null, 'la llave del otro proveedor no llega al hijo');
  assert.ok(!a.args.join(' ').includes(LLAVE), 'nunca en la línea de comandos');
  assert.strictEqual(a.input, 'proponé');
  const f = await M.llamar({ nightly, prompt: 'FALLA', env });
  assert.strictEqual(f.ok, false);
  assert.strictEqual(f.fallo, 'cli_fallo');
  const sinCli = await M.llamar({ nightly, prompt: 'p', env: { PATH: dir.replace(/$/, '-no'), ANTHROPIC_API_KEY: LLAVE } });
  assert.strictEqual(sinCli.fallo, 'cli_fallo');
});
