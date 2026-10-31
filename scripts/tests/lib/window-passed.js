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
 *   conVentana(env, { arbol: { arbol, pid, ahora } }) → la firma NO se da por pasada: va por la verificación de verdad
 *                       (el registro que dejó el freno de la prueba) con el árbol de procesos y la hora que dice la
 *                       prueba, y la casa de juguete
 *   conVentana(env, { sesionEn: '<archivo>' }) → al salir, el guion deja en ese archivo su variable de sesión
 *   arbolDelFreno() / arbolDelGuion(casa, cmd) → los árboles de procesos de la prueba: el del freno, para `decidir`
 *                       (pid 201), y el del guion que corre `cmd` (pid 301)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const { casaDeLaCuenta } = require(path.join(RAIZ, 'scripts', 'lib', 'real-home.js'));
const MODULO_DE_LA_VENTANA = /[\\/]scripts[\\/]lib[\\/]owner-window\.js$/;

function conVentana(env = process.env, { delegadaPor, arbol, sesionEn } = {}) {
  const previas = String(env.NODE_OPTIONS || '').trim();
  const out = { ...env, NODE_OPTIONS: `${previas ? `${previas} ` : ''}--require ${__filename}` };
  if (delegadaPor) out.WINDOW_PASSED_DELEGATED_BY = delegadaPor;
  if (arbol) out.WINDOW_PASSED_TREE = JSON.stringify(arbol);
  if (sesionEn) out.WINDOW_PASSED_SESSION_OUT = sesionEn;
  return out;
}

// El árbol de procesos de la prueba, para `conVentana(env, { arbol })`: la herramienta (pid 100) y, debajo, el freno
// (pid 201, el que arma el pedido con `decidir`) o el guion (pid 301) envuelto como lo corre la herramienta.
const INICIO = 'Tue Oct 27 10:00:00 2026';
const BASE_DEL_ARBOL = [{ pid: 1, ppid: 0, inicio: 'Mon Oct 26 08:00:00 2026', comando: '/sbin/launchd' },
  { pid: 100, ppid: 1, inicio: INICIO, comando: '/Applications/x/native-binary/claude --output-format stream-json --verbose' }];
const envolver = (casa, cmd) => `/bin/zsh -c source ${casa}/.claude/shell-snapshots/snapshot-zsh-1793030721191-z5n7vi.sh 2>/dev/null || true`
  + ' && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true'
  + " && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true"
  + ` && eval '${cmd.replace(/'/g, `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-b725-cwd`;
const arbolDelFreno = () => [...BASE_DEL_ARBOL,
  { pid: 200, ppid: 100, inicio: INICIO, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
  { pid: 201, ppid: 200, inicio: INICIO, comando: 'node /h/scripts/lib/owner-window.js gate' }];
const arbolDelGuion = (casa, cmd) => [...BASE_DEL_ARBOL,
  { pid: 300, ppid: 100, inicio: INICIO, comando: envolver(casa, cmd) },
  { pid: 301, ppid: 300, inicio: INICIO, comando: cmd }];

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

// La firma por pasada: la terminal y el pedido para otra sesión sin delegación siguen por el camino de verdad.
function darPorPasada(ow) {
  if (!ow || typeof ow.exigir !== 'function' || ow.exigir.porPasada) return;
  const exigir = ow.exigir;
  // con el árbol de la prueba, nada pasa solo: la verificación de verdad, con ese árbol y la casa de juguete
  if (process.env.WINDOW_PASSED_TREE) {
    const deLaPrueba = JSON.parse(process.env.WINDOW_PASSED_TREE);
    const conArbol = (o = {}) => exigir({ ...o, arbol: deLaPrueba.arbol, pid: deLaPrueba.pid, ahora: deLaPrueba.ahora, casa: os.homedir() });
    conArbol.porPasada = true;
    ow.exigir = conArbol;
    return;
  }
  const porPasada = (o = {}) => {
    const argv = o.argv || process.argv.slice(1);
    if (argv.includes('--terminal')) return exigir(o);
    const i = argv.indexOf('--for-session');
    const pedida = i >= 0 ? argv[i + 1] : null;
    const delegadaPor = process.env.WINDOW_PASSED_DELEGATED_BY || null;
    // la delegación firma para otra sesión desde la coordinadora; sin ella, el pedido para otra sesión va por el de verdad
    if (pedida && o.propia && pedida !== o.propia && !delegadaPor) return exigir(o);
    const destino = pedida || o.propia || null;
    const via = delegadaPor ? 'delegacion' : 'ventana';
    const sesion = delegadaPor || destino;
    // como la ventana de verdad: lo que el guion comprueba antes de firmar, y los campos que suma a la firma
    if (o.antes) {
      const n = o.antes(via, { via, sesion, destino });
      if (n && n.codigo) return { codigo: n.codigo, motivo: n.motivo };
    }
    ow.firmar({ firma: o.firma, via, sesion, destino, resumen: o.resumen || '', casa: os.homedir(), anotar: o.anotar, extra: o.extra });
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
  const sesionEn = process.env.WINDOW_PASSED_SESSION_OUT;
  if (sesionEn) process.on('exit', () => { try { fs.writeFileSync(sesionEn, String(process.env.CLAUDE_CODE_SESSION_ID || '')); } catch (_) { /* la prueba lo nota */ } });
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

module.exports = { conVentana, tocaLaCasaReal, arbolDelFreno, arbolDelGuion };
