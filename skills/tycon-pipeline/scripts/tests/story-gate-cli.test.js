#!/usr/bin/env node
/**
 * story-gate-cli.test.js — la parte del portón de carril que LANZA PROCESOS (git, marker.js CLI):
 * kill-switch commiteado, complete-step (orden / Step 3 / Step 5), marker set, adhoc. Corre en el throttle
 * DIARIO del instalador (hallazgo H8 del review 2026-08-19: en SessionStart sumaba ~1 min bajo carga).
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
// el nombre público del arnés (el del lugar, story 8.19), de place.js del repo único; en un clon de skills suelto no está
// y los gemelos con ese nombre no se miden (se dice). Nunca escrito a mano: vive sólo en public-repos.json y place.js.
const PUBLIC_NAME = (() => { try { return require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'setup', 'harness', 'place.js')).PLACE_NAME; } catch (_) { return null; } })();
const twin = (fn) => (PUBLIC_NAME ? fn() : console.log('⏭ gemelo con el nombre público: NO MEDIDO — sin scripts/setup/harness/place.js (clon de skills suelto)'));

const SCRIPTS = path.join(__dirname, '..');
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
// TYCON_LANE_LLM: '0' por default — el desempate por modelo barato (lib/lane-classifier.js) corre
// en los dos denies de `adhoc set`, y si no se apaga acá la suite saldría a invocar Haiku de
// verdad: lenta, con red, y con veredictos que cambian entre corridas. Un test que lo quiera
// probar lo prende por extraEnv e inyecta su propia respuesta.
function markerCli(home, sid, args, extraEnv = {}) {
  return spawnSync('node', [path.join(SCRIPTS, 'marker.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', ...extraEnv },
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
  // 3 auto-aprobado en story que NO es LOW (signed_for_sprint → NORMAL) → bloqueado
  r = markerCli(home, sid, ['complete-step', '3', '--auto-approved', 'criterios']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /risk-class/);
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
  assert.notEqual(r.status, 0); assert.match(r.stderr, /de ESTA iteración/);
  // trust-ran → provenance trust-ran → no alcanza
  markerCli(home, sid, ['run-check', 'advisors', '--', ...CC, '--trust-ran']);
  r = markerCli(home, sid, ['complete-step', '5', '--out-of-order']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /provenance=trust-ran/);
  // run-check fresco → cierra
  markerCli(home, sid, ['run-check', 'advisors', '--', ...CC]);
  r = markerCli(home, sid, ['complete-step', '5', '--out-of-order']);
  assert.equal(r.status, 0, r.stderr);
  // frescura: un check con el MISMO instante que el cierre previo NO cuenta (> estricto)
  // y el gate también cubre `4 sin 3` y `8 sin 5` (mutantes H16)
  const mpath = path.join(home, '.claude', '.tycon-pipeline', 'active', `${sid}.json`);
  const m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  m.checksAt.advisors = m.stepTimings['5'].completedAt; fs.writeFileSync(mpath, JSON.stringify(m));
  r = markerCli(home, sid, ['complete-step', '5', '--out-of-order']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /de ESTA iteración/);
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
  assert.equal(r.status, 0); assert.match(r.stderr, /SIN el Step 3/);
  const bl = () => fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'bypass.log'), 'utf8');
  assert.match(bl(), /MARKER_SKIPS_PLAN/);
  // MISMA story que OMITE el 3 que estaba pendiente → MARKER_DROPS_PLAN (H5)
  r = markerCli(home, sid, ['set', JSON.stringify({ storyId: '2.2', stepsPending: [5, 6, 7, 8] })]);
  assert.equal(r.status, 0); assert.match(r.stderr, /que estaba pendiente/);
  assert.match(bl(), /MARKER_DROPS_PLAN/);
  // OTRA story sobre un marker viejo, sin 3 → MARKER_SKIPS_PLAN (H5)
  r = markerCli(home, sid, ['set', JSON.stringify({ storyId: '9.9', stepsPending: [5, 6, 7, 8] })]);
  assert.equal(r.status, 0);
  assert.equal((bl().match(/MARKER_SKIPS_PLAN/g) || []).length, 2);
  // retomando con stepsCompleted que incluye 3 → sin aviso
  r = markerCli(home, 'sess-w', ['set', JSON.stringify({ storyId: '4.4', stepsPending: [5, 6, 7, 8], stepsCompleted: [0, 1, 2, 3, 4] })]);
  assert.doesNotMatch(r.stderr, /Step 3/);
});

test('marker.js adhoc set/get/clear', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sid = 'sess-a';
  // H2a (2026-08-27): el ring vacío ya no es un pase libre — este test de mecánica lo puebla,
  // porque set/get/clear es lo que prueba, no el juicio (eso vive en los tests de al lado).
  spawnSync('node', [path.join(SCRIPTS, 'on-prompt.js')], {
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hotfix botón guardar deshabilitado, sigue siendo chico, dice el user', session_id: sid }),
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  let r = markerCli(home, sid, ['adhoc', 'set', '{"reason":"x"}']);
  assert.notEqual(r.status, 0);
  r = markerCli(home, sid, ['adhoc', 'set', '{"reason":"hotfix botón guardar deshabilitado"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).maxFiles, 8);
  r = markerCli(home, sid, ['adhoc', 'get']);
  assert.equal(r.status, 0); assert.match(r.stdout, /hotfix botón/);
  r = markerCli(home, sid, ['adhoc', 'set', '{"reason":"sigue siendo chico, dice el user","maxFiles":12}']);
  assert.equal(JSON.parse(r.stdout).maxFiles, 12);
  assert.match(fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'adhoc.log'), 'utf8'), /ADHOC_UPDATE/);
  r = markerCli(home, sid, ['adhoc', 'clear']);
  assert.equal(r.status, 0);
  assert.equal(markerCli(home, sid, ['adhoc', 'get']).status, 1);
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

// ── Carril fijado por el prompt (2026-08-24): on-prompt.js real + marker.js adhoc set ─────────────
test('adhoc set sin modelo: la cita literal decide — paráfrasis denegada, cita del user permitida; kill-switch del dev', () => {
  // 2026-08-27: el carril por regex se borró (tres incidentes en tres días — ver story-gate.js).
  // Sin modelo disponible (markerCli pasa TYCON_LANE_LLM=0) decide la capa mecánica sola:
  // el reason tiene que ser un fragmento literal de un prompt del user. No hay más deny por
  // "carril pipeline fijado" — ese deny hoy sólo puede dictarlo el clasificador leyendo los
  // prompts reales (tests/lane-classifier.test.js cubre esos veredictos con call inyectado).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sid = 'sess-lane';
  const stateDir = path.join(home, '.claude', '.tycon-pipeline');
  const onPrompt = (prompt) => spawnSync('node', [path.join(SCRIPTS, 'on-prompt.js')], {
    encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: sid }),
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const adhocLog = () => { try { return fs.readFileSync(path.join(stateDir, 'adhoc.log'), 'utf8'); } catch { return ''; } };

  // El prompt del caso disparador del 2026-08-24: el reminder de intent sigue avisando…
  let r = onPrompt('implementemos la story 2.3: exponer el provider, tests scoped');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /INTENT-detect/, 'el reminder de pipeline sigue avisando');
  const lane = JSON.parse(fs.readFileSync(path.join(stateDir, 'lane', `${sid}.json`), 'utf8'));
  assert.equal(lane.lane, undefined, 'ningún prompt fija carril');

  // …y una paráfrasis del agente NO alcanza para declarar el atajo.
  r = markerCli(home, sid, ['adhoc', 'set', '{"reason":"un ajuste chico que decidí yo"}']);
  assert.equal(r.status, 2); assert.match(r.stderr, /LITERAL/); assert.match(adhocLog(), /ADHOC_DENIED_REASON/);
  assert.match(r.stderr, /Preguntale al user/i, 'la salida siempre es preguntar, no un muro');
  assert.equal(markerCli(home, sid, ['adhoc', 'get']).status, 1, 'no quedó ad-hoc declarado');

  // La cita literal del user sí declara.
  onPrompt('dale, hacelo ad-hoc: hotfix del provider nomás');
  r = markerCli(home, sid, ['adhoc', 'set', '{"reason":"Hotfix del provider nomas"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(markerCli(home, sid, ['adhoc', 'get']).status, 0);

  // Kill-switch del dev (env del proceso, no del agente): sin verificación.
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  r = markerCli(home2, sid, ['adhoc', 'set', '{"reason":"motivo inventado con kill-switch"}'], { TYCON_STORY_GATE: 'off' });
  assert.equal(r.status, 0, r.stderr);
});

// H1/H2a de la revisión adversarial del rediseño (2026-08-27) — las cercas del caso crítico:
// sin modelo, el rediseño había quedado MÁS DÉBIL que el regex borrado justo en el anti-pattern
// fundacional. Estos tests son la razón de que no vuelva a pasar.
test('adhoc set sin modelo: citar el PROPIO pedido de story se veta; el ring vacío no es un pase libre; el atajo sin juez deja constancia', () => {
  const onPrompt = (home, sid, prompt) => spawnSync('node', [path.join(SCRIPTS, 'on-prompt.js')], {
    encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: sid }),
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const log = (home) => { try { return fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'adhoc.log'), 'utf8'); } catch { return ''; } };

  // H1: el user pidió una story; el agente cita ESE pedido como motivo del atajo. La cita pasa la
  // capa mecánica de literalidad — el veto tiene que venir de reconocer QUÉ está citando.
  let home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  onPrompt(home, 's-h1', 'implementemos la story 1.1 del sprint');
  let r = markerCli(home, 's-h1', ['adhoc', 'set', '{"reason":"implementemos la story 1.1"}']);
  assert.equal(r.status, 2, `H1 REABIERTO: el pedido de story citado como motivo de ad-hoc pasó sin modelo\n${r.stderr}`);
  assert.match(r.stderr, /pedido de implementar/);
  assert.match(log(home), /ADHOC_DENIED_STORY_QUOTE/);

  // H2a: ring vacío (hook de prompt roto / sesión sin prompts) — antes quoted=true y pasaba todo.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  r = markerCli(home, 's-h2a', ['adhoc', 'set', '{"reason":"motivo inventado sin ring"}']);
  assert.equal(r.status, 2, 'H2a REABIERTO: ring vacío volvió a ser un pase libre');

  // La constancia del atajo sin juez: cita legítima + modelo ausente → pasa, pero queda anotado.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  onPrompt(home, 's-unj', 'arreglá el bug del redirect en el login');
  // Un PATH con node y NADA más. `path.dirname(process.execPath)` no sirve: con node por nvm, `claude` vive en esa misma
  // carpeta (…/.nvm/versions/node/<v>/bin/claude) y el clasificador lo encontraba — corría el binario real y anotaba
  // `via: "error"` en vez de «sin modelo» (rojo local de esta suite desde la 8.3-A; en la CI node no convive con claude).
  const binVacio = fs.mkdtempSync(path.join(os.tmpdir(), 'nobin-'));
  fs.symlinkSync(process.execPath, path.join(binVacio, 'node'));
  r = spawnSync('node', [path.join(SCRIPTS, 'marker.js'), 'adhoc', 'set', '{"reason":"arreglá el bug del redirect"}'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 's-unj', TYCON_LANE_LLM: '1', PATH: binVacio },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(log(home), /ADHOC_SET_UNJUDGED/, 'el atajo sin juez tiene que dejar constancia');
  assert.match(log(home), /"via":"sin-modelo"/, 'sin claude ni codex en el PATH no es un error ni una respuesta');
});

// El clasificador como JUEZ del adhoc set (2026-08-27): con modelo disponible, su veredicto gana
// sobre la cita. Se prueba con un `claude` falso en el PATH que contesta fijo — el binario real no
// entra a una suite (no reproducible, lento, y castiga la máquina sin red).
test('adhoc set con modelo: PIPELINE veta aunque el reason cite al user; ADHOC abre una cita fallida y queda auditado', () => {
  // El clasificador le pide al CLI salida estructurada (--output-format json --json-schema): el
  // `claude` falso contesta con el sobre del CLI, el veredicto en `structured_output.veredicto`.
  const sobre = (veredicto) => JSON.stringify({ type: 'result', subtype: 'success', result: '', structured_output: { veredicto } });
  const mkFakeClaude = (salida) => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fakebin-'));
    const f = path.join(bin, 'claude');
    // El falso exige el contrato real: sin --json-schema y --output-format json sale con error. Y, como el CLI real, lee
    // el prompt entero de la entrada antes de contestar: si sale sin leerlo, el clasificador recibe EPIPE de a ratos, lo
    // toma como «claude falló» y decide la capa mecánica (public-ci, 2026-10-14: la APERTURA AUDITADA salió 2, no 0).
    fs.writeFileSync(f, `#!/bin/sh\n[ "$1" = --version ] && { echo 2.1.280; exit 0; }\ncat > /dev/null\ncase "$*" in *--json-schema*) ;; *) echo 'falta --json-schema' >&2; exit 9;; esac\ncase "$*" in *'--output-format json'*) ;; *) echo 'falta --output-format json' >&2; exit 9;; esac\ncat <<'FIN'\n${salida}\nFIN\n`);
    fs.chmodSync(f, 0o755);
    return bin;
  };
  // El falso lee la entrada: con 1 MB (más que el búfer del caño) un falso que no la lee da EPIPE siempre.
  const lee = spawnSync(path.join(mkFakeClaude(sobre('ADHOC')), 'claude'), ['--json-schema', '{}', '--output-format', 'json'], { input: 'x'.repeat(1024 * 1024), encoding: 'utf8' });
  assert.ok(!lee.error && lee.status === 0, `el claude falso tiene que leer la entrada como el real: ${lee.error && lee.error.code} rc ${lee.status}`);
  const run = (home, sid, reason, salida) => markerCli(home, sid, ['adhoc', 'set', JSON.stringify({ reason })], {
    TYCON_LANE_LLM: '1', PATH: `${mkFakeClaude(salida)}:${process.env.PATH}`,
  });
  const onPrompt = (home, sid, prompt) => spawnSync('node', [path.join(SCRIPTS, 'on-prompt.js')], {
    encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: sid }),
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });

  // VETO: el user pidió una story; el agente la cita textual como motivo del atajo (el anti-pattern
  // del 2026-08-24). La cita PASA la capa mecánica — el veto sólo puede venir del modelo.
  let home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  onPrompt(home, 's-veto', 'implementemos la story 2.3 con el pipeline completo');
  let r = run(home, 's-veto', 'implementemos la story 2.3', sobre('PIPELINE'));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /story\/spec por el pipeline/);
  assert.match(fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'adhoc.log'), 'utf8'), /ADHOC_LLM_DENIED_LANE/);

  // APERTURA AUDITADA: el user pidió el atajo con palabras que ninguna cita mecánica matchea
  // ("metele nomás, sin tanta vuelta") y el reason del agente no es cita literal → la capa
  // mecánica denegaría; el modelo dice ADHOC → se abre, con constancia ADHOC_LLM_OVERRIDE_LANE.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  onPrompt(home, 's-open', 'metele nomás con eso del provider, sin tanta vuelta');
  r = run(home, 's-open', 'arreglo rapido del provider', sobre('ADHOC'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'adhoc.log'), 'utf8'), /ADHOC_LLM_OVERRIDE_LANE/);

  // ROTO: el CLI no entrega un veredicto estructurado (texto suelto en vez del sobre) → decide la
  // capa mecánica (cita fallida = deny).
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  onPrompt(home, 's-null', 'metele nomás con eso del provider');
  r = run(home, 's-null', 'arreglo rapido del provider', 'creo que ADHOC o quizás PIPELINE');
  assert.equal(r.status, 2, 'salida sin sobre → manda lo mecánico');
  assert.match(fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'adhoc.log'), 'utf8'), /"via":"error"/,
    'una falla del CLI queda como error, no como un NINGUNO del modelo');

  // NINGUNO estructurado: el modelo contestó y no eligió → también manda lo mecánico.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  onPrompt(home, 's-ninguno', 'metele nomás con eso del provider');
  r = run(home, 's-ninguno', 'arreglo rapido del provider', sobre('NINGUNO'));
  assert.equal(r.status, 2, 'NINGUNO → manda lo mecánico');
  assert.match(fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'adhoc.log'), 'utf8'), /"via":"llm-sin-veredicto"/,
    'NINGUNO es una respuesta del modelo, no un error');
});

test('on-prompt.js: un prompt sin señal no toca el carril; una pregunta sobre la story tampoco lo fija', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sid = 'sess-lane2';
  const stateDir = path.join(home, '.claude', '.tycon-pipeline');
  const onPrompt = (prompt) => spawnSync('node', [path.join(SCRIPTS, 'on-prompt.js')], {
    encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: sid }),
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  onPrompt('¿cómo está implementada la story 2.3?');
  onPrompt('arreglá el bug del redirect');
  const lane = JSON.parse(fs.readFileSync(path.join(stateDir, 'lane', `${sid}.json`), 'utf8'));
  assert.equal(lane.lane, undefined);
  assert.equal(lane.recentPrompts.length, 2);
  const r = markerCli(home, sid, ['adhoc', 'set', '{"reason":"arreglá el bug del redirect"}']);
  assert.equal(r.status, 0, r.stderr);
});

// ── gates.log con namespace de repo (2026-08-24, GATESLOG-STORYID-NS-1) ─────────────────────────
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

// ── quién es un repo del harness: lo dice el remoto, no la carpeta (2026-09-17) ──────────────────
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

// `nombre`: con cuál de sus dos nombres trae el criterio ese arnés (el de antes de la story 8.9 del arnés, por defecto: un
// arnés un pull atrás; `harness-repo.js`: el de hoy, que es el único que trae una copia sin reemplazos).
function tcgDeMentira(nombre = 'repo-del-arnes.js') { // un arnés cuyo criterio es: «es del arnés si la ruta dice ES-ARNES»
  const tcg = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-stub-'));
  fs.mkdirSync(path.join(tcg, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(tcg, 'scripts', 'lib', nombre), 'module.exports={esRutaDelArnes:(p)=>/ES-ARNES/.test(String(p))};\n');
  // Un «clon del arnés» tiene scripts/install-tycon-hooks.sh: es lo que exige lib/harness-path.js antes de hacer
  // require() de código en un hook (story 8.3, revisor de seguridad). Sin él, la variable se ignora, se cae al
  // enlace del HOME temporal —que no existe— y el portón decide por la carpeta: `block` (rojo de la CI 11070).
  fs.writeFileSync(path.join(tcg, 'scripts', 'install-tycon-hooks.sh'), '#!/usr/bin/env bash\nexit 0\n');
  return tcg;
}
// Las identidades del arnés se INYECTAN (story 8.3, AC 7): la CI corre con HOME temporal y sin TYCON_SKILLS_DIR,
// así que repo-del-arnes.js no encuentra agent-skills para derivar su identidad del origin de la máquina.
// La variable la lee sólo el arnés, con su nombre en inglés y el viejo andando por alias desde la story 8.9 (tanda B1).
const IDENTIDADES_ARNES = { TYCON_HARNESS_IDENTITIES: 'https://dev.azure.com/org-del-equipo/tycon-claude-guides/_git/tycon-claude-guides,https://org-del-equipo.visualstudio.com/AgentSkills/_git/AgentSkills' };
function tcgDeVerdad() { // la lib real, donde esté: variable, cwd (así corre el nocturno) o la ruta canónica
  const cand = [process.env.TYCON_GUIDES_DIR, process.env.TCG, process.cwd(), path.join(os.homedir(), 'SourceCode', 'tycon-claude-guides')];
  return cand.find((d) => d && fs.existsSync(path.join(d, 'scripts', 'lib', 'repo-del-arnes.js'))) || null;
}

test('harness: el portón le cree al criterio del arnés, no a la carpeta — en los dos sentidos', () => {
  const tcg = tcgDeMentira();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'porton-'));
  const clon = repoGit(path.join(base, 'ES-ARNES', 'clon'));
  const producto = repoGit(path.join(base, 'tycon-claude-guides', 'MiProducto'));
  // ROJO PREVIO: la carpeta del clon no se llama como el arnés → `no-lane`.
  const a = porton(tcg, path.join(clon, 'src', 'a.js'));
  assert.equal(a.action, 'pass', JSON.stringify(a)); assert.match(a.reason, /harness/);
  // ROJO PREVIO (la cara): un segmento con el nombre del arnés alcanzaba → código de producto sin carril, en silencio.
  const b = porton(tcg, path.join(producto, 'src', 'a.js'));
  assert.equal(b.action, 'block', JSON.stringify(b)); assert.equal(b.kind, 'no-lane');
  // gemelo con el nombre público (story 8.19, tanda E, AC 39): bajo una carpeta llamada como el lugar, tampoco
  twin(() => {
    const b2 = porton(tcg, path.join(repoGit(path.join(base, PUBLIC_NAME, 'MiProducto')), 'src', 'a.js'));
    assert.equal(b2.action, 'block', JSON.stringify(b2)); assert.equal(b2.kind, 'no-lane');
  });
  // El freno de story-a-mano usa el mismo criterio.
  assert.equal(frenoDeStory(tcg, path.join(clon, 'specs', '9-9.md')).kind, 'harness');
  assert.notEqual(frenoDeStory(tcg, path.join(producto, 'specs', '9-9.md')).kind, 'harness');
});

// Story 8.9 del arnés, tanda G: el criterio se buscaba sólo por su nombre de antes del renombre. En el equipo andaba por
// el reemplazo que deja el renombre; en una copia sin reemplazos el portón caía al nombre de carpeta sin decirlo.
// ROJO PREVIO: con un arnés que trae sólo `harness-repo.js`, el clon daba `no-lane` (decidía la carpeta).
test('harness: el criterio del arnés se encuentra por su nombre de hoy, sin el reemplazo del nombre de antes', () => {
  const tcg = tcgDeMentira('harness-repo.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'porton-'));
  const clon = repoGit(path.join(base, 'ES-ARNES', 'clon'));
  const producto = repoGit(path.join(base, 'tycon-claude-guides', 'MiProducto'));
  const a = porton(tcg, path.join(clon, 'src', 'a.js'));
  assert.equal(a.action, 'pass', JSON.stringify(a)); assert.match(a.reason, /harness/);
  const b = porton(tcg, path.join(producto, 'src', 'a.js'));
  assert.equal(b.action, 'block', JSON.stringify(b)); assert.equal(b.kind, 'no-lane');
  // gemelo con el nombre público (story 8.19, tanda E, AC 39)
  twin(() => {
    const b2 = porton(tcg, path.join(repoGit(path.join(base, PUBLIC_NAME, 'MiProducto')), 'src', 'a.js'));
    assert.equal(b2.action, 'block', JSON.stringify(b2)); assert.equal(b2.kind, 'no-lane');
  });
});

// Revisión de la tanda G (revisor de alcance): con el arnés UBICADO pero sin el archivo del criterio —ni con su nombre de
// hoy ni con el de antes—, el portón caía al nombre de carpeta sin una palabra. El AC 67 de la story 8.9 dice que no cae
// callado: decide la carpeta igual (nunca rompe un Edit), y lo dice por la salida de error.
// ROJO PREVIO: la salida de error venía vacía.
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

// Pase adversarial de la tanda G (causa 7): el criterio está y carga, pero no trae `esRutaDelArnes`, o la trae y revienta.
// En los dos casos el portón decidía por la carpeta sin decirlo. Ahora decide la carpeta igual (nunca rompe un Edit) y lo dice.
// ROJO PREVIO: la salida de error venía vacía en los dos.
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

test('harness: con el criterio REAL del arnés — clon por su remoto, producto bajo carpeta con nombre del arnés', (t) => {
  const tcg = tcgDeVerdad();
  if (!tcg) return t.skip('NO MEDIDO: no encontré tycon-claude-guides/scripts/lib/harness-repo.js (TYCON_GUIDES_DIR · TCG · cwd · ruta canónica)');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'porton-'));
  const clon = repoGit(path.join(base, 'scratchpad', 'as'), 'https://otro@org-del-equipo.visualstudio.com/AgentSkills/_git/AgentSkills');
  const producto = repoGit(path.join(base, 'tycon-claude-guides', 'MiProducto'), 'https://org-del-equipo@dev.azure.com/org-del-equipo/UnProducto/_git/Backend');
  assert.equal(porton(tcg, path.join(clon, 'skills', 'x', 'a.js'), IDENTIDADES_ARNES).action, 'pass');
  assert.equal(porton(tcg, path.join(producto, 'src', 'a.js'), IDENTIDADES_ARNES).kind, 'no-lane');
  // gemelo con el nombre público (story 8.19, tanda E, AC 39)
  twin(() => {
    const producto2 = repoGit(path.join(base, PUBLIC_NAME, 'MiProducto'), 'https://org-del-equipo@dev.azure.com/org-del-equipo/UnProducto/_git/Backend');
    assert.equal(porton(tcg, path.join(producto2, 'src', 'a.js'), IDENTIDADES_ARNES).kind, 'no-lane');
  });
});
