/**
 * story-skill-gate-io.js — la capa con I/O del freno de story-a-mano (lógica pura y porqué en
 * `story-skill-gate.js`). La comparten el handler de Edit|Write (`on-story-skill-gate.js`), el guard
 * de Bash (`on-bash-write-gate.js`) y el escritor de la constancia (`on-skill-invoke.js` + el bypass
 * de `marker.js`): UN solo cálculo y UN solo formato de marca para todas las puertas.
 *
 * Estado (bajo ~/.claude/.tycon-pipeline/):
 *   skill-marks/<sid>.json   { skill, at, sessionId, cwd, reason? } — la escribe on-skill-invoke.js
 *                            (PostToolUse Skill) (las marcas `skill:'bypass'` de antes siguen leyéndose).
 *   gates.log                cada bloqueo (status: blocked) y cada "no se frena pero se mide" (unknown).
 *   bypass.log               cada bypass declarado (kind: STORY_SKILL_BYPASS) — lo escribe marker.js.
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
    let at = NaN;
    try { at = Date.parse(JSON.parse(fs.readFileSync(p, 'utf8')).at); } catch { at = NaN; }
    if (!Number.isFinite(at) || nowMs - at > MARK_PURGE_MS) { try { fs.unlinkSync(p); } catch { /* noop */ } }
  }
}

/** ¿La herramienta que corre este hook es Codex? (payload con turn_id, o el env nativo sin el de Claude) */
function isCodexEvent(event, env = process.env) {
  if (event && typeof event.turn_id === 'string') return true;
  return !!env.CODEX_SESSION_ID && !env.CLAUDE_CODE_SESSION_ID;
}

/**
 * Decide sobre UN archivo que un tool call quiere escribir.
 *
 * @param {object} p
 * @param {string}      p.absPath        destino, absoluto
 * @param {string|null} p.content        el texto que se va a escribir (Write.content / cuerpo del heredoc), o null si no se tiene
 * @param {boolean}     [p.nameHint]     (puerta Bash, sin content) el nombre/carpeta sugiere story
 * @param {string}      p.sessionId
 * @param {string}      [p.via]          'Write' | 'Bash: <cmd recortado>' — mensaje/log
 * @param {object}      [p.event]        el evento crudo (detección de Codex)
 * @param {string}      [p.stateDir]
 * @param {number}      [p.nowMs]
 * @returns {{ verdict:{action,kind,reason}, message:string|null }}
 */
function evaluate({ absPath, content, nameHint = false, sessionId, via, event, stateDir = DEFAULT_STATE_DIR, nowMs = Date.now() }) {
  const abs = String(absPath);
  const quiet = { verdict: { action: 'pass', kind: 'not-story', reason: 'no es .md' }, message: null };
  if (!/\.md$/i.test(abs)) return quiet;

  // Camino barato: existe → editar, no crear. Antes que cualquier lectura de contenido o repo.
  let existsOnDisk = false;
  try { existsOnDisk = fs.existsSync(abs); } catch { existsOnDisk = false; }
  if (existsOnDisk) return { verdict: { action: 'pass', kind: 'exists', reason: 'la story ya existe — editar no es crear' }, message: null };

  let discovery = null;
  try { discovery = require('./story-discovery.js'); } catch { discovery = null; }

  // ¿Declara identidad de story? Por contenido (canónico); por nombre sólo si no hay contenido
  // (puerta Bash con `cp`/`printf` opaco) y el llamador lo pidió.
  let declaredId = null;
  let isStoryCandidate = false;
  if (typeof content === 'string' && content.length) {
    isStoryCandidate = discovery ? discovery.declaresStoryIdentity(content) : /^---[\s\S]*?^\s*story\s*:/m.test(content);
    declaredId = discovery && isStoryCandidate ? discovery.declaredStoryId(content) : null;
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

  const ttlMs = gate.ttlMsFrom(process.env.TYCON_STORY_SKILL_MARK_TTL_MIN);
  const mark = readMark(stateDir, sessionId);
  let verdict = gate.computeStorySkillGate({
    filePath: abs, existsOnDisk, isStoryCandidate, isHarness, repoUnderHarness, idIsWork,
    mark, nowMs, ttlMs, gateEnabled, isCodex: isCodexEvent(event),
  });

  // Veredicto por NOMBRE (sin contenido legible): se distingue en el log —para poder medir cuánto
  // ruido mete— y en el mensaje, que no puede afirmar "ES una story" cuando sólo lo parece (F3).
  const byName = !(typeof content === 'string' && content.length) && nameHint;
  // Escribirla sin la skill lo decide la persona: «autorizo story-skill-bypass» en un turno suyo (o reenviada por la
  // sesión designada) abre el freno para este pedido. El agente no la puede escribir por ella (escape-ok.js).
  let escapeRoto = null;   // la búsqueda de la frase falló: se frena igual, y se dice por qué en el registro y el mensaje
  if (verdict.action === 'block' && !isCodexEvent(event)) {
    let ok = null;
    try {
      ok = require('./escape-ok.js').escapeAutorizado({ variable: 'story-skill-bypass', sesion: event && event.session_id, pedido: event && event.tool_use_id });
    } catch (e) { escapeRoto = `no pude buscar la frase de la persona (${e.message})`; ok = { ok: false }; }
    if (ok && ok.ok) {
      io.appendLog(stateDir, 'bypass.log', sessionId, { repoPath: repo.repoRoot || null, kind: 'STORY_SKILL_BYPASS_USED', file: abs, via: ok.via, ...(ok.relevo ? { relevo: ok.relevo } : {}) });
      return { verdict: { action: 'pass', kind: 'persona', reason: `la persona autorizó escribirla sin la skill (${ok.via})` }, message: null };
    }
  }
  if (verdict.action === 'block' && byName) verdict = { ...verdict, kind: `${verdict.kind}-by-name` };
  const line = { repoPath: repo.repoRoot || null, name: 'story-skill-gate', file: abs, via: via || null, kind: verdict.kind, reason: verdict.reason, storyId: declaredId };
  if (verdict.action === 'block') {
    io.appendLog(stateDir, 'gates.log', sessionId, { ...line, status: 'blocked', ...(escapeRoto ? { escape: escapeRoto } : {}) });
    const message = gate.blockMessage(verdict, { filePath: abs, via, ttlMs, byName });
    return { verdict, message: escapeRoto ? `${message}\n   ⚠ ${escapeRoto}: la frase de la persona no se pudo verificar.` : message };
  }
  // "No se frena pero se mide" (trampa 5 del handoff: ante la duda no bloquear, y dejar el caso
  // registrado para poder decidir después si valía la pena).
  if (verdict.kind.startsWith('unknown')) io.appendLog(stateDir, 'gates.log', sessionId, { ...line, status: 'unknown' });
  // El bypass se audita sólo cuando evitó un bloqueo real (sin esto, una línea por cada story).
  if (verdict.kind === 'bypass') io.appendLog(stateDir, 'bypass.log', sessionId, { repoPath: repo.repoRoot || null, kind: 'STORY_SKILL_BYPASS_USED', file: abs, reason: mark && mark.reason });
  return { verdict, message: null };
}

module.exports = { DEFAULT_STATE_DIR, MARKS_DIR, markPath, readMark, writeMark, purgeStaleMarks, logUnknown, isCodexEvent, evaluate };
