#!/usr/bin/env node
/**
 * unclosed-runs-notice.js — «N corridas del pipeline quedaron sin cerrar», dicho una vez por día al arrancar.
 *
 * Hook SessionStart. Una corrida cuyo marcador desapareció sin su cierre no deja volcado: antes no subía al buzón y nadie
 * se enteraba. `upload-runs.js` ahora la sube marcada «sin cerrar» (`unclosed-runs.js`); este aviso se lo dice a la
 * persona, con de qué stories son y qué hacer, para que una story que sigue se retome.
 *
 * Una vez por día: el sello (`unclosed-runs-notice.json` en la carpeta de estado) guarda el día. Sin corridas sin cerrar,
 * calla y no sella. Sólo lee: no escribe volcados (eso lo hace la subida).
 * Fail-open total: nunca frena el arranque ni tira; una falla calla y sale 0.
 * Apagado: TYCON_UNCLOSED_NOTICE=0.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEAL = 'unclosed-runs-notice.json';

function stateDirOf(home) {
  return require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')).stateDir(home);
}

function line(runs, script) {
  const stories = [...new Set(runs.map((r) => r.key))];
  const shown = stories.slice(0, 5).join(', ') + (stories.length > 5 ? ` y ${stories.length - 5} más` : '');
  return `⚠️ ${runs.length} corrida(s) del pipeline quedaron sin cerrar (${shown}): se suben al buzón marcadas «sin cerrar» `
    + `con la próxima subida. Si una story sigue, retomala con el pipeline; para ver cuáles y dónde: node "${script}"`;
}

function main({ env = process.env, home = os.homedir(), write = (t) => console.log(t) } = {}) {
  if (String(env.TYCON_UNCLOSED_NOTICE || '').trim() === '0') return 0;
  const now = env.TYCON_UNCLOSED_NOW ? Date.parse(env.TYCON_UNCLOSED_NOW) : Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const dir = stateDirOf(home);
  const sealFile = path.join(dir, SEAL);
  try { if (JSON.parse(fs.readFileSync(sealFile, 'utf8')).day === day) return 0; } catch (_) { /* sin sello: se mira */ }
  const script = path.join(__dirname, '..', 'metrics', 'unclosed-runs.js');
  const { runs, problems } = require(script).findUnclosed({ home, stateDir: dir, now, env });
  if (!runs.length && !problems.length) return 0;
  // primero se sella, después se dice: si el estado no se deja escribir, calla (un aviso de cada arranque se deja de leer)
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sealFile, JSON.stringify({ day, runs: runs.length, problems: problems.length }), 'utf8');
  // «no pude mirar» no es «no hay»: se dice, con dónde está el detalle
  const partial = problems.length ? `${problems.length} cosa(s) no se pudieron mirar (${problems[0]}${problems.length > 1 ? '; …' : ''}); el detalle: node "${script}"` : '';
  if (runs.length) write(line(runs, script) + (partial ? ` · Además, ${partial}` : ''));
  else write(`⚠️ No pude mirar del todo si quedaron corridas del pipeline sin cerrar: ${partial}`);
  return 0;
}

module.exports = { main, line, SEAL };

if (require.main === module) {
  try { process.exitCode = main(); } catch (_) { process.exitCode = 0; }
}
