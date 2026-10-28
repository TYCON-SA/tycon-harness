/**
 * story-skill-gate-io.js — la capa con I/O del freno de story-a-mano (lógica pura y porqué en
 * `story-skill-gate.js`). La comparten el handler de Edit|Write (`on-story-skill-gate.js`), el guard
 * de Bash (`on-bash-write-gate.js`) y el escritor de la marca de la skill (`on-skill-invoke.js`): UN solo
 * cálculo para todas las puertas. La constancia que abre el freno es la del validador, leída de la conversación
 * (`validator-record.js`); la marca de la skill ya no lo abre, y la sigue usando el cierre del turno.
 *
 * Estado (bajo ~/.claude/.tycon-pipeline/):
 *   skill-marks/<sid>.json   { skill, at, sessionId, cwd, reason? } — la escribe on-skill-invoke.js
 *                            (PostToolUse Skill).
 *   gates.log                cada bloqueo (status: blocked), cada borrador que pasó con la constancia
 *                            (validated) y cada "no se frena pero se mide" (unknown).
 *   bypass.log               cada vez que la frase de la persona abrió el freno (kind: STORY_SKILL_BYPASS_USED).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const gate = require('./story-skill-gate.js');
const io = require('./story-gate-io.js');

const DEFAULT_STATE_DIR = io.DEFAULT_STATE_DIR;
const MARKS_DIR = 'skill-marks';
const MARK_PURGE_MS = 24 * 3600 * 1000; // marcas de más de un día se borran al escribir una nueva

function safeSid(sessionId) {
  return String(sessionId || '_nosession').replace(/[/\\]/g, '_');
}
function markPath(stateDir, sessionId) {
  return path.join(stateDir, MARKS_DIR, `${safeSid(sessionId)}.json`);
}
function readMark(stateDir, sessionId) {
  try { return JSON.parse(fs.readFileSync(markPath(stateDir, sessionId), 'utf8')); } catch { return null; }
}

/**
 * Escribe la marca (tmp + rename), purga las de otras sesiones con más de un día, y deja constancia
 * en gates.log (`mark-written`, con `via`: hook | slash | bypass). La línea del log existe porque la
 * marca SÍ se puede fabricar (hallazgo F6 del pase adversarial: `echo '{…Skill…}' | node
 * on-skill-invoke.js` la escribe sin invocar nada) — el freno es anti-olvido, no anti-evasión, y lo
 * mínimo es que toda marca sea auditable después.
 */
function writeMark(stateDir, sessionId, obj) {
  const file = markPath(stateDir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  purgeStaleMarks(path.dirname(file), Date.now());
  io.appendLog(stateDir, 'gates.log', sessionId, { repoPath: null, name: 'story-skill-gate', status: 'mark-written', skill: obj.skill, via: obj.via || (obj.skill === 'bypass' ? 'bypass' : 'hook'), cwd: obj.cwd || null });
  return obj;
}

/** Línea `unknown` suelta (para veredictos que decide el llamador, p.ej. rename por Bash). */
function logUnknown({ absPath, sessionId, via, stateDir = DEFAULT_STATE_DIR, kind, reason }) {
  io.appendLog(stateDir, 'gates.log', sessionId, { repoPath: null, name: 'story-skill-gate', status: 'unknown', file: String(absPath), via: via || null, kind, reason });
}

function purgeStaleMarks(dir, nowMs) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(dir, f);
    let at;
    try { at = Date.parse(JSON.parse(fs.readFileSync(p, 'utf8')).at); } catch { at = NaN; }
    if (!Number.isFinite(at) || nowMs - at > MARK_PURGE_MS) { try { fs.unlinkSync(p); } catch { /* noop */ } }
  }
}

/** ¿La herramienta que corre este hook es Codex? (payload con turn_id, o el env nativo sin el de Claude) */
function isCodexEvent(event, env = process.env) {
  if (event && typeof event.turn_id === 'string') return true;
  return !!env.CODEX_SESSION_ID && !env.CLAUDE_CODE_SESSION_ID;
}

/** El texto que queda después de un Edit: el reemplazo aplicado sobre el disco (null si no se puede calcular). */
function afterEdit(disk, edit) {
  if (typeof disk !== 'string' || !edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') return null;
  if (!edit.old_string) return null;
  return edit.replace_all ? disk.split(edit.old_string).join(edit.new_string) : disk.replace(edit.old_string, () => edit.new_string);
}

/**
 * Decide sobre UN archivo que un tool call quiere escribir.
 *
 * @param {object} p
 * @param {string}      p.absPath        destino, absoluto
 * @param {string|null} p.content        el texto que se va a escribir (Write.content / cuerpo del heredoc), o null si no se tiene
 * @param {object}      [p.edit]         (Edit) { old_string, new_string, replace_all }: el texto nuevo sale de aplicarlo al disco
 * @param {boolean}     [p.nameHint]     (puerta Bash, sin content) el nombre/carpeta sugiere story
 * @param {string}      p.sessionId
 * @param {string}      [p.via]          'Write' | 'Bash: <cmd recortado>' — mensaje/log
 * @param {object}      [p.event]        el evento crudo (detección de Codex; sesión y pedido para leer la conversación)
 * @param {string}      [p.stateDir]
 * @returns {{ verdict:{action,kind,reason}, message:string|null }}
 */
function evaluate({ absPath, content, edit, nameHint = false, sessionId, via, event, stateDir = DEFAULT_STATE_DIR, casa }) {
  const abs = String(absPath);
  const quiet = { verdict: { action: 'pass', kind: 'not-story', reason: 'no es .md' }, message: null };
  if (!/\.md$/i.test(abs)) return quiet;

  let discovery = null;
  try { discovery = require('./story-discovery.js'); } catch { discovery = null; }
  const declares = (t) => (discovery ? discovery.declaresStoryIdentity(t) : /^---[\s\S]*?^\s*story\s*:/m.test(t));

  // Camino barato: existe y no es un borrador → editar, no crear. Antes que cualquier lectura de repo.
  let existsOnDisk = false;
  try { existsOnDisk = fs.existsSync(abs); } catch { existsOnDisk = false; }
  let prevStatus = null;
  let declaredId = null;
  let isStoryCandidate = false;
  let status = null;
  if (existsOnDisk) {
    let disk = null;
    try { disk = fs.readFileSync(abs, 'utf8'); } catch (e) {
      // no se pudo leer: no se frena (el freno no traba por lo que no puede mirar), pero queda medido
      logUnknown({ absPath: abs, sessionId, via, stateDir, kind: 'unknown-unreadable', reason: `no pude leer el archivo (${e.code || e.message})` });
      return { verdict: { action: 'pass', kind: 'unknown-unreadable', reason: 'no pude leer el archivo' }, message: null };
    }
    prevStatus = declares(disk.replace(/^﻿/, '')) ? gate.statusOf(disk) : null;
    if (!gate.isDraftStatus(prevStatus)) return { verdict: { action: 'pass', kind: 'exists', reason: 'la story ya existe y no está en borrador — editar no es crear' }, message: null };
    isStoryCandidate = true;
    declaredId = discovery ? discovery.declaredStoryId(disk) : null;
    const after = typeof content === 'string' ? content : afterEdit(disk, edit);
    status = after == null ? null : gate.statusOf(after);
  } else if (typeof content === 'string' && content.length) {
    // ¿Declara identidad de story? Por contenido (canónico); por nombre sólo si no hay contenido
    // (puerta Bash con `cp`/`printf` opaco) y el llamador lo pidió.
    isStoryCandidate = declares(content);
    declaredId = discovery && isStoryCandidate ? discovery.declaredStoryId(content) : null;
    status = gate.statusOf(content);
  } else if (nameHint) {
    isStoryCandidate = true;
  }
  if (!isStoryCandidate) return quiet;

  const isHarness = io.isHarnessRepo(abs) || abs.replace(/\\/g, '/').startsWith(os.homedir().replace(/\\/g, '/') + '/.claude/');
  let repo = { repoRoot: null, repoHasTycon: false, repoHasStories: false };
  let repoUnderHarness = null;
  let idIsWork = null;
  let gateEnabled = true;
  if (!isHarness) {
    repo = io.repoContext(abs);
    repoUnderHarness = !!(repo.repoRoot && (repo.repoHasTycon || repo.repoHasStories));
    if (repo.repoRoot && discovery && declaredId) {
      let pattern = null;
      try { pattern = discovery.storiesConfigForGate(repo.repoRoot).idPattern; } catch { pattern = null; }
      idIsWork = discovery.isWorkStoryId(declaredId, pattern);
    }
    if (repoUnderHarness) gateEnabled = io.gateEnabledForRepo(repo.repoRoot, 'story_skill_gate');
  }

  const isCodex = isCodexEvent(event);
  const args = { filePath: abs, existsOnDisk, prevStatus, status, isStoryCandidate, isHarness, repoUnderHarness, idIsWork, gateEnabled, isCodex };
  let verdict = gate.computeStorySkillGate(args);
  // La constancia del validador se busca sólo cuando hace falta: leer la conversación cuesta.
  let recordNote = null;
  if (verdict.action === 'block' && !isCodex) {
    let rec = null;
    try {
      rec = require('./validator-record.js').constancia({ sesion: (event && event.session_id) || sessionId, ruta: abs, repoRoot: repo.repoRoot, pedido: event && event.tool_use_id });
    } catch (e) { recordNote = `no pude leer la constancia del validador (${e.message})`; }
    if (rec && rec.hay) verdict = gate.computeStorySkillGate({ ...args, record: true });
    else if (rec && !rec.legible) recordNote = `no pude leer la conversación (${rec.motivo})`;
  }

  // Veredicto por NOMBRE (sin contenido legible): se distingue en el log —para poder medir cuánto
  // ruido mete— y en el mensaje, que no puede afirmar "ES una story" cuando sólo lo parece (F3).
  const byName = !existsOnDisk && !(typeof content === 'string' && content.length) && nameHint;
  // Escribirla sin la skill lo decide la persona: su firma en la ventana sobre este archivo (`marker.js sign-file
  // story-skill-bypass <archivo>`, scripts/lib/owner-window.js) la deja pasar una vez, sólo por Edit o Write: por la
  // consola no se sabe con certeza a qué archivo escribe el comando.
  let firma = null;
  if (verdict.action === 'block' && !isCodex) {
    const porEdicion = !!event && ['Edit', 'Write', 'MultiEdit'].includes(event.tool_name);
    try {
      const ow = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
      firma = porEdicion ? ow.consumirArchivo({ firma: 'story-skill-bypass', sesion: event.session_id, archivo: abs, cwd: event.cwd, casa })
        : { ok: false, motivo: 'por la consola no vale: escribila con Edit o Write' };
      firma.comando = ow.comoSeFirma('story-skill-bypass', abs);
    } catch (e) { firma = { ok: false, motivo: `no pude consultar la ventana (${e.message})`, comando: `marker.js sign-file story-skill-bypass ${abs}` }; }
    if (firma.ok) {
      io.appendLog(stateDir, 'bypass.log', sessionId, { repoPath: repo.repoRoot || null, kind: 'STORY_SKILL_BYPASS_USED', file: abs, via: firma.constancia.via });
      return { verdict: { action: 'pass', kind: 'persona', reason: `la persona la firmó sin la skill (${firma.constancia.via})` }, message: null };
    }
  }
  if (verdict.action === 'block' && byName) verdict = { ...verdict, kind: `${verdict.kind}-by-name` };
  const line = { repoPath: repo.repoRoot || null, name: 'story-skill-gate', file: abs, via: via || null, kind: verdict.kind, reason: verdict.reason, storyId: declaredId };
  if (verdict.action === 'block') {
    io.appendLog(stateDir, 'gates.log', sessionId, { ...line, status: 'blocked', ...(recordNote ? { record: recordNote } : {}) });
    return { verdict, message: gate.blockMessage(verdict, { filePath: abs, via, byName, firma }) };
  }
  // "No se frena pero se mide" (trampa 5 del handoff: ante la duda no bloquear, y dejar el caso
  // registrado para poder decidir después si valía la pena).
  if (verdict.kind.startsWith('unknown')) io.appendLog(stateDir, 'gates.log', sessionId, { ...line, status: 'unknown' });
  // El paso de un borrador a otro estado con la constancia queda anotado: es lo que mide si la regla se cumple.
  if (verdict.kind === 'validated') io.appendLog(stateDir, 'gates.log', sessionId, { ...line, status: 'validated' });
  return { verdict, message: null };
}

module.exports = { DEFAULT_STATE_DIR, MARKS_DIR, markPath, readMark, writeMark, purgeStaleMarks, logUnknown, isCodexEvent, afterEdit, evaluate };
