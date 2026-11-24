'use strict';
// suggestion-choices.test.js — si la persona eligió la opción que sugería el agente (historia 8.324): se mide desde las
// conversaciones, cada cuadro de opciones con una opción recomendada contra la respuesta que llegó. Y cada corrida del
// pipeline lo guarda en su volcado (tokens-digest.js, `consumo.decisiones`).
// Todo con conversaciones de juguete en carpetas temporales. Nada lee la casa real.
// Correr: cd scripts/tests && HOME=$(mktemp -d) node --test suggestion-choices.test.js < /dev/null

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SC = path.join(ROOT, 'scripts', 'metrics', 'suggestion-choices.js');
const TD = require(path.join(ROOT, 'scripts', 'metrics', 'tokens-digest.js'));
const SID = 'aaaaaaaa-1111-4aaa-8bbb-000000008324';

const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
function escribirJsonl(ruta, lineas) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, `${lineas.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
}

/** Un cuadro de opciones (la llamada) y, si hay `elegida`, su respuesta, como los deja Claude Code. */
function cuadro(id, pregunta, opciones, elegida, { ts = '2026-11-21T10:00:00.000Z', tsRespuesta = ts } = {}) {
  const uso = { type: 'assistant', timestamp: ts, message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion',
    input: { questions: [{ question: pregunta, header: 'h', multiSelect: false, options: opciones.map((label) => ({ label, description: 'd' })) }] } }] } };
  if (elegida === undefined) return [uso];
  const resp = { type: 'user', timestamp: tsRespuesta, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `User has answered your questions: "${pregunta}"="${elegida}".` }] },
    toolUseResult: { questions: [], answers: { [pregunta]: elegida } } };
  return [uso, resp];
}
const medir = (archivo) => spawnSync(process.execPath, [SC, '--transcript', archivo, '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir() } });

test('T7 Sugerencias_CuentaLasElegidas @story-8.324 @ac-6', (t) => {
  const d = tmp(t, 'sugerencias-');
  const f = path.join(d, 'c.jsonl');
  escribirJsonl(f, [
    ...cuadro('u1', '¿Va A?', ['A (Recommended)', 'B'], 'A (Recommended)'),
    ...cuadro('u2', '¿Va C?', ['C', 'D (Recomendado)'], 'D (Recomendado)'),
    ...cuadro('u3', '¿Va E?', ['E (Recomendada)', 'F'], 'F'),
  ]);
  const r = medir(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepStrictEqual({ con: j.con_sugerencia, si: j.eligio_sugerencia, otra: j.otra }, { con: 3, si: 2, otra: 1 });
  assert.deepStrictEqual(j.cuadros_detalle.map((c) => [c.pregunta, c.sugerida, c.elegida, c.coincide]), [
    ['¿Va A?', 'A (Recommended)', 'A (Recommended)', true], ['¿Va C?', 'D (Recomendado)', 'D (Recomendado)', true], ['¿Va E?', 'E (Recomendada)', 'F', false]]);
});

test('T8 Sugerencias_SinSugerenciaOtherYCortado @story-8.324 @ac-7', (t) => {
  const d = tmp(t, 'sugerencias-');
  const f = path.join(d, 'c.jsonl');
  escribirJsonl(f, [
    ...cuadro('u1', '¿Sin sugerencia?', ['A', 'B'], 'A'),
    ...cuadro('u2', '¿Con texto libre?', ['C (Recommended)', 'D'], 'algo que escribió la persona'),
    ...cuadro('u3', '¿Cortado?', ['E (Recommended)', 'F'], undefined),
  ]);
  const j = JSON.parse(medir(f).stdout);
  assert.strictEqual(j.cuadros, 3);
  assert.strictEqual(j.con_sugerencia, 2, 'el cuadro sin recomendada no cuenta');
  assert.strictEqual(j.otra, 1, 'el texto libre cuenta como otra');
  assert.strictEqual(j.sin_respuesta, 1);
  assert.strictEqual(j.eligio_sugerencia, 0);
});

test('T9 Sugerencias_ConversacionIlegible_Sale2 @story-8.324 @ac-7', (t) => {
  const d = tmp(t, 'sugerencias-');
  const r = medir(path.join(d, 'no-existe.jsonl'));
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /no pude leer/);
  const f = path.join(d, 'c.jsonl');
  escribirJsonl(f, ['{ roto', ...cuadro('u1', '¿Va A?', ['A (Recommended)', 'B'], 'A (Recommended)')]);
  const j = JSON.parse(medir(f).stdout);
  assert.strictEqual(j.eligio_sugerencia, 1);
  assert.strictEqual(j.lineas_ilegibles, 1);
});

test('T10 Volcado_TraeLasDecisiones @story-8.324 @ac-8', (t) => {
  const home = tmp(t, 'sugerencias-volcado-');
  escribirJsonl(path.join(home, '.claude', 'projects', '-opt-acme-repo', `${SID}.jsonl`), [
    { type: 'assistant', timestamp: '2026-11-21T10:01:00.000Z', message: { id: 'r1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ...cuadro('u1', '¿Dentro?', ['A (Recommended)', 'B'], 'A (Recommended)', { ts: '2026-11-21T10:05:00.000Z' }),
    ...cuadro('u2', '¿Respuesta después del tramo?', ['C (Recommended)', 'D'], 'D', { ts: '2026-11-21T10:20:00.000Z', tsRespuesta: '2026-11-21T11:00:00.000Z' }),
    ...cuadro('u3', '¿Fuera?', ['E (Recommended)', 'F'], 'E (Recommended)', { ts: '2026-11-21T12:00:00.000Z' }),
  ]);
  const dump = path.join(home, 'timing-history', 'corrida.json');
  fs.mkdirSync(path.dirname(dump), { recursive: true });
  fs.writeFileSync(dump, JSON.stringify({ archivedAt: '2026-11-21T10:30:00.000Z', marker: { storyId: '9.9', sessionId: SID, startedAt: '2026-11-21T10:00:00.000Z',
    lastTouch: '2026-11-21T10:00:00.000Z', stepTimings: {} }, gates: [] }));
  const res = TD.rescatarCorrida(dump, { projectsDir: path.join(home, '.claude', 'projects'), home, ahora: '2026-11-22T00:00:00.000Z', proveedor: { provider: 'anthropic', origin: 'env' }, env: {} });
  assert.ok(!res.error, res.error);
  const dec = JSON.parse(fs.readFileSync(dump, 'utf8')).consumo.decisiones;
  assert.deepStrictEqual({ con: dec.con_sugerencia, si: dec.eligio_sugerencia, otra: dec.otra, sin: dec.sin_respuesta }, { con: 2, si: 1, otra: 1, sin: 0 });

  // una corrida de Codex no tiene cuadros de opciones: no medido, con su motivo
  const home2 = tmp(t, 'sugerencias-codex-');
  escribirJsonl(path.join(home2, '.codex', 'sessions', '2026', '11', '21', `rollout-2026-11-21T10-00-00-${SID}.jsonl`), [
    { timestamp: '2026-11-21T10:00:00.000Z', type: 'session_meta', payload: { id: SID, cwd: '/opt/acme/repo' } },
    { timestamp: '2026-11-21T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-luna', cwd: '/opt/acme/repo' } },
    { timestamp: '2026-11-21T10:00:03.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 } } } },
  ]);
  const dump2 = path.join(home2, 'timing-history', 'corrida.json');
  fs.mkdirSync(path.dirname(dump2), { recursive: true });
  fs.writeFileSync(dump2, JSON.stringify({ marker: { storyId: '9.9', sessionId: SID, stepTimings: {} }, gates: [] }));
  TD.rescatarCorrida(dump2, { projectsDir: path.join(home2, '.claude', 'projects'), codexDir: path.join(home2, '.codex', 'sessions'), home: home2,
    ahora: '2026-11-22T00:00:00.000Z', proveedor: { provider: 'openai', origin: 'env' }, env: { CODEX_SESSION_ID: SID } });
  const dec2 = JSON.parse(fs.readFileSync(dump2, 'utf8')).consumo.decisiones;
  assert.strictEqual(dec2 && dec2.estado, 'no_medido');
  assert.match(dec2.motivo, /Codex/);
});

// Pase adversarial (21/11): Claude Code guarda copias del pedido a la API (`api-request-blob`) que repiten cuadros y
// respuestas sin `toolUseResult`; contaban dos veces y pisaban la respuesta. Y un cuadro de varias opciones se comparaba
// con una sola.
test('T12 Sugerencias_CopiasDeLaApiYVariasOpciones @story-8.324 @ac-6 @ac-7', (t) => {
  const d = tmp(t, 'sugerencias-');
  const f = path.join(d, 'c.jsonl');
  const [uso, resp] = cuadro('u1', '¿Va A?', ['A (Recomendado)', 'B'], 'A (Recomendado)');
  const copia = (o) => ({ type: 'api-request-blob', message: { role: o.message.role, content: o.message.content } });
  const multi = cuadro('u2', '¿Cuáles?', ['X (Recommended)', 'Y (Recommended)', 'Z'], 'Y (Recommended), X (Recommended)');
  multi[0].message.content[0].input.questions[0].multiSelect = true;
  escribirJsonl(f, [uso, resp, copia(uso), copia(resp), ...multi]);
  const j = JSON.parse(medir(f).stdout);
  assert.strictEqual(j.cuadros, 2, 'cada cuadro una vez');
  assert.strictEqual(j.sin_respuesta, 0, 'la copia no pisa la respuesta');
  assert.strictEqual(j.eligio_sugerencia, 2, 'eligió las dos sugeridas del cuadro de varias opciones');
});

// Pase adversarial, segunda vuelta (21/11): una etiqueta sugerida con «, » adentro en un cuadro de varias opciones.
test('T13 Sugerencias_EtiquetaConComas @story-8.324 @ac-6', (t) => {
  const d = tmp(t, 'sugerencias-');
  const f = path.join(d, 'c.jsonl');
  const labels = ['Cinco firmas (Recomendado)', 'Firmas por click, tandas B, C y D (Recomendado)', 'Nada'];
  const multi = cuadro('u1', '¿Cuáles?', labels, 'Firmas por click, tandas B, C y D (Recomendado), Cinco firmas (Recomendado)');
  multi[0].message.content[0].input.questions[0].multiSelect = true;
  const otra = cuadro('u2', '¿Y acá?', labels, 'Cinco firmas (Recomendado), Nada');
  otra[0].message.content[0].input.questions[0].multiSelect = true;
  escribirJsonl(f, [...multi, ...otra]);
  const j = JSON.parse(medir(f).stdout);
  assert.deepStrictEqual({ si: j.eligio_sugerencia, otra: j.otra }, { si: 1, otra: 1 });
});
