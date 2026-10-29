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
 *   kind          cómo se pide: 'guion' (un guion que firma, y verifica la ventana) o 'freno' (un escape que el freno
 *                 deja pasar con la ventana). Las cuatro que se dan sobre un archivo (FIRMAS_DE_ARCHIVO) son 'guion':
 *                 `marker.js sign-file` las pide en la ventana y deja la constancia que consume el Edit o Write.
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
  ['TYCON_NO_DEEP_REVIEW', '1', 'apagar el pase adversarial de una ejecución'],
  ['TYCON_STATUS_GATE', 'off', 'cambiar a mano el estado de una story'],
];

const CON_NOMBRE = [
  ['story-skill-bypass', 'escribir una story sin la skill de stories', 'file'],
  ['set-autonomous', 'cambiar el modo autónomo de una ejecución', 'marker.js set-autonomous'],
  ['cerrar-la-ejecucion', 'cerrar una ejecución con un control en rojo', 'marker.js clear'],
  ['cerrar-como-deuda', 'cerrar una ejecución dejando lo que falta como deuda', 'marker.js close-as-debt'],
  ['force-manual', 'marcar a mano en verde la prueba de pantalla', 'marker.js set-check dod green --force-manual'],
  ['trust-ran', 'contar los revisores sin la constancia de que corrieron', 'pipeline.js check-count --trust-ran'],
  ['ALLOW_DOD_EVIDENCE_WRITE', 'escribir a mano la evidencia de la prueba en vivo', 'file'],
  ['dod_runtime_exempt', 'eximir una story de la prueba en vivo', 'file'],
  ['no-deep-review', 'saltear el pase adversarial de una ejecución', 'pipeline.js start --no-deep-review'],
  ['cambiar-el-estado', 'cambiar a mano el estado de una story', 'file'],
];

// qué aprueba cada firma, en inglés: lo muestra la pantalla de Configuración en ese idioma
const APPROVES_EN = {
  'plan-approval': "approve a story's plan",
  'extra-round': 'one more round of reviewers',
  'refresh-after-main': 'sign the controls again after bringing in main, with no change of its own',
  'control-change': "approve a change to the repo's controls",
  'critical-waiver': "waive a reviewers' critical finding",
  'runtime-waiver': 'accept a criterion that cannot be tested live',
  'manual-test': 'mark a criterion as tested by hand',
  'browser-test': 'set up the browser test, or say no to it',
  'lost-run': 'give up a run as lost and close it',
  'adversarial-skip': 'skip the adversarial pass with a signed record',
  'pending-approval': 'open a new item in the pending list',
  'escape:TYCON_SAFETY_OFF': 'turn off the safety guard for one command',
  'escape:TYCON_PROD_LINT': 'turn off the production query check for one command',
  'escape:TYCON_NEW_NAMES': 'turn off the new names check on what is published',
  'escape:TYCON_TEST_GATE': "skip the commit's test gate",
  'escape:DOD_BYPASS': "skip the commit's checks (it is logged)",
  'escape:TYCON_NO_DEEP_REVIEW': "turn off a run's adversarial pass",
  'escape:TYCON_STATUS_GATE': "change a story's status by hand",
  'escape:story-skill-bypass': 'write a story without the story skill',
  'escape:set-autonomous': "change a run's autonomous mode",
  'escape:cerrar-la-ejecucion': 'close a run with a check in red',
  'escape:cerrar-como-deuda': 'close a run leaving what is missing as debt',
  'escape:force-manual': 'mark the screen test green by hand',
  'escape:trust-ran': 'count the reviewers without the record that they ran',
  'escape:ALLOW_DOD_EVIDENCE_WRITE': 'write the live test evidence by hand',
  'escape:dod_runtime_exempt': 'exempt a story from the live test',
  'escape:no-deep-review': "skip a run's adversarial pass",
  'escape:cambiar-el-estado': "change a story's status by hand",
};

// las firmas que se dan sobre un archivo (`file` en vez del comando, en CON_NOMBRE): `marker.js sign-file` las pide en
// la ventana, y el Edit o Write que sigue consume la constancia
const FIRMAS_DE_ARCHIVO = Object.freeze(CON_NOMBRE.filter((f) => f[2] === 'file').map((f) => f[0]));
const kindDe = (id) => (!id.startsWith('escape:') || FIRMAS_DE_ARCHIVO.includes(id.slice('escape:'.length)) ? 'guion' : 'freno');
const sobreArchivo = (nombre) => `marker.js sign-file ${nombre} <archivo>`;

const SIGNATURES = Object.freeze([
  { id: 'plan-approval', approves: 'aprobar el plan de una story', command: 'marker.js complete-step approve-plan --approved', otherSession: 'yes', terminal: 'marker.js complete-step approve-plan --terminal' },
  { id: 'extra-round', approves: 'una vuelta más de revisores', command: 'pipeline.js smart-reloop --extra-round', otherSession: 'yes', terminal: 'pipeline.js smart-reloop --extra-round --terminal' },
  { id: 'refresh-after-main', approves: 'refirmar los controles tras traer main, sin cambio propio', command: 'run-base-controls.sh approve', otherSession: 'yes', terminal: 'run-base-controls.sh approve --terminal' },
  { id: 'control-change', approves: 'aprobar un cambio de los controles del repo', command: 'run-base-controls.sh approve', otherSession: 'yes', terminal: 'run-base-controls.sh approve --terminal' },
  { id: 'critical-waiver', approves: 'eximir un hallazgo crítico de los revisores', command: 'marker.js waive-critical', otherSession: 'yes', terminal: 'marker.js waive-critical --terminal' },
  { id: 'runtime-waiver', approves: 'aceptar un criterio imposible de probar en vivo', command: 'marker.js runtime-waiver', otherSession: 'no', terminal: 'marker.js runtime-waiver <historia> --terminal' },
  { id: 'manual-test', approves: 'marcar un criterio como probado a mano', command: 'marker.js mark-tested --acs', otherSession: 'yes', terminal: 'marker.js mark-tested --acs --terminal' },
  { id: 'browser-test', approves: 'preparar la prueba con navegador, o decirle que no', command: 'e2e-setup.js prepare (o defer --no)', otherSession: 'yes', terminal: 'e2e-setup.js prepare --terminal (o defer --no --terminal)' },
  { id: 'lost-run', approves: 'dar por perdida una ejecución y cerrarla', command: 'marker.js clear-session --lost (o restore)', otherSession: 'yes', terminal: 'marker.js clear-session --lost --terminal (o restore --terminal)' },
  { id: 'adversarial-skip', approves: 'saltear el pase adversarial con constancia', command: 'marker.js sign-adversarial-skip --story <S> --reason <R>', otherSession: 'no', terminal: 'marker.js sign-adversarial-skip --story <S> --reason <R> --terminal' },
  { id: 'pending-approval', approves: 'abrir un pendiente nuevo en la lista de pendientes', command: 'marker.js approve-pending --id <CÓDIGO> --repo <carpeta> --for-session <sesión>', otherSession: 'yes', terminal: 'marker.js approve-pending --id <CÓDIGO> --repo <carpeta> --terminal' },
  ...POR_VARIABLE.map(([nombre, valor, approves]) => ({
    id: `escape:${nombre}`, approves, command: `${nombre}=${valor} <comando>`, otherSession: 'no', terminal: `${nombre}=${valor} <comando>`,
  })),
  ...CON_NOMBRE.map(([nombre, approves, command]) => (command === 'file'
    ? { id: `escape:${nombre}`, approves, command: sobreArchivo(nombre), otherSession: 'no', terminal: `${sobreArchivo(nombre)} --terminal` }
    : { id: `escape:${nombre}`, approves, command, otherSession: 'no', terminal: 'el mismo comando' })),
].map((s) => Object.freeze({ ...s, approvesEn: APPROVES_EN[s.id] || null, kind: kindDe(s.id) })));

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

module.exports = { SIGNATURES, GROUPS, FIRMAS_DE_ARCHIVO, ids, groupNames, isId, expand };
