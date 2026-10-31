'use strict';
/*
 * site-views.test.js — las pestañas Inicio, Proyectos y Arnés del sitio de la organización.
 *
 * T28 Inicio_Mantenedor_LeeNoMide            T31 Cabeceras_EnCadaRespuestaConDatos
 * T29 Proyectos_ParadasCompartidosYDespliegues T34 Inicio_Dev_SoloLoSuyo_ConCantidades
 * T30 Arnes_SuitesYSoloMantenedor
 * T29b Proyectos_DiasDeLaConfiguracion   T29c Proyectos_SinDiasNoMedido   T29d Proyectos_ColumnaDeEdad
 *
 * Las filas se prueban como datos (views.filas*), y el HTML contra el servidor real. Lo que no se midió dice «no
 * medido» con su motivo: nunca 0.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const H = require('./lib/site-harness.js');

const views = require(path.join(H.SITE, 'views.js'));
const access = require(path.join(H.SITE, 'access.js'));
const sources = require(path.join(H.SITE, 'sources.js'));
const LEAD = 'lead@acme.example';
const A = 'dev.a@acme.example';
const B = 'dev.b@acme.example';
const HOY = '2026-10-15';
const AHORA = Date.parse(`${HOY}T12:00:00Z`);

const leida = (extra) => ({ estado: 'medido', codigo: null, motivo: null, fecha: HOY, ...extra });
const noMedida = (codigo) => ({ estado: 'no_medido', codigo, motivo: null, fecha: null });

function modeloCompleto(extra = {}) {
  return {
    dependencias: leida({ rubros: { nuevos: 3, aceptadas_sin_resolver: 1, rechazadas_sin_deuda: 0, pedidos_cerrados_con_vivas: 2 }, vivas_por_proyecto: { 'Proyecto X': 4 } }),
    vigilante: leida({ pendientes: 2, aceptadas_sin_story: 1, productos: ['producto-x'] }),
    prs: leida({ lista: [
      { numero: 7, proyecto: 'Proyecto X', repo: 'Repo X', dias: 5, autor: A, enlace: 'https://dev.example/pr/7' },
      { numero: 8, proyecto: 'Proyecto X', repo: 'Repo X', dias: 1, autor: B, enlace: 'https://dev.example/pr/8' },
    ] }),
    pedidos: leida({ lista: [] }),
    suites: leida({ rojas: ['a.test.js', 'b.test.js'], sin_medir: 0, total: 300, ayer: { fecha: '2026-10-14', rojas: ['a.test.js'] } }),
    banco: leida({ rojos: [], total: 2500, ayer: { fecha: '2026-10-14', rojos: [] } }),
    declarados: leida({ lista: [{ id: 'dato-uno', review_before: '2026-10-20' }, { id: 'dato-dos', review_before: '2026-12-31' }] }),
    corridas: leida({ lista: [{ maquina: 'maq-x-12345678', inicio: '2026-10-15T08:00:00Z' }] }),
    productos: [{ producto: 'Producto X', proyectos: ['Proyecto X'] }],
    proyectos: leida({ lista: [] }),
    despliegues: noMedida('sin_foto'),
    stateAgeDays: [30, 60],
    ...extra,
  };
}
// lo informado por la máquina del modelo: no informa correo y nadie la confirmó, así que es una por confirmar
const filasDe = (modelo) => views.filasInicioMantenedor(access.filtrar(modelo, { rol: 'maintainer', email: LEAD }, access.crearReglas({ config: {}, modelo, personas: { informados: H.informados({ 'maq-x-12345678': null }), repos: null } })), { ahora: AHORA });
const fila = (filas, clave) => filas.find((f) => f.clave === clave);

test('T28 Inicio_Mantenedor_LeeNoMide', () => {
  const filas = filasDe(modeloCompleto({ vigilante: noMedida('sin_foto') }));
  assert.deepStrictEqual(filas.map((f) => f.clave), [
    'dependencias_por_decidir', 'dependencias_aceptadas_sin_resolver', 'dependencias_rechazadas_sin_deuda',
    'vigilante_pendientes', 'vigilante_aceptadas_sin_story', 'prs_trabados', 'pedidos_cerrados_con_vivas',
    'suites_rojas_nuevas', 'banco_rojos_nuevos', 'declarados_por_vencer', 'maquinas_sin_confirmar', 'retrospectivas',
  ], 'las filas en orden');
  // las dependencias por decidir salen de la cuenta de Mantenimiento: sin ella, «no medido», nunca 0 ni lo de anoche
  assert.deepStrictEqual([fila(filas, 'dependencias_por_decidir').estado, fila(filas, 'dependencias_por_decidir').valor], ['no_medido', null]);
  assert.ok(fila(filas, 'dependencias_por_decidir').motivo);
  const conCuenta = views.filasInicioMantenedor(modeloCompleto({}), { ahora: AHORA, esperan: (f) => (f === 'dependencias' ? 22 : null) });
  assert.deepStrictEqual([fila(conCuenta, 'dependencias_por_decidir').estado, fila(conCuenta, 'dependencias_por_decidir').valor], ['medido', 22]);
  const enCero = views.filasInicioMantenedor(modeloCompleto({}), { ahora: AHORA, esperan: () => 0 });
  assert.strictEqual(fila(enCero, 'dependencias_por_decidir').valor, 0, 'ninguna por decidir es un 0 medido');
  for (const k of ['vigilante_pendientes', 'vigilante_aceptadas_sin_story']) {
    assert.strictEqual(fila(filas, k).estado, 'no_medido', `${k}: sin la foto del vigilante`);
    assert.strictEqual(fila(filas, k).valor, null, 'nunca 0');
    assert.ok(fila(filas, k).motivo);
  }
  assert.deepStrictEqual([fila(filas, 'suites_rojas_nuevas').estado, fila(filas, 'suites_rojas_nuevas').valor], ['medido', 1], '1 rojo nuevo: B (A ya estaba roja ayer)');
  assert.strictEqual(fila(filas, 'prs_trabados').valor, 1, 'PR abiertos hace más de 2 días');
  assert.strictEqual(fila(filas, 'pedidos_cerrados_con_vivas').valor, 2);
  assert.strictEqual(fila(filas, 'declarados_por_vencer').valor, 1, 'vence en 7 días');
  assert.strictEqual(fila(filas, 'maquinas_sin_confirmar').valor, 1);
  const retro = fila(filas, 'retrospectivas');
  assert.strictEqual(retro.estado, 'no_medido');
  assert.match(retro.motivo, /sólo existen en la máquina de quien mergeó/);
  // sin la foto de ayer, el rojo de esta noche no se puede decir
  const sinAyer = filasDe(modeloCompleto({ suites: leida({ rojas: ['a.test.js'], sin_medir: 0, total: 300, ayer: null }) }));
  assert.strictEqual(fila(sinAyer, 'suites_rojas_nuevas').estado, 'no_medido');
  // y el HTML: «no medido» con trama, nunca un 0 verde
  const html = views.paginaInicio({ modelo: access.filtrar(modeloCompleto({ vigilante: noMedida('sin_foto') }), { rol: 'maintainer' }, access.crearReglas({})), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  assert.match(html, /class="tile blind"/);
  assert.match(html, /no medido/);
});

// el enlace de cada tarjeta dice adónde lleva, también en las «no medido»; las máquinas, a donde se confirman
test('Inicio_EnlaceDeTarjeta_DiceAdondeLleva', () => {
  const filas = filasDe(modeloCompleto({ vigilante: noMedida('sin_foto') }));
  assert.strictEqual(fila(filas, 'maquinas_sin_confirmar').enlace, '/configuracion', 'una máquina se confirma en Configuración');
  const html = views.paginaInicio({ modelo: access.filtrar(modeloCompleto({ vigilante: noMedida('sin_foto') }), { rol: 'maintainer' }, access.crearReglas({})), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  const tarjetas = html.split('<div class="tile ').slice(1).map((x) => x.split('<div class="tile ')[0]);
  const deFila = (clave) => {
    const f = fila(filas, clave);
    return tarjetas.find((x) => x.includes(`<div class="t-label">${f.titulo}</div>`));
  };
  const pie = (clave) => (/<div class="t-foot"><a href="([^"]+)">([^<]+)<\/a><\/div>/.exec(deFila(clave) || '') || []).slice(1);
  assert.deepStrictEqual(pie('prs_trabados'), ['#prs-trabados', 'ver cuáles (cada una lleva a donde se decide)'], 'una lista de esta página');
  assert.deepStrictEqual(pie('suites_rojas_nuevas'), ['/arnes', 'ver en Arnés'], 'Arnés sólo se mira');
  assert.deepStrictEqual(pie('dependencias_por_decidir'), ['/mantenimiento', 'dónde se decide'], 'la pestaña donde se decide');
  assert.deepStrictEqual(pie('maquinas_sin_confirmar'), ['/configuracion', 'dónde se decide']);
  // la «no medido» también lleva su enlace
  assert.ok(deFila('vigilante_pendientes').startsWith('blind'), 'sin la foto del vigilante, no medido');
  assert.deepStrictEqual(pie('vigilante_pendientes'), ['#decidir-vigilante_pendientes', 'ver cuáles (cada una lleva a donde se decide)']);
});

test('T29 Proyectos_ParadasCompartidosYDespliegues', () => {
  const st = (grupo, canonico, dias) => ({ grupo, canonico, dias_en_estado: dias });
  const modelo = modeloCompleto({
    productos: [
      { producto: 'Producto X', proyectos: ['Proyecto X', 'Compartido'] },
      { producto: 'Producto Y', proyectos: ['Compartido'] },
    ],
    proyectos: leida({ lista: [
      { proyecto: 'Proyecto X', repo: 'Repo X', fecha: HOY, stories: [st('en_curso', 'in-progress', 45), st('en_curso', 'review', 10), st('en_curso', 'in-progress', null), st('bloqueado', 'blocked', 3)] },
      { proyecto: 'Compartido', repo: 'Repo C', fecha: HOY, stories: [st('en_curso', 'in-progress', 1), st('en_curso', 'in-progress', 2), st('en_curso', 'in-progress', 3), st('en_curso', 'in-progress', 4)] },
    ] }),
  });
  const { filas, totales } = views.filasProyectos(access.filtrar(modelo, { rol: 'maintainer' }, access.crearReglas({})));
  const x = filas.find((f) => f.producto === 'Producto X');
  assert.strictEqual(x.paradas, 1, '45 días: parada');
  assert.strictEqual(x.sin_medir, 1, 'sin días: sin medir, nunca «no parada»');
  assert.strictEqual(x.en_revision, 1);
  assert.strictEqual(x.bloqueadas, 1);
  const y = filas.find((f) => f.producto === 'Producto Y');
  assert.strictEqual(y.compartido, 2, 'el proyecto de dos productos: «compartido con 2»');
  assert.strictEqual(y.en_curso, 4);
  assert.strictEqual(totales.en_curso_total, 3 + 4, 'total sin contar dos veces el compartido (no 11)');
  assert.strictEqual(x.despliegues.estado, 'no_medido');
  assert.ok(x.despliegues.motivo, 'despliegues «no medido» con motivo');
  const html = views.paginaProyectos({ modelo: access.filtrar(modelo, { rol: 'maintainer' }, access.crearReglas({})), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  assert.match(html, /compartido con 2/);
});

// el modelo de T29, con los días que se quieran: los umbrales de «parada» y de edad salen de ahí
const stEdad = (grupo, canonico, dias) => ({ grupo, canonico, dias_en_estado: dias });
const modeloDeEdad = (stateAgeDays) => modeloCompleto({
  stateAgeDays,
  productos: [{ producto: 'Producto X', proyectos: ['Proyecto X'] }],
  proyectos: leida({ lista: [
    { proyecto: 'Proyecto X', repo: 'Repo X', fecha: HOY, stories: [stEdad('en_curso', 'in-progress', 45), stEdad('en_curso', 'review', 10), stEdad('en_curso', 'in-progress', null), stEdad('bloqueado', 'blocked', 70)] },
  ] }),
});
const vistaDeEdad = (stateAgeDays, idioma) => {
  const modelo = access.filtrar(modeloDeEdad(stateAgeDays), { rol: 'maintainer' }, access.crearReglas({}));
  return { ...views.filasProyectos(modelo, { idioma }), html: views.paginaProyectos({ modelo, quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA, idioma }) };
};

test('T29b Proyectos_DiasDeLaConfiguracion — el umbral de «parada» sale de params.edad_en_estado_dias', () => {
  const con40 = vistaDeEdad([40, 50]);
  assert.strictEqual(con40.filas[0].paradas, 1, '45 días con umbral 40: parada');
  assert.strictEqual(con40.totales.paradas_total, 1);
  assert.match(con40.html, /Paradas \(más de 40 días\)/, 'el encabezado nombra los días de la configuración');
  assert.doesNotMatch(con40.html, /más de 30 días/);
  const con50 = vistaDeEdad([50, 100]);
  assert.strictEqual(con50.filas[0].paradas, 0, '45 días con umbral 50: no parada');
  assert.strictEqual(con50.filas[0].sin_medir, 1, 'la sin dato sigue sin medir');
  assert.match(vistaDeEdad([40, 50], 'en').html, /Stalled \(more than 40 days\)/);
});

test('T29c Proyectos_SinDiasNoMedido — sin días válidos, paradas y edad dicen «no medido», nunca un 30 de respaldo', () => {
  for (const dias of [null, undefined, [60, 30], [30]]) {
    const { filas, totales, html } = vistaDeEdad(dias);
    const x = filas[0];
    assert.strictEqual(x.medido, true, 'las stories en curso se siguen contando');
    assert.strictEqual(x.en_curso, 3);
    assert.strictEqual(x.paradas, null, `${JSON.stringify(dias)}: paradas sin umbral no es 0`);
    assert.strictEqual(x.sin_medir, null);
    assert.strictEqual(x.edad.estado, 'no_medido');
    assert.match(x.edad.motivo, /edad_en_estado_dias/);
    assert.strictEqual(totales.paradas_total, null);
    assert.doesNotMatch(html, /más de 30/, 'ningún 30 escrito');
    assert.match(html, /no medido: sin los días de edad en el estado/);
  }
  assert.match(vistaDeEdad(null, 'en').html, /not measured: no state-age days/);
});

test('T29d Proyectos_ColumnaDeEdad — «más de N días: X · más de M: Y» por producto, de la misma cuenta que el tablero', () => {
  const { filas, html } = vistaDeEdad([30, 60]);
  assert.deepStrictEqual(filas[0].edad, { estado: 'medido', motivo: null, d1: 30, d2: 60, mas_de_d1: 2, mas_de_d2: 1 }, 'lo empezado: 45 y la bloqueada de 70');
  assert.match(html, /más de 30 días: 2 · más de 60: 1/);
  assert.match(vistaDeEdad([30, 60], 'en').html, /more than 30 days: 2 · more than 60: 1/);
  assert.match(vistaDeEdad([10, 50]).html, /más de 10 días: 2 · más de 50: 1/);
});

/** Un sitio con el emisor local, unas fuentes fijas y dos sesiones (mantenedor y persona). */
async function conSitio(modelo, config, fn) {
  const emisor = await arrancarEmisor();
  let h = null;
  try {
    h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_PUBLIC_URL: 'https://site.acme.example' }), fuentes: H.fuentesFijas({ config, modelo }) });
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    await fn({ h, entrar });
  } finally { if (h) await h.cerrar(); await emisor.cerrar(); }
}
const CONFIG = { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] }, people: { machines: { 'maq-a-11111111': { person: A, reported_sha256: null, confirmed_by: LEAD, confirmed_on: HOY } } } };

test('T30 Arnes_SuitesYSoloMantenedor', async () => {
  const modelo = modeloCompleto({ suites: leida({ rojas: Array.from({ length: 24 }, (_, i) => `s${i}.test.js`), sin_medir: 1, total: 280, ayer: null }) });
  const lineas = views.filasArnes(access.filtrar(modelo, { rol: 'maintainer' }, access.crearReglas({})), { ahora: AHORA });
  assert.strictEqual(lineas.find((l) => l.clave === 'suites').texto, '24 rojas · 1 sin medir, de 280');
  await conSitio(modelo, CONFIG, async ({ h, entrar }) => {
    const sA = await entrar(A);
    for (const ruta of ['/arnes']) {
      const r = await h.pedir(ruta, { cookie: sA });
      assert.strictEqual(r.status, 403, ruta);
      assert.ok(!r.texto.includes('24 rojas') && !r.texto.includes('s0.test.js'), `${ruta}: sin datos`);
      assert.doesNotMatch(r.texto, /href="\/arnes"/, `${ruta}: sin la pestaña dibujada`);
    }
    assert.doesNotMatch((await h.pedir('/', { cookie: sA })).texto, /href="\/arnes"/, 'el dev no ve la pestaña en Inicio');
    const lead = await h.pedir('/arnes', { cookie: await entrar(LEAD) });
    assert.strictEqual(lead.status, 200);
    assert.match(lead.texto, /24 rojas · 1 sin medir, de 280/);
  });
});

test('T31 Cabeceras_EnCadaRespuestaConDatos', async () => {
  const modelo = modeloCompleto({ tablero: leida({ sello: { generado: `${HOY}T06:00:00Z`, completo: true } }) });
  const { RUTAS, CSP } = require(path.join(H.SITE, 'server.js'));
  assert.strictEqual(CSP, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  await conSitio(modelo, CONFIG, async ({ h, entrar }) => {
    const s = await entrar(LEAD);
    for (const r of RUTAS) {
      const res = await h.pedir(r.path, { cookie: s, method: r.method });
      assert.strictEqual(res.status, 200, r.path);
      assert.strictEqual(res.headers['cache-control'], 'no-store', `${r.path}: no-store`);
      assert.strictEqual(res.headers['content-security-policy'], CSP, `${r.path}: la política`);
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff', r.path);
      // el Referer viaja sólo dentro del sitio, nunca afuera. Con `no-referrer`, el candado de la plataforma toma cada POST
      // de Configuración por falsificado (403, subestado 60): su anti-CSRF mira el Referer
      assert.strictEqual(res.headers['referrer-policy'], 'same-origin', r.path);
      assert.match(res.headers['strict-transport-security'] || '', /max-age=\d+/, `${r.path}: HSTS con dirección https`);
      if (/html/.test(res.headers['content-type'])) {
        // lo que se CARGA (src, srcset, <link href>, url() de un estilo) nunca viene de afuera; un <a href> a la
        // plataforma es navegación y se espera (los enlaces de PR, pedidos y «dónde se decide»)
        const valor = `\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`;   // con comillas dobles, simples o sin comillas
        const cargas = [...res.texto.matchAll(new RegExp(`[\\s/](?:src|srcset)${valor}`, 'gi')), ...res.texto.matchAll(new RegExp(`<link\\b[^>]*[\\s/]href${valor}`, 'gi')), ...res.texto.matchAll(/url\(\s*['"]?([^'")]+)/g)]
          .map((m) => [m[0], m[1] ?? m[2] ?? m[3]]);
        for (const m of cargas) assert.ok(!/^(https?:)?\/\//.test(m[1]), `${r.path}: nada se carga de afuera (${m[1]})`);
        assert.doesNotMatch(res.texto, /<script(?![^>]*\bsrc=)[^>]*>/i, `${r.path}: ningún <script> en línea`);
        assert.doesNotMatch(res.texto, /fonts\.googleapis|fonts\.gstatic/, `${r.path}: tampoco la tipografía`);
      }
    }
  });
});

test('T13 2.36-Arnes_SinEnlaceConSello @story-2.36 @ac-9 — Arnés no enlaza la página vieja del tablero, y su sello sigue', async () => {
  const modelo = modeloCompleto({ tablero: leida({ sello: { generado: `${HOY}T06:00:00Z`, completo: true } }) });
  const html = views.paginaArnes({ modelo: access.filtrar(modelo, { rol: 'maintainer' }, access.crearReglas({})), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  assert.doesNotMatch(html, /\/arnes\/tablero/, 'sin enlace a la página vieja');
  assert.match(html, new RegExp(`${HOY} · completa`), 'el sello dice si el nocturno corrió, con su fecha');
  assert.strictEqual(views.tableroServido, undefined, 'la vista que servía la página ya no existe');
});

test('T14 2.36-RutaTablero_404 @story-2.36 @ac-9 — GET /arnes/tablero contesta 404, como cualquier ruta que no existe', async () => {
  const { RUTAS } = require(path.join(H.SITE, 'server.js'));
  assert.ok(!RUTAS.some((r) => r.path === '/arnes/tablero'), 'la ruta no está declarada');
  await conSitio(modeloCompleto({ tablero: leida({ sello: { generado: `${HOY}T06:00:00Z`, completo: true } }) }), CONFIG, async ({ h, entrar }) => {
    const s = await entrar(LEAD);
    const t = await h.pedir('/arnes/tablero', { cookie: s });
    const otra = await h.pedir('/no-existe', { cookie: s });
    assert.strictEqual(t.status, 404);
    assert.strictEqual(t.status, otra.status, 'la misma respuesta que una ruta que no existe');
    assert.doesNotMatch(t.texto, /Seis preguntas|tablero-sello/, 'nada de la página vieja');
  });
});

test('T34 Inicio_Dev_SoloLoSuyo_ConCantidades', async () => {
  // el espejo del buzón: 3 corridas de A en los últimos 7 días (una con DOS copias del mismo volcado) y una de hace 10
  const espejo = fs.mkdtempSync(path.join(os.tmpdir(), 'site-t34-'));
  const volcado = (maq, sid, ini, nombre) => {
    fs.mkdirSync(path.join(espejo, maq), { recursive: true });
    fs.writeFileSync(path.join(espejo, maq, nombre || `${sid}.json`), JSON.stringify({ archivedAt: ini, marker: { sessionId: sid, startedAt: ini, lastTouch: ini, stepsCompleted: [] } }));
  };
  volcado('maq-a-11111111', 's1', '2026-10-14T10:00:00Z');
  volcado('maq-a-11111111', 's1', '2026-10-14T10:00:00Z', 's1-copia.json');
  volcado('maq-a-11111111', 's2', '2026-10-12T10:00:00Z');
  volcado('maq-a-11111111', 's3', '2026-10-15T09:00:00Z');
  volcado('maq-a-11111111', 's4', '2026-10-05T10:00:00Z');
  volcado('maq-b-22222222', 's5', '2026-10-15T09:30:00Z');
  try {
    const corridas = sources.leerCorridas(espejo);
    assert.strictEqual(corridas.estado, 'medido');
    const modelo = modeloCompleto({
      corridas,
      pedidos: leida({ lista: [{ id: 501, proyecto: 'Proyecto X', tipo: 'Bug', estado: 'Active', asignado: A, dias: 3, enlace: 'https://dev.example/wi/501', dependencias: true }] }),
    });
    const quien = access.quienPide({ email: A, sub: 'x' }, { config: CONFIG });
    // lo informado, leído del mismo espejo con el lector real
    const personas = { informados: require(path.join(H.SITE, '..', 'lib', 'people.js')).leerCorreosInformados(espejo), repos: null };
    const m = access.filtrar(modelo, quien, access.crearReglas({ config: CONFIG, modelo, personas }));
    const ini = views.inicioDev(m, { ahora: AHORA });
    assert.strictEqual(ini.corridas.en7dias, 3, '3 ejecuciones en 7 días (la copia cuenta una vez)');
    assert.strictEqual(ini.corridas.ultima, '2026-10-15');
    assert.deepStrictEqual(ini.prs.lista.map((p) => p.numero), [7], 'sus PR');
    assert.deepStrictEqual(ini.pedidos.lista.map((p) => [p.id, p.dependencias]), [[501, true]], 'el Bug de dependencias marcado');
    const html = views.paginaInicio({ modelo: m, quien, pestanas: [], ahora: AHORA });
    assert.match(html, /3 ejecuciones en 7 días/);
    assert.ok(!html.includes('maq-b-22222222') && !html.includes('#8') && !html.includes('/pr/8'), 'nada de B');
  } finally { fs.rmSync(espejo, { recursive: true, force: true }); }
});

// ── el cruce con datos como los reales ──────────────────────────────────────────────────────────────────────────
function modeloDesde(extra, { ahora = AHORA } = {}) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'site-r6-'));
  const clon = path.join(raiz, 'operaciones');
  for (const [rel, c] of Object.entries(H.archivosDeOperaciones({ extra }))) {
    if (c === null) continue;
    fs.mkdirSync(path.dirname(path.join(clon, rel)), { recursive: true });
    fs.writeFileSync(path.join(clon, rel), typeof c === 'string' ? c : JSON.stringify(c));
  }
  try { return sources.construirDesdeClon(clon, { ahora }); } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
}

test('2.23-R6 Proyectos_CruceConDatosReales', () => {
  const st = (grupo, dias) => ({ grupo, canonico: 'in-progress', dias_en_estado: dias });
  const m = modeloDesde({
    // repos.json lista los repos de CÓDIGO, con el proyecto codificado; las fotos por proyecto son de los repos de stories
    'scripts/nightly/dependencies/repos.json': { repos: [
      { producto: 'Producto Uno', ruta: 'Uno/front', ado: 'Proyecto%20Uno/Front', activo: true },
      { producto: 'Producto Uno', ruta: 'Uno/back', ado: 'Proyecto%20Uno/Back', activo: true },
      { producto: 'Producto Web', ruta: 'web', github: 'acme/web', activo: true },
      { producto: 'Producto Viejo', ruta: 'viejo', ado: 'Proyecto Viejo/Repo', activo: true },
    ] },
    // los días de «parada» vienen del sources.json de la organización: sin ellos, paradas «no medido»
    'scripts/nightly/dashboard/sources.json': { ...H.archivosDeOperaciones()['scripts/nightly/dashboard/sources.json'], params: { edad_en_estado_dias: [30, 60] } },
    '.dashboard/proyectos/Proyecto Uno__Stories.json': { proyecto: 'Proyecto Uno', repo: 'Stories', generated_at: `${HOY}T06:00:00Z`, stories: [st('en_curso', 40), st('en_curso', 3)] },
    '.dashboard/proyectos/Proyecto Viejo__Stories.json': { proyecto: 'Proyecto Viejo', repo: 'Stories', generated_at: '2026-10-01T06:00:00Z', stories: [st('en_curso', 3)] },
    [`.dashboard/dependencias/dependencias-${HOY}.json`]: { fecha: HOY, resumen: { rubros: { nuevos: { valor: [] }, vivas_por_proyecto: { valor: [{ proyecto: 'Proyecto Uno', ids: ['a', 'b', 'c'] }] } } } },
  });
  const { filas } = views.filasProyectos(access.filtrar(m, { rol: 'maintainer' }, access.crearReglas({})));
  const uno = filas.find((f) => f.producto === 'Producto Uno');
  assert.deepStrictEqual([uno.medido, uno.en_curso, uno.paradas, uno.vivas], [true, 2, 1, 3], 'el proyecto decodificado cruza fotos y vulnerabilidades');
  assert.ok(filas.some((f) => f.producto === 'Producto Web'), 'una entrada de GitHub también es un producto');
  const viejo = filas.find((f) => f.producto === 'Producto Viejo');
  assert.strictEqual(viejo.medido, false, 'una foto por proyecto de hace dos semanas no cuenta como al día');
  assert.match(viejo.motivo, /vieja|2026-10-01/);
  // la vista de una persona cruza igual
  // dónde trabaja A lo da people.js: acá, el producto agregado en la configuración
  const cfg = { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] }, people: { machines: { 'maq-a-11111111': { person: A } }, projects: { [A]: { add: ['Producto Uno'] } } } };
  const persona = access.filtrar(m, access.quienPide({ email: A, sub: 's' }, { config: cfg }), access.crearReglas({ config: cfg, modelo: m, personas: { informados: null, repos: [] } }));
  assert.deepStrictEqual(persona.dependencias.vivas_por_proyecto, { 'Proyecto Uno': 3 });
  assert.strictEqual(persona.proyectos.lista.length, 1);
  // vivas sin medir en la foto: «no medido», nunca 0
  const sinVivas = modeloDesde({ [`.dashboard/dependencias/dependencias-${HOY}.json`]: { fecha: HOY, resumen: { rubros: { nuevos: { valor: [] }, vivas_por_proyecto: { valor: null, motivo: 'no se pudo' } } } } });
  const f2 = views.filasProyectos(access.filtrar(sinVivas, { rol: 'maintainer' }, access.crearReglas({}))).filas;
  assert.ok(f2.every((f) => f.vivas === null), 'vivas sin medir no es 0');
});

test('2.23-R7 Inicio_SuitesNoMedidas_PrSinFecha_MaquinaUnida', () => {
  const m = modeloDesde({
    [`.dashboard/controls-bench/suites-${HOY}.json`]: { ts: `${HOY}T05:00:00Z`, corridas: 10, failures: ['a.test.js', 'b.test.js (no-medida)'], unmeasured: ['b.test.js'], complete: false },
    [`.dashboard/open-prs/open-prs-${HOY}.json`]: { estado: 'medido', prs: [{ numero: 1, proyecto: 'P', repo: 'R', dias: 5, autor: A }, { numero: 2, proyecto: 'P', repo: 'R', dias: null, autor: A }] },
    [`.dashboard/vigilante/vigilante-${HOY}.json`]: { fecha: HOY, productos: { 'producto x': { ok: true } }, resumen: { rubros: { pendientes: { valor: [] }, aceptadas_sin_story: { valor: [] } } } },
  });
  assert.deepStrictEqual(m.suites.rojas, ['a.test.js'], 'una suite no medida no es una roja');
  const filas = filasDe(m);
  assert.match(fila(filas, 'prs_trabados').detalle || '', /1 sin fecha/, 'el PR sin fecha se cuenta aparte');
  assert.strictEqual(views.filasArnes(access.filtrar(m, { rol: 'maintainer' }, access.crearReglas({})), {}).find((l) => l.clave === 'suites').texto, '1 nuevas desde anoche, de 1 rojas · 1 sin medir, de 10', 'con la foto de ayer, las nuevas (2.79 AC 3)');
  // el vigilante, para una persona, con el nombre del producto en otra forma (minúsculas, espacios)
  const cfg = { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] }, people: { machines: { 'maq-a-11111111': { person: A } }, projects: { [A]: { add: ['Producto X'] } } } };
  const conVig = { ...m, productos: [{ producto: 'Producto X', proyectos: [], rutas: [] }] };
  const p = access.filtrar(conVig, access.quienPide({ email: A, sub: 's' }, { config: cfg }), access.crearReglas({ config: cfg, modelo: conVig, personas: { informados: null, repos: [] } }));
  assert.deepStrictEqual(p.vigilante.productos, ['producto x'], 'el filtro del vigilante compara como la vista');
  // una carpeta vieja unida y su nueva, las dos sin confirmar: una sola máquina por confirmar
  const r = access.crearReglas({ config: {}, modelo: {}, personas: { informados: H.informados({ 'maq-1a2b3c4d': null }, { maq: { estado: 'unida', nueva: 'maq-1a2b3c4d' } }), repos: null } });
  assert.strictEqual(r.sinConfirmar([{ maquina: 'maq' }, { maquina: 'maq-1a2b3c4d' }]), 1);
});

test('2.23-R8 Version_LaFilaDelArnes', () => {
  const lineas = views.filasArnes({}, { version: '2026.10.15.99' });
  assert.strictEqual(lineas.find((l) => l.clave === 'version').texto, '2026.10.15.99');
  assert.strictEqual(views.filasArnes({}, {}).find((l) => l.clave === 'version').estado, 'no_medido', 'sin version.json, no medido');
});

// La paridad en Proyectos, sólo cantidades por repo. El archivo se lee de un repo de operaciones de
// verdad (sources.js) para que la lista blanca de la lectura quede probada: `divergencias[]` no llega al modelo.
test('T45 Proyectos_ParidadSoloCantidades', () => {
  const MARCA = 'RASGO-LIBRE-MARCADOR';
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'site-t45-'));
  const armar = (paridad) => {
    const clon = path.join(raiz, `c-${Math.random().toString(36).slice(2)}`, 'operaciones');
    const archivos = H.archivosDeOperaciones({ extra: {
      'scripts/nightly/dependencies/repos.json': { repos: [
        { producto: 'Producto X', ruta: 'X/back', ado: 'Proyecto X/Back', activo: true },
        { producto: 'Producto X', ruta: 'X/front', ado: 'Proyecto X/Front', activo: true },
        { producto: 'Producto Y', ruta: 'Y/back', ado: 'Proyecto Y/Back', activo: true },
        { producto: 'Producto Z', ruta: 'Z/back', ado: 'Proyecto Z/Back', activo: true },
      ] },
      ...(paridad ? { [`.dashboard/paridad/paridad-${HOY}.json`]: paridad } : {}),
    } });
    for (const [rel, c] of Object.entries(archivos)) {
      fs.mkdirSync(path.dirname(path.join(clon, rel)), { recursive: true });
      fs.writeFileSync(path.join(clon, rel), typeof c === 'string' ? c : JSON.stringify(c));
    }
    return sources.construirDesdeClon(clon, { ahora: AHORA });
  };
  try {
    const m = armar({
      estado: 'parcial', motivo: null, rc: 1,
      divergencias: [{ grupo: 'g', que: MARCA, tienen: ['Producto Y'], no_tienen: ['Producto X'] }],
      por_ruta: [
        { ruta: 'X/back', estado: 'medido', motivo: null, divergencias: 2, vencidas: 1 },
        { ruta: 'X/front', estado: 'medido', motivo: null, divergencias: 0, vencidas: 0 },
        { ruta: 'Y/back', estado: 'medido', motivo: null, divergencias: 0, vencidas: 0 },
        { ruta: 'Z/back', estado: 'desde_disco', motivo: 'sin_clon', divergencias: 0, vencidas: 0 },
      ],
    });
    assert.ok(!JSON.stringify(m).includes(MARCA), 'divergencias[] no llega al modelo');
    const filtrado = access.filtrar(m, { rol: 'maintainer' }, access.crearReglas({}));
    const { filas } = views.filasProyectos(filtrado);
    const par = (p) => filas.find((f) => f.producto === p).paridad;
    assert.deepStrictEqual([par('Producto X').estado, par('Producto X').texto], ['a_decidir', 'a decidir: 2 divergencias · 1 vencida']);
    assert.deepStrictEqual([par('Producto Y').estado, par('Producto Y').texto], ['en_orden', 'en orden']);
    assert.strictEqual(par('Producto Z').estado, 'sin_medir');
    assert.match(par('Producto Z').texto, /sin medir: .*sin clon/);
    const html = views.paginaProyectos({ modelo: filtrado, quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
    assert.match(html, /a decidir: 2 divergencias · 1 vencida/);
    assert.ok(!html.includes(MARCA));
    // el archivo entero sin productos: en gris con su motivo
    const sinProd = views.filasProyectos(access.filtrar(armar({ estado: 'sin_productos', motivo: null, por_ruta: [], divergencias: [] }), { rol: 'maintainer' }, access.crearReglas({}))).filas;
    assert.strictEqual(sinProd[0].paridad.estado, 'no_medido');
    assert.match(sinProd[0].paridad.texto, /sin productos/);
    // sin el archivo
    const sinArchivo = views.filasProyectos(access.filtrar(armar(null), { rol: 'maintainer' }, access.crearReglas({}))).filas;
    assert.strictEqual(sinArchivo[0].paridad.texto, 'no medido: la noche no dejó la paridad');
  } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
});

test('T28b Inicio_Mantenedor_PrsTrabados_LlevaASuLista — la ficha dice dónde se mira, como las demás', () => {
  const filas = filasDe(modeloCompleto());
  assert.strictEqual(fila(filas, 'prs_trabados').enlace, '#prs-trabados');
  const m = modeloCompleto({ prs: leida({ lista: [
    { numero: 7, proyecto: 'Proyecto X', repo: 'Repo X', dias: 5, autor: A, enlace: 'https://dev.example/pr/7' },
    { numero: 8, proyecto: 'Proyecto X', repo: 'Repo X', dias: 1, autor: B, enlace: 'https://dev.example/pr/8' },
    { numero: 9, proyecto: 'Proyecto Y', repo: 'Repo Y', dias: null, autor: B, enlace: 'javascript:alert(1)' },
  ] }) });
  const html = views.paginaInicio({ modelo: access.filtrar(m, { rol: 'maintainer' }, access.crearReglas({})), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  assert.match(html, /<a href="#prs-trabados">ver cuáles \(cada una lleva a donde se decide\)<\/a>/, 'lleva a una lista de esta página, no a donde se decide');
  assert.match(html, /<section class="q" id="prs-trabados">/);
  assert.match(html, /<a href="https:\/\/dev\.example\/pr\/7">#7<\/a><span>Proyecto X \/ Repo X · 5 días<\/span>/);
  assert.doesNotMatch(html, /pr\/8/, 'el de un día no está trabado');
  assert.match(html, /#9 · Proyecto Y \/ Repo Y · sin fecha/, 'el sin fecha se lista, sin enlace que no sea http');
  assert.doesNotMatch(html, /javascript:/);
  // sin la foto de la noche, la lista dice por qué
  const sin = views.paginaInicio({ modelo: access.filtrar(modeloCompleto({ prs: noMedida('sin_foto') }), { rol: 'maintainer' }, access.crearReglas({})), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  assert.match(sin, /id="prs-trabados"><div class="q-head"><h2>Pull requests abiertos hace más de 2 días<\/h2><\/div><p class="q-note">[^<]+<\/p>/);
});

// un producto cuyos repos no usan stories del arnés lo dice, en vez de «no medido», si la foto de anoche existe
const modeloSinStories = (fotos) => ({
  productos: [{ producto: 'Alfa', proyectos: ['Alfa'], rutas: ['Alfa/Web'] }, { producto: 'Zeta', proyectos: ['Plugins'], rutas: ['Plugins/Back'] }],
  productosFuente: { estado: 'medido', codigo: null, motivo: null, fecha: HOY },
  proyectos: fotos,
});

test('T9 Producto_SinStoriesDelArnes', () => {
  const m = modeloSinStories({ estado: 'medido', fecha: HOY, lista: [{ proyecto: 'Alfa', repo: 'Stories', fecha: HOY, vieja: false, stories: [] }] });
  const zeta = views.filasProyectos(m).filas.find((f) => f.producto === 'Zeta');
  assert.strictEqual(zeta.medido, false);
  assert.strictEqual(zeta.sin_stories, true);
  assert.strictEqual(zeta.motivo, 'sus repos no usan stories del arnés');
  const pagina = views.paginaProyectos({ modelo: m, quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  assert.match(pagina, /sus repos no usan stories del arnés/);
  assert.doesNotMatch(pagina, /no medido: sus repos no usan/, 'no se presenta como «no medido»');
});

test('T10 Producto_SinFotoDeAnoche_SigueNoMedido', () => {
  // sólo fotos viejas: no se sabe si el nocturno de métricas corrió, así que no se afirma que no usa stories
  const viejas = modeloSinStories({ estado: 'medido', fecha: HOY, lista: [{ proyecto: 'Alfa', repo: 'Stories', fecha: '2026-10-01', vieja: true, stories: [] }] });
  const zeta = views.filasProyectos(viejas).filas.find((f) => f.producto === 'Zeta');
  assert.strictEqual(zeta.sin_stories, undefined);
  assert.strictEqual(zeta.motivo, 'sin lectura de sus proyectos');
  // sin ninguna foto (la fuente no medida): la frase de la fuente, sin cambios
  const nada = views.filasProyectos(modeloSinStories({ estado: 'no_medido', codigo: 'sin_foto', motivo: null, fecha: null, lista: [] })).filas.find((f) => f.producto === 'Zeta');
  assert.ok(!nada.sin_stories);
  assert.notStrictEqual(nada.motivo, 'sus repos no usan stories del arnés');
});

test('8.101-Retrospectivas_SinFotoComoHoy_ConFotoSeVe', () => {
  const RETROS = (dia) => `.dashboard/retros/retros-${dia}.json`;
  const pendientes = [{ repo: 'Producto-X/FrontEnd', merge: 'abc1234', dias: 2 }, { repo: 'Producto-Y/Backend', merge: 'def5678', dias: 1 }];
  const retro = (extra) => fila(filasDe(modeloDesde(extra)), 'retrospectivas');
  const deHoy = filasDe(modeloCompleto()).find((f) => f.clave === 'retrospectivas');
  // sin la foto, con una de ayer o con una que no vale: la tarjeta de siempre, no medida y con su motivo
  for (const [caso, extra] of [
    ['sin la foto', {}],
    ['con la de ayer', { [RETROS('2026-10-14')]: { v: 1, fecha: '2026-10-14', estado: 'medido', pendientes } }],
    ['con una que no vale', { [RETROS(HOY)]: { v: 1, fecha: HOY, estado: 'medido', pendientes: 'muchas' } }],
    ['con una no medida', { [RETROS(HOY)]: { v: 1, fecha: HOY, estado: 'no_medido', pendientes: [] } }],
  ]) {
    const r = retro(extra);
    assert.strictEqual(r.estado, 'no_medido', caso);
    assert.strictEqual(r.valor, null, `${caso}: nunca 0`);
    assert.strictEqual(r.motivo, deHoy.motivo, `${caso}: el motivo de siempre`);
  }
  // con la de hoy, la cuenta
  const r = retro({ [RETROS(HOY)]: { v: 1, fecha: HOY, estado: 'medido', pendientes } });
  assert.strictEqual(r.estado, 'medido');
  assert.strictEqual(r.valor, 2);
});

// Inicio_Vulnerabilidades_DicenSeguimiento
// 🔴 Falla con: un recuadro de lo que sólo se sigue (las rechazadas sin deuda, que cada equipo sigue en su tarea) que diga
// «decidir», o las dependencias por decidir, que se deciden en Mantenimiento, diciendo «seguimiento».
test('T11 Inicio_Vulnerabilidades_DicenSeguimiento — las por decidir dicen «decidir»; las rechazadas sin deuda, «seguimiento»', () => {
  const html = views.paginaInicio({ modelo: access.filtrar(modeloCompleto({ vigilante: noMedida('sin_foto') }), { rol: 'maintainer' }, access.crearReglas({})), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA, esperan: () => 4 });
  const recuadro = (titulo) => html.split('<div class="tile ').find((x) => x.includes(`<div class="t-label">${titulo}</div>`)) || '';
  for (const titulo of ['Dependencias por decidir', 'Dependencias rechazadas sin deuda']) assert.ok(recuadro(titulo), `${titulo}: el recuadro está`);
  assert.doesNotMatch(recuadro('Dependencias rechazadas sin deuda'), />decidir</, 'lo que sólo se sigue no dice decidir');
  assert.match(recuadro('Dependencias por decidir'), />decidir</, 'se deciden en Mantenimiento');
  assert.match(recuadro('Dependencias por decidir'), /href="\/mantenimiento"/, 'y «dónde se decide» lleva ahí');
  assert.match(recuadro('Dependencias por decidir'), />4</, 'con el número de Mantenimiento');
  assert.match(recuadro('Pull requests abiertos hace más de 2 días'), />decidir</, 'los demás siguen diciendo decidir');
});

// ── el sitio coherente: cada cuenta dice de cuándo es y qué cuenta, y cada gris dice qué falta ──────────────────────
const deMantenedor = (modelo) => access.filtrar(modelo, { rol: 'maintainer', email: LEAD }, access.crearReglas({}));
const sinEtiquetas = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const tarjetaDe = (html, titulo) => html.split('<div class="tile ').find((x) => x.includes(`<div class="t-label">${titulo}</div>`)) || '';

// T3 2.79-Arnes_SuitesRojas_DiceCuantasNuevasYCuales @story-2.79 @ac-3
// 🔴 Falla con: Arnés diciendo sólo «N rojas» cuando Inicio cuenta las nuevas, o sin la lista con las nuevas marcadas.
test('T3 2.79-Arnes_SuitesRojas_DiceCuantasNuevasYCuales @story-2.79 @ac-3 — el mismo N que Inicio, y la lista', () => {
  const modelo = modeloCompleto({ suites: leida({ rojas: ['a.test.js', 'b.test.js', 'c.test.js'], sin_medir: 1, total: 300, ayer: { fecha: '2026-10-14', rojas: ['a.test.js'] } }) });
  const linea = views.filasArnes(deMantenedor(modelo), { ahora: AHORA }).find((l) => l.clave === 'suites');
  assert.strictEqual(linea.texto, '2 nuevas desde anoche, de 3 rojas · 1 sin medir, de 300');
  assert.deepStrictEqual(linea.lista, [{ nombre: 'a.test.js', nueva: false }, { nombre: 'b.test.js', nueva: true }, { nombre: 'c.test.js', nueva: true }]);
  assert.strictEqual(fila(filasDe(modelo), 'suites_rojas_nuevas').valor, 2, 'Inicio cuenta las mismas dos');
  const html = views.paginaArnes({ modelo: deMantenedor(modelo), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  assert.match(html, /<li class="nueva">b\.test\.js <b>nueva<\/b><\/li>/, 'la nueva, marcada');
  assert.match(html, /<li>a\.test\.js<\/li>/, 'la de ayer, sin marca');
});

// T4 2.79-Vulnerabilidades_CadaCuentaDiceQueCuenta @story-2.79 @ac-4
// 🔴 Falla con: las tres cuentas de vulnerabilidades sin decir de cuándo son ni qué cuentan (Mantenimiento lo prueba
//    en su HTML T5 de site-findings; acá, su texto).
test('T4 2.79-Vulnerabilidades_CadaCuentaDiceQueCuenta @story-2.79 @ac-4 — Inicio «de la noche del», Mantenimiento «al momento», Proyectos «por proyecto»', () => {
  const m = deMantenedor(modeloCompleto({ generado: AHORA }));
  const inicio = views.paginaInicio({ modelo: m, quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  assert.match(tarjetaDe(inicio, 'Dependencias aceptadas sin resolver'), /de la noche del 2026-10-15/);
  const textos = require(path.join(H.SITE, 'texts.js'));
  assert.match(textos.t('es', 'mant.vuln.resumen'), /al momento/);
  const proyectos = views.paginaProyectos({ modelo: m, quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  assert.match(proyectos, /por proyecto: un paquete cuenta en cada proyecto donde aparece/);
});

// T14 2.79-Arnes_UltimaPublicada_DiceCuandoSeMiro @story-2.79 @ac-12
// 🔴 Falla con: «Última publicada» sin decir contra qué (stable) ni cuándo se miró; o la vigía perdiendo la hora.
test('T14 2.79-Arnes_UltimaPublicada_DiceCuandoSeMiro @story-2.79 @ac-12 — «stable (mirada HH:MM)»', async () => {
  const ultima = { estado: 'medido', version: '2026.10.15.3', creada: '2026-10-14T20:00:00Z', mirado: Date.parse('2026-10-15T09:41:00Z') };
  const l = views.filasArnes({}, { version: '2026.10.15.1', ultima }).find((x) => x.clave === 'ultima');
  assert.match(l.texto, /^2026\.10\.15\.3 \(del 2026-10-14\) · última publicada en stable \(mirada 09:41 UTC\)$/);
  // la vigía guarda cuándo miró y lo devuelve con lo medido
  const LR = require(path.join(H.SITE, 'latest-release.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultima-'));
  try {
    fs.writeFileSync(path.join(dir, 'ultima-publicada.json'), JSON.stringify(ultima));
    const v = LR.crearVigia({ imagen: 'ghcr.io/acme/arnes', dataDir: dir, ahora: () => ultima.mirado + 60000 });
    assert.strictEqual(v.estado().mirado, ultima.mirado);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// T17 2.79-Proyectos_Filtro_FilasLlevanSusNumerosParaElTotal @story-2.79 @ac-14
// En el navegador fijo del arnés (scripts/lib/pinned-playwright.js); sin él se saltea con constancia, salvo con la llave
// exigente (E2E_REQUIRED=1).
// 🔴 Falla con: filtrar Proyectos y que el total y Estimaciones sigan siendo los de todos los productos.
const PINNED_PW = require('../lib/pinned-playwright.js');
const PLAYWRIGHT = PINNED_PW.load();
const SIN_NAVEGADOR = process.env.E2E_REQUIRED === '1' ? false : (!PLAYWRIGHT && PINNED_PW.locate().why);
test('T17 2.79-Proyectos_Filtro_FilasLlevanSusNumerosParaElTotal @story-2.79 @ac-14', { skip: SIN_NAVEGADOR, timeout: 120000 }, async () => {
  assert.ok(PLAYWRIGHT, `con la llave exigente prendida, Playwright tiene que estar: ${PINNED_PW.locate().why}`);
  const st = (grupo, canonico, dias) => ({ grupo, canonico, dias_en_estado: dias });
  const modelo = modeloCompleto({
    productos: [{ producto: 'Producto X', proyectos: ['Proyecto X', 'Compartido'] }, { producto: 'Producto Y', proyectos: ['Compartido'] }],
    proyectos: leida({ lista: [
      { proyecto: 'Proyecto X', repo: 'Repo X', fecha: HOY, stories: [st('en_curso', 'in-progress', 45), st('en_curso', 'review', 10), st('en_curso', 'in-progress', null)] },
      { proyecto: 'Compartido', repo: 'Repo C', fecha: HOY, stories: [st('en_curso', 'in-progress', 1), st('en_curso', 'in-progress', 2)] },
    ] }),
  });
  // cada fila lleva sus números, por proyecto (lo compartido se suma una vez)
  const html = views.paginaProyectos({ modelo: deMantenedor(modelo), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  assert.match(html, /<tr data-producto="Producto Y" data-por-proyecto="[^"]*Compartido/);
  await conSitio(modelo, CONFIG, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    const navegador = await PLAYWRIGHT.chromium.launch();
    try {
      const ctx = await navegador.newContext();
      await ctx.setExtraHTTPHeaders({ cookie: lead });
      const page = await ctx.newPage();
      await page.goto(`${h.base}/proyectos`);
      const total = page.locator('#proyectos-totales');
      assert.match(await total.innerText(), /5 en curso, paradas: 1,/, 'sin filtro, el total de todos');
      await page.locator('input[data-filtro="proyectos"]').fill('producto y');
      assert.match(await total.innerText(), /2 en curso, paradas: 0,/, 'filtrado, el total del producto que queda');
      const visibles = await page.locator('#tabla-estimaciones tbody tr:not([hidden])').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-producto')));
      assert.ok(visibles.length && visibles.every((p) => p === 'Producto Y'), `Estimaciones, sólo el producto que queda: ${visibles}`);
      await page.locator('input[data-filtro="proyectos"]').fill('');
      assert.match(await total.innerText(), /5 en curso, paradas: 1,/, 'sin filtro otra vez, el de todos');
    } finally { await navegador.close(); }
  });
});

// T19 2.79-Inicio_CadaFichaDiceDeCuandoEs @story-2.79 @ac-16
// 🔴 Falla con: una ficha de Inicio con «fuente del» suelto, sin decir si es de la noche o del momento.
test('T19 2.79-Inicio_CadaFichaDiceDeCuandoEs @story-2.79 @ac-16 — «al momento» para lo vivo, la noche para lo declarado', () => {
  const m = deMantenedor(modeloCompleto({ generado: AHORA }));
  const html = views.paginaInicio({ modelo: m, quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA, esperan: () => 3 });
  assert.match(tarjetaDe(html, 'Dependencias por decidir'), /al momento/);
  assert.match(tarjetaDe(html, 'Datos declarados que vencen en 7 días'), /de la noche del 2026-10-15/);
  assert.doesNotMatch(html, /fuente del/, 'ninguna ficha dice «fuente del» suelto');
});

// T20 2.79-Inicio_MaquinasSinConfirmar_Cargando_NoDiceNoMedido @story-2.79 @ac-17
// 🔴 Falla con: la ficha de máquinas en NO MEDIDO mientras el sitio carga, sin recargarse sola, o con «fuente del» cuando
//    la cuenta es de lo leído recién.
test('T20 2.79-Inicio_MaquinasSinConfirmar_Cargando_NoDiceNoMedido @story-2.79 @ac-17 — «cargando», recarga sola, después «leído HH:MM»', () => {
  // con lo que informó cada máquina (como filasDe): sin eso, la cuenta no se sabe
  const reglas = (modelo) => access.crearReglas({ config: {}, modelo, personas: { informados: H.informados({ 'maq-x-12345678': null }), repos: null } });
  const pagina = (modelo) => views.paginaInicio({ modelo: access.filtrar(modelo, { rol: 'maintainer', email: LEAD }, reglas(modelo)), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  const cargando = pagina(modeloCompleto({ corridas: noMedida('cargando'), generado: AHORA }));
  const t = tarjetaDe(cargando, 'Máquinas sin confirmar con ejecuciones');
  assert.ok(t.startsWith('cargando'), `la ficha está cargando, no gris: ${t.slice(0, 40)}`);
  assert.doesNotMatch(t, /no medido|buzón/i);
  assert.match(cargando, /<meta http-equiv="refresh" content="\d+">/, 'Inicio se recarga sola mientras carga');
  const leido = pagina(modeloCompleto({ generado: Date.parse('2026-10-15T11:58:00Z') }));
  assert.match(tarjetaDe(leido, 'Máquinas sin confirmar con ejecuciones'), /leído 11:58 UTC/);
  assert.doesNotMatch(leido, /<meta http-equiv="refresh"/, 'leído, ya no se recarga');
});

// T27 2.79-Sello_NoPrometeSeisPreguntas @story-2.79 @ac-24
// 🔴 Falla con: Arnés prometiendo «seis preguntas» que no están en la pantalla.
test('T27 2.79-Sello_NoPrometeSeisPreguntas @story-2.79 @ac-24 — «El tablero de la noche», con las fichas repartidas', () => {
  const html = views.paginaArnes({ modelo: deMantenedor(modeloCompleto()), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  assert.doesNotMatch(html, /seis preguntas/i);
  assert.match(html, /El tablero de la noche/);
  assert.match(html, /repartidas entre Arnés, Proyectos y Ejecuciones/);
});

// T35 2.79-Grises_CadaMotivoDiceQueFaltaYQueHacer @story-2.79 @ac-32
// 🔴 Falla con: «no medido: no medido», un código crudo (no_medido, sin_declarar), «N sin medir» sin decir qué falta, o
//    una fuente vieja que no nombra el proceso que la produce.
test('T35 2.79-Grises_CadaMotivoDiceQueFaltaYQueHacer @story-2.79 @ac-32 — motivos llanos, sin códigos', () => {
  const st = (grupo, canonico, dias) => ({ grupo, canonico, dias_en_estado: dias });
  const modelo = modeloCompleto({
    productos: [{ producto: 'Producto X', proyectos: ['Proyecto X'] }, { producto: 'Producto Z', proyectos: [] }],
    proyectos: leida({ lista: [{ proyecto: 'Proyecto X', repo: 'Repo X', fecha: HOY, stories: [st('en_curso', 'in-progress', null)] }] }),
    despliegues: leida({ productos: {
      'Producto X': { estado: 'medido', motivo: 'ok', staging: { fecha: '2026-10-14' }, produccion: null, produccion_atrasada: null, aprobacion: { estado: 'no_medido', motivo: 'az_fallo' }, main: 'ok' },
      'Producto Z': { estado: 'no_medido', motivo: 'sin_declarar', staging: null, produccion: null, produccion_atrasada: null, aprobacion: { estado: 'no_medido', motivo: 'sin_declarar' }, main: 'no_medido' },
    } }),
    examen: { estado: 'no_medido', codigo: 'fuente_vieja', motivo: null, fecha: '2026-10-11' },
  });
  const proyectos = sinEtiquetas(views.paginaProyectos({ modelo: deMantenedor(modelo), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA }));
  assert.doesNotMatch(proyectos, /no medido: no medido/);
  assert.match(proyectos, /sin despliegue declarado en Configuración → Despliegues/);
  assert.doesNotMatch(proyectos, /\b(no_medido|sin_declarar|az_fallo)\b/, 'sin códigos crudos');
  assert.match(proyectos, /sin despliegue a producción para comparar/, 'el atraso con su motivo');
  assert.match(proyectos, /sin la fecha en que entraron a su estado: 1/);
  const arnes = sinEtiquetas(views.paginaArnes({ modelo: deMantenedor(modelo), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA }));
  assert.match(arnes, /más vieja que su antigüedad máxima[^·]*· la deja el proceso de la noche del tablero/, 'la fuente vieja nombra el proceso');
});

// T59 2.79-Proyectos_FechasSinPartir @story-2.79 @ac-48
// 🔴 Falla con: las fechas de prueba y producción en celdas que pueden partir renglón, o una entrada que no nombra
//    alguna de las diez columnas de datos.
test('T59 2.79-Proyectos_FechasSinPartir @story-2.79 @ac-48 — las fechas no parten renglón y la entrada nombra las diez columnas', () => {
  const { t } = require(path.join(H.SITE, 'texts.js'));
  const modelo = modeloCompleto({
    productos: [{ producto: 'Producto X', proyectos: ['Proyecto X'] }],
    proyectos: leida({ lista: [{ proyecto: 'Proyecto X', repo: 'Repo X', fecha: HOY, stories: [] }] }),
    despliegues: leida({ productos: { 'Producto X': { estado: 'medido', motivo: 'ok', staging: { fecha: '2026-10-14' }, produccion: { fecha: '2026-10-12' }, produccion_atrasada: false, aprobacion: null, main: 'ok' } } }),
  });
  const html = views.paginaProyectos({ modelo: deMantenedor(modelo), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  assert.match(html, /<span class="fecha">2026-10-14<\/span>/, 'la fecha de prueba lleva la clase de fecha');
  assert.match(html, /<span class="fecha">2026-10-12<\/span>/, 'y la de producción');
  const css = fs.readFileSync(path.join(H.SITE, 'static', 'site.css'), 'utf8');
  assert.match(css, /table\.tabla \.fecha\{[^}]*white-space:nowrap/, 'una fecha no parte renglón');
  for (const idioma of ['es', 'en']) {
    const lede = t(idioma, 'proyectos.lede').toLowerCase();
    for (const k of ['enCurso', 'paradasSinDias', 'edad', 'bloqueadas', 'enPrueba', 'enProduccion', 'aprobacion', 'vigilado', 'vivas', 'paridad']) {
      const col = t(idioma, `proyectos.col.${k}`).toLowerCase();
      assert.ok(lede.includes(col), `${idioma}: la entrada nombra «${col}»: ${lede}`);
    }
  }
});

// T67 2.79-Prolijidad_ListasSingularYSinFalta @story-2.79 @ac-56 @ac-57 @ac-58
// 🔴 Falla con: una fila de las listas de Inicio con texto suelto o con un solo hijo (la grilla la corre de columna),
//    «1 días» o «1 paradas», «Ninguno.» en una lista de dependencias, «(es)», o una ficha sin dato que dice «falta».
test('T67 2.79-Prolijidad_ListasSingularYSinFalta @story-2.79 @ac-56 @ac-57 @ac-58 — filas parejas, singular y «sin dato»', () => {
  const { t } = require(path.join(H.SITE, 'texts.js'));
  // los hijos de primer nivel de un renglón; el texto suelto entre ellos cuenta como hijo y rompe la grilla
  const hijos = (adentro) => {
    const out = [];
    let prof = 0;
    for (const trozo of adentro.split(/(<\/?[a-z][^>]*>)/i).filter((x) => x !== '')) {
      if (/^<\//.test(trozo)) { prof -= 1; continue; }
      if (/^</.test(trozo)) { if (prof === 0) out.push(trozo); prof += 1; continue; }
      if (prof === 0 && trozo.trim()) out.push(`texto suelto: ${trozo}`);
    }
    return out;
  };
  const renglones = (html) => [...html.matchAll(/<ul class="lista[^"]*">([\s\S]*?)<\/ul>/g)].flatMap((u) => [...u[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((l) => l[1]));
  const parejas = (html, donde) => {
    const filas = renglones(html);
    assert.ok(filas.length > 0, `${donde}: hay renglones para mirar`);
    for (const f of filas) {
      const h = hijos(f);
      assert.strictEqual(h.length, 2, `${donde}: dos hijos por renglón, no ${JSON.stringify(h)}`);
      assert.match(h[0], /^<a |^<span class="li-marca">/, `${donde}: primero el enlace o el marcador vacío: ${h[0]}`);
    }
  };
  const modelo = modeloCompleto({
    prs: leida({ lista: [
      { numero: 7, proyecto: 'Proyecto X', repo: 'Repo X', dias: 5, autor: A, enlace: 'https://dev.example/pr/7' },
      { numero: 9, proyecto: 'Proyecto X', repo: 'Repo X', dias: 4, autor: A, enlace: null },
      { numero: 8, proyecto: 'Proyecto X', repo: 'Repo X', dias: 1, autor: A, enlace: 'https://dev.example/pr/8' },
    ] }),
    decisiones: leida({ items: [{ fuente: 'vigilante', rubro: 'pendientes', id: 'vig-uno', titulo: 'Errores 500', pr: 12 }] }),
    vigilante: noMedida('sin_foto'),
    proyectos: leida({ lista: [{ proyecto: 'Proyecto X', repo: 'Repo X', fecha: HOY, stories: [{ grupo: 'en_curso', canonico: 'in-progress', dias_en_estado: 45 }] }] }),
    // ninguno vence en 7 días: la lista sale vacía
    declarados: leida({ lista: [{ id: 'dato-dos', review_before: '2026-12-31' }] }),
  });
  const ctxM = { modelo: deMantenedor(modelo), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA, enlaceOperaciones: 'https://dev.example/org/proj/_git/ops' };
  const inicioM = views.paginaInicio(ctxM);
  parejas(inicioM, 'Inicio de quien mantiene');
  const quienA = access.quienPide({ email: A, sub: 'x' }, { config: CONFIG });
  const inicioB = views.paginaInicio({ modelo: access.filtrar(modelo, quienA, access.crearReglas({ config: CONFIG, modelo })), quien: quienA, pestanas: [], ahora: AHORA });
  parejas(inicioB, 'Inicio de un dev');
  // singular con 1, y el femenino en las listas de dependencias vacías
  const textoM = sinEtiquetas(inicioM);
  const textoB = sinEtiquetas(inicioB);
  assert.doesNotMatch(textoB, /\b1 días/, 'un día en singular');
  assert.match(textoB, /\b1 día\b/);
  const seccionDe = (html, id) => sinEtiquetas((html.split(`id="${id}"`)[1] || '').split('</section>')[0]);
  assert.match(seccionDe(inicioM, 'decidir-dependencias_aceptadas_sin_resolver'), /Ninguna\./, 'las dependencias son femeninas');
  assert.match(seccionDe(inicioM, 'decidir-declarados_por_vencer'), /Ninguno\./, 'los datos declarados, masculinos');
  const proyectos = sinEtiquetas(views.paginaProyectos({ modelo: deMantenedor(modelo), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA }));
  assert.doesNotMatch(proyectos, /\b1 paradas/, 'una parada no va en plural');
  for (const html of [textoM, textoB, proyectos]) assert.doesNotMatch(html, /\((es|s)\)/, 'sin «(es)» ni «(s)»');
  // la ficha sin dato: «sin dato» con su motivo, nunca «falta»
  assert.doesNotMatch(textoM, /\bfalta\b/);
  assert.match(inicioM, /<div class="t-val">sin dato<\/div><div class="t-den">[^<]+<\/div>/, 'sin dato y su motivo');
  for (const idioma of ['es', 'en']) {
    for (const k of ['vista.falta', 'fichas.falta', 'corridas.falta']) {
      assert.doesNotMatch(t(idioma, k), /falta|missing/i, `${idioma} ${k}`);
    }
  }
  assert.strictEqual(t('es', 'fichas.falta'), 'sin dato');
});
