#!/usr/bin/env node
/**
 * blocking-meter.js — hook `Stop`: MIDE cuánto tiempo del turno estuvo BLOQUEADO en una sola
 * tool call, y si el dev escribió mensajes durante esa espera.
 *
 * Por qué existe: la regla de ejecución en segundo plano ("pasos ≥2 min van de fondo, se anuncia
 * la duración, y al volver se contesta al dev primero" — bloque TYCON_BLOCK:background-execution
 * de ~/.claude/CLAUDE.md) existe porque, durante tool calls bloqueantes largas, los mensajes del dev esperan
 * minutos sin respuesta. Sin gate, esa regla es la única de su familia que depende de la memoria del modelo — y la
 * lección medida del arnés es que la regla que nada verifica se degrada. Esto la vuelve un número.
 *
 * Qué NO hace, a propósito: NO bloquea el fin de turno (mismo criterio que response-style-meter:
 * cobrar después, no interrumpir). El feedback viaja al turno siguiente vía `blocking-notice.js`.
 *
 * Qué mide (del transcript JSONL del turno que termina):
 *   · por cada tool_use del assistant, el delta hasta su tool_result — EXCLUYENDO las lanzadas con
 *     `run_in_background: true`, la tool `Workflow` (ya son de fondo por diseño) y las que esperan
 *     la respuesta del dev (ver ESPERAN_AL_DEV);
 *   · la espera bloqueante más larga (la métrica que gatea) + cuántas superaron 1 minuto;
 *   · cuántos mensajes REALES del dev quedaron encolados a mitad del turno — el caso que más duele.
 *
 * Fail-open total: cualquier error → exit 0 sin output. Nunca rompe el cierre de un turno.
 *
 * Uso manual:
 *   node blocking-meter.js --report        # estadística de cumplimiento
 *   node blocking-meter.js --report --all  # detalle por turno
 *   node blocking-meter.js --selftest      # corre la medición sobre un transcript sintético
 *
 * Opt-out: TYCON_BLOCKING_METER=0
 * Umbral:  TYCON_BLOCKING_MAX_MS (default 120000 = 2 min, el mismo corte de la regla)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude', 'blocking-meter');
const LOG_PATH = path.join(STATE_DIR, 'log.jsonl');
const PENDING_DIR = path.join(STATE_DIR, 'pending');
const PROBE_PATH = path.join(STATE_DIR, 'input-shape.json');

const MAX_MS = Number(process.env.TYCON_BLOCKING_MAX_MS || 120000);
const LONG_MS = 60000; // "llamada larga" para el conteo informativo (1 min)
// Herramientas que esperan la respuesta del dev: su demora es la del dev y no se pueden mandar de
// fondo. Contarlas produce avisos falsos: el aviso le pediría al modelo correr de fondo una pregunta.
const ESPERAN_AL_DEV = new Set(['AskUserQuestion', 'ExitPlanMode', 'mcp__spokenly__ask_user_dictation']);

// ─────────────────────────────────────────────────────────────────────────────
// Medición sobre el transcript
// ─────────────────────────────────────────────────────────────────────────────

function parseLines(raw) {
  return String(raw).split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function blocksOf(rec) {
  const msg = rec.message || rec;
  const c = msg.content;
  return Array.isArray(c) ? c : null;
}

/** ¿Es un prompt REAL del dev? — texto humano, no un tool_result ni un registro sintético. */
function isGenuineUserPrompt(rec) {
  const msg = rec.message || rec;
  const role = msg.role || rec.role || rec.type;
  if (role !== 'user') return false;
  if (rec.isMeta === true) return false;
  const c = msg.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (!Array.isArray(c)) return false;
  if (c.some((b) => b && b.type === 'tool_result')) return false;
  return c.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim());
}

function tsOf(rec) {
  const t = rec.timestamp || rec.ts || (rec.message && rec.message.timestamp);
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Mide una VENTANA del transcript (los registros desde el Stop anterior — el cursor lo maneja
 * main). El PRIMER prompt real del dev en la ventana es el que abrió el turno; cualquier otro es
 * un mensaje que quedó ENCOLADO a mitad de la espera — no se puede distinguir por contenido, solo
 * por posición (buscar "el último prompt" cortaría el turno en el mensaje encolado y dejaría la
 * espera larga afuera de la ventana).
 * Devuelve null si no hay nada medible (ventana sin prompt, sin tools, timestamps ausentes).
 */
function measure(lines) {
  let turnStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isGenuineUserPrompt(lines[i])) { turnStart = i; break; }
  }
  if (turnStart === -1) return null;

  // tool_use pendientes del turno: id → {name, ts, background}
  const open = new Map();
  const spans = [];
  let userMsgsDuringTurn = 0;

  for (let i = turnStart + 1; i < lines.length; i++) {
    const rec = lines[i];
    const role = (rec.message && rec.message.role) || rec.role || rec.type;
    const blocks = blocksOf(rec);
    if (isGenuineUserPrompt(rec)) { userMsgsDuringTurn++; continue; }
    if (!blocks) continue;

    if (role === 'assistant') {
      for (const b of blocks) {
        if (!b || b.type !== 'tool_use') continue;
        const input = b.input || {};
        const background = input.run_in_background === true || b.name === 'Workflow' || ESPERAN_AL_DEV.has(b.name);
        open.set(b.id, { name: b.name, ts: tsOf(rec), background });
      }
    } else {
      for (const b of blocks) {
        if (!b || b.type !== 'tool_result' || !open.has(b.tool_use_id)) continue;
        const u = open.get(b.tool_use_id);
        open.delete(b.tool_use_id);
        const end = tsOf(rec);
        if (u.background || u.ts == null || end == null) continue;
        spans.push({ name: u.name, ms: end - u.ts });
      }
    }
  }

  if (!spans.length) return { worst: null, longCalls: 0, userMsgsDuringTurn, calls: 0 };
  const worst = spans.reduce((a, b) => (b.ms > a.ms ? b : a), spans[0]);
  return {
    worst,
    longCalls: spans.filter((s) => s.ms >= LONG_MS).length,
    userMsgsDuringTurn,
    calls: spans.length,
  };
}

function verdict(m) {
  const reasons = [];
  if (m && m.worst && m.worst.ms > MAX_MS) {
    reasons.push(`una tool call bloqueante de ${fmt(m.worst.ms)} (${m.worst.name}; tope ${fmt(MAX_MS)})`);
    if (m.userMsgsDuringTurn > 0) {
      reasons.push(`${m.userMsgsDuringTurn} mensaje(s) del dev quedaron encolados durante la espera`);
    }
  }
  return { over: reasons.length > 0, reasons };
}

function fmt(ms) {
  if (ms >= 60000) return `${Math.round(ms / 60000)} min`;
  return `${Math.round(ms / 1000)}s`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistencia / reporte (molde response-style-meter)
// ─────────────────────────────────────────────────────────────────────────────

function ensureDirs() {
  for (const d of [STATE_DIR, PENDING_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* fail-open */ }
  }
}

function probeOnce(event) {
  if (fs.existsSync(PROBE_PATH)) return;
  try {
    fs.writeFileSync(PROBE_PATH, JSON.stringify({
      recordedAt: new Date().toISOString(),
      topLevelKeys: Object.keys(event).sort(),
    }, null, 2) + '\n');
  } catch { /* fail-open */ }
}

function report(showAll) {
  if (!fs.existsSync(LOG_PATH)) { console.log('Sin mediciones todavía. El hook escribe a', LOG_PATH); return; }
  const rows = parseLines(fs.readFileSync(LOG_PATH, 'utf8'));
  if (!rows.length) { console.log('Log vacío.'); return; }
  const over = rows.filter((r) => r.over);
  const pct = Math.round(((rows.length - over.length) / rows.length) * 100);
  const worst = rows.reduce((a, b) => ((b.worstMs || 0) > (a.worstMs || 0) ? b : a), rows[0]);
  console.log(`Turnos medidos (con tools): ${rows.length}`);
  console.log(`Dentro del tope (${fmt(MAX_MS)} de bloqueo máximo): ${rows.length - over.length} (${pct}%)`);
  console.log(`Pasados: ${over.length} · con mensajes del dev encolados: ${rows.filter((r) => r.over && r.userMsgs > 0).length}`);
  if (worst.worstMs) console.log(`El peor: ${fmt(worst.worstMs)} en ${worst.worstTool} — ${worst.at}`);
  if (showAll) {
    for (const r of rows) {
      console.log(`  ${r.at}  peor=${String(fmt(r.worstMs || 0)).padStart(7)} (${r.worstTool || '—'})  llamadas≥1min=${r.longCalls}  msgsEncolados=${r.userMsgs}  ${r.over ? '✗' : '✓'}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Selftest — la medición sobre un transcript sintético (sin harness)
// ─────────────────────────────────────────────────────────────────────────────

function selftest() {
  const t0 = Date.parse('2026-07-30T10:00:00Z');
  const iso = (ms) => new Date(t0 + ms).toISOString();
  const rec = (role, content, ms) => JSON.stringify({ type: role, message: { role, content }, timestamp: iso(ms) });
  const lines = parseLines([
    rec('user', 'arrancá el pipeline', 0),
    // llamada de fondo: NO cuenta aunque tarde 10 min
    rec('assistant', [{ type: 'tool_use', id: 'bg1', name: 'Bash', input: { command: 'sleep', run_in_background: true } }], 1000),
    rec('user', [{ type: 'tool_result', tool_use_id: 'bg1', content: 'ok' }], 600000),
    // llamada bloqueante larga: 199s — la que gatea
    rec('assistant', [{ type: 'tool_use', id: 'a1', name: 'Bash', input: { command: 'npm test' } }], 601000),
    // mensaje real del dev encolado a mitad del turno
    rec('user', [{ type: 'text', text: '¿cómo vas?' }], 700000),
    rec('user', [{ type: 'tool_result', tool_use_id: 'a1', content: 'verde' }], 800000),
    // llamada corta: no molesta
    rec('assistant', [{ type: 'tool_use', id: 'a2', name: 'Read', input: {} }], 801000),
    rec('user', [{ type: 'tool_result', tool_use_id: 'a2', content: 'x' }], 802000),
  ].join('\n'));

  const m = measure(lines);
  const v = verdict(m);
  const asserts = [
    [m.calls === 2, `calls=2 (la de fondo excluida) — dio ${m.calls}`],
    [m.worst.ms === 199000, `worst=199000ms — dio ${m.worst && m.worst.ms}`],
    [m.worst.name === 'Bash', `worst.name=Bash — dio ${m.worst && m.worst.name}`],
    [m.userMsgsDuringTurn === 1, `1 mensaje encolado — dio ${m.userMsgsDuringTurn}`],
    [v.over === true, 'over=true con el default de 2 min'],
    [v.reasons.length === 2, `2 razones (espera + encolado) — dio ${v.reasons.length}`],
  ];
  // Una pregunta al dev que tarda 10 min NO es un bloqueo: la demora es del dev.
  const soloPregunta = measure(parseLines([
    rec('user', 'decidí vos', 0),
    rec('assistant', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [] } }], 1000),
    rec('user', [{ type: 'tool_result', tool_use_id: 'q1', content: 'la A' }], 601000),
    rec('assistant', [{ type: 'tool_use', id: 'r1', name: 'Read', input: {} }], 602000),
    rec('user', [{ type: 'tool_result', tool_use_id: 'r1', content: 'x' }], 603000),
  ].join('\n')));
  asserts.push(
    [soloPregunta.calls === 1, `AskUserQuestion excluida: calls=1 — dio ${soloPregunta.calls}`],
    [verdict(soloPregunta).over === false, 'una pregunta de 10 min al dev no da over'],
  );
  let fallos = 0;
  for (const [ok, msg] of asserts) {
    console.log(`${ok ? '✓' : '✗'} ${msg}`);
    if (!ok) fallos++;
  }
  console.log(fallos === 0 ? 'selftest: TODO VERDE' : `selftest: ${fallos} en rojo`);
  process.exit(fallos === 0 ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) return selftest();
  if (args.includes('--report')) return report(args.includes('--all'));
  if (process.env.TYCON_BLOCKING_METER === '0') return;

  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : {};
  } catch { return; }
  if (event.stop_hook_active === true) return;

  const tPath = event.transcript_path || event.transcriptPath;
  if (!tPath || !fs.existsSync(tPath)) return;
  let lines;
  try { lines = parseLines(fs.readFileSync(tPath, 'utf8')); } catch { return; }

  ensureDirs();
  probeOnce(event);

  // Cursor por sesión: la ventana entre Stops ES el turno. Sin esto habría que adivinar el inicio
  // del turno por contenido, y un mensaje encolado se confunde con el que abre.
  const sessionIdForCursor = event.session_id || event.sessionId || '_nosession';
  const cursorPath = path.join(STATE_DIR, `cursor-${sessionIdForCursor}.json`);
  let cursor = 0;
  try { cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8')).lines || 0; } catch { cursor = 0; }
  if (cursor > lines.length) cursor = 0; // transcript nuevo/rotado → ventana completa
  const ventana = lines.slice(cursor);
  try { fs.writeFileSync(cursorPath, JSON.stringify({ lines: lines.length }) + '\n'); } catch { /* fail-open */ }

  const m = measure(ventana);
  if (!m || !m.worst) return; // turno sin tools bloqueantes medibles → nada que anotar
  const v = verdict(m);
  const sessionId = event.session_id || event.sessionId || '_nosession';
  const at = new Date().toISOString();

  if (v.over) {
    try {
      fs.writeFileSync(path.join(PENDING_DIR, `${sessionId}.json`), JSON.stringify({
        at, sessionId, worstMs: m.worst.ms, worstTool: m.worst.name,
        longCalls: m.longCalls, userMsgs: m.userMsgsDuringTurn,
        maxMs: MAX_MS, reasons: v.reasons,
      }, null, 2) + '\n');
    } catch { /* fail-open */ }
  }

  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify({
      at, sessionId, cwd: event.cwd || process.cwd(),
      worstMs: m.worst.ms, worstTool: m.worst.name, calls: m.calls,
      longCalls: m.longCalls, userMsgs: m.userMsgsDuringTurn,
      over: v.over, reasons: v.reasons,
    }) + '\n');
  } catch { /* fail-open */ }
}

try { main(); } catch { /* fail-open: jamás romper el cierre del turno */ }
if (!process.argv.slice(2).includes('--selftest')) process.exit(0);
