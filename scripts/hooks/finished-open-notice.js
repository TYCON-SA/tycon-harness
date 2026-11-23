#!/usr/bin/env node
'use strict';
// finished-open-notice.js — SessionStart: lo terminado sin cerrar de esta máquina, de cualquier sesión. Una ejecución
// con todos sus pasos hechos que sigue abierta, o un camino corto con su pedido abierto o su rama ya en main
// (skills/tycon-pipeline/scripts/lib/finished-open.js decide qué es eso). Además, las carpetas de trabajo con cambios
// sin commitear y ninguna sesión viva adentro: el código que quedó tirado al cerrarse su sesión.
//
// Muestra hasta cinco y «y N más». Cada renglón dice la story (o el motivo del camino corto), la sesión y cómo se cierra:
// si la sesión vive, la cierra ella (sin comando); si murió, `marker.js clear-session <sesión>` (o `adhoc clear-orphan`
// para un camino corto); si su ejecución está perdida, `clear-session <sesión> --lost`, que firma una persona; si no se sabe
// si vive (Codex no deja registro de sesión), lo dice y no da comando. Nada se cierra solo: el aviso sólo mira.
//
// Todo el recorrido tiene un tope de 5 s (lo que no se llegó a mirar se dice como no medido) y la consulta del pedido de
// un camino corto, una foto de 10 minutos. Los caminos cortos de sesiones que ya no están, sin tocarse hace más de 7
// días, sólo se cuentan, con el comando para cerrarlos. También dice la deuda de evidencia en vivo vencida
// (`debtNotice` de unclosed-runs-notice.js): es lo único que escribe, el cierre de una deuda ya pagada en `gates.log`.
// Con lo que ya miró deja la foto de lo que espera la revisión de la persona (scripts/lib/review-load.js,
// `review-load.json` de la carpeta de estado), que leen los avisos de la coordinadora y /wip: nadie decide con ella.
// Nunca rompe el arranque: sale 0 siempre. Off: TYCON_FINISHED_OPEN_NOTICE=0 (todo) o TYCON_UNSAVED_FOLDERS=0 (las carpetas). TYCON_FINISHED_OPEN_NOW fija la hora (pruebas).
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'finished-open.js');
const MARKER_JS = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');

async function main({ env = process.env, home = os.homedir(), write = (t) => process.stdout.write(t) } = {}) {
  // las corridas del banco lanzan `claude -p`: un aviso acá se leería como parte del caso
  if (env.TYCON_EVAL_SANDBOX === '1' || env.TYCON_FINISHED_OPEN_NOTICE === '0') return;
  try { fs.readFileSync(0, 'utf8'); } catch { /* el evento no hace falta: el aviso es de toda la máquina */ }
  const fijo = Date.parse(env.TYCON_FINISHED_OPEN_NOW || '');
  const now = Number.isFinite(fijo) ? fijo : Date.now();
  const stateDir = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(home);
  // si lo de las corridas falla, se dice y los avisos que siguen salen igual: la deuda vencida no espera a otro día
  let lines = [];
  let terminados = null;
  try { terminados = require(LIB).machine({ home, stateDir, now, markerJs: MARKER_JS }); ({ lines } = terminados); } catch (e) {
    write(`🔔 terminado sin cerrar: no pude mirar (${String((e && e.message) || e).split('\n')[0]})\n`);
  }
  if (lines.length) write(`🔔 terminado sin cerrar en esta máquina (nada se cierra solo; cerralo después del último push y del último pedido):\n${lines.map((l) => `  · ${l}`).join('\n')}\n`);
  // la deuda de evidencia en vivo vencida: este gancho se instala siempre, el de las corridas sin cerrar sólo con el buzón
  require(path.join(__dirname, 'unclosed-runs-notice.js')).debtNotice({ env, home, write: (t) => write(`${t}\n`) });
  let carpetas = null;
  if (env.TYCON_UNSAVED_FOLDERS !== '0') {
    carpetas = await require(LIB).unsavedFolderItems({ home, now, env });
    const sueltas = require(LIB).unsavedFolderLines(carpetas);
    if (sueltas.length) write(`🔔 carpetas de trabajo con cambios sin commitear y sin sesión (no toco nada; commitealos y empujalos a su rama, o descartalos a conciencia):\n${sueltas.map((l) => `  · ${l}`).join('\n')}\n`);
  }
  await dejarFoto({ env, home, stateDir, now, terminados, carpetas });
}

/** La foto de lo que espera revisión, con lo que el arranque ya miró. Si algo falla, no rompe el arranque. */
async function dejarFoto({ env, home, stateDir, now, terminados, carpetas }) {
  try {
    const RL = require(path.join(ROOT, 'scripts', 'lib', 'review-load.js'));
    const r = await RL.reviewLoad({ home, stateDir, ahora: now, env, deps: {
      machine: () => { if (!terminados) throw new Error('el arranque no los pudo mirar'); return terminados; },
      folderItems: async () => { if (!carpetas) throw new Error('TYCON_UNSAVED_FOLDERS=0: el arranque no las miró'); return carpetas; },
    } });
    RL.escribirFoto(stateDir, r, now);
  } catch (_) { /* la foto es para avisar: sin ella, los avisos dicen que no la hay */ }
}

if (require.main === module) {
  // un error no rompe el arranque, pero no se calla como «nada abierto»
  main().catch((e) => {
    try { process.stdout.write(`🔔 terminado sin cerrar: no pude mirar (${String((e && e.message) || e).split('\n')[0]})\n`); } catch { /* nada */ }
  }).finally(() => process.exit(0));
}

module.exports = { main };
