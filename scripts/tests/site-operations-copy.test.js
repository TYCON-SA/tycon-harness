'use strict';
/**
 * Pruebas de scripts/site/operations-copy.js: la copia de lo que el sitio lee del repo de operaciones.
 *
 * El trabajo que copia arma una foto (un tar.gz) con las rutas de `RUTAS` y la sube a un contenedor; el índice
 * (`actual.json`) va al final. El sitio baja el índice, después la foto, comprueba la huella y la abre en una carpeta
 * nueva. Acá el almacenamiento es de juguete: en memoria (registra el orden de lo que se sube) o un servidor HTTP local con
 * la forma de Azure Blob. Nada sale a la red. Nada de nombres reales: acme.
 *
 * Correr: node scripts/tests/site-operations-copy.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const assert = require('node:assert');
const { test } = require('node:test');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const COPIA = require(path.join(ROOT, 'scripts', 'site', 'operations-copy.js'));

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acme-copia-')));
// stable-data: la hora real sólo fecha blobs del almacén en memoria y los plazos se cuentan con el reloj inyectado (T0)
// fechas fijas (el sha sale siempre igual) y sin el mantenimiento automático de git, que tocaría el .git de la prueba
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'acme@acme.example', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'acme@acme.example', GIT_AUTHOR_DATE: '2026-10-17T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-17T12:00:00Z' };
const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Un repo de operaciones de juguete: lo que el sitio lee y cosas que no lee (pipelines, inbox). */
function repoDeJuguete(extra = {}) {
  const d = path.join(tmp(), 'ops');
  fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', d]);
  const archivos = {
    'operations.json': '{"version":1}\n',
    'scripts/nightly/dashboard/sources.json': '{"sources":[]}\n',
    'scripts/nightly/dashboard/declared.json': '{}\n',
    'scripts/nightly/dependencies/repos.json': '{"repos":[]}\n',
    'scripts/ci/product-parity.json': '{}\n',
    'artifacts/tablero-del-arnes.html': '<p>acme</p>\n',
    '.dashboard/controls-bench/banco-2026-10-17.json': '{"ok":true}\n',
    '.dashboard/sdlc-stage-2026-10-17.json': '{}\n',
    'pipelines/acme.yml': 'trigger: none\n',
    'inbox/acme.md': 'no lo lee el sitio\n',
    ...extra,
  };
  for (const [rel, txt] of Object.entries(archivos)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), txt); }
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'acme');
  return d;
}

/** Un almacenamiento en memoria con la forma que usa operations-copy.js; registra cada operación en orden. */
function almacenDeJuguete({ fallaPut = null, inicial = {} } = {}) {
  const blobs = new Map(Object.entries(inicial).map(([k, v]) => [k, { cuerpo: Buffer.from(v.cuerpo || v), modificado: v.modificado || Date.now() }]));
  const ops = [];
  return {
    blobs, ops,
    async get(nombre) { ops.push(['get', nombre]); const b = blobs.get(nombre); return b ? { status: 200, cuerpo: b.cuerpo } : { status: 404, cuerpo: Buffer.alloc(0) }; },
    async put(nombre, cuerpo) { ops.push(['put', nombre]); if (fallaPut && fallaPut(nombre)) return { status: 500 }; blobs.set(nombre, { cuerpo: Buffer.from(cuerpo), modificado: Date.now() }); return { status: 201 }; },
    async list(prefijo) { ops.push(['list', prefijo]); return { status: 200, blobs: [...blobs].filter(([k]) => k.startsWith(prefijo)).map(([name, b]) => ({ name, modificado: b.modificado })) }; },
    async del(nombre) { ops.push(['del', nombre]); blobs.delete(nombre); return { status: 202 }; },
  };
}

const sinLog = () => {};
/** Un .png con su firma: lo que el sitio sirve como logo. */
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 1)]);

test('T5 2.34-Subir_SoloLasRutasDelSitio @story-2.34 @ac-2 — la foto trae sólo lo de RUTAS', async () => {
  // 🔴 rojo: la foto trae pipelines/ o inbox/, que el sitio no muestra.
  const repo = repoDeJuguete();
  const al = almacenDeJuguete();
  const r = await COPIA.subir({ repo, almacen: al, log: sinLog });
  assert.strictEqual(r.ok, true, r.motivo);
  const idx = JSON.parse(al.blobs.get('actual.json').cuerpo);
  const entradas = COPIA.leerFoto(al.blobs.get(`fotos/${idx.commit}.tar.gz`).cuerpo);
  assert.strictEqual(entradas.ok, true, entradas.motivo);
  const nombres = entradas.archivos.map((a) => a.rel).sort();
  assert.ok(nombres.includes('operations.json') && nombres.includes('.dashboard/controls-bench/banco-2026-10-17.json'));
  assert.ok(!nombres.some((n) => /^(pipelines|inbox)\//.test(n)), nombres.join(', '));
  for (const n of nombres) assert.ok(COPIA.RUTAS.some((p) => (p.endsWith('/') ? n.startsWith(p) : n === p)), `${n} no está en RUTAS`);
});

test('T6 2.34-Subir_IndiceAlFinal @story-2.34 @ac-2 @ac-3 — la foto antes que el índice; el índice con commit, hora, huella y versiones', async () => {
  const repo = repoDeJuguete();
  const al = almacenDeJuguete();
  await COPIA.subir({ repo, almacen: al, log: sinLog, ahora: () => Date.parse('2026-10-17T12:00:00Z') });
  const puts = al.ops.filter((o) => o[0] === 'put').map((o) => o[1]);
  assert.deepStrictEqual(puts, [`fotos/${git(repo, 'rev-parse', 'HEAD')}.tar.gz`, 'actual.json']);
  const idx = JSON.parse(al.blobs.get('actual.json').cuerpo);
  assert.strictEqual(idx.commit, git(repo, 'rev-parse', 'HEAD'));
  assert.strictEqual(idx.hora, '2026-10-17T12:00:00.000Z');
  assert.strictEqual(idx.huella, crypto.createHash('sha256').update(al.blobs.get(`fotos/${idx.commit}.tar.gz`).cuerpo).digest('hex'));
  assert.strictEqual(idx.archivos['operations.json'], git(repo, 'rev-parse', 'HEAD:operations.json'));
});

test('T7 2.34-Subir_FallaNoTocaElIndice @story-2.34 @ac-3 — si falla la foto, el índice queda como estaba', async () => {
  const repo = repoDeJuguete();
  const viejo = JSON.stringify({ version: 1, commit: 'a'.repeat(40) });
  const al = almacenDeJuguete({ fallaPut: (n) => n.startsWith('fotos/'), inicial: { 'actual.json': viejo } });
  const r = await COPIA.subir({ repo, almacen: al, log: sinLog });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /foto.*500/);
  assert.strictEqual(al.blobs.get('actual.json').cuerpo.toString(), viejo, 'el índice sigue con la foto anterior');
  assert.ok(!al.ops.some((o) => o[0] === 'put' && o[1] === 'actual.json'));
});

test('T8 2.34-Subir_MismoCommitNoSube @story-2.34 @ac-2 — el índice ya nombra el commit de main: nada se sube', async () => {
  const repo = repoDeJuguete();
  const commit = git(repo, 'rev-parse', 'HEAD');
  // el índice previo con la misma lista de archivos que sale del commit (si la lista cambia, se re-sube: T1 Subir_MismoCommitOtraLista)
  const { indice } = await COPIA.subir({ repo, almacen: null, log: sinLog, dryRun: true });
  // la foto que nombra el índice está: al día (si faltara, se vuelve a subir: A6)
  const al = almacenDeJuguete({ inicial: { 'actual.json': JSON.stringify({ version: 1, commit, archivos: indice.archivos }), [`fotos/${commit}.tar.gz`]: 'x' } });
  const r = await COPIA.subir({ repo, almacen: al, log: sinLog });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.subido, false);
  assert.match(r.motivo, /ya.*al día/);
  assert.ok(!al.ops.some((o) => o[0] === 'put'));
});

test('T9 2.34-Subir_SinEnlacesNiFuera @story-2.34 @ac-2 — un enlace simbólico no entra a la foto, y lo dice', async () => {
  const repo = repoDeJuguete();
  const afuera = path.join(path.dirname(repo), 'secreto.txt');
  fs.writeFileSync(afuera, 'no\n');
  fs.symlinkSync(afuera, path.join(repo, '.dashboard', 'enlace.json'));
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'enlace');
  const avisos = [];
  const al = almacenDeJuguete();
  const r = await COPIA.subir({ repo, almacen: al, log: (l) => avisos.push(l) });
  assert.strictEqual(r.ok, true, r.motivo);
  const idx = JSON.parse(al.blobs.get('actual.json').cuerpo);
  const nombres = COPIA.leerFoto(al.blobs.get(`fotos/${idx.commit}.tar.gz`).cuerpo).archivos.map((a) => a.rel);
  assert.ok(!nombres.includes('.dashboard/enlace.json'));
  assert.ok(avisos.some((l) => /enlace\.json.*enlace/.test(l)), avisos.join(' | '));
});

test('T10 2.34-Subir_BorraLasViejas @story-2.34 @ac-3 — se borran las fotos de más de 7 días, salvo la que nombra el índice', async () => {
  const repo = repoDeJuguete();
  const ahora = Date.parse('2026-10-17T12:00:00Z');
  const dias = (n) => ahora - n * 86400000;
  const al = almacenDeJuguete({ inicial: {
    'fotos/tres.tar.gz': { cuerpo: 'x', modificado: dias(3) }, 'fotos/ocho.tar.gz': { cuerpo: 'x', modificado: dias(8) },
    'fotos/treinta.tar.gz': { cuerpo: 'x', modificado: dias(30) }, 'fotos/indice.tar.gz': { cuerpo: 'x', modificado: dias(9) },
    'actual.json': JSON.stringify({ version: 1, commit: 'indice' }),
  } });
  // con la subida fallada, el índice sigue nombrando «indice»: el borrado igual no la toca
  const r = await COPIA.borrarViejas({ almacen: al, ahora: () => ahora, log: sinLog });
  assert.deepStrictEqual(r.borradas.sort(), ['fotos/ocho.tar.gz', 'fotos/treinta.tar.gz']);
  assert.ok(al.blobs.has('fotos/indice.tar.gz') && al.blobs.has('fotos/tres.tar.gz'));
  void repo;
});

test('T11 2.34-Lista_IgualALasLecturas @story-2.34 @ac-5 — RUTAS cubre lo que leen sources.js y la pestaña Configuración', () => {
  // 🔴 rojo: una lectura nueva del sitio (un archivo del clon) que la lista no trae.
  const fuente = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'sources.js'), 'utf8');
  const leidas = new Set();
  for (const m of fuente.matchAll(/(?:jsonDelClon|delClon)\(([^)]*)\)/g)) {
    const partes = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    if (partes.length) leidas.add(partes.join('/'));
  }
  if (/path\.join\(clon,\s*'operations\.json'\)/.test(fuente)) leidas.add('operations.json');
  if (/'\.dashboard'/.test(fuente)) leidas.add('.dashboard/');
  const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
  for (const s of ORG.SECCIONES.filter((x) => x.repo === 'operaciones')) leidas.add(s.archivo);
  assert.ok(leidas.size >= 7, `pocas lecturas encontradas: ${[...leidas].join(', ')}`);
  const cubre = (r) => COPIA.RUTAS.some((p) => (p.endsWith('/') ? r.startsWith(p) || r === p : r === p));
  assert.deepStrictEqual([...leidas].filter((r) => !cubre(r)), [], 'lecturas que la copia no trae');
  // la lectura del logo vive en server.js (logo()): el archivo que declara site.brand.logo, de la carpeta de operaciones.
  // No está en RUTAS (la ruta la elige cada organización): la copia tiene que traer el que declara operations.json.
  const servidor = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'server.js'), 'utf8');
  assert.match(servidor, /site\.brand\.logo/, 'server.js dejó de leer site.brand.logo: actualizar esta prueba');
  assert.match(servidor, /operaciones\.dir/, 'server.js dejó de leer el logo de la carpeta de operaciones: actualizar esta prueba');
  const repo = repoDeJuguete({ 'operations.json': '{"version":1,"site":{"brand":{"logo":"marca/acme.png"}}}\n', 'marca/acme.png': PNG });
  const foto = COPIA.leerFoto(COPIA.armarFoto(COPIA.juntar(repo).archivos));
  assert.ok(foto.ok, foto.motivo);
  assert.ok(foto.archivos.some((a) => a.rel === 'marca/acme.png'), 'la lectura del logo: la copia no lo trae');
});

// ── bajar ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function conFotoSubida() {
  const repo = repoDeJuguete();
  const al = almacenDeJuguete();
  await COPIA.subir({ repo, almacen: al, log: sinLog });
  return { repo, al, idx: JSON.parse(al.blobs.get('actual.json').cuerpo) };
}

test('T13 2.34-Bajar_MismoCommitNoBaja @story-2.34 @ac-6 — el índice no cambió: no baja la foto', async () => {
  const { al, idx } = await conFotoSubida();
  const dir = tmp();
  const a = await COPIA.bajar({ almacen: al, dir, previo: null, log: sinLog });
  assert.strictEqual(a.ok, true, a.motivo);
  assert.ok(fs.existsSync(path.join(a.carpeta, 'operations.json')));
  al.ops.length = 0;
  const b = await COPIA.bajar({ almacen: al, dir, previo: { commit: idx.commit, huella: idx.huella, carpeta: a.carpeta }, log: sinLog });
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.cambio, false);
  assert.deepStrictEqual(al.ops, [['get', 'actual.json']], 'sólo el índice');
});

test('Bajar_PodaLasCopiasViejas — tras un reinicio (sin «previo») la carpeta guarda sólo las últimas; lo reciente y lo ajeno no se tocan', async () => {
  // 🔴 rojo: sin la poda, cada arranque del sitio deja la copia anterior en el disco de datos (cuál era sólo lo sabe la
  //    memoria del proceso), el disco se llena y el sitio deja de leer la configuración.
  const { al, idx } = await conFotoSubida();
  const dir = tmp();
  const ahora = Date.now();
  const hace = (min) => new Date(ahora - min * 60000);
  const copia = (sufijo, min) => { const c = path.join(dir, `copia-${'a'.repeat(12)}-${sufijo}`); fs.mkdirSync(c); fs.writeFileSync(path.join(c, 'operations.json'), '{}'); fs.utimesSync(c, hace(min), hace(min)); return c; };
  const viejas = ['000001', '000002', '000003', '000004', '000005'].map((s, i) => copia(s, 120 + i * 60));
  const reciente = copia('00000a', 5);          // otra réplica puede estar leyéndola: dentro de la hora de gracia
  const abriendo = path.join(dir, '.abriendo-zzz'); fs.mkdirSync(abriendo); fs.utimesSync(abriendo, hace(180), hace(180));
  const abriendoAhora = path.join(dir, '.abriendo-yyy'); fs.mkdirSync(abriendoAhora);
  const ajeno = path.join(dir, 'otra-cosa'); fs.mkdirSync(ajeno); fs.utimesSync(ajeno, hace(600), hace(600));
  const lineas = [];
  const r = await COPIA.bajar({ almacen: al, dir, previo: null, log: (l) => lineas.push(l), opcionesPoda: { demoraMs: 0, pausaMs: 0 } });
  assert.strictEqual(r.ok, true, r.motivo);
  await r.poda;
  const quedan = fs.readdirSync(dir).sort();
  // se quedan: la abierta, las dos más nuevas de las otras (la reciente y la vieja más nueva), lo que se está abriendo
  // ahora y lo que no es una copia
  assert.deepStrictEqual(quedan, [path.basename(abriendoAhora), path.basename(r.carpeta), path.basename(reciente), path.basename(viejas[0]), path.basename(ajeno)].sort());
  assert.ok(lineas.some((l) => /borradas 5 carpeta\(s\) viejas de la copia/.test(l)), lineas.join('\n'));
  // otro reinicio con el mismo commit: abre otra y la carpeta sigue acotada
  const r2 = await COPIA.bajar({ almacen: al, dir, previo: null, log: sinLog, opcionesPoda: { demoraMs: 0, pausaMs: 0 } });
  assert.strictEqual(r2.ok, true, r2.motivo);
  await r2.poda;
  // quedan la nueva, la anterior (dentro de la gracia) y la reciente; la vieja queda cuarta y se borra
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => /^copia-/.test(n)).sort(), [path.basename(r2.carpeta), path.basename(r.carpeta), path.basename(reciente)].sort());
  // sin cambio de commit también poda (un sitio que no se reinicia ni recibe commits nuevos no acumula)
  copia('000009', 300);
  const r3 = await COPIA.bajar({ almacen: al, dir, previo: { commit: idx.commit, huella: idx.huella, carpeta: r2.carpeta }, log: sinLog, opcionesPoda: { demoraMs: 0, pausaMs: 0 } });
  assert.strictEqual(r3.cambio, false);
  await r3.poda;
  assert.ok(!fs.existsSync(path.join(dir, `copia-${'a'.repeat(12)}-000009`)), 'la vieja de más, borrada aunque no haya foto nueva');
});

test('PodarCopias_SinCarpetaOIlegible_NoFalla — una carpeta que no existe o no se lista no frena la bajada', async () => {
  const lineas = [];
  assert.deepStrictEqual((await COPIA.podarCopias({ dir: path.join(tmp(), 'no-existe'), actual: null, log: (l) => lineas.push(l) })).borradas, []);
  assert.deepStrictEqual(lineas, [], 'que no exista no es un problema');
  // un archivo donde va la carpeta: no se lista, lo dice y sigue
  const archivo = path.join(tmp(), 'es-un-archivo'); fs.writeFileSync(archivo, 'x');
  assert.deepStrictEqual((await COPIA.podarCopias({ dir: archivo, actual: null, log: (l) => lineas.push(l) })).borradas, []);
  assert.ok(lineas.some((l) => /no se pudo listar .* para borrar las copias viejas \(ENOTDIR\)/.test(l)), lineas.join('\n'));
});

test('Bajar_PodaDeFondo_NoBloquea — bajar vuelve sin esperar la poda; la poda empieza después de su demora', async () => {
  // 🔴 rojo: la poda corre dentro de la bajada; borrar miles de archivos de un disco compartido traba al servidor que
  //    arranca y vence sus pruebas de disponibilidad.
  const { al } = await conFotoSubida();
  const dir = tmp();
  const hace = new Date(Date.now() - 300 * 60000);
  const viejas = ['000001', '000002', '000003', '000004'].map((s) => { const c = path.join(dir, `copia-${'b'.repeat(12)}-${s}`); fs.mkdirSync(c); fs.utimesSync(c, hace, hace); return c; });
  const r = await COPIA.bajar({ almacen: al, dir, previo: null, log: sinLog, opcionesPoda: { demoraMs: 200, pausaMs: 0 } });
  assert.strictEqual(r.ok, true, r.motivo);
  assert.ok(viejas.every((c) => fs.existsSync(c)), 'al volver de bajar, nada borrado todavía');
  assert.strictEqual(COPIA.programarPoda({ dir, actual: r.carpeta }), r.poda, 'una a la vez: pedir otra devuelve la que ya está en curso');
  const p = await r.poda;
  assert.deepStrictEqual(p.borradas.sort(), viejas.slice(2).map((c) => path.basename(c)).sort(), 'quedan la abierta y las dos más nuevas');
});

test('PodarCopias_PorPartes_TopePorPasada — una pasada borra hasta el tope, de a una con pausa, y dice cuántas quedan', async () => {
  const dir = tmp();
  const hace = new Date(Date.now() - 300 * 60000);
  for (let i = 0; i < 15; i++) { const c = path.join(dir, `copia-${'c'.repeat(12)}-${String(i).padStart(6, '0')}`); fs.mkdirSync(c); fs.utimesSync(c, hace, hace); }
  const lineas = [];
  const t0 = Date.now();
  const p = await COPIA.podarCopias({ dir, actual: null, log: (l) => lineas.push(l), tope: 5, pausaMs: 20, conservar: 3 });
  assert.strictEqual(p.borradas.length, 5, 'hasta el tope');
  assert.strictEqual(p.quedan, 7, '15 - 3 que se conservan - 5 borradas');
  assert.ok(Date.now() - t0 >= 4 * 20 - 10, 'con la pausa entre carpeta y carpeta');
  assert.ok(lineas.some((l) => /borradas 5 carpeta\(s\) viejas de la copia; quedan 7 para la próxima pasada/.test(l)), lineas.join('\n'));
  // la carpeta que este proceso dejó de usar se borra sin esperar la gracia
  const previo = path.join(dir, `copia-${'d'.repeat(12)}-000001`); fs.mkdirSync(previo);
  const q = await COPIA.podarCopias({ dir, actual: null, previo, log: sinLog, tope: 1, pausaMs: 0 });
  assert.deepStrictEqual(q.borradas, [path.basename(previo)], 'la anterior primero');
  // una «anterior» fuera de la carpeta de copias no se toca
  const afuera = path.join(tmp(), `copia-${'e'.repeat(12)}-000001`); fs.mkdirSync(afuera);
  await COPIA.podarCopias({ dir, actual: null, previo: afuera, log: sinLog, tope: 50, pausaMs: 0 });
  assert.ok(fs.existsSync(afuera), 'la de afuera sigue');
});

test('ProgramarPoda_SiFalla_LoDiceYLibera — una poda que falla se registra, no rechaza y deja programar la siguiente', async () => {
  const dir = tmp();
  const lineas = [];
  const p = COPIA.programarPoda({ dir, demoraMs: 0, log: (l) => lineas.push(l), ahora: () => { throw new Error('reloj roto'); } });
  assert.deepStrictEqual(await p, { borradas: [], quedan: 0 });
  assert.ok(lineas.some((l) => /la poda de copias viejas falló \(reloj roto\); queda para la próxima/.test(l)), lineas.join('\n'));
  assert.notStrictEqual(COPIA.programarPoda({ dir, demoraMs: 0, log: sinLog }), p, 'la carpeta quedó libre para otra poda');
  await COPIA.podaPendiente(dir);
  // un registro que falla tampoco la deja rechazada
  assert.deepStrictEqual(await COPIA.programarPoda({ dir, demoraMs: 0, log: () => { throw new Error('sin registro'); }, ahora: () => { throw new Error('reloj roto'); } }), { borradas: [], quedan: 0 });
  // una segunda pedida mientras hay una en curso lo dice, y devuelve la que ya está
  const enCurso = COPIA.programarPoda({ dir, demoraMs: 50, log: sinLog });
  const otra = [];
  assert.strictEqual(COPIA.programarPoda({ dir, previo: path.join(dir, 'copia-aaaaaaaaaaaa-000001'), log: (l) => otra.push(l) }), enCurso);
  assert.ok(otra.some((l) => /ya hay una poda en curso; la carpeta anterior queda para la próxima pasada/.test(l)), otra.join('\n'));
  await enCurso;
});

test('T14 2.34-Bajar_HuellaDistinta @story-2.34 @ac-8 — una foto con otra huella no se abre', async () => {
  const { al, idx } = await conFotoSubida();
  al.blobs.set('actual.json', { cuerpo: Buffer.from(JSON.stringify({ ...idx, huella: '0'.repeat(64) })), modificado: Date.now() });
  const dir = tmp();
  const r = await COPIA.bajar({ almacen: al, dir, previo: null, log: sinLog });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.codigo, 'ilegible');
  assert.match(r.motivo, /huella/);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'nada abierto');
});

/** Una foto armada a mano con entradas que el sitio tiene que rechazar. */
function fotoCon(entradas) {
  const bloques = [];
  for (const e of entradas) {
    const h = Buffer.alloc(512);
    h.write(e.nombre, 0, 100, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    const datos = Buffer.from(e.datos || '');
    h.write(datos.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write(e.tipo || '0', 156);
    if (e.enlace) h.write(e.enlace, 157, 100, 'utf8');
    h.write('ustar\0', 257); h.write('00', 263);
    h.fill(' ', 148, 156);
    let suma = 0; for (const b of h) suma += b;
    h.write(suma.toString(8).padStart(6, '0') + '\0 ', 148);
    bloques.push(h, datos, Buffer.alloc((512 - (datos.length % 512)) % 512));
  }
  bloques.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(bloques));
}

test('T15 2.34-Bajar_FotoConEnlaceOFuera @story-2.34 @ac-8 — una foto con un enlace o con «../» no se abre', async () => {
  for (const [que, entrada] of [['enlace', { nombre: '.dashboard/x.json', tipo: '2', enlace: '/etc/passwd' }], ['fuera', { nombre: '../fuera.json', datos: '{}' }], ['absoluta', { nombre: '/tmp/abs.json', datos: '{}' }]]) {
    const foto = fotoCon([{ nombre: 'operations.json', datos: '{}' }, entrada]);
    const huella = crypto.createHash('sha256').update(foto).digest('hex');
    const al = almacenDeJuguete({ inicial: { 'actual.json': JSON.stringify({ version: 1, commit: 'c'.repeat(40), hora: new Date().toISOString(), huella, archivos: {} }), [`fotos/${'c'.repeat(40)}.tar.gz`]: foto } });
    const dir = tmp();
    const r = await COPIA.bajar({ almacen: al, dir, previo: null, log: sinLog });
    assert.strictEqual(r.ok, false, que);
    assert.strictEqual(r.codigo, 'ilegible', que);
    assert.deepStrictEqual(fs.readdirSync(dir), [], `${que}: nada abierto`);
    assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'fuera.json')), `${que}: nada escrito afuera`);
  }
});

test('T16 2.34-Bajar_CodigosDeFalla @story-2.34 @ac-8 — sin índice, 403, sin red e índice ilegible, con su código', async () => {
  const casos = [
    ['sin_foto', { async get() { return { status: 404 }; } }],
    ['sin_permiso', { async get() { return { status: 403 }; } }],
    ['sin_red', { async get() { return { error: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }; } }],
    ['ilegible', { async get() { return { status: 200, cuerpo: Buffer.from('{roto') }; } }],
  ];
  for (const [codigo, almacen] of casos) {
    const r = await COPIA.bajar({ almacen, dir: tmp(), previo: null, log: sinLog });
    assert.strictEqual(r.ok, false, codigo);
    assert.strictEqual(r.codigo, codigo);
  }
});

test('T16b 2.34-Almacen_FormaDeAzureBlob @story-2.34 @ac-7 @ac-8 — subir y bajar contra un servidor con la forma de Azure Blob, con la credencial en la cabecera', async () => {
  // el adaptador real (HTTP): PUT de un blob, GET, listado y borrado; el token va como Bearer y la SAS en la consulta
  const blobs = new Map();
  const vistos = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    vistos.push({ metodo: req.method, ruta: u.pathname, auth: req.headers.authorization || null, sas: u.searchParams.get('sig') });
    const nombre = decodeURIComponent(u.pathname.replace(/^\/acmecopia\/copia\/?/, ''));
    const trozos = [];
    req.on('data', (c) => trozos.push(c));
    req.on('end', () => {
      if (req.method === 'PUT') { blobs.set(nombre, { cuerpo: Buffer.concat(trozos), modificado: new Date() }); res.writeHead(201); return res.end(); }
      if (req.method === 'DELETE') { blobs.delete(nombre); res.writeHead(202); return res.end(); }
      if (u.searchParams.get('comp') === 'list') {
        const pre = u.searchParams.get('prefix') || '';
        const xml = `<?xml version="1.0"?><EnumerationResults><Blobs>${[...blobs].filter(([k]) => k.startsWith(pre)).map(([k, b]) => `<Blob><Name>${k}</Name><Properties><Last-Modified>${b.modificado.toUTCString()}</Last-Modified></Properties></Blob>`).join('')}</Blobs><NextMarker/></EnumerationResults>`;
        res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(xml);
      }
      const b = blobs.get(nombre);
      if (!b) { res.writeHead(404); return res.end(); }
      res.writeHead(200); return res.end(b.cuerpo);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const urlBase = `http://127.0.0.1:${srv.address().port}`;
    const escritura = require(path.join(ROOT, 'scripts', 'site', 'cloud', 'azure.js')).almacenDeCopia({ cuenta: 'acmecopia', contenedor: 'copia', credencial: { token: 'tok-acme' }, urlBase });
    const repo = repoDeJuguete();
    const s = await COPIA.subir({ repo, almacen: escritura, log: sinLog });
    assert.strictEqual(s.ok, true, s.motivo);
    assert.ok(vistos.filter((v) => v.metodo === 'PUT').every((v) => v.auth === 'Bearer tok-acme'));
    const lectura = require(path.join(ROOT, 'scripts', 'site', 'cloud', 'azure.js')).almacenDeCopia({ cuenta: 'acmecopia', contenedor: 'copia', credencial: { sas: 'sv=2022-11-02&sr=c&sp=rl&si=lectura&sig=abc' }, urlBase });
    const desde = vistos.length;
    const b = await COPIA.bajar({ almacen: lectura, dir: tmp(), previo: null, log: sinLog });
    assert.strictEqual(b.ok, true, b.motivo);
    assert.strictEqual(fs.readFileSync(path.join(b.carpeta, 'operations.json'), 'utf8'), '{"version":1}\n');
    const deLaBajada = vistos.slice(desde);
    assert.ok(deLaBajada.length === 2 && deLaBajada.every((v) => v.metodo === 'GET' && v.sas === 'abc' && v.auth === null), `con la SAS, sin cabecera: ${JSON.stringify(deLaBajada)}`);
  } finally { srv.close(); }
});

// ── el sitio con la copia (T12, T17) ────────────────────────────────────────────────────────────────────────────
const H = require('./lib/site-harness.js');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const { crearFuentes } = require(path.join(ROOT, 'scripts', 'site', 'sources.js'));
const { validarConfiguracion } = require(path.join(ROOT, 'scripts', 'site', 'server.js'));
const OPS_VALIDO = '{"version":1,"owners":{"default":"lead@acme.example"},"site":{"maintainers":["lead@acme.example"]}}\n';
const HORA = 3600000;
const T0 = Date.parse('2026-10-17T12:00:00Z');
function fuentesConCopia(almacen, ahora) {
  const env = H.envBase({ SITE_OPERATIONS_SOURCE: 'copy', SITE_OPERATIONS_COPY: 'acmeops/copia' });
  delete env.SITE_OPERATIONS_TOKEN;
  const v = validarConfiguracion(env);
  assert.ok(v.ok, JSON.stringify(v.problemas));
  const dataDir = tmp();
  return { dataDir, f: crearFuentes({ cfg: v.cfg, dataDir, log: sinLog, ahora, almacenCopia: almacen, opcionesPodaCopia: { demoraMs: 0, pausaMs: 0 } }) };
}

test('T12 2.34-Bajar_CambiaDeUnaVez @story-2.34 @ac-6 — el sitio cambia de foto entera, nunca una mezcla', async () => {
  // 🔴 rojo: el sitio lee una carpeta a medio escribir, con archivos de dos commits.
  const repo = repoDeJuguete({ 'operations.json': OPS_VALIDO, '.dashboard/viejo.json': '{}\n' });
  const al = almacenDeJuguete();
  assert.strictEqual((await COPIA.subir({ repo, almacen: al, log: sinLog })).ok, true);
  const { dataDir, f } = fuentesConCopia(al, () => T0);
  try {
    await f.refrescar();
    const primera = f.clones().operaciones.dir;
    assert.ok(fs.existsSync(path.join(primera, '.dashboard', 'viejo.json')));
    fs.rmSync(path.join(repo, '.dashboard', 'viejo.json'));
    fs.writeFileSync(path.join(repo, '.dashboard', 'nuevo.json'), '{}\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'cambio');
    assert.strictEqual((await COPIA.subir({ repo, almacen: al, log: sinLog })).subido, true);
    await f.refrescar();
    const segunda = f.clones().operaciones.dir;
    assert.notStrictEqual(segunda, primera, 'otra carpeta');
    // la foto se abre en el disco del contenedor, no en SITE_DATA_DIR (un disco compartido lento en la nube)
    assert.ok(!segunda.startsWith(dataDir) && !fs.existsSync(path.join(dataDir, 'operaciones-copia')), 'nada en el disco de datos');
    await COPIA.podaPendiente(path.dirname(segunda));
    assert.ok(!fs.existsSync(primera), 'la anterior se borró después del cambio (de fondo)');
    assert.ok(fs.existsSync(path.join(segunda, '.dashboard', 'nuevo.json')) && !fs.existsSync(path.join(segunda, '.dashboard', 'viejo.json')), 'sólo los archivos del commit nuevo');
    assert.strictEqual(f.clones().operaciones.indice.commit, git(repo, 'rev-parse', 'HEAD'));
    const sueltas = fs.readdirSync(path.dirname(segunda));
    assert.deepStrictEqual(sueltas, [path.basename(segunda)], 'ninguna carpeta a medio abrir ni vieja');
    assert.strictEqual(f.estado().cargado, true);
    assert.strictEqual(f.config().site.maintainers[0], 'lead@acme.example');
  } finally { f.detener(); }
});

test('Fuentes_FotoEnDiscoLocal_PodaLasViejasDelDiscoDeDatos — la foto se abre fuera del disco de datos, y las copias que quedaron ahí se borran de fondo', async () => {
  // 🔴 rojo: la foto se escribe en SITE_DATA_DIR (archivo por archivo sobre un disco compartido, ~55 s en un arranque en
  //    frío), o las copias que versiones anteriores dejaron ahí quedan para siempre.
  const repo = repoDeJuguete({ 'operations.json': OPS_VALIDO });
  const al = almacenDeJuguete();
  assert.strictEqual((await COPIA.subir({ repo, almacen: al, log: sinLog })).ok, true);
  const { dataDir, f } = fuentesConCopia(al, () => T0);
  const viejas = path.join(dataDir, 'operaciones-copia');
  const hace = new Date(Date.now() - 300 * 60000);
  for (const s of ['000001', '000002']) { const c = path.join(viejas, `copia-${'a'.repeat(12)}-${s}`); fs.mkdirSync(c, { recursive: true }); fs.utimesSync(c, hace, hace); }
  try {
    await f.refrescar();
    const abierta = f.clones().operaciones.dir;
    assert.ok(!abierta.startsWith(dataDir), `abierta en el disco local: ${abierta}`);
    await COPIA.podaPendiente(viejas);
    for (let i = 0; i < 20 && fs.existsSync(viejas); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(!fs.existsSync(viejas), 'las del disco de datos, borradas, y la carpeta vacía también');
    // un reinicio: otro proceso con el mismo SITE_DATA_DIR y un disco local nuevo vuelve a bajar la foto
    f.detener();
    const env2 = H.envBase({ SITE_OPERATIONS_SOURCE: 'copy', SITE_OPERATIONS_COPY: 'acmeops/copia' }); delete env2.SITE_OPERATIONS_TOKEN;
    const v = validarConfiguracion(env2); const f2 = crearFuentes({ cfg: v.cfg, dataDir, log: sinLog, ahora: () => T0, almacenCopia: al, opcionesPodaCopia: { demoraMs: 0, pausaMs: 0 } });
    try {
      await f2.refrescar();
      const otra = f2.clones().operaciones;
      assert.ok(otra && otra.dir !== abierta && fs.existsSync(path.join(otra.dir, 'operations.json')), 'tras el reinicio, la foto otra vez en disco local');
    } finally { f2.detener(); }
  } finally { f.detener(); }
  // si la bajada falla, no se poda nada: las viejas quedan para cuando ande
  const vacio = almacenDeJuguete();
  const otro = fuentesConCopia(vacio, () => T0);
  const viejas2 = path.join(otro.dataDir, 'operaciones-copia', `copia-${'b'.repeat(12)}-000001`);
  fs.mkdirSync(viejas2, { recursive: true }); fs.utimesSync(viejas2, hace, hace);
  try {
    await otro.f.refrescar();
    await COPIA.podaPendiente(path.dirname(viejas2));
    assert.ok(fs.existsSync(viejas2), 'sin foto bajada, la vieja sigue');
  } finally { otro.f.detener(); }
});

test('T17 2.34-Edad_BandaYFreno @story-2.34 @ac-9 — 23 h nada, 25 h la banda, 49 h el sitio frenado', async () => {
  // 🔴 rojo: el trabajo que copia se corta y el sitio sigue mostrando una copia vieja sin decirlo, para siempre.
  const repo = repoDeJuguete({ 'operations.json': OPS_VALIDO });
  const al = almacenDeJuguete();
  assert.strictEqual((await COPIA.subir({ repo, almacen: al, ahora: () => T0, log: sinLog })).ok, true);
  let t = T0 + 23 * HORA;
  const { f } = fuentesConCopia(al, () => t);
  try {
    await f.refrescar();
    assert.strictEqual(f.estado().bandaConfig, null, '23 h: nada');
    assert.strictEqual(f.estado().frenado, null);
    t = T0 + 25 * HORA;
    const e25 = f.estado();
    assert.ok(e25.bandaConfig && /la copia de operaciones tiene 25 horas/.test(e25.bandaConfig.motivo), JSON.stringify(e25));
    assert.strictEqual(e25.frenado, null);
    assert.strictEqual(e25.bandaConfig.desde, T0 + 24 * HORA + 1, 'la cuenta empieza a las 24 h de la copia');
    t = T0 + 49 * HORA;
    await f.refrescar();
    const e49 = f.estado();
    assert.ok(e49.frenado, '49 h: frenado');
    assert.strictEqual(e49.frenado.desde, T0 + 48 * HORA + 1);
    // una copia nueva saca la banda y el freno
    fs.writeFileSync(path.join(repo, 'operations.json'), OPS_VALIDO.replace('"maintainers":["lead@', '"maintainers":["lead2@'));
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'otra');
    assert.strictEqual((await COPIA.subir({ repo, almacen: al, ahora: () => t, log: sinLog })).subido, true);
    await f.refrescar();
    assert.strictEqual(f.estado().frenado, null);
    assert.strictEqual(f.estado().bandaConfig, null);
  } finally { f.detener(); }
});

test('T26 2.34-Guia_FormasYFueraDeAzure @story-2.34 @ac-12 @ac-13 @ac-17 — las tres formas, en los dos idiomas; las variables sin valor', () => {
  // 🔴 rojo: quien instala fuera de Azure no sabe qué abre la llave prendida, o una de las dos guías cuenta otras formas.
  const seccion = (rel, titulo) => {
    const t = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const i = t.indexOf(`\n### ${titulo}\n`);
    assert.ok(i >= 0, `${rel}: falta «${titulo}»`);
    const resto = t.slice(i + 1);
    const fin = resto.slice(4).search(/\n##+ /);
    return fin < 0 ? resto : resto.slice(0, fin + 4);
  };
  const es = seccion('guides/organization-site.md', 'De dónde lee operaciones');
  const en = seccion('guides/organization-site.en.md', 'Where it reads operations from');
  const orden = (t, formas) => formas.map((f) => { const i = t.indexOf(f); assert.ok(i >= 0, `falta ${f}`); return i; });
  const ies = orden(es, ['**Copia con la identidad de la plataforma, en Azure**', '**Copia con una SAS, fuera de Azure**', '**Lectura directa del repo**']);
  const ien = orden(en, ['**Copy with the platform identity, in Azure**', '**Copy with a SAS, outside Azure**', '**Reading the repo directly**']);
  assert.deepStrictEqual([...ies].sort((a, b) => a - b), ies, 'en castellano, en orden');
  assert.deepStrictEqual([...ien].sort((a, b) => a - b), ien, 'en inglés, el mismo orden');
  assert.strictEqual((es.match(/Lo que cuesta:/g) || []).length, 3, 'cada forma, con lo que cuesta');
  assert.strictEqual((en.match(/What it costs:/g) || []).length, 3);
  assert.match(es, /llave de la cuenta[^.]*prendida[^.]*abre/i, 'qué abre la llave prendida fuera de Azure');
  assert.match(en, /account key[^.]*(on|enabled)[^.]*opens/i);
  for (const t of [es, en]) for (const v of ['SITE_OPERATIONS_SOURCE=copy', 'SITE_OPERATIONS_COPY', 'SITE_OPERATIONS_COPY_SAS', 'site-copy.yml']) assert.ok(t.includes(v), `${v} en la guía`);
  // render.yaml y sitio.env.example: las variables de la copia, sin valor
  const render = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'deploy', 'render.yaml'), 'utf8');
  for (const v of ['SITE_OPERATIONS_SOURCE', 'SITE_OPERATIONS_COPY', 'SITE_OPERATIONS_COPY_SAS']) assert.match(render, new RegExp(`- key: ${v}\\n {8}sync: false\\n`), `${v} en render.yaml, sin valor`);
  const local = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'deploy', 'local', 'sitio.env.example'), 'utf8');
  for (const v of ['SITE_OPERATIONS_SOURCE', 'SITE_OPERATIONS_COPY', 'SITE_OPERATIONS_COPY_SAS']) assert.match(local, new RegExp(`^# ${v}=$`, 'm'), `${v} en sitio.env.example, sin valor`);
});

test('T7b 2.34-Subir_RamasDeError @story-2.34 @ac-3 — un clon que no es git, uno sin las rutas, y el índice previo que no se lee: nada se sube', async () => {
  // 🔴 rojo: una falla al juntar o al leer el índice previo sube igual algo, o sale «ok».
  const al = almacenDeJuguete();
  const noGit = tmp();
  const r1 = await COPIA.subir({ repo: noGit, almacen: al, log: sinLog });
  assert.strictEqual(r1.ok, false);
  const vacio = path.join(tmp(), 'ops');
  fs.mkdirSync(vacio, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', vacio]);
  fs.writeFileSync(path.join(vacio, 'otro.txt'), 'x\n');
  git(vacio, 'add', '-A'); git(vacio, 'commit', '-qm', 'acme');
  const r2 = await COPIA.subir({ repo: vacio, almacen: al, log: sinLog });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.motivo, /ninguna de las rutas/);
  const caido = { ...almacenDeJuguete(), async get() { return { error: Object.assign(new Error('caído'), { code: 'ECONNRESET' }) }; } };
  caido.put = async () => { throw new Error('no debía subir nada'); };
  const r3 = await COPIA.subir({ repo: repoDeJuguete(), almacen: caido, log: sinLog });
  assert.strictEqual(r3.ok, false);
  assert.match(r3.motivo, /no se pudo leer el índice/);
  assert.deepStrictEqual(al.ops.filter((o) => o[0] === 'put'), [], 'ningún put');
});

test('T7c 2.34-Subir_LineaDeOrdenes @story-2.34 @ac-2 @ac-3 — la orden del trabajo que copia: uso, ensayo y la falla de la credencial', () => {
  // 🔴 rojo: el trabajo que copia sale verde sin haber subido nada (sin sesión de az, o con argumentos de menos).
  const CLI = path.join(ROOT, 'scripts', 'site', 'operations-copy.js');
  const correr = (args, env = {}) => require('child_process').spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.strictEqual(correr([]).status, 2, 'sin orden: uso');
  assert.strictEqual(correr(['subir', '--repo', 'x']).status, 2, 'sin cuenta ni contenedor: uso');
  const repo = repoDeJuguete();
  const ensayo = correr(['subir', '--repo', repo, '--dry-run']);
  assert.strictEqual(ensayo.status, 0, ensayo.stderr);
  assert.match(ensayo.stdout, /prueba: \d+ archivo\(s\)/);
  const sinAz = correr(['subir', '--repo', repo, '--account', 'acmecopia', '--container', 'copia', '--url-base', 'http://127.0.0.1:9'], { TYCON_AZ_CMD: process.execPath }); // node con «account …» sale 1: un az sin sesión, también en Windows
  assert.strictEqual(sinAz.status, 1, 'sin sesión de az: rojo');
  assert.match(sinAz.stderr, /\[copia\] /);
});

// ── una prueba por cada hallazgo confirmado del pase adversarial ──────────────────────────────────────────
test('A1 2.34-Adv_MismoCommitBorraLasViejas @story-2.34 @ac-3 — con el índice al día igual se borran las fotos vencidas', async () => {
  const repo = repoDeJuguete();
  const al = almacenDeJuguete();
  const s = await COPIA.subir({ repo, almacen: al, log: sinLog });
  al.blobs.set('fotos/vieja.tar.gz', { cuerpo: Buffer.from('x'), modificado: Date.now() - 8 * 86400000 });
  const r = await COPIA.subir({ repo, almacen: al, log: sinLog });
  assert.strictEqual(r.subido, false);
  assert.ok(!al.blobs.has('fotos/vieja.tar.gz'), 'la vencida se borró');
  assert.ok(al.blobs.has(`fotos/${s.commit}.tar.gz`), 'la del índice queda');
});

test('A6 2.34-Adv_MismoCommitSinFotoLaRepone @story-2.34 @ac-3 — el índice nombra el commit y su foto falta: se vuelve a subir', async () => {
  const repo = repoDeJuguete();
  const al = almacenDeJuguete();
  const s = await COPIA.subir({ repo, almacen: al, log: sinLog });
  al.blobs.delete(`fotos/${s.commit}.tar.gz`);
  const r = await COPIA.subir({ repo, almacen: al, log: sinLog });
  assert.strictEqual(r.ok, true, r.motivo);
  assert.strictEqual(r.subido, true);
  assert.strictEqual((await COPIA.bajar({ almacen: al, dir: tmp() })).ok, true, 'el sitio la puede abrir');
});

test('A2 2.34-Adv_SinCambiosSinCommitear @story-2.34 @ac-2 — un cambio sin commitear en el clon nunca entra a la foto', async () => {
  // 🔴 rojo: alguien con acceso al clon del trabajo cambia operations.json sin commit y se hace mantenedor con el sello de main.
  const repo = repoDeJuguete({ 'operations.json': '{"version":1,"site":{"maintainers":["real@acme.example"]}}\n' });
  fs.writeFileSync(path.join(repo, 'operations.json'), '{"version":1,"site":{"maintainers":["intruso@acme.example"]}}\n');
  const al = almacenDeJuguete();
  assert.strictEqual((await COPIA.subir({ repo, almacen: al, log: sinLog })).ok, true);
  const b = await COPIA.bajar({ almacen: al, dir: tmp() });
  const texto = fs.readFileSync(path.join(b.carpeta, 'operations.json'), 'utf8');
  assert.match(texto, /real@acme\.example/);
  assert.doesNotMatch(texto, /intruso/);
  assert.strictEqual(b.indice.archivos['operations.json'], git(repo, 'rev-parse', 'HEAD:operations.json'));
});

test('A3 2.34-Adv_IndiceSinVersiones @story-2.34 @ac-8 @ac-10 — un índice sin la versión de cada archivo es ilegible', async () => {
  const repo = repoDeJuguete();
  const al = almacenDeJuguete();
  await COPIA.subir({ repo, almacen: al, log: sinLog });
  const idx = JSON.parse(al.blobs.get('actual.json').cuerpo);
  for (const archivos of [undefined, {}, [], { 'operations.json': 'no-es-oid' }, { '../x': 'a'.repeat(40) }]) {
    al.blobs.set('actual.json', { cuerpo: Buffer.from(JSON.stringify({ ...idx, archivos })), modificado: Date.now() });
    const b = await COPIA.bajar({ almacen: al, dir: tmp() });
    assert.strictEqual(b.ok, false, JSON.stringify(archivos));
    assert.strictEqual(b.codigo, 'ilegible');
  }
});

test('A5 2.34-Adv_NombreLargoUtf8 @story-2.34 @ac-2 — un nombre válido de git que no entra en ustar va con su cabecera extendida', async () => {
  const largo = `.dashboard/${'é'.repeat(80)}/${'ñ'.repeat(60)}.json`;
  const repo = repoDeJuguete({ [largo]: '{"largo":true}\n' });
  const al = almacenDeJuguete();
  const s = await COPIA.subir({ repo, almacen: al, log: sinLog });
  assert.strictEqual(s.ok, true, s.motivo);
  const b = await COPIA.bajar({ almacen: al, dir: tmp() });
  assert.strictEqual(b.ok, true, b.motivo);
  assert.strictEqual(fs.readFileSync(path.join(b.carpeta, largo), 'utf8'), '{"largo":true}\n');
  // la cabecera extendida no sirve para escaparse: su ruta se valida como cualquier otra
  const malo = COPIA.armarFoto([{ rel: `.dashboard/${'x'.repeat(200)}/a.json`, cuerpo: Buffer.from('{}') }]);
  const tar = zlib.gunzipSync(malo);
  const pax = tar.subarray(512, 1024).toString('utf8');
  const cambiado = Buffer.from(tar);
  const nuevo = pax.replace(/path=[^\n]*/, (m) => `path=../${'x'.repeat(m.length - 'path=../'.length)}`);
  cambiado.write(nuevo, 512, 'utf8');
  assert.strictEqual(COPIA.leerFoto(zlib.gzipSync(cambiado)).ok, false, 'una ruta con .. por la cabecera extendida no se abre');
});

test('A9 2.34-Adv_ReinicioNoRenuevaElPlazo @story-2.34 @ac-9 — reiniciar con una copia de 49 h y el almacenamiento caído: frenado', async () => {
  // 🔴 rojo: un reinicio olvida la edad de la copia y un mantenedor ya sacado sigue entrando 24 horas más.
  const repo = repoDeJuguete({ 'operations.json': OPS_VALIDO });
  const al = almacenDeJuguete();
  await COPIA.subir({ repo, almacen: al, ahora: () => T0, log: sinLog });
  const env = H.envBase({ SITE_OPERATIONS_SOURCE: 'copy', SITE_OPERATIONS_COPY: 'acmeops/copia' });
  delete env.SITE_OPERATIONS_TOKEN;
  const cfg = validarConfiguracion(env).cfg;
  const dataDir = tmp();
  const f1 = crearFuentes({ cfg, dataDir, log: sinLog, ahora: () => T0 + HORA, almacenCopia: al });
  await f1.refrescar(); f1.detener();
  const caido = { ...al, async get() { return { error: Object.assign(new Error('caído'), { code: 'ECONNRESET' }) }; } };
  const f2 = crearFuentes({ cfg, dataDir, log: sinLog, ahora: () => T0 + 49 * HORA, almacenCopia: caido });
  try {
    await f2.refrescar();
    assert.ok(f2.estado().frenado, JSON.stringify(f2.estado()));
  } finally { f2.detener(); }
});

test('A4 2.34-Adv_FrenoConMasDe48 @story-2.34 @ac-9 — exactamente 48 h no frena; un instante después, sí', async () => {
  const repo = repoDeJuguete({ 'operations.json': OPS_VALIDO });
  const al = almacenDeJuguete();
  await COPIA.subir({ repo, almacen: al, ahora: () => T0, log: sinLog });
  let t = T0;
  const { f } = fuentesConCopia(al, () => t);
  try {
    await f.refrescar();
    t = T0 + 48 * HORA;
    assert.strictEqual(f.estado().frenado, null, '48 h exactas: banda, no freno');
    assert.ok(f.estado().bandaConfig);
    t = T0 + 48 * HORA + 2;
    assert.ok(f.estado().frenado, 'más de 48 h: frenado');
  } finally { f.detener(); }
});

test('S1 2.34-Silent_SinOperationsJsonNoSube @story-2.34 @ac-3 — un main sin operations.json no publica una foto sin configuración', async () => {
  const repo = repoDeJuguete();
  git(repo, 'rm', '-q', 'operations.json'); git(repo, 'commit', '-qm', 'sin ops');
  const al = almacenDeJuguete();
  const r = await COPIA.subir({ repo, almacen: al, log: sinLog });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /operations\.json/);
  assert.ok(!al.blobs.has('actual.json'));
});

test('T17b 2.34-SinCredencialesNiCuenta @story-2.34 @ac-17 — ni el índice ni la foto llevan credenciales; la banda no nombra la cuenta', async () => {
  // 🔴 rojo: el token del trabajo que copia queda en el índice, o la banda del sitio nombra la cuenta y el contenedor.
  const repo = repoDeJuguete({ 'operations.json': OPS_VALIDO });
  const al = almacenDeJuguete();
  const TOKEN = ['tok', 'de', 'la', 'copia', crypto.randomBytes(4).toString('hex')].join('-');
  // el token vive en el ambiente del trabajo (como el de `az`) y en el clon sin commitear: ninguno de los dos llega a la
  // foto ni al índice. El camino real de la credencial (la cabecera) lo prueba el humo de la story con un `az` de laboratorio
  fs.writeFileSync(path.join(repo, '.dashboard', 'credencial.json'), `{"token":"${TOKEN}"}\n`);
  const viejo = process.env.SITE_COPY_TOKEN; process.env.SITE_COPY_TOKEN = TOKEN;
  let s;
  try { s = await COPIA.subir({ repo, almacen: al, ahora: () => T0, log: sinLog }); } finally { if (viejo === undefined) delete process.env.SITE_COPY_TOKEN; else process.env.SITE_COPY_TOKEN = viejo; }
  assert.strictEqual(s.ok, true, s.motivo);
  assert.strictEqual(al.blobs.size, 2, 'la foto y el índice');
  for (const [nombre, b] of al.blobs) {
    const texto = nombre.endsWith('.gz') ? zlib.gunzipSync(b.cuerpo).toString('latin1') : b.cuerpo.toString('utf8');
    assert.ok(!texto.includes(TOKEN), `${nombre} trae la credencial`);
    assert.doesNotMatch(texto, /acmeops|sig=|Bearer /, `${nombre} nombra la cuenta o una credencial`);
  }
  let t = T0 + 25 * HORA;
  const { f } = fuentesConCopia(al, () => t);
  try {
    await f.refrescar();
    const banda = JSON.stringify(f.estado());
    assert.match(banda, /la copia de operaciones tiene 25 horas/);
    assert.doesNotMatch(banda, /acmeops|\/copia\b/, 'la banda no nombra la cuenta ni el contenedor');
  } finally { f.detener(); }
});

// ── el logo de la organización ────────────────────────────────────────────────────────────────────────────────
const opsConLogo = (logo) => `${JSON.stringify({ version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'], brand: { name: 'Acme', logo } } })}\n`;

test('T1 2.54-Subir_SumaElLogoDeclarado @story-2.54 @ac-1 — la foto y el índice traen el logo que declara operations.json', async () => {
  // 🔴 rojo: la foto sale sin el logo y /marca/logo no lo encuentra.
  const repo = repoDeJuguete({ 'operations.json': opsConLogo('marca/logo.png'), 'marca/logo.png': PNG, 'marca/otro.png': PNG });
  const al = almacenDeJuguete();
  const r = await COPIA.subir({ repo, almacen: al, log: sinLog });
  assert.strictEqual(r.ok, true, r.motivo);
  const idx = JSON.parse(al.blobs.get('actual.json').cuerpo);
  assert.ok(idx.archivos['marca/logo.png'], 'el índice nombra el logo con su versión');
  const foto = COPIA.leerFoto(al.blobs.get(`fotos/${idx.commit}.tar.gz`).cuerpo);
  assert.ok(foto.ok, foto.motivo);
  const logo = foto.archivos.find((a) => a.rel === 'marca/logo.png');
  assert.ok(logo && logo.cuerpo.equals(PNG), 'la foto trae el logo, con su contenido');
  assert.ok(!foto.archivos.some((a) => a.rel === 'marca/otro.png'), 'sólo el archivo exacto, no la carpeta');
  // un logo que ya cae en RUTAS (la carpeta .dashboard/) entra una sola vez
  const repo2 = repoDeJuguete({ 'operations.json': opsConLogo('.dashboard/logo.svg'), '.dashboard/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' });
  const al2 = almacenDeJuguete();
  assert.strictEqual((await COPIA.subir({ repo: repo2, almacen: al2, log: sinLog })).ok, true);
  const idx2 = JSON.parse(al2.blobs.get('actual.json').cuerpo);
  const foto2 = COPIA.leerFoto(al2.blobs.get(`fotos/${idx2.commit}.tar.gz`).cuerpo);
  assert.ok(foto2.ok, foto2.motivo);
  assert.strictEqual(foto2.archivos.filter((a) => a.rel === '.dashboard/logo.svg').length, 1, 'una sola vez');
});

test('T2 2.54-Subir_LogoInvalidoAusenteOEnlace @story-2.54 @ac-1 — un logo que no vale, que falta o que es un enlace: la foto sale igual, sin él, y lo dice', async () => {
  const afuera = path.join(tmp(), 'secreto.png');
  fs.writeFileSync(afuera, PNG);
  const casos = [
    ['gif', 'marca/logo.gif', { 'marca/logo.gif': PNG }, /site\.brand\.logo.*no entra a la foto/],
    ['sube', '../afuera.png', {}, /site\.brand\.logo.*no entra a la foto/],
    ['falta', 'marca/falta.png', {}, /marca\/falta\.png.*no está en el commit/],
    ['enlace', 'marca/enlace.png', {}, /marca\/enlace\.png.*enlace simbólico/],
    ['ilegible', null, { 'operations.json': '{roto', 'marca/logo.png': PNG }, /operations\.json no se lee como JSON.*el logo no entra/],
    ['carpeta', 'marca/logo.png', { 'marca/logo.png/adentro.txt': 'una carpeta con nombre de logo' }, /marca\/logo\.png es un tree de git, no un archivo/],
  ];
  for (const [que, logo, extra, mensaje] of casos) {
    const repo = repoDeJuguete({ 'operations.json': opsConLogo(logo), ...extra });
    if (que === 'enlace') {
      fs.mkdirSync(path.join(repo, 'marca'), { recursive: true });
      fs.symlinkSync(afuera, path.join(repo, 'marca', 'enlace.png'));
      git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'enlace');
    }
    const al = almacenDeJuguete();
    const lineas = [];
    const r = await COPIA.subir({ repo, almacen: al, log: (l) => lineas.push(l) });
    assert.strictEqual(r.ok, true, `${que}: ${r.motivo}`);
    const idx = JSON.parse(al.blobs.get('actual.json').cuerpo);
    const foto = COPIA.leerFoto(al.blobs.get(`fotos/${idx.commit}.tar.gz`).cuerpo);
    assert.ok(foto.ok, `${que}: ${foto.motivo}`);
    assert.ok(!foto.archivos.some((a) => /\.(png|gif)$/.test(a.rel)), `${que}: la foto no trae el logo`);
    assert.ok(lineas.some((l) => mensaje.test(l)), `${que}: el registro lo dice (${lineas.join(' | ')})`);
  }
});

test('T3 2.54-Bajar_IgnoraLoQueNoConoce @story-2.54 @ac-2 — una ruta sana que el sitio no lee se ignora; el resto se abre', async () => {
  // 🔴 rojo: hoy el sitio rechaza la foto entera y se queda sin datos frescos.
  const foto = fotoCon([
    { nombre: 'operations.json', datos: '{"version":1,"site":{"brand":{"logo":"marca/logo.png"}}}' },
    { nombre: 'pipelines/acme.yml', datos: 'trigger: none' },
    { nombre: 'marca/otro.png', datos: 'no lo declara operations.json' },
  ]);
  const huella = crypto.createHash('sha256').update(foto).digest('hex');
  const commit = 'd'.repeat(40);
  const al = almacenDeJuguete({ inicial: { 'actual.json': JSON.stringify({ version: 1, commit, hora: new Date().toISOString(), huella, archivos: { 'operations.json': 'a'.repeat(40), 'pipelines/acme.yml': 'b'.repeat(40) } }), [`fotos/${commit}.tar.gz`]: foto } });
  const dir = tmp();
  const lineas = [];
  const r = await COPIA.bajar({ almacen: al, dir, previo: null, log: (l) => lineas.push(l) });
  assert.strictEqual(r.ok, true, r.motivo);
  assert.ok(fs.existsSync(path.join(r.carpeta, 'operations.json')), 'lo que el sitio lee, abierto');
  assert.ok(!fs.existsSync(path.join(r.carpeta, 'pipelines')), 'lo que no lee no se escribe');
  assert.ok(!fs.existsSync(path.join(r.carpeta, 'marca')), 'un .png que operations.json no declara no se escribe');
  assert.ok(lineas.some((l) => /ignorad/.test(l) && l.includes('pipelines/acme.yml') && l.includes('marca/otro.png')), `el registro nombra lo ignorado (${lineas.join(' | ')})`);
  // una foto en la que todo se ignora no se abre, y el motivo dice que hubo archivos ignorados (no «ningún archivo»)
  const nada = COPIA.leerFoto(fotoCon([{ nombre: 'pipelines/acme.yml', datos: 'x' }, { nombre: 'inbox/acme.md', datos: 'x' }]));
  assert.strictEqual(nada.ok, false);
  assert.match(nada.motivo, /ningún archivo que el sitio lea \(2 ignorado\(s\)\)/);
});

test('T4 2.54-Bajar_ElLogoLlegaAlSitio @story-2.54 @ac-4 — el sitio abre la foto con el logo y lo deja donde /marca/logo lo lee', async () => {
  // 🔴 rojo: la carpeta de operaciones del sitio no trae el logo.
  const repo = repoDeJuguete({ 'operations.json': opsConLogo('marca/logo.png'), 'marca/logo.png': PNG });
  const al = almacenDeJuguete();
  assert.strictEqual((await COPIA.subir({ repo, almacen: al, log: sinLog })).ok, true);
  const { f } = fuentesConCopia(al, () => T0);
  const emisor = await arrancarEmisor();
  let h = null;
  try {
    await f.refrescar();
    const dir = f.clones().operaciones.dir;
    assert.ok(fs.readFileSync(path.join(dir, 'marca', 'logo.png')).equals(PNG), 'el logo, en la carpeta de operaciones');
    assert.strictEqual(f.config().site.brand.logo, 'marca/logo.png');
    // y la ruta del sitio lo sirve, leyendo la carpeta de la copia
    h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer }), fuentes: f });
    const s = (await H.ingresar(h, emisor, { sub: 's-lead', email: 'lead@acme.example', email_verified: true })).sesion;
    const logo = await h.pedir('/marca/logo', { cookie: s });
    assert.deepStrictEqual([logo.status, logo.headers['content-type']], [200, 'image/png'], '/marca/logo responde con el logo de la copia');
  } finally { if (h) await h.cerrar(); await emisor.cerrar(); f.detener(); }
});

// ── al día es el mismo commit y la misma foto ──────────────────────────────────────────────────────────────────────
/** Reemplaza en el almacén la foto del mismo commit por una con `extra` sumado, y el índice con su huella y su lista. */
function reemplazarFoto(al, extra) {
  const idx = JSON.parse(al.blobs.get('actual.json').cuerpo);
  const viejos = COPIA.leerFoto(al.blobs.get(`fotos/${idx.commit}.tar.gz`).cuerpo).archivos;
  const nuevos = [...viejos, ...Object.entries(extra).map(([rel, txt]) => ({ rel, cuerpo: Buffer.from(txt) }))];
  const foto = COPIA.armarFoto(nuevos);
  const archivos = { ...idx.archivos };
  for (const rel of Object.keys(extra)) archivos[rel] = crypto.createHash('sha1').update(rel).digest('hex');
  const nuevo = { ...idx, huella: crypto.createHash('sha256').update(foto).digest('hex'), bytes: foto.length, archivos };
  al.blobs.set(`fotos/${idx.commit}.tar.gz`, { cuerpo: foto, modificado: Date.now() });
  al.blobs.set('actual.json', { cuerpo: Buffer.from(JSON.stringify(nuevo)), modificado: Date.now() });
  return { antes: idx, despues: nuevo };
}

test('T1 2.55-Subir_MismoCommitOtraLista @story-2.55 @ac-1 — el índice nombra el commit con otra lista de archivos: se vuelve a subir', async () => {
  // 🔴 rojo: con el mismo commit dice «al día» y la foto con el logo nunca se sube.
  const repo = repoDeJuguete({ 'operations.json': opsConLogo('marca/logo.png'), 'marca/logo.png': PNG });
  const commit = git(repo, 'rev-parse', 'HEAD');
  const { indice } = await COPIA.subir({ repo, almacen: null, log: sinLog, dryRun: true });
  const sinLogo = Object.fromEntries(Object.entries(indice.archivos).filter(([rel]) => rel !== 'marca/logo.png'));
  // lo que deja un arnés que no sumaba el logo: el mismo commit, la foto presente, la lista sin el logo
  const al = almacenDeJuguete({ inicial: { 'actual.json': JSON.stringify({ ...indice, archivos: sinLogo }), [`fotos/${commit}.tar.gz`]: 'x' } });
  const lineas = [];
  const r = await COPIA.subir({ repo, almacen: al, log: (l) => lineas.push(l) });
  assert.strictEqual(r.ok, true, r.motivo);
  assert.strictEqual(r.subido, true, r.motivo);
  const idx = JSON.parse(al.blobs.get('actual.json').cuerpo);
  assert.strictEqual(idx.commit, commit, 'el mismo commit');
  assert.ok(idx.archivos['marca/logo.png'], 'el índice nuevo nombra el logo');
  const foto = COPIA.leerFoto(al.blobs.get(idx.foto).cuerpo);
  assert.ok(foto.ok && foto.archivos.some((a) => a.rel === 'marca/logo.png'), 'la foto nueva trae el logo');
  assert.ok(lineas.some((l) => /otra lista de archivos/.test(l) && l.includes(commit.slice(0, 12))), `el registro lo dice (${lineas.join(' | ')})`);
});

test('T3 2.55-Bajar_MismoCommitOtraHuella @story-2.55 @ac-2 — el mismo commit con otra huella: el sitio abre la foto nueva', async () => {
  // 🔴 rojo: con el mismo commit el sitio se queda con la carpeta vieja (cambio: false).
  const { al } = await conFotoSubida();
  const dir = tmp();
  const a = await COPIA.bajar({ almacen: al, dir, previo: null, log: sinLog });
  assert.strictEqual(a.ok, true, a.motivo);
  const { antes, despues } = reemplazarFoto(al, { 'marca/logo.png': PNG.toString('latin1') });
  assert.strictEqual(antes.commit, despues.commit);
  const b = await COPIA.bajar({ almacen: al, dir, previo: { commit: antes.commit, huella: antes.huella, carpeta: a.carpeta }, log: sinLog });
  assert.strictEqual(b.ok, true, b.motivo);
  assert.strictEqual(b.cambio, true, 'otra huella: se abre');
  assert.notStrictEqual(b.carpeta, a.carpeta, 'otra carpeta');
  assert.strictEqual(b.indice.huella, despues.huella);
  // sin huella previa (un sitio que no la guardó): se baja, que es lo seguro
  const c = await COPIA.bajar({ almacen: al, dir, previo: { commit: despues.commit, carpeta: b.carpeta }, log: sinLog });
  assert.strictEqual(c.ok, true, c.motivo);
  assert.strictEqual(c.cambio, true, 'sin huella previa: se baja');
});

test('T4 2.55-Fuentes_PasanLaHuella @story-2.55 @ac-2 — el sitio refresca la foto re-subida con el mismo commit; sin re-subir, no', async () => {
  const repo = repoDeJuguete({ 'operations.json': OPS_VALIDO });
  const al = almacenDeJuguete();
  assert.strictEqual((await COPIA.subir({ repo, almacen: al, log: sinLog })).ok, true);
  const { f } = fuentesConCopia(al, () => T0);
  try {
    await f.refrescar();
    const primera = f.clones().operaciones.dir;
    al.ops.length = 0;
    await f.refrescar();
    assert.strictEqual(f.clones().operaciones.dir, primera, 'la misma foto: la misma carpeta');
    assert.ok(!al.ops.some((o) => o[0] === 'get' && o[1].startsWith('fotos/')), 'la misma foto: no la baja');
    reemplazarFoto(al, { '.dashboard/nuevo.json': '{}\n' });
    await f.refrescar();
    const segunda = f.clones().operaciones.dir;
    assert.notStrictEqual(segunda, primera, 'la foto re-subida con el mismo commit: otra carpeta');
    assert.ok(fs.existsSync(path.join(segunda, '.dashboard', 'nuevo.json')), 'con lo que trae la foto nueva');
  } finally { f.detener(); }
});

test('T6 2.55-Subir_ReSubidaNoPisaLaFoto @story-2.55 @ac-1 @ac-2 — la re-subida con el mismo commit no pisa la foto del índice; un «foto» raro es ilegible', async () => {
  // 🔴 rojo (pase adversarial): la foto nueva pisa fotos/<commit>.tar.gz; si el índice no se escribe, el índice viejo
  // nombra una foto con otra huella y un sitio que arranca de cero queda sin datos hasta la próxima corrida.
  const repo = repoDeJuguete({ 'operations.json': opsConLogo('marca/logo.png'), 'marca/logo.png': PNG });
  const al = almacenDeJuguete();
  const s = await COPIA.subir({ repo, almacen: al, log: sinLog });
  assert.strictEqual(s.ok, true, s.motivo);
  // lo que deja un arnés que no sumaba el logo: el mismo commit, la foto sin él y el índice que la nombra
  const previo = JSON.parse(al.blobs.get('actual.json').cuerpo);
  const sinLogo = COPIA.leerFoto(al.blobs.get(`fotos/${previo.commit}.tar.gz`).cuerpo).archivos.filter((x) => x.rel !== 'marca/logo.png');
  const fotoVieja = COPIA.armarFoto(sinLogo);
  delete previo.archivos['marca/logo.png'];
  previo.huella = crypto.createHash('sha256').update(fotoVieja).digest('hex');
  al.blobs.set(`fotos/${previo.commit}.tar.gz`, { cuerpo: fotoVieja, modificado: Date.now() });
  al.blobs.set('actual.json', { cuerpo: Buffer.from(JSON.stringify(previo)), modificado: Date.now() });
  const falla = almacenDeJuguete({ fallaPut: (n) => n === 'actual.json' });
  for (const [k, v] of al.blobs) falla.blobs.set(k, v);
  const r = await COPIA.subir({ repo, almacen: falla, log: sinLog });
  assert.strictEqual(r.ok, false);
  assert.ok(falla.blobs.get(`fotos/${previo.commit}.tar.gz`).cuerpo.equals(fotoVieja), 'la foto que nombra el índice sigue entera');
  const a = await COPIA.bajar({ almacen: falla, dir: tmp(), previo: null, log: sinLog });
  assert.strictEqual(a.ok, true, `un sitio que arranca de cero abre la foto del índice viejo (${a.motivo})`);
  // con el índice escrito, el sitio baja la foto nueva, que nombra «foto»
  const ok = await COPIA.subir({ repo, almacen: al, log: sinLog });
  assert.strictEqual(ok.subido, true, ok.motivo);
  const idx = JSON.parse(al.blobs.get('actual.json').cuerpo);
  assert.ok(idx.foto && idx.foto !== `fotos/${idx.commit}.tar.gz` && al.blobs.has(idx.foto), `el índice nombra la foto re-subida (${idx.foto})`);
  const b = await COPIA.bajar({ almacen: al, dir: tmp(), previo: null, log: sinLog });
  assert.strictEqual(b.ok, true, b.motivo);
  assert.ok(fs.existsSync(path.join(b.carpeta, 'marca', 'logo.png')), 'el sitio abre la foto nueva, con el logo');
  // la que nombra el índice no se borra por vieja; la de antes, a los 7 días, sí
  for (const k of [idx.foto, `fotos/${idx.commit}.tar.gz`]) al.blobs.get(k).modificado = Date.now() - 8 * 86400000;
  await COPIA.borrarViejas({ almacen: al, log: sinLog });
  assert.ok(al.blobs.has(idx.foto) && !al.blobs.has(`fotos/${idx.commit}.tar.gz`), 'queda sólo la que nombra el índice');
  // un «foto» que no tiene la forma de una foto: el índice es ilegible
  for (const raro of ['../actual.json', 'fotos/../x.tar.gz', 'otra/carpeta.tar.gz', 7]) {
    const mal = almacenDeJuguete();
    for (const [k, v] of al.blobs) mal.blobs.set(k, v);
    mal.blobs.set('actual.json', { cuerpo: Buffer.from(JSON.stringify({ ...idx, foto: raro })), modificado: Date.now() });
    const c = await COPIA.bajar({ almacen: mal, dir: tmp(), previo: null, log: sinLog });
    assert.deepStrictEqual([c.ok, c.codigo], [false, 'ilegible'], `foto ${JSON.stringify(raro)}: ${c.motivo}`);
  }
});
