'use strict';
/**
 * ci-red-close.test.js — el cierre de «Preparar el pull request» corre en local los controles de la CI que se pueden
 * correr (los del paquete y los del repo), y no da por listo un pedido sin la compilación en verde.
 *
 * Sin esto, un control de manifiestos que en local tarda segundos da rojo recién en la compilación del pedido, después de
 * la cola, con el pedido ya presentado como listo.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const packs = require(path.join(SCRIPTS, 'lib', 'packs.js'));
const ci = require(path.join(SCRIPTS, 'lib', 'ci-local-checks.js'));
const saveOk = require(path.join(SCRIPTS, 'lib', 'save-ok.js'));

function tmp(t, p) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const FECHA = '2026-11-21T10:00:00Z';
const git = (d, ...a) => spawnSync('git', ['-C', d, '-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', '-c', 'maintenance.auto=false', ...a],
  { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA } });

// el control de manifiestos como lo declara el paquete del stack: con el guion del arnés, sin consola, y las migraciones
// contadas por el guion
const MANIFIESTOS = {
  name: 'Manifest check',
  run: ['node', '$TYCON_HARNESS_DIR/scripts/ci/check-plugin-manifests.js', '--repo', '.', '--migrations', 'auto'],
  whenFile: 'plugin.json',
  timeoutSeconds: 60,
};

/** Un paquete de prueba con esos controles de CI, activo en la máquina de la prueba. */
function conPaquete(t, controles) {
  const dir = tmp(t, 'ci-local-packs-');
  fs.mkdirSync(path.join(dir, 'acme', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'acme', 'agents', 'rev-acme.md'), '---\nname: rev-acme\n---\n# rev-acme\n');
  fs.writeFileSync(path.join(dir, 'acme', 'pack.json'), JSON.stringify({ name: 'acme', description: 'controles de la prueba',
    reviewers: [{ agent: 'rev-acme', group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'lean', prefixes: ['ACM'] }],
    ...(controles === undefined ? {} : { ciLocalChecks: controles }) }));
  const antes = { dir: process.env.TYCON_PACKS_DIR, def: process.env.TYCON_PACKS_DEFAULT };
  process.env.TYCON_PACKS_DIR = dir;
  process.env.TYCON_PACKS_DEFAULT = 'all';
  packs.resetCache();
  t.after(() => {
    for (const [k, v] of [['TYCON_PACKS_DIR', antes.dir], ['TYCON_PACKS_DEFAULT', antes.def]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    packs.resetCache();
  });
}

/** Un plugin con sus dos manifiestos iguales, commiteado; `extra`: lo que el cambio suma a `plugin.json` sin commitear. */
function plugin(t, { extra = null, archivos = {} } = {}) {
  const repo = tmp(t, 'ci-local-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  const meta = { name: 'Acme.Plugin', version: '1.0.0', hasSignalRHubs: true };
  fs.writeFileSync(path.join(repo, 'plugin.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(repo, 'plugin.json.example'), JSON.stringify({ ...meta, defaultSettings: { a: 1 } }, null, 2));
  for (const [rel, txt] of Object.entries(archivos)) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), txt); }
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  if (extra) fs.writeFileSync(path.join(repo, 'plugin.json'), JSON.stringify({ ...meta, ...extra }, null, 2));
  return repo;
}
const cierre = (repo) => saveOk.controlesDelCommit({ repos: [repo], para: 'pedido' });

// 🔴 Falla con: el cierre sin los controles de CI en local → un control declarado no corre (no deja rastro).
test('CiLocal_PackCheck_RunsAtClose (T1) @story-8.322 @ac-1 @ac-2', (t) => {
  const rastro = path.join(tmp(t, 'ci-local-rastro-'), 'corrio');
  conPaquete(t, [MANIFIESTOS, { name: 'Rastro', run: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(rastro)}, process.env.TYCON_REPO_DIR)`] }]);
  const repo = plugin(t);
  const r = cierre(repo);
  assert.deepStrictEqual(r, { codigo: 0 }, r.motivo);
  assert.strictEqual(fs.readFileSync(rastro, 'utf8'), repo, 'el control corre en el repo, con TYCON_REPO_DIR');
  // la lista que corre es la del paquete, con su tope y su condición
  const { controles, errores } = ci.controlesDe(repo);
  assert.deepStrictEqual(errores, []);
  assert.deepStrictEqual(controles.map((c) => [c.nombre, c.origen, c.topeS, c.whenFile]), [['Manifest check', 'el paquete acme', 60, 'plugin.json'], ['Rastro', 'el paquete acme', 120, null]]);
  // sin plugin.json, el control de manifiestos no corre: no hay nada que comparar
  const otro = tmp(t, 'ci-local-sin-plugin-');
  git(otro, 'init', '-q');
  fs.writeFileSync(path.join(otro, 'a.txt'), 'x\n');
  git(otro, 'add', '-A'); git(otro, 'commit', '-q', '-m', 'base');
  assert.deepStrictEqual(ci.correr(otro).corridos, ['Rastro']);
  // y la firma de guardar no los corre: no abre un pull request
  fs.rmSync(rastro);
  assert.strictEqual(saveOk.controlesDelCommit({ repos: [repo], para: 'firma' }).codigo, 0);
  assert.ok(!fs.existsSync(rastro), 'la firma de guardar corrió los controles de CI');
});

// 🔴 Falla con: el caso real, `defaultSettings` en plugin.json → el cierre pasa y la compilación del pedido da rojo.
test('CiLocal_ManifestRed_BlocksClose (T2) @story-8.322 @ac-1 @ac-2', (t) => {
  conPaquete(t, [MANIFIESTOS]);
  const repo = plugin(t, { extra: { defaultSettings: { a: 1 } } });
  const r = cierre(repo);
  assert.strictEqual(r.codigo, 2, 'el cierre dejó pasar el rojo de manifiestos');
  assert.match(r.motivo, new RegExp(`^${path.basename(repo)}: el control de CI «Manifest check» \\(el paquete acme\\) sale 1 en local, y la compilación del pull request daría rojo\\. Lo que dijo: .*defaultSettings`), r.motivo);
  assert.match(r.motivo, /volvé a cerrar «Preparar el pull request»$/);
  // arreglado, pasa
  fs.writeFileSync(path.join(repo, 'plugin.json'), JSON.stringify({ name: 'Acme.Plugin', version: '1.0.0', hasSignalRHubs: true }, null, 2));
  assert.strictEqual(cierre(repo).codigo, 0);
  // una migración nueva sin declarar en el manifiesto que viaja: también la ve, como la CI
  fs.mkdirSync(path.join(repo, 'database'));
  fs.writeFileSync(path.join(repo, 'database', '001_inicial.sql'), 'select 1;\n');
  assert.strictEqual(cierre(repo).codigo, 2);
});

// 🔴 Falla con: ignorar la lista del repo, o leer `fromPacks: false` sin commitear (apagar con un archivo suelto).
test('CiLocal_RepoAddsAndOptsOut (T3) @story-8.322 @ac-3', (t) => {
  conPaquete(t, [{ name: 'Del paquete', run: ['node', '-e', 'process.exit(1)'] }]);
  const propio = { checks: [{ name: 'Del repo', run: ['node', '-e', 'process.exit(3)'] }] };
  const repo = plugin(t, { archivos: { [ci.ARCHIVO_DEL_REPO]: JSON.stringify(propio) } });
  assert.deepStrictEqual(ci.controlesDe(repo).controles.map((c) => [c.nombre, c.origen]), [['Del paquete', 'el paquete acme'], ['Del repo', ci.ARCHIVO_DEL_REPO]]);
  assert.match(cierre(repo).motivo, /«Del paquete»/);
  // apagar los del paquete sin commitear no vale
  fs.writeFileSync(path.join(repo, ci.ARCHIVO_DEL_REPO), JSON.stringify({ ...propio, fromPacks: false }));
  assert.match(cierre(repo).motivo, /«Del paquete»/);
  // sacar el paquete de la lista `packs:` del repo sin commitear tampoco
  fs.writeFileSync(path.join(repo, ci.ARCHIVO_DEL_REPO), JSON.stringify(propio));
  fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), 'packs: []\n');
  assert.match(cierre(repo).motivo, /«Del paquete»/, 'una lista packs: sin commitear apagó los controles del paquete');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'el repo no usa paquetes');
  assert.deepStrictEqual(ci.controlesDe(repo).controles.map((c) => c.nombre), ['Del repo']);
  git(repo, 'rm', '-q', '.tycon/advisors.yaml'); git(repo, 'commit', '-q', '-m', 'vuelve a usar los paquetes');
  // commiteado, sí: corre sólo el del repo, y se dice
  fs.writeFileSync(path.join(repo, ci.ARCHIVO_DEL_REPO), JSON.stringify({ ...propio, fromPacks: false }));
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'apaga los del paquete');
  const r = ci.controlesDe(repo);
  assert.deepStrictEqual(r.controles.map((c) => c.nombre), ['Del repo']);
  assert.deepStrictEqual(r.avisos, [`${path.basename(repo)}: el repo apaga los controles de CI de los paquetes (${ci.ARCHIVO_DEL_REPO}, fromPacks: false)`]);
  assert.match(cierre(repo).motivo, /«Del repo» \(\.tycon\/ci-local-checks\.json\) sale 3 en local/);
});

// 🔴 Falla con: tomar por verde un control que no corre, no termina o está mal escrito.
test('CiLocal_Missing_NotMeasured (T4) @story-8.322 @ac-4', (t) => {
  const casos = [
    [[{ name: 'No existe', run: [path.join(RAIZ, 'scripts', 'ci', 'no-existe.sh')] }], /no medido «No existe» \(el paquete acme\): no terminó \(ENOENT\)/],
    [[{ name: 'Colgado', run: ['node', '-e', 'setTimeout(() => {}, 60000)'], timeoutSeconds: 1 }], /no medido «Colgado» \(el paquete acme\): no terminó \((ETIMEDOUT|SIGTERM)\)/],
    [[{ name: 'Sin run' }], /no medido, los controles de CI en local: el paquete acme: un control «run» no es una lista de palabras/],
    [[{ name: 'Tope', run: ['true'], timeoutSeconds: 9000 }], /«timeoutSeconds» no es un entero de 1 a 600/],
    [[{ name: 'Clave', run: ['true'], si: 'x' }], /trae «si», fuera de name, run, whenFile, timeoutSeconds/],
    ['no es lista', /el paquete acme: «ciLocalChecks» no es una lista/],
  ];
  for (const [controles, motivo] of casos) {
    conPaquete(t, controles);
    const r = cierre(plugin(t));
    assert.strictEqual(r.codigo, 2, `${JSON.stringify(controles)}: pasó`);
    assert.match(r.motivo, motivo);
  }
  // la configuración del repo rota tampoco es «sin controles»
  conPaquete(t, []);
  const roto = plugin(t, { archivos: { [ci.ARCHIVO_DEL_REPO]: '{ roto' } });
  assert.match(cierre(roto).motivo, /no medido, los controles de CI en local: \.tycon\/ci-local-checks\.json no es JSON/);
});

// 🔴 Falla con: un paso 11 que deja pedir la aprobación antes del aviso de «listos», o que sigue diciendo «espera la cola».
test('Step11_Order_DocumentsWait (T12) @story-8.322 @ac-7 @ac-8', () => {
  const paso = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-11-prepare-commit.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(paso, /controles de la CI que se pueden correr en local\*\* \(los declara el paquete del stack en `ciLocalChecks` de su `pack\.json`, y el repo en `\.tycon\/ci-local-checks\.json`, commiteado\)/);
  assert.match(paso, /Un pedido no está listo hasta ver su compilación en verde\.\*\*/);
  assert.match(paso, /No le digas a la persona que el pedido está listo, ni pidas su aprobación, antes del aviso de «listos»/);
  assert.match(paso, /Si un repo con commits de la corrida no tiene su pedido anotado, frena y lo nombra/);
  assert.doesNotMatch(paso, /espera la cola/);
});

// ── la espera de la compilación de cada pedido ─────────────────────────────────────────────────────────────────────
const espera = require(path.join(SCRIPTS, 'lib', 'pr-build-wait.js'));
const PEDIDOS = [{ repo: '/r/backend', nombre: 'backend', numero: 6910, rama: 'story/2.4' }, { repo: '/r/historias', nombre: 'historias', numero: 6911, rama: 'story/2.4' }];
const lectura = (state, stages = []) => ({ ok: true, value: { state, stages } });
/** Una espera con reloj falso: `guion[numero]` es la lista de lecturas de ese pedido, una por vuelta (la última se repite). */
async function esperarCon(guion, { topeMin = 90, cadaS = 60 } = {}) {
  let reloj = 0;
  const vueltas = {};
  const leer = async (p) => { const l = guion[p.numero]; const i = Math.min(vueltas[p.numero] || 0, l.length - 1); vueltas[p.numero] = (vueltas[p.numero] || 0) + 1; return l[i]; };
  const r = await espera.esperar({ pedidos: PEDIDOS, leer, dormir: async (ms) => { reloj += ms; }, ahora: () => reloj, topeMs: topeMin * 60000, cadaMs: cadaS * 1000 });
  return { ...r, minutos: reloj / 60000, vueltas };
}

// 🔴 Falla con: dar «listos» antes de que terminen todas, o con una sola en verde.
test('Wait_AllGreen_Ready (T9) @story-8.322 @ac-8', async () => {
  const r = await esperarCon({ 6910: [lectura('none'), lectura('running'), lectura('succeeded')], 6911: [lectura('succeeded')] });
  assert.strictEqual(r.estado, 'listos');
  assert.strictEqual(r.minutos, 2, 'esperó las vueltas de la que corría');
  assert.strictEqual(r.vueltas[6911], 1, 'una verde no se vuelve a leer');
  assert.strictEqual(espera.texto({ storyId: '2.4', resultado: r }), 'Historia 2.4: pedidos listos para aprobar.\n· #6910 de backend: compilación en verde\n· #6911 de historias: compilación en verde');
});

// 🔴 Falla con: seguir esperando a las demás con una en rojo, o no decir qué etapa falló.
test('Wait_Red_NotReady (T10) @story-8.322 @ac-9', async () => {
  const r = await esperarCon({ 6910: [lectura('running'), lectura('failed', [{ pipeline: 'Backend CI', name: 'Build', result: 'succeeded' }, { pipeline: 'Backend CI', name: 'Package', result: 'failed' }])], 6911: [lectura('running')] });
  assert.strictEqual(r.estado, 'rojo');
  assert.strictEqual(r.minutos, 1, 'con el rojo no espera a las demás');
  const t = espera.texto({ storyId: '2.4', resultado: r });
  assert.strictEqual(t.split('\n')[0], 'Historia 2.4: un pedido tiene la compilación en rojo. No está listo: arreglá el rojo y volvé a empujar.');
  assert.match(t, /· #6910 de backend: compilación en ROJO \(Backend CI · Package\)/);
  assert.doesNotMatch(t, /listos para aprobar/);
  // y el camino corto, con el pedido puesto (8.322 B, AC 9)
  assert.match(t.split('\n').pop(), /^Un rojo chico se arregla sin otra corrida: marker\.js adhoc set --ci-red 6910 --check "<el control que falló>"/);
  // GitHub: la conclusión «failure» de un control
  assert.strictEqual(espera.etapaQueFallo(lectura('failed', [{ pipeline: null, name: 'manifest', result: 'failure' }])), 'manifest');
});

// 🔴 Falla con: tomar el tope o una plataforma que no contesta por verde, o esperar 90 minutos a una plataforma que no existe.
test('Wait_TimeoutOrNoPlatform_NotMeasured (T11) @story-8.322 @ac-10', async () => {
  const tope = await esperarCon({ 6910: [lectura('running')], 6911: [lectura('succeeded')] }, { topeMin: 5, cadaS: 60 });
  assert.strictEqual(tope.estado, 'no-medido');
  assert.ok(tope.minutos <= 5, `esperó ${tope.minutos} min con un tope de 5`);
  assert.match(espera.texto({ storyId: '2.4', resultado: tope }), /· #6910 de backend: corriendo \(pasó el tope de 5 min con la compilación corriendo\)/);
  const sinPlataforma = await esperarCon({ 6910: [{ ok: false, reason: 'sin_plataforma', detail: 'el remoto no es de una plataforma conocida' }], 6911: [lectura('running')] });
  assert.strictEqual(sinPlataforma.estado, 'no-medido');
  assert.strictEqual(sinPlataforma.minutos, 0, 'sin plataforma no se arregla esperando');
  // una lectura que falla de a ratos sigue esperando y puede terminar en verde
  const aRatos = await esperarCon({ 6910: [{ ok: false, reason: 'no_medido', detail: 'az no contestó' }, lectura('succeeded')], 6911: [lectura('succeeded')] });
  assert.strictEqual(aRatos.estado, 'listos');
  // y una que tira no es verde
  const tira = await espera.esperar({ pedidos: PEDIDOS.slice(0, 1), leer: async () => { throw new Error('se cayó'); }, dormir: async () => {}, ahora: (() => { let t = 0; return () => (t += 60000); })(), topeMs: 120000, cadaMs: 60000 });
  assert.strictEqual(tira.estado, 'no-medido');
  assert.match(espera.texto({ storyId: '2.4', resultado: tira }), /no medido \(se cayó; pasó el tope/);
  // sin el commit de la punta no se lee: una compilación de un empuje anterior en verde diría «listo»
  assert.deepStrictEqual(await espera.lectorReal()({ repo: '/r/backend', nombre: 'backend', numero: 6910 }), { ok: false, reason: 'no_medido', detail: 'backend: no sé el commit de la punta del pedido' });
});
