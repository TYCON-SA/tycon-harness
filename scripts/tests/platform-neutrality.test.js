'use strict';
/*
 * platform-neutrality.test.js — lo que sólo es de Azure DevOps vive en su conector, y un candado frena todo comando o
 * dirección de plataforma nuevo en el núcleo (scripts/ci/check-core-neutrality.js).
 *
 * Los dos guiones sólo de Azure DevOps corren desde integrations/azure-devops/scripts/ y siguen frenando en GitHub; el
 * candado cuenta, por archivo, las líneas con los patrones que declaran los conectores (`hardSignals`) y las compara con
 * su lista (scripts/ci/neutrality-allowlist.json); los despliegues y las llaves de integración dan la misma foto que
 * antes de la mudanza. Sin red: az, gh y curl de mentira, y repos de laboratorio.
 *
 * Las fotos de T51 y T52 viven en scripts/tests/fixtures/platform-neutrality/; con TYCON_RECORD_NEUTRALITY=1 se graban
 * de nuevo (sólo antes de tocar lo que fotografían: si no, la foto dejaría de ser la vara).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CONECTOR = path.join(ROOT, 'integrations', 'azure-devops', 'scripts');
const CANDADO = path.join(ROOT, 'scripts', 'ci', 'check-core-neutrality.js');
const LISTA = path.join(ROOT, 'scripts', 'ci', 'neutrality-allowlist.json');
const FOTOS = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'platform-neutrality');
const FAKE_AZ = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-az.sh');
const FAKE_GH = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-gh.js');
const GRABAR = process.env.TYCON_RECORD_NEUTRALITY === '1';
const MUDADOS = ['validate-pipeline-in-ado.sh', 'grant-new-product-permissions.js'];

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

// ── los guiones mudados ─────────────────────────────────────────────────────────────────────────

const TEAM = { version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' }, profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'github', org: 'acme', repo: 'operaciones' } };

/** Un árbol con el perfil vacío y un team-repos.json con la cola en GitHub, una casa vacía y el entorno que los apunta. */
function mundo(raiz = ROOT) {
  const tree = tmp('arbol-');
  const home = tmp('casa-');
  fs.writeFileSync(path.join(tree, 'team-profile.json'), '{}');
  fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify(TEAM));
  const ints = tmp('plataformas-');
  for (const n of ['azure-devops', 'github']) fs.cpSync(path.join(raiz, 'integrations', n), path.join(ints, n), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_INTEGRATIONS_DIR: ints, TYCON_TREE: tree, TYCON_PROFILE: '0' };
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_ORG|PLATFORM|ALLOW_UNSUPPORTED|VALIDATION_.*)$|^ADO_ORG$|^AZURE_DEVOPS_EXT_PAT$|^GH_(TOKEN|REPO|HOST)$|^FAKE_GH_/.test(k)) delete env[k];
  env.TYCON_HOME = path.join(home, '.tycon');
  // curl de mentira: anota si alguien consultó a Azure, y falla
  const bin = tmp('bin-');
  const curl = path.join(bin, 'curl.log');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\necho "$*" >> "${curl}"\nexit 7\n`, { mode: 0o755 });
  env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  return { env, curl };
}
function correrMudado(m, raiz, nombre) {
  const guion = path.join(raiz, 'integrations', 'azure-devops', 'scripts', nombre);
  const args = nombre.endsWith('.sh')
    ? ['bash', [guion, '--project', 'Producto', '--pipeline', '7', '--org', 'https://dev.azure.com/acme']]
    : [process.execPath, [guion, '--project', 'Producto', '--verify']];
  const env = { ...m.env, AZURE_DEVOPS_EXT_PAT: 'de-mentira', TYCON_ADO_ORG: 'acme' };
  const r = spawnSync(args[0], args[1], { cwd: tmp('cwd-'), env, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, curl: fs.existsSync(m.curl) };
}

test('Move_AzureOnlyFiles_UnderIntegrations @story-8.85 @ac-24', () => {
  for (const n of MUDADOS) {
    assert.ok(fs.existsSync(path.join(CONECTOR, n)), `${n} vive en el conector de Azure DevOps`);
    assert.ok(!fs.existsSync(path.join(ROOT, 'scripts', 'ci', n)), `${n} ya no está en scripts/ci/ (no viaja en el artefacto arnes-ci)`);
  }
  // corridos desde el conector, con la cola elegida en GitHub: el freno de sólo Azure sigue (no_soportado, salen 2)
  for (const n of MUDADOS) {
    const r = correrMudado(mundo(), ROOT, n);
    assert.strictEqual(r.code, 2, `${n}: ${r.out}`);
    assert.match(r.out, new RegExp(`no_soportado: ${n.replace(/\./g, '\\.')}: sólo existe en Azure DevOps`), r.out);
    assert.strictEqual(r.curl, false, `${n} no consulta a Azure`);
  }
  // con el freno escondido (un árbol sin scripts/ci/azure-only.js), no pasan callados: no_medido y salen 2
  const copia = tmp('arnes-sin-freno-');
  for (const d of ['scripts', 'integrations']) fs.cpSync(path.join(ROOT, d), path.join(copia, d), { recursive: true, filter: (f) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(f) });
  fs.rmSync(path.join(copia, 'scripts', 'ci', 'azure-only.js'));
  for (const n of MUDADOS) {
    const r = correrMudado(mundo(copia), copia, n);
    assert.strictEqual(r.code, 2, `${n} sin el freno: ${r.out}`);
    assert.match(r.out, /no_medido: /, `${n} sin el freno lo dice: ${r.out}`);
    assert.strictEqual(r.curl, false, `${n} sin el freno no consulta a Azure`);
  }
  // con cualquier vecino que cargan desde la raíz del arnés escondido (el traductor de opciones viejas, la configuración),
  // tampoco pasan callados: no_medido y salen 2, sin consultar a Azure
  for (const vecinos of [['scripts/ci/legacy-options.js', 'scripts/ci/legacy-options.sh'], ['scripts/lib/tycon-config.js']]) {
    const sin = tmp('arnes-sin-vecino-');
    for (const d of ['scripts', 'integrations']) fs.cpSync(path.join(ROOT, d), path.join(sin, d), { recursive: true, filter: (f) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(f) });
    for (const v of vecinos) fs.rmSync(path.join(sin, v));
    for (const n of MUDADOS) {
      const r = correrMudado(mundo(sin), sin, n);
      assert.strictEqual(r.code, 2, `${n} sin ${vecinos.join(' ni ')}: ${r.out}`);
      assert.match(r.out, /no_medido: /, `${n} sin ${vecinos.join(' ni ')} lo dice: ${r.out}`);
      assert.strictEqual(r.curl, false, `${n} sin ${vecinos.join(' ni ')} no consulta a Azure`);
    }
  }
  // las suites que los prueban siguen registradas
  const lista = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'suites.json'), 'utf8'));
  const rutas = [...lista.diarias, ...lista.semanales].map((s) => s.ruta);
  for (const s of ['tests/platform-ci-queue.test.js', 'tests/config-shell-consumers.test.sh', 'tests/platform-neutrality.test.js']) assert.ok(rutas.includes(s), `${s} en suites.json`);
});

test('Move_GrantOptions_OldNamesWithoutMap_UnknownRejected @story-8.85 @ac-24', () => {
  // los nombres viejos de las opciones se traducen sin el mapa de renombres (que no viaja en el público), y una opción
  // que el guion no conoce frena antes de todo: nunca se toma por ausente y sigue a dar permisos
  const correr = (args) => {
    const r = spawnSync(process.execPath, [path.join(CONECTOR, 'grant-new-product-permissions.js'), ...args], { cwd: tmp('cwd-'), env: { ...mundo().env, TYCON_ADO_ORG: 'acme' }, encoding: 'utf8', timeout: 60000 });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const desconocida = correr(['--project', 'Producto', '--no-such-option']);
  assert.strictEqual(desconocida.code, 2, desconocida.out);
  assert.match(desconocida.out, /opción desconocida: --no-such-option/, desconocida.out);
  const vieja = correr(['--project', 'Producto', '--' + 'verifi' + 'car']);
  assert.doesNotMatch(vieja.out, /opción desconocida/, `el nombre viejo de --verify se traduce sin el mapa: ${vieja.out}`);
  assert.match(vieja.out, /no_soportado: grant-new-product-permissions\.js/, vieja.out);
});

// ── el candado ───────────────────────────────────────────────────────────────────────────────────

const git = (repo, args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@ejemplo.example', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@ejemplo.example' } });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
/** Un repo de laboratorio con dos conectores de juguete, la lista del candado y archivos del núcleo; todo en el índice. */
function laboratorio({ lista, archivos = {}, senales } = {}) {
  const repo = tmp('candado-');
  git(repo, ['init', '-q']);
  const poner = (rel, texto) => { const f = path.join(repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, texto); };
  const manifiesto = (name, hardSignals) => JSON.stringify({ name, label: name, kind: 'platform', connector: 'scripts/connector.js', operations: [], hardSignals });
  const s = senales || { 'azure-devops': ['\\baz\\s+(boards|repos|pipelines|devops|rest)\\b', 'dev\\.azure\\.com'], github: ['\\bgh\\s+(pr|api)\\b'] };
  for (const [n, h] of Object.entries(s)) poner(`integrations/${n}/integration.json`, manifiesto(n, h));
  // un manifiesto de horas: sus nombres no son señales de plataforma
  poner('integrations/horas/integration.json', JSON.stringify({ name: 'horas', label: 'Horas', kind: 'timeTracking' }));
  poner('scripts/ci/neutrality-allowlist.json', JSON.stringify(lista || { signals_at_least: 3, entries: [{ path: 'scripts/viejo.js', ceiling: 1, reason: 'el freno lee el comando crudo de la plataforma' }] }));
  // la excepción de horas de un archivo del núcleo: no lo saca del conteo de plataforma
  poner('scripts/ci/tool-names.json', JSON.stringify({ terms_at_least: 0, exceptions: [{ path: 'scripts/horas.js', reason: 'lee la herramienta de horas' }] }));
  poner('scripts/viejo.js', '// lee el comando\nconst c = "az repos pr create";\n');
  poner('scripts/horas.js', '// horas\n');
  poner('scripts/neutro.js', '// nada de plataformas\n');
  // las zonas que no son núcleo: el conector, su guía, las pruebas y sus fotos, el banco y las firmas de controles
  for (const z of ['integrations/azure-devops/scripts/connector.js', 'guides/integrations/ado.md', 'scripts/tests/x.test.js', 'scripts/tests/fixtures/f.json',
    'scripts/controls-bench/cases/hooks/01.json', 'scripts/controls-bench/reviewer-exams/r.json', '.github/control-changes/abc.json', 'otro/test/y.js']) poner(z, 'az boards query\ngh api x\n');
  for (const [rel, texto] of Object.entries(archivos)) poner(rel, texto);
  git(repo, ['add', '-A']);
  return { repo, poner, agregar: () => git(repo, ['add', '-A']) };
}
const candado = (repo, ...extra) => {
  const r = spawnSync(process.execPath, [CANDADO, '--repo', repo, ...extra], { encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

test('Neutrality_Control_BlocksNewName @story-8.85 @ac-25', () => {
  // sin cambios, dentro de la lista: sale 0
  const lab = laboratorio();
  const limpio = candado(lab.repo);
  assert.strictEqual(limpio.code, 0, limpio.out);
  // un comando de plataforma nuevo en el núcleo: frena con el archivo y la línea
  lab.poner('scripts/nuevo.js', '// abre el pedido\nexec("az repos pr create --title x");\n');
  lab.agregar();
  const nuevo = candado(lab.repo);
  assert.strictEqual(nuevo.code, 1, nuevo.out);
  assert.match(nuevo.out, /scripts\/nuevo\.js:2/, nuevo.out);
  // un archivo de la lista que sube su número: frena
  const sube = laboratorio();
  sube.poner('scripts/viejo.js', '// lee el comando\nconst c = "az repos pr create";\nconst d = "https://dev.azure.com/acme";\n');
  sube.agregar();
  const r2 = candado(sube.repo);
  assert.strictEqual(r2.code, 1, r2.out);
  assert.match(r2.out, /scripts\/viejo\.js.*techo/, r2.out);
  // un archivo exceptuado por horas en tool-names.json que suma una señal de plataforma: frena igual
  const horas = laboratorio();
  horas.poner('scripts/horas.js', '// horas\nrun("gh api repos/acme/x");\n');
  horas.agregar();
  const r3 = candado(horas.repo);
  assert.strictEqual(r3.code, 1, r3.out);
  assert.match(r3.out, /scripts\/horas\.js:2/, r3.out);
  // el candado mira el índice: un cambio sin agregar no cuenta todavía
  const sinAgregar = laboratorio();
  sinAgregar.poner('scripts/nuevo.js', 'exec("az repos pr list");\n');
  assert.strictEqual(candado(sinAgregar.repo).code, 0);
  // los manifiestos con menos patrones que el piso: no pudo mirar (sacar un patrón no apaga el candado en silencio)
  const pocos = laboratorio({ senales: { 'azure-devops': ['dev\\.azure\\.com'] } });
  const r4 = candado(pocos.repo);
  assert.strictEqual(r4.code, 2, r4.out);
  assert.match(r4.out, /signals_at_least/, r4.out);
  // un patrón que no compila: no pudo mirar
  const roto = laboratorio({ senales: { 'azure-devops': ['(', 'a', 'b'] } });
  assert.strictEqual(candado(roto.repo).code, 2);
  // el repo de mantenimiento adelgazado, con --skip-thin: no cuenta y lo dice
  const flaco = laboratorio({ archivos: { '.tycon/internal-forms.json': JSON.stringify({ layout: 'thin' }), 'specs/s.md': 'az boards work-item show\n' } });
  const r5 = candado(flaco.repo, '--skip-thin');
  assert.strictEqual(r5.code, 0, r5.out);
  assert.match(r5.out, /SALTEADO/, r5.out);
  assert.strictEqual(candado(flaco.repo).code, 1, 'sin --skip-thin, el árbol adelgazado se cuenta');
  // un repo de juguete con el pre-commit del arnés y sin ninguna integración: nada que contar, aunque no traiga la lista
  const juguete = tmp('juguete-');
  git(juguete, ['init', '-q']);
  fs.mkdirSync(path.join(juguete, 'scripts'));
  fs.writeFileSync(path.join(juguete, 'scripts', 'x.js'), 'run("az repos pr create");\n');
  git(juguete, ['add', '-A']);
  const sinIntegraciones = candado(juguete);
  assert.strictEqual(sinIntegraciones.code, 0, sinIntegraciones.out);
  assert.match(sinIntegraciones.out, /nada que contar/, sinIntegraciones.out);
  // el árbol de verdad, sin el cambio: dentro de la lista
  const real = candado(ROOT);
  assert.strictEqual(real.code, 0, real.out);
});

test('Neutrality_Control_EdgesOfTheTree @story-8.85 @ac-25', () => {
  // un submódulo en el núcleo no es un archivo: no se lee ni frena el commit
  const sub = laboratorio();
  git(sub.repo, ['update-index', '--add', '--cacheinfo', `160000,${'1234567890'.repeat(4)},vendor/sub`]);
  const r1 = candado(sub.repo);
  assert.strictEqual(r1.code, 0, r1.out);
  // los manifiestos son los de primer nivel de integrations/, como los lee el lector de integraciones: una foto de un
  // conector con un manifiesto adentro no suma señales ni rompe el control
  const anidado = laboratorio({ archivos: {
    'integrations/github/tests/fixtures/roto/integration.json': JSON.stringify({ name: 'roto', label: 'roto', kind: 'platform', hardSignals: [''] }),
    'integrations/github/fixtures/x/integration.json': JSON.stringify({ name: 'x', label: 'x', kind: 'platform', hardSignals: ['hola'] }),
    'scripts/saludo.js': '// hola mundo\n',
  } });
  const r2 = candado(anidado.repo);
  assert.strictEqual(r2.code, 0, r2.out);
  // con --repo en una subcarpeta mide el repo entero: no da verde sin contar
  const subcarpeta = laboratorio();
  subcarpeta.poner('scripts/nuevo.js', 'exec("az repos pr create --title x");\n');
  subcarpeta.agregar();
  const r3 = candado(path.join(subcarpeta.repo, 'scripts'));
  assert.strictEqual(r3.code, 1, r3.out);
  assert.match(r3.out, /scripts\/nuevo\.js:1/, r3.out);
  // el piso vale en cualquier árbol que traiga la lista o un manifiesto: la lista sin manifiestos no cuenta como juguete
  const soloLista = tmp('solo-lista-');
  git(soloLista, ['init', '-q']);
  fs.mkdirSync(path.join(soloLista, 'scripts', 'ci'), { recursive: true });
  fs.writeFileSync(path.join(soloLista, 'scripts', 'ci', 'neutrality-allowlist.json'), JSON.stringify({ signals_at_least: 3, entries: [] }));
  fs.writeFileSync(path.join(soloLista, 'scripts', 'x.js'), 'run("az repos pr create");\n');
  git(soloLista, ['add', '-A']);
  const r4 = candado(soloLista);
  assert.strictEqual(r4.code, 2, r4.out);
  assert.match(r4.out, /signals_at_least/, r4.out);
});

test('Neutrality_AssembledTree_OwnPrivateVersionIsNotStale @story-8.85 @ac-25', (t) => {
  // en el árbol armado de los nocturnos, un archivo de la lista con su versión privada no viaja: su entrada la mide el
  // público y no se pide sacarla; una entrada de un archivo que viaja y ya no tiene señales sí se pide
  const { overlayLab } = require('./lib/overlay-lab.js');
  const manifiesto = (name, hardSignals) => JSON.stringify({ name, label: name, kind: 'platform', connector: 'scripts/connector.js', operations: [], hardSignals });
  const armar = (entries) => overlayLab({
    privado: { 'scripts/propio.json': '{ "autor": "nadie" }\n' },
    publico: {
      'integrations/azure-devops/integration.json': manifiesto('azure-devops', ['\\baz\\s+(boards|repos)\\b', 'dev\\.azure\\.com']),
      'integrations/github/integration.json': manifiesto('github', ['\\bgh\\s+(pr|api)\\b']),
      'scripts/ci/neutrality-allowlist.json': JSON.stringify({ signals_at_least: 3, entries }),
      'scripts/viejo.js': 'const c = "az repos pr create";\n',
      'scripts/limpio.js': '// nada\n',
    },
  });
  const base = [{ path: 'scripts/viejo.js', ceiling: 1, reason: 'lee el comando crudo' }, { path: 'scripts/propio.json', ceiling: 1, reason: 'el autor de los pipelines' }];
  const lab = armar(base);
  t.after(lab.cleanup);
  const r = candado(lab.root);
  assert.strictEqual(r.code, 0, r.out);
  const sobra = armar([...base, { path: 'scripts/limpio.js', ceiling: 1, reason: 'ya no nombra nada' }]);
  t.after(sobra.cleanup);
  const r2 = candado(sobra.root);
  assert.strictEqual(r2.code, 1, r2.out);
  assert.match(r2.out, /scripts\/limpio\.js ya no hace falta/, r2.out);
  assert.doesNotMatch(r2.out, /propio\.json/, r2.out);
});

test('Neutrality_Allowlist_EveryEntryHasReason @story-8.85 @ac-25', () => {
  const lista = JSON.parse(fs.readFileSync(LISTA, 'utf8'));
  assert.ok(Number.isInteger(lista.signals_at_least) && lista.signals_at_least >= 1, 'el piso de patrones');
  const vistos = new Set();
  for (const e of lista.entries) {
    assert.match(e.path, /^[^*?[\]{}]+$/, `${e.path}: sin comodines`);
    assert.ok(!e.path.endsWith('/'), `${e.path}: un archivo, no una carpeta`);
    assert.ok(fs.statSync(path.join(ROOT, e.path)).isFile(), `${e.path}: existe y es un archivo`);
    assert.ok(Number.isInteger(e.ceiling) && e.ceiling >= 1, `${e.path}: techo entero ≥ 1`);
    assert.ok(typeof e.reason === 'string' && e.reason.trim().length >= 10, `${e.path}: con su motivo`);
    assert.ok(!vistos.has(e.path), `${e.path}: una sola vez`);
    vistos.add(e.path);
  }
  // en el laboratorio, las entradas mal formadas frenan y un techo que sobra se avisa
  for (const [entrada, motivo] of [
    [{ path: 'scripts/*.js', ceiling: 1, reason: 'con comodín, no vale' }, /comodines/],
    [{ path: 'scripts/', ceiling: 1, reason: 'una carpeta, no vale' }, /carpeta/],
    [{ path: 'scripts/viejo.js', ceiling: 1 }, /sin motivo/],
    [{ path: 'scripts/viejo.js', ceiling: 0, reason: 'techo cero, no vale' }, /techo/],
    [{ path: 'scripts/neutro.js', ceiling: 1, reason: 'ya no tiene señales' }, /ya no hace falta/],
  ]) {
    const base = { path: 'scripts/viejo.js', ceiling: 1, reason: 'el freno lee el comando crudo' };
    const lab = laboratorio({ lista: { signals_at_least: 3, entries: entrada.path === base.path ? [entrada] : [base, entrada] } });
    const r = candado(lab.repo);
    assert.strictEqual(r.code, 1, `${JSON.stringify(entrada)}: ${r.out}`);
    assert.match(r.out, motivo, r.out);
  }
  const sobra = laboratorio({ lista: { signals_at_least: 3, entries: [{ path: 'scripts/viejo.js', ceiling: 3, reason: 'el freno lee el comando crudo' }] } });
  const r = candado(sobra.repo);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /scripts\/viejo\.js.*bajalo/, r.out);
});

// ── las fotos de antes ───────────────────────────────────────────────────────────────────────────

/** Compara con la foto grabada, o la graba con TYCON_RECORD_NEUTRALITY=1. Una foto que falta es rojo, nunca verde. */
function contraLaFoto(t, nombre, valor) {
  const f = path.join(FOTOS, nombre);
  const texto = `${JSON.stringify(valor, null, 2)}\n`;
  if (GRABAR) { fs.mkdirSync(FOTOS, { recursive: true }); fs.writeFileSync(f, texto); t.diagnostic(`foto grabada: ${f}`); return; }
  assert.ok(fs.existsSync(f), `falta la foto ${nombre}: se graba con TYCON_RECORD_NEUTRALITY=1 antes de tocar lo que fotografía`);
  assert.strictEqual(texto, fs.readFileSync(f, 'utf8'), `${nombre} no es la foto de antes`);
}

const HOY = '2026-10-15';
/** La foto de despliegues de un escenario (el de los despliegues de la noche), sin la hora en que se generó. */
function despliegues({ provider, deployments, fixaz = {}, ghState = {} }) {
  const d = tmp('deployments-');
  const fix = path.join(d, 'fixaz');
  fs.mkdirSync(fix);
  for (const [n, v] of Object.entries(fixaz)) fs.writeFileSync(path.join(fix, n), JSON.stringify(v));
  const az = path.join(d, 'az');
  fs.copyFileSync(FAKE_AZ, az);
  fs.chmodSync(az, 0o755);
  const repos = path.join(d, 'repos.json');
  fs.writeFileSync(repos, JSON.stringify({ azure: { org: 'https://dev.azure.com/prueba' }, repos: [{ producto: 'Acme', ado: 'Proy/Back', ruta: 'x', activo: true }] }));
  const ops = path.join(d, 'operations.json');
  fs.writeFileSync(ops, JSON.stringify({ version: 1, owners: { default: 'lider@ejemplo.example' }, deployments: { provider, products: deployments } }));
  const gh = path.join(d, 'gh.json');
  fs.writeFileSync(gh, JSON.stringify({ user: 'bot', ...ghState }));
  const out = path.join(d, 'out');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'nightly', 'deployments', 'deployments.js'), '--today', HOY, '--out', out, '--repos', repos, '--operations', ops, '--org', 'https://dev.azure.com/prueba'], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, FIXAZ: fix, TYCON_ADO_CMD: az, TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: gh, TF_BUILD: '', GH_TOKEN: 'x' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const foto = JSON.parse(fs.readFileSync(path.join(out, `deployments-${HOY}.json`), 'utf8'));
  return JSON.parse(JSON.stringify(foto).replace(/"(generado|generated)[^"]*":"[^"]*",?/g, ''));
}

test('Deployments_Snapshot_Identical @story-8.85 @ac-31', (t) => {
  const stage = (identifier, result, finishTime) => ({ type: 'Stage', identifier, name: `Etapa visible ${identifier}`, state: 'completed', result, startTime: finishTime, finishTime });
  const corrida = { id: 1001, buildNumber: '20261015.1001', status: 'completed', result: 'succeeded', reason: 'individualCI', sourceBranch: 'refs/heads/main',
    sourceVersion: '1001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', queueTime: '2026-10-15T00:00:00.000Z', finishTime: '2026-10-14T11:00:00Z', tags: [] };
  const azure = despliegues({
    provider: 'azure', deployments: { Acme: { production: [{ pipeline: 'Proy/Acme Prod', stages: ['DeployProd'] }] } },
    fixaz: { 'definiciones-Proy.json': [{ id: 2, name: 'Acme Prod' }], 'builds-2.json': [corrida], 'timeline-1001.json': { records: [stage('DeployProd', 'succeeded', '2026-10-14T11:00:00Z')] } },
  });
  const ent = (environment) => ({ repo: 'org/app', environment });
  const github = despliegues({
    provider: 'github', deployments: { Acme: { staging: [ent('nada')], production: [ent('prod')] } },
    ghState: {
      environments: { 'org/app': ['prod'] },
      deployments: { 'org/app': [{ id: 3, sha: 'ccccccc2222', environment: 'prod', created_at: '2026-10-13T00:00:00Z', statuses: [{ id: 30, state: 'success', created_at: '2026-10-13T01:00:00Z' }] }] },
      runs: { 'org/app': [] },
    },
  });
  contraLaFoto(t, 'deployments.json', { azure, github });
});

test('IntegrationsOff_Others_Unchanged @story-8.85 @ac-31', (t) => {
  const TH = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));
  const salida = (config, env = {}) => {
    const home = tmp('casa-');
    if (config) { const f = TH.configFile(home); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(config)); }
    // la llave del buzón de corridas en un lugar que no existe: el árbol armado del privado la trae y el público no
    const base = { ...process.env, HOME: home, USERPROFILE: home, TYCON_MAILBOX_JSON: path.join(home, 'sin-llave.json'), ...env };
    for (const k of Object.keys(base)) if (/^TYCON_(ADO_ORG|PLATFORM|PROFILE|TIME_TRACKING|HOME|MAILBOX|INTEG_.*)$/.test(k) && !(k in env)) delete base[k];
    return ['--json', '--shell'].map((f) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'), 'integrations', f], { encoding: 'utf8', env: { ...base, TYCON_PROFILE: '0' } });
      return { status: r.status, stdout: r.stdout.replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<casa>') };
    });
  };
  contraLaFoto(t, 'integrations.json', {
    vacia: salida(null),
    azure: salida({ ado: { org: 'https://dev.azure.com/acme' } }),
    avisos: salida({ telegram: { chat_id: '1' } }),
  });
});
