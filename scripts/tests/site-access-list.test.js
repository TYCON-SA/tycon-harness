'use strict';
/*
 * site-access-list.test.js — quién entra al sitio lo decide la lista del sitio.
 *
 * T2 2.40-Lista_ValidadaConRutas          T4 2.40-VariosCorreos_MismaVista       T11 2.40-SinLista_PaginaClaraSinDatos
 * T3 2.40-Rol_SoloDeLaLista               T5 2.40-Migracion_NadiePierdeAcceso
 *
 * La lista es `site.access` de operations.json: una entrada por persona, con su rol (`maintainer` o `dev`) y uno o más
 * correos. Sin la lista, el sitio la arma con lo de hoy (la migración). Las de reglas puras van contra el lector y
 * access.js; las de la página y las rutas, contra el servidor real con el emisor local.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const H = require('./lib/site-harness.js');

const access = require(path.join(H.SITE, 'access.js'));
const OPS = require(path.join(H.SITE, '..', 'lib', 'operations-config.js'));
const LEAD = 'lead@acme.example';
const A = 'dev.a@acme.example';
const A2 = 'dev.a.otra@mail.example';
const B = 'dev.b@acme.example';
const NADIE = 'nadie@otra.example';

// operations.json con la lista puesta
const conAcceso = (accessList, extra = {}) => ({ version: 1, owners: { default: LEAD }, site: { access: accessList }, ...extra });
const maquina = (person) => ({ person, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-15' });
const ses = (email) => ({ email, sub: `s-${email}` });

async function conSitio(fuentes, fn, env = {}) {
  const emisor = await arrancarEmisor();
  let h = null;
  try {
    h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, ...env }), fuentes });
    await fn({ h, entrar: async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion });
  } finally { if (h) await h.cerrar(); await emisor.cerrar(); }
}

test('T2 2.40-Lista_ValidadaConRutas @story-2.40 @ac-2', () => {
  const r = OPS.parse(JSON.stringify(conAcceso([
    { role: 'maintainer', emails: [LEAD] },
    { emails: [A] },
    { role: 'jefe', emails: [B] },
    { role: 'dev', emails: [] },
    { role: 'dev' },
    { role: 'dev', emails: ['no es un correo'] },
    { role: 'dev', emails: ['Lead@ACME.example'] },
    { role: 'dev', emails: [A2, A2] },
    { role: 'dev', emails: [B], color: 'azul' },
  ])));
  assert.strictEqual(r.ok, false);
  const por = Object.fromEntries(r.problems.map((p) => [p.path, p.message]));
  assert.match(por['site.access.1.role'], /falta/);
  assert.match(por['site.access.2.role'], /maintainer.*dev/);
  assert.match(por['site.access.3.emails'], /al menos un correo/);
  assert.match(por['site.access.4.emails'], /al menos un correo/);
  assert.match(por['site.access.5.emails.0'], /no es un correo/);
  assert.match(por['site.access.6.emails.0'], /ya está en site\.access\.0/, 'sin distinguir mayúsculas');
  assert.match(por['site.access.7.emails.1'], /ya está en site\.access\.7/, 'repetido en la misma entrada');
  assert.match(por['site.access.8.color'], /desconocida/);
  // las dos fuentes juntas no: la lista reemplaza a site.maintainers
  const dos = OPS.parse(JSON.stringify({ version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD], access: [{ role: 'maintainer', emails: [LEAD] }] } }));
  assert.strictEqual(dos.ok, false);
  assert.match(dos.problems.find((p) => p.path === 'site.maintainers').message, /site\.access/);
  // una lista sana valida, y una lista que no es lista no
  assert.strictEqual(OPS.parse(JSON.stringify(conAcceso([{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [A, A2] }]))).ok, true);
  assert.match(OPS.parse(JSON.stringify(conAcceso({ lead: LEAD }))).problems.find((p) => p.path === 'site.access').message, /lista/);
});

test('T3 2.40-Rol_SoloDeLaLista @story-2.40 @ac-3', () => {
  // B tiene una máquina confirmada pero no está en la lista: sin rol. La máquina ya no da rol
  const config = conAcceso([{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [A] }], { people: { machines: { 'maq-b': maquina(B) } } });
  assert.strictEqual(access.quienPide(ses(B), { config }).rol, 'none');
  assert.strictEqual(access.quienPide(ses(A), { config }).rol, 'person');
  assert.strictEqual(access.quienPide(ses('LEAD@acme.example'), { config }).rol, 'maintainer');
  // SITE_FIRST_MAINTAINER cuenta sólo mientras la lista no tiene ningún maintainer
  assert.strictEqual(access.quienPide(ses(NADIE), { config, firstMaintainer: NADIE }).rol, 'none', 'con un maintainer en la lista, la variable no cuenta');
  assert.strictEqual(access.quienPide(ses(LEAD), { config, firstMaintainer: NADIE }).variableSobrante, true, 'y quien mantiene ve el aviso para sacarla');
  const sinMantenedor = conAcceso([{ role: 'dev', emails: [A] }]);
  assert.strictEqual(access.quienPide(ses(NADIE), { config: sinMantenedor, firstMaintainer: NADIE }).rol, 'maintainer');
  assert.strictEqual(access.quienPide(ses(A), { config: sinMantenedor, firstMaintainer: NADIE }).rol, 'person');
  assert.strictEqual(access.quienPide(ses(NADIE), { config: sinMantenedor }).sinMantenedores, true);
  // con cualquier proveedor: el rol no mira de dónde vino la sesión, sólo el correo
  assert.strictEqual(access.quienPide({ email: A, sub: 'github:123' }, { config }).rol, 'person');
});

test('T4 2.40-VariosCorreos_MismaVista @story-2.40 @ac-4', async () => {
  // A entra con su correo de la organización o con el personal; su máquina está a nombre del personal y su pedido,
  // asignado al de la organización: los dos son de A
  const config = conAcceso([{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [A, A2] }, { role: 'dev', emails: [B] }],
    { people: { machines: { 'maq-a': maquina(A2), 'maq-b': maquina(B) } } });
  const modelo = {
    corridas: { estado: 'medido', fecha: '2026-10-15', lista: [
      { maquina: 'maq-a', inicio: '2026-10-15T10:00:00Z', marca: 'CORRIDA-DE-A' },
      { maquina: 'maq-b', inicio: '2026-10-15T11:00:00Z', marca: 'CORRIDA-DE-B' },
    ] },
    prs: { estado: 'medido', fecha: '2026-10-15', lista: [
      { numero: 1, proyecto: 'P', repo: 'R', dias: 3, autor: A2, enlace: 'https://x.example/pr/1' },
      { numero: 2, proyecto: 'P', repo: 'R', dias: 4, autor: B, enlace: 'https://x.example/pr/2' },
    ] },
    pedidos: { estado: 'medido', fecha: '2026-10-15', lista: [
      { id: 10, proyecto: 'P', tipo: 'Bug', estado: 'Active', asignado: A, dias: 2, enlace: 'https://x.example/wi/10' },
      { id: 11, proyecto: 'P', tipo: 'Bug', estado: 'Active', asignado: B, dias: 2, enlace: 'https://x.example/wi/11' },
    ] },
  };
  const personas = { informados: H.informados({ 'maq-a': A2, 'maq-b': B }), repos: null };
  const vista = (email) => {
    const quien = access.quienPide(ses(email), { config });
    return { quien, m: access.filtrar(modelo, quien, access.crearReglas({ config, modelo, personas })) };
  };
  const conUno = vista(A);
  const conOtro = vista(A2.toUpperCase());
  assert.strictEqual(conUno.quien.rol, 'person');
  assert.strictEqual(conUno.quien.email, A, 'el primero de la entrada es el correo de la persona');
  assert.strictEqual(conOtro.quien.email, A, 'entrando con el otro, es la misma persona');
  assert.deepStrictEqual(conOtro.quien.correos, [A, A2]);
  assert.strictEqual(conOtro.quien.correoDeIngreso, A2, 'y se sabe con cuál entró');
  assert.deepStrictEqual(conUno.m, conOtro.m, 've lo mismo con cualquiera de sus correos');
  assert.deepStrictEqual(conUno.m.corridas.lista.map((c) => c.marca), ['CORRIDA-DE-A'], 'la máquina a nombre del otro correo es suya');
  assert.deepStrictEqual(conUno.m.prs.lista.map((p) => p.numero), [1]);
  assert.deepStrictEqual(conUno.m.pedidos.lista.map((p) => p.id), [10]);
  // en el servidor: las dos sesiones ven la misma página
  await conSitio(H.fuentesFijas({ config, modelo, personas }), async ({ h, entrar }) => {
    const p1 = await h.pedir('/', { cookie: await entrar(A) });
    const p2 = await h.pedir('/', { cookie: await entrar(A2) });
    assert.strictEqual(p1.status, 200);
    const sinCabecera = (t) => t.replace(/<form class="salir"[\s\S]*?<\/form>/, '');
    assert.strictEqual(sinCabecera(p1.texto), sinCabecera(p2.texto));
    assert.ok(p2.texto.includes(A2), 'arriba dice con qué cuenta entró');
  });
});

// una máquina que se mudó de carpeta: la vieja confirmada con un correo de la persona y la nueva con otro de la misma
// persona. La unión las junta (es la misma persona), y la persona ve las corridas de las dos con cualquiera de sus correos.
test('2.40-R3 VariosCorreos_CarpetaViejaYNueva @story-2.40 @ac-4', () => {
  const people = require(path.join(H.SITE, '..', 'lib', 'people.js'));
  const config = conAcceso([{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [A, A2] }, { role: 'dev', emails: [B] }],
    { people: { machines: { vieja: maquina(A2), nueva: maquina(A) } } });
  const uniones = { vieja: { estado: 'unida', nueva: 'nueva', declarantes: 1, desde: '2026-10-10' } };
  const personas = { informados: H.informados({ vieja: A2, nueva: A }, uniones), repos: null };
  const c = people.contexto({ operations: config, informados: personas.informados });
  assert.strictEqual(people.estadoDeMaquina('vieja', c).estado, 'confirmada', JSON.stringify(people.estadoDeMaquina('vieja', c)));
  const modelo = { corridas: { estado: 'medido', fecha: '2026-10-15', lista: [{ maquina: 'nueva', carpeta: 'vieja', marca: 'VIEJA' }, { maquina: 'nueva', marca: 'NUEVA' }] } };
  for (const email of [A, A2]) {
    const m = access.filtrar(modelo, access.quienPide(ses(email), { config }), access.crearReglas({ config, modelo, personas }));
    assert.deepStrictEqual(m.corridas.lista.map((x) => x.marca).sort(), ['NUEVA', 'VIEJA'], email);
  }
  // otra persona sigue sin heredarlas: una vieja de B unida a la nueva de A queda compartida
  const ajena = conAcceso(config.site.access, { people: { machines: { vieja: maquina(B), nueva: maquina(A) } } });
  const c2 = people.contexto({ operations: ajena, informados: H.informados({ vieja: B, nueva: A }, uniones) });
  assert.strictEqual(people.estadoDeMaquina('vieja', c2).estado, 'compartida');
});

// el registro del sitio dice cuándo entra en vigor un cambio de la lista: la cuenta, alta, baja o cambio de rol
test('2.40-R4 Registro_CambiosDeLaLista @story-2.40 @ac-6', () => {
  const people = require(path.join(H.SITE, '..', 'lib', 'people.js'));
  const antes = conAcceso([{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [A] }, { role: 'dev', emails: [B] }]);
  const despues = conAcceso([{ role: 'maintainer', emails: [LEAD, 'Lead.Casa@personal.example'] }, { role: 'maintainer', emails: [A] }]);
  const c = people.cambiosDeAcceso(antes, despues);
  assert.deepStrictEqual(c, { altas: [{ email: 'lead.casa@personal.example', role: 'maintainer' }], bajas: [{ email: B, role: 'dev' }], roles: [{ email: A, de: 'dev', a: 'maintainer' }] });
  assert.match(people.textoDeCambios(c), /alta lead\.casa@personal\.example \(maintainer\).*baja dev\.b@acme\.example.*dev\.a@acme\.example: dev → maintainer/);
  // sin cambios, nada que decir; la migración (sin site.access) contra la misma lista puesta, tampoco
  assert.strictEqual(people.textoDeCambios(people.cambiosDeAcceso(antes, antes)), '');
  const migracion = { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] } };
  assert.strictEqual(people.textoDeCambios(people.cambiosDeAcceso(migracion, conAcceso([{ role: 'maintainer', emails: [LEAD] }]))), '');
});

test('T5 2.40-Migracion_NadiePierdeAcceso @story-2.40 @ac-5', () => {
  const hoy = { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD, 'Otro.Lead@acme.example'] },
    people: { machines: { 'maq-a': maquina(A), 'maq-a2': maquina(A), 'maq-b': maquina('DEV.B@acme.example'), 'maq-l': maquina(LEAD), __nota: 'comentario' } } };
  const lista = access.listaDeAcceso(hoy);
  assert.strictEqual(lista.origen, 'migracion');
  assert.deepStrictEqual(lista.entradas, [
    { role: 'maintainer', emails: [LEAD] },
    { role: 'maintainer', emails: ['otro.lead@acme.example'] },
    { role: 'dev', emails: [A] },
    { role: 'dev', emails: [B] },
  ], 'cada maintainer y cada correo con máquina, sin repetir y sin el comentario');
  // la lista armada valida con el lector, y con ella cada uno conserva su rol
  const migrado = { ...hoy, site: { access: lista.entradas } };
  assert.strictEqual(OPS.parse(JSON.stringify(migrado)).ok, true);
  for (const [email, rol] of [[LEAD, 'maintainer'], ['otro.lead@acme.example', 'maintainer'], [A, 'person'], [B, 'person'], [NADIE, 'none']]) {
    assert.strictEqual(access.quienPide(ses(email), { config: hoy }).rol, rol, `${email} sin la lista`);
    assert.strictEqual(access.quienPide(ses(email), { config: migrado }).rol, rol, `${email} con la lista migrada`);
  }
  // con la lista puesta, la migración no corre
  assert.strictEqual(access.listaDeAcceso(migrado).origen, 'lista');
  // lo que no se puede leer no se pierde en silencio: la lista dice cuántos correos dejó afuera
  assert.strictEqual(lista.descartados, 0);
  const conBasura = access.listaDeAcceso({ ...hoy, site: { maintainers: [LEAD, 'no es un correo'] } });
  assert.strictEqual(conBasura.descartados, 1);
  // una máquina sin persona no es un correo mal escrito: no cuenta
  assert.strictEqual(access.listaDeAcceso({ ...hoy, people: { machines: { suelta: { reported_sha256: null } } } }).descartados, 0);
  // un correo en dos entradas (el lector lo rechaza; si igual llega) no pasa a la segunda: queda en la primera y se cuenta
  const repetido = access.listaDeAcceso(conAcceso([{ role: 'dev', emails: [A] }, { role: 'maintainer', emails: [LEAD, 'Dev.A@acme.example'] }]));
  assert.deepStrictEqual(repetido.entradas, [{ role: 'dev', emails: [A] }, { role: 'maintainer', emails: [LEAD] }]);
  assert.strictEqual(repetido.descartados, 1);
});

test('T11 2.40-SinLista_PaginaClaraSinDatos @story-2.40 @ac-9', async () => {
  const config = conAcceso([{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [A] }], { people: { machines: { 'maq-a': maquina(A) } } });
  const modelo = { corridas: { estado: 'medido', fecha: '2026-10-15', lista: [{ maquina: 'maq-a', inicio: '2026-10-15T10:00:00Z', marca: 'CORRIDA-DE-A' }] },
    proyectos: { estado: 'medido', fecha: '2026-10-15', lista: [{ proyecto: 'Proyecto X', repo: 'Repo X', stories: [] }] } };
  await conSitio(H.fuentesFijas({ config, modelo }), async ({ h, entrar }) => {
    const s = await entrar(NADIE);
    const p = await h.pedir('/', { cookie: s });
    assert.strictEqual(p.status, 200);
    assert.match(p.texto, /Tu cuenta no está en la lista/);
    assert.ok(p.texto.includes(NADIE), 'dice con qué cuenta entró');
    assert.match(p.texto, /pedile a quien mantiene el sitio de tu organización/i, 'a quién pedírselo, sin nombrar a nadie');
    assert.match(p.texto, /action="\/auth\/logout"/, 'cómo salir');
    assert.match(p.texto, /href="\/auth\/login\?otra=1"/, 'y entrar con otra cuenta');
    for (const marca of [LEAD, A, 'CORRIDA-DE-A', 'Proyecto X']) assert.ok(!p.texto.includes(marca), `sin datos ni nombres: ${marca}`);
    // ninguna ruta del sitio le contesta un dato: todas las de la tabla, con sus parámetros puestos
    // (la tabla base, y las de las pestañas Configuración y Corridas, que el sitio suma aparte)
    const deLasPestanas = [['GET', '/api/config'], ['GET', '/api/config/pasos'], ['GET', '/api/config/pipelines'], ['GET', '/api/config/stages'],
      ['POST', '/api/config/proponer'], ['POST', '/api/config/revisar'], ['GET', '/api/corridas'], ['GET', '/api/corridas/x'], ['GET', '/api/corridas/x/textos'],
      ['GET', '/configuracion'], ['GET', '/corridas'], ['GET', '/static/config.js'], ['GET', '/corridas/cliente.js']].map(([method, ruta]) => ({ method, ruta }));
    const rutas = [...h.sitio.rutas.map((r) => ({ method: r.method, ruta: r.path.replace(/:[a-z]+/g, 'x') })), ...deLasPestanas];
    assert.ok(h.sitio.rutas.length >= 5, 'se recorrió la tabla entera');
    for (const r of rutas) {
      const res = await h.pedir(r.ruta, { method: r.method, cookie: s, headers: r.method === 'POST' ? { origin: h.base, 'content-type': 'application/json' } : {}, body: r.method === 'POST' ? '{}' : undefined });
      if (r.ruta.startsWith('/api/')) assert.ok(res.status === 403 && res.texto === '', `${r.method} ${r.ruta}: 403 vacío (dio ${res.status})`);
      else for (const marca of [LEAD, A, 'CORRIDA-DE-A', 'Proyecto X']) assert.ok(!res.texto.includes(marca), `${r.method} ${r.ruta}: sin ${marca}`);
    }
    // «entrar con otra cuenta» va al emisor pidiendo elegir la cuenta
    const otra = await h.pedir('/auth/login?otra=1', { cookie: s });
    assert.strictEqual(otra.status, 302);
    assert.strictEqual(new URL(otra.headers.location).searchParams.get('prompt'), 'select_account');
    // el registro dice por qué no entró, sin el correo
    assert.ok(h.registro.some((l) => /no está en la lista del sitio/.test(l) && !l.includes(NADIE)), h.registro.join('\n'));
  });
});
