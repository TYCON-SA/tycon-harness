'use strict';
/**
 * plan-review-closed.test.js — la revisión del plan se lanza sobre el plan cerrado.
 *
 *   PlanReview_SinPlanCerradoOConPreguntaAbierta_NoSeLanza — con «Armar el plan» abierto, o con una pregunta sin
 *     contestar a la persona, la preparación se niega y no deja pedido
 *   PlanReview_LaHistoriaCambiaMientrasCorre_UnSoloReintentoEntreLosDos — el plan o la historia que cambian mientras
 *     corre la dejan sin veredicto, y se relanza una sola vez entre los dos
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

const COORD = 'ses-coord';
const DESTINO = 'ses-a';
const HUELLA = 'a1b2c3d4e5f60718';
const PERFIL = { relay_session: 'coordinadora', delegated_signing: ['plan-approval'], owner_only: [], delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] };
const delegacion = (o) => DS.delegaSinVentana({ ...o, perfil: () => PERFIL, huella: () => ({ huella: HUELLA }) });
const PLAN = '# Plan\n\n## Qué hace\n\nCambia el título del README.\n\n## Archivos\n\n- README.md\n\n## Pasos\n\n1. Tocar el README.md.\n';
const APROBADO = { modo: 'plan', medido: true, confirmed: [], hallazgos_sin_veredicto: 0, a_verificar_aparte: 0, lentes_sin_medir: [] };
const cfgCon = (raw = {}) => POL().normalize(raw).values;

/** El repo y la casa: dos corridas abiertas con «Armar el plan» cerrado, el plan de ses-a escrito y la coordinadora. */
function laboratorio(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-cerrado-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(home);
  // stable-data: la fecha del commit de juguete es fija
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
  const lab = { repo, home, estado, stories };
  lab.marker = (sid, args) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8', env: { ...env, CLAUDE_CODE_SESSION_ID: sid } });
  lab.marcador = (sid) => path.join(estado, 'active', `${sid}.json`);
  lab.leer = (sid) => JSON.parse(fs.readFileSync(lab.marcador(sid), 'utf8'));
  for (const [sid, storyId] of [[DESTINO, '9.91'], [COORD, '9.92']]) {
    const set = lab.marker(sid, ['set', JSON.stringify({ storyId, storyPath: stories[sid], repoPath: repo })]);
    assert.strictEqual(set.status, 0, set.stderr);
    for (const n of ['0', '1', '2']) lab.marker(sid, ['complete-step', n]);
  }
  lab.planFile = path.join(require(PIPELINE).resolveRunDir(repo, '9.91', true, stories[DESTINO]), 'step-02-bmad-plan.md');
  fs.writeFileSync(lab.planFile, PLAN);
  const d = { name: 'relay-designation', status: 'ok', ts: '2026-10-27T08:00:00.000Z', sesion: COORD, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DS.confirmationRecord(d, '2026-10-27T08:01:00.000Z'))}\n`);
  lab.preparar = () => PR().preparar({ lanza: COORD, destino: DESTINO, estado, home, delegacion });
  /** Prepara, deja que `antesDeAnotar` cambie algo y anota el resultado del pase. */
  lab.revisar = (antesDeAnotar) => {
    const p = lab.preparar();
    assert.strictEqual(p.codigo, 0, p.motivo);
    if (antesDeAnotar) antesDeAnotar();
    return PR().anotar({ lanza: COORD, destino: DESTINO, estado, resultado: { pedido: p.args.pedido, ...APROBADO }, modelo: 'opus', proveedor: 'anthropic' });
  };
  return lab;
}
// 🔴 Falla con: la revisión que se lanza con el plan todavía abierto, o con una pregunta sin contestar a la persona, y se
//    pierde (medido: cuatro lanzamientos para un plan, media hora).
test('PlanReview_SinPlanCerradoOConPreguntaAbierta_NoSeLanza', (t) => {
  const lab = laboratorio(t);
  const preparar = lab.preparar;
  // con «Armar el plan» abierto
  const m = lab.leer(DESTINO);
  // el plan cerrado, con el nombre de hoy o el de la numeración vieja («2»)
  const esPlan = (s) => s === 'plan' || s === '2';
  const sinPlan = { ...m, stepsCompleted: (m.stepsCompleted || []).filter((s) => !esPlan(String(s))), stepsPending: [...(m.stepsPending || [])] };
  fs.writeFileSync(lab.marcador(DESTINO), JSON.stringify(sinPlan));
  const abierto = preparar();
  assert.strictEqual(abierto.codigo, 2);
  assert.match(abierto.motivo, /no está cerrado: se lanza la revisión después de cerrar «Armar el plan»/);
  assert.ok(!fs.existsSync(path.join(lab.estado, 'plan-review', COORD, `${DESTINO}.pending.json`)), 'no deja pedido');
  fs.writeFileSync(lab.marcador(DESTINO), JSON.stringify(m));
  // con una pregunta a la persona sin contestar
  const ask = lab.marker(DESTINO, ['review-ask', '--kind', 'plan']);
  assert.strictEqual(ask.status, 0, ask.stderr);
  const conPregunta = preparar();
  assert.strictEqual(conPregunta.codigo, 2);
  assert.match(conPregunta.motivo, /hay una pregunta abierta a la persona/);
  // contestada, se lanza
  const ans = lab.marker(COORD, ['review-answer', '--kind', 'plan', '--choice', 'review', '--for-session', DESTINO]);
  assert.strictEqual(ans.status, 0, ans.stderr);
  assert.strictEqual(preparar().codigo, 0);
});

// 🔴 Falla con: un cambio en la historia mientras corre la revisión que no la invalida (aprueba lo que ya no está), o que
//    suma un reintento propio aparte del del plan: entre los dos se relanza una sola vez.
test('PlanReview_LaHistoriaCambiaMientrasCorre_UnSoloReintentoEntreLosDos', (t) => {
  const lab = laboratorio(t);
  const config = cfgCon({ plan_review: { routine: 'always' } });
  const accion = () => PR().accionDelPlan({ estado: lab.estado, sesion: DESTINO, marker: lab.leer(DESTINO), config, home: lab.home });
  const historia = lab.stories[DESTINO];
  let c = lab.revisar(() => fs.appendFileSync(historia, '\nAC 9. sumado mientras corría.\n'));
  assert.strictEqual(c.veredicto, 'sin-veredicto');
  assert.match(c.motivo, /la historia cambió mientras corría la revisión/);
  assert.strictEqual(c.reintentar, true);
  assert.strictEqual(accion().reintento, true);
  // la segunda vez cambia el plan: ya se reintentó una vez, llega a la persona
  c = lab.revisar(() => fs.writeFileSync(lab.planFile, `${PLAN}7. cambió mientras corría\n`));
  assert.strictEqual(c.reintentar, undefined, 'entre el plan y la historia se reintenta una sola vez');
  const a = accion();
  assert.strictEqual(a.comando, undefined);
  assert.strictEqual(a.alDueno.llega, true);
  assert.match(a.alDueno.motivo, /cambió mientras corría la revisión, dos veces/);
});
