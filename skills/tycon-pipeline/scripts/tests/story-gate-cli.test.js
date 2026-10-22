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

test('marker.js adhoc set/get/clear', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sid = 'sess-a';
  // El ring vacío no es un pase libre: este test de mecánica lo puebla,
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

// ── Carril fijado por el prompt: on-prompt.js real + marker.js adhoc set ─────────────
test('adhoc set sin modelo: la cita literal decide — paráfrasis denegada, cita del user permitida; kill-switch del dev', () => {
  // No hay carril por regex (ver story-gate.js).
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

  // Un prompt de ejemplo: el reminder de intent sigue avisando…
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

// Las cercas del caso crítico: sin modelo, el carril por prompt quedaría MÁS DÉBIL que el regex que reemplazó
// justo en el anti-pattern fundacional. Estos tests lo impiden.
test('adhoc set sin modelo: citar el PROPIO pedido de story se veta; el ring vacío no es un pase libre; el atajo sin juez deja constancia', () => {
  const onPrompt = (home, sid, prompt) => spawnSync('node', [path.join(SCRIPTS, 'on-prompt.js')], {
    encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: sid }),
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const log = (home) => { try { return fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'adhoc.log'), 'utf8'); } catch { return ''; } };

  // El user pidió una story; el agente cita ESE pedido como motivo del atajo. La cita pasa la
  // capa mecánica de literalidad — el veto tiene que venir de reconocer QUÉ está citando.
  let home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  onPrompt(home, 's-h1', 'implementemos la story 1.1 del sprint');
  let r = markerCli(home, 's-h1', ['adhoc', 'set', '{"reason":"implementemos la story 1.1"}']);
  assert.equal(r.status, 2, `H1 REABIERTO: el pedido de story citado como motivo de ad-hoc pasó sin modelo\n${r.stderr}`);
  assert.match(r.stderr, /pedido de implementar/);
  assert.match(log(home), /ADHOC_DENIED_STORY_QUOTE/);

  // Ring vacío (hook de prompt roto / sesión sin prompts): no cuenta como cita; si quoted fuera true, pasaba todo.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  r = markerCli(home, 's-h2a', ['adhoc', 'set', '{"reason":"motivo inventado sin ring"}']);
  assert.equal(r.status, 2, 'H2a REABIERTO: ring vacío volvió a ser un pase libre');

  // La constancia del atajo sin juez: cita legítima + modelo ausente → pasa, pero queda anotado.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  onPrompt(home, 's-unj', 'arreglá el bug del redirect en el login');
  // Un PATH con node y NADA más. `path.dirname(process.execPath)` no sirve: con node por nvm, `claude` vive en esa misma
  // carpeta (…/.nvm/versions/node/<v>/bin/claude) y el clasificador lo encontraría — correría el binario real y anotaría
  // `via: "error"` en vez de «sin modelo» (en la CI node no convive con claude).
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

// El clasificador como JUEZ del adhoc set: con modelo disponible, su veredicto gana
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
    // toma como «claude falló» y decide la capa mecánica (la APERTURA AUDITADA saldría 2, no 0).
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
  // fundacional). La cita PASA la capa mecánica — el veto sólo puede venir del modelo.
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
  let r = markerCli(home, 's13', ['complete-step', '3', '--auto-approved', 'LOW: 2 archivos']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /el plan se aprueba solo; la maqueta no: una pantalla la ve una persona antes/);
  // el plan aprobado solo se muestra igual: escrito, y en la respuesta del agente (plan-visible.test.js)
  const runDir = require(path.join(__dirname, '..', 'pipeline.js')).resolveRunDir(repo, '1.1', true, s);
  const planAuto = '1. La pantalla de facturas con su detalle.\n';
  fs.writeFileSync(path.join(runDir, 'step-02-bmad-plan.md'), planAuto);
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-repo'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', '-repo', 's13.jsonl'),
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `El plan:\n${planAuto}` }] } })}\n`);
  r = markerCli(home, 's13', ['complete-step', '3', '--auto-approved', 'LOW: 2 archivos', '--mockup-approved', 'la vio el dueño']);
  assert.equal(r.status, 0, r.stderr);
  const m = leerMarker730(home, 's13');
  assert.equal(m.planApproval.mode, 'auto-low-risk');
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
    // los sub-pasos del arranque (reloj, pedido en ADO) no son lo que se prueba
    markerCli(home, sid, ['set-flag', 'clockiStarted', 'true']); markerCli(home, sid, ['set-flag', 'adoMarkedActive', 'true']);
    const n = pipe(sid, ['next']);
    assert.equal(n.status, 0, n.stderr);
    assert.match(n.stdout, /complete-step approve-plan/);
    if (conMaqueta) assert.match(n.stdout, /--mockup-approved/); else assert.doesNotMatch(n.stdout, /--mockup-approved/);
    const rc = JSON.parse(pipe(sid, ['risk-class', '--story', s]).stdout);
    assert.equal(rc.auto_approve_plan, true);
    if (conMaqueta) {
      assert.equal(rc.mockup_required, true);
      assert.match(rc.note, /el plan se aprueba solo; la maqueta no/);
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
  markerCli(home, 's28c', ['set-flag', 'clockiStarted', 'true']); markerCli(home, 's28c', ['set-flag', 'adoMarkedActive', 'true']);
  const n = pipe('s28c', ['next']);
  assert.match(n.stdout, /--mockup-approved/);
});
