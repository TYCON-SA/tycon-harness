#!/usr/bin/env node
/**
 * reviewer-launch-gate.test.js — los revisores del arnés no salen mientras el pase adversarial que corresponde no esté
 * en vuelo, y un lanzamiento negado no queda anotado como revisor corrido.
 *
 * Qué fija esta suite: (1) el freno niega con el mismo criterio que `next` (`accionDelPase`), en los tres casos que
 * piden lanzar o relanzar el pase o consultar su portón; (2) deja pasar todo lo demás y dice por qué (`reason`), así un
 * freno caído no pasa por uno que dejó pasar por la regla; (3) lo que no puede leer lo deja pasar y lo anota; (4)
 * `on-advisor-run.js` no anota el lanzamiento negado, salvo que el freno no esté registrado en la configuración.
 *
 * Todo corre con los guiones reales en procesos hijos, una HOME temporal por caso (con su carpeta de estado y su
 * configuración de Claude Code), `TYCON_PROFILE=0` y el id de sesión fijado en el hijo: una prueba corrida desde una
 * sesión de agente hereda el suyo. La historia de ensayo vive fuera de `specs/`.
 *
 * stable-data: lee el reloj a propósito — la regla de un pase de otra sesión compara contra la hora actual; las pruebas
 * fijan edades relativas a «ahora» y ningún resultado compara una hora absoluta.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/reviewer-launch-gate.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const GATE = path.join(SCRIPTS, 'reviewer-launch-gate.js');
const ADVISOR_RUN = path.join(SCRIPTS, 'on-advisor-run.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const MARKER = path.join(SCRIPTS, 'marker.js');

const SID = 'sesion-freno-revisores-1';
const OTRA = 'sesion-ajena-freno-2';
const COORD = 'sesion-coordinadora-3';
const REVISOR = 'tycon-plugin-security-basics';
const OTRO_REVISOR = 'tycon-plugin-tests-coverage';
const POSIX = { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? 'permisos POSIX' : false };

// Variables de quien corre la suite que cambian una decisión: fuera, siempre.
const DEL_ENTORNO = ['TYCON_NO_DEEP_REVIEW', 'DOD_BYPASS', 'TYCON_5B_EARLY', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID', 'STOP_AUTONOMY', 'TYCON_PROFILE', 'TCG', 'TYCON_STATE_DIR', 'NODE_TEST_CONTEXT',
  'TYCON_PACKS_DIR', 'TYCON_PACKS_DEFAULT', 'TYCON_AGENTS_DIR', 'TYCON_SPAWN_GOVERNANCE', 'TYCON_AUTO_SNAPSHOT',
  'TYCON_REVIEW_ROSTER'];

const hace = (min) => new Date(Date.now() - min * 60000).toISOString();

function entorno(home, extra) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  return { ...env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_PROFILE: '0', ...(extra || {}) };
}

/** Una máquina de ensayo: HOME con la carpeta de estado, la configuración con el freno registrado y un repo con su
 *  historia (fuera de `specs/`). `registrado: false` deja la configuración sin el freno. */
function maquina({ registrado = true } = {}) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freno-revisores-')));
  const home = path.join(raiz, 'home');
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const hooks = registrado
    ? { PreToolUse: [{ matcher: 'Task|Agent', hooks: [{ type: 'command', command: `node ${GATE}` }] }] }
    : { PreToolUse: [{ matcher: 'Task|Agent', hooks: [{ type: 'command', command: `node ${ADVISOR_RUN}` }] }] };
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks }));
  const repo = path.join(raiz, 'repo');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  const story = path.join(repo, 'docs', 'historia-a.md');
  fs.writeFileSync(story, '---\nstory: "A"\nepic: 1\nstatus: in-progress\nfiles_to_create: []\nfiles_to_modify:\n  - scripts/x.js\n---\n\n# Story A\n\n## Acceptance Criteria\n\n1. criterio\n');
  return { raiz, home, estado, repo, story };
}
const limpiar = (m) => fs.rmSync(m.raiz, { recursive: true, force: true });

const LANZADO = () => ({ launchedAtStep: 4, runId: 'r1', sessionId: SID, launchedAt: hace(10) });
const CORRE = { run: true, early_launch: true, files: ['scripts/x.js'] };

/** El marcador de la sesión con «Correr las pruebas» cerrado (el paso siguiente es «Revisores»). */
function marcador(m, extra, sid = SID) {
  const datos = {
    storyId: 'A', storyPath: m.story, repoPath: m.repo, sessionId: sid,
    startedAt: hace(60), lastTouch: hace(0), stepsCompleted: [0, 1, 2, 3, 4], stepsPending: [5, 6, 7, 8],
    filesTouched: [], iterations: {}, fileEvents: [], clockiStarted: true, adoMarkedActive: true, ...extra,
  };
  for (const k of Object.keys(datos)) if (datos[k] === undefined) delete datos[k];
  fs.writeFileSync(path.join(m.estado, 'active', `${sid}.json`), JSON.stringify(datos));
}

const evento = (m, tipo = REVISOR, extra) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: SID, cwd: m.repo,
  tool_input: { subagent_type: tipo, prompt: 'revisá el diff' }, ...(extra || {}),
});

function freno(m, ev, extra) {
  const r = spawnSync(process.execPath, [GATE], { input: JSON.stringify(ev), encoding: 'utf8', env: entorno(m.home, extra), cwd: m.repo });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Lo que devuelve `decide` para el evento, en un proceso hijo con la HOME del caso. */
function decision(m, ev, extra) {
  const codigo = 'const { decide } = require(process.argv[1]); process.stdout.write(JSON.stringify(decide(JSON.parse(process.argv[2]))));';
  const r = spawnSync(process.execPath, ['-e', codigo, GATE, JSON.stringify(ev)], { encoding: 'utf8', env: entorno(m.home, extra), cwd: m.repo });
  assert.strictEqual(r.status, 0, `decide tiró: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function registro(m, nombre) {
  const p = path.join(m.estado, nombre);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const frenados = (m) => registro(m, 'gates.log').filter((g) => g.name === 'reviewer-launch-blocked');
const ilegibles = (m) => registro(m, 'gates.log').filter((g) => g.name === 'reviewer-launch-gate-unreadable');

/** Un paquete de revisores de ensayo, activo con `TYCON_PACKS_DEFAULT=all`. `roto: true` deja el manifiesto ilegible. */
function paquete(m, { roto = false } = {}) {
  const dir = path.join(m.raiz, 'paquetes');
  const p = path.join(dir, 'ensayo');
  fs.mkdirSync(path.join(p, 'agents'), { recursive: true });
  const revisores = [
    { agent: 'rev-ensayo', group: 'base', when: { detection: 'csModified' }, surface: { paths: ['**/*.cs'] }, depth: 'lean', prefixes: ['RVE'] },
    { agent: 'val-ensayo', group: 'validacion', when: { detection: 'csModified' }, prefixes: ['VLE'], prompt: 'Validá {story_path} contra {repo_path}.' },
  ];
  fs.writeFileSync(path.join(p, 'pack.json'), roto ? '{ esto no es json' : JSON.stringify({ name: 'ensayo', description: 'paquete de ensayo', guides: [], reviewers: revisores }));
  for (const a of ['rev-ensayo', 'val-ensayo']) fs.writeFileSync(path.join(p, 'agents', `${a}.md`), `---\nname: ${a}\n---\n# ${a}\n`);
  return { TYCON_PACKS_DIR: dir, TYCON_PACKS_DEFAULT: 'all' };
}

/** La coordinadora designada y viva, y otra sesión viva con su pase en vuelo: el turno del pase está ocupado. */
function turnoOcupado(m) {
  fs.appendFileSync(path.join(m.estado, 'gates.log'), `${JSON.stringify({ ts: hace(30), name: 'relay-designation', status: 'ok', sesion: COORD, rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' })}\n`);
  for (const [sid, nombre] of [[COORD, 'Coordinadora'], [OTRA, 'Otra'], [SID, 'Propia']]) {
    fs.writeFileSync(path.join(m.home, '.claude', 'sessions', `${sid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name: nombre, nameSource: 'user', status: 'busy', statusUpdatedAt: Date.now(), cwd: m.raiz }));
  }
  fs.writeFileSync(path.join(m.estado, 'active', `${OTRA}.json`), JSON.stringify({ sessionId: OTRA, storyId: 'B', stepsPending: [6], lastTouch: hace(0), adversarial: { launchedAt: hace(5), runId: 'wf_otra' } }));
}

/** La conversación de otra sesión, con su última modificación hace `min` minutos. */
function conversacion(m, sid, min) {
  const d = path.join(m.home, '.claude', 'projects', 'carpeta');
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, `${sid}.jsonl`);
  fs.writeFileSync(p, '{}\n');
  const t = new Date(Date.now() - min * 60000);
  fs.utimesSync(p, t, t);
}

function assertNiega(r, nombre) {
  assert.strictEqual(r.status, 2, `${nombre}: el freno tiene que negar (salió ${r.status}): ${r.stderr}`);
}

// ── El freno ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('T1 Revisor_PortonCorreSinPase_Niega @story-7.55 @ac-1', () => {
  const m = maquina();
  try {
    marcador(m, { adversarialGate: CORRE });
    const comando = `node ${MARKER} mark-adversarial-launched <runId> 4`;
    const r = freno(m, evento(m));
    assertNiega(r, 'revisor del núcleo');
    assert.ok(r.stderr.includes(comando), `trae el comando entero de mark-adversarial-launched: ${r.stderr}`);
    assert.match(r.stderr, /no lo relances|no se relanza/, 'avisa que un pase ya lanzado en este turno no se relanza');
    assert.strictEqual(decision(m, evento(m)).kind, 'lanzar-pase');

    const conPaquete = paquete(m);
    assertNiega(freno(m, evento(m, 'rev-ensayo'), conPaquete), 'revisor de un paquete activo');

    // la designación de la coordinadora ilegible: la consulta del turno no se pudo hacer, y `next` pide lanzar igual
    const log = path.join(m.estado, 'gates.log');
    fs.writeFileSync(log, '');
    if (!POSIX.skip) {
      fs.chmodSync(log, 0o000);
      try {
        const sinTurno = freno(m, evento(m));
        assertNiega(sinTurno, 'sin poder consultar el turno');
        assert.ok(sinTurno.stderr.includes(comando), sinTurno.stderr);
      } finally { fs.chmodSync(log, 0o600); }
    }
  } finally { limpiar(m); }
});

test('T2 Revisor_SinVeredicto_PideElPorton @story-7.55 @ac-2', () => {
  const m = maquina();
  try {
    marcador(m, {});
    const r = freno(m, evento(m));
    assertNiega(r, 'sin veredicto del portón');
    const comando = `node ${PIPELINE} deep-review-gate --repo ${m.repo} --story ${m.story} --files <archivos de código del diff>`;
    assert.ok(r.stderr.includes(comando), `trae el comando entero de deep-review-gate: ${r.stderr}`);
    assert.strictEqual(decision(m, evento(m)).kind, 'consultar-porton');
  } finally { limpiar(m); }
});

test('T3 Negativa_QuedaEnGatesLog @story-7.55 @ac-3', () => {
  const m = maquina();
  try {
    marcador(m, { adversarialGate: CORRE });
    assertNiega(freno(m, evento(m)), 'el caso de T1');
    const f = frenados(m);
    assert.strictEqual(f.length, 1, `un renglón por negativa: ${JSON.stringify(f)}`);
    assert.strictEqual(f[0].kind, 'lanzar-pase');
    assert.strictEqual(f[0].subagent_type, REVISOR);
    assert.strictEqual(f[0].storyId, 'A');
    assert.strictEqual(f[0].sessionId, SID);
  } finally { limpiar(m); }
});

// ── Lo que no frena ──────────────────────────────────────────────────────────────────────────────────────────────

/** Sale, con el motivo esperado y sin renglones del freno en `gates.log`. */
function assertDeja(m, ev, reason, extra, nombre) {
  const r = freno(m, ev, extra);
  assert.strictEqual(r.status, 0, `${nombre}: el freno tiene que dejar pasar (salió ${r.status}): ${r.stderr}`);
  const d = decision(m, ev, extra);
  assert.strictEqual(d.deny, false, `${nombre}: ${JSON.stringify(d)}`);
  assert.strictEqual(d.reason, reason, `${nombre}: el motivo de la salida: ${JSON.stringify(d)}`);
  assert.deepStrictEqual(frenados(m), [], `${nombre}: sin renglón de negativa`);
}

test('T4 PaseEnVuelo_Deja @story-7.55 @ac-4', () => {
  const m = maquina();
  try {
    marcador(m, { adversarialGate: CORRE, adversarial: LANZADO() });
    assertDeja(m, evento(m), 'pass-in-flight', undefined, 'pase propio en vuelo');
    assert.deepStrictEqual(ilegibles(m), []);
  } finally { limpiar(m); }
});

test('T5 PaseAtendido_Deja @story-7.55 @ac-5', () => {
  const casos = [
    ['salteado por el portón', { adversarialGate: { run: false, early_launch: true, files: [] }, adversarialSkip: { runId: 'r0' } }],
    ['con resultado', { adversarialGate: CORRE, adversarial: LANZADO(), adversarialPasses: [{ tipo: '5b', ts: hace(1), veredicto: 'medido' }] }],
    ['abandonado', { adversarialGate: CORRE, adversarial: LANZADO(), adversarialSkip: { runId: 'r1', abandonado: true } }],
  ];
  for (const [nombre, extra] of casos) {
    const m = maquina();
    try {
      marcador(m, extra);
      assertDeja(m, evento(m), 'pass-handled', undefined, nombre);
    } finally { limpiar(m); }
  }
});

test('T6 TempranoApagado_Deja @story-7.55 @ac-6', () => {
  const casos = [
    ['temprano apagado', { adversarialGate: { run: true, early_launch: false, files: [] } }],
    ['temprano apagado con el pase no medido', {
      adversarialGate: { run: true, early_launch: false, files: [] }, adversarial: LANZADO(),
      adversarialPasses: [{ tipo: '5b', ts: hace(1), veredicto: 'no-medido', motivo_no_medido: 'una lente sin medir' }],
    }],
  ];
  for (const [nombre, extra] of casos) {
    const m = maquina();
    try {
      marcador(m, extra);
      assertDeja(m, evento(m), 'early-off', undefined, nombre);
    } finally { limpiar(m); }
  }
});

test('T7 NoRevisorOAntes_Deja @story-7.55 @ac-7', () => {
  const m = maquina();
  try {
    // «Correr las pruebas» abierto
    marcador(m, { adversarialGate: CORRE, stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8] });
    assertDeja(m, evento(m), 'tests-open', undefined, 'pruebas abiertas');
    // sin marcador
    fs.rmSync(path.join(m.estado, 'active', `${SID}.json`));
    assertDeja(m, evento(m), 'no-marker', undefined, 'sin marcador');
    marcador(m, { adversarialGate: CORRE });
    for (const tipo of ['general-purpose', 'Explore', 'Plan', 'claude']) assertDeja(m, evento(m, tipo), 'exploration', undefined, tipo);
    for (const tipo of ['tycon-story-validator', 'tycon-story-adversarial-reviewer', 'tycon-retrospective-capturer', 'tycon-signed-scope-audit']) {
      assertDeja(m, evento(m, tipo), 'not-a-reviewer', undefined, tipo);
    }
    assertDeja(m, evento(m, 'val-ensayo'), 'not-a-reviewer', paquete(m), 'revisor de paquete del grupo validacion');
    assertDeja(m, { ...evento(m), tool_name: 'Bash' }, 'not-a-launch', undefined, 'otra herramienta');
    assertDeja(m, { ...evento(m), tool_input: { prompt: 'sin tipo' } }, 'no-subagent-type', undefined, 'sin subagent_type');
  } finally { limpiar(m); }

  // el turno del pase ocupado por otra sesión
  const t = maquina();
  try {
    marcador(t, { adversarialGate: CORRE });
    turnoOcupado(t);
    assertDeja(t, evento(t), 'turn-busy', undefined, 'turno ocupado');
  } finally { limpiar(t); }

  // un pase de otra sesión sin resultado: reciente y vivo, y vencido
  for (const [nombre, edad, hilo] of [['pase ajeno reciente y vivo', 5, 1], ['pase ajeno vencido', 120, 90]]) {
    const a = maquina();
    try {
      marcador(a, { adversarialGate: CORRE, adversarial: { launchedAtStep: 4, runId: 'r9', sessionId: OTRA, launchedAt: hace(edad) } });
      conversacion(a, OTRA, hilo);
      assertDeja(a, evento(a), 'foreign-pass', undefined, nombre);
    } finally { limpiar(a); }
  }
});

// ── Modos de falla ───────────────────────────────────────────────────────────────────────────────────────────────

test('T8 Ilegible_DejaYAnota @story-7.55 @ac-8', () => {
  const casos = [
    ['marcador-ilegible', (m) => fs.writeFileSync(path.join(m.estado, 'active', `${SID}.json`), '{ roto'), (m) => evento(m), undefined],
    ['sin-ruta-de-story', (m) => marcador(m, { adversarialGate: CORRE, storyPath: undefined }), (m) => evento(m), undefined],
    ['story-ilegible', (m) => marcador(m, { adversarialGate: CORRE, storyPath: path.join(m.repo, 'docs', 'no-existe.md') }), (m) => evento(m), undefined],
    ['sin-sesion', (m) => marcador(m, { adversarialGate: CORRE }), (m) => ({ ...evento(m), session_id: undefined }), undefined],
    // un tipo que no es del núcleo obliga a leer los paquetes, y el manifiesto roto tira adentro del freno
    ['error', (m) => marcador(m, { adversarialGate: CORRE }), (m) => evento(m, 'rev-ensayo'), (m) => paquete(m, { roto: true })],
  ];
  for (const [motivo, preparar, ev, env] of casos) {
    const m = maquina();
    try {
      preparar(m);
      const extra = env ? env(m) : undefined;
      const e = ev(m);
      const r = freno(m, e, extra);
      assert.strictEqual(r.status, 0, `${motivo}: deja pasar (salió ${r.status}): ${r.stderr}`);
      const g = ilegibles(m);
      assert.strictEqual(g.length, 1, `${motivo}: un renglón: ${JSON.stringify(registro(m, 'gates.log'))}`);
      assert.strictEqual(g[0].motivo, motivo);
      assert.deepStrictEqual(frenados(m), [], `${motivo}: no es una negativa`);
    } finally { limpiar(m); }
  }
});

// ── No-regresión ─────────────────────────────────────────────────────────────────────────────────────────────────

test('T9 Next_MismoPendingAction @story-7.55 @ac-9', () => {
  const casos = [
    ['T1 portón corre y sin pase', { adversarialGate: CORRE }, 'lanzar-pase'],
    ['T2 sin veredicto del portón', {}, 'consultar-porton'],
    ['T4 pase propio en vuelo', { adversarialGate: CORRE, adversarial: LANZADO() }, null],
    ['T5 salteado por el portón', { adversarialGate: { run: false, early_launch: true, files: [] }, adversarialSkip: { runId: 'r0' } }, null],
    ['T5 con resultado', { adversarialGate: CORRE, adversarial: LANZADO(), adversarialPasses: [{ tipo: '5b', ts: hace(1), veredicto: 'medido' }] }, null],
    ['T5 abandonado', { adversarialGate: CORRE, adversarial: LANZADO(), adversarialSkip: { runId: 'r1', abandonado: true } }, null],
    ['T6 temprano apagado', { adversarialGate: { run: true, early_launch: false, files: [] } }, null],
    ['T11 pase no medido', { adversarialGate: CORRE, adversarial: LANZADO(), adversarialPasses: [{ tipo: '5b', ts: hace(1), veredicto: 'no-medido', motivo_no_medido: 'una lente sin medir' }] }, 'relanzar-pase-no-medido'],
  ];
  const m = maquina();
  try {
    for (const [nombre, extra, esperado] of casos) {
      marcador(m, extra);
      const r = spawnSync(process.execPath, [PIPELINE, 'next'], { encoding: 'utf8', env: entorno(m.home), cwd: os.tmpdir() });
      assert.strictEqual(r.status, 0, `${nombre}: next salió ${r.status}: ${r.stderr}`);
      const pendiente = JSON.parse(r.stdout).pending_action;
      assert.strictEqual(pendiente ? pendiente.kind : null, esperado, `${nombre}: ${JSON.stringify(pendiente)}`);
    }
    // el freno decide con la misma función que `next`, la que exporta pipeline.js
    const codigo = 'const p = require(process.argv[1]); process.stdout.write(typeof p.accionDelPase);';
    const r = spawnSync(process.execPath, ['-e', codigo, PIPELINE], { encoding: 'utf8', env: entorno(m.home) });
    assert.strictEqual(r.stdout, 'function', `pipeline.js exporta accionDelPase: ${r.stderr}`);
  } finally { limpiar(m); }
});

/** Pasa el evento por `on-advisor-run.js` y devuelve su salida. */
function registrar(m, ev, extra) {
  const r = spawnSync(process.execPath, [ADVISOR_RUN], { input: JSON.stringify(ev), encoding: 'utf8', env: entorno(m.home, { TYCON_AUTO_SNAPSHOT: '0', ...(extra || {}) }), cwd: m.repo });
  assert.strictEqual(r.status, 0, `on-advisor-run nunca frena: ${r.stderr}`);
  return r;
}
const lanzamientos = (m) => registro(m, path.join('advisor-runs', `${SID}.jsonl`)).filter((l) => l.advisor);

test('T10 Negado_NoCuentaComoCorrido @story-7.55 @ac-10', () => {
  const m = maquina();
  try {
    // la ronda de revisores de esta iteración espera a los dos
    const runs = path.join(m.estado, 'advisor-runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, `${SID}.jsonl`), `${JSON.stringify({ ts: hace(2), event: 'step5-start', iter: 1, expected: [REVISOR, OTRO_REVISOR] })}\n`);

    marcador(m, { adversarialGate: CORRE });
    registrar(m, evento(m, REVISOR));
    assert.deepStrictEqual(lanzamientos(m).map((l) => l.advisor), [], 'el negado no deja renglón');

    marcador(m, { adversarialGate: CORRE, adversarial: LANZADO() });
    registrar(m, evento(m, OTRO_REVISOR));
    assert.deepStrictEqual(lanzamientos(m).map((l) => l.advisor), [OTRO_REVISOR], 'el que salió queda anotado');

    // check-count cuenta sólo el que salió y da el negado por faltante
    const cc = spawnSync(process.execPath, [PIPELINE, 'check-count', '--repo', m.repo, '--story', m.story], { encoding: 'utf8', env: entorno(m.home), cwd: m.repo });
    assert.notStrictEqual(cc.status, 0, `check-count no puede dar completa la ronda: ${cc.stdout}`);
    assert.ok(`${cc.stdout}${cc.stderr}`.includes(REVISOR), `nombra al negado como faltante: ${cc.stdout}${cc.stderr}`);

    // el registro de autoría, armado con ese registro, no trae al negado y sí al que salió
    const codigo = 'const r = require(process.argv[1]); const fs = require("fs"); const lines = fs.readFileSync(process.argv[2], "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l)); process.stdout.write(JSON.stringify(r.build({ lines, story: "A", sessionId: process.argv[3] })));';
    const rr = spawnSync(process.execPath, ['-e', codigo, path.join(SCRIPTS, 'lib', 'review-roster.js'), path.join(runs, `${SID}.jsonl`), SID], { encoding: 'utf8', env: entorno(m.home) });
    assert.strictEqual(rr.status, 0, rr.stderr);
    assert.ok(rr.stdout.includes(OTRO_REVISOR), `el registro de autoría trae al que salió: ${rr.stdout}`);
    assert.ok(!rr.stdout.includes(REVISOR), `y no al negado: ${rr.stdout}`);

    // el camino de Codex llama a recordLaunch directo, sin pasar por el freno: anota igual
    const codex = 'const { recordLaunch } = require(process.argv[1]); const r = recordLaunch({ sessionId: process.argv[2], cwd: process.argv[3], advisor: process.argv[4] }); process.stdout.write(String(r.ok));';
    marcador(m, { adversarialGate: CORRE });
    const rc = spawnSync(process.execPath, ['-e', codex, ADVISOR_RUN, SID, m.repo, REVISOR], { encoding: 'utf8', env: entorno(m.home, { TYCON_AUTO_SNAPSHOT: '0' }) });
    assert.strictEqual(rc.stdout, 'true', rc.stderr);
    assert.deepStrictEqual(lanzamientos(m).map((l) => l.advisor), [OTRO_REVISOR, REVISOR], 'recordLaunch anota aunque el freno negaría');
  } finally { limpiar(m); }

  // sin el freno registrado en la configuración: el lanzamiento se anota y se avisa
  const s = maquina({ registrado: false });
  try {
    marcador(s, { adversarialGate: CORRE });
    const r = registrar(s, evento(s, REVISOR));
    assert.deepStrictEqual(lanzamientos(s).map((l) => l.advisor), [REVISOR], 'sin el freno instalado, se anota');
    assert.match(r.stdout, /reviewer-launch-gate|freno/, `avisa que el freno no está instalado: ${r.stdout}`);
  } finally { limpiar(s); }

  // la consulta a `decide` que tira: se anota como hoy
  const e = maquina();
  try {
    marcador(e, { adversarialGate: CORRE });
    registrar(e, evento(e, 'rev-ensayo'), paquete(e, { roto: true }));
    assert.deepStrictEqual(lanzamientos(e).map((l) => l.advisor), ['rev-ensayo'], 'con la consulta rota, se anota');
  } finally { limpiar(e); }
});

// ── El pase no medido ────────────────────────────────────────────────────────────────────────────────────────────

test('T11 Revisor_PaseNoMedido_PideRelanzar @story-7.55 @ac-11', () => {
  const m = maquina();
  try {
    marcador(m, {
      adversarialGate: CORRE, adversarial: LANZADO(),
      adversarialPasses: [{ tipo: '5b', ts: hace(1), veredicto: 'no-medido', motivo_no_medido: 'una lente sin medir' }],
    });
    const r = freno(m, evento(m));
    assertNiega(r, 'pase no medido');
    assert.match(r.stderr, /--relaunch/, `el mensaje de next, con --relaunch: ${r.stderr}`);
    assert.match(r.stderr, /no lo relances|no se relanza/, 'y el aviso de no relanzar dos veces');
    assert.strictEqual(decision(m, evento(m)).kind, 'relanzar-pase-no-medido');
  } finally { limpiar(m); }
});
