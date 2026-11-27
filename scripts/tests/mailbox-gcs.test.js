'use strict';
/*
 * mailbox-gcs.test.js — el buzón de ejecuciones sobre Google Cloud Storage.
 *
 * El conector vive en integrations/gcs/ con el tipo de integración `mailbox`; el núcleo no lo nombra. Sin red: Cloud
 * Storage y su servidor de metadatos son un doble en 127.0.0.1 (lib/fake-gcs.js) que verifica la firma GOOG4-HMAC-SHA256
 * con su propia receta. La subida corre como proceso aparte con una casa falsa (HOME) y la llave, el registro de
 * ejecuciones y el registro de subidas fabricados (TYCON_MAILBOX_JSON, TYCON_TIMING_HISTORY, TYCON_UPLOADS_LOG,
 * TYCON_MACHINE); la dirección del doble va en TYCON_MAILBOX_URL_BASE, la misma que usan las pruebas de Azure. El sitio
 * llama al conector con la dirección del doble y GCE_METADATA_HOST apuntando a él.
 *
 * T5 está en site-config.test.js, junto a los casos de Azure de la pantalla. Que Azure no cambia lo dicen sus propias
 * suites (upload-runs, download-runs, site-sources, site-runs y site-config), que corren tal cual.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FAKE = require('./lib/fake-gcs.js');
const SUBIR = path.join(ROOT, 'scripts', 'metrics', 'upload-runs.js');
const BAJAR = path.join(ROOT, 'scripts', 'metrics', 'download-runs.js');
const CONECTOR = path.join(ROOT, 'integrations', 'gcs', 'scripts', 'mailbox.js');
const MANIFIESTO = path.join(ROOT, 'integrations', 'gcs', 'integration.json');

const BUCKET = 'acme-buzon-lab';
const ACCESS = 'GOOG1EPRUEBADEJUGUETENOESREAL0000000000';
// un secreto de juguete con la forma de uno real (base64 de 40 caracteres), armado acá para que se lea que no es real
const SECRETO = Buffer.from('secretoDePruebaNoEsReal000000').toString('base64');
const CORRIDA = '1.1-2026-11-20T1010.json';

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const conector = () => require(CONECTOR);

/** La llave gcs, con lo que cada caso cambie. */
function llaveGcs(extra = {}) {
  return { provider: 'gcs', bucket: BUCKET, accessId: ACCESS, secret: SECRETO, vence: '2099-12-31', rotar: 'desactivar la clave HMAC en la consola y crear otra', ...extra };
}

/** Una máquina de mentira: su casa, su registro de ejecuciones con una corrida y la llave. */
function maquina(fake, llave = llaveGcs()) {
  const base = tmp('gcs-maq-');
  const home = path.join(base, 'home');
  const hist = path.join(base, 'historia');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hist, { recursive: true });
  fs.writeFileSync(path.join(hist, CORRIDA), JSON.stringify({ archivedAt: '2026-11-20T10:10:00Z', marker: { sessionId: 's1' } }));
  const llaveRuta = path.join(base, 'corridas-buzon.json');
  fs.writeFileSync(llaveRuta, JSON.stringify(llave));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^TYCON_|^TF_BUILD$|^GCE_METADATA_HOST$|^ADO_ORG$/.test(k)) delete env[k];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_PROFILE: '0',
    TYCON_MAILBOX: '1', TYCON_MAILBOX_JSON: llaveRuta, TYCON_MAILBOX_URL_BASE: fake ? fake.url : 'http://127.0.0.1:1',
    TYCON_TIMING_HISTORY: hist, TYCON_UPLOADS_LOG: path.join(base, 'estado', 'mailbox-uploads.json'),
    TYCON_LOGS_DIR: path.join(base, 'registros'), TYCON_MERGES_DIR: path.join(base, 'merges'), TYCON_MACHINE: 'maq-a', TYCON_WORKDAYS: '0',
  });
  return { base, home, hist, env, registro: path.join(base, 'estado', 'mailbox-uploads.json') };
}

/**
 * Corre un guion como proceso aparte, SIN trabar este proceso: el doble de Cloud Storage vive acá y tiene que poder
 * contestarle (con spawnSync el hijo esperaría a un servidor que nunca atiende).
 */
function correr(guion, m, args = []) {
  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, [guion, '--json', ...args], { env: m.env });
    let out = '';
    let err = '';
    const reloj = setTimeout(() => hijo.kill('SIGKILL'), 60000);
    hijo.stdout.on('data', (c) => { out += c; });
    hijo.stderr.on('data', (c) => { err += c; });
    hijo.on('close', (codigo) => {
      clearTimeout(reloj);
      let res = null;
      try { res = JSON.parse(out); } catch (_) { /* abajo */ }
      resolve({ codigo, res, salida: `${out}\n${err}` });
    });
  });
}
const subir = (m, args) => correr(SUBIR, m, args);
const anotados = (m) => { try { return Object.keys(JSON.parse(fs.readFileSync(m.registro, 'utf8')).archivos); } catch (_) { return []; } };
const puts = (fake) => fake.pedidos.filter((p) => p.metodo === 'PUT');

// ── el núcleo y el tipo de integración ─────────────────────────────────────────────────────────────────────────

test('T1 Mailbox_GcsConnector_CoreNeutral @story-1.3 @ac-1 — el candado toma las señales del conector de buzón y el núcleo no las nombra', () => {
  const repo = tmp('gcs-candado-');
  const git = (...a) => { const r = spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr); return r; };
  git('init', '-q');
  const copiar = (rel) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.copyFileSync(path.join(ROOT, rel), path.join(repo, rel)); };
  // el conector, la lista del candado y los archivos del núcleo que la historia toca
  const nucleo = ['scripts/lib/integrations.js', 'scripts/metrics/upload-runs.js', 'scripts/metrics/download-runs.js', 'scripts/site/sources.js', 'scripts/site/server.js',
    'scripts/lib/operations-config.js', 'scripts/lib/org-config.js', 'scripts/site/tabs/config.js', 'scripts/setup/harness/team-config.js', 'scripts/lib/night-data.js', 'scripts/site/texts.js'];
  for (const rel of ['integrations/gcs/integration.json', 'integrations/gcs/scripts/mailbox.js', 'guides/integrations/gcs-mailbox.md', ...nucleo]) copiar(rel);
  fs.mkdirSync(path.join(repo, 'scripts', 'ci'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'ci', 'neutrality-allowlist.json'), JSON.stringify({ signals_at_least: 4, entries: [] }));
  git('add', '-A');
  const { check } = require(path.join(ROOT, 'scripts', 'ci', 'check-core-neutrality.js'));
  const r = check({ repo });
  assert.deepStrictEqual(r.problems, [], 'el árbol con el conector gcs pasa: el núcleo no nombra sus hosts ni sus cabeceras');
  // un archivo del núcleo de prueba que nombra el host
  fs.writeFileSync(path.join(repo, 'scripts', 'lib', 'nombra-el-host.js'), "const u = 'https://storage.googleapis.com/b/o';\n");
  git('add', '-A');
  const mal = check({ repo });
  assert.strictEqual(mal.ok, false);
  assert.ok(mal.problems.some((p) => p.includes('scripts/lib/nombra-el-host.js:1')), mal.problems.join('\n'));
});

test('T2 Mailbox_IntegrationKind_Mailbox @story-1.3 @ac-1 — integrations/gcs/integration.json es un conector de tipo mailbox', () => {
  const I = require(path.join(ROOT, 'scripts', 'lib', 'integrations.js'));
  const { manifests, problems } = I.listManifests({ dir: path.join(ROOT, 'integrations') });
  assert.ok(!problems.some((p) => p.name === 'gcs'), JSON.stringify(problems));
  const m = manifests.find((x) => x.name === 'gcs');
  assert.ok(m, 'el manifiesto de gcs se lee');
  assert.strictEqual(m.kind, 'mailbox');
  assert.strictEqual(m.provider, 'gcs');
  assert.strictEqual(m.connector, 'scripts/mailbox.js');
  assert.ok(m.hardSignals.length >= 4, 'declara sus señales duras');
  assert.strictEqual(typeof I.mailboxConnector, 'function');
  assert.strictEqual(I.mailboxConnector('gcs').PROVEEDORES_DE_BUZON[0], 'gcs');
  assert.strictEqual(I.mailboxConnector('s3'), null);
  // con otras mayúsculas el tipo no se encontraría nunca
  const otro = tmp('gcs-ints-');
  fs.mkdirSync(path.join(otro, 'gcs'));
  fs.writeFileSync(path.join(otro, 'gcs', 'integration.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(MANIFIESTO, 'utf8')), kind: 'Mailbox' }));
  const r = I.listManifests({ dir: otro });
  assert.ok(r.problems.some((p) => p.name === 'gcs' && p.reasons.includes('«kind» se escribe mailbox')), JSON.stringify(r.problems));
});

// ── el perfil del equipo: site.mailbox ──────────────────────────────────────────────────────────────────────────

// el lector del perfil no carga integraciones: se las da quien tiene el arnés completo (como el sitio y la pantalla)
const OPS = () => { const o = require(path.join(ROOT, 'scripts', 'lib', 'operations-config.js')); require(path.join(ROOT, 'scripts', 'lib', 'integrations.js')).giveMailboxConnectors(o); return o; };
const problemasDelBuzon = (mailbox) => OPS().parse(JSON.stringify({ version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'], mailbox } })).problems;

test('T3 SiteMailbox_GcsShape_Valid @story-1.3 @ac-2 — site.mailbox gcs con su bucket es válido', () => {
  assert.deepStrictEqual(problemasDelBuzon({ provider: 'gcs', bucket: BUCKET, threads: true }), []);
  assert.ok(OPS().MAILBOX_PROVIDERS.includes('gcs') && OPS().MAILBOX_PROVIDERS.includes('azure-blob'), 'la pantalla los ofrece a los dos');
  assert.deepStrictEqual(OPS().mailboxFields('gcs'), ['bucket']);
  assert.deepStrictEqual(OPS().mailboxFields('azure-blob'), ['account', 'container']);
});

test('T4 SiteMailbox_GcsShape_Rejected @story-1.3 @ac-2 — cada forma mala es un problema con su ruta', () => {
  const rutas = (mb) => problemasDelBuzon(mb).map((p) => p.path);
  assert.deepStrictEqual(rutas({ provider: 'gcs', bucket: 'Sils-Lab' }), ['site.mailbox.bucket'], 'mayúsculas');
  assert.deepStrictEqual(rutas({ provider: 'gcs', bucket: 'ab' }), ['site.mailbox.bucket'], 'dos letras');
  assert.deepStrictEqual(rutas({ provider: 'gcs', bucket: BUCKET, account: 'acmeruns' }), ['site.mailbox.account'], 'una clave de Azure');
  assert.deepStrictEqual(rutas({ provider: 's3', bucket: BUCKET }), ['site.mailbox.provider'], 'proveedor desconocido');
});

// ── la llave ───────────────────────────────────────────────────────────────────────────────────────────────────

test('T6 MailboxKey_NoProvider_IsAzure @story-1.3 @ac-3 — una llave de hoy, sin provider, se lee como siempre', () => {
  const { leerConfig } = require(SUBIR);
  const d = tmp('gcs-llave-');
  const ruta = path.join(d, 'corridas-buzon.json');
  fs.writeFileSync(ruta, JSON.stringify({ cuenta: 'acmeruns', contenedor: 'corridas', sas: '?si=solo-crear&sig=abc', vence: '2099-01-01' }));
  const r = leerConfig(undefined, ruta);
  assert.ok(r.cfg, JSON.stringify(r));
  assert.deepStrictEqual([r.cfg.cuenta, r.cfg.contenedor, r.cfg.sas], ['acmeruns', 'corridas', 'si=solo-crear&sig=abc']);
  assert.strictEqual(r.cfg.provider, undefined, 'la de Azure no gana campos');
  fs.writeFileSync(ruta, JSON.stringify({ cuenta: 'ACME', contenedor: 'corridas', sas: 'sig=x', vence: '2099-01-01' }));
  assert.deepStrictEqual(leerConfig(undefined, ruta), { estado: 'config_ilegible', motivo: `${ruta}: "cuenta" no tiene la forma de una cuenta de almacenamiento` }, 'el mismo motivo de hoy');
});

test('T7 MailboxKey_Gcs_ValidAndBroken @story-1.3 @ac-3 — la llave gcs se valida y el secreto no sale en ningún motivo', () => {
  const { leerConfig, negativaDeLaLlaveDe } = require(SUBIR);
  const d = tmp('gcs-llave-');
  const ruta = path.join(d, 'corridas-buzon.json');
  const leer = (llave) => { fs.writeFileSync(ruta, JSON.stringify(llave)); return leerConfig(undefined, ruta); };
  const buena = leer(llaveGcs());
  assert.ok(buena.cfg, JSON.stringify(buena));
  assert.deepStrictEqual([buena.cfg.provider, buena.cfg.bucket, buena.cfg.destino, buena.cfg.vence], ['gcs', BUCKET, `gcs/${BUCKET}`, '2099-12-31']);
  assert.strictEqual(negativaDeLaLlaveDe(buena.cfg), null, 'la negativa de la SAS de Azure no le aplica');
  const malas = [
    ['sin secret', (() => { const l = llaveGcs(); delete l.secret; return l; })(), /secret/],
    ['vence imposible', llaveGcs({ vence: '2026-13-45' }), /vence/],
    ['el secreto en vence', llaveGcs({ vence: SECRETO }), /vence/],
    ['el secreto en el bucket', llaveGcs({ bucket: SECRETO }), /bucket/],
    ['secreto con espacios', llaveGcs({ secret: `${SECRETO} x` }), /secret/],
    ['sin rotar', (() => { const l = llaveGcs(); delete l.rotar; return l; })(), /rotar/],
  ];
  for (const [caso, llave, campo] of malas) {
    const r = leer(llave);
    assert.strictEqual(r.estado, 'config_ilegible', caso);
    assert.match(r.motivo, campo, `${caso}: dice el campo`);
    assert.ok(!r.motivo.includes(SECRETO), `${caso}: el secreto no aparece en el motivo`);
  }
  // un proveedor sin conector, y un campo de más: el motivo no repite el valor ni el nombre (podrían ser el secreto)
  const otro = leer({ ...llaveGcs(), provider: SECRETO });
  assert.strictEqual(otro.estado, 'config_ilegible');
  assert.match(otro.motivo, /ningún conector de buzón/);
  assert.ok(!otro.motivo.includes(SECRETO), 'el valor de provider no aparece');
  const deMas = leer({ ...llaveGcs(), [SECRETO]: 'x' });
  assert.strictEqual(deMas.estado, 'config_ilegible');
  assert.match(deMas.motivo, /campo que no es de una llave gcs/);
  assert.ok(!deMas.motivo.includes(SECRETO), 'el nombre del campo de más no aparece');
});

// ── la subida ──────────────────────────────────────────────────────────────────────────────────────────────────

test('T8 UploadGcs_Create_SignedWithPrecondition @story-1.3 @ac-4 — cada PUT firmado, con precondición y Content-MD5; se anota recién con el 200', async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    const m = maquina(fake);
    const r = await subir(m);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.strictEqual(r.res.estado, 'subido');
    const p = puts(fake);
    assert.ok(p.length >= 1, 'subió algo');
    assert.strictEqual(fake.pedidos[0].metodo, 'GET', 'primero el listado de prueba');
    for (const x of p) {
      assert.strictEqual(x.firmaValida, true, `${x.objeto}: la firma valida`);
      assert.strictEqual(x.precondicion, '0', `${x.objeto}: x-goog-if-generation-match: 0`);
      assert.ok(x.cabeceras['content-md5'], `${x.objeto}: Content-MD5`);
      assert.ok(x.firmadas.split(';').includes('x-goog-if-generation-match') && x.firmadas.split(';').includes('content-md5'), 'la precondición y el md5 van firmados');
    }
    assert.ok(fake.objetos.has(`maq-a/${CORRIDA}`), 'la corrida con el nombre de siempre');
    assert.ok(anotados(m).includes(`maq-a/${CORRIDA}`), 'y anotada en el registro local');
    assert.strictEqual(JSON.parse(fs.readFileSync(m.registro, 'utf8')).destino, `gcs/${BUCKET}`, 'el registro es de este buzón');
    assert.ok(!r.salida.includes(SECRETO), 'el secreto no sale');
    // una segunda pasada no vuelve a subir nada
    const antes = puts(fake).length;
    const otra = await subir(m);
    assert.strictEqual(otra.codigo, 0, otra.salida);
    assert.strictEqual(puts(fake).length, antes);
  } finally { await fake.cerrar(); }
});

test('T9 UploadGcs_AlreadyExists_RetriesWithVersion @story-1.3 @ac-5 — 412 PreconditionFailed: un reintento con versión, nunca sin precondición', async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    fake.poner(`maq-a/${CORRIDA}`, 'lo que ya estaba');
    const m = maquina(fake);
    const r = await subir(m);
    assert.strictEqual(r.codigo, 0, r.salida);
    const deLaCorrida = puts(fake).filter((x) => x.objeto.endsWith(CORRIDA));
    assert.strictEqual(deLaCorrida.length, 2, 'el PUT que rebotó y un solo reintento');
    assert.match(deLaCorrida[1].objeto, /^maq-a\/v\d{8}T\d{9}Z\/1\.1-2026-11-20T1010\.json$/);
    assert.ok(puts(fake).every((x) => x.precondicion === '0'), 'ningún PUT sin la precondición');
    assert.strictEqual(r.res.ya_existian, 1);
    assert.strictEqual(fake.objetos.get(`maq-a/${CORRIDA}`).cuerpo.toString(), 'lo que ya estaba', 'lo que estaba no se pisó');
  } finally { await fake.cerrar(); }
});

test('T10 UploadGcs_ListProbe_OnlyAccessDeniedPasses @story-1.3 @ac-6 — sólo una llave que no puede listar sube', async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    const casos = [['ok', 2, 'llave_con_lectura'], ['SignatureDoesNotMatch', 1, 'llave_invalida'], ['KeyInactive', 1, 'llave_invalida'], ['corte', 1, 'sin_red']];
    for (const [listado, codigo, estado] of casos) {
      fake.modo.listado = listado;
      fake.pedidos.length = 0;
      const m = maquina(fake);
      const r = await subir(m);
      assert.strictEqual(r.codigo, codigo, `${listado}: ${r.salida}`);
      assert.strictEqual(r.res.estado, estado, listado);
      assert.ok(r.res.motivo, `${listado}: dice el motivo`);
      assert.strictEqual(puts(fake).length, 0, `${listado}: ningún PUT`);
      assert.deepStrictEqual(anotados(m), [], `${listado}: nada anotado como subido`);
      assert.ok(!r.salida.includes(SECRETO), `${listado}: el secreto no sale`);
    }
    fake.modo.listado = 'AccessDenied';
    const m = maquina(fake);
    const r = await subir(m);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.ok(puts(fake).length > 0, 'con AccessDenied sube');
  } finally { await fake.cerrar(); }
});

test('T11 UploadGcs_CheckCreateOnly @story-1.3 @ac-7 — vuelve a subir los mismos bytes sin precondición: 403 sale 0, 200 sale 1', async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    const m = maquina(fake);
    assert.strictEqual((await subir(m)).codigo, 0);
    const registro = JSON.parse(fs.readFileSync(m.registro, 'utf8')).archivos;
    for (const [pisar, codigo, estado] of [['AccessDenied', 0, 'solo_crear'], ['ok', 1, 'dejo_escribir']]) {
      fake.modo.pisar = pisar;
      fake.pedidos.length = 0;
      const r = await subir(m, ['--check-create-only']);
      assert.strictEqual(r.codigo, codigo, `${pisar}: ${r.salida}`);
      assert.strictEqual(r.res.estado, estado);
      assert.strictEqual(fake.pedidos[0].metodo, 'GET', `${pisar}: primero el listado de prueba`);
      const p = puts(fake);
      assert.strictEqual(p.length, 1, 'un solo PUT');
      assert.strictEqual(p[0].precondicion, null, 'sin la precondición');
      const anotado = Object.values(registro).find((e) => e.blob === p[0].objeto);
      assert.ok(anotado, `${p[0].objeto} es un objeto confirmado`);
      assert.strictEqual(p[0].sha256, anotado.sha256, 'los bytes son los confirmados');
    }
  } finally { await fake.cerrar(); }
});

test('T12 UploadGcs_ErrorClassification @story-1.3 @ac-8 — cada respuesta medida, a su estado; ninguna anota la corrida', async () => {
  const C = conector();
  const tipos = [['AccessDenied', 'sin_permiso'], ['SignatureDoesNotMatch', 'llave'], ['KeyInactive', 'llave'], ['NoSuchBucket', 'llave'], ['BadDigest', 'otro'], ['503', 'servicio'], ['429', 'servicio'], ['408', 'servicio'], ['PreconditionFailed', 'ya_existe']];
  const almacen = C.almacenDeSubida(llaveGcs(), { urlBase: 'http://127.0.0.1:1' });
  for (const [clave, tipo] of tipos) {
    const [status, codigo] = FAKE.ERRORES[clave];
    assert.strictEqual(almacen.clasificar({ status, codigo }).tipo, tipo, clave);
  }
  assert.strictEqual(almacen.clasificar({ status: 200, codigo: null }).tipo, 'creado');
  assert.match(almacen.clasificar({ status: 404, codigo: 'NoSuchBucket' }).motivo, new RegExp(BUCKET), '404 nombra el bucket');
  assert.match(almacen.clasificar({ status: 400, codigo: 'BadDigest' }).motivo, /no lleg[oó] entero/);

  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    const casos = [['AccessDenied', 'llave_sin_permiso'], ['SignatureDoesNotMatch', 'llave_invalida'], ['KeyInactive', 'llave_invalida'], ['NoSuchBucket', 'llave_invalida'],
      ['BadDigest', 'parcial'], ['503', 'servicio_fallo'], ['429', 'servicio_fallo'], ['408', 'servicio_fallo'], ['corte', 'sin_red']];
    for (const [forzar, estado] of casos) {
      fake.modo.forzar = { '1.1-2026-11-20T1010': forzar };
      const m = maquina(fake);
      const r = await subir(m);
      assert.notStrictEqual(r.codigo, 0, `${forzar}: ${r.salida}`);
      assert.strictEqual(r.res.estado, estado, forzar);
      assert.ok(!anotados(m).some((k) => k.endsWith(CORRIDA)), `${forzar}: la corrida no quedó como subida`);
      assert.ok(!r.salida.includes(SECRETO), `${forzar}: el secreto no sale`);
      if (forzar === 'NoSuchBucket') assert.match(r.res.motivo, new RegExp(BUCKET));
      if (forzar === 'BadDigest') assert.match(r.res.motivo, /no lleg[oó] entero/);
    }
  } finally { await fake.cerrar(); }
});

// ── el sitio ───────────────────────────────────────────────────────────────────────────────────────────────────

const volcado = (sid, ini) => JSON.stringify({ archivedAt: ini, marker: { sessionId: sid, startedAt: ini, lastTouch: ini, stepsCompleted: [] } });
const BUZON = { provider: 'gcs', bucket: BUCKET, threads: false };

/** Corre la lectura del sitio con el servidor de metadatos en `host`. */
async function leerDelSitio(fake, dir, host, extra = {}) {
  const antes = process.env.GCE_METADATA_HOST;
  process.env.GCE_METADATA_HOST = host;
  try { return await conector().bajarBuzon({ buzon: BUZON, credencial: { managed: true }, dir, urlBase: fake ? fake.url : 'http://127.0.0.1:1', budgetMs: 30000, jornadas: true, podar: true, ...extra }); }
  finally { if (antes === undefined) delete process.env.GCE_METADATA_HOST; else process.env.GCE_METADATA_HOST = antes; }
}

test('T13 SiteGcs_ManagedIdentity_ReadsMirror @story-1.3 @ac-9 — token del servidor de metadatos, listado paginado y el espejo de siempre', async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    fake.poner('maq-a-11111111/s1.json', volcado('s1', '2026-11-20T10:00:00Z'));
    fake.poner('maq-a-11111111/v20261121T101010000Z/s1.json', volcado('s1', '2026-11-21T10:00:00Z'));
    fake.poner('maq-a-11111111/s2.json', volcado('s2', '2026-11-22T10:00:00Z'));
    fake.poner('maq-b-22222222/s3.json', volcado('s3', '2026-11-23T10:00:00Z'));
    fake.modo.pagina = 2;
    const dir = path.join(tmp('gcs-sitio-'), 'corridas-buzon');
    const r = await leerDelSitio(fake, dir, fake.host);
    assert.strictEqual(r.codigo, 0, JSON.stringify(r.res));
    assert.strictEqual(r.res.completo, true);
    assert.strictEqual(r.res.versiones_viejas, 1);
    const listados = fake.pedidos.filter((p) => /^\/storage\/v1\/b\/[^/]+\/o$/.test(p.ruta));
    assert.ok(listados.length >= 2 && listados.some((p) => /pageToken=/.test(p.consulta)), 'siguió las páginas');
    assert.ok(fake.pedidos.some((p) => p.ruta === '/computeMetadata/v1/instance/service-accounts/default/token' && p.cabeceras['metadata-flavor'] === 'Google'), 'pidió el token con Metadata-Flavor: Google');
    // las mismas rutas del espejo que con Azure: la versión más nueva, en la ruta sin versión
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'maq-a-11111111', 's1.json'), 'utf8')).archivedAt, '2026-11-21T10:00:00Z');
    assert.ok(fs.existsSync(path.join(dir, 'maq-b-22222222', 's3.json')));
    const corridas = require(path.join(ROOT, 'scripts', 'site', 'sources.js')).leerCorridas(dir);
    assert.strictEqual(corridas.estado, 'medido');
    assert.strictEqual(corridas.lista.length, 3, 'la pestaña de ejecuciones las cuenta');

    // el listado con 401: credencial_rechazada y no completa
    fake.modo.json = '401';
    const r401 = await leerDelSitio(fake, dir, fake.host);
    assert.strictEqual(r401.codigo, 1);
    assert.strictEqual(r401.res.estado, 'credencial_rechazada');
    assert.strictEqual(r401.res.completo, false);
  } finally { await fake.cerrar(); }
});

test('T14 SiteGcs_NoMetadataOrNoRole_Said @story-1.3 @ac-10 — sin identidad del entorno o sin el rol de lector, se dice y el espejo no se toca', async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    fake.poner('maq-a-11111111/s1.json', volcado('s1', '2026-11-20T10:00:00Z'));
    const dir = path.join(tmp('gcs-sitio-'), 'corridas-buzon');
    fs.mkdirSync(path.join(dir, 'maq-z-00000000'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'maq-z-00000000', 'vieja.json'), volcado('v', '2026-10-01T10:00:00Z'));
    // los archivos del espejo con Node: find es otro comando en Windows y la comparación pasaría sin medir
    const archivos = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? archivos(path.join(d, e.name)) : [path.join(d, e.name)]));
    const foto = () => archivos(dir).sort().join('\n');
    const antes = foto();
    // fuera de GCP: el servidor de metadatos no contesta (puerto cerrado)
    const sin = await leerDelSitio(fake, dir, '127.0.0.1:1');
    assert.strictEqual(sin.res.estado, 'sin_configurar');
    assert.notStrictEqual(sin.codigo, 0);
    assert.strictEqual(sin.res.completo, false);
    assert.match(sin.res.motivo, /identidad/);
    // con la identidad y sin el rol de lector
    fake.modo.json = '403';
    const r403 = await leerDelSitio(fake, dir, fake.host);
    assert.strictEqual(r403.res.estado, 'sin_permiso');
    assert.strictEqual(r403.codigo, 1, 'no es «el buzón está vacío»: la pasada no es completa');
    assert.strictEqual(r403.res.completo, false);
    assert.ok(r403.res.motivo);
    assert.strictEqual(foto(), antes, 'el espejo no se tocó');
    // la credencial de Azure no sirve para este buzón
    const sas = await conector().bajarBuzon({ buzon: BUZON, credencial: { sas: 'sig=x' }, dir, urlBase: fake.url });
    assert.strictEqual(sas.res.estado, 'sin_configurar');
  } finally { await fake.cerrar(); }
});

test('T17 SiteGcs_MetadataHangs_TimesOut @story-1.3 @ac-10 — un servidor de metadatos colgado vence a los 2 segundos', async () => {
  const colgado = await FAKE.colgado();
  try {
    const dir = path.join(tmp('gcs-sitio-'), 'corridas-buzon');
    // stable-data: mide cuánto tarda en vencer el pedido al servidor de metadatos; no depende del día ni del huso
    const t0 = Date.now();
    const r = await leerDelSitio(null, dir, colgado.host);
    const ms = Date.now() - t0;
    assert.strictEqual(r.res.estado, 'sin_configurar');
    assert.ok(r.res.motivo);
    // el tope es de 2 s; el margen es para un runner lento
    assert.ok(ms < 5000, `tardó ${ms} ms`);
    assert.ok(!fs.existsSync(dir), 'el espejo no se tocó');
  } finally { await colgado.cerrar(); }
});

test('bajarUnaCorrida del conector baja la conversación más nueva @story-1.3 @ac-9', async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  const antes = process.env.GCE_METADATA_HOST;
  process.env.GCE_METADATA_HOST = fake.host;
  try {
    fake.poner('maq-a-11111111/s1.hilo.jsonl.gz', 'vieja');
    fake.poner('maq-a-11111111/v20261121T101010000Z/s1.hilo.jsonl.gz', 'nueva');
    const dir = tmp('gcs-una-');
    const r = await conector().bajarUnaCorrida({ buzon: BUZON, credencial: { managed: true }, urlBase: fake.url, maquina: 'maq-a-11111111', base: 's1', dir });
    assert.strictEqual(r.codigo, 0, JSON.stringify(r.res));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'maq-a-11111111', 's1.hilo.jsonl.gz'), 'utf8'), 'nueva');
  } finally { if (antes === undefined) delete process.env.GCE_METADATA_HOST; else process.env.GCE_METADATA_HOST = antes; await fake.cerrar(); }
});

// ── la bajada desde una máquina ─────────────────────────────────────────────────────────────────────────────

test('T18 DownloadGcs_FromMachine_NotSupported @story-1.3 @ac-13 @story-1.5 @ac-1 — con una llave gcs, los informes de re-subidas y del Node siguen en no_soportado sin red ni az', async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    const m = bajadaGcs(fake);
    // con Azure DevOps apagado (la casa falsa no tiene organización) y prendido
    for (const ado of [null, 'https://dev.azure.com/acme']) {
      if (ado) m.env.TYCON_ADO_ORG = ado; else delete m.env.TYCON_ADO_ORG;
      for (const args of [['--overwrites-report'], ['--harness-node-report']]) {
        const r = await correr(BAJAR, m, args);
        assert.strictEqual(r.codigo, 1, `${args.join(' ')} (ado ${ado ? 'prendido' : 'apagado'}): ${r.salida}`);
        assert.strictEqual(r.res.estado, 'no_soportado');
        assert.match(r.res.motivo, /sitio/, 'dice que ese buzón lo lee el sitio');
      }
    }
    assert.ok(!fs.existsSync(m.azLog), 'az no se llamó');
    assert.ok(!fs.existsSync(m.gcloudLog), 'gcloud no se llamó');
    assert.strictEqual(fake.pedidos.length, 0, 'ningún pedido a la red');
    assert.ok(!fs.existsSync(m.espejo), 'el espejo local no se tocó');
  } finally { await fake.cerrar(); }
});

// ── la bajada desde una máquina con la sesión de gcloud ─────────────────────────────────────────────────────

const TOKEN_GCLOUD = 'token-de-prueba';
// En Windows la bajada todavía no busca `gcloud.cmd` (integrations/gcs/scripts/mailbox.js) y el doble de gcloud es un
// guion de sh, que Node no lanza ahí: los casos que lo lanzan se saltean, y se miden en Mac y Linux
const CON_GCLOUD = { skip: process.platform === 'win32' && 'en Windows la bajada todavía no busca gcloud.cmd, y el doble de gcloud es un guion de sh: se mide en Mac y Linux' };
const MAQ_A = 'maq-a-11111111';
const MAQ_B = 'maq-b-22222222';
const V_NUEVA = 'v20261121T101010000Z';

/**
 * Una máquina que baja con una llave gcs: su espejo (TYCON_MAILBOX_DIR), un `az` doble que anota si lo llamaron y un
 * `gcloud` doble (TYCON_GCLOUD_BIN) que anota sus argumentos, `CLOUDSDK_CORE_DISABLE_PROMPTS` y si su entrada estaba
 * cerrada (`read` que falla de inmediato con /dev/null; con una entrada abierta se quedaría esperando), y escribe `token`
 * con la salida `sale`. Azure DevOps queda apagada: la casa falsa no tiene organización.
 */
function bajadaGcs(fake, { token = TOKEN_GCLOUD, sale = 0, llave } = {}) {
  const m = maquina(fake, llave);
  m.espejo = path.join(m.base, 'espejo');
  m.indice = path.join(m.base, 'mailbox-downloads.json');
  m.sello = path.join(m.base, 'download-runs-no-permission.seal');
  m.azLog = path.join(m.base, 'az.log');
  m.gcloudLog = path.join(m.base, 'gcloud.log');
  const az = path.join(m.base, 'az');
  fs.writeFileSync(az, `#!/bin/sh\necho "$*" >> "${m.azLog}"\necho token\n`, { mode: 0o755 });
  const gcloud = path.join(m.base, 'gcloud');
  fs.writeFileSync(gcloud, [
    '#!/bin/sh',
    `echo "args=$* prompts=\${CLOUDSDK_CORE_DISABLE_PROMPTS:-}" >> "${m.gcloudLog}"`,
    `if read -r x; then echo "entrada=abierta" >> "${m.gcloudLog}"; else echo "entrada=cerrada" >> "${m.gcloudLog}"; fi`,
    token ? `echo "${token}"` : 'echo ""',
    `exit ${sale}`,
    '',
  ].join('\n'), { mode: 0o755 });
  Object.assign(m.env, { TYCON_AZ_BIN: az, TYCON_GCLOUD_BIN: gcloud, TYCON_MAILBOX_DIR: m.espejo });
  delete m.env.TYCON_DOWNLOADS_LOG;
  return m;
}
const bajarGcs = (m, args = []) => correr(BAJAR, m, args);
const gets = (fake) => fake.pedidos.filter((p) => /alt=media/.test(p.consulta));
const enElIndice = (m) => { try { return Object.keys(JSON.parse(fs.readFileSync(m.indice, 'utf8')).blobs); } catch (_) { return []; } };

/** El bucket de T1: dos máquinas, dos versiones de una ejecución y un juego de registros más nuevo al que le falta uno. */
function bucketDeDosMaquinas(fake) {
  fake.poner(`${MAQ_A}/s1.json`, volcado('s1', '2026-11-20T10:00:00Z'));
  fake.poner(`${MAQ_A}/${V_NUEVA}/s1.json`, volcado('s1', '2026-11-21T10:00:00Z'));
  fake.poner(`${MAQ_B}/s3.json`, volcado('s3', '2026-11-23T10:00:00Z'));
  // el juego de siempre, completo: gates medido y su archivo está
  fake.poner(`${MAQ_A}/registros/gates.log.gz`, 'gates-viejo');
  fake.poner(`${MAQ_A}/registros/cobertura.json`, JSON.stringify({ fuentes: { gates: { estado: 'medido' } } }));
  // el juego más nuevo dice que midió gates, pero su gates.log.gz no está: incompleto
  fake.poner(`${MAQ_A}/registros/${V_NUEVA}/cobertura.json`, JSON.stringify({ fuentes: { gates: { estado: 'medido' } } }));
}

test('T1 Bajada_Gcs_BajaLoNuevo @story-1.5 @ac-1 — con la sesión de gcloud baja la versión más nueva y el juego completo de registros a las rutas de siempre', CON_GCLOUD, async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    bucketDeDosMaquinas(fake);
    const m = bajadaGcs(fake);
    m.env.TYCON_ADO_ORG = 'https://dev.azure.com/acme';
    const r = await bajarGcs(m);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.strictEqual(r.res.completo, true, r.salida);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(m.espejo, MAQ_A, 's1.json'), 'utf8')).archivedAt, '2026-11-21T10:00:00Z', 'la versión más nueva, en la ruta sin versión');
    assert.ok(fs.existsSync(path.join(m.espejo, MAQ_B, 's3.json')));
    assert.strictEqual(fs.readFileSync(path.join(m.espejo, MAQ_A, 'registros', 'gates.log.gz'), 'utf8'), 'gates-viejo', 'el juego completo, no el más nuevo incompleto');
    assert.ok(r.res.versiones_incompletas >= 1, 'contó el juego incompleto');
    assert.ok(fake.pedidos.every((p) => !p.ruta.startsWith('/storage/') || p.cabeceras.authorization === `Bearer ${TOKEN_GCLOUD}`), 'cada pedido con el token de gcloud');
    assert.match(fs.readFileSync(m.gcloudLog, 'utf8'), /args=auth print-access-token/);
    assert.ok(!fs.existsSync(m.azLog), 'az no se llamó');
  } finally { await fake.cerrar(); }
});

test('T2 Bajada_Gcs_SegundaPasadaNoBaja @story-1.5 @ac-2 — con el espejo al día no baja nada', CON_GCLOUD, async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    bucketDeDosMaquinas(fake);
    const m = bajadaGcs(fake);
    const primera = await bajarGcs(m);
    assert.strictEqual(primera.codigo, 0, primera.salida);
    const antes = gets(fake).length;
    const segunda = await bajarGcs(m);
    assert.strictEqual(segunda.codigo, 0, segunda.salida);
    assert.strictEqual(segunda.res.bajados, 0);
    assert.strictEqual(gets(fake).length, antes, 'ningún GET de objeto en la segunda pasada');
  } finally { await fake.cerrar(); }
});

test('T3 Bajada_Gcs_SinGcloud @story-1.5 @ac-4 — sin gcloud es «sin permiso»: sale 0, no crea el espejo y lo anota una vez por día', async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    bucketDeDosMaquinas(fake);
    const m = bajadaGcs(fake);
    m.env.TYCON_GCLOUD_BIN = path.join(m.base, 'no-existe', 'gcloud');
    const r = await bajarGcs(m);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.strictEqual(r.res.estado, 'sin_permiso');
    assert.match(r.res.motivo, /gcloud/);
    assert.strictEqual(r.res.aviso, 'emitido');
    assert.ok(!fs.existsSync(m.espejo), 'no creó la carpeta del espejo');
    assert.ok(fs.existsSync(m.sello), 'el sello de «sin permiso» de siempre');
    assert.strictEqual(fake.pedidos.length, 0, 'ningún pedido a la red');
    const otra = await bajarGcs(m);
    assert.strictEqual(otra.codigo, 0);
    assert.notStrictEqual(otra.res.aviso, 'emitido', 'el mismo día no lo vuelve a decir');
  } finally { await fake.cerrar(); }
});

test('T4 Bajada_Gcs_SinSesion @story-1.5 @ac-4 — gcloud sin sesión, o sin token, es «sin permiso»; corre con la entrada cerrada y sin preguntas', CON_GCLOUD, async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    bucketDeDosMaquinas(fake);
    for (const doble of [{ token: '', sale: 1 }, { token: '', sale: 0 }]) {
      const m = bajadaGcs(fake, doble);
      const r = await bajarGcs(m);
      assert.strictEqual(r.codigo, 0, `${JSON.stringify(doble)}: ${r.salida}`);
      assert.strictEqual(r.res.estado, 'sin_permiso');
      assert.ok(!fs.existsSync(m.espejo), 'no baja ni crea el espejo');
      const log = fs.readFileSync(m.gcloudLog, 'utf8');
      assert.match(log, /prompts=1/, 'CLOUDSDK_CORE_DISABLE_PROMPTS=1');
      assert.match(log, /entrada=cerrada/, 'la entrada cerrada: nunca espera una respuesta');
    }
    assert.strictEqual(fake.pedidos.length, 0, 'ningún pedido a la red');
  } finally { await fake.cerrar(); }
});

test('T5 Bajada_Gcs_SinRol @story-1.5 @ac-4 — un 403 al listar es «sin permiso»: sale 0 y no crea el espejo', CON_GCLOUD, async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    bucketDeDosMaquinas(fake);
    fake.modo.json = '403';
    const m = bajadaGcs(fake);
    const r = await bajarGcs(m);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.strictEqual(r.res.estado, 'sin_permiso');
    assert.ok(r.res.motivo);
    assert.ok(!fs.existsSync(m.espejo), 'no creó la carpeta del espejo');
    assert.strictEqual(gets(fake).length, 0, 'no bajó nada');
  } finally { await fake.cerrar(); }
});

test('T6 Bajada_Gcs_Token401 @story-1.5 @ac-5 — un 401 al listar o al bajar es credencial_rechazada: sale distinto de 0, no completa y sin el token', CON_GCLOUD, async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    bucketDeDosMaquinas(fake);
    // al listar
    fake.modo.json = '401';
    const m = bajadaGcs(fake);
    const r = await bajarGcs(m);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.strictEqual(r.res.estado, 'credencial_rechazada');
    assert.strictEqual(r.res.completo, false);
    assert.ok(!r.salida.includes(TOKEN_GCLOUD), 'el token no sale');
    assert.deepStrictEqual(enElIndice(m), [], 'nada marcado como bajado');
    // al bajar un objeto
    fake.modo.json = 'ok';
    fake.modo.media = '401';
    const m2 = bajadaGcs(fake);
    const r2 = await bajarGcs(m2);
    assert.notStrictEqual(r2.codigo, 0, r2.salida);
    assert.strictEqual(r2.res.estado, 'credencial_rechazada');
    assert.strictEqual(r2.res.completo, false);
    assert.ok(!r2.salida.includes(TOKEN_GCLOUD), 'el token no sale');
    const pedido = gets(fake).map((p) => decodeURIComponent(p.ruta.split('/o/')[1] || ''));
    assert.ok(pedido.length >= 1, 'pidió al menos un objeto');
    for (const nombre of pedido) assert.ok(!enElIndice(m2).includes(nombre), `${nombre} no queda en el índice`);
    // todos los objetos contestan 401: ninguno queda escrito en el espejo
    const archivos = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? archivos(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
    assert.deepStrictEqual(archivos(m2.espejo), [], 'el objeto del 401 no quedó en el espejo');
  } finally { await fake.cerrar(); }
});

test('T7 Bajada_Gcs_Bucket404 @story-1.5 @ac-5 — un 404 al listar es sin_contenedor con el bucket en el motivo', CON_GCLOUD, async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    fake.modo.json = '404';
    const m = bajadaGcs(fake);
    const r = await bajarGcs(m);
    assert.notStrictEqual(r.codigo, 0, r.salida);
    assert.strictEqual(r.res.estado, 'sin_contenedor');
    assert.ok(r.res.motivo.includes(BUCKET), r.res.motivo);
  } finally { await fake.cerrar(); }
});

test('T8 Bajada_Gcs_SinRed @story-1.5 @ac-5 — sin respuesta del servidor es sin_red: sale distinto de 0 y nada marcado', CON_GCLOUD, async () => {
  const m = bajadaGcs(null);
  const r = await bajarGcs(m);
  assert.notStrictEqual(r.codigo, 0, r.salida);
  assert.strictEqual(r.res.estado, 'sin_red', r.salida);
  assert.strictEqual(r.res.completo, false);
  assert.deepStrictEqual(enElIndice(m), [], 'nada marcado como bajado');
});

test('T10 Bajada_Gcs_SinAzureDevOps @story-1.5 @ac-3 — sin Azure DevOps, sin tenant y sin az, baja igual', CON_GCLOUD, async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    bucketDeDosMaquinas(fake);
    const m = bajadaGcs(fake);
    delete m.env.TYCON_ADO_ORG;
    m.env.TYCON_AZ_BIN = path.join(m.base, 'no-existe', 'az');
    const r = await bajarGcs(m);
    assert.strictEqual(r.codigo, 0, r.salida);
    assert.strictEqual(r.res.completo, true, r.salida);
    assert.ok(fs.existsSync(path.join(m.espejo, MAQ_B, 's3.json')));
    assert.ok(!fs.existsSync(m.azLog), 'az no se llamó');
    // con el buzón apagado sigue saliendo apagado
    m.env.TYCON_MAILBOX = '0';
    const apagado = await bajarGcs(m);
    assert.strictEqual(apagado.codigo, 0);
    assert.strictEqual(apagado.res.estado, 'apagado');
  } finally { await fake.cerrar(); }
});

test('T12 Bajada_OtroProveedor_SinConector @story-1.5 @ac-1 — sin conector, o con un conector que no sabe bajar, sigue no_soportado sin red', async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  try {
    // un proveedor que ningún conector atiende
    const m = bajadaGcs(fake, { llave: llaveGcs({ provider: 's3' }) });
    const r = await bajarGcs(m);
    assert.strictEqual(r.codigo, 1, r.salida);
    assert.strictEqual(r.res.estado, 'no_soportado');
    // un conector de buzón que sólo sabe subir
    const ints = tmp('gcs-ints-');
    fs.cpSync(path.join(ROOT, 'integrations', 'gcs'), path.join(ints, 'gcs'), { recursive: true });
    fs.writeFileSync(path.join(ints, 'gcs', 'scripts', 'mailbox.js'), `const real = require(${JSON.stringify(CONECTOR)});\nconst { almacenDeBajada, ...resto } = real;\nmodule.exports = resto;\n`);
    const m2 = bajadaGcs(fake);
    m2.env.TYCON_INTEGRATIONS_DIR = ints;
    const r2 = await bajarGcs(m2);
    assert.strictEqual(r2.codigo, 1, r2.salida);
    assert.strictEqual(r2.res.estado, 'no_soportado');
    // un conector que no carga: config_rota con salida 2
    fs.writeFileSync(path.join(ints, 'gcs', 'scripts', 'mailbox.js'), 'throw new Error("roto a propósito");\n');
    const r3 = await bajarGcs(m2);
    assert.strictEqual(r3.codigo, 2, r3.salida);
    assert.strictEqual(r3.res.estado, 'config_rota');
    assert.strictEqual(fake.pedidos.length, 0, 'ningún pedido a la red');
    assert.ok(!fs.existsSync(m.gcloudLog) && !fs.existsSync(m2.gcloudLog), 'gcloud no se llamó');
  } finally { await fake.cerrar(); }
});

// ── la guía y las suites de Azure ─────────────────────────────────────────────────────────────────────────────

test('T16 GcsGuide_DocumentsIamAndCodes @story-1.3 @ac-12 — la guía dice qué crear en GCP y los códigos medidos', () => {
  const g = fs.readFileSync(path.join(ROOT, 'guides', 'integrations', 'gcs-mailbox.md'), 'utf8');
  assert.match(g, /storage\.objects\.create/);
  assert.match(g, /únic[oa] permiso|sólo `?storage\.objects\.create/i, 'como único permiso de la cuenta de subida');
  assert.match(g, /HMAC/);
  assert.match(g, /desactiv/i, 'la clave se revoca desactivándola');
  assert.match(g, /roles\/storage\.objectViewer|lector/i, 'el rol de lector del sitio');
  for (const codigo of ['412', 'PreconditionFailed', 'AccessDenied', 'SignatureDoesNotMatch', 'KeyInactive', 'NoSuchBucket', 'BadDigest']) assert.ok(g.includes(codigo), `la tabla de códigos trae ${codigo}`);
  assert.match(g, /site\.mailbox\.bucket/, 'que la llave y el perfil nombran el mismo bucket');
});

// ── regresiones del pase adversarial ─────────────────────────────────────────────────────────────────────────────

test('SiteGcs_DownloadRejects401_CredentialRejected @story-1.3 @ac-9 — un 401 al bajar un objeto es credencial_rechazada, no un permiso que falta', async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  const antes = process.env.GCE_METADATA_HOST;
  try {
    fake.poner('maq-a-11111111/s1.json', volcado('s1', '2026-11-20T10:00:00Z'));
    fake.poner('maq-a-11111111/s1.hilo.jsonl.gz', 'hilo');
    fake.modo.media = '401';
    const dir = path.join(tmp('gcs-401-'), 'corridas-buzon');
    const r = await leerDelSitio(fake, dir, fake.host);
    assert.strictEqual(r.codigo, 1, JSON.stringify(r.res));
    assert.strictEqual(r.res.estado, 'credencial_rechazada', r.res.motivo);
    assert.strictEqual(r.res.completo, false);
    process.env.GCE_METADATA_HOST = fake.host;
    const una = await conector().bajarUnaCorrida({ buzon: BUZON, credencial: { managed: true }, urlBase: fake.url, maquina: 'maq-a-11111111', base: 's1', dir: tmp('gcs-401-una-') });
    assert.strictEqual(una.codigo, 1);
    assert.strictEqual(una.res.estado, 'credencial_rechazada', una.res.motivo);
    // un 403 al bajar sigue siendo el permiso que falta
    fake.modo.media = '403';
    const r403 = await leerDelSitio(fake, path.join(tmp('gcs-403-'), 'corridas-buzon'), fake.host);
    assert.strictEqual(r403.res.estado, 'sin_permiso_a_mitad');
  } finally { if (antes === undefined) delete process.env.GCE_METADATA_HOST; else process.env.GCE_METADATA_HOST = antes; await fake.cerrar(); }
});

test('SiteMailbox_ConnectorWithoutFields_IsAProblem @story-1.3 @ac-2 — un conector de buzón sin mailboxFields en su manifiesto da un problema, no tira el lector', () => {
  const integ = tmp('gcs-integ-');
  fs.mkdirSync(path.join(integ, 'sincampos', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(integ, 'sincampos', 'integration.json'), JSON.stringify({ name: 'sincampos', label: 'Sin campos', kind: 'mailbox', connector: 'scripts/mailbox.js', provider: 'sincampos' }));
  fs.writeFileSync(path.join(integ, 'sincampos', 'scripts', 'mailbox.js'), 'module.exports = { problemasDelBuzon: () => [] };\n');
  const guion = `const OC = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'operations-config.js'))});
require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'integrations.js'))}).giveMailboxConnectors(OC);
const r = OC.parse(JSON.stringify({ version: OC.VERSION, site: { mailbox: { provider: 'sincampos' } } }));
process.stdout.write(JSON.stringify(r.problems.filter((p) => String(p.path).startsWith('site.mailbox'))));`;
  const env = { ...process.env, TYCON_INTEGRATIONS_DIR: integ };
  const r = spawnSync(process.execPath, ['-e', guion], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, `el lector no tira: ${r.stderr}`);
  const problemas = JSON.parse(r.stdout);
  assert.ok(problemas.some((p) => p.path === 'site.mailbox.provider'), `dice que el conector no declara sus campos: ${r.stdout}`);
});

test('Mailbox_NeutralityBase_CoversEveryConnector @story-1.3 @ac-1 — el candado lee desde la base cada manifiesto con señales, y su piso no deja perder las de ninguno', () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'controls-from-base.json'), 'utf8'));
  const entrada = (base.controls || base.entries || Object.values(base).find(Array.isArray)).find((c) => c.name === 'core-neutrality');
  assert.ok(entrada, 'controls-from-base.json tiene core-neutrality');
  const dirInteg = path.join(ROOT, 'integrations');
  const conSenales = fs.readdirSync(dirInteg).map((n) => path.join(dirInteg, n, 'integration.json')).filter((f) => fs.existsSync(f))
    .map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), n: (JSON.parse(fs.readFileSync(f, 'utf8')).hardSignals || []).length }))
    .filter((m) => m.n > 0);
  for (const m of conSenales) assert.ok(entrada.rules.includes(m.rel), `${m.rel} declara señales y el candado no lo lee desde la base`);
  const total = conSenales.reduce((s, m) => s + m.n, 0);
  const piso = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'neutrality-allowlist.json'), 'utf8')).signals_at_least;
  for (const m of conSenales) assert.ok(total - m.n < piso, `sin las señales de ${m.rel} quedan ${total - m.n} y el piso (${piso}) no lo frena`);
});


// 🔴 Falla con: el lector del perfil cargando el código de integrations/ (deja de viajar solo), o rechazando un perfil gcs
// cuando nadie le dio los conectores (la noche y los avisos no podrían leer el perfil).
test('SiteMailbox_ReaderAlone_ReadsManifestsOnly @story-1.3 @ac-2 — el lector solo lee los manifiestos sin cargar código: acepta gcs con su campo y sigue rechazando un proveedor sin conector', () => {
  const guion = `const OC = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'operations-config.js'))});
const p = (mailbox) => OC.parse(JSON.stringify({ version: OC.VERSION, site: { mailbox } })).problems.filter((x) => String(x.path).startsWith('site.mailbox')).map((x) => x.path);
process.stdout.write(JSON.stringify({ gcs: p({ provider: 'gcs', bucket: 'acme-buzon-lab', threads: false }), mal: p({ provider: 's3', bucket: 'acme-buzon-lab' }), hilos: p({ provider: 'gcs', threads: 'si' }), azure: p({ provider: 'azure-blob', account: 'ACME' }), cargados: Object.keys(require.cache).filter((f) => /integrations[\\\\/]/.test(f) || /integrations\\.js$/.test(f)), proveedores: OC.MAILBOX_PROVIDERS }));`;
  const r = spawnSync(process.execPath, ['-e', guion], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepStrictEqual(o.gcs, [], 'el proveedor de un conector, con el campo de su manifiesto');
  assert.deepStrictEqual(o.mal, ['site.mailbox.provider'], 'un proveedor sin conector');
  assert.deepStrictEqual(o.hilos, ['site.mailbox.threads']);
  assert.ok(o.azure.includes('site.mailbox.account'), 'Azure se valida como siempre: la cuenta con su forma');
  assert.deepStrictEqual(o.cargados, [], 'no cargó integrations.js ni ningún conector');
  assert.deepStrictEqual(o.proveedores, ['azure-blob', 'gcs'], 'los proveedores salen de los manifiestos');
});

// --- pase adversarial de la 8.336 (26/11) ---------------------------------------------------------------------------

// el secreto de una llave HMAC tiene 40 caracteres: una llave que lo trae por error en "provider" no lo repite en ningún
// motivo ni registro de la bajada (el nombre del proveedor se dice sólo si tiene la forma de un nombre)
const SECRETO_EN_PROVIDER = Buffer.from('secretoDePruebaNoEsReal000000').toString('base64');
for (const args of [[], ['--overwrites-report']]) {
  test(`MailboxKey_SecretInProvider_NeverPrinted ${args.join(' ') || '(común)'} @story-8.336 — el secreto puesto en "provider" no sale en la bajada`, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gcs-provider-'));
    try {
      const home = path.join(base, 'home');
      fs.mkdirSync(home, { recursive: true });
      const ruta = path.join(base, 'corridas-buzon.json');
      fs.writeFileSync(ruta, JSON.stringify({ provider: SECRETO_EN_PROVIDER, bucket: 'acme-buzon-lab', accessId: 'GOOG1EPRUEBADEJUGUETENOESREAL0000000000', secret: 'x', vence: '2099-12-31', rotar: 'r' }));
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (/^TYCON_|^TF_BUILD$|^GCE_METADATA_HOST$|^ADO_ORG$/.test(k)) delete env[k];
      Object.assign(env, { HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_PROFILE: '0', TYCON_MAILBOX: '1', TYCON_MAILBOX_JSON: ruta,
        TYCON_MAILBOX_URL_BASE: 'http://127.0.0.1:1', TYCON_MAILBOX_DIR: path.join(base, 'espejo'), TYCON_AZ_BIN: path.join(base, 'no-hay-az'), TYCON_GCLOUD_BIN: path.join(base, 'no-hay-gcloud') });
      const r = spawnSync(process.execPath, [BAJAR, '--json', ...args], { env, encoding: 'utf8' });
      const salida = `${r.stdout}\n${r.stderr}`;
      // ni entero ni un tramo: un corte a 20 caracteres también lo dejaría a la vista
      for (let i = 0; i + 12 <= SECRETO_EN_PROVIDER.length; i += 4) assert.ok(!salida.includes(SECRETO_EN_PROVIDER.slice(i, i + 12)), `un tramo del secreto salió en la salida (desde ${i})`);
      const conSecreto = [];
      const andar = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) andar(p); else if (p !== ruta && fs.readFileSync(p, 'utf8').includes(SECRETO_EN_PROVIDER)) conSecreto.push(p); } };
      andar(base);
      assert.deepStrictEqual(conSecreto, [], 'el secreto quedó en un archivo');
      assert.strictEqual(r.status, 1, 'una llave con un proveedor que no es un nombre no baja nada');
      if (!args.length) assert.strictEqual(JSON.parse(r.stdout).estado, 'no_soportado', r.stdout);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
}

// un 200 que no es el listado de Cloud Storage (sin `kind: storage#objects`) no es el bucket vacío: con la poda prendida
// borraría el espejo del sitio
for (const cuerpo of ['{}', '[]', '{"error":{"code":200,"message":"mantenimiento"}}', '42']) {
  test(`SiteMailbox_200ThatIsNotAListing_DoesNotPrune ${cuerpo} @story-8.336 — un 200 que no es un listado no borra el espejo`, async () => {
    const http = require('http');
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/computeMetadata/')) { res.end(JSON.stringify({ access_token: 'token-de-juguete', expires_in: 3600 })); return; }
      res.end(cuerpo);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcs-espejo-'));
    const antes = process.env.GCE_METADATA_HOST;
    try {
      fs.mkdirSync(path.join(dir, 'maq-a-11111111'), { recursive: true });
      for (const f of ['s1.json', 's2.json', 's3.json']) fs.writeFileSync(path.join(dir, 'maq-a-11111111', f), JSON.stringify({ archivedAt: '2026-11-20T10:00:00Z', marker: { sessionId: f } }));
      process.env.GCE_METADATA_HOST = `127.0.0.1:${srv.address().port}`;
      const r = await conector().bajarBuzon({ buzon: BUZON, credencial: { managed: true }, urlBase: `http://127.0.0.1:${srv.address().port}`, dir, log: () => {}, budgetMs: 30000, podar: true });
      assert.notStrictEqual(r.codigo, 0, JSON.stringify(r.res));
      assert.strictEqual(fs.readdirSync(path.join(dir, 'maq-a-11111111')).length, 3, 'el espejo perdió ejecuciones');
    } finally {
      if (antes === undefined) delete process.env.GCE_METADATA_HOST; else process.env.GCE_METADATA_HOST = antes;
      srv.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('SiteMailbox_RealEmptyBucket_IsEmpty @story-8.336 — el listado de un bucket vacío (kind sin items) es el buzón vacío', async () => {
  const http = require('http');
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/computeMetadata/')) { res.end(JSON.stringify({ access_token: 'token-de-juguete', expires_in: 3600 })); return; }
    res.end(JSON.stringify({ kind: 'storage#objects' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcs-vacio-'));
  const antes = process.env.GCE_METADATA_HOST;
  try {
    process.env.GCE_METADATA_HOST = `127.0.0.1:${srv.address().port}`;
    const r = await conector().bajarBuzon({ buzon: BUZON, credencial: { managed: true }, urlBase: `http://127.0.0.1:${srv.address().port}`, dir, log: () => {}, budgetMs: 30000 });
    assert.strictEqual(r.codigo, 0, JSON.stringify(r.res));
    assert.strictEqual(r.res.blobs, 0);
  } finally {
    if (antes === undefined) delete process.env.GCE_METADATA_HOST; else process.env.GCE_METADATA_HOST = antes;
    srv.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── el sitio entero: el repo de operaciones con site.mailbox gcs, crearFuentes y su refresco ───────────────────────

const { arrancarRepoHttp, repoConArchivos, hayHttpBackend } = require('./lib/git-http-server.js');
const H = require('./lib/site-harness.js');
// sin git http-backend se saltea con constancia; en CI (CI=true) NO se saltea, como en site-sources.test.js
const SIN_BACKEND = !hayHttpBackend() && !process.env.CI && 'git http-backend no está en esta máquina: el repo por HTTP no se puede armar';

test('T19 SiteGcs_WholeSite_RefreshReadsRuns @story-1.3 @ac-9 — el sitio con site.mailbox gcs y la identidad del entorno: el refresco lee las corridas; una falla después conserva la última lectura buena', { skip: SIN_BACKEND }, async () => {
  const fake = await FAKE.crear({ bucket: BUCKET, accessId: ACCESS, secreto: SECRETO });
  const raiz = tmp('gcs-sitio-entero-');
  const TOKEN = `tok-${require('crypto').randomBytes(6).toString('hex')}`;
  const config = { version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'], mailbox: { provider: 'gcs', bucket: BUCKET } } };
  repoConArchivos(raiz, 'ops.git', H.archivosDeOperaciones({ config }), path.join(raiz, 'trabajo'));
  const git = await arrancarRepoHttp({ raiz, cabecera: `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}` });
  const antes = process.env.GCE_METADATA_HOST;
  process.env.GCE_METADATA_HOST = fake.host;
  let fuentes = null;
  try {
    fake.poner('maq-a-11111111/s1.json', volcado('s1', '2026-11-20T10:00:00Z'));
    fake.poner('maq-b-22222222/s2.json', volcado('s2', '2026-11-21T10:00:00Z'));
    const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
    const v = validarConfiguracion(H.envBase({ SITE_OPERATIONS_REPO: git.url('ops.git'), SITE_OPERATIONS_TOKEN: TOKEN, SITE_MAILBOX_IDENTITY: 'managed' }));
    assert.ok(v.ok, JSON.stringify(v.problemas));
    assert.deepStrictEqual(v.cfg.mailboxCredencial, { managed: true });
    const registro = [];
    const { crearFuentes } = require(path.join(H.SITE, 'sources.js'));
    fuentes = crearFuentes({ cfg: v.cfg, dataDir: tmp('gcs-sitio-datos-'), log: (l) => registro.push(l), urlBuzon: fake.url });

    await fuentes.refrescar();
    assert.strictEqual(fuentes.estado().cargado, true, registro.join('\n'));
    const c = fuentes.modelo().corridas;
    assert.strictEqual(c.estado, 'medido', `${JSON.stringify(c)}\n${registro.join('\n')}`);
    assert.strictEqual(c.lista.length, 2, 'las dos corridas del bucket');
    assert.strictEqual(fuentes.buzonEstado().completo, true);
    assert.ok(fake.pedidos.some((p) => p.ruta === '/computeMetadata/v1/instance/service-accounts/default/token'), 'el token salió del servidor de metadatos');
    assert.ok(fake.pedidos.some((p) => /^\/storage\/v1\/b\/[^/]+\/o$/.test(p.ruta)), 'listó el bucket por la API JSON');

    // después, sin el rol de lector: no es un buzón vacío; se queda lo último bueno y la falla se anota
    fake.modo.json = '403';
    await fuentes.refrescar();
    const c2 = fuentes.modelo().corridas;
    assert.strictEqual(c2.estado, 'medido', 'conserva la última lectura buena');
    assert.strictEqual(c2.lista.length, 2);
    assert.strictEqual(fuentes.buzonEstado().completo, false);
    assert.match(registro.join('\n'), /el buzón no se leyó entero \(sin_permiso/);
    assert.ok(!registro.join('\n').includes(TOKEN), 'la credencial del repo no sale en el registro');
  } finally {
    if (fuentes) fuentes.detener();
    if (antes === undefined) delete process.env.GCE_METADATA_HOST; else process.env.GCE_METADATA_HOST = antes;
    await git.cerrar();
    await fake.cerrar();
    fs.rmSync(raiz, { recursive: true, force: true });
  }
});
