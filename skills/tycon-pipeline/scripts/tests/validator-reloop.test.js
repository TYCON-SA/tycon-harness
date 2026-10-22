#!/usr/bin/env node
/**
 * validator-reloop.test.js — los re-loops sueltan al validador de stories después de dos veredictos
 * limpios seguidos, y VAL-C5/VAL-C6 corren sin modelo.
 *
 * Medido en 30 días: el validador corrió 508 veces; en los re-loops posteriores a dos veredictos limpios
 * seguidos después de implementar trajo algo nuevo en 2 de 24 lanzamientos, ninguno bloqueante (en los
 * anteriores a ese punto: 62 de 125).
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso dice la mutación que lo pone en rojo. Los que más pesan:
 *    · T9 — cualquier cosa que no sea `limpio` CORTA la racha (hallazgos, inconsistente, sin veredicto,
 *      un lanzamiento que no volvió). Contar «no hallazgos» en vez de «limpio» descontaría a ciegas.
 *    · T10 — lo de antes de implementar y lo de otra story no suma ni corta.
 *    · T12 — no poder mirar es INVOCAR, nunca descontar.
 *    · T13 — `Story N.10` no es `Story N.1`, y la marca en `tasks/todo.md` o en la propia story no cuenta.
 *    · T14 — `runStoryChecks` (lo que usa el pre-commit) NO gana VAL-*: un CRITICAL nuevo ahí frenaría
 *      commits que hoy pasan.
 *
 * El descuento lee la conversación con las libs del ARNÉS (el arnés): sin el arnés en la
 * máquina, los casos que lo necesitan se saltean diciendo «NO MEDIDO» (patrón de story-gate-cli.test.js).
 * Todo con HOME temporal: el registro real de la máquina no se toca.
 *
 * Correr: TYCON_GUIDES_DIR=<clon del arnés> node --test .../scripts/tests/validator-reloop.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const STEPS = path.join(SCRIPTS, '..', 'steps');
const AGENTE = path.join(SCRIPTS, '..', '..', '..', 'agents', 'tycon-story-validator.md');
const SID = 'test-validador-reloop';
const VAL = 'tycon-story-validator';

// El arnés se resuelve ANTES de falsear el HOME (con HOME falso la ruta canónica no existe).
// 🔴 Primero el repo en el que vive esta prueba, y los guiones por su nombre de hoy. Buscar
// `costo-revisores.js` y `veredicto-validador.js` (los nombres en castellano de antes del paso al inglés) dejaría
// que, en una máquina con un clon viejo en una carpeta conocida, ese clon tomara el lugar del arnés: casos en rojo sobre main.
// El repo propio va antes que TYCON_GUIDES_DIR: lo que se prueba es este árbol, no el que diga el ambiente.
const TCG = [path.resolve(__dirname, '..', '..', '..', '..'), process.env.TYCON_GUIDES_DIR, process.env.TCG, process.cwd()]
  .filter(Boolean)
  .find((d) => fs.existsSync(path.join(d, 'scripts', 'metrics', 'reviewers-cost.js')) && fs.existsSync(path.join(d, 'scripts', 'lib', 'validator-verdict.js')));
const SIN_ARNES = 'NO MEDIDO: no encontré el arnés con scripts/metrics/reviewers-cost.js y scripts/lib/validator-verdict.js (TYCON_GUIDES_DIR · TCG · la raíz de este repo · cwd)';

const T5 = Date.parse('2026-09-17T10:00:00.000Z');
const en = (min) => new Date(T5 + min * 60000).toISOString();

function mkRepo({ codigo = '// sin deuda\n', pipelines = null } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'valrl-repo-'));
  const git = (...a) => execFileSync('git', ['-C', r, ...a], { stdio: 'ignore' });
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.mkdirSync(path.join(r, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(r, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(r, 'src', 'a.js'), codigo);
  const fm = ['---', 'epic: 9', 'story: "9.9"', 'title: "algo"', 'status: in-progress'];
  if (pipelines) fm.push(...pipelines);
  fm.push('---');
  fs.writeFileSync(path.join(r, 'specs', 'story-9.9-algo.md'), [...fm, '', '# Story 9.9', '', '## Acceptance Criteria', '', '1. **Given** x **When** y **Then** z', '', '### Tests (1 verificaciones)', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|', '| T1 | `Algo_Pasa` | 1 | unit | x | y |', ''].join('\n'));
  fs.writeFileSync(path.join(r, 'tasks', 'todo.md'), '# todo\n');
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '.'); git('commit', '-qm', 'base');
  return r;
}

const lanz = (id, ts, prompt) => ({ type: 'assistant', timestamp: ts, message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: VAL, description: 'x', prompt } }] } });
const notif = (id, ts, informe) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: `<task-notification>\n<task-id>t-${id}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n<result>${informe}</result>\n<usage><subagent_tokens>100000</subagent_tokens><tool_uses>3</tool_uses><duration_ms>60000</duration_ms></usage>\n</task-notification>` } });

/**
 * Una sesión con veredictos. `pasos` = [{min, dice, historia}] — `dice` es el renglón (o null = sin resultado,
 * o 'sin-renglon'); `historia` = 'propia' (default) | 'otra'.
 */
function mkHome(repo, pasos, { marker = {}, conversacion = true, lineasCrudas = null } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'valrl-home-'));
  const activo = path.join(h, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activo, { recursive: true });
  // el tope de vueltas al máximo (el ajuste de la máquina): acá se mide qué revisores entran en cada vuelta, no el tope
  fs.writeFileSync(path.join(h, '.claude', '.tycon-pipeline', 'review-max-rounds.json'), '{ "max_rounds": 99 }\n');
  const story = path.join(repo, 'specs', 'story-9.9-algo.md');
  const a = path.join(repo, 'src', 'a.js');
  fs.writeFileSync(path.join(activo, `${SID}.json`), JSON.stringify({
    storyId: '9.9', storyPath: story, repoPath: repo, sessionId: SID,
    filesTouched: [a], fileEvents: [{ path: a, ts: new Date().toISOString() }],
    stepTimings: { 5: { startedAt: en(0) } },
    iterations: { 1: { ts: new Date(Date.now() - 120000).toISOString(), filesSnapshot: [a] }, 2: { ts: new Date(Date.now() - 60000).toISOString(), filesSnapshot: [a] } },
    ...marker,
  }, null, 2));
  if (conversacion) {
    const proj = path.join(h, '.claude', 'projects', 'carpeta-x');
    fs.mkdirSync(proj, { recursive: true });
    const lineas = [];
    pasos.forEach((p, i) => {
      const id = `toolu_${i}`;
      const prompt = p.prompt || (p.historia === 'otra' ? `Validá la story ${path.join(repo, 'specs', 'story-9.10-otra.md')}.` : `Validar la story en ${story} contra ${repo}.`);
      lineas.push(lanz(id, en(p.min), prompt));
      if (p.dice === null) return;
      lineas.push(notif(id, en(p.min + 2), p.dice === 'sin-renglon' ? '- revisé todo\n\nLimpio, 0 hallazgos.' : `- informe\n\nVeredicto: ${p.dice}`));
    });
    const texto = lineasCrudas !== null ? lineasCrudas : lineas.map((l) => JSON.stringify(l)).join('\n');
    fs.writeFileSync(path.join(proj, `${SID}.jsonl`), `${texto}\n`);
  }
  return h;
}

function correr(home, repo, args, envExtra = {}, { sinStory = false } = {}) {
  const story = sinStory ? [] : ['--story', path.join(repo, 'specs', 'story-9.9-algo.md')];
  // Desde la tercera vuelta el re-loop exige la nota de «repensar el enfoque»: estos casos miden la decisión del
  // validador, no el freno, así que la nota va puesta (el freno se prueba en reloop-rethink.test.js).
  // La vuelta que cuenta es la mayor entre la declarada y la que lleva el marcador (sus fotos de iteración + 1).
  let delMarcador = 0;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'active', `${SID}.json`), 'utf8'));
    delMarcador = Math.max(0, ...Object.keys(m.iterations || {}).map((k) => Number(k) + 1));
  } catch { /* sin marcador legible: vale la declarada */ }
  const declarada = args.includes('--iter') ? Number(args[args.indexOf('--iter') + 1]) : 1;
  const iter = ['smart-reloop', 'advisors'].includes(args[0]) ? Math.max(declarada, delMarcador) : 0;
  if (iter >= 3 && !sinStory) {
    const dicho = 'Nota de prueba: el enfoque se revisó y sigue igual, solo cambia el detalle del caso';
    const n = spawnSync(process.execPath, [path.join(SCRIPTS, 'marker.js'), 'rethink', '--iter', String(iter), '--repeated', dicho, '--keep', dicho, '--repo', repo, ...story],
      { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID } });
    assert.equal(n.status, 0, `no se pudo dejar la nota de la vuelta ${iter}: ${n.stderr}`);
  }
  const r = spawnSync(process.execPath, [PIPELINE, ...args, '--repo', repo, ...story, '--files', 'src/a.js'],
    { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_GUIDES_DIR: TCG || '', ...envExtra } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* se asserta abajo */ }
  return { status: r.status, json, stderr: r.stderr, stdout: r.stdout };
}

function lineasValidador(home) {
  const p = path.join(home, '.claude', '.tycon-pipeline', 'gates.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.name === 'validador-reloop');
}

function ultimoExpected(home) {
  const p = path.join(home, '.claude', '.tycon-pipeline', 'advisor-runs', `${SID}.jsonl`);
  const ev = fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'step5-start');
  return ev[ev.length - 1].expected;
}

const LIMPIO = 'limpio';
const HALLAZGOS = 'hallazgos (VAL-W15) · bloquea: no';

// El repo en el que vive esta prueba siempre trae los dos guiones: si no los encuentra, el árbol está roto, y los casos
// de abajo no pueden salir «salteados» en verde.
test('ValidatorReloop_HarnessFound_NotSkipped', () => {
  assert.ok(TCG, SIN_ARNES);
});

// ── T8 · ValidadorReloop_DosLimpios_SeDescuenta (AC 6) ─────────────────────────────────────────────
// Mutación: no descontar nunca (el validador sigue en el set), o descontar sin sacarlo del `expected`
// (check-count exigiría un lanzamiento que el set no pide).
test('T8 · dos veredictos limpios seguidos después de implementar → el re-loop no relanza al validador', (t) => {
  if (!TCG) return t.skip(SIN_ARNES);
  const repo = mkRepo();
  const home = mkHome(repo, [{ min: -30, dice: HALLAZGOS }, { min: 5, dice: LIMPIO }, { min: 20, dice: LIMPIO }]);

  const r = correr(home, repo, ['smart-reloop', '--iter', '3']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.json.rerun.includes(VAL), `el validador no tendría que estar en rerun: ${JSON.stringify(r.json.rerun)}`);
  assert.deepEqual([r.json.validador_reloop.invoca, r.json.validador_reloop.limpias_seguidas], [false, 2]);
  assert.ok(!ultimoExpected(home).includes(VAL), 'el expected de la vuelta tiene que venir descontado');
  const g = lineasValidador(home);
  assert.equal(g.length, 1);
  assert.deepEqual([g[0].invoca, g[0].limpias_seguidas, g[0].iter, g[0].storyId], [false, 2, 3, '9.9']);
  assert.equal(path.resolve(g[0].repoPath), path.resolve(repo));

  // Pedir la cuenta 4 después de servir la 3 (el helper le pone su nota).
  const r2 = correr(home, repo, ['advisors', '--iter', '4']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(!r2.json.all.includes(VAL), `advisors en la vuelta siguiente tampoco: ${JSON.stringify(r2.json.all)}`);
  assert.equal(r2.json.validador_reloop.invoca, false);
});

// ── T8b · sin story en los argumentos, los dos chequeos usan la del marcador ──
// Por la línea de comandos no se llega: sin --story el set no trae al validador. Se prueba la decisión directa.
// Mutación: pasarle a runValidatorChecks el `args.story` crudo (null) mientras la racha usa el marcador: el
// chequeo sin modelo sale «no pude mirar» y la decisión invoca por un motivo falso.
test('T8b · sin story en los argumentos, la decisión usa la del marcador también para VAL-C5/VAL-C6', (t) => {
  if (!TCG) return t.skip(SIN_ARNES);
  const repo = mkRepo();
  const home = mkHome(repo, [{ min: 5, dice: LIMPIO }, { min: 20, dice: LIMPIO }]);
  const marker = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'active', `${SID}.json`), 'utf8'));
  const { decidirValidadorEnReloop } = require(PIPELINE);
  const d = decidirValidadorEnReloop({ args: { iter: 3, repo, files: ['src/a.js'] }, marker, sessionId: SID, guidesDir: TCG, projectsDir: path.join(home, '.claude', 'projects') });
  assert.deepEqual([d.invoca, d.limpias_seguidas], [false, 2], d.motivo);
});

// ── T8d · las libs del arnés se buscan por su nombre de hoy ────────────────────────
// Buscar el medidor sólo por su nombre de antes del renombre anda en el equipo (por el reemplazo) pero no en una copia
// sin reemplazos: la decisión diría «sin las libs del arnés» y el validador se relanzaría siempre, callado.
// Un arnés que trae sólo `reviewers-cost.js` (el nombre de hoy) no debe decir «sin las libs del arnés».
test('T8d · un arnés que trae el medidor sólo con su nombre de hoy: la decisión lo encuentra', () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'valrl-arnes-'));
  fs.mkdirSync(path.join(lab, 'scripts', 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(lab, 'scripts', 'metrics', 'reviewers-cost.js'), 'module.exports={veredictosDeConversacion:()=>[]};\n');
  fs.writeFileSync(path.join(lab, 'scripts', 'metrics', 'tokens-digest.js'), "module.exports={ubicarTranscripcion:()=>({ruta:null,motivo:'conversación de laboratorio'})};\n");
  const { decidirValidadorEnReloop } = require(PIPELINE);
  const marker = { stepTimings: { 5: { startedAt: en(0) } } };
  const d = decidirValidadorEnReloop({ args: { iter: 3 }, marker, sessionId: SID, guidesDir: lab, projectsDir: path.join(lab, 'projects') });
  assert.equal(d.invoca, true);
  assert.doesNotMatch(d.motivo, /sin las libs del arnés/, d.motivo);
  assert.match(d.motivo, /conversación de laboratorio/, 'llegó a usar las libs que encontró por su nombre de hoy');
  // y un arnés sin ninguno de los dos nombres lo sigue diciendo
  const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'valrl-arnes-'));
  const d2 = decidirValidadorEnReloop({ args: { iter: 3 }, marker, sessionId: SID, guidesDir: vacio, projectsDir: path.join(vacio, 'projects') });
  assert.match(d2.motivo, /sin las libs del arnés/);
});

// ── T8c · check-count sin step5-start recalcula lo mismo que decidió el re-loop ──────
// Mutación: recalcular el set sólo con el descuento MECH-2 — exige al validador que el re-loop soltó y
// check-count da un rojo falso. Control: con UN limpio, el recálculo lo sigue exigiendo.
// Sin step5-start, check-count sólo cuenta con el override consciente (--trust-ran): sin él falla cerrado.
test('T8c · check-count sin step5-start aplica la decisión del validador al recalcular', (t) => {
  if (!TCG) return t.skip(SIN_ARNES);
  const OTROS = ['tycon-plugin-tests-coverage', 'tycon-plugin-security-basics', 'tycon-spec-first-checker', 'tycon-ac-coverage-checker',
    'tycon-silent-failure-hunter', 'tycon-feature-wiring-checker', 'tycon-deferral-tracker', 'tycon-plugin-react-conventions',
    'tycon-plugin-nextjs-conventions', 'tycon-plugin-dotnet-conventions'].join(',');
  const repo = mkRepo();
  const home = mkHome(repo, [{ min: 5, dice: LIMPIO }, { min: 20, dice: LIMPIO }]);
  const sinOverride = correr(home, repo, ['check-count', '--iter', '3', '--ran', OTROS]);
  assert.equal(sinOverride.status, 2, `sin step5-start y sin --trust-ran, check-count no confía en --ran: ${sinOverride.stdout}`);
  assert.match(sinOverride.stderr, /no hay step5-start/);
  const r = correr(home, repo, ['check-count', '--iter', '3', '--trust-ran', '--ran', OTROS]);
  assert.equal(r.status, 0, `con dos limpios el recálculo no exige al validador: ${r.stdout}${r.stderr}`);
  assert.equal(lineasValidador(home).length, 0, 'check-count no anota decisiones en gates.log');

  const repo1 = mkRepo();
  const home1 = mkHome(repo1, [{ min: 5, dice: LIMPIO }]);
  const r1 = correr(home1, repo1, ['check-count', '--iter', '3', '--trust-ran', '--ran', OTROS]);
  assert.notEqual(r1.status, 0, `con un solo limpio el validador sigue siendo exigido: ${r1.stdout}`);
});

// ── T9 · ValidadorReloop_RachaCortada_SeInvoca (AC 7) ──────────────────────────────────────────────
test('T9 · cualquier veredicto que no sea «limpio» corta la racha → se invoca', (t) => {
  if (!TCG) return t.skip(SIN_ARNES);
  const casos = [
    ['limpio → hallazgos', [{ min: 5, dice: LIMPIO }, { min: 20, dice: HALLAZGOS }], 0],
    ['hallazgos → limpio', [{ min: 5, dice: HALLAZGOS }, { min: 20, dice: LIMPIO }], 1],
    ['limpio → sin renglón', [{ min: 5, dice: LIMPIO }, { min: 20, dice: 'sin-renglon' }], 0],
    ['limpio → inconsistente', [{ min: 5, dice: LIMPIO }, { min: 20, dice: 'limpio (VAL-W3)' }], 0],
    ['limpio → sin resultado', [{ min: 5, dice: LIMPIO }, { min: 20, dice: null }], 0],
  ];
  for (const [nombre, pasos, k] of casos) {
    const repo = mkRepo();
    const home = mkHome(repo, pasos);
    const r = correr(home, repo, ['smart-reloop', '--iter', '3']);
    assert.equal(r.status, 0, `${nombre}: ${r.stderr}`);
    assert.ok(r.json.rerun.includes(VAL), `${nombre}: el validador tiene que estar en rerun`);
    assert.deepEqual([r.json.validador_reloop.invoca, r.json.validador_reloop.limpias_seguidas], [true, k], nombre);
    const g = lineasValidador(home);
    assert.deepEqual([g.length, g[0] && g[0].invoca], [1, true], nombre);
  }
});

// ── T10 · ValidadorReloop_Paso1YOtraStory_NoCuentan (AC 8) ─────────────────────────────────────────
test('T10 · lo de antes de implementar y lo de otra story no suma ni corta', (t) => {
  if (!TCG) return t.skip(SIN_ARNES);
  const casos = [
    ['dos limpios antes del paso 5 + uno después', [{ min: -40, dice: LIMPIO }, { min: -20, dice: LIMPIO }, { min: 5, dice: LIMPIO }], true, 1],
    ['uno propio + dos limpios de otra story', [{ min: 5, dice: LIMPIO }, { min: 10, dice: LIMPIO, historia: 'otra' }, { min: 15, dice: LIMPIO, historia: 'otra' }], true, 1],
    ['los hallazgos de otra story no cortan', [{ min: 5, dice: LIMPIO }, { min: 10, dice: HALLAZGOS, historia: 'otra' }, { min: 20, dice: LIMPIO }], false, 2],
    // Con «catalogo» en el nombre, la otra story contaba como propia y soltaba al validador
    ['un limpio de otra story con «catalogo» en el nombre no suma', [{ min: 5, dice: LIMPIO }, { min: 10, dice: LIMPIO, prompt: 'Validá la story specs/story-9.10-armar-el-catalogo-de-productos.md antes de implementarla.' }], true, 1],
  ];
  for (const [nombre, pasos, invoca, k] of casos) {
    const repo = mkRepo();
    const home = mkHome(repo, pasos);
    const r = correr(home, repo, ['smart-reloop', '--iter', '3']);
    assert.equal(r.status, 0, `${nombre}: ${r.stderr}`);
    assert.deepEqual([r.json.validador_reloop.invoca, r.json.validador_reloop.limpias_seguidas], [invoca, k], nombre);
  }
});

// ── T11 · ValidadorReloop_Vuelta1YForzado_SiempreInvoca (AC 9) ─────────────────────────────────────
test('T11 · la vuelta 1 no decide nada y el re-loop forzado invoca', (t) => {
  if (!TCG) return t.skip(SIN_ARNES);
  const repo = mkRepo();
  const home = mkHome(repo, [{ min: 5, dice: LIMPIO }, { min: 20, dice: LIMPIO }]);
  const r1 = correr(home, repo, ['advisors', '--iter', '1']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(r1.json.all.includes(VAL), 'en la vuelta 1 el validador corre siempre');
  assert.equal(r1.json.validador_reloop, undefined, 'la vuelta 1 no anota decisión');
  assert.equal(lineasValidador(home).length, 0);

  // El marcador lleva dos fotos: la primera llamada es la 3, así que la forzada es la 4.
  const r3 = correr(home, repo, ['smart-reloop', '--iter', '4', '--force-full-reloop']);
  assert.equal(r3.status, 0, r3.stderr);
  assert.ok(r3.json.rerun.includes(VAL), 'forzado → el validador está');
  const g = lineasValidador(home);
  assert.deepEqual([g.length, g[0].invoca, g[0].motivo], [1, true, 're-loop forzado']);
});

// ── T12 · ValidadorReloop_NoPudeMirar_SeInvoca (AC 10) ─────────────────────────────────────────────
test('T12 · no poder mirar es invocar, con el motivo', (t) => {
  if (!TCG) return t.skip(SIN_ARNES);
  const dos = [{ min: 5, dice: LIMPIO }, { min: 20, dice: LIMPIO }];
  const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'valrl-sin-arnes-'));
  const casos = [
    ['sin conversación', () => { const repo = mkRepo(); return [repo, mkHome(repo, dos, { conversacion: false }), {}]; }, /no pude|conversaci/i],
    ['conversación ilegible', () => { const repo = mkRepo(); return [repo, mkHome(repo, dos, { lineasCrudas: '{no es json\n{tampoco' }), {}]; }, /no pude|ilegible/i],
    ['sin arranque del paso 5', () => { const repo = mkRepo(); return [repo, mkHome(repo, dos, { marker: { stepTimings: {} } }), {}]; }, /paso 5/i],
    // sin paquetes instalados: sin arnés, el cargador no tiene a quién preguntar el default de `packs:`
    ['sin las libs del arnés', () => { const repo = mkRepo(); return [repo, mkHome(repo, dos), { TYCON_GUIDES_DIR: vacio, TYCON_PACKS_DIR: vacio }]; }, /arn[eé]s|lib/i],
  ];
  for (const [nombre, armar, motivo] of casos) {
    const [repo, home, env] = armar();
    const r = correr(home, repo, ['smart-reloop', '--iter', '3'], env);
    assert.equal(r.status, 0, `${nombre}: ${r.stderr}`);
    assert.ok(r.json.rerun.includes(VAL), `${nombre}: tiene que invocar`);
    assert.equal(r.json.validador_reloop.invoca, true, nombre);
    assert.match(r.json.validador_reloop.motivo, motivo, nombre);
    assert.equal(lineasValidador(home)[0].invoca, true, nombre);
  }
});

// ── T13 · ValChecks_DeudaYTandaBloqueada (AC 11) ───────────────────────────────────────────────────
test('T13 · VAL-C5 y VAL-C6 corren sin modelo', (t) => {
  const { runValidatorChecks } = require(path.join(SCRIPTS, 'lib', 'story-checks.js'));
  assert.equal(typeof runValidatorChecks, 'function', 'runValidatorChecks no existe');
  const reglas = (res) => res.findings.map((f) => `${f.rule}:${f.severity}`);

  let repo = mkRepo({ codigo: '// TODO(Story-9.9-deferral): falta el caso B\n' });
  const s = path.join(repo, 'specs', 'story-9.9-algo.md');
  assert.deepEqual(reglas(runValidatorChecks({ repo, storyPath: s, files: ['src/a.js'] })), ['VAL-C5:CRITICAL'], 'marca propia en código');

  repo = mkRepo({ codigo: '// TODO(Story-9.99-deferral) · pendiente Story 9.90 · FIXME: Story 9.9.1\n' });
  assert.deepEqual(reglas(runValidatorChecks({ repo, storyPath: path.join(repo, 'specs', 'story-9.9-algo.md'), files: ['src/a.js'] })), [], 'otras stories con id parecido no son la 9.9');

  repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'tasks', 'todo.md'), '- [ ] TODO(Story-9.9-deferral) tanda B\n');
  fs.appendFileSync(path.join(repo, 'specs', 'story-9.9-algo.md'), '\nEjemplo: `TODO(Story-9.9-deferral)`\n');
  assert.deepEqual(reglas(runValidatorChecks({ repo, storyPath: path.join(repo, 'specs', 'story-9.9-algo.md'), files: ['tasks/todo.md', 'specs/story-9.9-algo.md', 'src/a.js'] })), [], 'todo.md y la propia story no cuentan');

  // Un archivo que no se puede leer por algo que no es «no existe» (acá, una carpeta): no mirado ≠ sin deuda.
  // Mutación: saltearlo como un ENOENT, o anotar «sin marcas de deuda» en `ok` igual.
  repo = mkRepo();
  const noLeido = runValidatorChecks({ repo, storyPath: path.join(repo, 'specs', 'story-9.9-algo.md'), files: ['src', 'src/a.js'] });
  assert.deepEqual([reglas(noLeido), noLeido.ambiguous.map((a) => a.rule)], [[], ['VAL-C5']], 'ilegible → ambiguo');
  assert.match(noLeido.ambiguous[0].detail, /EISDIR/);
  assert.ok(!noLeido.ok.some((o) => o.rule === 'VAL-C5'), `con un archivo sin leer no se afirma «sin deuda»: ${JSON.stringify(noLeido.ok)}`);

  for (const [nombre, bloque, esperado] of [
    ['blocked sin blocked_by', ['pipelines:', '  - name: B-front', '    status: blocked'], ['VAL-C6:CRITICAL']],
    ['blocked con TBD', ['pipelines:', '  - name: B-front', '    status: blocked', '    blocked_by: "TBD"'], ['VAL-C6:CRITICAL']],
    ['blocked con causa real', ['pipelines:', '  - name: B-front', '    status: blocked', '    blocked_by: "Story 9.8 Task 3 — endpoint sin mergear"'], []],
  ]) {
    repo = mkRepo({ pipelines: bloque });
    assert.deepEqual(reglas(runValidatorChecks({ repo, storyPath: path.join(repo, 'specs', 'story-9.9-algo.md'), files: ['src/a.js'] })), esperado, nombre);
  }

  if (!TCG) return t.skip(`${SIN_ARNES} (la parte de la decisión del re-loop)`);
  repo = mkRepo({ codigo: '// TODO(Story-9.9-deferral): falta el caso B\n' });
  const home = mkHome(repo, [{ min: 5, dice: LIMPIO }, { min: 20, dice: LIMPIO }]);
  const r = correr(home, repo, ['smart-reloop', '--iter', '3']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.validador_reloop.invoca, true, 'con un VAL-C5 mecánico, el validador se invoca aunque haya dos limpios');
  assert.ok((r.json.mech_findings || []).some((f) => f.rule === 'VAL-C5'), 'y el hallazgo va a mech_findings');
});

// ── T14 · ValChecks_RunStoryChecksYMechCheck_SinCambios (AC 11, 15) ────────────────────────────────
test('T14 · runStoryChecks y mech-check no ganan VAL-*; parsePipelinesBlock sólo suma blockedBy', () => {
  const checks = require(path.join(SCRIPTS, 'lib', 'story-checks.js'));
  const repo = mkRepo({ codigo: '// TODO(Story-9.9-deferral)\n', pipelines: ['pipelines:', '  - name: B-front', '    status: blocked'] });
  const s = path.join(repo, 'specs', 'story-9.9-algo.md');
  const res = checks.runStoryChecks({ repo, storyPath: s, files: ['src/a.js'] });
  assert.ok(!res.findings.some((f) => /^VAL-/.test(f.rule)), `runStoryChecks no puede traer VAL-*: ${JSON.stringify(res.findings)}`);
  const p = checks.parsePipelinesBlock(fs.readFileSync(s, 'utf8'));
  assert.deepEqual(Object.keys(p[0]).sort(), ['acs', 'acsPending', 'blockedBy', 'name', 'pendingItems', 'status']);
  assert.deepEqual([p[0].name, p[0].status, p[0].blockedBy], ['B-front', 'blocked', null]);
  const mc = spawnSync(process.execPath, [PIPELINE, 'mech-check', '--repo', repo, '--story', s, '--files', 'src/a.js'], { encoding: 'utf8', env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'valrl-mc-')) } });
  const j = JSON.parse(mc.stdout);
  assert.ok(!j.findings.some((f) => /^VAL-/.test(f.rule)), 'mech-check tampoco');
});

// ── T18 · Steps_TextosDelValidador (AC 14, 6) ──────────────────────────────────────────────────────
test('T18 · los steps y el agente dicen cómo corre el validador ahora', () => {
  const s5 = fs.readFileSync(path.join(STEPS, 'step-07-reviewers.md'), 'utf8');
  const s7b = fs.readFileSync(path.join(STEPS, 'step-07-reviewers.md'), 'utf8');
  const ag = fs.readFileSync(AGENTE, 'utf8');
  assert.doesNotMatch(s5, /corre \*\*dos veces\*\*/, 'step-05 todavía dice que corre dos veces');
  assert.match(s5, /validador-reloop/);
  assert.match(s5, /dos veredictos limpios/);
  // el paso dice CUÁNDO corre (los tres momentos) y que el recorte lo decide el guion, no quien orquesta
  assert.match(s5, /\*\*tres momentos\*\* del pipeline/);
  assert.match(s5, /No lo lances a mano/);
  assert.match(s7b, /validador-reloop|dos veredictos limpios/);
  assert.match(ag, /Veredicto: limpio/);
  assert.match(ag, /VAL-W15/);
});
