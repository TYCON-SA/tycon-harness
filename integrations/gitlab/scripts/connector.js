'use strict';
// connector.js — el conector de GitLab: atiende las operaciones que declara su integration.json y contesta siempre
// dentro del contrato de la capa. Además de `run`, le dice a la capa de qué repo es la dirección de un remoto
// (`identityFromRemote`): el servidor de una instalación propia no se conoce de antemano.

const OPERACIONES = { ...require('./work-items.js'), ...require('./change-requests.js'), ...require('./ci.js') };

function run(operacion, args, ctx) {
  const f = OPERACIONES[operacion];
  return f ? f(args, ctx) : { ok: false, reason: 'no_soportado', detail: `GitLab no atiende ${operacion}` };
}

module.exports = { run, identityFromRemote: require('./remote.js').identityFromRemote };
