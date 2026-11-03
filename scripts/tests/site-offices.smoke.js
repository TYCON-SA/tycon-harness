#!/usr/bin/env node
'use strict';
// site-offices.smoke.js — la pestaña «Oficinas» en un navegador de verdad, bajo la política real del sitio: la página
// carga, dibuja las oficinas, una se agranda, un texto raro llega como texto, cada persona ve lo suyo y con más máquinas
// que el tope ninguna sala se cae. Corre con el Chromium fijo del arnés (scripts/lib/pinned-playwright.js) contra el
// servidor real, con máquinas de juguete que firman de verdad. La demo, sin ninguna conexión.
//
// stable-data: la sesión «Muerta» se calló hace 3 h según el reloj del navegador, que es el que mira la página; ninguna
// comprobación compara una hora fija
//
//   node scripts/tests/site-offices.smoke.js [--shots <carpeta>]    sale 0 si todo pasó; 1 si algo no; 2 si no hay navegador
//
// Con --shots deja las capturas de cada estado. Sólo datos de juguete: ningún nombre real.

const fs = require('fs');
const path = require('path');
const { A, SIN_MAQUINA, LEAD, tmp, hasta, montar, conectar, conectarMaquinas, ROOT, H } = require('./lib/offices-harness.js');

const PINNED_PW = require(path.join(ROOT, 'scripts', 'lib', 'pinned-playwright.js'));
const { crearSitioDemo } = require(path.join(H.SITE, 'server.js'));

// sin placa de video y con la máquina ocupada, la página tarda: con carga cercana a 20, 15 s no alcanzaron y 60 s sí
const ESPERA_MS = 60000;
const abiertasEnLaPrueba = [];
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'MAL'} ${what}`); if (!ok) fails.push(what); };
const shotsAt = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
async function shot(page, name) {
  if (!shotsAt) return;
  fs.mkdirSync(shotsAt, { recursive: true });
  await page.screenshot({ path: path.join(shotsAt, `${name}.png`), fullPage: true });
}

const PASOS = ['Arranque', 'Validar la historia', 'Armar el plan', 'Aprobar el plan', 'Implementar', 'Correr las pruebas', 'Revisores', 'Pase adversarial', 'Hallazgos', 'Probar en vivo', 'Preparar el commit'];
const pasos = (n) => PASOS.map((name, i) => ({ name, done: i < n }));
const sesion = (nombre, estado, extra = {}) => ({ nombre, estado, titulo: `Trabajo de ${nombre}`, haciendo: 'Va por sus pasos', fin: { hora: '18:30', dif: '', cls: 'ontime' }, avance: 45, pasos: pasos(5), ...extra });
const foto = (agents) => ({ agents, meta: { actualizado: '16:40', teToca: [] }, rows: [], free: [], unreadable: [] });

/** Un navegador con la sesión de esa persona, que anota lo que la política frena y lo que rompe. */
async function abrirComo(browser, h, email, viewport = { width: 1440, height: 1000 }) {
  const cookie = await h.entrar(email);
  // con el movimiento reducido la sala se dibuja sólo cuando algo cambia: sin placa de video, moverse la ahogaría
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  // `__Host-` pide https: la cookie va como encabezado, igual que en las otras pruebas del sitio con navegador
  await context.setExtraHTTPHeaders({ cookie });
  return nuevaPagina(context);
}
async function nuevaPagina(context) {
  const page = await context.newPage();
  // también para tocar: un click espera que la página quede quieta, y con la máquina ocupada eso tarda
  page.setDefaultTimeout(ESPERA_MS);
  const problemas = [];
  page.on('pageerror', (e) => problemas.push(`error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebGL|GPU|ERR_CONNECTION/i.test(m.text())) problemas.push(`consola: ${m.text()}`); });
  await page.addInitScript(() => { window.__frenos = []; document.addEventListener('securitypolicyviolation', (e) => window.__frenos.push(`${e.violatedDirective}: ${e.blockedURI}`)); });
  const abierta = { page, problemas, context };
  abiertasEnLaPrueba.push(abierta);
  return abierta;
}
/** Si la prueba se corta, lo que vio cada página: sin esto, un tiempo agotado no dice por qué. */
async function contarLoQueVieron() {
  for (const { page, problemas } of abiertasEnLaPrueba) {
    // eslint-disable-next-line no-await-in-loop -- una atrás de la otra, para que la salida se lea
    const vio = await page.evaluate(() => ({ dir: location.href, oficinas: document.querySelectorAll('.oficina').length, aviso: (document.getElementById('oficinasAviso') || {}).textContent, frenos: window.__frenos })).catch(() => null);
    if (vio) console.error('la página vio:', JSON.stringify(vio), problemas.join(' | '));
  }
}
const salas = (page) => page.locator('.oficina canvas').count();
const sinFrenos = async (page) => page.evaluate(() => window.__frenos);

async function delSitio(browser) {
  const extras = Array.from({ length: 9 }, (_, i) => `maquina-${i + 1}`);
  const h = await montar({ extras });
  try {
    await conectarMaquinas(h, {
      'maquina-a': foto([sesion('Coordinadora', 'coordina', { titulo: undefined }), sesion('Atlas', 'prueba'), sesion('Boro', 'firma', { espera: 'el plan espera tu firma' }), sesion('Dina', 'libre', { titulo: undefined, haciendo: 'Sin trabajo' })]),
      // un nombre con forma de código: tiene que verse como texto
      'maquina-b': foto([sesion('<img src=x onerror=window.__colado=1>', 'trabajando'), sesion('Cleo', 'parada', { parada: 'parada desde las 16:10' })]),
    });

    // quien mantiene: las dos, bajo la política real
    const m = await abrirComo(browser, h, LEAD);
    await m.page.goto(`${h.base}/offices`);
    await m.page.waitForSelector('.oficina[data-id="maquina-b"]', { timeout: ESPERA_MS });
    check((await m.page.locator('html').getAttribute('data-source')) === 'site', 'la página dice su fuente');
    await m.page.waitForFunction(() => document.querySelectorAll('.oficina canvas').length === 2, null, { timeout: ESPERA_MS });
    check(await salas(m.page) === 2, 'las dos oficinas tienen su sala en 3D');
    check(await m.page.locator('.oficina[data-id="maquina-a"] .stats').innerText().then((t) => /4\s*sesiones/.test(t) && /1\s*trabajando/.test(t) && /1\s*esperan tu firma/.test(t) && /1\s*esperan o libres/.test(t) && /coordina\s*Coordinadora/.test(t)), 'el resumen de la oficina');
    check(await m.page.locator('.crewblock[data-id="maquina-a"] .card').count() === 4, 'debajo, las tarjetas de sus sesiones');
    check(await m.page.locator('#oficinasVacio').isHidden(), 'con oficinas, no dice que no hay');
    await shot(m.page, '1-quien-mantiene-todas');

    // el texto raro llega como texto
    check(await m.page.evaluate(() => window.__colado === undefined), 'un nombre con código no corre');
    check(await m.page.locator('.crewblock[data-id="maquina-b"]').innerText().then((t) => t.includes('<img src=x onerror=window.__colado=1>')), 'y se ve tal cual');

    // tocar una la agranda; las otras en miniatura; volver
    await m.page.locator('.oficina[data-id="maquina-a"] .cover').click();
    await m.page.waitForSelector('.oficina.on[data-id="maquina-a"]');
    check(await m.page.locator('.oficina.mini[data-id="maquina-b"]').count() === 1, 'la otra queda en miniatura');
    check(await m.page.locator('#back').isVisible(), '«Volver a todas» aparece');
    check(await m.page.locator('.crewblock[data-id="maquina-b"]').isHidden(), 'sólo se ven las tarjetas de la elegida');
    check(new URL(m.page.url()).hash === '#maquina-a', 'la dirección dice cuál');
    check(await m.page.locator('#detalleOficina').isVisible(), 'con lo demás de esa máquina debajo');
    // el cambio de tamaño es animado
    await m.page.waitForTimeout(1000);
    const anchos = await m.page.evaluate(() => [...document.querySelectorAll('.oficina')].map((c) => c.offsetWidth));
    check(Math.max(...anchos) > Math.min(...anchos) * 2, `la elegida es la grande (${anchos})`);
    await shot(m.page, '2-una-grande');
    await m.page.locator('#back').click();
    await m.page.waitForFunction(() => !document.querySelector('.oficina.on'));
    check(await m.page.locator('.crewblock[data-id="maquina-b"]').isVisible() && await m.page.locator('#back').isHidden(), '«Volver a todas» vuelve');

    // tocar una tarjeta agranda su oficina y abre a esa persona
    await m.page.locator('.crewblock[data-id="maquina-a"] .card', { hasText: 'Boro' }).click();
    await m.page.waitForSelector('.oficina.on[data-id="maquina-a"] .panel3:not([hidden])', { timeout: ESPERA_MS });
    check((await m.page.locator('.oficina.on .panel3 h3').innerText()) === 'Boro', 'tocar una tarjeta abre a esa persona');

    // la política, en toda la visita de quien mantiene
    check((await sinFrenos(m.page)).length === 0, `la política no frenó nada: ${await sinFrenos(m.page)}`);
    check(m.problemas.length === 0, `sin errores en la página: ${m.problemas.join(' | ')}`);

    // abrir la dirección con la oficina la deja grande
    await m.page.goto('about:blank');
    await m.page.goto(`${h.base}/offices#maquina-b`);
    await m.page.waitForSelector('.oficina.on[data-id="maquina-b"]', { timeout: ESPERA_MS });
    check(await m.page.locator('.oficina.mini[data-id="maquina-a"]').count() === 1, '#maquina-b la deja grande y la otra en miniatura');

    // el teléfono: sin correrse a los costados
    const tel = await abrirComo(browser, h, LEAD, { width: 390, height: 844 });
    await tel.page.goto(`${h.base}/offices`);
    await tel.page.waitForSelector('.oficina[data-id="maquina-b"]', { timeout: ESPERA_MS });
    await tel.page.waitForTimeout(800);
    check(await tel.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'en el teléfono no se corre a los costados');
    await shot(tel.page, '3-telefono');
    await tel.context.close();

    // un dev: sólo la suya, y nada de la ajena en la página
    const a = await abrirComo(browser, h, A);
    await a.page.goto(`${h.base}/offices#maquina-b`);
    await a.page.waitForSelector('.oficina[data-id="maquina-a"]', { timeout: ESPERA_MS });
    check(await a.page.locator('.oficina').count() === 1, 'un dev ve sólo la suya');
    check(!/Cleo|maquina-b/.test(await a.page.content()), 'nada de la ajena: ni su sesión ni su nombre');
    await shot(a.page, '4-un-dev');
    check((await sinFrenos(a.page)).length === 0, `la política no frenó nada a un dev: ${await sinFrenos(a.page)}`);
    check(a.problemas.length === 0, `sin errores en la página de un dev: ${a.problemas.join(' | ')}`);
    await a.context.close();

    // alguien sin máquinas: lo dice, y no se confunde con cargando
    const c = await abrirComo(browser, h, SIN_MAQUINA);
    await c.page.goto(`${h.base}/offices`);
    await c.page.waitForFunction(() => /Todavía no hay oficinas/.test(document.getElementById('oficinasVacio').textContent), null, { timeout: ESPERA_MS });
    check(await c.page.locator('#oficinasVacio').isVisible() && await c.page.locator('.oficina').count() === 0, 'sin oficinas, lo dice');
    await shot(c.page, '5-sin-oficinas');

    // los cierres del sitio, de verdad: la cuenta sale de la lista, y no reintenta
    const conexiones = [];
    c.page.on('websocket', (w) => conexiones.push(w.url()));
    const guardada = h.fuentes.st.config;
    h.fuentes.st.config = { ...guardada, site: { ...guardada.site, access: guardada.site.access.filter((e) => !e.emails.includes(SIN_MAQUINA)) } };
    h.sitio.centro.revisar();
    await c.page.waitForFunction(() => /volvé a entrar/.test(document.getElementById('oficinasAviso').textContent), null, { timeout: ESPERA_MS });
    await c.page.waitForTimeout(3000);
    check(conexiones.length === 0, 'la cuenta salió de la lista: pide volver a entrar y no reintenta');
    await c.context.close();
    h.fuentes.st.config = guardada;

    // demasiadas ventanas de la misma cuenta: pide cerrar otra, y no reintenta
    const cookie = await h.entrar(SIN_MAQUINA);
    const abiertas = [];
    for (let i = 0; i < 5; i += 1) {
      const nav = conectar(h, '/live/offices', { origin: h.base, headers: { cookie } });
      abiertas.push(nav);
      // eslint-disable-next-line no-await-in-loop -- de a una: el sitio cuenta las que ya abrieron
      await hasta(() => nav.msgs.length > 0, ESPERA_MS, 'la conexión de esa ventana');
    }
    const sexta = await abrirComo(browser, h, SIN_MAQUINA);
    const intentos = [];
    sexta.page.on('websocket', (w) => intentos.push(w.url()));
    await sexta.page.goto(`${h.base}/offices`);
    await sexta.page.waitForFunction(() => /otra pestaña/.test(document.getElementById('oficinasAviso').textContent), null, { timeout: ESPERA_MS });
    await sexta.page.waitForTimeout(3000);
    check(intentos.length === 1, `con el tope de ventanas, pide cerrar otra y no reintenta (${intentos.length} conexiones)`);
    check(!/Cargando/.test(await sexta.page.locator('#oficinasVacio').innerText().catch(() => '')) || await sexta.page.locator('#oficinasVacio').isHidden(), 'cortada antes del primer mensaje, no sigue diciendo «Cargando»');
    await sexta.context.close();
    abiertas.forEach((nav) => nav.ws.close());

    // la dirección pide una oficina cuya máquina todavía no conectó: cuando conecta, queda grande
    const tarde = await abrirComo(browser, h, LEAD);
    await tarde.page.goto(`${h.base}/offices#maquina-3`);
    await tarde.page.waitForSelector('.oficina[data-id="maquina-b"]', { timeout: ESPERA_MS });
    // con más máquinas que el tope: ninguna se cae, y la elegida tiene su sala. En maquina-3, una sesión que firmaba y
    // se calló hace 3 h: su tarjeta dice «Inactiva», y el resumen no la cuenta como firma
    const muerta = sesion('Muerta', 'firma', { sinPid: true, novedadMs: Date.now() - 3 * 3600000 });
    await conectarMaquinas(h, Object.fromEntries(extras.map((id, i) => [id, foto([sesion(`Sesion ${i + 1}`, i < 2 ? 'firma' : 'libre'), ...(id === 'maquina-3' ? [muerta] : [])])])));
    await tarde.page.waitForSelector('.oficina.on[data-id="maquina-3"]', { timeout: ESPERA_MS });
    check(await tarde.page.locator('#back').isVisible(), 'la oficina de la dirección, que conectó tarde, queda grande');
    check(await tarde.page.locator('.oficina[data-id="maquina-3"] .stat.firma', { hasText: 'esperan tu firma' }).count() === 0, 'el resumen no cuenta como firma a la sesión inactiva');
    await tarde.context.close();
    await m.page.reload();
    await m.page.waitForFunction(() => document.querySelectorAll('.oficina').length >= 9, null, { timeout: ESPERA_MS });
    await m.page.waitForFunction(() => document.querySelectorAll('.oficina canvas').length === 8, null, { timeout: ESPERA_MS });
    check(await salas(m.page) === 8, 'con más máquinas, 8 salas');
    const sinSala = await m.page.evaluate(() => [...document.querySelectorAll('.oficina')].find((c) => !c.querySelector('canvas')).dataset.id);
    await shot(m.page, '6-mas-que-el-tope');
    await m.page.locator(`.oficina[data-id="${sinSala}"] .cover`).click();
    await m.page.waitForSelector(`.oficina.on[data-id="${sinSala}"] canvas`, { timeout: ESPERA_MS });
    check(await salas(m.page) === 8, 'al agrandar una sin sala, sigue en 8');
    check(m.problemas.length === 0, `con el tope, sin errores: ${m.problemas.join(' | ')}`);

    // el sitio se corta: queda lo último, y lo dice
    await m.page.locator('#back').click();
    await h.sitio.centro.detener();
    await m.page.waitForFunction(() => /Se cortó la conexión/.test(document.getElementById('oficinasAviso').textContent), null, { timeout: ESPERA_MS });
    check(await m.page.locator('.oficina').count() >= 9, 'se corta la conexión: queda lo último, y lo dice');
    await shot(m.page, '7-se-corto');
    await m.context.close();
  } finally { await h.cerrar().catch(() => {}); }
}

async function deLaDemo(browser) {
  const dir = tmp('demo-oficinas-');
  const sitio = crearSitioDemo({ env: { SITE_DEMO: '1' }, dir, log: () => {} });
  await sitio.iniciar();
  await new Promise((r) => sitio.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${sitio.server.address().port}`;
  try {
    const d = await nuevaPagina(await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }));
    const conexiones = [];
    d.page.on('websocket', (w) => conexiones.push(w.url()));
    await d.page.goto(`${base}/offices`);
    await d.page.waitForSelector('.oficina[data-id="mac-ana"]', { timeout: ESPERA_MS });
    check(await d.page.locator('.oficina').count() === 3, 'la demo dibuja sus oficinas inventadas');
    check(await d.page.locator('.oficina[data-id="mac-bruno"] .stats').innerText().then((t) => /sin conexión desde \d\d:\d\d/.test(t)), 'y una dice que no tiene conexión');
    await d.page.waitForTimeout(1000);
    await shot(d.page, '8-demo');
    await d.page.locator('.oficina[data-id="mac-lead"] .cover').click();
    await d.page.waitForSelector('.oficina.on[data-id="mac-lead"]');
    await d.page.waitForTimeout(1000);
    check(await d.page.locator('.oficina.mini canvas').count() === 2, 'en la demo, al agrandar una, las otras siguen con su sala');
    await shot(d.page, '9-demo-una-grande');
    check(conexiones.length === 0, `la demo no abre ninguna conexión: ${conexiones}`);
    check((await sinFrenos(d.page)).length === 0, `la política no frenó nada en la demo: ${await sinFrenos(d.page)}`);
    check(d.problemas.length === 0, `sin errores en la demo: ${d.problemas.join(' | ')}`);
    await d.context.close();
  } finally { await sitio.cerrar(); fs.rmSync(dir, { recursive: true, force: true }); }
}

async function main() {
  const playwright = PINNED_PW.load();
  if (!playwright) { console.error(`sin navegador: ${PINNED_PW.locate().why}`); return 2; }
  const browser = await playwright.chromium.launch({ args: ['--use-angle=swiftshader'] });
  try {
    await delSitio(browser);
    await deLaDemo(browser);
  } catch (e) { await contarLoQueVieron(); throw e; } finally { await browser.close(); }
  if (fails.length) { console.log(`\n${fails.length} sin pasar`); return 1; }
  console.log('\ntodo pasó');
  return 0;
}

main().then((code) => { process.exitCode = code; process.exit(code); }, (e) => { console.error(e); process.exit(1); });
