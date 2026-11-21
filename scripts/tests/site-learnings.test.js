'use strict';
/*
 * site-learnings.test.js — la pestaña «Aprendizajes» del sitio (scripts/site/tabs/learnings.js): las propuestas que dejó
 * la noche de los instintos del equipo, y decidirlas como en Mantenimiento. Aprobar lleva la regla, con el texto que
 * confirmó quien mantiene, por pedido al bloque `team-learnings.md` de un paquete del perfil; las decisiones van por
 * pedido al repo de operaciones (el archivo de cada propuesta, con `estado` y `decision`).
 *
 *   T8  Tab_ListsPendingWithNumbersAndSuggestion        T14 Approve_NumbersOnly_NeedsTextFromMaintainer
 *   T9  Tab_StatesNotConfusedWithEmpty                   T15 Approve_PackChoice_CeilingAndGate
 *   T10 Tab_MaintainerOnly_DevGets403                    T16 Send_RetryWithSameMarca_NoSecondProfileRequest
 *   T11 Tab_MenuCountsPending                            T18 Draft_ArtifactSuggestion_BuildsIssueDraft
 *   T12 Send_RejectRequiresMotive_OneRequestForAll       T19 Texts_LearningsInEsAndEn_AndImageWhitelist
 *   T13 Send_ApproveOpensProfileRequestThenMarks         T20 Tab_NoWriteIdentity_ReadOnlyWithReason
 *   T26 History_ApprovedNotInProfile_ShowsAndReproposes
 *
 * El servidor real del sitio, con sesiones de un emisor OIDC local, sobre dos repos git locales (operaciones y el perfil)
 * y dos APIs de GitHub falsas en el proceso (lib/fake-github-api.js). Sin red. Correos y repos inventados.
 *
 * A mano: node --test scripts/tests/site-learnings.test.js
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
const { validarConfiguracion } = require(path.join(H.SITE, 'server.js'));
const LEARN = () => require(path.join(H.SITE, 'tabs', 'learnings.js'));
const TX = require(path.join(H.SITE, 'texts.js'));
const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));

const LEAD = 'lead@acme.example';
const DEV = 'dev.a@acme.example';
const AHORA = Date.parse('2026-11-16T12:00:00Z');
const ESCRITURA_OPS = `w-${crypto.randomBytes(6).toString('hex')}`;
const ESCR_PERFIL = `p-${crypto.randomBytes(6).toString('hex')}`;
const MARCA = () => crypto.randomBytes(16).toString('hex');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

// fecha fija: los commits de la prueba dan el mismo hash en cada corrida
const ENV_GIT = { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@acme.example', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@acme.example',
  GIT_AUTHOR_DATE: '2026-11-16T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-16T12:00:00Z' };
function g(dir, ...a) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...ENV_GIT } });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// ── las propuestas de mentira, con la forma que escribe la noche (instinct-nightly.js) ──────────────────────────────────
const H1 = 'a000000001'; const H2 = 'a000000002'; const H3 = 'a000000003';
const H4 = 'a000000004'; const H5 = 'a000000005'; const H6 = 'a000000006'; const H7 = 'a000000007';
const REGLA = (trigger, action, extra = {}) => ({ trigger, action, domain: 'seguridad', scope: 'project', confidence: 0.91, reasoning: 'se repite', tycon_artifact_suggestion: null, ...extra });
const prop = (huella, extra) => ({ huella, estado: 'pendiente', herramienta: 'Bash', repo: 'acme/api', patron: `patron ${huella}`, veces: 3, maquinas: 2, desde: '2026-11-01', hasta: '2026-11-14',
  propuesta_el: '2026-11-15', redaccion: null, sin_redaccion: null, modelo: { provider: 'ollama', model: 'gemma4:31b' }, decision: null, ...extra });
const PROPUESTAS = {
  [H1]: prop(H1, { veces: 5, maquinas: 3, redaccion: REGLA('cuando se toca el login', 'correr las pruebas de seguridad', { tycon_artifact_suggestion: 'advisor:SEC-C10' }) }),
  [H2]: prop(H2, { veces: 9, maquinas: 3, sin_redaccion: 'tope', modelo: null }),
  [H3]: prop(H3, { veces: 20, maquinas: 2, redaccion: REGLA('cuando se cambia una migración', 'compilarla antes del commit') }),
  [H4]: prop(H4, { estado: 'aprobada', redaccion: REGLA('t4', 'a4'), decision: { por: LEAD, el: '2026-11-10', texto: 'Regla aprobada que está en el perfil', pedido: 'https://github.example/acme/perfil/pull/70' } }),
  [H5]: prop(H5, { estado: 'rechazada', redaccion: REGLA('t5', 'a5'), decision: { por: LEAD, el: '2026-11-12', motivo: 'No aplica a este equipo' } }),
  [H6]: prop(H6, { estado: 'rechazada', redaccion: REGLA('t6', 'a6'), decision: { por: LEAD, el: '2026-10-10', motivo: 'Decidida hace mas de treinta dias' } }),
};
const INFORME = { fecha: '2026-11-16', estado: 'medido', motivo: null, nuevas: 3, con_redaccion: 2, sin_redaccion: { tope: 1, fallo: 0, sin_modelo: 0, sin_llave: 0 },
  modelo: { provider: 'ollama', model: 'gemma4:31b', estado: 'ok', fallos: {} }, maquinas: 3 };
const json = (x) => `${JSON.stringify(x, null, 2)}\n`;
const archivosOps = (extra = {}) => ({
  ...Object.fromEntries(Object.values(PROPUESTAS).map((p) => [`inbox/instincts/propuestas/${p.huella}.json`, json(p)])),
  '.dashboard/instincts/instintos-2026-11-15.json': json({ ...INFORME, fecha: '2026-11-15', estado: 'apagado' }),
  '.dashboard/instincts/instintos-2026-11-16.json': json(INFORME),
  ...extra,
});
const PACK = (extra = {}) => json({ name: 'acme', reviewers: [{ agent: 'acme-revisor', group: 'base' }], ...extra });
const archivosPerfil = (extra = {}) => ({
  'team-profile.json': json({ version: 1, packs: { default: 'all' }, integrations: { instincts: true } }),
  'team-layer.json': json({ requires: { harness: '>= 2026.11.02.3' } }),
  'packs/acme/pack.json': PACK(),
  ...extra,
});

/** Un repo con su bare y un clon: `trabajo` es donde la prueba cambia main. */
function armarRepo(nombre, archivos) {
  const raiz = tmp(`site-learn-${nombre}-`);
  const trabajo = path.join(raiz, 'trabajo');
  fs.mkdirSync(trabajo);
  g(trabajo, 'init', '-q', '-b', 'main');
  escribir(trabajo, archivos);
  g(trabajo, 'add', '-A'); g(trabajo, 'commit', '-q', '-m', 'base');
  const bare = path.join(raiz, `${nombre}.git`);
  g(raiz, 'clone', '-q', '--bare', trabajo, bare);
  g(trabajo, 'remote', 'add', 'bare', bare);
  const clon = path.join(raiz, 'clon');
  g(raiz, 'clone', '-q', bare, clon);
  return { raiz, bare, clon, trabajo };
}
function escribir(dir, archivos) {
  for (const [rel, c] of Object.entries(archivos)) {
    const f = path.join(dir, rel);
    if (c === null) { fs.rmSync(f, { recursive: true, force: true }); continue; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, c);
  }
}
/** Cambia main del repo (y el clon del sitio, si `alClon`). */
function cambiarMain(r, archivos, { alClon = true } = {}) {
  escribir(r.trabajo, archivos);
  g(r.trabajo, 'add', '-A'); g(r.trabajo, 'commit', '-q', '-m', 'cambio');
  g(r.trabajo, 'push', '-q', 'bare', 'main');
  if (alClon) g(r.clon, 'pull', '-q', 'origin', 'main');
}
/** Lo que trae la rama de un pedido en el bare. */
const enRama = (r, rama, archivo) => g(r.bare, 'show', `${rama}:${archivo}`);

async function conSitio(o = {}, fn) {
  const { autoApply = false, ops: extraOps = {}, perfil: extraPerfil = {}, sinOps = false, sinPerfil = false, sinRepoPerfil = false, copia = false } = o;
  let apiOps; let apiPerfil; let emisor; let h;
  try {
    apiOps = await arrancarGithubFalso({ owner: 'acme', repo: 'ops' });
    apiPerfil = await arrancarGithubFalso({ owner: 'acme', repo: 'perfil' });
    for (const api of [apiOps, apiPerfil]) api.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 1 } };
    const opsDoc = { version: 1, owners: { default: LEAD }, site: { access: [{ role: 'maintainer', emails: [LEAD] }, { role: 'dev', emails: [DEV] }], url: 'https://sitio.acme.example', ...(autoApply ? { auto_apply: true } : {}) } };
    const ops = armarRepo('ops', { 'operations.json': json(opsDoc), ...archivosOps(extraOps) });
    const perfil = armarRepo('perfil', archivosPerfil(extraPerfil));
    apiOps.st.archivosDe = (p) => { try { return g(ops.bare, 'diff', '--name-only', `main...${p.head.ref}`).split('\n').filter(Boolean); } catch { return []; } };
    apiPerfil.st.archivosDe = (p) => { try { return g(perfil.bare, 'diff', '--name-only', `main...${p.head.ref}`).split('\n').filter(Boolean); } catch { return []; } };
    const fuentes = H.fuentesFijas({ config: opsDoc });
    const escritura = { usado: 0 };
    // con la copia del contenedor, el sitio lee una foto sin git y escribe en un clon aparte
    const foto = copia ? (() => { const d = tmp('site-learn-foto-'); fs.cpSync(ops.clon, d, { recursive: true }); fs.rmSync(path.join(d, '.git'), { recursive: true, force: true }); return d; })() : null;
    fuentes.clones = () => ({ operaciones: copia ? { dir: foto, indice: { hora: '2026-11-16T10:00:00Z' } } : { dir: ops.clon }, perfil: sinRepoPerfil ? null : { dir: perfil.clon } });
    if (copia) fuentes.clonDeEscritura = async () => { escritura.usado += 1; return { dir: ops.clon }; };
    fuentes.exclusivo = (f) => f();
    emisor = await arrancarEmisor();
    const env = H.envBase({
      SITE_OIDC_ISSUER: emisor.issuer, SITE_OPERATIONS_REPO: 'https://github.com/acme/ops',
      ...(sinOps ? {} : { SITE_OPERATIONS_WRITE_TOKEN: ESCRITURA_OPS }),
      ...(sinRepoPerfil ? {} : { SITE_PROFILE_REPO: 'https://github.com/acme/perfil', SITE_PROFILE_TOKEN: 'leer-perfil' }),
      ...(sinPerfil || sinRepoPerfil ? {} : { SITE_PROFILE_WRITE_TOKEN: ESCR_PERFIL }),
    });
    const cfg = validarConfiguracion(env).cfg;
    const reloj = { t: AHORA };
    const registro = [];
    const rutas = LEARN().crearRutas({ cfg, fuentes, ahora: () => reloj.t, urlBase: { github: apiOps.base }, urlBasePerfil: { github: apiPerfil.base }, log: (x) => registro.push(String(x)), versionImagen: '2026.11.16.1' });
    h = await H.arrancarSitio({ env, fuentes, rutasExtra: rutas });
    const entrar = async (email) => (await H.ingresar(h, emisor, { sub: `s-${email}`, email, email_verified: true })).sesion;
    const lead = await entrar(LEAD);
    const dev = await entrar(DEV);
    const pagina = async (cookie = lead) => h.pedir('/aprendizajes', { cookie });
    const p0 = await pagina();
    const tok = (/<section id="aprendizajes"[^>]* data-token="([^"]+)"/.exec(p0.texto) || [])[1];
    const modelo = async (cookie = lead) => h.pedir('/api/aprendizajes', { cookie });
    const enviar = async (cuerpo, { cookie = lead, token = tok, origin = 'http://127.0.0.1' } = {}) => h.pedir('/api/aprendizajes/enviar', { method: 'POST', cookie, body: JSON.stringify(cuerpo),
      headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json', ...(token ? { 'x-site-token': token } : {}) } });
    const seccion = (texto) => (/<section id="aprendizajes"[\s\S]*<\/section>/.exec(texto) || [''])[0];
    await fn({ h, apiOps, apiPerfil, ops, perfil, foto, lead, dev, tok, reloj, registro, rutas, pagina, modelo, enviar, seccion, escritura });
  } finally {
    if (h) await h.cerrar();
    if (emisor) await emisor.cerrar();
    if (apiOps) await apiOps.cerrar();
    if (apiPerfil) await apiPerfil.cerrar();
  }
}
const cuerpo = (r) => JSON.parse(r.texto);
const BLOQUE = 'packs/acme/claude-md-blocks/team-learnings.md';

// ── T8 la lista ────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T8 4.13-Tab_ListsPendingWithNumbersAndSuggestion @story-4.13 @ac-9 @ac-10 — las pendientes con sus números y su regla, la noche arriba y el historial cerrado', async () => {
  await conSitio({}, async ({ pagina, modelo, seccion }) => {
    const m = cuerpo(await modelo());
    assert.strictEqual(m.estado, 'leido');
    assert.deepStrictEqual(m.pendientes.map((p) => p.huella), [H2, H1, H3], 'las de más máquinas primero, después las de más veces');
    const p1 = m.pendientes.find((p) => p.huella === H1);
    assert.deepStrictEqual({ herramienta: p1.herramienta, patron: p1.patron, repo: p1.repo, maquinas: p1.maquinas, veces: p1.veces, desde: p1.desde, hasta: p1.hasta },
      { herramienta: 'Bash', patron: `patron ${H1}`, repo: 'acme/api', maquinas: 3, veces: 5, desde: '2026-11-01', hasta: '2026-11-14' });
    assert.strictEqual(p1.regla.trigger, 'cuando se toca el login');
    assert.strictEqual(p1.regla.action, 'correr las pruebas de seguridad');
    assert.strictEqual(p1.regla.confianza, 0.91);
    const p2 = m.pendientes.find((p) => p.huella === H2);
    assert.strictEqual(p2.regla, null);
    assert.match(p2.sinRedaccion, /tope/i);
    // la noche de arriba: la última
    assert.strictEqual(m.noche.fecha, '2026-11-16');
    assert.strictEqual(m.noche.estado, 'medido');
    assert.match(m.noche.modelo, /gemma4:31b/);
    assert.strictEqual(m.noche.sinRedactar, 1);
    // el historial: 30 días, sin la decidida hace 31 o más
    assert.deepStrictEqual(m.historial.map((x) => x.huella).sort(), [H4, H5]);
    const h4 = m.historial.find((x) => x.huella === H4);
    assert.strictEqual(h4.quien, 'lead');
    assert.strictEqual(h4.texto, 'Regla aprobada que está en el perfil');
    assert.strictEqual(m.historial.find((x) => x.huella === H5).motivo, 'No aplica a este equipo');
    const s = seccion((await pagina()).texto);
    for (const x of ['patron a000000002', 'patron a000000001', 'patron a000000003', 'cuando se toca el login', 'No aplica a este equipo']) assert.ok(s.includes(x), `la página trae «${x}»`);
    assert.ok(s.indexOf('patron a000000002') < s.indexOf('patron a000000001') && s.indexOf('patron a000000001') < s.indexOf('patron a000000003'), 'en orden');
    assert.match(s, /<details class="a-historial[^"]*"(?![^>]*\sopen)/, 'el historial cerrado de entrada');
    assert.ok(!s.includes('Decidida hace mas de treinta dias'));
    // nadie aparece como autor de lo repetido: ni carpetas de máquina, ni sesiones, ni correos
    assert.doesNotMatch(s, /@acme\.example|session_id|mac-[a-z]+-[0-9a-f]{8}/);
  });
  // lo que se muestra de un archivo pasa por el saneado aunque la noche no lo haya hecho
  const CASA = prop(H7, { patron: `node ${os.homedir()}/proyectos/x.js`, redaccion: REGLA('cuando token=abcdef123456', 'hacer y') });
  await conSitio({ ops: { [`inbox/instincts/propuestas/${H7}.json`]: json(CASA) } }, async ({ pagina, seccion }) => {
    const s = seccion((await pagina()).texto);
    assert.ok(!s.includes(os.homedir()), 'la ruta de la casa no se muestra');
    assert.ok(!s.includes('abcdef123456'), 'la credencial no se muestra');
  });
});

// ── T9 los estados ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('T9 4.13-Tab_StatesNotConfusedWithEmpty @story-4.13 @ac-9 — sin carpeta, apagado, no medido y un archivo ilegible: cuatro textos, ninguno una lista vacía', async () => {
  await conSitio({}, async ({ ops, modelo, pagina, seccion }) => {
    const leer = async () => cuerpo(await modelo());
    const frases = [];
    // un archivo que no se lee: se nombra
    fs.writeFileSync(path.join(ops.clon, 'inbox/instincts/propuestas/bbbbbbbbbb.json'), '{roto');
    let m = await leer();
    assert.strictEqual(m.estado, 'ilegible');
    assert.match(m.frase, /bbbbbbbbbb\.json/);
    frases.push(m.frase);
    fs.rmSync(path.join(ops.clon, 'inbox/instincts/propuestas/bbbbbbbbbb.json'));
    // el último informe apagado
    fs.writeFileSync(path.join(ops.clon, '.dashboard/instincts/instintos-2026-11-17.json'), json({ ...INFORME, fecha: '2026-11-17', estado: 'apagado' }));
    m = await leer();
    assert.strictEqual(m.estado, 'apagado');
    frases.push(m.frase);
    // el último informe no medido, con su motivo
    fs.writeFileSync(path.join(ops.clon, '.dashboard/instincts/instintos-2026-11-17.json'), json({ ...INFORME, fecha: '2026-11-17', estado: 'no_medido', motivo: 'sin_dias' }));
    m = await leer();
    assert.strictEqual(m.estado, 'no_medido');
    assert.match(m.frase, /sin_dias|ningún día|no day/i);
    frases.push(m.frase);
    // sin la carpeta de propuestas
    fs.rmSync(path.join(ops.clon, '.dashboard/instincts/instintos-2026-11-17.json'));
    fs.rmSync(path.join(ops.clon, 'inbox/instincts/propuestas'), { recursive: true });
    m = await leer();
    assert.strictEqual(m.estado, 'sin_propuestas');
    frases.push(m.frase);
    assert.strictEqual(new Set(frases).size, 4, `cuatro textos distintos: ${frases.join(' | ')}`);
    for (const f of frases) assert.ok(f && f.length > 10);
    assert.strictEqual(m.frase, TX.t('es', 'aprend.sinPropuestas'));
    assert.ok(seccion((await pagina()).texto).includes(TX.t('es', 'aprend.sinPropuestas')), 'la página lo dice');
  });
});

// ── T10 sólo quien mantiene ───────────────────────────────────────────────────────────────────────────────────────────
test('T10 4.13-Tab_MaintainerOnly_DevGets403 @story-4.13 @ac-8 — un dev, 403 sin dato; sin sesión, lo de siempre', async () => {
  await conSitio({}, async ({ h, dev, rutas }) => {
    const RUTAS = ['/aprendizajes', '/api/aprendizajes', '/aprendizajes/cliente.js'];
    for (const r of rutas) assert.deepStrictEqual(r.needs, ['maintainer'], `${r.path} declara maintainer`);
    assert.deepStrictEqual(rutas.map((r) => r.path).sort(), ['/aprendizajes', '/aprendizajes/cliente.js', '/api/aprendizajes', '/api/aprendizajes/enviar'].sort());
    const tab = rutas.find((r) => r.path === '/aprendizajes');
    assert.strictEqual(tab.pestana.id, 'aprendizajes');
    assert.strictEqual(tab.pestana.orden, 26);
    assert.strictEqual(tab.pestana.esperanDe, undefined, 'no compite con Mantenimiento por los números de Inicio');
    for (const ruta of RUTAS) {
      const r = await h.pedir(ruta, { cookie: dev });
      assert.strictEqual(r.status, 403, ruta);
      assert.ok(!r.texto.includes(H1) && !r.texto.includes('patron'), `${ruta}: sin dato`);
    }
    const post = await h.pedir('/api/aprendizajes/enviar', { method: 'POST', cookie: dev, body: '{}', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' } });
    assert.strictEqual(post.status, 403);
    const sinSesion = await h.pedir('/aprendizajes');
    const deSiempre = await h.pedir('/arnes');
    assert.strictEqual(sinSesion.status, deSiempre.status, 'sin sesión responde lo mismo que otra pestaña de quien mantiene');
  });
});

// ── T11 la cuenta del menú ───────────────────────────────────────────────────────────────────────────────────────────
test('T11 4.13-Tab_MenuCountsPending @story-4.13 @ac-8 @ac-22 — «Aprendizajes (3)»; sin pendientes, el nombre solo; un dev no la ve', async () => {
  await conSitio({}, async ({ h, lead, dev, ops }) => {
    const nombre = TX.t('es', 'pestana.aprendizajes');
    assert.strictEqual(nombre, 'Aprendizajes');
    const menu = async (cookie) => ((/<nav class="tabs"[\s\S]*?<\/nav>/.exec((await h.pedir('/', { cookie })).texto) || [''])[0]);
    assert.ok((await menu(lead)).includes(`${nombre} (3)`), await menu(lead));
    assert.ok(!(await menu(dev)).includes(nombre), 'un dev no la ve en el menú');
    for (const x of [H1, H2, H3]) fs.rmSync(path.join(ops.clon, `inbox/instincts/propuestas/${x}.json`));
    const m = await menu(lead);
    assert.ok(m.includes(nombre) && !m.includes(`${nombre} (`), m);
  });
});

// ── T12 rechazar ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('T12 4.13-Send_RejectRequiresMotive_OneRequestForAll @story-4.13 @ac-11 @ac-12 — el motivo, un pedido para todas, las defensas y la que cambió', async () => {
  await conSitio({}, async ({ enviar, apiOps, ops, pagina, seccion }) => {
    const rechazo = (huella, motivo) => ({ huella, accion: 'reject', ...(motivo === undefined ? {} : { motivo }) });
    for (const malo of [rechazo(H1), rechazo(H1, ''), rechazo(H1, 'x'.repeat(301)), rechazo(H1, 'una\nlinea')]) {
      const r = await enviar({ marca: MARCA(), decisiones: [malo] });
      assert.strictEqual(r.status, 400, JSON.stringify(malo).slice(0, 80));
    }
    assert.strictEqual(apiOps.st.pedidos.length, 0, 'los inválidos no crean nada');
    // las defensas de escritura, como Configuración
    assert.strictEqual((await enviar({ marca: MARCA(), decisiones: [rechazo(H1, 'no')] }, { origin: null })).status, 403);
    assert.strictEqual((await enviar({ marca: MARCA(), decisiones: [rechazo(H1, 'no')] }, { token: null })).status, 403);
    assert.ok(seccion((await pagina()).texto).includes(TX.t('es', 'aprend.enviar')), 'sin auto_apply el botón dice «Enviar para aprobar»');
    // dos buenas: un pedido
    const r = await enviar({ marca: MARCA(), decisiones: [rechazo(H1, 'No sirve para este repo'), rechazo(H3, 'Ya lo cubre el portón')] });
    const j = cuerpo(r);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(j.ok, true, j.message);
    assert.strictEqual(apiOps.st.pedidos.length, 1);
    assert.ok(j.queSigue && j.queSigue.texto.length > 10, 'la línea de qué sigue');
    const rama = apiOps.st.pedidos[0].head.ref;
    assert.match(rama, /^team-config\/aprendizajes/);
    for (const [hh, motivo] of [[H1, 'No sirve para este repo'], [H3, 'Ya lo cubre el portón']]) {
      const p = JSON.parse(enRama(ops, rama, `inbox/instincts/propuestas/${hh}.json`));
      assert.strictEqual(p.estado, 'rechazada');
      assert.deepStrictEqual(p.decision, { por: LEAD, el: '2026-11-16', motivo });
      assert.strictEqual(p.patron, `patron ${hh}`, 'lo demás queda igual');
    }
    // una propuesta que cambió en main después de la foto: no se pisa
    cambiarMain(ops, { [`inbox/instincts/propuestas/${H2}.json`]: json({ ...PROPUESTAS[H2], sin_redaccion: null, redaccion: REGLA('nueva', 'redaccion') }) }, { alClon: false });
    const c = cuerpo(await enviar({ marca: MARCA(), decisiones: [rechazo(H2, 'no va')] }));
    assert.strictEqual(c.ok, false);
    assert.strictEqual(c.codigo, 'cambio');
    assert.match(c.message, /recarg/i);
    assert.strictEqual(apiOps.st.pedidos.length, 1, 'no crea nada');
  });
  await conSitio({ autoApply: true }, async ({ enviar, pagina, seccion }) => {
    assert.ok(seccion((await pagina()).texto).includes(`>${TX.t('es', 'aprend.enviarSolo')}<`), 'con auto_apply el botón dice «Enviar»');
    const j = cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H1, accion: 'reject', motivo: 'no' }] }));
    assert.ok(j.ok || j.codigo === 'aplicado', j.message);
    assert.ok(j.queSigue && j.queSigue.texto);
  });
});

// ── T13 aprobar ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('T13 4.13-Send_ApproveOpensProfileRequestThenMarks @story-4.13 @ac-13 — el pedido al perfil con las reglas, después el de operaciones', async () => {
  await conSitio({}, async ({ enviar, apiOps, apiPerfil, ops, perfil }) => {
    const j = cuerpo(await enviar({ marca: MARCA(), decisiones: [
      { huella: H1, accion: 'approve', texto: 'Correr las pruebas de seguridad al tocar el login' },
      { huella: H3, accion: 'approve', texto: 'Compilar la migración antes de commitear' },
      { huella: H2, accion: 'reject', motivo: 'Sin datos suficientes' },
    ] }));
    assert.strictEqual(j.ok, true, j.message);
    assert.strictEqual(apiPerfil.st.pedidos.length, 1);
    assert.strictEqual(apiOps.st.pedidos.length, 1);
    const pp = apiPerfil.st.pedidos[0];
    assert.match(pp.head.ref, /^team-config\/aprendizajes/);
    const bloque = enRama(perfil, pp.head.ref, BLOQUE);
    assert.match(bloque, new RegExp(`Correr las pruebas de seguridad al tocar el login <!-- aprendizaje:${H1} -->`));
    assert.match(bloque, new RegExp(`Compilar la migración antes de commitear <!-- aprendizaje:${H3} -->`));
    assert.match(pp.body, new RegExp(`aprendizaje: ${H1}`));
    assert.match(pp.body, new RegExp(`aprendizaje: ${H3}`));
    const rama = apiOps.st.pedidos[0].head.ref;
    for (const [hh, texto] of [[H1, 'Correr las pruebas de seguridad al tocar el login'], [H3, 'Compilar la migración antes de commitear']]) {
      const p = JSON.parse(enRama(ops, rama, `inbox/instincts/propuestas/${hh}.json`));
      assert.strictEqual(p.estado, 'aprobada');
      assert.deepStrictEqual(p.decision, { por: LEAD, el: '2026-11-16', texto, pedido: pp.html_url });
    }
    assert.strictEqual(JSON.parse(enRama(ops, rama, `inbox/instincts/propuestas/${H2}.json`)).estado, 'rechazada');
    assert.strictEqual(j.perfil.enlace, pp.html_url);
  });
});

// ── T14 sin redacción ───────────────────────────────────────────────────────────────────────────────────────────────
test('T14 4.13-Approve_NumbersOnly_NeedsTextFromMaintainer @story-4.13 @ac-13 — sin redacción, el texto lo escribe quien mantiene', async () => {
  await conSitio({}, async ({ enviar, apiOps, apiPerfil, perfil }) => {
    const sin = await enviar({ marca: MARCA(), decisiones: [{ huella: H2, accion: 'approve' }] });
    assert.strictEqual(sin.status, 400);
    assert.strictEqual(apiPerfil.st.pedidos.length + apiOps.st.pedidos.length, 0, 'nada se crea');
    const j = cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H2, accion: 'approve', texto: 'Regla escrita por quien mantiene' }] }));
    assert.strictEqual(j.ok, true, j.message);
    assert.match(enRama(perfil, apiPerfil.st.pedidos[0].head.ref, BLOQUE), new RegExp(`Regla escrita por quien mantiene <!-- aprendizaje:${H2} -->`));
    assert.strictEqual(apiOps.st.pedidos.length, 1);
  });
});

// ── T15 el paquete, el techo y la versión ──────────────────────────────────────────────────────────────────────────
test('T15 4.13-Approve_PackChoice_CeilingAndGate @story-4.13 @ac-14 — sin paquetes frena; el que tiene el bloque viene elegido; inactivo avisa; techo; versión', async () => {
  const aprobar = (huella = H1, texto = 'Regla de cuarenta caracteres más o menos') => ({ marca: MARCA(), decisiones: [{ huella, accion: 'approve', texto }] });
  // sin paquetes
  await conSitio({ perfil: { 'packs/acme/pack.json': null } }, async ({ modelo, enviar, apiPerfil }) => {
    const m = cuerpo(await modelo());
    assert.ok(m.paquetes.frena, 'sin paquetes, frenado con el motivo');
    const j = cuerpo(await enviar(aprobar()));
    assert.strictEqual(j.ok, false);
    assert.strictEqual(j.codigo, 'sin_paquete');
    assert.strictEqual(apiPerfil.st.pedidos.length, 0);
  });
  // dos paquetes: viene elegido el que tiene el bloque
  await conSitio({ perfil: { 'packs/alfa/pack.json': PACK({ name: 'alfa' }), [BLOQUE]: `- Una regla <!-- aprendizaje:${H6} -->\n` } }, async ({ modelo }) => {
    const m = cuerpo(await modelo());
    assert.deepStrictEqual(m.paquetes.lista.map((p) => p.nombre), ['acme', 'alfa']);
    assert.strictEqual(m.paquetes.elegido, 'acme');
    assert.strictEqual(m.paquetes.aviso, null);
  });
  // dos paquetes sin bloque: lo elige quien mantiene
  await conSitio({ perfil: { 'packs/alfa/pack.json': PACK({ name: 'alfa' }) } }, async ({ modelo, enviar, apiPerfil, perfil }) => {
    assert.strictEqual(cuerpo(await modelo()).paquetes.elegido, null);
    assert.strictEqual(cuerpo(await enviar(aprobar())).codigo, 'sin_paquete');
    const j = cuerpo(await enviar({ ...aprobar(), paquete: 'alfa' }));
    assert.strictEqual(j.ok, true, j.message);
    assert.match(enRama(perfil, apiPerfil.st.pedidos[0].head.ref, 'packs/alfa/claude-md-blocks/team-learnings.md'), new RegExp(H1));
  });
  // un paquete que la organización no activa: avisa
  await conSitio({ perfil: { 'team-profile.json': json({ version: 1, packs: { default: ['otro'] } }) } }, async ({ modelo }) => {
    assert.ok(cuerpo(await modelo()).paquetes.aviso, 'avisa que no se escribiría en ninguna máquina');
  });
  // el techo: 3.990 bytes y una regla de 40
  await conSitio({ perfil: { [BLOQUE]: `${'x'.repeat(3989)}\n` } }, async ({ enviar, apiPerfil }) => {
    const j = cuerpo(await enviar(aprobar()));
    assert.strictEqual(j.ok, false);
    assert.strictEqual(j.codigo, 'techo');
    assert.strictEqual(apiPerfil.st.pedidos.length, 0);
  });
  // la capa anterior a los bloques de paquete: el pedido la sube
  await conSitio({ perfil: { 'team-layer.json': json({ requires: { harness: '>= 2026.10.01.1' } }) } }, async ({ enviar, apiPerfil, perfil }) => {
    assert.strictEqual(cuerpo(await enviar(aprobar())).ok, true);
    assert.strictEqual(JSON.parse(enRama(perfil, apiPerfil.st.pedidos[0].head.ref, 'team-layer.json')).requires.harness, `>= ${ORG.PACK_BLOCKS_SINCE}`);
  });
  // con la capa de hoy no cambia nada
  assert.strictEqual(ORG.PACK_BLOCKS_SINCE, '2026.10.17.19');
  assert.strictEqual(ORG.packBlocksLayer(json({ requires: { harness: '>= 2026.11.02.3' } })), null);
  assert.ok(ORG.packBlocksLayer('{roto').problema);
  assert.ok(ORG.packBlocksLayer(json({ requires: { harness: 'cualquiera' } })).problema);
});

// ── T16 reintentar y esperar ───────────────────────────────────────────────────────────────────────────────────────
test('T16 4.13-Send_RetryWithSameMarca_NoSecondProfileRequest @story-4.13 @ac-16 — la misma marca no abre otro pedido al perfil; esperando aprobación', async () => {
  await conSitio({}, async ({ enviar, modelo, apiOps, apiPerfil, perfil, reloj, h, lead, pagina, seccion }) => {
    const marca = MARCA();
    const cuerpoEnvio = { marca, decisiones: [{ huella: H1, accion: 'approve', texto: 'Regla uno' }] };
    apiOps.st.fallarPedido = 500;
    const j = cuerpo(await enviar(cuerpoEnvio));
    assert.strictEqual(j.ok, false);
    assert.strictEqual(apiPerfil.st.pedidos.length, 1, 'el del perfil salió');
    assert.match(j.message, /operaciones|operations/i, 'dice cuál falló');
    assert.ok(j.perfil && j.perfil.enlace);
    apiOps.st.fallarPedido = null;
    const j2 = cuerpo(await enviar(cuerpoEnvio));
    assert.strictEqual(j2.ok, true, j2.message);
    assert.strictEqual(apiPerfil.st.pedidos.length, 1, 'reusa el pedido del perfil');
    assert.strictEqual(apiOps.st.pedidos.length, 1);
    // esperando aprobación: por los archivos en operaciones y por el renglón del cuerpo en el perfil
    reloj.t += 61 * 1000;
    const m = cuerpo(await modelo());
    assert.ok(!m.pendientes.some((p) => p.huella === H1) || m.pendientes.find((p) => p.huella === H1).esperando, 'H1 espera aprobación');
    const esperaH1 = [...m.pendientes, ...m.historial].find((p) => p.huella === H1);
    assert.ok(esperaH1.esperando, 'H1 con su pedido');
    // la cuenta del menú no la suma
    const menu = (/<nav class="tabs"[\s\S]*?<\/nav>/.exec((await h.pedir('/', { cookie: lead })).texto) || [''])[0];
    assert.ok(menu.includes(`${TX.t('es', 'pestana.aprendizajes')} (2)`), menu);
    // con un pedido de aprendizajes vivo en el perfil, otro aprobar se frena; rechazar sigue andando
    const otro = cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H3, accion: 'approve', texto: 'Regla tres' }] }));
    assert.strictEqual(otro.codigo, 'perfil_abierto');
    assert.ok(otro.enlace);
    assert.strictEqual(apiPerfil.st.pedidos.length, 1);
    const rech = cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H3, accion: 'reject', motivo: 'no' }] }));
    assert.strictEqual(rech.ok, true, JSON.stringify(rech));
    // una que ya espera no se vuelve a enviar
    const repetida = cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H3, accion: 'reject', motivo: 'otra vez' }] }));
    assert.notStrictEqual(repetida.ok, true);
    assert.ok((repetida.omitidas || []).includes(H3));
    // la consulta que no contesta: lo dice y no ofrece enviar
    reloj.t += 61 * 1000;
    apiOps.st.exigirAuth = 'Bearer otra-cosa';
    const sin = cuerpo(await modelo());
    assert.strictEqual(sin.pedidos.estado, 'no_se_pudo');
    assert.ok(sin.pedidos.frase);
    const nada = cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H2, accion: 'reject', motivo: 'no' }] }));
    assert.strictEqual(nada.codigo, 'sin_pedidos');
    // y la pantalla no ofrece enviar: ningún botón de decidir sin apagar
    assert.doesNotMatch(seccion((await pagina()).texto), /<button[^>]*data-accion="(approve|reject)"(?![^>]*disabled)/);
    apiOps.st.exigirAuth = null;
    void perfil;
  });
  // 25 h después, con el bloque que ya trae la huella: no agrega una segunda línea
  await conSitio({ perfil: { [BLOQUE]: `- Regla uno <!-- aprendizaje:${H1} -->\n` } }, async ({ enviar, apiPerfil, apiOps, reloj }) => {
    reloj.t += 25 * 3600 * 1000;
    const j = cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H1, accion: 'approve', texto: 'Regla uno' }] }));
    assert.strictEqual(j.ok, true, j.message);
    assert.strictEqual(apiPerfil.st.pedidos.length, 0, 'la huella ya está en el bloque: no hay nada que agregar');
    assert.strictEqual(apiOps.st.pedidos.length, 1);
  });
  // la forma real del cuerpo: las secciones en un solo renglón
  await conSitio({}, async ({ enviar, apiPerfil }) => {
    await enviar({ marca: MARCA(), decisiones: [{ huella: H1, accion: 'approve', texto: 'Uno' }, { huella: H3, accion: 'approve', texto: 'Tres' }] });
    const renglones = apiPerfil.st.pedidos[0].body.split('\n').filter((l) => /aprendizaje: /.test(l));
    assert.strictEqual(renglones.length, 1, 'cuerpoDelPedido escribe las secciones juntas');
    assert.match(renglones[0], new RegExp(`aprendizaje: ${H1}, aprendizaje: ${H3}|aprendizaje: ${H3}, aprendizaje: ${H1}`));
  });
});

// ── T27-T30 el reenvío, la regla sugerida, otro paquete y la ya decidida ────────────────────────────────────────────
test('T27 4.13-Send_SameMarcaOtherApprovals_NotReportedAsSent @story-4.13 @ac-16 — un reenvío con la misma marca y otras aprobaciones no se da por enviado', async () => {
  await conSitio({}, async ({ enviar, apiOps, apiPerfil, ops }) => {
    const marca = MARCA();
    apiOps.st.fallarPedido = 500;
    assert.strictEqual(cuerpo(await enviar({ marca, decisiones: [{ huella: H1, accion: 'approve', texto: 'Regla uno' }] })).ok, false);
    apiOps.st.fallarPedido = null;
    assert.strictEqual(apiPerfil.st.pedidos.length, 1);
    // la misma marca, con una aprobación más: no es el mismo envío
    const j = cuerpo(await enviar({ marca, decisiones: [{ huella: H1, accion: 'approve', texto: 'Regla uno' }, { huella: H3, accion: 'approve', texto: 'Regla tres' }] }));
    assert.strictEqual(j.ok, false, JSON.stringify(j));
    assert.strictEqual(j.codigo, 'marca_otro_envio');
    assert.strictEqual(apiOps.st.pedidos.length, 0, 'operaciones no marca aprobada una regla que no está en el pull request del perfil');
    assert.strictEqual(apiPerfil.st.pedidos.length, 1);
    void ops;
  });
});
test('T28 4.13-Approve_SuggestedRuleOneLine_AndNoCommentMarks @story-4.13 @ac-11 @ac-13 — la regla sugerida pasa el mismo control de una línea; un texto no trae marcas de comentario', async () => {
  const MULTI = prop(H7, { redaccion: REGLA('cuando se toca X\n## Encabezado inyectado', 'hacer Y') });
  await conSitio({ ops: { [`inbox/instincts/propuestas/${H7}.json`]: json(MULTI) } }, async ({ enviar, apiPerfil, apiOps }) => {
    const sin = await enviar({ marca: MARCA(), decisiones: [{ huella: H7, accion: 'approve' }] });
    assert.strictEqual(sin.status, 400, 'sin texto, la sugerida de varias líneas no entra');
    for (const texto of [`Regla <!-- aprendizaje:${H3} -->`, 'Abre <!-- un comentario', 'Cierra --> uno', 'Cierra --!> también']) {
      assert.strictEqual((await enviar({ marca: MARCA(), decisiones: [{ huella: H1, accion: 'approve', texto }] })).status, 400, texto);
    }
    assert.strictEqual((await enviar({ marca: MARCA(), decisiones: [{ huella: H1, accion: 'reject', motivo: 'no <!-- x' }] })).status, 400);
    assert.strictEqual(apiPerfil.st.pedidos.length + apiOps.st.pedidos.length, 0);
  });
  // la sugerida va al bloque saneada, igual que la muestra la pantalla
  const CASA = prop(H7, { redaccion: REGLA(`cuando se toca ${os.homedir()}/x.js`, 'hacer y') });
  await conSitio({ ops: { [`inbox/instincts/propuestas/${H7}.json`]: json(CASA) } }, async ({ enviar, perfil, apiPerfil }) => {
    const j = cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H7, accion: 'approve' }] }));
    assert.strictEqual(j.ok, true, j.message);
    const bloque = enRama(perfil, apiPerfil.st.pedidos[0].head.ref, BLOQUE);
    assert.ok(!bloque.includes(os.homedir()), 'la ruta de la casa no llega al bloque');
  });
  // un bloque que no se puede leer frena aprobar aunque el envío nombre el paquete
  await conSitio({}, async ({ enviar, perfil, apiPerfil, apiOps }) => {
    const f = path.join(perfil.clon, BLOQUE);
    fs.mkdirSync(f, { recursive: true });
    const j = cuerpo(await enviar({ marca: MARCA(), paquete: 'acme', decisiones: [{ huella: H1, accion: 'approve', texto: 'Regla uno' }] }));
    assert.strictEqual(j.ok, false);
    assert.strictEqual(j.codigo, 'perfil_ilegible');
    assert.strictEqual(apiPerfil.st.pedidos.length + apiOps.st.pedidos.length, 0);
  });
});
test('T29 4.13-Approve_RuleAlreadyInOtherPack_NotDuplicated @story-4.13 @ac-16 — una huella que ya está en el bloque de otro paquete no se agrega otra vez', async () => {
  await conSitio({ perfil: { 'packs/alfa/pack.json': PACK({ name: 'alfa' }), 'packs/alfa/claude-md-blocks/team-learnings.md': `- Regla uno <!-- aprendizaje:${H1} -->\n` } }, async ({ enviar, apiPerfil, apiOps }) => {
    const j = cuerpo(await enviar({ marca: MARCA(), paquete: 'acme', decisiones: [{ huella: H1, accion: 'approve', texto: 'Regla uno' }] }));
    assert.strictEqual(j.ok, true, j.message);
    assert.strictEqual(apiPerfil.st.pedidos.length, 0, 'ya está en el perfil: no hay nada que agregar');
    assert.strictEqual(apiOps.st.pedidos.length, 1);
  });
});
test('T30 4.13-Send_AlreadyDecidedInMain_LeavesTheList @story-4.13 @ac-12 — una propuesta que ya está decidida en main sale de la lista y no abre pedido', async () => {
  await conSitio({}, async ({ enviar, apiOps, ops }) => {
    cambiarMain(ops, { [`inbox/instincts/propuestas/${H3}.json`]: json({ ...PROPUESTAS[H3], estado: 'rechazada', decision: { por: LEAD, el: '2026-11-16', motivo: 'decidida en otro lado' } }) }, { alClon: false });
    const j = cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H3, accion: 'reject', motivo: 'no' }, { huella: H1, accion: 'reject', motivo: 'no' }] }));
    assert.strictEqual(j.ok, true, j.message);
    assert.ok(j.omitidas.includes(H3), 'la ya decidida sale');
    assert.deepStrictEqual(j.enviadas, [H1]);
    assert.strictEqual(apiOps.st.pedidos.length, 1);
  });
});

// ── T18 el borrador para el arnés ─────────────────────────────────────────────────────────────────────────────────
test('T18 4.13-Draft_ArtifactSuggestion_BuildsIssueDraft @story-4.13 @ac-17 — el borrador desde la forma de la propuesta, en una carpeta que se borra', () => {
  const L = LEARN();
  const base = tmp('site-learn-borrador-');
  const casos = [['advisor:SEC-C10', 'advisor-sec-c10'], ['hook:PostToolUse', 'hook-posttooluse'], ['guide:tests', 'guide-tests']];
  for (const [sugerencia, sufijo] of casos) {
    const p = prop(H7, { veces: 12, redaccion: REGLA('cuando x', 'hacer y', { domain: 'testing', tycon_artifact_suggestion: sugerencia }) });
    const b = L.borradorAlArnes(p, { idioma: 'es', publicRepo: 'https://github.com/acme/harness', version: '2026.11.16.1', tmpBase: base });
    assert.ok(b && b.url, sugerencia);
    assert.strictEqual(b.archivo, `${H7}-${sufijo}.md`, 'nombrado por la huella');
    const u = decodeURIComponent(b.url);
    assert.ok(u.startsWith('https://github.com/acme/harness/issues/new?'));
    assert.ok(u.includes(`${H7}-${sufijo}.md`));
    assert.ok(!u.includes('undefined'));
    assert.ok(u.includes('12 ocurrencias') && u.includes('testing'), 'las veces y el dominio de la propuesta');
  }
  assert.strictEqual(L.borradorAlArnes(prop(H7, { redaccion: REGLA('a', 'b') }), { idioma: 'es', publicRepo: 'https://github.com/acme/harness', version: 'v', tmpBase: base }), null);
  assert.strictEqual(L.borradorAlArnes(prop(H7), { idioma: 'es', publicRepo: 'https://github.com/acme/harness', version: 'v', tmpBase: base }), null);
  assert.deepStrictEqual(fs.readdirSync(base), [], 'la carpeta temporal se borra');
});
test('T18b 4.13-Draft_LinkOnCardOnlyWithSuggestion @story-4.13 @ac-17 — la tarjeta con sugerencia trae «Proponer al arnés»; ningún repo recibe el borrador', async () => {
  await conSitio({}, async ({ modelo, apiOps, apiPerfil }) => {
    const m = cuerpo(await modelo());
    assert.ok(m.pendientes.find((p) => p.huella === H1).alArnes, 'H1 sugiere un revisor');
    assert.strictEqual(m.pendientes.find((p) => p.huella === H3).alArnes, null);
    const escrituras = [...apiOps.llamadas, ...apiPerfil.llamadas].filter((x) => x.method !== 'GET');
    assert.deepStrictEqual(escrituras, []);
  });
});

// ── T19 textos e imagen ─────────────────────────────────────────────────────────────────────────────────────────────
test('T19 4.13-Texts_LearningsInEsAndEn_AndImageWhitelist @story-4.13 @ac-18 — cada texto en los dos idiomas; la imagen trae lo que la pestaña carga', () => {
  const claves = Object.keys(TX.TEXTOS).filter((k) => k.startsWith('aprend.') || k === 'pestana.aprendizajes');
  assert.ok(claves.length >= 20, `pocas claves: ${claves.length}`);
  for (const k of claves) for (const i of ['es', 'en']) assert.ok(typeof TX.TEXTOS[k][i] === 'string' && TX.TEXTOS[k][i].trim(), `${k} en ${i}`);
  const fuente = fs.readFileSync(path.join(H.SITE, 'tabs', 'learnings.js'), 'utf8');
  for (const m of fuente.matchAll(/['`](aprend\.[A-Za-z0-9.]*[A-Za-z0-9])['`]/g)) assert.ok(TX.TEXTOS[m[1]], `${m[1]} está en la tabla`);
  const docker = fs.readFileSync(path.join(H.SITE, 'Dockerfile'), 'utf8');
  const ignore = fs.readFileSync(path.join(H.SITE, 'Dockerfile.dockerignore'), 'utf8');
  for (const f of ['instinct-draft.js', 'instinct-nightly.js', 'instinct-observer.js', 'instinct-dirs.js', 'instinct-model.js']) {
    assert.match(docker, new RegExp(`COPY [^\\n]*scripts/instincts/${f.replace('.', '\\.')}`), `Dockerfile copia ${f}`);
    assert.match(ignore, new RegExp(`^!scripts/instincts/${f.replace('.', '\\.')}$`, 'm'), `.dockerignore deja pasar ${f}`);
  }
  const deDocker = [...docker.matchAll(/scripts\/instincts\/([a-z-]+\.js)/g)].map((m) => m[1]).sort();
  const deIgnore = [...ignore.matchAll(/^!scripts\/instincts\/([a-z-]+\.js)$/gm)].map((m) => m[1]).sort();
  assert.deepStrictEqual([...new Set(deDocker)], [...new Set(deIgnore)], 'las dos listas dicen lo mismo');
});

// ── T20 sin identidad de escritura ──────────────────────────────────────────────────────────────────────────────────
test('T20 4.13-Tab_NoWriteIdentity_ReadOnlyWithReason @story-4.13 @ac-19 — todo se ve; cada botón dice qué le falta; con la copia escribe en el clon aparte', async () => {
  await conSitio({ sinOps: true }, async ({ modelo, enviar, pagina, seccion, apiOps }) => {
    const m = cuerpo(await modelo());
    assert.strictEqual(m.pendientes.length, 3, 'todo se ve');
    assert.ok(m.escritura.rechazar && m.escritura.aprobar, 'los dos dicen qué les falta');
    const s = seccion((await pagina()).texto);
    assert.ok(s.includes('SITE_OPERATIONS_WRITE_TOKEN'));
    assert.doesNotMatch(s, /<button[^>]*data-accion="(approve|reject)"(?![^>]*disabled)/, 'ningún botón que no puede');
    assert.strictEqual(cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H1, accion: 'reject', motivo: 'no' }] })).codigo, 'sin_identidad');
    assert.strictEqual(apiOps.st.pedidos.length, 0);
  });
  await conSitio({ sinPerfil: true }, async ({ modelo, enviar, pagina, seccion, apiOps }) => {
    const m = cuerpo(await modelo());
    assert.strictEqual(m.escritura.rechazar, null, 'rechazar puede');
    assert.match(m.escritura.aprobar, /SITE_PROFILE_WRITE_TOKEN/);
    const s = seccion((await pagina()).texto);
    assert.match(s, /<button[^>]*data-accion="reject"(?![^>]*disabled)/);
    assert.doesNotMatch(s, /<button[^>]*data-accion="approve"(?![^>]*disabled)/);
    assert.strictEqual(cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H1, accion: 'approve', texto: 'x' }] })).codigo, 'sin_identidad');
    assert.strictEqual(cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H1, accion: 'reject', motivo: 'no' }] })).ok, true);
    assert.strictEqual(apiOps.st.pedidos.length, 1);
  });
  await conSitio({ sinRepoPerfil: true }, async ({ modelo }) => {
    assert.match(cuerpo(await modelo()).escritura.aprobar, /SITE_PROFILE_REPO/);
  });
  await conSitio({ copia: true }, async ({ enviar, escritura, apiOps, ops }) => {
    const j = cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H1, accion: 'reject', motivo: 'no' }] }));
    assert.strictEqual(j.ok, true, j.message);
    assert.strictEqual(escritura.usado, 1, 'la escritura usa el clon aparte');
    assert.strictEqual(JSON.parse(enRama(ops, apiOps.st.pedidos[0].head.ref, `inbox/instincts/propuestas/${H1}.json`)).estado, 'rechazada');
  });
});

// ── T26 aprobada que no llegó al perfil ────────────────────────────────────────────────────────────────────────────
test('T26 4.13-History_ApprovedNotInProfile_ShowsAndReproposes @story-4.13 @ac-16 — «en el perfil», «no llegó al perfil» y volver a proponer', async () => {
  const H7APROBADA = prop(H7, { estado: 'aprobada', redaccion: REGLA('t7', 'a7'), decision: { por: LEAD, el: '2026-11-11', texto: 'Regla aprobada que no llegó', pedido: 'https://github.com/acme/perfil/pull/71' } });
  await conSitio({ ops: { [`inbox/instincts/propuestas/${H7}.json`]: json(H7APROBADA) }, perfil: { [BLOQUE]: `- Regla aprobada que está en el perfil <!-- aprendizaje:${H4} -->\n` } }, async ({ modelo, enviar, apiOps, apiPerfil, perfil, pagina, seccion, reloj }) => {
    let m = cuerpo(await modelo());
    const h4 = m.historial.find((x) => x.huella === H4);
    const h7 = m.historial.find((x) => x.huella === H7);
    assert.strictEqual(h4.enPerfil, true);
    assert.strictEqual(h7.enPerfil, false);
    assert.strictEqual(h7.pedido, 'https://github.com/acme/perfil/pull/71', 'el enlace es de la plataforma del perfil');
    assert.strictEqual(h4.pedido, null, 'un enlace a otro sitio, guardado en el archivo, no se pinta');
    assert.strictEqual(h7.reproponer, true);
    assert.strictEqual(h4.reproponer, false);
    const s = seccion((await pagina()).texto);
    assert.ok(s.includes(TX.t('es', 'aprend.enElPerfil')) && s.includes(TX.t('es', 'aprend.noLlego')));
    assert.ok(s.includes(TX.t('es', 'aprend.reproponer')));
    const j = cuerpo(await enviar({ marca: MARCA(), decisiones: [{ huella: H7, accion: 'repropose' }] }));
    assert.strictEqual(j.ok, true, j.message);
    assert.strictEqual(apiPerfil.st.pedidos.length, 1);
    assert.strictEqual(apiOps.st.pedidos.length, 0, 'operaciones no cambia');
    assert.match(enRama(perfil, apiPerfil.st.pedidos[0].head.ref, BLOQUE), new RegExp(`Regla aprobada que no llegó <!-- aprendizaje:${H7} -->`));
    reloj.t += 61 * 1000;
    m = cuerpo(await modelo());
    const otra = m.historial.find((x) => x.huella === H7);
    assert.ok(otra.esperando, 'con el pedido abierto, esperando aprobación');
    assert.strictEqual(otra.reproponer, false);
  });
});

// ── 4.14: la recomendación de la noche, y decidir muchas juntas ─────────────────────────────────────────────────────────

const H8 = 'a000000008'; const H9 = 'a000000009';
const ARCHIVO_RECOS = '.dashboard/instincts/recomendaciones.json';
const POR_MODELO_SI = 'Le sirve a todo el equipo';
const POR_MODELO_NO = 'Ya lo cubre otra regla';
const porRegla = (regla) => ({ recomendacion: { accion: 'rechazar', por: 'regla', regla, porque: 'texto de la noche' }, sin_recomendacion: null });
const porModelo = (accion, porque) => ({ recomendacion: { accion, por: 'modelo', modelo: 'gemma4:31b', porque, el: '2026-11-16', de: 'abcdef0123' }, sin_recomendacion: null });
const sinRecomendar = (motivo) => ({ recomendacion: null, sin_recomendacion: motivo });
const pendienteExtra = (h) => ({ [`inbox/instincts/propuestas/${h}.json`]: json(prop(h, { redaccion: REGLA(`cuando ${h}`, `hacer ${h}`) })) });
const conRecos = (porHuella, extra = {}) => ({ [ARCHIVO_RECOS]: json({ fecha: '2026-11-16', por_huella: porHuella }), ...extra });
const cartaDe = (s, h) => (new RegExp(`<article class="a-carta"[^>]*data-huella="${h}"[\\s\\S]*?</article>`).exec(s) || [''])[0];
const CUATRO = conRecos({ [H1]: porModelo('aprobar', POR_MODELO_SI), [H3]: porModelo('rechazar', POR_MODELO_NO), [H7]: porRegla('carpeta_de_trabajo'), [H2]: sinRecomendar('tope') }, pendienteExtra(H7));

test('T12 4.14-Card_ShowsRecommendationAndWhy @story-4.14 @ac-12 @ac-18 — cada tarjeta dice qué recomienda la noche y por qué, sin nombrar el modelo', async () => {
  await conSitio({ ops: CUATRO }, async ({ pagina, seccion, lead, modelo }) => {
    for (const idioma of ['es', 'en']) {
      const s = seccion((await pagina(`${lead}; sitio-idioma=${idioma}`)).texto);
      const t = (k, v) => TX.t(idioma, k, v);
      const aprueba = cartaDe(s, H1);
      assert.ok(aprueba.includes(t('aprend.recomiendaAprobar')), `${idioma}: dice aprobar`);
      assert.ok(aprueba.includes(`<span lang="es">${POR_MODELO_SI}</span>`), `${idioma}: el porqué del modelo, marcado en castellano`);
      assert.ok(aprueba.includes(t('aprend.propusoModelo')), `${idioma}: dice que lo propuso el modelo`);
      assert.strictEqual(aprueba.includes(TX.t('en', 'aprend.razonEnCastellano')), idioma === 'en', 'la nota de idioma, sólo fuera del castellano');
      assert.ok(cartaDe(s, H3).includes(t('aprend.recomiendaRechazar')));
      const regla = cartaDe(s, H7);
      assert.ok(regla.includes(t('aprend.recomiendaRechazar')));
      assert.ok(regla.includes(t('aprend.regla.carpeta_de_trabajo')), `${idioma}: la regla en llano y en su idioma`);
      assert.ok(!regla.includes(t('aprend.propusoModelo')));
      assert.ok(cartaDe(s, H2).includes(t('aprend.sinRec.tope')), `${idioma}: sin recomendación, dice por qué`);
      for (const h of [H1, H2, H3, H7]) assert.doesNotMatch(cartaDe(s, h), /gemma/, 'el nombre del modelo no se muestra');
    }
    assert.doesNotMatch(JSON.stringify(cuerpo(await modelo()).pendientes), /gemma/, 'tampoco en lo que devuelve la API');
  });
  // sin el archivo, todavía no recomendó; con uno ilegible, se dice como con cualquier archivo
  await conSitio({}, async ({ pagina, seccion }) => assert.ok(cartaDe(seccion((await pagina()).texto), H1).includes(TX.t('es', 'aprend.sinRec.todavia'))));
  await conSitio({ ops: { [ARCHIVO_RECOS]: '{ no es json' } }, async ({ pagina, seccion, modelo }) => {
    const m = cuerpo(await modelo());
    assert.strictEqual(m.estado, 'ilegible');
    assert.ok(m.frase.includes(ARCHIVO_RECOS));
    assert.ok(cartaDe(seccion((await pagina()).texto), H1).includes(TX.t('es', 'aprend.sinRec.ilegible')));
  });
  // una recomendación de algo que ya no está pendiente no aparece
  await conSitio({ ops: conRecos({ [H5]: porRegla('confianza') }) }, async ({ modelo }) => {
    assert.ok(cuerpo(await modelo()).pendientes.every((p) => !p.recomendacion));
  });
  // una acción que no es ninguna de las dos no se muestra, aunque se llame como algo que todo objeto trae
  await conSitio({ ops: conRecos({ [H1]: porModelo('constructor', POR_MODELO_SI) }) }, async ({ pagina, seccion }) => {
    const carta = cartaDe(seccion((await pagina()).texto), H1);
    assert.ok(carta.includes(TX.t('es', 'aprend.sinRec.todavia')));
    assert.doesNotMatch(carta, /data-recomendada/);
  });
});

test('T13 4.14-Card_RecommendedButtonHighlighted @story-4.14 @ac-13 — el botón recomendado va resaltado, como en Mantenimiento', async () => {
  await conSitio({ ops: CUATRO }, async ({ pagina, seccion }) => {
    const s = seccion((await pagina()).texto);
    assert.match(cartaDe(s, H1), /<article[^>]*data-recomendada="approve"/);
    assert.match(cartaDe(s, H1), /class="a-elegir recomendada" data-accion="approve"/);
    assert.match(cartaDe(s, H1), /class="a-elegir" data-accion="reject"/);
    assert.match(cartaDe(s, H3), /<article[^>]*data-recomendada="reject"/);
    assert.match(cartaDe(s, H3), /class="a-elegir recomendada" data-accion="reject"/);
    assert.doesNotMatch(cartaDe(s, H2), /data-recomendada|a-elegir recomendada/, 'sin recomendación, sin resaltado');
    assert.ok(cartaDe(s, H1).indexOf(TX.t('es', 'aprend.decidir')) < cartaDe(s, H1).indexOf('data-accion="approve"'), 'los botones siguen bajo «Decidir»');
  });
});

test('T14 4.14-Send_ManyRejectsSameMotive_OneRequest @story-4.14 @ac-15 — varias rechazadas con un motivo salen en un solo pedido', async () => {
  const MOTIVO = 'ruido de una carpeta de trabajo';
  const hs = [H1, H2, H3, H7, H8];
  await conSitio({ ops: { ...pendienteExtra(H7), ...pendienteExtra(H8) } }, async ({ enviar, apiOps, ops }) => {
    const j = cuerpo(await enviar({ marca: MARCA(), decisiones: hs.map((huella) => ({ huella, accion: 'reject', motivo: MOTIVO })) }));
    assert.strictEqual(j.ok, true, j.message);
    assert.strictEqual(apiOps.st.pedidos.length, 1);
    for (const h of hs) {
      const p = JSON.parse(enRama(ops, apiOps.st.pedidos[0].head.ref, `inbox/instincts/propuestas/${h}.json`));
      assert.strictEqual(p.estado, 'rechazada');
      assert.strictEqual(p.decision.motivo, MOTIVO);
    }
  });
});

test('T15 4.14-Cards_RuleDataAndChooseControls @story-4.14 @ac-15 — cada tarjeta se puede elegir y la barra elige por regla', async () => {
  const ops = conRecos({ [H7]: porRegla('carpeta_de_trabajo'), [H8]: porRegla('carpeta_de_trabajo'), [H9]: porRegla('ruta_de_una_maquina'), [H1]: porModelo('rechazar', POR_MODELO_NO) },
    { ...pendienteExtra(H7), ...pendienteExtra(H8), ...pendienteExtra(H9) });
  await conSitio({ ops }, async ({ pagina, seccion }) => {
    const s = seccion((await pagina()).texto);
    for (const h of [H1, H2, H3, H7, H8, H9]) assert.match(cartaDe(s, h), /class="a-elige"/, `${h} tiene su casilla`);
    assert.match(cartaDe(s, H7), /<article[^>]*data-regla="carpeta_de_trabajo"/);
    assert.match(cartaDe(s, H9), /<article[^>]*data-regla="ruta_de_una_maquina"/);
    assert.doesNotMatch(cartaDe(s, H1), /data-regla=/, 'la del modelo no es de ninguna regla');
    const boton = (regla, n) => `data-regla="${regla}">${TX.t('es', 'aprend.elegirRegla', { regla: TX.t('es', `aprend.reglaNombre.${regla}`), n })}</button>`;
    assert.ok(s.includes(boton('carpeta_de_trabajo', 2)), 'una elección por regla presente, con su cuenta');
    assert.ok(s.includes(boton('ruta_de_una_maquina', 1)));
    assert.ok(!s.includes('data-regla="conteo_sin_leccion"'), 'la regla que no está no se ofrece');
    assert.match(s, /class="[^"]*a-motivo-grupo"/);
    assert.ok(s.includes(TX.t('es', 'aprend.rechazarElegidas')));
  });
});

test('T16 4.14-Send_UpTo200_201Is400 @story-4.14 @ac-16 — 200 decisiones en un pedido corto, leyendo una vez la política', async () => {
  const hs = Array.from({ length: 260 }, (_, i) => `b${String(i).padStart(9, '0')}`);
  const ops = Object.assign({}, ...hs.map(pendienteExtra));
  const rechazos = (lista) => lista.map((huella) => ({ huella, accion: 'reject', motivo: 'ruido' }));
  await conSitio({ ops }, async ({ enviar, apiOps, ops: repo }) => {
    const politica = () => apiOps.llamadas.filter((l) => l.ruta.endsWith('/branches/main/protection')).length;
    const j = cuerpo(await enviar({ marca: MARCA(), decisiones: rechazos(hs.slice(0, 200)) }));
    assert.strictEqual(j.ok, true, j.message);
    assert.strictEqual(apiOps.st.pedidos.length, 1);
    const pedido = apiOps.st.pedidos[0];
    assert.strictEqual(g(repo.bare, 'diff', '--name-only', `main...${pedido.head.ref}`).split('\n').length, 200);
    assert.ok(pedido.body.length < 1000, `la descripción no crece con el envío: ${pedido.body.length}`);
    assert.match(pedido.body, /200 se rechazan/);
    assert.ok(!pedido.body.includes(hs[0]), 'con más de 50 no se nombra cada una');
    assert.strictEqual(politica(), 1, 'la política de la rama se lee una sola vez');
    const j2 = cuerpo(await enviar({ marca: MARCA(), decisiones: rechazos(hs.slice(200, 250)) }));
    assert.strictEqual(j2.ok, true, j2.message);
    for (const h of hs.slice(200, 250)) assert.ok(apiOps.st.pedidos[1].body.includes(h), 'hasta 50, cada una por su nombre');
    const r = await enviar({ marca: MARCA(), decisiones: rechazos(hs.slice(0, 201)) });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(apiOps.st.pedidos.length, 2, 'con 201 no se crea nada');
  });
});

test('T17 4.14-NightLine_ShowsFilteredCount @story-4.14 @ac-17 — la línea de la noche dice cuánto dejó afuera y qué quedó sin redactar', async () => {
  const informe = { ...INFORME, sin_redaccion: { tope: 0, fallo: 0, sin_modelo: 0, sin_llave: 0 }, filtradas: { conteo_sin_leccion: 2, carpeta_de_trabajo: 4, ruta_de_una_maquina: 1, un_solo_proyecto: null },
    en_espera_por: { tope: 9, fallo: 1, sin_modelo: 0, sin_llave: 2 } };
  await conSitio({ ops: { '.dashboard/instincts/instintos-2026-11-16.json': json(informe) } }, async ({ pagina, seccion }) => {
    const s = seccion((await pagina()).texto);
    assert.match(s, /Dejó afuera 7 por ruido/);
    assert.match(s, /quedaron 3 sin redactar/, 'cuenta las que esperan por llave, modelo o falla, no las del tope');
  });
  await conSitio({}, async ({ pagina, seccion }) => assert.match(seccion((await pagina()).texto), /Dejó afuera \? por ruido/));
  const { sin_redaccion: _s, ...sinClaves } = INFORME;
  await conSitio({ ops: { '.dashboard/instincts/instintos-2026-11-16.json': json(sinClaves) } }, async ({ pagina, seccion }) => assert.match(seccion((await pagina()).texto), /quedaron \? sin redactar/));
});

// E1-E3 en un navegador de verdad: el cliente de la pestaña sólo se puede medir ahí. Playwright no es una dependencia del
// arnés: se usa su versión fija; sin ella se saltean con constancia, salvo con la llave exigente (E2E_REQUIRED=1).
const PINNED_PW = require('../lib/pinned-playwright.js');
const PLAYWRIGHT = PINNED_PW.load();
const SIN_NAVEGADOR = process.env.E2E_REQUIRED === '1' ? false : !PLAYWRIGHT && PINNED_PW.locate().why;
async function enNavegador({ h, lead }, fn) {
  assert.ok(PLAYWRIGHT, `con la llave exigente prendida, Playwright tiene que estar: ${PINNED_PW.locate().why}`);
  const navegador = await PLAYWRIGHT.chromium.launch();
  try {
    const ctx = await navegador.newContext();
    await ctx.setExtraHTTPHeaders({ cookie: lead });
    const page = await ctx.newPage();
    await page.route('**/api/aprendizajes/**', async (rt) => rt.fulfill({ response: await rt.fetch({ headers: { ...rt.request().headers(), cookie: lead, origin: 'http://127.0.0.1' } }) }));
    await page.goto(`${h.base}/aprendizajes`);
    await fn(page, (huella) => page.locator(`article[data-huella="${huella}"]`));
  } finally { await navegador.close(); }
}
const marcada = (carta, accion) => carta.locator(`button[data-accion="${accion}"][aria-pressed="true"]`).count();

test('E1 4.14-E2E_Learnings_FollowRecommendations @story-4.14 @ac-14 — seguir las recomendaciones marca cada tarjeta con su acción', { skip: SIN_NAVEGADOR, timeout: 120000 }, async () => {
  await conSitio({ ops: CUATRO }, async (x) => enNavegador(x, async (page, carta) => {
    await page.getByRole('button', { name: TX.t('es', 'aprend.seguir', { n: 3 }) }).click();
    assert.strictEqual(await marcada(carta(H1), 'approve'), 1);
    assert.strictEqual(await carta(H1).locator('.a-texto').inputValue(), 'cuando se toca el login: correr las pruebas de seguridad', 'la aprobación lleva la regla sugerida');
    assert.strictEqual(await marcada(carta(H3), 'reject'), 1);
    assert.strictEqual(await carta(H3).locator('.a-motivo').inputValue(), POR_MODELO_NO, 'el rechazo lleva el porqué');
    assert.strictEqual(await carta(H7).locator('.a-motivo').inputValue(), TX.t('es', 'aprend.regla.carpeta_de_trabajo'));
    assert.strictEqual(await carta(H2).locator('button[aria-pressed="true"]').count(), 0, 'la que no tiene recomendación queda sin marcar');
    assert.strictEqual(await page.locator('.a-cuenta').innerText(), TX.t('es', 'aprend.barra.elegidas', { n: 3 }));
    // los dos campos siguen editables
    await carta(H3).locator('.a-motivo').fill('otro motivo');
    assert.strictEqual(await carta(H3).locator('.a-motivo').inputValue(), 'otro motivo');
  }));
});

test('E2 4.14-E2E_Learnings_BulkRejectOneMotive @story-4.14 @ac-15 — elegir varias y rechazarlas con un motivo', { skip: SIN_NAVEGADOR, timeout: 120000 }, async () => {
  const MOTIVO = 'no le sirve al equipo';
  const ops = conRecos({ [H7]: porRegla('carpeta_de_trabajo'), [H8]: porRegla('carpeta_de_trabajo'), [H9]: porRegla('ruta_de_una_maquina') }, { ...pendienteExtra(H7), ...pendienteExtra(H8), ...pendienteExtra(H9) });
  await conSitio({ ops }, async (x) => enNavegador(x, async (page, carta) => {
    const cinco = [H1, H3, H7, H8, H9];
    await carta(H1).locator('button[data-accion="approve"]').click();
    for (const h of cinco) await carta(h).locator('.a-elige').check();
    await page.locator('.a-motivo-grupo').fill(MOTIVO);
    await page.getByRole('button', { name: TX.t('es', 'aprend.rechazarElegidas') }).click();
    for (const h of cinco) {
      assert.strictEqual(await marcada(carta(h), 'reject'), 1, `${h} queda rechazada`);
      assert.strictEqual(await carta(h).locator('.a-motivo').inputValue(), MOTIVO);
    }
    assert.strictEqual(await marcada(carta(H1), 'approve'), 0, 'la que estaba para aprobar cambia');
    assert.strictEqual(await page.locator('.a-elige:checked').count(), 0, 'la elección se vacía');
    // elegir por regla toma sólo las de esa regla
    await page.getByRole('button', { name: TX.t('es', 'aprend.elegirRegla', { regla: TX.t('es', 'aprend.reglaNombre.carpeta_de_trabajo'), n: 2 }) }).click();
    assert.strictEqual(await carta(H7).locator('.a-elige').isChecked(), true);
    assert.strictEqual(await carta(H8).locator('.a-elige').isChecked(), true);
    assert.strictEqual(await carta(H9).locator('.a-elige').isChecked(), false);
    assert.strictEqual(x.apiOps.st.pedidos.length, 0, 'nada se envía hasta «Enviar para aprobar»');
    await page.getByRole('button', { name: TX.t('es', 'aprend.enviar') }).click();
    await page.locator('.a-estado').filter({ hasText: TX.t('es', 'aprend.sigue.aprobar') }).waitFor({ timeout: 30000 });
    assert.strictEqual(x.apiOps.st.pedidos.length, 1);
    for (const h of cinco) {
      const p = JSON.parse(enRama(x.ops, x.apiOps.st.pedidos[0].head.ref, `inbox/instincts/propuestas/${h}.json`));
      assert.strictEqual(p.estado, 'rechazada', h);
      assert.strictEqual(p.decision.motivo, MOTIVO, h);
    }
  }));
});

test('E3 4.14-E2E_Learnings_Over200_SendDisabled @story-4.14 @ac-16 — con más de 200 marcadas no se puede enviar', { skip: SIN_NAVEGADOR, timeout: 180000 }, async () => {
  const hs = Array.from({ length: 201 }, (_, i) => `c${String(i).padStart(9, '0')}`);
  const ops = conRecos(Object.fromEntries(hs.map((h) => [h, porRegla('carpeta_de_trabajo')])), Object.assign({}, ...hs.map(pendienteExtra)));
  await conSitio({ ops }, async (x) => enNavegador(x, async (page, carta) => {
    await page.getByRole('button', { name: TX.t('es', 'aprend.seguir', { n: 201 }) }).click();
    assert.ok((await page.locator('.a-cuenta').innerText()).includes(TX.t('es', 'aprend.barra.sobran', { n: 1 })), 'la barra dice cuántas sobran');
    assert.strictEqual(await page.locator('.a-enviar').isDisabled(), true);
    await carta(hs[0]).locator('button[data-accion="reject"]').click();
    assert.strictEqual(await page.locator('.a-enviar').isDisabled(), false, 'al bajar a 200 se puede enviar');
  }));
});
