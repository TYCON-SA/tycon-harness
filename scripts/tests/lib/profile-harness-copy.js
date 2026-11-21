'use strict';
/**
 * profile-harness-copy.js — un arnés copiado a una carpeta temporal, con su propio perfil del equipo.
 *
 * Las claves que vale sólo el perfil (PROFILE_ONLY, como los topes del camino corto) salen del perfil del ÁRBOL donde
 * vive el lector: ni una variable ni la casa de prueba las cambian. Para probar un guion de consola con un perfil
 * configurado, el guion corre desde una copia del árbol que trae ese perfil. Se copian sólo `scripts/lib` y
 * `skills/tycon-pipeline`, sin sus pruebas: lo que cargan `marker.js` y sus bibliotecas.
 *
 *   copiaConPerfil(t, perfil) → { raiz, marker }   la copia se borra al terminar la prueba `t`
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..', '..');
const SIN = new Set(['tests', 'node_modules', '.advisors']);

function copiar(desde, hasta) {
  fs.cpSync(desde, hasta, { recursive: true, filter: (f) => !SIN.has(path.basename(f)) });
}

function copiaConPerfil(t, perfil) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'arnes-con-perfil-'));
  if (t && typeof t.after === 'function') t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  copiar(path.join(RAIZ, 'scripts', 'lib'), path.join(raiz, 'scripts', 'lib'));
  copiar(path.join(RAIZ, 'skills', 'tycon-pipeline'), path.join(raiz, 'skills', 'tycon-pipeline'));
  if (perfil !== undefined && perfil !== null) {
    fs.writeFileSync(path.join(raiz, 'team-profile.json'), typeof perfil === 'string' ? perfil : JSON.stringify(perfil, null, 2));
  }
  return { raiz, marker: path.join(raiz, 'skills', 'tycon-pipeline', 'scripts', 'marker.js') };
}

module.exports = { copiaConPerfil };
