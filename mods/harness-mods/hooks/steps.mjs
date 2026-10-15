// Los pasos del pipeline de una story, como los muestra el cartel (story 7.27).
//
// Copia de `STEP_SEQUENCE` y `SUBSTEP_FLAG` de skills/tycon-pipeline/scripts/pipeline.js, con los nombres llanos de
// skills/tycon-pipeline/scripts/lib/steps.js (story 7.23): el plugin corre sin Node y no puede leer esos archivos.
// scripts/tests/harness-mods.test.js (T16) frena si los ids o los nombres se separan.

/** Cada paso: su id (el del marker) y el nombre que lee el dev — el único que se le muestra, sin el id. */
export const STEPS = [
  { id: '0', name: 'Arranque' },
  { id: '0b', name: 'Arranque: reloj de Clockify' },
  { id: '0c', name: 'Arranque: pedido en ADO' },
  { id: '1', name: 'Validar la story' },
  { id: '2', name: 'Armar el plan' },
  { id: '3', name: 'Aprobar el plan' },
  { id: '4', name: 'Implementar y correr las pruebas' },
  { id: '5', name: 'Revisores' },
  { id: '5b', name: 'Pase adversarial' },
  { id: '6', name: 'Hallazgos: el informe' },
  { id: '7', name: 'Hallazgos: la decisión' },
  { id: '7c', name: 'Probar en vivo' },
  { id: '8', name: 'Preparar el commit' },
];

/** Los sub-pasos que se dan por hechos con una bandera del marker (el 7c, como en `computeNext`). */
export const SUBSTEP_FLAG = { '0b': 'clockiStarted', '0c': 'adoMarkedActive', '5b': 'deepReviewDone', '7c': 'dodRuntimeChecked' };

/** Los pasos que esperan al dev cuando la corrida no es autónoma. */
export const ASKS_DEV = ['3', '7'];

/** Cuántos pasos principales (un dígito) tiene la corrida: el «M» de «N de M». */
export const MAIN_TOTAL = STEPS.filter((s) => /^\d$/.test(s.id)).length;
