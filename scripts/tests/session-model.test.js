'use strict';
/**
 * session-model.test.js — el modelo de una sesión de Claude, leído de su conversación (`scripts/lib/session-model.js`).
 *
 *   T4 SessionModel_FirstRealModel_ChunkedRead      — el primer `message.model` que no es `<synthetic>`, por tramos
 *   T5 SessionModel_MissingOrUnreadable_NotMeasured — sin archivo, ilegible o sin modelo: «no medido» con el motivo
 *
 * 🔴 Falla con: un modelo supuesto donde no se pudo leer, el `<synthetic>` contado como modelo, un renglón partido entre
 *    dos tramos que se pierde, o una conversación de otra sesión.
 * stable-data: conversaciones de juguete en una HOME temporal; no lee el reloj.
 * 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SM = require(path.join(__dirname, '..', 'lib', 'session-model.js'));

function casa(t) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'modelo-sesion-'));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
}
function conversacion(h, proyecto, sid, renglones) {
  const d = path.join(h, '.claude', 'projects', proyecto);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `${sid}.jsonl`);
  fs.writeFileSync(f, renglones.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return f;
}
const asistente = (model) => ({ type: 'assistant', message: { model, role: 'assistant', content: [] } });

test('T4 SessionModel_FirstRealModel_ChunkedRead — el primer modelo real, leyendo por tramos', (t) => {
  const h = casa(t);
  // más de un tramo antes del modelo: el renglón del modelo cae partido entre dos lecturas
  const relleno = { type: 'user', message: { role: 'user', content: 'x'.repeat(SM.STEP_BYTES - 40) } };
  conversacion(h, '-otro', 'ses-otra', [asistente('claude-haiku-5-5')]);
  conversacion(h, '-repo', 'ses-a', [relleno, asistente('<synthetic>'), relleno, asistente('claude-opus-5-5'), asistente('claude-fable-5-1')]);
  assert.ok(fs.statSync(path.join(h, '.claude', 'projects', '-repo', 'ses-a.jsonl')).size > SM.STEP_BYTES);
  assert.deepEqual(SM.modelOf('ses-a', { home: h }), { model: 'claude-opus-5-5' });
  // con el índice armado una vez, igual
  const indice = SM.transcriptIndex({ home: h });
  assert.deepEqual(SM.modelOf('ses-otra', { home: h, index: indice }), { model: 'claude-haiku-5-5' });
});

test('T5 SessionModel_MissingOrUnreadable_NotMeasured — «no medido» con el motivo de cada caso', (t) => {
  const h = casa(t);
  const sinArchivo = SM.modelOf('ses-nada', { home: h });
  assert.equal(sinArchivo.model, null);
  assert.match(sinArchivo.noMedido, /no encontré la conversación/);

  conversacion(h, '-repo', 'ses-sin', [{ type: 'user', message: { content: 'hola' } }, asistente('<synthetic>'), '{roto']);
  const sinModelo = SM.modelOf('ses-sin', { home: h });
  assert.equal(sinModelo.model, null);
  assert.match(sinModelo.noMedido, /no tiene modelo/);

  const f = conversacion(h, '-repo', 'ses-ilegible', [asistente('claude-opus-5-5')]);
  const io = { ...fs, openSync: (p, ...r) => { if (p === f) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return fs.openSync(p, ...r); } };
  const ilegible = SM.modelOf('ses-ilegible', { home: h, io });
  assert.equal(ilegible.model, null);
  assert.match(ilegible.noMedido, /no pude leer la conversación.*EACCES/);

  const malFormada = SM.modelOf('../ses-a', { home: h });
  assert.equal(malFormada.model, null);
  assert.match(malFormada.noMedido, /sesión sin forma/);
});
