'use strict';
/*
 * site-language.test.js — el idioma del sitio: de dónde sale en cada pedido, dónde se recuerda y cómo se cambia.
 *
 * T1 Idioma_PrimeraVez_DelNavegador          T4 Idioma_Post_CandadoYVuelta
 * T2 Idioma_ElOrden_PersonaCookieNavegador   T5 Idioma_SelectorEnTodasLasPaginas
 * T3 Idioma_SeGuardaPorHuella_SinCorreo      T6 Idioma_SinVolumen_ValeLaCookie
 * T11 Idioma_SalirDeLaLista_BorraLaPreferencia
 *
 * Sin red: el emisor de inicio de sesión es local (lib/fake-oidc.js) y el sitio corre en el proceso (lib/site-harness.js).
 * Correos inventados.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const H = require('./lib/site-harness.js');

const LANG = () => require(path.join(H.SITE, 'language.js'));
const HELP = require(path.join(H.SITE, 'help.js'));
const MANTIENE = 'lead@acme.example';
const PERSONA = 'ana@acme.example';
const OTRA = 'bruno@acme.example';
const FUERA = 'nadie@acme.example';
const acceso = (devs = [PERSONA, OTRA]) => ({ version: 1, owners: { default: MANTIENE }, site: { access: [{ emails: [MANTIENE], role: 'maintainer' }, ...devs.map((d) => ({ emails: [d], role: 'dev' }))] } });

const temporales = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temporales.push(d); return d; };
test.after(() => { for (const d of temporales) fs.rmSync(d, { recursive: true, force: true }); });

/** El sitio con la ayuda; `entrar(correo)` da la cookie de una sesión real. `datos`: SITE_DATA_DIR (null = sin volumen). */
async function conSitio({ datos = tmp('site-idioma-'), config = acceso(), fuentes = null } = {}, fn) {
  const emisor = await arrancarEmisor();
  const f = fuentes || H.fuentesFijas({ config });
  const h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, ...(datos ? { SITE_DATA_DIR: datos } : {}) }), fuentes: f, rutasExtra: HELP.crearRutas({}) });
  try {
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    await fn({ h, entrar, fuentes: f, datos });
  } finally { await h.cerrar(); await emisor.cerrar(); }
}

/** Elegir un idioma con el formulario del selector. */
const elegir = (h, idioma, { cookie, volver = '/', origin = 'http://127.0.0.1' } = {}) => h.pedir('/idioma', {
  method: 'POST', cookie,
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
  body: new URLSearchParams({ idioma, volver }).toString(),
});
const langDe = (texto) => (/<html lang="([a-z]+)"/.exec(texto) || [])[1];
const cookieIdioma = (r) => r.cookies['sitio-idioma'];
const juntar = (...cs) => cs.filter(Boolean).join('; ');

test('T1 Idioma_PrimeraVez_DelNavegador @story-2.42 @ac-3', () => {
  const L = LANG();
  const casos = [['en-US,en;q=0.9', 'en'], ['es-AR', 'es'], ['fr', 'es'], ['fr;q=1, en;q=0.5', 'en'], ['', 'es'], [undefined, 'es'], ['@@@;q=x,,', 'es'],
    ['en;q=0.2, es;q=0.8', 'es'], ['es;q=0, en', 'en'], ['EN-gb', 'en']];
  for (const [al, esperado] of casos) assert.strictEqual(L.elegir({ navegador: al }), esperado, `Accept-Language «${al}»`);
  // nunca se arma un idioma con lo que mandó el navegador
  assert.strictEqual(L.elegir({ navegador: 'xx' }), 'es');
  assert.deepStrictEqual(L.IDIOMAS, ['es', 'en']);
});

test('T2 Idioma_ElOrden_PersonaCookieNavegador @story-2.42 @ac-2 @ac-3', () => {
  const L = LANG();
  assert.strictEqual(L.elegir({ persona: 'en', cookie: 'es', navegador: 'es' }), 'en', 'gana la persona');
  assert.strictEqual(L.elegir({ persona: 'es', cookie: 'en', navegador: 'en' }), 'es', 'gana la persona');
  assert.strictEqual(L.elegir({ persona: null, cookie: 'en', navegador: 'es' }), 'en', 'después la cookie');
  assert.strictEqual(L.elegir({ cookie: 'zz', navegador: 'en-US' }), 'en', 'una cookie desconocida no cuenta');
  assert.strictEqual(L.elegir({ persona: 'zz', cookie: null, navegador: 'en' }), 'en', 'una preferencia desconocida no cuenta');
  assert.strictEqual(L.elegir({}), 'es', 'sin nada, castellano');
});

test('T3 Idioma_SeGuardaPorHuella_SinCorreo @story-2.42 @ac-2 @ac-3', async () => {
  await conSitio({}, async ({ h, entrar, datos }) => {
    // la primera vez, del navegador, y no se guarda nada
    const a = await entrar(PERSONA);
    const primera = await h.pedir('/', { cookie: a, headers: { 'accept-language': 'en-US,en;q=0.9' } });
    assert.strictEqual(langDe(primera.texto), 'en');
    assert.ok(!fs.existsSync(path.join(datos, 'idiomas.json')), 'sin elegir, no se guarda nada');
    // elige castellano con sesión: vuelve a la página y queda guardado
    const r = await elegir(h, 'es', { cookie: a, volver: '/ayuda' });
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.location, '/ayuda');
    // otra sesión de la misma persona, otro navegador en inglés y sin cookie: ve su idioma guardado
    const b = await entrar(PERSONA);
    const otra = await h.pedir('/', { cookie: b, headers: { 'accept-language': 'en-US' } });
    assert.strictEqual(langDe(otra.texto), 'es', 'la preferencia sigue a la persona');
    const crudo = fs.readFileSync(path.join(datos, 'idiomas.json'), 'utf8');
    assert.ok(!crudo.includes(PERSONA) && !crudo.includes('ana'), `sin el correo ni su parte local: ${crudo}`);
    const doc = JSON.parse(crudo);
    assert.deepStrictEqual(Object.values(doc), ['es']);
    for (const k of Object.keys(doc)) assert.match(k, /^[0-9a-f]{64}$/, 'la clave es una huella');
    // otra persona sigue con lo suyo
    const c = await entrar(OTRA);
    assert.strictEqual(langDe((await h.pedir('/', { cookie: c, headers: { 'accept-language': 'en' } })).texto), 'en');
  });
});

test('T4 Idioma_Post_CandadoYVuelta @story-2.42 @ac-6', async () => {
  await conSitio({}, async ({ h, entrar }) => {
    const a = await entrar(PERSONA);
    const ok = await elegir(h, 'en', { cookie: a, volver: '/proyectos' });
    assert.strictEqual(ok.status, 303);
    assert.strictEqual(ok.headers.location, '/proyectos');
    assert.strictEqual(cookieIdioma(ok).valor, 'en');
    assert.match(cookieIdioma(ok).crudo, /SameSite=Lax/);
    assert.match(cookieIdioma(ok).crudo, /Path=\//);
    // otro origen: 403 y nada cambia
    const otro = await elegir(h, 'es', { cookie: a, origin: 'https://otro.example' });
    assert.strictEqual(otro.status, 403);
    assert.ok(!cookieIdioma(otro), 'sin cookie nueva');
    assert.strictEqual(langDe((await h.pedir('/', { cookie: juntar(a, 'sitio-idioma=en') })).texto), 'en', 'sigue en inglés');
    // sin origen y sin referer del sitio: 403
    assert.strictEqual((await elegir(h, 'es', { cookie: a, origin: null })).status, 403);
    // con el referer del sitio (sin Origin), vale
    const conReferer = await h.pedir('/idioma', { method: 'POST', cookie: a, headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'http://127.0.0.1/arnes' }, body: 'idioma=es&volver=%2Farnes' });
    assert.strictEqual(conReferer.status, 303);
    // una vuelta que no es una ruta propia vuelve a /
    for (const v of ['https://otro.example/x', '//otro.example', '/\\otro.example', 'javascript:alert(1)', '', 'proyectos']) {
      const r = await elegir(h, 'en', { cookie: a, volver: v });
      assert.strictEqual(r.status, 303, v);
      assert.strictEqual(r.headers.location, '/', `vuelta «${v}»`);
    }
    // un idioma desconocido no cambia nada
    const xx = await elegir(h, 'xx', { cookie: a, volver: '/proyectos' });
    assert.strictEqual(xx.status, 303);
    assert.ok(!cookieIdioma(xx), 'un idioma desconocido no deja cookie');
    // sólo POST
    assert.strictEqual((await h.pedir('/idioma?idioma=en', { cookie: a })).status, 405);
    // sin sesión también se puede elegir (la cookie)
    const sin = await elegir(h, 'en', { volver: '/' });
    assert.strictEqual(sin.status, 303);
    assert.strictEqual(cookieIdioma(sin).valor, 'en');
  });
});

/** Las marcas del selector en una página: el formulario, sus dos botones y cuál está marcado. */
function selector(texto) {
  const f = /<form class="idioma"[^>]*method="post"[^>]*action="\/idioma"[^>]*>([\s\S]*?)<\/form>/.exec(texto);
  if (!f) return null;
  const marcado = (/<button[^>]*name="idioma"[^>]*value="([a-z]+)"[^>]*aria-pressed="true"/.exec(f[1]) || [])[1];
  return { marcado, botones: [...f[1].matchAll(/<button[^>]*name="idioma"[^>]*value="([a-z]+)"/g)].map((m) => m[1]), volver: (/name="volver" value="([^"]*)"/.exec(f[1]) || [])[1] };
}

test('T5 Idioma_SelectorEnTodasLasPaginas @story-2.42 @ac-1', async () => {
  const fuentes = H.fuentesFijas({ config: acceso() });
  await conSitio({ fuentes }, async ({ h, entrar }) => {
    const lead = await entrar(MANTIENE);
    const ana = await entrar(PERSONA);
    const fuera = await entrar(FUERA);
    for (const idioma of ['es', 'en']) {
      const ck = `sitio-idioma=${idioma}`;
      const paginas = [
        ['/', lead], ['/proyectos', lead], ['/arnes', lead], ['/arnes/tablero', lead], ['/ayuda', lead], ['/no-existe', lead],
        ['/', ana], ['/arnes', ana], ['/ayuda', ana],
        ['/', fuera],
      ];
      for (const [ruta, ses] of paginas) {
        const r = await h.pedir(ruta, { cookie: juntar(ses, ck) });
        assert.strictEqual(langDe(r.texto), idioma, `${ruta}: <html lang>`);
        const s = selector(r.texto);
        assert.ok(s, `${ruta} (${idioma}): sin el selector`);
        assert.deepStrictEqual(s.botones, ['es', 'en']);
        assert.strictEqual(s.marcado, idioma, `${ruta}: el actual, marcado`);
        assert.strictEqual(s.volver, ruta, `${ruta}: vuelve a la misma página`);
      }
    }
    // frenado y cargando también
    fuentes.st.frenado = { desde: Date.parse('2026-10-15T10:00:00Z') };
    const fr = await h.pedir('/', { cookie: juntar(lead, 'sitio-idioma=en') });
    assert.strictEqual(fr.status, 503);
    assert.strictEqual(langDe(fr.texto), 'en');
    assert.strictEqual(selector(fr.texto).marcado, 'en');
    fuentes.st.frenado = null; fuentes.st.cargado = false; fuentes.st.navegable = false;
    const ca = await h.pedir('/', { cookie: juntar(lead, 'sitio-idioma=en') });
    assert.strictEqual(ca.status, 503);
    assert.strictEqual(selector(ca.texto).marcado, 'en');
    fuentes.st.cargado = true; fuentes.st.navegable = true;
    // el selector anda sin JavaScript: es un formulario con botones de envío
    const html = (await h.pedir('/', { cookie: lead })).texto;
    assert.match(html, /<form class="idioma"[^>]*method="post"[^>]*action="\/idioma"/);
    assert.match(html, /<button type="submit" name="idioma" value="es"[^>]*>Español<\/button>/);
    assert.match(html, /<button type="submit" name="idioma" value="en"[^>]*>English<\/button>/);
  });
  // el estilo: junto al tema, en claro, oscuro y teléfono
  const css = fs.readFileSync(path.join(H.SITE, 'static', 'site.css'), 'utf8');
  assert.match(css, /\.idioma\b/);
  assert.match(css, /prefers-color-scheme: dark|data-theme="dark"|\[data-tema="dark"\]/);
});

test('T6 Idioma_SinVolumen_ValeLaCookie @story-2.42 @ac-2', async () => {
  await conSitio({ datos: null }, async ({ h, entrar }) => {
    const a = await entrar(PERSONA);
    const r = await elegir(h, 'en', { cookie: a });
    assert.strictEqual(r.status, 303);
    const ck = `sitio-idioma=${cookieIdioma(r).valor}`;
    assert.strictEqual(langDe((await h.pedir('/', { cookie: juntar(a, ck), headers: { 'accept-language': 'es' } })).texto), 'en', 'la cookie mantiene el idioma');
    await elegir(h, 'es', { cookie: a });
    const lineas = h.registro.filter((l) => /idioma/i.test(l) && /SITE_DATA_DIR/.test(l));
    assert.strictEqual(lineas.length, 1, `una sola línea en el registro: ${h.registro.join('\n')}`);
  });
});

test('T11 Idioma_SalirDeLaLista_BorraLaPreferencia @story-2.42 @ac-2', async () => {
  const fuentes = H.fuentesFijas({ config: acceso() });
  await conSitio({ fuentes }, async ({ h, entrar, datos }) => {
    await elegir(h, 'en', { cookie: await entrar(PERSONA) });
    await elegir(h, 'en', { cookie: await entrar(OTRA) });
    const archivo = path.join(datos, 'idiomas.json');
    assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(archivo, 'utf8'))).length, 2);
    // Ana sale de la lista; el sitio lee la lista nueva
    fuentes.st.config = acceso([OTRA]);
    await h.pedir('/', { cookie: await entrar(MANTIENE) });
    const doc = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    assert.strictEqual(Object.keys(doc).length, 1, 'queda sólo la de Bruno');
    for (const [k, v] of Object.entries(doc)) { assert.match(k, /^[0-9a-f]{64}$/); assert.strictEqual(v, 'en'); }
    // Bruno sigue viendo su idioma desde otro navegador
    assert.strictEqual(langDe((await h.pedir('/', { cookie: await entrar(OTRA), headers: { 'accept-language': 'es' } })).texto), 'en');
  });
});

test('T4b Idioma_VueltaFueraDeAscii_NoEsError @story-2.42 @ac-6 — el caso que encontró el pase adversarial', async () => {
  await conSitio({}, async ({ h }) => {
    for (const v of ['/arnes€', '/proyectos?q=ñ', '/a b']) {
      const r = await elegir(h, 'en', { volver: v });
      assert.strictEqual(r.status, 303, `vuelta «${v}»: ${r.status}`);
      assert.strictEqual(r.headers.location, '/', `vuelta «${v}»`);
    }
  });
});

test('T5b Idioma_SelectorEnCorridasYConfiguracion @story-2.42 @ac-1', async () => {
  const emisor = await arrancarEmisor();
  const f = H.fuentesFijas({ config: acceso() });
  f.dirBuzon = tmp('site-idioma-buzon-'); f.hilos = () => false; f.clones = () => ({ operaciones: null, perfil: null });
  f.alRefrescar = () => {}; f.buzonEstado = () => ({ completo: true, generacion: 1 }); f.exclusivo = (fn) => fn();
  const env = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer });
  const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
  const cfg = validarConfiguracion(env).cfg;
  const rutas = [...require(path.join(H.SITE, 'tabs', 'runs.js')).crearRutas({ cfg, fuentes: f, skillsDir: path.join(H.SITE, '..', '..', 'skills') }), ...require(path.join(H.SITE, 'tabs', 'config.js')).crearRutas({ cfg, fuentes: f })];
  const h = await H.arrancarSitio({ env, fuentes: f, rutasExtra: rutas });
  try {
    const lead = (await H.ingresar(h, emisor, { sub: 's-lead', email: MANTIENE, email_verified: true })).sesion;
    for (const idioma of ['es', 'en']) {
      for (const ruta of ['/corridas', '/configuracion']) {
        const r = await h.pedir(ruta, { cookie: `${lead}; sitio-idioma=${idioma}` });
        assert.strictEqual(langDe(r.texto), idioma, `${ruta}: ${r.status}`);
        const s = selector(r.texto);
        assert.ok(s && s.marcado === idioma && s.volver === ruta, `${ruta} (${idioma}): el selector`);
      }
    }
  } finally { await h.cerrar(); await emisor.cerrar(); }
});

test('T11b Idioma_ArchivoIlegible_NoSePisa @story-2.42 @ac-2', () => {
  const L = LANG();
  const datos = tmp('site-idioma-roto-');
  const archivo = path.join(datos, 'idiomas.json');
  fs.writeFileSync(archivo, '{ roto');
  const registro = [];
  const p = L.crearPreferencias({ dataDir: datos, llave: Buffer.alloc(32, 7), log: (l) => registro.push(l) });
  // elegir con el archivo ilegible: vale en este arranque, no se escribe encima, y se dice una vez
  assert.strictEqual(p.guardar(PERSONA, 'en'), false);
  assert.strictEqual(p.leer([PERSONA]), 'en', 'la elección vale aunque no se guardó');
  assert.strictEqual(fs.readFileSync(archivo, 'utf8'), '{ roto', 'no se pisa el archivo de todos');
  assert.strictEqual(p.podar([PERSONA]), -1, 'la poda no puede: se vuelve a probar');
  p.guardar(OTRA, 'en');
  assert.strictEqual(registro.filter((l) => /no se pudieron leer/.test(l)).length, 1, registro.join('\n'));
  // cuando el archivo vuelve a leerse, lo elegido mientras tanto se guarda encima de lo que había
  const h = (c) => require('crypto').createHmac('sha256', Buffer.alloc(32, 7)).update(c).digest('hex');
  fs.writeFileSync(archivo, JSON.stringify({ [h(FUERA)]: 'es' }));
  assert.strictEqual(p.guardar(PERSONA, 'es'), true);
  const doc = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  assert.deepStrictEqual(doc, { [h(FUERA)]: 'es', [h(PERSONA)]: 'es', [h(OTRA)]: 'en' });
  // sin poder escribir (la carpeta sin permiso), la elección vale en este arranque y se dice
  if (process.platform !== 'win32' && !(process.getuid && process.getuid() === 0)) {
    fs.chmodSync(datos, 0o500);
    try {
      assert.strictEqual(p.guardar(PERSONA, 'en'), false);
      assert.strictEqual(p.leer([PERSONA]), 'en');
      assert.ok(registro.some((l) => /no se pudo guardar el idioma/.test(l)), registro.join('\n'));
    } finally { fs.chmodSync(datos, 0o700); }
  }
});
