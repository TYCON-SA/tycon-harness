'use strict';
/*
 * nightly-deployments.test.js — la foto de despliegues de cada noche.
 *
 * Qué llegó a staging y qué a producción en cada producto, leído del STAGE de cada corrida (nunca del resultado global
 * ni de un pedazo de texto), con la aprobación de producción pendiente o vencida y main roto o no. Azure es
 * scripts/tests/lib/fake-az.sh (TYCON_ADO_CMD); GitHub, scripts/tests/lib/fake-gh.js (TYCON_GH_CMD). Sin red.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'scripts', 'nightly', 'deployments');
const GUION = path.join(DIR, 'deployments.js');
const HOY = '2026-10-15';
const ORG = 'https://dev.azure.com/prueba';

function mundo({ repos = [{ producto: 'Acme', ado: 'Proy/Back' }], deployments, provider = 'azure', operations = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deployments-'));
  const fix = path.join(d, 'fixaz');
  fs.mkdirSync(fix);
  const doble = path.join(d, 'az');
  fs.copyFileSync(path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-az.sh'), doble);
  fs.chmodSync(doble, 0o755);
  const reposFile = path.join(d, 'repos.json');
  fs.writeFileSync(reposFile, JSON.stringify({ azure: { org: ORG }, repos: repos.map((r) => ({ ruta: 'x', activo: true, ...r })) }));
  const ops = path.join(d, 'operations.json');
  if (operations) {
    const doc = { version: 1, owners: { default: 'lider@ejemplo.example' } };
    if (deployments) doc.deployments = { provider, products: deployments };
    fs.writeFileSync(ops, JSON.stringify(doc));
  }
  const gh = path.join(d, 'gh-state.json');
  fs.writeFileSync(gh, JSON.stringify({ user: 'bot' }));
  return { d, fix, doble, repos: reposFile, ops, gh, out: path.join(d, 'out') };
}
const fx = (m, nombre, v) => fs.writeFileSync(path.join(m.fix, nombre), JSON.stringify(v));
const gh = (m, cambios) => { const s = JSON.parse(fs.readFileSync(m.gh, 'utf8')); fs.writeFileSync(m.gh, JSON.stringify({ ...s, ...cambios })); };
function correr(m, extra = [], env = {}) {
  return spawnSync(process.execPath, [GUION, '--today', HOY, '--out', m.out, '--repos', m.repos, '--operations', m.ops, '--org', ORG, ...extra], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, FIXAZ: m.fix, TYCON_ADO_CMD: m.doble, TYCON_GH_CMD: path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-gh.js'), FAKE_GH_STATE: m.gh, TF_BUILD: '', GH_TOKEN: 'x', ...env },
  });
}
const foto = (m) => JSON.parse(fs.readFileSync(path.join(m.out, `deployments-${HOY}.json`), 'utf8'));
const llamadas = (m) => { try { return fs.readFileSync(path.join(m.fix, 'llamadas.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [p, j] = l.split('\t'); return { paso: p, ...JSON.parse(j) }; }); } catch { return []; } };

// ── datos armados de Azure ───────────────────────────────────────────────────────────────────────
const stage = (identifier, result, finishTime, extra = {}) => ({ type: 'Stage', identifier, name: extra.name || `Etapa visible ${identifier}`, state: extra.state || 'completed', result, startTime: finishTime, finishTime, ...extra });
const aprob = (state, result, startTime, finishTime) => ({ type: 'Checkpoint.Approval', identifier: '00000000-0000-0000-0000-000000000001', name: 'Checkpoint.Approval', state, result, startTime, finishTime });
let N = 1000;
function corrida(extra = {}) {
  N += 1;
  return { id: N, buildNumber: `20261015.${N}`, status: 'completed', result: 'succeeded', reason: 'individualCI', sourceBranch: 'refs/heads/main',
    sourceVersion: `${N}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.slice(0, 40), queueTime: '2026-10-14T10:00:00Z', finishTime: '2026-10-14T11:00:00Z', tags: [], ...extra };
}
/** Un pipeline con sus corridas (de la más nueva a la más vieja en `runs`) y el timeline de cada una. */
function pipeline(m, { proyecto = 'Proy', nombre, id, runs }) {
  const defs = path.join(m.fix, `definiciones-${proyecto}.json`);
  const prev = fs.existsSync(defs) ? JSON.parse(fs.readFileSync(defs, 'utf8')) : [];
  fs.writeFileSync(defs, JSON.stringify([...prev, { id, name: nombre }]));
  // `runs` va de la más nueva a la más vieja: la cola lo dice (el guion ordena por cola, nunca por el orden que llega)
  runs.forEach((r, i) => { r.run.queueTime = new Date(Date.parse('2026-10-15T00:00:00Z') - i * 3600000).toISOString(); });
  fx(m, `builds-${id}.json`, runs.map((r) => r.run));
  for (const r of runs) fx(m, `timeline-${r.run.id}.json`, { records: r.records || [] });
}
const az = (pipelineName, stages) => ({ pipeline: `Proy/${pipelineName}`, stages });

// ── la configuración ─────────────────────────────────────────────────────────────────────────────

test('T4 SinDeclarar_NoMedidoConMotivo', () => {
  const m = mundo({ repos: [{ producto: 'Acme', ado: 'P/a' }, { producto: 'Beta', ado: 'P/b' }] });
  const r = correr(m);
  assert.strictEqual(r.status, 0, r.stderr);
  const f = foto(m);
  assert.deepStrictEqual(Object.keys(f.productos).sort(), ['Acme', 'Beta']);
  for (const p of Object.values(f.productos)) { assert.strictEqual(p.estado, 'no_medido'); assert.strictEqual(p.motivo, 'sin_declarar'); }
});

test('T5 ProductoSoloEnDeployments_Aviso', () => {
  const m = mundo({ repos: [{ producto: 'Acme', ado: 'P/a' }], deployments: { Gamma: { production: [az('Gamma Prod', ['EtapaY'])] } } });
  pipeline(m, { nombre: 'Gamma Prod', id: 7, runs: [] });
  const r = correr(m);
  assert.strictEqual(r.status, 0, r.stderr);
  const f = foto(m);
  assert.ok(f.productos.Gamma, 'publicado');
  assert.ok(f.avisos.some((a) => a.codigo === 'no_esta_en_repos_json' && a.producto === 'Gamma'), JSON.stringify(f.avisos));
});

test('T6 Codigo_SinValoresDeUnaOrganizacion', (t) => {
  const textos = ['deployments.js', 'azure.js', 'github.js'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);
  const prohibidos = [/DeployProd/, /'Deploy'/, /"Deploy"/, /environment:\s*'production'/, /dev\.azure\.com\/[A-Za-z0-9]/];
  const rj = path.join(ROOT, 'scripts', 'nightly', 'dependencies', 'repos.json');
  if (fs.existsSync(rj)) {
    const j = JSON.parse(fs.readFileSync(rj, 'utf8'));
    for (const r of j.repos || []) for (const v of [r.producto, ...String(r.ado || '').split('/')]) {
      if (v && v.length > 2) prohibidos.push(new RegExp(`\\b${decodeURIComponent(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
    }
  } else t.diagnostic('sin repos.json en el árbol (CI pública): la parte de los nombres del equipo no se mide acá');
  for (const [f, t] of textos) for (const re of prohibidos) assert.ok(!re.test(t), `${f} contiene ${re}`);

  // con stages EtapaX / EtapaY declarados, cuenta eso y nada más
  const m = mundo({ deployments: { Acme: { staging: [az('Acme CI', ['EtapaX'])], production: [az('Acme Prod', ['EtapaY'])] } } });
  pipeline(m, { nombre: 'Acme CI', id: 1, runs: [{ run: corrida(), records: [stage('Deploy', 'succeeded', '2026-10-14T11:00:00Z'), stage('EtapaX', 'succeeded', '2026-10-14T10:30:00Z')] }] });
  pipeline(m, { nombre: 'Acme Prod', id: 2, runs: [{ run: corrida(), records: [stage('DeployProd', 'succeeded', '2026-10-14T11:00:00Z')] }, { run: corrida(), records: [stage('EtapaY', 'succeeded', '2026-10-13T11:00:00Z')] }] });
  assert.strictEqual(correr(m).status, 0);
  const p = foto(m).productos.Acme;
  assert.strictEqual(p.staging.fecha, '2026-10-14T10:30:00Z');
  assert.strictEqual(p.produccion.fecha, '2026-10-13T11:00:00Z', 'DeployProd no está declarado: no cuenta');
});

// ── el criterio en Azure ─────────────────────────────────────────────────────────────────────────

test('T7 Azure_StageExactoSucceeded — producción por el identificador exacto: succeeded sí, skipped/ausente no', () => {
  const casos = [
    ['DeployProd', 'succeeded', true, false], ['DeployProd', 'skipped', false], [null, null, false],
    ['DeployNonProd', 'succeeded', false], ['deployprod', 'succeeded', true, false], ['DeployProd', 'succeededWithIssues', true, true],
    ['DeployProd', 'abandoned', false],
  ];
  for (const [id, res, cuenta, avisos] of casos) {
    const m = mundo({ deployments: { Acme: { production: [az('Acme Prod', ['DeployProd'])] } } });
    pipeline(m, { nombre: 'Acme Prod', id: 2, runs: [{ run: corrida(), records: id ? [stage(id, res, '2026-10-14T11:00:00Z')] : [] }] });
    assert.strictEqual(correr(m).status, 0);
    const p = foto(m).productos.Acme.produccion;
    if (cuenta) { assert.strictEqual(p.estado, 'desplegado', `${id}/${res}`); assert.strictEqual(p.con_avisos, avisos); }
    else assert.strictEqual(p.estado, 'sin_despliegue_en_ventana', `${id}/${res} no tiene que contar`);
  }
});

test('T8 Azure_NombreVisibleNoSeMira', () => {
  const m = mundo({ deployments: { Acme: { production: [az('Acme Prod', ['DeployProd'])] } } });
  pipeline(m, { nombre: 'Acme Prod', id: 2, runs: [{ run: corrida(), records: [stage('Etapa3', 'succeeded', '2026-10-14T11:00:00Z', { name: 'PROD Acme' })] }] });
  correr(m);
  assert.strictEqual(foto(m).productos.Acme.produccion.estado, 'sin_despliegue_en_ventana');
});

test('T9 Azure_VariosStagesDeProduccion_ElMasNuevo', () => {
  const m = mundo({ deployments: { Acme: { production: [az('Acme Prod', ['DeployProdA', 'DeployProdB'])] } } });
  pipeline(m, { nombre: 'Acme Prod', id: 2, runs: [{ run: corrida(), records: [stage('DeployProdA', 'succeeded', '2026-10-12T11:00:00Z'), stage('DeployProdB', 'succeeded', '2026-10-14T11:00:00Z')] }] });
  correr(m);
  assert.strictEqual(foto(m).productos.Acme.produccion.fecha, '2026-10-14T11:00:00Z');
});

test('T10 Azure_UltimoDespliegue_CamposYConstancia', () => {
  for (const [tags, esperado] of [[['desplegado', 'despliegue-intentado'], true], [['despliegue-intentado'], false], [[], null]]) {
    const m = mundo({ deployments: { Acme: { staging: [az('Acme CI', ['Deploy1'])] } } });
    const run = corrida({ tags, sourceVersion: 'abcdef0123456789abcdef0123456789abcdef01' });
    pipeline(m, { nombre: 'Acme CI', id: 1, runs: [{ run, records: [stage('Deploy1', 'succeeded', '2026-10-14T11:00:00Z')] }] });
    correr(m);
    const s = foto(m).productos.Acme.staging;
    assert.strictEqual(s.estado, 'desplegado');
    assert.strictEqual(s.fecha, '2026-10-14T11:00:00Z');
    assert.strictEqual(s.corrida, run.buildNumber);
    assert.strictEqual(s.commit, 'abcdef0');
    assert.strictEqual(s.commit_fuente, 'sourceVersion');
    assert.strictEqual(s.pipeline, 'Proy/Acme CI');
    assert.strictEqual(s.constancia_humo, esperado);
  }
});

test('T11 Azure_ProduccionAtrasada', () => {
  const armar = (commitStg, commitProd, prodExtra = {}) => {
    const m = mundo({ deployments: { Acme: { staging: [az('Acme CI', ['S'])], production: [az('Acme Prod', ['P'])] } } });
    pipeline(m, { nombre: 'Acme CI', id: 1, runs: [{ run: corrida({ sourceVersion: commitStg.padEnd(40, '0') }), records: [stage('S', 'succeeded', '2026-10-15T05:00:00Z')] }] });
    pipeline(m, { nombre: 'Acme Prod', id: 2, runs: [{ run: corrida({ sourceVersion: commitProd.padEnd(40, '0'), ...prodExtra }), records: [stage('P', 'succeeded', '2026-10-14T05:00:00Z')] }] });
    correr(m);
    return foto(m).productos.Acme;
  };
  assert.strictEqual(armar('bbb', 'aaa').produccion_atrasada, true);
  assert.strictEqual(armar('bbb', 'bbb').produccion_atrasada, false);
  const manual = armar('bbb', 'ccc', { reason: 'manual', triggerInfo: {} });
  assert.strictEqual(manual.produccion_atrasada, null);
  assert.strictEqual(manual.motivo, 'promocion_manual_sin_commit');
  assert.strictEqual(manual.produccion.commit_fuente, 'sourceVersion');

  // con la corrida de CI promovida en triggerInfo, el commit sale del recurso
  const m = mundo({ deployments: { Acme: { staging: [az('Acme CI', ['S'])], production: [az('Acme Prod', ['P'])] } } });
  const ci = corrida({ sourceVersion: 'bbb'.padEnd(40, '0') });
  pipeline(m, { nombre: 'Acme CI', id: 1, runs: [{ run: ci, records: [stage('S', 'succeeded', '2026-10-15T05:00:00Z')] }] });
  pipeline(m, { nombre: 'Acme Prod', id: 2, runs: [{ run: corrida({ reason: 'manual', sourceVersion: 'fff'.padEnd(40, '0'), triggerInfo: { pipelineId: String(ci.id) } }), records: [stage('P', 'succeeded', '2026-10-14T05:00:00Z')] }] });
  fx(m, `corrida-${ci.id}.json`, ci);
  correr(m);
  const p = foto(m).productos.Acme;
  assert.strictEqual(p.produccion.commit, 'bbb0000');
  assert.strictEqual(p.produccion.commit_fuente, 'recurso');
  assert.strictEqual(p.produccion_atrasada, false);
});

test('T12 Azure_Aprobacion_PendienteVencidaNoAprobada', () => {
  const armar = (runs) => {
    const m = mundo({ deployments: { Acme: { production: [az('Acme Prod', ['P'])] } } });
    pipeline(m, { nombre: 'Acme Prod', id: 2, runs });
    correr(m);
    return foto(m).productos.Acme.aprobacion;
  };
  const desplegada = { run: corrida(), records: [stage('P', 'succeeded', '2026-10-10T05:00:00Z'), aprob('completed', 'succeeded', '2026-10-10T04:00:00Z', '2026-10-10T04:30:00Z')] };
  const a = armar([{ run: corrida({ status: 'inProgress', result: null }), records: [aprob('inProgress', null, '2026-10-15T01:00:00Z', null)] }, desplegada]);
  assert.strictEqual(a.estado, 'pendiente'); assert.strictEqual(a.desde, '2026-10-15T01:00:00Z');
  const v1 = corrida({ result: 'succeeded' }), v2 = corrida({ result: 'succeeded' });
  const b = armar([{ run: v2, records: [stage('P', 'skipped', '2026-10-14T05:00:00Z'), aprob('completed', 'skipped', '2026-10-13T05:00:00Z', '2026-10-14T05:00:00Z')] },
    { run: v1, records: [stage('P', 'skipped', '2026-10-12T05:00:00Z'), aprob('completed', 'skipped', '2026-10-11T05:00:00Z', '2026-10-12T05:00:00Z')] }, desplegada]);
  assert.strictEqual(b.estado, 'vencida'); assert.strictEqual(b.cuantas, 2); assert.strictEqual(b.corrida, v2.buildNumber);
  const c = armar([{ run: corrida({ result: 'failed' }), records: [aprob('completed', 'failed', '2026-10-13T05:00:00Z', '2026-10-13T06:00:00Z')] }, desplegada]);
  assert.strictEqual(c.estado, 'no_aprobada'); assert.strictEqual(c.resultado, 'failed');
  assert.strictEqual(armar([desplegada]).estado, 'ninguna');
});

test('T13 Azure_Main_RotoConAvisosVerdeSinCorridas', () => {
  const armar = (pipes) => {
    const m = mundo({ deployments: { Acme: { staging: pipes.map((p, i) => az(`CI ${i}`, ['S'])) } } });
    pipes.forEach((runs, i) => pipeline(m, { nombre: `CI ${i}`, id: 10 + i, runs: runs.map((run) => ({ run })) }));
    correr(m);
    return foto(m).productos.Acme;
  };
  assert.strictEqual(armar([[corrida({ result: 'canceled' }), corrida({ result: 'failed' })]]).main, 'roto');
  assert.strictEqual(armar([[corrida({ result: 'partiallySucceeded' })]]).main, 'con_avisos');
  assert.strictEqual(armar([[corrida({ result: 'succeeded' })]]).main, 'verde');
  assert.strictEqual(armar([[corrida({ sourceBranch: 'refs/heads/otra', result: 'failed' })]]).main, 'sin_corridas');
  assert.strictEqual(armar([[corrida({ result: 'failed' })], [corrida({ result: 'succeeded' })]]).main, 'roto');
});

test('T14 Azure_Ventana_SinDespliegueNoEsNunca', () => {
  const m = mundo({ deployments: { Acme: { production: [az('Acme Prod', ['P'])] } } });
  const runs = [];
  for (let i = 0; i < 31; i++) runs.push({ run: corrida(), records: i === 30 ? [stage('P', 'succeeded', '2026-09-01T00:00:00Z')] : [] });
  pipeline(m, { nombre: 'Acme Prod', id: 2, runs });
  correr(m);
  const f = foto(m);
  assert.strictEqual(f.productos.Acme.produccion.estado, 'sin_despliegue_en_ventana');
  assert.strictEqual(f.productos.Acme.produccion.ventana, 30);
  assert.strictEqual(f.ventana, 30);
  assert.ok(!llamadas(m).some((l) => l.paso === 'timeline' && l.args.includes(`buildId=${runs[30].run.id}`)), 'la 31 no se pide');

  const m2 = mundo({ deployments: { Acme: { production: [az('Acme Prod', ['P'])] } } });
  const r2 = [{ run: corrida(), records: [] }, { run: corrida(), records: [stage('P', 'succeeded', '2026-10-01T00:00:00Z')] }, { run: corrida(), records: [] }];
  pipeline(m2, { nombre: 'Acme Prod', id: 2, runs: r2 });
  correr(m2);
  assert.ok(!llamadas(m2).some((l) => l.paso === 'timeline' && l.args.includes(`buildId=${r2[2].run.id}`)), 'corta en el primer despliegue');

  const m3 = mundo({ deployments: { Acme: { production: [az('Acme Prod', ['P'])] } } });
  pipeline(m3, { nombre: 'Acme Prod', id: 2, runs: [{ run: corrida(), records: [] }] });
  assert.strictEqual(correr(m3, ['--budget-ms', '0']).status, 0);
  const p3 = foto(m3).productos.Acme;
  assert.strictEqual(p3.estado, 'no_medido');
  assert.strictEqual(p3.pipelines[0].motivo, 'presupuesto_agotado');
});

test('T26 Azure_PipelinePorNombreExacto', () => {
  const m = mundo({ deployments: { Acme: { production: [az('Acme Backend', ['P'])] } } });
  pipeline(m, { nombre: 'Acme Backend Prod', id: 3, runs: [{ run: corrida(), records: [stage('P', 'succeeded', '2026-10-14T00:00:00Z')] }] });
  pipeline(m, { nombre: 'Acme Backend', id: 4, runs: [{ run: corrida(), records: [stage('P', 'succeeded', '2026-10-13T00:00:00Z')] }] });
  correr(m);
  assert.strictEqual(foto(m).productos.Acme.produccion.fecha, '2026-10-13T00:00:00Z');

  const m2 = mundo({ deployments: { Acme: { production: [az('Acme Backend', ['P'])] } } });
  correr(m2);
  assert.strictEqual(foto(m2).productos.Acme.pipelines[0].motivo, 'pipeline_no_encontrado');

  const m3 = mundo({ deployments: { Acme: { production: [az('Acme Backend', ['P'])] } } });
  pipeline(m3, { nombre: 'acme backend', id: 5, runs: [] });
  pipeline(m3, { nombre: 'ACME BACKEND', id: 6, runs: [] });
  correr(m3);
  assert.strictEqual(foto(m3).productos.Acme.pipelines[0].motivo, 'pipeline_ambiguo');
});

// ── GitHub ───────────────────────────────────────────────────────────────────────────────────────

test('T15 GitHub_EnvironmentDeploymentsYEstados', () => {
  const ent = (environment) => ({ repo: 'org/app', environment });
  const m = mundo({ provider: 'github', deployments: { Acme: { staging: [ent('nada')], production: [ent('prod')] }, Beta: { production: [ent('vacio')] } } });
  gh(m, {
    environments: { 'org/app': ['prod', 'vacio'] },
    deployments: { 'org/app': [
      { id: 2, sha: 'bbbbbbb1111', environment: 'prod', created_at: '2026-10-14T00:00:00Z', statuses: [{ id: 20, state: 'success', created_at: '2026-10-14T01:00:00Z' }, { id: 21, state: 'failure', created_at: '2026-10-14T02:00:00Z' }] },
      { id: 1, sha: 'aaaaaaa0000', environment: 'prod', created_at: '2026-10-12T00:00:00Z', statuses: [{ id: 10, state: 'success', created_at: '2026-10-12T01:00:00Z' }] },
      { id: 3, sha: 'ccccccc2222', environment: 'prod', created_at: '2026-10-13T00:00:00Z', statuses: [{ id: 30, state: 'success', created_at: '2026-10-13T01:00:00Z' }] },
    ] },
    runs: { 'org/app': [{ id: 9, run_number: 77, status: 'waiting', created_at: '2026-10-15T03:00:00Z', head_branch: 'main', pending: ['prod'] }] },
  });
  assert.strictEqual(correr(m).status, 0);
  const f = foto(m);
  const a = f.productos.Acme;
  assert.strictEqual(a.pipelines.find((p) => p.entorno === 'staging').motivo, 'environment_no_existe');
  assert.strictEqual(a.produccion.estado, 'desplegado');
  assert.strictEqual(a.produccion.commit, 'ccccccc', 'el último con success, ordenado por created_at (el 2 terminó en failure)');
  assert.strictEqual(a.aprobacion.estado, 'pendiente');
  assert.strictEqual(a.aprobacion.vencida, 'no_medido');
  assert.strictEqual(a.aprobacion.motivo, 'github_no_distingue_vencida');
  assert.strictEqual(f.productos.Beta.produccion.estado, 'sin_despliegue_en_ventana');
});

test('T16 GitHub_MainDesdeElWorkflow', () => {
  const armar = (conclusiones) => {
    const m = mundo({ provider: 'github', deployments: { Acme: { staging: [{ repo: 'org/app', environment: 'stg', workflow: 'ci.yml' }] } } });
    gh(m, { environments: { 'org/app': ['stg'] }, default_branch: { 'org/app': 'main' },
      runs: { 'org/app': conclusiones.map((c, i) => ({ id: 100 + i, run_number: i, status: 'completed', conclusion: c, created_at: `2026-10-${String(15 - i).padStart(2, '0')}T00:00:00Z`, head_branch: 'main', workflow: 'ci.yml' })).reverse() } });
    correr(m);
    return foto(m).productos.Acme.main;
  };
  assert.strictEqual(armar(['cancelled', 'failure']), 'roto');
  assert.strictEqual(armar(['timed_out']), 'roto');
  assert.strictEqual(armar(['neutral']), 'con_avisos');
  assert.strictEqual(armar(['skipped', 'success']), 'verde');
  assert.strictEqual(armar([]), 'sin_corridas');
});

// ── el archivo ───────────────────────────────────────────────────────────────────────────────────

function nocheCompleta() {
  const m = mundo({ repos: [{ producto: 'Acme', ado: 'P/a' }, { producto: 'Beta', ado: 'P/b' }],
    deployments: { Acme: { staging: [az('Acme CI', ['S'])], production: [az('Acme Prod', ['P'])] }, Beta: { production: [az('Beta Prod', ['P'])] } } });
  const fuga = { ...aprob('completed', 'succeeded', '2026-10-14T04:00:00Z', '2026-10-14T04:30:00Z'), approver: { displayName: 'FUGA-APROBADOR', uniqueName: 'fuga@cliente-secreto.example' }, comment: 'FUGA-APROBADOR aprobó' };
  pipeline(m, { nombre: 'Acme CI', id: 1, runs: [{ run: corrida({ tags: ['desplegado'] }), records: [stage('S', 'succeeded', '2026-10-14T05:00:00Z', { issues: [{ message: 'falló https://host-secreto.example/x' }], log: { url: '/Users/x/a.cs' } })] }] });
  pipeline(m, { nombre: 'Acme Prod', id: 2, runs: [{ run: corrida(), records: [stage('P', 'succeeded', '2026-10-14T06:00:00Z', { log: { url: '/Users/x/a.cs' } }), fuga] }] });
  pipeline(m, { nombre: 'Beta Prod', id: 3, runs: [{ run: corrida(), records: [] }] });
  return m;
}

test('T17 Contrato_ClavesExactasYEscrituraAtomica', () => {
  const m = nocheCompleta();
  fx(m, 'builds-3.json', []);
  assert.strictEqual(correr(m, [], { TYCON_AZ_FAIL: 'builds:"3"' }).status, 0);
  const f = foto(m);
  assert.deepStrictEqual(Object.keys(f).sort(), ['avisos', 'fallas', 'generado', 'productos', 'proveedor', 'v', 'ventana']);
  assert.strictEqual(f.v, 1);
  const { MOTIVOS } = require(GUION);
  for (const p of Object.values(f.productos)) {
    assert.deepStrictEqual(Object.keys(p).sort(), ['aprobacion', 'estado', 'main', 'motivo', 'pipelines', 'produccion', 'produccion_atrasada', 'staging']);
    assert.ok(MOTIVOS.includes(p.motivo), p.motivo);
    if (p.aprobacion && p.aprobacion.motivo !== undefined) assert.ok(MOTIVOS.includes(p.aprobacion.motivo), p.aprobacion.motivo);
    for (const lado of [p.staging, p.produccion]) if (lado && lado.motivo !== undefined) assert.ok(MOTIVOS.includes(lado.motivo), lado.motivo);
    for (const e of p.pipelines) {
      assert.deepStrictEqual(Object.keys(e).sort(), ['detalle', 'entorno', 'estado', 'motivo', 'pipeline']);
      assert.ok(MOTIVOS.includes(e.motivo), e.motivo);
    }
  }
  for (const x of [...f.avisos, ...f.fallas]) assert.deepStrictEqual(Object.keys(x).sort(), ['codigo', 'pipeline', 'producto']);
  assert.ok(f.fallas.length >= 1);
  assert.deepStrictEqual(fs.readdirSync(m.out).filter((n) => n.includes('.tmp')), []);
});

test('T18 Fuga_SinAprobadorNiHostNiLog', () => {
  const m = nocheCompleta();
  correr(m);
  const t = fs.readFileSync(path.join(m.out, `deployments-${HOY}.json`), 'utf8');
  for (const x of ['FUGA-APROBADOR', 'fuga@cliente-secreto.example', 'host-secreto.example', '/Users/x/a.cs']) assert.ok(!t.includes(x), x);
  assert.strictEqual(JSON.parse(t).productos.Acme.produccion.estado, 'desplegado', 'control positivo: el despliegue se lee');
});

test('T19 Azure_SinPermisoONoJson_NoEsSinDespliegue', () => {
  const armar = (env) => {
    const m = mundo({ deployments: { Acme: { staging: [az('Acme CI', ['S'])], production: [az('Acme Prod', ['P'])] } } });
    pipeline(m, { nombre: 'Acme CI', id: 1, runs: [{ run: corrida(), records: [stage('S', 'succeeded', '2026-10-14T05:00:00Z')] }] });
    pipeline(m, { nombre: 'Acme Prod', id: 2, runs: [{ run: corrida(), records: [] }] });
    const r = correr(m, [], env);
    assert.strictEqual(r.status, 0, r.stderr);
    return { r, p: foto(m).productos.Acme };
  };
  const a = armar({ TYCON_AZ_FAIL: 'timeline' });
  assert.ok(a.p.pipelines.every((e) => e.motivo === 'az_fallo'));
  assert.strictEqual(a.p.estado, 'no_medido');
  assert.notStrictEqual(a.p.produccion.estado, 'sin_despliegue_en_ventana');
  assert.notStrictEqual(a.p.main, 'verde');

  const b = armar({ TYCON_AZ_GARBAGE: 'builds:"2"' });
  assert.strictEqual(b.p.estado, 'parcial');
  assert.strictEqual(b.p.pipelines.find((e) => e.entorno === 'production').motivo, 'respuesta_no_json');
  assert.strictEqual(b.p.produccion.estado, 'no_medido');

  // un 403 con la identidad, una dirección y un correo: el detalle sale saneado
  const m = mundo({ deployments: { Acme: { production: [az('Acme Prod', ['P'])] } } });
  const dobleMalo = path.join(m.d, 'az403');
  // armado por partes: el texto de Azure con una identidad, una dirección y un correo de mentira
  const msg = [
    'ERROR: TF400813: The user ',
    "'Acme\\\\",
    ['0f8e1c2a', '1234', '4abc', '9def', '0123456789ab'].join('-'),
    "'",
    ' is not authorized to access this resource. Ver ',
    'https://host-secreto.example/x', ' o escribir a ', 'quien', '@', 'cliente-secreto.example'].join('');
  fs.writeFileSync(dobleMalo, ['#!/bin/sh', `echo "${msg}" >&2`, 'exit 1', ''].join('\n'));
  fs.chmodSync(dobleMalo, 0o755);
  const r = correr(m, [], { TYCON_ADO_CMD: dobleMalo, TF_BUILD: 'True' });
  assert.strictEqual(r.status, 0);
  const e = foto(m).productos.Acme.pipelines[0];
  assert.strictEqual(e.motivo, 'sin_permiso');
  for (const x of ['0f8e1c2a', 'Acme\\', 'host-secreto', 'cliente-secreto']) assert.ok(!e.detalle.includes(x), `${x} en ${e.detalle}`);
  assert.ok(e.detalle.length <= 200);
  assert.match(r.stdout, /##vso\[task\.logissue type=warning\]/);
});

test('T20 ExitCodes_ArgumentosEscrituraConfig', () => {
  const m = mundo();
  assert.strictEqual(spawnSync(process.execPath, [GUION, '--today', 'ayer', '--out', m.out, '--repos', m.repos, '--operations', m.ops, '--org', ORG], { encoding: 'utf8' }).status, 1);
  const bloqueado = path.join(m.d, 'archivo');
  fs.writeFileSync(bloqueado, 'x');
  assert.strictEqual(correr(m, ['--out', path.join(bloqueado, 'sub')]).status, 2);
  const mal = mundo();
  fs.writeFileSync(mal.ops, JSON.stringify({ version: 1, owners: { default: 'a@b.example' }, deployments: { provider: 'gitlab', products: {} } }));
  const r = correr(mal);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /deployments\.provider/);
  const sin = mundo({ operations: false });
  assert.strictEqual(correr(sin).status, 0);
  const p = foto(sin).productos.Acme;
  assert.strictEqual(p.motivo, 'sin_declarar');
  assert.match(p.pipelines[0].detalle, /no está/);
});

test('T27 Resumen_AlRegistroSinDetalle', () => {
  const m = mundo({ repos: [{ producto: 'Acme', ado: 'P/a' }, { producto: 'Beta', ado: 'P/b' }],
    deployments: { Acme: { production: [az('Acme Prod', ['P'])] }, Beta: { production: [az('Beta Prod', ['P'])] } } });
  const run = corrida();
  pipeline(m, { nombre: 'Acme Prod', id: 2, runs: [{ run, records: [stage('P', 'succeeded', '2026-10-14T06:00:00Z')] }] });
  pipeline(m, { nombre: 'Beta Prod', id: 3, runs: [{ run: corrida(), records: [] }] });
  const r = correr(m, [], { TYCON_AZ_FAIL: 'timeline:buildId=' + (run.id + 1) });
  const lineas = r.stdout.split('\n').filter((l) => l.startsWith('deployments:'));
  assert.ok(lineas.some((l) => l.includes('Acme') && l.includes('medido') && l.includes(run.buildNumber) && l.includes(run.sourceVersion.slice(0, 7))), r.stdout);
  assert.ok(lineas.some((l) => l.includes('Beta') && l.includes('az_fallo')), r.stdout);
  assert.ok(!r.stdout.includes('falla fabricada'), 'nunca el detalle');
});

// ── el tablero y el registro ─────────────────────────────────────────────────────────────────────

test('T22 Tablero_FichaDesplieguesDeLaFoto', () => {
  const { fichaDespliegues } = require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'dashboard.js'));
  const p = (atrasada, aprob = 'ninguna') => ({ estado: 'medido', motivo: 'ok', produccion_atrasada: atrasada, aprobacion: { estado: aprob } });
  const hoy = { generado: `${HOY}T08:30:00Z`, productos: { A: p(false), B: p(false), C: p(true, 'vencida'), D: { estado: 'no_medido', motivo: 'sin_declarar' } } };
  const f = fichaDespliegues(hoy, HOY);
  assert.strictEqual(f.estado, 'medido');
  assert.strictEqual(f.valor, 2);
  assert.strictEqual(f.total, 3, 'sobre los productos medidos: D no cuenta');
  assert.match(f.detalle, /C/);
  assert.match(f.detalle, /1 aprobaci/);
  const vieja = fichaDespliegues({ ...hoy, generado: '2026-10-12T08:30:00Z' }, HOY);
  assert.strictEqual(vieja.estado, 'no_medido'); assert.ok(vieja.motivo);
  const sin = fichaDespliegues(null, HOY);
  assert.strictEqual(sin.estado, 'no_medido'); assert.ok(sin.motivo);
  assert.notStrictEqual(sin.valor, 0);
  const ninguno = fichaDespliegues({ generado: `${HOY}T08:30:00Z`, productos: { D: { estado: 'no_medido', motivo: 'sin_declarar' } } }, HOY);
  assert.strictEqual(ninguno.estado, 'no_medido'); assert.ok(ninguno.motivo);
  for (const f2 of [path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'sources.json'), path.join(ROOT, 'pipelines', 'operations', 'examples', 'sources.json')]) {
    const j = JSON.parse(fs.readFileSync(f2, 'utf8'));
    const src = j.sources.find((s) => s.id === 'deployments');
    assert.ok(src, f2);
    assert.deepStrictEqual([src.required, src.max_age_days, src.dir], [false, 2, 'deployments'], f2);
    const dora = j.not_measurable_today.find((x) => /DORA/.test(x.what));
    assert.match(dora.reason, /2\.11/, `${f2}: la frecuencia y el tiempo de código a producción son de la 2.11`);
  }
  // los productos que no se pudieron comparar se dicen, no desaparecen del detalle
  assert.match(f.detalle, /1 producto sin comparar/);
  // y la ficha llega a la página: el título nuevo, nunca la ficha vieja de «no consulta la API»
  const html = fs.readFileSync(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'dashboard.js'), 'utf8');
  assert.match(html, /E\.despliegues/);
  assert.doesNotMatch(html, /el arnés no consulta la API de compilaciones de Azure DevOps/);
});

test('T28 Registro_SuiteYPiezas', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'suites.json'), 'utf8');
  assert.match(s, /"tests\/nightly-deployments\.test\.js"/);
  const g = fs.readFileSync(path.join(ROOT, 'guides', 'piezas-del-arnes.md'), 'utf8');
  assert.match(g, /deployments\.js/);
  assert.match(g, /nightly-deployments/);
});

// ── casos de borde de los revisores ──────────────────────────────────────────────────────────────────────────────

test('R1 Revisores_NumeroDeCorridaSinTextoLibre_ResultadoDesconocidoNoEsRoto', () => {
  const m = mundo({ deployments: { Acme: { staging: [az('Acme CI', ['S'])], production: [az('Acme Prod', ['P'])] } } });
  pipeline(m, { nombre: 'Acme CI', id: 1, runs: [{ run: corrida({ buildNumber: 'pedido por Persona Secreta 1', result: 'algoNuevo' }), records: [stage('S', 'succeeded', '2026-10-14T05:00:00Z')] }] });
  pipeline(m, { nombre: 'Acme Prod', id: 2, runs: [{ run: corrida({ buildNumber: '20261014.3' }), records: [stage('P', 'succeeded', '2026-10-14T06:00:00Z')] }] });
  correr(m);
  const t = fs.readFileSync(path.join(m.out, `deployments-${HOY}.json`), 'utf8');
  assert.ok(!t.includes('Persona Secreta'), 'el nombre de la corrida no viaja');
  const p = JSON.parse(t).productos.Acme;
  assert.strictEqual(p.staging.corrida, null);
  assert.strictEqual(p.produccion.corrida, '20261014.3', 'control positivo');
  assert.strictEqual(p.main, 'no_medido', 'un resultado fuera de la lista no se inventa como roto ni verde');
});

test('R2 Revisores_ReposJsonIlegible_EsUnaFalla', () => {
  const m = mundo({ deployments: { Acme: { production: [az('Acme Prod', ['P'])] } } });
  fs.writeFileSync(m.repos, '{ esto no es json');
  pipeline(m, { nombre: 'Acme Prod', id: 2, runs: [] });
  assert.strictEqual(correr(m).status, 0);
  const f = foto(m);
  assert.ok(f.fallas.some((x) => x.codigo === 'repos_json_ilegible'), JSON.stringify(f.fallas));
  assert.deepStrictEqual(f.avisos, [], 'sin repos.json no se inventa «no está en repos.json» para cada producto');
});

test('R3 Revisores_ProductoSinEntradas_NoTiraLaFoto', () => {
  const { armarProducto } = require(GUION);
  const p = armarProducto([], { staging: false, production: false });
  assert.strictEqual(p.estado, 'no_medido');
  assert.strictEqual(p.motivo, 'sin_declarar');
});

test('R4 Revisores_GitHubRepoConPuntos_NoSaleDeSuRuta', () => {
  const m = mundo({ provider: 'github' });
  const log = path.join(m.d, 'gh.log');
  // stable-data: el reloj sólo arma un tope de tiempo generoso para la llamada; ningún dato de la prueba depende de la fecha
  const github = require(path.join(DIR, 'github.js')).crear({ cmd: path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-gh.js'), deadline: Date.now() + 60000 });
  process.env.FAKE_GH_STATE = m.gh; process.env.FAKE_GH_LOG = log;
  try {
    assert.throws(() => github.leer({ repo: '../..', environment: 'prod' }, 'production'), (e) => e.noMedido);
  } finally { delete process.env.FAKE_GH_STATE; delete process.env.FAKE_GH_LOG; }
  assert.ok(!fs.existsSync(log), 'gh no se llamó: la ruta nunca se armó');
});

// ── casos de borde (una prueba por clase) ────────────────────────────────────────────────────────────────────────

test('A1 Adversarial_VencidasDeUnProductoSinDespliegue_SeCuentanConSusCuantas', () => {
  const { fichaDespliegues } = require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'dashboard.js'));
  const f = fichaDespliegues({ generado: `${HOY}T08:30:00Z`, productos: {
    A: { estado: 'medido', motivo: 'ok', produccion_atrasada: null, aprobacion: { estado: 'vencida', cuantas: 3 } },
    B: { estado: 'medido', motivo: 'ok', produccion_atrasada: false, aprobacion: { estado: 'ninguna' } },
  } }, HOY);
  assert.match(f.detalle, /3 aprobaciones vencidas/);
  assert.doesNotMatch(f.detalle, /aprobaciónes/);
});

test('A2 Adversarial_PendienteEnUnaCorridaMasViejaQueElDespliegue', () => {
  const m = mundo({ deployments: { Acme: { production: [az('Acme Prod', ['P'])] } } });
  pipeline(m, { nombre: 'Acme Prod', id: 2, runs: [
    { run: corrida(), records: [stage('P', 'succeeded', '2026-10-14T06:00:00Z')] },
    { run: corrida({ status: 'inProgress', result: null }), records: [aprob('inProgress', null, '2026-10-13T01:00:00Z', null)] },
  ] });
  correr(m);
  const a = foto(m).productos.Acme.aprobacion;
  assert.strictEqual(a.estado, 'pendiente');
  assert.strictEqual(a.desde, '2026-10-13T01:00:00Z');
});

test('A4 Adversarial_AprobacionDeOtroStageNoCuenta', () => {
  const m = mundo({ deployments: { Acme: { production: [az('Acme CI', ['P'])] } } });
  const sStg = { ...stage('Stg', 'skipped', '2026-10-14T05:00:00Z'), id: 's1' };
  const ck = { type: 'Checkpoint', id: 'c1', parentId: 's1', state: 'completed', result: 'skipped' };
  const ap = { ...aprob('completed', 'skipped', '2026-10-13T05:00:00Z', '2026-10-14T05:00:00Z'), id: 'a1', parentId: 'c1' };
  pipeline(m, { nombre: 'Acme CI', id: 2, runs: [{ run: corrida(), records: [sStg, ck, ap] }] });
  correr(m);
  assert.strictEqual(foto(m).productos.Acme.aprobacion.estado, 'ninguna', 'la aprobación vencida es del stage de staging, no de P');
  // control positivo: la misma cadena colgada de P sí cuenta
  const m2 = mundo({ deployments: { Acme: { production: [az('Acme CI', ['P'])] } } });
  pipeline(m2, { nombre: 'Acme CI', id: 2, runs: [{ run: corrida(), records: [{ ...stage('P', 'skipped', '2026-10-14T05:00:00Z'), id: 's1' }, ck, ap] }] });
  correr(m2);
  assert.strictEqual(foto(m2).productos.Acme.aprobacion.estado, 'vencida');
});

test('A5 Adversarial_GitHubPendienteSinDistinguirMayusculas', () => {
  const m = mundo({ provider: 'github', deployments: { Acme: { production: [{ repo: 'org/app', environment: 'Production' }] } } });
  gh(m, { environments: { 'org/app': ['Production'] }, deployments: { 'org/app': [] },
    runs: { 'org/app': [{ id: 9, run_number: 7, status: 'waiting', created_at: '2026-10-15T03:00:00Z', head_branch: 'main', pending: ['production'] }] } });
  correr(m);
  assert.strictEqual(foto(m).productos.Acme.aprobacion.estado, 'pendiente');
});

test('A6 Adversarial_CommitDelRecursoIlegible_NoTiraElDespliegue', () => {
  const m = mundo({ deployments: { Acme: { staging: [az('Acme CI', ['S'])], production: [az('Acme Prod', ['P'])] } } });
  pipeline(m, { nombre: 'Acme CI', id: 1, runs: [{ run: corrida(), records: [stage('S', 'succeeded', '2026-10-15T05:00:00Z')] }] });
  pipeline(m, { nombre: 'Acme Prod', id: 2, runs: [{ run: corrida({ triggerInfo: { pipelineId: '999999' } }), records: [stage('P', 'succeeded', '2026-10-14T05:00:00Z')] }] });
  correr(m);
  const p = foto(m).productos.Acme;
  assert.strictEqual(p.produccion.estado, 'desplegado');
  assert.strictEqual(p.produccion.commit_fuente, 'sourceVersion');
  assert.strictEqual(p.produccion_atrasada, null);
  assert.strictEqual(p.motivo, 'commit_no_leido', 'la causa real, no «promoción manual»');
});

test('A9 Adversarial_VariosPipelinesDeProduccion_LaCorridaMasNueva', () => {
  const m = mundo({ deployments: { Acme: { production: [az('Prod Uno', ['P']), az('Prod Dos', ['P'])] } } });
  const vieja = corrida({ queueTime: '2026-10-10T00:00:00Z' }), nueva = corrida({ queueTime: '2026-10-14T00:00:00Z' });
  pipeline(m, { nombre: 'Prod Uno', id: 2, runs: [{ run: vieja, records: [aprob('completed', 'skipped', '2026-10-09T00:00:00Z', '2026-10-10T00:00:00Z')] }] });
  pipeline(m, { nombre: 'Prod Dos', id: 3, runs: [{ run: nueva, records: [aprob('completed', 'skipped', '2026-10-13T00:00:00Z', '2026-10-14T00:00:00Z')] }] });
  // pipeline() pisa queueTime por posición: se reescriben a mano las de cada pipeline
  fx(m, 'builds-2.json', [{ ...vieja, queueTime: '2026-10-10T00:00:00Z' }]);
  fx(m, 'builds-3.json', [{ ...nueva, queueTime: '2026-10-14T00:00:00Z' }]);
  correr(m);
  const a = foto(m).productos.Acme.aprobacion;
  assert.strictEqual(a.estado, 'vencida');
  assert.strictEqual(a.cuantas, 2);
  assert.strictEqual(a.corrida, nueva.buildNumber);
  assert.ok(!('_fecha' in a), 'el campo interno no viaja');
});

// ── casos contra datos reales de Azure ───────────────────────────────────────────────────────────────────────────

test('V1 EnVivo_TimelineVacioDeUnaCorridaCancelada_NoEsNoJson', () => {
  const m = mundo({ deployments: { Acme: { staging: [az('Acme CI', ['S'])] } } });
  const cancelada = corrida({ result: 'canceled' });
  pipeline(m, { nombre: 'Acme CI', id: 1, runs: [{ run: cancelada, records: [] }, { run: corrida(), records: [stage('S', 'succeeded', '2026-10-13T05:00:00Z')] }] });
  fs.writeFileSync(path.join(m.fix, `timeline-${cancelada.id}.json`), '');
  correr(m);
  const p = foto(m).productos.Acme;
  assert.strictEqual(p.pipelines[0].motivo, 'ok', 'el timeline vacío es «sin registros», no «no JSON»');
  assert.strictEqual(p.staging.estado, 'desplegado');
  // y en cualquier otro pedido una salida vacía sigue siendo una falla
  const m2 = mundo({ deployments: { Acme: { staging: [az('Acme CI', ['S'])] } } });
  fx(m2, 'definiciones-Proy.json', [{ id: 1, name: 'Acme CI' }]);
  fs.writeFileSync(path.join(m2.d, 'az-vacio'), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(m2.d, 'az-vacio'), 0o755);
  correr(m2, [], { TYCON_ADO_CMD: path.join(m2.d, 'az-vacio') });
  assert.strictEqual(foto(m2).productos.Acme.pipelines[0].motivo, 'respuesta_no_json');
});
