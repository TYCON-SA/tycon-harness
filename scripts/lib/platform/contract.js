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

const VEREDICTO = Object.freeze({ succeeded: 'verde', failed: 'rojo', running: 'corriendo', none: 'ninguna' });

/**
 * Lo que un control puede concluir de una lectura de `ci.read` o `queue.read`: `verde`, `rojo`, `corriendo` o `ninguna`
 * (la CI), `medido` (la cola), y `no_medido` para todo lo demás. Cualquier «no» (también `no_soportado`: la plataforma
 * no lo atiende) y cualquier respuesta sin forma es `no_medido`: verde sólo con una corrida que terminó bien.
 */
function verdictOf(r) {
  if (!r || r.ok !== true || !Object.prototype.hasOwnProperty.call(r, 'value')) return 'no_medido';
  if (Array.isArray(r.value)) return 'medido';
  const state = r.value && typeof r.value === 'object' ? r.value.state : undefined;
  return Object.prototype.hasOwnProperty.call(VEREDICTO, state) ? VEREDICTO[state] : 'no_medido';
}

// Las operaciones que llevan la estimación vigente de la historia (`estimate`); las demás la ignoran.
const ESTIMATE_OPERATIONS = Object.freeze(['work-item.create', 'work-item.update']);
const ESTIMATE_UNITS = Object.freeze(['hours', 'days', 'points']);

const positivo = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const presente = (x) => x !== undefined && x !== null;

/**
 * Si una estimación tiene la forma del contrato: `{ value, unit, hours?, level?, version? }`, con `value` mayor que 0 y
 * `unit` en horas, días o puntos. Devuelve el problema en texto, o null. Qué campo de la plataforma la recibe lo decide
 * cada conector.
 */
function estimateProblem(e) {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return 'la estimación no es un objeto { value, unit }';
  if (!positivo(e.value)) return `la estimación tiene que traer value, un número mayor que 0 (es ${JSON.stringify(e.value)})`;
  if (!ESTIMATE_UNITS.includes(e.unit)) return `la unidad de la estimación tiene que ser ${ESTIMATE_UNITS.join(', ')} (es ${JSON.stringify(e.unit)})`;
  if (presente(e.hours) && !positivo(e.hours)) return `las horas de la estimación tienen que ser un número mayor que 0 (son ${JSON.stringify(e.hours)})`;
  // el nivel y la versión llegan al texto de un comentario: una palabra y un entero, nada más
  if (presente(e.level) && !(typeof e.level === 'string' && /^\p{L}{1,20}$/u.test(e.level))) return `el nivel de la estimación tiene que ser una palabra (es ${JSON.stringify(e.level)})`;
  if (presente(e.version) && !(Number.isInteger(e.version) && e.version > 0)) return `la versión de la estimación tiene que ser un entero mayor que 0 (es ${JSON.stringify(e.version)})`;
  return null;
}

// una rama que llega a la línea de comandos de la plataforma: sin opciones disfrazadas (`-x`), sin `..` ni espacios
const RAMA = /^(?!-)(?!.*\.\.)(?!\/)[A-Za-z0-9._\/-]{1,200}$/;
const noNegativo = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * Si los argumentos de `change-request.open` tienen la forma del contrato: `{ sourceBranch, targetBranch, text,
 * deleteSourceBranch, title?, check?, waitMinutes?, pollSeconds?, repoDir? }`. `text` es el mensaje entero (su primera
 * línea es el título si no viene `title`); `check`, el nombre del control que se espera en una plataforma sin entrada
 * automática; `waitMinutes` y `pollSeconds`, los topes de esa espera. Devuelve el problema en texto, o null.
 */
function openProblem(a) {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return 'los argumentos no son un objeto';
  for (const k of ['sourceBranch', 'targetBranch']) if (!(typeof a[k] === 'string' && RAMA.test(a[k]))) return `${k} tiene que ser el nombre de una rama (es ${JSON.stringify(a[k])})`;
  if (!(typeof a.text === 'string' && a.text.trim())) return 'falta text: el mensaje del pedido (su primera línea es el título)';
  if (typeof a.deleteSourceBranch !== 'boolean') return 'deleteSourceBranch tiene que ser true o false: si la rama se borra al entrar';
  if (presente(a.title) && !(typeof a.title === 'string' && a.title.trim())) return 'title, si viene, es un texto';
  if (!presente(a.title) && !a.text.split('\n', 1)[0].trim()) return 'sin title, la primera línea de text es el título: no puede estar en blanco';
  // el título y el texto van sueltos a la línea de comandos de la plataforma: no pueden parecer una opción («-») ni un
  // archivo para leer («@», que `az` reemplaza por el contenido de ese archivo de la máquina)
  for (const [k, nombre] of [['title', 'el título'], ['text', 'el texto']]) {
    if (presente(a[k]) && /^[-@]/.test(a[k])) return `${nombre} no puede empezar con «${a[k][0]}»: la plataforma lo tomaría como ${a[k][0] === '-' ? 'una opción' : 'un archivo para leer'}`;
  }
  if (presente(a.check) && !(typeof a.check === 'string' && /^[^\n]{1,200}$/.test(a.check))) return 'check, si viene, es el nombre de un control';
  for (const k of ['waitMinutes', 'pollSeconds']) if (presente(a[k]) && !noNegativo(a[k])) return `${k}, si viene, es un número mayor o igual que 0`;
  if (presente(a.repoDir) && typeof a.repoDir !== 'string') return 'repoDir, si viene, es una carpeta';
  return null;
}

module.exports = { OPERATIONS, REASONS, REPO_OPERATIONS, AREAS, AREA_OF, ESTIMATE_OPERATIONS, ESTIMATE_UNITS, areaOf, shapeProblem, verdictOf, estimateProblem, openProblem };
