#!/usr/bin/env node
'use strict';
/**
 * cover-secrets.js — después de cada comando, lectura o búsqueda, cambia por «tapado» los valores reales de los secretos
 * de la máquina, para que no lleguen al modelo ni a la conversación guardada.
 *
 *   Claude: `updatedToolOutput` con los mismos campos que trajo la respuesta (uno que no respeta la forma se descarta, y el
 *           valor pasaría) y `additionalContext` con el aviso.
 *   Codex:  no tiene forma de reescribir una salida: `decision: "block"` reemplaza el resultado por el motivo. El comando ya
 *           corrió; el modelo lo ve como un error del guion, y el original queda en el archivo de su conversación.
 *
 * Nunca frena: sin nada que tapar calla y, ante cualquier error, sale 0 y el valor pasa. Registro en
 * `<estado>/cover-secrets.jsonl` (cuántos y de qué origen, nunca el valor ni el comando) y errores en
 * `<estado>/cover-secrets-errors.log`. Off: TYCON_COVER_SECRETS=0.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const NOTICE = 'Se tapó un valor real de la configuración de esta máquina: no hace falta verlo. Para saber si una clave de la configuración está, usá `tycon-config.js get <clave>`; si una variable está, `[ -n "$VARIABLE" ] && echo está`.';

const stateDir = (home) => require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js')).stateDir(home);

/** Un motivo por día: el gancho corre en cada herramienta, y un archivo roto no tiene que llenar el registro. */
function logProblems(home, problems) {
  if (!problems.length) return;
  try {
    const dir = stateDir(home);
    const file = path.join(dir, 'cover-secrets-errors.log');
    let current = '';
    try { current = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const day = new Date().toISOString().slice(0, 10);
    const fresh = problems.filter((p) => !current.includes(`${day} ${p}\n`));
    if (!fresh.length) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, fresh.map((p) => `${day} ${p}\n`).join(''));
  } catch { /* sin registro tampoco: nunca frena */ }
}

function record(home, input, count, origins) {
  fs.mkdirSync(stateDir(home), { recursive: true });
  const line = { ts: new Date().toISOString(), session: input.session_id || null, tool: input.tool_name || null, count, origins };
  fs.appendFileSync(path.join(stateDir(home), 'cover-secrets.jsonl'), `${JSON.stringify(line)}\n`);
}

/** El texto que Codex le muestra al modelo en lugar del resultado. Codex manda la salida como texto; si llega por campos, se arma. */
function codexReason(covered) {
  if (typeof covered === 'string') return covered;
  if (covered && typeof covered === 'object' && (typeof covered.stdout === 'string' || typeof covered.stderr === 'string')) {
    return [covered.stdout, covered.stderr].filter((t) => typeof t === 'string' && t).join('\n');
  }
  return JSON.stringify(covered);
}

function answer(input, covered) {
  if (typeof input.turn_id === 'string') return { decision: 'block', reason: `${codexReason(covered)}\n\n${NOTICE}` };
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: covered, additionalContext: NOTICE } };
}

function main() {
  if (process.env.TYCON_COVER_SECRETS === '0') return;
  const home = os.homedir();
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); }
  catch (e) { logProblems(home, [`la entrada del gancho no se entiende (${e.code || e.name})`]); return; }
  if (!input || input.tool_response === undefined || input.tool_response === null) {
    logProblems(home, ['la entrada del gancho no trae la respuesta de la herramienta']);
    return;
  }

  const { readKnownSecrets, coverIn } = require(path.join(ROOT, 'scripts', 'lib', 'known-secrets.js'));
  const { secrets, problems } = readKnownSecrets({ home, env: process.env });
  logProblems(home, problems);
  const { value, count, origins } = coverIn(input.tool_response, secrets);
  if (!count) return;
  const reply = JSON.stringify(answer(input, value));
  try { record(home, input, count, origins); }
  catch (e) { logProblems(home, [`no pude anotar en el registro (${e.code || e.name})`]); }
  process.stdout.write(reply);
}

try { main(); } catch (e) {
  logProblems(os.homedir(), [`el gancho falló (${e.code || e.name})`]);
}
process.exitCode = 0;
