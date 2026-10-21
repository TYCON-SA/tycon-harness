'use strict';
/*
 * site-access.test.js — quién es quién en el sitio de la organización y qué ve cada uno.
 *
 * T14 Identidad_NoSaleDeCabeceras      T18 Rol_SinRol_PaginaSinDatos     T43 Corridas_CarpetaNuevaYViejas
 * T17 Rol_SeRecalculaEnCadaPedido      T20 Filtro_QueEsDeQuien
 *
 * Y las de la regla de quién es quién, que el sitio toma de scripts/lib/people.js:
 * T26 2.28-Rol_PersonaSaleDePeople     T27 2.28-Modelo_ProyectosEInicioDesdeDondeTrabaja
 * T44 2.28-Config_BandaSoloMantenedores_YFrenoA24h
 *
 * Las de reglas puras van contra access.js; las de rol, contra el servidor real con el emisor local.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const H = require('./lib/site-harness.js');

const access = require(path.join(H.SITE, 'access.js'));
const sha = (c) => crypto.createHash('sha256').update(c.trim().toLowerCase()).digest('hex');
const A = 'dev.a@acme.example';
const B = 'dev.b@acme.example';
const LEAD = 'lead@acme.example';

const opsBase = (extra = {}) => ({ version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] }, ...extra });
const persona = (email) => ({ email, sub: `s-${email}` });

async function conSitio(fuentes, fn) {
  const emisor = await arrancarEmisor();
  let h = null;
  try {
    h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer }), fuentes });
    await fn({ emisor, h, entrar: async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion });
  } finally { if (h) await h.cerrar(); await emisor.cerrar(); }
}

test('T14 Identidad_NoSaleDeCabeceras', async () => {
  await conSitio(H.fuentesFijas({ config: opsBase() }), async ({ h }) => {
    const principal = Buffer.from(JSON.stringify({ userDetails: LEAD, userRoles: ['authenticated'], claims: [{ typ: 'email', val: LEAD }] })).toString('base64');
    const headers = { 'x-ms-client-principal': principal, 'x-ms-client-principal-name': LEAD, 'x-forwarded-user': LEAD, 'x-forwarded-email': LEAD, 'x-auth-request-email': LEAD };
    for (const ruta of ['/', '/arnes', '/proyectos']) assert.strictEqual((await h.pedir(ruta, { headers })).status, 302, `${ruta} sigue sin sesión`);
    assert.strictEqual((await h.pedir('/api/inicio', { headers })).status, 401);
  });
});

test('T17 Rol_SeRecalculaEnCadaPedido', async () => {
  const fuentes = H.fuentesFijas({ config: opsBase({ site: { maintainers: [LEAD, A] } }) });
  await conSitio(fuentes, async ({ h, entrar }) => {
    const s = await entrar(A);
    assert.strictEqual((await h.pedir('/arnes', { cookie: s })).status, 200, 'mantenedor: ve Arnés');
    fuentes.st.config = opsBase();   // el refresco trae la lista sin A
    const r = await h.pedir('/arnes', { cookie: s });
    assert.doesNotMatch(r.texto, /Cómo está el arnés/, 'la misma cookie ya no abre Arnés');
    assert.doesNotMatch(r.texto, /href="\/arnes"/, 'ni dibuja la pestaña');
    assert.match((await h.pedir('/', { cookie: s })).texto, /Tu cuenta no está en la lista/, 'sin rol: la página sin datos');
  });
});

test('T18 Rol_SinRol_PaginaSinDatos', async () => {
  const config = opsBase({ people: { machines: { 'maq-a-1a2b3c4d': { person: B, reported_sha256: sha(B), confirmed_by: LEAD, confirmed_on: '2026-10-15' } } } });
  const modelo = {
    corridas: { estado: 'medido', fecha: '2026-10-15', lista: [{ maquina: 'maq-a-1a2b3c4d', inicio: '2026-10-15T10:00:00Z', marca: 'CORRIDA-DE-B' }] },
    proyectos: { estado: 'medido', fecha: '2026-10-15', lista: [{ proyecto: 'Proyecto X', repo: 'Repo X', stories: [] }] },
    productos: [{ producto: 'Producto X', proyectos: ['Proyecto X'] }],
  };
  // la máquina informa otro correo: caída («cambio»). Lo informado llega aparte del modelo
  const personas = { informados: H.informados({ 'maq-a-1a2b3c4d': 'otra.persona@acme.example' }), repos: null };
  await conSitio(H.fuentesFijas({ config, modelo, personas }), async ({ h, entrar }) => {
    const sinRol = await h.pedir('/', { cookie: await entrar(A) });
    assert.strictEqual(sinRol.status, 200);
    assert.match(sinRol.texto, /Esa cuenta no está en la lista de quién entra a este sitio/);
    for (const marca of ['Producto X', 'Proyecto X', LEAD, B, 'CORRIDA-DE-B']) assert.ok(!sinRol.texto.includes(marca), `sin datos ni nombres: ${marca}`);
    assert.doesNotMatch(sinRol.texto, /href="\/proyectos"/, 'sin pestañas');
    // B tiene una entrada, pero su única máquina está caída: es persona, sin corridas de esa máquina
    const sB = await entrar(B);
    const iniB = await h.pedir('/', { cookie: sB });
    assert.match(iniB.texto, /href="\/proyectos"/, 'B tiene las pestañas de persona');
    assert.doesNotMatch(iniB.texto, /href="\/arnes"/);
    assert.ok(!iniB.texto.includes('CORRIDA-DE-B'));
    assert.strictEqual(access.quienPide(persona(B), { config }).rol, 'person');
    assert.strictEqual(access.crearReglas({ config, modelo, personas }).maquina('maq-a-1a2b3c4d').estado, 'cambio');
  });
});

test('T20 Filtro_QueEsDeQuien', () => {
  const config = opsBase({
    people: {
      machines: {
        'maq-a-11111111': { person: A, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-15' },
        'maq-b-22222222': { person: B, reported_sha256: sha(B), confirmed_by: LEAD, confirmed_on: '2026-10-15' },
      },
    },
  });
  const modelo = {
    corridas: { estado: 'medido', fecha: '2026-10-15', lista: [
      { maquina: 'maq-a-11111111', inicio: '2026-10-15T10:00:00Z' },
      { maquina: 'maq-b-22222222', inicio: '2026-10-15T11:00:00Z' },
      { maquina: 'maq-nueva-33333333', inicio: '2026-10-15T12:00:00Z' },
      { maquina: null, inicio: '2026-10-15T13:00:00Z' },
    ] },
    prs: { estado: 'medido', fecha: '2026-10-15', lista: [
      { numero: 1, proyecto: 'P', repo: 'R', dias: 3, autor: 'Dev.A@ACME.example', enlace: 'https://x.example/pr/1' },
      { numero: 2, proyecto: 'P', repo: 'R', dias: 4, autor: B, enlace: 'https://x.example/pr/2' },
    ] },
    pedidos: { estado: 'medido', fecha: '2026-10-15', lista: [
      { id: 10, proyecto: 'P', tipo: 'Bug', estado: 'Active', asignado: 'DEV.B@acme.example', dias: 2, enlace: 'https://x.example/wi/10', dependencias: true },
    ] },
  };
  const personas = { informados: H.informados({ 'maq-a-11111111': 'DEV.A@acme.example', 'maq-b-22222222': B, 'maq-nueva-33333333': null }), repos: null };
  const ve = (email, cfg = config) => {
    const quien = access.quienPide(persona(email), { config: cfg });
    return access.filtrar(modelo, quien, access.crearReglas({ config: cfg, modelo, personas }));
  };
  const mA = ve(A); const mB = ve(B); const mL = ve(LEAD);
  assert.deepStrictEqual(mA.corridas.lista.map((c) => c.maquina), ['maq-a-11111111'], 'A ve la suya (el correo informado en mayúsculas no la tira)');
  assert.deepStrictEqual(mB.corridas.lista.map((c) => c.maquina), ['maq-b-22222222']);
  assert.strictEqual(mL.corridas.lista.length, 4, 'quien mantiene ve las cuatro, también la sin confirmar y la sin máquina');
  assert.deepStrictEqual(mA.prs.lista.map((p) => p.numero), [1], 'mayúsculas en el autor no cambian nada');
  assert.deepStrictEqual(mB.pedidos.lista.map((p) => p.id), [10]);
  assert.deepStrictEqual(mA.pedidos.lista, []);
  // un pedido asignado a una identidad que no es el correo de A: sin alias, «no medido» con la frase; con alias, es de A
  const conPersonal = { ...modelo, prs: { ...modelo.prs, lista: [] }, pedidos: { ...modelo.pedidos, lista: [{ ...modelo.pedidos.lista[0], id: 11, asignado: 'a.personal@mail.example' }] } };
  const sinAlias = access.filtrar(conPersonal, access.quienPide(persona(A), { config }), access.crearReglas({ config, modelo: conPersonal, personas }));
  assert.strictEqual(sinAlias.pedidos.estado, 'no_medido');
  assert.match(sinAlias.pedidos.motivo, /tu identidad en la plataforma no es tu correo de la organización; pedile a quien mantiene que la asocie/);
  assert.strictEqual(sinAlias.pedidos.lista.length, 0);
  const cfgAlias = { ...config, people: { ...config.people, [A]: { identities: ['A.Personal@mail.example'] } } };
  const conAlias = access.filtrar(conPersonal, access.quienPide(persona(A), { config: cfgAlias }), access.crearReglas({ config: cfgAlias, modelo: conPersonal, personas }));
  assert.strictEqual(conAlias.pedidos.estado, 'medido');
  assert.deepStrictEqual(conAlias.pedidos.lista.map((p) => p.id), [11]);
  // A sin lista de proyectos: la frase
  assert.strictEqual(mA.proyectos.lista, null);
  assert.match(mA.proyectos.motivo, /quien mantiene todavía no te asignó productos/);
  // la persona nunca recibe la lista de máquinas sin confirmar
  assert.strictEqual(mA.maquinasSinConfirmar, undefined);
  assert.strictEqual(mL.maquinasSinConfirmar, 1, 'quien mantiene sabe cuántas máquinas sin confirmar hay');
});

test('T43 Corridas_CarpetaNuevaYViejas', () => {
  const config = opsBase({
    people: {
      machines: {
        'maq-1a2b3c4d': { person: A, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-15' },
        otra: { person: A, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-15' },
        vieja: { person: A, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-15' },
        maq: { person: A, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-15' },
      },
    },
  });
  const modelo = {
    corridas: { estado: 'medido', fecha: '2026-10-15', lista: [
      { maquina: 'maq-1a2b3c4d', inicio: '2026-10-15T10:00:00Z' },
      { maquina: 'maq', inicio: '2026-10-01T10:00:00Z' },
      { maquina: 'otra', inicio: '2026-10-02T10:00:00Z' },
      { maquina: 'vieja', inicio: '2026-10-03T10:00:00Z' },
    ] },
  };
  // la unión de carpetas llega con lo informado (people.js la calcula del espejo con carpetasDeMaquina), no del modelo
  const personas = { informados: H.informados({}, {
    maq: { estado: 'unida', nueva: 'maq-1a2b3c4d', declarantes: 1, desde: '2026-10-10' },
    otra: { estado: 'compartida', nueva: null, declarantes: 2, desde: null },
    vieja: { estado: 'siguio_recibiendo', nueva: null, declarantes: 1, desde: '2026-10-05' },
  }), repos: null };
  const filtra = (email, cfg) => access.filtrar(modelo, access.quienPide(persona(email), { config: cfg }), access.crearReglas({ config: cfg, modelo, personas }));
  assert.deepStrictEqual(filtra(A, config).corridas.lista.map((c) => c.maquina).sort(), ['maq', 'maq-1a2b3c4d'], 'la nueva y su vieja unida');
  assert.strictEqual(filtra(LEAD, config).corridas.lista.length, 4);
  // la entrada con el nombre de la vieja unida no cuenta: sin la de la nueva, A no ve nada
  const soloVieja = opsBase({ people: { machines: { maq: config.people.machines.maq, otra: config.people.machines.otra } } });
  assert.deepStrictEqual(filtra(A, soloVieja).corridas.lista, []);
  const reglas = access.crearReglas({ config, modelo, personas });
  assert.strictEqual(reglas.maquina('otra').estado, 'compartida');
  assert.match(reglas.maquina('otra').motivo, /compartida por 2 máquinas/);
  // people.js da a las dos viejas que no se unen el estado `compartida`; el motivo dice cuál de las dos es
  assert.strictEqual(reglas.maquina('vieja').estado, 'compartida');
  assert.match(reglas.maquina('vieja').motivo, /siguió recibiendo después de la mudanza/);
  assert.strictEqual(reglas.maquina('maq').carpeta, 'maq-1a2b3c4d');
});

// ── la regla de quién es quién viene de people.js ─────────────────────────────────────────────────────
const people = require(path.join(H.SITE, '..', 'lib', 'people.js'));
const views = require(path.join(H.SITE, 'views.js'));
const sources = require(path.join(H.SITE, 'sources.js'));
const C = 'dev.c@acme.example';
const D = 'dev.d@acme.example';
// stable-data: el emisor de mentira firma con la hora real y el sitio de estas pruebas corre con su reloj de verdad; lo
// que se compara son plazos relativos a ahora (una corrida de hace una hora, una falla de hace 2 o 25 horas), nunca una
// fecha fija.
const haceHoras = (n, t = Date.now()) => t - n * 3600000;

test('T26 2.28-Rol_PersonaSaleDePeople', async () => {
  const config = opsBase({ people: { machines: {
    'maq-a-11111111': { person: A, reported_sha256: sha(A), confirmed_by: LEAD, confirmed_on: '2026-10-15' },
    'maq-c-33333333': { person: C, reported_sha256: sha(C), confirmed_by: LEAD, confirmed_on: '2026-10-15' },
  } } });
  // la máquina de C informa hoy OTRO correo: su única máquina queda en `cambio`
  const personas = { informados: H.informados({ 'maq-a-11111111': A, 'maq-c-33333333': 'otra.persona@acme.example' }), repos: null };
  const modelo = { corridas: { estado: 'medido', fecha: '2026-10-15', lista: [
    { maquina: 'maq-a-11111111', inicio: new Date(haceHoras(1)).toISOString() },
    { maquina: 'maq-c-33333333', inicio: new Date(haceHoras(2)).toISOString() },
  ] } };
  // la regla es la de people.js: el sitio no tiene una propia
  assert.strictEqual(access.esPersona, undefined, 'access.js ya no exporta su propio esPersona');
  assert.match(require('fs').readFileSync(path.join(H.SITE, 'access.js'), 'utf8'), /require\('\.\.\/lib\/people\.js'\)/);
  assert.deepStrictEqual([A, C, D].map((e) => access.quienPide(persona(e), { config }).rol), ['person', 'person', 'none'], 'persona = alguna entrada, confirmada o caída');
  assert.deepStrictEqual([A, C, D].map((e) => people.esPersona(e, people.contexto({ operations: config }))), [true, true, false]);

  const fuentes = H.fuentesFijas({ config, modelo, personas });
  await conSitio(fuentes, async ({ h, entrar }) => {
    const sA = await entrar(A); const sC = await entrar(C); const sD = await entrar(D);
    const iniA = await h.pedir('/', { cookie: sA });
    assert.match(iniA.texto, /1 ejecuciones en 7 días/, 'A ve la ejecución de su máquina confirmada');
    const iniC = await h.pedir('/', { cookie: sC });
    assert.match(iniC.texto, /href="\/proyectos"/, 'C es persona aunque su única máquina esté caída');
    assert.match(iniC.texto, /0 ejecuciones en 7 días/, 'de una máquina caída no ve nada');
    assert.match((await h.pedir('/', { cookie: sD })).texto, /Tu cuenta no está en la lista/, 'sin entrada: sin rol');
    // el primer refresco fallido fue hace 25 horas: freno para todos, la persona incluida
    const falla = haceHoras(25);
    Object.assign(fuentes.st, sources.estadoDelSitio({ hayUltimoBueno: true, fallaDesde: falla, fallaRutas: 'problemas en people.machines', ahora: Date.now() }));
    const frenada = await h.pedir('/', { cookie: sA });
    assert.strictEqual(frenada.status, 503);
    assert.ok(frenada.texto.includes(`el sitio está frenado desde ${views.hora(falla + 24 * 3600000)}: la configuración de la organización no valida; se destraba cuando un refresco la lee bien`), 'desde cuándo está frenado y el motivo');
    assert.doesNotMatch(frenada.texto, /ejecuciones en 7 días|people\.machines/, 'sin datos ni rutas del archivo');
  });
});

test('T27 2.28-Modelo_ProyectosEInicioDesdeDondeTrabaja', () => {
  const X = 'dev.x@acme.example';
  const OTRO = ['sin', 'confirmar@acme.example'].join('.');
  const config = opsBase({ people: {
    machines: {
      'maq-a-11111111': { person: A, reported_sha256: sha(A), confirmed_by: LEAD, confirmed_on: '2026-10-15' },
      'maq-x-22222222': { person: X, reported_sha256: sha(X), confirmed_by: LEAD, confirmed_on: '2026-10-15' },
    },
    projects: { [A]: { add: ['Gama'] } },
  } });
  const personas = {
    informados: H.informados({ 'maq-a-11111111': A, 'maq-x-22222222': X, 'maq-s1-33333333': OTRO, 'maq-s2-44444444': null }),
    repos: [
      { producto: 'Alfa', ruta: 'Alfa/Web', ado: 'Alfa/Web' },
      { producto: 'Beta', ruta: 'Beta/Front', ado: 'Beta/Front' },
      { producto: 'Gama', ruta: 'Gama/Front', ado: 'Gama/Front' },
    ],
  };
  const inicio = new Date(haceHoras(1)).toISOString();
  const modelo = {
    corridas: { estado: 'medido', fecha: '2026-10-15', lista: [
      // el sitio no baja los cambios de git: la corrida se ubica por la carpeta del volcado
      { maquina: 'maq-a-11111111', inicio, producto: 'Alfa/Web', cambio: null },
      { maquina: 'maq-x-22222222', inicio, producto: 'Zeta/Nada', cambio: null },
      { maquina: 'maq-s1-33333333', inicio, producto: 'Beta/Front', cambio: null },
      { maquina: 'maq-s2-44444444', inicio, producto: 'Beta/Front', cambio: null },
    ] },
    productos: [
      { producto: 'Alfa', proyectos: ['Alfa'], rutas: ['Alfa/Web'] },
      { producto: 'Beta', proyectos: ['Beta'], rutas: ['Beta/Front'] },
      { producto: 'Gama', proyectos: ['Gama'], rutas: ['Gama/Front'] },
    ],
    productosFuente: { estado: 'medido', codigo: null, motivo: null, fecha: '2026-10-15' },
    proyectos: { estado: 'medido', fecha: '2026-10-15', lista: [{ proyecto: 'Alfa', repo: 'Web' }, { proyecto: 'Beta', repo: 'Front' }, { proyecto: 'Gama', repo: 'Front' }] },
  };
  const ve = (email) => access.filtrar(modelo, access.quienPide(persona(email), { config }), access.crearReglas({ config, modelo, personas }));
  const mA = ve(A);
  // lo que ve la persona es sólo lo declarado; sus corridas en Alfa quedan como sugerencia para quien mantiene
  assert.deepStrictEqual(mA.productos.map((p) => p.producto), ['Gama'], 'Gama declarado; Alfa (sus ejecuciones) no decide');
  assert.deepStrictEqual(views.inicioDev(mA).proyectos, { estado: 'medido', lista: ['Gama'] }, 'la línea de proyectos del Inicio');
  assert.deepStrictEqual(views.filasProyectos(mA).filas.map((f) => f.producto), ['Gama'], 'la pestaña Proyectos');
  assert.deepStrictEqual(access.crearReglas({ config, modelo, personas }).sugeridosDe(A), ['Alfa'], 'Alfa, por sus ejecuciones, como sugerencia; Beta no');
  // X tiene corridas y nada declarado: la tabla cerrada con su frase, nunca todos los productos
  const mX = ve(X);
  assert.strictEqual(mX.proyectos.lista, null);
  assert.deepStrictEqual(mX.productos, []);
  assert.match(views.inicioDev(mX).proyectos.motivo, /quien mantiene todavía no te asignó productos/);
  // quien mantiene: la cuenta de máquinas sin confirmar con corridas (la de OTRO y la que no informa), sin correos
  const mL = ve(LEAD);
  assert.strictEqual(mL.maquinasSinConfirmar, 2);
  assert.match(views.paginaInicio({ modelo: mL, quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: Date.now() }), /Máquinas sin confirmar con ejecuciones[\s\S]*?t-val">2</);
  assert.ok(!JSON.stringify(mL).includes(OTRO) && !JSON.stringify(mA).includes(OTRO), 'ningún correo informado en el modelo');
});

// runs.js pasa la corrida de una carpeta vieja `unida` a su nueva; el sitio tiene que
// darle a people.js la carpeta DE ORIGEN, para que sus guardas (la vieja informa otro correo, o está confirmada para otra
// persona) se apliquen. Espejo real, uniones del bajador real, corridas con el lector del sitio.
test('2.28-R1 Union_QuePeopleRechaza_NoPasaLaCorridaALaNueva', () => {
  const fs = require('fs'); const os = require('os');
  const { huellaDeCorridas } = require(path.join(H.SITE, '..', 'metrics', 'upload-runs.js'));
  const { carpetasDeMaquina } = require(path.join(H.SITE, '..', 'metrics', 'download-runs.js'));
  const NUEVA = 'maq-a-1234abcd';
  function armar(ownerVieja) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-r1-'));
    const run = '9.1-2026-10-01T0900.json';
    const escribir = (rel, obj) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj)); };
    escribir(`maq-a/${run}`, { archivedAt: '2026-10-01T09:00:00Z', marker: { sessionId: 'sess-vieja', startedAt: '2026-10-01T09:00:00Z', repoPath: '/Users/u/SourceCode/Alfa/Web' } });
    escribir('maq-a/registros/place.json', { schema: 1, day: '2026-10-01', owner: { email: ownerVieja } });
    escribir(`${NUEVA}/9.2-2026-10-03T0900.json`, { archivedAt: '2026-10-03T09:00:00Z', marker: { sessionId: 'sess-nueva', startedAt: '2026-10-03T09:00:00Z', repoPath: '/Users/u/SourceCode/Beta/Front' } });
    escribir(`${NUEVA}/registros/place.json`, { schema: 1, day: '2026-10-02', owner: { email: B },
      folder: { name: NUEVA, code: '1234abcd', previous_folder: 'maq-a', moved_on: '2026-10-02', previous_runs_sha256: huellaDeCorridas([run]) } });
    const u = carpetasDeMaquina(dir, { hoy: '2026-10-16' });
    assert.ok(!u.no_medido, 'las uniones se calcularon');
    fs.writeFileSync(path.join(dir, '.carpetas-de-maquina.json'), JSON.stringify(u));
    return dir;
  }
  const casos = [
    ['la vieja confirmada para otra persona', A, { [NUEVA]: { person: B, reported_sha256: sha(B) }, 'maq-a': { person: A, reported_sha256: sha(A) } }, false],
    ['la vieja informa otro correo', A, { [NUEVA]: { person: B, reported_sha256: sha(B) } }, false],
    ['control: la vieja informa el mismo correo', B, { [NUEVA]: { person: B, reported_sha256: sha(B) } }, true],
  ];
  for (const [nombre, ownerVieja, machines, unida] of casos) {
    const dir = armar(ownerVieja);
    try {
      const config = opsBase({ people: { machines } });
      const modelo = { corridas: { ...sources.leerCorridas(dir), fecha: '2026-10-16' } };
      const personas = { informados: people.leerCorreosInformados(dir), repos: [{ producto: 'Alfa', ruta: 'Alfa/Web', ado: '' }, { producto: 'Beta', ruta: 'Beta/Front', ado: '' }] };
      const reglas = access.crearReglas({ config, modelo, personas });
      const deB = access.filtrar(modelo, access.quienPide(persona(B), { config }), reglas);
      assert.deepStrictEqual(deB.corridas.lista.map((c) => c.inicio.slice(0, 10)).sort(), unida ? ['2026-10-01', '2026-10-03'] : ['2026-10-03'], `${nombre}: las ejecuciones que ve B`);
      assert.deepStrictEqual(reglas.sugeridosDe(B), unida ? ['Alfa', 'Beta'] : ['Beta'], `${nombre}: los productos sugeridos para B`);
      const lead = access.filtrar(modelo, access.quienPide(persona(LEAD), { config }), reglas);
      assert.strictEqual(lead.corridas.lista.length, 2, `${nombre}: quien mantiene ve las dos`);
      assert.strictEqual(lead.maquinasSinConfirmar, unida ? 0 : 1, `${nombre}: la vieja que no se une es una máquina por confirmar`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

// Lo informado que no se pudo leer NO es «ninguna máquina informa nada» (falla hacia cerrar)
test('2.28-R2 Informados_SinLeer_FallaHaciaCerrar', () => {
  const config = opsBase({ people: { machines: { 'maq-a-11111111': { person: A, reported_sha256: sha(A) } }, projects: { [A]: { add: ['Gama'] } } } });
  const modelo = { corridas: { estado: 'medido', fecha: '2026-10-15', lista: [{ maquina: 'maq-a-11111111', inicio: new Date(haceHoras(1)).toISOString(), producto: 'Alfa/Web' }] },
    productos: [{ producto: 'Alfa', proyectos: ['Alfa'], rutas: ['Alfa/Web'] }, { producto: 'Gama', proyectos: ['Gama'], rutas: ['Gama/Front'] }] };
  const repos = [{ producto: 'Alfa', ruta: 'Alfa/Web', ado: '' }, { producto: 'Gama', ruta: 'Gama/Front', ado: '' }];
  const sinListar = { maquinas: {}, uniones: { schema: 1, carpetas: {}, regeneradas: {} }, no_medido: 'el espejo del buzón no se pudo listar (EACCES)' };
  // las máquinas leídas pero las uniones de carpetas sin calcular: una vieja compartida pasaría por carpeta propia
  const sinUniones = { maquinas: H.informados({ 'maq-a-11111111': A }).maquinas, uniones: { schema: 1, carpetas: {}, regeneradas: {}, no_medido: 'las uniones de carpetas no se pudieron calcular (EACCES)' } };
  for (const [nombre, informados] of [['sin leer (null)', null], ['el espejo no se pudo listar', sinListar], ['las uniones sin calcular', sinUniones]]) {
    const personas = { informados, repos };
    const reglas = access.crearReglas({ config, modelo, personas });
    const mA = access.filtrar(modelo, access.quienPide(persona(A), { config }), reglas);
    assert.deepStrictEqual(mA.corridas.lista, [], `${nombre}: la persona no ve ejecuciones que no se pueden verificar`);
    assert.deepStrictEqual(mA.productos.map((p) => p.producto), ['Gama'], `${nombre}: sus ejecuciones no ubican productos; lo agregado a mano sí cuenta`);
    const mL = access.filtrar(modelo, access.quienPide(persona(LEAD), { config }), reglas);
    assert.strictEqual(mL.corridas.lista.length, 1, `${nombre}: quien mantiene ve todo`);
    assert.strictEqual(mL.maquinasSinConfirmar, null, `${nombre}: la cuenta no se sabe`);
    const fila = views.filasInicioMantenedor(mL, { ahora: Date.now() }).find((f) => f.clave === 'maquinas_sin_confirmar');
    assert.deepStrictEqual([fila.estado, fila.valor], ['no_medido', null], `${nombre}: la fila dice «no medido», nunca 0`);
    assert.match(fila.motivo, /lo que informan las máquinas no se pudo leer/);
  }
});

// La deducción por pedidos asignados también llega por el sitio (el modelo trae `asignado` y `proyecto`)
test('2.28-R3 DondeTrabaja_PorPedidosAsignados', () => {
  const config = opsBase({ people: { machines: { 'maq-a-11111111': { person: A, reported_sha256: sha(A) } } } });
  const modelo = {
    corridas: { estado: 'medido', fecha: '2026-10-15', lista: [] },
    pedidos: { estado: 'medido', fecha: '2026-10-15', lista: [{ id: 1, proyecto: 'Gama', tipo: 'Bug', estado: 'Active', asignado: A.toUpperCase(), dias: 1 }, { id: 2, proyecto: 'Beta', tipo: 'Bug', estado: 'Active', asignado: B, dias: 1 }] },
    productos: [{ producto: 'Beta', proyectos: ['Beta'], rutas: [] }, { producto: 'Gama', proyectos: ['Gama'], rutas: [] }],
  };
  const personas = { informados: H.informados({ 'maq-a-11111111': A }), repos: [{ producto: 'Beta', ruta: 'Beta/Front', ado: 'Beta/Front' }, { producto: 'Gama', ruta: 'Gama/Front', ado: 'Gama/Front' }] };
  const reglas = access.crearReglas({ config, modelo, personas });
  assert.deepStrictEqual(reglas.sugeridosDe(A), ['Gama'], 'el pedido asignado a A (en mayúsculas) sugiere Gama; el de B no cuenta');
  assert.strictEqual(reglas.proyectosDe(A), null, 'una sugerencia no decide qué ve');
});

// El ayudante de las pruebas tiene la misma forma que el lector real
test('2.28-R4 Ayudante_InformadosConLaFormaDelLector', () => {
  const fs = require('fs'); const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-r4-'));
  try {
    fs.mkdirSync(path.join(dir, 'maq-a-11111111', 'registros'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'maq-a-11111111', 'x.json'), '{}');
    fs.writeFileSync(path.join(dir, 'maq-a-11111111', 'registros', 'place.json'), JSON.stringify({ day: '2026-10-15', owner: { email: A } }));
    fs.mkdirSync(path.join(dir, 'maq-b-22222222', 'registros'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'maq-b-22222222', 'x.json'), '{}');
    fs.writeFileSync(path.join(dir, 'maq-b-22222222', 'registros', 'place.json'), JSON.stringify({ day: '2026-10-15', owner: { reason: 'no informa correo' } }));
    const real = people.leerCorreosInformados(dir);
    const ayudante = H.informados({ 'maq-a-11111111': A, 'maq-b-22222222': null });
    assert.deepStrictEqual(Object.keys(ayudante).sort(), Object.keys(real).filter((k) => k !== 'no_medido').sort());
    assert.deepStrictEqual(ayudante.maquinas['maq-a-11111111'], real.maquinas['maq-a-11111111']);
    assert.deepStrictEqual(ayudante.maquinas['maq-b-22222222'], real.maquinas['maq-b-22222222']);
    assert.deepStrictEqual(Object.keys(ayudante.uniones).sort(), Object.keys(real.uniones).sort());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('T44 2.28-Config_BandaSoloMantenedores_YFrenoA24h', async () => {
  const config = opsBase({ people: { machines: { 'maq-a-11111111': { person: A, reported_sha256: sha(A), confirmed_by: LEAD, confirmed_on: '2026-10-15' } } } });
  const personas = { informados: H.informados({ 'maq-a-11111111': A }), repos: null };
  const modelo = { corridas: { estado: 'medido', fecha: '2026-10-15', lista: [{ maquina: 'maq-a-11111111', inicio: new Date(haceHoras(1)).toISOString() }] } };
  const fuentes = H.fuentesFijas({ config, modelo, personas });
  const falla = haceHoras(2);
  const rutasDelProblema = 'problemas en people.machines.maq-a-11111111';
  const fijar = (ahora, fallaDesde = falla) => Object.assign(fuentes.st, sources.estadoDelSitio({ hayUltimoBueno: true, fallaDesde, fallaRutas: rutasDelProblema, ahora }));
  await conSitio(fuentes, async ({ h, entrar }) => {
    const sL = await entrar(LEAD); const sA = await entrar(A);
    // a las 2 horas: vale el último bueno; la banda, sólo para quien mantiene, con la hora y las rutas
    fijar(Date.now());
    const iniL = await h.pedir('/', { cookie: sL });
    assert.ok(iniL.texto.includes(`la configuración de la organización no se pudo releer desde ${views.hora(falla)}: ${rutasDelProblema}`), 'la banda de quien mantiene');
    const iniA = await h.pedir('/', { cookie: sA });
    assert.doesNotMatch(iniA.texto, /no se pudo releer|people\.machines/, 'la persona no ve la banda');
    assert.match(iniA.texto, /1 ejecuciones en 7 días/, 'y sigue viendo lo suyo');
    assert.strictEqual((await h.pedir('/healthz')).status, 200);
    // a las 25 horas: nadie recibe datos, quien mantiene incluido; /healthz en falso con la hora del primer fallo
    fijar(falla + 25 * 3600000);
    for (const s of [sL, sA]) {
      const r = await h.pedir('/', { cookie: s });
      assert.strictEqual(r.status, 503);
      assert.ok(r.texto.includes(`el sitio está frenado desde ${views.hora(falla + 24 * 3600000)}`));
      assert.doesNotMatch(r.texto, /ejecuciones en 7 días|people\.machines|Máquinas sin confirmar/);
    }
    const hz = await h.pedir('/healthz');
    assert.deepStrictEqual([hz.status, hz.json], [503, { ok: false, motivo: `la configuración de la organización no valida desde ${views.hora(falla)}` }]);
    // un refresco bueno: todo de vuelta, sin banda
    fijar(Date.now(), null);
    const otraVez = await h.pedir('/', { cookie: sL });
    assert.strictEqual(otraVez.status, 200);
    assert.doesNotMatch(otraVez.texto, /no se pudo releer/);
    assert.match((await h.pedir('/', { cookie: sA })).texto, /1 ejecuciones en 7 días/);
    assert.strictEqual((await h.pedir('/healthz')).status, 200);
  });
});

// ── los productos de cada persona salen sólo de lo declarado en Configuración; lo deducido es una sugerencia ──────

/** Un mundo con tres productos, una persona A con una máquina confirmada, corridas en Alfa y un pedido asignado en Beta. */
function mundoDeclarado(projects) {
  const config = opsBase({ people: {
    machines: { 'maq-a-11111111': { person: A, reported_sha256: sha(A), confirmed_by: LEAD, confirmed_on: '2026-10-15' } },
    ...(projects ? { projects } : {}),
  } });
  const personas = { informados: H.informados({ 'maq-a-11111111': A }), repos: [
    { producto: 'Alfa', ruta: 'Alfa/Web', ado: 'Alfa/Web' }, { producto: 'Beta', ruta: 'Beta/Front', ado: 'Beta/Front' }, { producto: 'Gama', ruta: 'Gama/Front', ado: 'Gama/Front' },
  ] };
  const inicio = new Date(haceHoras(1)).toISOString();
  const modelo = {
    corridas: { estado: 'medido', fecha: '2026-10-15', lista: [{ maquina: 'maq-a-11111111', inicio, producto: 'Alfa/Web', cambio: null }] },
    prs: { estado: 'medido', fecha: '2026-10-15', lista: [{ numero: 7, proyecto: 'Beta', repo: 'Front', dias: 1, autor: A, enlace: null }] },
    pedidos: { estado: 'medido', fecha: '2026-10-15', lista: [{ id: 9, proyecto: 'Beta', tipo: 'Bug', estado: 'Active', asignado: A, dias: 1, enlace: null, dependencias: false, titulo: null }] },
    productos: [{ producto: 'Alfa', proyectos: ['Alfa'], rutas: ['Alfa/Web'] }, { producto: 'Beta', proyectos: ['Beta'], rutas: ['Beta/Front'] }, { producto: 'Gama', proyectos: ['Gama'], rutas: ['Gama/Front'] }],
    productosFuente: { estado: 'medido', codigo: null, motivo: null, fecha: '2026-10-15' },
    proyectos: { estado: 'medido', fecha: '2026-10-15', lista: [{ proyecto: 'Alfa', repo: 'Web' }, { proyecto: 'Beta', repo: 'Front' }, { proyecto: 'Gama', repo: 'Front' }] },
  };
  const reglas = access.crearReglas({ config, modelo, personas });
  return { config, modelo, reglas, ve: (email) => access.filtrar(modelo, access.quienPide(persona(email), { config }), reglas) };
}

test('T1 Productos_SoloLoDeclarado', () => {
  const { reglas, ve } = mundoDeclarado({ [A]: { add: ['Gama'] } });
  assert.deepStrictEqual(reglas.proyectosDe(A), ['Gama'], 'ni Alfa (sus ejecuciones) ni Beta (su pedido): sólo lo declarado');
  const mA = ve(A);
  assert.deepStrictEqual(mA.productos.map((p) => p.producto), ['Gama']);
  assert.deepStrictEqual(mA.proyectos.lista.map((p) => p.proyecto), ['Gama'], 'las fotos de proyectos, sólo las del declarado');
  assert.deepStrictEqual(views.filasProyectos(mA).filas.map((f) => f.producto), ['Gama'], 'la pestaña Proyectos');
  // lo deducido queda como sugerencia para quien mantiene, sin lo ya declarado
  assert.deepStrictEqual(reglas.sugeridosDe(A), ['Alfa', 'Beta']);
});

test('T2 Productos_SinDeclarar_Cerrado', () => {
  const { reglas, ve } = mundoDeclarado(null);
  assert.strictEqual(reglas.proyectosDe(A), null, 'sin nada declarado, ninguno: nunca todos');
  const mA = ve(A);
  assert.deepStrictEqual(mA.productos, []);
  assert.strictEqual(mA.proyectos.lista, null);
  assert.strictEqual(mA.proyectos.codigo, 'sin_donde_trabaja');
  assert.match(views.inicioDev(mA).proyectos.motivo, /quien mantiene todavía no te asignó productos/);
  assert.match(views.paginaProyectos({ modelo: mA, quien: { rol: 'person', email: A }, pestanas: [], ahora: Date.now() }), /quien mantiene todavía no te asignó productos/);
  assert.deepStrictEqual(reglas.sugeridosDe(A), ['Alfa', 'Beta'], 'lo deducido sigue disponible como sugerencia');
});

test('T3 Productos_DeclaradoInexistente_NoSale', () => {
  const { reglas, ve } = mundoDeclarado({ [A]: { add: ['Gama', 'Inexistente'] } });
  assert.deepStrictEqual(reglas.proyectosDe(A), ['Gama'], 'un producto que no está en la lista no se declara');
  assert.deepStrictEqual(ve(A).productos.map((p) => p.producto), ['Gama']);
  // un declarado con otro de sus correos (la persona entra con cualquiera de los suyos)
  const otro = mundoDeclarado({ [A.toUpperCase()]: { add: ['Beta'] } });
  assert.deepStrictEqual(otro.reglas.proyectosDe(A), ['Beta'], 'el correo de la clave sin distinguir mayúsculas');
});

// la vista de una persona recorta las fotos a las de sus productos, y «no usa stories del
// arnés» se perdería si ninguno de los suyos tuviera foto al día
test('T12 Producto_SinStories_TambienParaLaPersona', () => {
  const { config, modelo } = mundoDeclarado({ [A]: { add: ['Gama', 'Delta'] } });
  modelo.productos.push({ producto: 'Delta', proyectos: ['Delta'], rutas: ['Delta/Back'] });
  modelo.proyectos = { estado: 'medido', fecha: '2026-10-15', hay_al_dia: true, lista: [{ proyecto: 'Alfa', repo: 'Web', vieja: false, stories: [] }, { proyecto: 'Gama', repo: 'Front', vieja: true, fecha: '2026-10-01', stories: [] }] };
  const mA = access.filtrar(modelo, access.quienPide(persona(A), { config }), access.crearReglas({ config, modelo, personas: null }));
  const delta = views.filasProyectos(mA).filas.find((f) => f.producto === 'Delta');
  assert.strictEqual(delta.motivo, 'sus repos no usan stories del arnés', 'la persona ve lo mismo que quien mantiene');
});

// si todo lo declarado no existe, «no te asignó productos» sería falso
test('T13 Productos_DeclaradosInexistentes_LoDice', () => {
  const { ve } = mundoDeclarado({ [A]: { add: ['Inexistente'] } });
  const mA = ve(A);
  assert.deepStrictEqual(mA.productos, []);
  assert.strictEqual(mA.proyectos.codigo, 'declarados_inexistentes');
  assert.match(views.inicioDev(mA).proyectos.motivo, /lo que te asignaron no está en la lista de productos/);
});

test('T4 Inicio_LoPersonal_SinCambios', () => {
  // sin nada declarado: sus pedidos, sus pull requests y sus corridas siguen saliendo de su identidad
  const { ve } = mundoDeclarado(null);
  const mA = ve(A);
  assert.deepStrictEqual(mA.pedidos.lista.map((p) => p.id), [9], 'su pedido asignado, aunque Beta no esté declarado');
  assert.deepStrictEqual(mA.prs.lista.map((p) => p.numero), [7], 'su pull request');
  assert.strictEqual(mA.corridas.lista.length, 1, 'su ejecución');
  assert.strictEqual(views.inicioDev(mA).corridas.en7dias, 1);
});
