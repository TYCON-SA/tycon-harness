/**
 * story-claim-check.js — no se cierra el turno diciendo «creé la historia» si la historia no quedó escrita.
 *
 * El caso: un modelo corrió tycon-create-story, relevó el código, mandó la escritura del archivo como si fuera un
 * comando de la terminal («Write {…}» por Bash), la escritura falló y aun así cerró con «He creado la historia».
 * Nadie lo ve hasta que busca el archivo.
 *
 * Cuándo actúa: en una sesión con la constancia de la skill que crea historias (la deja on-skill-invoke.js) o, sin ella,
 * con un marcador activo (Codex no tiene evento de skill), si el último mensaje del turno dice que creó o escribió una
 * historia. El mensaje sale del evento de cierre; la conversación, si se puede leer, sólo suma. Pasa si una escritura
 * del turno, un `.md` del registro de ediciones, la historia del marcador o un `.md` que el mensaje nombra existe y
 * declara `story:`. Si no, frena el cierre UNA vez (Claude Code avisa `stop_hook_active` en el cierre siguiente) con lo
 * que falta.
 *
 * Además (`insistir`): si la sesión dejó una historia en borrador sin la constancia del validador, el cierre le da al
 * agente la orden concreta, hasta un tope, y después se lo dice a la persona. Un «creada y verificada» con ese borrador
 * suma la aclaración de que no está verificada.
 *
 * Fuera de alcance, declarado: una historia escrita por la terminal no va al registro de ediciones; pasa sólo si el
 * mensaje la nombra o es la del marcador.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CLAIM = new RegExp([
  String.raw`\b(he creado|cre[ée]|escrib[íi]|dej[ée] (creada|escrita))\b[^.\n]{0,40}\b(historia|story)\b`,
  String.raw`\b(historia|story)\b[^.\n]{0,40}\b(creada|escrita|qued[óo] (creada|escrita)|created|written)\b`,
  String.raw`\b(created|wrote) (the|a|your) (new )?story\b`,
].join('|'), 'i');

/** ¿Alguna oración afirma que la historia quedó creada? Una que niega («NO quedó escrita») no cuenta. */
function claims(text) {
  return String(text).split(/(?<=[.!?\n])\s+/).some((s) => CLAIM.test(s) && !/\b(no|not|nunca|never|sin)\b/i.test(s));
}

/** Los registros del transcript, o null si no se puede leer: «no pude mirar» deja cerrar, no se toma por «no escribió». */
function readTranscript(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return null; }
}

const contentOf = (r) => (r && r.message && Array.isArray(r.message.content) ? r.message.content : []);

/** Los registros del último turno: desde el último mensaje de la persona que no es el resultado de una herramienta. */
function lastTurn(records) {
  let start = 0;
  records.forEach((r, i) => {
    if (r.type !== 'user') return;
    const c = r.message && r.message.content;
    if (typeof c === 'string' || (Array.isArray(c) && c.some((b) => b.type === 'text'))) start = i;
  });
  return records.slice(start);
}

function lastAssistantText(turn) {
  for (let i = turn.length - 1; i >= 0; i--) {
    if (turn[i].type !== 'assistant') continue;
    const t = contentOf(turn[i]).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (t.trim()) return t;
  }
  return '';
}

/** ¿Hay en el turno una escritura de un `.md` que no falló y cuyo archivo existe y es una historia? */
function wroteMarkdown(turn, cwd) {
  const failed = new Set();
  for (const r of turn) for (const b of contentOf(r)) if (b.type === 'tool_result' && b.is_error) failed.add(b.tool_use_id);
  for (const r of turn) {
    for (const b of contentOf(r)) {
      if (b.type !== 'tool_use' || !['Write', 'Edit', 'MultiEdit'].includes(b.name) || failed.has(b.id)) continue;
      const f = b.input && b.input.file_path;
      if (f && /\.md$/i.test(f) && declaresStory(path.resolve(cwd, f))) return true;
    }
  }
  return false;
}

/** Las rutas `.md` que nombra el mensaje. */
function mentionedMarkdown(text) {
  return [...new Set((text.match(/[\w./~-]*[\w-]+\.md\b/g) || []).map((s) => s.replace(/^`|`$/g, '')))];
}

// Un archivo nombrado que existe y no se puede leer cuenta como historia: no se frena por lo que no se pudo mirar.
const declaresStory = (abs) => {
  try { return /^---[\s\S]*?^story\s*:/m.test(fs.readFileSync(abs, 'utf8').slice(0, 4000)); } catch (e) { return e.code !== 'ENOENT' && e.code !== 'ENOTDIR'; }
};

/** Los `.md` que el registro de ediciones del arnés anotó en la sesión (Write/Edit; lo de la terminal no va ahí). */
function editedMarkdown(stateDir, sessionId, since) {
  if (!stateDir || !sessionId) return [];
  try {
    const file = path.join(stateDir, 'file-events', `${safeSid(sessionId)}.jsonl`);
    const out = new Set();
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      try {
        const e = JSON.parse(l);
        // sólo lo de este turno: una historia escrita en un turno anterior no respalda la afirmación de ahora
        if (e && typeof e.path === 'string' && /\.md$/i.test(e.path) && String(e.ts || '') > since) out.add(e.path);
      } catch { /* línea partida */ }
    }
    return [...out];
  } catch { return []; }
}

const safeSid = (sid) => String(sid).replace(/[/\\]/g, '_');
const lastStopFile = (stateDir, sessionId) => path.join(stateDir, 'last-stop', `${safeSid(sessionId)}.txt`);

/** La hora del cierre de turno anterior de la sesión (el inicio de este turno), o null si no hubo. */
function lastStop(stateDir, sessionId) {
  if (!stateDir || !sessionId) return null;
  try { return fs.readFileSync(lastStopFile(stateDir, sessionId), 'utf8').trim() || null; } catch { return null; }
}

/** Anota la hora de este cierre de turno: el comienzo del turno siguiente para el registro de ediciones. */
function noteStop(stateDir, sessionId, ts = new Date().toISOString()) {
  if (!stateDir || !sessionId) return;
  try {
    fs.mkdirSync(path.dirname(lastStopFile(stateDir, sessionId)), { recursive: true });
    fs.writeFileSync(lastStopFile(stateDir, sessionId), ts);
  } catch { /* sin la hora, el turno siguiente sin conversación no usa el registro de ediciones */ }
}

/**
 * El motivo para no cerrar, o null. `event` es la entrada del cierre (Claude Code o Codex). Actúa con la constancia de
 * la skill que crea historias (`hasMark`) o, sin ella, con un marcador activo de la sesión (`marker`): Codex no tiene
 * evento de skill.
 *
 * La afirmación sale del último mensaje que trae el evento (`last_assistant_message`, las dos herramientas) o, si no
 * viene, de la conversación. Lo que decide es el disco: pasa si una escritura del turno (en la conversación), un `.md`
 * del registro de ediciones, la historia del marcador o un `.md` que el mensaje nombra existe y declara `story:`. Sin
 * mensaje y sin conversación no se frena: queda «no medido». `log` recibe el resultado y de qué evidencia salió.
 */
function claimWithoutStory(event, { hasMark, marker = null, stateDir = null, sessionId = null, log = () => {} }) {
  if (!event || event.stop_hook_active || (!hasMark && !marker)) return null;
  const cwd = event.cwd || process.cwd();
  const records = readTranscript(event.transcript_path);
  const turn = records ? lastTurn(records) : [];
  const evidence = [];
  let text = '';
  if (typeof event.last_assistant_message === 'string' && event.last_assistant_message.trim()) {
    text = event.last_assistant_message;
    evidence.push('mensaje-del-evento');
  } else if (records) {
    text = lastAssistantText(turn);
    evidence.push('conversacion');
  }
  if (!text) {
    log({ status: 'no-medido', evidence, reason: 'ni mensaje en el evento ni conversación legible' });
    return null;
  }
  if (!claims(text)) return null;
  const pasa = (fuente) => { log({ status: 'verde', evidence: [...evidence, fuente] }); return null; };
  const abs = (f) => path.resolve(cwd, String(f).replace(/^~(?=\/)/, process.env.HOME || ''));
  if (records) {
    // con la conversación legible decide como siempre: las escrituras de ESTE turno, o una historia que el mensaje nombra
    if (wroteMarkdown(turn, cwd)) return pasa('conversacion');
  } else {
    // sin conversación (Codex): lo que el registro de ediciones anotó desde el cierre de turno anterior, o la historia
    // del marcador
    const since = lastStop(stateDir, sessionId);
    if (since && editedMarkdown(stateDir, sessionId, since).some((f) => declaresStory(abs(f)))) return pasa('registro-de-ediciones');
    if (marker && marker.storyPath && declaresStory(abs(marker.storyPath))) return pasa('marcador');
  }
  const named = mentionedMarkdown(text);
  if (named.some((f) => declaresStory(abs(f)))) return pasa('mensaje-nombra');
  log({ status: 'bloqueo', evidence: [...evidence, ...(marker ? ['marcador'] : []), 'disco'] });
  return [
    '⛔ Dijiste que la historia quedó creada, pero en este turno no se escribió ningún archivo de historia' +
      (named.length ? ` y ${named.join(', ')} no existe o no es una historia.` : '.'),
    '   Escribila con la tool Write (no por la terminal) en la carpeta que te dio la skill, y confirmá que el archivo existe.',
    '   Si no se pudo escribir, decilo así: «la historia NO quedó escrita», con el motivo.',
  ].join('\n');
}

// ── El borrador sin validar ──────────────────────────────────────────────────────────────────────────────────────────
// Una historia nueva sin la constancia del validador sólo se escribe en borrador (story-skill-gate.js). Si el agente
// cierra el turno con un borrador de la sesión sin validar, el cierre le da la orden concreta, una por historia. Tope:
// INSIST_MAX vueltas por historia, o dos cierres seguidos sin ninguna constancia nueva del validador; ahí deja cerrar y
// se lo dice a la persona en llano. El conteo vive en la carpeta de estado del arnés, donde el agente no escribe.
const INSIST_MAX = 3;
const INSIST_DIR = 'story-insist';

/** Los registros que cuentan de la conversación del cierre (la cadena y las respuestas que cuelgan de ella), o null. */
function chainRecords(event, home) {
  const vr = require('./validator-record.js');
  const records = event.transcript_path ? readTranscript(event.transcript_path) : null;
  if (records) return vr.conRespuestas(records);
  const conv = require('./person-ok.js').leerConversacion({ home, sesion: event.session_id });
  return conv.legible ? vr.conRespuestas(conv.registros) : null;
}

/** Los `.md` que la sesión escribió: con Write/Edit, o por la terminal (un heredoc, el guion sin BMAD). */
function writtenMarkdown(records, cwd) {
  const vr = require('./validator-record.js');
  const results = new Map();
  for (const r of records) for (const b of contentOf(r)) if (b.type === 'tool_result') results.set(b.tool_use_id, b);
  const out = [];
  for (const r of records) {
    for (const b of contentOf(r)) {
      if (b.type !== 'tool_use') continue;
      const res = results.get(b.id);
      if (!res || res.is_error) continue;
      const files = ['Write', 'Edit', 'MultiEdit'].includes(b.name) ? [b.input && b.input.file_path]
        : b.name === 'Bash' ? vr.escritosPorTerminal(b.input && b.input.command, r.cwd || cwd, typeof res.content === 'string' ? res.content
          : (Array.isArray(res.content) ? res.content.map((x) => (x && x.text) || '').join('\n') : ''))
          : [];
      for (const f of files) if (f && /\.md$/i.test(f)) out.push(path.resolve(r.cwd || cwd, f));
    }
  }
  return [...new Set(out)];
}

/**
 * Las historias que la sesión escribió, que en disco siguen en borrador y no tienen la constancia, en repos que trabajan
 * con el arnés y no apagaron el freno. `note(kind, reason, file)` anota lo que no se pudo mirar.
 */
function pendingDrafts(records, { cwd, home, note = () => {} }) {
  const vr = require('./validator-record.js');
  const { statusOf, isDraftStatus } = require('./story-skill-gate.js');
  const sgio = require('./story-gate-io.js');
  let declares = (t) => /^---[ \t]*\r?\n[\s\S]*?^story[ \t]*:[\s\S]*?\r?\n---/m.test(t);
  try { ({ declaresStoryIdentity: declares } = require('./story-discovery.js')); } catch (e) {
    note('unknown-reader', `no cargó el lector de historias; uso el criterio de respaldo (${e.message})`);
  }
  const out = [];
  for (const abs of writtenMarkdown(records, cwd)) {
    try {
      let text = null;
      try { text = fs.readFileSync(abs, 'utf8'); } catch (e) {
        if (e.code !== 'ENOENT') note('unknown-unreadable', `no pude leer el borrador (${e.code || e.message})`, abs);
        continue;
      }
      if (!declares(text.replace(/^﻿/, '')) || !isDraftStatus(statusOf(text))) continue;
      if (sgio.isHarnessRepo(abs)) continue;
      const repo = sgio.repoContext(abs);
      if (!repo.repoRoot || !(repo.repoHasTycon || repo.repoHasStories)) continue;
      if (!sgio.gateEnabledForRepo(repo.repoRoot, 'story_skill_gate')) continue;
      if (!vr.enRegistros(records, { ruta: abs, repoRoot: repo.repoRoot, home }).hay) out.push(abs);
    } catch (e) {
      // un archivo que falla no esconde a los demás
      note('unknown-error', `no pude decidir sobre el borrador (${e.message})`, abs);
    }
  }
  return out;
}

function insistFile(stateDir, sessionId) {
  return path.join(stateDir, INSIST_DIR, `${String(sessionId || '_nosession').replace(/[/\\]/g, '_')}.json`);
}

/**
 * El cierre con borradores sin validar: `{ block }` (la orden, el turno no cierra), `{ aviso }` (deja cerrar y se lo
 * dice a la persona) o null. Corre aunque Claude Code marque `stop_hook_active`: el tope es el freno del lazo. Lo que no
 * se pudo mirar deja cerrar y queda anotado en gates.log (`unknown-*`).
 *
 * Límite asumido: al cierre no hay un pedido que haga de punta de la cadena, así que es el último registro. Un renglón
 * agregado al final, encadenado al último real, entra; con él se puede callar esta insistencia, no el freno de escritura
 * ni el arranque del pipeline, que siguen negando el borrador.
 */
function insistir(event, { stateDir, home = require('os').homedir(), env = process.env } = {}) {
  if (!event || !stateDir) return null;
  // el mismo apagado del dev que el freno de historia: sin el freno, no hay borradores que insistir
  if (String(env.TYCON_STORY_SKILL_GATE || '').toLowerCase() === 'off') return null;
  const sgio = require('./story-gate-io.js');
  const note = (kind, reason, file) => {
    try { sgio.appendLog(stateDir, 'gates.log', event.session_id, { repoPath: null, name: 'story-claim-check', status: 'unknown', kind, reason, ...(file ? { file } : {}) }); } catch { /* el registro no traba el cierre */ }
  };
  const records = chainRecords(event, home);
  if (!records) { note('unknown-no-conversation', 'no pude leer la conversación del cierre'); return null; }
  const cwd = event.cwd || process.cwd();
  const file = insistFile(stateDir, event.session_id);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') note('unknown-counter', `el conteo de vueltas no se pudo leer y arranca de cero (${e.code || e.message})`);
    state = {};
  }
  const stories = state.stories || {};
  const pending = pendingDrafts(records, { cwd, home, note }).filter((f) => !(stories[f] && stories[f].avisada));
  if (!pending.length) return null;
  // el avance se cuenta por historia: cuántas respuestas del validador había en su cierre anterior
  const n = require('./validator-record.js').respuestasDelValidador(records);
  const agotadas = [];
  const siguen = [];
  for (const f of pending) {
    const s = stories[f] || {};
    const sinAvance = typeof s.ultimas === 'number' && n <= s.ultimas ? (s.sinAvance || 0) + 1 : 0;
    if (sinAvance >= 2 || (s.intentos || 0) >= INSIST_MAX) { agotadas.push(f); stories[f] = { ...s, avisada: true }; }
    else { siguen.push(f); stories[f] = { intentos: (s.intentos || 0) + 1, ultimas: n, sinAvance }; }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ stories }, null, 2));
  } catch (e) {
    // sin dónde contar no se insiste (sería un lazo sin tope): deja cerrar y queda anotado
    note('unknown-counter', `no pude guardar el conteo de vueltas (${e.code || e.message})`);
    return null;
  }
  const aviso = agotadas.length
    ? agotadas.map((f) => `La historia ${f} quedó en borrador porque no se validó: el agente no corrió el validador.`).join('\n')
    : null;
  if (!siguen.length) return { aviso };
  const text = typeof event.last_assistant_message === 'string' && event.last_assistant_message.trim()
    ? event.last_assistant_message : lastAssistantText(lastTurn(records));
  const verified = claims(text) || /\bverificad[ao]\b/i.test(text);
  return {
    block: [
      ...siguen.map((f) => `⛔ falta validar ${f}: corré el validador de historias (tycon-story-validator) sobre ese archivo y, si pasa, pasala a ready-for-dev.`),
      verified ? '   No digas que la historia quedó creada y verificada: está en borrador y no está verificada hasta que corra el validador.' : '',
      `   (vuelta ${Math.max(...siguen.map((f) => stories[f].intentos))} de ${INSIST_MAX})`,
    ].filter(Boolean).join('\n'),
    aviso,
  };
}

module.exports = { claimWithoutStory, insistir, pendingDrafts, CLAIM, INSIST_MAX, lastTurn, noteStop, lastStop };
