#!/usr/bin/env node
/**
 * wait-notice.js — la ejecución avisa por los canales de la organización cuando queda esperando a una persona.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────────────────────
 * La espera por una persona es buena parte del reloj de una corrida y sin aviso nadie se entera: quien deja
 * corriendo una story descubre una hora después que había una pregunta sin contestar.
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * Abre una ESPERA por sesión cuando una corrida del pipeline queda parada esperando a la persona, y la cierra cuando
 * vuelve. Si en el plazo (5 minutos; `wait_notice.minutes` de team-repos.json; `TYCON_WAIT_NOTICE_MS` en la máquina)
 * nadie se movió, manda UN mensaje por cada canal con el id de la story, el paso por su nombre llano y qué se espera.
 * Los canales los elige la organización en el perfil (`integrations.notify.channels`); sin la lista, Telegram.
 *
 *   Stop (también con stop_hook_active) · PreToolUse de las tres herramientas que esperan a la persona ·
 *   Notification con permission_prompt                                        → abre la espera
 *   UserPromptSubmit · PostToolUse de esas herramientas                         → la cierra: answered
 *   SessionEnd                                                                  → la cierra: session-ended
 *   --timer <sesión> <apertura>  (el proceso desprendido, uno por sesión)      → al cumplirse el plazo, decide
 *
 * «Siguió» se decide contando los registros DE VERDAD del hilo (prompts genuinos de la persona, mensajes del agente
 * con texto o con una herramienta), nunca por el tamaño del archivo: el hilo recibe registros que no son de nadie.
 *
 * Lo que NO hace, a propósito: sin ningún canal por donde avisar no hace NADA (ni archivos ni procesos); no
 * frena nada (todo error sale 0 sin salida); no tiene cliente de ningún canal (la única salida a la red es
 * scripts/lib/notify.js, con las credenciales del dev); no reintenta; no manda más que el id de la story, el nombre del paso y una
 * línea de 200 caracteres con las credenciales tapadas; no anota el chat ni el permiso del bot.
 *
 * Estado (en la carpeta de estado del arnés, `stateDir` de tycon-home.js): wait-notice/waits/<sesión>.json (la espera
 * abierta) · wait-notice/last-message.json (el último aviso y las sesiones que lista) · wait-notice/log.jsonl (una
 * línea por espera cerrada: story, paso, inicio, si avisó, resultado, vuelta).
 * Off: TYCON_WAIT_NOTICE=0. Red: scripts/tests/wait-notice.test.js y controls-bench/cases/hooks/58-wait-notice.json.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SKILL_LIB = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib');
const NOTIFY = path.join(ROOT, 'scripts', 'lib', 'notify.js');
const DEFAULT_MINUTES = 5;
const STALE_MS = 12 * 3600 * 1000;
const ALIVE_MARGIN_MS = 2 * 60 * 1000;
const LINE_MAX = 200;
// Copia de ESPERAN_AL_DEV de scripts/hooks/blocking-meter.js, que no se puede importar (no exporta y corre al
// cargarse): T16 compara las dos listas.
const WAIT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'mcp__spokenly__ask_user_dictation']);
// Las formas de una credencial, copiadas de FORMAS_EN_COMENTARIO de scripts/lib/tycon-config.js (no se exportan).
const SECRET_SHAPES = [
  /\d{6,}:[A-Za-z0-9_-]{30,}/g,
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])(?:pass(?:word|wd)?|pwd|secret|secreto|token|api[_-]?key|chat_?id)\s*[=:]\s*(?=[^\s,;)\]}»"'`]*[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s,;)\]}»"'`])[^\s,;)\]}»"'`]{4,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

// la carpeta del estado la sabe tycon-home.js; si este archivo viaja suelto (al banco, a un laboratorio), la ruta de siempre
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const home = () => os.homedir();
const dirs = () => {
  const sd = stateDirOf(home());
  const base = path.join(sd, 'wait-notice');
  return { active: path.join(sd, 'active'), base, waits: path.join(base, 'waits'), log: path.join(base, 'log.jsonl'), shared: path.join(base, 'last-message.json') };
};
const safeSid = (sid) => String(sid || '_nosession').replace(/[^A-Za-z0-9._-]/g, '_');

// ── la tabla de pasos ────────────────────────────────────────────────────────────────────────────────────────────
let STEPS_LIB;
function stepsLib() {
  if (STEPS_LIB !== undefined) return STEPS_LIB;
  try { STEPS_LIB = require(path.join(SKILL_LIB, 'steps.js')); } catch { STEPS_LIB = null; }
  return STEPS_LIB;
}
/** El nombre llano de un paso (nombre de máquina, o id del marcador viejo); con uno que la tabla no conoce, el id tal cual y `unknown`. */
function stepLabel(id) {
  const lib = stepsLib();
  const name = lib ? lib.stepName(id) : null;
  return name ? { id: String(id), name, unknown: false } : { id: String(id), name: String(id), unknown: true };
}

/** El paso en que quedó la corrida: el primero de la secuencia sin cerrar. `null` si la corrida terminó. */
function currentStep(marker) {
  const pend = (Array.isArray(marker.stepsPending) ? marker.stepsPending : []).map(String);
  if (!pend.length) return null;
  const lib = stepsLib();
  // un marcador que la tabla no sabe leer: el primer pendiente tal cual, marcado como desconocido
  if (!lib || lib.schemeOf(marker) === null) return stepLabel(pend[0]);
  const enSecuencia = lib.pendingSteps(marker).filter((id) => id !== lib.CLOSE_STEP.id);
  // los pasos de bandera cuentan como pendientes mientras quede CUALQUIER paso, también el cierre en ADO: si sólo quedan
  // ellos, la secuencia terminó
  const conLista = enSecuencia.filter((id) => !(lib.STEPS.find((s) => s.id === id) || {}).flag);
  return conLista.length ? stepLabel(enSecuencia[0]) : null;   // sólo queda el cierre en ADO: terminó
}

function readMarker(sid) {
  try { return JSON.parse(fs.readFileSync(path.join(dirs().active, `${safeSid(sid)}.json`), 'utf8')); } catch { return null; }
}

// ── el hilo de la sesión ─────────────────────────────────────────────────────────────────────────────────────────
// Dos formatos: el de Claude Code ({type, message:{role, content}}) y el de Codex ({type:'response_item', payload:{type,
// role, content:[{type:'input_text'|'output_text'}]}}). Sin el segundo, del lado Codex (sólo Stop) el plazo nunca veía
// que la persona contestó y avisaría igual.
// Lo que Codex inyecta como mensaje de la persona y no lo escribió nadie: las instrucciones y el contexto del entorno.
const CODEX_INJECTED = /^\s*(?:#\s*AGENTS\.md instructions|<(?:environment_context|user_instructions|INSTRUCTIONS|permissions instructions|turn_aborted)\b)/;
function codexItem(rec) { return rec && rec.type === 'response_item' && rec.payload && typeof rec.payload === 'object' ? rec.payload : null; }
function codexTexts(p) { return Array.isArray(p.content) ? p.content.filter((b) => b && typeof b.text === 'string').map((b) => b.text) : []; }

// El criterio de isGenuineUserPrompt de scripts/hooks/blocking-meter.js (que no exporta).
function isGenuineUserPrompt(rec) {
  const p = codexItem(rec);
  if (p) return p.type === 'message' && p.role === 'user' && codexTexts(p).some((t) => t.trim() && !CODEX_INJECTED.test(t));
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
function isAgentMessage(rec) {
  const p = codexItem(rec);
  if (p) {
    if (/^(?:function_call|local_shell_call|custom_tool_call)$/.test(String(p.type))) return true;
    return p.type === 'message' && p.role === 'assistant' && codexTexts(p).some((t) => t.trim());
  }
  const msg = rec.message || rec;
  if ((msg.role || rec.type) !== 'assistant') return false;
  const c = msg.content;
  if (typeof c === 'string') return c.trim().length > 0;
  return Array.isArray(c) && c.some((b) => b && ((b.type === 'text' && String(b.text || '').trim()) || b.type === 'tool_use'));
}
function readRecords(tp) {
  if (!tp) return [];
  let text = '';
  try { text = fs.readFileSync(tp, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* línea a medias */ } }
  return out;
}
/** Cuántos registros de verdad tiene el hilo, y cuántos de ésos son prompts de la persona. */
function countRecords(tp) {
  let records = 0, prompts = 0;
  for (const r of readRecords(tp)) {
    if (isGenuineUserPrompt(r)) { records++; prompts++; } else if (isAgentMessage(r)) records++;
  }
  return { records, prompts };
}
const usefulLines = (s) => String(s || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('```'));
/** La última línea con texto del último mensaje del agente. */
function lastAgentLine(tp) {
  const recs = readRecords(tp);
  for (let i = recs.length - 1; i >= 0; i--) {
    const p = codexItem(recs[i]);
    if (p) {
      if (p.type !== 'message' || p.role !== 'assistant') continue;
      const lines = usefulLines(codexTexts(p).join('\n'));
      if (lines.length) return lines[lines.length - 1];
      continue;
    }
    const msg = recs[i].message || recs[i];
    if ((msg.role || recs[i].type) !== 'assistant') continue;
    const c = msg.content;
    const texts = typeof c === 'string' ? [c] : (Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text) : []);
    const lines = usefulLines(texts.join('\n'));
    if (lines.length) return lines[lines.length - 1];
  }
  return '';
}

/**
 * ¿Quedó una tarea de fondo sin terminar? Un cierre de turno con una tarea de fondo corriendo es el agente esperando su
 * tarea, no a la persona: cuando termina, el arnés lo despierta. Se lanza → su resultado
 * dice «Command running in background with ID: X» / «agentId: X» / «Task ID: X»; termina → llega «<task-id>X</task-id>».
 */
function backgroundPending(tp) {
  const launched = new Set();
  const done = new Set();
  for (const r of readRecords(tp)) {
    const s = JSON.stringify(r.message || r.payload || r);
    // sólo lo que se lanzó DE FONDO: un subagente en primer plano también imprime su agentId en el informe (revisor de
    // fallas silenciosas, vuelta 2; verificado en transcripciones reales)
    for (const m of s.matchAll(/running in background with ID:\s*([A-Za-z0-9_-]{4,})/g)) launched.add(m[1]);
    for (const m of s.matchAll(/Async agent launched[^]*?agentId:\s*([A-Za-z0-9_-]{4,})/g)) launched.add(m[1]);
    for (const m of s.matchAll(/Workflow launched in background[^]*?Task ID:\s*([A-Za-z0-9_-]{4,})/g)) launched.add(m[1]);
    for (const m of s.matchAll(/<task-id>\s*([A-Za-z0-9_-]{4,})\s*<\/task-id>/g)) done.add(m[1]);
  }
  return [...launched].some((id) => !done.has(id));
}

// ── el plazo ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** `{ ms, problem }`: la variable de la máquina, si no `wait_notice.minutes` de la organización, si no 5 minutos. */
function thresholdMs({ env = process.env, tree, homeDir } = {}) {
  const def = { ms: DEFAULT_MINUTES * 60000, problem: null };
  const v = env.TYCON_WAIT_NOTICE_MS;
  if (v !== undefined && /^\d+$/.test(String(v)) && Number(v) > 0) return { ms: Number(v), problem: null };
  const envProblem = v !== undefined && String(v) !== '' ? `TYCON_WAIT_NOTICE_MS: tiene que ser un número de milisegundos (es ${JSON.stringify(String(v)).slice(0, 40)})` : null;
  if (envProblem) return { ms: def.ms, problem: envProblem };
  try {
    let dir = tree;
    if (!dir) {
      const hp = path.join(SKILL_LIB, 'harness-path.js');
      dir = fs.existsSync(hp) ? require(hp).rutaArnesHook({ env, home: homeDir || home() }).dir : null;
    }
    if (!dir) return def;
    let text;
    try { text = fs.readFileSync(path.join(dir, 'team-repos.json'), 'utf8'); } catch { return def; }
    const r = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js')).parse(String(text).replace(/^﻿/, ''));
    const sec = r.sectionProblems && r.sectionProblems.wait_notice;
    if (sec && sec.length) return { ms: def.ms, problem: `${sec[0].path}: ${sec[0].message}` };
    const m = r.ok && r.data && r.data.wait_notice && r.data.wait_notice.minutes;
    return Number.isInteger(m) ? { ms: m * 60000, problem: null } : def;
  } catch { return def; }
}

// ── el mensaje ───────────────────────────────────────────────────────────────────────────────────────────────────
function redact(s, botToken) {
  let t = String(s || '');
  if (botToken && botToken.length >= 8) t = t.split(botToken).join('<token>');
  for (const re of SECRET_SHAPES) t = t.replace(re, '<tapado>');
  return t;
}
function oneLine(s, botToken) {
  // primero se tapa y después se corta: cortada, una credencial deja de tener su forma y el pedazo se escapaba
  const first = redact(usefulLines(s)[0] || '', botToken);
  return first.length > LINE_MAX ? `${first.slice(0, LINE_MAX - 1)}…` : first;
}
/** El texto del aviso: por cada espera, el id de la story, el nombre llano del paso y una línea. Nada más. */
function buildMessage(entries, { botToken } = {}) {
  const lines = entries.map((e) => `· Story ${e.story} — ${stepLabel(e.step).name}: ${oneLine(e.waiting, botToken) || 'esperando tu respuesta'}`);
  const head = entries.length === 1 ? '⏳ Una ejecución te espera hace rato:' : `⏳ ${entries.length} ejecuciones te esperan:`;
  return [head, ...lines].join('\n');
}

// ── el estado en disco ───────────────────────────────────────────────────────────────────────────────────────────
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}
const waitPath = (sid) => path.join(dirs().waits, `${safeSid(sid)}.json`);
const readWait = (sid) => readJson(waitPath(sid));
function logLine(obj) {
  fs.mkdirSync(dirs().base, { recursive: true });
  fs.appendFileSync(dirs().log, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
}
function readShared() {
  const s = readJson(dirs().shared);
  return s && Array.isArray(s.sessions) ? s : { messageId: null, sessions: [] };
}
function dropFromShared(sid) {
  const s = readShared();
  if (!s.sessions.includes(sid)) return;
  writeJsonAtomic(dirs().shared, { ...s, sessions: s.sessions.filter((x) => x !== sid) });
}
/**
 * El archivo compartido se lee, se manda y se escribe con un candado (una carpeta, que se crea de forma atómica): dos
 * plazos casi juntos leían los dos el mismo estado y el segundo pisaba al primero. Un
 * candado de más de 2 minutos es de un proceso que murió y se saca. Sin candado en 90 s, se sigue igual: avisar mal
 * ordenado es mejor que no avisar.
 */
const LOCK_STALE_MS = 2 * 60 * 1000;
function withSharedLock(fn) {
  const lock = path.join(dirs().base, 'shared.lock');
  fs.mkdirSync(dirs().base, { recursive: true });
  const t0 = Date.now();
  let mine = false;
  while (Date.now() - t0 < 90000) {
    try { fs.mkdirSync(lock); mine = true; break; } catch (e) {
      if (!e || e.code !== 'EEXIST') break;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(lock); continue; } } catch { /* lo sacó otro */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  if (!mine) try { logLine({ event: 'lock-timeout' }); } catch { /* sin registro */ }
  try { return fn(); } finally { if (mine) try { fs.rmdirSync(lock); } catch { /* ya no está */ } }
}
function killPid(pid) {
  if (!pid || pid === process.pid) return;
  try { process.kill(pid); } catch { /* ya no está */ }
}

/** Cierra la espera de una sesión: una línea en el registro, fuera de la lista, y su proceso del plazo, muerto. */
function closeWait(sid, result, extra = {}) {
  const w = readWait(sid);
  if (!w) return false;
  // avisada, su proceso ya terminó: el pid puede ser de otro. Mandando, no se lo corta: el aviso saldría sin anotar
  // (el proceso, al terminar, ve la espera cerrada y deja la línea notified-after-close)
  if (!w.notified && !w.sending) killPid(w.pid);
  // la línea primero: si lo que sigue falla, la espera igual quedó anotada; y si la línea no se puede escribir, la
  // espera se cierra igual (si no, la siguiente de la sesión ni se abría)
  try {
    logLine({
      session: sid, story: w.story, step: w.stepName, startedAt: w.openedAt, notified: !!w.notified,
      ...(w.notifiedAt ? { notifiedAt: w.notifiedAt } : {}), result,
      ...(result === 'answered' ? { returnedAt: new Date().toISOString() } : {}), ...extra,
    });
  } catch { /* el registro no se pudo escribir: se sigue */ }
  try { fs.unlinkSync(waitPath(sid)); } catch { /* ya no está */ }
  if (w.notified) withSharedLock(() => dropFromShared(sid));
  return true;
}

/** Las esperas de más de 12 horas salen con `stale`. */
function sweepStale() {
  let names = [];
  try { names = fs.readdirSync(dirs().waits).filter((n) => n.endsWith('.json')); } catch { return; }
  for (const n of names) {
    const w = readJson(path.join(dirs().waits, n));
    if (!w || !w.session) continue;
    const t = Date.parse(w.openedAt);
    if (Number.isFinite(t) && Date.now() - t > STALE_MS) closeWait(w.session, 'stale');
  }
}

function timerSpawnOptions({ env = process.env } = {}) {
  // como `detach` de scripts/hooks/harness-startup.js: sin windowsHide, en Windows cada lanzamiento abre una ventana
  return { detached: true, stdio: 'ignore', env, windowsHide: true };
}

/** Abre (o reemplaza) la espera de la sesión y lanza su proceso del plazo. */
function openWait(sid, tp, kind, waiting) {
  const marker = readMarker(sid);
  if (!marker || !marker.storyId) return;
  const step = currentStep(marker);
  if (!step) return;
  sweepStale();
  if (readWait(sid)) closeWait(sid, 'kept-working');   // un cierre nuevo de la misma sesión: el agente siguió
  if (step.unknown) logLine({ session: sid, event: 'unknown-step', step: step.id });
  const plazo = thresholdMs({});
  if (plazo.problem) logLine({ session: sid, event: 'config-problem', problem: plazo.problem });   // usa 5 min, y lo dice
  const linea = marker.needs_human && marker.escalation_reason ? String(marker.escalation_reason) : waiting;
  const { records, prompts } = countRecords(tp);
  const wait = {
    session: sid, story: String(marker.storyId), step: step.id, stepName: step.name, kind, waiting: String(linea || '').slice(0, 2000),
    openedAt: new Date().toISOString(), records, prompts, transcript: tp || null, pid: null, notified: false,
  };
  writeJsonAtomic(waitPath(sid), wait);
  const child = spawn(process.execPath, [__filename, '--timer', sid, wait.openedAt], timerSpawnOptions({}));
  child.unref();
  writeJsonAtomic(waitPath(sid), { ...wait, pid: child.pid });
}

/**
 * Por dónde avisa esta máquina: `{ ok, channels, mail, chat }`. Los canales que eligió la organización en el perfil; sin
 * la lista, Telegram si está prendido en la máquina (lo de siempre). `ok: false` es una configuración que no se lee.
 */
function channels() {
  const N = require(NOTIFY);
  const s = N.canalesDeLaSesion({ env: process.env, home: home() });
  if (s.problema) return { ok: false, channels: [] };
  if (s.origen === 'antes') {
    const tg = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js')).integracionParaHook('telegram', { env: process.env, home: home() });
    if (!tg.ok) return { ok: false, channels: [] };
    if (!tg.prendida) return { ok: true, channels: [] };
  }
  return { ok: true, channels: s.canales, mail: s.mail, chat: s.chat };
}

/** El proceso del plazo: duerme, mira si la espera sigue igual y, si corresponde, avisa. */
function timer(sid, openedAt) {
  const { ms } = thresholdMs({});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const w = readWait(sid);
  if (!w || w.openedAt !== openedAt) return;          // ya se cerró o la reemplazó otra
  const now = countRecords(w.transcript);
  if (now.prompts > w.prompts) { closeWait(sid, 'answered'); return; }
  if (now.records > w.records) { closeWait(sid, 'kept-working'); return; }
  let mtime = 0;
  try { mtime = fs.statSync(w.transcript).mtimeMs; } catch { mtime = 0; }
  if (!mtime || Date.now() - mtime > ms + ALIVE_MARGIN_MS) { closeWait(sid, 'session-ended'); return; }
  if (backgroundPending(w.transcript)) { closeWait(sid, 'kept-working', { reason: 'background-task' }); return; }

  const via = channels();
  if (!via.ok) { closeWait(sid, 'config-error'); return; }
  if (!via.channels.length) { closeWait(sid, 'no-channel'); return; }
  const N = require(NOTIFY);
  const send = { lado: 'sesion', mail: via.mail, chat: via.chat };
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';

  const why = (motivos) => oneLine(motivos.join(' · ') || 'sin motivo', botToken);
  let after = null;   // lo que hay que cerrar, fuera del candado (closeWait también lo toma)
  withSharedLock(() => {
    const shared = readShared();
    const others = shared.sessions.filter((s) => s !== sid).map((s) => readWait(s)).filter((x) => x && x.notified);
    const entries = [...others, w].map((x) => ({ story: x.story, step: x.step, waiting: x.waiting }));
    const text = buildMessage(entries, { botToken });

    // el ensayo de cada canal: los que no pueden mandar (sin bot, sin credencial) no se intentan
    const dry = via.channels.map((canal) => ({ canal, e: N.ensayo({ canal, texto: text, ...send }) }));
    const ready = dry.filter((x) => x.e.codigo === 0).map((x) => x.canal);
    if (!ready.length) { after = ['no-channel', { reason: why(dry.map((x) => `${x.canal}: ${x.e.error}`)) }]; return; }
    const pre = readWait(sid);
    if (pre && pre.openedAt === openedAt) writeJsonAtomic(waitPath(sid), { ...pre, sending: true });   // que nadie lo corte mandando
    // un intento por canal: este aviso no reintenta (la espera puede cerrarse mientras tanto)
    const real = N.avisar({ canales: ready, texto: text, ...send, reintentar: false });
    const failed = real.resultados.filter((x) => !x.entregado).map((x) => `${x.canal}: ${x.motivo}`);
    if (!real.resultados.some((x) => x.entregado)) {
      const cur0 = readWait(sid);
      if (cur0 && cur0.openedAt === openedAt) writeJsonAtomic(waitPath(sid), { ...cur0, sending: false });
      after = ['failed', { reason: why(failed) }];
      return;
    }
    if (failed.length) logLine({ session: sid, event: 'channel-failed', reason: why(failed) });
    const tgResult = real.resultados.find((x) => x.canal === 'telegram' && x.entregado) || null;
    const notifiedAt = new Date().toISOString();
    try { afterSend(); } catch (e) {
      // el aviso salió: que quede anotado aunque lo que sigue falle
      try { logLine({ session: sid, story: w.story, step: w.stepName, event: 'post-send-error', notifiedAt, reason: oneLine(String((e && e.message) || e), botToken) }); } catch { /* sin registro */ }
    }
    return;
    function afterSend() {
    // sólo Telegram edita: el aviso anterior se reescribe para que no queden dos con las mismas esperas
    const messageId = tgResult && tgResult.message_id !== null ? String(tgResult.message_id) : '';
    if (tgResult && !/^\d+$/.test(messageId)) logLine({ session: sid, event: 'message-id-unknown' });

    if (tgResult && shared.messageId && others.length) {
      const ed = N.entregar({ canal: 'telegram', texto: '⏳ Esperas actualizadas: ver el mensaje siguiente.', editarId: String(shared.messageId), ...send, reintentar: false, nuevoSiNoEdita: false });
      if (!ed.entregado) logLine({ session: sid, event: 'edit-failed', reason: why([ed.motivo]) });
    }
    writeJsonAtomic(dirs().shared, { messageId: /^\d+$/.test(messageId) ? Number(messageId) : null, sessions: [...others.map((x) => x.session), sid] });
    const cur = readWait(sid);
    // el proceso del plazo termina acá: su pid ya no se guarda (otro proceso puede reusarlo)
    if (cur && cur.openedAt === openedAt) writeJsonAtomic(waitPath(sid), { ...cur, notified: true, notifiedAt, pid: null, sending: false });
    else logLine({ session: sid, story: w.story, step: w.stepName, event: 'notified-after-close', notifiedAt });
    }
  });
  if (after) closeWait(sid, ...after);
}

// ── las entradas ─────────────────────────────────────────────────────────────────────────────────────────────────
function questionLine(toolName, input = {}) {
  if (toolName === 'AskUserQuestion') {
    const q = Array.isArray(input.questions) && input.questions[0];
    return (q && q.question) || 'una pregunta de opciones';
  }
  if (toolName === 'ExitPlanMode') return `aprobar el plan${usefulLines(input.plan)[0] ? `: ${usefulLines(input.plan)[0]}` : ''}`;
  return input.question || input.prompt || input.message || input.text || 'una pregunta por voz';
}

function handle(d) {
  const sid = d.session_id;
  if (!sid) return;
  const ev = d.hook_event_name;
  const tp = d.transcript_path;
  if (ev === 'Stop') return openWait(sid, tp, 'stop', lastAgentLine(tp));
  if (ev === 'PreToolUse' && WAIT_TOOLS.has(d.tool_name)) return openWait(sid, tp, 'question', questionLine(d.tool_name, d.tool_input || {}));
  if (ev === 'Notification') {
    if (d.notification_type && d.notification_type !== 'permission_prompt') return;
    const m = /permission to use ([\w.:-]+)/i.exec(String(d.message || ''));
    return openWait(sid, tp, 'permission', `permiso para ${m ? m[1] : 'una herramienta'}`);
  }
  if (ev === 'UserPromptSubmit') return closeWait(sid, 'answered');
  if (ev === 'PostToolUse' && WAIT_TOOLS.has(d.tool_name)) return closeWait(sid, 'answered');
  if (ev === 'SessionEnd') return closeWait(sid, 'session-ended');
}

/**
 * La pregunta a la persona con «Hallazgos» abierto es el arranque de su espera: se anota en el marcador de la ejecución
 * (una sola vez), con o sin Telegram. Es una medición del tiempo de la ejecución, no un aviso.
 */
function noteFindingsWait(sid) {
  const m = readMarker(sid);
  if (!m) return false;
  let steps;
  // sin la tabla, o sin poder escribir el marcador, la espera queda sin medir: se dice en el registro, sin frenar
  try { steps = require(path.join(SKILL_LIB, 'steps.js')); } catch (e) {
    try { logLine({ session: sid, event: 'findings-wait-not-noted', reason: `lib/steps.js no carga (${e.code || e.name || 'error'})` }); } catch { /* sin registro tampoco */ }
    return false;
  }
  if (!steps.noteFindingsWait(m, new Date().toISOString())) return false;
  const file = path.join(dirs().active, `${safeSid(sid)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { logLine({ session: sid, event: 'findings-wait-not-noted', reason: `no pude escribir el marcador (${e.code || 'error'})` }); } catch { /* sin registro tampoco */ }
    return false;
  }
  return true;
}

module.exports = { WAIT_TOOLS, stepLabel, currentStep, buildMessage, thresholdMs, timerSpawnOptions, countRecords, isGenuineUserPrompt, backgroundPending, noteFindingsWait };

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    let d = null;
    if (args[0] !== '--timer') {
      let payload = '';
      try { payload = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
      d = JSON.parse(payload || '{}');
      if (d.hook_event_name === 'PreToolUse' && WAIT_TOOLS.has(d.tool_name) && d.session_id) {
        try { noteFindingsWait(d.session_id); } catch { /* la medición no frena la pregunta */ }
      }
    }
    if (process.env.TYCON_WAIT_NOTICE === '0') process.exit(0);
    // sin ningún canal por donde avisar, nada: ni archivos ni procesos
    const tg = channels();
    if (args[0] === '--timer') {
      timer(args[1], args[2]);
    } else {
      if (!tg.ok) { if (d.hook_event_name === 'Stop' && readMarker(d.session_id)) logLine({ session: d.session_id, result: 'config-error' }); process.exit(0); }
      if (!tg.channels.length) process.exit(0);
      handle(d);
    }
  } catch { /* fail-open: nunca rompe un cierre ni una pregunta */ }
  process.exit(0);
}
