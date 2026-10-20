'use strict';

/**
 * npm-package.test.js — el paquete de npm que arranca el instalador del arnés: baja el árbol publicado y le pasa el
 * trabajo a su `harness.js npx`. Lo que no se puede perder:
 *   · T1  — corrido contra un GitHub de juguete, baja la punta y corre `harness.js npx` del árbol bajado con las
 *           opciones tal cual, con el mismo Node y con el commit y el repo en el entorno; sale con el código del hijo.
 *   · T2  — si el hijo sale distinto de 0, el paquete sale con ese código y la carpeta temporal no queda.
 *   · T3  — con un Node menor que el piso sale 1 sin un solo pedido a la red, con el comando sugerido.
 *   · T4  — un árbol bajado sin el subcomando `npx` (una punta vieja) sale 1 diciendo el motivo, sin correr nada.
 *   · T5  — el archivo tiene 200 líneas o menos, ningún `require` fuera del núcleo, no nombra su versión, el paquete
 *           trae los mismos archivos de hoy y su versión es 1.1.0.
 *   · 8.40 T3 — el shebang, el repo de fábrica una sola vez, el piso de Node en 22, ningún hijo lanzado como `node`,
 *           `--help` corto sin red ni HOME, y `--repo` o las variables de prueba mal escritos salen 2 sin red.
 *   · T10 / T10b / T10c — package.json: semver, bin, `files`, licencia, repo, acceso público, `engines.node` con el piso;
 *           el semver se compara y se rechaza como lo hace npm.
 *   · T11 — scripts/ci/npm-package-version.js: un cambio bajo scripts/setup/npm/ sin subir `version` es rojo.
 *   · T12 — el README dice lo que el paquete NO es.
 *   · T35b — un proxy https:// se habla por TLS (como curl), para un destino https (CONNECT) y uno http.
 *
 * Los requisitos, «para quién», `--team`, el agente instalado y el caso «ya instalado» viven en
 * scripts/tests/npx-entry.test.js (el subcomando `npx` del árbol).
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
const SHA = 'a'.repeat(40);
const FILES = ['LICENSE', 'README.md', 'home-paths.json', 'index.js', 'package.json'];

/**
 * El paquete corrido de verdad (sin terminal) contra un GitHub de juguete que sirve un árbol con un `harness.js` de
 * mentira, que anota cada llamada. Opciones: el entorno extra y `npx` (el árbol trae el subcomando, o no).
 */
async function toyRun(box, args, extraEnv = {}, { npx = true } = {}) {
  const script = INDEX;
  const http = require('http');
  const tgz = path.join(box, npx ? 'arnes.tgz' : 'arnes-vieja.tgz');
  if (!fs.existsSync(tgz)) {
    const setup = path.join(box, npx ? 'src-n' : 'src-v', 'example-harness-main', 'scripts', 'setup');
    fs.mkdirSync(path.join(setup, 'harness'), { recursive: true });
    // anota cada llamada (argumentos, Node, commit y repo del entorno, lo que recibe por stdin) y sale con FAKE_EXIT
    fs.writeFileSync(path.join(setup, 'harness.js'), [
      "const fs=require('fs');const a=process.argv.slice(2);let i='';",
      "if(a[0]==='config'){try{i=fs.readFileSync(0,'utf8')}catch(_){}}",
      "fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({argv:a,input:i,exec:process.execPath,file:__filename,commit:process.env.TYCON_NPX_COMMIT||null,repo:process.env.TYCON_NPX_REPO||null})+'\\n');",
      "process.exitCode=Number(process.env.FAKE_EXIT||0);", ''].join('\n'));
    if (npx) fs.writeFileSync(path.join(setup, 'harness', 'npx.js'), "'use strict';\n// el subcomando npx de juguete\n");
    execFileSync('tar', ['-czf', tgz, '-C', path.join(box, npx ? 'src-n' : 'src-v'), 'example-harness-main']);
  }
  const seen = [];
  const srv = http.createServer((q, r) => {
    seen.push(q.url);
    if (q.url.includes('/info/refs')) { r.writeHead(200); return r.end(Buffer.from(`001e# service=git-upload-pack\n0000003f${SHA} refs/heads/main\n0000`, 'latin1')); }
    if (q.url.includes('/tar.gz/')) { r.writeHead(200); return r.end(fs.readFileSync(tgz)); }
    r.writeHead(404); r.end('{}');
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const home = fs.mkdtempSync(path.join(box, 'home-'));
  const temp = fs.mkdtempSync(path.join(box, 'temp-'));   // la carpeta temporal del sistema de esta corrida: al final tiene que estar vacía
  const log = path.join(home, 'fake.log');
  fs.writeFileSync(path.join(home, '.claude.json'), '{}');
  const env = Object.assign({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: temp, TEMP: temp, TMP: temp, TYCON_HOME: path.join(home, '.tycon'), FAKE_LOG: log,
    TYCON_RELEASE_API: base, TYCON_RELEASE_GIT: base, TYCON_RELEASE_ARCHIVE: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig') }, extraEnv);
  if (process.platform === 'win32') for (const k of ['SystemRoot', 'PATHEXT']) env[k] = process.env[k];
  const child = require('child_process').spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((res) => child.on('close', res));
  srv.close();
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { code, out, calls, seen, home, left: fs.readdirSync(temp) };
}

test('T1 NpmPackage_Arranque_DelegaEnElArbol @story-8.80 @ac-1', async () => {
  const box = tmp('npm-arranque-');
  try {
    const args = ['--team', 'acme/team-profile', '--tool', 'codex', '--yes'];
    const r = await toyRun(box, args);
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(r.calls.length, 1, `un solo hijo: ${JSON.stringify(r.calls)}`);
    const c = r.calls[0];
    assert.deepStrictEqual(c.argv, ['npx', ...args], 'las opciones, tal cual, detrás de `npx`');
    assert.strictEqual(c.exec, process.execPath, 'el mismo Node');
    assert.ok(c.file.endsWith(path.join('scripts', 'setup', 'harness.js')), 'el harness.js del árbol bajado');
    assert.strictEqual(c.commit, SHA, 'el commit que bajó, en el entorno');
    assert.strictEqual(c.repo, 'TYCON-SA/tycon-harness', 'el repo, en el entorno');
    assert.ok(r.seen.some((u) => u.includes('/info/refs')) && r.seen.some((u) => u.includes(`/tar.gz/${SHA}`)), `bajó por las rutas públicas: ${JSON.stringify(r.seen)}`);
    assert.ok(!fs.existsSync(path.dirname(path.dirname(path.dirname(c.file)))), 'la carpeta del árbol bajado ya no está');
    assert.deepStrictEqual(r.left, [], 'la carpeta temporal se borró');
    // --repo propio: llega al hijo en el entorno y también en las opciones
    const own = await toyRun(box, ['--repo=acme/harness', '--yes']);
    assert.strictEqual(own.code, 0, own.out);
    assert.strictEqual(own.calls[0].repo, 'acme/harness');
    assert.deepStrictEqual(own.calls[0].argv, ['npx', '--repo=acme/harness', '--yes']);
    assert.ok(own.seen.some((u) => u.startsWith('/acme/harness.git/info/refs')), JSON.stringify(own.seen));
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

test('T2 NpmPackage_HijoFalla_BorraIgual @story-8.80 @ac-1', async () => {
  const box = tmp('npm-falla-');
  try {
    const r = await toyRun(box, ['--yes'], { FAKE_EXIT: '3' });
    assert.strictEqual(r.code, 3, r.out);
    assert.strictEqual(r.calls.length, 1);
    assert.deepStrictEqual(r.left, [], 'la carpeta temporal no quedó');
    assert.ok(!fs.existsSync(path.dirname(path.dirname(path.dirname(r.calls[0].file)))), 'el árbol bajado ya no está');
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

test('T3 NpmPackage_NodeViejo_NoBaja @story-8.80 @ac-2', async () => {
  const http = require('http');
  let hits = 0;
  const srv = http.createServer((q, r) => { hits++; r.writeHead(404); r.end('{}'); });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const I = require(INDEX);
  const write = process.stderr.write; let said = '';
  process.stderr.write = (s) => { said += s; return true; };
  let code;
  try { code = await I.main(['--yes'], { PATH: process.env.PATH, TYCON_RELEASE_API: base, TYCON_RELEASE_GIT: base, TYCON_RELEASE_ARCHIVE: base }, '20.19.0'); }
  finally { process.stderr.write = write; srv.close(); }
  assert.strictEqual(code, 1, said);
  assert.strictEqual(hits, 0, 'ni un pedido al servidor');
  assert.match(said, /node 20\.19\.0/); assert.match(said, /Node 22 o más/); assert.match(said, /brew install node|nodejs\.org/, 'con el comando sugerido');
  assert.match(said, /no lo corro/, 'la sugerencia se imprime, nunca se corre');
});

test('T4 NpmPackage_PuntaVieja_LoDice @story-8.80 @ac-3', async () => {
  const box = tmp('npm-vieja-');
  try {
    const r = await toyRun(box, ['--yes'], {}, { npx: false });
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /la versión publicada todavía no sabe recibir este paquete/);
    assert.deepStrictEqual(r.calls, [], 'no corrió nada del árbol bajado');
    assert.deepStrictEqual(r.left, [], 'la carpeta temporal se borró también acá');
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

test('T5 NpmPackage_SinNumeroNiDependencias @story-8.80 @ac-4', (t) => {
  const pkg = JSON.parse(read(path.join(PKG_DIR, 'package.json')));
  const src = read(INDEX);
  assert.ok(src.split('\n').length <= 200, `index.js tiene ${src.split('\n').length} líneas (tope 200)`);
  assert.strictEqual(pkg.dependencies, undefined, 'sin dependencies');
  assert.strictEqual(pkg.devDependencies, undefined, 'sin devDependencies');
  assert.ok(!/require\(\s*['"](?!(fs|os|path|http|https|net|tls|tty|child_process|crypto|url)['"])/.test(src), 'sólo módulos del núcleo de Node');
  assert.ok(!/package\.json/.test(src) && !src.includes(pkg.version), 'no lee ni nombra el número de versión del paquete');
  assert.strictEqual(pkg.version, '1.1.0');
  const npm = spawnSync(npmBin, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (npm.status !== 0) { t.diagnostic('NO MEDIDO: no hay npm en esta máquina (la lista del paquete)'); return; }
  const box = tmp('npm-pack-');
  try {
    for (const f of ['package.json', 'index.js', 'home-paths.json', 'README.md']) fs.copyFileSync(path.join(PKG_DIR, f), path.join(box, f));
    fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(box, 'LICENSE'));
    fs.writeFileSync(path.join(box, 'sobra.txt'), 'no tiene que entrar al paquete\n');
    const r = spawnSync(npmBin, ['pack', '--dry-run', '--json'], { cwd: box, encoding: 'utf8', shell: process.platform === 'win32', env: Object.assign({}, process.env, { npm_config_offline: 'true', npm_config_cache: path.join(box, '.npm-cache'), npm_config_update_notifier: 'false' }) });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout)[0].files.map((f) => f.path).sort(), FILES, 'los mismos archivos de hoy');
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

test('8.40 T3 NpmPackage_Shebang_Floor_Help', () => {
  const src = read(INDEX);
  assert.strictEqual(src.split('\n')[0], '#!/usr/bin/env node', 'el shebang en la línea 1');
  assert.strictEqual((src.match(/^const REPO = '[^']+';/gm) || []).length, 1, 'el repo de fábrica, una sola vez');
  // el piso para INSTALAR es 22 (decisión del dueño, 2026-10-16); harness.js sigue en 20: lo tolera sólo para actualizar
  const floorHarness = /^const NODE_FLOOR = (\d+);/m.exec(read(path.join(ROOT, 'scripts', 'setup', 'harness.js')))[1];
  const floorPkg = /^const NODE_FLOOR = (\d+);/m.exec(src);
  assert.ok(floorPkg, 'index.js declara NODE_FLOOR');
  assert.strictEqual(floorPkg[1], '22', 'el piso del instalador es 22');
  assert.strictEqual(floorHarness, '20', 'harness.js sigue en 20 (actualizar una instalación existente)');
  assert.ok(!/spawnSync\(\s*['"]node['"]/.test(src) && !/spawn\(\s*['"]node['"]/.test(src) && !/execFileSync\(\s*['"]node['"]/.test(src), 'ningún hijo se lanza como `node` por nombre');
  assert.ok(/process\.execPath/.test(src), 'el hijo corre con process.execPath');
  assert.ok(!/(spawnSync|launch)\([^)]*?['"]tar['"]\s*,/.test(src), 'tar nunca por nombre suelto: siempre tarCmd()');
  // --help: sale 0 sin red ni HOME (una HOME que no existe y la red apuntada a un puerto cerrado), corto y propio
  const none = path.join(os.tmpdir(), 'no-existe-npm-help');
  const dead = { TYCON_RELEASE_API: 'http://127.0.0.1:9', TYCON_RELEASE_GIT: 'http://127.0.0.1:9', TYCON_RELEASE_ARCHIVE: 'http://127.0.0.1:9' };
  const h = spawnSync(process.execPath, [INDEX, '--help'], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: none, USERPROFILE: none }, dead) });
  assert.strictEqual(h.status, 0, h.stderr);
  const out = h.stdout + h.stderr;
  assert.ok(out.split('\n').length <= 14, 'una ayuda corta');
  assert.ok(out.includes(fs.realpathSync(INDEX)) || out.includes(INDEX), 'nombra el archivo que corre');
  assert.match(out, /harness\.js/, 'dice que el trabajo lo hace el instalador del arnés bajado');
  assert.match(out, /Provenance/);
  assert.match(out, /npm view @tyconsa\/harness dist\.attestations/);
  assert.ok(!fs.existsSync(none), '--help no creó la HOME');
  // --repo y las variables de prueba mal escritas: salen 2 sin tocar la red
  const bad = (args, env) => spawnSync(process.execPath, [INDEX, ...args], { encoding: 'utf8', env: Object.assign({}, process.env, dead, env) });
  for (const args of [['--repo', '../x'], ['--repo=acme/..'], ['--repo', 'sin-barra'], ['--repo']]) {
    const r = bad(args, {});
    assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stderr}`); assert.match(r.stderr, /--repo pide/);
  }
  const ftp = bad(['--yes'], { TYCON_RELEASE_API: 'ftp://x' });
  assert.strictEqual(ftp.status, 2, ftp.stderr); assert.match(ftp.stderr, /TYCON_RELEASE_API tiene que empezar con http/);
});

test('T10 NpmPackage_VersionIsSemverAndStartsAt1', () => {
  const pkg = JSON.parse(read(path.join(PKG_DIR, 'package.json')));
  const VT = require(VERSION_TOOL);
  assert.strictEqual(pkg.name, '@tyconsa/harness');
  assert.ok(VT.parseSemver(pkg.version), `version semver: ${pkg.version}`);
  assert.ok(VT.compareSemver(pkg.version, '1.0.0') >= 0, 'desde 1.0.0');
  assert.deepStrictEqual(pkg.bin, { 'tycon-harness': 'index.js' });
  assert.deepStrictEqual([...pkg.files].sort(), FILES);
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
