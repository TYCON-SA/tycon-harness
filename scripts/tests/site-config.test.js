'use strict';
/*
 * site-config.test.js — la pestaña Configuración del sitio de la organización (story 2.29).
 *
 * El núcleo común (scripts/lib/org-config.js) y la pestaña (scripts/site/tabs/config.js). El servidor de prueba es el
 * de la 2.23 con una sesión inyectada; los repos son repos git locales servidos por HTTP (lib/git-http-repo.js); las
 * APIs REST de Azure DevOps y de GitHub son servidores falsos en el proceso (lib/fake-ado-api.js, lib/fake-github-api.js).
 * Correos, repos y organizaciones inventados: nada de acá habla con la red.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
const OPS = require(path.join(ROOT, 'scripts', 'lib', 'operations-config.js'));
const TR = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const texto = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const ARNES_THRESHOLDS = { corridas_al_final: { direction: 'mayor_es_mejor', ok_min: 0.8, bad_max: 0.5 }, rojos: { direction: 'menor_es_mejor', ok_max: 0, bad_min: 3 } };
const SOURCES_ORG = { sources: [{ id: 'x', pattern: 'x-*.json', dir: 'x', max_age_days: 2 }], thresholds: { corridas_al_final: { direction: 'mayor_es_mejor', ok_min: 0.7, bad_max: 0.4 }, rojos: { direction: 'menor_es_mejor', ok_max: 0, bad_min: 3 } } };

// ── el núcleo común ──────────────────────────────────────────────────────────────────────────────────────────────

test('T20 NoTocaLaMaquina_NiDevuelveIdentidades @story-2.29 @ac-20 — el código de la pestaña y del núcleo no nombra la configuración de ninguna máquina', () => {
  for (const f of ['scripts/lib/org-config.js', 'scripts/site/tabs/config.js', 'scripts/lib/repo-proposal.js']) {
    const t = texto(f);
    for (const clave of ['github.token', 'azure.token', 'paths.', 'tycon-home']) assert.ok(!t.includes(clave), `${f} no nombra «${clave}»`);
    // `config.json` suelto (el de la máquina); `applied-config.json`, la marca del nocturno, es otra cosa
    assert.doesNotMatch(t, /(?<![-\w])config\.json/, `${f} no nombra config.json`);
  }
});

test('T23 Codigo_SinValoresDeUnaOrganizacion @story-2.29 @ac-22 — ni organización, proyecto, repo, correo ni inquilino de TYCON', () => {
  const marcas = [/tycon/i, /bizuit/i, /dev\.azure\.com\/[a-z]/i, /@[a-z0-9-]+\.com\.ar/i, /harness-team-(profile|operations)\b/, /TYCON-SA/];
  for (const f of ['scripts/lib/org-config.js', 'scripts/site/tabs/config.js', 'scripts/lib/repo-proposal.js']) {
    const t = texto(f);
    for (const rx of marcas) assert.ok(!rx.test(t), `${f} no trae ${rx}`);
  }
});

test('T6 Revisar_MismoLector_ProblemasConRuta @story-2.29 @ac-6 — el lector del arnés, espiado; cada problema con su ruta; uno sin campo arriba', () => {
  const llamadas = [];
  const espia = { ...OPS, parse: (t) => { llamadas.push(t); return OPS.parse(t); } };
  const seccion = ORG.SECCIONES.find((s) => s.id === 'responsables');
  assert.ok(seccion, 'hay una sección de responsables (owners y reviewers)');
  const archivo = `${JSON.stringify({ version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'] } }, null, 2)}\n`;
  const r = ORG.revisar({ seccion, texto: archivo, borrador: { owners: { default: '' }, foo: 1 }, lectores: { 'operations-config.js': espia } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(llamadas.length, 1, 'se validó con el lector del arnés, una vez');
  const rutas = r.problems.map((p) => p.path);
  assert.ok(rutas.includes('owners.default'), `owners.default con su ruta: ${rutas}`);
  assert.ok(rutas.includes('foo'), `foo con su ruta: ${rutas}`);
  assert.ok(r.problems.find((p) => p.path === 'foo').sinCampo, 'el problema sin campo en la pantalla se marca para ir arriba');
  // sin problemas: el texto resultante conserva lo que la sección no edita, byte a byte
  const ok = ORG.revisar({ seccion, texto: archivo, borrador: { owners: { default: 'otro@acme.example' } }, lectores: { 'operations-config.js': OPS } });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));
  assert.strictEqual(ok.texto, `${JSON.stringify({ version: 1, owners: { default: 'otro@acme.example' }, site: { maintainers: ['lead@acme.example'] } }, null, 2)}\n`);
});

test('T17 Perfil_SinVersionMinima_NoPropone @story-2.29 @ac-17 — la parte común del texto, sin la cola del clon', () => {
  const bajo = ORG.profileGateProblem(JSON.stringify({ requires: { harness: '>= 2026.10.01.1' } }));
  assert.match(bajo, /todavía no se puede proponer/);
  assert.match(bajo, new RegExp(ORG.TEAM_REPOS_SINCE.replace(/\./g, '\\.')));
  assert.doesNotMatch(bajo, /quedó guardado en tu clon/);
  assert.strictEqual(ORG.profileGateProblem(JSON.stringify({ requires: { harness: `>= ${ORG.TEAM_REPOS_SINCE}` } })), null);
  assert.match(ORG.profileGateProblem('no es json'), /no pude leer team-layer\.json/);
  assert.ok(ORG.versionAtLeast('2026.10.13.11', ORG.TEAM_REPOS_SINCE));
});

test('T12 Umbrales_SoloFilasConocidas_ElRestoIgual @story-2.29 @ac-11 — thresholdsParse: sólo thresholds, problemas con ruta, el resto byte por byte', () => {
  const seccion = ORG.SECCIONES.find((s) => s.id === 'umbrales');
  const archivo = ORG.formatJson(SOURCES_ORG);
  const borrador = { corridas_al_final: { direction: 'mayor_es_mejor', ok_min: 0.9, bad_max: 0.4 }, rojos: SOURCES_ORG.thresholds.rojos };
  const r = ORG.revisar({ seccion, texto: archivo, borrador, lectores: {}, arnes: { thresholds: ARNES_THRESHOLDS } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  const esperado = JSON.parse(archivo); esperado.thresholds.corridas_al_final.ok_min = 0.9;
  assert.strictEqual(r.texto, ORG.formatJson(esperado), 'cambia sólo esa fila');
  const mal = ORG.revisar({ seccion, texto: archivo, borrador: { ...borrador, inventada: { direction: 'mayor_es_mejor', ok_min: 1 }, rojos: { ok_max: 0 } }, lectores: {}, arnes: { thresholds: ARNES_THRESHOLDS } });
  assert.strictEqual(mal.ok, false);
  assert.deepStrictEqual(mal.problems.map((p) => p.path).sort(), ['thresholds.inventada', 'thresholds.rojos']);
  // el lector de umbrales es un envoltorio sobre umbralValido: no hay un validador propio
  const tp = ORG.thresholdsParse(archivo, { arnes: { thresholds: ARNES_THRESHOLDS } });
  assert.strictEqual(tp.ok, true);
  assert.deepStrictEqual(Object.keys(tp.data), ['corridas_al_final', 'rojos']);
});

test('T28 Umbrales_FormatoAjenoYClaveRetirada @story-2.29 @ac-11 — tabs: sólo lectura con el motivo; clave que el arnés ya no trae: aviso sin bloquear', () => {
  const conTabs = `${JSON.stringify(SOURCES_ORG, null, '\t')}\n`;
  const r = ORG.thresholdsParse(conTabs, { arnes: { thresholds: ARNES_THRESHOLDS } });
  assert.strictEqual(r.ok, false);
  assert.match(r.problems[0].message, /no está en el formato que escribe el arnés/);
  assert.strictEqual(r.soloLectura, true);
  const vieja = ORG.formatJson({ ...SOURCES_ORG, thresholds: { ...SOURCES_ORG.thresholds, vieja: { direction: 'menor_es_mejor', ok_max: 1, bad_min: 2 } } });
  const v = ORG.thresholdsParse(vieja, { arnes: { thresholds: ARNES_THRESHOLDS } });
  assert.strictEqual(v.ok, true, JSON.stringify(v.problems));
  assert.deepStrictEqual(v.avisos.map((a) => a.path), ['thresholds.vieja']);
  assert.match(v.avisos[0].message, /el arnés ya no usa esta clave/);
});

test('T14 Versiones_AlDiaAtrasadaSinNoticiasNoMedido @story-2.29 @ac-13 — contra la versión de la imagen, sin red; el día de la carpeta con fecha', () => {
  const espejo = tmp('site-config-espejo-');
  const pon = (maq, carpeta, doc) => { const d = path.join(espejo, maq, 'registros', carpeta || ''); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'place.json'), JSON.stringify(doc)); };
  pon('maq-a', 'v20261015T100000000Z', { install: { version: '2026.10.15.48' } });
  pon('maq-b', 'v20261014T100000000Z', { install: { version: '2026.10.10.1' } });
  pon('maq-c', 'v20260930T100000000Z', { install: { version: '2026.10.15.48' } });
  pon('maq-d', 'v20261015T100000000Z', { install: {} });
  pon('maq-e', '', { install: { version: '2026.10.16.1' } });
  const ahora = Date.parse('2026-10-16T12:00:00Z');
  const filas = ORG.versionesDeMaquinas({ espejo, versionImagen: '2026.10.15.48', ahora });
  const por = Object.fromEntries(filas.map((f) => [f.maquina, f]));
  assert.strictEqual(por['maq-a'].estado, 'al_dia');
  assert.strictEqual(por['maq-a'].dia, '2026-10-15');
  assert.strictEqual(por['maq-b'].estado, 'atrasada');
  assert.match(por['maq-b'].texto, /la imagen puede estar atrasada/);
  assert.strictEqual(por['maq-c'].estado, 'sin_noticias');
  assert.match(por['maq-c'].texto, /sin noticias desde 2026-09-30/);
  assert.strictEqual(por['maq-d'].estado, 'no_medido');
  assert.match(por['maq-d'].texto, /no declara/);
  assert.strictEqual(por['maq-e'].estado, 'al_dia', 'sin carpeta con fecha, se juzga sólo por la versión');
  assert.strictEqual(por['maq-e'].dia, null);
  assert.strictEqual(por['maq-e'].diaTexto, 'sin fecha');
  // la imagen sin versión: todas «no medido»
  const sin = ORG.versionesDeMaquinas({ espejo, versionImagen: null, ahora });
  assert.ok(sin.every((f) => f.estado === 'no_medido' && /la imagen no declara su versión/.test(f.texto)));
});

test('T31 Paridad_PorProducto_FaltaTieneDeclaradoVencido @story-2.29 @ac-25 — por producto, lo que le falta, lo declarado y lo vencido', () => {
  const lista = { grupos: { web: { repos: [{ ruta: 'a/front', producto: 'A' }, { ruta: 'b/front', producto: 'B' }] }, api: { repos: [{ ruta: 'a/back', producto: 'A' }] } }, rasgos: [{ id: 'escaneo' }], diferencias_declaradas: [{ grupo: 'web', rasgo: 'firma', motivo: 'no aplica a B', fecha: '2026-10-01', revision: '2027-01-01' }, { grupo: 'web', rasgo: 'cache', motivo: 'viejo', fecha: '2026-01-01', revision: '2026-02-01' }] };
  const resultado = { estado: 'medido', fecha: '2026-10-16', divergencias: [{ grupo: 'web', rasgo: 'escaneo', que: 'el paso de escaneo', tienen: ['a/front'], no_tienen: ['b/front'] }], declaradas: [{ grupo: 'web', rasgo: 'firma', revision: '2027-01-01' }], vencidas: [{ grupo: 'web', rasgo: 'cache', revision: '2026-02-01' }], por_ruta: [] };
  const v = ORG.paridadPorProducto({ lista, resultado, hoy: '2026-10-16' });
  assert.strictEqual(v.estado, 'medido');
  const b = v.productos.find((p) => p.producto === 'B');
  assert.deepStrictEqual(b.grupos, ['web']);
  assert.deepStrictEqual(b.faltan.map((x) => x.que), ['el paso de escaneo']);
  const a = v.productos.find((p) => p.producto === 'A');
  assert.deepStrictEqual(a.grupos.sort(), ['api', 'web']);
  assert.deepStrictEqual(a.tiene.map((x) => x.rasgo), ['escaneo'], 'A tiene lo que a la mayoría le falta');
  assert.deepStrictEqual(a.declaradas.map((x) => `${x.rasgo}:${x.revision}`), ['firma:2027-01-01']);
  assert.deepStrictEqual(a.vencidas.map((x) => x.rasgo), ['cache']);
  assert.ok(v.definicion.rasgos.length === 1 && Object.keys(v.definicion.grupos).length === 2, 'la definición se muestra, no se edita');
});

test('T33 Paridad_Renovar_SoloEsaEntrada_ConReglas @story-2.29 @ac-26 — revision, motivo y fecha de hoy; el resto byte a byte; las tres reglas', () => {
  const lista = { grupos: {}, rasgos: [], diferencias_declaradas: [{ grupo: 'web', rasgo: 'firma', motivo: 'no aplica', fecha: '2026-10-01', revision: '2026-12-01' }, { grupo: 'web', rasgo: 'cache', motivo: 'viejo', fecha: '2026-01-01', revision: '2026-02-01' }] };
  const archivo = ORG.formatJson(lista);
  const { leerDeclaradas } = require(path.join(ROOT, 'scripts', 'ci', 'check-product-parity.js'));
  const seccion = ORG.SECCIONES.find((s) => s.id === 'paridad');
  const ok = ORG.revisar({ seccion, texto: archivo, borrador: { accion: 'renew', grupo: 'web', rasgo: 'firma', revision: '2027-04-16', motivo: 'sigue sin aplicar' }, lectores: { 'check-product-parity.js': { leerDeclaradas } }, hoy: '2026-10-16' });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));
  const esperado = JSON.parse(archivo); esperado.diferencias_declaradas[0] = { grupo: 'web', rasgo: 'firma', motivo: 'sigue sin aplicar', fecha: '2026-10-16', revision: '2027-04-16' };
  assert.strictEqual(ok.texto, ORG.formatJson(esperado));
  for (const [borrador, rx] of [[{ revision: '2026-10-15', motivo: 'x' }, /posterior a hoy/], [{ revision: '2028-10-17', motivo: 'x' }, /como mucho a un año/], [{ revision: '2027-01-01', motivo: '  ' }, /motivo/]]) {
    const r = ORG.revisar({ seccion, texto: archivo, borrador: { accion: 'renew', grupo: 'web', rasgo: 'firma', ...borrador }, lectores: { 'check-product-parity.js': { leerDeclaradas } }, hoy: '2026-10-16' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => rx.test(p.message)), `${rx}: ${JSON.stringify(r.problems)}`);
  }
  // la validación es la del control: una entrada sin un campo la rechaza la lectura exportada
  const rota = ORG.formatJson({ ...lista, diferencias_declaradas: [lista.diferencias_declaradas[0], { grupo: 'web', rasgo: 'cache', motivo: 'x', revision: '2027-01-01' }] });
  const r2 = ORG.revisar({ seccion, texto: rota, borrador: { accion: 'renew', grupo: 'web', rasgo: 'firma', revision: '2027-01-01', motivo: 'x' }, lectores: { 'check-product-parity.js': { leerDeclaradas } }, hoy: '2026-10-16' });
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.problems.some((p) => /fecha/.test(p.message)), JSON.stringify(r2.problems));
});

test('T34b Paridad_VariosGrupos_DeUnaVez — la misma diferencia en dos grupos se renueva y se cierra junta; un grupo que no la tiene frena', () => {
  const mismo = (grupo) => ({ grupo, rasgo: 'etiqueta', motivo: 'falta el pedido', fecha: '2026-09-15', revision: '2026-12-15' });
  const lista = { grupos: {}, rasgos: [], diferencias_declaradas: [mismo('backend'), { grupo: 'web', rasgo: 'cache', motivo: 'b', fecha: '2026-10-01', revision: '2026-12-01' }, mismo('frontend')] };
  const archivo = ORG.formatJson(lista);
  const { leerDeclaradas } = require(path.join(ROOT, 'scripts', 'ci', 'check-product-parity.js'));
  const seccion = ORG.SECCIONES.find((s) => s.id === 'paridad');
  const lectores = { 'check-product-parity.js': { leerDeclaradas } };
  const ren = ORG.revisar({ seccion, texto: archivo, borrador: { accion: 'renew', grupos: ['backend', 'frontend'], rasgo: 'etiqueta', revision: '2027-03-01', motivo: 'sigue faltando' }, lectores, hoy: '2026-10-16' });
  assert.strictEqual(ren.ok, true, JSON.stringify(ren.problems));
  const nuevo = (grupo) => ({ ...mismo(grupo), motivo: 'sigue faltando', fecha: '2026-10-16', revision: '2027-03-01' });
  assert.strictEqual(ren.texto, ORG.formatJson({ ...lista, diferencias_declaradas: [nuevo('backend'), lista.diferencias_declaradas[1], nuevo('frontend')] }));
  const cer = ORG.revisar({ seccion, texto: archivo, borrador: { accion: 'close', grupos: ['backend', 'frontend'], rasgo: 'etiqueta' }, lectores, hoy: '2026-10-16' });
  assert.strictEqual(cer.ok, true, JSON.stringify(cer.problems));
  assert.strictEqual(cer.texto, ORG.formatJson({ ...lista, diferencias_declaradas: [lista.diferencias_declaradas[1]] }));
  const falta = ORG.revisar({ seccion, texto: archivo, borrador: { accion: 'close', grupos: ['backend', 'web'], rasgo: 'etiqueta' }, lectores, hoy: '2026-10-16' });
  assert.strictEqual(falta.ok, false);
  assert.match(falta.problems[0].message, /no hay una diferencia declarada web\/etiqueta/);
});

test('T34 Paridad_Cerrar_QuitaSoloEsaEntrada_YAvisa @story-2.29 @ac-26', () => {
  const lista = { grupos: {}, rasgos: [], diferencias_declaradas: [{ grupo: 'web', rasgo: 'firma', motivo: 'a', fecha: '2026-10-01', revision: '2026-12-01' }, { grupo: 'web', rasgo: 'cache', motivo: 'b', fecha: '2026-10-01', revision: '2026-12-01' }] };
  const archivo = ORG.formatJson(lista);
  const { leerDeclaradas } = require(path.join(ROOT, 'scripts', 'ci', 'check-product-parity.js'));
  const seccion = ORG.SECCIONES.find((s) => s.id === 'paridad');
  const r = ORG.revisar({ seccion, texto: archivo, borrador: { accion: 'close', grupo: 'web', rasgo: 'firma' }, lectores: { 'check-product-parity.js': { leerDeclaradas } }, hoy: '2026-10-16' });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  assert.strictEqual(r.texto, ORG.formatJson({ ...lista, diferencias_declaradas: [lista.diferencias_declaradas[1]] }));
  assert.match(r.aviso, /vuelve (a aparecer )?como divergencia la noche siguiente/);
});

test('T22 Propuesta_ConservaLoQueNoSeEdito @story-2.29 @ac-23 — se cambia sólo owners.default; el archivo propuesto difiere sólo en esa línea', () => {
  const doc = { __doc: 'un comentario', version: 1, owners: { default: 'lead@acme.example', by_project: { P: 'p@acme.example' } }, reviewers: { watcher: ['w@acme.example'] }, site: { maintainers: ['lead@acme.example'], refresh_minutes: 20 }, people: { machines: { 'maq-a': { person: 'a@acme.example', reported_sha256: null, confirmed_by: 'lead@acme.example', confirmed_on: '2026-10-01' } } } };
  const archivo = ORG.formatJson(doc);
  const seccion = ORG.SECCIONES.find((s) => s.id === 'responsables');
  const r = ORG.revisar({ seccion, texto: archivo, borrador: { owners: { ...doc.owners, default: 'otro@acme.example' }, reviewers: doc.reviewers }, lectores: { 'operations-config.js': OPS } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  const a = archivo.split('\n'); const b = r.texto.split('\n');
  assert.strictEqual(a.length, b.length);
  const distintas = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
  assert.strictEqual(distintas.length, 1, `una sola línea distinta: ${distintas}`);
  assert.match(b[distintas[0]], /otro@acme\.example/);
});

// el código de pantalla: un solo archivo, sin nada de afuera ni de la máquina
test('T4a Pantalla_EsUnArchivo_SinFetchAfuera @story-2.29 @ac-4', () => {
  const js = ORG.pantalla();
  assert.ok(js.length > 2000);
  assert.ok(!/https?:\/\//.test(js), 'nada de afuera');
  assert.ok(/X-Site-Token/i.test(js), 'manda el token de doble envío');
  assert.ok(!/innerHTML/.test(js), 'los textos van con textContent');
});

module.exports = { ARNES_THRESHOLDS, SOURCES_ORG, tmp };

// ── la pestaña en el sitio de la 2.23 ────────────────────────────────────────────────────────────────────────────
const { spawnSync } = require('child_process');
const H = require('./lib/site-harness.js');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
const TAB = () => require(path.join(H.SITE, 'tabs', 'config.js'));
const LEAD = 'lead@acme.example';
const DEV = 'dev.a@acme.example';
const sha = (c) => crypto.createHash('sha256').update(c.trim().toLowerCase()).digest('hex');
const HOY = '2026-10-16';
const AHORA = Date.parse(`${HOY}T12:00:00Z`);

function g(dir, ...a) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@acme.example', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@acme.example', GIT_AUTHOR_DATE: '2026-10-16T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-16T12:00:00Z' } });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
/** Un clon de juguete con estos archivos (objetos → JSON del arnés; texto tal cual; null no se escribe). */
function clon(archivos) {
  const d = tmp('site-config-clon-');
  g(d, 'init', '-q', '-b', 'main');
  for (const [rel, c] of Object.entries(archivos)) {
    if (c === null) continue;
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), typeof c === 'string' ? c : ORG.formatJson(c));
  }
  g(d, 'add', '-A'); g(d, 'commit', '-q', '--allow-empty', '-m', 'base');
  return d;
}
const opsBase = (extra = {}) => ({ version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] }, ...extra });

/** Las fuentes de la 2.23 de mentira, con los clones y el espejo que la pestaña lee. */
function fuentesCon({ ops, perfil = null, config, informados = null, repos = null, espejo = null, estado = {} }) {
  const f = H.fuentesFijas({ config: config || opsBase(), personas: { informados, repos } });
  const base = f.estado;
  f.estado = () => ({ ...base(), ...estado });
  f.clones = () => ({ operaciones: ops ? { dir: ops } : null, perfil: perfil ? { dir: perfil } : null });
  f.dirBuzon = espejo || tmp('site-config-buzon-');
  f.exclusivo = (fn) => fn();
  return f;
}

/** El sitio con la pestaña; `entrar(correo)` da la cookie de una sesión real del emisor local. */
async function conPestana({ fuentes, env = {}, opciones = {} }, fn) {
  let emisor = null;
  let h = null;
  try {
    emisor = await arrancarEmisor();
    const envSitio = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, ...env });
    const cfg = validarConfiguracion(envSitio).cfg;
    const rutasExtra = TAB().crearRutas({ cfg, fuentes, versionImagen: '2026.10.15.48', ahora: () => AHORA, ...opciones });
    h = await H.arrancarSitio({ env: envSitio, fuentes, rutasExtra });
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    const token = async (cookie) => { const p = await h.pedir('/configuracion', { cookie }); const m = /<meta name="site-token" content="([^"]+)">/.exec(p.texto); return m ? m[1] : null; };
    const escribir = (ruta, cookie, tok, cuerpo, headers = {}) => h.pedir(ruta, { method: 'POST', cookie, body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo), headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-site-token': tok, ...headers } });
    await fn({ h, entrar, token, escribir, cfg });
  } finally { await cerrarTodos(h, emisor); }
}
const RUTAS = [['GET', '/configuracion'], ['GET', '/static/config.js'], ['GET', '/api/config'], ['POST', '/api/config/revisar'], ['POST', '/api/config/stages'], ['POST', '/api/config/proponer']];

test('T1 Dev_403EnTodasLasRutas_SinDatos @story-2.29 @ac-1', async () => {
  const ops = clon({ 'operations.json': opsBase({ owners: { default: 'marcador-owner@acme.example' } }) });
  const fuentes = fuentesCon({ ops, config: opsBase({ people: { machines: { 'maq-a': { person: DEV, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' } } } }) });
  await conPestana({ fuentes }, async ({ h, entrar }) => {
    const dev = await entrar(DEV);
    for (const [method, ruta] of RUTAS) {
      const r = await h.pedir(ruta, { method, cookie: dev, body: method === 'POST' ? '{}' : undefined, headers: method === 'POST' ? { 'content-type': 'application/json', origin: 'http://127.0.0.1' } : {} });
      assert.strictEqual(r.status, 403, `${method} ${ruta}`);
      assert.ok(!r.texto.includes('marcador-owner'), `${ruta} sin un dato de la configuración`);
    }
    assert.strictEqual((await h.pedir('/api/config/descargar', { cookie: dev })).status, 404, 'no hay ruta de descarga');
    // la pestaña no aparece en el menú del dev, y sí en el del mantenedor
    assert.doesNotMatch((await h.pedir('/', { cookie: dev })).texto, /href="\/configuracion"/);
    assert.match((await h.pedir('/', { cookie: await entrar(LEAD) })).texto, /href="\/configuracion"/);
  });
});

test('T2 SinSesion_ComoLa2_23 @story-2.29 @ac-2', async () => {
  const fuentes = fuentesCon({ ops: clon({ 'operations.json': opsBase() }) });
  await conPestana({ fuentes }, async ({ h }) => {
    for (const [method, ruta] of RUTAS) {
      const r = await h.pedir(ruta, { method, body: method === 'POST' ? '{}' : undefined, headers: method === 'POST' ? { 'content-type': 'application/json' } : {} });
      if (ruta.startsWith('/api/')) assert.strictEqual(r.status, 401, `${ruta}: 401 sin cuerpo`);
      else assert.strictEqual(r.status, 302, `${ruta}: al inicio de sesión`);
      assert.ok(!r.texto.includes(LEAD));
    }
  });
});

test('T3 Escritura_SinOrigenSinTokenNoJsonGrande_NadaCreado @story-2.29 @ac-3', async () => {
  const fuentes = fuentesCon({ ops: clon({ 'operations.json': opsBase() }) });
  const llamadas = [];
  const fetchEspia = async (...a) => { llamadas.push(a); throw new Error('no debería salir a la red'); };
  await conPestana({ fuentes, opciones: { fetch: fetchEspia } }, async ({ h, entrar, token }) => {
    const lead = await entrar(LEAD);
    const tok = await token(lead);
    assert.match(tok || '', /^[A-Za-z0-9_-]{40,}$/, 'el token de la sesión llega en la página');
    const otro = await token(await entrar(LEAD));
    assert.notStrictEqual(tok, otro, 'cada sesión, su token');
    const cuerpo = JSON.stringify({ seccion: 'responsables', borrador: { owners: { default: LEAD } } });
    const casos = [
      [{ 'content-type': 'application/json', 'x-site-token': tok }, cuerpo, 403, /falta el origen del pedido/],
      [{ origin: 'https://otro.example', 'content-type': 'application/json', 'x-site-token': tok }, cuerpo, 403, /el pedido viene de otro origen/],
      [{ origin: 'http://127.0.0.1', 'content-type': 'application/json' }, cuerpo, 403, /falta el token del sitio/],
      [{ origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-site-token': otro }, cuerpo, 403, /el token no es el de tu sesión/],
      [{ origin: 'http://127.0.0.1', 'content-type': 'text/plain', 'x-site-token': tok }, cuerpo, 415, null],
      [{ origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-site-token': tok }, JSON.stringify({ x: 'a'.repeat(257 * 1024) }), 400, null],
    ];
    for (const ruta of ['/api/config/revisar', '/api/config/proponer']) {
      for (const [headers, body, status, rx] of casos) {
        const r = await h.pedir(ruta, { method: 'POST', cookie: lead, headers, body });
        assert.strictEqual(r.status, status, `${ruta} ${JSON.stringify(headers)}`);
        if (rx) assert.match(r.texto, rx);
      }
    }
    assert.strictEqual(llamadas.length, 0, 'cero llamadas a una API en los seis casos');
    const pasa = await h.pedir('/api/config/revisar', { method: 'POST', cookie: lead, headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-site-token': tok }, body: cuerpo });
    assert.strictEqual(pasa.status, 200, pasa.texto);
    assert.strictEqual(pasa.json.ok, true);
  });
});

/** Un lector de operations.json que conoce las claves de la 2.22 y la 2.30 (las pruebas lo inyectan: esas stories traen el suyo). */
const OPS_FUTURO = { ...OPS, KEYS: [...OPS.KEYS, 'deployments', 'notify'], parse: (t) => { const d = JSON.parse(t); const { deployments, notify, ...resto } = d; const r = OPS.parse(JSON.stringify(resto)); return r.ok ? { ...r, data: d } : r; } };

test('T4 Secciones_OchoEditablesYDosDeLectura_CanalSinSecretos_SinScriptEnLinea @story-2.29 @ac-4 @ac-12', async () => {
  const ops = clon({ 'operations.json': opsBase(), 'scripts/nightly/dashboard/sources.json': SOURCES_ORG, '.dashboard/applied-config.json': { files: { 'scripts/nightly/dashboard/sources.json': 'x' } }, 'scripts/ci/product-parity.json': { grupos: {}, rasgos: [], diferencias_declaradas: [] } });
  const perfil = clon({ 'team-repos.json': { version: 1 }, 'team-layer.json': { requires: { harness: `>= ${ORG.TEAM_REPOS_SINCE}` } } });
  const fuentes = fuentesCon({ ops, perfil });
  // el lector de hoy ya sabe `notify`; el «todavía no sabe leer» se prueba con uno de antes, sin la clave
  const OPS_VIEJO = { ...OPS, KEYS: OPS.KEYS.filter((k) => k !== 'notify') };
  for (const [lectores, canalEdita] of [[{ 'operations-config.js': OPS_VIEJO }, false], [{}, true], [{ 'operations-config.js': OPS_FUTURO }, true]]) {
    await conPestana({ fuentes, env: { SITE_PROFILE_REPO: 'https://git.acme.example/perfil.git', SITE_PROFILE_TOKEN: 't' }, opciones: { lectores } }, async ({ h, entrar }) => {
      const lead = await entrar(LEAD);
      const r = (await h.pedir('/api/config', { cookie: lead })).json;
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.secciones.map((s) => s.id), ORG.SECCIONES.map((s) => s.id), 'las ocho secciones');
      const canal = r.secciones.find((s) => s.id === 'canal');
      if (canalEdita) assert.notStrictEqual(canal.estado, 'no_reader');
      else { assert.strictEqual(canal.estado, 'no_reader'); assert.match(canal.motivo, /todavía no sabe leer/); }
      assert.ok(Array.isArray(r.productos) && Array.isArray(r.versiones), 'Productos y Versiones, de sólo lectura');
      const texto = JSON.stringify(r);
      for (const x of ['SITE_OPERATIONS_TOKEN', 'tok-de-prueba', 'webhook', 'chat_id']) assert.ok(!texto.includes(x), `sin ${x}`);
      const pagina = await h.pedir('/configuracion', { cookie: lead });
      assert.strictEqual(pagina.status, 200);
      assert.doesNotMatch(pagina.texto, /<script(?![^>]*\bsrc=)[^>]*>/, 'ningún <script> en línea');
      assert.match(pagina.texto, /<script src="\/static\/config\.js" defer><\/script>/);
      const js = await h.pedir('/static/config.js', { cookie: lead });
      assert.strictEqual(js.status, 200);
      assert.match(js.headers['content-type'], /javascript/);
      assert.match(js.headers['content-security-policy'], /script-src 'self'/);
      assert.strictEqual(js.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(js.texto, ORG.pantalla());
    });
  }
});

test('T5 Lectura_DelClonDelSitio_PerfilSinConfigurar_ArchivoAusenteOIlegible @story-2.29 @ac-5', async () => {
  const ops = clon({ 'scripts/nightly/dashboard/sources.json': SOURCES_ORG });
  await conPestana({ fuentes: fuentesCon({ ops, perfil: null }) }, async ({ h, entrar, cfg }) => {
    const r = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json;
    const por = Object.fromEntries(r.secciones.map((s) => [s.id, s]));
    assert.strictEqual(por.responsables.estado, 'nuevo', 'operations.json ausente: se crea con el pedido');
    assert.strictEqual(por.repos.estado, 'no_configurado');
    // dice qué falta, no sólo «sin configurar»: el repo del perfil, y con qué variables se pone
    assert.strictEqual(por.repos.falta, 'el repo del perfil');
    assert.match(por.repos.motivo, /^falta el repo del perfil: .*SITE_PROFILE_REPO y SITE_PROFILE_TOKEN/);
    assert.ok(!cfg.profileRepo);
    // y la lista de secciones de la pantalla lo muestra así
    const pantalla = await correrPantalla(() => Promise.resolve({ status: 200, json: () => Promise.resolve(r) }));
    assert.match(pantalla, /falta el repo del perfil/);
  });
  // un archivo que está y no se puede leer (una carpeta con su nombre): el motivo, sin edición
  const ops2 = clon({ 'operations.json/x': 'y' });
  await conPestana({ fuentes: fuentesCon({ ops: ops2 }) }, async ({ h, entrar }) => {
    const r = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json;
    const s = r.secciones.find((x) => x.id === 'responsables');
    assert.strictEqual(s.estado, 'ilegible');
    assert.match(s.motivo, /no se pudo leer/);
  });
  // todas las rutas de la pestaña registradas como sólo-mantenedor
  const rutas = TAB().crearRutas({ cfg: validarConfiguracion(H.envBase()).cfg, fuentes: fuentesCon({ ops }) });
  assert.ok(rutas.length >= 6 && rutas.every((x) => x.needs.length === 1 && x.needs[0] === 'maintainer'));
});

test('T7 Productos_DeDependenciasSoloLectura_DeDeploymentsEditables @story-2.29 @ac-7', async () => {
  const ops = clon({ 'operations.json': opsBase({ deployments: { provider: 'azure', products: { 'Prod A': { staging: [{ pipeline: 'Proy/Front', stages: ['Deploy'] }] }, 'Prod B': { production: [{ pipeline: 'Proy/Back', stages: ['DeployProd'] }] } } } }), 'scripts/nightly/dependencies/repos.json': { repos: [{ producto: 'Prod A', ado: 'Proy/RepoA', activo: true }, { producto: 'Prod C', ado: 'Proy/RepoC', activo: false, motivo: 'archivado' }] } });
  await conPestana({ fuentes: fuentesCon({ ops }), opciones: { lectores: { 'operations-config.js': OPS_FUTURO } } }, async ({ h, entrar }) => {
    const r = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json;
    const nombres = r.productos.map((p) => `${p.producto}:${p.origen}`).sort();
    assert.deepStrictEqual(nombres, ['Prod A:dependencias', 'Prod A:deployments', 'Prod B:deployments', 'Prod C:dependencias']);
    const c = r.productos.find((p) => p.producto === 'Prod C');
    assert.strictEqual(c.activo, false); assert.strictEqual(c.motivo, 'archivado');
    assert.ok(r.productos.filter((p) => p.origen === 'deployments').length === 2, 'sólo los de deployments se editan (en Despliegues)');
  });
});

test('Personas_SinActividad_AparteYSinConfirmar', async () => {
  // una carpeta sin place.json, sin fecha y sin corridas va aparte: sin esto sale por confirmar, con el botón, y cuenta
  // en «N por confirmar»
  const ops = clon({ 'operations.json': opsBase() });
  const inf = H.informados({ 'maq-c': 'dev.c@ejemplo.test' });
  inf.maquinas['lab-1'] = { estado: 'no_informa', motivo: 'la máquina no subió place.json', corridas: 0 };
  await conPestana({ fuentes: fuentesCon({ ops, informados: inf }), opciones: { hoy: () => HOY } }, async ({ h, entrar }) => {
    const vista = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json.secciones.find((s) => s.id === 'personas');
    assert.deepStrictEqual(vista.extras.porConfirmar.map((m) => m.maquina), ['maq-c']);
    assert.deepStrictEqual(vista.extras.sinActividad, [{ maquina: 'lab-1' }]);
  });
});

test('T9 Personas_ConfirmarEscribeQuienYCuando_YQuitar @story-2.29 @ac-9', async () => {
  const ops = clon({ 'operations.json': opsBase() });
  const inf = H.informados({ 'maq-c': ' Dev.C@Ejemplo.test ', 'maq-d': null });
  await conPestana({ fuentes: fuentesCon({ ops, informados: inf }), opciones: { hoy: () => HOY } }, async ({ h, entrar, token, escribir }) => {
    const lead = await entrar('LEAD@acme.example');
    const tok = await token(lead);
    const vista = (await h.pedir('/api/config', { cookie: lead })).json.secciones.find((s) => s.id === 'personas');
    assert.deepStrictEqual(vista.extras.porConfirmar.map((m) => m.maquina).sort(), ['maq-c', 'maq-d']);
    const c = (await escribir('/api/config/revisar', lead, tok, { seccion: 'personas', borrador: { accion: 'confirm', maquina: 'maq-c', person: ' C@Acme.Example ', people: {} } })).json;
    assert.strictEqual(c.ok, true, JSON.stringify(c.problems));
    const doc = JSON.parse(c.texto);
    assert.deepStrictEqual(doc.people.machines['maq-c'], { person: 'c@acme.example', reported_sha256: sha('dev.c@ejemplo.test'), confirmed_by: 'lead@acme.example', confirmed_on: HOY });
    assert.ok(!c.texto.toLowerCase().includes('dev.c@ejemplo.test'), 'el correo informado no se escribe en claro');
    const d = (await escribir('/api/config/revisar', lead, tok, { seccion: 'personas', borrador: { accion: 'confirm', maquina: 'maq-d', person: 'd@acme.example', people: c.borrador.people } })).json;
    assert.strictEqual(d.ok, true, JSON.stringify(d.problems));
    assert.strictEqual(JSON.parse(d.texto).people.machines['maq-d'].reported_sha256, null);
    // una entrada mal formada no pasa: la valida el lector
    const mal = (await escribir('/api/config/revisar', lead, tok, { seccion: 'personas', borrador: { people: { machines: { 'maq-c': { person: 'c@acme.example', reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-13-40' } } } } })).json;
    assert.strictEqual(mal.ok, false);
    assert.ok(mal.problems.some((p) => p.path === 'people.machines.maq-c.confirmed_on'));
    // «Quitar»: el borrador sin la entrada
    const sin = (await escribir('/api/config/revisar', lead, tok, { seccion: 'personas', borrador: { people: {} } })).json;
    assert.strictEqual(sin.ok, true);
    assert.ok(!JSON.parse(sin.texto).people || !JSON.parse(sin.texto).people.machines);
  });
});

test('T10 Personas_CorreccionDeDondeTrabaja @story-2.29 @ac-9', async () => {
  const machines = { 'maq-a': { person: DEV, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' }, 'maq-x': { person: 'caido@acme.example', reported_sha256: sha('otro@acme.example'), confirmed_by: LEAD, confirmed_on: '2026-10-01' } };
  const config = opsBase({ people: { machines } });
  const ops = clon({ 'operations.json': config });
  const inf = H.informados({ 'maq-a': null, 'maq-x': 'nuevo@acme.example' });
  await conPestana({ fuentes: fuentesCon({ ops, config, informados: inf }) }, async ({ h, entrar, token, escribir }) => {
    const lead = await entrar(LEAD);
    const tok = await token(lead);
    const p = (await h.pedir('/api/config', { cookie: lead })).json.secciones.find((s) => s.id === 'personas');
    const personas = p.extras.personas.map((x) => x.correo).sort();
    assert.deepStrictEqual(personas, ['caido@acme.example', DEV], 'la persona con todo caído también');
    assert.strictEqual(p.extras.personas.find((x) => x.correo === 'caido@acme.example').caida, true);
    const r = (await escribir('/api/config/revisar', lead, tok, { seccion: 'personas', borrador: { people: { machines, projects: { [DEV]: { add: ['Gama'], remove: ['Alfa'] } } } } })).json;
    assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
    assert.deepStrictEqual(JSON.parse(r.texto).people.projects[DEV], { add: ['Gama'], remove: ['Alfa'] });
  });
  // operations.json que no valida: el último bueno con el motivo y desde cuándo; vencido, no propone
  const rota = clon({ 'operations.json': '{ roto' });
  for (const [estado, rx, editable] of [[{ bandaConfig: { desde: AHORA - 2 * 3600000, motivo: 'problemas en owners' } }, /último bueno/, true], [{ frenado: { desde: AHORA - 3600000, fallaDesde: AHORA - 25 * 3600000 } }, /venció/, false]]) {
    await conPestana({ fuentes: fuentesCon({ ops: rota, config, estado }) }, async ({ h, entrar }) => {
      const r = await h.pedir('/api/config', { cookie: await entrar(LEAD) });
      // con el sitio frenado la 2.23 contesta 503 a todos: la sección no se ve; con la banda, se ve el último bueno
      if (estado.frenado) { assert.strictEqual(r.status, 503); return; }
      const p = r.json.secciones.find((s) => s.id === 'personas');
      assert.match(p.extras.ultimoBueno, rx);
      assert.strictEqual(!p.soloLectura, editable);
    });
  }
});

test('T11 Sitio_MantenedoresVaciaNoSePropone_CorreoMalFormado @story-2.29 @ac-10', async () => {
  const ops = clon({ 'operations.json': opsBase() });
  await conPestana({ fuentes: fuentesCon({ ops }) }, async ({ entrar, token, escribir }) => {
    const lead = await entrar(LEAD);
    const tok = await token(lead);
    const rev = async (site) => (await escribir('/api/config/revisar', lead, tok, { seccion: 'sitio', borrador: { site } })).json;
    const vacia = await rev({ maintainers: [] });
    assert.strictEqual(vacia.ok, false);
    assert.ok(vacia.problems.some((p) => /quedaría sin nadie que pueda entrar a esta pestaña/.test(p.message)));
    const mal = await rev({ maintainers: ['sin-arroba'], mailbox: { provider: 'azure-blob', account: 'acmeruns', container: 'runs', sas: 'x' } });
    assert.strictEqual(mal.ok, false);
    assert.deepStrictEqual(mal.problems.map((p) => p.path).sort(), ['site.mailbox.sas', 'site.maintainers.0']);
    const sinMi = await rev({ maintainers: ['otra@acme.example'] });
    assert.strictEqual(sinMi.ok, true);
    assert.match(sinMi.advertencia, /no estás en la lista que proponés: al mergear perdés el acceso/);
  });
});

test('T13 Umbrales_SinArchivoDeLaOrganizacion_SoloLectura @story-2.29 @ac-11', async () => {
  await conPestana({ fuentes: fuentesCon({ ops: clon({ 'operations.json': opsBase() }) }) }, async ({ h, entrar }) => {
    const u = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json.secciones.find((s) => s.id === 'umbrales');
    assert.strictEqual(u.soloLectura, true);
    assert.match(u.motivo, /no tiene su sources\.json/);
    assert.ok(u.borrador && Object.keys(u.borrador).length > 0, 'se muestran los del arnés');
  });
});

test('T30 Umbrales_SinMarcaDelNocturno_SoloLectura @story-2.29 @ac-11', async () => {
  for (const [marca, soloLectura] of [[null, true], [{ files: { 'scripts/nightly/dashboard/sources.json': 'abc' } }, false]]) {
    const ops = clon({ 'operations.json': opsBase(), 'scripts/nightly/dashboard/sources.json': SOURCES_ORG, '.dashboard/applied-config.json': marca });
    await conPestana({ fuentes: fuentesCon({ ops }) }, async ({ h, entrar }) => {
      const u = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json.secciones.find((s) => s.id === 'umbrales');
      assert.strictEqual(Boolean(u.soloLectura), soloLectura, JSON.stringify(u));
      if (soloLectura) assert.match(u.motivo, /tu nocturno todavía no lee este archivo/);
    });
  }
});

test('T8 Stages_PropuestosConLaCredencialDePipelines_NadaSinConfirmar @story-2.29 @ac-8', async () => {
  const { arrancarAdoFalso } = require('./lib/fake-ado-api.js');
  const { arrancarGithubFalso } = require('./lib/fake-github-api.js');
  let ado, gh;
  try {
    ado = await arrancarAdoFalso({ org: 'acme', project: 'Proy', repo: 'ops' });
    gh = await arrancarGithubFalso({ owner: 'acme', repo: 'producto' });
    ado.st.timeline = [{ type: 'Stage', identifier: 'Deploy', name: 'Desplegar a staging' }, { type: 'Stage', identifier: 'DeployProd', name: 'Producción' }, { type: 'Job', identifier: 'j', name: 'x' }];
    gh.st.environments = [{ name: 'staging' }, { name: 'production' }];
    ado.st.builds = { 42: [{ id: 7 }], 43: [{ id: 8 }] };
    const ops = clon({ 'operations.json': opsBase() });
    const remotos = { operaciones: { platform: 'azure', org: 'acme', project: 'Proy', repo: 'ops', web: 'https://dev.azure.example/acme/Proy/_git/ops' } };
    await conPestana({ fuentes: fuentesCon({ ops }), env: { SITE_PIPELINES_TOKEN: 'pip' }, opciones: { remotos, urlBase: { azure: ado.base, github: gh.base } } }, async ({ entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      const r = (await escribir('/api/config/stages', lead, tok, { pipeline: '42' })).json;
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual(r.propuestos, [{ identificador: 'Deploy', nombre: 'Desplegar a staging', estado: 'propuesto' }, { identificador: 'DeployProd', nombre: 'Producción', estado: 'propuesto' }]);
      assert.ok(!ado.llamadas.some((c) => c.method !== 'GET'), 'nada se escribe: la propuesta sólo lee');
      ado.st.pipelines403 = true;
      const sin = (await escribir('/api/config/stages', lead, tok, { pipeline: '43' })).json;
      assert.strictEqual(sin.ok, false); assert.match(sin.message, /escribí el stage a mano/); assert.match(sin.message, /403/);
      const g1 = (await escribir('/api/config/stages', lead, tok, { pipeline: 'acme/producto' })).json;
      assert.deepStrictEqual(g1.propuestos.map((x) => x.identificador), ['staging', 'production']);
    });
    await conPestana({ fuentes: fuentesCon({ ops }), opciones: { remotos, urlBase: { azure: ado.base, github: gh.base } } }, async ({ entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      assert.match((await escribir('/api/config/stages', lead, tok, { pipeline: '42' })).json.message, /no configurado: escribí el stage a mano/);
      assert.match((await escribir('/api/config/stages', lead, tok, { pipeline: 'acme/producto' })).json.message, /no configurado: escribí el environment a mano/);
    });
  } finally { await cerrarTodos(ado, gh); }
});

test('T14b Versiones_EnLaPestana_ConLaPersonaConfirmada @story-2.29 @ac-13', async () => {
  const espejo = tmp('site-config-espejo-');
  const d = path.join(espejo, 'maq-a', 'registros', 'v20261015T100000000Z'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'place.json'), JSON.stringify({ install: { version: '2026.10.15.48' } }));
  const config = opsBase({ people: { machines: { 'maq-a': { person: DEV, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' } } } });
  await conPestana({ fuentes: fuentesCon({ ops: clon({ 'operations.json': config }), config, espejo }) }, async ({ h, entrar }) => {
    const v = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json.versiones;
    assert.deepStrictEqual(v.map((x) => [x.maquina, x.persona, x.estado]), [['maq-a', DEV, 'al_dia']]);
  });
});

test('T19 SinIdentidadDeEscritura_SoloLecturaYDescarga @story-2.29 @ac-19', async () => {
  const ops = clon({ 'operations.json': opsBase() });
  for (const env of [{}, { SITE_OPERATIONS_WRITE_TOKEN: 'w' }]) {
    await conPestana({ fuentes: fuentesCon({ ops }), env }, async ({ h, entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      const r = (await h.pedir('/api/config', { cookie: lead })).json;
      assert.strictEqual(r.proponer.operaciones.habilitado, false);
      assert.match(r.proponer.operaciones.motivo, env.SITE_OPERATIONS_WRITE_TOKEN ? /no reconozco la plataforma/ : /sin identidad de escritura/);
      const rev = (await escribir('/api/config/revisar', lead, tok, { seccion: 'responsables', borrador: { owners: { default: 'otro@acme.example' } } })).json;
      assert.strictEqual(rev.texto, ORG.formatJson({ ...opsBase(), owners: { default: 'otro@acme.example' } }), 'el JSON validado, para descargar');
      const p = (await escribir('/api/config/proponer', lead, tok, { seccion: 'responsables', texto: rev.texto })).json;
      assert.strictEqual(p.ok, false);
    });
  }
});

test('T25 Mantenedores_CambianSoloAlMergearYReleer @story-2.29 @ac-10', async () => {
  const M2 = 'm2@acme.example';
  const fuentes = fuentesCon({ ops: clon({ 'operations.json': opsBase({ site: { maintainers: [LEAD, M2] } }) }), config: opsBase({ site: { maintainers: [LEAD, M2] } }) });
  await conPestana({ fuentes }, async ({ h, entrar, token, escribir }) => {
    const m2 = await entrar(M2); const lead = await entrar(LEAD); const tok = await token(lead);
    const rev = (await escribir('/api/config/revisar', lead, tok, { seccion: 'sitio', borrador: { site: { maintainers: [LEAD] } } })).json;
    assert.strictEqual(rev.ok, true);
    assert.strictEqual((await h.pedir('/api/config', { cookie: m2 })).status, 200, 'mientras el pedido está abierto, m2 sigue entrando');
    fuentes.st.config = opsBase({ site: { maintainers: [LEAD] } });   // el merge y el refresco de la 2.23
    assert.strictEqual((await h.pedir('/api/config', { cookie: m2 })).status, 403, 'después del refresco, 403 sin cerrar su sesión');
  });
});

test('T32 Paridad_SinArchivoDeHoy_SinListaOListaIlegible @story-2.29 @ac-25 @ac-27', async () => {
  const lista = { grupos: { web: { repos: [{ ruta: 'a/f', producto: 'A' }] } }, rasgos: [], diferencias_declaradas: [] };
  const casos = [
    [{ 'scripts/ci/product-parity.json': lista }, /no medido: la noche no dejó la paridad/],
    [{}, /la lista de paridad no está en el repo de operaciones/],
    [{ 'scripts/ci/product-parity.json': { sin_productos: 'copia pública', grupos: {}, rasgos: [], diferencias_declaradas: [] } }, /sin productos/],
    [{ 'scripts/ci/product-parity.json': '{ rota' }, /no se pudo leer|no es JSON/],
  ];
  for (const [archivos, rx] of casos) {
    await conPestana({ fuentes: fuentesCon({ ops: clon({ 'operations.json': opsBase(), ...archivos }) }) }, async ({ h, entrar }) => {
      const p = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json.secciones.find((s) => s.id === 'paridad');
      assert.match(`${p.motivo || ''} ${p.vista ? p.vista.texto : ''}`, rx, JSON.stringify(p));
    });
  }
});

test('T36 Proyectos_SinDetalleDeParidad @story-2.29 @ac-28', async () => {
  const modelo = { productos: [{ producto: 'A', proyectos: ['P'], rutas: ['a/f'] }], productosFuente: { estado: 'medido' }, proyectos: { estado: 'medido', lista: [] }, paridad: { estado: 'medido', fecha: HOY, por_ruta: [{ ruta: 'a/f', estado: 'medido', divergencias: 1, vencidas: 0 }], divergencias: [{ que: 'marcador-que', tienen: ['x'], no_tienen: ['a/f'] }] } };
  const fuentes = fuentesCon({ ops: clon({ 'operations.json': opsBase() }) });
  fuentes.st.modelo = modelo;
  await conPestana({ fuentes }, async ({ h, entrar }) => {
    const r = await h.pedir('/proyectos', { cookie: await entrar(LEAD) });
    assert.strictEqual(r.status, 200);
    assert.match(r.texto, /1 divergencia/);
    for (const x of ['marcador-que', 'no_tienen', 'tienen']) assert.ok(!r.texto.includes(x), `sin ${x}`);
  });
});

// ── proponer desde la pestaña: el repo de operaciones por HTTP y las APIs falsas ─────────────────────────────────
const { crearRepoHttp, hayHttpBackend } = require('./lib/git-http-repo.js');
const SIN_BACKEND = !hayHttpBackend() && !process.env.CI && 'git http-backend no está en esta máquina: el repo por HTTP no se puede armar';
const ESCRITURA = `w-${crypto.randomBytes(6).toString('hex')}`;
const CAB = `Basic ${Buffer.from(`x-access-token:${ESCRITURA}`).toString('base64')}`;

/** El repo de operaciones servido por HTTP y el clon del sitio sobre él (como lo baja sources.js). */
async function opsPorHttp(archivos) {
  const raiz = tmp('site-config-http-');
  const r = await crearRepoHttp({ raiz, nombre: 'ops.git', archivos, cabecera: CAB });
  const dir = path.join(raiz, 'clon-del-sitio');
  // 🔴 asíncrono: el repo HTTP vive en este mismo proceso, y un git sincrónico lo dejaría sin bucle para contestar
  try {
    await require('util').promisify(require('child_process').execFile)('git', ['-c', `http.extraheader=Authorization: ${CAB}`, 'clone', '-q', '--depth', '1', '--branch', 'main', r.url, dir]);
  } catch (e) { await cerrarTodos(r); throw e; } // el clon falló: el servidor no queda abierto colgando la prueba
  return { r, dir };
}

/** Cierra todos los servidores que se llegaron a abrir, aunque uno falle al cerrar; el error de la prueba no se pisa. */
async function cerrarTodos(...servidores) {
  await Promise.allSettled(servidores.filter(Boolean).map((s) => s.cerrar()));
}

test('T16 Proponer_ArchivoCambio_NoCreaNada @story-2.29 @ac-16', { skip: SIN_BACKEND }, async () => {
  const { arrancarGithubFalso } = require('./lib/fake-github-api.js');
  // 🔴 todo servidor nace dentro del try: si el clon falla, el finally los cierra y la prueba no se cuelga (Windows)
  let gh, r, dir;
  const remotos = { operaciones: { platform: 'github', org: 'acme', repo: 'ops', web: 'https://github.example/acme/ops' } };
  try {
    gh = await arrancarGithubFalso({ owner: 'acme', repo: 'ops' });
    gh.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 1 } };
    ({ r, dir } = await opsPorHttp({ 'operations.json': opsBase() }));
    await conPestana({ fuentes: fuentesCon({ ops: dir }), env: { SITE_OPERATIONS_WRITE_TOKEN: ESCRITURA }, opciones: { remotos, urlBase: { github: gh.base } } }, async ({ h, entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      const abierta = (await h.pedir('/api/config', { cookie: lead })).json;
      assert.strictEqual(abierta.proponer.operaciones.habilitado, true, JSON.stringify(abierta.proponer));
      const s = abierta.secciones.find((x) => x.id === 'responsables');
      const rev = (await escribir('/api/config/revisar', lead, tok, { seccion: 'responsables', borrador: { owners: { default: 'otro@acme.example' } } })).json;
      // otro commit cambia operations.json en main después de abrir la sección
      r.cambiar({ 'operations.json': ORG.formatJson(opsBase({ owners: { default: 'alguien@acme.example' } })) });
      const p = (await escribir('/api/config/proponer', lead, tok, { seccion: 'responsables', texto: rev.texto, oid: s.oid })).json;
      assert.strictEqual(p.ok, false);
      assert.match(p.message, /el archivo cambió desde que lo abriste: recargá/);
      assert.deepStrictEqual(r.empujes, [], 'cero ramas');
      assert.strictEqual(g(dir, 'status', '--porcelain'), '', 'el clon limpio');
      assert.strictEqual(g(dir, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
    });
  } finally { await cerrarTodos(r, gh); }
});

test('T39b Pestana_ProponerArchivoPorArchivo_ConElFiltroDeRuta @story-2.30 @ac-22b', { skip: SIN_BACKEND }, async () => {
  // con una «Required reviewers» que sólo cubre operations.json, la pantalla recibe el estado de cada archivo
  const { arrancarAdoFalso } = require('./lib/fake-ado-api.js');
  let ado, r, dir;
  const remotos = { operaciones: { platform: 'azure', org: 'acme', project: 'Proy', repo: 'ops', web: 'https://dev.azure.com/acme/Proy/_git/ops' } };
  try {
    ado = await arrancarAdoFalso({ org: 'acme', project: 'Proy', repo: 'ops' });
    ado.st.politicas = [{ isEnabled: true, isBlocking: true, type: { displayName: 'Required reviewers' },
      settings: { minimumApproverCount: 1, creatorVoteCounts: false, addedFilesOnly: false, requiredReviewerIds: ['grupo-de-quienes-mantienen'], filenamePatterns: ['/operations.json', '/pipelines/*'], scope: [{ refName: 'refs/heads/main', matchKind: 'Exact', repositoryId: ado.st.repoId }] } }];
    ({ r, dir } = await opsPorHttp({ 'operations.json': opsBase() }));
    await conPestana({ fuentes: fuentesCon({ ops: dir }), env: { SITE_OPERATIONS_WRITE_TOKEN: ESCRITURA }, opciones: { remotos, urlBase: { azure: ado.base } } }, async ({ h, entrar }) => {
      const lead = await entrar(LEAD);
      const p = (await h.pedir('/api/config', { cookie: lead })).json.proponer.operaciones;
      assert.strictEqual(p.porArchivo['operations.json'].habilitado, true, JSON.stringify(p));
      const umbrales = p.porArchivo['scripts/nightly/dashboard/sources.json'];
      assert.strictEqual(umbrales.habilitado, false, JSON.stringify(p));
      assert.match(umbrales.motivo, /la política de main no cubre scripts\/nightly\/dashboard\/sources\.json/);
      assert.strictEqual(p.habilitado, false, 'el estado del repo entero dice que no todo se propone');
    });
  } finally { await cerrarTodos(r, ado); }
});

test('T39c Pestana_ProponerPorArchivo_ConElNombreViejoDelPerfil @story-2.30 @ac-22b', async () => {
  // el perfil todavía usa el nombre de antes (perfil-equipo.json): la sección lee y propone sobre ése, así que el estado de
  // «Proponer» tiene que estar también con ese nombre (la pantalla lo busca con el archivo que la sección resolvió)
  const { arrancarAdoFalso } = require('./lib/fake-ado-api.js');
  const ops = clon({ 'operations.json': opsBase() });
  const perfil = clon({ 'team-repos.json': TR_BASE, 'team-layer.json': capa(ORG.MODELS_SINCE), 'perfil-equipo.json': {} });
  const remotos = { perfil: { platform: 'azure', org: 'acme', project: 'Proy', repo: 'perfil', web: 'https://dev.azure.com/acme/Proy/_git/perfil' } };
  let ado;
  try {
    ado = await arrancarAdoFalso({ org: 'acme', project: 'Proy', repo: 'perfil' });
    ado.st.politicas = [{ isEnabled: true, isBlocking: true, type: { displayName: 'Required reviewers' },
      settings: { minimumApproverCount: 1, creatorVoteCounts: false, addedFilesOnly: false, requiredReviewerIds: ['grupo-de-quienes-mantienen'], filenamePatterns: ['/perfil-equipo.json'], scope: [{ refName: 'refs/heads/main', matchKind: 'Exact', repositoryId: ado.st.repoId }] } }];
    await conPestana({ fuentes: fuentesCon({ ops, perfil }), env: { ...PERFIL_ENV, SITE_PROFILE_WRITE_TOKEN: 'w' }, opciones: { remotos, urlBase: { azure: ado.base } } }, async ({ h, entrar }) => {
      const lead = await entrar(LEAD);
      const r = (await h.pedir('/api/config', { cookie: lead })).json;
      const sec = r.secciones.find((s) => s.id === 'paquetes');
      assert.strictEqual(sec.archivo, 'perfil-equipo.json', 'la sección resolvió el nombre viejo');
      const p = r.proponer.perfil;
      assert.ok(p.porArchivo && p.porArchivo['perfil-equipo.json'], JSON.stringify(p));
      assert.strictEqual(p.porArchivo['perfil-equipo.json'].habilitado, true, JSON.stringify(p));
      // y el nombre nuevo, que el filtro no cubre, no sale habilitado
      assert.strictEqual(p.porArchivo['team-profile.json'].habilitado, false, JSON.stringify(p));
    });
  } finally { await cerrarTodos(ado); }
});

test('T24 Github_MismaPestana_SegundoProveedor @story-2.29 @ac-22', { skip: SIN_BACKEND }, async () => {
  const { arrancarGithubFalso } = require('./lib/fake-github-api.js');
  const perfil = clon({ 'team-repos.json': { version: 1 }, 'team-layer.json': { requires: { harness: `>= ${ORG.TEAM_REPOS_SINCE}` } } });
  const remotos = { operaciones: { platform: 'github', org: 'acme', repo: 'ops', web: 'https://github.example/acme/ops' }, perfil: { platform: 'github', org: 'acme', repo: 'perfil', web: 'https://github.example/acme/perfil' } };
  let gh, r, dir;
  try {
    gh = await arrancarGithubFalso({ owner: 'acme', repo: 'ops' });
    gh.st.reglas = [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }];
    ({ r, dir } = await opsPorHttp({ 'operations.json': opsBase(), 'scripts/nightly/dashboard/sources.json': SOURCES_ORG, '.dashboard/applied-config.json': { files: { 'scripts/nightly/dashboard/sources.json': 'x' } }, 'scripts/ci/product-parity.json': { grupos: {}, rasgos: [], diferencias_declaradas: [] } }));
    await conPestana({ fuentes: fuentesCon({ ops: dir, perfil }), env: { SITE_OPERATIONS_WRITE_TOKEN: ESCRITURA, SITE_PROFILE_REPO: 'https://git.acme.example/perfil.git', SITE_PROFILE_TOKEN: 't' }, opciones: { remotos, urlBase: { github: gh.base } } }, async ({ h, entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      const r0 = (await h.pedir('/api/config', { cookie: lead })).json;
      assert.deepStrictEqual(r0.secciones.map((s) => s.id), ORG.SECCIONES.map((s) => s.id), 'las ocho secciones leen');
      assert.ok(r0.secciones.filter((s) => !['despliegues', 'canal'].includes(s.id)).every((s) => !['no_reader', 'ilegible'].includes(s.estado)), JSON.stringify(r0.secciones.map((s) => [s.id, s.estado])));
      assert.strictEqual(r0.proponer.operaciones.habilitado, true);
      const s = r0.secciones.find((x) => x.id === 'responsables');
      const rev = (await escribir('/api/config/revisar', lead, tok, { seccion: 'responsables', borrador: { owners: { default: 'otro@acme.example' } } })).json;
      const p = (await escribir('/api/config/proponer', lead, tok, { seccion: 'responsables', texto: rev.texto, oid: s.oid })).json;
      assert.strictEqual(p.ok, true, p.message);
      assert.match(p.enlace, /^https:\/\/github\.example\/acme\/ops\/pull\/\d+$/);
      assert.strictEqual(r.empujes.length, 1);
      assert.match(r.empujes[0].ref, /^refs\/heads\/team-config\/operations-\d{8}-\d{6}$/);
      assert.strictEqual(r.empujes[0].forzado, false);
      const pedido = gh.llamadas.find((c) => c.method === 'POST' && /\/pulls$/.test(c.ruta));
      assert.match(JSON.stringify(pedido.cuerpo), /Pedido por lead@acme\.example desde el sitio/);
      assert.deepStrictEqual(gh.prohibidas(), [], 'nunca merge ni auto-merge');
      assert.strictEqual(g(dir, 'status', '--porcelain'), '');
    });
  } finally { await cerrarTodos(r, gh); }
});

// ── vuelta 2 (revisores y pase adversarial de la 2.29) ───────────────────────────────────────────────────────────
test('T31b Paridad_DivergenciasPorNombreDeProducto @story-2.29 @ac-25 — el control nombra cada repo por su producto (o «producto (ruta)»), no por la ruta', () => {
  const lista = { grupos: { backend: [{ ruta: 'Acme/Back', producto: 'Acme' }, { ruta: 'Beta/Back', producto: 'Beta' }, { ruta: 'Gama/Back', producto: 'Gama' }, { ruta: 'Gama/Back2', producto: 'Gama' }] }, rasgos: [], diferencias_declaradas: [] };
  const resultado = { fecha: HOY, estado: 'medido', divergencias: [{ grupo: 'backend', rasgo: 'r1', que: 'el rasgo uno', tienen: ['Acme', 'Beta'], no_tienen: ['Gama (Gama/Back)'] }] };
  const v = ORG.paridadPorProducto({ lista, resultado, hoy: HOY });
  assert.deepStrictEqual(v.productos.find((p) => p.producto === 'Gama').faltan.map((x) => x.que), ['el rasgo uno']);
  assert.deepStrictEqual(v.productos.find((p) => p.producto === 'Acme').faltan, []);
});

test('T8b Stages_DeOtroProyecto_ProyectoBarraNumero @story-2.29 @ac-8 — la definición se busca en el proyecto que se nombra', async () => {
  const RP = require(path.join(ROOT, 'scripts', 'lib', 'repo-proposal.js'));
  const urls = [];
  const f = async (url) => { urls.push(String(url)); return new Response(JSON.stringify({ value: [] }), { status: 200 }); };
  const remote = { platform: 'azure', org: 'acme', project: 'ops-proj', repo: 'ops', web: 'x' };
  await RP.stagesPropuestos({ pipeline: 'producto-x/42', remote, token: 't', urlBase: { azure: 'http://127.0.0.1:9' }, fetch: f });
  assert.match(urls[0], /\/acme\/producto-x\/_apis\/build\/builds\?definitions=42&/);
  urls.length = 0;
  await RP.stagesPropuestos({ pipeline: '42', remote, token: 't', urlBase: { azure: 'http://127.0.0.1:9' }, fetch: f });
  assert.match(urls[0], /\/acme\/ops-proj\/_apis\//, 'sólo el número: el proyecto del repo de operaciones');
});

test('T22b Proponer_ExigeLaVersionYSoloLaSeccion @story-2.29 @ac-16 @ac-23 — sin oid no propone; un cambio fuera de la sección tampoco', async () => {
  const ops = clon({ 'operations.json': opsBase({ reviewers: { watcher: ['w@acme.example'] } }) });
  await conPestana({ fuentes: fuentesCon({ ops }), env: { SITE_OPERATIONS_WRITE_TOKEN: 'w' }, opciones: { remotos: { operaciones: { platform: 'github', org: 'acme', repo: 'ops', web: 'https://github.example/acme/ops' } }, fetch: async () => { throw new Error('no debería salir a la red'); } } }, async ({ h, entrar, token, escribir }) => {
    const lead = await entrar(LEAD); const tok = await token(lead);
    const s = (await h.pedir('/api/config', { cookie: lead })).json.secciones.find((x) => x.id === 'responsables');
    const rev = (await escribir('/api/config/revisar', lead, tok, { seccion: 'responsables', borrador: { owners: { default: 'otro@acme.example' }, reviewers: { watcher: ['w@acme.example'] } } })).json;
    const sinOid = (await escribir('/api/config/proponer', lead, tok, { seccion: 'responsables', texto: rev.texto })).json;
    assert.strictEqual(sinOid.ok, false); assert.match(sinOid.message, /falta la versión del archivo que abriste: recargá/);
    const otro = JSON.parse(rev.texto); otro.site.maintainers.push('intruso@acme.example');
    const fuera = (await escribir('/api/config/proponer', lead, tok, { seccion: 'responsables', texto: ORG.formatJson(otro), oid: s.oid })).json;
    assert.strictEqual(fuera.ok, false); assert.match(fuera.message, /cambia site, que no es de esta sección/);
  });
});

test('T5b Lecturas_IlegiblesDicenElMotivo @story-2.29 @ac-5 @ac-7 @ac-11 @ac-25 — «no se pudo leer» nunca se muestra como vacío o «todavía no»', async (t) => {
  const ops = clon({ 'operations.json': opsBase(), 'scripts/nightly/dependencies/repos.json': '{ roto', 'scripts/nightly/dashboard/sources.json': SOURCES_ORG, '.dashboard/applied-config.json': '{ roto', 'scripts/ci/product-parity.json': { grupos: {}, rasgos: [], diferencias_declaradas: [] }, [`.dashboard/paridad/paridad-${HOY}.json`]: '{ roto' });
  await conPestana({ fuentes: fuentesCon({ ops }), opciones: { hoy: () => HOY } }, async ({ h, entrar }) => {
    const r = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json;
    assert.match(r.productosMotivo || '', /repos\.json\) no se pudo leer/);
    const u = r.secciones.find((s) => s.id === 'umbrales');
    assert.match(u.motivo, /la marca .*applied-config\.json.* no se pudo leer/);
    const p = r.secciones.find((s) => s.id === 'paridad');
    assert.match(p.vista.texto, /no se pudo leer el resultado de hoy/);
  });
  // el espejo del buzón con una carpeta de registros que no se puede leer: la máquina sale «no medido», no desaparece.
  // Como administrador los permisos no frenan la lectura: ese caso no se puede armar y se dice, no pasa en silencio
  if (process.getuid && process.getuid() === 0) { t.diagnostic('NO MEDIDO: corriendo como root, una carpeta sin permisos se lee igual'); return; }
  // en Windows chmod no quita el permiso de lectura: la carpeta «ilegible» no se puede armar, y se dice
  if (process.platform === 'win32') { t.diagnostic('NO MEDIDO: en Windows chmod no saca la lectura, una carpeta «sin permisos» se lee igual'); return; }
  const espejo = tmp('site-config-espejo-');
  fs.mkdirSync(path.join(espejo, 'maq-z', 'registros'), { recursive: true });
  fs.chmodSync(path.join(espejo, 'maq-z', 'registros'), 0o000);
  try {
    const filas = ORG.versionesDeMaquinas({ espejo, versionImagen: '2026.10.15.48', ahora: AHORA });
    assert.deepStrictEqual(filas.map((x) => [x.maquina, x.estado]), [['maq-z', 'no_medido']]);
  } finally { fs.chmodSync(path.join(espejo, 'maq-z', 'registros'), 0o755); }
});

/** Corre el código de pantalla con un documento mínimo y el `fetch` dado; devuelve el texto que quedó en la pestaña. */
async function correrPantalla(fetchFalso) {
  const nodo = () => { const n = { hijos: [], textContent: '', attrs: {}, setAttribute(k, v) { n.attrs[k] = v; }, appendChild(c) { n.hijos.push(c); return c; }, addEventListener() {}, replaceChildren(...cs) { n.hijos = cs; } }; return n; };
  const app = nodo();
  const document = { querySelector: () => null, getElementById: (id) => (id === 'config-app' ? app : null), createElement: () => nodo() };
  new Function('document', 'fetch', ORG.pantalla())(document, fetchFalso);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const textos = (n) => [n.textContent, ...(n.hijos || []).flatMap(textos)].filter(Boolean);
  return textos(app).join(' | ');
}

test('T4b Pantalla_UnPedidoCortadoNoQuedaColgado @story-2.29 @ac-18 — la llamada de la pantalla siempre termina con un mensaje', async () => {
  const cortado = await correrPantalla(() => Promise.reject(new Error('se cortó la red')));
  assert.match(cortado, /no pude hablar con el sitio \(se cortó la red\)/);
  const noJson = await correrPantalla(() => Promise.resolve({ status: 502, json: () => Promise.reject(new Error('no es JSON')) }));
  assert.match(noJson, /respuesta 502/);
});

test('T8c Stages_NombresDePuntos_Rechazados @story-2.29 @ac-8 — un proyecto, dueño o repo «.» o «..» no arma una ruta que sube de nivel', async () => {
  const RP = require(path.join(ROOT, 'scripts', 'lib', 'repo-proposal.js'));
  const urls = [];
  const f = async (url) => { urls.push(String(url)); return new Response('{}', { status: 200 }); };
  const remote = { platform: 'azure', org: 'acme', project: 'ops-proj', repo: 'ops', web: 'x' };
  for (const p of ['../1', './1', '../repo', 'acme/..', '../..']) {
    const r = await RP.stagesPropuestos({ pipeline: p, remote, token: 't', urlBase: { azure: 'http://127.0.0.1:9', github: 'http://127.0.0.1:9' }, fetch: f });
    assert.strictEqual(r.ok, false, p);
    assert.match(r.message, /no reconozco el pipeline/, p);
  }
  assert.deepStrictEqual(urls, [], 'ninguna llamada');
});

test('T28c Umbrales_SoloLectura_ControlesApagados — una sección «sólo para mirar» no ofrece nada que parezca editable', async () => {
  const creados = [];
  const nodo = (tag) => { const n = { tag, hijos: [], textContent: '', attrs: {}, setAttribute(k, v) { n.attrs[k] = v; }, appendChild(c) { n.hijos.push(c); return c; }, addEventListener() {}, replaceChildren(...cs) { n.hijos = cs; } }; creados.push(n); return n; };
  const app = nodo('div');
  const document = { querySelector: () => null, getElementById: (id) => (id === 'config-app' ? app : null), createElement: (t) => nodo(t) };
  const umbrales = (soloLectura) => ({ id: 'umbrales', titulo: 'Umbrales', repo: 'operaciones', estado: 'cargado', soloLectura, motivo: soloLectura ? 'tu nocturno todavía no lee este archivo' : null, borrador: { thresholds: { suites_rojas: { direction: 'menor_es_mejor', ok_max: 0, bad_min: 3 } } }, problems: [], avisos: [] });
  const correr = async (soloLectura) => {
    creados.length = 0;
    const respuesta = { ok: true, secciones: [umbrales(soloLectura), { id: 'canal', titulo: 'Canal', repo: 'operaciones', estado: 'cargado', soloLectura: false, borrador: { notify: 'x' }, problems: [], avisos: [] }], proponer: {}, versiones: [], productos: [] };
    new Function('document', 'fetch', ORG.pantalla())(document, () => Promise.resolve({ status: 200, json: () => Promise.resolve(respuesta) }));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const dentro = (n, id) => { const out = []; const walk = (x) => { out.push(x); (x.hijos || []).forEach(walk); }; walk(n); return out; };
    const sec = (id) => creados.find((n) => n.attrs.id === `seccion-${id}`);
    const controles = (id) => dentro(sec(id)).filter((n) => ['input', 'select', 'textarea', 'button'].includes(n.tag));
    return { umb: controles('umbrales'), canal: controles('canal') };
  };
  const solo = await correr(true);
  assert.ok(solo.umb.some((n) => n.tag === 'select') && solo.umb.some((n) => n.tag === 'input'), 'el editor de umbrales se dibuja');
  for (const n of solo.umb) assert.strictEqual(n.attrs.disabled, 'disabled', `${n.tag} ${n.attrs['data-path'] || n.textContent} apagado`);
  assert.ok(solo.canal.some((n) => n.tag === 'textarea' && !n.attrs.disabled), 'la sección vecina, editable, no se contagia');
  const editable = await correr(false);
  assert.ok(editable.umb.filter((n) => n.tag !== 'button').every((n) => !n.attrs.disabled), 'sin sólo lectura, los campos se editan');
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'static', 'site.css'), 'utf8'), /\.form-block select:disabled[^{]*\{[^}]*opacity/, 'y se ven apagados');
});

// ── tanda C: dónde corren las suites al mergear (7.28) y los modelos de cada trabajo (7.29) ──────────────────────
const GH = (repo) => ({ platform: 'github', org: 'acme', repo });
const TR_BASE = { version: 1, public: GH('harness'), profile: GH('profile'), operations: GH('ops') };
const PERFIL_ENV = { SITE_PROFILE_REPO: 'https://git.acme.example/perfil.git', SITE_PROFILE_TOKEN: 't' };
const capa = (v) => ({ requires: { harness: `>= ${v}` } });
/** La pestaña con el perfil: `team-repos.json` y `team-layer.json` dados; `fn` recibe lo mismo que conPestana más `seccion(id)`. */
async function conPerfil({ repos = TR_BASE, layer = capa(ORG.MODELS_SINCE), lectores = {} } = {}, fn) {
  const ops = clon({ 'operations.json': opsBase() });
  const perfil = clon({ 'team-repos.json': repos, 'team-layer.json': layer });
  await conPestana({ fuentes: fuentesCon({ ops, perfil }), env: PERFIL_ENV, opciones: { lectores } }, async (ctx) => {
    const lead = await ctx.entrar(LEAD); const tok = await ctx.token(lead);
    const estado = async () => (await ctx.h.pedir('/api/config', { cookie: lead })).json;
    const seccion = async (id) => (await estado()).secciones.find((s) => s.id === id);
    const revisar = async (id, borrador) => (await ctx.escribir('/api/config/revisar', lead, tok, { seccion: id, borrador })).json;
    const proponer = async (id, texto) => { const s = await seccion(id); return (await ctx.escribir('/api/config/proponer', lead, tok, { seccion: id, texto, oid: s.oid })).json; };
    await fn({ ...ctx, lead, tok, estado, seccion, revisar, proponer });
  });
}
// sin la credencial de escritura del perfil, «Proponer» llega hasta ahí sólo si el archivo pasó el lector y el portón
const PASO_EL_PORTON = /sin identidad de escritura/;
const SUITES_OK = { merge_suites: { default: 'automatico', repos: [{ repo: GH('app'), rule: 'confiar-en-el-servidor', full_tests_pipeline: 'pruebas-completas' }] } };

test('7.28-T19 MergeSuites_SectionSavedOnlyThroughReader @story-7.28 @ac-12 — la sección en la pestaña; se propone sólo lo que acepta el lector', async () => {
  const s = ORG.seccionPorId('suites');
  assert.ok(s, 'hay una sección de las suites al mergear');
  assert.deepStrictEqual([s.archivo, s.repo, s.lector, s.claves], ['team-repos.json', 'perfil', 'team-repos.js', ['merge_suites']]);
  await conPerfil({ repos: { ...TR_BASE, ...SUITES_OK } }, async ({ seccion, revisar, proponer }) => {
    const v = await seccion('suites');
    assert.strictEqual(v.estado, 'cargado', JSON.stringify(v));
    assert.deepStrictEqual(v.borrador, SUITES_OK, 'la regla y las filas del archivo');
    const nuevo = { merge_suites: { default: 'siempre-en-la-maquina', repos: SUITES_OK.merge_suites.repos } };
    const ok = await revisar('suites', nuevo);
    assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));
    assert.deepStrictEqual(JSON.parse(ok.texto), { ...TR_BASE, ...nuevo }, 'el resto del archivo igual');
    assert.match((await proponer('suites', ok.texto)).message, PASO_EL_PORTON);
    const malo = await revisar('suites', { merge_suites: { repos: [{ repo: GH('app'), rule: 'inventada' }] } });
    assert.strictEqual(malo.ok, false);
    assert.deepStrictEqual(malo.problems.map((p) => p.path), ['merge_suites.repos.0.rule']);
    assert.strictEqual(malo.texto, null);
    // y por «Proponer» directo, sin pasar por «Revisar»: el lector lo rechaza igual
    const directo = await proponer('suites', ORG.formatJson({ ...TR_BASE, merge_suites: { repos: [{ repo: GH('app'), rule: 'inventada' }] } }));
    assert.strictEqual(directo.ok, false); assert.match(directo.message, /merge_suites\.repos\.0\.rule/);
  });
  // un lector de antes de la 7.28 no conoce la clave: la sección no edita y lo dice
  const viejo = { ...TR, KEYS: TR.KEYS.filter((k) => k !== 'merge_suites' && k !== 'models') };
  await conPerfil({ lectores: { 'team-repos.js': viejo } }, async ({ seccion }) => {
    for (const id of ['suites', 'modelos']) {
      const v = await seccion(id);
      assert.strictEqual(v.estado, 'no_reader');
      assert.match(v.motivo, /todavía no sabe leer team-repos\.json → (merge_suites|models)/);
    }
    assert.strictEqual((await seccion('repos')).estado, 'cargado', 'la de los repos sigue editable');
  });
});

test('7.28-T20 MergeSuites_ProposalGatedBySince @story-7.28 @ac-12 — sin la versión que lee merge_suites, no se propone y se dice qué subir', async () => {
  assert.ok(ORG.versionAtLeast(ORG.MERGE_SUITES_SINCE, ORG.TEAM_REPOS_SINCE) && ORG.MERGE_SUITES_SINCE !== ORG.TEAM_REPOS_SINCE);
  const conSuites = { ...TR_BASE, ...SUITES_OK };
  const bajo = ORG.profileGateProblem(JSON.stringify(capa(ORG.TEAM_REPOS_SINCE)), conSuites);
  assert.match(bajo, /todavía no se puede proponer/);
  assert.match(bajo, /merge_suites/);
  assert.ok(bajo.includes(`>= ${ORG.MERGE_SUITES_SINCE}`), bajo);
  assert.strictEqual(ORG.profileGateProblem(JSON.stringify(capa(ORG.MERGE_SUITES_SINCE)), conSuites), null);
  assert.strictEqual(ORG.profileGateProblem(JSON.stringify(capa(ORG.TEAM_REPOS_SINCE)), TR_BASE), null, 'sin merge_suites, el portón de siempre');
  assert.strictEqual(ORG.profileGateProblem(JSON.stringify(capa(ORG.TEAM_REPOS_SINCE))), null, 'sin archivo, como antes');
  // por la pestaña: el mismo archivo, con cada versión del perfil
  for (const [v, espera] of [[ORG.TEAM_REPOS_SINCE, /todavía no se puede proponer.*merge_suites/], [ORG.MERGE_SUITES_SINCE, PASO_EL_PORTON]]) {
    await conPerfil({ layer: capa(v) }, async ({ revisar, proponer }) => {
      const r = await revisar('suites', SUITES_OK);
      assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
      assert.match((await proponer('suites', r.texto)).message, espera);
    });
  }
  await conPerfil({ layer: capa(ORG.TEAM_REPOS_SINCE) }, async ({ revisar, proponer }) => {
    const r = await revisar('repos', { ...TR_BASE, maintainers: GH('maint') });
    assert.match((await proponer('repos', r.texto)).message, PASO_EL_PORTON, 'sin merge_suites, los repos se proponen con la versión de siempre');
  });
  // el portón mira el archivo entero que se propone: editar los repos con merge_suites ya en el archivo también lo pide
  await conPerfil({ repos: { ...TR_BASE, ...SUITES_OK }, layer: capa(ORG.TEAM_REPOS_SINCE) }, async ({ revisar, proponer }) => {
    const r = await revisar('repos', { ...TR_BASE, ...SUITES_OK, maintainers: GH('maint') });
    assert.match((await proponer('repos', r.texto)).message, /todavía no se puede proponer.*merge_suites/);
  });
});

test('7.29-T22 Config_Modelos_SeccionPorLosDosTransportes @story-7.29 @ac-5 — «hoy: …» de los valores del árbol; se propone sólo lo válido', async () => {
  const s = ORG.seccionPorId('modelos');
  assert.ok(s, 'hay una sección de modelos');
  assert.deepStrictEqual([s.archivo, s.repo, s.lector, s.claves], ['team-repos.json', 'perfil', 'team-repos.js', ['models']]);
  const MOD = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'models.js'));
  assert.deepStrictEqual(ORG.modelosDeHoy(ROOT), MOD.DEFAULTS, 'los de hoy salen de models.js del árbol');
  assert.strictEqual(ORG.modelosDeHoy(tmp('site-config-sin-skill-')), null, 'un árbol sin el skill: no se inventan');
  assert.match(ORG.motivoDeHoy(tmp('site-config-sin-skill-')), /no trae los skills/);
  // un models.js que no carga no se confunde con uno que falta: el motivo lo dice
  const roto = tmp('site-config-models-roto-');
  fs.mkdirSync(path.join(roto, 'skills', 'x', 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(roto, 'skills', 'x', 'scripts', 'lib', 'models.js'), 'throw new Error("roto a propósito");\n');
  assert.strictEqual(ORG.modelosDeHoy(roto), null);
  assert.match(ORG.motivoDeHoy(roto), /no pude cargar skills\/x\/scripts\/lib\/models\.js \(roto a propósito\)/);
  // la pantalla dibuja «sin declarar (hoy: …)» con los de hoy que le da la vista (pantallaFalsa está más abajo)
  const p = await pantallaFalsa([{ id: 'modelos', titulo: 'm', repo: 'perfil', estado: 'cargado', borrador: {}, problems: [], avisos: [], extras: { hoy: MOD.DEFAULTS } }]);
  const opciones = p.todo(p.sec('modelos')).filter((n) => n.tag === 'option').map((n) => n.textContent);
  assert.ok(opciones.includes(`sin declarar (hoy: ${MOD.DEFAULTS.reviewers})`) && opciones.includes(`sin declarar (hoy: ${MOD.DEFAULTS.session.heavy})`), opciones.join(' · '));
  await conPerfil({}, async ({ seccion, revisar, proponer }) => {
    const v = await seccion('modelos');
    assert.strictEqual(v.estado, 'cargado', JSON.stringify(v));
    assert.deepStrictEqual(v.borrador, {}, 'sin models en el archivo');
    assert.strictEqual(v.extras.hoy.reviewers, 'sonnet');
    const ok = await revisar('modelos', { models: { reviewers: 'opus', helpers: 'haiku' } });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));
    assert.match((await proponer('modelos', ok.texto)).message, PASO_EL_PORTON);
    const malo = await revisar('modelos', { models: { reviewers: 'Opus' } });
    assert.strictEqual(malo.ok, false);
    assert.deepStrictEqual(malo.problems.map((p) => p.path), ['models.reviewers']);
  });
});

test('7.29-T23 Config_Modelos_PortonDeVersion @story-7.29 @ac-5 — con varias claves nuevas, la versión mayor', async () => {
  assert.ok(ORG.versionAtLeast(ORG.MODELS_SINCE, ORG.MERGE_SUITES_SINCE) && ORG.MODELS_SINCE !== ORG.MERGE_SUITES_SINCE);
  const conModelos = { ...TR_BASE, models: { reviewers: 'opus' } };
  const g = (v, doc) => ORG.profileGateProblem(JSON.stringify(capa(v)), doc);
  const bajo = g(ORG.TEAM_REPOS_SINCE, conModelos);
  assert.match(bajo, /todavía no se puede proponer/); assert.match(bajo, /models/); assert.ok(bajo.includes(`>= ${ORG.MODELS_SINCE}`), bajo);
  assert.strictEqual(g(ORG.MODELS_SINCE, conModelos), null);
  assert.strictEqual(g(ORG.TEAM_REPOS_SINCE, TR_BASE), null);
  const ambas = g(ORG.MERGE_SUITES_SINCE, { ...conModelos, ...SUITES_OK });
  assert.ok(ambas && ambas.includes(`>= ${ORG.MODELS_SINCE}`), `exige la mayor: ${ambas}`);
  assert.strictEqual(g(ORG.MODELS_SINCE, { ...conModelos, ...SUITES_OK }), null);
  await conPerfil({ layer: capa(ORG.MERGE_SUITES_SINCE) }, async ({ revisar, proponer }) => {
    const r = await revisar('modelos', { models: { reviewers: 'opus' } });
    assert.match((await proponer('modelos', r.texto)).message, new RegExp(`todavía no se puede proponer.*>= ${ORG.MODELS_SINCE.replace(/\./g, '\\.')}`));
  });
});

test('T37 Modelos_ProblemaDeSeccion_NoSePropone @story-2.29 @ac-4 — el lector da ok con un modelo mal escrito; la pestaña no lo deja pasar', async () => {
  const roto = { ...TR_BASE, models: { reviewers: 'gpt' } };
  assert.strictEqual(TR.parse(ORG.formatJson(roto)).ok, true, 'el lector lo tolera (decisión 13 de la 7.29)');
  const r = ORG.revisar({ seccion: 'modelos', texto: ORG.formatJson(TR_BASE), borrador: { models: { reviewers: 'gpt' } }, lectores: { 'team-repos.js': TR } });
  assert.strictEqual(r.ok, false); assert.deepStrictEqual(r.problems.map((p) => p.path), ['models.reviewers']); assert.strictEqual(r.texto, null);
  await conPerfil({ repos: roto }, async ({ seccion, revisar, proponer }) => {
    const v = await seccion('modelos');
    assert.deepStrictEqual(v.problems.map((p) => p.path), ['models.reviewers'], 'la vista muestra el problema del archivo');
    const directo = await proponer('modelos', ORG.formatJson({ ...roto, models: { reviewers: 'gpt', helpers: 'haiku' } }));
    assert.strictEqual(directo.ok, false); assert.match(directo.message, /models\.reviewers/);
    // la sección de los repos no toca models: con models roto en el archivo, se propone igual
    const rep = await revisar('repos', { ...roto, maintainers: GH('maint') });
    assert.strictEqual(rep.ok, true, JSON.stringify(rep.problems));
    assert.match((await proponer('repos', rep.texto)).message, PASO_EL_PORTON);
  });
});

// ── tanda C, pase adversarial: lo que la pantalla de las dos secciones nuevas tiene que aguantar ─────────────────
/** La pantalla real sobre un documento mínimo con eventos: `click(texto, seccion)` aprieta un botón; `pedidos` anota cada fetch. */
async function pantallaFalsa(secciones) {
  const creados = [];
  const nodo = (tag) => { const n = { tag, hijos: [], textContent: '', attrs: {}, on: {}, setAttribute(k, v) { n.attrs[k] = v; }, appendChild(c) { n.hijos.push(c); return c; }, addEventListener(e, f) { n.on[e] = f; }, replaceChildren(...cs) { n.hijos = cs; } }; creados.push(n); return n; };
  const app = nodo('div');
  const document = { querySelector: () => null, getElementById: (id) => (id === 'config-app' ? app : null), createElement: (t) => nodo(t) };
  const pedidos = [];
  const respuesta = { ok: true, secciones, proponer: {}, versiones: [], productos: [] };
  const fetch = (ruta, o) => { pedidos.push({ ruta, cuerpo: o && o.body ? JSON.parse(o.body) : null }); return Promise.resolve({ status: 200, json: () => Promise.resolve(ruta === '/api/config' ? respuesta : { ok: false, problems: [] }) }); };
  let error = null;
  try { new Function('document', 'fetch', ORG.pantalla())(document, fetch); } catch (e) { error = e; }
  const esperar = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  await esperar();
  const todo = (n) => { const out = []; const walk = (x) => { out.push(x); (x.hijos || []).forEach(walk); }; walk(n); return out; };
  const sec = (id) => creados.filter((n) => n.attrs.id === `seccion-${id}`).pop();
  const textoDe = (id) => (sec(id) ? todo(sec(id)).map((n) => n.textContent).join(' | ') : '');
  const click = async (texto, id) => { const b = todo(sec(id)).find((n) => n.tag === 'button' && n.textContent === texto); assert.ok(b, `hay «${texto}» en ${id}`); b.on.click({}); await esperar(); };
  return { error, sec, textoDe, todo, click, pedidos, app };
}
const seccionPerfil = (id, borrador, problems = []) => ({ id, titulo: id, repo: 'perfil', estado: 'cargado', soloLectura: false, motivo: null, borrador, problems, avisos: [], extras: id === 'modelos' ? { hoy: { reviewers: 'sonnet' } } : undefined });

test('T41 Pantalla_SuitesYModelos_TodoProblemaSeVe_YSeEditaComoTexto @story-2.29 @ac-4 (tanda C, pase adversarial) — ningún problema del lector queda sin dibujar', async () => {
  const pm = [['models.ceiling', 'un techo sin techo'], ['models.foo', 'clave desconocida foo'], ['models.session.huge', 'subclave huge'], ['models.adversarial', 'adversarial no es objeto']];
  const ps = [['merge_suites.foo', 'clave desconocida ms'], ['merge_suites.repos.0.extra', 'clave extra'], ['merge_suites.repos.1.repo', 'repo repetido']];
  const p = await pantallaFalsa([
    seccionPerfil('modelos', { models: { ceiling: 'opus', foo: 'x', session: { huge: 'opus' }, adversarial: 'opus' } }, pm.map(([path, message]) => ({ path, message }))),
    seccionPerfil('suites', { merge_suites: { foo: 1, repos: [{ repo: GH('x'), rule: 'automatico', extra: 1 }, { repo: GH('x'), rule: 'automatico' }] } }, ps.map(([path, message]) => ({ path, message }))),
  ]);
  assert.strictEqual(p.error, null);
  for (const [, m] of pm) assert.ok(p.textoDe('modelos').includes(m), `modelos muestra «${m}»`);
  for (const [, m] of ps) assert.ok(p.textoDe('suites').includes(m), `suites muestra «${m}»`);
  for (const id of ['modelos', 'suites']) assert.ok(p.todo(p.sec(id)).some((n) => n.tag === 'textarea'), `${id} se puede editar como texto (para sacar una clave que no tiene campo)`);
});

test('T42 Pantalla_SuitesMalFormado_NoCaeLaPestana @story-2.29 @ac-4 (tanda C, pase adversarial) — un merge_suites con otra forma se edita como texto', async () => {
  for (const ms of ['x', { repos: 'no' }, { repos: [null] }, null]) {
    const p = await pantallaFalsa([seccionPerfil('suites', { merge_suites: ms }, [{ path: 'merge_suites', message: 'forma rara' }]), seccionPerfil('modelos', { models: 'opus' }, [{ path: 'models', message: 'no es objeto' }])]);
    assert.strictEqual(p.error, null, JSON.stringify(ms));
    assert.ok(p.sec('suites') && p.sec('modelos'), `las dos secciones se dibujan con ${JSON.stringify(ms)}`);
    assert.ok(p.todo(p.sec('suites')).some((n) => n.tag === 'textarea'), 'como texto');
    assert.ok(p.textoDe('suites').includes('forma rara') && p.textoDe('modelos').includes('no es objeto'));
  }
});

test('T43 Pantalla_SuitesVacioDelArchivo_NoSeBorra @story-2.29 @ac-4 (tanda C, pase adversarial) — {} ya escrito no es lo mismo que la clave ausente', async () => {
  let p = await pantallaFalsa([seccionPerfil('suites', { merge_suites: {} })]);
  await p.click('Revisar cambios', 'suites');
  const ultimo = p.pedidos.filter((x) => x.ruta === '/api/config/revisar').pop();
  assert.deepStrictEqual(ultimo.cuerpo.borrador, { merge_suites: {} }, 'el {} del archivo viaja tal cual');
  p = await pantallaFalsa([seccionPerfil('suites', {}), seccionPerfil('modelos', {})]);
  await p.click('Revisar cambios', 'suites');
  await p.click('Revisar cambios', 'modelos');
  const rev = p.pedidos.filter((x) => x.ruta === '/api/config/revisar');
  assert.deepStrictEqual(rev.map((x) => x.cuerpo.borrador), [{}, {}], 'sin la clave en el archivo, abrir la sección no la crea');
});

test('T44 Pedido_UnoPorArchivo @story-2.29 @ac-16 (tanda C, pase adversarial) — las secciones de un mismo archivo comparten el identificador de la rama', () => {
  const porArchivo = {};
  for (const s of ORG.SECCIONES) (porArchivo[s.archivo] = porArchivo[s.archivo] || new Set()).add(s.idCorto);
  for (const [archivo, ids] of Object.entries(porArchivo)) assert.strictEqual(ids.size, 1, `${archivo}: ${[...ids].join(', ')}`);
});

test('T45 Revisar_Repos_ReordenarModelsNoEsCambio @story-2.29 @ac-4 (tanda C, pase adversarial) — el orden de las claves no cuenta', () => {
  const actual = { ...TR_BASE, models: { reviewers: 'opux', helpers: 'haiku' } };
  const r = ORG.revisar({ seccion: 'repos', texto: ORG.formatJson(actual), borrador: { ...TR_BASE, maintainers: GH('m'), models: { helpers: 'haiku', reviewers: 'opux' } }, lectores: { 'team-repos.js': TR } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
});

// ── story 2.31: la configuración del equipo, entera desde el sitio ───────────────────────────────────────────────
const TC = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
const PERFIL_TYCON = { __doc: 'perfil de juguete', ado: { org: 'https://dev.azure.com/acme' }, integrations: { clockify: true, engram: true, mailbox: true, codex: 'detect', nightly: true }, update: { channel: 'latest', apply: 'auto', skills_source: 'separate' }, packs: { default: 'all' }, install: { profile: 'full' } };
const CON_RESPUESTA = { ...PERFIL_TYCON, response: { language: 'es', style: 'executive', max_chars: 1300 } };
/** La pestaña con el perfil del equipo (`team-profile.json`) y, si se pide, más archivos en el clon del perfil. */
async function conEquipo({ profile = PERFIL_TYCON, layer = capa(ORG.RESPONSE_SINCE), ops = opsBase(), extra = {}, env = PERFIL_ENV, remotos = {} } = {}, fn) {
  const dirOps = clon({ 'operations.json': ops });
  const perfil = clon({ 'team-profile.json': profile, 'team-layer.json': layer, 'team-repos.json': TR_BASE, ...extra });
  await conPestana({ fuentes: fuentesCon({ ops: dirOps, perfil }), env, opciones: { remotos } }, async (ctx) => {
    const lead = await ctx.entrar(LEAD); const tok = await ctx.token(lead);
    const estado = async () => (await ctx.h.pedir('/api/config', { cookie: lead })).json;
    const seccion = async (id) => (await estado()).secciones.find((s) => s.id === id);
    const revisar = async (id, borrador) => (await ctx.escribir('/api/config/revisar', lead, tok, { seccion: id, borrador })).json;
    const proponer = async (id, texto) => { const s = await seccion(id); return (await ctx.escribir('/api/config/proponer', lead, tok, { seccion: id, texto, oid: s.oid })).json; };
    await fn({ ...ctx, lead, tok, estado, seccion, revisar, proponer });
  });
}

test('2.31-T1 ResponseSection_ShowsCurrentValueAndSource @story-2.31 @ac-1 — idioma, estilo y largo, con el valor vigente y de dónde sale', async () => {
  const s = ORG.seccionPorId('respuesta');
  assert.ok(s, 'hay una sección «Cómo contesta Claude»');
  assert.deepStrictEqual([s.archivo, s.repo, s.lector, s.claves], ['team-profile.json', 'perfil', 'harness-config', ['response']]);
  await conEquipo({ profile: CON_RESPUESTA }, async ({ seccion }) => {
    const v = await seccion('respuesta');
    assert.strictEqual(v.estado, 'cargado', JSON.stringify(v));
    assert.deepStrictEqual(v.borrador, { response: CON_RESPUESTA.response });
    assert.deepStrictEqual(v.extras.vigente, { language: 'es', style: 'executive', max_chars: 1300 });
    assert.deepStrictEqual(v.extras.origen, { language: 'perfil', style: 'perfil', max_chars: 'perfil' });
  });
  await conEquipo({}, async ({ seccion }) => {
    const v = await seccion('respuesta');
    assert.deepStrictEqual(v.extras.vigente, { language: 'es', style: 'neutral', max_chars: TC.TOPE_POR_ESTILO.neutral });
    assert.deepStrictEqual(v.extras.origen, { language: 'por defecto', style: 'por defecto', max_chars: 'del estilo' });
  });
  // la pantalla: los tres estilos con su línea, el idioma y el largo, y lo vigente dicho en llano
  const p = await pantallaFalsa([{ ...seccionPerfil('respuesta', { response: CON_RESPUESTA.response }), extras: { vigente: { language: 'es', style: 'executive', max_chars: 1300 }, origen: { language: 'perfil', style: 'perfil', max_chars: 'perfil' } } }]);
  assert.strictEqual(p.error, null);
  const opciones = p.todo(p.sec('respuesta')).filter((n) => n.tag === 'option').map((n) => n.attrs.value);
  for (const o of ['executive', 'detailed', 'neutral', 'es', 'en']) assert.ok(opciones.includes(o), `opción ${o}: ${opciones}`);
  assert.match(p.textoDe('respuesta'), /Hoy: executive · es · 1300 caracteres \(del perfil\)/);
});

test('2.31-T2 ResponseSection_ProposesOnlyResponseKey_RestByteIdentical @story-2.31 @ac-2 — sólo cambia response; el archivo entero pasa el lector del perfil', async () => {
  const r = ORG.revisar({ seccion: 'respuesta', texto: ORG.formatJson(PERFIL_TYCON), borrador: { response: { language: 'en', style: 'detailed' } }, lectores: { 'harness-config': TC } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  assert.strictEqual(r.texto, ORG.formatJson({ ...PERFIL_TYCON, response: { language: 'en', style: 'detailed' } }), 'el resto del archivo, byte a byte');
  assert.strictEqual(TC.parse(r.texto).ok, true, 'pasa el lector en modo perfil');
  const malo = ORG.revisar({ seccion: 'respuesta', texto: ORG.formatJson(PERFIL_TYCON), borrador: { response: { style: 'fancy', max_chars: 50 } }, lectores: { 'harness-config': TC } });
  assert.strictEqual(malo.ok, false);
  assert.deepStrictEqual(malo.problems.map((p) => p.path).sort(), ['response.max_chars', 'response.style']);
  await conEquipo({}, async ({ revisar, proponer }) => {
    const ok = await revisar('respuesta', { response: { style: 'executive', max_chars: 1300 } });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));
    assert.match((await proponer('respuesta', ok.texto)).message, PASO_EL_PORTON);
  });
});

test('2.31-T6 ResponseSection_OldLayerVersion_DoesNotPropose @story-2.31 @ac-5 — una capa que pide una versión anterior: se ve, no se propone, y se dice por qué', async () => {
  assert.ok(ORG.versionAtLeast(ORG.RESPONSE_SINCE, ORG.MODELS_SINCE) && ORG.RESPONSE_SINCE !== ORG.MODELS_SINCE);
  const viejo = JSON.stringify(capa(ORG.MODELS_SINCE));
  const bajo = ORG.teamProfileGateProblem({ layerText: viejo, versionImagen: '2026.10.15.48', doc: CON_RESPUESTA });
  assert.match(bajo, /todavía no se puede proponer/); assert.match(bajo, /response/); assert.ok(bajo.includes(`>= ${ORG.RESPONSE_SINCE}`), bajo);
  assert.strictEqual(ORG.teamProfileGateProblem({ layerText: JSON.stringify(capa(ORG.RESPONSE_SINCE)), versionImagen: '2026.10.15.48', doc: CON_RESPUESTA }), null);
  assert.strictEqual(ORG.teamProfileGateProblem({ layerText: viejo, versionImagen: '2026.10.15.48', doc: PERFIL_TYCON }), null, 'sin response, cualquier versión lee el perfil');
  await conEquipo({ profile: CON_RESPUESTA, layer: capa(ORG.MODELS_SINCE) }, async ({ seccion, proponer }) => {
    const v = await seccion('respuesta');
    assert.strictEqual(v.soloLectura, true);
    assert.match(v.motivo, /todavía no se puede proponer.*response/);
    assert.deepStrictEqual(v.borrador, { response: CON_RESPUESTA.response }, 'los valores se muestran igual');
    assert.match((await proponer('respuesta', ORG.formatJson({ ...CON_RESPUESTA, response: { style: 'neutral' } }))).message, /todavía no se puede proponer/);
    // las otras secciones del perfil no dependen de response
    assert.notStrictEqual((await seccion('actualizacion')).soloLectura, true);
  });
});

test('2.31-T11 NewSections_ValidateWithMachineReader_RejectPersonalValues @story-2.31 @ac-10 @ac-11 @ac-12 @ac-13 @ac-16 — cada sección cambia sólo sus hojas y valida con el lector de la máquina', () => {
  const rev = (seccion, borrador) => ORG.revisar({ seccion, texto: ORG.formatJson(PERFIL_TYCON), borrador, lectores: { 'harness-config': TC } });
  const cambio = (r, esperado) => { assert.strictEqual(r.ok, true, JSON.stringify(r.problems)); assert.strictEqual(r.texto, ORG.formatJson(esperado)); };
  // integraciones: las cinco del equipo; Telegram y CodeGraph no se editan acá (son de cada máquina)
  const integ = ORG.seccionPorId('integraciones');
  assert.deepStrictEqual(integ.rutas, ['integrations.clockify', 'integrations.engram', 'integrations.mailbox', 'integrations.codex', 'integrations.nightly']);
  cambio(rev('integraciones', { integrations: { clockify: false, engram: true, mailbox: true, codex: true, nightly: true, codegraph: true } }), { ...PERFIL_TYCON, integrations: { ...PERFIL_TYCON.integrations, clockify: false, codex: true } });
  assert.deepStrictEqual(rev('integraciones', { integrations: { clockify: 'sí' } }).problems.map((p) => p.path), ['integrations.clockify']);
  // Azure DevOps: la organización; un correo ahí es un valor personal y lo rechaza el lector
  cambio(rev('ado', { ado: { org: 'https://dev.azure.com/otra' } }), { ...PERFIL_TYCON, ado: { org: 'https://dev.azure.com/otra' } });
  const personal = rev('ado', { ado: { org: 'alguien@acme.example' } });
  assert.strictEqual(personal.ok, false); assert.strictEqual(personal.texto, null);
  assert.match(personal.problems.map((p) => p.message).join(' '), /personal/);
  // actualización: canal y aplicación; lo demás de `update` queda
  cambio(rev('actualizacion', { update: { channel: 'stable', apply: 'ask' } }), { ...PERFIL_TYCON, update: { ...PERFIL_TYCON.update, channel: 'stable', apply: 'ask' } });
  assert.deepStrictEqual(rev('actualizacion', { update: { channel: 'nightly', apply: 'auto' } }).problems.map((p) => p.path), ['update.channel']);
  // instalación
  cambio(rev('instalacion', { install: { profile: 'minimal' } }), { ...PERFIL_TYCON, install: { profile: 'minimal' } });
  assert.deepStrictEqual(rev('instalacion', { install: { profile: 'medio' } }).problems.map((p) => p.path), ['install.profile']);
  for (const id of ['respuesta', 'integraciones', 'ado', 'actualizacion', 'instalacion']) {
    const s = ORG.seccionPorId(id);
    assert.deepStrictEqual([s.archivo, s.repo, s.lector], ['team-profile.json', 'perfil', 'harness-config'], id);
  }
});

test('2.31-T11b NewSections_InTheTab — vigente, ADO en GitHub, qué trae cada perfil de instalación', async () => {
  await conEquipo({}, async ({ seccion, revisar }) => {
    const ado = await seccion('ado');
    assert.strictEqual(ado.estado, 'cargado', JSON.stringify(ado));
    assert.match(ado.extras.proyecto, /ado-config\.yaml/);
    assert.match(ado.extras.pedidos, /work-items/);
    const inst = await seccion('instalacion');
    assert.ok(inst.extras.perfiles.minimal.length > 0 && inst.extras.perfiles.full.length > inst.extras.perfiles.minimal.length, 'lo que trae cada perfil, de install-effects.json');
    const r = await revisar('integraciones', { integrations: { ...PERFIL_TYCON.integrations, nightly: false } });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  });
  await conEquipo({ remotos: { perfil: { platform: 'github', org: 'acme', repo: 'profile' } } }, async ({ seccion }) => {
    const ado = await seccion('ado');
    assert.strictEqual(ado.soloLectura, true);
    assert.match(ado.motivo, /no aplica/);
  });
});

test('2.31-T12 ThreadsToggle_ProposesOnlySiteMailboxThreads @story-2.31 @ac-14 @ac-15 — el interruptor cambia sólo site.mailbox.threads, por el camino de la 2.29', async () => {
  const s = ORG.seccionPorId('hilos');
  assert.deepStrictEqual([s.archivo, s.repo, s.lector, s.rutas], ['operations.json', 'operaciones', 'operations-config.js', ['site.mailbox.threads']]);
  assert.ok(ORG.ramaDePropuesta(s.idCorto).startsWith(`team-config/${s.idCorto}-`), 'la rama del pedido, como las de la 2.29');
  const conBuzon = opsBase({ site: { maintainers: [LEAD], mailbox: { provider: 'azure-blob', account: 'acmeruns', container: 'corridas' }, refresh_minutes: 15 } });
  const r = ORG.revisar({ seccion: 'hilos', texto: ORG.formatJson(conBuzon), borrador: { site: { maintainers: ['otro@acme.example'], mailbox: { threads: true } } }, lectores: { 'operations-config.js': OPS } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  assert.strictEqual(r.texto, ORG.formatJson({ ...conBuzon, site: { ...conBuzon.site, mailbox: { ...conBuzon.site.mailbox, threads: true } } }), 'sólo la hoja del interruptor');
  await conEquipo({ ops: conBuzon }, async ({ seccion, revisar, proponer }) => {
    const v = await seccion('hilos');
    assert.strictEqual(v.estado, 'cargado', JSON.stringify(v));
    const ok = await revisar('hilos', { site: { mailbox: { threads: true } } });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));
    assert.match((await proponer('hilos', ok.texto)).message, PASO_EL_PORTON);
  });
  // sin buzón configurado, el interruptor no tiene a qué aplicarse: se dice
  await conEquipo({}, async ({ seccion }) => {
    const v = await seccion('hilos');
    assert.strictEqual(v.soloLectura, true);
    assert.match(v.motivo, /buzón/);
  });
});

test('2.31-T13 ContentList_ReadOnly_NoEditAction @story-2.31 @ac-17 — lo que trae la organización, con ruta y enlace, sin editar', async () => {
  const extra = { 'skills/acme-skill/SKILL.md': '# skill\n', 'agents/acme-revisor.md': '# revisor\n', 'onboarding/step-0-mac.md': '# alta\n', 'packs/acme/pack.json': { name: 'acme' } };
  await conEquipo({ extra, env: { ...PERFIL_ENV, SITE_PROFILE_REPO: 'https://github.com/acme/profile.git' } }, async ({ estado }) => {
    const r = await estado();
    const c = r.contenido;
    assert.ok(Array.isArray(c), JSON.stringify(r).slice(0, 200));
    const rutas = c.map((x) => x.ruta);
    for (const rel of ['skills/acme-skill', 'agents/acme-revisor.md', 'onboarding/step-0-mac.md', 'packs/acme']) assert.ok(rutas.includes(rel), `${rel} en ${rutas}`);
    for (const x of c) assert.match(x.enlace, /^https:\/\/github\.com\/acme\/profile\//, x.ruta);
    assert.ok(c.every((x) => typeof x.tipo === 'string' && x.tipo));
  });
  const p = await pantallaFalsa([]);
  assert.strictEqual(p.error, null);
});

// ── story 2.31, pase adversarial: lo que el sitio tiene que aguantar ─────────────────────────────────────────────
test('2.31-T16 Proponer_SoloLasHojasDeLaSeccion @story-2.31 @ac-15 (pase adversarial) — al proponer, una sección con rutas no cambia otras hojas de su clave', async () => {
  const conBuzon = opsBase({ site: { maintainers: [LEAD, 'otro@acme.example'], mailbox: { provider: 'azure-blob', account: 'acmeruns', container: 'corridas' }, refresh_minutes: 15 } });
  await conEquipo({ ops: conBuzon }, async ({ revisar, proponer }) => {
    const ok = await revisar('hilos', { site: { mailbox: { threads: true } } });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));
    assert.match((await proponer('hilos', ok.texto)).message, PASO_EL_PORTON, 'lo legítimo sigue pasando');
    const doc = JSON.parse(ok.texto); doc.site.maintainers = ['otro@acme.example']; doc.site.refresh_minutes = 30;
    const r = await proponer('hilos', ORG.formatJson(doc));
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /site\.maintainers.*no es de esta sección/);
  });
  await conEquipo({}, async ({ revisar, proponer }) => {
    const ok = await revisar('actualizacion', { update: { channel: 'stable', apply: 'ask' } });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));
    const doc = JSON.parse(ok.texto); doc.update.skills_source = 'unified';
    assert.match((await proponer('actualizacion', ORG.formatJson(doc))).message, /update\.skills_source.*no es de esta sección/);
    const ok2 = await revisar('integraciones', { integrations: { ...PERFIL_TYCON.integrations, nightly: false } });
    const doc2 = JSON.parse(ok2.texto); doc2.integrations.codegraph = true;
    assert.match((await proponer('integraciones', ORG.formatJson(doc2))).message, /integrations\.codegraph.*no es de esta sección/);
  });
});

test('2.31-T16b Rutas_SacarLaUnicaHoja_NoDejaObjetoVacio @story-2.31 @ac-2 (vuelta 2) — sacar la única hoja de una clave no deja «{}» en el archivo', () => {
  const r = ORG.revisar({ seccion: 'instalacion', texto: ORG.formatJson(PERFIL_TYCON), borrador: {}, lectores: { 'harness-config': TC } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  const { install, ...sinInstall } = PERFIL_TYCON;
  assert.ok(install, 'el perfil de juguete trae install');
  assert.strictEqual(r.texto, ORG.formatJson(sinInstall), 'install, que sólo tenía profile, se va entero');
  // y la hoja de un objeto que tiene otras hojas sale sola
  const a = ORG.revisar({ seccion: 'actualizacion', texto: ORG.formatJson(PERFIL_TYCON), borrador: {}, lectores: { 'harness-config': TC } });
  assert.deepStrictEqual(JSON.parse(a.texto).update, { skills_source: 'separate' });
});

test('2.31-T17 ContentList_GroupedSkills @story-2.31 @ac-17 (pase adversarial) — las skills agrupadas de la capa también se listan', async () => {
  const extra = { 'skills/top/SKILL.md': '# a\n', 'skills/infra/s2/SKILL.md': '# b\n', 'skills/projects/acme/s1/SKILL.md': '# c\n', 'skills/notas.md': 'no es skill\n' };
  await conEquipo({ extra }, async ({ estado }) => {
    const rutas = (await estado()).contenido.filter((x) => x.tipo === 'skill').map((x) => x.ruta).sort();
    assert.deepStrictEqual(rutas, ['skills/infra/s2', 'skills/projects/acme/s1', 'skills/top']);
  });
});

test('2.31-T18 Gate_SoloLoQueCambia @story-2.31 @ac-5 (pase adversarial) — una lista de paquetes o un response ya escritos no frenan otra sección', () => {
  const viejo = JSON.stringify(capa(ORG.MODELS_SINCE));
  const sitio = '2026.10.20.1';   // la versión de este sitio, posterior a la que pide la capa: una lista la frena
  const conLista = { ...CON_RESPUESTA, packs: { default: ['acme'] } };
  const otro = { ...conLista, update: { ...conLista.update, channel: 'stable' } };
  assert.strictEqual(ORG.teamProfileGateProblem({ layerText: viejo, versionImagen: sitio, doc: otro, actual: conLista }), null, 'sin cambiar packs ni response, no se frena');
  assert.match(ORG.teamProfileGateProblem({ layerText: viejo, versionImagen: sitio, doc: { ...otro, response: { style: 'neutral' } }, actual: conLista }), /response/);
  assert.match(ORG.teamProfileGateProblem({ layerText: viejo, versionImagen: sitio, doc: { ...otro, packs: { default: ['acme', 'otro'] } }, actual: conLista }), /lista de paquetes/);
  assert.match(ORG.teamProfileGateProblem({ layerText: viejo, versionImagen: sitio, doc: otro }), /lista de paquetes/, 'sin el archivo actual, todo lo que trae');
});

test('2.31-T21 Espera_SeccionConSuPorton @story-2.31 @story-7.20 — el plazo del aviso de espera se edita en team-repos.json, con el lector y la versión que lo leen', async () => {
  const s = ORG.seccionPorId('espera');
  assert.ok(s, 'hay una sección del aviso de espera');
  assert.deepStrictEqual([s.archivo, s.repo, s.lector, s.claves, s.idCorto], ['team-repos.json', 'perfil', 'team-repos.js', ['wait_notice'], 'repos']);
  assert.ok(ORG.versionAtLeast(ORG.WAIT_NOTICE_SINCE, ORG.MODELS_SINCE) && ORG.WAIT_NOTICE_SINCE !== ORG.MODELS_SINCE);
  const malo = ORG.revisar({ seccion: 'espera', texto: ORG.formatJson(TR_BASE), borrador: { wait_notice: { minutes: 0 } }, lectores: { 'team-repos.js': TR } });
  assert.strictEqual(malo.ok, false);
  assert.deepStrictEqual(malo.problems.map((p) => p.path), ['wait_notice.minutes'], 'el lector da el problema aparte y la sección no lo propone');
  for (const [v, espera] of [[ORG.MODELS_SINCE, /todavía no se puede proponer.*wait_notice/], [ORG.WAIT_NOTICE_SINCE, PASO_EL_PORTON]]) {
    await conPerfil({ layer: capa(v) }, async ({ seccion, revisar, proponer }) => {
      assert.strictEqual((await seccion('espera')).estado, 'cargado');
      const r = await revisar('espera', { wait_notice: { minutes: 10 } });
      assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
      assert.deepStrictEqual(JSON.parse(r.texto), { ...TR_BASE, wait_notice: { minutes: 10 } }, 'el resto del archivo igual');
      assert.match((await proponer('espera', r.texto)).message, espera);
    });
  }
});

test('2.31-T13b ContentList_Screen_NoButtons — la tabla de lo que trae la organización no tiene botones', async () => {
  const creados = [];
  const nodo = (tag) => { const n = { tag, hijos: [], textContent: '', attrs: {}, on: {}, setAttribute(k, v) { n.attrs[k] = v; }, appendChild(ch) { n.hijos.push(ch); return ch; }, addEventListener(e, f) { n.on[e] = f; }, replaceChildren(...cs) { n.hijos = cs; } }; creados.push(n); return n; };
  const app = nodo('div');
  const document = { querySelector: () => null, getElementById: (id) => (id === 'config-app' ? app : null), createElement: (t) => nodo(t) };
  const respuesta = { ok: true, secciones: [], proponer: {}, versiones: [], productos: [], contenido: [{ tipo: 'skill', ruta: 'skills/acme-skill', enlace: 'https://github.com/acme/profile/tree/main/skills/acme-skill' }] };
  const fetch = (ruta) => Promise.resolve({ status: 200, json: () => Promise.resolve(ruta === '/api/config' ? respuesta : { ok: false }) });
  new Function('document', 'fetch', ORG.pantalla())(document, fetch);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const tabla = creados.filter((n) => n.attrs.id === 'contenido').pop();
  assert.ok(tabla, 'la tabla «Lo que trae la organización»');
  const todo = []; const walk = (x) => { todo.push(x); x.hijos.forEach(walk); }; walk(tabla);
  assert.ok(todo.some((n) => n.textContent === 'skills/acme-skill'), 'la ruta');
  assert.ok(todo.some((n) => n.tag === 'a' && n.attrs.href === respuesta.contenido[0].enlace), 'el enlace al archivo');
  assert.ok(!todo.some((n) => n.tag === 'button' || n.tag === 'input' || n.tag === 'select' || n.tag === 'textarea'), 'sin nada para editar');
});

// Navegar no vuelve a armar nada: abrir Configuración otra vez no lee cada sección ni
// le pregunta de nuevo a la plataforma si se puede proponer; eso se rearma cuando se refrescan los datos de fondo, cuando
// pasan 15 minutos o cuando alguien propone un cambio.
// Sin esto, cada apertura hace 2 consultas por archivo a la plataforma (12 en total, de 2 a 7 s).
test('Navegar_LoArmadoSeGuarda_HastaElRefrescoDeFondo', async () => {
  let consultas = 0;
  const fetch = async () => { consultas += 1; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  let reloj = AHORA;
  const remotos = { operaciones: { platform: 'github', org: 'acme', repo: 'ops', web: 'https://github.example/acme/ops' } };
  // el dev tiene una máquina a su nombre: entra al sitio como persona, no como alguien sin rol
  const fuentes = fuentesCon({ ops: clon({ 'operations.json': opsBase() }), config: opsBase({ people: { machines: { 'maq-a': { person: DEV, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' } } } }) });
  await conPestana({ fuentes, env: { SITE_OPERATIONS_WRITE_TOKEN: ESCRITURA }, opciones: { fetch, remotos, urlBase: { github: 'http://127.0.0.1:9' }, ahora: () => reloj } }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    const a = await h.pedir('/api/config', { cookie: lead });
    assert.strictEqual(a.status, 200);
    const primeras = consultas;
    assert.ok(primeras > 0, 'la primera apertura pregunta a la plataforma');
    const b = await h.pedir('/api/config', { cookie: lead });
    assert.strictEqual(consultas, primeras, 'abrirla otra vez no pregunta de nuevo');
    assert.strictEqual(b.texto, a.texto);
    // lo guardado es sólo para quien mantiene: con la pestaña ya armada, un dev sigue recibiendo 403 y nada más
    const dev = await entrar(DEV);
    for (const ruta of ['/api/config', '/configuracion']) {
      const r = await h.pedir(ruta, { cookie: dev });
      assert.strictEqual(r.status, 403, ruta);
      assert.ok(!r.texto.includes('operations.json') && !r.texto.includes('"secciones"'), `${ruta}: sin datos`);
    }
    // los datos de fondo se refrescan: el modelo llega como un objeto nuevo
    fuentes.st.modelo = { ...fuentes.st.modelo };
    await h.pedir('/api/config', { cookie: lead });
    assert.strictEqual(consultas, primeras * 2, 'datos de fondo nuevos: se arma de nuevo');
    reloj += 15 * 60 * 1000;
    await h.pedir('/api/config', { cookie: lead });
    assert.strictEqual(consultas, primeras * 3, 'pasados 15 minutos, también');
  });
});
