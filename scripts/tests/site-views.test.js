'use strict';
/*
 * site-views.test.js — las pestañas Inicio, Proyectos y Arnés del sitio de la organización.
 *
 * T28 Inicio_Mantenedor_LeeNoMide            T31 Cabeceras_EnCadaRespuestaConDatos
 * T29 Proyectos_ParadasCompartidosYDespliegues T34 Inicio_Dev_SoloLoSuyo_ConCantidades
 * T30 Arnes_SuitesYSoloMantenedor
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
    ...extra,
  };
}
// lo informado por la máquina del modelo: no informa correo y nadie la confirmó, así que es una por confirmar
const filasDe = (modelo) => views.filasInicioMantenedor(access.filtrar(modelo, { rol: 'maintainer', email: LEAD }, access.crearReglas({ config: {}, modelo, personas: { informados: H.informados({ 'maq-x-12345678': null }), repos: null } })), { ahora: AHORA });
const fila = (filas, clave) => filas.find((f) => f.clave === clave);

test('T28 Inicio_Mantenedor_LeeNoMide', () => {
  const filas = filasDe(modeloCompleto({ vigilante: noMedida('sin_foto') }));
  assert.deepStrictEqual(filas.map((f) => f.clave), [
    'dependencias_nuevas', 'dependencias_aceptadas_sin_resolver', 'dependencias_rechazadas_sin_deuda',
    'vigilante_pendientes', 'vigilante_aceptadas_sin_story', 'prs_trabados', 'pedidos_cerrados_con_vivas',
    'suites_rojas_nuevas', 'banco_rojos_nuevos', 'declarados_por_vencer', 'maquinas_sin_confirmar', 'retrospectivas',
  ], 'las filas en orden');
  assert.deepStrictEqual([fila(filas, 'dependencias_nuevas').estado, fila(filas, 'dependencias_nuevas').valor], ['medido', 3]);
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
  assert.strictEqual(views.filasArnes(access.filtrar(m, { rol: 'maintainer' }, access.crearReglas({})), {}).find((l) => l.clave === 'suites').texto, '1 rojas · 1 sin medir, de 10');
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
  assert.match(html, /<a href="#prs-trabados">dónde se decide<\/a>/);
  assert.match(html, /<section class="q" id="prs-trabados">/);
  assert.match(html, /<a href="https:\/\/dev\.example\/pr\/7">#7<\/a> · Proyecto X \/ Repo X · 5 días/);
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
  assert.strictEqual(zeta.motivo, 'sin foto de sus proyectos');
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
// 🔴 Falla con: un recuadro de vulnerabilidades que diga «decidir» cuando en Mantenimiento no se deciden (cada equipo
// las sigue en su tarea), o que el cambio se lleve puesto a los recuadros que sí se deciden.
test('T11 Inicio_Vulnerabilidades_DicenSeguimiento — los recuadros de dependencias dicen «seguimiento», no «decidir»', () => {
  const html = views.paginaInicio({ modelo: access.filtrar(modeloCompleto({ vigilante: noMedida('sin_foto') }), { rol: 'maintainer' }, access.crearReglas({})), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: AHORA });
  const recuadro = (titulo) => html.split('<div class="tile ').find((x) => x.includes(`<div class="t-label">${titulo}</div>`)) || '';
  for (const titulo of ['Dependencias nuevas', 'Dependencias rechazadas sin deuda']) {
    assert.ok(recuadro(titulo), `${titulo}: el recuadro está`);
    assert.doesNotMatch(recuadro(titulo), />decidir</, `${titulo}: no dice decidir`);
  }
  assert.match(recuadro('Dependencias nuevas'), />seguimiento</, 'con algo adentro, dice seguimiento');
  assert.match(recuadro('Pull requests abiertos hace más de 2 días'), />decidir</, 'los demás siguen diciendo decidir');
});
