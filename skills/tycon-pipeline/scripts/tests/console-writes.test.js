#!/usr/bin/env node
'use strict';
/**
 * console-writes.test.js — T10 de la story 2.19 del arnés (2026-09-17).
 *
 * QUÉ CUIDA: que la puerta de la consola (`on-bash-write-gate.js`) ANOTE dónde escribe cada comando, en
 * `<estado>/console-writes/<sesión>.jsonl`, para que el archivador sepa en qué repos buscar el cambio
 * de la corrida. Sin esta anotación, un repo que la corrida tocó sólo por consola no se mira nunca: de 297
 * corridas medidas, 123 escribieron en más de un repo.
 *
 * Tres cosas que no pueden pasar, y por eso cada una tiene su caso:
 *  - que anotar cambie la decisión del freno (la anotación es un registro, no un control);
 *  - que la anotación vaya a `file-events/` o al marcador: esos los leen los frenos de ATDD, y una
 *    escritura por consola ahí cambiaría sus veredictos;
 *  - que un estado no escribible rompa el comando.
 *
 * Correr: node --test ~/.claude/agent-skills/skills/tycon-pipeline/scripts/tests/console-writes.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));

function corral() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-'));
  const estado = path.join(raiz, 'estado');
  const trabajo = path.join(raiz, 'trabajo');
  fs.mkdirSync(estado, { recursive: true });
  fs.mkdirSync(trabajo, { recursive: true });
  return { raiz, estado, trabajo };
}

function anotadas(estado, sid) {
  const f = path.join(estado, 'console-writes', `${sid}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}

// rojo previo: la puerta no anota nada → la lista queda vacía.
test('T10a · un sed -i y un heredoc a archivo quedan anotados con ruta absoluta y hora', () => {
  const { raiz, estado, trabajo } = corral();
  const ev = (command) => ({ tool_name: 'Bash', session_id: 'sesion-consola', cwd: trabajo, tool_input: { command } });
  conEnv({ TYCON_NO_RUN_CHANGE: undefined }, () => {
    bash.handle(ev(`sed -i '' 's/a/b/' src/uno.cs`), { stateDir: estado });
    bash.handle(ev(`cd sub && cat > dos.md <<'EOF'\nhola\nEOF`), { stateDir: estado });
  });
  const a = anotadas(estado, 'sesion-consola');
  const rutas = a.map((x) => x.path).sort();
  assert.deepStrictEqual(rutas, [path.join(trabajo, 'src', 'uno.cs'), path.join(trabajo, 'sub', 'dos.md')].sort());
  assert.ok(a.every((x) => Number.isFinite(Date.parse(x.ts))), 'cada anotación trae su hora');
  assert.ok(!fs.existsSync(path.join(estado, 'file-events')), 'NO escribe en file-events/ (lo leen los frenos de ATDD)');
  fs.rmSync(raiz, { recursive: true, force: true });
});

// rojo previo: la puerta hace `return null` antes de extraer cuando los dos frenos están apagados.
test('T10b · con los dos frenos apagados también anota', () => {
  const { raiz, estado, trabajo } = corral();
  conEnv({ TYCON_STORY_GATE: 'off', TYCON_STORY_SKILL_GATE: 'off', TYCON_NO_RUN_CHANGE: undefined }, () => {
    const r = bash.handle({ tool_name: 'Bash', session_id: 's-off', cwd: trabajo, tool_input: { command: 'echo x > salida.ts' } }, { stateDir: estado });
    assert.strictEqual(r, null, 'con los frenos apagados la decisión sigue siendo dejar pasar');
  });
  assert.deepStrictEqual(anotadas(estado, 's-off').map((x) => x.path), [path.join(trabajo, 'salida.ts')]);
  fs.rmSync(raiz, { recursive: true, force: true });
});

// Mutación que lo pone rojo: ignorar la variable de apagado.
test('T10c · TYCON_NO_RUN_CHANGE=1 no anota', () => {
  const { raiz, estado, trabajo } = corral();
  conEnv({ TYCON_NO_RUN_CHANGE: '1' }, () => {
    bash.handle({ tool_name: 'Bash', session_id: 's-apagado', cwd: trabajo, tool_input: { command: 'echo x > a.ts' } }, { stateDir: estado });
  });
  assert.deepStrictEqual(anotadas(estado, 's-apagado'), []);
  fs.rmSync(raiz, { recursive: true, force: true });
});

// La decisión no cambia: mismo comando, con y sin anotar. Y un estado que es un ARCHIVO (no se puede
// crear la carpeta) no rompe nada. Mutación: dejar que el error de escritura se propague → rojo.
test('T10d · anotar no cambia la decisión y un estado no escribible no rompe', () => {
  const { raiz, estado, trabajo } = corral();
  const ev = { tool_name: 'Bash', session_id: 's-decision', cwd: trabajo, tool_input: { command: 'echo x > a.ts' } };
  const con = conEnv({ TYCON_NO_RUN_CHANGE: undefined }, () => bash.handle(ev, { stateDir: estado }));
  const sin = conEnv({ TYCON_NO_RUN_CHANGE: '1' }, () => bash.handle(ev, { stateDir: estado }));
  assert.deepStrictEqual(con, sin, 'anotar no puede cambiar lo que decide el freno');
  const archivo = path.join(raiz, 'estado-es-archivo');
  fs.writeFileSync(archivo, 'no soy una carpeta');
  let r;
  // la falla queda en hook-errors.log de la HOME (tanda D2): una HOME de juguete, nunca la real
  assert.doesNotThrow(() => { r = conEnv({ TYCON_NO_RUN_CHANGE: undefined, HOME: raiz }, () => bash.handle(ev, { stateDir: archivo })); });
  assert.deepStrictEqual(r, sin, 'con el estado roto la decisión es la misma');
  assert.ok(fs.existsSync(path.join(raiz, '.claude', '.tycon-pipeline', 'hook-errors.log')), 'y la falla al anotar queda dicha');
  fs.rmSync(raiz, { recursive: true, force: true });
});

// Story 8.9 del arnés, tanda D2: la carpeta tenía nombre en castellano. La primera anotación con el nombre nuevo se
// lleva la carpeta vieja entera (las otras sesiones también) y deja la vieja intacta. Corre en un proceso aparte con una
// HOME de juguete: la carpeta por defecto se calcula al cargar el módulo. El nombre viejo sale de la tabla del puente.
// Rojo previo: anotar en la nueva sin llevarse la vieja → lo de la otra sesión no está en la nueva.
const { OWN_STATES } = require(path.join(SCRIPTS, 'lib', 'legacy-names.js'));
function migrarEnHome(env) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-home-'));
  const trabajo = path.join(home, 'trabajo');
  const est = path.join(home, '.claude', '.tycon-pipeline');
  const vieja = path.join(est, OWN_STATES['console-writes']);
  fs.mkdirSync(trabajo, { recursive: true });
  fs.mkdirSync(vieja, { recursive: true });
  const otra = '{"path":"/otra/sesion.js","ts":"2026-10-01T00:00:00.000Z"}\n';
  fs.writeFileSync(path.join(vieja, 'otra-sesion.jsonl'), otra);
  const code = `require(${JSON.stringify(path.join(SCRIPTS, 'on-bash-write-gate.js'))}).handle({ tool_name: 'Bash', session_id: 's-d2', cwd: ${JSON.stringify(trabajo)}, tool_input: { command: 'echo x > a.ts' } });`;
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_')) base[k] = v;
  const r = require('child_process').spawnSync(process.execPath, ['-e', code], { env: { ...base, HOME: home, TYCON_STORY_GATE: 'off', TYCON_STORY_SKILL_GATE: 'off', ...env }, encoding: 'utf8' });
  return { home, est, vieja, otra, trabajo, r };
}
test('T10e · sin arnés: la primera anotación se lleva la carpeta vieja entera y la deja intacta', () => {
  const { home, est, vieja, otra, trabajo, r } = migrarEnHome({});
  assert.strictEqual(r.status, 0, r.stderr);
  const nueva = path.join(est, 'console-writes');
  assert.strictEqual(fs.readFileSync(path.join(nueva, 'otra-sesion.jsonl'), 'utf8'), otra, 'lo de la otra sesión pasó a la nueva');
  assert.deepStrictEqual(anotadas(est, 's-d2').map((x) => x.path), [path.join(trabajo, 'a.ts')], 'la anotación nueva va a la nueva');
  assert.deepStrictEqual(fs.readdirSync(vieja), ['otra-sesion.jsonl'], 'la vieja queda como estaba');
  assert.strictEqual(fs.readFileSync(path.join(vieja, 'otra-sesion.jsonl'), 'utf8'), otra);
  fs.rmSync(home, { recursive: true, force: true });
});
// Con el arnés al día (TYCON_GUIDES_DIR o el enlace de la máquina), el puente usa su biblioteca: la misma migración y
// el uso anotado. Sin un arnés con la tanda D2, se saltea con motivo.
const ARNES = (() => {
  const cands = [process.env.TYCON_GUIDES_DIR, path.join(os.homedir(), '.claude', 'tycon-harness'), path.join(os.homedir(), '.claude', 'tycon-claude-guides')].filter(Boolean);
  return cands.find((d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'scripts', 'lib', 'renames.json'), 'utf8')).entries.some((e) => e.batch === 'D2'); } catch (_) { return false; } }) || null;
})();
test('T10f · con el arnés al día: misma migración, por su biblioteca, y con el uso anotado', { skip: !ARNES && 'sin un arnés con la tanda D2 (TYCON_GUIDES_DIR)' }, () => {
  const { home, est, vieja, otra, r } = migrarEnHome({ TYCON_GUIDES_DIR: ARNES });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(est, 'console-writes', 'otra-sesion.jsonl'), 'utf8'), otra);
  assert.ok(fs.existsSync(path.join(vieja, 'otra-sesion.jsonl')), 'la vieja queda');
  const usos = fs.readFileSync(path.join(est, 'legacy-names.jsonl'), 'utf8');
  assert.ok(usos.includes(OWN_STATES['console-writes']), 'la biblioteca del arnés anotó el uso del nombre viejo');
  const mapa = JSON.parse(fs.readFileSync(path.join(ARNES, 'scripts', 'lib', 'renames.json'), 'utf8')).entries;
  const e = mapa.find((x) => x.kind === 'state-file' && /\/console-writes$/.test(x.new));
  assert.ok(e && e.old.endsWith(`/${OWN_STATES['console-writes']}`), 'la tabla del puente dice lo mismo que el mapa');
  fs.rmSync(home, { recursive: true, force: true });
});

// Pase adversarial de la D2 (traversal-completeness-1): con agent-skills al día y el arnés de la máquina ANTERIOR a la
// D2, quien lee la carpeta (run-change.js de ese arnés) mira sólo la vieja. Migrar ahí dejaría las anotaciones donde
// nadie las lee: se sigue escribiendo en la vieja hasta que el arnés conozca el nombre nuevo. Rojo previo: el puente
// caía a su tabla propia, migraba y escribía en la nueva.
function arnesAnteriorALaD2() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'arnes-pre-d2-'));
  fs.mkdirSync(path.join(d, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/sh\n');
  // una biblioteca de nombres viejos de antes de la D2: lee variables, no conoce oldPathOf ni carpetas
  fs.writeFileSync(path.join(d, 'scripts', 'lib', 'legacy-names.js'),
    "'use strict';\nmodule.exports = { readEnv: (n, o = {}) => (o.env || process.env)[n], envNames: (n) => [n], prepareStateWrite: (p) => p };\n");
  return d;
}
test('T10g · con el arnés anterior a la D2: se sigue anotando en la carpeta vieja, sin migrar', () => {
  const arnes = arnesAnteriorALaD2();
  const { home, est, vieja, otra, trabajo, r } = migrarEnHome({ TYCON_GUIDES_DIR: arnes });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(est, 'console-writes')), 'no se crea la carpeta nueva: el lector de ese arnés no la mira');
  const anotadasViejas = fs.readFileSync(path.join(vieja, 's-d2.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepStrictEqual(anotadasViejas.map((x) => x.path), [path.join(trabajo, 'a.ts')], 'la anotación va a la vieja, donde la lee ese arnés');
  assert.strictEqual(fs.readFileSync(path.join(vieja, 'otra-sesion.jsonl'), 'utf8'), otra);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(arnes, { recursive: true, force: true });
});

// Revisor de fallos silenciosos (SILENT-C1): si la migración falla, queda en hook-errors.log y la anotación no se pierde:
// va a la carpeta vieja (el lector de la D2 lee las dos). Rojo previo: un solo catch mudo, sin rastro ni anotación.
test('T10h · si la carpeta vieja no se puede llevar: rastro en hook-errors.log y la anotación va a la vieja', { skip: (typeof process.getuid === 'function' && process.getuid() === 0) && 'como root los permisos no frenan' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-home-'));
  const est = path.join(home, '.claude', '.tycon-pipeline');
  const vieja = path.join(est, OWN_STATES['console-writes']);
  const trabajo = path.join(home, 'trabajo');
  fs.mkdirSync(trabajo, { recursive: true });
  fs.mkdirSync(vieja, { recursive: true });
  const cerrado = path.join(vieja, 'otra-sesion.jsonl');
  fs.writeFileSync(cerrado, '{"path":"/x","ts":"2026-10-01T00:00:00.000Z"}\n');
  fs.chmodSync(cerrado, 0o000);
  try {
    const code = `require(${JSON.stringify(path.join(SCRIPTS, 'on-bash-write-gate.js'))}).handle({ tool_name: 'Bash', session_id: 's-err', cwd: ${JSON.stringify(trabajo)}, tool_input: { command: 'echo x > a.ts' } });`;
    const base = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_')) base[k] = v;
    const r = require('child_process').spawnSync(process.execPath, ['-e', code], { env: { ...base, HOME: home, TYCON_STORY_GATE: 'off', TYCON_STORY_SKILL_GATE: 'off' }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(est, 'hook-errors.log'), 'utf8'), /console-writes/, 'la falla queda en hook-errors.log');
    const anot = fs.readFileSync(path.join(vieja, 's-err.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepStrictEqual(anot.map((x) => x.path), [path.join(trabajo, 'a.ts')], 'la anotación no se pierde: va a la vieja');
  } finally { fs.chmodSync(cerrado, 0o644); fs.rmSync(home, { recursive: true, force: true }); }
});
