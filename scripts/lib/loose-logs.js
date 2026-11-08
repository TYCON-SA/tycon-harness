'use strict';
// loose-logs.js — dónde van los registros sueltos de los hooks (el registro del freno, la grabadora de instintos, los
// medidores): en una máquina que vive en la casa propia del arnés, en la carpeta del estado; si no, en la carpeta de
// Claude Code, donde estuvieron siempre. La regla es la de tycon-home.js; su gemela en shell es scripts/lib/state-dir.sh
// (`tycon_logs_dir`), y las compara scripts/tests/state-dir-parity.test.js.
//
// Sin tycon-home.js al lado (un árbol roto) devuelve null: quien escribe no escribe y quien lee no encuentra nada. Un
// registro es ayuda, nunca evidencia, y no hay ruta de respaldo escrita a mano.
//
// `node loose-logs.js --move-old` muda una vez a la carpeta del estado los registros que los hooks dejaron en la carpeta
// de Claude Code antes de que pidieran su casa, para que sus lectores lo encuentren. Lo llama el aplicador
// (install-tycon-hooks.sh).
const fs = require('fs');
const path = require('path');

let TH = null;
try { TH = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')); } catch (_) { TH = null; }

/** Los registros sueltos que esta regla lleva a la carpeta del estado (los de HOOK_STORES de uninstall.js, menos el de
 *  la integración de horas, que no es de esta regla). */
const STORES = ['safety-guard.log', 'tycon-observations', 'blocking-meter', 'lectura-grande', 'response-style', '.tycon-retro-staleness-last-notice'];

/** La carpeta de los registros sueltos para `home` (por defecto, la del usuario), o null sin tycon-home.js. */
function looseLogsDir(home) {
  if (!TH) return null;
  return TH.livesInOwnHome(home) ? TH.ownStateDir(home) : TH.claudeDir(home);
}

/** La ruta de un registro suelto (`name` relativo a esa carpeta), o null. */
function looseLogPath(name, home) {
  const dir = looseLogsDir(home);
  return dir ? path.join(dir, name) : null;
}

const lstat = (p) => { try { return fs.lstatSync(p); } catch (_) { return null; } };

/**
 * Muda a la carpeta del estado cada registro suelto que siga en la carpeta de Claude Code, en una máquina que vive en la
 * casa propia. Renombra (en el mismo disco no copia nada). Nunca pisa ni borra: si el destino ya existe, el viejo queda
 * donde está y se dice. Un enlace no se muda. Devuelve `{ moved: [[desde, hasta]], kept: [[desde, hasta, motivo]] }`.
 */
function moveOld(home) {
  const out = { moved: [], kept: [] };
  if (!TH || !TH.livesInOwnHome(home)) return out;
  const from = TH.claudeDir(home);
  const to = TH.ownStateDir(home);
  for (const name of STORES) {
    const src = path.join(from, name);
    const st = lstat(src);
    if (!st || st.isSymbolicLink()) continue;
    const dst = path.join(to, name);
    if (lstat(dst)) { out.kept.push([src, dst, `${dst} ya existe`]); continue; }
    try { fs.renameSync(src, dst); out.moved.push([src, dst]); } catch (e) { out.kept.push([src, dst, `no pude moverlo (${e.code || e.message})`]); }
  }
  return out;
}

module.exports = { looseLogsDir, looseLogPath, moveOld, STORES };

if (require.main === module && process.argv.includes('--move-old')) {
  // una línea por registro; nunca frena al aplicador
  try {
    const r = moveOld();
    for (const [src, dst] of r.moved) console.log(`✓ tycon: mudé ${src} a ${dst} (el historial de un hook, a la carpeta del estado)`);
    for (const [src, , why] of r.kept) console.log(`⚠ tycon: ${src} quedó donde está: ${why} — no piso ni borro historial; juntalos a mano si querés`);
  } catch (e) { console.log(`⚠ tycon: no pude mudar el historial de los hooks (${e.message})`); }
  process.exit(0);
}
