'use strict';
// platform-estimate.test.js — la estimación vigente de la historia llega al pedido de trabajo: en Azure DevOps a un campo
// (el declarado, o el de horas o puntos por defecto), en GitHub al campo numérico de un proyecto o, sin proyecto o sin
// permiso, a un comentario de formato fijo. Sin estimación vigente no se toca nada. Y quien llama a la capa (el paso de
// activo del pipeline) la saca del registro de estimaciones del repo. Todo contra el az y el gh de laboratorio: ninguna
// prueba habla con Azure DevOps ni con GitHub.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'platform');
const P = () => require(path.join(LIB, 'platform.js'));
const WCFG = () => require(path.join(LIB, 'work-items-config.js'));
const E = () => require(path.join(ROOT, 'scripts', 'lib', 'estimates.js'));
const FLAGS = () => require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'external-flags.js'));
const ESTIMATES = path.join(ROOT, 'scripts', 'lib', 'estimates.js');
const FAKE_AZ = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-az.sh');
const FAKE_GH = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-gh.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

/** Un árbol con el perfil que elige `platform`, una casa vacía, el az y el gh de laboratorio, y el entorno que los apunta. */
function mundo({ platform, ghState = { user: 'arnes-bot', now: '2026-10-29T05:00:00Z', issues: {} } } = {}) {
  const tree = tmp('arbol-');
  const home = tmp('casa-');
  const fixaz = tmp('fixaz-');
  fs.writeFileSync(path.join(tree, 'team-profile.json'), JSON.stringify({ integrations: { platform } }));
  const ghFile = path.join(tmp('gh-'), 'estado.json');
  fs.writeFileSync(ghFile, JSON.stringify(ghState));
  const ghLog = path.join(tmp('ghlog-'), 'llamadas.log');
  const az = path.join(tmp('bin-'), 'az');
  fs.copyFileSync(FAKE_AZ, az);
  fs.chmodSync(az, 0o755);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_TREE: tree, TYCON_HOME: path.join(home, '.tycon'), TYCON_ADO_CMD: az, FIXAZ: fixaz,
    TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: ghFile, FAKE_GH_LOG: ghLog };
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_ORG|ADO_PROJECT|PLATFORM|PROFILE|INTEGRATIONS_DIR|AZ_FAIL|AZ_WITHOUT_SESSION)$|^GH_TOKEN$/.test(k)) delete env[k];
  return { fixaz, ghFile, ghLog, env };
}
function repoCon(texto) {
  const repo = tmp('historias-');
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.tycon', 'work-items.yaml'), texto);
  return repo;
}
const AZ_CONFIG = ['org: https://dev.azure.com/acme', 'project: Producto', 'type: "User Story"', ''].join('\n');
const GH_CONFIG = ['repo: acme/portal', 'type: "Historia"', 'state_active: "en curso"', ''].join('\n');
const CON_PROYECTO = `${GH_CONFIG}github:\n  project: { owner: acme, number: 3, field: "Estimación" }\n`;
const PROYECTO = { id: 'PVT_3', fields: [{ id: 'F_est', name: 'Estimación', dataType: 'NUMBER' }, { id: 'F_txt', name: 'Notas', dataType: 'TEXT' }] };
const DIECISEIS = { value: 16, unit: 'hours', hours: 16, level: 'historia', version: 2 };

/** Las llamadas que recibió el az de laboratorio: los argumentos de cada una. */
const llamadasAz = (m) => {
  const f = path.join(m.fixaz, 'llamadas.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l.split('\t')[1]).args) : [];
};
const llamadasGh = (m) => (fs.existsSync(m.ghLog) ? fs.readFileSync(m.ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const graphql = (m) => llamadasGh(m).filter((l) => l.ruta === 'graphql');
const estadoGh = (m) => JSON.parse(fs.readFileSync(m.ghFile, 'utf8'));
const conCampo = (args, campo) => args.some((a) => a.startsWith(`${campo}=`));
const issue = (number) => ({ number, state: 'open', title: `Story 3.${number}`, labels: ['tipo:Historia', 'estado:en curso'] });

test('T31 Azure_CampoPorDefectoYDeclarado @story-2.75 @ac-28', async () => {
  const m = mundo({ platform: { default: 'azure-devops' } });
  const repo = repoCon(AZ_CONFIG);
  const crear = async (estimate, env = m.env) => {
    const antes = llamadasAz(m).length;
    const r = await P().run('work-item.create', { repoDir: repo, title: 'Story 3.2: Algo', estimate }, { env });
    const nuevas = llamadasAz(m).slice(antes);
    // la estimación va en un update propio después de crear: `args` es esa llamada (o la de crear, si no hubo)
    const alta = nuevas.find((a) => a.includes('create'));
    return { r, alta, args: nuevas.find((a) => a.includes('update')) || alta };
  };
  // horas y días van a OriginalEstimate con las horas; puntos, a StoryPoints con el valor; en un update después de crear
  const h = await crear(DIECISEIS);
  assert.strictEqual(h.r.ok, true, JSON.stringify(h.r));
  assert.ok(h.args.includes('Microsoft.VSTS.Scheduling.OriginalEstimate=16'), h.args.join(' '));
  assert.strictEqual(conCampo(h.alta, 'Microsoft.VSTS.Scheduling.OriginalEstimate'), false, 'la creación no lleva la estimación');
  assert.ok(h.alta.filter((a) => a === '--fields').length <= 1, 'a lo sumo un --fields: az se queda con el último');
  assert.strictEqual(h.args.filter((a) => a === '--fields').length, 1, 'el update de la estimación, con un solo --fields');
  assert.deepStrictEqual([h.r.value.estimateAs, h.r.value.estimateField], ['field', 'Microsoft.VSTS.Scheduling.OriginalEstimate']);
  // un campo que el proceso no tiene: el pedido queda creado, la estimación no, y se avisa
  const sinCampo = await crear(DIECISEIS, { ...m.env, TYCON_AZ_FAIL: 'actualizar:OriginalEstimate' });
  assert.strictEqual(sinCampo.r.ok, true, JSON.stringify(sinCampo.r));
  assert.ok(Number.isInteger(sinCampo.r.value.id));
  assert.strictEqual(sinCampo.r.value.estimateAs, undefined);
  assert.match(sinCampo.r.value.warnings.join(' '), /la estimación no se cargó en el pedido/);
  assert.match(sinCampo.r.summary, /creado/);
  const d = await crear({ value: 6, unit: 'days', hours: 48, level: 'plan', version: 1 });
  assert.ok(d.args.includes('Microsoft.VSTS.Scheduling.OriginalEstimate=48'), d.args.join(' '));
  const p = await crear({ value: 5, unit: 'points', hours: null, level: 'historia', version: 1 });
  assert.ok(p.args.includes('Microsoft.VSTS.Scheduling.StoryPoints=5'), p.args.join(' '));
  assert.strictEqual(p.r.value.estimateField, 'Microsoft.VSTS.Scheduling.StoryPoints');
  // días sin las horas: no se adivina la tasa; se avisa y no se carga
  const s = await crear({ value: 6, unit: 'days', level: 'plan', version: 1 });
  assert.strictEqual(s.r.ok, true);
  assert.strictEqual(conCampo(s.args, 'Microsoft.VSTS.Scheduling.OriginalEstimate'), false);
  assert.strictEqual(s.r.value.estimateAs, undefined);
  assert.match(s.r.value.warnings.join(' '), /estimación.*sin las horas|sin las horas.*estimación/);

  // en update, un --fields propio: con cambio de estado, sin cambio y por el camino de sólo comentar
  const actualizar = async (id, extra) => {
    const antes = llamadasAz(m).length;
    const r = await P().run('work-item.update', { repoDir: repo, id, estimate: DIECISEIS, ...extra }, { env: m.env });
    return { r, nuevas: llamadasAz(m).slice(antes) };
  };
  fs.writeFileSync(path.join(m.fixaz, 'estado-31'), 'New');
  const u1 = await actualizar(31);
  assert.strictEqual(u1.r.value.changed, true, JSON.stringify(u1.r));
  assert.ok(u1.nuevas.some((a) => a.includes('--state')));
  const campo1 = u1.nuevas.filter((a) => a.includes('update') && conCampo(a, 'Microsoft.VSTS.Scheduling.OriginalEstimate'));
  assert.strictEqual(campo1.length, 1, 'un update propio con el campo');
  assert.strictEqual(campo1[0].includes('--state'), false, 'separado del cambio de estado');
  assert.strictEqual(u1.r.value.estimateAs, 'field');
  fs.writeFileSync(path.join(m.fixaz, 'estado-32'), 'Active');
  const u2 = await actualizar(32);
  assert.strictEqual(u2.r.value.changed, false);
  assert.strictEqual(u2.nuevas.filter((a) => conCampo(a, 'Microsoft.VSTS.Scheduling.OriginalEstimate')).length, 1);
  assert.strictEqual(u2.r.value.estimateAs, 'field');
  const u3 = await actualizar(33, { comment: 'arrancó la implementación' });
  assert.strictEqual(u3.r.value.commented, true);
  assert.ok(u3.nuevas.some((a) => a.includes('--discussion')));
  assert.strictEqual(u3.nuevas.filter((a) => conCampo(a, 'Microsoft.VSTS.Scheduling.OriginalEstimate')).length, 1);
  assert.strictEqual(u3.r.value.estimateAs, 'field');
  assert.match(u3.r.summary, /estimación.*OriginalEstimate/);
  // cerrado: no se reabre ni se carga, y se dice
  fs.writeFileSync(path.join(m.fixaz, 'estado-34'), 'Closed');
  const u4 = await actualizar(34);
  assert.strictEqual(u4.r.value.pideReabrir, true);
  assert.strictEqual(u4.nuevas.filter((a) => conCampo(a, 'Microsoft.VSTS.Scheduling.OriginalEstimate')).length, 0);
  assert.match(u4.r.value.warnings.join(' '), /estimación no se cargó: el pedido está cerrado/);

  // el campo declarado lleva el valor tal como se escribió
  const declarado = repoCon(`${AZ_CONFIG}fields: { estimate: Custom.Estimacion }\n`);
  const antes = llamadasAz(m).length;
  const c = await P().run('work-item.create', { repoDir: declarado, title: 'Story 3.3', estimate: { value: 6, unit: 'days', hours: 48 } }, { env: m.env });
  const args = llamadasAz(m).slice(antes).find((a) => a.includes('update'));
  assert.ok(args.includes('Custom.Estimacion=6'), args.join(' '));
  assert.strictEqual(conCampo(args, 'Microsoft.VSTS.Scheduling.OriginalEstimate'), false);
  assert.strictEqual(c.value.estimateField, 'Custom.Estimacion');
  // un declarado que no es un nombre de referencia es un problema del lector
  const malo = repoCon(`${AZ_CONFIG}fields: { estimate: "--org otra" }\n`);
  assert.match(WCFG().read(malo).problem, /fields\.estimate/);
  const r = await P().run('work-item.create', { repoDir: malo, title: 'x', estimate: DIECISEIS }, { env: m.env });
  assert.strictEqual(r.ok, false);
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', 'azure-devops', 'integration.json'), 'utf8'));
  assert.strictEqual(man.capabilities.estimate, 'field');
});

test('T32 GitHub_ProyectoOComentario @story-2.75 @ac-29', async () => {
  const m = mundo({ platform: { default: 'github' }, ghState: { user: 'arnes-bot', now: '2026-10-29T05:00:00Z', issues: { 'acme/portal': [issue(7)] }, projects: { 'acme#3': PROYECTO } } });
  const repo = repoCon(CON_PROYECTO);
  const c = await P().run('work-item.create', { repoDir: repo, title: 'Story 3.2: Algo', estimate: DIECISEIS }, { env: m.env });
  assert.strictEqual(c.ok, true, JSON.stringify(c));
  assert.deepStrictEqual([c.value.estimateAs, c.value.estimateField], ['project', 'Estimación']);
  // las tres llamadas GraphQL: el proyecto del dueño con sus campos, agregar el issue y cargar el número
  const q = graphql(m);
  assert.strictEqual(q.length, 3, JSON.stringify(q));
  assert.match(q[0].cuerpo.query, /repositoryOwner[\s\S]*projectV2\(number/);
  assert.deepStrictEqual([q[0].cuerpo.variables.owner, q[0].cuerpo.variables.number], ['acme', 3]);
  assert.match(q[1].cuerpo.query, /addProjectV2ItemById/);
  assert.strictEqual(q[1].cuerpo.variables.content, `I_acme/portal#${c.value.id}`);
  assert.match(q[2].cuerpo.query, /updateProjectV2ItemFieldValue/);
  assert.deepStrictEqual([q[2].cuerpo.variables.field, q[2].cuerpo.variables.value], ['F_est', 16]);
  assert.strictEqual(estadoGh(m).projects['acme#3'].items[`I_acme/portal#${c.value.id}`].values.F_est, 16);
  assert.strictEqual((estadoGh(m).comments || {})[`acme/portal#${c.value.id}`], undefined, 'con proyecto, sin comentario');
  // en update también (el issue ya está en el proyecto: agregarlo de nuevo no lo duplica)
  const u = await P().run('work-item.update', { repoDir: repo, id: 7, estimate: { ...DIECISEIS, value: 18, hours: 18, version: 3 } }, { env: m.env });
  assert.strictEqual(u.value.estimateAs, 'project', JSON.stringify(u));
  assert.strictEqual(estadoGh(m).projects['acme#3'].items['I_acme/portal#7'].values.F_est, 18);

  // sin declarar: el comentario de formato fijo; en update, la misma estimación no se comenta otra vez
  const m2 = mundo({ platform: { default: 'github' }, ghState: { user: 'arnes-bot', now: '2026-10-29T05:00:00Z', issues: { 'acme/portal': [issue(7)] } } });
  const sin = repoCon(GH_CONFIG);
  const c2 = await P().run('work-item.create', { repoDir: sin, title: 'Story 3.2: Algo', estimate: DIECISEIS }, { env: m2.env });
  assert.strictEqual(c2.value.estimateAs, 'comment', JSON.stringify(c2));
  assert.deepStrictEqual(estadoGh(m2).comments[`acme/portal#${c2.value.id}`].map((x) => x.body), ['Estimación: 16 h (historia, versión 2)']);
  assert.strictEqual(graphql(m2).length, 0, 'sin proyecto no hay GraphQL');
  const u1 = await P().run('work-item.update', { repoDir: sin, id: 7, estimate: DIECISEIS }, { env: m2.env });
  assert.strictEqual(u1.value.estimateAs, 'comment');
  const u2 = await P().run('work-item.update', { repoDir: sin, id: 7, estimate: DIECISEIS, comment: 'sigue' }, { env: m2.env });
  assert.deepStrictEqual([u2.value.estimateAs, u2.value.estimateUnchanged], ['comment', true]);
  assert.deepStrictEqual(estadoGh(m2).comments['acme/portal#7'].map((x) => x.body), ['Estimación: 16 h (historia, versión 2)', 'sigue']);
  const u3 = await P().run('work-item.update', { repoDir: sin, id: 7, estimate: { value: 5, unit: 'points', level: 'historia', version: 3 } }, { env: m2.env });
  assert.strictEqual(u3.value.estimateUnchanged, undefined);
  assert.strictEqual(estadoGh(m2).comments['acme/portal#7'].slice(-1)[0].body, 'Estimación: 5 puntos (historia, versión 3)');
  await P().run('work-item.update', { repoDir: sin, id: 7, estimate: { value: 2, unit: 'days', hours: 12, level: 'plan', version: 1 } }, { env: m2.env });
  assert.strictEqual(estadoGh(m2).comments['acme/portal#7'].slice(-1)[0].body, 'Estimación: 2 días (plan, versión 1)');

  // la clave sin `field`: problema del lector con su ruta
  const roto = repoCon(`${GH_CONFIG}github:\n  project: { owner: acme, number: 3 }\n`);
  assert.match(WCFG().read(roto).problem, /github\.project\.field/);
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', 'github', 'integration.json'), 'utf8'));
  assert.strictEqual(man.capabilities.estimate, 'project-or-comment');
});

test('T33 GitHub_SinPermiso_Comentario @story-2.75 @ac-30', async () => {
  const sinPermiso = { type: 'INSUFFICIENT_SCOPES', message: "Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project']" };
  const casos = [
    ['sin_credencial', { graphql_error: sinPermiso, projects: { 'acme#3': PROYECTO } }],
    ['no_encontrado', { projects: { 'acme#3': { id: 'PVT_3', fields: [{ id: 'F_txt', name: 'Notas', dataType: 'TEXT' }] } } }],
    ['no_encontrado', { projects: { 'acme#9': PROYECTO } }],
    // el campo existe pero no es numérico
    ['no_encontrado', { projects: { 'acme#3': { id: 'PVT_3', fields: [{ id: 'F_est', name: 'Estimación', dataType: 'TEXT' }] } } }],
  ];
  for (const [motivo, extra] of casos) {
    const m = mundo({ platform: { default: 'github' }, ghState: { user: 'arnes-bot', now: '2026-10-29T05:00:00Z', issues: {}, ...extra } });
    const repo = repoCon(CON_PROYECTO);
    const c = await P().run('work-item.create', { repoDir: repo, title: 'Story 3.2: Algo', estimate: DIECISEIS }, { env: m.env });
    assert.strictEqual(c.ok, true, `${motivo}: el pedido igual se crea — ${JSON.stringify(c)}`);
    assert.strictEqual(c.value.estimateAs, 'comment');
    assert.strictEqual(c.value.estimateFallback.reason, motivo, JSON.stringify(c.value.estimateFallback));
    assert.ok(c.value.estimateFallback.detail);
    assert.deepStrictEqual(estadoGh(m).comments[`acme/portal#${c.value.id}`].map((x) => x.body), ['Estimación: 16 h (historia, versión 2)']);
    assert.strictEqual(c.summary.split('\n').length, 1);
    assert.match(c.summary, motivo === 'sin_credencial' ? /estimación.*comentario.*permiso/ : /estimación.*comentario.*no (se )?encontr/);
  }

  // el detalle de gh pasa por la misma limpieza que un «no»: ni direcciones ni credenciales
  const conDireccion = { ...sinPermiso, message: `${sinPermiso.message} — ver https://github.com/settings/tokens con Bearer ${'ghp_' + 'abcdefghijklmnop1234'}` };
  const ml = mundo({ platform: { default: 'github' }, ghState: { user: 'arnes-bot', now: '2026-10-29T05:00:00Z', issues: {}, graphql_error: conDireccion, projects: { 'acme#3': PROYECTO } } });
  const limpio = await P().run('work-item.create', { repoDir: repoCon(CON_PROYECTO), title: 'Story 3.2', estimate: DIECISEIS }, { env: ml.env });
  assert.doesNotMatch(limpio.value.estimateFallback.detail, /https:|ghp_/, limpio.value.estimateFallback.detail);

  // sólo comentar, y el issue no se puede leer: el motivo es el de gh, y sin poder leer los comentarios se avisa
  const roto = { 'GET repos/acme/portal/issues/7': { status: 500, message: 'servidor caído' } };
  const mr = mundo({ platform: { default: 'github' }, ghState: { user: 'arnes-bot', now: '2026-10-29T05:00:00Z', issues: { 'acme/portal': [issue(7)] }, projects: { 'acme#3': PROYECTO }, fail: roto } });
  const sc = await P().run('work-item.update', { repoDir: repoCon(CON_PROYECTO), id: 7, estimate: DIECISEIS, comment: 'sigue' }, { env: mr.env });
  assert.strictEqual(sc.ok, true, JSON.stringify(sc));
  assert.match(sc.value.estimateFallback.detail, /no pude leer el issue.*servidor caído/);
  assert.notStrictEqual(sc.value.estimateFallback.reason, 'no_encontrado');
  assert.match(sc.value.warnings.join(' '), /no pude leer los comentarios.*sin comprobar/);
  assert.strictEqual(sc.value.estimateAs, 'comment');

  // el comentario tampoco sale: el resumen no dice «como comentario»
  const sinComentar = { 'POST repos/acme/portal/issues/7/comments': { status: 500, message: 'no se pudo' } };
  const mc = mundo({ platform: { default: 'github' }, ghState: { user: 'arnes-bot', now: '2026-10-29T05:00:00Z', issues: { 'acme/portal': [issue(7)] }, projects: {}, fail: sinComentar } });
  const nc = await P().run('work-item.update', { repoDir: repoCon(CON_PROYECTO), id: 7, estimate: DIECISEIS }, { env: mc.env });
  assert.strictEqual(nc.ok, true, JSON.stringify(nc));
  assert.strictEqual(nc.value.estimateAs, undefined);
  assert.match(nc.summary, /estimación sin cargar/);
  assert.doesNotMatch(nc.summary, /estimación como comentario/);

  // el issue cerrado no se toca, y se dice que la estimación no se cargó
  const cerrado = { ...issue(8), state: 'closed' };
  const mz = mundo({ platform: { default: 'github' }, ghState: { user: 'arnes-bot', now: '2026-10-29T05:00:00Z', issues: { 'acme/portal': [cerrado] } } });
  const z = await P().run('work-item.update', { repoDir: repoCon(GH_CONFIG), id: 8, estimate: DIECISEIS }, { env: mz.env });
  assert.strictEqual(z.value.pideReabrir, true);
  assert.match(z.value.warnings.join(' '), /estimación no se cargó: el issue está cerrado/);
});

test('T34 SinEstimacion_NoToca @story-2.75 @ac-31', async () => {
  const a = mundo({ platform: { default: 'azure-devops' } });
  const repoA = repoCon(AZ_CONFIG);
  const ca = await P().run('work-item.create', { repoDir: repoA, title: 'Story 3.4' }, { env: a.env });
  fs.writeFileSync(path.join(a.fixaz, 'estado-41'), 'New');
  const ua = await P().run('work-item.update', { repoDir: repoA, id: 41 }, { env: a.env });
  for (const args of llamadasAz(a)) assert.strictEqual(args.some((x) => /OriginalEstimate|StoryPoints/.test(x)), false, args.join(' '));
  assert.strictEqual(llamadasAz(a).filter((x) => x.includes('update')).length, 1, 'sólo el cambio de estado');
  const g = mundo({ platform: { default: 'github' }, ghState: { user: 'arnes-bot', now: '2026-10-29T05:00:00Z', issues: { 'acme/portal': [issue(7)] }, projects: { 'acme#3': PROYECTO } } });
  const repoG = repoCon(CON_PROYECTO);
  const cg = await P().run('work-item.create', { repoDir: repoG, title: 'Story 3.4' }, { env: g.env });
  const ug = await P().run('work-item.update', { repoDir: repoG, id: 7 }, { env: g.env });
  assert.strictEqual(graphql(g).length, 0);
  assert.strictEqual(estadoGh(g).comments, undefined, 'ningún comentario');
  for (const r of [ca, ua, cg, ug]) {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.value.estimateAs, undefined);
    assert.strictEqual(r.value.estimateFallback, undefined);
    assert.deepStrictEqual(r.value.warnings, []);
    assert.doesNotMatch(r.summary, /estimaci/);
  }
});

/** Un `team-repos.json` de laboratorio con la tasa de días de la organización. */
function orgConfig(estimates) {
  const f = path.join(tmp('org-'), 'team-repos.json');
  fs.writeFileSync(f, JSON.stringify({
    version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' }, profile: { platform: 'github', org: 'acme', repo: 'harness-profile' },
    operations: { platform: 'github', org: 'acme', repo: 'harness-ops' }, estimates,
  }));
  return f;
}
/** Un repo de historias con su registro: una historia con plan y dos versiones de historia, otra sólo con plan en días. */
function repoConRegistro() {
  const repo = tmp('registro-');
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  const l = (o) => JSON.stringify(E().linea({ epica: '3', quien: null, cuando: '2026-10-29T00:00:00Z', ...o }));
  fs.writeFileSync(path.join(repo, '.tycon', 'estimates.jsonl'), [
    l({ nivel: 'plan', historia: '3.2', valor: 12, unidad: 'hours' }),
    l({ nivel: 'historia', historia: '3.2', valor: 14, unidad: 'hours' }),
    l({ nivel: 'plan', historia: '3.3', valor: 2, unidad: 'days' }),
    l({ nivel: 'historia', historia: '3.2', valor: 16, unidad: 'hours' }),
    '',
  ].join('\n'));
  return repo;
}

test('T44 Llamador_MandaLaVigente @story-2.75 @ac-38', () => {
  const repo = repoConRegistro();
  const org = orgConfig({ hours_per_day: 6 });
  // la vigente: la última historia; si no hay, el último plan; sin líneas, null
  assert.deepStrictEqual(E().run(['work-item', '--repo', repo, '--story', '3.2', '--org-config', org]),
    { ok: true, estimate: { value: 16, unit: 'hours', hours: 16, level: 'historia', version: 2 } });
  assert.deepStrictEqual(E().run(['work-item', '--repo', repo, '--story', '3.3', '--org-config', org]),
    { ok: true, estimate: { value: 2, unit: 'days', hours: 12, level: 'plan', version: 1 } });
  assert.deepStrictEqual(E().run(['work-item', '--repo', repo, '--story', '3.4', '--org-config', org]), { ok: true, estimate: null });
  // una configuración que no se lee no frena: null con el motivo
  const roto = E().run(['work-item', '--repo', repo, '--story', '3.2', '--org-config', path.join(tmp('nada-'), 'team-repos.json')]);
  assert.strictEqual(roto.ok, true);
  assert.strictEqual(roto.estimate, null);
  assert.match(roto.motivo, /configuración/);
  // por la línea de comandos, lo mismo y sale 0
  const cli = spawnSync(process.execPath, [ESTIMATES, 'work-item', '--repo', repo, '--story', '3.2', '--org-config', org, '--json'], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.deepStrictEqual(JSON.parse(cli.stdout).estimate.value, 16);

  // el paso de activo la manda en el update, y no la manda sin vigente
  const lab = tmp('capa-');
  const capa = path.join(lab, 'platform.js');
  const log = path.join(lab, 'args.log');
  fs.writeFileSync(capa, [
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(JSON.parse(process.argv[process.argv.indexOf('--args') + 1])) + '\\n');`,
    "process.stdout.write(JSON.stringify({ ok: true, value: { id: 7, estado: 'Active', previo: 'New', changed: true }, summary: 'pedido de trabajo #7: New → Active' }) + '\\n');",
  ].join('\n'));
  const marcar = (storyId, orgCfg = org) => FLAGS().adoMarkActive({ workItem: 7, repoDir: repo, storyId, platformJs: capa, estimatesJs: ESTIMATES, orgConfig: orgCfg });
  const enviados = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(marcar('3.2').marked, true);
  assert.deepStrictEqual(enviados()[0].estimate, { value: 16, unit: 'hours', hours: 16, level: 'historia', version: 2 });
  assert.strictEqual(marcar('3.4').marked, true);
  assert.strictEqual('estimate' in enviados()[1], false, 'sin vigente no se manda');
  const sinOrg = marcar('3.2', path.join(tmp('nada-'), 'team-repos.json'));
  assert.strictEqual(sinOrg.marked, true, 'no poder leer la estimación no frena el paso');
  assert.strictEqual('estimate' in enviados()[2], false);
  assert.match(sinOrg.line, /estimación: no se mandó/);
  // sin el número de la historia, el motivo llega a la línea; y también cuando la capa dice que no
  const sinId = FLAGS().adoMarkActive({ workItem: 7, repoDir: repo, storyId: null, estimateMotivo: 'la historia no trae `story:` en su frontmatter', platformJs: capa });
  assert.strictEqual(sinId.marked, true);
  assert.match(sinId.line, /estimación: no se mandó \(la historia no trae `story:`/);
  const capaNo = path.join(lab, 'no.js');
  fs.writeFileSync(capaNo, "process.stdout.write(JSON.stringify({ ok: false, reason: 'red', detail: 'caída', summary: 'pedido de trabajo: no se tocó — caída' }) + '\\n');");
  const falla = FLAGS().adoMarkActive({ workItem: 7, repoDir: repo, storyId: '3.2', platformJs: capaNo, estimatesJs: ESTIMATES, orgConfig: path.join(tmp('nada-'), 'team-repos.json') });
  assert.strictEqual(falla.code, 1);
  assert.match(falla.line, /no se tocó.*estimación: no se mandó/);
  // un registro con una línea ilegible: se manda lo que se lee y se dice
  const sucio = repoConRegistro();
  fs.appendFileSync(path.join(sucio, '.tycon', 'estimates.jsonl'), '{esto no es json\n');
  const conRoto = E().run(['work-item', '--repo', sucio, '--story', '3.2', '--org-config', org]);
  assert.strictEqual(conRoto.estimate.value, 16);
  assert.match(conRoto.motivo, /1 línea\(s\) ilegible\(s\)/);
  const avisado = FLAGS().adoMarkActive({ workItem: 7, repoDir: sucio, storyId: '3.2', platformJs: capa, estimatesJs: ESTIMATES, orgConfig: org });
  assert.match(avisado.line, /estimación: se mandó con aviso \(el registro tiene 1 línea/);
  // el paso de crear de la skill nombra el comando
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'tycon-story-work-item', 'SKILL.md'), 'utf8');
  assert.match(skill, /estimates\.js work-item --repo <repo> --story <story> --json/);
  assert.match(skill, /"estimate"/);
});
