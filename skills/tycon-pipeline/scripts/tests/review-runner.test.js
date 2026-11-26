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
  const correr = (orden, args = '{}') => {
    const out = path.join(lab, 'resultado.json');
    const r = spawnSync(process.execPath, [LITE, wf, '--args', args, '--out', out, '--runners', orden.join(',')], { cwd: lab, env, encoding: 'utf8', timeout: 60000 });
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
  const marker = require(path.join(SCRIPTS, 'tests', 'lib', 'marker-source.js'))(SCRIPTS);
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

// Defecto 9 (20/11): la revisión automática del plan dejaba sólo el total de tokens, y no se podía saber cuánto costó.
// Cada agente deja su consumo por tipo (entrada, salida, creación y lectura de caché), y el corredor lo suma por agente.
test('T1 ReviewRunner_UsageByType_PerAgent — cada agente deja su consumo por tipo; dos intentos se suman', () => {
  const integ = RR.loadIntegration({ env: {} });
  const ok = RR.readAnswer(integ.runners.claude, { stdout: fs.readFileSync(path.join(FIX, 'claude-ok.json'), 'utf8'), stderr: '', code: 0 });
  assert.deepStrictEqual(ok.usage, { input_tokens: 2, cache_creation_input_tokens: 31155, cache_read_input_tokens: 0, output_tokens: 74 });
  assert.strictEqual(RR.readAnswer(integ.runners.codex, { stdout: '', stderr: '', code: 0, fileText: '{"eco":"x"}' }).usage, null, 'sin consumo medible, null');
  const { anotarUso } = require('../workflow-lite.js');
  const corredor = {};
  anotarUso(corredor, { clave: 'plan-hunt:ac', fase: 'Hunt', nombre: 'claude', modelo: 'opus', usage: ok.usage });
  anotarUso(corredor, { clave: 'plan-hunt:ac', fase: 'Hunt', nombre: 'claude', modelo: 'opus', usage: { input_tokens: 1, output_tokens: 6 } });
  anotarUso(corredor, { clave: 'plan-verify:ac', fase: 'Verify', nombre: 'claude', modelo: 'opus', usage: null });
  assert.deepStrictEqual(corredor.usoPorAgente, {
    'plan-hunt:ac': { fase: 'Hunt', corredor: 'claude', modelo: 'opus', intentos: 2, input_tokens: 3, cache_creation_input_tokens: 31155, cache_read_input_tokens: 0, output_tokens: 80 },
  });
});

// Pedido del 20/11: una revisión que se corta (la mataron, se colgó, se cayó la máquina) no dejaba su consumo, porque el
// corredor lo escribía sólo al terminar. Con `usoFile`, cada intento lo deja escrito al momento, marcado sin terminar.
test('T2 ReviewRunner_UsageWrittenAsItGoes_SurvivesACut — el consumo queda escrito después de cada intento, sin terminar', (t) => {
  const { anotarUso, escribirUso } = require('../workflow-lite.js');
  const dir = carpeta(t, 'wflite-uso-');
  const usoFile = path.join(dir, 'ses-a.resultado.uso.json');
  const corredor = { usoFile, pedido: 'pedido-1', tokensPorFase: {} };
  anotarUso(corredor, { clave: 'plan-hunt:ac', fase: 'Hunt', nombre: 'claude', modelo: 'opus', usage: { input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 3 } });
  const j = JSON.parse(fs.readFileSync(usoFile, 'utf8'));
  assert.strictEqual(j.pedido, 'pedido-1');
  assert.strictEqual(j.completo, false, 'sin terminar: si se corta acá, el consumo de lo que ya corrió queda');
  assert.deepStrictEqual(j.tokens.por_agente['plan-hunt:ac'], { fase: 'Hunt', corredor: 'claude', modelo: 'opus', intentos: 1, input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 3 });
  assert.strictEqual(j.tokens.total, 15);
  escribirUso(corredor, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(usoFile, 'utf8')).completo, true);
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

// T8 · 🔴 Falla con: un revisor que no está en el PATH (la extensión de VS Code no lo pone) y que da `spawn … ENOENT`
//    aunque esté instalado en uno de los lugares que declara su integración (`bin_paths`).
test('T8 ReviewRunner_BinFueraDelPath_LoBuscaEnSusLugares — en el PATH tal cual; si no, en los lugares de su integración (gana el más nuevo); si no, dice dónde buscó', (t) => {
  const casa = carpeta(t, 'rr-casa-');
  const enPath = path.join(casa, 'bin');
  fs.mkdirSync(enPath);
  const instalar = (rel, ms) => {
    const f = path.join(casa, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
    if (ms) fs.utimesSync(f, ms / 1000, ms / 1000);
    return f;
  };
  const runner = { bin: 'revisor', bin_paths: { darwin: ['~/.editor/extensions/acme.revisor-*/resources/revisor'], win32: ['~/.editor/extensions/acme.revisor-*/resources/revisor.exe'] } };
  // en el PATH: se lanza por su nombre, como siempre
  instalar('bin/revisor');
  assert.strictEqual(RR.resolveBin(runner, 'revisor', { env: { PATH: enPath }, platform: 'darwin', home: casa }).bin, 'revisor');
  // fuera del PATH: el lugar de la integración, y entre dos versiones la más nueva
  instalar('.editor/extensions/acme.revisor-1.0/resources/revisor', Date.parse('2026-11-01'));
  const nueva = instalar('.editor/extensions/acme.revisor-1.1/resources/revisor', Date.parse('2026-11-20'));
  assert.strictEqual(RR.resolveBin(runner, 'revisor', { env: { PATH: '/no/existe' }, platform: 'darwin', home: casa }).bin, nueva);
  // Windows: el PATH con `;` y las extensiones de PATHEXT
  instalar('bin/revisor.EXE');
  assert.strictEqual(RR.resolveBin(runner, 'revisor', { env: { PATH: `/no/existe;${enPath}`, PATHEXT: '.EXE;.CMD' }, platform: 'win32', home: casa }).bin, 'revisor');
  const exe = instalar('.editor/extensions/acme.revisor-2.0/resources/revisor.exe');
  assert.strictEqual(RR.resolveBin(runner, 'revisor', { env: { PATH: '/no/existe', PATHEXT: '.EXE' }, platform: 'win32', home: casa }).bin, exe);
  // con carpeta, tal cual
  assert.strictEqual(RR.resolveBin(runner, '/opt/x/revisor', { env: { PATH: '' }, platform: 'darwin', home: casa }).bin, '/opt/x/revisor');
  // en ningún lado: null y dónde buscó
  const nada = RR.resolveBin(runner, 'revisor', { env: { PATH: '/no/existe' }, platform: 'linux', home: casa });
  assert.strictEqual(nada.bin, null);
  assert.deepStrictEqual(nada.buscado, ['el PATH']);
  // la integración de fábrica declara dónde deja la extensión de VS Code al revisor de fábrica, en cada sistema
  const fabrica = RR.loadIntegration({ env: {} }).runners;
  const primero = fabrica[RR.DEFAULT_ORDER[0]];
  for (const so of ['darwin', 'linux', 'win32']) assert.ok(Array.isArray(primero.bin_paths && primero.bin_paths[so]) && primero.bin_paths[so].length, `bin_paths de ${so}`);
});

// T9 · 🔴 Falla con: un corredor fuera del PATH que no contesta aunque esté en su lugar, o una causa de «no se pudo
//    lanzar» que no dice dónde se buscó ni ofrece la salida aprobada (`--agents-dir`).
test('T9 ReviewRunner_BinFueraDelPath_CorreDesdeSuLugar_YSiNoEstaDiceLaSalida — el corredor fuera del PATH contesta; si no está, la causa nombra dónde buscó y --agents-dir', (t) => {
  const a = laboratorio(t, { uno: CONTESTA, dos: CONTESTA });
  const archivo = path.join(a.lab, 'integration.json');
  const integ = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  // «uno» queda fuera del PATH, en un lugar que declara su integración, con un nombre que ninguna máquina tiene en el
  // PATH (el PATH de la prueba es el de quien la corre)
  const nombre = 'revisor-de-prueba-fuera-del-path';
  const lugar = path.join(a.lab, 'ext', `${nombre}-3.2`);
  fs.mkdirSync(lugar, { recursive: true });
  fs.renameSync(path.join(a.lab, 'bin', 'uno'), path.join(lugar, nombre));
  integ.runners.uno.bin = nombre;
  integ.runners.uno.bin_paths = { [process.platform]: [path.join(a.lab, 'ext', `${nombre}-*`, nombre)] };
  fs.writeFileSync(archivo, JSON.stringify(integ));
  const r = a.correr(['uno']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.res.corredor.usado.a, 'uno', 'contestó «uno» desde su lugar');
  // sin el lugar: no se pudo lanzar, y la causa dice dónde buscó y la salida aprobada
  fs.rmSync(lugar, { recursive: true, force: true });
  const r2 = a.correr(['uno', 'dos']);
  const causa = r2.res.corredor.caidos.uno.causa;
  assert.match(causa, /no se pudo lanzar/);
  assert.match(causa, /el PATH/);
  assert.match(causa, /--agents-dir/);
});

// T10 · 🔴 Falla con: en Windows el corredor encontrado como `.cmd` (el atajo que deja npm) se lanza por su nombre sin
//    shell y Node no lo corre (ENOENT; con la extensión, EINVAL). Se lanza el `.js` del atajo con el mismo Node, o el
//    `.exe` al que apunta; un `.exe` del PATH va con su ruta; un atajo que no se entiende dice por qué.
test('T10 ReviewRunner_EnWindowsElAtajoCmdSeLanzaConNode — el .cmd de npm se lanza por su .js con el mismo Node, sin shell', (t) => {
  const dir = carpeta(t, 'rr-win-');
  const cli = path.join(dir, 'node_modules', '@acme', 'revisor', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '');
  // el atajo como lo escribe npm (cmd-shim): el programa va relativo a la carpeta del atajo
  fs.writeFileSync(path.join(dir, 'revisor.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@acme\\revisor\\cli.js" %*\r\n');
  fs.writeFileSync(path.join(dir, 'revisor'), '#!/bin/sh\n');
  const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const l = RR.launchable('revisor', { platform: 'win32', env, separator: path.delimiter });
  assert.strictEqual(l.bin, process.execPath);
  assert.deepStrictEqual(l.pre, [cli]);
  // un .exe en la misma carpeta gana: se lanza con su ruta
  fs.writeFileSync(path.join(dir, 'revisor.exe'), '');
  assert.deepStrictEqual(RR.launchable('revisor', { platform: 'win32', env, separator: path.delimiter }), { bin: path.join(dir, 'revisor.exe'), pre: [] });
  fs.rmSync(path.join(dir, 'revisor.exe'));
  // el atajo que apunta a un .exe lo lanza directo
  const exe = path.join(dir, 'node_modules', '@acme', 'revisor', 'bin', 'revisor.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(dir, 'revisor.cmd'), '@ECHO off\r\n"%~dp0\\node_modules\\@acme\\revisor\\bin\\revisor.exe"   %*\r\n');
  assert.deepStrictEqual(RR.launchable('revisor', { platform: 'win32', env, separator: path.delimiter }), { bin: exe, pre: [] });
  // un atajo que no se entiende: no se lanza a ciegas, y la causa lo dice
  fs.writeFileSync(path.join(dir, 'revisor.cmd'), '@ECHO off\r\ncall otra-cosa %*\r\n');
  const mal = RR.launchable('revisor', { platform: 'win32', env, separator: path.delimiter });
  assert.strictEqual(mal.bin, null);
  assert.match(mal.motivo, /revisor\.cmd/);
  // con la ruta del .cmd (la que da un lugar de la integración), lo mismo
  fs.writeFileSync(path.join(dir, 'revisor.cmd'), '"%dp0%\\node_modules\\@acme\\revisor\\cli.js" %*\r\n');
  assert.deepStrictEqual(RR.launchable(path.join(dir, 'revisor.cmd'), { platform: 'win32', env }), { bin: process.execPath, pre: [cli] });
  // un atajo ajeno delante no corta la búsqueda: el .exe de otra carpeta del PATH se lanza
  const otra = carpeta(t, 'rr-win-otra-');
  fs.writeFileSync(path.join(dir, 'revisor.cmd'), '@ECHO off\r\ncall otra-cosa %*\r\n');
  fs.writeFileSync(path.join(otra, 'revisor.exe'), '');
  const env2 = { PATH: `${dir}${path.delimiter}${otra}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.deepStrictEqual(RR.launchable('revisor', { platform: 'win32', env: env2, separator: path.delimiter }), { bin: path.join(otra, 'revisor.exe'), pre: [] });
  // un nombre que ya trae la extensión se busca tal cual
  assert.deepStrictEqual(RR.launchable('revisor.exe', { platform: 'win32', env: env2, separator: path.delimiter }), { bin: path.join(otra, 'revisor.exe'), pre: [] });
  // fuera de Windows, tal cual
  assert.deepStrictEqual(RR.launchable('revisor', { platform: 'linux', env }), { bin: 'revisor', pre: [] });
});

/** Un atajo como lo escribe cmd-shim 8 (npm) para un programa con su primera línea `#!/usr/bin/env <prog> <banderas>`. */
function atajoDeNpm(prog, banderas, destino) {
  return ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    `IF EXIST "%dp0%\\${prog}.exe" (`, `  SET "_prog=%dp0%\\${prog}.exe"`, ') ELSE (', `  SET "_prog=${prog}"`, '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" ${banderas} "%dp0%\\${destino}" %*`, ''].join('\r\n');
}

// T14 · 🔴 Falla con: un atajo de npm cuyo programa no es Node (bun), o que lleva banderas de la primera línea, o
//    cuyo destino no tiene extensión, no se lanza o se lanza con Node sin sus banderas.
test('T14 ReviewRunner_EnWindowsElAtajoDiceSuPrograma — el programa y las banderas los da el atajo, no la extensión del destino', (t) => {
  const dir = carpeta(t, 'rr-win-prog-');
  const otra = carpeta(t, 'rr-win-prog-path-');
  const opts = { platform: 'win32', env: { PATH: `${dir}${path.delimiter}${otra}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, separator: path.delimiter };
  const destino = path.join(dir, 'pkg', 'cli');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, '');
  const cli = path.join(dir, 'pkg', 'cli.js');
  fs.writeFileSync(cli, '');
  // Node con banderas y un destino sin extensión: el mismo Node, con las banderas delante
  fs.writeFileSync(path.join(dir, 'revisor.cmd'), atajoDeNpm('node', '--no-warnings', 'pkg\\cli'));
  assert.deepStrictEqual(RR.launchable('revisor', opts), { bin: process.execPath, pre: ['--no-warnings', destino] });
  // bun: no se corre con Node; se busca en el PATH (sólo lo que Node lanza solo)
  fs.writeFileSync(path.join(dir, 'revisor.cmd'), atajoDeNpm('bun', '', 'pkg\\cli.js'));
  const sinBun = RR.launchable('revisor', opts);
  assert.strictEqual(sinBun.bin, null);
  assert.match(sinBun.motivo, /bun/);
  fs.writeFileSync(path.join(otra, 'bun.cmd'), '');
  assert.strictEqual(RR.launchable('revisor', opts).bin, null, 'un bun.cmd no se lanza sin shell');
  fs.writeFileSync(path.join(otra, 'bun.exe'), '');
  assert.deepStrictEqual(RR.launchable('revisor', opts), { bin: path.join(otra, 'bun.exe'), pre: [cli] });
  // el bun que está al lado del atajo gana, como en el atajo
  fs.writeFileSync(path.join(dir, 'bun.exe'), '');
  assert.deepStrictEqual(RR.launchable('revisor', opts), { bin: path.join(dir, 'bun.exe'), pre: [cli] });
  // una variable en la primera línea: cmd-shim la toma por el programa; no se lanza a ciegas
  fs.writeFileSync(path.join(dir, 'revisor.cmd'), atajoDeNpm('NODE_OPTIONS=--max-old-space-size=99', 'node', 'pkg\\cli'));
  const conVariable = RR.launchable('revisor', opts);
  assert.strictEqual(conVariable.bin, null);
  assert.match(conVariable.motivo, /NODE_OPTIONS/);
  // una bandera con comillas: no cae a decidir por la extensión, se rechaza
  fs.writeFileSync(path.join(dir, 'revisor.cmd'), atajoDeNpm('bun', '--title="x y"', 'pkg\\cli.js'));
  assert.strictEqual(RR.launchable('revisor', opts).bin, null);
  // una variable simple de la primera línea (`@SET NOMBRE=1`): no viajaría, se rechaza
  fs.writeFileSync(path.join(dir, 'revisor.cmd'), atajoDeNpm('node', '', 'pkg\\cli.js').replace('SETLOCAL\r\n', 'SETLOCAL\r\n@SET NODE_NO_WARNINGS=1\r\n'));
  const conSet = RR.launchable('revisor', opts);
  assert.strictEqual(conSet.bin, null);
  assert.match(conSet.motivo, /NODE_NO_WARNINGS/);
  // el formato sin `_prog` (npm viejo): su programa y sus banderas también cuentan
  const viejo = (linea) => `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  ${linea}\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  ${linea}\r\n)\r\n`;
  fs.writeFileSync(path.join(dir, 'revisor.cmd'), viejo('"%~dp0\\pkg\\cli.js" %*'));
  assert.deepStrictEqual(RR.launchable('revisor', opts), { bin: process.execPath, pre: [cli] });
  fs.writeFileSync(path.join(dir, 'revisor.cmd'), 'node --no-warnings "%~dp0\\pkg\\cli" %*\r\n');
  assert.deepStrictEqual(RR.launchable('revisor', opts), { bin: process.execPath, pre: ['--no-warnings', destino] });
  fs.writeFileSync(path.join(dir, 'revisor.cmd'), 'bun "%~dp0\\pkg\\cli.js" %*\r\n');
  assert.deepStrictEqual(RR.launchable('revisor', opts), { bin: path.join(dir, 'bun.exe'), pre: [cli] });
});

// T12 · 🔴 Falla con: workflow-lite.js lanza el nombre del corredor en vez de lo que da `launchable` (programa y sus
//    argumentos delante), y el arreglo de Windows no llega al pase.
test('T12 WorkflowLite_LanzaLoQueDaLaunchable — el corredor se lanza con el programa y los argumentos que da launchable', async (t) => {
  const a = laboratorio(t, { uno: CONTESTA, dos: CONTESTA });
  const archivo = path.join(a.lab, 'integration.json');
  const integ = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  const nombre = 'revisor-que-solo-lanza-launchable';
  integ.runners.uno.bin = nombre;
  fs.writeFileSync(archivo, JSON.stringify(integ));
  const original = RR.launchable;
  const antes = { PATH: process.env.PATH, file: process.env.TYCON_REVIEW_RUNNER_FILE, stub: process.env.TYCON_WFLITE_AGENT_CMD };
  RR.launchable = (b, o) => (b === nombre ? { bin: process.execPath, pre: [path.join(a.lab, 'uno.js')] } : original(b, o));
  process.env.TYCON_REVIEW_RUNNER_FILE = archivo;
  delete process.env.TYCON_WFLITE_AGENT_CMD;
  t.after(() => {
    RR.launchable = original;
    for (const [k, v] of [['TYCON_REVIEW_RUNNER_FILE', antes.file], ['TYCON_WFLITE_AGENT_CMD', antes.stub]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const { runWorkflow } = require('../workflow-lite.js');
  const res = await runWorkflow(path.join(a.lab, 'toy.workflow.js'), {}, { cwd: a.lab, timeoutMs: 60000, runners: ['uno'] });
  assert.strictEqual(a.llamadas('uno'), 2, JSON.stringify(res && res.corredor));
  assert.strictEqual(res.corredor.usado.a, 'uno');
});

// T11 · 🔴 Falla con: en la revisión del plan, la causa de «no se pudo lanzar» ofrece `--agents-dir` como salida
//    aprobada, y el freno la rechaza a propósito (las respuestas las escribiría la sesión revisada).
test('T11 WorkflowLite_EnModoPlanNoOfreceAgentsDir — sin el corredor, la causa del modo plan dice dónde buscó sin ofrecer --agents-dir', (t) => {
  const a = laboratorio(t, { uno: CONTESTA, dos: CONTESTA });
  const archivo = path.join(a.lab, 'integration.json');
  const integ = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  integ.runners.uno.bin = 'corredor-que-no-esta-instalado-en-ninguna-maquina';
  fs.writeFileSync(archivo, JSON.stringify(integ));
  const r = a.correr(['uno', 'dos'], JSON.stringify({ modo: 'plan' }));
  const causa = r.res.corredor.caidos.uno.causa;
  assert.match(causa, /no se pudo lanzar/);
  assert.match(causa, /el PATH/);
  assert.doesNotMatch(causa, /--agents-dir/);
});

// T13 · 🔴 Falla con: en la revisión del plan, el aviso de pase NO MEDIDO del guion del pase ofrece `--agents-dir`.
test('T13 AdversarialVerify_ModoPlanNoMedido_NoOfreceAgentsDir — el cazador no contesta: el aviso no ofrece la salida por carpeta', (t) => {
  const lab = carpeta(t, 'rr-plan-');
  const muerto = path.join(lab, 'muerto.js');
  fs.writeFileSync(muerto, "process.exit(1);");
  const home = path.join(lab, 'home');
  fs.mkdirSync(home);
  const out = path.join(lab, 'resultado.json');
  const r = spawnSync(process.execPath, [LITE, path.join(SCRIPTS, 'adversarial-verify.workflow.js'), '--args', JSON.stringify({ repo: lab, modo: 'plan', pedido: '0123456789abcdef', storyTexto: 'una historia', planTexto: 'un plan corto' }), '--out', out],
    { cwd: lab, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_GUIDES_DIR: path.join(SCRIPTS, '..', '..', '..'), TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${muerto}` } });
  assert.match(r.stderr, /pase NO MEDIDO/, r.stderr);
  assert.doesNotMatch(r.stderr, /--agents-dir/);
});
