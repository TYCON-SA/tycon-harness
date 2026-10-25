'use strict';
// contract.js — el contrato de la capa de plataforma: las operaciones del dominio, los motivos con que una contesta que
// no, y qué decide la plataforma de cada operación. Lo comparten el lector de integraciones (que valida los manifiestos
// de los conectores) y la capa (scripts/lib/platform/platform.js), sin requerirse entre ellos.

// Las doce operaciones: cinco del pedido de trabajo (crear, cambiar, cerrar, buscar por etiqueta y leer su estado), tres
// del pedido de cambio, lo asignado, la CI, la cola y los despliegues. Un conector declara cuáles implementa; las demás
// contestan no_soportado.
const OPERATIONS = Object.freeze([
  'work-item.create', 'work-item.update', 'work-item.close', 'work-item.find', 'work-item.read',
  'change-request.open', 'change-request.vote', 'change-request.list',
  'assigned.list', 'ci.read', 'queue.read', 'deployments.read',
]);

// Los motivos de un «no». Una lectura que falló es no_medido: nunca una lista vacía ni un cero.
const REASONS = Object.freeze(['sin_plataforma', 'sin_credencial', 'no_soportado', 'no_encontrado', 'rechazado', 'red', 'no_medido']);

// Las operaciones atadas a un repo: van por la plataforma que declara ese repo en team-repos.json.
const REPO_OPERATIONS = Object.freeze(['change-request.open', 'change-request.vote', 'change-request.list', 'ci.read']);

// Las demás las elige el perfil del equipo (`integrations.platform`): por su área, o por el valor por defecto.
const AREAS = Object.freeze(['default', 'workItems', 'queue']);
const AREA_OF = Object.freeze({
  'work-item.create': 'workItems', 'work-item.update': 'workItems', 'work-item.close': 'workItems',
  'work-item.find': 'workItems', 'work-item.read': 'workItems',
  'assigned.list': 'workItems', 'queue.read': 'queue', 'deployments.read': 'default',
});

/** El área del perfil que elige la plataforma de una operación que no es de un repo (null si es de un repo). */
function areaOf(operation) { return REPO_OPERATIONS.includes(operation) ? null : (AREA_OF[operation] || 'default'); }

/** Si un resultado tiene la forma del contrato: `{ok:true, value}` o `{ok:false, reason, detail}` con un motivo cerrado. */
function shapeProblem(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return 'la respuesta no es un objeto';
  if (r.ok === true) return Object.prototype.hasOwnProperty.call(r, 'value') ? null : 'dice ok sin traer «value»';
  if (r.ok !== false) return '«ok» no es true ni false';
  if (!REASONS.includes(r.reason)) return `motivo fuera del vocabulario: ${JSON.stringify(r.reason)}`;
  return typeof r.detail === 'string' && r.detail.trim() ? null : 'dice que no sin «detail»';
}

module.exports = { OPERATIONS, REASONS, REPO_OPERATIONS, AREAS, AREA_OF, areaOf, shapeProblem };
