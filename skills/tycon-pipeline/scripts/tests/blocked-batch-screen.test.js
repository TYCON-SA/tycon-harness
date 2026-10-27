#!/usr/bin/env node
/**
 * blocked-batch-screen.test.js — la pantalla de una tanda bloqueada no se pide en esta corrida.
 *
 * Caso: una story entregada en dos tandas, A-backend en `done` sin pantalla y B-frontend `blocked` con los `.tsx`.
 * El cierre decidía «story de pantalla» mirando la story entera: pedía la prueba de navegador (y al dev sólo le
 * quedaba «autorizo force-manual») y la revisión de la pantalla, que no tenía escape. La guía de los criterios de
 * backend se sigue pidiendo.
 *
 *   T1-T4   screenScope: la regla, con evidencia y sin ella
 *   T5-T7   la prueba de navegador (marker.js y on-pre-commit.js)
 *   T8-T11  la revisión de la pantalla (qa-guide.js --check) y el disparo de la guía
 *   T12     la marca a mano
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/blocked-batch-screen.test.js < /dev/null
 */
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { fakeHomeEnv } = require('./lib/fake-home.js');

const SCRIPTS = path.join(__dirname, '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const QA = path.join(SCRIPTS, 'qa-guide.js');
const ui = require(path.join(SCRIPTS, 'lib', 'ui-signal.js'));

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
function escribir(file, txt) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, txt); }

const ARCHIVOS = 'files_to_modify:\n  - Acme/Features/Switch/SwitchEndpoints.cs\n  - acme-admin/src/components/SwitchPanel.tsx\n';
const ARCHIVOS_CS = 'files_to_modify:\n  - Acme/Features/Switch/SwitchEndpoints.cs\n';

// La forma de la story real: la tanda de backend entregada, la de pantalla bloqueada con su criterio.
const TANDAS_126 = [
  'pipelines:',
  '  - name: A-backend',
  '    status: done',
  '    acs: [1, 2]',
  '  - name: B-frontend',
  '    status: blocked',
  '    blocked_by: "espera el merge del backend de la tanda A"',
  '    acs_pending: [3]',
].join('\n') + '\n';
// La pantalla en una tanda que se está entregando.
const TANDAS_ACTIVA = [
  'pipelines:',
  '  - name: A-backend',
  '    status: done',
  '    acs: [1, 2]',
  '  - name: B-frontend',
  '    status: in-progress',
  '    acs_pending: [3]',
  '  - name: C-frontend',
  '    status: blocked',
  '    blocked_by: "espera el diseño"',
  '    acs_pending: []',
].join('\n') + '\n';

const ACS_MARCADOS = [
  '1. **Estado**: GET /api/switch devuelve si el interruptor está prendido. @sin-pantalla',
  '2. **Cambio**: PUT /api/switch prende o apaga el interruptor. @sin-pantalla',
  '3. **Panel**: la pantalla muestra el interruptor.',
];

function storyText({ files = ARCHIVOS, tandas = '', acs = ACS_MARCADOS } = {}) {
  return [
    '---',
    'epic: 9',
    'story: "9.26"',
    'title: "Panel del interruptor y número receptor"',
    'status: in-progress',
    files + tandas + '---',
    '',
    '# Story 9.26: Panel',
    '',
    '## Acceptance Criteria',
    '',
    ...acs,
    '',
    '## Tests',
    '',
    '| # | Test | AC | Nivel | Escenario | Resultado esperado |',
    '|---|------|----|-------|-----------|--------------------|',
    ...acs.map((_, i) => `| T${i + 1} | \`Caso${i + 1}_Funciona\` | ${i + 1} | unit | el caso | sale bien |`),
    '',
  ].join('\n');
}

/** Un repo de juguete con la story; devuelve `{ repo, storyPath, content }`. */
function repoCon(opts, tag = 'r') {
  const repo = tmp(`bbs-${tag}-`);
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  const storyPath = path.join(repo, 'specs', 'story-9.26-panel.md');
  const content = storyText(opts);
  escribir(storyPath, content);
  return { repo, storyPath, content };
}

/** Un marcador de juguete sobre la story, en una carpeta personal de juguete. */
function marcador(r, tag, extra = {}) {
  const home = tmp(`bbs-home-${tag}-`);
  const sid = `bbs-${tag}`;
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({
    storyId: '9.26', storyPath: r.storyPath, repoPath: r.repo, sessionId: sid,
    startedAt: '2026-10-26T10:00:00.000Z', lastTouch: '2026-10-26T10:00:00.000Z',
    stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8], filesTouched: [], iterations: {}, fileEvents: [], ...extra,
  }));
  const correr = (...args) => spawnSync(process.execPath, [MARKER, ...args],
    { env: { ...process.env, ...fakeHomeEnv(home), CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8', cwd: r.repo });
  return { correr };
}

/** La guía del tester lista, en la carpeta qa/ que busca el chequeo. */
function guiaLista(r) {
  const qa = path.join(path.dirname(r.storyPath), 'qa');
  escribir(path.join(qa, '9.26-pasos.md'), [
    'Usuario por defecto: administrador',
    '',
    '## AC 1',
    'Ver si el interruptor está prendido.',
    '',
    '## AC 2',
    'Prender y apagar el interruptor.',
    '',
  ].join('\n'));
  escribir(path.join(qa, '9.26-legibilidad.md'), 'veredicto: OK\n');
  return qa;
}

const qaCheck = (r, ...extra) => spawnSync(process.execPath, [QA, '--story', r.storyPath, '--check', ...extra],
  { encoding: 'utf8', cwd: r.repo, env: { ...process.env, ...fakeHomeEnv(tmp('bbs-qa-home-')) } });

test('T1 ScreenScope_BlockedScreenBatch_NotActive', () => {
  // La forma de mapa también: si los cortes de las tandas dejaran de coincidir con los de parsePipelinesBlock, la baja
  // no se daría y este caso saldría en rojo.
  const mapa = [
    'pipelines:',
    '  backend:',
    '    status: done',
    '    acs: [1, 2]',
    '  frontend:',
    '    status: blocked',
    '    blocked_by: "espera el merge del backend"',
    '    acs_pending: [3]',
  ].join('\n') + '\n';
  for (const [tandas, nombre] of [[TANDAS_126, 'B-frontend'], [mapa, 'frontend']]) {
    const r = repoCon({ tandas }, 't1');
    const s = ui.screenScope(r.content, r.repo);
    assert.equal(s.story, true, 'la story entera sigue siendo de pantalla');
    assert.equal(s.active, false, `la pantalla es sólo de la tanda bloqueada:\n${tandas}`);
    assert.deepEqual(s.blocked, [nombre]);
    assert.match(String(s.note), new RegExp(nombre));
  }
});

test('T2 ScreenScope_ActiveScreenBatch_StillActive', () => {
  const casos = {
    'pantalla en una tanda en curso': { tandas: TANDAS_ACTIVA },
    // Una tanda `pending` puede ser la que se entrega en esta corrida: cuenta como activa.
    'pantalla en una tanda pendiente': { tandas: TANDAS_ACTIVA.replace('status: in-progress', 'status: pending') },
    'criterio activo sin marca': {
      tandas: TANDAS_126.replace('status: done', 'status: in-progress'),
      acs: [ACS_MARCADOS[0], '2. **Cambio**: el interruptor se prende o se apaga.', ACS_MARCADOS[2]],
    },
    'el mismo .tsx en una tanda bloqueada y en una activa': {
      tandas: [
        'pipelines:',
        '  - name: A-backend',
        '    status: in-progress',
        '    acs: [1, 2]',
        '    files: [acme-admin/src/components/SwitchPanel.tsx]',
        '  - name: B-frontend',
        '    status: blocked',
        '    blocked_by: "espera el merge del backend de la tanda A"',
        '    acs_pending: [3]',
        '    files: [acme-admin/src/components/SwitchPanel.tsx]',
      ].join('\n') + '\n',
    },
  };
  for (const [nombre, opts] of Object.entries(casos)) {
    const r = repoCon(opts, 't2');
    const s = ui.screenScope(r.content, r.repo);
    assert.equal(s.active, true, `${nombre}: la pantalla se sigue exigiendo`);
    assert.equal(s.note, null, `${nombre}: sin baja no hay nota`);
  }
});

test('T3 ScreenScope_NoEvidence_SameAsStory', () => {
  const sinSenal = TANDAS_126.replace('name: A-backend', 'name: A').replace('name: B-frontend', 'name: B');
  const bloqueadaDeBackend = [
    'pipelines:',
    '  - name: A-backend',
    '    status: blocked',
    '    blocked_by: "espera el proveedor"',
    '    acs_pending: [1]',
    '  - name: B-frontend',
    '    status: done',
    '    acs: [2, 3]',
  ].join('\n') + '\n';
  // La prosa de blocked_by no es señal: la pantalla la entrega la tanda activa.
  const esperaElFrontend = [
    'pipelines:',
    '  - name: A-wiring',
    '    status: in-progress',
    '    acs: [1, 2]',
    '  - name: B-api',
    '    status: blocked',
    '    blocked_by: "espera el frontend"',
    '    acs_pending: [3]',
  ].join('\n') + '\n';
  // Tampoco cuando la prosa nombra un archivo de pantalla, en la línea o en las que siguen.
  const esperaElPanel = esperaElFrontend.replace('"espera el frontend"', '"espera SwitchPanel.tsx"');
  const enVariasLineas = (marca) => esperaElFrontend.replace('    blocked_by: "espera el frontend"\n',
    `    blocked_by: ${marca}\n      espera que el frontend\n      entregue SwitchPanel.tsx\n`);
  for (const tandas of [sinSenal, bloqueadaDeBackend, esperaElFrontend, esperaElPanel,
    enVariasLineas('>'), enVariasLineas('|'), enVariasLineas('')]) {
    const r = repoCon({ tandas }, 't3');
    const s = ui.screenScope(r.content, r.repo);
    assert.equal(s.active, s.story, `sin evidencia, como hoy:\n${tandas}`);
    assert.equal(s.story, true);
  }
});

test('T4 ScreenScope_NoPipelines_SameAsToday', () => {
  for (const files of [ARCHIVOS, ARCHIVOS_CS]) {
    const r = repoCon({ files }, 't4');
    const s = ui.screenScope(r.content, r.repo);
    assert.equal(s.story, ui.storyTouchesUi(r.content, r.repo));
    assert.equal(s.active, s.story);
    assert.deepEqual(s.blocked, []);
    assert.equal(s.note, null);
  }
});

test('T5 Marker_BlockedScreenBatch_DodManualAccepted', () => {
  const r = repoCon({ tandas: TANDAS_126 }, 't5');
  for (const args of [['set-check', 'dod', 'green', '--manual'], ['mark-dod-runtime-checked', '{"verdict":"PASS"}']]) {
    const m = marcador(r, `t5-${args[0]}`);
    const out = m.correr(...args);
    assert.equal(out.status, 0, `${args.join(' ')} no pide la frase:\n${out.stderr}`);
    assert.doesNotMatch(out.stderr || '', /RECHAZADO/);
    const n = ((out.stderr || '').match(/B-frontend/g) || []).length;
    assert.equal(n, 1, `${args.join(' ')}: la baja se dice una vez nombrando la tanda (dijo ${n})\n${out.stderr}`);
  }
});

test('T6 Marker_ActiveScreenBatch_DodManualRejected', () => {
  const r = repoCon({ tandas: TANDAS_ACTIVA }, 't6');
  const out = marcador(r, 't6').correr('set-check', 'dod', 'green', '--manual');
  assert.equal(out.status, 2, `con la pantalla en curso sigue frenando:\n${out.stderr}`);
  assert.match(out.stderr || '', /RECHAZADO/);
});

test('T7 PreCommit_BlockedScreenBatch_NoBrowserDemand', () => {
  const { storyIsUiStory } = require(path.join(SCRIPTS, 'on-pre-commit.js'));
  assert.equal(typeof storyIsUiStory, 'function', 'storyIsUiStory se exporta');
  const bloqueada = repoCon({ tandas: TANDAS_126 }, 't7a');
  const activa = repoCon({ tandas: TANDAS_ACTIVA }, 't7b');
  assert.equal(storyIsUiStory(bloqueada.content, bloqueada.repo), false);
  assert.equal(storyIsUiStory(activa.content, activa.repo), true);
});

test('T8 QaCheck_BlockedScreenBatch_OnlyBackendGuide', () => {
  const r = repoCon({ tandas: TANDAS_126 }, 't8');
  const antes = qaCheck(r);
  const salida = `${antes.stdout}\n${antes.stderr}`;
  assert.equal(antes.status, 2, `sin la guía, la pide:\n${salida}`);
  assert.match(antes.stderr, /\(1\) Falta el archivo de pasos-tester/);
  assert.match(antes.stderr, /\(4\) Falta la review de legibilidad/);
  assert.doesNotMatch(antes.stderr, /\((7|8|9|10)\)/, 'nada de la pantalla');
  assert.match(salida, /B-frontend/, 'nombra la tanda bloqueada');
  const qa = guiaLista(r);
  // La revisión de la pantalla en rojo no frena: no se mira.
  escribir(path.join(qa, '9.26-legibilidad-ui.md'), 'veredicto: REVISAR\n');
  const despues = qaCheck(r);
  assert.equal(despues.status, 0, `con la guía lista, sale bien:\n${despues.stdout}\n${despues.stderr}`);
  assert.match(despues.stdout, /pantalla sin revisar[^\n]*B-frontend/);
});

test('T9 QaCheck_BlockedScreenBatch_MockupNotRequired', () => {
  const r = repoCon({ tandas: TANDAS_126 }, 't9');
  const qa = guiaLista(r);
  escribir(path.join(qa, '9.26-mockup-approval.json'), JSON.stringify({ sha256: 'a'.repeat(64) }));
  // Una maqueta que ya no coincide con la aprobada tampoco frena: no se compara.
  const out = qaCheck(r, '--mockup-sha', 'b'.repeat(64));
  assert.equal(out.status, 0, `la maqueta de la tanda bloqueada no obliga:\n${out.stdout}\n${out.stderr}`);
  assert.match(out.stdout, /maqueta[^\n]*B-frontend|B-frontend[^\n]*maqueta/i);
});

test('T10 QaCheck_ActiveScreenBatch_StillAsksScreenReview', () => {
  const r = repoCon({ tandas: TANDAS_ACTIVA }, 't10');
  guiaLista(r);
  const out = qaCheck(r);
  assert.equal(out.status, 2, `con la pantalla en curso, la revisa:\n${out.stdout}\n${out.stderr}`);
  assert.match(out.stderr, /\(7\)/);
});

test('T11 ScreenRule_BlockedScreenBatch_GuideStillTriggered', () => {
  const r = repoCon({ tandas: TANDAS_126 }, 't11');
  assert.equal(ui.applyScreenRule(r.content, r.repo, 'ui').ui, true, 'sin scope: la story entera (la guía)');
  assert.equal(ui.applyScreenRule(r.content, r.repo, 'ui', { scope: 'active' }).ui, false, 'la prueba de navegador');
  assert.equal(ui.applyScreenRule(r.content, r.repo, 'off').ui, false);
  assert.equal(ui.applyScreenRule(r.content, r.repo, 'off', { scope: 'active' }).ui, false);
});

test('T12 ManualChecks_BlockedScreenBatch_SkipsBlockedCriteria', () => {
  const { criterios } = require(path.join(SCRIPTS, 'lib', 'manual-checks.js'));
  const bloqueada = repoCon({ tandas: TANDAS_126 }, 't12a');
  const sinTandas = repoCon({}, 't12b');
  assert.deepEqual(criterios(bloqueada.storyPath).map((c) => c.n), [1, 2]);
  assert.deepEqual(criterios(sinTandas.storyPath).map((c) => c.n), [1, 2, 3]);
});

// ── La baja se cruza con los archivos que cambió el commit ───────────────────────────────────────────────────────────

const PANEL = 'acme-admin/src/components/SwitchPanel.tsx';

/** Un commit con la story; devuelve su sha. Después se escribe la pantalla, sin commitear: es lo que cambió. */
function conCommit(r, { pantalla = true } = {}) {
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', r.repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA } });
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  if (pantalla) escribir(path.join(r.repo, PANEL), 'export const SwitchPanel = () => null;\n');
  return sha;
}

test('T13 ScreenScope_CommitTouchesBlockedScreen_NoDrop', () => {
  const r = repoCon({ tandas: TANDAS_126 }, 't13');
  const s = ui.screenScope(r.content, r.repo, { changed: [PANEL, 'Acme/Features/Switch/SwitchEndpoints.cs'] });
  assert.equal(s.active, true, 'el commit cambia la pantalla de la tanda bloqueada: la baja no se da');
  assert.deepEqual(s.blocked, []);
  assert.match(String(s.note), /B-frontend/);
  assert.match(String(s.note), /SwitchPanel\.tsx/);
  // sin pantalla entre los cambios, o sin la lista, como hoy
  assert.equal(ui.screenScope(r.content, r.repo, { changed: ['Acme/Features/Switch/SwitchEndpoints.cs'] }).active, false);
  assert.equal(ui.screenScope(r.content, r.repo, { changed: [] }).active, false);
  assert.equal(ui.screenScope(r.content, r.repo).active, false);
  // la regla de la organización también la recibe
  assert.equal(ui.applyScreenRule(r.content, r.repo, 'ui', { scope: 'active', changed: [PANEL] }).ui, true);
});

test('T14 PreCommit_CommitTouchesBlockedScreen_BrowserDemanded', () => {
  const { storyIsUiStory } = require(path.join(SCRIPTS, 'on-pre-commit.js'));
  const r = repoCon({ tandas: TANDAS_126 }, 't14');
  assert.equal(storyIsUiStory(r.content, r.repo, [PANEL]), true);
  assert.equal(storyIsUiStory(r.content, r.repo, ['Acme/Features/Switch/SwitchEndpoints.cs']), false);
});

test('T15 Marker_RunTouchesBlockedScreen_DodManualRejected', () => {
  const r = repoCon({ tandas: TANDAS_126 }, 't15');
  const baseSha = conCommit(r);
  const out = marcador(r, 't15', { baseSha }).correr('set-check', 'dod', 'green', '--manual');
  assert.equal(out.status, 2, `la corrida cambió la pantalla: sigue frenando:\n${out.stderr}`);
  assert.match(out.stderr || '', /RECHAZADO/);
  // sin la pantalla entre los cambios, la baja se da como antes
  const r2 = repoCon({ tandas: TANDAS_126 }, 't15b');
  const sha2 = conCommit(r2, { pantalla: false });
  assert.equal(marcador(r2, 't15b', { baseSha: sha2 }).correr('set-check', 'dod', 'green', '--manual').status, 0);
});

test('T16 QaCheck_CommitTouchesBlockedScreen_AsksScreenReview', () => {
  const r = repoCon({ tandas: TANDAS_126 }, 't16');
  guiaLista(r);
  conCommit(r);
  const out = qaCheck(r);
  assert.equal(out.status, 2, `la pantalla cambió: la revisa:\n${out.stdout}\n${out.stderr}`);
  assert.match(out.stderr, /\(7\)/);
});
