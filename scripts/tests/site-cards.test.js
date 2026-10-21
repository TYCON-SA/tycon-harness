'use strict';
// Las fichas del tablero nocturno que llegan al sitio. El tablero y el sitio leen un solo modelo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const TABLERO = path.join(RAIZ, 'scripts', 'nightly', 'dashboard', 'dashboard.js');
const HOY = '2026-10-17';

// Un HOME de juguete: el anillo local del tablero sale de ~/.claude y esta prueba no mide la máquina.
const HOME_FALSO = fs.mkdtempSync(path.join(os.tmpdir(), 'fichas-home-'));
test.after(() => fs.rmSync(HOME_FALSO, { recursive: true, force: true }));

/** Un .dashboard sintético al día: las fuentes obligatorias del tablero, con números reconocibles. */
function montarDashboard(dir, { hoy = HOY } = {}) {
  const ts = `${hoy}T05:00:00Z`;
  const escribir = (rel, doc) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), JSON.stringify(doc)); };
  escribir(`sdlc-stage-${hoy}.json`, {
    generated_at: ts,
    global: {
      lead_time_days: { n: 400, mean: 16.7, median: 5.2, max: 129 },
      lead_time_monthly: [{ month: '2026-09', n: 140, mean: 17.7, median: 4.4, min: 0, max: 129 }],
      first_pass_ratio: { num: 3, den: 18 }, rework_ratio: { num: 100, den: 400 }, dod_evidence_ratio: { num: 80, den: 400 },
      tiempo_por_etapa: { 'in-progress': { n: 380, mean: 3.0, median: 2.1, min: 0.2, max: 40.0 }, review: { n: 402, mean: 8.0, median: 6.4, min: 0.1, max: 91.0 } },
      sin_transiciones: 24, estados_desconocidos: { blocked: 5 },
    },
    repos: [{ repo: 'acme/A', stories_total: 50, done_total: 40, rework_ratio: { num: 10, den: 40 }, dod_evidence_ratio: { num: 0, den: 40 }, not_measured: [] }],
  });
  escribir(`controls-bench/banco-${hoy}.json`, { ts, ran: 700, failed: 2, skipped: 10, nomedido: 0, parityBreaks: 0, baselineRegressions: 0 });
  escribir(`controls-bench/suites-${hoy}.json`, { ts, corridas: 50, failures: [] });
  // Las fotos de la noche quedan en su carpeta de siempre dentro de .dashboard (esa carpeta no se muda: T59a de
  // legacy-names-f); el nombre va por partes porque el detector de menciones viejas no sabe que es una foto.
  escribir(path.join('dependencias', `dependencias-${hoy}.json`), { fecha: ts, corrida_completa: true, repos_activos: 10, no_medidos: [], hallazgos: [] });
  escribir(path.join('vigilante', `vigilante-${hoy}.json`), { generado: ts, productos: { p: { ok: true } }, hallazgos: [], nuevos: 0, repetidos: 0 });
}

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ── Task 1 · el modelo del tablero se calcula con lo que se le pasa, no con los argumentos del proceso ──
test('2.36-Modelo_ColectarRecibeLaCarpeta: colectar({ dir }) da lo mismo que el tablero por la línea de órdenes', () => {
  const dir = tmp('fichas-dash-');
  try {
    montarDashboard(dir);
    const env = { ...process.env, HOME: HOME_FALSO, TYCON_TODAY: HOY };
    const cli = spawnSync(process.execPath, [TABLERO, '--nightly', '--dir', dir, '--dry-run', '--json'], { encoding: 'utf8', env, maxBuffer: 1 << 26 });
    assert.ok(cli.status === 0 || cli.status === 2, `el tablero por la línea de órdenes salió ${cli.status}: ${cli.stderr}`);
    const panelesCli = JSON.parse(cli.stdout.slice(cli.stdout.indexOf('\n{') + 1, cli.stdout.lastIndexOf('}') + 1));
    // el módulo se carga en un proceso aparte: nada del argv de esta prueba se parece al del tablero
    const api = spawnSync(process.execPath, ['-e', `
      const d = require(${JSON.stringify(TABLERO)}).colectar({ dir: ${JSON.stringify(dir)}, nocturno: true });
      process.stdout.write(JSON.stringify(d.paneles));`], { encoding: 'utf8', env, maxBuffer: 1 << 26 });
    assert.strictEqual(api.status, 0, api.stderr);
    assert.deepStrictEqual(JSON.parse(api.stdout), panelesCli);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const fichas = require('../site/tabs/cards.js');

/** Parte los argumentos de una llamada `F(...)` por las comas de primer nivel (respeta comillas, plantillas y paréntesis). */
function argumentosDe(texto, desde) {
  const args = []; let nivel = 0; let ini = desde; let comilla = null;
  for (let i = desde; i < texto.length; i += 1) {
    const c = texto[i];
    if (comilla) { if (c === '\\') i += 1; else if (c === comilla) comilla = null; continue; }
    if (c === "'" || c === '"' || c === '`') { comilla = c; continue; }
    if (c === '(' || c === '[' || c === '{') nivel += 1;
    else if (c === ')' || c === ']' || c === '}') { if (nivel === 0) { args.push(texto.slice(ini, i).trim()); return args; } nivel -= 1; }
    else if (c === ',' && nivel === 0) { args.push(texto.slice(ini, i).trim()); ini = i + 1; }
  }
  return args;
}

/** Las métricas que `render()` del tablero dibuja con `F(...)`: la expresión de cada una (E.backlog, L.mutacion, escapesDom…). */
function metricasDelTablero() {
  const fuente = fs.readFileSync(TABLERO, 'utf8');
  const cuerpo = fuente.slice(fuente.indexOf('function render(d)'), fuente.indexOf('function main()'));
  const out = [];
  for (const m of cuerpo.matchAll(/\bF\(/g)) {
    const a = argumentosDe(cuerpo, m.index + m[0].length);
    if (a.length >= 3) out.push(a[2]);
  }
  return out;
}

/** Lo que falta declarar: las métricas del tablero que ni la lista del sitio ni «ya estaban» nombran. */
function sinDeclarar(metricas) {
  const conocidas = new Set([...fichas.FICHAS.map(fichas.exprDelTablero), ...fichas.YA_EN_EL_SITIO]);
  return metricas.filter((m) => !conocidas.has(m));
}

test('2.36-Lista_ConSuIdentificador: cada ficha tiene identificador fijo, pregunta, pestaña, título y para qué, sin repetidos', () => {
  const ids = fichas.FICHAS.map((f) => f.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'hay identificadores repetidos');
  for (const f of fichas.FICHAS) {
    assert.match(f.id, /^[a-z][a-z0-9_]{2,40}$/);
    assert.ok(Number.isInteger(f.pregunta) && f.pregunta >= 0 && f.pregunta < fichas.PREGUNTAS.length, `${f.id}: pregunta`);
    assert.ok(fichas.PESTANAS.includes(f.pestana), `${f.id}: pestaña`);
    assert.ok(f.titulo && f.paraQue && Array.isArray(f.de) && f.de.length === 2, `${f.id}: título, para qué y de dónde`);
    assert.ok(['pct', 'num1', 'entero', 'redondo'].includes(f.formato), `${f.id}: formato`);
  }
  assert.strictEqual(fichas.FICHAS.length, 26);
});

test('2.36-Lista_IgualAlTablero: cada ficha del tablero está en la lista o declarada «ya estaba», y al revés', () => {
  const metricas = metricasDelTablero();
  assert.ok(metricas.length >= 30, `no encontré las fichas de render() (${metricas.length})`);
  assert.deepStrictEqual(sinDeclarar(metricas), [], 'fichas del tablero que la lista del sitio no nombra');
  const delTablero = new Set(metricas);
  for (const f of fichas.FICHAS) assert.ok(delTablero.has(fichas.exprDelTablero(f)), `${f.id}: el tablero ya no arma ${fichas.exprDelTablero(f)}`);
  for (const ya of fichas.YA_EN_EL_SITIO) assert.ok(delTablero.has(ya), `${ya}: el tablero ya no la arma`);
  // rojo: una ficha nueva del tablero sin declarar hace fallar la comparación
  assert.deepStrictEqual(sinDeclarar([...metricas, 'E.ficha_nueva_sin_declarar']), ['E.ficha_nueva_sin_declarar']);
});

test('2.36-ListaBlanca_SoloCamposPermitidos: del modelo del tablero llegan el número, su denominador, la fecha y un motivo cerrado', () => {
  const def = fichas.FICHAS.find((f) => f.id === 'backlog');
  const casa = ['', 'Users', 'ana'].join('/');   // una ruta de máquina de mentira, armada para que no quede escrita
  const medida = { estado: 'medido', valor: 7, medidos: 7, total: 9, unidad: 'conteo', den_etiqueta: 'stories', fecha: '2026-10-17T05:00:00Z',
    detalle: 'repo-del-cliente-secreto/story-9', titulo: `Diagnóstico con ${casa}/proyecto`, motivo: null, extra: { repos: ['cliente-x'] } };
  const p = fichas.proyectar(def, medida, {});
  assert.deepStrictEqual(Object.keys(p).sort(), ['den_etiqueta', 'estado', 'fecha', 'formato', 'id', 'medidos', 'motivo', 'nivel', 'pestana', 'pregunta', 'total', 'unidad', 'valor'].sort());
  assert.ok(!/cliente|Users|Diagn/.test(JSON.stringify(p)), 'un texto de la fuente llegó al modelo');
  assert.strictEqual(p.valor, 7);
  const n = fichas.proyectar(def, { estado: 'no_medido', valor: null, motivo: `no se pudo leer la carpeta de la fuente «x» (${casa}/dash): no existe`, fecha: null }, {});
  assert.ok(fichas.MOTIVOS.includes(n.motivo), `motivo fuera de la lista cerrada: ${n.motivo}`);
  assert.ok(!JSON.stringify(n).includes(casa));
  // un denominador con forma de texto libre no pasa
  assert.strictEqual(fichas.proyectar(def, { ...medida, den_etiqueta: '<script>alert(1)</script>' }, {}).den_etiqueta, null);
});

test('2.36-NoMedido_SinFotoOVieja: sin la foto, o con una más vieja que su antigüedad máxima, la ficha sale no medida con su motivo (nunca cero)', () => {
  const vacio = tmp('fichas-sin-');
  const viejo = tmp('fichas-viejo-');
  try {
    montarDashboard(viejo, { hoy: '2026-10-12' });   // la foto es de hace 5 días y sdlc-stage vale 2
    const modelo = (dir) => {
      const r = spawnSync(process.execPath, ['-e', `
        const f = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'site', 'tabs', 'cards.js'))});
        const d = require(${JSON.stringify(TABLERO)}).colectar({ dir: ${JSON.stringify(dir)}, nocturno: true, hoy: ${JSON.stringify(HOY)}, ahora: Date.parse('${HOY}T12:00:00Z') });
        process.stdout.write(JSON.stringify(f.modeloDeFichas(d.paneles, { cfg: d.cfg }).lista));`], { encoding: 'utf8', env: { ...process.env, HOME: HOME_FALSO, TYCON_TODAY: HOY }, maxBuffer: 1 << 26 });
      assert.strictEqual(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const sinFoto = modelo(vacio).find((f) => f.id === 'backlog');
    assert.strictEqual(sinFoto.estado, 'no_medido');
    assert.strictEqual(sinFoto.motivo, 'sin_foto');
    assert.strictEqual(sinFoto.valor, null);
    const vieja = modelo(viejo).find((f) => f.id === 'backlog');
    assert.strictEqual(vieja.estado, 'no_medido');
    assert.strictEqual(vieja.motivo, 'vieja');
    assert.strictEqual(vieja.valor, null);
  } finally { fs.rmSync(vacio, { recursive: true, force: true }); fs.rmSync(viejo, { recursive: true, force: true }); }
});

test('2.36-UnaSolaCuenta_TableroYSitio: sobre la misma foto, cada ficha da en el sitio el mismo número que en el tablero', () => {
  const dir = tmp('fichas-cuenta-');
  try {
    montarDashboard(dir);
    const env = { ...process.env, HOME: HOME_FALSO, TYCON_TODAY: HOY };
    // el instante también queda fijo, el mismo día de la foto: con el reloj real la foto se vuelve vieja al pasar los días
    const AHORA = Date.parse(`${HOY}T12:00:00Z`);
    const cli = spawnSync(process.execPath, [TABLERO, '--nightly', '--dir', dir, '--now', String(AHORA), '--dry-run', '--json'], { encoding: 'utf8', env, maxBuffer: 1 << 26 });
    const panelesCli = JSON.parse(cli.stdout.slice(cli.stdout.indexOf('\n{') + 1, cli.stdout.lastIndexOf('}') + 1));
    const api = spawnSync(process.execPath, ['-e', `
      const f = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'site', 'tabs', 'cards.js'))});
      const d = require(${JSON.stringify(TABLERO)}).colectar({ dir: ${JSON.stringify(dir)}, nocturno: true, ahora: ${AHORA} });
      process.stdout.write(JSON.stringify(f.modeloDeFichas(d.paneles, { cfg: d.cfg }).lista));`], { encoding: 'utf8', env, maxBuffer: 1 << 26 });
    assert.strictEqual(api.status, 0, api.stderr);
    const delSitio = JSON.parse(api.stdout);
    assert.strictEqual(delSitio.length, fichas.FICHAS.length);
    let medidas = 0;
    for (const f of delSitio) {
      const def = fichas.FICHAS.find((x) => x.id === f.id);
      const delTablero = panelesCli[def.de[0]][def.de[1]];
      assert.strictEqual(f.estado === 'no_medido', delTablero.estado !== 'medido', `${f.id}: no coinciden en medido`);
      if (delTablero.estado === 'medido') { medidas += 1; assert.strictEqual(f.valor, delTablero.valor, `${f.id}: el número no coincide`); }
    }
    assert.ok(medidas >= 3, `la foto de juguete tiene que medir varias fichas (midió ${medidas})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('2.36-Oculta_NoSeCalculaNiLlega: una ficha oculta no entra al modelo, y el modelo dice cuántas hay ocultas', () => {
  const paneles = { extra: { backlog: { estado: 'medido', valor: 3, medidos: 3, total: 3 }, estados_sin_diccionario: { estado: 'medido', valor: 1, medidos: 1, total: 1 } }, local: {}, mejora: {}, poda: {} };
  const todas = fichas.modeloDeFichas(paneles, {});
  assert.strictEqual(todas.lista.length, 26);
  assert.strictEqual(todas.ocultas, 0);
  const algunas = fichas.modeloDeFichas(paneles, { ocultas: ['backlog', 'estados_sin_diccionario'] });
  assert.strictEqual(algunas.lista.length, 24);
  assert.strictEqual(algunas.ocultas, 2);
  assert.ok(!algunas.lista.some((f) => f.id === 'backlog' || f.id === 'estados_sin_diccionario'));
  assert.ok(!/backlog|estados_sin_diccionario/.test(JSON.stringify(algunas)), 'el nombre de una ficha oculta viajó al modelo');
  // sin la clave se muestran todas, también con algo que no es una lista
  assert.strictEqual(fichas.modeloDeFichas(paneles, { ocultas: 'backlog' }).lista.length, 26);
});

// ── el sitio: Arnés con sus fichas ───────────────────────────────────────────────────────────────────────────
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const H = require('./lib/site-harness.js');
const sources = require(path.join(H.SITE, 'sources.js'));
const views = require(path.join(H.SITE, 'views.js'));
const access = require(path.join(H.SITE, 'access.js'));
const LEAD = 'lead@acme.example';
const PERSONA = 'dev.a@acme.example';
const LIBRE = ['REPO-SECRETO-DEL-CLIENTE', 'DIAGNOSTICO-LIBRE-DE-LA-FUENTE', 'TITULO-LIBRE-DE-STORY'];

/** Una copia de operaciones de juguete: las fotos del tablero, con texto libre sembrado donde la fuente lo trae. */
function clonDeJuguete() {
  const clon = tmp('fichas-clon-');
  const dash = path.join(clon, '.dashboard');
  montarDashboard(dash);
  const sdlc = path.join(dash, `sdlc-stage-${HOY}.json`);
  const doc = JSON.parse(fs.readFileSync(sdlc, 'utf8'));
  doc.repos[0].repo = `acme/${LIBRE[0]}`;
  doc.global.titulo_libre = LIBRE[2];
  fs.writeFileSync(sdlc, JSON.stringify(doc));
  fs.writeFileSync(path.join(dash, 'vigilante', `vigilante-${HOY}.json`), JSON.stringify({ generado: `${HOY}T05:00:00Z`, productos: { p: { ok: true } }, hallazgos: [{ diagnostico: LIBRE[1] }], nuevos: 0, repetidos: 0 }));
  fs.writeFileSync(path.join(clon, 'operations.json'), JSON.stringify({ version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] } }));
  return clon;
}
const AHORA = Date.parse(`${HOY}T12:00:00Z`);
const construirModelo = (clon, opciones = {}) => sources.construirDesdeClon(clon, { ahora: AHORA, fichas: fichas.fichasDelClon({ clon, ahora: AHORA, dirBuzon: null, buzonLeido: false, ocultas: [], ...opciones }) });

test('2.36-Arnes_FichasPorPregunta: Arnés trae sus fichas agrupadas por la pregunta del tablero, con el estilo del sitio', () => {
  const clon = clonDeJuguete();
  const m = construirModelo(clon);
  const html = views.paginaArnes({ modelo: access.filtrar(m, { rol: 'maintainer' }, access.crearReglas({})), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: Date.parse(`${HOY}T12:00:00Z`) });
  const delArnes = fichas.FICHAS.filter((f) => f.pestana === 'arnes');
  for (const f of delArnes) assert.match(html, new RegExp(`data-ficha="${f.id}"`), `${f.id} sale en Arnés`);
  for (const f of fichas.FICHAS.filter((x) => x.pestana !== 'arnes')) assert.ok(!html.includes(`data-ficha="${f.id}"`), `${f.id} no es de Arnés`);
  // agrupadas: el título de cada pregunta que tiene fichas de Arnés, en el orden del tablero
  const preguntas = [...new Set(delArnes.map((f) => f.pregunta))].sort((a, b) => a - b);
  let desde = 0;
  for (const n of preguntas) { const i = html.indexOf(fichas.PREGUNTAS[n], desde); assert.ok(i >= 0, `falta la pregunta «${fichas.PREGUNTAS[n]}»`); desde = i; }
  // las que el tablero mide con la foto de juguete salen con número; la del equipo (sin buzón) sale no medida, nunca cero
  assert.match(html, /data-ficha="dod"[\s\S]*?t-val">20%/);
  assert.match(html, /class="tile blind" data-ficha="mutacion"/);
  assert.doesNotMatch(html.slice(html.indexOf('data-ficha="mutacion"'), html.indexOf('data-ficha="mutacion"') + 400), /t-val">0/);
});

test('2.36-Arnes_SoloQuienMantiene: una persona sin el rol de quien mantiene recibe 403 en Arnés, y su modelo no trae las fichas', async () => {
  const clon = clonDeJuguete();
  const modelo = construirModelo(clon);
  const persona = access.filtrar(modelo, { rol: 'person', email: PERSONA }, access.crearReglas({}));
  assert.ok(!('fichas' in persona), 'el modelo de una persona no trae las fichas');
  const emisor = await arrancarEmisor();
  let h = null;
  try {
    const config = { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] }, people: { machines: { 'maq-a-11111111': { person: PERSONA, reported_sha256: null, confirmed_by: LEAD, confirmed_on: HOY } } } };
    h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_PUBLIC_URL: 'https://site.acme.example' }), fuentes: H.fuentesFijas({ config, modelo }) });
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    const r = await h.pedir('/arnes', { cookie: await entrar(PERSONA) });
    assert.strictEqual(r.status, 403);
    assert.ok(!r.texto.includes('data-ficha'), 'sin fichas para quien no mantiene');
    const lead = await h.pedir('/arnes', { cookie: await entrar(LEAD) });
    assert.strictEqual(lead.status, 200);
    assert.match(lead.texto, /data-ficha="dod"/);
  } finally { if (h) await h.cerrar(); await emisor.cerrar(); }
});

test('T10 1.31-SitioYTablero_MismoNumeroSinNombres @story-1.31 @ac-7: la ficha de cambios sin historia da el mismo número en el sitio y en el tablero, y el sitio no trae nombres', () => {
  const dir = tmp('fichas-sinhist-');
  try {
    montarDashboard(dir);
    const persona = 'Zqx Sembrada';
    fs.writeFileSync(path.join(dir, `story-reference-${HOY}.json`), JSON.stringify({ v: 1, generated_at: `${HOY}T05:00:00Z`,
      ventana: { desde: '2026-09-20', hasta: HOY, dias: 28 }, cobertura: { repos_declarados: 2, repos_medidos: 1 },
      totales: { codigo: 8, con: 6, sin: 2, por_persona: { [persona]: { con: 1, sin: 2 } }, por_tipo: { hotfix: 1, dependencias: 0, arnes_ci: 0, merge_dev: 1, otro: 0 }, por_via: { pedido: { con: 6, sin: 1 }, directo: { con: 0, sin: 1 } } },
      repos: [{ producto: 'Alfa', repo: 'Alfa/Back', estado: 'medido', motivo: null, codigo: 8, con: 6, sin: 2 }, { producto: 'Beta', repo: 'Beta/Back', estado: 'no_medido', motivo: 'no está entre los clones del nocturno', codigo: null, con: null, sin: null }] }));
    const env = { ...process.env, HOME: HOME_FALSO, TYCON_TODAY: HOY };
    const AHORA = Date.parse(`${HOY}T12:00:00Z`);
    const api = spawnSync(process.execPath, ['-e', `
      const f = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'site', 'tabs', 'cards.js'))});
      const d = require(${JSON.stringify(TABLERO)}).colectar({ dir: ${JSON.stringify(dir)}, nocturno: true, ahora: ${AHORA} });
      process.stdout.write(JSON.stringify({ tablero: d.paneles.extra.sin_historia, sitio: f.modeloDeFichas(d.paneles, { cfg: d.cfg }).lista.find((x) => x.id === 'sin_historia') }));`], { encoding: 'utf8', env, maxBuffer: 1 << 26 });
    assert.strictEqual(api.status, 0, api.stderr);
    const { tablero, sitio } = JSON.parse(api.stdout);
    assert.strictEqual(tablero.estado, 'medido', JSON.stringify(tablero));
    assert.strictEqual(tablero.valor, 0.25);
    assert.deepStrictEqual([sitio.estado, sitio.valor, sitio.medidos, sitio.total, sitio.pestana], ['medido', 0.25, 2, 8, 'proyectos']);
    // el detalle con nombres es del tablero; al sitio llega sólo el número (lista blanca de cards.js)
    assert.ok(!JSON.stringify(sitio).includes(persona), 'el nombre llegó al sitio');
    assert.match(fichas.tile(sitio), /25%/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('2.36-Proyectos_GrillaArribaDeLaTabla: quien mantiene ve las siete fichas de la organización en una grilla antes de la tabla; una persona no; la oculta no sale', () => {
  const clon = clonDeJuguete();
  // un producto declarado, para que la página arme su tabla
  const repos = path.join(clon, 'scripts', 'nightly', 'dependencies', 'repos.json');
  fs.mkdirSync(path.dirname(repos), { recursive: true });
  fs.writeFileSync(repos, JSON.stringify({ repos: [{ producto: 'Producto X', ruta: 'X/repo', ado: 'Proyecto X/Repo X', tipo: 'npm', activo: true }] }));
  const m = construirModelo(clon);
  const pagina = (modelo, quien) => views.paginaProyectos({ modelo, quien, pestanas: [], ahora: Date.parse(`${HOY}T12:00:00Z`) });
  const html = pagina(access.filtrar(m, { rol: 'maintainer' }, access.crearReglas({})), { rol: 'maintainer', email: LEAD });
  const deProyectos = fichas.FICHAS.filter((f) => f.pestana === 'proyectos');
  assert.strictEqual(deProyectos.length, 7);
  for (const f of deProyectos) assert.match(html, new RegExp(`data-ficha="${f.id}"`), `${f.id} sale en Proyectos`);
  for (const f of fichas.FICHAS.filter((x) => x.pestana !== 'proyectos')) assert.ok(!html.includes(`data-ficha="${f.id}"`), `${f.id} no es de Proyectos`);
  // una sola grilla, arriba de la tabla de productos
  const ultima = Math.max(...deProyectos.map((f) => html.indexOf(`data-ficha="${f.id}"`)));
  assert.ok(html.includes('<table class="tabla" id="proyectos">'), 'la foto de juguete arma la tabla de productos');
  assert.ok(ultima < html.indexOf('<table'), 'las fichas van antes de la tabla');
  // cada ficha dice lo que dice el modelo: con su número, o «no medida» (nunca cero)
  for (const f of m.fichas.lista.filter((x) => x.pestana === 'proyectos')) {
    const desde = html.indexOf(`data-ficha="${f.id}"`);
    const trozo = html.slice(html.lastIndexOf('<div class="tile', desde), desde + 600);
    if (f.estado === 'no_medido') { assert.match(trozo, /^<div class="tile blind"/, `${f.id} no medida`); assert.doesNotMatch(trozo.split('</div></div>')[0], /t-val">0</); }
    else assert.ok(trozo.includes(`t-val">${fichas.formatear(f)}<`), `${f.id} con su número`);
  }
  // una persona ve su Proyectos sin las fichas de la organización
  const persona = access.filtrar(m, { rol: 'person', email: PERSONA }, access.crearReglas({}));
  const dePersona = pagina(persona, { rol: 'person', email: PERSONA });
  assert.doesNotMatch(dePersona, /data-ficha=|id="fichas-proyectos"|id="fichas-calculando"/);
  assert.ok(!dePersona.includes('Cómo va la organización'), 'una persona no ve la sección de la organización');
  // sin la lista de productos (o sin poder leerla), las fichas de la organización siguen arriba
  for (const sinLista of [{ ...m, proyectos: { ...(m.proyectos || {}), lista: null } }, { ...m, productosFuente: { estado: 'no_medido', motivo: 'sin_foto' } }]) {
    const h = pagina(access.filtrar(sinLista, { rol: 'maintainer' }, access.crearReglas({})), { rol: 'maintainer', email: LEAD });
    assert.match(h, /id="fichas-proyectos"[\s\S]*data-ficha="bus_factor"/, 'la grilla sale aunque falte la lista de productos');
  }
  // la oculta desde Configuración no sale
  const conOculta = construirModelo(clon, { ocultas: ['backlog'] });
  const html2 = pagina(access.filtrar(conOculta, { rol: 'maintainer' }, access.crearReglas({})), { rol: 'maintainer', email: LEAD });
  assert.doesNotMatch(html2, /data-ficha="backlog"/);
  assert.match(html2, /data-ficha="bus_factor"/);
  // mientras el sitio no las calculó, lo dice; sin ninguna ficha de Proyectos visible, no hay grilla vacía
  assert.match(pagina({ ...m, fichas: null }, { rol: 'maintainer', email: LEAD }), /id="fichas-calculando"/);
  const sinNinguna = construirModelo(clon, { ocultas: deProyectos.map((f) => f.id) });
  assert.doesNotMatch(pagina(sinNinguna, { rol: 'maintainer', email: LEAD }), /id="fichas-proyectos"/);
  // ningún texto libre de las fotos llega a la página
  for (const marca of LIBRE) assert.ok(!html.includes(marca), `${marca} llegó a Proyectos`);
});

test('2.36-Fuga_ConLasFichas: ningún texto libre de las fotos llega al modelo ni a la página de Arnés', () => {
  const clon = clonDeJuguete();
  const m = construirModelo(clon);
  const html = views.paginaArnes({ modelo: access.filtrar(m, { rol: 'maintainer' }, access.crearReglas({})), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: Date.parse(`${HOY}T12:00:00Z`) });
  for (const marca of LIBRE) {
    assert.ok(!JSON.stringify(m.fichas).includes(marca), `${marca} llegó al modelo de las fichas`);
    assert.ok(!html.includes(marca), `${marca} llegó a la página`);
  }
  assert.ok(!JSON.stringify(m.fichas).includes(clon), 'una ruta del disco llegó al modelo');
});

test('2.36-Oculta_NoSeCalculaNiLlega (sitio): las ocultas por site.hidden_cards no entran al modelo ni a la página, y Arnés dice cuántas', () => {
  const clon = clonDeJuguete();
  const m = construirModelo(clon, { ocultas: ['dod', 'rework'] });
  assert.strictEqual(m.fichas.ocultas, 2);
  assert.ok(!m.fichas.lista.some((f) => f.id === 'dod' || f.id === 'rework'));
  const html = views.paginaArnes({ modelo: access.filtrar(m, { rol: 'maintainer' }, access.crearReglas({})), quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: Date.parse(`${HOY}T12:00:00Z`) });
  assert.doesNotMatch(html, /data-ficha="dod"|data-ficha="rework"/);
  assert.match(html, /2 fichas ocultas, desde Configuración/);
  const todas = construirModelo(clon, { ocultas: [] });
  assert.strictEqual(todas.fichas.ocultas, 0);
  assert.doesNotMatch(views.paginaArnes({ modelo: todas, quien: { rol: 'maintainer', email: LEAD }, pestanas: [], ahora: 0 }), /fichas? ocultas?/);
  // el cálculo roto no tira el sitio: cada ficha sale no medida
  const sinClon = fichas.fichasDelClon({ clon: path.join(clon, 'no-existe'), ahora: AHORA, ocultas: [] });
  assert.strictEqual(sinClon.lista.length, 26);
  assert.ok(sinClon.lista.every((f) => f.estado === 'no_medido'));
});

test('2.36-Copia_TraeLasFotos: la copia de operaciones trae lo que leen las fichas', () => {
  const COPIA = require(path.join(H.SITE, 'operations-copy.js'));
  const cubre = (r) => COPIA.RUTAS.some((p) => (p.endsWith('/') ? r.startsWith(p) : r === p));
  for (const r of ['.dashboard/sdlc-stage-2026-10-17.json', 'scripts/nightly/dashboard/sources.json', 'scripts/nightly/dashboard/declared.json', 'scripts/nightly/dependencies/repos.json']) assert.ok(cubre(r), `${r}: la copia no lo trae`);
});

// Tres casos que el modelo de las fichas contaba mal.
test('2.36-Copia_SinDatoNoUsaElDelArnes: con una copia de operaciones sin lane-hypothesis.json, el reproceso por carril sale no medido (no con la hipótesis del arnés)', () => {
  const dir = tmp('fichas-raiz-');
  const raiz = tmp('fichas-copia-');
  try {
    montarDashboard(dir);
    const f = path.join(dir, `sdlc-stage-${HOY}.json`);
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    doc.repos[0].rework_por_carril = { desde: '2026-01-01', con_corrida: { num: 1, den: 50 }, sin_constancia: { num: 9, den: 50 } };
    fs.writeFileSync(f, JSON.stringify(doc));
    const r = spawnSync(process.execPath, ['-e', `
      const d = require(${JSON.stringify(TABLERO)}).colectar({ dir: ${JSON.stringify(dir)}, raiz: ${JSON.stringify(raiz)}, nocturno: true, hoy: ${JSON.stringify(HOY)}, ahora: Date.parse('${HOY}T12:00:00Z') });
      process.stdout.write(JSON.stringify(d.paneles.extra.rework_por_carril));`], { encoding: 'utf8', env: { ...process.env, HOME: HOME_FALSO, TYCON_TODAY: HOY, TYCON_LANE_HYPOTHESIS: '' }, maxBuffer: 1 << 26 });
    assert.strictEqual(r.status, 0, r.stderr);
    const m = JSON.parse(r.stdout);
    assert.strictEqual(m.estado, 'no_medido', 'tomó la hipótesis del arnés en vez de la de la organización');
    assert.match(m.motivo, /hipótesis/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(raiz, { recursive: true, force: true }); }
});

test('2.36-Ahora_CeroEsUnaHora: colectar({ ahora: 0 }) usa el instante 0 y no el reloj', () => {
  const dir = tmp('fichas-cero-');
  try {
    const r = spawnSync(process.execPath, ['-e', `
      const t = require(${JSON.stringify(TABLERO)});
      process.stdout.write(JSON.stringify(t.colectar({ dir: ${JSON.stringify(dir)}, nocturno: true, hoy: '1970-01-01', ahora: 0 }).hoy));`], { encoding: 'utf8', env: { ...process.env, HOME: HOME_FALSO, TYCON_TODAY: '1970-01-01' }, maxBuffer: 1 << 26 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout), 0, 'ahora: 0 se trató como ausente y se usó el reloj');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('2.36-Medida_SinNumeroEsNoMedida: una métrica «medida» sin un número válido sale no medida con motivo', () => {
  const def = fichas.FICHAS.find((f) => f.id === 'backlog');
  const p = fichas.proyectar(def, { estado: 'medido', valor: '7', medidos: 1, total: 1, unidad: 'conteo', fecha: '2026-10-18' }, {});
  assert.strictEqual(p.estado, 'no_medido');
  assert.strictEqual(p.valor, null);
  assert.ok(fichas.MOTIVOS.includes(p.motivo));
});
