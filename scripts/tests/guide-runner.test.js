'use strict';
/**
 * guide-runner.test.js — si una guía cambia lo que hace un agente: la misma tarea con la guía en el árbol y escondida,
 * si la leyó y si le salió mejor.
 *
 * Ningún caso gasta una llamada al modelo: el agente se inyecta con `TYCON_GUIDE_AGENT`, un guion falso que contesta en
 * `stream-json` y deja anotado el árbol que recibió.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TCG = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(TCG, 'scripts', 'controls-bench', 'guide-runner.js');
const EXAMEN = path.join(TCG, 'scripts', 'controls-bench', 'periodic-exam.js');
const CASOS_REALES = path.join(TCG, 'scripts', 'controls-bench', 'cases', 'guides');
const G = require(RUNNER);

const GUIA = 'guides/test-execution-discipline.md';
const TMPS = [];
test.after(() => { for (const d of TMPS) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(prefijo) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefijo)); TMPS.push(d); return d; }

// Un renglón de stream-json con un tool_use, como lo escribe `claude -p --output-format stream-json --verbose`.
const usoDe = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const fin = JSON.stringify({ type: 'result', subtype: 'success', result: 'listo' });

/**
 * Un caso de juguete en una carpeta propia, con su corrector, y un agente falso. `modo` del agente: `lee` (lee la guía si
 * está en el árbol y escribe `hecho.txt` sólo si la leyó), `no-lee` (escribe `hecho.txt` igual, sin leer), `crash` (sale
 * 1 sin contestar, con una ruta y una credencial en el error) y `error` (sale 0 con un `result` de error, como cuando se
 * acaba el tope de gasto). El corrector da 1 si está `hecho.txt`; con `corrector: 'lanza'` lanza al corregir y con
 * `'preparar-lanza'` lanza al preparar el árbol.
 */
function banco({ modo = 'lee', runs, corrector = 'normal' } = {}) {
  const raiz = tmp('guias-');
  const casos = path.join(raiz, 'casos');
  fs.mkdirSync(casos);
  fs.writeFileSync(path.join(casos, 'juguete.corrector.js'),
    "module.exports.corregir = ({ dir }) => require('fs').existsSync(require('path').join(dir, 'hecho.txt'))"
    + " ? { score: 1, motivo: 'hecho' } : { score: 0, motivo: 'no hizo la tarea' };\n"
    + (corrector === 'lanza' ? "module.exports.corregir = () => { throw new Error('git no anda'); };\n" : '')
    + (corrector === 'preparar-lanza' ? "module.exports.preparar = () => { throw new Error('no pude armar el repo'); };\n" : ''));
  fs.writeFileSync(path.join(casos, 'juguete.json'), JSON.stringify(Object.assign({
    guide: GUIA, task: 'Hacé la tarea de juguete.', tree: { 'src/a.js': 'module.exports = 1;\n', 'README.md': 'juguete\n' },
    corrector: 'juguete.corrector.js',
  }, runs ? { runs } : {})));
  const bitacora = path.join(raiz, 'arboles.jsonl');
  const agente = path.join(raiz, 'agente-falso.js');
  fs.writeFileSync(agente, [
    "const fs = require('fs'); const path = require('path');",
    `const modo = ${JSON.stringify(modo)};`,
    "if (modo === 'crash') { process.stderr.write('falló en ' + ['', 'Users', 'alguien', 'Cliente Grande', 'a.js'].join('/') + ' con Bearer secreto123\\n'); process.exit(1); }",
    "if (modo === 'error') { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true }) + '\\n'); process.exit(0); }",
    'const listar = (d, b = "") => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? listar(path.join(d, e.name), b + e.name + "/") : [b + e.name]);',
    `fs.appendFileSync(${JSON.stringify(bitacora)}, JSON.stringify(listar(process.cwd()).sort()) + "\\n");`,
    `const guia = ${JSON.stringify(GUIA)};`,
    'const esta = fs.existsSync(guia);',
    "const out = [JSON.stringify({ type: 'system', subtype: 'init' })];",
    "if (esta && modo === 'lee') out.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(process.cwd(), guia) } }] } }));",
    "if (modo === 'no-lee' || (esta && modo === 'lee')) fs.writeFileSync('hecho.txt', 'sí');",
    "out.push(JSON.stringify({ type: 'result', subtype: 'success', result: 'listo' }));",
    "process.stdout.write(out.join('\\n') + '\\n');",
  ].join('\n'));
  return { raiz, casos, bitacora, agente };
}

function correr(b, extra = []) {
  const informe = b.informe || path.join(b.raiz, 'informe.json');
  const r = spawnSync(process.execPath, [RUNNER, '--cases', b.casos, '--json', informe, ...extra],
    { encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_GUIDE_AGENT: b.agente }), timeout: 60000 });
  let datos = null;
  try { datos = JSON.parse(fs.readFileSync(informe, 'utf8')); } catch (_) { /* no escribió informe */ }
  return { status: r.status, salida: `${r.stdout || ''}${r.stderr || ''}`, datos };
}

test('T1 Caso_SinCorrector_Invalido @story-1.25 @ac-1 @ac-5', () => {
  const dir = tmp('caso-');
  const sin = G.validarCaso({ guide: GUIA, task: 't', tree: {} }, dir);
  assert.strictEqual(sin.ok, false);
  assert.match(sin.motivo, /corrector/);
  const inexistente = G.validarCaso({ guide: GUIA, task: 't', tree: {}, corrector: 'no-esta.js' }, dir);
  assert.strictEqual(inexistente.ok, false);
  assert.match(inexistente.motivo, /no existe/);
  fs.writeFileSync(path.join(dir, 'c.js'), 'module.exports.corregir = () => ({ score: 1 });\n');
  const sinGuia = G.validarCaso({ guide: 'guides/no-hay-tal-guia.md', task: 't', tree: {}, corrector: 'c.js' }, dir);
  assert.strictEqual(sinGuia.ok, false, 'una guía que no está en el arnés no se mide');
  assert.match(sinGuia.motivo, /guía/);

  const reales = G.cargarCasos(CASOS_REALES);
  const guias = reales.map((c) => c.caso.guide).sort();
  assert.deepStrictEqual(guias, ['guides/git-commit-conventions.md', 'guides/test-execution-discipline.md', 'story-format.md']);
  for (const c of reales) assert.strictEqual(c.validez.ok, true, `${c.nombre}: ${c.validez.motivo}`);
});

test('T2 Corridas_ConYSinGuia_ElArbolSinElArchivo @story-1.25 @ac-2', () => {
  const b = banco();
  const r = correr(b);
  assert.strictEqual(r.status, 0, r.salida);
  const arboles = fs.readFileSync(b.bitacora, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(arboles.length, 2, 'una corrida con la guía y una sin ella (1 por lado por defecto)');
  const con = arboles.find((a) => a.includes(GUIA));
  const sin = arboles.find((a) => !a.includes(GUIA));
  assert.ok(con && sin, `un árbol con la guía y otro sin ella: ${JSON.stringify(arboles)}`);
  assert.deepStrictEqual(con.filter((f) => f !== GUIA), sin, 'el resto del árbol es igual');
  assert.ok(sin.includes('CLAUDE.md') && sin.includes('src/a.js'));
});

test('T3 Lectura_DelRegistroDeHerramientas @story-1.25 @ac-3', () => {
  const leyo = [usoDe('Read', { file_path: `/tmp/x/${GUIA}` }), fin].join('\n');
  const porBash = [usoDe('Bash', { command: `sed -n 1,40p ${GUIA}` }), fin].join('\n');
  const otra = [usoDe('Read', { file_path: '/tmp/x/guides/otra.md' }), usoDe('Bash', { command: 'npm test -- a' }), fin].join('\n');
  assert.strictEqual(G.leyoLaGuia(leyo, GUIA), true);
  assert.strictEqual(G.leyoLaGuia(porBash, GUIA), true);
  assert.strictEqual(G.leyoLaGuia(otra, GUIA), false);
  assert.strictEqual(G.leyoLaGuia('esto no es json\n', GUIA), false);
  // con el árbol de la corrida, sólo cuenta la guía de ESE árbol, no un archivo con el mismo nombre en otro lado
  const arbol = tmp('arbol-');
  const ajena = [usoDe('Read', { file_path: '/otro/lado/story-format.md' }), fin].join('\n');
  const propia = [usoDe('Read', { file_path: path.join(fs.realpathSync(arbol), 'story-format.md') }), fin].join('\n');
  const relativa = [usoDe('Read', { file_path: 'story-format.md' }), fin].join('\n');
  assert.strictEqual(G.leyoLaGuia(ajena, 'story-format.md', arbol), false);
  assert.strictEqual(G.leyoLaGuia(propia, 'story-format.md', arbol), true);
  assert.strictEqual(G.leyoLaGuia(relativa, 'story-format.md', arbol), true);
});

test('T4 Resultado_GuiaQueNoMejora_Marcada @story-1.25 @ac-4', () => {
  const corrida = (score, leyo) => ({ medida: true, score, leyo });
  const igual = G.resumir({ guia: GUIA, con: [corrida(1, true)], sin: [corrida(1, false)] });
  assert.strictEqual(igual.revisar, true, 'con la guía no sale mejor: se marca para revisar');
  assert.strictEqual(igual.leyo_pct, 100);
  assert.match(igual.senal, /señal gruesa: 1 corrida/);
  const mejor = G.resumir({ guia: GUIA, con: [corrida(1, true), corrida(1, false)], sin: [corrida(0, false), corrida(0, false)] });
  assert.strictEqual(mejor.revisar, false);
  assert.strictEqual(mejor.leyo_pct, 50);
  assert.strictEqual(mejor.puntaje_con, 1);
  assert.strictEqual(mejor.puntaje_sin, 0);
  assert.strictEqual(mejor.senal, null);
  const noMedida = { medida: false, motivo: 'cortado' };
  const conHueco = G.resumir({ guia: GUIA, con: [corrida(1, true), noMedida], sin: [corrida(0, false), corrida(0, false)] });
  assert.strictEqual(conHueco.corridas, 1, 'la señal la da el lado con menos corridas medidas');
  assert.strictEqual(conHueco.sin_medir, 1, 'la corrida sin medir se cuenta, no se esconde');
  assert.match(conHueco.senal, /1 corrida/);
  const ceros = G.resumir({ guia: GUIA, con: [corrida(0, true)], sin: [corrida(0, false)] });
  assert.strictEqual(ceros.ninguno_lo_logro, true, '0 y 0: se mira el caso antes que la guía');
  assert.strictEqual(mejor.ninguno_lo_logro, undefined);
});

test('T5 NoPudoMedir_SaleDistintoDeCero @story-1.25 @ac-4', () => {
  const muerto = correr(banco({ modo: 'crash' }));
  assert.notStrictEqual(muerto.status, 0, 'el agente no contestó: no pudo medir');
  assert.match(muerto.salida, /no pude medir/);

  const noLee = correr(banco({ modo: 'no-lee' }));
  assert.strictEqual(noLee.status, 0, `midió aunque marque la guía: ${noLee.salida}`);
  assert.strictEqual(noLee.datos.guias[0].revisar, true);
  assert.match(noLee.salida, /revisar/);

  const lee = correr(banco({ modo: 'lee', runs: 2 }));
  assert.strictEqual(lee.status, 0, lee.salida);
  assert.strictEqual(lee.datos.guias[0].revisar, false);
  assert.strictEqual(lee.datos.guias[0].corridas, 2, 'más corridas sólo por configuración del caso');
});

test('T6 ExamenPeriodico_CorreLasGuiasDespues @story-1.25 @ac-6', () => {
  const casa = tmp('guias-casa-');
  const cfg = path.join(casa, 'exam-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ designated_machine: 'ninguna-maquina', days_between_runs: 3, scheduled_days: ['tuesday'], hour: '02:00' }));
  const dry = spawnSync(process.execPath, [EXAMEN, '--dry-run'],
    { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: casa, TYCON_EXAM_CONFIG: cfg }) });
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /después del examen: los casos de guía/);
  assert.match(dry.stdout, /TYCON_NO_NIGHTLY_EXAM/);

  const E = require(EXAMEN);
  const llamadas = [];
  const spawn = (bin, args) => { llamadas.push(args); return { status: 0 }; };
  const viajar = () => ({ ok: true });
  const base = { repo: casa, spawn, viajar, log: () => {} };
  assert.strictEqual(E.casosDeGuia(['--dry-run'], Object.assign({ corrioElExamen: true }, base)).corrio, false);
  assert.strictEqual(E.casosDeGuia([], Object.assign({ corrioElExamen: false }, base)).corrio, false, 'sin examen no hay guías: misma cadencia');
  const viejo = process.env.TYCON_NO_NIGHTLY_EXAM;
  process.env.TYCON_NO_NIGHTLY_EXAM = '1';
  try { assert.strictEqual(E.casosDeGuia([], Object.assign({ corrioElExamen: true }, base)).corrio, false, 'el mismo apagado'); }
  finally { if (viejo === undefined) delete process.env.TYCON_NO_NIGHTLY_EXAM; else process.env.TYCON_NO_NIGHTLY_EXAM = viejo; }
  assert.strictEqual(llamadas.length, 0);
  const r = E.casosDeGuia([], Object.assign({ corrioElExamen: true }, base));
  assert.strictEqual(r.corrio, true);
  assert.strictEqual(llamadas.length, 1);
  assert.ok(llamadas[0].some((a) => a.endsWith('guide-runner.js')));
  const i = llamadas[0].indexOf('--json');
  assert.strictEqual(llamadas[0][i + 1], path.join(casa, 'scripts', 'controls-bench', 'ultimo-guias.json'), 'al lado del resultado del examen');

  // un examen con el corredor inyectado (las pruebas del examen) nunca lanza agentes de verdad
  const viejoRunner = process.env.TYCON_EXAM_RUNNER;
  process.env.TYCON_EXAM_RUNNER = path.join(casa, 'corredor-falso.js');
  try {
    const sinSpawn = E.casosDeGuia([], { corrioElExamen: true, repo: casa, viajar, log: () => {} });
    assert.strictEqual(sinSpawn.corrio, false, 'examen de mentira: casos de guía de mentira o ninguno');
  } finally { if (viejoRunner === undefined) delete process.env.TYCON_EXAM_RUNNER; else process.env.TYCON_EXAM_RUNNER = viejoRunner; }
});

test('T7 Guia_LeerElResultadoDeLasGuias @story-1.25 @ac-7', () => {
  const guia = fs.readFileSync(path.join(TCG, 'guides', 'maintaining', 'mantener-el-arnes.md'), 'utf8');
  const fila = guia.split('\n').find((l) => l.includes('ultimo-guias.json'));
  assert.ok(fila, '«Mantener el arnés» nombra el resultado de las guías');
  assert.match(fila, /guide-runner\.js/);
  assert.match(fila, /revisar/);
  assert.match(fila, /no se borra/);
});

// el git del dev (ganchos, firmas, plantillas) no decide el resultado: config global vacía, como en el corrector
const ENV_GIT = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
const corrector = (n) => require(path.join(CASOS_REALES, `${n}.corrector.js`));

test('T8 Correctores_PuntuanLoBuenoYLoMalo @story-1.25 @ac-5', () => {
  const T = corrector('test-execution-discipline');
  const bash = (command) => ({ name: 'Bash', input: { command } });
  assert.strictEqual(T.corregir({ toolLog: [bash('node --test test/resta.test.js')] }).score, 1);
  assert.strictEqual(T.corregir({ toolLog: [bash('npm test -- resta')] }).score, 1);
  assert.strictEqual(T.corregir({ toolLog: [bash('node --test test/resta.test.js'), bash('cd . && npm test')] }).score, 0, 'una corrida de la suite entera alcanza');
  assert.strictEqual(T.corregir({ toolLog: [] }).score, 0, 'sin correr pruebas no se confirmó nada');

  const G2 = corrector('git-commit-conventions');
  const repo = tmp('gc-');
  G2.preparar(repo);
  assert.strictEqual(G2.corregir({ dir: repo }).score, 0, 'sin commit nuevo');
  spawnSync('git', ['-C', repo, '-c', 'maintenance.auto=false', 'commit', '-qam', 'fix(precio): redondea el IVA en vez de cortarlo\n\nEl precio final perdía un centavo.\n\nCo-Authored-By: X <x@example.com>'], { env: ENV_GIT });
  assert.strictEqual(G2.corregir({ dir: repo }).score, 1);
  assert.deepStrictEqual(G2.evaluarMensaje('update'), { titulo: false, cuerpo: false, trailer: false });
  assert.strictEqual(G2.evaluarMensaje('chore: trigger rebuild\n\nporque sí').titulo, false, 'un título genérico no cuenta');
  assert.throws(() => G2.corregir({ dir: path.join(repo, 'no-existe') }), /git/, 'si git no anda, no se puntúa: se lanza');

  const S = corrector('story-format');
  const vacio = tmp('sf-');
  assert.strictEqual(S.corregir({ dir: vacio }).score, 0, 'sin story');
  fs.mkdirSync(path.join(vacio, 'specs'));
  fs.writeFileSync(path.join(vacio, 'specs', 'story-1.1-exportar.md'), [
    '---', 'epic: 1', 'story: 1.1', 'title: Exportar', 'status: ready-for-dev', '---',
    '## Story', 'Como admin, quiero bajar el CSV, para analizarlo.', '## Acceptance Criteria', '1. baja',
    '### Tests', '| # | Nombre |', '|---|---|', '| T1 | Baja |', '## Tasks / Subtasks', '- [ ] a', '## Dev Notes', 'x', ''].join('\n'));
  assert.strictEqual(S.corregir({ dir: vacio }).score, 1);
  fs.writeFileSync(path.join(vacio, 'specs', 'story-1.1-exportar.md'), '# Exportar\n\nUna historia sin formato.\n');
  assert.ok(S.corregir({ dir: vacio }).score < 0.5, 'sin frontmatter ni secciones');
});

test('T9 NoPudoMedir_NoPisaElInformeAnterior @story-1.25 @ac-4 @ac-6', () => {
  const anterior = { kind: 'casos-de-guia', ts: '2026-10-01T00:00:00.000Z', medido_en: '2026-10-01T00:00:00.000Z',
    guias: [{ caso: 'juguete', guia: GUIA, puntaje_con: 1, puntaje_sin: 0, revisar: false }], no_medido: [] };
  for (const [nombre, opciones] of [['error del agente', { modo: 'error' }], ['el corrector lanza', { corrector: 'lanza' }],
    ['preparar lanza', { corrector: 'preparar-lanza' }], ['el agente muere', { modo: 'crash' }]]) {
    const b = banco(opciones);
    b.informe = path.join(b.raiz, 'informe.json');
    fs.writeFileSync(b.informe, JSON.stringify(anterior));
    const r = correr(b);
    assert.strictEqual(r.status, 3, `${nombre}: no pudo medir → 3 · ${r.salida}`);
    assert.match(r.salida, /no pude medir/, nombre);
    assert.deepStrictEqual(r.datos.guias, anterior.guias, `${nombre}: lo medido antes no se borra`);
    assert.strictEqual(r.datos.medido_en, anterior.medido_en, `${nombre}: y dice de cuándo es`);
    assert.strictEqual(r.datos.no_medido.length, 1, nombre);
    assert.doesNotMatch(JSON.stringify(r.datos), /alguien|Cliente Grande|secreto123/, `${nombre}: el motivo va saneado`);
    assert.deepStrictEqual(fs.readdirSync(b.raiz).filter((f) => f.startsWith('informe.json.')), [], `${nombre}: sin restos del temporal`);
  }

  const invalido = banco();
  fs.writeFileSync(path.join(invalido.casos, 'roto.json'), JSON.stringify({ guide: GUIA, task: 't', tree: {} }));
  assert.strictEqual(correr(invalido).status, 2, 'un caso inválido sale 2, no 3');
  assert.strictEqual(correr(banco(), ['--runs', 'cero']).status, 2, '--runs que no es un entero ≥ 1 sale 2');
  const vacio = banco();
  vacio.informe = path.join(vacio.raiz, 'informe.json');
  const sinCasos = correr(vacio, ['--case', 'no-hay-tal']);
  assert.strictEqual(sinCasos.status, 2);
  assert.ok(!JSON.stringify(sinCasos.datos).includes(vacio.raiz), 'la carpeta de los casos no va al informe con su ruta');

  // los casos de guía que no dejaron informe no viajan; su código no cambia el del examen
  const E = require(EXAMEN);
  const casa = tmp('guias-casa-');
  const viajes = [];
  const avisos = [];
  const r = E.casosDeGuia([], { corrioElExamen: true, repo: casa, spawn: () => ({ status: 3 }),
    viajar: (...a) => { viajes.push(a); return { ok: true }; }, log: (m) => avisos.push(m) });
  assert.strictEqual(r.corrio, true);
  assert.strictEqual(viajes.length, 0, 'sin informe no hay nada que subir');
  assert.ok(avisos.some((m) => /salieron 3/.test(m)), avisos.join(' | '));
});

test('T10 Correctores_LoQueEncontroElPaseAdversarial @story-1.25 @ac-1 @ac-5', () => {
  // pruebas: la suite entera disfrazada de filtro sale 0; una sola prueba corrida de otra forma sale 1
  const T = corrector('test-execution-discipline');
  const arbol = tmp('ted-');
  fs.mkdirSync(path.join(arbol, 'test'));
  for (const n of ['suma', 'resta', 'producto']) fs.writeFileSync(path.join(arbol, 'test', `${n}.test.js`), '');
  const nota = (command) => T.corregir({ dir: arbol, toolLog: [{ name: 'Bash', input: { command } }] }).score;
  for (const entera of ['node --test test/*.test.js', 'node --test --test-name-pattern=. test/', 'npm test -- --test-reporter=spec',
    'node --test | grep resta.test.js', 'node --test test/resta.test.js test/suma.test.js test/producto.test.js',
    'npm t', 'yarn test', 'pnpm test', 'bun test']) assert.strictEqual(nota(entera), 0, entera);
  for (const acotada of ['node test/resta.test.js', 'node --test --test-reporter spec test/resta.test.js', 'npx jest resta',
    'npx vitest run resta', 'FOO=1 node test/resta.test.js', 'env FOO=1 node --test test/resta.test.js']) assert.strictEqual(nota(acotada), 1, acotada);
  for (const entera of ['time node --test', 'TYCON_FULL_SUITE=1 npm test -- resta', 'timeout -s KILL 60 node --test',
    'bash -c "node --test"', 'echo $(node --test)']) assert.strictEqual(nota(entera), 0, entera);
  for (const acotada of ['timeout 60 node --test test/resta.test.js', 'nohup nice -n 5 node --test test/resta.test.js',
    'sh -c "node --test test/resta.test.js"']) assert.strictEqual(nota(acotada), 1, acotada);
  // lo que no sabe leer no es un 0: lanza, y el corredor lo cuenta como «no pude medir»
  for (const opaca of ['ls test | xargs node --test', 'npm test -- "resta']) assert.throws(() => nota(opaca), /no pude leer/, opaca);
  if (process.getuid && process.getuid() !== 0) {
    const cerrado = path.join(arbol, 'cerrado');
    fs.mkdirSync(cerrado);
    fs.chmodSync(cerrado, 0);
    try { assert.throws(() => nota('node --test test/resta.test.js'), /EACCES/, 'un árbol que no se puede leer no se da por acotado'); }
    finally { fs.chmodSync(cerrado, 0o755); }
  }
  assert.strictEqual(nota('grep "npm test" package.json'), 0, 'nombrar npm test no es correrlo');
  assert.match(T.corregir({ dir: arbol, toolLog: [{ name: 'Bash', input: { command: 'grep "npm test" package.json' } }] }).motivo, /ninguna/);

  // commit: el cambio pedido tiene que entrar; un título que arranca con «fix» o «update» no es genérico por eso
  const G2 = corrector('git-commit-conventions');
  const repo = tmp('gc-');
  G2.preparar(repo);
  spawnSync('git', ['-C', repo, '-c', 'maintenance.auto=false', 'commit', '-q', '--allow-empty', '-m', 'fix(precio): redondea el IVA en vez de cortarlo\n\nEl precio final perdía un centavo.\n\nCo-Authored-By: X <x@example.com>'], { env: ENV_GIT });
  assert.strictEqual(G2.corregir({ dir: repo }).score, 0, 'un commit vacío no commitea el cambio');
  assert.strictEqual(G2.evaluarMensaje('fix: update rounding of the VAT price\n\nporque sí').titulo, true);
  assert.strictEqual(G2.evaluarMensaje('fix: update').titulo, false);

  // story: otro .md al lado no tapa a la story, y cada sección se busca en su propio cuerpo
  const S = corrector('story-format');
  const dir = tmp('sf-');
  fs.mkdirSync(path.join(dir, 'specs'));
  const buena = ['---', 'epic: 1', 'story: 1.1', 'title: Exportar', 'status: ready-for-dev', '---',
    '## Story', 'Como admin, quiero bajar el CSV, para analizarlo.', '## Acceptance Criteria', '1. baja',
    '### Tests', '| # | Nombre |', '|---|---|', '| T1 | Baja |', '## Tasks / Subtasks', '- [ ] a', '## Dev Notes', 'x', ''].join('\n');
  fs.writeFileSync(path.join(dir, 'specs', 'story-1.1-exportar.md'), buena);
  for (const otro of ['epic-1.md', 'README.md', 'sprint-plan.md']) fs.writeFileSync(path.join(dir, 'specs', otro), '# Épico 1\n');
  assert.strictEqual(S.corregir({ dir }).score, 1, 'el épico, el README y el plan no le restan a la story');
  const vacias = ['---', 'epic: 1', 'story: 1.1', 'title: Exportar', 'status: ready-for-dev', '---',
    '## Story', '## Acceptance Criteria', '### Tests', '## Tasks / Subtasks', 'Como admin, quiero bajar el CSV, para analizarlo.',
    '1. baja', '| # | Nombre |', '## Dev Notes', 'x', ''].join('\n');
  const otra = tmp('sf-');
  fs.mkdirSync(path.join(otra, 'specs'));
  fs.writeFileSync(path.join(otra, 'specs', 'story-1.1-exportar.md'), vacias);
  assert.ok(S.corregir({ dir: otra }).score < 1, 'Story, criterios y pruebas vacíos no sacan la nota completa');

  // corredor: --cases relativo funciona, y una opción sin valor sale 2
  const b = banco({ modo: 'lee' });
  const rel = spawnSync(process.execPath, [RUNNER, '--cases', 'casos', '--json', 'informe.json'],
    { cwd: b.raiz, encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_GUIDE_AGENT: b.agente }), timeout: 60000 });
  assert.strictEqual(rel.status, 0, `${rel.stdout}${rel.stderr}`);
  for (const sinValor of [['--runs'], ['--case'], ['--runs', '--case', 'juguete']]) {
    const r = correr(b, sinValor);
    assert.strictEqual(r.status, 2, `${sinValor.join(' ')}: ${r.salida}`);
    assert.match(r.salida, /sin valor/);
  }
  // `correr` ya pasa --cases y --json con valor: éstas van solas
  for (const sola of ['--cases', '--json']) {
    const r = spawnSync(process.execPath, [RUNNER, sola], { cwd: b.raiz, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 2, `${sola}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /sin valor/);
  }
});
