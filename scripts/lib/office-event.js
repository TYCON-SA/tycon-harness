'use strict';
/*
 * office-event.js — el aviso corto al proceso local de la oficina: «cambió algo, recalculá la foto».
 *
 * Lo manda quien cambia el estado de una sesión (el guardado del marcador del pipeline, la ventana del dueño) y el gancho
 * de arranque. `notify` no espera nada y no puede cambiar el resultado del comando que avisa: sin el candado del proceso
 * vuelve enseguida; con el candado, lanza este mismo archivo como un proceso suelto, así un `process.exit()` justo después
 * no corta el aviso. Ese proceso tiene un tope de 200 ms y se calla ante cualquier error. Un aviso perdido no rompe nada:
 * la vigilancia de carpetas del proceso lo ve después.
 *
 * Casos: scripts/tests/office-site-link.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { stateDir } = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));

const TIMEOUT_MS = 200;

/** Avisa al proceso local. Nunca tira. `type` es `changed` (cambió algo) o `session` (se abrió una sesión). */
function notify(sid, { home = os.homedir(), type = 'changed' } = {}) {
  try {
    const lock = path.join(stateDir(home), 'office', 'server.json');
    if (!fs.existsSync(lock)) return;
    const child = spawn(process.execPath, [__filename, lock, type, String(sid || '')], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => { /* sin proceso no hay aviso */ });
    child.unref();
  } catch { /* el aviso nunca frena a quien avisa */ }
}

function send(lockFile, type, sid) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  setTimeout(() => process.exit(0), TIMEOUT_MS);
  const req = http.request({ host: '127.0.0.1', port: lock.port, path: `/event?t=${lock.token}`, method: 'POST', timeout: TIMEOUT_MS, headers: { host: `127.0.0.1:${lock.port}`, 'content-type': 'application/json' } }, (res) => {
    res.resume();
    res.on('end', () => process.exit(0));
  });
  req.on('error', () => process.exit(0));
  req.end(JSON.stringify({ type, sid }));
}

if (require.main === module) {
  try { send(process.argv[2], process.argv[3], process.argv[4]); } catch { process.exit(0); }
}

module.exports = { notify };
