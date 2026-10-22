/**
 * story-claim-check.js — no se cierra el turno diciendo «creé la historia» si la historia no quedó escrita.
 *
 * El caso: un modelo corrió tycon-create-story, relevó el código, mandó la escritura del archivo como si fuera un
 * comando de la terminal («Write {…}» por Bash), la escritura falló y aun así cerró con «He creado la historia».
 * Nadie lo ve hasta que busca el archivo.
 *
 * Cuándo actúa: en una sesión con la constancia de la skill que crea historias (la deja on-skill-invoke.js), si el
 * último mensaje del turno dice que creó o escribió una historia. Pasa si en ese turno hay una escritura de un `.md`
 * que no falló y cuyo archivo existe, o si el mensaje nombra un `.md` que existe y declara `story:`. Si no, frena el
 * cierre UNA vez (Claude Code avisa `stop_hook_active` en el cierre siguiente) con lo que falta.
 *
 * Fuera de alcance, declarado: Codex (sin evento de skill ni de cierre equivalente) y una historia escrita por Bash
 * que existe pero no se nombra en el mensaje (pasa sólo si el mensaje la nombra).
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

/**
 * El motivo para no cerrar, o null. `event` es la entrada del cierre de Claude Code; `hasMark` dice si la sesión tiene
 * la constancia de la skill que crea historias.
 */
function claimWithoutStory(event, { hasMark }) {
  if (!hasMark || !event || event.stop_hook_active) return null;
  const cwd = event.cwd || process.cwd();
  const records = readTranscript(event.transcript_path);
  if (!records) return null;
  const turn = lastTurn(records);
  const text = typeof event.last_assistant_message === 'string' && event.last_assistant_message.trim()
    ? event.last_assistant_message : lastAssistantText(turn);
  if (!claims(text)) return null;
  if (wroteMarkdown(turn, cwd)) return null;
  const named = mentionedMarkdown(text);
  if (named.some((f) => declaresStory(path.resolve(cwd, f.replace(/^~(?=\/)/, process.env.HOME || ''))))) return null;
  return [
    '⛔ Dijiste que la historia quedó creada, pero en este turno no se escribió ningún archivo de historia' +
      (named.length ? ` y ${named.join(', ')} no existe o no es una historia.` : '.'),
    '   Escribila con la tool Write (no por la terminal) en la carpeta que te dio la skill, y confirmá que el archivo existe.',
    '   Si no se pudo escribir, decilo así: «la historia NO quedó escrita», con el motivo.',
  ].join('\n');
}

module.exports = { claimWithoutStory, CLAIM, lastTurn };
