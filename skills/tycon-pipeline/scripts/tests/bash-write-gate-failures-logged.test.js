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

/** El freno de verdad, en su proceso, con la entrada tal cual y un módulo roto (o una preparación propia) antes de cargarlo. */
function enProceso({ home, repo }, entrada, { romper, preparar } = {}) {
  const log = path.join(home, '.claude', '.tycon-pipeline', 'hook-errors.log');
  fs.rmSync(log, { force: true });
  const args = [];
  const previa = path.join(home, 'previa.js');
  if (romper) fs.writeFileSync(previa, `const M = require('module'); const c = M._load; M._load = function (p, ...r) { if (p.endsWith(${JSON.stringify(romper)})) throw new Error('roto: ${romper}'); return c.call(this, p, ...r); };`);
  if (preparar) fs.writeFileSync(previa, preparar);
  if (romper || preparar) args.push('-r', previa);
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_')) base[k] = v;
  const r = spawnSync(process.execPath, [...args, GATE], { input: entrada, cwd: repo, env: { ...base, HOME: home, USERPROFILE: home, TYCON_NO_RUN_CHANGE: '1' }, encoding: 'utf8', timeout: 15000 });
  return { salida: r.status, stderr: String(r.stderr), log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}
const pedido = (cwd, command) => JSON.stringify({ tool_name: 'Bash', session_id: 's-red', cwd, tool_input: { command } });
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

// T3 Falla_ModuloDelArranque_FrenaSoloLoQueEscribeUnaHistoria
// 🔴 Falla con: un `require` de arriba del archivo sin red: el proceso muere con salida 1, que no frena, y sin dejar rastro;
//    o el registro que necesita ese módulo para saber dónde escribir.
test('T3 Falla_ModuloDelArranque_FrenaSoloLoQueEscribeUnaHistoria', () => {
  const c = corral();
  try {
    for (const m of ['lib/story-gate.js', 'session-id.js']) matriz(c, { romper: m }, `sin ${m}`);
    // sin el lector de rutas no se sabe dónde vive el estado: frena igual, y dice dónde quedó el registro
    const sinLector = enProceso(c, pedido(c.repo, `echo x > specs/story-x.md`), { romper: 'tycon-home.js' });
    assert.strictEqual(sinLector.salida, 2, sinLector.stderr);
    assert.match(sinLector.stderr, /La falla quedó en .*hook-errors\.log/);
    const otro = enProceso(c, pedido(c.repo, `ls -la`), { romper: 'tycon-home.js' });
    assert.strictEqual(otro.salida, 0, otro.stderr);
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
    const preparar = `const io = require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'story-gate-io.js'))}); const antes = io.DEFAULT_STATE_DIR; Object.defineProperty(io, 'DEFAULT_STATE_DIR', { get() { if (new Error().stack.includes('handle')) return antes; throw new Error('roto después de decidir'); } });`;
    // escribe afuera y nombra la historia: el freno lo miró y lo deja pasar
    const r = enProceso(c, pedido(c.repo, `echo specs/story-x.md > salida.txt`), { preparar });
    assert.strictEqual(r.salida, 0, r.stderr);
    assert.match(r.log, /roto después de decidir/, 'la falla queda dicha');
    assert.doesNotMatch(r.log, /FAILED OPEN|FRENÓ POR FALLA/, 'el comando se miró: no se abrió ni frenó por la falla');
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});
