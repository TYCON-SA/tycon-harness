'use strict';
/*
 * site-sources.test.js — las fuentes del sitio de la organización y su refresco.
 *
 * T21 RepoDeOperaciones_CredencialNuncaEnElDisco    T25 Refresco_FallaYConservaElUltimoBueno
 * T22 Buzon_SoloConCredencialDeLectura              T40 Configuracion_UltimoBuenoBandaYFreno
 * T24 Despertar_CargandoYDespues                    T41 Configuracion_PlazoNoSeReiniciaAlDespertar
 * T45 2.28-Fuentes_InformadosFueraDelModelo_YCorridasConRepos (lo informado aparte del modelo)
 * T26 2.27-Espejo_BajaHilosYCambios_SoloConThreads (hilos y cambios sólo con `site.mailbox.threads` y disco)
 *
 * Sin red: el repo de operaciones es un repo git por HTTP local que exige la cabecera (lib/git-http-server.js), el buzón
 * un servidor local con la forma de Azure Blob, y la identidad administrada un servidor local que hace de la plataforma.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { arrancarRepoHttp, repoConArchivos, hayHttpBackend } = require('./lib/git-http-server.js');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const H = require('./lib/site-harness.js');

const sources = require(path.join(H.SITE, 'sources.js'));
const { crearFuentes, estadoDeLaConfiguracion, correr } = sources;
const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
const HOY = '2026-10-15';
const T0 = Date.parse(`${HOY}T12:00:00Z`);
const HORA = 3600000;
// stable-data: el emisor de mentira firma con la hora real, como uno de verdad, y el sitio de estas pruebas corre con su
// reloj de verdad; lo que se compara son plazos (la sesión, el token de la identidad), nunca una fecha fija.
const TOKEN = `tok-${require('crypto').randomBytes(6).toString('hex')}`;
const CABECERA = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
// sin git http-backend se saltea con constancia; en CI (CI=true) NO se saltea: un «verde» con estas pruebas salteadas no
// cubre las fuentes
const SIN_BACKEND = !hayHttpBackend() && !process.env.CI && 'git http-backend no está en esta máquina: el repo por HTTP no se puede armar';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
/** Entrar con el reloj del sitio: el id_token lleva iat y exp de ESE reloj, no del real. */
const entrar = async (h, emisor, email, t) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true, iat: Math.floor(t / 1000), exp: Math.floor(t / 1000) + 3600 })).sesion;

/** Repo + buzón + fuentes, todo local. */
async function montar({ archivos = {}, config, blobs = {}, mailbox = true, sasExtra = {}, credBuzon, ahora = () => T0, dataDir, firstMaintainer, envExtra = {}, fuentesExtra = {} } = {}) {
  const raiz = tmp('site-src-');
  const cfgOps = config || { version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'], ...(mailbox ? { mailbox: { provider: 'azure-blob', account: 'acmeruns', container: 'runs' } } : {}) } };
  const repo = repoConArchivos(raiz, 'ops.git', H.archivosDeOperaciones({ config: cfgOps, extra: archivos }), path.join(raiz, 'trabajo'));
  const git = await arrancarRepoHttp({ raiz, cabecera: CABECERA });
  const buzon = await H.arrancarBuzon({ blobs });
  const env = H.envBase({ SITE_OPERATIONS_REPO: git.url('ops.git'), SITE_OPERATIONS_TOKEN: TOKEN, ...(credBuzon === undefined ? { SITE_MAILBOX_SAS: H.sas(sasExtra) } : credBuzon), ...(firstMaintainer ? { SITE_FIRST_MAINTAINER: firstMaintainer } : {}), ...envExtra });
  const v = validarConfiguracion(env);
  assert.ok(v.ok, JSON.stringify(v.problemas));
  const llamadas = [];
  const spawn = (cmd, args, opts) => { llamadas.push({ cmd, args, env: opts && opts.env }); return correr(cmd, args, opts); };
  const registro = [];
  const dir = dataDir || tmp('site-data-');
  const fuentes = crearFuentes({ cfg: v.cfg, dataDir: dir, log: (l) => registro.push(l), ahora, spawn, urlBuzon: buzon.base, ...fuentesExtra });
  return {
    raiz, repo, git, buzon, env, cfg: v.cfg, fuentes, llamadas, registro, dataDir: dir,
    cerrar: async () => { fuentes.detener(); await git.cerrar(); await buzon.cerrar(); fs.rmSync(raiz, { recursive: true, force: true }); },
  };
}

test('T21b Clones_FueraDelDiscoDeDatos @story-2.30 @ac-25', { skip: SIN_BACKEND }, async () => {
  // SITE_DATA_DIR es el disco montado (Azure Files, por SMB): no admite el chmod que git hace al clonar. Los clones van
  // al disco del contenedor; en SITE_DATA_DIR no queda ningún repo de git, y lo que sí se guarda ahí (el estado) sigue
  const m = await montar();
  try {
    await m.fuentes.refrescar();
    assert.strictEqual(m.fuentes.estado().cargado, true);
    const clon = m.fuentes.clones().operaciones.dir;
    const real = (p) => fs.realpathSync(p);
    assert.ok(!(real(clon) + path.sep).startsWith(real(m.dataDir) + path.sep), `el clon no está dentro de SITE_DATA_DIR: ${clon}`);
    assert.ok(fs.existsSync(path.join(clon, '.git')), 'el clon existe');
    const conGit = [];
    const recorrer = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.name === '.git') conGit.push(p); else if (e.isDirectory()) recorrer(p); } };
    recorrer(m.dataDir);
    assert.deepStrictEqual(conGit, [], 'ningún repo de git en el disco de datos');
    assert.ok(fs.readdirSync(m.dataDir).some((f) => /\.json$/.test(f)), 'el estado de la configuración sí se guarda en el disco de datos');
  } finally { await m.cerrar(); }
});

test('T21 RepoDeOperaciones_CredencialNuncaEnElDisco', { skip: SIN_BACKEND }, async () => {
  const m = await montar();
  try {
    await m.fuentes.refrescar();
    assert.ok(m.git.pedidos.length > 0 && m.git.pedidos.every((p) => p.conCabecera), 'cada pedido al repo lleva la cabecera');
    assert.strictEqual(m.fuentes.estado().cargado, true);
    assert.strictEqual(m.fuentes.config().site.maintainers[0], 'lead@acme.example', 'leyó operations.json del clon');
    const clon = m.fuentes.clones().operaciones.dir;
    const gitConfig = fs.readFileSync(path.join(clon, '.git', 'config'), 'utf8');
    const b64 = CABECERA.split(' ')[1];
    assert.ok(!gitConfig.includes(TOKEN) && !gitConfig.includes(b64), 'ni el token ni la cabecera en .git/config');
    assert.match(gitConfig, new RegExp(`url = ${m.git.url('ops.git').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`), 'la dirección, sin credencial');
    for (const l of m.llamadas) {
      assert.ok(!l.args.some((a) => a.includes(TOKEN) || a.includes(b64)), `ningún argumento con la credencial: git ${l.args.join(' ')}`);
      assert.ok(Object.keys(l.env || {}).some((k) => /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)), 'la cabecera va por variables de git');
    }
    // un segundo refresco hace fetch sobre el mismo clon
    m.repo.cambiar({ 'scripts/nightly/dashboard/declared.json': { declared: [] } });
    await m.fuentes.refrescar();
    assert.deepStrictEqual(m.fuentes.modelo().declarados.lista, [], 'el fetch trajo el cambio');
    assert.ok(m.llamadas.some((l) => l.args.includes('fetch')));
    assert.ok(!m.registro.join('\n').includes(TOKEN), 'tampoco en el registro');
  } finally { await m.cerrar(); }
});

test('T22 Buzon_SoloConCredencialDeLectura', { skip: SIN_BACKEND }, async () => {
  const blobs = { 'maq-a-11111111/s1.json': H.volcado('s1', `${HOY}T08:00:00Z`) };
  const buenos = [['sp=rl', {}]];
  const malos = [['sp=rlw', { sp: 'rlw' }], ['sp=c', { sp: 'c' }], ['sp=rlm', { sp: 'rlm' }], ['sp=rlx', { sp: 'rlx' }], ['sr=b', { sr: 'b' }],
    ['de cuenta', { sr: null, ss: 'b', srt: 'co' }], ['sin si', { si: null }], ['vencida', { se: '2020-01-01T00:00:00Z' }], ['sp=r sin l', { sp: 'r' }],
    ['sp repetido', { __crudo: 'sp=rlw' }]];
  for (const [caso, extra] of [...buenos, ...malos]) {
    const m = await montar({ blobs, sasExtra: extra });
    try {
      await m.fuentes.refrescar();
      const c = m.fuentes.modelo().corridas;
      if (caso === 'sp=rl') {
        assert.strictEqual(c.estado, 'medido', caso);
        assert.strictEqual(c.lista.length, 1);
        assert.ok(m.buzon.pedidos.length > 0 && m.buzon.pedidos.every((p) => /[?&]sig=/.test(p.query) && p.auth === null), 'la SAS en la consulta y ningún Bearer');
      } else {
        assert.strictEqual(c.estado, 'no_medido', caso);
        assert.strictEqual(c.codigo, 'credencial_rechazada', caso);
        assert.strictEqual(m.buzon.pedidos.length, 0, `${caso}: no se usa`);
      }
    } finally { await m.cerrar(); }
  }
  // la identidad administrada: el token lo da un servidor local que hace de la plataforma
  const plataforma = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const ok = req.headers['x-identity-header'] === 'cabecera-plataforma' && u.searchParams.get('resource') === 'https://storage.azure.com/';
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { access_token: 'tok-identidad', expires_on: String(Math.floor(Date.now() / 1000) + 3600) } : { error: 'mal' }));
  });
  await new Promise((r) => plataforma.listen(0, '127.0.0.1', r));
  const antes = { e: process.env.IDENTITY_ENDPOINT, h: process.env.IDENTITY_HEADER };
  process.env.IDENTITY_ENDPOINT = `http://127.0.0.1:${plataforma.address().port}/msi/token`;
  process.env.IDENTITY_HEADER = 'cabecera-plataforma';
  const m = await montar({ blobs, credBuzon: { SITE_MAILBOX_IDENTITY: 'managed' } });
  try {
    await m.fuentes.refrescar();
    assert.strictEqual(m.fuentes.modelo().corridas.estado, 'medido', 'con la identidad administrada');
    assert.ok(m.buzon.pedidos.every((p) => p.auth === 'Bearer tok-identidad' && !/sig=/.test(p.query)));
  } finally {
    await m.cerrar();
    plataforma.close();
    for (const [k, v] of [['IDENTITY_ENDPOINT', antes.e], ['IDENTITY_HEADER', antes.h]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('T24 Despertar_CargandoYDespues', { skip: SIN_BACKEND }, async () => {
  const emisor = await arrancarEmisor();
  const m = await montar({ blobs: { 'maq-a-11111111/s1.json': H.volcado('s1', `${HOY}T08:00:00Z`) } });
  let h = null;
  try {
    h = await H.arrancarSitio({ env: { ...m.env, SITE_OIDC_ISSUER: emisor.issuer }, fuentes: m.fuentes, ahora: () => T0 });
    const s = await entrar(h, emisor, 'lead@acme.example', T0);
    assert.ok(s, 'entró');
    const antes = await h.pedir('/', { cookie: s });
    assert.strictEqual(antes.status, 503, 'antes de la primera lectura');
    assert.strictEqual(antes.headers['retry-after'], '5');
    assert.match(antes.texto, /cargando las fuentes/);
    assert.ok(!/Dependencias nuevas/.test(antes.texto), 'nunca una página con ceros');
    await m.fuentes.refrescar();
    const despues = await h.pedir('/', { cookie: s });
    assert.strictEqual(despues.status, 200);
    assert.match(despues.texto, /Dependencias nuevas/);
  } finally { if (h) await h.cerrar(); await m.cerrar(); await emisor.cerrar(); }
  // primera lectura con el buzón caído y una foto que falta: filas «no medido» con su estado, nunca 0
  const m2 = await montar({ archivos: { [`.dashboard/vigilante/vigilante-${HOY}.json`]: null } });
  try {
    m2.buzon.st.modo = 500;
    await m2.fuentes.refrescar();
    const mod = m2.fuentes.modelo();
    assert.strictEqual(m2.fuentes.estado().cargado, true);
    assert.strictEqual(mod.corridas.estado, 'no_medido');
    assert.ok(['sin_red', 'parcial'].includes(mod.corridas.codigo), mod.corridas.codigo);
    assert.strictEqual(mod.vigilante.estado, 'no_medido');
    assert.strictEqual(mod.vigilante.codigo, 'sin_foto');
    assert.strictEqual(mod.dependencias.estado, 'medido');
    // lo que va a la pantalla es un estado de lista cerrada: nunca un motivo crudo con rutas o blobs
    const texto = JSON.stringify(mod);
    assert.ok(!texto.includes(m2.dataDir) && !texto.includes(m2.buzon.base) && !texto.includes(m2.raiz), 'sin rutas ni direcciones en el modelo');
    assert.ok(m2.registro.some((l) => /buz/.test(l)), 'el motivo crudo va al registro');
  } finally { await m2.cerrar(); }
});

test('T25 Refresco_FallaYConservaElUltimoBueno', { skip: SIN_BACKEND }, async () => {
  let t = T0;
  const m = await montar({ ahora: () => t, archivos: { [`.dashboard/vigilante/vigilante-${HOY}.json`]: null, '.dashboard/vigilante/vigilante-2026-10-12.json': { fecha: '2026-10-12', productos: {}, resumen: { rubros: { pendientes: { valor: [] }, aceptadas_sin_story: { valor: [] } } } } } });
  try {
    await m.fuentes.refrescar();
    const primero = JSON.parse(JSON.stringify(m.fuentes.modelo()));
    assert.strictEqual(primero.vigilante.estado, 'no_medido', 'del 12 con max_age_days 2: vieja');
    assert.strictEqual(primero.vigilante.codigo, 'fuente_vieja');
    assert.strictEqual(primero.vigilante.fecha, '2026-10-12', 'con la fecha');
    assert.strictEqual(m.fuentes.estado().bandaRefresco, null);
    t += HORA;
    m.git.caido = true;
    await m.fuentes.refrescar();
    assert.deepStrictEqual(m.fuentes.modelo(), primero, 'el modelo anterior entero, no vacío');
    const b = m.fuentes.estado().bandaRefresco;
    assert.ok(b, 'la banda');
    assert.strictEqual(b.desde, t, 'con la hora');
    assert.ok(['sin_red', 'credencial_rechazada', 'parcial'].includes(b.estado), b.estado);
    m.git.caido = false;
    t += HORA;
    await m.fuentes.refrescar();
    assert.strictEqual(m.fuentes.estado().bandaRefresco, null, 'el refresco bueno saca la banda');
  } finally { await m.cerrar(); }
});

test('T40 Configuracion_UltimoBuenoBandaYFreno', { skip: SIN_BACKEND }, async () => {
  // la regla, pura
  assert.deepStrictEqual(estadoDeLaConfiguracion({ hayUltimoBueno: true, fallaDesde: null, ahora: T0 }).estado, 'vigente');
  assert.strictEqual(estadoDeLaConfiguracion({ hayUltimoBueno: true, fallaDesde: T0, ahora: T0 + 23 * HORA + 59 * 60000 }).estado, 'ultimo_bueno');
  assert.strictEqual(estadoDeLaConfiguracion({ hayUltimoBueno: true, fallaDesde: T0, ahora: T0 + 24 * HORA + 60000 }).estado, 'frenado');
  assert.strictEqual(estadoDeLaConfiguracion({ hayUltimoBueno: false, fallaDesde: T0, ahora: T0 }).estado, 'frenado');

  let t = T0 - HORA;
  const emisor = await arrancarEmisor();
  const m = await montar({ ahora: () => t });
  let h = null;
  try {
    await m.fuentes.refrescar();
    h = await H.arrancarSitio({ env: { ...m.env, SITE_OIDC_ISSUER: emisor.issuer }, fuentes: m.fuentes, ahora: () => t });
    let s = await entrar(h, emisor, 'lead@acme.example', t);
    // a las 0 h, operations.json deja de validar (una clave desconocida)
    t = T0;
    s = await entrar(h, emisor, 'lead@acme.example', t);
    m.repo.cambiar({ 'operations.json': { version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'] }, clave_nueva: 1 } });
    await m.fuentes.refrescar();
    let e = m.fuentes.estado();
    assert.strictEqual(e.frenado, null);
    assert.strictEqual(e.bandaConfig.desde, T0);
    assert.match(e.bandaConfig.motivo, /clave_nueva/, 'con la ruta de cada problema');
    assert.strictEqual(m.fuentes.config().site.maintainers[0], 'lead@acme.example', 'vale el último bueno');
    const ini = await h.pedir('/', { cookie: s });
    assert.strictEqual(ini.status, 200);
    assert.match(ini.texto, /la configuración de la organización no se pudo releer desde/, 'quien mantiene ve la banda');
    // a las 23 h 59 min, igual
    t = T0 + 23 * HORA + 59 * 60000;
    await m.fuentes.refrescar();
    assert.strictEqual(m.fuentes.estado().frenado, null);
    // a las 24 h 1 min, frenado para todos: cada ruta de la tabla trae sólo la página del freno
    t = T0 + 24 * HORA + 60000;
    s = await entrar(h, emisor, 'lead@acme.example', t);
    await m.fuentes.refrescar();
    e = m.fuentes.estado();
    assert.ok(e.frenado, 'frenado');
    const { RUTAS } = require(path.join(H.SITE, 'server.js'));
    for (const r of RUTAS) {
      const res = await h.pedir(r.path, { cookie: s });
      assert.strictEqual(res.status, 503, r.path);
      assert.ok(!/clave_nueva|operations\.json|Dependencias nuevas/.test(res.texto), `${r.path}: sin rutas ni nombres del archivo, sin datos`);
    }
    assert.match((await h.pedir('/', { cookie: s })).texto, /el sitio está frenado desde .*: la configuración de la organización no valida; se destraba cuando un refresco la lee bien/);
    const hz = await h.pedir('/healthz');
    assert.strictEqual(hz.status, 503);
    assert.strictEqual(hz.json.ok, false);
    assert.match(hz.json.motivo, /^la configuración de la organización no valida desde \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    assert.deepStrictEqual([(await h.pedir('/livez')).status, (await h.pedir('/readyz')).status], [200, 200]);
    // el primer refresco que lo lee bien destraba
    m.repo.cambiar({ 'operations.json': { version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'], mailbox: { provider: 'azure-blob', account: 'acmeruns', container: 'runs' } } } });
    t += HORA;
    await m.fuentes.refrescar();
    e = m.fuentes.estado();
    assert.deepStrictEqual([e.frenado, e.bandaConfig], [null, null]);
    assert.strictEqual((await h.pedir('/', { cookie: s })).status, 200);
    // otra fuente caída: banda «no se pudo actualizar» y sin freno
    m.buzon.st.modo = 500;
    t += HORA;
    await m.fuentes.refrescar();
    e = m.fuentes.estado();
    assert.strictEqual(e.frenado, null);
    assert.ok(e.bandaRefresco, 'banda de la otra fuente');
  } finally { if (h) await h.cerrar(); await m.cerrar(); await emisor.cerrar(); }
  // una persona no ve la banda de la configuración (con fuentes fijas: el lector todavía no admite `people`)
  const emisor2 = await arrancarEmisor();
  const cfgPersona = { version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'] }, people: { machines: { 'maq-a-11111111': { person: 'dev.a@acme.example', reported_sha256: null } } } };
  const h2 = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor2.issuer }), fuentes: H.fuentesFijas({ config: cfgPersona, bandaConfig: { desde: T0, motivo: 'clave_nueva: clave desconocida' } }) });
  try {
    const sp = await entrar(h2, emisor2, 'dev.a@acme.example', Date.now());
    const r = await h2.pedir('/', { cookie: sp });
    assert.strictEqual(r.status, 200);
    assert.ok(!/no se pudo releer|clave_nueva/.test(r.texto), 'la persona sigue viendo lo suyo, sin la banda');
  } finally { await h2.cerrar(); await emisor2.cerrar(); }
});

test('T41 Configuracion_PlazoNoSeReiniciaAlDespertar', { skip: SIN_BACKEND }, async () => {
  let t = T0 - HORA;
  const dataDir = tmp('site-data-t41-');
  const m = await montar({ ahora: () => t, dataDir });
  try {
    await m.fuentes.refrescar();
    t = T0;
    m.repo.cambiar({ 'operations.json': '{ roto' });
    await m.fuentes.refrescar();
    assert.strictEqual(m.fuentes.estado().bandaConfig.desde, T0);
    m.fuentes.detener();
    // el proceso se reinicia a las 23 h con el mismo SITE_DATA_DIR y el archivo todavía roto
    t = T0 + 23 * HORA;
    const otra = crearFuentes({ cfg: m.cfg, dataDir, log: () => {}, ahora: () => t, urlBuzon: m.buzon.base });
    await otra.refrescar();
    assert.strictEqual(otra.estado().frenado, null, 'sigue con el último bueno');
    assert.strictEqual(otra.estado().bandaConfig.desde, T0, 'el plazo cuenta desde la primera falla, no desde el reinicio');
    assert.strictEqual(otra.config().site.maintainers[0], 'lead@acme.example');
    t = T0 + 24 * HORA + 60000;
    await otra.refrescar();
    assert.ok(otra.estado().frenado, 'se frena a las 24 h (no a las 47)');
    otra.detener();
    assert.ok(!fs.readdirSync(dataDir).some((f) => f.includes('.tmp')), 'escrito de forma atómica: sin temporales');
  } finally { await m.cerrar(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  // arranque con el archivo roto y SITE_DATA_DIR vacío: frenado desde el arranque, también para el primer mantenedor
  const emisor = await arrancarEmisor();
  const m2 = await montar({ config: { version: 1 }, firstMaintainer: 'first@acme.example' });
  let h = null;
  try {
    await m2.fuentes.refrescar();
    assert.ok(m2.fuentes.estado().frenado, 'sin último bueno: freno inmediato');
    h = await H.arrancarSitio({ env: { ...m2.env, SITE_OIDC_ISSUER: emisor.issuer }, fuentes: m2.fuentes });
    const s = await entrar(h, emisor, 'first@acme.example', Date.now());
    const r = await h.pedir('/', { cookie: s });
    assert.strictEqual(r.status, 503);
    assert.match(r.texto, /el sitio está frenado/);
  } finally { if (h) await h.cerrar(); await m2.cerrar(); await emisor.cerrar(); }
});

// ── casos de borde de las fuentes ───────────────────────────────────────────────────────────────────────────────────
const g = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@acme.example', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@acme.example', GIT_AUTHOR_DATE: '2026-10-15T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-15T12:00:00Z' } }); if (r.status !== 0) throw new Error(r.stderr); };

test('2.23-R1 Buzon_IncompletoEsParcial', async () => {
  // bajar() devuelve 'bajado' también cuando se acabó el presupuesto: `completo` es el criterio, no el estado
  const nube = { PROVEEDORES_DE_BUZON: ['azure-blob'], bajarBuzon: async () => ({ codigo: 0, res: { estado: 'bajado', completo: false, sin_tiempo: 4, bajados: 2 } }) };
  const dataDir = tmp('site-r1-');
  const v = validarConfiguracion(H.envBase({ SITE_MAILBOX_SAS: H.sas() }));
  const raiz = tmp('site-r1-repo-');
  try {
    repoConArchivos(raiz, 'ops.git', H.archivosDeOperaciones({ config: { version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'], mailbox: { provider: 'azure-blob', account: 'acmeruns', container: 'runs' } } } }), path.join(raiz, 'trabajo'));
    // sin red: el «repo» es el bare local por ruta (el clon lo hace git sin HTTP)
    const f = crearFuentes({ cfg: { ...v.cfg, operationsRepo: path.join(raiz, 'ops.git') }, dataDir, log: () => {}, nubes: [nube] });
    await f.refrescar();
    assert.strictEqual(f.modelo().corridas.estado, 'no_medido');
    assert.strictEqual(f.modelo().corridas.codigo, 'parcial');
    assert.strictEqual(f.estado().bandaRefresco.estado, 'parcial', 'con banda');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(raiz, { recursive: true, force: true }); }
});

test('2.23-R2 Repo_EstadosDeGitYRemotoCambiado', { skip: SIN_BACKEND }, async () => {
  const { estadoDeGit } = require(path.join(H.SITE, 'sources.js'));
  assert.strictEqual(estadoDeGit("remote: TF401019: The Git repository with name or identifier ops does not exist or you do not have permissions\nfatal: repository 'x' not found"), 'sin_permiso');
  assert.strictEqual(estadoDeGit('fatal: Authentication failed for x'), 'credencial_rechazada');
  assert.strictEqual(estadoDeGit("fatal: unable to access 'x': Could not resolve host: git.acme.example"), 'sin_red');
  // con el mismo SITE_DATA_DIR y otro SITE_OPERATIONS_REPO, se lee el repo nuevo (no el remoto guardado en el clon)
  const m = await montar();
  try {
    await m.fuentes.refrescar();
    const otro = repoConArchivos(m.raiz, 'otro.git', H.archivosDeOperaciones({ extra: { 'scripts/nightly/dashboard/declared.json': { declared: [{ id: 'del-otro', review_before: '2026-12-01' }] } } }), path.join(m.raiz, 'trabajo-otro'));
    void otro;
    const f2 = crearFuentes({ cfg: { ...m.cfg, operationsRepo: m.git.url('otro.git') }, dataDir: m.dataDir, log: () => {}, urlBuzon: m.buzon.base });
    await f2.refrescar();
    assert.deepStrictEqual(f2.modelo().declarados.lista.map((d) => d.id), ['del-otro']);
    f2.detener();
  } finally { await m.cerrar(); }
});

test('T21c Perfil_AntesQueElBuzon_ConSuLineaYSuMotivo', { skip: SIN_BACKEND }, async () => {
  // el perfil del equipo se baja antes que el buzón (la pestaña Configuración no espera a las corridas), deja una línea
  // en el registro cuando se baja, y mientras tanto dice «pendiente», no «sin configurar»; una falla dice su motivo sin
  // la credencial
  const m = await montar({ blobs: { 'b.json': '{}' } });
  try {
    repoConArchivos(m.raiz, 'perfil.git', { 'team-profile.json': JSON.stringify({ version: 1 }) }, path.join(m.raiz, 'trabajo-perfil'));
    const registro = [];
    let buzonAlClonar = null;
    const spawn = (cmd, args, opts) => { if (args.includes('clone') && args.some((a) => a.endsWith('perfil.git'))) buzonAlClonar = m.buzon.pedidos.length; return correr(cmd, args, opts); };
    const cfg = { ...m.cfg, profileRepo: m.git.url('perfil.git'), profileCredencial: { token: TOKEN } };
    const f = crearFuentes({ cfg, dataDir: tmp('site-data-perfil-'), log: (l) => registro.push(l), spawn, urlBuzon: m.buzon.base });
    assert.strictEqual(f.clones().perfil.estado, 'pendiente', 'antes del primer refresco: pendiente, no sin configurar');
    await f.refrescar();
    assert.strictEqual(buzonAlClonar, 0, 'el perfil se clona antes de pedirle nada al buzón');
    assert.ok(f.clones().perfil.dir, 'el perfil quedó bajado');
    assert.strictEqual(f.clones().perfil.estado, 'medido');
    assert.ok(registro.includes('perfil del equipo: bajado'), `una línea en el registro: ${registro.join(' | ')}`);
    await f.refrescar();
    assert.strictEqual(registro.filter((l) => l === 'perfil del equipo: bajado').length, 1, 'una vez, no en cada refresco');
    f.detener();
    // la credencial que no vale: el motivo en el registro, sin el token ni la cabecera
    const reg2 = [];
    const f2 = crearFuentes({ cfg: { ...cfg, profileRepo: m.git.url('no-existe.git') }, dataDir: tmp('site-data-perfil2-'), log: (l) => reg2.push(l), urlBuzon: m.buzon.base });
    await f2.refrescar();
    assert.notStrictEqual(f2.clones().perfil.estado, 'medido');
    const linea = reg2.find((l) => /del perfil del equipo falló/.test(l));
    assert.ok(linea, `la falla dice su motivo: ${reg2.join(' | ')}`);
    assert.ok(!reg2.join('\n').includes(TOKEN) && !reg2.join('\n').includes(CABECERA.split(' ')[1]), 'sin la credencial');
    f2.detener();
  } finally { await m.cerrar(); }
});

test('2.23-R3 Clon_SinEnlacesNiRutasDeAfuera', { skip: SIN_BACKEND }, async () => {
  const afuera = path.join(tmp('site-r3-afuera-'), 'secreto.txt');
  fs.writeFileSync(afuera, 'SECRETO-DE-AFUERA');
  const m = await montar({ archivos: { 'scripts/nightly/dashboard/sources.json': { sources: [{ id: 'escape', pattern: '*.txt', dir: '../../..', max_age_days: 2 }, { id: 'vigilante', pattern: 'vigilante-*.json', dir: 'vigilante', max_age_days: 2 }], thresholds: {} } } });
  try {
    // el tablero del repo pasa a ser un enlace a un archivo de afuera, y la carpeta del vigilante, un enlace a una de afuera
    const t = path.join(m.repo.trabajo, 'artifacts', 'tablero-del-arnes.html');
    fs.rmSync(t); fs.symlinkSync(afuera, t);
    const dirAfuera = path.join(path.dirname(afuera), 'vig');
    fs.mkdirSync(dirAfuera);
    fs.writeFileSync(path.join(dirAfuera, `vigilante-${HOY}.json`), JSON.stringify({ fecha: HOY, productos: { 'SECRETO-DE-AFUERA': {} }, resumen: { rubros: {} } }));
    const vig = path.join(m.repo.trabajo, '.dashboard', 'vigilante');
    fs.rmSync(vig, { recursive: true, force: true }); fs.symlinkSync(dirAfuera, vig);
    g(m.repo.trabajo, 'add', '-A'); g(m.repo.trabajo, 'commit', '-q', '-m', 'enlace'); g(m.repo.trabajo, 'push', '-q', 'origin', 'main');
    await m.fuentes.refrescar();
    const texto = JSON.stringify(m.fuentes.modelo());
    assert.ok(!texto.includes('SECRETO-DE-AFUERA'), 'un enlace del repo no lleva a un archivo de afuera');
    const lista = m.fuentes.modelo().sources.lista;
    assert.ok(!lista.some((s) => s.id === 'escape'), 'un `dir` con .. ni se lee: queda fuera de la lista de fuentes');
    assert.ok(lista.some((s) => s.id === 'vigilante'), 'la fuente bien declarada sí está en la lista');
    assert.strictEqual(m.fuentes.modelo().vigilante.estado, 'no_medido', 'una carpeta que es un enlace a otra de afuera no se lee');
  } finally { await m.cerrar(); fs.rmSync(path.dirname(afuera), { recursive: true, force: true }); }
});

test('2.23-R4 Repo_ConIdentidadAdministradaYErroresDeLaPlataforma', { skip: SIN_BACKEND }, async () => {
  // El repo de operaciones con SITE_OPERATIONS_IDENTITY=managed (el token lo da la plataforma, va como Bearer)
  const raiz = tmp('site-r4-');
  repoConArchivos(raiz, 'ops.git', H.archivosDeOperaciones(), path.join(raiz, 'trabajo'));
  const git = await arrancarRepoHttp({ raiz, cabecera: 'Bearer tok-del-repo' });
  let modo = 200;
  const plataforma = http.createServer((req, res) => { res.writeHead(modo, { 'content-type': 'application/json' }); res.end(JSON.stringify(modo === 200 ? { access_token: 'tok-del-repo' } : { error: 'no' })); });
  await new Promise((r) => plataforma.listen(0, '127.0.0.1', r));
  const antes = { e: process.env.IDENTITY_ENDPOINT, h: process.env.IDENTITY_HEADER };
  process.env.IDENTITY_ENDPOINT = `http://127.0.0.1:${plataforma.address().port}/msi/token`;
  process.env.IDENTITY_HEADER = 'h';
  const dataDir = tmp('site-r4-data-');
  try {
    const v = validarConfiguracion(H.envBase({ SITE_OPERATIONS_REPO: git.url('ops.git'), SITE_OPERATIONS_TOKEN: undefined, SITE_OPERATIONS_IDENTITY: 'managed' }));
    assert.ok(v.ok, JSON.stringify(v.problemas));
    const f = crearFuentes({ cfg: v.cfg, dataDir, log: () => {} });
    await f.refrescar();
    assert.ok(git.pedidos.length && git.pedidos.every((p) => p.conCabecera), 'el repo se leyó con el token de la identidad');
    assert.strictEqual(f.estado().frenado, null);
    // la plataforma rechaza: credencial_rechazada; sin la plataforma: sin_configurar
    const az = require(path.join(H.SITE, 'cloud', 'azure.js'));
    modo = 403;
    assert.strictEqual((await az.tokenDeIdentidad('x')).estado, 'credencial_rechazada');
    modo = 500;
    assert.strictEqual((await az.tokenDeIdentidad('x')).estado, 'sin_permiso');
    assert.strictEqual((await az.tokenDeIdentidad('x', {})).estado, 'sin_configurar');
    f.detener();
  } finally {
    await git.cerrar(); plataforma.close(); fs.rmSync(raiz, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true });
    for (const [k, val] of [['IDENTITY_ENDPOINT', antes.e], ['IDENTITY_HEADER', antes.h]]) { if (val === undefined) delete process.env[k]; else process.env[k] = val; }
  }
});

test('2.23-R5 Fotos_IlegiblesYAusentesNoSonCero', (t) => {
  // en Windows un nombre de archivo no puede llevar un salto de línea: ese caso no se arma ahí, y se dice
  const conSalto = process.platform !== 'win32';
  const raiz = tmp('site-r5-');
  const clon = path.join(raiz, 'operaciones');
  const escribir = (rel, c) => { fs.mkdirSync(path.dirname(path.join(clon, rel)), { recursive: true }); fs.writeFileSync(path.join(clon, rel), typeof c === 'string' ? c : JSON.stringify(c)); };
  try {
    for (const [rel, c] of Object.entries(H.archivosDeOperaciones())) escribir(rel, c);
    escribir('scripts/nightly/dashboard/declared.json', '{ roto');
    escribir('.dashboard/proyectos/Roto__Roto.json', '{ roto');
    if (conSalto) escribir('.dashboard/proyectos/Raro\nnombre__X.json', '{ roto');   // git admite saltos de línea en un nombre de archivo
    else t.diagnostic('NO MEDIDO: en Windows un nombre de archivo no puede llevar un salto de línea');
    // fotos con forma inesperada: sin `results`, sin `failures` — nunca «0 rojas»
    escribir(`.dashboard/controls-bench/banco-${HOY}.json`, { ts: `${HOY}T05:00:00Z`, ran: 10 });
    escribir(`.dashboard/controls-bench/suites-${HOY}.json`, { ts: `${HOY}T05:00:00Z`, corridas: 10 });
    escribir(`.dashboard/paridad/paridad-${HOY}.json`, '{ rota');
    // una foto de la noche que dice «medido» y no trae su lista no es «0 PR» ni «la noche no la midió»: está mal formada
    escribir(`.dashboard/open-prs/open-prs-${HOY}.json`, { estado: 'medido' });
    escribir(`.dashboard/assigned/assigned-${HOY}.json`, { estado: 'medido' });
    fs.rmSync(path.join(clon, 'scripts', 'nightly', 'dependencies', 'repos.json'));
    const registro = [];
    const m = sources.construirDesdeClon(clon, { ahora: T0, log: (l) => registro.push(l) });
    assert.strictEqual(m.declarados.codigo, 'ilegible', 'declared.json roto no es «sin foto»');
    assert.strictEqual(m.proyectos.codigo, 'parcial', 'una foto por proyecto ilegible deja la fuente parcial');
    assert.strictEqual(m.productosFuente.estado, 'no_medido', 'sin repos.json, los productos no son «ninguno»');
    assert.ok(registro.some((l) => /Roto__Roto/.test(l)), 'la foto ilegible se nombra en el registro');
    assert.deepStrictEqual([m.banco.estado, m.banco.codigo], ['no_medido', 'ilegible'], 'banco sin results: ilegible, no 0 rojos');
    assert.deepStrictEqual([m.suites.estado, m.suites.codigo], ['no_medido', 'ilegible'], 'suites sin failures: ilegible, no 0 rojas');
    assert.strictEqual(m.paridad.codigo, 'ilegible', 'una paridad rota no es «la noche no la dejó»');
    assert.deepStrictEqual([m.prs.codigo, m.pedidos.codigo], ['ilegible', 'ilegible'], 'medido sin la lista: ilegible');
    assert.ok(registro.some((l) => /PR del .* dice medido y no trae la lista/.test(l)) && registro.some((l) => /pedidos asignados del .* dice medido/.test(l)), 'y se registra');
    // el registro sale sin saltos de línea aunque el nombre de un archivo los traiga
    assert.ok(registro.length > 0 && registro.every((l) => !/[\n\r]/.test(l)), 'ninguna línea del registro con saltos');
    if (conSalto) assert.ok(registro.some((l) => /Raro nombre__X/.test(l)), 'el nombre con salto se registra en una sola línea');
    // una foto que no se puede leer se nombra en el registro, también la de las fuentes sin registro propio
    escribir(`.dashboard/vigilante/vigilante-${HOY}.json`, '{ roto');
    const r2 = [];
    const m2 = sources.construirDesdeClon(clon, { ahora: T0, log: (l) => r2.push(l) });
    assert.strictEqual(m2.vigilante.codigo, 'ilegible');
    assert.ok(r2.some((l) => /vigilante/.test(l)), 'el vigilante ilegible queda en el registro');
  } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
});

// ── lo que el sitio necesita para la regla de quién es quién ──────────────────────────────────────────
// repos.json que falta, está roto o fuera del clon no es «no hay repos»; el freno con un reloj
// que no se puede leer, o con la primera falla en el futuro, frena
test('2.28-R5 Repos_Y_Reloj_FallanHaciaDecirlo', () => {
  const people = require(path.join(H.SITE, '..', 'lib', 'people.js'));
  const clon = tmp('site-r5-');
  try {
    const ruta = path.join(clon, 'scripts', 'nightly', 'dependencies', 'repos.json');
    assert.deepStrictEqual(sources.leerRepos(clon), { repos: null, motivo: 'el repo de operaciones no trae repos.json' });
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(ruta, '{ roto');
    assert.deepStrictEqual(sources.leerRepos(clon), { repos: null, motivo: 'repos.json no se pudo leer o no es JSON' });
    fs.writeFileSync(ruta, JSON.stringify({ repos: [{ producto: 'Alfa', ruta: 'Alfa/Web', ado: 'Alfa/Web' }, { producto: 'Viejo', ruta: 'V/x', activo: false }, { producto: '', ruta: 'S/x' }, 'no-es-objeto'] }));
    assert.deepStrictEqual(sources.leerRepos(clon), { repos: [{ producto: 'Alfa', ruta: 'Alfa/Web', ado: 'Alfa/Web' }], motivo: null }, 'sólo las entradas activas con producto');
    fs.rmSync(ruta);
    const afuera = path.join(tmp('site-r5-afuera-'), 'repos.json');
    fs.writeFileSync(afuera, JSON.stringify({ repos: [{ producto: 'Ajeno' }] }));
    fs.symlinkSync(afuera, ruta);
    assert.deepStrictEqual(sources.leerRepos(clon), { repos: null, motivo: 'repos.json no es un archivo del repo de operaciones' });
  } finally { fs.rmSync(clon, { recursive: true, force: true }); }
  const e = (o) => people.estadoDeLaConfiguracion({ hayUltimoBueno: true, ...o }).estado;
  assert.strictEqual(e({ fallaDesde: T0, ahora: 'no es una hora' }), 'frenado', 'un reloj que no se puede leer frena');
  assert.strictEqual(e({ fallaDesde: T0 + 2 * HORA, ahora: T0 }), 'frenado', 'una primera falla en el futuro no estira el plazo');
  assert.strictEqual(e({ fallaDesde: T0, ahora: T0 + 2 * HORA }), 'ultimo_bueno');
});

test('T45 2.28-Fuentes_InformadosFueraDelModelo_YCorridasConRepos', { skip: SIN_BACKEND }, async () => {
  const people = require(path.join(H.SITE, '..', 'lib', 'people.js'));
  const MAQ = 'maq-a-11111111';
  // el marcador, armado por partes: un correo entero escrito en el fuente lo toma el freno del empuje
  const MARCA = ['zqx-fuente-correo', 'ejemplo.test'].join('@');
  const HUELLA = people.huellaDeCorreo(MARCA);
  const config = { version: 1, owners: { default: 'lead@acme.example' },
    site: { maintainers: ['lead@acme.example'], mailbox: { provider: 'azure-blob', account: 'acmeruns', container: 'runs' } },
    people: { machines: { [MAQ]: { person: 'dev.a@acme.example', reported_sha256: HUELLA, confirmed_by: 'lead@acme.example', confirmed_on: HOY } } } };
  const blobs = {
    [`${MAQ}/sa.json`]: H.volcado('sa', `${HOY}T08:00:00Z`, { repoPath: '/Users/u/SourceCode/Alfa/Web' }),
    [`${MAQ}/registros/place.json`]: JSON.stringify({ day: HOY, owner: { email: MARCA }, folder: MAQ }),
  };
  let t = T0;
  const m = await montar({ config, blobs, ahora: () => t });
  try {
    // una sola cuenta del freno: la de people.js
    assert.strictEqual(estadoDeLaConfiguracion, people.estadoDeLaConfiguracion);
    assert.strictEqual(people.estadoDeLaConfiguracion({ hayUltimoBueno: false, fallaDesde: null, ahora: T0 }).estado, 'frenado', 'nunca leyó bien: frena');
    await m.fuentes.refrescar();
    const modelo = m.fuentes.modelo();
    const texto = JSON.stringify(modelo);
    assert.ok(!texto.includes(MARCA) && !texto.includes(HUELLA), 'ni el correo informado ni su huella entran al modelo');
    assert.strictEqual(modelo.informados, undefined, 'el modelo ya no tiene lugar para lo informado');
    const personas = m.fuentes.personas();
    assert.strictEqual(personas.informados.maquinas[MAQ].correo, MARCA, 'lo informado queda aparte, para la regla');
    assert.deepStrictEqual(personas.repos.map((r) => r.producto), ['Producto X'], 'la lista de repos.json, para dondeTrabaja');
    assert.strictEqual(modelo.corridas.estado, 'medido');
    assert.strictEqual(modelo.corridas.lista[0].producto, 'Alfa/Web', 'la ejecución con su producto (la carpeta del volcado)');
    assert.strictEqual(modelo.corridas.lista[0].cambio, undefined, 'sin el cambio de git: el sitio no lo baja');
    // operations.json deja de validar: a las 2 horas, la banda; a las 25, el freno desde el primer fallo + 24 horas
    m.repo.cambiar({ 'operations.json': { ...config, clave_nueva: 1 } });
    await m.fuentes.refrescar();
    t = T0 + 2 * HORA;
    await m.fuentes.refrescar();
    assert.deepStrictEqual([m.fuentes.estado().frenado, m.fuentes.estado().bandaConfig.desde], [null, T0]);
    assert.strictEqual(m.fuentes.personas().informados.maquinas[MAQ].correo, MARCA, 'durante el plazo, la regla sigue con lo informado');
    t = T0 + 25 * HORA;
    // sin ningún refresco más (el repo podría no bajarse): el freno se cuenta con la hora de cada pedido
    assert.deepStrictEqual(m.fuentes.estado().frenado, { desde: T0 + 24 * HORA, fallaDesde: T0 }, 'frena a las 24 horas aunque no haya refresco');
    await m.fuentes.refrescar();
    assert.deepStrictEqual(m.fuentes.estado().frenado, { desde: T0 + 24 * HORA, fallaDesde: T0 });
  } finally { await m.cerrar(); }
});

// 🔴 rojo: el espejo bajado como `--no-threads` siempre deja el detalle sin cambios ni antes y después
test('T26 Espejo_BajaHilosYCambios_SoloConThreads @story-2.27 @ac-18', { skip: SIN_BACKEND }, async () => {
  const zlib = require('zlib');
  const blobs = {
    'maq-a-11111111/s1.json': H.volcado('s1', `${HOY}T08:00:00Z`),
    'maq-a-11111111/s1.hilo.jsonl.gz': zlib.gzipSync('{"type":"user"}\n'),
    'maq-a-11111111/s1.cambio.json.gz': zlib.gzipSync('{"version":1,"estado":"medido","repos":[]}'),
    'maq-a-11111111/registros/place.json': JSON.stringify({ install: { version: '2026.10.15.1' } }),
  };
  const mb = (threads) => ({ provider: 'azure-blob', account: 'acmeruns', container: 'runs', ...(threads === undefined ? {} : { threads }) });
  const cfgOps = (threads) => ({ version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'], mailbox: mb(threads) } });
  const enEspejo = (m) => { const d = path.join(m.dataDir, 'buzon', 'maq-a-11111111'); return fs.existsSync(d) ? fs.readdirSync(d).sort() : []; };
  const gets = (m, f) => m.buzon.pedidos.filter((p) => p.ruta.endsWith(f) && !/comp=list/.test(p.query)).length;

  // con `threads: true` y un disco del sitio (SITE_DATA_DIR): la conversación y el cambio se bajan, se resumen y se borran
  // (en el disco queda su resumen), y la segunda bajada no vuelve a bajar nada
  const disco = tmp('site-disco-');
  let m = await montar({ blobs, config: cfgOps(true), dataDir: disco, envExtra: { SITE_DATA_DIR: disco } });
  try {
    await m.fuentes.refrescar();
    assert.deepStrictEqual(enEspejo(m), ['registros', 's1.json', 's1.resumen.json.gz']);
    assert.strictEqual(m.fuentes.hilos(), true, 'la pestaña sabe que el espejo trae las conversaciones');
    const antes = gets(m, 's1.hilo.jsonl.gz');
    assert.strictEqual(antes, 1);
    await m.fuentes.refrescar();
    assert.strictEqual(gets(m, 's1.hilo.jsonl.gz'), antes, 'lo que ya está no se vuelve a bajar');
    assert.strictEqual(gets(m, 's1.cambio.json.gz'), 1);
  } finally { await m.cerrar(); }

  // sin la clave: sólo volcados y registros
  m = await montar({ blobs, config: cfgOps(undefined) });
  try {
    await m.fuentes.refrescar();
    assert.deepStrictEqual(enEspejo(m), ['registros', 's1.json']);
    assert.strictEqual(m.fuentes.hilos(), false);
  } finally { await m.cerrar(); }

  // `threads: true` sin SITE_DATA_DIR (un disco que se pierde al dormir): tampoco
  m = await montar({ blobs, config: cfgOps(true) });
  try {
    await m.fuentes.refrescar();
    assert.deepStrictEqual(enEspejo(m), ['registros', 's1.json']);
    assert.strictEqual(m.fuentes.hilos(), false);
    assert.match(m.registro.join('\n'), /SITE_DATA_DIR/, 'el registro dice por qué no baja las conversaciones');
  } finally { await m.cerrar(); }

  // con una SAS que escribe, nada
  m = await montar({ blobs, config: cfgOps(true), sasExtra: { sp: 'rlw' }, dataDir: disco, envExtra: { SITE_DATA_DIR: disco } });
  try {
    await m.fuentes.refrescar();
    assert.strictEqual(m.buzon.pedidos.length, 0);
  } finally { await m.cerrar(); fs.rmSync(disco, { recursive: true, force: true }); }
});

// La bajada parcial: si la primera pasada de un espejo vacío corta por el tope de 120 s (baja de a un archivo) y la
// siguiente llega recién al refresco de los 15 minutos, la pestaña Corridas queda «no medido (parcial)» todo ese tiempo.
// 🔴 rojo: un blob por vez (maxEnVuelo 1), y después de un corte el próximo refresco a los minutos de siempre
test('T26b BajadaEnParalelo_YSiCortaLaSiguienteEnseguida @story-2.27 @ac-18', { skip: SIN_BACKEND }, async () => {
  const blobs = {};
  for (let i = 0; i < 24; i++) blobs[`maq-a-11111111/s${i}.json`] = H.volcado(`s${i}`, `${HOY}T08:${String(i).padStart(2, '0')}:00Z`);
  // en paralelo: 24 blobs de 150 ms bajan a la vez (no más de 8), muy por debajo de 24 × 150 ms
  let m = await montar({ blobs });
  try {
    m.buzon.st.demora = 150;
    await m.fuentes.refrescar();
    assert.strictEqual(m.fuentes.buzonEstado().completo, true);
    assert.ok(m.buzon.st.maxEnVuelo >= 2 && m.buzon.st.maxEnVuelo <= 8, `en paralelo, con tope: ${m.buzon.st.maxEnVuelo} a la vez`);
    assert.strictEqual(m.fuentes.modelo().corridas.lista.length, 24);
    assert.ok(m.fuentes.proximoRefrescoMs() >= 5 * 60000, 'entera: el refresco de siempre');
  } finally { await m.cerrar(); }
  // si igual corta (un tope chico), la pasada siguiente se programa enseguida y retoma donde quedó, hasta completar
  m = await montar({ blobs, fuentesExtra: { presupuestoBuzonMs: 200 } });
  try {
    m.buzon.st.demora = 150;
    await m.fuentes.refrescar();
    assert.strictEqual(m.fuentes.buzonEstado().completo, false, 'cortó por tiempo');
    assert.ok(m.fuentes.proximoRefrescoMs() <= 10000, `la siguiente, enseguida: ${m.fuentes.proximoRefrescoMs()} ms`);
    for (let i = 0; i < 10 && !m.fuentes.buzonEstado().completo; i++) await m.fuentes.refrescar();
    assert.strictEqual(m.fuentes.buzonEstado().completo, true, 'retomando, terminó entera');
    assert.ok(m.fuentes.proximoRefrescoMs() >= 5 * 60000, 'entera: vuelve al refresco de siempre');
  } finally { await m.cerrar(); }
  // un corte SIN avance (el tope se agotó antes de bajar uno) no se repite enseguida: no es un lazo
  m = await montar({ blobs, fuentesExtra: { presupuestoBuzonMs: -1 } });
  try {
    await m.fuentes.refrescar();
    assert.strictEqual(m.fuentes.buzonEstado().completo, false);
    assert.ok(m.fuentes.proximoRefrescoMs() >= 5 * 60000, 'sin avance: el refresco de siempre');
  } finally { await m.cerrar(); }
});

// ── la copia de operaciones ─────────────────────────────────────────────────────────────────────────
const COPIA = require(path.join(H.SITE, 'operations-copy.js'));
/** Un almacén en memoria con la forma de `almacenDeCopia` de cloud/ (get, put, list, del). */
function almacenEnMemoria() {
  const blobs = new Map();
  return {
    blobs,
    async get(n) { const b = blobs.get(n); return b ? { status: 200, cuerpo: b.cuerpo } : { status: 404, cuerpo: Buffer.alloc(0) }; },
    async put(n, c) { blobs.set(n, { cuerpo: Buffer.from(c), modificado: Date.now() }); return { status: 201 }; },
    async list(p) { return { status: 200, blobs: [...blobs].filter(([k]) => k.startsWith(p)).map(([name, b]) => ({ name, modificado: b.modificado })) }; },
    async del(n) { blobs.delete(n); return { status: 202 }; },
  };
}
const sinGenerado = (m) => { const { generado, ...resto } = m; return resto; };
const envCopia = (m, extra = {}) => {
  const env = { ...m.env, SITE_OPERATIONS_SOURCE: 'copy', SITE_OPERATIONS_COPY: 'acmeops/copia', ...extra };
  delete env.SITE_OPERATIONS_TOKEN;
  return env;
};

test('T21 2.34-Arranque_CredencialQueSobra @story-2.34 @ac-7 — con la copia, el token o la identidad del repo sobran', () => {
  // 🔴 rojo: el sitio arranca con `copy` y además el permiso del repo, y sigue dependiendo de él.
  const base = H.envBase({ SITE_OPERATIONS_SOURCE: 'copy', SITE_OPERATIONS_COPY: 'acmeops/copia' });
  for (const [sobra, valor] of [['SITE_OPERATIONS_TOKEN', 'tok-x'], ['SITE_OPERATIONS_IDENTITY', 'managed']]) {
    const env = { ...base }; delete env.SITE_OPERATIONS_TOKEN; env[sobra] = valor;
    const v = validarConfiguracion(env);
    assert.strictEqual(v.ok, false, `${sobra} con copy no arranca`);
    assert.ok(v.problemas.some((p) => p.variable === sobra && /sobra/.test(p.motivo)), JSON.stringify(v.problemas));
  }
  const ok = { ...base }; delete ok.SITE_OPERATIONS_TOKEN;
  const v = validarConfiguracion(ok);
  assert.strictEqual(v.ok, true, JSON.stringify(v.problemas));
  assert.deepStrictEqual(v.cfg.operationsCopy, { cuenta: 'acmeops', contenedor: 'copia', credencial: { managed: true } }, 'en Azure: la identidad administrada');
  const conSas = validarConfiguracion({ ...ok, SITE_OPERATIONS_COPY_SAS: 'sv=2021-08-06&sr=c&sp=rl&se=2099-01-01T00:00:00Z&sig=x' });
  assert.strictEqual(conSas.ok, true, JSON.stringify(conSas.problemas));
  assert.deepStrictEqual(conSas.cfg.operationsCopy.credencial, { sas: 'sv=2021-08-06&sr=c&sp=rl&se=2099-01-01T00:00:00Z&sig=x' });
  for (const [k, val] of [['SITE_OPERATIONS_COPY', ''], ['SITE_OPERATIONS_COPY', 'Cuenta Mal/x'], ['SITE_OPERATIONS_SOURCE', 'otra'], ['SITE_OPERATIONS_COPY_SAS', 'sr=c&sp=rwl&se=2099-01-01&sig=x'], ['SITE_OPERATIONS_COPY_SAS', 'sr=b&sp=r&se=2099-01-01&sig=x'], ['SITE_OPERATIONS_COPY_SAS', 'sr=c&sp=r&sig=x'], ['SITE_OPERATIONS_COPY_SAS', 'sr=c&sp=r&se=2099-01-01']]) {
    const r = validarConfiguracion({ ...ok, [k]: val });
    assert.strictEqual(r.ok, false, `${k}=${val} no arranca`);
    assert.ok(r.problemas.some((p) => p.variable === k), JSON.stringify(r.problemas));
  }
  // la SAS sin la copia elegida: sobra también (una credencial que nadie usa no se deja puesta)
  const sasSola = validarConfiguracion(H.envBase({ SITE_OPERATIONS_COPY_SAS: 'sr=c&sp=r&se=2099-01-01&sig=x' }));
  assert.ok(sasSola.problemas.some((p) => p.variable === 'SITE_OPERATIONS_COPY_SAS'), JSON.stringify(sasSola.problemas));
});

test('T22 2.34-Fuente_RepoIgualQueHoy @story-2.34 @ac-16 — sin la variable y con `repo`, lo de hoy', { skip: SIN_BACKEND }, async () => {
  // 🔴 rojo: la copia cambia algo del sitio que no la eligió.
  const hoy = await montar();
  const conRepo = await montar({ envExtra: { SITE_OPERATIONS_SOURCE: 'repo' } });
  try {
    assert.strictEqual(hoy.cfg.operationsSource, 'repo');
    assert.strictEqual(conRepo.cfg.operationsSource, 'repo');
    assert.strictEqual(hoy.cfg.operationsCopy, null);
    await hoy.fuentes.refrescar(); await conRepo.fuentes.refrescar();
    assert.deepStrictEqual(sinGenerado(conRepo.fuentes.modelo()), sinGenerado(hoy.fuentes.modelo()));
    assert.deepStrictEqual(conRepo.fuentes.estado(), hoy.fuentes.estado());
    for (const m of [hoy, conRepo]) {
      assert.ok(fs.existsSync(path.join(m.fuentes.clones().operaciones.dir, '.git')), 'lee de un clon de git, como hoy');
      assert.ok(m.git.pedidos.length > 0, 'clonó por HTTP');
      assert.ok(!fs.existsSync(path.join(m.dataDir, 'operaciones-copia')), 'ninguna carpeta de la copia');
    }
  } finally { await hoy.cerrar(); await conRepo.cerrar(); }
});

test('T23 2.34-Fuente_MismoModeloQueElRepo @story-2.34 @ac-6 @ac-16 — el mismo repo, directo y por la copia', { skip: SIN_BACKEND }, async () => {
  // 🔴 rojo: la copia deja afuera algo que el sitio lee, y una pestaña muestra otra cosa.
  const m = await montar({ archivos: { 'artifacts/tablero-del-arnes.html': '<html><body>tablero</body></html>' } });
  try {
    await m.fuentes.refrescar();
    const directo = m.fuentes.modelo();
    const al = almacenEnMemoria();
    const sub = await COPIA.subir({ repo: m.repo.trabajo, almacen: al, log: () => {} });
    assert.strictEqual(sub.ok, true, sub.motivo);
    const v = validarConfiguracion(envCopia(m));
    assert.ok(v.ok, JSON.stringify(v.problemas));
    const pedidosAntes = m.git.pedidos.length;
    const dataDir = tmp('site-data-copia-');
    const f = crearFuentes({ cfg: v.cfg, dataDir, log: () => {}, ahora: () => T0, urlBuzon: m.buzon.base, almacenCopia: al });
    try {
      await f.refrescar();
      assert.strictEqual(m.git.pedidos.length, pedidosAntes, 'con la copia no se clona nada');
      assert.deepStrictEqual(sinGenerado(f.modelo()), sinGenerado(directo), 'el mismo modelo, campo por campo');
      assert.deepStrictEqual(f.config(), m.fuentes.config());
      assert.deepStrictEqual(f.estado(), m.fuentes.estado());
      const op = f.clones().operaciones;
      assert.ok(op && !fs.existsSync(path.join(op.dir, '.git')), 'una carpeta para leer, sin git');
      assert.ok((fs.realpathSync(op.dir) + path.sep).startsWith(fs.realpathSync(dataDir) + path.sep), 'la foto se abre dentro de SITE_DATA_DIR');
      assert.strictEqual(op.indice.commit, sub.commit);
    } finally { f.detener(); }
  } finally { await m.cerrar(); }
});
