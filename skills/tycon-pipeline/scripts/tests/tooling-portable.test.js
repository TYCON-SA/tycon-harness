'use strict';

/**
 * tooling-portable.test.js — las herramientas del pipeline se buscan y se lanzan igual en los tres sistemas (story 8.17
 * del arnés, tanda W6 · T72, AC 48).
 *
 * LOS DOS AGUJEROS QUE CIERRA.
 *   · `pipeline.js tooling-expected` buscaba cada herramienta con la ruta fija `/usr/bin/which`. En Windows ese
 *     programa no existe: todas salían «no está», también las instaladas, y el pipeline mandaba a instalar lo que ya
 *     estaba. Ahora se busca con `where` en Windows y con `which` (por el PATH, sin ruta fija) en Mac y Linux.
 *   · `marker.js run-check <check> -- bash …` lanzaba `bash` por su nombre. En Windows el primero del PATH puede ser
 *     el lanzador de WSL (abre una distribución de Linux que no ve una ruta `C:/…`, o no está instalada). Ahora un
 *     `bash` en Windows se lanza con el que devuelve `findGitBash()` del arnés (`scripts/lib/git-bash.js`); si no hay,
 *     el check sale rojo con el motivo, nunca con otro bash.
 *   · Pase adversarial de la W6: en Windows `npx` es un `.cmd` que Node no lanza sin shell (ahora va por el bash de
 *     Git, y `canLaunch()` —lo que mira test-gate.sh antes de la salida 5— lo ve igual); una ruta absoluta sin `.exe`
 *     salía «no está»; y estas pruebas no estaban en scripts/tests/suites.json.
 *
 * La plataforma se inyecta: se mide la lógica, no el sistema (lo que sólo se ve en Windows lo mide el agente).
 * 🔴 Nada acá toca el HOME real: el caso de la línea de comandos corre con un HOME propio.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/tooling-portable.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const HARNESS = path.resolve(SCRIPTS, '..', '..', '..');
const portable = require(path.join(SCRIPTS, 'lib', 'portable-tools.js'));
const { computeToolingExpected } = require(path.join(SCRIPTS, 'pipeline.js'));

/** Un `execFileSync` de mentira: anota cada llamada y contesta según la herramienta pedida. */
function fakeExec(answers) {
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    const a = answers[args[0]];
    if (a === undefined) { const e = new Error('no está'); e.status = 1; throw e; }
    return a;
  };
  return { exec, calls };
}

test('Tooling_FindsToolsOnEveryPlatform_RunCheckUsesGitBash', async (t) => {
  await t.test('tooling-expected: where en Windows, which en Mac y Linux, sin ruta fija', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-portable-'));
    try {
      fs.mkdirSync(path.join(repo, '.codegraph'));
      const cases = [
        { platform: 'win32', finder: 'where', out: 'C:\\tools\\codegraph.exe\r\nC:\\tools\\codegraph.cmd\r\n', found: 'C:\\tools\\codegraph.exe' },
        { platform: 'darwin', finder: 'which', out: '/opt/homebrew/bin/codegraph\n', found: '/opt/homebrew/bin/codegraph' },
        { platform: 'linux', finder: 'which', out: '/usr/local/bin/codegraph\n', found: '/usr/local/bin/codegraph' },
      ];
      for (const c of cases) {
        const { exec, calls } = fakeExec({ codegraph: c.out });
        const r = computeToolingExpected(repo, { integrations: null, platform: c.platform, exec });
        const cg = r.expected.find((e) => e.name === 'codegraph');
        assert.strictEqual(cg.binary_found, c.found, `${c.platform}: la primera ubicación que dio ${c.finder}`);
        const engram = r.expected.find((e) => e.name === 'engram');
        assert.strictEqual(engram.binary_found, null, `${c.platform}: la que no está, null`);
        assert.ok(calls.length >= 2, `${c.platform}: buscó las herramientas (${calls.length} llamadas)`);
        for (const call of calls) assert.strictEqual(call[0], c.finder, `${c.platform}: buscó con ${call[0]}, no con ${c.finder}`);
      }
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
    assert.ok(!fs.readFileSync(path.join(SCRIPTS, 'pipeline.js'), 'utf8').includes('/usr/bin/which'), 'pipeline.js no nombra /usr/bin/which');
  });

  await t.test('findBinary: una ruta absoluta se mira en el disco; la salida vacía es «no está»', () => {
    assert.strictEqual(portable.whichCommand('win32'), 'where');
    assert.strictEqual(portable.whichCommand('darwin'), 'which');
    assert.strictEqual(portable.whichCommand('linux'), 'which');
    const { exec, calls } = fakeExec({ vacia: '\r\n' });
    assert.strictEqual(portable.findBinary('vacia', { platform: 'win32', exec }), null);
    assert.strictEqual(portable.findBinary('C:\\x\\tool.exe', { platform: 'win32', exec, exists: (p) => p === 'C:\\x\\tool.exe' }), 'C:\\x\\tool.exe');
    assert.strictEqual(portable.findBinary('/no/such/tool', { platform: 'linux', exec, exists: () => false }), null);
    assert.strictEqual(portable.findBinary('', { platform: 'linux', exec }), null);
    assert.strictEqual(calls.length, 1, 'una ruta absoluta no se busca en el PATH');
  });

  await t.test('run-check en Windows: bash es el de findGitBash()', () => {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const found = () => ({ path: gitBash, source: 'default', reason: null });
    for (const name of ['bash', 'bash.exe', 'BASH.EXE']) {
      const l = portable.runCheckLaunch([name, 'scripts/e2e.sh', 'web', '1.1'], { platform: 'win32', findGitBash: found });
      assert.deepStrictEqual([l.file, l.args, l.error], [gitBash, ['scripts/e2e.sh', 'web', '1.1'], null], `«${name}» se lanza con el bash de Git`);
    }
    // otro programa, o bash fuera de Windows: tal cual
    assert.deepStrictEqual(portable.runCheckLaunch(['node', 'x.js'], { platform: 'win32', findGitBash: found }), { file: 'node', args: ['x.js'], error: null });
    assert.deepStrictEqual(portable.runCheckLaunch(['bash', 'x.sh'], { platform: 'linux', findGitBash: () => { throw new Error('no se pregunta'); } }), { file: 'bash', args: ['x.sh'], error: null });
    assert.deepStrictEqual(portable.runCheckLaunch(['bash', 'x.sh'], { platform: 'darwin' }), { file: 'bash', args: ['x.sh'], error: null });
    // sin bash de Git: no se lanza ningún otro bash; el motivo llega al check
    const none = portable.runCheckLaunch(['bash', 'x.sh'], { platform: 'win32', findGitBash: () => ({ path: null, reason: 'falta Git for Windows: no hay git en el PATH' }) });
    assert.strictEqual(none.file, null, 'sin bash de Git no se lanza el lanzador de WSL');
    assert.match(none.error, /bash de Git for Windows/);
    assert.match(none.error, /falta Git for Windows: no hay git en el PATH/, 'el motivo de findGitBash() llega entero');
  });

  await t.test('run-check en Windows: la búsqueda es la del arnés (scripts/lib/git-bash.js)', () => {
    const want = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const l = portable.runCheckLaunch(['bash', 'x.sh'], {
      platform: 'win32', harnessDir: HARNESS,
      env: { PATH: 'C:\\Windows\\System32', ProgramFiles: 'C:\\Program Files' },
      exists: (p) => p === want || p === 'C:\\Windows\\System32\\bash.exe',
    });
    assert.deepStrictEqual([l.file, l.error], [want, null], 'el de Git, no el lanzador de WSL de System32');
    const lost = portable.runCheckLaunch(['bash', 'x.sh'], { platform: 'win32', harnessDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sin-arnes-')) });
    assert.strictEqual(lost.file, null);
    assert.match(lost.error, /git-bash\.js/, 'un arnés que no trae la búsqueda lo dice');
    const marker = fs.readFileSync(path.join(SCRIPTS, 'marker.js'), 'utf8');
    assert.match(marker, /runCheckLaunch\(/, 'marker.js run-check lanza por runCheckLaunch()');
  });

  await t.test('run-check en esta máquina: el código de salida del comando, como siempre', (t2) => {
    if (process.platform === 'win32') { t2.skip('en Windows lo mide el agente'); return; }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-portable-home-'));
    try {
      const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'marker.js'), 'run-check', 'build', '--', 'bash', '-c', 'echo hola; exit 3'], {
        encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, CLAUDE_CODE_SESSION_ID: 'tooling-portable' },
      });
      assert.strictEqual(r.status, 3, `salió ${r.status}: ${r.stderr}`);
      assert.match(r.stdout, /hola/);
      assert.match(r.stdout, /check build: red:exit=3/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

// ── Pase adversarial de la W6 (hallazgos #1, #2, #8): en Windows `npx` es `npx.cmd`, y Node no lanza un `.cmd` sin
// shell. run-check lo lanzaba tal cual: vitest y jest nunca corrían y el gate daba un rojo con totales vacíos. ──
test('Tooling_WindowsCmdShim_LaunchedThroughGitBash_AndCanLaunchSeesIt', async (t) => {
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const found = () => ({ path: gitBash, source: 'default', reason: null });
  // El Node del instalador oficial: `npx.cmd` y el guion `npx` sin extensión (el que ve Git Bash); ningún `npx.exe`.
  const nodeDir = 'C:\\Program Files\\nodejs';
  const disco = new Set([`${nodeDir}\\npx.cmd`, `${nodeDir}\\npx`, `${nodeDir}\\node.exe`, 'C:\\tools\\solo.bat', 'C:\\tools\\dotnet.exe']);
  const exists = (p) => disco.has(p);
  const env = { Path: `C:\\Windows\\System32;${nodeDir};C:\\tools`, PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS' };
  const ctx = { platform: 'win32', findGitBash: found, env, exists };

  await t.test('npx (sólo .cmd): se lanza por el bash de Git, con cada argumento tal cual', () => {
    const l = portable.runCheckLaunch(['npx', 'vitest', 'run', '--outputFile', 'C:/r & x/%TEMP%/v.json'], ctx);
    assert.strictEqual(l.error, null);
    assert.strictEqual(l.file, gitBash, 'no se lanza npx sin shell (ENOENT en Windows)');
    // el guion sin extensión que deja npm al lado del .cmd: un sh que llama a node, sin pasar por cmd.exe
    assert.deepStrictEqual(l.args, ['-c', 'exec "$0" "$@"', 'C:/Program Files/nodejs/npx', 'vitest', 'run', '--outputFile', 'C:/r & x/%TEMP%/v.json']);
  });

  await t.test('un .cmd o .bat sin guion al lado, o nombrado con su extensión: también por el bash de Git', () => {
    const solo = portable.runCheckLaunch(['solo', 'a'], ctx);
    assert.deepStrictEqual([solo.file, solo.args], [gitBash, ['-c', 'exec "$0" "$@"', 'C:/tools/solo.bat', 'a']]);
    const explicito = portable.runCheckLaunch(['npx.cmd', 'jest'], ctx);
    assert.deepStrictEqual([explicito.file, explicito.args], [gitBash, ['-c', 'exec "$0" "$@"', 'C:/Program Files/nodejs/npx', 'jest']]);
  });

  await t.test('un .exe del PATH se lanza tal cual, como siempre', () => {
    assert.deepStrictEqual(portable.runCheckLaunch(['dotnet', 'test'], ctx), { file: 'dotnet', args: ['test'], error: null });
    assert.deepStrictEqual(portable.runCheckLaunch(['node', 'x.js'], ctx), { file: 'node', args: ['x.js'], error: null });
  });

  await t.test('un .cmd sin bash de Git: no se lanza, y el motivo lo dice', () => {
    const l = portable.runCheckLaunch(['npx', 'vitest'], { ...ctx, findGitBash: () => ({ path: null, reason: 'falta Git for Windows' }) });
    assert.strictEqual(l.file, null);
    assert.match(l.error, /npx/);
    assert.match(l.error, /falta Git for Windows/);
  });

  await t.test('canLaunch: lo que test-gate.sh mira antes de la salida 5 es lo mismo que lanza run-check', () => {
    assert.deepStrictEqual(portable.canLaunch('npx', ctx), { ok: true, reason: null }, 'npx.cmd con bash de Git: se puede');
    assert.deepStrictEqual(portable.canLaunch('dotnet', ctx), { ok: true, reason: null });
    const sinBash = portable.canLaunch('npx', { ...ctx, findGitBash: () => ({ path: null, reason: 'falta Git for Windows' }) });
    assert.strictEqual(sinBash.ok, false, 'npx.cmd sin bash de Git: run-check no lo lanzaría');
    assert.match(sinBash.reason, /falta Git for Windows/);
    const nada = portable.canLaunch('npx', { ...ctx, exists: () => false });
    assert.strictEqual(nada.ok, false, 'sin .exe ni .cmd en el PATH');
    assert.match(nada.reason, /npx/);
    // fuera de Windows: un archivo del PATH que no se puede ejecutar no cuenta (bash `command -v` sí lo cuenta)
    const posix = { platform: 'linux', env: { PATH: '/x/bin:/usr/bin' }, exists: (p) => p === '/x/bin/npx', executable: () => false };
    assert.strictEqual(portable.canLaunch('npx', posix).ok, false);
    assert.strictEqual(portable.canLaunch('npx', { ...posix, executable: (p) => p === '/x/bin/npx' }).ok, true);
  });

  await t.test('por la línea de comandos: can-launch sale 0 si se puede lanzar y 1 con el motivo si no', () => {
    const lib = path.join(SCRIPTS, 'lib', 'portable-tools.js');
    const si = spawnSync(process.execPath, [lib, 'can-launch', 'node'], { encoding: 'utf8' });
    assert.strictEqual(si.status, 0, si.stderr);
    const no = spawnSync(process.execPath, [lib, 'can-launch', 'acme-no-existe-xyz'], { encoding: 'utf8' });
    assert.strictEqual(no.status, 1);
    assert.match(no.stderr, /acme-no-existe-xyz/);
  });
});

// ── Pase adversarial de la W6 (hallazgo #12): esta prueba (T72) y la de tmp-path.js (T71) no estaban en
// scripts/tests/suites.json, así que ni el nocturno ni el portón del PR las corrían. ──
test('Tooling_W6Suites_RegisteredInSuitesJson', (t) => {
  const suites = path.join(HARNESS, 'scripts', 'tests', 'suites.json');
  if (!fs.existsSync(suites)) { t.skip(`NO MEDIDO — no está ${suites} (la skill corre fuera del repo del arnés)`); return; }
  const cfg = JSON.parse(fs.readFileSync(suites, 'utf8'));
  const reg = new Set([].concat(cfg.diarias || [], cfg.semanales || []).filter((e) => e && e.raiz === 'agent-skills').map((e) => e.ruta));
  for (const f of ['tooling-portable.test.js', 'tmp-path.test.js', 'test-gate-report.test.js']) {
    const ruta = `tycon-pipeline/scripts/tests/${f}`;
    assert.ok(fs.existsSync(path.join(HARNESS, 'skills', ruta)), `${ruta} no existe`);
    assert.ok(reg.has(ruta), `${ruta} no está en scripts/tests/suites.json: nadie la corre`);
  }
});

// ── Pase adversarial de la W6 (hallazgo #5): una ruta absoluta en Windows no probaba las extensiones. El
// `codebase-memory-mcp` del arnés se declara por su ruta sin `.exe`, y en Windows salía «no está» aunque estuviera. ──
test('Tooling_AbsolutePathOnWindows_TriesExecutableExtensions', async (t) => {
  await t.test('findBinary: la ruta sin extensión encuentra el .exe (y los de PATHEXT)', () => {
    const files = new Set(['C:/Users/x/.local/bin/codebase-memory-mcp.exe', 'C:/Users/x/bin/acme.cmd']);
    const exists = (f) => files.has(f.replace(/\\/g, '/'));
    const exec = () => { throw new Error('una ruta absoluta no se busca en el PATH'); };
    assert.strictEqual(portable.findBinary('C:/Users/x/.local/bin/codebase-memory-mcp', { platform: 'win32', exists, exec }), 'C:/Users/x/.local/bin/codebase-memory-mcp.exe');
    assert.strictEqual(portable.findBinary('C:/Users/x/bin/acme', { platform: 'win32', exists, exec, env: { PATHEXT: '.COM;.EXE;.BAT;.CMD' } }), 'C:/Users/x/bin/acme.cmd');
    assert.strictEqual(portable.findBinary('C:/Users/x/.local/bin/codebase-memory-mcp.exe', { platform: 'win32', exists, exec }), 'C:/Users/x/.local/bin/codebase-memory-mcp.exe');
    assert.strictEqual(portable.findBinary('C:/Users/x/bin/otro', { platform: 'win32', exists, exec }), null);
    // una extensión escrita que no está en PATHEXT (un .ps1) se busca igual: existe, entonces no es «no está»
    const ps1 = (f) => f.replace(/\\/g, '/') === 'C:/Users/x/bin/tool.ps1';
    assert.strictEqual(portable.findBinary('C:/Users/x/bin/tool.ps1', { platform: 'win32', exists: ps1, exec, env: { PATHEXT: '.COM;.EXE;.BAT;.CMD' } }), 'C:/Users/x/bin/tool.ps1');
    // fuera de Windows no se inventan extensiones
    assert.strictEqual(portable.findBinary('/u/x/.local/bin/codebase-memory-mcp', { platform: 'linux', exists: (f) => f.endsWith('.exe'), exec }), null);
  });

  await t.test('tooling-expected en Windows: codebase_memory instalado con .exe sale encontrado', () => {
    const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-portable-cbm-'));
    const homeAntes = process.env.HOME;
    try {
      const home = path.join(lab, 'home');
      const repo = path.join(lab, 'repo');
      fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
      fs.mkdirSync(repo);
      fs.writeFileSync(path.join(home, '.local', 'bin', 'codebase-memory-mcp.exe'), '');
      fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { codebase_memory: { command: 'codebase-memory-mcp.exe' } } }));
      process.env.HOME = home;
      const r = computeToolingExpected(repo, { platform: 'win32', integrations: { engram: false }, exec: () => { throw new Error('no está'); } });
      const e = r.expected.find((x) => x.name === 'codebase_memory');
      assert.ok(e, 'codebase_memory no aparece como esperado');
      assert.strictEqual(e.binary_found, path.join(home, '.local', 'bin', 'codebase-memory-mcp.exe'), e.raise_it);
      assert.doesNotMatch(e.raise_it, /NO está en esta máquina/);
    } finally {
      if (homeAntes === undefined) delete process.env.HOME; else process.env.HOME = homeAntes;
      fs.rmSync(lab, { recursive: true, force: true });
    }
  });
});
