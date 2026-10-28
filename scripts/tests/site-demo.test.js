'use strict';
/*
 * site-demo.test.js — el sitio demo: el mismo servidor con `SITE_DEMO=1`, abierto, de sólo lectura y sin
 * llamadas afuera.
 *
 * Los datos de ejemplo («acme») que viajan en la imagen (scripts/site/demo/), las fuentes que los leen sin git ni buzón,
 * el arranque sin proveedor ni secretos, el freno de red, de procesos y de escrituras, el recorrido de cada ruta del
 * servidor, los botones que muestran lo que pasaría, la franja «Datos de ejemplo» y lo mínimo de un sitio público.
 *
 * Sin red: lo que en el sitio real sale a la plataforma se contesta de adentro del proceso. Correos y nombres inventados.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'scripts', 'site');
const DEMO = () => require(path.join(SITE, 'demo.js'));
const DATOS = () => require(path.join(SITE, 'demo', 'data.js'));
const H = require('./lib/site-harness.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

// ── los datos de ejemplo y las fuentes que los leen ─────────────────────────────────────────────────────────
// El resumen (sha256 del JSON con las claves ordenadas) de lo que las capturas de la guía armaban en línea, medido con el
// guion de antes de mover los datos y a esta misma hora: si los datos movidos dan el mismo resumen, las capturas salen iguales.
const AHORA_FIJO = Date.parse('2026-10-22T15:30:00Z');
const RESUMEN_DE_LAS_CAPTURAS = 'cef71fb65e5da931de9ac58dae3564f1723300c7ba3d18f88612edc97fb3fd31';
const canonico = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((q) => [q, x[q]])) : x));

test('2.76-Capturas_MismosDatos', () => {
  const D = DATOS();
  const out = {
    operaciones: D.operaciones({ ahora: AHORA_FIJO }),
    operacionesAcceso: D.operaciones({ ahora: AHORA_FIJO, access: [{ role: 'maintainer', emails: ['lead@acme.example'] }] }),
    buzon: D.blobsDelBuzon(AHORA_FIJO),
    PERFIL: D.PERFIL,
    REPOS: D.REPOS,
  };
  assert.strictEqual(crypto.createHash('sha256').update(canonico(out)).digest('hex'), RESUMEN_DE_LAS_CAPTURAS);
  // las suites del sitio siguen pidiéndole sus datos al ayudante de siempre, que los toma de la misma carpeta
  assert.strictEqual(H.archivosDeOperaciones, D.archivosDeOperaciones);
  assert.strictEqual(H.volcado, D.volcadoMinimo);
  // la guía de las capturas no trae ya los datos en línea: los pide a scripts/site/demo/
  const guion = fs.readFileSync(path.join(ROOT, 'scripts', 'tools', 'site-guide-captures.js'), 'utf8');
  assert.match(guion, /site\/demo\/data\.js/);
  assert.doesNotMatch(guion, /function blobsDelBuzon|function volcado\(/);
});

test('2.76-Demo_Datos_SonDeAcmeYSiguenElDia', () => {
  const D = DATOS();
  const hoy = D.operaciones({ ahora: AHORA_FIJO });
  const manana = D.operaciones({ ahora: AHORA_FIJO + 864e5 });
  assert.ok(hoy['.dashboard/dependencias/dependencias-2026-10-22.json'], 'las fotos de hoy llevan la fecha de hoy');
  assert.ok(manana['.dashboard/dependencias/dependencias-2026-10-23.json'], 'al día siguiente, las de ese día');
  // sólo nombres inventados: ningún correo ni dirección que no sea de ejemplo
  const todo = JSON.stringify([hoy, D.blobsDelBuzon(AHORA_FIJO), D.PERFIL, D.REPOS]);
  const correos = todo.match(/[\w.+-]+@[\w.-]+/g) || [];
  assert.ok(correos.length > 0);
  for (const c of correos) assert.match(c, /@acme\.example$/, `correo fuera de acme.example: ${c}`);
  for (const u of todo.match(/https?:\/\/[^"\\\s]+/g) || []) assert.match(new URL(u).hostname, /(^|\.)(acme\.example|example|invalid)$|^dev\.azure\.com$/, `dirección fuera de las de ejemplo: ${u}`);
});

test('2.76-Demo_FuentesDeEjemplo_ArmanElModeloDeAcme', async () => {
  const { crearFuentesDemo } = DEMO();
  const dir = tmp('demo-fuentes-');
  const f = crearFuentesDemo({ dir });
  await f.refrescar();
  assert.deepStrictEqual([f.estado().cargado, f.estado().navegable, f.estado().frenado, f.estado().bandaConfig, f.estado().bandaRefresco], [true, true, null, null, null]);
  const m = f.modelo();
  assert.deepStrictEqual(m.productos.map((p) => p.producto).sort(), ['Producto X', 'Producto Y']);
  for (const k of ['dependencias', 'vigilante', 'banco', 'suites', 'proyectos', 'productosFuente', 'corridas']) assert.strictEqual(m[k].estado, 'medido', `${k} se lee de los datos de ejemplo`);
  assert.strictEqual(m.corridas.lista.length, 5, 'las cinco ejecuciones de ejemplo');
  assert.ok(Array.isArray(m.fichas) || (m.fichas && typeof m.fichas === 'object'), 'las fichas del tablero también');
  const c = f.config();
  assert.strictEqual(c.site.brand.name, 'Acme');
  assert.deepStrictEqual(Object.keys(f.personas().informados.maquinas).sort(), ['mac-ana', 'mac-bruno', 'mac-lead']);
  assert.ok(f.personas().repos.length >= 2, 'la lista de repos para «dónde trabaja»');
  // los clones que lee Configuración: carpetas con la versión de cada archivo, sin git
  const cl = f.clones();
  assert.ok(fs.existsSync(path.join(cl.operaciones.dir, 'operations.json')));
  assert.match(cl.operaciones.indice.archivos['operations.json'], /^[0-9a-f]{40}$/);
  assert.ok(fs.existsSync(path.join(cl.perfil.dir, 'team-repos.json')));
  assert.match(cl.perfil.indice.archivos['team-repos.json'], /^[0-9a-f]{40}$/);
  assert.strictEqual(cl.perfil.estado, 'medido');
  assert.ok(!fs.existsSync(path.join(cl.operaciones.dir, '.git')) && !fs.existsSync(path.join(cl.perfil.dir, '.git')), 'sin git');
  // todo lo que escribe queda en su carpeta
  assert.ok(f.dirBuzon.startsWith(dir));
  assert.strictEqual(f.hilos(), true, 'cada ejecución trae su conversación de ejemplo');
  const sid = Object.keys(DATOS().blobsDelBuzon(AHORA_FIJO)).find((k) => /\.json$/.test(k) && !/place/.test(k));
  assert.ok(fs.existsSync(path.join(f.dirBuzon, sid.replace(/\.json$/, '.hilo.jsonl.gz'))));
  assert.deepStrictEqual(f.buzonEstado(), { completo: true, generacion: 1, siguiendo: false });
  assert.strictEqual(typeof f.exclusivo(() => 7).then, 'function');
  f.detener();
});

test('2.76-Demo_FuentesDeEjemplo_AlDiaSiguienteRehacenLosDatos', async () => {
  const { crearFuentesDemo } = DEMO();
  let t = AHORA_FIJO;
  const f = crearFuentesDemo({ dir: tmp('demo-dia-'), ahora: () => t });
  await f.refrescar();
  assert.strictEqual(f.modelo().dependencias.fecha, '2026-10-22');
  t += 3 * 864e5;
  // tres días después una foto fija sería «fuente vieja»: los datos de ejemplo se rehacen con la fecha de hoy
  assert.strictEqual(f.modelo().dependencias.estado, 'medido');
  assert.strictEqual(f.modelo().dependencias.fecha, '2026-10-25');
});

test('2.76-Demo_RespuestasDePlataforma_SinRedYSinError', async () => {
  const { fetchDemo, URL_BASE, REMOTOS } = DEMO();
  const RP = require(path.join(ROOT, 'scripts', 'lib', 'repo-proposal.js'));
  const org = 'acme';
  const opts = { token: 'ejemplo', urlBase: URL_BASE, fetch: fetchDemo };
  const pip = await RP.pipelinesDelProyecto({ org, project: 'Producto X', ...opts });
  assert.ok(pip.ok && pip.pipelines.length >= 2, `pipelines de ejemplo: ${JSON.stringify(pip)}`);
  const st = await RP.stagesPropuestos({ pipeline: `Producto X/${pip.pipelines[0].id}`, remote: REMOTOS.operaciones, ...opts });
  assert.ok(st.ok && st.propuestos.length >= 2, `stages de ejemplo: ${JSON.stringify(st)}`);
  const tipos = await RP.tiposDePedido({ org, project: 'Producto X', ...opts });
  assert.ok(tipos.ok && tipos.tipos.includes('Riesgo'), JSON.stringify(tipos));
  const campos = await RP.camposDelTipo({ tipo: 'Riesgo', org, project: 'Producto X', ...opts });
  assert.ok(campos.ok && campos.campos.some((x) => x.referencia === 'Custom.Impacto' && x.valores.length === 5), JSON.stringify(campos));
  // la política de revisión del perfil: pide un revisor, así «Proponer» se ofrece
  const pol = await RP.politicaDeRevision({ remote: REMOTOS.perfil, credencial: 'ejemplo', urlBase: URL_BASE, fetch: fetchDemo, archivo: 'team-profile.json' });
  assert.strictEqual(pol.ok, true, JSON.stringify(pol));
  // una dirección que no es de ejemplo no contesta nada: ni inventa una respuesta ni sale a buscarla
  const r = await fetchDemo('https://otro.example/lo-que-sea');
  assert.strictEqual(r.status, 404);
});

// ── el arranque sin proveedor ni secretos, la sesión de ejemplo y el selector ───────────────────────────────────
const { spawn } = require('child_process');
const net = require('net');
const SERVER_JS = path.join(SITE, 'server.js');
const SERVER = () => require(SERVER_JS);

/** Un puerto libre de esta máquina. */
const puertoLibre = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/** Arranca `node server.js` con ese entorno: { codigo, salida, error } cuando termina, o { proceso } si sigue vivo tras `espera`. */
function correrServidor(env, { espera = 0 } = {}) {
  return new Promise((resolve) => {
    const limpio = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SITE_|IDENTITY_|MSI_|AZURE_)/.test(k)));
    const p = spawn(process.execPath, [SERVER_JS], { env: { ...limpio, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = ''; let error = '';
    p.stdout.on('data', (c) => { salida += c; });
    p.stderr.on('data', (c) => { error += c; });
    p.once('close', (codigo) => resolve({ codigo, salida, error }));
    if (espera) setTimeout(() => resolve({ proceso: p, salida: () => salida, error: () => error }), espera);
  });
}
// stable-data: el reloj sólo mide cuánto se espera a que el proceso conteste; ninguna fecha de los datos sale de acá
const esperarA = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

/** El sitio demo en este proceso, en un puerto libre. `extra`: variables de más (las que el modo acepta). */
async function arrancarDemo(extra = {}, opciones = {}) {
  const dir = tmp('demo-sitio-');
  const registro = [];
  const sitio = SERVER().crearSitioDemo({ env: { SITE_DEMO: '1', ...extra }, dir, log: (l) => registro.push(l), ...opciones });
  await sitio.iniciar();
  await new Promise((r) => sitio.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${sitio.server.address().port}`;
  return { sitio, base, dir, registro, pedir: (ruta, o) => H.pedirA(base, ruta, o), cerrar: () => sitio.cerrar() };
}
/** Pide hasta que deje de contestar 503 (la vista de ejecuciones se arma en un hilo aparte al arrancar). */
async function pedirListo(h, ruta, o, ms = 30000) {
  const t0 = Date.now();
  let r = await h.pedir(ruta, o);
  while (r.status === 503 && Date.now() - t0 < ms) { await new Promise((x) => setTimeout(x, 200)); r = await h.pedir(ruta, o); }
  return r;
}
const MISMO_ORIGEN = { 'sec-fetch-site': 'same-origin' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

test('2.76-Demo_ConCredencial_NoArranca', async () => {
  const { validarDemo, VARIABLES_DEL_MODO } = DEMO();
  assert.deepStrictEqual([...VARIABLES_DEL_MODO].sort(), ['PORT', 'SITE_DEMO', 'SITE_PUBLIC_URL']);
  assert.strictEqual(validarDemo({ SITE_DEMO: '1' }).ok, true);
  assert.strictEqual(validarDemo({ SITE_DEMO: '1', PORT: '8080', SITE_PUBLIC_URL: 'https://demo.acme.example' }).ok, true);
  // cada variable de credencial o de identidad, una por vez: no arranca y dice cuál (sin repetir su valor)
  const credenciales = ['SITE_SESSION_KEY', 'SITE_OIDC_CLIENT_SECRET', 'SITE_OIDC_CLIENT_ID', 'SITE_OPERATIONS_TOKEN', 'SITE_OPERATIONS_IDENTITY', 'SITE_OPERATIONS_WRITE_TOKEN',
    'SITE_OPERATIONS_COPY_SAS', 'SITE_MAILBOX_SAS', 'SITE_MAILBOX_IDENTITY', 'SITE_PROFILE_TOKEN', 'SITE_PROFILE_WRITE_TOKEN', 'SITE_PIPELINES_TOKEN', 'SITE_DATA_DIR',
    'SITE_AUTH_PROVIDER', 'SITE_OPERATIONS_REPO', 'SITE_FIRST_MAINTAINER', 'SITE_ALGO_QUE_NO_EXISTE',
    'IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'MSI_ENDPOINT', 'MSI_SECRET', 'AZURE_CLIENT_SECRET'];
  for (const v of credenciales) {
    const r = validarDemo({ SITE_DEMO: '1', [v]: 'valor-secreto-9f2c' });
    assert.strictEqual(r.ok, false, `${v} tiene que frenar el modo demo`);
    assert.deepStrictEqual(r.problemas.map((p) => p.variable), [v]);
    assert.ok(!JSON.stringify(r.problemas).includes('valor-secreto-9f2c'), `${v}: el motivo no repite el valor`);
  }
  // SITE_DEMO sólo con «1» explícito: ningún otro valor cae callado al sitio real
  for (const x of ['0', 'true', 'yes', 'si', ' 1', '1 ', '', 'on']) {
    const r = validarDemo({ SITE_DEMO: x });
    assert.strictEqual(r.ok, false, `SITE_DEMO=${JSON.stringify(x)} no arranca`);
    assert.deepStrictEqual(r.problemas.map((p) => p.variable), ['SITE_DEMO']);
  }
  // lo que sí acepta, bien formado
  assert.deepStrictEqual(validarDemo({ SITE_DEMO: '1', PORT: '0' }).problemas.map((p) => p.variable), ['PORT']);
  assert.deepStrictEqual(validarDemo({ SITE_DEMO: '1', SITE_PUBLIC_URL: 'ftp://x' }).problemas.map((p) => p.variable), ['SITE_PUBLIC_URL']);
  // el proceso de verdad: sale 1 y nombra la variable, sin su valor
  const a = await correrServidor({ SITE_DEMO: '1', SITE_SESSION_KEY: 'valor-secreto-9f2c' });
  assert.strictEqual(a.codigo, 1);
  assert.match(a.error, /SITE_SESSION_KEY/);
  assert.ok(!(a.salida + a.error).includes('valor-secreto-9f2c'));
  const b = await correrServidor({ SITE_DEMO: 'true' });
  assert.strictEqual(b.codigo, 1);
  assert.match(b.error, /SITE_DEMO/);
});

test('2.76-Demo_ArrancaSinProveedor_EntraSinCuenta', async () => {
  // el proceso de verdad, sin ninguna otra variable
  const puerto = await puertoLibre();
  const p = await correrServidor({ SITE_DEMO: '1', PORT: String(puerto) }, { espera: 1 });
  try {
    assert.ok(await esperarA(() => /escuchando en el puerto/.test(p.salida())), `no escuchó: ${p.salida()} ${p.error()}`);
    assert.match(p.salida(), /demo: true/);
    assert.match(p.salida(), /sitio demo: datos de ejemplo/);
    assert.doesNotMatch(p.salida() + p.error(), /freno:/, 'el arranque no tocó nada de lo que el freno veda');
    const r = await H.pedirA(`http://127.0.0.1:${puerto}`, '/');
    assert.strictEqual(r.status, 200);
    assert.match(r.texto, /Qué decidir hoy/);
    assert.deepStrictEqual((await H.pedirA(`http://127.0.0.1:${puerto}`, '/livez')).json, { ok: true, demo: true });
  } finally { p.proceso.kill('SIGTERM'); await new Promise((r) => p.proceso.once('close', r)); }
  // en este proceso: sin cookie entra como quien mantiene, sin cuenta ni proveedor
  const h = await arrancarDemo();
  try {
    const inicio = await h.pedir('/');
    assert.strictEqual(inicio.status, 200);
    assert.match(inicio.texto, /Qué decidir hoy/);
    assert.ok(!inicio.headers['set-cookie'], 'ninguna cookie de cuenta');
    assert.doesNotMatch(inicio.texto, /\/auth\/logout|class="salir"/, 'sin «Salir»: no hay cuenta');
    assert.strictEqual((await h.pedir('/configuracion')).status, 200);
    // el inicio de sesión no existe: las rutas de /auth vuelven al sitio
    for (const ruta of ['/auth/login', '/auth/callback?code=x&state=y']) {
      const r = await h.pedir(ruta);
      assert.strictEqual(r.status, 303, ruta);
      assert.strictEqual(r.headers.location, '/');
    }
    assert.strictEqual((await h.pedir('/api/inicio')).status, 200, 'la API contesta sin sesión');
  } finally { await h.cerrar(); }
});

test('2.76-Demo_VerComoPersona', async () => {
  const h = await arrancarDemo();
  try {
    const mantiene = await h.pedir('/');
    assert.match(mantiene.texto, /Ver como/);
    assert.match(mantiene.texto, /action="\/demo\/ver-como"/);
    // «una persona del equipo»: la cookie de la vista (sólo la vista, sin cuenta)
    const cambio = await h.pedir('/demo/ver-como', { method: 'POST', headers: { ...MISMO_ORIGEN, ...FORM }, body: 'como=persona&volver=%2F' });
    assert.strictEqual(cambio.status, 303);
    assert.strictEqual(cambio.headers.location, '/');
    assert.ok(cambio.cookies['sitio-demo-vista'] && cambio.cookies['sitio-demo-vista'].valor === 'persona');
    const cookie = 'sitio-demo-vista=persona';
    const inicio = await h.pedir('/', { cookie });
    assert.strictEqual(inicio.status, 200);
    assert.match(inicio.texto, /Lo tuyo/);
    assert.doesNotMatch(inicio.texto, /Qué decidir hoy/);
    assert.doesNotMatch(inicio.texto, /href="\/configuracion"/, 'sin Configuración en el menú');
    assert.strictEqual((await h.pedir('/configuracion', { cookie })).status, 403);
    const ejecuciones = await pedirListo(h, '/api/corridas', { cookie });
    assert.strictEqual(ejecuciones.status, 200);
    const lista = ejecuciones.json.corridas || [];
    assert.ok(lista.length >= 2 && lista.length < 5, `«Lo tuyo» trae sus ejecuciones, no las de todos (${lista.length})`);
    // volver a quien mantiene
    const vuelta = await h.pedir('/demo/ver-como', { method: 'POST', headers: { ...MISMO_ORIGEN, ...FORM }, body: 'como=mantenedor&volver=%2Fproyectos' });
    assert.strictEqual(vuelta.headers.location, '/proyectos');
    assert.strictEqual((await h.pedir('/configuracion', { cookie: 'sitio-demo-vista=mantenedor' })).status, 200);
    // un valor que no es de la lista no cambia nada; desde otro origen, tampoco
    const raro = await h.pedir('/demo/ver-como', { method: 'POST', headers: { ...MISMO_ORIGEN, ...FORM }, body: 'como=admin&volver=%2F' });
    assert.ok(!raro.cookies['sitio-demo-vista']);
    const ajeno = await h.pedir('/demo/ver-como', { method: 'POST', headers: { origin: 'https://otro.example', ...FORM }, body: 'como=persona&volver=%2F' });
    assert.strictEqual(ajeno.status, 403);
  } finally { await h.cerrar(); }
});

test('2.76-SinDemo_ComoHoy', async () => {
  const S = SERVER();
  const D = DEMO();
  // sin SITE_DEMO el sitio exige proveedor y credenciales, como siempre
  const v = S.validarConfiguracion({});
  assert.strictEqual(v.ok, false);
  const faltan = v.problemas.map((p) => p.variable);
  for (const x of ['SITE_SESSION_KEY', 'SITE_AUTH_PROVIDER', 'SITE_OIDC_CLIENT_ID']) assert.ok(faltan.includes(x), `${x} sigue siendo obligatoria`);
  // el freno no está puesto y el modo no existe en este proceso
  assert.strictEqual(D.frenoActual(), null);
  // el registro del arranque dice que el modo demo está apagado
  assert.ok(S.lineasDeArranque({}).includes('demo: false'));
  assert.ok(S.lineasDeArranque({ SITE_DEMO: '1' }).includes('demo: true'));
  // el sitio real: /livez dice demo: false, y sin sesión la API sigue dando 401
  const h = await H.arrancarSitio({ env: H.envBase(), fuentes: H.fuentesFijas() });
  try {
    const lz = await h.pedir('/livez');
    assert.deepStrictEqual([lz.status, lz.json], [200, { ok: true, demo: false }]);
    assert.strictEqual((await h.pedir('/api/inicio')).status, 401);
    assert.ok(!(await h.pedir('/livez')).headers['x-robots-tag'], 'el sitio real no pide noindex');
  } finally { await h.cerrar(); }
  // el proceso de verdad: sin SITE_DEMO dice demo: false al arrancar y exige lo de siempre
  const r = await correrServidor({});
  assert.strictEqual(r.codigo, 1);
  assert.match(r.salida, /demo: false/);
  assert.match(r.error, /SITE_PUBLIC_URL/);
});

// ── el freno central, el recorrido de rutas y el idioma ─────────────────────────────────────────────────────────

/** Cada ruta de la tabla, con valores de ejemplo en sus parámetros: `{ metodo, url, ruta }`. Una ruta nueva entra sola. */
function rutasParaRecorrer(rutas, extra = []) {
  const muestra = (p) => p.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (m, n) => (n === 'id' ? '0123456789abcdef' : (n === 'nombre' ? 'inicio-quien-mantiene.png' : 'x')));
  const out = [];
  for (const r of [...rutas, ...extra]) for (const metodo of ['GET', 'POST']) out.push({ metodo, url: muestra(r.path), ruta: r.path, declarada: r.method });
  return out;
}

test('2.76-Demo_FrenoDeRed_FallaCerrado', async () => {
  const { ponerFreno, frenoActual } = DEMO();
  const http = require('http');
  const https = require('https');
  const netMod = require('net');
  const tls = require('tls');
  const cp = require('child_process');
  const dir = tmp('demo-guard-');
  const afuera = tmp('demo-afuera-');
  fs.writeFileSync(path.join(afuera, 'viejo.txt'), 'x');
  // lo que el pase adversarial usa: un archivo de afuera, una carpeta de afuera con un enlace a él y un enlace de adentro hacia afuera
  const fix = tmp('demo-fix-');
  const objetivo = path.join(fix, 'target.txt');
  fs.writeFileSync(objetivo, 'ORIGINAL'); fs.chmodSync(objetivo, 0o644);
  fs.mkdirSync(path.join(fix, 'src'));
  fs.writeFileSync(path.join(fix, 'src', 'real.txt'), 'x');
  fs.symlinkSync(objetivo, path.join(fix, 'src', 'link'));
  fs.symlinkSync(objetivo, path.join(dir, 'enl'));
  const originales = { request: http.request, fetch: globalThis.fetch, spawn: cp.spawn, writeFileSync: fs.writeFileSync };
  const avisos = [];
  const freno = ponerFreno({ dir });
  require(path.join(SITE, 'demo.js')).alIntentar((i) => avisos.push(i));
  // la forma con función de vuelta: el error llega por la función (nunca lanza)
  const porVuelta = (llamar) => new Promise((ok, mal) => { try { llamar((e) => ok(e || {})); } catch (e) { mal(e); } });
  const t = (fn, que, promesa = false) => (promesa ? assert.rejects(Promise.resolve().then(fn), { code: 'EDEMO_FRENO' }, que) : assert.throws(fn, { code: 'EDEMO_FRENO' }, que));
  try {
    assert.strictEqual(frenoActual(), freno);
    assert.throws(() => ponerFreno({ dir }), /ya está puesto/);
    // la red: ni una conexión hacia afuera
    assert.throws(() => http.request('http://otro.example/'), { code: 'EDEMO_FRENO' });
    assert.throws(() => http.get('http://otro.example/'), { code: 'EDEMO_FRENO' });
    assert.throws(() => https.request('https://otro.example/'), { code: 'EDEMO_FRENO' });
    assert.throws(() => https.get('https://otro.example/'), { code: 'EDEMO_FRENO' });
    assert.throws(() => netMod.connect(80, 'otro.example'), { code: 'EDEMO_FRENO' });
    assert.throws(() => netMod.createConnection({ port: 80 }), { code: 'EDEMO_FRENO' });
    assert.throws(() => new netMod.Socket().connect(80, 'otro.example'), { code: 'EDEMO_FRENO' });
    assert.throws(() => tls.connect({ port: 443, host: 'otro.example' }), { code: 'EDEMO_FRENO' });
    await assert.rejects(() => globalThis.fetch('https://otro.example/'), { code: 'EDEMO_FRENO' });
    // los procesos: ni git ni nada
    assert.throws(() => cp.spawn('git', ['--version']), { code: 'EDEMO_FRENO' });
    assert.throws(() => cp.spawnSync('git', ['--version']), { code: 'EDEMO_FRENO' });
    assert.throws(() => cp.exec('git --version', () => {}), { code: 'EDEMO_FRENO' });
    assert.throws(() => cp.execSync('git --version'), { code: 'EDEMO_FRENO' });
    assert.throws(() => cp.execFile('git', ['--version'], () => {}), { code: 'EDEMO_FRENO' });
    assert.throws(() => cp.execFileSync('git', ['--version']), { code: 'EDEMO_FRENO' });
    assert.throws(() => cp.fork(path.join(SITE, 'server.js')), { code: 'EDEMO_FRENO' });
    // el disco: leer sí; escribir sólo adentro de la carpeta propia, en sus tres formas
    const fuera = (n) => path.join(afuera, n);
    assert.throws(() => fs.writeFileSync(fuera('a.txt'), 'x'), { code: 'EDEMO_FRENO' });
    assert.throws(() => fs.appendFileSync(fuera('a.txt'), 'x'), { code: 'EDEMO_FRENO' });
    assert.throws(() => fs.mkdirSync(fuera('d'), { recursive: true }), { code: 'EDEMO_FRENO' });
    assert.throws(() => fs.mkdtempSync(fuera('t-')), { code: 'EDEMO_FRENO' });
    assert.throws(() => fs.rmSync(fuera('viejo.txt')), { code: 'EDEMO_FRENO' });
    assert.throws(() => fs.unlinkSync(fuera('viejo.txt')), { code: 'EDEMO_FRENO' });
    assert.throws(() => fs.renameSync(fuera('viejo.txt'), fuera('nuevo.txt')), { code: 'EDEMO_FRENO' });
    assert.throws(() => fs.copyFileSync(path.join(dir, 'x'), fuera('c.txt')), { code: 'EDEMO_FRENO' });
    assert.throws(() => fs.openSync(fuera('o.txt'), 'w'), { code: 'EDEMO_FRENO' });
    assert.throws(() => fs.createWriteStream(fuera('s.txt')), { code: 'EDEMO_FRENO' });
    assert.throws(() => fs.symlinkSync(dir, path.join(dir, 'enlace')), { code: 'EDEMO_FRENO' });
    assert.throws(() => fs.writeFileSync(path.join(dir, '..', 'escape.txt'), 'x'), { code: 'EDEMO_FRENO' }, 'subir con «..» no sale de la carpeta');
    await new Promise((resolve) => { try { fs.writeFile(fuera('cb.txt'), 'x', () => resolve()); resolve(); } catch (e) { assert.strictEqual(e.code, 'EDEMO_FRENO'); resolve(); } });
    await assert.rejects(() => fs.promises.writeFile(fuera('p.txt'), 'x'), { code: 'EDEMO_FRENO' });
    await assert.rejects(() => fs.promises.mkdir(fuera('pd')), { code: 'EDEMO_FRENO' });
    await assert.rejects(() => fs.promises.rm(fuera('viejo.txt')), { code: 'EDEMO_FRENO' });
    assert.deepStrictEqual(fs.readdirSync(afuera), ['viejo.txt'], 'afuera no cambió nada');
    // adentro de la carpeta propia, todo anda
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'c.txt'), 'y');
    await fs.promises.writeFile(path.join(dir, 'p.txt'), 'z');
    fs.rmSync(path.join(dir, 'a'), { recursive: true });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'ok.txt'), 'utf8'), 'x');
    assert.strictEqual(fs.readFileSync(path.join(afuera, 'viejo.txt'), 'utf8'), 'x', 'leer de cualquier lado sigue andando');
    // el `listen` del servidor sigue andando: recibir no es conectar
    const srv = http.createServer((req, res) => res.end('ok'));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    assert.ok(srv.address().port > 0);
    await new Promise((r) => srv.close(r));
    // lo que antes quedaba afuera: datagramas, DNS, WebSocket, ClientRequest directo y openAsBlob (cada uno lanza y se anota)
    const antesDe = freno.intentos.length;
    assert.throws(() => require('dgram').createSocket('udp4'), { code: 'EDEMO_FRENO' });
    const dns = require('dns');
    assert.throws(() => dns.lookup('otro.example', () => {}), { code: 'EDEMO_FRENO' });
    assert.throws(() => dns.resolve4('otro.example', () => {}), { code: 'EDEMO_FRENO' });
    assert.throws(() => dns.resolveTxt('otro.example', () => {}), { code: 'EDEMO_FRENO' });
    await assert.rejects(() => dns.promises.lookup('otro.example'), { code: 'EDEMO_FRENO' });
    await assert.rejects(() => dns.promises.resolve('otro.example'), { code: 'EDEMO_FRENO' });
    assert.throws(() => new globalThis.WebSocket('ws://otro.example/'), { code: 'EDEMO_FRENO' });
    assert.throws(() => new http.ClientRequest('http://otro.example/'), { code: 'EDEMO_FRENO' });
    if (typeof fs.openAsBlob === 'function') await assert.rejects(() => fs.openAsBlob(fuera('blob.txt')), { code: 'EDEMO_FRENO' });
    assert.ok(freno.intentos.length - antesDe >= (typeof fs.openAsBlob === 'function' ? 9 : 8), 'cada uno quedó anotado');
    for (const que of ['createSocket', 'lookup', 'resolve4', 'WebSocket', 'ClientRequest']) assert.ok(freno.intentos.some((i) => i.detalle.startsWith(`${que}:`)), `${que} anotado`);
    // buscar «localhost» o una dirección propia no sale a ningún lado: el servidor local sigue andando
    await new Promise((r, j) => dns.lookup('127.0.0.1', (e) => (e ? j(e) : r())));
    // ── el pase adversarial: cada vía que se escapaba, y el corte por defecto ──
    const modo = () => fs.statSync(objetivo).mode & 0o777;
    const cierra = (fd) => fs.closeSync(fd);
    // clases 2/12: `open(ruta, callback)` es una lectura (banderas por defecto): el texto del callback no decide
    for (const hace of [(r) => function alAbrir(err, fd) { if (!err) cierra(fd); r(); }, (r) => (a, b) => { if (!a) cierra(b); r(); }, (r) => function (e, fd) { if (!e) cierra(fd); r(); }]) {
      await new Promise((r, j) => { try { fs.open(objetivo, hace(r)); } catch (e) { j(e); } });
    }
    assert.strictEqual((await porVuelta((cb) => fs.open(objetivo, 'w', cb))).code, 'EDEMO_FRENO', 'abrir para escribir afuera sigue frenado');
    // clase 3: las carpetas temporales con su borrado también (Node 24)
    if (typeof fs.mkdtempDisposableSync === 'function') t(() => fs.mkdtempDisposableSync(fuera('disp-')), 'mkdtempDisposableSync');
    if (fs.promises.mkdtempDisposable) await assert.rejects(() => fs.promises.mkdtempDisposable(fuera('disp2-')), { code: 'EDEMO_FRENO' });
    // «a verificar aparte»: `mkdtemp` recibe un PREFIJO; con la propia carpeta sin barra final crearía un hermano AFUERA
    const hermanos = () => fs.readdirSync(path.dirname(dir)).filter((n) => n.startsWith(path.basename(dir)) && n !== path.basename(dir));
    t(() => fs.mkdtempSync(dir), 'mkdtemp con la propia ruta crea afuera');
    await assert.rejects(() => fs.promises.mkdtemp(dir), { code: 'EDEMO_FRENO' });
    assert.deepStrictEqual(hermanos(), [], 'no apareció ningún hermano');
    fs.rmdirSync(fs.mkdtempSync(path.join(dir, 'ok-')));
    fs.rmdirSync(fs.mkdtempSync(dir + path.sep));
    // clases 4 y 9: las instancias nuevas de Resolver
    t(() => new dns.Resolver(), 'dns.Resolver');
    t(() => new dns.promises.Resolver(), 'dns.promises.Resolver');
    t(() => dns.Resolver.prototype.resolve4.call({}, 'otro.example', () => {}), 'dns.Resolver.prototype.resolve4');
    t(() => dns.promises.Resolver.prototype.resolve4.call({}, 'otro.example'), 'dns.promises.Resolver.prototype.resolve4', true);
    // clases 5 y 7: permisos y fechas por descriptor, y por manejador
    const fd = fs.openSync(objetivo, 'r');
    t(() => fs.fchmodSync(fd, 0o600), 'fchmodSync');
    t(() => fs.futimesSync(fd, 1, 1), 'futimesSync');
    t(() => fs.fchownSync(fd, process.getuid(), process.getgid()), 'fchownSync');
    assert.strictEqual((await porVuelta((cb) => fs.fchmod(fd, 0o600, cb))).code, 'EDEMO_FRENO', 'fchmod');
    assert.strictEqual((await porVuelta((cb) => fs.futimes(fd, 1, 1, cb))).code, 'EDEMO_FRENO', 'futimes');
    t(() => fs.ftruncateSync(fd, 0), 'ftruncateSync');
    t(() => fs.truncateSync(fd, 0), 'truncateSync con un descriptor de afuera');
    cierra(fd);
    const manejador = await fs.promises.open(objetivo, 'r');
    await assert.rejects(() => manejador.chmod(0o640), { code: 'EDEMO_FRENO' });
    await assert.rejects(() => manejador.utimes(1, 1), { code: 'EDEMO_FRENO' });
    await assert.rejects(() => manejador.chown(process.getuid(), process.getgid()), { code: 'EDEMO_FRENO' });
    assert.strictEqual(await manejador.readFile('utf8'), 'ORIGINAL', 'leer por el manejador anda');
    await manejador.close();
    assert.strictEqual(modo(), 0o644, 'el archivo de afuera conserva sus permisos');
    assert.strictEqual(fs.statSync(objetivo).mtimeMs > 1000, true, 'y su fecha');
    // lo abierto adentro sí se puede cambiar
    const fdAdentro = fs.openSync(path.join(dir, 'f.txt'), 'w');
    fs.fchmodSync(fdAdentro, 0o600); fs.writeSync(fdAdentro, 'x'); fs.futimesSync(fdAdentro, 1, 1); cierra(fdAdentro);
    const mAdentro = await fs.promises.open(path.join(dir, 'h.txt'), 'w');
    await mAdentro.chmod(0o600); await mAdentro.writeFile('x'); await mAdentro.close();
    // clase 8: los enlaces. Una copia no trae el enlace de afuera, y una escritura por un enlace de adentro no sale
    fs.cpSync(path.join(fix, 'src'), path.join(dir, 'c'), { recursive: true });
    assert.strictEqual(fs.existsSync(path.join(dir, 'c', 'link')) || fs.lstatSync(path.join(dir, 'c')).isSymbolicLink(), false, 'cpSync no trae el enlace');
    fs.writeFileSync(path.join(dir, 'c', 'link'), 'PWNED');
    await new Promise((r, j) => fs.cp(path.join(fix, 'src'), path.join(dir, 'c2'), { recursive: true }, (e) => (e ? j(e) : r())));
    assert.strictEqual(fs.existsSync(path.join(dir, 'c2', 'link')), false, 'cp (callback) tampoco');
    await fs.promises.cp(path.join(fix, 'src'), path.join(dir, 'c3'), { recursive: true });
    assert.strictEqual(fs.existsSync(path.join(dir, 'c3', 'link')), false, 'promises.cp tampoco');
    // el filtro de quien llama sigue valiendo
    fs.cpSync(path.join(fix, 'src'), path.join(dir, 'c4'), { recursive: true, filter: () => true });
    assert.ok(fs.existsSync(path.join(dir, 'c4', 'real.txt')), 'lo que no es enlace se copia');
    t(() => fs.writeFileSync(path.join(dir, 'enl'), 'PWNED'), 'escribir por un enlace de adentro hacia afuera');
    t(() => fs.appendFileSync(path.join(dir, 'enl'), 'PWNED'), 'agregar por el enlace');
    t(() => fs.truncateSync(path.join(dir, 'enl'), 0), 'truncar por el enlace');
    t(() => fs.chmodSync(path.join(dir, 'enl'), 0o600), 'permisos por el enlace');
    t(() => fs.copyFileSync(path.join(dir, 'f.txt'), path.join(dir, 'enl')), 'copiar sobre el enlace');
    t(() => fs.createWriteStream(path.join(dir, 'enl')), 'flujo por el enlace');
    fs.unlinkSync(path.join(dir, 'enl'));
    assert.strictEqual(fs.readFileSync(objetivo, 'utf8'), 'ORIGINAL', 'el archivo de afuera no se tocó');
    // clase 12: una función «de lectura» con bandera de escritura, o un flujo con descriptor de afuera, no crea ni trunca afuera
    {
      const nuevo = fuera('nuevo-por-bandera.txt');
      const fdAfuera = fs.openSync(objetivo, 'r');
      const dentroOk = path.join(dir, 'bandera-nueva.txt');
      t(() => fs.readFileSync(nuevo, { flag: 'w' }), 'readFileSync con flag w');
      t(() => fs.readFileSync(objetivo, { flag: 'w' }), 'readFileSync trunca con flag w');
      t(() => fs.readFileSync(nuevo, { flag: fs.constants.O_WRONLY | fs.constants.O_CREAT }), 'readFileSync con flag numérica');
      assert.strictEqual((await porVuelta((cb) => fs.readFile(nuevo, { flag: 'a' }, cb))).code, 'EDEMO_FRENO', 'readFile con flag a');
      await t(() => fs.promises.readFile(nuevo, { flag: 'w' }), 'promises.readFile con flag w', true);
      t(() => fs.createReadStream(nuevo, { flags: 'w' }), 'createReadStream con flags w');
      t(() => new fs.ReadStream(nuevo, { flags: 'w+' }), 'ReadStream con flags w+');
      t(() => fs.createWriteStream(dentroOk, { fd: fdAfuera }), 'createWriteStream: ruta de adentro y fd de afuera');
      t(() => fs.createWriteStream(undefined, { fd: fdAfuera }), 'createWriteStream: sin ruta y fd de afuera');
      t(() => fs.createWriteStream(nuevo, { fd: fdAfuera }), 'createWriteStream: ruta de afuera y fd de afuera');
      t(() => new fs.WriteStream(dentroOk, { fd: fdAfuera }), 'WriteStream con fd de afuera');
      assert.ok(!fs.existsSync(nuevo), 'no se creó el archivo de afuera');
      assert.ok(!fs.existsSync(dentroOk), 'tampoco el de adentro');
      assert.strictEqual(fs.readFileSync(objetivo, 'utf8'), 'ORIGINAL', 'el archivo de afuera no se truncó');
      // las lecturas normales siguen andando afuera
      assert.strictEqual(fs.readFileSync(objetivo, { flag: 'r' }).toString(), 'ORIGINAL');
      assert.strictEqual(await fs.promises.readFile(objetivo, 'utf8'), 'ORIGINAL');
      fs.createReadStream(objetivo, { flags: 'r' }).destroy();
      // y adentro la bandera de escritura sigue andando
      assert.throws(() => fs.readFileSync(dentroOk, { flag: 'w' }), (e) => e.code !== 'EDEMO_FRENO');
      fs.unlinkSync(dentroOk);
      fs.closeSync(fdAfuera);
      // clase 13: las puertas nativas
      t(() => process.binding('fs'), 'process.binding');
      t(() => process.dlopen({ exports: {} }, '/no/existe.node'), 'process.dlopen');
      // las escrituras nativas que no pasan por fs: el informe del proceso y la foto de memoria
      const informe = fuera('informe.json');
      const foto = fuera('memoria.heapsnapshot');
      t(() => process.report.writeReport(informe), 'process.report.writeReport');
      t(() => require('v8').writeHeapSnapshot(foto), 'v8.writeHeapSnapshot');
      assert.ok(!fs.existsSync(informe) && !fs.existsSync(foto), 'afuera no se escribió el informe ni la foto');
    }
    // clase 10: el constructor de dgram
    t(() => new (require('dgram').Socket)('udp4'), 'dgram.Socket');
    // clase 11: lanzar un proceso por la clase
    t(() => new cp.ChildProcess(), 'child_process.ChildProcess');
    t(() => cp.ChildProcess.prototype.spawn.call({}, { file: '/bin/sh', args: ['/bin/sh', '-c', 'true'], stdio: 'ignore', envPairs: [] }), 'ChildProcess.prototype.spawn');
    // el corte por defecto: TODO lo que exporta cada módulo de salida y no está entre lo permitido lanza EDEMO_FRENO. Una función
    // que una versión nueva de Node agregue entra sola en esta recorrida
    const { PERMITIDAS, LECTURA_FS } = require(path.join(SITE, 'demo-guard.js'));
    const modulos = { net: netMod, tls, dgram: require('dgram'), dns, 'dns.promises': dns.promises, http, https, http2: require('http2'), child_process: cp };
    const funcionesDe = (mod) => {
      const out = [];
      for (const n of Object.getOwnPropertyNames(mod)) {
        if (/^[A-Z0-9_]+$/.test(n)) continue;
        const d = Object.getOwnPropertyDescriptor(mod, n);
        if (typeof d.value === 'function') out.push([n, d.value]);
        else if (d.get && /^[A-Z]/.test(n)) { try { if (typeof mod[n] === 'function') out.push([n, mod[n]]); } catch { /* no se puede leer */ } }
      }
      return out;
    };
    const lanzaFreno = async (fn, args) => {
      try { const r = fn(...args); if (r && typeof r.then === 'function') await r.then(() => { throw new Error('resolvió'); }, (e) => { if (e.code !== 'EDEMO_FRENO') throw e; }); else throw new Error('no lanzó'); } catch (e) { if (e.code !== 'EDEMO_FRENO') return e.message; }
      return null;
    };
    let recorridas = 0;
    for (const [clave, mod] of Object.entries(modulos)) {
      for (const [n, f] of funcionesDe(mod)) {
        if (PERMITIDAS[clave].includes(n) || (clave.startsWith('dns') && n === 'lookup')) continue;
        recorridas++;
        assert.strictEqual(await lanzaFreno(f, ['otro.example', () => {}]), null, `${clave}.${n} está frenada`);
      }
      for (const n of PERMITIDAS[clave]) assert.ok(n in mod, `${clave}.${n} existe en este Node (la lista permitida no tiene nombres muertos)`);
    }
    assert.ok(recorridas >= 60, `funciones de salida recorridas: ${recorridas}`);
    // los globales
    for (const n of ['fetch', 'WebSocket']) assert.strictEqual(await lanzaFreno(globalThis[n], ['http://otro.example/']), null, `${n} está frenada`);
    // fs: toda función que no es de lectura, llamada con rutas de afuera, lanza (las de descriptor, con uno que no se abrió adentro)
    const noLee = (n) => { const base = n.endsWith('Sync') ? n.slice(0, -4) : n; return !LECTURA_FS.includes(base) && !['open', 'close', 'openAsBlob'].includes(base); };
    let fsRecorridas = 0;
    for (const [mod, nombreMod] of [[fs, 'fs'], [fs.promises, 'fs.promises']]) {
      for (const [n, f] of funcionesDe(mod)) {
        if (!noLee(n)) continue;
        fsRecorridas++;
        // la forma con función de vuelta recibe el error por ella; las demás lo lanzan (o rechazan): las dos cuentan como frenadas
        const porLaVuelta = new Promise((ok) => { setTimeout(() => ok(null), 1000); f.__vuelta = ok; });
        const r = await lanzaFreno(f, [fuera('recorrida.txt'), fuera('recorrida2.txt'), (e) => f.__vuelta(e)]);
        const e = r === null ? null : await porLaVuelta;
        delete f.__vuelta;
        assert.ok(r === null || (e && e.code === 'EDEMO_FRENO'), `${nombreMod}.${n} está frenada`);
      }
    }
    assert.ok(fsRecorridas >= 60, `funciones de fs recorridas: ${fsRecorridas}`);
    // y las de un FileHandle que no son de lectura (el manejador de afuera de más arriba)
    const mf = await fs.promises.open(objetivo, 'r');
    const protoMf = Object.getPrototypeOf(mf);
    for (const n of Object.getOwnPropertyNames(protoMf)) {
      if (n === 'constructor' || ['read', 'readv', 'readFile', 'readLines', 'createReadStream', 'stat', 'close', 'readableWebStream'].includes(n) || typeof Object.getOwnPropertyDescriptor(protoMf, n).value !== 'function') continue;
      assert.strictEqual(await lanzaFreno(protoMf[n].bind(mf), []), null, `FileHandle.${n} de un archivo de afuera está frenada`);
    }
    await mf.close();
    // la forma con función de vuelta recibe el error por la función, sin lanzar: un borrado de fondo frenado no deja un
    // rechazo suelto que tumbe el proceso
    for (const [n, args] of [['rm', [fix, { recursive: true, force: true }]], ['writeFile', [objetivo, 'x']], ['open', [objetivo, 'w']]]) {
      const err = await new Promise((ok, mal) => { try { fs[n](...args, (e) => ok(e)); } catch (e) { mal(e); } });
      assert.strictEqual(err && err.code, 'EDEMO_FRENO', `fs.${n} con función de vuelta recibe el error por la función`);
    }
    assert.ok(fs.existsSync(objetivo), 'afuera no se borró nada');
    // una función a frenar que no existe se anota al poner el freno (y el resto se frena igual); en el Node de la imagen
    // no falta ninguna: con alguna, el sitio demo no arranca (arrancarDemo)
    assert.ok(Array.isArray(freno.faltantes));
    assert.deepStrictEqual(freno.faltantes, [], 'el freno se puso entero en este Node');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'site', 'server.js'), 'utf8'), /freno\.faltantes\.length[^\n]*process\.exit\(1\)|if \(freno\.faltantes\.length\)/, 'arrancarDemo no arranca con un hueco en el freno');
    // cada intento quedó anotado, con su tipo
    const tipos = new Set(freno.intentos.map((i) => i.tipo));
    assert.deepStrictEqual([...tipos].sort(), ['escritura', 'proceso', 'red']);
    assert.ok(freno.intentos.length >= 30, `intentos anotados: ${freno.intentos.length}`);
    assert.ok(avisos.length >= 30 && avisos.every((i) => i.tipo && i.detalle));
    assert.ok(freno.intentos.some((i) => /otro\.example/.test(i.detalle)), 'dice a dónde quiso ir');
  } finally { freno.quitar(); }
  // sin el freno todo vuelve a ser lo de antes
  assert.strictEqual(frenoActual(), null);
  assert.strictEqual(http.request, originales.request);
  assert.strictEqual(globalThis.fetch, originales.fetch);
  assert.strictEqual(cp.spawn, originales.spawn);
  assert.strictEqual(fs.writeFileSync, originales.writeFileSync);
  fs.writeFileSync(path.join(afuera, 'ya-puedo.txt'), 'x');
  await subcasoRefrescarFallido();
});

test("2.76-Demo_RutaNueva_EntraEnElRecorrido", async () => {
  const handler = () => ({ status: 200, cuerpo: '' });
  const base = [{ method: 'GET', path: '/a', needs: ['person'], handler }, { method: 'GET', path: '/api/corridas/:id', needs: ['person'], handler }];
  const antes = rutasParaRecorrer(base).map((r) => `${r.metodo} ${r.url}`);
  assert.deepStrictEqual(antes, ['GET /a', 'POST /a', 'GET /api/corridas/0123456789abcdef', 'POST /api/corridas/0123456789abcdef']);
  // una ruta agregada a la tabla aparece en el recorrido, en los dos métodos, sin tocar nada más
  const despues = rutasParaRecorrer([...base, { method: 'POST', path: '/api/lo-nuevo/:id/escribe', needs: ['maintainer'], handler }]).map((r) => `${r.metodo} ${r.url}`);
  assert.ok(despues.includes('GET /api/lo-nuevo/0123456789abcdef/escribe') && despues.includes('POST /api/lo-nuevo/0123456789abcdef/escribe'));
  assert.strictEqual(despues.length, antes.length + 2);
  // y el recorrido del servidor sale de su tabla entera: una ruta del servidor no puede quedar afuera
  const modo = SERVER().crearSitioDemo({ env: { SITE_DEMO: '1' }, dir: tmp('demo-tabla-'), log: () => {} });
  const completo = rutasParaRecorrer(modo.rutas);
  assert.strictEqual(completo.length, modo.rutas.length * 2);
  for (const r of modo.rutas) assert.ok(completo.some((x) => x.ruta === r.path), `${r.path} entra al recorrido`);
  await modo.cerrar();
});

test('2.76-Demo_RecorridoDeRutas_NiEscribeNiSale', async () => {
  // la vista de «Cómo trabaja» arma la lista de validadores sin consultar la lista de código deprecado: esa consulta lanza
  // git y anota en el registro del arnés en cada visita (también en el sitio real), y la vista no muestra archivos
  {
    const cp = require('child_process');
    const original = cp.execFileSync;
    const lanzados = [];
    cp.execFileSync = function espia(...a) { lanzados.push(a[0]); return original.apply(this, a); };
    try { require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'how-it-works.js')).buildModel({ treeDir: path.join(__dirname, '..', '..') }); } catch { /* el modelo puede faltar sin datos; lo que se mide son los procesos */ } finally { cp.execFileSync = original; }
    assert.deepStrictEqual(lanzados, [], 'armar la vista no lanza procesos');
  }
  // la tabla entera del servidor (en este proceso, para leerla) y el sitio de verdad (otro proceso, con su freno puesto)
  const tabla = SERVER().crearSitioDemo({ env: { SITE_DEMO: '1' }, dir: tmp('demo-tabla-'), log: () => {} });
  const propias = [{ path: '/livez' }, { path: '/healthz' }, { path: '/readyz' }, { path: '/idioma' }, { path: '/demo/ver-como' }, { path: '/auth/login' }, { path: '/auth/callback' }, { path: '/auth/logout' }, { path: '/saliste' },
    { path: '/licencia' }, { path: '/creditos' }, { path: '/marca/logo' }, { path: '/static/site.css' }, { path: '/static/site.js' }, { path: '/static/long-text-editor.js' }, { path: '/no-existe' }, { path: '/api/no-existe' }];
  const recorrido = rutasParaRecorrer(tabla.rutas, propias);
  await tabla.cerrar();
  const puerto = await puertoLibre();
  const base = `http://127.0.0.1:${puerto}`;
  // la carpeta temporal del proceso queda adentro de la de la prueba: al salir, el proceso la borra
  const raiz = tmp('demo-barrido-');
  const p = await correrServidor({ SITE_DEMO: '1', PORT: String(puerto), SITE_PUBLIC_URL: base, TMPDIR: raiz }, { espera: 1 });
  const fallas = [];
  try {
    assert.ok(await esperarA(() => /escuchando en el puerto/.test(p.salida())), `no escuchó: ${p.salida()} ${p.error()}`);
    const h = { pedir: (ruta, o) => H.pedirA(base, ruta, o) };
    // la vista de ejecuciones se arma en un hilo aparte: se espera a que esté
    assert.strictEqual((await pedirListo(h, '/api/corridas', undefined, 60000)).status, 200);
    const meta = /<meta name="site-token" content="([^"]+)"/.exec((await h.pedir('/configuracion')).texto);
    assert.ok(meta, 'la página de Configuración trae el token de la sesión');
    const token = meta[1];
    let n = 0;
    for (const vista of ['mantenedor', 'persona']) {
      for (const r of recorrido) {
        for (const conToken of [true, false]) {
          // cada pedido desde una dirección distinta (la última de X-Forwarded-For): el tope por dirección no lo frena
          const cabeceras = { 'x-forwarded-for': `203.0.113.7, 10.${Math.floor(n / 250)}.${n % 250}.1`, origin: base, ...(conToken ? { 'x-site-token': token } : {}) };
          n += 1;
          const opciones = r.metodo === 'POST'
            ? { method: 'POST', cookie: `sitio-demo-vista=${vista}`, headers: { ...cabeceras, 'content-type': 'application/json' }, body: JSON.stringify({ seccion: 'sitio', texto: '{}', borrador: {}, correo: 'otra@acme.example', pipeline: '11', tipo: 'Riesgo', draft: {} }) }
            : { cookie: `sitio-demo-vista=${vista}`, headers: cabeceras };
          const res = await h.pedir(r.url, opciones);
          if (res.status >= 500) fallas.push(`${r.metodo} ${r.url} (${vista}${conToken ? ', con token' : ''}): ${res.status}`);
        }
      }
    }
    assert.deepStrictEqual(fallas, [], 'ninguna ruta contesta 500');
    assert.ok(n >= recorrido.length * 4);
    // los botones que cambian algo, en serio y con el token: contestan «lo que pasaría» y no tocan nada
    const fin = p.salida() + p.error();
    assert.doesNotMatch(fin, /freno:/, `el recorrido entero no tocó nada de lo que el freno veda:\n${fin.split('\n').filter((l) => /freno:/.test(l)).slice(0, 5).join('\n')}`);
  } finally { p.proceso.kill('SIGTERM'); await new Promise((r) => p.proceso.once('close', r)); }
  assert.deepStrictEqual(fs.readdirSync(raiz), [], 'la carpeta temporal propia se borra al salir');
});

test('2.76-Demo_Idioma_SoloCookie', async () => {
  const h = await arrancarDemo();
  const listar = (d) => { const out = []; const rec = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isDirectory()) rec(p); else out.push(`${path.relative(d, p)}:${fs.statSync(p).mtimeMs}:${fs.statSync(p).size}`); } }; rec(d); return out.sort(); };
  try {
    const antes = listar(h.dir);
    const r = await h.pedir('/idioma', { method: 'POST', headers: { ...MISMO_ORIGEN, ...FORM }, body: 'idioma=en&volver=%2Fproyectos' });
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.location, '/proyectos');
    assert.strictEqual(r.cookies['sitio-idioma'].valor, 'en');
    const ingles = await h.pedir('/', { cookie: 'sitio-idioma=en' });
    assert.match(ingles.texto, /<html lang="en"/);
    assert.match(ingles.texto, /Example data/);
    const otra = await h.pedir('/idioma', { method: 'POST', headers: { ...MISMO_ORIGEN, ...FORM }, body: 'idioma=es&volver=%2F' });
    assert.strictEqual(otra.cookies['sitio-idioma'].valor, 'es');
    assert.deepStrictEqual(listar(h.dir), antes, 'nada en disco: ni preferencias ni archivos nuevos');
    assert.ok(!listar(h.dir).some((f) => /idiomas\.json/.test(f)));
    assert.ok(!h.registro.some((l) => /SITE_DATA_DIR|idioma elegido se recuerda/.test(l)), 'ni una línea de «no hay dónde guardarlo»');
  } finally { await h.cerrar(); }
});

// ── cada pestaña con datos, la franja, los botones que muestran lo que pasaría y lo mínimo de un sitio público ──

const PAGINAS = ['/', '/corridas', '/proyectos', '/arnes', '/configuracion', '/como-trabaja', '/ayuda'];
const JSON_H = { 'content-type': 'application/json' };

/** El sitio demo de verdad (otro proceso, con su freno puesto) durante `fn({ base, pedir, token, sinFreno })`. */
async function conProcesoDemo(fn) {
  const puerto = await puertoLibre();
  const base = `http://127.0.0.1:${puerto}`;
  const raiz = tmp('demo-proceso-');
  const p = await correrServidor({ SITE_DEMO: '1', PORT: String(puerto), SITE_PUBLIC_URL: base, TMPDIR: raiz }, { espera: 1 });
  try {
    assert.ok(await esperarA(() => /escuchando en el puerto/.test(p.salida())), `no escuchó: ${p.salida()} ${p.error()}`);
    const h = { pedir: (ruta, o) => H.pedirA(base, ruta, o) };
    const meta = /<meta name="site-token" content="([^"]+)"/.exec((await h.pedir('/configuracion')).texto);
    assert.ok(meta, 'la página de Configuración trae el token de la sesión');
    const escribir = (ruta, cuerpo, extra = {}) => h.pedir(ruta, { method: 'POST', headers: { ...JSON_H, origin: base, 'x-site-token': meta[1], ...extra }, body: JSON.stringify(cuerpo) });
    await fn({ base, pedir: h.pedir, escribir, token: meta[1], vistas: () => (p.salida() + p.error()).split('\n').filter((l) => /freno:/.test(l)) });
  } finally { p.proceso.kill('SIGTERM'); await new Promise((r) => p.proceso.once('close', r)); }
}

test('2.76-Demo_CadaPestanaConDatos', async () => {
  const h = await arrancarDemo();
  try {
    const sinDatos = (nombre, texto) => assert.doesNotMatch(texto, /sin datos/i, `${nombre} no dice «sin datos»`);
    const inicio = await h.pedir('/');
    assert.match(inicio.texto, /Qué decidir hoy/);
    assert.match(inicio.texto, />Acme</, 'la marca de la organización de ejemplo');
    sinDatos('/', inicio.texto);
    const proyectos = await h.pedir('/proyectos');
    assert.strictEqual(proyectos.status, 200);
    assert.match(proyectos.texto, /Producto X/);
    assert.match(proyectos.texto, /Producto Y/);
    sinDatos('/proyectos', proyectos.texto);
    const arnes = await h.pedir('/arnes');
    assert.match(arnes.texto, /Cómo está el arnés/);
    assert.doesNotMatch(arnes.texto, /no se pudo mirar|sin mirar/i, 'la última versión publicada contesta con datos de ejemplo');
    sinDatos('/arnes', arnes.texto);
    // Ejecuciones: la tabla, el detalle de una y sus textos
    const tabla = await pedirListo(h, '/corridas');
    assert.strictEqual(tabla.status, 200);
    assert.match(tabla.texto, /Lo que se mira primero/);
    const lista = (await pedirListo(h, '/api/corridas')).json.corridas;
    assert.strictEqual(lista.length, 5);
    for (const c of lista) {
      const detalle = await h.pedir(`/api/corridas/${c.id}`);
      assert.strictEqual(detalle.status, 200, `el detalle de ${c.id}`);
      assert.ok(detalle.json.story && detalle.json.tramos.length > 0);
      const textos = await h.pedir(`/api/corridas/${c.id}/textos`);
      assert.strictEqual(textos.status, 200, `los textos de ${c.id}`);
      assert.strictEqual(typeof textos.json.texto, 'string', 'trae el texto del cambio');
      assert.ok(zlibTexto(textos.json.texto).includes('const limite = 25'), 'y es el de la conversación de ejemplo');
    }
    // Cómo trabaja, con su paquete de revisores propio
    const como = await h.pedir('/como-trabaja');
    assert.strictEqual(como.status, 200);
    assert.match(como.texto, /acme-api-reviewer/);
    const revisor = await h.pedir('/api/como-trabaja/revisor?pack=acme-api&agent=acme-api-reviewer');
    assert.strictEqual(revisor.status, 200);
    assert.ok(revisor.json.draft && revisor.json.versions && revisor.json.firma, 'el revisor se abre con su borrador y sus versiones');
    const ayuda = await h.pedir('/ayuda');
    assert.match(ayuda.texto, /Problemas comunes/);
    // Configuración: todas las secciones leen, la plataforma contesta y las invitaciones tienen estado
    const configuracion = await h.pedir('/configuracion');
    assert.strictEqual(configuracion.status, 200);
    const cfg = await h.pedir('/api/config');
    assert.strictEqual(cfg.status, 200);
    assert.deepStrictEqual(cfg.json.secciones.filter((s) => ['ilegible', 'no_reader', 'bajando'].includes(s.estado)).map((s) => s.id), [], 'ninguna sección sin leer');
    // un producto sale una vez por cada lugar de donde sale (la lista de dependencias y, en el demo, los despliegues)
    assert.deepStrictEqual([...new Set(cfg.json.productos.map((x) => x.producto))].sort(), ['Producto X', 'Producto Y']);
    assert.strictEqual(cfg.json.proponer.operaciones.habilitado, true);
    assert.strictEqual(cfg.json.proponer.perfil.habilitado, true);
    const sitio = cfg.json.secciones.find((s) => s.id === 'sitio');
    assert.strictEqual(sitio.extras.invitaciones.boton, true);
    assert.strictEqual(sitio.extras.invitaciones.estados['nuevo@acme.example'].estado, 'enviada', 'el estado de ejemplo de una invitación');
    assert.strictEqual((await h.pedir('/api/config?releer=1')).status, 200);
    // las consultas de Configuración a la plataforma: datos de ejemplo, sin red y nunca 500
    const token = /<meta name="site-token" content="([^"]+)"/.exec(configuracion.texto)[1];
    const escribir = (ruta, cuerpo) => h.pedir(ruta, { method: 'POST', headers: { ...JSON_H, ...MISMO_ORIGEN, 'x-site-token': token }, body: JSON.stringify(cuerpo) });
    const pip = await escribir('/api/config/pipelines', { org: 'acme', project: 'Producto X' });
    assert.ok(pip.json.ok && pip.json.pipelines.length >= 2, JSON.stringify(pip.json));
    const stages = await escribir('/api/config/stages', { pipeline: `Producto X/${pip.json.pipelines[0].id}` });
    assert.ok(stages.json.ok && stages.json.propuestos.some((x) => x.identificador === 'Production'), JSON.stringify(stages.json));
    const pasos = await escribir('/api/config/pasos', { pipeline: `Producto X/${pip.json.pipelines[0].nombre}` });
    assert.ok(pasos.json.ok && Object.keys(pasos.json.nombres).length >= 2, JSON.stringify(pasos.json));
    const tipos = await escribir('/api/config/tipos-de-pedido', {});
    assert.ok(tipos.json.ok && tipos.json.tipos.includes('Riesgo'), JSON.stringify(tipos.json));
    const campos = await escribir('/api/config/campos-de-pedido', { tipo: 'Riesgo' });
    assert.ok(campos.json.ok && campos.json.campos.length >= 5, JSON.stringify(campos.json));
    for (const r of [pip, stages, pasos, tipos, campos]) assert.strictEqual(r.status, 200);
  } finally { await h.cerrar(); }
});

/** El texto de un campo `texto` de /api/corridas/:id/textos: gzip en base64. */
function zlibTexto(b64) { return require('zlib').gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'); }

test('2.76-Demo_FranjaDatosDeEjemplo', async () => {
  const h = await arrancarDemo();
  try {
    await pedirListo(h, '/corridas');
    const TEXTOS = { es: 'Datos de ejemplo', en: 'Example data' };
    for (const idioma of ['es', 'en']) {
      for (const vista of ['mantenedor', 'persona']) {
        for (const ruta of [...PAGINAS, '/no-existe', '/licencia']) {
          const r = await pedirListo(h, ruta, { cookie: `sitio-idioma=${idioma}; sitio-demo-vista=${vista}` });
          if (!/^text\/html/.test(r.headers['content-type'] || '')) continue;
          assert.match(r.texto, /<body class="demo"><div class="franja-demo" role="note"><b>/, `${ruta} (${idioma}, ${vista}) trae la franja arriba de todo`);
          assert.ok(r.texto.includes(`<b>${TEXTOS[idioma]}</b>`), `${ruta} (${idioma}) dice «${TEXTOS[idioma]}»`);
          assert.match(r.texto, new RegExp(`<title>${TEXTOS[idioma]} · `), `${ruta} (${idioma}) lo dice en su título`);
          assert.ok(r.texto.includes(`name="volver" value="${ruta}"`) || ruta === '/no-existe' || ruta === '/licencia', `${ruta}: «Ver como» vuelve a la misma página`);
        }
      }
    }
    // la hoja de estilo trae la franja fija
    assert.ok(/\.franja-demo\{position:sticky/.test((await h.pedir('/static/site.css')).texto), 'la hoja de estilo trae la franja fija');
    // pase adversarial, clase 13: un `$` en la dirección no es una orden de reemplazo (`$\``, `$'`, `$&`, `$$`) ni se sale del atributo
    for (const ruta of ['/?x=$`', "/$'", '/?x=$&', '/?x=$$', "/?x=$'$`"]) {
      const r = await pedirListo(h, ruta);
      assert.strictEqual((r.texto.match(/<!doctype/gi) || []).length, 1, `${ruta}: una sola página`);
      assert.strictEqual((r.texto.match(/<body class="demo">/g) || []).length, 1, `${ruta}: una sola franja`);
      const volver = /name="volver" value="([^"]*)"/.exec(r.texto);
      assert.ok(volver && !/[<>]/.test(volver[1]) && volver[1].startsWith(ruta.slice(0, 3)), `${ruta}: «Ver como» vuelve a la misma dirección, sin salir del atributo`);
      assert.match(r.texto, /<title>Datos de ejemplo · /, `${ruta}: el título lleva la marca`);
    }
  } finally { await h.cerrar(); }
});

test('2.76-Demo_Proponer_MuestraYNoEscribe', async () => {
  await conProcesoDemo(async ({ escribir, pedir, vistas }) => {
    const cfg = (await pedir('/api/config')).json;
    const seccion = cfg.secciones.find((s) => s.id === 'respuesta');
    // Proponer de Configuración: «Revisar» como siempre, y al confirmar, lo que pasaría
    const revisada = (await escribir('/api/config/revisar', { seccion: 'respuesta', borrador: { response: { style: 'executive', max_chars: 1300 } }, oid: seccion.oid, base: seccion.texto })).json;
    assert.strictEqual(revisada.ok, true, JSON.stringify(revisada.problems));
    const marca = 'a'.repeat(32);
    const propuesta = (await escribir('/api/config/proponer', { seccion: 'respuesta', texto: revisada.texto, oid: seccion.oid, base: seccion.texto, marca })).json;
    assert.strictEqual(propuesta.ok, true);
    assert.strictEqual(propuesta.codigo, 'demo');
    assert.match(propuesta.message, /En el sitio demo no se escribe/);
    assert.match(propuesta.message, /ningún pedido|no se abrió/);
    assert.ok(!propuesta.enlace, 'no hay pedido que enlazar');
    assert.strictEqual(propuesta.loQuePasaria.repo, 'perfil');
    assert.ok(propuesta.loQuePasaria.diferencia.length > 0, 'muestra el cambio');
    // una propuesta que no valida se rechaza igual que en el sitio real
    const mala = (await escribir('/api/config/proponer', { seccion: 'respuesta', texto: '{"x":1}\n', oid: seccion.oid, base: seccion.texto })).json;
    assert.strictEqual(mala.ok, false);
    // en inglés, el mensaje también sale en inglés
    const en = (await escribir('/api/config/proponer', { seccion: 'respuesta', texto: revisada.texto, oid: seccion.oid, base: seccion.texto }, { cookie: 'sitio-idioma=en' })).json;
    assert.match(en.message, /The demo site writes nothing/);
    // Invitar y Revocar
    const invitada = (await escribir('/api/config/invitar', { correo: 'otra@acme.example', productos: ['Producto X'] })).json;
    assert.strictEqual(invitada.ok, true);
    assert.strictEqual(invitada.codigo, 'demo');
    assert.match(invitada.message, /En el sitio demo no se escribe/);
    assert.match(invitada.message, /otra@acme\.example/);
    const yaEstaba = (await escribir('/api/config/invitar', { correo: 'ana@acme.example' })).json;
    assert.strictEqual(yaEstaba.ok, false, 'invitar a alguien que ya está en la lista se rechaza como siempre');
    const revocada = (await escribir('/api/config/revocar', { correo: 'nuevo@acme.example' })).json;
    assert.strictEqual(revocada.ok, true);
    assert.strictEqual(revocada.codigo, 'demo');
    assert.match(revocada.message, /En el sitio demo no se escribe/);
    // Proponer de «Cómo trabaja»: la revisión del revisor y, al confirmar, lo que pasaría
    const abierto = (await pedir('/api/como-trabaja/revisor?pack=acme-api&agent=acme-api-reviewer')).json;
    const rev = (await escribir('/api/como-trabaja/revisar', { draft: abierto.draft })).json;
    assert.strictEqual(rev.ok, true, JSON.stringify(rev));
    const como = (await escribir('/api/como-trabaja/proponer', { draft: abierto.draft, versions: abierto.versions, firma: abierto.firma })).json;
    assert.strictEqual(como.ok, true, JSON.stringify(como));
    assert.strictEqual(como.codigo, 'demo');
    assert.match(como.message, /En el sitio demo no se escribe/);
    assert.ok(como.loQuePasaria.archivos.some((a) => /pack\.json$/.test(a)));
    // clase 14: «Cómo trabaja» muestra la respuesta del modo demo (no «Pedido abierto…»)
    const pagina = (await pedir('/static/como-trabaja.js?l=es')).texto;
    const iDemo = pagina.indexOf("r.codigo === 'demo'");
    assert.ok(iDemo > 0 && iDemo < pagina.indexOf("T('comoTrabaja.propuesto'") && /r\.codigo === 'demo'\) estado\.appendChild\(el\('p', \{[^}]*text: r\.message/.test(pagina), 'el navegador escribe el mensaje del servidor con codigo demo');
    // y nada intentó salir ni escribir: el freno no anotó un solo intento
    assert.deepStrictEqual(vistas(), []);
  });
  // pase adversarial, clase 1: «Proponer» contesta en cada sección que se puede revisar (el piso de versión de la capa del
  // equipo de los datos de ejemplo cubre lo que sus claves piden: `stack`, aprobaciones…). En el mismo proceso: el tope de
  // pedidos por minuto del sitio cuenta por dirección: cada sección pide desde la suya, así el recorrido no depende de
  // cuántas secciones haya
  const h = await arrancarDemo();
  try {
    const token = /<meta name="site-token" content="([^"]+)"/.exec((await h.pedir('/configuracion')).texto)[1];
    let direccion = '';
    const escribir = (ruta, cuerpo) => h.pedir(ruta, { method: 'POST', headers: { ...JSON_H, ...MISMO_ORIGEN, 'x-site-token': token, 'x-forwarded-for': direccion }, body: JSON.stringify(cuerpo) });
    const cfg = (await h.pedir('/api/config')).json;
    const revisables = [];
    for (const [i, sec] of cfg.secciones.entries()) {
      direccion = `192.0.2.${i + 1}`;
      let borrador; try { borrador = JSON.parse(sec.texto); } catch { borrador = null; }
      const r = (await escribir('/api/config/revisar', { seccion: sec.id, borrador, oid: sec.oid, base: sec.texto })).json;
      if (!r.ok) continue;
      revisables.push(sec.id);
      const res = await escribir('/api/config/proponer', { seccion: sec.id, texto: r.texto, oid: sec.oid, base: sec.texto, marca: 'a'.repeat(32) });
      assert.ok(res.json && res.json.codigo === 'demo', `${sec.id}: Proponer muestra lo que pasaría (${res.status} ${String(res.texto).slice(0, 200)})`);
    }
    for (const id of ['repos', 'suites', 'modelos', 'espera', 'cobertura', 'revision', 'tecnologia', 'aprobaciones']) assert.ok(revisables.includes(id), `${id} se puede revisar y proponer`);
    const org = require('../lib/org-config.js');
    const piso = DATOS().archivosDelPerfil()['team-layer.json'].requires.harness.replace(/^>= /, '');
    for (const v of [org.RESPONSE_SINCE, org.STACK_SINCE, org.APPROVALS_SINCE]) assert.ok(org.versionAtLeast(piso, v), `el piso ${piso} alcanza a ${v}`);
  } finally { await h.cerrar(); }
});

test('2.76-Demo_SitioPublico_NoindexYTope', async () => {
  const h = await arrancarDemo();
  try {
    for (const ruta of ['/', '/livez', '/api/inicio', '/no-existe', '/static/site.css', '/licencia', '/auth/login']) {
      const r = await h.pedir(ruta);
      assert.strictEqual(r.headers['x-robots-tag'], 'noindex', `${ruta} pide que no se indexe`);
    }
    const desde = (ip, extra = {}) => h.pedir('/api/inicio', { headers: { 'x-forwarded-for': ip, ...extra } });
    const estados = [];
    for (let i = 0; i < 61; i++) estados.push((await desde('198.51.100.1')).status);
    assert.deepStrictEqual(estados.slice(0, 60).filter((s) => s !== 200), [], 'los primeros 60 pasan');
    assert.strictEqual(estados[60], 429, 'el 61 responde 429');
    const lleno = await desde('198.51.100.1');
    assert.strictEqual(lleno.status, 429);
    assert.ok(Number(lleno.headers['retry-after']) >= 1, 'dice cuándo volver');
    assert.strictEqual(lleno.headers['x-robots-tag'], 'noindex', 'también el 429');
    // la dirección es la ÚLTIMA de X-Forwarded-For: quien inventa las anteriores no se saca el tope de encima
    assert.strictEqual((await desde('203.0.113.99, 198.51.100.1')).status, 429, 'las anteriores las inventa quien pide');
    // otra dirección lleva su propia cuenta
    assert.strictEqual((await desde('198.51.100.2')).status, 200);
    assert.strictEqual((await desde('203.0.113.99, 198.51.100.2')).status, 200);
    // las sondas de la plataforma no cuentan: con el tope lleno siguen contestando
    assert.strictEqual((await h.pedir('/livez', { headers: { 'x-forwarded-for': '198.51.100.1' } })).status, 200);
    // nada del registro del sitio en las páginas
    for (const ruta of ['/', '/arnes', '/proyectos', '/configuracion', '/como-trabaja']) {
      const r = await h.pedir(ruta, { headers: { 'x-forwarded-for': '198.51.100.3' } });
      assert.ok(!r.texto.includes(h.dir) && !r.texto.includes(os.tmpdir()), `${ruta}: ninguna ruta de la carpeta temporal`);
      for (const l of h.registro.filter((x) => x.length > 20)) assert.ok(!r.texto.includes(l), `${ruta}: ninguna línea del registro («${l.slice(0, 40)}…»)`);
    }
  } finally { await h.cerrar(); }
  // sin X-Forwarded-For cuenta la dirección del socket
  const h2 = await arrancarDemo();
  try {
    const estados = [];
    for (let i = 0; i < 61; i++) estados.push((await h2.pedir('/api/inicio')).status);
    assert.deepStrictEqual([estados.filter((s) => s === 200).length, estados[60]], [60, 429]);
  } finally { await h2.cerrar(); }
  // el tope vuelve a empezar pasado el minuto
  const { crearTope } = DEMO();
  let t = 1000;
  const tope = crearTope({ ahora: () => t, porMinuto: 3 });
  const req = { headers: { 'x-forwarded-for': '198.51.100.7' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.deepStrictEqual([tope(req).ok, tope(req).ok, tope(req).ok, tope(req).ok], [true, true, true, false]);
  t += 60001;
  assert.strictEqual(tope(req).ok, true);
});

// los hilos aparte de estas pruebas tienen tope propio: uno colgado sale rojo diciendo qué esperaba y se termina,
// en vez de dejar viva la suite hasta el tope de la CI (15 min) sin decir dónde
const TOPE_HILO_MS = 60000;
const conTope = (promesa, que, alCortar, ms = TOPE_HILO_MS) => {
  let corte;
  const tope = new Promise((_, reject) => {
    corte = setTimeout(() => { if (alCortar) alCortar(); reject(new Error(`se colgó esperando ${que} (${ms / 1000} s)`)); }, ms);
  });
  return Promise.race([promesa, tope]).finally(() => clearTimeout(corte));
};

test('2.76-Demo_HiloColgado_SaleRojoYSeTermina', async () => {
  // un hilo que nunca contesta ni termina: la espera sale roja diciendo qué esperaba, y el hilo queda terminado
  const { Worker } = require('worker_threads');
  const w = new Worker('setInterval(() => {}, 1000)', { eval: true });
  const salida = new Promise((r) => w.once('exit', r));
  await assert.rejects(conTope(new Promise((r) => w.once('message', r)), 'el mensaje del hilo', () => { w.terminate(); }, 300),
    /se colgó esperando el mensaje del hilo \(0\.3 s\)/);
  assert.strictEqual(await conTope(salida, 'el fin del hilo', null, 5000), 1, 'terminado desde afuera: sale 1');
});

test('2.76-Demo_FrenoEnElHiloAparte', async () => {
  const { ponerFreno, crearFuentesDemo } = DEMO();
  const { armarEnWorker } = require(path.join(SITE, 'tabs', 'runs.js'));
  const dir = tmp('demo-hilo-');
  const afuera = tmp('demo-hilo-afuera-');
  const fuentes = crearFuentesDemo({ dir });
  const freno = ponerFreno({ dir });
  // `tiempoMs`: el armado corta y termina su hilo solo; el código del corte dice cuál de los dos armados se colgó
  const armar = () => armarEnWorker({ buzon: fuentes.dirBuzon, textosDir: path.join(afuera, 'textos'), tiempoMs: TOPE_HILO_MS });
  try {
    // el hilo aparte arma la vista de ejecuciones con el freno puesto adentro: lo que quiera escribir afuera falla cerrado
    await assert.rejects(armar, (e) => { assert.strictEqual(e.code, 'EDEMO_FRENO', 'el armado con el freno'); return true; });
  } finally { freno.quitar(); }
  assert.deepStrictEqual(fs.readdirSync(afuera), [], 'afuera no se escribió nada');
  // sin el freno el mismo armado anda: lo anterior falló por el freno, no por otra cosa
  const r = await armar();
  assert.strictEqual(r.M.corridas.length, 5);
  await subcasoHiloAnotaElIntento();
});

// subcaso de 2.76-Demo_FrenoEnElHiloAparte: un intento dentro del hilo queda anotado
async function subcasoHiloAnotaElIntento() {
  const { Worker } = require('worker_threads');
  const dir = tmp('demo-hilo-anota-');
  const codigo = `const { workerData, parentPort } = require('worker_threads');
    const f = require(workerData.freno).ponerFreno({ dir: workerData.dir });
    let c = null; try { require('http').request('http://otro.example/'); } catch (e) { c = e.code; }
    parentPort.postMessage({ c, n: f.intentos.length });`;
  const w = new Worker(codigo, { eval: true, stderr: true, workerData: { freno: path.join(SITE, 'demo-guard.js'), dir } });
  let err = ''; w.stderr.on('data', (d) => { err += d; });
  // el fin se escucha desde el principio: escucharlo recién después del mensaje se pierde un fin que ya llegó
  const salida = new Promise((r) => w.once('exit', r));
  const terminar = () => { w.terminate(); };
  const m = await conTope(new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); }), 'el mensaje del hilo', terminar);
  await conTope(salida, 'el fin del hilo', terminar);
  assert.deepStrictEqual(m, { c: 'EDEMO_FRENO', n: 1 });
  assert.match(err, /freno: red: request: .*otro\.example/, 'el intento del hilo queda anotado en su salida de error');
}

// subcaso de 2.76-Demo_FrenoDeRed_FallaCerrado: una falla al rehacer los datos se anota y no traba los siguientes
async function subcasoRefrescarFallido() {
  const { crearFuentesDemo } = DEMO();
  let romper = false;
  const lineas = [];
  const fuentes = crearFuentesDemo({ dir: tmp('demo-refrescar-'), ahora: () => { if (romper) throw new Error('se rompió'); return AHORA_FIJO; }, log: (l) => lineas.push(l) });
  romper = true;
  await assert.rejects(() => fuentes.refrescar(), /se rompió/);
  assert.ok(lineas.some((l) => /se rompió/.test(l)), 'la falla queda anotada');
  romper = false;
  await fuentes.refrescar();
  assert.strictEqual(await fuentes.exclusivo(async () => 'ok'), 'ok');
}

test('2.76-Demo_FrenoSePoneAntesDeCargarFuentesYPestanas', () => {
  // server.js pone el freno al cargarse, antes de pedir ninguno de los módulos que guardarían una referencia a lo que veda
  const texto = fs.readFileSync(path.join(SITE, 'server.js'), 'utf8');
  const freno = texto.indexOf("require('./demo-guard.js').frenoTemprano()");
  assert.ok(freno > 0, 'server.js pone el freno al cargarse');
  for (const modulo of ["require('./session.js')", "require('./oidc.js')", "require('./views.js')", "require('./sources.js')", "require('./texts.js')", "path.join(__dirname, 'auth-providers')"]) {
    assert.ok(freno < texto.indexOf(modulo), `el freno va antes de ${modulo}`);
  }
  // y el archivo del freno no carga nada del sitio: sólo módulos del sistema
  const propios = [...fs.readFileSync(path.join(SITE, 'demo-guard.js'), 'utf8').matchAll(/require\('(\.[^']*)'\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(propios, [], 'demo-guard.js no carga nada del sitio');
});

// ── 8.101: todo lo que se ve tiene un dato de ejemplo ───────────────────────────────────────────────────────────────

const TX = () => require(path.join(SITE, 'texts.js'));
// los estados con que las respuestas del sitio dicen que un dato falta
const ESTADOS_DE_HUECO = new Set(['no_medido', 'no_medidas', 'sin_medir', 'no_configurado', 'ilegible', 'no_reader', 'no_se_pudo', 'sin_foto', 'sin_datos']);

/** Los huecos del HTML de una pestaña: tarjetas y celdas no medidas, listas vacías y los textos exactos de hueco de texts.js. */
function huecosDelHtml(html, idioma) {
  const T = (k) => TX().t(idioma, k);
  const main = (/<main[\s\S]*<\/main>/.exec(html) || [html])[0].replace(/<script[\s\S]*?<\/script>/g, '');
  const out = [];
  if (/class="tile blind"/.test(main)) out.push(`tarjeta no medida: ${(/class="tile blind">[\s\S]*?<div class="t-label">([^<]*)/.exec(main) || [])[1]}`);
  if (/<td class="nm"/.test(main)) out.push('celda no medida');
  // las líneas no medidas de «Cómo está el arnés»: el rótulo va pegado al título en el texto, se las reconoce por la marca
  for (const m of main.matchAll(/<li class="nm">[\s\S]*?<\/li>/g)) out.push(`línea no medida: ${m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)}`);
  if (/class="pill nm"/.test(main) && !/<li class="nm">/.test(main)) out.push('marca «no medido»');
  if (/<ul class="lista">\s*<\/ul>/.test(main)) out.push('lista vacía');
  const enteras = new Set(['vista.noMedido', 'vista.ninguno', 'pantalla.sinDato', 'vista.falta', 'fichas.noMedido', 'fichas.falta', 'corridas.falta'].map(T));
  const adentro = [T('frase.sin_foto'), T('ficha.motivo.sin_datos'), `${T('vista.noMedido')}:`];
  const texto = main.replace(/<(br|\/?(p|div|li|tr|td|th|h\d|section|ul|dt|dd|summary))\b[^>]*>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const l of texto.split('\n').map((x) => x.trim()).filter(Boolean)) {
    if (enteras.has(l) || adentro.some((a) => l.includes(a))) out.push(`«${l.slice(0, 120)}»`);
  }
  return out;
}

/** Los huecos de una respuesta JSON: cada `estado` de hueco, con su ruta y su motivo. */
function huecosDelJson(v, ruta = '$', out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => huecosDelJson(x, `${ruta}[${i}]`, out));
  else if (v && typeof v === 'object') {
    if (typeof v.estado === 'string' && ESTADOS_DE_HUECO.has(v.estado)) out.push(`${ruta}: ${v.estado}${v.motivo ? ` (${String(v.motivo).slice(0, 120)})` : ''}`);
    for (const [k, x] of Object.entries(v)) huecosDelJson(x, `${ruta}.${k}`, out);
  }
  return out;
}

test('8.101-Demo_Recorrido_SinHuecos', async () => {
  // el detector mismo: la página de Arnés con una fuente vieja y sin versión tiene líneas no medidas, y las ve
  const conHuecos = require(path.join(SITE, 'views.js')).paginaArnes({ quien: { rol: 'maintainer', nombre: 'x' }, modelo: { sources: { lista: [{ id: 'sdlc-stage', estado: 'viejo', fecha: '2026-10-20', motivo: 'la foto es de hace 3 días' }] } }, version: null, ahora: AHORA_FIJO, idioma: 'es' });
  assert.ok(huecosDelHtml(conHuecos, 'es').some((x) => /línea no medida: Fuente sdlc-stage/.test(x)), 'el detector ve las líneas no medidas de Arnés');
  const h = await arrancarDemo();
  const huecos = [];
  try {
    assert.strictEqual((await pedirListo(h, '/api/corridas')).status, 200);
    for (const vista of ['mantenedor', 'persona']) {
      for (const idioma of ['es', 'en']) {
        const cookie = `sitio-demo-vista=${vista}; sitio-idioma=${idioma}`;
        const donde = (q) => `${q} · ${vista} · ${idioma}`;
        for (const pagina of ['/', '/corridas', '/proyectos', '/arnes', '/configuracion', '/como-trabaja']) {
          const r = await h.pedir(pagina, { cookie });
          // Arnés, Configuración y Cómo trabaja son de quien mantiene: la persona ve la página de permiso, que no es un hueco
          if (vista === 'persona' && ['/arnes', '/configuracion', '/como-trabaja'].includes(pagina)) { assert.strictEqual(r.status, 403, donde(pagina)); continue; }
          assert.strictEqual(r.status, 200, donde(pagina));
          for (const x of huecosDelHtml(r.texto, idioma)) huecos.push(`${donde(pagina)}: ${x}`);
        }
        const lista = (await pedirListo(h, '/api/corridas', { cookie })).json;
        assert.ok(lista && lista.corridas.length > 0, donde('/api/corridas'));
        for (const x of huecosDelJson(lista)) huecos.push(`${donde('/api/corridas')}: ${x}`);
        for (const c of lista.corridas) {
          for (const x of huecosDelJson((await h.pedir(`/api/corridas/${c.id}`, { cookie })).json)) huecos.push(`${donde(`/api/corridas/${c.id}`)}: ${x}`);
        }
        if (vista !== 'mantenedor') continue;
        const cfg = (await h.pedir('/api/config', { cookie })).json;
        for (const x of huecosDelJson(cfg)) huecos.push(`${donde('/api/config')}: ${x}`);
        for (const e of cfg.reposDeProducto.lista) {
          for (const x of huecosDelJson((await h.pedir(`/api/config/repo?id=${encodeURIComponent(e.id)}`, { cookie })).json)) huecos.push(`${donde(`/api/config/repo ${e.nombre}`)}: ${x}`);
        }
      }
    }
  } finally { await h.cerrar(); }
  assert.deepStrictEqual(huecos, [], `huecos en el demo:\n${huecos.join('\n')}`);
});

test('8.101-Demo_DatosCompletos_SoloConLaOpcion', () => {
  const D = DATOS();
  const zlib = require('zlib');
  // sin la opción, lo de siempre (2.76-Capturas_MismosDatos cuida el resumen de las capturas); con ella, lo que agrega el demo
  const base = D.operaciones({ ahora: AHORA_FIJO });
  const completo = D.operaciones({ ahora: AHORA_FIJO, completo: true });
  assert.deepStrictEqual(D.operaciones({ ahora: AHORA_FIJO, completo: false }), base);
  for (const k of ['.dashboard/open-prs/open-prs-2026-10-22.json', '.dashboard/assigned/assigned-2026-10-22.json', '.dashboard/retros/retros-2026-10-22.json',
    '.dashboard/controls-bench/banco-2026-10-21.json', '.dashboard/sdlc-stage-2026-10-22.json', 'scripts/controls-bench/ultimo-examen.json', 'scripts/ci/product-parity.json']) {
    assert.ok(!(k in base), `${k} no está en los datos de siempre`);
    assert.ok(k in completo, `${k} está en los del demo`);
  }
  const buzonBase = D.blobsDelBuzon(AHORA_FIJO);
  const buzon = D.blobsDelBuzon(AHORA_FIJO, { completo: true });
  assert.deepStrictEqual(D.blobsDelBuzon(AHORA_FIJO, { completo: false }), buzonBase);
  assert.ok(!('mac-ana/registros/gates.log.gz' in buzonBase));
  for (const maq of ['mac-ana', 'mac-lead']) for (const r of ['cobertura.json', 'gates.log.gz', 'frenos.jsonl.gz', 'hallazgos.jsonl.gz']) assert.ok(`${maq}/registros/${r}` in buzon, `${maq}/registros/${r}`);
  assert.strictEqual(Object.keys(buzon).filter((k) => /^[^/]+\/[0-9a-f-]{36}\.json$/.test(k)).length, 5, 'siguen siendo 5 ejecuciones');
  const perfil = D.archivosDelPerfil({ completo: true });
  assert.deepStrictEqual(D.archivosDelPerfil(), D.archivosDelPerfil({ completo: false }));
  assert.deepStrictEqual(perfil['team-repos.json'].review.blocking_prefixes, ['ACMEAPI']);
  // sólo nombres inventados, también adentro de lo comprimido (el sources.json es la configuración del propio arnés, no un dato inventado)
  const texto = (v) => (Buffer.isBuffer(v) ? zlib.gunzipSync(v).toString('utf8') : typeof v === 'string' ? v : JSON.stringify(v));
  const inventados = Object.fromEntries(Object.entries(completo).filter(([k]) => k !== 'scripts/nightly/dashboard/sources.json'));
  const todo = [inventados, perfil, D.ADVISORS_DE_EJEMPLO].map((x) => JSON.stringify(x)).concat(Object.values(buzon).map(texto)).join('\n');
  const correos = todo.match(/[\w.+-]+@[\w.-]+\.[a-z]+/g) || [];
  assert.ok(correos.length > 0);
  for (const c of correos) assert.match(c, /@acme\.example$/, `correo fuera de acme.example: ${c}`);
  // la misma regla de 2.76-Demo_Datos_SonDeAcmeYSiguenElDia: la organización de ejemplo es la de la plataforma (`dev.azure.com/acme`)
  for (const u of todo.match(/https?:\/\/[^"\\\s'<>]+/g) || []) assert.match(new URL(u).hostname, /(^|\.)(acme\.example|example|invalid)$|^dev\.azure\.com$/, `dirección fuera de las de ejemplo: ${u}`);
});

test('8.101-Demo_Ejecuciones_TodoMedido', async () => {
  const h = await arrancarDemo();
  try {
    const lista = (await pedirListo(h, '/api/corridas')).json;
    assert.strictEqual(lista.corridas.length, 5);
    assert.strictEqual(lista.buzon.uniones.estado, 'medidas', 'la banda de carpetas de máquina sale medida');
    const filas = lista.pasos.nombres;
    const conTiempo = new Set();
    const conTokens = new Set();
    for (const c of lista.corridas) {
      assert.strictEqual(c.tiempos.trabajo_medido, true, `${c.story}: trabajo medido`);
      assert.ok(Number.isFinite(c.tiempos.espera_humana_ms), `${c.story}: espera medida`);
      assert.ok(Number.isInteger(c.costo.vueltas) && c.costo.vueltas >= 1, `${c.story}: vueltas`);
      assert.strictEqual(c.validador.estado, 'medido', `${c.story}: validador por fase`);
      for (const t of c.tramos) if (t.tipo === 'paso' && t.ms > 0) conTiempo.add(t.nombre);
      const d = (await h.pedir(`/api/corridas/${c.id}`)).json;
      assert.strictEqual(d.revisores.estado, 'medido', `${c.story}: revisores medidos`);
      assert.ok(Object.keys(d.costo.por_tipo).length > 0, `${c.story}: desglose por tipo`);
      assert.strictEqual(Object.values(d.costo.por_tipo).reduce((a, b) => a + b, 0), d.costo.agentes, `${c.story}: el desglose suma los agentes`);
      for (const t of d.tramos) if (t.tipo === 'paso' && d.consumo.por_paso && Object.keys(d.consumo.por_paso).some((k) => t.pasos.map(String).includes(k))) conTokens.add(t.nombre);
    }
    assert.deepStrictEqual(filas.filter((f) => !conTiempo.has(f)), [], 'cada fila de «Tiempo por paso» tiene dato');
    assert.deepStrictEqual(filas.filter((f) => !conTokens.has(f)), [], 'cada fila de «Tokens por paso» tiene dato');
  } finally { await h.cerrar(); }
});

test('8.101-Demo_Configuracion_TodoConDato', async () => {
  for (const version of ['2026.10.23.10', null]) {
    const h = await arrancarDemo({}, { version });
    try {
      const cfg = (await h.pedir('/api/config')).json;
      const seccion = (id) => cfg.secciones.find((s) => s.id === id);
      const ops = JSON.parse(seccion('personas').texto);
      assert.deepStrictEqual(Object.keys(ops.people.projects).sort(), ['ana@acme.example', 'nuevo@acme.example']);
      assert.strictEqual(seccion('paridad').estado, 'cargado', 'la lista de paridad, con su diferencia aceptada');
      assert.ok(Object.keys(JSON.parse(seccion('despliegues').texto).deployments.products).length >= 2, 'los despliegues de cada producto');
      assert.ok(JSON.parse(seccion('canal').texto).notify, 'el canal del resumen');
      const maquinas = cfg.versiones;
      assert.strictEqual(maquinas.length, 3);
      assert.deepStrictEqual(maquinas.map((m) => m.estado).sort(), ['al_dia', 'al_dia', 'atrasada'], `versión ${version}: ${JSON.stringify(maquinas)}`);
      const repos = JSON.parse(seccion('revision').texto);
      assert.deepStrictEqual(repos.review.blocking_prefixes, ['ACMEAPI']);
      assert.deepStrictEqual(repos.stack.code_extensions, ['.cls'], 'la terminación propia');
      assert.strictEqual(cfg.proponer.perfil.habilitado, true, '«Proponer» del perfil sigue habilitado');
      // «Versión del sitio» en Arnés: la de la imagen, o la de ejemplo sin ella (la misma contra la que se comparan las máquinas)
      const propia = version || DATOS().VERSION_DE_EJEMPLO;
      assert.match((await h.pedir('/arnes')).texto, new RegExp(`${propia.replace(/\./g, '\\.')}`), `versión ${version}: Arnés dice ${propia}`);
    } finally { await h.cerrar(); }
  }
});

test('8.101-Demo_ConfigDeCadaRepo_SeLeeYProponerMuestra', async () => {
  await conProcesoDemo(async ({ pedir, escribir, vistas }) => {
    const cfg = (await pedir('/api/config')).json;
    assert.strictEqual(cfg.reposDeProducto.lista.length, 2);
    let leido = null;
    for (const e of cfg.reposDeProducto.lista) {
      const r = (await pedir(`/api/config/repo?id=${encodeURIComponent(e.id)}`)).json;
      assert.ok(['leido', 'nuevo'].includes(r.estado), `${e.nombre}: ${r.estado} ${r.motivo || ''}`);
      assert.strictEqual(r.proponer.habilitado, true, `${e.nombre}: «Proponer» habilitado`);
      if (r.estado === 'leido') leido = { e, r };
    }
    assert.ok(leido, 'al menos un repo trae su advisors.yaml');
    const clave = leido.r.claves.find((c) => c.estado === 'ok');
    // el `deprecated` de ejemplo trae una ruta viva: sus archivos están en la rama, nada podrido
    assert.ok(clave.valor && clave.valor.paths && clave.valor.paths.length > 0, 'el deprecated trae sus rutas');
    assert.deepStrictEqual(clave.podridas, [], 'las rutas de ejemplo existen en la rama');
    const valor = JSON.parse(JSON.stringify(clave.valor || {}));
    valor.edit = valor.edit === 'warn' ? 'block' : 'warn';
    const rev = (await escribir('/api/config/repo/revisar', { id: leido.e.id, clave: clave.clave, valor, oid: leido.r.oid })).json;
    assert.strictEqual(rev.ok, true, JSON.stringify(rev));
    const prop = (await escribir('/api/config/repo/proponer', { id: leido.e.id, clave: clave.clave, valor, oid: leido.r.oid, marca: 'b'.repeat(32) })).json;
    assert.strictEqual(prop.ok, true, JSON.stringify(prop));
    assert.strictEqual(prop.codigo, 'demo');
    assert.match(prop.message, /En el sitio demo no se escribe/);
    assert.strictEqual(prop.loQuePasaria.archivo, leido.r.archivo);
    assert.ok(prop.loQuePasaria.diferencia.length > 0, 'muestra el cambio');
    assert.deepStrictEqual(vistas(), [], 'ni clonó ni escribió: el freno no anotó intentos');
  });
});
