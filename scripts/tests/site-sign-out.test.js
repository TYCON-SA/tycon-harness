'use strict';
/*
 * site-sign-out.test.js — «Salir» cierra la sesión de verdad: la lista de sesiones cerradas y el control del botón.
 *
 * T1 Salir_CopiaDeLaCookie_NoEntra                 T2 Salir_OtraSesion_SigueAndando
 * T3 ListaDeCerradas_SeBorraAlVencer               T4 Salir_OtroOrigenOSinToken_403
 * T5 Salir_ElBoton_MandaElToken                    T8 Salir_DiscoQueFalla_AvisaQueNoSeInvalido
 * T9 Cerradas_DosCierresALaVez_NingunoSePierde      T10 Cerradas_ArchivoIlegible_SigueCerrada
 * T11 Salir_SinDisco_Avisa                          T12 Salir403_TraeSalirConElTokenVigente
 * T13 Cerradas_ConsultaNoRecorreLaLista
 *
 * El sitio corre en este proceso contra un emisor OIDC local; el disco es una carpeta temporal.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const H = require('./lib/site-harness.js');

const session = require(path.join(H.SITE, 'session.js'));
const LEAD = 'lead@acme.example';
const ORIGEN = 'http://127.0.0.1';
const config = () => ({ version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] } });
const FORM = 'application/x-www-form-urlencoded';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'site-sign-out-'));
const limpiar = (d) => { try { fs.chmodSync(d, 0o700); } catch { /* ya no está */ } fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };

const sitioSobre = (emisor, dataDir) => H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_DATA_DIR: dataDir, SITE_SESSION_KEY: llaveFija }), fuentes: H.fuentesFijas({ config: config() }) });
// la misma llave en el sitio que arranca de nuevo: la cookie de antes sigue siendo válida
const llaveFija = H.llave();
const entrar = async (h, emisor, sub = 's-lead') => (await H.ingresar(h, emisor, { sub, email: LEAD, email_verified: true })).sesion;
/** El token que la barra pone en el formulario de «Salir». */
const tokDeLaBarra = async (h, cookie) => {
  const p = await h.pedir('/', { cookie });
  const m = /<form class="salir"[^>]*>[\s\S]*?<input type="hidden" name="tok" value="([^"]+)"/.exec(p.texto);
  return m ? m[1] : null;
};
const salir = (h, cookie, tok, headers = {}) => h.pedir('/auth/logout', { method: 'POST', cookie, headers: { origin: ORIGEN, 'content-type': FORM, ...headers }, body: tok === null ? '' : new URLSearchParams({ tok }).toString() });
const sinSesion = async (h, cookie, etiqueta) => {
  const p = await h.pedir('/', { cookie });
  assert.strictEqual(p.status, 302, `${etiqueta}: la página va al emisor`);
  const a = await h.pedir('/api/inicio', { cookie, headers: { accept: 'application/json' } });
  assert.strictEqual(a.status, 401, `${etiqueta}: la API contesta 401`);
};

test('T1 Salir_CopiaDeLaCookie_NoEntra @story-2.48 @ac-1', async () => {
  const emisor = await arrancarEmisor();
  const dir = tmp();
  let h = await sitioSobre(emisor, dir);
  try {
    const copia = await entrar(h, emisor);
    const tok = await tokDeLaBarra(h, copia);
    assert.ok(tok, 'la barra trae el token');
    assert.strictEqual((await h.pedir('/', { cookie: copia })).status, 200, 'antes de salir entra');
    const r = await salir(h, copia, tok);
    assert.strictEqual(r.status, 303);
    await sinSesion(h, copia, 'tras salir');
    await h.cerrar();
    h = await sitioSobre(emisor, dir);
    await sinSesion(h, copia, 'tras reiniciar');
    const nombres = fs.readdirSync(path.join(dir, session.CARPETA_CERRADAS));
    assert.strictEqual(nombres.length, 1, 'un archivo por sesión cerrada');
    assert.ok(!nombres.join('\n').includes(tok) && !fs.readFileSync(path.join(dir, session.CARPETA_CERRADAS, nombres[0]), 'utf8').includes(tok), 'el token no está en claro en el disco');
  } finally { await h.cerrar(); await emisor.cerrar(); limpiar(dir); }
});

test('T2 Salir_OtraSesion_SigueAndando @story-2.48 @ac-2', async () => {
  const emisor = await arrancarEmisor();
  const dir = tmp();
  const h = await sitioSobre(emisor, dir);
  try {
    const a = await entrar(h, emisor);
    const b = await entrar(h, emisor);
    assert.notStrictEqual(a, b);
    assert.strictEqual((await salir(h, a, await tokDeLaBarra(h, a))).status, 303);
    await sinSesion(h, a, 'la que salió');
    assert.strictEqual((await h.pedir('/', { cookie: b })).status, 200, 'la otra sigue');
  } finally { await h.cerrar(); await emisor.cerrar(); limpiar(dir); }
});

test('T3 ListaDeCerradas_SeBorraAlVencer @story-2.48 @ac-3', () => {
  const dir = tmp();
  try {
    let t = 1000000;
    const cerradas = session.crearCerradas({ dataDir: dir, ahora: () => t, log: () => {} });
    const ses = { tok: 'tok-de-prueba', exp: t + 8 * 3600 * 1000 };
    assert.strictEqual(cerradas.cerrar(ses), true);
    assert.strictEqual(cerradas.cerrada(ses), true);
    const carpeta = path.join(dir, session.CARPETA_CERRADAS);
    assert.strictEqual(fs.readdirSync(carpeta).length, 1);
    t = ses.exp + 1;
    // otra sesión que se cierra después poda las vencidas del disco
    assert.strictEqual(cerradas.cerrar({ tok: 'otro-tok', exp: t + 1000 }), true);
    const en = fs.readdirSync(carpeta);
    assert.strictEqual(en.length, 1, 'sólo la viva');
    assert.ok(!en.includes(crypto.createHash('sha256').update('tok-de-prueba').digest('hex')));
    assert.strictEqual(cerradas.cerrada(ses), false, 'la vencida ya no está en la lista');
  } finally { limpiar(dir); }
});

test('T4 Salir_OtroOrigenOSinToken_403 @story-2.48 @ac-4', async () => {
  const emisor = await arrancarEmisor();
  const dir = tmp();
  const h = await sitioSobre(emisor, dir);
  try {
    const cookie = await entrar(h, emisor);
    const tok = await tokDeLaBarra(h, cookie);
    const otra = await entrar(h, emisor);
    const tokAjeno = await tokDeLaBarra(h, otra);
    const casos = [
      ['otro origen', await salir(h, cookie, tok, { origin: 'https://otro.example' })],
      ['sin el token', await salir(h, cookie, null)],
      ['con el token de otra sesión', await salir(h, cookie, tokAjeno)],
    ];
    for (const [caso, r] of casos) {
      assert.strictEqual(r.status, 403, caso);
      assert.ok(!r.cookies['__Host-site'], `${caso}: no borra la cookie`);
    }
    assert.strictEqual((await h.pedir('/', { cookie })).status, 200, 'la sesión sigue');
    assert.strictEqual((await h.pedir('/', { cookie: otra })).status, 200, 'la otra también');
  } finally { await h.cerrar(); await emisor.cerrar(); limpiar(dir); }
});

test('T5 Salir_ElBoton_MandaElToken @story-2.48 @ac-5', async () => {
  const emisor = await arrancarEmisor();
  const dir = tmp();
  const h = await sitioSobre(emisor, dir);
  try {
    const cookie = await entrar(h, emisor);
    const tok = await tokDeLaBarra(h, cookie);
    assert.ok(tok, 'el formulario trae el campo oculto');
    const r = await salir(h, cookie, tok);
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.location, '/saliste');
    assert.match(String(r.headers['set-cookie']), /__Host-site=;|Max-Age=0/);
    const otra = await entrar(h, emisor);
    const detras = await salir(h, otra, await tokDeLaBarra(h, otra), { 'X-MS-CLIENT-PRINCIPAL-NAME': LEAD });
    assert.strictEqual(detras.status, 303);
    assert.strictEqual(detras.headers.location, '/saliste', 'detrás del candado también se queda en el sitio');
    // sin sesión no se exige el token
    const sin = await h.pedir('/auth/logout', { method: 'POST', headers: { origin: ORIGEN } });
    assert.strictEqual(sin.status, 303);
    assert.strictEqual(sin.headers.location, '/saliste');
  } finally { await h.cerrar(); await emisor.cerrar(); limpiar(dir); }
});

test('T8 Salir_DiscoQueFalla_AvisaQueNoSeInvalido @story-2.48 @ac-8', async (t) => {
  const emisor = await arrancarEmisor();
  const dir = tmp();
  const h = await sitioSobre(emisor, dir);
  try {
    const cookie = await entrar(h, emisor);
    const tok = await tokDeLaBarra(h, cookie);
    fs.chmodSync(dir, 0o500);
    try { fs.writeFileSync(path.join(dir, 'sonda'), 'x'); fs.rmSync(path.join(dir, 'sonda')); t.skip('esta cuenta escribe aunque la carpeta no tenga permiso'); return; } catch { /* sin permiso, como se necesita */ }
    const r = await salir(h, cookie, tok);
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.location, '/saliste?sin_invalidar=1');
    assert.match(String(r.headers['set-cookie']), /__Host-site=;|Max-Age=0/, 'la cookie igual se borra');
    const lineas = h.registro.filter((l) => l.includes('la lista de sesiones cerradas no se pudo escribir'));
    assert.ok(lineas.length >= 1, 'una línea en el registro');
    assert.ok(!lineas.join('\n').includes(LEAD), 'sin el correo');
    assert.ok(!h.registro.join('\n').includes(tok), 'sin el token');
    const es = await h.pedir('/saliste?sin_invalidar=1', { headers: { 'accept-language': 'es' } });
    assert.ok(es.texto.includes('no se pudo invalidar en el servidor'), 'el aviso en castellano');
    const en = await h.pedir('/saliste?sin_invalidar=1', { headers: { 'accept-language': 'en' } });
    assert.ok(en.texto.includes('could not be invalidated on the server'), 'el aviso en inglés');
    const comun = await h.pedir('/saliste', { headers: { 'accept-language': 'es' } });
    assert.ok(!comun.texto.includes('no se pudo invalidar'), 'sin el parámetro, la página de siempre');
  } finally { await h.cerrar(); await emisor.cerrar(); limpiar(dir); }
});

test('T9 Cerradas_DosCierresALaVez_NingunoSePierde @story-2.48 @ac-1', async () => {
  const dir = tmp();
  try {
    const t = 1000000;
    const exp = t + 8 * 3600 * 1000;
    // dos réplicas (dos procesos) sobre el mismo disco cierran 150 sesiones cada una, a la vez
    const hijo = (prefijo) => new Promise((resolve, reject) => {
      const codigo = `const s=require(${JSON.stringify(path.join(H.SITE, 'session.js'))});const c=s.crearCerradas({dataDir:${JSON.stringify(dir)},ahora:()=>${t},log:()=>{}});let mal=0;for(let i=0;i<150;i++)if(c.cerrar({tok:${JSON.stringify(prefijo)}+i,exp:${exp}})!==true)mal++;process.exit(mal?1:0);`;
      require('child_process').execFile(process.execPath, ['-e', codigo], (err, so, se) => (err ? reject(new Error(`${prefijo}: ${err.code} ${se}`)) : resolve()));
    });
    await Promise.all([hijo('a-'), hijo('b-')]);
    const c = session.crearCerradas({ dataDir: dir, ahora: () => t, log: () => {} });
    for (const p of ['a-', 'b-']) for (let i = 0; i < 150; i++) assert.strictEqual(c.cerrada({ tok: `${p}${i}`, exp }), true, `${p}${i} cerrada`);
    assert.strictEqual(fs.readdirSync(path.join(dir, session.CARPETA_CERRADAS)).length, 300, 'ni un archivo de más ni de menos');
    const modo = fs.statSync(path.join(dir, session.CARPETA_CERRADAS, crypto.createHash('sha256').update('a-0').digest('hex'))).mode & 0o777;
    assert.strictEqual(modo, 0o600);
  } finally { limpiar(dir); }
});

test('T10 Cerradas_ArchivoIlegible_SigueCerrada @story-2.48 @ac-1', () => {
  const dir = tmp();
  try {
    const t = 1000000;
    const log = [];
    const cerradas = session.crearCerradas({ dataDir: dir, ahora: () => t, log: (l) => log.push(l) });
    const rota = { tok: 'sesion-rota', exp: t + 1000 };
    const sana = { tok: 'sesion-sana', exp: t + 1000 };
    const otra = { tok: 'sesion-sin-archivo', exp: t + 1000 };
    assert.strictEqual(cerradas.cerrar(rota), true);
    assert.strictEqual(cerradas.cerrar(sana), true);
    // el contenido de una sola sesión se rompe
    fs.writeFileSync(path.join(dir, session.CARPETA_CERRADAS, crypto.createHash('sha256').update('sesion-rota').digest('hex')), '{ no es un número');
    assert.strictEqual(cerradas.cerrada(rota), true, 'con el archivo roto sigue cerrada');
    assert.strictEqual(cerradas.cerrada(sana), true);
    assert.strictEqual(cerradas.cerrada(otra), false, 'una sesión sin archivo entra');
    assert.strictEqual(cerradas.cerrar(otra), true, 'y puede salir');
    assert.strictEqual(cerradas.cerrada(otra), true);
    // un archivo vacío o con un número que no es un vencimiento tampoco la reabre (Number('') es 0, no un vencimiento)
    for (const [tok, contenido] of [['sesion-vacia', ''], ['sesion-cero', '0'], ['sesion-espacios', '  \n'], ['sesion-negativa', '-5']]) {
      const s = { tok, exp: t + 1000 };
      assert.strictEqual(cerradas.cerrar(s), true);
      const archivo = path.join(dir, session.CARPETA_CERRADAS, crypto.createHash('sha256').update(tok).digest('hex'));
      fs.writeFileSync(archivo, contenido);
      assert.strictEqual(cerradas.cerrada(s), true, `con el contenido ${JSON.stringify(contenido)} sigue cerrada`);
      assert.ok(fs.existsSync(archivo), `con el contenido ${JSON.stringify(contenido)} el archivo no se borra`);
    }
  } finally { limpiar(dir); }
});

test('T11 Salir_SinDisco_Avisa @story-2.48 @ac-8', async () => {
  const emisor = await arrancarEmisor();
  const h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_SESSION_KEY: llaveFija }), fuentes: H.fuentesFijas({ config: config() }) });
  try {
    const cookie = await entrar(h, emisor);
    const r = await salir(h, cookie, await tokDeLaBarra(h, cookie));
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.location, '/saliste?sin_invalidar=1', 'sin disco no se puede decir que se invalidó');
    await sinSesion(h, cookie, 'en este proceso igual bloquea');
    const t = 1000000;
    const cerradas = session.crearCerradas({ ahora: () => t, log: () => {} });
    assert.strictEqual(cerradas.cerrar({ tok: 'x', exp: t + 1000 }), false, 'sin carpeta, cerrar devuelve false');
    assert.strictEqual(cerradas.cerrada({ tok: 'x', exp: t + 1000 }), true, 'pero la memoria bloquea');
  } finally { await h.cerrar(); await emisor.cerrar(); }
});

test('T12 Salir403_TraeSalirConElTokenVigente @story-2.48 @ac-4', async () => {
  const emisor = await arrancarEmisor();
  const dir = tmp();
  const h = await sitioSobre(emisor, dir);
  try {
    const cookie = await entrar(h, emisor);
    const vigente = await tokDeLaBarra(h, cookie);
    const r = await salir(h, cookie, 'token-de-una-pestana-vieja');
    assert.strictEqual(r.status, 403);
    const m = /<form class="salir"[^>]*>[\s\S]*?<input type="hidden" name="tok" value="([^"]+)"/.exec(r.texto);
    assert.ok(m, 'la página del 403 trae el formulario «Salir»');
    assert.strictEqual(m[1], vigente, 'con el token vigente');
    // y ese formulario sirve: sale de verdad
    assert.strictEqual((await salir(h, cookie, m[1])).status, 303);
    await sinSesion(h, cookie, 'tras salir con el formulario del 403');
  } finally { await h.cerrar(); await emisor.cerrar(); limpiar(dir); }
});

test('T13 Cerradas_ConsultaNoRecorreLaLista @story-2.48 @ac-1', (t) => {
  const dir = tmp();
  try {
    const ahora = 1000000;
    const cerradas = session.crearCerradas({ dataDir: dir, ahora: () => ahora, log: () => {} });
    const carpeta = path.join(dir, session.CARPETA_CERRADAS);
    const viva = { tok: 'viva', exp: ahora + 1000 };
    assert.strictEqual(cerradas.cerrar({ tok: 'otra', exp: ahora + 1000 }), true);
    for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(carpeta, crypto.createHash('sha256').update(`relleno-${i}`).digest('hex')), String(ahora + 1000));
    const lee = t.mock.method(fs, 'readdirSync');
    const abre = t.mock.method(fs, 'readFileSync');
    assert.strictEqual(cerradas.cerrada(viva), false);
    assert.strictEqual(cerradas.cerrada({ tok: 'relleno-7', exp: ahora + 1000 }), true);
    assert.strictEqual(lee.mock.callCount(), 0, 'consultar no lista la carpeta');
    assert.ok(abre.mock.callCount() <= 1, `consultar lee a lo sumo el archivo de esa sesión (leyó ${abre.mock.callCount()})`);
  } finally { limpiar(dir); }
});

test('T14 Cerradas_CarpetaIlegible_AvisaAQuienMantiene @story-2.48 @ac-9', async (t) => {
  // la carpeta de la lista sin permiso: la sesión entra (se abre, no se cierra), quien mantiene lo ve arriba de las
  // pestañas, una persona no, y el sitio sin sesión no cuenta nada nuevo
  const PERSONA = 'ana@acme.example';
  const conPersona = { ...config(), people: { machines: { 'mac-ana': { person: PERSONA, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' } } } };
  const emisor = await arrancarEmisor();
  const dir = tmp();
  const h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_DATA_DIR: dir, SITE_SESSION_KEY: llaveFija }), fuentes: H.fuentesFijas({ config: conPersona }) });
  const carpeta = path.join(dir, session.CARPETA_CERRADAS);
  try {
    const lead = await entrar(h, emisor);
    const ana = (await H.ingresar(h, emisor, { sub: 's-ana', email: PERSONA, email_verified: true })).sesion;
    const sano = await h.pedir('/', { cookie: lead, headers: { 'accept-language': 'es' } });
    assert.ok(!sano.texto.includes('no se pueden verificar las sesiones cerradas'), 'con la carpeta sana, sin aviso');
    fs.mkdirSync(carpeta, { recursive: true });
    fs.chmodSync(carpeta, 0o000);
    try { fs.statSync(path.join(carpeta, 'sonda')); } catch (e) { if (e.code === 'ENOENT') { t.skip('esta cuenta lee aunque la carpeta no tenga permiso'); return; } }
    const es = await h.pedir('/', { cookie: lead, headers: { 'accept-language': 'es' } });
    assert.strictEqual(es.status, 200, 'la sesión entra: se abre, no se cierra');
    assert.ok(es.texto.includes('no se pueden verificar las sesiones cerradas'), 'el aviso en castellano');
    const en = await h.pedir('/', { cookie: lead, headers: { 'accept-language': 'en' } });
    assert.ok(/closed sessions cannot be verified/i.test(en.texto), 'el aviso en inglés');
    const persona = await h.pedir('/', { cookie: ana, headers: { 'accept-language': 'es' } });
    assert.strictEqual(persona.status, 200, 'la persona entra');
    assert.ok(!/no está en la lista|sin rol/i.test(persona.texto), 'la persona ve su página, no la de sin rol');
    assert.ok(!persona.texto.includes('no se pueden verificar las sesiones cerradas'), 'una persona no lo ve');
    const salud = await h.pedir('/healthz');
    assert.deepStrictEqual(salud.json, { ok: true }, 'sin sesión no se cuenta nada nuevo');
    assert.ok(h.registro.some((l) => l.includes('la lista de sesiones cerradas no se pudo leer')), 'una línea en el registro');
  } finally { try { fs.chmodSync(carpeta, 0o700); } catch { /* no se creó */ } await h.cerrar(); await emisor.cerrar(); limpiar(dir); }
});
