'use strict';
/**
 * save-ok-lab.js — el ok de guardar de una corrida de laboratorio, armado con la misma biblioteca que usa
 * `marker.js approve-save` después de la firma. Para las suites que commitean dentro de una corrida sin probar la firma.
 *
 *   firmarGuardado(marcador, [repo])   // escribe la constancia en el marcador, con la huella de hoy de cada repo
 */
const fs = require('fs');
const path = require('path');

const SO = require(path.join(__dirname, '..', '..', 'lib', 'save-ok.js'));

function firmarGuardado(marcador, repos) {
  const m = JSON.parse(fs.readFileSync(marcador, 'utf8'));
  const previo = SO.antesDeFirmar({ via: 'ventana', marker: m, repos: repos.map((r) => fs.realpathSync(r)) });
  if (previo.codigo) throw new Error(`firmarGuardado: ${previo.motivo}`);
  // stable-data: la hora sólo dice cuándo se dio el ok; la vigencia se mide por la huella y la corrida, no por el reloj.
  m.saveOk = SO.constancia({ marker: m, via: 'ventana', previo, ahora: new Date().toISOString() });
  fs.writeFileSync(marcador, JSON.stringify(m));
}

module.exports = { firmarGuardado };
