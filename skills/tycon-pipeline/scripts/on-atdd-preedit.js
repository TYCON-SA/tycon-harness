#!/usr/bin/env node
/**
 * tycon-pipeline PreToolUse hook (matcher: Edit|Write) — portón PREVENTIVO de ATDD.
 *
 * DENIEGA la edición del primer archivo de código de una corrida de pipeline si todavía no se tocó
 * ningún archivo de test. Es la capa que faltaba: las otras dos (`complete-step implement` y el gate de
 * commit) detectan la inversión cuando la implementación ya está escrita; ésta la hace imposible.
 * Una implementación completa antes de ningún test no la caza el harness sino quien lee el
 * transcript. Ver `lib/atdd-preedit.js` (la
 * lógica y su calibrado viven ahí, en funciones puras testeadas).
 *
 * Corre in-process vía dispatch.js ('pre-edit'). Contrato: handle(event) →
 *   null           → dejar pasar
 *   { block: msg } → dispatch escribe msg a stderr y sale con exit 2 (el tool call se deniega)
 *
 * Fail-open VISIBLE, no silencioso: este handler NO envuelve todo en try/catch — si tira, el
 * dispatcher lo loguea a `hook-errors.log` y sigue (su contrato de siempre). Un catch-todo acá
 * haría que "explotó" y "salteó bien" devolvieran lo mismo (`null`), o sea un gate roto invisible
 * — exactamente el defecto del gate ciego. Las lecturas que PUEDEN fallar
 * legítimamente (marker ausente, story ilegible) tienen su try puntual con el default documentado.
 *
 * Evidencia de "qué se editó antes": la UNIÓN de `marker.fileEvents` (dentro del pipeline) y el
 * `.jsonl` por sesión de `atdd-commit-gate.js` (que `on-edit.js` graba SIEMPRE, haya marker o no).
 * Sin la unión, los tests escritos ANTES de crear el marker (Arranque o «Validar la historia», o el reminder de "seteá el
 * marker AHORA") no contarían y el portón denegaría un ATDD impecable — falso positivo.
 *
 * Escapes: marker flag `atddBypass` (marker.js set-flag atddBypass true --reason "<por qué>" — cada edición que el
 * bypass deja pasar queda en bypass.log, y el MISMO flag satisface el gate del complete-step implement) ·
 * env TYCON_ATDD_PREEDIT_GATE=off (apaga la capa entera, p.ej. para debug del propio harness).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // la carpeta del estado, de una sola pieza
const { computeAtddPreEdit, preEditBlockMessage, storyDeclaresTests } = require('./lib/atdd-preedit.js');
const { readFileEvents } = require('./lib/atdd-commit-gate.js');
const { declaredFiles } = require('./lib/run-size.js');
const { resolveSessionId } = require('./lib/session-id.js');

const DEFAULT_STATE_DIR = path.join(stateDirOf(os.homedir()));

function readMarker(stateDir, sessionId) {
  try {
    const safe = String(sessionId || '_nosession').replace(/[/\\]/g, '_');
    const m = JSON.parse(fs.readFileSync(path.join(stateDir, 'active', `${safe}.json`), 'utf8'));
    return m && m.storyId ? m : null;
  } catch {
    return null; // sin marker (o ilegible) = sin pipeline activo → este portón no aplica
  }
}

function appendLog(stateDir, fileName, sessionId, obj) {
  try {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(
      path.join(stateDir, fileName),
      JSON.stringify({ ts: new Date().toISOString(), sessionId, ...obj }) + '\n',
      'utf8',
    );
  } catch { /* logging nunca rompe el gate */ }
}

/**
 * @param {object} event  evento PreToolUse de Claude Code (stdin del dispatcher)
 * @param {object} [opts] { stateDir } — override para tests
 */
function handle(event, opts = {}) {
  if (String(process.env.TYCON_ATDD_PREEDIT_GATE || '').toLowerCase() === 'off') return null;

  const filePath = event?.tool_input?.file_path;
  if (!filePath) return null;

  const stateDir = opts.stateDir || DEFAULT_STATE_DIR;
  const sessionId = resolveSessionId(event?.session_id);
  const marker = readMarker(stateDir, sessionId);
  // Sin pipeline activo no se frena nada — el gate de commit
  // (`atdd-commit-gate.js`) sigue cubriendo el trabajo a mano, en modo aviso.
  if (!marker) return null;

  // storyPath puede venir relativo (marker armado a mano / adoptado) — resolver contra repoPath,
  // misma regla que `resolveStoryPath` de marker.js. Sin esto, el read falla → "no declara Tests"
  // → portón apagado toda la corrida CON UNA RAZÓN FALSA.
  let storyAbs = String(marker.storyPath || '');
  if (storyAbs && !path.isAbsolute(storyAbs) && marker.repoPath) {
    storyAbs = path.join(marker.repoPath, storyAbs);
  }
  // Story ilegible → '' → storyDeclaresTests=false → pass. Fail-open deliberado: un portón que
  // frena por no poder leer un archivo es un portón que se apaga. Se dice en cada edición que juzga (cada una es un
  // proceso aparte); sin story en el marcador no hay nada que decir.
  let storyText = '';
  if (storyAbs) {
    try { storyText = fs.readFileSync(storyAbs, 'utf8'); } catch (e) {
      process.stderr.write(`⚠️  freno ATDD previo: no pude leer la historia (${storyAbs}: ${e.code || e.message}); sin su tabla de pruebas no juzgo esta edición.\n`);
    }
  }

  // Evidencia previa = fileEvents del marker ∪ .jsonl de la sesión (ediciones pre-marker).
  const priorPaths = (Array.isArray(marker.fileEvents) ? marker.fileEvents : [])
    .concat(readFileEvents(stateDir, sessionId))
    .map((e) => e && e.path)
    .filter(Boolean);

  const base = {
    filePath,
    repoPath: marker.repoPath,
    priorPaths,
    storyHasTests: storyDeclaresTests(storyText),
    stepsCompleted: marker.stepsCompleted,
    stepScheme: marker.stepScheme,
    declarados: declaredFiles(storyText),
  };
  const r = computeAtddPreEdit({ ...base, bypassed: marker.atddBypass === true });

  if (r.action !== 'block') {
    // El bypass se audita SOLO cuando evitó un bloqueo real (sin esto, una línea por CADA
    // edición de la sesión — ruido que entierra las entradas que importan).
    if (marker.atddBypass === true && computeAtddPreEdit({ ...base, bypassed: false }).action === 'block') {
      appendLog(stateDir, 'bypass.log', sessionId, {
        repoPath: marker.repoPath || null, kind: 'ATDD_PREEDIT_BYPASS', story: marker.storyId, file: filePath,
        reason: marker.atddBypassReason || null,
      });
    }
    return null;
  }

  // repoPath: namespace por repo — misma key que marker.js.
  appendLog(stateDir, 'gates.log', sessionId, {
    repoPath: marker.repoPath || null, name: 'atdd-preedit', status: 'blocked', story: marker.storyId, file: filePath, reason: r.reason,
  });
  return {
    block: preEditBlockMessage({ filePath, storyId: marker.storyId, storyPath: storyAbs }) + '\n',
  };
}

module.exports = { handle };
