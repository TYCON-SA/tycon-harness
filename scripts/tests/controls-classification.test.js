'use strict';
/**
 * controls-classification.test.js — cada freno y cada gancho que frena tiene su clasificación (exigencia o preferencia),
 * su motivo y su fecha de revisión (`scripts/metrics/controls-classification.json`). Así un freno nuevo no entra sin fecha.
 *
 *   T1 ControlsClassification_EveryBlockingHookAndGuard_HasEntry — la clasificación real cubre FRENOS y los ganchos `blocks`
 *   T2 ControlsClassification_MissingEntryOrDate_Red              — un gancho sin entrada o una entrada sin fecha: rojo
 *   T3 ControlsClassification_ExigenciaWithoutReason_Red          — una exigencia cuyo motivo no nombra qué protege: rojo
 *   T4 ControlsClassification_PipelineControl_OnlyIfAScriptBlocksWithIt — un control del pipeline (`del_pipeline`) vale
 *      sólo si un guion del pipeline lo anota en gates.log como blocked, y sin ganchos
 *   T5 ControlsClassification_ControlInsideAHook_HasEntry — cada control que frena adentro de hook-pre-edit.js y cada
 *      control del pipeline que frena tienen su entrada; una entrada `dentro_de` nombra un archivo que existe, sin ganchos
 *
 * 🔴 Falla con: un freno de guard-record.js o un gancho que frena sin entrada, un gancho en dos entradas, una entrada sin
 *    `review_before` o con una fecha que no existe, una exigencia sin decir qué protege, una firmada sin quién y cuándo,
 *    o un control del pipeline que ningún guion anota.
 * stable-data: lee archivos del repo; no lee el reloj.
 * 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const clasificacion = () => require(path.join(ROOT, 'scripts', 'metrics', 'controls-classification.json'));
const { FRENOS } = require(path.join(ROOT, 'scripts', 'lib', 'guard-record.js'));

/** Los ganchos que frenan de hooks-list.json, por el nombre de su archivo, sin repetir. */
function ganchosQueFrenan() {
  const lista = require(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'));
  const arr = Array.isArray(lista) ? lista : (lista.hooks || Object.values(lista));
  return [...new Set(arr.filter((h) => h && h.effect === 'blocks').map((h) => path.basename(String(h.spec).replace(/^@\w+:/, ''))))];
}

// Lo que protege una exigencia (la regla 1 de la clasificación): su motivo nombra al menos una.
const PROTEGE = /producción|datos|secreto|rama compartida|público|firma|historia|constancia|constitución|no es del agente/i;
const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
function fechaValida(s) {
  const m = FECHA.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Los controles que frenan adentro de hook-pre-edit.js: los de su cadena con `effect: 'blocks'` (dispatch.js). */
function cadenaDePreEdit() {
  const { CHAINS } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'dispatch.js'));
  return (CHAINS['pre-edit'] || []).filter((x) => x.effect === 'blocks').map((x) => x.name);
}

/** ¿Existe `rel` en el árbol del repo? (la entrada `dentro_de` nombra el gancho que corre el control) */
const existeEnElRepo = (rel) => require('fs').existsSync(path.join(ROOT, String(rel)));

/** Los controles del pipeline que frenan: los nombres que sus guiones anotan en gates.log con `status: 'blocked'`. */
function controlesDelPipeline() {
  const fs = require('fs');
  const dir = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts');
  const out = new Set();
  const leer = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'tests') leer(path.join(d, e.name)); continue; }
      if (!e.name.endsWith('.js')) continue;
      for (const m of fs.readFileSync(path.join(d, e.name), 'utf8').matchAll(/name: '([a-z0-9-]+)', status: 'blocked'/g)) out.add(m[1]);
    }
  };
  leer(dir);
  return [...out];
}

/**
 * Los problemas de una clasificación contra los frenos, los ganchos que frenan y los controles del pipeline: lista vacía
 * si está bien.
 */
function problemas(c, frenos, ganchos, delPipeline = [], { cadena = [], existe = existeEnElRepo, todoElPipeline = false } = {}) {
  const out = [];
  const entradas = Object.entries(c).filter(([k]) => !k.startsWith('__'));
  const claves = new Set(entradas.map(([k]) => k));
  for (const f of frenos) if (!claves.has(f)) out.push(`el freno ${f} no tiene entrada`);
  // los controles que frenan adentro de un gancho que corre varios, y (con `todoElPipeline`) los del pipeline
  for (const n of cadena) if (!claves.has(n)) out.push(`el control ${n} de hook-pre-edit.js no tiene entrada`);
  if (todoElPipeline) for (const n of delPipeline) if (!claves.has(n)) out.push(`el control del pipeline ${n} no tiene entrada`);
  const donde = new Map();
  for (const [k, v] of entradas) {
    if (!['exigencia', 'preferencia'].includes(v.tipo)) out.push(`${k}: tipo ${JSON.stringify(v.tipo)} no es exigencia ni preferencia`);
    if (typeof v.motivo !== 'string' || !v.motivo.trim()) out.push(`${k}: sin motivo`);
    if (!fechaValida(v.review_before)) out.push(`${k}: sin review_before válido (AAAA-MM-DD)`);
    if (!['propuesta', 'firmada'].includes(v.estado)) out.push(`${k}: estado ${JSON.stringify(v.estado)} no es propuesta ni firmada`);
    if (v.estado === 'firmada' && (!fechaValida(v.firmada_el) || !v.firmada_por)) out.push(`${k}: firmada sin firmada_el o firmada_por`);
    if (v.tipo === 'exigencia' && !PROTEGE.test(v.motivo || '')) out.push(`${k}: exigencia cuyo motivo no nombra qué protege`);
    if (!Array.isArray(v.ganchos)) out.push(`${k}: sin lista de ganchos`);
    for (const g of v.ganchos || []) donde.set(g, [...(donde.get(g) || []), k]);
    if (v.del_pipeline === true) {
      if (!delPipeline.includes(k)) out.push(`${k}: no es un control del pipeline que frena (ningún guion anota «${k}» como blocked)`);
      if ((v.ganchos || []).length) out.push(`${k}: un control del pipeline no lleva ganchos`);
    } else if (v.dentro_de !== undefined) {
      // un control que corre adentro de un gancho (la cadena de hook-pre-edit.js, un gancho de git): nombra ese archivo
      if (typeof v.dentro_de !== 'string' || !v.dentro_de || !existe(v.dentro_de)) out.push(`${k}: dentro_de no nombra un archivo del repo (${JSON.stringify(v.dentro_de)})`);
      if ((v.ganchos || []).length) out.push(`${k}: un control adentro de un gancho no lleva ganchos (el gancho es de otra entrada)`);
    } else if (!frenos.includes(k) && !ganchos.includes(k)) out.push(`${k}: no es un freno de guard-record.js ni un gancho que frena`);
  }
  for (const g of ganchos) {
    const en = donde.get(g) || [];
    if (en.length === 0) out.push(`el gancho ${g} no está en los ganchos de ninguna entrada`);
    if (en.length > 1) out.push(`el gancho ${g} está en los ganchos de ${en.join(' y ')}`);
  }
  return out;
}

const entrada = (extra = {}) => ({ tipo: 'preferencia', motivo: 'un trámite', review_before: '2027-01-20', estado: 'propuesta', ganchos: [], ...extra });

test('T1 ControlsClassification_EveryBlockingHookAndGuard_HasEntry — cada freno y gancho que frena, con su entrada', () => {
  const c = clasificacion();
  assert.deepEqual(problemas(c, Object.keys(FRENOS), ganchosQueFrenan(), controlesDelPipeline(), { cadena: cadenaDePreEdit(), todoElPipeline: true }), []);
  // la propuesta todavía no la firmó el dueño
  for (const [k, v] of Object.entries(c)) if (!k.startsWith('__')) assert.equal(v.estado, 'propuesta', k);
});

test('T2 ControlsClassification_MissingEntryOrDate_Red — un gancho sin entrada y una entrada sin fecha, nombrados', () => {
  const c = { 'un-freno': entrada({ ganchos: ['a.js'] }), 'otro-freno': entrada({ review_before: undefined }) };
  const p = problemas(c, ['un-freno', 'otro-freno', 'freno-nuevo'], ['a.js', 'gancho-nuevo.js']);
  assert.ok(p.includes('el gancho gancho-nuevo.js no está en los ganchos de ninguna entrada'), p.join('\n'));
  assert.ok(p.includes('otro-freno: sin review_before válido (AAAA-MM-DD)'), p.join('\n'));
  assert.ok(p.includes('el freno freno-nuevo no tiene entrada'), p.join('\n'));
  // un gancho en dos entradas, y una fecha que no existe
  const doble = { 'un-freno': entrada({ ganchos: ['a.js'] }), 'otro-freno': entrada({ ganchos: ['a.js'], review_before: '2027-02-30' }) };
  const q = problemas(doble, ['un-freno', 'otro-freno'], ['a.js']);
  assert.ok(q.includes('el gancho a.js está en los ganchos de un-freno y otro-freno'), q.join('\n'));
  assert.ok(q.includes('otro-freno: sin review_before válido (AAAA-MM-DD)'), q.join('\n'));
});

test('T3 ControlsClassification_ExigenciaWithoutReason_Red — una exigencia que no dice qué protege', () => {
  const p = problemas({ 'un-freno': entrada({ tipo: 'exigencia', motivo: 'porque sí, es importante' }) }, ['un-freno'], []);
  assert.deepEqual(p, ['un-freno: exigencia cuyo motivo no nombra qué protege']);
  assert.deepEqual(problemas({ 'un-freno': entrada({ tipo: 'exigencia', motivo: 'protege producción' }) }, ['un-freno'], []), []);
  // firmada sin quién: rojo
  assert.deepEqual(problemas({ 'un-freno': entrada({ estado: 'firmada', firmada_el: '2026-12-01' }) }, ['un-freno'], []),
    ['un-freno: firmada sin firmada_el o firmada_por']);
});

test('T4 ControlsClassification_PipelineControl_OnlyIfAScriptBlocksWithIt — un control del pipeline, sólo si un guion lo anota como blocked', () => {
  // los dos de la medición con modelo están, con su tipo
  const c = clasificacion();
  assert.equal(c['step-arg'].tipo, 'exigencia');
  assert.equal(c['internal-history'].tipo, 'exigencia');
  assert.equal(c['review-cap-shown'].tipo, 'preferencia');
  const reales = controlesDelPipeline();
  for (const k of ['step-arg', 'review-cap-shown']) assert.ok(reales.includes(k), `${k} no aparece como blocked en el pipeline: ${reales.join(', ')}`);
  // un nombre que ningún guion anota, y uno con ganchos: rojo
  const p = problemas({ 'inventado': entrada({ del_pipeline: true }), 'con-ganchos': entrada({ del_pipeline: true, ganchos: ['a.js'] }) },
    [], ['a.js'], ['con-ganchos']);
  assert.ok(p.includes('inventado: no es un control del pipeline que frena (ningún guion anota «inventado» como blocked)'), p.join('\n'));
  assert.ok(p.includes('con-ganchos: un control del pipeline no lleva ganchos'), p.join('\n'));
  // sin la marca, el mismo nombre no pasa como freno
  assert.ok(problemas({ 'step-arg': entrada() }, [], [], ['step-arg']).includes('step-arg: no es un freno de guard-record.js ni un gancho que frena'));
  assert.deepEqual(problemas({ 'step-arg': entrada({ del_pipeline: true }) }, [], [], ['step-arg']), []);
});

test('T5 ControlsClassification_ControlInsideAHook_HasEntry — los controles de hook-pre-edit.js y del pipeline, con su entrada', () => {
  // los ocho de la cadena que no anotan en FRENOS: la cadena real los trae y la clasificación los tiene
  const cadena = cadenaDePreEdit();
  for (const n of ['on-controls-off', 'on-story-gate', 'on-story-skill-gate', 'on-red-test-edit', 'on-coordination-write', 'on-atdd-preedit', 'on-planning-artifact', 'on-deprecated-edit']) {
    assert.ok(cadena.includes(n), `${n} no está en la cadena de pre-edit: ${cadena.join(', ')}`);
    assert.ok(clasificacion()[n], `${n} sin entrada`);
  }
  // uno de la cadena sin entrada, uno del pipeline sin entrada, un dentro_de que no existe y uno con ganchos: rojo
  const p = problemas({ 'adentro': entrada({ dentro_de: 'no/existe.js' }), 'con-ganchos': entrada({ dentro_de: 'a.js', ganchos: ['a.js'] }) },
    [], ['a.js'], ['del-pipeline'], { cadena: ['de-la-cadena'], existe: (r) => r === 'a.js', todoElPipeline: true });
  assert.ok(p.includes('el control de-la-cadena de hook-pre-edit.js no tiene entrada'), p.join('\n'));
  assert.ok(p.includes('el control del pipeline del-pipeline no tiene entrada'), p.join('\n'));
  assert.ok(p.includes('adentro: dentro_de no nombra un archivo del repo ("no/existe.js")'), p.join('\n'));
  assert.ok(p.includes('con-ganchos: un control adentro de un gancho no lleva ganchos (el gancho es de otra entrada)'), p.join('\n'));
  // bien formado: pasa
  assert.deepEqual(problemas({ 'adentro': entrada({ dentro_de: 'a.js' }) }, [], [], [], { existe: () => true }), []);
  // el freno retirado ya no está en la lista
  assert.equal(clasificacion()['pr-sin-portables'], undefined);
  assert.equal(FRENOS['pr-sin-portables'], undefined);
});
