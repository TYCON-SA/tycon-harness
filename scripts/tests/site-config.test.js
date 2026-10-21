'use strict';
/*
 * site-config.test.js — la pestaña Configuración del sitio de la organización.
 *
 * El núcleo común (scripts/lib/org-config.js) y la pestaña (scripts/site/tabs/config.js). El servidor de prueba es el
 * del sitio con una sesión inyectada; los repos son repos git locales servidos por HTTP (lib/git-http-repo.js); las
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
// el código de pantalla pide sus textos a la tabla del sitio: para leer su forma, con cada texto en castellano
const pantallaEnCastellano = () => { const { t } = require(path.join(ROOT, 'scripts', 'site', 'texts.js')); return ORG.pantalla().replace(/T\('(pantalla\.[A-Za-z0-9]+)'(?:, \{[^}]*\})?\)/g, (x, k) => `'${t('es', k).replace(/'/g, "\\'")}'`); };
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

test('T7.35-1 Thresholds_UnderscoreComment_NotAProblem @story-7.35 @ac-5 — un comentario con un solo «_» no es una fila: ni problema ni aviso', () => {
  const conComentarios = ORG.formatJson({
    ...SOURCES_ORG,
    thresholds: { _comment: 'los umbrales del tablero', ...SOURCES_ORG.thresholds, corridas_al_final: { ...SOURCES_ORG.thresholds.corridas_al_final, _note: 'proporción' } },
  });
  const r = ORG.thresholdsParse(conComentarios, { arnes: { thresholds: ARNES_THRESHOLDS } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  assert.deepStrictEqual(r.avisos, []);
  // la clave inventada sin «_» se sigue mirando: sólo se saltean los comentarios (agregada, un problema)
  const inventada = ORG.formatJson({ ...SOURCES_ORG, thresholds: { ...SOURCES_ORG.thresholds, comment: 'x' } });
  const previas = Object.keys(SOURCES_ORG.thresholds);
  assert.deepStrictEqual(ORG.thresholdsParse(inventada, { arnes: { thresholds: ARNES_THRESHOLDS }, previas }).problems.map((p) => p.path), ['thresholds.comment']);
  // un «_» con forma de secreto no es comentario (se mira como fila); «__» lo es con cualquier valor
  const raras = ORG.formatJson({ ...SOURCES_ORG, thresholds: { ...SOURCES_ORG.thresholds, _token: 'x', __meta: { a: 1 } } });
  assert.deepStrictEqual(ORG.thresholdsParse(raras, { arnes: { thresholds: ARNES_THRESHOLDS }, previas }).problems.map((p) => p.path), ['thresholds._token']);
});

test('T7.35-2 ApplySection_KeepsUnderscoreKeys @story-7.35 @ac-6 — proponer no pierde los comentarios con «_» que el borrador no trae', () => {
  // Umbrales: el borrador reemplaza el bloque entero; los comentarios del bloque y de cada fila se conservan
  const seccion = ORG.SECCIONES.find((s) => s.id === 'umbrales');
  const archivo = ORG.formatJson({
    ...SOURCES_ORG,
    thresholds: { _comment: 'los umbrales del tablero', ...SOURCES_ORG.thresholds, corridas_al_final: { ...SOURCES_ORG.thresholds.corridas_al_final, _note: 'proporción' } },
  });
  const borrador = { corridas_al_final: { direction: 'mayor_es_mejor', ok_min: 0.9, bad_max: 0.4 }, rojos: SOURCES_ORG.thresholds.rojos };
  const r = ORG.revisar({ seccion, texto: archivo, borrador, lectores: {}, arnes: { thresholds: ARNES_THRESHOLDS } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  const th = JSON.parse(r.texto).thresholds;
  assert.strictEqual(th._comment, 'los umbrales del tablero');
  assert.strictEqual(th.corridas_al_final._note, 'proporción');
  assert.strictEqual(th.corridas_al_final.ok_min, 0.9, 'el cambio del borrador entra');
  // una sección de archivo entero: el comentario de arriba que el borrador no trae se conserva
  const entera = { id: 'x', claves: null };
  const out = ORG.aplicarSeccion({ _lea_esto_primero: 'nota', __doc: 'doc', version: 1 }, entera, { version: 2 });
  assert.deepStrictEqual(out, { version: 2, _lea_esto_primero: 'nota', __doc: 'doc' });
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

// ── la pestaña en el sitio ────────────────────────────────────────────────────────────────────────────
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

/** Las fuentes del sitio, de mentira, con los clones y el espejo que la pestaña lee. */
function fuentesCon({ ops, perfil = null, config, informados = null, repos = null, espejo = null, estado = {}, indice = null, escritura = null, modelo = {} }) {
  const f = H.fuentesFijas({ config: config || opsBase(), modelo, personas: { informados, repos } });
  const base = f.estado;
  f.estado = () => ({ ...base(), ...estado });
  // con la copia de operaciones: la carpeta de la foto con su índice, y el clon de escritura aparte
  f.clones = () => ({ operaciones: ops ? (indice ? { dir: ops, indice } : { dir: ops }) : null, perfil: perfil ? { dir: perfil } : null });
  if (escritura) f.clonDeEscritura = escritura;
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
const RUTAS = [['GET', '/configuracion'], ['GET', '/static/config.js'], ['GET', '/api/config'], ['POST', '/api/config/revisar'], ['POST', '/api/config/stages'], ['POST', '/api/config/pipelines'], ['POST', '/api/config/pasos'], ['POST', '/api/config/tipos-de-pedido'], ['POST', '/api/config/campos-de-pedido'], ['POST', '/api/config/proponer'], ['GET', '/api/config/propuesta']];

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

/** Un lector de operations.json que conoce las claves que la pestaña usa (las pruebas lo inyectan: cada versión del arnés trae el suyo). */
const OPS_FUTURO = { ...OPS, KEYS: [...OPS.KEYS, 'deployments', 'notify'], parse: (t) => { const d = JSON.parse(t); const { deployments, notify, ...resto } = d; const r = OPS.parse(JSON.stringify(resto)); return r.ok ? { ...r, data: d } : r; } };

test('T4 Secciones_OchoEditablesYDosDeLectura_CanalSinSecretos_SinScriptEnLinea @story-2.29 @ac-4 @ac-12', async () => {
  const ops = clon({ 'operations.json': opsBase(), 'scripts/nightly/dashboard/sources.json': SOURCES_ORG, '.dashboard/applied-config.json': { files: { 'scripts/nightly/dashboard/sources.json': 'x' } }, 'scripts/ci/product-parity.json': { grupos: {}, rasgos: [], diferencias_declaradas: [] } });
  const perfil = clon({ 'team-repos.json': { version: 1 }, 'team-layer.json': { requires: { harness: `>= ${ORG.TEAM_REPOS_SINCE}` } } });
  const fuentes = fuentesCon({ ops, perfil });
  // el lector de hoy ya sabe `notify`; el «todavía no sabe leer» se prueba con un lector sin la clave
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
      assert.match(pagina.texto, /<script src="\/static\/config\.js\?l=es" defer><\/script>/);
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

test('T5b Paquetes_YRevisores_TambienDelPerfil — los paquetes y los revisores del clon del perfil se suman a los del árbol', async () => {
  // la capa del equipo trae sus paquetes y sus revisores en el repo del perfil: la pestaña los lista junto a los del
  // árbol, sin repetir, y un paquete activado en packs.default que trae el perfil sale activo
  const ops = clon({ 'scripts/nightly/dashboard/sources.json': SOURCES_ORG });
  const perfil = clon({
    'team-profile.json': { version: 1, packs: { default: ['acme-pack'] } },
    'packs/acme-pack/pack.json': { reviewers: [{ agent: 'acme-pack-reviewer' }] },
    'agents/acme-team-reviewer.md': '# un revisor del equipo\n',
  });
  await conPestana({ fuentes: fuentesCon({ ops, perfil }), env: { SITE_PROFILE_REPO: 'https://git.acme.example/perfil.git', SITE_PROFILE_TOKEN: ['tok', 'perfil'].join('-') } }, async ({ h, entrar }) => {
    const r = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json;
    const por = Object.fromEntries(r.secciones.map((s) => [s.id, s]));
    assert.ok(por.paquetes.extras.instalados.includes('acme-pack'), `instalados: ${JSON.stringify(por.paquetes.extras)}`);
    assert.deepStrictEqual(por.paquetes.extras.activos, ['acme-pack']);
    assert.strictEqual(new Set(por.paquetes.extras.instalados).size, por.paquetes.extras.instalados.length, 'sin repetir');
    const revisores = por.modelos.extras.revisores;
    assert.ok(revisores.includes('acme-team-reviewer'), 'el revisor del perfil');
    assert.ok(revisores.includes('acme-pack-reviewer'), 'el revisor del paquete del perfil');
    assert.deepStrictEqual(revisores, [...revisores].sort(), 'ordenados');
  });
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
  // las personas de la sección salen de «Quién entra al sitio»: las dos están en la lista
  const lista = [{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [DEV] }, { role: 'dev', emails: ['caido@acme.example'] }];
  const machines = { 'maq-a': { person: DEV, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' }, 'maq-x': { person: 'caido@acme.example', reported_sha256: sha('otro@acme.example'), confirmed_by: LEAD, confirmed_on: '2026-10-01' } };
  const config = opsBase({ site: { access: lista }, people: { machines } });
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
      // con el sitio frenado contesta 503 a todos: la sección no se ve; con la banda, se ve el último bueno
      if (estado.frenado) { assert.strictEqual(r.status, 503); return; }
      const p = r.json.secciones.find((s) => s.id === 'personas');
      assert.match(p.extras.ultimoBueno, rx);
      assert.strictEqual(!p.soloLectura, editable);
    });
  }
});

// ── «En qué proyectos trabaja cada uno»: las personas de la lista de acceso, lo deducido como sugerencia ──────────

test('T5 Personas_DeLaListaDeAcceso', async () => {
  const SIN = 'sin.maquina@acme.example';
  const config = opsBase({ site: { access: [{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [SIN, 'otro.correo@acme.example'] }] },
    people: { projects: { 'declarada@acme.example': { add: ['Gama'] } } } });
  const ops = clon({ 'operations.json': config });
  await conPestana({ fuentes: fuentesCon({ ops, config }) }, async ({ h, entrar }) => {
    const p = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json.secciones.find((s) => s.id === 'personas');
    const correos = p.extras.personas.map((x) => x.correo);
    assert.ok(correos.includes(SIN), 'una persona de la lista sin máquina aparece (por su primer correo)');
    assert.ok(!correos.includes('otro.correo@acme.example'), 'una vez por persona, no por correo');
    assert.ok(correos.includes('declarada@acme.example'), 'quien ya tiene algo declarado también');
    assert.ok(!correos.includes(LEAD), 'quien mantiene ve todo: no se le declaran productos');
  });
});

test('T6 Sugerencia_SeAcepta', async () => {
  // del lado del servidor: lo deducido que no está declarado llega como sugerencia
  const config = opsBase({ site: { access: [{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [DEV] }] }, people: { projects: { [DEV]: { add: ['Alfa'] } } } });
  const modelo = {
    pedidos: { estado: 'medido', fecha: HOY, lista: [{ id: 1, proyecto: 'Beta', tipo: 'Bug', estado: 'Active', asignado: DEV, dias: 1 }, { id: 2, proyecto: 'Alfa', tipo: 'Bug', estado: 'Active', asignado: DEV, dias: 1 }] },
    productos: [{ producto: 'Alfa', proyectos: ['Alfa'], rutas: [] }, { producto: 'Beta', proyectos: ['Beta'], rutas: [] }],
  };
  const repos = [{ producto: 'Alfa', ruta: 'Alfa/Web', ado: 'Alfa/Web' }, { producto: 'Beta', ruta: 'Beta/Front', ado: 'Beta/Front' }];
  const ops = clon({ 'operations.json': config });
  await conPestana({ fuentes: fuentesCon({ ops, config, modelo, repos, informados: H.informados({}) }) }, async ({ h, entrar }) => {
    const p = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json.secciones.find((s) => s.id === 'personas');
    const dev = p.extras.personas.find((x) => x.correo === DEV);
    assert.deepStrictEqual(dev.sugeridos, ['Beta'], 'Beta por su pedido; Alfa ya está declarado');
  });
  // en la pantalla: «sugerido: Beta» con Aceptar, que lo suma a lo declarado; Quitar saca de lo declarado
  const seccion = { id: 'personas', titulo: 'personas', repo: 'operaciones', estado: 'cargado', soloLectura: false, motivo: null, problems: [], avisos: [],
    borrador: { people: { projects: { [DEV]: { add: ['Alfa'] } } } }, extras: { personas: [{ correo: DEV, sugeridos: ['Beta'], caida: false }] } };
  const pa = await pantallaFalsa([seccion]);
  assert.strictEqual(pa.error, null);
  assert.ok(pa.textoDe('personas').includes('sugerido: Beta'), pa.textoDe('personas'));
  await pa.click('Aceptar', 'personas');
  assert.ok(!pa.textoDe('personas').includes('sugerido: Beta'), 'aceptada deja de ser sugerencia');
  await pa.click('Revisar cambios', 'personas');
  const rev = pa.pedidos.filter((x) => x.ruta === '/api/config/revisar').pop();
  assert.deepStrictEqual(rev.cuerpo.borrador.people.projects[DEV].add, ['Alfa', 'Beta'], 'Aceptar la sumó a lo declarado');
  // «Quitar» sobre un declarado lo saca de add (y no escribe un remove)
  const pq = await pantallaFalsa([{ ...seccion, borrador: { people: { projects: { [DEV]: { add: ['Alfa', 'Beta'] } } } }, extras: { personas: [{ correo: DEV, sugeridos: [], caida: false }] } }]);
  const quitar = pq.todo(pq.sec('personas')).find((n) => n.tag === 'button' && n.textContent === 'Quitar' && n.attrs['data-producto'] === 'Beta');
  assert.ok(quitar, 'cada declarado tiene su Quitar');
  quitar.on.click({});
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  await pq.click('Revisar cambios', 'personas');
  const rq = pq.pedidos.filter((x) => x.ruta === '/api/config/revisar').pop();
  assert.deepStrictEqual(rq.cuerpo.borrador.people.projects[DEV], { add: ['Alfa'] });
});

// lo declarado bajo otro correo de la persona, o con mayúsculas, la pantalla lo ve igual
test('T11 Personas_DeclaradoBajoOtroCorreo_SeVeYSeEdita', async () => {
  const OTRO = 'segundo.correo@acme.example';
  const machines = { 'maq-b': { person: OTRO, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' } };
  const config = opsBase({ site: { access: [{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [DEV, OTRO] }] },
    people: { machines, projects: { 'Segundo.Correo@acme.example': { add: ['Alfa'] } } } });
  const ops = clon({ 'operations.json': config });
  const modelo = { productos: [{ producto: 'Alfa', proyectos: ['Alfa'], rutas: [] }] };
  const inf = H.informados({ 'maq-b': 'otro.distinto@acme.example' });
  await conPestana({ fuentes: fuentesCon({ ops, config, modelo, informados: inf }) }, async ({ h, entrar }) => {
    const p = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json.secciones.find((s) => s.id === 'personas');
    const fila = p.extras.personas.find((x) => x.correo === DEV);
    assert.strictEqual(fila.clave, 'Segundo.Correo@acme.example', 'la pantalla edita la clave que ya existe, con su grafía');
    assert.strictEqual(fila.caida, true, 'la máquina de su otro correo cuenta (informa otro correo: no confirmada)');
  });
  const seccion = { id: 'personas', titulo: 'personas', repo: 'operaciones', estado: 'cargado', soloLectura: false, motivo: null, problems: [], avisos: [],
    borrador: { people: { projects: { 'Segundo.Correo@acme.example': { add: ['Alfa'] } } } }, extras: { personas: [{ correo: DEV, clave: 'Segundo.Correo@acme.example', sugeridos: ['Beta'], caida: false }] } };
  const pa = await pantallaFalsa([seccion]);
  assert.ok(pa.textoDe('personas').includes('ve: Alfa'), pa.textoDe('personas'));
  await pa.click('Aceptar', 'personas');
  await pa.click('Revisar cambios', 'personas');
  const rev = pa.pedidos.filter((x) => x.ruta === '/api/config/revisar').pop();
  assert.deepStrictEqual(rev.cuerpo.borrador.people.projects, { 'Segundo.Correo@acme.example': { add: ['Alfa', 'Beta'] } }, 'una sola clave, la que ya estaba');
});

test('T7 QuitadosViejos_SeAvisanYSeLimpian', async () => {
  const seccion = { id: 'personas', titulo: 'personas', repo: 'operaciones', estado: 'cargado', soloLectura: false, motivo: null, problems: [], avisos: [],
    borrador: { people: { projects: { [DEV]: { add: ['Alfa'], remove: ['Beta'] }, 'solo.quitados@acme.example': { remove: ['Gama'] } } } },
    extras: { personas: [{ correo: DEV, sugeridos: [], caida: false }] } };
  const p = await pantallaFalsa([seccion]);
  assert.strictEqual(p.error, null);
  assert.ok(p.textoDe('personas').includes('hay quitados viejos que ya no hacen nada'), p.textoDe('personas'));
  await p.click('Revisar cambios', 'personas');
  const rev = p.pedidos.filter((x) => x.ruta === '/api/config/revisar').pop();
  assert.deepStrictEqual(rev.cuerpo.borrador.people.projects, { [DEV]: { add: ['Alfa'] } }, 'el borrador que se propone ya no trae los quitados');
  // sin quitados, no hay aviso
  const sin = await pantallaFalsa([{ ...seccion, borrador: { people: { projects: { [DEV]: { add: ['Alfa'] } } } }, extras: { personas: [{ correo: DEV, sugeridos: [], caida: false }] } }]);
  assert.ok(!sin.textoDe('personas').includes('quitados viejos'));
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
    fuentes.st.config = opsBase({ site: { maintainers: [LEAD] } });   // el merge y el refresco del sitio
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
  // el perfil usa el nombre anterior del archivo (perfil-equipo.json): la sección lee y propone sobre ése, así que el estado de
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

// ── casos de borde de la pestaña ───────────────────────────────────────────────────────────
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
  assert.match(noJson, /el sitio contestó con un error \(502\)/);
});

test('Pantalla_RechazoEnLlano_NuncaRespuestaN @story-2.38 @ac-4 — un rechazo dice por qué y qué hacer', async () => {
  const vacio = (status) => () => Promise.resolve({ status, json: () => Promise.reject(new Error('cuerpo vacío')) });
  const casos = [
    [vacio(401), /la sesión venció o se cerró: recargá la página/],
    // el sitio manda su motivo en cada 403: uno vacío lo dio lo que está delante (el candado de la nube)
    [vacio(403), /lo rechazó lo que está delante del sitio, no el sitio: recargá la página.*quien mantiene/],
    [vacio(503), /el sitio está cargando o frenado: probá de nuevo en unos segundos/],
    [vacio(418), /el sitio contestó con un error \(418\)/],
    // con el mensaje del servidor, ése (aunque el JSON no traiga `ok`)
    [() => Promise.resolve({ status: 403, json: () => Promise.resolve({ ok: false, codigo: 'sin_rol', message: 'tu cuenta ana@acme.example no está entre los que mantienen el sitio' }) }), /tu cuenta ana@acme\.example no está entre los que mantienen el sitio/],
    // un JSON sin `message`: el llano de su estado
    [() => Promise.resolve({ status: 403, json: () => Promise.resolve({ ok: false }) }), /lo rechazó lo que está delante del sitio/],
  ];
  for (const [f, rx] of casos) {
    const t = await correrPantalla(f);
    assert.match(t, rx);
    assert.doesNotMatch(t, /respuesta \d{3}/, 'nunca «respuesta N» suelto');
  }
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

/** La pestaña con pestañas: corre la pantalla con `secciones` y `extras`, el ancla dada, y devuelve los nodos creados. */
async function pantallaConPestanas({ secciones, extras = {}, hash = '', idioma = 'es' }) {
  const creados = [];
  const nodo = (tag) => { const n = { tag, hijos: [], textContent: '', attrs: {}, on: {}, setAttribute(k, v) { n.attrs[k] = v; }, appendChild(c) { n.hijos.push(c); return c; }, addEventListener(e, f) { n.on[e] = f; }, replaceChildren(...cs) { n.hijos = cs; } }; creados.push(n); return n; };
  const app = nodo('div');
  const document = { querySelector: () => null, getElementById: (id) => (id === 'config-app' ? app : creados.find((n) => n.attrs.id === id) || null), createElement: (t) => nodo(t) };
  const respuesta = Object.assign({ ok: true, secciones, proponer: {}, versiones: [], productos: [] }, extras);
  const llamadas = [];
  new Function('document', 'fetch', 'location', ORG.pantalla(idioma))(document, (ruta, opts) => { llamadas.push({ ruta, cuerpo: opts && opts.body ? JSON.parse(opts.body) : null }); return Promise.resolve({ status: 200, json: () => Promise.resolve(respuesta) }); }, { hash });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const dentro = (n) => { const out = []; const walk = (x) => { out.push(x); (x.hijos || []).forEach(walk); }; walk(n); return out; };
  const visibles = dentro(app).filter((n) => n.attrs.role === 'tabpanel' && !n.attrs.hidden).map((n) => n.attrs.id);
  const tabs = dentro(app).filter((n) => n.attrs.role === 'tab').map((n) => ({ id: n.attrs.id, sel: n.attrs['aria-selected'], cuenta: (n.hijos.find((h) => /cuenta/.test(h.attrs.class || '')) || {}).textContent || '' }));
  const panelDe = (id) => dentro(app).filter((n) => n.attrs.role === 'tabpanel').find((p) => dentro(p).some((x) => x.attrs.id === id));
  return { app, tabs, visibles, panelDe, resumen: app.hijos[0], llamadas, creados };
}
const SEC = (id, extra = {}) => Object.assign({ id, titulo: id, repo: 'operaciones', estado: 'cargado', soloLectura: false, borrador: {}, problems: [], avisos: [] }, extra);
const TODAS = ['sitio', 'personas', 'responsables', 'repos', 'despliegues', 'paridad', 'ado', 'canal', 'espera', 'umbrales', 'respuesta', 'modelos', 'suites', 'integraciones', 'hilos', 'actualizacion', 'instalacion'];

test('Pestanas_CincoPorTema_UnaVisible — las secciones se reparten en cinco pestañas y el resumen queda arriba de todas', async () => {
  const r = await pantallaConPestanas({ secciones: TODAS.map((id) => SEC(id)) });
  assert.deepStrictEqual(r.tabs.map((t) => t.id), ['tab-personas', 'tab-repos', 'tab-avisos', 'tab-claude', 'tab-instalacion']);
  assert.deepStrictEqual(r.visibles, ['pestana-personas'], 'sin ancla, se abre la primera y las otras quedan ocultas');
  const esperado = { personas: ['sitio', 'personas', 'responsables'], repos: ['repos', 'despliegues', 'paridad', 'ado', 'productos'], avisos: ['canal', 'espera', 'umbrales'], claude: ['respuesta', 'modelos', 'suites', 'integraciones', 'hilos'], instalacion: ['actualizacion', 'instalacion', 'versiones'] };
  for (const [tab, ids] of Object.entries(esperado)) for (const id of ids) {
    const dom = ['productos', 'versiones'].includes(id) ? id : `seccion-${id}`;
    assert.strictEqual((r.panelDe(dom) || { attrs: {} }).attrs.id, `pestana-${tab}`, `${id} va en ${tab}`);
  }
  assert.strictEqual(r.resumen.attrs.class, 'grid', 'el resumen va primero, fuera de las pestañas');
  assert.ok(r.tabs.every((t) => t.cuenta === ''), 'todo al día: ninguna pestaña marca pendientes');
});

test('Pestanas_MarcanLoPendiente — cada pestaña cuenta las secciones con algo para arreglar y las máquinas atrasadas', async () => {
  const secs = TODAS.map((id) => SEC(id, id === 'umbrales' ? { problems: [{ path: 'thresholds.x', message: 'mal' }] } : id === 'modelos' ? { estado: 'ilegible', motivo: 'roto' } : {}));
  const r = await pantallaConPestanas({ secciones: secs, extras: { versiones: [{ maquina: 'm1', estado: 'atrasada' }, { maquina: 'm2', estado: 'al_dia' }] } });
  const cuenta = Object.fromEntries(r.tabs.map((t) => [t.id, t.cuenta]));
  assert.deepStrictEqual(cuenta, { 'tab-personas': '', 'tab-repos': '', 'tab-avisos': '1', 'tab-claude': '1', 'tab-instalacion': '1' });
});

test('Pestanas_EnlaceDirectoAbreSuPestana — #seccion-… y #pestana-… abren la pestaña que corresponde', async () => {
  const secs = TODAS.map((id) => SEC(id));
  assert.deepStrictEqual((await pantallaConPestanas({ secciones: secs, hash: '#seccion-umbrales' })).visibles, ['pestana-avisos']);
  assert.deepStrictEqual((await pantallaConPestanas({ secciones: secs, hash: '#pestana-claude' })).visibles, ['pestana-claude']);
  assert.deepStrictEqual((await pantallaConPestanas({ secciones: secs, hash: '#versiones' })).visibles, ['pestana-instalacion']);
  assert.deepStrictEqual((await pantallaConPestanas({ secciones: secs, hash: '#nada' })).visibles, ['pestana-personas'], 'un ancla desconocida abre la primera');
  // una sección que el arnés sume y la pantalla no conozca se muestra igual, en la última pestaña
  const r = await pantallaConPestanas({ secciones: secs.concat(SEC('nueva')), hash: '#seccion-nueva' });
  assert.deepStrictEqual(r.visibles, ['pestana-instalacion']);
  assert.strictEqual(r.panelDe('seccion-nueva').attrs.id, 'pestana-instalacion');
});

test('Umbrales_VerdeDelLadoDelRojo_DichoLlano — el límite del verde no puede quedar del lado del rojo, y se dice sin nombres de claves', () => {
  const texto = (th) => ORG.formatJson({ thresholds: th });
  const menor = ORG.thresholdsParse(texto({ x: { direction: 'menor_es_mejor', ok_max: 3, bad_min: 1 } }));
  assert.strictEqual(menor.ok, false);
  assert.deepStrictEqual(menor.problems.map((p) => p.message), ['si es mejor más bajo, el límite del verde tiene que ser menor que el del rojo']);
  const mayor = ORG.thresholdsParse(texto({ x: { direction: 'mayor_es_mejor', ok_min: 0.5, bad_max: 0.5 } }));
  assert.deepStrictEqual(mayor.problems.map((p) => p.message), ['si es mejor más alto, el límite del verde tiene que ser mayor que el del rojo']);
  const mal = ORG.thresholdsParse(texto({ x: { direction: 'menor_es_mejor', ok_max: 1 } }));
  for (const p of mal.problems) assert.doesNotMatch(p.message, /ok_|bad_|direction|_es_mejor/, 'sin claves del archivo');
  assert.strictEqual(ORG.thresholdsParse(texto({ x: { direction: 'menor_es_mejor', ok_max: 0, bad_min: 1 } })).ok, true, 'en orden, pasa');
});

test('Mensajes_EnLlano_SinRutasNiClaves — la pantalla muestra dónde con los nombres de la pantalla y los mensajes que nombran claves, en palabras', async () => {
  const problems = [
    { path: 'site.mailbox.account', message: 'tiene que tener la forma de una cuenta de almacenamiento (3 a 24 minúsculas o números)', sinCampo: true },
    { path: 'people.machines.mac-1.person', message: 'clave desconocida', sinCampo: true },
    { path: 'models.ceiling', message: 'con techo obligatorio falta «ceiling»', sinCampo: true },
    { path: 'deployments.products.acme', message: 'tiene que declarar staging, production o los dos', sinCampo: true },
    { path: 'merge_suites.repos.0', message: 'tiene que traer rule o full_tests_pipeline (sin ninguno, la entrada no dice nada)', sinCampo: true },
  ];
  const r = await pantallaConPestanas({ secciones: TODAS.map((id) => SEC(id, id === 'sitio' ? { problems } : {})) });
  const textos = []; const walk = (n) => { if (n.textContent) textos.push(n.textContent); (n.hijos || []).forEach(walk); }; walk(r.panelDe('seccion-sitio'));
  const err = textos.filter((t) => / › /.test(t)).join('\n');
  assert.match(err, /el sitio › dónde dejan sus ejecuciones › cuenta: tiene que tener la forma de una cuenta/);
  assert.match(err, /personas › máquinas › «mac-1» › persona: el arnés no conoce este dato/);
  assert.match(err, /modelos › techo: con el techo obligatorio, falta elegir el modelo del techo/);
  assert.match(err, /despliegues › productos › «acme»: tiene que tener el paso de prueba, el de producción o los dos/);
  assert.match(err, /pruebas al mergear › repos › fila 1: tiene que decir la regla o el pipeline de las pruebas completas/);
  assert.doesNotMatch(err, /site\.|mailbox|merge_suites|full_tests_pipeline|staging|ceiling»/, 'ninguna clave del archivo a la vista');
});

// ── dónde corren las suites al mergear y los modelos de cada trabajo ──────────────────────
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
  // un lector que no conoce la clave `merge_suites`: la sección no edita y lo dice
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
  // la pantalla dibuja el valor de hoy de cada trabajo con los que le da la vista (pantallaFalsa está más abajo), en la
  // columna «Por defecto» de su renglón
  const p = await pantallaFalsa([{ id: 'modelos', titulo: 'm', repo: 'perfil', estado: 'cargado', borrador: {}, problems: [], avisos: [], extras: { hoy: MOD.DEFAULTS } }]);
  const porDefecto = Object.fromEntries(p.todo(p.sec('modelos')).filter((n) => String(n.attrs.class || '').split(' ').includes('r'))
    .map((f) => [f.hijos[0].hijos.map((x) => x.textContent).join(''), f.hijos[1].textContent]));
  // la columna habla en niveles: el valor de hoy, con el nombre de su nivel en el idioma de la página
  const enPantalla = (m) => require(path.join(ROOT, 'scripts', 'site', 'texts.js')).t('es', `pantalla.nivel.${MOD.levelOf(m)}`);
  assert.strictEqual(porDefecto['Primera vuelta'], enPantalla(MOD.DEFAULTS.reviewers), JSON.stringify(porDefecto));
  assert.strictEqual(porDefecto['Sesión, historia pesada'], enPantalla(MOD.DEFAULTS.session.heavy), JSON.stringify(porDefecto));
  // la sesión de una historia pesada dice opus (potente) de fábrica; fable (máximo) sólo si la organización lo declara
  assert.ok(porDefecto['Sesión, historia pesada'] === 'potente' && !Object.values(porDefecto).includes('máximo'), JSON.stringify(porDefecto));
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

// ── lo que la pantalla de las dos secciones (suites y modelos) tiene que aguantar ─────────────────
/** La pantalla real sobre un documento mínimo con eventos: `click(texto, seccion)` aprieta un botón; `pedidos` anota cada fetch. */
async function pantallaFalsa(secciones, respuestas = {}) {
  const creados = [];
  const nodo = (tag) => { const n = { tag, hijos: [], textContent: '', attrs: {}, on: {}, setAttribute(k, v) { n.attrs[k] = v; }, appendChild(c) { n.hijos.push(c); return c; }, addEventListener(e, f) { n.on[e] = f; }, replaceChildren(...cs) { n.hijos = cs; } }; creados.push(n); return n; };
  const app = nodo('div');
  const document = { querySelector: () => null, getElementById: (id) => (id === 'config-app' ? app : null), createElement: (t) => nodo(t) };
  const pedidos = [];
  const respuesta = { ok: true, secciones, proponer: {}, versiones: [], productos: [] };
  const fetch = (ruta, o) => { pedidos.push({ ruta, cuerpo: o && o.body ? JSON.parse(o.body) : null }); return Promise.resolve({ status: 200, json: () => Promise.resolve(ruta === '/api/config' ? respuesta : respuestas[ruta] ? respuestas[ruta](o && o.body ? JSON.parse(o.body) : null) : { ok: false, problems: [] }) }); };
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

// ── la configuración del equipo, entera desde el sitio ───────────────────────────────────────────────
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
  assert.ok(s, 'hay una sección «Cómo contesta el agente»');
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
  // integraciones: las seis del equipo (CodeGraph incluido); Telegram no se edita acá (es de cada máquina)
  const integ = ORG.seccionPorId('integraciones');
  // la herramienta de horas y la llave vieja, para poder sacarla; las hojas de cada herramienta salen de sus manifiestos
  assert.deepStrictEqual(ORG.rutasDeHoras(), ['integrations.solidtime']);
  assert.deepStrictEqual(integ.rutas, ['integrations.timeTracking', 'integrations.notify', 'integrations.clockify', 'integrations.engram', 'integrations.mailbox', 'integrations.codex', 'integrations.nightly', 'integrations.codegraph']);
  cambio(rev('integraciones', { integrations: { clockify: false, engram: true, mailbox: true, codex: true, nightly: true, codegraph: true } }), { ...PERFIL_TYCON, integrations: { ...PERFIL_TYCON.integrations, clockify: false, codex: true, codegraph: true } });
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

// ── lo que el sitio tiene que aguantar de la configuración del equipo ─────────────────────────────────────────────
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
    // las seis integraciones son de la sección (CodeGraph también): lo de otra clave del perfil, no
    const doc2 = JSON.parse(ok2.texto); doc2.ado = { org: 'https://dev.azure.com/otra' };
    assert.match((await proponer('integraciones', ORG.formatJson(doc2))).message, /ado.*no es de esta sección/);
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

test('T12 7.31-Cobertura_SeccionConSuPorton @story-7.31 @ac-11 @ac-12 — el umbral de cobertura se edita en team-repos.json, con el lector y la versión que lo leen', async () => {
  // 🔴 rojo: la sección no existe, se propone con una capa que no la sabe leer, o cambia otra cosa del archivo.
  const s = ORG.seccionPorId('cobertura');
  assert.ok(s, 'hay una sección de la cobertura de las pruebas');
  assert.deepStrictEqual([s.titulo, s.archivo, s.repo, s.lector, s.claves, s.idCorto], ['Cobertura de las pruebas', 'team-repos.json', 'perfil', 'team-repos.js', ['coverage'], 'repos']);
  assert.ok(ORG.versionAtLeast(ORG.COVERAGE_SINCE, ORG.WAIT_NOTICE_SINCE) && ORG.COVERAGE_SINCE !== ORG.WAIT_NOTICE_SINCE);
  const malo = ORG.revisar({ seccion: 'cobertura', texto: ORG.formatJson(TR_BASE), borrador: { coverage: { min_touched_lines_pct: 0 } }, lectores: { 'team-repos.js': TR } });
  assert.strictEqual(malo.ok, false);
  assert.deepStrictEqual(malo.problems.map((p) => p.path), ['coverage.min_touched_lines_pct'], 'el lector da el problema y la sección no lo propone');
  for (const [v, espera] of [[ORG.WAIT_NOTICE_SINCE, /todavía no se puede proponer.*coverage/], [ORG.COVERAGE_SINCE, PASO_EL_PORTON]]) {
    await conPerfil({ layer: capa(v) }, async ({ seccion, revisar, proponer }) => {
      assert.strictEqual((await seccion('cobertura')).estado, 'cargado');
      const r = await revisar('cobertura', { coverage: { min_touched_lines_pct: 80 } });
      assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
      assert.deepStrictEqual(JSON.parse(r.texto), { ...TR_BASE, coverage: { min_touched_lines_pct: 80 } }, 'el resto del archivo igual');
      assert.match((await proponer('cobertura', r.texto)).message, espera);
    });
  }
});

test('T13 7.31-Cobertura_EnSuBloque @story-7.31 @ac-11 — la sección va en «Cómo trabaja el agente», después de «Pruebas al mergear»', async () => {
  // 🔴 rojo: la sección en otra pestaña, o fuera de su lugar.
  const r = await pantallaConPestanas({ secciones: [...TODAS, 'cobertura'].map((id) => SEC(id)) });
  const panel = r.panelDe('seccion-cobertura');
  assert.strictEqual((panel || { attrs: {} }).attrs.id, 'pestana-claude');
  const orden = []; const walk = (x) => { if (/^seccion-/.test(x.attrs.id || '')) orden.push(x.attrs.id); (x.hijos || []).forEach(walk); }; walk(panel);
  assert.deepStrictEqual(orden.slice(orden.indexOf('seccion-suites'), orden.indexOf('seccion-suites') + 2), ['seccion-suites', 'seccion-cobertura']);
});

test('T12 …el campo de la sección: un número entero va como número, vacío saca la clave, un texto llega tal cual al lector @story-7.31 @ac-11', async () => {
  // 🔴 rojo: «abc» se convierte en NaN (el archivo escribe null y el aviso dice «es null» en vez de qué corregir), o un
  // campo vaciado deja `coverage: {}` en el archivo.
  const sec = SEC('cobertura', { repo: 'perfil', borrador: {} });
  const r = await pantallaConPestanas({ secciones: [...TODAS.map((id) => SEC(id)), sec] });
  // los nodos actuales (la pantalla vuelve a dibujar después de cada revisión)
  const enLaSeccion = (pred) => {
    const caja = r.creados.filter((n) => n.attrs.id === 'seccion-cobertura').pop();
    const out = []; const walk = (x) => { if (pred(x)) out.push(x); (x.hijos || []).forEach(walk); }; walk(caja);
    return out.pop();
  };
  const escribir = (v) => enLaSeccion((n) => n.tag === 'input' && n.attrs['data-path'] === 'coverage.min_touched_lines_pct').on.input({ target: { value: v } });
  const revisarCon = async (v) => {
    escribir(v);
    enLaSeccion((n) => n.tag === 'button' && n.textContent === 'Revisar cambios').on.click();
    for (let i = 0; i < 10; i++) await new Promise((x) => setImmediate(x));
    return r.llamadas.filter((l) => /revisar/.test(l.ruta)).pop().cuerpo.borrador;
  };
  assert.deepStrictEqual((await revisarCon('80')).coverage, { min_touched_lines_pct: 80 });
  const conTexto = await revisarCon('abc');
  assert.deepStrictEqual(conTexto.coverage, { min_touched_lines_pct: 'abc' }, 'el texto llega al lector, que dice «es "abc"»');
  const malo = ORG.revisar({ seccion: 'cobertura', texto: ORG.formatJson(TR_BASE), borrador: conTexto, lectores: { 'team-repos.js': TR } });
  assert.match(malo.problems[0].message, /porcentaje entero, de 1 a 100 \(es "abc"\)/);
  assert.strictEqual((await revisarCon('')).coverage, undefined, 'vacío: sin la clave, el de siempre (75)');
});

test('Review_MaxRounds_EditableOnSite @story-7.37 @ac-4 — el tope de vueltas de revisores se edita en team-repos.json, con su campo y su validación', async () => {
  // 🔴 rojo: la sección no existe, no tiene su campo, o un valor fuera de 1 a 6 / un prefijo inválido pasa sin motivo.
  const s = ORG.seccionPorId('revision');
  assert.ok(s, 'hay una sección de las vueltas de revisores');
  assert.deepStrictEqual([s.titulo, s.archivo, s.repo, s.lector, s.claves, s.idCorto], ['Vueltas de revisores', 'team-repos.json', 'perfil', 'team-repos.js', ['review'], 'repos']);
  assert.ok(ORG.versionAtLeast(ORG.REVIEW_SINCE, ORG.COVERAGE_SINCE) && ORG.REVIEW_SINCE !== ORG.COVERAGE_SINCE);
  const rev = (review) => ORG.revisar({ seccion: 'revision', texto: ORG.formatJson(TR_BASE), borrador: { review }, lectores: { 'team-repos.js': TR } });
  const bien = rev({ max_rounds: 3, blocking_prefixes: ['PAGOS', 'SIGNALR-C'] });
  assert.strictEqual(bien.ok, true, JSON.stringify(bien.problems));
  assert.deepStrictEqual(JSON.parse(bien.texto), { ...TR_BASE, review: { max_rounds: 3, blocking_prefixes: ['PAGOS', 'SIGNALR-C'] } }, 'el resto del archivo igual');
  for (const n of [0, 7, 2.5, '3']) {
    const malo = rev({ max_rounds: n });
    assert.strictEqual(malo.ok, false, `max_rounds ${JSON.stringify(n)}`);
    assert.deepStrictEqual(malo.problems.map((p) => p.path), ['review.max_rounds']);
    assert.match(malo.problems[0].message, /de 1 a 6/);
  }
  for (const [lista, ruta] of [[['pagos'], 'review.blocking_prefixes.0'], [['SEC', 'A B'], 'review.blocking_prefixes.1'], [['SEC', 'SEC'], 'review.blocking_prefixes.1'], [[''], 'review.blocking_prefixes.0']]) {
    const malo = rev({ blocking_prefixes: lista });
    assert.strictEqual(malo.ok, false, JSON.stringify(lista));
    assert.deepStrictEqual(malo.problems.map((p) => p.path), [ruta]);
  }
  // el campo está en la pantalla, dentro de «Cómo trabaja el agente»
  const r = await pantallaConPestanas({ secciones: [...TODAS.map((id) => SEC(id)), SEC('revision', { repo: 'perfil', borrador: {} })] });
  const caja = r.creados.filter((n) => n.attrs.id === 'seccion-revision').pop();
  const hallados = []; const walk = (x) => { if (x.tag === 'input' && x.attrs['data-path'] === 'review.max_rounds') hallados.push(x); (x.hijos || []).forEach(walk); }; walk(caja);
  assert.strictEqual(hallados.length, 1, 'la sección trae el campo del tope');
  assert.strictEqual(r.panelDe('seccion-revision').attrs.id, 'pestana-claude');
});

test('T12 …la clase: ningún campo numérico de la pantalla convierte un texto en null @story-7.31 @ac-11', () => {
  // 🔴 rojo: un campo que hace `Number(v)` manda NaN, el archivo escribe null y el aviso dice «es null» en vez de qué corregir.
  const fuente = ORG.pantalla();
  // toda conversión a número de la pantalla, salvo la de numOTexto, la de una ruta («fila N») y el id de un pipeline
  const conversiones = fuente.split('\n').filter((l) => /\bNumber\(|parseInt\(|parseFloat\(|[=:(,]\s*\+\s*(v|e\.target)\b/.test(l))
    .filter((l) => !/function numOTexto|Number\(p\) \+ 1|full_tests_pipeline/.test(l));
  assert.deepStrictEqual(conversiones, [], 'los campos numéricos pasan por numOTexto');
  const numOTexto = new Function(`${fuente.match(/function numOTexto\([^)]*\)\s*\{[^}]*\}/)[0]}; return numOTexto;`)();
  assert.deepStrictEqual([numOTexto('80'), numOTexto(' 7 '), numOTexto('0.5'), numOTexto('abc'), numOTexto('8 0')], [80, 7, 0.5, 'abc', '8 0']);
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

// ── el perfil de instalación, por tema ─────────────────────────────────────────────────────────────────────────────
test('Perfil_LoQueApuntaElArchivo_ExisteEnElSitio — cada sección y pestaña que nombra install-effects.json es una de verdad', () => {
  const efectos = JSON.parse(texto('scripts/setup/install-effects.json')).effects;
  const secciones = ORG.SECCIONES.map((s) => s.id);
  const pestanas = [...pantallaEnCastellano().matchAll(/\['([a-z]+)', '[^']+', \[[^\]]*\], \[[^\]]*\]\]/g)].map((m) => m[1]);
  assert.deepStrictEqual(pestanas, ['personas', 'repos', 'avisos', 'claude', 'instalacion'], 'las pestañas, leídas de la pantalla');
  for (const e of efectos) {
    if (e.site_section) assert.ok(secciones.includes(e.site_section), `${e.title}: la sección ${e.site_section}`);
    if (e.site_pending) assert.ok(pestanas.includes(e.site_pending), `${e.title}: la pestaña ${e.site_pending}`);
    assert.doesNotMatch(e.does, /de fábrica: prendido/, `${e.title}: sin la frase que no dice si viene prendido`);
  }
});

test('Perfil_PorTema_ElMinimoYLoQueSumaElCompleto — grupos con su cuenta, una línea por cosa y dónde se cambia', async () => {
  const f = (title, group, extra = {}) => ({ title, group, does: `${title}, en detalle.`, default: 'on', when: 'always', switch: null, site_section: null, site_pending: null, ...extra });
  const frenos = f('Frena comandos destructivos', 'safety', { switch: 'TYCON_SAFETY_GUARD=0', site_pending: 'claude' });
  const reloj = f('Propone abrir el timer', 'time', { when: 'integration:clockify', site_section: 'integraciones' });
  const sesion = f('Frena git si otra sesión usa la copia', 'safety', { default: 'off', switch: 'TYCON_SESSION_GUARD=1 lo prende' });
  const arranque = f('Guarda una copia del arranque', 'install');
  const sec = seccionPerfil('instalacion', {});
  sec.extras = { perfiles: { minimal: [frenos, reloj], full: [frenos, reloj, sesion, arranque], motivo: null } };
  const p = await pantallaFalsa([sec]);
  assert.strictEqual(p.error, null);
  const t = p.textoDe('instalacion');
  assert.match(t, /El mínimo trae 2 cosas/);
  assert.match(t, /El completo suma estas 2/, 'el completo no repite lo del mínimo');
  const grupos = p.todo(p.sec('instalacion')).filter((n) => n.tag === 'details' && n.attrs.class === 'grupo').map((d) => d.hijos[0].textContent);
  assert.deepStrictEqual(grupos, ['Frenos de seguridad (1)', 'Registro de tiempo (1)', 'Frenos de seguridad (1)', 'Instalación y actualización (1)'], 'por grupo, con su cuenta');
  assert.ok(p.todo(p.sec('instalacion')).filter((n) => n.tag === 'details' && n.attrs.class === 'grupo').every((d) => !d.attrs.open), 'cerrados');
  assert.match(t, /Viene con su integración\. Se cambia en Configuración → Cómo trabaja el agente → Integraciones\./, 'lo de la organización, en su sección');
  assert.match(t, /Viene prendido\. Sólo en tu máquina, con TYCON_SAFETY_GUARD=0\. Pendiente: que se pueda cambiar desde Configuración → Cómo trabaja el agente\./);
  assert.match(t, /Viene apagado\. Sólo en tu máquina, con TYCON_SESSION_GUARD=1 lo prende\./);
  assert.match(t, /Viene prendido\. Es parte del arnés: no se apaga\./);
  const titulos = p.todo(p.sec('instalacion')).filter((n) => n.tag === 'summary').map((n) => n.textContent);
  assert.ok(titulos.includes('Frena comandos destructivos') && titulos.every((x) => !/TYCON_/.test(x)), 'la línea de cada cosa, sin variables');
});
// ── los nombres en lugar de los números ────────────────────────────────────────────────────────────────────────────
const AZ = (org, project, repo) => ({ platform: 'azure', org, project, repo });

test('Nombres_PipelinesDelProyecto_SinPermisoYConLista — la lista sale por nombre, ordenada; sin el permiso se dice cuál falta', async () => {
  const RP = require(path.join(ROOT, 'scripts', 'lib', 'repo-proposal.js'));
  const urls = [];
  const resp = (status, doc) => async (url) => { urls.push(String(url)); return new Response(JSON.stringify(doc || {}), { status }); };
  const sin = await RP.pipelinesDelProyecto({ org: 'acme', project: 'Ventas', token: null, fetch: resp(200) });
  assert.deepStrictEqual([sin.ok, sin.codigo], [false, 'sin_permiso']);
  assert.match(sin.message, /falta su permiso de lectura de pipelines \(SITE_PIPELINES_TOKEN\)/);
  assert.deepStrictEqual(urls, [], 'sin credencial no se pregunta nada');
  const ok = await RP.pipelinesDelProyecto({ org: 'acme', project: 'Ventas', token: 't', urlBase: { azure: 'http://az.example' }, fetch: resp(200, { value: [{ id: 9, name: 'Ventas-Frontend-CI', folder: '\\' }, { id: 123, name: 'Ventas-Backend-CI', folder: '\\CI' }, { id: 'x', name: 'roto' }] }) });
  assert.deepStrictEqual(ok, { ok: true, pipelines: [{ id: 123, nombre: 'Ventas-Backend-CI', carpeta: 'CI' }, { id: 9, nombre: 'Ventas-Frontend-CI', carpeta: null }] });
  assert.match(urls[0], /^http:\/\/az\.example\/acme\/Ventas\/_apis\/pipelines\?/);
  assert.strictEqual((await RP.pipelinesDelProyecto({ org: 'acme', project: 'Ventas', token: 't', fetch: resp(403) })).codigo, 'sin_permiso', 'un permiso que no alcanza también lo dice');
  assert.strictEqual((await RP.pipelinesDelProyecto({ org: 'acme', project: 'Nada', token: 't', fetch: resp(404) })).codigo, 'no_reconozco');
  for (const project of ['', '..', 'a/b', 'a?b']) assert.strictEqual((await RP.pipelinesDelProyecto({ org: 'acme', project, token: 't', fetch: resp(200) })).codigo, 'no_reconozco', JSON.stringify(project));
});

test('Nombres_PruebasAlMergear_ElPipelineSeEligePorNombre_YSeGuardaElNumero — sin la lista, el número a mano con el motivo', async () => {
  const pipes = { ok: true, pipelines: [{ id: 123, nombre: 'Ventas-Backend-CI', carpeta: null }, { id: 9, nombre: 'Ventas-Frontend-CI', carpeta: null }] };
  const conLista = await pantallaFalsa([seccionPerfil('suites', { merge_suites: { repos: [{ repo: AZ('acme', 'Ventas', 'backend'), full_tests_pipeline: 123 }] } })], { '/api/config/pipelines': () => pipes });
  assert.strictEqual(conLista.error, null);
  // el renglón cerrado ya dice el pipeline por su nombre; los campos se abren con ✎
  assert.strictEqual(conLista.todo(conLista.sec('suites')).find((n) => String(n.attrs.class || '').split(' ').includes('pc')).textContent, 'Ventas-Backend-CI', 'cerrado, por nombre');
  conLista.todo(conLista.sec('suites')).find((n) => n.tag === 'button' && n.textContent === '✎').on.click({});
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(conLista.pedidos.filter((x) => x.ruta === '/api/config/pipelines').map((x) => x.cuerpo), [{ org: 'acme', project: 'Ventas' }], 'una sola vez por proyecto');
  const sel = conLista.todo(conLista.sec('suites')).find((n) => n.tag === 'select' && n.attrs['data-path'] === 'merge_suites.repos.0.full_tests_pipeline');
  assert.ok(sel, 'el pipeline se elige de una lista');
  assert.strictEqual(sel.value, '123');
  assert.deepStrictEqual(sel.hijos.map((o) => o.textContent), ['ninguno', 'Ventas-Backend-CI', 'Ventas-Frontend-CI'], 'por nombre, no por número');
  // sin permiso: el número a mano y por qué
  const sinPermiso = { ok: false, codigo: 'sin_permiso', message: 'el sitio no puede leer los pipelines: falta su permiso de lectura de pipelines (SITE_PIPELINES_TOKEN). Mientras tanto, escribí el número del pipeline' };
  const sinLista = await pantallaFalsa([seccionPerfil('suites', { merge_suites: { repos: [{ repo: AZ('acme', 'Ventas', 'backend'), full_tests_pipeline: 123 }] } })], { '/api/config/pipelines': () => sinPermiso });
  sinLista.todo(sinLista.sec('suites')).find((n) => n.tag === 'button' && n.textContent === '✎').on.click({});
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const inp =sinLista.todo(sinLista.sec('suites')).find((n) => n.tag === 'input' && n.attrs['data-path'] === 'merge_suites.repos.0.full_tests_pipeline');
  assert.ok(inp, 'a mano');
  assert.strictEqual(inp.attrs.value, '123');
  assert.match(sinLista.textoDe('suites'), /falta su permiso de lectura de pipelines/);
});

test('Nombres_Despliegues_LosPasosConSuNombre — lo guardado dice el nombre del paso, no su identificador', async () => {
  const sec = { id: 'despliegues', titulo: 'despliegues', repo: 'operaciones', estado: 'cargado', soloLectura: false, problems: [], avisos: [], extras: { plataforma: 'azure', org: 'acme', proyecto: 'Ops' },
    borrador: { deployments: { provider: 'azure', products: { ventas: { staging: [{ pipeline: 'Ventas/Ventas-CD', stages: ['deploy_stg'] }], production: [{ pipeline: 'Ventas/Ventas-CD', stages: ['deploy_prod'] }] } } } } };
  const p = await pantallaFalsa([sec], { '/api/config/pasos': () => ({ ok: true, nombres: { deploy_stg: 'Desplegar a prueba', deploy_prod: 'Desplegar a producción' } }), '/api/config/pipelines': () => ({ ok: true, pipelines: [{ id: 41, nombre: 'Ventas-CD', carpeta: null }] }) });
  const t = p.textoDe('despliegues');
  assert.match(t, /Desplegar a prueba \(pipeline Ventas-CD\)/);
  assert.match(t, /Desplegar a producción \(pipeline Ventas-CD\)/);
  assert.doesNotMatch(t.replace(/Escribirlo a mano[\s\S]*/, ''), /deploy_stg/);
  assert.ok(p.todo(p.sec('despliegues')).some((n) => n.tag === 'select' && n.hijos.some((o) => o.textContent === 'Ventas-CD')), 'el pipeline para agregar, de la lista');
});

test('Nombres_PaquetesModelosBuzonParidad_SinClavesDelArchivo — casillas, filas por revisor, servicio y qué se compara, en palabras', async () => {
  const paquetes = { id: 'paquetes', titulo: 'Paquetes', repo: 'perfil', estado: 'cargado', soloLectura: false, problems: [], avisos: [], borrador: { packs: { default: ['ventas'] } }, extras: { instalados: ['ventas', 'compras'], activos: ['ventas'] } };
  const modelos = seccionPerfil('modelos', { models: { reviewer: { 'acme-silent-failure-hunter': 'opus' } } });
  modelos.extras = { hoy: null, motivoHoy: 'x', revisores: ['acme-silent-failure-hunter', 'acme-story-validator'] };
  const sitio = { id: 'sitio', titulo: 'sitio', repo: 'operaciones', estado: 'cargado', soloLectura: false, problems: [], avisos: [], borrador: { site: { mailbox: { provider: 'azure-blob' } } }, extras: { servicios: ['azure-blob'] } };
  const paridad = { id: 'paridad', titulo: 'paridad', repo: 'operaciones', estado: 'cargado', soloLectura: false, problems: [], avisos: [], borrador: {}, vista: { texto: 'ok', productos: [], declaradas: [], definicion: { rasgos: [{ id: 'lint-en-ci', que: 'corre el lint en la integración' }] } } };
  const p = await pantallaFalsa([paquetes, modelos, sitio, paridad]);
  assert.strictEqual(p.error, null);
  const cajas = p.todo(p.sec('paquetes')).filter((n) => n.tag === 'input' && n.attrs.type === 'checkbox');
  assert.deepStrictEqual(cajas.map((c) => [c.attrs['aria-label'], Boolean(c.checked)]), [['ventas', true], ['compras', false]]);
  assert.doesNotMatch(p.textoDe('paquetes'), /packs\.default|all, none/);
  const tm = p.textoDe('modelos');
  assert.match(tm, /Fallas que pasan en silencio \(acme-silent-failure-hunter\)/, 'el revisor con su nombre llano');
  // la pantalla dice «historia» en castellano
  assert.ok(p.todo(p.sec('modelos')).some((n) => n.tag === 'option' && n.textContent === 'Que la historia esté completa antes de empezar (acme-story-validator)'), 'y los demás, para agregar');
  assert.ok(!p.todo(p.sec('modelos')).some((n) => n.tag === 'textarea' && n.attrs['data-path'] === 'reviewer'), 'sin JSON para un revisor');
  const serv = p.todo(p.sec('sitio')).find((n) => n.tag === 'select' && n.attrs['data-path'] === 'site.mailbox.provider');
  assert.ok(serv && serv.hijos.some((o) => o.textContent === 'Azure Blob Storage'), 'el servicio del buzón, de una lista');
  assert.match(p.textoDe('paridad'), /corre el lint en la integración/);
  assert.doesNotMatch(p.textoDe('paridad'), /"rasgos"/, 'sin el JSON de la definición');
});

test('Nombres_Guia_DiceElPermisoDeLosPipelines — la instalación normal cuenta qué permiso pide SITE_PIPELINES_TOKEN y qué se ve sin él', () => {
  for (const [f, sin] of [['organization-site.md', /Sin él, la pestaña pide el número del pipeline a mano/], ['organization-site.en.md', /Without it, the tab asks for the pipeline number by hand/]]) {
    const fila = texto(`guides/${f}`).split('\n').find((l) => l.startsWith('| `SITE_PIPELINES_TOKEN` |'));
    assert.ok(fila, `${f}: la fila propia de SITE_PIPELINES_TOKEN`);
    assert.match(fila, /\*Build: Read\*/, `${f}: el permiso`);
    assert.match(fila, sin, `${f}: qué se ve sin él`);
  }
});

// ── la marca de la organización ────────────────────────────────────────────────────────────────────────────────────
test('Marca_ElLectorValidaSiteBrand — nombre, logo dentro del repo de operaciones (.png o .svg) y qué hacer en oscuro', () => {
  const problemas = (brand) => OPS.parse(JSON.stringify({ version: 1, owners: { default: LEAD }, site: { brand } })).problems.map((p) => p.path);
  assert.deepStrictEqual(problemas({ name: 'Acme', logo: 'marca/logo.png', dark: 'keep' }), []);
  assert.deepStrictEqual(problemas({ logo: 'marca/logo.svg', dark: 'invert' }), []);
  for (const logo of ['../logo.png', '/etc/logo.png', 'marca/../../x.png', 'marca/logo.gif', 'marca/logo.png?x', '']) assert.deepStrictEqual(problemas({ logo }), ['site.brand.logo'], JSON.stringify(logo));
  assert.deepStrictEqual(problemas({ name: 'x'.repeat(81) }), ['site.brand.name']);
  assert.deepStrictEqual(problemas({ dark: 'grises' }), ['site.brand.dark']);
  assert.deepStrictEqual(problemas({ color: 'rojo' }), ['site.brand.color'], 'una clave que no conoce');
});

test('Marca_LaOrganizacionEnPersonas_ConVistaPrevia — se edita en Configuración; un lector viejo dice que no sabe leerla', async () => {
  const sec = { id: 'organizacion', titulo: 'La organización', repo: 'operaciones', estado: 'cargado', soloLectura: false, problems: [], avisos: [], borrador: { site: { brand: { name: 'Acme', logo: 'marca/logo.png' } } } };
  const p = await pantallaFalsa([sec]);
  assert.strictEqual(p.error, null);
  const campos = p.todo(p.sec('organizacion')).filter((n) => ['input', 'select'].includes(n.tag)).map((n) => n.attrs['data-path']);
  assert.deepStrictEqual(campos, ['site.brand.name', 'site.brand.logo', 'site.brand.dark']);
  const img = p.todo(p.sec('organizacion')).find((n) => n.tag === 'img');
  assert.deepStrictEqual([img.attrs.src, img.attrs.class], ['/marca/logo', 'logo logo-previa invierte'], 'la vista previa, como se ve en la barra');
  assert.match(p.textoDe('organizacion'), /El archivo del logo entra con un pedido al repo de operaciones/);
  // el lector de una versión anterior no conoce site.brand: la sección no se edita y lo dice
  const viejo = { ...OPS, SITE_KEYS: OPS.SITE_KEYS.filter((k) => k !== 'brand') };
  const ops = clon({ 'operations.json': opsBase() });
  await conPestana({ fuentes: fuentesCon({ ops }), opciones: { lectores: { 'operations-config.js': viejo } } }, async ({ h, entrar }) => {
    const r = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json;
    const o = r.secciones.find((s) => s.id === 'organizacion');
    assert.deepStrictEqual([o.estado, o.motivo], ['no_reader', 'esta versión del arnés todavía no sabe leer la marca de la organización (site.brand)']);
  });
});

// ── quién entra al sitio lo decide la lista, y el inicio de sesión elegido se ve ─────────
test('T6 2.40-Personas_EditaLaLista @story-2.40 @ac-6 @ac-5', async () => {
  // (la lista vive en operations.json como las demás secciones de Personas)
  const M = 'mant@acme.example';
  const conLista = { version: 1, owners: { default: LEAD }, reviewers: { watcher: ['w@acme.example'] },
    site: { access: [{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [DEV, 'dev.a.casa@mail.example'] }], refresh_minutes: 20, mailbox: { provider: 'azure-blob', account: 'acmeruns', container: 'runs' } },
    people: { machines: { 'maq-a': { person: DEV, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' } } } };
  await conPestana({ fuentes: fuentesCon({ ops: clon({ 'operations.json': conLista }), config: conLista }) }, async ({ h, entrar, token, escribir }) => {
    const lead = await entrar(LEAD); const tok = await token(lead);
    const s = (await h.pedir('/api/config', { cookie: lead })).json.secciones.find((x) => x.id === 'sitio');
    assert.deepStrictEqual(s.borrador.site.access, conLista.site.access, 'la sección trae la lista');
    assert.strictEqual(s.extras.migracion, undefined, 'con la lista puesta, sin aviso de migración');
    const rev = async (access) => (await escribir('/api/config/revisar', lead, tok, { seccion: 'sitio', borrador: { site: { ...conLista.site, access } } })).json;
    // sumar a alguien, sumar un correo, cambiar el rol: cada pedido cambia sólo esa entrada; el resto, byte por byte
    const cambios = [
      ['sumar a alguien', [...conLista.site.access, { role: 'maintainer', emails: [M] }]],
      ['sumar un correo', [conLista.site.access[0], { role: 'dev', emails: [DEV, 'dev.a.casa@mail.example', 'dev.a.otra@mail.example'] }]],
      ['cambiar el rol', [conLista.site.access[0], { role: 'maintainer', emails: [DEV, 'dev.a.casa@mail.example'] }]],
      ['sacar un correo', [conLista.site.access[0], { role: 'dev', emails: [DEV] }]],
      ['sacar a alguien', [conLista.site.access[0]]],
    ];
    for (const [caso, access] of cambios) {
      const r = await rev(access);
      assert.strictEqual(r.ok, true, `${caso}: ${JSON.stringify(r.problems)}`);
      assert.strictEqual(r.texto, ORG.formatJson({ ...conLista, site: { ...conLista.site, access } }), caso);
    }
    // sin nadie que mantenga no se propone; un correo repetido, con su ruta
    const sinMant = await rev([{ role: 'dev', emails: [DEV] }]);
    assert.strictEqual(sinMant.ok, false);
    assert.ok(sinMant.problems.some((p) => p.path === 'site.access' && /quedaría sin nadie que pueda entrar a esta pestaña/.test(p.message)), JSON.stringify(sinMant.problems));
    const repetido = await rev([{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: ['LEAD@acme.example'] }]);
    assert.ok(repetido.problems.some((p) => p.path === 'site.access.1.emails.0'));
    const sinMi = await rev([{ role: 'maintainer', emails: [M] }]);
    assert.match(sinMi.advertencia, /no estás en la lista que proponés: al mergear perdés el acceso/);
    // proponer revalida: un texto sin ningún maintainer no se propone aunque se arme a mano
    const aMano = ORG.formatJson({ ...conLista, site: { ...conLista.site, access: [{ role: 'dev', emails: [DEV] }] } });
    const p = (await escribir('/api/config/proponer', lead, tok, { seccion: 'sitio', texto: aMano, oid: 'x' })).json;
    assert.strictEqual(p.ok, false);
    assert.match(p.message, /sin nadie que pueda entrar/);
  });
  // la migración: sin site.access, la sección arranca con la lista armada con lo de hoy y la propone sin site.maintainers
  const hoy = { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD], refresh_minutes: 20 }, people: conLista.people };
  await conPestana({ fuentes: fuentesCon({ ops: clon({ 'operations.json': hoy }), config: hoy }) }, async ({ h, entrar, token, escribir }) => {
    const lead = await entrar(LEAD); const tok = await token(lead);
    const s = (await h.pedir('/api/config', { cookie: lead })).json.secciones.find((x) => x.id === 'sitio');
    assert.deepStrictEqual(s.borrador.site, { refresh_minutes: 20, access: [{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [DEV] }] });
    assert.match(s.extras.migracion, /se armó con lo de hoy/);
    const r = (await escribir('/api/config/revisar', lead, tok, { seccion: 'sitio', borrador: s.borrador })).json;
    assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
    assert.strictEqual(r.texto, ORG.formatJson({ ...hoy, site: s.borrador.site }), 'el pedido cambia sólo site');
  });
  // si todo lo de hoy está mal escrito, la sección igual avisa que quedó afuera (aunque no haya lista para proponer)
  const basura = { version: 1, owners: { default: LEAD }, site: { maintainers: ['no es un correo'] } };
  await conPestana({ fuentes: fuentesCon({ ops: clon({ 'operations.json': basura }), config: opsBase() }) }, async ({ h, entrar }) => {
    const s = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json.secciones.find((x) => x.id === 'sitio');
    assert.match(String(s.extras.migracion), /1 correo\(s\) .*quedaron afuera/, JSON.stringify(s.extras));
  });
  // la pantalla: sumar a alguien, sumar un correo y elegir el rol, sin JSON a mano
  const sec = { id: 'sitio', titulo: 'sitio', repo: 'operaciones', estado: 'cargado', soloLectura: false, problems: [], avisos: [],
    borrador: { site: { access: [{ role: 'maintainer', emails: [LEAD] }] } }, extras: { servicios: ['azure-blob'], conAcceso: true, migracion: 'la lista se armó con lo de hoy' } };
  const pant = await pantallaFalsa([sec]);
  assert.strictEqual(pant.error, null);
  // un correo escrito es una etiqueta con su ruta; uno recién sumado, un campo
  const campos = () => pant.todo(pant.sec('sitio')).filter((n) => ['input', 'select', 'span'].includes(n.tag)).map((n) => n.attrs['data-path']).filter((x) => /^site\.access/.test(x || ''));
  assert.deepStrictEqual(campos(), ['site.access.0.role', 'site.access.0.emails.0']);
  assert.match(pant.textoDe('sitio'), /la lista se armó con lo de hoy/);
  await pant.click('+ Agregar persona', 'sitio');
  assert.deepStrictEqual(campos(), ['site.access.0.role', 'site.access.0.emails.0', 'site.access.1.role', 'site.access.1.emails.0']);
  // el + del primer renglón suma un correo
  await pant.click('+', 'sitio');
  assert.ok(campos().includes('site.access.0.emails.1'), campos().join(' '));
  const rol = pant.todo(pant.sec('sitio')).find((n) => n.tag === 'select' && n.attrs['data-path'] === 'site.access.0.role');
  assert.deepStrictEqual(rol.hijos.map((o) => o.textContent), ['Mantiene el sitio', 'Dev']);
  assert.ok(!pant.todo(pant.sec('sitio')).some((n) => n.attrs['data-path'] === 'site.maintainers'), 'con la lista, la forma de antes no se edita');
});

test('T10 2.40-InicioDeSesion_Visible @story-2.40 @ac-8', async () => {
  const org = crypto.randomUUID();
  const textoDe = (env) => validarConfiguracion(H.envBase(env)).cfg.inicioDeSesion;
  const casos = [
    [{}, 'oidc', null, /OpenID Connect/],
    [{ SITE_AUTH_PROVIDER: 'microsoft', SITE_OIDC_ISSUER: `https://login.microsoftonline.com/${org}/v2.0` }, 'microsoft', 'organization', /Microsoft.*directorio de la organización/],
    [{ SITE_AUTH_PROVIDER: 'microsoft', SITE_AUTH_MICROSOFT_ACCOUNTS: 'any', SITE_AUTH_MICROSOFT_TENANT: org, SITE_OIDC_ISSUER: 'https://login.microsoftonline.com/common/v2.0' }, 'microsoft', 'any', /cualquier cuenta de trabajo o escuela.*invitados/],
    [{ SITE_AUTH_PROVIDER: 'google', SITE_AUTH_ALLOWED_DOMAINS: 'acme.example' }, 'google', null, /Google/],
    [{ SITE_AUTH_PROVIDER: 'github', SITE_AUTH_GITHUB_ORG: 'acme' }, 'github', null, /GitHub/],
  ];
  for (const [env, proveedor, modo, rx] of casos) {
    const i = textoDe(env);
    assert.ok(i, proveedor);
    assert.deepStrictEqual([i.proveedor, i.modo], [proveedor, modo], proveedor);
    assert.match(i.texto, rx, proveedor);
    assert.doesNotMatch(i.texto, new RegExp(org), 'sin el inquilino');
  }
  // la pestaña lo trae en la sección del sitio, y la pantalla lo muestra sin un campo para cambiarlo
  await conPestana({ fuentes: fuentesCon({ ops: clon({ 'operations.json': opsBase() }) }) }, async ({ h, entrar }) => {
    const s = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json.secciones.find((x) => x.id === 'sitio');
    assert.match(s.extras.inicioDeSesion.texto, /OpenID Connect/);
  });
  const sec = { id: 'sitio', titulo: 'sitio', repo: 'operaciones', estado: 'cargado', soloLectura: false, problems: [], avisos: [], borrador: { site: { access: [{ role: 'maintainer', emails: [LEAD] }] } },
    extras: { conAcceso: true, inicioDeSesion: { proveedor: 'microsoft', modo: 'any', texto: 'Microsoft, con cualquier cuenta de trabajo o escuela' } } };
  const p = await pantallaFalsa([sec]);
  assert.match(p.textoDe('sitio'), /Con qué se entra: Microsoft, con cualquier cuenta de trabajo o escuela/);
  assert.match(p.textoDe('sitio'), /se cambia en la instalación/);
  // (el único «provider» de la sección es el servicio del buzón, site.mailbox.provider)
  assert.ok(!p.todo(p.sec('sitio')).some((n) => /inicio|auth|^(?!site\.mailbox\.).*provider/i.test(n.attrs['data-path'] || '')), 'sin un campo para cambiarlo');
});

// ── los cambios de un mantenedor se aplican solos ───────────────────────────────────────────────────────────
test('T1 Lector_AutoApply_SoloSiONo @story-2.39 @ac-1', () => {
  for (const v of [true, false]) assert.strictEqual(OPS.parse(ORG.formatJson(opsBase({ site: { maintainers: [LEAD], auto_apply: v } }))).ok, true, `auto_apply: ${v}`);
  assert.strictEqual(OPS.parse(ORG.formatJson(opsBase())).ok, true, 'sin la clave vale');
  const r = OPS.parse(ORG.formatJson(opsBase({ site: { maintainers: [LEAD], auto_apply: 'si' } })));
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.problems.map((p) => [p.path, p.message]), [['site.auto_apply', 'tiene que ser true o false']]);
});

test('T2 Seccion_AutoApply_CambiaSoloSuHoja @story-2.39 @ac-2', () => {
  const s = ORG.seccionPorId('aplicar');
  assert.ok(s, 'la sección existe');
  assert.deepStrictEqual([s.titulo, s.archivo, s.repo, s.lector, s.rutas, s.idCorto], ['Los cambios de un mantenedor', 'operations.json', 'operaciones', 'operations-config.js', ['site.auto_apply'], 'operations']);
  const base = opsBase({ site: { maintainers: [LEAD], refresh_minutes: 15 } });
  const r = ORG.revisar({ seccion: 'aplicar', texto: ORG.formatJson(base), borrador: { site: { maintainers: ['otro@acme.example'], refresh_minutes: 30, auto_apply: true } }, lectores: { 'operations-config.js': OPS } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  assert.strictEqual(r.texto, ORG.formatJson({ ...base, site: { ...base.site, auto_apply: true } }), 'sólo la hoja del interruptor');
  // en la pestaña Personas, junto a «El sitio», con su editor de tres opciones
  const codigo = pantallaEnCastellano();
  assert.match(codigo, /\['personas', 'Personas', \['organizacion', 'sitio', 'aplicar',/);
  assert.match(codigo, /aplicar: editorAplicar/);
  for (const t of ['sin declarar (no)', 'sí: se aplican solos', 'no: queda el pedido para aprobar']) assert.ok(codigo.includes(t), t);
});

/** El repo de operaciones por HTTP, Azure de juguete que deja completar y mueve main, y la pestaña encima. */
async function conAplicar({ autoApply, politica = 'autor', ops = null, masPoliticas = () => [], log = () => {}, esperaRefrescoMs }, fn) {
  const { arrancarAdoFalso } = require('./lib/fake-ado-api.js');
  let ado, r, dir;
  const remotos = { operaciones: { platform: 'azure', org: 'acme', project: 'Proy', repo: 'ops', web: 'https://dev.azure.com/acme/Proy/_git/ops' } };
  try {
    ado = await arrancarAdoFalso({ org: 'acme', project: 'Proy', repo: 'ops' });
    const pol = { isEnabled: true, isBlocking: true, type: { displayName: 'Minimum number of reviewers' }, settings: { minimumApproverCount: 1, creatorVoteCounts: politica === 'autor', scope: [{ refName: 'refs/heads/main', matchKind: 'Exact', repositoryId: ado.st.repoId }] } };
    ado.st.politicas = [pol, ...masPoliticas(ado)];
    const doc = ops || opsBase({ site: { maintainers: [LEAD], ...(autoApply === undefined ? {} : { auto_apply: autoApply }) } });
    ({ r, dir } = await opsPorHttp({ 'operations.json': doc }));
    ado.st.permitirCompletar = true;
    ado.st.alCompletar = (p) => { const s = r.ref(p.sourceRefName); spawnSync('git', ['update-ref', 'refs/heads/main', s], { cwd: r.bare }); };
    const f = fuentesCon({ ops: dir, config: doc });
    // el candado de la propuesta y el refresco: la prueba anota si se releyó con el candado tomado
    let dentro = false;
    const refrescos = [];
    f.exclusivo = async (fn2) => { dentro = true; try { return await fn2(); } finally { dentro = false; } };
    f.releerDeVerdad = true;
    f.refrescar = async () => {
      refrescos.push({ dentro });
      if (!f.releerDeVerdad) return;
      const ex = require('util').promisify(require('child_process').execFile);
      await ex('git', ['-c', `http.extraheader=Authorization: ${CAB}`, 'fetch', '-q', '--depth', '1', 'origin', 'main'], { cwd: dir });
      await ex('git', ['reset', '-q', '--hard', 'FETCH_HEAD'], { cwd: dir });
    };
    await conPestana({ fuentes: f, env: { SITE_OPERATIONS_WRITE_TOKEN: ESCRITURA }, opciones: { remotos, urlBase: { azure: ado.base }, log, ...(esperaRefrescoMs === undefined ? {} : { esperaRefrescoMs }) } }, async (ctx) => {
      const lead = await ctx.entrar(LEAD); const tok = await ctx.token(lead);
      const estado = async () => (await ctx.h.pedir('/api/config', { cookie: lead })).json;
      const revisar = async (id, borrador) => (await ctx.escribir('/api/config/revisar', lead, tok, { seccion: id, borrador })).json;
      const proponer = async (id, texto) => { const s = (await estado()).secciones.find((x) => x.id === id); return (await ctx.escribir('/api/config/proponer', lead, tok, { seccion: id, texto, oid: s.oid })).json; };
      await fn({ ...ctx, ado, r, dir, f, refrescos, estado, revisar, proponer });
    });
  } finally { await cerrarTodos(r, ado); }
}
const parches = (ado) => ado.llamadas.filter((l) => l.method === 'PATCH');

test('T8 Interruptor_ElQueCuentaEsElDeMain @story-2.39 @ac-8', { skip: SIN_BACKEND }, async () => {
  // apagada en main: prenderla se propone y queda el pedido
  await conAplicar({ autoApply: false }, async ({ ado, revisar, proponer, r }) => {
    const rev = await revisar('aplicar', { site: { auto_apply: true } });
    assert.strictEqual(rev.ok, true, JSON.stringify(rev.problems));
    const antes = r.ref('refs/heads/main');
    const p = await proponer('aplicar', rev.texto);
    // con la opción apagada, la política que deja votar al autor apaga «Proponer»: no se aplica solo
    assert.strictEqual(p.ok, false, JSON.stringify(p));
    assert.match(p.message, /Allow requestors to approve their own changes/);
    assert.deepStrictEqual(parches(ado), []);
    assert.strictEqual(r.ref('refs/heads/main'), antes);
  });
  await conAplicar({ autoApply: false, politica: 'otro' }, async ({ ado, revisar, proponer, r }) => {
    const rev = await revisar('aplicar', { site: { auto_apply: true } });
    const antes = r.ref('refs/heads/main');
    const p = await proponer('aplicar', rev.texto);
    assert.strictEqual(p.ok, true, JSON.stringify(p));
    assert.match(p.message, /^Pedido abierto: /);
    assert.deepStrictEqual(parches(ado), [], 'prenderla nunca se aplica sola');
    assert.strictEqual(r.ref('refs/heads/main'), antes);
  });
  // prendida en main: apagarla se aplica solo
  await conAplicar({ autoApply: true }, async ({ ado, revisar, proponer, r }) => {
    const rev = await revisar('aplicar', { site: { auto_apply: false } });
    const p = await proponer('aplicar', rev.texto);
    assert.strictEqual(p.codigo, 'aplicado', JSON.stringify(p));
    assert.strictEqual(parches(ado).length, 1);
    assert.strictEqual(JSON.parse(r.archivoEn('refs/heads/main', 'operations.json')).site.auto_apply, false);
  });
});

test('T9 Pestana_Aplicado_RelleeYLoMuestra @story-2.39 @ac-9', { skip: SIN_BACKEND }, async () => {
  await conAplicar({ autoApply: true }, async ({ revisar, proponer, refrescos }) => {
    const rev = await revisar('responsables', { owners: { default: 'otro@acme.example' } });
    const p = await proponer('responsables', rev.texto);
    assert.deepStrictEqual([p.ok, p.codigo], [true, 'aplicado'], JSON.stringify(p));
    assert.deepStrictEqual(refrescos, [{ dentro: false }], 'releyó una vez, con el candado suelto');
    assert.match(p.message, /^Aplicado: el cambio ya está en la rama principal y el sitio lo usa/);
    assert.ok(p.enlace, 'con el enlace del pedido');
  });
  await conAplicar({ autoApply: true }, async ({ f, revisar, proponer, refrescos }) => {
    f.releerDeVerdad = false;
    const rev = await revisar('responsables', { owners: { default: 'otro@acme.example' } });
    const p = await proponer('responsables', rev.texto);
    assert.strictEqual(p.codigo, 'aplicado', JSON.stringify(p));
    assert.strictEqual(refrescos.length, 1);
    assert.match(p.message, /se completó.*próximo refresco/);
  });
  // lo que no queda aplicado pasa tal cual, sin releer
  await conAplicar({ autoApply: true }, async ({ ado, revisar, proponer, refrescos }) => {
    ado.st.evaluaciones = () => [{ configuration: { isEnabled: true, isBlocking: true, type: { displayName: 'Build' } }, status: 'rejected' }];
    const rev = await revisar('responsables', { owners: { default: 'otro@acme.example' } });
    const p = await proponer('responsables', rev.texto);
    assert.strictEqual(p.codigo, 'no_aplica_solo', JSON.stringify(p));
    assert.deepStrictEqual(refrescos, [], 'sin releer');
    assert.match(p.message, /^No se pudo aplicar solo: .*«Build»/);
  });
});

test('T11 EstadoProponer_DiceSiSeAplicaSolo @story-2.39 @ac-10', { skip: SIN_BACKEND }, async () => {
  await conAplicar({ autoApply: true }, async ({ estado }) => {
    const p = (await estado()).proponer.operaciones;
    assert.deepStrictEqual([p.habilitado, p.aplicaSolo], [true, true], JSON.stringify(p));
  });
  await conAplicar({ autoApply: true, politica: 'otro' }, async ({ estado }) => {
    const p = (await estado()).proponer.operaciones;
    assert.deepStrictEqual([p.habilitado, p.aplicaSolo], [true, false], JSON.stringify(p));
    assert.match(p.motivoAplicar, /queda el pedido para aprobar/);
  });
  await conAplicar({ autoApply: false }, async ({ estado }) => {
    const p = (await estado()).proponer.operaciones;
    assert.strictEqual(p.habilitado, false, JSON.stringify(p));
    assert.match(p.motivo, /Allow requestors to approve their own changes/);
  });
  // la pantalla dice qué va a pasar antes de tocar «Proponer»
  const codigo = ORG.pantalla();
  assert.ok(codigo.includes('Se aplica solo: el sitio aprueba y completa el pedido'), 'el texto de «se aplica solo»');
});

test('Aplicado_RefrescoLento_ContestaAlTope @story-2.68 @ac-1', { skip: SIN_BACKEND }, async () => {
  // el refresco entero (con la bajada del buzón) tarda minutos: la respuesta sale al tope y el refresco sigue solo
  const registro = [];
  await conAplicar({ autoApply: true, esperaRefrescoMs: 200, log: (l) => registro.push(l) }, async ({ f, revisar, proponer, refrescos }) => {
    let fallar; const lento = new Promise((ok, mal) => { fallar = mal; });
    // se mide desde que arranca el refresco: armar y aplicar el cambio (git y la plataforma de juguete) tarda lo suyo
    let t0 = null;
    f.refrescar = async () => { refrescos.push({ lento: true }); t0 = Date.now(); await lento; };
    try {
      const rev = await revisar('responsables', { owners: { default: 'otro@acme.example' } });
      const p = await proponer('responsables', rev.texto);
      const tardo = Date.now() - t0;
      assert.deepStrictEqual([p.ok, p.codigo], [true, 'aplicado'], JSON.stringify(p));
      assert.match(p.message, /próximo refresco/);
      assert.ok(tardo < 2000, `contestó en ${tardo} ms, sin esperar el refresco`);
      assert.strictEqual(refrescos.length, 1, 'el refresco arrancó');
      assert.ok(registro.some((l) => /el refresco sigue/.test(l)), registro.join('\n'));
    } finally {
      // el refresco que siguió solo falla después de la respuesta: queda en el registro, no se pierde
      fallar(new Error('el buzón no contestó'));
    }
    for (let i = 0; i < 20 && !registro.some((l) => /el refresco falló/.test(l)); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(registro.some((l) => /el refresco falló/.test(l)), registro.join('\n'));
  });
});

test('Aplicado_RefrescoRapido_ComoHoy @story-2.68 @ac-2', { skip: SIN_BACKEND }, async () => {
  await conAplicar({ autoApply: true, esperaRefrescoMs: 30000 }, async ({ revisar, proponer }) => {
    const rev = await revisar('responsables', { owners: { default: 'otro@acme.example' } });
    const p = await proponer('responsables', rev.texto);
    assert.deepStrictEqual([p.ok, p.codigo], [true, 'aplicado'], JSON.stringify(p));
    assert.match(p.message, /^Aplicado: el cambio ya está en la rama principal y el sitio lo usa/);
  });
});

test('T19 Pestana_RefrescoFalla_LoAnotaYSigue @story-2.39 @ac-9', { skip: SIN_BACKEND }, async () => {
  const registro = [];
  await conAplicar({ autoApply: true, log: (l) => registro.push(l) }, async ({ f, revisar, proponer }) => {
    f.refrescar = async () => { throw new Error('el repo no contestó'); };
    const rev = await revisar('responsables', { owners: { default: 'otro@acme.example' } });
    const p = await proponer('responsables', rev.texto);
    assert.deepStrictEqual([p.ok, p.codigo], [true, 'aplicado'], JSON.stringify(p));
    assert.match(p.message, /próximo refresco/);
    assert.ok(registro.some((l) => /el refresco falló/.test(l)), registro.join('\n'));
  });
});

test('T20 EstadoProponer_UnArchivoQueNoSeAplicaSolo_ElRepoTampoco @story-2.39 @ac-10', { skip: SIN_BACKEND }, async () => {
  // la del mínimo de revisores deja votar al autor en toda la rama; otra, con filtro, pide un revisor distinto para operations.json
  const requeridaParaOps = (ado) => [{ isEnabled: true, isBlocking: true, type: { displayName: 'Required reviewers' },
    settings: { minimumApproverCount: 1, creatorVoteCounts: false, addedFilesOnly: false, requiredReviewerIds: ['grupo-de-quienes-mantienen'], filenamePatterns: ['/operations.json'], scope: [{ refName: 'refs/heads/main', matchKind: 'Exact', repositoryId: ado.st.repoId }] } }];
  await conAplicar({ autoApply: true, masPoliticas: requeridaParaOps }, async ({ estado }) => {
    const p = (await estado()).proponer.operaciones;
    assert.strictEqual(p.porArchivo['operations.json'].aplicaSolo, false, JSON.stringify(p));
    assert.strictEqual(p.porArchivo['scripts/nightly/dashboard/sources.json'].aplicaSolo, true, JSON.stringify(p));
    assert.deepStrictEqual([p.habilitado, p.aplicaSolo], [true, false], 'el repo entero no se aplica solo si un archivo no');
  });
});

// ── la pestaña con la copia de operaciones ─────────────────────────────────────────────────────────
const COPIA = require(path.join(H.SITE, 'operations-copy.js'));
const { prepararClonDeEscritura } = require(path.join(H.SITE, 'sources.js'));
// stable-data: la hora real sólo fecha las fotos del almacén en memoria; ninguna prueba compara contra ella
/** La foto de `dir` (un clon con commit) abierta en una carpeta, como la deja `bajar`: `{ carpeta, indice }`. */
async function fotoDe(dir) {
  const blobs = new Map();
  const al = {
    async get(n) { const b = blobs.get(n); return b ? { status: 200, cuerpo: b } : { status: 404, cuerpo: Buffer.alloc(0) }; },
    async put(n, c) { blobs.set(n, Buffer.from(c)); return { status: 201 }; },
    async list(p) { return { status: 200, blobs: [...blobs.keys()].filter((k) => k.startsWith(p)).map((name) => ({ name, modificado: Date.now() })) }; },
    async del(n) { blobs.delete(n); return { status: 202 }; },
  };
  const s = await COPIA.subir({ repo: dir, almacen: al });
  assert.strictEqual(s.ok, true, s.motivo);
  const b = await COPIA.bajar({ almacen: al, dir: tmp('site-config-copia-') });
  assert.strictEqual(b.ok, true, b.motivo);
  return b;
}
const huellaDeCarpeta = (d) => { const out = []; const ir = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true }).sort((a, z) => a.name.localeCompare(z.name))) { const p = path.join(x, e.name); if (e.isDirectory()) ir(p); else out.push(`${path.relative(d, p)}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`); } }; ir(d); return out.join('\n'); };
const ENV_COPIA = { SITE_OPERATIONS_SOURCE: 'copy', SITE_OPERATIONS_COPY: 'acmeops/copia', SITE_OPERATIONS_TOKEN: '' };

test('T18 2.34-Config_VersionDelIndice @story-2.34 @ac-10 — con la copia, la versión de cada archivo sale del índice', async () => {
  // 🔴 rojo: la carpeta de la foto no tiene git, y cada sección queda «ilegible» sin versión.
  const ops = clon({ 'operations.json': opsBase(), 'scripts/ci/product-parity.json': { grupos: {}, rasgos: [], diferencias_declaradas: [] } });
  const { carpeta, indice } = await fotoDe(ops);
  assert.ok(!fs.existsSync(path.join(carpeta, '.git')));
  await conPestana({ fuentes: fuentesCon({ ops: carpeta, indice }), env: ENV_COPIA }, async ({ h, entrar }) => {
    const lead = await entrar(LEAD);
    const r = (await h.pedir('/api/config', { cookie: lead })).json;
    const resp = r.secciones.find((x) => x.id === 'responsables');
    assert.strictEqual(resp.estado, 'cargado', JSON.stringify(resp));
    assert.strictEqual(resp.oid, indice.archivos['operations.json']);
    assert.strictEqual(resp.oid, g(ops, 'rev-parse', 'HEAD:operations.json'), 'la misma versión que da git en el repo');
    const par = r.secciones.find((x) => x.archivo === 'scripts/ci/product-parity.json');
    if (par) assert.strictEqual(par.oid, indice.archivos['scripts/ci/product-parity.json']);
  });
});

test('T19 2.34-Proponer_ContraMainFresco @story-2.34 @ac-10 — «Proponer» compara contra main recién traído y arma ahí', { skip: SIN_BACKEND }, async () => {
  // 🔴 rojo: la propuesta compara contra la foto (de hasta 15 minutos atrás) y pisa un cambio mergeado en el medio.
  const { arrancarGithubFalso } = require('./lib/fake-github-api.js');
  const remotos = { operaciones: { platform: 'github', org: 'acme', repo: 'ops', web: 'https://github.example/acme/ops' } };
  let gh, r, dir;
  try {
    gh = await arrancarGithubFalso({ owner: 'acme', repo: 'ops' });
    gh.st.reglas = [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }];
    ({ r, dir } = await opsPorHttp({ 'operations.json': opsBase() }));
    const { carpeta, indice } = await fotoDe(dir);
    const antes = huellaDeCarpeta(carpeta);
    const dirEscritura = path.join(tmp('site-config-esc-'), 'operaciones-escritura');
    const escritura = () => prepararClonDeEscritura({ dir: dirEscritura, url: r.url });
    await conPestana({ fuentes: fuentesCon({ ops: carpeta, indice, escritura }), env: { ...ENV_COPIA, SITE_OPERATIONS_REPO: r.url, SITE_OPERATIONS_WRITE_TOKEN: ESCRITURA }, opciones: { remotos, urlBase: { github: gh.base } } }, async ({ h, entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      const abierta = (await h.pedir('/api/config', { cookie: lead })).json;
      assert.strictEqual(abierta.proponer.operaciones.habilitado, true, JSON.stringify(abierta.proponer));
      const s = abierta.secciones.find((x) => x.id === 'responsables');
      const rev = (await escribir('/api/config/revisar', lead, tok, { seccion: 'responsables', borrador: { owners: { default: 'otro@acme.example' } } })).json;
      // main cambió después de la copia: «recargá», ninguna rama
      r.cambiar({ 'operations.json': ORG.formatJson(opsBase({ owners: { default: 'alguien@acme.example' } })) });
      const p1 = (await escribir('/api/config/proponer', lead, tok, { seccion: 'responsables', texto: rev.texto, oid: s.oid })).json;
      assert.strictEqual(p1.ok, false);
      assert.match(p1.message, /el archivo cambió desde que lo abriste: recargá/);
      assert.deepStrictEqual(r.empujes, [], 'cero ramas');
      // con la versión actual de main, el pedido se arma sobre esa punta
      const oidMain = g(dirEscritura, 'rev-parse', 'FETCH_HEAD:operations.json');
      const p2 = (await escribir('/api/config/proponer', lead, tok, { seccion: 'responsables', texto: rev.texto, oid: oidMain })).json;
      assert.strictEqual(p2.ok, true, p2.message);
      assert.strictEqual(r.empujes.length, 1);
      const sha = r.empujes[0].despues;
      assert.strictEqual(g(dirEscritura, 'rev-parse', `${sha}^`), g(dirEscritura, 'rev-parse', 'FETCH_HEAD'), 'el commit va sobre la punta recién traída');
      assert.strictEqual(huellaDeCarpeta(carpeta), antes, 'la carpeta de la foto no cambió');
      assert.ok(!fs.existsSync(path.join(carpeta, '.git')), 'la escritura nunca toca la carpeta de la foto');
    });
  } finally { await cerrarTodos(r, gh); }
});

test('T20 2.34-Proponer_SinCredencialDescarga @story-2.34 @ac-10 @ac-16 — la copia sin credencial de escritura: valida y descarga', async () => {
  // 🔴 rojo: con la copia, «Proponer» queda prendido sin credencial, o «Revisar» deja de validar.
  const ops = clon({ 'operations.json': opsBase() });
  const { carpeta, indice } = await fotoDe(ops);
  await conPestana({ fuentes: fuentesCon({ ops: carpeta, indice }), env: ENV_COPIA }, async ({ h, entrar, token, escribir }) => {
    const lead = await entrar(LEAD); const tok = await token(lead);
    const r = (await h.pedir('/api/config', { cookie: lead })).json;
    assert.strictEqual(r.proponer.operaciones.habilitado, false);
    assert.match(r.proponer.operaciones.motivo, /sin identidad de escritura/);
    const rev = (await escribir('/api/config/revisar', lead, tok, { seccion: 'responsables', borrador: { owners: { default: 'otro@acme.example' } } })).json;
    assert.strictEqual(rev.texto, ORG.formatJson({ ...opsBase(), owners: { default: 'otro@acme.example' } }), 'el JSON validado, para descargar');
    const p = (await escribir('/api/config/proponer', lead, tok, { seccion: 'responsables', texto: rev.texto, oid: r.secciones.find((x) => x.id === 'responsables').oid })).json;
    assert.strictEqual(p.ok, false);
    assert.match(p.message, /sin identidad de escritura/);
  });
});

// ── las fichas que muestra el sitio ──────────────────────────────────────────────────────────────────────
test('T16 2.36-Clave_HiddenCardsValida @story-2.36 @ac-2 — site.hidden_cards: una lista de identificadores de la lista; lo demás, con su ruta', () => {
  const FICHAS = require(path.join(ROOT, 'scripts', 'site', 'tabs', 'cards.js')).FICHAS;
  const con = (hidden_cards) => OPS.parse(ORG.formatJson(opsBase({ site: { maintainers: [LEAD], hidden_cards } })));
  assert.strictEqual(con([FICHAS[0].id, FICHAS[3].id]).ok, true);
  assert.strictEqual(con([]).ok, true, 'una lista vacía vale: se muestran todas');
  assert.strictEqual(OPS.parse(ORG.formatJson(opsBase())).ok, true, 'sin la clave vale');
  const malas = con([FICHAS[0].id, 'no_existe', 7, FICHAS[0].id]);
  assert.strictEqual(malas.ok, false);
  assert.deepStrictEqual(malas.problems.map((p) => p.path), ['site.hidden_cards.1', 'site.hidden_cards.2', 'site.hidden_cards.3']);
  assert.match(malas.problems[0].message, /no es una ficha del sitio/);
  assert.match(malas.problems[2].message, /repetida/);
  const forma = con('backlog');
  assert.strictEqual(forma.ok, false);
  assert.deepStrictEqual(forma.problems.map((p) => [p.path, p.message]), [['site.hidden_cards', 'tiene que ser una lista de identificadores de ficha']]);
});

test('T17 2.36-Seccion_FichasQueMuestraElSitio @story-2.36 @ac-2 — la sección está en «Avisos y la noche» y propone un cambio que toca sólo site.hidden_cards', async () => {
  const s = ORG.seccionPorId('fichas');
  assert.ok(s, 'la sección existe');
  assert.deepStrictEqual([s.titulo, s.archivo, s.repo, s.lector, s.rutas, s.idCorto], ['Fichas que muestra el sitio', 'operations.json', 'operaciones', 'operations-config.js', ['site.hidden_cards'], 'operations']);
  const base = opsBase({ site: { maintainers: [LEAD], refresh_minutes: 15 } });
  const r = ORG.revisar({ seccion: 'fichas', texto: ORG.formatJson(base), borrador: { site: { maintainers: ['otro@acme.example'], refresh_minutes: 30, hidden_cards: ['backlog', 'pasos'] } }, lectores: { 'operations-config.js': OPS } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  assert.strictEqual(r.texto, ORG.formatJson({ ...base, site: { ...base.site, hidden_cards: ['backlog', 'pasos'] } }), 'sólo la hoja de las fichas');
  // sacar todas las ocultas saca la clave, sin dejar un objeto vacío
  const vuelta = ORG.revisar({ seccion: 'fichas', texto: r.texto, borrador: { site: { maintainers: [LEAD], refresh_minutes: 15 } }, lectores: { 'operations-config.js': OPS } });
  assert.strictEqual(vuelta.texto, ORG.formatJson(base));
  const codigo = pantallaEnCastellano();
  assert.match(codigo, /\['avisos', 'Avisos y la noche', \['canal', 'espera', 'umbrales', 'fichas', 'pedidos'\]/);
  assert.match(codigo, /fichas: editorFichas/);
  // en el sitio, la sección llega con las 25 fichas y su casilla
  const ops = clon({ 'operations.json': opsBase() });
  await conPestana({ fuentes: fuentesCon({ ops }) }, async ({ h, entrar }) => {
    const sec = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json.secciones.find((x) => x.id === 'fichas');
    assert.strictEqual(sec.estado, 'cargado');
    assert.strictEqual(sec.extras.fichas.length, require(path.join(ROOT, 'scripts', 'site', 'tabs', 'cards.js')).FICHAS.length);
    assert.deepStrictEqual(Object.keys(sec.extras.fichas[0]).sort(), ['id', 'paraQue', 'pestana', 'titulo']);
  });
});

test('T17b 2.36-Editor_CasillaPorFicha @story-2.36 @ac-2 — una casilla por ficha, tildada si se muestra; destildar la agrega a site.hidden_cards en el borrador', async () => {
  const REALES = require(path.join(ROOT, 'scripts', 'site', 'tabs', 'cards.js')).FICHAS;
  const fichas = ['backlog', 'mutacion', 'pasos'].map((id) => { const f = REALES.find((x) => x.id === id); assert.ok(f, `${id} está en la lista real`); return { id: f.id, titulo: f.titulo, paraQue: f.paraQue, pestana: f.pestana }; });
  const sec = { id: 'fichas', titulo: 'Fichas que muestra el sitio', repo: 'operaciones', estado: 'cargado', soloLectura: false, problems: [], avisos: [], extras: { fichas }, borrador: { site: { maintainers: [LEAD], hidden_cards: ['pasos', 'ficha_de_otra_version'] } } };
  const p = await pantallaFalsa([sec]);
  assert.strictEqual(p.error, null);
  const casillas = p.todo(p.sec('fichas')).filter((n) => n.tag === 'input' && n.attrs.type === 'checkbox');
  assert.deepStrictEqual(casillas.map((c) => c.attrs['data-path']), ['site.hidden_cards.mutacion', 'site.hidden_cards.backlog', 'site.hidden_cards.pasos'], 'agrupadas por pestaña: Arnés, Proyectos, Ejecuciones');
  assert.deepStrictEqual(casillas.map((c) => Boolean(c.checked)), [true, true, false], 'la oculta viene destildada');
  assert.match(p.textoDe('fichas'), /ficha_de_otra_version/, 'una oculta que esta versión no conoce se nombra y se conserva');
  // destildar una la agrega al borrador; volver a tildar la oculta la saca
  casillas[0].checked = false; casillas[0].on.change({ target: casillas[0] });
  casillas[2].checked = true; casillas[2].on.change({ target: casillas[2] });
  await p.click('Revisar cambios', 'fichas');
  const enviado = p.pedidos.filter((x) => x.cuerpo && x.cuerpo.borrador).pop();
  assert.ok(enviado, 'Revisar manda el borrador');
  assert.deepStrictEqual([...enviado.cuerpo.borrador.site.hidden_cards].sort(), ['ficha_de_otra_version', 'mutacion']);
});

test('2.36-HiddenCards_ListaDelLectorIgualAlSitio @story-2.36 @ac-2 — el lector viaja solo con su copia de los identificadores: es la misma lista que muestra el sitio, y un desconocido es un problema', () => {
  const FICHAS = require(path.join(ROOT, 'scripts', 'site', 'tabs', 'cards.js')).FICHAS;
  assert.deepStrictEqual([...OPS.CARD_IDS], FICHAS.map((f) => f.id), 'la copia del lector no es la lista de cards.js');
  const r = OPS.parse(ORG.formatJson(opsBase({ site: { maintainers: [LEAD], hidden_cards: ['no_existe'] } })));
  assert.deepStrictEqual(r.problems.map((p) => p.path), ['site.hidden_cards.0']);
});

// ── cómo se actualiza el sitio (`site.update`) ──────────────────────────────────────────────────────
test('T22 2.33-Clave_SiteUpdateValida @story-2.33 @ac-17 — "auto" y "notice" valen; otro valor, problema en site.update', () => {
  for (const v of ['auto', 'notice']) assert.strictEqual(OPS.parse(ORG.formatJson(opsBase({ site: { maintainers: [LEAD], update: v } }))).ok, true, `update: ${v}`);
  assert.strictEqual(OPS.parse(ORG.formatJson(opsBase())).ok, true, 'sin la clave vale (y el modo es «sólo aviso»)');
  for (const malo of ['si', true]) {
    const r = OPS.parse(ORG.formatJson(opsBase({ site: { maintainers: [LEAD], update: malo } })));
    assert.strictEqual(r.ok, false, JSON.stringify(malo));
    assert.deepStrictEqual(r.problems.map((p) => p.path), ['site.update']);
  }
  assert.ok(OPS.SITE_KEYS.includes('update'));
  const { modoDe } = require(path.join(ROOT, 'scripts', 'site', 'deploy', 'update-site.js'));
  const d = tmp('site-config-modo-');
  fs.writeFileSync(path.join(d, 'operations.json'), ORG.formatJson(opsBase()));
  assert.strictEqual(modoDe(path.join(d, 'operations.json')), 'notice', 'sin la clave, sólo aviso');
});

test('T23 2.33-Seccion_ProponeComoLasDemas @story-2.33 @ac-18 — «Cómo se actualiza el sitio» cambia sólo site.update', async () => {
  const s = ORG.seccionPorId('aldia');
  assert.ok(s, 'la sección existe');
  assert.deepStrictEqual([s.titulo, s.archivo, s.repo, s.lector, s.rutas, s.idCorto], ['Cómo se actualiza el sitio', 'operations.json', 'operaciones', 'operations-config.js', ['site.update'], 'operations']);
  const base = opsBase({ site: { maintainers: [LEAD], refresh_minutes: 15, auto_apply: false } });
  const r = ORG.revisar({ seccion: 'aldia', texto: ORG.formatJson(base), borrador: { site: { maintainers: ['otro@acme.example'], auto_apply: true, update: 'auto' } }, lectores: { 'operations-config.js': OPS } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  assert.strictEqual(r.texto, ORG.formatJson({ ...base, site: { ...base.site, update: 'auto' } }), 'sólo la hoja de la actualización');
  const codigo = pantallaEnCastellano();
  assert.match(codigo, /\['personas', 'Personas', \['organizacion', 'sitio', 'aplicar', 'aldia',/);
  assert.match(codigo, /aldia: editorActualizacionSitio/);
  for (const t of ['sin declarar (sólo aviso)', 'automático: el nocturno instala la versión nueva, la prueba y vuelve atrás si falla', 'sólo aviso: el sitio dice que hay una versión nueva y se instala a mano']) assert.ok(codigo.includes(t), t);
  // la pestaña muestra el valor que hay
  const ops = clon({ 'operations.json': opsBase({ site: { maintainers: [LEAD], update: 'auto' } }) });
  await conPestana({ fuentes: fuentesCon({ ops }) }, async ({ h, entrar }) => {
    const sec = (await h.pedir('/api/config', { cookie: await entrar(LEAD) })).json.secciones.find((x) => x.id === 'aldia');
    assert.ok(sec && sec.estado === 'cargado', JSON.stringify(sec));
    assert.strictEqual(sec.borrador.site.update, 'auto');
  });
});

test('T24 2.33-LectorSabe_RutaConPunto @story-2.33 @ac-18 — un lector sin `update` en SITE_KEYS no sabe leer la sección', () => {
  const s = ORG.seccionPorId('aldia');
  const sinUpdate = { ...OPS, SITE_KEYS: OPS.SITE_KEYS.filter((k) => k !== 'update') };
  assert.strictEqual(ORG.lectorSabe(sinUpdate, s), false, 'la clave de arriba (site) existe, pero la hoja no');
  assert.strictEqual(ORG.lectorSabe(OPS, s), true);
  // la del interruptor de los cambios sigue sabiendo, y una sección sin rutas no cambia
  assert.strictEqual(ORG.lectorSabe(OPS, ORG.seccionPorId('aplicar')), true);
  assert.strictEqual(ORG.lectorSabe(sinUpdate, ORG.seccionPorId('aplicar')), true);
});

// ── «Tu tecnología»: la clave `stack` de team-repos.json ──
const RUNNERS = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'test-runners.js'));
const TEC_EXTRAS = { fabrica: RUNNERS.factoryTable(), internos: ['dotnet', 'vitest', 'jest', 'node'] };
const GO_ORG = { name: 'go', detect: 'go.mod', command: 'go test ./...', results: { format: 'junit', path: '{results}/junit.xml' } };
const CARGO = { name: 'cargo', detect: 'Cargo.toml', command: 'cargo nextest run', results: { format: 'junit', path: '{results}/junit.xml' } };
async function pantallaTec(borrador, idioma = 'es', respuesta = {}) {
  const sec = SEC('tecnologia', { repo: 'perfil', borrador, extras: TEC_EXTRAS });
  const r = await pantallaConPestanas({ secciones: [...TODAS.map((id) => SEC(id)), sec], idioma, hash: '#seccion-tecnologia', extras: respuesta });
  const caja = () => r.creados.filter((n) => n.attrs.id === 'seccion-tecnologia').pop();
  const todos = () => { const out = []; const walk = (x) => { out.push(x); (x.hijos || []).forEach(walk); }; walk(caja()); return out; };
  const texto = () => todos().map((n) => n.textContent || '').join(' | ');
  const boton = (re) => todos().filter((n) => n.tag === 'button' && re.test(n.textContent)).pop();
  const esperar = async () => { for (let i = 0; i < 10; i++) await new Promise((x) => setImmediate(x)); };
  const revisado = async () => {
    boton(/^(Revisar cambios|Review changes)$/).on.click(); await esperar();
    return r.llamadas.filter((l) => /revisar/.test(l.ruta)).pop().cuerpo.borrador;
  };
  return { r, caja, todos, texto, boton, esperar, revisado };
}

test('T27 TeamRepos_StackKey_SinceVersion @story-8.48 @ac-27 @ac-33 — `stack` no se propone a una organización con un arnés anterior', async () => {
  // 🔴 rojo: la sección no existe, se propone a un perfil que pide un arnés que no lee `stack.rules`, o cambia otra cosa del archivo.
  const s = ORG.seccionPorId('tecnologia');
  assert.ok(s, 'hay una sección «Tu tecnología»');
  assert.deepStrictEqual([s.archivo, s.repo, s.lector, s.claves, s.idCorto], ['team-repos.json', 'perfil', 'team-repos.js', ['stack'], 'repos']);
  assert.ok(ORG.versionAtLeast(ORG.STACK_SINCE, ORG.COVERAGE_SINCE) && ORG.STACK_SINCE !== ORG.COVERAGE_SINCE, 'la versión de `stack` es posterior a la de cobertura');
  const borrador = { stack: { code_extensions: ['.ex'], rules: { test_names: 'snake' } } };
  for (const [v, espera] of [[ORG.COVERAGE_SINCE, new RegExp(`todavía no se puede proponer.*stack.*${ORG.STACK_SINCE.replace(/\./g, '\\.')}`)], [ORG.STACK_SINCE, PASO_EL_PORTON]]) {
    await conPerfil({ layer: capa(v) }, async ({ seccion, revisar, proponer }) => {
      const sec = await seccion('tecnologia');
      assert.strictEqual(sec.estado, 'cargado');
      assert.ok(sec.extras && sec.extras.fabrica.some((f) => f.name === 'pytest'), 'la sección trae la lista de fábrica');
      const r = await revisar('tecnologia', borrador);
      assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
      assert.deepStrictEqual(JSON.parse(r.texto), { ...TR_BASE, ...borrador }, 'el resto del archivo igual');
      assert.match((await proponer('tecnologia', r.texto)).message, espera);
    });
  }
});

test('T28 SiteConfig_StackSection_ShowsCurrentAndDefault @story-8.48 @ac-25 — lo de fábrica y lo de la organización, en castellano y en inglés', async () => {
  // 🔴 rojo: la sección no muestra los lenguajes que ya conoce, las herramientas con su origen o las reglas; o falta un idioma.
  const con = await pantallaTec({ stack: { code_extensions: ['.ex'], test_runners: [GO_ORG, CARGO], rules: { test_names: 'pascal' } } });
  const t = con.texto();
  for (const re of [/Python/, /Svelte/, /pytest/, /de fábrica/, /cambiada por tu organización/, /agregada por tu organización/, /incluida en el arnés · no se edita/, /Vitest/]) assert.match(t, re);
  assert.ok(con.todos().some((n) => n.tag === 'input' && n.attrs.value === '.ex'), 'la terminación de la organización');
  const regla = con.todos().find((n) => n.tag === 'select' && n.attrs['data-path'] === 'stack.rules.test_names');
  assert.strictEqual(regla.value, 'pascal');
  assert.ok(con.todos().some((n) => n.tag === 'select' && n.attrs['data-path'] === 'stack.rules.screen_test'));
  assert.ok(con.todos().some((n) => n.attrs['data-path'] === 'stack.rules.ui_language'));
  // las de la puerta no se cambian desde acá: «Reemplazar» dice cómo (el detalle, en T30b)
  assert.match(t, /Reemplazar/);
  const sin = await pantallaTec({});
  assert.match(sin.texto(), /no tenés que configurar nada/);
  const en = await pantallaTec({ stack: { test_runners: [CARGO] } }, 'en');
  const te = en.texto();
  for (const re of [/built in/i, /added by your organization/i, /Ask your agent/]) assert.match(te, re);
  assert.doesNotMatch(te, /pantalla\./, 'ninguna clave sin traducir');
});

test('T29 SiteConfig_StackSection_ValidatesAndProposes @story-8.48 @ac-26 — el lector de las máquinas decide, y lo malo no se propone', async () => {
  // 🔴 rojo: un valor inválido llega al pedido, o el problema no dice cuál ni cómo corregirlo.
  const malo = ORG.revisar({ seccion: 'tecnologia', texto: ORG.formatJson(TR_BASE), borrador: { stack: { code_extensions: ['EX'] } }, lectores: { 'team-repos.js': TR } });
  assert.strictEqual(malo.ok, false);
  assert.deepStrictEqual(malo.problems.map((p) => p.path), ['stack.code_extensions.0']);
  assert.match(malo.problems[0].message, /con punto y en minúsculas.*"\.ex"/);
  const bien = ORG.revisar({ seccion: 'tecnologia', texto: ORG.formatJson(TR_BASE), borrador: { stack: { code_extensions: ['.ex'] } }, lectores: { 'team-repos.js': TR } });
  assert.strictEqual(bien.ok, true, JSON.stringify(bien.problems));
  // en la pantalla: la terminación nueva llega al lector tal cual, y vaciar todo saca la clave
  const p = await pantallaTec({});
  p.boton(/Agregar terminación/).on.click(); await p.esperar();
  p.todos().filter((n) => n.tag === 'input' && n.attrs['data-path'] === 'stack.code_extensions.0').pop().on.input({ target: { value: 'EX' } });
  assert.deepStrictEqual((await p.revisado()).stack, { code_extensions: ['EX'] });
  p.todos().filter((n) => n.tag === 'select' && n.attrs['data-path'] === 'stack.rules.test_names').pop().on.change({ target: { value: 'snake' } });
  assert.deepStrictEqual((await p.revisado()).stack.rules, { test_names: 'snake' });
  p.todos().filter((n) => n.tag === 'select' && n.attrs['data-path'] === 'stack.rules.test_names').pop().on.change({ target: { value: '' } });
  assert.strictEqual((await p.revisado()).stack.rules, undefined, 'sin regla, sin la clave');
  // lo que el lector rechaza se ve en la pantalla, junto al campo, en llano
  const conProblema = await pantallaTec({ stack: { code_extensions: ['EX'] } }, 'es', { problems: malo.problems });
  await conProblema.revisado();
  const err = conProblema.todos().filter((n) => n.attrs.class === 'err').map((n) => n.textContent).join(' | ');
  assert.match(err, /con punto y en minúsculas.*"\.ex"/, 'la pantalla dice cuál y cómo corregirlo');
});

test('T30 SiteConfig_FactoryRunner_ChangeAndRevert @story-8.48 @ac-28 — «Cambiar» trae la de fábrica, guardar la copia, volver la borra', async () => {
  // 🔴 rojo: el formulario llega vacío, la copia sale con otro nombre, «Volver» no la borra o falta el aviso del comando.
  const p = await pantallaTec({});
  const fila = p.todos().find((n) => n.attrs['data-runner'] === 'go');
  assert.ok(fila, 'go está en la tabla');
  const cambiar = (() => { const out = []; const walk = (x) => { out.push(x); (x.hijos || []).forEach(walk); }; walk(fila); return out.find((n) => n.tag === 'button' && /^Cambiar$/.test(n.textContent)); })();
  cambiar.on.click(); await p.esperar();
  const valor = (k) => (p.todos().filter((n) => n.attrs['data-path'] === `runner.${k}`).pop() || { attrs: {} });
  assert.match(valor('command').attrs.value, /^gotestsum /, 'el comando de fábrica');
  assert.strictEqual(valor('detect').attrs.value, 'go.mod');
  assert.match(p.texto(), /va a correr este comando en su computadora/);
  valor('command').on.input({ target: { value: 'go test -json ./... | go-junit-report > {results}/junit.xml' } });
  p.boton(/^Guardar$/).on.click(); await p.esperar();
  const guardado = (await p.revisado()).stack.test_runners;
  assert.strictEqual(guardado.length, 1);
  assert.strictEqual(guardado[0].name, 'go', 'misma nombre: reemplaza a la de fábrica');
  assert.match(guardado[0].command, /go-junit-report/);
  assert.match(p.texto(), /cambiada por tu organización/);
  p.boton(/Volver a la de fábrica/).on.click(); await p.esperar();
  assert.strictEqual((await p.revisado()).stack, undefined, 'sin la copia, `stack` vacío no se propone');
  // las cuatro que corre la puerta por dentro no tienen «Cambiar»: sólo «Reemplazar», que explica cómo
  const dotnet = p.todos().find((n) => n.attrs['data-runner'] === 'dotnet');
  const deDotnet = (() => { const out = []; const walk = (x) => { out.push(x); (x.hijos || []).forEach(walk); }; walk(dotnet); return out; })();
  assert.deepStrictEqual(deDotnet.filter((n) => n.tag === 'button').map((n) => n.textContent), ['Reemplazar'], '.NET sólo con «Reemplazar»');
});

test('T30b SiteConfig_RunnerTable_SameColumnsAndClearOrigin — todas las filas con las mismas columnas y el origen en palabras claras', async () => {
  // 🔴 rojo: las internas con una columna menos (la tabla queda corrida), las internas y las recetas con el mismo
  //    «de fábrica», o sin «Reemplazar» en las internas.
  const p = await pantallaTec({ stack: { test_runners: [CARGO] } });
  const fila = (n) => p.todos().find((x) => x.attrs['data-runner'] === n);
  const celdas = (n) => (fila(n).hijos || []).filter((x) => x.tag === 'span');
  for (const n of ['dotnet', 'vitest', 'go', 'cargo']) assert.strictEqual(celdas(n).length, 4, `${n}: nombre, archivo, origen y acción`);
  const origen = (n) => celdas(n)[2].textContent;
  assert.strictEqual(origen('dotnet'), 'incluida en el arnés · no se edita');
  assert.strictEqual(origen('go'), 'de fábrica · se puede cambiar');
  assert.strictEqual(origen('cargo'), 'agregada por tu organización');
  // «Reemplazar» deja, en la fila, la frase para el agente (el detalle, en T30d)
  const reemplazar = (() => { const out = []; (function walk(x) { out.push(x); (x.hijos || []).forEach(walk); })(fila('dotnet')); return out.find((x) => x.tag === 'button'); })();
  assert.strictEqual(reemplazar.textContent, 'Reemplazar');
  assert.doesNotMatch(p.texto(), /quiero reemplazar la herramienta de pruebas/, 'plegado hasta que se toca');
  reemplazar.on.click(); await p.esperar();
  assert.match(p.texto(), /quiero reemplazar la herramienta de pruebas \.NET de mi proyecto/);
  // una de fábrica cambiada lo dice
  const cambiada = await pantallaTec({ stack: { test_runners: [{ name: 'go', detect: 'go.mod', command: 'go test ./...', results: { format: 'junit', path: '{results}/j.xml' } }] } });
  const celdasGo = (cambiada.todos().find((x) => x.attrs['data-runner'] === 'go').hijos || []).filter((x) => x.tag === 'span');
  assert.strictEqual(celdasGo[2].textContent, 'cambiada por tu organización');
  // y en inglés
  const en = await pantallaTec({}, 'en');
  const celdasEn = (n) => (en.todos().find((x) => x.attrs['data-runner'] === n).hijos || []).filter((x) => x.tag === 'span');
  assert.strictEqual(celdasEn('dotnet')[2].textContent, 'included in the harness · not editable');
  assert.strictEqual(celdasEn('go')[2].textContent, 'built in · can be changed');
});

test('T30c SiteConfig_OrgRunner_LabelAndRepoFiltersSurviveChange — el nombre para personas, el filtro de cada repo a la vista y conservado al guardar', async () => {
  // 🔴 rojo: la fila o el formulario muestran el id en vez del nombre; el formulario no muestra el filtro de un repo; o
  //    «Guardar» pierde `repos`/`args_default` (la máquina volvería a correr sin el filtro).
  const NETFX = {
    name: 'netfx-vstest', label: '.NET Framework (vstest)', detect: 'packages.config', detect_depth: 1, command: 'bash -c x', results: { format: 'trx', path: '{results}/**/*.trx' },
    args_default: 'TestCategory!=Slow',
    repos: [{ repo: { platform: 'azure', org: 'acme', project: 'Prod', repo: 'api' }, args: 'TestCategory=Unit' }],
  };
  const p = await pantallaTec({ stack: { test_runners: [NETFX] } });
  const fila = p.todos().find((x) => x.attrs['data-runner'] === 'netfx-vstest');
  assert.strictEqual((fila.hijos || []).filter((x) => x.tag === 'span')[0].textContent, '.NET Framework (vstest)', 'la fila con el nombre para personas');
  const cambiar = (() => { const out = []; (function walk(x) { out.push(x); (x.hijos || []).forEach(walk); })(fila); return out.find((x) => x.tag === 'button' && x.textContent === 'Cambiar'); })();
  cambiar.on.click(); await p.esperar();
  assert.match(p.texto(), /Cambiar la herramienta \.NET Framework \(vstest\)/);
  const campoDe = (k) => p.todos().filter((n) => n.attrs['data-path'] === `runner.${k}`).pop();
  assert.ok(campoDe('repos.0.args'), 'el filtro del repo, a la vista');
  assert.strictEqual(campoDe('repos.0.args').attrs.value, 'TestCategory=Unit');
  assert.match(p.texto(), /azure · acme\/Prod\/api/, 'el repo de ese filtro, con su nombre');
  assert.strictEqual(campoDe('args_default').attrs.value, 'TestCategory!=Slow');
  // la cobertura dice que es un formato
  assert.ok(p.todos().some((n) => n.tag === 'option' && n.textContent === 'Cobertura (formato XML)'), 'la opción «Cobertura» aclara que es un formato');
  // guardar sin tocar el filtro lo conserva entero; editarlo cambia sólo el args
  p.boton(/^Guardar$/).on.click(); await p.esperar();
  assert.deepStrictEqual((await p.revisado()).stack.test_runners[0], NETFX, 'guardar sin cambios no pierde nada');
  cambiar.on.click(); await p.esperar();
  campoDe('repos.0.args').on.input({ target: { value: '(TestCategory=Unit|TestCategory=Component)&TestCategory!=PendingSeed' } });
  p.boton(/^Guardar$/).on.click(); await p.esperar();
  const guardada = (await p.revisado()).stack.test_runners[0];
  assert.deepStrictEqual(guardada.repos, [{ repo: NETFX.repos[0].repo, args: '(TestCategory=Unit|TestCategory=Component)&TestCategory!=PendingSeed' }]);
  assert.strictEqual(guardada.args_default, 'TestCategory!=Slow');
  assert.strictEqual(guardada.label, '.NET Framework (vstest)');
});

test('T30a SiteConfig_AskYourAgent_CopiesPhrase @story-8.48 @ac-36 — «Pedíselo a tu agente» deja la frase y la guía dice qué hace el agente', async () => {
  // 🔴 rojo: el botón no deja la frase a mano, o la guía no tiene la sección que el agente sigue.
  const p = await pantallaTec({});
  // el portapapeles del navegador, de prueba: la frase tiene que llegar ahí
  const antes = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let copiado = null;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: (t) => { copiado = t; return Promise.resolve(); } } }, configurable: true, writable: true });
  try {
    p.boton(/Pedíselo a tu agente/).on.click(); await p.esperar();
  } finally {
    if (antes) Object.defineProperty(globalThis, 'navigator', antes); else delete globalThis.navigator;
  }
  // la frase lleva al agente a la receta: nombra la sección de la guía
  assert.strictEqual(copiado, 'configurá las pruebas de mi proyecto en la configuración del arnés (la receta está en la sección «Tu tecnología» de guides/organization-site.md del arnés)');
  assert.match(p.texto(), /configurá las pruebas de mi proyecto en la configuración del arnés \(la receta está en la sección «Tu tecnología»/);
  assert.match(p.texto(), /después la herramienta aparece en esta lista/i);
  const guia = fs.readFileSync(path.join(ROOT, 'guides', 'organization-site.md'), 'utf8');
  const sec = guia.split(/\n### Tu tecnología\n/)[1];
  assert.ok(sec, 'la guía tiene §Tu tecnología');
  assert.match(sec, /team-repos\.js/);
  assert.match(sec, /archivo que la detecta|detect/);
  assert.match(fs.readFileSync(path.join(ROOT, 'guides', 'organization-site.en.md'), 'utf8'), /\n### Your technology\n/);
});

test('T30d SiteConfig_ReplaceBuiltIn_CopiesPhraseForThatTool — «Reemplazar» de una incluida deja la frase armada para esa herramienta y qué pasa después', async () => {
  // 🔴 rojo: «Reemplazar» sólo despliega una explicación, o la frase no nombra la herramienta y su archivo.
  const antes = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const copiado = [];
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: (t) => { copiado.push(t); return Promise.resolve(); } } }, configurable: true, writable: true });
  try {
    for (const [idioma, frase, despues] of [
      ['es', 'quiero reemplazar la herramienta de pruebas Node (node --test) de mi proyecto por una receta propia en la configuración del arnés, detectada por package.json (la receta está en la sección «Tu tecnología» de guides/organization-site.md del arnés)',
        'El agente arma el pedido, lo aprueba un admin y desde la próxima ejecución se usa la tuya.'],
      ['en', 'I want to replace the Node (node --test) test tool in my project with our own recipe in the harness configuration, detected by package.json (the recipe is in the «Your technology» section of the harness guides/organization-site.en.md)',
        'The agent builds the request, an admin approves it, and from the next execution on yours is used.'],
    ]) {
      const p = await pantallaTec({}, idioma);
      const fila = p.todos().find((n) => n.attrs['data-runner'] === 'node');
      const deFila = []; (function walk(x) { deFila.push(x); (x.hijos || []).forEach(walk); })(fila);
      deFila.find((n) => n.tag === 'button').on.click(); await p.esperar();
      assert.strictEqual(copiado.pop(), frase, `${idioma}: la frase copiada nombra la herramienta y su archivo`);
      const msg = p.todos().find((n) => n.attrs['data-reemplazar'] === 'node');
      assert.ok(msg, `${idioma}: la frase queda a la vista debajo de la fila`);
      assert.ok(p.texto().includes('«' + frase + '»'), `${idioma}: la frase, entera`);
      assert.ok(p.texto().includes(despues), `${idioma}: qué pasa después`);
    }
  } finally {
    if (antes) Object.defineProperty(globalThis, 'navigator', antes); else delete globalThis.navigator;
  }
  // .NET: dos archivos que la detectan, sin el agregado entre paréntesis
  const q = await pantallaTec({});
  const filaNet = q.todos().find((n) => n.attrs['data-runner'] === 'dotnet');
  const deNet = []; (function walk(x) { deNet.push(x); (x.hijos || []).forEach(walk); })(filaNet);
  deNet.find((n) => n.tag === 'button').on.click(); await q.esperar();
  assert.match(q.texto(), /herramienta de pruebas \.NET de mi proyecto .* detectada por \.sln, \.csproj \(la receta/);
  // sin portapapeles, la frase igual queda a la vista; un segundo clic no la pliega
  const sinPortapapeles = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  delete globalThis.navigator;
  try {
    const z = await pantallaTec({});
    const filaJest = z.todos().find((n) => n.attrs['data-runner'] === 'jest');
    const deJest = []; (function walk(x) { deJest.push(x); (x.hijos || []).forEach(walk); })(filaJest);
    const b = deJest.find((n) => n.tag === 'button');
    b.on.click(); await z.esperar();
    assert.match(z.texto(), /herramienta de pruebas Jest de mi proyecto/, 'sin portapapeles, la frase a la vista');
    const filaJest2 = z.todos().find((n) => n.attrs['data-runner'] === 'jest');
    const deJest2 = []; (function walk(x) { deJest2.push(x); (x.hijos || []).forEach(walk); })(filaJest2);
    deJest2.find((n) => n.tag === 'button').on.click(); await z.esperar();
    assert.match(z.texto(), /herramienta de pruebas Jest de mi proyecto/, 'el segundo clic la deja a la vista');
  } finally { if (sinPortapapeles) Object.defineProperty(globalThis, 'navigator', sinPortapapeles); }
});

test('E1 SiteConfig_TuTecnologia_RendersInPage @story-8.48 @ac-25 @ac-28 @ac-36 — la sección en su pestaña, al lado de Cobertura, de punta a punta', async () => {
  // 🔴 rojo: la sección no está en «Cómo trabaja el agente» o el recorrido se corta.
  const r = await pantallaConPestanas({ secciones: [...TODAS, 'cobertura', 'tecnologia'].map((id) => SEC(id, id === 'tecnologia' ? { repo: 'perfil', extras: TEC_EXTRAS } : {})) });
  const panel = r.panelDe('seccion-tecnologia');
  assert.strictEqual((panel || { attrs: {} }).attrs.id, 'pestana-claude');
  const orden = []; const walk = (x) => { if (/^seccion-/.test(x.attrs.id || '')) orden.push(x.attrs.id); (x.hijos || []).forEach(walk); }; walk(panel);
  assert.deepStrictEqual(orden.slice(orden.indexOf('seccion-cobertura'), orden.indexOf('seccion-cobertura') + 2), ['seccion-cobertura', 'seccion-tecnologia']);
  const p = await pantallaTec({ stack: { test_runners: [CARGO] } });
  const carga = p.todos().find((n) => n.attrs['data-runner'] === 'cargo');
  assert.ok(carga, 'la agregada por la organización se ve');
  assert.ok(p.boton(/^Borrar esta herramienta$/), 'y se puede borrar');
  // el recorrido: cambiar una de fábrica (llega llena, con el aviso del comando), guardarla, y volver a la de fábrica
  const goFila = p.todos().find((n) => n.attrs['data-runner'] === 'go');
  const deGo = []; (function walk(x) { deGo.push(x); (x.hijos || []).forEach(walk); })(goFila);
  deGo.find((n) => n.tag === 'button' && n.textContent === 'Cambiar').on.click(); await p.esperar();
  assert.match(p.texto(), /va a correr este comando en su computadora/);
  assert.ok(p.todos().some((n) => n.attrs['data-path'] === 'runner.command' && /^gotestsum /.test(n.attrs.value)), 'el formulario llega lleno');
  p.boton(/^Guardar$/).on.click(); await p.esperar();
  assert.deepStrictEqual((await p.revisado()).stack.test_runners.map((x) => x.name), ['cargo', 'go']);
  p.boton(/Volver a la de fábrica/).on.click(); await p.esperar();
  assert.deepStrictEqual((await p.revisado()).stack.test_runners.map((x) => x.name), ['cargo'], 'volver deja la agregada');
  p.boton(/Pedíselo a tu agente/).on.click(); await p.esperar();
  assert.match(p.texto(), /configurá las pruebas de mi proyecto/);
  // revisado y bien escrito: la pantalla dice que no se aplica solo, que se abre un pedido que alguien aprueba
  const q = await pantallaTec({ stack: { code_extensions: ['.ex'] } }, 'es', { texto: '{}\n', proponer: { perfil: { habilitado: true } } });
  await q.revisado();
  assert.match(q.texto(), /Se abre un pedido de cambio en .*Entra cuando alguien lo aprueba/);
});

// ── Personas: un renglón por persona ─────────────────────────────────────────────────────────────────────────────────
const SEIS = [
  { role: 'maintainer', emails: ['ana@acme.example', 'ana@casa.example'] },
  { role: 'maintainer', emails: ['bruno@acme.example'] },
  { role: 'dev', emails: ['carla@acme.example', 'carla@lab.example', 'c@viejo.example'] },
  { role: 'dev', emails: ['dario@acme.example'] },
  { role: 'dev', emails: ['elena@acme.example', 'elena@casa.example'] },
  { role: 'dev', emails: ['fede@acme.example'] },
];
const seccionSitio = (access, { problems = [], soloLectura = false } = {}) => ({ id: 'sitio', titulo: 'sitio', repo: 'operaciones', archivo: 'operations.json', estado: 'cargado', soloLectura, motivo: soloLectura ? 'sólo lectura' : null,
  borrador: { site: { access: clon2(access), refresh_minutes: 20 } }, problems, avisos: [], extras: { conAcceso: true } });
function clon2(v) { return JSON.parse(JSON.stringify(v)); }
/** La sección Personas sobre la pantalla falsa: sus renglones y lo que viaja al revisar. */
async function personas(access, opciones) {
  const p = await pantallaFalsa([seccionSitio(access, opciones)], { '/api/config/revisar': () => ({ ok: true, texto: '', diferencias: [] }) });
  assert.strictEqual(p.error, null);
  const de = (n, clase) => p.todo(n).filter((x) => String(x.attrs.class || '').split(' ').includes(clase));
  const renglones = () => de(p.sec('sitio'), 'persona');
  const revisado = async () => { await p.click('Revisar cambios', 'sitio'); return p.pedidos.filter((x) => x.ruta === '/api/config/revisar').pop().cuerpo.borrador.site.access; };
  return { ...p, de, renglones, revisado };
}

test('T1 Personas_UnRenglonPorPersona @story-2.56 @ac-1', async () => {
  const p = await personas(SEIS);
  const r = p.renglones();
  assert.strictEqual(r.length, 6, 'un renglón por persona');
  r.forEach((fila, i) => {
    const sel = p.todo(fila).filter((n) => n.tag === 'select');
    assert.strictEqual(sel.length, 1, `renglón ${i}: un selector de rol`);
    assert.deepStrictEqual(sel[0].hijos.map((o) => o.attrs.value), ['maintainer', 'dev']);
    assert.strictEqual(sel[0].value, SEIS[i].role);
    const etiquetas = p.de(fila, 'correo');
    assert.deepStrictEqual(etiquetas.map((e) => p.todo(e).map((n) => n.textContent).join('')).map((t) => t.replace('✕', '')), SEIS[i].emails, `renglón ${i}: una etiqueta por correo`);
    etiquetas.forEach((e) => assert.strictEqual(p.de(e, 'chip-x').length, 1, 'cada etiqueta con su ×'));
    assert.strictEqual(p.de(fila, 'sumar').length, 1, 'un +');
    assert.strictEqual(p.de(fila, 'quitar-persona').length, 1, 'la × de la persona');
    assert.strictEqual(p.todo(fila).filter((n) => n.tag === 'input').length, 0, 'un correo escrito no es un campo');
  });
  assert.ok(p.todo(p.sec('sitio')).some((n) => n.tag === 'button' && n.textContent === '+ Agregar persona'));
});

test('T2 Personas_SumarYSacar @story-2.56 @ac-2', async () => {
  // el +: un campo para escribir; lo escrito se guarda al tipear y viaja al revisar
  let p = await personas(SEIS);
  p.de(p.renglones()[1], 'sumar')[0].on.click({});
  await new Promise((r) => setImmediate(r));
  const campo = p.todo(p.renglones()[1]).find((n) => n.tag === 'input');
  assert.ok(campo, 'el + abre un campo');
  campo.on.input({ target: { value: 'bruno@casa.example' } });
  let esperado = clon2(SEIS); esperado[1].emails.push('bruno@casa.example');
  assert.deepStrictEqual(await p.revisado(), esperado, 'sumar un correo');
  // la × de una etiqueta saca sólo ese correo
  p = await personas(SEIS);
  p.de(p.de(p.renglones()[2], 'correo')[1], 'chip-x')[0].on.click({});
  esperado = clon2(SEIS); esperado[2].emails.splice(1, 1);
  assert.deepStrictEqual(await p.revisado(), esperado, 'sacar un correo');
  // la × de la persona la saca entera
  p = await personas(SEIS);
  p.de(p.renglones()[3], 'quitar-persona')[0].on.click({});
  esperado = clon2(SEIS); esperado.splice(3, 1);
  assert.deepStrictEqual(await p.revisado(), esperado, 'sacar a la persona');
  // el rol cambia sólo esa entrada
  p = await personas(SEIS);
  p.todo(p.renglones()[5]).find((n) => n.tag === 'select').on.change({ target: { value: 'maintainer' } });
  esperado = clon2(SEIS); esperado[5].role = 'maintainer';
  assert.deepStrictEqual(await p.revisado(), esperado, 'cambiar el rol');
});

test('T3 Personas_LaNuevaEsDev @story-2.56 @ac-3', async () => {
  const p = await personas(SEIS);
  await p.click('+ Agregar persona', 'sitio');
  const r = p.renglones();
  assert.strictEqual(r.length, 7);
  assert.strictEqual(p.todo(r[6]).find((n) => n.tag === 'select').value, 'dev', 'nace Dev, el de menor permiso');
  const campos = p.todo(r[6]).filter((n) => n.tag === 'input');
  assert.strictEqual(campos.length, 1, 'con el campo del correo listo');
  assert.strictEqual(campos[0].attrs.value, '');
  assert.deepStrictEqual((await p.revisado())[6], { role: 'dev', emails: [''] });
});

test('T4 Personas_SinTocarNadaNoCambia @story-2.56 @ac-4', async () => {
  const p = await personas(SEIS);
  const va = await p.revisado();
  assert.deepStrictEqual(va, SEIS);
  assert.strictEqual(JSON.stringify(va), JSON.stringify(SEIS), 'mismo orden y mismas claves');
});

test('T5 Personas_TodoProblemaEnSuRenglon @story-2.56 @ac-5', async () => {
  const access = clon2(SEIS); access[4].emails[1] = 'elena-casa.example';
  const problems = [
    { path: 'site.access.4.emails.1', message: 'no es un correo' },
    { path: 'site.access.3.emails', message: 'hace falta al menos un correo' },
    { path: 'site.access.2.role', message: 'el rol es maintainer o dev' },
    { path: 'site.access.1.color', message: 'clave desconocida color' },
  ];
  const p = await personas(access, { problems });
  const r = p.renglones();
  const texto = (fila) => p.todo(fila).map((n) => n.textContent).join(' | ');
  const mala = p.de(r[4], 'correo')[1];
  assert.ok(String(mala.attrs.class).split(' ').includes('bad'), 'el correo mal escrito, en rojo');
  assert.match(texto(r[4]), /elena-casa\.example: no es un correo/);
  // el mensaje que ya nombra el correo (el del servidor: «x» no es un correo) no lo repite
  const yaLoDice = await personas(access, { problems: [{ path: 'site.access.4.emails.1', message: '«elena-casa.example» no es un correo' }] });
  const err = yaLoDice.de(yaLoDice.renglones()[4], 'err').map((n) => n.textContent);
  assert.deepStrictEqual(err, ['«elena-casa.example» no es un correo'], 'sin el correo dos veces');
  assert.match(texto(r[3]), /hace falta al menos un correo/);
  assert.match(texto(r[2]), /el rol es maintainer o dev/);
  assert.match(texto(r[1]), /clave desconocida color/, 'también una clave desconocida de la entrada');
  assert.doesNotMatch(texto(r[0]), /no es un correo|clave desconocida/);
  // un correo recién sumado (vacío, todavía un campo) con su problema: el campo en rojo y el mensaje en el renglón
  const conVacio = clon2(SEIS); conVacio[0].emails.push('');
  const v = await personas(conVacio, { problems: [{ path: 'site.access.0.emails.2', message: 'el correo está vacío' }] });
  const campoVacio = v.todo(v.renglones()[0]).find((n) => n.tag === 'input');
  assert.ok(String(campoVacio.attrs.class).split(' ').includes('bad'), 'el campo vacío con problema, en rojo');
  assert.match(v.todo(v.renglones()[0]).map((n) => n.textContent).join(' | '), /correo: el correo está vacío/);
  // una entrada que no es una persona, o con correos que no son una lista: la sección se dibuja igual y lo dice en su
  // renglón (sin eso, la pantalla se caería y la sección quedaría vacía sin aviso)
  for (const rara of ['pepe', null, { role: 'dev', emails: 'suelto@acme.example' }]) {
    const q = await personas([SEIS[0], rara, SEIS[1]]);
    const filas = q.renglones();
    assert.strictEqual(filas.length, 3, `${JSON.stringify(rara)}: los tres renglones`);
    assert.match(q.todo(filas[1]).map((n) => n.textContent).join(' | '), /renglón de la lista está mal armado|correos de esta persona están mal escritos en el archivo/, JSON.stringify(rara));
    assert.strictEqual(q.de(filas[1], 'quitar-persona').length, 1, 'se puede quitar');
    assert.deepStrictEqual(await q.revisado(), [SEIS[0], rara, SEIS[1]], 'dibujarla no la cambia');
  }
});

test('T6 Personas_TextosEnLosDosIdiomas @story-2.56 @ac-7', () => {
  const { t } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  for (const k of ['pantalla.correos', 'pantalla.quitarCorreo', 'pantalla.agregarCorreoUno', 'pantalla.quitarPersona']) {
    assert.notStrictEqual(t('es', k), k, `${k} en castellano`);
    assert.notStrictEqual(t('en', k), k, `${k} en inglés`);
    assert.notStrictEqual(t('en', k), t('es', k), `${k} distinto en cada idioma`);
    assert.ok(ORG.pantalla().includes(`'${k}'`), `${k} lo usa la pantalla`);
  }
});

test('T7 Personas_HojaConTemaYTelefono @story-2.56 @ac-6 @ac-7', () => {
  const css = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'static', 'site.css'), 'utf8');
  const reglas = css.match(/[^{}]*\.(personas|persona|correo|chip-x|sumar|quitar-persona)\b[^{}]*\{[^{}]*\}/g) || [];
  assert.ok(reglas.length >= 5, `las reglas de la tabla (${reglas.length})`);
  for (const r of reglas) assert.doesNotMatch(r.slice(r.indexOf('{')), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, `sin colores fijos: ${r.trim().slice(0, 80)}`);
  const tel = /@media \(max-width:640px\)\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(tel && /\.personas/.test(tel[1]), 'el teléfono baja el renglón a dos líneas');
});

test('T10 Personas_SoloLecturaYLaT6 @story-2.56 @ac-9', async () => {
  const p = await personas(SEIS, { soloLectura: true });
  const tabla = p.de(p.sec('sitio'), 'personas')[0];
  assert.ok(tabla, 'la tabla dibujada');
  const agregar = p.todo(p.sec('sitio')).find((n) => n.tag === 'button' && n.textContent === '+ Agregar persona');
  const controles = [...p.todo(tabla).filter((n) => ['select', 'button', 'input'].includes(n.tag)), agregar];
  assert.ok(controles.length >= 6 * 3, `los controles de la tabla (${controles.length})`);
  for (const c of controles) assert.strictEqual(c.attrs.disabled, 'disabled', `${c.tag} ${c.textContent} apagado`);
});

test('T11 Personas_TextosDelDuenoEnIngles @story-2.56 @ac-10', () => {
  const { t } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  const MS = require(path.join(ROOT, 'scripts', 'site', 'auth-providers', 'microsoft.js'));
  assert.strictEqual(t('en', 'pantalla.laListaDeQuienEntra'), 'The list of who gets in and what they see: Maintainers see this tab and propose changes; devs see only their own work. If you remove yourself, you lose access once the change is applied.');
  assert.strictEqual(t('en', 'pantalla.conQueSeEntra') + MS.TEXTOS['proveedor.microsoftInquilino'].en + t('en', 'pantalla.estoSeCambiaEnLa'),
    "Sign-in: Microsoft accounts from the organization's directory (one tenant, including guests). You change this in the installation, not here.");
  assert.strictEqual(t('en', 'pantalla.nadieEntraSiNoEsta'), 'Only people on this list can sign in. Each person can use any of their emails and sees the same thing.');
  // el castellano no cambia
  assert.strictEqual(t('es', 'pantalla.laListaDeQuienEntra'), 'La lista de quién entra y qué ve: quienes mantienen ven esta pestaña y proponen cambios; los devs ven lo suyo. Si te sacás de la lista, perdés el acceso cuando se apruebe.');
  assert.strictEqual(t('es', 'pantalla.conQueSeEntra') + MS.TEXTOS['proveedor.microsoftInquilino'].es + t('es', 'pantalla.estoSeCambiaEnLa'),
    'Con qué se entra: Microsoft, con las cuentas del directorio de la organización (un solo inquilino, con sus invitados). Esto se cambia en la instalación, no acá.');
  assert.strictEqual(t('es', 'pantalla.nadieEntraSiNoEsta'), 'Nadie entra si no está acá. Cada persona entra con cualquiera de sus correos y ve lo mismo.');
});

// ── Modelos, Repos e Integraciones en renglones ─────────────────────────────────────────────────────────────────
const MOD_JS = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'models.js'));
const MOD_DEFAULTS = MOD_JS.DEFAULTS;
/** El mismo `models` con cada modelo de Claude pasado a su nivel (lo que la pantalla muestra y propone). */
const enNiveles = (v) => (typeof v === 'string' ? (MOD_JS.levelOf(v) || v) : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'fable_question' || k === 'mandatory_ceiling' ? x : enNiveles(x)])) : v);
const AZR = (project, repo) => ({ platform: 'azure', org: 'acme', project, repo });
const MODELOS_2 = { reviewers_reloop: 'haiku', adversarial: { heavy: 'fable' }, session: { heavy: 'opus' },
  reviewer: { 'tycon-silent-failure-hunter': 'opus', 'tycon-spec-first-checker': 'sonnet' }, mandatory_ceiling: true, ceiling: 'opus' };
const SUITES_5 = { default: 'siempre-en-la-maquina', repos: [
  { repo: AZR('Cobranzas', 'CobranzasBackend'), rule: 'automatico', full_tests_pipeline: 'Cobranzas/pruebas-completas' },
  { repo: AZR('Cobranzas', 'CobranzasFormularios'), full_tests_pipeline: 'Cobranzas/formularios-completas' },
  { repo: GH('portal-clientes'), rule: 'confiar-en-el-servidor', full_tests_pipeline: 'full-tests' },
  { repo: AZR('Plataforma', 'herramientas-internas-del-equipo-de-plataforma-con-un-nombre-muy-largo'), rule: 'automatico' },
  { repo: GH('sitio-publico'), rule: 'confiar-en-el-servidor' },
] };
const INTEG = { clockify: true, engram: true, codex: 'detect', nightly: false };
const SIN_PIPE = { automatico: 'machine', 'siempre-en-la-maquina': 'machine', 'confiar-en-el-servidor': 'server-if-any-check' };
const secModelos = (models, problems = []) => ({ id: 'modelos', titulo: 'm', repo: 'perfil', archivo: 'team-repos.json', estado: 'cargado', soloLectura: false, motivo: null,
  borrador: models === undefined ? {} : { models: clon2(models) }, problems, avisos: [], extras: { hoy: MOD_DEFAULTS, revisores: ['tycon-silent-failure-hunter', 'tycon-spec-first-checker', 'tycon-story-validator'] } });
const secSuites = (ms, problems = [], extras = { sinPipeline: SIN_PIPE }) => ({ id: 'suites', titulo: 's', repo: 'perfil', archivo: 'team-repos.json', estado: 'cargado', soloLectura: false, motivo: null,
  borrador: { merge_suites: clon2(ms) }, problems, avisos: [], extras });
const secInteg = (i, problems = []) => ({ id: 'integraciones', titulo: 'i', repo: 'perfil', archivo: 'team-profile.json', estado: 'cargado', soloLectura: false, motivo: null,
  borrador: { integrations: clon2(i) }, problems, avisos: [] });
/** Una de las tres secciones sobre la pantalla falsa: sus tablas, sus renglones y lo que viaja al revisar. */
async function compacta(seccion) {
  const p = await pantallaFalsa([seccion], { '/api/config/revisar': () => ({ ok: true, texto: '', diferencias: [] }) });
  assert.strictEqual(p.error, null);
  const clases = (x) => String(x.attrs.class || '').split(' ');
  const de = (n, clase) => p.todo(n).filter((x) => clases(x).includes(clase));
  const tablas = () => de(p.sec(seccion.id), 'tabla2');
  const renglones = (tabla) => tabla.hijos.filter((x) => clases(x).includes('r'));
  const texto = (n) => p.todo(n).map((x) => x.textContent).join(' | ');
  const revisado = async () => { await p.click('Revisar cambios', seccion.id); return p.pedidos.filter((x) => x.ruta === '/api/config/revisar').pop().cuerpo.borrador; };
  const esperar = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return { ...p, clases, de, tablas, renglones, texto, revisado, esperar };
}

test('T1 Modelos_TresTablasUnRenglonPorTrabajo @story-2.59 @ac-1', async () => {
  const p = await compacta(secModelos(MODELOS_2));
  const t = p.tablas();
  assert.strictEqual(t.length, 3, 'una tabla por grupo');
  assert.ok(t.every((x) => p.clases(x).includes('modelos')));
  const [rev, adv, ayu] = t.map((x) => p.renglones(x));
  assert.deepStrictEqual([rev.length, adv.length, ayu.length], [4, 3, 4], 'revisores: 2 vueltas + 2 particulares · pase: normal, pesada, preguntar · ayudantes + 3 sesiones');
  for (const fila of [...rev, ...adv, ...ayu]) {
    assert.strictEqual(p.de(fila, 'hoy').length, 1, `${p.texto(fila)}: su valor por defecto`);
    assert.strictEqual(p.todo(fila).filter((n) => n.tag === 'select').length, 1, `${p.texto(fila)}: un selector`);
  }
  // la columna «Por defecto» en niveles
  assert.match(p.texto(rev[0]), /Primera vuelta \| equilibrado/);
  assert.match(p.texto(adv[1]), /pesada \| potente/);
  assert.match(p.texto(ayu[3]), /pesada \| potente/, 'la sesión pesada: opus (potente) por defecto (7.35)');
  // los particulares: su ✕; las vueltas, no
  assert.deepStrictEqual(rev.map((f) => p.de(f, 'quitar-fila').length), [0, 0, 1, 1]);
  assert.match(p.texto(rev[2]) + p.texto(rev[3]), /silent-failure-hunter/);
  // el tope, un renglón al pie, fuera de las tablas
  const tope = p.de(p.sec('modelos'), 'tope');
  assert.strictEqual(tope.length, 1);
  assert.ok(p.todo(tope[0]).some((n) => n.tag === 'input' && n.attrs.type === 'checkbox'));
  assert.ok(p.todo(tope[0]).some((n) => n.tag === 'select' && n.value === 'strong'));
});

test('T2 Modelos_TextosDelDueno @story-2.59 @ac-2', async () => {
  const { t } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  assert.deepStrictEqual([t('es', 'pantalla.porDefecto2'), t('es', 'pantalla.tuOrganizacionUsa'), t('es', 'pantalla.elPorDefecto')], ['Por defecto', 'Tu organización usa', 'el por defecto']);
  assert.deepStrictEqual([t('en', 'pantalla.porDefecto2'), t('en', 'pantalla.tuOrganizacionUsa'), t('en', 'pantalla.elPorDefecto')], ['Default', 'Your organization uses', 'the default']);
  const p = await compacta(secModelos(MODELOS_2));
  const cab = p.de(p.tablas()[0], 'h')[0];
  assert.deepStrictEqual(p.todo(cab).filter((n) => n.tag === 'span').map((n) => n.textContent).slice(0, 3), ['Trabajo', 'Por defecto', 'Tu organización usa']);
  const primera = p.todo(p.renglones(p.tablas()[0])[0]).find((n) => n.tag === 'select');
  assert.deepStrictEqual([primera.hijos[0].attrs.value, primera.hijos[0].textContent], ['', 'el por defecto']);
  assert.match(p.textoDe('modelos'), /«el por defecto»/, 'la ayuda de arriba dice qué hace «el por defecto»');
  // «historia», nunca «story», en castellano (los identificadores de los revisores, entre paréntesis, no son texto)
  const s = await compacta(secSuites(SUITES_5)); const i = await compacta(secInteg(INTEG));
  for (const [id, x] of [['modelos', p], ['suites', s], ['integraciones', i]]) assert.doesNotMatch(x.textoDe(id).replace(/\(tycon-[a-z0-9-]+\)/g, ''), /\bstor(y|ies)\b/i, id);
  assert.match(p.textoDe('modelos'), /Sesión, historia pesada/);
});

test('T3 Modelos_CambiarYVolverAlPorDefecto @story-2.59 @ac-3', async () => {
  const sel = (p, tabla, fila) => p.todo(p.renglones(p.tablas()[tabla])[fila]).find((n) => n.tag === 'select');
  let p = await compacta(secModelos(MODELOS_2));
  sel(p, 2, 0).on.change({ target: { value: 'balanced' } });   // los ayudantes
  assert.deepStrictEqual((await p.revisado()).models, { ...enNiveles(MODELOS_2), helpers: 'balanced' });
  p = await compacta(secModelos(MODELOS_2));
  sel(p, 1, 1).on.change({ target: { value: '' } });        // la historia pesada vuelve al por defecto: adversarial queda vacío y sale
  const sinPesada = enNiveles(MODELOS_2); delete sinPesada.adversarial;
  assert.deepStrictEqual((await p.revisado()).models, sinPesada);
  p = await compacta(secModelos(MODELOS_2));
  p.de(p.renglones(p.tablas()[0])[2], 'quitar-fila')[0].on.click({}); await p.esperar();
  const sinUno = enNiveles(MODELOS_2); delete sinUno.reviewer[Object.keys(MODELOS_2.reviewer)[0]];
  assert.deepStrictEqual((await p.revisado()).models, sinUno, 'sacar un revisor particular');
});

test('T4 Modelos_PorEncimaDelTope @story-2.59 @ac-4', async () => {
  const TEAM = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
  const rev = (models) => ORG.revisar({ seccion: 'modelos', texto: ORG.formatJson(TR_BASE), borrador: { models }, lectores: { 'team-repos.js': TEAM } });
  const malo = rev(MODELOS_2);
  assert.strictEqual(malo.ok, false, 'no se puede proponer');
  assert.strictEqual(malo.texto, null);
  assert.deepStrictEqual(malo.problems.map((x) => x.path), ['models.adversarial.heavy']);
  assert.strictEqual(rev({ ...MODELOS_2, adversarial: { heavy: 'opus' } }).ok, true, 'igual al tope: se propone');
  assert.strictEqual(rev({ mandatory_ceiling: true, ceiling: 'sonnet' }).ok, true, 'el por defecto (opus) por encima del tope no se marca');
  const { mandatory_ceiling: _m, ceiling: _c, ...sinTope } = MODELOS_2;
  assert.strictEqual(rev(sinTope).ok, true, 'sin tope, nada');
  // la pantalla: el renglón en rojo con su mensaje; los demás, no
  const p = await compacta(secModelos(MODELOS_2, [{ path: 'models.adversarial.heavy', message: 'pasa el tope obligatorio (opus)' }]));
  const filas = p.tablas().flatMap((x) => p.renglones(x));
  const malas = filas.filter((f) => p.clases(f).includes('mal'));
  assert.strictEqual(malas.length, 1);
  assert.match(p.texto(malas[0]), /pesada/);
  assert.match(p.texto(malas[0]), /pasa el tope obligatorio \(opus\): elegí uno igual o menor/);
  assert.ok(p.clases(p.todo(malas[0]).find((n) => n.tag === 'select')).includes('bad'));
  // al cargar, el sitio ya lo marca (la vista trae el problema) y «revisar» no deja proponer
  await conPerfil({ repos: { ...TR_BASE, models: MODELOS_2 } }, async ({ seccion, revisar }) => {
    const v = await seccion('modelos');
    assert.deepStrictEqual(v.problems.map((x) => x.path), ['models.adversarial.heavy'], JSON.stringify(v.problems));
    const r = await revisar('modelos', { models: MODELOS_2 });
    assert.strictEqual(r.ok, false);
  });
});

test('T5 Repos_UnRenglonPorRepo @story-2.59 @ac-5', async () => {
  const p = await compacta(secSuites(SUITES_5));
  const t = p.tablas();
  assert.strictEqual(t.length, 1);
  const filas = p.renglones(t[0]);
  assert.strictEqual(filas.length, 5, 'un renglón por repo');
  const textos = ['acme / Cobranzas / CobranzasBackend', 'acme / Cobranzas / CobranzasFormularios', 'acme / portal-clientes',
    'acme / Plataforma / herramientas-internas-del-equipo-de-plataforma-con-un-nombre-muy-largo', 'acme / sitio-publico'];
  filas.forEach((f, i) => {
    const ic = p.de(f, 'ic')[0];
    assert.strictEqual(ic.attrs['aria-label'], SUITES_5.repos[i].repo.platform === 'github' ? 'GitHub' : 'Azure DevOps');
    const rt = p.de(f, 'repo-t')[0];
    assert.deepStrictEqual([rt.textContent, rt.attrs.title], [textos[i], textos[i]], 'el repo entero, y entero en su título');
    assert.strictEqual(p.todo(p.de(f, 'regla')[0]).filter((n) => n.tag === 'select').length, 1);
    const pc = p.de(f, 'pc')[0];
    // la celda es un texto, o el pipeline y su nota (el pipeline que la regla no usa): el título los trae enteros
    const partes = p.todo(pc).filter((n) => n !== pc && n.textContent).map((n) => n.textContent);
    assert.strictEqual(pc.attrs.title, partes.length ? partes.join(' · ') : pc.textContent, 'las pruebas completas, enteras en su título');
    assert.deepStrictEqual(p.todo(p.de(f, 'acc')[0]).filter((n) => n.tag === 'button').map((n) => n.textContent), ['✎', '✕']);
    assert.strictEqual(p.todo(f).filter((n) => n.tag === 'input').length, 0, 'cerrado: sin campos de texto');
  });
  assert.strictEqual(p.de(filas[0], 'pc')[0].textContent, 'Cobranzas/pruebas-completas');
  assert.match(p.textoDe('suites'), /Cada repo usa la regla de la organización, salvo que elijas otra para él\./);
  const { t: tx } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  assert.strictEqual(tx('en', 'pantalla.cadaRepoUsaLaRegla'), "Each repo uses the organization's rule, unless you pick another one for it.");
});

test('T6 Repos_EditarAgregarSacar @story-2.59 @ac-6', async () => {
  let p = await compacta(secSuites(SUITES_5));
  const fila = (i) => p.renglones(p.tablas()[0])[i];
  const boton = (f, txt) => p.todo(f).find((n) => n.tag === 'button' && n.textContent === txt);
  boton(fila(1), '✎').on.click({}); await p.esperar();
  assert.strictEqual(boton(fila(1), '✎').attrs['aria-expanded'], 'true');
  const edit = p.de(fila(1), 'edit')[0];
  assert.ok(edit, '✎ abre los campos debajo del renglón');
  const repo = p.todo(edit).find((n) => n.tag === 'input' && n.attrs['data-path'] === 'merge_suites.repos.1.repo.repo');
  repo.on.input({ target: { value: 'CobranzasFront' } });
  p.todo(p.de(fila(1), 'regla')[0]).find((n) => n.tag === 'select').on.change({ target: { value: 'confiar-en-el-servidor' } }); await p.esperar();
  let esperado = clon2(SUITES_5); esperado.repos[1].repo.repo = 'CobranzasFront'; esperado.repos[1].rule = 'confiar-en-el-servidor';
  assert.deepStrictEqual((await p.revisado()).merge_suites, esperado, 'editar: sólo ese repo');
  boton(fila(1), 'Listo').on.click({}); await p.esperar();
  assert.strictEqual(p.de(fila(1), 'edit').length, 0, '«Listo» lo cierra');
  // ✕ saca sólo ese repo
  p = await compacta(secSuites(SUITES_5));
  boton(fila(2), '✕').on.click({}); await p.esperar();
  esperado = clon2(SUITES_5); esperado.repos.splice(2, 1);
  assert.deepStrictEqual((await p.revisado()).merge_suites, esperado);
  // + agrega la entrada de hoy, abierta
  p = await compacta(secSuites(SUITES_5));
  await p.click('+ Agregar repo', 'suites');
  assert.strictEqual(p.renglones(p.tablas()[0]).length, 6);
  assert.strictEqual(p.de(fila(5), 'edit').length, 1, 'el nuevo, abierto');
  esperado = clon2(SUITES_5); esperado.repos.push({ repo: { platform: 'azure', org: '', project: '', repo: '' }, rule: 'automatico' });
  assert.deepStrictEqual((await p.revisado()).merge_suites, esperado);
  // un repo con problema se dibuja abierto y con su mensaje
  p = await compacta(secSuites(SUITES_5, [{ path: 'merge_suites.repos.3.repo.org', message: 'falta' }, { path: 'merge_suites.repos.0.extra', message: 'clave desconocida' }]));
  assert.strictEqual(p.de(fila(3), 'edit').length, 1, 'abierto por su problema');
  assert.strictEqual(p.de(fila(0), 'edit').length, 1, 'también uno con una clave que no tiene campo');
  assert.match(p.texto(fila(0)), /no conoce|clave desconocida/i);
  assert.strictEqual(p.de(fila(2), 'edit').length, 0, 'los demás, cerrados');
});

test('T13 Repos_SinPipelineQuePasa @story-2.59 @ac-13', async () => {
  const pc = (p, i) => p.de(p.renglones(p.tablas()[0])[i], 'pc')[0].textContent;
  const MAQ = 'corren en la máquina del dev';
  const SRV = 'el servidor, si la rama exige un control; si no, la máquina del dev';
  // regla propia: automático y confiar, sin pipeline (los repos 3 y 4); con pipeline se ve el pipeline
  let p = await compacta(secSuites(SUITES_5));
  assert.deepStrictEqual([pc(p, 3), pc(p, 4), pc(p, 0)], [MAQ, SRV, 'Cobranzas/pruebas-completas']);
  // siempre en la máquina propio; y la de la organización cuando el repo no elige otra
  p = await compacta(secSuites({ default: 'confiar-en-el-servidor', repos: [{ repo: GH('a'), rule: 'siempre-en-la-maquina' }, { repo: GH('b'), full_tests_pipeline: 'ci' }, { repo: GH('c') }] }));
  assert.deepStrictEqual([pc(p, 0), pc(p, 1), pc(p, 2)], [MAQ, 'ci', SRV]);
  // cambiar la regla de la organización cambia el texto; sin declarar, automático
  const orgSel = p.todo(p.sec('suites')).find((n) => n.tag === 'select' && n.attrs['data-path'] === 'merge_suites.default');
  orgSel.on.change({ target: { value: 'siempre-en-la-maquina' } }); await p.esperar();
  assert.strictEqual(pc(p, 2), MAQ, 'la de la organización cambió');
  orgSel.on.change({ target: { value: '' } }); await p.esperar();
  assert.strictEqual(pc(p, 2), MAQ, 'sin declarar: automático');
  // y cambiar la regla del repo también
  p.todo(p.de(p.renglones(p.tablas()[0])[2], 'regla')[0]).find((n) => n.tag === 'select').on.change({ target: { value: 'confiar-en-el-servidor' } }); await p.esperar();
  assert.strictEqual(pc(p, 2), SRV);
  // un sitio que no manda qué pasa no lo inventa
  const w = await compacta(secSuites({ repos: [{ repo: GH('c'), rule: 'automatico' }] }, [], null));
  assert.strictEqual(pc(w, 0), 'sin pipeline');
  // el servidor manda el mapa con el lector del árbol
  await conPerfil({ repos: { ...TR_BASE, merge_suites: SUITES_5 } }, async ({ seccion }) => {
    assert.deepStrictEqual((await seccion('suites')).extras.sinPipeline, SIN_PIPE);
  });
});

test('T7 Integraciones_UnRenglonPorIntegracion @story-2.59 @ac-7', async () => {
  let p = await compacta(secInteg(INTEG));
  const filas = p.renglones(p.tablas()[0]);
  assert.strictEqual(filas.length, 7, 'la de horas, la de los avisos (story 7.40), las cuatro de antes y CodeGraph');
  assert.ok(p.clases(p.tablas()[0]).includes('integ'));
  filas.forEach((f) => { assert.strictEqual(p.de(f, 'que').length, 1); assert.strictEqual(p.todo(f).filter((n) => n.tag === 'select').length, 1); });
  assert.match(p.texto(filas[0]), /Registro de horas/, 'el primero es la herramienta de horas');
  assert.match(p.texto(filas[1]), /Avisos/, 'el segundo, los canales de aviso');
  assert.deepStrictEqual(p.todo(filas[4]).find((n) => n.tag === 'select').hijos.map((o) => o.attrs.value), ['', 'true', 'false', 'detect'], 'codex suma «si está instalado»');
  p.todo(filas[3]).find((n) => n.tag === 'select').on.change({ target: { value: 'true' } });
  assert.deepStrictEqual((await p.revisado()).integrations, { ...INTEG, mailbox: true });
  p = await compacta(secInteg(INTEG));
  p.todo(p.renglones(p.tablas()[0])[0]).find((n) => n.tag === 'select').on.change({ target: { value: '' } });
  const { clockify: _c, ...sinClockify } = INTEG;
  assert.deepStrictEqual((await p.revisado()).integrations, sinClockify, '«sin declarar» saca la hoja');
});

test('T8 Compacta_SinTocarNadaNoCambia @story-2.59 @ac-8', async () => {
  // el servidor carga los modelos en niveles; lo que llega así viaja igual
  for (const [s, k, v] of [[secModelos(enNiveles(MODELOS_2)), 'models', enNiveles(MODELOS_2)], [secSuites(SUITES_5), 'merge_suites', SUITES_5], [secInteg(INTEG), 'integrations', INTEG]]) {
    const p = await compacta(s);
    const va = (await p.revisado())[k];
    assert.strictEqual(JSON.stringify(va), JSON.stringify(v), `${s.id}: mismo orden y mismas claves`);
  }
});

test('T9 Compacta_HojaConTemaYTelefono @story-2.59 @ac-9 @ac-10', () => {
  const css = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'static', 'site.css'), 'utf8');
  const reglas = css.match(/[^{}]*\.(tabla2|tope|repo-t|ic|pc|integ)\b[^{}]*\{[^{}]*\}/g) || [];
  assert.ok(reglas.length >= 8, `las reglas de las tablas (${reglas.length})`);
  for (const r of reglas) assert.doesNotMatch(r.slice(r.indexOf('{')), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, `sin colores fijos: ${r.trim().slice(0, 80)}`);
  // las columnas de Modelos: el trabajo con un ancho acotado y el resto para el selector y su equivalencia; el selector,
  // del mismo ancho en todos los renglones de las tres tablas, y la equivalencia en un renglón
  assert.match(css, /\.tabla2\.modelos\{[^}]*grid-template-columns:minmax\(\d+em,\d+em\) max-content minmax\(0,1fr\)/);
  assert.match(css, /\.tabla2\.modelos select\.corto\{[^}]*width:\d+em/);
  assert.match(css, /\.tabla2\.modelos \.equiv\{[^}]*white-space:nowrap/);
  // nada cortado en Repos: sin puntos suspensivos
  for (const r of reglas.filter((x) => /\.(repo-t|pc)\b/.test(x))) assert.doesNotMatch(r, /text-overflow:ellipsis/, r.trim().slice(0, 80));
  const tel = /@media \(max-width:640px\)\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(tel && /\.tabla2/.test(tel[1]), 'el teléfono baja los renglones a dos líneas');
});

test('T10 Compacta_TextosEnLosDosIdiomas @story-2.59 @ac-10', () => {
  const { t } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  const claves = ['pantalla.porDefecto2', 'pantalla.tuOrganizacionUsa', 'pantalla.elPorDefecto', 'pantalla.llegaATodasLasMaquinas3', 'pantalla.cadaRepoUsaLaRegla',
    'pantalla.correnEnLaMaquinaDelDev', 'pantalla.elServidorSiLaRama', 'pantalla.sinPipeline', 'pantalla.pasaElTopeObligatorio', 'pantalla.editarElRepo',
    'pantalla.quitarElRepo', 'pantalla.listo', 'pantalla.pruebasCompletas', 'pantalla.unRevisorEnParticular2'];
  for (const k of claves) {
    assert.notStrictEqual(t('es', k), k, `${k} en castellano`);
    assert.notStrictEqual(t('en', k), k, `${k} en inglés`);
    assert.notStrictEqual(t('en', k), t('es', k), `${k} distinto en cada idioma`);
    assert.ok(ORG.pantalla().includes(`'${k}'`), `${k} lo usa la pantalla`);
  }
});

// ── el pipeline que la regla no usa, atenuado ────────────────────────────────────────────────────────────────────────
test('T1 Repos_PipelineQueLaReglaNoUsa_Atenuado @story-2.59.1 @ac-1 @ac-2 @ac-3', async () => {
  const ms = { default: 'siempre-en-la-maquina', repos: [
    { repo: GH('propia'), rule: 'siempre-en-la-maquina', full_tests_pipeline: 'ci-a' },
    { repo: GH('de-la-org'), full_tests_pipeline: 'ci-b' },
    { repo: GH('auto'), rule: 'automatico', full_tests_pipeline: 'ci-c' },
    { repo: GH('confiar'), rule: 'confiar-en-el-servidor', full_tests_pipeline: 'ci-d' },
  ] };
  const p = await compacta(secSuites(ms));
  const celda = (i) => p.de(p.renglones(p.tablas()[0])[i], 'pc')[0];
  const atenuado = (i) => p.de(celda(i), 'ignorado').length === 1 && p.texto(celda(i)).includes('no se usa con esta regla');
  assert.deepStrictEqual([0, 1, 2, 3].map(atenuado), [true, true, false, false], 'sólo con «siempre en la máquina», propia o de la organización');
  assert.ok(p.texto(celda(0)).includes('ci-a') && p.texto(celda(1)).includes('ci-b'), 'el nombre sigue entero');
  assert.match(celda(0).attrs.title, /ci-a.*no se usa con esta regla/, 'el título lo dice');
  // la regla de la organización a automático: el segundo deja de estar atenuado; el primero tiene la suya
  p.todo(p.sec('suites')).find((n) => n.tag === 'select' && n.attrs['data-path'] === 'merge_suites.default').on.change({ target: { value: 'automatico' } });
  await p.esperar();
  assert.deepStrictEqual([0, 1].map(atenuado), [true, false]);
  // sin tocar, lo mismo que llegó
  const q = await compacta(secSuites(ms));
  assert.strictEqual(JSON.stringify((await q.revisado()).merge_suites), JSON.stringify(ms));
});

test('T2 Repos_PipelineNoUsado_TextosEnLosDosIdiomas @story-2.59.1 @ac-4', () => {
  const { t } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  assert.deepStrictEqual([t('es', 'pantalla.noSeUsaConEstaRegla'), t('en', 'pantalla.noSeUsaConEstaRegla')], ['no se usa con esta regla', 'not used with this rule']);
  assert.ok(ORG.pantalla().includes("'pantalla.noSeUsaConEstaRegla'"));
});

test('T3 Repos_PipelineNoUsado_HojaConTema @story-2.59.1 @ac-4', () => {
  const css = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'static', 'site.css'), 'utf8');
  const reglas = css.match(/[^{}]*\.(ignorado|nota)\b[^{}]*\{[^{}]*\}/g) || [];
  assert.ok(reglas.length >= 2, `las reglas del pipeline atenuado (${reglas.length})`);
  for (const r of reglas) assert.doesNotMatch(r.slice(r.indexOf('{')), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, r.trim().slice(0, 80));
});

// ── qué hace cada regla, debajo de su selector ──────────────────────────────────────────────────────────────────────
const QUE_HACE = { automatico: 'server-if-required', 'siempre-en-la-maquina': 'machine-always', 'confiar-en-el-servidor': 'server-only' };
const LINEA = {
  automatico: 'el servidor, si la rama le exige las pruebas; si no, la máquina del dev',
  siempre: 'en la máquina del dev, aunque el servidor también las corra',
  confiar: 'sólo el servidor; sirve si de verdad las corre',
};
// un repo sin regla propia: qué hace la regla de la organización
const COMO_ORG = (queHace) => `como la organización: ${queHace}`;

test('T1 Repos_QueHaceCadaRegla_DebajoDelSelector @story-2.59.2 @ac-1 @ac-3', async () => {
  const ms = { default: 'automatico', repos: [
    { repo: GH('sin-regla') },
    { repo: GH('auto'), rule: 'automatico' },
    { repo: GH('siempre'), rule: 'siempre-en-la-maquina', full_tests_pipeline: 'ci-s' },
    { repo: GH('confiar'), rule: 'confiar-en-el-servidor' },
  ] };
  const extras = { sinPipeline: SIN_PIPE, queHace: QUE_HACE };
  const p = await compacta(secSuites(ms, [], extras));
  const linea = (nodo) => { const q = p.de(nodo, 'que-hace'); return q.length === 1 ? p.texto(q[0]) : null; };
  const deRepo = (i) => linea(p.de(p.renglones(p.tablas()[0])[i], 'regla')[0]);
  const orgSel = () => p.todo(p.sec('suites')).find((n) => n.tag === 'select' && n.attrs['data-path'] === 'merge_suites.default');
  const deOrg = () => { const sel = orgSel(); const caja = p.todo(p.sec('suites')).find((n) => n.tag === 'div' && n.attrs.class === 'campo' && p.todo(n).includes(sel)); return linea(caja); };
  assert.deepStrictEqual([0, 1, 2, 3].map(deRepo), [COMO_ORG(LINEA.automatico), LINEA.automatico, LINEA.siempre, LINEA.confiar]);
  assert.strictEqual(deOrg(), LINEA.automatico);
  // al cambiar la opción, cambia la línea (la del repo y la de la organización)
  p.todo(p.de(p.renglones(p.tablas()[0])[1], 'regla')[0]).find((n) => n.tag === 'select').on.change({ target: { value: 'confiar-en-el-servidor' } });
  await p.esperar();
  assert.strictEqual(deRepo(1), LINEA.confiar);
  orgSel().on.change({ target: { value: 'siempre-en-la-maquina' } });
  await p.esperar();
  assert.strictEqual(deOrg(), LINEA.siempre);
  assert.strictEqual(deRepo(0), COMO_ORG(LINEA.siempre), 'el repo sin regla propia dice qué hace la de la organización');
  // «sin declarar» en la organización: rige automático
  orgSel().on.change({ target: { value: '' } });
  await p.esperar();
  assert.strictEqual(deOrg(), LINEA.automatico);
  // sin tocar, lo mismo que llegó; la nota «sin pipeline» y el pipeline que la regla no usa, igual
  const q = await compacta(secSuites(ms, [], extras));
  assert.strictEqual(JSON.stringify((await q.revisado()).merge_suites), JSON.stringify(ms));
  const pc = (i) => p.texto(q.de(q.renglones(q.tablas()[0])[i], 'pc')[0]);
  assert.strictEqual(pc(0), 'corren en la máquina del dev');
  assert.match(pc(2), /ci-s.*no se usa con esta regla/);
});

test('T2 Repos_QueHace_SaleDelLector @story-2.59.2 @ac-2', async () => {
  assert.deepStrictEqual(ORG.queHacePorRegla(TR), Object.fromEntries(TR.MERGE_RULES.map((r) => [r, TR.suitesWithRule(r)])));
  assert.deepStrictEqual(ORG.queHacePorRegla(TR), QUE_HACE);
  assert.strictEqual(TR.suitesWithRule('otra'), null);
  assert.strictEqual(ORG.queHacePorRegla({ MERGE_RULES: TR.MERGE_RULES, suitesWithoutPipeline: TR.suitesWithoutPipeline }), null, 'un lector anterior');
  // sin la respuesta del lector, ninguna línea
  const p = await compacta(secSuites({ default: 'automatico', repos: [{ repo: GH('c'), rule: 'automatico' }] }));
  assert.strictEqual(p.todo(p.sec('suites')).filter((n) => n.attrs && n.attrs.class === 'que-hace').length, 0);
  // una respuesta incompleta o con un valor que la pantalla no conoce: esa regla queda sin línea, las demás la tienen
  const raro = { automatico: 'otra-cosa', 'siempre-en-la-maquina': 'machine-always' };
  const r = await compacta(secSuites({ default: 'automatico', repos: [
    { repo: GH('a'), rule: 'automatico' }, { repo: GH('s'), rule: 'siempre-en-la-maquina' }, { repo: GH('c'), rule: 'confiar-en-el-servidor' }, { repo: GH('o'), full_tests_pipeline: 'ci' },
  ] }, [], { sinPipeline: SIN_PIPE, queHace: raro }));
  const lineaDe = (i) => { const q = r.de(r.de(r.renglones(r.tablas()[0])[i], 'regla')[0], 'que-hace'); return q.length ? r.texto(q[0]) : null; };
  // el repo que sigue a la organización (automático, con un valor que la pantalla no conoce) tampoco tiene línea
  assert.deepStrictEqual([0, 1, 2, 3].map(lineaDe), [null, LINEA.siempre, null, null]);
  // el servidor manda la respuesta con el lector del árbol
  await conPerfil({ repos: { ...TR_BASE, merge_suites: SUITES_5 } }, async ({ seccion }) => {
    assert.deepStrictEqual((await seccion('suites')).extras.queHace, QUE_HACE);
  });
});

test('T3 Repos_QueHace_TextosEnLosDosIdiomas @story-2.59.2 @ac-4', () => {
  const { t } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  const claves = { 'pantalla.comoLaOrganizacion': ['como la organización: {queHace}', "like the organization: {queHace}"],
    'pantalla.queHaceAutomatico': [LINEA.automatico, "the server, if the branch requires the tests; otherwise the dev's machine"],
    'pantalla.queHaceSiempre': [LINEA.siempre, "on the dev's machine, even if the server also runs them"],
    'pantalla.queHaceConfiar': [LINEA.confiar, 'only the server; useful if it really runs them'] };
  for (const [k, [es, en]] of Object.entries(claves)) {
    assert.deepStrictEqual([t('es', k), t('en', k)], [es, en], k);
    assert.ok(ORG.pantalla().includes(`'${k}'`), `${k} lo usa la pantalla`);
  }
});

test('T33 Repos_ComoLaOrganizacionDiceQueHace @story-2.61.3 @ac-7 — el repo que sigue a la organización dice qué hace su regla, y cambia con ella', async () => {
  const ms = { repos: [{ repo: GH('sigue') }, { repo: GH('propia'), rule: 'confiar-en-el-servidor' }] };
  const p = await compacta(secSuites(ms, [], { sinPipeline: SIN_PIPE, queHace: QUE_HACE }));
  const deRepo = (i) => { const q = p.de(p.de(p.renglones(p.tablas()[0])[i], 'regla')[0], 'que-hace'); return q.length === 1 ? p.texto(q[0]) : null; };
  const orgSel = () => p.todo(p.sec('suites')).find((n) => n.tag === 'select' && n.attrs['data-path'] === 'merge_suites.default');
  // sin declarar en la organización: rige automático, y el repo lo dice
  assert.strictEqual(deRepo(0), COMO_ORG(LINEA.automatico));
  assert.strictEqual(deRepo(1), LINEA.confiar, 'el de regla propia, sin cambios');
  for (const [regla, linea] of [['siempre-en-la-maquina', LINEA.siempre], ['confiar-en-el-servidor', LINEA.confiar], ['automatico', LINEA.automatico]]) {
    orgSel().on.change({ target: { value: regla } });
    await p.esperar();
    assert.strictEqual(deRepo(0), COMO_ORG(linea), `con «${regla}» arriba`);
  }
  assert.ok(!p.todo(p.sec('suites')).some((n) => n.attrs && n.attrs.class === 'que-hace' && /regla de arriba/.test(p.texto(n))), 'ningún «sigue la regla de arriba»');
});

test('T4 Repos_QueHace_HojaConTema @story-2.59.2 @ac-4', () => {
  const css = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'static', 'site.css'), 'utf8');
  const reglas = css.match(/[^{}]*\.que-hace\b[^{}]*\{[^{}]*\}/g) || [];
  assert.ok(reglas.length >= 1, 'la regla de la línea');
  for (const r of reglas) assert.doesNotMatch(r.slice(r.indexOf('{')), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, r.trim().slice(0, 80));
});

// ── Quién puede reenviar el ok de un dev (approvals.relay_session) ─────────────────────────────────────
test('8.63 Seccion_ReenvioDelOk @story-8.63 @ac-12 — la sección valida con el lector de la máquina y va en «Cómo trabaja el agente»', () => {
  const s = ORG.seccionPorId('aprobaciones');
  assert.ok(s, 'la sección existe');
  assert.deepStrictEqual([s.archivo, s.repo, s.lector, s.claves, s.rutas], ['team-profile.json', 'perfil', 'harness-config', ['approvals'], ['approvals.relay_session']]);
  const rev = (borrador) => ORG.revisar({ seccion: 'aprobaciones', texto: ORG.formatJson(PERFIL_TYCON), borrador, lectores: { 'harness-config': TC } });
  const ok = rev({ approvals: { relay_session: 'coordinadora' } });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));
  assert.strictEqual(ok.texto, ORG.formatJson({ ...PERFIL_TYCON, approvals: { relay_session: 'coordinadora' } }));
  const malo = rev({ approvals: { relay_session: 42 } });
  assert.strictEqual(malo.ok, false);
  assert.ok(malo.problems.some((p) => p.path === 'approvals.relay_session'), JSON.stringify(malo.problems));
  // la pantalla la dibuja en «Cómo trabaja el agente», con sus textos en las dos lenguas
  for (const idioma of ['es', 'en']) {
    const js = ORG.pantalla(idioma);
    assert.match(js, /aprobaciones: editorAprobaciones/);
    assert.match(js, /'respuesta', 'modelos', 'suites', 'cobertura', 'revision', 'tecnologia', 'aprobaciones'/);
    // sí o no: el «sí» escribe el rol que ya tenga o «coordinadora» (su nombre se cambia aparte; la prueba de abajo);
    // la sesión se designa en la máquina, así que la pantalla nunca pide el nombre de una sesión
    assert.match(js, /selector\(T\('pantalla\.quienReenviaElOk'\), rol \? 'si' : ''/);
    assert.match(js, /x === 'si' \? \(rol \|\| 'coordinadora'\) : ''/);
    assert.doesNotMatch(js, /campo\(T\('pantalla\.quienReenviaElOk'\)/, 'no pide el nombre de una sesión');
  }
  const textos = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  assert.match(textos.t('es', 'pantalla.quienReenviaElOkAyuda'), /se designa en cada máquina/);
  for (const k of ['pantalla.quienReenviaElOk', 'pantalla.quienReenviaElOkNo', 'pantalla.quienReenviaElOkSi', 'pantalla.quienReenviaElOkAyuda', 'org.capaSinApprovals']) {
    assert.ok(textos.t('es', k, { req: 'x', version: 'y' }) !== textos.t('en', k, { req: 'x', version: 'y' }), `${k} en las dos lenguas`);
  }
});

test('Seccion_ReenvioDelOk_ElNombreDelRol — con «Sí», el nombre del rol se cambia y la frase de la ayuda lo usa', async () => {
  // 🔴 rojo: no hay dónde poner el nombre, la ayuda dice siempre «coordinadora», o se lee «Cuál sesión es se designa».
  const abrir = async (borrador, idioma = 'es') => {
    const r = await pantallaConPestanas({ secciones: [...TODAS.map((id) => SEC(id)), SEC('aprobaciones', { repo: 'perfil', borrador })], idioma, hash: '#seccion-aprobaciones' });
    const todos = () => { const out = []; (function walk(x) { out.push(x); (x.hijos || []).forEach(walk); })(r.creados.filter((n) => n.attrs.id === 'seccion-aprobaciones').pop()); return out; };
    const esperar = async () => { for (let i = 0; i < 10; i++) await new Promise((x) => setImmediate(x)); };
    return { r, todos, esperar, texto: () => todos().map((n) => n.textContent || '').join(' | ') };
  };
  // con «No» no se pide el nombre, y la ayuda sale sin la errata
  const no = await abrir({});
  assert.ok(!no.todos().some((n) => n.tag === 'input'), 'sin «Sí», no hay campo');
  assert.match(no.texto(), /La sesión se designa en cada máquina: el dev escribe en el chat de esa sesión «Esta sesión es la coordinadora»/);
  assert.doesNotMatch(no.texto(), /Cuál sesión es se designa/);
  // elegir «Sí» trae el campo con «coordinadora», el nombre de fábrica
  no.todos().find((n) => n.tag === 'select' && n.attrs['data-path'] === 'approvals.relay_session').on.change({ target: { value: 'si' } }); await no.esperar();
  const deFabrica = no.todos().find((n) => n.tag === 'input' && n.attrs['aria-label'] === '¿Cómo la llaman?');
  assert.ok(deFabrica, 'con «Sí», aparece el campo');
  assert.strictEqual(deFabrica.attrs.value, 'coordinadora');
  // con un nombre propio: el campo lo trae, la ayuda lo nombra y avisa que cambiarlo pide designar de nuevo
  const si = await abrir({ approvals: { relay_session: 'líder' } });
  const campoNombre = si.todos().find((n) => n.tag === 'input' && n.attrs['aria-label'] === '¿Cómo la llaman?');
  assert.ok(campoNombre, 'con «Sí», el campo del nombre');
  assert.strictEqual(campoNombre.attrs.value, 'líder');
  assert.match(si.texto(), /«Esta sesión es la líder»/);
  assert.match(si.texto(), /Si cambiás el nombre, la designación anterior deja de valer/);
  // escribir otro nombre lo guarda y la ayuda cambia en el lugar; vacío vuelve a «coordinadora»
  campoNombre.on.input({ target: { value: '  jefa  ' } }); await si.esperar();
  assert.match(si.texto(), /«Esta sesión es la jefa»/);
  campoNombre.on.input({ target: { value: '' } }); await si.esperar();
  assert.match(si.texto(), /«Esta sesión es la coordinadora»/);
  const en = await abrir({ approvals: { relay_session: 'lead' } }, 'en');
  assert.ok(en.todos().some((n) => n.tag === 'input' && n.attrs['aria-label'] === 'What do you call it?'));
  assert.match(en.texto(), /names the role \(lead\)/);
});

// ── Una persona marca cada criterio como probado a mano (qa.manual_check) ───────────────────────────────
test('7.46 Config_PruebaAMano_SeccionYPedido @story-7.46 @ac-7 @ac-15 — la sección, sus textos en dos lenguas, y lo que propone', async () => {
  const s = ORG.seccionPorId('pruebaAMano');
  assert.ok(s, 'la sección existe');
  assert.deepStrictEqual([s.archivo, s.repo, s.lector, s.claves, s.rutas, s.necesita], ['team-profile.json', 'perfil', 'harness-config', ['qa'], ['qa.manual_check'], ['qa']]);
  const rev = (borrador) => ORG.revisar({ seccion: 'pruebaAMano', texto: ORG.formatJson(PERFIL_TYCON), borrador, lectores: { 'harness-config': TC } });
  const ok = rev({ qa: { manual_check: 'required' } });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));
  assert.strictEqual(ok.texto, ORG.formatJson({ ...PERFIL_TYCON, qa: { manual_check: 'required' } }));
  assert.strictEqual(rev({ qa: { manual_check: 'si' } }).ok, false);
  // la pantalla, en las dos lenguas: el título, el selector con sus dos opciones y la ayuda
  const textos = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  const esperado = {
    es: ['Prueba a mano de cada criterio', 'Una persona marca cada criterio como probado a mano', 'No (de fábrica): la guía dice qué probó el arnés', 'Sí: la historia no se cierra sin la marca de una persona'],
    en: ['Hand-testing each criterion', 'A person marks each criterion as tested by hand', 'No (default): the guide says what the harness tested', "Yes: the story does not close without a person's mark"],
  };
  for (const idioma of ['es', 'en']) {
    for (const k of ['pantalla.pruebaAManoTitulo', 'pantalla.pruebaAMano', 'pantalla.pruebaAManoNo', 'pantalla.pruebaAManoSi']) assert.ok(esperado[idioma].includes(textos.t(idioma, k)), `${idioma} ${k}: ${textos.t(idioma, k)}`);
    assert.match(textos.t(idioma, 'pantalla.pruebaAManoAyuda'), idioma === 'es' ? /el agente no puede\s+ponerla/ : /the agent cannot set it/);
    assert.match(ORG.pantalla(idioma), /pruebaAMano: editorPruebaAMano/);
  }
  const p = await pantallaFalsa([seccionPerfil('pruebaAMano', {})]);
  assert.strictEqual(p.error, null);
  const sel = p.todo(p.sec('pruebaAMano')).find((n) => n.tag === 'select');
  assert.ok(sel, 'hay un selector');
  assert.deepStrictEqual(p.todo(sel).filter((n) => n.tag === 'option').map((n) => n.attrs.value), ['', 'required']);
  assert.match(p.textoDe('pruebaAMano'), /el agente no puede/);
  // con qa en el perfil, la capa tiene que pedir la versión que la lee
  const CON = { ...PERFIL_TYCON, qa: { manual_check: 'required' } };
  const bajo = ORG.teamProfileGateProblem({ layerText: JSON.stringify(capa(ORG.APPROVALS_SINCE)), versionImagen: '2026.10.15.48', doc: CON });
  assert.match(bajo, /todavía no se puede proponer/); assert.match(bajo, /qa/); assert.ok(bajo.includes(`>= ${ORG.QA_SINCE}`), bajo);
  assert.strictEqual(ORG.teamProfileGateProblem({ layerText: JSON.stringify(capa(ORG.QA_SINCE)), versionImagen: '2026.10.15.48', doc: CON }), null);
});

test('8.63 Perfil_ApprovalsPideSuVersion @story-8.63 @ac-12 — con approvals en el perfil, la capa tiene que pedir la versión que la lee', () => {
  const CON = { ...PERFIL_TYCON, approvals: { relay_session: 'coordinadora' } };
  const viejo = JSON.stringify(capa(ORG.RESPONSE_SINCE));
  assert.ok(ORG.versionAtLeast(ORG.APPROVALS_SINCE, ORG.STACK_SINCE) && ORG.APPROVALS_SINCE !== ORG.STACK_SINCE);
  const bajo = ORG.teamProfileGateProblem({ layerText: viejo, versionImagen: '2026.10.15.48', doc: CON });
  assert.match(bajo, /todavía no se puede proponer/); assert.match(bajo, /approvals/); assert.ok(bajo.includes(`>= ${ORG.APPROVALS_SINCE}`), bajo);
  assert.strictEqual(ORG.teamProfileGateProblem({ layerText: JSON.stringify(capa(ORG.APPROVALS_SINCE)), versionImagen: '2026.10.15.48', doc: CON }), null);
  assert.strictEqual(ORG.teamProfileGateProblem({ layerText: viejo, versionImagen: '2026.10.15.48', doc: PERFIL_TYCON }), null, 'sin approvals, cualquier versión lee el perfil');
  // con el archivo actual, sólo frena si el pedido cambia approvals
  assert.strictEqual(ORG.teamProfileGateProblem({ layerText: viejo, versionImagen: '2026.10.15.48', doc: { ...CON, ado: { org: 'https://dev.azure.com/otra' } }, actual: CON }), null);
});

test('T1 OrgConfig_IntegrationsSection_EditsCodegraph @story-8.75 @ac-1 — CodeGraph se edita desde Integraciones, validado por el lector', () => {
  assert.ok(ORG.seccionPorId('integraciones').rutas.includes('integrations.codegraph'));
  const r = ORG.revisar({ seccion: 'integraciones', texto: ORG.formatJson(PERFIL_TYCON), borrador: { integrations: { codegraph: 'sí' } }, lectores: { 'harness-config': TC } });
  assert.deepStrictEqual(r.problems.map((p) => p.path), ['integrations.codegraph']);
});

test('T2 OrgConfig_TelegramText_PerMachine @story-8.75 @ac-2 — el texto dice que Telegram es de cada máquina, sin nombrar CodeGraph', () => {
  const { t } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  const es = t('es', 'pantalla.telegramSeConfigura');
  assert.match(es, /Telegram/);
  assert.doesNotMatch(es, /CodeGraph/);
  assert.match(ORG.pantalla(), /pantalla\.telegramSeConfigura/);
});

// ── los pedidos de vulnerabilidades ────────────────────────────────────────────────────────────────────────────────
// T16 y T17, los criterios de la sección; T16b y T17b, los casos de borde (comentarios con «_»,
// nombres con «key» dentro de una palabra, Severity que fija el pedido y el nombre repetido en el editor)

const WI_RIESGO = { type: 'Riesgo', fixed_fields: { 'Custom.Categoria': 'Seguridad', 'Custom.Probabilidad': 3 }, by_severity: { critical: { 'Custom.Impacto': 5 }, high: { 'Custom.Impacto': 4 }, moderate: { 'Custom.Impacto': 3 }, low: { 'Custom.Impacto': 2 } } };

test('T16 Config_SeccionPedidosMuestraTipoCamposYTabla_EsEn @story-4.9 @ac-10 — la sección muestra el tipo, los campos fijos y una fila por gravedad, en castellano y en inglés', async () => {
  // 🔴 rojo: la sección no existe, va en otra pestaña, le falta el tipo, un campo fijo o una gravedad, o no tiene su texto en inglés.
  const s = ORG.seccionPorId('pedidos');
  assert.ok(s, 'hay una sección de los pedidos de vulnerabilidades');
  assert.deepStrictEqual([s.titulo, s.archivo, s.repo, s.lector, s.claves, s.idCorto, s.necesita], ['Pedidos de vulnerabilidades', 'operations.json', 'operaciones', 'operations-config.js', ['work_items'], 'operations', ['work_items']]);
  assert.strictEqual(ORG.lectorSabe(OPS, s), true, 'el lector de hoy conoce la clave');
  assert.strictEqual(ORG.lectorSabe({ ...OPS, KEYS: OPS.KEYS.filter((k) => k !== 'work_items') }, s), false, 'uno anterior deja la sección en «todavía no sabe leer»');
  assert.match(pantallaEnCastellano(), /\['avisos', 'Avisos y la noche', \['canal', 'espera', 'umbrales', 'fichas', 'pedidos'\]/);
  for (const idioma of ['es', 'en']) {
    const sec = SEC('pedidos', { borrador: { work_items: WI_RIESGO } });
    const r = await pantallaConPestanas({ secciones: [...TODAS.map((id) => SEC(id)), sec], idioma, hash: '#seccion-pedidos' });
    assert.strictEqual((r.panelDe('seccion-pedidos') || { attrs: {} }).attrs.id, 'pestana-avisos', `${idioma}: en «Avisos y la noche»`);
    const caja = r.creados.filter((n) => n.attrs.id === 'seccion-pedidos').pop();
    const nodos = []; const walk = (x) => { nodos.push(x); (x.hijos || []).forEach(walk); }; walk(caja);
    const rutas = nodos.filter((n) => n.tag === 'input').map((n) => n.attrs['data-path']);
    for (const p of ['work_items.type', 'work_items.fixed_fields.Custom.Categoria', 'work_items.fixed_fields.Custom.Probabilidad']) assert.ok(rutas.includes(p), `${idioma}: el campo ${p}`);
    for (const g of OPS.SEVERITIES) assert.ok(rutas.includes(`work_items.by_severity.${g}.Custom.Impacto`), `${idioma}: la fila de ${g}`);
    const texto = nodos.map((n) => n.textContent || '').join(' | ');
    assert.match(texto, idioma === 'es' ? /Pedidos de vulnerabilidades/ : /Vulnerability work items/);
    assert.match(texto, idioma === 'es' ? /Crítica/ : /Critical/, `${idioma}: la gravedad dicha en el idioma`);
  }
  // el editor cambia el borrador con la forma del lector: renombrar una fila la mueve en las cuatro gravedades, un número va como número
  const sec = SEC('pedidos', { borrador: { work_items: JSON.parse(JSON.stringify(WI_RIESGO)) } });
  const r = await pantallaConPestanas({ secciones: [...TODAS.map((id) => SEC(id)), sec], hash: '#seccion-pedidos' });
  const ultimo = (pred) => { const caja = r.creados.filter((n) => n.attrs.id === 'seccion-pedidos').pop(); const out = []; const walk = (x) => { if (pred(x)) out.push(x); (x.hijos || []).forEach(walk); }; walk(caja); return out.pop(); };
  ultimo((n) => n.tag === 'input' && n.attrs['data-path'] === 'work_items.by_severity.high.Custom.Impacto').on.input({ target: { value: '5' } });
  ultimo((n) => n.tag === 'input' && n.attrs['data-path'] === 'work_items.campos.Custom.Impacto').on.input({ target: { value: 'Custom.Area' } });
  ultimo((n) => n.tag === 'button' && n.textContent === 'Revisar cambios').on.click();
  for (let i = 0; i < 10; i++) await new Promise((x) => setImmediate(x));
  const enviado = r.llamadas.filter((l) => /revisar/.test(l.ruta)).pop().cuerpo.borrador.work_items;
  assert.deepStrictEqual(enviado.fixed_fields, { 'Custom.Categoria': 'Seguridad', 'Custom.Probabilidad': 3 });
  assert.deepStrictEqual(enviado.by_severity, { critical: { 'Custom.Area': 5 }, high: { 'Custom.Area': 5 }, moderate: { 'Custom.Area': 3 }, low: { 'Custom.Area': 2 } });
});

test('T17 Config_CambioInvalidoMuestraElProblemaDelLector @story-4.9 @ac-11 — un cambio inválido da el problema del lector y no se propone; uno válido cambia sólo work_items', async () => {
  // 🔴 rojo: un campo que fija el pedido, un valor con «@» o una gravedad inventada pasan; el problema no se ve junto a su
  // campo; o un cambio válido toca otra parte de operations.json.
  const base = opsBase({ owners: { default: LEAD, by_project: { 'acme/Pagos': 'pagos@acme.example' } } });
  const rev = (work_items) => ORG.revisar({ seccion: 'pedidos', texto: ORG.formatJson(base), borrador: { work_items }, lectores: { 'operations-config.js': OPS } });
  for (const [wi, ruta] of [
    [{ fixed_fields: { 'System.Tags': 'x' } }, 'work_items.fixed_fields.System.Tags'],
    [{ fixed_fields: { 'Custom.Categoria': '@/etc/passwd' } }, 'work_items.fixed_fields.Custom.Categoria'],
    [{ by_severity: { urgente: { 'Custom.Impacto': 5 } } }, 'work_items.by_severity.urgente'],
    [{ type: 'Riesgo; rm' }, 'work_items.type'],
  ]) {
    const malo = rev(wi);
    assert.strictEqual(malo.ok, false, JSON.stringify(wi));
    assert.ok(malo.problems.some((p) => p.path === ruta), `${JSON.stringify(wi)} → ${ruta}: ${JSON.stringify(malo.problems)}`);
  }
  const bien = rev(WI_RIESGO);
  assert.strictEqual(bien.ok, true, JSON.stringify(bien.problems));
  assert.strictEqual(bien.texto, ORG.formatJson({ ...base, work_items: WI_RIESGO }), 'sólo work_items cambia');
  // la pantalla dibuja el problema junto a su campo y no ofrece proponer
  const problems = [{ path: 'work_items.fixed_fields.System.Tags', message: 'lo fija el pedido (su identidad, su asignación o su texto): la configuración no lo pisa' }];
  const p = await pantallaFalsa([SEC('pedidos', { borrador: { work_items: { fixed_fields: { 'System.Tags': 'x' } } }, problems })]);
  assert.strictEqual(p.error, null);
  assert.ok(p.textoDe('pedidos').includes(problems[0].message), 'el problema del lector se ve en la sección');
  const campoMalo = p.todo(p.sec('pedidos')).find((n) => n.tag === 'input' && n.attrs['data-path'] === 'work_items.fixed_fields.System.Tags');
  assert.strictEqual(campoMalo.attrs.class, 'bad', 'marcado en su campo');
  // en el sitio: la sección llega cargada desde operations.json, con la configuración como borrador
  const ops = clon({ 'operations.json': { ...base, work_items: WI_RIESGO } });
  await conPestana({ fuentes: fuentesCon({ ops }) }, async ({ h, entrar, token, escribir }) => {
    const lead = await entrar(LEAD); const tok = await token(lead);
    const s = (await h.pedir('/api/config', { cookie: lead })).json.secciones.find((x) => x.id === 'pedidos');
    assert.strictEqual(s.estado, 'cargado');
    assert.deepStrictEqual(s.borrador.work_items, WI_RIESGO);
    // el camino de pedido de siempre: lo inválido no pasa de «Revisar»; lo válido llega a «Proponer», que sin la
    // identidad de escritura del repo de operaciones se frena recién ahí
    const malo = (await escribir('/api/config/revisar', lead, tok, { seccion: 'pedidos', borrador: { work_items: { fixed_fields: { 'System.Tags': 'x' } } } })).json;
    assert.strictEqual(malo.ok, false);
    assert.ok(malo.problems.some((p) => p.path === 'work_items.fixed_fields.System.Tags'));
    const nuevo = { work_items: { ...WI_RIESGO, type: 'Bug' } };
    const ok = (await escribir('/api/config/revisar', lead, tok, { seccion: 'pedidos', borrador: nuevo })).json;
    assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));
    assert.deepStrictEqual(JSON.parse(ok.texto), { ...base, ...nuevo }, 'el resto de operations.json igual');
    const pr = (await escribir('/api/config/proponer', lead, tok, { seccion: 'pedidos', texto: ok.texto, oid: s.oid })).json;
    assert.match(pr.message, /sin identidad de escritura/);
  });
});

test('T17b Lector_WorkItems_ComentariosSecretosYGravedad @story-4.9 @ac-11 (pase adversarial) — un «_comentario» no es un campo, «Custom.Keyword» no es un secreto y Severity lo fija el pedido', () => {
  // 🔴 rojo: un comentario con un solo «_» invalida el archivo; un campo propio con «key» dentro de una palabra se toma
  // por secreto; o Severity se acepta y la noche lo pisa sin avisar.
  const doc = (work_items) => ({ version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] }, work_items });
  const probs = (wi) => OPS.parse(JSON.stringify(doc(wi))).problems.filter((p) => String(p.path).startsWith('work_items'));
  assert.deepStrictEqual(probs({ type: 'Bug', _comment: 'x', fixed_fields: { _comment: 'nota', 'Custom.A': 'v' }, by_severity: { _note: 'n', high: { _comment: 'y', 'Custom.B': 2 } } }), [], 'los comentarios con «_» se aceptan en las tres partes');
  assert.deepStrictEqual(probs({ fixed_fields: { 'Custom.Keyword': 'x', 'Custom.Monkey': 'y', 'Custom.Passage': 'z' } }), [], 'una palabra que contiene «key» o «sas» no es un secreto');
  for (const k of ['Custom.ApiKey', 'Custom.api_token', 'Custom.Secret', 'Custom.Password', 'Custom.apikey', 'Custom.authtoken', 'Custom.clientsecret', 'Custom.Pat']) assert.match((probs({ fixed_fields: { [k]: 'x' } })[0] || {}).message || '', /forma de secreto/, k);
  assert.match((probs({ fixed_fields: { 'Microsoft.VSTS.Common.Severity': '1 - Critical' } })[0] || {}).message || '', /lo fija el pedido/);
  assert.strictEqual(OPS.workItemFieldOk('Microsoft.VSTS.Common.Severity', '1 - Critical'), false, 'tampoco viaja al armar el pedido');
  assert.strictEqual(OPS.workItemFieldOk('_comment', 'nota'), false, 'un comentario no viaja');
  assert.strictEqual(OPS.workItemFieldOk('Custom.Keyword', 'x'), true);
});

test('T16b Editor_Pedidos_NombreRepetidoYVaciar @story-4.9 @ac-10 (pase adversarial) — renombrar una fila a un campo que ya está no lo pisa; vaciar todo saca work_items', async () => {
  // 🔴 rojo: al tipear el nombre de otra fila se pierde su valor sin aviso, renombrar no mueve el campo en todas las
  // gravedades, o vaciar deja «{}» en el archivo.
  const sec = SEC('pedidos', { borrador: { work_items: { fixed_fields: { 'Custom.A': 'uno' }, by_severity: { high: { 'Custom.B': 'dos', 'Custom.C': 'tres' }, low: { 'Custom.C': 'cuatro' } } } } });
  const r = await pantallaConPestanas({ secciones: [...TODAS.map((id) => SEC(id)), sec], hash: '#seccion-pedidos' });
  const caja = () => r.creados.filter((n) => n.attrs.id === 'seccion-pedidos').pop();
  const todos = () => { const out = []; const walk = (x) => { out.push(x); (x.hijos || []).forEach(walk); }; walk(caja()); return out; };
  const esperar = async () => { for (let i = 0; i < 10; i++) await new Promise((x) => setImmediate(x)); };
  const revisado = async () => { todos().filter((n) => n.tag === 'button' && n.textContent === 'Revisar cambios').pop().on.click(); await esperar(); return r.llamadas.filter((l) => /revisar/.test(l.ruta)).pop().cuerpo.borrador; };
  const nombreB = todos().find((n) => n.tag === 'input' && n.attrs['data-path'] === 'work_items.campos.Custom.B');
  nombreB.on.input({ target: { value: 'Custom.C' } });
  const aviso = todos().find((n) => n.attrs['data-path'] === 'work_items.campos.Custom.B.repetido');
  assert.match(aviso.textContent, /ya está en la lista/);
  assert.deepStrictEqual((await revisado()).work_items.by_severity, { high: { 'Custom.B': 'dos', 'Custom.C': 'tres' }, low: { 'Custom.C': 'cuatro' } }, 'ninguno se perdió');
  todos().find((n) => n.tag === 'input' && n.attrs['data-path'] === 'work_items.campos.Custom.C').on.input({ target: { value: 'Custom.D' } });
  const movido = (await revisado()).work_items.by_severity;
  assert.deepStrictEqual(movido, { high: { 'Custom.B': 'dos', 'Custom.D': 'tres' }, low: { 'Custom.D': 'cuatro' } }, 'la fila se renombra en las dos gravedades');
  assert.deepStrictEqual(Object.keys(movido.high), ['Custom.B', 'Custom.D'], 'en el mismo lugar');
  // quitar el campo fijo y las dos filas saca las partes y la clave entera
  for (let i = 0; i < 3; i++) { todos().filter((n) => n.tag === 'button' && n.attrs.title === 'Quitar')[0].on.click(); await esperar(); }
  assert.strictEqual((await revisado()).work_items, undefined, 'sin nada, sin work_items: cada proyecto con su elemento de backlog');
});

// ── la tabla de los pedidos: una fila por campo, una columna por gravedad, los valores para elegir ──
// el nombre para personas, los valores sin su símbolo de adelante, la caída sin las listas y quitar que se puede
// deshacer antes de guardar
const CAMPOS_RIESGO = [
  { referencia: 'Custom.Categoria', nombre: 'Categoría', valores: ['Calidad', 'Seguridad'] },
  { referencia: 'Custom.Probabilidad', nombre: 'Probabilidad', valores: ['1', '2', '3', '4', '5'] },
  { referencia: 'Custom.Impacto', nombre: 'Impacto', valores: ['1', '2', '3', '4', '5'] },
  { referencia: 'Custom.PrioridadDelRiesgo', nombre: 'Prioridad del riesgo', valores: ['🔴 Crítico (21-25)', '🟠 Alto (15-20)', '🟡 Medio (8-14)', '🟢 Bajo (1-7)'] },
  { referencia: 'Custom.Disparador', nombre: 'Disparador', valores: [] },
];
const WI_TABLA = { type: 'Riesgo', fixed_fields: { 'Custom.Categoria': 'Seguridad', 'Custom.Probabilidad': 3 }, by_severity: { critical: { 'Custom.Impacto': 5, 'Custom.PrioridadDelRiesgo': '🟠 Alto (15-20)' }, high: { 'Custom.Impacto': 4, 'Custom.PrioridadDelRiesgo': '🟡 Medio (8-14)' }, moderate: { 'Custom.Impacto': 3 }, low: { 'Custom.Impacto': 2, 'Custom.Disparador': 'una dependencia' } } };
const LISTAS_RIESGO = { '/api/config/tipos-de-pedido': () => ({ ok: true, tipos: ['Bug', 'Riesgo'] }), '/api/config/campos-de-pedido': () => ({ ok: true, proyecto: 'Ventas', campos: CAMPOS_RIESGO }) };
const GRAVEDADES_4 = ['critical', 'high', 'moderate', 'low'];
/** La sección de los pedidos sobre la pantalla de mentira, con las listas que contesta el sitio. */
async function tablaDePedidos(work_items, respuestas = LISTAS_RIESGO) {
  const p = await pantallaFalsa([SEC('pedidos', { titulo: 'Pedidos de vulnerabilidades', borrador: { work_items: JSON.parse(JSON.stringify(work_items)) } })], respuestas);
  const esperar = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  await esperar();
  const nodos = () => p.todo(p.sec('pedidos'));
  const en = (ruta) => nodos().filter((n) => n.attrs['data-path'] === ruta).pop();
  const boton = (etiqueta) => nodos().find((n) => n.tag === 'button' && n.attrs['aria-label'] === etiqueta);
  const opcionesDe = (n) => n.hijos.filter((o) => o.tag === 'option').map((o) => [o.attrs.value, o.textContent, o.attrs.selected === 'selected']);
  const revisado = async () => { await p.click('Revisar cambios', 'pedidos'); return p.pedidos.filter((x) => x.ruta === '/api/config/revisar').pop().cuerpo.borrador.work_items; };
  return { ...p, esperar, nodos, en, boton, opcionesDe, revisado };
}

test('T16d Tabla_UnaFilaPorCampo_DesplegablesConElGuardado @story-4.9 @ac-10 — con la lista, una fila por campo de las cuatro gravedades, y cada celda elige entre los valores del campo', async () => {
  // 🔴 rojo: vuelve la lista «Campo / Valor» por gravedad, una fila se repite o falta, la celda no es un desplegable o no
  // trae elegido lo guardado, o el campo se ve sólo con su nombre técnico.
  const t = await tablaDePedidos(WI_TABLA);
  assert.strictEqual(t.error, null);
  assert.deepStrictEqual(t.nodos().filter((n) => n.attrs['data-fila']).map((n) => n.attrs['data-fila']), ['Custom.Impacto', 'Custom.PrioridadDelRiesgo', 'Custom.Disparador'], 'una fila por campo, en el orden en que aparecen');
  for (const [g, v] of [['critical', '5'], ['high', '4'], ['moderate', '3'], ['low', '2']]) {
    const celda = t.en(`work_items.by_severity.${g}.Custom.Impacto`);
    assert.strictEqual(celda.tag, 'select', `${g}: un desplegable`);
    assert.deepStrictEqual(t.opcionesDe(celda).map((o) => o[0]), ['', '1', '2', '3', '4', '5'], `${g}: los valores del campo, y vacío para dejarla sin valor`);
    assert.deepStrictEqual(t.opcionesDe(celda).filter((o) => o[2]).map((o) => o[0]), [v], `${g}: elegido lo guardado`);
  }
  const texto = t.textoDe('pedidos');
  assert.match(texto, /Impacto \| Custom\.Impacto/, 'el nombre para personas y la referencia, en la celda del campo');
  assert.match(texto, /Campo \| Crítica \| Alta \| Media \| Baja/, 'las columnas de la tabla');
  assert.match(texto, /proyecto Ventas/, 'de dónde salen los valores');
  const tipo = t.en('work_items.type');
  assert.strictEqual(tipo.tag, 'select', 'el tipo se elige');
  assert.deepStrictEqual(t.opcionesDe(tipo).filter((o) => o[2]).map((o) => o[0]), ['Riesgo']);
  const fijo = t.en('work_items.fixed_fields.Custom.Categoria');
  assert.strictEqual(fijo.tag, 'select', 'un campo fijo con valores también se elige');
  assert.deepStrictEqual(t.opcionesDe(fijo).filter((o) => o[2]).map((o) => o[0]), ['Seguridad']);
  assert.match(texto, /Categoría \| · igual para todas/, 'el campo fijo con su nombre para personas');
  // «+ campo»: los campos del tipo que todavía no están en la tabla
  const nuevo = t.en('work_items.campos.nuevo');
  assert.deepStrictEqual(t.opcionesDe(nuevo).map((o) => o[0]), ['', 'Custom.Categoria', 'Custom.Probabilidad']);
  assert.strictEqual(t.opcionesDe(nuevo)[0][1], 'Elegí un campo del tipo Riesgo…');
  t.en('work_items.by_severity.high.Custom.Impacto').on.change({ target: { value: '5' } });
  assert.deepStrictEqual((await t.revisado()).by_severity.high, { 'Custom.Impacto': 5, 'Custom.PrioridadDelRiesgo': '🟡 Medio (8-14)' }, 'un número va como número');
});

test('T16e Tabla_EtiquetaSinCirculo_ValorExacto @story-4.9 @ac-10 — la opción se lee sin el símbolo de adelante y guarda el valor exacto, con el símbolo', async () => {
  // 🔴 rojo: el desplegable muestra el círculo de color, o guarda el valor limpio que la plataforma no acepta.
  const t = await tablaDePedidos(WI_TABLA);
  const celda = t.en('work_items.by_severity.critical.Custom.PrioridadDelRiesgo');
  assert.deepStrictEqual(t.opcionesDe(celda), [['', '—', false], ['🔴 Crítico (21-25)', 'Crítico (21-25)', false], ['🟠 Alto (15-20)', 'Alto (15-20)', true], ['🟡 Medio (8-14)', 'Medio (8-14)', false], ['🟢 Bajo (1-7)', 'Bajo (1-7)', false]]);
  assert.deepStrictEqual(t.opcionesDe(t.en('work_items.by_severity.low.Custom.Impacto')).map((o) => o[1]), ['—', '1', '2', '3', '4', '5'], 'un valor sin símbolo se lee igual');
  celda.on.change({ target: { value: '🔴 Crítico (21-25)' } });
  assert.strictEqual((await t.revisado()).by_severity.critical['Custom.PrioridadDelRiesgo'], '🔴 Crítico (21-25)', 'se guarda con el círculo');
  // un valor que es sólo un símbolo no queda sin etiqueta
  const solo = await tablaDePedidos({ type: 'Riesgo', by_severity: { high: { 'Custom.Marca': '★' } } }, { ...LISTAS_RIESGO, '/api/config/campos-de-pedido': () => ({ ok: true, proyecto: 'Ventas', campos: [{ referencia: 'Custom.Marca', nombre: 'Marca', valores: ['★', '☆'] }] }) });
  assert.deepStrictEqual(solo.opcionesDe(solo.en('work_items.by_severity.high.Custom.Marca')).map((o) => o[1]), ['—', '★', '☆']);
});

test('T16f Tabla_QuitarYAgregarFila_EnLasCuatroGravedades @story-4.9 @ac-10 — la ✕ saca el campo de las cuatro gravedades; «+ campo» lo agrega en las cuatro sin proponer un valor vacío', async () => {
  // 🔴 rojo: la ✕ es una barra a lo ancho o deja el campo en alguna gravedad, «+ campo» lo agrega en una sola, o un
  // valor vacío pasa el revisar.
  const t = await tablaDePedidos(WI_TABLA);
  const x = t.boton('Quitar Prioridad del riesgo');
  assert.ok(x, 'la ✕ de la fila, con el nombre del campo');
  assert.strictEqual(x.attrs.class, 'quitar-fila', 'la ✕ chica, no una barra');
  x.on.click({}); await t.esperar();
  let enviado = await t.revisado();
  for (const g of GRAVEDADES_4) assert.ok(!Object.prototype.hasOwnProperty.call(enviado.by_severity[g] || {}, 'Custom.PrioridadDelRiesgo'), `${g}: sin el campo`);
  assert.deepStrictEqual(enviado.by_severity.critical, { 'Custom.Impacto': 5 }, 'lo demás queda');
  t.en('work_items.campos.nuevo').on.change({ target: { value: 'Custom.Probabilidad' } }); await t.esperar();
  for (const g of GRAVEDADES_4) {
    const celda = t.en(`work_items.by_severity.${g}.Custom.Probabilidad`);
    assert.strictEqual(celda && celda.tag, 'select', `${g}: la celda nueva`);
    assert.deepStrictEqual(t.opcionesDe(celda)[0], ['', '—', true], `${g}: sin elegir todavía`);
  }
  enviado = await t.revisado();
  for (const g of GRAVEDADES_4) assert.strictEqual(enviado.by_severity[g]['Custom.Probabilidad'], '', `${g}: el campo nuevo`);
  const problemas = OPS.parse(JSON.stringify({ version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] }, work_items: enviado })).problems.map((p) => p.path);
  for (const g of GRAVEDADES_4) assert.ok(problemas.includes(`work_items.by_severity.${g}.Custom.Probabilidad`), `${g}: vacío no pasa el lector, así que no se propone`);
});

test('T16g Tabla_CampoSinValores_CampoDeTexto @story-4.9 @ac-10 — un campo sin valores permitidos se escribe en la celda', async () => {
  // 🔴 rojo: un campo sin valores fijos sale como desplegable vacío, o lo escrito no llega al borrador.
  const t = await tablaDePedidos(WI_TABLA);
  for (const g of GRAVEDADES_4) assert.strictEqual(t.en(`work_items.by_severity.${g}.Custom.Disparador`).tag, 'input', `${g}: se escribe`);
  assert.strictEqual(t.en('work_items.by_severity.low.Custom.Disparador').attrs.value, 'una dependencia');
  t.en('work_items.by_severity.critical.Custom.Disparador').on.input({ target: { value: 'un paquete' } });
  const enviado = await t.revisado();
  assert.strictEqual(enviado.by_severity.critical['Custom.Disparador'], 'un paquete');
  assert.strictEqual(enviado.by_severity.low['Custom.Disparador'], 'una dependencia');
  assert.match(t.textoDe('pedidos'), /Un campo sin valores fijos se escribe/);
});

test('T16h Tabla_SinLista_TextoAvisoYGuardadoIntacto @story-4.9 @ac-10 — sin las listas, campos de texto, el aviso con el motivo y lo guardado sin cambios', async () => {
  // 🔴 rojo: sin permiso desaparecen los campos o la tabla, no dice por qué, o revisar sin tocar nada cambia lo guardado.
  const sinPermiso = { ok: false, codigo: 'sin_permiso', message: 'el sitio no puede leer los tipos de pedido: falta su permiso de lectura de pedidos de trabajo' };
  const t = await tablaDePedidos(WI_TABLA, { '/api/config/tipos-de-pedido': () => sinPermiso });
  assert.strictEqual(t.error, null);
  assert.ok(!t.nodos().some((n) => n.tag === 'select' || n.tag === 'datalist'), 'sin listas, todo se escribe');
  assert.strictEqual(t.en('work_items.type').attrs.value, 'Riesgo');
  assert.strictEqual(t.en('work_items.fixed_fields.Custom.Categoria').attrs.value, 'Seguridad');
  assert.strictEqual(t.en('work_items.campos.Custom.Impacto').attrs.value, 'Custom.Impacto', 'la celda del campo es su referencia, para escribir');
  for (const g of GRAVEDADES_4) assert.strictEqual(t.en(`work_items.by_severity.${g}.Custom.Impacto`).tag, 'input');
  const aviso = t.nodos().find((n) => n.attrs.class === 'aviso-listas');
  assert.ok(aviso, 'el aviso de arriba');
  assert.match(t.textoDe('pedidos'), /Sin las listas de la plataforma: el sitio no puede leer los tipos de pedido: falta su permiso de lectura de pedidos de trabajo\. Podés escribir los nombres y los valores; se validan al revisar\./);
  assert.ok(t.nodos().some((n) => n.tag === 'button' && n.textContent === '+ campo'), '«+ campo» también sin lista');
  assert.deepStrictEqual(await t.revisado(), WI_TABLA, 'lo guardado, intacto');
});

test('T16i Quitar_SeDeshace_AntesDeGuardar @story-4.9 @ac-10 — quitar un campo fijo o una fila avisa y se deshace, con su valor', async () => {
  // 🔴 rojo: la ✕ borra sin aviso, o «Deshacer» no devuelve el campo con sus valores.
  const t = await tablaDePedidos(WI_TABLA);
  const x = t.boton('Quitar Categoría');
  assert.ok(x, 'el campo fijo también tiene su ✕');
  x.on.click({}); await t.esperar();
  assert.ok(!t.en('work_items.fixed_fields.Custom.Categoria'), 'ya no está');
  assert.match(t.textoDe('pedidos'), /Quitaste Categoría\./, 'lo dice');
  await t.click('Deshacer', 'pedidos');
  assert.ok(t.en('work_items.fixed_fields.Custom.Categoria'), 'volvió');
  assert.doesNotMatch(t.textoDe('pedidos'), /Quitaste/);
  assert.deepStrictEqual((await t.revisado()).fixed_fields, WI_TABLA.fixed_fields, 'con su valor');
  t.boton('Quitar Impacto').on.click({}); await t.esperar();
  assert.match(t.textoDe('pedidos'), /Quitaste Impacto\./);
  await t.click('Deshacer', 'pedidos');
  assert.deepStrictEqual((await t.revisado()).by_severity, WI_TABLA.by_severity, 'la fila vuelve con sus cuatro valores');
});

// los bordes de la tabla: signos en las etiquetas, valores que parecen números, el orden al deshacer, los campos que
// fija el pedido y la celda vacía
const conCampos = (campos) => ({ ...LISTAS_RIESGO, '/api/config/campos-de-pedido': () => ({ ok: true, proyecto: 'Ventas', campos }) });

test('T16j Tabla_EtiquetaSinElSimboloSolo_SinChoques @story-4.9 @ac-10 (pase adversarial) — sólo se limpia el símbolo de adelante, y dos valores que se leerían igual se muestran enteros', async () => {
  // 🔴 rojo: «-1» se lee «1» (y se confunde con el 1), «(ninguno)» pierde su paréntesis, o dos valores distintos quedan
  // con la misma etiqueta.
  const t = await tablaDePedidos({ type: 'Riesgo', by_severity: { high: { 'Custom.Delta': '-1', 'Custom.Nivel': '🔴 Alto' } } }, conCampos([
    { referencia: 'Custom.Delta', nombre: 'Delta', valores: ['-1', '0', '1', '(ninguno)', '¿Sí?'] },
    { referencia: 'Custom.Nivel', nombre: 'Nivel', valores: ['🔴 Alto', '🟠 Alto', '🟢 Bajo'] },
  ]));
  const etiquetas = (ruta) => t.opcionesDe(t.en(ruta)).filter((o) => o[0] !== '').map((o) => o[1]);
  assert.deepStrictEqual(etiquetas('work_items.by_severity.high.Custom.Delta'), ['-1', '0', '1', '(ninguno)', '¿Sí?'], 'los signos y la puntuación quedan');
  assert.deepStrictEqual(etiquetas('work_items.by_severity.high.Custom.Nivel'), ['🔴 Alto', '🟠 Alto', 'Bajo'], 'sin el círculo se leerían igual: van enteros');
});

test('T16k Tabla_ValorElegido_SeGuardaExacto @story-4.9 @ac-10 (pase adversarial) — lo que parece número se guarda como número sólo si se escribe igual', async () => {
  // 🔴 rojo: «007» se guarda 7 o «1.10» se guarda 1.1, en el desplegable o escrito a mano.
  const t = await tablaDePedidos({ type: 'Riesgo', by_severity: { high: { 'Custom.Codigo': '1.10', 'Custom.Impacto': 4, 'Custom.Disparador': 'x' } } }, conCampos([
    { referencia: 'Custom.Codigo', nombre: 'Código', valores: ['007', '1.10', '5'] },
    { referencia: 'Custom.Impacto', nombre: 'Impacto', valores: ['1', '2', '3', '4', '5'] },
    { referencia: 'Custom.Disparador', nombre: 'Disparador', valores: [] },
  ]));
  assert.deepStrictEqual(t.opcionesDe(t.en('work_items.by_severity.high.Custom.Codigo')).filter((o) => o[2]).map((o) => o[0]), ['1.10'], 'elegido lo guardado, tal cual');
  t.en('work_items.by_severity.high.Custom.Codigo').on.change({ target: { value: '007' } });
  t.en('work_items.by_severity.high.Custom.Impacto').on.change({ target: { value: '5' } });
  t.en('work_items.by_severity.high.Custom.Disparador').on.input({ target: { value: '0012' } });
  assert.deepStrictEqual((await t.revisado()).by_severity.high, { 'Custom.Codigo': '007', 'Custom.Impacto': 5, 'Custom.Disparador': '0012' });
});

test('T16l Deshacer_DevuelveElOrden_YSeApagaConOtroCambio @story-4.9 @ac-10 (pase adversarial) — deshacer deja el borrador como estaba; otro cambio en el medio apaga el deshacer', async () => {
  // 🔴 rojo: el campo vuelve al final (el archivo cambia de orden sin que nadie lo pida), o «Deshacer» después de otro
  // cambio pisa lo nuevo sin avisar.
  const t = await tablaDePedidos(WI_TABLA);
  t.boton('Quitar Categoría').on.click({}); await t.esperar();
  await t.click('Deshacer', 'pedidos');
  let enviado = await t.revisado();
  assert.deepStrictEqual(Object.keys(enviado.fixed_fields), ['Custom.Categoria', 'Custom.Probabilidad'], 'en su lugar');
  t.boton('Quitar Impacto').on.click({}); await t.esperar();
  await t.click('Deshacer', 'pedidos');
  enviado = await t.revisado();
  assert.deepStrictEqual(Object.keys(enviado.by_severity.critical), ['Custom.Impacto', 'Custom.PrioridadDelRiesgo'], 'la fila en su lugar');
  assert.deepStrictEqual(t.nodos().filter((n) => n.attrs['data-fila']).map((n) => n.attrs['data-fila']), ['Custom.Impacto', 'Custom.PrioridadDelRiesgo', 'Custom.Disparador']);
  // quitar, cambiar otra cosa y recién ahí deshacer: el deshacer ya no está
  t.boton('Quitar Prioridad del riesgo').on.click({}); await t.esperar();
  const aviso = t.nodos().find((n) => n.attrs.class === 'deshacer');
  t.en('work_items.by_severity.high.Custom.Impacto').on.change({ target: { value: '1' } });
  assert.strictEqual(aviso.attrs.hidden, 'hidden', 'el aviso se apaga con el otro cambio');
  aviso.hijos.find((n) => n.tag === 'button').on.click({}); await t.esperar();
  enviado = await t.revisado();
  assert.strictEqual(enviado.by_severity.high['Custom.Impacto'], 1, 'el otro cambio queda');
  assert.ok(!Object.prototype.hasOwnProperty.call(enviado.by_severity.critical, 'Custom.PrioridadDelRiesgo'), 'y lo quitado no vuelve por un deshacer viejo');
});

test('T16m Agregar_NoOfreceLosCamposQueFijaElPedido @story-4.9 @ac-10 (pase adversarial) — «+ campo» y «+ campo fijo» no ofrecen lo que el lector siempre rechaza', async () => {
  // 🔴 rojo: se puede elegir el título, las etiquetas, la asignación o la gravedad, que el lector rechaza después.
  const t = await tablaDePedidos({ type: 'Riesgo' }, conCampos([...CAMPOS_RIESGO,
    { referencia: 'System.Title', nombre: 'Title', valores: [] }, { referencia: 'System.Tags', nombre: 'Tags', valores: [] },
    { referencia: 'System.AssignedTo', nombre: 'Assigned To', valores: [] }, { referencia: 'Microsoft.VSTS.Common.Severity', nombre: 'Severity', valores: ['1 - Critical'] }]));
  for (const ruta of ['work_items.campos.nuevo', 'work_items.fijos.nuevo']) {
    const ofrecidos = t.opcionesDe(t.en(ruta)).map((o) => o[0]).filter(Boolean);
    assert.deepStrictEqual(ofrecidos, CAMPOS_RIESGO.map((c) => c.referencia), `${ruta}: sólo los que se pueden configurar`);
  }
});

test('T16n Celda_SeVaciaSoloEnSuGravedad @story-4.9 @ac-10 (pase adversarial) — una celda con valor se puede vaciar, y el campo sigue en las otras gravedades', async () => {
  // 🔴 rojo: el desplegable no ofrece dejar la celda sin valor, o vaciarla saca el campo de toda la tabla.
  const t = await tablaDePedidos(WI_TABLA);
  const celda = t.en('work_items.by_severity.moderate.Custom.Impacto');
  assert.deepStrictEqual(t.opcionesDe(celda)[0], ['', '—', false], 'la opción de dejarla sin valor');
  celda.on.change({ target: { value: '' } });
  const enviado = await t.revisado();
  assert.ok(!enviado.by_severity.moderate, 'la gravedad que queda sin campos se saca');
  assert.deepStrictEqual(enviado.by_severity.critical, WI_TABLA.by_severity.critical, 'las demás, igual');
  assert.ok(t.en('work_items.by_severity.moderate.Custom.Impacto'), 'la fila sigue');
});

// ── los tipos de pedido y sus campos, leídos de la plataforma: para elegir, y sin lista se escribe ──
test('T18 Pedidos_LecturaDeTiposYCampos_ConPermisoSinPermisoYCaidas @story-4.9 @ac-10 — la misma forma con lista, sin permiso, sin red y con una respuesta ilegible', async () => {
  // 🔴 rojo: con permiso no da la lista (o trae tipos apagados o repetidos), un 401 no dice qué permiso falta, o una caída sale como lista vacía.
  const RP = require(path.join(ROOT, 'scripts', 'lib', 'repo-proposal.js'));
  const urls = [];
  const resp = (status, doc) => async (url) => { urls.push(String(url)); return new Response(typeof doc === 'string' ? doc : JSON.stringify(doc || {}), { status }); };
  const base = { org: 'acme', project: 'Ventas', token: 't', urlBase: { azure: 'http://az.example' } };
  const ok = await RP.tiposDePedido({ ...base, fetch: resp(200, { value: [{ name: 'Riesgo' }, { name: 'Bug' }, { name: 'Viejo', isDisabled: true }, { name: 'Bug' }, { nombre: 'roto' }] }) });
  assert.deepStrictEqual(ok, { ok: true, tipos: ['Bug', 'Riesgo'] });
  assert.match(urls[0], /^http:\/\/az\.example\/acme\/Ventas\/_apis\/wit\/workitemtypes\?api-version=7\.1$/);
  // los internos del proceso, que la plataforma declara en su categoría oculta, no se ofrecen
  const conOcultos = async (url) => new Response(JSON.stringify(/HiddenCategory/.test(String(url)) ? { workItemTypes: [{ name: 'Test Plan' }] } : { value: [{ name: 'Bug' }, { name: 'Test Plan' }] }), { status: 200 });
  assert.deepStrictEqual((await RP.tiposDePedido({ ...base, fetch: conOcultos })).tipos, ['Bug']);
  const sin = await RP.tiposDePedido({ ...base, fetch: resp(401) });
  assert.deepStrictEqual([sin.ok, sin.codigo], [false, 'sin_permiso']);
  assert.match(sin.message, /lectura de pedidos de trabajo/);
  assert.strictEqual((await RP.tiposDePedido({ ...base, token: null, fetch: resp(200) })).codigo, 'sin_permiso', 'sin credencial no pregunta');
  assert.strictEqual((await RP.tiposDePedido({ ...base, fetch: async () => { throw new Error('red'); } })).codigo, 'sin_respuesta');
  assert.strictEqual((await RP.tiposDePedido({ ...base, fetch: resp(200, 'no es json') })).codigo, 'sin_respuesta');
  assert.strictEqual((await RP.tiposDePedido({ ...base, fetch: resp(500) })).codigo, 'sin_respuesta');
  const campos = await RP.camposDelTipo({ ...base, tipo: 'Riesgo', fetch: resp(200, { value: [{ referenceName: 'Custom.Impacto', name: 'Impacto', allowedValues: [1, 2, '3'] }, { referenceName: 'System.Title', name: 'Title' }] }) });
  assert.deepStrictEqual(campos, { ok: true, campos: [{ referencia: 'Custom.Impacto', nombre: 'Impacto', valores: ['1', '2', '3'] }, { referencia: 'System.Title', nombre: 'Title', valores: [] }] });
  assert.match(urls[urls.length - 1], /\/workitemtypes\/Riesgo\/fields\?\$expand=allowedValues&api-version=7\.1$/);
  const noEsta = await RP.camposDelTipo({ ...base, tipo: 'Nada', fetch: resp(404) });
  assert.deepStrictEqual([noEsta.codigo, /no tiene el tipo de pedido Nada/.test(noEsta.message)], ['no_reconozco', true]);
  for (const tipo of ['', '..', 'a/b', 'a?b']) assert.strictEqual((await RP.camposDelTipo({ ...base, tipo, fetch: resp(200) })).codigo, 'no_reconozco', JSON.stringify(tipo));
});

test('T19 Pedidos_PantallaOfreceLasListas_YSinPermisoDejaEscribirConAviso @story-4.9 @ac-10 — los tipos, los campos y los valores para elegir; sin la lista, el campo de siempre y por qué', async () => {
  // 🔴 rojo: con la lista no hay opciones para elegir, o sin permiso el campo desaparece o no dice por qué.
  const sec = () => ({ id: 'pedidos', titulo: 'Pedidos de vulnerabilidades', repo: 'operaciones', estado: 'cargado', soloLectura: false, problems: [], avisos: [], borrador: { work_items: { type: 'Riesgo', fixed_fields: { 'Custom.Impacto': 3 } } } });
  const listas = { '/api/config/tipos-de-pedido': () => ({ ok: true, tipos: ['Bug', 'Riesgo'], sinLeer: [{ proyecto: 'Compras', message: 'x' }] }),
    '/api/config/campos-de-pedido': () => ({ ok: true, proyecto: 'Ventas', campos: [{ referencia: 'Custom.Impacto', nombre: 'Impacto', valores: ['1', '2', '3'] }, { referencia: 'System.Title', nombre: 'Title', valores: [] }] }) };
  const con = await pantallaFalsa([sec()], listas);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const nodos = con.todo(con.sec('pedidos'));
  const valores = (ruta) => (nodos.find((n) => n.tag === 'select' && n.attrs['data-path'] === ruta) || { hijos: [] }).hijos.map((o) => o.attrs.value);
  assert.deepStrictEqual(valores('work_items.type'), ['', 'Bug', 'Riesgo'], 'los tipos para elegir, y vacío para el de cada proyecto');
  assert.deepStrictEqual(valores('work_items.campos.nuevo'), ['', 'Custom.Impacto'], 'los campos del tipo elegido, sin el título, que lo fija el pedido');
  assert.deepStrictEqual(valores('work_items.fixed_fields.Custom.Impacto'), ['1', '2', '3'], 'los valores permitidos del campo');
  assert.match(con.textoDe('pedidos'), /no incluye los de Compras/);
  assert.deepStrictEqual(con.pedidos.filter((x) => x.ruta === '/api/config/campos-de-pedido').map((x) => x.cuerpo), [{ tipo: 'Riesgo' }], 'los campos, una vez por tipo');
  const sinPermiso = { ok: false, codigo: 'sin_permiso', message: 'el sitio no puede leer los tipos de pedido: falta su permiso de lectura de pedidos de trabajo. Mientras tanto, escribí el nombre' };
  const sin = await pantallaFalsa([sec()], { '/api/config/tipos-de-pedido': () => sinPermiso });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const n2 = sin.todo(sin.sec('pedidos'));
  const t2 = n2.find((n) => n.tag === 'input' && n.attrs['data-path'] === 'work_items.type');
  assert.ok(t2 && t2.attrs.value === 'Riesgo' && !t2.attrs.list, 'el campo de siempre, con lo guardado');
  assert.ok(!n2.some((n) => n.tag === 'datalist'), 'sin listas');
  assert.match(sin.textoDe('pedidos'), /Sin las listas de la plataforma: el sitio no puede leer los tipos de pedido/);
  assert.deepStrictEqual(sin.pedidos.filter((x) => x.ruta === '/api/config/campos-de-pedido'), [], 'sin tipos no pide campos');
});

test('T20 Pedidos_ElSitioLeeDeLosProyectosDeLosProductos_ConElTokenDeSoloLectura @story-4.9 @ac-10 — junta los tipos, dice el proyecto que no pudo leer, y sin permiso cae con el motivo', async () => {
  // 🔴 rojo: no lee de los proyectos de repos.json, pide con otra credencial, o un proyecto sin permiso tumba la lista entera.
  const http = require('http');
  const vistos = [];
  const az = http.createServer((req, res) => {
    vistos.push({ url: req.url, auth: req.headers.authorization });
    const m = /^\/acme\/([^/]+)\/_apis\/wit\/workitemtypes(\/[^/?]+\/fields)?\?/.exec(req.url);
    const proyecto = m && decodeURIComponent(m[1]);
    if (proyecto === 'Compras') { res.writeHead(401); return res.end(); }
    if (!m) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(m[2] ? { value: [{ referenceName: 'Custom.Impacto', name: 'Impacto', allowedValues: ['1', '2'] }] } : { value: proyecto === 'Ventas' ? [{ name: 'Riesgo' }, { name: 'Bug' }] : proyecto === 'Soporte Tecnico' ? [{ name: 'Bug' }, { name: 'Tarea' }] : [] }));
  });
  await new Promise((r) => az.listen(0, '127.0.0.1', r));
  const baseAz = `http://127.0.0.1:${az.address().port}`;
  try {
    const repos = { azure: { org: 'acme' }, repos: [{ producto: 'V', ado: 'Ventas/front' }, { producto: 'V', ado: 'Ventas/back' }, { producto: 'S', ado: 'Soporte%20Tecnico/app' }, { producto: 'C', ado: 'Compras/app' }, { producto: 'X', ado: 'Apagado/app', activo: false }] };
    const ops = clon({ 'operations.json': opsBase(), 'scripts/nightly/dependencies/repos.json': JSON.stringify(repos) });
    await conPestana({ fuentes: fuentesCon({ ops }), env: { SITE_PIPELINES_TOKEN: 'pip' }, opciones: { urlBase: { azure: baseAz } } }, async ({ entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      const t = (await escribir('/api/config/tipos-de-pedido', lead, tok, {})).json;
      assert.deepStrictEqual([t.ok, t.tipos], [true, ['Bug', 'Riesgo', 'Tarea']], JSON.stringify(t));
      assert.deepStrictEqual(t.sinLeer.map((x) => x.proyecto), ['Compras']);
      assert.ok(!vistos.some((v) => v.url.includes('/Apagado/')), 'un repo apagado no cuenta');
      assert.ok(vistos.every((v) => v.auth === `Basic ${Buffer.from(':pip').toString('base64')}`), 'con el token de sólo lectura');
      const c = (await escribir('/api/config/campos-de-pedido', lead, tok, { tipo: 'Riesgo' })).json;
      assert.deepStrictEqual([c.ok, c.proyecto, c.campos[0].valores], [true, 'Ventas', ['1', '2']]);
      const nada = (await escribir('/api/config/campos-de-pedido', lead, tok, { tipo: 'Inexistente' })).json;
      assert.match(nada.message, /ningún proyecto de los productos tiene el tipo de pedido Inexistente/);
    });
    vistos.length = 0;
    const soloCompras = clon({ 'operations.json': opsBase(), 'scripts/nightly/dependencies/repos.json': JSON.stringify({ azure: { org: 'acme' }, repos: [{ producto: 'C', ado: 'Compras/app' }] }) });
    await conPestana({ fuentes: fuentesCon({ ops: soloCompras }), env: { SITE_PIPELINES_TOKEN: 'pip' }, opciones: { urlBase: { azure: baseAz } } }, async ({ entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      const t = (await escribir('/api/config/tipos-de-pedido', lead, tok, {})).json;
      assert.deepStrictEqual([t.ok, t.codigo], [false, 'sin_permiso']);
      assert.match(t.message, /necesita lectura de pedidos de trabajo/);
    });
  } finally { await new Promise((r) => az.close(r)); }
});

test('T20b Pedidos_OrganizacionComoDireccion_SeLeeSuNombre @story-4.9 @ac-10 (tanda F) — repos.json guarda la organización como dirección, como la usa la noche: el sitio lee igual', async () => {
  // 🔴 rojo: con «https://dev.azure.com/acme» (la forma del archivo real) el sitio dice «falta la organización» y la
  // pantalla nunca recibe las listas: los campos se ven con su nombre técnico.
  const RP = require(path.join(ROOT, 'scripts', 'lib', 'repo-proposal.js'));
  const repos = (org) => ({ azure: { org }, repos: [{ producto: 'V', ado: 'Ventas/front' }] });
  for (const [org, nombre] of [['https://dev.azure.com/acme', 'acme'], ['https://dev.azure.com/acme/', 'acme'], ['https://acme.visualstudio.com', 'acme'], ['https://acme.visualstudio.com/', 'acme'], ['acme', 'acme']]) {
    assert.deepStrictEqual(RP.dondeLeerPedidos(repos(org)), { org: nombre, proyectos: ['Ventas'] }, org);
  }
  for (const org of ['https://dev.azure.com/', 'https://example.com/a/b', 'ftp://dev.azure.com/acme', 'no es/un nombre']) assert.strictEqual(RP.dondeLeerPedidos(repos(org)), null, `${org}: sin organización reconocible`);
  const urls = [];
  const r = await RP.tiposDePedido({ ...RP.dondeLeerPedidos(repos('https://dev.azure.com/acme')), project: 'Ventas', token: 't', urlBase: { azure: 'http://az.example' }, fetch: async (u) => { urls.push(String(u)); return new Response(JSON.stringify({ value: [{ name: 'Riesgo' }] }), { status: 200 }); } });
  assert.deepStrictEqual(r, { ok: true, tipos: ['Riesgo'] });
  assert.match(urls[0], /^http:\/\/az\.example\/acme\/Ventas\/_apis\/wit\/workitemtypes\?/);
});

test('T20c Pedidos_OrganizacionNoReconocida_LoDice @story-4.9 @ac-10 (tanda F, revisor de fallas silenciosas) — una organización mal escrita no se confunde con «no hay productos»', async () => {
  // 🔴 rojo: con azure.org mal escrita el sitio dice «no hay productos con su proyecto declarado», y quien mantiene busca
  // el error en la lista de productos en vez de en la organización.
  const RP = require(path.join(ROOT, 'scripts', 'lib', 'repo-proposal.js'));
  const repos = (org, lista = [{ producto: 'V', ado: 'Ventas/front' }]) => ({ azure: org === undefined ? undefined : { org }, repos: lista });
  assert.strictEqual(RP.porQueNoSeLeenPedidos(repos('https://dev.azure.com/')), 'organizacion');
  assert.strictEqual(RP.porQueNoSeLeenPedidos(repos(undefined)), 'organizacion');
  assert.strictEqual(RP.porQueNoSeLeenPedidos(repos('acme', [])), 'proyectos');
  assert.strictEqual(RP.porQueNoSeLeenPedidos(null), 'proyectos', 'sin repos.json, lo de siempre');
  for (const [doc, esperado] of [[repos('https://example.com/a/b'), /la organización declarada en repos\.json/], [repos('acme', []), /no hay productos con su proyecto declarado/]]) {
    const ops = clon({ 'operations.json': opsBase(), 'scripts/nightly/dependencies/repos.json': JSON.stringify(doc) });
    await conPestana({ fuentes: fuentesCon({ ops }), env: { SITE_PIPELINES_TOKEN: 'pip' }, opciones: { urlBase: { azure: 'http://127.0.0.1:9' } } }, async ({ entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      for (const ruta of ['/api/config/tipos-de-pedido', '/api/config/campos-de-pedido']) {
        const r = (await escribir(ruta, lead, tok, { tipo: 'Riesgo' })).json;
        assert.strictEqual(r.ok, false, ruta);
        assert.match(r.message, esperado, `${ruta}: ${r.message}`);
      }
    });
  }
});

// ── los niveles de modelo en la pantalla ────────────────────────────────────────────────────────────────
const NIVELES_ES = ['económico', 'equilibrado', 'potente', 'máximo'];
const EQUIV = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'equivalences.json'), 'utf8')).models;
const secNiveles = (models, extras = {}) => ({ ...secModelos(models), extras: { ...secModelos(models).extras, equivalencias: EQUIV, ...extras } });
const opcionesDe = (p, n) => p.todo(n).filter((x) => x.tag === 'option');

test('T8 Modelos_SelectoresConNiveles @story-2.70 @ac-6', async () => {
  const p = await compacta(secNiveles(enNiveles(MODELOS_2)));
  const selectores = p.todo(p.sec('modelos')).filter((n) => n.tag === 'select' && !/fable_question/.test(String(n.attrs['data-path'] || '')) && n.attrs['aria-label'] !== 'Revisor');
  assert.ok(selectores.length >= 10, `${selectores.length} selectores de modelo`);
  for (const sel of selectores) {
    const ops = opcionesDe(p, sel).filter((o) => o.attrs.value !== '');
    assert.deepStrictEqual(ops.map((o) => o.attrs.value), MOD_JS.LEVELS, `${sel.attrs['data-path']}: los cuatro niveles, en el archivo sin tilde`);
    assert.deepStrictEqual(ops.map((o) => o.textContent), NIVELES_ES, `${sel.attrs['data-path']}: en pantalla con tilde`);
  }
  assert.ok(selectores.some((s) => s.attrs['data-path'] === 'models.ceiling'), 'el del tope incluido');
  // «Por defecto» en niveles: ningún renglón muestra un nombre de Claude en esa columna
  for (const fila of p.tablas().flatMap((t) => p.renglones(t))) {
    const hoy = p.de(fila, 'hoy')[0].textContent;
    assert.doesNotMatch(hoy, /^(haiku|sonnet|opus|fable)$/, p.texto(fila));
  }
  const { t } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  assert.deepStrictEqual(MOD_JS.LEVELS.map((n) => t('en', `pantalla.nivel.${n}`)), ['economy', 'balanced', 'strong', 'max']);
});

test('Modelos_PreguntarAntesDelNivelMaximo_GenericoConSuEquivalencia — la fila no nombra un modelo; la equivalencia del máximo va al costado y no cambia con la respuesta', async () => {
  // 🔴 rojo: la etiqueta vuelve a nombrar un modelo, o la fila no dice a qué modelo equivale el nivel máximo.
  const p = await compacta(secNiveles({ reviewers: 'balanced' }));
  const fila = p.tablas().map((t) => p.renglones(t)).flat().find((r) => p.todo(r).some((n) => n.textContent === 'Preguntar antes de usar el nivel máximo'));
  assert.ok(fila, 'la fila, con su etiqueta genérica');
  const equiv = () => p.todo(fila).filter((n) => /\bequiv\b/.test(n.attrs.class || '')).map((n) => n.textContent);
  assert.deepStrictEqual(equiv(), [`Claude: fable · Codex: ${EQUIV.fable}`]);
  p.todo(fila).find((n) => n.tag === 'select').on.change({ target: { value: 'never' } }); await p.esperar();
  assert.deepStrictEqual(equiv(), [`Claude: fable · Codex: ${EQUIV.fable}`], 'responder «nunca» no la cambia');
  const { t } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  for (const idioma of ['es', 'en']) assert.doesNotMatch(t(idioma, 'pantalla.preguntarAntesDelNivelMaximo'), /fable/i, `${idioma}: sin el nombre de un modelo`);
});

test('T9 Modelos_EquivalenciasDebajo @story-2.70 @ac-7', async () => {
  const lineas = (p) => p.de(p.sec('modelos'), 'equiv').map((n) => n.textContent);
  let p = await compacta(secNiveles({ reviewers: 'balanced' }));
  assert.ok(lineas(p).includes('Claude: sonnet · Codex: gpt-5.6-luna'), lineas(p).join('\n'));
  // cambiar el selector cambia la línea
  const sel = p.todo(p.renglones(p.tablas()[0])[0]).find((n) => n.tag === 'select');
  sel.on.change({ target: { value: 'max' } }); await p.esperar();
  assert.ok(lineas(p).includes(`Claude: fable · Codex: ${EQUIV.fable}`), lineas(p).join('\n'));
  // un árbol sin la equivalencia (o sin el archivo): «sin equivalencia en este árbol»
  p = await compacta(secNiveles({ reviewers: 'balanced' }, { equivalencias: { opus: 'gpt-x' } }));
  assert.ok(lineas(p).includes('Claude: sonnet · Codex: sin equivalencia en este árbol'), lineas(p).join('\n'));
  p = await compacta(secNiveles({ reviewers: 'balanced' }, { equivalencias: null }));
  assert.ok(lineas(p).includes('Claude: sonnet · Codex: sin equivalencia en este árbol'));
  // un archivo que está pero no se lee no se confunde con uno que falta: la línea dice por qué (fallas silenciosas)
  const roto = tmp('site-config-equiv-roto-');
  fs.mkdirSync(path.join(roto, 'build'), { recursive: true });
  fs.writeFileSync(path.join(roto, 'build', 'equivalences.json'), '{ roto');
  const leido = ORG.equivalenciasDe(roto);
  assert.strictEqual(leido.equivalencias, null);
  assert.match(leido.motivo, /^no pude leer las equivalencias de este árbol \(/);
  assert.deepStrictEqual(ORG.equivalenciasDe(tmp('site-config-sin-equiv-')), { equivalencias: null, motivo: null }, 'sin el archivo: sin motivo');
  p = await compacta(secNiveles({ reviewers: 'balanced' }, { equivalencias: null, motivoEquivalencias: leido.motivo }));
  assert.ok(lineas(p).some((l) => l.startsWith('Claude: sonnet · Codex: no pude leer las equivalencias de este árbol (')), lineas(p).join('\n'));
  // el servidor las lee de build/equivalences.json del árbol que sirve el sitio
  await conPerfil({ repos: { ...TR_BASE, models: { reviewers: 'balanced' } }, layer: capa(ORG.MODEL_LEVELS_SINCE) }, async ({ seccion }) => {
    const v = await seccion('modelos');
    assert.deepStrictEqual(v.extras.equivalencias, EQUIV);
  });
});

test('T10 Modelos_LoViejoSeProponeComoNivel @story-2.70 @ac-8', async () => {
  const viejo = { reviewers: 'sonnet', adversarial: { heavy: 'opus', fable_question: 'never' } };
  await conPerfil({ repos: { ...TR_BASE, models: viejo }, layer: capa(ORG.MODEL_LEVELS_SINCE) }, async ({ seccion, revisar }) => {
    const v = await seccion('modelos');
    assert.deepStrictEqual(v.borrador.models, { reviewers: 'balanced', adversarial: { heavy: 'strong', fable_question: 'never' } }, 'se ve en niveles');
    const p = await compacta(v);
    const val = (ruta) => p.todo(p.sec('modelos')).find((n) => n.tag === 'select' && n.attrs['data-path'] === ruta).value;
    assert.deepStrictEqual([val('models.reviewers'), val('models.adversarial.heavy')], ['balanced', 'strong']);
    // cambiar una clave: las otras viajan como nivel
    p.todo(p.sec('modelos')).find((n) => n.tag === 'select' && n.attrs['data-path'] === 'models.helpers').on.change({ target: { value: 'economy' } });
    const propuesto = (await p.revisado()).models;
    assert.deepStrictEqual(propuesto, { reviewers: 'balanced', adversarial: { heavy: 'strong', fable_question: 'never' }, helpers: 'economy' });
    const r = await revisar('modelos', { models: propuesto });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
    assert.deepStrictEqual(JSON.parse(r.texto).models, propuesto, 'el archivo propuesto lleva niveles');
  });
  // sin tocar nada, lo que viaja es lo cargado, sin cambios (el original del servidor ya está en niveles)
  const p = await compacta(secNiveles(enNiveles(viejo)));
  assert.deepStrictEqual((await p.revisado()).models, enNiveles(viejo));
});

test('T11 Modelos_TopeSigueFrenando @story-2.70 @ac-9', () => {
  const TEAM = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
  const r = ORG.revisar({ seccion: 'modelos', texto: ORG.formatJson(TR_BASE), borrador: { models: { mandatory_ceiling: true, ceiling: 'balanced', reviewers: 'strong' } }, lectores: { 'team-repos.js': TEAM } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.texto, null);
  assert.deepStrictEqual(r.problems.map((x) => x.path), ['models.reviewers']);
  assert.match(r.problems[0].message, /balanced/);
  assert.doesNotMatch(r.problems[0].message, /sonnet|opus/);
});

test('T13 Modelos_NivelesPidenSuVersion @story-2.70 @ac-11', async () => {
  assert.ok(ORG.versionAtLeast(ORG.MODEL_LEVELS_SINCE, ORG.MODELS_SINCE), 'la de los niveles es posterior');
  assert.notStrictEqual(ORG.MODEL_LEVELS_SINCE, ORG.MODELS_SINCE);
  assert.strictEqual(ORG.versionQuePide({ ...TR_BASE, models: { reviewers: 'sonnet' } }).version, ORG.MODELS_SINCE, 'con nombres, la de siempre');
  assert.strictEqual(ORG.versionQuePide({ ...TR_BASE, models: { reviewers: 'balanced' } }).version, ORG.MODEL_LEVELS_SINCE);
  assert.strictEqual(ORG.versionQuePide({ ...TR_BASE, models: { session: { heavy: 'max' } } }).version, ORG.MODEL_LEVELS_SINCE, 'un nivel adentro de un objeto');
  assert.match(String(ORG.profileGateProblem(JSON.stringify(capa(ORG.MODELS_SINCE)), { ...TR_BASE, models: { reviewers: 'balanced' } })), new RegExp(ORG.MODEL_LEVELS_SINCE.replace(/\./g, '\\.')));
  assert.strictEqual(ORG.profileGateProblem(JSON.stringify(capa(ORG.MODEL_LEVELS_SINCE)), { ...TR_BASE, models: { reviewers: 'balanced' } }), null);
  assert.strictEqual(ORG.profileGateProblem(JSON.stringify(capa(ORG.MODELS_SINCE)), { ...TR_BASE, models: { reviewers: 'sonnet' } }), null);
  // un comentario cuyo texto es un nivel no es un nivel: ni pide la versión ni se traduce
  assert.strictEqual(ORG.versionQuePide({ ...TR_BASE, models: { _nota: 'economy', reviewers: 'haiku' } }).version, ORG.MODELS_SINCE);
  const TEAM = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
  assert.deepStrictEqual(ORG.modelosEnNiveles({ _nota: 'opus', helpers: 'haiku' }, TEAM), { _nota: 'opus', helpers: 'economy' });
});

// ── la herramienta de horas se elige en Integraciones ────────────────────────────────────────────────────────────────
// Las opciones salen de los manifiestos de integrations/ del árbol (el servidor las manda en `extras.horas`); con
// Solidtime, la pantalla pide la URL de la instancia y dice el comando del token, que nunca pide.
const HORAS = [{ name: 'clockify', label: 'Clockify', url: false, token: null }, { name: 'solidtime', label: 'Solidtime', url: true, token: 'harness.js config set solidtime.token' }];
const secHoras = (i) => ({ ...secInteg(i), extras: { horas: HORAS } });

test('Config_TimeTrackingSelector_SavesKey @story-7.40 @ac-10', async () => {
  // el servidor manda las herramientas de los manifiestos del árbol
  await conEquipo({}, async ({ seccion }) => {
    const ex = (await seccion('integraciones')).extras;
    assert.deepStrictEqual(ex.horas.map((h) => [h.name, h.label, h.url]), [['clockify', 'Clockify', false], ['solidtime', 'Solidtime', true]]);
    assert.match(ex.horas[1].token, /harness\.js config set solidtime\.token/);
  });
  // la pantalla: el primer renglón es «Registro de horas», con Ninguno y las de los manifiestos
  let p = await compacta(secHoras(INTEG));
  const sel = () => p.todo(p.renglones(p.tablas()[0])[0]).find((n) => n.tag === 'select');
  assert.match(p.texto(p.renglones(p.tablas()[0])[0]), /Registro de horas/);
  assert.deepStrictEqual(sel().hijos.map((o) => o.attrs.value), ['', 'none', 'clockify', 'solidtime']);
  assert.strictEqual(sel().value, 'clockify', 'la llave vieja prendida se muestra como Clockify');
  assert.ok(!p.todo(p.sec('integraciones')).some((n) => n.attrs['data-path'] === 'integrations.clockify'), 'ya no hay renglón de la llave vieja');
  // elegir Solidtime: aparece la URL, el comando del token, y ningún campo para el token
  sel().on.change({ target: { value: 'solidtime' } });
  const url = p.todo(p.sec('integraciones')).find((n) => n.tag === 'input' && n.attrs['data-path'] === 'integrations.solidtime.url');
  assert.ok(url, 'pide la URL de la instancia');
  assert.match(p.textoDe('integraciones'), /harness\.js config set solidtime\.token/);
  assert.ok(!p.todo(p.sec('integraciones')).some((n) => /token/i.test(String(n.attrs['data-path'] || ''))), 'nunca pide el token');
  url.on.input({ target: { value: 'https://horas.acme.example' } });
  const { clockify: _vieja, ...sinVieja } = INTEG;
  assert.deepStrictEqual((await p.revisado()).integrations, { ...sinVieja, timeTracking: 'solidtime', solidtime: { url: 'https://horas.acme.example' } }, 'la clave nueva y la URL; la llave vieja sale');
  // con la llave vieja apagada se muestra Ninguno; elegir Clockify no pide URL
  p = await compacta(secHoras({ ...INTEG, clockify: false }));
  assert.strictEqual(sel().value, 'none');
  sel().on.change({ target: { value: 'clockify' } });
  assert.ok(!p.todo(p.sec('integraciones')).some((n) => n.attrs['data-path'] === 'integrations.solidtime.url'));
  assert.deepStrictEqual((await p.revisado()).integrations, { ...sinVieja, timeTracking: 'clockify' });
  // el servidor: una URL sin https:// se rechaza; https y localhost pasan
  const rev = (doc) => ORG.revisar({ seccion: 'integraciones', texto: ORG.formatJson(PERFIL_TYCON), borrador: doc, lectores: { 'harness-config': TC } });
  const { clockify: _c, ...integSinVieja } = PERFIL_TYCON.integrations;
  assert.deepStrictEqual(rev({ integrations: { ...integSinVieja, timeTracking: 'solidtime', solidtime: { url: 'http://horas.acme.example' } } }).problems.map((x) => x.path), ['integrations.solidtime.url']);
  for (const u of ['https://horas.acme.example', 'http://localhost:8080']) {
    const r = rev({ integrations: { ...integSinVieja, timeTracking: 'solidtime', solidtime: { url: u } } });
    assert.strictEqual(r.ok, true, `${u}: ${JSON.stringify(r.problems)}`);
    assert.strictEqual(JSON.parse(r.texto).integrations.solidtime.url, u, 'la URL llega al archivo');
  }
  // las hojas de cada herramienta salen de su manifiesto: la de Solidtime es de la sección; una que nadie declara, no
  const integ = ORG.seccionPorId('integraciones');
  assert.deepStrictEqual(ORG.hojasAjenas(integ, { integrations: {} }, { integrations: { timeTracking: 'solidtime', solidtime: { url: 'https://h' } } }), []);
  assert.deepStrictEqual(ORG.hojasAjenas(integ, { integrations: {} }, { integrations: { acme: { url: 'https://h' } } }), ['integrations.acme.url']);
  // como la lee la máquina: un valor con mayúsculas o espacios se reconoce, y con Solidtime aparece su URL
  p = await compacta(secHoras({ ...INTEG, timeTracking: ' Solidtime ' }));
  assert.strictEqual(sel().value, 'solidtime');
  assert.ok(p.todo(p.sec('integraciones')).some((n) => n.attrs['data-path'] === 'integrations.solidtime.url'));
  // una herramienta que el perfil tiene y este sitio no ofrece se muestra dicha; los manifiestos rotos, también
  p = await compacta({ ...secInteg({ ...INTEG, timeTracking: 'harvest' }), extras: { horas: HORAS, horasProblemas: ['la integración acme tiene el manifiesto roto (x): no se ofrece'] } });
  assert.strictEqual(sel().value, 'harvest');
  assert.match(p.texto(p.renglones(p.tablas()[0])[0]), /harvest \(este sitio no la ofrece\)/);
  assert.match(p.textoDe('integraciones'), /acme tiene el manifiesto roto/);
});

test('Config_TimeTracking_RaisesRequiresAndDropsOldKey @story-7.40 @ac-10', { skip: SIN_BACKEND }, async () => {
  // la función: la capa sube a la versión que lee la clave nueva sólo cuando el pedido la cambia y la capa pide menos
  const antes = { integrations: { clockify: true } };
  const despues = { integrations: { timeTracking: 'solidtime' } };
  const sube = ORG.timeTrackingLayer({ layerText: JSON.stringify(capa(ORG.RESPONSE_SINCE)), actual: antes, doc: despues });
  assert.strictEqual(sube.archivo, 'team-layer.json');
  assert.deepStrictEqual(JSON.parse(sube.contenido).requires.harness, `>= ${ORG.TIME_TRACKING_SINCE}`);
  assert.strictEqual(ORG.TIME_TRACKING_SINCE, '2026.10.21.15', 'la versión que publicó la tanda A, la primera que lee integrations.timeTracking');
  assert.strictEqual(ORG.timeTrackingLayer({ layerText: JSON.stringify(capa(ORG.TIME_TRACKING_SINCE)), actual: antes, doc: despues }), null, 'ya pide lo suficiente');
  assert.strictEqual(ORG.timeTrackingLayer({ layerText: JSON.stringify(capa(ORG.RESPONSE_SINCE)), actual: despues, doc: despues }), null, 'no la cambia');
  assert.match(ORG.timeTrackingLayer({ layerText: '{ roto', actual: antes, doc: despues }).problema, /team-layer\.json/);
  // la capa con la marca de orden de bytes la lee como la máquina; la que no tiene la forma «>= x» no se pisa
  const conBom = ORG.timeTrackingLayer({ layerText: `﻿${JSON.stringify({ schema: 1, name: 'acme', ...capa(ORG.RESPONSE_SINCE) })}`, actual: antes, doc: despues });
  assert.deepStrictEqual(JSON.parse(conBom.contenido), { schema: 1, name: 'acme', requires: { harness: `>= ${ORG.TIME_TRACKING_SINCE}` } }, 'sube y conserva lo demás');
  assert.match(ORG.timeTrackingLayer({ layerText: JSON.stringify({ requires: { harness: '2026.10.01.1' } }), actual: antes, doc: despues }).problema, /no «>= versión»/);
  // sin capa ninguna máquina aplica el perfil: no hay versión que subir, y no se inventa una declaración incompleta
  assert.strictEqual(ORG.timeTrackingLayer({ layerText: null, actual: antes, doc: despues }), null);
  // prender o apagar otra integración no cambia la herramienta: el pedido no lee la capa
  assert.strictEqual(ORG.cambiaHoras({ actual: { integrations: { engram: true } }, doc: { integrations: { engram: false } } }), false);
  assert.strictEqual(ORG.cambiaHoras({ actual: antes, doc: despues }), true);
  // de punta a punta: el pedido al perfil lleva el perfil sin la llave vieja y la capa con la versión nueva
  const { arrancarAdoFalso } = require('./lib/fake-ado-api.js');
  let ado, r, dir;
  try {
    ado = await arrancarAdoFalso({ org: 'acme', project: 'Proy', repo: 'perfil' });
    ado.st.politicas = [{ isEnabled: true, isBlocking: true, type: { displayName: 'Minimum number of reviewers' }, settings: { minimumApproverCount: 1, creatorVoteCounts: false, scope: [{ refName: 'refs/heads/main', matchKind: 'Exact', repositoryId: ado.st.repoId }] } }];
    ({ r, dir } = await opsPorHttp({ 'team-profile.json': PERFIL_TYCON, 'team-layer.json': capa(ORG.RESPONSE_SINCE), 'team-repos.json': TR_BASE }));
    const remotos = { perfil: { platform: 'azure', org: 'acme', project: 'Proy', repo: 'perfil', web: 'https://dev.azure.com/acme/Proy/_git/perfil' } };
    await conPestana({ fuentes: fuentesCon({ ops: clon({ 'operations.json': opsBase() }), perfil: dir }), env: { ...PERFIL_ENV, SITE_PROFILE_WRITE_TOKEN: ESCRITURA }, opciones: { remotos, urlBase: { azure: ado.base } } }, async (ctx) => {
      const lead = await ctx.entrar(LEAD); const tok = await ctx.token(lead);
      const { clockify: _c, ...integSinVieja } = PERFIL_TYCON.integrations;
      const rev = (await ctx.escribir('/api/config/revisar', lead, tok, { seccion: 'integraciones', borrador: { integrations: { ...integSinVieja, timeTracking: 'clockify' } } })).json;
      assert.strictEqual(rev.ok, true, JSON.stringify(rev.problems));
      const s = (await ctx.h.pedir('/api/config', { cookie: lead })).json.secciones.find((x) => x.id === 'integraciones');
      const p = (await ctx.escribir('/api/config/proponer', lead, tok, { seccion: 'integraciones', texto: rev.texto, oid: s.oid })).json;
      assert.strictEqual(p.ok, true, JSON.stringify(p));
      const ref = ado.st.pedidos[0].sourceRefName;
      const perfil = JSON.parse(r.archivoEn(ref, 'team-profile.json'));
      assert.strictEqual(perfil.integrations.timeTracking, 'clockify');
      assert.ok(!('clockify' in perfil.integrations), 'la llave vieja salió del perfil');
      assert.strictEqual(JSON.parse(r.archivoEn(ref, 'team-layer.json')).requires.harness, `>= ${ORG.TIME_TRACKING_SINCE}`, 'y el mismo pedido sube la versión que pide el perfil');
    });
  } finally { await cerrarTodos(ado, r); }
});

test('T28 Config_NotifyChannels_NoSecrets @story-7.40 @ac-18', async () => {
  // la pantalla: el renglón «Avisos», sin declarar (Telegram, como hasta ahora), ninguno, o los canales tildados
  let p = await compacta(secHoras(INTEG));
  const avisos = () => p.renglones(p.tablas()[0]).find((r) => /Avisos/.test(p.texto(r)));
  const sel = () => p.todo(avisos()).find((n) => n.tag === 'select');
  assert.ok(avisos(), 'hay un renglón «Avisos» en Integraciones');
  assert.deepStrictEqual(sel().hijos.map((o) => o.attrs.value), ['', 'none', 'elegir']);
  assert.strictEqual(sel().value, '', 'sin la lista, «sin declarar»');
  sel().on.change({ target: { value: 'elegir' } });
  const tilde = (canal) => p.todo(p.sec('integraciones')).find((n) => n.tag === 'input' && n.attrs['data-path'] === `integrations.notify.channels.${canal}`);
  assert.deepStrictEqual(['telegram', 'slack', 'teams', 'mail'].map((c) => Boolean(tilde(c))), [true, true, true, true], 'los cuatro canales para tildar');
  tilde('slack').on.change({ target: { checked: true } });
  tilde('mail').on.change({ target: { checked: true } });
  tilde('telegram').on.change({ target: { checked: false } });
  const host = p.todo(p.sec('integraciones')).find((n) => n.tag === 'input' && n.attrs['data-path'] === 'integrations.notify.mail_host');
  const puerto = p.todo(p.sec('integraciones')).find((n) => n.tag === 'input' && n.attrs['data-path'] === 'integrations.notify.mail_port');
  assert.ok(host && puerto, 'con el correo, su servidor y su puerto');
  host.on.input({ target: { value: 'smtp.acme.example' } });
  puerto.on.input({ target: { value: '587' } });
  // ninguna credencial: la pantalla dice dónde va cada una y nunca la pide
  assert.match(p.textoDe('integraciones'), /harness\.js config set notify\.slack_webhook/);
  assert.match(p.textoDe('integraciones'), /TYCON_SLACK_WEBHOOK_URL/);
  assert.ok(!p.todo(p.sec('integraciones')).some((n) => n.tag === 'input' && /webhook|password|user|token|address|chat/i.test(String(n.attrs['data-path'] || ''))), 'nunca un campo de credencial');
  assert.deepStrictEqual((await p.revisado()).integrations.notify, { channels: ['slack', 'mail'], mail_host: 'smtp.acme.example', mail_port: 587 }, 'los canales y el servidor, en el perfil');
  // destildar el correo saca su servidor; «ninguno» es la lista vacía; «sin declarar» saca la clave
  tilde('mail').on.change({ target: { checked: false } });
  assert.deepStrictEqual((await p.revisado()).integrations.notify, { channels: ['slack'] });
  sel().on.change({ target: { value: 'none' } });
  assert.deepStrictEqual((await p.revisado()).integrations.notify, { channels: [] });
  sel().on.change({ target: { value: '' } });
  assert.ok(!('notify' in (await p.revisado()).integrations));
  // el servidor lo valida con el lector de la máquina: un canal inventado o un puerto que no es un número no pasan
  const rev = (notify) => ORG.revisar({ seccion: 'integraciones', texto: ORG.formatJson(PERFIL_TYCON), borrador: { integrations: { ...PERFIL_TYCON.integrations, notify } }, lectores: { 'harness-config': TC } });
  assert.strictEqual(rev({ channels: ['slack', 'mail'], mail_host: 'smtp.acme.example', mail_port: 587 }).ok, true);
  assert.deepStrictEqual(rev({ channels: ['paloma'] }).problems.map((x) => x.path), ['integrations.notify.channels']);
  assert.deepStrictEqual(rev({ channels: ['mail'], mail_port: 'x' }).problems.map((x) => x.path), ['integrations.notify.mail_port']);
  // la clave es de la sección: no es una hoja ajena
  assert.deepStrictEqual(ORG.hojasAjenas(ORG.seccionPorId('integraciones'), { integrations: {} }, { integrations: { notify: { channels: ['slack'] } } }), []);
});

test('T54 Config_NotifyChannels_RaisesRequires @story-7.40 @ac-18', { skip: SIN_BACKEND }, async () => {
  // la función: guardar los canales sube la capa a la versión que los lee; con la herramienta de horas, a la mayor
  const antes = { integrations: { engram: true } };
  const conAvisos = { integrations: { engram: true, notify: { channels: ['slack'] } } };
  assert.strictEqual(ORG.cambiaAvisos({ actual: antes, doc: conAvisos }), true);
  assert.strictEqual(ORG.cambiaLaCapa({ actual: { integrations: { engram: true } }, doc: { integrations: { engram: false } } }), false, 'otra integración no la toca');
  const sube = ORG.timeTrackingLayer({ layerText: JSON.stringify(capa(ORG.RESPONSE_SINCE)), actual: antes, doc: conAvisos });
  assert.strictEqual(JSON.parse(sube.contenido).requires.harness, `>= ${ORG.NOTIFY_SINCE}`);
  assert.strictEqual(ORG.NOTIFY_SINCE, '2026.10.21.52', 'la etiqueta del merge que trajo el lector de integrations.notify');
  assert.ok(ORG.versionAtLeast(ORG.NOTIFY_SINCE, ORG.TIME_TRACKING_SINCE), 'la versión que lee los avisos es posterior a la de las horas');
  const ambas = ORG.timeTrackingLayer({ layerText: JSON.stringify(capa(ORG.RESPONSE_SINCE)), actual: { integrations: { clockify: true } }, doc: { integrations: { timeTracking: 'solidtime', notify: { channels: [] } } } });
  assert.strictEqual(JSON.parse(ambas.contenido).requires.harness, `>= ${ORG.NOTIFY_SINCE}`, 'la mayor de las dos');
  assert.strictEqual(ORG.timeTrackingLayer({ layerText: JSON.stringify(capa(ORG.NOTIFY_SINCE)), actual: antes, doc: conAvisos }), null, 'ya pide lo suficiente');
  // de punta a punta: el pedido al perfil lleva los canales y la capa con la versión nueva
  const { arrancarAdoFalso } = require('./lib/fake-ado-api.js');
  let ado, r, dir;
  try {
    ado = await arrancarAdoFalso({ org: 'acme', project: 'Proy', repo: 'perfil' });
    ado.st.politicas = [{ isEnabled: true, isBlocking: true, type: { displayName: 'Minimum number of reviewers' }, settings: { minimumApproverCount: 1, creatorVoteCounts: false, scope: [{ refName: 'refs/heads/main', matchKind: 'Exact', repositoryId: ado.st.repoId }] } }];
    ({ r, dir } = await opsPorHttp({ 'team-profile.json': PERFIL_TYCON, 'team-layer.json': capa(ORG.RESPONSE_SINCE), 'team-repos.json': TR_BASE }));
    const remotos = { perfil: { platform: 'azure', org: 'acme', project: 'Proy', repo: 'perfil', web: 'https://dev.azure.com/acme/Proy/_git/perfil' } };
    await conPestana({ fuentes: fuentesCon({ ops: clon({ 'operations.json': opsBase() }), perfil: dir }), env: { ...PERFIL_ENV, SITE_PROFILE_WRITE_TOKEN: ESCRITURA }, opciones: { remotos, urlBase: { azure: ado.base } } }, async (ctx) => {
      const lead = await ctx.entrar(LEAD); const tok = await ctx.token(lead);
      const rev = (await ctx.escribir('/api/config/revisar', lead, tok, { seccion: 'integraciones', borrador: { integrations: { ...PERFIL_TYCON.integrations, notify: { channels: ['slack', 'mail'], mail_host: 'smtp.acme.example' } } } })).json;
      assert.strictEqual(rev.ok, true, JSON.stringify(rev.problems));
      const s = (await ctx.h.pedir('/api/config', { cookie: lead })).json.secciones.find((x) => x.id === 'integraciones');
      const pr = (await ctx.escribir('/api/config/proponer', lead, tok, { seccion: 'integraciones', texto: rev.texto, oid: s.oid })).json;
      assert.strictEqual(pr.ok, true, JSON.stringify(pr));
      const ref = ado.st.pedidos[0].sourceRefName;
      assert.deepStrictEqual(JSON.parse(r.archivoEn(ref, 'team-profile.json')).integrations.notify, { channels: ['slack', 'mail'], mail_host: 'smtp.acme.example' });
      assert.strictEqual(JSON.parse(r.archivoEn(ref, 'team-layer.json')).requires.harness, `>= ${ORG.NOTIFY_SINCE}`, 'y el mismo pedido sube la versión que pide el perfil');
    });
  } finally { await cerrarTodos(ado, r); }
});
