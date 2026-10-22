'use strict';
/*
 * site-runs.test.js — la pestaña Corridas del sitio de la organización.
 *
 * El servidor de prueba es el del sitio con una sesión real del emisor local; el buzón es un espejo fabricado en un
 * temporal con tres máquinas (`maq-a` confirmada para dev-a, `maq-b` confirmada para dev-b, `maq-c` sin confirmar) y una
 * corrida suelta sin máquina. El cliente de runs.js corre sobre un DOM mínimo en Node, como en dashboard-runs.test.sh,
 * con un `fetch` que pide al sitio de la prueba. Correos, máquinas y productos inventados: nada habla con la red.
 *
 * T28 (`Armado_Incremental_SoloLoNuevo`) no existe: el armado de la pestaña es siempre entero.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const H = require('./lib/site-harness.js');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const RUNS = path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'runs.js');
const runs = require(RUNS);
const access = require(path.join(H.SITE, 'access.js'));
const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
const TAB = () => require(path.join(H.SITE, 'tabs', 'runs.js'));

const LEAD = 'lead@ejemplo.test';
const DEV_A = 'dev-a@ejemplo.test';
const DEV_B = 'dev-b@ejemplo.test';
const DEV_D = 'dev-d@ejemplo.test';
const sha = (c) => crypto.createHash('sha256').update(c.trim().toLowerCase()).digest('hex');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

// ── el fabricante de volcados (la forma del archivador; la misma base que dashboard-runs.test.sh) ────────────────
const iso = (t0, min) => new Date(Date.parse(t0) + min * 60000).toISOString();
function volcado(sid, inicio, extra = {}) {
  const m = (x) => iso(inicio, x);
  const base = {
    archivedAt: m(125),
    marker: {
      storyId: '2.1', storyPath: '/Users/dev/SourceCode/Prod/specs/story-2.1-una-cosa.md', repoPath: '/Users/dev/SourceCode/Alfa/FrontEnd',
      sessionId: sid, startedAt: m(0), lastTouch: m(120), stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7, 8], stepsPending: [],
      stepTimings: { 0: { completedAt: m(1) }, 1: { completedAt: m(10) }, 2: { completedAt: m(12) }, 3: { completedAt: m(14) }, 4: { completedAt: m(40) },
        5: { completedAt: m(95) }, 6: { completedAt: m(100) }, 7: { completedAt: m(102) }, 8: { completedAt: m(118) } },
      planApproval: { text: 'zqx-prohibido-prompt aprobado', ts: m(14) },
      filesTouched: ['/Users/dev/zqx-prohibido-archivo/a.ts'],
    },
    gates: [
      { ts: m(20), sessionId: sid, check: 'build', status: 'green', cmd: 'npm run build zqx-prohibido-cmd', exit: 0, durationMs: 11542 },
      { ts: m(30), sessionId: sid, check: 'tests', status: 'red:exit=1', cmd: 'npm test', exit: 1, durationMs: 61000, mensaje: 'FAIL src/x.test.ts › caso 3\n  esperaba 2, salió 3' },
    ],
    costo: { spawns: 9, adhoc: 0, iteraciones: 2, por_tipo: { 'tycon-story-validator': 2 } },
    consumo: { estado: 'medido', respuestas: 40, sinteticos: 0, lineas_ilegibles: 0, tokens: { in: 900, out: 30000, cache_new: 100000, cache_read: 2000000 },
      por_modelo: { 'modelo-x': { respuestas: 40, in: 900, out: 30000, cache_new: 100000, cache_read: 2000000 } },
      por_paso: { 0: 20000, 4: 50000, 5: 60000 }, fuera_de_ventana: 1000, hilo_hasta: m(126), medido_en: m(300) },
  };
  const merge = (a, b) => { for (const [k, v] of Object.entries(b)) { if (v === null) delete a[k]; else if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') merge(a[k], v); else a[k] = v; } return a; };
  return merge(base, extra);
}
const escribir = (dir, nombre, doc) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, nombre), typeof doc === 'string' || Buffer.isBuffer(doc) ? doc : JSON.stringify(doc)); };
const gz = (s) => zlib.gzipSync(Buffer.from(s));
const parte = (ruta, lineas) => ({ ruta, estado: 'M', mas: lineas.length, menos: 0, binario: false, parche: `diff --git a/${ruta} b/${ruta}\n--- a/${ruta}\n+++ b/${ruta}\n@@ -1 +1,${lineas.length} @@\n${lineas.join('\n')}\n`, cortado: 0 });
function cambioGit(inicio, ruta, lineas) {
  return { version: 1, estado: 'medido', motivo: null, medido_en: iso(inicio, 200), ventana: { desde: inicio, hasta: iso(inicio, 200) },
    repos: [{ nombre: 'FrontEnd', principal: true, por: ['story'], otras_sesiones: 0, sin_commitear_previo: 0, estado: 'medido',
      commits: [{ h: 'abc123456789', fecha: iso(inicio, 60), asunto: 'feat: un commit', archivos: [parte(ruta, lineas)] }], commits_de_otras_sesiones: [], sin_commitear: [] }],
    totales: { repos: 1, archivos: 1, partes: 1, cortados: 0, sin_parche_por_tope: 0 }, topes: { por_parte: 200000, por_corrida: 5242880 } };
}
const uso = (ts, name, input) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name, input }] } });
function hilo(inicio, archivo, viejo, nuevo) {
  return [uso(iso(inicio, 20), 'Edit', { file_path: archivo, old_string: viejo, new_string: nuevo }),
    JSON.stringify({ type: 'user', timestamp: iso(inicio, 50), message: { content: [{ type: 'tool_result', content: '[main abc1234] feat: un commit\n 1 file changed' }] } })].join('\n') + '\n';
}

const SID = { a1: 'aaaaaaaa-0000-4000-8000-000000000001', a2: 'aaaaaaaa-0000-4000-8000-000000000002', b1: 'bbbbbbbb-0000-4000-8000-000000000001', c1: 'cccccccc-0000-4000-8000-000000000001', s1: 'dddddddd-0000-4000-8000-000000000001', x1: 'eeeeeeee-0000-4000-8000-000000000001' };

/**
 * El mundo de la prueba: el espejo del buzón con sus máquinas. `marcadores` siembra `zqx-fuga-b1`…`b8` en la corrida de
 * `maq-b` y en la suelta; `sinB` deja afuera `maq-b` (T11).
 */
function mundo({ marcadores = true, conB = true, carpetaSinForma = true } = {}) {
  const espejo = tmp('site-runs-espejo-');
  const A = path.join(espejo, 'maq-a');
  escribir(A, 'a1.json', volcado(SID.a1, '2026-08-05T09:00:00.000Z', { marker: { storyId: '3.1', repoPath: '/Users/dev/SourceCode/Alfa/FrontEnd' } }));
  escribir(A, 'a1.cambio.json.gz', gz(JSON.stringify(cambioGit('2026-08-05T09:00:00.000Z', 'src/Pago.ts', ['+const PARCHE_DE_A = 1;']))));
  escribir(A, 'a1.hilo.jsonl.gz', gz(hilo('2026-08-05T09:00:00.000Z', '/Users/dev/SourceCode/Alfa/FrontEnd/src/Pago.ts', 'const viejo = 0;', 'const NUEVO_DE_A = 1;')));
  // la segunda de dev-a, en otra semana, sin consumo medido y en un repo suelto (`<repo>`)
  escribir(A, 'a2.json', volcado(SID.a2, '2026-08-19T09:00:00.000Z', { marker: { storyId: '3.2', repoPath: '/tmp/RepoComun' }, consumo: { estado: 'no_medido', motivo: 'sin hilo', tokens: null, por_paso: null, por_modelo: null } }));
  if (conB) {
    const B = path.join(espejo, 'maq-b');
    const marca = (k) => (marcadores ? `zqx-fuga-b${k}` : `otra-cosa-${k}`);
    escribir(B, 'b1.json', volcado(SID.b1, '2026-08-06T09:00:00.000Z', { marker: { storyId: marca(1), storyPath: `/Users/x/specs/story-9.9-${marca(2)}.md`, repoPath: `/Users/x/SourceCode/${marca(3)}/RepoComun` },
      gates: [{ ts: iso('2026-08-06T09:00:00.000Z', 30), check: 'tests', status: 'red:exit=1', exit: 1, mensaje: `FAIL ${marca(7)}` }] }));
    escribir(B, 'b1.cambio.json.gz', gz(JSON.stringify(cambioGit('2026-08-06T09:00:00.000Z', `src/${marca(4)}.ts`, [`+const x = '${marca(6)}';`]))));
    escribir(B, 'b1.hilo.jsonl.gz', gz(hilo('2026-08-06T09:00:00.000Z', `/Users/x/SourceCode/Prod/src/${marca(4)}.ts`, 'a', marca(5))));
  }
  escribir(path.join(espejo, 'maq-c'), 'c1.json', volcado(SID.c1, '2026-08-07T09:00:00.000Z', { marker: { storyId: '5.1' } }));
  // la suelta, en la raíz del espejo (sin máquina), con los marcadores también
  escribir(espejo, 's1.json', volcado(SID.s1, '2026-08-08T09:00:00.000Z', { marker: { storyId: marcadores ? 'zqx-fuga-b1' : '6.1' } }));
  // una carpeta con nombre de máquina de los marcadores (con forma) y otra sin forma
  if (marcadores) escribir(path.join(espejo, 'zqx-fuga-b8'), 'x1.json', volcado(SID.x1, '2026-08-09T09:00:00.000Z', { marker: { storyId: '7.1' } }));
  if (carpetaSinForma) escribir(path.join(espejo, 'Sin Forma.local'), 'y1.json', volcado('ffffffff-0000-4000-8000-000000000001', '2026-08-10T09:00:00.000Z'));
  return espejo;
}

const MAQUINAS = {
  'maq-a': { person: DEV_A, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' },
  'maq-b': { person: DEV_B, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' },
};
const opsCon = (machines = MAQUINAS, extra = {}) => ({ version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD], mailbox: { provider: 'azure-blob', account: 'cuentax', container: 'runs', threads: true } }, people: { machines }, ...extra });
const INFORMADOS = { 'maq-a': DEV_A, 'maq-b': DEV_B, 'maq-c': 'dev-c@ejemplo.test' };

/** Las fuentes del sitio de mentira, con el espejo, las conversaciones y el aviso de refresco. */
function fuentesCon({ espejo, config = opsCon(), informados = INFORMADOS, hilos = true, ops = null }) {
  // `informados: null` = todavía no se sabe de quién es cada máquina (antes de la primera bajada entera)
  const f = H.fuentesFijas({ config, personas: { informados: informados === null ? null : H.informados(informados), repos: null } });
  f.dirBuzon = espejo;
  f.hilos = () => hilos;
  f.clones = () => ({ operaciones: ops ? { dir: ops } : null, perfil: null });
  const oyentes = [];
  f.alRefrescar = (fn) => { oyentes.push(fn); };
  f.avisar = () => { for (const fn of oyentes) fn(); };
  // la última bajada del buzón (sources.js): entera por defecto; las pruebas la cambian con `f.bajada`
  f.bajada = { completo: true, generacion: 1 };
  f.buzonEstado = () => ({ ...f.bajada });
  return f;
}

/** El sitio con la pestaña; `entrar(correo)` da la cookie de una sesión real. `opciones` va a crearRutas. */
async function conPestana({ fuentes, opciones = {}, rutasMas = [], sinDisco = false }, fn) {
  const emisor = await arrancarEmisor();
  const datos = tmp('site-runs-datos-');
  const env = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, ...(sinDisco ? {} : { SITE_DATA_DIR: datos }) });
  const cfg = validarConfiguracion(env).cfg;
  const rutasExtra = TAB().crearRutas({ cfg, fuentes, skillsDir: path.join(ROOT, 'skills'), ...opciones });
  let h = null;
  try {
    h = await H.arrancarSitio({ env, fuentes, rutasExtra: [...rutasExtra, ...rutasMas] });
    if (!opciones.noEsperar) await rutasExtra.vista.listo();
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    await fn({ h, entrar, vista: rutasExtra.vista, cfg });
  } finally { if (h) await h.cerrar(); await emisor.cerrar(); }
}

// ── el cliente sobre un DOM mínimo, con las filas de la tabla que armó el servidor ─────────────────────────────────
function domMinimo(htmlTabla) {
  const nodos = {};
  const el = (extra = {}) => ({ innerHTML: '', textContent: '', value: '', checked: false, min: '', max: '', hidden: false, rows: [], dataset: {}, children: [],
    addEventListener() {}, set onclick(f) { this._click = f; }, get onclick() { return this._click; }, querySelectorAll: () => [], querySelector: () => el(), scrollIntoView() {},
    classList: { add() {}, remove() {}, contains: () => false }, ...extra });
  // las filas de la tabla: lo justo para abrir y cerrar un detalle
  const filas = [];
  const re = /<tr data-i="(\d+)"(?: data-id="([0-9a-f]*)")?/g;
  let mm;
  while ((mm = re.exec(htmlTabla || ''))) filas.push(mm);
  const cuerpo = el();
  const rows = [];
  const clases = (tr) => ({ add: (c) => tr._cl.add(c), remove: (c) => tr._cl.delete(c), contains: (c) => tr._cl.has(c) });
  const idx = (tr) => rows.indexOf(tr);
  const fila = (i, id) => { const tr = el({ dataset: { i: String(i), id: id || '' }, children: new Array(13) }); tr._cl = new Set(); tr.classList = clases(tr);
    Object.defineProperty(tr, 'nextElementSibling', { get: () => rows[idx(tr) + 1] || null });
    Object.defineProperty(tr, 'previousElementSibling', { get: () => rows[idx(tr) - 1] || null });
    tr.after = (n) => { rows.splice(idx(tr) + 1, 0, n); }; tr.remove = () => { const k = idx(tr); if (k >= 0) rows.splice(k, 1); }; return tr; };
  for (const f of filas) rows.push(fila(Number(f[1]), f[2]));
  cuerpo.rows = rows;
  cuerpo.querySelector = (sel) => {
    if (sel === '.fila-det') return rows.find((r) => r._cl.has('fila-det')) || null;
    const m = /tr\[data-(i|id)="([^"]+)"\]/.exec(sel);
    if (m) return rows.find((r) => r.dataset[m[1]] === m[2]) || null;
    return null;
  };
  nodos.cuerpo = cuerpo;
  const documento = { addEventListener() {}, querySelectorAll: () => [], body: { classList: { add() {} } },
    // la fila del detalle: «.cerrar» existe; los cambios y los parches de la corrida, no (este DOM no los arma)
    createElement: () => { const tr = fila('', ''); tr.querySelector = (sel) => (sel === '.cerrar' ? el() : null); tr.className = ''; Object.defineProperty(tr, 'className', { set: (v) => tr._cl.add(v), get: () => [...tr._cl].join(' ') }); return tr; },
    getElementById: (id) => (nodos[id] = nodos[id] || el()) };
  return { nodos, rows, documento };
}

/**
 * Corre el cliente de la pestaña: pide la página, el cliente y la lista al sitio con la cookie, como el navegador.
 * Devuelve { nodos, rows, w, pagina, lista }.
 */
async function clienteDelSitio(h, cookie, { search = '', alterar = null } = {}) {
  const pagina = await h.pedir(`/corridas${search}`, { cookie });
  assert.strictEqual(pagina.status, 200, `la página: ${pagina.status}`);
  const js = await h.pedir('/corridas/cliente.js', { cookie });
  assert.strictEqual(js.status, 200);
  const tbody = (/<tbody id="cuerpo"[^>]*>([\s\S]*?)<\/tbody>/.exec(pagina.texto) || [])[1] || '';
  const { nodos, rows, documento } = domMinimo(tbody);
  const fuente = /<div id="fuente-corridas"[^>]*data-api="([^"]+)"[^>]*data-generado="([^"]*)"/.exec(pagina.texto);
  nodos['fuente-corridas'] = { dataset: { api: fuente && fuente[1], generado: fuente && fuente[2] } };
  // el molde de la cuenta viaja en un atributo de la página (el cliente lo lee de ahí)
  const molde = /<span[^>]*id="cuenta"[^>]*data-molde="([^"]*)"/.exec(pagina.texto);
  nodos.cuenta = { innerHTML: '', textContent: '', value: '', dataset: molde ? { molde: molde[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>') } : {} };
  const w = { location: { search, hash: '', reload() { w.recargo = true; } } };
  const pendientes = [];
  // `alterar(url, json)`: cambia lo que contesta el sitio (para probar un detalle que no se puede dibujar)
  const pedidos = [];
  const fetchFalso = (url) => { pedidos.push(url); const p = h.pedir(url, { cookie }).then((r) => ({ ok: r.status === 200, status: r.status, json: async () => (alterar ? alterar(url, r.json) : r.json) })); pendientes.push(p); return p; };
  const contexto = { window: w, document: documento, location: w.location, fetch: fetchFalso, DecompressionStream: globalThis.DecompressionStream, Response, Blob, atob: globalThis.atob, Uint8Array, console };
  w.window = w; w.parent = w;
  const fn = new Function(...Object.keys(contexto), js.texto);
  fn(...Object.values(contexto));
  await esperarTodo(pendientes);
  return { nodos, rows, w, pagina, pendientes, pedidos, esperar: () => esperarTodo(pendientes) };
}
async function esperarTodo(pendientes) { for (let i = 0; i < 20; i++) { const n = pendientes.length; await Promise.all(pendientes); await new Promise((r) => setImmediate(r)); if (pendientes.length === n) return; } }
const sinTags = (h) => String(h).replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

// ── la pestaña: el contenido ──────────────────────────────────────────────────────────────────────────────────────

test('T1 Cabecera_SelloYBandas_IgualQueLaVista @story-2.27 @ac-1 @ac-18', async () => {
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const p = (await h.pedir('/corridas', { cookie: await entrar(LEAD) })).texto;
    for (const rot of ['Ejecuciones:', 'Con consumo medido:', 'Con controles:', 'Llegaron al paso 8:', 'Generado:', 'Alcance:']) assert.ok(p.includes(`<b>${rot}</b>`), `el sello trae «${rot}»`);
    assert.match(p, /versión del sitio/, 'el sello dice la versión del sitio, no el commit');
    assert.doesNotMatch(p, /Sin registro de ejecuciones propio/, 'el sitio no tiene registro propio y no lo declara como faltante');
    assert.doesNotMatch(p, /~\/\.claude\/\.tycon-pipeline\/timing-history/, 'la nota «De dónde sale» es la del sitio');
    assert.match(p, /del espejo del buzón de ejecuciones que el sitio baja con su identidad de sólo lectura/);
    // la página vieja del tablero ya no se sirve: el eyebrow lleva a Arnés, donde están sus fichas
    assert.match(p, /href="\/arnes"/, 'el eyebrow enlaza Arnés para quien mantiene');
    assert.doesNotMatch(p, /href="\/arnes\/tablero"/, 'nada enlaza la página vieja del tablero');
  });
  // el saneado ausente: la banda de rescate aparece (una copia de runs.js sin tokens-digest.js al lado)
  const copia = tmp('site-runs-copia-');
  fs.mkdirSync(path.join(copia, 'scripts', 'nightly', 'dashboard'), { recursive: true });
  fs.mkdirSync(path.join(copia, 'scripts', 'lib'), { recursive: true });
  for (const f of ['runs.js', 'common.js', 'sources.json']) fs.copyFileSync(path.join(ROOT, 'scripts', 'nightly', 'dashboard', f), path.join(copia, 'scripts', 'nightly', 'dashboard', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts', 'lib'))) if (f.endsWith('.js') || f.endsWith('.json')) fs.copyFileSync(path.join(ROOT, 'scripts', 'lib', f), path.join(copia, 'scripts', 'lib', f));
  const r = spawnSync(process.execPath, ['-e', `const r=require(${JSON.stringify(path.join(copia, 'scripts', 'nightly', 'dashboard', 'runs.js'))});const M=r.modelo(${JSON.stringify(tmp('vacia-'))},{buzon:${JSON.stringify(mundo())},soloBuzon:true});process.stdout.write(r.cabecera(M,{sitio:{rol:'maintainer',version:'1'}}))`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /tokens-digest\.js/, 'sin el saneado, la banda lo dice');
  assert.doesNotMatch(r.stdout, /Sin registro de ejecuciones propio/);
});

test('T9 2.36-Corridas_FichasArribaDeLaTabla @story-2.36 @ac-8 — las tres de Ejecuciones, entre el resumen y la tabla, para quien mantiene', async () => {
  const cards = require(path.join(H.SITE, 'tabs', 'cards.js'));
  const f = fuentesCon({ espejo: mundo() });
  // el modelo de fichas que arma el cálculo común del tablero (la misma cuenta la prueba site-cards: UnaSolaCuenta)
  f.st.modelo = { ...f.st.modelo, fichas: cards.modeloDeFichas({ local: {
    corridas: { estado: 'medido', valor: 1.25, medidos: 5, total: 5, unidad: 'conteo', fecha: '2026-08-10' },
    pasos: { estado: 'medido', valor: 41, medidos: 5, total: 5, unidad: 'conteo', fecha: '2026-08-10' },
    bloqueos: { estado: 'no_medido', motivo: 'no hay ningún archivo' },
  } }) };
  await conPestana({ fuentes: f }, async ({ h, entrar }) => {
    const p = (await h.pedir('/corridas', { cookie: await entrar(LEAD) })).texto;
    const deCorridas = cards.FICHAS.filter((x) => x.pestana === 'corridas').map((x) => x.id);
    assert.deepStrictEqual(deCorridas.sort(), ['bloqueos', 'corridas', 'pasos']);
    for (const id of deCorridas) assert.match(p, new RegExp(`data-ficha="${id}"`), `${id} sale en Ejecuciones`);
    for (const x of cards.FICHAS.filter((y) => y.pestana !== 'corridas')) assert.ok(!p.includes(`data-ficha="${x.id}"`), `${x.id} no es de Ejecuciones`);
    // entre el resumen (las fichas del filtro) y la tabla
    const grilla = p.indexOf('id="fichas-corridas"');
    assert.ok(grilla > 0 && grilla > p.indexOf('id="fichas"') && grilla < p.indexOf('<table'), 'la grilla va entre el resumen y la tabla');
    assert.match(p, /data-ficha="corridas"[\s\S]*?t-val">1,3</, 'la mediana con el número del modelo');
    assert.match(p, /class="tile blind" data-ficha="bloqueos"/, 'la que no tiene foto sale no medida, nunca cero');
    // un dev ve su Corridas como antes: las fichas son de la organización
    const pd = (await h.pedir('/corridas', { cookie: await entrar(DEV_A) })).texto;
    assert.doesNotMatch(pd, /data-ficha=|id="fichas-corridas"|id="fichas-calculando"/);
    // de la grilla sólo llegan los títulos fijos y los motivos de la lista cerrada: el motivo libre del tablero no viaja
    assert.ok(!p.includes('no hay ningún archivo'), 'el motivo libre de la fuente no llega a la página');
    // el enlace a una sola corrida (?solo=) esconde el resumen y también la grilla (pase adversarial): la hoja del sitio lo dice
    const css = (await h.pedir('/static/site.css', { cookie: await entrar(LEAD) })).texto;
    assert.match(css, /body\.solo \.corridas #fichas-corridas[^{]*\{display:none\}/, 'con ?solo= la grilla no se ve');
    assert.match(p, /<div class="corridas">[\s\S]*id="fichas-corridas"/, 'la grilla queda dentro de la vista, donde la regla la alcanza');
  });
  // todavía sin fichas (el primer refresco): lo dice, como Arnés; una oculta desde Configuración no sale
  const g = fuentesCon({ espejo: mundo() });
  g.st.modelo = { ...g.st.modelo, fichas: null };
  await conPestana({ fuentes: g }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    assert.match((await h.pedir('/corridas', { cookie: lead })).texto, /id="fichas-calculando"/);
    g.st.modelo = { ...g.st.modelo, fichas: cards.modeloDeFichas({ local: { corridas: { estado: 'medido', valor: 2, medidos: 3, total: 3, unidad: 'conteo' } } }, { ocultas: ['pasos'] }) };
    const p = (await h.pedir('/corridas', { cookie: lead })).texto;
    assert.match(p, /data-ficha="corridas"/);
    assert.doesNotMatch(p, /data-ficha="pasos"|id="fichas-calculando"/);
  });
});

test('T2 CapaEjecutiva_FiltrosYDiezFichas @story-2.27 @ac-2', async () => {
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const c = await clienteDelSitio(h, await entrar(LEAD));
    const fichas = c.nodos.fichas.innerHTML;
    assert.strictEqual((fichas.match(/class="tile/g) || []).length, 10, 'diez fichas');
    assert.match(fichas, /n=\d+ de \d+/, 'las medianas llevan n=');
    assert.match(c.pagina.texto, /id="f-maquina"/, 'el filtro por máquina para quien ve varias');
    c.nodos.fc.checked = true; c.w.__aplicar();
    assert.match(c.nodos.cuenta.textContent, /^\d+ de \d+ ejecuciones a la vista$/);
    c.nodos.fc.checked = false;
    c.nodos['f-desde'].value = '2030-01-01'; c.nodos['f-hasta'].value = '2030-12-31'; c.w.__aplicar();
    assert.strictEqual((c.nodos.fichas.innerHTML.match(/class="tile/g) || []).length, 1, 'con el filtro imposible, la ficha gris única');
  });
});

test('2.45-T4 FiltroSaleEnElIdioma @story-2.45 @ac-4', async () => {
  const filtro = (html) => (/<div class="filtrera">[\s\S]*?<\/div>\s*<div class="grid"/.exec(html) || [''])[0];
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const ses = await entrar(LEAD);
    const en = filtro((await h.pedir('/corridas', { cookie: `${ses}; sitio-idioma=en` })).texto);
    const visibleEn = sinTags(en);
    for (const t of ['from', 'to', 'product', 'machine', 'today', 'this week', 'this month', 'clear']) assert.match(visibleEn, new RegExp(`(^| )${t}( |$)`), `en inglés: «${t}»`);
    assert.doesNotMatch(visibleEn, /desde|hasta|máquina|esta semana|este mes|limpiar|\bhoy\b/, 'ni una etiqueta en castellano');
    assert.match(en, /id="f-hoy"[\s\S]*id="f-semana"[\s\S]*id="f-mes"/, 'los tres atajos');
    assert.match(en, /data-molde="\{n\} of \{t\} runs shown"/, 'el molde de la cuenta, en inglés');
    const es = filtro((await h.pedir('/corridas', { cookie: `${ses}; sitio-idioma=es` })).texto);
    for (const t of ['desde', 'hasta', 'producto', 'máquina', 'hoy', 'esta semana', 'este mes', 'limpiar']) assert.match(sinTags(es), new RegExp(`(^| )${t}( |$)`), `en castellano: «${t}»`);
    assert.match(es, /data-molde="\{n\} de \{t\} ejecuciones a la vista"/);
    // el cliente dibuja la cuenta con el molde del idioma
    const c = await clienteDelSitio(h, `${ses}; sitio-idioma=en`);
    c.w.__aplicar();
    assert.match(c.nodos.cuenta.textContent, /^\d+ of \d+ runs shown$/, c.nodos.cuenta.textContent);
    // y la caché por idioma no mezcla: pedir en castellano después de inglés devuelve castellano
    assert.match(filtro((await h.pedir('/corridas', { cookie: ses })).texto), /limpiar/);
  });
});

test('T3 Graficos_SemanaVaciaEnCero_MesSinMedirRayado @story-2.27 @ac-3', async () => {
  const espejo = mundo({ conB: false, marcadores: false, carpetaSinForma: false });
  // junio medido, julio con una corrida sin consumo medido, agosto medido: julio es el mes sin medir entre dos medidos
  escribir(path.join(espejo, 'maq-a'), 'a0.json', volcado('aaaaaaaa-0000-4000-8000-000000000000', '2026-06-10T09:00:00.000Z', { marker: { storyId: '3.0' } }));
  escribir(path.join(espejo, 'maq-a'), 'aj.json', volcado('aaaaaaaa-0000-4000-8000-00000000000a', '2026-07-10T09:00:00.000Z', { marker: { storyId: '3.9' }, consumo: { estado: 'no_medido', motivo: 'sin hilo', tokens: null, por_paso: null, por_modelo: null } }));
  await conPestana({ fuentes: fuentesCon({ espejo }) }, async ({ h, entrar }) => {
    const c = await clienteDelSitio(h, await entrar(DEV_A));
    const sem = c.nodos.gsem.innerHTML;
    // dev-a corrió en la S32 y en la S34: la S33 sale dibujada en cero, con su barra
    assert.match(sem, /<title>2026-S33: 0 ejecuciones<\/title>/, `la semana vacía, en cero: ${sinTags(sem).slice(0, 200)}`);
    const pasos = c.nodos.gpasos.innerHTML;
    assert.match(pasos, /fill="var\(--hatch\)"[^>]*><title>2026-07: sin ejecuciones medidas<\/title>/, 'el mes sin medir: hueco rayado');
    assert.doesNotMatch(pasos, /<title>2026-07: mediana/, 'nunca en cero');
    assert.match(pasos, /<title>2026-08: mediana \d+ · n=1<\/title>/, 'el mes medido, con su n=');
    assert.match(pasos, /línea base|sin línea base|stroke-dasharray/, 'la línea base, o lo que dice que no hay');
    // los volcados miden tokens sólo en los pasos 0, 4 y 5: los demás, «sin dato» rayado (nunca cero)
    assert.match(c.nodos.ppk.innerHTML, /<i class="hatch"[^>]*><\/i><\/span><span class="pv">sin dato<\/span>/, 'los tokens por paso: «sin dato» rayado donde no hay');
    assert.match(c.nodos.ppt.innerHTML, /n=\d+ de \d+/, 'el tiempo por paso con su n=');
  });
});

test('T4 Tabla_TreceColumnas_UnDetalleAbierto @story-2.27 @ac-4', async () => {
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    const p = (await h.pedir('/corridas', { cookie: lead })).texto;
    const thead = /<thead>([\s\S]*?)<\/thead>/.exec(p)[1];
    assert.strictEqual((thead.match(/<th>/g) || []).length, 13, 'trece columnas, con la de máquina');
    const c = await clienteDelSitio(h, lead);
    assert.ok(c.rows.length >= 2);
    c.w.__abrirFila(c.rows[0]); c.w.__abrirFila(c.rows[2]);
    await c.esperar();
    assert.strictEqual(c.rows.filter((r) => r._cl.has('fila-det')).length, 1, 'un solo detalle abierto');
    assert.strictEqual(c.rows.filter((r) => r._cl.has('abierta')).length, 1);
    // el dev con una sola máquina: doce columnas (sin la de máquina)
    const pd = (await h.pedir('/corridas', { cookie: await entrar(DEV_A) })).texto;
    assert.strictEqual((/<thead>([\s\S]*?)<\/thead>/.exec(pd)[1].match(/<th>/g) || []).length, 12);
  });
});

test('T5b DetalleQueNoSeDibuja_LaFilaLoDice @story-2.27 @ac-5', async () => {
  // un detalle que llega pero no se puede dibujar: la fila dice «no se pudo dibujar el detalle», nunca queda vacía
  await conPestana({ fuentes: fuentesCon({ espejo: mundo({ marcadores: false }) }) }, async ({ h, entrar }) => {
    const roto = (url, j) => (/\/api\/corridas\/[0-9a-f]{16}$/.test(url) ? { id: j.id } : j);
    const c = await clienteDelSitio(h, await entrar(DEV_A), { alterar: roto });
    const errores = []; const original = console.error; console.error = (e) => errores.push(e);
    try { c.w.__abrirFila(c.rows[0]); await c.esperar(); } finally { console.error = original; }
    const det = c.rows.find((r) => r._cl.has('fila-det'));
    assert.ok(det, 'la fila del detalle está');
    assert.match(det.innerHTML, /<span class="nd">no se pudo dibujar el detalle: /, 'dice que no se pudo dibujar (no «traer»: llegó)');
    assert.strictEqual(errores.length, 1, 'y el error va a la consola');
  });
});

test('T5 Detalle_TodoElInventario_ConMensajeRescatado @story-2.27 @ac-5', async () => {
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const dev = await entrar(DEV_A);
    const c = await clienteDelSitio(h, dev);
    const lista = (await h.pedir('/api/corridas', { cookie: dev })).json;
    const a1 = lista.corridas.find((x) => x.story === '3.1');
    const det = (await h.pedir(`/api/corridas/${a1.id}`, { cookie: dev })).json;
    const html = c.w.__detalle(det);
    // los carriles de la línea de tiempo, las minitarjetas y el bloque de archivos (el inventario)
    for (const rot of ['Archivos tocados', 'Consumo', 'Qué encontraron los controles', '<h4>Controles', '<h4>Revisores', '<h4>Consumo', 'Cómo quedó cada archivo · según git', 'Cada cambio, en orden · según la conversación'])
      assert.ok(html.includes(rot), `el detalle trae «${rot}»`);
    assert.ok((html.match(/class="mini/g) || []).length >= 4, 'las cuatro minitarjetas');
    assert.match(html, /<svg[\s\S]*<\/svg>/, 'la línea de tiempo');
    assert.match(html, /class="tokbar"|data-desde=/, 'el consumo se puede abrir («qué se fue»)');
    assert.match(html, /esperaba 2, salió 3/, 'el mensaje rescatado, saneado');
    assert.match(html, /src\/Pago\.ts/, 'el archivo de git');
    assert.match(html, /<h4>Commits<\/h4>|abc1234/, 'los commits');
    // los textos al abrir: el parche de git y el antes/después de la conversación
    const tx = (await h.pedir(`/api/corridas/${a1.id}/textos`, { cookie: dev })).json;
    const abrir = (b64) => JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));
    assert.match(JSON.stringify(abrir(tx.textoGit)), /PARCHE_DE_A/);
    assert.match(JSON.stringify(abrir(tx.texto)), /NUEVO_DE_A/);
  });
});

test('T6 Enlaces_AbrirVerGitMaquinaSolo_ConIdEstable @story-2.27 @ac-6', async () => {
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const dev = await entrar(DEV_A);
    const lista = (await h.pedir('/api/corridas', { cookie: dev })).json;
    const a2 = lista.corridas.find((x) => x.story === '3.2');
    const c = await clienteDelSitio(h, dev, { search: `?abrir=${a2.id}&ver=1&git=0` });
    const abierta = c.rows.find((r) => r._cl.has('abierta'));
    assert.ok(abierta, 'abrió una ejecución');
    assert.strictEqual(abierta.dataset.id, a2.id, 'la del id, no la del índice');
    assert.deepStrictEqual(c.w.__enlace(), { abrir: lista.corridas.indexOf(a2), ver: 1, git: 0, solo: null, maquina: null });
    const solo = await clienteDelSitio(h, dev, { search: `?solo=${a2.id}` });
    assert.strictEqual(solo.w.__enlace().solo, lista.corridas.indexOf(a2));
    const maq = await clienteDelSitio(h, await entrar(LEAD), { search: '?maquina=maq-a' });
    assert.strictEqual(maq.nodos['f-maquina'].value, 'maq-a');
    // en el sitio el índice no es un enlace: `?abrir=0` no abre nada (con el filtro de otra persona, sería otra corrida)
    const indice = await clienteDelSitio(h, dev, { search: '?abrir=0' });
    assert.strictEqual(indice.rows.filter((r) => r._cl.has('abierta')).length, 0);
  });
});

test('T7 Equivalencia_VistaLocalYPestana_MismoTexto @story-2.27 @ac-7', async () => {
  const espejo = mundo({ marcadores: false });
  const home = tmp('site-runs-home-');
  const salida = path.join(tmp('site-runs-local-'), 'o.html');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'dashboard.js'), '--view', 'runs', '--runs-dir', tmp('vacia-'), '--mailbox', espejo, '--output', salida],
    { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_MAILBOX_DIR: '/nonexistent' } });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const local = fs.readFileSync(salida, 'utf8');
  const modeloLocal = JSON.parse(/<script id="modelo" type="application\/json">([\s\S]*?)<\/script>/.exec(local)[1]);
  const clienteLocal = [...local.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
  const tbodyLocal = /<tbody id="cuerpo">([\s\S]*?)<\/tbody>/.exec(local)[1];
  const { nodos: nl, documento: dl } = domMinimo(tbodyLocal);
  dl.getElementById = ((orig) => (id) => (id === 'modelo' ? { textContent: JSON.stringify(modeloLocal) } : orig(id)))(dl.getElementById);
  const wl = { location: { search: '', hash: '' } }; wl.window = wl; wl.parent = wl;
  new Function('window', 'document', 'location', clienteLocal)(wl, dl, wl.location);
  const filasDe = (tb) => tb.split(/<tr /).slice(1).map(sinTags);

  await conPestana({ fuentes: fuentesCon({ espejo }) }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    const c = await clienteDelSitio(h, lead);
    assert.strictEqual(sinTags(c.nodos.fichas.innerHTML), sinTags(nl.fichas.innerHTML), 'las fichas, iguales');
    for (const [k, v] of [['f-desde', '2026-08-06'], ['f-hasta', '2026-08-20']]) { c.nodos[k].value = v; nl[k].value = v; }
    c.w.__aplicar(); wl.__aplicar();
    assert.strictEqual(sinTags(c.nodos.fichas.innerHTML), sinTags(nl.fichas.innerHTML), 'con el mismo filtro, iguales');
    const tbodySitio = /<tbody id="cuerpo"[^>]*>([\s\S]*?)<\/tbody>/.exec(c.pagina.texto)[1];
    assert.deepStrictEqual(filasDe(tbodySitio), filasDe(tbodyLocal), 'cada fila de la tabla, igual');
    const lista = (await h.pedir('/api/corridas', { cookie: lead })).json;
    assert.strictEqual(lista.corridas.length, modeloLocal.corridas.length);
    for (let i = 0; i < lista.corridas.length; i++) {
      const det = (await h.pedir(`/api/corridas/${lista.corridas[i].id}`, { cookie: lead })).json;
      assert.strictEqual(sinTags(c.w.__detalle(det)), sinTags(wl.__detalle(modeloLocal.corridas[i])), `el detalle de la ejecución ${i}, igual`);
    }
  });
});

// ── el filtro por persona, en el servidor ─────────────────────────────────────────────────────────────────────────

test('T8 Dev_SoloSusCorridas_SinConteosGlobales @story-2.27 @ac-8', async () => {
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const dev = await entrar(DEV_A);
    const l = (await h.pedir('/api/corridas', { cookie: dev })).json;
    assert.deepStrictEqual([...new Set(l.corridas.map((c) => c.maquina))], ['maq-a']);
    for (const k of ['archivos', 'duplicados', 'ilegibles']) assert.ok(!(k in l), `sin «${k}»`);
    assert.ok(!l.buzon || !('carpetas_ilegibles' in l.buzon));
    assert.ok(!l.maquinas || !('sin_declarar' in l.maquinas));
    assert.deepStrictEqual(l.maquinas.lista.map((m) => m.nombre), ['maq-a'], 'las opciones de máquina, sólo las suyas');
    const p = (await h.pedir('/corridas', { cookie: dev })).texto;
    const sello = /<div class="stamp">([\s\S]*?)<\/div>/.exec(p)[1];
    assert.match(sinTags(sello), /^Ejecuciones: 2 Con consumo medido: 1 de 2 Con controles: 2 de 2 Llegaron al paso 8: 2 de 2 Generado: \d{4}-\d\d-\d\d \d\d:\d\d UTC · versión del sitio Alcance: maq-a 2$/);
    assert.doesNotMatch(sello, /archivos|esta máquina|undefined/);
    assert.doesNotMatch(p, /href="\/arnes\/tablero"/, 'el eyebrow no enlaza una página que el dev no puede abrir');
  });
});

test('T9 Dev_CorridaAjenaSinMaquinaOInexistente_404Igual @story-2.27 @ac-9', async () => {
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const todas = (await h.pedir('/api/corridas', { cookie: await entrar(LEAD) })).json.corridas;
    const deB = todas.find((c) => c.maquina === 'maq-b').id;
    const suelta = todas.find((c) => !c.maquina).id;
    const dev = await entrar(DEV_A);
    const respuestas = [];
    for (const id of [deB, suelta, '0123456789abcdef']) for (const sufijo of ['', '/textos']) respuestas.push(await h.pedir(`/api/corridas/${id}${sufijo}`, { cookie: dev }));
    for (const r of respuestas) assert.strictEqual(r.status, 404);
    assert.strictEqual(new Set(respuestas.map((r) => r.texto)).size, 1, 'el mismo cuerpo');
  });
});

test('T10 MaquinaSinConfirmarOConfirmacionCaida_SoloMantenedor @story-2.27 @ac-10', async () => {
  const machines = { ...MAQUINAS, 'maq-b': { ...MAQUINAS['maq-b'], reported_sha256: sha(DEV_B) } };
  const fuentes = fuentesCon({ espejo: mundo({ marcadores: false }), config: opsCon(machines), informados: { ...INFORMADOS, 'maq-b': 'otro-correo@ejemplo.test' } });
  await conPestana({ fuentes }, async ({ h, entrar }) => {
    const maqs = async (email) => [...new Set((await h.pedir('/api/corridas', { cookie: await entrar(email) })).json.corridas.map((c) => c.maquina))].sort();
    assert.deepStrictEqual(await maqs(DEV_A), ['maq-a']);
    const b = await h.pedir('/api/corridas', { cookie: await entrar(DEV_B) });
    assert.deepStrictEqual(b.json.corridas, [], 'la confirmación caída: dev-b no ve maq-b');
    const todas = await maqs(LEAD);
    assert.ok(todas.includes('maq-b') && todas.includes('maq-c'), 'quien mantiene sí');
  });
});

test('T11 PersonaSinCorridasTodavia_FichaGris_SinRolComoLa2_23 @story-2.27 @ac-11 @ac-13', async () => {
  const machines = { ...MAQUINAS, 'maq-d': { person: DEV_D, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' } };
  await conPestana({ fuentes: fuentesCon({ espejo: mundo(), config: opsCon(machines) }) }, async ({ h, entrar }) => {
    const d = await entrar(DEV_D);
    const l = (await h.pedir('/api/corridas', { cookie: d })).json;
    assert.deepStrictEqual(l.corridas, []);
    const c = await clienteDelSitio(h, d);
    assert.match(sinTags(c.nodos.fichas.innerHTML), /todavía no hay ejecuciones de tus máquinas en el buzón \(maq-d\): la primera llega sola al terminar un pipeline/);
    assert.doesNotMatch(c.nodos.fichas.innerHTML, /t-val">0/);
    const sinRol = await entrar('nadie@ejemplo.test');
    assert.strictEqual((await h.pedir('/api/corridas', { cookie: sinRol })).status, 403);
    const pag = await h.pedir('/corridas', { cookie: sinRol });
    assert.match(pag.texto, /Tu cuenta no está en la lista/);
    assert.doesNotMatch(pag.texto, /maq-a|3\.1/);
  });
});

test('T12 Mantenedor_VeTodoConConteosGlobales @story-2.27 @ac-12', async () => {
  await conPestana({ fuentes: fuentesCon({ espejo: mundo({ marcadores: false }) }) }, async ({ h, entrar }) => {
    const l = (await h.pedir('/api/corridas', { cookie: await entrar(LEAD) })).json;
    const maqs = new Set(l.corridas.map((c) => c.maquina));
    for (const m of ['maq-a', 'maq-b', 'maq-c', null]) assert.ok(maqs.has(m), `ve ${m}`);
    for (const k of ['archivos', 'duplicados', 'ilegibles']) assert.ok(Number.isFinite(l[k]), `con «${k}»`);
    assert.ok(Number.isFinite(l.maquinas.sin_declarar) && l.maquinas.sin_declarar >= 1);
  });
});

test('T13 SinSesion_NadaDeDatos @story-2.27 @ac-13', async () => {
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const id = (await h.pedir('/api/corridas', { cookie: await entrar(LEAD) })).json.corridas[0].id;
    for (const ruta of ['/corridas', '/api/corridas', `/api/corridas/${id}`, `/api/corridas/${id}/textos`, '/corridas/cliente.js', '/corridas/vista.css']) {
      const r = await h.pedir(ruta);
      if (ruta.startsWith('/api/')) assert.strictEqual(r.status, 401, ruta); else assert.strictEqual(r.status, 302, ruta);
      assert.doesNotMatch(r.texto, /maq-a|3\.1|ejecuciones/i, `${ruta}: sin un byte del modelo`);
    }
  });
});

test('T14 Fuga_NingunMarcadorDeOtroLlegaAlDev @story-2.27 @ac-14', async () => {
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const dev = await entrar(DEV_A);
    const textos = [];
    const pide = async (ruta) => { const r = await h.pedir(ruta, { cookie: dev }); textos.push(r.texto); return r; };
    await pide('/corridas'); await pide('/corridas/cliente.js'); await pide('/corridas/vista.css');
    const l = (await pide('/api/corridas')).json;
    for (const c of l.corridas) { await pide(`/api/corridas/${c.id}`); const t = (await pide(`/api/corridas/${c.id}/textos`)).json;
      for (const b of [t.texto, t.textoGit]) if (b) textos.push(zlib.gunzipSync(Buffer.from(b, 'base64')).toString('utf8')); }
    const todas = (await h.pedir('/api/corridas', { cookie: await entrar(LEAD) })).json.corridas;
    for (const c of todas.filter((x) => x.maquina !== 'maq-a')) { await pide(`/api/corridas/${c.id}`); await pide(`/api/corridas/${c.id}/textos`); }
    const junto = textos.join('\n').toLowerCase();
    for (let k = 1; k <= 8; k++) assert.ok(!junto.includes(`zqx-fuga-b${k}`), `zqx-fuga-b${k} no llega al dev`);
    assert.ok(!junto.includes('sin forma.local'), 'la carpeta sin forma tampoco');
    assert.strictEqual(l.corridas.find((c) => c.story === '3.2').producto, 'RepoComun', 'el producto de su ejecución sigue siendo el suyo');
  });
});

// ── lo que viaja y cuándo ─────────────────────────────────────────────────────────────────────────────────────────

const LISTA_BLANCA = ['id', 'story', 'producto', 'maquina', 'maquina_motivo', 'inicio', 'semana', 'dur_ms', 'llego_al_final', 'ultimo_paso', 'tramos', 'sin_marca', 'tiempos', 'controles', 'costo', 'validador', 'consumo', 'sin_pasos_anotados', 'sin_cerrar'];

test('T15 Lista_ListaBlancaExacta @story-2.27 @ac-15', () => {
  const espejo = mundo({ marcadores: false });
  const M = runs.modelo(tmp('vacia-'), { buzon: espejo, soloBuzon: true });
  const c = M.corridas.find((x) => x.story === '3.1');
  assert.match(c.id, /^[0-9a-f]{16}$/, 'el id estable');
  assert.strictEqual(c.id, runs.idEstable('maq-a', SID.a1));
  const l = runs.paraLista(c);
  assert.deepStrictEqual(Object.keys(l).sort(), [...LISTA_BLANCA].sort());
  assert.deepStrictEqual(Object.keys(l.tiempos).sort(), ['espera_del_hilo_ms', 'espera_humana_ms', 'trabajo_medido', 'trabajo_ms']);
  assert.deepStrictEqual(Object.keys(l.controles).sort(), ['error', 'freno', 'por_control', 'total']);
  assert.deepStrictEqual(Object.keys(l.consumo).sort().filter((k) => !['motivo'].includes(k)), ['estado', 'fuera_de_ventana', 'por_paso', 'respuestas', 'tokens']);
  const t = JSON.stringify(l);
  for (const k of ['_texto', '_textoGit', 'eventos', 'vueltas_ts', 'revisores', 'por_modelo', 'cambios', 'src/Pago.ts']) assert.ok(!t.includes(k), `sin «${k}»`);
});

test('T16 DetalleYTextos_APedido_MismaFormaQueHoy @story-2.27 @ac-16', async () => {
  const espejo = mundo({ marcadores: false });
  await conPestana({ fuentes: fuentesCon({ espejo }) }, async ({ h, entrar }) => {
    const dev = await entrar(DEV_A);
    const l = (await h.pedir('/api/corridas', { cookie: dev })).json;
    assert.ok(!JSON.stringify(l).includes('PARCHE_DE_A'), 'los textos no viajan en la lista');
    const id = l.corridas.find((c) => c.story === '3.1').id;
    const det = (await h.pedir(`/api/corridas/${id}`, { cookie: dev })).json;
    assert.ok(!JSON.stringify(det).includes('PARCHE_DE_A'), 'ni en el detalle');
    assert.ok(det.cambios && det.cambios.git, 'el detalle trae el resumen de los cambios');
    const tx = (await h.pedir(`/api/corridas/${id}/textos`, { cookie: dev })).json;
    // el mismo bloque que la vista local pone en `cg-N`
    const M = runs.modelo(tmp('vacia-'), { buzon: espejo, soloBuzon: true });
    const local = runs.textosDe(M.corridas.find((c) => c.id === id));
    assert.deepStrictEqual(Object.keys(tx).sort(), ['texto', 'textoGit']);
    assert.strictEqual(zlib.gunzipSync(Buffer.from(tx.textoGit, 'base64')).toString(), zlib.gunzipSync(Buffer.from(local.textoGit, 'base64')).toString());
  });
});

test('T17 Modelo_ListaBlanca_SinCamposNuevos @story-2.27 @ac-17', () => {
  const espejo = mundo({ marcadores: false });
  const M = runs.modelo(tmp('vacia-'), { buzon: espejo, soloBuzon: true });
  for (const c of M.corridas) {
    const salida = JSON.stringify([runs.paraLista(c), runs.paraDetalle(c)]);
    for (const k of ['zqx-prohibido-prompt', 'zqx-prohibido-archivo', 'zqx-prohibido-cmd', 'planApproval', 'filesTouched']) assert.ok(!salida.includes(k), `«${k}» no sale`);
    for (const sid of Object.values(SID)) assert.ok(!salida.includes(sid), 'el id de sesión crudo no sale');
    assert.ok(!('_texto' in (runs.paraDetalle(c).cambios || {})), 'los textos no van en el detalle');
  }
  // la pestaña no lee el volcado ni el hilo por su cuenta: sólo `modelo()` de runs.js
  const tab = fs.readFileSync(path.join(H.SITE, 'tabs', 'runs.js'), 'utf8');
  assert.doesNotMatch(tab, /hilo\.jsonl|cambio\.json|dirBuzon[^\n]*readFileSync|leerRegistro|modeloDeCorrida/, 'la pestaña no lee el espejo por su cuenta');
});

// ── las fuentes y los modos de falla ──────────────────────────────────────────────────────────────────────────────

test('T18 Buzon_NoLeidoOParcial_BandaConMotivo @story-2.27 @ac-19', async () => {
  // una carpeta de máquina ilegible: para el dev, «puede faltar alguna corrida tuya», sin el número
  const espejo = mundo({ marcadores: false });
  const mala = path.join(espejo, 'maq-z');
  fs.mkdirSync(mala); fs.chmodSync(mala, 0o000);
  try {
    await conPestana({ fuentes: fuentesCon({ espejo }) }, async ({ h, entrar }) => {
      const dev = await entrar(DEV_A);
      const l = (await h.pedir('/api/corridas', { cookie: dev })).json;
      assert.deepStrictEqual(l.buzon, { estado: 'leido', parcial: true });
      const p = (await h.pedir('/corridas', { cookie: dev })).texto;
      assert.match(p, /puede faltar alguna ejecución tuya: el buzón no se leyó entero/);
      assert.doesNotMatch(p, /carpeta de máquina del buzón no se pudo leer/);
      const pl = (await h.pedir('/corridas', { cookie: await entrar(LEAD) })).texto;
      assert.match(pl, /1 carpeta de máquina del buzón no se pudo leer/);
    });
  } finally { fs.chmodSync(mala, 0o755); }
  // el espejo no se pudo leer: la banda con su motivo para quien mantiene; al dev, que puede faltar alguna suya
  await conPestana({ fuentes: fuentesCon({ espejo: path.join(tmp('site-runs-nada-'), 'no-existe') }) }, async ({ h, entrar }) => {
    const pl = (await h.pedir('/corridas', { cookie: await entrar(LEAD) })).texto;
    assert.match(pl, /No se leyó la carpeta bajada del buzón\.<\/b> la carpeta bajada del buzón de ejecuciones no se pudo leer \(ENOENT\)/);
    assert.doesNotMatch(pl, /0 ejecuciones/);
    const dev = await entrar(DEV_A);
    assert.deepStrictEqual((await h.pedir('/api/corridas', { cookie: dev })).json.buzon, { estado: 'no_medido', parcial: true });
    assert.match((await h.pedir('/corridas', { cookie: dev })).texto, /puede faltar alguna ejecución tuya: el buzón no se leyó entero/);
  });
  // sin buzón configurado: gris «no medido»
  const sinBuzon = fuentesCon({ espejo: mundo(), config: { ...opsCon(), site: { maintainers: [LEAD] } } });
  await conPestana({ fuentes: sinBuzon, opciones: { noEsperar: true } }, async ({ h, entrar }) => {
    const p = await h.pedir('/corridas', { cookie: await entrar(LEAD) });
    assert.strictEqual(p.status, 200);
    assert.match(p.texto, /sin buzón configurado: no medido/);
    assert.doesNotMatch(p.texto, /0 ejecuciones/);
    // el detalle tampoco: «no medido», no el 404 mudo de «no es tuya»
    const d = await h.pedir('/api/corridas/0123456789abcdef', { cookie: await entrar(LEAD) });
    assert.strictEqual(d.status, 404);
    assert.match(d.texto, /sin buzón configurado: no medido/);
  });
});

test('T19 ModeloQueTira_503ConCodigo_LasOtrasPestanasAndan @story-2.27 @ac-20', async () => {
  const armar = async () => { throw Object.assign(new Error('no se pudo leer /secreto/ruta/buzon'), { code: 'EACCES' }); };
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }), opciones: { armar, noEsperar: true } }, async ({ h, entrar, vista }) => {
    await vista.listo().catch(() => {});
    const lead = await entrar(LEAD);
    for (const ruta of ['/corridas', '/api/corridas']) {
      const r = await h.pedir(ruta, { cookie: lead });
      assert.strictEqual(r.status, 503, ruta);
      assert.match(r.texto, /no se pudo armar la vista de ejecuciones/);
      assert.match(r.texto, /EACCES/);
      assert.doesNotMatch(r.texto, /secreto|\/ruta\//, 'sin rutas');
    }
    assert.strictEqual((await h.pedir('/', { cookie: lead })).status, 200, 'Inicio anda');
  });
  // un armado colgado (sin llegar al techo de memoria) se corta con su código, no deja la pestaña armando para siempre
  const colgado = await TAB().armarEnWorker({ buzon: '/nonexistent', textosDir: path.join(tmp('site-runs-col-'), 't'), tiempoMs: 1 }).then(() => null, (e) => e);
  assert.ok(colgado && ['TIEMPO_AGOTADO'].includes(colgado.code), `cortado por tiempo: ${colgado && colgado.code}`);
});

test('T19b TextosIlegibles_NoSonSinTexto @story-2.27 @ac-16 @ac-20', async () => {
  // los textos de una corrida rotos en el disco del sitio: 500 «no se pudieron leer», nunca el {null,null} de «no hay»
  await conPestana({ fuentes: fuentesCon({ espejo: mundo({ marcadores: false }) }) }, async ({ h, entrar, vista }) => {
    const dev = await entrar(DEV_A);
    const id = (await h.pedir('/api/corridas', { cookie: dev })).json.corridas.find((c) => c.story === '3.1').id;
    assert.strictEqual((await h.pedir(`/api/corridas/${id}/textos`, { cookie: dev })).status, 200);
    fs.writeFileSync(path.join(vista.textosDir(), `${id}.json`), '{ roto');
    const r = await h.pedir(`/api/corridas/${id}/textos`, { cookie: dev });
    assert.strictEqual(r.status, 500);
    assert.match(r.texto, /no se pudieron leer/);
  });
});

test('T20 Rearmado_SirveElAnteriorEntero @story-2.27 @ac-20', async () => {
  let n = 0;
  let soltar = null;
  const armarReal = TAB().armarEnElHilo;
  const armar = async (o) => { n += 1; if (n === 2) await new Promise((r) => { soltar = r; }); if (n === 3) throw Object.assign(new Error('memoria'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }); return armarReal(o); };
  const espejo = mundo({ marcadores: false });
  const fuentes = fuentesCon({ espejo });
  await conPestana({ fuentes, opciones: { armar } }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    const antes = (await h.pedir('/api/corridas', { cookie: lead })).json;
    escribir(path.join(espejo, 'maq-a'), 'a3.json', volcado('aaaaaaaa-0000-4000-8000-000000000003', '2026-08-20T09:00:00.000Z', { marker: { storyId: '3.3' } }));
    fuentes.avisar();
    // el armado arranca cuando termina la huella del espejo (en un hilo aparte)
    for (let i = 0; i < 200 && !soltar; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(soltar, 'el rearmado arrancó');
    const mientras = (await h.pedir('/api/corridas', { cookie: lead })).json;
    assert.deepStrictEqual(mientras, antes, 'mientras rearma: el anterior, entero');
    soltar(); await vista.listo();
    const despues = (await h.pedir('/api/corridas', { cookie: lead })).json;
    assert.strictEqual(despues.corridas.length, antes.corridas.length + 1, 'después: el nuevo, entero');
    assert.notStrictEqual(despues.generado, antes.generado, 'el sello dice cuál');
    // un armado que falla (también por memoria) deja el anterior, nunca una pantalla vacía
    escribir(path.join(espejo, 'maq-a'), 'a4.json', volcado('aaaaaaaa-0000-4000-8000-000000000004', '2026-08-21T09:00:00.000Z', { marker: { storyId: '3.4' } }));
    fuentes.avisar(); await vista.listo();
    const tras = await h.pedir('/api/corridas', { cookie: lead });
    assert.strictEqual(tras.status, 200);
    assert.deepStrictEqual(tras.json, despues);
    assert.match((await h.pedir('/corridas', { cookie: lead })).texto, /no se pudo rearmar la vista de ejecuciones/i, 'y lo dice');
  });
});

test('T21 Umbrales_DeLaOrganizacionSiLosTrae @story-2.27 @ac-21', async () => {
  // dev-a: 2 corridas, las 2 llegaron al 8 → con un tope de 0,9 la ficha sigue «bien»; armamos 4 de 5 con maq-c
  const espejo = mundo({ marcadores: false, conB: false, carpetaSinForma: false });
  for (let i = 3; i <= 5; i++) escribir(path.join(espejo, 'maq-a'), `a${i}.json`, volcado(`aaaaaaaa-0000-4000-8000-00000000000${i}`, `2026-08-1${i}T09:00:00.000Z`, { marker: { storyId: `3.${i}`, stepsCompleted: i === 5 ? [0, 1, 2, 3] : [0, 1, 2, 3, 4, 5, 6, 7, 8], stepTimings: i === 5 ? { 8: null } : {} } }));
  const ops = tmp('site-runs-ops-');
  const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'sources.json'), 'utf8'));
  const conOrg = (th) => { fs.mkdirSync(path.join(ops, 'scripts', 'nightly', 'dashboard'), { recursive: true }); fs.writeFileSync(path.join(ops, 'scripts', 'nightly', 'dashboard', 'sources.json'), JSON.stringify({ ...sources, thresholds: { ...sources.thresholds, ...th } })); };
  const fichaAlFinal = async (fuentes) => {
    let html = '';
    await conPestana({ fuentes }, async ({ h, entrar }) => { html = (await clienteDelSitio(h, await entrar(DEV_A))).nodos.fichas.innerHTML; });
    const f = html.split('class="tile').find((x) => /llegaron al último paso/i.test(x)) || '';
    return f;
  };
  conOrg({ corridas_al_final: { direction: 'mayor_es_mejor', ok_min: 0.9, bad_max: 0.5 } });
  assert.match(await fichaAlFinal(fuentesCon({ espejo, ops })), /atenci/, 'con el de la organización: atención');
  assert.match(await fichaAlFinal(fuentesCon({ espejo, ops: null })), /bien|ok/i, 'con el del arnés: bien');
  conOrg({ corridas_al_final: { ok_min: 0.9, bad_max: 0.5 } });
  assert.match(await fichaAlFinal(fuentesCon({ espejo, ops })), /neutr|sin juicio|umbral/i, 'la fila rota: neutra con su motivo');
});

// ── cualquier organización, y la página ───────────────────────────────────────────────────────────────────────────

test('T22 Codigo_SinValoresDeUnaOrganizacion @story-2.27 @ac-22', () => {
  const marcas = [/tycon/i, /bizuit/i, /dev\.azure\.com\/[a-z]/i, /@[a-z0-9-]+\.com\.ar/i, /harness-team-(profile|operations)\b/, /TYCON-SA/, /corridasbuzon|tyconruns/i, /blob\.core\.windows\.net/];
  // (los nombres de máquina reales no se escriben acá: el árbol se publica, y su freno los busca en todo lo publicado)
  const t = fs.readFileSync(path.join(H.SITE, 'tabs', 'runs.js'), 'utf8');
  for (const rx of marcas) assert.ok(!rx.test(t), `tabs/runs.js no trae ${rx}`);
  // las funciones de runs.js que el sitio usa
  const r = fs.readFileSync(RUNS, 'utf8');
  for (const nombre of ['function idEstable', 'function paraLista', 'function paraDetalle', 'function textosDe', 'function cabecera', 'function tabla', 'function pie']) {
    const i = r.indexOf(nombre);
    assert.ok(i >= 0, `runs.js tiene ${nombre}`);
    // `.tycon-pipeline` es la carpeta de estado del arnés (el texto de la vista local), no un valor de una organización
    const cuerpo = r.slice(i, r.indexOf('\n}\n', i)).replace(/\.tycon-pipeline/g, '');
    for (const rx of marcas) assert.ok(!rx.test(cuerpo), `${nombre} no trae ${rx}`);
  }
});

test('T25 Pagina_SinScriptNiStyleEnLinea_PasaLaPoliticaDelSitio @story-2.27 @ac-25', async () => {
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    const p = await h.pedir('/corridas', { cookie: lead });
    assert.strictEqual((p.texto.match(/<script(?![^>]*\bsrc=)[^>]*>/g) || []).length, 0, 'ningún <script> sin src');
    assert.strictEqual((p.texto.match(/<style/g) || []).length, 0, 'ningún <style>');
    assert.match(p.texto, /<script src="\/corridas\/cliente\.js"><\/script>/);
    assert.match(p.texto, /<link rel="stylesheet" href="\/corridas\/vista\.css">/);
    assert.match(p.headers['content-security-policy'], /script-src 'self'/);
    const js = await h.pedir('/corridas/cliente.js', { cookie: lead });
    assert.match(js.headers['content-type'], /javascript/);
    const css = await h.pedir('/corridas/vista.css', { cookie: lead });
    assert.match(css.headers['content-type'], /text\/css/);
  });
});

// La espera por fuente: el sitio ya se navega con el repo leído; sólo Corridas espera el buzón, lo dice y
// se recarga sola. 🔴 rojo: «no medido: el buzón todavía no se pudo bajar entero» mientras la primera bajada corría
test('T27b CorridasCargando_LoDiceYSeRecarga @story-2.27 @ac-20', async () => {
  const fuentes = fuentesCon({ espejo: mundo({ marcadores: false }) });
  fuentes.bajada = { completo: false, generacion: 0 };
  fuentes.st.modelo = { corridas: { estado: 'no_medido', codigo: 'cargando', motivo: null, lista: [] } };
  await conPestana({ fuentes, opciones: { noEsperar: true } }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    const p = await h.pedir('/corridas', { cookie: lead });
    assert.strictEqual(p.status, 503);
    assert.match(p.texto, /cargando las ejecuciones/);
    assert.match(p.texto, /<meta http-equiv="refresh" content="5">/, 'se recarga sola');
    assert.doesNotMatch(p.texto, /no medido/, 'mientras carga, no es «no medido»');
    assert.doesNotMatch(p.texto, /<script(?![^>]*\bsrc=)[^>]*>/, 'sin script en línea');
    const api = await h.pedir('/api/corridas', { cookie: lead });
    assert.strictEqual(api.status, 503);
    assert.match(api.texto, /cargando las ejecuciones/);
    // una pasada que cortó y ya sigue: también «cargando»
    fuentes.st.modelo = { corridas: { estado: 'no_medido', codigo: 'parcial', motivo: null, lista: [] } };
    fuentes.bajada = { completo: false, generacion: 0, siguiendo: true };
    assert.match((await h.pedir('/corridas', { cookie: lead })).texto, /cargando las ejecuciones/);
    assert.strictEqual((await h.pedir('/', { cookie: lead })).status, 200, 'Inicio no espera las ejecuciones');
  });
});

test('T27 Armado_EnWorker_HealthzContesta @story-2.27 @ac-8 @ac-20', async () => {
  // el armado de verdad (en su hilo) con un espejo que tarda: mientras arma, /healthz e Inicio contestan rápido
  const espejo = mundo({ marcadores: false });
  for (let i = 0; i < 150; i++) escribir(path.join(espejo, 'maq-a'), `g${i}.json`, volcado(`99999999-0000-4000-8000-${String(i).padStart(12, '0')}`, '2026-08-21T09:00:00.000Z'));
  await conPestana({ fuentes: fuentesCon({ espejo }), opciones: { noEsperar: true, demora: 1500 } }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    assert.ok(vista.armando(), 'arrancó a armar');
    // una duración, no una fecha: el reloj monótono del proceso
    const t0 = performance.now();
    assert.strictEqual((await h.pedir('/healthz')).status, 200);
    assert.strictEqual((await h.pedir('/', { cookie: lead })).status, 200);
    const ms = Math.round(performance.now() - t0);
    assert.ok(ms < 1000, `contestaron en ${ms} ms`);
    const cargando = await h.pedir('/api/corridas', { cookie: lead });
    assert.strictEqual(cargando.status, 503, 'al despertar sin datos: cargando');
    assert.ok(cargando.headers['retry-after']);
    await vista.listo();
    assert.strictEqual((await h.pedir('/api/corridas', { cookie: lead })).status, 200);
    assert.ok(Number.isFinite(vista.estado().pico_mb), 'el armado anota su pico de memoria');
  });
});

test('T29 SinDisco_LoDelHiloNoMedido @story-2.27 @ac-11 @ac-18', async () => {
  // `site.mailbox.threads` apagado (el espejo no trae las conversaciones); y aparte, con conversaciones pero sin
  // SITE_DATA_DIR (sin un disco del sitio no cuentan)
  for (const caso of [{ fuentes: fuentesCon({ espejo: mundo({ marcadores: false }), hilos: false }) }, { fuentes: fuentesCon({ espejo: mundo({ marcadores: false }), hilos: true }), sinDisco: true }]) {
    await conPestana(caso, async ({ h, entrar }) => {
      const dev = await entrar(DEV_A);
      const l = (await h.pedir('/api/corridas', { cookie: dev })).json;
      const a1 = l.corridas.find((c) => c.story === '3.1');
      assert.strictEqual(a1.tiempos.espera_del_hilo_ms, null, 'la espera del hilo: no medida, no cero');
      const det = (await h.pedir(`/api/corridas/${a1.id}`, { cookie: dev })).json;
      assert.strictEqual(det.cambios.motivo, 'no medido: este sitio no baja las conversaciones');
      const c = await clienteDelSitio(h, dev);
      assert.match(sinTags(c.w.__detalle(det)), /no medido: este sitio no baja las conversaciones/);
      assert.match(sinTags(c.nodos.fichas.innerHTML), /no medido: este sitio no baja las conversaciones/);
    });
  }
});

test('T30 Pasos_NombresDeLaImagen @story-2.27 @ac-18', () => {
  const skills = tmp('site-runs-skills-');
  const lib = path.join(skills, 'tycon-pipeline', 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js'), path.join(lib, 'steps.js'));
  const M = runs.modelo(tmp('vacia-'), { buzon: mundo({ marcadores: false }), soloBuzon: true, skillsDir: skills });
  assert.strictEqual(M.pasos.fuente, 'skill');
  assert.ok(M.pasos.nombres.every((n) => !/^\d$/.test(n)), 'con nombre');
  assert.doesNotMatch(runs.cabecera(M, { sitio: { rol: 'maintainer', version: '1' } }), /los pasos van por número/);
  const sinTabla = runs.modelo(tmp('vacia-'), { buzon: mundo({ marcadores: false }), soloBuzon: true, skillsDir: tmp('vacia-') });
  assert.strictEqual(sinTabla.pasos.fuente, 'numeros', 'sin la tabla en la imagen: por número, y se dice (nunca ~/.claude/agent-skills)');
});

// ── casos de borde: una prueba por cada clase ─────────────────────────────────────────

test('2.27-A1 QuienEsQuienSinMedir_NoMedidoNuncaVacio @story-2.27 @ac-11 @ac-19', async () => {
  // antes de la primera bajada entera no se sabe de quién es cada máquina: el dev no ve nada (cierra), pero la respuesta
  // dice «no medido», nunca «todavía no hay corridas (ninguna confirmada)» con el buzón «leído entero»
  await conPestana({ fuentes: fuentesCon({ espejo: mundo({ marcadores: false }), informados: null }) }, async ({ h, entrar }) => {
    const dev = await entrar(DEV_A);
    const l = (await h.pedir('/api/corridas', { cookie: dev })).json;
    assert.deepStrictEqual(l.corridas, []);
    assert.match(l.vacio_motivo, /^no medido: todavía no se pudo saber de quién es cada máquina/);
    assert.doesNotMatch(l.vacio_motivo, /ninguna confirmada|la primera llega sola/);
    assert.strictEqual(l.buzon.parcial, true);
    const c = await clienteDelSitio(h, dev);
    assert.match(sinTags(c.nodos.fichas.innerHTML), /no medido: todavía no se pudo saber de quién es cada máquina/);
    assert.ok((await h.pedir('/api/corridas', { cookie: await entrar(LEAD) })).json.corridas.length >= 4, 'quien mantiene ve todas igual');
  });
});

test('2.27-A2 Huella_UnionesReescritasSinCambios_NoRearma @story-2.27 @ac-20', async () => {
  // la bajada reescribe .carpetas-de-maquina.json en cada pasada (escritura atómica, fecha nueva): sin cambio de
  // contenido la huella es la misma; con cambio, otra
  const espejo = mundo({ marcadores: false });
  const uniones = path.join(espejo, '.carpetas-de-maquina.json');
  const doc = JSON.stringify({ schema: 1, carpetas: {}, regeneradas: {} });
  fs.writeFileSync(uniones, doc);
  const h1 = TAB().huellaDelEspejo(espejo);
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(`${uniones}.tmp`, doc); fs.renameSync(`${uniones}.tmp`, uniones);
  assert.strictEqual(TAB().huellaDelEspejo(espejo), h1, 'el mismo contenido con fecha nueva: la misma huella');
  fs.writeFileSync(uniones, JSON.stringify({ schema: 1, carpetas: { 'maq-x': { estado: 'unida', nueva: 'maq-a' } }, regeneradas: {} }));
  assert.notStrictEqual(TAB().huellaDelEspejo(espejo), h1, 'otro contenido: otra huella');
  // y en la pestaña: avisar sin cambios no rearma
  let armados = 0;
  const armarReal = TAB().armarEnElHilo;
  const fuentes = fuentesCon({ espejo });
  await conPestana({ fuentes, opciones: { armar: (o) => { armados += 1; return armarReal(o); } } }, async ({ vista }) => {
    fs.writeFileSync(`${uniones}.tmp`, fs.readFileSync(uniones)); fs.renameSync(`${uniones}.tmp`, uniones);
    fuentes.avisar(); await vista.listo();
    assert.strictEqual(armados, 1, 'un solo armado');
  });
});

test('2.27-A3 BajadaAMedias_NoRearma_YDiceQuePuedeFaltar @story-2.27 @ac-19 @ac-20', async () => {
  // con la última bajada a medias no se rearma (el espejo sería más nuevo que lo informado por las máquinas: una que
  // cambió de dueño mostraría corridas al anterior); se sirve el último armado entero y la respuesta lo dice
  const espejo = mundo({ marcadores: false });
  const fuentes = fuentesCon({ espejo });
  await conPestana({ fuentes }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    const antes = (await h.pedir('/api/corridas', { cookie: lead })).json;
    escribir(path.join(espejo, 'maq-a'), 'a7.json', volcado('aaaaaaaa-0000-4000-8000-000000000007', '2026-08-22T09:00:00.000Z', { marker: { storyId: '3.7' } }));
    fuentes.bajada = { completo: false, generacion: 1 };
    fuentes.avisar(); await vista.listo();
    assert.strictEqual(vista.armando(), false);
    const l = (await h.pedir('/api/corridas', { cookie: lead })).json;
    assert.strictEqual(l.generado, antes.generado, 'el último armado entero');
    assert.strictEqual(l.corridas.length, antes.corridas.length);
    assert.strictEqual(l.buzon.parcial, true);
    assert.match((await h.pedir('/corridas', { cookie: lead })).texto, /La última bajada del buzón no terminó entera/);
    const dev = await entrar(DEV_A);
    assert.strictEqual((await h.pedir('/api/corridas', { cookie: dev })).json.buzon.parcial, true);
    assert.match((await h.pedir('/corridas', { cookie: dev })).texto, /puede faltar alguna ejecución tuya/);
    // la privacidad: maq-b pasó a otra persona y su corrida nueva bajó en una bajada A MEDIAS, cuando
    // lo informado todavía es el de la última entera (dice dev-b). dev-b no la ve: el espejo a medias no se arma
    escribir(path.join(espejo, 'maq-b'), 'b9.json', volcado('bbbbbbbb-0000-4000-8000-000000000009', '2026-08-23T09:00:00.000Z', { marker: { storyId: 'de-la-persona-nueva' } }));
    fuentes.avisar(); await vista.listo();
    const b = (await h.pedir('/api/corridas', { cookie: await entrar(DEV_B) })).json;
    assert.ok(!JSON.stringify(b).includes('de-la-persona-nueva'), 'el dueño anterior de maq-b no ve la ejecución de la persona nueva');
    // la bajada siguiente termina entera, con lo informado al día (maq-b informa otro correo): ahí sí se rearma, y la
    // confirmación de dev-b cae, así que dev-b tampoco la ve
    fuentes.st.personas = { informados: H.informados({ ...INFORMADOS, 'maq-b': 'persona-nueva@ejemplo.test' }), repos: null };
    fuentes.bajada = { completo: true, generacion: 2 };
    fuentes.avisar(); await vista.listo();
    const b2 = (await h.pedir('/api/corridas', { cookie: await entrar(DEV_B) })).json;
    assert.ok(!JSON.stringify(b2).includes('de-la-persona-nueva'), 'con la bajada entera, tampoco');
    assert.ok((await h.pedir('/api/corridas', { cookie: lead })).json.corridas.some((c) => c.story === 'de-la-persona-nueva'), 'quien mantiene sí');
    fuentes.st.personas = { informados: H.informados(INFORMADOS), repos: null };
    // y con todo al día, el rearmado trae las nuevas
    fuentes.bajada = { completo: true, generacion: 3 };
    fuentes.avisar(); await vista.listo();
    assert.strictEqual((await h.pedir('/api/corridas', { cookie: lead })).json.corridas.length, antes.corridas.length + 2);
  });
  // sin ninguna bajada entera y con la fuente diciendo por qué: «no medido», no «cargando» para siempre
  const nunca = fuentesCon({ espejo: mundo({ marcadores: false }) });
  nunca.bajada = { completo: false, generacion: 0 };
  nunca.st.modelo = { corridas: { estado: 'no_medido', codigo: 'credencial_rechazada' } };
  await conPestana({ fuentes: nunca, opciones: { noEsperar: true } }, async ({ h, entrar }) => {
    const p = await h.pedir('/corridas', { cookie: await entrar(LEAD) });
    assert.strictEqual(p.status, 200);
    assert.match(p.texto, /no medido: el buzón todavía no se pudo bajar entero \(credencial_rechazada\)/);
  });
  // ya hubo una entera pero la pestaña no armó todavía y la última quedó a medias: tampoco «cargando» sin motivo
  const media = fuentesCon({ espejo: mundo({ marcadores: false }) });
  media.bajada = { completo: false, generacion: 3 };
  await conPestana({ fuentes: media, opciones: { noEsperar: true } }, async ({ h, entrar }) => {
    const p = await h.pedir('/corridas', { cookie: await entrar(LEAD) });
    assert.strictEqual(p.status, 200);
    assert.match(p.texto, /no medido: el buzón todavía no se pudo bajar entero/);
  });
});

test('2.27-A4 FilaPorId_LaListaCambioEntreLosDosPedidos @story-2.27 @ac-4 @ac-6', async () => {
  // la tabla vino con la página y la lista en otro pedido: si entre los dos cambió el orden, la fila abre SU corrida
  await conPestana({ fuentes: fuentesCon({ espejo: mundo({ marcadores: false }) }) }, async ({ h, entrar }) => {
    const alReves = (url, j) => (url === '/api/corridas' ? { ...j, corridas: [...j.corridas].reverse() } : j);
    const c = await clienteDelSitio(h, await entrar(LEAD), { alterar: alReves });
    const fila = c.rows[0];
    c.w.__abrirFila(fila); await c.esperar();
    const pedido = c.pedidos.filter((u) => /^\/api\/corridas\/[0-9a-f]{16}$/.test(u)).pop();
    assert.strictEqual(pedido, `/api/corridas/${fila.dataset.id}`, 'pidió el detalle de la ejecución de esa fila');
  });
});

test('2.27-A5 Sitio_CambiosYParchesConSuFila @story-2.27 @ac-5 @ac-16', async () => {
  // en el sitio el detalle es otro objeto que la corrida de la lista: los <details> llevan la fila, nunca -1
  await conPestana({ fuentes: fuentesCon({ espejo: mundo({ marcadores: false }) }) }, async ({ h, entrar }) => {
    const dev = await entrar(DEV_A);
    const c = await clienteDelSitio(h, dev);
    const k = c.rows.findIndex((r) => r.dataset.id);
    const lista = (await h.pedir('/api/corridas', { cookie: dev })).json.corridas;
    const i = lista.findIndex((x) => x.story === '3.1');
    const fila = c.rows.find((r) => r.dataset.id === lista[i].id);
    assert.ok(k >= 0 && fila);
    c.w.__abrirFila(fila); await c.esperar();
    const det = c.rows.find((r) => r._cl.has('fila-det'));
    assert.match(det.innerHTML, new RegExp(`data-cg="${i}"`), 'el parche de git con su fila');
    assert.match(det.innerHTML, new RegExp(`data-cz="${i}"`), 'el cambio de la conversación con su fila');
    assert.doesNotMatch(det.innerHTML, /data-c[gz]="-1"/);
  });
});

test('2.30-T49 Detalle_ResumidaBajaSusTextosADemanda_ConCacheConTope @story-2.30 @ac-25', async () => {
  // con el espejo resumido (sin conversaciones en el disco), abrir los cambios de una corrida baja su conversación y su
  // cambio del buzón, arma los textos y los guarda en un caché fuera de SITE_DATA_DIR; la segunda vez salen del caché, y
  // con el caché lleno se borran los abiertos hace más tiempo
  const original = mundo({ marcadores: false });
  const blobs = {};
  for (const f of ['maq-a/a1.hilo.jsonl.gz', 'maq-a/a1.cambio.json.gz', 'maq-b/b1.hilo.jsonl.gz', 'maq-b/b1.cambio.json.gz']) blobs[f] = fs.readFileSync(path.join(original, f));
  const buzon = await H.arrancarBuzon({ blobs });
  const espejo = mundo({ marcadores: false });
  const r = runs.resumirEspejo(espejo, { skillsDir: path.join(ROOT, 'skills') });
  assert.strictEqual(r.resumidas, 2, JSON.stringify(r));
  const fuentes = fuentesCon({ espejo });
  const { bajarUnaCorrida } = require(path.join(ROOT, 'scripts', 'metrics', 'download-runs.js'));
  fuentes.bajarCorrida = ({ maquina, base, dir }) => bajarUnaCorrida({ cuenta: 'cuentax', contenedor: 'runs', credencial: { sas: H.sas() }, urlBase: buzon.base, maquina, base, dir });
  const descomprimir = (b64) => zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
  try {
    await conPestana({ fuentes, opciones: { topeCacheBytes: 1 } }, async ({ h, entrar, vista, cfg }) => {
      const lead = await entrar(LEAD);
      const lista = (await h.pedir('/api/corridas', { cookie: lead })).json.corridas;
      const idA = lista.find((c) => c.story === '3.1').id;
      const pedidosA = () => buzon.pedidos.filter((p) => /a1\.(hilo\.jsonl|cambio\.json)\.gz$/.test(p.ruta)).length;
      const t = await h.pedir(`/api/corridas/${idA}/textos`, { cookie: lead });
      assert.strictEqual(t.status, 200, t.texto);
      assert.match(descomprimir(t.json.texto), /NUEVO_DE_A/, 'el cambio de la conversación, bajado a demanda');
      assert.match(descomprimir(t.json.textoGit), /PARCHE_DE_A/, 'y el parche de git');
      assert.strictEqual(pedidosA(), 2, 'se bajaron las dos partes de esa ejecución');
      // la segunda vez, del caché: el buzón no se vuelve a tocar
      const t2 = await h.pedir(`/api/corridas/${idA}/textos`, { cookie: lead });
      assert.deepStrictEqual(t2.json, t.json);
      assert.strictEqual(pedidosA(), 2, 'del caché');
      // el caché, fuera del disco del sitio, y con su tope: abrir otra corrida borra la de antes
      assert.ok(!path.resolve(vista.dirCache()).startsWith(path.resolve(cfg.dataDir)), 'el caché no está en SITE_DATA_DIR');
      const idB = lista.find((c) => c.maquina === 'maq-b').id;
      assert.strictEqual((await h.pedir(`/api/corridas/${idB}/textos`, { cookie: lead })).status, 200);
      assert.deepStrictEqual(fs.readdirSync(vista.dirCache()), [`${idB}.json`], 'con el tope lleno queda la última abierta');
      // lo bajado para armar el detalle no queda en ningún lado: ni en el espejo ni en el disco del sitio
      assert.deepStrictEqual(fs.readdirSync(espejo, { recursive: true }).filter((f) => /\.(hilo\.jsonl|cambio\.json)\.gz$/.test(f)), []);
      // un buzón que no contesta: «no se pudieron leer» (500), nunca «no hay cambios»
      buzon.st.modo = '503';
      fs.rmSync(path.join(vista.dirCache(), `${idB}.json`));
      const caido = await h.pedir(`/api/corridas/${idB}/textos`, { cookie: lead });
      assert.strictEqual(caido.status, 500, caido.texto);
    });
  } finally { await buzon.cerrar(); }
});

test('2.27-A6 Arranque_BorraLosTextosDeArmadosAnteriores @story-2.27 @ac-20', () => {
  const datos = tmp('site-runs-arranque-');
  const viejo = path.join(datos, 'corridas-textos', '1700000000000-abcd1234');
  fs.mkdirSync(viejo, { recursive: true });
  fs.writeFileSync(path.join(viejo, '0123456789abcdef.json'), '{}');
  const f = fuentesCon({ espejo: mundo({ marcadores: false }) });
  f.st.cargado = false;   // sin armar: sólo el arranque
  const vista = TAB().crearVista({ cfg: { dataDir: datos }, fuentes: f });
  // los textos viven en el disco del contenedor, no en el del sitio: una carpeta de textos en SITE_DATA_DIR se borra entera
  assert.ok(!fs.existsSync(path.join(datos, 'corridas-textos')), 'la carpeta de un arranque anterior no queda');
  assert.ok(!path.resolve(vista.dirCache()).startsWith(path.resolve(datos)), 'el caché de textos, fuera de SITE_DATA_DIR');
});

test('2.27-A7 VistaLocal_SelloSinMaquinas_IgualQueAntes @story-2.27 @ac-23', () => {
  // la vista local con buzón y ninguna corrida dice el alcance sin cambios; «ninguna máquina» es sólo del sitio
  const M = runs.modelo(tmp('vacia-'), { buzon: path.join(tmp('site-runs-nada-'), 'no-existe') });
  assert.match(runs.cabecera(M), /<b>Alcance:<\/b> <\/span>/);
  assert.match(runs.cabecera(M, { sitio: { rol: 'maintainer', version: '1' } }), /<b>Alcance:<\/b> ninguna máquina<\/span>/);
});

// Navegar no vuelve a armar nada: la página y la lista de cada persona se arman una vez
// por modelo y por datos de fondo; un clic más sólo las vuelve a mandar. Cambia la persona, el modelo o los datos de
// fondo, y se arma de nuevo.
// Sin esto, cada visita a Corridas filtra y arma de nuevo 1,7 MB de página y 1,8 MB de lista.
test('Navegar_LoArmadoPorPersonaSeGuarda_HastaQueCambianLosDatos', async () => {
  const real = access.filtrarCorridas;
  let n = 0;
  access.filtrarCorridas = (...a) => { n += 1; return real(...a); };
  try {
    const fuentes = fuentesCon({ espejo: mundo() });
    await conPestana({ fuentes }, async ({ h, entrar }) => {
      const lead = await entrar(LEAD); const dev = await entrar(DEV_A);
      const a = await h.pedir('/api/corridas', { cookie: lead });
      const p = await h.pedir('/corridas', { cookie: lead });
      assert.strictEqual(n, 1, 'la lista y la página de la misma persona salen del mismo filtrado');
      const b = await h.pedir('/api/corridas', { cookie: lead });
      const q = await h.pedir('/corridas', { cookie: lead });
      assert.strictEqual(n, 1, 'un clic más no filtra de nuevo');
      assert.strictEqual(b.texto, a.texto);
      assert.strictEqual(q.texto, p.texto);
      // lo guardado para el mantenedor nunca le llega a otra persona: el dev ve sólo lo suyo, en la lista y en la página
      const ld = (await h.pedir('/api/corridas', { cookie: dev })).json;
      assert.strictEqual(n, 2, 'otra persona, su propio filtrado');
      assert.deepStrictEqual([...new Set(ld.corridas.map((c) => c.maquina))], ['maq-a'], 'el dev, sólo sus ejecuciones');
      assert.ok(a.json.corridas.some((c) => c.maquina !== 'maq-a'), 'el mantenedor ve más que eso');
      const pd = (await h.pedir('/corridas', { cookie: dev })).texto;
      assert.notStrictEqual(pd, p.texto, 'la página del dev no es la del mantenedor');
      assert.match(sinTags(pd), /Alcance: maq-a \d/);
      assert.strictEqual(n, 2);
      // y lo del dev tampoco vuelve al mantenedor
      assert.strictEqual((await h.pedir('/api/corridas', { cookie: lead })).texto, a.texto);
      assert.strictEqual(n, 2);
      // los datos de fondo se refrescan: la configuración llega como un objeto nuevo y lo guardado ya no vale
      fuentes.st.config = { ...fuentes.st.config };
      await h.pedir('/api/corridas', { cookie: lead });
      assert.strictEqual(n, 3, 'datos de fondo nuevos, filtrado nuevo');
      // lo informado por las máquinas cambia por partes: también cuenta
      fuentes.st.personas.informados = { ...fuentes.st.personas.informados };
      await h.pedir('/corridas', { cookie: lead });
      assert.strictEqual(n, 4);
    });
  } finally { access.filtrarCorridas = real; }
});

test('Cambios_RenglonesDelHilo_SinElTextoEntero — los renglones de la conversación salen de a uno, iguales a partir el texto', () => {
  // 🔴 rojo: resumir una conversación grande arma el texto entero y su lista de renglones; con una de 110 MB
  //    comprimidos el sitio pasaba de 1 GiB y el contenedor moría.
  const { renglonesDe } = require(path.join(__dirname, '..', 'nightly', 'dashboard', 'changes.js'));
  const casos = ['', '\n', 'a', 'a\n', 'a\nb', 'a\n\nb\n', '{"x":"ñandú 😀"}\n{"y":1}\r\n', `${'z'.repeat(70000)}\nfin`];
  for (const t of casos) {
    // igual que partir el texto, renglones vacíos incluidos; sólo el vacío después del último salto no sale
    const esperado = t.split('\n'); if (esperado[esperado.length - 1] === '') esperado.pop();
    assert.deepStrictEqual([...renglonesDe(Buffer.from(t, 'utf8'))], esperado, JSON.stringify(t.slice(0, 30)));
  }
});
