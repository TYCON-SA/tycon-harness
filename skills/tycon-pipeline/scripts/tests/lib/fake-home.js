'use strict';
/**
 * fake-home.js — la carpeta personal de juguete de las suites de Node (el par de scripts/tests/lib/fake-home.sh).
 *
 * En Windows `os.homedir()` lee `USERPROFILE`, no `HOME`: una prueba que cambia sólo `HOME` deja que el guion que
 * lanza escriba el marcador y los registros en la carpeta personal REAL de quien corre la suite. Las dos variables
 * se cambian juntas, siempre por acá (lo vigila scripts/tests/fake-home-userprofile.test.js).
 *
 *   spawnSync(node, [guion], { env: { ...process.env, ...fakeHomeEnv(casa) } })
 *   conCarpetaPersonal(casa, () => { ...código que llama a os.homedir() dentro del proceso... })
 */

/** Las variables de la carpeta personal apuntando a `dir`, para extender un `env`. */
function fakeHomeEnv(dir) {
  return { HOME: dir, USERPROFILE: dir };
}

/**
 * Pone `process.env.HOME` y `USERPROFILE` en `dir` y devuelve la función que las restaura (una variable que no
 * estaba se borra). Para cuando el cambio y la vuelta quedan en lugares distintos, como un `try`/`finally`.
 */
function ponerCarpetaPersonal(dir) {
  const antes = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, fakeHomeEnv(dir));
  return () => {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}

/** Corre `fn` con la carpeta personal en `dir` y restaura las dos variables, también si `fn` lanza. */
function conCarpetaPersonal(dir, fn) {
  const volver = ponerCarpetaPersonal(dir);
  try {
    return fn();
  } finally {
    volver();
  }
}

module.exports = { fakeHomeEnv, ponerCarpetaPersonal, conCarpetaPersonal };
