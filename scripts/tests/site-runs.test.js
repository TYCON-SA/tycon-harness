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

/**
 * El sitio con la pestaña; `entrar(correo)` da la cookie de una sesión real. `opciones` va a crearRutas. `datos`: el
 * disco del sitio de un arranque anterior (un reinicio sobre el mismo `SITE_DATA_DIR`); sin él, uno nuevo.
 */
async function conPestana({ fuentes, opciones = {}, rutasMas = [], sinDisco = false, datos = tmp('site-runs-datos-') }, fn) {
  const emisor = await arrancarEmisor();
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
async function clienteDelSitio(h, cookie, { search = '', alterar = null, textos } = {}) {
  const pagina = await h.pedir(`/corridas${search}`, { cookie });
  assert.strictEqual(pagina.status, 200, `la página: ${pagina.status}`);
  const js = await h.pedir('/corridas/cliente.js', { cookie });
  assert.strictEqual(js.status, 200);
  const tbody = (/<tbody id="cuerpo"[^>]*>([\s\S]*?)<\/tbody>/.exec(pagina.texto) || [])[1] || '';
  const { nodos, rows, documento } = domMinimo(tbody);
  const fuente = /<div id="fuente-corridas"[^>]*data-api="([^"]+)"[^>]*data-generado="([^"]*)"/.exec(pagina.texto);
  nodos['fuente-corridas'] = { dataset: { api: fuente && fuente[1], generado: fuente && fuente[2] } };
  // los textos del cliente, en el idioma de la página (el atributo que pone el sitio)
  const textosCliente = /<div id="corridas-textos" data-textos="([^"]*)"/.exec(pagina.texto);
  if (textosCliente) nodos['corridas-textos'] = { dataset: { textos: textosCliente[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') } };
  // `textos`: null saca el bloque (una página sin él); un texto lo reemplaza (una página de otra versión)
  if (textos === null) delete nodos['corridas-textos'];
  else if (typeof textos === 'string') nodos['corridas-textos'] = { dataset: { textos } };
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
    for (const rot of ['Ejecuciones:', 'Con consumo medido:', 'Con controles:', 'Llegaron al final:', 'Generado:', 'Alcance:']) assert.ok(p.includes(`<b>${rot}</b>`), `el sello trae «${rot}»`);
    assert.match(p, /versión del sitio/, 'el sello dice la versión del sitio, no el commit');
    assert.doesNotMatch(p, /Sin registro de ejecuciones propio/, 'el sitio no tiene registro propio y no lo declara como faltante');
    assert.doesNotMatch(p, /~\/\.claude\/\.tycon-pipeline\/timing-history/, 'la nota «De dónde sale» es la del sitio');
    assert.match(p, /del espejo del depósito de ejecuciones que el sitio baja con su identidad de sólo lectura/);
    // la página vieja del tablero ya no se sirve: el eyebrow lleva a Arnés, donde están sus fichas
    assert.match(p, /href="\/arnes"/, 'el eyebrow enlaza Arnés para quien mantiene');
    assert.doesNotMatch(p, /href="\/arnes\/tablero"/, 'nada enlaza la página vieja del tablero');
  });
  // el saneado ausente: la banda de rescate aparece (una copia de runs.js sin tokens-digest.js al lado)
  const copia = tmp('site-runs-copia-');
  fs.mkdirSync(path.join(copia, 'scripts', 'nightly', 'dashboard'), { recursive: true });
  fs.mkdirSync(path.join(copia, 'scripts', 'lib'), { recursive: true });
  for (const f of ['runs.js', 'runs-texts.js', 'common.js', 'sources.json']) fs.copyFileSync(path.join(ROOT, 'scripts', 'nightly', 'dashboard', f), path.join(copia, 'scripts', 'nightly', 'dashboard', f));
  // la vista pide sus textos a la tabla del sitio, que carga lo suyo de la carpeta del sitio
  fs.cpSync(path.join(ROOT, 'scripts', 'site'), path.join(copia, 'scripts', 'site'), { recursive: true });
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
    assert.strictEqual((fichas.match(/class="tile/g) || []).length, 11, 'once fichas');
    // la de la revisión previa sale en el sitio por compartir el cliente; los volcados del mundo no traen el campo: gris
    // con las corridas viejas contadas, nunca un cero
    const rp = fichas.slice(fichas.lastIndexOf('<div class="tile', fichas.indexOf('La historia revisada antes de programar')));
    assert.match(rp, /^<div class="tile blind"/, 'la ficha de la revisión previa sale gris sin constancias');
    assert.match(rp, /anterior\(es\) a la revisión previa/, 'y cuenta las viejas aparte');
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
    assert.match(sinTags(sello), /^Ejecuciones: 2 Con consumo medido: 1 de 2 Con controles: 2 de 2 Llegaron al final: 2 de 2 Generado: \d{4}-\d\d-\d\d \d\d:\d\d UTC · versión del sitio Alcance: maq-a 2$/);
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
    assert.match(sinTags(c.nodos.fichas.innerHTML), /todavía no hay ejecuciones de tus máquinas en el depósito \(maq-d\): la primera llega sola al terminar un pipeline/);
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

const LISTA_BLANCA = ['id', 'story', 'producto', 'grupo', 'maquina', 'maquina_motivo', 'inicio', 'semana', 'dur_ms', 'llego_al_final', 'ultimo_paso', 'paso_en_curso', 'tramos', 'sin_marca', 'tiempos', 'controles', 'costo', 'validador', 'consumo', 'sin_pasos_anotados', 'sin_cerrar', 'esquema', 'revision_previa'];

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
  assert.deepStrictEqual(Object.keys(l.revision_previa).sort(), ['corregida', 'duracion_ms', 'estado', 'hallazgos', 'tokens'], 'de la revisión previa viajan su estado y números');
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

test('T16b Armado_LosTextosSalenAlDiscoCorridaPorCorrida — el modelo no junta los textos de todas antes de escribirlos', async () => {
  const espejo = mundo({ marcadores: false });
  const entero = runs.modelo(tmp('vacia-'), { buzon: espejo, soloBuzon: true, sinUnificar: true });
  const esperados = Object.fromEntries(entero.corridas.map((c) => [c.id, runs.textosDe(c)]).filter(([, t]) => t.texto || t.textoGit));
  assert.ok(Object.keys(esperados).length >= 1, 'el mundo trae corridas con textos');
  // con `alTexto`, cada corrida entrega sus textos al armarse y queda sin ellos: ninguna los conserva hasta el final
  const entregados = {};
  const conTextosAlEntregar = [];
  const M = runs.modelo(tmp('vacia-'), { buzon: espejo, soloBuzon: true, sinUnificar: true, alTexto: (c, t) => {
    entregados[c.id] = t;
    conTextosAlEntregar.push(Boolean(c.cambios && (c.cambios._texto || c.cambios._textoGit)));
  } });
  assert.strictEqual(Object.keys(entregados).length, entero.corridas.length, 'una entrega por corrida');
  assert.ok(conTextosAlEntregar.every((x) => !x), 'la corrida ya no los trae cuando los entrega');
  assert.ok(M.corridas.every((c) => !runs.textosDe(c).texto && !runs.textosDe(c).textoGit), 'el modelo vuelve sin textos');
  for (const [id, t] of Object.entries(esperados)) assert.deepStrictEqual(entregados[id], t, `los mismos textos de ${id}`);
  // el armado del sitio escribe los mismos archivos que antes, y baja a demanda las mismas
  const textosDir = path.join(tmp('textos-'), 'x');
  const r = await TAB().armarEnElHilo({ buzon: espejo, textosDir });
  assert.deepStrictEqual(fs.readdirSync(textosDir).sort(), Object.keys(esperados).map((id) => `${id}.json`).sort());
  for (const [id, t] of Object.entries(esperados)) assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(textosDir, `${id}.json`), 'utf8')), t);
  assert.deepStrictEqual(r.aDemanda, {});
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
      assert.match(p, /puede faltar alguna ejecución tuya: el depósito no se leyó entero/);
      assert.doesNotMatch(p, /carpeta de máquina del depósito no se pudo leer/);
      const pl = (await h.pedir('/corridas', { cookie: await entrar(LEAD) })).texto;
      assert.match(pl, /1 carpeta de máquina del depósito no se pudo leer/);
    });
  } finally { fs.chmodSync(mala, 0o755); }
  // el espejo no se pudo leer: la banda con su motivo para quien mantiene; al dev, que puede faltar alguna suya
  await conPestana({ fuentes: fuentesCon({ espejo: path.join(tmp('site-runs-nada-'), 'no-existe') }) }, async ({ h, entrar }) => {
    const pl = (await h.pedir('/corridas', { cookie: await entrar(LEAD) })).texto;
    assert.match(pl, /No se leyó la carpeta bajada del depósito\.<\/b> la carpeta bajada del depósito de ejecuciones no se pudo leer \(ENOENT\)/);
    assert.doesNotMatch(pl, /0 ejecuciones/);
    const dev = await entrar(DEV_A);
    assert.deepStrictEqual((await h.pedir('/api/corridas', { cookie: dev })).json.buzon, { estado: 'no_medido', parcial: true });
    assert.match((await h.pedir('/corridas', { cookie: dev })).texto, /puede faltar alguna ejecución tuya: el depósito no se leyó entero/);
  });
  // sin depósito configurado: gris «no medido»
  const sinBuzon = fuentesCon({ espejo: mundo(), config: { ...opsCon(), site: { maintainers: [LEAD] } } });
  await conPestana({ fuentes: sinBuzon, opciones: { noEsperar: true } }, async ({ h, entrar }) => {
    const p = await h.pedir('/corridas', { cookie: await entrar(LEAD) });
    assert.strictEqual(p.status, 200);
    assert.match(p.texto, /sin depósito configurado: no medido/);
    assert.doesNotMatch(p.texto, /0 ejecuciones/);
    // el detalle tampoco: «no medido», no el 404 mudo de «no es tuya»
    const d = await h.pedir('/api/corridas/0123456789abcdef', { cookie: await entrar(LEAD) });
    assert.strictEqual(d.status, 404);
    assert.match(d.texto, /sin depósito configurado: no medido/);
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
// se recarga sola. 🔴 rojo: «no medido: el depósito todavía no se pudo bajar entero» mientras la primera bajada corría
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
    assert.strictEqual(cargando.status, 503, 'al despertar sin vista guardada: cargando');
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

// rojo si: con la generación del espejo, la pestaña lo recorre igual (rearma por un archivo que la generación no
// anunció) o no rearma cuando la generación sube.
test('Generacion_SinCambiosNoRecorreElEspejo_YSubeRearma — igual generación, mismo espejo', async () => {
  const espejo = mundo({ marcadores: false });
  const datos = tmp('site-runs-gen-');
  const armarReal = TAB().armarEnElHilo;
  let armados = 0;
  const armar = (o) => { armados += 1; return armarReal(o); };
  let gen = 7;
  const fuentes = fuentesCon({ espejo });
  fuentes.espejoGeneracion = () => gen;
  await conPestana({ fuentes, datos, opciones: { armar } }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    const n0 = (await h.pedir('/api/corridas', { cookie: lead })).json.corridas.length;
    assert.strictEqual(armados, 1, 'el arranque arma una vez');
    // un archivo nuevo en el espejo sin que suba la generación: la pestaña no lo mira (sólo el sitio escribe el espejo,
    // y cuando escribe sube la generación)
    escribir(path.join(espejo, 'maq-a'), 'a8.json', volcado('aaaaaaaa-0000-4000-8000-000000000008', '2026-08-24T09:00:00.000Z', { marker: { storyId: '3.8' } }));
    fuentes.avisar(); await vista.listo();
    await h.pedir('/api/corridas', { cookie: lead }); await vista.listo();
    assert.strictEqual(armados, 1, 'misma generación: no rearma');
    gen = 8;
    fuentes.avisar(); await vista.listo();
    assert.strictEqual(armados, 2, 'la generación subió: rearma');
    assert.strictEqual((await h.pedir('/api/corridas', { cookie: lead })).json.corridas.length, n0 + 1, 'con la corrida nueva');
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
    assert.match((await h.pedir('/corridas', { cookie: lead })).texto, /La última bajada del depósito no terminó entera/);
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
    assert.match(p.texto, /no medido: el depósito todavía no se pudo bajar entero \(credencial_rechazada\)/);
  });
  // ya hubo una entera pero la pestaña no armó todavía y la última quedó a medias: tampoco «cargando» sin motivo
  const media = fuentesCon({ espejo: mundo({ marcadores: false }) });
  media.bajada = { completo: false, generacion: 3 };
  await conPestana({ fuentes: media, opciones: { noEsperar: true } }, async ({ h, entrar }) => {
    const p = await h.pedir('/corridas', { cookie: await entrar(LEAD) });
    assert.strictEqual(p.status, 200);
    assert.match(p.texto, /no medido: el depósito todavía no se pudo bajar entero/);
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

test('Resumida_ConSoloElCambioDeVuelta_NoPierdeTituloNiEsperas — una pasada que corta entre el cambio y la conversación no cambia la ejecución', () => {
  // la bajada trae el cambio de git antes que la conversación: con el corte en el medio, el armado veía el cambio solo y
  // dejaba la ejecución sin título ni esperas; a la pasada siguiente volvían (los valores iban y venían entre recargas)
  const espejo = mundo({ marcadores: false });
  const de = (M) => M.corridas.find((c) => c.story === '3.1');
  const antes = de(runs.modelo(tmp('vacia-'), { buzon: espejo, soloBuzon: true }));
  assert.strictEqual(antes.cambios.estado, 'leido');
  assert.strictEqual(runs.resumirEspejo(espejo, { skillsDir: path.join(ROOT, 'skills') }).resumidas, 2);
  fs.copyFileSync(path.join(mundo({ marcadores: false }), 'maq-a', 'a1.cambio.json.gz'), path.join(espejo, 'maq-a', 'a1.cambio.json.gz'));
  const corte = de(runs.modelo(tmp('vacia-'), { buzon: espejo, soloBuzon: true }));
  assert.strictEqual(corte.cambios.estado, 'leido', 'con el resumen al lado, el cambio solo no deja la ejecución sin leer');
  assert.deepStrictEqual(corte.descripcion, antes.descripcion, 'el mismo título');
  assert.deepStrictEqual(corte.tiempos, antes.tiempos, 'el mismo trabajo y la misma espera');
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

// ── 2.60: la pestaña en el idioma de la página, y lo de hoy en castellano igual ─────────────────────────────────────
//
// Las fotos de `fixtures/runs-2.60/` se tomaron con el runs.js de antes de la story: la página de la noche, la pestaña
// en castellano y lo que el cliente dibuja en castellano (fichas, gráficos, cuenta y el detalle de una ejecución).
// Se comparan normalizadas: la hora de armado, el commit o la versión, las carpetas temporales, el código de pantalla
// (que cambia de forma, no de lo que muestra) y el bloque de textos que se le inyecta. Regenerarlas es una decisión
// explícita: TYCON_RUNS_FOTO_WRITE=1, sobre el runs.js de partida.
const FOTOS_260 = path.join(__dirname, 'fixtures', 'runs-2.60');
const { textosVisibles, enCastellano } = require('./lib/spanish-text.js');
function normalizar260(s) {
  const tmps = [...new Set([os.tmpdir(), fs.realpathSync(os.tmpdir())])].sort((a, b) => b.length - a.length);
  let t = String(s);
  for (const d of tmps) t = t.split(d).join('<TMP>');
  return t
    .replace(/<TMP>\/[\w.-]+/g, '<TMP>/x')
    .replace(/<b>Generated:<\/b>[^<]*|<b>Generado:<\/b>[^<]*/g, '<b>Generado:</b> X')
    .replace(/data-generado="[^"]*"/g, 'data-generado="X"')
    .replace(/name="tok" value="[^"]*"/g, 'name="tok" value="X"')
    .replace(/nonce="[^"]*"/g, 'nonce="X"')
    .replace(/"generado":"[^"]*"/g, '"generado":"X"')
    .replace(/<script>\s*\(function \(\) \{[\s\S]*?<\/script>/g, '<script>CLIENTE</script>')
    .replace(/<div id="corridas-textos" data-textos="[^"]*" hidden><\/div>/g, '');
}
function foto260(nombre, texto) {
  const f = path.join(FOTOS_260, nombre);
  const n = normalizar260(texto);
  if (process.env.TYCON_RUNS_SNAPSHOT_WRITE === '1') { fs.mkdirSync(FOTOS_260, { recursive: true }); fs.writeFileSync(f, n); return; }
  assert.ok(fs.existsSync(f), `falta la foto ${nombre}`);
  compararConFoto(nombre, n, fs.readFileSync(f, 'utf8'));
}
function compararConFoto(nombre, n, guardada) {
  // los textos comprimidos de la página se comparan descomprimidos: la cabecera dice el sistema que los comprimió (macOS o
  // Linux) y los bytes cambian con la versión de zlib del Node que corre (el de Homebrew usa otra); el contenido es el mismo
  // la versión del pie sale del archivo de versión de la copia, que no toda copia trae: tampoco se compara
  const descomprimido = (b64) => {
    try { return `GZ[${zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')}]`; } catch (_) { return b64; }
  };
  const sinSistema = (s) => s.replace(/H4sIAAAAAAAA[A-Za-z0-9+/=]*/g, descomprimido)
    .replace(/(<footer class="pie"><span>[^<]*?) v[\w.+-]+<\/span>/g, '$1</span>');
  const foto = sinSistema(guardada);
  if (sinSistema(n) === foto) return;
  // el primer renglón distinto, con los dos lados: la página entera no entra en el mensaje
  const a = foto.split('\n'); const b = sinSistema(n).split('\n');
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  let c = 0; while (c < Math.min((a[i] || '').length, (b[i] || '').length) && a[i][c] === b[i][c]) c++;
  const tramo = (s) => JSON.stringify((s || '').slice(Math.max(0, c - 120), c + 200));
  assert.fail(`${nombre}: cambió lo que se ve en castellano — renglón ${i + 1} (de ${a.length} y ${b.length}), columna ${c + 1}:\n  antes: ${tramo(a[i])}\n  ahora: ${tramo(b[i])}`);
}

/** Lo que dibuja el cliente: fichas, gráficos, la cuenta y el detalle de la primera ejecución de dev-a. */
async function dibujado(h, cookie, devCookie, opts) {
  const c = await clienteDelSitio(h, cookie, opts);
  c.w.__aplicar();
  const partes = ['fichas', 'gsem', 'gpasos', 'ppt', 'ppk', 'nota-tokens', 'cuenta'].map((k) => `## ${k}\n${(c.nodos[k] && (c.nodos[k].innerHTML || c.nodos[k].textContent)) || ''}`);
  const lista = (await h.pedir('/api/corridas', { cookie: devCookie })).json;
  const a1 = lista.corridas.find((x) => x.story === '3.1');
  const det = (await h.pedir(`/api/corridas/${a1.id}`, { cookie: devCookie })).json;
  partes.push(`## detalle\n${c.w.__detalle(det)}`);
  return partes.join('\n');
}

test('2.60-T5 Corridas_LaPaginaDeLaNocheIgual @story-2.60 @ac-5 — la página de la noche, lo mismo que antes', () => {
  const M = runs.modelo(tmp('vacia-'), { buzon: mundo(), soloBuzon: true });
  foto260('noche.html', runs.render(M));
});

test('2.60-T6 Corridas_EnCastellanoIgual @story-2.60 @ac-6 — la pestaña en castellano, la página y lo que dibuja el cliente', async () => {
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    const dev = await entrar(DEV_A);
    foto260('pestana-es.html', (await h.pedir('/corridas', { cookie: lead })).texto);
    foto260('cliente-es.txt', await dibujado(h, lead, dev));
  });
});

test('2.60-T6b Corridas_FotoSinVersion_IgualYTextoCambiadoRojo @story-2.60 @ac-6 — la versión del pie no cuenta; un texto en castellano sí', () => {
  const foto = fs.readFileSync(path.join(FOTOS_260, 'pestana-es.html'), 'utf8');
  assert.match(foto, /<footer class="pie"><span>Arnés v[\w.+-]+<\/span>/, 'la foto trae la versión en el pie');
  assert.doesNotThrow(() => compararConFoto('pestana-es.html', foto, foto), 'la misma página');
  const sinVersion = foto.replace(/(<footer class="pie"><span>Arnés) v[\w.+-]+<\/span>/, '$1</span>');
  assert.notStrictEqual(sinVersion, foto);
  assert.doesNotThrow(() => compararConFoto('pestana-es.html', sinVersion, foto), 'la copia sin version.json');
  const otraVersion = foto.replace(/(<footer class="pie"><span>Arnés) v[\w.+-]+<\/span>/, '$1 v2099.1.1.1</span>');
  assert.doesNotThrow(() => compararConFoto('pestana-es.html', otraVersion, foto), 'otra versión');
  const otroTexto = foto.replace('Cada ejecución del pipeline', 'Cada corrida del pipeline');
  assert.notStrictEqual(otroTexto, foto);
  assert.throws(() => compararConFoto('pestana-es.html', otroTexto, foto), /cambió lo que se ve en castellano/);
});

test('2.60-T1 Corridas_ElCuerpoEnIngles @story-2.60 @ac-1 @ac-2 — la página y lo que dibuja el cliente, sin castellano', async () => {
  // lo de afuera no se traduce: stories, productos, máquinas, correos, archivos y el mensaje rescatado de una prueba
  const DATOS = ['maq-a', 'maq-b', 'maq-c', 'zqx-fuga', 'RepoComun', 'FrontEnd', 'Alfa', 'Pago.ts', 'src/', 'esperaba 2, salió 3', 'caso 3', LEAD, DEV_A, DEV_B, 'Sin Forma.local', 'tycon-story-validator', 'modelo-x', 'una-cosa', 'sin hilo'];
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const lead = `${await entrar(LEAD)}; sitio-idioma=en`;
    const dev = `${await entrar(DEV_A)}; sitio-idioma=en`;
    const pagina = (await h.pedir('/corridas', { cookie: lead })).texto;
    // la de una dev arma otras partes (su encabezado, sólo lo suyo): también en inglés
    const deDev = (await h.pedir('/corridas', { cookie: dev })).texto;
    const enPagina = enCastellano([...textosVisibles(pagina), ...textosVisibles(deDev)], DATOS);
    // (las etiquetas «## …» separan las partes del dibujo en la prueba: no son de la página)
    const enCliente = enCastellano(textosVisibles((await dibujado(h, lead, dev)).replace(/^## .*$/gm, '')), DATOS);
    assert.deepStrictEqual([...enPagina, ...enCliente], [], `castellano en la pestaña en inglés:\n${[...enPagina, ...enCliente].join('\n')}`);
    assert.doesNotMatch(sinTags(pagina), /\bcorridas?\b/i, 'el inglés no usa el nombre viejo');
    assert.match(sinTags(pagina), /\bruns?\b/i, 'dice «run»');
    // la coma decimal es del castellano: en inglés, «1.5 h» y «1.8 M»
    const todo = `${sinTags(pagina)}\n${sinTags(await dibujado(h, lead, dev))}`;
    assert.doesNotMatch(todo, /\d,\d\s?(?:h|M)\b/, 'ningún número con coma decimal');
    assert.match(todo, /\d\.\d\s?(?:h|M)\b/, 'los decimales llevan punto');
    // la semana: ni «S44» en el texto, ni en los «title», ni en los rótulos del gráfico (2.79 T40, @story-2.79 @ac-34)
    const crudo = `${pagina}\n${deDev}\n${await dibujado(h, lead, dev)}`;
    assert.doesNotMatch(todo, /\bS\d{2}\b/, 'la semana con la letra del castellano en el texto');
    assert.doesNotMatch(crudo, /title="[^"]*\bS\d{2}\b/, 'la semana con la letra del castellano en un title');
    assert.doesNotMatch(crudo, /<text[^>]*>[^<]*\bS\d{2}\b/, 'la semana con la letra del castellano en el gráfico');
  });
});

test('2.60-T7 ModeloViejo_LaFraseSeVeIgual @story-2.60 @ac-6 — el modelo guarda la frase; en inglés se traduce al pintar', () => {
  // el modelo no cambia de forma: guarda la frase en castellano, como antes, y un archivo de la noche ya escrito se lee
  // igual. Al pintar en inglés, una frase de la casa se reconoce por su molde; lo que no es de la casa pasa tal cual.
  const T = require(path.join(H.SITE, 'texts.js'));
  const frase = 'sin tiempos por paso';
  assert.ok(Object.values(T.TEXTOS).some((v) => v.es === frase), 'la frase del modelo tiene su molde');
  assert.strictEqual(runs.enIdioma('es', frase), frase);
  assert.notStrictEqual(runs.enIdioma('en', frase), frase);
  assert.doesNotMatch(runs.enIdioma('en', frase), /\b(?:sin|por|paso)\b/);
  assert.strictEqual(runs.enIdioma('en', 'FAIL src/x.test.ts › caso 3'), 'FAIL src/x.test.ts › caso 3', 'un dato de afuera pasa tal cual');
  // un modelo de antes (con sus frases en castellano) se pinta en inglés por la API sin cambiar lo guardado
  const M = runs.modelo(tmp('vacia-'), { buzon: mundo(), soloBuzon: true });
  const antes = JSON.stringify(M);
  const enIngles = runs.todoEnIdioma('en', M);
  assert.strictEqual(JSON.stringify(M), antes, 'el modelo guardado no cambia');
  assert.notStrictEqual(JSON.stringify(enIngles), antes, 'lo que sale en inglés sí');
  assert.strictEqual(runs.todoEnIdioma('es', M), M, 'en castellano sale el mismo modelo');
  // los textos de los cambios son de afuera: aunque digan una frase de la casa, pasan tal cual
  const cambio = runs.todoEnIdioma('en', { _texto: frase, _textoGit: frase, motivo: frase });
  assert.strictEqual(cambio._texto, frase);
  assert.strictEqual(cambio._textoGit, frase);
  assert.notStrictEqual(cambio.motivo, frase, 'el motivo, que es de la casa, sí se traduce');
});

test('2.60-T11 FrasesDeLaCasa_CadaRama @story-2.60 @ac-1 @ac-3 — los tramos fundidos, la espera sin medir, los cambios ilegibles y los módulos que faltan, en inglés', () => {
  const D = path.join(ROOT, 'scripts', 'nightly', 'dashboard');
  const ST = require(path.join(ROOT, 'scripts', 'metrics', 'step-times.js'));
  const ch = require(path.join(D, 'changes.js'));
  const enEspanol = (t) => enCastellano([t]).length > 0;
  const frases = [];
  // tramos: dos pasos con la misma marca (se funden) y un hueco entre pasos (los sub-pasos viejos van en la fila de su paso)
  const c = runs.modeloDeCorrida({ marker: { startedAt: '2026-10-01T10:00:00Z', lastTouch: '2026-10-01T12:00:00Z', stepTimings: {
    1: { completedAt: '2026-10-01T10:05:00Z' }, 4: { completedAt: '2026-10-01T10:30:00Z' }, '5b': { startedAt: '2026-10-01T10:31:00Z' },
    5: { startedAt: '2026-10-01T10:40:00Z', completedAt: '2026-10-01T11:25:00Z' }, 6: { completedAt: '2026-10-01T11:25:00Z' },
    '7c': { startedAt: '2026-10-01T11:27:00Z' }, 8: { startedAt: '2026-10-01T11:35:00Z', completedAt: '2026-10-01T11:50:00Z' } } } }, runs.nombresDePasos().nombres);
  const nombres = c.tramos.map((t) => t.nombre);
  assert.ok(nombres.some((n) => n.includes(' + ')), `hay un tramo fundido: ${nombres.join(' · ')}`);
  frases.push(...nombres);
  // la espera sin medir: sin el arranque del 7; sin el del 3 y el 7
  const base = Date.parse('2026-10-20T10:00:00Z');
  const m = (n) => new Date(base + n * 60000).toISOString();
  for (const sin of [[7], [3, 7]]) {
    const st = {};
    for (let i = 0; i <= 8; i++) st[i] = { completedAt: m(i * 10 + 9), ...(sin.includes(i) ? {} : { startedAt: m(i * 10 + 1) }) };
    frases.push(ST.tiempos(st, { inicio: m(0) }).motivo);
  }
  // los cambios: hilo y cambio de git ilegibles, sin cambio guardado, sin saneado
  const dir = tmp('cambios-');
  const v = path.join(dir, 'a.json');
  fs.writeFileSync(v, '{}');
  fs.writeFileSync(ch.rutaDeHilo(v), 'no es gzip');
  fs.writeFileSync(ch.rutaDeCambio(v), 'no es gzip');
  fs.writeFileSync(ch.rutaDeHilo(path.join(dir, 'c.json')), 'x');
  frases.push(ch.cambiosDeCorrida(v, {}, { sanear: (x) => x }).motivo, ch.leerCambioDeGit(v).motivo,
    ch.leerCambioDeGit(path.join(dir, 'b.json')).motivo, ch.cambiosDeCorrida(path.join(dir, 'c.json'), {}, {}).motivo);
  // los módulos de la vista que faltan: una copia sin scripts/metrics ni changes.js
  const copia = tmp('site-runs-sin-modulos-');
  const dash = path.join(copia, 'scripts', 'nightly', 'dashboard');
  fs.cpSync(D, dash, { recursive: true });
  fs.rmSync(path.join(dash, 'changes.js'));
  for (const sub of ['lib', 'site']) fs.cpSync(path.join(ROOT, 'scripts', sub), path.join(copia, 'scripts', sub), { recursive: true });
  const r = spawnSync(process.execPath, ['-e', `const V = require(${JSON.stringify(path.join(dash, 'runs.js'))});
    const M = V.modelo(${JSON.stringify(tmp('vacia-'))}, { buzon: ${JSON.stringify(mundo())}, soloBuzon: true });
    const c = M.corridas[0];
    process.stdout.write(JSON.stringify([M.sin_rescate, M.sin_tiempos, c.costo && c.costo.vueltas_fuente, V.paraDetalle(c).cambios.motivo]));`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const sinModulos = JSON.parse(r.stdout).filter(Boolean);
  assert.ok(sinModulos.length >= 3, `la copia sin módulos los nombra: ${r.stdout}`);
  frases.push(...sinModulos);
  // cada frase de la casa en castellano sale en inglés, sin castellano
  const quedan = frases.filter((f) => enEspanol(f) && runs.enIdioma('en', f) === f);
  assert.deepStrictEqual(quedan, [], `frases de la casa sin molde:\n${quedan.join('\n')}`);
});

test('2.60-T12 DatosDeAfuera_NoSeTraducen @story-2.60 @ac-1 — la API traduce sólo los campos de la casa', () => {
  // lo de afuera que coincide con un molde: un producto, una story, el título, los asuntos de los commits, un archivo
  const det = { story: 'Revisores', producto: 'pruebas', maquina: 'pruebas', descripcion: { texto: 'Pago confirmado', fuente: 'el título de la story' },
    cambios: { titulo: 'antes, el login fallaba', commits: [{ h: 'a', s: 'pruebas' }, { h: 'b', s: 'fix: el pedido queda confirmado' }],
      archivos: [{ f: 'Arranque' }, { f: 'fuera del repo: x.txt' }], motivo: 'la conversación no se pudo leer (Z_DATA_ERROR)' },
    tramos: [{ nombre: 'Revisores + Hallazgos' }] };
  const en = runs.todoEnIdioma('en', det);
  assert.strictEqual(en.story, 'Revisores');
  assert.strictEqual(en.producto, 'pruebas');
  assert.strictEqual(en.maquina, 'pruebas');
  assert.strictEqual(en.descripcion.texto, 'Pago confirmado');
  assert.strictEqual(en.cambios.titulo, 'antes, el login fallaba');
  assert.deepStrictEqual(en.cambios.commits.map((x) => x.s), ['pruebas', 'fix: el pedido queda confirmado']);
  assert.strictEqual(en.cambios.archivos[0].f, 'Arranque', 'un nombre de archivo no se traduce');
  // y lo de la casa sí
  assert.notStrictEqual(en.descripcion.fuente, det.descripcion.fuente);
  assert.strictEqual(en.cambios.archivos[1].f, 'outside the repo: x.txt');
  assert.strictEqual(en.cambios.motivo, 'the conversation could not be read (Z_DATA_ERROR)');
  assert.doesNotMatch(en.tramos[0].nombre, /Revisores|Hallazgos/, 'un paso fundido se traduce de a uno');
});

test('2.60-T10 ClienteSinTextos_SaleEnCastellano @story-2.60 @ac-6 — sin el bloque de textos, o con uno incompleto, el navegador muestra castellano y nunca una clave', async () => {
  await conPestana({ fuentes: fuentesCon({ espejo: mundo() }) }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    const dev = await entrar(DEV_A);
    const foto = fs.readFileSync(path.join(FOTOS_260, 'cliente-es.txt'), 'utf8');
    // una página sin el bloque (la de la noche, una vieja en caché): el castellano que el cliente lleva adentro
    assert.strictEqual(normalizar260(await dibujado(h, lead, dev, { textos: null })), foto, 'sin el bloque');
    // un bloque de otra versión al que le faltan claves: cada una que falta sale en castellano
    assert.strictEqual(normalizar260(await dibujado(h, lead, dev, { textos: '{}' })), foto, 'con el bloque vacío');
    // un bloque que no se puede leer: castellano, y lo avisa
    assert.strictEqual(normalizar260(await dibujado(h, lead, dev, { textos: '{roto' })), foto, 'con el bloque roto');
  });
});

test('2.60-T9 TablaDelSitioRota_LaNocheSigueEnCastellano @story-2.60 @ac-5 — una tabla del sitio que no carga no tumba la vista', () => {
  const copia = tmp('site-runs-tabla-rota-');
  const dash = path.join(copia, 'scripts', 'nightly', 'dashboard');
  fs.mkdirSync(dash, { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'nightly', 'dashboard'), dash, { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(copia, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(copia, 'scripts', 'site'), { recursive: true });
  fs.writeFileSync(path.join(copia, 'scripts', 'site', 'texts.js'), "throw new Error('tabla rota');\n");
  const r = require('child_process').spawnSync(process.execPath, ['-e',
    `const V = require(${JSON.stringify(path.join(dash, 'runs.js'))}); const h = V.render(V.modelo(${JSON.stringify(tmp('vacia-'))}, { buzon: ${JSON.stringify(mundo())}, soloBuzon: true })); process.stdout.write(String(h.includes('<html lang="es"')) + ' ' + V.enIdioma('en', 'sin tiempos por paso'));`], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, 'true sin tiempos por paso', 'la página sale, en castellano');
  assert.match(r.stderr, /la tabla de textos del sitio no cargó/, 'y lo dice');
});

test('2.60-T8 FrasesDelModelo_TodasCalzanConSuMolde @story-2.60 @ac-3 — si alguien cambia una frase, el inglés no queda en castellano callado', () => {
  // Cada texto que arma el modelo, en mundos que tocan sus ramas (con y sin hilo, sin pasos anotados, sin cerrar, sin
  // marcador, máquinas sin declarar, buzón sin uniones): el que está en castellano tiene que salir en inglés por su molde.
  // Lo de afuera (lo que vino en el volcado) se nombra acá y pasa tal cual.
  const espejo = mundo();
  escribir(path.join(espejo, 'maq-a'), 'sp.json', volcado('aaaaaaaa-0000-4000-8000-0000000000f1', '2026-08-21T09:00:00.000Z',
    { marker: { storyId: '3.5', stepsCompleted: [0], stepTimings: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null } }, consumo: null, costo: null, gates: [] }));
  escribir(path.join(espejo, 'maq-a'), 'sm.json', volcado('aaaaaaaa-0000-4000-8000-0000000000f2', '2026-08-22T09:00:00.000Z', { marker: null }));
  const DE_AFUERA = new Set(['sin hilo', 'zqx-prohibido-prompt aprobado', 'FAIL src/x.test.ts › caso 3\n  esperaba 2, salió 3']);
  const sinMolde = new Set();
  // se compara con lo que sale por la API en inglés (todoEnIdioma): una frase de la casa en un campo que la API no
  // traduce también queda en castellano, aunque tenga su molde
  const recorrer = (v, e, ruta) => {
    if (typeof v === 'string') {
      if (!DE_AFUERA.has(v) && !/^[\w./:@-]*$/.test(v) && enCastellano([v]).length && e === v) sinMolde.add(`${ruta}: «${v}»`);
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => recorrer(x, e && e[i], `${ruta}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== '_texto' && k !== '_textoGit') recorrer(x, e && e[k], `${ruta}.${k}`);
  };
  // con las conversaciones y sin ellas (el sitio no las baja), la lista y el detalle de cada ejecución
  for (const sinHilos of [false, true]) {
    const M = runs.modelo(tmp('vacia-'), { buzon: espejo, soloBuzon: true, sinHilos });
    recorrer(M, runs.todoEnIdioma('en', M), `M${sinHilos ? '(sin hilos)' : ''}`);
    for (const c of M.corridas) { const d = runs.paraDetalle(c); recorrer(d, runs.todoEnIdioma('en', d), `D(${c.story})`); }
  }
  assert.deepStrictEqual([...sinMolde], [], `frases del modelo sin molde en texts.js (el inglés quedaría en castellano):\n${[...sinMolde].join('\n')}`);
});

/**
 * El mundo de todas las ramas de una ejecución: los resultados del pase adversarial y sus salteos, los pasos de los dos
 * esquemas sin el arranque de la espera, los repos sin nombre y sin historial de git, y las uniones de carpetas.
 */
function mundoDeTodasLasRamas() {
  const espejo = mundo({ marcadores: false });
  const A = path.join(espejo, 'maq-a');
  const t0 = '2026-08-25T09:00:00.000Z';
  const pase = (min, extra) => ({ ts: iso(t0, min), check: 'adversarial-pass', ...extra });
  escribir(A, 'r1.json', volcado('aaaaaaaa-0000-4000-8000-0000000000e1', t0, { gates: [
    pase(40, { veredicto: 'no-listo', confirmados: 3, pruebas: 2, diferidos: 1 }),
    pase(41, { veredicto: 'no-listo', confirmados: 1, pruebas: 0, diferidos: 0, propias: 1 }),
    pase(42, { veredicto: 'no-listo', confirmados: 2 }),
    pase(43, { veredicto: 'no-medido', lentes_sin_medir: ['a', 'b'], hallazgos_sin_veredicto: 1 }),
    pase(44, { veredicto: 'no-medido', lentes_sin_medir: ['a'], hallazgos_sin_veredicto: 3 }),
    pase(45, { veredicto: 'listo', confirmados: 0 }),
    { ts: iso(t0, 46), check: 'adversarial-skip', status: 'green', forzado: true },
    { ts: iso(t0, 47), check: 'adversarial-skip', status: 'green', abandonado: true },
  ] }));
  // los pasos sin la espera: por nombre (esquema 2) sin «Aprobar el plan» o sin su arranque, y por número sin el 3 y el 7
  const m2 = (n) => iso('2026-08-26T09:00:00.000Z', n);
  const sinLosViejos = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null };
  escribir(A, 'r2.json', volcado('aaaaaaaa-0000-4000-8000-0000000000e2', '2026-08-26T09:00:00.000Z', { marker: { stepsCompleted: ['start', 'plan', 'implement'],
    stepTimings: { ...sinLosViejos, start: { startedAt: m2(0), completedAt: m2(1) }, plan: { startedAt: m2(2), completedAt: m2(9) }, implement: { startedAt: m2(13), completedAt: m2(40) } } } }));
  escribir(A, 'r4.json', volcado('aaaaaaaa-0000-4000-8000-0000000000e7', '2026-08-26T09:00:00.000Z', { marker: { storyId: '3.11', stepsCompleted: ['start', 'plan', 'approve-plan', 'implement'],
    stepTimings: { ...sinLosViejos, start: { startedAt: m2(0), completedAt: m2(1) }, plan: { startedAt: m2(2), completedAt: m2(9) }, 'approve-plan': { completedAt: m2(12) }, implement: { startedAt: m2(13), completedAt: m2(40) } } } }));
  escribir(A, 'r5.json', volcado('aaaaaaaa-0000-4000-8000-0000000000e8', '2026-08-26T09:00:00.000Z', { marker: { storyId: '3.12', stepsCompleted: [0, 1, 4],
    stepTimings: { ...sinLosViejos, 0: { startedAt: m2(0), completedAt: m2(1) }, 1: { startedAt: m2(2), completedAt: m2(5) }, 4: { startedAt: m2(6), completedAt: m2(30) } } } }));
  // los repos de un cambio de git: sin nombre, sin historial, con el historial ilegible, sin sesión
  const cambio = cambioGit('2026-08-27T09:00:00.000Z', 'src/Uno.ts', ['+const uno = 1;']);
  const sinCommits = (commits_motivo, extra = {}) => ({ principal: false, por: ['hilo'], otras_sesiones: null, sin_commitear_previo: 0, estado: 'medido', commits: null, commits_motivo, commits_de_otras_sesiones: [], sin_commitear: [], ...extra });
  cambio.repos.push(
    sinCommits('no se pudo ubicar el historial local de git (ENOENT)', { otras_sesiones_motivo: 'el registro no trae sesión: no se puede saber si otra sesión escribió en esta copia' }),
    sinCommits('esta copia no tiene historial local de git (reflog): no se puede saber qué commits hizo la ejecución', { nombre: 'Beta' }),
    sinCommits('no se pudo leer el historial local de git (EACCES)', { nombre: 'Gama' }),
    { nombre: 'Delta', principal: false, por: ['hilo'], estado: 'no_medido', motivo: 'la carpeta del repo de la ejecución ya no existe en esta máquina', otras_sesiones: null,
      otras_sesiones_motivo: 'no se pudo mirar este repo: no se puede saber si otra sesión escribió en él' });
  escribir(A, 'r3.json', volcado('aaaaaaaa-0000-4000-8000-0000000000e3', '2026-08-27T09:00:00.000Z', { marker: { storyId: '3.7' } }));
  escribir(A, 'r3.cambio.json.gz', gz(JSON.stringify(cambio)));
  // las carpetas viejas: una unida a maq-a, una compartida, una que siguió recibiendo
  escribir(path.join(espejo, 'maq-v'), 'v1.json', volcado('aaaaaaaa-0000-4000-8000-0000000000e4', '2026-08-28T09:00:00.000Z', { marker: { storyId: '3.8' } }));
  escribir(path.join(espejo, 'maq-w'), 'w1.json', volcado('aaaaaaaa-0000-4000-8000-0000000000e5', '2026-08-29T09:00:00.000Z', { marker: { storyId: '3.9' } }));
  escribir(path.join(espejo, 'maq-z'), 'z1.json', volcado('aaaaaaaa-0000-4000-8000-0000000000e6', '2026-08-30T09:00:00.000Z', { marker: { storyId: '3.10' } }));
  escribir(espejo, '.carpetas-de-maquina.json', { schema: 1, carpetas: {
    'maq-v': { estado: 'unida', nueva: 'maq-a', declarantes: 1, desde: '2026-08-01' },
    'maq-w': { estado: 'compartida', declarantes: 2, desde: '2026-08-01' },
    'maq-z': { estado: 'siguio_recibiendo', declarantes: 1, desde: '2026-08-01' } } });
  return espejo;
}

/**
 * Las frases en castellano de un valor ya pintado en inglés, con su ruta. Lo de afuera (lo que vino en el volcado: la
 * story, el producto, la máquina, el mensaje de una prueba) se nombra en `deAfuera` y no cuenta, ni entero ni dentro
 * de una frase de la casa.
 */
function castellanoEn(valor, raiz, deAfuera) {
  const quedan = [];
  const recorrer = (v, ruta) => {
    if (typeof v === 'string') {
      if (!/^[\w./:@-]*$/.test(v) && enCastellano([v], deAfuera).length) quedan.push(`${ruta}: «${v}»`);
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => recorrer(x, `${ruta}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== '_texto' && k !== '_textoGit') recorrer(x, `${ruta}.${k}`);
  };
  recorrer(valor, raiz);
  return quedan;
}
// una frase de cada rama de mundoDeTodasLasRamas(), tal como la escribe el tablero en castellano
const RAMAS_260 = ['con prueba promovida', 'con prueba en la suite', 'sin constancia de sus pruebas', 'lentes sin medir', 'forzado con el interruptor', 'abandonado con el pase',
  'Aprobar el plan no tiene arranque', 'los pasos de espera (3 y 7)', 'no tiene arranque medido', 'repo sin nombre', 'historial local de git', 'el registro no trae sesión', 'antes, maq-v', 'compartida por 2',
  'siguió recibiendo después de la mudanza', 'ya no existe en esta máquina', 'historial local de git (EACCES)'];
const DE_AFUERA_260 = ['sin hilo', 'zqx-prohibido-prompt aprobado', 'esperaba 2, salió 3', 'caso 3', 'feat: un commit', 'Sin Forma.local', 'otra-cosa', 'otra cosa'];

test('2.60-T13 DetalleEnIngles_SinCastellanoEnNingunaRama @story-2.60 @ac-1 @ac-3 — la lista y el detalle de cada ejecución, por la API, sin una frase en castellano', async () => {
  // La familia entera, no los casos sueltos: todo lo que la API devuelve en inglés se recorre, y cualquier frase en
  // castellano que no sea un dato de afuera es un rojo, esté o no en un campo que hoy se traduce.
  const espejo = mundoDeTodasLasRamas();
  const quedan = [];
  for (const sinHilos of [false, true]) {
    const M = runs.modelo(tmp('vacia-'), { buzon: espejo, soloBuzon: true, sinHilos });
    quedan.push(...castellanoEn(runs.todoEnIdioma('en', M), `M${sinHilos ? '(sin hilos)' : ''}`, DE_AFUERA_260));
    for (const c of M.corridas) quedan.push(...castellanoEn(runs.todoEnIdioma('en', runs.paraDetalle(c)), `D(${c.story})`, DE_AFUERA_260));
  }
  // la tabla de pasos que carga pero no nombra ninguno
  const tablaSinNombres = path.join(tmp('site-runs-tabla-'), 'steps.js');
  fs.writeFileSync(tablaSinNombres, 'module.exports = { stepName: () => null };\n');
  const sinNombres = runs.nombresDePasos(tablaSinNombres);
  assert.strictEqual(sinNombres.fuente, 'numeros');
  quedan.push(...castellanoEn(runs.todoEnIdioma('en', { pasos: sinNombres }), 'pasos', DE_AFUERA_260));
  // el mundo toca de verdad cada rama (si una deja de existir, la prueba no la está mirando)
  const M = runs.modelo(tmp('vacia-'), { buzon: espejo, soloBuzon: true });
  const crudo = JSON.stringify([M, ...M.corridas.map((c) => runs.paraDetalle(c))]);
  for (const rama of RAMAS_260) {
    assert.ok(crudo.includes(rama), `el mundo no toca la rama «${rama}»`);
  }
  // y por el sitio: la lista, el detalle de cada una y la ficha gris de quien todavía no tiene ejecuciones
  const machines = { ...MAQUINAS, 'maq-d': { person: DEV_D, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' } };
  await conPestana({ fuentes: fuentesCon({ espejo, config: opsCon(machines) }) }, async ({ h, entrar }) => {
    const lead = `${await entrar(LEAD)}; sitio-idioma=en`;
    const l = (await h.pedir('/api/corridas', { cookie: lead })).json;
    quedan.push(...castellanoEn(l, 'API', DE_AFUERA_260));
    for (const c of l.corridas) {
      const d = await h.pedir(`/api/corridas/${c.id}`, { cookie: lead });
      assert.strictEqual(d.status, 200, `el detalle de ${c.id}`);
      quedan.push(...castellanoEn(d.json, `API(${c.story})`, DE_AFUERA_260));
    }
    const vacia = (await h.pedir('/api/corridas', { cookie: `${await entrar(DEV_D)}; sitio-idioma=en` })).json;
    assert.ok(vacia.vacio_motivo, 'la dev sin ejecuciones tiene su motivo');
    quedan.push(...castellanoEn(vacia, 'API(dev-d)', DE_AFUERA_260));
  });
  // sin saber de quién es cada máquina: «no medido», también en inglés
  await conPestana({ fuentes: fuentesCon({ espejo, informados: null }) }, async ({ h, entrar }) => {
    const l = (await h.pedir('/api/corridas', { cookie: `${await entrar(DEV_A)}; sitio-idioma=en` })).json;
    assert.ok(l.vacio_motivo, 'la dev sin medir tiene su motivo');
    quedan.push(...castellanoEn(l, 'API(no medido)', DE_AFUERA_260));
  });
  assert.deepStrictEqual([...new Set(quedan)], [], `castellano en la ejecución en inglés:\n${[...new Set(quedan)].join('\n')}`);
});

test('2.60-T17 DetalleEnCastellano_CadaRamaIntacta @story-2.60 @ac-6 — en castellano, cada frase de la casa sale tal cual en la API y en lo que dibuja el cliente', async () => {
  // La contracara de T13: sobre el mismo buzón, la pestaña en castellano no traduce nada por error. El servidor y el
  // cliente se miran por separado, así una traducción de un lado no la tapa el otro.
  const espejo = mundoDeTodasLasRamas();
  const M = runs.modelo(tmp('vacia-'), { buzon: espejo, soloBuzon: true });
  const conEscape = (r) => r.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const esta = (texto, r) => texto.includes(r) || texto.includes(conEscape(r));
  const machines = { ...MAQUINAS, 'maq-d': { person: DEV_D, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' } };
  await conPestana({ fuentes: fuentesCon({ espejo, config: opsCon(machines) }) }, async ({ h, entrar }) => {
    const es = `${await entrar(LEAD)}; sitio-idioma=es`;
    const l = (await h.pedir('/api/corridas', { cookie: es })).json;
    const c = await clienteDelSitio(h, es);
    const servidor = [JSON.stringify(l)];
    const cliente = [(await h.pedir('/corridas', { cookie: es })).texto];
    const faltanEnElDibujo = [];
    for (const x of l.corridas) {
      const d = (await h.pedir(`/api/corridas/${x.id}`, { cookie: es })).json;
      const delModelo = M.corridas.find((m) => m.id === x.id);
      assert.ok(delModelo, `la ejecución ${x.story} está en el modelo`);
      assert.deepStrictEqual(d, JSON.parse(JSON.stringify(runs.paraDetalle(delModelo))), `el detalle de ${x.story} en castellano es el del modelo, sin tocar`);
      const json = JSON.stringify(d);
      const dibujo = c.w.__detalle(d);
      servidor.push(json);
      cliente.push(dibujo);
      // lo que el detalle trae del servidor, el cliente lo dibuja tal cual (el motivo de los tiempos no va en el
      // detalle: lo dibuja la tabla, que la página ya trae)
      const delDetalle = JSON.stringify({ ...d, tiempos: undefined });
      for (const r of RAMAS_260) if (delDetalle.includes(r) && !esta(dibujo, r)) faltanEnElDibujo.push(`${x.story}: «${r}»`);
    }
    const faltan = (partes) => RAMAS_260.filter((r) => !esta(partes.join('\n'), r));
    assert.deepStrictEqual(faltan(servidor), [], 'en castellano la API no trae tal cual estas frases');
    assert.deepStrictEqual(faltan(cliente), [], 'en castellano la página y el detalle dibujado no traen tal cual estas frases');
    assert.deepStrictEqual(faltanEnElDibujo, [], 'el detalle dibujado en castellano no trae lo que le dio la API');
    const vacia = (await h.pedir('/api/corridas', { cookie: `${await entrar(DEV_D)}; sitio-idioma=es` })).json;
    assert.match(vacia.vacio_motivo || '', /^todavía no hay ejecuciones de tus máquinas en el depósito/, 'la lista vacía, en castellano');
  });
});

test('2.60-T14 VacioSinMaquinaConfirmada_EnIngles @story-2.60 @ac-1 — «ninguna confirmada» también se traduce', () => {
  const frase = 'todavía no hay ejecuciones de tus máquinas en el depósito (ninguna confirmada): la primera llega sola al terminar un pipeline';
  const en = runs.todoEnIdioma('en', { vacio_motivo: frase }).vacio_motivo;
  assert.notStrictEqual(en, frase);
  assert.deepStrictEqual(enCastellano([en]), [], `queda castellano: «${en}»`);
  const conMaquinas = runs.todoEnIdioma('en', { vacio_motivo: frase.replace('ninguna confirmada', 'maq-d, maq-e') }).vacio_motivo;
  assert.match(conMaquinas, /\(maq-d, maq-e\)/, 'las máquinas, tal cual');
});

test('2.60-T15 NombresDeMaquina_NoSeTraducen @story-2.60 @ac-1 — `nombre` es de la casa en un paso, y de afuera en la lista de máquinas', () => {
  const frase = 'Revisores';
  const en = runs.todoEnIdioma('en', { maquinas: { lista: [{ nombre: frase, corridas: 2 }] }, tramos: [{ nombre: frase }] });
  assert.strictEqual(en.maquinas.lista[0].nombre, frase, 'una máquina que se llama como un paso queda igual');
  assert.notStrictEqual(en.tramos[0].nombre, frase, 'el paso sí se traduce');
  // un repo se traduce sólo si es el «repo sin nombre» de la casa
  const r = runs.todoEnIdioma('en', { cambios: { repos: [{ n: 'repo sin nombre' }, { n: 'Revisores' }] } }).cambios.repos;
  assert.notStrictEqual(r[0].n, 'repo sin nombre');
  assert.strictEqual(r[1].n, 'Revisores');
  // una clave de afuera que se llama como una propiedad de cualquier objeto no tumba la API ni se traduce
  const raras = { constructor: 'Revisores', toString: 'Revisores', __proto__x: 'Revisores', por_control: { constructor: { n: 1 } } };
  assert.deepStrictEqual(runs.todoEnIdioma('en', raras), raras);
});

test('2.60-T16 Decimal_IdiomaDesconocido_ComaComoElCastellano @story-2.60 @ac-6 — un idioma que la tabla no tiene sale entero en castellano, coma incluida', () => {
  const M = runs.modelo(tmp('vacia-'), { buzon: mundo({ marcadores: false }), soloBuzon: true });
  const es = runs.tabla(M, { idioma: 'es' });
  assert.match(sinTags(es), /\d,\d\s?h\b/, 'el castellano lleva coma');
  assert.strictEqual(runs.tabla(M, { idioma: 'fr' }), es, 'un idioma desconocido: igual al castellano');
  assert.strictEqual(runs.cabecera(M, { idioma: 'fr' }), runs.cabecera(M, { idioma: 'es' }));
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

// El texto del error de un hook viaja en la conversación subida, que leen sólo quienes administran el buzón; en el
// sitio no lo ve el dev dueño de la máquina. 🔴 Falla con: que la lista, el detalle, los textos o la página de una ejecución empiecen a
// mostrar los adjuntos de la conversación sin mirar el rol.
test('4.10-T30b SitioNoMuestraElTextoDelHookAlDev @story-4.10 @ac-28', async () => {
  const espejo = mundo();
  const hook = JSON.stringify({ type: 'attachment', timestamp: iso('2026-08-05T09:00:00.000Z', 30),
    attachment: { type: 'hook_non_blocking_error', hookName: 'Stop', hookEvent: 'Stop', exitCode: 1, categoria: 'carga', texto: 'zqx-texto-de-hook: Cannot find module' } });
  escribir(path.join(espejo, 'maq-a'), 'a1.hilo.jsonl.gz', gz(hilo('2026-08-05T09:00:00.000Z', '/Users/dev/SourceCode/Alfa/FrontEnd/src/Pago.ts', 'const viejo = 0;', 'const NUEVO_DE_A = 1;') + hook + '\n'));
  await conPestana({ fuentes: fuentesCon({ espejo }) }, async ({ h, entrar }) => {
    const dev = await entrar(DEV_A);
    const lista = await h.pedir('/api/corridas', { cookie: dev });
    assert.ok(lista.json.corridas.length > 0, 'el dev ve sus ejecuciones');
    const servido = [lista.texto, (await h.pedir('/corridas', { cookie: dev })).texto];
    for (const c of lista.json.corridas) {
      servido.push((await h.pedir(`/api/corridas/${c.id}`, { cookie: dev })).texto);
      const t = await h.pedir(`/api/corridas/${c.id}/textos`, { cookie: dev });
      servido.push(t.texto);
      if (t.json) for (const b of [t.json.texto, t.json.textoGit]) if (b) servido.push(zlib.gunzipSync(Buffer.from(b, 'base64')).toString('utf8'));
    }
    // control positivo: el sitio sí leyó esa conversación (el antes/después de la edición llega al dev)
    assert.ok(servido.some((s) => String(s || '').includes('NUEVO_DE_A')), 'el sitio leyó la conversación de la prueba');
    for (const s of servido) assert.ok(!String(s || '').includes('zqx-texto-de-hook'), 'el texto del hook no le llega al dev');
  });
});

// rojo si: la pestaña del sitio no agrupa con los productos de repos.json (el filtro queda todo en «otros repos») o
// mete en un producto lo que es del laboratorio.
test('Filtro_ProductosDeReposJson_AgrupanLaLista', async () => {
  const fuentes = fuentesCon({ espejo: mundo() });
  fuentes.st.personas = { informados: H.informados(INFORMADOS), repos: [{ producto: 'Cliente A', ruta: 'Alfa/FrontEnd', ado: '' }] };
  await conPestana({ fuentes }, async ({ h, entrar }) => {
    const l = (await h.pedir('/api/corridas', { cookie: await entrar(LEAD) })).json;
    const alfa = l.corridas.filter((c) => c.producto === 'Alfa/FrontEnd');
    assert.ok(alfa.length > 0, 'el mundo de prueba trae ejecuciones de Alfa/FrontEnd');
    assert.deepStrictEqual([...new Set(alfa.map((c) => c.grupo))], ['Cliente A']);
    assert.ok(l.corridas.every((c) => c.producto === 'Alfa/FrontEnd' || c.grupo !== 'Cliente A'), 'sólo su repo cae en el producto');
  });
});

// ── La vista guardada: lo último que había, después de un reinicio ───────────────────────────────────────────────

const VISTA_GUARDADA = (datos) => path.join(datos, 'runs-view.json');
const leerGuardada = (datos) => JSON.parse(fs.readFileSync(VISTA_GUARDADA(datos), 'utf8'));
/**
 * Un armado que espera a que la prueba lo suelte: `{ armar, soltar(), arrancado() }`. Soltado antes de arrancar, el
 * armado que llegue después no espera.
 */
function armadoLento({ falla = false } = {}) {
  const armarReal = TAB().armarEnElHilo;
  let liberar = null;
  let suelto = false;
  const armar = async (o) => {
    if (!suelto) await new Promise((r) => { liberar = r; });
    if (falla) throw Object.assign(new Error('memoria'), { code: 'ERR_WORKER_OUT_OF_MEMORY' });
    return armarReal(o);
  };
  return { armar, soltar: () => { suelto = true; if (liberar) liberar(); }, arrancado: () => Boolean(liberar) };
}
/** Pide hasta que contesta 200 o pasa el tope: `{ r, ms }`. */
async function hasta200(h, ruta, cookie, topeMs = 3000) {
  const t0 = performance.now();
  let r = null;
  while (performance.now() - t0 < topeMs) {
    r = await h.pedir(ruta, { cookie });
    if (r.status === 200) break;
    await new Promise((z) => setTimeout(z, 20));
  }
  return { r, ms: Math.round(performance.now() - t0) };
}
/** Un arranque que deja la vista guardada en `datos` y devuelve lo que sirvió. */
async function primerArranque(datos, { espejo = mundo({ marcadores: false }), config } = {}) {
  let servida = null;
  await conPestana({ fuentes: fuentesCon({ espejo, ...(config ? { config } : {}) }), datos }, async ({ h, entrar, vista }) => {
    await vista.listo();
    servida = (await h.pedir('/api/corridas', { cookie: await entrar(LEAD) })).json;
  });
  return { espejo, servida };
}
// los textos de los cambios de una ejecución van en `texto` y `textoGit` de la ejecución (runs.textosDe); la huella del
// espejo sería una clave de la vista guardada
const sinTextosNiHuella = (g) => {
  assert.ok(!('huella' in g), 'la vista guardada no lleva la huella del espejo');
  for (const c of g.ejecuciones.corridas) {
    for (const k of ['texto', 'textoGit']) assert.ok(!(k in c), `la ejecución ${c.id} no lleva «${k}»`);
    if (isObject(c.cambios)) for (const k of ['texto', 'textoGit', 'parches']) assert.ok(!(k in c.cambios), `los cambios de ${c.id} no llevan «${k}»`);
  }
};
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
/** Lo que ve una sesión en la lista: `[]` si hoy no puede entrar a la pestaña (sin ninguna máquina confirmada). */
async function loQueVe(h, cookie) {
  const r = await h.pedir('/api/corridas', { cookie });
  if (r.status === 403) return [];
  assert.strictEqual(r.status, 200, r.texto);
  return r.json.corridas;
}

// rojo si: el armado no deja la vista en el disco del sitio, la deja con textos o con la huella, no la reemplaza con el
// armado siguiente, o un armado fallado la pisa.
test('T1 2.77-Armado_GuardaLaVistaEntera @story-2.77 @ac-1 @ac-2', async () => {
  const datos = tmp('site-runs-datos-');
  let n = 0;
  const armarReal = TAB().armarEnElHilo;
  const armar = async (o) => { n += 1; if (n === 3) throw Object.assign(new Error('memoria'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }); return armarReal(o); };
  const espejo = mundo({ marcadores: false });
  const fuentes = fuentesCon({ espejo });
  await conPestana({ fuentes, datos, opciones: { armar } }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    await vista.listo();
    const servida = (await h.pedir('/api/corridas', { cookie: lead })).json;
    const g = leerGuardada(datos);
    assert.strictEqual(g.formato, 1);
    assert.strictEqual(g.generado, servida.generado, 'la fecha del armado');
    assert.strictEqual(g.ejecuciones.corridas.length, servida.corridas.length);
    assert.ok(g.informados && g.informados.maquinas && g.informados.maquinas['maq-a'], 'con lo informado de la misma bajada');
    sinTextosNiHuella(g);
    // el armado siguiente la reemplaza
    escribir(path.join(espejo, 'maq-a'), 'a3.json', volcado('aaaaaaaa-0000-4000-8000-000000000003', '2026-08-20T09:00:00.000Z', { marker: { storyId: '3.3' } }));
    fuentes.avisar(); await vista.listo();
    const g2 = leerGuardada(datos);
    assert.strictEqual(g2.ejecuciones.corridas.length, g.ejecuciones.corridas.length + 1, 'el armado nuevo la reemplaza');
    // uno fallado no la toca
    const antes = fs.readFileSync(VISTA_GUARDADA(datos));
    escribir(path.join(espejo, 'maq-a'), 'a4.json', volcado('aaaaaaaa-0000-4000-8000-000000000004', '2026-08-21T09:00:00.000Z', { marker: { storyId: '3.4' } }));
    fuentes.avisar(); await vista.listo();
    assert.strictEqual(n, 3, 'el tercer armado corrió y falló');
    assert.ok(fs.readFileSync(VISTA_GUARDADA(datos)).equals(antes), 'un armado fallado no toca la guardada');
  });
});

// rojo si: después de un reinicio la pestaña dice «cargando» con una vista guardada, o tarda más de 2 s en servirla.
test('T2 2.77-Reinicio_SirveLaGuardadaAlInstante @story-2.77 @ac-4', async () => {
  const datos = tmp('site-runs-datos-');
  const { espejo, servida } = await primerArranque(datos);
  const lento = armadoLento();
  await conPestana({ fuentes: fuentesCon({ espejo }), datos, opciones: { noEsperar: true, armar: lento.armar } }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    assert.strictEqual((await h.pedir('/healthz')).status, 200);
    // el primer pedido, sin reintentar: una respuesta de «cargando» antes de la guardada también es rojo
    const t0 = performance.now();
    const r = await h.pedir('/api/corridas', { cookie: lead });
    const ms = Math.round(performance.now() - t0);
    assert.strictEqual(r.status, 200, r.texto);
    assert.ok(ms < 2000, `la guardada se sirvió en ${ms} ms`);
    assert.deepStrictEqual(r.json.vista, { guardada: true, generado: servida.generado });
    assert.strictEqual(r.json.corridas.length, servida.corridas.length);
    assert.doesNotMatch((await h.pedir('/corridas', { cookie: lead })).texto, /cargando las ejecuciones/);
    lento.soltar(); await vista.listo();
  });
});

// rojo si: con la bajada a medias después de un reinicio no se sirve la guardada, se sirve sin decir que puede faltar
// algo, a una persona le sale «no medido», o se arma con la bajada a medias.
test('T3 2.77-Reinicio_BajadaAMedias_SirveLaGuardada @story-2.77 @ac-5 @ac-15', async () => {
  const datos = tmp('site-runs-datos-');
  const { espejo, servida } = await primerArranque(datos);
  const fuentes = fuentesCon({ espejo, informados: null });
  fuentes.bajada = { completo: false, generacion: 0 };
  await conPestana({ fuentes, datos, opciones: { noEsperar: true } }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    const dev = await entrar(DEV_A);
    const { r } = await hasta200(h, '/api/corridas', lead);
    assert.strictEqual(r.status, 200, r.texto);
    assert.strictEqual(r.json.generado, servida.generado, 'la guardada, con su fecha');
    assert.strictEqual(r.json.buzon.parcial, true, 'puede faltar alguna ejecución');
    const d = (await h.pedir('/api/corridas', { cookie: dev })).json;
    assert.ok(!d.vacio_motivo || !/no medido/.test(d.vacio_motivo), `la persona no ve «no medido»: ${d.vacio_motivo}`);
    assert.ok(d.corridas.length > 0 && d.corridas.every((c) => c.maquina === 'maq-a'), 'sólo sus máquinas');
    assert.strictEqual(vista.armando(), false, 'no se arma con la bajada a medias');
  });
});

// rojo si: con la guardada y algo por esperar no hay banda ni recarga; si siguen con el armado nuevo; si con el armado
// fallado o la fuente del buzón fallando la página promete actualizarse sola o se recarga sin fin.
test('T4 2.77-Guardada_BandaRecargaYApi @story-2.77 @ac-6 @ac-7', async () => {
  const datos = tmp('site-runs-datos-');
  const { espejo, servida } = await primerArranque(datos);
  const BANDA = /Se muestra la vista guardada el/;
  const RECARGA = /<meta http-equiv="refresh" content="60">/;
  // esperando la bajada entera
  const fuentes = fuentesCon({ espejo, informados: null });
  fuentes.bajada = { completo: false, generacion: 0 };
  await conPestana({ fuentes, datos, opciones: { noEsperar: true } }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    await hasta200(h, '/api/corridas', lead);
    const p = await h.pedir('/corridas', { cookie: lead });
    assert.strictEqual(p.status, 200);
    assert.match(p.texto, BANDA);
    assert.match(p.texto, RECARGA);
    // llega la bajada entera: el armado nuevo se pone, sin banda ni recarga, y reemplaza la guardada
    fuentes.st.personas = { informados: H.informados(INFORMADOS), repos: null };
    fuentes.bajada = { completo: true, generacion: 1 };
    fuentes.avisar(); await vista.listo();
    const p2 = await h.pedir('/corridas', { cookie: lead });
    assert.doesNotMatch(p2.texto, BANDA);
    assert.doesNotMatch(p2.texto, RECARGA);
    assert.strictEqual((await h.pedir('/api/corridas', { cookie: lead })).json.vista, undefined);
    assert.notStrictEqual(leerGuardada(datos).generado, servida.generado, 'la guardada se reemplazó');
  });
  // el armado de este arranque falla: sólo la banda del rearmado, sin recarga
  const guardada = leerGuardada(datos).generado;
  await conPestana({ fuentes: fuentesCon({ espejo }), datos, opciones: { armar: async () => { throw Object.assign(new Error('memoria'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }); } } }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    const p = await h.pedir('/corridas', { cookie: lead });
    assert.strictEqual(p.status, 200, p.texto);
    assert.match(p.texto, /No se pudo rearmar la vista de ejecuciones/);
    assert.ok(p.texto.includes(guardada.slice(0, 16).replace('T', ' ')), 'con la fecha de la guardada');
    assert.doesNotMatch(p.texto, BANDA);
    assert.doesNotMatch(p.texto, RECARGA);
  });
  // la fuente del buzón falla: no hay nada por esperar
  const caida = fuentesCon({ espejo, informados: null });
  caida.bajada = { completo: false, generacion: 0 };
  caida.st.bandaRefresco = { desde: Date.parse('2026-10-24T14:33:00Z'), estado: 'error' };
  await conPestana({ fuentes: caida, datos, opciones: { noEsperar: true } }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    await hasta200(h, '/api/corridas', lead);
    const p = await h.pedir('/corridas', { cookie: lead });
    assert.strictEqual(p.status, 200);
    assert.doesNotMatch(p.texto, BANDA);
    assert.doesNotMatch(p.texto, RECARGA);
  });
});

// rojo si: los textos de la guardada dicen que la ejecución no tiene cambios, prometen volver cuando no hay nada por
// esperar, o no vuelven con el armado nuevo; o el mapa a demanda guardado deja de andar.
test('T5 2.77-Guardada_TextosVuelvenConElArmado @story-2.77 @ac-8', async () => {
  const datos = tmp('site-runs-datos-');
  const { espejo, servida } = await primerArranque(datos);
  const a1 = servida.corridas.find((c) => c.story === '3.1').id;
  const a2 = servida.corridas.find((c) => c.story === '3.2');
  // una ejecución a demanda en el mapa guardado, con su volcado dentro del buzón
  const g = leerGuardada(datos);
  g.aDemanda = { [a2.id]: path.join(espejo, 'maq-a', 'a2.json') };
  fs.writeFileSync(VISTA_GUARDADA(datos), JSON.stringify(g));
  const pedidos = [];
  const conBajada = (f) => { f.bajarCorrida = async (x) => { pedidos.push(x); return { codigo: 1, res: { estado: 'sin_partes' } }; }; return f; };
  const fuentes = conBajada(fuentesCon({ espejo, informados: null }));
  fuentes.bajada = { completo: false, generacion: 0 };
  await conPestana({ fuentes, datos, opciones: { noEsperar: true } }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    await hasta200(h, '/api/corridas', lead);
    const t = await h.pedir(`/api/corridas/${a1}/textos`, { cookie: lead });
    assert.strictEqual(t.status, 503, t.texto);
    assert.match(t.texto, /los cambios de esta ejecución vuelven cuando termine de armarse la vista/);
    assert.strictEqual(t.headers['retry-after'], '60');
    const d = await h.pedir(`/api/corridas/${a2.id}/textos`, { cookie: lead });
    assert.strictEqual(d.status, 200, 'la a demanda anda como hoy');
    assert.strictEqual(pedidos.length, 1, 'bajó del buzón');
    // llega la bajada entera: el armado nuevo trae los textos
    fuentes.st.personas = { informados: H.informados(INFORMADOS), repos: null };
    fuentes.bajada = { completo: true, generacion: 1 };
    fuentes.avisar(); await vista.listo();
    const t2 = await h.pedir(`/api/corridas/${a1}/textos`, { cookie: lead });
    assert.strictEqual(t2.status, 200, t2.texto);
    assert.ok(t2.json.textoGit, 'el parche volvió');
  });
  // sin nada por esperar (el armado de este arranque falló): «no están disponibles», sin Retry-After; también con una
  // bajada posterior a medias (decisión 4: con el armado fallado no hay nada por esperar)
  const fallado = fuentesCon({ espejo });
  await conPestana({ fuentes: fallado, datos, opciones: { armar: async () => { throw Object.assign(new Error('x'), { code: 'X' }); } } }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    const ida1 = (await h.pedir('/api/corridas', { cookie: lead })).json.corridas.find((c) => c.story === '3.1').id;
    const t = await h.pedir(`/api/corridas/${ida1}/textos`, { cookie: lead });
    assert.strictEqual(t.status, 503, t.texto);
    assert.match(t.texto, /no están disponibles hasta el próximo armado de la vista/);
    assert.strictEqual(t.headers['retry-after'], undefined);
    fallado.bajada = { completo: false, generacion: 2 };
    fallado.avisar(); await vista.listo();
    const t2 = await h.pedir(`/api/corridas/${ida1}/textos`, { cookie: lead });
    assert.strictEqual(t2.status, 503, t2.texto);
    assert.match(t2.texto, /no están disponibles hasta el próximo armado de la vista/, 'armado fallado y bajada a medias: no se promete que vuelvan');
    assert.strictEqual(t2.headers['retry-after'], undefined);
  });
});

// rojo si: la guardada se filtra con las reglas del momento del armado y no con las de hoy.
test('T6 2.77-Guardada_FiltraConLasReglasDeHoy @story-2.77 @ac-9', async () => {
  const datos = tmp('site-runs-datos-');
  const { espejo, servida } = await primerArranque(datos);
  const a1 = servida.corridas.find((c) => c.story === '3.1').id;
  // hoy, maq-a ya no está confirmada para dev-a
  const fuentes = fuentesCon({ espejo, config: opsCon({ 'maq-b': MAQUINAS['maq-b'] }), informados: null });
  fuentes.bajada = { completo: false, generacion: 0 };
  await conPestana({ fuentes, datos, opciones: { noEsperar: true } }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    await hasta200(h, '/api/corridas', lead);
    const dev = await entrar(DEV_A);
    assert.ok((await loQueVe(h, dev)).every((c) => c.maquina !== 'maq-a'), 'dev-a ya no ve maq-a');
    assert.ok([403, 404].includes((await h.pedir(`/api/corridas/${a1}`, { cookie: dev })).status), 'su detalle tampoco');
    // con la confirmación de antes, la misma guardada sí le muestra maq-a: lo que cambió es la regla de hoy
    assert.ok(servida.corridas.some((c) => c.maquina === 'maq-a'));
    // los repos de hoy también: la fuente cambia repos.json en el mismo objeto de personas, y la guardada agrupa con lo nuevo
    const grupos = async () => [...new Set((await h.pedir('/api/corridas', { cookie: lead })).json.corridas.map((c) => c.grupo))];
    assert.ok(!(await grupos()).includes('Cliente A'));
    fuentes.st.personas.repos = [{ producto: 'Cliente A', ruta: 'Alfa/FrontEnd', ado: '' }];
    assert.ok((await grupos()).includes('Cliente A'), 'la guardada agrupa con el repos.json de hoy');
  });
});

// rojo si: una vista guardada rota se sirve, no se dice en el registro, o una ruta del mapa a demanda fuera del buzón
// hace copiar otro archivo del disco.
test('T7 2.77-Guardada_Ilegible_NoSeSirve @story-2.77 @ac-10', async () => {
  const datosOk = tmp('site-runs-datos-');
  const { espejo, servida } = await primerArranque(datosOk);
  const buena = leerGuardada(datosOk);
  const casos = [
    ['json roto', (d) => fs.writeFileSync(VISTA_GUARDADA(d), '{ esto no')],
    ['otro formato', (d) => fs.writeFileSync(VISTA_GUARDADA(d), JSON.stringify({ ...buena, formato: 2 }))],
    ['sin ejecuciones', (d) => fs.writeFileSync(VISTA_GUARDADA(d), JSON.stringify({ ...buena, ejecuciones: null }))],
  ];
  if (!(process.getuid && process.getuid() === 0)) casos.push(['sin permiso de lectura', (d) => { fs.writeFileSync(VISTA_GUARDADA(d), JSON.stringify(buena)); fs.chmodSync(VISTA_GUARDADA(d), 0o000); }]);
  for (const [nombre, armarCaso] of casos) {
    const datos = tmp('site-runs-datos-');
    armarCaso(datos);
    const registro = [];
    const fuentes = fuentesCon({ espejo, informados: null });
    fuentes.bajada = { completo: false, generacion: 0 };
    await conPestana({ fuentes, datos, opciones: { noEsperar: true, log: (l) => registro.push(l) } }, async ({ h, entrar, vista }) => {
      const lead = await entrar(LEAD);
      await vista.listo();
      const r = await h.pedir('/api/corridas', { cookie: lead });
      assert.strictEqual(r.status, 503, `${nombre}: no se sirve, y se dice que carga`);
      assert.ok(registro.some((l) => /vista guardada/.test(l)), `${nombre}: el registro lo dice (${registro.join(' | ')})`);
    });
    try { fs.chmodSync(VISTA_GUARDADA(datos), 0o600); } catch { /* ya está */ }
  }
  // una ruta del mapa a demanda fuera del buzón: se descarta, nunca se copia
  const datos = tmp('site-runs-datos-');
  const a2 = servida.corridas.find((c) => c.story === '3.2').id;
  const ajeno = path.join(tmp('site-runs-ajeno-'), 'secreto.json');
  fs.writeFileSync(ajeno, '{"zqx":"no se copia"}');
  fs.writeFileSync(VISTA_GUARDADA(datos), JSON.stringify({ ...buena, aDemanda: { [a2]: ajeno } }));
  const pedidos = [];
  const fuentes = fuentesCon({ espejo, informados: null });
  fuentes.bajada = { completo: false, generacion: 0 };
  fuentes.bajarCorrida = async (x) => { pedidos.push(x); return { codigo: 1, res: { estado: 'sin_partes' } }; };
  await conPestana({ fuentes, datos, opciones: { noEsperar: true } }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    await hasta200(h, '/api/corridas', lead);
    const t = await h.pedir(`/api/corridas/${a2}/textos`, { cookie: lead });
    assert.strictEqual(t.status, 503, t.texto);
    assert.strictEqual(pedidos.length, 0, 'no se bajó ni se copió nada');
  });
});

// rojo si: sin disco del sitio se escribe una vista guardada en algún lado.
test('T8 2.77-SinDisco_ComoHoy @story-2.77 @ac-11', async () => {
  const datos = tmp('site-runs-datos-');
  await conPestana({ fuentes: fuentesCon({ espejo: mundo({ marcadores: false }) }), datos, sinDisco: true }, async ({ h, entrar, vista }) => {
    await vista.listo();
    assert.strictEqual((await h.pedir('/api/corridas', { cookie: await entrar(LEAD) })).status, 200);
    assert.strictEqual(vista.estado().guardada, null);
  });
  assert.ok(!fs.existsSync(VISTA_GUARDADA(datos)), 'sin SITE_DATA_DIR no se guarda');
});

// rojo si: no poder guardar la vista tumba el armado, o el registro trae una ruta.
test('T9 2.77-EscrituraFallida_ElArmadoSeSirve @story-2.77 @ac-3', async () => {
  const datos = tmp('site-runs-datos-');
  fs.mkdirSync(VISTA_GUARDADA(datos));   // una carpeta en el lugar del archivo: el rename falla
  const registro = [];
  await conPestana({ fuentes: fuentesCon({ espejo: mundo({ marcadores: false }) }), datos, opciones: { log: (l) => registro.push(l) } }, async ({ h, entrar, vista }) => {
    await vista.listo();
    assert.strictEqual((await h.pedir('/api/corridas', { cookie: await entrar(LEAD) })).status, 200, 'el armado se sirve');
    const linea = registro.find((l) => /no se pudo guardar la vista/.test(l));
    assert.ok(linea, registro.join(' | '));
    assert.ok(!linea.includes(datos), 'sin rutas en el registro');
  });
  // la carpeta de datos sin permiso de escritura: falla la escritura del temporal, no el rename, y el armado igual se sirve
  if (process.getuid && process.getuid() === 0) return;
  const datos2 = tmp('site-runs-datos-');
  const registro2 = [];
  const lento = armadoLento();
  await conPestana({ fuentes: fuentesCon({ espejo: mundo({ marcadores: false }) }), datos: datos2, opciones: { noEsperar: true, armar: lento.armar, log: (l) => registro2.push(l) } }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    fs.chmodSync(datos2, 0o500);
    try {
      lento.soltar(); await vista.listo();
      assert.strictEqual((await h.pedir('/api/corridas', { cookie: lead })).status, 200, 'sin poder escribir el temporal, el armado se sirve');
      const linea = registro2.find((l) => /no se pudo guardar la vista para el próximo arranque/.test(l));
      assert.ok(linea, registro2.join(' | '));
      assert.ok(!linea.includes(datos2), 'sin rutas en el registro');
    } finally { fs.chmodSync(datos2, 0o700); }
  });
  assert.deepStrictEqual(fs.readdirSync(datos2).filter((f) => f.startsWith('runs-view')), [], 'ni guardada ni temporal');
});

// rojo si: leer una vista guardada grande traba al sitio.
test('T10 2.77-Lectura_NoFrenaHealthz @story-2.77 @ac-12', async () => {
  const datos = tmp('site-runs-datos-');
  const { espejo } = await primerArranque(datos);
  // una guardada del tamaño medido (unos 20 MB): la misma ejecución repetida con ids distintos
  const g = leerGuardada(datos);
  const base = g.ejecuciones.corridas[0];
  const muchas = [];
  for (let i = 0; muchas.length < 6500; i++) muchas.push({ ...base, id: i.toString(16).padStart(16, '0') });
  g.ejecuciones.corridas = muchas;
  fs.writeFileSync(VISTA_GUARDADA(datos), JSON.stringify(g));
  assert.ok(fs.statSync(VISTA_GUARDADA(datos)).size > 20 * 1024 * 1024, `la guardada tiene el tamaño medido (${fs.statSync(VISTA_GUARDADA(datos)).size})`);
  const lento = armadoLento();
  await conPestana({ fuentes: fuentesCon({ espejo }), datos, opciones: { noEsperar: true, armar: lento.armar } }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    const t0 = performance.now();
    assert.strictEqual((await h.pedir('/healthz')).status, 200);
    assert.strictEqual((await h.pedir('/', { cookie: lead })).status, 200);
    const ms = Math.round(performance.now() - t0);
    assert.ok(ms < 1000, `contestaron en ${ms} ms mientras se leía la guardada`);
    lento.soltar(); await vista.listo();
  });
});

// rojo si: un temporal a medio escribir de un arranque anterior se lee en lugar de la guardada entera.
test('T11 2.77-Guardada_EscrituraAtomica @story-2.77 @ac-1', async () => {
  const datos = tmp('site-runs-datos-');
  const { espejo, servida } = await primerArranque(datos);
  fs.writeFileSync(`${VISTA_GUARDADA(datos)}.tmp-12345`, '{ "formato": 1, "generado": "2099');
  const fuentes = fuentesCon({ espejo, informados: null });
  fuentes.bajada = { completo: false, generacion: 0 };
  await conPestana({ fuentes, datos, opciones: { noEsperar: true } }, async ({ h, entrar }) => {
    const { r } = await hasta200(h, '/api/corridas', await entrar(LEAD));
    assert.strictEqual(r.status, 200, r.texto);
    assert.strictEqual(r.json.generado, servida.generado, 'la guardada entera');
  });
});

// rojo si: el archivo queda con permisos abiertos o alguna ruta del sitio lo sirve.
test('T14 2.77-Guardada_PermisosYSinRuta @story-2.77 @ac-16', async () => {
  const datos = tmp('site-runs-datos-');
  await conPestana({ fuentes: fuentesCon({ espejo: mundo({ marcadores: false }) }), datos }, async ({ h, entrar, vista }) => {
    await vista.listo();
    assert.strictEqual(fs.statSync(VISTA_GUARDADA(datos)).mode & 0o777, 0o600);
    const lead = await entrar(LEAD);
    for (const ruta of ['/runs-view.json', '/corridas/runs-view.json', '/static/runs-view.json', '/api/corridas/runs-view.json']) {
      const r = await h.pedir(ruta, { cookie: lead });
      assert.ok(r.status === 404, `${ruta}: ${r.status}`);
      assert.doesNotMatch(r.texto || '', /"formato"\s*:\s*1/);
    }
  });
});

// rojo si: con la guardada, una máquina que cambió de dueño se filtra con lo informado nuevo (una foto más nueva que la
// vista), o sigue con el dueño viejo después del armado nuevo.
test('T15 2.77-Guardada_CambioDeDueno_HastaLaBajadaEntera @story-2.77 @ac-15', async () => {
  const datos = tmp('site-runs-datos-');
  const { espejo } = await primerArranque(datos);
  const maqAdeB = { ...MAQUINAS, 'maq-a': { person: DEV_B, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-24' } };
  const nuevos = H.informados({ ...INFORMADOS, 'maq-a': DEV_B });
  const verMaqA = async (h, cookie) => (await loQueVe(h, cookie)).some((c) => c.maquina === 'maq-a');
  // la confirmación de hoy todavía dice dev-a: la ve dev-a
  const f1 = fuentesCon({ espejo, informados: null });
  f1.bajada = { completo: false, generacion: 0 };
  await conPestana({ fuentes: f1, datos, opciones: { noEsperar: true } }, async ({ h, entrar }) => {
    await hasta200(h, '/api/corridas', await entrar(LEAD));
    assert.strictEqual(await verMaqA(h, await entrar(DEV_A)), true, 'el dueño viejo, con la confirmación vieja');
    assert.strictEqual(await verMaqA(h, await entrar(DEV_B)), false);
  });
  // reconfirmada para dev-b: ninguna persona la ve (sólo quien mantiene), también con el armado nuevo en curso
  const lento = armadoLento();
  const f2 = fuentesCon({ espejo, config: opsCon(maqAdeB), informados: null });
  f2.bajada = { completo: false, generacion: 0 };
  await conPestana({ fuentes: f2, datos, opciones: { noEsperar: true, armar: lento.armar } }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    await hasta200(h, '/api/corridas', lead);
    assert.strictEqual(await verMaqA(h, await entrar(DEV_A)), false, 'reconfirmada: el viejo no');
    assert.strictEqual(await verMaqA(h, await entrar(DEV_B)), false, 'y el nuevo tampoco, con la foto vieja');
    assert.strictEqual(await verMaqA(h, lead), true, 'quien mantiene sí');
    // llega la bajada entera con lo informado nuevo; el armado nuevo tarda
    f2.st.personas = { informados: nuevos, repos: null };
    f2.bajada = { completo: true, generacion: 1 };
    f2.avisar();
    for (let i = 0; i < 200 && !lento.arrancado(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(lento.arrancado(), 'el armado nuevo arrancó');
    assert.strictEqual(await verMaqA(h, await entrar(DEV_B)), false, 'con el armado en curso, la guardada sigue con su foto');
    lento.soltar(); await vista.listo();
    assert.strictEqual(await verMaqA(h, await entrar(DEV_B)), true, 'con el armado nuevo, el dueño nuevo');
    assert.strictEqual(await verMaqA(h, await entrar(DEV_A)), false);
  });
});

test('T1 2.79-Corridas_VistaServida_NoSeReemplazaAMedias @story-2.79 @ac-1', async () => {
  // el caso de la Task 0.1: con la vista entera servida, una pasada con conversaciones pendientes no la reemplaza (sin
  // la conversación, el título, los tiempos y el consumo de una ejecución van y vuelven). Se espera a la pasada entera.
  const espejo = mundo({ marcadores: false });
  const fuentes = fuentesCon({ espejo });
  await conPestana({ fuentes }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    const antes = (await h.pedir('/api/corridas', { cookie: lead })).json;
    escribir(path.join(espejo, 'maq-a'), 'a7.json', volcado('aaaaaaaa-0000-4000-8000-000000000007', '2026-08-22T09:00:00.000Z', { marker: { storyId: '3.7' } }));
    fuentes.bajada = { completo: false, armable: true, generacion: 2, pendientes: 3 };
    fuentes.avisar(); await vista.listo();
    const l = (await h.pedir('/api/corridas', { cookie: lead })).json;
    assert.strictEqual(l.generado, antes.generado, 'la vista entera sigue servida');
    assert.deepStrictEqual(l.corridas.map((c) => [c.id, c.maquina, c.repo, c.story]), antes.corridas.map((c) => [c.id, c.maquina, c.repo, c.story]), 'mismos ids, máquinas y productos');
    assert.ok(!(l.buzon && l.buzon.pendientes), 'la vista servida es entera: no dice que le faltan conversaciones');
    assert.strictEqual(l.buzon && l.buzon.parcial, true, 'pero dice que puede faltar alguna ejecución: espera la pasada entera');
    // la pasada entera sí la reemplaza
    fuentes.bajada = { completo: true, armable: true, generacion: 3 };
    fuentes.avisar(); await vista.listo();
    assert.strictEqual((await h.pedir('/api/corridas', { cookie: lead })).json.corridas.length, antes.corridas.length + 1);
  });
  // en frío, sin vista: se arma con los registros enteros y se dice cuántas faltan (2.77); la pasada entera la reemplaza
  const espejoFrio = mundo({ marcadores: false });
  const frio = fuentesCon({ espejo: espejoFrio });
  frio.bajada = { completo: false, armable: true, generacion: 1, pendientes: 2 };
  await conPestana({ fuentes: frio }, async ({ h, entrar, vista }) => {
    const lead = await entrar(LEAD);
    const l = (await h.pedir('/api/corridas', { cookie: lead })).json;
    assert.ok(l.corridas.length > 0, 'arma en frío');
    assert.strictEqual(l.buzon.pendientes, 2, 'y dice cuántas faltan');
    // una pasada entera que no cambia el espejo (lo que faltaba ya no estaba en el buzón): no le falta nada
    frio.bajada = { completo: true, armable: true, generacion: 2 };
    frio.avisar(); await vista.listo();
    const igual = (await h.pedir('/api/corridas', { cookie: lead })).json;
    assert.ok(!(igual.buzon && igual.buzon.pendientes), `la entera sin cambios no arrastra los pendientes: ${JSON.stringify(igual.buzon)}`);
    frio.bajada = { completo: false, armable: true, generacion: 3, pendientes: 2 };
    frio.avisar(); await vista.listo();
    // la pasada entera trae lo que faltaba (acá, una ejecución más: cambia el espejo como cambia con las conversaciones)
    escribir(path.join(espejoFrio, 'maq-a'), 'a8.json', volcado('aaaaaaaa-0000-4000-8000-000000000008', '2026-08-23T09:00:00.000Z', { marker: { storyId: '3.8' } }));
    frio.bajada = { completo: true, armable: true, generacion: 2 };
    frio.avisar(); await vista.listo();
    const l2 = (await h.pedir('/api/corridas', { cookie: lead })).json;
    assert.strictEqual(l2.corridas.length, l.corridas.length + 1, 'la pasada entera reemplaza la vista armada a medias');
    assert.ok(!(l2.buzon && l2.buzon.pendientes));
  });
});

test('T2 2.79-Espejo_BajadaYArmado_NoSePisan (la pestaña) @story-2.79 @ac-2', async () => {
  // con la bajada escribiendo el espejo no se arma; al terminar (el refresco avisa), sí. Y la pestaña le dice a las
  // fuentes cuándo arma, para que la bajada espere
  const espejo = mundo({ marcadores: false });
  const fuentes = fuentesCon({ espejo });
  const armandoDe = [];
  fuentes.alArmar = (fn) => armandoDe.push(fn);
  await conPestana({ fuentes }, async ({ h, entrar, vista }) => {
    assert.strictEqual(armandoDe.length, 1, 'la pestaña se anota');
    assert.strictEqual(armandoDe[0](), false, 'sin armado en curso');
    const lead = await entrar(LEAD);
    const antes = (await h.pedir('/api/corridas', { cookie: lead })).json;
    escribir(path.join(espejo, 'maq-a'), 'a7.json', volcado('aaaaaaaa-0000-4000-8000-000000000007', '2026-08-22T09:00:00.000Z', { marker: { storyId: '3.7' } }));
    fuentes.bajada = { completo: true, armable: true, generacion: 2, bajando: true };
    fuentes.avisar(); await vista.listo();
    assert.strictEqual((await h.pedir('/api/corridas', { cookie: lead })).json.corridas.length, antes.corridas.length, 'con la bajada escribiendo, no arma');
    fuentes.bajada = { completo: true, armable: true, generacion: 2 };
    fuentes.avisar(); await vista.listo();
    assert.strictEqual((await h.pedir('/api/corridas', { cookie: lead })).json.corridas.length, antes.corridas.length + 1, 'terminada la bajada, arma');
  });
  // un armado que falla suelta la marca: la bajada no queda esperando un armado que ya no existe
  const fallido = fuentesCon({ espejo: mundo({ marcadores: false }) });
  const armandoFallido = [];
  fallido.alArmar = (fn) => armandoFallido.push(fn);
  await conPestana({ fuentes: fallido, opciones: { armar: async () => { throw Object.assign(new Error('memoria'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }); } } }, async ({ vista }) => {
    await vista.listo();
    assert.strictEqual(armandoFallido[0](), false, 'tras el fallo, la pestaña no dice que arma');
  });
});

test('T8 2.79-Corridas_FichasDeLaNoche_DicenQueNoSiguenElFiltro @story-2.79 @ac-7 — las fichas de la noche dicen de cuándo son y que el filtro no las cambia', async () => {
  const cards = require(path.join(H.SITE, 'tabs', 'cards.js'));
  const f = fuentesCon({ espejo: mundo() });
  f.st.modelo = { ...f.st.modelo, fichas: cards.modeloDeFichas({ local: {
    corridas: { estado: 'medido', valor: 1.25, medidos: 5, total: 5, unidad: 'conteo', fecha: '2026-08-10' },
  } }) };
  await conPestana({ fuentes: f }, async ({ h, entrar }) => {
    for (const [idioma, frase] of [['es', /son de la noche y no siguen el filtro/], ['en', /are from last night and do not follow the filter/]]) {
      const p = (await h.pedir('/corridas?desde=2026-08-10&hasta=2026-08-10', { cookie: `${await entrar(LEAD)}; sitio-idioma=${idioma}` })).texto;
      const grilla = p.slice(p.indexOf('id="fichas-corridas"'), p.indexOf('<table'));
      assert.match(grilla, frase, `${idioma}: la grilla de la noche lo dice`);
    }
  });
});

test('T47 2.79-Corridas_CadaControlConNombreLlano @story-2.79 @ac-39 — cada control que se cuenta tiene su nombre en castellano y en inglés, y los chips van separados', () => {
  // 🔴 rojo: un control de los que cuenta el tablero (o «ac-shown», «approval», que escribe el pipeline) sin nombre —
  // sale su clave técnica—, un nombre sin su traducción, o los tres chips de la fila pegados («approvalac-shown»).
  const fuentes = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'sources.json'), 'utf8'));
  const contados = fuentes.reducer.metrics.bloqueos.values;
  const T = require(path.join(H.SITE, 'texts.js'));
  for (const k of [...contados, 'ac-shown', 'approval']) {
    assert.ok(Object.prototype.hasOwnProperty.call(runs.CONTROLES, k), `«${k}» tiene nombre`);
    const es = runs.CONTROLES[k];
    assert.notStrictEqual(es, k, `«${k}» no se nombra con su clave`);
    assert.strictEqual(runs.enIdioma('es', es), es);
    const en = runs.enIdioma('en', es);
    assert.notStrictEqual(en, es, `«${es}» tiene su inglés`);
    assert.ok(Object.values(T.TEXTOS).some((v) => v.es === es && v.en === en), `«${es}» se traduce por un texto de la tabla`);
  }
  // la fila de la tabla: hasta tres chips, separados por « · »
  const t0 = '2026-08-15T05:53:47Z';
  const c = { controles: { por_control: { approval: { n: 2, paso: 2, error: 0, freno: 0 }, 'ac-shown': { n: 1, paso: 1, error: 0, freno: 0 }, build: { n: 1, paso: 1, error: 0, freno: 0 } } }, inicio: t0 };
  const fila = runs.filaControles(c, 'es');
  assert.strictEqual((fila.match(/<\/span> · <span class="f/g) || []).length, 2, `los tres chips separados: ${fila}`);
});

test('2.79-Corridas_SemanaEnElIdioma @story-2.79 @ac-34 (complemento de T40) — la semana guardada «2026-S44» se ve «W44» en inglés y «S44» en castellano', () => {
  // 🔴 rojo: la celda o el cliente muestran la clave guardada tal cual en inglés («S44»), o la clave cambia de forma.
  assert.strictEqual(runs.semanaVisible('2026-S44', 'en'), '2026-W44');
  assert.strictEqual(runs.semanaVisible('2026-S44', 'es'), '2026-S44');
  assert.strictEqual(runs.semanaVisible('basura', 'en'), '');
  const T = require(path.join(H.SITE, 'texts.js'));
  for (const k of ['corridas.v.letraSemana', 'corridas.c.letraSemana']) assert.deepStrictEqual([T.TEXTOS[k].es, T.TEXTOS[k].en], ['S', 'W'], k);
  // el cliente arma lo visible con la letra del idioma, nunca con la clave guardada
  const fuente = fs.readFileSync(RUNS, 'utf8');
  assert.match(fuente, /var semanaVisible = function \(k\) \{ return k\.slice\(0, 5\) \+ T\('letraSemana'\)/);
});
