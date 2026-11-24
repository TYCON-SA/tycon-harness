'use strict';
/**
 * ci-red-lane.test.js — el arreglo de un rojo de CI de un pedido abierto (la firma `adhoc-lane:ci-rojo`): se abre sólo
 * sobre el pedido en rojo de la sesión, con su tope de 3 archivos y sin lo sensible; guarda sin revisores ni pase pero con
 * el control que falló corrido otra vez; tras empujar, la espera de la compilación lo cierra con el verde.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.TYCON_PACKS_DEFAULT = 'all';
const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const lane = require(path.join(SCRIPTS, 'lib', 'ci-red-lane.js'));
const screen = require(path.join(SCRIPTS, 'lib', 'adhoc-screen.js'));
const saveBrake = require(path.join(SCRIPTS, 'lib', 'save-brake.js'));
const espera = require(path.join(SCRIPTS, 'lib', 'pr-build-wait.js'));
const firmas = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
const MARKER = path.join(SCRIPTS, 'marker.js');

const FECHA = '2026-11-21T10:00:00Z';
const git = (d, ...a) => spawnSync('git', ['-C', d, '-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', '-c', 'maintenance.auto=false', ...a],
  { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA } });
function tmp(t, p) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function escribir(dir, rel, txt = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), txt);
}

/** Un repo con su origen y la rama del pedido ya empujada; una casa con la espera de la compilación de `sid` en rojo. */
function mundo(t, { estado = 'rojo', veredicto = 'rojo', numero = 6910 } = {}) {
  const raiz = tmp(t, 'ci-rojo-');
  const origen = path.join(raiz, 'backend-origen.git');
  const repo = path.join(raiz, 'backend');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'remote', 'add', 'origin', origen);
  escribir(repo, 'plugin.json', JSON.stringify({ name: 'X', version: '1.0.0' }));
  escribir(repo, 'plugin.json.example', JSON.stringify({ name: 'X', version: '1.0.0', defaultSettings: { a: 1 } }));
  escribir(repo, 'src/a.js'); escribir(repo, 'src/b.js'); escribir(repo, 'src/c.js'); escribir(repo, 'src/d.js');
  // el control de manifiestos, declarado para correr en local
  escribir(repo, '.tycon/ci-local-checks.json', JSON.stringify({ checks: [{ name: 'Manifest check', run: ['node', '$TYCON_HARNESS_DIR/scripts/ci/check-plugin-manifests.js', '--repo', '.'] }] }));
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'story/2.4');
  // la historia ya revisada: muchos archivos, que el arreglo no cuenta
  for (const n of ['e', 'f', 'g', 'h', 'i']) escribir(repo, `src/${n}.js`);
  escribir(repo, 'plugin.json', JSON.stringify({ name: 'X', version: '1.0.0', defaultSettings: { a: 1 } }));
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'la historia'); git(repo, 'push', '-q', 'origin', 'story/2.4');
  const commit = git(repo, 'rev-parse', 'HEAD').stdout.trim();
  const home = tmp(t, 'ci-rojo-casa-');
  const state = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(state, 'pr-build-wait'), { recursive: true });
  fs.writeFileSync(path.join(state, 'pr-build-wait', 's1-resultado.json'), JSON.stringify({ storyId: '2.4', estado,
    pedidos: [{ repo, nombre: 'backend', numero, rama: 'story/2.4', commit, veredicto, etapa: 'Backend CI · Package' }] }));
  return { repo, home, state, commit };
}
const abrir = (m, o = {}) => lane.validarApertura({ stateDir: m.state, sesion: 's1', pedido: 6910, control: 'Manifest check', allowedFiles: [path.join(m.repo, 'plugin.json')], tope: firmas.TOPE_CI_ROJO, ...o });

// 🔴 Falla con: abrir sin anotar la punta del pedido (el carril mediría desde main y contaría la historia entera).
test('CiRedLane_Opens_OnRedPr (T13) @story-8.322 @ac-11', (t) => {
  const m = mundo(t);
  const r = abrir(m);
  assert.ok(!r.problema, r.problema);
  assert.deepStrictEqual(r.ciRojo, { pedido: 6910, control: 'Manifest check', repo: m.repo, nombre: 'backend', rama: 'story/2.4', etapa: 'Backend CI · Package', puntas: { [m.repo]: m.commit }, storyId: '2.4' });
  // el carril abierto mide desde esa punta: los 5 archivos de la historia no suman, el arreglo sí
  const base = require(path.join(SCRIPTS, 'lib', 'adhoc-base.js'));
  escribir(m.repo, 'plugin.json', JSON.stringify({ name: 'X', version: '1.0.0' }));
  const carril = { reason: 'saca defaultSettings del manifiesto', maxFiles: 3, files: [path.join(m.repo, 'plugin.json')], allowedFiles: [path.join(m.repo, 'plugin.json')], ciRojo: r.ciRojo };
  const medida = base.medirLoPropio(carril);
  const rutas = base.rutasDe(medida, carril, { como: 'todo' })[m.repo] || [];
  assert.deepStrictEqual(rutas.map((x) => path.basename(x)).sort(), ['plugin.json'], JSON.stringify(rutas));
});

// 🔴 Falla con: la firma común o la de sobre cupo para el arreglo de un rojo, o una firma que la coordinadora no puede delegar.
test('CiRedLane_Signature_OwnerOrDelegated (T14) @story-8.322 @ac-12', () => {
  const pedido = (...extra) => ['--ci-red', '6910', '--check', 'Manifest check', '--reason', 'saca la clave', '--data', 'sin-cambio', ...extra];
  assert.strictEqual(firmas.firmaDelPedidoAdhoc(pedido('--file', 'plugin.json', '--file', 'src/a.js')), firmas.CI_ROJO);
  assert.strictEqual(firmas.firmaDelPedidoAdhoc(pedido('--file', 'src/a.js', '--file', 'src/b.js', '--file', 'src/c.js', '--file', 'src/a.test.js')), firmas.SOBRE_CUPO, 'una prueba cuenta');
  assert.strictEqual(firmas.firmaDelPedidoAdhoc(pedido('--file', 'src/a.js', '--file', 'src/a.test.js', '--file', 'README.md')), firmas.CI_ROJO);
  assert.strictEqual(firmas.firmaDelPedidoAdhoc(pedido('--file', 'src/a.js', '--file', 'src/b.js', '--file', 'src/c.js', '--file', 'src/d.js')), firmas.SOBRE_CUPO);
  assert.strictEqual(firmas.firmaDelPedidoAdhoc(pedido('--max-files', '2', '--file', 'src/a.js')), firmas.SOBRE_CUPO);
  const s = firmas.SIGNATURES.find((x) => x.id === firmas.CI_ROJO);
  assert.deepStrictEqual([s.level, s.otherSession, Boolean(s.clickDelDueno), Boolean(s.soloClick)], [1, 'yes', false, false]);
  assert.ok(firmas.delegable(firmas.CI_ROJO), 'la coordinadora la puede firmar si el perfil la delega');
  assert.ok(!firmas.delegable(firmas.CI_ROJO, { [firmas.CI_ROJO]: 2 }), 'un perfil que la sube a excepción la devuelve a una persona');
  assert.ok(!firmas.ONLY_IN_TERMINAL.includes(firmas.CI_ROJO));
  // el pedido por banderas, desde la sesión (sin --terminal): el pedido y el control van juntos, sin cupo propio
  assert.deepStrictEqual(screen.pedidoPorBanderas(pedido('--file', 'plugin.json')).payload, { ciRojo: 6910, control: 'Manifest check', reason: 'saca la clave', datos: 'sin-cambio', allowedFiles: ['plugin.json'] });
  assert.match(screen.pedidoPorBanderas(['--ci-red', '6910', '--reason', 'saca la clave']).problema, /van juntos/);
  assert.match(screen.pedidoPorBanderas(pedido('--max-files', '2')).problema, /va sin --max-files/);
  assert.match(screen.pedidoPorBanderas(['--ci-red', 'x', '--check', 'M', '--reason', 'saca la clave']).problema, /número del pedido/);
});

// 🔴 Falla con: un cuadro que no dice el pedido, el control o los archivos, o que la variante cae en el arreglo común.
test('CiRedLane_Box_ShowsPrCheckFiles (T15) @story-8.322 @ac-12', (t) => {
  const m = mundo(t);
  const r = spawnSync(process.execPath, [MARKER, 'adhoc', 'set', '--ci-red', '6910', '--check', 'Manifest check', '--reason', 'saca defaultSettings del manifiesto', '--data', 'sin-cambio', '--file', 'plugin.json'],
    { cwd: m.repo, encoding: 'utf8', env: { ...process.env, HOME: m.home, USERPROFILE: m.home, CLAUDE_CODE_SESSION_ID: 's1' } });
  // sin persona ni delegación en la prueba, no se aprueba; el pedido llegó a la firma con lo que se firma
  assert.notStrictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /la persona no lo aprobó/, r.stderr);
  assert.doesNotMatch(r.stderr, /marker\.js adhoc set: (el pedido #|la compilación del pedido|la lista nombra)/, r.stderr);
  const firmaLog = path.join(m.state, 'gates.log');
  const pedidos = fs.existsSync(firmaLog) ? fs.readFileSync(firmaLog, 'utf8') : '';
  assert.doesNotMatch(pedidos, /"name":"ci-red-lane","status":"open"/, 'se abrió sin firma');
  // la forma de la terminal es la del arreglo de un rojo, con el pedido y el control: la común abriría otra cosa
  assert.match(r.stderr, / adhoc set --ci-red 6910 --check "Manifest check" --reason "saca defaultSettings del manifiesto" --data sin-cambio --file plugin\.json --terminal --for-session s1 /, r.stderr);
});

// 🔴 Falla con: un tope que no es el del arreglo, o un archivo fuera de la lista que guarda.
test('CiRedLane_OutsideListOrOverCap_Blocks (T16) @story-8.322 @ac-13', (t) => {
  const m = mundo(t);
  assert.match(abrir(m, { allowedFiles: ['a', 'b', 'c', 'd'].map((n) => path.join(m.repo, 'src', `${n}.js`)) }).problema, /nombra 4 archivos y el arreglo de un rojo de CI llega hasta 3, pruebas incluidas/);
  // el tope cuenta todo: con las pruebas afuera, un archivo de código y diez de prueba pasaban sin revisores
  assert.match(abrir(m, { allowedFiles: ['a.js', 'a.test.js', 'b.test.js', 'c.test.js'].map((n) => path.join(m.repo, 'src', n)) }).problema, /nombra 4 archivos/);
  // la compilación y los controles del repo no se tocan por acá: el arreglo los apagaría en vez de arreglar el rojo
  for (const rel of ['.github/workflows/ci.yml', 'azure-pipelines.yml', 'build/azure-pipelines-pr.yaml', 'pipelines/build.yml', '.gitlab-ci.yml', '.tycon/ci-local-checks.json', '.tycon/advisors.yaml']) {
    escribir(m.repo, rel);
    assert.match(abrir(m, { allowedFiles: [path.join(m.repo, rel)] }).problema || '', /la lista toca la compilación o los controles del repo/, rel);
  }
  const otro = tmp(t, 'otro-repo-');
  assert.match(abrir(m, { allowedFiles: [path.join(otro, 'x.js')] }).problema, /no son del repo del pedido \(backend\)/);
  // abierto con su lista, guardar un archivo que la lista no nombra frena (el freno de la lista de siempre)
  const r = abrir(m);
  fs.mkdirSync(path.join(m.state, 'adhoc'), { recursive: true });
  // stable-data: la firma del carril tiene que ser de ahora, o el freno lo toma por vencido
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(m.state, 'adhoc', 's1.json'), JSON.stringify({ reason: 'saca defaultSettings del manifiesto', maxFiles: 3, files: [path.join(m.repo, 'src/a.js')],
    allowedFiles: [path.join(m.repo, 'plugin.json')], declaredAt: ts, lastTouch: ts, firmadaEn: ts, via: 'ventana', ciRojo: r.ciRojo, datos: 'sin-cambio' }));
  fs.appendFileSync(path.join(m.state, 'gates.log'), `${JSON.stringify({ ts, name: 'adhoc-lane:ci-rojo-signed', status: 'ok', destino: 's1' })}\n${JSON.stringify({ ts, name: 'adhoc-lane-signed', status: 'ok', destino: 's1' })}\n`);
  escribir(m.repo, 'src/a.js', 'cambiado\n');
  git(m.repo, 'add', '-A');
  const d = saveBrake.decidir({ command: 'git commit -m arreglo', cwd: m.repo, sid: 's1', home: m.home });
  assert.ok(d && d.texto, JSON.stringify(d));
  assert.match(d.texto, /src\/a\.js|lista/, d.texto);
  // la prueba de un archivo de la lista, por su nombre, no entra sin estar en la lista: el tope de 3 no se pasa con pruebas
  const LISTA = require(path.join(SCRIPTS, 'lib', 'adhoc-list.js'));
  const lista = [path.join(m.repo, 'plugin.json'), path.join(m.repo, 'src', 'a.js')];
  for (const rel of ['src/a.test.js', 'otra/__tests__/a.js', 'tests/a.spec.ts']) {
    const abs = path.join(m.repo, rel);
    assert.strictEqual(LISTA.fueraDeLaLista({ lista, filePath: abs, real: abs, repoRoot: m.repo }), null, `${rel}: el camino corto común la deja pasar`);
    assert.ok(LISTA.fueraDeLaLista({ lista, filePath: abs, real: abs, repoRoot: m.repo, estricta: true }), `${rel}: el del rojo la deja pasar`);
  }
  git(m.repo, 'reset', '-q', '--hard');
  fs.writeFileSync(path.join(m.state, 'adhoc', 's1.json'), JSON.stringify({ reason: 'saca defaultSettings del manifiesto', maxFiles: 3, files: [],
    allowedFiles: lista, declaredAt: ts, lastTouch: ts, firmadaEn: ts, via: 'ventana', ciRojo: r.ciRojo, datos: 'sin-cambio' }));
  escribir(m.repo, 'src/a.js', 'cambiado\n');
  escribir(m.repo, 'src/a.test.js', 'la prueba\n');
  git(m.repo, 'add', '-A');
  const p = saveBrake.decidir({ command: 'git commit -m arreglo', cwd: m.repo, sid: 's1', home: m.home });
  assert.ok(p && p.texto, `guardó una prueba fuera de la lista: ${JSON.stringify(p)}`);
  assert.match(p.texto, /a\.test\.js/, p.texto);
});

// 🔴 Falla con: guardar el arreglo sin correr los controles de CI en local, o corriendo sólo el que nombró la sesión.
test('CiRedLane_Save_RunsFailedCheck (T17) @story-8.322 @ac-14', () => {
  const carril = { ciRojo: { pedido: 6910, control: 'Manifest check', repo: '/r/backend', nombre: 'backend' } };
  const declarado = { controles: [{ nombre: 'Manifest check' }, { nombre: 'Lint' }], errores: [] };
  // el rojo de otro control declarado también frena: con `--check` elegido por la sesión, el que falló quedaba sin correr
  const rojo = lane.frenoAlGuardar(carril, { controlesDe: () => declarado, correr: (repo, o) => (o.soloNombre ? { codigo: 0 } : { codigo: 2, motivo: 'Lint sale 1 en local' }) });
  assert.ok(rojo, 'guardó con un control declarado en rojo');
  assert.strictEqual(rojo.texto, '🔒 GUARDAR: el arreglo del rojo de CI del pedido #6910 todavía no pasa los controles de CI que corren en local: Lint sale 1 en local');
  let corrido = null;
  assert.strictEqual(lane.frenoAlGuardar(carril, { controlesDe: () => declarado, correr: (repo, o) => { corrido = [repo, Boolean(o && o.soloNombre)]; return { codigo: 0, corridos: ['Manifest check', 'Lint'] }; } }), null);
  assert.deepStrictEqual(corrido, ['/r/backend', false], 'corrió uno solo, o en otro repo');
  // el control nombrado que no corrió (su `whenFile` no está en el repo) no es un verde: no guarda
  assert.match((lane.frenoAlGuardar(carril, { controlesDe: () => declarado, correr: () => ({ codigo: 0, corridos: ['Lint'] }) }) || {}).texto || '',
    /el control «Manifest check» no corrió en local/);
  assert.strictEqual(lane.frenoAlGuardar(carril, { controlesDe: () => declarado, correr: () => ({ codigo: 0, corridos: ['Manifest check', 'Lint'] }) }), null);
  // el control que dejó de estar declarado: sin él nada frena el arreglo, y no guarda
  assert.match(lane.frenoAlGuardar(carril, { controlesDe: () => ({ controles: [], errores: [] }), correr: () => assert.fail('corrió un control que no está declarado') }).texto,
    /el control «Manifest check» ya no está declarado para correr en local en backend: sin él no se guarda/);
  // la lista de controles rota no es «sin el control»
  assert.match(lane.frenoAlGuardar(carril, { controlesDe: () => ({ controles: [], errores: ['el paquete acme: un control le falta «name»'] }) }).texto, /no puede correr el control que falló: el paquete acme/);
  // un carril que no es el arreglo de un rojo no lo corre
  assert.strictEqual(lane.frenoAlGuardar({ reason: 'otro' }), null);
});

// 🔴 Falla con: pedirle revisores y pase al arreglo de un rojo de CI por una ruta de riesgo alto.
test('CiRedLane_NoPlanNoReviewers_HighRisk (T18) @story-8.322 @ac-15', () => {
  const carril = { ciRojo: { pedido: 6910 }, reason: 'x', riesgoAlto: { regla: 'produccion' } };
  assert.strictEqual(saveBrake.frenoDelRiesgo(carril, 's1', os.tmpdir(), [], { medida: {}, registrar: false }), null);
});

// 🔴 Falla con: abrir el arreglo con un archivo sensible, que va con su firma de control.
test('CiRedLane_Sensitive_KeepsControlSignature (T19) @story-8.322 @ac-15', (t) => {
  const m = mundo(t);
  escribir(m.repo, 'scripts/lib/signatures.js', '// x\n');
  const r = abrir(m, { allowedFiles: [path.join(m.repo, 'scripts', 'lib', 'signatures.js')] });
  assert.match(r.problema, /la lista toca lo sensible \(scripts\/lib\/signatures\.js\): eso va con su firma de control/);
});

// 🔴 Falla con: abrir sobre un pedido en verde, de otra sesión, sin espera, o con la punta movida.
test('CiRedLane_Refuses_GreenOtherOrClosed (T20) @story-8.322 @ac-16', (t) => {
  assert.match(abrir(mundo(t, { estado: 'listos', veredicto: 'verde' })).problema, /no está en rojo \(la espera dijo: verde\)/);
  assert.match(abrir(mundo(t), { pedido: 7000 }).problema, /el pedido #7000 no es de la espera de compilación de esta sesión \(#6910\)/);
  const m = mundo(t);
  assert.match(abrir(m, { sesion: 'otra' }).problema, /esta sesión no tiene una espera de compilación terminada/);
  escribir(m.repo, 'src/a.js', 'otro\n');
  git(m.repo, 'commit', '-qam', 'se movió');
  assert.match(abrir(m).problema, /no es la que dio rojo/);
  assert.match(abrir(mundo(t), { control: '  ' }).problema, /--check/);
  // un control que el repo no declara para correr en local: nada frenaría el arreglo antes de empujar
  assert.match(abrir(mundo(t), { control: 'nombre-inventado' }).problema, /«nombre-inventado» no es un control de CI que backend declare para correr en local \(«Manifest check»\)/);
  // declarado, pero con una condición que el repo no cumple: al guardar no correría, y nada frenaría el arreglo
  assert.match(abrir(mundo(t), { controlesDe: () => ({ controles: [{ nombre: 'Manifest check', whenFile: 'no-existe.json' }], errores: [] }) }).problema || '',
    /«Manifest check» no corre en backend: pide no-existe\.json/);
  // un arreglo común no se le suma al del rojo: le sacaría los revisores con otra firma
  const c = mundo(t);
  fs.mkdirSync(path.join(c.state, 'adhoc'), { recursive: true });
  // stable-data: la firma del carril tiene que ser de ahora, o el freno lo toma por vencido
  const ahora = new Date().toISOString();
  fs.writeFileSync(path.join(c.state, 'adhoc', 's1.json'), JSON.stringify({ reason: 'saca defaultSettings del manifiesto', maxFiles: 3, files: [], allowedFiles: [path.join(c.repo, 'plugin.json')],
    declaredAt: ahora, lastTouch: ahora, firmadaEn: ahora, via: 'ventana', ciRojo: abrir(c).ciRojo, datos: 'sin-cambio' }));
  const comun = spawnSync(process.execPath, [MARKER, 'adhoc', 'set', JSON.stringify({ reason: 'agranda el arreglo con otra cosa', datos: 'sin-cambio', maxFiles: 8, allowedFiles: ['plugin.json', 'src/a.js'] })],
    { cwd: c.repo, encoding: 'utf8', env: { ...process.env, HOME: c.home, USERPROFILE: c.home, CLAUDE_CODE_SESSION_ID: 's1' } });
  assert.strictEqual(comun.status, 2, comun.stderr);
  assert.match(comun.stderr, /tiene abierto el arreglo del rojo de CI del pedido #6910, sin revisores; un arreglo común no se le suma/);
  // ni al revés: el arreglo de un rojo no se abre sobre un arreglo común abierto, que tiene su propio tope
  const d = mundo(t);
  fs.mkdirSync(path.join(d.state, 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(d.state, 'adhoc', 's1.json'), JSON.stringify({ reason: 'un arreglo común con su lista', maxFiles: 8, files: [], allowedFiles: ['a', 'b', 'c', 'd'].map((n) => path.join(d.repo, 'src', `${n}.js`)),
    declaredAt: ahora, lastTouch: ahora, firmadaEn: ahora, via: 'ventana', datos: 'sin-cambio' }));
  const encima = spawnSync(process.execPath, [MARKER, 'adhoc', 'set', '--ci-red', '6910', '--check', 'Manifest check', '--reason', 'saca defaultSettings del manifiesto', '--data', 'sin-cambio', '--file', 'plugin.json'],
    { cwd: d.repo, encoding: 'utf8', env: { ...process.env, HOME: d.home, USERPROFILE: d.home, CLAUDE_CODE_SESSION_ID: 's1' } });
  assert.strictEqual(encima.status, 2, encima.stderr);
  assert.match(encima.stderr, /esta sesión tiene abierto un arreglo rápido común; el arreglo de un rojo de CI no se abre encima/);
  // por la consola: lo rechaza antes de pedir la firma
  const n = mundo(t, { estado: 'listos', veredicto: 'verde' });
  const r = spawnSync(process.execPath, [MARKER, 'adhoc', 'set', '--ci-red', '6910', '--check', 'Manifest check', '--reason', 'saca defaultSettings del manifiesto', '--data', 'sin-cambio', '--file', 'plugin.json'],
    { cwd: n.repo, encoding: 'utf8', env: { ...process.env, HOME: n.home, USERPROFILE: n.home, CLAUDE_CODE_SESSION_ID: 's1' } });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /marker\.js adhoc set: la compilación del pedido #6910 no está en rojo/);
  // en JSON no va: lo dice, en vez de un tope que la lista no pasa
  const j = mundo(t);
  const enJson = spawnSync(process.execPath, [MARKER, 'adhoc', 'set', JSON.stringify({ ciRojo: 6910, control: 'Manifest check', reason: 'saca defaultSettings del manifiesto', datos: 'sin-cambio', allowedFiles: ['plugin.json'] })],
    { cwd: j.repo, encoding: 'utf8', env: { ...process.env, HOME: j.home, USERPROFILE: j.home, CLAUDE_CODE_SESSION_ID: 's1' } });
  assert.strictEqual(enJson.status, 2, enJson.stderr);
  assert.match(enJson.stderr, /el arreglo de un rojo de CI se pide con banderas/);
  assert.doesNotMatch(enJson.stderr, /más de 3 archivos/);
});

// 🔴 Falla con: no relanzar la espera con la punta nueva tras empujar, o no cerrar el arreglo con el verde.
test('CiRedLane_Push_RelaunchesWait_ClosesOnGreen (T21) @story-8.322 @ac-17 @ac-18', (t) => {
  const m = mundo(t);
  const r = abrir(m);
  escribir(m.repo, 'plugin.json', JSON.stringify({ name: 'X', version: '1.0.0' }));
  git(m.repo, 'commit', '-qam', 'el arreglo');
  const nueva = git(m.repo, 'rev-parse', 'HEAD').stdout.trim();
  // sin empujar, la punta de la copia no es la del pedido: un verde suyo no dice nada del pedido
  assert.match((lane.esperaTrasEmpujar({ ciRojo: r.ciRojo }) || {}).problema || '', /no es la empujada del pedido #6910/);
  git(m.repo, 'push', '-q', 'origin', 'story/2.4');
  assert.deepStrictEqual(lane.esperaTrasEmpujar({ ciRojo: r.ciRojo }), [{ repo: m.repo, nombre: 'backend', numero: 6910, rama: 'story/2.4', commit: nueva }]);
  assert.strictEqual(lane.esperaTrasEmpujar({ reason: 'otro' }), null);
  // parada en otro commit en verde (main): tampoco
  git(m.repo, 'checkout', '-q', 'main');
  assert.match((lane.esperaTrasEmpujar({ ciRojo: r.ciRojo }) || {}).problema || '', /no es la empujada del pedido #6910/);
  git(m.repo, 'checkout', '-q', 'story/2.4');
  // la punta que se movió mientras esperaba: el verde del commit esperado no cierra el arreglo
  const lista = { session: 's1', closeAdhoc: true, pedidos: [{ repo: m.repo, nombre: 'backend', numero: 6910, rama: 'story/2.4', commit: nueva }] };
  assert.strictEqual(espera.puntaMovida(lista), null);
  escribir(m.repo, 'src/a.js', 'otro arreglo\n');
  git(m.repo, 'commit', '-qam', 'otro empuje'); git(m.repo, 'push', '-q', 'origin', 'story/2.4');
  assert.match(espera.puntaMovida(lista) || '', /la punta del pedido #6910 cambió mientras esperaba/);
  // con el verde, la espera cierra el arreglo en nombre de la sesión
  let llamada = null;
  assert.strictEqual(espera.cerrarArreglo('s1', { correr: (cmd, args, o) => { llamada = { args, sesion: o.env.CLAUDE_CODE_SESSION_ID }; return { status: 0 }; } }), true);
  assert.deepStrictEqual([llamada.args.slice(-2), llamada.sesion], [['adhoc', 'clear'], 's1']);
  assert.strictEqual(espera.cerrarArreglo('s1', { correr: () => ({ status: 1 }) }), false, 'un cierre que falló se dio por hecho');
  // con el pedido, sólo si el carril de la sesión sigue siendo el arreglo de ese rojo
  fs.mkdirSync(path.join(m.state, 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(m.state, 'adhoc', 's1.json'), JSON.stringify({ reason: 'otro carril que la sesión abrió después' }));
  assert.strictEqual(espera.cerrarArreglo('s1', { pedido: 6910, stateDir: m.state, correr: () => assert.fail('cerró otro carril') }), false);
  // y de verdad: el arreglo abierto de la sesión queda cerrado
  fs.mkdirSync(path.join(m.state, 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(m.state, 'adhoc', 's1.json'), JSON.stringify({ reason: 'saca defaultSettings del manifiesto', ciRojo: r.ciRojo }));
  const antes = process.env.HOME;
  process.env.HOME = m.home;
  try { assert.strictEqual(espera.cerrarArreglo('s1'), true); } finally { process.env.HOME = antes; }
  assert.ok(!fs.existsSync(path.join(m.state, 'adhoc', 's1.json')), 'el arreglo quedó abierto');
  // ci-wait sin el arreglo abierto no lanza nada
  const w = spawnSync(process.execPath, [MARKER, 'adhoc', 'ci-wait'], { cwd: m.repo, encoding: 'utf8', env: { ...process.env, HOME: m.home, USERPROFILE: m.home, CLAUDE_CODE_SESSION_ID: 's1' } });
  assert.strictEqual(w.status, 2);
  assert.match(w.stderr, /no tiene abierto el arreglo de un rojo de CI/);
});

// ── los revisores de un arreglo no ensanchan el alcance ──────────────────────────────────────────────────────────────
const fixScope = require(path.join(SCRIPTS, 'lib', 'fix-scope.js'));
const sello = (repo) => { git(repo, 'add', '-A'); return git(repo, 'write-tree').stdout.trim(); };

// 🔴 Falla con: tomar un hallazgo de la vuelta del arreglo fuera de sus líneas como uno del arreglo (otra vuelta), o
//    mover uno de adentro, o uno sin vuelta, de la primera, o sin poder medirlo.
test('Findings_OutsideFix_Deferred (T22) @story-8.322 @ac-19 @ac-20 @ac-21', (t) => {
  const repo = tmp(t, 'arreglo-');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  escribir(repo, 'src/a.js', Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n');
  escribir(repo, 'src/b.js', 'b\n');
  const antes = sello(repo);
  escribir(repo, 'src/a.js', Array.from({ length: 20 }, (_, i) => (i + 1 === 10 ? 'arreglada' : `l${i + 1}`)).join('\n') + '\n');
  const ahora = sello(repo);
  const casa = tmp(t, 'arreglo-casa-');
  fs.mkdirSync(path.join(casa, 'frozen', 's1'), { recursive: true });
  fs.writeFileSync(path.join(casa, 'frozen', 's1', 'vueltas.jsonl'), [
    { ts: '2026-11-21T10:00:00Z', tipo: 'revisores', etiqueta: 'iter-1', story: '9.9', repos: [{ repo, tree: antes }] },
    { ts: '2026-11-21T10:30:00Z', tipo: 'revisores', etiqueta: 'iter-2', story: '9.9', repos: [{ repo, tree: ahora }] },
    { ts: '2026-11-21T10:31:00Z', tipo: 'revisores', etiqueta: 'iter-2', story: '9.9', repos: [{ repo, tree: ahora }] },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const alcance = fixScope.alcanceDelArreglo({ stateDir: casa, sid: 's1', story: '9.9' });
  assert.deepStrictEqual(alcance, { iter: 2, repos: [{ repo, desde: antes, hasta: ahora }] }, 'la vuelta sellada dos veces cuenta una');
  const h = (o) => ({ rule_id: 'X-W1', severity: 'WARNING', advisor: 'r', disposition: 'open', reason: 'x', iter: 2, ...o });
  const hallazgos = [
    h({ rule_id: 'DENTRO', file: 'src/a.js', line: 10 }),
    h({ rule_id: 'MISMO-ARCHIVO-OTRA-LINEA', file: 'src/a.js', line: 3 }),
    h({ rule_id: 'OTRO-ARCHIVO', file: 'src/b.js', line: 1 }),
    h({ rule_id: 'SEC-C1', severity: 'CRITICAL', file: path.join(repo, 'src/b.js') }),
    h({ rule_id: 'SIN-LINEA', file: 'src/a.js' }),
    h({ rule_id: 'PRIMERA-VUELTA', file: 'src/b.js', iter: 1 }),
    h({ rule_id: 'SIN-VUELTA', file: 'src/b.js', iter: undefined }),
    h({ rule_id: 'YA-ARREGLADO', file: 'src/b.js', disposition: 'fixed' }),
    h({ rule_id: 'OTRO-REPO', file: '/otro/x.js' }),
  ];
  const r = fixScope.aplicar(hallazgos, alcance);
  const como = Object.fromEntries(r.records.map((f) => [f.rule_id, f.disposition === 'deferred' ? f.deuda : f.disposition]));
  assert.deepStrictEqual(como, { DENTRO: 'open', 'MISMO-ARCHIVO-OTRA-LINEA': 'fuera-del-arreglo', 'OTRO-ARCHIVO': 'fuera-del-arreglo', 'SEC-C1': 'fuera-del-arreglo',
    'SIN-LINEA': 'open', 'PRIMERA-VUELTA': 'open', 'SIN-VUELTA': 'open', 'YA-ARREGLADO': 'fixed', 'OTRO-REPO': 'open' });
  assert.deepStrictEqual(r.fuera.map((f) => f.rule_id), ['SEC-C1', 'MISMO-ARCHIVO-OTRA-LINEA', 'OTRO-ARCHIVO'], 'el crítico va primero');
  // dos repos: una ruta relativa es del único repo cuyo sello la tiene; si la tienen los dos, ante la duda es del arreglo
  const otro = tmp(t, 'arreglo-otro-');
  spawnSync('git', ['init', '-q', '-b', 'main', otro]);
  escribir(otro, 'src/c.js', 'c\n');
  escribir(otro, 'src/a.js', 'otra a\n');
  const deOtro = sello(otro);
  const dos = { iter: 2, repos: [{ repo: otro, desde: deOtro, hasta: deOtro }, { repo, desde: antes, hasta: ahora }] };
  assert.strictEqual(fixScope.estaFuera(h({ file: 'src/b.js', line: 1 }), dos), true, 'src/b.js es sólo del segundo, y el arreglo no lo tocó');
  assert.strictEqual(fixScope.estaFuera(h({ file: 'src/a.js', line: 10 }), dos), false, 'src/a.js está en los dos: no se sabe de cuál es');
  assert.strictEqual(fixScope.estaFuera(h({ file: 'src/c.js', line: 1 }), dos), true);
  assert.strictEqual(fixScope.estaFuera(h({ file: 'src/no-existe.js', line: 1 }), dos), false);
  // con una sola vuelta no hay arreglo que medir; con el diff ilegible, como vino
  assert.strictEqual(fixScope.alcanceDelArreglo({ stateDir: casa, sid: 's1', story: '7.7' }), null);
  assert.strictEqual(fixScope.estaFuera(h({ file: 'src/b.js' }), { iter: 2, repos: [{ repo, desde: 'f'.repeat(40), hasta: ahora }] }), false);
});
