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
const MARCAS = ['pkg-uno', 'errores-500', 'lentitud', 'Se saltó el pase adversarial', 'Las pruebas quedaron en rojo', 'dep-uno', 'vig-uno', EJ1.id];

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
async function conSitio({ politica = true, autoApply = false, extra = {}, clones } = {}, fn) {
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
    await fn({ h, api, ops, lead, dev, tok, lista, confirmar, enviar, fila, reloj, llamadasPedidos, entrar });
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
    // te toca decidir: el vigilante primero, después ejecuciones; dependencias nunca
    assert.deepStrictEqual(j.toca.map((x) => `${x.fuente}/${x.id}`), ['vigilante/vig-uno', 'vigilante/vig-dos', `ejecuciones/${EJ1.id}`]);
    assert.deepStrictEqual(j.espera, []);
    assert.deepStrictEqual(j.cuentas, { toca: 3, espera: 0, marcha: 2 });
    // las de antes no traen análisis: sin analizar, con su motivo en llano, y sin recomendación
    const e1 = fila(j, 'ejecuciones', EJ1.id);
    assert.strictEqual(e1.analisis, null);
    assert.strictEqual(e1.recomendada, null);
    assert.match(e1.sin_analizar, /^Sin analizar: el modelo no lo analizó todavía\./);
    // en marcha: el arreglo con su tarea (el enlace guardado) y sin el correo de quien la tiene
    assert.deepStrictEqual(j.marcha.arreglos, [{ fuente: 'ejecuciones', id: EJ2.id, nombre: 'Las pruebas quedaron en rojo', estado: 'tarea',
      tarea: { numero: '77', enlace: 'https://dev.acme.example/acme/_workitems/edit/77' }, asignado: null, motivo: null }]);
    // y la vulnerabilidad, con la tarea de su proyecto armada con la organización de operations.json
    assert.deepStrictEqual(j.marcha.vulnerabilidades, [{ id: 'dep-uno', paquete: 'pkg-uno', severidad: 'high', repos: 1, desde: '2026-10-19', volvio: null,
      tareas: [{ proyecto: 'Producto X', numero: '5002', enlace: 'https://dev.azure.com/acme/Producto%20X/_workitems/edit/5002', asignado: null }], motivo: null }]);
    // la página: tarjetas, no tabla; los números son enlaces; nada de lo que no se muestra
    const p = await h.pedir('/mantenimiento', { cookie: lead });
    assert.strictEqual(p.status, 200);
    assert.match(p.texto, /<h1>Mantenimiento<\/h1>/);
    assert.doesNotMatch(p.texto, /<table/);
    assert.strictEqual((p.texto.match(/<article class="m-carta[^"]*" data-ficha="/g) || []).length, 3, 'una tarjeta por ficha que espera decisión');
    assert.match(p.texto, /Te toca decidir \(3\)/);
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
    assert.deepStrictEqual(j.toca.map((x) => x.id), ['vig-dos']);
    assert.deepStrictEqual(j.espera, [{ numero: 1, enlace: api.st.pedidos[0].html_url, aprobado: false, filas: [
      { fuente: 'vigilante', id: 'vig-uno', nombre: 'errores-500', accion: 'aceptar' },
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
    assert.deepStrictEqual(caida.toca.map((x) => x.id).sort(), ['vig-dos', 'vig-uno', EJ1.id].sort());
    // y sin saber qué espera aprobación no se envía: podría abrir un segundo pedido para una ficha ya enviada
    const pedidosAntes = api.st.pedidos.length;
    const aCiegas = await enviar(['vigilante', 'vig-uno', 'arreglar']);
    assert.strictEqual(aCiegas.json.codigo, 'sin_pedidos', aCiegas.texto);
    assert.strictEqual(api.st.pedidos.length, pedidosAntes, 'ningún pedido a ciegas');
    // la falla no se guarda: vuelta la plataforma, la lectura siguiente pregunta otra vez sin esperar el minuto
    api.st.exigirAuth = null;
    const vuelta = (await lista()).json;
    assert.strictEqual(vuelta.pedidos.estado, 'leido');
    assert.deepStrictEqual(vuelta.toca, []);
    assert.ok(fila(caida, 'vigilante', 'vig-uno'));
  });
});

// Sitio_PedidoViejoDeLaNoche_SeDecideIgual @story-4.11 @ac-20
// 🔴 Falla con: una ficha que tiene el pedido viejo de la noche fuera de «Te toca decidir», o una vulnerabilidad que se
// pueda decidir desde el sitio.
test('T37c Sitio_PedidoViejoDeLaNoche_SeDecideIgual — la ficha con el pedido viejo se decide acá; la de paquetes, no @story-4.11 @ac-20', { timeout: 60000 }, async () => {
  const extra = {
    'inbox/dependencies/promoted/dep-mov.yaml': 'id: dep-mov\ndetectado: 2026-10-19\nveredicto: pendiente # decision-en-curso\npaquete: pkg-movido\nseveridad: critical\nnoches: 2\n',
    'inbox/watcher/pending/vig-uno.yaml': `${FICHAS['inbox/watcher/pending/vig-uno.yaml']}pr: 123\n`,
  };
  await conSitio({ extra }, async ({ api, lista, enviar, fila }) => {
    const j = (await lista()).json;
    assert.ok(fila(j, 'vigilante', 'vig-uno'), 'con el pedido viejo de la noche, igual se decide');
    assert.ok(!j.toca.some((x) => x.fuente === 'dependencias'));
    // la crítica primero, sin tarea todavía
    assert.deepStrictEqual(j.marcha.vulnerabilidades.map((x) => [x.id, x.severidad, x.tareas.length]), [['dep-mov', 'critical', 0], ['dep-uno', 'high', 1]]);
    const r = await enviar(['vigilante', 'vig-uno', 'aceptar']);
    assert.strictEqual(r.json.ok, true, r.texto);
    assert.strictEqual(api.st.pedidos.length, 1);
    const dep = await enviar(['dependencias', 'dep-uno', 'arreglar']);
    assert.strictEqual(dep.status, 400);
    assert.match(dep.json.message, /las vulnerabilidades de paquetes no se deciden acá/);
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
// 🔴 Falla con: seguir ofreciendo decidir (o abrir otro pedido) cuando la decisión ya está en main.
test('T58 Sitio_DecisionEnMain_AprobadoSeAplicaEstaNoche — con la decisión en main, la fila espera la noche y no se reenvía @story-4.11 @ac-22', { timeout: 60000 }, async () => {
  const extra = { 'inbox/watcher/decisions/vig-uno.json': `${JSON.stringify({ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar', quien: LEAD, el: '2026-10-24' })}\n` };
  await conSitio({ extra }, async ({ h, api, lead, lista, enviar }) => {
    const j = (await lista()).json;
    assert.ok(!j.toca.some((x) => x.id === 'vig-uno'));
    assert.deepStrictEqual(j.espera, [{ numero: null, enlace: null, aprobado: true, filas: [{ fuente: 'vigilante', id: 'vig-uno', nombre: 'errores-500', accion: 'aceptar' }] }]);
    const p = await h.pedir('/mantenimiento', { cookie: lead });
    assert.match(p.texto, /Aprobado: se aplica esta noche/);
    assert.match(p.texto, /errores-500 → Archivar/);
    // y un envío tardío no abre otro pedido
    const r = await enviar(['vigilante', 'vig-uno', 'arreglar']);
    assert.strictEqual(r.json.codigo, 'nada_que_enviar');
    assert.strictEqual(api.st.pedidos.length, 0);
  });
});

// ── T66 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Mantenimiento_Vulnerabilidades_Seguimiento @story-4.11 @ac-20
// 🔴 Falla con: un botón en una vulnerabilidad, una tarea sin enlace con número, el correo de quien la tiene, o la frase
// de la deuda repetida por fila.
test('T66 Mantenimiento_Vulnerabilidades_Seguimiento — paquetes: severidad, repos, desde, la tarea de cada proyecto y quién la tiene', { timeout: 60000 }, async () => {
  const extra = {
    'inbox/dependencies/pending/dep-uno.yaml': `${FICHAS['inbox/dependencies/pending/dep-uno.yaml']}  - Producto Y: 5003\nasignados:\n  - "5002: Ana Pérez"\n  - "5003: dev.a@acme.example"\nreaparecido: 2026-10-22\n`,
    'inbox/dependencies/pending/dep-sin.yaml': 'id: dep-sin\ndetectado: 2026-09-09\nveredicto: pendiente\npaquete: pkg-sin\nseveridad: high\nnoches: 9\npedido_motivo: sin-proyecto\nrepos:\n  - A/x\n  - B/y\n',
  };
  await conSitio({ extra }, async ({ h, lead, lista }) => {
    const v = (await lista()).json.marcha.vulnerabilidades;
    // críticas primero; después, la más vieja
    assert.deepStrictEqual(v.map((x) => x.id), ['dep-sin', 'dep-uno']);
    assert.deepStrictEqual(v[1].tareas.map((t) => [t.proyecto, t.numero, t.asignado]), [['Producto X', '5002', 'Ana Pérez'], ['Producto Y', '5003', null]]);
    assert.strictEqual(v[1].volvio, '2026-10-22');
    assert.strictEqual(v[0].motivo, 'sin-proyecto');
    const p = await h.pedir('/mantenimiento', { cookie: lead });
    const bloque = (/<details class="m-vulns"[\s\S]*?<\/details>\s*<p class="m-deuda/.exec(p.texto) || [''])[0];
    assert.ok(bloque, 'el bloque de vulnerabilidades, cerrado');
    assert.match(p.texto, /Vulnerabilidades de paquetes: 2 \(0 críticas, 2 altas\)\. Cada equipo ya tiene su tarea\. La más vieja, desde el 09\/09\./);
    assert.match(bloque, /en 2 repos · desde 09\/09/);
    assert.match(bloque, /en 1 repo · desde 19\/10 · volvió el 22\/10/);
    assert.match(bloque, /<summary>2 tareas<\/summary>/);
    assert.match(bloque, /Tarea 5002 \(Producto X\)<\/a> · asignada a Ana Pérez/);
    // la tarea sin persona lo dice, en vez de callarlo
    assert.match(bloque, /Tarea 5003 \(Producto Y\)<\/a> · sin asignar/);
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
    assert.deepStrictEqual([...new Set(j.toca.map((x) => x.fuente))].sort(), ['ejecuciones', 'vigilante']);
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
    assert.strictEqual(fila(j, 'ejecuciones', C.id).sin_analizar, 'Sin analizar: el análisis del modelo no citaba ningún dato o repetía el problema, y se descartó. Con estos datos solos no alcanza para decidir; la noche lo vuelve a intentar.');
    const p = await h.pedir('/mantenimiento', { cookie: lead });
    const a = cartaDe(p.texto, `ejecuciones/${A.id}`);
    assert.match(a, /Por qué:<\/b> <span lang="es">Su tope es de 2 s/);
    assert.match(a, /Recomienda Arreglar:<\/b> <span lang="es">no es una falla del arnés/);
    assert.match(a, /Si se arregla:<\/b> <span lang="es">separar los avisos/);
    assert.match(a, /Análisis de una persona/);
    assert.match(a, /<button type="button" class="m-elegir recomendada" data-accion="arreglar" aria-pressed="false">Arreglar<\/button>/);
    assert.doesNotMatch(p.texto.slice(p.texto.indexOf('id="hallazgos"')), /aria-pressed="true"/, 'nada elegido de entrada');
    const b = cartaDe(p.texto, `ejecuciones/${B.id}`);
    assert.match(b, /Si vuelve:<\/b> <span lang="es">limitar las sesiones/);
    assert.match(b, /Análisis del modelo de la noche/);
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
    assert.match(en, /Your decision \(3\)/);
    assert.match(en, /<b>Archive<\/b> means/);
    assert.match(en, /Send for approval/);
  });
});

// Mantenimiento_MenuConCuantasEsperan
// 🔴 Falla con: el menú sin el número de lo que espera decisión, un número que cuenta lo decidido, lo de paquetes o lo
// que cuenta aparte, o un «(0)» cuando no queda nada.
test('T74 Mantenimiento_MenuConCuantasEsperan — al lado del nombre, cuántas fichas esperan decisión; sin ninguna, sin número', { timeout: 90000 }, async () => {
  const enlace = (html) => (/<a href="\/mantenimiento"[^>]*>([\s\S]*?)<\/a>/.exec(html) || [])[1];
  // las que esperan: vig-uno, vig-dos y la de ejecuciones; ni la de paquetes, ni EJ2 (decidida), ni la que cuenta aparte
  const APARTE = CYCLE.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-ESCAPE:GIT_NO_VERIFY/laboratorio', nombre: 'commit sin controles', hoy: '2026-10-22' });
  await conSitio({ extra: extraDe(APARTE) }, async ({ h, lead, lista }) => {
    assert.match(enlace((await h.pedir('/corridas', { cookie: lead })).texto), /Mantenimiento \(3\)$/);
    assert.match(enlace((await h.pedir('/mantenimiento', { cookie: `${lead}; sitio-idioma=en` })).texto), /Maintenance \(3\)$/);
    assert.ok(!(await lista()).json.toca.some((x) => x.id === APARTE.id), 'lo que cuenta aparte no se pregunta');
  });
  // una con su decisión en main ya no espera; la del pedido viejo de la noche, sí
  const extra = {
    'inbox/watcher/decisions/vig-uno.json': `${JSON.stringify({ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar', quien: LEAD, el: '2026-10-24' })}\n`,
    'inbox/watcher/pending/vig-dos.yaml': `${FICHAS['inbox/watcher/pending/vig-dos.yaml']}pr: 123\n`,
  };
  await conSitio({ extra }, async ({ h, lead }) => {
    assert.match(enlace((await h.pedir('/corridas', { cookie: lead })).texto), /Mantenimiento \(2\)$/);
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
