#!/usr/bin/env node
/**
 * org-switches.test.js — los frenos y medidores que la organización cambia desde el sitio (`switches` del perfil del
 * equipo, y `wait_notice.enabled` de team-repos.json).
 *
 * La regla que se prueba, en tres casos por control:
 *   - sin clave en el perfil, todo como hoy (cada control como viene de fábrica, o como dice su variable);
 *   - la organización lo enciende, y corre (o se registra) sin que la máquina ponga nada;
 *   - un freno que la organización intenta apagar queda como viene de fábrica, y se nombra; un medidor sí se apaga.
 * Y una clave que no se puede leer no enciende ni apaga nada en silencio: queda lo de fábrica, con aviso.
 *
 * Cada caso tiene su HOME temporal y su perfil en un archivo propio (`TYCON_PROFILE=<ruta>`): el perfil y la
 * configuración reales de la máquina no se leen ni se tocan.
 *
 * Correr: node --test scripts/tests/org-switches.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const C = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
const AH = require(path.join(ROOT, 'scripts', 'setup', 'apply-hooks.js'));
const WN = require(path.join(ROOT, 'scripts', 'hooks', 'wait-notice.js'));
const TR = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
const HOOKS = path.join(ROOT, 'scripts', 'hooks');
// las carpetas temporales de cada caso se borran al terminar
const temporales = [];
const temporal = (prefijo) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefijo)); temporales.push(d); return d; };
process.on('exit', () => { for (const d of temporales) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ya no está */ } } });

/** Una casa temporal con su perfil: `{ home, env }`. `perfil` es el objeto del perfil, o un texto tal cual. */
function casa(perfil) {
  const home = temporal('org-switches-');
  const prof = path.join(home, 'team-profile.json');
  fs.writeFileSync(prof, typeof perfil === 'string' ? perfil : JSON.stringify(perfil || {}));
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TYCON_PROFILE: prof };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return { home, env };
}
const opts = (c) => ({ env: c.env, home: c.home });

// ── el lector ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('T1 sin clave = como hoy: cada interruptor sale como viene de fábrica, sin aviso', () => {
  const c = casa({ response: { style: 'neutral' } });
  for (const [name, sw] of Object.entries(C.SWITCHES)) {
    const st = C.switchState(name, opts(c));
    assert.strictEqual(st.value, null, `${name} no tendría que traer valor`);
    assert.strictEqual(st.warning, null, `${name} no tendría que avisar nada`);
    assert.strictEqual(C.switchOn(name, opts(c)), sw.factory === 'on', `${name} tendría que estar como de fábrica`);
  }
  assert.deepStrictEqual(C.brakeOptIns(C.leer(opts(c))), {});
});

test('T2 org enciende: los frenos que vienen apagados se encienden sin variable en la máquina', () => {
  const c = casa({ switches: { session_guard: 'on', pr_one_per_repo: 'on' } });
  assert.strictEqual(C.switchOn('session_guard', opts(c)), true);
  assert.strictEqual(C.switchOn('pr_one_per_repo', opts(c)), true);
  assert.deepStrictEqual(C.brakeOptIns(C.leer(opts(c))), { TYCON_SESSION_GUARD: '1', TYCON_PR_ONE_PER_REPO: '1' });
});

test('T3 org intenta apagar un freno = ignorado: queda como de fábrica, se nombra y la configuración no se rompe', () => {
  for (const off of ['off', false, 'false', '0', 0, 'no']) {
    const c = casa({ switches: { safety_guard: off, session_guard: off } });
    const r = C.leerParaHook(opts(c));
    assert.strictEqual(r.ok, true, `con ${JSON.stringify(off)} la configuración no tendría que romperse`);
    assert.strictEqual(C.switchOn('safety_guard', opts(c)), true, 'el freno de fábrica encendido sigue encendido');
    assert.strictEqual(C.switchOn('session_guard', opts(c)), false, 'el freno de fábrica apagado sigue apagado');
    const st = C.switchState('safety_guard', opts(c));
    assert.match(String(st.warning), /switches\.safety_guard/, 'el aviso nombra la clave');
    assert.match(String(st.warning), /TYCON_SAFETY_GUARD=0/, 'y dice cómo se apaga en la máquina');
  }
});

test('T4 el sitio rechaza un freno apagado y un valor que no se entiende, nombrando la clave', () => {
  const off = C.parse(JSON.stringify({ switches: { test_scope_guard: 'off' } }));
  assert.strictEqual(off.ok, false);
  assert.strictEqual(off.problems[0].path, 'switches.test_scope_guard');
  const raro = C.parse(JSON.stringify({ switches: { response_meter: 'tal vez' } }));
  assert.strictEqual(raro.ok, false);
  assert.strictEqual(raro.problems[0].path, 'switches.response_meter');
  assert.strictEqual(C.parse(JSON.stringify({ switches: { safety_guard: 'on', blocking_meter: 'off' } })).ok, true);
});

test('T5 un medidor: la org lo apaga o lo enciende, y la variable de la máquina gana', () => {
  const apagado = casa({ switches: { response_meter: 'off', blocking_meter: 'off' } });
  assert.strictEqual(C.switchOn('response_meter', opts(apagado)), false);
  assert.strictEqual(C.switchOn('blocking_meter', opts(apagado)), false);
  const conVariable = Object.assign({}, apagado.env, { TYCON_RESPONSE_METER: '1' });
  assert.strictEqual(C.switchOn('response_meter', { env: conVariable, home: apagado.home }), true, 'la variable puesta gana');
  const encendido = casa({ switches: { response_meter: 'on' } });
  const apagadoEnLaMaquina = Object.assign({}, encendido.env, { TYCON_RESPONSE_METER: '0' });
  assert.strictEqual(C.switchOn('response_meter', { env: apagadoEnLaMaquina, home: encendido.home }), false);
});

test('T6 clave ilegible: la configuración rota no enciende ni apaga nada, y avisa', () => {
  const c = casa({ switches: { session_guard: 'tal vez', response_meter: 'off' } });
  const st = C.switchState('response_meter', opts(c));
  assert.strictEqual(st.value, null);
  assert.ok(st.warning, 'tiene que avisar');
  const avisos = [];
  assert.strictEqual(C.switchOn('response_meter', Object.assign(opts(c), { warn: (w) => avisos.push(w) })), true, 'el medidor sigue como de fábrica');
  assert.strictEqual(C.switchOn('session_guard', opts(c)), false, 'el freno sigue como de fábrica');
  assert.ok(avisos.length, 'el aviso llega a quien pregunta');
  // el comando del aplicador: nada por la salida, y sale con 2
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'), 'switches', '--env'], { env: c.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.stdout, '');
});

// ── el aplicador: qué controles se registran ───────────────────────────────────────────────────────────────────────

function registrados(c) {
  const list = AH.loadList(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), { integrationsDir: path.join(ROOT, 'integrations') });
  const cfg = AH.readConfig({ env: c.env });
  const d = AH.decide(list, { env: AH.envWithOrgSwitches(c.env, cfg.switches), integ: { state: 'ok', values: {} }, profile: { state: 'ok', value: 'full' }, minimalIds: new Set(), platform: 'posix', has: () => false });
  return { cfg, specs: d.active.map((h) => `${h.event} ${h.spec}`) };
}

test('T7 aplicador sin clave = como hoy: el freno de dos sesiones no se registra', () => {
  const { cfg, specs } = registrados(casa({}));
  assert.strictEqual(cfg.switches.state, 'ok');
  assert.deepStrictEqual(cfg.switches.env, {});
  assert.ok(!specs.some((s) => s.includes('session-collision-guard.js')));
  assert.ok(specs.some((s) => s.includes('safety-guard-pre.sh')), 'el freno de comandos sigue registrado');
});

test('T8 aplicador con la org encendiendo: el freno de dos sesiones se registra sin variable en la máquina', () => {
  const { specs } = registrados(casa({ switches: { session_guard: 'on' } }));
  assert.ok(specs.some((s) => s === 'PreToolUse @tcg:session-collision-guard.js'), specs.join('\n'));
  assert.ok(specs.some((s) => s === 'SessionStart @tcg:session-collision-guard.js'));
});

test('T9 aplicador: un freno apagado por la org se ignora, y la variable de la máquina sigue ganando', () => {
  const c = casa({ switches: { safety_guard: 'off' } });
  assert.ok(registrados(c).specs.some((s) => s.includes('safety-guard-pre.sh')), 'el «off» del perfil no lo saca');
  const c2 = casa({ switches: { session_guard: 'on' } });
  c2.env.TYCON_SESSION_GUARD = '0';
  assert.ok(!registrados(c2).specs.some((s) => s.includes('session-collision-guard.js')), 'la máquina que lo apagó lo deja apagado');
});

// ── los hooks ─────────────────────────────────────────────────────────────────────────────────────────────────────

function avisoDeBloqueo(c) {
  const dir = path.join(c.home, '.claude', 'blocking-meter', 'pending');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's1.json'), JSON.stringify({ worstMs: 300000, worstTool: 'Bash', maxMs: 120000, userMsgs: 0 }));
  const r = spawnSync(process.execPath, [path.join(HOOKS, 'blocking-notice.js')], { env: c.env, input: JSON.stringify({ session_id: 's1' }), encoding: 'utf8' });
  return r.stdout;
}

test('T10 medidor de esperas: sin clave avisa como hoy; la org lo apaga; la variable de la máquina gana', () => {
  assert.match(avisoDeBloqueo(casa({})), /quedó bloqueado/);
  assert.strictEqual(avisoDeBloqueo(casa({ switches: { blocking_meter: 'off' } })), '');
  const c = casa({ switches: { blocking_meter: 'off' } });
  c.env.TYCON_BLOCKING_METER = '1';
  assert.match(avisoDeBloqueo(c), /quedó bloqueado/);
  assert.match(avisoDeBloqueo(casa({ switches: { blocking_meter: 'tal vez' } })), /quedó bloqueado/, 'una clave ilegible no lo apaga');
});

function avisoDeLargo(c) {
  const dir = path.join(c.home, '.claude', 'response-style', 'pending');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's1.json'), JSON.stringify({ reasons: ['prosa 2000 > 1300'], maxProseChars: 1300, maxHeaders: 1 }));
  const r = spawnSync(process.execPath, [path.join(HOOKS, 'response-style-notice.js')], { env: c.env, input: JSON.stringify({ session_id: 's1' }), encoding: 'utf8' });
  return r.stdout;
}

test('T10b medidor de largo: sin clave avisa como hoy; la org lo apaga; la org lo enciende aunque nadie lo pida', () => {
  assert.match(avisoDeLargo(casa({})), /se pasó de largo/);
  assert.strictEqual(avisoDeLargo(casa({ switches: { response_meter: 'off' } })), '');
  assert.match(avisoDeLargo(casa({ switches: { response_meter: 'on' } })), /se pasó de largo/);
  const c = casa({ switches: { response_meter: 'on' } });
  c.env.TYCON_RESPONSE_METER = '0';
  assert.strictEqual(avisoDeLargo(c), '', 'la máquina que lo apagó lo deja apagado');
});

test('T11 el freno de un pedido por repo: sin clave apagado; la org lo enciende; la máquina lo apaga', { skip: process.platform === 'win32' ? 'el freno no corre en Windows (hooks-list: platforms.windows false)' : false }, () => {
  const bin = temporal('org-switches-az-');
  fs.writeFileSync(path.join(bin, 'az'), '#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = "policy" ] && { echo \'[{"configuration":{"type":{"displayName":"Build"}},"status":"running"}]\'; exit 0; }; done\necho \'[{"pullRequestId":4242,"title":"otro","sourceRefName":"refs/heads/ci/otra"}]\'\n');
  fs.chmodSync(path.join(bin, 'az'), 0o755);
  const crear = 'az repos pr create --org https://x --project Acme --repository Widgets --source-branch ci/nueva --target-branch main --title t';
  const corre = (c) => spawnSync(process.execPath, [path.join(HOOKS, 'pr-one-per-repo-guard.js')], { env: Object.assign({}, c.env, { PATH: `${bin}${path.delimiter}${c.env.PATH}` }), input: JSON.stringify({ tool_input: { command: crear } }), encoding: 'utf8' });
  assert.strictEqual(corre(casa({})).status, 0, 'sin clave, apagado como hoy');
  const enc = corre(casa({ switches: { pr_one_per_repo: 'on' } }));
  assert.strictEqual(enc.status, 2, 'la org lo enciende');
  assert.match(enc.stderr, /toda la organización/, 'y dice que lo encendió la organización');
  const c = casa({ switches: { pr_one_per_repo: 'on' } });
  c.env.TYCON_PR_ONE_PER_REPO = '0';
  assert.strictEqual(corre(c).status, 0, 'la máquina lo apaga con su variable');
  assert.strictEqual(corre(casa({ switches: { pr_one_per_repo: 'off' } })).status, 0, 'un «off» del perfil lo deja como de fábrica');
});

// ── el aviso de espera ────────────────────────────────────────────────────────────────────────────────────────────

// lo mínimo que team-repos.json necesita para ser válido (nombres inventados)
const BASE = { version: 1, public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' }, operations: { platform: 'github', org: 'acme', repo: 'o' } };
function arbol(waitNotice) {
  const dir = temporal('org-switches-tree-');
  if (waitNotice !== undefined) fs.writeFileSync(path.join(dir, 'team-repos.json'), JSON.stringify(Object.assign({}, BASE, { wait_notice: waitNotice })));
  return dir;
}

test('T12 aviso de espera: sin clave corre como hoy; la org lo apaga; la variable gana; una clave ilegible no lo apaga', () => {
  assert.deepStrictEqual(WN.noticeEnabled({ env: {}, tree: arbol() }), { on: true, problem: null });
  assert.deepStrictEqual(WN.noticeEnabled({ env: {}, tree: arbol({ minutes: 7 }) }), { on: true, problem: null });
  assert.deepStrictEqual(WN.noticeEnabled({ env: {}, tree: arbol({ enabled: false }) }), { on: false, problem: null });
  assert.deepStrictEqual(WN.noticeEnabled({ env: {}, tree: arbol({ enabled: true }) }), { on: true, problem: null });
  assert.strictEqual(WN.noticeEnabled({ env: { TYCON_WAIT_NOTICE: '1' }, tree: arbol({ enabled: false }) }).on, true);
  assert.strictEqual(WN.noticeEnabled({ env: { TYCON_WAIT_NOTICE: '0' }, tree: arbol({ enabled: true }) }).on, false);
  const roto = WN.noticeEnabled({ env: {}, tree: arbol({ enabled: 'no' }) });
  assert.strictEqual(roto.on, true);
  assert.match(String(roto.problem), /wait_notice\.enabled/);
  // el plazo sigue leyéndose igual con la clave nueva al lado
  assert.strictEqual(WN.thresholdMs({ env: {}, tree: arbol({ minutes: 9, enabled: false }) }).ms, 9 * 60000);
});

test('T13 team-repos.json: wait_notice.enabled es true o false, y otro valor se nombra sin tirar el archivo', () => {
  assert.strictEqual(TR.parse(JSON.stringify(Object.assign({}, BASE, { wait_notice: { enabled: false } }))).ok, true);
  const r = TR.parse(JSON.stringify(Object.assign({}, BASE, { wait_notice: { enabled: 'sí' } })));
  assert.ok(r.sectionProblems && r.sectionProblems.wait_notice && r.sectionProblems.wait_notice[0].path === 'wait_notice.enabled');
});
