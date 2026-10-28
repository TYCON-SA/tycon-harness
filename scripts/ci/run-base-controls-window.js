'use strict';
// La ventana nueva de Windows de `run-base-controls.sh approve --terminal` corre este archivo con node. El guion de
// bash le pasa su programa a node por la entrada estándar, y en la ventana la entrada tiene que ser la consola: ahí se
// escriben las tres palabras. Esto corre el mismo programa, leído del guion de su misma carpeta.
const fs = require('fs');
const path = require('path');
const Module = require('module');

const guion = path.join(__dirname, 'run-base-controls.sh');
const texto = fs.readFileSync(guion, 'utf8');
const inicio = /<<'JS'\r?\n/.exec(texto);
const fin = inicio ? texto.slice(inicio.index).search(/\r?\nJS\r?\n/) : -1;
if (!inicio || fin < 0) {
  console.error(`🔒 run-base-controls approve: no encuentro el programa dentro de ${guion}: no se firmó nada.`);
  process.exit(9);
}
const programa = new Module(guion, module);
programa.filename = guion;
programa.paths = Module._nodeModulePaths(__dirname);
programa._compile(texto.slice(inicio.index + inicio[0].length, inicio.index + fin + 1), guion);
