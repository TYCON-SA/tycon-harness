#!/usr/bin/env node
'use strict';
// product-lab.test.js — la matriz y los cierres, sobre un producto de prueba de tres repos con fusiones reales.
//
// Las pruebas de cada regla arman el repo justo que esa regla mira, y por eso no ven lo que depende de la forma de un
// producto: historias en un repo, código en otro, ramas `dev` y `main`, fusiones de pedido, copias locales atrasadas. Esta
// suite corre los comandos reales del arnés sobre esa forma. Lo que hoy falla y tiene dueño va en
// product-lab-known-gaps.json: un caso de esa lista que ya anda da rojo y pide sacarlo.
//
// stable-data: ninguna prueba lee el reloj, y los commits del laboratorio llevan fechas fijas (lib/product-lab.js).
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const lab = require('./lib/product-lab.js');

const RAIZ = path.resolve(__dirname, '..', '..');
const LAB = path.join(__dirname, 'lib', 'product-lab.js');
const HUECOS = path.join(__dirname, 'product-lab-known-gaps.json');
const SUITE = 'product-lab.test.js';
const CARPETAS_DE_GUIONES = [path.join('skills', 'tycon-pipeline', 'scripts'), path.join('scripts', 'hooks'), path.join('scripts', 'lib')];

const temporales = [];
function carpeta() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-prueba-')));
  temporales.push(d);
  return d;
}

function huellaDe(raices) {
  const out = {};
  const recorrer = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.isFile()) out[p] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  for (const r of raices) recorrer(r);
  return out;
}

/** Una versión del arnés de juguete: los cuatro guiones, cada uno con el código que se le pase, o ninguno con `null`. */
function juguete(guiones = {}) {
  const dir = carpeta();
  const RUTAS = lab.rutasDeComandos(dir);
  const porDefecto = {
    matriz: 'console.log(JSON.stringify({ green: false, acs: [1], perAc: { 1: { verdict: "NOT-RUN" } }, warnings: [] })); process.exitCode = 1;',
    freno: 'console.error("freno de juguete");',
    guia: 'console.log("qa-guide --check de juguete");',
    retro: 'console.error("retro-pending de juguete");',
  };
  for (const [nombre, ruta] of Object.entries(RUTAS)) {
    const codigo = nombre in guiones ? guiones[nombre] : porDefecto[nombre];
    if (codigo === null) continue;
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(ruta, codigo);
  }
  return dir;
}

function correrUno(id, harness, opciones = {}) {
  const { resultados } = lab.correrCasos({ harness, solo: [id], tmp: carpeta(), ...opciones });
  assert.strictEqual(resultados.length, 1);
  return resultados[0];
}

let reales;
let salidaReal;
let juicio;
let huellaAntes;
let huellaDespues;

before(() => {
  const raices = CARPETAS_DE_GUIONES.map((c) => path.join(RAIZ, c));
  huellaAntes = huellaDe(raices);
  salidaReal = spawnSync(process.execPath, [LAB, '--harness', RAIZ, '--json'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  huellaDespues = huellaDe(raices);
  reales = JSON.parse(salidaReal.stdout).casos;
  juicio = lab.juzgarHuecos(reales, lab.leerHuecos(HUECOS));
});

after(() => { for (const d of temporales) fs.rmSync(d, { recursive: true, force: true }); });

const deCaso = (id) => reales.find((r) => r.id === id);

/** Un caso de la lista: pasa si anda, o si falla por el motivo con que está declarado en la lista de huecos. */
function casoEsperado(nombre, id, ac) {
  test(`${nombre} @story-8.193 @ac-${ac}`, () => {
    const r = deCaso(id);
    assert.ok(r, `el caso ${id} no corrió`);
    const j = juicio.find((x) => x.id === id);
    assert.ok(['pasa', 'conocido'].includes(j.veredicto), `${id}: ${j.veredicto} — ${j.mensaje}`);
  });
}

// ---------------------------------------------------------------- el laboratorio

test('T1 Lab_Arma_TresReposConRemotoYRamas @story-8.193 @ac-1', () => {
  lab.conBase({ tmp: carpeta() }, (base) => {
    assert.deepStrictEqual(Object.keys(base.repos).sort(), ['Lab-Backend', 'Lab-Formularios', 'Lab-Historias']);
    for (const repo of Object.values(base.repos)) {
      assert.match(base.git(repo, ['remote', 'get-url', 'origin']), /\.git$/);
      for (const rama of ['origin/main', 'origin/dev']) assert.ok(base.git(repo, ['rev-parse', rama]));
    }
    const historias = base.repos['Lab-Historias'];
    const yaml = base.git(historias, ['show', 'HEAD:.tycon/advisors.yaml']);
    assert.match(yaml, /companion_repos/);
    const estados = base.git(historias, ['grep', '-h', '^status:', 'HEAD', '--', 'specs']);
    assert.match(estados, /status: done/);
    assert.match(estados, /status: in-progress/);
    // las historias van en una carpeta por tema
    assert.match(base.git(historias, ['ls-files', 'specs']), /^specs\/cobranza\/stories\/0-1-alta\.md$/m);
  });
});

test('Lab_Remotos_SinMantenimientoDeFondo', () => {
  // el lado que recibe un empuje no ve los `-c` del laboratorio: el remoto lo apaga en su propio archivo, que se lee
  // directo (con `-c` de por medio daría `false` aunque faltara)
  lab.conBase({ tmp: carpeta() }, (base) => {
    for (const repo of Object.values(base.repos)) {
      const archivo = path.join(base.git(repo, ['remote', 'get-url', 'origin']), 'config');
      for (const clave of ['receive.autogc', 'maintenance.auto']) {
        assert.strictEqual(base.git(repo, ['config', '--file', archivo, '--get', clave]), 'false', `${clave} en ${path.basename(path.dirname(archivo))}`);
      }
    }
  });
});

test('T2 Lab_Fusion_TieneDosPadres @story-8.193 @ac-1', () => {
  lab.conBase({ tmp: carpeta() }, (base) => {
    const backend = base.repos['Lab-Backend'];
    const fusiones = base.git(backend, ['log', '--merges', '--format=%P|%s', 'origin/main']).split('\n').map((l) => l.split('|'));
    for (const [padres] of fusiones) assert.strictEqual(padres.split(' ').length, 2);
    const asuntos = fusiones.map(([, a]) => a);
    // los dos asuntos de pedido: el que nombra la rama de la historia y el de plataforma, que no la nombra
    assert.ok(asuntos.some((a) => /^Merge pull request \d+ from story\/0\.1-alta into dev$/.test(a)), asuntos.join(' | '));
    assert.ok(asuntos.some((a) => /^Merged PR \d+: .+$/.test(a)), asuntos.join(' | '));
  });
});

test('T3 Lab_DosCorridas_MismosResultados @story-8.193 @ac-2', () => {
  // dos armados de verdad: la base se arma una vez por proceso, así que cada punta sale de un proceso propio
  const puntas = () => {
    const r = spawnSync(process.execPath, ['-e', `const lab = require(${JSON.stringify(LAB)});
console.log(JSON.stringify(lab.conBase({ tmp: ${JSON.stringify(carpeta())} }, (base) => Object.values(base.repos).map((r) => base.git(r, ['rev-parse', 'origin/main'])))));`],
    { encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepStrictEqual(puntas(), puntas());
  const una = correrUno('cambio-real', RAIZ);
  assert.strictEqual(una.estado, deCaso('cambio-real').estado);
  assert.strictEqual(una.motivo, deCaso('cambio-real').motivo);
});

test('T4 Lab_CuatroComandos_SeEjecutanDeVerdad @story-8.193 @ac-3', () => {
  // con una versión de juguete: cada guion deja su marca
  const marcas = path.join(carpeta(), 'marcas');
  const marca = (n, resto) => `require("fs").appendFileSync(${JSON.stringify(marcas)}, "${n}\\n"); ${resto}`;
  const dir = juguete({
    matriz: marca('matriz', 'console.log(JSON.stringify({ green: false, acs: [1], perAc: { 1: { verdict: "NOT-RUN" } }, warnings: [] })); process.exitCode = 1;'),
    freno: marca('freno', 'console.error("freno");'),
    guia: marca('guia', 'console.log("qa-guide --check");'),
    retro: marca('retro', 'console.error("retro-pending");'),
  });
  lab.correrCasos({ harness: dir, solo: ['cambio-real', 'freno-cambio-real', 'hermano-atrasado-guia', 'carpeta-borrada'], tmp: carpeta() });
  const vistas = new Set(fs.readFileSync(marcas, 'utf8').trim().split('\n'));
  assert.deepStrictEqual([...vistas].sort(), ['freno', 'guia', 'matriz', 'retro']);
  // con el arnés real: cada uno deja su firma
  assert.ok(deCaso('cambio-real').detalle.acs.length, 'la matriz no devolvió sus criterios');
  assert.match(deCaso('freno-cambio-real').detalle.salida, /tycon-story-evidence/);
  assert.match(deCaso('hermano-atrasado-guia').detalle.salida, /qa-guide --check/);
  assert.match(deCaso('dev-local-vieja').detalle.registro, /"sha":"[0-9a-f]+"/);
});

test('T5 Lab_Historias_PasanElLint @story-8.193 @ac-4', () => {
  const lint = path.join(RAIZ, 'scripts', 'lib', 'lint-story-frontmatter.js');
  lab.conBase({ tmp: carpeta() }, (base) => {
    const historias = base.repos['Lab-Historias'];
    const archivos = base.git(historias, ['ls-files', '*.md']).split('\n').filter(Boolean);
    assert.ok(archivos.length >= 2, 'el laboratorio no trae historias');
    const r = spawnSync(process.execPath, [lint, ...archivos], { cwd: historias, encoding: 'utf8', env: base.entorno() });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    // la evidencia lleva la línea `v:2` en el registro del repo y en el espejo, con su salida
    const registro = fs.readFileSync(path.join(historias, '.advisors', 'dod-runtime', '0.1-smoke-ledger.jsonl'), 'utf8').trim();
    assert.match(registro, /"v":2/);
    assert.match(registro, /"output_sha":"[0-9a-f]{64}"/);
    assert.ok(fs.readFileSync(base.espejo, 'utf8').includes('"story":"0.1"'), 'falta la línea del espejo');
  });
});

// ---------------------------------------------------------------- los casos

casoEsperado('T6 Caso_FusionPropia', 'fusion-propia', 5);
casoEsperado('T7 Caso_FrenoFusion', 'freno-fusion', 6);
casoEsperado('T8 Caso_CambioReal', 'cambio-real', 7);
casoEsperado('T9 Caso_ChoqueEnLaFusion', 'choque-en-la-fusion', 8);
casoEsperado('T10 Caso_FrenoCambioReal', 'freno-cambio-real', 9);
casoEsperado('T11 Caso_Comillas', 'comillas', 10);
casoEsperado('T12 Caso_NumeroRepetido', 'numero-repetido', 11);
casoEsperado('T13 Caso_ViejaTrasCambioDeRama', 'vieja-tras-cambio-de-rama', 12);
casoEsperado('T14 Caso_MismoRepo', 'mismo-repo', 13);
casoEsperado('T15 Caso_HermanoAtrasadoMatriz', 'hermano-atrasado-matriz', 14);
casoEsperado('T16 Caso_HermanoAtrasadoGuia', 'hermano-atrasado-guia', 15);
casoEsperado('T17 Caso_DevLocalVieja', 'dev-local-vieja', 16);
casoEsperado('T18 Caso_CarpetaBorrada', 'carpeta-borrada', 17);
casoEsperado('T33 Caso_PruebaDeOtraHistoria', 'prueba-de-otra-historia', 34);
casoEsperado('T34 Caso_PruebaDeLaMismaHistoria', 'prueba-de-la-misma-historia', 35);
casoEsperado('T35 Caso_CommitAjenoViejo', 'commit-ajeno-viejo', 36);
casoEsperado('T36 Caso_FusionSinRama', 'fusion-sin-rama', 37);
casoEsperado('T37 Caso_SquashPropio', 'squash-propio', 38);
casoEsperado('T38 Caso_NumeroRepetidoFusion', 'numero-repetido-fusion', 39);
casoEsperado('T39 Caso_RutaRelativaAlHermano', 'ruta-relativa-al-hermano', 40);
casoEsperado('T51 Caso_ComentarioSinSangria', 'comentario-sin-sangria', 41);
casoEsperado('T52 Caso_ListaPartida', 'lista-partida', 42);

// ---------------------------------------------------------------- los huecos conocidos

const hueco = (id, extra = {}) => ({ id, match: '^esperaba', pending: 'una historia', ...extra });

test('T19 Huecos_LosCuatroResultados @story-8.193 @ac-18', () => {
  const r = (id, estado, motivo = '') => ({ id, estado, motivo });
  const j = lab.juzgarHuecos(
    [r('anda', 'ok'), r('conocido', 'falla', 'esperaba verde'), r('otro-motivo', 'falla', 'se rompió'), r('sin-lista', 'falla', 'esperaba verde'), r('ya-anda', 'ok')],
    [hueco('conocido'), hueco('otro-motivo'), hueco('ya-anda')],
  );
  const v = Object.fromEntries(j.map((x) => [x.id, x.veredicto]));
  assert.deepStrictEqual(v, { anda: 'pasa', conocido: 'conocido', 'otro-motivo': 'rojo', 'sin-lista': 'rojo', 'ya-anda': 'sobra' });
  assert.match(j.find((x) => x.id === 'ya-anda').mensaje, /sacalo/);
  // lo no medido nunca es conocido, y un hueco sin caso tampoco pasa
  const k = lab.juzgarHuecos([r('x', 'no-medido', 'sin guion')], [hueco('x'), hueco('fantasma')]);
  assert.strictEqual(k.find((x) => x.id === 'x').veredicto, 'no-medido');
  assert.strictEqual(k.find((x) => x.id === 'fantasma').veredicto, 'sobra');
});

test('T20 Huecos_CadaUnoDiceQuienLoCierra @story-8.193 @ac-18', () => {
  const dir = carpeta();
  const con = (huecos) => { const f = path.join(dir, 'h.json'); fs.writeFileSync(f, JSON.stringify({ gaps: huecos })); return () => lab.leerHuecos(f); };
  assert.throws(con([{ id: 'a', match: 'x' }]), /pending/);
  assert.throws(con([{ id: 'a', pending: 'x' }]), /match/);
  assert.throws(con([{ id: 'a', match: '(', pending: 'x' }]), /match/);
  // la lista real cumple, y cada hueco nombra un caso que existe
  const ids = new Set(lab.CASOS.map((c) => c.id));
  for (const h of lab.leerHuecos(HUECOS)) assert.ok(ids.has(h.id), `hueco sin caso: ${h.id}`);
});

test('Huecos_LaCorridaRealCuadra @story-8.193 @ac-18', () => {
  const malos = juicio.filter((j) => !['pasa', 'conocido'].includes(j.veredicto));
  assert.deepStrictEqual(malos.map((j) => `${j.id}: ${j.veredicto} — ${j.mensaje}`), []);
});

// ---------------------------------------------------------------- comparar versiones

test('T21 Comparar_ConHarness_ImprimeCadaCaso @story-8.193 @ac-19', () => {
  assert.strictEqual(salidaReal.status, 0, salidaReal.stderr);
  assert.deepStrictEqual(reales.map((r) => r.id).sort(), lab.CASOS.map((c) => c.id).sort());
  for (const r of reales) assert.ok(['ok', 'falla'].includes(r.estado), `${r.id}: ${r.estado} — ${r.motivo}`);
});

test('T22 Comparar_NoEscribeAfuera @story-8.193 @ac-19', () => {
  const padre = carpeta();
  const testigo = path.join(padre, 'testigo');
  fs.mkdirSync(testigo);
  correrUno('cambio-real', RAIZ, { tmp: padre });
  assert.deepStrictEqual(fs.readdirSync(testigo), []);
  assert.deepStrictEqual(fs.readdirSync(padre), ['testigo']);
});

test('T49 Lab_NoEscribeEnElArnesRecibido @story-8.193 @ac-19', () => {
  assert.ok(Object.keys(huellaAntes).length > 100, 'no se midieron los guiones');
  assert.deepStrictEqual(huellaDespues, huellaAntes);
});

// ---------------------------------------------------------------- dónde corre

function suitesPublicas() {
  const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'suites.json'), 'utf8'));
  return [...(s.diarias || []), ...(s.semanales || [])].filter((e) => e && e.ruta);
}

test('T23 Suites_RegistradaSinRequisitos @story-8.193 @ac-21 @ac-22', () => {
  for (const nombre of [SUITE, 'compare-matrix.test.js']) {
    const e = suitesPublicas().find((x) => x.ruta === `tests/${nombre}`);
    assert.ok(e, `${nombre} no está en suites.json`);
    assert.strictEqual(e.raiz, 'arnes');
    assert.deepStrictEqual(e.requiere, []);
  }
  // lo que corre la parte de la noche: la suite le toca a uno de los trabajos
  const repartidas = [1, 2, 3, 4, 5].map((i) => {
    const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'ci', 'suites-shard.js'), 'list', '--shard', String(i), '--of', '5', '--skills', path.join(RAIZ, 'skills'), '--scripts', path.join(RAIZ, 'scripts')], { encoding: 'utf8', cwd: RAIZ, maxBuffer: 1 << 26 });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout;
  }).join('\n');
  assert.match(repartidas, /product-lab\.test\.js/);
  assert.match(repartidas, /compare-matrix\.test\.js/);
});

test('T40 Suites_LaColaNoLaSaltea @story-8.193 @ac-21', () => {
  const heavy = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'ci', 'heavy-suites.json'), 'utf8')).suites || {};
  assert.ok(!(SUITE in heavy), 'la suite no va en heavy-suites.json: la cola la saltearía');
  // lo que hace public-ci.sh: pregunta con un cambio ajeno, y saltea sólo lo del grupo `installer`
  const dir = carpeta();
  const cambio = path.join(dir, 'cambio.txt');
  fs.writeFileSync(cambio, 'guides/ajeno.md\n');
  const plan = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'ci', 'suites-for-change.js'), '--suites', path.join(__dirname, 'suites.json'),
    '--scripts', path.join(RAIZ, 'scripts'), '--skills', path.join(RAIZ, 'skills'), '--heavy', path.join(RAIZ, 'scripts', 'ci', 'heavy-suites.json'),
    '--changed', cambio, '--groups-alone'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.strictEqual(plan.status, 0, plan.stderr);
  const salteadas = plan.stdout.split('\n').filter((l) => l.startsWith('SKIP\t')).map((l) => l.split('\t')[1]);
  assert.ok(!salteadas.includes(SUITE), `la cola la saltea: ${salteadas.join(', ')}`);
});

// ---------------------------------------------------------------- la guía

test('T28 Guia_NombraMedidaYCasoNuevo @story-8.193 @ac-26 @ac-27', () => {
  const guia = fs.readFileSync(path.join(RAIZ, 'guides', 'piezas-del-arnes.md'), 'utf8');
  const i = guia.indexOf('\n## scripts/tests/lib/product-lab.js\n');
  assert.ok(i >= 0, 'la guía no tiene la pieza del laboratorio');
  const fin = guia.indexOf('\n## ', i + 1);
  const pieza = guia.slice(i, fin < 0 ? guia.length : fin);
  assert.match(pieza, /compare-matrix\.js/);
  assert.match(pieza, /la medida se corre antes y después, y los totales van en la historia/);
  assert.match(pieza, /suma su caso en el mismo cambio, con nombres inventados/);
  assert.match(fs.readFileSync(path.join(RAIZ, 'INDEX.md'), 'utf8'), /product-lab/);
});

// ---------------------------------------------------------------- modos de falla

test('T29 Lab_SinGuion_NoMedido @story-8.193 @ac-28', () => {
  const dir = juguete({ retro: null });
  const r = correrUno('dev-local-vieja', dir);
  assert.strictEqual(r.estado, 'no-medido');
  assert.match(r.motivo, /retro-pending/);
  const cli = spawnSync(process.execPath, [LAB, '--harness', juguete({ matriz: null, freno: null, guia: null, retro: null }), '--json'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.strictEqual(cli.status, 2);
  for (const args of [['--harness'], ['--harness', '--json']]) {
    const sinValor = spawnSync(process.execPath, [LAB, ...args], { encoding: 'utf8' });
    assert.strictEqual(sinValor.status, 2, args.join(' '));
    assert.strictEqual(sinValor.stdout, '');
  }
});

test('T32 Lab_ComandoColgado_NoMedido @story-8.193 @ac-28', () => {
  const dir = juguete({ matriz: 'setInterval(() => {}, 1000);' });
  const r = correrUno('cambio-real', dir, { topeMs: 1500 });
  assert.strictEqual(r.estado, 'no-medido');
  assert.match(r.motivo, /no terminó/);
  assert.strictEqual(lab.TOPE_MS, 60000);
});

test('T42 Lab_SalidaInesperada_NoMedido @story-8.193 @ac-28', () => {
  const rojo = (extra, salida = 1) => `console.log(JSON.stringify({ green: false, acs: [1], perAc: { 1: { verdict: "NOT-RUN" } }, warnings: [], ...${extra} })); process.exitCode = ${salida};`;
  for (const [nombre, caso, guiones] of [
    ['matriz: JSON roto', 'cambio-real', { matriz: 'console.log("{roto"); process.exitCode = 1;' }],
    ['matriz: sin salida', 'cambio-real', { matriz: 'process.exitCode = 1;' }],
    ['matriz: código desconocido', 'cambio-real', { matriz: rojo('{}', 7) }],
    ['matriz: dice verde y sale 1', 'cambio-real', { matriz: rojo('{ green: true }') }],
    ['matriz: sin criterios', 'cambio-real', { matriz: rojo('{ acs: [] }') }],
    ['freno: código desconocido', 'freno-cambio-real', { freno: 'console.error("x"); process.exitCode = 3;' }],
    ['freno: sin salida', 'freno-cambio-real', { freno: '' }],
    ['guía: sin su resultado', 'hermano-atrasado-guia', { guia: 'console.log("otra cosa");' }],
    ['retro-pending: código desconocido', 'dev-local-vieja', { retro: 'process.exitCode = 5;' }],
  ]) {
    const r = correrUno(caso, juguete(guiones));
    assert.strictEqual(r.estado, 'no-medido', `${nombre}: ${r.estado} — ${r.motivo}`);
  }
});

test('T31 Lab_FallaAMitad_BorraLaCarpeta @story-8.193 @ac-30 @ac-31', () => {
  const home = carpeta();
  const control = carpeta();
  const roto = { id: 'roto', ac: 0, prepara() { throw new Error('a propósito'); }, corre() { return {}; }, juzga() { return { ok: true }; } };
  const vars = { HOME: home, USERPROFILE: home, GIT_DIR: path.join(control, '.git'), GIT_WORK_TREE: control, GIT_INDEX_FILE: path.join(control, 'index') };
  // un caso que falla a la mitad, y un laboratorio que no se puede armar porque no hay git
  const padres = [carpeta(), carpeta()];
  const a = conVariables(vars, () => lab.correrCasos({ harness: RAIZ, tmp: padres[0], casos: [roto] })).resultados[0];
  const b = conVariables({ ...vars, PATH: path.join(control, 'sin-nada') }, () => lab.correrCasos({ harness: RAIZ, tmp: padres[1], solo: ['cambio-real'] })).resultados[0];
  assert.strictEqual(a.estado, 'no-medido');
  assert.match(a.motivo, /a propósito/);
  assert.strictEqual(b.estado, 'no-medido');
  assert.match(b.motivo, /no pude armar el laboratorio/);
  for (const p of padres) assert.deepStrictEqual(fs.readdirSync(p), []);
  assert.deepStrictEqual(fs.readdirSync(home), [], 'escribió en la HOME de quien lo lanza');
  assert.deepStrictEqual(fs.readdirSync(control), [], 'escribió en el repo de las variables de git');
});

const llamar = (cmd, args) => `require("child_process").spawnSync(${JSON.stringify(cmd)}, ${JSON.stringify(args)}); console.log(JSON.stringify({ green: false, acs: [1], perAc: { 1: { verdict: "NOT-RUN" } }, warnings: [] })); process.exitCode = 1;`;

test('T43 Lab_LlamaAzOGh_NoMedido @story-8.193 @ac-31', () => {
  for (const cmd of ['az', 'gh']) {
    const r = correrUno('cambio-real', juguete({ matriz: llamar(cmd, ['repos', 'list']) }));
    assert.strictEqual(r.estado, 'no-medido', cmd);
    assert.match(r.motivo, new RegExp(`\\b${cmd}\\b`));
  }
});

test('T44 Lab_LlamaALaRed_NoMedido @story-8.193 @ac-31', () => {
  const conNode = 'const net = require("net"); let rechazada = false; try { net.connect(443, "ejemplo.invalid"); } catch (_) { rechazada = true; } '
    + 'console.log(JSON.stringify({ green: false, acs: [1], perAc: { 1: { verdict: "NOT-RUN" } }, warnings: [rechazada ? "rechazada" : "abierta"] })); process.exitCode = 1;';
  const a = correrUno('cambio-real', juguete({ matriz: conNode }));
  assert.strictEqual(a.estado, 'no-medido');
  assert.match(a.motivo, /red/);
  const b = correrUno('cambio-real', juguete({ matriz: llamar('git', ['ls-remote', 'https://ejemplo.invalid/x.git']) }));
  assert.strictEqual(b.estado, 'no-medido');
  assert.match(b.motivo, /git/);
  // UDP y nombres: también se anotan y se rechazan
  const resto = 'console.log(JSON.stringify({ green: false, acs: [1], perAc: { 1: { verdict: "NOT-RUN" } }, warnings: [] })); process.exitCode = 1;';
  for (const [nombre, intento, marca] of [
    ['udp', 'try { require("dgram").createSocket("udp4").send("x", 53, "ejemplo.invalid"); } catch (_) {}', /udp/],
    ['dns', 'try { require("dns").lookup("ejemplo.invalid", () => {}); } catch (_) {}', /dns ejemplo\.invalid/],
    ['dns: otra consulta', 'try { require("dns").resolveMx("ejemplo.invalid", () => {}); } catch (_) {}', /dns ejemplo\.invalid/],
    ['dns: al revés', 'try { require("dns").reverse("192.0.2.1", () => {}); } catch (_) {}', /dns 192\.0\.2\.1/],
  ]) {
    const r = correrUno('cambio-real', juguete({ matriz: `${intento} ${resto}` }));
    assert.strictEqual(r.estado, 'no-medido', nombre);
    assert.match(r.motivo, marca, nombre);
  }
  // si la guarda no puede dejar su marca, corta el proceso: el caso no queda medido
  const sinMarca = correrUno('cambio-real', juguete({ matriz: `process.env.LAB_CALLS = "/no/existe/marcas"; try { require("net").connect(443, "ejemplo.invalid"); } catch (_) {} ${resto}` }));
  assert.strictEqual(sinMarca.estado, 'no-medido');
  assert.match(sinMarca.motivo, /salió 86/);
  // un socket local, conectado por su ruta y con devolución de llamada, no es la red
  const local = `const net = require("net"); const ruta = "/tmp/lab-" + process.pid + ".sock";
    const srv = net.createServer((c) => c.end()).listen(ruta, () => {
      const c = new net.Socket(); c.on("error", () => {});
      c.connect(ruta, () => { ${resto} c.destroy(); srv.close(); });
    });`;
  const r = correrUno('cambio-real', juguete({ matriz: local }));
  assert.deepStrictEqual(r.llamadas, [], `${r.estado} — ${r.motivo}`);
  assert.notStrictEqual(r.estado, 'no-medido', r.motivo);
});

const ESTADO = JSON.stringify(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js'));
const RETRO_DE_JUGUETE = (aviso) => `const fs = require("fs"); const path = require("path");
  const d = require(${ESTADO}).stateDir(process.env.HOME); fs.mkdirSync(d, { recursive: true });
  if (process.argv.includes("--mode")) console.log(${JSON.stringify(aviso)});
  else fs.appendFileSync(path.join(d, "retro-pending.jsonl"), JSON.stringify({ sha: "aaaaaaaaaaaa" }) + "\\n");`;

test('T55 Lab_JuecesEstrictos_FallanConElAvisoIncompleto @story-8.193 @ac-5 @ac-7 @ac-17', () => {
  const verdeSinFusion = 'console.log(JSON.stringify({ green: true, acs: [1, 2], perAc: { 1: { verdict: "RUNTIME" }, 2: { verdict: "RUNTIME" } }, warnings: ["se supone que la evidencia corrió sobre esa rama"] }));';
  const rojoSinCommit = 'console.log(JSON.stringify({ green: false, acs: [1, 2], perAc: { 1: { verdict: "NOT-RUN" }, 2: { verdict: "NOT-RUN" } }, warnings: ["Lab-Backend/src/Clientes/ClienteEndpoint.cs cambió después"] })); process.exitCode = 1;';
  for (const [caso, guiones, motivo] of [
    ['fusion-propia', { matriz: verdeSinFusion }, /no nombra la fusión/],
    ['cambio-real', { matriz: rojoSinCommit }, /no nombra/],
    ['carpeta-borrada', { retro: RETRO_DE_JUGUETE('  - <lab>/a @ aaaaaaaaaaaa\n  - <lab>/b @ aaaaaaaaaaaa') }, /2 veces/],
  ]) {
    const r = correrUno(caso, juguete(guiones));
    assert.strictEqual(r.estado, 'falla', `${caso}: ${r.estado} — ${r.motivo}`);
    assert.match(r.motivo, motivo, caso);
  }
  // un aviso sin ningún reclamo no se lee como un conteo: no se midió
  const vacio = correrUno('carpeta-borrada', juguete({ retro: RETRO_DE_JUGUETE('') }));
  assert.strictEqual(vacio.estado, 'no-medido', vacio.motivo);
});

test('T56 Lab_LecturaRota_NoMedido @story-8.193 @ac-28', () => {
  // las marcas de llamadas, cambiadas por una carpeta: no se pueden leer
  const marcasRotas = 'const fs = require("fs"); fs.rmSync(process.env.LAB_CALLS); fs.mkdirSync(process.env.LAB_CALLS); console.log(JSON.stringify({ green: false, acs: [1], perAc: { 1: { verdict: "NOT-RUN" } }, warnings: [] })); process.exitCode = 1;';
  const a = correrUno('cambio-real', juguete({ matriz: marcasRotas }));
  assert.strictEqual(a.estado, 'no-medido');
  assert.match(a.motivo, /no pude leer las marcas/);
  // lo que anotó retro-pending, cambiado por una carpeta
  const registroRoto = `const fs = require("fs"); const path = require("path"); const d = require(${ESTADO}).stateDir(process.env.HOME); fs.mkdirSync(path.join(d, "retro-pending.jsonl"), { recursive: true });`;
  const b = correrUno('dev-local-vieja', juguete({ retro: registroRoto }));
  assert.strictEqual(b.estado, 'no-medido');
  assert.match(b.motivo, /no pude leer lo que anotó retro-pending/);
});

test('T45 Lab_ArnesReal_NoLlamaAzGhNiRed @story-8.193 @ac-31', () => {
  for (const r of reales) assert.deepStrictEqual(r.llamadas, [], `${r.id} llamó afuera`);
});

test('T46 Lab_ClientesDeRed_NoMedido @story-8.193 @ac-31', () => {
  for (const cmd of ['curl', 'python3']) {
    const r = correrUno('cambio-real', juguete({ matriz: llamar(cmd, ['--version']) }));
    assert.strictEqual(r.estado, 'no-medido', cmd);
    assert.match(r.motivo, new RegExp(`\\b${cmd}\\b`));
  }
});

/** Corre `fn` con esas variables puestas en el entorno de esta prueba, y las deja como estaban. */
function conVariables(vars, fn) {
  const antes = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('T47 Lab_EntornoSinCredenciales @story-8.193 @ac-31', () => {
  const volcado = path.join(carpeta(), 'entorno.json');
  const dir = juguete({ matriz: `require("fs").writeFileSync(${JSON.stringify(volcado)}, JSON.stringify(Object.keys(process.env))); console.log(JSON.stringify({ green: false, acs: [1], perAc: { 1: { verdict: "NOT-RUN" } }, warnings: [] })); process.exitCode = 1;` });
  conVariables({ GH_TOKEN: 'prueba', SYSTEM_ACCESSTOKEN: 'prueba', AZURE_DEVOPS_EXT_PAT: 'prueba' }, () => correrUno('cambio-real', dir));
  const vistas = JSON.parse(fs.readFileSync(volcado, 'utf8'));
  for (const k of ['GH_TOKEN', 'SYSTEM_ACCESSTOKEN', 'AZURE_DEVOPS_EXT_PAT']) assert.ok(!vistas.includes(k), `${k} llegó al comando`);
});

test('T48 Lab_ConVariablesDeGit_NoTocaElRepoDelPadre @story-8.193 @ac-31', () => {
  const control = carpeta();
  const fecha = { GIT_AUTHOR_DATE: '1790000000 +0000', GIT_COMMITTER_DATE: '1790000000 +0000', GIT_CONFIG_GLOBAL: os.devNull };
  const g = (args) => spawnSync('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', ...args], { cwd: control, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: control, ...fecha } });
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(control, 'x.txt'), 'x\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'control']);
  const foto = () => [g(['rev-parse', 'HEAD']).stdout, g(['ls-files', '--stage']).stdout, g(['status', '--porcelain']).stdout];
  const antes = foto();
  const r = conVariables({ GIT_DIR: path.join(control, '.git'), GIT_WORK_TREE: control, GIT_INDEX_FILE: path.join(control, '.git', 'index') }, () => correrUno('cambio-real', RAIZ));
  assert.deepStrictEqual(foto(), antes);
  assert.strictEqual(r.estado, deCaso('cambio-real').estado);
  assert.strictEqual(r.motivo, deCaso('cambio-real').motivo);
});

// ---------------------------------------------------------------- la base, una vez por proceso
//
// Cada prueba corre el laboratorio en un proceso hijo propio: la base vive una vez por proceso, y sólo un proceso nuevo
// deja contar cuántas veces se arma. El hijo tiene su TMPDIR (ahí va la plantilla) y un `git` que anota cada llamada.

const GIT_REAL = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

/** Una carpeta con un `git` que anota cada llamada en `registro` y sigue al de verdad; con `fallaEn`, ese subcomando sale 1. */
function gitQueCuenta(registro, { fallaEn } = {}) {
  const dir = carpeta();
  const falla = fallaEn ? `case " $* " in *" ${fallaEn} "*) echo "git ${fallaEn}: falla a propósito" >&2; exit 1 ;; esac\n` : '';
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${registro}'\n${falla}exec '${GIT_REAL}' "$@"\n`, { mode: 0o755 });
  return dir;
}
const cuantas = (registro, sub) => (fs.existsSync(registro)
  ? fs.readFileSync(registro, 'utf8').split('\n').filter((l) => new RegExp(`(^| )${sub}( |$)`).test(l)).length : 0);
/** La misma cuenta, como expresión para el código del hijo: `{ init, clone }` del registro `DATOS.registro` en ese momento. */
const CUENTA_EN_EL_HIJO = `(() => { const l = fs.readFileSync(DATOS.registro, 'utf8').split('\\n');
  const n = (s) => l.filter((x) => new RegExp('(^| )' + s + '( |$)').test(x)).length; return { init: n('init'), clone: n('clone') }; })()`;

/**
 * El guion del hijo: `lab` cargado, y dos casos de juguete que dicen con qué copia, arnés y tope corrieron. Las rutas de
 * cada prueba le llegan en `DATOS`, por el ambiente: el código del hijo no las lleva escritas.
 */
function guionDelHijo(codigo) {
  const guion = path.join(carpeta(), 'hijo.js');
  fs.writeFileSync(guion, `'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const DATOS = JSON.parse(process.env.LAB_DATA || '{}');
delete process.env.LAB_DATA;
const lab = require(${JSON.stringify(LAB)});
const marca = (c) => path.join(c.repos['Lab-Backend'], 'marca.txt');
const casos = [
  { id: 'escribe', ac: 0, prepara(c) { fs.writeFileSync(marca(c), 'x'); return {}; }, corre(c) { return { harness: c.harness, dir: c.dir, topeMs: c.topeMs }; }, juzga() { return { ok: true }; } },
  { id: 'mira', ac: 0, prepara() { return {}; }, corre(c) { return { ve: fs.existsSync(marca(c)), harness: c.harness, dir: c.dir, topeMs: c.topeMs }; },
    juzga(s) { return s.ve ? { ok: false, motivo: 've la marca de otro caso' } : { ok: true }; } },
];
${codigo}
`);
  return guion;
}
const entornoDelHijo = (dirGit, tmpdir, datos) => ({ ...process.env, PATH: `${dirGit}${path.delimiter}${process.env.PATH}`, TMPDIR: tmpdir,
  LAB_DATA: JSON.stringify(datos || {}) });

function hijoLab(codigo, { dirGit, tmpdir, datos }) {
  return spawnSync(process.execPath, [guionDelHijo(codigo)], { encoding: 'utf8', timeout: 180000, env: entornoDelHijo(dirGit, tmpdir, datos) });
}

/** El hijo arma la plantilla, dice «listo» y queda vivo; recibe `senal` en ese momento. Un hijo que no termina da `colgado`. */
function hijoLabVivo(codigo, { dirGit, tmpdir, datos }, senal) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [guionDelHijo(codigo)], { env: entornoDelHijo(dirGit, tmpdir, datos) });
    let out = '';
    let err = '';
    let colgado = false;
    const tope = setTimeout(() => { colgado = true; p.kill('SIGKILL'); }, 120000);
    p.stdout.on('data', (d) => {
      out += d;
      if (senal && /listo/.test(out) && !p.killed) p.kill(senal);
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code, signal) => { clearTimeout(tope); resolve({ code, signal, out, err, colgado }); });
  });
}

test('T57 Lab_Plantilla_SeArmaUnaVezYCadaCasoLaCopia @story-8.230 @ac-6', () => {
  const registro = path.join(carpeta(), 'git.log');
  const tmpdir = carpeta();
  const tmp = carpeta();
  const r = hijoLab(`const primera = lab.correrCasos({ casos, tmp: DATOS.tmp }).resultados;
const tras1 = ${CUENTA_EN_EL_HIJO};
const segunda = lab.correrCasos({ casos, tmp: DATOS.tmp }).resultados;
console.log(JSON.stringify({ llamadas: [primera, segunda], tras1, tras2: ${CUENTA_EN_EL_HIJO} }));`,
  { dirGit: gitQueCuenta(registro), tmpdir, datos: { tmp, registro } });
  assert.strictEqual(r.status, 0, r.stderr);
  const { llamadas, tras1, tras2 } = JSON.parse(r.stdout);
  for (const resultados of llamadas) {
    assert.deepStrictEqual(resultados.map((x) => [x.id, x.estado, x.motivo]), [['escribe', 'ok', ''], ['mira', 'ok', '']]);
    assert.notStrictEqual(resultados[0].detalle.dir, resultados[1].detalle.dir, 'los dos casos corrieron en la misma copia');
  }
  assert.strictEqual(tras1.init, 3, 'la base no armó sus tres repos');
  assert.ok(tras1.clone > 0, 'la base no clonó nada');
  assert.deepStrictEqual(tras2, tras1, 'la segunda llamada volvió a armar los repos');
  assert.deepStrictEqual(fs.readdirSync(tmpdir), [], 'la plantilla quedó en la carpeta temporal al salir');
  assert.deepStrictEqual(fs.readdirSync(tmp), []);
});

test('T58 Lab_Plantilla_FallaGuardada_MismoMotivoSinReintentar @story-8.230 @ac-6', () => {
  const registro = path.join(carpeta(), 'git.log');
  const tmpdir = carpeta();
  const tmp = carpeta();
  const r = hijoLab(`const out = [0, 1].map(() => lab.correrCasos({ casos, tmp: DATOS.tmp }).resultados);
console.log(JSON.stringify({ out, quedan: fs.readdirSync(os.tmpdir()) }));`, { dirGit: gitQueCuenta(registro, { fallaEn: 'init' }), tmpdir, datos: { tmp } });
  assert.strictEqual(r.status, 0, r.stderr);
  const { out, quedan } = JSON.parse(r.stdout);
  const todos = out.flat();
  assert.strictEqual(todos.length, 4);
  for (const x of todos) assert.strictEqual(x.estado, 'no-medido', JSON.stringify(x));
  assert.match(todos[0].motivo, /no pude armar el laboratorio: .*falla a propósito/);
  assert.deepStrictEqual([...new Set(todos.map((x) => x.motivo))], [todos[0].motivo], 'el motivo cambió entre llamadas');
  assert.strictEqual(cuantas(registro, 'init'), 1, 'volvió a intentar armar la base');
  assert.deepStrictEqual(quedan, [], 'la carpeta de la plantilla que falló quedó mientras el proceso seguía vivo');
  assert.deepStrictEqual(fs.readdirSync(tmpdir), []);
});

test('T59 Lab_Plantilla_ClaveEsElPath_LoDeCadaLlamadaNoQuedaGuardado @story-8.230 @ac-6', () => {
  const registro = path.join(carpeta(), 'git.log');
  const tmpdir = carpeta();
  const [ha, hb, ta, tb] = [carpeta(), carpeta(), carpeta(), carpeta()];
  const otro = gitQueCuenta(registro);
  const r = hijoLab(`const reg = DATOS.registro;
const inits = () => fs.readFileSync(reg, 'utf8').split('\\n').filter((l) => / init /.test(' ' + l + ' ')).length;
const a = lab.correrCasos({ casos, harness: DATOS.ha, tmp: DATOS.ta, topeMs: 1111 }).resultados;
const b = lab.correrCasos({ casos, harness: DATOS.hb, tmp: DATOS.tb, topeMs: 2222 }).resultados;
const despuesDeDos = inits();
process.env.PATH = DATOS.otro + path.delimiter + process.env.PATH;
const c = lab.correrCasos({ casos, tmp: DATOS.ta }).resultados;
console.log(JSON.stringify({ a, b, c, despuesDeDos, alFinal: inits() }));`, { dirGit: gitQueCuenta(registro), tmpdir, datos: { registro, ha, hb, ta, tb, otro } });
  assert.strictEqual(r.status, 0, r.stderr);
  const { a, b, c, despuesDeDos, alFinal } = JSON.parse(r.stdout);
  assert.strictEqual(despuesDeDos, 3, 'otro arnés, otro tope u otra carpeta armaron otra base');
  assert.strictEqual(alFinal, 6, 'otro PATH no armó su propia base');
  for (const [res, harness, tmp, topeMs] of [[a, ha, ta, 1111], [b, hb, tb, 2222]]) {
    for (const x of res) {
      assert.strictEqual(x.estado, 'ok', JSON.stringify(x));
      assert.strictEqual(x.detalle.harness, harness, 'el caso corrió con el arnés de otra llamada');
      assert.strictEqual(x.detalle.topeMs, topeMs, 'el caso corrió con el tope de otra llamada');
      assert.ok(x.detalle.dir.startsWith(tmp + path.sep), `la copia no cayó en la carpeta de su llamada: ${x.detalle.dir}`);
    }
  }
  for (const x of c) assert.strictEqual(x.estado, 'ok', JSON.stringify(x));
  assert.deepStrictEqual(fs.readdirSync(tmpdir), []);
});

test('T60 Lab_Plantilla_SeBorraConError_YConSenal @story-8.230 @ac-6', async () => {
  const armarYEsperar = `lab.correrCasos({ casos: [], tmp: DATOS.tmp });\nconsole.log('listo');\nsetInterval(() => {}, 1000);`;
  // un error después de armar: sale 1 y no deja la plantilla
  {
    const tmpdir = carpeta();
    const r = await hijoLabVivo(`lab.correrCasos({ casos: [], tmp: DATOS.tmp });\nthrow new Error('a propósito');`,
      { dirGit: gitQueCuenta(path.join(carpeta(), 'git.log')), tmpdir, datos: { tmp: carpeta() } });
    assert.ok(!r.colgado, 'el hijo no terminó');
    assert.strictEqual(r.code, 1, r.err);
    assert.match(r.err, /a propósito/);
    assert.deepStrictEqual(fs.readdirSync(tmpdir), [], 'con un error quedó la plantilla');
  }
  // cada señal: el hijo termina por esa señal y no deja la plantilla
  for (const senal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const tmpdir = carpeta();
    const r = await hijoLabVivo(armarYEsperar, { dirGit: gitQueCuenta(path.join(carpeta(), 'git.log')), tmpdir, datos: { tmp: carpeta() } }, senal);
    assert.ok(!r.colgado, `${senal}: el hijo no terminó`);
    assert.strictEqual(r.signal, senal, `${senal}: terminó de otra forma (código ${r.code}) ${r.err}`);
    assert.deepStrictEqual(fs.readdirSync(tmpdir), [], `${senal}: quedó la plantilla`);
  }
  // con un manejador propio que sólo anota la señal y sale: la plantilla no se la traga
  {
    const tmpdir = carpeta();
    const anotada = path.join(carpeta(), 'anotada');
    const r = await hijoLabVivo(`process.on('SIGTERM', () => { fs.writeFileSync(DATOS.anotada, 'x'); process.exit(0); });\n${armarYEsperar}`,
      { dirGit: gitQueCuenta(path.join(carpeta(), 'git.log')), tmpdir, datos: { tmp: carpeta(), anotada } }, 'SIGTERM');
    assert.ok(!r.colgado, 'con su propio manejador, el hijo no terminó');
    assert.ok(fs.existsSync(anotada), 'el manejador propio no corrió');
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual(fs.readdirSync(tmpdir), [], 'con un manejador propio quedó la plantilla');
  }
});

test('T62 Lab_Plantilla_FallaConValorVacio_SeRelanza @story-8.230 @ac-6', () => {
  // la prueba con que el pase adversarial lo confirmó: `throw undefined` (o 0, '', null, false) quedaba como armada
  const { plantilla } = require('./lib/template-dir.js');
  const lanza = (fn) => { try { fn(); } catch (e) { return { lanzo: true, e }; } return { lanzo: false }; };
  for (const valor of [undefined, null, 0, '', false]) {
    const p = plantilla('lab-prueba-vacio-', () => { throw valor; });
    for (const intento of [() => p.obtener(), () => p.obtener(), () => p.copiar(path.join(carpeta(), 'd'))]) {
      const r = lanza(intento);
      assert.ok(r.lanzo, `${String(valor)}: no relanzó la falla guardada`);
      assert.strictEqual(r.e, valor, `${String(valor)}: relanzó otra cosa`);
    }
    assert.strictEqual(p.armados, 1, `${String(valor)}: volvió a armar`);
  }
});

test('T61 Lab_ConBase_UnaArmadaYCopiaAislada @story-8.230 @ac-6', () => {
  const registro = path.join(carpeta(), 'git.log');
  const tmpdir = carpeta();
  const tmp = carpeta();
  const r = hijoLab(`const vistos = [];
let tras1;
for (let i = 0; i < 3; i++) lab.conBase({ tmp: DATOS.tmp }, (base) => {
  if (i === 0) tras1 = ${CUENTA_EN_EL_HIJO};
  const back = base.repos['Lab-Backend'];
  vistos.push({ back, ve: base.git(back, ['log', '--format=%s']).includes('propio de la primera') });
  if (i === 0) { fs.writeFileSync(path.join(back, 'propio.txt'), 'x'); base.git(back, ['add', '-A']); base.git(back, ['commit', '-q', '-m', 'propio de la primera']); }
});
const sigue = vistos.map((v) => fs.existsSync(v.back));
const mira = { id: 'mira-propio', ac: 0, prepara() { return {}; }, corre(c) { return { ve: fs.existsSync(path.join(c.repos['Lab-Backend'], 'propio.txt')) }; },
  juzga(s) { return s.ve ? { ok: false, motivo: 've lo de conBase' } : { ok: true }; } };
const caso = lab.correrCasos({ casos: [mira], tmp: DATOS.tmp }).resultados[0];
console.log(JSON.stringify({ vistos, sigue, caso, tras1, alFinal: ${CUENTA_EN_EL_HIJO} }));`, { dirGit: gitQueCuenta(registro), tmpdir, datos: { tmp, registro } });
  assert.strictEqual(r.status, 0, r.stderr);
  const { vistos, sigue, caso, tras1, alFinal } = JSON.parse(r.stdout);
  assert.strictEqual(new Set(vistos.map((v) => v.back)).size, 3, 'dos llamadas recibieron la misma carpeta');
  for (const v of vistos) {
    assert.ok(v.back.startsWith(tmp + path.sep), `conBase no entregó una copia en su carpeta: ${v.back}`);
    assert.strictEqual(v.ve, false, 'una llamada vio el commit de otra');
  }
  assert.deepStrictEqual(sigue, [false, false, false], 'la copia de conBase quedó al volver');
  assert.strictEqual(caso.estado, 'ok', JSON.stringify(caso));
  assert.strictEqual(tras1.init, 3, 'la base no armó sus tres repos');
  // el commit de la primera copia no clona ni arma nada: lo que suma después del primer armado es cero
  assert.deepStrictEqual(alFinal, tras1, 'conBase o correrCasos armaron una base nueva');
  assert.deepStrictEqual(fs.readdirSync(tmpdir), []);
});

