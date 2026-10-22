// Los pasos del pipeline de una story, como los muestra el cartel.
//
// Copia de la tabla de skills/tycon-pipeline/scripts/lib/steps.js (orden, nombre de máquina, nombre llano, la
// equivalencia con el marcador viejo y las banderas): el plugin corre sin Node y no puede leer ese archivo.
// scripts/tests/harness-mods.test.js (T16) frena si se separan.

/** Cada paso: su número, su nombre de máquina (el del marker nuevo) y el nombre que lee el dev. */
export const STEPS = [
  { number: 1, id: 'start', name: 'Arranque', old: ['0', '0b', '0c'] },
  { number: 2, id: 'validate-story', name: 'Validar la historia', old: ['1'] },
  { number: 3, id: 'plan', name: 'Armar el plan', old: ['2'] },
  { number: 4, id: 'approve-plan', name: 'Aprobar el plan', old: ['3'] },
  { number: 5, id: 'implement', name: 'Implementar', old: ['4'] },
  { number: 6, id: 'run-tests', name: 'Correr las pruebas', old: ['4'] },
  { number: 7, id: 'reviewers', name: 'Revisores', old: ['5', '7b'] },
  { number: 8, id: 'adversarial-pass', name: 'Pase adversarial', old: ['5b'], flag: 'deepReviewDone' },
  { number: 9, id: 'findings', name: 'Hallazgos', old: ['6', '7'] },
  { number: 10, id: 'live-check', name: 'Probar en vivo', old: ['7c'], flag: 'dodRuntimeChecked' },
  { number: 11, id: 'prepare-commit', name: 'Preparar el commit', old: ['8'] },
];

/** El «M» de «N de M»: el largo de la tabla. */
export const TOTAL = STEPS.length;

/** Los pasos del marker viejo (por número) y sus sub-pasos que se daban por hechos con bandera. */
export const OLD_IDS = ['0', '0b', '0c', '1', '2', '3', '4', '5', '5b', '6', '7', '7b', '7c', '8', '9'];
export const OLD_FLAG = { '0b': ['workSignalStarted', 'clockiStarted'], '0c': ['adoMarkedActive'], '5b': ['deepReviewDone'], '7c': ['dodRuntimeChecked'] };

/** Lo que dice el aviso de una parte del Arranque que falló (`startWarnings` del marker). */
export const START_PART_FAILED = {
  'time-tracking': 'no se pudo abrir el registro de horas',
  ado: 'no se pudo marcar el pedido en ADO',
};
