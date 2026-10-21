#!/usr/bin/env node
'use strict';
/**
 * instincts-notice.js — gancho `SessionStart`: dice UNA vez por máquina qué graba la integración `instincts`, adónde
 * va y cómo bajarse; y, con la integración apagada, que las variables viejas ya no prenden nada.
 *
 * El sello (`<stateDir>/instincts-notice.json`) guarda `{ schema, said_on, state }`: `said_on` es el día, en UTC, en que
 * se dijo el aviso, y es el primer día que esta máquina puede subir lo grabado. `legacy_said_on` anota el aviso de las
 * variables viejas. Sin sello no hay aviso dos veces; con el sello ilegible, se vuelve a decir.
 *
 * Nunca frena ni sale distinto de 0. Casos: scripts/tests/instinct-observe.test.js (T9)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEAL = 'instincts-notice.json';
const LEGACY_VARS = ['TYCON_INSTINCT_MINING', 'TYCON_INSTINCT_OBSERVER'];

const TEXT_ON = [
  '🔎 instintos — esta máquina graba, para encontrar lo que el equipo repite y proponer controles:',
  '   · la ruta de los archivos que lee o edita, los comandos, los patrones de búsqueda, la descripción de los',
  '     ayudantes y el nombre de las skills; de las demás herramientas, sólo el nombre (todo saneado de secretos);',
  '   · lo grabado sube al buzón de la organización y sólo lo leen los mantenedores con el rol de lectura;',
  '   · queda atribuido a vos: tu máquina informa tu correo de git;',
  '   · el modelo que propone no corre en esta máquina, sino en la del mantenedor que revisa.',
  '   Para bajarte: TYCON_INSTINCTS=0 (o integrations.instincts=false en ~/.claude/tycon.json).',
].join('\n');

const TEXT_LEGACY = '🔎 instintos — TYCON_INSTINCT_MINING y TYCON_INSTINCT_OBSERVER ya no prenden nada: la grabación la decide la integración instincts del perfil del equipo.';

function readSeal(stateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, SEAL), 'utf8')); } catch (_) { return null; }
}

/** Qué decir en este arranque: `{ text, seal }` (`text: null` = nada). */
function decide({ prendida, env, stateDir, now }) {
  const prev = readSeal(stateDir) || {};
  const day = (now || new Date()).toISOString().slice(0, 10);
  if (prendida) {
    if (prev.said_on) return { text: null, seal: null };
    return { text: TEXT_ON, seal: { ...prev, schema: 1, said_on: day, state: 'prendida' } };
  }
  const legacy = LEGACY_VARS.some((v) => String((env || {})[v] || '') === '1');
  if (!legacy || prev.legacy_said_on) return { text: null, seal: null };
  return { text: TEXT_LEGACY, seal: { ...prev, schema: 1, legacy_said_on: day, state: prev.state || 'apagada' } };
}

function seal(stateDir, data) {
  if (!data) return;
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, SEAL);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  fs.renameSync(tmp, file);
}

/** Anota un fallo del aviso en el registro de la grabadora; si tampoco se puede, queda callado. */
function noteFailure(home, motivo) {
  try {
    const dir = process.env.TYCON_INSTINCT_OBS_DIR || path.join(home, '.claude', 'tycon-observations');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'instinct-observe.errors.log'), `${new Date().toISOString()} instincts-notice: ${motivo}\n`);
  } catch (_) { /* sin dónde anotarlo */ }
}

module.exports = { decide, seal, SEAL };

if (require.main === module) {
  // las corridas del banco lanzan sesiones de prueba: un aviso ahí entra al prompt del agente simulado
  if (process.env.TYCON_EVAL_SANDBOX === '1') process.exit(0);
  try {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const cfg = require('../lib/tycon-config.js');
    let prendida = false;
    try { const r = cfg.integracionParaHook('instincts', { env: process.env, home }); prendida = !!(r && r.ok && r.prendida); } catch (_) { prendida = false; }
    const stateDir = require('../setup/harness/tycon-home.js').stateDir(home);
    const d = decide({ prendida, env: process.env, stateDir });
    if (d.text) {
      // el aviso sale aunque el sello no se pueda escribir: grabar sin haber avisado es peor que avisar dos veces
      process.stdout.write(`<system-reminder>\n${d.text}\n</system-reminder>\n`);
      try { seal(stateDir, d.seal); } catch (e) { noteFailure(home, `no pude escribir el sello del aviso (${e.code || e.message})`); }
    }
  } catch (_) { /* un aviso que no se pudo decir no frena la sesión */ }
  process.exitCode = 0;
}
