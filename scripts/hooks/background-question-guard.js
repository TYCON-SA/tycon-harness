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
 * Lo que no se puede leer queda en `<estado>/hook-errors.log`. Si la sesión es de fondo y no se pudo leer el registro de
 * las lanzadas, ante la duda niega; si ni siquiera se sabe si es de fondo, deja pasar: negar por un error frenaría a las
 * sesiones que abre la persona. Codex no abre sesiones de fondo: no hay gancho del lado Codex. Off: TYCON_BG_QUESTION_GUARD=0.
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

/** ¿La firma sólo la aprueba un click en la pestaña que trabaja? Sin la lista de firmas, no, y queda anotado. */
function esSoloClick(home, firma) {
  try { return !!((require('../lib/signatures.js').SIGNATURES.find((s) => s.id === firma) || {}).soloClick); } catch (e) {
    logError(home, `no pude leer la lista de firmas (${(e && e.message) || e}): «${firma}» se trató como una firma más`);
    return false;
  }
}

/**
 * La negativa: a quién mandarle la pregunta y qué. `firma`: el id del sello, si la pregunta trae uno; `soloClick`, si esa
 * firma sólo la aprueba un click en la pestaña que trabaja; `duda`: no se pudo leer el registro de las lanzadas.
 */
function textoDeLaNegativa({ nombre, sid, firma = null, soloClick = false, duda = false }) {
  const partes = [
    duda
      ? `No pude leer qué sesiones abrió la coordinadora, y ésta es de fondo: ante la duda, no le preguntes a la persona. Mandale a «${nombre}» (${sid}) por SendMessage la pregunta tal cual,`
      : `Esta sesión la abrió la coordinadora: no le preguntes a la persona. Mandale a «${nombre}» (${sid}) por SendMessage la pregunta tal cual,`,
    'lo que se decide en tres renglones (el plan, si es un plan) y la ruta del archivo. Esperá su aviso.',
  ];
  if (firma && soloClick) partes.push('Es una firma que sólo aprueba un click en la pestaña que trabaja: no se aprueba desde la pestaña de la coordinadora. Queda la terminal del dueño, y eso es lo que le pasás.');
  else if (firma) partes.push('Es una pregunta de firma: va tal cual, sin cambiarle una letra; la coordinadora la muestra en su pestaña, y con el click repetís el comando acá.');
  return partes.join(' ');
}

/**
 * A quién va una pregunta de la sesión `sid`: `{ name, sid, duda }` de la coordinadora si la pregunta no le llega a la
 * persona, o null si pregunta como siempre. No le llega si la sesión la abrió `open`, o si es de fondo y no se pudo leer
 * el registro de las lanzadas (`duda`), con una coordinadora confirmada y viva que no es ella. Lo que no se pudo leer
 * queda en hook-errors.log; sin poder saber si es de fondo, pregunta. La usan este freno y el de firmas (owner-window.js).
 */
function coordinadoraDeLaLanzada({ home = os.homedir(), sid, env, arnes }) {
  try {
    const sl = require('../lib/signature-list.js');
    const s = sl.sesiones(home);
    // la misma confirmación que la lista de firmas, con el perfil del árbol `arnes` (en las pruebas, uno de juguete)
    const confirmada = require('../lib/owner-approvals.js').coordinadoraConfirmada(home, { env, arnes });
    const coord = confirmada && sl.vive(s, confirmada) === true ? confirmada : null;
    if (!coord || coord === sid) return null;
    const lanzada = require('../tools/coordination.js').launchedBy({ home, sid });
    if (lanzada.problem) {
      logError(home, `no pude saber si ${sid} la abrió la coordinadora (${lanzada.problem}): ${lanzada.background ? 'es de fondo, la frené' : 'la dejé preguntar'}`);
      if (!lanzada.background) return null;
    } else if (!lanzada.launched) return null;
    const c = s.mapa.get(coord);
    return { name: (c && c.name) || 'la coordinadora', sid: coord, duda: !!lanzada.problem };
  } catch (e) {
    logError(home, `${(e && e.message) || e}: dejé preguntar a ${sid}`);
    return null;
  }
}

/**
 * Lo que decide el freno: null (pasa) o `{ decision: 'deny', reason }`. `home`, `env` y `arnes` (el árbol con el perfil del equipo) se pasan en las pruebas.
 */
function decidir(evento, { home = os.homedir(), env = process.env, arnes } = {}) {
  const d = evento && typeof evento === 'object' ? evento : {};
  if (env.TYCON_BG_QUESTION_GUARD === '0') return null;
  if (d.hook_event_name && d.hook_event_name !== 'PreToolUse') return null;
  if (!QUESTION_TOOLS.has(d.tool_name)) return null;
  const sid = d.session_id;
  if (!sid || !/^[\w-]+$/.test(String(sid))) return null;
  const c = coordinadoraDeLaLanzada({ home, sid, env, arnes });
  if (!c) return null;
  const m = SELLO.exec(textoDe(d.tool_input));
  const firma = m ? m[1] : null;
  return { decision: 'deny', reason: textoDeLaNegativa({ nombre: c.name, sid: c.sid, firma, soloClick: firma ? esSoloClick(home, firma) : false, duda: c.duda }) };
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
