'use strict';

/**
 * refutation.test.js — un hallazgo sólo queda como falso si lo confirma un verificador independiente
 * que corrió el código.
 *
 * `write-findings` exige la constancia de otro agente: el comando que corrió, su salida recortada y la
 * huella. Sin constancia válida, el hallazgo queda `open`; con un verificador que lo reprodujo, no se
 * puede descartar. Cada caso dice arriba qué lo pone en rojo.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const REFUTATION = path.join(SCRIPTS, 'lib', 'refutation.js');

// 🔴 Sale rojo si el módulo no existe: los casos unitarios piden la lib por su ruta real.
const R = () => require(REFUTATION);

const HALLAZGO = { reviewer: 'tycon-silent-failure-hunter', rule: 'SILENT-C2', file: 'src/a.js', line: 12 };
const VERIFICADOR = { agent: 'general-purpose@2026-10-18T10:00:00.000Z', model: 'sonnet' };
const construir = (extra = {}) => R().build({
  finding: HALLAZGO, authorReason: 'el catch sí registra el error', verifier: VERIFICADOR,
  verdict: 'refutado', command: 'node probe.js', output: 'ok: el catch registra', ts: '2026-10-18T10:05:00.000Z', ...extra,
});

// ── T1 (AC 1) ────────────────────────────────────────────────────────────────────────────────
// 🔴 Sale rojo si `validate` acepta una constancia sin comando o sin salida, o no dice qué campo falta.
test('Constancia_Completa_Valida', () => {
  const c = construir();
  const v = R().validate(c, { implementer: 'sesion-1' });
  assert.deepStrictEqual(v, { ok: true, faltan: [], errores: [] });
  assert.strictEqual(c.output_sha256, require('crypto').createHash('sha256').update(c.output).digest('hex'));

  for (const [campo, mutar] of [
    ['command', (x) => { x.command = ''; }],
    ['output', (x) => { x.output = ''; }],
    ['finding.rule', (x) => { x.finding.rule = ''; }],
    ['finding.file', (x) => { x.finding.file = ''; }],
    ['finding.line', (x) => { delete x.finding.line; }],
    ['author_reason', (x) => { x.author_reason = ''; }],
    ['verifier.model', (x) => { x.verifier.model = ''; }],
    ['verdict', (x) => { x.verdict = 'quizas'; }],
  ]) {
    const roto = JSON.parse(JSON.stringify(c));
    mutar(roto);
    const r = R().validate(roto, { implementer: 'sesion-1' });
    assert.strictEqual(r.ok, false, `sin ${campo} tiene que ser inválida`);
    assert.ok(r.faltan.includes(campo), `tiene que nombrar el campo que falta (${campo}): ${JSON.stringify(r)}`);
  }
});

test('Constancia_SalidaRecortada_ConHuella', () => {
  const grande = 'x'.repeat(20000);
  const c = construir({ output: grande });
  assert.ok(Buffer.byteLength(c.output, 'utf8') <= 8192, 'la salida guardada no pasa de 8 KB');
  assert.strictEqual(c.output_truncated, true);
  assert.strictEqual(c.output_sha256, require('crypto').createHash('sha256').update(c.output).digest('hex'));
  assert.strictEqual(R().validate(c, { implementer: 's' }).ok, true);
  // la huella tiene que corresponder a lo guardado: una salida cambiada a mano no vale
  const manoseada = { ...c, output: `${c.output}!` };
  assert.strictEqual(R().validate(manoseada, { implementer: 's' }).ok, false);
});

// ── T2 (AC 1, 3) ─────────────────────────────────────────────────────────────────────────────
// 🔴 Sale rojo si una constancia firmada por la misma sesión que implementó se acepta.
test('Constancia_DelMismoAgente_NoVale', () => {
  const c = construir({ verifier: { agent: 'sesion-1', model: 'opus' } });
  const v = R().validate(c, { implementer: 'sesion-1' });
  assert.strictEqual(v.ok, false);
  assert.match(v.errores.join(' '), /el verificador tiene que ser otro/);
  // el orquestador por su nombre tampoco es un verificador, aunque el registro no traiga su sesión
  const orq = construir({ verifier: { agent: 'orquestador', model: 'opus' } });
  assert.strictEqual(R().validate(orq, { implementer: null }).ok, false);
});

// ── T3 (AC 2) ────────────────────────────────────────────────────────────────────────────────
// 🔴 Sale rojo si un verificador que no demuestra la refutación deja pasar «refutado».
test('Verificador_SinRefutar_DiceReproducido', () => {
  assert.strictEqual(R().decide({ refuted: false, command: 'node p.js', output: 'falla de verdad' }), 'reproducido');
  assert.strictEqual(R().decide({}), 'reproducido');
  assert.strictEqual(R().decide(null), 'reproducido');
  // dice que refutó pero no trae qué corrió ni qué vio: no demostró nada
  assert.strictEqual(R().decide({ refuted: true, command: '', output: 'x' }), 'reproducido');
  assert.strictEqual(R().decide({ refuted: true, command: 'node p.js', output: '' }), 'reproducido');
  assert.strictEqual(R().decide({ refuted: true, command: 'node p.js', output: 'no se da' }), 'refutado');
});

// ── laboratorio de write-findings ───────────────────────────────────────────────────────────
const RUN = '9.9-20261018120000';
function lab() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'refut-'));
  const spec = path.join(d, 'story-9.9-x.md');
  fs.writeFileSync(spec, ['---', 'story: "9.9"', 'title: "t"', 'status: in-progress', '---', '', '# Story 9.9', '',
    '## Acceptance Criteria', '', '1. algo', ''].join('\n'));
  const runDir = path.join(d, '.advisors', 'pipeline-runs', RUN);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'review-roster.json'), `${JSON.stringify({
    version: 1, story: '9.9', written_by: 'on-advisor-run.js', ts: '2026-10-18T12:00:00Z', base_sha: null, tree_sha: null,
    implementer: { kind: 'sesion-principal', session_id: 'sesion-1', model: null },
    reviewers: [{ agent: HALLAZGO.reviewer, kind: 'subagente', model: null, model_source: 'heredado', ts: null, iter: 1 }],
    iterations: 1, iterations_source: 'ledger',
  }, null, 2)}\n`);
  return { d, spec, runDir, findings: path.join(runDir, 'findings.json') };
}

function dejarConstancia(L, c, opts) {
  const id = R().idOf(c.finding);
  fs.mkdirSync(path.join(L.runDir, 'refutations'), { recursive: true });
  fs.writeFileSync(path.join(L.runDir, 'refutations', `${id}.json`), `${JSON.stringify(c, null, 2)}\n`);
  if (!(opts && opts.sinLanzamiento)) sembrarLanzamiento(L, c.verifier.agent);
}

// El registro de lanzamientos de juguete: el HOME del laboratorio. `write-findings` revalida contra él al verificador de
// cada constancia, así que una constancia armada a mano necesita también su lanzamiento.
function sembrarLanzamiento(L, id = VERIFICADOR.agent) {
  const [agente, ts] = id.split('@');
  const dir = path.join(L.d, 'home', '.claude', '.tycon-pipeline', 'advisor-runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'sesion-1.jsonl'), `${JSON.stringify({ ts, advisor: agente, model: 'sonnet' })}\n`);
}

function escribir(L, hallazgos) {
  const home = path.join(L.d, 'home');
  fs.mkdirSync(home, { recursive: true });
  try {
    const out = execFileSync('node', [PIPELINE, 'write-findings', '--repo', L.d, '--story', L.spec, '--findings', '-'],
      { encoding: 'utf8', input: JSON.stringify(hallazgos), env: { ...process.env, HOME: home, USERPROFILE: home } });
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status === undefined ? -1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const hallazgo = (disposition, extra = {}) => ({
  rule_id: HALLAZGO.rule, severity: 'WARNING', advisor: HALLAZGO.reviewer, file: HALLAZGO.file, line: HALLAZGO.line,
  disposition, reason: 'el catch sí registra el error', ...extra,
});
const leer = (L) => JSON.parse(fs.readFileSync(L.findings, 'utf8'));
const limpiar = (L) => fs.rmSync(L.d, { recursive: true, force: true });

// ── T4 (AC 3) ────────────────────────────────────────────────────────────────────────────────
// 🔴 Sale rojo si un `refuted` sin constancia se escribe como `refuted` (hoy queda `refuted`).
test('WriteFindings_RefutedSinConstancia_QuedaOpen', () => {
  const L = lab();
  const r = escribir(L, [hallazgo('refuted')]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.strictEqual(leer(L)[0].disposition, 'open', 'sin constancia no hay «falso»');
  assert.match(r.out, /constancia/, 'el comando dice por qué quedó abierto');
  limpiar(L);
});

// 🔴 Sale rojo si una constancia del propio implementador deja pasar el `refuted`.
test('WriteFindings_RefutedConVerificadorImplementador_QuedaOpen', () => {
  const L = lab();
  dejarConstancia(L, construir({ verifier: { agent: 'sesion-1', model: 'opus' } }));
  const r = escribir(L, [hallazgo('refuted')]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.strictEqual(leer(L)[0].disposition, 'open');
  assert.match(r.out, /el verificador tiene que ser otro/);
  limpiar(L);
});

// 🔴 Sale rojo si una constancia válida de «refutado» no conserva el `refuted`, o si no deja su resumen en el hallazgo.
test('WriteFindings_RefutedConConstanciaValida_SeConserva', () => {
  const L = lab();
  const c = construir();
  dejarConstancia(L, c);
  const r = escribir(L, [hallazgo('refuted')]);
  assert.strictEqual(r.exit, 0, r.out);
  const f = leer(L)[0];
  assert.strictEqual(f.disposition, 'refuted');
  assert.strictEqual(f.refutation.verdict, 'refutado');
  assert.strictEqual(f.refutation.output_sha256, c.output_sha256);
  assert.strictEqual(f.refutation.verifier, VERIFICADOR.agent);
  limpiar(L);
});

// ── T5 (AC 4) ────────────────────────────────────────────────────────────────────────────────
// 🔴 Sale rojo si con una constancia «reproducido» se acepta `waived` o `refuted`; o si se frena `fixed` / `open`.
test('WriteFindings_Reproducido_NoAceptaWaived', () => {
  const L = lab();
  dejarConstancia(L, construir({ verdict: 'reproducido', output: 'el bug se reproduce: sale 200 y debía ser 403' }));
  for (const d of ['waived', 'refuted']) {
    const r = escribir(L, [hallazgo(d)]);
    assert.notStrictEqual(r.exit, 0, `${d} con «reproducido» tiene que rechazarse`);
    assert.match(r.out, /reprodujo|reproducido/);
    assert.ok(!fs.existsSync(L.findings), 'no se escribió nada');
  }
  for (const d of ['fixed', 'open']) {
    const r = escribir(L, [hallazgo(d, { test: 'tests/a.test.js::el catch registra' })]);
    assert.strictEqual(r.exit, 0, `${d} pasa: ${r.out}`);
    const f = leer(L)[0];
    assert.strictEqual(f.disposition, d);
    assert.strictEqual(f.refutation.verdict, 'reproducido');
    fs.rmSync(L.findings);
  }
  limpiar(L);
});

// ── El verificador de un hallazgo: verify-finding y record-refutation (AC 2) ─────────────────────
function cli(args, env) {
  try {
    return { exit: 0, out: execFileSync('node', [PIPELINE, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }) };
  } catch (e) { return { exit: e.status === undefined ? -1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}

// 🔴 Sale rojo si verify-finding no imprime el lanzamiento (prompt y modelo con el criterio reproducir-o-refutar), si
// record-refutation guarda una constancia de un verificador que no figura en el registro de spawns, o si deja pasar
// la del propio implementador.
test('VerifyFinding_ImprimeElLanzamiento_RecordRefutation_ExigeUnSpawnReal', () => {
  const L = lab();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'refut-home-'));
  const env = { HOME: home, USERPROFILE: home };
  const fj = path.join(L.d, 'hallazgo.json');
  fs.writeFileSync(fj, JSON.stringify({ reviewer: HALLAZGO.reviewer, rule: HALLAZGO.rule, file: HALLAZGO.file, line: 12, summary: 's', author_reason: 'el catch registra' }));
  const v = cli(['verify-finding', '--finding', fj, '--repo', L.d, '--model', 'opus'], env);
  assert.strictEqual(v.exit, 0, v.out);
  const lanz = JSON.parse(v.out);
  assert.strictEqual(lanz.model, 'opus');
  assert.match(lanz.prompt, /REPRODUCIRLO/);
  assert.match(lanz.prompt, /ante la duda, el hallazgo es real/);
  assert.match(lanz.prompt, /el catch registra/);

  const rj = path.join(L.d, 'resultado.json');
  fs.writeFileSync(rj, JSON.stringify({ refuted: true, command: 'node probe.js', output: 'no se da' }));
  const base = ['record-refutation', '--finding', fj, '--result', rj, '--verifier-model', 'sonnet', '--run-dir', L.runDir];
  // sin lanzamiento en el registro de spawns: no hay constancia
  const sin = cli([...base, '--verifier', 'general-purpose@2026-10-18T10:00:00.000Z'], env);
  assert.notStrictEqual(sin.exit, 0);
  assert.match(sin.out, /registro de spawns/);
  assert.ok(!fs.existsSync(path.join(L.runDir, 'refutations')));
  // con la línea que escribe el hook al lanzar: se guarda, y write-findings la acepta
  const ledger = path.join(home, '.claude', '.tycon-pipeline', 'advisor-runs');
  fs.mkdirSync(ledger, { recursive: true });
  fs.writeFileSync(path.join(ledger, 'sesion-1.jsonl'), `${JSON.stringify({ ts: '2026-10-18T10:00:00.000Z', advisor: 'general-purpose', model: 'sonnet' })}\n${JSON.stringify({ ts: '2026-10-18T10:00:00.000Z', advisor: 'orquestador', model: null })}\n`);
  const con = cli([...base, '--verifier', 'general-purpose@2026-10-18T10:00:00.000Z'], env);
  assert.strictEqual(con.exit, 0, con.out);
  assert.strictEqual(JSON.parse(con.out).verdict, 'refutado');
  assert.strictEqual(R().load(L.runDir, HALLAZGO).verifier.model, 'sonnet');
  sembrarLanzamiento(L); // write-findings lee su propio registro de juguete: el mismo lanzamiento
  const w = escribir(L, [hallazgo('refuted')]);
  assert.strictEqual(w.exit, 0, w.out);
  assert.strictEqual(leer(L)[0].disposition, 'refuted');
  // un verificador que dice haber refutado y no trae lo que vio: no hay constancia (ni «refutado» ni nada)
  fs.writeFileSync(rj, JSON.stringify({ refuted: true, command: 'node probe.js', output: '' }));
  const dud = cli([...base, '--verifier', 'general-purpose@2026-10-18T10:00:00.000Z'], env);
  assert.notStrictEqual(dud.exit, 0);
  assert.match(dud.out, /faltan: output/);
  // uno que no refuta queda «reproducido»
  fs.writeFileSync(rj, JSON.stringify({ refuted: false, command: 'node probe.js', output: 'sale 200 y debía ser 403' }));
  const rep = cli([...base, '--verifier', 'general-purpose@2026-10-18T10:00:00.000Z'], env);
  assert.strictEqual(JSON.parse(rep.out).verdict, 'reproducido');
  // la sesión que implementó no es un verificador, aunque figure en el registro
  const yo = cli([...base, '--verifier', 'orquestador@2026-10-18T10:00:00.000Z'], env);
  assert.notStrictEqual(yo.exit, 0);
  assert.match(yo.out, /el verificador tiene que ser otro/);
  fs.rmSync(home, { recursive: true, force: true });
  limpiar(L);
});

// ── T6 (AC 5) ────────────────────────────────────────────────────────────────────────────────
function corridas(base, spec) {
  // spec: [{ findings:[...] }] de la MÁS VIEJA a la más nueva; cada carpeta lleva su sello de 14 dígitos
  fs.mkdirSync(base, { recursive: true });
  spec.forEach((c, i) => {
    const t = new Date(Date.UTC(2026, 8, 1) + i * 86400000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dir = path.join(base, `1.${i}-${t}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(c.findings));
  });
}
// El resumen sale de la lib (summary(build(...))), no armado a mano: si cambia la forma de la constancia, estas corridas la siguen.
const resumenDe = (verdict, revisor) => R().summary(R().build({ finding: { reviewer: revisor, rule: 'X-1', file: 'a.js', line: 1 }, authorReason: 'r',
  verifier: { agent: 'general-purpose@2026-10-18T10:00:00.000Z', model: 'sonnet' }, verdict, command: 'node p.js', output: 'salida' }));
const falso = (revisor) => ({ rule_id: 'X-1', severity: 'WARNING', advisor: revisor, file: 'a.js', disposition: 'refuted', reason: 'r',
  refutation: resumenDe('refutado', revisor) });
const comun = (revisor) => ({ rule_id: 'X-1', severity: 'WARNING', advisor: revisor, file: 'a.js', disposition: 'fixed', reason: 'r' });

// 🔴 Sale rojo si no marca al revisor con más de 30 %, si marca al de 25 %, o si cuenta corridas más viejas que las últimas 20.
test('Tasa_PorRevisor_MarcaMasDe30', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tasa-'));
  const base = path.join(d, '.advisors', 'pipeline-runs');
  const veinte = [];
  for (let i = 0; i < 20; i++) {
    veinte.push({ findings: [i < 7 ? falso('revisor-ruidoso') : comun('revisor-ruidoso'), i < 5 ? falso('revisor-normal') : comun('revisor-normal')] });
  }
  // cinco corridas MÁS VIEJAS, todas falsas para el revisor normal: no tienen que contar
  const viejas = Array.from({ length: 5 }, () => ({ findings: [falso('revisor-normal')] }));
  corridas(base, [...viejas, ...veinte]);
  const tasas = R().reviewerRates(base).valor;
  const por = Object.fromEntries(tasas.map((t) => [t.reviewer, t]));
  assert.strictEqual(por['revisor-ruidoso'].total, 20);
  assert.strictEqual(por['revisor-ruidoso'].refuted, 7);
  assert.strictEqual(por['revisor-ruidoso'].flagged, true, '7 de 20 es 35 %: marcado para revisión');
  assert.strictEqual(por['revisor-normal'].refuted, 5);
  assert.strictEqual(por['revisor-normal'].flagged, false, '5 de 20 es 25 %: no se marca');
  // un «refuted» sin la constancia del verificador no suma a la tasa
  corridas(path.join(d, 'otra'), [{ findings: Array.from({ length: 6 }, () => ({ ...comun('r-x'), disposition: 'refuted' })) }]);
  assert.strictEqual(R().reviewerRates(path.join(d, 'otra')).valor[0].refuted, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── Casos de la revisión de los revisores ────────────────────────────────────────────────────────
const sinLeer = (base, nombre, contenido) => {
  const dir = path.join(base, nombre);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'findings.json'), contenido);
};

// SILENT-C2 — 🔴 sale rojo si un findings.json roto cuenta como corrida vacía: tiene que contarse «no leída».
test('Corridas_Ilegibles_SeContanComoNoLeidas_NuncaComoVacias', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noleidas-'));
  const base = path.join(d, 'runs');
  corridas(base, [{ findings: [falso('rev-a'), comun('rev-a')] }, { findings: [falso('rev-a')] }]);
  sinLeer(base, '2.0-20260903120000', '{ esto no es json');
  sinLeer(base, '2.1-20260904120000', '{"no":"es un array"}');
  const hoy = '2026-09-05';
  const dudas = R().repeatedDoubts(base, hoy, 7);
  assert.strictEqual(dudas.no_leidas, 2, 'dice cuántas corridas no se pudieron leer');
  assert.ok(Array.isArray(dudas.valor), 'con alguna legible hay resultado');
  assert.strictEqual(R().reviewerRates(base).no_leidas, 2);
  // ninguna legible: null con motivo, ni «sin dudas» ni tasa 0
  const roto = path.join(d, 'rotas');
  sinLeer(roto, '1.0-20260903120000', '{ roto');
  sinLeer(roto, '1.1-20260904120000', '');
  const dr = R().repeatedDoubts(roto, hoy, 7);
  assert.strictEqual(dr.valor, null);
  assert.match(dr.motivo, /no se pudo leer/);
  assert.strictEqual(dr.no_leidas, 2);
  const tr = R().reviewerRates(roto);
  assert.strictEqual(tr.valor, null);
  assert.match(tr.motivo, /no se pudo leer/);
  // una carpeta de corrida SIN findings.json todavía no es una corrida rota: no suma a las no leídas
  fs.mkdirSync(path.join(base, '3.0-20260905010101'));
  assert.strictEqual(R().repeatedDoubts(base, hoy, 7).no_leidas, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

// W7 — 🔴 sale rojo si una constancia rota se lee como «no hay constancia».
test('WriteFindings_ConstanciaRota_NoEsSinConstancia', () => {
  const L = lab();
  const ruta = R().constanciaPath(L.runDir, HALLAZGO);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, '{ "verdict": "reprod');
  assert.strictEqual(R().readConstancia(L.runDir, HALLAZGO).estado, 'rota');
  assert.strictEqual(R().readConstancia(L.runDir, { ...HALLAZGO, line: 99 }).estado, 'no-existe');
  for (const d of ['refuted', 'waived']) {
    const r = escribir(L, [hallazgo(d)]);
    assert.notStrictEqual(r.exit, 0, `${d} con una constancia ilegible tiene que rechazarse`);
    assert.match(r.out, /constancia ilegible/);
    assert.ok(!fs.existsSync(L.findings));
  }
  const f = escribir(L, [hallazgo('fixed', { test: 't.test.js' })]);
  assert.strictEqual(f.exit, 0, f.out);
  assert.match(f.out, /constancia ilegible/, 'un fixed pasa, pero lo dice');
  limpiar(L);
});

// W2 — 🔴 sale rojo si, sin poder leer el registro de lanzamientos o el roster, dice «no figura» o aprueba el refuted.
test('WriteFindings_SinPoderVerificar_RefutedQuedaOpen_YLoDice', () => {
  // registro de lanzamientos ilegible (un archivo donde va la carpeta)
  let L = lab();
  dejarConstancia(L, construir(), { sinLanzamiento: true });
  const home = path.join(L.d, 'home', '.claude', '.tycon-pipeline');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'advisor-runs'), 'no soy una carpeta');
  let r = escribir(L, [hallazgo('refuted')]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.strictEqual(leer(L)[0].disposition, 'open');
  assert.match(r.out, /no se pudo verificar quién verificó/);
  assert.doesNotMatch(r.out, /no figura en el registro/);
  limpiar(L);
  // roster ilegible: no se sabe quién implementó
  L = lab();
  dejarConstancia(L, construir());
  fs.writeFileSync(path.join(L.runDir, 'review-roster.json'), '{ roto');
  r = escribir(L, [hallazgo('refuted')]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.strictEqual(leer(L)[0].disposition, 'open');
  assert.match(r.out, /no se pudo verificar quién implementó/);
  limpiar(L);
  // record-refutation con el registro ilegible lo dice, no inventa «no figura»
  L = lab();
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'refut-home-'));
  fs.mkdirSync(path.join(h, '.claude', '.tycon-pipeline'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', '.tycon-pipeline', 'advisor-runs'), 'x');
  const fj = path.join(L.d, 'h.json'); const rj = path.join(L.d, 'r.json');
  fs.writeFileSync(fj, JSON.stringify({ ...HALLAZGO, author_reason: 'x' }));
  fs.writeFileSync(rj, JSON.stringify({ refuted: true, command: 'c', output: 'o' }));
  const rec = cli(['record-refutation', '--finding', fj, '--result', rj, '--verifier', VERIFICADOR.agent, '--verifier-model', 'sonnet', '--run-dir', L.runDir], { HOME: h, USERPROFILE: h });
  assert.notStrictEqual(rec.exit, 0);
  assert.match(rec.out, /no se pudo leer el registro de spawns/);
  assert.doesNotMatch(rec.out, /no figura/);
  fs.rmSync(h, { recursive: true, force: true });
  limpiar(L);
});

// ACCOV-C2 — 🔴 sale rojo si una constancia escrita a mano, con un verificador que nunca se lanzó, deja pasar el refuted.
test('WriteFindings_RefutedConVerificadorQueNoFiguraEnElRegistro_QuedaOpen', () => {
  const L = lab();
  dejarConstancia(L, construir(), { sinLanzamiento: true });
  fs.mkdirSync(path.join(L.d, 'home'), { recursive: true });
  const r = escribir(L, [hallazgo('refuted')]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.strictEqual(leer(L)[0].disposition, 'open');
  assert.match(r.out, /no figura en el registro de spawns/);
  limpiar(L);
});

// 🔴 sale rojo si una constancia «reproducido» que no se pudo validar (el verificador no figura en el registro) deja
// pasar un `waived`: que no se pueda verificar quién reprodujo no vuelve descartable lo reproducido.
test('WriteFindings_ReproducidoSinVerificar_NoAceptaWaived', () => {
  const L = lab();
  dejarConstancia(L, construir({ verdict: 'reproducido', output: 'sale 200 y debía ser 403' }), { sinLanzamiento: true });
  fs.mkdirSync(path.join(L.d, 'home'), { recursive: true });
  const r = escribir(L, [hallazgo('waived')]);
  assert.notStrictEqual(r.exit, 0, r.out);
  assert.match(r.out, /reprodu/);
  limpiar(L);
});

// ACCOV-C3 — 🔴 sale rojo si un `fixed` con veredicto «reproducido» pasa sin la prueba que lo cubre.
test('WriteFindings_FixedConReproducido_ExigeSuPrueba', () => {
  const L = lab();
  dejarConstancia(L, construir({ verdict: 'reproducido', output: 'sale 200 y debía ser 403' }));
  let r = escribir(L, [hallazgo('fixed')]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.strictEqual(leer(L)[0].disposition, 'open');
  assert.match(r.out, /prueba/);
  escribir(L, [hallazgo('fixed', { test: '   ' })]);
  assert.strictEqual(leer(L)[0].disposition, 'open', 'una prueba en blanco no es prueba');
  escribir(L, [hallazgo('fixed', { test: 'tests/a.test.js::devuelve 403' })]);
  const f = leer(L)[0];
  assert.strictEqual(f.disposition, 'fixed');
  assert.strictEqual(f.test, 'tests/a.test.js::devuelve 403');
  limpiar(L);
});

// TEST-W4 / ACCOV-C6 — 🔴 sale rojo si write-findings no avisa «marcado para revisión» ni lista `reviewers_flagged`
// con 20 corridas ruidosas; si marca con 4 hallazgos (el mínimo es 5); o si una constancia inválida bloquea el `fixed`.
test('WriteFindings_RevisorRuidoso_AvisaYLoListaEnReviewersFlagged', () => {
  const L = lab();
  const base = path.dirname(L.runDir);
  const antes = Array.from({ length: 19 }, (_, i) => ({ findings: [i < 8 ? falso(HALLAZGO.reviewer) : comun(HALLAZGO.reviewer)] }));
  corridas(base, antes);
  const r = escribir(L, [hallazgo('fixed')]);
  assert.strictEqual(r.exit, 0, r.out);
  const j = JSON.parse(r.out);
  assert.deepStrictEqual(j.reviewers_flagged, [HALLAZGO.reviewer]);
  assert.ok(j.warnings.some((w) => /marcado para revisión/.test(w) && w.includes('8 de 20')), JSON.stringify(j.warnings));
  limpiar(L);
});

test('Tasa_MinimoDeCincoHallazgos', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'minimo-'));
  const cuatro = path.join(d, 'cuatro'); const cinco = path.join(d, 'cinco');
  corridas(cuatro, [{ findings: Array.from({ length: 4 }, () => falso('rev-x')) }]);
  corridas(cinco, [{ findings: Array.from({ length: 5 }, () => falso('rev-x')) }]);
  assert.strictEqual(R().reviewerRates(cuatro).valor[0].flagged, false, '4 de 4 no marca: es muestra chica');
  assert.strictEqual(R().reviewerRates(cinco).valor[0].flagged, true, '5 de 5 marca');
  fs.rmSync(d, { recursive: true, force: true });
});

test('WriteFindings_ConstanciaInvalida_NoBloqueaElFixed', () => {
  const L = lab();
  dejarConstancia(L, construir({ verifier: { agent: 'sesion-1', model: 'opus' } }));
  const r = escribir(L, [hallazgo('fixed')]);
  assert.strictEqual(r.exit, 0, r.out);
  const f = leer(L)[0];
  assert.strictEqual(f.disposition, 'fixed');
  assert.ok(!('refutation' in f), 'una constancia que no vale no deja resumen');
  assert.match(r.out, /no vale/);
  limpiar(L);
});

// SEC-W8 — 🔴 sale rojo si el comando entero (con un token dentro) viaja a findings.json.
test('Resumen_ComandoAcotadoYSaneado_LaConstanciaCompletaLoGuardaEntero', () => {
  const L = lab();
  const largo = `curl -H "Authorization: Bearer ghp_${'a'.repeat(36)}" https://x/${'y'.repeat(600)}\nsegunda línea`;
  const c = construir({ command: largo });
  assert.strictEqual(c.command, largo.trim(), 'la constancia completa lo guarda entero');
  const s = R().summary(c);
  assert.ok(s.command.length <= 200, `acotado: ${s.command.length}`);
  assert.doesNotMatch(s.command, /ghp_|\n/);
  dejarConstancia(L, c);
  const r = escribir(L, [hallazgo('refuted')]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.ok(leer(L)[0].refutation.command.length <= 200);
  assert.ok(!fs.readFileSync(L.findings, 'utf8').includes('ghp_'));
  assert.ok(fs.readFileSync(R().constanciaPath(L.runDir, HALLAZGO), 'utf8').includes('ghp_'));
  limpiar(L);
});

// ── La constancia está atada a SU hallazgo: revisor, regla, archivo y línea ──────────────────────
// 🔴 sale rojo si dos hallazgos del mismo revisor, regla y archivo en líneas distintas comparten el nombre de la constancia,
// o si la constancia de la línea 10 deja pasar como `refuted` el hallazgo de la línea 20.
test('Constancia_DosLineasDistintas_NoColisionan_TwoLinesNeverShareProof', () => {
  const a = { ...HALLAZGO, line: 10 }; const b = { ...HALLAZGO, line: 20 };
  assert.notStrictEqual(R().idOf(a), R().idOf(b));
  const L = lab();
  dejarConstancia(L, construir({ finding: a }));
  const r = escribir(L, [hallazgo('refuted', { line: 10 }), hallazgo('refuted', { line: 20 })]);
  assert.strictEqual(r.exit, 0, r.out);
  const f = leer(L);
  assert.strictEqual(f.find((x) => x.line === 10).disposition, 'refuted');
  assert.strictEqual(f.find((x) => x.line === 20).disposition, 'open', 'la línea 20 no tiene constancia propia');
  limpiar(L);
});

// 🔴 sale rojo si verify-finding acepta un hallazgo sin línea (y record-refutation después lo rechaza), o si un
// hallazgo sin línea llega a `refuted`: las dos órdenes aplican la misma regla.
test('VerifyFinding_SinLinea_SeRechazaComoRecordRefutation_NoLineSameRule', () => {
  const L = lab();
  const sinLinea = { reviewer: HALLAZGO.reviewer, rule: HALLAZGO.rule, file: HALLAZGO.file, author_reason: 'x' };
  const fj = path.join(L.d, 'sl.json'); const rj = path.join(L.d, 'rl.json');
  fs.writeFileSync(fj, JSON.stringify(sinLinea));
  fs.writeFileSync(rj, JSON.stringify({ refuted: true, command: 'c', output: 'o' }));
  const v = cli(['verify-finding', '--finding', fj, '--repo', L.d]);
  assert.notStrictEqual(v.exit, 0, 'verify-finding sin línea tiene que rechazarse');
  assert.match(v.out, /line/);
  sembrarLanzamiento(L);
  const rec = cli(['record-refutation', '--finding', fj, '--result', rj, '--verifier', VERIFICADOR.agent, '--verifier-model', 'sonnet', '--run-dir', L.runDir],
    { HOME: path.join(L.d, 'home'), USERPROFILE: path.join(L.d, 'home') });
  assert.notStrictEqual(rec.exit, 0, 'record-refutation sin línea también');
  assert.match(rec.out, /line/);
  // Una constancia de «refutado» dejada para ese hallazgo SIN línea: es lo que protege write-findings de verdad (sin ella
  // el `open` saldría igual por «no hay constancia», aunque `sameFinding` aceptara dos líneas vacías).
  const sinLineaRefutada = { ...construir(), finding: { ...sinLinea } };
  delete sinLineaRefutada.finding.author_reason;
  sinLineaRefutada.id = R().idOf(sinLineaRefutada.finding);
  fs.mkdirSync(path.join(L.runDir, 'refutations'), { recursive: true });
  fs.writeFileSync(path.join(L.runDir, 'refutations', `${sinLineaRefutada.id}.json`), JSON.stringify(sinLineaRefutada));
  const r = escribir(L, [hallazgo('refuted', { line: undefined })]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.strictEqual(leer(L)[0].disposition, 'open', 'una constancia sin línea no vuelve «falso» un hallazgo sin línea');
  assert.match(r.out, /otro hallazgo|no trae línea/);
  limpiar(L);
});

// ── La clase: un `waived`/`refuted` nunca pasa si hay una constancia legible «reproducido» del mismo revisor, regla y archivo ──
const escribirConstanciaA = (L, nombre, c) => {
  fs.mkdirSync(path.join(L.runDir, 'refutations'), { recursive: true });
  fs.writeFileSync(path.join(L.runDir, 'refutations', nombre), typeof c === 'string' ? c : JSON.stringify(c));
};

// 🔴 sale rojo si el hallazgo llega con la línea cambiada (o sin línea) y el `waived`/`refuted` pasa porque la constancia
// «reproducido» quedó bajo otra línea; o si el rechazo no nombra la línea de esa constancia.
test('WriteFindings_ReproducidoEnOtraLinea_NoAceptaWaived_LineaCambiada', () => {
  const L = lab();
  dejarConstancia(L, construir({ verdict: 'reproducido', output: 'sale 200 y debía ser 403' }));
  for (const d of ['waived', 'refuted']) {
    for (const line of [13, undefined]) {
      const r = escribir(L, [hallazgo(d, { line })]);
      assert.notStrictEqual(r.exit, 0, `${d} con línea ${line} tiene que rechazarse: ${r.out}`);
      assert.match(r.out, /línea 12/, 'nombra la línea de la constancia');
      assert.ok(!fs.existsSync(L.findings));
    }
  }
  // otro archivo o regla: no es el mismo hallazgo, no se rechaza
  const ok = escribir(L, [hallazgo('waived', { file: 'src/otro.js' })]);
  assert.strictEqual(ok.exit, 0, ok.out);
  limpiar(L);
});

// 🔴 sale rojo si una constancia que dice «reproducido» puesta bajo el nombre de este hallazgo, pero de OTRO hallazgo, deja
// pasar un `waived` con un simple aviso.
test('WriteFindings_ConstanciaAjenaReproducido_NoAceptaWaived', () => {
  const L = lab();
  const ajena = construir({ finding: { reviewer: 'r2', rule: 'RULE-B', file: 'b.js', line: 20 }, verdict: 'reproducido', output: 'se reproduce' });
  escribirConstanciaA(L, `${R().idOf(HALLAZGO)}.json`, ajena);
  sembrarLanzamiento(L);
  const r = escribir(L, [hallazgo('waived')]);
  assert.notStrictEqual(r.exit, 0, r.out);
  assert.match(r.out, /reproducido|reprodujo/);
  limpiar(L);
});

// 🔴 sale rojo si una constancia ilegible del mismo revisor, regla y archivo (en otra línea) deja pasar un `waived`.
test('WriteFindings_ConstanciaRotaEnOtraLinea_NoAceptaWaived', () => {
  const L = lab();
  escribirConstanciaA(L, `${R().idOf({ ...HALLAZGO, line: 40 })}.json`, '{ "verdict": "reprod');
  for (const d of ['waived', 'refuted']) {
    const r = escribir(L, [hallazgo(d)]);
    assert.notStrictEqual(r.exit, 0, `${d}: ${r.out}`);
    assert.match(r.out, /constancia ilegible/);
  }
  // una rota de otro archivo no cuenta
  fs.rmSync(path.join(L.runDir, 'refutations'), { recursive: true });
  escribirConstanciaA(L, `${R().idOf({ ...HALLAZGO, file: 'src/b.js', line: 40 })}.json`, '{ roto');
  const ok = escribir(L, [hallazgo('waived')]);
  assert.strictEqual(ok.exit, 0, ok.out);
  limpiar(L);
});

// 🔴 sale rojo si una constancia «reproducido» con la constancia inválida (se rompe la huella) o sin roster deja pasar un `waived`.
test('WriteFindings_ReproducidoInvalidaOSinRoster_NoAceptaWaived', () => {
  // constancia inválida: la huella no corresponde a la salida
  let L = lab();
  const c = construir({ verdict: 'reproducido', output: 'sale 200 y debía ser 403' });
  c.output_sha256 = 'f'.repeat(64);
  dejarConstancia(L, c);
  let r = escribir(L, [hallazgo('waived')]);
  assert.notStrictEqual(r.exit, 0, r.out);
  assert.match(r.out, /no vale|reprodu/);
  assert.ok(!fs.existsSync(L.findings));
  limpiar(L);
  // roster que falta: no se sabe quién implementó
  L = lab();
  dejarConstancia(L, construir({ verdict: 'reproducido', output: 'sale 200 y debía ser 403' }));
  fs.rmSync(path.join(L.runDir, 'review-roster.json'));
  r = escribir(L, [hallazgo('waived')]);
  assert.notStrictEqual(r.exit, 0, r.out);
  assert.match(r.out, /reprodu/);
  assert.ok(!fs.existsSync(L.findings));
  limpiar(L);
});

// 🔴 sale rojo si `validate` acepta una constancia de otro hallazgo cuando se le dice cuál se juzga, o si `write-findings`
// deja pasar como `refuted` una constancia de otra regla/archivo puesta bajo el nombre de ésta.
test('Constancia_DeOtroHallazgo_NoVale_ForeignProofRejected', () => {
  const otro = { reviewer: 'r2', rule: 'RULE-B', file: 'b.js', line: 20 };
  const c = construir({ finding: otro });
  assert.strictEqual(R().validate(c, { implementer: 'sesion-1', finding: otro }).ok, true);
  const v = R().validate(c, { implementer: 'sesion-1', finding: HALLAZGO });
  assert.strictEqual(v.ok, false);
  assert.match(v.errores.join(';'), /otro hallazgo/);
  const L = lab();
  fs.mkdirSync(path.join(L.runDir, 'refutations'), { recursive: true });
  fs.writeFileSync(path.join(L.runDir, 'refutations', `${R().idOf(HALLAZGO)}.json`), JSON.stringify(c));
  sembrarLanzamiento(L);
  const r = escribir(L, [hallazgo('refuted')]);
  assert.strictEqual(r.exit, 0, r.out);
  assert.strictEqual(leer(L)[0].disposition, 'open');
  assert.match(r.out, /otro hallazgo/);
  limpiar(L);
});

// 🔴 sale rojo si la identidad de la constancia omite la línea: la evidencia de la línea 10 se reutiliza para la 11
// (mismo verificador y huella en los dos hallazgos).
test('Constancia_IdentidadConLinea_NoReutilizaEvidencia_IdentityIncludesLine', () => {
  const L = lab();
  dejarConstancia(L, construir({ finding: { ...HALLAZGO, line: 10 } }));
  const r = escribir(L, [hallazgo('refuted', { line: 10 }), hallazgo('refuted', { line: 11 })]);
  assert.strictEqual(r.exit, 0, r.out);
  const f = leer(L);
  assert.strictEqual(f.filter((x) => x.disposition === 'refuted').length, 1);
  assert.ok(!f.find((x) => x.line === 11).refutation, 'la línea 11 no hereda la huella de la 10');
  assert.ok(R().sameFinding({ ...HALLAZGO, line: 10 }, { ...HALLAZGO, line: 10 }));
  assert.ok(!R().sameFinding({ ...HALLAZGO, line: 10 }, { ...HALLAZGO, line: 11 }));
  limpiar(L);
});

// ── Una sola regla: lo que reprodujo el verificador (o no se puede leer) nunca termina descartado ──
const ENV_DE = (L) => ({ HOME: path.join(L.d, 'home'), USERPROFILE: path.join(L.d, 'home') });
const registrar = (L, hallazgoJson, resultado, extra = []) => {
  const fj = path.join(L.d, `h-${Math.random().toString(36).slice(2)}.json`); const rj = `${fj}.res`;
  fs.writeFileSync(fj, JSON.stringify(hallazgoJson)); fs.writeFileSync(rj, JSON.stringify(resultado));
  sembrarLanzamiento(L);
  return cli(['record-refutation', '--finding', fj, '--result', rj, '--verifier', VERIFICADOR.agent, '--verifier-model', 'sonnet', '--run-dir', L.runDir, ...extra], ENV_DE(L));
};
const dePrueba = { reviewer: HALLAZGO.reviewer, rule: HALLAZGO.rule, file: HALLAZGO.file, line: 12, author_reason: 'x' };

// 🔴 sale rojo si la identidad del hallazgo no es la misma con y sin la anotación del revisor («x (sonnet)»), o si
// record-refutation guarda la constancia bajo un nombre distinto del que write-findings busca y el `waived` pasa.
test('Identidad_RevisorConAnotacion_UnaSolaNormalizacion_SilentAnnotation', () => {
  const anotado = { ...HALLAZGO, reviewer: `${HALLAZGO.reviewer} (sonnet)` };
  assert.strictEqual(R().idOf(anotado), R().idOf(HALLAZGO));
  assert.ok(R().sameFinding(anotado, HALLAZGO));
  const L = lab();
  const rec = registrar(L, { ...dePrueba, reviewer: anotado.reviewer }, { refuted: false, command: 'node p.js', output: 'se reproduce' });
  assert.strictEqual(rec.exit, 0, rec.out);
  assert.ok(fs.existsSync(path.join(L.runDir, 'refutations', `${R().idOf(HALLAZGO)}.json`)), 'queda bajo el nombre normalizado');
  for (const d of ['waived', 'refuted']) {
    const r = escribir(L, [hallazgo(d)]);
    assert.notStrictEqual(r.exit, 0, `${d} tiene que rechazarse: ${r.out}`);
  }
  limpiar(L);
});

// 🔴 sale rojo si una constancia con veredicto que no es refutado/reproducido, o con el hallazgo sin campos, deja pasar un
// `waived`/`refuted` (hoy sólo avisa).
test('Constancia_MalEscrita_SeTrataComoRota_BloqueaWaived_SilentMalformed', () => {
  for (const mala of [{ ...construir(), verdict: 'quizas' }, { ...construir(), verdict: undefined }, { ...construir(), finding: {} }]) {
    for (const nombre of [`${R().idOf(HALLAZGO)}.json`, `${R().idOf({ ...HALLAZGO, line: 40 })}.json`]) {
      const L = lab();
      escribirConstanciaA(L, nombre, mala);
      sembrarLanzamiento(L);
      for (const d of ['waived', 'refuted']) {
        const r = escribir(L, [hallazgo(d)]);
        assert.notStrictEqual(r.exit, 0, `${d} con ${nombre} y ${JSON.stringify(mala.verdict)}: ${r.out}`);
      }
      limpiar(L);
    }
  }
});

// 🔴 sale rojo si un «refutado» posterior pisa un «reproducido» (o una constancia ilegible) en record-refutation.
test('RecordRefutation_NuncaPisaUnReproducido_SilentOverwrite', () => {
  const L = lab();
  const rep = registrar(L, dePrueba, { refuted: false, command: 'node p.js', output: 'se reproduce' });
  assert.strictEqual(JSON.parse(rep.out).verdict, 'reproducido');
  const dest = R().constanciaPath(L.runDir, HALLAZGO);
  const antes = fs.readFileSync(dest, 'utf8');
  const ref = registrar(L, dePrueba, { refuted: true, command: 'node q.js', output: 'no se da' });
  assert.notStrictEqual(ref.exit, 0, ref.out);
  assert.match(ref.out, /reproducido/);
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), antes, 'el archivo no cambió');
  // un reproducido sobre otro reproducido sí se puede volver a registrar
  assert.strictEqual(registrar(L, dePrueba, { refuted: false, command: 'node p.js', output: 'otra vez' }).exit, 0);
  // una ilegible tampoco se pisa
  fs.writeFileSync(dest, '{ roto');
  assert.notStrictEqual(registrar(L, dePrueba, { refuted: true, command: 'node q.js', output: 'no se da' }).exit, 0);
  // una mal escrita (JSON legible, veredicto que no existe) tampoco se pisa: cuenta como «reproducido»
  const malEscrita = { ...JSON.parse(antes), verdict: 'quizas' };
  fs.writeFileSync(dest, JSON.stringify(malEscrita));
  const sobreMal = registrar(L, dePrueba, { refuted: true, command: 'node q.js', output: 'no se da' });
  assert.notStrictEqual(sobreMal.exit, 0, sobreMal.out);
  assert.strictEqual(JSON.parse(fs.readFileSync(dest, 'utf8')).verdict, 'quizas', 'la mal escrita no se pisó');
  limpiar(L);
});

// 🔴 sale rojo si el mismo hallazgo escrito con otras mayúsculas u otra forma de la ruta no ve la constancia «reproducido»
// y deja pasar el descarte.
test('BlocksDismissal_MayusculasYRuta_MismoHallazgo', () => {
  const M = lab();
  const guardado = { reviewer: 'rev', rule: 'sec-c1', file: './src/a.js', line: 12 };
  escribirConstanciaA(M, `${R().idOf(guardado)}.json`, construir({ finding: guardado, verdict: 'reproducido' }));
  for (const otro of [{ reviewer: 'Rev', rule: 'SEC-C1', file: 'src/a.js' }, { reviewer: 'rev', rule: 'sec-c1', file: 'src//a.js' }, { reviewer: 'rev (sonnet)', rule: 'SEC-C1', file: 'src\\a.js' }]) {
    assert.strictEqual(R().blocksDismissal(M.runDir, otro).blocks, true, JSON.stringify(otro));
  }
  assert.strictEqual(R().blocksDismissal(M.runDir, { reviewer: 'rev', rule: 'sec-c1', file: 'src/b.js' }).blocks, false, 'otro archivo no bloquea');
  limpiar(M);
});

// 🔴 sale rojo (TEST-W4) si con la carpeta refutations/ ilegible el `waived`/`refuted` pasa, o si un nombre base de 90+
// caracteres deja pasar la constancia «reproducido» de otra línea.
test('BlocksDismissal_CarpetaIlegible_YNombreLargo_TestW4', () => {
  const L = lab();
  fs.writeFileSync(path.join(L.runDir, 'refutations'), 'esto es un archivo, no una carpeta');
  const b = R().blocksDismissal(L.runDir, HALLAZGO);
  assert.strictEqual(b.blocks, true);
  assert.match(b.motivos.join(';'), /carpeta/);
  for (const d of ['waived', 'refuted']) assert.notStrictEqual(escribir(L, [hallazgo(d)]).exit, 0, d);
  limpiar(L);

  const largo = { reviewer: `tycon-${'r'.repeat(95)}`, rule: 'SILENT-C2', file: 'src/a.js', line: 12 };
  assert.ok(`${largo.reviewer}__${largo.rule}__${largo.file}`.length >= 90);
  const M = lab();
  assert.strictEqual(R().blocksDismissal(M.runDir, largo).blocks, false, 'sin carpeta no bloquea');
  escribirConstanciaA(M, `${R().idOf({ ...largo, line: 40 })}.json`, '{ roto');
  assert.strictEqual(R().blocksDismissal(M.runDir, largo).blocks, true, 'ilegible con nombre largo');
  fs.rmSync(path.join(M.runDir, 'refutations'), { recursive: true });
  escribirConstanciaA(M, `${R().idOf({ ...largo, line: 40 })}.json`, construir({ finding: { ...largo, line: 40 }, verdict: 'reproducido' }));
  assert.strictEqual(R().blocksDismissal(M.runDir, largo).blocks, true, 'reproducido con nombre largo');
  assert.strictEqual(R().blocksDismissal(M.runDir, { ...largo, file: 'src/otro.js' }).blocks, false, 'otro archivo no bloquea');
  limpiar(M);
});
