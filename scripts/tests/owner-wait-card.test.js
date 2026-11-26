#!/usr/bin/env node
'use strict';
// owner-wait-card.test.js — la ficha de lo que espera al dueño (su riesgo, su pedido y la acción propuesta) y los tres
// grupos de esperas de la oficina: al dueño, a main y a otra sesión.
// Nada mira la HOME real: las corridas son de juguete, en carpetas temporales.
// stable-data: las fechas van por argumento; la única hora real es la de la sesión de juguete, que marker.js anota al momento.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CARD = require(path.join(ROOT, 'scripts', 'lib', 'owner-wait-card.js'));
const MARKER = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const { buildOffice, buildBoard, ownerWaitsOf, page } = require(path.join(ROOT, 'scripts', 'tools', 'office.js'));
const { buildWip } = require(path.join(ROOT, 'scripts', 'tools', 'work-in-progress.js'));
const { pick } = require(path.join(ROOT, 'scripts', 'tools', 'office', 'fields.js'));

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const PLAN_COMMON = '## Qué hace\nAlgo.\n\n## Archivos\n\n- docs/a.md\n';
const PLAN_CONTROL = `${PLAN_COMMON}- skills/tycon-pipeline/scripts/marker.js\n`;

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Una corrida de juguete: un repo con su historia y, si se pasa, el plan escrito en la carpeta de la corrida. */
function toyRun(t, { front = '', plan = PLAN_COMMON, ...fields } = {}) {
  const repo = tmp(t, 'owner-card-');
  execFileSync('git', ['-c', 'maintenance.auto=false', 'init', '-q', repo]);
  const storyPath = path.join(repo, 'story-9.1-algo.md');
  fs.writeFileSync(storyPath, `---\nstory: "9.1"\ntitle: "Algo"\n${front}files_to_modify:\n  - docs/a.md\n---\n# Story\n`);
  const runDir = path.join(repo, '.advisors', 'pipeline-runs', '9.1-1');
  fs.mkdirSync(runDir, { recursive: true });
  if (plan !== null) fs.writeFileSync(path.join(runDir, 'step-02-bmad-plan.md'), plan);
  return { storyId: '9.1', storyPath, repoPath: repo, runDir, ...fields };
}

const toyWip = (entries, more = {}) => ({
  rows: entries.map((e) => ({ work: e.work || `Trabajo de ${e.session}`, state: e.state || 'en curso', end: '15:00', session: e.session, folder: 'repo' })),
  details: entries.map((e) => ({ sid: e.sid || `sid-${e.session}`, status: e.status || 'busy', statusAt: null })),
  extra: entries.map((e) => e.extra || { kind: 'loose' }),
  free: [], halfway: [], unreadable: [],
  ...more,
});
const waiting = (session, waitingFor, more = {}) => ({ session, extra: { kind: 'note', text: 'una nota', waitingFor, waitingSince: NOW - 60000, ...more } });
const firmaColumn = (data) => data.kanban.columnas.find((c) => c.id === 'firma').tarjetas;
const stubCard = ({ row }) => ({ riesgo: 'delicada', pedido: '#12', accion: `acción de ${row.origen}`, linea: `delicada · acción de ${row.origen}` });

test('OW1 Card_RiskPrAction @story-8.293 @ac-9', (t) => {
  // delicada por la historia, y de rutina en la historia pero delicada porque su plan nombra un control
  const byStory = toyRun(t, { front: 'sensible: "plata"\n', pr: { number: 12, merged: false } });
  const byPlan = toyRun(t, { plan: PLAN_CONTROL });
  const common = toyRun(t);
  const row = { origen: 'plan', quien: 'Ana' };
  const first = CARD.card({ row, marker: byStory });
  assert.strictEqual(first.riesgo, 'delicada');
  assert.strictEqual(first.pedido, '#12');
  assert.strictEqual(first.linea, 'delicada · aprobar el plan de la sesión Ana');
  assert.strictEqual(CARD.card({ row, marker: byPlan }).riesgo, 'delicada', 'el plan cuenta para la clase');
  assert.strictEqual(CARD.card({ row, marker: common }).riesgo, 'de rutina');
  assert.strictEqual('pedido' in CARD.card({ row, marker: common }), false);

  const expected = {
    lista: 'contestar la firma que trae la coordinadora',
    plan: 'aprobar el plan de la sesión Ana',
    guardar: 'dar el ok de guardar en la sesión Ana',
    cuadro: 'contestar el cuadro en la sesión Ana',
    pregunta: 'contestar la pregunta en la sesión Ana',
    medio: 'decidir si se retoma la sesión Ana: está cerrada',
    tablero: 'preguntarle a la coordinadora: la anotó ella',
  };
  for (const [origen, accion] of Object.entries(expected)) {
    const c = CARD.card({ row: { origen, quien: 'Ana' }, marker: null });
    assert.strictEqual(c.accion, accion, origen);
    assert.doesNotMatch(c.accion, /node |owner-next|\.js/, 'la acción no trae comando');
    assert.strictEqual('comando' in c, false);
  }
});

test('OW2 Card_MissingData_SaysSinDato @story-8.293 @ac-10', (t) => {
  const row = { origen: 'pregunta', quien: 'Ana' };
  // sin ejecución
  const none = CARD.card({ row, marker: null });
  assert.strictEqual(none.riesgo, 'sin dato (sin ejecución)');
  assert.strictEqual(none.accion, 'contestar la pregunta en la sesión Ana');
  // la cuenta dice que no pudo saber: la historia no se lee
  const gone = toyRun(t);
  fs.rmSync(gone.storyPath);
  const unknown = CARD.card({ row, marker: gone });
  assert.match(unknown.riesgo, /^sin dato \(.+\)$/);
  assert.notStrictEqual(unknown.riesgo, 'delicada');
  // la cuenta falla
  const failed = CARD.card({ row, marker: toyRun(t), riskOf: () => { throw new Error('se rompió'); } });
  assert.match(failed.riesgo, /^sin dato \(.+\)$/);
  // no alcanza el tiempo: ni se lanza la cuenta
  const late = CARD.card({ row, marker: toyRun(t), budget: { until: 0 } });
  assert.match(late.riesgo, /^sin dato \(.*tiempo.*\)$/);
  // la ficha sale siempre, y lo que le falta no pasa a lo que la oficina no pudo leer
  const { data } = buildOffice({ wip: toyWip([{ session: 'Ana', status: 'waiting' }]), nowMs: NOW, ownerCard: () => ({ riesgo: 'sin dato (sin ejecución)', accion: 'x', linea: 'sin dato (sin ejecución) · x' }) });
  assert.deepStrictEqual(data.unreadable, []);
});

test('OW3 Card_ProposesNeverRuns @story-8.293 @ac-11', (t) => {
  const marker = toyRun(t);
  const list = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((f) => {
    const p = path.join(dir, f);
    return fs.statSync(p).isFile() ? `${f}:${fs.readFileSync(p, 'utf8').length}` : f;
  }).filter((f) => !f.startsWith('.git'));
  fs.writeFileSync(path.join(marker.runDir, 'approvals.jsonl'), '{"que":"plan"}\n');
  const before = list(marker.repoPath);
  const c = CARD.card({ row: { origen: 'lista', quien: 'Ana' }, marker });
  const signatures = [{ id: 'f1', firma: 'plan-approval', destino: 'sid-Ana', title: 'Aprobar', at: NOW }];
  const { data } = buildOffice({ wip: toyWip([{ session: 'Ana' }]), signatures, nowMs: NOW, ownerCard: () => c });
  page(data);
  assert.deepStrictEqual(list(marker.repoPath), before, 'armar la ficha y la página no escribe nada');
});

test('OW4 Office_PanelCardOwnerWaits @story-8.293 @ac-12', () => {
  const sessionFiles = [
    { session: 'sid-Plan', tool: 'claude', waitingForOwner: true, waitingFor: 'permiso', updatedAt: new Date(NOW).toISOString() },
    { session: 'sid-Otra', tool: 'claude', waitingForOwner: true, waitingFor: 'permiso', updatedAt: new Date(NOW).toISOString() },
  ];
  const wip = toyWip([
    { session: 'Plan', extra: { kind: 'pipeline', current: 'approve-plan', steps: [], progress: 30 } },
    { session: 'Otra', extra: { kind: 'loose', text: 'algo' } },
  ]);
  const { data } = buildOffice({ wip, sessionFiles, nowMs: NOW, ownerCard: stubCard });
  const cards = firmaColumn(data);
  assert.strictEqual(cards.length, 2, JSON.stringify(cards));
  const plan = cards.find((c) => c.quien === 'Plan');
  assert.strictEqual(plan.ficha.linea, 'delicada · acción de plan');
  assert.strictEqual(cards.find((c) => c.quien === 'Otra').ficha.linea, 'delicada · acción de cuadro');
  assert.strictEqual(data.agents.find((a) => a.nombre === 'Plan').ficha.accion, 'acción de plan');
  // la coordinadora la recibe en cada espera; sin ficha, la espera sale igual
  assert.deepStrictEqual(ownerWaitsOf(data).map((w) => w.ficha.linea).sort(), ['delicada · acción de cuadro', 'delicada · acción de plan']);
  const plainOffice = buildOffice({ wip, sessionFiles, nowMs: NOW }).data;
  assert.strictEqual(ownerWaitsOf(plainOffice).every((w) => !('ficha' in w)), true);
  // viaja al sitio como texto
  const sent = pick(data, '/home/nadie');
  assert.strictEqual(sent.agents.find((a) => a.nombre === 'Plan').ficha.riesgo, 'delicada');
  assert.strictEqual(sent.kanban.columnas.find((c) => c.id === 'firma').tarjetas[0].ficha.pedido, '#12');
  // la página la muestra: el panel y la tarjeta
  const html = page(data);
  const at = html.indexOf('function ficha(a,abiertos)');
  const panel = html.slice(at, html.indexOf('return r;}', at));
  for (const label of ['"Riesgo"', '"Pedido"', '"Propuesta"']) assert.ok(panel.includes(label), label);
  assert.match(html, /i\.ficha&&i\.ficha\.linea/);
});

test('OW5 WaitingKind_ThreeGroups @story-8.293 @ac-13', (t) => {
  const home = tmp(t, 'owner-kind-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'ses-kind' };
  const doing = (...args) => spawnSync(process.execPath, [MARKER, 'doing', ...args], { env, encoding: 'utf8' });
  const note = () => JSON.parse(fs.readFileSync(path.join(stateDir(home), 'doing', 'ses-kind.json'), 'utf8'));
  assert.strictEqual(doing('una nota de prueba', '--waiting-for', 'que main arranque', '--kind', 'main').status, 0);
  assert.strictEqual(note().waitingKind, 'main');
  assert.strictEqual(doing('una nota de prueba', '--waiting-for', 'a otra sesión', '--kind', 'session').status, 0);
  assert.strictEqual(note().waitingKind, 'session');
  assert.strictEqual(doing('una nota de prueba', '--waiting-for', 'a otra sesión').status, 0);
  assert.strictEqual('waitingKind' in note(), false, 'sin --kind el archivo queda como hoy');
  // errores de uso, también como primer argumento
  assert.strictEqual(doing('una nota de prueba', '--kind', 'main').status, 2);
  assert.strictEqual(doing('--kind', 'main').status, 2);
  assert.strictEqual(doing('una nota de prueba', '--waiting-for', 'algo', '--kind', 'otro').status, 2);
  assert.strictEqual(doing('una nota de prueba', '--waiting-for', 'algo', '--kind').status, 2);

  // /wip le pasa la clase a la oficina
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  assert.strictEqual(doing('una nota de prueba', '--waiting-for', 'que main arranque', '--kind', 'main').status, 0);
  fs.writeFileSync(path.join(sessions, 'ses-kind.json'), JSON.stringify({ pid: process.pid, sessionId: 'ses-kind', name: 'Nota', status: 'idle', statusUpdatedAt: Date.now() }));
  const real = buildWip({ home, stateDir: stateDir(home), sessionsDir: sessions });
  const i = real.rows.findIndex((r) => r.session === 'Nota');
  assert.ok(i >= 0, JSON.stringify(real.rows));
  assert.strictEqual(real.extra[i].waitingKind, 'main');

  const wip = toyWip([
    waiting('Main', 'que main arranque', { waitingKind: 'main' }),
    waiting('Sesion', 'a Pedro', { waitingKind: 'session' }),
    waiting('SinClase', 'a Juan'),
    waiting('Doble', 'a Pedro', { waitingKind: 'main' }),
    { session: 'Vieja', extra: { kind: 'note', text: 'una nota', waitingKind: 'main' } },
  ]);
  const openPrs = [{ repo: 'acme/pub', repoName: 'pub', number: 7, mark: '#', branch: 'b', title: 'Choca', inQueue: true, waiting: true, conflict: true }];
  const signatures = [{ id: 'f1', firma: 'x', destino: 'sid-Doble', title: 'Aprobar', at: NOW }];
  const { meta } = buildOffice({ wip, openPrs, signatures, nowMs: NOW, ownerCard: stubCard }).data;
  const names = (list) => list.map((s) => s.split(':')[0]).sort();
  assert.deepStrictEqual(names(meta.esperan.dueno), ['Doble'], 'la doble va con el dueño');
  assert.deepStrictEqual(names(meta.esperan.main), ['Main', 'pedido #7']);
  assert.deepStrictEqual(names(meta.esperan.sesion), ['Sesion', 'SinClase']);
  const all = [...meta.esperan.dueno, ...meta.esperan.main, ...meta.esperan.sesion];
  assert.strictEqual(new Set(names(all)).size, all.length, 'cada trabajo en un solo grupo');
  assert.strictEqual(all.some((s) => s.startsWith('Vieja')), false, 'sin espera no cuenta');
  assert.match(meta.esperan.dueno[0], /delicada · acción de lista/);
});

test('OW5b WaitGroups_SameWorkOnce_OwnerWins @story-8.293 @ac-13', () => {
  const g = CARD.waitGroups([
    { clave: 'a', quien: 'A', waitingFor: 'x', waitingKind: 'main' },
    { clave: 'a', quien: 'A', dueno: true, linea: 'de rutina · y' },
    { clave: 'b', quien: 'B', waitingKind: 'main' },
    { clave: 'c', quien: 'C', choca: true },
  ]);
  assert.deepStrictEqual(g.dueno.map((f) => f.quien), ['A']);
  assert.deepStrictEqual(g.main.map((f) => f.quien), ['C']);
  assert.deepStrictEqual(g.sesion, []);
});

const openPr = (repoName, number, more = {}) => ({ repo: `acme/${repoName}`, repoName, number, mark: '#', branch: 'b', title: `Pedido ${number}`, inQueue: true, waiting: true, conflict: true, ...more });
const realCard = ({ row }) => CARD.card({ row, marker: null });
const entering = (session, state, more = {}) => ({ session, state, ...more });

test('OWR1 Waits_EveryCrashingPrOnce @story-8.293 @ac-13', () => {
  // el mismo número en dos repos son dos pedidos
  const twoRepos = buildOffice({ wip: toyWip([]), openPrs: [openPr('pub', 7), openPr('priv', 7)], nowMs: NOW }).data;
  assert.strictEqual(twoRepos.meta.esperan.main.length, 2, JSON.stringify(twoRepos.meta.esperan));
  // filas distintas con la misma persona, o sin persona: una espera cada una y ninguna sale sin nombre
  const board = buildBoard({ pendientes: [
    { id: 'T-40', titulo: 'Uno', estado: 'espera', quien: 'Omega' }, { id: 'T-41', titulo: 'Dos', estado: 'espera', quien: 'Omega' },
    { id: 'T-42', titulo: 'Tres', estado: 'espera' }, { id: 'T-43', titulo: 'Cuatro', estado: 'espera' },
  ] });
  const prs = ['T-40', 'T-41', 'T-42', 'T-43'].map((id, i) => openPr('r', 40 + i, { title: `${id} algo` }));
  const rows = buildOffice({ wip: toyWip([]), board, openPrs: prs, nowMs: NOW }).data.meta.esperan.main;
  assert.strictEqual(rows.length, 4, JSON.stringify(rows));
  assert.strictEqual(rows.some((s) => s.startsWith(':')), false, JSON.stringify(rows));
});

test('OWR2 Waits_SessionAndItsPrAreOneWork @story-8.293 @ac-13', () => {
  const wip = toyWip([entering('Ana', 'Entrando a los repos · x #236 (choca con main)')]);
  const openPrs = [openPr('x', 236)];
  const alone = buildOffice({ wip, openPrs, nowMs: NOW, ownerCard: stubCard }).data.meta.esperan;
  assert.deepStrictEqual(alone.main, ['Ana: choca con main']);
  const signatures = [{ id: 'f1', firma: 'x', destino: 'sid-Ana', title: 'Aprobar', at: NOW }];
  const signed = buildOffice({ wip, openPrs, signatures, nowMs: NOW, ownerCard: stubCard }).data.meta.esperan;
  assert.strictEqual(signed.dueno.length, 1, JSON.stringify(signed));
  assert.deepStrictEqual(signed.main, [], 'el trabajo va con el dueño y no se repite en main');
  // otro pedido que choca, con el mismo número en otro repo, sigue contando
  const other = buildOffice({ wip, openPrs: [openPr('y', 236)], nowMs: NOW, ownerCard: stubCard }).data.meta.esperan;
  assert.strictEqual(other.main.length, 2, JSON.stringify(other));
});

test('OWR3 Waits_BoardRowWithItsPrCrashing @story-8.293 @ac-13', () => {
  const board = buildBoard({ pendientes: [{ id: 'T-50', titulo: 'Con pedido', estado: 'espera', quien: 'Omega', pedido: { repo: 'x', numero: 236 } }] });
  const prAnswers = new Map([['x#236', { pr: { state: 'open', autoComplete: true, mergeState: 'conflict', conflict: true } }]]);
  const { data } = buildOffice({ wip: toyWip([]), board, prAnswers, openPrs: [openPr('x', 236)], nowMs: NOW });
  const card = data.kanban.columnas.find((c) => c.id === 'entrando').tarjetas.find((t) => t.titulo === 'Con pedido');
  assert.strictEqual(card.motivo, 'choca con main');
  assert.deepStrictEqual(data.meta.esperan.main, ['Omega: choca con main']);
});

test('OWR4 Firma_KeepsItsOwnOriginAndRow @story-8.293 @ac-9 @ac-13', () => {
  // una firma de la lista, para una sesión con una pregunta en pantalla
  const wip = toyWip([{ session: 'Ana', status: 'waiting' }]);
  const signatures = [{ id: 'f1', firma: 'x', destino: 'sid-Ana', title: 'El carril', at: NOW }];
  const data = buildOffice({ wip, signatures, nowMs: NOW, ownerCard: realCard }).data;
  const firma = firmaColumn(data).find((c) => /El carril/.test(c.titulo));
  assert.strictEqual(firma.ficha.accion, 'contestar la firma que trae la coordinadora');
  // dos firmas distintas con el mismo título son dos esperas
  const twins = [{ id: 'f1', firma: 'x', title: 'Firma del plan', at: NOW }, { id: 'f2', firma: 'y', title: 'Firma del plan', at: NOW }];
  const both = buildOffice({ wip: toyWip([]), signatures: twins, nowMs: NOW, ownerCard: realCard }).data;
  assert.strictEqual(firmaColumn(both).length, 2);
  assert.strictEqual(both.meta.esperan.dueno.length, 2, JSON.stringify(both.meta.esperan));
  // una fila sin persona no deja el renglón sin sujeto
  const board = buildBoard({ pendientes: [{ id: 'T-1', titulo: 'Decidir algo', estado: 'firma' }] });
  const unnamed = buildOffice({ wip: toyWip([]), board, nowMs: NOW, ownerCard: realCard }).data.meta.esperan.dueno;
  assert.strictEqual(unnamed.length, 1);
  assert.doesNotMatch(unnamed[0], /^:/);
});

test('OWR5 Card_FailureStillSaysSinDato @story-8.293 @ac-10', (t) => {
  const row = { origen: 'pregunta', quien: 'Ana' };
  // si armar la ficha falla, la espera la trae igual
  const { data } = buildOffice({ wip: toyWip([{ session: 'Ana', status: 'waiting' }]), nowMs: NOW, ownerCard: () => { throw new Error('un texto secreto del error'); } });
  const ana = data.agents.find((a) => a.nombre === 'Ana');
  assert.match(ana.ficha.riesgo, /^sin dato \(.+\)$/);
  assert.strictEqual(ana.ficha.accion, 'contestar la pregunta en la sesión Ana');
  assert.doesNotMatch(JSON.stringify(ana.ficha), /secreto/);
  assert.deepStrictEqual(data.unreadable, []);
  // el motivo no trae el texto del error
  const thrown = CARD.card({ row, marker: toyRun(t), riskOf: () => { throw new Error('/ruta/interna'); } });
  assert.doesNotMatch(thrown.riesgo, /ruta/);
  // un marcador roto no es «sin ejecución»
  const home = tmp(t, 'owner-marker-');
  fs.mkdirSync(path.join(home, 'active'));
  fs.writeFileSync(path.join(home, 'active', 'rota.json'), '{ no es json');
  const broken = CARD.markerOf(home, 'rota');
  assert.ok(broken, 'un marcador ilegible no se confunde con no tener corrida');
  assert.strictEqual(CARD.card({ row, marker: broken }).riesgo, 'sin dato (no pude leer la ejecución)');
  assert.strictEqual(CARD.markerOf(home, 'ninguna'), null);
});

test('OWR6 Risk_WithoutPlanOrWithOldMemory @story-8.293 @ac-10', (t) => {
  // sin plan escrito, «de rutina» no se puede afirmar; lo delicado por la historia sí
  const noPlan = toyRun(t, { plan: null });
  assert.strictEqual(CARD.riskOfRun(noPlan), 'sin dato (plan no escrito)');
  assert.strictEqual(CARD.riskOfRun(toyRun(t, { plan: '  \n' })), 'sin dato (plan no escrito)', 'un plan vacío no es un plan');
  assert.strictEqual(CARD.riskOfRun(toyRun(t, { plan: null, front: 'sensible: "plata"\n' })), 'delicada');
  // la cuenta también mira archivos del repo: lo recordado vence
  const run = toyRun(t);
  assert.strictEqual(CARD.riskOfRun(run, undefined, NOW), 'de rutina');
  fs.mkdirSync(path.join(run.repoPath, 'scripts', 'ci'), { recursive: true });
  fs.writeFileSync(path.join(run.repoPath, 'scripts', 'ci', 'controls-from-base.json'), JSON.stringify({ controls: [{ script: 'docs/a.md' }] }));
  assert.strictEqual(CARD.riskOfRun(run, undefined, NOW + 1000), 'de rutina', 'dentro del minuto vale lo recordado');
  assert.strictEqual(CARD.riskOfRun(run, undefined, NOW + 61000), 'delicada');
  // la misma historia en dos repos no comparte respuesta
  const a = toyRun(t);
  const b = { ...toyRun(t), storyPath: a.storyPath };
  fs.mkdirSync(path.join(a.repoPath, 'scripts', 'ci'), { recursive: true });
  fs.writeFileSync(path.join(a.repoPath, 'scripts', 'ci', 'controls-from-base.json'), JSON.stringify({ controls: [{ script: 'docs/a.md' }] }));
  const same = new Date(NOW);
  for (const m of [a, b]) fs.utimesSync(path.join(m.runDir, 'step-02-bmad-plan.md'), same, same);
  assert.strictEqual(CARD.riskOfRun(b, undefined, NOW), 'de rutina');
  assert.strictEqual(CARD.riskOfRun(a, undefined, NOW), 'delicada');
});

test('OWR7 Doing_KindUsageErrors @story-8.293 @ac-13', (t) => {
  const home = tmp(t, 'owner-flags-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'ses-flags' };
  const doing = (...args) => spawnSync(process.execPath, [MARKER, 'doing', ...args], { env, encoding: 'utf8' });
  const note = () => JSON.parse(fs.readFileSync(path.join(stateDir(home), 'doing', 'ses-flags.json'), 'utf8'));
  assert.strictEqual(doing('una nota de prueba', '--waiting-for', '--kind', 'main').status, 2, 'sin qué espera');
  assert.strictEqual(doing('una nota de prueba', '--waiting-for', 'algo real', '--kind', 'main', '--kind', 'otro').status, 2);
  assert.strictEqual(doing('una nota de prueba', '--waiting-for', 'algo real', '--kind=otro').status, 2);
  assert.strictEqual(doing('una nota de prueba', '--waiting-for', 'algo real', '--kind=main').status, 2);
  // sin texto y con la clase primero: es la misma espera sobre la nota anotada
  assert.strictEqual(doing('una nota de prueba').status, 0);
  assert.strictEqual(doing('--kind', 'main', '--waiting-for', 'que main arranque').status, 0);
  assert.strictEqual(note().waitingFor, 'que main arranque');
  assert.strictEqual(note().waitingKind, 'main');
});

test('OWR8 Waits_SeenWithNothingToDo @story-8.293 @ac-13', () => {
  // sin nada en «Te toca», el bloque que se pliega no se abre: las esperas van afuera y se ven igual
  const { data } = buildOffice({ wip: toyWip([waiting('Sesion', 'a Pedro', { waitingKind: 'session' })]), nowMs: NOW, ownerCard: stubCard });
  assert.deepStrictEqual(data.meta.teToca, []);
  assert.strictEqual(data.meta.esperan.sesion.length, 1, JSON.stringify(data.meta.esperan));
  const html = page(data);
  const count = (str, what) => str.split(what).length - 1;
  const folded = html.indexOf('id="resumenListas"'), at = html.indexOf('<div class="esperan" id="esperan"');
  assert.ok(folded > html.indexOf('<div class="resumen" id="resumen">') && at > folded, JSON.stringify([folded, at]));
  const after = html.slice(folded, at);
  assert.strictEqual(count(after, '</div>') - count(after, '<div'), 1, 'después de cerrar lo que se pliega');
  assert.strictEqual(count(html.slice(at, html.indexOf('<div class="interruptor">')), '</div>'), 2, 'y antes de cerrar #resumen');
  assert.match(html, /renderEsperan\(meta&&meta\.esperan\)/, 'cada foto la vuelve a pintar');
  const el = html.match(/const el=(\([^\n]*\});\n/)[1];
  const summary = html.match(/const RESUMEN_KEY=[\s\S]*?b\.onclick=[^\n]*\n/)[0];
  const groups = html.match(/const GRUPOS_ESPERA=[^\n]*\nfunction renderEsperan\([^\n]*\n/)[0];
  const text = (n) => (n.textContent || '') + n.children.map(text).join('');
  const draw = (esperan) => {
    const node = (tag) => {
      const n = { tag, className: '', textContent: '', hidden: false, children: [], attrs: {} };
      n.appendChild = (c) => { n.children.push(c); return c; };
      n.replaceChildren = (...cs) => { n.children = cs; };
      n.setAttribute = (k, v) => { n.attrs[k] = v; };
      return n;
    };
    const byId = {};
    for (const id of ['resumen', 'resumenLinea', 'resumenListas', 'esperan']) byId[id] = node('div');
    byId.resumen.classList = { toggle() {} };
    const document = { createElement: node, getElementById: (id) => byId[id] || null, createTextNode: (textContent) => ({ textContent, children: [] }) };
    new Function('document', 'localStorage', `const el=${el};${summary}${groups};pintarResumen(0,0);renderEsperan(${JSON.stringify(esperan)});`)(document, { getItem: () => '1', setItem() {} });
    return byId;
  };
  const shown = draw(data.meta.esperan);
  assert.strictEqual(shown.resumenListas.hidden, true, 'sin nada que mostrar, las listas no se abren');
  assert.strictEqual(shown.esperan.hidden, false, 'las esperas se ven igual');
  assert.match(text(shown.esperan), /Esperan a otra sesión/);
  assert.match(text(shown.esperan), /Sesion/);
  assert.strictEqual(draw({ dueno: [], main: [], sesion: [] }).esperan.hidden, true, 'sin esperas queda oculto');
  assert.strictEqual(draw(undefined).esperan.hidden, true);
});

// OWR9: lo que espera una sesión puede decir ya «espera …» (espera a main): el renglón no lo repite, ni en la tarjeta
// ni en los dos renglones de la coordinación que nombran la espera
test('OWR9 WaitText_NoRepiteEspera', () => {
  assert.strictEqual(CARD.waitPhrase('espera a main (main-1)'), 'espera a main (main-1)');
  assert.strictEqual(CARD.waitPhrase('Espera a main'), 'Espera a main');
  assert.strictEqual(CARD.waitPhrase('a Pedro'), 'espera a Pedro');
  assert.strictEqual(CARD.waitPhrase('esperanza'), 'espera esperanza', 'sólo la palabra «espera» entera');
  assert.strictEqual(CARD.waitText({ quien: 'esper', waitingFor: 'espera a main (main-1)' }), 'esper: espera a main (main-1)');
  assert.strictEqual(CARD.waitText({ quien: 's', waitingFor: 'un permiso' }), 's: espera un permiso');
  const coord = fs.readFileSync(path.join(ROOT, 'scripts', 'tools', 'coordination.js'), 'utf8');
  assert.doesNotMatch(coord, /espera \$\{(?:x|w)\.waitingFor\}/, 'la coordinación arma la espera con waitPhrase');
});

// OW6: /wip muestra debajo de su tabla los mismos tres grupos que la oficina, armados con la foto que /wip ya tiene y sin
// el tablero de la coordinadora
test('OW6 Wip_EsperanBlock @story-8.293 @ac-14', async (t) => {
  const WIP = require(path.join(ROOT, 'scripts', 'tools', 'work-in-progress.js'));
  const office = require(path.join(ROOT, 'scripts', 'tools', 'office.js'));
  // la foto de OW5, con la firma de la lista para una sesión y otra firma suelta
  const wip = toyWip([
    waiting('Main', 'que main arranque', { waitingKind: 'main' }),
    waiting('Sesion', 'a Pedro', { waitingKind: 'session' }),
    waiting('Doble', 'a Pedro', { waitingKind: 'main' }),
  ]);
  const signatures = [{ id: 'f1', firma: 'x', destino: 'sid-Doble', title: 'Aprobar', at: NOW }, { id: 'f2', firma: 'y', title: 'Suelta', at: NOW }];
  const { meta } = buildOffice({ wip, openPrs: [openPr('pub', 7)], signatures, nowMs: NOW, ownerCard: stubCard }).data;
  const block = WIP.renderWaits(meta.esperan);
  const lines = block.split('\n');
  assert.ok(block.startsWith('\n\n'), 'un renglón en blanco lo separa de lo de arriba');
  const at = (title) => lines.indexOf(title);
  assert.ok(at('Esperan al dueño:') > 0 && at('Esperan al dueño:') < at('Esperan a main:') && at('Esperan a main:') < at('Esperan a otra sesión:'), block);
  const under = (title) => {
    const out = [];
    for (let j = at(title) + 1; j < lines.length && lines[j].startsWith('- '); j += 1) out.push(lines[j].slice(2));
    return out;
  };
  assert.deepStrictEqual(under('Esperan al dueño:'), meta.esperan.dueno, 'un renglón por espera, tal cual los arma la oficina');
  assert.strictEqual(under('Esperan al dueño:').length, 2, 'la sesión que espera la firma y la firma suelta de la lista');
  assert.ok(under('Esperan al dueño:').every((l) => / · acción de lista$/.test(l)), 'las del dueño, con la línea corta de su ficha y la acción');
  assert.deepStrictEqual(under('Esperan a main:'), meta.esperan.main);
  assert.deepStrictEqual(under('Esperan a otra sesión:'), meta.esperan.sesion);
  // un grupo vacío no sale, y sin esperas no hay bloque
  assert.doesNotMatch(WIP.renderWaits({ dueno: [], main: ['x: choca con main'], sesion: [] }), /Esperan al dueño|otra sesión/);
  assert.strictEqual(WIP.renderWaits(null), '');
  assert.strictEqual(WIP.renderWaits({ dueno: [], main: [], sesion: [] }), '');

  // /wip le pasa a la oficina la foto que ya armó, sin el tablero y sin escribir nada
  let asked;
  const r = { text: 'TABLA', unreadable: [] };
  const answered = await WIP.waitsOf(r, { stateDir: '/x' }, { collect: async (o) => { asked = o; return { meta: { esperan: meta.esperan }, unreadable: [] }; } });
  assert.strictEqual(answered, block);
  assert.strictEqual(asked.wip, r);
  assert.strictEqual(asked.noBoard, true);
  assert.strictEqual(asked.readOnly, true);
  assert.strictEqual(asked.stateDir, '/x');
  // si la oficina no contesta, se dice: nunca pasa por «no hay esperas»
  assert.match(await WIP.waitsOf(r, {}, { collect: () => new Promise(() => {}), ms: 50 }), /^\n\nEsperan: no pude mirarlo \(la oficina tardó más de /);
  assert.match(await WIP.waitsOf(r, {}, { collect: async () => { throw new Error('se rompió'); } }), /^\n\nEsperan: no pude mirarlo \(se rompió\)$/);
  // lo que la oficina no pudo leer y /wip no dijo ya va en un renglón
  const partial = await WIP.waitsOf({ text: '', unreadable: ['ya dicho'] }, {}, { collect: async () => ({ meta: {}, unreadable: ['ya dicho', 'las firmas pendientes no se pudieron leer: x'] }) });
  assert.strictEqual(partial, '\n\nLa oficina no pudo leer todo para las esperas: las firmas pendientes no se pudieron leer: x');
  assert.doesNotMatch(partial, /ya dicho/);

  // la fila del tablero que espera al dueño sale en la oficina y no en /wip
  const home = tmp(t, 'owner-wip-');
  const sdir = stateDir(home);
  fs.mkdirSync(path.join(sdir, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'coordination', 'tablero.json'), JSON.stringify({ pendientes: [{ id: 'T-1', titulo: 'Decidir algo', estado: 'firma' }] }));
  const sessions = path.join(home, 'sessions');
  const projects = path.join(home, 'projects');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  const base = { home, stateDir: sdir, sessionsDir: sessions, projectsDir: projects, wip: toyWip([]), readOnly: true, syncBoard: false, machine: false, quietMinutes: async () => ({ code: 0, out: '5' }), siteUrl: async () => ({ code: 0, out: '' }) };
  const withBoard = await office.collect(base);
  assert.strictEqual(withBoard.meta.esperan && withBoard.meta.esperan.dueno.length, 1, JSON.stringify(withBoard.meta.esperan));
  assert.ok(!(await office.collect({ ...base, noBoard: true })).meta.esperan, 'sin el tablero no queda espera');

  // de punta a punta: la tabla de siempre y, debajo, el bloque; `--json` no cambia
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'ses-wip' };
  assert.strictEqual(spawnSync(process.execPath, [MARKER, 'doing', 'una nota de prueba', '--waiting-for', 'que main arranque', '--kind', 'main'], { env, encoding: 'utf8' }).status, 0);
  fs.writeFileSync(path.join(sessions, 'ses-wip.json'), JSON.stringify({ pid: process.pid, sessionId: 'ses-wip', name: 'Nota', status: 'idle', statusUpdatedAt: Date.now() }));
  const WIP_JS = path.join(ROOT, 'scripts', 'tools', 'work-in-progress.js');
  const cli = (...more) => spawnSync(process.execPath, [WIP_JS, '--sessions-dir', sessions, '--projects-dir', projects, ...more], { env, encoding: 'utf8', input: '' });
  const text = cli();
  assert.strictEqual(text.status, 0, text.stderr);
  assert.match(text.stdout, /^\| Trabajo \| Estado \| Fin estimado \| Sesión \| Carpeta \|\n/);
  assert.match(text.stdout, /\n\nEsperan a main:\n- Nota: espera que main arranque\n$/);
  assert.doesNotMatch(text.stdout, /Decidir algo|Esperan al dueño/, 'las filas del tablero no salen en /wip');
  const json = cli('--json');
  assert.strictEqual(json.status, 0, json.stderr);
  assert.deepStrictEqual(Object.keys(JSON.parse(json.stdout)).sort(), ['free', 'halfway', 'idle', 'rows', 'unreadable']);

  // el comando dice qué es cada grupo
  const doc = fs.readFileSync(path.join(ROOT, 'commands', 'wip.md'), 'utf8');
  for (const title of ['Esperan al dueño', 'Esperan a main', 'Esperan a otra sesión']) assert.match(doc, new RegExp(`«${title}»`));
});
