'use strict';
/*
 * site-findings.test.js — la pestaña «Mantenimiento», lo que encontró la noche, en tres bloques: lo que te toca decidir,
 * lo que espera aprobación y lo que está en marcha. Quien mantiene elige Archivar o Arreglar en cada tarjeta y envía todo
 * junto: un solo pedido al repo de operaciones con un archivo de decisión por ficha, que la noche aplica cuando está en
 * main (scripts/nightly/findings/cycle.js).
 *
 *   T31 Mantenimiento_TresBloques_PorQuienTienePelota   T38 Sitio_SinClon_UnaFrase
 *   T32 Sitio_SoloQuienMantiene                          T39 Sitio_OtrasRutas_NoFiltranFichas
 *   T33 Sitio_OtroRol_403YSinMenu                        T57 Sitio_Decision_LaAplicaLaNoche
 *   T34 Sitio_Enviar_UnPedidoConVariasDecisiones         T58 Sitio_DecisionEnMain_AprobadoSeAplicaEstaNoche
 *   T35 Sitio_Confirmar_NoEscribeMain                    T66 Mantenimiento_Vulnerabilidades_Seguimiento
 *   T36 Sitio_AutorNoAprueba                             T69 Sitio_Demo_FichasYEnviarNoAbreNada
 *   T37 Sitio_Enviado_PasaAEsperandoAprobacion           T70 Mantenimiento_SaleDeEjecuciones
 *   T37c Sitio_PedidoViejoDeLaNoche_SeDecideIgual        T71 Mantenimiento_QuePasoYMeta
 *   T72 Mantenimiento_Analisis_RecomiendaYOrden          T73 Mantenimiento_AyudaYBarra_EnElIdioma
 *   T74 Mantenimiento_MenuConCuantasEsperan              T75 Mantenimiento_Envio_FormaYTope
 *   T76 Sitio_DecisionYaEnMain_NoPideRecargar           T77 Sitio_Decididas_NoReaparecen
 *   T78 Sitio_Envio_SeSigueSuNumero                      T79 Mantenimiento_Envio_DiceQuePasa
 *   T80 Mantenimiento_AplicaSolo_NoHablaDeAprobar
 *   T80 Mantenimiento_Cuentas_BajanConLoDecidido
 *   T81 Mantenimiento_YaDecididas_QueQuienCuandoYSiSeAplico   T82 Mantenimiento_Numeros_CambianSinRecargar
 *
 * El servidor real del sitio sobre un clon de operaciones de mentira: el repo es un repo git local y la API de GitHub un
 * servidor falso en el proceso (lib/fake-github-api.js). Sin red. Correos y repos inventados.
 *
 * A mano: node --test scripts/tests/site-findings.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const H = require('./lib/site-harness.js');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const { arrancarGithubFalso } = require('./lib/fake-github-api.js');
const CYCLE = require(path.join(ROOT, 'scripts', 'nightly', 'findings', 'cycle.js'));
const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
const FINDINGS = () => require(path.join(H.SITE, 'tabs', 'findings.js'));
const RUNS = () => require(path.join(H.SITE, 'tabs', 'runs.js'));
const TX = require(path.join(H.SITE, 'texts.js'));

const LEAD = 'lead@acme.example';
const DEV = 'dev.a@acme.example';
const AHORA = Date.parse('2026-10-25T12:00:00Z');
const ESCRITURA = `w-${crypto.randomBytes(6).toString('hex')}`;

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const ENV_GIT = { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@acme.example', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@acme.example',
  GIT_AUTHOR_DATE: '2026-10-25T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-25T12:00:00Z' };
function g(dir, ...a) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...ENV_GIT } });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// ── las fichas de mentira ────────────────────────────────────────────────────────────────────────────────────────────
const EJ1 = CYCLE.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-ESCAPE:TYCON_NO_DEEP_REVIEW', nombre: 'Se saltó el pase adversarial', hoy: '2026-10-21' });
const EJ1_CON = { ...EJ1, ultima_vez: '2026-10-24', apariciones: 4, propuesta: { accion: 'arreglar', razon: 'Se repite cada semana en el mismo paso', modelo: 'sonnet' }, pedido: 42 };
const EJ2 = { ...CYCLE.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-ROJO:pruebas', nombre: 'Las pruebas quedaron en rojo', hoy: '2026-10-20' }), veredicto: 'arreglo', pedido: 'https://dev.acme.example/acme/_workitems/edit/77', propuesta_motivo: 'tope', asignado: DEV };
const EJ_RES = { ...CYCLE.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-VIEJA:resuelta', nombre: 'Una causa ya resuelta', hoy: '2026-10-01' }), estado: 'resuelta' };

const FICHAS = {
  'inbox/dependencies/pending/dep-uno.yaml': 'id: dep-uno\ndetectado: 2026-10-19\nveredicto: pendiente\npaquete: pkg-uno\nseveridad: high\nnoches: 3\npropuesta_accion: arreglar\npropuesta_razon: Hay una versión corregida del paquete\nrepos:\n  - Producto X/FrontEnd\npedidos:\n  - Producto X: 5002\n',
  'inbox/dependencies/promoted/dep-res.yaml': 'id: dep-res\ndetectado: 2026-10-01\nveredicto: pendiente\npaquete: pkg-resuelto\nseveridad: low\nnoches: 5\nresuelto: 2026-10-20\n',
  'inbox/dependencies/archived/2026-10-10/dep-arch.yaml': 'id: dep-arch\ndetectado: 2026-10-01\nveredicto: descartado\npaquete: pkg-archivado\nseveridad: low\nnoches: 5\n',
  'inbox/watcher/pending/vig-uno.yaml': '# borrador del vigilante\nid: vig-uno\nfuente: vigilante\ncausa: acme:errores-500\nfecha: 2026-10-22\nproducto: acme\nregla: errores-500\nseveridad: alta\ndiagnostico: DIAGNOSTICO-PRIVADO del vigilante\nveredicto: pendiente\nvista_por_ultima_vez: 2026-10-24\nnoches_seguidas: 3\npropuesta_accion: aceptar\npropuesta_razon: Es ruido de un cliente de prueba\nstory_creada: https://dev.acme.example/acme/_workitems/edit/88\nevidencia:\n  - EVIDENCIA-PRIVADA tachada\n',
  'inbox/watcher/pending/vig-dos.yaml': 'id: vig-dos\nfuente: vigilante\ncausa: acme:lentitud\nfecha: 2026-10-23\nproducto: acme\nregla: lentitud\nveredicto: pendiente\npropuesta_accion: arreglar\npropuesta_razon: mirar /etc/passwd en acme.example\nstory_creada: algo escrito a mano con espacios\n',
  [`inbox/runs-review/pending/${EJ1.id}.yaml`]: CYCLE.serializar(EJ1_CON),
  [`inbox/runs-review/promoted/${EJ2.id}.yaml`]: CYCLE.serializar(EJ2),
  [`inbox/runs-review/archived/${EJ_RES.id}.yaml`]: CYCLE.serializar(EJ_RES),
  'inbox/runs-review/last-run.json': '{}\n',
};
/** Lo que nunca puede salir del sitio: el diagnóstico y la evidencia del vigilante, y las fichas que no están vivas. */
const NUNCA = ['DIAGNOSTICO-PRIVADO', 'EVIDENCIA-PRIVADA', 'pkg-resuelto', 'pkg-archivado', 'Una causa ya resuelta', '/etc/passwd'];
/** Lo que sí sale de cada fuente: para ver que otra ruta no lo filtra (T39). */
const MARCAS = ['pkg-uno', 'Acme: un error que la noche marcó', 'Es ruido de un cliente de prueba', 'Se saltó el pase adversarial', 'Las pruebas quedaron en rojo', 'dep-uno', 'vig-uno', EJ1.id];

/** El repo de operaciones (un bare local) y el clon del sitio. `extra`: archivos de más o null para borrar uno. */
function armarOperaciones({ opsDoc, extra = {} }) {
  const raiz = tmp('site-findings-ops-');
  const trabajo = path.join(raiz, 'trabajo');
  fs.mkdirSync(trabajo);
  g(trabajo, 'init', '-q', '-b', 'main');
  const archivos = { 'operations.json': `${JSON.stringify(opsDoc, null, 2)}\n`, ...FICHAS, ...extra };
  for (const [rel, c] of Object.entries(archivos)) {
    if (c === null) continue;
    fs.mkdirSync(path.dirname(path.join(trabajo, rel)), { recursive: true });
    fs.writeFileSync(path.join(trabajo, rel), c);
  }
  g(trabajo, 'add', '-A'); g(trabajo, 'commit', '-q', '-m', 'base');
  const bare = path.join(raiz, 'ops.git');
  g(raiz, 'clone', '-q', '--bare', trabajo, bare);
  const clon = path.join(raiz, 'clon');
  g(raiz, 'clone', '-q', bare, clon);
  return { raiz, bare, clon, trabajo };
}

/**
 * El sitio con las pestañas Mantenimiento y Ejecuciones, sobre el clon de operaciones. `fn` recibe los ayudantes.
 * `politica`: la rama principal pide la aprobación de otra persona (por defecto, sí).
 */
async function conSitio({ politica = true, autoApply = false, extra = {}, clones, dataDir = null } = {}, fn) {
  let api; let emisor; let h;
  try {
    api = await arrancarGithubFalso({ owner: 'acme', repo: 'ops' });
    if (politica) api.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 1 } };
    const opsDoc = { version: 1, owners: { default: LEAD }, site: { access: [{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [DEV] }], url: 'https://sitio.acme.example', ...(autoApply ? { auto_apply: true } : {}) }, work_items: { org: 'acme', project: 'Ops Team' } };
    const ops = armarOperaciones({ opsDoc, extra });
    // lo que trae cada pedido: lo que su rama cambia contra main
    api.st.archivosDe = (p) => { try { return g(ops.bare, 'diff', '--name-only', 'main', p.head.ref).split('\n').filter(Boolean); } catch { return []; } };
    const fuentes = H.fuentesFijas({ config: opsDoc });
    fuentes.clones = clones ? () => clones(ops) : () => ({ operaciones: { dir: ops.clon }, perfil: null });
    fuentes.exclusivo = (f) => f();
    emisor = await arrancarEmisor();
    const env = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, SITE_OPERATIONS_REPO: 'https://github.com/acme/ops', SITE_OPERATIONS_WRITE_TOKEN: ESCRITURA });
    const cfg = validarConfiguracion(env).cfg;
    if (dataDir) cfg.dataDir = dataDir;
    const reloj = { t: AHORA };
    const hallazgos = FINDINGS().crearRutas({ cfg, fuentes, ahora: () => reloj.t, urlBase: { github: api.base } });
    const rutasExtra = [...hallazgos, ...RUNS().crearRutas({ cfg, fuentes, version: '2026.10.25.1' })];
    h = await H.arrancarSitio({ env, fuentes, rutasExtra });
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    const lead = await entrar(LEAD);
    const dev = await entrar(DEV);
    const pagina = await h.pedir('/mantenimiento', { cookie: lead });
    // la sección lleva el token de escritura de la sesión (la página no lo trae en su cabecera)
    const tok = (/<section id="hallazgos"[^>]* data-token="([^"]+)"/.exec(pagina.texto) || [])[1];
    const lista = async (cookie = lead) => h.pedir('/api/hallazgos', { cookie });
    const confirmar = async (cuerpo, cookie = lead, token = tok) => h.pedir('/api/hallazgos/confirmar', { method: 'POST', cookie, body: JSON.stringify(cuerpo), headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-site-token': token } });
    const enviar = async (...ds) => confirmar({ decisiones: ds.map(([fuente, id, accion]) => ({ fuente, id, accion })) });
    const fila = (j, fuente, id) => (j.toca || []).find((x) => x.fuente === fuente && x.id === id);
    const llamadasPedidos = () => api.llamadas.filter((l) => l.method === 'GET' && /\/pulls$/.test(l.ruta)).length;
    await fn({ h, api, ops, lead, dev, tok, lista, confirmar, enviar, fila, reloj, llamadasPedidos, entrar, fuentes });
  } finally { await Promise.allSettled([h && h.cerrar(), emisor && emisor.cerrar(), api && api.cerrar()].filter(Boolean)); }
}

// ── T31 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Mantenimiento_TresBloques_PorQuienTienePelota
// 🔴 Falla con: una vulnerabilidad de paquetes para decidir, una ficha decidida en «Te toca decidir», una tabla, un
// número de pedido en una fila por decidir, un correo a la vista o el diagnóstico del vigilante en la página.
test('T31 Mantenimiento_TresBloques_PorQuienTienePelota — te toca decidir, esperando aprobación y en marcha', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, lead, lista, fila }) => {
    const r = await lista();
    assert.strictEqual(r.status, 200, r.texto);
    const j = r.json;
    assert.strictEqual(j.estado, 'leido');
    // te toca decidir: el vigilante primero, después ejecuciones y al final las dependencias
    assert.deepStrictEqual(j.toca.map((x) => `${x.fuente}/${x.id}`), ['vigilante/vig-uno', 'vigilante/vig-dos', `ejecuciones/${EJ1.id}`, 'dependencias/dep-uno']);
    assert.deepStrictEqual(j.espera, []);
    assert.deepStrictEqual(j.cuentas, { toca: 4, espera: 0, decididas: 0, marcha: 2 });
    // las de antes no traen análisis: sin analizar, con su motivo en llano, y sin recomendación
    const e1 = fila(j, 'ejecuciones', EJ1.id);
    assert.strictEqual(e1.analisis, null);
    assert.strictEqual(e1.recomendada, null);
    assert.match(e1.sin_analizar, /^Sin analizar: la noche todavía no analiza estas fichas\./);
    // en marcha: el arreglo con su tarea (el enlace guardado) y sin el correo de quien la tiene
    assert.deepStrictEqual(j.marcha.arreglos, [{ fuente: 'ejecuciones', id: EJ2.id, nombre: 'Las pruebas quedaron en rojo', regla: null, estado: 'tarea',
      tarea: { numero: '77', enlace: 'https://dev.acme.example/acme/_workitems/edit/77' }, asignado: null, motivo: null }]);
    // y la vulnerabilidad, con la tarea de su proyecto armada con la organización de operations.json
    assert.deepStrictEqual(j.marcha.vulnerabilidades, [{ id: 'dep-uno', paquete: 'pkg-uno', severidad: 'high', repos: 1, desde: '2026-10-19', volvio: null,
      tareas: [{ proyecto: 'Producto X', numero: '5002', enlace: 'https://dev.azure.com/acme/Producto%20X/_workitems/edit/5002', asignado: null, sinAsignar: false, sinNombre: false }], motivo: null }]);
    // la página: tarjetas, no tabla; los números son enlaces; nada de lo que no se muestra
    const p = await h.pedir('/mantenimiento', { cookie: lead });
    assert.strictEqual(p.status, 200);
    assert.match(p.texto, /<h1>Mantenimiento<\/h1>/);
    assert.doesNotMatch(p.texto, /<table/);
    assert.strictEqual((p.texto.match(/<article class="m-carta[^"]*" data-ficha="/g) || []).length, 4, 'una tarjeta por ficha que espera decisión');
    assert.match(p.texto, /Te toca decidir \(4\)/);
    assert.match(p.texto, /<details class="m-bloque m-marcha"><summary>[^<]*En marcha \(2\)/, 'en marcha, cerrado');
    assert.doesNotMatch(p.texto, /<h2>Esperando aprobación/, 'sin nada esperando, el bloque no se ve');
    assert.match(p.texto, /href="https:\/\/dev\.acme\.example\/acme\/_workitems\/edit\/77"[^>]*>Tarea 77</);
    assert.match(p.texto, /href="https:\/\/dev\.azure\.com\/acme\/Producto%20X\/_workitems\/edit\/5002"[^>]*>Tarea 5002 \(Producto X\)</);
    // el pedido que creó una persona para una ficha que todavía se decide no se muestra
    assert.doesNotMatch(p.texto, /_workitems\/edit\/88/);
    for (const x of [...NUNCA, DEV]) {
      assert.ok(!p.texto.includes(x), `la página no muestra «${x}»`);
      assert.ok(!r.texto.includes(x), `la lista no trae «${x}»`);
    }
  });
});

// ── T32 / T33 ────────────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_SoloQuienMantiene @story-4.11 @ac-19
// 🔴 Falla con: mostrarle la pestaña Mantenimiento a una persona que no mantiene.
test('T32 Sitio_SoloQuienMantiene — la pestaña Mantenimiento sale sólo para quien mantiene @story-4.11 @ac-19', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, lead, dev }) => {
    const suya = await h.pedir('/mantenimiento', { cookie: lead });
    assert.strictEqual(suya.status, 200);
    assert.match(suya.texto, /id="hallazgos"/);
    const ajena = await h.pedir('/mantenimiento', { cookie: dev });
    assert.strictEqual(ajena.status, 403, 'otro rol no entra a la pestaña');
    assert.doesNotMatch(ajena.texto, /id="hallazgos"/);
    for (const x of MARCAS) assert.ok(!ajena.texto.includes(x), `sin «${x}» para otro rol`);
  });
});

// Sitio_OtroRol_403YSinMenu @story-4.11 @ac-19
// 🔴 Falla con: que otro rol lea las fichas o envíe decisiones por las rutas propias, o una entrada de menú para la sección.
test('T33 Sitio_OtroRol_403YSinMenu — las rutas de la pestaña dan 403 a otro rol y su menú no la tiene @story-4.11 @ac-19', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, api, lead, dev, lista, confirmar }) => {
    assert.strictEqual((await lista(dev)).status, 403);
    // otro rol no recibe la sección ni su token: va con uno inventado, y lo frena el rol antes que el token
    const tokDev = (/data-token="([^"]+)"/.exec((await h.pedir('/mantenimiento', { cookie: dev })).texto || '') || [])[1] || 'sin-token';
    const r = await confirmar({ decisiones: [{ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar' }] }, dev, tokDev);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(api.st.pedidos.length, 0, 'ningún pedido');
    // el menú: quien mantiene tiene la pestaña; otro rol, no
    const menu = async (cookie) => (/<nav[\s\S]*?<\/nav>/.exec((await h.pedir('/corridas', { cookie })).texto) || [''])[0];
    const suyo = await menu(lead);
    assert.match(suyo, /href="\/mantenimiento"[^>]*>(?:<span[^>]*>\d+<\/span>)?Mantenimiento \(\d+\)</, 'quien mantiene tiene la pestaña');
    const ajeno = await menu(dev);
    assert.ok(ajeno, 'la página tiene su menú');
    assert.doesNotMatch(ajeno, /mantenimiento|hallazgos/i, 'otro rol no tiene la pestaña');
  });
});

// ── T34 / T35 / T36 ──────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_Enviar_UnPedidoConVariasDecisiones @story-4.11 @ac-20
// 🔴 Falla con: un pedido por ficha, un archivo de decisión distinto del que aplica la noche, o un pedido que toca algo más.
test('T34 Sitio_Enviar_UnPedidoConVariasDecisiones — «Enviar para aprobar» abre un solo pedido con un archivo por ficha @story-4.11 @ac-20', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ api, ops, enviar }) => {
    const r = await enviar(['vigilante', 'vig-uno', 'aceptar'], ['ejecuciones', EJ1.id, 'arreglar']);
    assert.strictEqual(r.status, 200, r.texto);
    assert.strictEqual(r.json.ok, true, r.texto);
    assert.deepStrictEqual(r.json.omitidas, []);
    assert.strictEqual(api.st.pedidos.length, 1, 'un solo pedido');
    const p = api.st.pedidos[0];
    assert.strictEqual(p.title, 'Decisiones sobre lo que encontró la noche (2)');
    assert.match(p.head.ref, /^team-config\/decisiones-[0-9a-f]{12}-/);
    assert.match(p.body, /vigilante\/vig-uno → aceptar/);
    assert.match(p.body, new RegExp(`ejecuciones/${EJ1.id} → arreglar`));
    assert.match(p.body, /lead@acme\.example/);
    const doc = (ruta) => JSON.parse(g(ops.bare, 'show', `${p.head.ref}:${ruta}`));
    assert.deepStrictEqual(doc('inbox/watcher/decisions/vig-uno.json'), { fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar', quien: LEAD, el: '2026-10-25' });
    assert.deepStrictEqual(doc(`inbox/runs-review/decisions/${EJ1.id}.json`), { fuente: 'ejecuciones', id: EJ1.id, accion: 'arreglar', quien: LEAD, el: '2026-10-25' });
    assert.ok(r.json.numero === 1 && /\/pull\/1$/.test(r.json.enlace), JSON.stringify(r.json));
    // y no toca nada más: la rama es main más esos archivos
    assert.deepStrictEqual(g(ops.bare, 'diff', '--name-only', 'main', p.head.ref).split('\n').sort(),
      [`inbox/runs-review/decisions/${EJ1.id}.json`, 'inbox/watcher/decisions/vig-uno.json'].sort());
  });
});

// Sitio_Confirmar_NoEscribeMain @story-4.11 @ac-20
// 🔴 Falla con: que el envío escriba en main o mergee el pedido.
test('T35 Sitio_Confirmar_NoEscribeMain — main queda igual y el sitio no mergea @story-4.11 @ac-20', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ api, ops, enviar }) => {
    const antes = g(ops.bare, 'rev-parse', 'main');
    const r = await enviar(['ejecuciones', EJ1.id, 'aceptar']);
    assert.strictEqual(r.json.ok, true, r.texto);
    assert.strictEqual(g(ops.bare, 'rev-parse', 'main'), antes);
    assert.deepStrictEqual(api.prohibidas(), [], 'ni merge, ni auto-merge, ni editar el pedido');
    // el clon del sitio tampoco cambia: ni su rama ni su árbol
    assert.strictEqual(g(ops.clon, 'rev-parse', 'HEAD'), antes);
    assert.strictEqual(g(ops.clon, 'status', '--porcelain'), '');
  });
});

// Sitio_AutorNoAprueba @story-4.11 @ac-21
// 🔴 Falla con: abrir el pedido en un repo donde nadie más tiene que aprobarlo.
test('T36 Sitio_AutorNoAprueba — sin la aprobación de otra persona no se propone; con auto_apply, como la Configuración @story-4.11 @ac-21', { timeout: 60000 }, async () => {
  await conSitio({ politica: false }, async ({ api, ops, enviar }) => {
    const r = await enviar(['vigilante', 'vig-uno', 'aceptar']);
    assert.strictEqual(r.json.ok, false, r.texto);
    assert.strictEqual(r.json.codigo, 'sin_politica');
    assert.strictEqual(api.st.pedidos.length, 0);
    assert.deepStrictEqual(g(ops.bare, 'branch', '--list', 'team-config/*'), '', 'no empujó ninguna rama');
  });
  await conSitio({ autoApply: true }, async ({ api, enviar }) => {
    const r = await enviar(['vigilante', 'vig-uno', 'aceptar']);
    assert.strictEqual(api.st.pedidos.length, 1, r.texto);
    // con la opción prendida el sitio intenta aplicarlo, como en la Configuración (la regla de proponer)
    assert.ok(api.prohibidas().length >= 1, 'con site.auto_apply el sitio intenta aplicarlo');
  });
});

// ── T37 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_Enviado_PasaAEsperandoAprobacion @story-4.11 @ac-22
// 🔴 Falla con: un segundo pedido para lo mismo, la fila enviada todavía en «Te toca decidir», una consulta por fila, o
// perder las filas cuando la plataforma no contesta.
test('T37 Sitio_Enviado_PasaAEsperandoAprobacion — lo enviado espera en su pedido; reenviarlo no abre otro @story-4.11 @ac-22', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ api, ops, lista, enviar, fila, reloj, llamadasPedidos }) => {
    assert.strictEqual((await enviar(['vigilante', 'vig-uno', 'aceptar'], ['ejecuciones', EJ1.id, 'arreglar'])).json.ok, true);
    const n0 = llamadasPedidos();
    reloj.t += 61000;
    const j = (await lista()).json;
    assert.deepStrictEqual(j.toca.map((x) => x.id), ['vig-dos', 'dep-uno']);
    assert.deepStrictEqual(j.espera, [{ numero: 1, enlace: api.st.pedidos[0].html_url, aprobado: false, filas: [
      { fuente: 'vigilante', id: 'vig-uno', nombre: 'Acme: un error que la noche marcó', accion: 'aceptar' },
      { fuente: 'ejecuciones', id: EJ1.id, nombre: 'Se saltó el pase adversarial', accion: 'arreglar' }] }]);
    assert.strictEqual(llamadasPedidos() - n0, 1, 'una sola consulta para todas las filas');
    // reenviar lo mismo: nada que enviar, y ningún pedido nuevo; con una más, sólo esa
    const otra = await enviar(['vigilante', 'vig-uno', 'arreglar']);
    assert.strictEqual(otra.json.ok, false);
    assert.strictEqual(otra.json.codigo, 'nada_que_enviar');
    assert.strictEqual(api.st.pedidos.length, 1);
    const mezcla = await enviar(['vigilante', 'vig-uno', 'arreglar'], ['vigilante', 'vig-dos', 'arreglar']);
    assert.strictEqual(mezcla.json.ok, true, mezcla.texto);
    assert.deepStrictEqual(mezcla.json.omitidas, ['vigilante/vig-uno']);
    assert.strictEqual(api.st.pedidos.length, 2);
    assert.deepStrictEqual(g(ops.bare, 'diff', '--name-only', 'main', api.st.pedidos[1].head.ref).split('\n'), ['inbox/watcher/decisions/vig-dos.json']);
    // un pedido de decisiones que no trae archivos de fichas no mueve ninguna fila
    api.st.pedidos.push({ number: 90, state: 'open', html_url: 'https://github.com/acme/ops/pull/90', title: 'otro', body: 'vigilante/vig-dos → aceptar', head: { ref: 'team-config/decisiones-ajeno-20261025-120000' }, base: { ref: 'main' } });
    await lista();
    const n1 = llamadasPedidos();
    // guardada un minuto: otra lectura enseguida no vuelve a preguntar; pasado el minuto, sí
    await lista();
    assert.strictEqual(llamadasPedidos() - n1, 0);
    reloj.t += 61000;
    const conOtro = (await lista()).json;
    assert.strictEqual(llamadasPedidos() - n1, 1);
    assert.deepStrictEqual(conOtro.espera.map((x) => x.numero), [1, 2], 'el pedido sin archivos de fichas no cuenta');
    // la plataforma no contesta: una frase, y las filas vuelven a «Te toca decidir»
    api.st.exigirAuth = 'Bearer otra-cosa';
    reloj.t += 61000;
    const caida = (await lista()).json;
    assert.strictEqual(caida.pedidos.estado, 'no_se_pudo');
    assert.match(caida.pedidos.frase, /No se pudo ver qué está esperando aprobación/);
    assert.deepStrictEqual(caida.toca.map((x) => x.id).sort(), ['vig-dos', 'vig-uno', EJ1.id, 'dep-uno'].sort());
    // y sin saber qué espera aprobación no se envía: podría abrir un segundo pedido para una ficha ya enviada
    const pedidosAntes = api.st.pedidos.length;
    const aCiegas = await enviar(['vigilante', 'vig-uno', 'arreglar']);
    assert.strictEqual(aCiegas.json.codigo, 'sin_pedidos', aCiegas.texto);
    assert.strictEqual(api.st.pedidos.length, pedidosAntes, 'ningún pedido a ciegas');
    // la falla no se guarda: vuelta la plataforma, la lectura siguiente pregunta otra vez sin esperar el minuto
    api.st.exigirAuth = null;
    const vuelta = (await lista()).json;
    assert.strictEqual(vuelta.pedidos.estado, 'leido');
    assert.deepStrictEqual(vuelta.toca.map((x) => x.id), ['dep-uno'], 'sólo lo que nunca se envió');
    assert.ok(fila(caida, 'vigilante', 'vig-uno'));
  });
});

// Sitio_PedidoViejoDeLaNoche_SeDecideIgual @story-4.11 @ac-20
// 🔴 Falla con: una ficha que tiene el pedido viejo de la noche fuera de «Te toca decidir», o una vulnerabilidad que se
// pueda arreglar desde el sitio (sus acciones son aceptar o rechazar su pull request: T83).
test('T37c Sitio_PedidoViejoDeLaNoche_SeDecideIgual — la ficha con el pedido viejo se decide acá; la de paquetes, con sus acciones @story-4.11 @ac-20', { timeout: 60000 }, async () => {
  const extra = {
    'inbox/dependencies/promoted/dep-mov.yaml': 'id: dep-mov\ndetectado: 2026-10-19\nveredicto: pendiente # decision-en-curso\npaquete: pkg-movido\nseveridad: critical\nnoches: 2\n',
    'inbox/watcher/pending/vig-uno.yaml': `${FICHAS['inbox/watcher/pending/vig-uno.yaml']}pr: 123\n`,
  };
  await conSitio({ extra }, async ({ api, lista, enviar, fila }) => {
    const j = (await lista()).json;
    assert.ok(fila(j, 'vigilante', 'vig-uno'), 'con el pedido viejo de la noche, igual se decide');
    // la pendiente se decide acá; la movida a promoted/ ya no espera a nadie
    assert.deepStrictEqual(j.toca.filter((x) => x.fuente === 'dependencias').map((x) => x.id), ['dep-uno']);
    // la crítica primero, sin tarea todavía
    assert.deepStrictEqual(j.marcha.vulnerabilidades.map((x) => [x.id, x.severidad, x.tareas.length]), [['dep-mov', 'critical', 0], ['dep-uno', 'high', 1]]);
    const r = await enviar(['vigilante', 'vig-uno', 'aceptar']);
    assert.strictEqual(r.json.ok, true, r.texto);
    assert.strictEqual(api.st.pedidos.length, 1);
    const dep = await enviar(['dependencias', 'dep-uno', 'arreglar']);
    assert.strictEqual(dep.status, 400);
    assert.strictEqual(api.st.pedidos.length, 1);
  });
});

// ── T38 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_SinClon_UnaFrase @story-4.11 @ac-23
// 🔴 Falla con: un bloque vacío cuando no hay clon, no hay fichas o las carpetas no se pueden leer.
test('T38 Sitio_SinClon_UnaFrase — sin clon, sin fichas o con carpetas que no se leen: una frase @story-4.11 @ac-23', { timeout: 90000 }, async () => {
  const casos = [
    { nombre: 'sin clon', clones: () => ({ operaciones: null, perfil: null }), estado: 'sin_clon', frase: /todavía no bajó el repo de operaciones/ },
    { nombre: 'sin fichas', extra: Object.fromEntries(Object.keys(FICHAS).map((k) => [k, null])), estado: 'sin_fichas', frase: /no dejó nada para mirar/ },
    // una carpeta de fichas que es un archivo: no se puede listar
    { nombre: 'ilegible', extra: { 'inbox/watcher/pending/vig-uno.yaml': null, 'inbox/watcher/pending/vig-dos.yaml': null, 'inbox/watcher/pending': 'no es una carpeta\n' }, estado: 'ilegible', frase: /No se pudo leer lo de: Producción/ },
  ];
  for (const c of casos) {
    await conSitio({ extra: c.extra || {}, clones: c.clones }, async ({ h, lead, lista }) => {
      const j = (await lista()).json;
      assert.strictEqual(j.estado, c.estado, `${c.nombre}: ${JSON.stringify(j)}`);
      assert.match(j.frase, c.frase, c.nombre);
      const p = await h.pedir('/mantenimiento', { cookie: lead });
      const seccion = (/<section id="hallazgos"[\s\S]*?<\/section>/.exec(p.texto) || [''])[0];
      assert.ok(seccion, `${c.nombre}: la sección está`);
      assert.match(seccion, c.frase, c.nombre);
      if (c.estado !== 'ilegible') assert.doesNotMatch(seccion, /m-carta|m-barra/, `${c.nombre}: ni tarjetas ni barra vacías`);
      // lo que se pudo leer, igual se muestra
      else assert.match(seccion, new RegExp(`data-ficha="ejecuciones/${EJ1.id}"`), 'lo de ejecuciones sigue a la vista');
    });
  }
  // enviar con la ficha o la carpeta de decisiones sin poder leerse: «no se pudo leer», nunca un pedido a ciegas
  const ilegibles = [
    { nombre: 'ficha', extra: casos[2].extra, codigo: 'ficha_ilegible' },
    { nombre: 'decisiones', extra: { 'inbox/watcher/decisions': 'no es una carpeta\n' }, codigo: 'decision_ilegible' },
  ];
  for (const c of ilegibles) {
    await conSitio({ extra: c.extra }, async ({ api, enviar }) => {
      const r = await enviar(['vigilante', 'vig-uno', 'aceptar'], ['ejecuciones', EJ1.id, 'aceptar']);
      assert.strictEqual(r.json.ok, false, `${c.nombre}: ${r.texto}`);
      assert.strictEqual(r.json.codigo, c.codigo, c.nombre);
      assert.match(r.json.message, /no se pudo leer/, c.nombre);
      assert.strictEqual(api.st.pedidos.length, 0, `${c.nombre}: ningún pedido`);
    });
  }
});

// ── T39 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_OtrasRutas_NoFiltranFichas @story-4.11 @ac-34
// 🔴 Falla con: que otra ruta del sitio le muestre datos de las fichas a quien no mantiene.
test('T39 Sitio_OtrasRutas_NoFiltranFichas — ninguna otra ruta le da datos de las fichas a otro rol @story-4.11 @ac-34', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, dev }) => {
    // todas las rutas GET que el sitio registra, sin parámetros, con la sesión de una persona que no mantiene
    const rutas = [...new Set(h.sitio.rutas.filter((r) => r.method === 'GET' && !r.path.includes(':')).map((r) => r.path))];
    assert.ok(rutas.includes('/api/hallazgos') && rutas.includes('/corridas'), rutas.join(' '));
    for (const ruta of rutas) {
      const r = await h.pedir(ruta, { cookie: dev });
      for (const x of [...MARCAS, ...NUNCA]) assert.ok(!r.texto.includes(x), `${ruta} le muestra «${x}» a otro rol`);
    }
  });
});

// ── T57 / T58 ────────────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_Decision_LaAplicaLaNoche @story-4.11 @ac-20
// 🔴 Falla con: un archivo de decisión que la noche no sabe aplicar.
test('T57 Sitio_Decision_LaAplicaLaNoche — lo que deja el envío, en main, lo aplica la noche @story-4.11 @ac-20', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ api, ops, enviar }) => {
    assert.strictEqual((await enviar(['ejecuciones', EJ1.id, 'aceptar'], ['vigilante', 'vig-dos', 'arreglar'])).json.ok, true);
    // otra persona aprueba: el pedido entra en main
    const noche = path.join(ops.raiz, 'noche');
    g(ops.raiz, 'clone', '-q', ops.bare, noche);
    for (const p of api.st.pedidos) g(noche, 'merge', '-q', '--no-edit', `origin/${p.head.ref}`);
    assert.ok(fs.existsSync(path.join(noche, 'inbox', 'runs-review', 'decisions', `${EJ1.id}.json`)));
    // la noche
    const e = CYCLE.aplicarDecisiones({ base: noche, fuente: 'ejecuciones' });
    const v = CYCLE.aplicarDecisiones({ base: noche, fuente: 'vigilante' });
    assert.deepStrictEqual([e.aplicadas.length, e.sinForma, v.aplicadas.length, v.sinForma], [1, 0, 1, 0]);
    assert.strictEqual(CYCLE.parsear(fs.readFileSync(path.join(noche, 'inbox', 'runs-review', 'promoted', `${EJ1.id}.yaml`), 'utf8')).veredicto, 'aceptada');
    assert.match(fs.readFileSync(path.join(noche, 'inbox', 'watcher', 'promoted', 'vig-dos.yaml'), 'utf8'), /^veredicto: util$/m);
    assert.ok(!fs.existsSync(path.join(noche, 'inbox', 'runs-review', 'decisions', `${EJ1.id}.json`)));
  });
});

// Sitio_DecisionEnMain_AprobadoSeAplicaEstaNoche @story-4.11 @ac-22
// 🔴 Falla con: seguir ofreciendo decidir (o abrir otro pedido) cuando la decisión ya está en main, o mostrarla en
//    «Esperando aprobación» cuando nadie más tiene que aprobar nada: sale de la lista, con una línea llana.
test('T58 Sitio_DecisionEnMain_AprobadoSeAplicaEstaNoche — con la decisión en main, la fila espera la noche y no se reenvía @story-4.11 @ac-22', { timeout: 60000 }, async () => {
  const extra = { 'inbox/watcher/decisions/vig-uno.json': `${JSON.stringify({ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar', quien: LEAD, el: '2026-10-24' })}\n` };
  await conSitio({ extra }, async ({ h, api, lead, lista, enviar }) => {
    const j = (await lista()).json;
    assert.ok(!j.toca.some((x) => x.id === 'vig-uno'));
    assert.deepStrictEqual(j.espera, [], 'nadie más tiene que aprobarla');
    assert.deepStrictEqual(j.decididas, [{ fuente: 'vigilante', id: 'vig-uno', nombre: 'Acme: un error que la noche marcó', accion: 'aceptar', quien: 'lead', el: '2026-10-24', estado: 'esta_noche' }]);
    const p = await h.pedir('/mantenimiento', { cookie: lead });
    assert.doesNotMatch(p.texto, /<div class="m-bloque m-espera">|Aprobado: se aplica/);
    assert.match(p.texto, /<summary data-t="Ya decididas \(\{n\}\)">Ya decididas \(1\)<\/summary>/);
    assert.match(p.texto, /<li data-ficha="vigilante\/vig-uno"><b>Acme: un error que la noche marcó<\/b> <span class="m-tarea">Archivar · 24\/10 · lead · la aplica la revisión de esta noche<\/span><\/li>/);
    // y un envío tardío no abre otro pedido
    const r = await enviar(['vigilante', 'vig-uno', 'arreglar']);
    assert.strictEqual(r.json.codigo, 'nada_que_enviar');
    assert.strictEqual(api.st.pedidos.length, 0);
  });
});

// ── T66 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Mantenimiento_Vulnerabilidades_Seguimiento @story-4.11 @ac-20
// 🔴 Falla con: un botón en una vulnerabilidad, una tarea sin enlace con número, el correo de quien la tiene, «sin asignar»
// en una tarea que la noche no midió, o la frase de la deuda repetida por fila.
test('T66 Mantenimiento_Vulnerabilidades_Seguimiento — paquetes: severidad, repos, desde, la tarea de cada proyecto y quién la tiene', { timeout: 60000 }, async () => {
  const extra = {
    'inbox/dependencies/pending/dep-uno.yaml': `${FICHAS['inbox/dependencies/pending/dep-uno.yaml']}  - Producto Y: 5003\n  - Producto Z: 5004\n  - Producto W: 5005\n  - Producto V: 5006\nasignados:\n  - "5002: Ana Pérez"\n  - "5003: <nadie>"\n  - "5004: dev.a@acme.example"\n  - "5006: <alguien>"\nreaparecido: 2026-10-22\n`,
    'inbox/dependencies/pending/dep-sin.yaml': 'id: dep-sin\ndetectado: 2026-09-09\nveredicto: pendiente\npaquete: pkg-sin\nseveridad: high\nnoches: 9\npedido_motivo: sin-proyecto\nrepos:\n  - A/x\n  - B/y\n',
  };
  await conSitio({ extra }, async ({ h, lead, lista }) => {
    const v = (await lista()).json.marcha.vulnerabilidades;
    // críticas primero; después, la más vieja
    assert.deepStrictEqual(v.map((x) => x.id), ['dep-sin', 'dep-uno']);
    assert.deepStrictEqual(v[1].tareas.map((t) => [t.proyecto, t.numero, t.asignado, t.sinAsignar]),
      [['Producto X', '5002', 'Ana Pérez', false], ['Producto Y', '5003', null, true], ['Producto Z', '5004', null, false], ['Producto W', '5005', null, false], ['Producto V', '5006', null, false]]);
    assert.deepStrictEqual(v[1].tareas.map((t) => t.sinNombre), [false, false, false, false, true], 'sólo la anotada «<alguien>»');
    assert.strictEqual(v[1].volvio, '2026-10-22');
    assert.strictEqual(v[0].motivo, 'sin-proyecto');
    const p = await h.pedir('/mantenimiento', { cookie: lead });
    const bloque = (/<details class="m-vulns"[\s\S]*?<\/details>\s*<p class="m-deuda/.exec(p.texto) || [''])[0];
    assert.ok(bloque, 'el bloque de vulnerabilidades, cerrado');
    assert.match(p.texto, /Vulnerabilidades de paquetes: 2 \(0 críticas, 2 altas\)\. Cada equipo ya tiene su tarea\. La más vieja, desde el 09\/09\./);
    assert.match(bloque, /en 2 repos · desde 09\/09/);
    assert.match(bloque, /en 1 repo · desde 19\/10 · volvió el 22\/10/);
    assert.match(bloque, /<summary>5 tareas<\/summary>/);
    assert.match(bloque, /Tarea 5002 \(Producto X\)<\/a> · asignada a Ana Pérez/);
    // la tarea que la noche leyó sin nadie dice «sin asignar»; la que no se midió (o con un correo), que no se sabe
    assert.match(bloque, /Tarea 5003 \(Producto Y\)<\/a> · sin asignar/);
    assert.match(bloque, /Tarea 5004 \(Producto Z\)<\/a> · asignada a: no se sabe todavía/);
    assert.match(bloque, /Tarea 5005 \(Producto W\)<\/a> · asignada a: no se sabe todavía/);
    // la que tiene a alguien cuyo nombre es un correo: tiene dueño, y el correo no se muestra
    assert.match(bloque, /Tarea 5006 \(Producto V\)<\/a> · asignada: su nombre en la plataforma es un correo y acá no se muestra/);
    assert.doesNotMatch(bloque, /&lt;nadie&gt;|<nadie>|&lt;alguien&gt;|<alguien>/);
    assert.match(bloque, /Todavía sin tarea: sus repos no tienen un proyecto conocido/);
    assert.doesNotMatch(bloque, /data-accion|dev\.a@acme/);
    assert.strictEqual(p.texto.split('Declara la deuda en su repo, con plazo.').length - 1, 1, 'la frase de la deuda, una vez');
  });
});

// ── T69 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_Demo_FichasYEnviarNoAbreNada @story-4.11 @ac-18 @ac-20 @ac-23
// 🔴 Falla con: una pantalla vacía en el demo, o un envío del demo que sale a la red.
test('T69 Sitio_Demo_FichasYEnviarNoAbreNada — el demo muestra los tres bloques y enviar dice lo que pasaría @story-4.11 @ac-18 @ac-20 @ac-23', { timeout: 60000 }, async () => {
  const dir = tmp('site-findings-demo-');
  const sitio = require(path.join(H.SITE, 'server.js')).crearSitioDemo({ env: { SITE_DEMO: '1' }, dir, log: () => {} });
  await sitio.iniciar();
  await new Promise((r) => sitio.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${sitio.server.address().port}`;
  const pedir = (ruta, o) => H.pedirA(base, ruta, o);
  try {
    const j = (await pedir('/api/hallazgos')).json;
    assert.strictEqual(j.estado, 'leido', JSON.stringify(j));
    assert.deepStrictEqual([...new Set(j.toca.map((x) => x.fuente))].sort(), ['dependencias', 'ejecuciones', 'vigilante']);
    assert.ok(j.toca.some((x) => x.analisis), 'una con análisis');
    assert.ok(j.toca.some((x) => !x.analisis), 'una sin analizar');
    assert.ok(j.marcha.vulnerabilidades.length && j.marcha.arreglos.length, JSON.stringify(j.marcha));
    const pendiente = j.toca.find((x) => x.fuente === 'vigilante');
    const pagina = await pedir('/mantenimiento');
    assert.strictEqual(pagina.status, 200, pagina.texto);
    const tok = (/<section id="hallazgos"[^>]* data-token="([^"]+)"/.exec(pagina.texto) || [])[1];
    assert.ok(tok, 'la sección del demo lleva su token');
    const r = await pedir('/api/hallazgos/confirmar', { method: 'POST', body: JSON.stringify({ decisiones: [{ fuente: 'vigilante', id: pendiente.id, accion: 'aceptar' }] }), headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-site-token': tok } });
    assert.strictEqual(r.status, 200, r.texto);
    assert.strictEqual(r.json.codigo, 'demo');
    assert.strictEqual(r.json.loQuePasaria.archivos[0].archivo, `inbox/watcher/decisions/${pendiente.id}.json`);
    assert.strictEqual(JSON.parse(r.json.loQuePasaria.archivos[0].contenido).accion, 'aceptar');
    // el cliente muestra lo que se propondría
    assert.match(pagina.texto, /data-t-demo="[^"]+"/);
    assert.match(FINDINGS().CLIENTE, /j\.demo && j\.loQuePasaria/);
    // nada cambió: la fila sigue por decidir
    assert.ok((await pedir('/api/hallazgos')).json.toca.some((x) => x.id === pendiente.id));
  } finally { await sitio.cerrar(); }
});

// ── T70..T75: la pestaña Mantenimiento ──────────────────────────────────────────────────────────────────────────────────

/** Una ficha de ejecuciones con sus casos (máquina y story de cada uno). */
const conCasos = (causa, nombre, casos) => CYCLE.nuevaFicha({ fuente: 'ejecuciones', causa, nombre, hoy: '2026-10-22', casos });
const caso = (n, dia, maquina, story) => ({ ejecucion: `e${n}`, base: `${story}-${dia}T1000`, dia, maquina, story });
const EJ_CASOS = conCasos('RR-HOOK:Stop/otro', 'aviso automático con error', [
  caso(1, '2026-10-21', 'mac-a-0123abcd', '1.1'), caso(2, '2026-10-21', 'mac-b-89abcdef', '1.2'), caso(3, '2026-10-22', 'mac-a-0123abcd', '1.3'),
  caso(4, '2026-10-22', 'mac-a-0123abcd', '1.4'), caso(5, '2026-10-22', 'mac-b-89abcdef', '1.5'),
]);
const EJ_UNA = conCasos('RR-ESCAPE:TYCON_SAFETY_OFF', 'freno de seguridad apagado', [caso(6, '2026-10-22', 'mac-c-00112233', '2.1')]);
const extraDe = (...fichas) => Object.fromEntries(fichas.map((f) => [`inbox/runs-review/pending/${f.id}.yaml`, CYCLE.serializar(f)]));
const cartaDe = (html, ficha) => (new RegExp(`<article class="m-carta[^"]*" data-ficha="${ficha.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?</article>`).exec(html) || [''])[0];
const VIG_SENAL = 'id: vig-tres\nfuente: vigilante\ncausa: acme:deriva\nfecha: 2026-10-22\nproducto: acme\nregla: deriva\nplugin: utilesplugin\nveredicto: pendiente\nsenal:\n  errores: 15\n  estado_http: 502\n  total_pedidos: 21\nreincidente:\n  desde: 2026-10-06\nevidencia:\n  - {"duracion_ms":31000}\n  - {"duracion_ms":33000}\n';

// Mantenimiento_SaleDeEjecuciones
// 🔴 Falla con: la sección todavía al pie de Ejecuciones, o la pestaña sin su lugar en el menú de quien mantiene.
test('T70 Mantenimiento_SaleDeEjecuciones — lo que encontró la noche tiene su pestaña y ya no está en Ejecuciones', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, lead, dev }) => {
    for (const cookie of [lead, dev]) {
      const corridas = await h.pedir('/corridas', { cookie });
      assert.doesNotMatch(corridas.texto, /id="hallazgos"|data-ficha=/, 'Ejecuciones no trae las fichas');
      for (const x of MARCAS) assert.ok(!corridas.texto.includes(x), `Ejecuciones no muestra «${x}»`);
    }
    const p = await h.pedir('/mantenimiento', { cookie: lead });
    assert.match(p.texto, /class="activa" aria-current="page"><span class="ix">\d+<\/span>Mantenimiento \(\d+\)</, 'la pestaña activa es Mantenimiento');
    // entre Ejecuciones y Proyectos
    const nav = (/<nav[\s\S]*?<\/nav>/.exec(p.texto) || [''])[0];
    const orden = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(orden.indexOf('/corridas') < orden.indexOf('/mantenimiento') && orden.indexOf('/mantenimiento') < orden.indexOf('/proyectos'), orden.join(' '));
  });
});

// Mantenimiento_QuePasoYMeta
// 🔴 Falla con: una tarjeta que dice sólo el nombre de la causa, las máquinas o las stories en la frase en lugar del
// detalle, una fecha en otro formato que DD/MM, o los datos del vigilante sin usar.
test('T71 Mantenimiento_QuePasoYMeta — cada tarjeta dice qué pasó con los datos de la ficha; máquinas y stories, en el detalle', { timeout: 60000 }, async () => {
  await conSitio({ extra: { ...extraDe(EJ_CASOS, EJ_UNA), 'inbox/watcher/pending/vig-tres.yaml': VIG_SENAL } }, async ({ h, lead, lista, fila }) => {
    const j = (await lista()).json;
    const c = fila(j, 'ejecuciones', EJ_CASOS.id);
    assert.strictEqual(c.meta, '5 veces · 2 máquinas · última vez 22/10');
    assert.strictEqual(c.que_paso, 'Pasó 5 veces, del 21/10 al 22/10.');
    assert.deepStrictEqual(c.detalle, { maquinas: ['mac-b', 'mac-a'], stories: ['1.5', '1.4', '1.3', '1.2', '1.1'] });
    const u = fila(j, 'ejecuciones', EJ_UNA.id);
    assert.strictEqual(u.meta, '1 vez · 1 máquina · última vez 22/10');
    assert.strictEqual(u.que_paso, 'Pasó una vez, el 22/10.');
    // sin casos, la cuenta y las fechas de la ficha
    const e1 = fila(j, 'ejecuciones', EJ1.id);
    assert.strictEqual(e1.meta, '4 veces · última vez 24/10');
    assert.strictEqual(e1.que_paso, 'Pasó 4 veces, del 21/10 al 24/10.');
    // el vigilante: sus números, su regla en llano, que ya había aparecido y cuánto tardó
    const v = fila(j, 'vigilante', 'vig-tres');
    assert.strictEqual(v.meta, 'acme · producción · 22/10');
    assert.strictEqual(v.que_paso, '15 errores 502 en el plugin utilesplugin sobre 21 pedidos en 24 h. Es un tipo de error que no se había visto, o que coincide con un despliegue. Ya había aparecido desde el 06/10 y quedó sin mirar. Cada uno tardó unos 32 s antes de fallar.');
    assert.strictEqual(fila(j, 'vigilante', 'vig-uno').que_paso, 'Un error de producción que la noche marcó.');
    // la página: la frase en la tarjeta y el detalle aparte, cerrado
    const p = await h.pedir('/mantenimiento', { cookie: lead });
    const carta = cartaDe(p.texto, `ejecuciones/${EJ_CASOS.id}`);
    assert.match(carta, /Qué pasó:<\/b> Pasó 5 veces, del 21\/10 al 22\/10\./);
    assert.match(carta, /<details class="m-detalle"><summary>Ver detalle<\/summary>[\s\S]*Máquinas: mac-b, mac-a[\s\S]*Stories: 1\.5, 1\.4, 1\.3, 1\.2, 1\.1/);
    const en = (await lista(`${lead}; sitio-idioma=en`)).json;
    assert.strictEqual(fila(en, 'ejecuciones', EJ_CASOS.id).que_paso, 'It happened 5 times, from 21/10 to 22/10.');
    assert.strictEqual(fila(en, 'ejecuciones', EJ_CASOS.id).meta, '5 times · 2 machines · last time 22/10');
  });
});

// Mantenimiento_Analisis_RecomiendaYOrden
// 🔴 Falla con: una elección hecha de entrada, la recomendada sin marca, lo sin analizar con los botones a la vista o
// mezclado con lo analizado, o el análisis en castellano sin decirlo en la página en inglés.
test('T72 Mantenimiento_Analisis_RecomiendaYOrden — el análisis dice por qué y recomienda; el orden pone primero lo analizado', { timeout: 60000 }, async () => {
  const analisis = (recomendacion, autor, extra = {}) => ({ recomendacion, por_que_pasa: 'Su tope es de 2 s y hubo 479 cortes desde el 22/10',
    por_que_recomienda: 'no es una falla del arnés', ...(recomendacion === 'arreglar' ? { arreglo: 'separar los avisos de complementos de afuera' } : {}), autor, el: '2026-10-27', ...extra });
  const A = { ...conCasos('RR-HOOK:x/tiempo', 'aviso que se pasó de tiempo', [caso(7, '2026-10-22', 'm-1', '3.1'), caso(8, '2026-10-22', 'm-1', '3.2')]), analisis: analisis('arreglar', 'persona') };
  const B = { ...conCasos('RR-CIERRE:abandonada', 'ejecución abandonada', [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => caso(10 + n, '2026-10-22', 'm-2', `4.${n}`))), analisis: analisis('aceptar', 'modelo', { si_vuelve: 'limitar las sesiones a la vez', modelo: 'sonnet' }) };
  const C = { ...conCasos('RR-APAGO:x', 'pipeline pasado a manual', Array.from({ length: 20 }, (_, n) => caso(30 + n, '2026-10-22', 'm-3', `5.${n}`))), analisis_motivo: 'no-aporta' };
  await conSitio({ extra: extraDe(A, B, C) }, async ({ h, lead, lista, fila }) => {
    const j = (await lista()).json;
    const ej = j.toca.filter((x) => x.fuente === 'ejecuciones').map((x) => x.id);
    assert.deepStrictEqual(ej, [A.id, B.id, C.id, EJ1.id], 'arreglar, aceptar y sin analizar; dentro de cada tramo, más veces primero');
    assert.strictEqual(fila(j, 'ejecuciones', A.id).recomendada, 'arreglar');
    assert.strictEqual(fila(j, 'ejecuciones', B.id).recomendada, 'aceptar');
    assert.strictEqual(fila(j, 'ejecuciones', C.id).recomendada, null);
    assert.strictEqual(fila(j, 'ejecuciones', C.id).sin_analizar, 'Sin analizar: el análisis del modelo no citaba ningún dato o repetía el problema, y se descartó. Con estos datos solos no alcanza para decidir.');
    const p = await h.pedir('/mantenimiento', { cookie: lead });
    const a = cartaDe(p.texto, `ejecuciones/${A.id}`);
    assert.match(a, /Por qué:<\/b> <span lang="es">Su tope es de 2 s/);
    assert.match(a, /Recomienda Arreglar:<\/b> <span lang="es">no es una falla del arnés/);
    assert.match(a, /Si se arregla:<\/b> <span lang="es">separar los avisos/);
    // sólo el del modelo de la noche lleva etiqueta; el escrito a mano, ninguna
    assert.doesNotMatch(a, /Análisis automático|escrito a mano|de una persona/);
    assert.match(a, /<button type="button" class="m-elegir recomendada" data-accion="arreglar" aria-pressed="false">Arreglar<\/button>/);
    assert.doesNotMatch(p.texto.slice(p.texto.indexOf('id="hallazgos"')), /aria-pressed="true"/, 'nada elegido de entrada');
    const b = cartaDe(p.texto, `ejecuciones/${B.id}`);
    assert.match(b, /Si vuelve:<\/b> <span lang="es">limitar las sesiones/);
    assert.match(b, /Análisis automático/);
    const c = cartaDe(p.texto, `ejecuciones/${C.id}`);
    assert.match(c, /class="m-carta sin-analizar"/);
    assert.match(c, /<details class="m-sin-analisis"><summary>Decidir sin análisis<\/summary>[\s\S]*data-accion="aceptar"/);
    // la página en inglés dice que el análisis está en castellano
    const en = (await h.pedir('/mantenimiento', { cookie: `${lead}; sitio-idioma=en` })).texto;
    assert.match(cartaDe(en, `ejecuciones/${A.id}`), /\(the analysis is in Spanish\)/);
    assert.match(cartaDe(en, `ejecuciones/${A.id}`), /Recommends Fix:/);
  });
});

// Mantenimiento_AyudaYBarra_EnElIdioma
// 🔴 Falla con: la ayuda de un concepto repetida en cada tarjeta (o en ningún lado), la barra sin sus tres acciones, o
// la página en inglés con textos en castellano sin decirlo.
test('T73 Mantenimiento_AyudaYBarra_EnElIdioma — el «?» de cada concepto, una vez; la barra con sus acciones, en el idioma de la página', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, lead }) => {
    const es = (await h.pedir('/mantenimiento', { cookie: lead })).texto;
    for (const k of ['aceptar', 'arreglar', 'enviar', 'tarea', 'deuda', 'analisis', 'seguir']) {
      assert.strictEqual((es.match(new RegExp(`<div id="m-ayuda-${k}" popover`, 'g')) || []).length, 1, `la ayuda de ${k}, una vez`);
    }
    assert.match(es, /<b>Archivar<\/b> quiere decir/, 'las negritas de la ayuda');
    assert.match(es, /<button type="button" class="m-q" popovertarget="m-ayuda-aceptar" aria-label="Qué es Archivar">\?<\/button>/);
    const barra = (/<div class="m-barra"[\s\S]*?<\/div>/.exec(es) || [''])[0];
    for (const x of ['Enviar para aprobar', 'Borrar elecciones', 'data-t-seguir="Seguir las recomendaciones ({n})"']) assert.ok(barra.includes(x), `la barra trae «${x}»`);
    assert.ok(es.indexOf('Te toca decidir') < es.indexOf('class="m-barra"'));
    const en = (await h.pedir('/mantenimiento', { cookie: `${lead}; sitio-idioma=en` })).texto;
    assert.match(en, /<h1>Maintenance<\/h1>/);
    assert.match(en, /Your decision \(4\)/);
    assert.match(en, /<b>Archive<\/b> means/);
    assert.match(en, /Send for approval/);
  });
});

// Mantenimiento_MenuConCuantasEsperan
// 🔴 Falla con: el menú sin el número de lo que espera decisión, un número que cuenta lo decidido, lo de paquetes o lo
// que cuenta aparte, o un «(0)» cuando no queda nada.
test('T74 Mantenimiento_MenuConCuantasEsperan — al lado del nombre, cuántas fichas esperan decisión; sin ninguna, sin número', { timeout: 90000 }, async () => {
  const enlace = (html) => (/<a href="\/mantenimiento"[^>]*>([\s\S]*?)<\/a>/.exec(html) || [])[1];
  // las que esperan: vig-uno, vig-dos, la de ejecuciones y la dependencia; ni EJ2 (decidida), ni la que cuenta aparte
  const APARTE = CYCLE.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-ESCAPE:GIT_NO_VERIFY/laboratorio', nombre: 'commit sin controles', hoy: '2026-10-22' });
  await conSitio({ extra: extraDe(APARTE) }, async ({ h, lead, lista }) => {
    assert.match(enlace((await h.pedir('/corridas', { cookie: lead })).texto), /Mantenimiento \(4\)$/);
    assert.match(enlace((await h.pedir('/mantenimiento', { cookie: `${lead}; sitio-idioma=en` })).texto), /Maintenance \(4\)$/);
    assert.ok(!(await lista()).json.toca.some((x) => x.id === APARTE.id), 'lo que cuenta aparte no se pregunta');
  });
  // una con su decisión en main ya no espera; la del pedido viejo de la noche, sí
  const extra = {
    'inbox/watcher/decisions/vig-uno.json': `${JSON.stringify({ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar', quien: LEAD, el: '2026-10-24' })}\n`,
    'inbox/watcher/pending/vig-dos.yaml': `${FICHAS['inbox/watcher/pending/vig-dos.yaml']}pr: 123\n`,
  };
  await conSitio({ extra }, async ({ h, lead }) => {
    assert.match(enlace((await h.pedir('/corridas', { cookie: lead })).texto), /Mantenimiento \(3\)$/);
  });
  // sin fichas, el nombre solo
  await conSitio({ extra: Object.fromEntries(Object.keys(FICHAS).map((k) => [k, null])) }, async ({ h, lead }) => {
    assert.match(enlace((await h.pedir('/corridas', { cookie: lead })).texto), /<\/span>Mantenimiento$/);
  });
});

// Mantenimiento_Envio_FormaYTope
// 🔴 Falla con: un envío con la misma ficha dos veces, sin decisiones, con más del tope o con una acción que no existe
// que abre un pedido.
test('T75 Mantenimiento_Envio_FormaYTope — el envío se rechaza entero si no tiene forma: repetidas, vacío, de más o con una acción rara', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ api, confirmar, enviar }) => {
    const malos = [
      { decisiones: [] },
      { decisiones: [{ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar' }, { fuente: 'vigilante', id: 'vig-uno', accion: 'arreglar' }] },
      { decisiones: [{ fuente: 'vigilante', id: 'vig-uno', accion: 'borrar' }] },
      { decisiones: [{ fuente: 'vigilante', id: '../vig-uno', accion: 'aceptar' }] },
      { decisiones: Array.from({ length: 101 }, (_, n) => ({ fuente: 'ejecuciones', id: `x${n}`, accion: 'aceptar' })) },
    ];
    for (const m of malos) {
      const r = await confirmar(m);
      assert.strictEqual(r.status, 400, `${JSON.stringify(m).slice(0, 80)}: ${r.texto}`);
    }
    // la forma vieja, de a una, sigue andando
    const una = await confirmar({ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar' });
    assert.strictEqual(una.json.ok, true, una.texto);
    assert.strictEqual(api.st.pedidos.length, 1);
    // una que no existe o ya no está pendiente, se omite; si no queda ninguna, nada que enviar
    const r = await enviar(['ejecuciones', 'no-existe', 'aceptar']);
    assert.strictEqual(r.json.codigo, 'nada_que_enviar');
    assert.strictEqual(api.st.pedidos.length, 1);
  });
});

// Mantenimiento_QuePaso_ClaseDeError
// 🔴 Falla con: la clase sin decir, su clave cruda en lugar del texto, el código de salida perdido, o el otro idioma.
test('M6 Mantenimiento_QuePaso_ClaseDeError — las ejecuciones dicen su error más común, con la clase en llano', { timeout: 60000 }, async () => {
  const conClase = { ...conCasos('RR-HOOK:UserPromptSubmit/carga', 'aviso automático con error', [caso(7, '2026-10-22', 'mac-a-0123abcd', '3.1'), caso(8, '2026-10-22', 'mac-a-0123abcd', '3.2')]),
    hechos: { errores: { 'sin-procesos': 146, otro: 2 }, error_clase: 'sin-procesos', error_clase_veces: 146, error_veces: 148 } };
  const conSalida = { ...conCasos('RR-HOOK:Stop/carga', 'aviso automático con error', [caso(9, '2026-10-22', 'mac-a-0123abcd', '3.3')]),
    hechos: { errores: { salida: 3 }, error_clase: 'salida', error_clase_veces: 3, error_veces: 3, error_codigo: 2 } };
  await conSitio({ extra: extraDe(conClase, conSalida) }, async ({ lead, lista, fila }) => {
    const j = (await lista()).json;
    assert.strictEqual(fila(j, 'ejecuciones', conClase.id).que_paso, 'Pasó 2 veces, el 22/10. Error más común: la máquina no pudo abrir un proceso más («resource temporarily unavailable») (146 de 148).');
    assert.strictEqual(fila(j, 'ejecuciones', conSalida.id).que_paso, 'Pasó una vez, el 22/10. Error más común: terminó con error (código 2) sin un mensaje reconocible (3 de 3).');
    const en = (await lista(`${lead}; sitio-idioma=en`)).json;
    assert.strictEqual(fila(en, 'ejecuciones', conClase.id).que_paso, 'It happened 2 times, on 22/10. Most common error: the machine could not start another process ("resource temporarily unavailable") (146 of 148).');
  });
});

// Mantenimiento_VigilanteEnLlano
// 🔴 Falla con: la clave de la regla («deriva», «latido») como título de la tarjeta o de la fila de En marcha, sin el
// producto, el plugin o las veces; una regla sin su «?»; la promesa de que la noche vuelve a analizar lo que no analiza;
// la de producción sin análisis que diga que la noche no analiza, o la que dejó de pedirse sin decirlo; o la propuesta
// del modelo escondida.
test('M7 Mantenimiento_VigilanteEnLlano — el título dice producto, plugin, qué pasó y cuántas veces, con su «?»', { timeout: 60000 }, async () => {
  const extra = {
    'inbox/watcher/pending/vig-tres.yaml': 'id: vig-tres\nfecha: 2026-10-22\nproducto: facturas\nregla: deriva\nseveridad: alta\nplugin: utilesx\nsenal:\n  errores: 12\n  estado_http: 502\n  total_pedidos: 21\nveredicto: pendiente\nnoches_seguidas: 1\n',
    'inbox/watcher/pending/vig-cinco.yaml': 'id: vig-cinco\nfecha: 2026-10-22\nproducto: facturas\nregla: goteo\nseveridad: media\nendpoint: /api/cobros\nsenal:\n  errores: 0\nveredicto: pendiente\n',
    'inbox/watcher/pending/vig-seis.yaml': 'id: vig-seis\nfecha: 2026-10-21\nproducto: facturas\nregla: deriva\nseveridad: alta\nplugin: utilesx\nveredicto: pendiente\nanalisis_motivo: modelo-caido\nanalisis_fallas: 3\nanalisis_fallo_el: 2026-10-24\n',
    'inbox/watcher/promoted/vig-cuatro.yaml': 'id: vig-cuatro\nfecha: 2026-10-20\nproducto: abc\nregla: latido\nseveridad: alta\nplugin: abcbackend\nveredicto: util\n',
  };
  await conSitio({ extra }, async ({ h, lead, lista, fila }) => {
    const j = (await lista()).json;
    const tres = fila(j, 'vigilante', 'vig-tres');
    assert.strictEqual(tres.nombre, 'Facturas · plugin utilesx: un error nuevo, o que apareció con un despliegue (12 veces)');
    assert.strictEqual(tres.regla, 'deriva');
    // sin plugin, el endpoint; sin errores contados, sin cifra
    assert.strictEqual(fila(j, 'vigilante', 'vig-cinco').nombre, 'Facturas · /api/cobros: errores que se repiten sin llegar a la alarma');
    // la regla que la noche no conoce: una frase genérica, nunca su clave
    assert.strictEqual(fila(j, 'vigilante', 'vig-uno').nombre, 'Acme: un error que la noche marcó');
    const cuatro = j.marcha.arreglos.find((x) => x.id === 'vig-cuatro');
    assert.strictEqual(cuatro.nombre, 'ABC · plugin abcbackend: no tuvo actividad, o está caído');
    assert.strictEqual(cuatro.regla, 'latido');
    // sin análisis: lo dice tal cual, sin prometer que la noche lo vuelve a intentar; y la propuesta del modelo, a la vista
    assert.match(tres.sin_analizar, /la noche todavía no le llegó a esta ficha/);
    assert.match(fila(j, 'vigilante', 'vig-seis').sin_analizar, /el modelo falló tres noches seguidas y la noche dejó de pedírselo/);
    assert.doesNotMatch(tres.sin_analizar, /vuelve a intentar/);
    assert.deepStrictEqual(fila(j, 'vigilante', 'vig-uno').propuesta, { accion: 'aceptar', razon: 'Es ruido de un cliente de prueba' });
    assert.deepStrictEqual(fila(j, 'vigilante', 'vig-dos').propuesta, { accion: 'arreglar', razon: null }, 'la razón que no pasa el filtro no se muestra');
    const p = (await h.pedir('/mantenimiento', { cookie: lead })).texto;
    assert.match(p, /<b class="m-nombre">Facturas · plugin utilesx: un error nuevo, o que apareció con un despliegue \(12 veces\)<\/b> <button type="button" class="m-q" popovertarget="m-ayuda-regla-deriva"/);
    assert.match(p, /<li><b>ABC · plugin abcbackend: no tuvo actividad, o está caído<\/b> <button type="button" class="m-q" popovertarget="m-ayuda-regla-latido"/);
    for (const r of ['deriva', 'goteo', 'desagregacion', 'latido', 'otra']) assert.match(p, new RegExp(`<div id="m-ayuda-regla-${r}" popover`), `la ayuda de ${r}`);
    assert.match(p, /Es un tipo de error que no se había visto, o que coincide con un despliegue/);
    assert.doesNotMatch(p, /<b(?: class="m-nombre")?>(deriva|latido|goteo|desagregacion)</, 'ninguna clave cruda como título');
    assert.doesNotMatch(p, /vuelve a intentar/);
    assert.match(p, /Propuesta del modelo: Archivar\. <span lang="es">Es ruido de un cliente de prueba<\/span>/);
    const en = (await lista(`${lead}; sitio-idioma=en`)).json;
    const pEn = (await h.pedir('/mantenimiento', { cookie: `${lead}; sitio-idioma=en` })).texto;
    assert.match(pEn, /Model proposal: Archive\. <span lang="es">Es ruido de un cliente de prueba<\/span> \(the reason is in Spanish\)/);
    assert.strictEqual(fila(en, 'vigilante', 'vig-tres').nombre, 'Facturas · plugin utilesx: a new error, or one that came with a deployment (12 times)');
  });
});

// Mantenimiento_EnMarcha_SeCreaSoloSiLaNocheLaCrea
// 🔴 Falla con: «La tarea se crea esta noche» en una ficha que la noche saltea (ya tiene su historia, quedó «pidiendo»
// de una noche anterior, o la organización no dijo dónde crear las tareas); la historia mostrada como la ruta cruda; o
// una ficha que el sitio da por creada esta noche y la noche no pide (o al revés).
test('M8 Mantenimiento_EnMarcha_SeCreaSoloSiLaNocheLaCrea — «se crea esta noche» sólo donde la noche la va a crear', { timeout: 60000 }, async () => {
  const extra = {
    'inbox/watcher/promoted/vig-historia.yaml': 'id: vig-historia\nfecha: 2026-09-07\nproducto: abc\nregla: latido\nseveridad: media\nplugin: abcbackend\nveredicto: util\nstory_creada: "Acme/Project/specs/epics/stories/7-9-latido-sin-uso.md"\npr: 3587\n',
    'inbox/watcher/promoted/vig-pidiendo.yaml': 'id: vig-pidiendo\nfecha: 2026-10-21\nproducto: abc\nregla: deriva\nseveridad: alta\nplugin: abcbackend\nveredicto: util\npedido: "pidiendo"\n',
    'inbox/watcher/promoted/vig-nueva.yaml': 'id: vig-nueva\nfecha: 2026-10-22\nproducto: abc\nregla: deriva\nseveridad: alta\nplugin: abcbackend\nveredicto: util\n',
    // la nota de una noche sin configurar no manda: hoy está configurado y la noche la pide
    'inbox/watcher/promoted/vig-vieja.yaml': 'id: vig-vieja\nfecha: 2026-10-23\nproducto: abc\nregla: deriva\nseveridad: alta\nplugin: abcbackend\nveredicto: util\npedido_motivo: "sin-configurar"\n',
    // la story sin número de pedido, y la que no tiene forma de nombre: nunca la ruta
    'inbox/watcher/promoted/vig-sinpr.yaml': 'id: vig-sinpr\nfecha: 2026-09-08\nproducto: abc\nregla: latido\nseveridad: media\nplugin: abcbackend\nveredicto: util\nstory_creada: "Acme/specs/8-1-otra.md"\n',
    'inbox/watcher/promoted/vig-rara.yaml': 'id: vig-rara\nfecha: 2026-09-09\nproducto: abc\nregla: latido\nseveridad: media\nplugin: abcbackend\nveredicto: util\nstory_creada: "Acme/specs/una story rara.md"\n',
    // la decidida que todavía no pasó a promoted/: la noche no la pide
    'inbox/watcher/pending/vig-quieta.yaml': 'id: vig-quieta\nfecha: 2026-10-24\nproducto: abc\nregla: deriva\nseveridad: alta\nplugin: abcbackend\nveredicto: util\n',
  };
  const estados = (j) => Object.fromEntries(j.marcha.arreglos.filter((x) => x.fuente === 'vigilante').map((x) => [x.id, [x.estado, x.motivo || (x.historia && x.historia.nombre) || null]]));
  await conSitio({ extra }, async ({ h, ops, lead, lista }) => {
    const j = (await lista()).json;
    assert.deepStrictEqual(estados(j), {
      'vig-historia': ['historia', '7-9-latido-sin-uso'], 'vig-pidiendo': ['sin_tarea', 'sin-confirmar'], 'vig-nueva': ['se_crea', null],
      'vig-vieja': ['se_crea', null], 'vig-sinpr': ['historia', '8-1-otra'], 'vig-rara': ['historia', null], 'vig-quieta': ['sin_tarea', 'sin-mover'] });
    assert.deepStrictEqual(j.marcha.arreglos.find((x) => x.id === 'vig-historia').historia, { nombre: '7-9-latido-sin-uso', pedido: 3587 });
    const p = (await h.pedir('/mantenimiento', { cookie: lead })).texto;
    assert.match(p, /Ya tiene su historia: 7-9-latido-sin-uso \(pedido 3587\)/);
    assert.doesNotMatch(p, /Acme\/Project\/specs/, 'nunca la ruta cruda');
    assert.match(p, /Ya tiene su historia: 8-1-otra</);
    assert.match(p, /Ya tiene su historia</, 'la de nombre raro, sin nombre');
    assert.doesNotMatch(p, /una story rara|Acme\/specs/, 'nunca la ruta cruda');
    assert.match(p, /Sin tarea: todavía no pasó a las decididas/);
    assert.strictEqual((p.match(/La tarea se crea esta noche/g) || []).length, 2, 'sólo las que la noche va a pedir');
    // la noche, sobre las mismas fichas, pide exactamente las que el sitio da por creadas esta noche
    const pedidas = [];
    const run = async (op, args) => { pedidas.push(args.tags.find((t) => t.startsWith('arnes:')).slice(6)); return { ok: true, value: { id: 900 + pedidas.length } }; };
    await CYCLE.pedirTrabajo({ fuente: 'vigilante', dir: path.join(ops.trabajo, 'inbox', 'watcher'), operations: path.join(ops.trabajo, 'operations.json'), run, repoDir: ops.trabajo });
    assert.deepStrictEqual(pedidas, j.marcha.arreglos.filter((x) => x.fuente === 'vigilante' && x.estado === 'se_crea').map((x) => x.id));
  });
  // sin dónde crear las tareas en operations.json, la noche no pide ninguna: el sitio lo dice
  const sinDestino = { version: 1, owners: { default: LEAD }, site: { access: [{ role: 'maintainer', emails: [LEAD] }] } };
  await conSitio({ extra: { ...extra, 'operations.json': `${JSON.stringify(sinDestino, null, 2)}\n` } }, async ({ lista }) => {
    const j = (await lista()).json;
    assert.deepStrictEqual(estados(j)['vig-nueva'], ['sin_tarea', 'sin-configurar']);
    assert.ok(!j.marcha.arreglos.some((x) => x.estado === 'se_crea'), JSON.stringify(j.marcha.arreglos));
  });
  // con operations.json ilegible la noche tampoco pide, pero no es que no se haya configurado: lo dice
  await conSitio({ extra: { ...extra, 'operations.json': '{ esto no es json\n' } }, async ({ lista }) => {
    const j = (await lista()).json;
    assert.deepStrictEqual(estados(j)['vig-nueva'], ['sin_tarea', 'configuracion-ilegible']);
    assert.ok(!j.marcha.arreglos.some((x) => x.estado === 'se_crea'), JSON.stringify(j.marcha.arreglos));
  });
});

// ── T76 · T77 · T78 · T79: un envío que se puede seguir, y lo decidido no vuelve ─────────────────────────────────────

/** main de operaciones ya trae la decisión de `id` (un envío anterior), y el clon del sitio sigue en la foto de antes. */
function decisionYaEnMain(ops, fuente, carpeta, id, accion = 'aceptar') {
  g(ops.trabajo, 'pull', '-q', ops.bare, 'main');
  const rel = `inbox/${carpeta}/decisions/${id}.json`;
  fs.mkdirSync(path.dirname(path.join(ops.trabajo, rel)), { recursive: true });
  fs.writeFileSync(path.join(ops.trabajo, rel), `${JSON.stringify({ fuente, id, accion, quien: LEAD, el: '2026-10-25' }, null, 2)}\n`);
  g(ops.trabajo, 'add', '-A'); g(ops.trabajo, 'commit', '-q', '-m', 'la decisión de antes');
  g(ops.trabajo, 'push', '-q', ops.bare, 'HEAD:main');
}

// Sitio_DecisionYaEnMain_NoPideRecargar
// 🔴 Falla con: pedir «recargá» cuando main ya trae la decisión de esa misma ficha (un envío anterior que llegó mientras
//    la pantalla esperaba, con el sitio leyendo todavía la foto de antes), abrir un pedido con ella, o contestar recién
//    después de un refresco de las fuentes (en un sitio real baja el buzón: un minuto con la pantalla en «enviando»).
test('T76 Sitio_DecisionYaEnMain_NoPideRecargar — lo ya decidido en main sale de la lista como hecho, no como error', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ api, ops, enviar, fuentes }) => {
    decisionYaEnMain(ops, 'ejecuciones', 'runs-review', EJ1.id);
    // un refresco que no termina nunca: el envío no lo espera
    fuentes.refrescar = () => new Promise(() => {});
    const sola = await enviar(['ejecuciones', EJ1.id, 'aceptar']);
    assert.strictEqual(sola.json.codigo, 'ya_decidida', sola.texto);
    assert.strictEqual(sola.json.ok, true, 'ya estaba hecho: no es un error');
    assert.deepStrictEqual(sola.json.omitidas, [`ejecuciones/${EJ1.id}`]);
    assert.doesNotMatch(sola.json.message, /recarg/i, 'recargar no lo arregla: no se pide');
    assert.strictEqual(api.st.pedidos.length, 0, 'ningún pedido con lo que ya está en main');
    // junto con otra: sale la decidida y la otra va en su pedido
    const mezcla = await enviar(['ejecuciones', EJ1.id, 'arreglar'], ['vigilante', 'vig-uno', 'aceptar']);
    assert.strictEqual(mezcla.json.ok, true, mezcla.texto);
    assert.deepStrictEqual(mezcla.json.omitidas, [`ejecuciones/${EJ1.id}`]);
    assert.deepStrictEqual(g(ops.bare, 'diff', '--name-only', 'main', api.st.pedidos[0].head.ref).split('\n'), ['inbox/watcher/decisions/vig-uno.json']);
  });
});

// Sitio_Decididas_NoReaparecen
// 🔴 Falla con: una ficha que el sitio ya decidió y vuelve a «Te toca decidir» porque la foto de operaciones todavía no
//    la trae (el refresco de siempre, o un reinicio con la foto vieja), o una marca que no se olvida nunca.
test('T77 Sitio_Decididas_NoReaparecen — lo que el sitio ya decidió no vuelve, ni después de reiniciar', { timeout: 60000 }, async () => {
  const datos = tmp('site-findings-datos-');
  await conSitio({ dataDir: datos }, async ({ ops, enviar, lista, fila }) => {
    decisionYaEnMain(ops, 'ejecuciones', 'runs-review', EJ1.id, 'arreglar');
    assert.strictEqual((await enviar(['ejecuciones', EJ1.id, 'aceptar'])).json.codigo, 'ya_decidida');
    const j = (await lista()).json;
    assert.strictEqual(fila(j, 'ejecuciones', EJ1.id), undefined, 'no vuelve a «Te toca decidir» con la foto vieja');
    assert.deepStrictEqual(j.espera, [], 'no espera la aprobación de nadie');
    assert.deepStrictEqual(j.decididas.map((x) => [x.id, x.accion]), [[EJ1.id, 'arreglar']], 'cuenta como decidida, con la decisión que está en main');
  });
  // otro arranque del sitio sobre el mismo disco y la misma foto vieja: tampoco vuelve
  await conSitio({ dataDir: datos }, async ({ lista, fila }) => {
    assert.strictEqual(fila((await lista()).json, 'ejecuciones', EJ1.id), undefined, 'después de reiniciar, tampoco');
  });
  // la marca: se olvida cuando la foto ya trae la decisión, y vence sola
  const D = FINDINGS().crearDecididas;
  let t = AHORA;
  const a = D({ dataDir: datos, ahora: () => t });
  a.marcar([{ clave: 'vigilante/x1', accion: 'aceptar' }]);
  assert.strictEqual(D({ dataDir: datos, ahora: () => t }).accionDe('vigilante/x1'), 'aceptar', 'otra instancia la lee del disco');
  a.olvidar('vigilante/x1');
  assert.strictEqual(D({ dataDir: datos, ahora: () => t }).accionDe('vigilante/x1'), null);
  a.marcar([{ clave: 'vigilante/x2', accion: 'arreglar' }]);
  t += 8 * 24 * 3600 * 1000;
  assert.strictEqual(D({ dataDir: datos, ahora: () => t }).accionDe('vigilante/x2'), null, 'vence sola');
  // sin disco, en memoria; un archivo roto no tira al sitio
  assert.strictEqual(D({ dataDir: null }).accionDe('vigilante/x1'), null);
  fs.writeFileSync(path.join(datos, 'mantenimiento-decididas.json'), '{roto');
  assert.strictEqual(D({ dataDir: datos }).accionDe('vigilante/x1'), null);
});

// Sitio_Envio_SeSigueSuNumero
// 🔴 Falla con: un envío que no se puede seguir cuando la conexión se corta (la pantalla no sabe si llegó), o un reenvío
//    con el mismo número que abre un segundo pedido.
test('T78 Sitio_Envio_SeSigueSuNumero — cómo terminó un envío se pregunta por su número', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, api, lead, confirmar }) => {
    const estado = async (id) => (await h.pedir(`/api/hallazgos/envio?id=${encodeURIComponent(id)}`, { cookie: lead })).json;
    assert.deepStrictEqual(await estado('envio-desconocido-1'), { estado: 'desconocido' });
    const r = await confirmar({ envio: 'envio-de-prueba-1', decisiones: [{ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar' }] });
    assert.strictEqual(r.json.ok, true, r.texto);
    const e = await estado('envio-de-prueba-1');
    assert.strictEqual(e.estado, 'listo');
    assert.strictEqual(e.resultado.ok, true);
    assert.deepStrictEqual(e.resultado.enviadas, ['vigilante/vig-uno']);
    // el mismo número otra vez: el mismo resultado, sin otro pedido
    const otra = await confirmar({ envio: 'envio-de-prueba-1', decisiones: [{ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar' }] });
    assert.deepStrictEqual(otra.json, r.json);
    assert.strictEqual(api.st.pedidos.length, 1);
    // un número sin forma no se acepta
    assert.strictEqual((await confirmar({ envio: 'a b', decisiones: [{ fuente: 'vigilante', id: 'vig-dos', accion: 'aceptar' }] })).status, 400);
    assert.strictEqual((await h.pedir('/api/hallazgos/envio?id=a%20b', { cookie: lead })).status, 400);
  });
});

// Mantenimiento_Envio_DiceQuePasa
// 🔴 Falla con: un «Enviando…» mudo, una pantalla que no averigua si llegó cuando la conexión se corta, un reenvío de
//    algo hecho mostrado como error, o un error que no dice qué hacer.
test('T79 Mantenimiento_Envio_DiceQuePasa — mientras envía, si tarda, si se corta y si ya estaba hecho', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, lead }) => {
    const p = await h.pedir('/mantenimiento', { cookie: lead });
    for (const [k, attr] of [['mant.envio.enviando', 'enviando'], ['mant.envio.lento', 'lento'], ['mant.envio.verificando', 'verificando'], ['mant.envio.yaEnviado', 'ya-enviado'], ['mant.envio.noLlego', 'no-llego']]) {
      assert.ok(p.texto.includes(`data-t-${attr}="${TX.t('es', k)}"`), `la barra trae «${k}»`);
    }
    // el sitio que contesta la página está despierto: ningún texto dice que dormía
    for (const k of ['mant.envio.enviando', 'mant.envio.lento']) assert.doesNotMatch(TX.t('es', k), /dormid/, `${k} no inventa la causa`);
    for (const k of ['mant.envio.error', 'mant.envio.noLlego']) assert.match(TX.t('es', k), /probá de nuevo/, `${k} dice qué hacer`);
    const cli = (await h.pedir('/hallazgos/cliente.js', { cookie: lead })).texto;
    assert.match(cli, /\/api\/hallazgos\/envio\?id=/, 'si se corta, pregunta cómo terminó');
    assert.match(cli, /AbortController/, 'con un tope de espera');
    assert.match(cli, /'ya_decidida'/, 'lo ya hecho no se muestra como error');
  });
});

// Mantenimiento_Cuentas_BajanConLoDecidido
// 🔴 Falla con: el menú, «Te toca decidir» o el subtítulo de la fuente contando una ficha que el sitio ya decidió
//    (con la foto todavía vieja), o una pantalla que saca la ficha y deja los números como estaban.
test('T80 Mantenimiento_Cuentas_BajanConLoDecidido — los tres números cuentan sólo lo que sigue esperando', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, ops, lead, enviar }) => {
    const antes = (await h.pedir('/mantenimiento', { cookie: lead })).texto;
    assert.match(antes, /Mantenimiento \(4\)<\/a>/);
    assert.match(antes, /<h2[^>]*>Te toca decidir \(4\)<\/h2>/);
    // la pantalla recuenta sola al sacar una ficha: cada número trae su molde
    assert.match(antes, /<h2 data-t="Te toca decidir \(\{n\}\)">/);
    assert.match(antes, /<h3 class="m-sub" data-fuente="ejecuciones" data-t="Ejecuciones del pipeline · \{n\}">Ejecuciones del pipeline · 1<\/h3>/);
    const cli = (await h.pedir('/hallazgos/cliente.js', { cookie: lead })).texto;
    assert.match(cli, /function recontar\(/, 'quitar una ficha recuenta los números');
    assert.ok(cli.includes(String.raw`replace(/\s*\(\d+\)$/, '')`), 'el número de la pestaña se reemplaza, no se suma');
    decisionYaEnMain(ops, 'ejecuciones', 'runs-review', EJ1.id);
    assert.strictEqual((await enviar(['ejecuciones', EJ1.id, 'aceptar'])).json.codigo, 'ya_decidida');
    const despues = (await h.pedir('/mantenimiento', { cookie: lead })).texto;
    assert.match(despues, /Mantenimiento \(3\)<\/a>/, 'el menú no cuenta lo ya decidido');
    assert.match(despues, /<h2[^>]*>Te toca decidir \(3\)<\/h2>/);
    assert.doesNotMatch(despues, /data-fuente="ejecuciones"/, 'sin fichas de la fuente, sin su subtítulo');
  });
});

// ── T80 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// 🔴 Falla con: decir «Enviar para aprobar» o «hasta que otra persona lo apruebe» cuando lo enviado se guarda sin que
// nadie más lo apruebe (site.auto_apply), o dejar de decirlo cuando sí hace falta otra persona.
test('T80 Mantenimiento_AplicaSolo_NoHablaDeAprobar — con auto_apply la pantalla no promete una aprobación que no hay', { timeout: 60000 }, async () => {
  await conSitio({ autoApply: true }, async ({ h, lead }) => {
    const p = (await h.pedir('/mantenimiento', { cookie: lead })).texto;
    assert.doesNotMatch(p, /Enviar para aprobar|otra persona lo apruebe/);
    assert.match(p, /<button type="button" class="btn prim m-enviar" disabled>Enviar<\/button>/);
    assert.match(p, /la revisión de esta noche lo aplica/);
    // las ayudas de archivar y arreglar tampoco esperan a otra persona
    assert.doesNotMatch(p, /otra persona aprueba tu envío/);
    assert.match(p, /<b>Archivar<\/b> quiere decir «esto es normal, no hay que tocar nada»\. Cuando lo enviás,/);
    assert.match(p, /<b>Arreglar<\/b> quiere decir «hay que corregirlo»\. Cuando lo enviás,/);
  });
  await conSitio({}, async ({ h, lead }) => {
    const p = (await h.pedir('/mantenimiento', { cookie: lead })).texto;
    assert.match(p, /<button type="button" class="btn prim m-enviar" disabled>Enviar para aprobar<\/button>/);
    assert.match(p, /Nada cambia hasta que otra persona lo apruebe/);
    assert.match(p, /<b>Archivar<\/b> quiere decir «esto es normal, no hay que tocar nada»\. Cuando otra persona aprueba tu envío,/);
  });
});

// ── T81 / T82 ────────────────────────────────────────────────────────────────────────────────────────────────────────

// Mantenimiento_YaDecididas_QueQuienCuandoYSiSeAplico
// 🔴 Falla con: no tener dónde ver lo ya decidido, perder quién decidió cuando la noche borra el archivo de la decisión,
//    decir «esta noche» de algo que la noche ya aplicó (o al revés), mostrar el correo entero, o guardarlo para siempre.
test('T81 Mantenimiento_YaDecididas_QueQuienCuandoYSiSeAplico — qué se decidió, quién, cuándo y si la noche ya lo aplicó', { timeout: 60000 }, async () => {
  const datos = tmp('site-findings-datos-');
  await conSitio({ autoApply: true, dataDir: datos }, async ({ h, api, ops, lead, lista, enviar, reloj }) => {
    const antes = (await h.pedir('/mantenimiento', { cookie: lead })).texto;
    assert.match(antes, /<details class="m-bloque m-decididas" hidden/, 'sin nada decidido, la sección está y no se ve: lo enviado pasa ahí sin recargar');
    const r = await enviar(['vigilante', 'vig-uno', 'aceptar']);
    assert.strictEqual(r.json.codigo, 'aplicado', r.texto);
    assert.deepStrictEqual(r.json.decididas, [{ clave: 'vigilante/vig-uno', accion: 'aceptar', quien: 'lead', el: '2026-10-25' }], 'la respuesta trae lo que pasa a «Ya decididas»');
    const esta = (await lista()).json;
    assert.deepStrictEqual(esta.decididas, [{ fuente: 'vigilante', id: 'vig-uno', nombre: 'Acme: un error que la noche marcó', accion: 'aceptar', quien: 'lead', el: '2026-10-25', estado: 'esta_noche' }]);
    assert.strictEqual(esta.cuentas.decididas, 1);
    // el pedido entra en main, el sitio trae la foto nueva, y la noche aplica la decisión y borra su archivo
    const noche = path.join(ops.raiz, 'noche');
    g(ops.raiz, 'clone', '-q', ops.bare, noche);
    for (const p of api.st.pedidos) g(noche, 'merge', '-q', '--no-edit', `origin/${p.head.ref}`);
    g(noche, 'push', '-q', 'origin', 'HEAD:main');
    g(ops.clon, 'pull', '-q', '--no-rebase');
    assert.strictEqual((await lista()).json.decididas[0].estado, 'esta_noche', 'en main y todavía en pending: la aplica esta noche');
    assert.strictEqual(CYCLE.aplicarDecisiones({ base: noche, fuente: 'vigilante' }).aplicadas.length, 1);
    g(noche, 'add', '-A'); g(noche, 'commit', '-q', '-m', 'la noche');
    g(noche, 'push', '-q', 'origin', 'HEAD:main');
    g(ops.clon, 'pull', '-q', '--no-rebase');
    assert.ok(!fs.existsSync(path.join(ops.clon, 'inbox', 'watcher', 'decisions', 'vig-uno.json')), 'la noche borró el archivo de la decisión');
    const despues = (await lista()).json;
    assert.deepStrictEqual(despues.decididas, [{ fuente: 'vigilante', id: 'vig-uno', nombre: 'Acme: un error que la noche marcó', accion: 'aceptar', quien: 'lead', el: '2026-10-25', estado: 'aplicada' }], 'quién y cuándo siguen aunque el archivo ya no esté');
    const p = (await h.pedir('/mantenimiento', { cookie: lead })).texto;
    assert.match(p, /<span class="m-tarea">Archivar · 25\/10 · lead · la noche ya guardó la decisión<\/span>/);
    // el correo de la sesión está en la cabecera de la página; en la sección y en la lista, no
    const seccion = p.slice(p.indexOf('<details class="m-bloque m-decididas"'), p.indexOf('</details>', p.indexOf('<details class="m-bloque m-decididas"')));
    assert.ok(!seccion.includes(LEAD) && !JSON.stringify(despues).includes(LEAD), 'sin el correo entero');
    // a los 30 días ya no se muestra
    reloj.t += 31 * 24 * 3600 * 1000;
    assert.deepStrictEqual((await lista()).json.decididas, []);
  });
});

// Mantenimiento_Numeros_CambianSinRecargar
// 🔴 Falla con: un número de la pantalla que queda viejo después de enviar hasta recargar: «Seguir las recomendaciones»,
//    «Ya decididas», o «Te toca decidir» vacío sin su frase.
test('T82 Mantenimiento_Numeros_CambianSinRecargar — cada número trae su molde y la pantalla los recuenta al enviar', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, lead }) => {
    const p = (await h.pedir('/mantenimiento', { cookie: lead })).texto;
    assert.match(p, /<button type="button" class="btn m-seguir" data-t="Seguir las recomendaciones \(\{n\}\)"/);
    assert.match(p, /<div class="m-bloque m-toca" data-t-vacio="Nada para decidir hoy\.">/);
    assert.match(p, /<details class="m-bloque m-decididas"[^>]* data-t-esta-noche="la aplica la revisión de esta noche"><summary data-t="Ya decididas \(\{n\}\)">/);
    const cli = (await h.pedir('/hallazgos/cliente.js', { cookie: lead })).texto;
    assert.match(cli, /function aDecididas\(/, 'lo decidido pasa a «Ya decididas»');
    // la fecha de la fila nueva: la expresión llega entera al navegador (en el molde, `\d` sin duplicar se pierde)
    assert.ok(cli.includes(String.raw`/^\d{4}-\d{2}-\d{2}$/.test(x.el || '')`), 'la fila que entra sin recargar lleva su fecha');
    assert.match(cli, /aDecididas\(j && j\.decididas\);\s*\/\/[^\n]*\n\s*\(\(j && j\.omitidas\)/, 'antes de sacar las omitidas, que se llevan su título');
    const recontar = cli.slice(cli.indexOf('function recontar('), cli.indexOf('function aDecididas('));
    for (const x of ['.m-seguir', 'article[data-recomendada]', '.m-decididas', 'data-t-vacio']) assert.ok(recontar.includes(x), `recontar actualiza ${x}`);
  });
});

// ── las dependencias se deciden acá: aceptar mergea su pull request, rechazar lo cierra con el motivo ──────────────────

const DEP_PR = 'id: dep-pr\ndetectado: 2026-10-20\nveredicto: pendiente\npaquete: pkg-pr\nseveridad: high\nnoches: 2\npr: 7\npr_repo: acme/ops\nrepos:\n  - Producto X/FrontEnd\n';
const DEP_RECH = 'id: dep-rech\ndetectado: 2026-10-18\nveredicto: pendiente\npaquete: pkg-rechazado\nseveridad: low\nnoches: 4\npr: 8\npr_repo: acme/ops\nrechazado: 2026-10-21\nmotivo_rechazo: "rompe el build"\n';
const DEP_FALLO = 'id: dep-fallo\ndetectado: 2026-10-19\nveredicto: pendiente\npaquete: pkg-fallo\nseveridad: moderate\nnoches: 3\npr: 9\npr_repo: acme/ops\ndecision_fallida: 2026-10-25\nmotivo_decision_fallida: "el pedido 9 ya no estaba abierto"\n';
const EXTRA_DEP = { 'inbox/dependencies/pending/dep-pr.yaml': DEP_PR, 'inbox/dependencies/pending/dep-rech.yaml': DEP_RECH };
const decidir = (fuente, id, accion, motivo) => ({ fuente, id, accion, ...(motivo === undefined ? {} : { motivo }) });

// Mantenimiento_Dependencias_FilasParaDecidir
// 🔴 Falla con: una dependencia pendiente que no se puede decidir acá, Archivar o Arreglar en lugar de Aceptar o
//    Rechazar, sin el lugar para el motivo, sin el enlace a su pull request, una ya rechazada que se vuelve a preguntar,
//    o un número de la pestaña que no la cuenta.
test('T83 Mantenimiento_Dependencias_FilasParaDecidir — cada dependencia pendiente es una fila con Aceptar o Rechazar', { timeout: 60000 }, async () => {
  await conSitio({ extra: EXTRA_DEP }, async ({ h, lead, lista, fila }) => {
    const j = (await lista()).json;
    const conPedido = fila(j, 'dependencias', 'dep-pr');
    assert.ok(conPedido, JSON.stringify(j.toca.map((x) => x.id)));
    assert.deepStrictEqual(conPedido.pedido, { numero: 7, enlace: 'https://github.com/acme/ops/pull/7' });
    const sinPedido = fila(j, 'dependencias', 'dep-uno');
    assert.ok(sinPedido, 'la que no tiene pull request también se decide');
    assert.strictEqual(sinPedido.pedido, null);
    assert.strictEqual(fila(j, 'dependencias', 'dep-rech'), undefined, 'la ya rechazada no se vuelve a preguntar');
    assert.strictEqual(j.cuentas.toca, j.toca.length);
    const p = (await h.pedir('/mantenimiento', { cookie: lead })).texto;
    const carta = cartaDe(p, 'dependencias/dep-pr');
    assert.match(carta, /data-accion="aceptar"[^>]*>Aceptar</);
    assert.match(carta, /data-accion="reject"[^>]*>Rechazar</);
    assert.doesNotMatch(carta, /data-accion="arreglar"|>Archivar</);
    assert.match(carta, /<input[^>]* class="m-motivo"[^>]* maxlength="180"/);
    assert.match(carta, /href="https:\/\/github\.com\/acme\/ops\/pull\/7"/);
    assert.match(p, /<h3 class="m-sub" data-fuente="dependencias"/);
    const menu = (/<nav[\s\S]*?<\/nav>/.exec((await h.pedir('/corridas', { cookie: lead })).texto) || [''])[0];
    assert.match(menu, new RegExp(`Mantenimiento \\(${j.toca.length}\\)<`), 'el número de la pestaña las cuenta');
    const cli = (await h.pedir('/hallazgos/cliente.js', { cookie: lead })).texto;
    assert.match(cli, /'reject'/, 'el navegador recuerda también Rechazar');
    assert.match(cli, /if \(acciones\[k\] === 'reject'\) d\.motivo = motivoDe\(k\);/, 'y manda el motivo del rechazo');
    assert.match(cli, /if \(!ks\.length \|\| faltaMotivo\(\)\) return;/, 'un rechazo sin motivo no se envía');
  });
});

// Sitio_Dependencias_EnvioLlevaElPedidoDeLaFicha
// 🔴 Falla con: un pedido o un repo que vienen del navegador en lugar de la ficha (la noche mergearía otro pull
//    request), un rechazo sin su motivo, una decisión que la noche no acepta, o un envío que no pasa a «Esperando
//    aprobación».
test('T84 Sitio_Dependencias_EnvioLlevaElPedidoDeLaFicha — el pull request sale de la ficha; el motivo, de la persona', { timeout: 60000 }, async () => {
  await conSitio({ extra: EXTRA_DEP }, async ({ api, ops, confirmar, lista }) => {
    const r = await confirmar({ decisiones: [{ ...decidir('dependencias', 'dep-pr', 'aceptar'), pr: '999', pr_repo: 'otro/repo' }, decidir('dependencias', 'dep-uno', 'reject', '  No aplica a nuestro uso  ')] });
    assert.strictEqual(r.json.ok, true, r.texto);
    assert.strictEqual(api.st.pedidos.length, 1);
    const p = api.st.pedidos[0];
    const doc = (ruta) => JSON.parse(g(ops.bare, 'show', `${p.head.ref}:${ruta}`));
    const a = doc('inbox/dependencies/decisions/dep-pr.json');
    const b = doc('inbox/dependencies/decisions/dep-uno.json');
    assert.deepStrictEqual(a, { fuente: 'dependencias', id: 'dep-pr', accion: 'aceptar', quien: LEAD, el: '2026-10-25', pr: '7', pr_repo: 'acme/ops' });
    assert.deepStrictEqual(b, { fuente: 'dependencias', id: 'dep-uno', accion: 'reject', quien: LEAD, el: '2026-10-25', pr: null, pr_repo: null, motivo: 'No aplica a nuestro uso' });
    assert.ok(CYCLE.decisionConForma(a, 'dependencias', 'dep-pr') && CYCLE.decisionConForma(b, 'dependencias', 'dep-uno'), 'la noche las acepta');
    assert.match(p.body, /dependencias\/dep-pr → aceptar/);
    assert.match(p.body, /dependencias\/dep-uno → reject/);
    const j = (await lista()).json;
    assert.deepStrictEqual(j.espera.flatMap((x) => x.filas).map((x) => [x.id, x.accion]).sort(), [['dep-pr', 'aceptar'], ['dep-uno', 'reject']]);
  });
});

// Sitio_Dependencias_MotivoYAcciones
// 🔴 Falla con: un rechazo sin motivo, con un salto de línea o de más de 180 caracteres, un motivo en un aceptar, o
//    una acción de otra fuente (Arreglar en una dependencia, Rechazar en el vigilante) que abre un pedido.
test('T85 Sitio_Dependencias_MotivoYAcciones — el motivo es obligatorio, de una línea y con tope; cada fuente, sus acciones', { timeout: 60000 }, async () => {
  await conSitio({ extra: EXTRA_DEP }, async ({ api, confirmar }) => {
    const malos = [
      decidir('dependencias', 'dep-pr', 'reject'),
      decidir('dependencias', 'dep-pr', 'reject', ''),
      decidir('dependencias', 'dep-pr', 'reject', '   '),
      decidir('dependencias', 'dep-pr', 'reject', 'una línea\notra'),
      decidir('dependencias', 'dep-pr', 'reject', 'x'.repeat(181)),
      decidir('dependencias', 'dep-pr', 'reject', 123),
      decidir('dependencias', 'dep-pr', 'aceptar', 'sobra'),
      decidir('dependencias', 'dep-pr', 'arreglar'),
      decidir('vigilante', 'vig-uno', 'reject', 'no va'),
    ];
    for (const m of malos) {
      const r = await confirmar({ decisiones: [m] });
      assert.strictEqual(r.status, 400, `${JSON.stringify(m).slice(0, 80)}: ${r.texto}`);
    }
    assert.strictEqual(api.st.pedidos.length, 0, 'ninguno abre un pedido');
    const justo = await confirmar({ decisiones: [decidir('dependencias', 'dep-pr', 'reject', 'x'.repeat(180))] });
    assert.strictEqual(justo.json.ok, true, justo.texto);
  });
});

// Sitio_Dependencias_SoloQuienMantiene
// 🔴 Falla con: otro rol que decide una dependencia mandando el pedido a mano (esconder el botón no alcanza).
test('T86 Sitio_Dependencias_SoloQuienMantiene — el servidor no deja a otro rol aceptar ni rechazar', { timeout: 60000 }, async () => {
  await conSitio({ extra: EXTRA_DEP }, async ({ api, tok, dev, confirmar }) => {
    for (const d of [decidir('dependencias', 'dep-pr', 'aceptar'), decidir('dependencias', 'dep-pr', 'reject', 'no')]) {
      const r = await confirmar({ decisiones: [d] }, dev, tok);
      assert.strictEqual(r.status, 403, r.texto);
    }
    assert.strictEqual(api.st.pedidos.length, 0);
  });
});

// Mantenimiento_Dependencias_DecisionNoAplicadaVuelve
// 🔴 Falla con: una decisión que la noche no pudo aplicar y la fila sigue escondida (un éxito callado), «Ya decididas»
//    que la da por aplicada, o la que sí espera la noche de vuelta en «Te toca decidir».
test('T87 Mantenimiento_Dependencias_DecisionNoAplicadaVuelve — lo que la noche no aplicó vuelve a «Te toca decidir» y lo dice', { timeout: 60000 }, async () => {
  const datos = tmp('site-findings-datos-');
  const anotada = (el) => ({ accion: 'aceptar', en: AHORA - 3600 * 1000, quien: LEAD, el });
  fs.writeFileSync(path.join(datos, 'mantenimiento-decididas.json'), JSON.stringify({ 'dependencias/dep-fallo': anotada('2026-10-24'), 'dependencias/dep-pr': anotada('2026-10-25') }));
  const extra = { ...EXTRA_DEP, 'inbox/dependencies/pending/dep-fallo.yaml': DEP_FALLO };
  await conSitio({ extra, dataDir: datos }, async ({ h, lead, lista, fila }) => {
    const j = (await lista()).json;
    assert.ok(fila(j, 'dependencias', 'dep-fallo'), 'la que no se aplicó vuelve');
    assert.strictEqual(fila(j, 'dependencias', 'dep-pr'), undefined, 'la que espera la noche, no');
    const estado = Object.fromEntries(j.decididas.map((x) => [x.id, x.estado]));
    assert.deepStrictEqual([estado['dep-fallo'], estado['dep-pr']], ['no_aplicada', 'esta_noche']);
    const p = (await h.pedir('/mantenimiento', { cookie: lead })).texto;
    assert.match(cartaDe(p, 'dependencias/dep-fallo'), /La noche no pudo aplicar la decisión del 25\/10: el pedido 9 ya no estaba abierto/);
    assert.match(p, /<li data-ficha="dependencias\/dep-fallo">[^\n]*la noche no la pudo aplicar/);
  });
});

// Inicio_DependenciasPorDecidir_MismoNumeroQueMantenimiento
// 🔴 Falla con: el recuadro de Inicio con otro número que las filas de Mantenimiento a las que lleva (las nuevas de
//    anoche en lugar de todas las que esperan), o que sigue contando una ya enviada.
test('T88 Inicio_DependenciasPorDecidir_MismoNumeroQueMantenimiento — el número de Inicio es el de las filas de Mantenimiento', { timeout: 60000 }, async () => {
  await conSitio({ extra: EXTRA_DEP }, async ({ h, lead, lista, confirmar }) => {
    const recuadro = async () => {
      const p = (await h.pedir('/', { cookie: lead })).texto;
      const r = p.split('<div class="tile ').find((x) => x.includes('<div class="t-label">Dependencias por decidir</div>')) || '';
      assert.match(r, /href="\/mantenimiento"/, 'lleva a Mantenimiento');
      return Number((/<div class="t-val">(\d+)<\/div>/.exec(r) || [])[1]);
    };
    const filas = async () => (await lista()).json.toca.filter((x) => x.fuente === 'dependencias').length;
    assert.strictEqual(await filas(), 2, 'dep-uno y dep-pr esperan; la rechazada, no');
    assert.strictEqual(await recuadro(), 2);
    assert.strictEqual((await confirmar({ decisiones: [decidir('dependencias', 'dep-pr', 'aceptar')] })).json.ok, true);
    assert.strictEqual(await filas(), 1);
    assert.strictEqual(await recuadro(), 1, 'la enviada deja de contarse en los dos lados');
  });
});

// Mantenimiento_Dependencias_RedecidirElMismoDia
// 🔴 Falla con: una decisión tomada después de leer la falla, el mismo día en que la noche la anotó, que el sitio
//    ignora (la fila vuelve a «Te toca decidir», se cuenta otra vez y «Ya decididas» dice que no se aplicó).
test('T89 Mantenimiento_Dependencias_RedecidirElMismoDia — decidir otra vez tras leer la falla vale aunque sea el mismo día', { timeout: 60000 }, async () => {
  const datos = tmp('site-findings-datos-');
  // la falla es del 25/10 y la persona vuelve a decidir ese mismo día (hoy, en la prueba), después de verla
  const extra = { 'inbox/dependencies/pending/dep-fallo.yaml': DEP_FALLO };
  await conSitio({ extra, dataDir: datos, autoApply: true }, async ({ lista, fila, confirmar }) => {
    assert.ok(fila((await lista()).json, 'dependencias', 'dep-fallo'), 'la que no se aplicó está para decidir');
    const r = await confirmar({ decisiones: [decidir('dependencias', 'dep-fallo', 'aceptar')] });
    assert.strictEqual(r.json.ok, true, r.texto);
    const guardada = JSON.parse(fs.readFileSync(path.join(datos, 'mantenimiento-decididas.json'), 'utf8'))['dependencias/dep-fallo'];
    assert.deepStrictEqual([guardada.el, guardada.vio], ['2026-10-25', '2026-10-25'], 'recuerda la falla que tenía a la vista');
    const j = (await lista()).json;
    assert.strictEqual(fila(j, 'dependencias', 'dep-fallo'), undefined, 'la nueva decisión no se tapa con la falla vieja');
    assert.strictEqual(j.decididas.find((x) => x.id === 'dep-fallo').estado, 'esta_noche');
  });
});

// Mantenimiento_Cuenta_PlataformaCaidaNoSeReconsulta
// 🔴 Falla con: con la plataforma de pedidos caída, cada página que muestra el número del menú vuelve a preguntarle
//    (una consulta remota y una línea de registro por página abierta, sin espera).
test('T90 Mantenimiento_Cuenta_PlataformaCaidaNoSeReconsulta — si la plataforma no contesta, se vuelve a preguntar al minuto', { timeout: 60000 }, async () => {
  const opsDoc = { version: 1, owners: { default: LEAD }, site: { access: [{ role: 'maintainer', emails: [LEAD] }] } };
  const ops = armarOperaciones({ opsDoc, extra: EXTRA_DEP });
  const fuentes = H.fuentesFijas({ config: opsDoc });
  fuentes.clones = () => ({ operaciones: { dir: ops.clon }, perfil: null });
  const env = H.envBase({ SITE_OIDC_ISSUER: 'https://emisor.acme.example', SITE_OPERATIONS_REPO: 'https://github.com/acme/ops', SITE_OPERATIONS_WRITE_TOKEN: ESCRITURA });
  const cfg = validarConfiguracion(env).cfg;
  let llamadas = 0;
  const fetch = async () => { llamadas++; return new Response('', { status: 503 }); };
  const reloj = { t: AHORA };
  const rutas = FINDINGS().crearRutas({ cfg, fuentes, ahora: () => reloj.t, fetch, urlBase: { github: 'http://127.0.0.1:9' } });
  const cuenta = rutas.find((r) => r.pestana && r.pestana.id === 'mantenimiento').pestana.cuenta;
  const pausa = () => new Promise((r) => setTimeout(r, 20));
  const n = cuenta();
  assert.ok(Number.isInteger(n) && n > 0, 'el número sale sin esperar a la plataforma');
  for (let i = 0; i < 5; i++) { assert.strictEqual(cuenta(), n, 'y no cambia porque la plataforma no conteste'); await pausa(); }
  const primeras = llamadas;
  assert.ok(primeras >= 1, 'pregunta de fondo una vez');
  for (let i = 0; i < 5; i++) { cuenta(); await pausa(); }
  assert.strictEqual(llamadas, primeras, 'en el mismo minuto no vuelve a preguntar');
  reloj.t += 61 * 1000;
  cuenta(); await pausa();
  assert.ok(llamadas > primeras, 'pasado el minuto, vuelve a preguntar');
});

// ── la carta de una dependencia dice qué es la vulnerabilidad y qué sugiere el modelo ─────────────────────────────────

const DEP_AVISO = 'id: dep-aviso\ndetectado: 2026-10-20\nveredicto: pendiente\npaquete: pkg-aviso\nseveridad: high\nnoches: 2\npr: 7\npr_repo: acme/ops\nrepos:\n  - Producto X/FrontEnd\n'
  + 'avisos:\n  - https://github.com/advisories/GHSA-2345-6789-cfgh\n'
  + 'aviso_resumen: "Denial of Service via RouterLink <img src=x onerror=alert(1)> in SSR (CVE-2026-111751)"\naviso_parche: "22.2.1, 21.2.25"\n'
  + 'propuesta_accion: revisar\npropuesta_razon: "Antes de aceptar, mirá si el sitio usa la representación del lado del servidor"\npropuesta_modelo: gemma4:31b\n';
const DEP_SIN_AVISO = 'id: dep-sinaviso\ndetectado: 2026-10-21\nveredicto: pendiente\npaquete: pkg-sinaviso\nseveridad: low\nnoches: 1\nrepos:\n  - Producto X/FrontEnd\n'
  + 'aviso_motivo: no-se-pudo-leer\npropuesta_accion: aceptar\npropuesta_razon: "Una razón sin el aviso"\n';
const DEP_VIEJA = 'id: dep-vieja\ndetectado: 2026-10-19\nveredicto: pendiente\npaquete: pkg-vieja\nseveridad: low\nnoches: 3\nrepos:\n  - Producto X/FrontEnd\n'
  + 'propuesta_accion: arreglar\npropuesta_razon: "Se detectó una vulnerabilidad de severidad alta"\n';
const EXTRA_AVISO = { 'inbox/dependencies/pending/dep-aviso.yaml': DEP_AVISO, 'inbox/dependencies/pending/dep-sinaviso.yaml': DEP_SIN_AVISO, 'inbox/dependencies/pending/dep-vieja.yaml': DEP_VIEJA };

// Mantenimiento_Dependencia_QueEsYSugerencia
// 🔴 Falla con: una carta sin qué es la vulnerabilidad o sin la versión que la corrige, sin la sugerencia del modelo y
//    su por qué, el texto del aviso sin escapar, una sugerencia en la carta cuyo aviso no se pudo leer, la propuesta
//    vieja (hecha sin el aviso) mostrada como sugerencia, o la sugerencia marcada como recomendada para seguirla en
//    bloque.
test('T91 Mantenimiento_Dependencia_QueEsYSugerencia — la carta dice qué es la vulnerabilidad y qué sugiere el modelo', { timeout: 60000 }, async () => {
  await conSitio({ extra: EXTRA_AVISO }, async ({ h, lead, lista, fila }) => {
    const j = (await lista()).json;
    const con = fila(j, 'dependencias', 'dep-aviso');
    assert.deepStrictEqual(con.aviso, { resumen: 'Denial of Service via RouterLink <img src=x onerror=alert(1)> in SSR (CVE-2026-111751)', parche: '22.2.1, 21.2.25' });
    assert.deepStrictEqual(con.propuesta, { accion: 'revisar', razon: 'Antes de aceptar, mirá si el sitio usa la representación del lado del servidor' });
    assert.strictEqual(con.recomendada, null, 'la sugerencia no se sigue en bloque');
    assert.deepStrictEqual(fila(j, 'dependencias', 'dep-sinaviso').aviso, { sin_leer: true });
    assert.strictEqual(fila(j, 'dependencias', 'dep-sinaviso').propuesta, null);
    assert.strictEqual(fila(j, 'dependencias', 'dep-vieja').aviso, null);
    assert.strictEqual(fila(j, 'dependencias', 'dep-vieja').propuesta, null, 'la de antes del aviso no se muestra');
    const p = (await h.pedir('/mantenimiento', { cookie: lead })).texto;
    const carta = cartaDe(p, 'dependencias/dep-aviso');
    assert.match(carta, /<p class="m-aviso"><b>Qué es:<\/b> <span lang="en">Denial of Service via RouterLink &lt;img src=x onerror=alert\(1\)&gt; in SSR \(CVE-2026-111751\)<\/span> Se corrige en la versión 22\.2\.1, 21\.2\.25\.<\/p>/);
    assert.doesNotMatch(carta, /<img/);
    assert.match(carta, /<p class="m-propuesta">Sugerencia del modelo: mirá algo antes de decidir\. <span lang="es">Antes de aceptar, mirá si el sitio usa la representación del lado del servidor<\/span><\/p>/);
    assert.doesNotMatch(carta, /class="m-elegir recomendada"/);
    const sin = cartaDe(p, 'dependencias/dep-sinaviso');
    assert.match(sin, /No se pudo leer el aviso de seguridad: sin él, el modelo no sugiere nada\./);
    assert.doesNotMatch(sin, /m-propuesta|Una razón sin el aviso/);
    assert.doesNotMatch(cartaDe(p, 'dependencias/dep-vieja'), /m-aviso|m-propuesta/);
  });
});
