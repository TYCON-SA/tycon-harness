'use strict';
/**
 * codex-usage.js — el consumo de una sesión de Codex, para el bloque `consumo` de la constancia de cada corrida.
 *
 * Codex guarda cada sesión en `<CODEX_HOME>/sessions/AAAA/MM/DD/rollout-<fecha>-<id>.jsonl`. De ese archivo se leen
 * SÓLO tres tipos de evento: `session_meta` (el id), `turn_context` (el modelo) y `event_msg` con
 * `payload.type = token_count` (los tokens). El texto de la conversación no se lee ni se copia.
 *
 * 🔴 LOS TIPOS, SIN CONTAR NADA DOS VECES. En el formato de OpenAI la entrada INCLUYE la caché y la salida INCLUYE el
 * razonamiento: `total_tokens = input_tokens + output_tokens` (medido sobre 202 sesiones de una máquina, sin una sola
 * diferencia). Claude Code, en cambio, da la entrada SIN la caché. Para que los dos bloques se sumen igual:
 *   in = input_tokens − cached_input_tokens − cache_write_input_tokens · cache_read = cached_input_tokens
 *   cache_new = cache_write_input_tokens · out = output_tokens · out_reasoning = reasoning_output_tokens (parte de out)
 *
 * El total sale del ÚLTIMO `total_token_usage` (es acumulado). El reparto por paso usa el `last_token_usage` de cada
 * evento con su hora, con los mismos cortes que las conversaciones de Claude Code.
 *
 * Nunca un cero donde no se midió: un archivo sin ningún `token_count` (la sesión se cortó antes de la primera
 * respuesta) sale `no_medido`, sin la clave `tokens`.
 */

const fs = require('fs');
const path = require('path');

const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const num = (v) => (Number.isFinite(v) ? v : 0);

/** La carpeta de sesiones de Codex: `$CODEX_HOME/sessions` o `<home>/.codex/sessions`. */
function carpetaDeSesiones(env, home) {
  return env && env.CODEX_HOME ? path.join(env.CODEX_HOME, 'sessions') : path.join(home, '.codex', 'sessions');
}

/**
 * Ubica el archivo de una sesión por su id. Devuelve {ruta} | {estado:'no_medido', motivo}. Nunca `borrada`: ese estado
 * habla de las conversaciones de Claude Code, y el barrido lo da por definitivo.
 */
function ubicarSesion(sessionId, sessionsDir) {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(String(sessionId))) {
    return { estado: 'no_medido', motivo: `el identificador de sesión anotado no sirve para buscar la sesión de Codex (${String(sessionId || '').slice(0, 40)})` };
  }
  const sufijo = `-${sessionId}.jsonl`;
  let encontrada = null;
  const ilegibles = [];
  const recorrer = (dir, nivel) => {
    let entradas;
    try {
      entradas = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (nivel === 0) throw e;
      ilegibles.push(`${path.relative(sessionsDir, dir)}: ${e.code || e.message}`);
      return;
    }
    for (const d of entradas) {
      if (encontrada) return;
      const p = path.join(dir, d.name);
      if (d.isDirectory() && nivel < 3) recorrer(p, nivel + 1);
      else if (d.isFile() && d.name.endsWith(sufijo)) encontrada = p;
    }
  };
  try {
    recorrer(sessionsDir, 0);
  } catch (e) {
    return { estado: 'no_medido', motivo: `no pude leer la carpeta de sesiones de Codex (${sessionsDir}): ${e.code || e.message}` };
  }
  if (encontrada) return { ruta: encontrada };
  // sin la sesión y con alguna subcarpeta sin leer, no se sabe si estaba ahí: se dice «no pude leer», no «no está»
  if (ilegibles.length) {
    return { estado: 'no_medido', motivo: `no encontré la sesión de Codex ${sessionId} y no pude leer ${ilegibles.length} carpeta(s) de ${sessionsDir} (${ilegibles.slice(0, 3).join('; ')})` };
  }
  return { estado: 'no_medido', motivo: `no encontré la sesión de Codex ${sessionId} en ${sessionsDir}` };
}

/**
 * El consumo de una sesión ya parseada. `lineas` son objetos; `cortes` viene de `cortesDePaso()` de tokens-digest.js.
 * Devuelve `{ bloque, paraCosto, motivoCosto }`: el bloque va a la constancia; `paraCosto` es la lista que usa el costo
 * (una sola entrada con el total y sin hora, porque Codex no da la hora de cada respuesta junto a su precio).
 */
function consumoCodex(lineas, cortes, sessionId) {
  const meta = lineas.find((o) => o && o.type === 'session_meta');
  if (sessionId && meta && meta.payload && meta.payload.id && meta.payload.id !== sessionId) {
    return { bloque: { estado: 'no_medido', herramienta: 'codex', motivo: `el archivo de la sesión dice otro id (${String(meta.payload.id).slice(0, 40)})` } };
  }
  let modelo = null;
  const modelos = new Set();
  let ultimo = null;
  let leidoHasta = null;
  let respuestas = 0;
  const porPaso = {};
  let fuera = 0;
  for (const o of lineas) {
    if (!o || !o.payload) continue;
    if (o.type === 'turn_context') {
      if (o.payload.model) { modelo = o.payload.model; modelos.add(modelo); }
      continue;
    }
    if (o.type !== 'event_msg' || o.payload.type !== 'token_count' || !o.payload.info) continue;
    const info = o.payload.info;
    if (!info.total_token_usage) continue;
    // Codex a veces repite el mismo evento ~0,3 s después: el total acumulado igual al anterior no es otra respuesta
    if (ultimo && JSON.stringify(info.total_token_usage) === JSON.stringify(ultimo)) continue;
    respuestas += 1;
    ultimo = info.total_token_usage;
    const t = ms(o.timestamp);
    if (t !== null && (leidoHasta === null || t > leidoHasta)) leidoHasta = t;
    const l = info.last_token_usage || {};
    // los tokens nuevos de esta respuesta: la entrada sin la caché leída, más la salida (la caché escrita va adentro)
    const nuevos = num(l.input_tokens) - num(l.cached_input_tokens) + num(l.output_tokens);
    const corte = t === null ? null : cortes.find((c) => t <= c.hasta);
    if (!corte) fuera += nuevos;
    else porPaso[corte.paso] = (porPaso[corte.paso] || 0) + nuevos;
  }
  if (!ultimo) {
    return { bloque: { estado: 'no_medido', herramienta: 'codex', motivo: 'la sesión de Codex no tiene ningún evento token_count: se cortó antes de la primera respuesta, o no guardó su consumo' } };
  }
  // un total sin la entrada o sin la salida no es un total: contarlo con ceros sería inventar
  const faltan = ['input_tokens', 'output_tokens'].filter((k) => !Number.isFinite(ultimo[k]));
  if (faltan.length) {
    return { bloque: { estado: 'no_medido', herramienta: 'codex', motivo: `el último total de la sesión de Codex no trae ${faltan.join(' ni ')}` } };
  }
  const tokens = {
    in: num(ultimo.input_tokens) - num(ultimo.cached_input_tokens) - num(ultimo.cache_write_input_tokens),
    out: num(ultimo.output_tokens),
    cache_new: num(ultimo.cache_write_input_tokens),
    cache_read: num(ultimo.cached_input_tokens),
    out_reasoning: num(ultimo.reasoning_output_tokens),
  };
  const bloque = {
    estado: 'medido',
    herramienta: 'codex',
    respuestas,
    sinteticos: 0,
    lineas_ilegibles: 0,
    tokens,
    por_paso: porPaso,
    fuera_de_ventana: fuera,
    hilo_hasta: null,
    leido_hasta: leidoHasta === null ? null : new Date(leidoHasta).toISOString(),
  };
  const lista = [...modelos];
  if (lista.length === 1) {
    bloque.por_modelo = { [lista[0]]: { respuestas, in: tokens.in, out: tokens.out, cache_new: tokens.cache_new, cache_read: tokens.cache_read } };
    return { bloque, paraCosto: [{ modelo: lista[0], t: null, in: tokens.in, out: tokens.out, cache_new: tokens.cache_new, cache_read: tokens.cache_read }] };
  }
  bloque.por_modelo_motivo = lista.length
    ? `la sesión usó ${lista.length} modelos y Codex da un solo total: no se reparte por modelo`
    : 'la sesión no anotó su modelo';
  return { bloque, paraCosto: null, motivoCosto: bloque.por_modelo_motivo };
}

/** Lee el archivo y lo parsea. Cuenta las líneas ilegibles en vez de descartarlas calladas. */
function leerSesion(ruta) {
  let crudo;
  try {
    crudo = fs.readFileSync(ruta, 'utf8');
  } catch (e) {
    return { error: `no pude leer la sesión de Codex: ${e.code || e.message}` };
  }
  const lineas = [];
  let ilegibles = 0;
  for (const l of crudo.split('\n')) {
    if (!l.trim()) continue;
    try { lineas.push(JSON.parse(l)); } catch { ilegibles += 1; }
  }
  return { lineas, ilegibles };
}

module.exports = { carpetaDeSesiones, ubicarSesion, consumoCodex, leerSesion };
