'use strict';
/**
 * session-model.js — el modelo de una sesión de Claude, leído de su conversación.
 *
 * Qué hace. Busca `~/.claude/projects/<carpeta>/<sesión>.jsonl` y devuelve el primer `message.model` que no es
 * `<synthetic>` (los mensajes que arma Claude Code y no vienen del modelo). Lee por tramos de 1 MB, como
 * transcript-tokens.js: hay conversaciones de más de 500 MB y el modelo aparece en los primeros renglones.
 *
 * Por qué. La tabla de controles cuenta cada freno por modelo; un modelo supuesto haría pasar por medido lo que no se
 * midió. Sin conversación, sin poder leerla o sin modelo, devuelve `{ model: null, noMedido: <motivo> }`, nunca un modelo.
 *
 * Uso: `modelOf(sid, { home, index })`; para muchas sesiones, `transcriptIndex({ home })` una vez y pasarlo como `index`.
 * 0 deps.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const STEP_BYTES = 1024 * 1024;
const SESION = /^[\w-]{1,80}$/;

/** Sesión → ruta de su conversación, de todas las carpetas de `~/.claude/projects`. Una carpeta ilegible se saltea. */
function transcriptIndex({ home = os.homedir(), io = fs } = {}) {
  const index = new Map();
  const base = path.join(home, '.claude', 'projects');
  let carpetas = [];
  try { carpetas = io.readdirSync(base); } catch (_) { return index; }
  for (const c of carpetas) {
    let nombres = [];
    try { nombres = io.readdirSync(path.join(base, c)); } catch (_) { continue; }
    for (const n of nombres) if (n.endsWith('.jsonl')) index.set(n.slice(0, -6), path.join(base, c, n));
  }
  return index;
}

/** El primer modelo real de la conversación, o null. Tira si el archivo no se puede abrir o leer. */
function firstModel(file, io = fs) {
  const fd = io.openSync(file, 'r');
  try {
    const size = io.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    let at = 0;
    const deRenglon = (line) => {
      if (!line.includes('"model"')) return null;
      let d;
      try { d = JSON.parse(line); } catch (_) { return null; }
      const m = d && d.message && d.message.model;
      return typeof m === 'string' && m && m !== '<synthetic>' ? m : null;
    };
    while (at < size) {
      const chunk = Buffer.alloc(Math.min(STEP_BYTES, size - at));
      const n = io.readSync(fd, chunk, 0, chunk.length, at);
      if (!n) break;
      at += n;
      const whole = Buffer.concat([carry, chunk.subarray(0, n)]);
      const lastEnd = whole.lastIndexOf(10);
      if (lastEnd < 0) { carry = whole; continue; }
      for (const line of whole.subarray(0, lastEnd).toString('utf8').split('\n')) {
        const m = line && deRenglon(line);
        if (m) return m;
      }
      carry = whole.subarray(lastEnd + 1);
    }
    return carry.length ? deRenglon(carry.toString('utf8')) : null;
  } finally { io.closeSync(fd); }
}

/** `{ model }` o `{ model: null, noMedido }`. */
function modelOf(sid, { home = os.homedir(), index, io = fs } = {}) {
  if (typeof sid !== 'string' || !SESION.test(sid)) return { model: null, noMedido: 'sesión sin forma de sesión' };
  const file = (index || transcriptIndex({ home, io })).get(sid);
  if (!file) return { model: null, noMedido: 'no encontré la conversación de la sesión' };
  let model;
  try { model = firstModel(file, io); } catch (e) {
    return { model: null, noMedido: `no pude leer la conversación (${(e && (e.code || e.message)) || e})` };
  }
  return model ? { model } : { model: null, noMedido: 'la conversación no tiene modelo' };
}

module.exports = { modelOf, transcriptIndex, firstModel, STEP_BYTES };
