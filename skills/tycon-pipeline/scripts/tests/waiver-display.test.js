'use strict';
/**
 * waiver-display.test.js — firmar un criterio que no se puede probar en vivo: el arnés le muestra el criterio a la
 * persona antes del ok, el ok tiene que nombrarlo, no se acepta el reenvío de otra sesión, y el bloqueo sin terminal
 * dice en llano las dos vías.
 *
 * Todo corre los comandos de verdad contra un HOME y un repo de juguete. 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const TEXTO = 'el aviso queda registrado en el servicio externo del cliente';
const RAZON = 'el servicio externo no tiene ambiente de prueba';
// stable-data: las horas de la conversación van después de la muestra, que se anota con el reloj real
const T = (seg) => new Date(Date.now() + 60000 + seg * 1000).toISOString();
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-10-20T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-20T12:00:00Z' };
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

// Un repo con una story que declara el AC 1 imposible de probar en vivo, la prueba que lo cubre en verde, un marcador
// abierto, una HOME propia y la conversación de la sesión.
function laboratorio({ sid = 's-wd' } = {}) {
  const base = tmp('wd-');
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(home);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: GIT_ENV });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.94-juguete.md');
  fs.writeFileSync(story, ['---', 'story: "9.94"', 'title: "juguete"', 'status: in-progress', 'runtime_not_verifiable:', '  - ac: 1',
    `    reason: "${RAZON}"`, '    covered_by: T1', '---', '', '# Story 9.94', '', '## Acceptance Criteria', '',
    `1. **Given** un pedido **Then** ${TEXTO}.`, '', '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |',
    '|---|---|---|---|---|---|', '| T1 | `Aviso_QuedaRegistrado` | 1 | unit | x | y |', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  fs.mkdirSync(path.join(repo, '.advisors'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.advisors', 'tests-result.json'), JSON.stringify({ ts: new Date().toISOString(), story_id: '9.94', suite_green: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_PROFILE: '0', TYCON_WAIVER_LOG: path.join(base, 'home-waivers.jsonl') };
  for (const k of ['TYCON_HOME', 'TYCON_WAIVER_PLATFORM', 'TYCON_WAIVER_IN_WINDOW', 'NODE_TEST_CONTEXT']) delete env[k];
  const marker = (args, extra = {}) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8', env: { ...env, ...extra }, input: '', detached: true });
  const set = marker(['set', JSON.stringify({ storyId: '9.94', storyPath: story, repoPath: repo })]);
  assert.equal(set.status, 0, set.stderr);
  const runDir = require(PIPELINE).resolveRunDir(repo, '9.94', true, story);
  const lab = { base, repo, home, story, sid, env, marker, runDir };
  lab.conversar = (regs) => {
    const dir = path.join(home, '.claude', 'projects', '-repo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), regs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  lab.conversar([delAgente('Hay un criterio que no se puede probar en vivo.', new Date().toISOString())]);
  return lab;
}
const delDev = (texto, ts = T(1)) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: texto } });
const delAgente = (texto, ts = T(0)) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: texto }] } });

const pedirFirma = (lab) => `node ${MARKER} runtime-waiver ${lab.story} --acs 1`;
function puertaBash(lab, command) {
  return spawnSync('node', [path.join(SCRIPTS, 'on-bash-write-gate.js')], {
    cwd: lab.repo, encoding: 'utf8', env: lab.env,
    input: JSON.stringify({ session_id: lab.sid, tool_name: 'Bash', cwd: lab.repo, tool_input: { command } }),
  });
}
function despachar(lab, file_path, content) {
  fs.writeFileSync(file_path, content);
  return spawnSync('node', [path.join(SCRIPTS, 'hook-post-edit.js')], {
    cwd: lab.repo, encoding: 'utf8', env: lab.env,
    input: JSON.stringify({ session_id: lab.sid, tool_name: 'Write', cwd: lab.repo, tool_input: { file_path, content } }),
  });
}
const mostrar = (lab) => {
  const p = puertaBash(lab, pedirFirma(lab));
  assert.equal(p.status, 0, p.stderr);
  return p.stdout.trim() ? JSON.parse(p.stdout).systemMessage : '';
};
const firmar = (lab, quote, extra = []) => lab.marker(['runtime-waiver', lab.story, '--acs', '1', '--approved-by', 'Dev de Prueba', '--quote', quote, ...extra]);
const lineas = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const gates = (lab) => lineas(path.join(lab.home, '.claude', '.tycon-pipeline', 'gates.log'));
const firmados = (lab) => lineas(require(path.join(SCRIPTS, 'lib', 'runtime-waiver.js')).repoWaiverLogPath(lab.repo));

test('WaiverShown_BashGate_ShowsCriterion @story-8.78 @ac-1', () => {
  const lab = laboratorio();
  const msg = mostrar(lab);
  assert.match(msg, /historia 9\.94/);
  assert.match(msg, /servicio externo del cliente/, 'el texto del criterio');
  assert.match(msg, /no tiene ambiente de prueba/, 'por qué no se puede probar en vivo');
  assert.match(msg, /T1/, 'la prueba que lo cubre');
  assert.match(msg, /«firmo el AC 1»/);
  const g = gates(lab).filter((x) => x.name === 'ac-shown');
  assert.equal(g.length, 1);
  assert.deepEqual([g[0].story, g[0].ac], ['9.94', 1]);
  // mostrado una vez, no se repite
  assert.equal(mostrar(lab), '');
});

test('WaiverShown_Minimal_RequestFile @story-8.78 @ac-2', () => {
  const lab = laboratorio();
  const r = despachar(lab, path.join(lab.runDir, 'firma-pedida.json'), JSON.stringify({ acs: [1] }));
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : {};
  assert.match(String(out.systemMessage || ''), /servicio externo del cliente/, r.stdout);
  assert.match(String(out.systemMessage || ''), /«firmo el AC 1»/);
  assert.equal(gates(lab).filter((x) => x.name === 'ac-shown').length, 1);
});

test('WaiverOk_WithoutShowing_NotSigned @story-8.78 @ac-3', () => {
  const lab = laboratorio();
  lab.conversar([delDev('firmo el AC 1, el servicio no tiene ambiente de prueba')]);
  const r = firmar(lab, 'firmo el AC 1, el servicio no tiene ambiente de prueba');
  assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no se le mostró/);
  assert.match(r.stderr, /firma-pedida\.json/);
  assert.equal(firmados(lab).length, 0);
});

test('WaiverOk_Generic_NotSigned_Named_Signed @story-8.78 @ac-4', () => {
  const lab = laboratorio();
  mostrar(lab);
  lab.conversar([delDev('apruebo, seguí', T(1))]);
  const g = firmar(lab, 'apruebo, seguí');
  assert.notEqual(g.status, 0, 'un ok genérico no firma');
  assert.match(g.stderr, /AC 1/);
  lab.conversar([delDev('no firmo el AC 1 todavía', T(2))]);
  assert.notEqual(firmar(lab, 'no firmo el AC 1 todavía').status, 0, 'un ok que lo niega no firma');
  assert.equal(firmados(lab).length, 0);
  lab.conversar([delDev('no firmo el AC 1 todavía', T(2)), delDev('firmo el AC 1', T(3))]);
  const ok = firmar(lab, 'firmo el AC 1');
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  assert.equal(firmados(lab).length, 1);
});

test('WaiverOk_Relayed_Rejected @story-8.78 @ac-5', () => {
  const lab = laboratorio();
  mostrar(lab);
  lab.conversar([delDev('firmo el AC 1')]);
  const r = firmar(lab, 'firmo el AC 1', ['--relayed-by', 'coordinadora']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no se acepta reenviad[oa]/);
  assert.equal(firmados(lab).length, 0);
});

test('WaiverBlocked_SaysBothWays @story-8.78 @ac-6', () => {
  const lab = laboratorio();
  for (const extra of [{}, { TYCON_WAIVER_PLATFORM: 'win32', TYCON_WAIVER_IN_WINDOW: '1', TYCON_WAIVER_TIMEOUT_S: '1' }]) {
    const r = lab.marker(['runtime-waiver', lab.story], extra);
    assert.notEqual(r.status, 0);
    const t = r.stderr;
    assert.match(t, /BLOQUEADO/, t);
    assert.match(t, /firmo el AC/, 'la vía del chat');
    assert.match(t, /tu terminal/, 'la vía de la terminal');
    assert.match(t, /versión del arnés: \S+/i);
    assert.match(t, /\/tycon-harness/, 'cómo actualizar');
    if (extra.TYCON_WAIVER_PLATFORM) assert.match(t, /ventana/);
  }
});

test('WaiverShown_OtherCopyOrChangedText_NotSigned @story-8.78 @ac-4', () => {
  // una copia de la historia con otro texto y la misma razón no se muestra ni se firma; y cambiar el texto del criterio
  // después de la muestra la deja sin valor: la persona firma lo que vio
  const lab = laboratorio();
  const copia = path.join(lab.base, 'copia.md');
  fs.writeFileSync(copia, fs.readFileSync(lab.story, 'utf8').replace(TEXTO, 'el botón tiene el color de la marca'));
  const p = puertaBash(lab, `node ${MARKER} runtime-waiver ${copia} --acs 1`);
  assert.equal(p.stdout.trim(), '', 'una historia que no es la de la corrida no se muestra');
  assert.equal(gates(lab).filter((x) => x.name === 'ac-shown').length, 0);
  const c = lab.marker(['runtime-waiver', copia, '--acs', '1', '--approved-by', 'Dev de Prueba', '--quote', 'firmo el AC 1']);
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /no es la historia de la corrida/);
  // mostrada la verdadera, cambia el texto del criterio: la muestra ya no vale para firmar
  mostrar(lab);
  fs.writeFileSync(lab.story, fs.readFileSync(lab.story, 'utf8').replace(TEXTO, 'el aviso queda en cualquier lado'));
  lab.conversar([delDev('firmo el AC 1')]);
  const r = firmar(lab, 'firmo el AC 1');
  assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no se le mostró/);
  assert.equal(firmados(lab).length, 0);
});

test('WaiverJudge_OnlyAPlainYesSigns @story-8.78 @ac-4', () => {
  const juez = require(path.join(SCRIPTS, 'lib', 'waiver-display.js')).juez([1]);
  for (const t of ['¿firmo el AC 1?', 'no quiero firmar el AC 1', 'revisá el AC 1', 'apruebo, seguí', 'no lo firmo, el AC 1 está mal']) {
    assert.ok(juez(t), `«${t}» no es un sí`);
  }
  for (const t of ['firmo el AC 1', 'Firmo el criterio 1: no hay ambiente de prueba', 'sí, lo firmo, AC 1']) {
    assert.equal(juez(t), null, `«${t}» es un sí`);
  }
});
