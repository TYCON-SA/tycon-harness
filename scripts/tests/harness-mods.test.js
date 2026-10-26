#!/usr/bin/env node
'use strict';
// harness-mods.test.js — los mods de Claude Code del arnés: el cartel de la corrida, el comando /mods y
// la carpeta que el instalador suma a CLAUDE_CODE_PLUGIN_DIRS.
//
// La lógica del plugin vive en módulos puros (`mods/harness-mods/hooks/*.mjs`) para probarla con node sin el motor;
// lo que sólo el motor puede probar (dibujar, el comando de verdad) lo prueba harness-mods-plugin.test.sh.
//
// Correr: node --test --test-reporter=tap scripts/tests/harness-mods.test.js < /dev/null
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const RAIZ = path.resolve(__dirname, '..', '..');
const PLUGIN = path.join(RAIZ, 'mods', 'harness-mods');
const mod = (name) => import(pathToFileURL(path.join(PLUGIN, 'hooks', name)).href);

const T0 = Date.parse('2026-10-15T03:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const NOW = T0 + 40 * 60000;

// Una corrida en el paso 4: 0..3 terminados, 0b y 0c por bandera, el 4 corriendo hace 12 minutos.
function markerEnPaso4(extra = {}) {
  return JSON.stringify({
    storyId: '9.9',
    startedAt: at(0),
    stepsCompleted: [0, 1, 2, 3],
    stepsPending: [4, 5, 6, 7, 8],
    clockiStarted: true,
    adoMarkedActive: true,
    autonomous: true,
    stepTimings: {
      0: { startedAt: at(0), completedAt: at(1) },
      1: { startedAt: at(2), completedAt: at(10) },
      2: { startedAt: at(10), completedAt: at(20) },
      3: { startedAt: at(20), completedAt: at(28) },
      4: { startedAt: at(28) },
    },
    ...extra,
  });
}

function labHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mods-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}
const settingsOf = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
const writeSettings = (home, obj) => fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(obj, null, 2));

// ── El cartel ────────────────────────────────────────────────────────────────────────────────────────────────────

test('T1 Board_LineFromMarker_NoMoney — el renglón trae story, el nombre del paso, n de 11, minutos y contexto, sin dinero', async () => {
  const { readRun, boardLine } = await mod('run.mjs');
  const run = readRun(markerEnPaso4(), NOW);
  assert.ok(run, 'la ejecución se lee');
  const line = boardLine(run, 37);
  assert.match(line, /Story 9\.9/);
  assert.match(line, / · Implementar · /, 'el paso por su nombre llano; el 4 viejo arrancado es «Implementar»');
  assert.match(line, /4 de 11 hechos/, 'el marker viejo con la equivalencia: Arranque, Validar, Armar y Aprobar el plan');
  assert.match(line, /12 min en este paso/);
  assert.match(line, /40 min en total/);
  assert.match(line, /contexto usado 37 %/);
  assert.doesNotMatch(line, /USD|\$|gasto/i, 'nada de dinero');
  assert.doesNotMatch(line, /te espera/);
});

test('T2 Board_WaitingForHuman_Yellow — waitingForHuman, o Aprobar el plan / la decisión de Hallazgos sin modo autónomo, espera al dev', async () => {
  const { readRun, boardLine } = await mod('run.mjs');
  const porBandera = readRun(markerEnPaso4({ waitingForHuman: true }), NOW);
  assert.strictEqual(porBandera.waiting, true);
  assert.match(boardLine(porBandera, 10), /te espera/);

  const timings = { 7: { startedAt: at(30) } };
  const en7 = (autonomous) => JSON.stringify({ storyId: '9.9', startedAt: at(0), stepsCompleted: [0, 1, 2, 3, 4, 5, 6], autonomous, stepTimings: timings });
  assert.strictEqual(readRun(en7(false), NOW).waiting, true, 'paso 7 sin modo autónomo');
  assert.strictEqual(readRun(en7(true), NOW).waiting, false, 'paso 7 en modo autónomo no espera');
});

test('T3 Board_ToastOncePerStep — un aviso por story:paso que espera', async () => {
  const { readRun, warnKey } = await mod('run.mjs');
  const warned = [];
  const r1 = readRun(markerEnPaso4({ waitingForHuman: true }), NOW);
  const k1 = warnKey(r1, warned);
  assert.strictEqual(k1, '9.9:implement');
  warned.push(k1);
  assert.strictEqual(warnKey(r1, warned), null, 'el segundo refresco del mismo paso no avisa');
  assert.strictEqual(warnKey(readRun(markerEnPaso4({ waitingForHuman: true }), NOW + 60000), warned), null, 'ni el tercero');
  const otro = readRun(JSON.stringify({ ...JSON.parse(markerEnPaso4({ waitingForHuman: true })), stepsCompleted: [0, 1, 2, 3, 4], stepTimings: { ...JSON.parse(markerEnPaso4()).stepTimings, 4: { startedAt: at(28), completedAt: at(35) }, 5: { startedAt: at(35) } } }), NOW);
  assert.strictEqual(warnKey(otro, warned), '9.9:reviewers', 'otro paso que espera, otro aviso');
  assert.strictEqual(warnKey(readRun(markerEnPaso4(), NOW), []), null, 'sin espera, sin aviso');
});

test('T4 Board_PipelineTable_NoCostColumn — /pipeline: Paso | Estado | Tiempo, sin gasto', async () => {
  const { readRun, pipelineTable } = await mod('run.mjs');
  const t = pipelineTable(readRun(markerEnPaso4(), NOW));
  assert.match(t, /\| Paso \| Estado \| Tiempo \|/);
  assert.doesNotMatch(t, /gasto|USD|\$/i);
  const fila = (name) => t.split('\n').find((l) => new RegExp(`^\\| \\d+\\. ${name} \\|`).test(l));
  assert.match(fila('Validar la historia'), /^\| 2\. Validar la historia \| hecho \| 8 min \|/);
  assert.match(fila('Arranque'), /\| hecho \|/, 'el Arranque viejo, con sus partes por bandera');
  assert.match(fila('Implementar'), /\| corriendo \| 12 min \|/);
  assert.match(fila('Correr las pruebas'), /\| pendiente \| — \|/);
  assert.match(fila('Revisores'), /\| pendiente \| — \|/);
  assert.match(t.split('\n')[0], /Story 9\.9/);
});

test('T5 Board_NoMarkerOrBroken_Nothing — sin ejecución no dibuja y /pipeline lo dice; un archivo roto es un error', async () => {
  const { readRun, readRunError, NO_RUN_TEXT, BROKEN_RUN_TEXT } = await mod('run.mjs');
  for (const txt of [null, undefined, '', '{roto', '[]', '"texto"', '{}']) {
    assert.strictEqual(readRun(txt, NOW), null, `no es ejecución: ${JSON.stringify(txt)}`);
  }
  for (const txt of [null, undefined, '', '{}']) assert.strictEqual(readRunError(txt), null, `sin ejecución, sin error: ${JSON.stringify(txt)}`);
  for (const txt of ['{roto', '[]', '"texto"']) assert.strictEqual(readRunError(txt), BROKEN_RUN_TEXT, `ilegible, error: ${JSON.stringify(txt)}`);
  assert.match(NO_RUN_TEXT, /no hay una ejecución del pipeline en esta sesión/i);
});

test('T6 Board_UnknownStepsAndNoTimings — pasos que no conoce: error; sin horas: se arma igual', async () => {
  const { readRun, readRunError, boardLine, pipelineTable } = await mod('run.mjs');
  const raro = JSON.stringify({ storyId: '9.9', stepsCompleted: [0, 1, 9, 'zz'], stepsPending: [2, 3] });
  assert.strictEqual(readRun(raro, NOW), null, 'un paso que ninguna tabla conoce: no se adivina');
  assert.match(readRunError(raro), /dañado/);
  const run = readRun(JSON.stringify({ storyId: '9.9', stepsCompleted: [0, 1, 9], stepsPending: [2, 3] }), NOW);
  assert.ok(run);
  const line = boardLine(run, undefined);
  assert.match(line, / · Armar el plan · /, 'el primero pendiente: 0b y 0c sin bandera cuentan hechos porque el 1 está cerrado');
  assert.match(line, /— min en este paso/);
  assert.match(line, /contexto usado — %/);
  assert.doesNotThrow(() => pipelineTable(run));
});

// ── casos de borde del cartel ─────────────────────────────────────────────────────

test('T20 Board_SubstepWithoutFlag_ClosedByCompleteStep — un sub-paso sin bandera no clava el cartel (clase 1)', async () => {
  const { readRun, warnKey } = await mod('run.mjs');
  // complete-step anota sólo completedAt y stepsCompleted (sin startedAt); 0b sin Clockify, 0c sin pedido de Azure
  const m = JSON.stringify({ storyId: '7.18', startedAt: at(0), stepsCompleted: [0, 1, 2],
    stepTimings: { 0: { startedAt: at(0), completedAt: at(1) }, 1: { completedAt: at(5) }, 2: { completedAt: at(9) } } });
  const run = readRun(m, NOW);
  assert.strictEqual(run.current.id, 'approve-plan', 'está en Aprobar el plan, no en una parte del Arranque');
  assert.strictEqual(run.waiting, true, 'Aprobar el plan sin modo autónomo espera al dev');
  assert.strictEqual(warnKey(run, []), '7.18:approve-plan');
  const fin = readRun(JSON.stringify({ storyId: '8.22', stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7, 8] }), NOW);
  assert.strictEqual(fin.done, 11);
  assert.strictEqual(fin.current, null, 'con los nueve viejos cerrados no queda un paso clavado');
});

test('T21 Board_StepZeroNeverClosed_NotPinned — el 0 que nunca se cerró no clava el cartel (clase 7)', async () => {
  const { readRun } = await mod('run.mjs');
  const m = JSON.stringify({ storyId: '8.26', stepsCompleted: [1, 2, 3, 4, 5, 6], clockiStarted: true, adoMarkedActive: true,
    deepReviewDone: true, stepTimings: { 0: { startedAt: at(0) }, 2: { startedAt: at(5), completedAt: at(9) }, 6: { completedAt: at(30) } } });
  const run = readRun(m, NOW);
  assert.strictEqual(run.current.id, 'findings', 'el 7 viejo es la decisión de Hallazgos');
  assert.strictEqual(run.waiting, true);
  // y una vuelta atrás de verdad (el 5 arrancó otra vez después de cerrar el 6) sigue siendo el paso actual
  const back = readRun(JSON.stringify({ storyId: '9.9', stepsCompleted: [0, 1, 2, 3, 4, 6], clockiStarted: true, adoMarkedActive: true,
    stepTimings: { 5: { startedAt: at(35) }, 6: { startedAt: at(20), completedAt: at(30) } } }), NOW);
  assert.strictEqual(back.current.id, 'reviewers');
});

test('T22 Board_StickyWaiting_SurvivesFlagDeletion — «te espera» sigue aunque el pipeline borre la bandera (clase 6)', async () => {
  const { readRun, stickyWaiting } = await mod('run.mjs');
  const conBandera = readRun(markerEnPaso4({ waitingForHuman: true }), NOW);
  const a = stickyWaiting(conBandera, null);
  assert.strictEqual(a.run.waiting, true);
  assert.strictEqual(a.remember, '9.9:implement');
  const sinBandera = readRun(markerEnPaso4(), NOW + 60000);   // el Stop-hook la borró al cerrar el turno
  const b = stickyWaiting(sinBandera, a.remember);
  assert.strictEqual(b.run.waiting, true, 'sigue esperando en el mismo paso');
  const otroPaso = readRun(JSON.stringify({ ...JSON.parse(markerEnPaso4()), stepsCompleted: [0, 1, 2, 3, 4], stepTimings: { ...JSON.parse(markerEnPaso4()).stepTimings, 4: { startedAt: at(28), completedAt: at(35) }, 5: { startedAt: at(35) } } }), NOW);
  const c = stickyWaiting(otroPaso, b.remember);
  assert.strictEqual(c.run.waiting, false, 'cambió de paso: ya no');
  assert.strictEqual(c.remember, null);
});

test('T23 Board_WarnedAtOnce_AndStateDirs — el aviso se anota de una vez; el estado se busca bajo HOME y USERPROFILE (clases 4 y 2)', async () => {
  const { addWarned, stateDirs } = await mod('run.mjs');
  const r1 = addWarned([], '9.9:4');
  assert.deepStrictEqual(r1, { list: ['9.9:4'], added: true });
  assert.deepStrictEqual(addWarned(r1.list, '9.9:4'), { list: ['9.9:4'], added: false });
  const dirs = stateDirs({ HOME: 'H:', USERPROFILE: 'C:/Users/dev', TYCON_HOME: '/t' });
  assert.deepStrictEqual(dirs, ['/t/state', 'H:/.tycon/state', 'H:/.claude/.tycon-pipeline', 'C:/Users/dev/.tycon/state', 'C:/Users/dev/.claude/.tycon-pipeline']);
  assert.deepStrictEqual(stateDirs({ HOME: '/u', USERPROFILE: '/u' }), ['/u/.tycon/state', '/u/.claude/.tycon-pipeline'], 'sin repetir');
});

test('T24 Installer_PluginDirs_ShellAndCosmetic — suma las carpetas de la terminal; no reescribe por forma (clases 3 y 12)', () => {
  const PD = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'plugin-dirs.js'));
  const SH = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'shared.js'));
  const home = labHome();
  const dir = PD.ourDir(home);
  writeSettings(home, { env: {} });
  SH.applyShared({ home, env: { HOME: home, TYCON_NO_COMMANDS_SYNC: '1', CLAUDE_CODE_PLUGIN_DIRS: '/opt/mis-mods' }, tree: RAIZ, backup: false, platform: 'darwin' });
  assert.strictEqual(settingsOf(home).env.CLAUDE_CODE_PLUGIN_DIRS, `/opt/mis-mods:${dir}`, 'la de la terminal queda');
  const raro = ` /opt/a :: ${dir} `;
  const r = PD.addDir(raro, dir, { sep: ':', home });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.value, raro, 'el valor del dev queda tal cual');
});

// ── /mods ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('T7 Mods_ListShowsStateAndUsage — /mods lista cada mod con su estado y el uso', async () => {
  const { runModsCommand, CATALOG } = await mod('mods.mjs');
  assert.ok(CATALOG.some((m) => m.id === 'pipeline-board'));
  const visible = runModsCommand('', { off: [], hidden: [] });
  assert.strictEqual(visible.changed, false);
  assert.match(visible.text, /pipeline-board/);
  assert.match(visible.text, /visible/);
  for (const v of ['hide', 'show', 'off', 'on']) assert.match(visible.text, new RegExp(`/mods ${v}`));
  assert.match(runModsCommand('', { off: [], hidden: ['pipeline-board'] }).text, /oculto en esta sesión/);
  assert.match(runModsCommand('', { off: ['pipeline-board'], hidden: [] }).text, /apagado/);
});

test('T8 Mods_HideShow_SessionOnly — hide/show cambian sólo lo de la sesión', async () => {
  const { runModsCommand, isShown } = await mod('mods.mjs');
  const h = runModsCommand('hide pipeline-board', { off: [], hidden: [] });
  assert.strictEqual(h.changed, true);
  assert.deepStrictEqual(h.hidden, ['pipeline-board']);
  assert.deepStrictEqual(h.off, []);
  assert.strictEqual(isShown('pipeline-board', h), false);
  const s = runModsCommand('show pipeline-board', h);
  assert.deepStrictEqual(s.hidden, []);
  assert.strictEqual(isShown('pipeline-board', s), true);
});

test('T9 Mods_OffOn_Persists — off/on cambian lo que se guarda y si el mod trabaja', async () => {
  const { runModsCommand, isActive, isShown } = await mod('mods.mjs');
  const off = runModsCommand('off pipeline-board', { off: [], hidden: [] });
  assert.strictEqual(off.changed, true);
  assert.deepStrictEqual(off.off, ['pipeline-board']);
  assert.strictEqual(isActive('pipeline-board', off), false);
  assert.strictEqual(isShown('pipeline-board', off), false);
  const on = runModsCommand('on pipeline-board', { off: off.off, hidden: ['pipeline-board'] });
  assert.deepStrictEqual(on.off, []);
  assert.deepStrictEqual(on.hidden, [], 'prenderlo también lo muestra en esta sesión');
  assert.strictEqual(isActive('pipeline-board', on), true);
});

test('T10 Mods_NewModArrivesOn — un mod nuevo llega prendido aunque haya otros apagados', async () => {
  const { isActive, CATALOG } = await mod('mods.mjs');
  const state = { off: ['un-mod-que-ya-no-esta'], hidden: [] };
  for (const m of CATALOG) assert.strictEqual(isActive(m.id, state), true, m.id);
});

test('T11 Mods_BadInput_NoChange — lo que no entiende no cambia nada', async () => {
  const { runModsCommand } = await mod('mods.mjs');
  const st = { off: ['pipeline-board'], hidden: [] };
  for (const args of ['foo', 'hide', 'hide nada', 'off', 'apagar pipeline-board', 'on nada extra']) {
    const r = runModsCommand(args, st);
    assert.strictEqual(r.changed, false, args);
    assert.deepStrictEqual(r.off, st.off, args);
    assert.deepStrictEqual(r.hidden, st.hidden, args);
    assert.match(r.text, /No entendí/, args);
    assert.match(r.text, /pipeline-board/, args);
    assert.match(r.text, /\/mods hide/, args);
  }
});

// ── El instalador ─────────────────────────────────────────────────────────────────────────────────────────────────

test('T12 Installer_PluginDirs_AddIdempotent — sin la variable, la crea; dos ejecuciones, una sola vez', () => {
  const PD = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'plugin-dirs.js'));
  const SH = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'shared.js'));
  const home = labHome();
  writeSettings(home, { model: 'x', env: { OTRA: '1' } });
  const env = { HOME: home, TYCON_NO_COMMANDS_SYNC: '1' };
  const r1 = SH.applyShared({ home, env, tree: RAIZ, backup: false, platform: 'darwin' });
  assert.ok(r1.ok, r1.reason);
  const dir = PD.ourDir(home);
  assert.strictEqual(settingsOf(home).env.CLAUDE_CODE_PLUGIN_DIRS, dir);
  assert.ok(r1.pieces.some((p) => p.id === PD.PLUGIN_DIRS_ID && p.value === dir), 'la pieza queda registrada');
  assert.ok(SH.isShared({ kind: 'setting', id: PD.PLUGIN_DIRS_ID }), 'isShared la reconoce');
  SH.applyShared({ home, env, tree: RAIZ, backup: false, platform: 'darwin' });
  const s = settingsOf(home);
  assert.strictEqual(s.env.CLAUDE_CODE_PLUGIN_DIRS, dir, 'sin duplicar');
  assert.strictEqual(s.model, 'x');
  assert.strictEqual(s.env.OTRA, '1');

  // el camino suelto (apply-hooks.js sin harness.js) usa la misma unión
  const v = PD.addDir(undefined, dir, { sep: ':', home });
  assert.strictEqual(v.value, dir);
  assert.strictEqual(PD.addDir(dir, dir, { sep: ':', home }).changed, false);
});

test('T19 Installer_NoModsSwitch_LeavesVariable — con TYCON_NO_MODS=1 el arnés no suma su carpeta ni la anota', () => {
  const SH = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'shared.js'));
  const home = labHome();
  writeSettings(home, { env: { CLAUDE_CODE_PLUGIN_DIRS: '/opt/otros-mods' } });
  const r = SH.applyShared({ home, env: { HOME: home, TYCON_NO_MODS: '1', TYCON_NO_COMMANDS_SYNC: '1' }, tree: RAIZ, backup: false, platform: 'darwin' });
  assert.ok(r.ok, r.reason);
  assert.strictEqual(settingsOf(home).env.CLAUDE_CODE_PLUGIN_DIRS, '/opt/otros-mods');
  assert.ok(!r.pieces.some((p) => p.id === 'env.CLAUDE_CODE_PLUGIN_DIRS'), 'no se anota');
});

test('T13 Installer_PluginDirs_JoinAndDropOldMod — suma a lo del dev; saca sólo el mod viejo que ya no existe', () => {
  const PD = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'plugin-dirs.js'));
  const home = labHome();
  const dir = PD.ourDir(home);
  const viejo = '~/.claude/tycon-mods/tablero-corrida';
  const suyo = '/opt/otros-mods';

  assert.strictEqual(PD.addDir(suyo, dir, { sep: ':', home }).value, `${suyo}:${dir}`, 'el del dev primero');
  assert.strictEqual(PD.addDir(`${suyo};C:\\x`, dir, { sep: ';', home }).value, `${suyo};C:\\x;${dir}`, 'Windows con ;');

  const sin = PD.addDir(`${viejo}:${suyo}`, dir, { sep: ':', home });
  assert.strictEqual(sin.value, `${suyo}:${dir}`, 'el mod viejo que no existe sale');
  assert.deepStrictEqual(sin.dropped, [viejo]);

  fs.mkdirSync(path.join(home, '.claude', 'tycon-mods', 'tablero-corrida'), { recursive: true });
  assert.strictEqual(PD.addDir(`${viejo}:${suyo}`, dir, { sep: ':', home }).value, `${viejo}:${suyo}:${dir}`, 'si existe, se respeta');

  assert.strictEqual(PD.hasDir(`${suyo}:${dir}`, dir, { sep: ':', home }), true);
  assert.strictEqual(PD.hasDir(suyo, dir, { sep: ':', home }), false);
});

test('T14 Uninstall_PluginDirs_RemovesOnlyOurs — la desinstalación saca sólo la carpeta del arnés', () => {
  const PD = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'plugin-dirs.js'));
  const RM = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'remove.js'));
  const M = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'managed.js'));
  const home = labHome();
  const dir = PD.ourDir(home);
  const file = path.join(home, '.claude', 'settings.json');
  const piece = { kind: 'setting', where: file, id: PD.PLUGIN_DIRS_ID, value: dir };

  writeSettings(home, { env: { CLAUDE_CODE_PLUGIN_DIRS: `/opt/otros-mods:${dir}`, OTRA: '1' } });
  assert.strictEqual(M.present(piece, { home, env: { HOME: home } }), true, 'en su lugar aunque convive con otra carpeta');
  RM.removePieces([piece], { home, env: { HOME: home }, platform: 'darwin' });
  let s = settingsOf(home);
  assert.strictEqual(s.env.CLAUDE_CODE_PLUGIN_DIRS, '/opt/otros-mods');
  assert.strictEqual(s.env.OTRA, '1');

  writeSettings(home, { env: { CLAUDE_CODE_PLUGIN_DIRS: dir } });
  RM.removePieces([piece], { home, env: { HOME: home }, platform: 'darwin' });
  s = settingsOf(home);
  assert.ok(!s.env || !('CLAUDE_CODE_PLUGIN_DIRS' in s.env), 'sin nada más, la clave se borra');

  writeSettings(home, { env: { CLAUDE_CODE_PLUGIN_DIRS: '/opt/otros-mods' } });
  assert.strictEqual(M.present(piece, { home, env: { HOME: home } }), false, 'sin la carpeta, no está');
});

test('T15 InstallEffects_DeclaresPluginDirs — la pieza nueva declarada en los dos catálogos', () => {
  const effects = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'setup', 'install-effects.json'), 'utf8'));
  const list = JSON.stringify(effects);
  assert.match(list, /"id":\s*"env\.CLAUDE_CODE_PLUGIN_DIRS"/);
  const managed = fs.readFileSync(path.join(RAIZ, 'scripts', 'tests', 'fixtures', 'harness-managed-pieces.json'), 'utf8');
  assert.match(managed, /"id":\s*"env\.CLAUDE_CODE_PLUGIN_DIRS"/);
});

// ── El pipeline y Codex ───────────────────────────────────────────────────────────────────────────────────────────

test('T16 Steps_MatchPipelineSequence — los pasos del plugin son los de la tabla del pipeline', async () => {
  const T = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js'));
  const { STEPS, TOTAL, OLD_IDS, OLD_FLAG, START_PART_FAILED } = await mod('steps.mjs');
  // T2 Mod_NamesMatchStepsTable: los MISMOS números, nombres de máquina, nombres llanos, equivalencia y banderas que la
  // tabla del pipeline — uno distinto la pone roja
  const forma = (s) => ({ number: s.number, id: s.id, name: s.name, old: s.old, flag: s.flag });
  assert.deepStrictEqual(STEPS.map(forma), T.STEPS.map(forma));
  assert.strictEqual(TOTAL, T.TOTAL);
  assert.deepStrictEqual(OLD_IDS, T.OLD_IDS);
  assert.deepStrictEqual(OLD_FLAG, { '0b': ['workSignalStarted', 'clockiStarted'], '0c': ['adoMarkedActive'], '5b': ['deepReviewDone'], '7c': ['dodRuntimeChecked'] });
  assert.deepStrictEqual(START_PART_FAILED, Object.fromEntries(Object.entries(T.START_PARTS).map(([k, v]) => [k, v.failed])));
});

test('T16 (7.23) Board_ReadsBothSchemes @story-7.23 @ac-16 — el marker nuevo y el viejo, «N de 11», esperas por nombre, el aviso del Arranque, el roto como error', async () => {
  const { readRun, readRunError, boardLine, pipelineTable, waitingToast, OLD_RUN_TEXT } = await mod('run.mjs');
  const NOMBRES = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'];
  const hasta = (id) => NOMBRES.slice(0, NOMBRES.indexOf(id) + 1);
  const nuevo = (extra) => JSON.stringify({ storyId: '7.23', storyTitle: 'Los pasos del pipeline, claros: nombres', stepScheme: 2, startedAt: at(0), autonomous: true, ...extra });
  // segunda vuelta de revisores, con un aviso del Arranque
  const vuelta = nuevo({
    stepsCompleted: hasta('findings'), stepsPending: NOMBRES.slice(9), deepReviewDone: true,
    startWarnings: [{ part: 'time-tracking', message: 'no contestó' }],
    stepTimings: { reviewers: { startedAt: at(20), completedAt: at(30), rounds: 1 }, findings: { completedAt: at(32) } },
    fileEvents: [{ path: '/r/src/a.js', ts: at(34) }],
  });
  const run = readRun(vuelta, NOW);
  const line = boardLine(run, 41);
  assert.match(line, /^Story 7\.23 · Los pasos del pipeline, claros… · Revisores, vuelta 2 · 8 de 11 hechos · /, line);
  assert.match(line, /Arranque: hecho, con aviso: no se pudo abrir el registro de horas/);
  const t = pipelineTable(run);
  assert.match(t.split('\n')[0], /^Story 7\.23 «Los pasos del pipeline, claros: nombres» — Revisores, vuelta 2 · 8 de 11 pasos hechos/);
  assert.strictEqual(t.split('\n')[1], 'Arranque: hecho, con aviso: no se pudo abrir el registro de horas');
  assert.ok(t.includes('| 1. Arranque | hecho, con aviso |'), t);
  assert.ok(t.includes('| 7. Revisores (vuelta 2) | corriendo |'), t);
  assert.ok(t.includes('| 11. Preparar el commit | pendiente | — |'), t);
  assert.ok(!t.includes(OLD_RUN_TEXT), 'el marker nuevo no lleva la nota del viejo');
  // Hallazgos: espera sólo cuando de verdad preguntó (waitStartedAt), aun sin modo autónomo
  const hall = (extra) => readRun(nuevo({ autonomous: false, stepsCompleted: hasta('adversarial-pass'), stepsPending: NOMBRES.slice(8), ...extra }), NOW);
  assert.strictEqual(hall({ stepTimings: { findings: { startedAt: at(35) } } }).waiting, false, 'sin pregunta, sin espera');
  const espera = hall({ stepTimings: { findings: { startedAt: at(35), waitStartedAt: at(36) } } });
  assert.strictEqual(espera.waiting, true);
  assert.strictEqual(waitingToast(espera), 'Story 7.23 (Los pasos del pipeline, claros…): Hallazgos te espera — contestá en el chat');
  // Aprobar el plan sin modo autónomo, como siempre
  assert.strictEqual(readRun(nuevo({ autonomous: false, stepsCompleted: hasta('plan'), stepsPending: NOMBRES.slice(3) }), NOW).waiting, true);
  // el marker viejo: con los nombres nuevos y la nota
  const viejo = readRun(markerEnPaso4(), NOW);
  assert.strictEqual(viejo.total, 11);
  assert.ok(pipelineTable(viejo).split('\n').includes(OLD_RUN_TEXT), pipelineTable(viejo));
  // ilegible o de ningún esquema: error, no «sin ejecución»
  assert.match(readRunError('{"storyId":"7.23","stepScheme":2,"stepsCompleted":[5]}'), /dañado/, 'el esquema 2 con un número no es ninguno de los dos');
  assert.match(readRunError('{"storyId":"7.23","stepScheme":3,"stepsCompleted":[]}'), /dañado/);
  assert.strictEqual(readRunError(vuelta), null);
});

test('T4 (7.23) Board_ShowsPlainNamesWithoutStepId — el cartel, /pipeline y el aviso, por nombre y sin «paso N»', async () => {
  const { readRun, boardLine, pipelineTable, waitingToast } = await mod('run.mjs');
  const en5b = JSON.stringify({
    ...JSON.parse(markerEnPaso4()), stepsCompleted: [0, 1, 2, 3, 4, 5], stepsPending: [6, 7, 8],
    stepTimings: { ...JSON.parse(markerEnPaso4()).stepTimings, 4: { startedAt: at(28), completedAt: at(30) }, 5: { startedAt: at(30), completedAt: at(32) }, '5b': { startedAt: at(32) } },
  });
  const run = readRun(en5b, NOW);
  const line = boardLine(run, 20);
  assert.match(line, /^Story 9\.9 · Pase adversarial · 7 de 11 hechos · /, line);
  assert.doesNotMatch(line, /\bpaso \d|\b5b\b|búsqueda de fallas/);
  const t = pipelineTable(run);
  assert.match(t.split('\n')[0], /^Story 9\.9 — Pase adversarial · 7 de 11 pasos hechos/);
  assert.doesNotMatch(t, /\| (?:0|0b|0c|1|2|3|4|5|5b|6|7|7c|8) \|/, 'la tabla no muestra el id del paso');
  assert.ok(t.includes('| 8. Pase adversarial | corriendo |'), t);
  // el aviso «te espera»: el paso por su nombre
  const en3 = JSON.stringify({ storyId: '9.9', startedAt: at(0), stepsCompleted: [0, 1, 2], autonomous: false, stepTimings: { 3: { startedAt: at(20) } } });
  assert.strictEqual(waitingToast(readRun(en3, NOW)), 'Story 9.9: Aprobar el plan te espera — contestá en el chat');
});

test('T18 Codex_DeclaresNoMods — Codex no tiene mods, y queda declarado', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(RAIZ, 'adapters', 'codex', 'hooks.json'), 'utf8'));
  const d = (hooks.divergences || []).find((x) => JSON.stringify(x).includes('mods/harness-mods'));
  assert.ok(d, 'una entrada en divergences nombra mods/harness-mods');
  assert.match(JSON.stringify(d), /SOLO Claude Code/);
});

test('T19 Board_ShowsShortStoryTitle — el cartel trae el título corto de la story; /pipeline y el aviso, también', async () => {
  const { readRun, boardLine, pipelineTable, waitingToast, shortTitle, specTitle, storyPathOf } = await mod('run.mjs');
  const LARGO = 'El video de 0 a 100: del arnés instalado al primer código, en capítulos cortos';
  // del frontmatter de la spec, con comillas y sin ellas
  assert.strictEqual(specTitle(`---\nepic: 2\ntitle: "${LARGO}"\nstatus: in-progress\n---\n# x\n`), LARGO);
  assert.strictEqual(specTitle('---\ntitle: Corto y claro\n---\n'), 'Corto y claro');
  assert.strictEqual(specTitle('# sin frontmatter\ntitle: no\n'), null);
  assert.strictEqual(specTitle('---\nepic: 2\n---\ntitle: fuera\n'), null);
  // recorte: hasta los dos puntos; si no hay, en una palabra y nunca más de 40; sin recorte no lleva «…»
  assert.strictEqual(shortTitle(LARGO), 'El video de 0 a 100…');
  assert.strictEqual(shortTitle('Corto y claro'), 'Corto y claro');
  const sinPuntos = shortTitle('Toda retrospectiva sale sola aunque el merge entre por un pedido de la plataforma');
  assert.ok(sinPuntos.length <= 41 && sinPuntos.endsWith('…') && !/\s…$/.test(sinPuntos), sinPuntos);
  assert.strictEqual(shortTitle(''), null);
  // la ruta de la spec: absoluta tal cual, relativa contra el repo
  assert.strictEqual(storyPathOf(JSON.stringify({ storyPath: '/r/specs/s.md', repoPath: '/otro' })), '/r/specs/s.md');
  assert.strictEqual(storyPathOf(JSON.stringify({ storyPath: 'specs/s.md', repoPath: '/r/' })), '/r/specs/s.md');
  assert.strictEqual(storyPathOf(JSON.stringify({ storyPath: 'C:\\r\\s.md' })), 'C:\\r\\s.md');
  assert.strictEqual(storyPathOf(JSON.stringify({ storyPath: 'specs/s.md' })), null);
  // el título que trae el marker gana; el renglón queda «Story · título corto · paso · …»
  const run = readRun(markerEnPaso4({ storyTitle: LARGO }), NOW);
  assert.strictEqual(run.title, LARGO);
  assert.match(boardLine(run, 20), /^Story 9\.9 · El video de 0 a 100… · Implementar · 4 de 11 hechos · /);
  assert.ok(pipelineTable(run).split('\n')[0].startsWith(`Story 9.9 «${LARGO}» — `), pipelineTable(run));
  // sin título, el título es null
  const sin = readRun(markerEnPaso4(), NOW);
  assert.strictEqual(sin.title, null);
  assert.match(boardLine(sin, 20), /^Story 9\.9 · Implementar · /);
  const en3 = JSON.stringify({ storyId: '9.9', storyTitle: LARGO, startedAt: at(0), stepsCompleted: [0, 1, 2], autonomous: false, stepTimings: { 3: { startedAt: at(20) } } });
  assert.strictEqual(waitingToast(readRun(en3, NOW)), 'Story 9.9 (El video de 0 a 100…): Aprobar el plan te espera — contestá en el chat');
});

test('T40 Board_OpenStepWithoutStart_CountsFromPreviousClose — un paso abierto sin arranque cuenta desde el cierre del anterior', async () => {
  const { readRun, boardLine } = await mod('run.mjs');
  // esquema nuevo: la sesión trabajó sin llamar `pipeline.js next`, así que «Correr las pruebas» no tiene startedAt;
  // los minutos salen del cierre de Implementar (el último completedAt de los pasos anteriores): 40 - 25 = 15
  const nuevo = JSON.stringify({
    storyId: '8.85', stepScheme: 2, startedAt: at(0), autonomous: true,
    stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement'],
    stepsPending: ['run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'],
    stepTimings: { implement: { startedAt: at(10), completedAt: at(25) } },
  });
  const run = readRun(nuevo, NOW);
  assert.strictEqual(run.current.name, 'Correr las pruebas');
  assert.strictEqual(run.minutesStep, 15);
  assert.match(boardLine(run, undefined), /15 min en este paso/);
  // esquema viejo equivalente: Implementar (el 4) sin arranque y el 3 cerrado hace 15 minutos
  const viejo = JSON.stringify({
    storyId: '9.9', startedAt: at(0), stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5],
    stepTimings: { 3: { startedAt: at(20), completedAt: at(25) } },
  });
  const runViejo = readRun(viejo, NOW);
  assert.strictEqual(runViejo.current.name, 'Implementar');
  assert.strictEqual(runViejo.minutesStep, 15);
  // sin arranque propio y sin cierre de ningún anterior, sigue la raya (lo que prueba T6)
  assert.strictEqual(readRun(JSON.stringify({ storyId: '9.9', stepScheme: 2, startedAt: at(0), stepsCompleted: ['start'], stepTimings: {} }), NOW).minutesStep, null);
});

test('T41 Board_NoOpenStep_SaysWhatItWaitsFor — sin paso abierto dice si espera pedidos o está lista para cerrar', async () => {
  const { readRun, boardLine, pipelineTable, idleStep } = await mod('run.mjs');
  const cerrada = JSON.stringify({
    storyId: '8.117', stepScheme: 2, startedAt: at(0), autonomous: true,
    stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'],
    stepsPending: [],
  });
  const run = readRun(cerrada, NOW);
  assert.strictEqual(run.current, null);
  // todavía sin preguntar: lo de antes
  assert.match(boardLine(run, 10), / · sin paso abierto · /);
  const con = { ...run, entering: { prs: [{ repo: 'tycon-harness', ref: '#536' }, { repo: 'harness-maintainers', ref: '!5434' }], failed: false } };
  assert.match(boardLine(con, 10), / · esperando que entren los pedidos \(#536, !5434\) · /);
  assert.match(pipelineTable(con), /— esperando que entren los pedidos \(#536, !5434\) ·/);
  assert.match(boardLine({ ...run, entering: { prs: [], failed: false } }, 10), / · lista para cerrar · /);
  // una consulta que no contestó no es «lista para cerrar»
  assert.strictEqual(idleStep({ prs: [], failed: true }), 'sin paso abierto (no pude consultar los pedidos)');
  assert.strictEqual(idleStep(null), 'sin paso abierto');
});

test('T42 Board_TotalInHours — el total en horas desde la hora, y desde un día entero, desde cuándo corre', async () => {
  const { readRun, boardLine, totalText } = await mod('run.mjs');
  const now = new Date(2026, 9, 25, 10, 0).getTime();
  assert.strictEqual(totalText(35, now - 35 * 60000, now), '35 min');
  assert.strictEqual(totalText(120, now - 120 * 60000, now), '2 h');
  assert.strictEqual(totalText(23 * 60 + 59, now - (23 * 60 + 59) * 60000, now), '23 h 59 min');
  assert.strictEqual(totalText(null, null, now), '— min');
  const ayer = new Date(2026, 9, 24, 9, 27).getTime();
  assert.strictEqual(totalText(Math.round((now - ayer) / 60000), ayer, now), 'desde ayer 09:27');
  const antes = new Date(2026, 9, 23, 15, 20).getTime();
  assert.strictEqual(totalText(Math.round((now - antes) / 60000), antes, now), 'desde el 23/10 15:20');
  // el renglón usa ese texto
  const marker = JSON.stringify({ storyId: '9.9', stepScheme: 2, startedAt: new Date(now - (3 * 60 + 12) * 60000).toISOString(), stepsCompleted: ['start'], stepTimings: {} });
  assert.match(boardLine(readRun(marker, now), 5), / · 3 h 12 min en total · /);
});

test('T43 Board_FindingsAnswered_StopsWaiting — «te espera» de Hallazgos se apaga cuando la persona contestó', async () => {
  const { readRun, stickyWaiting, boardLine } = await mod('run.mjs');
  const NOMBRES = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'];
  const hall = (findings) => readRun(JSON.stringify({
    storyId: 'CO-7', stepScheme: 2, startedAt: at(0), autonomous: true,
    stepsCompleted: NOMBRES.slice(0, 8), stepsPending: NOMBRES.slice(8), stepTimings: { findings },
  }), NOW);
  // preguntó: espera, y el cartel lo recuerda
  const pregunta = stickyWaiting(hall({ startedAt: at(30), waitStartedAt: at(31) }), null);
  assert.strictEqual(pregunta.run.waiting, true);
  assert.strictEqual(pregunta.remember, 'CO-7:findings');
  // contestó: la marca del fin de la espera apaga «te espera», aunque el cartel lo recordara del refresco anterior
  const contesto = stickyWaiting(hall({ startedAt: at(30), waitStartedAt: at(31), waitEndedAt: at(33) }), pregunta.remember);
  assert.strictEqual(contesto.run.waiting, false, 'la persona ya contestó');
  assert.strictEqual(contesto.remember, null);
  assert.doesNotMatch(boardLine(contesto.run, 10), /te espera/);
});
