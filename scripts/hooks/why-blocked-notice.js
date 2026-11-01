#!/usr/bin/env node
/**
 * why-blocked-notice.js — cuando la persona pregunta por qué la frenó el arnés, el asistente recibe el último freno.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────────────────────
 * Un freno para el comando con un mensaje pensado para el asistente: el código de la regla, la ruta del gancho, la
 * forma de la firma. La persona pregunta «¿por qué me frenaste?» y, sin el mensaje a mano (otro turno, el hilo
 * resumido), la respuesta sale de memoria o en la jerga del freno.
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * En cada prompt, si la persona pregunta por qué la frenó (en castellano o en inglés), busca en el hilo de la sesión el
 * ÚLTIMO freno previo a una herramienta y se lo pasa al asistente con el comando que paró, pidiéndole que lo explique
 * en llano: qué hacía el comando, por qué lo paró y cómo se sigue. Sin ningún freno en el hilo, le dice que no hubo y
 * que no lo invente.
 *
 *   Claude Code: el resultado con error que empieza «PreToolUse:<herramienta> hook error: [<gancho>]: <mensaje>».
 *   Codex: la salida de la herramienta con «Command blocked by PreToolUse hook: <mensaje>».
 *
 * Sólo cuenta esa forma, en ese lugar: un texto que la cita (una búsqueda, un mensaje del asistente) no es un freno.
 * Lo que se pasa sale tapado (credenciales y rutas, con los mismos tapadores que el resumen de consumo) y cortado.
 *
 * Lo que NO hace, a propósito: no escribe nada (ni archivos ni registro), no frena nada (todo error sale 0 sin
 * salida), no lee otro hilo que el de la sesión. Off: TYCON_WHY_BLOCKED_NOTICE=0.
 * Red: scripts/tests/why-blocked-notice.test.js y controls-bench/cases/hooks/73-why-blocked-notice.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const COMMAND_MAX = 300;
const MESSAGE_MAX = 1500;

const CLAUDE_BRAKE = /^PreToolUse:\S+ hook error: /;
const CODEX_BRAKE = /(?:^|\n)Command blocked by PreToolUse hook: ([\s\S]*)$/;

/** ¿La persona pregunta por qué la frenó? Sin tildes ni mayúsculas, en castellano o en inglés. */
function asksWhy(prompt) {
  const t = String(prompt || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/\bpor ?que\b.{0,60}?(fren|bloque|\bparaste\b|\bparo\b|\bpararon\b|\bcortaste\b)/.test(t)) return true;
  return /\bwhy\b.{0,60}?\b(block|stopp?ed|stop me|halt)/.test(t);
}

function readRecords(tp) {
  const out = [];
  for (const l of fs.readFileSync(tp, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* línea a medias */ }
  }
  return out;
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : '');

/** Lo que una herramienta iba a correr, en una línea: el comando, o la ruta que iba a escribir. */
function commandOf(input) {
  if (typeof input === 'string') {
    try { return commandOf(JSON.parse(input)); } catch { return input; }
  }
  if (!input || typeof input !== 'object') return '';
  const c = input.command || input.cmd || input.file_path || input.path;
  return Array.isArray(c) ? c.join(' ') : String(c || '');
}

/** `{ message, command, at }` del último freno del hilo, o null. Sirve para los hilos de Claude Code y de Codex. */
function lastBrake(records) {
  const calls = new Map();
  let last = null;
  for (const r of records) {
    const p = r && r.type === 'response_item' && r.payload && typeof r.payload === 'object' ? r.payload : null;
    if (p) {
      if (/^(?:custom_tool_call|function_call|local_shell_call)$/.test(String(p.type)) && p.call_id) calls.set(p.call_id, commandOf(p.input !== undefined ? p.input : p.arguments));
      if (/^(?:custom_tool_call_output|function_call_output)$/.test(String(p.type))) {
        const m = CODEX_BRAKE.exec(textOf(p.output));
        if (m) last = { message: m[1], command: calls.get(p.call_id) || '', at: r.timestamp };
      }
      continue;
    }
    const msg = r && (r.message || r);
    const content = msg && Array.isArray(msg.content) ? msg.content : [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'tool_use' && b.id) calls.set(b.id, commandOf(b.input));
      if (b.type === 'tool_result' && b.is_error === true && (msg.role || r.type) === 'user') {
        const t = textOf(b.content).trim();
        if (!CLAUDE_BRAKE.test(t)) continue;
        let rest = t.replace(CLAUDE_BRAKE, '');
        if (rest.startsWith('[')) { const i = rest.indexOf(']: '); if (i >= 0) rest = rest.slice(i + 3); }
        last = { message: rest, command: calls.get(b.tool_use_id) || '', at: r.timestamp };
      }
    }
  }
  return last;
}

function clean(s, max) {
  const { sanear } = require(path.join(ROOT, 'scripts', 'metrics', 'tokens-digest.js'));
  const { redactShapes } = require(path.join(ROOT, 'scripts', 'lib', 'provider-secret-shapes.js'));
  const t = redactShapes(sanear(String(s || ''))).trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
const clock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : ` (${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')})`; };

/** El texto para el asistente, o '' si el prompt no pregunta por un freno. */
function notice(d) {
  if (!asksWhy(d.prompt)) return '';
  const head = 'La persona pregunta por qué la frenó el arnés.';
  let records;
  try { records = readRecords(d.transcript_path); } catch {
    return `${head} No pude leer el hilo de esta sesión para buscar el freno: contestá con lo que tengas a la vista y no lo inventes.`;
  }
  const b = lastBrake(records);
  if (!b) {
    return `${head} En el hilo de esta sesión no hay ningún freno previo a una herramienta. Decíselo así y no lo inventes; si se refiere a otra cosa (un control al commitear, el cierre del turno), preguntale cuál.`;
  }
  return [
    `${head} El último freno de esta sesión${clock(b.at)}:`,
    ...(b.command ? [`  Comando: ${clean(b.command, COMMAND_MAX)}`] : []),
    `  Mensaje del freno: ${clean(b.message, MESSAGE_MAX)}`,
    'Contestale en llano, sin jerga ni códigos de regla: qué iba a hacer ese comando, por qué el freno lo paró y cómo se sigue (el camino que nombra el mensaje, si nombra uno; si hace falta una firma, quién la da).',
  ].join('\n');
}

module.exports = { asksWhy, lastBrake, notice };

if (require.main === module) {
  try {
    if (process.env.TYCON_WHY_BLOCKED_NOTICE !== '0') {
      const d = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
      const out = notice(d);
      if (out) process.stdout.write(out + '\n');
    }
  } catch { /* fail-open: nunca rompe un prompt */ }
  process.exit(0);
}
