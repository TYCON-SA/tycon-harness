'use strict';
// planning-controls.test.js — los controles de planificación sin BMAD (historia 8.324): un PRD no se aprueba sin la
// validación de otro agente, y cada documento de planificación dice en su cabecera su método y su proceso.
// Cada caso arma un repo de juguete en una carpeta temporal (con una carpeta .git, que es lo que busca la raíz) y llama al
// handler como lo llama el despachador. Nada lee la casa real.
// Correr: cd skills/tycon-pipeline/scripts/tests && HOME=$(mktemp -d) node --test planning-controls.test.js < /dev/null

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { handle } = require(path.join(__dirname, '..', 'on-planning-artifact.js'));

function repo(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'planning-controls-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.mkdirSync(path.join(d, '.git'));
  fs.mkdirSync(path.join(d, 'specs', 'planning-artifacts'), { recursive: true });
  return d;
}
const cabecera = (campos) => `---\n${Object.entries(campos).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n# Documento\n`;
const escribir = (archivo, contenido) => { fs.mkdirSync(path.dirname(archivo), { recursive: true }); fs.writeFileSync(archivo, contenido); };
const write = (file_path, content) => handle({ tool_name: 'Write', tool_input: { file_path, content } });
const COMPLETA = { metodo: 'sin-bmad', proceso: 'relevamiento, borrador y validación' };

test('T1 PrdAprobado_SinValidacion_Frena @story-8.324 @ac-1', (t) => {
  const d = repo(t);
  const prd = path.join(d, 'specs', 'planning-artifacts', 'prd.md');
  for (const estado of [{ estado: 'aprobado' }, { status: 'approved' }]) {
    const r = write(prd, cabecera({ ...COMPLETA, escrito_por: 'agente-a', ...estado }));
    assert.ok(r && r.block, JSON.stringify(r));
    assert.match(r.block, /validacion:/);
  }
  escribir(prd, cabecera({ ...COMPLETA, escrito_por: 'agente-a' }));
  const r = handle({ tool_name: 'Edit', tool_input: { file_path: prd, old_string: 'escrito_por: agente-a', new_string: 'escrito_por: agente-a\nestado: aprobado' } });
  assert.ok(r && r.block, 'una edición que lo aprueba también frena');
});

test('T2 PrdAprobado_InformeQueNoVale_Frena @story-8.324 @ac-2', (t) => {
  const d = repo(t);
  const prd = path.join(d, 'specs', 'planning-artifacts', 'prd.md');
  const informe = path.join(d, 'specs', 'planning-artifacts', 'prd-validacion.md');
  const aprobado = (extra) => write(prd, cabecera({ ...COMPLETA, escrito_por: 'agente-a', estado: 'aprobado', ...extra }));
  assert.match(aprobado({ validacion: 'specs/planning-artifacts/no-existe.md' }).block, /no existe/);
  assert.match(aprobado({ validacion: '../afuera.md' }).block, /sale del repo/);
  escribir(informe, cabecera({ fecha: '2026-11-21' }));
  assert.match(aprobado({ validacion: 'specs/planning-artifacts/prd-validacion.md' }).block, /validado_por:/);
  escribir(informe, cabecera({ validado_por: ' Agente-A ' }));
  assert.match(aprobado({ validacion: 'specs/planning-artifacts/prd-validacion.md' }).block, /el mismo que lo escribió/);
  escribir(informe, cabecera({ validado_por: 'agente-b' }));
  const sinAutor = write(prd, cabecera({ ...COMPLETA, estado: 'aprobado', validacion: 'specs/planning-artifacts/prd-validacion.md' }));
  assert.match(sinAutor.block, /falta escrito_por:/);
  const fuera = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'planning-sin-repo-')));
  t.after(() => fs.rmSync(fuera, { recursive: true, force: true }));
  const r = write(path.join(fuera, 'specs', 'planning-artifacts', 'prd.md'), cabecera({ ...COMPLETA, escrito_por: 'a', estado: 'aprobado', validacion: 'x.md' }));
  assert.match(r.block, /raíz del repo/);
});

test('T3 PrdAprobado_InformeDeOtroOBmad_Pasa @story-8.324 @ac-3', (t) => {
  const d = repo(t);
  const prd = path.join(d, 'specs', 'planning-artifacts', 'prd.md');
  escribir(path.join(d, 'specs', 'planning-artifacts', 'prd-validacion.md'), cabecera({ validado_por: 'agente-b' }));
  let r = write(prd, cabecera({ ...COMPLETA, escrito_por: 'agente-a', estado: 'aprobado', validacion: 'specs/planning-artifacts/prd-validacion.md' }));
  assert.ok(!r || !r.block, JSON.stringify(r));
  escribir(path.join(d, 'specs', 'planning-artifacts', 'prd-validation-report.md'), cabecera({ validationTarget: "'_bmad-output/planning-artifacts/prd.md'", validationDate: "'2026-03-14'" }));
  r = write(prd, cabecera({ ...COMPLETA, estado: 'aprobado', validacion: 'specs/planning-artifacts/prd-validation-report.md' }));
  assert.ok(!r || !r.block, `el informe de BMAD vale sin escrito_por: ${JSON.stringify(r)}`);
  escribir(path.join(d, 'specs', 'planning-artifacts', 'otro-report.md'), cabecera({ validationTarget: "'planning-artifacts/architecture.md'" }));
  r = write(prd, cabecera({ ...COMPLETA, estado: 'aprobado', validacion: 'specs/planning-artifacts/otro-report.md' }));
  assert.match(r.block, /otro documento/);
  r = write(prd, cabecera({ ...COMPLETA, escrito_por: 'agente-a' }));
  assert.ok(!r || !r.block, 'sin estado: aprobado, el freno no actúa');
});

test('T4 Cabecera_SinMetodoOProceso_Avisa @story-8.324 @ac-4', (t) => {
  const d = repo(t);
  const doc = path.join(d, 'specs', 'planning-artifacts', 'notas-de-relevamiento.md');
  let r = write(doc, cabecera({ fecha: '2026-11-21' }));
  assert.ok(r && r.reminder && !r.block);
  assert.match(r.reminder, /metodo:/);
  assert.match(r.reminder, /proceso:/);
  r = write(doc, cabecera({ stepsCompleted: '[step-01]' }));
  assert.ok(r && r.reminder);
  assert.match(r.reminder, /proceso:/);
  assert.doesNotMatch(r.reminder, /falta[^\n]*metodo:/, 'la cabecera de BMAD cuenta como método');
  r = write(doc, cabecera(COMPLETA));
  assert.ok(!r || !r.reminder || !/metodo:|proceso:/.test(r.reminder), JSON.stringify(r));
});

test('T5 FueraDePlanificacion_NoActua @story-8.324 @ac-5', (t) => {
  const d = repo(t);
  assert.strictEqual(write(path.join(d, 'specs', 'otra', 'prd.md'), cabecera({ estado: 'aprobado' })), null);
  assert.strictEqual(write(path.join(d, 'specs', 'planning-artifacts', 'x.html'), '<p>estado: aprobado</p>'), null);
});

test('T6 Regla121_SigueIgual @story-8.324 @ac-5', (t) => {
  const d = repo(t);
  const r = write(path.join(d, 'specs', 'planning-artifacts', 'ux-design-specification.md'), cabecera(COMPLETA));
  assert.ok(r && r.reminder);
  assert.match(r.reminder, /Regla 12\.1/);
  const ok = write(path.join(d, 'specs', 'planning-artifacts', 'ux-design-specification.md'), cabecera({ ...COMPLETA, reconciles: '[]' }));
  assert.strictEqual(ok, null, 'con reconciles: y la cabecera completa, nada');
});

test('T11 Guia_DiceLaRegla124 @story-8.324 @ac-9', () => {
  const guia = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'guides', 'workflow-orchestration.md'), 'utf8');
  const regla = (/### Regla 12\.4[\s\S]*?(?=\n### |\n## |$)/.exec(guia) || [''])[0];
  for (const palabra of ['estado: aprobado', 'validacion:', 'validado_por:', 'escrito_por:', 'metodo:', 'proceso:', 'suggestion-choices.js']) {
    assert.ok(regla.includes(palabra), `la regla 12.4 nombra ${palabra}`);
  }
});

// Pase adversarial (21/11): en Codex un parche llega como Edit sin old_string; un comentario al final del valor y un
// BOM al comienzo no cambian lo que dice la cabecera; el informe no puede ser el mismo PRD.
test('T12 PrdAprobado_ParcheDeCodexComentariosYElMismoPrd @story-8.324 @ac-1 @ac-2', (t) => {
  const d = repo(t);
  const prd = path.join(d, 'specs', 'planning-artifacts', 'prd.md');
  escribir(prd, cabecera({ ...COMPLETA, escrito_por: 'agente-a', estado: 'borrador' }));
  const parche = `*** Begin Patch\n*** Update File: ${prd}\n@@\n-estado: borrador\n+estado: aprobado\n*** End Patch`;
  const r = handle({ tool_name: 'Edit', tool_name_raw: 'apply_patch', tool_input: { file_path: prd, command: parche } });
  assert.ok(r && r.block, `el parche de Codex que lo aprueba frena: ${JSON.stringify(r)}`);
  const otro = `*** Begin Patch\n*** Update File: ${prd}\n@@\n-no está así\n+estado: aprobado\n*** End Patch`;
  assert.ok((handle({ tool_name: 'Edit', tool_input: { file_path: prd, command: otro } }) || {}).block, 'un parche que no aplica: se ven sus renglones nuevos');
  assert.ok(write(prd, `﻿${cabecera({ ...COMPLETA, escrito_por: 'a' })}`.replace('escrito_por: a', 'escrito_por: a\nestado: aprobado  # por la persona')).block, 'el comentario no esconde la aprobación');
  escribir(path.join(d, 'specs', 'planning-artifacts', 'informe.md'), cabecera({ validado_por: 'agente-b' }));
  const ok = write(prd, cabecera({ ...COMPLETA, escrito_por: 'agente-a', estado: 'aprobado', validacion: 'specs/planning-artifacts/informe.md  # el de b' }));
  assert.ok(!ok || !ok.block, `un comentario en validacion: no la rompe: ${JSON.stringify(ok)}`);
  escribir(prd, cabecera({ ...COMPLETA, escrito_por: 'agente-a', validado_por: 'otro' }));
  const mismo = write(prd, cabecera({ ...COMPLETA, escrito_por: 'agente-a', validado_por: 'otro', estado: 'aprobado', validacion: 'specs/planning-artifacts/prd.md' }));
  assert.match(mismo.block, /mismo PRD/);
});

// Pase adversarial, segunda vuelta (21/11): el parche que además renombra (`*** Move to:`), el que borra el PRD junto a
// otro archivo, el informe que llega en el mismo parche, las listas en bloque de YAML, el mismo PRD con otras
// mayúsculas y una carpeta que empieza con «..».
test('T13 PrdAprobado_ParchesDeVariosArchivosYListasDeYaml @story-8.324 @ac-1 @ac-2 @ac-4', (t) => {
  const d = repo(t);
  const dir = path.join(d, 'specs', 'planning-artifacts');
  const prd = path.join(dir, 'prd.md');
  const edit = (command) => handle({ tool_name: 'Edit', tool_input: { file_path: prd, command } });
  escribir(prd, cabecera({ ...COMPLETA, escrito_por: 'agente-a', estado: 'borrador' }));
  assert.ok((edit(`*** Begin Patch\n*** Update File: ${prd}\n*** Move to: ${dir}/prd-v2.md\n@@\n-estado: borrador\n+estado: aprobado\n*** End Patch`) || {}).block, 'renombrar y aprobar frena');
  assert.strictEqual(edit(`*** Begin Patch\n*** Delete File: ${prd}\n*** Add File: ${d}/docs/otro.md\n+---\n+status: approved\n+---\n*** End Patch`), null, 'borrar no aprueba, y lo de otro archivo no cuenta');
  const conInforme = `*** Begin Patch\n*** Add File: ${dir}/prd-validacion.md\n+---\n+validado_por: agente-b\n+---\n*** Update File: ${prd}\n@@\n-estado: borrador\n+estado: aprobado\n+validacion: specs/planning-artifacts/prd-validacion.md\n*** End Patch`;
  const r = edit(conInforme);
  assert.ok(!r || !r.block, `el informe que llega en el mismo parche vale: ${JSON.stringify(r)}`);
  const bmad = write(path.join(dir, 'epics.md'), '---\nstepsCompleted:\n  - step-01-init\n  - step-02\nproceso:\n  - relevamiento\n  - revisión\n---\n');
  assert.ok(!bmad || !/metodo:|proceso:/.test(bmad.reminder || ''), `las listas en bloque cuentan: ${JSON.stringify(bmad)}`);
  escribir(path.join(d, '..informes', 'inf.md'), cabecera({ validado_por: 'agente-b' }));
  const puntos = write(prd, cabecera({ ...COMPLETA, escrito_por: 'agente-a', estado: 'aprobado', validacion: '..informes/inf.md' }));
  assert.ok(!puntos || !puntos.block, `una carpeta que empieza con «..» está adentro: ${JSON.stringify(puntos)}`);
  escribir(prd, cabecera({ ...COMPLETA, escrito_por: 'agente-a', validado_por: 'otro' }));
  const mayus = path.join(dir, 'PRD.md');
  if (fs.existsSync(mayus)) {
    const m = write(prd, cabecera({ ...COMPLETA, escrito_por: 'agente-a', validado_por: 'otro', estado: 'aprobado', validacion: 'specs/planning-artifacts/PRD.md' }));
    assert.match(m.block, /mismo PRD/);
  }
});
