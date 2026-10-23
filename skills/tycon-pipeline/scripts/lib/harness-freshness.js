'use strict';
/**
 * harness-freshness — ¿el Arranque corre con el arnés instalado y al día?
 *
 * `pipeline.js` lee los pasos de una ruta fija (`~/.claude/agent-skills/skills/tycon-pipeline/steps`). Si esa carpeta no
 * es la del arnés que corre (una copia vieja, una carpeta real que la actualización no reemplaza), `next` manda a pasos
 * que ya no existen y el modelo los sigue: la sesión de un dev leyó un paso de horas borrado dos versiones antes. Eso
 * frena el Arranque. Que haya una versión nueva, o que la última actualización haya fallado, no frena: lo dice el aviso
 * que el arranque de la sesión dejó en el estado del arnés (`state.notice`), sin ir a la red.
 *
 * Uso: revisar({ stepsDir, nextFile, scriptDir, home, leerEstado }) →
 *   { error?: <línea>, aviso?: <línea>, sinEstado?: <línea> }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const mismo = (a, b) => {
  const ra = real(a);
  const rb = real(b);
  return !!ra && !!rb && (process.platform === 'win32' || process.platform === 'darwin' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb);
};

/** El estado del arnés con el lector del árbol que corre: `{ status, state, reason }`. */
function estadoDelArbol(scriptDir, home) {
  const lector = path.join(scriptDir, '..', '..', '..', 'scripts', 'setup', 'harness', 'state.js');
  if (!fs.existsSync(lector)) return { status: 'missing', state: null, reason: 'el árbol que corre no trae el lector del estado' };
  try { return require(lector).read(home); } catch (e) { return { status: 'broken', state: null, reason: e.message }; }
}

function revisar({ stepsDir, nextFile, scriptDir, home = os.homedir(), leerEstado = estadoDelArbol } = {}) {
  const out = {};
  const propios = path.join(scriptDir, '..', 'steps');
  const st = leerEstado(scriptDir, home);
  const administrada = st && st.status === 'ok' && st.state && st.state.mode === 'managed' && typeof st.state.tree === 'string';
  const delArbol = administrada ? path.join(st.state.tree, 'skills', 'tycon-pipeline', 'steps') : null;
  const arreglo = 'El enlace ~/.claude/agent-skills tiene que llevar al arnés instalado: pedile a la persona que saque la copia vieja y corra «node ~/.tycon/harness/scripts/setup/harness.js install»; después, volvé a correr next.';
  if (!mismo(stepsDir, propios) || (delArbol && !mismo(stepsDir, delArbol))) {
    const esperada = real(delArbol || propios) || delArbol || propios;
    out.error = `arnés viejo: los pasos salen de ${real(stepsDir) || stepsDir}, y el arnés que corre los tiene en ${esperada}. ${arreglo}`;
    return out;
  }
  if (nextFile && !fs.existsSync(nextFile)) {
    out.error = `arnés viejo: el paso que toca (${path.basename(nextFile)}) no está en ${real(stepsDir) || stepsDir}. ${arreglo}`;
    return out;
  }
  // sin estado (un clon de desarrollo, una casa de prueba) no hay instalación que comparar: no se dice nada; un estado
  // que existe y no se lee, sí
  if (!st || st.status === 'missing') return out;
  if (st.status !== 'ok') out.sinEstado = `arnés: no sé si está al día (${st.reason || st.status}).`;
  else if (st.state && typeof st.state.notice === 'string' && st.state.notice.trim()) {
    out.aviso = `arnés: ${st.state.notice.trim()} — «node ~/.tycon/harness/scripts/setup/harness.js doctor» lo detalla.`;
  }
  return out;
}

module.exports = { revisar, estadoDelArbol };
