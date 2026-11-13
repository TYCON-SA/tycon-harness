'use strict';
// review-runner.test.js — con qué corre la revisión: los corredores salen de su integración, no del núcleo.
//
// Lo que no se puede perder:
//   · el núcleo no nombra ningún corredor, ni en el código ni en lo que imprime;
//   · de fábrica corre el primero de la lista de la organización, y sin lista, el de fábrica;
//   · si un corredor llega a su tope o falla, el mismo agente se relanza con el siguiente, y el resultado dice quién
//     contestó y por qué murió el otro; si fallan todos, el pase no queda medido;
//   · el tope marca sólo a ese corredor: los agentes siguientes no lo vuelven a probar; un error común no lo marca;
//   · en el modo código sólo corre un corredor confinado;
//   · el comando propio corre sin shell: el pedido nunca entra en la línea de comando.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RR = require('../lib/review-runner.js');
const LITE = path.join(SCRIPTS, 'workflow-lite.js');
const FIX = path.join(__dirname, 'fixtures', 'review-runner');

function carpeta(t, prefijo) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** El código de un archivo sin sus comentarios de línea ni de bloque (los textos quedan). */
function sinComentarios(texto) {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => {
    const i = l.search(/(^|[^:'"`\\])\/\//);
    return i < 0 ? l : l.slice(0, i + (l[i] === '/' ? 0 : 1));
  }).join('\n');
}

/**
 * Un laboratorio con dos corredores inventados («uno» y «dos»), sus ejecutables falsos en una carpeta que va al frente
 * del PATH y su integración de prueba. `uno` y `dos` son el código (node) de cada falso: leen el pedido de
 * TYCON_WFLITE_PROMPT, anotan cada llamada en `<lab>/<nombre>.calls` y contestan por la salida.
 */
function laboratorio(t, { uno, dos, labelUno = 'uno' }) {
  const lab = carpeta(t, 'rr-lab-');
  const bin = path.join(lab, 'bin');
  fs.mkdirSync(bin);
  for (const [nombre, cuerpo] of [['uno', uno], ['dos', dos]]) {
    const js = path.join(lab, `${nombre}.js`);
    fs.writeFileSync(js, `const fs=require('fs');fs.appendFileSync(${JSON.stringify(path.join(lab, `${nombre}.calls`))},'x');const prompt=process.env.TYCON_WFLITE_PROMPT||'';${cuerpo}`);
    const sh = path.join(bin, nombre);
    fs.writeFileSync(sh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} "$@"\n`);
    fs.chmodSync(sh, 0o755);
  }
  const integracion = {
    name: 'review-runner',
    runners: {
      uno: { label: labelUno, bin: 'uno', args: [], prompt: 'env', answer: 'stdout', models: 'none', confined: true },
      dos: { label: 'dos', bin: 'dos', args: [], prompt: 'env', answer: 'stdout', models: 'none', confined: true },
    },
  };
  const file = path.join(lab, 'integration.json');
  fs.writeFileSync(file, JSON.stringify(integracion));
  const wf = path.join(lab, 'toy.workflow.js');
  fs.writeFileSync(wf, `
const a = await agent('primero', { label: 'a', phase: 'Hunt', schema: { required: ['eco'] } })
const b = await agent('segundo falla-dos', { label: 'b', phase: 'Verify', schema: { required: ['eco'] } })
return { medido: a !== null && b !== null, a, b }
`);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TYCON_REVIEW_RUNNER_FILE: file };
  delete env.TYCON_WFLITE_AGENT_CMD;
  const correr = (orden) => {
    const out = path.join(lab, 'resultado.json');
    const r = spawnSync(process.execPath, [LITE, wf, '--args', '{}', '--out', out, '--runners', orden.join(',')], { cwd: lab, env, encoding: 'utf8', timeout: 60000 });
    let res = null;
    try { res = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (_) { res = null; }
    return { code: r.status, stderr: r.stderr, res };
  };
  const llamadas = (n) => { try { return fs.readFileSync(path.join(lab, `${n}.calls`), 'utf8').length; } catch (_) { return 0; } };
  return { lab, correr, llamadas };
}

const CONTESTA = "console.log(JSON.stringify({eco:'ok'}));";
const TOPE = "console.error('Error: usage limit reached, try again later');process.exit(1);";

test('T1 ReviewRunner_ElNucleoNoNombraCorredores @story-8.221 @ac-1 — ni el código ni los textos del núcleo nombran un corredor; el tope dice el nombre de la integración', (t) => {
  const archivos = ['workflow-lite.js', 'lib/plan-review.js', 'lib/review-runner.js', 'lib/review-policy.js'].map((f) => path.join(SCRIPTS, f));
  const prohibido = /codex|cursor|claude -p|ollama/i;
  for (const f of archivos) {
    const malas = sinComentarios(fs.readFileSync(f, 'utf8')).split('\n').filter((l) => prohibido.test(l));
    assert.deepStrictEqual(malas, [], `${path.basename(f)} nombra un corredor`);
  }
  // los manejadores nuevos de marker.js
  const marker = fs.readFileSync(path.join(SCRIPTS, 'marker.js'), 'utf8');
  for (const fn of ['cmdPlanReview', 'cmdReviewAsk', 'cmdReviewAnswer', 'cmdOwnerAway']) {
    const i = marker.indexOf(`function ${fn}(`);
    assert.ok(i >= 0, `marker.js no tiene ${fn}`);
    const fin = marker.indexOf('\nfunction ', i + 10);
    const cuerpo = sinComentarios(marker.slice(i, fin < 0 ? undefined : fin));
    assert.ok(!prohibido.test(cuerpo), `${fn} nombra un corredor`);
  }
  // con un corredor inventado «acme» en su tope, el aviso dice «acme»
  const L = laboratorio(t, { uno: TOPE, dos: CONTESTA, labelUno: 'acme' });
  const r = L.correr(['uno']);
  assert.match(r.stderr, /acme en su tope de uso/);
});

test('T2 ReviewRunner_LaLineaDeCadaCorredorDeFabrica @story-8.221 @ac-2 — los cinco de fábrica arman su línea; codex con las banderas de hoy; el propio sin shell', () => {
  const integ = RR.loadIntegration({ env: {} });
  assert.strictEqual(integ.problem, undefined);
  assert.deepStrictEqual(Object.keys(integ.runners).sort(), ['claude', 'claude-ollama', 'codex', 'cursor', 'custom']);
  const schema = { type: 'object', required: ['eco'] };
  const base = { model: 'm-1', schema, outFile: '/tmp/salida.txt', schemaFile: '/tmp/esquema.json', cwd: '/tmp/repo', mode: 'plan' };
  const codex = RR.commandFor('codex', integ.runners.codex, base);
  assert.strictEqual(codex.bin, 'codex');
  assert.deepStrictEqual(codex.args.slice(0, 4), ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check']);
  assert.ok(codex.args.join(' ').includes('-m m-1') && codex.args.join(' ').includes('-o /tmp/salida.txt') && codex.args.join(' ').includes('--output-schema /tmp/esquema.json'));
  const claude = RR.commandFor('claude', integ.runners.claude, base);
  assert.strictEqual(claude.bin, 'claude');
  assert.ok(claude.args.includes('-p') && claude.args.includes('--model') && claude.args.includes('m-1'));
  const i = claude.args.indexOf('--json-schema');
  assert.ok(i >= 0);
  assert.deepStrictEqual(JSON.parse(claude.args[i + 1]), schema, 'el esquema va en línea');
  assert.ok(!claude.args.includes('-o'));
  assert.strictEqual(claude.input, 'stdin');
  const cursor = RR.commandFor('cursor', integ.runners.cursor, base);
  assert.strictEqual(cursor.bin, 'cursor-agent');
  const ollama = RR.commandFor('claude-ollama', integ.runners['claude-ollama'], base);
  assert.ok(ollama.env.ANTHROPIC_BASE_URL);
  for (const c of [codex, claude, cursor, ollama]) assert.strictEqual(c.cwd, '/tmp/repo');
  const propio = RR.commandFor('custom', integ.runners.custom, { ...base, customCommand: '/opt/acme/review --fast' });
  assert.strictEqual(propio.bin, '/opt/acme/review');
  assert.deepStrictEqual(propio.args, ['--fast']);
  assert.strictEqual(propio.input, 'env');
  assert.ok(propio.env.TYCON_REVIEW_OUT, 'la respuesta se lee del archivo de TYCON_REVIEW_OUT');
  assert.strictEqual(propio.shell, false);
});

test('T3 ReviewRunner_SinPerfilClaude @story-8.221 @ac-3 — sin review_runner, el revisor es claude', () => {
  assert.deepStrictEqual(RR.runnerOrder(undefined).order, ['claude']);
  assert.deepStrictEqual(RR.runnerOrder({}).order, ['claude']);
  assert.deepStrictEqual(RR.runnerOrder({ review_runner: { order: ['codex', 'claude'] } }).order, ['codex', 'claude']);
});

test('T4 ReviewRunner_RespaldoAnteElTopeDeUso @story-8.221 @ac-4 — el tope pasa al siguiente y no se vuelve a probar; un error común sí', (t) => {
  // «uno» en su tope: contesta «dos», y el segundo agente ya no prueba «uno»
  const a = laboratorio(t, { uno: TOPE, dos: CONTESTA });
  const r = a.correr(['uno', 'dos']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.res.corredor.usado.a, 'dos');
  assert.strictEqual(r.res.corredor.usado.b, 'dos');
  assert.ok(r.res.corredor.muertos.some((m) => m.corredor === 'uno' && /usage limit/.test(m.causa)));
  assert.strictEqual(a.llamadas('uno'), 1, 'después del tope, «uno» no se vuelve a probar');
  // un error común de «uno»: el agente siguiente lo vuelve a probar
  const b = laboratorio(t, { uno: "console.error('boom');process.exit(2);", dos: CONTESTA });
  const r2 = b.correr(['uno', 'dos']);
  assert.strictEqual(r2.code, 0, r2.stderr);
  assert.ok(b.llamadas('uno') >= 2, 'un error común no marca el tope');
  // uno contestado y otro muerto: el resultado nombra cada uno
  const c = laboratorio(t, { uno: TOPE, dos: "if (prompt.includes('falla-dos')) { console.error('se cayó'); process.exit(1); } console.log(JSON.stringify({eco:'ok'}));" });
  const r3 = c.correr(['uno', 'dos']);
  assert.strictEqual(r3.code, 3);
  assert.strictEqual(r3.res.corredor.usado.a, 'dos');
  assert.ok(r3.res.corredor.muertos.some((m) => m.label === 'b' && m.corredor === 'dos'));
});

test('T4 ReviewRunner_CorredorCaidoNoSeVuelveAProbar @story-8.221 @ac-4 — uno que no se puede lanzar cae enseguida; uno que falla seguido, a los tres intentos', (t) => {
  // «uno» no está instalado: un solo intento en toda la corrida, y queda caído con su causa
  const a = laboratorio(t, { uno: CONTESTA, dos: CONTESTA });
  const archivo = path.join(a.lab, 'integration.json');
  const integ = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  integ.runners.uno.bin = 'corredor-que-no-esta-instalado-en-ninguna-maquina';
  fs.writeFileSync(archivo, JSON.stringify(integ));
  const r = a.correr(['uno', 'dos']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual((r.stderr.match(/con uno \(intento/g) || []).length, 1, r.stderr);
  assert.match(r.res.corredor.caidos.uno.causa, /no se pudo lanzar/);
  assert.strictEqual(r.res.corredor.usado.b, 'dos');
  // «uno» falla siempre sin tope: a los tres intentos seguidos queda caído y el resto de la corrida no lo prueba
  const b = laboratorio(t, { uno: "console.error('boom');process.exit(2);", dos: CONTESTA });
  const r2 = b.correr(['uno', 'dos']);
  assert.strictEqual(r2.code, 0, r2.stderr);
  assert.strictEqual(b.llamadas('uno'), 3);
  assert.match(r2.res.corredor.caidos.uno.causa, /falló 3 veces seguidas/);
  assert.strictEqual(r2.res.corredor.tope, null, 'caído no es tope de uso');
});

test('T5 ReviewRunner_TodosFallanSinVeredicto @story-8.221 @ac-5 — fallan todos: no medido, sale 3 y están las dos causas', (t) => {
  const L = laboratorio(t, { uno: TOPE, dos: "console.error('dos no anda');process.exit(1);" });
  const r = L.correr(['uno', 'dos']);
  assert.strictEqual(r.code, 3);
  assert.strictEqual(r.res.medido, false);
  const causas = r.res.corredor.muertos.map((m) => `${m.corredor}: ${m.causa}`).join(' | ');
  assert.match(causas, /uno: .*usage limit/);
  assert.match(causas, /dos: .*dos no anda/);
});

test('T6 PlanReview_ElComandoSugeridoEsElDelRevisorElegido @story-8.221 @ac-6 — el comando sugerido lleva el corredor de la lista', () => {
  const pr = require(path.join(SCRIPTS, 'lib', 'plan-review.js'));
  const integ = RR.loadIntegration({ env: {} });
  const cmd = pr.comandoLite('/tmp/args.json', '/tmp/resultado.json', { order: ['cursor'], integration: integ });
  assert.match(cmd, /--runners cursor/);
  assert.match(cmd, new RegExp(integ.runners.cursor.label));
  assert.doesNotMatch(cmd, /--runners codex/);
});

test('T7 WorkflowLite_ElGanchoDePruebasGana @story-8.221 @ac-7 — TYCON_WFLITE_AGENT_CMD gana sobre la lista; el autotest sigue verde', (t) => {
  const L = laboratorio(t, { uno: TOPE, dos: TOPE });
  const lab = L.lab;
  const falso = path.join(lab, 'falso.js');
  fs.writeFileSync(falso, "console.log(JSON.stringify({eco:'del-falso'}))");
  const wf = path.join(lab, 'uno.workflow.js');
  fs.writeFileSync(wf, "return { medido: true, a: await agent('x', { schema: { required: ['eco'] } }) }");
  const out = path.join(lab, 'r.json');
  const r = spawnSync(process.execPath, [LITE, wf, '--args', '{}', '--out', out, '--runners', 'uno'], {
    cwd: lab, encoding: 'utf8', env: { ...process.env, TYCON_REVIEW_RUNNER_FILE: path.join(lab, 'integration.json'), TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${falso}` },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).a.eco, 'del-falso');
  assert.strictEqual(L.llamadas('uno'), 0);
  const st = spawnSync(process.execPath, [LITE, '--selftest'], { encoding: 'utf8', env: { ...process.env, TYCON_WFLITE_AGENT_CMD: '' } });
  assert.strictEqual(st.status, 0, st.stdout + st.stderr);
});

test('WorkflowLite_ElCorredorDePruebaNuncaApruebaNiMide — con TYCON_WFLITE_AGENT_CMD el resultado sale marcado de prueba, y ni la revisión del plan ni la del código lo cuentan', (t) => {
  const L = laboratorio(t, { uno: TOPE });
  const lab = L.lab;
  // el corredor falso contesta lo que haga falta para un pase limpio
  const falso = path.join(lab, 'falso.js');
  fs.writeFileSync(falso, "console.log(JSON.stringify({eco:'limpio'}))");
  const wf = path.join(lab, 'limpio.workflow.js');
  fs.writeFileSync(wf, "await agent('x', { schema: { required: ['eco'] } })\n"
    + "return { medido: true, modo: 'plan', veredicto: 'aprobado', confirmed: [], lentes: [{ lens: 'a', estado: 'medida' }], detalle: [] }");
  const out = path.join(lab, 'r.json');
  const r = spawnSync(process.execPath, [LITE, wf, '--args', '{}', '--out', out], {
    cwd: lab, encoding: 'utf8', env: { ...process.env, TYCON_REVIEW_RUNNER_FILE: path.join(lab, 'integration.json'), TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${falso}` },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(res.corredor.de_prueba, true);
  const PR = require('../lib/plan-review.js');
  assert.strictEqual(PR.veredictoDe(res), 'sin-veredicto');
  // sin la marca, el mismo resultado aprobaría: lo que lo frena es el corredor de prueba
  const { de_prueba, ...sinMarca } = res.corredor;
  assert.strictEqual(de_prueba, true);
  assert.strictEqual(PR.veredictoDe({ ...res, corredor: sinMarca }), 'aprobado');
  const m = require('../lib/adversarial-verdict.js').medicionDelResultado(res);
  assert.strictEqual(m.medido, false);
  assert.match(m.motivo, /corredor de prueba/);
});

test('T60 ReviewRunner_LeeLaRespuestaYElTopeDeCadaCorredor @story-8.221 @ac-2 @ac-4 @ac-5 — salidas reales: respuesta, tokens, error y tope; sin confinamiento no corre en el modo código', () => {
  const integ = RR.loadIntegration({ env: {} });
  const claude = integ.runners.claude;
  const leer = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
  const ok = RR.readAnswer(claude, { stdout: leer('claude-ok.json'), stderr: '', code: 0 });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.structured, { eco: 'hola', n: 2 });
  assert.strictEqual(ok.tokens, 2 + 31155 + 0 + 74);
  const err = RR.readAnswer(claude, { stdout: leer('claude-error.json'), stderr: '', code: 1 });
  assert.strictEqual(err.ok, false);
  assert.match(err.cause, /Internal server error/);
  assert.strictEqual(err.limit, false);
  const tope = RR.readAnswer(claude, { stdout: leer('claude-limit.json'), stderr: '', code: 1 });
  assert.strictEqual(tope.ok, false);
  assert.strictEqual(tope.limit, true);
  // el tope de los otros, por su patrón
  assert.strictEqual(RR.isLimit(integ.runners.codex, 'ERROR: You have hit your usage limit. Upgrade to Pro'), true);
  assert.strictEqual(RR.isLimit(integ.runners.cursor, 'Error: rate limit exceeded (429)'), true);
  assert.strictEqual(RR.isLimit(integ.runners['claude-ollama'], 'API Error: 429 Too Many Requests'), true);
  assert.strictEqual(RR.isLimit(integ.runners.codex, 'error: no such file'), false);
  // un patrón inválido usa el de siempre, no tira, y lo dice una sola vez por corredor
  const escrito = [];
  const original = process.stderr.write;
  process.stderr.write = (s) => { escrito.push(String(s)); return true; };
  let conMalo;
  try {
    const malo = { label: 'acme', limit_pattern: '(sin cerrar' };
    conMalo = [RR.isLimit(malo, 'Error: usage limit reached'), RR.isLimit(malo, 'error: no such file'), RR.isLimit(malo, 'usage limit')];
  } finally { process.stderr.write = original; }
  assert.deepStrictEqual(conMalo, [true, false, true]);
  assert.strictEqual(escrito.filter((s) => /limit_pattern de acme no es una expresión válida/.test(s)).length, 1, escrito.join(''));
  // sin respuesta medible, la cuenta de tokens es null, nunca ausente
  const sinUso = RR.readAnswer(integ.runners.codex, { stdout: '', stderr: '', code: 0, fileText: '{"eco":"x"}' });
  assert.strictEqual(sinUso.tokens, null);
  // el modo código salta al que no corre confinado
  const elegidos = RR.pickRunners({ order: ['custom', 'claude'], mode: 'code', integration: integ, customCommand: '/opt/acme/review' });
  assert.deepStrictEqual(elegidos.usable.map((u) => u.name), ['claude']);
  assert.ok(elegidos.skipped.some((s) => s.name === 'custom' && /confin/.test(s.reason)));
  const plan = RR.pickRunners({ order: ['custom', 'claude'], mode: 'plan', integration: integ, customCommand: '/opt/acme/review' });
  assert.deepStrictEqual(plan.usable.map((u) => u.name), ['custom', 'claude']);
});
