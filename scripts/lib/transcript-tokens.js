'use strict';
/**
 * transcript-tokens.js — los tokens de una conversación de Claude o de Codex, por día local, sin nada más de la sesión.
 *
 * Vive aparte de session-transcript.js (que lo usa y lo vuelve a exportar) para que la preparación de los días
 * (scripts/metrics/workday-upload.js), que también carga el sitio, no arrastre la oficina y sus herramientas.
 * Cada turno de Claude trae su `usage` y puede ocupar varios renglones con el mismo `message.id`: se cuenta una vez por
 * mensaje (`addTurn`). Se lee por tramos de 1 MB: hay conversaciones de más de 500 MB.
 *
 * Los tokens también salen repartidos por modelo (`porModelo`), para el costo estimado del sitio. Claude trae el modelo en
 * cada respuesta (`message.model`); Codex, en el renglón `turn_context` de cada turno (`payload.model`), que vale para los
 * conteos que le siguen. Lo que llega sin modelo va a `SIN_MODELO`: nunca a un modelo adivinado.
 */
const fs = require('fs');

const TOKEN_STEP_BYTES = 1024 * 1024;
const PARTES = ['lectura', 'escritura', 'cache'];
const SIN_MODELO = 'sin_modelo';
const newCount = () => ({ offset: 0, byMessage: new Map(), lectura: 0, escritura: 0, cache: 0, porModelo: {}, ultimo: null, codex: null, codexTurno: null });
const modeloDe = (m) => (typeof m === 'string' && m.trim() ? m.trim() : SIN_MODELO);

/** Suma `delta` (lectura, escritura, caché) al modelo `modelo` de `porModelo`. */
function sumarModelo(porModelo, modelo, delta, signo = 1) {
  const m = porModelo[modelo] || (porModelo[modelo] = { lectura: 0, escritura: 0, cache: 0 });
  for (const k of PARTES) m[k] += signo * (delta[k] || 0);
}

function addTurn(count, id, u, model) {
  const now = { lectura: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), escritura: u.output_tokens || 0, cache: u.cache_read_input_tokens || 0, modelo: modeloDe(model) };
  const was = count.byMessage.get(id);
  for (const k of PARTES) count[k] += now[k] - (was ? was[k] : 0);
  if (!count.porModelo) count.porModelo = {};
  if (was) sumarModelo(count.porModelo, was.modelo, was, -1);
  sumarModelo(count.porModelo, now.modelo, now);
  count.byMessage.set(id, now);
}

/** La resta de dos totales acumulados de Codex, en lectura (entrada sin caché), escritura y caché. */
function codexDiff(base, last) {
  const n = (t, k) => Number((t && t[k]) || 0);
  const input = Math.max(0, n(last, 'input_tokens') - n(base, 'input_tokens'));
  const cached = Math.max(0, n(last, 'cached_input_tokens') - n(base, 'cached_input_tokens'));
  return { lectura: Math.max(0, input - cached), escritura: Math.max(0, n(last, 'output_tokens') - n(base, 'output_tokens')), cache: cached };
}

/**
 * Los tokens de una conversación por día local, en una sola lectura: `days` es `[{ day, desde, hasta }]` (ms) y devuelve
 * `{ <día>: { lectura, escritura, cache, sinHora, hubo, codex } }`, uno por día pedido. Se lee renglón por renglón y no con
 * `countLine`, que no mira la hora y de Codex guarda sólo el último total. Claude: lectura, escritura y caché de cada
 * respuesta con hora en el día, una vez por mensaje (`addTurn`); un agente (`isAgent`) cuenta sus renglones laterales.
 * Codex: el primer y el último total acumulado del día (`codex: { primero, ultimo, modeloPrimero, pasos }`), que resta
 * quien llama; `pasos` reparte por modelo lo que creció entre conteos del mismo día, y `modeloPrimero` es el modelo del
 * primer conteo, a quien va lo que creció antes de él. `porModelo`: el reparto de Claude por modelo. Una
 * respuesta sin hora no se cuenta: va a `sinHora` del día del renglón con hora anterior; un renglón con uso que no se
 * entiende, igual, a `ilegibles`. `hubo`: hubo algún mensaje con hora ese día. Tira si el archivo no se puede leer.
 */
function dayTokens(file, { days = [], isAgent = false } = {}) {
  const out = {};
  for (const d of days) out[d.day] = { count: newCount(), sinHora: 0, ilegibles: 0, hubo: false, primero: null, ultimo: null, modeloPrimero: null, pasos: {} };
  const dayAt = (t) => { const d = days.find((x) => t >= x.desde && t < x.hasta); return d ? d.day : null; };
  let previo = null;
  // el modelo del turno de Codex en curso: vale para los conteos que le siguen
  let modeloCodex = SIN_MODELO;
  // lo que llega antes del primer renglón con hora va al día de ese renglón (o, si no hay ninguno, al de la última
  // modificación del archivo): no se pierde callado
  let visto = false;
  const antes = { sinHora: 0, ilegibles: 0 };
  const aparte = (k) => { if (!visto) antes[k] += 1; else if (previo && out[previo]) out[previo][k] += 1; };
  const onLine = (line) => {
    const turno = line.includes('"turn_context"');
    if (!turno && !line.includes('"usage"') && !line.includes('"token_count"')) return;
    let d;
    try { d = JSON.parse(line); } catch { if (!turno) aparte('ilegibles'); return; }
    if (!d || typeof d !== 'object') return;
    if (d.type === 'turn_context') { modeloCodex = modeloDe(d.payload && d.payload.model); return; }
    const t = Date.parse(d.timestamp);
    const claude = d.type === 'assistant' && d.message && d.message.usage && typeof d.message.usage === 'object';
    const p = d.type === 'event_msg' && d.payload;
    const codex = p && p.type === 'token_count' && p.info && p.info.total_token_usage;
    if (!claude && !codex) return;
    if (claude && (d.message.model === '<synthetic>' || (d.isSidechain && !isAgent))) return;
    if (!Number.isFinite(t)) { aparte('sinHora'); return; }
    const day = dayAt(t);
    previo = day;
    if (!visto) {
      visto = true;
      if (day) for (const k of ['sinHora', 'ilegibles']) out[day][k] += antes[k];
    }
    if (!day) return;
    const b = out[day];
    b.hubo = true;
    if (claude) addTurn(b.count, d.message.id || d.uuid, d.message.usage, d.message.model);
    else {
      const total = p.info.total_token_usage;
      if (!b.primero) { b.primero = total; b.modeloPrimero = modeloCodex; } else sumarModelo(b.pasos, modeloCodex, codexDiff(b.ultimo, total));
      b.ultimo = total;
    }
  };
  const fd = fs.openSync(file, 'r');
  let mtime = NaN;
  try {
    const st = fs.fstatSync(fd);
    mtime = st.mtimeMs;
    const size = st.size;
    let carry = Buffer.alloc(0);
    let at = 0;
    while (at < size) {
      const chunk = Buffer.alloc(Math.min(TOKEN_STEP_BYTES, size - at));
      const n = fs.readSync(fd, chunk, 0, chunk.length, at);
      if (!n) break;
      at += n;
      const whole = Buffer.concat([carry, chunk.subarray(0, n)]);
      const lastEnd = whole.lastIndexOf(10);
      if (lastEnd < 0) { carry = whole; continue; }
      for (const line of whole.subarray(0, lastEnd).toString('utf8').split('\n')) if (line) onLine(line);
      carry = whole.subarray(lastEnd + 1);
    }
    if (carry.length) onLine(carry.toString('utf8'));
  } finally { fs.closeSync(fd); }
  if (!visto) {
    const day = dayAt(mtime);
    if (day) for (const k of ['sinHora', 'ilegibles']) out[day][k] += antes[k];
  }
  const result = {};
  for (const [day, b] of Object.entries(out)) {
    result[day] = { lectura: b.count.lectura, escritura: b.count.escritura, cache: b.count.cache, porModelo: b.count.porModelo, sinHora: b.sinHora, ilegibles: b.ilegibles, hubo: b.hubo, codex: b.ultimo ? { primero: b.primero, ultimo: b.ultimo, modeloPrimero: b.modeloPrimero, pasos: b.pasos } : null };
  }
  return result;
}

module.exports = { dayTokens, newCount, addTurn, codexDiff, sumarModelo, SIN_MODELO, TOKEN_STEP_BYTES };
