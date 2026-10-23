'use strict';
/*
 * demo/data.js —LOS DATOS DE EJEMPLO DE «ACME».
 *
 * Una organización inventada (`acme`) con sus personas, máquinas, productos, proyectos, ejecuciones, configuración y
 * perfil. Es el único juego de datos de ejemplo del arnés: lo lee el sitio demo (demo.js), lo muestran las capturas de la
 * guía del sitio (scripts/tools/site-guide-captures.js) y lo usan las pruebas del sitio (scripts/tests/lib/site-harness.js).
 * Viaja en la imagen del sitio, con scripts/site/.
 *
 * Los datos son de HOY: cada función recibe la hora (`ahora`, ms) y arma las fechas desde ella. Una foto más vieja que su
 * plazo saldría «no medido», y una demo que lleva días encendida tiene que seguir mostrando datos al día.
 * Ningún nombre, correo ni dirección de una organización real: sólo `acme` y `*.example`.
 */
// el piso de versión que la capa del equipo de estos datos declara: el más alto de los que exigen sus claves (la respuesta,
// el `stack` de team-repos.json y las aprobaciones del perfil). Con uno más bajo, el portón del perfil traba «Proponer»
const RESPONSE_SINCE = () => {
  const o = require('../../lib/org-config.js');
  return [o.RESPONSE_SINCE, o.STACK_SINCE, o.APPROVALS_SINCE].reduce((a, v) => (o.versionAtLeast(a, v) ? a : v));
};
// lo que la nube da a estos datos (la organización de los productos, el proveedor del buzón): el núcleo no la nombra
const PLATAFORMA = require('./platform-answers.js').plataformaDeEjemplo();

const LEAD = 'lead@acme.example';
const ANA = 'ana@acme.example';
const BRUNO = 'bruno@acme.example';
// una persona invitada desde el sitio (sólo el sitio demo la muestra)
const INVITADA = 'nuevo@acme.example';

const DIA_MS = 864e5;
/** El día de `ahora` y el anterior, como «AAAA-MM-DD» en UTC. */
const diasDe = (ahora) => ({ hoy: new Date(ahora).toISOString().slice(0, 10), ayer: new Date(ahora - DIA_MS).toISOString().slice(0, 10) });

// ── las ejecuciones ─────────────────────────────────────────────────────────────────────────────────────────────────
const iso = (t0, min) => new Date(Date.parse(t0) + min * 60000).toISOString();
/** Un volcado de ejecución con lo mínimo: su sesión e inicio (lo que usan las pruebas del sitio). */
const volcadoMinimo = (sid, inicio, extra = {}) => JSON.stringify({ archivedAt: inicio, marker: { sessionId: sid, startedAt: inicio, lastTouch: inicio, stepsCompleted: [], ...extra } });

/** Una ejecución del pipeline como la sube upload-runs.js: su marcador, sus controles, su costo y su consumo. */
function volcadoDeEjecucion(sid, inicio, { story, repo, pasos = [0, 1, 2, 3, 4, 5, 6, 7, 8], rojo = false } = {}) {
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

/** El buzón: tres máquinas (la de ana, confirmada; la de bruno, sin confirmar; la de quien mantiene), con sus ejecuciones. */
function blobsDelBuzon(ahora = Date.now()) {
  const { hoy } = diasDe(ahora);
  // el comienzo de una ejecución de hace `n` horas, en hora redonda
  const haceHoras = (n) => new Date(Math.floor((ahora - n * 36e5) / 36e5) * 36e5).toISOString();
  const lugar = (correo) => JSON.stringify({ day: hoy, owner: { email: correo }, folder: null });
  const b = {};
  const sid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const corridas = [
    ['mac-ana', '1.4', 'Producto-X/FrontEnd', haceHoras(50), {}],
    ['mac-ana', '1.5', 'Producto-X/FrontEnd', haceHoras(28), { rojo: true }],
    ['mac-ana', '2.1', 'Producto-Y/Backend', haceHoras(6), { pasos: [0, 1, 2, 3, 4] }],
    ['mac-bruno', '2.2', 'Producto-Y/Backend', haceHoras(8), {}],
    ['mac-lead', '3.1', 'Producto-X/Backend', haceHoras(75), {}],
  ];
  corridas.forEach(([maq, story, repo, inicio, extra], i) => { b[`${maq}/${sid(i + 1)}.json`] = volcadoDeEjecucion(sid(i + 1), inicio, { story, repo, ...extra }); });
  b['mac-ana/registros/place.json'] = lugar(ANA);
  b['mac-bruno/registros/place.json'] = lugar(BRUNO);
  b['mac-lead/registros/place.json'] = lugar(LEAD);
  return b;
}

// ── el repo de operaciones ──────────────────────────────────────────────────────────────────────────────────────────
/** Los archivos de un repo de operaciones con todas las fuentes del día `hoy` (nombres inventados). */
function archivosDeOperaciones({ hoy = '2026-10-15', ayer = '2026-10-14', config, extra = {} } = {}) {
  return {
    'operations.json': config || { version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'] } },
    'scripts/nightly/dependencies/repos.json': { [PLATAFORMA.claveDeOrganizacion]: { org: 'https://dev.example/acme' }, repos: [{ producto: 'Producto X', ruta: 'X/repo', ado: 'Proyecto X/Repo X', tipo: 'npm', activo: true }] },
    'scripts/nightly/dashboard/sources.json': { sources: [
      { id: 'dependencias', pattern: 'dependencias-*.json', dir: 'dependencias', max_age_days: 2 },
      { id: 'vigilante', pattern: 'vigilante-*.json', dir: 'vigilante', max_age_days: 2 },
      { id: 'banco', pattern: 'banco-*.json', dir: 'controls-bench', max_age_days: 2 },
      { id: 'suites', pattern: 'suites-*.json', dir: 'controls-bench', max_age_days: 2 },
    ], thresholds: {} },
    'scripts/nightly/dashboard/declared.json': { declared: [{ id: 'dato-uno', review_before: '2026-10-20' }] },
    [`.dashboard/dependencias/dependencias-${hoy}.json`]: { fecha: hoy, resumen: { rubros: {
      nuevos: { valor: [{ id: 'f1', paquete: 'pkg-uno', proyectos: ['Proyecto X'] }], motivo: null },
      aceptadas_sin_resolver: { valor: [], motivo: null }, rechazadas_sin_deuda: { valor: [], motivo: null },
      vivas_por_proyecto: { valor: [{ proyecto: 'Proyecto X', ids: ['f1', 'f2'] }], motivo: null },
      pedidos_cerrados_con_vivas: { valor: [], motivo: null } } } },
    [`.dashboard/vigilante/vigilante-${hoy}.json`]: { fecha: hoy, productos: { 'producto-x': { ok: true } }, resumen: { rubros: { pendientes: { valor: [], motivo: null }, aceptadas_sin_story: { valor: [], motivo: null } } } },
    [`.dashboard/controls-bench/banco-${hoy}.json`]: { ts: `${hoy}T05:00:00Z`, ran: 10, failed: 0, estado: 'completo', results: {} },
    [`.dashboard/controls-bench/suites-${hoy}.json`]: { ts: `${hoy}T05:00:00Z`, corridas: 10, failures: [], unmeasured: [], complete: true },
    [`.dashboard/controls-bench/suites-${ayer}.json`]: { ts: `${ayer}T05:00:00Z`, corridas: 10, failures: [], unmeasured: [], complete: true },
    '.dashboard/proyectos/Proyecto X__Repo X.json': { v: 1, generated_at: `${hoy}T06:00:00Z`, proyecto: 'Proyecto X', repo: 'Repo X', stories: [{ id: '1.1', titulo: 'un título', grupo: 'en_curso', canonico: 'in-progress', dias_en_estado: 3 }] },
    'artifacts/tablero-del-arnes.html': '<!doctype html><html><head><style>b{color:red}</style></head><body><h1>Seis preguntas</h1></body></html>',
    ...extra,
  };
}

/**
 * Los archivos del repo de operaciones de «acme». `access`: la lista de quién entra en lugar de la de antes
 * (site.maintainers). `invitaciones`: las invitaciones que quien mantiene hizo desde el sitio (`site.invitations`).
 */
function operaciones({ access, invitaciones, ahora = Date.now() } = {}) {
  const { hoy, ayer } = diasDe(ahora);
  const ops = {
    version: 1,
    owners: { default: LEAD },
    site: { maintainers: [LEAD], url: 'https://sitio.acme.example', refresh_minutes: 15, brand: { name: 'Acme' },
      mailbox: { provider: PLATAFORMA.proveedorDeBuzon, account: 'acmecorridas', container: 'corridas', threads: false } },
    people: { machines: {
      'mac-ana': { person: ANA, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' },
      'mac-lead': { person: LEAD, reported_sha256: null, confirmed_by: LEAD, confirmed_on: '2026-10-01' },
    } },
    // los pedidos de vulnerabilidades, con el tipo y los campos que devuelve la plataforma de mentira (respuestas.js)
    work_items: { type: 'Riesgo', fixed_fields: { 'Custom.Categoria': 'Seguridad', 'Custom.Probabilidad': 3 }, by_severity: {
      critical: { 'Custom.Impacto': 5, 'Custom.Prioridad': '🔴 Crítico (21-25)' }, high: { 'Custom.Impacto': 4, 'Custom.Prioridad': '🟠 Alto (15-20)' },
      moderate: { 'Custom.Impacto': 3, 'Custom.Prioridad': '🟡 Medio (8-14)' }, low: { 'Custom.Impacto': 2, 'Custom.Prioridad': '🟢 Bajo (1-7)' } } },
  };
  if (access) { delete ops.site.maintainers; ops.site.access = access; }
  if (invitaciones) ops.site.invitations = invitaciones;
  const archivos = archivosDeOperaciones({ hoy, ayer, config: ops });
  // los proyectos del día: dos productos con sus stories (sólo número, estado y días en el estado)
  delete archivos['.dashboard/proyectos/Proyecto X__Repo X.json'];
  // la organización con la forma del archivo real; los pedidos se leen de la plataforma de ejemplo, nunca de la red
  archivos['scripts/nightly/dependencies/repos.json'] = { [PLATAFORMA.claveDeOrganizacion]: { org: PLATAFORMA.urlOrganizacion }, repos: [
    { producto: 'Producto X', ruta: 'Producto-X/FrontEnd', ado: 'Producto X/FrontEnd', tipo: 'npm', activo: true },
    { producto: 'Producto Y', ruta: 'Producto-Y/Backend', ado: 'Producto Y/Backend', tipo: 'nuget', activo: true },
  ] };
  archivos['.dashboard/proyectos/Producto X__FrontEnd.json'] = { v: 1, generated_at: `${hoy}T06:00:00Z`, proyecto: 'Producto X', repo: 'FrontEnd', stories: [
    { id: '1.4', titulo: 'una mejora', grupo: 'en_curso', canonico: 'in-progress', dias_en_estado: 2 },
    { id: '1.5', titulo: 'otra mejora', grupo: 'en_revision', canonico: 'review', dias_en_estado: 1 },
    { id: '1.2', titulo: 'una vieja', grupo: 'parado', canonico: 'in-progress', dias_en_estado: 12 },
  ] };
  archivos['.dashboard/proyectos/Producto Y__Backend.json'] = { v: 1, generated_at: `${hoy}T06:00:00Z`, proyecto: 'Producto Y', repo: 'Backend', stories: [
    { id: '2.1', titulo: 'una mejora', grupo: 'en_curso', canonico: 'in-progress', dias_en_estado: 1 },
    { id: '2.2', titulo: 'otra', grupo: 'bloqueado', canonico: 'blocked', dias_en_estado: 4 },
  ] };
  return archivos;
}

// ── lo que contesta la plataforma de pedidos de trabajo ─────────────────────────────────────────────────────────────────
/** Los campos del tipo «Riesgo» y sus valores permitidos (la API de pedidos de trabajo de ejemplo: la trae la nube). */
const CAMPOS_DE_RIESGO = PLATAFORMA.camposDeRiesgo;

// ── el perfil del equipo ────────────────────────────────────────────────────────────────────────────────────────────
const PERFIL = {
  ado: { org: PLATAFORMA.urlOrganizacion },
  integrations: { timeTracking: 'none', engram: true, mailbox: true, codex: 'detect', nightly: true },
  update: { channel: 'latest', apply: 'auto' }, packs: { default: 'all' }, install: { profile: 'full' },
};
// una herramienta de prueba agregada por la organización: la tabla de «Cómo se corren las pruebas» la muestra junto a
// las internas y las recetas de fábrica
const RECETA_NETFX = {
  name: 'netfx-vstest', label: '.NET Framework (vstest)', detect: 'packages.config', detect_depth: 1,
  command: 'bash -c \'vstest.console.exe $(find . -path "*/bin/Debug/*Tests.dll") --logger:trx "--ResultsDirectory:{results}"\'',
  results: { format: 'trx', path: '{results}/**/*.trx' },
};
const GH = (repo) => ({ platform: 'github', org: 'acme', repo });
const REPOS = { version: 1, public: GH('arnes'), profile: GH('perfil'), operations: GH('operaciones'), stack: { test_runners: [RECETA_NETFX] } };

/**
 * Los archivos del repo del perfil de «acme» (`ruta → objeto o texto`). `repos`: claves que se suman a `team-repos.json`;
 * `extra`: archivos de más (por ejemplo un paquete de revisores de la organización).
 */
function archivosDelPerfil({ repos = {}, extra = {} } = {}) {
  return {
    'team-profile.json': PERFIL, 'team-repos.json': { ...REPOS, ...repos }, 'team-layer.json': { requires: { harness: `>= ${RESPONSE_SINCE()}` } },
    'skills/acme-guia/SKILL.md': '# una skill de la organización\n', 'agents/acme-revisor.md': '# un revisor de la organización\n', 'onboarding/step-0-mac.md': '# el alta\n',
    ...extra,
  };
}

/**
 * Un paquete de revisores propio de «acme» (como el que una organización arma para su stack): la pestaña «Cómo trabaja» lo
 * lista y deja editar su revisor. Sólo lo trae el perfil del sitio demo (no es parte de las capturas de la guía).
 */
const PAQUETE_DE_REVISORES = Object.freeze({
  'packs/acme-api/pack.json': {
    name: 'acme-api',
    description: 'Paquete de revisores de «acme» para sus APIs: un revisor chico que mira los endpoints nuevos.',
    agents: 'agents',
    guides: [],
    reviewers: [{
      agent: 'acme-api-reviewer', group: 'condicional', when: { detection: 'codeModified' },
      surface: { paths: ['**/api/**/*.js'] }, depth: 'lean', prefixes: ['ACMEAPI'],
    }],
  },
  'packs/acme-api/agents/acme-api-reviewer.md': `---
name: acme-api-reviewer
tools: Read, Grep, Glob
model: sonnet
description: Revisor de ejemplo de «acme». Audita los endpoints del diff: entradas que llegan sin validar y respuestas que devuelven más de lo que deben. Reglas ACMEAPI-C1 y ACMEAPI-W1. Sólo invocar si el diff toca archivos de api/.
omitClaudeMd: true
---

# acme-api-reviewer

**Fase**: durante y después de implementar.
**Severidad**: CRITICAL para la entrada que llega sin validar; WARNING para una respuesta que devuelve de más.

## Cuándo se invoca

Lo suma el pipeline cuando el diff toca un archivo de \`api/\` (bandera \`codeModified\` del \`pack.json\`).

## Cómo revisar

1. Leé cada endpoint del diff entero: el tipo de lo que recibe puede estar definido en otro lado del archivo.
2. Aplicá sólo las reglas de este catálogo. Si no estás seguro, no marques la regla y decilo en el resumen.

## Catálogo de reglas

| Regla | Severidad | Qué marca |
|---|---|---|
| ACMEAPI-C1 | CRITICAL | Un endpoint que usa el cuerpo del pedido sin validarlo. |
| ACMEAPI-W1 | WARNING | Una respuesta que devuelve campos internos de la base. |

## Formato del reporte

Un renglón por hallazgo: regla, archivo y línea, y qué cambiar. Sin hallazgos: \`✅ OK\`.
`,
});

module.exports = { PAQUETE_DE_REVISORES, CAMPOS_DE_RIESGO, LEAD, ANA, BRUNO, INVITADA, PERFIL, RECETA_NETFX, REPOS, diasDe, volcadoMinimo, volcadoDeEjecucion, blobsDelBuzon, archivosDeOperaciones, operaciones, archivosDelPerfil };
