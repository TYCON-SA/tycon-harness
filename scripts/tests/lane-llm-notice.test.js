'use strict';
/**
 * lane-llm-notice.test.js — el aviso de arranque de los arreglos rápidos (@story-8.141).
 *
 * El arreglo rápido lo firma el dueño (en la ventana, en su terminal o por la coordinadora). El aviso de arranque cuenta
 * los de los últimos 7 días por cómo se firmaron, sólo cuando hay alguno nuevo desde el último aviso; `--report` da la
 * misma cuenta a pedido. Los eventos del juez por modelo que ya no existe no cuentan ni aparecen.
 *
 *   8.141 T16 · LaneLlmNotice_CuentaPorVia
 *
 * stable-data: cada evento se fecha relativo a la hora de la corrida (hace 1 día, hace 9 días), igual que lo mide el
 * aviso, así que el resultado no depende del día en que se corre.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const AVISO = path.join(__dirname, '..', 'hooks', 'lane-llm-notice.js');
const DIA = 24 * 60 * 60 * 1000;

function estado(t, eventos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-notice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'adhoc.log'), `${eventos.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return dir;
}
const correr = (dir, args = []) => spawnSync(process.execPath, [AVISO, ...args], {
  encoding: 'utf8', env: { ...process.env, TYCON_PIPELINE_STATE_DIR: dir, TYCON_LANE_LLM_NOTICE: '', TYCON_EVAL_SANDBOX: '' },
});
const hace = (ms) => new Date(Date.now() - ms).toISOString();

// 8.141 T16 LaneLlmNotice_CuentaPorVia @story-8.141 @ac-9
// 🔴 Falla con: la cuenta que mezcla las vías, cuenta lo de hace más de 7 días o los eventos del juez, un aviso que sale
//    en cada arranque, o un renglón que todavía habla del modelo.
test('8.141 T16 LaneLlmNotice_CuentaPorVia', (t) => {
  const eventos = [
    { ts: hace(DIA), kind: 'ADHOC_SET', via: 'ventana', reason: 'a' },
    { ts: hace(DIA), kind: 'ADHOC_SET', via: 'ventana', reason: 'b' },
    { ts: hace(DIA), kind: 'ADHOC_UPDATE', via: 'ventana', reason: 'b' },
    { ts: hace(DIA), kind: 'ADHOC_SET', via: 'terminal', reason: 'c' },
    { ts: hace(DIA), kind: 'ADHOC_SET', via: 'delegacion', by: 'ses-coord', reason: 'd' },
    { ts: hace(DIA), kind: 'ADHOC_SET', reason: 'viejo, sin via' },
    { ts: hace(9 * DIA), kind: 'ADHOC_SET', via: 'ventana', reason: 'de hace 9 días' },
    { ts: hace(DIA), kind: 'ADHOC_LLM_OVERRIDE_LANE', reason: 'juez', lanePrompt: 'x', via: 'llm' },
    { ts: hace(DIA), kind: 'ADHOC_SET_UNJUDGED', reason: 'juez', via: 'error' },
    { ts: hace(DIA), kind: 'ADHOC_DENIED_REASON', reason: 'juez', via: 'llm' },
  ];
  const dir = estado(t, eventos);
  const r = correr(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /arreglos rápidos en 7 días: 6 \(en la ventana: 3, en la terminal: 1, por la coordinadora: 1\)/);
  assert.match(r.stdout, /sin dato de cómo se firmó: 1/);
  assert.doesNotMatch(r.stdout, /modelo|desempate|juez|TYCON_LANE_LLM=/i);
  // un segundo arranque sin arreglos nuevos no dice nada (el sello)
  assert.strictEqual(correr(dir).stdout, '');
  // sin arreglos en 7 días, nada
  const viejo = estado(t, [{ ts: hace(9 * DIA), kind: 'ADHOC_SET', via: 'ventana', reason: 'x' }, eventos[7]]);
  assert.strictEqual(correr(viejo).stdout, '');
  // --report: la cuenta por vía en su ventana de días, sin los renglones del modelo
  const rep = correr(dir, ['--report']);
  assert.strictEqual(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /en la ventana:\s+4/, 'en 30 días entra el de hace 9');
  assert.match(rep.stdout, /en la terminal:\s+1/);
  assert.match(rep.stdout, /por la coordinadora:\s+1/);
  assert.match(rep.stdout, /sin dato:\s+1/);
  assert.doesNotMatch(rep.stdout, /modelo|desempate|juez/i);
});
