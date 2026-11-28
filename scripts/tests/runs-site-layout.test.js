'use strict';
// runs-site-layout.test.js — la pestaña Ejecuciones del sitio se lee entera.
//
// A135: la fecha del detalle de una ejecución es la misma que la de su fila (la del navegador), no la UTC.
// A136: las ejecuciones del sitio demo son de productos, no de laboratorio; y el grupo «laboratorio» del filtro dice qué es.
// A137: la tabla «Ejecución por ejecución» entra en el ancho del sitio a 1280 px (962 px de contenido).
// A138: el detalle abierto ocupa el ancho visible de la tabla, no el de la ventana.
// A139: la línea de tiempo del detalle conserva su ancho mínimo dentro del sitio (en el celular se desliza en su caja).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const RUNS = path.join(RAIZ, 'scripts', 'nightly', 'dashboard', 'runs.js');
const SITE_CSS = path.join(RAIZ, 'scripts', 'site', 'static', 'site.css');
const DATOS = require(path.join(RAIZ, 'scripts', 'site', 'demo', 'data.js'));
const { esLaboratorio } = require(RUNS);

/** Una regla CSS de runs.js por su selector exacto (el texto entre llaves de su primera aparición). */
function regla(texto, selector) {
  const i = texto.indexOf(`\n${selector}{`) >= 0 ? texto.indexOf(`\n${selector}{`) + 1 : texto.indexOf(`}${selector}{`) + 1;
  assert.ok(i > 0, `no encontré la regla ${selector}`);
  const a = texto.indexOf('{', i);
  return texto.slice(a + 1, texto.indexOf('}', a));
}
const px = (decl, prop) => { const m = decl.match(new RegExp(`(?:^|;)${prop}:(\\d+)px`)); return m ? Number(m[1]) : null; };

/** Arma la página de ejecuciones con una sola ejecución que arranca en `inicio` y devuelve el detalle que dibuja el cliente. */
function detalleDe(inicio, tz, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-site-layout-'));
  try {
    const runs = path.join(dir, 'runs');
    fs.mkdirSync(runs);
    const sid = 'bbbbbbbb-0000-4000-8000-000000000001';
    fs.writeFileSync(path.join(runs, `${sid}.json`), JSON.stringify({ ...JSON.parse(DATOS.volcadoDeEjecucion(sid, inicio, { story: '1.4', repo: 'Producto-X/FrontEnd' })), ...extra }));
    const html = path.join(dir, 'o.html');
    const g = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'nightly', 'dashboard', 'dashboard.js'), '--view', 'runs', '--runs-dir', runs, '--output', html], { encoding: 'utf8' });
    assert.strictEqual(g.status, 0, g.stderr);
    // el cliente REAL sobre un DOM mínimo, como dashboard-runs.test.sh, con la zona horaria de quien mira
    const corredor = path.join(dir, 'c.js');
    fs.writeFileSync(corredor, `
const fs = require('fs');
const h = fs.readFileSync(process.argv[2], 'utf8');
const modelo = h.match(/<script id="modelo" type="application\\/json">([\\s\\S]*?)<\\/script>/)[1];
const scripts = [...h.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)].map((m) => m[1]);
const el = () => ({ innerHTML: '', textContent: '', value: '', checked: false, hidden: false, rows: [], dataset: {}, addEventListener() {},
  querySelectorAll: () => [], querySelector: () => el(), classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, setAttribute() {}, appendChild() {} });
const nodos = {};
global.window = global; global.location = { pathname: '/corridas', search: '', hash: '' }; global.history = { replaceState() {} };
global.document = { addEventListener() {}, querySelectorAll: () => [], createElement: () => el(), getElementById: (id) => id === 'modelo' ? { textContent: modelo } : (nodos[id] = nodos[id] || el()) };
eval(scripts[scripts.length - 1]);
process.stdout.write(window.__detalle(JSON.parse(modelo).corridas[0]));
`);
    const r = spawnSync(process.execPath, [corredor, html], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// 🔴 Falla con: el detalle con la fecha y la hora en UTC mientras la fila de la misma ejecución dice el día anterior (a las
// 21 h de Argentina ya es el día siguiente en UTC).
test('A135 Detalle_FechaYHoraDelNavegador_IgualQueLaFila', () => {
  const firmas = { estado: 'leido', ilegibles: 0, recortadas: 0, lineas: [{ cuando: '2026-11-26T00:30:00.000Z', firma: 'plan-approval', nivel: 1, via: 'click', delegada: false, quien: 'persona', pedida_por: null, razon: 'dale' }] };
  const det = detalleDe('2026-11-26T00:00:00Z', 'America/Argentina/Buenos_Aires', { firmas });
  const sub = (det.match(/<div class="mono sub">([^<]*)<\/div>/) || [])[1];
  assert.ok(sub, 'el detalle tiene su renglón de fecha');
  assert.doesNotMatch(sub, /UTC/, `la fecha del detalle no va en UTC: ${sub}`);
  const prev = process.env.TZ;
  process.env.TZ = 'America/Argentina/Buenos_Aires';
  try {
    const d = new Date('2026-11-26T00:00:00Z');
    const dia = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
    assert.ok(sub.startsWith(`${dia} 21:00`), `el día y la hora locales, con el formato de la columna de la tabla («${dia} 21:00»): ${sub}`);
    // la hora de cada firma, también la del navegador
    const firmasHtml = (det.match(/<ul class="nopaso firmas">([\s\S]*?)<\/ul>/) || [])[1] || '';
    assert.match(firmasHtml, /<span class="np-t">21:30<\/span>/, `la firma de las 00:30 UTC dice 21:30: ${firmasHtml.slice(0, 200)}`);
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
});

// 🔴 Falla con: las ejecuciones del demo en /home/dev/acme/…, una carpeta que el código toma como de laboratorio: el
// filtro marcaba «(laboratorio)» los tres productos.
test('A136 Demo_EjecucionesDeProductos_NoDeLaboratorio', () => {
  const blobs = DATOS.blobsDelBuzon(Date.parse('2026-11-27T23:00:00Z'), { completo: true });
  const volcados = Object.entries(blobs).filter(([k]) => /^mac-[^/]+\/[0-9a-f-]+\.json$/.test(k)).map(([, v]) => JSON.parse(v));
  assert.ok(volcados.length >= 3, 'el demo trae sus ejecuciones');
  for (const v of volcados) assert.strictEqual(esLaboratorio(v.marker.repoPath), false, `${v.marker.repoPath} es de laboratorio`);
});

// 🔴 Falla con: el grupo del filtro que dice sólo «laboratorio», una palabra que la página no explica en ninguna parte.
test('A136b Filtro_ElGrupoLaboratorioDiceQueEs', () => {
  const T = require(path.join(RAIZ, 'scripts', 'nightly', 'dashboard', 'runs-texts.js'));
  const todos = JSON.stringify(T);
  assert.match(todos, /"corridas\.c\.laboratorioGrupo":\{"es":"laboratorio: [^"]+","en":"lab: [^"]+"\}/, 'el texto del grupo explica qué es el laboratorio, en los dos idiomas');
  assert.match(fs.readFileSync(RUNS, 'utf8'), /g === 'laboratorio' \? T\('laboratorioGrupo'\)/, 'el grupo del desplegable usa ese texto');
});

// 🔴 Falla con: las columnas de la tabla con sus anchos de antes. Medido en el sitio a 1280 px (962 px de contenido): la
// tabla pedía 1126 px y CONTROLES quedaba afuera. «Pasos» sin cortar ocupaba 179 px; con estos mínimos entra en 962.
test('A137 Tabla_EntraEnElAnchoDelSitioA1280', () => {
  const t = fs.readFileSync(RUNS, 'utf8');
  const pasos = regla(t, 'td.pasos-n');
  assert.doesNotMatch(pasos, /white-space:nowrap/, '«Pasos» se corta en dos renglones');
  assert.ok(px(regla(t, 'td.story'), 'min-width') <= 130, 'la historia, 130 px como mucho');
  assert.ok(px(regla(t, 'td.barra'), 'min-width') <= 60, 'tiempo por paso, 60 px como mucho');
  assert.ok(px(regla(t, 'td.frenos'), 'min-width') <= 110, 'controles, 110 px como mucho');
  assert.match(t, /\.tabla th\{padding:8px 5px;/, 'las celdas, con 5 px a cada lado');
  assert.match(t, /\.tabla td\{padding:7px 5px\}/, 'las celdas, con 5 px a cada lado');
});

// 🔴 Falla con: el detalle con el ancho de la ventana (`100vw - 60px`): en el sitio la tabla mide 962 px a 1280 y el
// detalle, 1124; quedaba cortado a la derecha sin aviso.
test('A138 Detalle_AnchoDeLaCajaDeLaTabla', () => {
  const t = fs.readFileSync(RUNS, 'utf8');
  assert.match(regla(t, '.tabla'), /container-type:inline-size/, 'la caja de la tabla es la medida del detalle');
  const det = regla(t, '.det');
  const anchos = det.match(/(?:^|;)width:[^;]+/g) || [];
  assert.match(anchos[anchos.length - 1] || '', /width:100cqw$/, 'el detalle mide lo que se ve de la tabla (la última declaración gana)');
  // un navegador sin cqw descarta esa declaración y se queda con la anterior, el ancho de la ventana
  assert.ok(anchos.length === 2 && /100vw/.test(anchos[0]), 'con el ancho de la ventana como respaldo, antes');
});

// 🔴 Falla con: la hoja del sitio que achica todo gráfico de Ejecuciones a su caja (`min-width:0 !important`): en el
// celular la línea de tiempo quedaba en 302 px y no se leía. Va a su ancho y se desliza dentro de su caja (.tl).
test('A139 Sitio_LineaDeTiempoConSuAnchoMinimo', () => {
  const css = fs.readFileSync(SITE_CSS, 'utf8');
  const general = css.indexOf('.shell .corridas svg{min-width:0 !important');
  const tl = css.indexOf('.shell .corridas .tl svg{');
  assert.ok(general >= 0 && tl > general, 'la excepción va después de la regla general');
  const decl = css.slice(tl, css.indexOf('}', tl));
  assert.match(decl, /min-width:760px !important/, 'la línea de tiempo con su ancho mínimo');
  assert.match(decl, /max-width:none/, 'sin el tope de su caja: se desliza en ella');
  assert.match(fs.readFileSync(RUNS, 'utf8'), /\.tl\{[^}]*overflow-x:auto/, 'la caja de la línea de tiempo se desliza');
});
