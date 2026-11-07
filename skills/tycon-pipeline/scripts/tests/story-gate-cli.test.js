#!/usr/bin/env node
/**
 * story-gate-cli.test.js — la parte del portón de carril que LANZA PROCESOS (git, marker.js CLI):
 * kill-switch commiteado, complete-step (orden / Step 3 / Step 5), marker set, adhoc. Corre en el throttle
 * DIARIO del instalador: en SessionStart sumaría ~1 min bajo carga.
 * La parte pura vive en story-gate.test.js (cada arranque).
 *
 * Correr: node --test ~/.claude/agent-skills/skills/tycon-pipeline/scripts/tests/story-gate-cli.test.js
 * 0 deps (node:test). Los tests de marker.js corren el CLI real contra un HOME temporal
 * (marker.js resuelve STATE_DIR desde os.homedir() y SID desde CLAUDE_CODE_SESSION_ID).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
// el nombre público del arnés (el del lugar), de place.js del repo único; en un clon de skills suelto no está
// y los gemelos con ese nombre no se miden (se dice). Nunca escrito a mano: vive sólo en public-repos.json y place.js.
const PUBLIC_NAME = (() => { try { return require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'setup', 'harness', 'place.js')).PLACE_NAME; } catch (_) { return null; } })();
const twin = (fn) => (PUBLIC_NAME ? fn() : console.log('⏭ gemelo con el nombre público: NO MEDIDO — sin scripts/setup/harness/place.js (clon de skills suelto)'));

const SCRIPTS = path.join(__dirname, '..');
const { conVentana } = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'tests', 'lib', 'window-passed.js'));
const gate = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
const io = require(path.join(SCRIPTS, 'lib', 'story-gate-io.js'));
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));

function mkRepo(withTycon) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  fs.mkdirSync(path.join(r, '.git'));
  fs.mkdirSync(path.join(r, 'src'));
  if (withTycon) fs.mkdirSync(path.join(r, '.tycon'));
  return r;
}

test('io.gateEnabledForRepo: lee lo COMMITEADO — el yaml del working tree no apaga nada', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), 'pipeline:\n  story_gate: true\n');
  git('add', '.'); git('commit', '-qm', 'x');
  assert.equal(io.gateEnabledForRepo(repo), true);
  fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), 'pipeline:\n  story_gate: false\n'); // sin commit
  assert.equal(io.gateEnabledForRepo(repo), true);
  git('add', '.'); git('commit', '-qm', 'off');
  assert.equal(io.gateEnabledForRepo(repo), false);
  assert.equal(io.gateEnabledForRepo('/no/existe'), true);
});

// ── marker.js complete-step: orden, Step 3, Step 5 ───────────────────────────────────────────────
// Las firmas del dueño (el plan, el arreglo rápido) las da en la ventana de permiso; acá se dan por pasada
// (window-passed.js).
function markerCli(home, sid, args, extraEnv = {}) {
  return spawnSync('node', [path.join(SCRIPTS, 'marker.js'), ...args], {
    encoding: 'utf8',
    env: conVentana({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, ...extraEnv }),
  });
}

// Un mensaje que llega a la sesión como lo entrega Claude Code: corre on-prompt.js y el mensaje queda en la conversación
// con su marca de origen (`human` = lo tipeó el dueño). `adhoc set` no lo lee: T10 prueba que no abre nada.
function mensajeConMarca(home, sid, prompt, origin = { kind: 'human' }) {
  const dir = path.join(home, '.claude', 'projects', '-repo');
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${sid}.jsonl`);
  fs.appendFileSync(transcript, JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: `u-${Date.now()}-${Math.random()}`,
    timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: prompt }] }, origin }) + '\n');
  return spawnSync('node', [path.join(SCRIPTS, 'on-prompt.js')], {
    encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: sid, transcript_path: transcript }),
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

// El gate del 5 sólo acepta un `run-check advisors` que invoque `pipeline.js check-count` (sin --ran):
// para el test, un pipeline.js de mentira que sale 0 — lo que se prueba es el gate, no check-count.
function fakeCheckCount() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fakepipe-'));
  const f = path.join(d, 'pipeline.js');
  fs.writeFileSync(f, 'process.exit(0)\n');
  return ['node', f, 'check-count'];
}

test('complete-step: orden (3←1,2 · 4←3 · 5←4 · 8←5), --out-of-order logueado; Step 3 exige --approved; Step 5 exige advisors por run-check fresco', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const CC = fakeCheckCount();
  const sid = 'sess-t';
  const repo = mkRepo(true);
  const story = path.join(repo, 'story.md');
  // signed_for_sprint → risk-class NORMAL (la auto-aprobación Nivel 2 es sólo LOW)
  fs.writeFileSync(story, '---\nstory: "1.1"\nstatus: in-progress\nsigned_for_sprint: 3\nfiles_to_modify:\n  - src/a.cs\n---\n# S\n');
  let r = markerCli(home, sid, ['set', JSON.stringify({ storyId: '1.1', storyPath: story, repoPath: repo, stepsPending: [0, 1, 2, 3, 4, 5, 6, 7, 8] })]);
  assert.equal(r.status, 0, r.stderr);
  // 3 antes de 1,2 → bloqueado por orden
  r = markerCli(home, sid, ['complete-step', '3', '--approved', 'dale']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /step\(s\) 1, 2 todavía pendiente/);
  markerCli(home, sid, ['complete-step', '0']); markerCli(home, sid, ['complete-step', '1']); markerCli(home, sid, ['complete-step', '2']);
  // 3 sin aprobación → bloqueado
  r = markerCli(home, sid, ['complete-step', '3']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /falta la aprobación del plan/);
  // 3 «auto-aprobado» → bloqueado: ningún plan se aprueba solo
  r = markerCli(home, sid, ['complete-step', '3', '--auto-approved', 'criterios']);
  assert.equal(r.status, 2); assert.match(r.stderr, /el plan no se aprueba solo/);
  // 3 con cita → ok y queda planApproval
  r = markerCli(home, sid, ['complete-step', '3', '--approved', 'dale, aprobado']);
  assert.equal(r.status, 0, r.stderr);
  const m1 = JSON.parse(r.stdout);
  assert.equal(m1.planApproval.mode, 'user'); assert.equal(m1.planApproval.text, 'dale, aprobado');
  // 5 antes de 4 → orden; con --out-of-order pasa el orden pero cae en el gate de advisors
  r = markerCli(home, sid, ['complete-step', '5']);
  assert.match(r.stderr, /step\(s\) 4 todavía pendiente/);
  r = markerCli(home, sid, ['complete-step', '5', '--out-of-order']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /check `advisors` no está en verde/);
  assert.match(fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'bypass.log'), 'utf8'), /STEP_OUT_OF_ORDER/);
  // advisors green por run-check (comando que sale 0) → 5 cierra (con --out-of-order porque 4 sigue pendiente)
  r = markerCli(home, sid, ['run-check', 'advisors', '--', ...CC]);
  assert.equal(r.status, 0, r.stderr);
  r = markerCli(home, sid, ['complete-step', '5', '--out-of-order']);
  assert.equal(r.status, 0, r.stderr);
  // re-cerrar el 5 (loop D.i) sin re-correr advisors → bloqueado por frescura (4 sigue pendiente en
  // este test, por eso --out-of-order: lo que se prueba es el gate de advisors)
  r = markerCli(home, sid, ['complete-step', '5', '--out-of-order']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /de ESTA vuelta/);
  // trust-ran → provenance trust-ran → no alcanza
  markerCli(home, sid, ['run-check', 'advisors', '--', ...CC, '--trust-ran']);
  r = markerCli(home, sid, ['complete-step', '5', '--out-of-order']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /provenance=trust-ran/);
  // run-check fresco → cierra
  markerCli(home, sid, ['run-check', 'advisors', '--', ...CC]);
  r = markerCli(home, sid, ['complete-step', '5', '--out-of-order']);
  assert.equal(r.status, 0, r.stderr);
  // frescura: un check con el MISMO instante que el cierre previo NO cuenta (> estricto)
  // y el gate también cubre `4 sin 3` y `8 sin 5`
  const mpath = path.join(home, '.claude', '.tycon-pipeline', 'active', `${sid}.json`);
  const m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  m.checksAt.advisors = m.stepTimings['5'].completedAt; fs.writeFileSync(mpath, JSON.stringify(m));
  r = markerCli(home, sid, ['complete-step', '5', '--out-of-order']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /de ESTA vuelta/);
  // manual-forced es escape válido del gate del 5
  markerCli(home, sid, ['set-check', 'advisors', 'green', '--force-manual']);
  r = markerCli(home, sid, ['complete-step', '5', '--out-of-order']);
  assert.equal(r.status, 0, r.stderr);
});

test('complete-step: 4 exige 3 y 8 exige 5 (orden); run-check advisors sin check-count o con --ran no alcanza (H4)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sid = 'sess-o';
  let r = markerCli(home, sid, ['set', JSON.stringify({ storyId: '3.3', stepsPending: [3, 4, 5, 8] })]);
  assert.equal(r.status, 0, r.stderr);
  r = markerCli(home, sid, ['complete-step', '4']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /step\(s\) 3 todavía pendiente/);
  r = markerCli(home, sid, ['complete-step', '8']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /step\(s\) 5 todavía pendiente/);
  // `run-check advisors -- true` → provenance run-check-other → no alcanza
  r = markerCli(home, sid, ['run-check', 'advisors', '--', 'true']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /run-check-other/);
  r = markerCli(home, sid, ['complete-step', '5', '--out-of-order']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /provenance=run-check-other/);
  // check-count con --ran → trust-ran
  r = markerCli(home, sid, ['run-check', 'advisors', '--', 'node', path.join(SCRIPTS, 'pipeline.js'), 'check-count', '--ran', 'x']);
  assert.match(r.stdout + r.stderr, /trust-ran/);
});

test('marker set: mismo storyId no reabre steps completados (R7); marker nuevo sin Step 3 queda en bypass.log; repoPath se resuelve absoluto', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sid = 'sess-u';
  let r = markerCli(home, sid, ['set', JSON.stringify({ storyId: '2.2', repoPath: '.', stepsPending: [0, 1, 2, 3, 4, 5, 6, 7, 8] })]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(path.isAbsolute(JSON.parse(r.stdout).repoPath));
  markerCli(home, sid, ['complete-step', '0']); markerCli(home, sid, ['complete-step', '1']);
  r = markerCli(home, sid, ['set', JSON.stringify({ storyId: '2.2', stepsPending: [0, 1, 2, 3, 4, 5, 6, 7, 8] })]);
  assert.deepEqual(JSON.parse(r.stdout).stepsPending, [2, 3, 4, 5, 6, 7, 8]);
  // marker nuevo (otra sesión) que arranca sin 3 → aviso + bypass.log
  r = markerCli(home, 'sess-v', ['set', JSON.stringify({ storyId: '2.3', stepsPending: [5, 6, 7, 8] })]);
  assert.equal(r.status, 0); assert.match(r.stderr, /SIN el paso «Aprobar el plan»/);
  const bl = () => fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'bypass.log'), 'utf8');
  assert.match(bl(), /MARKER_SKIPS_PLAN/);
  // MISMA story que OMITE el 3 que estaba pendiente: un set no cierra pasos pendientes (@story-8.92), el 3 sigue
  r = markerCli(home, sid, ['set', JSON.stringify({ storyId: '2.2', stepsPending: [5, 6, 7, 8] })]);
  assert.equal(r.status, 0);
  assert.ok(JSON.parse(r.stdout).stepsPending.includes(3), r.stdout);
  assert.doesNotMatch(bl(), /MARKER_DROPS_PLAN/);
  // OTRA story sobre un marker viejo, sin 3 → MARKER_SKIPS_PLAN
  r = markerCli(home, sid, ['set', JSON.stringify({ storyId: '9.9', stepsPending: [5, 6, 7, 8] }), '--replace']);
  assert.equal(r.status, 0);
  assert.equal((bl().match(/MARKER_SKIPS_PLAN/g) || []).length, 2);
  // retomando con stepsCompleted que incluye 3 → sin aviso
  r = markerCli(home, 'sess-w', ['set', JSON.stringify({ storyId: '4.4', stepsPending: [5, 6, 7, 8], stepsCompleted: [0, 1, 2, 3, 4] })]);
  assert.doesNotMatch(r.stderr, /Step 3/);
});

test('check-count: set esperado VACÍO persistido en step5-start → exit 0 (H6), no fail-closed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sid = 'sess-cc';
  const runs = path.join(home, '.claude', '.tycon-pipeline', 'advisor-runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, `${sid}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: 'step5-start', expected: [] }) + '\n');
  const repo = mkRepo(true);
  const story = path.join(repo, 'story.md');
  fs.writeFileSync(story, '---\nstory: "1.1"\nstatus: in-progress\n---\n# S\n');
  const r = spawnSync('node', [path.join(SCRIPTS, 'pipeline.js'), 'check-count', '--repo', repo, '--story', story, '--files', 'README.md'], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout + r.stderr, /VACÍO|vacío/);
});

// ── El arreglo rápido: la firma del dueño en la ventana ─────────────
const estadoDe = (home) => path.join(home, '.claude', '.tycon-pipeline');
const adhocLog = (home) => { try { return fs.readFileSync(path.join(estadoDe(home), 'adhoc.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
const declaracion = (home, sid) => { try { return JSON.parse(fs.readFileSync(io.adhocPath(estadoDe(home), sid), 'utf8')); } catch (_) { return null; } };

// marker.js sin la ventana de prueba: sin pedido de la ventana, como lo corre un agente al que nadie le aprobó nada
function markerSinVentana(home, sid, args, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, ...extraEnv };
  delete env.NODE_OPTIONS;
  return spawnSync('node', [path.join(SCRIPTS, 'marker.js'), ...args], { encoding: 'utf8', env });
}

// marker.js con una terminal de verdad: una pseudo-terminal propia (Python, `pty.fork`), que contesta `respuesta` cuando
// el guion pide «firmo». Sin Python o en Windows no se mide, y se dice.
const CON_TERMINAL = [
  'import os, sys, pty, select',
  'resp = os.environ.pop("RESPUESTA_TTY", "")',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  '    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)',
  'out = b""',
  'enviada = False',
  'while True:',
  '    r, _, _ = select.select([fd], [], [], 20)',
  '    if not r: break',
  '    try: d = os.read(fd, 4096)',
  '    except OSError: break',
  '    if not d: break',
  '    out += d',
  '    if not enviada and "firmo".encode() in out:',
  '        os.write(fd, (resp + "\\n").encode()); enviada = True',
  '_, st = os.waitpid(pid, 0)',
  'sys.stdout.write(out.decode("utf8", "replace"))',
  'sys.exit(os.waitstatus_to_exitcode(st))',
].join('\n');
function markerEnTerminal(home, args, respuesta) {
  if (process.platform === 'win32') return null;
  const env = { ...process.env, HOME: home, USERPROFILE: home, RESPUESTA_TTY: respuesta };
  // la firma por la terminal se niega dentro de la CI: la terminal simulada no hereda sus variables
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_OPTIONS', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS']) delete env[k];
  const r = spawnSync('python3', ['-c', CON_TERMINAL, process.execPath, path.join(SCRIPTS, 'marker.js'), ...args], { encoding: 'utf8', env, timeout: 60000 });
  return r.error ? null : r;
}

test('marker.js adhoc set/get/clear', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sid = 'sess-a';
  let r = markerCli(home, sid, ['adhoc', 'set', '{"reason":"x"}']);
  assert.equal(r.status, 2, 'el motivo corto no llega a la firma');
  r = markerCli(home, sid, ['adhoc', 'set', '{"reason":"hotfix botón guardar deshabilitado","datos":"sin-cambio"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).maxFiles, 8);
  r = markerCli(home, sid, ['adhoc', 'get']);
  assert.equal(r.status, 0); assert.match(r.stdout, /hotfix botón/);
  r = markerCli(home, sid, ['adhoc', 'set', '{"reason":"sigue siendo chico","maxFiles":6}']);
  assert.equal(JSON.parse(r.stdout).maxFiles, 6);
  assert.deepStrictEqual(adhocLog(home).map((e) => e.kind), ['ADHOC_SET', 'ADHOC_UPDATE']);
  r = markerCli(home, sid, ['adhoc', 'clear']);
  assert.equal(r.status, 0);
  assert.equal(markerCli(home, sid, ['adhoc', 'get']).status, 1);
});

// 🔴 Falla con: declarar el carril de nuevo (otro cupo, o el mismo con otro motivo) pierde sus rutas, su marca de riesgo o
// sus constancias: la tarea que sigue en la sesión tiene que volver a correr los revisores y el pase.
test('marker.js adhoc set: declararlo de nuevo, con el motivo que sea, conserva la marca y las constancias', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sid = 'sess-constancias';
  const A = 'tarea A: el combo muestra el nombre completo';
  assert.equal(markerCli(home, sid, ['adhoc', 'set', JSON.stringify({ reason: A, datos: 'sin-cambio' })]).status, 0);
  const archivo = path.join(estadoDe(home), 'adhoc', `${sid}.json`);
  const huella = { huella: 'h-1', at: new Date().toISOString() };
  const deA = { files: ['/repo/src/a.js'], rutas: ['/repo/db/1.sql'], bases: { '/repo': { sha: 'abc' } },
    riesgoAlto: { regla: 'porton-instalador-migracion', archivo: '/repo/db/1.sql' }, revisoresEsperados: { expected: ['x'] }, revisores: huella, pase: huella };
  fs.writeFileSync(archivo, JSON.stringify({ ...JSON.parse(fs.readFileSync(archivo, 'utf8')), ...deA }));
  for (const pedido of [{ reason: A, maxFiles: 6 }, { reason: 'tarea B: otro motivo en la misma sesión' }]) {
    const r = markerCli(home, sid, ['adhoc', 'set', JSON.stringify(pedido)]);
    assert.equal(r.status, 0, r.stderr);
    for (const [k, v] of Object.entries(deA)) assert.deepStrictEqual(JSON.parse(r.stdout)[k], v, `«${pedido.reason}» conserva ${k}`);
  }
  assert.deepStrictEqual(adhocLog(home).map((e) => e.kind), ['ADHOC_SET', 'ADHOC_UPDATE', 'ADHOC_UPDATE']);
});

// 8.141 T9 AdhocSet_SinFirma_NoEscribe @story-8.141 @ac-4 @ac-8 @ac-9
// 🔴 Falla con: `adhoc set` que escribe sin la firma, la declaración sin `via`/`by`, o un renglón del registro sin `via`.
test('8.141 T9 AdhocSet_SinFirma_NoEscribe', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sid = 'sess-t9';
  const SET = ['adhoc', 'set', '{"reason":"arreglo del sp de deudas","maxFiles":3,"datos":"sin-cambio"}'];
  let r = markerSinVentana(home, sid, SET);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /la persona no lo aprobó/);
  assert.match(r.stderr, /adhoc set '\{"reason":"arreglo del sp de deudas","maxFiles":3,"datos":"sin-cambio"\}' --terminal --for-session sess-t9/, 'dice el comando de la terminal entero');
  assert.equal(declaracion(home, sid), null, 'sin firma no escribe');
  assert.equal(adhocLog(home).filter((e) => e.kind === 'ADHOC_SET').length, 0);
  r = markerCli(home, sid, SET);
  assert.equal(r.status, 0, r.stderr);
  const d = declaracion(home, sid);
  assert.equal(d.via, 'ventana');
  assert.equal(d.by, sid);
  assert.equal(d.maxFiles, 3);
  const set = adhocLog(home).filter((e) => e.kind === 'ADHOC_SET');
  assert.equal(set.length, 1);
  assert.equal(set[0].via, 'ventana');
  assert.equal(set[0].by, sid);
  r = markerCli(home, sid, ['adhoc', 'get']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).via, 'ventana');
  assert.equal(JSON.parse(r.stdout).by, sid);
  // en la terminal del dueño, con «firmo»
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const t = markerEnTerminal(home2, [...SET, '--terminal', '--for-session', 'sess-t9b'], 'firmo');
  if (!t) { console.log('⏭ T9 la firma en la terminal: NO MEDIDO — sin Python (o en Windows) para abrir una terminal'); return; }
  assert.equal(t.status, 0, `${t.stdout}${t.stderr}`);
  assert.match(t.stdout, /hasta 3 archivos/, 'la terminal muestra el cupo que se firma');
  assert.equal(declaracion(home2, 'sess-t9b').via, 'terminal');
  assert.equal(adhocLog(home2).filter((e) => e.kind === 'ADHOC_SET')[0].via, 'terminal');
  const no = markerEnTerminal(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')), [...SET, '--terminal', '--for-session', 'sess-t9c'], 'no');
  assert.equal(no.status, 1, `${no.stdout}${no.stderr}`);
});

// 8.141 T9b AdhocSet_LoQueSeFirmaSeVeEntero @story-8.141 @ac-4
// De la revisión de seguridad: la ventana y la terminal muestran el motivo hasta 200 caracteres y el cupo. Un motivo
// más largo o un cupo que no es un entero de 1 a 50 se niegan antes de pedir la firma, así el dueño firma lo que se guarda.
// 🔴 Falla con: un motivo de más de 200 caracteres o un cupo raro que llegan a escribirse.
test('8.141 T9b AdhocSet_LoQueSeFirmaSeVeEntero', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sid = 'sess-t9b';
  for (const payload of [{ reason: 'x'.repeat(201) }, { reason: 'arreglo del sp', maxFiles: 2.5 }, { reason: 'arreglo del sp', maxFiles: 51 }, { reason: 'arreglo del sp', maxFiles: '8' }]) {
    const r = markerCli(home, sid, ['adhoc', 'set', JSON.stringify(payload)]);
    assert.equal(r.status, 2, `${JSON.stringify(payload)}: ${r.stderr}`);
    assert.equal(declaracion(home, sid), null);
  }
  assert.equal(markerCli(home, sid, ['adhoc', 'set', JSON.stringify({ reason: 'x'.repeat(200), maxFiles: 8, datos: 'sin-cambio' })]).status, 0);
  const techo = markerEnTerminal(home, ['adhoc', 'set', JSON.stringify({ reason: 'x'.repeat(200), maxFiles: 50 }), '--terminal', '--for-session', sid], 'firmo');
  if (techo) assert.equal(techo.status, 0, `${techo.stdout}${techo.stderr}`);
});

// La forma sin JSON, para la consola de la persona en Windows. 🔴 Falla con: un pedido por banderas que se firma fuera de
// la terminal, un motivo que se hace pasar por una bandera, o un pedido que no queda igual que el de JSON.
test('AdhocSet_PorBanderas_SoloEnLaTerminal_YQuedaIgualQueConJson', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sid = 'sess-banderas';
  for (const [args, dice] of [
    [['--reason', 'arreglo del sp de deudas'], /sólo con --terminal/],
    [['--max-files', '3', '--terminal'], /falta --reason/],
    [['--reason', '--terminal', '--terminal'], /no puede empezar con «-»/],
    [['--reason', '--for-session', 'otra', '--terminal'], /no puede empezar con «-»/],
    [['--reason', '-x motivo largo', '--terminal'], /no puede empezar con «-»/],
    [['--reason'], /--reason necesita un valor/],
    [['--reason', 'arreglo del sp de deudas', '--reason', 'otro motivo cualquiera', '--terminal'], /una sola vez/],
    [['--reason', 'arreglo del sp de deudas', '--max-files', 'tres', '--terminal'], /número entero/],
    [['--reason', 'arreglo del sp de deudas', '--max-files', '-3', '--terminal'], /no puede empezar con «-»/],
    [['--reason', 'arreglo del sp de deudas', '--quote', 'dijo que sí', '--terminal'], /no conozco «--quote»/],
    [['--reason', 'arreglo del sp de deudas', '--mockup', 'm.html', '--terminal'], /no conozco «--mockup»/],
    [['--reason', 'x', '--terminal'], /≥8 caracteres/],
    [['--reason', 'x'.repeat(201), '--terminal'], /hasta 200 caracteres/],
    [['--reason', 'arreglo del sp de deudas', '--max-files', '51', '--terminal'], /entero de 1 a 50/],
  ]) {
    const r = markerSinVentana(home, sid, ['adhoc', 'set', ...args]);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, dice, args.join(' '));
    assert.equal(declaracion(home, sid), null, `${args.join(' ')}: no escribe`);
  }
  assert.equal(adhocLog(home).length, 0);
  const banderas = markerEnTerminal(home, ['adhoc', 'set', '--reason', 'arreglo del sp de deudas', '--max-files', '3', '--data', 'sin-cambio', '--terminal', '--for-session', 'sess-b'], 'firmo');
  if (!banderas) { console.log('⏭ la firma por banderas en la terminal: NO MEDIDO — sin Python (o en Windows) para abrir una terminal'); return; }
  assert.equal(banderas.status, 0, `${banderas.stdout}${banderas.stderr}`);
  assert.match(banderas.stdout, /«arreglo del sp de deudas» · hasta 3 archivos/, 'la terminal muestra el motivo y el cupo que se firman');
  const json = markerEnTerminal(home, ['adhoc', 'set', '{"reason":"arreglo del sp de deudas","maxFiles":3,"datos":"sin-cambio"}', '--terminal', '--for-session', 'sess-j'], 'firmo');
  assert.equal(json.status, 0, `${json.stdout}${json.stderr}`);
  // lo único que cambia entre las dos es la sesión y la hora
  const loPedido = (d) => { const { declaredAt, lastTouch, firmadaEn, by, ...resto } = d; return resto; };
  assert.deepStrictEqual(loPedido(declaracion(home, 'sess-b')), loPedido(declaracion(home, 'sess-j')));
  assert.equal(declaracion(home, 'sess-b').via, 'terminal');
  const no = markerEnTerminal(home, ['adhoc', 'set', '--reason', 'otro arreglo chico', '--data', 'sin-cambio', '--terminal', '--for-session', 'sess-no'], 'no');
  assert.equal(no.status, 1, `${no.stdout}${no.stderr}`);
  assert.equal(declaracion(home, 'sess-no'), null);
  assert.match(`${no.stdout}${no.stderr}`, /adhoc set --reason "otro arreglo chico" --data sin-cambio --terminal --for-session sess-no/, 'dice el comando en la misma forma');
});

// En Windows la consola de la persona no se lleva bien con el JSON: el aviso da la forma sin él, salvo que no se pueda.
test('AdhocSet_EnWindows_ElAvisoDaLaFormaSinJson', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const win = { TYCON_WAIVER_PLATFORM: 'win32' };
  let r = markerSinVentana(home, 'sess-w', ['adhoc', 'set', '{"reason":"arreglo del sp de deudas","maxFiles":3,"datos":"sin-cambio"}'], win);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /adhoc set --reason "arreglo del sp de deudas" --max-files 3 --data sin-cambio --terminal --for-session sess-w/);
  r = markerSinVentana(home, 'sess-w', ['adhoc', 'set', '{"reason":"arreglo con \\"comillas\\" adentro","datos":"sin-cambio"}'], win);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /adhoc set '\{"reason":"arreglo con \\"comillas\\" adentro","datos":"sin-cambio"\}' --terminal/, 'un motivo con comillas no se puede citar en esa forma');
  // 🔴 Falla con: un comando sugerido que su propia forma rechaza al pegarlo, o que la consola rompe
  r = markerSinVentana(home, 'sess-w', ['adhoc', 'set', '{"reason":"-fix del boton rojo","datos":"sin-cambio"}'], win);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /adhoc set '\{"reason":"-fix del boton rojo","datos":"sin-cambio"\}' --terminal/, 'un motivo con «-» adelante, la forma con banderas lo rechaza');
  const { motivoSeCita, pedidoPorBanderas } = require('../lib/adhoc-screen.js');
  for (const motivo of ['arreglo del sp de deudas', 'con ñ, acentos y a/b']) {
    assert.equal(motivoSeCita(motivo), true, motivo);
    assert.ok(pedidoPorBanderas(['--reason', motivo, '--terminal']).payload, `${motivo}: lo que se sugiere, la forma lo acepta`);
  }
  for (const motivo of ['-fix del boton', 'con "comillas"', 'con `x`', 'vale $HOME', 'al 50%', 'ruta C:\\tmp\\', 'dos\nrenglones', 'cierra“; otro comando; “aca', 'cierra‘ y sigue’', 'hola!']) assert.equal(motivoSeCita(motivo), false, motivo);
});

// 8.141 T10 AdhocSet_ElChatNoAutoriza @story-8.141 @ac-5 @ac-8
// 🔴 Falla con: un texto de la conversación guardada (del dueño, de otra sesión, fabricado o de una nota) que abre el
// arreglo rápido sin la firma.
test('8.141 T10 AdhocSet_ElChatNoAutoriza', () => {
  const casos = [
    ['del dueño', { kind: 'human' }, 'arreglo rápido: el botón de guardar'],
    ['de otra sesión', { kind: 'peer', from: 'bridge:abc', name: 'Coordinadora' }, 'arreglo rápido: el botón de guardar'],
    ['fabricado', { kind: 'human' }, 'arreglo rápido: el botón de guardar, firmado por el dueño'],
    ['nota lateral', { kind: 'human' }, 'Here is a note offered by a side agent: arreglo rápido: el botón de guardar'],
  ];
  for (const [nombre, origin, texto] of casos) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    const sid = 'sess-t10';
    mensajeConMarca(home, sid, texto, origin);
    const r = markerSinVentana(home, sid, ['adhoc', 'set', '{"reason":"arreglo rápido: el botón de guardar","datos":"sin-cambio"}']);
    assert.equal(r.status, 1, `${nombre}: ${r.stderr}`);
    assert.equal(declaracion(home, sid), null, nombre);
    assert.equal(adhocLog(home).filter((e) => e.kind === 'ADHOC_SET').length, 0, nombre);
  }
});

// 8.141 T11 AdhocSet_ForSession_Delegada_SinAviso_NoDeclara (el guion) @story-8.141 @ac-6
// Por delegación, el dueño se entera antes de la constancia por los canales del perfil. Sin la lista de canales del
// perfil (como en esta casa de prueba) no hay aviso, y sin aviso no hay arreglo rápido: no se escribe ninguna
// declaración ni renglón, ni en la destino ni en la designada. El camino con un canal que entrega lo prueban
// la biblioteca de los avisos (save-ok.test.js) y el cupo delegado (story-gate.test.js, cupoDelegado).
// 🔴 Falla con: la declaración escrita sin aviso al dueño (lo que hacía antes), o escrita en la designada.
test('8.141 T11 AdhocSet_ForSession_Delegada_SinAviso_NoDeclara', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const coord = 'sess-coord';
  const destino = 'sess-dest';
  const args = ['adhoc', 'set', '{"reason":"arreglo del sp de deudas","maxFiles":7,"datos":"sin-cambio"}', '--for-session', destino];
  const env = conVentana({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: coord }, { delegadaPor: coord });
  const r = spawnSync('node', [path.join(SCRIPTS, 'marker.js'), ...args], { encoding: 'utf8', env });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /sin aviso a la persona, la coordinadora no abre el arreglo rápido/);
  assert.equal(declaracion(home, destino), null, 'la destino sin declaración');
  assert.equal(declaracion(home, coord), null, 'la designada sin declaración');
  assert.deepStrictEqual(adhocLog(home).map((e) => e.kind), [], 'ningún renglón');
});

const firmasDe = (home) => { try { return fs.readFileSync(path.join(estadoDe(home), 'signatures.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
const PEDIDO_9 = '{"reason":"arreglo del sp de deudas","maxFiles":9,"datos":"sin-cambio"}';

test('T14 AdhocSet_SobreCupoAprobado_QuedaAnotadoQueLoEligioElDev @story-8.181 @ac-6', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  // la ventana no alcanza: lo elige la persona con su click o su terminal
  const conVentanaNoVale = markerCli(home, 'sess-a', ['adhoc', 'set', PEDIDO_9]);
  assert.equal(conVentanaNoVale.status, 1, conVentanaNoVale.stderr);
  assert.match(conVentanaNoVale.stderr, /sólo el click de la persona o su terminal/);
  assert.equal(declaracion(home, 'sess-a'), null);
  const r = markerEnTerminal(home, ['adhoc', 'set', PEDIDO_9, '--terminal', '--for-session', 'sess-a'], 'firmo');
  if (!r) { console.log('⏭ la firma en la terminal: NO MEDIDO — sin Python (o en Windows) para abrir una terminal'); return; }
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const d = declaracion(home, 'sess-a');
  assert.deepStrictEqual([d.sobreCupo, d.cupoPedido, d.eligio, d.via, d.maxFiles], [true, 9, 'persona', 'terminal', 9]);
  const renglon = adhocLog(home).find((e) => e.kind === 'ADHOC_SET');
  assert.deepStrictEqual([renglon.sobreCupo, renglon.cupoPedido, renglon.eligio, renglon.via], [true, 9, 'persona', 'terminal']);
  const firma = firmasDe(home).find((f) => f.signature === 'adhoc-lane:sobre-cupo');
  assert.ok(firma, 'el registro común de firmas la anota');
  assert.strictEqual(firma.level, 2);
  // la firma abre el portón: sin este renglón, el click pasaría y el carril no abriría
  assert.ok(io.adhocFirmado(estadoDe(home), 'sess-a', d), 'el portón la reconoce');
  // pedir sin número conserva el cupo y la marca, con la firma común
  const sigue = markerCli(home, 'sess-a', ['adhoc', 'set', '{"reason":"arreglo del sp de deudas, sigue"}']);
  assert.equal(sigue.status, 0, sigue.stderr);
  assert.deepStrictEqual((({ sobreCupo, cupoPedido, eligio, maxFiles }) => [sobreCupo, cupoPedido, eligio, maxFiles])(JSON.parse(sigue.stdout)), [true, 9, 'persona', 9]);
});

test('T15 AdhocClear_SobreCupo_AnotaLosArchivosTocados @story-8.181 @ac-6', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-')));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  fs.mkdirSync(path.join(repo, 'src'));
  const a = path.join(repo, 'src', 'a.js');
  fs.writeFileSync(a, 'x\n');
  fs.mkdirSync(path.dirname(io.adhocPath(estadoDe(home), 'sess-a')), { recursive: true });
  fs.writeFileSync(io.adhocPath(estadoDe(home), 'sess-a'), JSON.stringify({ reason: 'arreglo grande', maxFiles: 9, sobreCupo: true, cupoPedido: 9, eligio: 'persona', files: [a, '/tmp/sonda.js'], bases: {} }));
  assert.equal(markerSinVentana(home, 'sess-a', ['adhoc', 'clear']).status, 0);
  const c = adhocLog(home).find((e) => e.kind === 'ADHOC_CLEAR');
  assert.deepStrictEqual([c.sobreCupo, c.cupoPedido, c.eligio, c.contados, c.archivos], [true, 9, 'persona', 1, [a]]);
});

// 🔴 Falla con: la cuenta leída con `readAdhoc`, que da nada pasadas las 6 horas: se pierde el dato del sobre cupo.
test('AdhocClear_SobreCupoVencido_AnotaLaCuentaIgual @story-8.181 @ac-6', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-')));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  fs.mkdirSync(path.join(repo, 'src'));
  const a = path.join(repo, 'src', 'a.js');
  fs.writeFileSync(a, 'x\n');
  const viejo = new Date(Date.now() - 7 * 3600000).toISOString();
  fs.mkdirSync(path.dirname(io.adhocPath(estadoDe(home), 'sess-a')), { recursive: true });
  fs.writeFileSync(io.adhocPath(estadoDe(home), 'sess-a'), JSON.stringify({ reason: 'arreglo grande', maxFiles: 9, sobreCupo: true, cupoPedido: 9, eligio: 'persona', files: [a], declaredAt: viejo, lastTouch: viejo }));
  assert.equal(markerSinVentana(home, 'sess-a', ['adhoc', 'clear']).status, 0);
  const c = adhocLog(home).find((e) => e.kind === 'ADHOC_CLEAR');
  assert.deepStrictEqual([c.sobreCupo, c.cupoPedido, c.eligio, c.contados, c.archivos], [true, 9, 'persona', 1, [a]]);
});

// 🔴 Falla con: la ruta absoluta mirada entera: un repo debajo de una carpeta `tests` cuenta cero archivos y nunca frena.
test('ArchivosQueSuman_RepoDebajoDeTests_Cuentan @story-8.181 @ac-10', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'porton-')));
  const repo = path.join(base, 'tests', 'r');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q']);
  const a = path.join(repo, 'src', 'a.js');
  fs.writeFileSync(a, 'x\n');
  assert.deepStrictEqual(io.archivosQueSuman([a]), [a]);
});

// 🔴 Falla con: una declaración ilegible o medida con menos que queda en el registro como un cierre normal.
test('AdhocClear_RegistroDiceLoQueNoSeMidio @story-8.181 @ac-6', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-')));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  fs.mkdirSync(path.join(repo, 'src'));
  const a = path.join(repo, 'src', 'a.js');
  fs.writeFileSync(a, 'x\n');
  const p = io.adhocPath(estadoDe(home), 'sess-a');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ reason: 'arreglo grande', maxFiles: 9, sobreCupo: true, cupoPedido: 9, eligio: 'persona', files: [a], declaredAt: new Date().toISOString(), lastTouch: new Date().toISOString() }));
  assert.equal(markerSinVentana(home, 'sess-a', ['adhoc', 'clear']).status, 0);
  assert.match(adhocLog(home).find((e) => e.kind === 'ADHOC_CLEAR').medidoConMenos[0], /no tiene su base/, 'sin origin/main se midió con menos');
  fs.writeFileSync(p, 'esto no es un json');
  assert.equal(markerSinVentana(home, 'sess-a', ['adhoc', 'clear']).status, 0);
  assert.match(adhocLog(home).filter((e) => e.kind === 'ADHOC_CLEAR').pop().sinMedir, /declaración ilegible/);
});

test('T20 OnEdit_RepoDelArnes_CuentaElArchivo @story-8.181 @ac-9', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clon-')));
  const repo = path.join(base, 'tycon-harness');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q']);
  const ahora = new Date().toISOString();
  fs.mkdirSync(path.dirname(io.adhocPath(estadoDe(home), 'sess-a')), { recursive: true });
  fs.writeFileSync(io.adhocPath(estadoDe(home), 'sess-a'), JSON.stringify({ reason: 'arreglo en el arnés', maxFiles: 8, files: [], declaredAt: ahora, lastTouch: ahora, firmadaEn: ahora }));
  fs.appendFileSync(path.join(estadoDe(home), 'gates.log'), `${JSON.stringify({ name: 'adhoc-lane-signed', status: 'ok', destino: 'sess-a', ts: ahora })}\n`);
  const archivo = path.join(repo, 'scripts', 'x.js');
  fs.writeFileSync(archivo, 'x\n');
  const r = spawnSync('node', [path.join(SCRIPTS, 'on-edit.js')], { encoding: 'utf8', input: JSON.stringify({ session_id: 'sess-a', tool_name: 'Edit', tool_input: { file_path: archivo } }),
    env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepStrictEqual(declaracion(home, 'sess-a').files, [archivo]);
});

test('T21 Cuenta_TemporalesYRutasInexistentes_NoCuentan @story-8.181 @ac-10', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-')));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.mkdirSync(path.join(repo, 'src'));
  const real = path.join(repo, 'src', 'a.js');
  fs.writeFileSync(real, 'x\n');
  const prueba = path.join(repo, 'src', 'a.test.js');
  fs.writeFileSync(prueba, 'x\n');
  const sonda = path.join(os.tmpdir(), `sonda-${process.pid}.js`);
  fs.writeFileSync(sonda, 'x\n');
  const ahora = new Date().toISOString();
  const st = estadoDe(home);
  fs.mkdirSync(path.dirname(io.adhocPath(st, 'sess-a')), { recursive: true });
  fs.writeFileSync(io.adhocPath(st, 'sess-a'), JSON.stringify({ reason: 'arreglo con sondas', maxFiles: 2, files: [sonda, '$L/p.js', path.join(repo, '$L', 'p.js'), prueba, real], declaredAt: ahora, lastTouch: ahora, firmadaEn: ahora }));
  fs.appendFileSync(path.join(st, 'gates.log'), `${JSON.stringify({ name: 'adhoc-lane-signed', status: 'ok', destino: 'sess-a', ts: ahora })}\n`);
  try {
    // la lista cruda ya pasó el cupo de 2; de implementación, en un repo y que exista, hay uno solo
    const uno = io.evaluate({ filePath: path.join(repo, 'src', 'b.js'), sessionId: 'sess-a', cwd: repo, stateDir: st, installedRoots: [] });
    assert.strictEqual(uno.verdict.action, 'pass', uno.message);
    const { cuentaDelCarril } = require(path.join(SCRIPTS, 'lib', 'adhoc-base.js'));
    assert.deepStrictEqual(cuentaDelCarril(JSON.parse(fs.readFileSync(io.adhocPath(st, 'sess-a'), 'utf8'))).archivos, [real]);
    // con el cupo lleno de verdad, frena
    io.recordAdhocFile(st, 'sess-a', path.join(repo, 'src', 'b.js'));
    fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'x\n');
    const dos = io.evaluate({ filePath: path.join(repo, 'src', 'c.js'), sessionId: 'sess-a', cwd: repo, stateDir: st, installedRoots: [] });
    assert.strictEqual(dos.verdict.kind, 'adhoc-cap', dos.message);
  } finally { fs.rmSync(sonda, { force: true }); }
});

test('T30 AdhocSet_CarrilViejoConMasDeOcho_SigueConSuNumero @story-8.181 @ac-14', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-')));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.mkdirSync(path.join(repo, 'src'));
  const archivos = Array.from({ length: 17 }, (_, i) => path.join(repo, 'src', `f${i}.js`));
  for (const f of archivos) fs.writeFileSync(f, 'x\n');
  const ahora = new Date().toISOString();
  const st = estadoDe(home);
  fs.mkdirSync(path.dirname(io.adhocPath(st, 'sess-a')), { recursive: true });
  fs.writeFileSync(io.adhocPath(st, 'sess-a'), JSON.stringify({ reason: 'arreglo de antes del cambio', maxFiles: 18, files: archivos, declaredAt: ahora, lastTouch: ahora, firmadaEn: ahora, via: 'ventana', by: 'sess-a' }));
  fs.appendFileSync(path.join(st, 'gates.log'), `${JSON.stringify({ name: 'adhoc-lane-signed', status: 'ok', destino: 'sess-a', ts: ahora })}\n`);
  const nuevo = path.join(repo, 'src', 'nuevo.js');
  assert.strictEqual(io.evaluate({ filePath: nuevo, sessionId: 'sess-a', cwd: repo, stateDir: st, installedRoots: [] }).verdict.action, 'pass');
  // pedir sin número no pide la firma nueva, ni sube la marca
  const r = markerCli(home, 'sess-a', ['adhoc', 'set', '{"reason":"arreglo de antes, sigue igual"}']);
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.strictEqual(d.maxFiles, 18);
  assert.strictEqual(d.sobreCupo, undefined);
  // pedir uno mayor, sí
  const mayor = markerCli(home, 'sess-a', ['adhoc', 'set', '{"reason":"arreglo de antes, más grande","maxFiles":19}']);
  assert.equal(mayor.status, 1, mayor.stderr);
});

test('T45 AdhocSet_SobreCupo_PorTerminal_QuedaAnotado @story-8.181 @ac-4 @ac-6', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const r = markerEnTerminal(home, ['adhoc', 'set', '--reason', 'arreglo del sp de deudas', '--max-files', '12', '--data', 'sin-cambio', '--terminal', '--for-session', 'sess-b'], 'firmo');
  if (!r) { console.log('⏭ la firma en la terminal: NO MEDIDO — sin Python (o en Windows) para abrir una terminal'); return; }
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const d = declaracion(home, 'sess-b');
  assert.deepStrictEqual([d.via, d.eligio, d.sobreCupo, d.cupoPedido], ['terminal', 'persona', true, 12]);
  assert.strictEqual(firmasDe(home).find((f) => f.signature === 'adhoc-lane:sobre-cupo').via, 'terminal');
});

// 8.141 T14 AdhocSet_PortonApagado_SigueFirmando @story-8.141 @ac-12
// 🔴 Falla con: `TYCON_STORY_GATE=off` que deja declarar sin firma, o la firma con el portón apagado sin su renglón en
// bypass.log.
test('8.141 T14 AdhocSet_PortonApagado_SigueFirmando', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sid = 'sess-t14';
  const SET = ['adhoc', 'set', '{"reason":"arreglo del sp de deudas","datos":"sin-cambio"}'];
  let r = markerSinVentana(home, sid, SET, { TYCON_STORY_GATE: 'off' });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(declaracion(home, sid), null);
  r = markerCli(home, sid, SET, { TYCON_STORY_GATE: 'off' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(declaracion(home, sid).via, 'ventana');
  assert.match(fs.readFileSync(path.join(estadoDe(home), 'bypass.log'), 'utf8'), /STORY_GATE_OFF_ADHOC/);
});

// ── gates.log con namespace de repo ─────────────────────────
test('gates.log: cada entry de marker.js lleva repoPath del marker (dos repos con la misma "S1" no se mezclan)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const log = path.join(home, '.claude', '.tycon-pipeline', 'gates.log');
  const repoA = mkRepo(true); const repoB = mkRepo(true);
  fs.writeFileSync(path.join(repoA, 'story.md'), '---\nstory: "S1"\nstatus: in-progress\n---\n# S1 A\n');
  fs.writeFileSync(path.join(repoB, 'story.md'), '---\nstory: "S1"\nstatus: in-progress\n---\n# S1 B\n');
  let r = markerCli(home, 'sess-a', ['set', JSON.stringify({ storyId: 'S1', storyPath: path.join(repoA, 'story.md'), repoPath: repoA, stepsPending: [1, 2, 3, 4, 5, 6, 7, 8] })]);
  assert.equal(r.status, 0, r.stderr);
  r = markerCli(home, 'sess-a', ['run-check', 'build', '--', 'node', '-e', 'process.exit(0)']);
  assert.equal(r.status, 0, r.stderr);
  r = markerCli(home, 'sess-b', ['set', JSON.stringify({ storyId: 'S1', storyPath: path.join(repoB, 'story.md'), repoPath: repoB, stepsPending: [1, 2, 3, 4, 5, 6, 7, 8] })]);
  assert.equal(r.status, 0, r.stderr);
  r = markerCli(home, 'sess-b', ['run-check', 'build', '--', 'node', '-e', 'process.exit(0)']);
  assert.equal(r.status, 0, r.stderr);
  const checks = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.check === 'build');
  assert.equal(checks.length, 2);
  assert.equal(checks[0].storyId, 'S1'); assert.equal(checks[1].storyId, 'S1');
  assert.equal(fs.realpathSync(checks[0].repoPath), fs.realpathSync(repoA));
  assert.equal(fs.realpathSync(checks[1].repoPath), fs.realpathSync(repoB));
  assert.notEqual(checks[0].repoPath, checks[1].repoPath, 'mismo storyId, repos distintos → entries distinguibles');
});

// ── quién es un repo del harness: lo dice el remoto, no la carpeta ──────────────────
// El criterio vive en el arnés (tycon-claude-guides/scripts/lib/harness-repo.js) y el borde lo
// carga UNA vez por proceso: cada escenario corre en un proceso hijo con su TYCON_GUIDES_DIR.
const IO = path.join(SCRIPTS, 'lib', 'story-gate-io.js');
const SIO = path.join(SCRIPTS, 'lib', 'story-skill-gate-io.js');
const S99 = '---\nstory: "9.9"\nepic: "9"\nstatus: backlog\n---\n# Story 9.9\n';

function repoGit(dir, origin) {
  fs.mkdirSync(path.join(dir, '.tycon'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin], { stdio: 'ignore' });
  return dir;
}
function enHijo(tcg, codigo, args, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-h-'));
  const r = spawnSync('node', ['-e', codigo, ...args, path.join(home, 'st')], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_GUIDES_DIR: tcg, TCG: '', ...extraEnv },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const porton = (tcg, file, extraEnv) => enHijo(tcg,
  `const io=require(${JSON.stringify(IO)});process.stdout.write(JSON.stringify(io.evaluate({filePath:process.argv[1],sessionId:'s-h',via:'Edit',stateDir:process.argv[2]}).verdict))`, [file], extraEnv);
const frenoDeStory = (tcg, file) => enHijo(tcg,
  `const sio=require(${JSON.stringify(SIO)});process.stdout.write(JSON.stringify(sio.evaluate({absPath:process.argv[1],content:${JSON.stringify(S99)},sessionId:'s-h',via:'Write',stateDir:process.argv[2]}).verdict))`, [file]);

// `nombre`: con cuál de sus dos nombres trae el criterio ese arnés (el anterior, por defecto: un
// arnés un pull atrás; `harness-repo.js`: el actual, que es el único que trae una copia sin reemplazos).
function tcgDeMentira(nombre = 'repo-del-arnes.js') { // un arnés cuyo criterio es: «es del arnés si la ruta dice ES-ARNES»
  const tcg = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-stub-'));
  fs.mkdirSync(path.join(tcg, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(tcg, 'scripts', 'lib', nombre), 'module.exports={esRutaDelArnes:(p)=>/ES-ARNES/.test(String(p))};\n');
  // Un «clon del arnés» tiene scripts/install-tycon-hooks.sh: es lo que exige lib/harness-path.js antes de hacer
  // require() de código en un hook. Sin él, la variable se ignora, se cae al
  // enlace del HOME temporal —que no existe— y el portón decide por la carpeta: `block`.
  fs.writeFileSync(path.join(tcg, 'scripts', 'install-tycon-hooks.sh'), '#!/usr/bin/env bash\nexit 0\n');
  return tcg;
}
// Las identidades del arnés se INYECTAN: la CI corre con HOME temporal y sin TYCON_SKILLS_DIR,
// así que repo-del-arnes.js no encuentra agent-skills para derivar su identidad del origin de la máquina.
// La variable la lee sólo el arnés, con su nombre en inglés; el nombre viejo anda por alias.
const IDENTIDADES_ARNES = { TYCON_HARNESS_IDENTITIES: 'https://dev.azure.com/org-del-equipo/tycon-claude-guides/_git/tycon-claude-guides,https://org-del-equipo.visualstudio.com/AgentSkills/_git/AgentSkills' };
// La lib real, donde esté: variable, cwd (así corre el nocturno) o el arnés instalado. Se reconoce por el criterio con su
// nombre actual: buscarlo por el anterior (`repo-del-arnes.js`) saltearía la prueba en la copia pública, y desde la carpeta del
// repo privado —que todavía guarda ese archivo viejo y no el código del portón— la correría contra un árbol sin el criterio y
// saldría roja.
function tcgDeVerdad() {
  const cand = [process.env.TYCON_GUIDES_DIR, process.env.TCG, process.cwd(), path.join(os.homedir(), '.tycon', 'harness')];
  return cand.find((d) => d && fs.existsSync(path.join(d, 'scripts', 'lib', 'harness-repo.js'))) || null;
}

test('harness: el portón le cree al criterio del arnés, no a la carpeta — en los dos sentidos', () => {
  const tcg = tcgDeMentira();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'porton-'));
  const clon = repoGit(path.join(base, 'ES-ARNES', 'clon'));
  const producto = repoGit(path.join(base, 'tycon-claude-guides', 'MiProducto'));
  // La carpeta del clon no se llama como el arnés y aun así es del arnés (si decidiera la carpeta daría `no-lane`).
  const a = porton(tcg, path.join(clon, 'src', 'a.js'));
  assert.equal(a.action, 'pass', JSON.stringify(a)); assert.match(a.reason, /harness/);
  // Un segmento con el nombre del arnés no alcanza: si alcanzara, código de producto quedaría sin carril, en silencio.
  const b = porton(tcg, path.join(producto, 'src', 'a.js'));
  assert.equal(b.action, 'block', JSON.stringify(b)); assert.equal(b.kind, 'no-lane');
  // gemelo con el nombre público: bajo una carpeta llamada como el lugar, tampoco
  twin(() => {
    const b2 = porton(tcg, path.join(repoGit(path.join(base, PUBLIC_NAME, 'MiProducto')), 'src', 'a.js'));
    assert.equal(b2.action, 'block', JSON.stringify(b2)); assert.equal(b2.kind, 'no-lane');
  });
  // El freno de story-a-mano usa el mismo criterio.
  assert.equal(frenoDeStory(tcg, path.join(clon, 'specs', '9-9.md')).kind, 'harness');
  assert.notEqual(frenoDeStory(tcg, path.join(producto, 'specs', '9-9.md')).kind, 'harness');
});

// El criterio se busca también por su nombre actual, no sólo por el de antes del renombre. En el equipo anda por
// el reemplazo que deja el renombre; en una copia sin reemplazos el portón caería al nombre de carpeta sin decirlo.
// Con un arnés que trae sólo `harness-repo.js`, el clon tiene que ser del arnés (si decidiera la carpeta daría `no-lane`).
test('harness: el criterio del arnés se encuentra por su nombre de hoy, sin el reemplazo del nombre de antes', () => {
  const tcg = tcgDeMentira('harness-repo.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'porton-'));
  const clon = repoGit(path.join(base, 'ES-ARNES', 'clon'));
  const producto = repoGit(path.join(base, 'tycon-claude-guides', 'MiProducto'));
  const a = porton(tcg, path.join(clon, 'src', 'a.js'));
  assert.equal(a.action, 'pass', JSON.stringify(a)); assert.match(a.reason, /harness/);
  const b = porton(tcg, path.join(producto, 'src', 'a.js'));
  assert.equal(b.action, 'block', JSON.stringify(b)); assert.equal(b.kind, 'no-lane');
  // gemelo con el nombre público
  twin(() => {
    const b2 = porton(tcg, path.join(repoGit(path.join(base, PUBLIC_NAME, 'MiProducto')), 'src', 'a.js'));
    assert.equal(b2.action, 'block', JSON.stringify(b2)); assert.equal(b2.kind, 'no-lane');
  });
});

// Con el arnés UBICADO pero sin el archivo del criterio —ni con su nombre actual ni con el anterior—, el portón no cae al
// nombre de carpeta callado: decide la carpeta igual (nunca rompe un Edit), y lo dice por la salida de error
// (sin esto, la salida de error saldría vacía).
test('harness: el arnés está pero no trae el criterio con ninguno de sus dos nombres — decide la carpeta y LO DICE', () => {
  const tcg = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-sin-criterio-'));
  fs.mkdirSync(path.join(tcg, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(tcg, 'scripts', 'install-tycon-hooks.sh'), '#!/usr/bin/env bash\nexit 0\n');   // es un clon del arnés
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'porton-'));
  const enCarpeta = repoGit(path.join(base, 'agent-skills', 'x'));
  const suelto = repoGit(path.join(base, 'otro', 'x'));
  const correr = (file) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-h-'));
    const r = spawnSync('node', ['-e',
      `const io=require(${JSON.stringify(IO)});process.stdout.write(JSON.stringify(io.evaluate({filePath:process.argv[1],sessionId:'s-h',via:'Edit',stateDir:process.argv[2]}).verdict))`,
      file, path.join(home, 'st')], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_GUIDES_DIR: tcg, TCG: '' } });
    assert.equal(r.status, 0, r.stderr);
    return { verdict: JSON.parse(r.stdout), stderr: r.stderr || '' };
  };
  const a = correr(path.join(enCarpeta, 'src', 'a.js'));
  assert.equal(a.verdict.action, 'pass', 'decide la carpeta, como siempre');
  assert.match(a.stderr, /harness-repo\.js/, `dice qué archivo no encontró: «${a.stderr}»`);
  assert.match(a.stderr, /nombre de carpeta/, 'y que decide por el nombre de carpeta');
  assert.ok(a.stderr.includes(tcg), 'y en qué arnés lo buscó');
  const b = correr(path.join(suelto, 'src', 'a.js'));
  assert.equal(b.verdict.kind, 'no-lane');
  assert.match(b.stderr, /nombre de carpeta/);
  // el criterio está y no carga (un archivo a medio escribir): decide la carpeta y también lo dice
  fs.writeFileSync(path.join(tcg, 'scripts', 'lib', 'harness-repo.js'), 'module.exports = {{{\n');
  const c = correr(path.join(suelto, 'src', 'a.js'));
  assert.equal(c.verdict.kind, 'no-lane');
  assert.match(c.stderr, /no pude cargar el criterio del arnés.*nombre de carpeta/);
  // con el criterio a mano no dice nada de esto
  const ok = spawnSync('node', ['-e', `const io=require(${JSON.stringify(IO)});io.evaluate({filePath:process.argv[1],sessionId:'s-h',via:'Edit',stateDir:process.argv[2]})`,
    path.join(suelto, 'src', 'a.js'), path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'home-h-')), 'st')],
  { encoding: 'utf8', env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'home-h-')), TYCON_GUIDES_DIR: tcgDeMentira('harness-repo.js'), TCG: '' } });
  assert.doesNotMatch(ok.stderr || '', /nombre de carpeta/, 'con el criterio a mano no avisa');
});

// El criterio está y carga, pero no trae `esRutaDelArnes`, o la trae y revienta. En los dos casos el portón decide
// la carpeta igual (nunca rompe un Edit) y lo dice (sin esto, la salida de error saldría vacía).
test('harness: el criterio carga pero no sirve (sin la función, o la función revienta) — decide la carpeta y LO DICE', () => {
  for (const [caso, cuerpo, aviso] of [
    ['sin la función', 'module.exports={otraCosa:()=>true};\n', /no trae esRutaDelArnes.*nombre de carpeta/],
    ['la función revienta', 'module.exports={esRutaDelArnes:()=>{throw new Error("roto")}};\n', /criterio del arnés falló.*nombre de carpeta/],
  ]) {
    const tcg = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-criterio-raro-'));
    fs.mkdirSync(path.join(tcg, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tcg, 'scripts', 'install-tycon-hooks.sh'), '#!/usr/bin/env bash\nexit 0\n');
    fs.writeFileSync(path.join(tcg, 'scripts', 'lib', 'harness-repo.js'), cuerpo);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'porton-'));
    const suelto = repoGit(path.join(base, 'otro', 'x'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-h-'));
    const r = spawnSync('node', ['-e',
      `const io=require(${JSON.stringify(IO)});const v=(f)=>io.evaluate({filePath:f,sessionId:'s-h',via:'Edit',stateDir:process.argv[2]}).verdict;v(process.argv[1]);process.stdout.write(JSON.stringify(v(process.argv[1])))`,
      path.join(suelto, 'src', 'a.js'), path.join(home, 'st')], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_GUIDES_DIR: tcg, TCG: '' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).kind, 'no-lane', `${caso}: decide la carpeta, como siempre`);
    assert.match(r.stderr || '', aviso, `${caso}: lo dice — «${r.stderr}»`);
    assert.equal((r.stderr.match(/nombre de carpeta/g) || []).length, 1, `${caso}: una vez por proceso, no en cada edición — «${r.stderr}»`);
  }
});

test('harness: sin la lib del arnés (máquina atrasada) decide la carpeta, como siempre — nunca rompe un Edit', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'porton-'));
  const enCarpeta = repoGit(path.join(base, 'agent-skills', 'x'));
  const suelto = repoGit(path.join(base, 'otro', 'x'));
  assert.equal(porton('/no/existe', path.join(enCarpeta, 'src', 'a.js')).action, 'pass');
  assert.equal(porton('/no/existe', path.join(suelto, 'src', 'a.js')).kind, 'no-lane');
});

// 🔴 Falla con: el tope reevaluado con `isHarness: false`, que deja pasar a un clon del arnés sin `.tycon/`.
test('Evaluate_ClonDelArnesSinTycon_FrenaAlPasarElTope @story-8.181 @ac-7', () => {
  const tcg = tcgDeMentira();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'porton-'));
  const clon = repoGit(path.join(fs.realpathSync(base), 'ES-ARNES'));
  fs.rmSync(path.join(clon, '.tycon'), { recursive: true });
  const hecho = path.join(clon, 'src', 'hecho.js');
  fs.writeFileSync(hecho, 'x\n');
  const v = enHijo(tcg, `const fs=require('fs'),path=require('path');const io=require(${JSON.stringify(IO)});const [f,hecho,st]=process.argv.slice(1);
    const ahora=new Date().toISOString();const p=io.adhocPath(st,'s-h');fs.mkdirSync(path.dirname(p),{recursive:true});
    fs.writeFileSync(p,JSON.stringify({reason:'arreglo en el arnés',maxFiles:1,files:[hecho],declaredAt:ahora,lastTouch:ahora,firmadaEn:ahora}));
    fs.appendFileSync(path.join(st,'gates.log'),JSON.stringify({name:'adhoc-lane-signed',status:'ok',destino:'s-h',ts:ahora})+'\\n');
    process.stdout.write(JSON.stringify(io.evaluate({filePath:f,sessionId:'s-h',via:'Edit',stateDir:st}).verdict))`, [path.join(clon, 'src', 'nuevo.js'), hecho]);
  assert.deepStrictEqual([v.action, v.kind], ['block', 'adhoc-cap'], JSON.stringify(v));
});

test('harness: con el criterio REAL del arnés — clon por su remoto, producto bajo carpeta con nombre del arnés', (t) => {
  const tcg = tcgDeVerdad();
  if (!tcg) return t.skip('NO MEDIDO: no encontré scripts/lib/harness-repo.js (TYCON_GUIDES_DIR · TCG · cwd · ~/.tycon/harness)');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'porton-'));
  const clon = repoGit(path.join(base, 'scratchpad', 'as'), 'https://otro@org-del-equipo.visualstudio.com/AgentSkills/_git/AgentSkills');
  const producto = repoGit(path.join(base, 'tycon-claude-guides', 'MiProducto'), 'https://org-del-equipo@dev.azure.com/org-del-equipo/UnProducto/_git/Backend');
  assert.equal(porton(tcg, path.join(clon, 'skills', 'x', 'a.js'), IDENTIDADES_ARNES).action, 'pass');
  assert.equal(porton(tcg, path.join(producto, 'src', 'a.js'), IDENTIDADES_ARNES).kind, 'no-lane');
  // gemelo con el nombre público
  twin(() => {
    const producto2 = repoGit(path.join(base, PUBLIC_NAME, 'MiProducto'), 'https://org-del-equipo@dev.azure.com/org-del-equipo/UnProducto/_git/Backend');
    assert.equal(porton(tcg, path.join(producto2, 'src', 'a.js'), IDENTIDADES_ARNES).kind, 'no-lane');
  });
});

// ── La maqueta de la pantalla en «Aprobar el plan», approve-mockup, set y el paso 8 ─────────────────────
// La story va en <repo>/specs/stories/ (la carpeta qa queda en <repo>/specs/qa, propia de cada prueba). Ejemplos inventados.
const MOCKUP_JS = path.join(SCRIPTS, 'mockup.js');
const MODELO_730 = (boton = 'Pagar seleccionadas') => JSON.stringify({ title: 'La lista de facturas', screens: [{ name: 'Lista de facturas',
  state: 'con facturas', elements: [{ kind: 'heading', text: 'Facturas pendientes' }, { kind: 'button', text: boton }] }] });
// Un repo git en su carpeta padre propia: la matriz de la story mira los repos vecinos, y suelto en la carpeta temporal
// del sistema recorre todo lo que hay ahí (cada `render` tardaba minutos).
function mundo730() {
  const repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mundo730-')), 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  return repo;
}
function story730(repo, archivos, { extra = [], title = 'La lista de facturas' } = {}) {
  const p = path.join(repo, 'specs', 'stories', 'story-1.1-x.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, ['---', 'story: "1.1"', `title: "${title}"`, 'status: in-progress', ...extra, 'files_to_modify:',
    ...archivos.map((a) => `  - ${a}`), '---', '# S', '', '## Acceptance Criteria', '',
    '1. **Given** un cliente con facturas **When** abre la lista **Then** ve cuántas le faltan pagar.', '',
    '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
    '| T1 | `ListaDeFacturas_MuestraPendientes` | 1 | e2e | x | y |', ''].join('\n'));
  return p;
}
const PANTALLA_NORMAL = (repo) => story730(repo, ['src/components/Facturas.tsx'], { extra: ['signed_for_sprint: 3'] });
function maqueta730(storyPath, boton) {
  const r = spawnSync('node', [MOCKUP_JS, 'render', '--data', '-', '--story', storyPath], { encoding: 'utf8', input: MODELO_730(boton) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
function marker730(home, sid, storyPath, repo, { done = [0, 1, 2], pending } = {}) {
  const all = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const r = markerCli(home, sid, ['set', JSON.stringify({ storyId: '1.1', storyPath, repoPath: repo, stepsCompleted: done,
    stepsPending: pending || all.filter((n) => !done.includes(n)) })]);
  assert.equal(r.status, 0, r.stderr);
}
const markerFile730 = (home, sid) => path.join(home, '.claude', '.tycon-pipeline', 'active', `${sid}.json`);
// las banderas de las partes del Arranque las pone el arnés (no set-flag): la prueba las escribe en el marcador
const partesHechas730 = (home, sid) => fs.writeFileSync(markerFile730(home, sid),
  JSON.stringify({ ...JSON.parse(fs.readFileSync(markerFile730(home, sid), 'utf8')), workSignalStarted: true, adoMarkedActive: true }));
const leerMarker730 = (home, sid) => JSON.parse(fs.readFileSync(markerFile730(home, sid), 'utf8'));
const gates730 = (home) => { try { return fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
const aprobacion730 = (repo) => path.join(repo, 'specs', 'qa', '1.1-mockup-approval.json');

test('7.30-T11 CompleteStep3_ConPantalla_SinMaqueta_Bloquea @story-7.30 @ac-9', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = mundo730();
  const s = PANTALLA_NORMAL(repo);
  marker730(home, 's11', s, repo);
  let r = markerCli(home, 's11', ['complete-step', '3', '--approved', 'dale']);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(path.join('specs', 'qa', '1.1-mockup.html')), r.stderr);
  assert.match(r.stderr, /mockup\.js render/);
  const m = leerMarker730(home, 's11');
  assert.equal(m.planApproval, undefined);
  assert.ok(m.stepsPending.includes(3));
  // la story borrada del disco: no pude saber si tiene pantalla (nunca «sin pantalla»)
  fs.unlinkSync(s);
  r = markerCli(home, 's11', ['complete-step', '3', '--approved', 'dale']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /no pude saber si tiene pantalla/);
  // el marcador sin storyPath
  markerCli(home, 's11b', ['set', JSON.stringify({ storyId: '1.1', repoPath: repo, stepsCompleted: [0, 1, 2], stepsPending: [3, 4, 5, 6, 7, 8] })]);
  r = markerCli(home, 's11b', ['complete-step', '3', '--approved', 'dale']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /el marcador no tiene la ruta de la story: `marker\.js set` con `storyPath`/);
});

test('7.30-T12 CompleteStep3_ConPantalla_PideAprobarLaMaqueta @story-7.30 @ac-10', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = mundo730();
  const s = PANTALLA_NORMAL(repo);
  const mq = maqueta730(s);
  marker730(home, 's12', s, repo);
  let r = markerCli(home, 's12', ['complete-step', '3', '--approved', 'dale']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /story con pantalla: mostrale la maqueta \(.*1\.1-mockup\.html\) y pasá su aprobación con --mockup-approved/);
  const cita = 'la maqueta va, aprobada por el dueño en el chat';
  r = markerCli(home, 's12', ['complete-step', '3', '--approved', 'dale', '--mockup-approved', cita]);
  assert.equal(r.status, 0, r.stderr);
  const m = leerMarker730(home, 's12');
  assert.equal(m.planApproval.mode, 'user');
  assert.equal(m.mockupApproval.sha256, mq.sha256);
  assert.equal(m.mockupApproval.mode, 'user');
  assert.equal(m.mockupApproval.text, cita);
  assert.equal(m.mockupApproval.file, mq.out);
  assert.equal(m.mockupDecision.screen, true);
  const ap = JSON.parse(fs.readFileSync(aprobacion730(repo), 'utf8'));
  assert.deepEqual(Object.keys(ap).sort(), ['approvedAt', 'file', 'schema', 'sha256', 'story']);
  assert.equal(ap.file, '1.1-mockup.html'); assert.equal(ap.sha256, mq.sha256); assert.equal(ap.story, '1.1');
  assert.ok(!fs.readFileSync(aprobacion730(repo), 'utf8').includes(cita));
  const linea = gates730(home).find((l) => l.name === 'mockup-approval' && l.status === 'ok');
  assert.ok(linea);
  assert.equal(linea.sha256, mq.sha256.slice(0, 12));
  assert.ok(!JSON.stringify(linea).includes(cita));
});

test('7.30-T13 CompleteStep3_RiesgoBajoConPantalla_IgualPideLaMaqueta @story-7.30 @ac-11', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = mundo730();
  const s = story730(repo, ['src/components/Facturas.tsx', 'src/components/Detalle.tsx']);
  maqueta730(s);
  marker730(home, 's13', s, repo);
  // con riesgo bajo el plan ya no se aprueba solo; con su aprobación, la maqueta se pide igual
  let r = markerCli(home, 's13', ['complete-step', '3', '--auto-approved', 'LOW: 2 archivos']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /el plan no se aprueba solo/);
  const runDir = require(path.join(__dirname, '..', 'pipeline.js')).resolveRunDir(repo, '1.1', true, s);
  const planAuto = '1. La pantalla de facturas con su detalle.\n';
  fs.writeFileSync(path.join(runDir, 'step-02-bmad-plan.md'), planAuto);
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-repo'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', '-repo', 's13.jsonl'),
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `El plan:\n${planAuto}` }] } })}\n`);
  r = markerCli(home, 's13', ['complete-step', '3', '--approved', 'dale']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /mostrale la maqueta/);
  r = markerCli(home, 's13', ['complete-step', '3', '--approved', 'dale', '--mockup-approved', 'la vio el dueño']);
  assert.equal(r.status, 0, r.stderr);
  const m = leerMarker730(home, 's13');
  assert.equal(m.planApproval.mode, 'user');
  assert.equal(m.mockupApproval.mode, 'user');
});

test('7.30-T14 CompleteStep3_MaquetaConRed_Bloquea @story-7.30 @ac-12', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = mundo730();
  const s = PANTALLA_NORMAL(repo);
  const mq = maqueta730(s);
  fs.writeFileSync(mq.out, fs.readFileSync(mq.out, 'utf8').replace('</head>', '<link href="https://x/y.css"></head>'));
  marker730(home, 's14', s, repo);
  let r = markerCli(home, 's14', ['complete-step', '3', '--approved', 'dale', '--mockup-approved', 'va']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /<link/);
  fs.writeFileSync(mq.out, '<html><body><p>Facturas pendientes</p></body></html>');
  r = markerCli(home, 's14', ['complete-step', '3', '--approved', 'dale', '--mockup-approved', 'va']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /generator/);
  const m = leerMarker730(home, 's14');
  assert.equal(m.mockupApproval, undefined);
  assert.equal(m.planApproval, undefined);
  assert.ok(!fs.existsSync(aprobacion730(repo)));
});

test('7.30-T15 CompleteStep3_SinPantalla_ComoHoy @story-7.30 @ac-13', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = mundo730();
  const s = story730(repo, ['src/Servicio.cs'], { extra: ['signed_for_sprint: 3'] });
  marker730(home, 's15', s, repo);
  let r = markerCli(home, 's15', ['complete-step', '3', '--approved', 'dale']);
  assert.equal(r.status, 0, r.stderr);
  let m = leerMarker730(home, 's15');
  assert.equal(m.mockupApproval, undefined);
  assert.equal(m.mockupDecision.screen, false);
  assert.ok(!fs.existsSync(path.join(repo, 'specs', 'qa')));
  marker730(home, 's15b', s, repo);
  r = markerCli(home, 's15b', ['complete-step', '3', '--approved', 'dale', '--mockup-approved', 'va']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /la story no tiene pantalla: no hay maqueta que aprobar/);
  m = leerMarker730(home, 's15b');
  assert.equal(m.mockupApproval, undefined);
  assert.equal(m.mockupDecision.screen, false);
  // la palabra del frente sólo en la prosa: la línea sale una vez
  const repo2 = mundo730();
  const s2 = story730(repo2, ['src/Servicio.cs'], { extra: ['signed_for_sprint: 3'], title: 'El servicio que usa el frontend' });
  marker730(home, 's15c', s2, repo2);
  r = markerCli(home, 's15c', ['complete-step', '3', '--approved', 'dale']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stderr.match(/se trata como SIN pantalla/g) || []).length, 1, r.stderr);
  assert.equal(leerMarker730(home, 's15c').mockupDecision.screen, false);
});

test('7.30-T16 ApproveMockup_ReapruebaConOtraHuella @story-7.30 @ac-14', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = mundo730();
  const s = PANTALLA_NORMAL(repo);
  const mq = maqueta730(s);
  marker730(home, 's16', s, repo);
  let r = markerCli(home, 's16', ['approve-mockup', '--approved', 'va']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /la maqueta se aprueba con el plan: complete-step 3/);
  r = markerCli(home, 's16', ['complete-step', '3', '--approved', 'dale', '--mockup-approved', 'va']);
  assert.equal(r.status, 0, r.stderr);
  const mq2 = maqueta730(s, 'Pagar las seleccionadas');
  assert.notEqual(mq2.sha256, mq.sha256);
  r = markerCli(home, 's16', ['approve-mockup']);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(leerMarker730(home, 's16').mockupApproval.sha256, mq.sha256);
  r = markerCli(home, 's16', ['approve-mockup', '--approved', 'la nueva va, aprobada por el dueño']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(leerMarker730(home, 's16').mockupApproval.sha256, mq2.sha256);
  assert.equal(JSON.parse(fs.readFileSync(aprobacion730(repo), 'utf8')).sha256, mq2.sha256);
  const re = gates730(home).filter((l) => l.name === 'mockup-approval' && l.reapproval === true);
  assert.equal(re.length, 1);
  assert.equal(re[0].previous, mq.sha256.slice(0, 12));
  // la maqueta que no pasa check: no se escribe nada
  fs.writeFileSync(mq2.out, fs.readFileSync(mq2.out, 'utf8').replace('</head>', '<link href="https://x/y.css"></head>'));
  r = markerCli(home, 's16', ['approve-mockup', '--approved', 'va']);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(leerMarker730(home, 's16').mockupApproval.sha256, mq2.sha256);
  // una story sin pantalla
  const repo2 = mundo730();
  const s2 = story730(repo2, ['src/Servicio.cs'], { extra: ['signed_for_sprint: 3'] });
  marker730(home, 's16b', s2, repo2, { done: [0, 1, 2, 3] });
  r = markerCli(home, 's16b', ['approve-mockup', '--approved', 'va']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /la story no tiene pantalla/);
  assert.equal(leerMarker730(home, 's16b').mockupApproval, undefined);
});

test('7.30-T17 MarkerSet_NoHeredaNiAceptaLaMaqueta @story-7.30 @ac-15', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = mundo730();
  const s = PANTALLA_NORMAL(repo);
  const mq = maqueta730(s);
  marker730(home, 's17', s, repo);
  assert.equal(markerCli(home, 's17', ['complete-step', '3', '--approved', 'dale', '--mockup-approved', 'va']).status, 0);
  // la misma story con una aprobación falsa en el payload: se descarta y lo dice
  let r = markerCli(home, 's17', ['set', JSON.stringify({ storyId: '1.1', mockupApproval: { sha256: 'f'.repeat(64) }, mockupDecision: { screen: false } })]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /mockupApproval/);
  assert.match(r.stderr, /mockupDecision/);
  let m = leerMarker730(home, 's17');
  assert.equal(m.mockupApproval.sha256, mq.sha256);
  assert.equal(m.mockupDecision.screen, true);
  // otra story: no se heredan
  r = markerCli(home, 's17', ['set', JSON.stringify({ storyId: '2.2', storyPath: s, repoPath: repo, stepsPending: [0, 1, 2, 3, 4, 5, 6, 7, 8] }), '--replace']);
  assert.equal(r.status, 0, r.stderr);
  m = leerMarker730(home, 's17');
  assert.equal(m.mockupApproval, undefined);
  assert.equal(m.mockupDecision, undefined);
});

test('7.30-T27 CompleteStep8_PantallaNuevaDespuesDelPlan_PideLaMaqueta @story-7.30 @ac-30', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = mundo730();
  const s = story730(repo, ['src/Servicio.cs'], { extra: ['signed_for_sprint: 3'] });
  marker730(home, 's27', s, repo);
  assert.equal(markerCli(home, 's27', ['complete-step', '3', '--approved', 'dale']).status, 0);
  // la story gana una pantalla después de aprobar el plan
  story730(repo, ['src/Servicio.cs', 'src/components/Facturas.tsx'], { extra: ['signed_for_sprint: 3'] });
  const m0 = leerMarker730(home, 's27');
  m0.stepsCompleted = [0, 1, 2, 3, 4, 5, 6, 7]; m0.stepsPending = [8];
  fs.writeFileSync(markerFile730(home, 's27'), JSON.stringify(m0));
  for (const extra of [{}, { DOD_BYPASS: '1' }]) {
    const r = markerCli(home, 's27', ['complete-step', '8'], extra);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /la story ganó una pantalla después de aprobar el plan/);
    assert.match(r.stderr, /approve-mockup --approved/);
  }
  maqueta730(s);
  let r = markerCli(home, 's27', ['approve-mockup', '--approved', 'va, aprobada por el dueño']);
  assert.equal(r.status, 0, r.stderr);
  const m = leerMarker730(home, 's27');
  assert.equal(m.mockupDecision.screen, true);
  assert.ok(m.mockupApproval);
  assert.ok(gates730(home).some((l) => l.name === 'mockup-approval' && l.reapproval === false));
  r = markerCli(home, 's27', ['complete-step', '8']);
  assert.doesNotMatch(r.stderr, /ganó una pantalla/);
  const { mockupStep8 } = require(MOCKUP_JS);
  assert.equal(mockupStep8(m, s).compare, true);
  // un marcador sin la decisión del paso 3 (anterior a la maqueta): no frena por la maqueta
  marker730(home, 's27b', s, repo, { done: [0, 1, 2, 3, 4, 5, 6, 7] });
  r = markerCli(home, 's27b', ['complete-step', '8']);
  assert.doesNotMatch(r.stderr, /ganó una pantalla/);
  // con la maqueta aprobada y la story que ya no está, frena y lo dice (también con DOD_BYPASS)
  const m2 = leerMarker730(home, 's27');
  m2.storyPath = path.join(repo, 'specs', 'stories', 'no-esta.md');
  fs.writeFileSync(markerFile730(home, 's27'), JSON.stringify(m2));
  r = markerCli(home, 's27', ['complete-step', '8'], { DOD_BYPASS: '1' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /la story tenía maqueta aprobada y no la encuentro/);
});

test('7.30-T28 PipelineNextRiskClassYPortonDePlan_NombranLaMaqueta @story-7.30 @ac-29', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = mundo730();
  const conPantalla = story730(repo, ['src/components/Facturas.tsx', 'src/components/Detalle.tsx']);
  const repo2 = mundo730();
  const sinPantalla = story730(repo2, ['src/Servicio.cs', 'src/Otro.cs']);
  const pipe = (sid, args) => spawnSync('node', [path.join(SCRIPTS, 'pipeline.js'), ...args], { encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0' } });
  for (const [sid, s, r0, conMaqueta] of [['s28a', conPantalla, repo, true], ['s28b', sinPantalla, repo2, false]]) {
    marker730(home, sid, s, r0);
    // los sub-pasos del arranque (reloj, pedido en ADO) no son lo que se prueba: sus banderas, escritas en el marcador
    partesHechas730(home, sid);
    const n = pipe(sid, ['next']);
    assert.equal(n.status, 0, n.stderr);
    assert.match(n.stdout, /complete-step approve-plan/);
    if (conMaqueta) assert.match(n.stdout, /--mockup-approved/); else assert.doesNotMatch(n.stdout, /--mockup-approved/);
    const rc = JSON.parse(pipe(sid, ['risk-class', '--story', s]).stdout);
    assert.equal(rc.risk, 'LOW');
    assert.ok(!('auto_approve_plan' in rc), 'ningún plan se aprueba solo (story 1.29)');
    if (conMaqueta) {
      assert.equal(rc.mockup_required, true);
      assert.match(rc.note, /la maqueta la aprueba quien aprueba el plan/);
    } else {
      assert.equal(rc.mockup_required, undefined);
      assert.doesNotMatch(rc.note, /maqueta/);
    }
    const msg = gate.blockMessage({ kind: 'plan' }, { filePath: path.join(r0, 'src', 'a.ts'), marker: { storyId: '1.1', storyPath: s } });
    if (conMaqueta) assert.match(msg, /--mockup-approved/); else assert.doesNotMatch(msg, /--mockup-approved/);
  }
  // la ruta relativa se resuelve contra repoPath (como marker.js); una story que no está da el mensaje sin maqueta
  const rel = path.relative(repo, conPantalla);
  assert.match(gate.blockMessage({ kind: 'plan' }, { filePath: path.join(repo, 'src', 'a.ts'), marker: { storyId: '1.1', storyPath: rel, repoPath: repo } }), /--mockup-approved/);
  const roto = gate.blockMessage({ kind: 'plan' }, { filePath: path.join(repo, 'src', 'a.ts'), marker: { storyId: '1.1', storyPath: path.join(repo, 'no-existe.md') } });
  assert.doesNotMatch(roto, /--mockup-approved/);
  assert.match(roto, /complete-step 3 --approved/);
  markerCli(home, 's28c', ['set', JSON.stringify({ storyId: '1.1', storyPath: rel, repoPath: repo, stepsCompleted: [0, 1, 2], stepsPending: [3, 4, 5, 6, 7, 8] })]);
  partesHechas730(home, 's28c');
  const n = pipe('s28c', ['next']);
  assert.match(n.stdout, /--mockup-approved/);
});

// ── el freno de edición invisible con un repo de git de verdad (8.93 C) ─────────────────────────────────────────────
// Lanzan git: viven acá y no en story-gate.test.js, que corre en cada arranque y en máquinas sin git.
function tmpStateGit() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
  fs.mkdirSync(path.join(d, 'active'), { recursive: true });
  return d;
}
function corridaAbierta({ pendiente = [4, 5, 6, 7, 8] } = {}) {
  const stateDir = tmpStateGit();
  const repo = fs.realpathSync(mkRepo(false));
  fs.writeFileSync(path.join(stateDir, 'active', 's1.json'), JSON.stringify({
    storyId: '9.9', repoPath: repo, sessionId: 's1', stepsCompleted: [0, 1, 2, 3], stepsPending: pendiente,
  }));
  return { stateDir, repo };
}
function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}
const SIN_REGISTRO = { TYCON_LEDGER_VISIBLE: undefined, TYCON_STORY_GATE: undefined, TYCON_NO_RUN_CHANGE: '1' };
const INVISIBLE = /EDICIÓN INVISIBLE/;

test('T32 Freno_BorrarYDeshacer_ArchivoQueGitNoSigue', () => {
  // borrar un archivo que git no sigue (uno de prueba que la sesión creó) pasa y queda anotado
  const conGit = corridaAbierta();
  execFileSync('git', ['-C', conGit.repo, 'init', '-q']);
  fs.writeFileSync(path.join(conGit.repo, 'src', 'probe.js'), 'x\n');
  conEnv({ ...SIN_REGISTRO, TYCON_NO_RUN_CHANGE: undefined }, () => {
    assert.equal(bash.handle({ tool_name: 'Bash', session_id: 's1', cwd: conGit.repo, tool_input: { command: 'rm src/probe.js' } }, { stateDir: conGit.stateDir, installedRoots: [] }), null);
  });
  const anotadas = fs.readFileSync(path.join(conGit.stateDir, 'console-writes', 's1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(anotadas.some((l) => l.path === path.join(conGit.repo, 'src', 'probe.js') && l.kind === 'delete'), 'queda anotado');
});

// las formas que el pase adversarial encontró escapándose (o frenando de más), con un repo de git de verdad
function corridaConGit() {
  const c = corridaAbierta();
  const g = (...a) => execFileSync('git', ['-C', c.repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@noreply', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@noreply', GIT_AUTHOR_DATE: '2026-10-22T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-22T10:00:00Z' } });
  fs.rmSync(path.join(c.repo, '.git'), { recursive: true, force: true });
  g('init', '-q');
  fs.mkdirSync(path.join(c.repo, 'src', 'b'), { recursive: true });
  fs.mkdirSync(path.join(c.repo, 'node_modules', 'x'), { recursive: true });
  for (const f of ['src/a.ts', 'src/b/c.ts', 'src/a b.ts', 'package.json']) fs.writeFileSync(path.join(c.repo, f), 'x\n');
  g('add', 'src', 'package.json');
  g('commit', '-q', '-m', 'base');
  return c;
}

test('T32 Freno_BorrarYDeshacer_FormasQueSeEscapaban', () => {
  const { stateDir, repo } = corridaConGit();
  const ev = (command, cwd = repo) => ({ tool_name: 'Bash', session_id: 's1', cwd, tool_input: { command } });
  conEnv({ ...SIN_REGISTRO, TYCON_NO_RUN_CHANGE: undefined }, () => {
    for (const [cmd, cwd] of [
      [`git -C ${repo} rm src/a.ts`, os.tmpdir()],
      [`git -C ${repo} checkout -- src/a.ts`, os.tmpdir()],
      [`git -C ${repo} restore src/a.ts`, repo],
      ['/bin/rm src/a.ts'], ['\\rm src/a.ts'], ['command rm src/a.ts'], ['env X=1 rm src/a.ts'], ['timeout 5 rm src/a.ts'],
      ['(rm src/a.ts)'], ['sudo -n rm src/a.ts'],
      ['git checkout HEAD src/a.ts'], ['git checkout src/a.ts'],
      ['rm -r src/b'], ['git rm -r src'], ['git restore .'], ['git checkout -- .'],
      ['rm "src/a b.ts"'],
    ]) {
      const b = bash.handle(ev(cmd, cwd), { stateDir, installedRoots: [] });
      assert.ok(b && INVISIBLE.test(b.block), cmd);
    }
    // borrar código y node_modules juntos frena, y como el comando no corre, no anota nada
    const antes = fs.existsSync(path.join(stateDir, 'console-writes', 's1.jsonl'));
    assert.ok(bash.handle(ev('rm -rf node_modules src/a.ts'), { stateDir, installedRoots: [] }));
    assert.equal(fs.existsSync(path.join(stateDir, 'console-writes', 's1.jsonl')), antes, 'un comando frenado no anota borrados');
    // node_modules (git no sigue nada adentro) y cambiar de rama pasan
    assert.equal(bash.handle(ev('rm -rf node_modules'), { stateDir, installedRoots: [] }), null);
    assert.equal(bash.handle(ev('git checkout -b feat/x'), { stateDir, installedRoots: [] }), null);
    assert.equal(bash.handle(ev('git checkout main'), { stateDir, installedRoots: [] }), null);
    assert.equal(bash.handle(ev('git commit -m "rm src/a.ts; git restore ."'), { stateDir, installedRoots: [] }), null, 'texto entre comillas no es un comando');
    assert.ok(bash.handle(ev('git restore --staged --worktree src/a.ts'), { stateDir, installedRoots: [] }), 'con --worktree el archivo cambia');
    assert.equal(bash.handle(ev('git checkout --orphan nueva'), { stateDir, installedRoots: [] }), null);
  });
  // sin poder preguntarle a git, una carpeta frena del lado seguro; node_modules igual pasa
  const sinGit = corridaAbierta();
  fs.mkdirSync(path.join(sinGit.repo, 'src', 'b'), { recursive: true });
  conEnv(SIN_REGISTRO, () => {
    const e = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: sinGit.repo, tool_input: { command } });
    assert.match((bash.handle(e('rm -r src/b'), { stateDir: sinGit.stateDir, installedRoots: [] }) || {}).block || '', /no pude preguntarle a git/);
    assert.equal(bash.handle(e('rm -rf node_modules dist'), { stateDir: sinGit.stateDir, installedRoots: [] }), null);
  });
  // ninguna forma del comando traba el freno (cada parte del lector tiene una sola lectura posible)
  for (const cmd of [`node ${'--a '.repeat(40)}x`, `node -e "${'\\'.repeat(20000)}`, `python3 -c '${"'".repeat(5000)}`]) {
    const t0 = Date.now();
    bash.destinosArmados(cmd);
    assert.ok(Date.now() - t0 < 500, `tardó de más: ${cmd.slice(0, 30)}`);
  }
});

test('T32b Freno_GitRm_LoQueLaStoryNombra_PasaYQuedaAnotado', () => {
  // la story declara sus archivos con la ruta desde otra raíz (`app/src/a.ts`), como una story de un repo de specs
  const { stateDir, repo } = corridaConGit();
  const story = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'specs-')), 'story-9.9.md');
  fs.writeFileSync(story, '---\nstory: "9.9"\nfiles_to_modify:\n  - "app/src/x.ts"\n  # se borran\n  - "app/src/a.ts"  # sin uso\n---\n# 9.9\n');
  const mPath = path.join(stateDir, 'active', 's1.json');
  fs.writeFileSync(mPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(mPath, 'utf8')), storyPath: story, filesTouched: [] }));
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  const anotadas = () => {
    const f = path.join(stateDir, 'console-writes', 's1.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  conEnv({ ...SIN_REGISTRO, TYCON_NO_RUN_CHANGE: undefined }, () => {
    // lo que la story no nombra, una carpeta, un `rm` a secas o una mezcla siguen frenando, sin anotar nada
    for (const cmd of ['git rm src/b/c.ts', 'git rm -r src', 'rm src/a.ts', 'git rm src/a.ts src/b/c.ts', 'git rm src/*.ts']) {
      const b = bash.handle(ev(cmd), { stateDir, installedRoots: [] });
      assert.ok(b && INVISIBLE.test(b.block), cmd);
    }
    assert.equal(anotadas().length, 0, 'un comando frenado no anota');
    assert.equal(bash.handle(ev('git rm -q src/a.ts'), { stateDir, installedRoots: [] }), null, 'la story lo nombra');
  });
  const abs = path.join(repo, 'src', 'a.ts');
  assert.ok(anotadas().some((l) => l.path === abs && l.kind === 'delete'), 'queda en el registro de la terminal');
  const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  assert.deepEqual(m.filesTouched, [abs], 'queda en los archivos tocados de la corrida');
  assert.ok((m.fileEvents || []).some((e) => e.path === abs), 'con su evento, para la vuelta siguiente de revisores');
  const log = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((l) => l.name === 'ledger-visible' && l.status === 'story-delete' && l.paths.includes(abs)), 'y la constancia en gates.log');
});

test('T31 Freno_InterpreteConDestinoArmado_FormasQueSeEscapaban', () => {
  const { stateDir, repo } = corridaAbierta();
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: repo, tool_input: { command } });
  conEnv(SIN_REGISTRO, () => {
    for (const cmd of [
      // el script por la entrada estándar, o con opciones antes de -e
      `python3 - <<'PY'\nimport sys\nd = sys.argv[0]\nopen(d + '/a.py', 'w').write('x')\nPY`,
      `node <<'JS'\nconst fs = require('fs'); const p = process.cwd(); fs.writeFileSync(p, 'x')\nJS`,
      `node --no-warnings -e "const fs=require('fs'); fs.writeFileSync(p,'x')"`,
      // un destino armado por una llamada anidada
      `python3 -c "import os; open(os.path.join(d,'x.ts'),'w').write('x')"`,
      `python3 -c "from pathlib import Path; Path(d).write_text('x')"`,
      // un literal con algo concatenado después no es un literal
      `node -e "const n='a.ts'; const p='src/'+n; require('fs').writeFileSync(p,'x')"`,
      // con el -- de node, process.argv[1] es la palabra que sigue
      `node -e "require('fs').writeFileSync(process.argv[1],'x')" -- src/a.ts`,
    ]) {
      const b = bash.handle(ev(cmd), { stateDir, installedRoots: [] });
      assert.ok(b && INVISIBLE.test(b.block), cmd);
    }
    for (const cmd of [
      // lo que otro comando sólo menciona no es un script
      `git commit -m "node -e: writeFileSync(p) ahora frena"`,
      `cat > notas.md <<'EOF'\nnode -e "fs.writeFileSync(p, x)"\nEOF`,
      // python sin modo es lectura
      `python3 -c "import sys; print(open(sys.argv[1]).read())" src/a.ts`,
      // rutas que salen sólo de literales (medido: los más comunes de la segunda medición)
      `python3 - <<'E'\nfor p in ['specs/a.yaml', 'specs/b.md']:\n    s = open(p).read()\n    open(p, 'w').write(s)\nE`,
      `python3 - <<'E'\nimport os\np = os.path.expanduser('~/.tycon/x.json')\nopen(p, 'w').write('{}')\nE`,
      `node -e "const path=require('path'); const p = path.join('specs', 'a.md'); require('fs').writeFileSync(p, 'x')"`,
      `node - <<'E'\nconst fs = require('fs');\nfunction edit(p, pares) { let t = fs.readFileSync(p, 'utf8'); fs.writeFileSync(p, t); }\nedit('specs/a.md', []);\nedit("guides/b.md", []);\nE`,
    ]) assert.equal(bash.handle(ev(cmd), { stateDir, installedRoots: [] }), null, cmd);
    for (const cmd of [
      `python3 - <<'E'\nfor p in ['notas.md', 'src/a.ts']:\n    open(p, 'w').write('x')\nE`,
      `python3 - <<'E'\ndef rep(p, pares):\n    open(p, 'w').write('x')\nrep('notas.md', [])\nrep(otro, [])\nE`,
    ]) assert.ok(INVISIBLE.test((bash.handle(ev(cmd), { stateDir, installedRoots: [] }) || {}).block || ''), `una lista con código frena: ${cmd}`);
  });
});

// ── la pregunta al abrir: ¿cambia de dónde salen los datos o quién los ve? ──────────────────────────────────────────
const SIN_CAMBIO = 'no cambia de dónde salen los datos ni quién los ve';
const pedidoConDatos = (datos, extra = {}) => JSON.stringify({ reason: 'el botón del comprobante', ...(datos === undefined ? {} : { datos }), ...extra });

// 🔴 Falla con: la respuesta que no llega al resumen que firma la persona, o que no queda anotada.
test('T1 AdhocSet_DatosSinCambio_EnElCuadroYAnotado @story-8.196 @ac-1 @ac-5', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const r = markerCli(home, 'ses-d1', ['adhoc', 'set', pedidoConDatos('sin-cambio')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(declaracion(home, 'ses-d1').datos, 'sin-cambio');
  const set = adhocLog(home).filter((e) => e.kind === 'ADHOC_SET');
  assert.equal(set.length, 1);
  assert.equal(set[0].datos, 'sin-cambio', 'el campo va dentro del evento ADHOC_SET');
  const firmado = fs.readFileSync(path.join(estadoDe(home), 'gates.log'), 'utf8');
  assert.ok(firmado.includes(SIN_CAMBIO), 'el resumen que firma la persona lo dice');
  // el cuadro de la firma (el que muestra la persona) también, y otro `datos` da otro cuadro
  const fuentes = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'signature-sources.js'));
  const partes = (p) => fuentes.partesDe({ firma: 'adhoc-lane', palabras: ['marker.js', 'adhoc', 'set', p] });
  assert.ok(partes(pedidoConDatos('sin-cambio')).queHace.join(' ').includes(SIN_CAMBIO));
  assert.notStrictEqual(partes(pedidoConDatos('sin-cambio')).fuente, partes(pedidoConDatos('cambian')).fuente);
});

test('T2 AdhocSet_DatosCambian_NoAbreYMandaAHistoria @story-8.196 @ac-2', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const r = markerCli(home, 'ses-d2', ['adhoc', 'set', pedidoConDatos('cambian')]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /esto va por historia, aunque sea corta/);
  assert.match(r.stderr, /tycon-create-story/);
  assert.equal(declaracion(home, 'ses-d2'), null);
});

test('T3 AdhocSet_SinDatosOValorRaro_NoAbreYDiceLosValores @story-8.196 @ac-3', () => {
  for (const p of [pedidoConDatos(undefined), pedidoConDatos('quizas')]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    const r = markerCli(home, 'ses-d3', ['adhoc', 'set', p]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /"datos"/);
    assert.match(r.stderr, /sin-cambio/);
    assert.match(r.stderr, /cambian/);
    assert.equal(declaracion(home, 'ses-d3'), null);
  }
});

test('T4 AdhocSet_FormaSinJson_AceptaDatos @story-8.196 @ac-3', () => {
  const screen = require(path.join(SCRIPTS, 'lib', 'adhoc-screen.js'));
  assert.deepStrictEqual(screen.pedidoPorBanderas(['--reason', 'el botón del comprobante', '--data', 'sin-cambio', '--terminal']).payload,
    { reason: 'el botón del comprobante', datos: 'sin-cambio' });
  assert.match(screen.pedidoPorBanderas(['--reason', 'x', '--data', '--terminal']).problema, /--data necesita un valor/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const r = markerEnTerminal(home, ['adhoc', 'set', '--reason', 'el botón del comprobante', '--data', 'sin-cambio', '--terminal', '--for-session', 'ses-d4'], 'firmo');
  if (!r) return console.log('⏭ la forma de la terminal: NO MEDIDA — sin Python o en Windows');
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(declaracion(home, 'ses-d4').datos, 'sin-cambio');
});

test('T5 CarrilViejoSinDatos_SigueAndando @story-8.196 @ac-4', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  // un carril de antes, sin `datos`: un `set` que sólo sube el cupo no lo pide
  fs.mkdirSync(path.join(estadoDe(home), 'adhoc'), { recursive: true });
  fs.writeFileSync(io.adhocPath(estadoDe(home), 'ses-d5'), JSON.stringify({ reason: 'un arreglo de antes', maxFiles: 3, files: [] }));
  let r = markerCli(home, 'ses-d5', ['adhoc', 'set', JSON.stringify({ reason: 'un arreglo de antes', maxFiles: 5 })]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(declaracion(home, 'ses-d5').datos, undefined);
  // uno con `sin-cambio`, al que se le cambia el motivo: lo conserva
  r = markerCli(home, 'ses-d6', ['adhoc', 'set', pedidoConDatos('sin-cambio')]);
  assert.equal(r.status, 0, r.stderr);
  r = markerCli(home, 'ses-d6', ['adhoc', 'set', JSON.stringify({ reason: 'el botón del comprobante, y su texto' })]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(declaracion(home, 'ses-d6').datos, 'sin-cambio');
  assert.ok(fs.readFileSync(path.join(estadoDe(home), 'gates.log'), 'utf8').split('\n').filter((l) => l.includes('el botón del comprobante, y su texto')).some((l) => l.includes(SIN_CAMBIO)), 'el cuadro lo sigue diciendo');
});

test('T22 AdhocSet_CambianSobreCarrilAbierto_NoCambiaYMandaACerrar @story-8.196 @ac-4', () => {
  for (const files of [['/r/src/a.ts', '/r/src/b.ts'], []]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    fs.mkdirSync(path.join(estadoDe(home), 'adhoc'), { recursive: true });
    const antes = { reason: 'el botón del comprobante', maxFiles: 8, files, datos: 'sin-cambio' };
    fs.writeFileSync(io.adhocPath(estadoDe(home), 'ses-d7'), JSON.stringify(antes));
    const r = markerCli(home, 'ses-d7', ['adhoc', 'set', pedidoConDatos('cambian')]);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /adhoc clear/);
    assert.match(r.stderr, /historia/);
    assert.deepStrictEqual(declaracion(home, 'ses-d7'), antes, 'el carril sigue igual');
  }
});

// ── el click del dueño sobre el freno de los datos ─────────────────────────────────────────────────────────────────
const FRENO_DATOS = { huella: 'abc123', at: '2026-11-05T10:00:00.000Z', hallazgos: [{ id: 'proceso', strength: 'strong', says: 'una llamada a un proceso',
  repo: '/r', file: 'src/pantallas/Detalle.tsx', line: 42, borrada: false, texto: 'sdk.process.start({ processName: "Comprobante" })' }] };
function carrilFrenado(home, sid, extra = {}) {
  fs.mkdirSync(path.join(estadoDe(home), 'adhoc'), { recursive: true });
  fs.writeFileSync(io.adhocPath(estadoDe(home), sid), JSON.stringify({ reason: 'el botón del comprobante', maxFiles: 8, files: [], datos: 'sin-cambio', frenoDatos: FRENO_DATOS, ...extra }));
}
const ALLOW = (rec, extra = []) => ['adhoc', 'allow-data-change', '--changed', 'el botón deja de pedirlo al servicio propio', '--recommends', rec, '--why', 'el proceso tiene su propia seguridad', ...extra];

test('T15 Cuadro_ArmaLaPreguntaConLasDosOpciones @story-8.196 @ac-13', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  carrilFrenado(home, 'ses-c1');
  const fuentes = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'signature-sources.js'));
  const firmas = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'signatures.js'));
  const p = fuentes.partesDe({ firma: 'adhoc-lane:datos', palabras: ['marker.js', ...ALLOW('pasar')], estado: estadoDe(home), destino: 'ses-c1' });
  const que = p.queHace.join(' · ');
  assert.match(que, /una llamada a un proceso, src\/pantallas\/Detalle\.tsx:42/);
  assert.match(que, /processName: "Comprobante"/, 'el texto de la línea');
  assert.match(que, /deja de pedirlo al servicio propio/);
  assert.match(que, /dejar pasar, porque el proceso tiene su propia seguridad/);
  assert.match(que, /Ante la duda, historia/);
  assert.ok(p.fuente.includes(FRENO_DATOS.huella), 'el código del cuadro sale de las señales');
  const s = firmas.SIGNATURES.find((x) => x.id === 'adhoc-lane:datos');
  assert.strictEqual(s.level, 2);
  assert.strictEqual(s.clickDelDueno, true);
  assert.match(s.descripciones[0], /^Dejar pasar: sigue por camino corto/);
  assert.match(s.descripciones[1], /historia/);
  assert.match(s.descripciones[1], /descart/);
  // con otras señales, otro código
  carrilFrenado(home, 'ses-c1', { frenoDatos: { ...FRENO_DATOS, huella: 'otra' } });
  const q = fuentes.partesDe({ firma: 'adhoc-lane:datos', palabras: ['marker.js', ...ALLOW('pasar')], estado: estadoDe(home), destino: 'ses-c1' });
  assert.notStrictEqual(q.fuente, p.fuente);
});

test('T25 Cuadro_DejarPasar_ConClick_GuardaYAnota @story-8.196 @ac-13', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  carrilFrenado(home, 'ses-c2');
  const r = markerEnTerminal(home, [...ALLOW('pasar'), '--terminal', '--for-session', 'ses-c2'], 'firmo');
  if (!r) return console.log('⏭ la firma por la terminal: NO MEDIDA — sin Python o en Windows');
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const d = declaracion(home, 'ses-c2');
  assert.strictEqual(d.datosPermitido.huella, FRENO_DATOS.huella);
  assert.strictEqual(d.datosPermitido.recomienda, 'pasar');
  const e = adhocLog(home).find((x) => x.kind === 'ADHOC_DATA_ALLOWED');
  assert.ok(e, 'queda en adhoc.log');
  assert.deepStrictEqual([e.senal, e.archivo, e.recomienda, e.via], ['proceso', 'src/pantallas/Detalle.tsx:42', 'pasar', 'terminal']);
});

test('T27 Cuadro_NoSeDelegaNiVaPorVentanaDeFondo @story-8.196 @ac-13', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  carrilFrenado(home, 'ses-c3');
  // la ventana de la prueba (y la delegación) firman `via: ventana` / `delegacion`: el guion no lo acepta
  for (const o of [{}, { delegadaPor: 'ses-coord' }]) {
    const r = spawnSync('node', [path.join(SCRIPTS, 'marker.js'), ...ALLOW('pasar')], { encoding: 'utf8',
      env: conVentana({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'ses-c3' }, o) });
    assert.notEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /click de una persona/);
    assert.strictEqual(declaracion(home, 'ses-c3').datosPermitido, undefined);
  }
});

test('T28 Cuadro_EscribirHistoriaYDescartar_TextosSinFirma @story-8.196 @ac-13', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-')));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'a\n');
  git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'executeQuery("x");\n');
  fs.writeFileSync(path.join(repo, 'src', 'nuevo.ts'), 'n\n');
  carrilFrenado(home, 'ses-c4', { files: [path.join(repo, 'src', 'a.ts'), path.join(repo, 'src', 'nuevo.ts')] });
  let r = markerSinVentana(home, 'ses-c4', ALLOW('historia'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /adhoc clear/);
  assert.match(r.stdout, /historia/);
  r = markerSinVentana(home, 'ses-c4', ALLOW('descartar'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /checkout '[0-9a-f]{7,}' -- 'src\/a\.ts'/);
  assert.match(r.stdout, /src\/nuevo\.ts/);
  assert.match(r.stdout, /adhoc clear/);
  assert.strictEqual(declaracion(home, 'ses-c4').datosPermitido, undefined, 'sin firma');
});

// 🔴 Falla con: un archivo nuevo del carril ya guardado en la rama, mandado a «restaurar» contra una base donde no
// existe; o un git que no contesta, que manda a borrar un archivo que la base sí tiene.
test('T28 Cuadro_Descartar_ClasificaContraLaBase @story-8.196 @ac-13', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-')));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'a\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'executeQuery("x");\n');
  fs.writeFileSync(path.join(repo, 'src', 'hecho.ts'), 'h\n');
  git('add', '.'); git('commit', '-qm', 'el carril');
  const files = [path.join(repo, 'src', 'a.ts'), path.join(repo, 'src', 'hecho.ts')];
  carrilFrenado(home, 'ses-c8', { files, bases: { [repo]: { sha: base, traida: true } } });
  const r = markerSinVentana(home, 'ses-c8', ALLOW('descartar'));
  assert.equal(r.status, 0, r.stderr);
  const restaurar = r.stdout.split('\n').find((l) => / checkout /.test(l)) || '';
  assert.match(restaurar, /'src\/a\.ts'/);
  assert.doesNotMatch(restaurar, /hecho\.ts/, 'no está en la base: no se restaura');
  assert.match(r.stdout.split('\n').find((l) => /para borrar/.test(l)) || '', /hecho\.ts/);
  // la base no se puede leer: no clasifica, y no manda a borrar nada
  carrilFrenado(home, 'ses-c9', { files, bases: { [repo]: { sha: 'f'.repeat(40), traida: true } } });
  const sinBase = markerSinVentana(home, 'ses-c9', ALLOW('descartar'));
  assert.equal(sinBase.status, 0, sinBase.stderr);
  assert.doesNotMatch(sinBase.stdout, /para borrar/);
  assert.doesNotMatch(sinBase.stdout, / checkout /);
  assert.match(sinBase.stdout, /⚠ .*(no pude saber si .*a\.ts|git no contestó)/);
  assert.strictEqual(new Set(sinBase.stdout.split('\n')).size, sinBase.stdout.split('\n').length, 'cada aviso una vez');
});

// 🔴 Falla con: «descartar» leyendo otra medida que el resto del carril, o mandando a borrar lo sin seguir de otra sesión.
test('T52 Descartar_ListaLaDeHoy_SinLoAjeno @story-8.190 @ac-35', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-')));
  const origen = `${repo}-origen.git`;
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'a\n');
  git('add', '.'); git('commit', '-qm', 'base');
  git('remote', 'add', 'origin', origen); git('push', '-q', 'origin', 'main');
  git('checkout', '-q', '-b', 'arreglo');
  const base = { sha: git('rev-parse', 'origin/main'), traida: true, origen };
  fs.writeFileSync(path.join(repo, 'src', 'hecho.ts'), 'h\n');
  git('add', '.'); git('commit', '-qm', 'el carril');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'executeQuery("x");\n');
  fs.writeFileSync(path.join(repo, 'src', 'ajeno.ts'), 'de otra sesión\n');
  // sin seguir y anotado: es del carril, y se manda a borrar
  fs.writeFileSync(path.join(repo, 'src', 'nuevo.ts'), 'del carril\n');
  carrilFrenado(home, 'ses-c52', { files: [path.join(repo, 'src', 'a.ts'), path.join(repo, 'src', 'nuevo.ts')], bases: { [repo]: base } });
  const r = markerSinVentana(home, 'ses-c52', ALLOW('descartar'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /src\/a\.ts/);
  assert.match(r.stdout, /src\/hecho\.ts/);
  assert.match(r.stdout.split('\n').find((l) => /para borrar/.test(l)) || '', /nuevo\.ts/);
  assert.doesNotMatch(r.stdout, /ajeno\.ts/);
});

// 🔴 Falla con: el texto libre de la sesión pegado sin escapar en el comando que corre el dueño en su terminal.
test('T29 Cuadro_ComandoParaElDueno_SinInyeccion @story-8.196 @ac-13', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  carrilFrenado(home, 'ses-c10');
  const r = markerSinVentana(home, 'ses-c10', ['adhoc', 'allow-data-change', '--changed', 'el "botón" $(id)', '--recommends', 'pasar', '--why', "es `seguro' y punto"]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(`--changed 'el "botón" $(id)'`), r.stderr);
  assert.ok(r.stderr.includes(`--why 'es \`seguro'\\'' y punto'`), r.stderr);
});

test('T29 Cuadro_SinRecomendacionOSinPorque_NoArma @story-8.196 @ac-13', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  carrilFrenado(home, 'ses-c5');
  const casos = [
    [['adhoc', 'allow-data-change', '--changed', 'x', '--why', 'y'], /--recommends/],
    [['adhoc', 'allow-data-change', '--changed', 'x', '--recommends', 'pasar'], /--why/],
    [['adhoc', 'allow-data-change', '--changed', 'x', '--recommends', 'quizas', '--why', 'y'], /pasar, historia o descartar/],
    [['adhoc', 'allow-data-change', '--recommends', 'pasar', '--why', 'y'], /--changed/],
  ];
  for (const [args, falta] of casos) {
    const r = markerSinVentana(home, 'ses-c5', args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, falta);
  }
  const sinCarril = markerSinVentana(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')), 'ses-c6', ALLOW('pasar'));
  assert.equal(sinCarril.status, 1);
  assert.match(sinCarril.stderr, /no hay un camino corto abierto/);
  const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  carrilFrenado(h2, 'ses-c7', { frenoDatos: undefined });
  const sinFreno = markerSinVentana(h2, 'ses-c7', ALLOW('pasar'));
  assert.equal(sinFreno.status, 1);
  assert.match(sinFreno.stderr, /no hay un freno de datos/);
});
