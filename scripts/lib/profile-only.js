'use strict';
// Las claves que vale SÓLO el perfil del equipo: ni una variable ni el archivo de la máquina las cambian. El perfil es
// versionado y se cambia con un pedido; la variable y el archivo de la máquina los puede escribir el agente que
// implementa, y estas claves abren la puerta a eximir un crítico, a firmar sin la persona o a subirse un tope: si las
// leyera de ahí, el agente se las abriría solo. Lo que el archivo de la máquina tenga escrito queda en `shadowed` con
// `by: 'solo-perfil'` y `explain` lo dice; `set` no la escribe.
//
// Vive en un archivo propio, chico, para que la revisión de un pedido pida la constancia del dueño cada vez que cambia
// (scripts/ci/controls-from-base.json): sacar una clave de acá la deja en manos de la máquina. La lee tycon-config.js.
module.exports = Object.freeze([
  'approvals.relay_session',
  'qa.manual_check',
  'approvals.delegated_signing',
  'guard.update',
  'approvals.delegated_machines',
  'approvals.owner_only',
  'approvals.levels',
  'site.url',
  'short_path.coordinator_max_files',
  'short_path.max_files',
  'approvals.delegation_wait_minutes',
  'pull_requests.team_authors',
]);
