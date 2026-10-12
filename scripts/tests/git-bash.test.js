'use strict';
/**
 * git-bash.test.js — dónde está el bash de Git for Windows, probado sin Windows (story 8.17, tanda W1).
 *
 * `scripts/lib/git-bash.js` recibe la plataforma, las variables de entorno y el sistema de archivos por parámetro:
 * acá se le inyectan los de un Windows de mentira y se recorre cada rama. Lo que sólo se ve en un Windows de verdad
 * (qué trae el PATH de una sesión, si la ruta hallada corre) lo mide el pipeline de Windows.
 *
 * El caso que la función existe para evitar: en Windows hay DOS `bash.exe` que no son el de Git —el de `System32` y
 * el alias de `WindowsApps`—, los dos son el lanzador de WSL, y los dos pueden estar antes en el PATH. Lanzar `bash`
 * a secas puede abrir una distribución de Linux que no ve las rutas `C:/…` del arnés.
 *
 * No usa bash ni toca el disco de la máquina (salvo el caso «fuera de Windows», que mira el PATH real).
 *
 * Correr:   node scripts/tests/git-bash.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, '..', 'lib', 'git-bash.js');
const { findGitBash, isWslLauncher, ENV_VAR } = require(MODULE);

const GIT_ROOT = 'C:\\Program Files\\Git';
const GIT_BASH = `${GIT_ROOT}\\bin\\bash.exe`;
const WSL_SYSTEM32 = 'C:\\Windows\\System32\\bash.exe';
const WSL_ALIAS = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';
const BASE_ENV = {
  SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
};

/** Un Windows de mentira: `files` es lo único que existe (sin distinguir mayúsculas, como en Windows). */
function windows(files, env) {
  const present = new Set(files.map((f) => f.toLowerCase()));
  const asked = [];
  return {
    asked,
    ctx: {
      platform: 'win32',
      env: { ...BASE_ENV, ...env },
      exists: (p) => { asked.push(p); return present.has(String(p).toLowerCase()); },
    },
  };
}
const pathOf = (...dirs) => dirs.join(';');

// ── T18 · AC 13, 18 ───────────────────────────────────────────────────────────────────────────────────────────────
test('T18a GitBash_Find_Env — la variable manda: su bash.exe gana aunque haya git en el PATH', () => {
  const custom = 'D:\\herramientas\\git\\bin\\bash.exe';
  const w = windows([custom, GIT_BASH, `${GIT_ROOT}\\cmd\\git.exe`], { [ENV_VAR]: custom, Path: pathOf(`${GIT_ROOT}\\cmd`) });
  assert.deepStrictEqual(findGitBash(w.ctx), { path: custom, source: 'env', reason: null });
  // en Windows el nombre de una variable no distingue mayúsculas: escrita en minúsculas es la misma variable
  const lower = windows([custom, GIT_BASH], { [ENV_VAR.toLowerCase()]: custom, Path: '' });
  assert.deepStrictEqual(findGitBash(lower.ctx), { path: custom, source: 'env', reason: null });
});

test('T18b GitBash_Find_Git — sin la variable, el bash.exe de la instalación del git que está en el PATH', () => {
  // git por su carpeta cmd (lo que deja el instalador en el PATH), con el lanzador de WSL ANTES en el PATH
  let w = windows([`${GIT_ROOT}\\cmd\\git.exe`, GIT_BASH, `${GIT_ROOT}\\usr\\bin\\bash.exe`, WSL_SYSTEM32],
    { Path: pathOf('C:\\Windows\\System32', `${GIT_ROOT}\\cmd`) });
  assert.deepStrictEqual(findGitBash(w.ctx), { path: GIT_BASH, source: 'git', reason: null });
  // git por mingw64\bin, en una carpeta que no es la de por defecto: la raíz está dos carpetas arriba
  const deep = 'E:\\Tools\\Git';
  w = windows([`${deep}\\mingw64\\bin\\git.exe`, `${deep}\\bin\\bash.exe`], { PATH: pathOf(`${deep}\\mingw64\\bin`) });
  assert.deepStrictEqual(findGitBash(w.ctx), { path: `${deep}\\bin\\bash.exe`, source: 'git', reason: null });
  // una instalación en otra unidad, sin bin\bash.exe: vale el de usr\bin
  const other = 'E:\\PortableGit';
  w = windows([`${other}\\cmd\\git.exe`, `${other}\\usr\\bin\\bash.exe`], { Path: pathOf(`${other}\\cmd`) });
  assert.deepStrictEqual(findGitBash(w.ctx), { path: `${other}\\usr\\bin\\bash.exe`, source: 'git', reason: null });
  // la variable de entorno del PATH se lee sin distinguir mayúsculas (`Path`, `PATH`, `path`)
  w = windows([`${GIT_ROOT}\\cmd\\git.exe`, GIT_BASH], { path: pathOf(`"${GIT_ROOT}\\cmd"`) });
  assert.strictEqual(findGitBash(w.ctx).path, GIT_BASH, 'y una entrada del PATH entre comillas también cuenta');
  // dos claves que sólo difieren en mayúsculas, una vacía: vale la que trae algo
  w = windows([`${GIT_ROOT}\\cmd\\git.exe`, GIT_BASH], { PATH: '', Path: pathOf(`${GIT_ROOT}\\cmd`), ProgramFiles: 'X:\\nada', LOCALAPPDATA: 'X:\\nada' });
  assert.deepStrictEqual(findGitBash(w.ctx), { path: GIT_BASH, source: 'git', reason: null });
});

test('T18c GitBash_Find_Defaults — sin la variable y sin git en el PATH, las dos carpetas de instalación por defecto', () => {
  let w = windows([GIT_BASH], { Path: 'C:\\Windows\\System32' });
  assert.deepStrictEqual(findGitBash(w.ctx), { path: GIT_BASH, source: 'default', reason: null });
  const perUser = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
  w = windows([perUser], { Path: '' });
  assert.deepStrictEqual(findGitBash(w.ctx), { path: perUser, source: 'default', reason: null });
  // un Node de 32 bits ve `ProgramFiles` como la carpeta (x86): la de 64 bits la da `ProgramW6432`
  w = windows([GIT_BASH], { Path: '', ProgramFiles: 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files' });
  assert.deepStrictEqual(findGitBash(w.ctx), { path: GIT_BASH, source: 'default', reason: null });
  // el orden: variable → git del PATH → por defecto
  const custom = 'D:\\g\\bin\\bash.exe';
  const otherGit = 'E:\\Git';
  w = windows([custom, `${otherGit}\\cmd\\git.exe`, `${otherGit}\\bin\\bash.exe`, GIT_BASH], { Path: pathOf(`${otherGit}\\cmd`) });
  assert.strictEqual(findGitBash(w.ctx).source, 'git', 'con git en el PATH no se llega a las carpetas por defecto');
  assert.strictEqual(findGitBash(w.ctx).path, `${otherGit}\\bin\\bash.exe`);
});

test('T18d GitBash_NeverSystem32 — el lanzador de WSL no se devuelve nunca: ni por el PATH, ni por la variable', () => {
  // sólo el lanzador de WSL (los dos: System32 y el alias de WindowsApps)
  let w = windows([WSL_SYSTEM32, WSL_ALIAS], { Path: pathOf('C:\\Windows\\System32', 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps') });
  let r = findGitBash(w.ctx);
  assert.strictEqual(r.path, null);
  assert.strictEqual(r.source, null);
  assert.match(r.reason, /sólo está el lanzador de WSL/);
  assert.match(r.reason, /System32\\bash\.exe/, 'el motivo dice cuál encontró');
  // la variable apuntando al lanzador: no se acepta, y el motivo lo dice
  w = windows([WSL_SYSTEM32], { [ENV_VAR]: WSL_SYSTEM32, Path: 'C:\\Windows\\System32' });
  r = findGitBash(w.ctx);
  assert.strictEqual(r.path, null);
  assert.match(r.reason, new RegExp(`${ENV_VAR}.*lanzador de WSL`));
  // un git.exe al lado del lanzador no convierte al lanzador en el bash de Git: el bash nunca se toma del PATH, se
  // arma desde la raíz de la instalación de git (`<raíz>\bin\bash.exe`), y el lanzador no vive en un `bin`
  w = windows(['C:\\Windows\\System32\\git.exe', WSL_SYSTEM32], { Path: 'C:\\Windows\\System32' });
  r = findGitBash(w.ctx);
  assert.strictEqual(r.path, null);
  assert.match(r.reason, /el bash que aparece en el PATH es el lanzador de WSL \(C:\\Windows\\System32\\bash\.exe\)/);
  // y con Git instalado Y el lanzador primero en el PATH (lo medido en el agente), gana el de Git
  w = windows([WSL_SYSTEM32, WSL_ALIAS, `${GIT_ROOT}\\cmd\\git.exe`, GIT_BASH],
    { Path: pathOf('C:\\Windows\\System32', 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps', `${GIT_ROOT}\\cmd`) });
  assert.strictEqual(findGitBash(w.ctx).path, GIT_BASH);
  // con SystemRoot en otra unidad o en otra forma de escribirlo
  assert.strictEqual(isWslLauncher('D:\\WINNT\\system32\\BASH.EXE', { SystemRoot: 'D:\\WINNT' }), true);
  assert.strictEqual(isWslLauncher('C:/Windows/System32/bash.exe', BASE_ENV), true, 'con barras hacia adelante también');
  assert.strictEqual(isWslLauncher('C:\\Windows\\Sysnative\\bash.exe', BASE_ENV), true);
  assert.strictEqual(isWslLauncher(WSL_ALIAS, BASE_ENV), true);
  assert.strictEqual(isWslLauncher(GIT_BASH, BASE_ENV), false);
  // tres maneras de colarle el lanzador a la variable, que tampoco pasan: con el prefijo de ruta larga, con Windows en
  // otra unidad y sin SystemRoot en el entorno, y por el alias SysWOW64
  for (const sneaky of ['\\\\?\\C:\\Windows\\System32\\bash.exe', 'D:\\WINNT\\System32\\bash.exe', 'C:\\Windows\\SysWOW64\\bash.exe']) {
    const x = findGitBash({ platform: 'win32', env: { [ENV_VAR]: sneaky, Path: '' }, exists: (p) => p === sneaky });
    assert.strictEqual(x.path, null, `${sneaky} es el lanzador de WSL`);
    assert.match(x.reason, /lanzador de WSL/);
  }
});

test('T18e GitBash_NullWithReason — sin nada, null con su motivo; una variable que apunta a nada lo dice y sigue buscando', () => {
  let w = windows([], { Path: 'C:\\Windows' });
  let r = findGitBash(w.ctx);
  assert.deepStrictEqual({ path: r.path, source: r.source }, { path: null, source: null });
  assert.match(r.reason, /falta Git for Windows/);
  assert.doesNotMatch(r.reason, /lanzador de WSL/, 'sin lanzador a la vista no lo nombra');
  assert.match(r.reason, new RegExp(ENV_VAR), 'y dice cómo indicarle dónde está');
  // 🔴 hay git en el PATH pero sin su bash.exe al lado (una instalación mínima, o git por atajos): el motivo no puede
  // decir «no hay git en el PATH» — mandaría a instalar lo que ya está
  w = windows(['C:\\MinGit\\cmd\\git.exe'], { Path: 'C:\\MinGit\\cmd' });
  r = findGitBash(w.ctx);
  assert.strictEqual(r.path, null);
  assert.match(r.reason, /hay git en C:\\MinGit\\cmd, pero no su bash\.exe/);
  assert.doesNotMatch(r.reason, /no hay git en el PATH/);
  assert.match(r.reason, new RegExp(ENV_VAR), 'y dice cómo indicarle dónde está');
  w = windows(['C:\\Users\\dev\\scoop\\shims\\git.exe', 'C:\\Users\\dev\\scoop\\apps\\git\\current\\bin\\bash.exe'], { Path: 'C:\\Users\\dev\\scoop\\shims' });
  r = findGitBash(w.ctx);
  assert.strictEqual(r.path, null, 'por atajos no se adivina dónde está la instalación');
  assert.match(r.reason, /hay git en C:\\Users\\dev\\scoop\\shims, pero no su bash\.exe/);
  // un contexto inyectado raro no revienta: valores que no son texto, y un `exists` que tira
  assert.doesNotThrow(() => findGitBash({ platform: 'win32', env: { Path: 7, ProgramFiles: 5, LOCALAPPDATA: {}, [ENV_VAR]: 3 }, exists: () => false }));
  r = findGitBash({ platform: 'win32', env: { Path: `${GIT_ROOT}\\cmd` }, exists: () => { throw new Error('disco roto'); } });
  assert.strictEqual(r.path, null, 'un «no pude mirar» del disco se lee como «no está», con su motivo');
  assert.ok(r.reason);
  // sin PATH y sin las variables de las carpetas por defecto: tampoco revienta
  r = findGitBash({ platform: 'win32', env: {}, exists: () => false });
  assert.strictEqual(r.path, null);
  assert.ok(r.reason);
  // la variable apunta a un archivo que no existe: no se devuelve a ciegas; si hay otro, se usa y no hay motivo
  w = windows([`${GIT_ROOT}\\cmd\\git.exe`, GIT_BASH], { [ENV_VAR]: 'D:\\no\\existe\\bash.exe', Path: `${GIT_ROOT}\\cmd` });
  assert.deepStrictEqual(findGitBash(w.ctx), { path: GIT_BASH, source: 'git', reason: null });
  // …y si no hay otro, el motivo nombra la variable
  w = windows([], { [ENV_VAR]: 'D:\\no\\existe\\bash.exe', Path: '' });
  assert.match(findGitBash(w.ctx).reason, new RegExp(`${ENV_VAR}.*D:\\\\no\\\\existe\\\\bash\\.exe.*no existe`));
});

test('T18f GitBash_OutsideWindows — fuera de Windows devuelve el bash del PATH, y la variable no cuenta', () => {
  const ctx = {
    platform: 'linux',
    env: { PATH: '/opt/bin:/usr/local/bin:/usr/bin', [ENV_VAR]: '/otro/bash' },
    exists: (p) => p === '/usr/local/bin/bash' || p === '/usr/bin/bash' || p === '/otro/bash',
  };
  assert.deepStrictEqual(findGitBash(ctx), { path: '/usr/local/bin/bash', source: 'path', reason: null });
  const none = findGitBash({ platform: 'darwin', env: { PATH: '/opt/bin' }, exists: () => false });
  assert.strictEqual(none.path, null);
  assert.match(none.reason, /no hay bash en el PATH/);
  // sin nada inyectado mira esta máquina: acá (Linux, Mac o Windows con Git) hay un bash, y existe
  const real = findGitBash();
  if (process.platform !== 'win32') {
    assert.ok(real.path && path.isAbsolute(real.path) && fs.existsSync(real.path), `el bash de esta máquina: ${JSON.stringify(real)}`);
    assert.strictEqual(real.source, 'path');
  } else {
    assert.ok(real.path === null ? real.reason : fs.existsSync(real.path), `en Windows: una ruta que existe, o null con su motivo: ${JSON.stringify(real)}`);
    if (real.path) assert.strictEqual(isWslLauncher(real.path, process.env), false, 'nunca el lanzador de WSL');
  }
});

test('T18g GitBash_PureLookup — con todo inyectado no toca process.platform ni el disco, y por línea de comandos contesta en JSON', () => {
  const w = windows([GIT_BASH, `${GIT_ROOT}\\cmd\\git.exe`], { Path: `${GIT_ROOT}\\cmd` });
  const before = process.platform;
  findGitBash(w.ctx);
  assert.strictEqual(process.platform, before);
  assert.ok(w.asked.length > 0 && w.asked.every((p) => /^[A-Z]:\\/i.test(p)), `sólo preguntó por rutas del Windows inyectado: ${JSON.stringify(w.asked)}`);
  const source = fs.readFileSync(MODULE, 'utf8');
  assert.doesNotMatch(source, /process\.platform\s*=[^=]/, 'no reasigna process.platform');
  const r = spawnSync(process.execPath, [MODULE, '--json'], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  assert.deepStrictEqual(Object.keys(j).sort(), ['path', 'platform', 'reason', 'source']);
  assert.strictEqual(r.status, j.path ? 0 : 1, 'sale 0 si lo encontró y 1 si no');
});
