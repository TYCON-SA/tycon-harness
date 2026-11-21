'use strict';
// adversarial-verifiers.test.js — cuántos verificadores lanza el pase y qué lentes corre el modo plan.
//
// Lo que no se puede perder:
//   · con un verificador por lente, cada hallazgo recibe su propia respuesta, con su id: uno sin respuesta queda «sin
//     veredicto», nunca confirmado ni descartado; una respuesta repetida o con un id que no está se descarta y se anota;
//   · con uno por hallazgo, todo queda como antes;
//   · el modo plan corre sólo las lentes pedidas, y el resultado dice cuántos agentes corrieron por fase.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const GUION = path.join(SCRIPTS, 'adversarial-verify.workflow.js');
const WFLITE = path.join(SCRIPTS, 'workflow-lite.js');
const P = require('../lib/review-policy.js');
const BASE = 'a'.repeat(40);
const PEDIDO = 'b'.repeat(32);

const fuente = fs.readFileSync(GUION, 'utf8');
const LENTES_CODIGO = [...fuente.matchAll(/key: '([a-z-]+)',\s*\n\s*prompt: `(LENTE: [^.]{8,40})/g)].map((m) => ({ key: m[1], marca: m[2] }));

/** Corre el guion en el proceso, con un `agent()` falso. Devuelve el resultado y las llamadas por tipo. */
async function correr(args, responder) {
  const source = fuente.replace(/^export const meta =/m, 'const meta =');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('args', 'log', 'agent', 'parallel', 'pipeline', source);
  const llamadas = { hunt: 0, verify: 0 };
  const logs = [];
  const agent = async (prompt, o) => {
    const tipo = o && o.phase === 'Hunt' ? 'hunt' : 'verify';
    llamadas[tipo] += 1;
    return responder(tipo, prompt, o);
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const r = await fn(args, (m) => logs.push(m), agent, parallel, null);
  return { r, llamadas, logs };
}

const hallazgo = (file, summary, severity = 'bug') => ({ severity, file, line: 1, summary, repro: 'con [1]', confidence: 'high' });

// Siete hallazgos en tres lentes: 3, 2 y 2.
const REPARTO = { 0: [hallazgo('a.js', 'uno-a'), hallazgo('b.js', 'dos-a'), hallazgo('c.js', 'tres-a')], 1: [hallazgo('d.js', 'uno-b'), hallazgo('e.js', 'dos-b')], 2: [hallazgo('f.js', 'uno-c'), hallazgo('g.js', 'dos-c')] };

/** Los ids que pide un verificador por lente, en el orden del pedido. */
const idsDe = (prompt) => [...prompt.matchAll(/^ID=(\S+)$/gm)].map((m) => m[1]);

/** Respuestas del verificador de una lente: todas CONFIRMED, menos lo que se diga. */
function respuestaDeLente(prompt, { faltan = [], extra = [] } = {}) {
  const ids = idsDe(prompt).filter((id) => !faltan.includes(id));
  const verdicts = ids.map((id) => ({ id, verdict: 'CONFIRMED', reasoning: `reproducido ${id}`, adjusted_severity: 'bug', probe_dir: '' }));
  return { verdicts: [...verdicts, ...extra] };
}

test('T50 AdversarialVerifiers_UnVerificadorPorLente @story-8.221 @ac-39 — modo código: tres verificadores para siete hallazgos, una respuesta por id', async () => {
  const lentesConH = [0, 1, 2].map((i) => LENTES_CODIGO[i].key);
  const hunt = (prompt) => {
    const i = LENTES_CODIGO.findIndex((l) => prompt.includes(l.marca));
    return { lens: LENTES_CODIGO[i].key, base: BASE, probe_dir: '', findings: REPARTO[i] || [] };
  };
  const { r, llamadas } = await correr({ repo: '/tmp/r', files: ['a.js'], runDir: '/tmp/r/run', base: BASE, verifiers: 'per_lens' }, (tipo, prompt) => {
    if (tipo === 'hunt') return hunt(prompt);
    if (prompt.includes(`VERIFICADOR DE LA LENTE ${lentesConH[0]}`)) {
      // una repetida y un id que no está
      return respuestaDeLente(prompt, { extra: [{ id: `${lentesConH[0]}-1`, verdict: 'REFUTED', reasoning: 'otra vez', adjusted_severity: 'bug', probe_dir: '' },
        { id: 'inventado-9', verdict: 'CONFIRMED', reasoning: 'no está', adjusted_severity: 'bug', probe_dir: '' }] });
    }
    if (prompt.includes(`VERIFICADOR DE LA LENTE ${lentesConH[1]}`)) return respuestaDeLente(prompt, { faltan: [`${lentesConH[1]}-2`] });
    return respuestaDeLente(prompt);
  });
  assert.strictEqual(llamadas.verify, 3, 'un verificador por lente con hallazgos');
  assert.strictEqual(r.detalle.length, 7);
  const sinV = r.detalle.filter((d) => d.estado === 'sin-veredicto');
  assert.strictEqual(sinV.length, 1, 'el que no tuvo respuesta queda sin veredicto');
  assert.strictEqual(sinV[0].summary, 'dos-b');
  assert.strictEqual(r.confirmed.length, 6);
  assert.strictEqual(r.medido, false);
  assert.strictEqual(r.respuestas_descartadas.length, 2);
  assert.ok(r.respuestas_descartadas.some((d) => /repetida/.test(d.motivo)));
  assert.ok(r.respuestas_descartadas.some((d) => d.id === 'inventado-9'));
  // la primera respuesta de un id es la que vale
  assert.strictEqual(r.detalle.find((d) => d.summary === 'uno-a').estado, 'confirmado');

  // con uno por hallazgo, lo de hoy: un verificador por clase
  const hoy = await correr({ repo: '/tmp/r', files: ['a.js'], runDir: '/tmp/r/run', base: BASE, verifiers: 'per_finding' }, (tipo, prompt) => {
    if (tipo === 'hunt') return hunt(prompt);
    return { verdict: 'CONFIRMED', reasoning: 'ok', adjusted_severity: 'bug', probe_dir: '', todos_el_mismo_defecto: true };
  });
  assert.strictEqual(hoy.llamadas.verify, hoy.r.clases);
  assert.ok(hoy.llamadas.verify > 3);
});

test('T50 AdversarialVerifiers_UnVerificadorPorLente_ModoPlan @story-8.221 @ac-39 — modo plan: un verificador por lente; con el corredor, los agentes por fase', async () => {
  const lentes = P.PLAN_LENSES.slice(0, 3);
  const plan = { modo: 'plan', repo: '/tmp/r', storyTexto: 'historia', planTexto: 'plan', pedido: PEDIDO, lenses: lentes, verifiers: 'per_lens' };
  const { r, llamadas } = await correr(plan, (tipo, prompt) => {
    if (tipo === 'hunt') {
      const lens = lentes.find((l) => prompt.includes(`LENTE DEL PLAN: ${l}`));
      return { lens, findings: lens === lentes[0] ? [hallazgo('plan', 'p1'), hallazgo('plan', 'p2')] : [hallazgo('plan', `p-${lens}`)] };
    }
    return respuestaDeLente(prompt);
  });
  assert.strictEqual(llamadas.hunt, 3);
  assert.strictEqual(llamadas.verify, 3);
  assert.strictEqual(r.detalle.length, 4);
  assert.ok(r.detalle.every((d) => d.estado === 'confirmado'));

  // con workflow-lite y un corredor falso: el resultado trae los agentes por fase y los tokens en null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-verif-'));
  try {
    const stub = path.join(dir, 'stub.js');
    fs.writeFileSync(stub, `
const p = process.env.TYCON_WFLITE_PROMPT || '';
if (/LENTE DEL PLAN: /.test(p)) { console.log(JSON.stringify({ lens: 'x', findings: [{ severity: 'nit', file: 'plan', line: 1, summary: 's', repro: 'r', confidence: 'high' }] })); }
else { const ids = [...p.matchAll(/^ID=(\\S+)$/gm)].map((m) => m[1]); console.log(JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: 'REFUTED', reasoning: 'no', adjusted_severity: 'nit', probe_dir: '' })) })); }
`);
    const out = path.join(dir, 'r.json');
    const res = spawnSync(process.execPath, [WFLITE, GUION, '--args', JSON.stringify({ ...plan, repo: dir, lenses: ['suposicion-falsa'] }), '--out', out],
      { encoding: 'utf8', env: { ...process.env, TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${stub}` } });
    assert.strictEqual(res.status, 0, res.stderr);
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepStrictEqual(j.corredor.agentes, { Hunt: 1, Verify: 1 });
    assert.strictEqual(j.corredor.tokens, null, 'sin tokens del corredor: null, nunca ausente');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('T50 AdversarialVerifiers_ModoPlanUnoPorHallazgoConTope @story-8.221 @ac-39 — con per_finding, el plan verifica como mucho 20, los de mayor gravedad; los demás quedan sin veredicto y se dice', async () => {
  // 20 nits primero y 3 bugs al final: entran los 3 bugs y los 17 primeros nits
  const nits = Array.from({ length: 20 }, (_, i) => hallazgo('plan', `nit-${i}`, 'nit'));
  const bugs = Array.from({ length: 3 }, (_, i) => hallazgo('plan', `bug-${i}`, 'bug'));
  const verificados = [];
  const args = { modo: 'plan', repo: '/tmp/r', storyTexto: 'h', planTexto: 'p', pedido: PEDIDO, lenses: ['suposicion-falsa'] };
  const { r, llamadas, logs } = await correr({ ...args, verifiers: 'per_finding' }, (tipo, prompt) => {
    if (tipo === 'hunt') return { lens: 'suposicion-falsa', findings: [...nits, ...bugs] };
    verificados.push(/summary=(\S+)/.exec(prompt)[1]);
    return { verdict: 'REFUTED', reasoning: 'no', adjusted_severity: 'nit', probe_dir: '', todos_el_mismo_defecto: true };
  });
  assert.strictEqual(llamadas.verify, 20);
  for (const b of ['bug-0', 'bug-1', 'bug-2']) assert.ok(verificados.includes(b), `${b} se verifica`);
  const sin = r.detalle.filter((d) => d.estado === 'sin-veredicto').map((d) => d.summary);
  assert.deepStrictEqual(sin, ['nit-17', 'nit-18', 'nit-19']);
  assert.strictEqual(r.medido, false, 'con hallazgos sin veredicto el plan no cuenta como medido');
  assert.strictEqual(r.fuera_del_tope, 3);
  assert.strictEqual(r.tope_verificar, 20);
  assert.ok(logs.some((l) => /23 hallazgos del plan; verifico 20 \(tope 20\)/.test(l)), logs.join('\n'));
  // por lente no hay tope: el campo no aparece
  const { r: porLente } = await correr({ ...args, verifiers: 'per_lens' }, (tipo, prompt) =>
    (tipo === 'hunt' ? { lens: 'suposicion-falsa', findings: [...nits, ...bugs] } : respuestaDeLente(prompt)));
  assert.strictEqual(porLente.fuera_del_tope, undefined);
});

test('T61 AdversarialVerifiers_ElModoPlanCorreLasLentesDelPerfil @story-8.221 @ac-48 — de fábrica una lente; las cuatro si se piden; lo malo cae al de fábrica', async () => {
  const fabrica = P.normalize({}).values.plan_review.lenses;
  assert.deepStrictEqual(fabrica, ['suposicion-falsa']);
  const correrPlan = (lenses) => correr({ modo: 'plan', repo: '/tmp/r', storyTexto: 'h', planTexto: 'p', pedido: PEDIDO, lenses, verifiers: 'per_lens' },
    (tipo, prompt) => (tipo === 'hunt' ? { lens: 'x', findings: [] } : respuestaDeLente(prompt)));
  const uno = await correrPlan(fabrica);
  assert.strictEqual(uno.llamadas.hunt, 1);
  assert.deepStrictEqual(uno.r.lentes.map((l) => l.lens), ['suposicion-falsa']);
  const cuatro = await correrPlan(P.PLAN_LENSES.slice());
  assert.strictEqual(cuatro.llamadas.hunt, 4);
  // una lente que no contesta sólo cuenta si se pidió
  const muerta = await correr({ modo: 'plan', repo: '/tmp/r', storyTexto: 'h', planTexto: 'p', pedido: PEDIDO, lenses: ['suposicion-falsa'], verifiers: 'per_lens' },
    (tipo) => (tipo === 'hunt' ? null : { verdicts: [] }));
  assert.deepStrictEqual(muerta.r.lentes_sin_medir, ['suposicion-falsa']);
  // lo malo cae al de fábrica, con su problema
  for (const malo of [[], ['suposicion-falsa', 'suposicion-falsa'], ['inventada']]) {
    const n = P.normalize({ plan_review: { lenses: malo } });
    assert.deepStrictEqual(n.values.plan_review.lenses, ['suposicion-falsa']);
    assert.ok(n.problems.some((p) => p.path === 'plan_review.lenses'));
  }
  // en el guion, una lente desconocida no corre: corre la de fábrica y se dice
  const rara = await correrPlan(['inventada']);
  assert.strictEqual(rara.llamadas.hunt, 1);
  assert.ok(rara.logs.some((l) => /inventada/.test(l)));
  // el modo código no cambia: sus lentes de siempre
  const codigo = await correr({ repo: '/tmp/r', files: ['a.js'], runDir: '/tmp/r/run', base: BASE }, () => ({ lens: 'x', base: BASE, probe_dir: '', findings: [] }));
  assert.strictEqual(codigo.llamadas.hunt, LENTES_CODIGO.length);
});
