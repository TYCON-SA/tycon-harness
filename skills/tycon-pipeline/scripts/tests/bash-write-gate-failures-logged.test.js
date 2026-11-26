'use strict';
// Lo que el freno de escrituras por consola no pudo hacer queda en hook-errors.log: el lector de historias que no carga
// (el freno sigue con la forma de siempre), la copia de una historia que no se pudo mirar (se juzga como historia
// nueva) y el cupo ad-hoc que no se pudo anotar. La decisión no cambia; la falla deja de ser muda.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');

/** Corre el freno en un proceso aparte, con una HOME de juguete y la falla inyectada antes de cargarlo. */
function correr({ home, cwd, command, romper }) {
  const lib = (n) => JSON.stringify(path.join(SCRIPTS, 'lib', n));
  const code = `
    const romper = ${JSON.stringify(romper)};
    const Module = require('module');
    const cargar = Module._load;
    Module._load = function (pedido, ...resto) {
      const n = romper.find((x) => x.endsWith('.js') && pedido.endsWith(x));
      if (n) throw new Error('roto: ' + n);
      return cargar.call(this, pedido, ...resto);
    };
    const sd = require(${lib('story-discovery.js')});
    for (const k of romper.filter((x) => x !== 'recordAdhocFile' && !x.endsWith('.js'))) Object.defineProperty(sd, k, { get() { throw new Error('roto: ' + k); } });
    if (romper.includes('recordAdhocFile')) require(${lib('story-gate-io.js')}).recordAdhocFile = () => { throw new Error('roto: recordAdhocFile'); };
    const r = require(${JSON.stringify(path.join(SCRIPTS, 'on-bash-write-gate.js'))}).handle(
      { tool_name: 'Bash', session_id: 's-fallas', cwd: ${JSON.stringify(cwd)}, tool_input: { command: ${JSON.stringify(command)} } },
      { stateDir: ${JSON.stringify(path.join(home, 'estado'))}, installedRoots: [] });
    process.stdout.write(JSON.stringify(r));`;
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_')) base[k] = v;
  const r = spawnSync(process.execPath, ['-e', code], { env: { ...base, HOME: home, USERPROFILE: home, TYCON_NO_RUN_CHANGE: '1' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const log = path.join(home, '.claude', '.tycon-pipeline', 'hook-errors.log');
  return { decision: JSON.parse(r.stdout || 'null'), log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

function corral() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fallas-freno-')));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'estado'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'specs', 'story-x.md'), '---\nstory: "9.9"\ntitle: "x"\nstatus: draft\n---\n\n# x\n');
  return { home, repo };
}

// T1 BashWriteGateFailures_AreLoggedNotSwallowed
// 🔴 Falla con: cualquiera de los tres `catch` sin rastro (el lector de historias, la copia de una historia, el cupo
//    ad-hoc).
test('T1 BashWriteGateFailures_AreLoggedNotSwallowed', () => {
  const { home, repo } = corral();
  try {
    // el lector de historias no carga: al crear un .md nuevo y al mirar una historia que se escribe
    let r = correr({ home, cwd: repo, command: 'echo hola > specs/nueva.md', romper: ['declaresStoryIdentity'] });
    assert.match(r.log, /roto: declaresStoryIdentity/, 'el lector de historias que no carga queda dicho');
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    r = correr({ home, cwd: repo, command: 'echo x > specs/story-x.md', romper: ['declaresStoryIdentity'] });
    assert.match(r.log, /roto: declaresStoryIdentity[\s\S]*estadoDeHistoria/, 'también al mirar una historia que se escribe');
    assert.ok(r.decision && r.decision.block, 'y la forma de siempre la sigue frenando');
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });

    // la copia de una historia existente no se pudo mirar
    r = correr({ home, cwd: repo, command: 'cp specs/story-x.md specs/story-copia.md', romper: ['probeStoryFile'] });
    assert.match(r.log, /roto: probeStoryFile/, 'la copia que no se pudo mirar queda dicha');
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });

    // el cupo ad-hoc no se pudo anotar
    r = correr({ home, cwd: repo, command: 'echo x > a.js', romper: ['recordAdhocFile'] });
    assert.match(r.log, /roto: recordAdhocFile/, 'el cupo que no se anotó queda dicho');
    assert.strictEqual(r.decision, null, 'la decisión es la misma: pasa');
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });

    // las bibliotecas que el freno carga con respaldo: la de rutas y la que lee los heredocs
    r = correr({ home, cwd: repo, command: 'echo x > out.txt', romper: ['path-shape.js'] });
    assert.match(r.log, /roto: path-shape\.js/, 'sin la de rutas, queda dicho');
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    r = correr({ home, cwd: repo, command: 'cat > out.txt <<EOF\nhola\nEOF', romper: ['shell-parse.js'] });
    assert.match(r.log, /roto: shell-parse\.js/, 'sin la que lee los heredocs, queda dicho');
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });

    // un programa que no se puede leer para saber si es un guion
    fs.writeFileSync(path.join(repo, 'cerrado'), '#!/usr/bin/env python3\nprint(1)\n');
    fs.chmodSync(path.join(repo, 'cerrado'), 0o111);
    r = correr({ home, cwd: repo, command: './cerrado specs/story-x.md', romper: [] });
    if (!(typeof process.getuid === 'function' && process.getuid() === 0)) assert.match(r.log, /EACCES/, 'el guion que no se pudo leer queda dicho');
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    r = correr({ home, cwd: repo, command: './no-existe specs/story-x.md', romper: [] });
    assert.strictEqual(r.log, '', 'el que no existe no es una falla');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── cuando el freno mismo falla: frena sólo lo que escribe y nombra una historia o una constancia ──────────────────────

const GATE = path.join(SCRIPTS, 'on-bash-write-gate.js');

/**
 * El freno de verdad, en su proceso, con la entrada tal cual y un módulo roto (o una preparación propia) antes de cargarlo.
 * `gate`: otro freno que el de este árbol (el de una copia). `env`: variables de más.
 */
function enProceso({ home, repo }, entrada, { romper, preparar, gate = GATE, env = {} } = {}) {
  const log = path.join(home, '.claude', '.tycon-pipeline', 'hook-errors.log');
  fs.rmSync(log, { force: true });
  const args = [];
  const previa = path.join(home, 'previa.js');
  if (romper) fs.writeFileSync(previa, "const M = require('module'); const c = M._load; const broken = process.env.BREAK_MODULE; M._load = function (p, ...r) { if (p.endsWith(broken)) throw new Error('roto: ' + broken); return c.call(this, p, ...r); };");
  if (preparar) fs.writeFileSync(previa, preparar);
  if (romper || preparar) args.push('-r', previa);
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_')) base[k] = v;
  const r = spawnSync(process.execPath, [...args, gate], { input: entrada, cwd: repo, env: { ...base, HOME: home, USERPROFILE: home, TYCON_NO_RUN_CHANGE: '1', ...(romper ? { BREAK_MODULE: romper } : {}), ...env }, encoding: 'utf8', timeout: 15000 });
  return { salida: r.status, stderr: String(r.stderr), log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}
const pedido = (cwd, command) => JSON.stringify({ tool_name: 'Bash', session_id: 's-red', cwd, tool_input: { command } });
/** La preparación de un archivo del freno que no está: su `require` falla como en una instalación a la que le falta. */
const sinArchivo = (archivo) => `const M = require('module'); const c = M._load; M._load = function (p, ...r) { if (p.endsWith('/${archivo}')) { const e = new Error("Cannot find module '" + p + "'"); e.code = 'MODULE_NOT_FOUND'; throw e; } return c.call(this, p, ...r); };`;
/**
 * Una versión bajada del arnés en `destino`: lo que el freno carga, sin pruebas, y su lista (`.tycon-release.json`) con la
 * huella de git de cada archivo, como la deja el instalador. No es un clon: no trae `.git`.
 */
function versionBajada(destino) {
  const raiz = path.resolve(SCRIPTS, '..', '..', '..');
  const sinPruebas = (p) => !p.split(path.sep).includes('tests');
  for (const d of ['skills/tycon-pipeline/scripts', 'scripts/lib', 'scripts/setup']) {
    fs.cpSync(path.join(raiz, d), path.join(destino, d), { recursive: true, filter: sinPruebas });
  }
  const files = [];
  const recorrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(abs);
      else if (e.isFile()) {
        const d = fs.readFileSync(abs);
        files.push({ path: path.relative(destino, abs).split(path.sep).join('/'), mode: '100644', blob: require('crypto').createHash('sha1').update(`blob ${d.length}\0`).update(d).digest('hex') });
      }
    }
  };
  recorrer(destino);
  fs.writeFileSync(path.join(destino, '.tycon-release.json'), JSON.stringify({ schema: 1, files }));
  return destino;
}
const FRENO = /EL FRENO FALLÓ/;

// Lo que frena y lo que pasa cuando el freno no pudo mirar: `specs/story-x.md` es la historia del corral.
const LOS_QUE_FRENAN = [
  `echo x > specs/story-x.md`,
  `sed -i '' 's/a/b/' specs/story-x.md`,
  `python3 -c "open('specs/story-x.md','w').write('x')"`,
  `node -e "require('fs').writeFileSync('specs/story-x.md','x')"`,
  `rm specs/story-x.md`,
  `cp /tmp/x specs/*.md`,
  `echo x > .github/control-changes/abc.json`,
  `sed --in-place s/a/b/ specs/story-x.md`,
  `perl -0pi -e 's/a/b/' specs/story-x.md`,
  `awk -i inplace 1 specs/story-x.md`,
  `patch specs/story-x.md arreglo.diff`,
  `git apply specs/story-x.md`,
  `rm -rf specs`,
  `cd specs && sed -i s/a/b/ *.md`,
  `python3 -c "open('specs/story-x.md', mode='w')"`,
  `python3 -c "from pathlib import Path; Path('specs/story-x.md').open('w')"`,
  `node -e "require('fs').openSync('specs/story-x.md','w')"`,
  `bash -c 'rm specs/story-x.md'`,
  `sh -c "cp a specs/story-x.md"`,
  `ssh h 'rm specs/story-x.md'`,
  `bash -c 'patch specs/story-x.md arreglo.diff'`,
  `echo x >specs/otra.md`,
  `echo x>specs/otra.md`,
  `dd if=a of=specs/otra.md`,
  `\\rm specs/story-x.md`,
  `\\tee specs/story-x.md`,
];
const LOS_QUE_PASAN = [
  `ls -la`,
  `cat specs/story-x.md`,
  `python3 -c "print(open('specs/story-x.md').read())"`,
  `echo x > salida.txt`,
  `echo x > notas.txt # la historia dice otra cosa`,
  `grep -l story specs/story-x.md`,
];
function matriz(c, opciones, rotulo) {
  for (const cmd of LOS_QUE_FRENAN) {
    const r = enProceso(c, pedido(c.repo, cmd), opciones);
    assert.strictEqual(r.salida, 2, `${rotulo}, ${cmd}: ${r.stderr}`);
    assert.match(r.stderr, FRENO, `${rotulo}, ${cmd}`);
    assert.match(r.log, /FRENÓ POR FALLA/, `${rotulo}, ${cmd}: queda en el registro`);
    assert.doesNotMatch(r.log, /FAILED OPEN/, `${rotulo}, ${cmd}: no dejó pasar nada`);
  }
  for (const cmd of LOS_QUE_PASAN) {
    const r = enProceso(c, pedido(c.repo, cmd), opciones);
    assert.strictEqual(r.salida, 0, `${rotulo}, ${cmd}: ${r.stderr}`);
    assert.match(r.log, /FAILED OPEN/, `${rotulo}, ${cmd}: pasó sin mirarse, y queda dicho`);
  }
}

// T2 Falla_SinPrever_FrenaSoloLoQueEscribeUnaHistoria
// 🔴 Falla con: dejar pasar todo ante una falla sin prever, como antes; o frenar todo, que es el otro extremo.
test('T2 Falla_SinPrever_FrenaSoloLoQueEscribeUnaHistoria', () => {
  const c = corral();
  try { matriz(c, { romper: 'story-gate-io.js' }, 'falla sin prever'); } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

// T3 Falla_ModuloDelArranque_FrenaTodoYDiceCual
// 🔴 Falla con: un `require` de arriba del archivo sin red: el proceso muere con salida 1, que no frena, y sin dejar rastro;
//    o la red de fallas, que deja pasar lo que no nombra una historia (escribir código sin carril). Sin cargarse, el freno
//    no decidió nada: frena todo comando, dice qué no cargó y dónde quedó el registro.
test('T3 Falla_ModuloDelArranque_FrenaTodoYDiceCual', () => {
  const c = corral();
  try {
    for (const m of ['lib/story-gate.js', 'session-id.js']) {
      const r = enProceso(c, pedido(c.repo, `ls -la`), { romper: m });
      assert.strictEqual(r.salida, 2, `sin ${m}, ls -la: ${r.stderr}`);
      assert.match(r.stderr, /NO PUDO CARGARSE/, `sin ${m}: lo dice`);
      assert.ok(r.stderr.includes(path.basename(m)), `sin ${m}: nombra el módulo (${r.stderr})`);
      assert.match(r.log, /FRENÓ POR FALLA/, `sin ${m}: queda en el registro`);
    }
    // sin el lector de rutas no se sabe dónde vive el estado: frena igual, y dice dónde quedó el registro
    for (const cmd of [`echo x > specs/story-x.md`, `ls -la`]) {
      const sinLector = enProceso(c, pedido(c.repo, cmd), { romper: 'tycon-home.js' });
      assert.strictEqual(sinLector.salida, 2, `sin tycon-home.js, ${cmd}: ${sinLector.stderr}`);
      assert.match(sinLector.stderr, /La falla quedó en .*hook-errors\.log/);
    }
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

// T3b Falla_ModuloQueNoCarga_FrenaTodo
// 🔴 Falla con: un módulo del freno que no carga y la red que deja pasar lo que no nombra una historia ni una constancia,
//    como escribir código sin carril, que el freno entero frena. Sin cargarse, el freno no decidió nada: frena todo y
//    lo dice. La T3 mira el mensaje; ésta, que no se escapa ningún comando.
test('T3b Falla_ModuloQueNoCarga_FrenaTodo', () => {
  const c = corral();
  try {
    fs.mkdirSync(path.join(c.repo, 'src'), { recursive: true });
    const todos = [...LOS_QUE_FRENAN, ...LOS_QUE_PASAN, 'echo x > src/Foo.cs', "cat > src/Foo.cs <<'EOF'\nclass X{}\nEOF"];
    const problemas = [];
    for (const m of ['lib/story-gate.js', 'session-id.js', 'tycon-home.js']) {
      for (const cmd of todos) {
        const r = enProceso(c, pedido(c.repo, cmd), { romper: m });
        const que = `sin ${m}, «${cmd.split('\n')[0]}»`;
        if (r.salida !== 2) problemas.push(`${que}: salió ${r.salida}, no frenó`);
        else if (!r.stderr.includes(path.basename(m))) problemas.push(`${que}: frenó sin nombrar el módulo que no cargó`);
        if (/FAILED OPEN/.test(r.log)) problemas.push(`${que}: el registro dice FAILED OPEN`);
      }
    }
    assert.deepStrictEqual(problemas, [], 'sin cargarse, el freno frena todo y nombra el módulo');
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

// T3c Falla_ModuloQueFaltaAlDecidir_FrenaTodo
// 🔴 Falla con: un módulo que el freno carga recién al decidir y que no está (el que lee lo instalado, por ejemplo):
//    la falla iba a la red, que deja pasar escribir código sin carril. Que falte un archivo del freno no es una falla
//    sin prever del análisis (la T2): frena y dice cuál falta.
test('T3c Falla_ModuloQueFaltaAlDecidir_FrenaTodo', () => {
  const c = corral();
  try {
    fs.mkdirSync(path.join(c.repo, 'src'), { recursive: true });
    for (const cmd of ['echo x > src/Foo.cs', "cat > src/Foo.cs <<'EOF'\nclass X{}\nEOF"]) {
      const r = enProceso(c, pedido(c.repo, cmd), { preparar: sinArchivo('installed-tree.js') });
      const que = `sin installed-tree.js, «${cmd.split('\n')[0]}»`;
      assert.strictEqual(r.salida, 2, `${que}: ${r.stderr}`);
      assert.ok(r.stderr.includes('installed-tree.js'), `${que}: nombra el módulo (${r.stderr})`);
      assert.match(r.log, /FRENÓ POR FALLA/, `${que}: queda en el registro`);
      assert.doesNotMatch(r.log, /FAILED OPEN/, `${que}: no pasa por la red`);
    }
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

// T3d Falla_ModuloQueNoCompilaAlDecidir_FrenaTodo
// 🔴 Falla con: un módulo que el freno carga recién al decidir y que está, pero no compila (una instalación a medias):
//    como en la T3c, la falla iba a la red y escribir código sin carril pasaba. Un archivo roto es una pieza rota.
test('T3d Falla_ModuloQueNoCompilaAlDecidir_FrenaTodo', () => {
  const c = corral();
  try {
    fs.mkdirSync(path.join(c.repo, 'src'), { recursive: true });
    const roto = "const fs = require('fs'); const os = require('os'); const p = require('path'); const rota = p.join(os.homedir(), 'rota-installed-tree.js'); fs.writeFileSync(rota, 'module.exports = {;\\n'); const M = require('module'); const c = M._load; M._load = function (q, ...r) { return c.call(this, q.endsWith('/installed-tree.js') || q === './installed-tree.js' ? rota : q, ...r); };";
    for (const cmd of ['echo x > src/Foo.cs', "cat > src/Foo.cs <<'EOF'\nclass X{}\nEOF"]) {
      const r = enProceso(c, pedido(c.repo, cmd), { preparar: roto });
      const que = `con installed-tree.js roto, «${cmd.split('\n')[0]}»`;
      assert.strictEqual(r.salida, 2, `${que}: ${r.stderr}`);
      assert.ok(r.stderr.includes('installed-tree.js'), `${que}: nombra el módulo (${r.stderr})`);
      assert.match(r.log, /FRENÓ POR FALLA/, `${que}: queda en el registro`);
      assert.doesNotMatch(r.log, /FAILED OPEN/, `${que}: no pasa por la red`);
    }
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

// T3e Falla_ControlSinSuArchivo_FrenaTodo
// 🔴 Falla con: un control del freno que pide su archivo dentro de su propia red (un `try` que traga el error): si el
//    archivo falta, el control se apaga callado y el resto del freno decide sin él. Con el deprecado en `block`, escribir
//    lo deprecado pasaba; sin el freno de stash, también descartar el stash de otra sesión. Que falte un archivo del freno
//    frena todo, aunque lo pida un control que sigue sin él.
test('T3e Falla_ControlSinSuArchivo_FrenaTodo', () => {
  const c = corral();
  try {
    fs.mkdirSync(path.join(c.repo, '.tycon'), { recursive: true });
    fs.mkdirSync(path.join(c.repo, 'src', 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(c.repo, 'src', 'legacy', 'a.cs'), 'x\n');
    fs.writeFileSync(path.join(c.repo, '.tycon', 'advisors.yaml'), 'deprecated:\n  edit: block\n  paths:\n    - path: "src/legacy/**"\n      level: frozen\n      reason: "reemplazado"\n');
    // el deprecado lee la configuración commiteada: un repo con un commit, con fechas fijas y sin el mantenimiento de git
    const gitEnv = { ...process.env, GIT_AUTHOR_DATE: '2026-11-24T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-24T12:00:00Z' };
    const git = (...a) => spawnSync('git', ['-C', c.repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: gitEnv });
    git('init', '-q', '-b', 'main', '.');
    git('add', '-A');
    git('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');
    // y con el arnés: el de este árbol. Sin el carril: escribir código sin carril frenaría igual y taparía al deprecado
    const env = { TYCON_GUIDES_DIR: path.resolve(SCRIPTS, '..', '..', '..'), TYCON_STORY_GATE: 'off' };
    // con el archivo, el deprecado frena: es lo que se apagaba
    const con = enProceso(c, pedido(c.repo, 'echo y > src/legacy/a.cs'), { env });
    assert.strictEqual(con.salida, 2, con.stderr);
    assert.match(con.stderr, /deprecado/);
    for (const [archivo, cmd] of [['deprecated.js', 'echo y > src/legacy/a.cs'], ['stash-guard.js', 'git stash drop']]) {
      const r = enProceso(c, pedido(c.repo, cmd), { preparar: sinArchivo(archivo), env });
      const que = `sin ${archivo}, «${cmd}»`;
      assert.strictEqual(r.salida, 2, `${que}: ${r.stderr}`);
      assert.match(r.stderr, /NO PUDO CARGARSE/, `${que}: lo dice`);
      assert.ok(r.stderr.includes(archivo), `${que}: nombra el archivo (${r.stderr})`);
      assert.match(r.log, /FRENÓ POR FALLA/, `${que}: queda en el registro`);
    }
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

// T3f Falla_ArchivoQueNoEsElInstalado_FrenaTodo
// 🔴 Falla con: un archivo del freno que compila pero quedó a medias (una instalación cortada): la decisión cae con un
//    error común, que va a la red, y escribir código sin carril pasa. En una versión bajada (trae su lista y no es un
//    clon), el freno compara la huella de cada archivo suyo que usó con la de la lista: si una no coincide, frena todo y
//    dice cuál. En un clon no la mira: quien mantiene el arnés cambia sus archivos a propósito.
test('T3f Falla_ArchivoQueNoEsElInstalado_FrenaTodo', () => {
  const c = corral();
  const copia = versionBajada(path.join(c.home, 'arnes'));
  const gate = path.join(copia, 'skills', 'tycon-pipeline', 'scripts', 'on-bash-write-gate.js');
  try {
    fs.mkdirSync(path.join(c.repo, 'src'), { recursive: true });
    // intacta, decide como siempre
    const sana = enProceso(c, pedido(c.repo, 'echo x > src/Foo.cs'), { gate });
    assert.strictEqual(sana.salida, 0, sana.stderr);
    assert.doesNotMatch(sana.log, /FAILED OPEN|FRENÓ POR FALLA/, 'la copia intacta no es una falla');
    fs.writeFileSync(path.join(copia, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'installed-tree.js'), 'module.exports = {};\n');
    for (const cmd of ['echo x > src/Foo.cs', "cat > src/Foo.cs <<'EOF'\nclass X{}\nEOF"]) {
      const r = enProceso(c, pedido(c.repo, cmd), { gate });
      const que = `con installed-tree.js a medias, «${cmd.split('\n')[0]}»`;
      assert.strictEqual(r.salida, 2, `${que}: ${r.stderr}`);
      assert.ok(r.stderr.includes('installed-tree.js'), `${que}: nombra el archivo (${r.stderr})`);
      assert.match(r.stderr, /no es el que se instaló/, `${que}: dice por qué`);
      assert.match(r.log, /FRENÓ POR FALLA/, `${que}: queda en el registro`);
      assert.doesNotMatch(r.log, /FAILED OPEN/, `${que}: no pasa por la red`);
    }
    // un clon no se compara con la lista
    fs.mkdirSync(path.join(copia, '.git'));
    const clon = enProceso(c, pedido(c.repo, 'ls -la'), { gate });
    assert.strictEqual(clon.salida, 0, clon.stderr);
    assert.doesNotMatch(clon.stderr, /no es el que se instaló/);
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

// T4 Falla_EntradaIlegible_MiraElTextoCrudo
// 🔴 Falla con: tratar la entrada rota como vacía: pasa sin mirarse y sin dejar rastro.
test('T4 Falla_EntradaIlegible_MiraElTextoCrudo', () => {
  const c = corral();
  try {
    const rota = enProceso(c, '{"tool_input":{"command":"echo x > specs/story-x.md"');
    assert.strictEqual(rota.salida, 2, rota.stderr);
    assert.match(rota.stderr, FRENO);
    assert.match(rota.log, /FRENÓ POR FALLA/);
    // en el texto crudo, el salto de línea sigue escrito como `\n`
    const renglones = enProceso(c, '{"tool_input":{"command":"ls\\nrm specs/story-x.md"');
    assert.strictEqual(renglones.salida, 2, renglones.stderr);
    // el primer comando va pegado a la comilla del texto crudo
    for (const cmd of ['rm -rf specs', 'cp /tmp/x specs/story-x.md', 'mv /tmp/x specs/story-x.md', 'patch specs/story-x.md arreglo.diff']) {
      const r = enProceso(c, `{"tool_input":{"command":"${cmd}`);
      assert.strictEqual(r.salida, 2, `${cmd}: ${r.stderr}`);
    }
    const otra = enProceso(c, '{"tool_input":{"command":"ls -la"');
    assert.strictEqual(otra.salida, 0, otra.stderr);
    assert.match(otra.log, /FAILED OPEN/, 'no se pudo leer: queda dicho');
    // sin entrada no hay comando que mirar: no es una falla
    for (const vacia of ['', 'null']) {
      const r = enProceso(c, vacia);
      assert.strictEqual(r.salida, 0, r.stderr);
      assert.strictEqual(r.log, '', `«${vacia}» no es una falla`);
    }
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

// T7 Falla_AlDecirElBloqueo_FrenaIgual
// 🔴 Falla con: dar por decidido antes de decir el bloqueo: si esa escritura falla, el comando pasa.
test('T7 Falla_AlDecirElBloqueo_FrenaIgual', () => {
  const c = corral();
  try {
    const preparar = `const w = process.stderr.write.bind(process.stderr); process.stderr.write = (s, ...r) => { if (/HISTORIA ESCRITA/.test(String(s))) throw new Error('sin stderr'); return w(s, ...r); };`;
    const r = enProceso(c, pedido(c.repo, `echo x > specs/story-x.md`), { preparar });
    assert.strictEqual(r.salida, 2, r.stderr);
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

// T6 Falla_EntradaQueNoSeLee_QuedaComoAbierto
// 🔴 Falla con: anotarla como una falla más: sin texto no hay qué frenar, y el comando pasó sin mirarse.
test('T6 Falla_EntradaQueNoSeLee_QuedaComoAbierto', (t) => {
  if (process.platform === 'win32') return t.skip('en Windows una carpeta no se abre como archivo');
  const c = corral();
  const carpeta = fs.openSync(c.repo, 'r');
  try {
    const base = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_')) base[k] = v;
    const r = spawnSync(process.execPath, [GATE], { stdio: [carpeta, 'pipe', 'pipe'], cwd: c.repo, env: { ...base, HOME: c.home, USERPROFILE: c.home, TYCON_NO_RUN_CHANGE: '1' }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(c.home, '.claude', '.tycon-pipeline', 'hook-errors.log'), 'utf8'), /FAILED OPEN/);
  } finally { fs.closeSync(carpeta); fs.rmSync(c.home, { recursive: true, force: true }); }
});

// T5 Falla_DespuesDeDecidir_NoCambiaLaDecision
// 🔴 Falla con: que la red juzgue también lo que el freno ya miró: lo que falla después son sólo los avisos.
test('T5 Falla_DespuesDeDecidir_NoCambiaLaDecision', () => {
  const c = corral();
  try {
    // la pila entera: «dentro de handle» se lee en ella, y cada `require` del freno le suma un renglón
    const preparar = `Error.stackTraceLimit = 200; const io = require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'story-gate-io.js'))}); const antes = io.DEFAULT_STATE_DIR; Object.defineProperty(io, 'DEFAULT_STATE_DIR', { get() { if (new Error().stack.includes('handle')) return antes; throw new Error('roto después de decidir'); } });`;
    // escribe afuera y nombra la historia: el freno lo miró y lo deja pasar
    const r = enProceso(c, pedido(c.repo, `echo specs/story-x.md > salida.txt`), { preparar });
    assert.strictEqual(r.salida, 0, r.stderr);
    assert.match(r.log, /roto después de decidir/, 'la falla queda dicha');
    assert.doesNotMatch(r.log, /FAILED OPEN|FRENÓ POR FALLA/, 'el comando se miró: no se abrió ni frenó por la falla');
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

// 🔴 Falla con: una copia del freno que no es la instalada (la de una prueba, la de un laboratorio en la carpeta de
//    trabajo de otra sesión), corrida con la casa de una máquina que tiene el arnés instalado, escribe sus fallas en el
//    registro de verdad y ensucia la medición de los frenos.
test('T8 Falla_DeUnaCopiaQueNoEsLaInstalada_VaAlRegistroAparte', () => {
  const { home, repo } = corral();
  try {
    const H = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js'));
    // una máquina con el arnés instalado por versión, en su lugar de siempre: esta copia del repo no es esa
    const instalado = H.placePath(home);
    fs.mkdirSync(path.join(instalado, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(instalado, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/sh\n');
    fs.mkdirSync(H.stateDir(home), { recursive: true });
    fs.writeFileSync(path.join(H.stateDir(home), 'harness-state.json'), JSON.stringify({ sources: [{ kind: 'release' }] }));
    correr({ home, cwd: repo, command: 'echo hola > specs/nueva.md', romper: ['declaresStoryIdentity'] });
    const registro = path.join(H.stateDir(home), 'hook-errors.log');
    const aparte = path.join(H.stateDir(home), 'hook-errors-copies.log');
    const leer = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    assert.doesNotMatch(leer(registro), /roto: declaresStoryIdentity/, 'la falla de una copia no va al registro de verdad');
    assert.match(leer(aparte), /roto: declaresStoryIdentity/, 'queda en el registro aparte, con su falla');
    assert.match(leer(aparte), /\(copia en [^)]+\)/, 'y dice desde qué copia corrió');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
