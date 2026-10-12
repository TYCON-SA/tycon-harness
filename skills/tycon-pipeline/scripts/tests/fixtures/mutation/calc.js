'use strict';
// Fixture del chequeo de mutantes (control positivo de test-mutation-check.js):
//   - `esPar` ESTÁ cubierta por calc.test.js → su mutante TIENE que morir.
//   - `nuncaTesteada` NO tiene ningún test → sus mutantes TIENEN que sobrevivir.
// Si alguna de las dos filas no se enciende, el instrumento está roto.
function esPar(n) {
  return n % 2 === 0;
}
function nuncaTesteada(a) {
  if (a >= 1) {
    return true;
  }
  return false;
}
module.exports = { esPar, nuncaTesteada };
