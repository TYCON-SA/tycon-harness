'use strict';
/**
 * approve-without-person.test.js — lo que se firma sin persona pasa el control previo de su guion: la maqueta
 * (`approve-mockup`), el pendiente (`approve-pending`) y las firmas de rutina que el perfil puede delegar
 * (`compare-waiver`, `e2e-setup.js prepare`, el cierre de una ejecución perdida por partición). Lo de nivel 2 del mismo
 * guion (`e2e-setup.js defer --no`, `clear-session --lost`) no sale por delegación.
 *
 * Los guiones corren de verdad, en una HOME de juguete. La maqueta: el registro de la ventana se escribe a mano, con la
 * vía que se prueba, y el guion lo verifica con el árbol de procesos de la prueba (window-passed.js, `arbol`). El
 * pendiente: `exigir` en proceso con el control previo del guion (`antesDelPendiente`), y el guion de verdad en el
 * chequeo previo. Lo delegable: la firma por delegación dada por pasada (window-passed.js, `delegadaPor`), que pasa por
 * el control previo del guion como la delegación de verdad.
 *
 * stable-data: las horas son las de la corrida de la prueba; ninguna se compara con una fecha fija, salvo las de los
 * commits del laboratorio de la partición, que son fijas.
 */
// sin el perfil del equipo: la prueba fija su ambiente (scripts/tests/lib/without-team-profile.js)
require('../../../../scripts/tests/lib/without-team-profile.js');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
// los guiones que la prueba lanza como procesos corren desde la copia del arnés, que no trae el perfil del equipo: en
// el nocturno y en la validación del privado el árbol real lo trae encima, y TYCON_PROFILE=0 no apaga sus claves
const { harnessCopy } = require('../../../../scripts/tests/lib/harness-copy.js');
const COPIA = path.join(harnessCopy(), 'skills', 'tycon-pipeline', 'scripts');
const MARKER = path.join(COPIA, 'marker.js');
const PIPELINE = path.join(COPIA, 'pipeline.js');
const E2E = path.join(COPIA, 'e2e-setup.js');
const MOCKUP = path.join(COPIA, 'mockup.js');
const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
const DS = require(path.join(RAIZ, 'scripts', 'lib', 'delegated-signing.js'));
const PA = require(path.join(RAIZ, 'scripts', 'lib', 'pending-approvals.js'));
const { conVentana, arbolDelGuion } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'window-passed.js'));
const PR = () => require(path.join(SCRIPTS, 'lib', 'plan-review.js'));
const or = require(path.join(SCRIPTS, 'lib', 'open-runs.js'));
const bt = require(path.join(SCRIPTS, 'lib', 'browser-test.js'));

const DEST = 'ses-a';
const COORD = 'ses-coord';
const AHORA = Date.now();
const INICIO = 'Tue Oct 27 10:00:00 2026';
const PASOS = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'];
const PLAN = '# Plan\n\n## Qué hace\n\nSuma el botón de pagar a la lista de facturas.\n\n## Archivos\n\n- src/components/Facturas.tsx\n\n## Pasos\n\n1. El botón.\n2. Su prueba.\n';
const APROBADO = { modo: 'plan', medido: true, confirmed: [], hallazgos_sin_veredicto: 0, a_verificar_aparte: 0, lentes_sin_medir: [] };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const comillas = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
const salida = (r) => `${r.stderr || ''}${r.stdout || ''}`;

function tmp(t, prefijo) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefijo)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function gitInit(repo) {
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  return git;
}
function ambiente(home, sid, extra = {}) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_PROFILE: '0', ...extra };
  for (const k of ['TYCON_HOME', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_OPTIONS', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS', 'NODE_TEST_CONTEXT', 'TYCON_SIGN_PRECHECK', 'TYCON_SIGN_PRECHECK_VIA']) if (!(k in extra)) delete e[k];
  if (sid) e.CLAUDE_CODE_SESSION_ID = sid;
  return e;
}
const estadoDe = (home) => path.join(home, '.claude', '.tycon-pipeline');
const lineas = (archivo) => { try { return fs.readFileSync(archivo, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };

/** El registro de la ventana como lo deja el freno: `via` ausente es la ventana. */
function registrar(home, { firma, cmd, sesion, destino, via, extra = {} }) {
  fs.mkdirSync(ow.carpeta(home), { recursive: true });
  const reg = { firma, sesion, destino, tool_use_id: 'toolu_01', sha256: sha(cmd), comando: cmd, herramienta: { pid: 100, inicio: INICIO },
    ts: new Date(AHORA).toISOString(), ...(via === undefined ? {} : { via }), ...extra };
  fs.writeFileSync(path.join(ow.carpeta(home), `${firma.replace(/[^\w-]/g, '_')}--${crypto.randomBytes(4).toString('hex')}.json`), JSON.stringify(reg));
}
const vigentes = (home) => { try { return fs.readdirSync(ow.carpeta(home)).filter((f) => f.endsWith('.json')); } catch (_) { return []; } };

// ── la maqueta ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Una historia con pantalla y su maqueta, la corrida de ses-a con el plan aprobado y su plan escrito, y la coordinadora
 * designada y confirmada. `sensible`: la historia es delicada.
 */
function maqueta(t, { sensible = false } = {}) {
  const base = tmp(t, 'sin-persona-mq-');
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const git = gitInit(repo);
  const story = path.join(repo, 'specs', 'stories', 'story-9.91-facturas.md');
  fs.mkdirSync(path.dirname(story), { recursive: true });
  fs.writeFileSync(story, ['---', 'story: "9.91"', 'title: "La lista de facturas"', 'status: in-progress', ...(sensible ? ['sensible: seguridad'] : []),
    'files_to_modify:', '  - src/components/Facturas.tsx', '---', '', '# Story 9.91', '', '## Acceptance Criteria', '',
    '1. **Given** un cliente con facturas **When** abre la lista **Then** ve cuántas le faltan pagar.', '',
    '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
    '| T1 | `ListaDeFacturas_MuestraPendientes` | 1 | e2e | x | y |', ''].join('\n'));
  git('add', '.'); git('commit', '-qm', 'base');
  const modelo = JSON.stringify({ title: 'La lista de facturas', summary: 'Suma el botón de pagar.', screens: [{ name: 'Lista de facturas', state: 'con facturas',
    elements: [{ kind: 'heading', text: 'Facturas pendientes' }, { kind: 'button', text: 'Pagar seleccionadas' }] }] });
  const r = spawnSync(process.execPath, [MOCKUP, 'render', '--data', '-', '--story', story], { encoding: 'utf8', input: modelo, env: ambiente(home) });
  assert.strictEqual(r.status, 0, salida(r));
  // su revisión con navegador, limpia (la de `mockup.js shots`; el navegador se prueba en mockup.test.js)
  {
    const out = JSON.parse(r.stdout).out;
    const SH = require(path.join(COPIA, 'lib', 'mockup-shots.js'));
    const { report, shots } = SH.shotsPaths(out);
    SH.escribirInforme({ report, file: path.basename(out), sha256: require(MOCKUP).mockupHash(fs.readFileSync(out, 'utf8')), shots, findings: [] });
  }
  const estado = estadoDe(home);
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const marcador = { storyId: '9.91', sessionId: DEST, stepScheme: 2, startedAt: new Date(AHORA - 3600000).toISOString(), lastTouch: new Date(AHORA).toISOString(),
    stepsCompleted: PASOS.slice(0, 4), stepsPending: PASOS.slice(4), iterations: {}, storyPath: story, repoPath: repo, fileEvents: [] };
  fs.writeFileSync(path.join(estado, 'active', `${DEST}.json`), JSON.stringify(marcador));
  const runDir = require(PIPELINE).resolveRunDir(repo, '9.91', true, story);
  fs.writeFileSync(path.join(runDir, 'step-02-bmad-plan.md'), PLAN);
  const d = { name: 'relay-designation', status: 'ok', ts: new Date(AHORA - 7200000).toISOString(), sesion: COORD, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DS.confirmationRecord(d, new Date(AHORA - 7100000).toISOString()))}\n`);
  const L = { base, repo, home, story, estado };
  L.aprobacion = () => require(MOCKUP).mockupPaths(story).approval;
  L.leer = () => JSON.parse(fs.readFileSync(path.join(estado, 'active', `${DEST}.json`), 'utf8'));
  /** La revisión automática del plan de ses-a que lanza `lanza`, aprobada. */
  L.revisar = (lanza) => {
    const p = PR().preparar({ lanza, destino: DEST, estado, home, delegacion: () => ({ ok: true, maquina: 'm' }) });
    assert.strictEqual(p.codigo, 0, p.motivo);
    const a = PR().anotar({ lanza, destino: DEST, estado, resultado: { pedido: p.args.pedido, ...APROBADO }, modelo: 'opus', proveedor: 'anthropic' });
    return a;
  };
  /** El guion de verdad, con el registro de la ventana verificado contra el árbol de la prueba. */
  L.correr = (sid, args, extra = {}) => {
    const cmd = `node ${MARKER} ${args.map(comillas).join(' ')}`;
    return spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8',
      env: conVentana(ambiente(home, sid, extra), { arbol: { arbol: arbolDelGuion(home, cmd), pid: 301, ahora: AHORA + 60000 } }) });
  };
  L.comando = (args) => `node ${MARKER} ${args.map(comillas).join(' ')}`;
  return L;
}
const PROPIA_PANTALLA = /la revisión que lanzó la propia sesión no cuenta para una pantalla/;
const COMO_APROBAR = /Si lo que frena es que no firma una persona/;

test('T5 ApproveMockup_AvisadoOwnSession_Denied @story-8.255 @ac-4', (t) => {
  const ARGS = ['approve-mockup', '--approved', 'x'];
  for (const conConstancia of [true, false]) {
    const L = maqueta(t);
    if (conConstancia) {
      L.revisar(DEST);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(L.estado, 'plan-review', DEST, `${DEST}.json`), 'utf8')).informativa, false,
        'con el perfil de fábrica la revisión propia de una historia de rutina no es informativa');
    }
    registrar(L.home, { firma: 'plan-approval', cmd: L.comando(ARGS), sesion: DEST, destino: DEST, via: 'avisado' });
    const r = L.correr(DEST, ARGS);
    const caso = conConstancia ? 'con constancia' : 'sin constancia';
    assert.notStrictEqual(r.status, 0, `${caso}: ${salida(r)}`);
    assert.match(r.stderr, PROPIA_PANTALLA, caso);
    assert.match(r.stderr, COMO_APROBAR, caso);
    assert.ok(!fs.existsSync(L.aprobacion()), `${caso}: sin archivo de aprobación`);
    assert.strictEqual(L.leer().mockupApproval, undefined, caso);
    assert.strictEqual(vigentes(L.home).length, 1, `${caso}: el pedido no se consume`);
  }
  // en el chequeo previo del freno, con la vía avisado: lo mismo, sin el ok del chequeo
  const L = maqueta(t);
  L.revisar(DEST);
  const p = spawnSync(process.execPath, [MARKER, ...ARGS], { cwd: L.repo, encoding: 'utf8',
    env: ambiente(L.home, DEST, { TYCON_SIGN_PRECHECK: '1', TYCON_SIGN_PRECHECK_VIA: 'avisado' }) });
  assert.notStrictEqual(p.status, 0, salida(p));
  assert.match(p.stderr, PROPIA_PANTALLA);
  assert.doesNotMatch(p.stdout, /tycon-sign-precheck: ok/);
  assert.ok(!fs.existsSync(L.aprobacion()));
});

test('T6 ApproveMockup_DelegatedDelicate_Denied @story-8.255 @ac-5', (t) => {
  const L = maqueta(t, { sensible: true });
  const ARGS = ['approve-mockup', '--for-session', DEST, '--approved', 'x'];
  registrar(L.home, { firma: 'plan-approval', cmd: L.comando(ARGS), sesion: COORD, destino: DEST, via: 'delegacion', extra: { maquina: 'm' } });
  const r = L.correr(COORD, ARGS);
  assert.notStrictEqual(r.status, 0, salida(r));
  assert.match(r.stderr, /plan delicado \(nivel 2\)/);
  assert.ok(!fs.existsSync(L.aprobacion()));
  assert.strictEqual(L.leer().mockupApproval, undefined);
});

test('T7 ApproveMockup_DelegatedRoutineReviewed_SignsByReview @story-8.255 @ac-6', (t) => {
  const L = maqueta(t);
  L.revisar(COORD);
  const ARGS = ['approve-mockup', '--for-session', DEST, '--approved', 'x'];
  registrar(L.home, { firma: 'plan-approval', cmd: L.comando(ARGS), sesion: COORD, destino: DEST, via: 'delegacion', extra: { maquina: 'm' } });
  const r = L.correr(COORD, ARGS);
  assert.strictEqual(r.status, 0, salida(r));
  const firmada = lineas(path.join(L.estado, 'gates.log')).filter((g) => g.name === 'plan-approval-signed');
  assert.strictEqual(firmada.length, 1);
  assert.strictEqual(firmada[0].via, 'revision');
  assert.ok(fs.existsSync(L.aprobacion()), 'escribe la aprobación');
  assert.strictEqual(L.leer().mockupApproval.via, 'revision', 'la constancia dice quién firmó');
});

test('T8 ApproveMockup_PersonVias_SignAsToday @story-8.255 @ac-7', (t) => {
  for (const via of [undefined, 'click']) {
    const L = maqueta(t);
    const ARGS = ['approve-mockup', '--approved', 'la ve bien'];
    registrar(L.home, { firma: 'plan-approval', cmd: L.comando(ARGS), sesion: DEST, destino: DEST, via });
    const r = L.correr(DEST, ARGS);
    assert.strictEqual(r.status, 0, `${via || 'ventana'}: ${salida(r)}`);
    assert.ok(fs.existsSync(L.aprobacion()), via || 'ventana');
    assert.ok(L.leer().mockupApproval, via || 'ventana');
  }
});

// ── el pendiente ─────────────────────────────────────────────────────────────────────────────────────────────────

/** El repo de ses-a con su pendiente abierto, el checkout de la coordinadora, y la corrida abierta de ses-a. */
function pendiente(t) {
  const base = tmp(t, 'sin-persona-pa-');
  const home = path.join(base, 'home');
  const destino = path.join(base, 'destino');
  const coordinadora = path.join(base, 'coordinadora');
  fs.mkdirSync(home);
  for (const repo of [destino, coordinadora]) {
    const git = gitInit(repo);
    fs.mkdirSync(path.join(repo, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(repo, PA.TODO), '# Pendientes\n\n- [ ] [DEF-x] el arreglo que quedó para después\n');
    git('add', '.'); git('commit', '-qm', 'base');
  }
  const estado = estadoDe(home);
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.writeFileSync(path.join(estado, 'active', `${DEST}.json`), JSON.stringify({ sessionId: DEST, storyId: '9.92', repoPath: destino, startedAt: new Date(AHORA).toISOString() }));
  const P = { base, home, destino, coordinadora, estado };
  P.argv = (repo, forSession) => [MARKER, 'approve-pending', '--id', 'DEF-x', '--repo', repo, ...(forSession ? ['--for-session', forSession] : [])];
  P.cmd = (repo, forSession) => `node ${P.argv(repo, forSession).map(comillas).join(' ')}`;
  /** `exigir` en proceso, con el control previo del guion: quién pide, desde qué carpeta y si es la designada. */
  P.exigir = ({ repo, forSession, propia, cwd, designada = (s) => s === COORD }) => ow.exigir({ firma: PA.FIRMA, argv: P.argv(repo, forSession), pid: 301,
    arbol: arbolDelGuion(home, P.cmd(repo, forSession)), casa: home, ahora: AHORA + 60000, propia: undefined, anotar: () => {}, notificar: () => {},
    antes: (via, registro) => DS.antesDelPendiente({ via, registro, propia, pedida: forSession || null, estado, cwd, repo, designada }) });
  P.aprobaciones = () => { try { return fs.readdirSync(path.join(destino, PA.RECORD_DIR)); } catch (_) { return []; } };
  /** El guion de verdad en el chequeo previo del freno, con la vía `avisado`. */
  P.previo = (sid, args, cwd) => spawnSync(process.execPath, [MARKER, 'approve-pending', ...args], { cwd, encoding: 'utf8',
    env: ambiente(home, sid, { TYCON_SIGN_PRECHECK: '1', TYCON_SIGN_PRECHECK_VIA: 'avisado' }) });
  return P;
}

test('T9 ApprovePending_AvisadoOwnSession_Denied @story-8.255 @ac-8', (t) => {
  const P = pendiente(t);
  registrar(P.home, { firma: PA.FIRMA, cmd: P.cmd(P.destino), sesion: DEST, destino: DEST, via: 'avisado' });
  const r = P.exigir({ repo: P.destino, propia: DEST, cwd: P.destino });
  assert.notStrictEqual(r.codigo, 0, r.motivo);
  assert.match(r.motivo, /lo aprueba una persona o la coordinadora/);
  assert.strictEqual(vigentes(P.home).length, 1, 'el pedido no se consume');
  // un registro sin destino, o con el destino vacío
  for (const destino of [undefined, '']) {
    const Q = pendiente(t);
    registrar(Q.home, { firma: PA.FIRMA, cmd: Q.cmd(Q.destino), sesion: DEST, destino, via: 'avisado' });
    const s = Q.exigir({ repo: Q.destino, propia: DEST, cwd: Q.destino });
    assert.notStrictEqual(s.codigo, 0, s.motivo);
    assert.match(s.motivo, /el registro de la firma no dice para qué sesión es/);
    assert.strictEqual(vigentes(Q.home).length, 1, 'el pedido no se consume');
  }
  // el guion de verdad, en el chequeo previo: la sesión que abrió el pendiente no se lo aprueba
  const p = P.previo(DEST, ['--id', 'DEF-x'], P.destino);
  assert.notStrictEqual(p.status, 0, salida(p));
  assert.match(p.stderr, /lo aprueba una persona o la coordinadora/);
  assert.doesNotMatch(p.stdout, /tycon-sign-precheck: ok/);
  assert.deepStrictEqual(P.aprobaciones(), [], 'nada en tasks/pending-approvals/');
});

test('T10 ApprovePending_AvisadoNotDesignated_Denied @story-8.255 @ac-9', (t) => {
  const P = pendiente(t);
  registrar(P.home, { firma: PA.FIRMA, cmd: P.cmd(P.destino, DEST), sesion: 'ses-otra', destino: DEST, via: 'avisado' });
  const r = P.exigir({ repo: P.destino, forSession: DEST, propia: 'ses-otra', cwd: P.coordinadora });
  assert.notStrictEqual(r.codigo, 0, r.motivo);
  assert.match(r.motivo, /la sesión que pide no es la coordinadora designada/);
  // el guion de verdad, en el chequeo previo: sin coordinadora confirmada en el perfil, nadie es la designada
  const p = P.previo('ses-otra', ['--id', 'DEF-x', '--repo', P.destino, '--for-session', DEST], P.coordinadora);
  assert.notStrictEqual(p.status, 0, salida(p));
  assert.match(p.stderr, /no es la coordinadora designada/);
  assert.deepStrictEqual(P.aprobaciones(), []);
});

test('T11 ApprovePending_DelegatedWrongRepo_Denied @story-8.255 @ac-10 @ac-17', (t) => {
  // el pendiente en el checkout de la coordinadora
  const P = pendiente(t);
  registrar(P.home, { firma: PA.FIRMA, cmd: P.cmd(P.coordinadora, DEST), sesion: COORD, destino: DEST, via: 'delegacion', extra: { maquina: 'm' } });
  const r = P.exigir({ repo: P.coordinadora, forSession: DEST, propia: COORD, cwd: P.coordinadora });
  assert.notStrictEqual(r.codigo, 0, r.motivo);
  assert.match(r.motivo, /es un repo de la coordinadora/);
  assert.strictEqual(vigentes(P.home).length, 1);
  // el marcador de la sesión destino que no se puede leer
  const Q = pendiente(t);
  fs.writeFileSync(path.join(Q.estado, 'active', `${DEST}.json`), '{ no es json');
  registrar(Q.home, { firma: PA.FIRMA, cmd: Q.cmd(Q.destino, DEST), sesion: COORD, destino: DEST, via: 'delegacion', extra: { maquina: 'm' } });
  const s = Q.exigir({ repo: Q.destino, forSession: DEST, propia: COORD, cwd: Q.coordinadora });
  assert.notStrictEqual(s.codigo, 0, s.motivo);
  assert.match(s.motivo, /no pude leer el marcador o el arreglo rápido de la sesión ses-a/);
  assert.strictEqual(vigentes(Q.home).length, 1);
});

test('T12 ApprovePending_DelegatedDestinationRepo_Signs @story-8.255 @ac-11', (t) => {
  const P = pendiente(t);
  registrar(P.home, { firma: PA.FIRMA, cmd: P.cmd(P.destino, DEST), sesion: COORD, destino: DEST, via: 'delegacion', extra: { maquina: 'm' } });
  const r = P.exigir({ repo: P.destino, forSession: DEST, propia: COORD, cwd: P.coordinadora });
  assert.strictEqual(r.codigo, 0, r.motivo);
  assert.strictEqual(r.via, 'delegacion');
  assert.strictEqual(vigentes(P.home).length, 0, 'el pedido se gastó');
  // y con el registro completo, el control lo da por bueno: es la coordinadora y el repo es de la sesión destino
  assert.strictEqual(DS.antesDelPendiente({ via: 'delegacion', registro: { via: 'delegacion', sesion: COORD, destino: DEST, comando: 'x' },
    estado: P.estado, cwd: P.coordinadora, repo: P.destino, designada: (s) => s === COORD }), null);
  // con persona (la ventana, un click, la terminal) el control no mira nada, aunque la que pide sea la destino
  const nadie = () => { throw new Error('con persona no se pregunta por la coordinadora'); };
  for (const [via, registro] of [['ventana', { sesion: DEST, destino: DEST, comando: 'x' }], ['ventana', { via: 'click', sesion: DEST, destino: DEST, comando: 'x' }], ['terminal', null]]) {
    assert.strictEqual(DS.antesDelPendiente({ via, registro, propia: DEST, estado: P.estado, cwd: P.destino, repo: P.destino, designada: nadie }), null, `${via} ${JSON.stringify(registro)}`);
  }
});

// la firma de trámite de un pendiente: la línea que escribe approve-pending lleva la vía de su renglón firmado, y el
// control del commit la da por buena
test('T12b ApprovePending_FirmaDeTramite_ElCommitLaAcepta', (t) => {
  const P = pendiente(t);
  registrar(P.home, { firma: PA.FIRMA, cmd: P.cmd(P.destino, DEST), sesion: COORD, destino: DEST, via: 'automatica', extra: { maquina: 'm' } });
  const linea = PA.lineaNueva({ id: 'DEF-x', maquina: 'm', ahora: AHORA });
  const renglones = [];
  const r = ow.exigir({ firma: PA.FIRMA, argv: P.argv(P.destino, DEST), pid: 301, arbol: arbolDelGuion(P.home, P.cmd(P.destino, DEST)), casa: P.home,
    ahora: AHORA + 60000, propia: undefined, resumen: `huella ${linea.huella} · DEF-x · el arreglo`, anotar: (g) => renglones.push(g), notificar: () => {},
    avisarSinAprobacion: () => {},
    antes: (via, registro) => DS.antesDelPendiente({ via, registro, propia: COORD, pedida: DEST, estado: P.estado, cwd: P.coordinadora, repo: P.destino, designada: (s) => s === COORD }) });
  assert.strictEqual(r.codigo, 0, r.motivo);
  assert.strictEqual(r.automatica, true, JSON.stringify(r));
  assert.strictEqual(renglones.length, 1);
  assert.strictEqual(renglones[0].via, 'automatica');
  const escrita = { ...linea, via: PA.viaDeLaFirma(r), quien: ow.quienFirmo(r, 'persona').quien };
  assert.strictEqual(escrita.via, 'automatica');
  const tramite = () => ({ ok: true });
  assert.deepStrictEqual(PA.revisarNuevas({ antes: '', despues: `${JSON.stringify(escrita)}\n`, renglones, deTramite: tramite }), [], 'el commit acepta la firma de trámite');
  // con la vía que devuelve `exigir` (la de la delegación), el commit la rechazaba
  const comoAntes = { ...escrita, via: r.via };
  assert.strictEqual(PA.revisarNuevas({ antes: '', despues: `${JSON.stringify(comoAntes)}\n`, renglones, deTramite: tramite }).length, 1);
  // si el perfil ya no la tiene como trámite (la pasó a «sólo del dueño»), la línea pide la firma de una persona
  const delDueno = PA.revisarNuevas({ antes: '', despues: `${JSON.stringify(escrita)}\n`, renglones, deTramite: () => ({ ok: false, motivo: '«pending-approval» es sólo del dueño (approvals.owner_only)' }) });
  assert.strictEqual(delDueno.length, 1);
  assert.match(delDueno[0].motivo, /ya no es de trámite .*sólo del dueño.*lo firma una persona/);
  // y una línea de otra vía no pregunta por el trámite
  const otra = { ...escrita, via: 'delegacion' };
  const conDelegacion = [{ ...renglones[0], via: 'delegacion' }];
  assert.deepStrictEqual(PA.revisarNuevas({ antes: '', despues: `${JSON.stringify(otra)}\n`, renglones: conDelegacion, deTramite: () => { throw new Error('no pregunta'); } }), []);
});

// ── las firmas de rutina que se delegan ──────────────────────────────────────────────────────────────────────────

const CLI = "#!/usr/bin/env node\n'use strict';\nconst sub = process.argv[2];\nif (sub === 'get') console.log('hola');\n";

/** compare-waiver: un repo con su origin, el comando cambiado en la rama, y la corrida de la sesión en «Preparar». */
function comparacion(t, { sensible }) {
  const base = tmp(t, 'sin-persona-cw-');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const origen = path.join(base, 'repo.git');
  const repo = path.join(base, 'repo');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', HOME: home };
  const g = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  fs.mkdirSync(repo);
  g('init', '-q', '-b', 'main');
  g('remote', 'add', 'origin', origen);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.advisors/\n');
  fs.writeFileSync(path.join(repo, 'cli.js'), CLI);
  g('add', '.'); g('commit', '-qm', 'inicio'); g('push', '-q', 'origin', 'main'); g('fetch', '-q', 'origin');
  g('checkout', '-q', '-b', 'story/9.9');
  const storyPath = path.join(repo, 'specs', 'story-9.9-cmp.md');
  fs.mkdirSync(path.dirname(storyPath), { recursive: true });
  fs.writeFileSync(storyPath, ['---', 'story: "9.9"', 'epic: "9"', 'status: in-progress', ...(sensible ? ['sensible: seguridad'] : []), 'files_to_modify:', '  - cli.js', '---', '', '# Story 9.9', ''].join('\n'));
  g('add', '.'); g('commit', '-qm', 'la historia');
  const baseSha = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'cli.js'), CLI.replace("'hola'", "'hola!'"));
  const estado = estadoDe(home);
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.writeFileSync(path.join(estado, 'active', 's-cw.json'), JSON.stringify({ storyId: '9.9', sessionId: 's-cw', stepScheme: 2, startedAt: new Date(AHORA).toISOString(),
    lastTouch: new Date(AHORA).toISOString(), stepsCompleted: PASOS.slice(0, -1), stepsPending: ['prepare-commit'], iterations: {}, storyPath, repoPath: repo, baseSha,
    filesTouched: [path.join(repo, 'cli.js')], fileEvents: [] }));
  const correr = (opciones) => spawnSync(process.execPath, [MARKER, 'compare-waiver', '--story', storyPath, '--command', 'cli.js', '--reason', 'usa la red'],
    { cwd: repo, encoding: 'utf8', env: conVentana(ambiente(home, 's-cw'), opciones) });
  const marcador = () => JSON.parse(fs.readFileSync(path.join(estado, 'active', 's-cw.json'), 'utf8'));
  return { correr, runDir: () => require(PIPELINE).resolveRunDir(repo, '9.9', true, storyPath), estado, marcador };
}

/** e2e-setup.js: una tienda con su página y su historia con pantalla, y npm/npx de mentira. */
function tienda(t, { sensible }) {
  const base = tmp(t, 'sin-persona-bt-');
  const home = path.join(base, 'home');
  const repo = path.join(base, 'tienda');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(repo, 'frontend', 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'stories'));
  fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "name": "tienda",\n  "version": "1.0.0"\n}\n');
  fs.writeFileSync(path.join(repo, 'frontend', 'index.html'), '<!doctype html><title>Tienda</title><p id="precio"></p>\n');
  fs.writeFileSync(path.join(repo, 'frontend', 'src', 'main.js'), 'export {};\n');
  const story = path.join(repo, 'stories', 'story-1.1-precio.md');
  fs.writeFileSync(story, ['---', 'story: "1.1"', 'title: "El precio en pesos"', 'status: in-progress', ...(sensible ? ['sensible: seguridad'] : []),
    'files_to_modify:', '  - frontend/src/main.js', '---', '', '# Story 1.1', ''].join('\n'));
  const git = gitInit(repo);
  git('add', '.'); git('commit', '-qm', 'base');
  fs.mkdirSync(bin);
  for (const n of ['npm', 'npx']) { fs.writeFileSync(path.join(bin, n), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(bin, n), 0o755); }
  const estado = estadoDe(home);
  const correr = (args, sid, opciones) => spawnSync(process.execPath, [E2E, ...args, '--repo', repo, '--story', story], { cwd: repo, encoding: 'utf8',
    env: conVentana(ambiente(home, sid, { PATH: `${bin}${path.delimiter}${process.env.PATH}` }), opciones) });
  /** La oferta que el arnés le mostró a la persona: sin ella el «no» no vale. */
  const oferta = (sid) => {
    fs.mkdirSync(estado, { recursive: true });
    fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify({ name: bt.OFFER_SHOWN, ts: new Date(AHORA).toISOString(), story: '1.1', repoPath: repo, sessionId: sid })}\n`);
  };
  return { repo, story, estado, correr, oferta };
}

/** El cierre de una ejecución perdida cuya historia se partió en tandas después de su apertura. */
function particion(t, { sensible }) {
  const base = tmp(t, 'sin-persona-lr-');
  const home = path.join(base, 'home');
  const codigo = path.join(base, 'codigo');
  const historias = path.join(base, 'historias');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const git = (repo, fecha, ...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  // stable-data: las fechas de los commits y de la apertura son fijas
  const [ANTES, APERTURA, DESPUES] = ['2026-01-01T10:00:00Z', '2026-01-02T10:00:00.000Z', '2026-01-03T10:00:00Z'];
  for (const repo of [codigo, historias]) {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ANTES, 'init', '-q', '-b', 'feat/x'); git(repo, ANTES, 'config', 'user.email', 't@t'); git(repo, ANTES, 'config', 'user.name', 't');
  }
  fs.mkdirSync(path.join(codigo, 'src'));
  fs.writeFileSync(path.join(codigo, 'src', 'a.js'), 'module.exports = 1;\n');
  git(codigo, ANTES, 'add', '.'); git(codigo, ANTES, 'commit', '-qm', 'inicio');
  fs.mkdirSync(path.join(historias, 'specs'));
  const story = path.join(historias, 'specs', 'story-9.7-partida.md');
  const cabeza = ['---', 'story: "9.7"', 'title: "partida"', 'status: in-progress', ...(sensible ? ['sensible: seguridad'] : [])];
  fs.writeFileSync(story, [...cabeza, 'files_to_modify:', '  - src/a.js', '---', '', '# Story 9.7', ''].join('\n'));
  git(historias, ANTES, 'add', '.'); git(historias, ANTES, 'commit', '-qm', 'la historia');
  fs.writeFileSync(story, [...cabeza, 'pipelines:', '  - name: A-uno', '    status: pending', '  - name: B-dos', '    status: pending', 'files_to_modify:', '  - src/a.js', '---', '', '# Story 9.7', ''].join('\n'));
  git(historias, DESPUES, 'commit', '-qam', 'la historia se parte');
  or.abrir({ sid: 's-p', story: '9.7', storyPath: story, repo: codigo, runDir: path.join(codigo, '.advisors', 'pipeline-runs', '9.7-s-p'), home, ahora: APERTURA });
  const gates = path.join(estadoDe(home), 'gates.log');
  const cerrada = () => lineas(gates).some((e) => e.sesion === 's-p' && e.name === 'run-close');
  const correr = (args, opciones) => spawnSync(process.execPath, [MARKER, 'clear-session', 's-p', ...args], { cwd: codigo, encoding: 'utf8', input: '',
    env: conVentana(ambiente(home, 's-p', { TYCON_TIME_TRACKING: 'none', TYCON_GUIDES_DIR: RAIZ }), opciones) });
  return { correr, cerrada };
}

const DELEGADA = { delegadaPor: COORD };
const DELICADA = /historia delicada/;

test('T13 DelegatedLevelOne_DelicateStory_Denied @story-8.255 @ac-12', (t) => {
  // eximir de la comparación con main
  const CWF = require(path.join(SCRIPTS, 'lib', 'compare-waiver.js')).FILE;
  const cwd = comparacion(t, { sensible: true });
  const cd = cwd.correr(DELEGADA);
  assert.notStrictEqual(cd.status, 0, salida(cd));
  assert.match(cd.stderr, DELICADA);
  assert.ok(!fs.existsSync(path.join(cwd.runDir(), CWF)), 'compare-waiver delicada: no exime');
  const cwr = comparacion(t, { sensible: false });
  const cr = cwr.correr(DELEGADA);
  assert.strictEqual(cr.status, 0, salida(cr));
  // preparar la prueba con navegador
  const bd = tienda(t, { sensible: true });
  const pd = bd.correr(['prepare', '--approved-by', 'Dev'], 's-bt', DELEGADA);
  assert.notStrictEqual(pd.status, 0, salida(pd));
  assert.match(pd.stderr, DELICADA);
  assert.ok(!fs.existsSync(path.join(bd.repo, '.tycon', 'e2e-setup.json')), 'prepare delicada: no prepara nada');
  // de rutina pasa la firma (el npm de juguete no instala nada: lo que sigue a la firma no es lo que se mide acá)
  const br = tienda(t, { sensible: false });
  const pr = br.correr(['prepare', '--approved-by', 'Dev'], 's-bt', DELEGADA);
  assert.doesNotMatch(pr.stderr, /no preparo nada/, salida(pr));
  assert.ok(lineas(path.join(br.estado, 'gates.log')).some((g) => g.name === 'browser-test-signed' && g.via === 'delegacion'), salida(pr));
  // decir que no a la prueba con navegador: por delegación nunca; con la ventana, como hoy
  for (const sensible of [true, false]) {
    const b = tienda(t, { sensible });
    b.oferta('s-bt');
    const d = b.correr(['defer', '--approved-by', 'Dev', '--no', 'no, por ahora no'], 's-bt', DELEGADA);
    assert.notStrictEqual(d.status, 0, `defer ${sensible ? 'delicada' : 'de rutina'}: ${salida(d)}`);
    assert.match(d.stderr, /decir que no a la prueba con navegador lo decide una persona/);
    assert.doesNotMatch(fs.readFileSync(b.story, 'utf8'), /browser_test: deferred/);
  }
  const bv = tienda(t, { sensible: false });
  bv.oferta('s-bt');
  const v = bv.correr(['defer', '--approved-by', 'Dev', '--no', 'no, por ahora no'], 's-bt', {});
  assert.strictEqual(v.status, 0, salida(v));
  assert.match(fs.readFileSync(bv.story, 'utf8'), /browser_test: deferred/);
  // cerrar una ejecución perdida por la partición de su historia: la de rutina sí; la delicada, no. La de nivel 2
  // (`lost-run`) sale por delegación: es una excepción de trámite, y el perfil la delega con su nombre
  const ld = particion(t, { sensible: true });
  const xd = ld.correr(['--lost', '--partition'], DELEGADA);
  assert.notStrictEqual(xd.status, 0, salida(xd));
  assert.match(xd.stderr, DELICADA);
  assert.ok(!ld.cerrada(), 'delicada: la ejecución sigue abierta');
  const lr = particion(t, { sensible: false });
  const xr = lr.correr(['--lost', '--partition'], DELEGADA);
  assert.strictEqual(xr.status, 0, salida(xr));
  assert.ok(lr.cerrada());
  const ll = particion(t, { sensible: false });
  const xl = ll.correr(['--lost'], DELEGADA);
  assert.strictEqual(xl.status, 0, salida(xl));
  assert.ok(ll.cerrada(), 'lost-run por delegación: la cierra la coordinadora');
  // sin poder leer el plan o la historia no se sabe si es de rutina: cuenta como delicada
  const cwl = comparacion(t, { sensible: false });
  const m = cwl.marcador();
  assert.strictEqual(PR().rutinaParaDelegar({ marker: m }), null);
  const plan = path.join(cwl.runDir(), 'step-02-bmad-plan.md');
  fs.mkdirSync(plan);
  assert.match(PR().rutinaParaDelegar({ marker: m }).motivo, /no pude leer su plan/);
  fs.rmdirSync(plan);
  fs.rmSync(m.storyPath);
  assert.match(PR().rutinaParaDelegar({ marker: m }).motivo, /no pude leer la historia/);
});
