'use strict';
/**
 * window-passed.js — en las pruebas que lanzan un guion de firma por subproceso, da la ventana de permiso por pasada.
 *
 * Desde una sesión, el dueño aprueba cada firma en la ventana de permiso y el guion lo comprueba en el árbol de procesos
 * (scripts/lib/owner-window.js). Una prueba que lanza marker.js, pipeline.js, e2e-setup.js o run-base-controls.sh por
 * subproceso no tiene esa ventana. La que necesita la firma dada para probar lo que viene después (el plan aprobado,
 * la línea del registro de aprobaciones, el cierre de la corrida) lanza el guion con
 * `NODE_OPTIONS=--require <este archivo>` (`conVentana(env)`): la firma queda anotada con `via: ventana`, como la deja
 * la ventana. Vale también para un arnés copiado a otra carpeta: se reconoce el módulo de la ventana por su ruta. La
 * verificación misma se prueba en proceso, con el árbol inyectado (scripts/tests/owner-window.test.js), y cada guion
 * tiene su prueba de que sin la ventana no firma.
 *
 * Sólo con una HOME de prueba: si el estado que usaría el guion cae en la casa de la cuenta (por `HOME`, por
 * `TYCON_HOME` o por un enlace), el proceso termina sin firmar nada. Así no sirve para firmar en el estado real de nadie. Y ningún guion fuera de las carpetas de pruebas lo nombra
 * (window-passed-guard.test.js).
 *
 *   conVentana(env)   → una copia de `env` con NODE_OPTIONS que carga este archivo
 *   conVentana(env, { delegadaPor: '<sesión>' }) → la firma queda como la deja la delegación del perfil: `via: delegacion`,
 *                       firmada por esa sesión (la coordinadora)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const { casaDeLaCuenta } = require(path.join(RAIZ, 'scripts', 'lib', 'real-home.js'));
const MODULO_DE_LA_VENTANA = /[\\/]scripts[\\/]lib[\\/]owner-window\.js$/;

function conVentana(env = process.env, { delegadaPor } = {}) {
  const previas = String(env.NODE_OPTIONS || '').trim();
  const out = { ...env, NODE_OPTIONS: `${previas ? `${previas} ` : ''}--require ${__filename}` };
  if (delegadaPor) out.WINDOW_PASSED_DELEGATED_BY = delegadaPor;
  return out;
}

// La ruta con los enlaces resueltos, aunque el final todavía no exista.
function sinEnlaces(p) {
  const abs = path.resolve(p);
  const resto = [];
  let cabeza = abs;
  for (;;) {
    try { return path.join(fs.realpathSync(cabeza), ...resto); } catch (_) { /* no existe: se sube uno */ }
    const arriba = path.dirname(cabeza);
    if (arriba === cabeza) return abs;
    resto.unshift(path.basename(cabeza));
    cabeza = arriba;
  }
}
const adentro = (hijo, padre) => hijo === padre || hijo.startsWith(padre.endsWith(path.sep) ? padre : padre + path.sep);

/**
 * ¿El estado que usaría el guion cae en la casa de la cuenta? Se miran las tres raíces de donde sale: la HOME, la casa
 * propia (`TYCON_HOME` absoluto, o `<home>/.tycon`: la regla de ownRootOf en tycon-home.js) y la carpeta de Claude Code.
 * Cuenta si una es la casa de la cuenta, o si una y la casa propia o la carpeta de Claude Code de la cuenta están una
 * adentro de la otra. Una HOME de prueba adentro de la casa de la cuenta (un worktree) no cuenta. Si algo no se puede
 * resolver, cuenta.
 */
function tocaLaCasaReal({ home = os.homedir(), env = process.env, real } = {}) {
  try {
    const cuenta = sinEnlaces(real === undefined ? casaDeLaCuenta() : real);
    const delaCuenta = [path.join(cuenta, '.tycon'), path.join(cuenta, '.claude')];
    const t = env.TYCON_HOME === undefined ? '' : String(env.TYCON_HOME).trim();
    const raices = [home, t && path.isAbsolute(t) ? t : path.join(home, '.tycon'), path.join(home, '.claude')].map(sinEnlaces);
    return raices.some((r) => r === cuenta || delaCuenta.some((c) => adentro(r, c) || adentro(c, r)));
  } catch (_) { return true; }
}

// La firma por pasada: la terminal y el pedido para otra sesión siguen por el camino de verdad.
function darPorPasada(ow) {
  if (!ow || typeof ow.exigir !== 'function' || ow.exigir.porPasada) return;
  const exigir = ow.exigir;
  const porPasada = (o = {}) => {
    const argv = o.argv || process.argv.slice(1);
    if (argv.includes('--terminal')) return exigir(o);
    const i = argv.indexOf('--for-session');
    const pedida = i >= 0 ? argv[i + 1] : null;
    if (pedida && o.propia && pedida !== o.propia) return exigir(o);
    const destino = pedida || o.propia || null;
    const delegadaPor = process.env.WINDOW_PASSED_DELEGATED_BY || null;
    const via = delegadaPor ? 'delegacion' : 'ventana';
    const sesion = delegadaPor || destino;
    ow.firmar({ firma: o.firma, via, sesion, destino, resumen: o.resumen || '', casa: os.homedir(), anotar: o.anotar });
    return { codigo: 0, via, destino, sesion };
  };
  porPasada.porPasada = true;
  ow.exigir = porPasada;
}

// Cargado como `--require` (antes del guion: todavía no hay `require.main`), reemplaza la verificación de la ventana en
// cada copia del módulo que el guion cargue. Cargado con `require` desde una prueba (para `conVentana`), no cambia nada.
if (!require.main) {
  if (tocaLaCasaReal()) {
    process.stderr.write('window-passed.js: sólo con una HOME de prueba; con el estado en la casa de la cuenta (HOME o TYCON_HOME) no firma nada.\n');
    process.exit(3);
  }
  const cargar = Module._load;
  Module._load = function cargarConVentana(pedido, padre, esPrincipal) {
    const exportado = cargar.apply(this, arguments);
    if (!String(pedido).includes('owner-window')) return exportado;
    let archivo = '';
    try { archivo = Module._resolveFilename(pedido, padre, esPrincipal); } catch (_) { /* un módulo del sistema */ }
    if (MODULO_DE_LA_VENTANA.test(archivo)) darPorPasada(exportado);
    return exportado;
  };
}

module.exports = { conVentana, tocaLaCasaReal };
