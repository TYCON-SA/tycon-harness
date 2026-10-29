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
