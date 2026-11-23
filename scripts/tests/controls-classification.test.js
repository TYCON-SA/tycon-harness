'use strict';
/**
 * controls-classification.test.js — cada freno y cada gancho que frena tiene su clasificación (exigencia o preferencia),
 * su motivo y su fecha de revisión (`scripts/metrics/controls-classification.json`). Así un freno nuevo no entra sin fecha.
 *
 *   T1 ControlsClassification_EveryBlockingHookAndGuard_HasEntry — la clasificación real cubre FRENOS y los ganchos `blocks`
 *   T2 ControlsClassification_MissingEntryOrDate_Red              — un gancho sin entrada o una entrada sin fecha: rojo
 *   T3 ControlsClassification_ExigenciaWithoutReason_Red          — una exigencia cuyo motivo no nombra qué protege: rojo
 *
 * 🔴 Falla con: un freno de guard-record.js o un gancho que frena sin entrada, un gancho en dos entradas, una entrada sin
 *    `review_before` o con una fecha que no existe, una exigencia sin decir qué protege, o una firmada sin quién y cuándo.
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

/** Los problemas de una clasificación contra los frenos y los ganchos que frenan: lista vacía si está bien. */
function problemas(c, frenos, ganchos) {
  const out = [];
  const entradas = Object.entries(c).filter(([k]) => !k.startsWith('__'));
  const claves = new Set(entradas.map(([k]) => k));
  for (const f of frenos) if (!claves.has(f)) out.push(`el freno ${f} no tiene entrada`);
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
    if (!frenos.includes(k) && !ganchos.includes(k)) out.push(`${k}: no es un freno de guard-record.js ni un gancho que frena`);
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
  assert.deepEqual(problemas(c, Object.keys(FRENOS), ganchosQueFrenan()), []);
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
