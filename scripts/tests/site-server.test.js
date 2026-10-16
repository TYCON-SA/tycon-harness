'use strict';
/*
 * site-server.test.js — el arranque, la tabla de rutas, la vida y la imagen del sitio de la organización (story 2.23).
 *
 * T1  Arranque_FaltaUnaVariable_NoArranca          T19 Rutas_SinDeclaracion_NoArranca
 * T2  Arranque_RegistroSinSecretos                 T33 PrimerMantenedor_SoloSinLista
 * T6  Imagen_DockerfileSinPrivilegiosNiPruebas     T39 Nucleo_SinNube
 * T7  Codigo_SinValoresDeUnaOrganizacion           T42 Vida_NoDependeDelFreno
 *
 * Y de la story 2.28: T29 2.28-Healthz_FrenadoSinUltimoBueno.
 * T6b Imagen_TodoLoQueCargaElSitioEstaAdentro: lo que el sitio carga (sus módulos y los lectores de Configuración) está
 *     en lo que copia la imagen (caso 2026-10-16: el lector de la paridad quedó afuera y la sección decía «no sabe leer»).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const { arrancarRepoHttp, repoConArchivos, hayHttpBackend } = require('./lib/git-http-server.js');
const H = require('./lib/site-harness.js');

const SITE = H.SITE;
const ROOT = path.resolve(SITE, '..', '..');
const SERVER = path.join(SITE, 'server.js');
const { validarConfiguracion, crearSitio } = require(SERVER);
const access = require(path.join(SITE, 'access.js'));

/** El arranque real, con un ambiente limpio: { status, salida }. */
function arrancarProceso(env, timeout = 20000) {
  const r = spawnSync(process.execPath, [SERVER], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env }, encoding: 'utf8', timeout });
  return { status: r.status, salida: `${r.stdout}${r.stderr}` };
}
const puertoLibre = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

/** Arranca el proceso de verdad y espera a que diga que escucha; devuelve { hijo, salida(), puerto }. */
async function procesoVivo(env) {
  const puerto = await puertoLibre();
  const hijo = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), PORT: String(puerto), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let salida = '';
  hijo.stdout.on('data', (c) => { salida += c; });
  hijo.stderr.on('data', (c) => { salida += c; });
  // stable-data: el reloj sólo pone el plazo de espera del arranque del proceso hijo; no entra en lo que se compara.
  const hasta = Date.now() + 20000;
  while (!/escuchando en el puerto/.test(salida)) {
    if (Date.now() > hasta || hijo.exitCode !== null) throw new Error(`el sitio no arrancó: ${salida}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return { hijo, puerto, salida: () => salida, base: `http://127.0.0.1:${puerto}`, cerrar: () => new Promise((r) => { hijo.once('exit', r); hijo.kill('SIGTERM'); }) };
}

test('T1 Arranque_FaltaUnaVariable_NoArranca', () => {
  const secreto = H.llave();
  const casos = [
    ['sin SITE_SESSION_KEY', { SITE_SESSION_KEY: undefined }, 'SITE_SESSION_KEY'],
    ['llave de 16 bytes', { SITE_SESSION_KEY: 'x'.repeat(16) }, 'SITE_SESSION_KEY'],
    ['http a otro host', { SITE_PUBLIC_URL: 'http://site.acme.example' }, 'SITE_PUBLIC_URL'],
    ['sin credencial del repo', { SITE_OPERATIONS_TOKEN: undefined }, 'SITE_OPERATIONS_TOKEN'],
    ['proveedor desconocido', { SITE_AUTH_PROVIDER: 'saml' }, 'SITE_AUTH_PROVIDER'],
    ['repo con credencial en la dirección', { SITE_OPERATIONS_REPO: 'https://u:p@git.acme.example/ops.git' }, 'SITE_OPERATIONS_REPO'],
  ];
  for (const [caso, cambio, variable] of casos) {
    const env = { ...H.envBase({ SITE_OIDC_CLIENT_SECRET: secreto, SITE_OPERATIONS_TOKEN: `tok-${secreto.slice(0, 8)}` }), ...cambio };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const r = arrancarProceso(env);
    assert.strictEqual(r.status, 1, caso);
    assert.match(r.salida, new RegExp(`${variable}: `), `${caso}: nombra la variable`);
    for (const v of [secreto, env.SITE_SESSION_KEY, env.SITE_OPERATIONS_TOKEN].filter((x) => x && x.length >= 8)) assert.ok(!r.salida.includes(v), `${caso}: ningún valor en la salida`);
  }
});

test('T2 Arranque_RegistroSinSecretos', async () => {
  const env = H.envBase({ SITE_SESSION_KEY: H.llave(), SITE_OIDC_CLIENT_SECRET: `sec-${H.llave()}`, SITE_OPERATIONS_TOKEN: `tok-${H.llave()}`, SITE_MAILBOX_SAS: H.sas(), SITE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'site-t2-')) });
  const p = await procesoVivo(env);
  try {
    await new Promise((r) => setTimeout(r, 300));
    const s = p.salida();
    for (const v of ['SITE_SESSION_KEY', 'SITE_OIDC_CLIENT_SECRET', 'SITE_OPERATIONS_TOKEN', 'SITE_MAILBOX_SAS']) assert.match(s, new RegExp(`${v}: presente`), v);
    for (const v of [env.SITE_SESSION_KEY, env.SITE_OIDC_CLIENT_SECRET, env.SITE_OPERATIONS_TOKEN, env.SITE_MAILBOX_SAS, new URLSearchParams(env.SITE_MAILBOX_SAS).get('sig')]) assert.ok(!s.includes(v), 'ningún secreto en el registro');
    // el `git clone` que el sitio lanzó puede seguir escribiendo un instante después de cerrarlo: el borrado reintenta
    // (cola de merge del 2026-10-16: ENOTEMPTY en operaciones/.git, al azar)
  } finally { await p.cerrar(); fs.rmSync(env.SITE_DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('T6 Imagen_DockerfileSinPrivilegiosNiPruebas', () => {
  const df = fs.readFileSync(path.join(SITE, 'Dockerfile'), 'utf8');
  const ign = fs.readFileSync(path.join(SITE, 'Dockerfile.dockerignore'), 'utf8');
  const from = df.match(/^FROM\s+(\S+)/m);
  assert.ok(from, 'FROM');
  assert.match(from[1], /^node:\d+(\.\d+){1,2}-alpine\d*(\.\d+)?(@sha256:[0-9a-f]{64})?$/, `Node LTS sobre Alpine con la versión fijada (es ${from[1]})`);
  assert.doesNotMatch(df, /node:latest|node:lts\b/);
  const user = df.match(/^USER\s+(\S+)/m);
  assert.ok(user && !/^(root|0)(:|$)/.test(user[1]), 'un usuario sin privilegios');
  assert.match(df, /^EXPOSE\s+8080\b/m);
  assert.match(df, /^HEALTHCHECK\b[\s\S]*\/livez/m, 'HEALTHCHECK contra /livez');
  assert.doesNotMatch(df.split('\n').filter((l) => /HEALTHCHECK|CMD .*wget|CMD .*node/.test(l)).join('\n'), /\/healthz/, 'nunca contra /healthz');
  assert.match(df, /apk add[^\n]*\bgit\b/, 'git adentro');
  assert.match(df, /skills\/tycon-pipeline\/steps\/step-0/, 'los títulos de los pasos adentro');
  assert.match(df, /ENV\s+[^\n]*TYCON_SKILLS_DIR=/, 'TYCON_SKILLS_DIR apuntando a ellos');
  assert.match(df, /CMD\s+\["node",\s*"scripts\/site\/server\.js"\]/, 'la misma orden que con Node solo');
  for (const p of ['scripts/tests', '.git', '**/*.pem', '**/*.key', '**/.env']) assert.ok(ign.split('\n').map((l) => l.trim()).includes(p), `${p} fuera de la imagen`);
  assert.doesNotMatch(df, /ARG\s+\S*(TOKEN|SECRET|KEY|SAS)|ENV\s+\S*(TOKEN|SECRET|SAS)/i, 'ningún secreto en la imagen');
  // /data nace del usuario del sitio ANTES de pasar a él, y es un VOLUME: un volumen con nombre nuevo hereda ese dueño
  // (2026-10-16: con `-v sitio-datos:/data` el volumen nacía de root y el sitio no podía clonar ni guardar: se frenaba)
  const iUser = df.search(/^USER\s+node\b/m);
  const iData = df.search(/^RUN\s+mkdir -p \/data && chown node:node \/data\b/m);
  assert.ok(iData >= 0 && iData < iUser, '/data con dueño node, antes del USER');
  assert.match(df, /^VOLUME\s+\/data\b/m, 'VOLUME /data');
  assert.match(df, /-v sitio-datos:\/data -e SITE_DATA_DIR=\/data/, 'la cabecera dice cómo montarlo');
});

/**
 * Todo lo que el sitio puede cargar, recorrido desde sus módulos y los lectores de Configuración: cada `require('./…')`
 * y cada `path.join(__dirname, '…')` que nombra un .js (también los que se cargan tarde, adentro de una función).
 */
function cargaDelSitio() {
  const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
  const raices = [];
  const recorrerDir = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) recorrerDir(p); else if (e.name.endsWith('.js')) raices.push(p); } };
  recorrerDir(SITE);
  // los lectores los busca loadReader por nombre: se piden de verdad y se toma el archivo que cargó
  for (const nombre of [...new Set([...ORG.SECCIONES.map((s) => s.lector), 'check-product-parity.js'])]) {
    const mod = ORG.loadReader(ROOT, nombre, {});
    if (nombre === 'thresholds') continue;
    assert.ok(mod, `el lector ${nombre} se encuentra en este árbol`);
    const f = Object.keys(require.cache).find((k) => require.cache[k].exports === mod);
    assert.ok(f, `el archivo del lector ${nombre}`);
    raices.push(f);
  }
  const vistos = new Set();
  const pila = [...raices];
  while (pila.length) {
    const f = pila.pop();
    if (vistos.has(f)) continue;
    vistos.add(f);
    const t = fs.readFileSync(f, 'utf8');
    const dir = path.dirname(f);
    const destinos = [];
    for (const m of t.matchAll(/require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) destinos.push(path.resolve(dir, m[1]));
    for (const m of t.matchAll(/path\.join\(\s*__dirname\s*((?:,\s*'[^']*'\s*)+)\)/g)) destinos.push(path.resolve(dir, ...[...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])));
    for (const d of destinos) {
      const js = fs.existsSync(d) && fs.statSync(d).isFile() ? d : (fs.existsSync(`${d}.js`) ? `${d}.js` : null);
      if (js && js.endsWith('.js') && js.startsWith(ROOT + path.sep) && !js.includes(`${path.sep}tests${path.sep}`)) pila.push(js);
    }
  }
  return [...vistos].map((f) => path.relative(ROOT, f).split(path.sep).join('/')).sort();
}

test('T6b Imagen_TodoLoQueCargaElSitioEstaAdentro — cada archivo que el sitio carga lo copia el Dockerfile y lo deja pasar su lista', () => {
  const df = fs.readFileSync(path.join(SITE, 'Dockerfile'), 'utf8');
  const ign = fs.readFileSync(path.join(SITE, 'Dockerfile.dockerignore'), 'utf8');
  const aRegex = (pat) => new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}${pat.endsWith('/') ? '' : '$'}`);
  const copias = df.split('\n').filter((l) => /^COPY\s/.test(l)).flatMap((l) => l.trim().split(/\s+/).slice(1, -1)).filter((x) => !x.startsWith('--')).map(aRegex);
  const pasan = ign.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('!')).map((l) => aRegex(l.slice(1)));
  const archivos = cargaDelSitio();
  assert.ok(archivos.includes('scripts/site/server.js') && archivos.includes('scripts/ci/check-product-parity.js'), `el recorrido encuentra el servidor y el lector de la paridad: ${archivos.join(', ')}`);
  const sinCopiar = archivos.filter((f) => !copias.some((r) => r.test(f)));
  const sinPasar = archivos.filter((f) => !pasan.some((r) => r.test(f)));
  assert.deepStrictEqual(sinCopiar, [], 'el sitio carga estos archivos y el Dockerfile no los copia');
  assert.deepStrictEqual(sinPasar, [], 'el sitio carga estos archivos y Dockerfile.dockerignore no los deja entrar');
});

test('T7 Codigo_SinValoresDeUnaOrganizacion', () => {
  const archivos = [];
  const recorrer = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) recorrer(p); else archivos.push(p); } };
  recorrer(SITE);
  recorrer(path.join(ROOT, 'scripts', 'nightly', 'assigned'));
  // el único GUID admitido es el id PÚBLICO de la aplicación de Azure DevOps en Entra (el mismo para todas las organizaciones)
  const GUID_PUBLICO = new Set(['499b84ac-1321-427f-aa17-267ca6975798']);
  const terminos = (() => {
    const deny = path.join(ROOT, 'scripts', 'publishing', 'denylist.json');
    if (!fs.existsSync(deny)) return [];
    try { const d = JSON.parse(fs.readFileSync(deny, 'utf8')); return (Array.isArray(d.terms) ? d.terms : []).map((t) => (typeof t === 'string' ? t : t && t.term)).filter((t) => typeof t === 'string' && t.length >= 4); } catch { return []; }
  })();
  const malos = [];
  for (const f of archivos) {
    const t = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    for (const m of t.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g)) if (!/\.example$/i.test(m[0]) && !/@sha256/.test(m[0])) malos.push(`${rel}: correo ${m[0]}`);
    for (const m of t.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) if (!GUID_PUBLICO.has(m[0].toLowerCase())) malos.push(`${rel}: GUID ${m[0]}`);
    for (const m of t.matchAll(/\b([a-z0-9]{3,24})\.blob\.core\.windows\.net/gi)) malos.push(`${rel}: cuenta de almacenamiento ${m[1]}`);
    for (const m of t.matchAll(/dev\.azure\.com\/([A-Za-z0-9_.-]+)/g)) malos.push(`${rel}: organización de Azure DevOps ${m[1]}`);
    for (const m of t.matchAll(/github\.com\/([A-Za-z0-9-]+)\//g)) malos.push(`${rel}: organización de GitHub ${m[1]}`);
    for (const term of terminos) if (t.toLowerCase().includes(term.toLowerCase())) malos.push(`${rel}: un nombre de la lista privada`);
  }
  assert.deepStrictEqual(malos, [], 'ningún valor de una organización en el código del sitio');
  if (!terminos.length) console.log('# T7: la lista privada de nombres no está en esta copia (público): se miden sólo las formas');
});

test('T19 Rutas_SinDeclaracion_NoArranca', () => {
  const fuentes = H.fuentesFijas();
  assert.throws(() => crearSitio({ env: H.envBase(), fuentes, log: () => {}, rutasExtra: [{ method: 'GET', path: '/abierta', handler: () => ({ status: 200, cuerpo: 'x' }) }] }), /\/abierta.*needs/);
  assert.throws(() => crearSitio({ env: H.envBase(), fuentes, log: () => {}, rutasExtra: [{ method: 'GET', path: '/rara', needs: ['todos'], handler: () => ({}) }] }), /\/rara/);
  const ok = crearSitio({ env: H.envBase(), fuentes, log: () => {}, rutasExtra: [{ method: 'GET', path: '/nueva', needs: ['maintainer'], handler: () => ({ status: 200, cuerpo: '' }) }] });
  assert.ok(ok.rutas.some((r) => r.path === '/nueva'), 'con su declaración, entra a la tabla');
});

test('T33 PrimerMantenedor_SoloSinLista', async () => {
  const A = 'a@acme.example';
  const Bm = 'b@acme.example';
  const sinLista = { version: 1, owners: { default: 'x@acme.example' } };
  const conLista = { ...sinLista, site: { maintainers: [Bm] } };
  // (a) sin lista y con la variable: a es mantenedor, nadie más
  assert.strictEqual(access.quienPide({ email: A, sub: 's' }, { config: sinLista, firstMaintainer: A }).rol, 'maintainer');
  assert.strictEqual(access.quienPide({ email: Bm, sub: 's' }, { config: sinLista, firstMaintainer: A }).rol, 'none');
  assert.strictEqual(access.quienPide({ email: A, sub: 's' }, { config: { ...sinLista, site: { maintainers: [] } }, firstMaintainer: A }).rol, 'maintainer', 'lista vacía = sin lista');
  // (b) con lista: la variable no cuenta, y quien mantiene ve el aviso
  assert.strictEqual(access.quienPide({ email: A, sub: 's' }, { config: conLista, firstMaintainer: A }).rol, 'none');
  const b = access.quienPide({ email: Bm, sub: 's' }, { config: conLista, firstMaintainer: A });
  assert.deepStrictEqual([b.rol, b.variableSobrante], ['maintainer', true]);
  // (d) la variable con dos correos, vacía o con espacios: no arranca
  for (const v of ['a@acme.example,b@acme.example', '', 'a@acme.example b@acme.example', ' ']) {
    const r = validarConfiguracion(H.envBase({ SITE_FIRST_MAINTAINER: v }));
    assert.ok(r.problemas.some((p) => p.variable === 'SITE_FIRST_MAINTAINER'), JSON.stringify(v));
  }
  // por el servidor: el aviso en Inicio de b, y (c) la página «sin mantenedores» sin datos
  const emisor = await arrancarEmisor();
  const entrar = async (h, email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
  try {
    const h1 = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_FIRST_MAINTAINER: A }), fuentes: H.fuentesFijas({ config: conLista }) });
    try {
      assert.match((await h1.pedir('/', { cookie: await entrar(h1, Bm) })).texto, /la variable de arranque sigue puesta: sacala de la configuración de la instalación/);
      const a = await h1.pedir('/', { cookie: await entrar(h1, A) });
      assert.doesNotMatch(a.texto, /Qué decidir hoy/, 'a ya no es mantenedor');
    } finally { await h1.cerrar(); }
    const h2 = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer }), fuentes: H.fuentesFijas({ config: sinLista, modelo: { dependencias: { estado: 'medido', fecha: '2026-10-15', rubros: { nuevos: 9 } } } }) });
    try {
      const c = await h2.pedir('/', { cookie: await entrar(h2, A) });
      assert.strictEqual(c.status, 200);
      assert.match(c.texto, /este sitio todavía no tiene mantenedores: quien lo instaló tiene que poner SITE_FIRST_MAINTAINER/);
      assert.doesNotMatch(c.texto, /Dependencias|href="\/proyectos"/, 'sin datos');
    } finally { await h2.cerrar(); }
  } finally { await emisor.cerrar(); }
});

test('T39 Nucleo_SinNube', { skip: !hayHttpBackend() && !process.env.CI && 'git http-backend no está en esta máquina (en CI no se saltea)' }, async () => {
  // el texto: lo de una nube vive sólo en cloud/ y lo de un proveedor sólo en auth-providers/
  const malos = [];
  const recorrer = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!['cloud', 'auth-providers'].includes(e.name)) recorrer(p); } else if (!/^Dockerfile/.test(e.name)) { const t = fs.readFileSync(p, 'utf8'); for (const w of ['azure', 'microsoft', 'windows.net', 'IDENTITY_ENDPOINT', 'X-MS-']) if (t.toLowerCase().includes(w.toLowerCase())) malos.push(`${path.relative(SITE, p)}: ${w}`); } } };
  recorrer(SITE);
  assert.deepStrictEqual(malos, []);
  // y el arranque real sin ninguna variable de una nube: oidc, el repo con token y el buzón con SAS
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'site-t39-'));
  const token = `tok-${require('crypto').randomBytes(6).toString('hex')}`;
  repoConArchivos(raiz, 'ops.git', H.archivosDeOperaciones({ config: { version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'] } } }), path.join(raiz, 'trabajo'));
  const git = await arrancarRepoHttp({ raiz, cabecera: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` });
  const emisor = await arrancarEmisor();
  let p = null;
  try {
    p = await procesoVivo(H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_OPERATIONS_REPO: git.url('ops.git'), SITE_OPERATIONS_TOKEN: token, SITE_MAILBOX_SAS: H.sas(), SITE_DATA_DIR: path.join(raiz, 'data') }));
    let listo = 0;
    for (let i = 0; i < 200 && listo !== 200; i++) { listo = (await H.pedirA(p.base, '/readyz')).status; if (listo !== 200) await new Promise((r) => setTimeout(r, 100)); }
    assert.strictEqual(listo, 200, `leyó las fuentes: ${p.salida()}`);
    assert.ok(git.pedidos.some((x) => x.conCabecera), 'leyó el repo de operaciones con su credencial');
    assert.strictEqual((await H.pedirA(p.base, '/healthz')).status, 200);
    assert.strictEqual((await H.pedirA(p.base, '/')).status, 302, 'sin sesión, al emisor');
  } finally { if (p) await p.cerrar(); await git.cerrar(); await emisor.cerrar(); fs.rmSync(raiz, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('T42 Vida_NoDependeDelFreno', async () => {
  const frenado = H.fuentesFijas({ frenado: { desde: Date.parse('2026-10-15T00:00:00Z') } });
  const cargando = H.fuentesFijas({ cargado: false });
  for (const [caso, fuentes, esperado] of [['frenado', frenado, { healthz: 503, readyz: 200 }], ['cargando', cargando, { healthz: 200, readyz: 503 }]]) {
    const h = await H.arrancarSitio({ env: H.envBase(), fuentes });
    try {
      const vida = await h.pedir('/livez');
      assert.deepStrictEqual([vida.status, vida.json], [200, { ok: true }], `${caso}: /livez`);
      const hz = await h.pedir('/healthz');
      assert.strictEqual(hz.status, esperado.healthz, `${caso}: /healthz`);
      if (caso === 'frenado') assert.match(hz.json.motivo, /^la configuración de la organización no valida desde /);
      assert.strictEqual((await h.pedir('/readyz')).status, esperado.readyz, `${caso}: /readyz`);
    } finally { await h.cerrar(); }
  }
});

// story 2.28 (AC 10): el sitio que arranca con operations.json roto y sin último bueno se frena enseguida, para todos
test('T29 2.28-Healthz_FrenadoSinUltimoBueno', { skip: !hayHttpBackend() && !process.env.CI && 'git http-backend no está en esta máquina (en CI no se saltea)' }, async () => {
  const sources = require(path.join(SITE, 'sources.js'));
  const LEAD = 'lead@acme.example';
  // roto en `people`: una máquina sin forma de carpeta y sin `person`
  const roto = { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] }, people: { machines: { 'MAQ ROTA': { confirmed_by: LEAD } } } };
  for (const primero of [null, 'first@acme.example']) {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'site-t29-'));
    const token = `tok-${require('crypto').randomBytes(6).toString('hex')}`;
    repoConArchivos(raiz, 'ops.git', H.archivosDeOperaciones({ config: roto }), path.join(raiz, 'trabajo'));
    const git = await arrancarRepoHttp({ raiz, cabecera: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` });
    const emisor = await arrancarEmisor();
    const env = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_OPERATIONS_REPO: git.url('ops.git'), SITE_OPERATIONS_TOKEN: token, ...(primero ? { SITE_FIRST_MAINTAINER: primero } : {}) });
    const registro = [];
    const fuentes = sources.crearFuentes({ cfg: validarConfiguracion(env).cfg, dataDir: path.join(raiz, 'data'), log: (l) => registro.push(l) });
    let h = null;
    try {
      await fuentes.refrescar();
      const e = fuentes.estado();
      assert.ok(e.frenado, `sin último bueno: freno inmediato (${primero || 'sin primer mantenedor'})`);
      h = await H.arrancarSitio({ env, fuentes });
      const hz = await h.pedir('/healthz');
      assert.strictEqual(hz.status, 503);
      assert.match(hz.json.motivo, /^la configuración de la organización no valida desde \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/, 'sólo desde cuándo: sin rutas ni nombres del archivo');
      // la sesión de quien mantendría (el primer mantenedor, o el de la lista rota): ninguna ruta trae datos
      const s = (await H.ingresar(h, emisor, { sub: 's', email: primero || LEAD, email_verified: true })).sesion;
      for (const r of h.sitio.rutas) {
        const res = await h.pedir(r.path, { cookie: s, method: r.method });
        assert.strictEqual(res.status, 503, `${r.path} frenada`);
        assert.doesNotMatch(res.texto, /MAQ ROTA|people\.machines|operations\.json|Producto X/, `${r.path}: sin datos, rutas ni nombres del archivo`);
      }
      assert.match((await h.pedir('/', { cookie: s })).texto, /el sitio está frenado desde .*: la configuración de la organización no valida; se destraba cuando un refresco la lee bien/);
      assert.match(registro.join('\n'), /people\.machines/, 'el registro del servidor trae la ruta de cada problema');
    } finally { if (h) await h.cerrar(); fuentes.detener(); await git.cerrar(); await emisor.cerrar(); fs.rmSync(raiz, { recursive: true, force: true }); }
  }
});
