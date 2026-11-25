'use strict';
// lab-inside-isolation.test.js — un guion de laboratorio que arma su propia casa corre igual dentro de la ejecución
// aislada de smoke-run.sh que suelto, y la casa de la cuenta sigue protegida.
//
// El guion de laboratorio de cada caso es de verdad: arma su casa de juguete en su carpeta temporal, copia el ambiente
// SIN las variables `TYCON_*`, pone `HOME` en su casa y lanza un `node` hijo, como hacen los guiones de cierre. La
// «casa de la cuenta» es de juguete: una precarga hace que `os.userInfo()` la devuelva en cada proceso de la cadena.
//
//   T1 · el hijo escribe su hook-errors.log en la casa de juguete, y el humo sale 0
//   T2 · suelto y encerrado dan la misma salida y el mismo registro
//   T3 · el hijo que escribe en la casa de la cuenta, también con TYCON_REAL_HOME_GUARD_ROOTS=[], queda frenado y
//        anotado (el humo sale 3); en un repo bajo .claude/worktrees/ escribe
//   T4 · un comando que no limpia el ambiente sigue como antes: las mismas raíces y lo mismo admitido
//   T5 · el freno de escrituras sin gate-clock.js deja «FAILED OPEN» en la casa de juguete,
//        suelto y encerrado
//   T6 · los mensajes de smoke-run.sh dicen «ejecución aislada»
//
// stable-data: los repos de juguete van con fecha fija, y el único reloj que lee es el tope de espera de la T10.
//
// Uso: node --test scripts/tests/lab-inside-isolation.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const SK = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts');
const SMOKE = path.join(SK, 'smoke-run.sh');
const POSIX = process.platform !== 'win32';

// la casa de la cuenta, simulada en cada proceso de la cadena: smoke-run.sh, isolated-run.js, el guion y su hijo
const PRECARGA = "const os = require('os'); const h = process.env.TEST_ACCOUNT_HOME; if (h) os.userInfo = () => ({ homedir: h, username: 'prueba', uid: 1, gid: 1, shell: null });\n";

function carpeta(t, prefijo) {
  const b = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefijo)));
  t.after(() => fs.rmSync(b, { recursive: true, force: true }));
  return b;
}
/** Una «casa de la cuenta» de juguete y la precarga que la hace pasar por la real. */
function cuenta(t) {
  const b = carpeta(t, 'lab-encierro-');
  const casa = path.join(b, 'cuenta');
  fs.mkdirSync(path.join(casa, '.tycon', 'state'), { recursive: true });
  const pre = path.join(b, 'precarga.js');
  fs.writeFileSync(pre, PRECARGA);
  return { b, casa, pre };
}
// TEST_ACCOUNT_HOME no empieza con TYCON_: sobrevive a la limpieza del guion, así la precarga sigue en el hijo
function ambiente(c) {
  const e = { ...process.env };
  for (const k of ['NODE_TEST_CONTEXT', 'CLAUDE_CODE_SESSION_ID', 'TYCON_TEST_RUN', 'TYCON_REAL_HOME_GUARD_ROOTS', 'TYCON_REAL_HOME_GUARD_LOG', 'TYCON_REAL_HOME_GUARD_ALLOW']) delete e[k];
  const previas = String(e.NODE_OPTIONS || '').trim();
  return { ...e, HOME: c.casa, USERPROFILE: c.casa, TYCON_HOME: '', TEST_ACCOUNT_HOME: c.casa, CLAUDE_CODE_SESSION_ID: 'ses-8321',
    NODE_OPTIONS: `${previas ? `${previas} ` : ''}--require "${c.pre}"` };
}
const FECHA = '2026-11-21T00:00:00Z';
const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=prueba', '-c', 'user.email=prueba@acme.test', '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA } });
/** Un repo de juguete con sus archivos, commiteado. */
function repo(dir, archivos) {
  for (const [rel, texto] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), texto);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'inicio');
  return dir;
}
const humo = (dir, id, guion, extra, env) => spawnSync('bash', [SMOKE, path.join(dir, '.advisors', 'dod-runtime'), id, '--', process.execPath, guion, ...extra],
  { cwd: dir, env, encoding: 'utf8' });
const suelto = (dir, guion, extra, env) => spawnSync(process.execPath, [guion, ...extra], { cwd: dir, env, encoding: 'utf8' });
const salida = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const resultado = (r) => String(r.stdout || '').split('\n').filter((l) => l.startsWith('LAB ')).join('\n');

// El guion de laboratorio: casa de juguete en su temporal, ambiente sin TYCON_* (y lo que pida el caso), y un hijo.
// Imprime lo que el hijo hizo y lo que quedó en el registro de su casa, sin rutas que cambien de una corrida a otra.
const LAB = [
  "const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawnSync } = require('child_process');",
  "const pedido = JSON.parse(process.argv[2] || '{}');",
  "const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-casa-'));",
  "const casa = path.join(base, 'casa');",
  "const env = {}; for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_')) env[k] = v;",
  "Object.assign(env, { HOME: casa, USERPROFILE: casa }, pedido.env || {});",
  "const r = spawnSync(process.execPath, [path.join(__dirname, pedido.hijo || 'hijo.js'), ...(pedido.args || [])], { env, encoding: 'utf8', input: pedido.entrada || '' });",
  "const reg = path.join(casa, '.claude', '.tycon-pipeline', 'hook-errors.log');",
  "const hallados = []; (function buscar(d) { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) buscar(p); else if (e.name === 'hook-errors.log') hallados.push(fs.readFileSync(p, 'utf8')); } })(casa);",
  "console.log('LAB hijo salió ' + r.status);",
  "for (const l of String(r.stdout || '').split('\\n').filter(Boolean)) console.log('LAB hijo: ' + l);",
  "console.log('LAB registro: ' + JSON.stringify(hallados.join('').split('\\n').filter(Boolean).map((l) => (l.match(/FAILED OPEN|del hijo/) || ['otro'])[0])));",
  "if (r.stderr) process.stderr.write(r.stderr);",
  "fs.rmSync(base, { recursive: true, force: true });",
  'process.exitCode = r.status === 0 ? 0 : 1;',
  '',
].join('\n');
// El hijo: escribe su renglón en el hook-errors.log de su casa y, si se le pide, en otra ruta.
const HIJO = [
  "const fs = require('fs'); const os = require('os'); const path = require('path');",
  "const reg = path.join(os.homedir(), '.claude', '.tycon-pipeline', 'hook-errors.log');",
  "try { fs.mkdirSync(path.dirname(reg), { recursive: true }); fs.appendFileSync(reg, 'renglón del hijo\\n'); console.log('escribí mi registro'); } catch (e) { console.log('no pude escribir mi registro: ' + e.code); }",
  "if (process.argv[2]) { try { fs.appendFileSync(process.argv[2], 'del hijo\\n'); console.log('escribí afuera'); } catch (e) { console.log('no pude escribir afuera: ' + e.code); } }",
  '',
].join('\n');

test('T1 LabInsideIsolation_CleanEnvChild_WritesOwnHouse @story-8.321 @ac-1', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const r = repo(path.join(c.b, 'repo'), { '.advisors/dod-runtime/lab.js': LAB, '.advisors/dod-runtime/hijo.js': HIJO });
  const s = humo(r, '9.21', '.advisors/dod-runtime/lab.js', [], ambiente(c));
  assert.strictEqual(s.status, 0, salida(s));
  assert.match(s.stdout, /LAB hijo: escribí mi registro/, salida(s));
  assert.match(s.stdout, /LAB hijo salió 0/, salida(s));
});

test('T2 LabInsideIsolation_SameResultAsDirect @story-8.321 @ac-1', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const r = repo(path.join(c.b, 'repo'), { '.advisors/dod-runtime/lab.js': LAB, '.advisors/dod-runtime/hijo.js': HIJO });
  const fuera = suelto(r, '.advisors/dod-runtime/lab.js', [], ambiente(c));
  const dentro = humo(r, '9.22', '.advisors/dod-runtime/lab.js', [], ambiente(c));
  assert.strictEqual(fuera.status, 0, salida(fuera));
  assert.strictEqual(dentro.status, fuera.status, salida(dentro));
  assert.strictEqual(resultado(dentro), resultado(fuera), `encerrado:\n${salida(dentro)}`);
});

// lo que queda de un archivo del estado sin el renglón que el propio humo anota en su espejo (el gates.log de la carpeta
// del estado): el de su historia y con su salida. Un renglón verde que escribiera el comando, o cualquier otra línea, queda
const sinSuEspejo = (texto, story, salida) => texto.split('\n').filter((l) => {
  try { const g = JSON.parse(l); return !(g.type === 'smoke-run' && g.story === story && g.exit === salida); } catch { return true; }
}).join('\n');

test('T3 LabInsideIsolation_CleanEnvChild_RealHomeStillGuarded @story-8.321 @ac-2', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const destino = path.join(c.casa, '.tycon', 'state', 'gates.log');
  fs.writeFileSync(destino, 'antes\n');
  const r = repo(path.join(c.b, 'repo'), { '.advisors/dod-runtime/lab.js': LAB, '.advisors/dod-runtime/hijo.js': HIJO });
  for (const [nombre, env] of [['limpia las TYCON_*', {}], ['además vacía las raíces', { TYCON_REAL_HOME_GUARD_ROOTS: '[]' }],
    ['además pone raíces falsas', { TYCON_REAL_HOME_GUARD_ROOTS: JSON.stringify([path.join(c.b, 'otra')]) }]]) {
    const s = humo(r, '9.23', '.advisors/dod-runtime/lab.js', [JSON.stringify({ args: [destino], env })], ambiente(c));
    assert.strictEqual(s.status, 3, `${nombre}: ${salida(s)}`);
    assert.ok(salida(s).includes(destino), `${nombre}: la salida nombra la ruta frenada: ${salida(s)}`);
    assert.strictEqual(sinSuEspejo(fs.readFileSync(destino, 'utf8'), '9.23', s.status), 'antes\n', `${nombre}: el archivo de la casa de la cuenta no cambió`);
  }
  // un repo del humo bajo .claude/worktrees/ de la casa de la cuenta: el hijo escribe en él
  const w = repo(path.join(c.casa, '.claude', 'worktrees', 'r'), { '.advisors/dod-runtime/lab.js': LAB, '.advisors/dod-runtime/hijo.js': HIJO });
  const enRepo = path.join(w, 'escrito.txt');
  const s = humo(w, '9.23', '.advisors/dod-runtime/lab.js', [JSON.stringify({ args: [enRepo] })], ambiente(c));
  assert.strictEqual(s.status, 0, salida(s));
  assert.strictEqual(fs.readFileSync(enRepo, 'utf8'), 'del hijo\n');
});

test('T4 LabInsideIsolation_NoEnvCleaning_Unchanged @story-8.321 @ac-3', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const destino = path.join(c.casa, '.claude', 'x.txt');
  const r = repo(path.join(c.b, 'repo'), {
    '.advisors/dod-runtime/ve.js': [
      "const { spawnSync } = require('child_process'); const path = require('path');",
      "console.log('ROOTS ' + process.env.TYCON_REAL_HOME_GUARD_ROOTS); console.log('ALLOW ' + process.env.TYCON_REAL_HOME_GUARD_ALLOW);",
      `const h = spawnSync(process.execPath, [path.join(__dirname, 'hijo.js'), ${JSON.stringify(destino)}], { encoding: 'utf8' });`,
      'process.stdout.write(h.stdout);',
      '',
    ].join('\n'),
    '.advisors/dod-runtime/hijo.js': HIJO,
  });
  const s = humo(r, '9.24', '.advisors/dod-runtime/ve.js', [], ambiente(c));
  const raices = JSON.parse(/ROOTS (.*)/.exec(s.stdout)[1]);
  const admitidas = JSON.parse(/ALLOW (.*)/.exec(s.stdout)[1]);
  for (const d of ['.tycon', '.claude', '.codex']) assert.ok(raices.includes(path.join(c.casa, d)), `vigila ${d}: ${raices}`);
  assert.ok(admitidas.includes(r), `admite la raíz del repo: ${admitidas}`);
  assert.strictEqual(s.status, 3, salida(s));
  assert.ok(!fs.existsSync(destino), 'el hijo que hereda el ambiente sigue frenado en la casa de la cuenta');
});

// El freno de escrituras copiado sin lib/gate-clock.js: corre sin reloj y lo anota como «FAILED OPEN».
function frenoSinReloj(dest) {
  const filtro = (src) => !src.split(path.sep).includes('tests') && path.basename(src) !== 'gate-clock.js';
  fs.cpSync(SK, path.join(dest, 'skills', 'tycon-pipeline', 'scripts'), { recursive: true, filter: filtro });
  fs.mkdirSync(path.join(dest, 'scripts', 'setup', 'harness'), { recursive: true });
  fs.copyFileSync(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js'), path.join(dest, 'scripts', 'setup', 'harness', 'tycon-home.js'));
  return path.join(dest, 'skills', 'tycon-pipeline', 'scripts', 'on-bash-write-gate.js');
}

test('T5 LabInsideIsolation_GateWithoutClock_FailedOpenInLabHouse @story-8.321 @ac-4', { skip: !POSIX }, (t) => {
  const c = cuenta(t);
  const r = repo(path.join(c.b, 'repo'), { '.advisors/dod-runtime/lab.js': LAB, '.advisors/dod-runtime/.gitkeep': '' });
  const freno = frenoSinReloj(path.join(c.b, 'freno'));
  assert.ok(!fs.existsSync(path.join(path.dirname(freno), 'lib', 'gate-clock.js')), 'la copia no trae el reloj');
  const pedido = JSON.stringify({ hijo: path.relative(path.join(r, '.advisors', 'dod-runtime'), freno), entrada: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }) });
  const fuera = suelto(r, '.advisors/dod-runtime/lab.js', [pedido], ambiente(c));
  const dentro = humo(r, '9.25', '.advisors/dod-runtime/lab.js', [pedido], ambiente(c));
  for (const [nombre, s] of [['suelto', fuera], ['encerrado', dentro]]) {
    assert.strictEqual(s.status, 0, `${nombre}: ${salida(s)}`);
    assert.match(s.stdout, /LAB registro: .*FAILED OPEN/, `${nombre}: ${salida(s)}`);
  }
});

// 🔴 mutación: que una ejecución aislada anidada arme lo que vigila sólo con la variable del ambiente. Un guion que la
// limpia y lanza otra ejecución aislada deja al nieto sin las raíces de la de afuera (una TYCON_HOME propia).
// Sin el encierro del sistema, como en Linux y Windows: lo que se mide es la red.
test('T9 LabInsideIsolation_NestedRun_KeepsOuterRoots @story-8.321 @ac-2', { skip: !POSIX }, async (t) => {
  const c = cuenta(t);
  const propia = path.join(c.b, 'th');
  fs.mkdirSync(propia, { recursive: true });
  const destino = path.join(propia, 'x.txt');
  const fuera = carpeta(t, 'lab-anidada-');
  const guion = path.join(fuera, 'lab.js');
  fs.writeFileSync(guion, [
    "const { spawnSync } = require('child_process');",
    "const env = {}; for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_')) env[k] = v;",
    "env.TYCON_COMPARE_SANDBOX = 'off';",
    `const r = spawnSync(process.execPath, [${JSON.stringify(path.join(SK, 'lib', 'isolated-run.js'))}, 'exec', '--', process.execPath, '-e', ${JSON.stringify(`try { require('fs').writeFileSync(${JSON.stringify(destino)}, 'x'); console.log('escribí'); } catch (e) { console.log('frenado ' + e.code); }`)}], { env, encoding: 'utf8' });`,
    "process.stdout.write(r.stdout || ''); process.exitCode = r.status;",
    '',
  ].join('\n'));
  const env = { ...ambiente(c), TYCON_HOME: propia, TYCON_COMPARE_SANDBOX: 'off' };
  const codigo = await require(path.join(SK, 'lib', 'isolated-run.js')).exec({ argv: [process.execPath, guion], raices: [fuera], env, userInfo: () => ({ homedir: c.casa }), cwd: fuera, err: () => {} });
  assert.notStrictEqual(codigo, 0, 'la ejecución de afuera no sale limpia');
  assert.ok(!fs.existsSync(destino), 'el nieto no escribió en la TYCON_HOME que vigilaba la ejecución de afuera');
});

// 🔴 mutación: dejar el arranque de la red en la carpeta de la ejecución, que se borra al terminar el comando. Un node
// que el comando deja de fondo y arranca después no encuentra el archivo que NODE_OPTIONS le pide y no corre.
test('T10 LabInsideIsolation_BackgroundChild_StillStarts @story-8.321 @ac-3', { skip: !POSIX }, async (t) => {
  const c = cuenta(t);
  const fuera = carpeta(t, 'lab-fondo-');
  const marca = path.join(fuera, 'nieto.txt');
  const guion = path.join(fuera, 'fondo.js');
  // el código de cada node es fijo: la ruta de la marca le llega al nieto por sus argumentos, no escrita en el código
  fs.writeFileSync(guion, [
    "const { spawn } = require('child_process');",
    "const nieto = \"require('fs').writeFileSync(process.argv[1], 'corrió')\";",
    "const h = spawn(process.execPath, ['-e', \"setTimeout(() => require('child_process').spawnSync(process.execPath, ['-e', process.argv[1], process.argv[2]], { stdio: 'inherit' }), 1500);\", nieto, process.argv[2]], { detached: true, stdio: 'ignore' });",
    'h.unref();',
    '',
  ].join('\n'));
  const codigo = await require(path.join(SK, 'lib', 'isolated-run.js')).exec({ argv: [process.execPath, guion, marca], raices: [fuera], env: { ...ambiente(c), TYCON_COMPARE_SANDBOX: 'off' }, userInfo: () => ({ homedir: c.casa }), cwd: fuera, err: () => {} });
  assert.strictEqual(codigo, 0);
  const hasta = Date.now() + 8000;
  while (!fs.existsSync(marca) && Date.now() < hasta) await new Promise((r) => setTimeout(r, 200));
  assert.ok(fs.existsSync(marca), 'el node de fondo arrancó su nieto después de que terminó la ejecución');
});

test('T6 SmokeRun_Messages_SayEjecucionAislada @story-8.321 @ac-5', () => {
  const texto = fs.readFileSync(SMOKE, 'utf8');
  assert.doesNotMatch(texto, /corrida aislada/);
  assert.match(texto, /ejecución aislada/);
});
