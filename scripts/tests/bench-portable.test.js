'use strict';
/**
 * bench-portable.test.js — el banco de controles corre también en Windows, y en Linux y en Mac no cambia nada
 * (story 8.17, tanda W1).
 *
 * EL CASO. El banco aislaba cada caso con una `HOME` temporal y preparaba los casos con el shell por defecto. En
 * Windows las dos cosas fallan sin avisar: `os.homedir()` mira `USERPROFILE` (con `HOME` sola, cada hook escribía en
 * la carpeta de usuario real), y el shell por defecto es `cmd.exe`, que no entiende `mkdir -p`. Y `bash` a secas
 * puede ser el lanzador de WSL. El banco es la herramienta con la que se mide si un control frena: si no corre en
 * Windows, de Windows no se sabe nada.
 *
 * QUÉ FIJA
 *   · fuera de Windows, el entorno de cada caso y el comando con que se lanza son, clave por clave, los de siempre;
 *   · con Windows inyectado: el caso ve la carpeta de laboratorio por `USERPROFILE`, la preparación y los hooks de
 *     bash van por el bash que encontró `findGitBash()`, y sin ese bash el banco dice «NO MEDIDO: falta Git for
 *     Windows», sale 2 y no imprime ningún verde;
 *   · la línea de base se escribe y se compara igual (sobre un banco de juguete: el banco entero se compara a mano);
 *   · el marcador de `live-fire.js` es un guion de Node, no un `.sh`;
 *   · las tres formas de una ruta de Windows, y que `missing-path-notice.js` no le pide la carpeta de usuario a la
 *     variable `HOME` (con un testigo sobre el entorno del proceso, no leyendo el fuente);
 *   · un caso que no se pudo medir vuelve «no medido», y el auditor de vacuidad no lo cuenta como «prueba algo».
 *
 * La plataforma se inyecta por parámetro (`ctx.platform`): no se toca `process.platform`. No usa bash para armar
 * nada; el bash que lanza es el que el propio banco encuentra. En un Windows de verdad no inyecta: mide el real.
 *
 * Correr:   node scripts/tests/bench-portable.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(REPO, 'scripts', 'controls-bench', 'runner.js');
const LIVE_FIRE = path.join(REPO, 'scripts', 'controls-bench', 'live-fire.js');
const NOTICE = path.join(REPO, 'scripts', 'hooks', 'missing-path-notice.js');
const VACUITY = path.join(REPO, 'scripts', 'controls-bench', 'vacuity-audit.js');
const { findGitBash, ENV_VAR } = require('../lib/git-bash.js');
const runner = require(RUNNER);

const ON_WINDOWS = process.platform === 'win32';
const temporaries = [];
function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(d);
  return d;
}

// Un hook de Node que cuenta qué carpeta de usuario ve. No imprime rutas: compara y dice.
const PROBE_HOOK = [
  "'use strict';",
  "const os = require('os');",
  "require('fs').readFileSync(0);",
  "const same = (a, b) => Boolean(a) && Boolean(b) && String(a) === String(b);",
  "const lab = process.env.SANDBOX_HOME;",
  "console.log(same(process.env.USERPROFILE, lab) ? 'USERPROFILE-IS-LAB' : ('USERPROFILE' in process.env ? 'USERPROFILE-IS-OTHER' : 'USERPROFILE-UNSET'));",
  "console.log(same(process.env.HOME, lab) ? 'HOME-IS-LAB' : 'HOME-IS-OTHER');",
  "console.log(same(os.homedir(), lab) ? 'HOMEDIR-IS-LAB' : 'HOMEDIR-IS-OTHER');",
  "console.log(same(process.env.USERPROFILE, process.env.HOME) ? 'USERPROFILE-FOLLOWS-HOME' : 'USERPROFILE-APART-FROM-HOME');",
  "console.log(process.env.CLAUDE_CODE_GIT_BASH_PATH ? 'GIT-BASH-GIVEN' : 'GIT-BASH-NOT-GIVEN');",
  '',
].join('\n');
const SHELL_HOOK = ['#!/usr/bin/env bash', 'cat > /dev/null', 'echo "SHELL-HOOK-RAN"', 'exit 0', ''].join('\n');

/**
 * Un Windows inyectado sobre esta máquina: la plataforma dice `win32` y el bash «de Git» es un testigo que anota
 * cada vez que lo llaman y le pasa el trabajo al bash de verdad. En un Windows real no hace falta: devuelve `undefined`
 * (el banco usa lo que encuentre) y `calls()` devuelve `null` (no hay testigo que leer).
 */
function injectedWindows() {
  if (ON_WINDOWS) return { ctx: undefined, calls: () => null };
  const dir = tempDir('tycon-bench-witness-');
  const log = path.join(dir, 'calls.log');
  const real = findGitBash().path;
  assert.ok(real, 'esta máquina tiene un bash con el que hacer de testigo');
  const witness = path.join(dir, 'bash-witness');
  fs.writeFileSync(witness, [
    '#!/usr/bin/env node',
    "'use strict';",
    "const { spawnSync } = require('child_process');",
    `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    `const r = spawnSync(${JSON.stringify(real)}, process.argv.slice(2), { stdio: 'inherit' });`,
    'process.exit(r.status === null ? 1 : r.status);',
    '',
  ].join('\n'));
  fs.chmodSync(witness, 0o755);
  return {
    ctx: { platform: 'win32', env: { ...process.env, [ENV_VAR]: witness } },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    witness,
  };
}

function hookFiles() {
  const dir = tempDir('tycon-bench-hooks-');
  const probe = path.join(dir, 'probe.js');
  const shell = path.join(dir, 'shell-hook.sh');
  fs.writeFileSync(probe, PROBE_HOOK);
  fs.writeFileSync(shell, SHELL_HOOK);
  return { dir, probe, shell };
}

// ── T19 · AC 14, 18 ───────────────────────────────────────────────────────────────────────────────────────────────
test('T19a Bench_Portable_PosixUnchanged — fuera de Windows, el entorno de un caso y su comando son los de siempre', () => {
  const vars = { TCG: '/repo', SKILLS: '/skills', SANDBOX_HOME: '/tmp/s/home', FIXTURE: '/tmp/s/fixture' };
  for (const platform of ['linux', 'darwin']) {
    const env = runner.isolationEnv({ sandbox: '/tmp/s', vars, ctx: { platform, env: { PATH: '/usr/bin:/bin', USERPROFILE: 'X', Path: 'no' } } });
    assert.deepStrictEqual(env, {
      PATH: '/usr/bin:/bin', HOME: '/tmp/s/home', TMPDIR: '/tmp/s', TCG: '/repo', SKILLS: '/skills', GIT_CONFIG_NOSYSTEM: '1',
      FIXTURE: '/tmp/s/fixture', SANDBOX_HOME: '/tmp/s/home', TYCON_GUIDES_DIR: '/repo', LANG: 'en_US.UTF-8',
    }, `${platform}: ni una clave de más, ni una de menos`);
    assert.deepStrictEqual(runner.setupEnv({ ...vars, HOME: vars.SANDBOX_HOME }, { platform }), {
      GIT_CONFIG_NOSYSTEM: '1', HOME: '/tmp/s/home', TCG: '/repo', SKILLS: '/skills', FIXTURE: '/tmp/s/fixture', SANDBOX_HOME: '/tmp/s/home',
    }, `${platform}: la preparación recibe lo de siempre`);
    assert.strictEqual(runner.forBash(env, { platform }), env, `${platform}: lo que va a un hook de bash es el mismo entorno, sin tocar`);
    assert.strictEqual(runner.sandboxRoot({ platform, realpath: () => '/otra' }), os.tmpdir(), `${platform}: los sandboxes nacen en os.tmpdir(), tal cual`);
    assert.strictEqual(runner.fileVars('_marker.json', vars, { platform }), vars, `${platform}: lo que se escribe en un archivo del caso lleva las rutas de siempre`);
    assert.deepStrictEqual(runner.interpreterFor('/x/hook.sh', { platform }), ['bash', '/x/hook.sh'], `${platform}: un .sh corre con «bash», por su nombre`);
    assert.deepStrictEqual(runner.interpreterFor('/x/hook.js', { platform }), [process.execPath, '/x/hook.js']);
    assert.deepStrictEqual(runner.pathShapes('/tmp/s/fixture', platform), { BACKSLASH: '/tmp/s/fixture', SLASH: '/tmp/s/fixture', MSYS: '/tmp/s/fixture' });
  }
});

test('T19b Bench_Portable_WindowsEnv — con Windows inyectado, la carpeta de usuario y el temporal son los del laboratorio', () => {
  const home = 'C:\\lab\\s\\home';
  const vars = { TCG: 'C:\\repo', SKILLS: 'C:\\skills', SANDBOX_HOME: home, FIXTURE: 'C:\\lab\\s\\fixture' };
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const ctx = {
    platform: 'win32',
    env: { Path: 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      USERPROFILE: 'C:\\Users\\dev', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', SECRET_TOKEN: 'x' },
    exists: (p) => [bash.toLowerCase(), 'c:\\program files\\git\\cmd\\git.exe'].includes(String(p).toLowerCase()),
  };
  const env = runner.isolationEnv({ sandbox: 'C:\\lab\\s', vars, ctx });
  assert.strictEqual(env.USERPROFILE, home, 'USERPROFILE es la carpeta de laboratorio');
  assert.strictEqual(env.HOME, home);
  assert.strictEqual(env.APPDATA, `${home}\\AppData\\Roaming`);
  assert.strictEqual(env.LOCALAPPDATA, `${home}\\AppData\\Local`);
  assert.strictEqual(env.TEMP, 'C:\\lab\\s');
  assert.strictEqual(env.TMP, 'C:\\lab\\s');
  assert.strictEqual(env.PATH, ctx.env.Path, 'el PATH se toma aunque Windows lo escriba «Path»');
  assert.strictEqual(env.SystemRoot, 'C:\\Windows', 'las variables de sistema pasan');
  assert.strictEqual(env[ENV_VAR], bash, 'y el bash hallado viaja, para que nadie lo vuelva a buscar');
  assert.ok(!('SECRET_TOKEN' in env), 'lo demás del entorno de la máquina no entra al caso');
  for (const v of Object.values(env)) assert.ok(!String(v).startsWith('C:\\Users\\dev'), `nada apunta a la carpeta de usuario real: ${v}`);
  // 🔴 TODO lo que el banco le pasa a bash —por una variable o por el texto del guion— va con barras hacia adelante.
  // Medido en Windows (corrida 11699): con `TCG=D:\\a\\1\\…`, `cp $TCG/scripts/controls-bench/*.js` no encontraba
  // nada — en una palabra con comodín bash lee cada `\\` como un escape—, y 36 casos fallaban en su preparación.
  assert.deepStrictEqual(runner.setupEnv(vars, ctx), {
    GIT_CONFIG_NOSYSTEM: '1', HOME: 'C:/lab/s/home', USERPROFILE: 'C:/lab/s/home', TCG: 'C:/repo', SKILLS: 'C:/skills',
    FIXTURE: 'C:/lab/s/fixture', SANDBOX_HOME: 'C:/lab/s/home',
    APPDATA: 'C:/lab/s/home/AppData/Roaming', LOCALAPPDATA: 'C:/lab/s/home/AppData/Local', TEMP: 'C:/lab/s', TMP: 'C:/lab/s',
  }, 'la preparación no hereda de la máquina ninguna carpeta de usuario ni el temporal, y ninguna ruta trae una barra invertida');
  // lo mismo para un hook que es un guion de bash: sus variables de ruta, con barras hacia adelante; las de la máquina
  // (el PATH, SystemRoot) y las de un hook de Node, como Windows las da
  const toShell = runner.forBash(env, ctx);
  for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'TCG', 'SKILLS', 'FIXTURE', 'SANDBOX_HOME', 'TYCON_GUIDES_DIR', ENV_VAR]) {
    assert.ok(toShell[k] && !toShell[k].includes('\\'), `${k} va a bash sin barras invertidas: ${toShell[k]}`);
  }
  assert.strictEqual(toShell.FIXTURE, 'C:/lab/s/fixture');
  assert.strictEqual(toShell.PATH, ctx.env.Path, 'el PATH es de Windows: no se toca');
  assert.strictEqual(toShell.SystemRoot, 'C:\\Windows');
  assert.strictEqual(env.FIXTURE, 'C:\\lab\\s\\fixture', 'y no modifica el entorno que recibe: un hook de Node sigue viendo la ruta nativa');
  assert.deepStrictEqual(runner.forBash({ FIXTURE: 'C:\\lab\\s\\fixture', OTRA: 'a\\b' }, ctx, ['FIXTURE', 'OTRA']), { FIXTURE: 'C:/lab/s/fixture', OTRA: 'a/b' });
  // el entorno completo de un hook, con una variable que declara el caso: a bash, con barras hacia adelante; a Node, nativa
  const declares = { hookDef: { env: { DEL_HOOK: '${TCG}/x' } }, caseDef: { env: { PS_FILE: '${FIXTURE}/ps.txt' } } };
  const shellHook = runner.hookEnv({ sandbox: 'C:\\lab\\s', vars, ...declares, bash: true, ctx });
  assert.deepStrictEqual([shellHook.PS_FILE, shellHook.DEL_HOOK, shellHook.FIXTURE, shellHook.USERPROFILE], ['C:/lab/s/fixture/ps.txt', 'C:/repo/x', 'C:/lab/s/fixture', 'C:/lab/s/home']);
  const nodeHook = runner.hookEnv({ sandbox: 'C:\\lab\\s', vars, ...declares, bash: false, ctx });
  assert.deepStrictEqual([nodeHook.PS_FILE, nodeHook.FIXTURE, nodeHook.USERPROFILE], ['C:\\lab\\s\\fixture/ps.txt', 'C:\\lab\\s\\fixture', home]);
  // los sandboxes nacen bajo el temporal por su nombre LARGO: el corto (la carpeta de usuario como `NOMBRE~1`) no es la misma cadena
  // que la que devuelven git y `realpath`, y un control que compara rutas daba rojo por el laboratorio, no por él
  assert.strictEqual(runner.sandboxRoot({ platform: 'win32', tmpdir: 'C:\\Users\\NOMBRE~1\\AppData\\Local\\Temp', realpath: () => 'C:\\Users\\NombreLargo\\AppData\\Local\\Temp' }),
    'C:\\Users\\NombreLargo\\AppData\\Local\\Temp');
  assert.strictEqual(runner.sandboxRoot({ platform: 'win32', tmpdir: 'C:\\Temp', realpath: () => { throw new Error('no'); } }), 'C:\\Temp', 'si no se puede resolver, el de siempre');
  // lo que se escribe en un archivo del caso: en un JSON las barras invertidas van escapadas (si no, el archivo no se
  // puede leer: `"C:\Users"` no es JSON); en lo demás (un guion de bash, un yaml), con barras hacia adelante
  assert.strictEqual(runner.fileVars('_marker.json', vars, ctx).FIXTURE, 'C:\\\\lab\\\\s\\\\fixture');
  assert.strictEqual(runner.fileVars('advisor-runs/x.jsonl', vars, ctx).SANDBOX_HOME, 'C:\\\\lab\\\\s\\\\home');
  assert.strictEqual(runner.fileVars('wrapper.sh', vars, ctx).FIXTURE, 'C:/lab/s/fixture');
  assert.strictEqual(runner.fileVars('.tycon/advisors.yaml', vars, ctx).TCG, 'C:/repo');
  assert.deepStrictEqual(JSON.parse(`{"repoPath":"${runner.fileVars('m.json', vars, ctx).FIXTURE}/src"}`), { repoPath: 'C:\\lab\\s\\fixture/src' }, 'y el JSON que queda se lee, con la ruta nativa adentro');
  assert.deepStrictEqual(runner.interpreterFor('C:\\repo\\scripts\\hooks\\a.sh', ctx), [bash, 'C:/repo/scripts/hooks/a.sh'],
    'un .sh corre con la ruta del bash de Git, nunca con «bash» a secas');
  assert.deepStrictEqual(runner.pathShapes('C:\\lab\\s\\fixture', 'win32'),
    { BACKSLASH: 'C:\\lab\\s\\fixture', SLASH: 'C:/lab/s/fixture', MSYS: '/c/lab/s/fixture' });
  assert.deepStrictEqual(runner.pathShapes('D:/a b/c', 'win32'), { BACKSLASH: 'D:\\a b\\c', SLASH: 'D:/a b/c', MSYS: '/d/a b/c' });
  // sin bash de Git: un .sh no se lanza con otra cosa
  const without = { platform: 'win32', env: { Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' }, exists: (p) => /system32\\bash\.exe$/i.test(p) };
  assert.throws(() => runner.interpreterFor('C:\\repo\\a.sh', without), /NO MEDIDO: falta Git for Windows.*lanzador de WSL/);
  assert.ok(!(ENV_VAR in runner.isolationEnv({ sandbox: 'C:\\lab\\s', vars, ctx: without })));
});

test('T19c Bench_Portable_UserprofileIsolated_SetupThroughGitBash — un caso de verdad, con Windows inyectado', () => {
  const w = injectedWindows();
  const hooks = hookFiles();
  // 1 · un hook de Node, con preparación: la preparación usa lo que sólo bash entiende
  const hook = { hook: 'probe', script: hooks.probe, event: 'PreToolUse' };
  const viaNode = runner.runCase('claude', hook, {
    id: 'sees-lab-folder', type: 'must-emit',
    setup: ['mkdir -p a/b && printf "uno\\n" > a/b/hecho.txt', 'test -f "$FIXTURE/a/b/hecho.txt" && echo dos > "${FIXTURE}/segundo.txt"'],
    stdin: { tool_name: 'Bash', tool_input: { command: 'echo hola' } },
    expect: {
      stdout_re: ['^USERPROFILE-IS-LAB$', '^HOME-IS-LAB$', '^GIT-BASH-GIVEN$', ...(ON_WINDOWS ? ['^HOMEDIR-IS-LAB$'] : [])],
      file_exists: ['${FIXTURE}/a/b/hecho.txt', '${FIXTURE}/segundo.txt'],
    },
  }, w.ctx);
  assert.deepStrictEqual(viaNode.failures, [], 'el caso ve la carpeta de laboratorio por USERPROFILE y su preparación corrió');
  // 2 · un caso que cambia HOME: en Windows USERPROFILE lo sigue (es la que decide la carpeta de usuario)
  const moved = runner.runCase('claude', hook, {
    id: 'home-moved', type: 'must-emit', env: { HOME: '${FIXTURE}/otra-casa' },
    stdin: {}, expect: { stdout_re: ['^USERPROFILE-FOLLOWS-HOME$', '^HOME-IS-OTHER$'] },
  }, w.ctx);
  assert.deepStrictEqual(moved.failures, []);
  // 3 · un hook de bash: lo lanza el bash hallado
  const viaShell = runner.runCase('claude', { hook: 'shell', script: hooks.shell, event: 'PreToolUse' }, {
    id: 'shell-hook-runs', type: 'must-emit', stdin: {}, expect: { stdout_re: ['^SHELL-HOOK-RAN$'] },
  }, w.ctx);
  assert.deepStrictEqual(viaShell.failures, []);
  // el testigo: las dos preparaciones y el hook de bash pasaron por el bash de findGitBash(), cada una por su archivo
  const calls = w.calls();
  if (calls !== null) {   // en un Windows de verdad no hay testigo: que los tres casos den verde es la medición
    assert.strictEqual(calls.length, 3, `tres llamadas al bash hallado: ${JSON.stringify(calls)}`);
    assert.match(calls[0][0], /setup-0\.sh$/);
    assert.match(calls[1][0], /setup-1\.sh$/);
    assert.strictEqual(calls[2][0], hooks.shell);
  }
  // 🔴 En Windows la preparación va por `spawnSync`, que NO tira cuando el comando falla (`execSync` sí): el código de
  // salida lo tiene que mirar el corredor. Una preparación que falla es un rojo que nombra el comando, nunca un caso
  // que sigue de largo con el laboratorio a medio armar.
  const failing = runner.runCase('claude', hook, {
    id: 'setup-fails', type: 'must-emit', setup: ['echo antes-de-fallar >&2; exit 3'], stdin: {}, expect: { stdout_re: ['^HOME-IS-LAB$'] },
  }, w.ctx);
  assert.strictEqual(failing.pass, false, 'una preparación que sale 3 no deja pasar el caso');
  assert.match(failing.failures.join('\n'), /ERROR: Command failed: echo antes-de-fallar >&2; exit 3/, 'y el rojo nombra el comando');
  assert.match(failing.failures.join('\n'), /antes-de-fallar/, 'con lo que el comando dijo por stderr');
  // un comodín pegado a una variable del banco, que es lo que hacen los casos (`cp $TCG/scripts/x/*.js …`)
  const globbing = runner.runCase('claude', hook, {
    id: 'glob-after-a-bench-variable', type: 'must-emit',
    setup: ['mkdir -p origen destino && echo a > origen/uno.js && echo b > origen/dos.js', 'cp $FIXTURE/origen/*.js destino/'],
    stdin: {}, expect: { stdout_re: ['^HOME-IS-LAB$'], file_exists: ['${FIXTURE}/destino/uno.js', '${FIXTURE}/destino/dos.js'] },
  }, w.ctx);
  assert.deepStrictEqual(globbing.failures, [], 'el comodín encuentra los archivos');
  // un caso que declara HOME: su PREPARACIÓN también ve USERPROFILE siguiéndola (no sólo el hook)
  const movedSetup = runner.runCase('claude', hook, {
    id: 'home-moved-in-setup', type: 'must-emit', env: { HOME: '${FIXTURE}/otra-casa' },
    // 🔴 Se compara con Node y por la carpeta, no con `test "$USERPROFILE" = "$HOME"`: en un Windows de verdad el bash de
    // Git reescribe HOME a su forma (`/c/a/b`) y deja USERPROFILE como vino — la misma carpeta, dos cadenas. Así
    // estaba escrito y falló al correr EN Windows (corrida 11699), verde con Windows «inyectado» en una Mac.
    // (`n` deshace también la forma `/c/a/b`, por si bash se la deja a HOME al lanzar a node, y no mira mayúsculas.)
    setup: ['node -e "const p=require(\'path\');const e=process.env;const n=(x)=>p.resolve(String(x).replace(/^[/]([A-Za-z])[/]/,(m,d)=>d+String.fromCharCode(58,47))).toLowerCase();process.exit(n(e.USERPROFILE)===n(e.HOME)&&n(e.HOME)!==n(e.SANDBOX_HOME)?0:1)" && echo sigue > "$FIXTURE/sigue.txt"'],
    stdin: {}, expect: { stdout_re: ['^USERPROFILE-FOLLOWS-HOME$'], file_exists: ['${FIXTURE}/sigue.txt'] },
  }, w.ctx);
  assert.deepStrictEqual(movedSetup.failures, [], 'en la preparación USERPROFILE sigue a la HOME que declara el caso');
  if (calls === null) return;
  // un bash que no se puede lanzar (acá: un archivo sin permiso de ejecución): el error del lanzamiento sale tal cual
  const broken = path.join(tempDir('tycon-bench-broken-'), 'bash-roto');
  fs.writeFileSync(broken, 'no soy un programa\n');
  fs.chmodSync(broken, 0o644);
  const unlaunchable = runner.runCase('claude', hook, { id: 'shell-cannot-start', type: 'must-emit', setup: ['mkdir -p a'], stdin: {}, expect: { stdout_re: ['^HOME-IS-LAB$'] } },
    { platform: 'win32', env: { ...process.env, [ENV_VAR]: broken } });
  assert.strictEqual(unlaunchable.pass, false);
  assert.match(unlaunchable.failures.join('\n'), /ERROR: spawnSync .*bash-roto EACCES/, `el motivo es el del lanzamiento, no un «Command failed» genérico: ${unlaunchable.failures.join(' | ')}`);
  const before = w.calls().length;
  // el control del rojo: SIN inyectar Windows, en esta máquina el testigo no ve nada y USERPROFILE no se fija
  const plain = runner.runCase('claude', hook, {
    id: 'posix-as-always', type: 'must-emit', setup: ['mkdir -p a'], stdin: {},
    expect: { stdout_re: ['^HOME-IS-LAB$', '^HOMEDIR-IS-LAB$', '^GIT-BASH-NOT-GIVEN$'], stdout_not_re: ['USERPROFILE-IS-LAB'] },
  });
  assert.deepStrictEqual(plain.failures, []);
  assert.strictEqual(w.calls().length, before, 'fuera de Windows la preparación no pasa por findGitBash()');
});

test('T19d Bench_Portable_NoGitBash — en Windows sin Git for Windows: «NO MEDIDO», sale 2 y ningún verde', () => {
  const cases = tempDir('tycon-bench-cases-');
  const hooks = hookFiles();
  fs.writeFileSync(path.join(cases, '01-toy.json'), JSON.stringify({
    hook: 'probe', script: hooks.probe, event: 'PreToolUse',
    cases: [{ id: 'would-pass', type: 'must-emit', stdin: {}, expect: { stdout_re: ['HOME-IS-LAB'] } }],
  }));
  const report = path.join(tempDir('tycon-bench-report-'), 'report.json');
  const run = (ctxSource) => spawnSync(process.execPath, ['-e',
    // el corredor lee sus opciones al cargarse, y con `-e` no hay nombre de guion: va un relleno en su lugar
    `process.argv.push('-', '--json', ${JSON.stringify(report)}); const r = require(${JSON.stringify(RUNNER)}); process.exitCode = r.main(${ctxSource});`],
  { encoding: 'utf8', env: { ...process.env, TYCON_BENCH_CASES_DIR: cases } });
  // sin nada
  let r = run("{ platform: 'win32', env: { Path: 'C:\\\\Windows' }, exists: () => false }");
  assert.strictEqual(r.status, 2, `sale 2 (no pude medir), no 0 ni 1: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /NO MEDIDO: falta Git for Windows/);
  assert.doesNotMatch(r.stdout, /✅/, 'ningún verde');
  assert.doesNotMatch(r.stdout, /would-pass/, 'no corrió ningún caso');
  assert.ok(!fs.existsSync(report), 'ni escribió un reporte que alguien pueda leer como una corrida');
  // sólo con el lanzador de WSL
  r = run("{ platform: 'win32', env: { Path: 'C:\\\\Windows\\\\System32', SystemRoot: 'C:\\\\Windows' }, exists: (p) => /system32\\\\bash\\.exe$/i.test(p) }");
  assert.strictEqual(r.status, 2);
  assert.match(r.stdout, /NO MEDIDO: falta Git for Windows.*sólo está el lanzador de WSL/);
  assert.doesNotMatch(r.stdout, /✅/);
  // 🔴 LA CONDICIÓN MEDIDA EN WINDOWS (corrida 11694): Git for Windows INSTALADO en su carpeta por defecto y FUERA del
  // PATH (el PATH, sólo System32; `ProgramFiles` y `LOCALAPPDATA` apuntando a una carpeta que no existe). El bash se
  // encuentra igual —la carpeta por defecto también se busca por `ProgramW6432`, y Windows no deja esconderla—, así
  // que el banco corría: 392 rojos y 329 verdes que no decían nada de ningún control, porque `git` y `node` no
  // estaban en el PATH con que corren los casos. Sin ellos tampoco hay nada que medir.
  const measured = (extra) => `{ platform: 'win32', env: Object.assign({ Path: 'C:\\\\Windows\\\\System32', SystemRoot: 'C:\\\\Windows', ProgramFiles: 'C:\\\\no-such-folder', LOCALAPPDATA: 'C:\\\\no-such-folder', ProgramW6432: 'C:\\\\Program Files' }, ${extra || '{}'}),`
    + " exists: (p) => ['c:\\\\program files\\\\git\\\\bin\\\\bash.exe', 'c:\\\\windows\\\\system32\\\\bash.exe', 'c:\\\\tools\\\\git.exe', 'c:\\\\tools\\\\node.exe'].includes(String(p).toLowerCase()) }";
  r = run(measured());
  assert.strictEqual(r.status, 2, `con git y node fuera del PATH sale 2: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /NO MEDIDO: falta Git for Windows en el PATH/);
  assert.match(r.stdout, /Program Files\\Git\\bin\\bash\.exe/, 'dice que el bash sí está, y dónde');
  assert.match(r.stdout, /`git` y `node`/, 'y qué es lo que no encuentra');
  assert.doesNotMatch(r.stdout, /✅/, 'ningún verde');
  assert.doesNotMatch(r.stdout, /would-pass/, 'no corrió ningún caso');
  assert.ok(!fs.existsSync(report));
  // lo que decide es el PATH de los casos, sin lanzar nada
  const ctxOf = (source) => new Function(`return (${source});`)();
  assert.deepStrictEqual(runner.missingOnPath(ctxOf(measured())), ['git', 'node']);
  assert.deepStrictEqual(runner.missingOnPath(ctxOf(measured("{ Path: 'C:\\\\Windows\\\\System32;C:\\\\Tools' }"))), [], 'con los dos en el PATH no falta nada');
  assert.strictEqual(runner.cannotMeasure(ctxOf(measured("{ Path: 'C:\\\\Windows\\\\System32;C:\\\\Tools' }"))), null);
  assert.deepStrictEqual(runner.missingOnPath({ platform: 'linux', env: { PATH: '/nada' }, exists: () => false }), [], 'fuera de Windows no se mira: el banco se comporta como siempre');
  assert.strictEqual(runner.cannotMeasure({ platform: 'darwin', env: { PATH: '/nada' }, exists: () => false }), null);
  // el control del rojo: el mismo banco de juguete, en esta máquina tal cual, corre y da su verde
  if (!ON_WINDOWS || !runner.cannotMeasure()) {
    r = spawnSync(process.execPath, [RUNNER, '--tool', 'claude', '--json', report], { encoding: 'utf8', env: { ...process.env, TYCON_BENCH_CASES_DIR: cases } });
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /✅ \[claude\] probe\.js::would-pass/);
  }
});

test('T19d2 Bench_Portable_NotMeasuredIsNotRed — un caso que no se pudo medir no es un rojo, y el auditor de vacuidad no lo cuenta como «prueba algo»', () => {
  const hooks = hookFiles();
  const without = "{ platform: 'win32', env: { Path: 'C:\\\\Windows\\\\System32', SystemRoot: 'C:\\\\Windows' }, exists: (p) => /system32\\\\bash\\.exe$/i.test(p) }";
  const ctx = { platform: 'win32', env: { Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' }, exists: (p) => /system32\\bash\.exe$/i.test(p) };
  // 1 · runCase: sin bash de Git, un caso con preparación o con un hook de bash vuelve «no medido», no «falló»
  for (const [hook, caseDef] of [
    [{ hook: 'probe', script: hooks.probe, event: 'PreToolUse' }, { id: 'needs-setup', type: 'must-emit', setup: ['mkdir -p a'], stdin: {}, expect: { stdout_re: ['HOME-IS-LAB'] } }],
    [{ hook: 'shell', script: hooks.shell, event: 'PreToolUse' }, { id: 'needs-bash', type: 'must-emit', stdin: {}, expect: { stdout_re: ['SHELL-HOOK-RAN'] } }],
  ]) {
    const r = runner.runCase('claude', hook, caseDef, ctx);
    assert.strictEqual(r.pass, false, caseDef.id);
    assert.strictEqual(r.nomedido, true, `${caseDef.id}: va al balde de NO MEDIDO, no al de rojos: ${JSON.stringify(r)}`);
    assert.match(r.failures.join('\n'), /^NO MEDIDO: falta Git for Windows/);
  }
  // un error cualquiera sigue siendo un rojo común
  const red = runner.runCase('claude', { hook: 'gone', script: path.join(hooks.dir, 'no-existe.js'), event: 'Stop' }, { id: 'x', type: 'must-run', stdin: {}, expect: { stdout_re: ['x'] } });
  assert.strictEqual(red.pass, false);
  assert.ok(!red.nomedido, 'un guion que no existe es un rojo, no un «no medido»');
  // 2 · el auditor de vacuidad: su método es «el caso tiene que FALLAR con un control mudo». Un caso que no se pudo
  //     correr también «falla»: sin esta guarda lo contaba como un caso que prueba algo, y cerraba con un verde.
  const audit = require(VACUITY);
  const toy = [{ hook: 'probe', script: hooks.probe, event: 'PreToolUse', __file: 'toy', cases: [
    { id: 'affirmative', type: 'must-emit', stdin: {}, expect: { stdout_re: ['HOME-IS-LAB'] } }] }];
  const judged = audit.auditar(toy, null, ctx);
  assert.deepStrictEqual({ vacuos: judged.vacuos.length, corridos: judged.corridos, noMedidos: judged.noMedidos.length }, { vacuos: 0, corridos: 0, noMedidos: 1 },
    'el caso no se audita: ni vacuo ni «prueba algo»');
  // por línea de comandos: sale 2, dice NO MEDIDO y no imprime ningún verde
  const cases = tempDir('tycon-vacuity-cases-');
  fs.writeFileSync(path.join(cases, '01-toy.json'), JSON.stringify(toy[0]));
  const r = spawnSync(process.execPath, ['-e', `const a = require(${JSON.stringify(VACUITY)}); process.exitCode = a.main(${without});`],
    { encoding: 'utf8', env: { ...process.env, TYCON_BENCH_CASES_DIR: cases } });
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /NO MEDIDO: falta Git for Windows/);
  assert.doesNotMatch(r.stdout + r.stderr, /✅/, 'ningún verde');
  // el control: en esta máquina tal cual, el mismo caso de juguete se audita y da su verde
  if (!ON_WINDOWS || findGitBash().path) {
    const ok = spawnSync(process.execPath, [VACUITY], { encoding: 'utf8', env: { ...process.env, TYCON_BENCH_CASES_DIR: cases } });
    assert.strictEqual(ok.status, 0, `${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /✅ vacuity: 1 casos afirmativos/);
  }
});

test('T19d3 Bench_Portable_KnownGaps — en Windows un rojo declarado en known-gaps.json es un «rojo conocido», y uno que ya no se reproduce se dice', () => {
  const cases = tempDir('tycon-bench-gaps-cases-');
  const hooks = hookFiles();
  const blocks = path.join(hooks.dir, 'blocks.js');
  fs.writeFileSync(blocks, "require('fs').readFileSync(0); process.exit(2);\n");
  // tres casos que esperan que el hook NO frene, sobre un hook que frena siempre: tres rojos. Y uno verde.
  fs.writeFileSync(path.join(cases, '01-toy.json'), JSON.stringify({ hooks: [
    { hook: 'blocks', script: blocks, event: 'PreToolUse', cases: [
      { id: 'declared', type: 'must-not-block', stdin: {}, expect: { exit: 0 } },
      { id: 'not-declared', type: 'must-not-block', stdin: {}, expect: { exit: 0 } }] },
    { hook: 'probe', script: hooks.probe, event: 'PreToolUse', cases: [
      { id: 'green-and-declared', type: 'must-emit', stdin: {}, expect: { stdout_re: ['HOME-IS-LAB'] } },
      { id: 'green', type: 'must-emit', stdin: {}, expect: { stdout_re: ['HOME-IS-LAB'] } }] },
  ] }));
  const out = tempDir('tycon-bench-gaps-out-');
  const gaps = path.join(out, 'known-gaps.json');
  const report = path.join(out, 'report.json');
  const write = (list) => fs.writeFileSync(gaps, JSON.stringify({ baseline: null, gaps: list }));
  const w = injectedWindows();
  // Windows inyectado con todo a mano (el bash, y git y node «en el PATH»), o el Windows de verdad
  const ctxSource = w.ctx ? `{ platform: 'win32', env: Object.assign({}, process.env, { ${JSON.stringify(ENV_VAR)}: ${JSON.stringify(w.witness)} }), exists: () => true }` : 'undefined';
  const run = () => spawnSync(process.execPath, ['-e',
    `process.argv.push('-', '--json', ${JSON.stringify(report)}); const r = require(${JSON.stringify(RUNNER)}); process.exitCode = r.main(${ctxSource});`],
  { encoding: 'utf8', env: { ...process.env, TYCON_BENCH_CASES_DIR: cases, TYCON_BENCH_KNOWN_GAPS: gaps } });
  // cada hueco declara POR QUÉ falla su caso: acá, un hook que frena cuando el caso espera que no (T19d4 mide esa regla)
  const gap = (id, extra) => ({ id: `bench:red:${id}`, step: 'bench', closes: 'W4', note: 'no anda en Windows: usa ps', match: '^(bloqueó y no debía|exit=2 esperado=0)', ...extra });

  // 1 · un rojo declarado y otro sin declarar: el declarado no cuenta como rojo, el otro sí
  write([gap('blocks.js::declared')]);
  let r = run();
  assert.strictEqual(r.status, 1, `queda un rojo sin declarar: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /🟠 \[claude\] blocks\.js::declared — ROJO CONOCIDO \(lo cierra W4: no anda en Windows: usa ps\)/);
  assert.match(r.stdout, /❌ \[claude\] blocks\.js::not-declared/);
  assert.match(r.stdout, /4 corridos · 1 rojos · 1 rojos conocidos \(known-gaps\.json\) · 0 NO MEDIDOS/);
  let j = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.deepStrictEqual([j.failed, j.knownGaps, j.staleGaps], [1, 1, 0]);
  assert.strictEqual(j.results['blocks.js::declared'].tools.claude.pass, false, 'en el reporte sigue siendo un caso que no pasó');
  assert.deepStrictEqual(j.results['blocks.js::declared'].tools.claude.known_gap, { closes: 'W4', note: 'no anda en Windows: usa ps' });
  // 2 · con los dos declarados: sale 0, y lo dice
  write([gap('blocks.js::declared'), gap('blocks.js::not-declared')]);
  r = run();
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /✅ 4 corridos · 0 rojos · 2 rojos conocidos/);
  // 3 · un hueco declarado que ya no se reproduce: la lista quedó vieja, y eso es un rojo que lo nombra
  write([gap('blocks.js::declared'), gap('blocks.js::not-declared'), gap('probe.js::green-and-declared')]);
  r = run();
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /HUECO QUE YA NO SE REPRODUCE: probe\.js::green-and-declared[^\n]*ya no falla: sacalo de known-gaps\.json/);
  assert.strictEqual(JSON.parse(fs.readFileSync(report, 'utf8')).staleGaps, 1);
  // 4 · un hueco sin su tanda no tapa nada; una lista ilegible tampoco
  write([{ id: 'bench:red:blocks.js::declared', step: 'bench', note: 'sin tanda', match: 'bloqueó' }, gap('blocks.js::not-declared')]);
  r = run();
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /❌ \[claude\] blocks\.js::declared/, 'un hueco que no dice qué tanda lo cierra no cuenta');
  assert.match(r.stdout, /known-gaps\.json: 1 hueco\(s\) mal declarado\(s\)[^\n]*blocks\.js::declared/, 'y se dice cuál');
  write([gap('blocks.js::declared', { match: undefined }), gap('blocks.js::not-declared', { match: '(' })]);
  r = run();
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /2 rojos · 0 rojos conocidos/, 'un hueco sin su motivo (`match`), o con uno que no es una expresión válida, tampoco');
  assert.match(r.stdout, /known-gaps\.json: 2 hueco\(s\) mal declarado\(s\)/);
  fs.writeFileSync(gaps, 'esto no es json');
  r = run();
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /known-gaps\.json no se pudo leer/);
  assert.match(r.stdout, /2 rojos · 0 rojos conocidos/);
  // 5 · fuera de Windows la lista no se mira: es lo que no anda EN WINDOWS
  if (!ON_WINDOWS) {
    write([gap('blocks.js::declared'), gap('blocks.js::not-declared')]);
    r = spawnSync(process.execPath, [RUNNER, '--tool', 'claude', '--json', report], { encoding: 'utf8', env: { ...process.env, TYCON_BENCH_CASES_DIR: cases, TYCON_BENCH_KNOWN_GAPS: gaps } });
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /4 corridos · 2 rojos · 0 NO MEDIDOS/, 'la línea de resumen de siempre, sin la lista');
    assert.doesNotMatch(r.stdout, /🟠|rojos conocidos/);
  }
  // 6 · la lista real: cada hueco nombra un caso que existe y dice su tanda
  const real = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'tests', 'windows', 'known-gaps.json'), 'utf8'));
  const keys = new Set(runner.loadCaseFiles().flatMap((h) => h.cases.map((c) => `bench:red:${path.basename(String(c.script || h.script || h.hook))}::${c.id}`)));
  for (const g of real.gaps.filter((x) => x.step === 'bench')) {
    assert.ok(keys.has(g.id), `${g.id}: no es un caso del banco`);
    assert.match(String(g.closes), /^W[1-8]$/, `${g.id}: dice qué tanda lo cierra`);
    assert.ok(String(g.note || '').length > 40, `${g.id}: dice por qué`);
    assert.ok(typeof g.match === 'string' && g.match.length > 8, `${g.id}: declara el motivo con que falla (match)`);
    assert.doesNotThrow(() => new RegExp(g.match), `${g.id}: su match es una expresión válida`);
    assert.doesNotMatch('ERROR: script no existe: x', new RegExp(g.match), `${g.id}: su match no acepta un error del banco`);
    assert.doesNotMatch('ERROR: Command failed: x', new RegExp(g.match));
  }
  // lo medido en Windows (corrida 11705): los motivos con que fallan los dos casos de Telegram entran en su match
  const realGap = (id) => new RegExp(real.gaps.find((g) => g.id === `bench:red:telegram-zombie-sweep.sh::${id}`).match);
  for (const reason of ['stdout no matchea /huérfanos/', 'stdout no matchea /pids: 9001 9002/']) assert.match(reason, realGap('mata-launcher-huerfano-y-respeta-vivo'));
  assert.match('stdout no matchea /huérfanos cerrados \\(pids: [0-9]+/', realGap('mata-de-verdad'));
});

test('T19d4 Bench_Portable_KnownGapOnlyForItsReason — un rojo conocido lo es sólo si falla por el motivo declarado', () => {
  // 🔴 Lo que cierra (revisión del 2026-10-04, reproducido): la lista se buscaba por NOMBRE de caso, así que un caso
  // declarado quedaba «conocido» fallara por lo que fallara — con su guion borrado, con su preparación rota o con el
  // caso mal escrito, el banco salía 0. La lista podía tapar un rojo nuevo.
  const cases = tempDir('tycon-bench-reason-cases-');
  const hooks = hookFiles();
  const blocks = path.join(hooks.dir, 'blocks.js');
  const slow = path.join(hooks.dir, 'slow.js');
  fs.writeFileSync(blocks, "require('fs').readFileSync(0); process.exit(2);\n");
  fs.writeFileSync(slow, 'setTimeout(() => {}, 8000);\n');
  const quiet = { type: 'must-not-block', stdin: {}, expect: { exit: 0 } };
  fs.writeFileSync(path.join(cases, '01-toy.json'), JSON.stringify({ hooks: [
    { hook: 'blocks', script: blocks, event: 'PreToolUse', cases: [
      { id: 'fails-for-its-reason', ...quiet },
      { id: 'setup-fails', ...quiet, setup: ['exit 7'] },
      { id: 'badly-written', type: 'must-not-block', stdin: {}, expect: { exit: 0, stderr_re: 'una cadena, no una lista' } },
      { id: 'only-elsewhere', ...quiet, so: ['linux', 'darwin'] }] },
    { hook: 'gone', script: path.join(hooks.dir, 'no-existe.js'), event: 'PreToolUse', cases: [{ id: 'script-is-gone', ...quiet }] },
    { hook: 'probe', script: hooks.probe, event: 'PreToolUse', cases: [
      { id: 'back-to-green', type: 'must-emit', stdin: {}, expect: { stdout_re: ['HOME-IS-LAB'] } }] },
    { hook: 'slow', script: slow, event: 'PreToolUse', cases: [{ id: 'not-measured', ...quiet, timeout_s: 0.3 }] },
  ] }));
  const out = tempDir('tycon-bench-reason-out-');
  const gaps = path.join(out, 'known-gaps.json');
  const report = path.join(out, 'report.json');
  const baseline = path.join(out, 'baseline.json');
  const gap = (id) => ({ id: `bench:red:${id}`, step: 'bench', closes: 'W4', note: 'frena cuando no tiene que frenar', match: '^(bloqueó y no debía|exit=2 esperado=0)' });
  const write = (ids) => fs.writeFileSync(gaps, JSON.stringify({ baseline: null, gaps: ids.map(gap) }));
  const w = injectedWindows();
  const ctxSource = w.ctx ? `{ platform: 'win32', env: Object.assign({}, process.env, { ${JSON.stringify(ENV_VAR)}: ${JSON.stringify(w.witness)} }), exists: () => true }` : 'undefined';
  const run = (...args) => spawnSync(process.execPath, ['-e',
    `process.argv.push('-', '--json', ${JSON.stringify(report)}, ...${JSON.stringify(args)}); const r = require(${JSON.stringify(RUNNER)}); process.exitCode = r.main(${ctxSource});`],
  { encoding: 'utf8', env: { ...process.env, TYCON_BENCH_CASES_DIR: cases, TYCON_BENCH_KNOWN_GAPS: gaps, TYCON_BENCH_BASELINE: baseline } });
  const read = () => JSON.parse(fs.readFileSync(report, 'utf8'));
  const ALL = ['blocks.js::fails-for-its-reason', 'blocks.js::setup-fails', 'blocks.js::badly-written', 'no-existe.js::script-is-gone', 'probe.js::back-to-green', 'slow.js::not-measured'];

  // 1 · un conocido que falla por SU motivo: conocido, y el banco sale 0
  write(ALL);
  let r = run('--only', 'fails-for-its-reason');
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /🟠 \[claude\] blocks\.js::fails-for-its-reason — ROJO CONOCIDO/);
  assert.match(r.stdout, /1 corridos · 0 rojos · 1 rojos conocidos/);

  // 2 · todos declarados, y cada uno falla (o no) por lo suyo
  r = run();
  assert.strictEqual(r.status, 1, `${r.stdout}${r.stderr}`);
  // … el que falla por OTRO motivo es un rojo a secas, y dice que estaba en la lista y qué motivo se esperaba
  assert.match(r.stdout, /❌ \[claude\] blocks\.js::setup-fails — está en known-gaps\.json y falla por OTRO motivo[^\n]*ERROR: Command failed: exit 7/);
  assert.match(r.stdout, /❌ \[claude\] blocks\.js::badly-written — está en known-gaps\.json y falla por OTRO motivo[^\n]*caso MAL ESCRITO/);
  // … el que ya no tiene su guion, también
  assert.match(r.stdout, /❌ \[claude\] no-existe\.js::script-is-gone — está en known-gaps\.json y falla por OTRO motivo[^\n]*ERROR: script no existe/);
  // … el que volvió a verde se dice, sin tapar nada
  assert.match(r.stdout, /✅ \[claude\] probe\.js::back-to-green/);
  assert.match(r.stdout, /HUECO QUE YA NO SE REPRODUCE: probe\.js::back-to-green[^\n]*ya no falla: sacalo de known-gaps\.json/);
  // … y uno que no se pudo medir sigue siendo «no medido»: la lista no lo convierte en conocido
  assert.match(r.stdout, /🟡 \[claude\] slow\.js::not-measured — NO MEDIDO/);
  assert.match(r.stdout, /6 corridos · 3 rojos · 1 rojos conocidos \(known-gaps\.json\) · 1 NO MEDIDOS/);
  let j = read();
  assert.deepStrictEqual([j.failed, j.knownGaps, j.staleGaps, j.nomedido], [3, 1, 1, 1]);
  for (const k of ['blocks.js::setup-fails', 'blocks.js::badly-written', 'no-existe.js::script-is-gone', 'slow.js::not-measured']) {
    assert.strictEqual(j.results[k].tools.claude.known_gap, undefined, `${k}: no queda marcado como conocido en el reporte`);
  }

  // 3 · un hueco sin caso que lo mida —el caso ya no existe, o en Windows se saltea— es una lista vieja: se dice
  fs.writeFileSync(gaps, JSON.stringify({ baseline: null, gaps: ['blocks.js::fails-for-its-reason', 'blocks.js::no-such-case', 'blocks.js::only-elsewhere'].map(gap) }));
  r = run('--only', 'blocks.js::fails');
  assert.strictEqual(r.status, 0, `con --only, un hueco de un caso que el filtro dejó afuera no se juzga: ${r.stdout}`);
  r = run();
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /HUECO SIN CASO QUE LO MIDA: blocks\.js::no-such-case[^\n]*no está en la lista de casos/);
  assert.match(r.stdout, /HUECO SIN CASO QUE LO MIDA: blocks\.js::only-elsewhere[^\n]*se saltea en este sistema/);
  assert.strictEqual(read().staleGaps, 2);

  // 4 · con la línea de base: un rojo conocido no es una regresión (ya está dicho como conocido)
  write(['blocks.js::fails-for-its-reason']);
  fs.writeFileSync(baseline, JSON.stringify({ tool: 'claude', cases: { 'blocks.js::fails-for-its-reason': true } }));
  r = run('--only', 'fails-for-its-reason', '--baseline', 'check');
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /REGRESIÓN vs baseline/);
});

test('T19e Bench_Portable_BaselineSame — la línea de base se escribe y se compara como siempre, y un verde que se pone rojo se ve', () => {
  const cases = tempDir('tycon-bench-baseline-');
  const hooks = hookFiles();
  const flag = path.join(cases, 'flag');
  const toggling = path.join(hooks.dir, 'toggling.js');
  fs.writeFileSync(toggling, `require('fs').readFileSync(0); process.exit(require('fs').existsSync(${JSON.stringify(flag)}) ? 0 : 2);\n`);
  fs.writeFileSync(path.join(cases, '01-toy.json'), JSON.stringify({ hooks: [
    { hook: 'probe', script: hooks.probe, event: 'PreToolUse', cases: [
      { id: 'with-setup', type: 'must-emit', setup: ['mkdir -p x/y'], stdin: {}, expect: { stdout_re: ['HOME-IS-LAB'], file_exists: ['${FIXTURE}/x/y'] } }] },
    { hook: 'shell', script: hooks.shell, event: 'PreToolUse', cases: [
      { id: 'shell-runs', type: 'must-emit', stdin: {}, expect: { stdout_re: ['SHELL-HOOK-RAN'] } }] },
    { hook: 'toggling', script: toggling, event: 'PreToolUse', cases: [
      { id: 'blocks', type: 'must-block', stdin: {}, expect: { exit: 2 } }] },
  ] }));
  // la línea de base y el reporte van a OTRA carpeta: el corredor lee como casos todo .json de la suya
  const out = tempDir('tycon-bench-baseline-out-');
  const baseline = path.join(out, 'baseline.json');
  const env = { ...process.env, TYCON_BENCH_CASES_DIR: cases, TYCON_BENCH_BASELINE: baseline };
  const run = (mode) => spawnSync(process.execPath, [RUNNER, '--tool', 'claude', '--baseline', mode, '--json', path.join(out, 'report.json')], { encoding: 'utf8', env });
  let r = run('write');
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(baseline, 'utf8')).cases,
    { 'probe.js::with-setup': true, 'shell-hook.sh::shell-runs': true, 'toggling.js::blocks': true }, 'un veredicto por caso');
  r = run('check');
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  // en Windows el resumen suma «N rojos conocidos (known-gaps.json)»: medido en el agente Windows (corrida 11705), donde esta
  // comparación, escrita en una Mac, daba rojo con el banco en verde
  assert.match(r.stdout, /3 corridos · 0 rojos · (?:0 rojos conocidos \(known-gaps\.json\) · )?0 NO MEDIDOS .* regresiones vs baseline: 0/);
  // En Windows (inyectado acá; de verdad en el agente) con una lista de casos de juguete, la lista REAL de huecos conocidos
  // no aplica: describe los casos de verdad. Medido en el agente Windows (corrida 11714): se comparaba igual, cada hueco
  // quedaba «sin caso que lo mida» y el banco salía 1 con los tres casos en verde.
  {
    const w = injectedWindows();
    const ctxSource = w.ctx ? `{ platform: 'win32', env: Object.assign({}, process.env, { ${JSON.stringify(ENV_VAR)}: ${JSON.stringify(w.witness)} }), exists: () => true }` : 'undefined';
    const asWindows = spawnSync(process.execPath, ['-e',
      `process.argv.push('-', '--tool', 'claude', '--json', ${JSON.stringify(path.join(out, 'report-win.json'))}); const r = require(${JSON.stringify(RUNNER)}); process.exitCode = r.main(${ctxSource});`],
    { encoding: 'utf8', env });
    assert.doesNotMatch(asWindows.stdout, /HUECO SIN CASO/, `la lista real de huecos no se compara contra casos de juguete: ${asWindows.stdout}`);
    assert.strictEqual(asWindows.status, 0, `${asWindows.stdout}${asWindows.stderr}`);
    assert.match(asWindows.stdout, /3 corridos · 0 rojos · 0 rojos conocidos/);
  }
  fs.writeFileSync(flag, '');
  r = run('check');
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /REGRESIÓN vs baseline: toggling\.js::blocks era verde y ahora es rojo/);
  assert.match(r.stdout, /regresiones vs baseline: 1/);
});

test('T19f LiveFire_MarkerIsNode — el marcador de live-fire.js es un guion de Node, y hace lo mismo que hacía el de sh', () => {
  // 🔴 ANTES de requerirlo: si el guion corre `main()` al cargarse, requerirlo abre una sesión real del asistente (pasó
  // al escribir esta prueba). Sin la guarda no se requiere: se falla acá.
  assert.match(fs.readFileSync(LIVE_FIRE, 'utf8'), /\nif \(require\.main === module\) main\(\);\n/,
    'live-fire.js sólo corre main() cuando se lo lanza: requerirlo no puede abrir una sesión');
  const liveFire = require(LIVE_FIRE);
  const dir = tempDir('tycon-livefire-marker-');
  const marker = liveFire.markScript(dir);
  assert.match(marker, /\.js$/, 'el marcador ya no es un .sh');
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.sh')), 'ni deja un .sh en la carpeta');
  const config = liveFire.buildHooksConfig(marker);
  const commands = Object.values(config).flat().flatMap((m) => m.hooks.map((h) => h.command));
  assert.strictEqual(commands.length, 8);
  for (const c of commands) {
    assert.doesNotMatch(c, /(^|\s)sh\s|\.sh\b|\\/, `sin sh y sin barras invertidas: ${c}`);
    if (ON_WINDOWS) assert.match(c, /^node "/, `en Windows, node por su nombre (lo leen igual bash, PowerShell y cmd.exe): ${c}`);
    else assert.ok(c.startsWith(`"${process.execPath}" "`), `fuera de Windows, el node que está corriendo, por su ruta: ${c}`);
  }
  // el intérprete del marcador, por plataforma. Fuera de Windows va la ruta absoluta del node que corre: un hook lanzado
  // con el PATH mínimo de un trabajo programado no encuentra `node` por su nombre (y antes alcanzaba con `sh`).
  assert.strictEqual(liveFire.hookEntry('/a b/mark.js', 'Stop', '', { platform: 'darwin', execPath: '/opt/node 20/bin/node' }).command,
    '"/opt/node 20/bin/node" "/a b/mark.js" Stop');
  assert.strictEqual(liveFire.hookEntry('C:\\lab x\\mark.js', 'PreToolUse', '-err', { platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe' }).command,
    'node "C:/lab x/mark.js" PreToolUse -err', 'en Windows una ruta entre comillas al principio no es un comando para PowerShell: va el nombre');
  {
    // con el PATH mínimo y una carpeta con espacios, el marcador corre igual
    const spaced = path.join(tempDir('tycon livefire '), 'con espacio');
    fs.mkdirSync(spaced, { recursive: true });
    const m = liveFire.markScript(spaced);
    const bare = spawnSync(liveFire.hookEntry(m, 'Stop').command, { shell: true, input: '{}', encoding: 'utf8', env: ON_WINDOWS ? process.env : { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    assert.strictEqual(bare.status, 0, `con el PATH mínimo: ${bare.stderr}`);
    assert.ok(fs.existsSync(path.join(spaced, 'Stop.json')));
  }
  const fire = (command, payload) => spawnSync(command, { shell: true, input: JSON.stringify(payload), encoding: 'utf8' });
  const byEvent = (event, i = 0) => config[event][i].hooks[0].command;
  // un evento común: vuelca la entrada e imprime su código
  let r = fire(byEvent('SessionStart'), { hook_event_name: 'SessionStart', n: 1 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /CODIGO-DE-PRUEBA del banco .*: E3INJ-SessionStart\n$/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'SessionStart.json'), 'utf8')), { hook_event_name: 'SessionStart', n: 1 });
  // el segundo marcador de PreToolUse (el del matcher Bash): vuelca con su etiqueta y no imprime código
  r = fire(byEvent('PreToolUse', 1), { tool_name: 'Bash' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.ok(fs.existsSync(path.join(dir, 'PreToolUse-matcherBash.json')));
  // PostToolUse: el sobre con additionalContext
  r = fire(byEvent('PostToolUse', 0), { a: 1 });
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'PostToolUse',
    additionalContext: 'CODIGO-DE-PRUEBA del banco (no es secreto, repetilo textual en tu respuesta final): E3INJ-PostToolUse' } });
  // PostToolUse por el canal de error: stderr y sale 2
  r = fire(byEvent('PostToolUse', 1), { a: 2 });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /E3ERR-PostToolUse\n$/);
  assert.ok(fs.existsSync(path.join(dir, 'PostToolUse-err.json')));
  // Stop y el canario: vuelcan y callan
  for (const [command, file] of [[byEvent('Stop'), 'Stop.json'], [byEvent('PreToolUse', 2), 'CANARY.json']]) {
    r = fire(command, { x: 1 });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `${file}: no imprime nada`);
    assert.ok(fs.existsSync(path.join(dir, file)));
  }
});

test('T19g MissingPathNotice_UserFolderFromOsHomedir — el aviso de ruta inexistente no le pide la carpeta de usuario a la variable HOME', () => {
  // Qué mide y qué no (T22 de la story 8.17). El hook, como hook, no usa la carpeta de usuario: un caso del banco con
  // HOME vacía no distingue nada (pasa igual con el código de antes) y por eso no existe. El único lugar que la pide
  // es el modo `--measure`, y ahí el valor tampoco llega a usarse (sólo juzga rutas absolutas): el cambio es de
  // higiene. Lo que SÍ se puede medir es de dónde la pide: se corre ese modo con un testigo que anota cada lectura de
  // `HOME` por el entorno del proceso —con cualquier forma de escribirla—. `os.homedir()` no pasa por ahí.
  const dir = tempDir('tycon-notice-');
  const log = path.join(dir, 'log.jsonl');
  const reads = path.join(dir, 'home-reads.log');
  const witness = path.join(dir, 'witness.js');
  fs.writeFileSync(witness, [
    "'use strict';",
    "const fs = require('fs');",
    'process.env = new Proxy(process.env, {',
    `  get(target, key) { if (key === 'HOME') fs.appendFileSync(${JSON.stringify(reads)}, 'read\\n'); return target[key]; },`,
    '});',
    '',
  ].join('\n'));
  // una ruta absoluta fuera de las carpetas temporales (ésas el modo las descarta antes de juzgar)
  fs.writeFileSync(log, `${JSON.stringify({ tool: 'Bash', summary: 'cat /carpeta-que-no-existe-tycon/no-existe.txt' })}\n`);
  const measure = (script, env) => spawnSync(process.execPath, ['-r', witness, script, '--measure', log], { encoding: 'utf8', env });
  const r = measure(NOTICE, process.env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /comandos Bash: 1/);
  assert.match(r.stdout, /^evaluables: 1$/m, 'la línea del registro llegó a juzgarse: el lugar que pedía la carpeta se ejecutó');
  assert.ok(!fs.existsSync(reads), 'no leyó HOME del entorno');
  // el control del rojo: la misma corrida sobre una copia que la pide como antes deja la lectura anotada
  const old = path.join(dir, 'as-before.js');
  const source = fs.readFileSync(NOTICE, 'utf8');
  const call = 'missing(abs, os.homedir(), true)';
  assert.ok(source.includes(call), 'la carpeta de usuario sale de os.homedir()');
  fs.writeFileSync(old, source.replace(call, "missing(abs, process.env['HOME'], true)"));
  assert.strictEqual(measure(old, process.env).status, 0);
  assert.ok(fs.existsSync(reads), 'el testigo ve la lectura cuando existe: la prueba puede fallar');
  // y sin HOME en el entorno (como en Windows) el modo corre igual
  const env = { ...process.env };
  delete env.HOME;
  assert.strictEqual(measure(NOTICE, env).status, 0);
});

// T19h · el caso (2026-10-04, corrida 182 #11867 sobre el main unido): 53 casos GIT-C4 «NO bloqueó» en Windows y 0
// en Mac. No era el freno: los casos armaban la instalación con `ln -s <carpeta> ~/.claude/skills`, y el bash de Git
// for Windows (sin `winsymlinks`) COPIA la carpeta en vez de enlazarla. Con una carpeta real no hay «árbol del que
// salen las skills» y el freno deja pasar, como corresponde. La instalación de verdad crea un junction
// (scripts/lib/canonical-path.js): los casos lo crean igual, con node. Un `ln -s` a una carpeta sólo se acepta en un
// caso que se declara fuera de Windows (`so` sin `win32`).
test('T19h Bench_FolderLinksAreJunctions — ningún caso que corre en Windows enlaza una carpeta con `ln -s` (el bash de Git la copia)', () => {
  const dir = path.join(__dirname, '..', 'controls-bench', 'cases', 'hooks');
  const bad = [];
  let junctions = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const h of d.hooks || []) for (const c of h.cases || []) {
      const setup = (c.setup || []).join('\n');
      if (setup.includes("'junction')")) junctions++;
      const onWindows = !Array.isArray(c.so) || c.so.includes('win32');
      // `ln -s "$(command -v x)" lab/x` enlaza un PROGRAMA (un archivo): copiarlo no cambia lo que se mide
      if (onWindows && /ln -s "\$(FIXTURE|SANDBOX_HOME|HOME|TCG|SKILLS)\b/.test(setup)) bad.push(`${f} · ${c.id}`);
    }
  }
  assert.deepStrictEqual(bad, [], `casos que en Windows quedarían con una COPIA en vez de un enlace:\n${bad.join('\n')}`);
  assert.ok(junctions >= 60, `el lector no encontró los junctions de los casos GIT-C4 (${junctions})`);
});

test('T19i LiveFire_SessionThatDidNotWork_IsUnmeasuredNotSixReds — una sesión sin cuota no se cuenta como hooks que no disparan', () => {
  const { sessionDidNotWork } = require(LIVE_FIRE);
  const quota = { status: 1, stderr: 'hook: SessionStart\nERROR: You’ve hit your usage limit. Try again later.\nERROR: otra\n' };
  assert.strictEqual(sessionDidNotWork(quota, new Set(['SessionStart', 'UserPromptSubmit'])), 'ERROR: You’ve hit your usage limit. Try again later.',
    'el motivo es la primera línea de error de la herramienta');
  assert.strictEqual(sessionDidNotWork({ status: 3, stderr: 'nada útil' }, new Set()), null, 'sin un error de la cuenta, lo que falte es rojo');
  assert.strictEqual(sessionDidNotWork({ status: 1, stderr: 'ERROR: hook PreToolUse exited with code 2' }, new Set(['SessionStart'])), null,
    'un error que no nombra la cuenta (un hook que frena) puede ser el arnés: rojo');
  assert.strictEqual(sessionDidNotWork({ status: null, signal: 'SIGTERM', stderr: 'ERROR: usage limit' }, new Set()), null,
    'un corte por tiempo puede ser un hook colgado: rojo');
  assert.strictEqual(sessionDidNotWork({ status: 0, stderr: '' }, new Set()), null, 'una sesión que terminó bien sí midió: si falta un marcador, es rojo');
  assert.strictEqual(sessionDidNotWork({ status: 1, stderr: 'ERROR: usage limit' }, new Set(['PreToolUse'])), null,
    'si el agente llegó a correr un comando, la sesión trabajó: lo que falte es del arnés');
});

test.after(() => {
  for (const d of temporaries) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* un temporal que no se pudo borrar no cambia el veredicto */ } }
});
