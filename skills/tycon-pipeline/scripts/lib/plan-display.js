'use strict';
/**
 * plan-display — el plan del paso 3 se lo muestra el arnés a la persona, sin depender del agente.
 *
 * Medido en un laboratorio con una sesión atendida: el freno de `complete-step 3` le devolvió el plan entero al agente
 * tres veces, el agente no lo escribió nunca y dijo que ya lo había mostrado. Lo que el agente lee no le llega a la
 * persona; lo que un control de Claude Code devuelve como `systemMessage` sí aparece en su pantalla.
 *
 *   · `planParaMostrar({ command, sessionId, stateDir, home })`: antes de un `marker.js complete-step 3`, con el paso 3
 *     abierto, el plan escrito en la carpeta de la corrida y la conversación legible sin el plan, devuelve
 *     `{ systemMessage, constancia }` y deja la constancia en `gates.log` (`plan-shown`: sesión, historia y huella del
 *     plan). Si no, null. Sin conversación legible (otra herramienta) no muestra ni anota: no se sabe si el aviso se ve.
 *   · `handle(event)`: lo mismo, después de que el agente escribe el plan con Edit o Write (`step-02-bmad-plan.md` de la
 *     corrida abierta de esta sesión). Corre en el despachador de ediciones, que la instalación mínima también trae:
 *     el plan aparece en pantalla en el momento en que se escribe. Devuelve `{ systemMessage }` o null.
 *   · `mostradoPorElArnes({ stateDir, sessionId, storyId, planTxt })`: ¿hay una constancia de esa sesión, esa historia y
 *     ese mismo plan? La lee `complete-step 3`. El agente no puede escribir en la carpeta del estado (la frena el
 *     portón de carril), así que la constancia no se fabrica copiando una línea.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLAN_FILE = 'step-02-bmad-plan.md';
const CIERRE_DEL_PASO_3 = /\bmarker\.js["']?\s+complete-step\s+["']?3(?![\w.])/;

const huella = (planTxt) => crypto.createHash('sha256').update(String(planTxt).trim()).digest('hex').slice(0, 16);

// Que falte el archivo es lo normal (no hay corrida, o todavía no hay plan): null. Un archivo roto o sin permiso sube, y
// quien llama lo deja en hook-errors.log: si no, se vería igual que «no hay nada que mostrar».
function leerMarcador(stateDir, sessionId) {
  let txt;
  try { txt = fs.readFileSync(path.join(stateDir, 'active', `${sessionId}.json`), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(txt);
}

function rutaDeLaStory(marker) {
  if (!marker || !marker.storyPath) return null;
  const p = path.isAbsolute(marker.storyPath) ? marker.storyPath : path.join(marker.repoPath || process.cwd(), marker.storyPath);
  return fs.existsSync(p) ? p : null;
}

function planParaMostrar({ command, sessionId, stateDir, home = os.homedir() }) {
  if (!command || !CIERRE_DEL_PASO_3.test(String(command))) return null;
  return mostrar({ sessionId, stateDir, home });
}

const mismaRuta = (a, b) => path.resolve(String(a)).replace(/\\/g, '/').toLowerCase() === path.resolve(String(b)).replace(/\\/g, '/').toLowerCase();

function handle(event, opts = {}) {
  const tool = event && event.tool_name;
  if (tool !== 'Write' && tool !== 'Edit') return null;
  const file = event.tool_input && event.tool_input.file_path;
  if (!file || path.basename(String(file)) !== PLAN_FILE) return null;
  const { resolveSessionId } = require('./session-id.js');
  const r = mostrar({
    sessionId: resolveSessionId(event.session_id), stateDir: opts.stateDir || require('./story-gate-io.js').DEFAULT_STATE_DIR,
    home: opts.home, archivo: file,
  });
  return r ? { systemMessage: r.systemMessage, alMostrar: r.anotar } : null;
}

// `archivo`: si viene, el plan sólo se muestra si es el de la corrida abierta (no el de otra story ni de otra carpeta).
function mostrar({ sessionId, stateDir, home = os.homedir(), archivo = null }) {
  const marker = leerMarcador(stateDir, sessionId);
  if (!marker || !marker.storyId) return null;
  if (require('./steps.js').isDone(marker, 'approve-plan')) return null;
  const story = rutaDeLaStory(marker);
  const repo = marker.repoPath || process.cwd();
  const runDir = require('../pipeline.js').resolveRunDir(repo, String(marker.storyId), false, story || undefined);
  if (!runDir) return null;
  if (archivo && !mismaRuta(archivo, path.join(runDir, PLAN_FILE))) return null;
  let planTxt = '';
  try { planTxt = fs.readFileSync(path.join(runDir, PLAN_FILE), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!planTxt.trim()) return null;
  const visto = require('./person-ok.js').planEnLaConversacion(planTxt, { sesion: sessionId, home });
  if (!visto.legible || visto.mostrado) return null;
  const constancia = { ts: new Date().toISOString(), sessionId, repoPath: repo, name: 'plan-shown', status: 'ok', story: String(marker.storyId), sha: huella(planTxt) };
  // la constancia la escribe quien muestra, DESPUÉS de mostrar (`anotar`): un aviso que no salió no cuenta como visto
  return {
    systemMessage: `El plan de la historia ${marker.storyId} (te lo muestra el arnés, tal cual está escrito):\n\n${planTxt.trim()}`,
    constancia,
    anotar: () => anotar(stateDir, constancia),
  };
}

function anotar(stateDir, constancia) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, 'gates.log'), `${JSON.stringify(constancia)}\n`, 'utf8');
}

function mostradoPorElArnes({ stateDir, sessionId, storyId, planTxt }) {
  let log = '';
  try { log = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8'); } catch (_e) { return false; }
  const sha = huella(planTxt);
  return log.split('\n').some((l) => {
    if (!l.includes('"plan-shown"')) return false;
    try {
      const e = JSON.parse(l);
      return e.name === 'plan-shown' && e.sessionId === sessionId && e.story === String(storyId) && e.sha === sha;
    } catch (_e) { return false; }
  });
}

module.exports = { PLAN_FILE, planParaMostrar, handle, mostradoPorElArnes, huella };
