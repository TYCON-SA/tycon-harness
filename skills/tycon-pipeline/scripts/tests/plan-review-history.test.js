'use strict';
/**
 * plan-review-history.test.js — cada revisión automática del plan deja su resultado con fecha, sin pisar la anterior, y su
 * constancia guarda cuánto costó, por agente y por tipo de token.
 *
 * Por qué: el corredor escribe siempre en la misma ruta, y la revisión siguiente de la misma sesión pisaba el resultado de
 * la anterior; la constancia guardaba sólo el total de tokens. No se podía saber cuánto costó cada una.
 *
 * Arma lo mínimo que lee `anotar`: el pedido de la revisión, el plan que nombra y el resultado del corredor, en una
 * carpeta de estado temporal. Nada lee la casa real.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/plan-review-history.test.js < /dev/null
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PR = require(path.join(__dirname, '..', 'lib', 'plan-review.js'));
const LANZA = 'ses-coord';
const DESTINO = 'ses-a';
const PLAN = '## Qué hace\n1. Un paso.\n## Archivos\n- README.md\n';

function estado(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-history-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** El pedido que deja la preparación, con su número, y el resultado del corredor en su ruta fija, con su consumo. */
function revision(dir, numero, tokens) {
  const carpeta = path.join(dir, PR.CARPETA, LANZA);
  fs.mkdirSync(carpeta, { recursive: true });
  const planFile = path.join(dir, 'plan.md');
  fs.writeFileSync(planFile, PLAN);
  fs.writeFileSync(path.join(carpeta, `${DESTINO}.pending.json`), JSON.stringify({ numero, lanzo: LANZA, destino: DESTINO, informativa: false,
    corte: 'all', corrida: { storyId: '9.91' }, storyId: '9.91', planFile, storyFile: null, huellas: { plan: PR.sha(PLAN) }, delicate: { value: false } }));
  const uso = { total: tokens, por_fase: { Hunt: tokens },
    por_agente: { 'plan-hunt:ac': { fase: 'Hunt', corredor: 'claude', modelo: 'opus', intentos: 1, input_tokens: tokens, output_tokens: 0 } } };
  const resultado = { pedido: numero, confirmed: [], medido: true, lentes_sin_medir: [], corredor: { nombre: 'workflow-lite', tokens: uso } };
  fs.writeFileSync(PR.rutaResultado(dir, LANZA, DESTINO), JSON.stringify(resultado));
  return { resultado, uso };
}

test('T2 PlanReview_EachReviewKept_WithUsageByAgent — dos revisiones dejan dos resultados con fecha y su consumo', (t) => {
  const dir = estado(t);
  const r1 = revision(dir, 'pedido-1', 100);
  const c1 = PR.anotar({ lanza: LANZA, destino: DESTINO, estado: dir, resultado: r1.resultado, modelo: 'opus' });
  assert.ok(!c1.codigo, c1.motivo);
  assert.deepStrictEqual(c1.uso, r1.uso, 'la constancia guarda el consumo por agente');
  const r2 = revision(dir, 'pedido-2', 200);
  const c2 = PR.anotar({ lanza: LANZA, destino: DESTINO, estado: dir, resultado: r2.resultado, modelo: 'opus' });
  assert.deepStrictEqual(c2.uso, r2.uso);
  const guardados = PR.resultadosGuardados(dir, LANZA, DESTINO);
  assert.strictEqual(guardados.length, 2, JSON.stringify(guardados));
  assert.ok(guardados.every((g) => /\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d/.test(path.basename(g))), 'con fecha en el nombre');
  const leidos = guardados.map((g) => JSON.parse(fs.readFileSync(g, 'utf8')));
  assert.deepStrictEqual(leidos.map((j) => j.corredor.tokens.total).sort(), [100, 200], 'la primera no se pisó');
  assert.strictEqual(c2.resultado_guardado, guardados.find((g) => JSON.parse(fs.readFileSync(g, 'utf8')).corredor.tokens.total === 200));
  // guardar dos veces el mismo resultado no lo duplica
  assert.strictEqual(PR.guardarResultado(dir, LANZA, DESTINO), c2.resultado_guardado);
  assert.strictEqual(PR.resultadosGuardados(dir, LANZA, DESTINO).length, 2);
});

// Pedido del 20/11: una revisión cortada no dejaba lo que gastó. El corredor deja su consumo al momento (`rutaUso`), y la
// constancia lo toma de ahí cuando el resultado no lo trae, marcado como cortada; el de otra revisión no se toma.
function revisionCortada(dir, numero, pedidoDelUso) {
  const carpeta = path.join(dir, PR.CARPETA, LANZA);
  fs.mkdirSync(carpeta, { recursive: true });
  const planFile = path.join(dir, 'plan.md');
  fs.writeFileSync(planFile, PLAN);
  fs.writeFileSync(path.join(carpeta, `${DESTINO}.pending.json`), JSON.stringify({ numero, lanzo: LANZA, destino: DESTINO, informativa: false,
    corte: 'all', corrida: { storyId: '9.91' }, storyId: '9.91', planFile, storyFile: null, huellas: { plan: PR.sha(PLAN) }, delicate: { value: false } }));
  const tokens = { total: 40, por_fase: { Hunt: 40 }, por_agente: { 'plan-hunt:ac': { fase: 'Hunt', corredor: 'claude', modelo: 'opus', intentos: 1, input_tokens: 30, output_tokens: 10 } } };
  fs.writeFileSync(PR.rutaUso(dir, LANZA, DESTINO), JSON.stringify({ pedido: pedidoDelUso, completo: false, tokens }));
  return tokens;
}

test('T3 PlanReview_CutReview_KeepsItsUsage — sin resultado, la constancia guarda lo gastado hasta el corte', (t) => {
  const dir = estado(t);
  const tokens = revisionCortada(dir, 'pedido-1', 'pedido-1');
  const c = PR.anotar({ lanza: LANZA, destino: DESTINO, estado: dir, resultado: null, sinHerramienta: 'se cortó', modelo: 'opus' });
  assert.strictEqual(c.veredicto, 'sin-veredicto');
  assert.deepStrictEqual(c.uso, { ...tokens, cortada: true });
  assert.ok(c.uso_guardado && fs.existsSync(c.uso_guardado), 'el consumo queda guardado con fecha');
});

// Pase adversarial (21/11): la ruta fija conserva el resultado de la revisión anterior, y `--result <ruta fija>` se lo pasa
// a anotar. Su consumo no es el de ésta: vale el de la cortada.
test('T6 PlanReview_CutAfterAnotherReview_TakesItsOwnUsage — con el resultado viejo en la ruta fija, vale el consumo de la cortada', (t) => {
  const dir = estado(t);
  const viejo = { pedido: 'pedido-1', confirmed: [], medido: true, corredor: { nombre: 'workflow-lite', tokens: { total: 999, por_fase: { Hunt: 999 }, por_agente: {} } } };
  const tokens = revisionCortada(dir, 'pedido-2', 'pedido-2');
  const c = PR.anotar({ lanza: LANZA, destino: DESTINO, estado: dir, resultado: viejo, modelo: 'opus' });
  assert.strictEqual(c.veredicto, 'sin-veredicto');
  assert.deepStrictEqual(c.uso, { ...tokens, cortada: true });
});

test('T4 PlanReview_UsageOfAnotherReview_NotTaken — el consumo de otra revisión no se le cuenta a ésta', (t) => {
  const dir = estado(t);
  revisionCortada(dir, 'pedido-2', 'pedido-1');
  const c = PR.anotar({ lanza: LANZA, destino: DESTINO, estado: dir, resultado: null, sinHerramienta: 'se cortó', modelo: 'opus' });
  assert.strictEqual(c.uso, null);
});

test('T5 PlanReview_CutUsage_KeptWithDate — el consumo se guarda con fecha, una vez, y no cuenta como resultado', (t) => {
  const dir = estado(t);
  revisionCortada(dir, 'pedido-1', 'pedido-1');
  const g = PR.guardarUso(dir, LANZA, DESTINO);
  assert.ok(g && /\.uso\.json$/.test(g) && /\d{4}-\d\d-\d\dT/.test(path.basename(g)), String(g));
  assert.strictEqual(PR.guardarUso(dir, LANZA, DESTINO), g, 'guardar dos veces el mismo no lo duplica');
  assert.strictEqual(JSON.parse(fs.readFileSync(g, 'utf8')).pedido, 'pedido-1');
  assert.strictEqual(PR.resultadosGuardados(dir, LANZA, DESTINO).length, 0, 'no se cuenta como un resultado');
});
