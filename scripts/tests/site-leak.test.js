'use strict';
/*
 * site-leak.test.js — LA PRUEBA DE FUGA DEL SITIO DE LA ORGANIZACIÓN (story 2.23, AC 24; T32).
 *
 * Siembra marcadores en lo de la persona B (una corrida de su máquina, un PR suyo, un pedido asignado a ella, un producto
 * donde sólo trabaja ella), en una corrida de una máquina sin confirmar, y texto libre en las fuentes (el título de un
 * PR, un diagnóstico del vigilante, el mensaje de un freno, el título de una story, el texto de un rasgo de la paridad).
 * Con la sesión de la persona A recorre TODAS las rutas de la tabla del servidor (la tabla, no una lista de la prueba) y
 * ninguna trae un marcador de B, de la máquina sin confirmar ni de texto libre. Control positivo: B ve lo suyo, quien
 * mantiene ve lo de A, lo de B y lo de la máquina sin confirmar, y nadie ve el texto libre.
 *
 * La cadena es la real: las fotos se leen con sources.js (la lista blanca de la lectura) desde un clon en disco, las
 * corridas con leerRegistro sobre un espejo del buzón, y las páginas las arma el servidor con el filtro de access.js.
 * Aparte, con las fuentes de verdad (repo por HTTP y buzón local), el nombre de un blob de B en una bajada que falla y
 * la ruta de una foto ilegible no llegan a ninguna pantalla: sólo el estado de lista cerrada.
 *
 * El modelo de la tanda: scripts/tests/telemetry-leak.test.sh (marcadores, control positivo, la cadena real).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const { arrancarRepoHttp, repoConArchivos, hayHttpBackend } = require('./lib/git-http-server.js');
const H = require('./lib/site-harness.js');

const sources = require(path.join(H.SITE, 'sources.js'));
const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
const HOY = '2026-10-15';
const LEAD = 'lead@acme.example';
const A = 'dev.a@acme.example';
const B = 'dev.b@acme.example';
const MAQ_A = 'maq-a-11111111';
const MAQ_B = 'maq-b-22222222';
const MAQ_SC = 'maq-sinconfirmar-99999999';

const DE_B = [MAQ_B, '#9001', '/pr/9001', '#9002', '/edit/9002', 'Producto Solo B', 'Repo Solo B'];
const SIN_CONFIRMAR = [MAQ_SC];
const LIBRE = ['TITULO-LIBRE-PR', 'DIAGNOSTICO-LIBRE', 'MENSAJE-FRENO-LIBRE', 'TITULO-STORY-LIBRE', 'RASGO-LIBRE', 'NOMBRE-VISIBLE-LIBRE', 'UMBRAL-LIBRE', 'MOTIVO LIBRE DE DESPLIEGUE'];
const DE_A = [MAQ_A, '#9101', '#9102'];

function escribirArbol(raiz, archivos) {
  for (const [rel, c] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true });
    fs.writeFileSync(path.join(raiz, rel), typeof c === 'string' ? c : JSON.stringify(c));
  }
}

function fuentesConMarcadores() {
  const extra = {
    'scripts/nightly/dependencies/repos.json': { repos: [
      { producto: 'Producto A', ruta: 'A/repo', ado: 'Proyecto A/Repo A', activo: true },
      { producto: 'Producto Solo B', ruta: 'B/repo', ado: 'Proyecto Solo B/Repo Solo B', activo: true },
    ] },
    '.dashboard/proyectos/Proyecto A__Repo A.json': { proyecto: 'Proyecto A', repo: 'Repo A', generated_at: `${HOY}T06:00:00Z`, stories: [{ id: '1.1', titulo: 'TITULO-STORY-LIBRE', grupo: 'en_curso', canonico: 'in-progress', dias_en_estado: 4 }] },
    '.dashboard/proyectos/Proyecto Solo B__Repo Solo B.json': { proyecto: 'Proyecto Solo B', repo: 'Repo Solo B', generated_at: `${HOY}T06:00:00Z`, stories: [{ id: '2.1', titulo: 'TITULO-STORY-LIBRE', grupo: 'en_curso', canonico: 'in-progress', dias_en_estado: 40 }] },
    [`.dashboard/open-prs/open-prs-${HOY}.json`]: { estado: 'medido', prs: [
      { numero: 9001, proyecto: 'Proyecto Solo B', repo: 'Repo Solo B', dias: 4, autor: B, enlace: 'https://dev.example/pr/9001', titulo: 'TITULO-LIBRE-PR', nombre: 'NOMBRE-VISIBLE-LIBRE' },
      { numero: 9101, proyecto: 'Proyecto A', repo: 'Repo A', dias: 1, autor: A, enlace: 'https://dev.example/pr/9101', titulo: 'TITULO-LIBRE-PR' },
    ] },
    [`.dashboard/assigned/assigned-${HOY}.json`]: { estado: 'medido', pedidos: [
      { id: 9002, proyecto: 'Proyecto Solo B', tipo: 'Bug', estado: 'Active', asignado: B, dias_en_estado: 2, enlace: 'https://dev.example/wi/edit/9002', dependencias: true, titulo: 'TITULO-LIBRE-PR' },
      { id: 9102, proyecto: 'Proyecto A', tipo: 'Task', estado: 'New', asignado: A, dias_en_estado: 1, enlace: 'https://dev.example/wi/edit/9102', dependencias: false },
    ] },
    [`.dashboard/vigilante/vigilante-${HOY}.json`]: { fecha: HOY, productos: { 'producto-a': { ok: true } }, hallazgos: [{ diagnostico: 'DIAGNOSTICO-LIBRE' }], resumen: { rubros: { pendientes: { valor: [{ id: 'x', diagnostico: 'DIAGNOSTICO-LIBRE' }] }, aceptadas_sin_story: { valor: [] } } } },
    [`.dashboard/controls-bench/banco-${HOY}.json`]: { ts: `${HOY}T05:00:00Z`, ran: 2, results: { 'caso-1': { tools: { claude: { pass: false, failures: ['MENSAJE-FRENO-LIBRE'] } } } } },
    [`.dashboard/paridad/paridad-${HOY}.json`]: { estado: 'medido', divergencias: [{ grupo: 'g', que: 'RASGO-LIBRE', tienen: ['Producto Solo B'], no_tienen: ['Producto A'] }], por_ruta: [{ ruta: 'A/repo', estado: 'medido', divergencias: 1, vencidas: 0 }, { ruta: 'B/repo', estado: 'medido', divergencias: 0, vencidas: 0 }] },
    'artifacts/tablero-del-arnes.html': '<!doctype html><html><head><style>b{}</style></head><body>Seis preguntas</body></html>',
    // texto libre en lugares que no son fotos (revisión de seguridad, vuelta 1): los umbrales y el motivo de un despliegue
    'scripts/nightly/dashboard/sources.json': { sources: [], thresholds: { banco_rojos: { direction: 'menor_es_mejor', ok_max: 0, bad_min: 1, nota: 'UMBRAL-LIBRE' } } },
    [`.dashboard/deployments/deployments-${HOY}.json`]: { v: 1, productos: { 'Producto A': { estado: 'no_medido', motivo: 'MOTIVO LIBRE DE DESPLIEGUE', staging: null, produccion: null } } },
  };
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'site-fuga-'));
  const clon = path.join(raiz, 'operaciones');
  escribirArbol(clon, H.archivosDeOperaciones({ extra }));
  const espejo = path.join(raiz, 'buzon');
  escribirArbol(espejo, {
    [`${MAQ_A}/sa.json`]: H.volcado('sa', `${HOY}T08:00:00Z`),
    [`${MAQ_B}/sb.json`]: H.volcado('sb', `${HOY}T09:00:00Z`),
    [`${MAQ_SC}/sc.json`]: H.volcado('sc', `${HOY}T10:00:00Z`),
  });
  const modelo = sources.construirDesdeClon(clon, { ahora: Date.parse(`${HOY}T12:00:00Z`), corridas: { ...sources.leerCorridas(espejo), fecha: HOY } });
  return { raiz, modelo };
}

const CONFIG = {
  version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] },
  people: { machines: {
    [MAQ_A]: { person: A, reported_sha256: null, confirmed_by: LEAD, confirmed_on: HOY },
    [MAQ_B]: { person: B, reported_sha256: null, confirmed_by: LEAD, confirmed_on: HOY },
  } },
};
const DONDE = { [A]: ['Producto A'], [B]: ['Producto A', 'Producto Solo B'] };

test('T32 Fuga_PersonaA_NoVeNadaDeB', async () => {
  const { raiz, modelo } = fuentesConMarcadores();
  const emisor = await arrancarEmisor();
  let h = null;
  try {
    assert.ok(!LIBRE.some((m) => JSON.stringify(modelo).includes(m)), 'el texto libre no entra ni al modelo');
    h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer }), fuentes: H.fuentesFijas({ config: CONFIG, modelo }), ahora: () => Date.parse(`${HOY}T12:00:00Z`), dondeTrabaja: (c) => DONDE[c] || null });
    const ahoraSeg = Math.floor(Date.parse(`${HOY}T12:00:00Z`) / 1000);
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true, iat: ahoraSeg, exp: ahoraSeg + 3600 })).sesion;
    const rutas = h.sitio.rutas;
    assert.ok(rutas.length >= 5, 'la tabla de rutas del servidor');
    const todo = async (sesion) => {
      const out = {};
      for (const r of rutas) out[r.path] = (await h.pedir(r.path, { cookie: sesion, method: r.method })).texto;
      return out;
    };
    const buscar = (paginas, marcas) => Object.entries(paginas).flatMap(([ruta, t]) => marcas.filter((m) => t.includes(m)).map((m) => `${ruta}: ${m}`));

    const pA = await todo(await entrar(A));
    assert.deepStrictEqual(buscar(pA, [...DE_B, ...SIN_CONFIRMAR, ...LIBRE]), [], 'A no ve nada de B, de la máquina sin confirmar ni texto libre');
    // control positivo: A sí ve lo suyo (si no, la prueba no prueba nada)
    assert.ok(pA['/'].includes('#9101') && pA['/'].includes('#9102'), 'A ve su PR y su pedido');
    assert.match(pA['/'], /1 corridas en 7 días/, 'A ve su corrida');

    const pB = await todo(await entrar(B));
    assert.ok(pB['/'].includes('#9001') && pB['/'].includes('#9002'), 'B ve su PR y su pedido');
    assert.ok(pB['/proyectos'].includes('Producto Solo B'), 'B ve el producto donde sólo trabaja ella');
    assert.deepStrictEqual(buscar(pB, ['#9101', '#9102', ...SIN_CONFIRMAR, ...LIBRE]), [], 'B tampoco ve lo de A ni lo sin confirmar');

    const pL = await todo(await entrar(LEAD));
    const unido = Object.values(pL).join('\n');
    for (const m of ['Producto Solo B', 'Producto A']) assert.ok(unido.includes(m), `quien mantiene ve ${m}`);
    assert.match(pL['/'], /Máquinas sin confirmar con corridas[\s\S]*?t-val">1</, 'quien mantiene ve la máquina sin confirmar (la cuenta)');
    assert.deepStrictEqual(buscar(pL, LIBRE), [], 'nadie ve el texto libre, tampoco quien mantiene');

    // sin sesión: ninguna ruta de la tabla contesta 200; lo que contesta 200 son las sondas y los estáticos, sin datos
    for (const r of rutas) assert.notStrictEqual((await h.pedir(r.path, { method: r.method })).status, 200, `${r.path} sin sesión`);
    for (const ruta of ['/healthz', '/livez', '/readyz', '/static/site.css', '/static/site.js']) {
      const t = (await h.pedir(ruta)).texto;
      assert.deepStrictEqual([...DE_A, ...DE_B, ...SIN_CONFIRMAR, ...LIBRE].filter((m) => t.includes(m)), [], `${ruta} sin marcadores`);
    }
  } finally { if (h) await h.cerrar(); await emisor.cerrar(); fs.rmSync(raiz, { recursive: true, force: true }); }
});

test('T32b Fuga_MotivosCrudosNoLleganALaPantalla', { skip: !hayHttpBackend() && !process.env.CI && 'git http-backend no está en esta máquina (en CI no se saltea)' }, async () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'site-fuga-b-'));
  const token = `tok-${Date.now().toString(36)}`;
  const config = { version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD], mailbox: { provider: 'azure-blob', account: 'acmeruns', container: 'runs' } } };
  repoConArchivos(raiz, 'ops.git', H.archivosDeOperaciones({ config, extra: { [`.dashboard/vigilante/vigilante-${HOY}.json`]: '{ roto' } }), path.join(raiz, 'trabajo'));
  const git = await arrancarRepoHttp({ raiz, cabecera: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` });
  const blobB = `${MAQ_B}/sesion-secreta-de-b.json`;
  const buzon = await H.arrancarBuzon({ blobs: { [blobB]: H.volcado('sb', `${HOY}T09:00:00Z`) } });
  buzon.st.fallar.add(blobB);
  const emisor = await arrancarEmisor();
  const dataDir = path.join(raiz, 'data');
  const env = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_OPERATIONS_REPO: git.url('ops.git'), SITE_OPERATIONS_TOKEN: token, SITE_MAILBOX_SAS: H.sas() });
  const registro = [];
  const fuentes = sources.crearFuentes({ cfg: validarConfiguracion(env).cfg, dataDir, log: (l) => registro.push(l), urlBuzon: buzon.base });
  let h = null;
  try {
    await fuentes.refrescar();
    h = await H.arrancarSitio({ env, fuentes });
    const s = (await H.ingresar(h, emisor, { sub: 'l', email: LEAD, email_verified: true })).sesion;
    const marcas = ['sesion-secreta-de-b', dataDir, raiz, 'vigilante-2026', buzon.base, git.base];
    for (const r of h.sitio.rutas) {
      const t = (await h.pedir(r.path, { cookie: s, method: r.method })).texto;
      assert.deepStrictEqual(marcas.filter((m) => t.includes(m)), [], `${r.path}: ni el blob ni la ruta`);
    }
    assert.strictEqual(fuentes.modelo().corridas.codigo, 'parcial', 'el estado de lista cerrada');
    assert.strictEqual(fuentes.modelo().vigilante.codigo, 'ilegible');
    assert.ok(registro.join('\n').includes('sesion-secreta-de-b'), 'el motivo crudo va al registro del servidor');
  } finally { if (h) await h.cerrar(); fuentes.detener(); await git.cerrar(); await buzon.cerrar(); await emisor.cerrar(); fs.rmSync(raiz, { recursive: true, force: true }); }
});
