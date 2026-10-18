'use strict';

/**
 * npm-package.test.js — la forma del paquete de npm que instala el arnés (story 8.40, tanda A · T3, T5, T10, T11, T12).
 *
 * El paquete (`scripts/setup/npm/`) es un INSTALADOR chico, no el arnés: un solo programa sin dependencias que baja la
 * versión publicada de GitHub y corre `harness.js install`. Lo que no se puede perder:
 *   · T3  — `npm pack --dry-run` lista exactamente package.json, index.js, home-paths.json, README.md y LICENSE (la copia el workflow);
 *           sin `dependencies`; el shebang en la línea 1; 420 líneas como mucho (con la detección de Claude Code y Codex); el repo de fábrica escrito UNA vez; el
 *           piso de Node para instalar en 22 (harness.js sigue en 20, sólo para actualizar); ningún hijo lanzado como `node` por nombre (siempre process.execPath);
 *           `--help` sale 0 sin red ni HOME y nombra el archivo que corre y dónde se ve la procedencia.
 *   · T5  — `requisites()` exportada: Windows pide pwsh 7 (con `winget install Microsoft.PowerShell`) y tar; fuera de
 *           Windows, bash, tar y python3 (éste salvo que se pida SÓLO Codex); ninguna variable de entorno cambia la
 *           plataforma; un Node por debajo del piso se nombra.
 *   · T10 — package.json: versión semver, bin `tycon-harness` → index.js, `files` con los cinco, Apache-2.0, el repo
 *           público, `publishConfig.access: public`, `engines.node` con el piso.
 *   · T11 — scripts/ci/npm-package-version.js: un cambio bajo scripts/setup/npm/ sin subir `version` es rojo con la línea
 *           «subí version»; con la subida, verde; un cambio que no toca la carpeta no la mira.
 *   · T12 — el README del paquete (la página de npmjs.com) dice lo que el paquete NO es.
 *   · T5b — (pase adversarial de la 8.40, clases 5 y 6) `--tool` se lee como lo lee install (tools.parseOption: comas,
 *           mayúsculas, espacios) y python3 se pide justo cuando install lo va a pedir; en una Mac sin las herramientas de
 *           línea de comandos, /usr/bin/python3 no cuenta (como get-harness.sh): se nombra con `xcode-select --install`.
 *   · T10c — (clase 8) la versión del paquete se rechaza si npm la rechaza o la normaliza: identificadores vacíos, ceros
 *           adelante, metadatos de build, más de 256 caracteres; lo que acepta, el semver de npm lo da por válido tal cual
 *           (si está en la máquina).
 *   · T5c — (segunda vuelta de revisores) un xcode-select que no se pudo correr (no está, o lo corta una señal) no
 *           afirma que faltan las herramientas; uno que corre y dice que no están, sí.
 *   · T36 — (clases 1 y 2) la dirección del repo del perfil se acepta con el MISMO criterio que parseTeam (team.js), con
 *           paridad caso por caso.
 *   · T37 — (clases 1, 2 y 3) corrido contra un GitHub de juguete y un harness.js de mentira: las URL de GitHub y la de
 *           clonar de Azure llegan a install --team; TYCON_AZURE_TOKEN se guarda (azure.token); la credencial de Azure
 *           del gestor de git alcanza (no se pide ni se sale 1), y sin ninguna se sale 1 antes de bajar.
 *   · T35b — (clase 9) un proxy https:// se habla por TLS (como curl), para un destino https (CONNECT) y uno http.
 *   · T40 — (segunda vuelta) un config.json que está y no se lee sale 1 nombrándolo, sin bajar ni instalar ni tocarlo;
 *           uno que no existe es «sin permiso guardado».
 *   · 8.46 T15 — la ayuda dice el defecto «para mí», `--audience team|org`, el plan corto y el único sí; no dice «sin
 *           valor por defecto».
 *   · 8.46 T44 — sin Claude Code ni Codex, la ayuda de index.js (que no puede cargar tools.js) es la misma que la de
 *           noneFound para cada sistema, y la detección da lo mismo que tools.detect en los mismos casos.
 *
 * Sin red: npm pack --dry-run no la usa (y se le cierra con npm_config_offline). Repos de juguete con git de verdad.
 * Correr: node --test scripts/tests/npm-package.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PKG_DIR = path.join(ROOT, 'scripts', 'setup', 'npm');
const INDEX = path.join(PKG_DIR, 'index.js');
const VERSION_TOOL = path.join(ROOT, 'scripts', 'ci', 'npm-package-version.js');
const read = (f) => fs.readFileSync(f, 'utf8');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

test('T3 NpmPackage_OneFile_NoDeps_Help', (t) => {
  const pkg = JSON.parse(read(path.join(PKG_DIR, 'package.json')));
  assert.strictEqual(pkg.dependencies, undefined, 'sin dependencies');
  assert.strictEqual(pkg.devDependencies, undefined, 'sin devDependencies');
  const src = read(INDEX);
  assert.strictEqual(src.split('\n')[0], '#!/usr/bin/env node', 'el shebang en la línea 1');
  assert.ok(src.split('\n').length <= 420, `index.js tiene ${src.split('\n').length} líneas (tope 420)`);
  assert.strictEqual((src.match(/^const REPO = '[^']+';/gm) || []).length, 1, 'el repo de fábrica, una sola vez');
  // el piso para INSTALAR es 22 (decisión del dueño, 2026-10-16); harness.js sigue en 20: lo tolera sólo para actualizar
  const floorHarness = /^const NODE_FLOOR = (\d+);/m.exec(read(path.join(ROOT, 'scripts', 'setup', 'harness.js')))[1];
  const floorPkg = /^const NODE_FLOOR = (\d+);/m.exec(src);
  assert.ok(floorPkg, 'index.js declara NODE_FLOOR');
  assert.strictEqual(floorPkg[1], '22', 'el piso del instalador es 22');
  assert.strictEqual(floorHarness, '20', 'harness.js sigue en 20 (actualizar una instalación existente)');
  assert.ok(!/spawnSync\(\s*['"]node['"]/.test(src) && !/spawn\(\s*['"]node['"]/.test(src) && !/execFileSync\(\s*['"]node['"]/.test(src), 'ningún hijo se lanza como `node` por nombre');
  assert.ok(/process\.execPath/.test(src), 'el hijo corre con process.execPath');
  assert.ok(!/require\(\s*['"](?!(fs|os|path|http|https|net|tls|tty|child_process|crypto|url|\.\/home-paths\.json)['"])/.test(src), 'sólo módulos del núcleo de Node y las rutas del paquete');
  // --help: sale 0 sin red ni HOME (una HOME que no existe y la red apuntada a un puerto cerrado)
  const h = spawnSync(process.execPath, [INDEX, '--help'], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: path.join(os.tmpdir(), 'no-existe-npm-help'), USERPROFILE: path.join(os.tmpdir(), 'no-existe-npm-help'), TYCON_RELEASE_API: 'http://127.0.0.1:9', TYCON_RELEASE_GIT: 'http://127.0.0.1:9', TYCON_RELEASE_ARCHIVE: 'http://127.0.0.1:9' }) });
  assert.strictEqual(h.status, 0, h.stderr);
  const out = h.stdout + h.stderr;
  assert.ok(out.includes(fs.realpathSync(INDEX)) || out.includes(INDEX), 'nombra el archivo que corre');
  assert.match(out, /Provenance/);
  assert.match(out, /npm view @tyconsa\/harness dist\.attestations/);
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'no-existe-npm-help')), '--help no creó la HOME');
  // npm pack --dry-run: exactamente los cinco (LICENSE lo copia el workflow antes de empaquetar)
  const npm = spawnSync(npmBin, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (npm.status !== 0) { t.diagnostic('NO MEDIDO: no hay npm en esta máquina (la lista del paquete)'); return; }
  const box = tmp('npm-pack-');
  try {
    for (const f of ['package.json', 'index.js', 'home-paths.json', 'README.md']) fs.copyFileSync(path.join(PKG_DIR, f), path.join(box, f));
    fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(box, 'LICENSE'));
    fs.writeFileSync(path.join(box, 'sobra.txt'), 'no tiene que entrar al paquete\n');
    const r = spawnSync(npmBin, ['pack', '--dry-run', '--json'], { cwd: box, encoding: 'utf8', shell: process.platform === 'win32', env: Object.assign({}, process.env, { npm_config_offline: 'true', npm_config_cache: path.join(box, '.npm-cache'), npm_config_update_notifier: 'false' }) });
    assert.strictEqual(r.status, 0, r.stderr);
    const files = JSON.parse(r.stdout)[0].files.map((f) => f.path).sort();
    assert.deepStrictEqual(files, ['LICENSE', 'README.md', 'home-paths.json', 'index.js', 'package.json']);
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

test('T5 NpxInstaller_Requisites_PerPlatform', () => {
  const I = require(INDEX);
  assert.strictEqual(typeof I.requisites, 'function', 'requisites() exportada');
  const have = (...names) => (n) => names.includes(n);
  const NEW = '24.0.0';
  // Windows sin pwsh: lo nombra con el comando sugerido; tar sí está
  const win = I.requisites({ platform: 'win32', tools: have('tar'), nodeVersion: NEW, args: [] });
  assert.strictEqual(win.length, 1, JSON.stringify(win));
  assert.match(win[0], /pwsh/); assert.match(win[0], /7/); assert.match(win[0], /winget install Microsoft\.PowerShell/);
  assert.match(win[0], /no lo corro/);
  // en Windows no se piden bash ni python3
  assert.deepStrictEqual(I.requisites({ platform: 'win32', tools: have('tar', 'pwsh'), nodeVersion: NEW, args: [] }), []);
  // una Mac sin bash: lo nombra (brew)
  const mac = I.requisites({ platform: 'darwin', tools: have('tar', 'python3'), nodeVersion: NEW, args: [] });
  assert.strictEqual(mac.length, 1); assert.match(mac[0], /falta bash/); assert.match(mac[0], /brew install bash/);
  // sólo Codex: python3 no hace falta; Claude y Codex: sí
  assert.deepStrictEqual(I.requisites({ platform: 'darwin', tools: have('tar', 'bash'), nodeVersion: NEW, args: ['--tool', 'codex'] }), []);
  const both = I.requisites({ platform: 'darwin', tools: have('tar', 'bash'), nodeVersion: NEW, args: ['--tool', 'claude', '--tool', 'codex'] });
  assert.strictEqual(both.length, 1); assert.match(both[0], /python3/);
  // sin opciones (Claude Code por defecto): python3 es requisito
  assert.strictEqual(I.requisites({ platform: 'linux', tools: have('tar', 'bash'), nodeVersion: NEW, args: [] }).length, 1);
  // un Node viejo se nombra con la versión que hay y el piso (20 ya no alcanza para instalar)
  const old = I.requisites({ platform: 'darwin', tools: have('tar', 'bash', 'python3'), nodeVersion: '20.19.0', args: [] });
  assert.strictEqual(old.length, 1); assert.match(old[0], /20\.19\.0/); assert.match(old[0], new RegExp(String(I.NODE_FLOOR)));
  assert.deepStrictEqual(I.requisites({ platform: 'darwin', tools: have('tar', 'bash', 'python3'), nodeVersion: '22.0.0', args: [] }), [], 'Node 22 alcanza');
  // dos faltas: una línea por cada una
  assert.strictEqual(I.requisites({ platform: 'darwin', tools: have(), nodeVersion: NEW, args: [] }).length, 3);
  // Windows: tar por ruta absoluta (el de System32), nunca el primero que aparezca (CreateProcess mira antes la carpeta
  // actual): un tar.exe en el PATH no lo cumple, y la falta se dice
  assert.strictEqual(I.tarCmd({ SystemRoot: 'C:\\Windows' }, 'win32'), 'C:\\Windows\\System32\\tar.exe');
  assert.strictEqual(I.tarCmd({}, 'darwin'), 'tar');
  const box = tmp('npm-wintar-');
  try {
    fs.writeFileSync(path.join(box, 'tar.exe'), '');
    const noSys = I.requisites({ platform: 'win32', env: { PATH: box, PATHEXT: '.EXE', SystemRoot: path.join(box, 'no-existe') }, nodeVersion: NEW, args: [] });
    assert.ok(noSys.some((l) => /falta tar/.test(l)), `un tar.exe en el PATH no cuenta: ${JSON.stringify(noSys)}`);
    fs.mkdirSync(path.join(box, 'win', 'System32'), { recursive: true }); fs.writeFileSync(path.join(box, 'win', 'System32', 'tar.exe'), '');
    if (process.platform !== 'win32') {   // path.win32.join arma la ruta con «\»: sólo se puede pisar en un sistema de archivos de Windows
      assert.match(I.tarCmd({ SystemRoot: path.join(box, 'win') }, 'win32'), /System32\\tar\.exe$/);
    } else assert.ok(!I.requisites({ platform: 'win32', env: { PATH: '', SystemRoot: path.join(box, 'win') }, tools: null, nodeVersion: NEW, args: [] }).some((l) => /falta tar/.test(l)));
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
  // ninguna variable de entorno cambia la plataforma: la lee de process.platform (o del argumento), nada más
  const src = read(INDEX);
  assert.ok(!/(spawnSync|launch)\([^)]*?['"]tar['"]\s*,/.test(src), 'tar nunca por nombre suelto: siempre tarCmd()');
  assert.ok(!/env\.[A-Z_]*(PLATFORM|OSTYPE|\bOS\b)/.test(src) && !/process\.env\.OS\b/.test(src), 'la plataforma no sale de una variable');
});

test('T10 NpmPackage_VersionIsSemverAndStartsAt1', () => {
  const pkg = JSON.parse(read(path.join(PKG_DIR, 'package.json')));
  const VT = require(VERSION_TOOL);
  assert.strictEqual(pkg.name, '@tyconsa/harness');
  assert.ok(VT.parseSemver(pkg.version), `version semver: ${pkg.version}`);
  assert.ok(VT.compareSemver(pkg.version, '1.0.0') >= 0, 'desde 1.0.0');
  assert.deepStrictEqual(pkg.bin, { 'tycon-harness': 'index.js' });
  assert.deepStrictEqual([...pkg.files].sort(), ['LICENSE', 'README.md', 'home-paths.json', 'index.js', 'package.json']);
  assert.strictEqual(pkg.license, 'Apache-2.0');
  const remote = JSON.parse(read(path.join(ROOT, 'scripts', 'setup', 'public-remotes.json'))).remotes[0];
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url;
  assert.ok(repoUrl.replace(/^git\+/, '').replace(/\.git$/, '') === remote, `repository nombra el repo público (${remote}): ${repoUrl}`);
  assert.deepStrictEqual(pkg.publishConfig, { access: 'public' });
  const floor = /^const NODE_FLOOR = (\d+);/m.exec(read(INDEX))[1];   // el piso para instalar, el del propio instalador
  assert.strictEqual(pkg.engines.node, `>=${floor}`);
  // el repo de fábrica de index.js es el de public-remotes.json
  assert.ok(read(INDEX).includes(`const REPO = '${remote.replace(/^https:\/\/github\.com\//, '')}';`));
});

test('T10b NpmPackageVersion_PrereleaseComparedBySemver', () => {
  const { compareSemver } = require(VERSION_TOOL);
  // semver §11: cada identificador por separado; los numéricos por número; un numérico es menor que uno alfanumérico;
  // con todo igual, el que tiene más identificadores es mayor
  const less = [['1.0.0-alpha', '1.0.0-alpha.1'], ['1.0.0-alpha.1', '1.0.0-alpha.beta'], ['1.0.0-alpha.beta', '1.0.0-beta'],
    ['1.0.0-beta', '1.0.0-beta.2'], ['1.0.0-beta.2', '1.0.0-beta.11'], ['1.0.0-beta.11', '1.0.0-rc.1'], ['1.0.0-rc.1', '1.0.0'],
    ['1.0.0-alpha.2', '1.0.0-alpha.10'], ['1.0.0-9', '1.0.0-10'], ['1.0.0-10', '1.0.0-a']];
  for (const [a, b] of less) {
    assert.ok(compareSemver(a, b) < 0, `${a} < ${b}`);
    assert.ok(compareSemver(b, a) > 0, `${b} > ${a}`);
  }
  assert.strictEqual(compareSemver('1.0.0-rc.1', '1.0.0-rc.1'), 0, 'la misma versión');
  // con metadatos de build npm publica OTRA versión (los saca): no es una versión del paquete (pase adversarial, clase 8)
  assert.strictEqual(require(VERSION_TOOL).parseSemver('1.0.0-rc.1+build.5'), null);
});

/** Un repo de juguete con la carpeta del paquete en la base y una rama con `change` aplicado. */
function toyRepo(change) {
  const dir = tmp('npm-version-');
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=lab', '-c', 'user.email=lab@example.org', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', ...a], { encoding: 'utf8', env: Object.assign({}, process.env, { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }) });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'scripts', 'setup', 'npm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'setup', 'npm', 'package.json'), JSON.stringify({ name: '@tyconsa/harness', version: '1.0.0' }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'setup', 'npm', 'index.js'), '// uno\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'raíz\n');
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'rama');
  change(dir);
  g('add', '-A'); g('commit', '-q', '-m', 'cambio');
  return dir;
}
const runVersion = (dir) => spawnSync(process.execPath, [VERSION_TOOL, '--root', dir, '--range', 'main...rama'], { encoding: 'utf8' });

test('T11 NpmPackageVersion_ChangeWithoutBump_Red', () => {
  const dirs = [];
  try {
    const noBump = toyRepo((d) => fs.appendFileSync(path.join(d, 'scripts', 'setup', 'npm', 'index.js'), '// dos\n')); dirs.push(noBump);
    let r = runVersion(noBump);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /el paquete cambia: subí version en scripts\/setup\/npm\/package\.json/);
    const bump = toyRepo((d) => {
      fs.appendFileSync(path.join(d, 'scripts', 'setup', 'npm', 'index.js'), '// dos\n');
      fs.writeFileSync(path.join(d, 'scripts', 'setup', 'npm', 'package.json'), JSON.stringify({ name: '@tyconsa/harness', version: '1.0.1' }, null, 2) + '\n');
    }); dirs.push(bump);
    r = runVersion(bump);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const down = toyRepo((d) => fs.writeFileSync(path.join(d, 'scripts', 'setup', 'npm', 'package.json'), JSON.stringify({ name: '@tyconsa/harness', version: '0.9.0' }, null, 2) + '\n')); dirs.push(down);
    r = runVersion(down);
    assert.strictEqual(r.status, 1, 'una versión que baja es rojo');
    const bad = toyRepo((d) => fs.writeFileSync(path.join(d, 'scripts', 'setup', 'npm', 'package.json'), JSON.stringify({ name: '@tyconsa/harness', version: '1.0' }, null, 2) + '\n')); dirs.push(bad);
    r = runVersion(bad);
    assert.strictEqual(r.status, 1, 'una versión que no es semver es rojo');
    const other = toyRepo((d) => fs.appendFileSync(path.join(d, 'README.md'), 'otra línea\n')); dirs.push(other);
    r = runVersion(other);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /no toca scripts\/setup\/npm\//);
    // un rango que no resuelve no es verde
    r = spawnSync(process.execPath, [VERSION_TOOL, '--root', other, '--range', 'main...no-existe'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
  } finally { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
  // el paso de la CI pública: public-ci.sh lo corre con el rango, y no trata la carpeta como un proyecto de npm
  const ci = read(path.join(ROOT, 'scripts', 'ci', 'public-ci.sh'));
  assert.match(ci, /scripts\/ci\/npm-package-version\.js" --root "\$\{ROOT\}" --range "\$\{RANGE_BASE\}\.\.\.\$\{RANGE_TIP\}"/);
  assert.ok(!/\bnpm (test|install|ci)\b/.test(ci.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')), 'public-ci.sh no corre npm test/install/ci');
});

test('T12 NpmPackage_ReadmeSaysWhatItIsNot', () => {
  const text = read(path.join(PKG_DIR, 'README.md'));
  for (const want of ['no viene en el paquete', 'GitHub', 'plan', 'Provenance', 'get-harness.sh', 'get-harness.ps1',
    'npm view @tyconsa/harness dist.attestations', 'npx no comprueba la firma', '.npmrc', 'EACCES', 'Node 24']) {
    assert.ok(text.includes(want), `el README del paquete nombra «${want}»`);
  }
  assert.ok(!/npx (-y|--yes)\b/.test(text), 'el README no escribe npx -y / --yes');
  assert.ok(/npx @tyconsa\/harness@latest/.test(text), 'la línea lleva @latest');
});

// ── pase adversarial de la 8.40 (las clases confirmadas, como regresión) ─────────────────────────────────────────────

test('T5b NpxInstaller_Requisites_ToolLikeInstall_MacPythonStub', () => {
  const I = require(INDEX);
  const TL = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tools.js'));
  const NEW = '24.0.0';
  const have = (...names) => (n) => names.includes(n);
  // clase 6: python3 se pide justo cuando install instala Claude Code, leyendo --tool como lo lee install
  for (const args of [['--tool', 'codex', '--tool', 'CLAUDE'], ['--tool', 'Codex'], ['--tool', ' codex '], ['--tool', 'codex,claude'],
    ['--tool=CODEX'], ['--tool', 'codex'], ['--tool', 'claude'], ['--tool', 'Codex,'], ['--tool=codex', '--tool=Claude']]) {
    const values = args.flatMap((a, i) => (a === '--tool' ? [args[i + 1]] : (a.startsWith('--tool=') ? [a.slice(7)] : [])));
    const p = TL.parseOption(values);
    assert.ok(p.ok, `${JSON.stringify(args)}: install lo acepta`);
    const needsPython = !(p.tools.length === 1 && p.tools[0] === 'codex');
    const gate = I.requisites({ platform: 'darwin', tools: have('tar', 'bash'), nodeVersion: NEW, args, clt: true });
    assert.strictEqual(gate.some((l) => /python3/.test(l)), needsPython, `${JSON.stringify(args)}: install instala ${JSON.stringify(p.tools)}`);
  }
  // clase 5: en una Mac sin las herramientas de línea de comandos, /usr/bin/python3 sólo pide instalarlas
  const stub = (n) => (n === 'python3' ? '/usr/bin/python3' : ['tar', 'bash'].includes(n));
  const noClt = I.requisites({ platform: 'darwin', tools: stub, nodeVersion: NEW, args: [], clt: false });
  assert.strictEqual(noClt.length, 1, JSON.stringify(noClt));
  assert.match(noClt[0], /python3/); assert.match(noClt[0], /xcode-select --install/); assert.match(noClt[0], /no lo corro/);
  assert.deepStrictEqual(I.requisites({ platform: 'darwin', tools: stub, nodeVersion: NEW, args: [], clt: true }), [], 'con las herramientas, el de /usr/bin vale');
  assert.deepStrictEqual(I.requisites({ platform: 'darwin', tools: (n) => (n === 'python3' ? '/opt/homebrew/bin/python3' : true), nodeVersion: NEW, args: [], clt: false }), [], 'otro python3 primero en el PATH no depende de las herramientas');
  assert.deepStrictEqual(I.requisites({ platform: 'darwin', tools: stub, nodeVersion: NEW, args: ['--tool', 'codex'], clt: false }), [], 'sólo Codex no pide python3');
  assert.deepStrictEqual(I.requisites({ platform: 'linux', tools: stub, nodeVersion: NEW, args: [], clt: false }), [], 'fuera de la Mac no se mira');
});

test('T5c NpxInstaller_Requisites_XcodeSelectUnrunnable_NoClaim', (t) => {
  if (process.platform === 'win32') { t.diagnostic('NO MEDIDO: el xcode-select de mentira es un guion de shell'); return; }
  const I = require(INDEX);
  const stub = (n) => (n === 'python3' ? '/usr/bin/python3' : ['tar', 'bash'].includes(n));
  const dir = tmp('npx-xcode-');
  const before = process.env.PATH;
  const fake = (body) => { const bin = fs.mkdtempSync(path.join(dir, 'bin-')); const f = path.join(bin, 'xcode-select'); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`); fs.chmodSync(f, 0o755); return bin; };
  const gate = (PATH) => { process.env.PATH = PATH; try { return I.requisites({ platform: 'darwin', tools: stub, nodeVersion: '24.0.0', args: [] }); } finally { process.env.PATH = before; } };
  try {
    // no se pudo correr: no hay xcode-select en el PATH, o una señal lo corta. No sé si faltan: no lo afirmo
    assert.deepStrictEqual(gate(fs.mkdtempSync(path.join(dir, 'vacio-'))), [], 'sin xcode-select no se afirma que faltan las herramientas');
    assert.deepStrictEqual(gate(fake('kill -9 $$')), [], 'un xcode-select cortado por una señal no afirma que faltan');
    // corrió y dijo que no están: se nombran (el control)
    const no = gate(fake('exit 2'));
    assert.strictEqual(no.length, 1, JSON.stringify(no)); assert.match(no[0], /xcode-select --install/);
    assert.deepStrictEqual(gate(fake('echo /Library/Developer/CommandLineTools; exit 0')), [], 'con las herramientas, nada falta');
  } finally { process.env.PATH = before; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('T10c NpmPackageVersion_RejectsWhatNpmRejects', () => {
  const { parseSemver } = require(VERSION_TOOL);
  const bad = ['1.0.1-a..b', '1.0.1-a.', '1.0.1-.a', '1.0.1-01', '1.0.1-a.01', '1.0.0-', '1.0.0+', '1.0.0+a..b', '01.0.0', '1.00.0',
    '1.0.0-a b', `1.0.0-${'a'.repeat(260)}`, '9007199254740992.0.0', 'v1.0.0', ' 1.0.0', '1.0.0+build.01', '1.0.0-rc.1+b-2'];
  for (const v of bad) assert.strictEqual(parseSemver(v), null, `«${v.slice(0, 40)}» no es una versión que npm publique tal cual`);
  const good = ['1.0.0', '1.0.0-0', '1.0.0-0a', '1.0.0-alpha.0', '1.0.0-x-y.1', '1.0.0-rc.1', '10.20.30'];
  for (const v of good) assert.ok(parseSemver(v), `«${v}» es semver`);
  // paridad con el semver que trae npm (el que decide en `npm publish`), si se encuentra
  const root = spawnSync(npmBin, ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const semverDir = root.status === 0 ? path.join(root.stdout.trim(), 'npm', 'node_modules', 'semver') : '';
  if (!semverDir || !fs.existsSync(semverDir)) return;
  const semver = require(semverDir);
  for (const v of [...bad, ...good]) {
    if (parseSemver(v)) assert.strictEqual(semver.valid(v), v, `«${v}»: lo acepto y npm lo publica tal cual`);
  }
});

test('T36 NpxInstaller_TeamAddress_SameCriterionAsParseTeam', () => {
  const I = require(INDEX);
  const T = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team.js'));
  assert.strictEqual(typeof I.teamShape, 'function', 'teamShape() exportada');
  const cases = ['acme/team-profile', ' acme/team-profile ', 'https://github.com/acme/team-profile', 'https://github.com/acme/team-profile.git',
    'https://github.com/acme/team-profile/', 'https://GitHub.com/acme/team-profile.git', ['https://usuario', 'github.com/acme/team-profile'].join('@'),
    'https://dev.azure.com/acme/Proj/_git/team-profile', ['https://acme', 'dev.azure.com/acme/Proj/_git/team-profile'].join('@'),
    'https://dev.azure.com/acme/Proj/_git/team-profile/', 'https://dev.azure.com/acme/Proj/_git/team-profile.git',
    'https://DEV.AZURE.COM/acme/Mi%20Proyecto/_git/perfil', 'https://dev.azure.com/acme/Proyecto (uno)/_git/perfil',
    'https://dev.azure.com/acme/%2e%2e/_git/perfil', 'https://dev.azure.com/../acme/_git/perfil', 'https://dev.azure.com/acme/../_git/perfil',
    'https://dev.azure.com/acme/Pro<j/_git/perfil', 'https://dev.azure.com/acme/Proj/perfil', 'https://dev.azure.com/acme/Proj/_git/a/b',
    'acme/..', '../perfil', './.', 'acme', 'acme/perfil/extra', 'http://github.com/acme/perfil', 'https://gitlab.com/acme/perfil',
    'git@github.com:acme/perfil.git', '', 'acme/per fil', 'https://github.com/acme/..'];
  for (const c of cases) {
    const p = T.parseTeam(c);
    const mine = I.teamShape(c);
    assert.strictEqual(Boolean(mine), p.ok, `«${c}»: parseTeam dice ${p.ok}`);
    if (p.ok) { assert.strictEqual(mine.host, p.host, c); assert.strictEqual(mine.repo, p.repo, c); }
  }
});

/** El instalador del paquete corrido de verdad (sin terminal) contra un GitHub de juguete que sirve un harness.js de mentira. */
async function toyRun(box, args, extraEnv) {
  const http = require('http');
  const sha = 'a'.repeat(40);
  const tgz = path.join(box, 'arnes.tgz');
  if (!fs.existsSync(tgz)) {
    const top = path.join(box, 'src', 'example-harness-main', 'scripts', 'setup');
    fs.mkdirSync(top, { recursive: true });
    // anota cada llamada (argumentos y lo que recibe por stdin) y sale 0
    fs.writeFileSync(path.join(top, 'harness.js'), "const fs=require('fs');let i='';if(process.argv[2]==='config'){try{i=fs.readFileSync(0,'utf8')}catch(_){}}\nfs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({argv:process.argv.slice(2),input:i})+'\\n');\n");
    execFileSync('tar', ['-czf', tgz, '-C', path.join(box, 'src'), 'example-harness-main']);
  }
  const seen = [];
  const srv = http.createServer((q, r) => {
    seen.push(q.url);
    if (q.url.includes('/info/refs')) { r.writeHead(200); return r.end(Buffer.from(`001e# service=git-upload-pack\n0000003f${sha} refs/heads/main\n0000`, 'latin1')); }
    if (q.url.includes('/tar.gz/')) { r.writeHead(200); return r.end(fs.readFileSync(tgz)); }
    r.writeHead(404); r.end('{}');
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const home = fs.mkdtempSync(path.join(box, 'home-'));
  const log = path.join(home, 'fake.log');
  fs.writeFileSync(path.join(home, '.claude.json'), '{}');   // Claude Code «instalado» por su configuración: el instalador no frena por falta de agente
  const env = Object.assign({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), FAKE_LOG: log,
    TYCON_RELEASE_API: base, TYCON_RELEASE_GIT: base, TYCON_RELEASE_ARCHIVE: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig') }, extraEnv);
  if (process.platform === 'win32') for (const k of ['SystemRoot', 'PATHEXT']) env[k] = process.env[k];
  const child = require('child_process').spawn(process.execPath, [INDEX, ...args, '--tool', 'codex'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((res) => child.on('close', res));
  srv.close();
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { code, out, calls, seen, home };
}

test('T37 NpxInstaller_TeamForms_AzureCredential_Run', async () => {
  const box = tmp('npx-team-');
  try {
    const install = (r) => r.calls.find((c) => c.argv[0] === 'install');
    const teamOf = (r) => { const a = install(r).argv; return a[a.indexOf('--team') + 1]; };
    // clase 2: las formas de GitHub que acepta --team llegan a install, con el repo que lee parseTeam
    for (const form of ['https://github.com/acme/team-profile', 'https://GitHub.com/acme/team-profile.git', 'https://github.com/acme/team-profile/']) {
      const r = await toyRun(box, ['--team', form, '--yes'], {});
      assert.strictEqual(r.code, 0, `${form}: ${r.out}`);
      assert.strictEqual(teamOf(r), 'acme/team-profile', form);
      assert.ok(install(r).argv.includes('--defaults'), `${form}: install recibe --defaults (8.46 T3)`);
      assert.ok(r.seen.some((u) => u.startsWith('/acme/team-profile.git/info/refs')), `${form}: miró el repo del equipo antes de bajar`);
    }
    // clases 1 y 2: la URL de clonar de Azure (con usuario) y TYCON_AZURE_TOKEN: el permiso se guarda como azure.token
    const pat = ['permiso', 'azure', 'de', 'laboratorio'].join('-');
    let r = await toyRun(box, ['--team', ['https://acme', 'dev.azure.com/acme/Proj/_git/team-profile'].join('@'), '--yes'], { TYCON_AZURE_TOKEN: pat, TYCON_AZURE_GIT_CREDENTIAL: '0' });
    assert.strictEqual(r.code, 0, r.out);
    const saved = r.calls.find((c) => c.argv.join(' ') === 'config set azure.token');
    assert.ok(saved && saved.input === pat, `TYCON_AZURE_TOKEN guardado con config set azure.token: ${JSON.stringify(r.calls)}`);
    assert.strictEqual(teamOf(r), 'https://dev.azure.com/acme/Proj/_git/team-profile');
    assert.ok(!r.out.includes(pat), 'el permiso no sale en pantalla');
    // sin credencial de ninguna clase: sale 1 antes de bajar (el control)
    r = await toyRun(box, ['--team', 'https://dev.azure.com/acme/Proj/_git/team-profile/', '--yes'], { TYCON_AZURE_GIT_CREDENTIAL: '0' });
    assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /permiso de Azure DevOps/); assert.ok(!install(r), 'no instaló');
    // clase 3: la credencial de Azure en el gestor de credenciales de git alcanza, como en install --team (team-azure.credential)
    if (spawnSync('git', ['--version']).status !== 0) return;
    const creds = path.join(box, 'git-credentials');
    fs.writeFileSync(creds, `https://usuario:${['otro', 'permiso', 'azure'].join('-')}@dev.azure.com\n`);
    const gitconfig = path.join(box, 'gitconfig-store');
    fs.writeFileSync(gitconfig, `[credential]\n\thelper = store --file=${creds.replace(/\\/g, '/')}\n`);
    r = await toyRun(box, ['--team', 'https://dev.azure.com/acme/Proj/_git/team-profile', '--yes'], { GIT_CONFIG_GLOBAL: gitconfig });
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(install(r), 'siguió a install --team');
    assert.ok(!r.calls.some((c) => c.argv.includes('azure.token')), 'no guardó nada: install la lee del gestor de git');
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

test('T35b NpxInstaller_HttpsProxy_SpeaksTls', async (t) => {
  const tls = require('tls'); const net = require('net'); const http = require('http'); const https = require('https');
  const dir = tmp('npx-tlsproxy-');
  try {
    const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
    const o = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
    if (o.status !== 0) { t.diagnostic('NO MEDIDO: sin openssl para el certificado de juguete'); return; }
    const pem = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    const listen = (s) => new Promise((res) => s.listen(0, '127.0.0.1', () => res(s.address().port)));
    const target = https.createServer(pem, (q, r) => { r.writeHead(200); r.end(`seguro ${q.url}`); });
    const plain = http.createServer((q, r) => { r.writeHead(200); r.end(`plano ${q.url}`); });
    const lines = [];
    // el proxy habla TLS: CONNECT para https, forma absoluta para http
    const proxy = tls.createServer(pem, (sock) => {
      sock.on('error', () => {});
      sock.once('data', (d) => {
        const head = d.toString('latin1'); const [method, where] = head.split('\r\n')[0].split(' '); lines.push(`${method} ${where}`);
        if (method === 'CONNECT') {
          const [h, p] = where.split(':');
          const up = net.connect(Number(p), h, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
          return up.on('error', () => sock.destroy());
        }
        const u = new URL(where);
        const up = net.connect(Number(u.port), u.hostname, () => { up.write(`${method} ${u.pathname} HTTP/1.1\r\n${head.slice(head.indexOf('\r\n') + 2)}`); up.pipe(sock); sock.pipe(up); });
        up.on('error', () => sock.destroy());
      });
    });
    const [tp, pp, hp] = [await listen(target), await listen(proxy), await listen(plain)];
    const probe = "const I=require(process.argv[1]);I.get(process.argv[2],{env:process.env,accept:'*/*'}).then((r)=>console.log(`${r.status} ${r.body}`),(e)=>{console.log(`ERR ${e.message}`);process.exit(1)})";
    const run = (url) => new Promise((res) => {
      const c = require('child_process').spawn(process.execPath, ['-e', probe, INDEX, url], { env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: cert, HTTPS_PROXY: `https://127.0.0.1:${pp}`, HTTP_PROXY: `https://127.0.0.1:${pp}` }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
      c.on('close', (code) => res({ code, out: out.trim() }));
    });
    try {
      const a = await run(`https://127.0.0.1:${tp}/tunel`);
      assert.strictEqual(a.out, '200 seguro /tunel', a.out);
      assert.ok(lines.includes(`CONNECT 127.0.0.1:${tp}`), JSON.stringify(lines));
      const b = await run(`http://127.0.0.1:${hp}/directo`);
      assert.strictEqual(b.out, '200 plano /directo', b.out);
      assert.ok(lines.includes(`GET http://127.0.0.1:${hp}/directo`), JSON.stringify(lines));
    } finally { target.close(); proxy.close(); plain.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('T40 NpxInstaller_SavedConfigUnreadable_Exits1_KeepsFile', async () => {
  const box = tmp('npx-config-');
  try {
    for (const [what, text] of [['no es JSON', '{"github": {"token": '], ['no es un objeto', 'null\n']]) {
      const own = fs.mkdtempSync(path.join(box, 'tycon-'));
      const f = path.join(own, 'config.json');
      fs.writeFileSync(f, text);
      const r = await toyRun(box, ['--yes'], { TYCON_HOME: own });
      assert.strictEqual(r.code, 1, `${what}: ${r.out}`);
      assert.ok(r.out.includes(f), `${what}: nombra el archivo — ${r.out}`);
      assert.strictEqual(fs.readFileSync(f, 'utf8'), text, `${what}: el archivo queda como estaba`);
      assert.ok(!r.calls.length, `${what}: no corrió install ni config set — ${JSON.stringify(r.calls)}`);
      assert.ok(!r.seen.some((u) => u.includes('/tar.gz/')), `${what}: no bajó nada — ${JSON.stringify(r.seen)}`);
    }
    // el control: sin config.json (ENOENT) es «sin permiso guardado», e instala
    const r = await toyRun(box, ['--yes'], { TYCON_HOME: fs.mkdtempSync(path.join(box, 'tycon-')) });
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(r.calls.some((c) => c.argv[0] === 'install'), JSON.stringify(r.calls));
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

// T43 (el cierre, AC 36): el instalador corre antes de que exista el arnés y no puede cargar tycon-home.js; sus rutas viven
// en home-paths.json y tienen que ser las MISMAS que resuelve tycon-home.js, con la casa propia y sin ella, y con TYCON_HOME
test('T43 NpmPackage_HomePaths_ParityWithTyconHome', () => {
  const HP = JSON.parse(read(path.join(PKG_DIR, 'home-paths.json')));
  const TH = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));
  const STATE_FILE = 'harness-state.json';
  const I = require(INDEX);
  assert.deepStrictEqual(I.HP, HP, 'index.js lee el mismo home-paths.json');
  assert.strictEqual(I.ownRoot({ TYCON_HOME: '/x/y' }), '/x/y', 'ownRoot de index.js honra TYCON_HOME');
  assert.strictEqual(I.ownRoot({}), path.join(os.homedir(), HP.own_dir), 'ownRoot de index.js sin TYCON_HOME');
  const ours = (home, env = {}) => {   // lo que arma index.js con home-paths.json, con su HOME de juguete
    const own = env[HP.own_env] || path.join(home, HP.own_dir);
    return { ownState: path.join(own, ...HP.own_state.split('/')), ownConfig: path.join(own, ...HP.own_config.split('/')), legacyState: path.join(home, ...HP.legacy_state.split('/')) };
  };
  const saved = process.env.TYCON_HOME;
  const box = tmp('home-paths-');
  try {
    delete process.env.TYCON_HOME;
    const fresh = path.join(box, 'sin-casa'); fs.mkdirSync(fresh);
    assert.strictEqual(ours(fresh).legacyState, path.join(TH.stateDir(fresh), STATE_FILE), 'sin la casa propia, el estado es el de siempre');
    const own = path.join(box, 'con-casa'); fs.mkdirSync(path.join(own, '.tycon', 'state'), { recursive: true });
    assert.strictEqual(ours(own).ownState, path.join(TH.stateDir(own), STATE_FILE), 'con la casa propia, el estado es el de ~/.tycon');
    assert.strictEqual(ours(own).ownConfig, TH.configFile(own), 'la configuración de la casa propia');
    const elsewhere = path.join(box, 'otra-casa'); fs.mkdirSync(path.join(elsewhere, 'state'), { recursive: true });
    process.env.TYCON_HOME = elsewhere;
    assert.strictEqual(ours(own, { TYCON_HOME: elsewhere }).ownState, path.join(TH.stateDir(own), STATE_FILE), 'con TYCON_HOME, el estado es el de esa carpeta');
    assert.strictEqual(HP.own_env, 'TYCON_HOME');
    assert.strictEqual(HP.own_dir, TH.OWN_DIR_NAME);
    // la ruta vieja está declarada en legacy-home-names.json (se retira con la 8.24)
    const legacy = JSON.parse(read(path.join(ROOT, 'scripts', 'tests', 'fixtures', 'legacy-home-names.json')));
    assert.ok([...(legacy.entries || []), ...(legacy.until_d || [])].some((e) => e.path === 'scripts/setup/npm/home-paths.json'), 'home-paths.json declarado en legacy-home-names.json');
    // el espejo: una ruta cambiada sale distinta
    const bad = Object.assign({}, HP, { own_state: 'estado/harness-state.json' });
    assert.notStrictEqual(path.join(own, '.tycon', ...bad.own_state.split('/')), path.join(TH.stateDir(own), STATE_FILE));
  } finally {
    if (saved === undefined) delete process.env.TYCON_HOME; else process.env.TYCON_HOME = saved;
    fs.rmSync(box, { recursive: true, force: true });
  }
  // index.js no arma las rutas a mano: las lee de home-paths.json
  const src = read(INDEX);
  assert.match(src, /require\('\.\/home-paths\.json'\)/);
  assert.ok(!/'\.tycon-pipeline'|'harness-state\.json'|'config\.json'/.test(src), 'ninguna ruta del estado escrita a mano en index.js');
});

test('8.46 T15 NpxInstaller_Help_DefaultsForMe_OneYes', () => {
  const h = spawnSync(process.execPath, [INDEX, '--help'], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: path.join(os.tmpdir(), 'no-existe-npm-help'), USERPROFILE: path.join(os.tmpdir(), 'no-existe-npm-help') }) });
  assert.strictEqual(h.status, 0, h.stderr);
  const out = h.stdout + h.stderr;
  assert.match(out, /para m[ií]/, 'nombra «para mí» como defecto');
  assert.match(out, /--audience team\|org/, 'nombra --audience team|org');
  assert.match(out, /cinco renglones/, 'dice el plan corto');
  assert.match(out, /¿Instalo\? \[s\/N\]/, 'dice el único sí');
  assert.ok(!/sin valor por defecto/.test(out), 'no dice «sin valor por defecto»');
});

test('8.46 T44 NpxInstaller_AgentHelpAndDetection_SameAsTools', () => {
  const I = require(INDEX);
  const T = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tools.js'));
  for (const p of ['darwin', 'linux', 'win32']) {
    assert.deepStrictEqual(I.agentLines(p), T.agentLines(p), `las órdenes de ${p}: las mismas en index.js y en tools.js`);
    const text = I.agentLines(p).join('\n');
    assert.match(text, /Claude Code/); assert.match(text, /Codex/);
    assert.match(text, p === 'win32' ? /irm https:\/\/claude\.ai\/install\.ps1 \| iex/ : /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
    assert.match(text, p === 'win32' ? /chatgpt\.com\/codex\/install\.ps1/ : /curl -fsSL https:\/\/chatgpt\.com\/codex\/install\.sh \| sh/);
    assert.ok(T.noneFound(p).includes(I.agentLines(p)[0]), `noneFound(${p}) trae las órdenes`);
  }
  const box = tmp('agent-detect-');
  try {
    const bin = path.join(box, 'bin'); fs.mkdirSync(bin);
    const cases = {
      ninguna: () => {},
      claudeEnElPath: (h) => { const f = path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude'); fs.writeFileSync(f, ''); fs.chmodSync(f, 0o755); },
      claudeJson: (h) => fs.writeFileSync(path.join(h, '.claude.json'), '{}'),
      codexAuth: (h) => { fs.mkdirSync(path.join(h, '.codex')); fs.writeFileSync(path.join(h, '.codex', 'auth.json'), '{}'); },
      soloLoDesplegado: (h) => { fs.mkdirSync(path.join(h, '.codex')); fs.writeFileSync(path.join(h, '.codex', 'hooks.json'), '{}'); fs.mkdirSync(path.join(h, '.claude')); fs.writeFileSync(path.join(h, '.claude', 'settings.json'), '{}'); },
    };
    for (const [name, make] of Object.entries(cases)) {
      const home = path.join(box, name); fs.mkdirSync(home);
      for (const f of fs.readdirSync(bin)) fs.rmSync(path.join(bin, f));
      make(home);
      const env = { TYCON_TOOLS_DETECT_PATH: bin, PATH: '' };
      const d = T.detect({ home, env, platform: process.platform });
      const want = d.claude.installed || d.codex.installed;
      assert.strictEqual(I.agentFound({ home, env, platform: process.platform }), want, `${name}: index.js dice lo mismo que tools.detect (${want})`);
    }
    // en Windows la carpeta personal es USERPROFILE aunque HOME diga otra (como os.homedir())
    const real = path.join(box, 'perfil-real'); fs.mkdirSync(real); fs.writeFileSync(path.join(real, '.claude.json'), '{}');
    assert.strictEqual(I.agentFound({ env: { USERPROFILE: real, HOME: path.join(box, 'otra'), TYCON_TOOLS_DETECT_PATH: '' }, platform: 'win32' }), true, 'win32: mira USERPROFILE');
    assert.strictEqual(I.agentFound({ env: { USERPROFILE: path.join(box, 'otra'), HOME: real, TYCON_TOOLS_DETECT_PATH: '' }, platform: 'linux' }), true, 'fuera de Windows: mira HOME');
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});
