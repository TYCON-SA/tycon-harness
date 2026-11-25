'use strict';
// github-code-scanning.test.js — el análisis de seguridad (code scanning) de cada pedido abierto de GitHub, como lo lee
// el conector: un pedido sin su análisis, con él en rojo, corriendo o con alertas abiertas nunca sale verde, y la regla
// de la rama dice si lo exige. Todo con una llamada a GitHub de mentira: ninguna prueba sale a la red.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const CR = () => require(path.join(ROOT, 'integrations', 'github', 'scripts', 'change-requests.js'));

const APP = 'github-advanced-security';
const corrida = (o = {}) => ({ __typename: 'CheckRun', name: 'CodeQL', status: 'COMPLETED', conclusion: 'SUCCESS', checkSuite: { app: { slug: APP } }, ...o });
const otra = (o = {}) => ({ __typename: 'CheckRun', name: 'public-ci', status: 'COMPLETED', conclusion: 'SUCCESS', checkSuite: { app: { slug: 'github-actions' } }, ...o });
/** Un pedido como lo devuelve la consulta GraphQL, con los controles de su punta. */
const reglas = (...tipos) => ({ rules: { totalCount: tipos.length, nodes: tipos.map((type) => ({ type })) } });
const EXIGE = reglas('MERGE_QUEUE', 'REQUIRED_STATUS_CHECKS', 'CODE_SCANNING');
const NO_EXIGE = reglas('MERGE_QUEUE', 'REQUIRED_STATUS_CHECKS');
const nodo = (n, controles, o = {}) => ({ number: n, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', id: `PR_${n}`, headRefName: `fix/${n}`, headRefOid: `c${n}`, baseRefName: 'main', baseRef: EXIGE,
  commits: { nodes: [{ commit: { committedDate: '2026-11-19T10:00:00Z', statusCheckRollup: { state: 'SUCCESS', contexts: { totalCount: controles.length, nodes: controles } } } }] }, ...o });

/** La llamada a GitHub de mentira: cada ruta, su respuesta (`{ value }` o `{ problem }`); lo que no está, 404. */
function github(rutas) {
  const llamadas = [];
  const llamar = (ctx, method, ruta) => {
    llamadas.push(ruta);
    for (const [patron, r] of rutas) if (patron.test(ruta)) return typeof r === 'function' ? r(ruta) : r;
    return { problem: { ok: false, reason: 'no_encontrado', detail: `HTTP 404 ${ruta}` } };
  };
  return { llamar, llamadas };
}
const CONFIGURADO = [/code-scanning\/default-setup$/, { value: { state: 'configured' } }];
const SIN_ALERTAS = [/code-scanning\/alerts\?ref=refs%2Fpull%2F\d+%2F(merge|head)&state=open/, { value: [] }];

function leer(nodos, rutas) {
  const g = github(rutas);
  const pedidos = nodos.map((n) => CR().deGraphql(n));
  return { pedidos: CR().conAnalisis({}, 'acme/widgets', pedidos, g.llamar), llamadas: g.llamadas };
}

test('T1 CodeScanning_SuControlVerdeSinAlertas_EsVerde — el control de la app del análisis en success y sin alertas abiertas', () => {
  const { pedidos } = leer([nodo(1, [otra(), corrida()])], [CONFIGURADO, SIN_ALERTAS]);
  assert.deepStrictEqual(pedidos[0].codeScanning, { estado: 'verde', motivo: null });
  assert.strictEqual(pedidos[0].codeScanningRequired, true);
  assert.strictEqual(pedidos[0]._rollup, undefined, 'lo leído para contar no sale del conector');
});

test('T2 CodeScanning_SinSuControl_Falta — un repo con análisis y una punta sin su control (no corrió) no es verde', () => {
  const { pedidos, llamadas } = leer([nodo(2, [otra()], { baseRef: NO_EXIGE })], [CONFIGURADO, SIN_ALERTAS]);
  assert.strictEqual(pedidos[0].codeScanning.estado, 'falta');
  assert.match(pedidos[0].codeScanning.motivo, /no corrió \(o todavía no empezó\) en la punta/);
  assert.strictEqual(pedidos[0].codeScanningRequired, false);
  assert.ok(!llamadas.some((r) => /alerts/.test(r)), 'sin el control, ni siquiera se leen las alertas');
});

test('T3 CodeScanning_EnRojoOCorriendo_NoEsVerde — failure, neutral o sin terminar', () => {
  for (const [c, estado] of [[corrida({ conclusion: 'FAILURE' }), 'rojo'], [corrida({ conclusion: 'NEUTRAL' }), 'rojo'], [corrida({ status: 'IN_PROGRESS', conclusion: null }), 'corriendo']]) {
    const { pedidos } = leer([nodo(3, [c])], [CONFIGURADO, SIN_ALERTAS]);
    assert.strictEqual(pedidos[0].codeScanning.estado, estado, JSON.stringify(c));
  }
});

test('T4 CodeScanning_ConAlertasAbiertas_EsRojo — el control en success pero el pedido con una alerta abierta', () => {
  const { pedidos } = leer([nodo(4, [corrida()])], [CONFIGURADO, [/code-scanning\/alerts\?ref=refs%2Fpull%2F4%2Fmerge/, { value: [{ number: 9 }] }], SIN_ALERTAS]);
  assert.strictEqual(pedidos[0].codeScanning.estado, 'rojo');
  assert.match(pedidos[0].codeScanning.motivo, /1 alerta/);
});

test('T5 CodeScanning_LoQueNoSeLee_NuncaEsVerde — las alertas, los controles o el repo que no se pudieron leer', () => {
  const ilegible = [/alerts/, { problem: { ok: false, reason: 'red', detail: 'sin red' } }];
  assert.strictEqual(leer([nodo(5, [corrida()])], [CONFIGURADO, ilegible]).pedidos[0].codeScanning.estado, 'no-se-pudo');
  const sinControles = nodo(5, [corrida()]);
  sinControles.commits.nodes[0].commit.statusCheckRollup = null;
  assert.strictEqual(leer([sinControles], [CONFIGURADO, SIN_ALERTAS]).pedidos[0].codeScanning.estado, 'no-se-pudo');
  const cortados = nodo(5, [corrida()]);
  cortados.commits.nodes[0].commit.statusCheckRollup.contexts.totalCount = 150;
  assert.strictEqual(leer([cortados], [CONFIGURADO, SIN_ALERTAS]).pedidos[0].codeScanning.estado, 'no-se-pudo', 'una lista de controles cortada no se cuenta');
  const repoIlegible = leer([nodo(5, [corrida()])], [[/default-setup|analyses/, { problem: { ok: false, reason: 'red', detail: 'sin red' } }]]).pedidos[0];
  assert.strictEqual(repoIlegible.codeScanning.estado, 'no-se-pudo');
  assert.strictEqual(repoIlegible.codeScanningRequired, null, 'sin saber si hay análisis, no se afirma nada de la regla');
});

test('T6 CodeScanning_RepoSinAnalisis_NoAplica — sin configuración ni análisis subidos, nada cambia', () => {
  const { pedidos, llamadas } = leer([nodo(6, [otra()])], [[/default-setup/, { value: { state: 'not-configured' } }], [/analyses/, { value: [] }]]);
  assert.deepStrictEqual(pedidos[0].codeScanning, { estado: 'no-aplica', motivo: null });
  assert.strictEqual(pedidos[0].codeScanningRequired, null);
  assert.ok(!llamadas.some((r) => /rules|alerts/.test(r)), 'sin análisis no se leen reglas ni alertas');
  // la configuración avanzada (un flujo propio) cuenta por sus análisis subidos
  const avanzada = leer([nodo(6, [otra()])], [[/default-setup/, { value: { state: 'not-configured' } }], [/analyses/, { value: [{ id: 1 }] }]]);
  assert.strictEqual(avanzada.pedidos[0].codeScanning.estado, 'falta');
});

test('T7 CodeScanning_SoloLosQuePuedenEntrar_LeenAlertas — borrador, en choque o en la cola: sin leer alertas, y no salen verdes', () => {
  const enCola = nodo(9, [corrida()], { mergeQueueEntry: { state: 'QUEUED' } });
  const { pedidos, llamadas } = leer([nodo(7, [corrida()], { isDraft: true }), nodo(8, [corrida()], { mergeable: 'CONFLICTING' }), enCola], [CONFIGURADO, SIN_ALERTAS]);
  assert.deepStrictEqual(pedidos.map((p) => p.codeScanning.estado), ['sin-mirar', 'sin-mirar', 'sin-mirar']);
  assert.ok(!llamadas.some((r) => /alerts|rules/.test(r)), 'ni alertas ni reglas por REST');
  // en choque, igual se ve que el análisis falta o está en rojo: eso no cuesta ninguna lectura
  assert.strictEqual(leer([nodo(8, [otra()], { mergeable: 'CONFLICTING' })], [CONFIGURADO]).pedidos[0].codeScanning.estado, 'falta');
});

test('T8 CodeScanning_LaRegla_VieneEnLaConsulta — exige, no exige, o no se supo (sin rama, o la lista de reglas cortada)', () => {
  const r = (baseRef) => leer([nodo(1, [corrida()], { baseRef })], [CONFIGURADO, SIN_ALERTAS]).pedidos[0].codeScanningRequired;
  assert.strictEqual(r(EXIGE), true);
  assert.strictEqual(r(NO_EXIGE), false);
  assert.strictEqual(r(null), null);
  assert.strictEqual(r({ rules: { totalCount: 150, nodes: [{ type: 'MERGE_QUEUE' }] } }), null, 'una lista de reglas cortada no dice «no exige»');
});

test('T9 CodeScanning_Un404Cualquiera_NoEsSinAnalisis — sólo «no analysis found» dice que el repo no tiene análisis', () => {
  const sinPermiso = [/default-setup/, { problem: { ok: false, reason: 'rechazado', detail: 'HTTP 403 Must have admin rights' } }];
  const noVe = leer([nodo(1, [corrida()])], [sinPermiso, [/analyses/, { problem: { ok: false, reason: 'no_encontrado', detail: 'HTTP 404 Not Found' } }]]).pedidos[0];
  assert.strictEqual(noVe.codeScanning.estado, 'no-se-pudo', 'una credencial que no ve los análisis no los da por inexistentes');
  const ninguno = leer([nodo(1, [otra()])], [sinPermiso, [/analyses/, { problem: { ok: false, reason: 'no_encontrado', detail: 'HTTP 404 no analysis found' } }]]).pedidos[0];
  assert.strictEqual(ninguno.codeScanning.estado, 'no-aplica');
});

test('T10 CodeScanning_SinTiempo_NoLeeYNoEsVerde — pasado el tope de la lectura, ni el repo ni las alertas se leen', () => {
  const g = github([CONFIGURADO, SIN_ALERTAS]);
  const tarde = CR().conAnalisis({}, 'acme/widgets', [CR().deGraphql(nodo(1, [corrida()]))], g.llamar, { hasta: 0, ahora: () => 1 });
  assert.strictEqual(tarde[0].codeScanning.estado, 'no-se-pudo');
  assert.deepStrictEqual(g.llamadas, [], 'no llamó a GitHub');
  // con tiempo para el repo y no para las alertas
  let t = 0;
  const g2 = github([CONFIGURADO, SIN_ALERTAS]);
  const medio = CR().conAnalisis({}, 'acme/widgets', [CR().deGraphql(nodo(1, [corrida()]))], g2.llamar, { hasta: 0.5, ahora: () => t++ });
  assert.match(medio[0].codeScanning.motivo, /no hubo tiempo de leer sus alertas/);
  assert.ok(!g2.llamadas.some((r) => /alerts/.test(r)));
});

test('T11 CodeScanning_ExigidoComoControlRequerido_CuentaComoExigido — por una regla o por la protección clásica', () => {
  const r = (baseRef) => leer([nodo(1, [corrida()], { baseRef })], [CONFIGURADO, SIN_ALERTAS]).pedidos[0].codeScanningRequired;
  const conCheck = (ctx) => ({ rules: { totalCount: 1, nodes: [{ type: 'REQUIRED_STATUS_CHECKS', parameters: { requiredStatusChecks: [{ context: ctx }] } }] } });
  assert.strictEqual(r(conCheck('CodeQL')), true);
  assert.strictEqual(r(conCheck('public-ci')), false);
  assert.strictEqual(r({ ...NO_EXIGE, branchProtectionRule: { requiredStatusCheckContexts: ['public-ci', 'CodeQL'] } }), true);
});

test('T12 CodeScanning_AlertaSoloEnLaPunta_EsRojo — una alerta anotada en refs/pull/N/head (no en /merge) también cuenta', () => {
  // así entró a main la alerta 171 del público: el análisis la anotó en la punta del pedido, y el control sólo leía /merge
  const { pedidos, llamadas } = leer([nodo(12, [corrida()])], [CONFIGURADO,
    [/code-scanning\/alerts\?ref=refs%2Fpull%2F12%2Fmerge/, { value: [] }],
    [/code-scanning\/alerts\?ref=refs%2Fpull%2F12%2Fhead/, { value: [{ number: 171 }] }]]);
  assert.strictEqual(pedidos[0].codeScanning.estado, 'rojo', JSON.stringify(pedidos[0].codeScanning));
  assert.match(pedidos[0].codeScanning.motivo, /1 alerta/);
  assert.ok(llamadas.some((r) => /refs%2Fpull%2F12%2Fhead/.test(r)), 'lee la punta');
  // la misma alerta en las dos: se cuenta una vez
  const dos = leer([nodo(12, [corrida()])], [CONFIGURADO, [/code-scanning\/alerts\?ref=refs%2Fpull%2F12%2F(merge|head)/, { value: [{ number: 171 }] }]]).pedidos[0];
  assert.match(dos.codeScanning.motivo, /^1 alerta/);
});

/**
 * Un gh de mentira para la lista con la cola: la consulta GraphQL contesta con el pedido `n` limpio y con su análisis en
 * verde; cualquier otra ruta, 404. Anota cada ruta pedida.
 */
function ghConUnPedido(n) {
  const fs = require('fs');
  const os = require('os');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-un-pedido-'));
  const bin = path.join(d, 'gh.js');
  const log = path.join(d, 'rutas.log');
  fs.writeFileSync(bin, `'use strict';
const fs = require('fs');
const a = process.argv.slice(2);
const ruta = a[a.indexOf('--method') + 4];
fs.appendFileSync(${JSON.stringify(log)}, ruta + '\\n');
if (ruta === 'graphql') {
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequests: { nodes: [${JSON.stringify(nodo(n, [corrida()]))}], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
  process.exit(0);
}
process.stderr.write('gh: Not Found (HTTP 404)');
process.exit(1);
`);
  return { bin, rutas: () => fs.readFileSync(log, 'utf8').trim().split('\n') };
}

// Fila 172b (24/11): `deadlineMs` es la hora límite, como en el conector de Azure DevOps y en quien llama; el análisis la
// tomaba como una duración, y su corte caía en otro siglo. Con la hora límite ya pasada, no lee el análisis y lo dice.
test('T13 CodeScanning_LaHoraLimite_EsUnaHora_YSinTiempoLoMarca — pasada la hora límite no se lee, y queda marcado sin tiempo', () => {
  const listar = (gh, deadlineMs) => CR()['change-request.list']({ queue: true, deadlineMs }, { env: { ...process.env, TYCON_GH_CMD: gh.bin }, repo: { org: 'acme', repo: 'widgets' } });
  const tarde = ghConUnPedido(13);
  // stable-data: el conector mide el corte contra el reloj de ahora; la hora límite va un segundo antes o un minuto después
  const r = listar(tarde, Date.now() - 1000);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.value[0].codeScanning.estado, 'no-se-pudo', JSON.stringify(r.value[0].codeScanning));
  assert.match(r.value[0].codeScanning.motivo, /no hubo tiempo/);
  assert.strictEqual(r.value[0].codeScanning.sinTiempo, true, 'marcado sin tiempo: quien lee la lista lo distingue de una lectura fallida');
  assert.deepStrictEqual(tarde.rutas(), ['graphql'], 'no salió a leer el análisis');
  // con tiempo, sale a leerlo (acá GitHub contesta 404: no se pudo, por otro motivo) y no queda marcado sin tiempo
  const aTiempo = ghConUnPedido(13);
  const s = listar(aTiempo, Date.now() + 60000);
  assert.doesNotMatch(String(s.value[0].codeScanning.motivo), /no hubo tiempo/, JSON.stringify(s.value[0].codeScanning));
  assert.ok(!s.value[0].codeScanning.sinTiempo);
  assert.ok(aTiempo.rutas().some((x) => /code-scanning/.test(x)), 'leyó el análisis');
  // lo que se corta en el medio también queda marcado
  let t = 0;
  const medio = CR().conAnalisis({}, 'acme/widgets', [CR().deGraphql(nodo(1, [corrida()]))], github([CONFIGURADO]).llamar, { hasta: 0.5, ahora: () => t++ });
  assert.strictEqual(medio[0].codeScanning.sinTiempo, true, JSON.stringify(medio[0].codeScanning));
});
