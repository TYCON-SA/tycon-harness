'use strict';
/*
 * site-access.test.js — quién es quién en el sitio de la organización y qué ve cada uno (story 2.23, AC 8, 10 a 12).
 *
 * T14 Identidad_NoSaleDeCabeceras      T18 Rol_SinRol_PaginaSinDatos     T43 Corridas_CarpetaNuevaYViejas
 * T17 Rol_SeRecalculaEnCadaPedido      T20 Filtro_QueEsDeQuien
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
    assert.match((await h.pedir('/', { cookie: s })).texto, /todavía no está confirmada/, 'sin rol: la página sin datos');
  });
});

test('T18 Rol_SinRol_PaginaSinDatos', async () => {
  const config = opsBase({ people: { machines: { 'maq-a-1a2b3c4d': { person: B, reported_sha256: sha(B), confirmed_by: LEAD, confirmed_on: '2026-10-15' } } } });
  const modelo = {
    corridas: { estado: 'medido', fecha: '2026-10-15', lista: [{ maquina: 'maq-a-1a2b3c4d', inicio: '2026-10-15T10:00:00Z', marca: 'CORRIDA-DE-B' }] },
    informados: { 'maq-a-1a2b3c4d': 'otra.persona@acme.example' },   // la máquina informa otro correo: caída («cambio»)
    proyectos: { estado: 'medido', fecha: '2026-10-15', lista: [{ proyecto: 'Proyecto X', repo: 'Repo X', stories: [] }] },
    productos: [{ producto: 'Producto X', proyectos: ['Proyecto X'] }],
  };
  await conSitio(H.fuentesFijas({ config, modelo }), async ({ h, entrar }) => {
    const sinRol = await h.pedir('/', { cookie: await entrar(A) });
    assert.strictEqual(sinRol.status, 200);
    assert.match(sinRol.texto, /tu cuenta todavía no está confirmada; pedíselo a quien mantiene el arnés/);
    for (const marca of ['Producto X', 'Proyecto X', LEAD, B, 'CORRIDA-DE-B']) assert.ok(!sinRol.texto.includes(marca), `sin datos ni nombres: ${marca}`);
    assert.doesNotMatch(sinRol.texto, /href="\/proyectos"/, 'sin pestañas');
    // B tiene una entrada, pero su única máquina está caída: es persona, sin corridas de esa máquina
    const sB = await entrar(B);
    const iniB = await h.pedir('/', { cookie: sB });
    assert.match(iniB.texto, /href="\/proyectos"/, 'B tiene las pestañas de persona');
    assert.doesNotMatch(iniB.texto, /href="\/arnes"/);
    assert.ok(!iniB.texto.includes('CORRIDA-DE-B'));
    assert.strictEqual(access.quienPide(persona(B), { config }).rol, 'person');
    assert.strictEqual(access.crearReglas({ config, modelo }).maquina('maq-a-1a2b3c4d').estado, 'cambio');
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
    informados: { 'maq-a-11111111': 'DEV.A@acme.example', 'maq-b-22222222': B },
    prs: { estado: 'medido', fecha: '2026-10-15', lista: [
      { numero: 1, proyecto: 'P', repo: 'R', dias: 3, autor: 'Dev.A@ACME.example', enlace: 'https://x.example/pr/1' },
      { numero: 2, proyecto: 'P', repo: 'R', dias: 4, autor: B, enlace: 'https://x.example/pr/2' },
    ] },
    pedidos: { estado: 'medido', fecha: '2026-10-15', lista: [
      { id: 10, proyecto: 'P', tipo: 'Bug', estado: 'Active', asignado: 'DEV.B@acme.example', dias: 2, enlace: 'https://x.example/wi/10', dependencias: true },
    ] },
  };
  const ve = (email, cfg = config) => {
    const quien = access.quienPide(persona(email), { config: cfg });
    return access.filtrar(modelo, quien, access.crearReglas({ config: cfg, modelo }));
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
  const sinAlias = access.filtrar(conPersonal, access.quienPide(persona(A), { config }), access.crearReglas({ config, modelo: conPersonal }));
  assert.strictEqual(sinAlias.pedidos.estado, 'no_medido');
  assert.match(sinAlias.pedidos.motivo, /tu identidad en la plataforma no es tu correo de la organización; pedile a quien mantiene que la asocie/);
  assert.strictEqual(sinAlias.pedidos.lista.length, 0);
  const cfgAlias = { ...config, people: { ...config.people, [A]: { identities: ['A.Personal@mail.example'] } } };
  const conAlias = access.filtrar(conPersonal, access.quienPide(persona(A), { config: cfgAlias }), access.crearReglas({ config: cfgAlias, modelo: conPersonal }));
  assert.strictEqual(conAlias.pedidos.estado, 'medido');
  assert.deepStrictEqual(conAlias.pedidos.lista.map((p) => p.id), [11]);
  // A sin lista de proyectos: la frase
  assert.strictEqual(mA.proyectos.lista, null);
  assert.match(mA.proyectos.motivo, /todavía no se sabe en qué proyectos trabajás: lo confirma quien mantiene el arnés/);
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
    carpetas: { schema: 1, carpetas: {
      maq: { estado: 'unida', nueva: 'maq-1a2b3c4d', declarantes: 1, desde: '2026-10-10' },
      otra: { estado: 'compartida', nueva: null, declarantes: 2, desde: null },
      vieja: { estado: 'siguio_recibiendo', nueva: null, declarantes: 1, desde: '2026-10-05' },
    } },
  };
  const filtra = (email, cfg) => access.filtrar(modelo, access.quienPide(persona(email), { config: cfg }), access.crearReglas({ config: cfg, modelo }));
  assert.deepStrictEqual(filtra(A, config).corridas.lista.map((c) => c.maquina).sort(), ['maq', 'maq-1a2b3c4d'], 'la nueva y su vieja unida');
  assert.strictEqual(filtra(LEAD, config).corridas.lista.length, 4);
  // la entrada con el nombre de la vieja unida no cuenta: sin la de la nueva, A no ve nada
  const soloVieja = opsBase({ people: { machines: { maq: config.people.machines.maq, otra: config.people.machines.otra } } });
  assert.deepStrictEqual(filtra(A, soloVieja).corridas.lista, []);
  const reglas = access.crearReglas({ config, modelo });
  assert.strictEqual(reglas.maquina('otra').estado, 'compartida');
  assert.strictEqual(reglas.maquina('vieja').estado, 'siguio_recibiendo');
  assert.strictEqual(reglas.maquina('maq').carpeta, 'maq-1a2b3c4d');
});
