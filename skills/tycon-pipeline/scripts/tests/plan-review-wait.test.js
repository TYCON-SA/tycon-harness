'use strict';
/**
 * plan-review-wait.test.js — una sesión no queda quieta esperando a una coordinadora que no atiende.
 *
 *   PlanReview_CoordinadoraMuerta_LaLanzaLaSesion — la designada que no está viva no deja la sesión esperando
 *   PlanReview_CoordinadoraQueNoTomaElPedido_DespuesDeNMinutosLaLanzaLaSesion — el pedido que el arnés le anota vence a
 *     los minutos de plan_review.coordinator_wait_minutes, y la coordinadora ve en su aviso que la sesión siguió sola
 *   PlanReview_CoordinadoraConLaRevisionEnCurso_LaSesionLaSigueEsperando — una revisión suya en curso sobre este plan
 *     cuenta como tomada, aunque la haya preparado antes del pedido
 *   PlanReview_PedidoResueltoPorUnaRevisionTerminada_UnRelanzamientoTieneSuPropioPlazo
 *   PlanReview_SinSaberSiVive_LaEsperaHastaElTope — la sesión no se declara sola: la espera los minutos del tope
 *
 * Una casa y un repo de juguete por prueba, con los guiones de verdad; la coordinadora designada y confirmada en el
 * registro. 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const DS = require(path.join(RAIZ, 'scripts', 'lib', 'delegated-signing.js'));
const PR = () => require(path.join(SCRIPTS, 'lib', 'plan-review.js'));
const POL = () => require(path.join(SCRIPTS, 'lib', 'review-policy.js'));
const C = () => require(path.join(RAIZ, 'scripts', 'tools', 'coordination.js'));

const COORD = 'ses-coord';
const DESTINO = 'ses-a';
const HUELLA = 'a1b2c3d4e5f60718';
const PERFIL = { relay_session: 'coordinadora', delegated_signing: ['plan-approval'], owner_only: [], delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] };
const delegacion = (o) => DS.delegaSinVentana({ ...o, perfil: () => PERFIL, huella: () => ({ huella: HUELLA }) });
const PLAN = '# Plan\n\n## Qué hace\n\nCambia el título del README.\n\n## Archivos\n\n- README.md\n\n## Pasos\n\n1. Tocar el README.md.\n';
const SIN_MEDIR = { modo: 'plan', medido: false, confirmed: [], hallazgos_sin_veredicto: 0, a_verificar_aparte: 0, lentes_sin_medir: ['ac-sin-cubrir'] };
const cfgCon = (raw = {}) => POL().normalize(raw).values;
const RUN = () => cfgCon({ plan_review: { routine: 'always' } });
// stable-data: la hora de las pruebas es fija
const AHORA = Date.parse('2026-11-20T12:00:00.000Z');
const MIN = 60000;

/** El repo y la casa: dos corridas abiertas con «Armar el plan» cerrado, el plan de ses-a escrito y la coordinadora. */
function laboratorio(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-coord-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(home);
  const fecha = { GIT_AUTHOR_DATE: '2026-11-20T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-20T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: { ...process.env, ...fecha } });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const historia = (n) => {
    const f = path.join(repo, 'specs', `story-${n}-juguete.md`);
    fs.writeFileSync(f, ['---', `story: "${n}"`, 'title: "juguete"', 'status: in-progress', 'files_to_modify:', '  - README.md', '---', '', `# Story ${n}`, ''].join('\n'));
    return f;
  };
  const stories = { [DESTINO]: historia('9.91'), [COORD]: historia('9.92') };
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_PROFILE: '0' };
  for (const k of ['TYCON_HOME', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_OPTIONS', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS']) delete env[k];
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  const lab = { base, repo, home, estado, stories };
  lab.marker = (sid, args) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8', env: { ...env, CLAUDE_CODE_SESSION_ID: sid } });
  lab.leer = (sid) => JSON.parse(fs.readFileSync(path.join(estado, 'active', `${sid}.json`), 'utf8'));
  for (const [sid, storyId] of [[DESTINO, '9.91'], [COORD, '9.92']]) {
    const set = lab.marker(sid, ['set', JSON.stringify({ storyId, storyPath: stories[sid], repoPath: repo })]);
    assert.strictEqual(set.status, 0, set.stderr);
    for (const n of ['0', '1', '2']) lab.marker(sid, ['complete-step', n]);
  }
  fs.writeFileSync(path.join(require(PIPELINE).resolveRunDir(repo, '9.91', true, stories[DESTINO]), 'step-02-bmad-plan.md'), PLAN);
  const d = { name: 'relay-designation', status: 'ok', ts: '2026-10-27T08:00:00.000Z', sesion: COORD, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DS.confirmationRecord(d, '2026-10-27T08:01:00.000Z'))}\n`);
  lab.gates = () => fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  lab.preparar = () => PR().preparar({ lanza: COORD, destino: DESTINO, estado, home, delegacion });
  /** La coordinadora prepara la revisión del plan de ses-a y anota `resultado` como el del pase. */
  lab.revisar = (resultado) => {
    const p = lab.preparar();
    assert.strictEqual(p.codigo, 0, p.motivo);
    return PR().anotar({ lanza: COORD, destino: DESTINO, estado, resultado: { pedido: p.args.pedido, ...resultado }, modelo: 'opus', proveedor: 'anthropic' });
  };
  lab.accion = (ahora, config = RUN()) => PR().accionDelPlan({ estado, sesion: DESTINO, marker: lab.leer(DESTINO), config, home, ahora });
  return lab;
}

/** El archivo de sesión de Claude Code de la coordinadora: viva con este pid, muerta con uno que no existe, o sin archivo. */
function sesionDeLaCoordinadora(lab, { viva }) {
  const dir = path.join(lab.home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  if (viva === null) return;
  fs.writeFileSync(path.join(dir, `${COORD}.json`), JSON.stringify({ pid: viva ? process.pid : 999999, sessionId: COORD, name: 'Coordinadora', kind: 'interactive', cwd: lab.base }));
}

// 🔴 Falla con: la sesión que espera para siempre a una coordinadora cerrada (medido: dos historias de un producto,
//    paradas y relanzadas a mano).
test('PlanReview_CoordinadoraMuerta_LaLanzaLaSesion', (t) => {
  const muerta = laboratorio(t);
  sesionDeLaCoordinadora(muerta, { viva: false });
  const a = muerta.accion(AHORA);
  assert.strictEqual(a.lanza, 'session', JSON.stringify(a));
  assert.strictEqual(a.comando, 'marker.js plan-review');
  assert.match(a.reason, /no está viva/);
  // Claude Code borra el archivo al cerrarla: con la carpeta leída y sin su archivo, tampoco vive
  const cerrada = laboratorio(t);
  sesionDeLaCoordinadora(cerrada, { viva: null });
  assert.strictEqual(cerrada.accion(AHORA).lanza, 'session');
  // viva: la lanza ella, como siempre
  const viva = laboratorio(t);
  sesionDeLaCoordinadora(viva, { viva: true });
  const c = viva.accion(AHORA);
  assert.strictEqual(c.lanza, 'coordinator', JSON.stringify(c));
  assert.match(c.comando, /plan-review --for-session ses-a/);
});

test('PlanReview_CoordinadoraQueNoTomaElPedido_DespuesDeNMinutosLaLanzaLaSesion', (t) => {
  const lab = laboratorio(t);
  sesionDeLaCoordinadora(lab, { viva: true });
  assert.strictEqual(lab.accion(AHORA).lanza, 'coordinator', 'al cerrar el plan, le toca a ella');
  assert.strictEqual(lab.gates().filter((g) => g.name === PR().PEDIDO).length, 1, 'el arnés anota el pedido');
  // la coordinadora se entera sola: su aviso de cada turno nombra el plan y cuánto le queda
  const aviso = C().planRequestLines({ home: lab.home }, COORD, AHORA + 3 * MIN);
  assert.strictEqual(aviso.length, 1, JSON.stringify(aviso));
  assert.match(aviso[0], /plan-review --for-session ses-a/);
  assert.match(aviso[0], /en 7 min/);
  assert.deepStrictEqual(C().planRequestLines({ home: lab.home }, 'ses-otra', AHORA + 3 * MIN), []);
  assert.strictEqual(lab.accion(AHORA + 9 * MIN).lanza, 'coordinator', 'dentro de los 10 minutos, la espera');
  assert.strictEqual(lab.gates().filter((g) => g.name === PR().PEDIDO).length, 1, 'el pedido no se anota dos veces');
  const tarde = lab.accion(AHORA + 11 * MIN);
  assert.strictEqual(tarde.lanza, 'session', JSON.stringify(tarde));
  assert.match(tarde.reason, /no tomó el pedido en 10 min/);
  // ve que la sesión siguió sin ella: no pierde la aprobación delegada sin enterarse
  const vencido = C().planRequestLines({ home: lab.home }, COORD, AHORA + 20 * MIN);
  assert.strictEqual(vencido.length, 1, JSON.stringify(vencido));
  assert.match(vencido[0], /la lanza ella sola/);
  assert.deepStrictEqual(C().planRequestLines({ home: lab.home }, COORD, AHORA + 80 * MIN), [], 'después de una hora ya no sale');
  // con otro tope configurado, cuenta ése
  assert.strictEqual(lab.accion(AHORA + 11 * MIN, cfgCon({ plan_review: { routine: 'always', coordinator_wait_minutes: 30 } })).lanza, 'coordinator');
});

test('PlanReview_CoordinadoraConLaRevisionEnCurso_LaSesionLaSigueEsperando', (t) => {
  // ella preparó la revisión ANTES de que se anotara el pedido: cuenta igual, por el plan que revisa
  const lab = laboratorio(t);
  sesionDeLaCoordinadora(lab, { viva: true });
  const p = lab.preparar();
  assert.strictEqual(p.codigo, 0, p.motivo);
  assert.strictEqual(lab.accion(AHORA).lanza, 'coordinator');
  assert.strictEqual(lab.accion(AHORA + 30 * MIN).lanza, 'coordinator', 'con su revisión corriendo, la sesión no lanza otra');
  assert.deepStrictEqual(PR().pedidosA({ estado: lab.estado, a: COORD }), [], 'ni se le anota un pedido');
});

test('PlanReview_PedidoResueltoPorUnaRevisionTerminada_UnRelanzamientoTieneSuPropioPlazo', (t) => {
  const lab = laboratorio(t);
  sesionDeLaCoordinadora(lab, { viva: true });
  lab.accion(AHORA);
  const [pedido] = PR().pedidosA({ estado: lab.estado, a: COORD });
  assert.ok(pedido, 'el pedido quedó anotado');
  lab.revisar(SIN_MEDIR);
  // terminó una revisión suya después del pedido: el pedido viejo ya no cuenta minutos
  assert.strictEqual(PR().estadoDelPedido({ estado: lab.estado, pedido, minutos: 10, ahora: AHORA + 30 * MIN }).estado, 'resuelto');
  // un pedido nuevo del mismo plan se ata a esa revisión terminada y empieza de cero
  const atiende = PR().coordinadoraQueAtiende({ estado: lab.estado, home: lab.home, sesion: DESTINO, huellaPlan: pedido.huellaPlan, corrida: pedido.corrida, minutos: 10, ahora: AHORA + 30 * MIN });
  assert.strictEqual(atiende.coordinadora, COORD);
  assert.strictEqual(atiende.pedido, false, 'el pedido viejo no vale para el relanzamiento');
  assert.ok(atiende.tras, 'se ata a la revisión terminada');
});

test('PlanReview_SinSaberSiVive_LaEsperaHastaElTope', (t) => {
  // sin la carpeta de sesiones no se sabe si vive: la sesión no se declara sola, la espera los minutos del tope
  const lab = laboratorio(t);
  const a = lab.accion(AHORA);
  assert.strictEqual(a.lanza, 'coordinator', JSON.stringify(a));
  assert.match(a.reason, /no pude saber si la coordinadora/);
  assert.strictEqual(lab.accion(AHORA + 11 * MIN).lanza, 'session');
});
