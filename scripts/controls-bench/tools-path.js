#!/usr/bin/env node
'use strict';
/**
 * tools-path.js — dónde están `claude` y `codex`, sin depender del PATH.
 *
 * ── EL PROBLEMA ─────────────────────────────────────────────────────────────────────────────────
 * launchd lanza sus trabajos con el PATH mínimo de macOS —`/usr/bin:/bin:/usr/sbin:/sbin`— y los binarios `claude` y
 * `codex` viven en el bin de Node (nvm), que no está ahí. Si el plist lleva la ruta ABSOLUTA de node, node arranca,
 * pero todo lo que el examen lanza después por NOMBRE PELADO (`spawnSync('claude', …)`) falla con `ENOENT`: el
 * disparador así generado NUNCA puede completar un examen. Una sesión de shell sí tiene PATH y por eso no lo nota.
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
 * funciona. Fallar acá rompería las máquinas con PATH normal para arreglar la que no lo tiene.
 *
 * ── POR QUÉ ES UN ARCHIVO PROPIO ────────────────────────────────────────────────────────────────
 * Lo consumen `periodic-exam.js` (la sonda y el instalador) y `advisor-runner.js` (las ~580
 * invocaciones del examen, que fallarían TODAS por lo mismo, una por una). No puede vivir en
 * `advisor-runner.js` porque requerirlo ARRANCA EL BANCO ENTERO (el mismo motivo por el que
 * `report-name.js` es un archivo aparte), y ponerlo en `periodic-exam.js` obligaría al runner a
 * requerir a quien lo envuelve. Mismo patrón de la casa: la lógica que hay que poder probar barato
 * vive afuera.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * ── EL NODE DEL ARNÉS ────────────────────────────────────────────────────────────────────────────
 * El disparador corre con el Node propio del arnés (`<casa>/node/current`), que NO es
 * el paquete de npm global donde viven `claude` y `codex`: al lado de ese node no están. Por eso,
 * al instalar el disparador, `periodic-exam.js` anota en `<estado>/exam-tools.json` la carpeta donde
 * el PATH de quien instala tiene a cada una, y acá se busca: primero al lado del node, después en
 * esa carpeta, y por último el nombre pelado (el plan B). La carpeta va en un archivo
 * aparte y no en el plist, por la misma razón de arriba: el plist se compara byte a byte.
 */
const EXAM_TOOLS = 'exam-tools.json';
// la carpeta del estado la sabe tycon-home.js; sin ese archivo (un laboratorio que copia carpetas sueltas) no hay anotación
function archivoDeHerramientas(home = os.homedir()) {
  try { return path.join(require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js')).stateDir(home), EXAM_TOOLS); } catch (_) { return null; }
}
/** Las carpetas anotadas al instalar: `{ claude, codex }` (cada una, una carpeta o null). Sin archivo, vacías. */
function carpetasAnotadas(file = archivoDeHerramientas()) {
  if (!file) return { claude: null, codex: null };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return { claude: typeof j.claude === 'string' ? j.claude : null, codex: typeof j.codex === 'string' ? j.codex : null }; } catch (_) { return { claude: null, codex: null }; }
}
/** Anota dónde están `claude` y `codex` según ESTE PATH (el de quien instala). Devuelve lo anotado. */
function anotarCarpetas({ env = process.env, file = archivoDeHerramientas(), ejecutable = ejecutablePorDefecto } = {}) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const where = (bin) => dirs.find((d) => ejecutable(path.join(d, bin))) || null;
  const out = { claude: where('claude'), codex: where('codex'), at: new Date().toISOString() };
  if (!file) return out;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

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
  const candidatas = [];
  if (nodeBin) candidatas.push(path.join(path.dirname(nodeBin), bin));
  // la carpeta anotada al instalar el disparador: ahí quedó la herramienta en el PATH de quien instaló
  const anotada = (opts.anotadas || carpetasAnotadas())[bin];
  if (anotada) candidatas.push(path.join(anotada, bin));
  return candidatas.find((c) => ejecutable(c)) || bin;
}

/** ¿Se puede LANZAR? Responde el ENOENT, NO si la sesión puede trabajar (eso es la sonda). */
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
 * 🔴 La ruta absoluta NO alcanza sola: `codex` no es un binario, es
 * un script `#!/usr/bin/env node` — se lo puede lanzar por ruta absoluta y aun así muere con 127,
 * porque `env` busca `node` EN EL PATH, que bajo launchd no lo tiene. (`claude` zafa de casualidad:
 * es un Mach-O nativo.) Lo mismo vale para cualquier subproceso que las herramientas lancen por
 * dentro. La reparación se DEDUCE de `process.execPath` —cero dependencia de entorno externo— y va
 * en el PROCESO, no en el plist: el plist se compara byte a byte para no reinstalarse en cada
 * arranque, y un PATH escrito ahí volvería a depender de quién invocó al instalador.
 */
function asegurarPathDeHerramientas(env = process.env, nodeBin = process.execPath, anotadas = carpetasAnotadas()) {
  // primero las carpetas anotadas: con el Node del arnés en el disparador, `codex` (`#!/usr/bin/env node`)
  // tiene que encontrar el `node` de SU carpeta, el del dev; después la del node que corre, como siempre
  const dirs = [...new Set([anotadas.codex, anotadas.claude, path.dirname(nodeBin)].filter(Boolean))];
  let partes = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs.reverse()) if (!partes.includes(dir)) partes = [dir].concat(partes);
  env.PATH = partes.join(path.delimiter);
  return env.PATH;
}

module.exports = { rutaDeHerramienta, seAlcanza, ejecutablePorDefecto, asegurarPathDeHerramientas, carpetasAnotadas, anotarCarpetas, archivoDeHerramientas, EXAM_TOOLS };
