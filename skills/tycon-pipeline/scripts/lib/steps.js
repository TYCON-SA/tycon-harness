'use strict';
// lib/steps.js — la tabla única de los pasos del pipeline.
//
// Cada paso: su id (el del marcador y el de los comandos: `complete-step 5`, `--type 5b`), el nombre llano con que se
// le muestra al dueño (sin número: «Revisores», no «Step 5») y su archivo en `steps/`. El orden de la tabla es el orden
// de la corrida; `inSequence: false` marca los dos que `pipeline.js next` no recorre (el 7b, que es una vuelta más de
// revisores, y el 9, que corre después del merge).
//
// Sólo los nombres son llanos: los ids, los archivos y el marcador son los de la corrida. La copia del cartel (`mods/harness-mods/hooks/steps.mjs`) lleva los mismos
// nombres, y scripts/tests/harness-mods.test.js frena si se separan.

const STEPS = [
  { id: '0', name: 'Arranque', file: 'step-00-preflight.md' },
  { id: '0b', name: 'Arranque: aviso de trabajo', file: 'step-00b-work-start.md' },
  { id: '0c', name: 'Arranque: pedido en ADO', file: 'step-00c-ado-mark-active.md' },
  { id: '1', name: 'Validar la historia', file: 'step-01-validate-story.md' },
  { id: '2', name: 'Armar el plan', file: 'step-02-invoke-bmad.md' },
  { id: '3', name: 'Aprobar el plan', file: 'step-03-hitl-plan.md' },
  { id: '4', name: 'Implementar y correr las pruebas', file: 'step-04-execute.md' },
  { id: '5', name: 'Revisores', file: 'step-05-advisors-parallel.md' },
  { id: '5b', name: 'Pase adversarial', file: 'step-05b-adversarial-verify.md' },
  { id: '6', name: 'Hallazgos: el informe', file: 'step-06-consolidated-report.md' },
  { id: '7', name: 'Hallazgos: la decisión', file: 'step-07-hitl-approve.md' },
  { id: '7b', name: 'Revisores, otra vuelta', file: 'step-07b-rerun-advisors-if-fixes.md', inSequence: false },
  { id: '7c', name: 'Probar en vivo', file: 'step-07c-dod-runtime-gate.md' },
  { id: '8', name: 'Preparar el commit', file: 'step-08-commit-prep.md' },
  { id: '9', name: 'Cerrar la historia', file: 'step-09-ado-story-closure.md', inSequence: false },
];

/** El nombre llano de un paso por su id; acepta el número suelto del marcador (`5` o `'5'`). `null` si no existe. */
function stepName(id) {
  const s = STEPS.find((x) => x.id === String(id));
  return s ? s.name : null;
}

/** Una lista de ids (los pendientes del marcador, p. ej.) como nombres, separados por coma. */
function stepNames(ids) {
  return (Array.isArray(ids) ? ids : []).map((id) => stepName(id) || `«${id}»`).join(', ');
}

module.exports = { STEPS, stepName, stepNames };
