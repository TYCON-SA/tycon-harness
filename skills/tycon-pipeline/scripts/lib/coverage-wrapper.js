'use strict';
/**
 * coverage-wrapper.js — lanza UNA suite como proceso hijo, para que el medidor de cobertura de Node la mida.
 *
 * run-suites-json.js, con la cobertura pedida, corre cada suite así:
 *     node --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=<suite>.lcov \
 *          --test-coverage-exclude=<este archivo> coverage-wrapper.js <ejecutable> <suite>
 * El medidor sólo arranca con una prueba de `node:test` en marcha, y mide también lo que corre en los procesos hijos
 * (les deja su carpeta en la variable de V8). Por eso hace falta este envoltorio: una suite de bash, o un `.js` suelto
 * que no usa `node:test`, quedarían sin medir si se los corriera directo.
 *
 * La suite corre igual que sin medir: con su salida tal cual (la del medidor va al archivo, no a la pantalla) y con su
 * mismo código de salida; murió por una señal → 124, no arrancó → 127, como cuenta el corredor de suites.
 */
const { test } = require('node:test');
const { spawnSync } = require('child_process');

const [ejecutable, suite] = process.argv.slice(2);
if (!ejecutable || !suite) {
  process.stderr.write('uso: coverage-wrapper.js <ejecutable> <suite>\n');
  process.exit(2);
}
// Hasta que la suite devuelva su código, «no corrió»: si algo tira antes, el envoltorio no puede salir 0.
let status = 127;

test(`suite ${suite}`, () => {
  const r = spawnSync(ejecutable, [suite], { stdio: 'inherit', windowsHide: true });
  if (r.error) {
    process.stderr.write(`[coverage-wrapper] no pude lanzar ${ejecutable} ${suite}: ${r.error.message}\n`);
    status = 127;
  } else {
    status = r.status === null ? 124 : r.status;
  }
});

// `node:test` pone su propio código al terminar: el de la suite se pone después, al salir.
process.on('exit', () => { process.exitCode = status; });
