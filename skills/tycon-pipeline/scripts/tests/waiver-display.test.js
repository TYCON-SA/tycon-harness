'use strict';
/**
 * waiver-display.test.js — firmar un criterio que no se puede probar en vivo: el arnés le muestra el criterio a la
 * persona, la firma la da en la ventana de permiso (la cita del chat ya no firma), no se acepta el reenvío de otra
 * sesión, y el bloqueo sin terminal dice en llano las dos vías. El juez de la respuesta se prueba en la librería mientras
 * siga ahí.
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
const { conVentana } = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'tests', 'lib', 'window-passed.js'));
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
  const marker = (args, extra = {}, { ventana = false } = {}) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8', env: ventana ? conVentana({ ...env, ...extra }) : { ...env, ...extra }, input: '', detached: true });
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
const firmar = (lab, quote, extra = [], opts = {}) => lab.marker(['runtime-waiver', lab.story, '--acs', '1', '--approved-by', 'Dev de Prueba', ...(quote === null ? [] : ['--quote', quote]), ...extra], {}, opts);
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

test('WaiverOk_SinVentana_NotSigned @story-8.78 @ac-3 — el ok escrito en el chat no firma: sin la ventana, frena', () => {
  const lab = laboratorio();
  mostrar(lab);
  lab.conversar([delDev('firmo el AC 1, el servicio no tiene ambiente de prueba')]);
  const r = firmar(lab, null);
  assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no pasó por la ventana/);
  assert.match(r.stderr, /--terminal/);
  assert.equal(firmados(lab).length, 0);
});

test('WaiverOk_CitaNoFirma_VentanaFirma @story-8.78 @ac-4 — la cita, aun la que nombra el criterio, no firma; la ventana sí', () => {
  const lab = laboratorio();
  mostrar(lab);
  lab.conversar([delDev('firmo el AC 1', T(1))]);
  const c = firmar(lab, 'firmo el AC 1', [], { ventana: true });
  assert.notEqual(c.status, 0, 'la cita no firma');
  assert.match(c.stderr, /la cita ya no firma un criterio que no se puede probar en vivo/);
  assert.equal(firmados(lab).length, 0);
  const ok = firmar(lab, null, [], { ventana: true });
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  assert.match(ok.stderr, /Firmado en la ventana de permiso \(Dev de Prueba\)/);
  const f = firmados(lab);
  assert.equal(f.length, 1);
  assert.equal(f[0].ok.via, 'ventana');
  assert.ok(!('cita' in f[0].ok));
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
  // desde la sesión, sin la ventana: frena y dice cómo firmarlo en la terminal
  const s = lab.marker(['runtime-waiver', lab.story]);
  assert.notEqual(s.status, 0);
  assert.match(s.stderr, /no pasó por la ventana/, s.stderr);
  assert.match(s.stderr, /runtime-waiver .*--terminal/, 'la vía de la terminal');
  assert.equal(firmados(lab).length, 0);
  // en la ventana nueva de Windows, sin terminal de una persona: las dos vías, en llano
  const r = lab.marker(['runtime-waiver', lab.story], { TYCON_WAIVER_PLATFORM: 'win32', TYCON_WAIVER_IN_WINDOW: '1', TYCON_WAIVER_TIMEOUT_S: '1' });
  assert.notEqual(r.status, 0);
  const t = r.stderr;
  assert.match(t, /BLOQUEADO/, t);
  assert.match(t, /lo aprobás en la ventana de permiso/, 'la vía de la sesión');
  assert.match(t, /tu terminal/, 'la vía de la terminal');
  assert.match(t, /versión del arnés: \S+/i);
  assert.match(t, /\/tycon-harness/, 'cómo actualizar');
});

test('WaiverShown_OtherCopy_NotSigned @story-8.78 @ac-4', () => {
  // una copia de la historia con otro texto y la misma razón no se muestra ni se firma: la persona firma lo que vio
  const lab = laboratorio();
  const copia = path.join(lab.base, 'copia.md');
  fs.writeFileSync(copia, fs.readFileSync(lab.story, 'utf8').replace(TEXTO, 'el botón tiene el color de la marca'));
  const p = puertaBash(lab, `node ${MARKER} runtime-waiver ${copia} --acs 1`);
  assert.equal(p.stdout.trim(), '', 'una historia que no es la de la corrida no se muestra');
  assert.equal(gates(lab).filter((x) => x.name === 'ac-shown').length, 0);
  // ni con la ventana: la copia no es la historia de la corrida
  const c = lab.marker(['runtime-waiver', copia, '--acs', '1', '--approved-by', 'Dev de Prueba'], {}, { ventana: true });
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /no es la historia de la corrida/);
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

test('WaiverJudge_ListaDeCriterios: «firmo los AC 3, 5 y 7» firma los tres, y una lista incompleta no', () => {
  const juez = require(path.join(SCRIPTS, 'lib', 'waiver-display.js')).juez([3, 5, 7]);
  for (const t of ['firmo los AC 3, 5 y 7', 'firmo los criterios 3, 5 y 7', 'Firmo ACs 3, 5 e 7', 'firmo el AC 3, el AC 5 y el AC 7', 'firmo #3, #5 y #7']) {
    assert.equal(juez(t), null, `«${t}» firma los tres`);
  }
  for (const t of ['firmo los AC 3 y 5', 'firmo los AC 3, 5 y 17', 'firmo los AC 35 y 7', 'no firmo los AC 3, 5 y 7', '¿firmo los AC 3, 5 y 7?']) {
    assert.ok(juez(t), `«${t}» no firma los tres`);
  }
});

test('WaiverShown_VariosCriterios: el aviso propone la firma de todos en una sola frase', () => {
  const wd = require(path.join(SCRIPTS, 'lib', 'waiver-display.js'));
  const msg = wd.bloque({ storyId: '9.94', criterios: [{ ac: 3, text: 'a' }, { ac: 5, text: 'b' }, { ac: 7, text: 'c' }] });
  assert.ok(msg.includes('«firmo los AC 3, 5 y 7»'), msg);
  assert.equal(wd.juez([3, 5, 7])('firmo los AC 3, 5 y 7'), null, 'la frase que propone el aviso firma');
});

test('WaiverShown_AvisoCorto: un renglón por criterio, más el encabezado y cómo contestar', () => {
  // Claude Code antepone su propio rótulo a cada renglón del aviso: cada renglón de más es un aviso repetido en pantalla
  const msg = mostrar(laboratorio());
  assert.ok(msg.split('\n').length <= 3, msg);
  for (const t of ['historia 9.94', 'servicio externo del cliente', 'no tiene ambiente de prueba', 'T1', '«firmo el AC 1»', 'cuenta como probado']) {
    assert.ok(msg.includes(t), `falta «${t}»:\n${msg}`);
  }
});
