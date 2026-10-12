'use strict';

/**
 * advisor-ledger-cli.test.js — el registro de corridas de revisores, de punta a punta.
 *
 * Ejerce los PROCESOS reales (marker.js y pipeline.js con un HOME de laboratorio), no las
 * funciones sueltas: la parte pura vive en `advisor-ledger.test.js`. Acá se prueba lo que
 * de verdad protege al dato — que la poda de 7 días no borre sin dejar resumen, que el
 * registro de gates atribuya el repo aunque no haya marker, y que el comando lector conteste
 * "¿corrieron los revisores de la story X?" desde el archivo durable.
 *
 * Lanza procesos → va en el throttle DIARIO del instalador, no en cada arranque.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');

const LOG_VIEJO = [
  '{"ts":"2026-08-01T10:00:00.000Z","event":"step5-start","expected":["a","b"],"iter":1}',
  '{"ts":"2026-08-01T10:00:01.000Z","advisor":"tycon-plugin-security-basics","model":"sonnet","repo":"/r/Backend","story":"9.4"}',
  '{"ts":"2026-08-01T10:00:02.000Z","advisor":"tycon-plugin-tests-coverage","model":null,"repo":"/r/Backend","story":"9.4"}',
].join('\n') + '\n';

function lab() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'led-cli-'));
  const home = path.join(root, 'home');
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline', 'advisor-runs'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  fs.mkdirSync(fixture, { recursive: true });
  return { root, home, fixture, state: path.join(home, '.claude', '.tycon-pipeline') };
}

function run(bin, args, l, extraEnv) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: l.fixture, encoding: 'utf8', timeout: 30000,
    env: Object.assign({ PATH: process.env.PATH, HOME: l.home, LANG: 'en_US.UTF-8' }, extraEnv || {}),
  });
}

function gitInit(dir) {
  for (const a of [['init', '-q', '-b', 'main', '.'], ['add', 'a.txt'],
    ['-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base']]) {
    if (a[0] === 'add') fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    spawnSync('git', a, { cwd: dir, stdio: 'ignore' });
  }
}

// El marker se escribe (y por lo tanto la poda corre) con `marker.js set`.
function podar(l) {
  return run(MARKER, ['set', JSON.stringify({ storyId: '0.0', repoPath: l.fixture })], l,
    { CLAUDE_CODE_SESSION_ID: 'probe' });
}

test('la poda de 7 días deja resumen durable antes de borrar, y no toca lo fresco', () => {
  const l = lab();
  const runs = path.join(l.state, 'advisor-runs');
  const viejo = path.join(runs, 'vieja.jsonl');
  fs.writeFileSync(viejo, LOG_VIEJO);
  const hace10dias = Date.now() - 10 * 24 * 3600 * 1000;
  fs.utimesSync(viejo, hace10dias / 1000, hace10dias / 1000);
  fs.writeFileSync(path.join(runs, 'fresca.jsonl'),
    '{"ts":"2026-08-25T10:00:00.000Z","advisor":"tycon-story-validator","repo":"/r/X","story":"1.1"}\n');

  podar(l);

  assert.equal(fs.existsSync(viejo), false, 'el archivo viejo se poda');
  assert.equal(fs.existsSync(path.join(runs, 'fresca.jsonl')), true, 'el fresco no se toca');
  const sum = fs.readFileSync(path.join(l.state, 'advisor-runs-summary.jsonl'), 'utf8').trim();
  const s = JSON.parse(sum);
  assert.deepEqual(s.stories, ['9.4'], 'el resumen conserva la story');
  assert.deepEqual(s.repos, ['/r/Backend'], 'el resumen conserva el repo');
  assert.equal(s.spawns, 2);
});

test('si el resumen no se puede escribir, la poda NO borra (no se pierde la constancia)', () => {
  const l = lab();
  const runs = path.join(l.state, 'advisor-runs');
  const viejo = path.join(runs, 'vieja.jsonl');
  fs.writeFileSync(viejo, LOG_VIEJO);
  const hace10dias = Date.now() - 10 * 24 * 3600 * 1000;
  fs.utimesSync(viejo, hace10dias / 1000, hace10dias / 1000);
  // un DIRECTORIO donde va el archivo de resumen → la escritura falla
  fs.mkdirSync(path.join(l.state, 'advisor-runs-summary.jsonl'));

  podar(l);

  assert.equal(fs.existsSync(viejo), true,
    'sin resumen escrito el archivo tiene que sobrevivir: perder unos KB es reversible, borrar la constancia en silencio no');
});

test('el lector contesta la pregunta desde el resumen durable', () => {
  const l = lab();
  fs.writeFileSync(path.join(l.state, 'advisor-runs-summary.jsonl'), JSON.stringify({
    ts: '2026-08-10T00:00:00.000Z', sessionId: 'vieja',
    from: '2026-08-01T10:00:00.000Z', to: '2026-08-01T10:00:02.000Z',
    repos: ['/r/Backend'], stories: ['9.4'],
    advisors: { 'tycon-plugin-security-basics': 1, 'tycon-plugin-tests-coverage': 1 }, spawns: 2, rondas: 1,
  }) + '\n');

  const r = run(PIPELINE, ['advisor-runs', '--story', '9.4'], l);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /2 spawn\(s\)/);
  assert.match(r.stdout, /tycon-plugin-security-basics/);
  assert.match(r.stdout, /\/r\/Backend/);
});

test('sin registro, el lector dice que el silencio NO prueba que no corrieron', () => {
  const l = lab();
  const r = run(PIPELINE, ['advisor-runs', '--story', '9.4'], l);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /NO prueba que no corrieron/,
    'la diferencia entre "no corrieron" y "no quedó constancia" tiene que estar escrita en la salida');
});

test('el lector NO filtra por el repo actual si nadie pasó --repo', () => {
  const l = lab();
  fs.writeFileSync(path.join(l.state, 'advisor-runs', 's.jsonl'),
    '{"ts":"2026-08-25T10:00:00.000Z","advisor":"sec","repo":"/otro/repo","story":"1.1"}\n');
  const r = run(PIPELINE, ['advisor-runs'], l);
  assert.match(r.stdout, /1 spawn\(s\)/,
    'el default de --repo es el cwd: si filtrara solo, "no aparece" volvería a leerse como "no corrió"');
});

test('gates.log atribuye el repo por raíz de git aunque no haya marker', () => {
  const l = lab();
  gitInit(l.fixture);
  const r = run(MARKER, ['run-check', 'tests', '--', 'true'], l, { CLAUDE_CODE_SESSION_ID: 'sin-marker' });
  assert.equal(r.status, 0, r.stderr);
  const linea = JSON.parse(fs.readFileSync(path.join(l.state, 'gates.log'), 'utf8').trim().split('\n').pop());
  assert.ok(linea.repoPath, 'sin repoPath las métricas por proyecto no se pueden armar (142 de 149 entradas históricas)');
  assert.equal(fs.realpathSync(linea.repoPath), fs.realpathSync(l.fixture));
});

test('el hook estampa repo y story en cada spawn', () => {
  const l = lab();
  gitInit(l.fixture);
  fs.writeFileSync(path.join(l.state, 'active', 'sid1.json'), JSON.stringify({
    storyId: '9.4', repoPath: l.fixture, sessionId: 'sid1',
  }), { flag: 'w' });

  const hook = path.join(SCRIPTS, 'on-advisor-run.js');
  const r = spawnSync(process.execPath, [hook], {
    cwd: l.fixture, encoding: 'utf8', timeout: 20000,
    input: JSON.stringify({
      session_id: 'sid1', tool_name: 'Task', cwd: l.fixture,
      tool_input: { subagent_type: 'tycon-plugin-security-basics', model: 'sonnet' },
    }),
    env: { PATH: process.env.PATH, HOME: l.home, TYCON_AUTO_SNAPSHOT: '0' },
  });
  assert.equal(r.status, 0);
  const linea = JSON.parse(fs.readFileSync(path.join(l.state, 'advisor-runs', 'sid1.jsonl'), 'utf8').trim());
  assert.equal(linea.story, '9.4', 'sin story el registro no puede contestar por story');
  assert.equal(fs.realpathSync(linea.repo), fs.realpathSync(l.fixture));
});

test('el hook estampa el repo por raíz de git cuando no hay marker', () => {
  const l = lab();
  gitInit(l.fixture);
  const hook = path.join(SCRIPTS, 'on-advisor-run.js');
  const r = spawnSync(process.execPath, [hook], {
    cwd: l.fixture, encoding: 'utf8', timeout: 20000,
    input: JSON.stringify({
      session_id: 'sid2', tool_name: 'Task', cwd: l.fixture,
      tool_input: { subagent_type: 'tycon-plugin-react-conventions' },
    }),
    env: { PATH: process.env.PATH, HOME: l.home, TYCON_AUTO_SNAPSHOT: '0' },
  });
  assert.equal(r.status, 0);
  const linea = JSON.parse(fs.readFileSync(path.join(l.state, 'advisor-runs', 'sid2.jsonl'), 'utf8').trim());
  assert.equal(linea.story, null);
  assert.equal(fs.realpathSync(linea.repo), fs.realpathSync(l.fixture));
});
