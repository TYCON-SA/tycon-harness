#!/usr/bin/env node
'use strict';
/*
 * site-guide-captures.js — saca las capturas de la guía del sitio (guides/organization-site.md) del sitio
 * corriendo. Vive fuera de scripts/site/ a propósito: esa carpeta es lo que viaja en la imagen del sitio, y no nombra
 * ninguna nube ni valores de una organización; este guion arma un laboratorio con todo eso.
 *
 * Levanta el sitio REAL en esta máquina, con todo lo que trae la imagen: el servidor (server.js), sus fuentes (sources.js,
 * que clona por HTTP el repo de operaciones y el del perfil y baja el buzón de corridas) y las dos pestañas con código
 * propio (tabs/config.js y tabs/runs.js). Lo que el sitio lee es de laboratorio: la organización `acme`, con personas,
 * máquinas, productos y repos inventados, servidos en esta máquina (un emisor de inicio de sesión, dos repos git por HTTP,
 * un buzón y una API de GitHub de mentira). Nada habla con la red, y ninguna captura muestra una organización real.
 *
 * Un navegador sin ventana (Chromium, con playwright-core) entra como cada persona y saca cada captura de CAPTURAS con su
 * nombre fijo. Al lado de cada `<nombre>.png` deja `<nombre>.html`: el HTML de la página tal como el navegador la tenía
 * en el momento de la captura. Sobre ese texto la prueba de la guía busca nombres reales (una imagen no se puede leer).
 *
 * Uso:
 *   node scripts/tools/site-guide-captures.js --out guides/sitio-de-la-organizacion/capturas   # todas
 *   node scripts/tools/site-guide-captures.js --out <carpeta> --only inicio-quien-mantiene    # una (o varias)
 *   node scripts/tools/site-guide-captures.js --list                                          # los nombres
 *
 * Lo que pide la máquina: Node 20 o más, git con `git http-backend` (viene con git), y playwright-core con su Chromium.
 * Si playwright-core no se encuentra, se instala una vez en ~/.cache/site-guide-captures/playwright (fuera del repo) con su
 * navegador; el repo no lo trae. Salida: 0 si sacó todas, 1 si alguna falló (dice cuál), 2 si falta algo de la máquina.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const req = (rel) => require(path.join(ROOT, rel));

const LEAD = 'lead@acme.example';
const ANA = 'ana@acme.example';
const BRUNO = 'bruno@acme.example';
// los datos son de hoy: una foto más vieja que su plazo sale «no medido» en la captura
const HOY = new Date().toISOString().slice(0, 10);
const AYER = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

// Las capturas, en el orden de la guía. `espera`: un texto que la pantalla tiene que mostrar a la vista; si no está, la
// captura no se guarda (una pantalla de error o la de otra pestaña no pasa por buena). `sitio`: con qué laboratorio (normal, sin política de revisión en el perfil, falla,
// frenado, cargando); `quien`: con qué correo entra; `pasos`: lo que el navegador hace antes de sacarla.
const CAPTURAS = [
  { nombre: 'inicio-quien-mantiene', sitio: 'normal', quien: LEAD, ruta: '/', espera: 'Qué decidir hoy' },
  { nombre: 'inicio-persona', sitio: 'normal', quien: ANA, ruta: '/', espera: 'Lo tuyo' },
  { nombre: 'corridas-tabla', sitio: 'normal', quien: LEAD, ruta: '/corridas', espera: 'Lo que se mira primero', barras: true },
  { nombre: 'corridas-detalle', sitio: 'normal', quien: LEAD, ruta: '/corridas', pasos: 'abrirCorrida', espera: 'Qué encontraron los controles' },
  { nombre: 'corridas-leyenda', sitio: 'normal', quien: LEAD, ruta: '/corridas', pasos: 'leyenda', espera: 'Ejecución por ejecución', barras: true },
  { nombre: 'proyectos', sitio: 'normal', quien: LEAD, ruta: '/proyectos', espera: 'Cómo va cada producto' },
  { nombre: 'arnes', sitio: 'normal', quien: LEAD, ruta: '/arnes', espera: 'Cómo está el arnés' },
  { nombre: 'como-trabaja', sitio: 'normal', quien: LEAD, ruta: '/como-trabaja', espera: 'Tu organización' },
  { nombre: 'ayuda-persona', sitio: 'normal', quien: ANA, ruta: '/ayuda', espera: 'Problemas comunes' },
  { nombre: 'ayuda-quien-mantiene', sitio: 'normal', quien: LEAD, ruta: '/ayuda#las-recetas', espera: 'Las recetas' },
  { nombre: 'configuracion-personas', sitio: 'normal', quien: LEAD, ruta: '/configuracion#pestana-personas', pasos: 'config', espera: 'Quién entra al sitio' },
  { nombre: 'configuracion-confirmar-maquina', sitio: 'normal', quien: LEAD, ruta: '/configuracion#seccion-personas', pasos: 'config', espera: 'Por confirmar' },
  { nombre: 'configuracion-repos', sitio: 'normal', quien: LEAD, ruta: '/configuracion#pestana-repos', pasos: 'config', espera: 'Dónde vive cada repo' },
  { nombre: 'configuracion-avisos', sitio: 'normal', quien: LEAD, ruta: '/configuracion#pestana-avisos', pasos: 'config', espera: 'Aviso de espera' },
  { nombre: 'configuracion-pedidos', sitio: 'normal', quien: LEAD, ruta: '/configuracion#seccion-pedidos', pasos: 'config', espera: 'Valores leídos de la plataforma' },
  { nombre: 'configuracion-claude', sitio: 'normal', quien: LEAD, ruta: '/configuracion#pestana-claude', pasos: 'config', espera: 'Cómo contesta el agente' },
  { nombre: 'configuracion-tecnologia', sitio: 'normal', quien: LEAD, ruta: '/configuracion#seccion-tecnologia', pasos: 'config', espera: 'Cómo se corren las pruebas' },
  { nombre: 'configuracion-instalacion', sitio: 'normal', quien: LEAD, ruta: '/configuracion#pestana-instalacion', pasos: 'config', espera: 'Perfil de instalación' },
  { nombre: 'configuracion-revisado', sitio: 'normal', quien: LEAD, ruta: '/configuracion#seccion-respuesta', pasos: 'revisar', espera: 'Revisado: está bien escrito' },
  { nombre: 'configuracion-diferencia', sitio: 'normal', quien: LEAD, ruta: '/configuracion#seccion-respuesta', pasos: 'proponer', espera: 'Mirá la diferencia antes de confirmar' },
  { nombre: 'configuracion-propuesto', sitio: 'normal', quien: LEAD, ruta: '/configuracion#seccion-respuesta', pasos: 'confirmar', espera: 'Pedido abierto' },
  { nombre: 'sin-rol', sitio: 'normal', quien: BRUNO, ruta: '/', espera: 'Tu cuenta no está en la lista' },
  { nombre: 'no-se-pudo-actualizar', sitio: 'falla', quien: LEAD, ruta: '/', espera: 'no se pudo actualizar' },
  { nombre: 'sitio-frenado', sitio: 'frenado', quien: LEAD, ruta: '/', espera: 'Sitio frenado' },
  { nombre: 'cargando-corridas', sitio: 'cargando', quien: LEAD, ruta: '/corridas', espera: 'cargando las ejecuciones' },
  { nombre: 'proponer-apagado', sitio: 'sinPolitica', quien: LEAD, ruta: '/configuracion#seccion-respuesta', pasos: 'config', espera: 'no tiene una política' },
];

// ── los datos de laboratorio ────────────────────────────────────────────────────────────────────────────────────────
const iso = (t0, min) => new Date(Date.parse(t0) + min * 60000).toISOString();
/** Una corrida del pipeline como la sube upload-runs.js: su marcador, sus controles, su costo y su consumo. */
function volcado(sid, inicio, { story, repo, pasos = [0, 1, 2, 3, 4, 5, 6, 7, 8], rojo = false } = {}) {
  const m = (x) => iso(inicio, x);
  const tiempos = Object.fromEntries(pasos.map((p, i) => [p, { completedAt: m(5 + i * 12) }]));
  return JSON.stringify({
    archivedAt: m(130),
    marker: { storyId: story, storyPath: `/home/dev/acme/specs/story-${story}-una-mejora.md`, repoPath: `/home/dev/acme/${repo}`, sessionId: sid, startedAt: m(0), lastTouch: m(120),
      stepsCompleted: pasos, stepsPending: [], stepTimings: tiempos },
    gates: [
      { ts: m(20), sessionId: sid, check: 'build', status: 'green', exit: 0, durationMs: 11000 },
      { ts: m(40), sessionId: sid, check: 'tests', status: rojo ? 'red:exit=1' : 'green', exit: rojo ? 1 : 0, durationMs: 61000 },
    ],
    costo: { spawns: 8, adhoc: 0, iteraciones: 1, por_tipo: {} },
    consumo: { estado: 'medido', respuestas: 40, sinteticos: 0, lineas_ilegibles: 0, tokens: { in: 900, out: 30000, cache_new: 100000, cache_read: 1800000 },
      por_modelo: {}, por_paso: { 4: 50000, 5: 60000 }, fuera_de_ventana: 0, hilo_hasta: m(126), medido_en: m(300) },
  });
}
/** El comienzo de una corrida de hace `n` horas, en hora redonda. */
const haceHoras = (n) => new Date(Math.floor((Date.now() - n * 36e5) / 36e5) * 36e5).toISOString();
const lugar = (correo) => JSON.stringify({ day: HOY, owner: { email: correo }, folder: null });

/** El buzón: tres máquinas (la de ana, confirmada; la de bruno, sin confirmar; la de quien mantiene), con sus corridas. */
function blobsDelBuzon() {
  const b = {};
  const sid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const corridas = [
    ['mac-ana', '1.4', 'Producto-X/FrontEnd', haceHoras(50), {}],
    ['mac-ana', '1.5', 'Producto-X/FrontEnd', haceHoras(28), { rojo: true }],
    ['mac-ana', '2.1', 'Producto-Y/Backend', haceHoras(6), { pasos: [0, 1, 2, 3, 4] }],
    ['mac-bruno', '2.2', 'Producto-Y/Backend', haceHoras(8), {}],
    ['mac-lead', '3.1', 'Producto-X/Backend', haceHoras(75), {}],
  ];
  corridas.forEach(([maq, story, repo, inicio, extra], i) => { b[`${maq}/${sid(i + 1)}.json`] = volcado(sid(i + 1), inicio, { story, repo, ...extra }); });
  b['mac-ana/registros/place.json'] = lugar(ANA);
  b['mac-bruno/registros/place.json'] = lugar(BRUNO);
  b['mac-lead/registros/place.json'] = lugar(LEAD);
  return b;
}

const GH = (repo) => ({ platform: 'github', org: 'acme', repo });
/** La API de pedidos de trabajo de mentira: los tipos de cada proyecto y los campos del tipo «Riesgo», con sus valores. */
async function azureFalso() {
  const CAMPOS = [
    { referenceName: 'Custom.Categoria', name: 'Categoría', allowedValues: ['Calidad', 'Operacional', 'Seguridad', 'Técnico'] },
    { referenceName: 'Custom.Probabilidad', name: 'Probabilidad', allowedValues: ['1', '2', '3', '4', '5'] },
    { referenceName: 'Custom.Impacto', name: 'Impacto', allowedValues: ['1', '2', '3', '4', '5'] },
    { referenceName: 'Custom.Prioridad', name: 'Prioridad del riesgo', allowedValues: ['🔴 Crítico (21-25)', '🟠 Alto (15-20)', '🟡 Medio (8-14)', '🟢 Bajo (1-7)'] },
    { referenceName: 'Custom.Disparador', name: 'Disparador' },
    { referenceName: 'Custom.PlanDeMitigacion', name: 'Plan de mitigación' },
  ];
  const server = require('http').createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const doc = /\/workitemtypecategories\//.test(u.pathname) ? { workItemTypes: [] }
      : /\/workitemtypes\/Riesgo\/fields$/.test(u.pathname) ? { value: CAMPOS }
        : /\/workitemtypes$/.test(u.pathname) ? { value: [{ name: 'Bug' }, { name: 'Riesgo' }, { name: 'Tarea' }] } : null;
    // lo demás (los pipelines de cada proyecto) contesta «sin permiso», como sin la credencial: las otras capturas no cambian
    res.writeHead(doc ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(doc || {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, cerrar: () => new Promise((r) => server.close(r)) };
}
/** Los archivos del repo de operaciones. `extra.access`: la lista de quién entra en lugar de la de antes (site.maintainers). */
function operaciones(extra = {}) {
  const H = req('scripts/tests/lib/site-harness.js');
  const ops = {
    version: 1,
    owners: { default: LEAD },
    site: { maintainers: [LEAD], url: 'https://sitio.acme.example', refresh_minutes: 15, brand: { name: 'Acme' },
      mailbox: { provider: 'azure-blob', account: 'acmecorridas', container: 'corridas', threads: false } },
    people: { machines: {
      'mac-ana': { person: ANA, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' },
      'mac-lead': { person: LEAD, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' },
    } },
    // los pedidos de vulnerabilidades, con el tipo y los campos que devuelve la plataforma de mentira (azureFalso)
    work_items: { type: 'Riesgo', fixed_fields: { 'Custom.Categoria': 'Seguridad', 'Custom.Probabilidad': 3 }, by_severity: {
      critical: { 'Custom.Impacto': 5, 'Custom.Prioridad': '🔴 Crítico (21-25)' }, high: { 'Custom.Impacto': 4, 'Custom.Prioridad': '🟠 Alto (15-20)' },
      moderate: { 'Custom.Impacto': 3, 'Custom.Prioridad': '🟡 Medio (8-14)' }, low: { 'Custom.Impacto': 2, 'Custom.Prioridad': '🟢 Bajo (1-7)' } } },
  };
  if (extra.access) { delete ops.site.maintainers; ops.site.access = extra.access; }
  const archivos = H.archivosDeOperaciones({ hoy: HOY, ayer: AYER, config: ops });
  // los proyectos del día: dos productos con sus stories (sólo número, estado y días en el estado)
  delete archivos['.dashboard/proyectos/Proyecto X__Repo X.json'];
  // la organización con la forma del archivo real; los pedidos se leen de azureFalso, nunca de la red
  archivos['scripts/nightly/dependencies/repos.json'] = { azure: { org: 'https://dev.azure.com/acme' }, repos: [
    { producto: 'Producto X', ruta: 'Producto-X/FrontEnd', ado: 'Producto X/FrontEnd', tipo: 'npm', activo: true },
    { producto: 'Producto Y', ruta: 'Producto-Y/Backend', ado: 'Producto Y/Backend', tipo: 'nuget', activo: true },
  ] };
  archivos['.dashboard/proyectos/Producto X__FrontEnd.json'] = { v: 1, generated_at: `${HOY}T06:00:00Z`, proyecto: 'Producto X', repo: 'FrontEnd', stories: [
    { id: '1.4', titulo: 'una mejora', grupo: 'en_curso', canonico: 'in-progress', dias_en_estado: 2 },
    { id: '1.5', titulo: 'otra mejora', grupo: 'en_revision', canonico: 'review', dias_en_estado: 1 },
    { id: '1.2', titulo: 'una vieja', grupo: 'parado', canonico: 'in-progress', dias_en_estado: 12 },
  ] };
  archivos['.dashboard/proyectos/Producto Y__Backend.json'] = { v: 1, generated_at: `${HOY}T06:00:00Z`, proyecto: 'Producto Y', repo: 'Backend', stories: [
    { id: '2.1', titulo: 'una mejora', grupo: 'en_curso', canonico: 'in-progress', dias_en_estado: 1 },
    { id: '2.2', titulo: 'otra', grupo: 'bloqueado', canonico: 'blocked', dias_en_estado: 4 },
  ] };
  return archivos;
}

const PERFIL = {
  ado: { org: 'https://dev.azure.com/acme' },
  integrations: { clockify: false, engram: true, mailbox: true, codex: 'detect', nightly: true },
  update: { channel: 'latest', apply: 'auto' }, packs: { default: 'all' }, install: { profile: 'full' },
};
// una herramienta de prueba agregada por la organización: la tabla de «Cómo se corren las pruebas» la muestra junto a
// las internas y las recetas de fábrica
const RECETA_NETFX = {
  name: 'netfx-vstest', label: '.NET Framework (vstest)', detect: 'packages.config', detect_depth: 1,
  command: 'bash -c \'vstest.console.exe $(find . -path "*/bin/Debug/*Tests.dll") --logger:trx "--ResultsDirectory:{results}"\'',
  results: { format: 'trx', path: '{results}/**/*.trx' },
};
const REPOS = { version: 1, public: GH('arnes'), profile: GH('perfil'), operations: GH('operaciones'), stack: { test_runners: [RECETA_NETFX] } };

/**
 * Un laboratorio: el sitio real con las fuentes reales sobre los datos de arriba. `variante`:
 *   normal       todo bien, con política de revisión en el perfil (se puede proponer)
 *   sinPolitica  el perfil sin política de revisión en main: «Proponer» apagado
 *   frenado      el repo de operaciones con una configuración que no valida y sin último bueno: el sitio se frena
 *   cargando     el buzón contesta muy lento: el repo de operaciones ya se leyó y las corridas quedan «cargando»
 *   falla        todo se leyó una vez y después el buzón dejó de contestar: la banda «no se pudo actualizar»
 * `opciones.access`: la lista de quién entra (site.access) del repo de operaciones; sin ella, la de antes
 * (site.maintainers), que la pestaña Configuración muestra migrada. `opciones.repos`: claves que se suman a
 * `team-repos.json` del perfil (por ejemplo `models` y `merge_suites`). `opciones.profileFiles`: archivos de más en el
 * repo del perfil (`ruta → contenido`), por ejemplo un paquete de revisores de la organización. `opciones.sinPerfil`: el
 * sitio arranca sin el repo del perfil configurado (lo que ve una organización que todavía no lo declaró).
 */
async function laboratorio(variante, opciones = {}) {
  const ORG = req('scripts/lib/org-config.js');
  const H = req('scripts/tests/lib/site-harness.js');
  const { crearRepoHttp } = req('scripts/tests/lib/git-http-repo.js');
  const { arrancarGithubFalso } = req('scripts/tests/lib/fake-github-api.js');
  const { arrancarEmisor } = req('scripts/tests/lib/fake-oidc.js');
  const { validarConfiguracion, VERSION } = req('scripts/site/server.js');
  const { crearFuentes } = req('scripts/site/sources.js');
  const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
  const raiz = tmp('guia-sitio-');
  for (const d of ['ops', 'perfil']) fs.mkdirSync(path.join(raiz, d));
  const TOKEN = `w-${crypto.randomBytes(8).toString('hex')}`;
  const CAB = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
  const archivosOps = operaciones({ access: opciones.access });
  if (variante === 'frenado') archivosOps['operations.json'] = { version: 1, owners: { default: 'esto no es un correo' }, site: { maintainers: [LEAD] } };
  const json = (o) => (typeof o === 'string' ? o : ORG.formatJson(o));
  const ops = await crearRepoHttp({ raiz: path.join(raiz, 'ops'), nombre: 'operaciones.git', cabecera: CAB, archivos: Object.fromEntries(Object.entries(archivosOps).map(([k, v]) => [k, json(v)])) });
  const perfil = await crearRepoHttp({ raiz: path.join(raiz, 'perfil'), nombre: 'perfil.git', cabecera: CAB, archivos: {
    'team-profile.json': json(PERFIL), 'team-repos.json': json({ ...REPOS, ...(opciones.repos || {}) }), 'team-layer.json': json({ requires: { harness: `>= ${ORG.RESPONSE_SINCE}` } }),
    'skills/acme-guia/SKILL.md': '# una skill de la organización\n', 'agents/acme-revisor.md': '# un revisor de la organización\n', 'onboarding/step-0-mac.md': '# el alta\n',
    ...Object.fromEntries(Object.entries(opciones.profileFiles || {}).map(([k, v]) => [k, json(v)])),
  } });
  const gh = await arrancarGithubFalso({ owner: 'acme', repo: 'perfil' });
  if (variante !== 'sinPolitica') gh.st.proteccion = { required_pull_request_reviews: { required_approving_review_count: 1 } };
  const buzon = await H.arrancarBuzon({ blobs: blobsDelBuzon(), contenedor: 'corridas' });
  if (variante === 'cargando') buzon.st.demora = 10 * 60 * 1000;
  const emisor = await arrancarEmisor();
  const dataDir = path.join(raiz, 'datos');
  fs.mkdirSync(dataDir);
  // la dirección pública lleva el puerto de verdad: el sitio compara el origen de cada escritura con ella
  const puerto = await puertoLibre();
  const env = H.envBase({
    SITE_PUBLIC_URL: `http://127.0.0.1:${puerto}`,
    SITE_OIDC_ISSUER: emisor.issuer, SITE_OPERATIONS_REPO: ops.url, SITE_OPERATIONS_TOKEN: TOKEN, SITE_MAILBOX_SAS: H.sas(),
    ...(opciones.sinPerfil ? {} : { SITE_PROFILE_REPO: perfil.url, SITE_PROFILE_TOKEN: TOKEN, SITE_PROFILE_WRITE_TOKEN: TOKEN }), SITE_DATA_DIR: dataDir,
    SITE_PIPELINES_TOKEN: TOKEN,
  });
  const az = await azureFalso();
  const cfg = validarConfiguracion(env).cfg;
  const fuentes = crearFuentes({ cfg, dataDir, log: process.env.GUIDE_CAPTURES_DEBUG ? (l) => process.stderr.write(`[sitio] ${l}\n`) : () => {}, urlBuzon: buzon.base });
  const remotos = { operaciones: { platform: 'github', org: 'acme', repo: 'operaciones', web: 'https://github.example/acme/operaciones' }, perfil: { platform: 'github', org: 'acme', repo: 'perfil', web: 'https://github.example/acme/perfil' } };
  const rutasConfig = req('scripts/site/tabs/config.js').crearRutas({ cfg, fuentes, versionImagen: VERSION, remotos, urlBase: { github: gh.base, azure: az.base } });
  const rutasCorridas = req('scripts/site/tabs/runs.js').crearRutas({ cfg, fuentes, version: VERSION, skillsDir: path.join(ROOT, 'skills') });
  const { crearSitio } = req('scripts/site/server.js');
  const rutasAyuda = req('scripts/site/help.js').crearRutas({ raiz: ROOT });
  const rutasComoTrabaja = req('scripts/site/tabs/how-it-works.js').crearRutas({ cfg, fuentes, versionImagen: VERSION, remotos, urlBase: { github: gh.base } });
  const sitio = crearSitio({ env, fuentes, log: () => {}, rutasExtra: [...rutasConfig, ...rutasComoTrabaja, ...rutasCorridas, ...rutasAyuda] });
  await sitio.iniciar();
  await new Promise((r) => sitio.server.listen(puerto, '127.0.0.1', r));
  const h = { base: `http://127.0.0.1:${puerto}`, pedir: (ruta, o) => H.pedirA(`http://127.0.0.1:${puerto}`, ruta, o), cerrar: () => sitio.cerrar() };
  // la primera lectura; con el buzón lento no se espera entera: lo que la captura quiere mostrar es la espera
  const primera = fuentes.refrescar();
  if (variante === 'cargando') {
    // hasta que el repo de operaciones se leyó: las pestañas que no esperan el buzón ya se ven
    for (let i = 0; i < 300 && !fuentes.estado().navegable; i++) await new Promise((r) => setTimeout(r, 200));
    if (!fuentes.estado().navegable) throw new Error('el laboratorio «cargando» no llegó a leer el repo de operaciones en 60 s');
  } else {
    await primera;
    if (rutasCorridas.vista && rutasCorridas.vista.listo) await rutasCorridas.vista.listo();
    if (variante === 'falla') { buzon.st.modo = '503'; await fuentes.refrescar(); }
  }
  const sesiones = new Map();
  return {
    base: h.base,
    // el GitHub de juguete del perfil (sus pedidos) y el repo del perfil (lo que se empujó): la prueba en vivo los lee
    gh, perfil,
    async entrar(correo) {
      if (!sesiones.has(correo)) sesiones.set(correo, (await H.ingresar(h, emisor, { sub: `s-${correo}`, email: correo, email_verified: true })).sesion);
      return sesiones.get(correo);
    },
    async cerrar() {
      buzon.st.demora = 0;
      await h.cerrar(); await emisor.cerrar(); await gh.cerrar(); await ops.cerrar(); await perfil.cerrar(); await buzon.cerrar(); await az.cerrar();
      fs.rmSync(raiz, { recursive: true, force: true });
    },
  };
}

/** Un puerto libre de esta máquina. */
function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = require('net').createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ── el navegador ────────────────────────────────────────────────────────────────────────────────────────────────────
const CACHE_PW = path.join(os.homedir(), '.cache', 'site-guide-captures', 'playwright');
const VERSION_PW = '1.63.0';
function playwright() {
  try { return require('playwright-core'); } catch { /* abajo */ }
  const enCache = path.join(CACHE_PW, 'node_modules', 'playwright-core');
  if (!fs.existsSync(enCache)) {
    process.stderr.write(`playwright-core no está: lo instalo una vez en ${CACHE_PW} (fuera del repo)\n`);
    fs.mkdirSync(CACHE_PW, { recursive: true });
    if (!fs.existsSync(path.join(CACHE_PW, 'package.json'))) fs.writeFileSync(path.join(CACHE_PW, 'package.json'), '{"private":true}\n');
    const npm = spawnSync('npm', ['install', '--prefix', CACHE_PW, '--no-audit', '--no-fund', `playwright-core@${VERSION_PW}`], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (npm.status !== 0) return null;
  }
  return require(enCache);
}
async function abrirNavegador(pw) {
  try { return await pw.chromium.launch({ headless: true }); } catch (e) {
    if (!/Executable doesn't exist|install/i.test(String(e && e.message))) throw e;
    process.stderr.write('falta el Chromium de playwright: lo bajo una vez\n');
    const cli = path.join(path.dirname(require.resolve('playwright-core/package.json', { paths: [CACHE_PW, ROOT] })), 'cli.js');
    const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
    if (r.status !== 0) return null;
    return pw.chromium.launch({ headless: true });
  }
}

/** Espera a que la página termine de pedir lo suyo y se quede quieta. */
async function quieta(page) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
}

const PASOS = {
  async config(page) {
    // la pantalla arma sus sub-pestañas al cargar; la del ancla (una sub-pestaña o una sección) la elige ella
    await page.waitForSelector('#config-app nav.pestanas', { state: 'attached', timeout: 60000 });
    await quieta(page);
    const ancla = new URL(page.url()).hash.slice(1);
    const sub = ancla.startsWith('pestana-') ? ancla.slice('pestana-'.length) : await page.evaluate((id) => {
      const el = document.getElementById(id); const panel = el && el.closest('.pestana-panel'); return panel ? panel.id.slice('pestana-'.length) : null;
    }, ancla);
    if (sub) await page.click(`#tab-${sub}`);
    await page.waitForTimeout(300);
    if (ancla.startsWith('seccion-')) await page.locator(`#${ancla}`).scrollIntoViewIfNeeded();
    else await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
  },
  async revisar(page) {
    await PASOS.config(page);
    const sec = page.locator('#seccion-respuesta');
    // un cambio de verdad: el estilo ejecutivo con un tope de 1300 caracteres
    await sec.locator('select[data-path="response.style"]').selectOption('executive');
    await sec.locator('input[data-path="response.max_chars"]').fill('1300');
    await sec.getByRole('button', { name: /Revisar/ }).click();
    await sec.getByText(/Revisado/).waitFor({ timeout: 20000 });
    await page.waitForTimeout(300);
    await sec.scrollIntoViewIfNeeded();
  },
  async proponer(page) {
    await PASOS.revisar(page);
    const sec = page.locator('#seccion-respuesta');
    await sec.getByRole('button', { name: /Proponer/ }).click();
    const confirmar = sec.getByRole('button', { name: /Confirmar y proponer/ });
    await confirmar.waitFor({ timeout: 20000 });
    // el botón queda abajo de las dos columnas: la captura lo muestra entero
    await page.evaluate(() => { const b = [...document.querySelectorAll('#seccion-respuesta button')].find((x) => /Confirmar y proponer/.test(x.textContent)); if (b) b.scrollIntoView({ block: 'end' }); });
    await page.waitForTimeout(300);
  },
  async confirmar(page) {
    await PASOS.proponer(page);
    const sec = page.locator('#seccion-respuesta');
    await sec.getByRole('button', { name: /Confirmar y proponer/ }).click();
    await sec.getByText(/Pedido abierto/).waitFor({ timeout: 30000 });
    // la sección se vuelve a dibujar con el enlace: se busca de nuevo por su id
    await page.evaluate(() => { const s = document.getElementById('seccion-respuesta'); if (s) s.scrollIntoView({ block: 'start' }); });
    await page.waitForTimeout(300);
  },
  async abrirCorrida(page) {
    await page.waitForSelector('tr[data-i]', { timeout: 30000 });
    await page.locator('tr[data-i]').first().click();
    await page.waitForSelector('.fila-det', { timeout: 15000 });
    await quieta(page);
  },
  async leyenda(page) {
    await page.waitForSelector('tr[data-i]', { timeout: 30000 });
    // la leyenda de los pasos, arriba de «Corrida por corrida»: sin ella la captura no sirve
    await page.locator('.leyenda').first().scrollIntoViewIfNeeded({ timeout: 15000 });
    await page.waitForTimeout(300);
  },
};

async function sacar(nav, lab, c, out) {
  const ctx = await nav.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, locale: 'es-AR', colorScheme: 'light' });
  try {
    const sesion = await lab.entrar(c.quien);
    const [nombre, valor] = sesion.split('=');
    const u = new URL(lab.base);
    await ctx.addCookies([{ name: nombre, value: valor, domain: u.hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    const page = await ctx.newPage();
    await page.goto(new URL(c.ruta, lab.base).toString(), { waitUntil: 'domcontentloaded' });
    await quieta(page);
    if (c.pasos) await PASOS[c.pasos](page);
    // a la vista: el mismo texto puede estar en una sub-pestaña oculta de Configuración
    await page.getByText(c.espera).filter({ visible: true }).first().waitFor({ timeout: 30000 });
    // `barras`: la columna de tiempo por paso se ve con sus colores (una hoja que la pisa la deja en una raya)
    if (c.barras) {
      const altas = await page.evaluate(() => [...document.querySelectorAll('td.barra .bar i')].filter((i) => i.getBoundingClientRect().height >= 8).length);
      if (!altas) throw new Error('las barras de tiempo por paso no se ven (alto menor a 8 px)');
    }
    // sin los estilos (son del arnés, no de la organización, y pesan) ni el token de la sesión de laboratorio
    const html = (await page.content()).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<meta name="site-token"[^>]*>/g, '');
    // la imagen y su HTML se arman aparte y recién al final se ponen en su lugar: una captura que falla al sacarse no deja
    // un HTML nuevo al lado de una imagen vieja (sólo quedaría así si falla el segundo de los dos renombres)
    const tmpHtml = path.join(out, `.${c.nombre}.html.nuevo`);
    const tmpPng = path.join(out, `.${c.nombre}.png.nuevo`);
    try {
      fs.writeFileSync(tmpHtml, html);
      await page.screenshot({ path: tmpPng, type: 'png' });
      fs.renameSync(tmpHtml, path.join(out, `${c.nombre}.html`));
      fs.renameSync(tmpPng, path.join(out, `${c.nombre}.png`));
    } finally { for (const f of [tmpHtml, tmpPng]) fs.rmSync(f, { force: true }); }
  } finally { await ctx.close(); }
}

function args(argv) {
  const a = { out: null, only: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--only') {
      a.only = [...new Set(String(argv[++i] || '').split(',').map((x) => x.trim()).filter(Boolean))];
      if (!a.only.length) a.error = '--only necesita al menos un nombre (los nombres: --list)';
    }
    else if (argv[i] === '--list') a.list = true;
    else if (argv[i] === '--help' || argv[i] === '-h') a.help = true;
    else { a.error = `no conozco ${argv[i]}`; }
  }
  return a;
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.help) { const t = fs.readFileSync(__filename, 'utf8'); process.stdout.write(t.slice(t.indexOf('/*') + 2, t.indexOf('*/')).replace(/^ \* ?/gm, '').trim() + '\n'); return 0; }
  if (a.error) { process.stderr.write(`${a.error}\n`); return 2; }
  if (a.list) { for (const c of CAPTURAS) process.stdout.write(`${c.nombre}\n`); return 0; }
  if (!a.out) { process.stderr.write('falta --out <carpeta>\n'); return 2; }
  const elegidas = a.only ? CAPTURAS.filter((c) => a.only.includes(c.nombre)) : CAPTURAS;
  if (a.only && elegidas.length !== a.only.length) { process.stderr.write(`no conozco: ${a.only.filter((n) => !CAPTURAS.some((c) => c.nombre === n)).join(', ')}\n`); return 2; }
  const { hayHttpBackend } = req('scripts/tests/lib/git-http-repo.js');
  if (!hayHttpBackend()) { process.stderr.write('falta `git http-backend` en esta máquina: los repos de laboratorio se sirven con él\n'); return 2; }
  const pw = playwright();
  if (!pw) { process.stderr.write('no pude instalar playwright-core\n'); return 2; }
  const nav = await abrirNavegador(pw);
  if (!nav) { process.stderr.write('no pude bajar el Chromium de playwright\n'); return 2; }
  const out = path.resolve(a.out);
  fs.mkdirSync(out, { recursive: true });
  // todo lo temporal del laboratorio —sus repos, sus datos y las carpetas que el sitio arma en el directorio temporal
  // (los clones, los textos de las corridas)— queda en una sola carpeta, que se borra al salir aunque algo falle
  const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'guia-sitio-'));
  process.env.TMPDIR = temporal;
  process.on('exit', () => { try { fs.rmSync(temporal, { recursive: true, force: true }); } catch { /* al salir no hay a quién avisar */ } });
  // cortado con Ctrl+C o por quien lo lanzó: sale por el mismo camino, así la carpeta también se borra
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));
  const fallas = [];
  const fallo = (nombre, e) => { fallas.push(nombre); process.stderr.write(`✗ ${nombre}: ${(e && e.message || String(e)).split('\n')[0]}\n`); };
  try {
    // el laboratorio «cargando» deja su buzón demorado: va último, y no se cierra (el proceso sale sin esperarlo)
    const orden = ['normal', 'sinPolitica', 'falla', 'frenado', 'cargando'];
    for (const variante of orden.filter((v) => elegidas.some((c) => c.sitio === v))) {
      const deEsta = elegidas.filter((x) => x.sitio === variante);
      let lab;
      try { lab = await laboratorio(variante); } catch (e) { for (const c of deEsta) fallo(c.nombre, e); continue; }
      try {
        for (const c of deEsta) {
          try { await sacar(nav, lab, c, out); process.stdout.write(`✓ ${c.nombre}\n`); } catch (e) { fallo(c.nombre, e); }
        }
      } finally {
        if (variante !== 'cargando') await lab.cerrar().catch((e) => process.stderr.write(`el laboratorio «${variante}» no cerró limpio: ${(e && e.message || String(e)).split('\n')[0]}\n`));
      }
    }
  } finally { await nav.close(); }
  if (fallas.length) { process.stderr.write(`no salieron ${fallas.length} de ${elegidas.length}: ${fallas.join(', ')}\n`); return 1; }
  process.stdout.write(`${elegidas.length} capturas en ${out}\n`);
  return 0;
}

module.exports = { CAPTURAS, laboratorio, args };

if (require.main === module) main().then((c) => process.exit(c), (e) => { process.stderr.write(`${e && e.stack || e}\n`); process.exit(1); });
