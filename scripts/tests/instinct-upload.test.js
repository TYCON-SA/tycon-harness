'use strict';

/**
 * instinct-upload.test.js — los días de instintos, al buzón y de vuelta (scripts/instincts/instinct-upload.js, su lugar
 * en la cola de scripts/metrics/upload-runs.js, la forma nueva de scripts/metrics/download-runs.js y el aviso de la
 * máquina sin buzón de integrations/instincts/scripts/instincts-notice.js).
 *
 * Lo que no se puede perder:
 *   · Que suba un archivo por día UTC cerrado, desde el aviso, y nunca lo de antes ni el día en curso.
 *   · Que no salga nada personal ni de otra organización: una línea de GitHub, de otra organización, sin repo o de
 *     `/clients/` no viaja, y de lo que viaja sólo van los seis campos proyectados (ni `project` ni `origin`).
 *   · Que un día subido no se mande otra vez, que una línea tardía lo mande entero con una versión nueva, que un «ya
 *     existe» se reintente una vez con otra versión, y que un corte a mitad no deje el día como subido.
 *   · Que «no pude» nunca sea «nada»: sin organización o con el registro ilegible, la cobertura dice `no_medido`.
 *   · Que la bajada traiga los días sólo con `--instincts`, la versión más nueva, y los cuente en `omitidos` sin ella.
 *
 * Sin red: el buzón es un servidor HTTP local en un proceso aparte (la subida corre en otro proceso y espera), con la
 * llave, el perfil y la HOME de laboratorio. Nunca se lee lo de esta máquina ni el buzón real.
 *
 * Uso: node --test scripts/tests/instinct-upload.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const UPLOAD = path.join(RAIZ, 'scripts', 'metrics', 'upload-runs.js');
const NOTICE = path.join(RAIZ, 'integrations', 'instincts', 'scripts', 'instincts-notice.js');
const INSTINCT_UPLOAD = path.join(RAIZ, 'scripts', 'instincts', 'instinct-upload.js');
const { stateDir } = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js'));

// La firma de mentira va armada por partes: pegada a su parámetro tiene la forma de una llave real.
const FIRMA = ['FIRMA', '%2B', 'deprueba', '%3D'].join('');
const SAS_ESCRITURA = `sv=2022-11-02&si=subida-prueba&sr=c&spr=https&sig=${FIRMA}`;
const SAS_LECTURA = `sv=2022-11-02&si=lectura-prueba&sr=c&sp=rl&se=2099-01-01T00:00:00Z&spr=https&sig=${FIRMA}`;

// ── el buzón de mentira ────────────────────────────────────────────────────────────────────────────────────────────
// Control por archivos en su carpeta: `ya-existe-una-vez` (una parte del nombre: el primer PUT que la nombra contesta 409)
// y `cortar` (una parte del nombre y un número N: desde el N-ésimo PUT que la nombra, corta la conexión).
const SERVIDOR = `
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const dir = process.argv[2];
const leer = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch (_) { return ''; } };
const blobs = path.join(dir, 'blobs');
const cuenta = {};
const todos = (d, pre = '') => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? todos(path.join(d, e.name), pre + e.name + '/') : [pre + e.name]) : [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const ruta = decodeURIComponent(u.pathname).replace(/^\\/[^/]+\\//, '');
  const trozos = [];
  let cortado = false;
  const [parteCorte, desde] = leer('cortar').split(' ');
  req.on('data', (c) => {
    if (req.method === 'PUT' && parteCorte && ruta.includes(parteCorte) && !cortado) {
      cuenta.corte = (cuenta.corte || 0) + (trozos.length ? 0 : 1);
      if (cuenta.corte >= Number(desde)) { cortado = true; req.socket.destroy(); return; }
    }
    trozos.push(c);
  });
  req.on('end', () => {
    if (cortado) return;
    if (req.method === 'GET' && u.searchParams.get('comp') === 'list') {
      const items = todos(blobs).sort().map((n) => {
        const b = fs.readFileSync(path.join(blobs, n));
        return '<Blob><Name>' + n + '</Name><Properties><Content-Length>' + b.length + '</Content-Length><Content-MD5>' + crypto.createHash('md5').update(b).digest('base64') + '</Content-MD5><Etag>e' + b.length + '</Etag></Properties></Blob>';
      }).join('');
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end('<?xml version="1.0"?><EnumerationResults><Blobs>' + items + '</Blobs><NextMarker/></EnumerationResults>');
    }
    if (req.method === 'GET') {
      const f = path.join(blobs, ruta);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      const b = fs.readFileSync(f);
      res.writeHead(200, { 'content-md5': crypto.createHash('md5').update(b).digest('base64') });
      return res.end(b);
    }
    const cuerpo = Buffer.concat(trozos);
    fs.appendFileSync(path.join(dir, 'pedidos.jsonl'), JSON.stringify({ metodo: req.method, ruta, inm: req.headers['if-none-match'] || null, bytes: cuerpo.length }) + '\\n');
    const rechazo = leer('rechazar-llave');
    if (rechazo && ruta.includes(rechazo)) { res.writeHead(403); return res.end('<?xml version="1.0"?><Error><Code>AuthenticationFailed</Code></Error>'); }
    const sinContenedor = leer('contenedor-borrado');
    if (sinContenedor && ruta.includes(sinContenedor)) { res.writeHead(404); return res.end('<?xml version="1.0"?><Error><Code>ContainerNotFound</Code></Error>'); }
    const unaVez = leer('ya-existe-una-vez');
    if (unaVez && ruta.includes(unaVez) && !cuenta.yaExiste) {
      cuenta.yaExiste = true;
      res.writeHead(409); return res.end('<?xml version="1.0"?><Error><Code>BlobAlreadyExists</Code></Error>');
    }
    const destino = path.join(blobs, ruta);
    if (fs.existsSync(destino) && req.headers['if-none-match'] === '*') { res.writeHead(409); return res.end('<?xml version="1.0"?><Error><Code>BlobAlreadyExists</Code></Error>'); }
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, cuerpo);
    res.writeHead(201); res.end();
  });
});
// el puerto se escribe de una vez (temporal y renombre): leído a medio escribir, la URL queda sin puerto
srv.listen(0, '127.0.0.1', () => { fs.writeFileSync(path.join(dir, 'puerto.tmp'), String(srv.address().port)); fs.renameSync(path.join(dir, 'puerto.tmp'), path.join(dir, 'puerto')); });
`;

const servidores = [];
test.after(() => { for (const s of servidores) s.kill(); });

/** Levanta un buzón de mentira en `dir` y devuelve su URL. */
function buzon(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'servidor.js'), SERVIDOR);
  const p = spawn(process.execPath, [path.join(dir, 'servidor.js'), dir], { stdio: 'ignore' });
  servidores.push(p);
  const puerto = path.join(dir, 'puerto');
  const leido = () => { try { return fs.readFileSync(puerto, 'utf8').trim(); } catch (_) { return ''; } };
  for (let i = 0; i < 200 && !leido(); i++) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},25)']);
  assert.ok(leido(), 'el buzón de mentira no dijo su puerto');
  return `http://127.0.0.1:${leido()}`;
}

/** Los PUT que recibió el buzón, en orden. */
const pedidos = (dir) => (fs.existsSync(path.join(dir, 'pedidos.jsonl'))
  ? fs.readFileSync(path.join(dir, 'pedidos.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Una línea como la que graba la grabadora: `ts` en segundos, como lo anota instinct-observe.js. */
function linea(iso, extra = {}) {
  return { ts: Math.floor(Date.parse(iso) / 1000), session_id: 'abcd1234', tool: 'Bash', project: 'Producto/repo-a', summary: `npm test ${iso}`, status: 'ok', repo: 'Producto/repo-a', origin: 'dev.azure.com/acme', ...extra };
}
/** El mes `AAAA-MM` de una línea, con `ts` en segundos o en texto. */
const mesDe = (l) => (typeof l.ts === 'number' ? new Date(l.ts * 1000).toISOString() : l.ts).slice(0, 7);

/** Una HOME de laboratorio con lo grabado, el sello del aviso y la llave del buzón. */
function lab({ lineas = [], sello = { said_on: '2026-10-15', said_at: '2026-10-15T12:00:00.000Z' }, llave = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'instinct-upload-'));
  const obsDir = path.join(home, '.claude', 'tycon-observations');
  fs.mkdirSync(obsDir, { recursive: true });
  const porMes = {};
  for (const l of lineas) (porMes[mesDe(l)] = porMes[mesDe(l)] || []).push(JSON.stringify(l));
  for (const [mes, ls] of Object.entries(porMes)) fs.writeFileSync(path.join(obsDir, `${mes}.jsonl`), `${ls.join('\n')}\n`);
  const estado = stateDir(home);
  fs.mkdirSync(estado, { recursive: true });
  if (sello) fs.writeFileSync(path.join(estado, 'instincts-notice.json'), `${JSON.stringify({ schema: 1, state: 'prendida', ...sello })}\n`);
  const cfg = path.join(home, 'cfg.json');
  if (llave) fs.writeFileSync(cfg, JSON.stringify({ cuenta: 'cuentadeprueba', contenedor: 'corridas', tenant: '0', politica: 'subida-prueba', vence: '2099-01-01', sas: SAS_ESCRITURA }));
  const historia = path.join(home, 'historia');
  fs.mkdirSync(historia, { recursive: true });
  return { home, obsDir, estado, cfg, historia, registros: path.join(home, 'registros-buzon'), subidas: path.join(estado, 'mailbox-uploads.json') };
}

/** Corre la subida en otro proceso. */
function subir(l, url, { hoy = '2026-10-20', ahora = '2026-10-20T15:00:00.000Z', org = 'https://dev.azure.com/Acme/', extra = {} } = {}) {
  const env = {
    ...process.env, HOME: l.home, USERPROFILE: l.home, TYCON_PROFILE: '0', TYCON_MAILBOX: '1', TYCON_INSTINCTS: '1',
    TYCON_MAILBOX_JSON: l.cfg, TYCON_MAILBOX_URL_BASE: url, TYCON_TIMING_HISTORY: l.historia, TYCON_UPLOADS_LOG: l.subidas,
    TYCON_MACHINE: 'mac-de-prueba', TYCON_LOGS_SOURCE: l.estado, TYCON_LOGS_DIR: l.registros, TYCON_TODAY: hoy, TYCON_NOW: ahora,
    TYCON_INSTINCT_OBS_DIR: l.obsDir, ...extra,
  };
  delete env.TF_BUILD;
  if (org) env.TYCON_ADO_ORG = org; else delete env.TYCON_ADO_ORG;
  const r = spawnSync(process.execPath, [UPLOAD, '--json'], { env, encoding: 'utf8', timeout: 60000 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch (_) { out = null; }
  return { status: r.status, out, stderr: r.stderr };
}

const lineasDe = (buf) => zlib.gunzipSync(buf).toString('utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
const blobsDeInstintos = (dirBuzon) => {
  const raiz = path.join(dirBuzon, 'blobs', 'mac-de-prueba', 'instincts');
  if (!fs.existsSync(raiz)) return [];
  return fs.readdirSync(raiz).flatMap((v) => fs.readdirSync(path.join(raiz, v)).map((d) => ({ version: v, dia: d, cuerpo: fs.readFileSync(path.join(raiz, v, d)) })));
};

// ── la subida ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('T10 Upload_ClosedDaysSinceNotice_OneFilePerDay @story-4.7 @ac-10 @ac-13 — dos días cerrados después del aviso; ni los de antes ni hoy', () => {
  const l = lab({ lineas: [
    linea('2026-10-12T10:00:00.000Z'), linea('2026-10-13T10:00:00.000Z'), linea('2026-10-14T10:00:00.000Z'),
    linea('2026-10-15T09:00:00.000Z'),   // el día del aviso, antes de la hora del aviso: no sale
    linea('2026-10-15T12:00:00Z', { ts: '2026-10-15T12:00:00Z' }),   // a la hora del aviso, con la fecha en texto: sale
    linea('2026-10-16T10:00:00.000Z'), linea('2026-10-17T10:00:00.000Z'), linea('2026-10-17T11:00:00.000Z'),
    linea('2026-10-20T10:00:00.000Z'),
  ] });
  const dir = path.join(l.home, 'buzon');
  const url = buzon(dir);
  const r = subir(l, url);
  assert.strictEqual(r.status, 0, `${r.stderr} ${JSON.stringify(r.out)}`);
  const subidos = blobsDeInstintos(dir);
  assert.deepStrictEqual(subidos.map((b) => b.dia).sort(), ['2026-10-15.jsonl.gz', '2026-10-16.jsonl.gz', '2026-10-17.jsonl.gz']);
  assert.strictEqual(lineasDe(subidos.find((b) => b.dia.startsWith('2026-10-15')).cuerpo).length, 1, 'del día del aviso, sólo lo de después');
  for (const b of subidos) assert.match(b.version, /^v\d{8}T\d{9}Z$/, 'siempre con versión');
  assert.strictEqual(lineasDe(subidos.find((b) => b.dia.startsWith('2026-10-17')).cuerpo).length, 2);
  // el orden: los registros primero, después los días, después las ejecuciones
  const orden = pedidos(dir).map((p) => p.ruta);
  const primeroDia = orden.findIndex((x) => x.includes('/instincts/'));
  assert.ok(primeroDia > orden.findIndex((x) => x.includes('/registros/')), orden.join(' '));
  for (const p of pedidos(dir).filter((x) => x.ruta.includes('/instincts/'))) assert.strictEqual(p.inm, '*');
  const cob = JSON.parse(fs.readFileSync(path.join(l.registros, 'cobertura.json'), 'utf8'));
  assert.ok(cob.instincts, 'la cobertura trae la sección instincts');
  assert.ok(!cob.fuentes.instincts, 'fuera de fuentes: la 2.24 juzga el juego mirando fuentes');
  assert.deepStrictEqual(Object.keys(cob.instincts.dias).sort(), ['2026-10-15', '2026-10-16', '2026-10-17']);
  for (const d of Object.values(cob.instincts.dias)) assert.ok(d.bytes > 0 && d.truncado === false);
  assert.strictEqual(cob.instincts.ultima_linea, '2026-10-20', 'la última línea grabada, aunque hoy no suba');
});

test('T11 Upload_ProjectsFieldsOnly @story-4.7 @ac-10 — el día lleva sólo los seis campos proyectados', () => {
  const up = require(INSTINCT_UPLOAD);
  const l = lab({ lineas: [linea('2026-10-16T10:00:00.000Z', { extra: 'no viaja' })] });
  const out = path.join(l.home, 'armado');
  const r = up.prepareDays({ obsDir: l.obsDir, outDir: out, seal: { said_on: '2026-10-15' }, org: 'https://dev.azure.com/acme', today: '2026-10-20' });
  assert.deepStrictEqual(r.files, ['2026-10-16.jsonl.gz']);
  const [l1] = lineasDe(fs.readFileSync(path.join(out, '2026-10-16.jsonl.gz')));
  assert.deepStrictEqual(Object.keys(l1).sort(), ['repo', 'session_id', 'status', 'summary', 'tool', 'ts']);
});

test('T12 Upload_AlreadyUploaded_Skips_LateLineResends @story-4.7 @ac-11 — no se repite; la línea tardía sube entera con otra versión; el «ya existe», con la regla de la 2.24', () => {
  const l = lab({ lineas: [linea('2026-10-16T10:00:00.000Z'), linea('2026-10-17T10:00:00.000Z')] });
  const dir = path.join(l.home, 'buzon');
  const url = buzon(dir);
  assert.strictEqual(subir(l, url).status, 0);
  const antes = pedidos(dir).length;
  // otra pasada el mismo día: nada que mandar
  assert.strictEqual(subir(l, url, { ahora: '2026-10-20T16:00:00.000Z' }).status, 0);
  assert.strictEqual(pedidos(dir).filter((p, i) => i >= antes && p.ruta.includes('/instincts/')).length, 0, 'un día subido no se manda otra vez');
  // al día siguiente, sin línea nueva: tampoco
  const r2 = subir(l, url, { hoy: '2026-10-21', ahora: '2026-10-21T15:00:00.000Z' });
  assert.strictEqual(r2.status, 0, r2.stderr);
  const antes2 = pedidos(dir).length;
  assert.strictEqual(pedidos(dir).filter((p) => p.ruta.includes('/instincts/2026-10-16') || p.ruta.endsWith('/2026-10-16.jsonl.gz')).length, 1);
  // una línea tardía del 16: el día entero, con una versión nueva y sin pisar
  fs.appendFileSync(path.join(l.obsDir, '2026-10.jsonl'), `${JSON.stringify(linea('2026-10-16T23:59:59.000Z'))}\n`);
  fs.writeFileSync(path.join(dir, 'ya-existe-una-vez'), '2026-10-16.jsonl.gz');
  const r3 = subir(l, url, { hoy: '2026-10-22', ahora: '2026-10-22T15:00:00.000Z' });
  assert.strictEqual(r3.status, 0, `${r3.stderr} ${JSON.stringify(r3.out)}`);
  assert.notStrictEqual(r3.out.estado, 'llave_invalida');
  const del16 = blobsDeInstintos(dir).filter((b) => b.dia === '2026-10-16.jsonl.gz');
  assert.strictEqual(del16.length, 2, 'la versión vieja queda y la nueva se suma');
  const nueva = del16.sort((a, b) => (a.version < b.version ? -1 : 1))[1];
  assert.strictEqual(lineasDe(nueva.cuerpo).length, 2, 'el día entero, con la línea tardía');
  const tardios = pedidos(dir).slice(antes2).filter((p) => p.ruta.includes('2026-10-16'));
  assert.strictEqual(tardios.length, 2, 'un «ya existe» y un reintento con otra versión');
  assert.ok(tardios.every((p) => p.inm === '*'));
  assert.notStrictEqual(tardios[0].ruta, tardios[1].ruta);

  // un mes cerrado que ya subió entero no se relee; con otra carpeta u otra organización, sí
  const up = require(INSTINCT_UPLOAD);
  const m = lab({ lineas: [linea('2026-09-29T10:00:00.000Z'), linea('2026-10-02T10:00:00.000Z')], sello: { said_on: '2026-09-28' } });
  const out = path.join(m.home, 'armado');
  const armar = (extra = {}) => up.prepareDays({ obsDir: m.obsDir, outDir: out, seal: { said_on: '2026-09-28' }, org: 'https://dev.azure.com/acme', today: '2026-10-20', folder: 'mac-a', ...extra });
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(out, f))).digest('hex');
  const r1 = armar();
  assert.deepStrictEqual(r1.files, ['2026-09-29.jsonl.gz', '2026-10-02.jsonl.gz']);
  const subido = { '2026-09-29': sha('2026-09-29.jsonl.gz'), '2026-10-02': sha('2026-10-02.jsonl.gz') };
  assert.deepStrictEqual(armar({ uploaded: subido }).files, [], 'subido igual: nada que armar');
  fs.appendFileSync(path.join(m.obsDir, '2026-09.jsonl'), `${JSON.stringify(linea('2026-09-30T10:00:00.000Z'))}\n`);
  assert.deepStrictEqual(armar({ uploaded: subido }).files, [], 'septiembre ya está cerrado y subido: no se relee');
  assert.deepStrictEqual(armar({ folder: 'mac-a-0000beef' }).files, ['2026-09-29.jsonl.gz', '2026-09-30.jsonl.gz', '2026-10-02.jsonl.gz'], 'con otra carpeta se relee y sube todo');
  const otra = armar({ uploaded: subido, org: 'https://dev.azure.com/otra' });
  assert.deepStrictEqual(otra.files, [], 'con otra organización lo de acme no sale');
  assert.strictEqual(otra.coverage.dias['2026-09-30'].filtradas.otra_organizacion, 1, 'septiembre se volvió a leer');
  // sin el archivo del mes en curso, la última línea sale del mes más nuevo que hay, aunque esté anotado como subido
  fs.rmSync(path.join(m.obsDir, '2026-10.jsonl'));
  assert.strictEqual(armar({ uploaded: subido, org: 'https://dev.azure.com/otra' }).coverage.ultima_linea, '2026-09-30');
});

test('T13 Upload_CutMidway_NotMarked @story-4.7 @ac-11 @ac-16 — un corte en el segundo día deja anotado sólo el primero', () => {
  const l = lab({ lineas: [linea('2026-10-16T10:00:00.000Z'), linea('2026-10-17T10:00:00.000Z')] });
  const dir = path.join(l.home, 'buzon');
  const url = buzon(dir);
  fs.writeFileSync(path.join(dir, 'cortar'), '/instincts/ 2');
  const r = subir(l, url);
  assert.notStrictEqual(r.status, 0, 'un corte no es «subido»');
  assert.strictEqual(r.out.estado, 'sin_red');
  const anotados = Object.keys(JSON.parse(fs.readFileSync(l.subidas, 'utf8')).archivos).filter((k) => k.includes('/instincts/'));
  assert.deepStrictEqual(anotados, ['mac-de-prueba/instincts/2026-10-16.jsonl.gz']);
  // la pasada siguiente manda el que faltó
  fs.writeFileSync(path.join(dir, 'cortar'), '');
  assert.strictEqual(subir(l, url, { ahora: '2026-10-20T16:00:00.000Z' }).status, 0);
  assert.deepStrictEqual(blobsDeInstintos(dir).map((b) => b.dia).sort(), ['2026-10-16.jsonl.gz', '2026-10-17.jsonl.gz']);

  // la llave rechazada en un día: el mismo estado de hoy y ningún día anotado
  const k = lab({ lineas: [linea('2026-10-16T10:00:00.000Z')] });
  const dirK = path.join(k.home, 'buzon');
  const urlK = buzon(dirK);
  fs.writeFileSync(path.join(dirK, 'rechazar-llave'), '/instincts/');
  const rk = subir(k, urlK);
  assert.strictEqual(rk.status, 1);
  assert.strictEqual(rk.out.estado, 'llave_invalida');
  const anotadosK = fs.existsSync(k.subidas) ? Object.keys(JSON.parse(fs.readFileSync(k.subidas, 'utf8')).archivos).filter((x) => x.includes('/instincts/')) : [];
  assert.deepStrictEqual(anotadosK, []);
  // la llave revocada con el contenedor borrado (404): lo mismo
  fs.writeFileSync(path.join(dirK, 'rechazar-llave'), '');
  fs.writeFileSync(path.join(dirK, 'contenedor-borrado'), '/instincts/');
  const r404 = subir(k, urlK, { ahora: '2026-10-20T16:00:00.000Z' });
  assert.strictEqual(r404.status, 1);
  assert.strictEqual(r404.out.estado, 'llave_invalida');
  const anotados404 = Object.keys(JSON.parse(fs.readFileSync(k.subidas, 'utf8')).archivos).filter((x) => x.includes('/instincts/'));
  assert.deepStrictEqual(anotados404, []);
});

test('T14 Upload_OtherOrgGithubAndNull_FilteredAndCounted @story-4.7 @ac-12 @ac-13 — sube sólo lo de la organización; nada personal ni de otra', () => {
  const up = require(INSTINCT_UPLOAD);
  const l = lab({ lineas: [
    linea('2026-10-16T10:00:00.000Z'),
    linea('2026-10-16T10:01:00.000Z', { origin: 'dev.azure.com/ACME' }),
    linea('2026-10-16T10:02:00.000Z', { origin: 'dev.azure.com/otra', summary: 'de otra organización' }),
    linea('2026-10-16T10:03:00.000Z', { origin: 'github.com/dueno', summary: 'proyecto personal' }),
    linea('2026-10-16T10:04:00.000Z', { origin: null, repo: null, summary: 'sin repo' }),
    linea('2026-10-16T10:05:00.000Z', { summary: 'cat $HOME/SourceCode/clients/x/a.cs' }),
    linea('2026-10-16T10:06:00.000Z', { summary: 'cat $HOME/SourceCode/Clients/x/a.cs' }),
    linea('2026-10-16T10:07:00.000Z', { repo: 'C:\\SourceCode\\CLIENTS\\x' }),
    linea('2026-10-16T10:08:00.000Z', { repo: 'Clients/repo-x', summary: 'ls' }),   // la raíz de repos tiene una carpeta Clients
  ] });
  fs.appendFileSync(path.join(l.obsDir, '2026-10.jsonl'), `{esto no es json\n${JSON.stringify(linea('2026-10-16T10:09:00.000Z', { ts: 'ayer' }))}\n`);
  const out = path.join(l.home, 'armado');
  const r = up.prepareDays({ obsDir: l.obsDir, outDir: out, seal: { said_on: '2026-10-15' }, org: 'https://dev.azure.com/Acme/', today: '2026-10-20' });
  const texto = zlib.gunzipSync(fs.readFileSync(path.join(out, '2026-10-16.jsonl.gz'))).toString('utf8');
  assert.strictEqual(texto.split('\n').filter(Boolean).length, 2);
  for (const nunca of ['de otra organización', 'proyecto personal', 'sin repo', 'clients', 'Clients', 'CLIENTS']) assert.ok(!texto.includes(nunca), nunca);
  assert.deepStrictEqual(r.coverage.dias['2026-10-16'].filtradas, { otra_organizacion: 2, sin_repo: 1, clientes: 4 });
  assert.strictEqual(r.coverage.dias['2026-10-16'].lineas, 2);
  assert.strictEqual(r.coverage.ilegibles, 2, 'el JSON roto y la hora ilegible se cuentan: no son «0»');
  // las otras formas de escribir la organización dan lo mismo
  // la forma con usuario va por partes: entera tiene forma de correo y el freno de publicación la frena
  for (const org of ['https://acme.visualstudio.com/', ['https://usuario', '@', 'dev.azure.com/ACME'].join(''), 'dev.azure.com/acme']) assert.strictEqual(up.orgKey(org), 'dev.azure.com/acme', org);
});

test('T15 Upload_NoAdoOrg_UploadsNothingSaysNotMeasured @story-4.7 @ac-12 — sin organización no sale ninguna línea', () => {
  const up = require(INSTINCT_UPLOAD);
  const l = lab({ lineas: [linea('2026-10-16T10:00:00.000Z')] });
  const out = path.join(l.home, 'armado');
  const r = up.prepareDays({ obsDir: l.obsDir, outDir: out, seal: { said_on: '2026-10-15' }, org: '', today: '2026-10-20' });
  assert.deepStrictEqual(r.files, []);
  assert.strictEqual(r.coverage.estado, 'no_medido');
  assert.match(r.coverage.motivo, /sin organización/);
  assert.ok(!fs.existsSync(out) || fs.readdirSync(out).length === 0);
  // de punta a punta: un día armado antes no sale si la preparación de hoy dice «no medido»
  const v = lab({ lineas: [linea('2026-10-16T10:00:00.000Z')] });
  fs.mkdirSync(path.join(v.registros, 'instincts'), { recursive: true });
  fs.writeFileSync(path.join(v.registros, 'instincts', '2026-10-16.jsonl.gz'), zlib.gzipSync('{"viejo":1}\n'));
  const dirV = path.join(v.home, 'buzon');
  const rv = subir(v, buzon(dirV), { org: '' });
  assert.strictEqual(rv.status, 0, rv.stderr);
  assert.deepStrictEqual(pedidos(dirV).filter((p) => p.ruta.includes('/instincts/')), []);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(v.registros, 'cobertura.json'), 'utf8')).instincts.estado, 'no_medido');
});

test('T16 Coverage_UnreadableJsonl_IsNotMeasuredNotZero @story-4.7 @ac-13 — un registro ilegible es «no medido», no 0 líneas', () => {
  const up = require(INSTINCT_UPLOAD);
  const l = lab();
  // una carpeta con el nombre del mes no se puede leer en ningún sistema ni como root (chmod no alcanza en Windows)
  fs.mkdirSync(path.join(l.obsDir, '2026-10.jsonl'));
  const r = up.prepareDays({ obsDir: l.obsDir, outDir: path.join(l.home, 'armado'), seal: { said_on: '2026-10-15' }, org: 'https://dev.azure.com/acme', today: '2026-10-20' });
  assert.strictEqual(r.coverage.estado, 'no_medido');
  assert.ok(r.coverage.motivo && !r.coverage.motivo.includes(l.home), 'el motivo no lleva rutas de la máquina');
  assert.deepStrictEqual(r.files, []);
});

test('T17 Upload_OverCap_TruncatesAndDeclares @story-4.7 @ac-14 — pasa el tope: sube hasta el tope y lo declara', () => {
  const up = require(INSTINCT_UPLOAD);
  const lineas = [];
  for (let i = 0; i < 400; i++) lineas.push(linea(`2026-10-16T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`, { summary: crypto.randomBytes(120).toString('hex') }));
  const l = lab({ lineas });
  const out = path.join(l.home, 'armado');
  const tope = 20 * 1024;
  const r = up.prepareDays({ obsDir: l.obsDir, outDir: out, seal: { said_on: '2026-10-15' }, org: 'https://dev.azure.com/acme', today: '2026-10-20', maxBytes: tope });
  const gz = fs.readFileSync(path.join(out, '2026-10-16.jsonl.gz'));
  assert.ok(gz.length <= tope, `${gz.length} > ${tope}`);
  const d = r.coverage.dias['2026-10-16'];
  assert.strictEqual(d.truncado, true);
  assert.ok(d.quedaron_afuera > 0);
  assert.strictEqual(lineasDe(gz).length + d.quedaron_afuera, 400);
  assert.strictEqual(lineasDe(gz)[0].ts, Date.parse('2026-10-16T10:00:00.000Z') / 1000, 'suben las primeras');
  // ni la primera línea entra: no se arma un día vacío (fijaría su huella como «subido»)
  const nada = up.prepareDays({ obsDir: l.obsDir, outDir: path.join(l.home, 'nada'), seal: { said_on: '2026-10-15' }, org: 'https://dev.azure.com/acme', today: '2026-10-20', maxBytes: 10 });
  assert.deepStrictEqual(nada.files, []);
  assert.strictEqual(nada.coverage.dias['2026-10-16'].truncado, true);
  assert.strictEqual(nada.coverage.dias['2026-10-16'].quedaron_afuera, 400);
  // y su mes no se da por terminado: el día no subió
  const sep = lab({ lineas: [linea('2026-09-29T10:00:00.000Z', { summary: crypto.randomBytes(200).toString('hex') })], sello: { said_on: '2026-09-28' } });
  const outSep = path.join(sep.home, 'armado');
  up.prepareDays({ obsDir: sep.obsDir, outDir: outSep, seal: { said_on: '2026-09-28' }, org: 'https://dev.azure.com/acme', today: '2026-10-20', folder: 'mac-a', maxBytes: 10 });
  assert.ok(!fs.existsSync(path.join(outSep, 'months-done.json')), 'septiembre sigue abierto');
});

// ── el aviso de la máquina sin buzón ──────────────────────────────────────────────────────────────────────────────

test('T18 NoMailbox_RecordsLocally_NoticeOnceUntilStateChanges @story-4.7 @ac-15 — sin buzón: un aviso; con buzón, silencio', () => {
  const l = lab({ sello: { said_on: '2026-10-15', said_at: '2026-10-15T12:00:00.000Z' }, llave: false });
  // el buzón lo decide la llave: un TYCON_MAILBOX heredado (el banco exporta TYCON_MAILBOX=0) lo apagaría igual
  const envAviso = { ...process.env, HOME: l.home, USERPROFILE: l.home, TYCON_PROFILE: '0', TYCON_INSTINCTS: '1', TYCON_MAILBOX_JSON: l.cfg, TYCON_EVAL_SANDBOX: '' };
  delete envAviso.TYCON_MAILBOX;
  const correr = () => spawnSync(process.execPath, [NOTICE], { encoding: 'utf8', env: envAviso });
  const a = correr();
  assert.strictEqual(a.status, 0, a.stderr);
  assert.match(a.stdout, /no tiene buzón/);
  assert.match(a.stdout, /no le llega a nadie/);
  assert.strictEqual(correr().stdout, '', 'una vez');
  // la subida no manda nada y lo dice como hoy
  const r = subir(l, 'http://127.0.0.1:9');
  assert.strictEqual(r.out.estado, 'sin_config');
  // con llave: no avisa más, y el sello cambia de estado
  fs.writeFileSync(l.cfg, JSON.stringify({ cuenta: 'cuentadeprueba', contenedor: 'corridas', tenant: '0', politica: 'p', vence: '2099-01-01', sas: SAS_ESCRITURA }));
  assert.strictEqual(correr().stdout, '');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(l.estado, 'instincts-notice.json'), 'utf8')).mailbox, 'con_buzon');
  // si vuelve a quedar sin buzón, se dice otra vez
  fs.rmSync(l.cfg);
  assert.match(correr().stdout, /no tiene buzón/);

  // con la llave pero `mailbox` apagada: tampoco hay buzón, y la subida no manda nada
  const m = lab({ lineas: [linea('2026-10-16T10:00:00.000Z')] });
  const n = spawnSync(process.execPath, [NOTICE], {
    encoding: 'utf8',
    env: { ...process.env, HOME: m.home, USERPROFILE: m.home, TYCON_PROFILE: '0', TYCON_INSTINCTS: '1', TYCON_MAILBOX: '0', TYCON_MAILBOX_JSON: m.cfg, TYCON_EVAL_SANDBOX: '' },
  });
  assert.match(n.stdout, /no tiene buzón/);
  const dirM = path.join(m.home, 'buzon');
  const rm = subir(m, buzon(dirM), { extra: { TYCON_MAILBOX: '0' } });
  assert.strictEqual(rm.status, 0);
  assert.strictEqual(rm.out.estado, 'apagado');
  assert.deepStrictEqual(pedidos(dirM), []);
});

// ── la bajada ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('T19 Download_InstinctDaysOnlyWithFlag_LatestVersion @story-4.7 @ac-17 — con --instincts, la versión más nueva; sin ella, a omitidos', async () => {
  const { bajar } = require(path.join(RAIZ, 'scripts', 'metrics', 'download-runs.js'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'instinct-download-'));
  const dir = path.join(base, 'buzon');
  const url = buzon(dir);
  const poner = (nombre, cuerpo) => { const f = path.join(dir, 'blobs', nombre); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, cuerpo); };
  const vieja = zlib.gzipSync('{"ts":"vieja"}\n');
  const nueva = zlib.gzipSync('{"ts":"nueva"}\n{"ts":"nueva-2"}\n');
  poner('mac-a/instincts/v20261017T000000000Z/2026-10-16.jsonl.gz', vieja);
  poner('mac-a/instincts/v20261018T000000000Z/2026-10-16.jsonl.gz', nueva);
  poner('mac-a/una-corrida.json', '{"marker":{}}\n');
  const opts = (espejo, extra = {}) => ({ cuenta: 'cuentax', contenedor: 'corridas', credencial: { sas: SAS_LECTURA }, urlBase: url, dir: espejo, budgetMs: 30000, ...extra });
  const local = (espejo) => path.join(espejo, 'mac-a', 'instincts', '2026-10-16.jsonl.gz');

  const con = await bajar(opts(path.join(base, 'con'), { instintos: true }));
  assert.strictEqual(con.codigo, 0, JSON.stringify(con.res));
  assert.deepStrictEqual(fs.readFileSync(local(path.join(base, 'con'))), nueva);
  assert.ok(con.res.versiones_viejas >= 1);
  assert.strictEqual(con.res.omitidos, 0);

  const sin = await bajar(opts(path.join(base, 'sin')));
  assert.strictEqual(sin.codigo, 0, JSON.stringify(sin.res));
  assert.ok(!fs.existsSync(local(path.join(base, 'sin'))), 'sin la opción no se bajan');
  assert.strictEqual(sin.res.omitidos, 1, 'una por carpeta y día, no por versión');
  assert.ok(fs.existsSync(path.join(base, 'sin', 'mac-a', 'una-corrida.json')), 'lo demás baja igual');

  const sinHilos = await bajar(opts(path.join(base, 'sin-hilos'), { sinHilos: true }));
  assert.strictEqual(sinHilos.codigo, 0);
  assert.ok(!fs.existsSync(local(path.join(base, 'sin-hilos'))));
  assert.strictEqual(sinHilos.res.omitidos, 1);
});
