#!/usr/bin/env node
'use strict';
/**
 * background-question-guard.js — una sesión que abrió la coordinadora no le pregunta a la persona: la pregunta va a la
 * coordinadora, que es quien se la muestra.
 *
 *   Claude: PreToolUse de AskUserQuestion y del dictado (mcp__spokenly__ask_user_dictation). Niega si la sesión es de
 *           fondo, la abrió `coordination.js open` (su renglón en `<estado>/coordination/launched.json`) y hay una
 *           coordinadora confirmada por el dueño y viva que no es ella. El texto dice qué mandarle y a quién. La pregunta
 *           queda anotada (coordination.js questionRelay) y sale en el aviso de cada turno de la coordinadora; si la sesión
 *           repite la misma pregunta pasado `plan_review.coordinator_wait_minutes`, le llega a la persona.
 *
 * Claude: PreToolUse de Bash. En una sesión de fondo (su archivo de Claude Code dice `kind: bg`), niega el comando que
 *           haría que Claude Code le pida permiso a una persona aun sin permisos (lib/bg-permission-shapes.js: un `rm`
 *           cuyo destino no puede revisar) y dice cómo reescribirlo. Nadie contesta ese pedido de fondo, y mientras
 *           espera la sesión no lee mensajes: la negación llega como respuesta y la sesión reintenta sola. Lo que hoy
 *           pasa sin pedir, pasa; en una sesión que no es de fondo, nada cambia.
 *
 * Claude: PreToolUse de SendMessage: a una sesión de fondo que abrió `open` sólo le escribe la coordinadora. Un
 *           mensaje de otra sesión le llega retenido (otro modo de permisos) y la deja esperando un click en una pestaña
 *           que nadie mira; se niega y se manda a la coordinadora, que se lo pasa. Acá se mira el DESTINO (`tool_input.to`), no la
 *           sesión que llama, con las formas que Claude Code entrega: el nombre entero de los archivos de sesión (el
 *           recorte de la oficina confunde nombres largos) comparado como lo compara Claude Code, el id de la sesión, la
 *           dirección `uds:` o la ruta del socket, `bridge:`, y `*`, que es toda sesión viva. Con la coordinadora viva,
 *           una falla niega. A una sesión con persona delante se le escribe como siempre. Corre en la máquina de quien
 *           manda: un mensaje desde otra máquina no lo ve.
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
const MESSAGE_TOOL = 'SendMessage';
// un destino que no es otra sesión: la conversación principal o un ayudante de la propia sesión (su id)
const NOT_A_SESSION = /^(main|a[0-9a-f]{16})$/;
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

/** La negativa de un mensaje: a quién mandárselo. `duda`: no se pudo leer el registro de las lanzadas. */
function textoDeLaNegativaDelMensaje({ nombre, sid, duda = false }) {
  return [
    duda ? 'No pude leer qué sesiones abrió la coordinadora, y el destino es de fondo: ante la duda, no le escribas directo.' : null,
    'Esa sesión trabaja de fondo: mandáselo a la coordinadora, que se lo pasa.',
    `Mandale a «${nombre}» (${sid}) por SendMessage a quién va y lo que querés que le diga.`,
  ].filter(Boolean).join(' ');
}

/** Un texto ajeno en un renglón del registro: sin saltos ni caracteres de control, y corto. */
const unRenglon = (x) => String(x).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').slice(0, 200);

/** El nombre como lo compara Claude Code al entregar un mensaje: NFKC, sin control, sin espacios al borde, en minúsculas y con `-` por espacio. */
const nombreNormal = (x) => String(x).normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().toLowerCase().replace(/\s+/g, '-');

/** Una dirección de Claude Code (`uds:`, `bridge:`) viene codificada; si no se puede decodificar, se compara tal cual. */
function decodificada(x) {
  try { return decodeURIComponent(x); } catch { return x; }
}

/** Las sesiones de la máquina como las escribe Claude Code: `{ sid, name, socket, bridge, kind }` de las vivas, con el nombre entero. */
function sesionesVivas(home, problemas) {
  const dir = path.join(require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).claudeDir(home), 'sessions');
  let archivos;
  try { archivos = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (e) {
    if (e.code !== 'ENOENT') problemas.push(`${dir}: ${e.message}`);
    return [];
  }
  const out = [];
  for (const n of archivos) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (e) { problemas.push(`${n}: ${e.message}`); continue; }
    if (!s || typeof s !== 'object' || typeof s.sessionId !== 'string') continue;
    const pid = Number(s.pid);
    let viva = false;
    try { process.kill(pid, 0); viva = true; } catch (e) { viva = e.code === 'EPERM'; }
    if (!Number.isInteger(pid) || pid <= 0 || !viva) continue;
    const texto = (v) => (typeof v === 'string' ? v : null);
    out.push({ sid: s.sessionId, name: typeof s.name === 'string' ? s.name.trim() : '', socket: texto(s.messagingSocketPath), bridge: texto(s.bridgeSessionId), kind: String(s.kind || '') });
  }
  return out;
}

/**
 * Las sesiones a las que va un mensaje, con las formas que Claude Code entrega: `*` es toda viva; `uds:<ruta>` (o la ruta
 * del socket suelta) la de ese socket; `bridge:<id>` la de ese puente; el id de la sesión, ésa; si no, el nombre sin su
 * ` [ref]`, comparado como lo compara Claude Code (mayúsculas, espacios y el espacio antes de la referencia no cuentan).
 */
function destinosDe(to, vivas) {
  if (to === '*') return vivas.map((s) => s.sid);
  const uds = /^uds:(.+)$/i.exec(to);
  if (uds || to.startsWith('/') || to.startsWith('\\\\.\\pipe\\')) {
    const ruta = uds ? decodificada(uds[1]) : to;
    return vivas.filter((s) => s.socket && (s.socket === ruta || s.socket === to)).map((s) => s.sid);
  }
  const puente = /^bridge:(.+)$/i.exec(to);
  if (puente) return vivas.filter((s) => s.bridge && s.bridge === decodificada(puente[1])).map((s) => s.sid);
  const porId = vivas.filter((s) => s.sid === to);
  if (porId.length) return porId.map((s) => s.sid);
  const ref = /^(.*\S)\s*\[([0-9a-f]{6,12})\]$/i.exec(to.trim());
  const nombre = nombreNormal(ref ? ref[1] : to);
  return nombre ? vivas.filter((s) => nombreNormal(s.name) === nombre).map((s) => s.sid) : [];
}

/**
 * Un mensaje de `sid` a `to`: niega si algún destino es una sesión de fondo que abrió `open`, con una coordinadora
 * confirmada y viva que no es quien manda. Un destino que no es ninguna sesión pasa y queda anotado. Una falla con la
 * coordinadora ya confirmada niega (ante la duda): un freno que deja pasar al fallar es un agujero. Una falla sobre un
 * destino que no es de fondo deja pasar ese destino, y queda anotada.
 */
function decidirMensaje({ home, sid, to, env, arnes }) {
  let coord = null;
  let nombreCoord = 'la coordinadora';
  const negar = (duda) => ({ decision: 'deny', reason: textoDeLaNegativaDelMensaje({ nombre: nombreCoord, sid: coord, duda }) });
  try {
    const sl = require('../lib/signature-list.js');
    const s = sl.sesiones(home);
    const confirmada = require('../lib/owner-approvals.js').coordinadoraConfirmada(home, { env, arnes });
    coord = confirmada && sl.vive(s, confirmada) === true ? confirmada : null;
    if (!coord || coord === sid) return null;
    const c = s.mapa.get(coord);
    if (c && c.name) nombreCoord = c.name;
    const problemas = [];
    const vivas = sesionesVivas(home, problemas);
    // el nombre entero de la coordinadora, del archivo de su sesión: el de la lista de sesiones viene recortado
    const deCoord = vivas.find((v) => v.sid === coord);
    if (deCoord && deCoord.name) nombreCoord = deCoord.name;
    const todos = destinosDe(to, vivas);
    if (!todos.length) {
      if (NOT_A_SESSION.test(to) || to === '*') return null;
      // con un archivo de sesión ilegible, el destino que no resuelve puede ser justo esa sesión: ante la duda, niega
      if (problemas.length) {
        logError(home, `el mensaje de ${sid} a «${unRenglon(to)}» no va a ninguna sesión que pude leer (${unRenglon(problemas[0])}): lo frené ante la duda`);
        return negar(true);
      }
      logError(home, `el mensaje de ${sid} a «${unRenglon(to)}» no va a ninguna sesión viva: lo dejé pasar`);
      return null;
    }
    if (problemas.length) logError(home, `no pude leer archivos de sesión al mirar el mensaje de ${sid} (${unRenglon(problemas.join('; '))})`);
    let duda = false;
    let frena = false;
    // ni la coordinadora ni quien manda (una lanzada que difunde) son el destino que se frena
    for (const destino of todos.filter((d) => d !== coord && d !== sid)) {
      let lanzada;
      try { lanzada = require('../tools/coordination.js').launchedBy({ home, sid: destino }); } catch (e) {
        const deFondo = /^(bg|background)$/.test((vivas.find((v) => v.sid === destino) || {}).kind || '');
        logError(home, `no pude saber si ${destino} la abrió la coordinadora (${unRenglon((e && e.message) || e)}): ${deFondo ? 'es de fondo, frené el mensaje' : 'dejé pasar el mensaje'}`);
        if (deFondo) { frena = true; duda = true; }
        continue;
      }
      if (lanzada.problem) {
        logError(home, `no pude saber si ${destino} la abrió la coordinadora (${unRenglon(lanzada.problem)}): ${lanzada.background ? 'es de fondo, frené el mensaje' : 'dejé pasar el mensaje'}`);
        if (lanzada.background) { frena = true; duda = true; }
      } else if (lanzada.launched) frena = true;
    }
    return frena ? negar(duda) : null;
  } catch (e) {
    if (coord && coord !== sid) {
      logError(home, `${unRenglon((e && e.message) || e)}: con la coordinadora viva, frené el mensaje de ${sid} ante la duda`);
      return negar(true);
    }
    logError(home, `${unRenglon((e && e.message) || e)}: dejé pasar el mensaje de ${sid}`);
    return null;
  }
}

/**
 * ¿La sesión `sid` es de fondo? Lo dice su archivo de Claude Code (`sessions/<pid>.json` en su carpeta, `kind`). Sin
 * archivo legible que la nombre, la variable que Claude Code deja en sus sesiones de fondo (`CLAUDE_JOB_DIR`).
 */
function esDeFondo({ home, sid, env }) {
  const dir = path.join(require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js')).claudeDir(home), 'sessions');
  let nombres = [];
  try { nombres = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { nombres = []; }
  for (const f of nombres) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    if (s && s.sessionId === sid) return /^(bg|background)$/.test(String(s.kind || ''));
  }
  return !!(env && env.CLAUDE_JOB_DIR);
}

/** Un comando de fondo que pediría permiso: `{ decision: 'deny', reason, forma }` o null. */
function decidirBash(d, { home, env }) {
  const cmd = d.tool_input && typeof d.tool_input.command === 'string' ? d.tool_input.command : '';
  // primero lo barato: sin un `rm` no hay nada que mirar, y en una sesión que no es de fondo tampoco
  if (!/\brm\b/.test(cmd)) return null;
  const sid = d.session_id;
  if (!sid || !/^[\w-]+$/.test(String(sid)) || !esDeFondo({ home, sid, env })) return null;
  let forma = null;
  try { forma = require('../lib/bg-permission-shapes.js').formaQuePidePermiso(cmd); } catch (e) {
    logError(home, `no cargué lib/bg-permission-shapes.js (${(e && e.message) || e}): el comando pasó sin mirarlo`);
    return null;
  }
  if (!forma) return null;
  return { decision: 'deny', forma: forma.forma, reason: require('../lib/bg-permission-shapes.js').textoDeLaNegativa(forma) };
}

/**
 * Lo que decide el freno: null (pasa) o `{ decision: 'deny', reason }`. `home`, `env` y `arnes` (el árbol con el perfil del equipo) se pasan en las pruebas.
 */
function decidir(evento, { home = os.homedir(), env = process.env, arnes, ahora = Date.now() } = {}) {
  const d = evento && typeof evento === 'object' ? evento : {};
  if (env.TYCON_BG_QUESTION_GUARD === '0') return null;
  if (d.hook_event_name && d.hook_event_name !== 'PreToolUse') return null;
  if (d.tool_name === 'Bash') return decidirBash(d, { home, env });
  if (d.tool_name === MESSAGE_TOOL) {
    const sid = d.session_id;
    const to = String((d.tool_input && d.tool_input.to) || '').trim();
    if (!sid || !/^[\w-]+$/.test(String(sid)) || !to) return null;
    return decidirMensaje({ home, sid, to, env, arnes });
  }
  if (!QUESTION_TOOLS.has(d.tool_name)) return null;
  const sid = d.session_id;
  if (!sid || !/^[\w-]+$/.test(String(sid))) return null;
  const c = coordinadoraDeLaLanzada({ home, sid, env, arnes });
  if (!c) return null;
  // la coordinadora tiene sus minutos para contestar; si no, la pregunta le llega a la persona y la sesión no queda quieta.
  // El registro lo lleva este freno: sin poder leerlo o escribirlo, se niega como siempre, y queda anotado
  let espera = null;
  try {
    const r = require('../tools/coordination.js').questionRelay({ home, sesion: sid, a: c.sid, pregunta: textoDe(d.tool_input), ahora });
    if (r.pasa) return null;
    espera = r.quedan;
  } catch (e) { logError(home, `no pude llevar el registro de las preguntas a la coordinadora (${(e && e.message) || e}): negué sin plazo`); }
  const m = SELLO.exec(textoDe(d.tool_input));
  const firma = m ? m[1] : null;
  const base = textoDeLaNegativa({ nombre: c.name, sid: c.sid, firma, soloClick: firma ? esSoloClick(home, firma) : false, duda: c.duda });
  const plazo = espera ? ` La coordinadora lo ve en su aviso de cada turno. Si en ${espera} min no te la resuelve, volvé a hacer la misma pregunta con el cuadro: le llega a la persona.` : '';
  return { decision: 'deny', reason: `${base}${plazo}` };
}

module.exports = { QUESTION_TOOLS, MESSAGE_TOOL, decidir, textoDeLaNegativa, textoDeLaNegativaDelMensaje, coordinadoraDeLaLanzada, esDeFondo };

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
