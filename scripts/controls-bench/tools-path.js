#!/usr/bin/env node
'use strict';
/**
 * tools-path.js —dónde están `claude` y `codex`, sin depender del PATH.
 *
 * ── EL INCIDENTE (2026-09-04) ───────────────────────────────────────────────────────────────────
 * El examen de los revisores no corrió el viernes, y no fue por el horario: el disparador arrancó
 * puntual (02:00:04) y murió cuatro segundos después. launchd lanza sus trabajos con el PATH mínimo
 * de macOS —`/usr/bin:/bin:/usr/sbin:/sbin`— y los binarios `claude` y `codex` viven en el bin de
 * Node (nvm), que no está ahí. El plist llevaba la ruta ABSOLUTA de node —por eso node sí arrancó—
 * pero todo lo que el examen lanza después iba por NOMBRE PELADO: `spawnSync('claude', …)` →
 * `ENOENT`. No es un evento: el disparador, tal como se generaba, NUNCA pudo completar un examen.
 * La única corrida completa que existía (31/8) la lanzó una sesión de shell, que sí tiene PATH.
 *
 * ── POR QUÉ LA RUTA ABSOLUTA Y NO "ESCRIBIR UN PATH EN EL PLIST" ────────────────────────────────
 * Escribirle un PATH al plist arregla el síntoma y agrega dos problemas. Uno: el plist se compara
 * BYTE A BYTE para no reinstalarse en cada arranque de sesión (ver `instalarTarea`), y un PATH
 * copiado del entorno cambia según quién invoque al instalador — el disparador se reescribiría, con
 * su `bootout`/`bootstrap`, varias veces por día. Dos: deja el arreglo dependiendo de una variable
 * de entorno, que es exactamente la clase de cosa que falló. Acá no hay variable: se deduce del
 * proceso que está corriendo.
 *
 * ── LA DEDUCCIÓN ────────────────────────────────────────────────────────────────────────────────
 * `claude`, `codex` y `node` son el MISMO paquete de npm global: viven los tres en el mismo
 * directorio. Entonces `dirname(process.execPath)` —el node que launchd acaba de lanzar por ruta
 * absoluta— es también el directorio de las herramientas. Se deduce sola, y sigue siendo correcta
 * el día que nvm cambie de versión, porque se recalcula en cada corrida.
 *
 * 🔴 EL PLAN B ES EL NOMBRE PELADO, NO UN ERROR. Si al lado de node no está la herramienta (un
 * `npm i -g` con otro prefijo, un Homebrew, Windows con `.cmd`), se devuelve el nombre tal cual y
 * `spawnSync` lo resuelve por PATH como siempre. El arreglo AGREGA un camino; no saca el que ya
 * funcionaba. Fallar acá sería romper las máquinas que hoy andan para arreglar la que no.
 *
 * ── POR QUÉ ES UN ARCHIVO PROPIO ────────────────────────────────────────────────────────────────
 * Lo consumen `periodic-exam.js` (la sonda y el instalador) y `advisor-runner.js` (las ~580
 * invocaciones del examen — que habrían fallado TODAS por lo mismo, una por una). No puede vivir en
 * `advisor-runner.js` porque requerirlo ARRANCA EL BANCO ENTERO (el mismo motivo por el que se
 * extrajo `report-name.js`), y ponerlo en `periodic-exam.js` obligaría al runner a
 * requerir a quien lo envuelve. Mismo patrón de la casa: la lógica que hay que poder probar barato
 * vive afuera.
 */
const fs = require('fs');
const path = require('path');

/** Un archivo que existe y se puede ejecutar. Un directorio con ese nombre NO cuenta. */
function ejecutablePorDefecto(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;   // no está, o no se puede mirar: para el caso es lo mismo
  }
}

/**
 * La ruta con la que hay que lanzar `bin`.
 *
 * @param {string} bin            'claude' | 'codex'
 * @param {object} [opts]
 * @param {string} [opts.nodeBin] el node de referencia (default: el que está corriendo)
 * @param {function} [opts.ejecutable] inyección para las pruebas
 * @returns {string} la ruta absoluta si la herramienta está al lado de node; si no, `bin` tal cual.
 */
function rutaDeHerramienta(bin, opts = {}) {
  const nodeBin = opts.nodeBin || process.execPath;
  const ejecutable = opts.ejecutable || ejecutablePorDefecto;
  if (!bin || path.isAbsolute(bin)) return bin;          // ya viene resuelto: no se toca
  if (!nodeBin) return bin;
  const candidata = path.join(path.dirname(nodeBin), bin);
  return ejecutable(candidata) ? candidata : bin;
}

/** ¿Se puede LANZAR? Responde el ENOENT del incidente — NO si la sesión puede trabajar (eso es la sonda). */
function seAlcanza(bin, opts = {}) {
  const spawnSync = opts.spawnSync || require('child_process').spawnSync;
  const ruta = rutaDeHerramienta(bin, opts);
  const r = spawnSync(ruta, ['--version'], { encoding: 'utf8', timeout: 60000 });
  if (r.error) return { ok: false, ruta, motivo: r.error.message };
  return { ok: true, ruta };
}

/**
 * Repara el PATH DEL PROCESO: antepone el directorio de node si no está.
 *
 * 🔴 La ruta absoluta NO alcanza sola, y esto se MIDIÓ (2026-09-05): `codex` no es un binario, es
 * un script `#!/usr/bin/env node` — se lo puede lanzar por ruta absoluta y aun así muere con 127,
 * porque `env` busca `node` EN EL PATH, que bajo launchd no lo tiene. (`claude` zafa de casualidad:
 * es un Mach-O nativo.) Lo mismo vale para cualquier subproceso que las herramientas lancen por
 * dentro. La reparación se DEDUCE de `process.execPath` —cero dependencia de entorno externo— y va
 * en el PROCESO, no en el plist: el plist se compara byte a byte para no reinstalarse en cada
 * arranque, y un PATH escrito ahí volvería a depender de quién invocó al instalador.
 */
function asegurarPathDeHerramientas(env = process.env, nodeBin = process.execPath) {
  const dir = path.dirname(nodeBin);
  const partes = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  if (!partes.includes(dir)) env.PATH = [dir].concat(partes).join(path.delimiter);
  return env.PATH;
}

module.exports = { rutaDeHerramienta, seAlcanza, ejecutablePorDefecto, asegurarPathDeHerramientas };
