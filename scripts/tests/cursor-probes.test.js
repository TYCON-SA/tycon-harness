'use strict';
// cursor-probes.test.js — the Cursor probes: what they answer without Cursor, the shape of the evidence with a fake
// `cursor-agent`, and the time limit when Cursor hangs or fails. Every case builds its own HOME, PATH and package folder:
// the real `cursor-agent` and the real HOME are never reached. These tests check the SHAPE of the evidence, not the
// measurement: the fake answers what it was told to; the measurement is the run against the real Cursor.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PROBES = path.join(ROOT, 'scripts', 'tools', 'cursor-probes.js');
const FAKE = path.join(__dirname, 'lib', 'fake-cursor-agent.js');
const probes = require(PROBES);
const IS_WIN = process.platform === 'win32';
// the system folders the probes need (`ps`, a shell), none of which holds a real cursor-agent
const SYSTEM_PATH = IS_WIN ? [process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32'] : ['/usr/bin', '/bin'];

const roots = [];
function tmpRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-probes-')));
  roots.push(root);
  return root;
}
test.after(() => {
  for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* the OS cleans tmp */ } }
});

// A package folder that looks like Cursor's: the launcher `cursor-agent` (which runs the fake) next to an `index.js`
// carrying the texts the probes read.
function fakePackage(root, { source } = {}) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (IS_WIN) {
    fs.writeFileSync(path.join(bin, 'cursor-agent.cmd'), `@"${process.execPath}" "${FAKE}" %*\r\n`);
  } else {
    // like the real launcher: `exec -a "$0"` keeps the name `cursor-agent` in the command line of the node process
    fs.writeFileSync(path.join(bin, 'cursor-agent'), `#!/usr/bin/env bash\nexec -a "$0" "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  }
  const text = source != null ? source : [
    'const hooks=["sessionStart","beforeSubmitPrompt","preToolUse","subagentStart","subagentStop","stop"];',
    'const rules=[".cursor/rules","AGENTS.md","CLAUDE.md"];',
    'class HookAdditionalContextTooLargeError{constructor(e){this.m=`Hook additional_context for ${e}`}}',
    'opt("-e, --endpoint <url>","Target API endpoint URL (can also use CURSOR_API_ENDPOINT env var)");',
    'const env={CURSOR_CONVERSATION_ID:id,CURSOR_AGENT_CHAT_ID:chat};',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'index.js'), text);
  return bin;
}

function runProbes(root, { bin, state, args = [], home = path.join(root, 'home'), extraEnv = {}, json = true } = {}) {
  fs.mkdirSync(home, { recursive: true });
  const env = Object.assign({
    PATH: [bin, ...SYSTEM_PATH].filter(Boolean).join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: os.tmpdir(),
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    FAKE_CURSOR_LOG: path.join(root, 'fake-calls.jsonl'),
  }, extraEnv);
  if (IS_WIN && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (IS_WIN && process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT;
  if (state) {
    const statePath = path.join(root, 'fake-state.json');
    fs.writeFileSync(statePath, JSON.stringify(state));
    env.FAKE_CURSOR_STATE = statePath;
  }
  // stable-data: mide cuánto tarda el guion; no depende de la fecha
  const started = Date.now();
  const r = spawnSync(process.execPath, [PROBES, ...(json ? ['--json'] : []), ...args], { env, encoding: 'utf8', timeout: 60000 });
  const elapsed = Date.now() - started;
  let out = null;
  try { out = JSON.parse(r.stdout); } catch (_e) { /* the assertion below shows the raw output */ }
  return { r, out, elapsed };
}

const SONDAS = ['S1', 'S2', 'S3', 'S4'];
const EJECUCION = 'ejecución';

test('CursorProbes_SinCursor_NoMedidoSale0', () => {
  const root = tmpRoot();
  // guard: the system folders must not hold a real cursor-agent, or this case would not be «without Cursor»
  for (const d of SYSTEM_PATH) assert.ok(!fs.existsSync(path.join(d, IS_WIN ? 'cursor-agent.cmd' : 'cursor-agent')), `${d} has a cursor-agent`);
  const empty = path.join(root, 'empty-bin');
  fs.mkdirSync(empty);
  const { r, out } = runProbes(root, { bin: empty });
  assert.strictEqual(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  assert.ok(out, `the output is not JSON:\n${r.stdout}`);
  for (const s of SONDAS) {
    assert.strictEqual(out.probes[s].status, 'NO MEDIDO', `${s}: ${JSON.stringify(out.probes[s])}`);
    assert.match(out.probes[s].motivo, /cursor-agent no está en el PATH/, s);
  }
  // the same questions as with Cursor: none disappears
  const other = tmpRoot();
  const withCursor = runProbes(other, { bin: fakePackage(other), state: { fire_hooks: false } }).out;
  for (const s of SONDAS) {
    assert.deepStrictEqual(out.probes[s].items.map((i) => i.id).sort(), withCursor.probes[s].items.map((i) => i.id).sort(), s);
  }
});

test('CursorProbes_ConFake_EscribeEvidencia', async (t) => {
  await t.test('forma de la evidencia', () => {
    const root = tmpRoot();
    const bin = fakePackage(root);
    const report = path.join(root, 'medicion.md');
    // a project folder of an earlier session, which must stay
    fs.mkdirSync(path.join(root, 'home', '.cursor', 'projects', 'ya-estaba'), { recursive: true });
    const state = {
      version: '2026.10.19-fake',
      fire_hooks: true,
      conversation_id: 'conv-1234',
      env: { CURSOR_CONVERSATION_ID: 'conv-1234' },
    };
    const { r, out } = runProbes(root, { bin, state, args: ['--report', report] });
    assert.strictEqual(r.status, 0, `exit ${r.status}\n${r.stderr}`);
    assert.ok(out, `the output is not JSON:\n${r.stdout}`);

    // the version, with its command and output
    assert.strictEqual(out.version.status, 'MEDIDO');
    assert.strictEqual(out.version.value, '2026.10.19-fake');
    assert.match(out.version.command, /cursor-agent --version/);

    for (const s of SONDAS) {
      const p = out.probes[s];
      assert.ok(Array.isArray(p.items) && p.items.length > 0, `${s} without questions`);
      for (const it of p.items) {
        assert.ok(['MEDIDO', 'NO MEDIDO', 'ERROR'].includes(it.status), `${s}/${it.id}: ${it.status}`);
        assert.ok(['paquete', EJECUCION, 'modelo'].includes(it.source), `${s}/${it.id}: ${it.source}`);
        if (it.status === 'MEDIDO') {
          assert.ok(it.command, `${s}/${it.id} without a command`);
          assert.ok(it.output != null && it.output !== '', `${s}/${it.id} without an output`);
        } else {
          assert.ok(it.motivo, `${s}/${it.id} without a reason`);
        }
        // what needs a model is never measured here
        if (it.source === 'modelo') assert.deepStrictEqual([it.status, it.motivo], ['NO MEDIDO', 'pide modelo'], `${s}/${it.id}`);
      }
    }
    // the package reading answers without a model
    const s1code = out.probes.S1.items.find((i) => i.source === 'paquete');
    assert.strictEqual(s1code.status, 'MEDIDO');
    // S2 (a subagent launch needs a model): «not measured», never a negative answer
    const s2model = out.probes.S2.items.find((i) => i.source === 'modelo');
    assert.strictEqual(s2model.status, 'NO MEDIDO');
    assert.strictEqual(s2model.answer, null);
    // the run with the fake: the hook saw an id in its environment, equal to the payload's
    const s3run = out.probes.S3.items.find((i) => i.source === EJECUCION);
    assert.strictEqual(s3run.status, 'MEDIDO', JSON.stringify(s3run));
    assert.match(JSON.stringify(s3run.answer), /CURSOR_CONVERSATION_ID/);
    assert.strictEqual(s3run.answer.matches_payload, true);
    // S4: the ancestor chain of a hook, with pid, start time, executable and command line
    const s4run = out.probes.S4.items.find((i) => i.source === EJECUCION);
    if (IS_WIN) {
      assert.strictEqual(s4run.status, 'NO MEDIDO');
    } else {
      assert.strictEqual(s4run.status, 'MEDIDO', JSON.stringify(s4run));
      assert.ok(s4run.answer.chain.length > 0);
      for (const k of ['pid', 'start', 'exe', 'args']) assert.ok(k in s4run.answer.chain[0], `chain without ${k}`);
      assert.ok(['ejecutable', 'linea de comando', 'no aparece'].includes(s4run.answer.cursor_seen_as), s4run.answer.cursor_seen_as);
    }

    // the branch of each decision
    for (const d of ['D4', 'D5', 'D8', 'D9']) {
      assert.ok(out.decisions[d] && out.decisions[d].rama, `${d} without a branch`);
      assert.ok(out.decisions[d].motivo, `${d} without a reason`);
    }
    // nothing that needs a model was measured: the safe branches
    assert.strictEqual(out.decisions.D4.rama, '(c)');
    assert.match(out.decisions.D5.rama, /proceso ancestro/);
    assert.strictEqual(out.decisions.D9.rama, 'falla cerrada');
    // the hook measured its ancestors, but the terminal did not: D5 and D8 are still an assumption
    assert.strictEqual(out.decisions.D5.supuesto, true, JSON.stringify(out.decisions.D5));
    assert.strictEqual(out.decisions.D8.supuesto, true, JSON.stringify(out.decisions.D8));

    // the report names the four decisions, the note about AC 17 and 19, and keeps the HOME out
    const md = fs.readFileSync(report, 'utf8');
    for (const d of ['D4', 'D5', 'D8', 'D9']) assert.match(md, new RegExp(`\\b${d}\\b`));
    assert.match(md, /AC 17 y 19/);
    assert.match(md, /2026\.10\.19-fake/);
    assert.ok(!md.includes(root), 'the report carries the temporary folder path');
    assert.ok(!md.includes('conv-1234'), 'the report carries a conversation id');

    // what Cursor created for the temporary folder (its two project folders under ~/.cursor/projects) does not stay
    // behind, and what was already there is not touched
    const projects = path.join(root, 'home', '.cursor', 'projects');
    assert.deepStrictEqual(fs.readdirSync(projects).sort(), ['ya-estaba'], 'a project folder of the run stayed in ~/.cursor/projects');
    assert.strictEqual(out.cursor_state.status, 'igual', JSON.stringify(out.cursor_state));
    assert.ok(out.cursor_state.removed.length >= 1, JSON.stringify(out.cursor_state));
    // the chain stops at the probes: what launched them says nothing about the Cursor measured, and is nobody's business
    if (!IS_WIN) {
      const chain = s4run.answer.chain;
      assert.ok(!chain.some((a) => a.pid === process.pid), 'the chain goes above the probes');
      assert.strictEqual(s4run.answer.cursor_seen_as, 'linea de comando', JSON.stringify(chain));
    }
    // the run trusted only its temporary folder, and never ran with --force
    const calls = fs.readFileSync(path.join(root, 'fake-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const runs = calls.filter((c) => c.argv.includes('-p'));
    assert.strictEqual(runs.length, 1);
    assert.deepStrictEqual(runs[0].argv.filter((a) => a.startsWith('-')), ['-p', '--trust'], runs[0].argv.join(' '));
    assert.ok(path.basename(runs[0].cwd).startsWith('cursor-probes-run-'), runs[0].cwd);
  });

  await t.test('una carpeta ajena no se borra', () => {
    const root = tmpRoot();
    const bin = fakePackage(root);
    // another Cursor session opens a project while the run is going on
    const { r, out } = runProbes(root, { bin, state: { fire_hooks: false, foreign_project: 'Users-alguien-repo-real' } });
    assert.strictEqual(r.status, 0, r.stderr);
    const projects = path.join(root, 'home', '.cursor', 'projects');
    assert.deepStrictEqual(fs.readdirSync(projects), ['Users-alguien-repo-real'], 'the folder of another session was removed');
    assert.strictEqual(out.cursor_state.status, 'ERROR', JSON.stringify(out.cursor_state));
    assert.deepStrictEqual(out.cursor_state.foreign, ['Users-alguien-repo-real']);
    assert.ok(out.notes.some((n) => /^ERROR/.test(n)), JSON.stringify(out.notes));
    // the reader of the short summary and of the report learn it too, without the name of somebody else's project
    const report = path.join(root, 'medicion.md');
    const second = runProbes(root, { bin, state: { fire_hooks: false, foreign_project: 'Users-alguien-otro-repo' }, args: ['--report', report], json: false });
    assert.match(second.r.stdout, /ERROR/);
    const md = fs.readFileSync(report, 'utf8');
    assert.match(md, /ERROR/);
    assert.ok(!md.includes('Users-alguien'), 'the report names a project of the dev');
  });

  await t.test('la carpeta corta se reconoce con cualquier largo de HOME', () => {
    for (const largo of [3, 23, 40]) {
      const root = tmpRoot();
      const home = path.join(root, 'h'.repeat(largo));
      const { r, out } = runProbes(root, { bin: fakePackage(root), state: { fire_hooks: false }, home });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(out.cursor_state.status, 'igual', `HOME de ${largo}: ${JSON.stringify(out.cursor_state)}`);
      assert.ok(!fs.existsSync(path.join(home, '.cursor')), 'the run left its folders behind');
    }
  });

  // The short name cuts the whole route, so a long data folder puts it above `projects`, where no listing shows it. Where
  // the cut lands depends on the length of the temporary folder, so these cases build the route to the exact length.
  const homeCutAt = (tail) => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(IS_WIN ? os.tmpdir() : '/tmp', 'cp-')));
    roots.push(parent);
    const size = 83 - parent.length - 1 - tail.length;
    assert.ok(size > 0, `${parent} is too long for this case`);
    return { parent, home: path.join(parent, 'h'.repeat(size)) };
  };

  await t.test('la carpeta corta que cae fuera de projects también se borra', () => {
    for (const tail of [`${path.sep}.cursor${path.sep}pro`, `${path.sep}.cu`, '']) {
      const root = tmpRoot();
      const { parent, home } = homeCutAt(tail);
      const { r, out } = runProbes(root, { bin: fakePackage(root), state: { fire_hooks: false }, home });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(out.cursor_state.status, 'igual', `corte en «${tail}»: ${JSON.stringify(out.cursor_state)}`);
      assert.strictEqual(out.cursor_state.removed.length, 2, JSON.stringify(out.cursor_state));
      assert.deepStrictEqual(fs.readdirSync(home), [], `corte en «${tail}»`);
      assert.deepStrictEqual(fs.readdirSync(parent), [path.basename(home)], `corte en «${tail}»`);
    }
  });

  await t.test('la carpeta corta que no se pudo borrar no sale como «igual»', { skip: IS_WIN || process.getuid() === 0 }, () => {
    const root = tmpRoot();
    const { home } = homeCutAt(`${path.sep}.cu`);
    try {
      const { r, out } = runProbes(root, { bin: fakePackage(root), state: { fire_hooks: false, lock_short_parent: true }, home });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(out.cursor_state.status, 'ERROR', JSON.stringify(out.cursor_state));
      assert.ok(out.notes.some((n) => /^ERROR/.test(n)), JSON.stringify(out.notes));
    } finally {
      fs.chmodSync(home, 0o755);
    }
  });

  await t.test('la carpeta corta de otra ruta no se borra', () => {
    const root = tmpRoot();
    const home = path.join(root, 'home');
    const slug = fs.realpathSync(os.tmpdir()).replace(/^[\\/]+/, '').replace(/[^A-Za-z0-9]+/g, '-');
    const foreign = path.basename(`${path.join(home, '.cursor', 'projects', slug).substring(0, 83)}-abcdef0`);
    const { r, out } = runProbes(root, { bin: fakePackage(root), state: { fire_hooks: false, foreign_project: foreign }, home });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(fs.readdirSync(path.join(home, '.cursor', 'projects')), [foreign]);
    assert.strictEqual(out.cursor_state.status, 'ERROR');
  });

  await t.test('con CURSOR_DATA_DIR limpia donde Cursor escribe', () => {
    const root = tmpRoot();
    const dataDir = path.join(root, 'datos');
    const { r, out } = runProbes(root, { bin: fakePackage(root), state: { fire_hooks: false }, extraEnv: { CURSOR_DATA_DIR: dataDir } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(out.cursor_state.status, 'igual', JSON.stringify(out.cursor_state));
    assert.ok(out.cursor_state.removed.length >= 1, JSON.stringify(out.cursor_state));
    assert.ok(!fs.existsSync(path.join(dataDir, 'projects')), 'the run left its folders behind');
  });

  await t.test('sin hooks, dice lo medido y nada más', () => {
    // a Cursor that reaches for its service before any hook: «does the session-start hook run with the service closed?»
    // is a measured «no», while what only a hook can show stays «not measured», and nothing claims more than that
    const root = tmpRoot();
    const bin = fakePackage(root);
    const { r, out } = runProbes(root, { bin, state: { fire_hooks: false } });
    assert.strictEqual(r.status, 0, r.stderr);
    const start = out.probes.S1.items.find((i) => i.id === 'arranque_con_servicio_cerrado');
    assert.ok(start, JSON.stringify(out.probes.S1.items.map((i) => i.id)));
    assert.deepStrictEqual([start.status, start.answer], ['MEDIDO', false], JSON.stringify(start));
    assert.match(start.output, /servicio cerrado/);
    for (const s of ['S3', 'S4']) {
      const run = out.probes[s].items.find((i) => i.source === EJECUCION);
      assert.strictEqual(run.status, 'NO MEDIDO', `${s}: ${JSON.stringify(run)}`);
      assert.match(run.motivo, /no disparó ningún hook/);
    }
    assert.doesNotMatch(out.decisions.D4.motivo, /no corre antes del modelo/);
    assert.strictEqual(out.decisions.D5.supuesto, true);
  });

  await t.test('una carpeta de otra sesión en el mismo temporal no se borra', () => {
    const root = tmpRoot();
    const bin = fakePackage(root);
    const slug = fs.realpathSync(os.tmpdir()).replace(/^[\\/]+/, '').replace(/[^A-Za-z0-9]+/g, '-');
    const foreign = `${slug}-otra-sesion-de-cursor`;
    const { r, out } = runProbes(root, { bin, state: { fire_hooks: false, foreign_project: foreign } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'home', '.cursor', 'projects')), [foreign]);
    assert.strictEqual(out.cursor_state.status, 'ERROR', JSON.stringify(out.cursor_state));
    assert.ok(out.cursor_state.removed.length >= 1, JSON.stringify(out.cursor_state));
  });

  await t.test('sólo el rechazo de la dirección cerrada es «no corrió ningún hook»', async (t2) => {
    const start = (state) => {
      const root = tmpRoot();
      const { r, out } = runProbes(root, { bin: fakePackage(root), state: Object.assign({ fire_hooks: false }, state) });
      assert.strictEqual(r.status, 0, r.stderr);
      return out.probes.S1.items.find((i) => i.id === 'arranque_con_servicio_cerrado');
    };
    await t2.test('otro error', () => {
      const s = start({ run_error: 'Error: network policy denied the connection' });
      assert.strictEqual(s.status, 'ERROR', JSON.stringify(s));
      assert.match(s.motivo, /network policy/);
    });
    await t2.test('rechazo de otra dirección', () => {
      const s = start({ run_error: 'Error: connect ECONNREFUSED 10.0.0.5:3128 (proxy)' });
      assert.strictEqual(s.status, 'ERROR', JSON.stringify(s));
    });
    await t2.test('la palabra trust en una ruta no pisa el rechazo', () => {
      const s = start({ run_error_after: 'at /opt/trustin/app/index.js:1' });
      assert.deepStrictEqual([s.status, s.answer], ['MEDIDO', false], JSON.stringify(s));
    });
    await t2.test('el rechazo después de mucho texto', () => {
      const s = start({ run_error_before: 'aviso '.repeat(1000) });
      assert.deepStrictEqual([s.status, s.answer], ['MEDIDO', false], JSON.stringify(s));
    });
    await t2.test('el pedido de confianza de verdad', () => {
      const s = start({ run_error: 'Error: Workspace Trust Required' });
      assert.strictEqual(s.status, 'ERROR', JSON.stringify(s));
      assert.match(s.motivo, /confiar/);
    });
  });

  await t.test('un hook lanzado sin esperar se mide igual', () => {
    const root = tmpRoot();
    const { r, out } = runProbes(root, { bin: fakePackage(root), state: { no_wait: true, events: ['sessionStart'] } });
    assert.strictEqual(r.status, 0, r.stderr);
    const start = out.probes.S1.items.find((i) => i.id === 'arranque_con_servicio_cerrado');
    assert.deepStrictEqual([start.status, start.answer], ['MEDIDO', true], JSON.stringify(start));
  });

  await t.test('una ejecución que llegó al servicio no pasa por servicio cerrado', () => {
    const root = tmpRoot();
    const { r, out } = runProbes(root, { bin: fakePackage(root), state: { exit_code: 0, events: ['sessionStart', 'afterAgentResponse', 'stop'] } });
    assert.strictEqual(r.status, 0, r.stderr);
    const start = out.probes.S1.items.find((i) => i.id === 'arranque_con_servicio_cerrado');
    assert.strictEqual(start.status, 'NO MEDIDO', JSON.stringify(start));
    assert.ok(out.notes.some((n) => /^ERROR.*servicio/.test(n)), JSON.stringify(out.notes));
  });

  await t.test('S3 mira todos los hooks y compara por valor', async (t2) => {
    const s3 = (state, extraEnv) => {
      const root = tmpRoot();
      const { r, out } = runProbes(root, { bin: fakePackage(root), state, extraEnv });
      assert.strictEqual(r.status, 0, r.stderr);
      return out.probes.S3.items.find((i) => i.id === 'variables_de_id_en_el_hook');
    };
    await t2.test('un payload ilegible no se mide', () => {
      const s = s3({ raw_payload: 'no es json', env: { CURSOR_CONVERSATION_ID: 'conv-1234' } });
      assert.strictEqual(s.status, 'NO MEDIDO', JSON.stringify(s));
      assert.match(s.motivo, /payload/);
    });
    for (const raw of ['[]', '42', '{}']) {
      await t2.test(`un payload sin ids no se mide: ${raw}`, () => {
        const s = s3({ raw_payload: raw, env: { CURSOR_CONVERSATION_ID: 'conv-1234' } });
        assert.strictEqual(s.status, 'NO MEDIDO', JSON.stringify(s));
      });
    }
    await t2.test('la coincidencia puede estar en otro hook', () => {
      const s = s3({ conversation_id: 'conv-1234', event_env: { beforeSubmitPrompt: { CURSOR_CONVERSATION_ID: 'conv-1234' } } });
      assert.strictEqual(s.status, 'MEDIDO', JSON.stringify(s));
      assert.deepStrictEqual(s.answer.matching, ['CURSOR_CONVERSATION_ID']);
    });
    await t2.test('el primer payload ilegible no tapa al segundo', () => {
      const s = s3({ conversation_id: 'conv-1234', env: { CURSOR_CONVERSATION_ID: 'conv-1234' }, event_raw_payload: { sessionStart: 'no es json' } });
      assert.strictEqual(s.status, 'MEDIDO', JSON.stringify(s));
      assert.strictEqual(s.answer.matches_payload, true);
    });
    await t2.test('una variable con otro nombre coincide por su valor', () => {
      const s = s3({ conversation_id: 'conv-1234', env: { AGENT_THREAD_UUID: 'conv-1234', OTRA_COSA: 'valor-ajeno' } });
      assert.deepStrictEqual(s.answer.matching, ['AGENT_THREAD_UUID']);
      assert.ok(!JSON.stringify(s).includes('valor-ajeno'), 'it stored a value that matches nothing');
    });
    await t2.test('un id numérico coincide', () => {
      const s = s3({ raw_payload: '{"conversation_id":1234}', env: { CURSOR_CONVERSATION_ID: '1234' } });
      assert.strictEqual(s.answer.matches_payload, true, JSON.stringify(s));
    });
    await t2.test('lo que hereda de quien lanzó las sondas no cuenta', () => {
      const s = s3({ conversation_id: 'conv-1234' }, { CURSOR_CONVERSATION_ID: 'de-afuera', CLAUDE_CODE_SESSION_ID: 'de-afuera-2', TERM_SESSION_ID: 'de-afuera-3' });
      assert.strictEqual(s.status, 'MEDIDO', JSON.stringify(s));
      assert.ok(!JSON.stringify(s).includes('de-afuera'), JSON.stringify(s));
    });
  });

  await t.test('la lectura del paquete dice lo que hay', async (t2) => {
    const read = (source) => {
      const root = tmpRoot();
      const { r, out } = runProbes(root, { bin: fakePackage(root, { source }), state: { fire_hooks: false } });
      assert.strictEqual(r.status, 0, r.stderr);
      return { root, out };
    };
    await t2.test('algo que no es Cursor no responde «no trae»', () => {
      const rules = read('console.log("algo que no es Cursor")').out.probes.S1.items.find((i) => i.id === 'reglas_en_el_codigo');
      assert.strictEqual(rules.status, 'ERROR', JSON.stringify(rules));
    });
    await t2.test('los archivos de reglas y la carpeta global', () => {
      const { out } = read('const a=["AGENTS.md","CLAUDE.local.md",user_rules];const r=(0,a.join)((0,i.homedir)(),".cursor","rules");');
      const rules = out.probes.S1.items.find((i) => i.id === 'reglas_en_el_codigo');
      assert.deepStrictEqual(rules.answer.slice().sort(), ['AGENTS.md', 'CLAUDE.local.md']);
      const user = out.probes.S1.items.find((i) => i.id === 'carpeta_de_reglas_de_usuario');
      assert.strictEqual(user.answer, true, JSON.stringify(user));
      assert.match(out.decisions.D4.motivo, /~\/\.cursor\/rules/);
      assert.strictEqual(out.decisions.D4.rama, '(c)');
    });
    await t2.test('los nombres de los hooks', () => {
      const { out } = read('const h={a:"workspaceOpen",b:"sessionStart"};');
      const hooks = out.probes.S1.items.find((i) => i.id === 'hooks_en_el_codigo');
      assert.deepStrictEqual(hooks.answer.slice().sort(), ['sessionStart', 'workspaceOpen']);
    });
    await t2.test('sólo --endpoint: lo pasa como opción', () => {
      const { root } = read('const h="sessionStart";opt("-e, --endpoint <url>","Target API endpoint URL");');
      const calls = fs.readFileSync(path.join(root, 'fake-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const run = calls.find((c) => c.argv.includes('-p'));
      assert.ok(run.argv.includes('--endpoint'), run.argv.join(' '));
    });
    await t2.test('sin cómo apuntar el servicio, no hay ejecución', () => {
      const { root, out } = read('const h="sessionStart";');
      const s3run = out.probes.S3.items.find((i) => i.source === EJECUCION);
      assert.match(s3run.motivo, /sin mecanismo/);
      const calls = fs.readFileSync(path.join(root, 'fake-calls.jsonl'), 'utf8');
      assert.ok(!calls.includes('"-p"'), 'it ran against the real service');
    });
  });

  await t.test('la versión: vacía no es medida, y un error no se publica en claro', () => {
    const root = tmpRoot();
    const { out } = runProbes(root, { bin: fakePackage(root), state: { fire_hooks: false, version: '' } });
    assert.strictEqual(out.version.status, 'ERROR', JSON.stringify(out.version));
    const home = path.join(root, 'home');
    const report = path.join(root, 'medicion.md');
    runProbes(root, { bin: fakePackage(root), state: { fire_hooks: false, version_stderr: `Error: ${home}/x --api-key sk-abc` }, args: ['--report', report] });
    const md = fs.readFileSync(report, 'utf8');
    assert.ok(!md.includes(home), 'the report carries the HOME');
    assert.ok(!md.includes('sk-abc'), 'the report carries a secret');
  });

  await t.test('sin carpeta temporal, sigue con el paquete y sale 0', () => {
    const root = tmpRoot();
    const { r, out } = runProbes(root, { bin: fakePackage(root), extraEnv: { TMPDIR: path.join(root, 'no-existe'), TEMP: path.join(root, 'no-existe'), TMP: path.join(root, 'no-existe') } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(out.probes.S3.items.find((i) => i.source === EJECUCION).status, 'NO MEDIDO');
    assert.strictEqual(out.probes.S1.items.find((i) => i.source === 'paquete').status, 'MEDIDO');
  });

  await t.test('argumentos inválidos y un informe que no se puede escribir', () => {
    assert.throws(() => probes.parseArgs(['--report', '--json']), /--report/);
    assert.throws(() => probes.parseArgs(['--timeout-ms', '3000000000']), /--timeout-ms/);
    assert.strictEqual(probes.parseArgs(['--timeout-ms', '2147483647']).timeoutMs, 2147483647);
    const root = tmpRoot();
    const { r, out } = runProbes(root, { bin: fakePackage(root), state: { fire_hooks: false }, args: ['--report', root] });
    assert.strictEqual(r.status, 1);
    assert.ok(out, 'the measurement was lost with the report');
  });

  await t.test('una contrabarra no rompe una fila del informe', () => {
    const item = { id: 'x', question: 'q', source: EJECUCION, status: 'MEDIDO', motivo: null, answer: null, command: null, output: 'C:\\ruta\\|fin', evidence: [] };
    const probe = { status: 'MEDIDO', motivo: null, items: [item] };
    const md = probes.renderReport({
      measured_at: 'hoy',
      cursor: { path: null, package_dir: null },
      version: { status: 'NO MEDIDO', motivo: 'm', command: 'c' },
      probes: { S1: probe, S2: probe, S3: probe, S4: probe },
      decisions: Object.fromEntries(['D4', 'D5', 'D8', 'D9'].map((d) => [d, { rama: 'r', motivo: 'm', supuesto: true }])),
      notes: [],
    });
    assert.ok(md.includes('C:\\\\ruta\\\\\\|fin'), md);
  });

  await t.test('quién aparece como cursor-agent', () => {
    const seen = (args, exe = 'node') => probes.cursorSeenAs([{ exe, args }]);
    assert.strictEqual(seen('/Users/ana maria/.local/bin/cursor-agent --use-system-ca /x/index.js -p ok'), 'linea de comando');
    assert.strictEqual(seen('/bin/bash /home/u/.local/bin/cursor-agent -p ok', 'bash'), 'linea de comando');
    assert.strictEqual(seen('node /x/index.js', 'cursor-agent'), 'ejecutable');
    assert.strictEqual(seen('node /x/my-cursor-agent-helper.js'), 'no aparece');
  });

  await t.test('la línea base no depende del ambiente del dev', () => {
    const generate = path.join(ROOT, 'scripts', 'tests', 'fixtures', '8.90-baseline', 'generate.js');
    const plain = spawnSync(process.execPath, [generate, '--check'], { encoding: 'utf8', timeout: 60000 });
    const noisy = spawnSync(process.execPath, [generate, '--check'], { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { TYCON_PIPELINE_COST_TIER: 'lean', TYCON_PACKS_DIR: tmpRoot() }) });
    assert.strictEqual(noisy.status, plain.status, `${plain.stderr}\n${noisy.stderr}`);
  });

  await t.test('sin ps no dice que Cursor no aparece', { skip: IS_WIN }, () => {
    const root = tmpRoot();
    const bin = fakePackage(root);
    const { r, out } = runProbes(root, { bin, state: { env: { PATH: path.join(root, 'sin-nada') } } });
    assert.strictEqual(r.status, 0, r.stderr);
    const s4run = out.probes.S4.items.find((i) => i.source === EJECUCION);
    assert.strictEqual(s4run.status, 'NO MEDIDO', JSON.stringify(s4run));
    assert.match(s4run.motivo, /ps/);
  });

  await t.test('un paquete que no se puede leer entero no responde', () => {
    const root = tmpRoot();
    const bin = fakePackage(root);
    fs.mkdirSync(path.join(bin, 'no-se-lee.js'));
    const { r, out } = runProbes(root, { bin, state: { fire_hooks: false } });
    assert.strictEqual(r.status, 0, r.stderr);
    const rules = out.probes.S1.items.find((i) => i.id === 'reglas_en_el_codigo');
    assert.strictEqual(rules.status, 'ERROR', JSON.stringify(rules));
    assert.match(rules.motivo, /no-se-lee\.js/);
  });

  await t.test('un paquete sin código no responde', () => {
    const root = tmpRoot();
    const bin = fakePackage(root);
    fs.rmSync(path.join(bin, 'index.js'));
    const { r, out } = runProbes(root, { bin, state: { fire_hooks: false } });
    assert.strictEqual(r.status, 0, r.stderr);
    const rules = out.probes.S1.items.find((i) => i.id === 'reglas_en_el_codigo');
    assert.strictEqual(rules.status, 'ERROR', JSON.stringify(rules));
  });

  await t.test('sin poder leer ~/.cursor/projects no hay ejecución', { skip: IS_WIN || process.getuid() === 0 }, () => {
    const root = tmpRoot();
    const bin = fakePackage(root);
    const projects = path.join(root, 'home', '.cursor', 'projects');
    fs.mkdirSync(projects, { recursive: true });
    fs.chmodSync(projects, 0o000);
    try {
      const { r, out } = runProbes(root, { bin });
      assert.strictEqual(r.status, 0, r.stderr);
      const s3run = out.probes.S3.items.find((i) => i.source === EJECUCION);
      assert.strictEqual(s3run.status, 'NO MEDIDO', JSON.stringify(s3run));
      assert.match(s3run.motivo, /cursor\/projects/);
      const calls = fs.readFileSync(path.join(root, 'fake-calls.jsonl'), 'utf8');
      assert.ok(!calls.includes('"-p"'), 'the run went on without being able to restore the listing');
    } finally {
      fs.chmodSync(projects, 0o755);
    }
  });

  await t.test('un registrador que no escribe se dice', () => {
    const root = tmpRoot();
    const recorder = path.join(root, 'recorder.js');
    fs.writeFileSync(recorder, probes.RECORDER);
    const good = probes.checkRecorder(recorder, path.join(root, 'prueba.jsonl'));
    assert.strictEqual(good, null, good);
    const bad = probes.checkRecorder(recorder, path.join(root, 'no-existe', 'prueba.jsonl'));
    assert.match(String(bad), /registrador/);
  });

  await t.test('el informe no publica secretos de los procesos', () => {
    const chain = [
      { pid: 1, start: 'hoy', exe: 'node', args: 'node x --api-key sk-secreto-1 --token=tok-secreto-2 API_KEY=clave-secreta-3 Bearer portador-4 alguien@example.com token=sec-a password=s-b' },
      { pid: 2, start: 'hoy', exe: 'node', args: 'node x api_key=sec-c --secret-key sec-d AZURE_DEVOPS_PAT=sec-e Authorization: Basic sec-f bearer sec-g' },
      { pid: 3, start: 'hoy', exe: 'node', args: 'node x https://usuario:sec-h@host.example.com/x --api-key "sec-i sec-j" --path /se/ve' },
    ];
    const item = { id: 'ancestros_del_hook', question: 'q', source: EJECUCION, status: 'MEDIDO', motivo: null, answer: { chain, cursor_seen_as: 'no aparece' }, command: 'c', output: 'o', evidence: [] };
    const probe = { status: 'MEDIDO', motivo: null, items: [item] };
    const md = probes.renderReport({
      measured_at: 'hoy',
      cursor: { path: null, package_dir: null },
      version: { status: 'NO MEDIDO', motivo: 'm', command: 'c' },
      probes: { S1: probe, S2: probe, S3: probe, S4: probe },
      decisions: Object.fromEntries(['D4', 'D5', 'D8', 'D9'].map((d) => [d, { rama: 'r', motivo: 'm', supuesto: true }])),
      notes: [],
    });
    assert.match(md, /pid 1/);
    for (const s of ['sk-secreto-1', 'tok-secreto-2', 'clave-secreta-3', 'portador-4', 'alguien@example.com', 'sec-a', 's-b', 'sec-c', 'sec-d', 'sec-e', 'sec-f', 'sec-g', 'sec-h', 'usuario', 'sec-i', 'sec-j']) assert.ok(!md.includes(s), `the report carries ${s}`);
    assert.match(md, /\/se\/ve/, 'an ordinary option is not a secret');
  });
});

test('CursorProbes_SeCuelga_TiempoMaximoYSigue', async (t) => {
  await t.test('hang', () => {
    const root = tmpRoot();
    const bin = fakePackage(root);
    const { r, out, elapsed } = runProbes(root, { bin, state: { hang: ['version', 'run'] }, args: ['--timeout-ms', '500'] });
    assert.strictEqual(r.status, 0, `exit ${r.status}\n${r.stderr}`);
    assert.ok(elapsed < 10000, `took ${elapsed} ms`);
    assert.strictEqual(out.version.status, 'NO MEDIDO');
    assert.match(out.version.motivo, /tiempo máximo/);
    // the run items hung; the package reading went on
    for (const s of ['S3', 'S4']) {
      const run = out.probes[s].items.find((i) => i.source === EJECUCION);
      assert.strictEqual(run.status, 'NO MEDIDO', `${s}: ${JSON.stringify(run)}`);
      assert.match(run.motivo, /tiempo máximo/);
    }
    assert.strictEqual(out.probes.S1.items.find((i) => i.source === 'paquete').status, 'MEDIDO');
  });
  await t.test('error', () => {
    const root = tmpRoot();
    const bin = fakePackage(root);
    // a generous limit: this case is about the failure, and a busy machine takes more than 500 ms to start the fake
    const { r, out, elapsed } = runProbes(root, { bin, state: { fail: ['run'] }, args: ['--timeout-ms', '8000'] });
    assert.strictEqual(r.status, 0, `exit ${r.status}\n${r.stderr}`);
    assert.ok(elapsed < 10000, `took ${elapsed} ms`);
    assert.strictEqual(out.version.status, 'MEDIDO');
    for (const s of ['S3', 'S4']) {
      const run = out.probes[s].items.find((i) => i.source === EJECUCION);
      assert.strictEqual(run.status, 'ERROR', `${s}: ${JSON.stringify(run)}`);
      assert.match(run.motivo, /falla de mentira/);
    }
    assert.strictEqual(out.probes.S2.items.find((i) => i.source === 'paquete').status, 'MEDIDO');
  });
});
