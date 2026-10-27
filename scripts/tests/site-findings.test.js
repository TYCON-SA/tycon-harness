'use strict';
/*
 * site-findings.test.js — la pestaña «Pendientes», lo que encontró la noche: una fila por ficha viva de las tres fuentes,
 * que quien mantiene confirma con un clic. El clic abre un pedido al repo de operaciones con un archivo de decisión; la
 * noche que lo ve en main lo aplica (scripts/nightly/findings/cycle.js).
 *
 *   T31 Sitio_SeccionUnaFilaPorFicha            T37 Sitio_SegundoClic_NoAbreOtro
 *   T32 Sitio_SoloQuienMantiene                 T38 Sitio_SinClon_UnaFrase
 *   T33 Sitio_OtroRol_403YSinMenu               T39 Sitio_OtrasRutas_NoFiltranFichas
 *   T34 Sitio_Confirmar_AbrePedidoAOperaciones  T57 Sitio_Decision_LaAplicaLaNoche
 *   T35 Sitio_Confirmar_NoEscribeMain           T58 Sitio_DecisionEnMain_DiceSeAplicaEstaNoche
 *   T36 Sitio_AutorNoAprueba                    T66 Sitio_Dependencias_SoloArreglar
 *   T70 Pendientes_SaleDeEjecuciones            T69 Sitio_Demo_FichasYConfirmarNoAbreNada
 *   T71 Pendientes_FilaDiceQuePaso              T72 Pendientes_QueHariaArreglar_PorFamilia
 *   T73 Pendientes_BotonesUnaVez_EnElIdioma
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
 * El sitio con las pestañas Pendientes y Ejecuciones, sobre el clon de operaciones. `fn` recibe los ayudantes.
 * `politica`: la rama principal pide la aprobación de otra persona (por defecto, sí).
 */
async function conSitio({ politica = true, autoApply = false, extra = {}, clones } = {}, fn) {
  let api; let emisor; let h;
  try {
    api = await arrancarGithubFalso({ owner: 'acme', repo: 'ops' });
    if (politica) api.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 1 } };
    const opsDoc = { version: 1, owners: { default: LEAD }, site: { access: [{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [DEV] }], url: 'https://sitio.acme.example', ...(autoApply ? { auto_apply: true } : {}) } };
    const ops = armarOperaciones({ opsDoc, extra });
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
    const pagina = await h.pedir('/pendientes', { cookie: lead });
    // la sección lleva el token de escritura de la sesión (la página no lo trae en su cabecera)
    const tok = (/<section id="hallazgos"[^>]* data-token="([^"]+)"/.exec(pagina.texto) || [])[1];
    const lista = async (cookie = lead) => h.pedir('/api/hallazgos', { cookie });
    const confirmar = async (cuerpo, cookie = lead, token = tok) => h.pedir('/api/hallazgos/confirmar', { method: 'POST', cookie, body: JSON.stringify(cuerpo), headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', 'x-site-token': token } });
    const fila = (j, fuente, id) => (j.filas || []).find((x) => x.fuente === fuente && x.id === id);
    const llamadasPedidos = () => api.llamadas.filter((l) => l.method === 'GET' && /\/pulls$/.test(l.ruta)).length;
    await fn({ h, api, ops, lead, dev, tok, lista, confirmar, fila, reloj, llamadasPedidos, entrar });
  } finally { await Promise.allSettled([h && h.cerrar(), emisor && emisor.cerrar(), api && api.cerrar()].filter(Boolean)); }
}

// ── T31 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_SeccionUnaFilaPorFicha @story-4.11 @ac-18
// 🔴 Falla con: una ficha resuelta o archivada en la sección, una razón sin forma a la vista, o el diagnóstico del
// vigilante en la página.
test('T31 Sitio_SeccionUnaFilaPorFicha — una fila por ficha viva de las tres fuentes, con su propuesta y su pedido @story-4.11 @ac-18', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, lead, lista, fila }) => {
    const r = await lista();
    assert.strictEqual(r.status, 200, r.texto);
    const j = r.json;
    assert.strictEqual(j.estado, 'leido');
    assert.deepStrictEqual(j.filas.map((x) => `${x.fuente}/${x.id}`).sort(),
      ['dependencias/dep-uno', `ejecuciones/${EJ1.id}`, `ejecuciones/${EJ2.id}`, 'vigilante/vig-dos', 'vigilante/vig-uno'].sort());
    // dependencias: las noches que lleva, la propuesta y el último pedido (sin enlace guardado: el id)
    const d = fila(j, 'dependencias', 'dep-uno');
    assert.strictEqual(d.nombre, 'pkg-uno (high)');
    assert.strictEqual(d.noches, 3);
    assert.strictEqual(d.ultima_vez, null);
    assert.deepStrictEqual(d.propuesta, { accion: 'arreglar', razon: 'Hay una versión corregida del paquete' });
    assert.deepStrictEqual(d.pedido, { id: '5002', enlace: null });
    // el vigilante: el pedido con enlace (story_creada con forma de enlace); sin forma, ninguno
    const v1 = fila(j, 'vigilante', 'vig-uno');
    assert.strictEqual(v1.apariciones, 3);
    assert.strictEqual(v1.ultima_vez, '2026-10-24');
    assert.deepStrictEqual(v1.pedido, { id: null, enlace: 'https://dev.acme.example/acme/_workitems/edit/88' });
    const v2 = fila(j, 'vigilante', 'vig-dos');
    assert.strictEqual(v2.propuesta.razon, 'razón sin la forma esperada', 'la razón vuelve a pasar por el filtro al mostrarse');
    assert.strictEqual(v2.propuesta.accion, 'arreglar');
    assert.strictEqual(v2.pedido, null);
    // ejecuciones: la ficha común, con su pedido por id; la ya decidida, con su veredicto y sin botón
    const e1 = fila(j, 'ejecuciones', EJ1.id);
    assert.strictEqual(e1.apariciones, 4);
    assert.deepStrictEqual(e1.pedido, { id: '42', enlace: null });
    assert.strictEqual(e1.estado_fila, 'pendiente');
    assert.strictEqual(e1.por_defecto, 'arreglar');
    const e2 = fila(j, 'ejecuciones', EJ2.id);
    assert.strictEqual(e2.veredicto, 'arreglo');
    assert.strictEqual(e2.estado_fila, 'decidida');
    assert.deepStrictEqual(e2.acciones, []);
    assert.deepStrictEqual(e2.pedido, { id: null, enlace: 'https://dev.acme.example/acme/_workitems/edit/77' });
    // sin propuesta, su motivo; y a quién está asignado el pedido
    assert.strictEqual(e2.propuesta, null);
    assert.strictEqual(e2.propuesta_motivo, 'tope');
    assert.strictEqual(e2.asignado, DEV);
    assert.strictEqual(e1.propuesta_motivo, null);
    assert.strictEqual(e1.asignado, null);
    // la página: la sección con una fila por ficha, el enlace sólo donde hay uno con forma, nada de lo que no se muestra
    const p = await h.pedir('/pendientes', { cookie: lead });
    assert.strictEqual(p.status, 200);
    assert.match(p.texto, /<h1>Pendientes<\/h1>/);
    assert.strictEqual((p.texto.match(/<tr data-ficha="/g) || []).length, 5, 'una fila por ficha viva');
    assert.match(p.texto, /href="https:\/\/dev\.acme\.example\/acme\/_workitems\/edit\/88"/);
    assert.match(p.texto, /razón sin la forma esperada/);
    assert.match(p.texto, /sin propuesta: la noche llegó al tope de propuestas/);
    assert.match(p.texto, /asignado a dev\.a@acme\.example/);
    for (const x of NUNCA) {
      assert.ok(!p.texto.includes(x), `la página no muestra «${x}»`);
      assert.ok(!r.texto.includes(x), `la lista no trae «${x}»`);
    }
  });
});

// ── T32 / T33 ────────────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_SoloQuienMantiene @story-4.11 @ac-19
// 🔴 Falla con: mostrarle la pestaña Pendientes a una persona que no mantiene.
test('T32 Sitio_SoloQuienMantiene — la pestaña Pendientes sale sólo para quien mantiene @story-4.11 @ac-19', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, lead, dev }) => {
    const suya = await h.pedir('/pendientes', { cookie: lead });
    assert.strictEqual(suya.status, 200);
    assert.match(suya.texto, /id="hallazgos"/);
    const ajena = await h.pedir('/pendientes', { cookie: dev });
    assert.strictEqual(ajena.status, 403, 'otro rol no entra a la pestaña');
    assert.doesNotMatch(ajena.texto, /id="hallazgos"/);
    for (const x of MARCAS) assert.ok(!ajena.texto.includes(x), `sin «${x}» para otro rol`);
  });
});

// Sitio_OtroRol_403YSinMenu @story-4.11 @ac-19
// 🔴 Falla con: que otro rol lea las fichas o confirme por las rutas propias, o una entrada de menú para la sección.
test('T33 Sitio_OtroRol_403YSinMenu — las rutas de la pestaña dan 403 a otro rol y su menú no la tiene @story-4.11 @ac-19', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, api, lead, dev, lista, confirmar }) => {
    assert.strictEqual((await lista(dev)).status, 403);
    // otro rol no recibe la sección ni su token: va con uno inventado, y lo frena el rol antes que el token
    const tokDev = (/data-token="([^"]+)"/.exec((await h.pedir('/pendientes', { cookie: dev })).texto || '') || [])[1] || 'sin-token';
    const r = await confirmar({ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar' }, dev, tokDev);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(api.st.pedidos.length, 0, 'ningún pedido');
    // el menú: quien mantiene tiene la pestaña; otro rol, no
    const menu = async (cookie) => (/<nav[\s\S]*?<\/nav>/.exec((await h.pedir('/corridas', { cookie })).texto) || [''])[0];
    const suyo = await menu(lead);
    assert.match(suyo, /href="\/pendientes"[^>]*>(?:<span[^>]*>\d+<\/span>)?Pendientes</, 'quien mantiene tiene la pestaña');
    const ajeno = await menu(dev);
    assert.ok(ajeno, 'la página tiene su menú');
    assert.doesNotMatch(ajeno, /pendientes|hallazgos/i, 'otro rol no tiene la pestaña');
  });
});

// ── T34 / T35 / T36 ──────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_Confirmar_AbrePedidoAOperaciones @story-4.11 @ac-20
// 🔴 Falla con: confirmar sin abrir el pedido, o con un archivo de decisión distinto del de la decisión 16.
test('T34 Sitio_Confirmar_AbrePedidoAOperaciones — el clic abre un pedido con el archivo de decisión @story-4.11 @ac-20', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ api, ops, confirmar }) => {
    const r = await confirmar({ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar' });
    assert.strictEqual(r.status, 200, r.texto);
    assert.strictEqual(r.json.ok, true, r.texto);
    assert.strictEqual(api.st.pedidos.length, 1);
    const p = api.st.pedidos[0];
    assert.strictEqual(p.title, 'Decisión sobre lo que encontró la noche: errores-500');
    assert.match(p.head.ref, /^team-config\/decision-vigilante-vig-uno-/);
    assert.match(p.body, /lead@acme\.example/);
    // la rama trae el archivo de decisión, con su forma cerrada
    const doc = JSON.parse(g(ops.bare, 'show', `${p.head.ref}:inbox/watcher/decisions/vig-uno.json`));
    assert.deepStrictEqual(doc, { fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar', quien: LEAD, el: '2026-10-25' });
    assert.ok(r.json.numero === 1 && /\/pull\/1$/.test(r.json.enlace), JSON.stringify(r.json));
    // y no toca nada más: la rama es main más ese archivo
    assert.deepStrictEqual(g(ops.bare, 'diff', '--name-only', 'main', p.head.ref).split('\n'), ['inbox/watcher/decisions/vig-uno.json']);
  });
});

// Sitio_Confirmar_NoEscribeMain @story-4.11 @ac-20
// 🔴 Falla con: que el clic escriba en main o mergee el pedido.
test('T35 Sitio_Confirmar_NoEscribeMain — main queda igual y el sitio no mergea @story-4.11 @ac-20', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ api, ops, confirmar }) => {
    const antes = g(ops.bare, 'rev-parse', 'main');
    const r = await confirmar({ fuente: 'ejecuciones', id: EJ1.id, accion: 'aceptar' });
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
  await conSitio({ politica: false }, async ({ api, ops, confirmar }) => {
    const r = await confirmar({ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar' });
    assert.strictEqual(r.json.ok, false, r.texto);
    assert.strictEqual(r.json.codigo, 'sin_politica');
    assert.strictEqual(api.st.pedidos.length, 0);
    assert.deepStrictEqual(g(ops.bare, 'branch', '--list', 'team-config/*'), '', 'no empujó ninguna rama');
  });
  await conSitio({ autoApply: true }, async ({ api, confirmar }) => {
    const r = await confirmar({ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar' });
    assert.strictEqual(api.st.pedidos.length, 1, r.texto);
    // con la opción prendida el sitio intenta aplicarlo, como en la Configuración (la regla de proponer)
    assert.ok(api.prohibidas().length >= 1, 'con site.auto_apply el sitio intenta aplicarlo');
  });
});

// ── T37 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_SegundoClic_NoAbreOtro @story-4.11 @ac-22
// 🔴 Falla con: un segundo pedido para la misma ficha, una consulta de pedidos por fila, o perder el botón cuando la
// plataforma no contesta.
test('T37 Sitio_SegundoClic_NoAbreOtro — el segundo clic no abre otro; la fila dice el pedido; una consulta para todas @story-4.11 @ac-22', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ api, lista, confirmar, fila, reloj, llamadasPedidos }) => {
    assert.strictEqual((await confirmar({ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar' })).json.ok, true);
    const otra = await confirmar({ fuente: 'vigilante', id: 'vig-uno', accion: 'arreglar' });
    assert.strictEqual(otra.json.ok, false);
    assert.strictEqual(otra.json.codigo, 'pedido_abierto');
    assert.strictEqual(api.st.pedidos.length, 1);
    // la fila: «propuesto en el pedido N», con su enlace y sin botón
    const n0 = llamadasPedidos();
    reloj.t += 61000;
    const j = (await lista()).json;
    const v = fila(j, 'vigilante', 'vig-uno');
    assert.strictEqual(v.estado_fila, 'propuesto');
    assert.deepStrictEqual(v.propuesto, { numero: 1, enlace: api.st.pedidos[0].html_url });
    assert.deepStrictEqual(v.acciones, []);
    assert.strictEqual(fila(j, 'vigilante', 'vig-dos').estado_fila, 'pendiente');
    assert.strictEqual(llamadasPedidos() - n0, 1, 'una sola consulta para todas las filas');
    // un pedido abierto cuya rama empieza como la de otra ficha no es de esa ficha: la fila sigue pendiente
    api.st.pedidos.push({ number: 90, state: 'open', html_url: 'https://github.com/acme/ops/pull/90', title: 'otro', body: '', head: { ref: 'team-config/decision-vigilante-vig-dos-extra-20261025-120000' }, base: { ref: 'main' } });
    reloj.t += 61000;
    const conOtro = (await lista()).json;
    assert.strictEqual(fila(conOtro, 'vigilante', 'vig-dos').estado_fila, 'pendiente', 'el pedido de otra rama no cuenta');
    assert.deepStrictEqual(fila(conOtro, 'vigilante', 'vig-dos').acciones, ['aceptar', 'arreglar']);
    const n1 = llamadasPedidos();
    // guardada un minuto: otra lectura enseguida no vuelve a preguntar; pasado el minuto, sí
    await lista();
    assert.strictEqual(llamadasPedidos() - n1, 0);
    reloj.t += 61000;
    await lista();
    assert.strictEqual(llamadasPedidos() - n1, 1);
    // la plataforma no contesta: una frase, y el botón sigue
    api.st.exigirAuth = 'Bearer otra-cosa';
    reloj.t += 61000;
    const caida = (await lista()).json;
    assert.strictEqual(caida.pedidos.estado, 'no_se_pudo');
    assert.match(caida.pedidos.frase, /no se pudo ver si hay pedidos abiertos/);
    assert.deepStrictEqual(fila(caida, 'vigilante', 'vig-dos').acciones, ['aceptar', 'arreglar']);
    // la falla no se guarda: vuelta la plataforma, la lectura siguiente pregunta otra vez sin esperar el minuto
    api.st.exigirAuth = null;
    const vuelta = (await lista()).json;
    assert.strictEqual(vuelta.pedidos.estado, 'leido');
    assert.strictEqual(fila(vuelta, 'vigilante', 'vig-uno').estado_fila, 'propuesto');
  });
});

// Sitio_FichaMovidaOConPedidoDeLaNoche_SinBotones @story-4.11 @ac-20 @ac-22 — lo confirmó el pase adversarial
// 🔴 Falla con: un botón que nunca puede andar (una ficha en promoted/ que conserva `veredicto: pendiente # nota`), o
// decidir en el sitio una ficha cuyo pedido de la noche sigue abierto: ese pedido quedaría huérfano.
test('T37c Sitio_FichaMovidaOConPedidoDeLaNoche_SinBotones @story-4.11 @ac-20 @ac-22', { timeout: 60000 }, async () => {
  const extra = {
    'inbox/dependencies/promoted/dep-mov.yaml': 'id: dep-mov\ndetectado: 2026-10-19\nveredicto: pendiente # decision-en-curso\npaquete: pkg-movido\nseveridad: high\nnoches: 2\n',
    'inbox/watcher/pending/vig-uno.yaml': `${FICHAS['inbox/watcher/pending/vig-uno.yaml']}pr: 123\n`,
  };
  await conSitio({ extra }, async ({ api, lista, confirmar, fila }) => {
    const j = (await lista()).json;
    const mov = fila(j, 'dependencias', 'dep-mov');
    assert.ok(mov, 'la ficha movida se ve');
    assert.deepStrictEqual(mov.acciones, [], 'sin botón: no se puede confirmar desde promoted/');
    assert.strictEqual(mov.estado_fila, 'movida');
    const v = fila(j, 'vigilante', 'vig-uno');
    assert.deepStrictEqual(v.acciones, [], 'sin botón: se decide en el pedido de la noche');
    assert.strictEqual(v.estado_fila, 'pedido_noche');
    const r = await confirmar({ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar' });
    assert.strictEqual(r.json.ok, false);
    assert.strictEqual(r.json.codigo, 'pedido_de_la_noche');
    assert.strictEqual(api.st.pedidos.length, 0);
  });
});

// ── T38 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_SinClon_UnaFrase @story-4.11 @ac-23
// 🔴 Falla con: una tabla vacía cuando no hay clon, no hay fichas o las carpetas no se pueden leer.
test('T38 Sitio_SinClon_UnaFrase — sin clon, sin fichas o con carpetas que no se leen: una frase @story-4.11 @ac-23', { timeout: 90000 }, async () => {
  const casos = [
    { nombre: 'sin clon', clones: () => ({ operaciones: null, perfil: null }), estado: 'sin_clon', frase: /todavía no tiene el repo de operaciones/ },
    { nombre: 'sin fichas', extra: Object.fromEntries(Object.keys(FICHAS).map((k) => [k, null])), estado: 'sin_fichas', frase: /no dejó fichas/ },
    // una carpeta de fichas que es un archivo: no se puede listar
    { nombre: 'ilegible', extra: { 'inbox/watcher/pending/vig-uno.yaml': null, 'inbox/watcher/pending/vig-dos.yaml': null, 'inbox/watcher/pending': 'no es una carpeta\n' }, estado: 'ilegible', frase: /no se pudieron leer/ },
  ];
  for (const c of casos) {
    await conSitio({ extra: c.extra || {}, clones: c.clones }, async ({ h, lead, lista }) => {
      const j = (await lista()).json;
      assert.strictEqual(j.estado, c.estado, `${c.nombre}: ${JSON.stringify(j)}`);
      assert.match(j.frase, c.frase, c.nombre);
      const p = await h.pedir('/pendientes', { cookie: lead });
      const seccion = (/<section id="hallazgos"[\s\S]*?<\/section>/.exec(p.texto) || [''])[0];
      assert.ok(seccion, `${c.nombre}: la sección está`);
      assert.match(seccion, c.frase, c.nombre);
      if (c.estado !== 'ilegible') assert.doesNotMatch(seccion, /<table/, `${c.nombre}: nunca una tabla vacía`);
    });
  }
  // confirmar con la ficha o la carpeta de decisiones sin poder leerse: «no se pudo leer», nunca «ya no está pendiente»
  // ni un pedido abierto a ciegas
  const ilegibles = [
    { nombre: 'ficha', extra: casos[2].extra, codigo: 'ficha_ilegible' },
    { nombre: 'decisiones', extra: { 'inbox/watcher/decisions': 'no es una carpeta\n' }, codigo: 'decision_ilegible' },
  ];
  for (const c of ilegibles) {
    await conSitio({ extra: c.extra }, async ({ api, confirmar }) => {
      const r = await confirmar({ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar' });
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
test('T57 Sitio_Decision_LaAplicaLaNoche — lo que deja el clic, en main, lo aplica la noche @story-4.11 @ac-20', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ api, ops, confirmar }) => {
    assert.strictEqual((await confirmar({ fuente: 'ejecuciones', id: EJ1.id, accion: 'aceptar' })).json.ok, true);
    assert.strictEqual((await confirmar({ fuente: 'dependencias', id: 'dep-uno', accion: 'arreglar' })).json.ok, true);
    // otra persona aprueba: los pedidos entran en main
    const noche = path.join(ops.raiz, 'noche');
    g(ops.raiz, 'clone', '-q', ops.bare, noche);
    for (const p of api.st.pedidos) g(noche, 'merge', '-q', '--no-edit', `origin/${p.head.ref}`);
    assert.ok(fs.existsSync(path.join(noche, 'inbox', 'runs-review', 'decisions', `${EJ1.id}.json`)));
    // la noche
    const e = CYCLE.aplicarDecisiones({ base: noche, fuente: 'ejecuciones' });
    const d = CYCLE.aplicarDecisiones({ base: noche, fuente: 'dependencias' });
    assert.deepStrictEqual([e.aplicadas.length, e.sinForma, d.aplicadas.length, d.sinForma], [1, 0, 1, 0]);
    assert.strictEqual(CYCLE.parsear(fs.readFileSync(path.join(noche, 'inbox', 'runs-review', 'promoted', `${EJ1.id}.yaml`), 'utf8')).veredicto, 'aceptada');
    assert.match(fs.readFileSync(path.join(noche, 'inbox', 'dependencies', 'promoted', 'dep-uno.yaml'), 'utf8'), /^veredicto: util$/m);
    assert.ok(!fs.existsSync(path.join(noche, 'inbox', 'runs-review', 'decisions', `${EJ1.id}.json`)));
  });
});

// Sitio_DecisionEnMain_DiceSeAplicaEstaNoche @story-4.11 @ac-22
// 🔴 Falla con: seguir ofreciendo el botón (o decir «pendiente») cuando la decisión ya está en main.
test('T58 Sitio_DecisionEnMain_DiceSeAplicaEstaNoche — con la decisión en main, la fila lo dice y no hay botón @story-4.11 @ac-22', { timeout: 60000 }, async () => {
  const extra = { 'inbox/watcher/decisions/vig-uno.json': `${JSON.stringify({ fuente: 'vigilante', id: 'vig-uno', accion: 'aceptar', quien: LEAD, el: '2026-10-24' })}\n` };
  await conSitio({ extra }, async ({ h, api, lead, lista, confirmar, fila }) => {
    const v = fila((await lista()).json, 'vigilante', 'vig-uno');
    assert.strictEqual(v.estado_fila, 'decidido');
    assert.deepStrictEqual(v.acciones, []);
    const p = await h.pedir('/pendientes', { cookie: lead });
    assert.match(p.texto, /decidido, se aplica esta noche/);
    // y un clic tardío no abre otro pedido
    const r = await confirmar({ fuente: 'vigilante', id: 'vig-uno', accion: 'arreglar' });
    assert.strictEqual(r.json.ok, false);
    assert.strictEqual(api.st.pedidos.length, 0);
  });
});

// ── T66 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_Dependencias_SoloArreglar @story-4.11 @ac-20
// 🔴 Falla con: ofrecer «Aceptar» en dependencias, o abrir un pedido para un «aceptar» de dependencias.
test('T66 Sitio_Dependencias_SoloArreglar — la fila de dependencias trae sólo «Arreglar»; la frase de la deuda va una vez, arriba @story-4.11 @ac-20', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, api, lead, lista, confirmar, fila }) => {
    const d = fila((await lista()).json, 'dependencias', 'dep-uno');
    assert.deepStrictEqual(d.acciones, ['arreglar']);
    assert.strictEqual(d.por_defecto, 'arreglar');
    const p = await h.pedir('/pendientes', { cookie: lead });
    const tr = (/<tr data-ficha="dependencias\/dep-uno"[\s\S]*?<\/tr>/.exec(p.texto) || [''])[0];
    assert.ok(tr, 'la fila de dependencias');
    assert.doesNotMatch(tr, /data-accion="aceptar"/);
    assert.match(tr, /data-accion="arreglar"/);
    assert.doesNotMatch(tr, /declarar la deuda/, 'la frase de la deuda no se repite en la fila');
    assert.strictEqual(p.texto.split('declarar la deuda').length - 1, 1, 'la frase de la deuda, una vez');
    const r = await confirmar({ fuente: 'dependencias', id: 'dep-uno', accion: 'aceptar' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(api.st.pedidos.length, 0);
  });
});

// ── T69 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Sitio_Demo_FichasYConfirmarNoAbreNada @story-4.11 @ac-18 @ac-20 @ac-23
// 🔴 Falla con: una sección vacía en el demo, o un confirmar del demo que sale a la red.
test('T69 Sitio_Demo_FichasYConfirmarNoAbreNada — el demo muestra fichas de las tres fuentes y confirmar dice lo que pasaría @story-4.11 @ac-18 @ac-20 @ac-23', { timeout: 60000 }, async () => {
  const dir = tmp('site-findings-demo-');
  const sitio = require(path.join(H.SITE, 'server.js')).crearSitioDemo({ env: { SITE_DEMO: '1' }, dir, log: () => {} });
  await sitio.iniciar();
  await new Promise((r) => sitio.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${sitio.server.address().port}`;
  const pedir = (ruta, o) => H.pedirA(base, ruta, o);
  try {
    const j = (await pedir('/api/hallazgos')).json;
    assert.strictEqual(j.estado, 'leido', JSON.stringify(j));
    assert.deepStrictEqual([...new Set(j.filas.map((x) => x.fuente))].sort(), ['dependencias', 'ejecuciones', 'vigilante']);
    const pendiente = j.filas.find((x) => x.fuente === 'vigilante' && x.estado_fila === 'pendiente');
    assert.ok(pendiente, 'una ficha del vigilante para confirmar');
    const pagina = await pedir('/pendientes');
    assert.strictEqual(pagina.status, 200, pagina.texto);
    const tok = (/<section id="hallazgos"[^>]* data-token="([^"]+)"/.exec(pagina.texto) || [])[1];
    assert.ok(tok, 'la sección del demo lleva su token');
    const r = await pedir('/api/hallazgos/confirmar', { method: 'POST', body: JSON.stringify({ fuente: 'vigilante', id: pendiente.id, accion: 'aceptar' }), headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-site-token': tok } });
    assert.strictEqual(r.status, 200, r.texto);
    assert.strictEqual(r.json.codigo, 'demo');
    assert.strictEqual(r.json.loQuePasaria.archivo, `inbox/watcher/decisions/${pendiente.id}.json`);
    assert.strictEqual(JSON.parse(r.json.loQuePasaria.contenido).accion, 'aceptar');
    // la fila del demo dice lo que pasaría: el cliente muestra el archivo que se propondría, con su texto en la sección
    assert.match(pagina.texto, /data-t-demo="[^"]+"/);
    assert.match(FINDINGS().CLIENTE, /j\.demo && j\.loQuePasaria/);
    // nada cambió: la fila sigue pendiente
    const otra = (await pedir('/api/hallazgos')).json.filas.find((x) => x.fuente === 'vigilante' && x.id === pendiente.id);
    assert.strictEqual(otra.estado_fila, 'pendiente');
  } finally { await sitio.cerrar(); }
});

// ── T70..T73: la pestaña Pendientes ──────────────────────────────────────────────────────────────────────────────────

/** Una ficha de ejecuciones con sus casos (máquina y story de cada uno). */
const conCasos = (causa, nombre, casos) => CYCLE.nuevaFicha({ fuente: 'ejecuciones', causa, nombre, hoy: '2026-10-22', casos });
const caso = (n, dia, maquina, story) => ({ ejecucion: `e${n}`, base: `${story}-${dia}T1000`, dia, maquina, story });
const EJ_CASOS = conCasos('RR-HOOK:Stop/otro', 'aviso automático con error', [
  caso(1, '2026-10-21', 'mac-a-0123abcd', '1.1'), caso(2, '2026-10-21', 'mac-b-89abcdef', '1.2'), caso(3, '2026-10-22', 'mac-a-0123abcd', '1.3'),
  caso(4, '2026-10-22', 'mac-a-0123abcd', '1.4'), caso(5, '2026-10-22', 'mac-b-89abcdef', '1.5'),
]);
const EJ_UNA = conCasos('RR-ESCAPE:TYCON_SAFETY_OFF', 'freno de seguridad apagado', [caso(6, '2026-10-22', 'mac-c-00112233', '2.1')]);
const EJ_RARA = CYCLE.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-NUEVA:algo', nombre: 'una causa que la tabla no conoce', hoy: '2026-10-22' });
const extraDe = (...fichas) => Object.fromEntries(fichas.map((f) => [`inbox/runs-review/pending/${f.id}.yaml`, CYCLE.serializar(f)]));
const filaDe = (html, ficha) => (new RegExp(`<tr data-ficha="${ficha.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?</tr>`).exec(html) || [''])[0];

// Pendientes_SaleDeEjecuciones
// 🔴 Falla con: la sección todavía al pie de Ejecuciones, o la pestaña sin su lugar en el menú de quien mantiene.
test('T70 Pendientes_SaleDeEjecuciones — lo que encontró la noche tiene su pestaña y ya no está en Ejecuciones', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, lead, dev }) => {
    for (const cookie of [lead, dev]) {
      const corridas = await h.pedir('/corridas', { cookie });
      assert.doesNotMatch(corridas.texto, /id="hallazgos"|data-ficha=/, 'Ejecuciones no trae las fichas');
      for (const x of MARCAS) assert.ok(!corridas.texto.includes(x), `Ejecuciones no muestra «${x}»`);
    }
    const p = await h.pedir('/pendientes', { cookie: lead });
    assert.match(p.texto, /class="activa" aria-current="page"><span class="ix">\d+<\/span>Pendientes</, 'la pestaña activa es Pendientes');
    // entre Ejecuciones y Proyectos
    const nav = (/<nav[\s\S]*?<\/nav>/.exec(p.texto) || [''])[0];
    const orden = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(orden.indexOf('/corridas') < orden.indexOf('/pendientes') && orden.indexOf('/pendientes') < orden.indexOf('/proyectos'), orden.join(' '));
  });
});

// Pendientes_FilaDiceQuePaso
// 🔴 Falla con: una fila que dice sólo el nombre de la causa, sin cuántas veces, en qué máquinas ni en qué stories.
test('T71 Pendientes_FilaDiceQuePaso — cada fila dice qué pasó, con los datos de la ficha', { timeout: 60000 }, async () => {
  await conSitio({ extra: extraDe(EJ_CASOS, EJ_UNA) }, async ({ h, lead, lista, fila }) => {
    const j = (await lista()).json;
    // las máquinas sin su huella, de la más reciente a la más vieja; pasadas tres stories, «y N más»
    assert.strictEqual(fila(j, 'ejecuciones', EJ_CASOS.id).que_paso,
      'Pasó 5 veces, en las máquinas mac-b y mac-a, en las stories 1.5, 1.4, 1.3 y 2 más. La última vez, el 2026-10-22.');
    assert.strictEqual(fila(j, 'ejecuciones', EJ_UNA.id).que_paso, 'Pasó una vez, en la máquina mac-c, en la story 2.1. La última vez, el 2026-10-22.');
    // sin casos, la cuenta de la ficha
    assert.strictEqual(fila(j, 'ejecuciones', EJ1.id).que_paso, 'Pasó 4 veces. La última vez, el 2026-10-24.');
    assert.strictEqual(fila(j, 'dependencias', 'dep-uno').que_paso, 'El paquete pkg-uno (high) tiene una vulnerabilidad conocida, vista 3 noches seguidas, en Producto X/FrontEnd.');
    assert.strictEqual(fila(j, 'vigilante', 'vig-uno').que_paso, 'En producción de acme: errores-500, vista 3 noches seguidas.');
    // la página y en inglés
    const p = await h.pedir('/pendientes', { cookie: lead });
    assert.ok(filaDe(p.texto, `ejecuciones/${EJ_CASOS.id}`).includes('Pasó 5 veces, en las máquinas mac-b y mac-a'));
    const en = (await lista(`${lead}; sitio-idioma=en`)).json;
    assert.strictEqual(fila(en, 'ejecuciones', EJ_CASOS.id).que_paso,
      'It happened 5 times, on the machines mac-b and mac-a, in stories 1.5, 1.4, 1.3 and 2 more. Last time: 2026-10-22.');
  });
});

// Pendientes_QueHariaArreglar_PorFamilia
// 🔴 Falla con: una familia de causa sin su texto, un texto en un solo idioma, o «Arreglar» escondido en una fila sin
// propuesta del modelo.
test('T72 Pendientes_QueHariaArreglar_PorFamilia — cada fila dice qué haría «Arreglar»; la propuesta va debajo, como sugerencia', { timeout: 60000 }, async () => {
  const FAMILIAS = { 'RR-ESCAPE': 'escape', 'RR-HOOK': 'hook', 'RR-CIERRE': 'cierre', 'RR-NODE': 'node', 'RR-BANDERA': 'bandera', 'RR-APAGO': 'apago' };
  const porFamilia = Object.keys(FAMILIAS).map((r, i) => CYCLE.nuevaFicha({ fuente: 'ejecuciones', causa: `${r}:x`, nombre: `familia ${i}`, hoy: '2026-10-22' }));
  await conSitio({ extra: extraDe(...porFamilia, EJ_RARA) }, async ({ h, lead, lista, fila }) => {
    const j = (await lista()).json;
    porFamilia.forEach((f, i) => {
      const clave = `hallazgos.arreglo.${Object.values(FAMILIAS)[i]}`;
      const r = fila(j, 'ejecuciones', f.id);
      assert.strictEqual(r.que_arreglaria, TX.t('es', clave), f.causa);
      assert.notStrictEqual(TX.t('en', clave), TX.t('es', clave), `${clave}: en inglés también`);
      assert.ok(r.acciones.includes('arreglar'), `${f.causa}: «Arreglar» sin propuesta del modelo`);
    });
    assert.strictEqual(fila(j, 'ejecuciones', EJ_RARA.id).que_arreglaria, 'Todavía no se sabe; Arreglar abre la investigación.');
    assert.match(fila(j, 'dependencias', 'dep-uno').que_arreglaria, /^Actualizar el paquete/);
    assert.match(fila(j, 'vigilante', 'vig-uno').que_arreglaria, /^Investigar ese error de producción/);
    // la página: el texto de la familia y, debajo, la propuesta del modelo como sugerencia
    const p = await h.pedir('/pendientes', { cookie: lead });
    const tr = filaDe(p.texto, `ejecuciones/${EJ1.id}`);
    assert.match(tr, /Se busca por qué se salteó el freno\./);
    assert.match(tr, /Sugerencia del modelo \(Arreglar\): <span lang="es">Se repite cada semana en el mismo paso<\/span>/);
    assert.match(filaDe(p.texto, `ejecuciones/${EJ_RARA.id}`), /data-accion="arreglar"/);
  });
});

// Pendientes_BotonesUnaVez_EnElIdioma
// 🔴 Falla con: qué hace cada botón repetido en cada fila (o en ningún lado), o la página en inglés con textos en
// castellano sin decirlo.
test('T73 Pendientes_BotonesUnaVez_EnElIdioma — qué hace cada botón, una vez arriba, en el idioma de la página', { timeout: 60000 }, async () => {
  await conSitio({}, async ({ h, lead }) => {
    const es = (await h.pedir('/pendientes', { cookie: lead })).texto;
    for (const x of ['Aceptar: está bien así; la ficha se archiva.', 'Arreglar: queda como trabajo pendiente. Abre un pedido que aprueba otra persona; no arregla nada solo.']) {
      assert.strictEqual(es.split(x).length - 1, 1, `«${x}», una vez`);
    }
    assert.ok(es.indexOf('Aceptar: está bien así') < es.indexOf('<table'), 'arriba de la tabla');
    const en = (await h.pedir('/pendientes', { cookie: `${lead}; sitio-idioma=en` })).texto;
    assert.match(en, /<h1>Pending<\/h1>/);
    assert.strictEqual(en.split('Accept: it is fine as it is; the finding is archived.').length - 1, 1);
    assert.match(en, /<th>What happened<\/th><th>What «Fix» would do<\/th>/);
    // la razón del modelo viene en castellano: lo dice la etiqueta
    assert.match(filaDe(en, `ejecuciones/${EJ1.id}`), /Model suggestion, written in Spanish \(Fix\): <span lang="es">/);
    assert.match(filaDe(en, `ejecuciones/${EJ1.id}`), /We find out why the check was skipped\./);
  });
});
