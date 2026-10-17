'use strict';
// site-mailbox-summaries.test.js — el sitio de la organización con las conversaciones prendidas
// (`site.mailbox.threads: true`) sobre un disco chico: la bajada pasa por tandas con un tope de bytes, cada conversación
// se resume una vez y se borra del disco, el espejo poda lo que ya no está en el buzón, y el detalle de una corrida
// se baja a demanda a un caché con tope, fuera del disco del sitio.
//
// Sin red: el buzón es un servidor local (tests/lib/site-harness.js → arrancarBuzon).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const H = require('./lib/site-harness.js');
const { arrancarRepoHttp, repoConArchivos, hayHttpBackend } = require('./lib/git-http-server.js');
const { bajar } = require(path.join(ROOT, 'scripts', 'metrics', 'download-runs.js'));
const runs = require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'runs.js'));
const { crearFuentes } = require(path.join(H.SITE, 'sources.js'));
const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
const SIN_BACKEND = !hayHttpBackend() && !process.env.CI && 'git http-backend no está en esta máquina: el repo por HTTP no se puede armar';
const TOKEN = `tok-${crypto.randomBytes(6).toString('hex')}`;
const CABECERA = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const gz = (s) => zlib.gzipSync(Buffer.from(s));
const iso = (t0, min) => new Date(Date.parse(t0) + min * 60000).toISOString();
const md5 = (b) => crypto.createHash('md5').update(b).digest('base64');

// ── el fabricante: corridas con su volcado, su conversación y su cambio de git (la forma de site-runs.test.js) ────
function volcado(sid, inicio) {
  const m = (x) => iso(inicio, x);
  return JSON.stringify({
    archivedAt: m(125),
    marker: { storyId: '2.1', storyPath: '/Users/dev/SourceCode/Prod/specs/story-2.1-una-cosa.md', repoPath: '/Users/dev/SourceCode/Alfa/FrontEnd',
      sessionId: sid, startedAt: m(0), lastTouch: m(120), stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7, 8], stepsPending: [],
      stepTimings: { 0: { completedAt: m(1) }, 4: { completedAt: m(40) }, 8: { completedAt: m(118) } } },
  });
}
const uso = (ts, name, input) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name, input }] } });
/** Una conversación con un Edit y un commit; `relleno` la agranda con texto que no se comprime (bytes al azar en hex). */
function conversacion(inicio, n, relleno = 0) {
  const lineas = [uso(iso(inicio, 20), 'Edit', { file_path: `/Users/dev/SourceCode/Alfa/FrontEnd/src/Pago${n}.ts`, old_string: 'const viejo = 0;', new_string: `const NUEVO_${n} = 1;` }),
    JSON.stringify({ type: 'user', timestamp: iso(inicio, 50), message: { content: [{ type: 'tool_result', content: `[main abc1234] feat: el commit ${n}\n 1 file changed` }] } })];
  if (relleno) lineas.push(JSON.stringify({ type: 'user', timestamp: iso(inicio, 60), message: { content: [{ type: 'text', text: crypto.randomBytes(relleno).toString('hex') }] } }));
  return gz(lineas.join('\n') + '\n');
}
function cambioGit(inicio, n) {
  const ruta = `src/Pago${n}.ts`;
  return gz(JSON.stringify({ version: 1, estado: 'medido', motivo: null, medido_en: iso(inicio, 200), ventana: { desde: inicio, hasta: iso(inicio, 200) },
    repos: [{ nombre: 'FrontEnd', principal: true, por: ['story'], otras_sesiones: 0, sin_commitear_previo: 0, estado: 'medido',
      commits: [{ h: 'abc123456789', fecha: iso(inicio, 60), asunto: `feat: el commit ${n}`, archivos: [{ ruta, estado: 'M', mas: 1, menos: 0, binario: false, parche: `diff --git a/${ruta} b/${ruta}\n+const PARCHE_${n} = 1;\n`, cortado: 0 }] }],
      commits_de_otras_sesiones: [], sin_commitear: [] }],
    totales: { repos: 1, archivos: 1, partes: 1, cortados: 0, sin_parche_por_tope: 0 }, topes: { por_parte: 200000, por_corrida: 5242880 } }));
}
const sid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Los blobs de `n` corridas de `maq-a`; `relleno`: bytes al azar en cada conversación. */
function blobsDe(n, relleno = 0) {
  const b = {};
  for (let i = 1; i <= n; i++) {
    const ini = iso('2026-08-05T09:00:00.000Z', i * 300);
    b[`maq-a/r${i}.json`] = volcado(sid(i), ini);
    b[`maq-a/r${i}.hilo.jsonl.gz`] = conversacion(ini, i, relleno);
    b[`maq-a/r${i}.cambio.json.gz`] = cambioGit(ini, i);
  }
  return b;
}
const bajada = (buzon, dir, extra = {}) => bajar({ cuenta: 'cuentax', contenedor: 'runs', credencial: { sas: H.sas() }, urlBase: buzon.base, dir, budgetMs: 60000, ...extra });
const conversacionesEn = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(hilo\.jsonl|cambio\.json)\.gz$/.test(f)) : [];
function tamano(dir) {
  let t = 0;
  const recorrer = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) recorrer(p); else t += fs.statSync(p).size; } };
  if (fs.existsSync(dir)) recorrer(dir);
  return t;
}

test('T48 Sitio_ConConversacionesNuncaPasaDelTope @story-2.30 @ac-25', { skip: SIN_BACKEND }, async () => {
  // el sitio de verdad (sources.js), con `site.mailbox.threads: true`, sobre un buzón cuyas conversaciones no entran en
  // el tope: pasada a pasada baja una tanda, la resume y la borra. El disco nunca guarda más que el tope (más los
  // volcados y los resúmenes), y al final no queda ninguna conversación, cada corrida tiene su resumen y la bajada está entera
  const N = 8;
  const blobs = blobsDe(N, 60000);
  const largo = Buffer.from(blobs['maq-a/r1.hilo.jsonl.gz']).length + Buffer.from(blobs['maq-a/r1.cambio.json.gz']).length;
  const tope = largo * 3;
  const buzon = await H.arrancarBuzon({ blobs });
  const raiz = tmp('mbx-sitio-');
  const ops = { version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'], mailbox: { provider: 'azure-blob', account: 'cuentax', container: 'runs', threads: true } } };
  repoConArchivos(raiz, 'ops.git', H.archivosDeOperaciones({ config: ops }), path.join(raiz, 'trabajo'));
  const git = await arrancarRepoHttp({ raiz, cabecera: CABECERA });
  const datos = tmp('mbx-sitio-datos-');
  const env = H.envBase({ SITE_OPERATIONS_REPO: git.url('ops.git'), SITE_OPERATIONS_TOKEN: TOKEN, SITE_MAILBOX_SAS: H.sas(), SITE_DATA_DIR: datos });
  const v = validarConfiguracion(env);
  assert.ok(v.ok, JSON.stringify(v.problemas));
  const registro = [];
  const fuentes = crearFuentes({ cfg: v.cfg, dataDir: datos, log: (l) => registro.push(l), urlBuzon: buzon.base, topeConversacionesBytes: tope });
  try {
    let maximo = 0;
    let pasadas = 0;
    for (; pasadas < 20; pasadas++) {
      await fuentes.refrescar();
      maximo = Math.max(maximo, conversacionesEn(path.join(datos, 'buzon')).reduce((t, f) => t + fs.statSync(path.join(datos, 'buzon', f)).size, 0));
      if (fuentes.buzonEstado().completo) break;
    }
    assert.ok(fuentes.buzonEstado().completo, `la bajada terminó entera en ${pasadas + 1} pasadas: ${registro.slice(-5).join(' | ')}`);
    assert.ok(pasadas >= 2, `hizo falta más de una pasada (${pasadas + 1}): si no, el tope no se probó`);
    assert.ok(maximo <= tope, `las conversaciones en el disco nunca pasaron del tope: ${maximo} de ${tope}`);
    assert.deepStrictEqual(conversacionesEn(path.join(datos, 'buzon')), [], 'ninguna conversación quedó en el disco');
    const resumenes = fs.readdirSync(path.join(datos, 'buzon', 'maq-a')).filter((f) => f.endsWith(runs.RESUMEN.sufijo));
    assert.strictEqual(resumenes.length, N, 'cada corrida, con su resumen');
    assert.ok(registro.some((l) => /corrida\(s\) resumida\(s\)/.test(l)), 'el registro dice que resumió');
    // y con el disco del tamaño de hoy: el espejo entero (volcados y resúmenes) es chico
    // el espejo entero: los volcados, los resúmenes (unos kilos cada uno) y lo chico de la bajada; nunca una conversación
    const volcados = Object.entries(blobs).filter(([n]) => n.endsWith('.json')).reduce((t, [, b]) => t + Buffer.from(b).length, 0);
    const resumidos = resumenes.reduce((t, f) => t + fs.statSync(path.join(datos, 'buzon', 'maq-a', f)).size, 0);
    assert.ok(resumidos <= N * 4096, `cada resumen, a lo sumo 4 KB: ${resumidos} bytes entre ${N}`);
    assert.ok(tamano(path.join(datos, 'buzon')) <= volcados + resumidos + 64 * 1024, `el espejo, ${tamano(path.join(datos, 'buzon'))} bytes: volcados ${volcados}, resúmenes ${resumidos}`);
  } finally { fuentes.detener(); await git.cerrar(); await buzon.cerrar(); }
});

test('T44 Bajada_TopeDeConversacionesPorPasada @story-2.30 @ac-25', async () => {
  // con resúmenes, una pasada no baja más bytes de conversaciones que el tope: el resto queda para la siguiente, y la
  // pasada no dice «leída entera»; siempre avanza al menos una, aunque una sola pase el tope
  const blobs = blobsDe(6, 20000);
  const buzon = await H.arrancarBuzon({ blobs });
  try {
    const dir = path.join(tmp('mbx-tope-'), 'buzon');
    const largo = Buffer.from(blobs['maq-a/r1.hilo.jsonl.gz']).length;
    const r = await bajada(buzon, dir, { sinHilos: false, resumenes: true, topeBytesHilos: Math.floor(largo * 2.5) });
    assert.strictEqual(r.codigo, 0, JSON.stringify(r.res));
    const bajadas = conversacionesEn(dir).filter((f) => f.endsWith('.hilo.jsonl.gz'));
    assert.ok(bajadas.length >= 1 && bajadas.length <= 2, `entre 1 y 2 conversaciones en la pasada: ${bajadas.length}`);
    assert.ok(r.res.sin_tiempo > 0, 'quedaron conversaciones para la siguiente pasada');
    assert.strictEqual(r.res.completo, false, 'no dice leída entera');
    assert.ok(r.res.por_tope > 0, 'lo cuenta como tope, no como tiempo');
    // los volcados sí bajaron todos (son chicos y la tabla los necesita)
    assert.strictEqual(fs.readdirSync(path.join(dir, 'maq-a')).filter((f) => /^r\d+\.json$/.test(f)).length, 6);
    // un tope menor que una sola conversación igual avanza una por pasada
    const dir2 = path.join(tmp('mbx-tope-uno-'), 'buzon');
    const r2 = await bajada(buzon, dir2, { sinHilos: false, resumenes: true, topeBytesHilos: 10 });
    assert.strictEqual(conversacionesEn(dir2).filter((f) => f.endsWith('.hilo.jsonl.gz')).length, 1, 'una por pasada');
    assert.ok(r2.res.sin_tiempo > 0);
  } finally { await buzon.cerrar(); }
});

test('T45 Bajada_SalteaLaConversacionYaResumida @story-2.30 @ac-25', async () => {
  // una corrida con su resumen (con la huella de la conversación y del cambio) no vuelve a bajar ninguno de los dos.
  // Si una de las dos cambió en el buzón (otra huella), se bajan LAS DOS: el resumen se rehace con las dos partes, y
  // rehacerlo con una sola perdería lo que traía la otra
  const blobs = blobsDe(2);
  const buzon = await H.arrancarBuzon({ blobs });
  try {
    const dir = path.join(tmp('mbx-resumida-'), 'buzon');
    fs.mkdirSync(path.join(dir, 'maq-a'), { recursive: true });
    for (const i of [1, 2]) {
      fs.writeFileSync(path.join(dir, 'maq-a', runs.RESUMEN.nombre(`r${i}.json`)), zlib.gzipSync(JSON.stringify({ v: 1,
        hilo_md5: md5(Buffer.from(blobs[`maq-a/r${i}.hilo.jsonl.gz`])), cambio_md5: i === 1 ? md5(Buffer.from(blobs[`maq-a/r${i}.cambio.json.gz`])) : 'otra-huella', cambios: { estado: 'leido' } })));
    }
    const r = await bajada(buzon, dir, { sinHilos: false, resumenes: true, topeBytesHilos: 1 << 30 });
    assert.strictEqual(r.codigo, 0, JSON.stringify(r.res));
    const pedidas = buzon.pedidos.filter((p) => !p.query.includes('comp=list')).map((p) => p.ruta);
    assert.ok(!pedidas.some((p) => /r1\.(hilo\.jsonl|cambio\.json)\.gz$/.test(p)), `r1, resumida con las dos huellas, no se pide: ${pedidas.join(' ')}`);
    assert.ok(pedidas.some((p) => /r2\.cambio\.json\.gz$/.test(p)), 'el cambio de r2, con otra huella, sí');
    assert.ok(pedidas.some((p) => /r2\.hilo\.jsonl\.gz$/.test(p)), 'y la conversación de r2 con él, aunque su huella coincida');
    assert.strictEqual(r.res.resumidos, 2, 'las dos partes de r1, salteadas por su resumen');
    assert.strictEqual(r.res.completo, true, 'leída entera: lo salteado está resumido');
  } finally { await buzon.cerrar(); }
});

test('T46 Bajada_PodaLoQueYaNoEstaEnElBuzon @story-2.30 @ac-25', async () => {
  // el espejo borra las corridas (volcado, conversación, cambio y resumen) que ya no están en el buzón; los registros de
  // una máquina y el resto del espejo no se tocan. Sólo con el listado entero
  const blobs = blobsDe(2);
  const buzon = await H.arrancarBuzon({ blobs });
  try {
    const dir = path.join(tmp('mbx-poda-'), 'buzon');
    const vieja = path.join(dir, 'maq-a');
    fs.mkdirSync(path.join(vieja, 'registros'), { recursive: true });
    for (const f of ['r9.json', 'r9.hilo.jsonl.gz', 'r9.cambio.json.gz', runs.RESUMEN.nombre('r9.json')]) fs.writeFileSync(path.join(vieja, f), 'viejo');
    fs.writeFileSync(path.join(vieja, 'registros', 'gates.jsonl.gz'), 'registro');
    fs.mkdirSync(path.join(dir, 'maq-z'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'maq-z', 'z1.json'), 'de una máquina que ya no está');
    const r = await bajada(buzon, dir, { sinHilos: false, resumenes: true, topeBytesHilos: 1 << 30, podar: true });
    assert.strictEqual(r.codigo, 0, JSON.stringify(r.res));
    for (const f of ['r9.json', 'r9.hilo.jsonl.gz', 'r9.cambio.json.gz', runs.RESUMEN.nombre('r9.json')]) assert.ok(!fs.existsSync(path.join(vieja, f)), `se podó ${f}`);
    assert.ok(!fs.existsSync(path.join(dir, 'maq-z', 'z1.json')), 'la corrida de una máquina que no está en el buzón');
    assert.ok(fs.existsSync(path.join(vieja, 'registros', 'gates.jsonl.gz')), 'los registros no se podan acá');
    assert.ok(fs.existsSync(path.join(vieja, 'r1.json')) && fs.existsSync(path.join(vieja, 'r2.json')), 'lo que está en el buzón queda');
    assert.strictEqual(r.res.podados, 5);
    // sin `podar`, nada se borra
    fs.writeFileSync(path.join(vieja, 'r8.json'), 'viejo');
    await bajada(buzon, dir, { sinHilos: false, resumenes: true, topeBytesHilos: 1 << 30 });
    assert.ok(fs.existsSync(path.join(vieja, 'r8.json')));
  } finally { await buzon.cerrar(); }
});

test('T47 Resumir_LaTablaQuedaIgualYLaConversacionSeVa @story-2.30 @ac-25', () => {
  // resumir una corrida guarda lo que la tabla saca de su conversación (la descripción, el reparto del tiempo, los
  // cambios) y borra la conversación y el cambio de git: la vista armada después es la misma, sin los textos
  const espejo = tmp('mbx-resumir-');
  const A = path.join(espejo, 'maq-a');
  fs.mkdirSync(A, { recursive: true });
  for (const [f, b] of Object.entries(blobsDe(2))) fs.writeFileSync(path.join(espejo, f), b);
  const vacia = tmp('mbx-sin-registro-');
  const antes = runs.modelo(vacia, { buzon: espejo, soloBuzon: true, sinUnificar: true });
  const r = runs.resumirEspejo(espejo);
  assert.deepStrictEqual({ resumidas: r.resumidas, fallidas: r.fallidas }, { resumidas: 2, fallidas: 0 }, JSON.stringify(r));
  assert.deepStrictEqual(conversacionesEn(espejo), [], 'ni conversaciones ni cambios en el disco');
  assert.ok(fs.existsSync(path.join(A, runs.RESUMEN.nombre('r1.json'))), 'el resumen está');
  const despues = runs.modelo(vacia, { buzon: espejo, soloBuzon: true, sinUnificar: true });
  const ver = (M) => M.corridas.map((c) => ({ id: c.id, descripcion: c.descripcion, tiempos: c.tiempos, cambios: runs.paraDetalle(c).cambios }));
  assert.deepStrictEqual(ver(despues), ver(antes), 'la tabla y el detalle, iguales');
  assert.ok(despues.corridas.every((c) => c.cambios && c.cambios.estado === 'leido'), 'los cambios, leídos del resumen');
  // los textos (los parches) no se guardan: se bajan a demanda
  assert.ok(despues.corridas.every((c) => !runs.textosDe(c).texto && !runs.textosDe(c).textoGit));
  assert.ok(despues.corridas.every((c) => c._volcado && c._volcado.endsWith('.json')), 'cada corrida sabe de qué volcado salió (para bajar su detalle)');
  // una segunda pasada no hace nada
  assert.deepStrictEqual(runs.resumirEspejo(espejo).resumidas, 0);
});

test('T50 Resumir_LoQueNoSePudoLeerQuedaEnElDisco @story-2.30 @ac-25', () => {
  // un volcado roto o una conversación ilegible no se resumen: cuentan como fallidas, con su motivo, y la conversación
  // y el cambio quedan en el disco para la pasada siguiente (un resumen de una lectura fallida taparía la corrida)
  const espejo = tmp('mbx-resumir-falla-');
  const A = path.join(espejo, 'maq-a');
  fs.mkdirSync(A, { recursive: true });
  for (const [f, b] of Object.entries(blobsDe(3))) fs.writeFileSync(path.join(espejo, f), b);
  fs.writeFileSync(path.join(A, 'r1.json'), '{ esto no es json');
  fs.writeFileSync(path.join(A, 'r2.hilo.jsonl.gz'), 'no es gzip');
  const r = runs.resumirEspejo(espejo);
  assert.deepStrictEqual({ resumidas: r.resumidas, fallidas: r.fallidas }, { resumidas: 1, fallidas: 2 }, JSON.stringify(r));
  assert.ok(r.motivos.some((m) => /r1\.json/.test(m)) && r.motivos.some((m) => /r2\.json \(sin resumir/.test(m)), JSON.stringify(r.motivos));
  for (const n of ['r1', 'r2']) {
    assert.ok(fs.existsSync(path.join(A, `${n}.hilo.jsonl.gz`)) && fs.existsSync(path.join(A, `${n}.cambio.json.gz`)), `${n}: sus archivos siguen`);
    assert.ok(!fs.existsSync(path.join(A, runs.RESUMEN.nombre(`${n}.json`))), `${n}: sin resumen`);
  }
  assert.ok(!fs.existsSync(path.join(A, 'r3.hilo.jsonl.gz')) && fs.existsSync(path.join(A, runs.RESUMEN.nombre('r3.json'))), 'la sana, resumida');
});

test('T51 Bajada_SinListadoNoPoda @story-2.30 @ac-25', async () => {
  // si el buzón no contesta el listado, la bajada falla y el espejo no se toca: «no sé qué hay» no es «no hay nada»
  const buzon = await H.arrancarBuzon({ blobs: blobsDe(2) });
  try {
    const dir = path.join(tmp('mbx-sin-listado-'), 'buzon');
    assert.strictEqual((await bajada(buzon, dir, { sinHilos: false, resumenes: true, topeBytesHilos: 1 << 30, podar: true })).codigo, 0);
    const antes = fs.readdirSync(path.join(dir, 'maq-a')).sort();
    buzon.st.modo = '500';
    const r = await bajada(buzon, dir, { sinHilos: false, resumenes: true, topeBytesHilos: 1 << 30, podar: true });
    assert.notStrictEqual(r.codigo, 0, 'la bajada dice que falló');
    assert.ok(!r.res.podados, 'no podó nada');
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'maq-a')).sort(), antes, 'el espejo, igual');
  } finally { await buzon.cerrar(); }
});

test('T52 Bajada_FallaAMitadYSeCompletaSola @story-2.30 @ac-25', async () => {
  // una conversación que el buzón no entrega deja la pasada incompleta; lo que sí bajó se resume, y la pasada siguiente
  // (con el buzón sano) vuelve a bajar esa corrida entera, porque su resumen no coincide con lo que el buzón tiene
  const buzon = await H.arrancarBuzon({ blobs: blobsDe(3) });
  try {
    const dir = path.join(tmp('mbx-a-mitad-'), 'buzon');
    buzon.st.fallar.add('maq-a/r2.hilo.jsonl.gz');
    const r1 = await bajada(buzon, dir, { sinHilos: false, resumenes: true, topeBytesHilos: 1 << 30, podar: true });
    assert.notStrictEqual(r1.codigo, 0, 'la pasada con la falla no sale verde');
    runs.resumirEspejo(dir);
    buzon.st.fallar.clear();
    const r2 = await bajada(buzon, dir, { sinHilos: false, resumenes: true, topeBytesHilos: 1 << 30, podar: true });
    assert.strictEqual(r2.codigo, 0, JSON.stringify(r2.res));
    assert.strictEqual(r2.res.resumidos, 4, 'las dos sanas, salteadas por su resumen (dos partes cada una)');
    assert.ok(fs.existsSync(path.join(dir, 'maq-a', 'r2.hilo.jsonl.gz')), 'la que falló, bajada ahora');
    const r = runs.resumirEspejo(dir);
    assert.deepStrictEqual({ resumidas: r.resumidas, fallidas: r.fallidas }, { resumidas: 1, fallidas: 0 });
    const M = runs.modelo(tmp('mbx-sin-registro-'), { buzon: dir, soloBuzon: true, sinUnificar: true });
    assert.ok(M.corridas.every((c) => c.cambios && c.cambios.estado === 'leido'), 'las tres, con sus cambios leídos');
  } finally { await buzon.cerrar(); }
});

test('T53 Hilos_ResumenYTextosConTopeDeTiempo @story-2.30 @ac-25', async () => {
  // los hilos aparte: el resumen y los textos a demanda dan lo mismo que en el hilo principal; un error sale con su
  // motivo de verdad, y el que no termina a tiempo se corta (el sitio sigue)
  const { resumirEnWorker, textosEnWorker } = require(path.join(H.SITE, 'summaries.js'));
  const espejo = tmp('mbx-hilos-');
  fs.mkdirSync(path.join(espejo, 'maq-a'), { recursive: true });
  for (const [f, b] of Object.entries(blobsDe(2))) fs.writeFileSync(path.join(espejo, f), b);
  const volcadoR1 = path.join(espejo, 'maq-a', 'r1.json');
  const t = await textosEnWorker({ volcado: volcadoR1 });
  assert.match(zlib.gunzipSync(Buffer.from(String(t.textoGit || ''), 'base64')).toString('utf8'), /PARCHE_1/, 'el parche de la corrida');
  await assert.rejects(textosEnWorker({ volcado: path.join(espejo, 'maq-a', 'no-esta.json') }), (e) => /ENOENT/.test(e.message));
  await assert.rejects(textosEnWorker({ volcado: volcadoR1, tiempoMs: 1 }), (e) => e.code === 'TIEMPO_AGOTADO');
  const r = await resumirEnWorker({ buzon: espejo });
  assert.deepStrictEqual({ resumidas: r.resumidas, fallidas: r.fallidas }, { resumidas: 2, fallidas: 0 });
  assert.deepStrictEqual(conversacionesEn(espejo), []);
});
