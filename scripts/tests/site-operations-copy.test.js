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
  // la foto que nombra el índice está: al día (si faltara, se vuelve a subir: A6)
  const al = almacenDeJuguete({ inicial: { 'actual.json': JSON.stringify({ version: 1, commit }), [`fotos/${commit}.tar.gz`]: 'x' } });
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
  const b = await COPIA.bajar({ almacen: al, dir, previo: { commit: idx.commit, carpeta: a.carpeta }, log: sinLog });
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.cambio, false);
  assert.deepStrictEqual(al.ops, [['get', 'actual.json']], 'sólo el índice');
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
  return { dataDir, f: crearFuentes({ cfg: v.cfg, dataDir, log: sinLog, ahora, almacenCopia: almacen }) };
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
    assert.ok(!fs.existsSync(primera), 'la anterior se borró después del cambio');
    assert.ok(fs.existsSync(path.join(segunda, '.dashboard', 'nuevo.json')) && !fs.existsSync(path.join(segunda, '.dashboard', 'viejo.json')), 'sólo los archivos del commit nuevo');
    assert.strictEqual(f.clones().operaciones.indice.commit, git(repo, 'rev-parse', 'HEAD'));
    const sueltas = fs.readdirSync(path.join(dataDir, 'operaciones-copia'));
    assert.deepStrictEqual(sueltas, [path.basename(segunda)], 'ninguna carpeta a medio abrir ni vieja');
    assert.strictEqual(f.estado().cargado, true);
    assert.strictEqual(f.config().site.maintainers[0], 'lead@acme.example');
  } finally { f.detener(); }
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
  const es = seccion('guides/sitio-de-la-organizacion.md', 'De dónde lee operaciones');
  const en = seccion('guides/sitio-de-la-organizacion.en.md', 'Where it reads operations from');
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
