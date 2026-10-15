// Los pasos del pipeline de una story, como los muestra el cartel (story 7.27).
//
// Copia de `STEP_SEQUENCE` y `SUBSTEP_FLAG` de skills/tycon-pipeline/scripts/pipeline.js: el plugin corre sin Node y
// no puede leer ese archivo. scripts/tests/harness-mods.test.js (T16) frena si las dos listas se separan.

/** Cada paso: su id (el del marker) y el nombre que lee el dev. */
export const STEPS = [
  { id: '0', name: 'preparación' },
  { id: '0b', name: 'registro de horas' },
  { id: '0c', name: 'pedido en Azure' },
  { id: '1', name: 'validar la story' },
  { id: '2', name: 'plan' },
  { id: '3', name: 'aprobar el plan' },
  { id: '4', name: 'implementación' },
  { id: '5', name: 'revisores' },
  { id: '5b', name: 'búsqueda de fallas' },
  { id: '6', name: 'reporte' },
  { id: '7', name: 'aprobar hallazgos' },
  { id: '7c', name: 'verificación en vivo' },
  { id: '8', name: 'commit' },
];

/** Los sub-pasos que se dan por hechos con una bandera del marker (el 7c, como en `computeNext`). */
export const SUBSTEP_FLAG = { '0b': 'clockiStarted', '0c': 'adoMarkedActive', '5b': 'deepReviewDone', '7c': 'dodRuntimeChecked' };

/** Los pasos que esperan al dev cuando la corrida no es autónoma. */
export const ASKS_DEV = ['3', '7'];

/** Cuántos pasos principales (un dígito) tiene la corrida: el «M» de «N de M». */
export const MAIN_TOTAL = STEPS.filter((s) => /^\d$/.test(s.id)).length;
