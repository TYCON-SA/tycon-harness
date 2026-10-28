#!/usr/bin/env node
/**
 * adversarial-launch.test.js — el pase adversarial sale a tiempo, sus verificadores no esperan al más lento y la
 * pregunta del modelo se puede apagar.
 *
 * El pase es el camino crítico de la revisión: si se lanza tarde, la revisión entera se alarga. Un lanzamiento
 * temprano que fuera sólo un párrafo del paso 4 nadie se lo recordaría al agente: `pipeline.js next` tiene que
 * conocerlo y el portón tiene que dejar anotado su veredicto.
 *
 * Qué fija esta suite: (1) el portón deja su veredicto en un campo propio del marcador, nunca dentro de
 * `marker.adversarial` (que para todo el código es «lanzado»); (2) `next` pide consultar el portón o lanzar el pase
 * antes del primer revisor, no pide nada con el pase atendido, y ante un lanzamiento de otra sesión aplica una regla
 * sin preguntar; (3) el apagado del temprano vale para toda la corrida; (4) los verificadores corren en una ventana de
 * tres; (5) la clave `adversarial.model_question` apaga la oferta del modelo mayor sin cambiar nada más (la foto).
 *
 * Todo corre con los comandos reales, una HOME temporal, `TYCON_PROFILE=0` (salvo el caso del perfil) y el id de
 * sesión fijado en el proceso hijo: una prueba corrida desde una sesión de agente hereda el suyo.
 *
 * stable-data: lee el reloj a propósito — la regla de un pase de otra sesión compara contra la hora actual (minutos
 * desde el lanzamiento y desde la última modificación de su conversación), y las pruebas fijan esas edades relativas a
 * «ahora»; ningún resultado compara una hora absoluta.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/adversarial-launch.test.js
 * Regenerar la foto de T14 (sólo con el código de antes del veredicto propio del portón, que es lo que la foto fija): TYCON_GATE_SNAPSHOT=escribir node <este archivo>
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const WFLITE = path.join(SCRIPTS, 'workflow-lite.js');
const WORKFLOW = path.join(SCRIPTS, 'adversarial-verify.workflow.js');
const FOTO = path.join(__dirname, 'fixtures', 'deep-review-gate-snapshot.json');
const VENTANA = path.join(SCRIPTS, 'lib', 'sliding-window.js');

const SID = 'sesion-propia-7190';
const OTRA = 'sesion-ajena-71900';

// Variables de quien corre la suite que cambian un veredicto: fuera, siempre.
const DEL_ENTORNO = ['TYCON_NO_DEEP_REVIEW', 'DOD_BYPASS', 'TYCON_5B_EARLY', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID', 'TYCON_DEEP_REVIEW_DENSE_LINES', 'STOP_AUTONOMY', 'TYCON_PROFILE', 'TCG', 'TYCON_GUIDES_DIR',
  'TYCON_CLOCKIFY', 'TYCON_STATE_DIR', 'NODE_TEST_CONTEXT'];

function entorno(home, sid, extra) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith('TYCON_ADVERSARIAL')) delete env[k];
  return {
    ...env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_SESSION_ID: sid,
    TYCON_PROFILE: '0', TYCON_GUIDES_DIR: RAIZ, ...(extra || {}),
  };
}

function correr(script, home, sid, args, extra) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: entorno(home, sid, extra), cwd: os.tmpdir() });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const pipe = (home, args, extra, sid = SID) => correr(PIPELINE, home, sid, args, extra);
const mark = (home, args, extra, sid = SID) => correr(MARKER, home, sid, args, extra);

function casa() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanz-adv-home-'))); }
const estado = (home) => path.join(home, '.claude', '.tycon-pipeline');
const archivoMarker = (home, sid = SID) => path.join(estado(home), 'active', `${sid}.json`);
const leerMarker = (home, sid = SID) => JSON.parse(fs.readFileSync(archivoMarker(home, sid), 'utf8'));
function lineas(home, nombre) {
  const p = path.join(estado(home), nombre);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Un repo de prueba: git + una story con su alcance declarado. `pesada` = 13 archivos y 10 criterios (las dos
 * señales que hacen «pesada» a una story NORMAL, y con ellas la oferta del modelo mayor). `deepReview` va a
 * `.tycon/advisors.yaml`.
 */
function mkRepo({ pesada = false, deepReview = null, archivos = 1 } = {}) {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanz-adv-')));
  spawnSync('git', ['init', '-q', r]);
  for (const d of ['specs', 'scripts', '.tycon']) fs.mkdirSync(path.join(r, d), { recursive: true });
  const n = pesada ? 13 : archivos;
  const rutas = Array.from({ length: n }, (_x, i) => `scripts/x${i + 1}.js`);
  for (const [i, f] of rutas.entries()) fs.writeFileSync(path.join(r, f), `module.exports = ${i + 1};\n`);
  const criterios = Array.from({ length: pesada ? 10 : 1 }, (_x, i) => `${i + 1}. criterio ${i + 1}`);
  fs.writeFileSync(path.join(r, 'specs', 'a.md'), [
    '---', 'story: "A"', 'epic: 1', 'status: in-progress', 'approach: "[ADAPT]"', 'files_to_create: []',
    'files_to_modify:', ...rutas.map((f) => `  - ${f}`),
    '---', '', '# Story A', '', '## Acceptance Criteria', '', ...criterios, '',
  ].join('\n'));
  if (deepReview) fs.writeFileSync(path.join(r, '.tycon', 'advisors.yaml'), `deep_review: ${deepReview}\n`);
  return { dir: r, story: path.join(r, 'specs', 'a.md'), rutas };
}

/** Un marcador con el paso 4 cerrado sobre `repo` (el paso siguiente es «Revisores»). */
function enPaso5(home, repo, extra, sid = SID) {
  const dir = path.join(estado(home), 'active');
  fs.mkdirSync(dir, { recursive: true });
  const m = {
    storyId: 'A', storyPath: repo ? repo.story : undefined, repoPath: repo ? repo.dir : '/tmp/no-hay', sessionId: sid,
    startedAt: new Date(Date.now() - 3600000).toISOString(), lastTouch: new Date().toISOString(),
    stepsCompleted: [0, 1, 2, 3, 4], stepsPending: [5, 6, 7, 8], filesTouched: [], iterations: {}, fileEvents: [],
    clockiStarted: true, adoMarkedActive: true,
    ...extra,
  };
  for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify(m));
  return m;
}

function siguiente(home, extra, sid) {
  const r = pipe(home, ['next'], extra, sid);
  assert.strictEqual(r.status, 0, `next salió ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const hace = (min) => new Date(Date.now() - min * 60000).toISOString();
const horaCorta = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** La transcripción de otra sesión, con su última modificación hace `min` minutos. */
function hiloDe(home, sid, min) {
  const dir = path.join(home, '.claude', 'projects', '-tmp-otro-repo');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(f, '{"type":"user"}\n');
  const t = new Date(Date.now() - min * 60000);
  fs.utimesSync(f, t, t);
}

// ------------------------------------------------------------------ T1

test('T1 Gate_AnnotatesVerdictInItsOwnField — el veredicto va a adversarialGate, nunca a adversarial', () => {
  const home = casa();
  const repo = mkRepo({ deepReview: 'always', archivos: 2 });
  enPaso5(home, repo);

  const r1 = pipe(home, ['deep-review-gate', '--repo', repo.dir, '--story', repo.story, '--files', 'scripts/x1.js']);
  assert.strictEqual(r1.status, 0, r1.stderr);
  let m = leerMarker(home);
  assert.ok(m.adversarialGate, 'el portón anotó su veredicto');
  assert.strictEqual(m.adversarialGate.run, true);
  assert.strictEqual(m.adversarialGate.early_launch, true);
  assert.deepStrictEqual(m.adversarialGate.files, ['scripts/x1.js']);
  assert.strictEqual(m.adversarialGate.sessionId, SID);
  assert.ok(Date.parse(m.adversarialGate.at), 'con su hora');
  assert.strictEqual(m.adversarial, undefined, 'marker.adversarial es «lanzado»: el portón no lo toca');

  const r2 = pipe(home, ['deep-review-gate', '--repo', repo.dir, '--story', repo.story, '--files', 'scripts/x1.js', 'scripts/x2.js']);
  assert.strictEqual(r2.status, 0, r2.stderr);
  m = leerMarker(home);
  assert.deepStrictEqual(m.adversarialGate.files, ['scripts/x1.js', 'scripts/x2.js'], 'la segunda consulta reemplaza a la primera');

  // «No corre» → el salteo se acepta (con el veredicto adentro de `adversarial` se negaba: «ya se lanzó»).
  fs.writeFileSync(path.join(repo.dir, '.tycon', 'advisors.yaml'), 'deep_review: off\n');
  const s = mark(home, ['mark-adversarial-skipped', '--files', 'scripts/x1.js']);
  assert.strictEqual(s.status, 0, `el salteo se negó: ${s.stderr}`);
  m = leerMarker(home);
  assert.ok(m.adversarialSkip, 'el salteo quedó anotado');
  assert.strictEqual(m.adversarialGate.run, false, 'y no pisó la anotación que hizo el portón que el salteo lanzó');
  assert.strictEqual(m.adversarial, undefined);

  // Sin marcador: ni escribe ni cambia la salida.
  const sola = casa();
  fs.writeFileSync(path.join(repo.dir, '.tycon', 'advisors.yaml'), 'deep_review: always\n');
  const conMarcador = pipe(home, ['deep-review-gate', '--repo', repo.dir, '--story', repo.story, '--files', 'scripts/x1.js']);
  const sinMarcador = pipe(sola, ['deep-review-gate', '--repo', repo.dir, '--story', repo.story, '--files', 'scripts/x1.js']);
  assert.strictEqual(sinMarcador.status, conMarcador.status);
  assert.strictEqual(sinMarcador.stdout, conMarcador.stdout, 'la salida no depende de que haya marcador');
  assert.ok(!fs.existsSync(path.join(estado(sola), 'active')), 'sin marcador no se crea ninguno');
});

// ------------------------------------------------------------------ T2

test('T2 Next_PendingLaunchBeforeFirstReviewer — veredicto «corre» + temprano → lanzar antes de los revisores', () => {
  const home = casa();
  const repo = mkRepo();
  enPaso5(home, repo, { adversarialGate: { run: true, early_launch: true, files: ['scripts/x1.js'], at: hace(1), sessionId: SID } });
  const out = siguiente(home);
  assert.ok(out.pending_action, `sin acción pendiente: ${JSON.stringify(out)}`);
  assert.strictEqual(out.pending_action.kind, 'lanzar-pase');
  assert.match(out.pending_action.message, /mark-adversarial-launched/, 'dice cómo dejar la constancia');
  assert.strictEqual(String(out.next_step), 'reviewers');
  assert.strictEqual(out.step_name, 'Revisores');
  const m = leerMarker(home);
  assert.ok(m.stepTimings && m.stepTimings['5'] && m.stepTimings['5'].startedAt, 'el arranque de los revisores se anota (en el 5 del marcador viejo)');
});

// ------------------------------------------------------------------ T3

test('T3 Next_AsksForGateWhenNoVerdict — sin veredicto (o con el portón que no pudo medir) → consultar el portón', () => {
  const home = casa();
  const repo = mkRepo();
  enPaso5(home, repo);
  let out = siguiente(home);
  assert.ok(out.pending_action, 'sin veredicto hay acción pendiente');
  assert.strictEqual(out.pending_action.kind, 'consultar-porton');
  assert.match(out.pending_action.command, /deep-review-gate --repo .+ --story .+ --files/, 'con el comando');

  // El portón que no puede medir: una story liviana (1 archivo declarado → LOW) consultada sin --files llega a la
  // medición de densidad sin archivos y sale 2 (el mismo caso de adversarial-result.test.js). Una story SIN archivos
  // declarados no sirve para esto: sin nada que contar es NORMAL y corre.
  const home2 = casa();
  const liviana = mkRepo();
  enPaso5(home2, liviana);
  const g = pipe(home2, ['deep-review-gate', '--repo', liviana.dir, '--story', liviana.story]);
  assert.strictEqual(g.status, 2, `el portón sin archivos tenía que salir 2: ${g.stdout}${g.stderr}`);
  assert.strictEqual(leerMarker(home2).adversarialGate, undefined, 'un «no pude medir» no se anota');
  out = siguiente(home2);
  assert.strictEqual(out.pending_action && out.pending_action.kind, 'consultar-porton', 'la falta de veredicto no es «no corre»');
});

// ------------------------------------------------------------------ T4

test('T4 Next_NothingWhenAdversarialAttended — pase atendido, lo haya lanzado quien sea → nada sobre el pase', () => {
  const casos = {
    'propio con resultado': { adversarial: { launchedAtStep: 4, runId: 'r1', sessionId: SID, launchedAt: hace(30) }, adversarialPasses: [{ tipo: '5b', ts: hace(5), confirmados: 0 }], deepReviewDone: true },
    'ajeno con resultado': { adversarial: { launchedAtStep: 4, runId: 'r2', sessionId: OTRA, launchedAt: hace(30) }, adversarialPasses: [{ tipo: '5b', ts: hace(5), confirmados: 1 }], deepReviewDone: true },
    'salteado por el portón': { adversarialSkip: { motivo: 'LOW', archivos: 1, forzado: false, abandonado: false, runId: null, at: hace(2) }, deepReviewDone: true },
    // el resultado anotado es de un lanzamiento anterior: el paso 8 lo frena, pero `next` no pide otro (relanzar empeora)
    'resultado de otro lanzamiento': { adversarial: { launchedAtStep: '5b', runId: 'r3', sessionId: SID, launchedAt: hace(10) }, adversarialPasses: [{ tipo: '5b', ts: hace(30), confirmados: 0 }] },
  };
  for (const [nombre, extra] of Object.entries(casos)) {
    const home = casa();
    enPaso5(home, mkRepo(), { adversarialGate: { run: true, early_launch: true, files: ['scripts/x1.js'], at: hace(40), sessionId: SID }, ...extra });
    const out = siguiente(home);
    assert.ok(!out.pending_action, `${nombre}: no tenía que pedir nada (${JSON.stringify(out.pending_action)})`);
  }
});

// ------------------------------------------------------------------ T5

test('T5 Next_ForeignLaunch_AppliesTheRule — pase de otra sesión sin resultado: esperar o relanzar, sin preguntar', () => {
  const casos = [
    { nombre: 'reciente y su hilo vivo', lanzado: 20, hilo: 1, esperado: 'esperar-pase-ajeno' },
    { nombre: 'reciente y su hilo quieto', lanzado: 20, hilo: 30, esperado: 'relanzar-pase-ajeno' },
    { nombre: 'viejo', lanzado: 60, hilo: 1, esperado: 'relanzar-pase-ajeno' },
    // los bordes: los dos topes son estrictos (menos de 45, menos de 10)
    { nombre: 'justo debajo de los dos topes', lanzado: 44, hilo: 9, esperado: 'esperar-pase-ajeno' },
    { nombre: 'en el tope de 45 min', lanzado: 45, hilo: 1, esperado: 'relanzar-pase-ajeno' },
    { nombre: 'en el tope de 10 min del hilo', lanzado: 20, hilo: 10, esperado: 'relanzar-pase-ajeno' },
  ];
  for (const c of casos) {
    const home = casa();
    const launchedAt = hace(c.lanzado);
    hiloDe(home, OTRA, c.hilo);
    enPaso5(home, mkRepo(), { adversarial: { launchedAtStep: 4, runId: 'wf-ajeno', sessionId: OTRA, launchedAt } });
    const out = siguiente(home);
    assert.ok(out.pending_action, `${c.nombre}: sin acción`);
    assert.strictEqual(out.pending_action.kind, c.esperado, `${c.nombre}: ${out.pending_action.message}`);
    const texto = out.pending_action.message;
    assert.ok(texto.includes(OTRA.slice(0, 8)), `${c.nombre}: nombra la otra sesión`);
    assert.ok(texto.includes(horaCorta(launchedAt)), `${c.nombre}: dice la hora del lanzamiento`);
    assert.ok(out.pending_action.rule && /45 min/.test(out.pending_action.rule) && /10 min/.test(out.pending_action.rule), `${c.nombre}: trae la regla`);
    assert.ok(out.pending_action.why, `${c.nombre}: y por qué se aplicó así`);
    assert.doesNotMatch(texto, /pregunt/i, `${c.nombre}: no se le pregunta a nadie`);
    if (c.esperado === 'relanzar-pase-ajeno') assert.match(texto, /5b|pase adversarial/, 'relanzar es en el paso del pase');
  }

  // Sin hora de lanzamiento legible (o sin la clave): no se puede decir que sea reciente → se relanza, y se dice por qué.
  for (const launchedAt of ['no-es-una-fecha', undefined]) {
    const home = casa();
    hiloDe(home, OTRA, 1);
    const adv = { launchedAtStep: 4, runId: 'wf-ajeno', sessionId: OTRA, ...(launchedAt ? { launchedAt } : {}) };
    enPaso5(home, mkRepo(), { adversarial: adv });
    const out = siguiente(home);
    assert.strictEqual(out.pending_action && out.pending_action.kind, 'relanzar-pase-ajeno', `${launchedAt}: relanzar`);
    assert.match(out.pending_action.why, /sin hora/, `${launchedAt}: dice que no tiene hora legible`);
  }
});

// ------------------------------------------------------------------ T6

test('T6 Next_SaysForcedSkip — salteo forzado o pase abandonado: no pide lanzar, lo dice', () => {
  const casos = {
    forzado: { adversarialSkip: { motivo: 'forzado OFF', archivos: 1, forzado: true, abandonado: false, runId: null, at: hace(1) }, deepReviewDone: true },
    abandonado: {
      adversarial: { launchedAtStep: 4, runId: 'wf-x', sessionId: SID, launchedAt: hace(20) },
      adversarialSkip: { motivo: 'forzado OFF', archivos: 1, forzado: true, abandonado: true, runId: 'wf-x', at: hace(1) }, deepReviewDone: true,
    },
  };
  for (const [nombre, extra] of Object.entries(casos)) {
    const home = casa();
    enPaso5(home, mkRepo(), extra);
    const out = siguiente(home);
    assert.ok(!out.pending_action, `${nombre}: no pide lanzar (${JSON.stringify(out.pending_action)})`);
    assert.ok(out.adversarial_note, `${nombre}: lo dice en la salida`);
    assert.match(out.adversarial_note, nombre === 'forzado' ? /salteo FORZADO, queda en bypass\.log/ : /ABANDONADO/);
  }
});

// ------------------------------------------------------------------ T7

test('T7 EarlyOff_BelongsToTheRun — el temprano apagado una vez vale para la corrida, y =1 lo vuelve a prender', () => {
  const home = casa();
  const repo = mkRepo({ deepReview: 'always' });
  enPaso5(home, repo);
  const g = pipe(home, ['deep-review-gate', '--repo', repo.dir, '--story', repo.story, '--files', 'scripts/x1.js'], { TYCON_5B_EARLY: '0' });
  assert.strictEqual(g.status, 0, g.stderr);
  assert.strictEqual(JSON.parse(g.stdout).early_launch, false);
  assert.strictEqual(leerMarker(home).adversarialGate.early_launch, false, 'el apagado quedó en la corrida');

  let out = siguiente(home);
  assert.strictEqual(String(out.next_step), 'reviewers');
  assert.ok(!out.pending_action, `sin la variable, igual no pide lanzar (${JSON.stringify(out.pending_action)})`);

  // Una consulta posterior al portón sin la variable tampoco lo prende.
  const g2 = pipe(home, ['deep-review-gate', '--repo', repo.dir, '--story', repo.story, '--files', 'scripts/x1.js']);
  assert.strictEqual(JSON.parse(g2.stdout).early_launch, false, 'el portón dice lo que vale para la corrida');
  assert.strictEqual(JSON.parse(g2.stdout).early_launch_origin, 'TYCON_5B_EARLY=0', 'y de dónde sale');

  out = siguiente(home, { TYCON_5B_EARLY: '1' });
  assert.strictEqual(out.pending_action && out.pending_action.kind, 'lanzar-pase', '=1 explícito lo vuelve a prender');
  const m = leerMarker(home);
  assert.strictEqual(m.adversarialGate.early_launch, true, 'y queda anotado');
  assert.strictEqual(m.adversarialGate.early_origin, 'TYCON_5B_EARLY=1');

  // La otra mitad del AC 7: el apagado lo ve `next` en su propio comando (sin pasar por el portón) y lo conserva.
  const home2 = casa();
  enPaso5(home2, mkRepo(), { adversarialGate: { run: true, early_launch: true, files: ['scripts/x1.js'], at: hace(1), sessionId: SID } });
  out = siguiente(home2, { TYCON_5B_EARLY: '0' });
  assert.ok(!out.pending_action, `next con =0 no pide lanzar (${JSON.stringify(out.pending_action)})`);
  const m2 = leerMarker(home2);
  assert.strictEqual(m2.adversarialGate.early_launch, false, 'next anotó el apagado');
  assert.strictEqual(m2.adversarialGate.early_origin, 'TYCON_5B_EARLY=0');
  assert.strictEqual(m2.adversarialGate.run, true, 'sin pisar el veredicto del portón');
  out = siguiente(home2);
  assert.ok(!out.pending_action, 'el siguiente next, sin la variable, sigue sin pedir lanzar');

  // Si la anotación no se puede escribir, se dice (sin ella, el próximo `next` vuelve a pedir lo que se apagó). Con
  // la carpeta del marcador en sólo lectura. Donde eso no frena la escritura (Windows, o corriendo como administrador)
  // no hay cómo provocar la falla: se comprueba antes escribiendo de verdad, y si se puede, esta parte no corre.
  const home3 = casa();
  const repo3 = mkRepo({ deepReview: 'always' });
  enPaso5(home3, repo3);
  const activa = path.join(estado(home3), 'active');
  fs.chmodSync(activa, 0o555);
  let seFrena = false;
  try { fs.writeFileSync(path.join(activa, 'sonda.tmp'), ''); fs.unlinkSync(path.join(activa, 'sonda.tmp')); } catch { seFrena = true; }
  if (!seFrena) fs.chmodSync(activa, 0o755);
  else {
    try {
      const n = pipe(home3, ['next'], { TYCON_5B_EARLY: '0' });
      assert.strictEqual(n.status, 0, `next sigue contestando: ${n.stderr}`);
      assert.match(n.stderr, /no pude anotar TYCON_5B_EARLY=0 en la corrida/, 'next dice que no pudo anotar el apagado');
      const g = pipe(home3, ['deep-review-gate', '--repo', repo3.dir, '--story', repo3.story, '--files', 'scripts/x1.js']);
      assert.strictEqual(g.status, 0, 'el portón sale igual');
      assert.match(g.stderr, /no pude anotar el veredicto en la corrida/, 'el portón dice que no pudo anotar su veredicto');
    } finally {
      fs.chmodSync(activa, 0o755);
    }
  }
});

// ------------------------------------------------------------------ T8 · T9 (la ventana)

function diferida() {
  let resolver; let rechazar;
  const p = new Promise((res, rej) => { resolver = res; rechazar = rej; });
  return { p, resolver, rechazar };
}

test('T8 Verifiers_SlidingWindowOfThree — nunca más de 3 vivas, y la 4ta entra cuando termina la 1ra', async () => {
  const { runWindow } = require(VENTANA);
  const reloj = [];
  let vivas = 0; let pico = 0;
  const pendientes = Array.from({ length: 7 }, () => diferida());
  const arrancadas = [];
  const tareas = pendientes.map((d, i) => () => {
    vivas += 1; pico = Math.max(pico, vivas); arrancadas.push(i); reloj.push(`arranca ${i}`);
    return d.p.then((v) => { vivas -= 1; reloj.push(`termina ${i}`); return v; });
  });
  const todo = runWindow(tareas, { size: 3 });
  const vuelta = () => new Promise((r) => setImmediate(r));
  await vuelta();
  assert.deepStrictEqual(arrancadas, [0, 1, 2], 'arrancan tres');
  pendientes[0].resolver('a'); await vuelta(); await vuelta();
  assert.deepStrictEqual(arrancadas, [0, 1, 2, 3], 'la cuarta entra apenas termina la primera, sin esperar a las otras dos');
  // la más lenta (la 2) sigue viva mientras pasan las demás
  for (const i of [1, 3, 4, 5, 6]) { pendientes[i].resolver(String(i)); await vuelta(); await vuelta(); }
  assert.ok(arrancadas.includes(6), 'la séptima arrancó con la segunda tanda de la vieja forma todavía abierta');
  pendientes[2].resolver('lenta');
  const res = await todo;
  assert.strictEqual(res.length, 7);
  assert.strictEqual(res[2], 'lenta');
  assert.ok(pico <= 3, `pico ${pico}: nunca más de 3 vivas`);
});

test('T9 Verifiers_OneThrows_AllClassesAttempted — una que tira no corta las demás', async () => {
  const { runWindow } = require(VENTANA);
  const intentadas = new Set();
  const tareas = Array.from({ length: 7 }, (_x, i) => async () => {
    intentadas.add(i);
    if (i === 1) throw new Error('el verificador murió');
    await new Promise((r) => setTimeout(r, 5 * (7 - i)));
    return { k: i };
  });
  const avisos = [];
  const res = await runWindow(tareas, { size: 3, onError: (k, e) => avisos.push([k, e.message]) });
  assert.strictEqual(intentadas.size, 7, 'las siete se intentaron');
  assert.strictEqual(res[1], null, 'la que tiró vuelve null');
  assert.deepStrictEqual(avisos, [[1, 'el verificador murió']], 'y su motivo no se pierde: se le pasa a quien la llamó');
  for (const i of [0, 2, 3, 4, 5, 6]) assert.deepStrictEqual(res[i], { k: i });
});

// ------------------------------------------------------------------ T10 · T11 (la clave)

function portonPesado(home, extra) {
  const repo = mkRepo({ pesada: true, deepReview: 'always' });
  return pipe(home, ['deep-review-gate', '--repo', repo.dir, '--story', repo.story, '--files', ...repo.rutas], extra);
}

/** Escribe la clave vieja a mano en el archivo de la máquina, como la dejó una versión anterior (`set` ya no la escribe). */
function escribirClave(home, valor) {
  const archivo = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js'))}).configFile(${JSON.stringify(home)}))`], { encoding: 'utf8' }).stdout;
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, JSON.stringify({ adversarial: { model_question: valor } }));
  return archivo;
}

test('T10 ModelQuestion_Retirada_ElPortonNoLaLee — con o sin la clave vieja, la salida es la misma y no habla de preguntar', () => {
  const esperado = JSON.parse(portonPesado(casa()).stdout);
  for (const v of ['ask', 'never', 'siempre']) {
    const home = casa();
    escribirClave(home, v);
    const r = portonPesado(home);
    assert.strictEqual(r.status, 0, `${v}: ${r.stderr}`);
    const o = JSON.parse(r.stdout);
    assert.deepStrictEqual(o, esperado, `${v}: la salida no cambia`);
    for (const k of ['fable_upsell', 'model_question', 'model_question_note']) assert.strictEqual(o[k], undefined, `${v}: sin ${k}`);
    assert.strictEqual(o.model, 'opus', `${v}: la story pesada va con opus`);
    assert.doesNotMatch(r.stderr, /model_question/, `${v}: el portón no la lee`);
    assert.strictEqual(lineas(home, 'gates.log').filter((x) => x.check === 'model-question').length, 0, `${v}: sin línea en gates.log`);
  }
});

test('T11 ModelQuestion_Retirada_ConfiguracionRota_NoLaNombra — un archivo roto o un perfil con la clave no cambian el portón', () => {
  const esperado = JSON.parse(portonPesado(casa()).stdout);
  const rota = casa();
  fs.writeFileSync(escribirClave(rota, 'never'), '{ esto no es json');
  const r = portonPesado(rota);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /model_question/, 'la clave ya no se busca: no se la nombra');
  assert.strictEqual(JSON.parse(r.stdout).model, esperado.model);

  const perfil = casa();
  const rutaPerfil = path.join(perfil, 'perfil-equipo.json');
  fs.writeFileSync(rutaPerfil, JSON.stringify({ adversarial: { model_question: 'never' } }));
  const p = portonPesado(perfil, { TYCON_PROFILE: rutaPerfil });
  assert.strictEqual(p.status, 0, p.stderr);
  assert.deepStrictEqual(JSON.parse(p.stdout), esperado, 'el perfil con la clave vieja tampoco cambia nada');
});

// ------------------------------------------------------------------ T12 · T13

test('T12 Next_UnreadableStory — sin ruta de story o con una que no existe: no pide lanzar y dice qué faltó', () => {
  const home = casa();
  const fantasma = '/tmp/no-existe-7190/specs/a.md';
  enPaso5(home, { dir: '/tmp/no-existe-7190', story: fantasma }, { adversarialGate: { run: true, early_launch: true, files: ['x.js'], at: hace(1), sessionId: SID } });
  let out = siguiente(home);
  assert.ok(!out.pending_action || !['lanzar-pase', 'consultar-porton'].includes(out.pending_action.kind), 'no pide lanzar');
  assert.ok(out.adversarial_note && out.adversarial_note.includes(fantasma), `dice la ruta (${out.adversarial_note})`);

  const home2 = casa();
  enPaso5(home2, null, { adversarialGate: { run: true, early_launch: true, files: ['x.js'], at: hace(1), sessionId: SID } });
  out = siguiente(home2);
  assert.ok(!out.pending_action || !['lanzar-pase', 'consultar-porton'].includes(out.pending_action.kind), 'sin ruta: no pide lanzar');
  assert.match(out.adversarial_note || '', /sin ruta de story/);
});

test('T13 Next_NoActionWhenGateSaysNo — «no corre» o temprano apagado: el paso 5 sin acción', () => {
  for (const gate of [{ run: false, early_launch: true }, { run: true, early_launch: false }]) {
    const home = casa();
    enPaso5(home, mkRepo(), { adversarialGate: { ...gate, files: ['scripts/x1.js'], at: hace(1), sessionId: SID } });
    const out = siguiente(home);
    assert.strictEqual(String(out.next_step), 'reviewers');
    assert.ok(!out.pending_action, `${JSON.stringify(gate)}: sin acción (${JSON.stringify(out.pending_action)})`);
  }
});

// ------------------------------------------------------------------ T14 (la foto)

/** Los casos fijos de la foto: cada uno arma su repo y su línea de comando. Inventados: esta carpeta se publica. */
const CASOS_FOTO = [
  { nombre: 'liviana-sin-config', repo: {}, files: 'todos', env: {} },
  { nombre: 'liviana-always', repo: { deepReview: 'always' }, files: 'todos', env: {} },
  { nombre: 'liviana-off', repo: { deepReview: 'off' }, files: 'todos', env: {} },
  { nombre: 'normal-forzada', repo: { archivos: 8 }, files: 'todos', env: {}, flags: ['--deep-review'] },
  { nombre: 'pesada-always', repo: { pesada: true, deepReview: 'always' }, files: 'todos', env: {} },
  { nombre: 'pesada-sin-config', repo: { pesada: true }, files: 'todos', env: {} },
  { nombre: 'pesada-temprano-apagado', repo: { pesada: true, deepReview: 'always' }, files: 'todos', env: { TYCON_5B_EARLY: '0' } },
  { nombre: 'pesada-fable-autorizado', repo: { pesada: true, deepReview: 'always' }, files: 'todos', env: {}, flags: ['--deep-review-fable'] },
  { nombre: 'pesada-interruptor', repo: { pesada: true }, files: 'todos', env: { TYCON_NO_DEEP_REVIEW: '1' } },
];

function correrFoto(home, c) {
  const repo = mkRepo(c.repo);
  const r = pipe(home, ['deep-review-gate', '--repo', repo.dir, '--story', repo.story, '--files', ...repo.rutas, ...(c.flags || [])], c.env);
  return { status: r.status, salida: r.status === 0 ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

if (process.env.TYCON_GATE_SNAPSHOT === 'escribir') {
  const foto = { tomada_de: 'el commit anterior a la story 7.19 (103b45d)', casos: [] };
  for (const c of CASOS_FOTO) {
    const r = correrFoto(casa(), c);
    foto.casos.push({ nombre: c.nombre, status: r.status, salida: r.salida });
  }
  fs.writeFileSync(FOTO, `${JSON.stringify(foto, null, 2)}\n`);
  process.stdout.write(`foto escrita: ${FOTO}\n`);
  process.exit(0);
}

test('T14 Gate_SnapshotUnchangedWithoutKey — sin clave igual a la foto; con la clave vieja, también', () => {
  const foto = JSON.parse(fs.readFileSync(FOTO, 'utf8'));
  assert.strictEqual(foto.casos.length, CASOS_FOTO.length, 'la foto tiene todos los casos');
  for (const c of CASOS_FOTO) {
    const esperado = foto.casos.find((x) => x.nombre === c.nombre);
    const sin = correrFoto(casa(), c);
    assert.strictEqual(sin.status, esperado.status, `${c.nombre}: código de salida`);
    assert.deepStrictEqual(sin.salida, esperado.salida, `${c.nombre}: sin clave, la salida es la de la foto`);

    // la clave vieja de la pregunta ya no cambia nada: con ask o never escrita, idéntica
    for (const v of ['ask', 'never']) {
      const con = casa(); escribirClave(con, v);
      assert.deepStrictEqual(correrFoto(con, c).salida, esperado.salida, `${c.nombre}: con ${v}, idéntica`);
    }
  }
});

// ------------------------------------------------------------------ T16 (el guion real bajo el otro corredor)

test('T16 Verifiers_WindowUnderLiteRunner — el guion real con 7 clases nunca pasa de 3 verificadores vivos', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ventana-')));
  const vivos = path.join(tmp, 'vivos');
  fs.mkdirSync(vivos);
  const stub = path.join(tmp, 'stub.js');
  // Un cazador devuelve 7 hallazgos en 7 archivos distintos (7 clases); cada verificador se anota vivo, mide cuántos
  // hay, espera y se borra. El pico queda en un archivo.
  fs.writeFileSync(stub, `
const fs = require('fs'); const path = require('path');
const prompt = process.env.TYCON_WFLITE_PROMPT || '';
const vivos = ${JSON.stringify(vivos)}; const picos = ${JSON.stringify(path.join(tmp, 'picos.txt'))};
const dormir = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (/REFUTAR/i.test(prompt)) {
  const yo = path.join(vivos, String(process.pid));
  fs.writeFileSync(yo, '');
  fs.appendFileSync(picos, fs.readdirSync(vivos).length + '\\n');
  dormir(400);
  fs.appendFileSync(picos, fs.readdirSync(vivos).length + '\\n');
  fs.unlinkSync(yo);
  console.log(JSON.stringify({ verdict: 'REFUTED', reasoning: 'no reproduce', adjusted_severity: 'bug', probe_dir: '', todos_el_mismo_defecto: true }));
} else {
  // cada una de las seis lentes reporta un defecto en su propio archivo; la de completitud, dos (7 clases)
  const lente = ((prompt.match(/LENTE: ([^\\n]+)/) || [])[1] || 'x').replace(/[^a-z]/gi, '').slice(0, 12);
  const F = (i) => ({ severity: 'bug', file: 'src/' + lente + i + '.js', line: 10 * i, summary: 'defecto ' + lente + i + ' distinto en su archivo', repro: 'r' + i, confidence: 'high' });
  console.log(JSON.stringify({ lens: lente, findings: /LENTE: completitud/.test(prompt) ? [F(1), F(2)] : [F(1)] }));
}
`);
  const out = path.join(tmp, 'out.json');
  const args = { repo: tmp, files: ['src/f1.js'], runDir: path.join(tmp, 'run') };
  const env = { ...process.env, TYCON_WFLITE_AGENT_CMD: `${process.execPath} ${stub}`, TYCON_WFLITE_JOBS: '8' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [WFLITE, WORKFLOW, '--args', JSON.stringify(args), '--out', out], { encoding: 'utf8', env });
  assert.ok(fs.existsSync(out), `el pase no devolvió salida: ${r.stderr}`);
  const salida = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(salida.clases, 7, 'siete clases a verificar');
  const picos = fs.readFileSync(path.join(tmp, 'picos.txt'), 'utf8').split('\n').filter(Boolean).map(Number);
  assert.strictEqual(picos.length, 14, 'los siete verificadores corrieron');
  assert.ok(Math.max(...picos) <= 3, `pico ${Math.max(...picos)}: con el corredor admitiendo 8, la ventana pone 3`);
  assert.ok(Math.max(...picos) >= 2, 'y corren en paralelo, no en serie');
  assert.strictEqual(salida.all_lenses.length, 6, 'los seis lentes del pase son los mismos');

  // La ventana va copiada dentro del guion (la caja del pase no tiene `require`): las dos copias no se separan.
  const { nucleo } = require(VENTANA);
  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  const i = wf.indexOf('// ===== NUCLEO-VENTANA: INICIO =====');
  const j = wf.indexOf('// ===== NUCLEO-VENTANA: FIN =====');
  assert.ok(i >= 0 && j > i, 'el guion trae el núcleo de la ventana entre sus marcas');
  assert.strictEqual(wf.slice(i, j).trimEnd(), nucleo(), 'las dos copias se separaron — re-sincronizá: node lib/sliding-window.js --emit-core');
});

// La pregunta «tarda 20-40 min, ¿lo corro?» salía de la duración que anunciaba la skill, y la respuesta «no» terminaba
// en el apagado del pase. Con el portón en «corre», el pase se lanza de fondo y se avisa; apagarlo lo decide la persona.
test('T9 Skill_NoOfreceSaltearElPase @story-8.104 @ac-1', () => {
  const skill = fs.readFileSync(path.join(SCRIPTS, '..', 'SKILL.md'), 'utf8');
  const paso = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-08-adversarial-pass.md'), 'utf8');
  const regla = (id) => { const m = new RegExp(`^- \\*\\*${id.replace(/\./g, '\\.')}[^\\n]*(?:\\n  [^\\n]*)*`, 'm').exec(skill); return m ? m[0] : ''; };
  const comm = regla('COMM.iii');
  const hii = regla('H.ii');
  const tooli = regla('TOOL.i');
  assert.ok(comm && hii && tooli, 'COMM.iii, H.ii y TOOL.i están en SKILL.md');
  for (const [nombre, t] of [['COMM.iii', comm], ['H.ii', hii]]) {
    assert.match(t, /sin preguntar/, `${nombre}: el pase se lanza sin preguntar`);
    assert.match(t, /de fondo|segundo plano/, `${nombre}: de fondo`);
  }
  for (const [nombre, t] of [['SKILL.md', skill], ['step-08', paso]]) {
    assert.doesNotMatch(t, /¿lo corro\?|¿sigo sin el pase/i, `${nombre}: no ofrece saltearlo`);
    assert.doesNotMatch(t, /TYCON_NO_DEEP_REVIEW=1 /, `${nombre}: sin la receta del apagado`);
    assert.match(t, /autorizo TYCON_NO_DEEP_REVIEW/, `${nombre}: apagarlo lo decide la persona con la frase`);
  }
  assert.match(tooli, /salida aprobada/, 'TOOL.i: sin Workflow, la salida aprobada');
});
