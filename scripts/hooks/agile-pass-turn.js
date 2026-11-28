#!/usr/bin/env node
'use strict';
/**
 * agile-pass-turn.js — un pase adversarial lanzado sin el pipeline pasa por el turno de tarea pesada.
 *
 *   Claude: PreToolUse de Agent|Task|Workflow.
 *
 * En el pipeline, el pase ocupa el turno por el marcador de la corrida (coordination.js passOccupiesMachine). Una sesión
 * sin corrida (el modo ágil: la que abrió la coordinadora, o una suelta) lo lanza con la herramienta Agent o Workflow, y
 * nada lo cuenta: con varios a la vez, la máquina se queda sin procesos y no arranca ningún comando. Cuenta como pase:
 *   - todo Workflow, sin mirar su nombre: es el abanico de agentes que llena la máquina;
 *   - un Agent cuya descripción o tipo de agente dice «adversarial» (los revisores chicos y las búsquedas no cuentan).
 * Tiene turno la sesión a la que la coordinadora se lo dio: su «arrancá» vigente (`heavy-turn.js grant --to <sesión>`) o
 * una reserva para ella (`heavy-turn.js reserve --for "<qué>" --to <sesión>`). No se mira nada sin una
 * coordinadora designada y viva, en la coordinadora misma, ni en una sesión con corrida del pipeline (su pase ya pasa por
 * su marcador). La coordinadora se reconoce igual que en `grant` y `reserve` (heavy-turn.js coordinator): si ella no
 * puede dar el turno (TYCON_SUITE_TURN=0, o el perfil sin el rol), no hay a quién mandar la sesión y el gancho calla.
 *
 * Sin turno FRENA el lanzamiento y dice, al modelo y a la persona, con quién está el turno y cómo pedirlo: varios pases
 * a la vez dejan la máquina sin procesos, y un aviso no los separaba. Cada freno o lanzamiento con turno queda en
 * gates.log (`agile-pass-turn`: la herramienta, la sesión y el resultado, sin el pedido).
 * Codex no tiene estas herramientas (adapters/codex/hooks.json). Off: TYCON_AGILE_PASS_TURN=0 (el freno de mano no
 * deja apagarlo desde el arranque de la consola: scripts/lib/env-switches.json).
 *
 * Un error al leer la máquina (el turno, la designación, las ejecuciones) NO frena: calla y anota `no-medido`, que sale
 * al arrancar con las fallas de los controles. Frenar ahí trabaría todo lanzamiento de agentes por un archivo de
 * coordinación ilegible, y lo que este freno cuida (no llenar la máquina de procesos) no justifica eso. Si Node mismo
 * falla (o es más viejo que el piso y la máquina no tiene el Node del arnés), el aplicador lo lanza como freno
 * (`effect: blocks` en scripts/setup/hooks-list.json) y falla cerrado como los demás frenos: ahí frena todo Agent, Task
 * y Workflow hasta arreglar Node. Sin tiempo máximo: un freno que se agota deja pasar, y se agotaría justo con la máquina
 * cargada, que es lo que cuida.
 * `MODO = 'warn'` vuelve al aviso de antes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const NOMBRE = 'agile-pass-turn';
// 'warn' avisa; 'block' frena (la forma vigente: el aviso no separaba los pases).
const MODO = 'block';
const HERRAMIENTAS_DE_AGENTE = new Set(['Agent', 'Task']);
const DICE_PASE = /adversari/i;
// el revisor único de historias (tycon-create-story lo lanza al cerrar una historia): un solo agente de sólo lectura, no
// un pase pesado. Se exceptúa por su nombre EXACTO: un tipo parecido sigue contando, y con una descripción que dice
// «adversarial» también
const REVISOR_DE_HISTORIAS = 'tycon-story-adversarial-reviewer';
// el «para qué» de un turno tomado para lanzar un pase o un Workflow (heavy-turn.js take --what …)
const PARA_UN_PASE = /\b(pase|adversari\w*|workflow)\b/i;

/**
 * ¿Este lanzamiento es un pase? Todo Workflow; un Agent sólo si su descripción o su tipo de agente dicen «adversarial».
 * El pedido no se mira: nombrar el pase en un pedido («no hagas una revisión adversarial») no lo vuelve uno.
 */
function esPase(toolName, toolInput) {
  if (toolName === 'Workflow') return true;
  if (!HERRAMIENTAS_DE_AGENTE.has(toolName)) return false;
  const i = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (i.subagent_type === REVISOR_DE_HISTORIAS) return DICE_PASE.test(String(i.description || ''));
  return DICE_PASE.test(`${i.description || ''}\n${i.subagent_type || ''}`);
}

/**
 * La decisión, pura: `{ status, message }`. `status`: `fuera` (no se mira), `con-turno`, `aviso` o `freno`. `d` trae lo
 * que se lee de la máquina: `coordinadora()` (el id de la designada y viva, o null), `tieneCorrida(sid)`, `arranca()`
 * (el «arrancá» vigente, `{ to }`, o null), `reserva()` (`{ what, to, toSession }` vigente, o null), `corriendo()` (textos
 * de las ejecuciones grandes), `propias(sid)` (las de esa sesión) y `pases()` (textos de los pases en vuelo de otras
 * sesiones).
 */
function decidir({ toolName, toolInput, sid, modo = MODO }, d) {
  if (!esPase(toolName, toolInput)) return { status: 'fuera', message: null };
  const coord = d.coordinadora();
  if (!coord || !sid || coord === sid || d.tieneCorrida(sid)) return { status: 'fuera', message: null };
  const g = d.arranca();
  const r = d.reserva();
  const que = toolName === 'Workflow' ? 'un Workflow (un abanico de agentes)' : 'un pase adversarial';
  if (g && g.to === sid) return { status: 'con-turno', message: null };
  // el turno que ya tiene esta sesión, tomado para un pase o un Workflow, es el de lo que lanza (se toma y después se
  // lanza), también con la reserva: se mira antes que ella, que si no frenaría a la sesión por su propio pase
  const propios = d.propios ? d.propios(sid) : [];
  if (propios.some((p) => PARA_UN_PASE.test(String(p.what || '')))) return { status: 'con-turno', message: null };
  if (r && r.to === sid) {
    // la reserva es para una cosa por vez: si el portón de esta sesión ya tomó el turno con ella, el pase espera
    const propias = d.propias(sid);
    if (!propias.length) return { status: 'con-turno', message: null };
    const message = `Lanzás ${que} con la reserva de la coordinadora, pero con esa reserva ya corre ${propias.join(' y ')}, de esta sesión: es para una cosa por vez. Lanzalo cuando termine.`
      + (modo === 'block' ? '' : ' Hoy sólo se avisa.');
    return { status: modo === 'block' ? 'freno' : 'aviso', message };
  }
  // el turno que ya tiene esta sesión, tomado para otra cosa (su portón): lanzar el pase encima serían dos ejecuciones
  // grandes de una sesión
  if (propios.length) {
    const message = `Lanzás ${que}, pero el turno de esta sesión es para ${propios.map((p) => p.texto).join(' y ')}: es para una cosa por vez. Lanzalo cuando termine.`
      + (modo === 'block' ? '' : ' Hoy sólo se avisa.');
    return { status: modo === 'block' ? 'freno' : 'aviso', message };
  }
  const quien = [
    ...d.corriendo(),
    ...d.pases(),
    ...(r ? [`la reserva de la coordinadora para «${r.what}»${r.toSession ? ` de ${r.toSession}` : ''}`] : []),
  ];
  const message = `Lanzás ${que} sin el turno de tarea pesada de esta máquina. ${quien.length ? `Lo tiene: ${quien.join(' · ')}.` : 'Nadie lo tiene, pero la coordinadora no te lo dio.'} `
    + `Pedile turno a la coordinadora (te lo da con heavy-turn.js grant --to ${sid}, o reserve --for "<qué>" --to ${sid}) y lanzalo cuando te lo dé: varios pases a la vez dejan la máquina sin procesos.`
    + (modo === 'block' ? '' : ' Hoy sólo se avisa.');
  return { status: modo === 'block' ? 'freno' : 'aviso', message };
}

/** Lo que se lee de la máquina, para `decidir`. */
function lectores(home, now) {
  const HT = require(path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'));
  const { designacionVigente } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'critical-waivers.js'));
  const stateDir = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(home);
  return {
    coordinadora: () => {
      if (!HT.coordinator({ home, env: process.env })) return null;
      const v = designacionVigente({ home });
      return v && !v.error && v.sesion ? v.sesion : null;
    },
    tieneCorrida: (sid) => fs.existsSync(path.join(stateDir, 'active', `${String(sid).replace(/[/\\]/g, '_')}.json`)),
    arranca: () => HT.grantInForce({ home, now }),
    reserva: () => HT.reserveInForce({ home, now }),
    corriendo: () => HT.holders({ home, now }).map((h) => HT.describe(h)),
    propias: (sid) => HT.holders({ home, now }).filter((h) => h.sid === sid).map((h) => HT.describe(h)),
    propios: (sid) => HT.holders({ home, now }).filter((h) => h.sid === sid).map((h) => ({ texto: HT.describe(h), what: h.what })),
    pases: () => require(path.join(ROOT, 'scripts', 'tools', 'coordination.js')).heavyPassesInFlight({ home, now })
      .passes.filter((p) => !p.stale).map((p) => `el pase de ${p.storyId ? `la ${p.storyId}` : 'una sesión sin story'} (${p.session})`),
  };
}

function anotar(home, fila) {
  try {
    const dir = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), name: NOMBRE, ...fila })}\n`, 'utf8');
  } catch { /* el registro nunca frena un lanzamiento */ }
}

/**
 * El evento entero: `{ fila, salida }` (lo que se anota en gates.log y lo que se imprime), o null si no hay nada que
 * decir. `leer()` da los lectores de la máquina: se piden sólo para un pase, con el gancho prendido.
 */
function responder(ev, env, leer, modo = MODO) {
  if (env.TYCON_AGILE_PASS_TURN === '0' || !ev || typeof ev !== 'object') return null;
  const toolName = ev.tool_name;
  if (!esPase(toolName, ev.tool_input)) return null;
  const sid = ev.session_id || env.CLAUDE_CODE_SESSION_ID || null;
  let r;
  try { r = decidir({ toolName, toolInput: ev.tool_input, sid, modo }, leer()); } catch (e) {
    return { fila: { sessionId: sid, tool: toolName, status: 'no-medido', why: String((e && e.code) || (e && e.message) || e).slice(0, 160) }, salida: null };
  }
  if (r.status === 'fuera') return null;
  let salida = null;
  if (r.message && r.status === 'freno') salida = { systemMessage: `⛔ ${r.message}`, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.message } };
  else if (r.message) salida = { systemMessage: `⚠️ ${r.message}`, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: r.message } };
  return { fila: { sessionId: sid, tool: toolName, status: r.status }, salida };
}

function main() {
  let ev;
  try { ev = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return; }
  const home = os.homedir();
  const r = responder(ev, process.env, () => lectores(home, Date.now()));
  if (!r) return;
  anotar(home, r.fila);
  if (r.salida) process.stdout.write(`${JSON.stringify(r.salida)}\n`);
}

module.exports = { MODO, NOMBRE, esPase, decidir, responder, lectores };

if (require.main === module) {
  try { main(); } catch { /* nunca romper un lanzamiento */ }
  process.exit(0);
}
