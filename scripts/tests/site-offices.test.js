'use strict';
/*
 * site-offices.test.js — la pestaña «Oficinas» del sitio y `/office`, que la abre.
 *
 * El sitio es el servidor real, con el emisor local y su encabezado de política real. Lo que sólo un navegador puede
 * comprobar (que la política deje correr la página, tocar una oficina, un texto que llega escapado) está en
 * scripts/tests/site-offices.smoke.js; acá se corre sin pantalla la parte de la página que decide, sacada de page.js.
 *
 * T20 Pestana_ResumenYSesiones            T21 UnaSolaPagina_DosFuentes
 * T22 Office_AbreElSitioSiEstaAprobada    T23 Office_SinSitioSinAprobarOPendiente_Local
 * T24 Pagina_SinNombresAjenos             T25 Demo_OficinasInventadas_SinConexion
 * T34 Pagina_BajoLaPoliticaDelSitio       T36 Imagen_TraeLaOficina
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { A, LEAD, tmp, hasta, pausa, montar, conectar, conectarMaquinas, ROOT, OFFICE_DIR, WS, F, SL, H } = require('./lib/offices-harness.js');

const { crearSitioDemo, CSP } = require(path.join(H.SITE, 'server.js'));
const { limpiarFoto } = require(path.join(H.SITE, 'live-hub.js'));
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

const dosMaquinas = (h) => conectarMaquinas(h, {
  'maquina-a': { agents: [{ nombre: 'Sesion de A', estado: 'trabajando' }], free: [], unreadable: [] },
  'maquina-b': { agents: [{ nombre: 'Sesion de B', estado: 'firma' }], free: [], unreadable: [] },
});

/** La parte de page.js que decide y no toca la pantalla, sacada del archivo y corrida acá. */
function decisiones() {
  const code = fs.readFileSync(path.join(OFFICE_DIR, 'page.js'), 'utf8');
  const desde = code.indexOf('// la pestaña del sitio: lo que se decide sin tocar la pantalla');
  const hasta_ = code.indexOf('// fin de lo que se decide sin tocar la pantalla');
  assert.ok(desde >= 0 && hasta_ > desde, 'page.js marca la parte que decide');
  return new Function(`${code.slice(desde, hasta_)}; return { resumenDeOficina, alCerrarLaConexion, oficinaDelHash, oficinaAMostrar, aplicarOficinas, salasVivas, TOPE_DE_SALAS };`)();
}

// ── La pestaña ──────────────────────────────────────────────────────────────────────────────

test('T20 Pestana_ResumenYSesiones — @story-8.171 @ac-16 @ac-16b', async () => {
  const P = decisiones();
  // el resumen, con los estados reales de la foto; todas las sesiones cuentan una vez
  assert.deepStrictEqual(P.resumenDeOficina({ agents: [
    { nombre: 'Coordinadora', estado: 'coordina' }, { nombre: 'a', estado: 'trabajando' }, { nombre: 'b', estado: 'prueba' },
    { nombre: 'c', estado: 'firma' }, { nombre: 'd', estado: 'pregunta' }, { nombre: 'e', estado: 'espera' }, { nombre: 'f', estado: 'esperando' },
    { nombre: 'g', estado: 'parada' }, { nombre: 'h', estado: 'libre' }, { nombre: 'i', estado: 'inactiva' }] }),
  { sesiones: 10, trabajando: 2, firma: 2, esperanOLibres: 5, coordina: 'Coordinadora' });
  assert.deepStrictEqual(P.resumenDeOficina({}), { sesiones: 0, trabajando: 0, firma: 0, esperanOLibres: 0, coordina: null });
  // la coordinadora que espera una firma sigue coordinando: la foto la marca por cómo trabaja, no por su estado
  assert.strictEqual(P.resumenDeOficina({ agents: [{ nombre: 'Coord', estado: 'firma', comoTrabaja: 'Coordinando' }] }).coordina, 'Coord');
  // cada cierre hace lo del criterio
  assert.strictEqual(P.alCerrarLaConexion(F.CLOSE.pending, 0).reintenta, false);
  assert.match(P.alCerrarLaConexion(F.CLOSE.pending, 0).texto, /volvé a entrar/i);
  assert.strictEqual(P.alCerrarLaConexion(F.CLOSE.revoked, 0).reintenta, false);
  assert.match(P.alCerrarLaConexion(F.CLOSE.revoked, 0).texto, /volvé a entrar/i);
  assert.strictEqual(P.alCerrarLaConexion(F.CLOSE.policy, 0).reintenta, false);
  assert.match(P.alCerrarLaConexion(F.CLOSE.policy, 0).texto, /otra pestaña/i);
  for (const codigo of [1013, 1006, 1001, 1011]) assert.strictEqual(P.alCerrarLaConexion(codigo, 0).reintenta, true, String(codigo));
  // la espera crece y tiene tope
  const esperas = [0, 1, 2, 3, 9, 30].map((i) => P.alCerrarLaConexion(1006, i).esperaMs);
  assert.ok(esperas.every((e, i) => i === 0 || e >= esperas[i - 1]), `crece: ${esperas}`);
  assert.ok(esperas[0] >= 1000 && esperas[esperas.length - 1] <= 60000, `dentro del plazo: ${esperas}`);

  // la lista: entera reemplaza; lo que sale, sale
  let m = P.aplicarOficinas(new Map(), { type: 'oficinas', entera: true, oficinas: [{ id: 'x', foto: {} }, { id: 'y', foto: {} }], fuera: [] });
  assert.deepStrictEqual([...m.keys()], ['x', 'y']);
  m = P.aplicarOficinas(m, { type: 'oficinas', oficinas: [{ id: 'z', foto: {} }], fuera: ['x'] });
  assert.deepStrictEqual([...m.keys()], ['y', 'z']);
  m = P.aplicarOficinas(m, { type: 'oficinas', entera: true, oficinas: [{ id: 'y', foto: {} }], fuera: [] });
  assert.deepStrictEqual([...m.keys()], ['y']);

  // con más oficinas que el tope: primero la elegida, después firmas, después trabajo; las demás sin sala
  const of = (id, estado) => ({ id, foto: { agents: [{ nombre: id, estado }] } });
  const lista = [of('libre1', 'libre'), of('firma1', 'firma'), of('trabaja1', 'trabajando'), of('libre2', 'libre')];
  assert.deepStrictEqual([...P.salasVivas(lista, null, 2)], ['firma1', 'trabaja1']);
  assert.deepStrictEqual([...P.salasVivas(lista, 'libre2', 2)], ['libre2', 'firma1']);
  assert.strictEqual(P.salasVivas(lista, null, P.TOPE_DE_SALAS).size, 4);
  assert.strictEqual(P.TOPE_DE_SALAS, 8);

  // la pestaña está en el menú de quien mantiene y de cada dev, en los dos idiomas
  const h = await montar();
  try {
    for (const email of [LEAD, A]) {
      const cookie = await h.entrar(email);
      const inicio = await h.pedir('/', { cookie });
      assert.match(inicio.texto, /href="\/offices"[^>]*>(<span[^>]*>\d+<\/span>)?Oficinas</, email);
      const pagina = await h.pedir('/offices', { cookie });
      assert.strictEqual(pagina.status, 200, email);
      assert.match(pagina.texto, /<nav[^>]*>[\s\S]*href="\/offices"[^>]*aria-current="page"/, 'la barra del sitio marca la pestaña');
      assert.match(pagina.texto, /id="offices"/, 'el lugar de las oficinas');
      assert.match(pagina.texto, /id="back"[^>]*hidden/, '«Volver a todas» arranca escondido');
      assert.match(pagina.texto, /Volver a todas/);
    }
  } finally { await h.cerrar(); }
});

test('T21 UnaSolaPagina_DosFuentes — @story-8.171 @ac-17', async () => {
  const PP = require(path.join(OFFICE_DIR, 'page-parts.js'));
  const { page } = require(path.join(ROOT, 'scripts', 'tools', 'office.js'));
  const plantilla = fs.readFileSync(path.join(OFFICE_DIR, 'page.html'), 'utf8');
  const codigo = fs.readFileSync(path.join(OFFICE_DIR, 'page.js'), 'utf8');
  assert.doesNotMatch(plantilla, /<script>|<script type="module">/, 'la plantilla no trae código');

  const local = page({ agents: [], meta: {} }, { live: { token: 'abc' } });
  assert.match(local, /<html[^>]*data-source="local"/);
  assert.match(local, /<script src="page\.js\?t=abc"/, 'la local pide el mismo código');
  assert.doesNotMatch(local, /const SITE=|function renderCrew/, 'y no lo trae adentro');

  // lo fijo de la página es lo mismo en las dos: sólo cambian los marcadores
  const h = await montar();
  try {
    const cookie = await h.entrar(LEAD);
    const sitio = await h.pedir('/offices', { cookie });
    assert.match(sitio.texto, /<html[^>]*data-source="site"/);
    const trozo = (html) => html.slice(html.indexOf('<section class="office"'), html.indexOf('<div class="ventana"'));
    assert.strictEqual(trozo(sitio.texto), trozo(local), 'la misma página');
    assert.strictEqual(trozo(local), trozo(plantilla), 'la de la plantilla');
    const servido = await h.pedir('/offices/page.js', { cookie });
    assert.strictEqual(servido.status, 200);
    assert.strictEqual(servido.texto, codigo, 'el mismo código');
  } finally { await h.cerrar(); }

  // la foto fija no tiene fuente: lleva lo suyo adentro y sigue andando sin nada más
  const fija = PP.renderPage({ data: { agents: [{ nombre: 'Alfa' }] } });
  assert.doesNotMatch(fija, /data-source="(local|site|demo)"/);
  assert.ok(fija.includes(codigo.slice(0, 200)), 'el código va adentro');
  assert.match(fija, /<script type="application\/json" id="officeData">/);
  assert.match(fija, /data:text\/javascript;base64,/, 'y la librería');
});

// ── /office elige ───────────────────────────────────────────────────────────────────────────

function arbolDeOffice() {
  const dir = tmp('office-arbol-');
  for (const rel of ['scripts/lib', 'scripts/tools', 'scripts/hooks', 'scripts/setup', 'scripts/metrics', 'scripts/publishing', 'skills/tycon-pipeline/scripts']) {
    fs.cpSync(path.join(ROOT, ...rel.split('/')), path.join(dir, ...rel.split('/')), { recursive: true });
  }
  return dir;
}
const QUITAR = ['TF_BUILD', 'AGENT_ID', 'BUILD_BUILDID', 'SYSTEM_TEAMFOUNDATIONCOLLECTIONURI', 'GITHUB_ACTIONS', 'CI', 'NODE_TEST_CONTEXT', 'TYCON_HOME', 'TYCON_GUIDES_DIR', 'TCG', 'TYCON_SKILLS_DIR', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_OFFICE_LINK', 'TYCON_EVAL_SANDBOX', 'TYCON_PROFILE'];
function juguete(arbol, { url, estado } = {}) {
  const home = tmp('office-casa-');
  const sdir = stateDir(home);
  for (const d of ['active', 'adhoc', 'doing']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
  fs.mkdirSync(path.join(claudeDir(home), 'sessions'), { recursive: true });
  const profile = path.join(arbol, 'team-profile.json');
  if (url) fs.writeFileSync(profile, JSON.stringify({ site: { url } }));
  else fs.rmSync(profile, { force: true });
  if (estado) { SL.ensureKey(sdir); SL.writeLinkState(sdir, estado); }
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_OFFICE_NO_BROWSER: '1', TYCON_OFFICE_TEST: '1' };
  for (const k of QUITAR) delete env[k];
  return { home, sdir, env };
}
function correrOffice(arbol, m, args = []) {
  const r = spawnSync(process.execPath, [path.join(arbol, 'scripts', 'tools', 'office.js'), '--open', ...args], { input: '', env: m.env, encoding: 'utf8', timeout: 40000 });
  // la local deja un proceso; lo apaga el fin de la prueba
  try { const l = JSON.parse(fs.readFileSync(path.join(m.sdir, 'office', 'server.json'), 'utf8')); process.kill(l.pid); } catch { /* sin proceso */ }
  return r;
}

test('T22 Office_AbreElSitioSiEstaAprobada — @story-8.171 @ac-18', async () => {
  const arbol = arbolDeOffice();
  try {
    const m = juguete(arbol, { url: 'https://sitio.acme.example', estado: 'aprobada' });
    const r = correrOffice(arbol, m);
    assert.strictEqual(r.status, 0, r.stderr);
    // el nombre que usa la subida al buzón en esa misma casa: con él la conoce el sitio
    const nombre = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(arbol, 'scripts', 'metrics', 'upload-runs.js'))}).nombreDeMaquina())`], { env: m.env, encoding: 'utf8' }).stdout;
    assert.ok(nombre, 'la máquina tiene nombre');
    assert.ok(r.stdout.includes(`https://sitio.acme.example/offices#${encodeURIComponent(nombre)}`), r.stdout);
    assert.ok(!fs.existsSync(path.join(m.sdir, 'office', 'server.json')), 'no hace falta la página local');
  } finally { fs.rmSync(arbol, { recursive: true, force: true }); }
  // y la pestaña abierta con esa dirección busca esa oficina
  const P = decisiones();
  assert.strictEqual(P.oficinaDelHash('#maquina-a'), 'maquina-a');
  assert.strictEqual(P.oficinaDelHash('#m%C3%A1quina'), 'máquina');
  assert.strictEqual(P.oficinaDelHash(''), null);
  assert.strictEqual(P.oficinaDelHash('#%E0%A4%A'), null, 'un % roto no es ninguna oficina');
  // la oficina que pide la dirección espera a su máquina: si conecta tarde, o se va y vuelve, queda grande igual
  const ids = (...l) => new Set(l);
  assert.strictEqual(P.oficinaAMostrar(null, 'maquina-a', ids(), true), null, 'mientras no está, ninguna grande');
  assert.strictEqual(P.oficinaAMostrar(null, 'maquina-a', ids('maquina-a'), true), 'maquina-a', 'cuando llega, la grande');
  assert.strictEqual(P.oficinaAMostrar('maquina-a', 'maquina-a', ids('maquina-b'), true), null, 'si se va, ninguna');
  assert.strictEqual(P.oficinaAMostrar('maquina-b', 'maquina-b', ids('maquina-b'), true), 'maquina-b');
  assert.strictEqual(P.oficinaAMostrar(null, null, ids('maquina-a'), true), null, 'sin pedido, ninguna');
});

test('T23 Office_SinSitioSinAprobarOPendiente_Local — @story-8.171 @ac-18', async () => {
  const arbol = arbolDeOffice();
  try {
    const local = /La oficina (está abierta en|ya estaba abierta:) http:\/\/127\.0\.0\.1/;
    const sinSitio = correrOffice(arbol, juguete(arbol, {}));
    assert.strictEqual(sinSitio.status, 0, sinSitio.stderr);
    assert.match(sinSitio.stdout, local);

    const pendiente = correrOffice(arbol, juguete(arbol, { url: 'https://sitio.acme.example', estado: 'pendiente' }));
    assert.match(pendiente.stdout, local);
    assert.match(pendiente.stdout, /espera la aprobación de su oficina en el sitio \(huella /);
    assert.doesNotMatch(pendiente.stdout, /\/offices#/);

    const sinPedir = correrOffice(arbol, juguete(arbol, { url: 'https://sitio.acme.example' }));
    assert.match(sinPedir.stdout, local);

    const aPropio = correrOffice(arbol, juguete(arbol, { url: 'https://sitio.acme.example', estado: 'aprobada' }), ['--local']);
    assert.match(aPropio.stdout, local, '--local la fuerza');
    assert.doesNotMatch(aPropio.stdout, /\/offices#/);

    const apagado = juguete(arbol, { url: 'https://sitio.acme.example', estado: 'aprobada' });
    apagado.env.TYCON_OFFICE_LINK = '0';
    assert.match(correrOffice(arbol, apagado).stdout, local, 'con el enlace apagado, la local');
  } finally { fs.rmSync(arbol, { recursive: true, force: true }); }
});

// ── Quién ve qué ────────────────────────────────────────────────────────────────────────────

test('T24 Pagina_SinNombresAjenos — @story-8.171 @ac-19', async () => {
  const h = await montar();
  try {
    await dosMaquinas(h);
    const cookie = await h.entrar(A);
    const pagina = await h.pedir('/offices#maquina-b', { cookie });
    assert.strictEqual(pagina.status, 200);
    assert.doesNotMatch(pagina.texto, /maquina-[ab]|Sesion de/, 'la página no lleva datos');
    const nav = conectar(h, '/live/offices', { origin: h.base, headers: { cookie } });
    await hasta(() => nav.msgs.some((m) => m.type === 'oficinas' && (m.oficinas || []).some((o) => o.id === 'maquina-a')), 3000, 'la oficina propia');
    await pausa(200);
    const todo = nav.crudos.join('\n');
    assert.match(todo, /Sesion de A/);
    assert.doesNotMatch(todo, /maquina-b|Sesion de B|dev\.b@/, 'nada de la máquina ajena');
    nav.ws.close();

    const lider = conectar(h, '/live/offices', { origin: h.base, headers: { cookie: await h.entrar(LEAD) } });
    await hasta(() => lider.crudos.join('\n').includes('Sesion de B'), 3000, 'quien mantiene ve todas');
    lider.ws.close();
  } finally { await h.cerrar(); }
});

// ── La demo ─────────────────────────────────────────────────────────────────────────────────

test('T25 Demo_OficinasInventadas_SinConexion — @story-8.171 @ac-20', async () => {
  const dir = tmp('demo-oficinas-');
  const sitio = crearSitioDemo({ env: { SITE_DEMO: '1' }, dir, log: () => {} });
  await sitio.iniciar();
  await new Promise((r) => sitio.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${sitio.server.address().port}`;
  const pedir = (ruta, o) => H.pedirA(base, ruta, o);
  try {
    const pagina = await pedir('/offices');
    assert.strictEqual(pagina.status, 200);
    assert.match(pagina.texto, /<html[^>]*data-source="demo"/);
    assert.match(pagina.texto, /<body class="demo">/, 'con la franja de los datos de ejemplo');
    assert.doesNotMatch(pagina.texto, /mac-ana|mac-lead/, 'la página no lleva datos');

    const todas = await pedir('/offices/demo.json', { cookie: 'sitio-demo-vista=mantenedor' });
    assert.strictEqual(todas.status, 200);
    assert.strictEqual(todas.json.type, 'oficinas');
    assert.strictEqual(todas.json.entera, true);
    const ids = todas.json.oficinas.map((o) => o.id);
    assert.ok(ids.includes('mac-ana') && ids.includes('mac-lead'), `las inventadas: ${ids}`);
    assert.ok(todas.json.oficinas.every((o) => (o.foto.agents || []).length > 0), 'cada una con sus sesiones');
    assert.ok(todas.json.oficinas.some((o) => o.sinConexionDesde), 'una sin conexión, para que se vea');
    for (const o of todas.json.oficinas) {
      const limpia = limpiarFoto(o.foto);
      assert.strictEqual(limpia.ok, true, `${o.id} tiene la forma de lo que manda una máquina`);
      assert.deepStrictEqual(limpia.desconocidos, [], `${o.id} no trae campos de más`);
    }

    const suyas = await pedir('/offices/demo.json', { cookie: 'sitio-demo-vista=persona' });
    assert.deepStrictEqual(suyas.json.oficinas.map((o) => o.id), ['mac-ana'], '«Ver como» una persona: sólo las suyas');
    assert.ok(suyas.json.oficinas.every((o) => o.person === undefined), 'de quién es cada una, sólo para quien mantiene');

    // ninguna puerta de máquina ni de navegador
    assert.notStrictEqual((await pedir('/live/machine')).status, 426, 'la demo no tiene la ruta de la máquina');
    const cierre = await new Promise((resolve) => {
      const ws = new WS(`${base.replace('http', 'ws')}/live/machine`);
      ws.on('open', () => { ws.close(); resolve('abrió'); });
      ws.on('error', () => resolve('no abrió'));
    });
    assert.strictEqual(cierre, 'no abrió');
  } finally { await sitio.cerrar(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── La política ─────────────────────────────────────────────────────────────────────────────

test('T34 Pagina_BajoLaPoliticaDelSitio — @story-8.171 @ac-17b @ac-10c', async () => {
  const h = await montar();
  try {
    const cookie = await h.entrar(LEAD);
    const pagina = await h.pedir('/offices', { cookie });
    const csp = pagina.headers['content-security-policy'];
    // lo único en línea es el mapa de importación, con su hash, y sólo en esta ruta
    const scripts = [...pagina.texto.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    const enLinea = scripts.filter((s) => !/\bsrc=/.test(s[1]));
    assert.strictEqual(enLinea.length, 1, 'un solo guion en línea');
    assert.match(enLinea[0][1], /type="importmap"/);
    const hash = crypto.createHash('sha256').update(enLinea[0][2]).digest('base64');
    assert.ok(csp.includes(`script-src 'self' 'sha256-${hash}'`), csp);
    assert.strictEqual(csp, CSP.replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`), 'lo demás de la política no cambia');
    const inicio = await h.pedir('/', { cookie });
    assert.strictEqual(inicio.headers['content-security-policy'], CSP, 'las otras rutas, sin el hash');

    // ni manejadores en línea, que la política no deja correr, ni token, ni datos
    assert.doesNotMatch(pagina.texto, /<[a-z][^>]*\son[a-z]+\s*=/i, 'sin manejadores en línea');
    assert.match(pagina.texto, /<html[^>]*data-source="site"/);
    // dentro del armazón del sitio, como la maqueta: su encabezado, su barra lateral con la pestaña marcada, sus hojas y
    // su pie; la oficina no trae barra propia ni los estilos de página que pisarían los del sitio
    assert.match(pagina.texto, /<header class="barra">/, 'el encabezado del sitio');
    assert.match(pagina.texto, /<aside class="side"><nav class="tabs"[^>]*>[\s\S]*?<a href="\/offices" class="activa" aria-current="page">/, 'la barra lateral, con la pestaña marcada');
    assert.match(pagina.texto, /<link rel="stylesheet" href="\/static\/site\.css">/, 'las hojas del sitio');
    assert.match(pagina.texto, /<footer class="pie">/, 'el pie del sitio');
    assert.doesNotMatch(pagina.texto, /barra-sitio|id="estiloPagina"/, 'sin barra propia ni los estilos de página de la local');
    assert.strictEqual((pagina.texto.match(/<h1\b/g) || []).length, 1, 'un solo título');
    assert.match(pagina.texto, /<section class="oficinas" id="oficinas"/, 'la pestaña adentro');
    // la local sigue con su página de siempre
    const local = require(path.join(OFFICE_DIR, 'page-parts.js')).renderPage({ source: 'local', token: 'abc', urlOf: (k) => `/modules/${k}`, script: '/page.js?t=abc' });
    assert.match(local, /id="estiloPagina"/);
    assert.doesNotMatch(local, /class="side"/);
    assert.doesNotMatch(pagina.texto, /data-token|[?&]t=[0-9a-f]/, 'sin token');
    assert.doesNotMatch(pagina.texto, /id="officeData"/, 'los datos llegan por la conexión');
    assert.ok(scripts.some((s) => /src="\/offices\/page\.js"/.test(s[1])), 'el código desde page.js');
    assert.match(fs.readFileSync(path.join(OFFICE_DIR, 'page.js'), 'utf8'), /\/live\/offices/);

    // el mapa apunta a rutas de esta pestaña, sin barras codificadas que un intermediario pueda tocar, y cada una contesta
    const mapa = JSON.parse(enLinea[0][2]);
    for (const [clave, dir] of Object.entries(mapa.imports)) {
      assert.match(dir, /^\/offices\/modules\/\d+\.js$/, clave);
      const mod = await h.pedir(dir, { cookie });
      assert.strictEqual(mod.status, 200, clave);
      assert.match(mod.headers['content-type'], /javascript/, clave);
    }
    assert.strictEqual((await h.pedir('/offices/modules/999.js', { cookie })).status, 404);
    assert.strictEqual((await h.pedir('/offices/modules/constructor.js', { cookie })).status, 404);

    // sin sesión, el sitio no entrega ni la página ni el código
    for (const ruta of ['/offices', '/offices/page.js', '/offices/modules/0.js']) {
      const sin = await h.pedir(ruta);
      assert.notStrictEqual(sin.status, 200, ruta);
    }
  } finally { await h.cerrar(); }
  // lo que llega por la conexión se pone como texto: en la parte nueva, ningún HTML armado con datos
  const code = fs.readFileSync(path.join(OFFICE_DIR, 'page.js'), 'utf8');
  const nuevo = code.slice(code.indexOf('// la pestaña del sitio: el dibujo'), code.indexOf('// fin de la pestaña del sitio'));
  assert.ok(nuevo.length > 0, 'page.js marca la parte de la pestaña');
  assert.doesNotMatch(nuevo, /innerHTML|insertAdjacentHTML|document\.write/);
});

// ── La imagen ───────────────────────────────────────────────────────────────────────────────

test('T36 Imagen_TraeLaOficina — @story-8.171 @ac-17c', () => {
  const docker = fs.readFileSync(path.join(H.SITE, 'Dockerfile'), 'utf8');
  const lista = fs.readFileSync(path.join(H.SITE, 'Dockerfile.dockerignore'), 'utf8');
  assert.match(docker, /^COPY scripts\/tools\/office\/ scripts\/tools\/office\/$/m);
  assert.match(lista, /^!scripts\/tools\/office\/$/m);
  const PP = require(path.join(OFFICE_DIR, 'page-parts.js'));
  for (const archivo of ['page.html', 'page.js', 'page-parts.js', 'fields.js', ...Object.values(PP.MODULES).map((r) => path.join('vendor', 'three', r))]) {
    assert.ok(fs.existsSync(path.join(OFFICE_DIR, archivo)), archivo);
    assert.doesNotMatch(archivo, /\.test\.js$|\.env$|\.pem$|\.key$/, `${archivo}: la lista de exclusiones lo sacaría`);
  }
  // lo que carga la pestaña se tiene que poder cargar en la imagen, que trae esta carpeta y no office.js
  const propios = [...fs.readFileSync(path.join(OFFICE_DIR, 'page-parts.js'), 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  for (const r of propios) assert.ok(!r.startsWith('..'), `page-parts.js sale de su carpeta: ${r}`);
  const tab = [...fs.readFileSync(path.join(H.SITE, 'tabs', 'offices.js'), 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.ok(tab.every((r) => !/tools\/office\.js/.test(r)), `la pestaña no carga office.js: ${tab}`);
});
