'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * lab-home.js — la casa de un guion de laboratorio, y la negativa a correr sobre el estado real de la máquina.
 *
 * Un guion de laboratorio arma su casa de juguete. Si la arma en `process.env.HOME` y alguien lo corre con la casa real,
 * escribe en la máquina de verdad: así una prueba dejó sin puesto a la coordinadora y otra reemplazó el tablero. Por eso:
 *   - `refuseRealHome(nombre)`, la primera línea de un guion, sale 3 si `HOME` es la casa de la cuenta o está adentro;
 *   - `labHouse(nombre)` da una carpeta nueva de `mkdtemp`, fuera de la casa de la cuenta;
 *   - `pruebaSobreLoReal(carpeta)` dice si una prueba (`TYCON_TEST_RUN=1`) va a escribir el estado real. La usan el
 *     tablero y la designación de la coordinadora, que se niegan.
 *
 * La casa de la cuenta sale de `real-home.js` (la base de usuarios del sistema), nunca de `HOME`; el estado real, de las
 * dos carpetas posibles de esa casa, sin mirar `TYCON_HOME`. Ninguna de estas preguntas reconoce una prueba por un
 * nombre: la marca es la variable, que `smoke-run.sh` pone en todo comando que lanza.
 *
 * CLI (para un guion de shell):
 *   node lab-home.js check <nombre>   sale 3 con la casa real; 0 si sigue
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const FOLD = process.platform === 'darwin' || process.platform === 'win32';
const fold = (p) => (FOLD ? p.toLowerCase() : p);

/** La casa de la cuenta; `userInfo` se inyecta sólo en proceso (las pruebas). */
function casaDeLaCuenta({ userInfo } = {}) {
  return require('./real-home.js').casaDeLaCuenta(userInfo ? { userInfo } : {});
}

/** La ruta real: la del tramo que existe, con lo que falta agregado tal cual. */
function real(p) {
  let base = path.resolve(String(p));
  const resto = [];
  for (;;) {
    try { return path.join(fs.realpathSync(base), ...resto); } catch (_) { /* sube un tramo */ }
    const arriba = path.dirname(base);
    if (arriba === base) return path.join(base, ...resto);
    resto.unshift(path.basename(base));
    base = arriba;
  }
}
/** ¿`p` es `base` o está adentro? Por ruta real. */
function adentro(p, base) {
  const a = fold(real(p));
  const b = fold(real(base));
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

const casaDelAmbiente = (env, platform = process.platform) => String((platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) || '').trim();

/**
 * La primera línea de un guion de laboratorio: con `HOME` igual a la casa de la cuenta, adentro de ella, o sin `HOME`,
 * sale 3 sin hacer nada y dice cómo correrlo. Devuelve la casa con que sigue.
 */
function refuseRealHome(nombre, { env = process.env, userInfo, exit = process.exit, err = (t) => process.stderr.write(t), platform = process.platform } = {}) {
  const quien = String(nombre || 'guion de laboratorio');
  const h = casaDelAmbiente(env, platform);
  let motivo = null;
  if (!h) motivo = 'no dice su HOME';
  else {
    try {
      const casa = casaDeLaCuenta({ userInfo });
      // la casa que da `labHouse` en Windows vive en la carpeta temporal del perfil: ésa no es la casa real
      if (adentro(h, casa) && !temporalDeWindows(h, casa, platform)) motivo = `su HOME (${h}) es la casa real de la cuenta`;
    } catch (e) { motivo = `no pude saber cuál es la casa de la cuenta (${e.message})`; }
  }
  if (motivo) {
    err(`🚫 ${quien}: no corre con la casa real: ${motivo}. Corrélo con una casa nueva, por ejemplo HOME="$(mktemp -d "\${TMPDIR:-/tmp}/lab.XXXXXX")" ${quien}, o por smoke-run.sh, que le da una casa aparte.\n`);
    exit(3);
  }
  return h;
}

/** ¿`base` es la carpeta temporal del sistema de Windows, que vive adentro del perfil? */
function temporalDeWindows(base, casa, platform = process.platform) {
  return platform === 'win32' && adentro(base, path.join(casa, 'AppData', 'Local', 'Temp'));
}

/** Una carpeta nueva de `mkdtemp`, fuera de la casa de la cuenta. Tira si la carpeta temporal cae adentro de ella. */
function labHouse(nombre, { env = process.env, userInfo } = {}) {
  const base = String(env.TMPDIR || env.TMP || env.TEMP || os.tmpdir());
  const casa = casaDeLaCuenta({ userInfo });
  if (adentro(base, casa) && !temporalDeWindows(base, casa)) {
    const e = new Error(`la carpeta temporal (${base}) está adentro de la casa de la cuenta (${casa}): la casa de laboratorio no se crea ahí`);
    e.code = 'LAB_HOUSE_INSIDE';
    throw e;
  }
  const seguro = String(nombre || 'lab').replace(/[^\w.-]+/g, '-').slice(0, 40);
  return fs.realpathSync(fs.mkdtempSync(path.join(base, `tycon-lab-${seguro}-`)));
}

/** Las dos carpetas de estado posibles de la casa de la cuenta, sin mirar `TYCON_HOME`. */
function estadosDeLaCuenta({ userInfo } = {}) {
  const casa = casaDeLaCuenta({ userInfo });
  const th = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));
  return [path.join(casa, th.OWN_DIR_NAME, 'state'), th.legacyStateDir(casa)];
}

/**
 * Con `TYCON_TEST_RUN=1`, ¿la carpeta de estado `dir` es la real de la cuenta? El motivo de la negativa, o null. Si no
 * se puede saber, también niega: en una prueba, ante la duda, no se escribe el estado real.
 */
function pruebaSobreLoReal(dir, { env = process.env, userInfo } = {}) {
  if (String(env.TYCON_TEST_RUN || '').trim() !== '1') return null;
  try {
    if (!estadosDeLaCuenta({ userInfo }).some((e) => fold(real(e)) === fold(real(dir)))) return null;
    return `una prueba (TYCON_TEST_RUN=1) no escribe el estado real de la máquina (${dir}): usá una carpeta de estado de juguete`;
  } catch (e) {
    return `una prueba (TYCON_TEST_RUN=1) no escribe el estado sin saber si es el real (${e.message})`;
  }
}

module.exports = { refuseRealHome, labHouse, pruebaSobreLoReal, estadosDeLaCuenta, adentro, real };

if (require.main === module) {
  const [cmd, nombre] = process.argv.slice(2);
  if (cmd === 'check') refuseRealHome(nombre);
  else {
    process.stderr.write('uso: lab-home.js check <nombre>\n');
    process.exit(2);
  }
}
