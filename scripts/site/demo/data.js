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

/**
 * Una ejecución del pipeline como la sube upload-runs.js: su marcador, sus controles, su costo y su consumo. `completo`
 * (sólo el sitio demo): además el arranque de cada paso, sus vueltas, los revisores medidos con el validador por fase,
 * el desglose por tipo y el consumo de cada paso; `esquema: 2`, los pasos por nombre (el marcador de hoy).
 */
function volcadoDeEjecucion(sid, inicio, { story, repo, pasos = [0, 1, 2, 3, 4, 5, 6, 7, 8], rojo = false, completo = false, esquema = 1 } = {}) {
  if (completo) return volcadoCompleto(sid, inicio, { story, repo, pasos, rojo, esquema });
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

/**
 * El buzón: tres máquinas (la de ana, confirmada; la de bruno, sin confirmar; la de quien mantiene), con sus ejecuciones.
 * `completo` (sólo el sitio demo): las ejecuciones completas, dos de ellas con los pasos por nombre, la versión del
 * arnés en cada `place.json` (`version` en dos, una más vieja en la de bruno) y los registros que sube cada máquina.
 */
function blobsDelBuzon(ahora = Date.now(), { completo = false, version = VERSION_DE_EJEMPLO } = {}) {
  const { hoy } = diasDe(ahora);
  // el comienzo de una ejecución de hace `n` horas, en hora redonda
  const haceHoras = (n) => new Date(Math.floor((ahora - n * 36e5) / 36e5) * 36e5).toISOString();
  const lugar = (correo, v) => JSON.stringify({ day: hoy, owner: { email: correo }, folder: null, ...(completo ? { install: { mode: 'managed', version: v } } : {}) });
  const b = {};
  const sid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const dos = completo ? { esquema: 2 } : {};
  const corridas = [
    ['mac-ana', '1.4', 'Producto-X/FrontEnd', haceHoras(50), { ...dos }],
    ['mac-ana', '1.5', 'Producto-X/FrontEnd', haceHoras(28), { rojo: true, ...dos }],
    ['mac-ana', '2.1', 'Producto-Y/Backend', haceHoras(6), { pasos: [0, 1, 2, 3, 4] }],
    ['mac-bruno', '2.2', 'Producto-Y/Backend', haceHoras(8), { ...dos }],
    ['mac-lead', '3.1', 'Producto-X/Backend', haceHoras(75), {}],
  ];
  corridas.forEach(([maq, story, repo, inicio, extra], i) => { b[`${maq}/${sid(i + 1)}.json`] = volcadoDeEjecucion(sid(i + 1), inicio, { story, repo, completo, ...extra }); });
  b['mac-ana/registros/place.json'] = lugar(ANA, version);
  b['mac-bruno/registros/place.json'] = lugar(BRUNO, VERSION_VIEJA);
  b['mac-lead/registros/place.json'] = lugar(LEAD, version);
  if (completo) {
    const deMaquina = (maq) => corridas.map((c, i) => [c, sid(i + 1)]).filter(([c]) => c[0] === maq).map(([c, s]) => ({ volcado: `${s}.json`, inicio: c[3] }));
    for (const maq of ['mac-ana', 'mac-bruno', 'mac-lead']) Object.assign(b, registrosDeMaquina(maq, ahora, deMaquina(maq)));
  }
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
 * `completo` (sólo el sitio demo): además todo lo que deja la noche y lo que el repo declara, para que cada pestaña tenga
 * un dato (fotosCompletas).
 */
function operaciones({ access, invitaciones, ahora = Date.now(), completo = false } = {}) {
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
  if (completo) {
    // en qué productos trabaja cada persona, de dónde se leen los despliegues y por dónde sale el aviso
    ops.people.projects = { [ANA]: { add: ['Producto X', 'Producto Y'] }, [INVITADA]: { add: ['Producto X'] } };
    const pipeline = (p, nombre, stage) => [{ pipeline: `${p}/${nombre}`, stages: [stage] }];
    // el proveedor es el de la plataforma de ejemplo (la trae la nube: el núcleo no nombra ninguna)
    ops.deployments = { provider: PLATAFORMA.remotos.operaciones.platform, products: {
      'Producto X': { staging: pipeline('Producto X', 'Producto X FrontEnd', 'Staging'), production: pipeline('Producto X', 'Producto X FrontEnd', 'Production') },
      'Producto Y': { staging: pipeline('Producto Y', 'Producto Y Backend', 'Staging'), production: pipeline('Producto Y', 'Producto Y Backend', 'Production') },
    } };
    ops.notify = { channel: 'teams' };
  }
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
  if (completo) Object.assign(archivos, fotosCompletas({ ahora, hoy, ayer, archivos }));
  return archivos;
}

// ── lo que agrega el sitio demo (`completo`) ─────────────────────────────────────────────────────────────────────────
// Con estos datos cada pestaña tiene algo que mostrar, en cada vista. Las capturas de la guía y las pruebas del sitio no
// los piden: siguen con los de siempre.

/** La versión con que corre el demo si la imagen no trae la suya, y la de una máquina que quedó atrás. */
const VERSION_DE_EJEMPLO = '2026.10.23.10';
const VERSION_VIEJA = '2026.09.30.5';
const diaDesde = (ahora, n) => new Date(ahora + n * DIA_MS).toISOString().slice(0, 10);
/** Líneas JSON comprimidas, como sube cada registro una máquina. */
const comprimido = (lineas) => require('zlib').gzipSync(`${lineas.map((x) => JSON.stringify(x)).join('\n')}\n`);

// los pasos del marcador de hoy, por nombre (la tabla de skills/tycon-pipeline/scripts/lib/steps.js)
const PASOS_POR_NOMBRE = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'prepare-commit'];
// los revisores de una ejecución (suman los agentes) y las vueltas en que corrieron
const REVISORES_POR_TIPO = Object.freeze({ 'tycon-story-validator': 2, 'tycon-plugin-security-basics': 2, 'tycon-plugin-tests-coverage': 2, 'acme-api-reviewer': 2 });
const FASES_DEL_VALIDADOR = ['antes-de-implementar', 'vuelta-1', 're-loop', 'sin-vuelta', 'otra-story'];

/** Una ejecución con todo lo que el sitio sabe mostrar (volcadoDeEjecucion con `completo`). */
function volcadoCompleto(sid, inicio, { story, repo, pasos, rojo, esquema }) {
  const m = (x) => iso(inicio, x);
  const ids = esquema === 2 ? PASOS_POR_NOMBRE.slice(0, pasos.length) : pasos;
  // cada paso arranca 2 minutos después de su lugar y dura 8: ninguno pisa al anterior; Hallazgos espera desde el 5
  const tiempos = {};
  ids.forEach((p, i) => { tiempos[p] = { startedAt: m(2 + i * 12), completedAt: m(10 + i * 12), ...(p === 'findings' ? { waitStartedAt: m(5 + i * 12) } : {}) }; });
  const fase = (limpio, hallazgos) => ({ lanzamientos: limpio + hallazgos, limpio, hallazgos, inconsistente: 0, sin_veredicto: 0, no_medido: 0 });
  const porFase = Object.fromEntries(FASES_DEL_VALIDADOR.map((f) => [f, f === 'antes-de-implementar' ? fase(1, 0) : f === 'vuelta-1' ? fase(0, 1) : fase(0, 0)]));
  const spawns = Object.values(REVISORES_POR_TIPO).reduce((a, b) => a + b, 0);
  return JSON.stringify({
    archivedAt: m(130),
    marker: { storyId: story, storyPath: `/home/dev/acme/specs/story-${story}-una-mejora.md`, repoPath: `/home/dev/acme/${repo}`, sessionId: sid, startedAt: m(0), lastTouch: m(120),
      ...(esquema === 2 ? { stepScheme: 2 } : {}), stepsCompleted: ids, stepsPending: [], stepTimings: tiempos,
      iterations: { 1: { ts: m(60) }, 2: { ts: m(85) } } },
    gates: [
      { ts: m(20), sessionId: sid, check: 'build', status: 'green', exit: 0, durationMs: 11000 },
      { ts: m(40), sessionId: sid, check: 'tests', status: rojo ? 'red:exit=1' : 'green', exit: rojo ? 1 : 0, durationMs: 61000 },
    ],
    costo: { spawns, adhoc: 0, iteraciones: 2, por_tipo: { ...REVISORES_POR_TIPO } },
    revisores: { estado: 'medido', fuente: 'hilo_guardado', lanzamientos: spawns, con_resultado: spawns, sin_resultado: 0, no_ubicados: 0, fuera_del_registro: 0, con_tokens: spawns,
      por_vuelta: { 1: spawns - 2, 2: 2 }, por_tipo: { ...REVISORES_POR_TIPO },
      duracion_ms: { mediana: 95000, total: 95000 * spawns, n: spawns }, devuelto_bytes: { mediana: 2400, total: 2400 * spawns, n: spawns },
      tokens_medidos: { total: 40000 * spawns, n: spawns },
      estimado: { estado: 'vacio', motivo: 'todos los lanzamientos tienen tokens medidos', lanzamientos_cubiertos: 0 },
      validador: { estado: 'medido', lanzamientos: 2, por_fase: porFase } },
    consumo: { estado: 'medido', respuestas: 40, sinteticos: 0, lineas_ilegibles: 0, tokens: { in: 900, out: 30000, cache_new: 100000, cache_read: 1800000 },
      por_modelo: {}, por_paso: Object.fromEntries(ids.map((p, i) => [p, 20000 + i * 5000])), fuera_de_ventana: 0, hilo_hasta: m(126), medido_en: m(300) },
  });
}

/**
 * Los registros que sube una máquina (`<máquina>/registros/…`): los controles, los escapes, los frenos, los carriles y los
 * hallazgos de sus revisores, de los últimos días (nunca de hoy: la ventana de la noche termina ayer), y su cobertura.
 * `volcados`: sus ejecuciones, `{ volcado, inicio }`.
 */
function registrosDeMaquina(maq, ahora, volcados) {
  const { hoy, ayer } = diasDe(ahora);
  const ts = (n, h = 10) => `${diaDesde(ahora, -n)}T${String(h).padStart(2, '0')}:00:00Z`;
  // una letra hexadecimal por máquina: las corridas y las claves de la guía de QA tienen forma hexadecimal
  const letra = { 'mac-ana': 'a', 'mac-bruno': 'b', 'mac-lead': 'c' }[maq] || 'd';
  const gates = [];
  for (let i = 1; i <= 4; i += 1) gates.push({ ts: ts(i), name: 'tests', status: 'green', durationMs: 60000 + i * 5000 });
  gates.push({ ts: ts(2, 11), name: 'build', status: 'red:exit=1' });
  for (let i = 1; i <= 3; i += 1) gates.push({ ts: ts(i, 12), name: 'cobertura-tocada', status: 'cumple' });
  gates.push({ ts: ts(4, 12), name: 'cobertura-tocada', status: 'habria-frenado' });
  for (let i = 1; i <= 3; i += 1) gates.push({ ts: ts(i, 13), name: 'mutation', status: 'pass', killed: 7 + i, total: 10 });
  for (let i = 1; i <= 3; i += 1) gates.push({ ts: ts(i, 14), name: 'qa-guide', status: 'presente', esquema: 2, clave: `${letra}${String(i).repeat(15)}` });
  gates.push({ ts: ts(5, 14), name: 'qa-guide', status: 'missing', esquema: 2, clave: `${letra}${'9'.repeat(15)}` });
  const frenos = [
    ...[1, 2, 3].map((i) => ({ ts: ts(i, 16), freno: 'safety-guard', regla: 'rm-rf', veredicto: 'bloqueo' })), { ts: ts(4, 16), freno: 'safety-guard', regla: 'rm-rf', veredicto: 'escape' },
    ...[1, 2, 3].map((i) => ({ ts: ts(i, 17), freno: 'on-pre-commit', regla: 'evidencia', veredicto: 'paso' })), { ts: ts(4, 17), freno: 'on-pre-commit', regla: 'evidencia', veredicto: 'bloqueo' },
  ];
  // los hallazgos de las ejecuciones de antes de hoy: una con un hallazgo de cada revisor de seguridad, el resto limpias
  const previas = volcados.filter((v) => v.inicio.slice(0, 10) <= ayer);
  const hallazgos = previas.slice(0, 1).flatMap((v, i) => [
    { ts: v.inicio, corrida: `c-${letra.repeat(4)}${String(i).padStart(8, '0')}`, regla: 'SEC-C2', dueno: 'tycon-plugin-security-basics', severidad: 'CRITICAL', disposicion: 'corregido' },
    { ts: v.inicio, corrida: `c-${letra.repeat(4)}${String(i).padStart(8, '0')}`, regla: 'TEST-W2', dueno: 'tycon-plugin-tests-coverage', severidad: 'WARNING', disposicion: 'corregido' },
  ]);
  const serie = [...hallazgos, ...previas.map((v, i) => ({ volcado: v.volcado, medida: i === 0 ? 'con_hallazgos' : 'revisado_sin_hallazgos' }))];
  const medido = { estado: 'medido' };
  return {
    [`${maq}/registros/gates.log.gz`]: comprimido(gates),
    [`${maq}/registros/bypass.log.gz`]: comprimido([1, 2, 3, 4].map((i) => ({ ts: ts(i, 15), type: 'FULL_SUITE_RUN' }))),
    [`${maq}/registros/frenos.jsonl.gz`]: comprimido(frenos),
    [`${maq}/registros/carriles.jsonl.gz`]: comprimido([...[1, 2, 3, 4].map((i) => ({ ts: ts(i, 18), carril: 'pipeline' })), { ts: ts(5, 18), carril: 'adhoc' }]),
    [`${maq}/registros/hallazgos.jsonl.gz`]: comprimido(serie),
    [`${maq}/registros/cobertura.json`]: JSON.stringify({ esquema: 1, fecha: hoy, fuentes: { gates: medido, bypass: medido, frenos: medido, carriles: medido,
      hallazgos: { estado: 'medido', fecha: hoy, resumen: { hallazgos: hallazgos.length, volcados: { medidos: previas.length } } } } }),
  };
}

// los pares revisor-regla del examen de ejemplo: casos que obligan a marcar, todos pasados
const CASOS_DEL_BANCO = Object.freeze([
  ['tycon-plugin-security-basics', 'sec-c2-secreto-hardcoded', 'SEC-C2'], ['tycon-plugin-security-basics', 'sec-c6-random-para-token', 'SEC-C6'],
  ['tycon-plugin-tests-coverage', 'test-c1-suite-roja-en-artifact', 'TEST-C1'], ['tycon-plugin-tests-coverage', 'test-w2-coverage-bajo-archivo-nuevo', 'TEST-W2'],
  ['tycon-silent-failure-hunter', 'silent-c1-catch-vacio-cs', 'SILENT-C1'],
]);

/** Las fotos de la noche y lo que el repo de operaciones declara, del día `hoy`: lo que `operaciones({ completo })` suma. */
function fotosCompletas({ ahora, hoy, ayer, archivos }) {
  const d = (n) => diaDesde(ahora, -n);
  const ts = `${hoy}T05:00:00Z`;
  // los enlaces de pedidos y PR, en la plataforma de ejemplo (la misma dirección que el repo de operaciones)
  const web = (proyecto, resto) => `${new URL(PLATAFORMA.remotos.operaciones.web).origin}/acme/${encodeURIComponent(proyecto)}/${resto}`;
  const f = {};
  // la configuración del tablero de verdad: todas las fuentes, el reductor, la poda y los umbrales
  f['scripts/nightly/dashboard/sources.json'] = require('../../nightly/dashboard/sources.json');
  f['scripts/nightly/dashboard/declared.json'] = { declared: [{ id: 'dato-uno', review_before: diaDesde(ahora, 5) }] };
  f['scripts/metrics/lane-hypothesis.json'] = { schema: 1, min_n_per_group: 5 };
  f['scripts/ci/pipeline-debt.json'] = { debt: [{ id: 'PROD-PIPELINE-producto-y-1', repo: 'Producto-Y/Backend', que: 'sin stage de producción', motivo: 'el cliente despliega a mano', fecha: d(10), revision: diaDesde(ahora, 30) }] };
  f['scripts/ci/product-parity.json'] = {
    grupos: { productos: { repos: [{ ruta: 'Producto-X/FrontEnd', producto: 'Producto X' }, { ruta: 'Producto-Y/Backend', producto: 'Producto Y' }] } },
    rasgos: [{ id: 'escaneo' }, { id: 'firma' }],
    diferencias_declaradas: [{ grupo: 'productos', rasgo: 'firma', motivo: 'Producto Y se publica sin firma hasta la migración', fecha: d(10), revision: diaDesde(ahora, 80) }],
  };
  // el examen del banco y sus casos (la poda de reglas los lee de acá)
  f['scripts/controls-bench/ultimo-examen.json'] = { ts: `${ayer}T03:00:00Z`, alcance: 'completo', only: [],
    results: Object.fromEntries(CASOS_DEL_BANCO.map(([rev, caso, regla]) => [`${rev}::${caso}`, { rule: regla, type: 'must-flag', tools: { claude: { pass: true } } }])) };
  for (const rev of [...new Set(CASOS_DEL_BANCO.map(([r]) => r))]) {
    f[`scripts/controls-bench/cases/advisors/${rev}.json`] = { cases: CASOS_DEL_BANCO.filter(([r]) => r === rev).map(([, id, rule]) => ({ id, rule, type: 'must-flag' })) };
  }
  // la página de las seis preguntas, con el sello de una noche completa
  f['artifacts/tablero-del-arnes.html'] = `<!doctype html><html><head><style>b{color:red}</style></head><body><h1>Seis preguntas</h1><script type="application/json" id="tablero-sello">${JSON.stringify({ esquema: 1, generado: `${hoy}T05:40:00Z`, snapshot: hoy, modo: 'nocturno', corrida: '9001', fuentes: { esperadas: 10, al_dia: 10 }, buzon: { estado: 'leido', maquinas: 3 } })}</script></body></html>`;
  // Proyectos: una story estancada (40 días en curso) y, en cada repo de historias, una épica estimada con su rango,
  // lo planeado, lo vigente y lo real de la épica abierta
  const estimaciones = { estado: 'medido', motivo: null, ilegibles: 0, unidad: 'hours' };
  const epica = (id, titulo, [min, max], plan, vigente, real) => ({ id, titulo, estimacion: {
    rango: { min, max, unidad: 'hours' }, unidad: 'hours', suma_plan: plan, suma_vigente: vigente, dentro: vigente >= min && vigente <= max,
    en_horas: { min, max, plan, vigente }, real: { cerrada: false, suma: real, faltan: 1 } } });
  const fx = archivos['.dashboard/proyectos/Producto X__FrontEnd.json'];
  f['.dashboard/proyectos/Producto X__FrontEnd.json'] = { ...fx, stories: fx.stories.map((s) => (s.id === '1.2' ? { ...s, grupo: 'en_curso', dias_en_estado: 40 } : s)),
    cobertura: { estimaciones }, epicas: [epica('1', 'La lista de clientes', [30, 45], 36, 40, 22)] };
  const fy = archivos['.dashboard/proyectos/Producto Y__Backend.json'];
  f['.dashboard/proyectos/Producto Y__Backend.json'] = { ...fy, cobertura: { estimaciones }, epicas: [epica('2', 'Los pagos en cuotas', [20, 30], 24, 28, 9)] };
  // las colas de la noche, con una ficha en cada rubro y su pedido
  f[`.dashboard/dependencias/dependencias-${hoy}.json`] = { fecha: hoy, corrida_completa: true, repos_activos: 2, no_medidos: [], hallazgos: [{ id: 'f1' }, { id: 'f2' }], resumen: { rubros: {
    nuevos: { valor: [{ id: 'f1', paquete: 'pkg-uno', proyectos: ['Producto X'] }], motivo: null },
    aceptadas_sin_resolver: { valor: [{ id: 'f2', paquete: 'pkg-dos' }], motivo: null },
    rechazadas_sin_deuda: { valor: [{ id: 'f3', paquete: 'pkg-tres' }], motivo: null },
    vivas_por_proyecto: { valor: [{ proyecto: 'Producto X', ids: ['f1', 'f2'] }], motivo: null },
    pedidos_cerrados_con_vivas: { valor: [{ id: 'f4', paquete: 'pkg-cuatro' }], motivo: null } } } };
  f[`.dashboard/vigilante/vigilante-${hoy}.json`] = { fecha: hoy, generado: `${hoy}T05:30:00Z`, productos: { 'producto-x': { ok: true }, 'producto-y': { ok: true } }, hallazgos: [{ id: 'v1' }], nuevos: 1, repetidos: 0, resumen: { rubros: {
    pendientes: { valor: [{ id: 'v1', producto: 'producto-x', regla: 'errores-500' }], motivo: null },
    aceptadas_sin_story: { valor: [{ id: 'v2', producto: 'producto-y', regla: 'lentitud' }], motivo: null } } } };
  // las fichas, en el formato de cada fuente: la pestaña Pendientes las muestra.
  // Las pendientes van sin `pr:`: con el pedido de la noche abierto se deciden ahí, no en el sitio
  const conPr = (pr) => (pr ? `pr: ${pr}\n` : '');
  const fichaDep = (id, pr, veredicto, paquete, severidad, noches, extra = '') => `id: ${id}\ndetectado: ${ayer}\nveredicto: ${veredicto}\npaquete: ${paquete}\nseveridad: ${severidad}\nnoches: ${noches}\n${conPr(pr)}${extra}`;
  const fichaVig = (id, pr, veredicto, regla, extra = '') => `id: ${id}\nfuente: vigilante\ncausa: producto-x:${regla}\nfecha: ${ayer}\nproducto: producto-x\nregla: ${regla}\nseveridad: alta\nveredicto: ${veredicto}\nvista_por_ultima_vez: ${hoy}\nnoches_seguidas: 2\n${conPr(pr)}${extra}`;
  Object.assign(f, {
    'inbox/dependencies/pending/f1.yaml': fichaDep('f1', null, 'pendiente', 'pkg-uno', 'high', 3, 'propuesta_accion: arreglar\npropuesta_razon: Hay una versión corregida del paquete\npedidos:\n  - Producto X: 5002\n'),
    'inbox/dependencies/promoted/f2.yaml': fichaDep('f2', 202, 'util', 'pkg-dos', 'moderate', 5),
    'inbox/dependencies/archived/f3.yaml': fichaDep('f3', 203, 'descartado', 'pkg-tres', 'low', 8),
    'inbox/dependencies/promoted/f4.yaml': fichaDep('f4', 204, 'util', 'pkg-cuatro', 'high', 6),
    'inbox/watcher/pending/v1.yaml': fichaVig('v1', null, 'pendiente', 'errores-500', 'propuesta_accion: arreglar\npropuesta_razon: Se repite en el mismo endpoint desde el último despliegue\n'),
    'inbox/watcher/promoted/v2.yaml': fichaVig('v2', 206, 'util', 'lentitud'),
  });
  const CYCLE = require('../../nightly/findings/cycle.js');
  const ej1 = { ...CYCLE.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-ESCAPE:TYCON_NO_DEEP_REVIEW', nombre: 'Se saltó el pase adversarial', hoy: ayer }),
    ultima_vez: hoy, apariciones: 3, propuesta: { accion: 'arreglar', razon: 'Pasa en la mitad de las ejecuciones de la semana' } };
  const ej2 = { ...CYCLE.nuevaFicha({ fuente: 'ejecuciones', causa: 'RR-ROJO:pruebas', nombre: 'Las pruebas quedaron en rojo al cerrar', hoy: ayer }), veredicto: 'arreglo', pedido: 5001 };
  f[`inbox/runs-review/pending/${ej1.id}.yaml`] = CYCLE.serializar(ej1);
  f[`inbox/runs-review/promoted/${ej2.id}.yaml`] = CYCLE.serializar(ej2);
  // lo que deja la noche para el sitio
  f[`.dashboard/open-prs/open-prs-${hoy}.json`] = { v: 1, fecha: hoy, generado: `${hoy}T05:10:00Z`, estado: 'medido', motivo: null, prs: [
    { numero: 101, proyecto: 'Producto X', repo: 'FrontEnd', dias: 5, autor: ANA, enlace: web('Producto X', '_git/FrontEnd/pullrequest/101') },
    { numero: 102, proyecto: 'Producto Y', repo: 'Backend', dias: 1, autor: BRUNO, enlace: web('Producto Y', '_git/Backend/pullrequest/102') },
    { numero: 103, proyecto: 'Producto Y', repo: 'Backend', dias: 4, autor: BRUNO, enlace: web('Producto Y', '_git/Backend/pullrequest/103') }] };
  f[`.dashboard/assigned/assigned-${hoy}.json`] = { v: 1, fecha: hoy, estado: 'medido', proyectos_no_medidos: [], pedidos: [
    { id: 5001, proyecto: 'Producto X', tipo: 'Tarea', estado: 'Active', asignado: ANA, dias_en_estado: 2, enlace: web('Producto X', '_workitems/edit/5001'), dependencias: false, titulo: 'Paginar la lista de clientes' },
    { id: 5002, proyecto: 'Producto X', tipo: 'Bug', estado: 'New', asignado: ANA, dias_en_estado: 1, enlace: web('Producto X', '_workitems/edit/5002'), dependencias: true, titulo: 'pkg-uno con una vulnerabilidad alta' }] };
  f[`.dashboard/retros/retros-${hoy}.json`] = { v: 1, fecha: hoy, estado: 'medido', pendientes: [{ repo: 'Producto-X/FrontEnd', merge: 'abc1234', dias: 2 }] };
  // el banco con un caso rojo nuevo esta noche, y el de ayer para comparar; el examen de los revisores
  f[`.dashboard/controls-bench/banco-${hoy}.json`] = { ts, ran: 10, failed: 1, skipped: 0, nomedido: 0, parityBreaks: 0, baselineRegressions: 0, estado: 'completo',
    results: { 'caso-uno': { tools: { claude: { pass: false } } }, 'caso-dos': { tools: { claude: { pass: true } } } } };
  f[`.dashboard/controls-bench/banco-${ayer}.json`] = { ts: `${ayer}T05:00:00Z`, ran: 10, failed: 0, estado: 'completo', results: { 'caso-dos': { tools: { claude: { pass: true } } } } };
  f[`.dashboard/controls-bench/examen-${hoy}.json`] = { failed: 0, estado: 'completo' };
  f[`.dashboard/deployments/deployments-${hoy}.json`] = { v: 1, generado: `${hoy}T05:20:00Z`, proveedor: PLATAFORMA.remotos.operaciones.platform, ventana: 30, avisos: [], fallas: [], productos: {
    'Producto X': { estado: 'medido', motivo: 'ok', staging: { estado: 'desplegado', fecha: `${ayer}T14:00:00Z` }, produccion: { estado: 'desplegado', fecha: `${d(3)}T16:00:00Z` }, produccion_atrasada: true, aprobacion: { estado: 'pendiente', desde: `${ayer}T14:30:00Z` }, main: 'verde' },
    'Producto Y': { estado: 'medido', motivo: 'ok', staging: { estado: 'desplegado', fecha: `${d(2)}T10:00:00Z` }, produccion: { estado: 'desplegado', fecha: `${d(2)}T12:00:00Z` }, produccion_atrasada: false, aprobacion: { estado: 'ninguna' }, main: 'verde' } } };
  // la paridad de hoy: lo que lee Proyectos (por repo) y lo que lee Configuración (lo declarado)
  f[`.dashboard/paridad/paridad-${hoy}.json`] = { fecha: hoy, estado: 'medido', divergencias: [{ grupo: 'productos', rasgo: 'escaneo', que: 'el paso de escaneo', tienen: ['Producto-Y/Backend'], no_tienen: ['Producto-X/FrontEnd'] }],
    declaradas: [{ grupo: 'productos', rasgo: 'firma', revision: diaDesde(ahora, 80) }], vencidas: [],
    por_ruta: [{ ruta: 'Producto-X/FrontEnd', estado: 'medido', motivo: null, divergencias: 1, vencidas: 0 }, { ruta: 'Producto-Y/Backend', estado: 'medido', motivo: null, divergencias: 0, vencidas: 0 }] };
  // las métricas de stories, de quién toca qué y de los registros por merge
  f[`.dashboard/sdlc-stage-${hoy}.json`] = { generated_at: ts, global: {
    lead_time_days: { n: 12, mean: 6.1, median: 4.5, max: 15 }, lead_time_monthly: [{ month: hoy.slice(0, 7), n: 12, mean: 6.1, median: 4.5, min: 1, max: 15 }],
    first_pass_ratio: { num: 9, den: 12 }, rework_ratio: { num: 2, den: 12 }, dod_evidence_ratio: { num: 10, den: 12 },
    tiempo_por_etapa: { 'in-progress': { n: 12, mean: 3.1, median: 2.5, min: 0.5, max: 9 }, review: { n: 11, mean: 1.6, median: 1.2, min: 0.2, max: 4 } },
    estados_por_canonico: { conteo: { done: 12, review: 1, 'in-progress': 3, 'ready-for-dev': 2, blocked: 1 }, sin_diccionario: { esperando: 1 }, sin_status: 0, total: 20, por_grupo: { cerrado: 12, en_curso: 4, backlog: 2, bloqueado: 1 } },
    rework_por_causa: { conteo: { 'defecto-propio': 1, 'cambio-de-requisito': 1, 'deuda-declarada': 0, descubrimiento: 0 }, sin_declarar: 1, fuera_de_vocabulario: {}, sin_declarar_por_type: { fix: 1 }, total: 3 },
    sin_transiciones: 0, estados_desconocidos: {} },
  repos: [
    { repo: '/home/dev/acme/Producto-X/historias', stories_total: 12, done_total: 8, rework_ratio: { num: 1, den: 8 }, dod_evidence_ratio: { num: 7, den: 8 }, not_measured: [],
      rework_por_carril: { desde: d(60), con_corrida: { num: 0, den: 6 }, sin_constancia: { num: 2, den: 5 }, fuera_de_ventana: 0 } },
    { repo: '/home/dev/acme/Producto-Y/historias', stories_total: 8, done_total: 4, rework_ratio: { num: 1, den: 4 }, dod_evidence_ratio: { num: 3, den: 4 }, not_measured: [],
      rework_por_carril: { desde: d(60), con_corrida: { num: 1, den: 5 }, sin_constancia: { num: 1, den: 5 }, fuera_de_ventana: 0 } }] };
  f[`.dashboard/story-reference-${hoy}.json`] = { v: 1, generated_at: ts, ventana: { desde: d(28), hasta: hoy, dias: 28 }, cobertura: { repos_declarados: 2, repos_medidos: 2 },
    totales: { codigo: 20, con: 17, sin: 3, por_persona: { Ana: { con: 10, sin: 1 }, Bruno: { con: 7, sin: 2 } }, por_tipo: { hotfix: 1, dependencias: 1, arnes_ci: 0, merge_dev: 1, otro: 0 }, por_via: { pedido: { con: 17, sin: 1 }, directo: { con: 0, sin: 2 } } },
    repos: [{ producto: 'Producto X', repo: 'Producto-X/FrontEnd', estado: 'medido', motivo: null, codigo: 12, con: 10, sin: 2 }, { producto: 'Producto Y', repo: 'Producto-Y/Backend', estado: 'medido', motivo: null, codigo: 8, con: 7, sin: 1 }] };
  f[`.dashboard/author-concentration-${hoy}.json`] = { v: 1, generated_at: ts, ventana: { desde: d(365), hasta: hoy }, umbral: 0.75, min_commits: 20,
    productos: [{ producto: 'Producto X', estado: 'medido', motivo: null, concentracion: 0.82, en_riesgo: true, commits: 120, commits_de_maquina: 10, repos: [] },
      { producto: 'Producto Y', estado: 'medido', motivo: null, concentracion: 0.55, en_riesgo: false, commits: 60, commits_de_maquina: 4, repos: [] }],
    cobertura: { productos_declarados: 2, productos_medidos: 2, repos_declarados: 2, repos_medidos: 2 } };
  f['.dashboard/merges/bajada.json'] = { fecha: ts, estado: 'completo', completo: true, juntados: 1, repetidos: 0, invalidos: 0 };
  f[`.dashboard/merges/metrics-${hoy}-producto-x-1.4-abc1234.json`] = { schema_version: '2.0', repo: '/home/dev/acme/Producto-X/FrontEnd', merge_commit: 'abc1234', project: 'Producto X', captured_at: `${hoy}T09:00:00Z`, story: '1.4', metrics: {} };
  return f;
}

/** El `.tycon/advisors.yaml` de la rama principal de cada repo de producto, con los archivos de esa rama (por nombre del repo). */
const ADVISORS_DE_EJEMPLO = Object.freeze({
  FrontEnd: { texto: '# la configuración del arnés en FrontEnd (ejemplo de acme)\ndeprecated:\n  edit: warn\n  paths:\n    - path: "src/legacy/**"\n      level: frozen\n      reason: "reemplazado por src/lista"\n',
    archivos: ['.tycon/advisors.yaml', 'src/legacy/tabla.js', 'src/lista.js'] },
  Backend: { texto: '# la configuración del arnés en Backend (ejemplo de acme)\ndeprecated:\n  edit: block\n  paths:\n    - path: "src/Viejo/**"\n      level: frozen\n      reason: "lo reemplaza src/Clientes"\n',
    archivos: ['.tycon/advisors.yaml', 'src/Viejo/Cliente.cs', 'src/Clientes/Cliente.cs'] },
});

/** Las claves propias de la organización en `team-repos.json` (sólo el perfil del sitio demo). */
const reposDelDemo = () => ({ review: { blocking_prefixes: ['ACMEAPI'] }, stack: { ...REPOS.stack, code_extensions: ['.cls'] } });

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
function archivosDelPerfil({ repos = {}, extra = {}, completo = false } = {}) {
  // `completo` (sólo el sitio demo): las claves propias de la organización (prefijos graves y terminaciones de código), con
  // el piso de versión que piden
  const propias = completo ? reposDelDemo() : {};
  const piso = completo ? [RESPONSE_SINCE(), require('../../lib/org-config.js').REVIEW_SINCE].reduce((a, v) => (require('../../lib/org-config.js').versionAtLeast(a, v) ? a : v)) : RESPONSE_SINCE();
  return {
    'team-profile.json': PERFIL, 'team-repos.json': { ...REPOS, ...propias, ...repos }, 'team-layer.json': { requires: { harness: `>= ${piso}` } },
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

module.exports = { PAQUETE_DE_REVISORES, CAMPOS_DE_RIESGO, LEAD, ANA, BRUNO, INVITADA, PERFIL, RECETA_NETFX, REPOS, ADVISORS_DE_EJEMPLO, VERSION_DE_EJEMPLO, diasDe, volcadoMinimo, volcadoDeEjecucion, blobsDelBuzon, archivosDeOperaciones, operaciones, archivosDelPerfil };
