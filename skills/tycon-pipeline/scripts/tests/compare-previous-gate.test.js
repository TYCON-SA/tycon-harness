#!/usr/bin/env node
'use strict';
// compare-previous-gate.test.js — cuándo se compara y qué pasa con la diferencia.
//
//   T12      los candidatos: sólo los comandos modificados que existen en main, sin las pruebas, cada uno de su repo
//   T13-T16  el freno de «Preparar el commit»: sin humo ni exención, diferencia sin declarar, declarada, sin candidatos
//   T24-T27  la exención con firma, la del frontmatter no cuenta, «no comparado» no cumple, el aviso de cada exención
//   T28, T34 qué humo cubre qué candidato: por subcomando, por palabra completa, y por declaración con `--covers`
//   T31      la firma en el catálogo y en la ventana; sin el perfil, la coordinadora no la firma
//   P1-P6    lo que encontró el pase adversarial de la 8.243: qué es candidato, qué subcomando toca un cambio (cierres,
//            despachos con if, comentarios, switch internos, el último case, shell), las declaraciones bajo subtítulos,
//            un «no comparado» que no borra un «distinto», y un humo de otra versión del código que no cuenta
//   T28      el papeleo que escribe el cierre (los seguimientos y el renglón propio de sprint-status) no
//            vuelve viejo un humo; el renglón de otra historia, sí
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/compare-previous-gate.test.js < /dev/null

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const CP = path.join(SCRIPTS, 'lib', 'compare-previous.js');
const CW = path.join(SCRIPTS, 'lib', 'compare-waiver.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const SMOKE = path.join(SCRIPTS, 'smoke-run.sh');
const { conVentana } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'window-passed.js'));
const cp = () => require(CP);
const ft = () => require(path.join(SCRIPTS, 'lib', 'frozen-tree.js'));

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}
after(() => { for (const d of tmpDirs) { try { execFileSync('chmod', ['-R', 'u+w', d]); } catch { /* ya no está */ } fs.rmSync(d, { recursive: true, force: true }); } });

const FECHA = '2026-01-01T10:00:00';
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA };
const SIN_CIERRE = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check'];

// Un comando con subcomandos y funciones: el diff de cada prueba cae en uno de ellos o en la parte común.
const CLI = [
  '#!/usr/bin/env node',
  "'use strict';",
  'function saludar(n) {',
  '  return `hola ${n}`;',
  '}',
  'function despedir() {',
  "  return 'chau';",
  '}',
  'const sub = process.argv[2];',
  'switch (sub) {',
  "  case 'get':",
  "    console.log(saludar('get'));",
  '    break;',
  "  case 'forget':",
  "    console.log('olvido');",
  '    break;',
  "  case 'bye':",
  "  case 'adios':",
  '    console.log(despedir());',
  '    break;',
  '  default:',
  "    console.log('uso');",
  '}',
  '',
].join('\n');
const enGet = CLI.replace("console.log(saludar('get'));", "console.log(saludar('get!'));");
const enDespedir = CLI.replace("return 'chau';", "return 'chau!';");
const enLaParteComun = CLI.replace("const sub = process.argv[2];", "const sub = process.argv[2] || '';");

// Un repo con su origin (un repo desnudo): `main` con `archivos`, y la rama de la historia con `cambios` sin commitear.
function repoCon(base, nombre, archivos, cambios, home) {
  const origen = path.join(base, `${nombre}.git`);
  const repo = path.join(base, nombre);
  const g = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV, HOME: home } }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  fs.mkdirSync(repo, { recursive: true });
  g('init', '-q', '-b', 'main');
  g('remote', 'add', 'origin', origen);
  const escribir = (o) => {
    for (const [rel, txt] of Object.entries(o)) {
      const f = path.join(repo, rel);
      if (txt === null) { fs.rmSync(f, { force: true }); continue; }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, txt);
    }
  };
  escribir({ '.gitignore': '.advisors/\n', ...archivos });
  g('add', '.');
  g('commit', '-qm', 'inicio');
  g('push', '-q', 'origin', 'main');
  g('fetch', '-q', 'origin');
  g('checkout', '-q', '-b', 'story/9.9');
  escribir(cambios);
  return { repo, g };
}

function historia(repo, { modificar = [], cuerpo = [], frontmatter = [] } = {}) {
  const storyPath = path.join(repo, 'specs', 'story-9.9-cmp.md');
  fs.mkdirSync(path.dirname(storyPath), { recursive: true });
  fs.writeFileSync(storyPath, ['---', 'story: "9.9"', 'epic: "9"', 'status: in-progress', ...frontmatter, 'files_to_modify:', ...modificar.map((f) => `  - ${f}`), '---', '', '# Story 9.9', '', ...cuerpo, ''].join('\n'));
  return storyPath;
}

// El laboratorio de un repo: la historia y el comando viven en el mismo repo; el marcador está en «Preparar el commit».
function laboratorio({ archivos = { 'cli.js': CLI }, cambios = { 'cli.js': enGet }, modificar = ['cli.js'], cuerpo = [], frontmatter = [], sid = 's-gate' } = {}) {
  const base = tmp('cpg-');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const { repo, g } = repoCon(base, 'repo', { 'specs/.keep': '', ...archivos }, {}, home);
  const storyPath = historia(repo, { modificar, cuerpo, frontmatter });
  g('add', '.');
  g('commit', '-qm', 'la historia');
  const baseSha = g('rev-parse', 'HEAD');
  for (const [rel, txt] of Object.entries(cambios)) fs.writeFileSync(path.join(repo, rel), txt);
  const state = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  const marcador = {
    storyId: '9.9', sessionId: sid, stepScheme: 2, startedAt: '2026-10-22T10:00:00.000Z', lastTouch: '2026-10-22T10:00:00.000Z',
    stepsCompleted: SIN_CIERRE, stepsPending: ['prepare-commit'], iterations: {},
    storyPath, repoPath: repo, baseSha, filesTouched: Object.keys(cambios).map((r) => path.join(repo, r)), fileEvents: [],
  };
  fs.writeFileSync(path.join(state, 'active', `${sid}.json`), JSON.stringify(marcador));
  const env = (extra = {}) => {
    const e = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_PROFILE: '0', TYCON_NO_RUN_CHANGE: '', ...extra };
    delete e.TYCON_HOME;
    delete e.NODE_TEST_CONTEXT;
    return e;
  };
  const runDir = () => require(PIPELINE).resolveRunDir(repo, '9.9', true, storyPath);
  const cerrar = () => spawnSync(process.execPath, [MARKER, 'complete-step', 'prepare-commit'], { cwd: repo, encoding: 'utf8', env: env() });
  const marker = (args, { ventana = true, delegadaPor } = {}) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8', env: ventana ? conVentana(env(), { delegadaPor }) : env(), detached: true });
  // un humo comparado ya corrido: su entrada en el informe y su renglón en el registro del arnés
  // stable-data: la hora de la entrada y de la constancia sólo se anota; el freno no compara horas ni shas
  // con el sello del código de ahora: el freno cuenta sólo los humos del árbol que se guarda
  const humo = (entrada) => cp().anotarEntrada(runDir(), state, { ts: new Date().toISOString(), sid, repo, encierro: { nombre: 'ninguno' }, covers: [], sello: ft().seal(repo).tree, ...entrada });
  return { base, home, repo, g, storyPath, state, sid, env, runDir, cerrar, marker, humo };
}
const FRENO = /BLOQUEADO — comparación con main/;
const lineasDelFreno = (state) => {
  try { return fs.readFileSync(path.join(state, 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((g) => g.name === 'compare-previous-gate'); } catch { return []; }
};

test('T12 Candidatos_SoloComandosExistentes @story-8.167 @ac-10 — sólo los comandos modificados que existen en main, sin las pruebas, cada uno de su repo', () => {
  const base = tmp('cpg-cand-');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const ESPERA = '#!/usr/bin/env node\nif (require.main === module) console.log(1);\n';
  const a = repoCon(base, 'a', { 'cli.js': CLI, 'datos.json': '{}\n', 'tests/ayuda.js': ESPERA, 'lib/x.test.js': ESPERA }, {
    'cli.js': enGet, 'datos.json': '{"a":1}\n', 'nuevo.js': ESPERA, 'tests/ayuda.js': `${ESPERA}// cambio\n`, 'lib/x.test.js': `${ESPERA}// cambio\n`,
  }, home);
  const b = repoCon(base, 'b', { 'tool.sh': '#!/bin/bash\necho hola\n' }, { 'tool.sh': '#!/bin/bash\necho chau\n' }, home);
  const storyPath = historia(a.repo, { modificar: ['cli.js', 'datos.json', 'nuevo.js', 'tests/ayuda.js', 'lib/x.test.js', 'tool.sh', 'fantasma.js'] });
  const r = cp().candidatos({ storyPath, repos: [a.repo, b.repo] });
  assert.deepStrictEqual(r.candidatos.map((c) => [c.archivo, c.repo]), [['cli.js', a.repo], ['tool.sh', b.repo]]);
  assert.deepStrictEqual(r.candidatos[0].subcomandos, ['get']);
  assert.deepStrictEqual(r.sinRepo.map((c) => c.archivo), ['fantasma.js']);
  // la línea de comando, con los repos de la corrida del marcador
  const state = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  fs.writeFileSync(path.join(state, 'active', 's-cand.json'), JSON.stringify({ storyId: '9.9', storyPath, repoPath: b.repo, sessionId: 's-cand' }));
  const env = { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 's-cand', TYCON_PROFILE: '0' };
  delete env.TYCON_HOME;
  const cli = spawnSync(process.execPath, [PIPELINE, 'compare-candidates', '--story', storyPath, '--json'], { cwd: a.repo, encoding: 'utf8', env });
  assert.strictEqual(cli.status, 0, cli.stderr);
  const j = JSON.parse(cli.stdout);
  assert.deepStrictEqual(j.candidatos.map((c) => c.archivo).sort(), ['cli.js', 'tool.sh']);
  assert.deepStrictEqual(j.sinRepo.map((c) => c.archivo), ['fantasma.js']);
  // el que no está en ningún repo no cumple: pide humo o exención como cualquiera
  const juicio = cp().juicio({ ...r, entradas: [], exenciones: new Map(), storyText: fs.readFileSync(storyPath, 'utf8') });
  const fantasma = juicio.faltan.find((f) => f.archivo === 'fantasma.js');
  assert.ok(fantasma, JSON.stringify(juicio.faltan));
  assert.match(fantasma.motivo, /no comparado: sin repo/);
});

test('T13 PrepareCommit_SinHumoNiExencion_Frena @story-8.167 @ac-11 — un candidato sin humo que lo cubra ni constancia', () => {
  const L = laboratorio();
  const r = L.cerrar();
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, FRENO);
  assert.match(r.stderr, /cli\.js/);
  assert.match(r.stderr, /get/, 'dice qué subcomando hay que cubrir');
  assert.match(r.stderr, /compare-waiver/, 'y la otra salida');
  assert.strictEqual(lineasDelFreno(L.state).at(-1).action, 'bloqueo');
});

test('T14 PrepareCommit_DiferenciaNoDeclarada_Frena @story-8.167 @ac-12 — un humo «distinto» sin declarar', () => {
  const L = laboratorio();
  L.humo({ cmd: 'node cli.js get', archivo: 'cli.js', resultado: 'distinto', main: { exit: 0 }, cambio: { exit: 1 }, diff: [{ linea: 1, main: 'hola get', cambio: 'hola get!' }] });
  const r = L.cerrar();
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, FRENO);
  assert.match(r.stderr, /node cli\.js get/);
  assert.match(r.stderr, /main salió 0.*el cambio salió 1/);
  assert.match(r.stderr, /hola get!/);
  assert.match(r.stderr, /Cambios de comportamiento/);
});

test('T15 PrepareCommit_Declarada_PasaSinBucle @story-8.167 @ac-13 — declarada exacta y por prefijo, pasa; declarar es papeleo', () => {
  const distinto = { archivo: 'cli.js', resultado: 'distinto', main: { exit: 0 }, cambio: { exit: 0 }, diff: [{ linea: 1, main: 'hola get', cambio: 'hola get!' }] };
  const base = { candidatos: [{ archivo: 'cli.js', repo: '/r', subcomandos: ['get'], sinSubcomando: false }], sinRepo: [], exenciones: new Map() };
  const conDeclaracion = (renglon) => ['---', 'story: "9.9"', '---', '', '## Cambios de comportamiento', '', renglon, '', '## Otra', ''].join('\n');
  const entradas = [{ ...distinto, repo: '/r', cmd: 'node cli.js get --verbose' }];
  for (const renglon of ['- node cli.js get --verbose: ahora saluda con signo', '- `node cli.js get `: ahora saluda con signo']) {
    const j = cp().juicio({ ...base, entradas, storyText: conDeclaracion(renglon) });
    assert.deepStrictEqual(j.noDeclaradas, [], renglon);
    assert.deepStrictEqual(j.faltan, [], renglon);
  }
  // un prefijo que no termina en espacio no declara: «node cli.js g» no es «node cli.js get»
  const mal = cp().juicio({ ...base, entradas, storyText: conDeclaracion('- node cli.js g: algo') });
  assert.strictEqual(mal.noDeclaradas.length, 1);
  // declarar es papeleo: la copia revisada no cambia por la sección «Cambios de comportamiento»
  const ft = require(path.join(SCRIPTS, 'lib', 'frozen-tree.js'));
  const antes = ['---', 'story: "9.9"', '---', '', '## Story', 'x', ''].join('\n');
  const despues = ['---', 'story: "9.9"', '---', '', '## Story', 'x', '', '## Cambios de comportamiento', '', '- node cli.js get: ahora saluda con signo', ''].join('\n');
  assert.strictEqual(ft.sinPapeleoDeLaHistoria(antes), ft.sinPapeleoDeLaHistoria(despues));
  // y el cierre pasa este freno con la diferencia declarada por prefijo
  const L = laboratorio({ cuerpo: ['## Cambios de comportamiento', '', '- node cli.js get : ahora saluda con signo'] });
  L.humo({ ...distinto, cmd: 'node cli.js get --verbose' });
  const r = L.cerrar();
  assert.doesNotMatch(r.stderr, FRENO, r.stderr);
  assert.strictEqual(lineasDelFreno(L.state).at(-1).action, 'verde');
});

test('T16 SinCandidatos_NoCorreNada @story-8.167 @ac-14 — una historia que no modifica comandos existentes', () => {
  const L = laboratorio({ archivos: { 'README.md': 'x\n' }, cambios: { 'README.md': 'y\n' }, modificar: ['README.md'] });
  assert.deepStrictEqual(cp().candidatos({ storyPath: L.storyPath, repos: [L.repo] }).candidatos, []);
  const r = L.cerrar();
  assert.doesNotMatch(r.stderr, FRENO);
  assert.doesNotMatch(r.stderr, /comparación con main/);
  assert.deepStrictEqual(lineasDelFreno(L.state), [], 'ni una línea: sin candidatos no hay control que anotar');
  assert.ok(!fs.existsSync(path.join(L.runDir(), cp().INFORME)), 'ninguna comparación corrió');
});

test('T24 CompareWaiver_SinFirmaNoEscribe @story-8.167 @ac-20 — sin firma no hay constancia; con firma delegada, exime', () => {
  const L = laboratorio();
  const args = ['compare-waiver', '--story', L.storyPath, '--command', 'cli.js', '--reason', 'usa la red: nunca da igual'];
  const sin = L.marker(args, { ventana: false });
  assert.notStrictEqual(sin.status, 0, sin.stderr);
  assert.ok(!fs.existsSync(path.join(L.runDir(), require(CW).FILE)), 'sin firma no escribe nada');
  // un candidato que no está en la lista no se exime: ni se pide la firma
  const otro = L.marker(['compare-waiver', '--story', L.storyPath, '--command', 'no-existe.js', '--reason', 'x']);
  assert.strictEqual(otro.status, 2, otro.stderr);
  assert.match(otro.stderr, /no es candidato/);
  const con = L.marker(args, { delegadaPor: 's-coordinadora' });
  assert.strictEqual(con.status, 0, con.stderr);
  const vig = require(CW).vigentes(L.runDir(), { stateDir: L.state, story: '9.9' });
  assert.ok(vig.has('cli.js'), JSON.stringify([...vig.keys()]));
  const r = L.cerrar();
  assert.doesNotMatch(r.stderr, FRENO, r.stderr);
  // una constancia copiada a mano, sin su renglón en el registro del arnés, no exime
  const L2 = laboratorio({ sid: 's-gate-2' });
  fs.mkdirSync(L2.runDir(), { recursive: true });
  fs.writeFileSync(path.join(L2.runDir(), require(CW).FILE), `${JSON.stringify({ ts: new Date().toISOString(), story: '9.9', command: 'cli.js', reason: 'x', tipo: 'manual', quien: 'el dev', via: 'compare-waiver (ventana)' })}\n`);
  assert.match(L2.cerrar().stderr, FRENO);
});

test('T25 PrepareCommit_ExencionEnElFrontmatter_NoCuenta @story-8.167 @ac-20 — compare_exempt: en el frontmatter no exime', () => {
  const L = laboratorio({ frontmatter: ['compare_exempt:', '  - cli.js'] });
  const r = L.cerrar();
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, FRENO);
  assert.match(r.stderr, /compare_exempt/);
  assert.match(r.stderr, /marker\.js compare-waiver --story/);
});

test('T26 PrepareCommit_NoComparado_NoCumple @story-8.167 @ac-11 — el único humo dio «no comparado»', () => {
  for (const motivo of ['usa la red: git push', 'tope: la corrida de main pasó 500 ms']) {
    const L = laboratorio();
    L.humo({ cmd: 'node cli.js get', archivo: 'cli.js', resultado: 'no-comparado', motivo });
    const r = L.cerrar();
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, FRENO);
    assert.ok(r.stderr.includes(motivo), r.stderr);
  }
});

test('T27 PrepareCommit_AvisaCadaExencion @story-8.167 @ac-21 — la exención y la cobertura declarada, en el aviso y en el texto del pedido', () => {
  const L = laboratorio({
    archivos: { 'cli.js': CLI, 'otro.js': CLI, 'lab.js': '#!/usr/bin/env node\nconsole.log(1);\n' },
    cambios: { 'cli.js': enGet, 'otro.js': enLaParteComun }, modificar: ['cli.js', 'otro.js'],
  });
  const firma = L.marker(['compare-waiver', '--story', L.storyPath, '--command', 'cli.js', '--reason', 'usa la red: nunca da igual'], { delegadaPor: 's-coordinadora' });
  assert.strictEqual(firma.status, 0, firma.stderr);
  L.humo({ cmd: 'node {raiz}/lab.js', archivo: 'lab.js', covers: ['otro.js'], resultado: 'igual', main: { exit: 0 }, cambio: { exit: 0 } });
  const r = L.cerrar();
  assert.doesNotMatch(r.stderr, FRENO, r.stderr);
  for (const texto of [r.stderr, fs.readFileSync(path.join(L.runDir(), cp().AVISOS), 'utf8')]) {
    assert.match(texto, /cli\.js/);
    assert.match(texto, /usa la red: nunca da igual/);
    assert.match(texto, /coordinadora/, 'quién firmó');
    assert.match(texto, /cubierto por declaración/);
    assert.match(texto, /node \{raiz\}\/lab\.js/);
    assert.match(texto, /--covers otro\.js/);
  }
});

test('T28 Candidatos_HumoQueNoNombraElSubcomando_NoCubre @story-8.167 @ac-22 — por palabra completa sobre el comando tapado', () => {
  const L = laboratorio();
  const c = cp().candidatos({ storyPath: L.storyPath, repos: [L.repo] }).candidatos;
  assert.deepStrictEqual(c[0].subcomandos, ['get']);
  const humo = (cmd) => ({ cmd, archivo: 'cli.js', repo: L.repo, resultado: 'igual', covers: [] });
  const cubre = (cmd, cand = c) => cp().juicio({ candidatos: cand, sinRepo: [], entradas: [humo(cmd)], exenciones: new Map(), storyText: '' });
  assert.strictEqual(cubre('node cli.js bye').faltan.length, 1, 'otro subcomando no cubre');
  assert.strictEqual(cubre('node cli.js forget').faltan.length, 1, '«get» dentro de «forget» no cuenta');
  assert.strictEqual(cubre('node cli.js get').faltan.length, 0);
  // un cambio en una función: la cubre el subcomando que la llama, y sus alias; la función queda para `--covers`
  fs.writeFileSync(path.join(L.repo, 'cli.js'), enDespedir);
  const enFuncion = cp().candidatos({ storyPath: L.storyPath, repos: [L.repo] }).candidatos;
  assert.deepStrictEqual([...enFuncion[0].subcomandos].sort(), ['adios', 'bye']);
  assert.deepStrictEqual(enFuncion[0].funciones, ['despedir']);
  assert.strictEqual(cubre('node cli.js adios', enFuncion).faltan.length, 0);
  // un cambio fuera de todo subcomando: correr el archivo alcanza, y se dice
  fs.writeFileSync(path.join(L.repo, 'cli.js'), enLaParteComun);
  const comun = cp().candidatos({ storyPath: L.storyPath, repos: [L.repo] }).candidatos;
  assert.deepStrictEqual(comun[0].subcomandos, []);
  const j = cubre('node cli.js cualquiera', comun);
  assert.strictEqual(j.faltan.length, 0);
  assert.match(j.cubiertos[0].como, /cubre el archivo, sin subcomando/);
});

test('T31 CompareWaiver_EnElCatalogo_SinPerfilFirmaElDueno @story-8.167 @ac-24 — nivel 1, con su forma; sin el perfil, la coordinadora no firma', () => {
  const sig = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
  const s = sig.SIGNATURES.find((x) => x.id === 'compare-waiver');
  assert.ok(s, 'compare-waiver está en el catálogo');
  assert.strictEqual(s.level, 1);
  assert.match(s.command, /^marker\.js compare-waiver/);
  assert.ok(s.approves && s.approvesEn && s.ifWrong);
  assert.match(s.terminal, /--terminal/);
  const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
  assert.deepStrictEqual(ow.firmasDelComando('node /h/skills/tycon-pipeline/scripts/marker.js compare-waiver --story s.md --command cli.js --reason x'), ['compare-waiver']);
  const ds = require(path.join(RAIZ, 'scripts', 'lib', 'delegated-signing.js'));
  const sinPerfil = ds.delegaSinVentana({ firma: 'compare-waiver', sesion: 'coord', destino: 'otra', estado: tmp('cpg-ds-'), perfil: () => ({ delegated_signing: ['critical-waiver'], delegated_machines: [] }) });
  assert.strictEqual(sinPerfil.ok, false);
  assert.match(sinPerfil.motivo, /no delega «compare-waiver»/);
  const conPerfil = ds.delegaSinVentana({ firma: 'compare-waiver', sesion: 'coord', destino: 'otra', estado: tmp('cpg-ds-'), perfil: () => ({ delegated_signing: ['compare-waiver'], delegated_machines: [] }), huella: () => ({ huella: 'm1' }) });
  assert.doesNotMatch(conPerfil.motivo || '', /no delega/, 'con el renglón del perfil, la delegación sigue a sus otras llaves');
});

test('T34 Candidatos_CoversDeclarado_CubiertoPorDeclaracion @story-8.167 @ac-22 — `--covers` con `{raiz}` cubre lo que está en la lista', () => {
  const L = laboratorio({ archivos: { 'cli.js': CLI, 'lab.js': '#!/usr/bin/env node\nconsole.log(1);\n', 'datos.json': '{}\n' } });
  const { candidatos } = cp().candidatos({ storyPath: L.storyPath, repos: [L.repo] });
  const humo = (cmd, covers, extra = {}) => ({ cmd, covers, archivo: 'lab.js', repo: L.repo, resultado: 'igual', ...extra });
  const juzgar = (h) => cp().juicio({ candidatos, sinRepo: [], entradas: [h], exenciones: new Map(), storyText: '' });
  const bien = juzgar(humo('node {raiz}/lab.js', ['cli.js:get']));
  assert.strictEqual(bien.faltan.length, 0);
  assert.match(bien.cubiertos[0].como, /cubierto por declaración/);
  assert.ok(bien.avisos.some((a) => /cubierto por declaración/.test(a) && /--covers cli\.js:get/.test(a)), JSON.stringify(bien.avisos));
  const casos = [
    [humo('node {raiz}/lab.js', ['datos.json']), /no es candidato/],
    [humo('node lab.js', ['cli.js:get']), /\{raiz\}/],
    [humo('node {raiz}/lab.js', ['cli.js:forget']), /no toca «forget»/],
    [humo('node {raiz}/lab.js', ['cli.js']), /toca subcomandos/],
    [humo('node {raiz}/lab.js', ['cli.js:get', '../b/x.js'], { resultado: 'no-comparado', motivo: 'raíz ambigua: los --covers son de dos repos' }), /raíz ambigua/],
  ];
  for (const [h, porque] of casos) {
    const j = juzgar(h);
    assert.strictEqual(j.faltan.length, 1, `${h.cmd} ${h.covers}`);
    assert.ok(j.notas.some((n) => porque.test(n)) || porque.test(j.faltan[0].motivo || ''), `${h.covers}: ${JSON.stringify(j)}`);
  }
  // `--covers` sin `--compare`: smoke-run.sh sale 2 sin correr nada
  const sinCompare = spawnSync('bash', [SMOKE, path.join(L.repo, '.advisors', 'dod-runtime'), L.storyPath, '--covers', 'cli.js:get', '--', process.execPath, 'lab.js'], { cwd: L.repo, encoding: 'utf8', env: L.env() });
  assert.strictEqual(sinCompare.status, 2, sinCompare.stderr);
  // con `--compare`, el informe guarda el comando con `{raiz}` literal y la declaración
  const r = spawnSync('bash', [SMOKE, path.join(L.repo, '.advisors', 'dod-runtime'), L.storyPath, '--compare', '--covers', 'cli.js:get', '--', process.execPath, '{raiz}/lab.js'], { cwd: L.repo, encoding: 'utf8', env: L.env() });
  assert.strictEqual(r.status, 0, r.stderr);
  const informe = cp().leerInforme(L.runDir());
  const e = informe.at(-1);
  assert.ok(e && e.cmd.includes('{raiz}/lab.js'), JSON.stringify(informe));
  assert.deepStrictEqual(e.covers, ['cli.js:get']);
});

// ── Lo que encontró el pase adversarial de la 8.243 ───────────────────────────────────────────────────────────────────
const analizar = (codigo, buscar, sh = false) => {
  const lineas = codigo.join('\n').split('\n');
  return cp().analizar(lineas, [lineas.findIndex((l) => l.includes(buscar)) + 1], sh);
};

test('P1 Candidatos_SoloGuionesDeVerdad_YRutasDeclaradasDeOtraForma @story-8.167 @ac-10 — un .md no es comando; el prefijo, la ruta absoluta y la que sube se resuelven', () => {
  const base = tmp('cpg-p1-');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const r = repoCon(base, 'repo', { 'cli.js': CLI, 'specs/otra.md': 'el criterio dice `require.main === module`\n' },
    { 'cli.js': enGet, 'specs/otra.md': 'el criterio dice `require.main === module` y algo más\n' }, home);
  const conRutas = (rutas) => cp().candidatos({ storyPath: historia(r.repo, { modificar: rutas }), repos: [r.repo] });
  // un markdown que menciona la frase no es un comando: sin esto, una spec pediría un humo
  let c = conRutas(['specs/otra.md']);
  assert.deepStrictEqual([c.candidatos, c.sinRepo], [[], []]);
  // el prefijo de repo o de tanda no impide encontrarlo, ni lo manda a «sin repo»
  c = conRutas(['(agent-skills) cli.js']);
  assert.deepStrictEqual(c.candidatos.map((x) => x.archivo), ['cli.js']);
  assert.deepStrictEqual(c.sinRepo, []);
  // la ruta absoluta y la que sube desde la raíz del repo de la historia caen en su repo
  for (const ruta of [path.join(r.repo, 'cli.js'), '../repo/cli.js']) assert.deepStrictEqual(conRutas([ruta]).candidatos.map((x) => x.archivo), ['cli.js'], ruta);
  // una que no cae en ningún repo de la corrida no pasa callada: «sin repo»
  assert.deepStrictEqual(conRutas([path.join(base, 'afuera', 'x.js')]).sinRepo.map((x) => x.archivo), [path.join(base, 'afuera', 'x.js')]);
});

test('P2 Alcance_SigueLasLlamadas @story-8.167 @ac-22 — cierres, despachos con if, comentarios, switch internos, el último case y case no literales', () => {
  // un cierre dentro de la función de un subcomando: cuenta el subcomando que la llama
  assert.deepStrictEqual(analizar(['function cmdSave() {', '  const frenar = (m) => {', "    console.log('frena', m);", '  };', '  frenar(1);', '}',
    'switch (process.argv[2]) {', "  case 'save': cmdSave(); break;", '}'], "console.log('frena'").subcomandos, ['save']);
  // un despacho con if dentro de main(): el subcomando es la rama, no «main»
  const despacho = analizar(['#!/usr/bin/env node', 'function main() {', '  const cmd = process.argv[2];', "  if (cmd === 'review-rounds') {", "    console.log('rr');",
    '  }', "  if (cmd === 'advisors') {", "    console.log('adv');", '  }', '}', 'main();'], "console.log('rr')");
  assert.deepStrictEqual([despacho.subcomandos, despacho.funciones], [['review-rounds'], ['main']]);
  assert.strictEqual(cp().juicio({ candidatos: [{ archivo: 'cli.js', repo: '/r', ...despacho }], entradas: [{ cmd: 'node {raiz}/cli.js advisors --base origin/main', archivo: 'cli.js', repo: '/r', resultado: 'igual' }] }).faltan.length, 1,
    'un humo de advisors que dice origin/main no cubre un cambio en review-rounds');
  // un comentario que dice «case 'get':» no es una etiqueta
  assert.deepStrictEqual(analizar(['switch (process.argv[2]) {', "  case 'get': console.log('g'); break;", "  case 'approve':", "    // igual que en case 'get': leer primero",
    "    console.log('a');", '    break;', '}'], "console.log('a')").subcomandos, ['approve']);
  // el switch interno de una función auxiliar no reparte subcomandos: cuenta el que la llama
  assert.deepStrictEqual(analizar(['function tipoDe(x) {', '  switch (x) {', "    case 'a': return 'A';", "    case 'b': return 'B';", '  }', '}',
    'switch (process.argv[2]) {', "  case 'show': console.log(tipoDe(process.argv[3])); break;", '}'], "return 'A'").subcomandos, ['show']);
  // el último case sin default no se lleva lo que viene después del switch; una función que nadie llama no suma
  assert.deepStrictEqual(analizar(['function helper() { return 1; }', 'function other() { return helper(); }', 'switch (process.argv[2]) {', "  case 'a': other(); break;",
    "  case 'b': console.log('b'); break;", '}', 'function late() { return helper(); }'], 'function helper').subcomandos, ['a']);
  // un case no literal es su propia etiqueta, no la del case literal de arriba
  assert.deepStrictEqual(analizar(['switch (cmd) {', "  case 'a': doA(); break;", '  case B: doB(); break;', '  case 1:', '    one();', '    break;', '}'], 'one();').subcomandos, ['1']);
});

test('P3 Alcance_Shell_EsacYDefault @story-8.167 @ac-22 — lo de después de esac y lo de *) no son de ningún brazo', () => {
  const brazos = ['#!/bin/bash', 'case "$1" in', '  a) echo a ;;', '  b)', '    echo b', '    ;;', '  *)', '    echo unknown', '    ;;', 'esac', 'echo comun'];
  assert.deepStrictEqual(analizar(brazos, 'echo b', true).subcomandos, ['b']);
  for (const renglon of ['echo unknown', 'echo comun']) {
    const a = analizar(brazos, renglon, true);
    assert.deepStrictEqual([a.subcomandos, a.sinSubcomando], [[], true], renglon);
  }
});

test('P4 Declaracion_BajoSubtitulos @story-8.167 @ac-13 — un renglón bajo un ### de «Cambios de comportamiento» declara', () => {
  const texto = ['## Cambios de comportamiento', '', '### Tanda C', '', '- `node cli.js save`: dice frena con dos puntos', '', '## Change Log', '- node cli.js otro: no cuenta'].join('\n');
  assert.deepStrictEqual(cp().cambiosDeclarados(texto), ['`node cli.js save`: dice frena con dos puntos']);
  const j = cp().juicio({ candidatos: [], entradas: [{ cmd: 'node cli.js save', resultado: 'distinto', archivo: 'cli.js', repo: '/r' }], storyText: texto });
  assert.deepStrictEqual(j.noDeclaradas, []);
});

test('P5 NoComparado_NoBorraUnDistinto @story-8.167 @ac-12 — repetir el humo y que dé «no comparado» no esconde la diferencia', () => {
  // con la forma real: el candidato sale de `candidatos` y las entradas de `anotarEntrada` leídas del informe
  const juzgar = (resultados) => {
    const L = laboratorio({ sid: `s-gate-p5-${resultados.join('-')}` });
    const { candidatos } = cp().candidatos({ storyPath: L.storyPath, repos: [L.repo] });
    assert.deepStrictEqual(candidatos.map((c) => c.subcomandos), [['get']]);
    for (const resultado of resultados) {
      L.humo({ cmd: 'node {raiz}/cli.js get', archivo: 'cli.js', resultado, main: { exit: 0 }, cambio: { exit: resultado === 'distinto' ? 3 : 0 },
        ...(resultado === 'distinto' ? { diff: [{ linea: 1, main: 'hola get', cambio: 'hola get!' }] } : {}),
        ...(resultado === 'no-comparado' ? { motivo: 'tope: ya hubo 2 humos' } : {}) });
    }
    return cp().juicio({ candidatos, entradas: cp().leerInforme(L.runDir()), storyText: '' });
  };
  assert.strictEqual(juzgar(['distinto', 'no-comparado']).noDeclaradas.length, 1, 'el «distinto» sigue frenando');
  // un «igual» posterior sí reemplaza al «distinto» (se arregló el código y se volvió a correr)
  assert.strictEqual(juzgar(['distinto', 'igual']).noDeclaradas.length, 0);
});

test('P6 HumoDeOtraVersion_NoCuenta @story-8.167 @ac-11 — el freno mira sobre qué árbol corrió el humo', () => {
  const L = laboratorio({ sid: 's-gate-p6' });
  L.humo({ cmd: 'node cli.js get', archivo: 'cli.js', resultado: 'igual', main: { exit: 0 }, cambio: { exit: 0 } });
  const repos = [L.repo];
  const frenar = () => cp().freno({ storyPath: L.storyPath, repos, runDir: L.runDir(), stateDir: L.state, story: '9.9' });
  assert.strictEqual(frenar().bloquea, false, 'el humo es del código de ahora');
  // declarar en la historia es papeleo: el humo sigue valiendo
  fs.appendFileSync(L.storyPath, '\n## Cambios de comportamiento\n\n- node cli.js get : nada\n');
  assert.strictEqual(frenar().bloquea, false, 'cambiar la historia no vence el humo');
  // el código del subcomando cambia después del humo: ese humo ya no cuenta
  fs.writeFileSync(path.join(L.repo, 'cli.js'), enGet.replace("saludar('get!')", "saludar('get!!')"));
  const f = frenar();
  assert.strictEqual(f.bloquea, true);
  assert.ok(f.lineas.some((l) => /otra versión del código/.test(l)), f.lineas.join('\n'));
  // un humo sin sello (de antes de esta regla) tampoco
  const L2 = laboratorio({ sid: 's-gate-p6b' });
  L2.humo({ cmd: 'node cli.js get', archivo: 'cli.js', resultado: 'igual', main: { exit: 0 }, cambio: { exit: 0 }, sello: undefined });
  assert.strictEqual(cp().freno({ storyPath: L2.storyPath, repos: [L2.repo], runDir: L2.runDir(), stateDir: L2.state, story: '9.9' }).bloquea, true);
});

test('P13 Candidatos_LoQueNoSePuedeMirar_EsNoMedido @story-8.167 @ac-11 — el archivo de ahora ilegible, una ruta que se sale del repo y sin punto en común con main', () => {
  // el comando se borró en el cambio: su diff existe, pero el archivo de ahora no se lee
  const L = laboratorio({ sid: 's-gate-p13' });
  fs.rmSync(path.join(L.repo, 'cli.js'));
  const c = cp().candidatos({ storyPath: L.storyPath, repos: [L.repo] });
  assert.deepStrictEqual(c.candidatos, []);
  assert.deepStrictEqual(c.noMedidos.map((x) => x.archivo), ['cli.js']);
  assert.match(c.noMedidos[0].motivo, /no pude leer el archivo de ahora \(ENOENT\)/);
  // el freno no lo da por «sin candidatos»: «no medido», con el motivo, y la línea de comando lo dice
  const f = cp().freno({ storyPath: L.storyPath, repos: [L.repo], runDir: L.runDir(), stateDir: L.state, story: '9.9' });
  assert.strictEqual(f.medido, false);
  assert.match(f.motivo, /cli\.js \(repo\): no pude leer el archivo de ahora/);
  const r = L.cerrar();
  assert.match(r.stderr, /comparación con main: no medido \(cli\.js/, r.stderr);
  const cc = spawnSync(process.execPath, [PIPELINE, 'compare-candidates', '--story', L.storyPath, '--repo', L.repo], { cwd: L.repo, encoding: 'utf8', env: L.env() });
  assert.match(cc.stdout, /cli\.js \(repo\) — no medido: no pude leer el archivo de ahora/, cc.stdout);
  assert.doesNotMatch(cc.stdout, /sin candidatos/);

  // una ruta relativa que sube fuera del repo no se lee en ningún repo de la corrida
  const base = tmp('cpg-p13-');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const otro = repoCon(base, 'otro', { 'cli.js': CLI }, { 'cli.js': enGet }, home);
  const r1 = repoCon(base, 'repo', { 'cli.js': CLI }, { 'cli.js': enGet }, home);
  const fuera = cp().candidatos({ storyPath: historia(r1.repo, { modificar: ['specs/../../otro/cli.js'] }), repos: [r1.repo] });
  assert.deepStrictEqual([fuera.candidatos, fuera.noMedidos], [[], []], `no lee ${otro.repo}`);

  // sin punto en común con main (una rama huérfana): compara contra la punta de main y lo avisa
  r1.g('checkout', '-q', '--orphan', 'huerfana');
  r1.g('add', '.');
  r1.g('commit', '-qm', 'huerfana');
  fs.writeFileSync(path.join(r1.repo, 'cli.js'), enDespedir);
  const h = cp().candidatos({ storyPath: historia(r1.repo, { modificar: ['cli.js'] }), repos: [r1.repo] });
  assert.deepStrictEqual(h.candidatos.map((x) => x.archivo), ['cli.js']);
  assert.ok(h.avisos.some((a) => /no encontré el punto en común con main/.test(a)), h.avisos.join('\n'));
});

test('P14 HumoSinSellar_DiceElMotivo @story-8.167 @ac-11 — si el repo del humo no se puede sellar, no lo da por «otra versión»', () => {
  const noRepo = tmp('cpg-p14-');
  const e = { cmd: 'node cli.js get', archivo: 'cli.js', repo: noRepo, resultado: 'igual', sello: 'a'.repeat(40) };
  const d = cp().delCodigoDeAhora([e], null);
  assert.deepStrictEqual([d.vigentes, d.viejas], [[], []]);
  assert.strictEqual(d.sinComparar.length, 1);
  assert.match(d.sinComparar[0].motivo, /no pude sellar/);
  // en el freno: la nota dice el motivo, no «otra versión del código»
  const L = laboratorio({ sid: 's-gate-p14' });
  L.humo({ cmd: 'node cli.js get', archivo: 'cli.js', resultado: 'igual', main: { exit: 0 }, cambio: { exit: 0 }, repo: noRepo, sello: 'a'.repeat(40) });
  const f = cp().freno({ storyPath: L.storyPath, repos: [L.repo], runDir: L.runDir(), stateDir: L.state, story: '9.9' });
  assert.ok(f.lineas.some((l) => /no pude sellar .*no se pudieron atar al código de ahora/.test(l)), f.lineas.join('\n'));
  assert.ok(!f.lineas.some((l) => /otra versión del código/.test(l)), f.lineas.join('\n'));
});

test('T28 CompareSmokes_ClosingPaperwork_SmokeStaysCurrent @story-8.263 @ac-25 — los seguimientos y el renglón propio de sprint-status no vuelven viejo un humo', () => {
  const SPRINT = ['development_status:', '', 'epic-9: in-progress', '9-9-cmp: in-progress   # hoy', '9-10-otra: backlog', ''].join('\n');
  const L = laboratorio({ sid: 's-gate-t28', archivos: { 'cli.js': CLI, 'specs/sprint-status.yaml': SPRINT } });
  L.humo({ cmd: 'node cli.js get', archivo: 'cli.js', resultado: 'igual', main: { exit: 0 }, cambio: { exit: 0 } });
  const vigentes = () => cp().delCodigoDeAhora(cp().leerInforme(L.runDir()), L.storyPath);
  // «Hallazgos» escribe la sección de seguimientos y el cierre pasa la historia a review
  fs.appendFileSync(L.storyPath, '\n## Review Follow-ups (Advisors)\n\n- [ ] **[WARNING]** X-W1 — `cli.js` — algo <!-- fkey:X-W1|cli.js -->\n');
  fs.writeFileSync(path.join(L.repo, 'specs', 'sprint-status.yaml'), SPRINT.replace('9-9-cmp: in-progress   # hoy', '9-9-cmp: review   # cerrada'));
  let d = vigentes();
  assert.deepStrictEqual([d.vigentes.length, d.viejas.length], [1, 0], 'el humo sigue siendo de la versión de ahora');
  // el renglón de otra historia: el humo pasa a ser de otra versión
  fs.writeFileSync(path.join(L.repo, 'specs', 'sprint-status.yaml'), SPRINT.replace('9-10-otra: backlog', '9-10-otra: done'));
  d = vigentes();
  assert.deepStrictEqual([d.vigentes.length, d.viejas.length], [0, 1], 'otro renglón lo vuelve viejo');
});
