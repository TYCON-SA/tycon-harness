'use strict';
// stable-data: las conversaciones, las sesiones de Codex y la tabla de precios se arman acá, con fechas fijas; el reloj
// del costo se inyecta. Nada lee ~/.claude ni ~/.codex de verdad: cada caso tiene su carpeta personal de mentira.
/*
 * tokens-digest-other-tools.test.js — el consumo de una corrida con otras herramientas y otros modelos: la carpeta de
 * Claude Code con CLAUDE_CONFIG_DIR, las sesiones de Codex, el proveedor y el costo con la tabla de precios declarada.
 *
 * Cada caso dice la mutación que lo pone en rojo.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DIGEST = path.join(ROOT, 'scripts', 'metrics', 'tokens-digest.js');
const TD = require(DIGEST);
const PRECIOS_REPO = path.join(ROOT, 'scripts', 'metrics', 'model-prices.json');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SID = 'aaaaaaaa-1111-4aaa-8bbb-000000000001';

// ── Las piezas ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Una respuesta de Claude Code: una línea `assistant` con su `usage`. */
function respuesta(id, model, usage, timestamp) {
  const o = { type: 'assistant', message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage } };
  if (timestamp !== undefined) o.timestamp = timestamp;
  return o;
}
const uso = (inp, out, cacheNew = 0, cacheRead = 0) => ({ input_tokens: inp, output_tokens: out, cache_creation_input_tokens: cacheNew, cache_read_input_tokens: cacheRead });

function escribirJsonl(ruta, lineas) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, `${lineas.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** Una carpeta personal de mentira, con la conversación de Claude Code en `<base>/projects/<proyecto>/<sid>.jsonl`. */
function conversacionClaude(base, lineas, sid = SID) {
  escribirJsonl(path.join(base, 'projects', '-opt-acme-repo', `${sid}.jsonl`), lineas);
}

/** Una sesión de Codex como la deja Codex: `sessions/AAAA/MM/DD/rollout-<fecha>-<id>.jsonl`. */
function sesionCodex(codexDir, { sid = SID, model = 'gpt-5.6-luna', totales = [], sinTokens = false } = {}) {
  const lineas = [
    { timestamp: '2026-10-25T10:00:00.000Z', type: 'session_meta', payload: { id: sid, cwd: '/opt/acme/repo', instructions: 'NO LEER' } },
    { timestamp: '2026-10-25T10:00:01.000Z', type: 'turn_context', payload: { model, cwd: '/opt/acme/repo' } },
    { timestamp: '2026-10-25T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'texto que no se lee' }] } },
  ];
  if (!sinTokens) {
    lineas.push({ timestamp: '2026-10-25T10:00:03.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } });
    let previo = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
    totales.forEach((t, i) => {
      const total = { ...t, total_tokens: t.input_tokens + t.output_tokens };
      const last = Object.fromEntries(Object.keys(total).map((k) => [k, total[k] - previo[k]]));
      lineas.push({ timestamp: `2026-10-25T10:0${i + 1}:00.000Z`, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 200000 } } });
      previo = total;
    });
  }
  escribirJsonl(path.join(codexDir, 'sessions', '2026', '10', '25', `rollout-2026-10-25T10-00-00-${sid}.jsonl`), lineas);
}

/** El volcado que deja `marker.js clear`, con lo que el medidor lee. */
function volcado(dir, { sid = SID } = {}) {
  const ruta = path.join(dir, 'timing-history', 'corrida.json');
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, JSON.stringify({ marker: { storyId: '9.9', sessionId: sid, stepTimings: { start: { completedAt: '2026-10-25T23:59:00.000Z' } } }, gates: [] }));
  return ruta;
}
const leer = (ruta) => JSON.parse(fs.readFileSync(ruta, 'utf8'));

/** Una tabla de precios de prueba: un modelo con precio único, uno con franjas y el de nombre exacto. */
function tabla(dir, extra = {}) {
  const ruta = path.join(dir, 'precios.json');
  const unico = { in: 1, out: 2, cache_read: 0.1, cache_new: null };
  fs.writeFileSync(ruta, JSON.stringify({
    models: {
      'gemma4:31b-cloud': { provider: 'ollama', currency: 'USD', source: 'https://example.com/pricing', checked: '2026-10-25', review_before: '2026-11-25', per_million: unico },
      'deepseek-v4-flash:cloud': {
        provider: 'ollama', currency: 'USD', source: 'https://example.com/pricing', checked: '2026-10-25', review_before: '2026-11-25',
        bands: {
          timezone: 'UTC',
          peak: { days: [1, 2, 3, 4, 5], from: '12:00', to: '18:00', per_million: { in: 10, out: 20, cache_read: 1, cache_new: null } },
          off_peak: { per_million: { in: 5, out: 10, cache_read: 0.5, cache_new: null } },
        },
      },
      'gpt-5.6-luna': { provider: 'openai', currency: 'USD', source: 'https://example.com/openai', checked: '2026-10-25', review_before: '2026-11-25', per_million: { in: 2, out: 8, cache_read: 0.2, cache_new: null } },
      ...extra,
    },
  }));
  return ruta;
}

/** Corre el medidor por la línea de comando, con una carpeta personal de mentira y el ambiente que se le pase. */
function correr(home, dump, env = {}) {
  const r = spawnSync(process.execPath, [DIGEST, '--run', dump, '--json'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TYCON_NO_REVIEWER_COST: '1', ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const AHORA = '2026-10-26T12:00:00.000Z';

// ── Claude Code con otra carpeta de configuración ──────────────────────────────────────────────────────────────

// Mutación: buscar sólo en ~/.claude/projects (sin mirar CLAUDE_CONFIG_DIR) → la corrida sale `borrada`.
test('T1 Digest_ClaudeConfigDir_Found', () => {
  const home = tmp('t1-home-');
  const config = tmp('t1-config-');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  conversacionClaude(config, [respuesta('m1', 'gemma4:31b-cloud', uso(100, 20), '2026-10-25T10:00:00.000Z')]);
  const dump = volcado(home);
  const r = correr(home, dump, { CLAUDE_CONFIG_DIR: config });
  assert.strictEqual(r.status, 0, r.err);
  const c = leer(dump).consumo;
  assert.strictEqual(c.estado, 'medido', JSON.stringify(c));
  assert.strictEqual(c.tokens.in, 100);
  assert.strictEqual(c.tokens.out, 20);
});

// ── Codex ───────────────────────────────────────────────────────────────────────────────────────────────────────

// Mutación: tomar el PRIMER total, o sumar los totales, o no restar la caché de la entrada → otros números.
test('T2 Digest_Codex_ReadsLastTotal', () => {
  const home = tmp('t2-home-');
  sesionCodex(path.join(home, '.codex'), {
    totales: [
      { input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10 },
      { input_tokens: 3000, cached_input_tokens: 1500, cache_write_input_tokens: 100, output_tokens: 120, reasoning_output_tokens: 30 },
      { input_tokens: 6000, cached_input_tokens: 4000, cache_write_input_tokens: 200, output_tokens: 300, reasoning_output_tokens: 70 },
    ],
  });
  const dump = volcado(home);
  const r = correr(home, dump, { CODEX_SESSION_ID: SID });
  assert.strictEqual(r.status, 0, r.err);
  const c = leer(dump).consumo;
  assert.strictEqual(c.estado, 'medido', JSON.stringify(c));
  assert.strictEqual(c.herramienta, 'codex');
  assert.deepStrictEqual(c.tokens, { in: 1800, out: 300, cache_new: 200, cache_read: 4000, out_reasoning: 70 });
  assert.strictEqual(c.respuestas, 3);
  assert.ok(c.por_paso && typeof c.por_paso === 'object', 'el tablero lee por_paso en todo bloque medido');
});

// Mutación: dejar el final de siempre (`borrada`) para una sesión de Codex sin archivo.
test('T3 Digest_Codex_Missing_NotMeasured', () => {
  const home = tmp('t3-home-');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
  const dump = volcado(home);
  const r = correr(home, dump, { CODEX_SESSION_ID: SID });
  assert.strictEqual(r.status, 0, r.err);
  const c = leer(dump).consumo;
  assert.strictEqual(c.estado, 'no_medido', JSON.stringify(c));
  assert.notStrictEqual(c.estado, 'borrada');
  assert.ok(c.motivo.includes(path.join(home, '.codex', 'sessions')), c.motivo);
  assert.ok(!('tokens' in c), 'sin la clave tokens: un cero se lee como «no consumió»');
  // y el barrido la reintenta: no_medido no es definitivo. Con el bloque de revisores puesto, para que lo único que
  // decida sea el estado del consumo; el contraste con `borrada` (definitivo) prueba que la aserción mide algo.
  const conRevisores = { ...leer(dump), revisores: { estado: 'no_medido' } };
  fs.writeFileSync(dump, JSON.stringify(conRevisores));
  assert.strictEqual(TD.estaPendiente(dump, path.join(home, '.claude', 'projects')), true);
  fs.writeFileSync(dump, JSON.stringify({ ...conRevisores, consumo: { ...conRevisores.consumo, estado: 'borrada' } }));
  assert.strictEqual(TD.estaPendiente(dump, path.join(home, '.claude', 'projects')), false);
});

// ── El proveedor ────────────────────────────────────────────────────────────────────────────────────────────────

// Mutación: no anotar el proveedor en el bloque.
test('T4 Digest_Provider_Recorded', () => {
  const home = tmp('t4-home-');
  conversacionClaude(path.join(home, '.claude'), [respuesta('m1', 'gemma4:31b-cloud', uso(10, 5), '2026-10-25T10:00:00.000Z')]);
  const dump = volcado(home);
  const r = correr(home, dump, { TYCON_MODEL_PROVIDER: 'ollama' });
  assert.strictEqual(r.status, 0, r.err);
  const c = leer(dump).consumo;
  assert.strictEqual(c.estado, 'medido');
  assert.strictEqual(c.proveedor.provider, 'ollama');
  assert.strictEqual(c.proveedor.origin, 'env');
});

// ── El costo ────────────────────────────────────────────────────────────────────────────────────────────────────

function medirClaude(lineas, { proveedor = { provider: 'ollama', origin: 'env' }, ahora = AHORA, extra } = {}) {
  const home = tmp('cost-home-');
  conversacionClaude(path.join(home, '.claude'), lineas);
  const dump = volcado(home);
  const res = TD.rescatarCorrida(dump, { projectsDir: path.join(home, '.claude', 'projects'), codexDir: path.join(home, '.codex', 'sessions'), home, preciosPath: tabla(home, extra), ahora, proveedor, env: {} });
  assert.ok(!res.error, res.error);
  return leer(dump).consumo;
}

// Mutación: no multiplicar por el precio, olvidar la caché leída, o no anotar moneda, fuente o fecha.
test('T5 Digest_Price_CostWithSource', () => {
  const c = medirClaude([respuesta('m1', 'gemma4:31b-cloud', uso(1000000, 500000, 0, 2000000), '2026-10-25T10:00:00.000Z')]);
  assert.strictEqual(c.costo.estado, 'medido', JSON.stringify(c.costo));
  // 1 M de entrada a 1 + 0,5 M de salida a 2 + 2 M de caché leída a 0,1 = 2,2
  assert.strictEqual(c.costo.total, 2.2);
  assert.strictEqual(c.costo.moneda, 'USD');
  assert.strictEqual(c.costo.fuentes['gemma4:31b-cloud'].fuente, 'https://example.com/pricing');
  assert.strictEqual(c.costo.fuentes['gemma4:31b-cloud'].revisado, '2026-10-25');
});

// Mutación: tomar la franja de la primera respuesta (o de la hora de medir) para todas.
test('T6 Digest_Price_CrossesBand', () => {
  // las dos respuestas caen un lunes: 11:59 UTC es horario bajo, 12:01 es pico.
  const c = medirClaude([
    respuesta('m1', 'deepseek-v4-flash:cloud', uso(1000000, 0), '2026-10-26T11:59:00.000Z'),
    respuesta('m2', 'deepseek-v4-flash:cloud', uso(1000000, 0), '2026-10-26T12:01:00.000Z'),
  ]);
  assert.strictEqual(c.costo.estado, 'medido', JSON.stringify(c.costo));
  assert.strictEqual(c.costo.total, 15); // 5 en horario bajo + 10 en pico
});

// Mutación: anotar un costo de cero (o ninguno, sin motivo) para un modelo que no está en la tabla.
test('T7 Digest_Price_Missing_NotMeasured', () => {
  const c = medirClaude([respuesta('m1', 'kimi-k9:cloud', uso(100, 10), '2026-10-25T10:00:00.000Z')]);
  assert.strictEqual(c.costo.estado, 'no_medido');
  assert.ok(/kimi-k9:cloud/.test(c.costo.motivo), c.costo.motivo);
  assert.ok(!('total' in c.costo));
  assert.strictEqual(c.tokens.in, 100);
});

// Mutación: no mirar review_before.
test('T8 Digest_Price_Expired_NotMeasured', () => {
  const c = medirClaude([respuesta('m1', 'gemma4:31b-cloud', uso(100, 10), '2026-10-25T10:00:00.000Z')], { ahora: '2026-12-01T00:00:00.000Z' });
  assert.strictEqual(c.costo.estado, 'no_medido');
  assert.ok(/review_before|vencid/.test(c.costo.motivo), c.costo.motivo);
  assert.strictEqual(c.tokens.in, 100);
});

// Mutación: anotar `costo: no_medido` también en las corridas de Claude, o cambiar el resto del bloque.
test('T9 Digest_Claude_NoCost', () => {
  const lineas = [respuesta('m1', 'claude-opus-5-5', uso(100, 10, 5, 50), '2026-10-25T10:00:00.000Z')];
  const c = medirClaude(lineas, { proveedor: { provider: 'anthropic', origin: 'derivado' } });
  assert.ok(!('costo' in c), JSON.stringify(c));
  assert.strictEqual(c.proveedor.provider, 'anthropic');
  const hoy = TD.consumo(lineas, TD.cortesDePaso({ start: { completedAt: '2026-10-25T23:59:00.000Z' } }));
  // hilo_hasta lo fija quien escribe la constancia, no consumo(): no es parte de lo que se compara
  for (const k of Object.keys(hoy).filter((k) => k !== 'hilo_hasta')) assert.deepStrictEqual(c[k], hoy[k], `el campo ${k} cambió`);
});

// Mutación: una entrada de la tabla sin moneda, fuente, review_before o algún tipo de precio.
test('T10 Prices_File_Shape', () => {
  const t = JSON.parse(fs.readFileSync(PRECIOS_REPO, 'utf8'));
  const modelos = Object.entries(t.models || {});
  assert.ok(modelos.length > 0, 'la tabla nace con los modelos de Ollama del equipo');
  const tipos = ['in', 'out', 'cache_read', 'cache_new'];
  const precioCompleto = (pm, donde) => {
    for (const k of tipos) {
      assert.ok(k in pm, `${donde}: falta el precio de ${k}`);
      assert.ok(pm[k] === null || (typeof pm[k] === 'number' && pm[k] >= 0), `${donde}: ${k} no es un número`);
    }
  };
  for (const [nombre, m] of modelos) {
    assert.ok(m.currency, `${nombre}: sin moneda`);
    assert.ok(/^https?:\/\//.test(m.source || ''), `${nombre}: sin fuente`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(m.review_before || ''), `${nombre}: sin review_before`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(m.checked || ''), `${nombre}: sin fecha de lectura`);
    assert.ok(!/claude/i.test(nombre), 'la tabla no trae modelos de Claude');
    if (m.bands) {
      assert.ok(m.bands.timezone, `${nombre}: franjas sin zona horaria`);
      precioCompleto(m.bands.peak.per_million, `${nombre} pico`);
      precioCompleto(m.bands.off_peak.per_million, `${nombre} horario bajo`);
      assert.ok(Array.isArray(m.bands.peak.days) && m.bands.peak.from && m.bands.peak.to, `${nombre}: el pico sin días u horas`);
    } else {
      precioCompleto(m.per_million || {}, nombre);
    }
  }
});

// Mutación: borrar la entrada de sources.json, o no nombrar el archivo de precios y el campo en las guías.
test('T11 Docs_CostAndCursor_Said', () => {
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'sources.json'), 'utf8'));
  const e = (src.not_measurable_today || []).find((x) => x.what === 'Costo en plata por story');
  assert.ok(e, 'la entrada «Costo en plata por story» sigue');
  assert.ok(e.reason.includes('model-prices.json'), e.reason);
  assert.ok(/Claude/.test(e.reason), 'dice que Claude sigue sin medirse');
  const ollama = fs.readFileSync(path.join(ROOT, 'guides', 'integrations', 'ollama.md'), 'utf8');
  assert.ok(ollama.includes('model-prices.json'), 'ollama.md nombra el archivo de precios');
  assert.ok(ollama.includes('consumo.costo'), 'ollama.md nombra el campo del costo');
  const cursor = fs.readFileSync(path.join(ROOT, 'guides', 'integrations', 'cursor.md'), 'utf8');
  assert.ok(/no (guarda|deja) su consumo en la máquina/.test(cursor), 'cursor.md dice que no hay consumo en la máquina');
});

// Mutación: asignarle una franja a la respuesta sin hora (o descartarla callada).
test('T12 Digest_Price_NoTimestamp_NotMeasured', () => {
  const c = medirClaude([
    respuesta('m1', 'deepseek-v4-flash:cloud', uso(100, 10), '2026-10-26T10:00:00.000Z'),
    respuesta('m2', 'deepseek-v4-flash:cloud', uso(100, 10)),
  ]);
  assert.strictEqual(c.costo.estado, 'no_medido');
  assert.ok(/\b1\b/.test(c.costo.motivo) && /hora/.test(c.costo.motivo), c.costo.motivo);
});

// Mutación: decidir el costo por el proveedor (sólo con `ollama` declarado).
test('T13 Digest_Price_ByModel_NotProvider', () => {
  const c = medirClaude([respuesta('m1', 'gemma4:31b-cloud', uso(1000000, 0), '2026-10-25T10:00:00.000Z')], { proveedor: { provider: 'anthropic', origin: 'derivado' } });
  assert.strictEqual(c.costo.estado, 'medido', JSON.stringify(c.costo));
  assert.strictEqual(c.costo.total, 1);
});

// Mutación: usar `input_tokens` tal cual (con la caché adentro) o sumar el razonamiento a la salida.
test('T14 Digest_Codex_NoDoubleCount', () => {
  const home = tmp('t14-home-');
  const total = { input_tokens: 114466, cached_input_tokens: 75904, cache_write_input_tokens: 1200, output_tokens: 155, reasoning_output_tokens: 19 };
  sesionCodex(path.join(home, '.codex'), { totales: [total] });
  const dump = volcado(home);
  const r = correr(home, dump, { CODEX_SESSION_ID: SID });
  assert.strictEqual(r.status, 0, r.err);
  const t = leer(dump).consumo.tokens;
  assert.strictEqual(t.in + t.cache_read + t.cache_new + t.out, total.input_tokens + total.output_tokens);
  assert.strictEqual(t.out_reasoning, 19);
  assert.strictEqual(t.out, 155);
});

// Mutación: escribir ceros cuando la sesión no tiene ningún token_count.
test('T15 Digest_Codex_NoTokenCount_NotMeasured', () => {
  const home = tmp('t15-home-');
  sesionCodex(path.join(home, '.codex'), { sinTokens: true });
  const dump = volcado(home);
  const r = correr(home, dump, { CODEX_SESSION_ID: SID });
  assert.strictEqual(r.status, 0, r.err);
  const c = leer(dump).consumo;
  assert.strictEqual(c.estado, 'no_medido', JSON.stringify(c));
  assert.ok(/token_count/.test(c.motivo), c.motivo);
  assert.ok(!('tokens' in c) && !('costo' in c) && !('respuestas' in c), 'ningún cero');
});

// Mutación: buscar el modelo por prefijo (o sin el `:cloud`), o comparar review_before con otra fecha que la de medir.
test('T16 Digest_Price_ExactNameAndClock', () => {
  const sinCloud = medirClaude([respuesta('m1', 'deepseek-v4-flash', uso(100, 10), '2026-10-25T10:00:00.000Z')]);
  assert.strictEqual(sinCloud.costo.estado, 'no_medido');
  const linea = [respuesta('m1', 'deepseek-v4-flash:cloud', uso(1000000, 0), '2026-10-25T10:00:00.000Z')]; // sábado: horario bajo
  const antes = medirClaude(linea, { ahora: '2026-11-24T12:00:00.000Z' });
  assert.strictEqual(antes.costo.estado, 'medido', JSON.stringify(antes.costo));
  assert.strictEqual(antes.costo.total, 5);
  const despues = medirClaude(linea, { ahora: '2026-11-26T12:00:00.000Z' });
  assert.strictEqual(despues.costo.estado, 'no_medido');
});

// ── Lo que no se pudo medir dice por qué ────────────────────────────────────────────────────────────────────────

const CU = require(path.join(ROOT, 'scripts', 'metrics', 'codex-usage.js'));
const precioUnico = { in: 1, out: 2, cache_read: 0.1, cache_new: null };
const entradaDeTabla = (extra) => ({ currency: 'USD', source: 'https://example.com', checked: '2026-10-25', review_before: '2026-11-25', ...extra });
const una = (modelo, t = Date.parse('2026-10-26T10:00:00.000Z')) => [{ modelo, t, in: 1000000, out: 0, cache_new: 0, cache_read: 0 }];

// Mutación: con una hora o una zona horaria ilegible, elegir una franja igual (cobra la barata sin avisar).
test('T17 Digest_Price_BadBands_NotMeasured', () => {
  const franjas = (peak, timezone) => ({ models: { m: entradaDeTabla({ bands: { timezone, peak, off_peak: { per_million: precioUnico } } }) } });
  const pico = { days: [1, 2, 3, 4, 5], from: '12:00', to: '18:00', per_million: { ...precioUnico, in: 9 } };
  // la de control: bien escrita, mide (si no, las de abajo pasarían por otra razón)
  assert.strictEqual(TD.costo(una('m'), franjas(pico, 'UTC'), { ahora: AHORA, proveedor: { provider: 'ollama' } }).estado, 'medido');
  for (const precios of [franjas({ ...pico, from: '12h' }, 'UTC'), franjas({ ...pico, days: undefined }, 'UTC'), franjas(pico, 'Marte/Olimpo'), franjas(pico, undefined), franjas(pico, '')]) {
    const c = TD.costo(una('m'), precios, { ahora: AHORA, proveedor: { provider: 'ollama' } });
    assert.strictEqual(c.estado, 'no_medido', JSON.stringify(c));
    assert.ok(/franjas/.test(c.motivo), c.motivo);
  }
});

// Mutación: contar un total sin entrada o sin salida con ceros.
test('T18 Digest_Codex_IncompleteTotal_NotMeasured', () => {
  const lineas = [
    { type: 'session_meta', payload: { id: SID } },
    { type: 'turn_context', payload: { model: 'gpt-5.5' } },
    { type: 'event_msg', timestamp: '2026-10-25T10:00:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100 } } } },
  ];
  const { bloque } = CU.consumoCodex(lineas, [], SID);
  assert.strictEqual(bloque.estado, 'no_medido', JSON.stringify(bloque));
  assert.ok(/output_tokens/.test(bloque.motivo), bloque.motivo);
  assert.ok(!('tokens' in bloque));
});

// Mutación: sin proveedor conocido, tratar la ejecución como de Claude (sin costo y sin motivo).
test('T19 Digest_Price_UnknownProvider_Said', () => {
  const sinProveedor = { provider: null, origin: 'no_medido', problem: 'no pude cargar el lector de configuración (MODULE_NOT_FOUND)' };
  const otro = TD.costo(una('gpt-5.5'), { models: {} }, { ahora: AHORA, proveedor: sinProveedor });
  assert.strictEqual(otro.estado, 'no_medido', JSON.stringify(otro));
  assert.ok(otro.motivo.includes('proveedor desconocido'), otro.motivo);
  assert.strictEqual(TD.costo(una('claude-opus-5-5'), { models: {} }, { ahora: AHORA, proveedor: sinProveedor }), null);
});

// Mutación: con la tabla ilegible, devolver null (se pierde el costo sin avisar) o un cero.
test('T20 Digest_Price_UnreadableTable_Said', () => {
  const rota = path.join(tmp('t20-'), 'precios.json');
  fs.writeFileSync(rota, '{ no es json');
  const leida = TD.leerPrecios(rota);
  assert.ok(leida.error, 'la tabla rota se dice');
  for (const proveedor of [{ provider: 'anthropic' }, { provider: 'ollama' }]) {
    const c = TD.costo(una('claude-opus-5-5'), leida, { ahora: AHORA, proveedor });
    assert.strictEqual(c.estado, 'no_medido', JSON.stringify(c));
    assert.ok(c.motivo.includes('precios.json'), c.motivo);
  }
});

// Mutación: sumar un total parcial, sumar monedas distintas, o cobrar en cero un tipo de token sin precio publicado.
test('T22 Digest_Price_PartialOrMixed_NotMeasured', () => {
  const precios = { models: {
    a: entradaDeTabla({ per_million: precioUnico }),
    b: entradaDeTabla({ currency: 'EUR', per_million: precioUnico }),
  } };
  const opts = { ahora: AHORA, proveedor: { provider: 'ollama' } };
  const parcial = TD.costo([...una('a'), ...una('sin-precio')], precios, opts);
  assert.strictEqual(parcial.estado, 'no_medido');
  assert.ok(parcial.motivo.includes('sin-precio') && /total/.test(parcial.motivo), parcial.motivo);
  const monedas = TD.costo([...una('a'), ...una('b')], precios, opts);
  assert.strictEqual(monedas.estado, 'no_medido');
  assert.ok(/monedas distintas/.test(monedas.motivo) && monedas.motivo.includes('EUR'), monedas.motivo);
  const conCacheNueva = [{ modelo: 'a', t: Date.parse('2026-10-26T10:00:00.000Z'), in: 10, out: 0, cache_new: 500, cache_read: 0 }];
  const cache = TD.costo(conCacheNueva, precios, opts);
  assert.strictEqual(cache.estado, 'no_medido');
  assert.ok(/cache_new/.test(cache.motivo) && /500/.test(cache.motivo), cache.motivo);
});

// Mutación: aceptar un archivo de otra sesión, inventar el reparto por modelo, o buscar con un id que no sirve.
test('T23 Digest_Codex_IdAndModels_Said', () => {
  const evento = { type: 'event_msg', timestamp: '2026-10-25T10:00:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 }, last_token_usage: { input_tokens: 100, output_tokens: 10 } } } };
  const otro = CU.consumoCodex([{ type: 'session_meta', payload: { id: 'otra-sesion' } }, evento], [], SID);
  assert.strictEqual(otro.bloque.estado, 'no_medido');
  assert.ok(/otro id/.test(otro.bloque.motivo), otro.bloque.motivo);
  const dos = CU.consumoCodex([
    { type: 'turn_context', payload: { model: 'gpt-5.5' } }, evento,
    { type: 'turn_context', payload: { model: 'kimi-k2.7-code:cloud' } }, evento,
  ], [], SID);
  assert.strictEqual(dos.bloque.estado, 'medido');
  assert.ok(!('por_modelo' in dos.bloque) && /2 modelos/.test(dos.bloque.por_modelo_motivo), JSON.stringify(dos.bloque));
  assert.strictEqual(dos.paraCosto, null);
  assert.ok(dos.motivoCosto);
  const sinModelo = CU.consumoCodex([evento], [], SID);
  assert.ok(/no anotó su modelo/.test(sinModelo.bloque.por_modelo_motivo), JSON.stringify(sinModelo.bloque));
  const malo = CU.ubicarSesion('../../etc', tmp('t23-'));
  assert.strictEqual(malo.estado, 'no_medido');
  assert.ok(/no sirve/.test(malo.motivo), malo.motivo);
});

// Mutación: una subcarpeta de sesiones ilegible se ignora y el motivo dice «no encontré».
test('T21 Digest_Codex_UnreadableFolder_Said', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
  const dir = tmp('t21-');
  const cerrada = path.join(dir, '2026');
  fs.mkdirSync(cerrada);
  fs.chmodSync(cerrada, 0o000);
  try {
    const r = CU.ubicarSesion(SID, dir);
    assert.strictEqual(r.estado, 'no_medido');
    assert.ok(/no pude leer/.test(r.motivo), r.motivo);
  } finally {
    fs.chmodSync(cerrada, 0o755);
  }
});

// ── Lo que el pase adversarial encontró ─────────────────────────────────────────────────────────────────────────

// Mutación: contar el evento que Codex repite (mismo total, ~0,3 s después) como otra respuesta.
test('T24 Digest_Codex_RepeatedEvent_CountedOnce', () => {
  const ev = (ts, total, last) => ({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
  const t1 = { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 };
  const t2 = { input_tokens: 2500, cached_input_tokens: 1400, output_tokens: 120 };
  const l2 = { input_tokens: 1500, cached_input_tokens: 1000, output_tokens: 70 };
  const lineas = [
    { type: 'turn_context', payload: { model: 'gpt-5.5' } },
    ev('2026-10-25T10:00:00.000Z', t1, t1),
    ev('2026-10-25T10:01:00.000Z', t2, l2),
    ev('2026-10-25T10:01:00.300Z', t2, l2),
  ];
  const { bloque } = CU.consumoCodex(lineas, [], SID);
  assert.strictEqual(bloque.estado, 'medido', JSON.stringify(bloque));
  assert.strictEqual(bloque.respuestas, 2);
  assert.strictEqual(bloque.por_modelo['gpt-5.5'].respuestas, 2);
  const t = bloque.tokens;
  assert.strictEqual(bloque.fuera_de_ventana, t.in + t.cache_new + t.out, 'el reparto suma lo mismo que el total');
});

// Mutación: decidir la herramienta o el proveedor con el ambiente del barrido, que es de OTRA sesión.
test('T25 Digest_Sweep_ForeignSession_NotItsTool', () => {
  // una ejecución de Claude, medida desde el arranque de una sesión de Codex
  const home = tmp('t25-home-');
  conversacionClaude(path.join(home, '.claude'), [respuesta('m1', 'claude-opus-5-5', uso(10, 5), '2026-10-25T10:00:00.000Z')]);
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
  const dump = volcado(home);
  const opciones = { projectsDir: path.join(home, '.claude', 'projects'), codexDir: path.join(home, '.codex', 'sessions'), home, preciosPath: tabla(home), ahora: AHORA };
  TD.rescatarCorrida(dump, { ...opciones, env: { CODEX_SESSION_ID: 'otra-sesion-codex', TYCON_MODEL_PROVIDER: 'openai' } });
  const c = leer(dump).consumo;
  assert.strictEqual(c.estado, 'medido', JSON.stringify(c));
  assert.notStrictEqual(c.herramienta, 'codex');
  assert.strictEqual(c.tokens.in, 10);
  assert.strictEqual(c.proveedor.provider, null, JSON.stringify(c.proveedor));
  assert.ok(/otra sesión/.test(c.proveedor.problem), c.proveedor.problem);
  assert.ok(!('costo' in c), 'un modelo de Claude sigue sin costo');
  // una ejecución de Codex con un modelo sin precio, medida desde el arranque de una sesión de Claude
  const home2 = tmp('t25-home2-');
  fs.mkdirSync(path.join(home2, '.claude', 'projects'), { recursive: true });
  sesionCodex(path.join(home2, '.codex'), { model: 'gpt-sin-precio', totales: [{ input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 }] });
  const dump2 = volcado(home2);
  TD.rescatarCorrida(dump2, { projectsDir: path.join(home2, '.claude', 'projects'), codexDir: path.join(home2, '.codex', 'sessions'), home: home2, preciosPath: tabla(home2), ahora: AHORA, env: { CLAUDE_CODE_SESSION_ID: 'otra-sesion-claude' } });
  const c2 = leer(dump2).consumo;
  assert.strictEqual(c2.herramienta, 'codex', JSON.stringify(c2));
  assert.strictEqual(c2.estado, 'medido');
  assert.notStrictEqual(c2.proveedor.provider, 'anthropic');
  assert.strictEqual(c2.costo.estado, 'no_medido', JSON.stringify(c2.costo));
});

// Mutación: contar como ilegible una carpeta de conversaciones que no existe (la ejecución nunca llega a `borrada`).
test('T26 Digest_ClaudeConfigDir_MissingRoot_Deleted', () => {
  const config = tmp('t26-config-');
  fs.mkdirSync(path.join(config, 'projects', '-opt-acme-repo'), { recursive: true });
  const raices = [path.join(config, 'projects'), path.join(tmp('t26-home-'), '.claude', 'projects')];
  const r = TD.ubicarTranscripcion(SID, raices);
  assert.strictEqual(r.estado, 'borrada', JSON.stringify(r));
  // si NINGUNA existe, no se puede afirmar que se borró
  const ninguna = TD.ubicarTranscripcion(SID, [path.join(config, 'no-esta'), raices[1]]);
  assert.strictEqual(ninguna.estado, 'no_medido', JSON.stringify(ninguna));
});

// Mutación: una franja que cruza la medianoche o una hora fuera de rango cobran el horario bajo, callado.
test('T27 Digest_Price_NightBandAndBadHour', () => {
  const franjas = (peak) => ({ bands: { timezone: 'UTC', peak: { days: [1, 2, 3, 4, 5, 6, 7], per_million: { in: 9 }, ...peak }, off_peak: { per_million: { in: 1 } } } });
  const noche = franjas({ from: '22:00', to: '06:00' });
  assert.deepStrictEqual(TD.precioEn(noche, Date.parse('2026-10-26T23:30:00Z')), { in: 9 });
  assert.deepStrictEqual(TD.precioEn(noche, Date.parse('2026-10-27T03:00:00Z')), { in: 9 });
  assert.deepStrictEqual(TD.precioEn(noche, Date.parse('2026-10-27T12:00:00Z')), { in: 1 });
  for (const mal of [{ from: '25:99', to: '06:00' }, { from: '12:00', to: '12:60' }, { from: '12:00', to: '12:00' }]) {
    assert.strictEqual(TD.precioEn(franjas(mal), Date.parse('2026-10-26T13:00:00Z')), null, JSON.stringify(mal));
  }
});

// ── Dos corridas en la misma sesión ─────────────────────────────────────────────────────────────────────────────

/** Un volcado con su arranque, su cierre y sus pasos: el tramo de la sesión que le toca sale de ahí. */
function volcadoConTramo(dir, nombre, { startedAt, archivedAt, stepTimings }) {
  const ruta = path.join(dir, 'timing-history', `${nombre}.json`);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, JSON.stringify({ archivedAt, marker: { storyId: '9.9', sessionId: SID, startedAt, lastTouch: startedAt, stepTimings }, gates: [] }));
  return ruta;
}

// Una sesión larga con dos corridas cargaba en cada una el consumo de la sesión entera: el tablero contaba el mismo gasto
// dos veces y le cobraba a cada corrida el de la otra. Cada corrida cuenta sólo su tramo (el mismo que su hilo); entre
// las dos suman lo de sus dos tramos, y lo de afuera de los dos no es de ninguna. Una respuesta sin hora no es de
// ninguna corrida: con dos tramos en la misma sesión, darle la hora de su vecina la podría cobrar en la equivocada.
// Sin esto, cada corrida sale con las 8 respuestas e in=14000, la sesión entera, con la respuesta sin hora y lo de
// afuera de los dos tramos; juntas cuentan la sesión dos veces.
// Mutación: medir el consumo sobre todas las líneas de la sesión, o recortar el costo y no los tokens (o al revés).
test('T28 Digest_TwoRunsSameSession_EachCountsItsOwnWindow', () => {
  const home = tmp('t28-home-');
  conversacionClaude(path.join(home, '.claude'), [
    respuesta('fuera-antes', 'gemma4:31b-cloud', uso(1000, 1000), '2026-10-25T08:00:00.000Z'),
    respuesta('a1', 'gemma4:31b-cloud', uso(10, 1), '2026-10-25T09:55:00.000Z'),
    respuesta('a2', 'gemma4:31b-cloud', uso(20, 2), '2026-10-25T10:15:00.000Z'),
    respuesta('sin-hora', 'gemma4:31b-cloud', uso(900, 90)),
    respuesta('fuera-entre', 'gemma4:31b-cloud', uso(5000, 500), '2026-10-25T12:45:00.000Z'),
    respuesta('b1', 'gemma4:31b-cloud', uso(30, 3), '2026-10-25T14:05:00.000Z'),
    respuesta('b2', 'gemma4:31b-cloud', uso(40, 4), '2026-10-25T15:00:00.000Z'),
    respuesta('fuera-despues', 'gemma4:31b-cloud', uso(7000, 700), '2026-10-25T17:00:00.000Z'),
  ]);
  // Tramos: la primera de 09:50 a 11:30; la segunda de 13:50 a 15:20.
  const a = volcadoConTramo(home, 'corrida-a', { startedAt: '2026-10-25T10:00:00.000Z', archivedAt: '2026-10-25T10:30:00.000Z',
    stepTimings: { 0: { completedAt: '2026-10-25T10:05:00.000Z' }, 1: { completedAt: '2026-10-25T10:30:00.000Z' } } });
  const b = volcadoConTramo(home, 'corrida-b', { startedAt: '2026-10-25T14:00:00.000Z', archivedAt: '2026-10-25T14:20:00.000Z',
    stepTimings: { 0: { completedAt: '2026-10-25T14:10:00.000Z' }, 1: { completedAt: '2026-10-25T15:10:00.000Z' } } });
  const opciones = { projectsDir: path.join(home, '.claude', 'projects'), codexDir: path.join(home, '.codex', 'sessions'), home,
    preciosPath: tabla(home), ahora: AHORA, proveedor: { provider: 'ollama', origin: 'env' }, env: {} };
  for (const v of [a, b]) assert.ok(!TD.rescatarCorrida(v, opciones).error);
  const ca = leer(a).consumo;
  const cb = leer(b).consumo;

  assert.deepStrictEqual([ca.respuestas, ca.tokens], [2, { in: 30, out: 3, cache_new: 0, cache_read: 0 }], JSON.stringify(ca));
  assert.deepStrictEqual([cb.respuestas, cb.tokens], [2, { in: 70, out: 7, cache_new: 0, cache_read: 0 }], JSON.stringify(cb));
  assert.deepStrictEqual(ca.por_paso, { 0: 11, 1: 22 });
  assert.deepStrictEqual(cb.por_paso, { 0: 33, 1: 44 });
  assert.strictEqual(ca.por_modelo['gemma4:31b-cloud'].in, 30);
  // Entre las dos, lo de sus dos tramos y nada más: 100 de entrada y 10 de salida.
  assert.strictEqual(ca.tokens.in + cb.tokens.in, 100);
  assert.strictEqual(ca.tokens.out + cb.tokens.out, 10);
  // El costo, del mismo tramo: (30·1 + 3·2) y (70·1 + 7·2) por millón.
  assert.strictEqual(ca.costo.estado, 'medido', JSON.stringify(ca.costo));
  assert.strictEqual(ca.costo.total, 0.000036);
  assert.strictEqual(cb.costo.total, 0.000084);
  // La respuesta sin hora no se cobra en ninguna, pero se dice.
  assert.deepStrictEqual([ca.sin_hora, cb.sin_hora], [1, 1]);
  // El tramo con que se midió queda anotado: el barrido sabe que este consumo ya es el de la corrida.
  assert.deepStrictEqual(ca.tramo, { desde: '2026-10-25T09:50:00.000Z', hasta: '2026-10-25T11:30:00.000Z' });
});

// Una corrida medida antes del recorte guarda el consumo de la sesión entera y su ventana ya cerró: sin volver una vez,
// el barrido no la tocaría nunca más y seguiría cargando lo de las otras corridas.
// Mutación: no mirar `tramo` en el barrido → la corrida vieja no vuelve; o mirarlo siempre → vuelve en cada arranque.
test('T29 Digest_Sweep_RunMeasuredBeforeWindow_ComesBackOnce', () => {
  const home = tmp('t29-home-');
  conversacionClaude(path.join(home, '.claude'), [
    respuesta('a1', 'gemma4:31b-cloud', uso(10, 1), '2026-10-25T10:15:00.000Z'),
    respuesta('fuera', 'gemma4:31b-cloud', uso(5000, 500), '2026-10-25T17:00:00.000Z'),
  ]);
  const ruta = volcadoConTramo(home, 'vieja', { startedAt: '2026-10-25T10:00:00.000Z', archivedAt: '2026-10-25T10:30:00.000Z', stepTimings: {} });
  const d = leer(ruta);
  d.consumo = { estado: 'medido', respuestas: 2, tokens: { in: 5010, out: 501, cache_new: 0, cache_read: 0 }, hilo_hasta: '2026-10-25T10:15:00.000Z', hilo_guardado_en: '2026-10-25T18:00:00.000Z' };
  d.revisores = { estado: 'no_medido', motivo: 'de prueba' };
  fs.writeFileSync(ruta, JSON.stringify(d));
  const projectsDir = path.join(home, '.claude', 'projects');
  assert.strictEqual(TD.estaPendiente(ruta, projectsDir, { ahora: AHORA, env: {} }), true);
  assert.ok(!TD.rescatarCorrida(ruta, { projectsDir, home, preciosPath: tabla(home), ahora: AHORA, proveedor: { provider: 'ollama', origin: 'env' }, env: {} }).error);
  assert.strictEqual(leer(ruta).consumo.tokens.in, 10);
  assert.strictEqual(TD.estaPendiente(ruta, projectsDir, { ahora: AHORA, env: {} }), false);
});

// Una corrida vieja sin tramo cuya conversación no se puede leer hoy (un permiso) no vuelve al barrido, y si el rescate
// corre igual no pisa lo que ya estaba medido: se reintenta otro día. Sólo un recálculo que sale bien lo reemplaza.
// Sin esto, el barrido la da por pendiente y el rescate deja `no_medido` en lugar de los 5010 tokens.
// Mutación: volver sin mirar si la conversación se lee, o reemplazar el consumo cuando la lectura falla.
test('T30 Digest_OldRunUnreadableConversation_KeepsMeasured', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
  const home = tmp('t30-home-');
  conversacionClaude(path.join(home, '.claude'), [respuesta('a1', 'gemma4:31b-cloud', uso(10, 1), '2026-10-25T10:15:00.000Z')]);
  const conversacion = path.join(home, '.claude', 'projects', '-opt-acme-repo', `${SID}.jsonl`);
  const ruta = volcadoConTramo(home, 'vieja', { startedAt: '2026-10-25T10:00:00.000Z', archivedAt: '2026-10-25T10:30:00.000Z', stepTimings: {} });
  const d = leer(ruta);
  d.consumo = { estado: 'medido', respuestas: 2, tokens: { in: 5010, out: 501, cache_new: 0, cache_read: 0 }, hilo_hasta: '2026-10-25T10:15:00.000Z', hilo_guardado_en: '2026-10-25T18:00:00.000Z' };
  d.revisores = { estado: 'no_medido', motivo: 'de prueba' };
  fs.writeFileSync(ruta, JSON.stringify(d));
  const projectsDir = path.join(home, '.claude', 'projects');
  fs.chmodSync(conversacion, 0o000);
  try {
    assert.strictEqual(TD.estaPendiente(ruta, projectsDir, { ahora: AHORA, env: {} }), false);
    assert.ok(!TD.rescatarCorrida(ruta, { projectsDir, home, preciosPath: tabla(home), ahora: AHORA, proveedor: { provider: 'ollama', origin: 'env' }, env: {} }).error);
    const c = leer(ruta).consumo;
    assert.deepStrictEqual([c.estado, c.tokens.in, c.tramo], ['medido', 5010, undefined], JSON.stringify(c));
    assert.strictEqual(c.conversacion.estado, 'no_medido');
  } finally {
    fs.chmodSync(conversacion, 0o600);
  }
  // Con la conversación legible otra vez, vuelve y se recorta.
  assert.strictEqual(TD.estaPendiente(ruta, projectsDir, { ahora: AHORA, env: {} }), true);
});

// Un tramo sin ninguna respuesta no es «consumió cero»: sale «no medido», sin la clave `tokens` y sin costo.
// Sin esto, sale `medido` con todos los tokens en cero.
// Mutación: publicar el consumo de un tramo vacío como medido.
test('T31 Digest_EmptyWindow_NotMeasured', () => {
  const home = tmp('t31-home-');
  conversacionClaude(path.join(home, '.claude'), [respuesta('fuera', 'gemma4:31b-cloud', uso(5000, 500), '2026-10-25T17:00:00.000Z')]);
  const ruta = volcadoConTramo(home, 'vacia', { startedAt: '2026-10-25T10:00:00.000Z', archivedAt: '2026-10-25T10:30:00.000Z', stepTimings: {} });
  assert.ok(!TD.rescatarCorrida(ruta, { projectsDir: path.join(home, '.claude', 'projects'), home, preciosPath: tabla(home), ahora: AHORA, proveedor: { provider: 'ollama', origin: 'env' }, env: {} }).error);
  const c = leer(ruta).consumo;
  assert.strictEqual(c.estado, 'no_medido', JSON.stringify(c));
  assert.ok(!('tokens' in c) && !('costo' in c), JSON.stringify(c));
  assert.match(c.motivo, /tramo/);
});
