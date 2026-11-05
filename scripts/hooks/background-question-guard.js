#!/usr/bin/env node
'use strict';
/**
 * background-question-guard.js — una sesión que abrió la coordinadora no le pregunta a la persona: la pregunta va a la
 * coordinadora, que es quien se la muestra.
 *
 *   Claude: PreToolUse de AskUserQuestion y del dictado (mcp__spokenly__ask_user_dictation). Niega si la sesión es de
 *           fondo, la abrió `coordination.js open` (su renglón en `<estado>/coordination/launched.json`) y hay una
 *           coordinadora confirmada por el dueño y viva que no es ella. El texto dice qué mandarle y a quién.
 *
 * Toda pregunta, no sólo la de firma: una pregunta libre de la sesión también le llegaba a la persona por una pestaña que
 * no mira. ExitPlanMode no: es la salida del modo plan, y negarla dejaría a la sesión encerrada ahí.
 *
 * Lo que no se puede leer deja pasar y queda en `<estado>/hook-errors.log`: negar por un error frenaría a las sesiones
 * que abre la persona. Codex no abre sesiones de fondo: no hay gancho del lado Codex. Off: TYCON_BG_QUESTION_GUARD=0.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'mcp__spokenly__ask_user_dictation']);
const SELLO = /\bfirma ([\w:.-]+) · sesi[oó]n [\w-]+ · c[oó]digo [\w-]+/;
const NOMBRE = 'background-question-guard';

const stateDirOf = (home) => require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).stateDir(home);

function logError(home, message) {
  try { fs.appendFileSync(path.join(stateDirOf(home), 'hook-errors.log'), `[${new Date().toISOString()}] ${NOMBRE}: ${message}\n\n`, 'utf8'); } catch { /* sin registro tampoco */ }
}

/** Lo que pregunta la herramienta, para reconocer el sello de una firma. */
function textoDe(input) {
  const i = input && typeof input === 'object' ? input : {};
  if (Array.isArray(i.questions)) return i.questions.map((q) => (q && q.question) || '').join(' ');
  return String(i.question || i.prompt || i.message || i.text || '');
}

/** La negativa: a quién mandarle la pregunta y qué. `firma`: el id del sello, si la pregunta trae uno. */
function textoDeLaNegativa({ nombre, sid, firma }) {
  const partes = [
    `Esta sesión la abrió la coordinadora: no le preguntes a la persona. Mandale a «${nombre}» (${sid}) por SendMessage la pregunta tal cual,`
      + ' lo que se decide en tres renglones (el plan, si es un plan) y la ruta del archivo. Esperá su aviso.',
  ];
  if (firma) {
    partes.push('Es una pregunta de firma: va tal cual, sin cambiarle una letra; la coordinadora la muestra en su pestaña, y con el click repetís el comando acá.');
    let soloClick = false;
    try { soloClick = !!((require('../lib/signatures.js').SIGNATURES.find((s) => s.id === firma) || {}).soloClick); } catch { /* sin la lista, como una firma más */ }
    if (soloClick) partes.push('Esa firma sólo la aprueba un click en la pestaña que trabaja: acá queda la terminal del dueño, y eso es lo que le pasás a la coordinadora.');
  }
  return partes.join(' ');
}

/**
 * Lo que decide el freno: null (pasa) o `{ decision: 'deny', reason }`. `home` y `env` se pasan en las pruebas.
 */
function decidir(evento, { home = os.homedir(), env = process.env } = {}) {
  const d = evento && typeof evento === 'object' ? evento : {};
  if (env.TYCON_BG_QUESTION_GUARD === '0') return null;
  if (d.hook_event_name && d.hook_event_name !== 'PreToolUse') return null;
  if (!QUESTION_TOOLS.has(d.tool_name)) return null;
  const sid = d.session_id;
  if (!sid || !/^[\w-]+$/.test(String(sid))) return null;
  try {
    const sl = require('../lib/signature-list.js');
    const s = sl.sesiones(home);
    const coord = sl.coordinadoraViva(home, s);
    if (!coord || coord === sid) return null;
    const lanzada = require('../tools/coordination.js').launchedBy({ home, sid });
    if (lanzada.problem) { logError(home, `no pude saber si ${sid} la abrió la coordinadora (${lanzada.problem}): la dejé preguntar`); return null; }
    if (!lanzada.launched) return null;
    const c = s.mapa.get(coord);
    const nombre = (c && c.name) || 'la coordinadora';
    const m = SELLO.exec(textoDe(d.tool_input));
    return { decision: 'deny', reason: textoDeLaNegativa({ nombre, sid: coord, firma: m ? m[1] : null }) };
  } catch (e) {
    logError(home, `${(e && e.message) || e}: la dejé preguntar`);
    return null;
  }
}

/**
 * La coordinadora a quien mandarle una firma de esta sesión: `{ name, sid }` si la sesión la abrió `open` y hay una
 * coordinadora confirmada y viva que no es ella; null si no, o sin el dato. Lo usa el freno de firmas (owner-window.js).
 */
function coordinadoraDeLaLanzada({ home = os.homedir(), sid }) {
  try {
    const sl = require('../lib/signature-list.js');
    const s = sl.sesiones(home);
    const coord = sl.coordinadoraViva(home, s);
    if (!coord || coord === sid) return null;
    const lanzada = require('../tools/coordination.js').launchedBy({ home, sid });
    if (!lanzada.launched) return null;
    const c = s.mapa.get(coord);
    return { name: (c && c.name) || 'la coordinadora', sid: coord };
  } catch { return null; }
}

module.exports = { QUESTION_TOOLS, decidir, textoDeLaNegativa, coordinadoraDeLaLanzada };

if (require.main === module) {
  if (process.env.TYCON_BG_QUESTION_GUARD === '0') process.exit(0);
  let d = null;
  try { d = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (e) {
    logError(os.homedir(), `la entrada del gancho no es JSON (${e.message})`);
    process.exit(0);
  }
  const r = decidir(d);
  if (r) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason } }));
  process.exit(0);
}
