'use strict';
/*
 * site-propose.test.js — «Proponer» usable en la pestaña Configuración: la diferencia por renglones, el resumen, el envío
 * único con su marca y el pedido que se encuentra aunque la respuesta se corte.
 *
 * El servidor:
 *   T1  Diferencia_SoloLoQueCambia_ConContexto            T8  DobleClic_UnSoloPedido
 *   T2  Diferencia_ArchivoGrande_NoCuelga                 T12 Propuesta_TrasReinicio_PorLaMarca_AzureYGitHub
 *   T4  Resumen_SumarPersona_EnQuienEntra                 T13 Propuesta_SoloQuienMantiene_YMarcaValida
 *   T5  Resumen_CambioDeValor_YGenerico
 *   T6  Resumen_EnIngles
 * Además: la marca viaja en el cuerpo del pedido y la consulta tras un reinicio la encuentra (T8b).
 *
 * La pantalla y los textos (al final del archivo):
 *   T3  Diferencia_EnLaPantalla_RojoVerdeYSignos          T10 RespuestaCortada_ConsultaYMuestraElEnlace
 *   T7  Proponiendo_TodoApagado_YVuelve                   T11 RespuestaCortada_NoHayPedido_ElErrorDeSiempre
 *   T9  SegundaRespuesta_NoPisaElExito                    T14 Textos_RefreshMinutes_YGuia
 * La pantalla corre sobre un documento mínimo y un fetch falso; los tiempos de espera de la consulta los pasa la
 * prueba como un parámetro más del código de la página (en el navegador no existe y valen 2, 5 y 10 segundos).
 *
 * Sin red: el repo de operaciones es un repo git local por HTTP (lib/git-http-repo.js) y las APIs de Azure DevOps y de
 * GitHub son servidores falsos en el proceso (lib/fake-ado-api.js, lib/fake-github-api.js). Correos y repos inventados.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
const RP = require(path.join(ROOT, 'scripts', 'lib', 'repo-proposal.js'));
const TX = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
const H = require('./lib/site-harness.js');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const { arrancarAdoFalso } = require('./lib/fake-ado-api.js');
const { arrancarGithubFalso } = require('./lib/fake-github-api.js');
const { crearRepoHttp, hayHttpBackend } = require('./lib/git-http-repo.js');
const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
const TAB = () => require(path.join(H.SITE, 'tabs', 'config.js'));

// sin git http-backend se saltea con constancia; en CI (CI=true) NO se saltea
const SIN_BACKEND = !hayHttpBackend() && !process.env.CI && 'git http-backend no está en esta máquina: el repo por HTTP no se puede armar';
const LEAD = 'lead@acme.example';
const DEV = 'dev.a@acme.example';
const AHORA = Date.parse('2026-10-16T12:00:00Z');
const ESCRITURA = `w-${crypto.randomBytes(6).toString('hex')}`;
const CAB = `Basic ${Buffer.from(`x-access-token:${ESCRITURA}`).toString('base64')}`;
const marcaNueva = () => crypto.randomBytes(16).toString('hex');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

function g(dir, ...a) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@acme.example', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@acme.example', GIT_AUTHOR_DATE: '2026-10-16T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-16T12:00:00Z' } });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
/** Un clon de juguete con estos archivos (objetos → JSON del arnés; texto tal cual). */
function clon(archivos) {
  const d = tmp('site-propose-clon-');
  g(d, 'init', '-q', '-b', 'main');
  for (const [rel, c] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), typeof c === 'string' ? c : ORG.formatJson(c));
  }
  g(d, 'add', '-A'); g(d, 'commit', '-q', '--allow-empty', '-m', 'base');
  return d;
}
const opsBase = (extra = {}) => ({ version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] }, ...extra });
const GH = (repo) => ({ platform: 'github', org: 'acme', repo });
const TR_BASE = { version: 1, public: GH('harness'), profile: GH('profile'), operations: GH('ops') };
const PERFIL_ENV = { SITE_PROFILE_REPO: 'https://git.acme.example/perfil.git', SITE_PROFILE_TOKEN: 't' };
const capa = (v) => ({ requires: { harness: `>= ${v}` } });
const PERFIL = { __doc: 'perfil de juguete', ado: { org: 'https://dev.azure.com/acme' }, integrations: { clockify: true, engram: true, mailbox: true, codex: 'detect', nightly: true }, update: { channel: 'latest', apply: 'auto', skills_source: 'separate' }, packs: { default: 'all' }, install: { profile: 'full' }, response: { language: 'es', style: 'executive', max_chars: 1300 } };

function fuentesCon({ ops, perfil = null, config }) {
  const f = H.fuentesFijas({ config: config || opsBase(), personas: { informados: null, repos: null } });
  f.clones = () => ({ operaciones: ops ? { dir: ops } : null, perfil: perfil ? { dir: perfil } : null });
  f.dirBuzon = tmp('site-propose-buzon-');
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
  } finally { await Promise.allSettled([h && h.cerrar && h.cerrar(), emisor && emisor.cerrar && emisor.cerrar()].filter(Boolean)); }
}
async function cerrarTodos(...servidores) {
  await Promise.allSettled(servidores.filter(Boolean).map((s) => s.cerrar()));
}
/** El repo de operaciones servido por HTTP y el clon del sitio sobre él. */
async function opsPorHttp(archivos) {
  const raiz = tmp('site-propose-http-');
  const r = await crearRepoHttp({ raiz, nombre: 'ops.git', archivos, cabecera: CAB });
  const dir = path.join(raiz, 'clon-del-sitio');
  try {
    await require('util').promisify(require('child_process').execFile)('git', ['-c', `http.extraheader=Authorization: ${CAB}`, 'clone', '-q', '--depth', '1', '--branch', 'main', r.url, dir]);
  } catch (e) { await cerrarTodos(r); throw e; }
  return { r, dir };
}

// ── la diferencia ────────────────────────────────────────────────────────────────────────────────────────────────

test('T1 Diferencia_SoloLoQueCambia_ConContexto @story-2.46 @ac-1', () => {
  const antes = Array.from({ length: 30 }, (_, i) => `renglon ${i + 1}`);
  const despues = antes.slice();
  despues[11] = 'renglon 12 cambiado';
  despues[27] = 'renglon 28 cambiado';
  const d = ORG.diferencia(`${antes.join('\n')}\n`, `${despues.join('\n')}\n`);
  const tramos = d.filter((x) => Array.isArray(x.renglones));
  assert.strictEqual(tramos.length, 2, JSON.stringify(d));
  assert.deepStrictEqual(d.map((x) => (x.iguales === undefined ? 'tramo' : `iguales:${x.iguales}`)), ['tramo', 'iguales:9', 'tramo'], 'entre los dos tramos, lo que se salta');
  const forma = (t) => t.renglones.map((r) => `${{ igual: ' ', sale: '-', entra: '+' }[r.tipo]}${r.linea}`);
  assert.deepStrictEqual(forma(tramos[0]), [' renglon 9', ' renglon 10', ' renglon 11', '-renglon 12', '+renglon 12 cambiado', ' renglon 13', ' renglon 14', ' renglon 15']);
  assert.deepStrictEqual(forma(tramos[1]), [' renglon 25', ' renglon 26', ' renglon 27', '-renglon 28', '+renglon 28 cambiado', ' renglon 29', ' renglon 30']);
  // el renglón de cada lado: el que sale lleva el de antes, el que entra el de después
  const sale = tramos[0].renglones.find((r) => r.tipo === 'sale');
  const entra = tramos[0].renglones.find((r) => r.tipo === 'entra');
  assert.deepStrictEqual([sale.a, sale.b, entra.a, entra.b], [12, null, null, 12]);
  assert.deepStrictEqual(tramos[0].renglones[0].a === 9 && tramos[0].renglones[0].b === 9, true);
  // archivos iguales: ningún tramo; menos contexto, tramos más chicos
  assert.deepStrictEqual(ORG.diferencia('a\nb\n', 'a\nb\n'), []);
  assert.deepStrictEqual(ORG.diferencia('', ''), []);
  assert.strictEqual(ORG.diferencia(`${antes.join('\n')}\n`, `${despues.join('\n')}\n`, 1).filter((x) => x.renglones).length, 2);
  // un renglón agregado y uno sacado
  const mas = ORG.diferencia('a\nb\nc\n', 'a\nb\nx\nc\n');
  assert.deepStrictEqual(mas, [{ renglones: [{ tipo: 'igual', linea: 'a', a: 1, b: 1 }, { tipo: 'igual', linea: 'b', a: 2, b: 2 }, { tipo: 'entra', linea: 'x', a: null, b: 3 }, { tipo: 'igual', linea: 'c', a: 3, b: 4 }] }]);
});

test('T2 Diferencia_ArchivoGrande_NoCuelga @story-2.46 @ac-4', () => {
  const antes = Array.from({ length: 5000 }, (_, i) => `renglon ${i}`);
  const despues = antes.slice();
  despues[2500] = 'el del medio';
  // stable-data: el reloj sólo mide cuánto tarda la diferencia (el tope de 1 s); no entra en lo que se compara.
  let t0 = Date.now();
  const d = ORG.diferencia(antes.join('\n'), despues.join('\n'));
  assert.ok(Date.now() - t0 < 1000, `tardó ${Date.now() - t0} ms`);
  const marcados = d.flatMap((x) => x.renglones || []).filter((r) => r.tipo !== 'igual');
  assert.deepStrictEqual(marcados.map((r) => `${r.tipo}:${r.linea}`), ['sale:renglon 2500', 'entra:el del medio']);
  // sin nada igual en las puntas y con un medio de más de 4 000 000 de celdas: todo el medio queda marcado, sin colgar
  const a2 = Array.from({ length: 2600 }, (_, i) => `a${i}`);
  const b2 = Array.from({ length: 2600 }, (_, i) => `b${i}`);
  t0 = Date.now();
  const grande = ORG.diferencia(a2.join('\n'), b2.join('\n'));
  assert.ok(Date.now() - t0 < 1000, `tardó ${Date.now() - t0} ms`);
  const filas = grande.flatMap((x) => x.renglones || []);
  assert.strictEqual(filas.filter((r) => r.tipo === 'sale').length, 2600);
  assert.strictEqual(filas.filter((r) => r.tipo === 'entra').length, 2600);
  assert.strictEqual(filas.filter((r) => r.tipo === 'igual').length, 0);
});

// ── el resumen ───────────────────────────────────────────────────────────────────────────────────────────────────

const ACCESO = [{ role: 'maintainer', emails: [LEAD] }];
const ACCESO_MAS = [...ACCESO, { role: 'dev', emails: ['x@acme.example'] }];

test('T4 Resumen_SumarPersona_EnQuienEntra @story-2.46 @ac-2', async () => {
  const ops = clon({ 'operations.json': opsBase({ site: { access: ACCESO } }) });
  await conPestana({ fuentes: fuentesCon({ ops, config: opsBase({ site: { access: ACCESO } }) }) }, async ({ entrar, token, escribir }) => {
    const lead = await entrar(LEAD); const tok = await token(lead);
    const r = (await escribir('/api/config/revisar', lead, tok, { seccion: 'sitio', borrador: { site: { access: ACCESO_MAS } } })).json;
    assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
    assert.deepStrictEqual(r.resumen, ['Sumás a x@acme.example como dev en Quién entra al sitio']);
    // la diferencia viaja con la revisión: el renglón del correo nuevo entra
    assert.ok(r.diferencia.flatMap((x) => x.renglones || []).some((l) => l.tipo === 'entra' && l.linea.includes('x@acme.example')));
    // sacar a la persona (partiendo de la lista con ella) y cambiar su rol
    const con = clon({ 'operations.json': opsBase({ site: { access: ACCESO_MAS } }) });
    await conPestana({ fuentes: fuentesCon({ ops: con, config: opsBase({ site: { access: ACCESO_MAS } }) }) }, async (c2) => {
      const l2 = await c2.entrar(LEAD); const t2 = await c2.token(l2);
      const sacar = (await c2.escribir('/api/config/revisar', l2, t2, { seccion: 'sitio', borrador: { site: { access: ACCESO } } })).json;
      assert.deepStrictEqual(sacar.resumen, ['Sacás a x@acme.example de Quién entra al sitio']);
      const rol = (await c2.escribir('/api/config/revisar', l2, t2, { seccion: 'sitio', borrador: { site: { access: [ACCESO[0], { role: 'maintainer', emails: ['x@acme.example'] }] } } })).json;
      assert.deepStrictEqual(rol.resumen, ['Cambiás el rol de x@acme.example de dev a maintainer en Quién entra al sitio']);
    });
  });
});

test('T5 Resumen_CambioDeValor_YGenerico @story-2.46 @ac-2', async () => {
  const tit = (k) => TX.t('es', k);
  const etiqueta = tit('pantalla.largoMaximoDeProsaEn').split(' (')[0];
  const ops = clon({ 'operations.json': opsBase() });
  const perfil = clon({ 'team-profile.json': PERFIL, 'team-layer.json': capa(ORG.RESPONSE_SINCE), 'team-repos.json': TR_BASE });
  await conPestana({ fuentes: fuentesCon({ ops, perfil }), env: PERFIL_ENV }, async ({ entrar, token, escribir }) => {
    const lead = await entrar(LEAD); const tok = await token(lead);
    const uno = (await escribir('/api/config/revisar', lead, tok, { seccion: 'respuesta', borrador: { response: { language: 'es', style: 'executive', max_chars: 1500 } } })).json;
    assert.strictEqual(uno.ok, true, JSON.stringify(uno.problems));
    assert.deepStrictEqual(uno.resumen, [`Cambiás «${etiqueta}» de 1300 a 1500`]);
    // una sección sin frase propia: cuenta los valores
    const tres = (await escribir('/api/config/revisar', lead, tok, { seccion: 'responsables', borrador: { owners: { default: 'otro@acme.example', by_project: { P: 'p@acme.example', Q: 'q@acme.example' } } } })).json;
    assert.strictEqual(tres.ok, true, JSON.stringify(tres.problems));
    assert.deepStrictEqual(tres.resumen, [`Cambiás 3 valores en ${tit('pantalla.aQuienLeLleganLos')}`]);
    const unValor = (await escribir('/api/config/revisar', lead, tok, { seccion: 'responsables', borrador: { owners: { default: 'otro@acme.example' } } })).json;
    assert.deepStrictEqual(unValor.resumen, [`Cambiás 1 valor en ${tit('pantalla.aQuienLeLleganLos')}`]);
    // sin cambios: ningún resumen ni diferencia
    const nada = (await escribir('/api/config/revisar', lead, tok, { seccion: 'responsables', borrador: { owners: { default: LEAD } } })).json;
    assert.deepStrictEqual([nada.resumen, nada.diferencia], [[], []]);
  });
});

test('T6 Resumen_EnIngles @story-2.46 @ac-2 @ac-5', async () => {
  const ops = clon({ 'operations.json': opsBase({ site: { access: ACCESO } }) });
  const EN = { 'accept-language': 'en' };
  await conPestana({ fuentes: fuentesCon({ ops, config: opsBase({ site: { access: ACCESO } }) }) }, async ({ entrar, token, escribir }) => {
    const lead = await entrar(LEAD); const tok = await token(lead);
    const r = (await escribir('/api/config/revisar', lead, tok, { seccion: 'sitio', borrador: { site: { access: ACCESO_MAS } } }, EN)).json;
    assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
    assert.deepStrictEqual(r.resumen, [`You add x@acme.example as dev in ${TX.t('en', 'pantalla.quienEntraAlSitio')}`]);
    for (const frase of r.resumen) assert.doesNotMatch(frase, /Sumás|Sacás|Cambiás|Quién|entra al sitio| como /, `sin castellano: ${frase}`);
  });
  const ops2 = clon({ 'operations.json': opsBase() });
  const perfil = clon({ 'team-profile.json': PERFIL, 'team-layer.json': capa(ORG.RESPONSE_SINCE), 'team-repos.json': TR_BASE });
  await conPestana({ fuentes: fuentesCon({ ops: ops2, perfil }), env: PERFIL_ENV }, async ({ entrar, token, escribir }) => {
    const lead = await entrar(LEAD); const tok = await token(lead);
    const r = (await escribir('/api/config/revisar', lead, tok, { seccion: 'respuesta', borrador: { response: { language: 'es', style: 'executive', max_chars: 1500 } } }, EN)).json;
    const etiqueta = TX.t('en', 'pantalla.largoMaximoDeProsaEn').split(' (')[0];
    assert.deepStrictEqual(r.resumen, [`You change «${etiqueta}» from 1300 to 1500`]);
    assert.doesNotMatch(r.resumen[0], /Cambiás|Largo|de prosa/);
    const t = (await escribir('/api/config/revisar', lead, tok, { seccion: 'responsables', borrador: { owners: { default: 'otro@acme.example', by_project: { P: 'p@acme.example', Q: 'q@acme.example' } } } }, EN)).json;
    assert.deepStrictEqual(t.resumen, [`You change 3 values in ${TX.t('en', 'pantalla.aQuienLeLleganLos')}`]);
  });
});

// ── la marca: un solo pedido, y el pedido que se encuentra ───────────────────────────────────────────────────────

test('T8 DobleClic_UnSoloPedido @story-2.46 @ac-7', { skip: SIN_BACKEND }, async () => {
  let gh, r, dir;
  const remotos = { operaciones: { platform: 'github', org: 'acme', repo: 'ops', web: 'https://github.example/acme/ops' } };
  try {
    gh = await arrancarGithubFalso({ owner: 'acme', repo: 'ops' });
    gh.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 1 } };
    ({ r, dir } = await opsPorHttp({ 'operations.json': opsBase() }));
    await conPestana({ fuentes: fuentesCon({ ops: dir }), env: { SITE_OPERATIONS_WRITE_TOKEN: ESCRITURA }, opciones: { remotos, urlBase: { github: gh.base } } }, async ({ h, entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      const s = (await h.pedir('/api/config', { cookie: lead })).json.secciones.find((x) => x.id === 'responsables');
      const rev = (await escribir('/api/config/revisar', lead, tok, { seccion: 'responsables', borrador: { owners: { default: 'otro@acme.example' } } })).json;
      const marca = marcaNueva();
      const cuerpo = { seccion: 'responsables', texto: rev.texto, oid: s.oid, marca };
      const [a, b] = await Promise.all([escribir('/api/config/proponer', lead, tok, cuerpo), escribir('/api/config/proponer', lead, tok, cuerpo)]);
      assert.strictEqual(a.json.ok, true, JSON.stringify(a.json));
      assert.deepStrictEqual(a.json, b.json, 'las dos respuestas, iguales');
      assert.ok(a.json.enlace, 'con el mismo enlace');
      assert.strictEqual(gh.st.pedidos.length, 1, 'un solo pedido');
      assert.strictEqual(r.empujes.length, 1, 'una sola rama empujada');
      // la marca viaja en el cuerpo del pedido, en su primera línea
      assert.ok(gh.st.pedidos[0].body.startsWith(`propuesta: ${marca}\n`), gh.st.pedidos[0].body);
      // un tercer envío con la misma marca, más tarde: la misma respuesta y nada nuevo
      const c = await escribir('/api/config/proponer', lead, tok, cuerpo);
      assert.deepStrictEqual(c.json, a.json);
      assert.strictEqual(gh.st.pedidos.length, 1);
      // otra marca con el pedido ya abierto: el servidor lo frena como siempre
      const otra = (await escribir('/api/config/proponer', lead, tok, { ...cuerpo, marca: marcaNueva() })).json;
      assert.strictEqual(otra.ok, false);
      assert.strictEqual(gh.st.pedidos.length, 1);
      // sin marca, como hoy; una marca con otra forma, 400
      const sinMarca = (await escribir('/api/config/proponer', lead, tok, { seccion: 'responsables', texto: rev.texto, oid: s.oid })).json;
      assert.strictEqual(sinMarca.ok, false);
      const mala = await escribir('/api/config/proponer', lead, tok, { ...cuerpo, marca: 'ABC' });
      assert.strictEqual(mala.status, 400);
      assert.strictEqual(gh.st.pedidos.length, 1);
      assert.strictEqual(gh.prohibidas().length, 0);
    });
  } finally { await cerrarTodos(r, gh); }
});

test('T8b Propuesta_ConsultaTrasReinicio_ElPedidoDeLaMarca @story-2.46 @ac-8 @ac-9', { skip: SIN_BACKEND }, async () => {
  let gh, r, dir;
  const remotos = { operaciones: { platform: 'github', org: 'acme', repo: 'ops', web: 'https://github.example/acme/ops' } };
  const marca = marcaNueva();
  try {
    gh = await arrancarGithubFalso({ owner: 'acme', repo: 'ops' });
    gh.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 1 } };
    ({ r, dir } = await opsPorHttp({ 'operations.json': opsBase() }));
    const opts = { fuentes: fuentesCon({ ops: dir }), env: { SITE_OPERATIONS_WRITE_TOKEN: ESCRITURA }, opciones: { remotos, urlBase: { github: gh.base } } };
    let enlace;
    await conPestana(opts, async ({ h, entrar, token, escribir }) => {
      const lead = await entrar(LEAD); const tok = await token(lead);
      const s = (await h.pedir('/api/config', { cookie: lead })).json.secciones.find((x) => x.id === 'responsables');
      const rev = (await escribir('/api/config/revisar', lead, tok, { seccion: 'responsables', borrador: { owners: { default: 'otro@acme.example' } } })).json;
      const p = (await escribir('/api/config/proponer', lead, tok, { seccion: 'responsables', texto: rev.texto, oid: s.oid, marca })).json;
      assert.strictEqual(p.ok, true, JSON.stringify(p));
      enlace = p.enlace;
      // la memoria del servidor la tiene
      const q = (await h.pedir(`/api/config/propuesta?seccion=responsables&marca=${marca}`, { cookie: lead })).json;
      assert.deepStrictEqual(q, { ok: true, estado: 'abierto', enlace });
    });
    // un servidor nuevo (sin memoria): la encuentra por la marca que viaja en el pedido
    await conPestana({ ...opts, fuentes: fuentesCon({ ops: dir }) }, async ({ h, entrar }) => {
      const lead = await entrar(LEAD);
      const q = (await h.pedir(`/api/config/propuesta?seccion=responsables&marca=${marca}`, { cookie: lead })).json;
      assert.deepStrictEqual(q, { ok: true, estado: 'abierto', enlace });
      assert.deepStrictEqual(Object.keys(q).sort(), ['enlace', 'estado', 'ok'], 'nada más que el estado y el enlace');
      const ninguna = (await h.pedir(`/api/config/propuesta?seccion=responsables&marca=${marcaNueva()}`, { cookie: lead })).json;
      assert.deepStrictEqual(ninguna, { ok: true, estado: 'no_hay' });
      // la marca de una sección en la sección de otro repo: no se ve
      const otraSeccion = (await h.pedir(`/api/config/propuesta?seccion=sitio&marca=${marca}`, { cookie: lead })).json;
      assert.strictEqual(otraSeccion.estado === 'abierto' && otraSeccion.enlace !== enlace, false);
      // la API no contesta bien: «no pude mirar», no «no hay»
      gh.st.exigirAuth = 'otra-credencial';
      const sinMirar = (await h.pedir(`/api/config/propuesta?seccion=responsables&marca=${marcaNueva()}`, { cookie: lead })).json;
      assert.deepStrictEqual(sinMirar, { ok: true, estado: 'no_se_pudo_mirar' });
    });
  } finally { await cerrarTodos(r, gh); }
});

const REMOTO_ADO = { platform: 'azure', org: 'acme', project: 'Proy', repo: 'ops', web: 'https://dev.azure.example/acme/Proy/_git/ops' };
const REMOTO_GH = { platform: 'github', org: 'acme', repo: 'ops', web: 'https://github.example/acme/ops' };
const hace = (horas) => new Date(AHORA - horas * 3600 * 1000).toISOString();

test('T12 Propuesta_TrasReinicio_PorLaMarca_AzureYGitHub @story-2.46 @ac-9', async () => {
  const [activa, hecha2h, hecha30h, abandonada, ajena] = [marcaNueva(), marcaNueva(), marcaNueva(), marcaNueva(), marcaNueva()];
  const cuerpo = (marca) => `propuesta: ${marca}\nSecciones cambiadas: X. Pedido por alguien desde el sitio.`;
  let ado, gh;
  try {
    ado = await arrancarAdoFalso({ org: 'acme', project: 'Proy', repo: 'ops', token: 'api-a' });
    gh = await arrancarGithubFalso({ owner: 'acme', repo: 'ops', token: 'api-g' });
    const pr = (id, status, marca, extra = {}) => ({ pullRequestId: id, status, sourceRefName: `refs/heads/team-config/operations-${id}`, targetRefName: 'refs/heads/main', title: 't', description: cuerpo(marca), webUrl: `https://dev.azure.example/acme/Proy/_git/ops/pullrequest/${id}`, createdBy: { id: 'x' }, votos: [], ...extra });
    ado.st.pedidos.push(pr(1, 'active', activa), pr(2, 'completed', hecha2h, { closedDate: hace(2) }), pr(3, 'completed', hecha30h, { closedDate: hace(30) }), pr(4, 'abandoned', abandonada, { closedDate: hace(1) }),
      pr(5, 'active', ajena, { targetRefName: 'refs/heads/otra', description: cuerpo(ajena) }),
      // el cuerpo sólo la nombra: no es la línea entera
      pr(6, 'active', 'x', { description: `mirá propuesta: ${activa.slice(0, 20)} y ${hecha2h}` }));
    const gp = (n, state, marca, extra = {}) => ({ number: n, state, html_url: `https://github.example/acme/ops/pull/${n}`, title: 't', body: cuerpo(marca), head: { ref: `team-config/operations-${n}` }, base: { ref: 'main' }, merged_at: null, closed_at: null, ...extra });
    gh.st.pedidos.push(gp(1, 'open', activa), gp(2, 'closed', hecha2h, { merged_at: hace(2), closed_at: hace(2) }), gp(3, 'closed', hecha30h, { merged_at: hace(30), closed_at: hace(30) }), gp(4, 'closed', abandonada, { closed_at: hace(1) }));
    const casos = [
      ['azure', REMOTO_ADO, 'api-a', { azure: ado.base }, 'https://dev.azure.example/acme/Proy/_git/ops/pullrequest'],
      ['github', REMOTO_GH, 'api-g', { github: gh.base }, 'https://github.example/acme/ops/pull'],
    ];
    for (const [nombre, remote, credencial, urlBase, enlace] of casos) {
      const busca = (marca, extra = {}) => RP.pedidoDeMarca({ remote, credencial, marca, urlBase, ahora: AHORA, ...extra });
      assert.deepStrictEqual(await busca(activa), { estado: 'abierto', enlace: `${enlace}/1` }, `${nombre}: el pedido activo`);
      assert.deepStrictEqual(await busca(hecha2h), { estado: 'aplicado', enlace: `${enlace}/2` }, `${nombre}: el completado hace 2 h`);
      assert.strictEqual(await busca(hecha30h), null, `${nombre}: el completado hace 30 h, no`);
      assert.strictEqual(await busca(abandonada), null, `${nombre}: el abandonado o cerrado sin mergear, no`);
      assert.strictEqual(await busca(ajena), null, `${nombre}: hacia otra rama, no`);
      assert.strictEqual(await busca(marcaNueva()), null, `${nombre}: una marca que nadie usó`);
      assert.strictEqual(await busca(activa.slice(0, 20)), null, `${nombre}: ni por prefijo`);
      const mala = await busca(activa, { credencial: 'otra' });
      assert.ok(mala && mala.error, `${nombre}: la API que no contesta bien es un error, no «no hay»: ${JSON.stringify(mala)}`);
    }
  } finally { await cerrarTodos(ado, gh); }
});

test('T12b Marca_AlPrincipioDelCuerpo_SobreviveAlCorte @story-2.46 @ac-9', async () => {
  // Azure DevOps corta la descripción a 400 caracteres al LISTAR pedidos: la marca tiene que caber en lo que queda
  const marca = marcaNueva();
  const cuerpo = RP.cuerpoDelPedido({ secciones: ['Una sección con un título larguísimo '.repeat(8).trim()], quien: LEAD, aplicarSolo: true, marca });
  assert.ok(cuerpo.length > 400, `el cuerpo es largo (${cuerpo.length})`);
  assert.ok(cuerpo.startsWith(`propuesta: ${marca}\n`), 'la marca va en la primera línea');
  let ado;
  try {
    ado = await arrancarAdoFalso({ org: 'acme', project: 'Proy', repo: 'ops', token: 'api-a' });
    ado.st.pedidos.push({ pullRequestId: 1, status: 'active', sourceRefName: 'refs/heads/team-config/operations-1', targetRefName: 'refs/heads/main', title: 't', description: cuerpo, webUrl: 'https://dev.azure.example/acme/Proy/_git/ops/pullrequest/1', createdBy: { id: 'x' }, votos: [] });
    const r = await RP.pedidoDeMarca({ remote: REMOTO_ADO, credencial: 'api-a', marca, urlBase: { azure: ado.base }, ahora: AHORA });
    assert.deepStrictEqual(r, { estado: 'abierto', enlace: 'https://dev.azure.example/acme/Proy/_git/ops/pullrequest/1' }, 'el pedido se encuentra aunque el listado corte la descripción');
  } finally { await cerrarTodos(ado); }
});

// ── la ruta de consulta ──────────────────────────────────────────────────────────────────────────────────────────

test('T13 Propuesta_SoloQuienMantiene_YMarcaValida @story-2.46 @ac-10', async () => {
  const ops = clon({ 'operations.json': opsBase() });
  const marca = marcaNueva();
  const fuentes = fuentesCon({ ops, config: opsBase({ people: { machines: { 'maq-a': { person: DEV, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' } } } }) });
  await conPestana({ fuentes }, async ({ h, entrar }) => {
    const dev = await entrar(DEV);
    const comoDev = await h.pedir(`/api/config/propuesta?seccion=responsables&marca=${marca}`, { cookie: dev });
    assert.strictEqual(comoDev.status, 403, 'un dev no la usa');
    assert.ok(!comoDev.texto.includes('abierto'));
    const sinSesion = await h.pedir(`/api/config/propuesta?seccion=responsables&marca=${marca}`);
    assert.strictEqual(sinSesion.status, 401, 'sin sesión, como las otras rutas de la API');
    const lead = await entrar(LEAD);
    for (const mala of ['../x', 'ABCDEF0123456789ABCDEF0123456789', marca.slice(0, 31), `${marca}0`, '', '%00']) {
      const r = await h.pedir(`/api/config/propuesta?seccion=responsables&marca=${mala}`, { cookie: lead });
      assert.strictEqual(r.status, 400, `marca «${mala}»`);
    }
    assert.strictEqual((await h.pedir(`/api/config/propuesta?seccion=responsables`, { cookie: lead })).status, 400, 'sin marca');
    assert.strictEqual((await h.pedir(`/api/config/propuesta?seccion=inventada&marca=${marca}`, { cookie: lead })).status, 400, 'sección desconocida');
    // sin identidad de escritura el sitio no puede mirar: lo dice, no inventa un «no hay»
    const sin = await h.pedir(`/api/config/propuesta?seccion=responsables&marca=${marca}`, { cookie: lead });
    assert.strictEqual(sin.status, 200);
    assert.deepStrictEqual(sin.json, { ok: true, estado: 'no_se_pudo_mirar' });
  });
});

// ── la pantalla: documento mínimo y fetch falso ──────────────────────────────────────────────────────────────────

const TEXTO_HOY = '{\n  "notify": "x"\n}\n';
const TEXTO_DESPUES = '{\n  "notify": "y"\n}\n';
const DIFERENCIA = [{ renglones: [{ tipo: 'igual', linea: '{', a: 1, b: 1 }, { tipo: 'sale', linea: '  "notify": "x"', a: 2, b: null }, { tipo: 'entra', linea: '  "notify": "y"', a: null, b: 2 }, { tipo: 'igual', linea: '}', a: 3, b: 3 }] }, { iguales: 7 }];
const RESUMEN = ['Cambiás «Dónde llega el resumen» de x a y'];
const SECCION_CANAL = { id: 'canal', titulo: 'Canal', repo: 'operaciones', archivo: 'operations.json', estado: 'cargado', soloLectura: false, borrador: { notify: 'x' }, texto: TEXTO_HOY, oid: 'oid-1', problems: [], avisos: [] };

/**
 * La pantalla viva: `rutas` contesta cada llamada del fetch falso (`{ GET|POST ruta }` → función que da la respuesta, o
 * una promesa que la prueba suelta cuando quiere). Devuelve el árbol, los botones por su texto y las llamadas hechas.
 */
async function pantallaViva(rutas, esperas = [1, 1, 1]) {
  const nodo = (tag) => { const n = { tag, hijos: [], textContent: '', attrs: {}, on: {}, setAttribute(k, v) { n.attrs[k] = v; }, appendChild(c) { n.hijos.push(c); return c; }, addEventListener(e, f) { n.on[e] = f; }, replaceChildren(...cs) { n.hijos = cs; } }; return n; };
  const app = nodo('div');
  const document = { querySelector: () => null, getElementById: (id) => (id === 'config-app' ? app : null), createElement: (t) => nodo(t) };
  const llamadas = [];
  const fetchFalso = (ruta, opts) => {
    const metodo = (opts && opts.method) || 'GET';
    llamadas.push({ metodo, ruta, cuerpo: opts && opts.body ? JSON.parse(opts.body) : null });
    const f = rutas[`${metodo} ${ruta.replace(/\?.*$/, '')}`];
    if (!f) return Promise.reject(new Error(`ruta sin contestar: ${metodo} ${ruta}`));
    return Promise.resolve(f(ruta, opts)).then((r) => (r instanceof Error ? Promise.reject(r) : r));
  };
  new Function('document', 'fetch', 'location', 'esperasConsulta', ORG.pantalla())(document, fetchFalso, { hash: '' }, esperas);
  const soltar = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  await soltar();
  const todos = (n = app) => [n, ...n.hijos.flatMap((h) => todos(h))];
  const textoDe = (n) => [n.textContent, ...n.hijos.map(textoDe)].filter(Boolean).join(' ');
  const seccion = () => todos().find((n) => n.attrs.id === 'seccion-canal');
  const boton = (texto) => todos(seccion()).find((n) => n.tag === 'button' && n.textContent === texto);
  return { app, llamadas, soltar, todos, textoDe, seccion, boton, clic: async (texto) => { const b = boton(texto); assert.ok(b, `hay un botón «${texto}»`); b.on.click(); await soltar(); return b; } };
}
const json = (j, status = 200) => () => ({ status, json: () => Promise.resolve(j) });
const sinJson = (status) => () => ({ status, json: () => Promise.reject(new Error('no es JSON')) });
const CONFIG = () => json({ ok: true, secciones: [SECCION_CANAL], proponer: { operaciones: { habilitado: true } }, versiones: [], productos: [] });
const REVISAR = json({ ok: true, texto: TEXTO_DESPUES, borrador: { notify: 'y' }, diferencia: DIFERENCIA, resumen: RESUMEN });
const MARCA_RX = /^[0-9a-f]{32}$/;

test('T3 Diferencia_EnLaPantalla_RojoVerdeYSignos @story-2.46 @ac-1 @ac-3', async () => {
  const p = await pantallaViva({ 'GET /api/config': CONFIG(), 'POST /api/config/revisar': REVISAR });
  await p.clic('Revisar cambios');
  await p.clic('Proponer el cambio');
  const clase = (rx) => p.todos(p.seccion()).filter((n) => rx.test(n.attrs.class || ''));
  const sale = clase(/\bdif-sale\b/); const entra = clase(/\bdif-entra\b/); const igual = clase(/\bdif-igual\b/);
  assert.strictEqual(sale.length, 1); assert.strictEqual(entra.length, 1); assert.strictEqual(igual.length, 2);
  assert.match(p.textoDe(sale[0]), /^−\s+"notify": "x"$/, 'lo que sale lleva «−»');
  assert.match(p.textoDe(entra[0]), /^\+\s+"notify": "y"$/, 'lo que entra lleva «+»');
  assert.ok(p.todos(sale[0]).some((n) => (n.attrs.class || '').includes('dif-signo') && n.textContent === '−'), 'el signo va en un span aparte, sin depender del color');
  const todo = p.textoDe(p.seccion());
  assert.match(todo, /… 7 renglones iguales/);
  assert.ok(todo.includes(RESUMEN[0]), 'arriba, el resumen');
  assert.ok(todo.indexOf(RESUMEN[0]) < todo.indexOf('… 7 renglones iguales'), 'el resumen va antes que la diferencia');
  const detalle = p.todos(p.seccion()).find((n) => n.tag === 'details');
  assert.ok(detalle && detalle.attrs.open === undefined, 'los archivos enteros, en un details cerrado');
  assert.ok(p.textoDe(detalle).includes('Ver los archivos enteros'));
  const pres = p.todos(detalle).filter((n) => n.tag === 'pre').map((n) => n.textContent);
  assert.deepStrictEqual(pres, [TEXTO_HOY, TEXTO_DESPUES], 'el Hoy / Después de antes, adentro');
});

test('T7 Proponiendo_TodoApagado_YVuelve @story-2.46 @ac-6', async () => {
  let soltarProponer; const espera = new Promise((r) => { soltarProponer = r; });
  const enlace = 'https://git.acme.example/acme/ops/pullrequest/7';
  const p = await pantallaViva({ 'GET /api/config': CONFIG(), 'POST /api/config/revisar': REVISAR, 'POST /api/config/proponer': () => espera });
  await p.clic('Revisar cambios'); await p.clic('Proponer el cambio');
  await p.clic('Confirmar y proponer');
  const controles = () => p.todos(p.seccion()).filter((n) => ['input', 'select', 'textarea', 'button'].includes(n.tag));
  assert.ok(controles().length >= 3, 'la sección sigue dibujada con el campo y la confirmación');
  for (const n of controles()) assert.strictEqual(n.attrs.disabled, 'disabled', `${n.tag} «${n.textContent || n.attrs['data-path'] || ''}» apagado mientras propone`);
  const envio = p.llamadas.find((c) => c.ruta === '/api/config/proponer');
  assert.match(envio.cuerpo.marca, MARCA_RX, 'la marca viaja: 32 hex en minúscula');
  soltarProponer({ status: 200, json: () => Promise.resolve({ ok: true, message: `Pedido abierto: ${enlace}`, enlace }) });
  await p.soltar();
  const campos = controles().filter((n) => n.tag !== 'button' || n.textContent === 'Revisar cambios');
  assert.ok(campos.length >= 2);
  for (const n of campos) assert.strictEqual(n.attrs.disabled, undefined, `${n.tag} «${n.textContent || ''}» vuelve a andar`);
  assert.ok(p.todos(p.seccion()).some((n) => n.tag === 'a' && n.attrs.href === enlace), 'con el enlace del pedido');
});

test('T9 SegundaRespuesta_NoPisaElExito @story-2.46 @ac-7', async () => {
  const enlace = 'https://git.acme.example/acme/ops/pullrequest/8';
  let n = 0;
  const p = await pantallaViva({
    'GET /api/config': CONFIG(), 'POST /api/config/revisar': REVISAR,
    'POST /api/config/proponer': () => { n++; return { status: n === 1 ? 200 : 409, json: () => Promise.resolve(n === 1 ? { ok: true, message: `Pedido abierto: ${enlace}`, enlace } : { ok: false, message: 'ya hay un pedido abierto sobre este archivo: x; esperá' }) }; },
  });
  await p.clic('Revisar cambios'); await p.clic('Proponer el cambio');
  const confirmar = p.boton('Confirmar y proponer');
  confirmar.on.click(); confirmar.on.click(); // el doble clic: el segundo no manda nada
  await p.soltar();
  assert.strictEqual(p.llamadas.filter((c) => c.ruta === '/api/config/proponer').length, 1, 'un solo envío');
  assert.ok(p.textoDe(p.seccion()).includes('Pedido abierto'));
  // un envío tardío con la misma marca (un botón viejo): su rechazo habla del pedido de esta misma propuesta y se descarta
  confirmar.on.click(); await p.soltar();
  assert.strictEqual(p.llamadas.filter((c) => c.ruta === '/api/config/proponer').length, 2, 'el tardío sí salió');
  const ahora = p.textoDe(p.seccion());
  assert.ok(ahora.includes('Pedido abierto'), 'sigue «Pedido abierto»');
  assert.ok(!ahora.includes('ya hay un pedido abierto'), 'sin el error que lo pisa');
  assert.ok(p.todos(p.seccion()).some((x) => x.tag === 'a' && x.attrs.href === enlace), 'con su enlace');
});

test('T9c Proponer_RespuestaNula_NoTrabaLaSeccion @story-2.46 @ac-6', async () => {
  // un cuerpo JSON que no es un objeto (`null`, una lista) con 200 o con 502: la sección vuelve a andar y dice qué hacer
  for (const [status, nombre, cuerpo] of [[200, '200', null], [502, '502', null], [200, '200 con una lista', []]]) {
    const rechazos = []; const h = (e) => rechazos.push(String(e && e.message));
    process.on('unhandledRejection', h);
    try {
      const p = await pantallaViva({ 'GET /api/config': CONFIG(), 'POST /api/config/revisar': REVISAR, 'POST /api/config/proponer': json(cuerpo, status), 'GET /api/config/propuesta': json({ ok: true, estado: 'no_hay' }) });
      await p.clic('Revisar cambios'); await p.clic('Proponer el cambio'); await p.clic('Confirmar y proponer');
      for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 5)); await p.soltar(); } // las tres consultas con esperas de 1 ms
      assert.deepStrictEqual(rechazos, [], `${nombre}: ningún rechazo sin atender`);
      const apagados = p.todos(p.seccion()).filter((x) => ['button', 'input', 'select', 'textarea'].includes(x.tag) && x.attrs.disabled === 'disabled');
      assert.strictEqual(apagados.length, 0, `${nombre}: la sección vuelve a tener los controles habilitados`);
      const texto = p.textoDe(p.seccion());
      assert.ok(!texto.includes('proponiendo…'), `${nombre}: ya no dice «proponiendo…»: ${texto}`);
      assert.match(texto, /recargá|Recargá/, `${nombre}: una nota que dice qué hacer`);
    } finally { process.off('unhandledRejection', h); }
  }
});

test('T10 RespuestaCortada_ConsultaYMuestraElEnlace @story-2.46 @ac-8', async () => {
  const enlace = 'https://git.acme.example/acme/ops/pullrequest/9';
  const consultas = [];
  const p = await pantallaViva({
    'GET /api/config': CONFIG(), 'POST /api/config/revisar': REVISAR,
    'POST /api/config/proponer': sinJson(500),
    'GET /api/config/propuesta': (ruta) => { consultas.push(ruta); return { status: 200, json: () => Promise.resolve({ ok: true, estado: consultas.length < 2 ? 'en_curso' : 'abierto', enlace }) }; },
  });
  await p.clic('Revisar cambios'); await p.clic('Proponer el cambio'); await p.clic('Confirmar y proponer');
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
  await p.soltar();
  const marca = p.llamadas.find((c) => c.ruta === '/api/config/proponer').cuerpo.marca;
  assert.ok(consultas.length >= 2 && consultas.every((c) => c === `/api/config/propuesta?seccion=canal&marca=${marca}`), consultas.join(' '));
  const texto = p.textoDe(p.seccion());
  assert.ok(texto.includes('Pedido abierto'), texto);
  assert.ok(!/contestó con un error/.test(texto), 'no se ve el error');
  assert.ok(p.todos(p.seccion()).some((x) => x.tag === 'a' && x.attrs.href === enlace), 'con el enlace');
  // un rechazo con el mensaje del sitio NO consulta
  const q = await pantallaViva({ 'GET /api/config': CONFIG(), 'POST /api/config/revisar': REVISAR, 'POST /api/config/proponer': json({ ok: false, message: 'el archivo cambió desde que lo abriste: recargá' }, 409) });
  await q.clic('Revisar cambios'); await q.clic('Proponer el cambio'); await q.clic('Confirmar y proponer');
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(!q.llamadas.some((c) => c.ruta.startsWith('/api/config/propuesta')), 'con mensaje del sitio no consulta');
  assert.ok(q.textoDe(q.seccion()).includes('el archivo cambió desde que lo abriste'));
});

test('T11 RespuestaCortada_NoHayPedido_ElErrorDeSiempre @story-2.46 @ac-8', async () => {
  for (const [nombre, proponer] of [['red caída', () => new Error('se cortó la red')], ['500 sin cuerpo', sinJson(500)]]) {
    const consultas = [];
    const p = await pantallaViva({
      'GET /api/config': CONFIG(), 'POST /api/config/revisar': REVISAR, 'POST /api/config/proponer': proponer,
      'GET /api/config/propuesta': (ruta) => { consultas.push(ruta); return { status: 200, json: () => Promise.resolve({ ok: true, estado: 'no_hay' }) }; },
    });
    await p.clic('Revisar cambios'); await p.clic('Proponer el cambio'); await p.clic('Confirmar y proponer');
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10));
    await p.soltar();
    assert.strictEqual(consultas.length, 3, `${nombre}: tres consultas, ni más`);
    assert.strictEqual(p.llamadas.filter((c) => c.ruta === '/api/config/proponer').length, 1, `${nombre}: nunca reintenta /proponer`);
    assert.match(p.textoDe(p.seccion()), /recargá y mirá si el pedido se abrió/, nombre);
    assert.ok(!p.textoDe(p.seccion()).includes('Pedido abierto'), nombre);
  }
});

test('T14 Textos_RefreshMinutes_YGuia @story-2.46 @ac-11 @ac-12', () => {
  const sources = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'sources.js'), 'utf8');
  const defecto = Number(/REFRESCO_POR_DEFECTO = (\d+)/.exec(sources)[1]);
  assert.strictEqual(defecto, 15);
  assert.strictEqual(TX.t('es', 'pantalla.cadaCuantoSeActualizaEl'), 'Cada cuánto el sitio relee sus datos');
  assert.strictEqual(TX.t('en', 'pantalla.cadaCuantoSeActualizaEl'), 'How often the site rereads its data');
  for (const [idioma, rx] of [['es', /configuración.*buzón de corridas.*perfil del equipo.*no instala versiones.*Cómo se actualiza el sitio/is], ['en', /configuration.*runs mailbox.*team profile.*does not install versions.*How the site updates/is]]) {
    assert.match(TX.t(idioma, 'pantalla.queReleeElSitio'), rx, idioma);
  }
  assert.strictEqual(TX.t('es', 'pantalla.siNoLoDeclarasQuinceMinutos'), `Si no lo declarás: ${defecto} minutos`);
  assert.match(TX.t('en', 'pantalla.siNoLoDeclarasQuinceMinutos'), new RegExp(`If you do not declare it: ${defecto} minutes`));
  // la pantalla los muestra en la sección «Quién entra al sitio»
  const pantalla = ORG.pantalla('es');
  assert.match(pantalla, /Cada cuánto el sitio relee sus datos/);
  assert.match(pantalla, /Si no lo declarás: 15 minutos/);
  const es = fs.readFileSync(path.join(ROOT, 'guides', 'organization-site.md'), 'utf8');
  const en = fs.readFileSync(path.join(ROOT, 'guides', 'organization-site.en.md'), 'utf8');
  for (const [nombre, guia, rx] of [['es', es, [/`site\.refresh_minutes`[^\n]*(\n[^\n]+)*?[^\n]*5 a 120/, /15 minutos/, /no instala versiones/i, /SITE_AUTH_MICROSOFT_ACCOUNTS=organization/, /nunca `common`/, /Saliste/, /una sola\s+vez/, /consulta/]], ['en', en, [/`site\.refresh_minutes`[^\n]*(\n[^\n]+)*?[^\n]*5 to 120/, /15 minutes/, /does not install versions/, /SITE_AUTH_MICROSOFT_ACCOUNTS=organization/, /never `common`/, /You signed out/, /only once|a single time/, /checks/]]]) {
    for (const r of rx) assert.match(guia, r, `${nombre}: ${r}`);
  }
});
