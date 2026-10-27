'use strict';
/**
 * signatures.js — el catálogo de las firmas del dueño (@story-8.139).
 *
 * Una entrada por cada cosa que un freno le pide firmar a una persona. Lo leen el lector de la configuración (con qué
 * ids se escriben `approvals.delegated_signing` y `approvals.owner_only`) y la guía `guides/firmas-del-arnes.md`, que
 * trae una fila por entrada. Sin dependencias: lo carga el lector.
 *
 * Cada entrada:
 *   id            el nombre con que se la nombra en el perfil del equipo; un escape es `escape:<nombre>`, con los
 *                 espacios como guiones y sin acentos.
 *   approves      qué aprueba, en llano.
 *   command       el comando que la pide.
 *   otherSession  'yes' si el comando se puede correr desde la pestaña de otra sesión, 'no' si no, 'pending' si la firma
 *                 todavía no tiene comando.
 *   terminal      cómo la firma el dueño en su terminal, o null mientras no tenga comando.
 *
 * GROUPS es la tabla de equivalencias de los 11 valores que la 8.116 aceptaba en `approvals.delegated_signing` (`off`
 * aparte: es «ninguna»): `escape-phrases` son todos los escapes; cada uno de los demás, su propia firma.
 */

const POR_VARIABLE = [
  ['TYCON_SAFETY_OFF', '1', 'apagar el freno de seguridad para un comando'],
  ['TYCON_PROD_LINT', '0', 'apagar el control de consultas a producción para un comando'],
  ['TYCON_NEW_NAMES', '0', 'apagar el control de nombres nuevos en lo que se publica'],
  ['TYCON_TEST_GATE', '1', 'saltear el portón de pruebas del commit'],
  ['DOD_BYPASS', '1', 'saltear los controles del commit (queda anotado)'],
  ['TYCON_NO_DEEP_REVIEW', '1', 'apagar el pase adversarial de una corrida'],
  ['TYCON_STATUS_GATE', 'off', 'cambiar a mano el estado de una story'],
];

const CON_NOMBRE = [
  ['story-skill-bypass', 'usar una skill de stories fuera del pipeline', 'invocar una skill de stories fuera del pipeline'],
  ['set-autonomous', 'cambiar el modo autónomo de una corrida', 'marker.js set-autonomous'],
  ['cerrar-la-ejecucion', 'cerrar una corrida con un control en rojo', 'marker.js clear'],
  ['cerrar-como-deuda', 'cerrar una corrida dejando lo que falta como deuda', 'marker.js close-as-debt'],
  ['force-manual', 'marcar a mano en verde la prueba de pantalla', 'marker.js set-check dod green --force-manual'],
  ['trust-ran', 'contar los revisores sin la constancia de que corrieron', 'pipeline.js check-count --trust-ran'],
  ['ALLOW_DOD_EVIDENCE_WRITE', 'escribir a mano la evidencia de la prueba en vivo', 'escribir el archivo de evidencia de la prueba en vivo'],
  ['dod_runtime_exempt', 'eximir una story de la prueba en vivo', 'poner dod_runtime_exempt: true en una story'],
  ['no-deep-review', 'saltear el pase adversarial de una corrida', 'pipeline.js start --no-deep-review'],
  ['cambiar-el-estado', 'cambiar a mano el estado de una story', 'marker.js update-story-status'],
];

const SIGNATURES = Object.freeze([
  { id: 'plan-approval', approves: 'aprobar el plan de una story', command: 'marker.js complete-step approve-plan --approved', otherSession: 'yes', terminal: 'marker.js complete-step approve-plan --terminal' },
  { id: 'extra-round', approves: 'una vuelta más de revisores', command: 'pipeline.js smart-reloop --extra-round', otherSession: 'yes', terminal: 'pipeline.js smart-reloop --extra-round --terminal' },
  { id: 'refresh-after-main', approves: 'refirmar los controles tras traer main, sin cambio propio', command: 'run-base-controls.sh approve', otherSession: 'yes', terminal: 'run-base-controls.sh approve --terminal' },
  { id: 'control-change', approves: 'aprobar un cambio de los controles del repo', command: 'run-base-controls.sh approve', otherSession: 'yes', terminal: 'run-base-controls.sh approve --terminal' },
  { id: 'critical-waiver', approves: 'eximir un hallazgo crítico de los revisores', command: 'marker.js waive-critical', otherSession: 'yes', terminal: 'marker.js waive-critical --terminal' },
  { id: 'runtime-waiver', approves: 'aceptar un criterio imposible de probar en vivo', command: 'marker.js runtime-waiver', otherSession: 'no', terminal: 'marker.js runtime-waiver' },
  { id: 'manual-test', approves: 'marcar un criterio como probado a mano', command: 'marker.js mark-tested --acs', otherSession: 'yes', terminal: 'marker.js mark-tested --acs --terminal' },
  { id: 'browser-test', approves: 'preparar la prueba con navegador, o decirle que no', command: 'e2e-setup.js prepare --ok (o decline --ok)', otherSession: 'yes', terminal: 'e2e-setup.js prepare --terminal (o decline --terminal)' },
  { id: 'lost-run', approves: 'dar por perdida una corrida y cerrarla', command: 'marker.js clear-session --lost', otherSession: 'yes', terminal: 'marker.js clear-session --lost --terminal' },
  { id: 'adversarial-skip', approves: 'saltear el pase adversarial con constancia', command: 'marker.js sign-adversarial-skip (todavía no existe)', otherSession: 'pending', terminal: null },
  ...POR_VARIABLE.map(([nombre, valor, approves]) => ({
    id: `escape:${nombre}`, approves, command: `${nombre}=${valor} <comando>`, otherSession: 'no', terminal: `${nombre}=${valor} <comando>`,
  })),
  ...CON_NOMBRE.map(([nombre, approves, command]) => ({
    id: `escape:${nombre}`, approves, command, otherSession: 'no', terminal: 'correr el mismo comando en tu terminal',
  })),
].map((s) => Object.freeze(s)));

const ESCAPES = SIGNATURES.filter((s) => s.id.startsWith('escape:')).map((s) => s.id);

const GROUPS = Object.freeze(Object.fromEntries(['refresh-after-main', 'adversarial-skip', 'critical-waiver', 'escape-phrases',
  'plan-approval', 'browser-test', 'runtime-waiver', 'manual-test', 'extra-round', 'control-change', 'lost-run']
  .map((g) => [g, Object.freeze(g === 'escape-phrases' ? ESCAPES : [g])])));

function ids() { return SIGNATURES.map((s) => s.id); }
function groupNames() { return Object.keys(GROUPS); }
function isId(v) { return SIGNATURES.some((s) => s.id === v); }

/** Los ids que nombra un valor de la lista: un grupo, sus firmas; un id, él mismo; `off` o desconocido, ninguno. */
function expand(v) {
  if (Object.prototype.hasOwnProperty.call(GROUPS, v)) return [...GROUPS[v]];
  return isId(v) ? [v] : [];
}

module.exports = { SIGNATURES, GROUPS, ids, groupNames, isId, expand };
