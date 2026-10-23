'use strict';

/**
 * phantom-round.test.js — una corrida nueva no hereda la ronda de revisores de la anterior.
 *
 * La secuencia: en la misma sesión, la última vuelta de revisores de una corrida se completa, pero su foto
 * automática sale rechazada (código editado después del último revisor) y la ronda queda sin sellar. Después
 * `pipeline.js start` arranca otra corrida y el paso 1 lanza al validador. El validador no puede «completar»
 * aquella ronda: si lo hace, la foto se toma sobre el marcador nuevo con el set esperado de la corrida anterior,
 * y `pipeline.js advisors` frena por un tope de vueltas que nadie corrió.
 *
 * Todo corre con un HOME de laboratorio, con el hook y marker.js de este árbol.
 *
 * stable-data: las horas del registro se arman relativas a «ahora» porque el hook estampa la hora real de cada
 * lanzamiento y la guarda de la foto compara contra ella; ninguna aserción depende de la fecha.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const HOOK = path.join(SCRIPTS, 'on-advisor-run.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const GUION = path.join(RAIZ, 'skills', 'tycon-create-story', 'scripts', 'story-without-bmad.js');
const { stateDir } = require('../lib/state-dir.js');
const { rondaCompleta } = require('../lib/advisor-round.js');

const SID = 'lab-vuelta-fantasma';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `fantasma-${p}-`));

function laboratorio() {
  const home = tmp('home');
  // `start` llama a marker.js por ~/.claude/agent-skills: el de este árbol, no el de la máquina
  const skills = path.join(home, '.claude', 'agent-skills');
  fs.mkdirSync(path.dirname(skills), { recursive: true });
  fs.symlinkSync(RAIZ, skills, 'junction');
  return home;
}

function entorno(home, extra) {
  const env = { ...process.env };
  for (const k of ['TYCON_GUIDES_DIR', 'TCG', 'NODE_TEST_CONTEXT', 'TYCON_SKILLS_DIR', 'TYCON_HOME', 'TYCON_STATE_DIR',
    'TYCON_AUTO_SNAPSHOT', 'TYCON_SNAPSHOT_GUARD', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  return Object.assign(env, {
    HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_SESSION_ID: SID,
    TYCON_PACKS_DEFAULT: 'none', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'acme@example.invalid', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'acme@example.invalid',
  }, extra || {});
}

const registro = (home) => path.join(stateDir(home), 'advisor-runs', `${SID}.jsonl`);
const lineas = (home) => fs.readFileSync(registro(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
function anotar(home, ...eventos) {
  fs.mkdirSync(path.dirname(registro(home)), { recursive: true });
  fs.appendFileSync(registro(home), eventos.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function marcador(home, datos) {
  const r = spawnSync(process.execPath, [MARKER, 'set', JSON.stringify(datos)], { env: entorno(home), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}
function leerMarcador(home) {
  const r = spawnSync(process.execPath, [MARKER, 'get'], { env: entorno(home), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** Un lanzamiento de subagente, como lo ve el hook. */
function lanzar(home, agente, cwd) {
  const r = spawnSync(process.execPath, [HOOK], {
    env: entorno(home), encoding: 'utf8', cwd,
    input: JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type: agente, prompt: 'x' }, session_id: SID, cwd }),
  });
  assert.strictEqual(r.status, 0, r.stderr);
}

/** La vuelta 2 de la corrida anterior: completa, con su foto rechazada y sin sello (el estado que deja el arnés de hoy). */
function vueltaAnteriorSinSello(home) {
  const hace = (s) => new Date(Date.now() - s * 1000).toISOString();
  anotar(home,
    { ts: hace(600), event: 'step5-start', expected: ['tycon-plugin-security-basics', 'tycon-silent-failure-hunter'], mode: 'smart-reloop', iter: 2 },
    { ts: hace(590), advisor: 'tycon-plugin-security-basics', model: 'sonnet', repo: null, story: '1.0' },
    { ts: hace(585), advisor: 'tycon-silent-failure-hunter', model: 'sonnet', repo: null, story: '1.0' });
}

test('T1 Ronda_DespuesDeRunStart_NoEstaAbierta: la ronda de la corrida anterior no se completa en la nueva', () => {
  const crudo = [
    { event: 'step5-start', expected: ['a'], iter: 2 },
    { advisor: 'a', story: '1.0' },
    { event: 'run-start', story: '1.1' },
    { advisor: 'tycon-story-validator', story: '1.1' },
  ].map((e) => JSON.stringify(e));
  assert.strictEqual(rondaCompleta(crudo).completa, false);
  assert.strictEqual(rondaCompleta(crudo).iter, null);
  // sin la marca de corrida nueva, la misma ronda sí está completa: el corte es la marca, no otra cosa
  assert.strictEqual(rondaCompleta(crudo.filter((l) => !l.includes('run-start'))).completa, true);
});

test('T2 CorridaNueva_ValidadorDelPaso1_NoTomaLaFoto: start de otra story y el validador no dejan una vuelta 2', () => {
  const home = laboratorio();
  vueltaAnteriorSinSello(home);
  const repo = tmp('repo');
  const answers = path.join(tmp('respuestas'), 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({
    title: 'El total suma el envío', asA: 'quien compra', iWant: 'ver el total con envío', soThat: 'no tener sorpresas',
    criteria: [{ given: 'un carrito con envío', when: 'abro el resumen', then: 'el total incluye el envío' }],
    tests: [{ name: 'Total_ConEnvio', criterion: 1, level: 'unit', scenario: 'envío de 500', expected: 'total + 500' }],
    verify: ['npm test'],
  }));
  const g = spawnSync(process.execPath, [GUION, 'write', '--repo', repo, '--answers', answers], { env: entorno(home), encoding: 'utf8' });
  assert.strictEqual(g.status, 0, g.stderr);
  const story = JSON.parse(g.stdout).path;
  // el guion la deja en borrador; el recorrido la pasa a ready-for-dev después del validador
  fs.writeFileSync(story, fs.readFileSync(story, 'utf8').replace(/^status: draft$/m, 'status: ready-for-dev'));

  const s = spawnSync(process.execPath, [PIPELINE, 'start', '--story', story, '--repo', repo], { env: entorno(home), encoding: 'utf8', cwd: repo });
  const inicio = JSON.parse(s.stdout);
  assert.strictEqual(inicio.ready, true, JSON.stringify(inicio.pauses));
  assert.ok(lineas(home).some((e) => e.event === 'run-start'), 'start tiene que dejar la marca de corrida nueva en el registro');

  lanzar(home, 'tycon-story-validator', repo);

  const m = leerMarcador(home);
  assert.deepStrictEqual(m.iterations || {}, {}, `la corrida nueva quedó con vueltas que no corrió: ${JSON.stringify(m.iterations)}`);
  assert.ok(!lineas(home).some((e) => e.event === 'auto-snapshot'), 'el validador del paso 1 no cierra la ronda de la corrida anterior');
});

test('T3 Start_MismaStory_NoHeredaVueltas: la misma story corrida otra vez en la sesión arranca sin vueltas', () => {
  const home = laboratorio();
  const repo = tmp('repo');
  const answers = path.join(tmp('respuestas'), 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({
    title: 'El total suma el envío', asA: 'quien compra', iWant: 'ver el total', soThat: 'no tener sorpresas',
    criteria: [{ given: 'un carrito', when: 'abro el resumen', then: 'veo el total' }],
    tests: [{ name: 'Total', criterion: 1, level: 'unit', scenario: 'x', expected: 'y' }],
    verify: ['npm test'],
  }));
  const g = spawnSync(process.execPath, [GUION, 'write', '--repo', repo, '--answers', answers], { env: entorno(home), encoding: 'utf8' });
  assert.strictEqual(g.status, 0, g.stderr);
  const story = JSON.parse(g.stdout).path;
  // el guion la deja en borrador; el recorrido la pasa a ready-for-dev después del validador
  fs.writeFileSync(story, fs.readFileSync(story, 'utf8').replace(/^status: draft$/m, 'status: ready-for-dev'));
  const arrancar = () => {
    const s = spawnSync(process.execPath, [PIPELINE, 'start', '--story', story, '--repo', repo], { env: entorno(home), encoding: 'utf8', cwd: repo });
    assert.strictEqual(JSON.parse(s.stdout).ready, true, s.stdout);
  };
  arrancar();
  // la corrida anterior de la misma story dejó sus dos vueltas en el marcador de la sesión
  const ts = new Date().toISOString();
  marcador(home, { storyId: leerMarcador(home).storyId, iterations: { 1: { ts, filesSnapshot: [] }, 2: { ts, filesSnapshot: [] } } });
  // la tanda siguiente de la misma story: vuelve a estar lista para hacer
  fs.writeFileSync(story, fs.readFileSync(story, 'utf8').replace(/^status: .*$/m, 'status: ready-for-dev'));
  arrancar();
  assert.deepStrictEqual(leerMarcador(home).iterations, {});
});

test('T4 FotoRechazada_SellaLaRonda: la decisión de no tomar la foto cierra la ronda y no se reintenta', () => {
  const home = laboratorio();
  const repo = tmp('repo');
  fs.mkdirSync(path.join(repo, 'src'));
  const codigo = path.join(repo, 'src', 'total.js');
  fs.writeFileSync(codigo, 'module.exports = 1;\n');
  const despues = new Date(Date.now() + 120 * 1000).toISOString();
  marcador(home, { storyId: '1.0', repoPath: repo, filesTouched: [codigo], fileEvents: [{ path: codigo, ts: despues }] });
  anotar(home, { ts: new Date(Date.now() - 1000).toISOString(), event: 'step5-start', expected: ['tycon-plugin-security-basics'], iter: 2 });

  lanzar(home, 'tycon-plugin-security-basics', repo);   // completa la ronda; la foto sale rechazada
  const sellos = lineas(home).filter((e) => e.event === 'auto-snapshot');
  assert.strictEqual(sellos.length, 1, 'una foto rechazada es una decisión: la ronda queda sellada');
  assert.strictEqual(sellos[0].foto, 'rechazada');
  assert.ok(!(leerMarcador(home).iterations || {})['2'], 'rechazada: no hay foto de la vuelta 2');

  lanzar(home, 'Explore', repo);                         // otro agente después: no reintenta la foto
  assert.strictEqual(lineas(home).filter((e) => e.event === 'auto-snapshot').length, 1);
});

test('T5 VueltaManual_DespuesDeRunStart_NoAbre: un revisor de la corrida nueva no abre una vuelta manual de la anterior', () => {
  const { vueltaManual } = require('../lib/advisor-round.js');
  const base = [
    { ts: '2026-01-01T00:00:00Z', event: 'step5-start', expected: ['a'], iter: 2 },
    { ts: '2026-01-01T00:00:10Z', advisor: 'a', story: '1.0' },
    { ts: '2026-01-01T00:00:11Z', event: 'auto-snapshot', iter: 2 },
  ];
  const despues = { ts: '2026-01-01T00:10:00Z', advisor: 'a', story: '1.0' };
  const crudo = (xs) => xs.map((e) => JSON.stringify(e));
  assert.strictEqual(vueltaManual(crudo([...base, despues])).abre, true, 'sin corte, el mismo revisor después del sello abre la vuelta 2.1');
  assert.strictEqual(vueltaManual(crudo([...base, { ts: '2026-01-01T00:05:00Z', event: 'run-start', story: '1.0' }, despues])).abre, false);
});

test('T6 CheckCount_CorridaNuevaSinAdvisors_Frena: la ronda de la corrida anterior no cuenta ni se acepta el --ran', () => {
  const home = laboratorio();
  const repo = tmp('repo');
  anotar(home,
    { ts: new Date().toISOString(), event: 'step5-start', expected: ['tycon-plugin-security-basics'], iter: 2 },
    { ts: new Date().toISOString(), advisor: 'tycon-plugin-security-basics', story: '1.0' },
    { ts: new Date().toISOString(), event: 'run-start', story: '1.1' });
  const r = spawnSync(process.execPath, [PIPELINE, 'check-count', '--repo', repo, '--ran', 'tycon-plugin-security-basics'],
    { env: entorno(home), encoding: 'utf8', cwd: repo });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /todavía no lanzó revisores/);
});

test('T7 FotoQueFalla_NoSella: una falla que no es la decisión de rechazo deja la ronda abierta para reintentar', () => {
  const home = laboratorio();
  const repo = tmp('repo');
  // sin marcador: snapshot-iter sale con 1, no con la decisión 2
  anotar(home, { ts: new Date(Date.now() - 1000).toISOString(), event: 'step5-start', expected: ['tycon-plugin-security-basics'], iter: 2 });
  lanzar(home, 'tycon-plugin-security-basics', repo);
  assert.ok(!lineas(home).some((e) => e.event === 'auto-snapshot'), 'una falla que no es una decisión no sella');
});
