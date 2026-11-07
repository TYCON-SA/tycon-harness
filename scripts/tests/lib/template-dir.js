'use strict';
/**
 * template-dir.js — lo fijo de un laboratorio de pruebas, armado una vez por proceso y copiado en cada caso.
 *
 * Por qué existe: las suites que arman repos de juguete los armaban de nuevo en cada caso (`git init`, commits, clones),
 * y eso era la mayor parte de los eventos de archivo de la suite completa. Lo fijo se arma una vez; cada caso trabaja
 * sobre una copia, así que un caso que cambia la suya no cambia la base ni a otro caso.
 *
 * Uso: `const p = plantilla('prefijo-', (dir, clave) => valor)`. `p.copiar(destino, clave)` copia la carpeta armada en
 * `destino` (que puede existir vacía) y devuelve el `valor` que dio `armar`; `p.obtener(clave)` da `{ dir, valor }` sin
 * copiar. Hay una plantilla por `clave` (por defecto, una sola): la clave es lo único de afuera de lo que depende el
 * armado. `p.armados` cuenta cuántas veces corrió `armar`, para las pruebas.
 *
 * Una falla de `armar` queda guardada: la carpeta se borra en el momento y cada pedido siguiente con esa clave vuelve a
 * lanzar el mismo error, sin reintentar.
 *
 * Cada plantilla vive en su propia carpeta de la temporal del sistema (`os.tmpdir()`), fuera de las carpetas que los
 * casos borran, y se borra al salir el proceso: al terminar, con un error, o con SIGINT, SIGTERM o SIGHUP. La señal sólo
 * se atiende si el proceso no tenía ya quien la atienda: con un manejador propio, la plantilla no la toca (ese manejador
 * decide, y si sale, borra `exit`). Al atenderla, se suelta de las tres, borra y la vuelve a mandar, así el proceso
 * termina como habría terminado sin plantilla; si el proceso sumó su manejador después, no la reenvía. Un corte sin aviso (SIGKILL) deja la carpeta en la temporal del sistema,
 * con el prefijo de quien la armó.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SENALES = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const vivas = new Set();
let enganchado = false;

function borrarTodas() {
  for (const dir of vivas) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* al salir no hay a quién avisarle */ }
  }
  vivas.clear();
}

function alRecibir(senal) {
  for (const s of SENALES) process.removeListener(s, MANEJADORES[s]);
  borrarTodas();
  // si el proceso sumó su propio manejador después de armar, ése ya la recibió y decide; si no, termina como siempre
  if (process.listenerCount(senal) === 0) process.kill(process.pid, senal);
}
const MANEJADORES = Object.fromEntries(SENALES.map((s) => [s, () => alRecibir(s)]));

function engancharLaSalida() {
  if (enganchado) return;
  enganchado = true;
  process.once('exit', borrarTodas);
  for (const s of SENALES) if (process.listenerCount(s) === 0) process.once(s, MANEJADORES[s]);
}

function plantilla(prefijo, armar) {
  const porClave = new Map();
  const p = {
    armados: 0,
    obtener(clave = '') {
      if (!porClave.has(clave)) {
        engancharLaSalida();
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefijo)));
        vivas.add(dir);
        p.armados++;
        try {
          porClave.set(clave, { dir, valor: armar(dir, clave) });
        } catch (error) {
          // la falla de armar es la que se guarda: si además no se puede borrar, la carpeta queda para el borrado al salir
          porClave.set(clave, { error });
          try {
            fs.rmSync(dir, { recursive: true, force: true });
            vivas.delete(dir);
          } catch (_) { /* sigue en `vivas` */ }
        }
      }
      const hecha = porClave.get(clave);
      // por la clave y no por el valor: un `throw undefined` (o 0, o '') también es una falla guardada
      if ('error' in hecha) throw hecha.error;
      return hecha;
    },
    copiar(destino, clave = '') {
      const { dir, valor } = p.obtener(clave);
      fs.cpSync(dir, destino, { recursive: true, verbatimSymlinks: true });
      return valor;
    },
  };
  return p;
}

module.exports = { plantilla };
