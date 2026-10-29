#!/usr/bin/env node
/**
 * response-style-meter.js — hook `Stop`: MIDE el largo del mensaje final del turno.
 *
 * Por qué existe: la regla de estilo de respuesta ("conclusión primero, detalle a pedido",
 * bloque TYCON_BLOCK:response-style de ~/.claude/CLAUDE.md) es la única regla del harness que
 * no tiene gate — depende de que el modelo se acuerde en el momento de escribir, y bajo presión
 * de contexto se ignora. Se reescribió 2 veces con más texto y falló las 2. Esto la convierte en
 * un número medido, igual que los tests o los advisors.
 *
 * Qué NO hace, a propósito: NO bloquea el fin de turno. Bloquear haría que el modelo escriba un
 * SEGUNDO mensaje después del muro que el user ya leyó → más ruido, no menos. El feedback viaja
 * al turno siguiente vía `response-style-notice.js` (hook UserPromptSubmit).
 *
 * Fail-open total: cualquier error → exit 0 sin output. Nunca rompe el cierre de un turno.
 *
 * Uso manual:
 *   node response-style-meter.js --report        # estadística de cumplimiento
 *   node response-style-meter.js --report --all  # incluye el detalle por turno
 *
 * Opt-out: TYCON_RESPONSE_METER=0 en la máquina, o `switches.response_meter: "off"` en el perfil (la variable gana).
 * Umbrales:  TYCON_RESPONSE_MAX_PROSE_CHARS (el que importa; sin la variable, `response.max_chars` de la configuración
 *            o el tope del estilo elegido, y 1300 si no se pudo leer) · TYCON_RESPONSE_MAX_LINES (15)
 *            · TYCON_RESPONSE_MAX_HEADERS (1) · TYCON_RESPONSE_MAX_SENTENCE_WORDS (35)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude', 'response-style');
const LOG_PATH = path.join(STATE_DIR, 'log.jsonl');
const PENDING_DIR = path.join(STATE_DIR, 'pending');
const LONG_DIR = path.join(STATE_DIR, 'long');
const PROBE_PATH = path.join(STATE_DIR, 'input-shape.json');

const MAX_LINES = Number(process.env.TYCON_RESPONSE_MAX_LINES || 15);
const MAX_HEADERS = Number(process.env.TYCON_RESPONSE_MAX_HEADERS || 1);
// El tope de prosa: la variable › `response.max_chars` de la configuración (el perfil del equipo, o el
// tope del estilo elegido si no lo fija) › 1300, el de siempre, si la configuración no se pudo leer.
function topeDeLaConfiguracion() {
  try {
    const C = require(path.join(__dirname, '..', 'lib', 'tycon-config.js'));
    if (typeof C.respuesta !== 'function') return null;
    const r = C.sinAnotar(() => C.leerParaHook());
    if (r.ok) return C.respuesta(r.config).max_chars;
    // rota: se mide con el de siempre, y se dice (no saber el tope no es «el tope es 1300»); el medidor sí hace su parte
    process.stderr.write('⚠️ tycon: la configuración del arnés está rota (node scripts/lib/tycon-config.js validate dice qué): el medidor de estilo usa el tope de siempre, 1300, hasta que se arregle\n');
    return null;
  } catch (e) {
    process.stderr.write(`⚠️ tycon: el medidor de estilo no pudo leer la configuración (${(e && e.message) || e}): usa el tope de siempre, 1300\n`);
    return null;
  }
}
// se resuelve al medir, después de mirar el apagado (TYCON_RESPONSE_METER=0 no lee la configuración ni avisa nada)
let MAX_PROSE_CHARS = Number(process.env.TYCON_RESPONSE_MAX_PROSE_CHARS || 1300);
function resolverTope() { if (!process.env.TYCON_RESPONSE_MAX_PROSE_CHARS) MAX_PROSE_CHARS = Number(topeDeLaConfiguracion() || 1300); }
const MAX_SENTENCE_WORDS = Number(process.env.TYCON_RESPONSE_MAX_SENTENCE_WORDS || 35);

// ─────────────────────────────────────────────────────────────────────────────
// Medición
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Largo en palabras de cada oración de una línea de prosa. Lo tomado de ASD-STE100 (el inglés
 * técnico simplificado): una idea por oración. El código en línea y los enlaces cuentan como lo
 * que el lector ve (una palabra, el texto del enlace); un renglón de lista es su propia oración.
 */
function sentencesOf(line) {
  const clean = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^([-*+]|\d+[.)])\s+/, '')
    .replace(/`[^`]*`/g, 'X')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'X')
    .replace(/\*\*/g, '');
  return clean.split(/(?<=[.!?:;])\s+(?=[A-ZÁÉÍÓÚÑ¿¡«"(])/)
    .map((text) => ({ text: text.trim(), words: (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-./]*/gu) || []).length }))
    .filter((x) => x.words > 0);
}

/**
 * Cuenta la PROSA del mensaje: líneas no vacías que están FUERA de bloques de código.
 * Un mensaje con un script largo que el user pidió no es verbosidad — los fences no cuentan.
 * Las tablas markdown tampoco (son datos enumerables, la regla las permite explícitamente).
 */
function measure(text) {
  const lines = String(text).split(/\r?\n/);
  let inFence = false;
  let prose = 0;        // líneas de prosa (source)
  let proseChars = 0;   // caracteres de prosa — el que importa (ver nota)
  let headers = 0;
  let fenced = 0;
  let table = 0;
  let longest = { words: 0, text: '' };

  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      fenced++;
      continue;
    }
    if (inFence) { fenced++; continue; }
    if (!line) continue;
    if (/^\|.*\|$/.test(line)) { table++; continue; }
    if (/^#{2,6}\s/.test(line)) headers++;
    prose++;
    proseChars += line.length;
    for (const x of sentencesOf(line)) if (x.words > longest.words) longest = x;
  }

  return {
    prose, proseChars, headers, fenced, table,
    longestSentence: longest.words, longestSentenceText: longest.text.length > 200 ? `${longest.text.slice(0, 200)}…` : longest.text,
    total: lines.length, chars: String(text).length,
    wrapped: Math.ceil(proseChars / 100),  // renglones aprox. en una terminal de ~100 cols
  };
}

/**
 * NOTA DE CALIBRACIÓN DEL LARGO DE ORACIÓN: sobre 6.500 mensajes finales de 30 días,
 * la oración mediana tenía 12 palabras, pero el 56 % de los mensajes traía alguna de más de 25 y el
 * 23 %, alguna de más de 35. El bloque pide ~20 (lo que el modelo apunta al escribir); el medidor
 * cobra desde 35 para avisar las que de verdad cuestan leer sin avisar uno de cada dos turnos.
 *
 * NOTA DE CALIBRACIÓN:
 * contar LÍNEAS de source no alcanza — un párrafo largo sin cortes es 1 línea pero 6 renglones en
 * pantalla, así que un muro pasaba el control con "3 líneas". El gate real es `proseChars`, que sí
 * escala con lo que el lector ve. Referencia empírica: un mensaje ejecutivo correcto midió ~1180
 * caracteres de prosa (~11 renglones). El tope se fija apenas arriba de eso.
 * `chars` (el total, con código incluido) NO se usa para gatear: un artefacto pedido no es verbosidad.
 */
function verdict(m) {
  const reasons = [];
  if (m.proseChars > MAX_PROSE_CHARS) {
    reasons.push(`${m.proseChars} caracteres de prosa ≈ ${m.wrapped} renglones en pantalla (tope ${MAX_PROSE_CHARS} ≈ ${Math.ceil(MAX_PROSE_CHARS / 100)})`);
  }
  if (m.prose > MAX_LINES) reasons.push(`${m.prose} líneas de prosa (tope ${MAX_LINES})`);
  if (m.headers > MAX_HEADERS) reasons.push(`${m.headers} títulos de sección (tope ${MAX_HEADERS})`);
  if (m.longestSentence > MAX_SENTENCE_WORDS) {
    reasons.push(`una oración de ${m.longestSentence} palabras (tope ${MAX_SENTENCE_WORDS}; objetivo ~20): «${m.longestSentenceText}»`);
  }
  return { over: reasons.length > 0, reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extracción del mensaje final
// ─────────────────────────────────────────────────────────────────────────────

/** Camino A: el campo directo, si el harness lo provee. */
function fromEvent(event) {
  for (const key of ['last_assistant_message', 'lastAssistantMessage', 'final_message']) {
    const v = event[key];
    if (typeof v === 'string' && v.trim()) return v;
    // Puede venir como bloques de contenido.
    if (Array.isArray(v)) {
      const joined = v.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text).join('\n');
      if (joined.trim()) return joined;
    }
  }
  return null;
}

/** Camino B (fallback): el último turno del assistant en el transcript JSONL. */
function fromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return null; }
  const lines = raw.split(/\r?\n/).filter(Boolean);

  // Se recorre desde el final: el último evento del assistant con texto visible.
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    const msg = rec.message || rec;
    const role = msg.role || rec.role || rec.type;
    if (role !== 'assistant') continue;
    const content = msg.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text).join('\n');
      // Un turno que solo tiene tool_use no es el mensaje final visible: seguir buscando.
      if (text.trim()) return text;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistencia
// ─────────────────────────────────────────────────────────────────────────────

function ensureDirs() {
  for (const d of [STATE_DIR, PENDING_DIR, LONG_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* fail-open */ }
  }
}

function appendLog(entry) {
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n'); } catch { /* fail-open */ }
}

/**
 * Sonda de una sola vez: deja constancia de QUÉ campos trae realmente el input del hook Stop
 * en esta versión del harness, para no depender de suposiciones sobre el schema.
 */
function probeOnce(event, source) {
  if (fs.existsSync(PROBE_PATH)) return;
  try {
    fs.writeFileSync(PROBE_PATH, JSON.stringify({
      recordedAt: new Date().toISOString(),
      topLevelKeys: Object.keys(event).sort(),
      textSource: source,
    }, null, 2) + '\n');
  } catch { /* fail-open */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporte (--report)
// ─────────────────────────────────────────────────────────────────────────────

function report(showAll) {
  if (!fs.existsSync(LOG_PATH)) {
    console.log('Sin mediciones todavía. El hook escribe a', LOG_PATH);
    return;
  }
  const rows = fs.readFileSync(LOG_PATH, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  if (!rows.length) { console.log('Log vacío.'); return; }

  const over = rows.filter((r) => r.over);
  const pct = Math.round(((rows.length - over.length) / rows.length) * 100);
  const key = (r) => (r.proseChars != null ? r.proseChars : r.prose * 80);
  const vals = rows.map(key).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const withSentence = rows.filter((r) => r.longestSentence != null);
  const longSentences = withSentence.filter((r) => r.longestSentence > MAX_SENTENCE_WORDS).length;
  const worst = rows.reduce((a, b) => (key(b) > key(a) ? b : a), rows[0]);

  console.log(`Mensajes finales medidos: ${rows.length}`);
  console.log(`Dentro de los topes (${MAX_PROSE_CHARS} caracteres de prosa ≈ ${Math.ceil(MAX_PROSE_CHARS / 100)} renglones; oraciones de hasta ${MAX_SENTENCE_WORDS} palabras): ${rows.length - over.length} (${pct}%)`);
  console.log(`Pasados de largo: ${over.length}`);
  console.log(`Mediana: ${median} caracteres de prosa (≈ ${Math.ceil(median / 100)} renglones)`);
  if (withSentence.length) {
    console.log(`Con alguna oración de más de ${MAX_SENTENCE_WORDS} palabras: ${longSentences} de ${withSentence.length} (${Math.round(100 * longSentences / withSentence.length)}%)`);
  }
  console.log(`El más largo: ${key(worst)} caracteres ≈ ${Math.ceil(key(worst) / 100)} renglones — ${worst.at}${worst.savedTo ? ` → ${worst.savedTo}` : ''}`);

  if (showAll) {
    console.log('\nDetalle:');
    for (const r of rows) {
      console.log(`  ${r.at}  prosaChars=${String(key(r)).padStart(5)} (≈${String(Math.ceil(key(r)/100)).padStart(2)} rengl.)  líneas=${String(r.prose).padStart(3)}  títulos=${r.headers}  ${r.over ? '✗ ' + r.reasons.join('; ') : '✓'}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

// La organización puede apagar o encender este medidor desde el sitio (`switches.response_meter` del perfil); la variable
// TYCON_RESPONSE_METER de la máquina, si está puesta, gana. Sin lector, o con la configuración rota, sigue encendido: una clave
// que no se puede leer no lo apaga, y el aviso va a stderr.
function orgSwitchOn(name) {
  try {
    const C = require(path.join(__dirname, '..', 'lib', 'tycon-config.js'));
    return C.switchOn(name, { warn: (w) => process.stderr.write(`${w}\n`) });
  } catch { return true; }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--report')) { resolverTope(); return report(args.includes('--all')); }

  if (process.env.TYCON_RESPONSE_METER === '0') return;
  if (!orgSwitchOn('response_meter')) return;
  resolverTope();

  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : {};
  } catch { return; }

  // Si el propio hook ya forzó una continuación, no re-medir (no aplica hoy porque nunca
  // bloqueamos, pero deja el invariante explícito si alguien lo cambia).
  if (event.stop_hook_active === true) return;

  let text = fromEvent(event);
  let source = 'event';
  if (!text) {
    text = fromTranscript(event.transcript_path || event.transcriptPath);
    source = 'transcript';
  }

  ensureDirs();
  probeOnce(event, text ? source : 'none');
  if (!text) return; // no se pudo leer el mensaje → no inventar una medición

  const m = measure(text);
  const v = verdict(m);
  const sessionId = event.session_id || event.sessionId || '_nosession';
  const at = new Date().toISOString();

  let savedTo = null;
  if (v.over) {
    // El desagüe automático: el texto largo queda archivado, así el aviso del turno siguiente
    // puede decir "está guardado acá" en vez de pedir que se reescriba de memoria.
    try {
      savedTo = path.join(LONG_DIR, `${at.replace(/[:.]/g, '-')}.md`);
      fs.writeFileSync(savedTo, text);
    } catch { savedTo = null; }

    try {
      fs.writeFileSync(path.join(PENDING_DIR, `${sessionId}.json`), JSON.stringify({
        at, sessionId, prose: m.prose, proseChars: m.proseChars, wrapped: m.wrapped,
        headers: m.headers, longestSentence: m.longestSentence, reasons: v.reasons,
        maxLines: MAX_LINES, maxHeaders: MAX_HEADERS, maxProseChars: MAX_PROSE_CHARS,
        maxSentenceWords: MAX_SENTENCE_WORDS, savedTo,
      }, null, 2) + '\n');
    } catch { /* fail-open */ }
  }

  appendLog({
    at, sessionId, cwd: event.cwd || process.cwd(), source,
    prose: m.prose, proseChars: m.proseChars, wrapped: m.wrapped,
    headers: m.headers, fenced: m.fenced, table: m.table, chars: m.chars,
    longestSentence: m.longestSentence, over: v.over, reasons: v.reasons, savedTo,
  });
}

try { main(); } catch { /* fail-open: jamás romper el cierre del turno */ }
process.exit(0);
