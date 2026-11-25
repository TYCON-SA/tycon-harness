#!/usr/bin/env node
'use strict';
/**
 * batch-plan-gate.test.js — el plan delegado queda atado a la lista de su parte.
 *
 *   T17 con el plan aprobado por la coordinadora para una parte, un `.js` fuera de la lista frena (batch-out-of-list),
 *       por la herramienta y por la consola; una guía fuera de la lista pasa al editar (la mide el cierre)
 *   T18 la prueba de un archivo de la lista y la evidencia de `.advisors/` pasan; `.advisors/x.js` frena
 *   T19 con el plan aprobado por una persona, no frena
 *   T31 la lista que vale es la congelada al aprobar: sumar el archivo a `files:` en la historia, o una lista escrita en
 *       el marcador, no lo deja pasar
 *   Adopcion1 en una corrida adoptada, la lista sale de la constancia de la revisión hecha para la sesión anterior
 *
 * stable-data: arma la corrida, la revisión del plan y su constancia en carpetas temporales; nunca toca el repo real.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/batch-plan-gate.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const io = require(path.join(SCRIPTS, 'lib', 'story-gate-io.js'));
const pr = require(path.join(SCRIPTS, 'lib', 'plan-review.js'));
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));

const A = 'A-el-combo';
const B = 'B-la-grilla';
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function historia({ filesA = ['src/combo.js', 'docs/combo.md'] } = {}) {
  return ['---', 'story: "9.7"', 'title: "partes"', 'status: in-progress', 'files_to_modify:',
    '  - src/combo.js', '  - docs/combo.md', '  - src/grilla.js',
    'pipelines:',
    `  - name: ${A}`, '    status: pending', '    acs: [1]', '    files:', ...filesA.map((f) => `      - ${f}`),
    `  - name: ${B}`, '    status: pending', '    acs: [2]', '    files:', '      - src/grilla.js',
    '---', '# Story 9.7', '', '## Acceptance Criteria', '', '1. **Given** algo, **Then** pasa.', ''].join('\n');
}

/**
 * Una corrida con la parte A anotada y el plan aprobado: `porRevision` (la coordinadora, con la revisión automática y
 * su constancia) o por una persona.
 */
function corrida({ porRevision = true, bajo = null, texto = null } = {}) {
  const repo = bajo ? path.join(tmp('raiz-'), bajo, 'producto') : tmp('repo-');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const story = path.join(repo, 'specs', 'story-9.7-partes.md');
  fs.writeFileSync(story, texto || historia());
  const run = path.join(repo, '.advisors', 'pipeline-runs', '9.7-20261109000000');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'step-02-bmad-plan.md'), '# Plan\n\nCambiar src/combo.js y docs/combo.md.\n');
  const estado = tmp('estado-');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const sid = 'dest';
  const marker = { storyId: '9.7', storyPath: story, repoPath: repo, startedAt: '2026-11-09T00:00:00.000Z', batch: A, batchValid: !texto,
    stepScheme: 2, stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'], stepsPending: ['implement', 'run-tests'] };
  const escribirMarcador = (m) => fs.writeFileSync(path.join(estado, 'active', `${sid}.json`), JSON.stringify(m));
  escribirMarcador(marker);
  if (porRevision) {
    const p = pr.preparar({ lanza: 'coord', destino: sid, estado, designada: () => 'coord' });
    assert.strictEqual(p.codigo, 0, p.motivo);
    const pedido = JSON.parse(fs.readFileSync(p.pedido, 'utf8'));
    const c = pr.anotar({ lanza: 'coord', destino: sid, estado, resultado: { medido: true, modo: 'plan', confirmed: [], pedido: pedido.numero } });
    marker.planApproval = { mode: 'revision', text: 'revisión automática', at: new Date().toISOString(), revision: { id: c.id, veredicto: c.veredicto, modelo: c.modelo, lanzo: 'coord' } };
  } else {
    marker.planApproval = { mode: 'user', text: 'firmado en la terminal', at: new Date().toISOString() };
  }
  escribirMarcador(marker);
  const ev = (rel) => io.evaluate({ filePath: path.join(repo, rel), sessionId: sid, cwd: repo, via: 'Edit', stateDir: estado, installedRoots: [] });
  const consola = (command) => bash.handle({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: sid, cwd: repo, tool_input: { command } },
    { stateDir: estado, installedRoots: [] });
  return { repo, story, estado, sid, marker, ev, consola, escribirMarcador };
}
const tipo = (r) => (r && r.verdict ? r.verdict.kind : null);

test('T17 Edit_FueraDeLaLista_PlanDelegado_Frena — @story-8.168 @ac-9', () => {
  const C = corrida();
  assert.strictEqual(tipo(C.ev('src/grilla.js')), 'batch-out-of-list');
  assert.notStrictEqual(tipo(C.ev('src/combo.js')), 'batch-out-of-list', 'dentro de la lista pasa');
  // por la consola, con lo que la puerta ya lee
  const r = C.consola('echo x > src/grilla.js');
  assert.ok(r && /FUERA DE LA PARTE|batch-out-of-list/.test(JSON.stringify(r)), JSON.stringify(r));
  // una guía fuera de la lista no frena al editar: la mide el cierre
  assert.notStrictEqual(tipo(C.ev('docs/otra.md')), 'batch-out-of-list');
});

test('T18 Edit_PruebaYPapeleo_Pasan — @story-8.168 @ac-9', () => {
  const C = corrida();
  for (const rel of ['tests/combo.test.js', '.advisors/x.json']) assert.notStrictEqual(tipo(C.ev(rel)), 'batch-out-of-list', rel);
  assert.strictEqual(tipo(C.ev('.advisors/x.js')), 'batch-out-of-list');
});

test('T19 Edit_PlanDeUnaPersona_NoFrena — @story-8.168 @ac-10', () => {
  const C = corrida({ porRevision: false });
  assert.notStrictEqual(tipo(C.ev('src/grilla.js')), 'batch-out-of-list');
});

test('T31 Edit_ListaCongeladaAlAprobar — @story-8.168 @ac-9', () => {
  const C = corrida();
  // la historia suma el archivo a la parte después de aprobar: no amplía nada
  fs.writeFileSync(C.story, historia({ filesA: ['src/combo.js', 'docs/combo.md', 'src/grilla.js'] }));
  assert.strictEqual(tipo(C.ev('src/grilla.js')), 'batch-out-of-list');
  // una lista escrita en el marcador, tampoco
  C.escribirMarcador({ ...C.marker, batchFiles: ['src/grilla.js'], allowedFiles: ['src/grilla.js'] });
  assert.strictEqual(tipo(C.ev('src/grilla.js')), 'batch-out-of-list');
});

test('T32 ParteQueDejaDeValer_NoAmplia — @story-8.168 @ac-11', () => {
  const C = corrida();
  // la historia cambia el files: de la parte y deja de valer: la aprobación delegada se niega
  fs.writeFileSync(C.story, historia({ filesA: [] }));
  const r = pr.antesDeAprobar({ estado: C.estado, firmante: 'coord', destino: C.sid, marker: C.marker, config: { plan_review: { coordinator_approves: true } } });
  assert.strictEqual(r.codigo, 2);
  // y el portón sigue con la lista congelada al aprobar
  assert.strictEqual(tipo(C.ev('src/grilla.js')), 'batch-out-of-list');
  assert.notStrictEqual(tipo(C.ev('src/combo.js')), 'batch-out-of-list');
});

// 🔴 Falla con: en una corrida adoptada (`adopt-session`) con el plan aprobado por la revisión de la sesión anterior, el
//    portón busca la constancia con la sesión nueva, no la encuentra y frena todo el código de la parte.
test('Adopcion1 Edit_CorridaAdoptada_LaListaSaleDeLaConstanciaDeLaAnterior', () => {
  const C = corrida();
  const nueva = 'nueva';
  // lo que deja adopt-session: el mismo marcador con la sesión nueva y de cuál viene; el de la anterior se borra
  fs.writeFileSync(path.join(C.estado, 'active', `${nueva}.json`), JSON.stringify({ ...C.marker, sessionId: nueva, adoptedFrom: C.sid }));
  fs.unlinkSync(path.join(C.estado, 'active', `${C.sid}.json`));
  const ev = (rel) => io.evaluate({ filePath: path.join(C.repo, rel), sessionId: nueva, cwd: C.repo, via: 'Edit', stateDir: C.estado, installedRoots: [] });
  const dentro = ev('src/combo.js');
  assert.notStrictEqual(tipo(dentro), 'batch-out-of-list', JSON.stringify(dentro && dentro.verdict));
  const fuera = ev('src/grilla.js');
  assert.strictEqual(tipo(fuera), 'batch-out-of-list');
  assert.match(fuera.verdict.reason, /no está en la lista de la parte A-el-combo/, 'frena por la lista heredada, no por no encontrarla');
  // sin «adoptedFrom», la constancia es de otra sesión: no se hereda y, con una parte, frena en duda
  fs.writeFileSync(path.join(C.estado, 'active', `${nueva}.json`), JSON.stringify({ ...C.marker, sessionId: nueva }));
  assert.match(io.listaDelPlanDelegado(C.estado, nueva, { ...C.marker, sessionId: nueva }).problema, /no está la constancia de la revisión/);
});

// ── la parte no cambia con el plan aprobado ───────────────────────────────────────────────────────

const { spawnSync } = require('child_process');
const MARKER = path.join(SCRIPTS, 'marker.js');
/** Una HOME con el marcador de una corrida con el plan aprobado, sin parte; marker.js corre con ella. */
function conPlanSinParte() {
  const repo = tmp('repo-');
  execFileSync('git', ['init', '-q', '-b', 'feat/x', repo]);
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const story = path.join(repo, 'specs', 'story-9.7-partes.md');
  fs.writeFileSync(story, historia());
  const home = tmp('home-');
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const m = { storyId: '9.7', storyPath: story, repoPath: repo, startedAt: new Date().toISOString(), lastTouch: new Date().toISOString(),
    stepScheme: 2, stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'], stepsPending: ['implement', 'run-tests'],
    planApproval: { mode: 'user', text: 'dale', at: new Date().toISOString() } };
  fs.writeFileSync(path.join(estado, 'active', 'sp.json'), JSON.stringify(m));
  const correr = (args) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'sp', TYCON_HOME: '', NODE_OPTIONS: '' } });
  const leer = () => JSON.parse(fs.readFileSync(path.join(estado, 'active', 'sp.json'), 'utf8'));
  return { correr, leer, estado };
}

test('T20 ParteConPlanAprobado_NoCambia — @story-8.168 @ac-11', () => {
  const P = conPlanSinParte();
  // anotar la parte con el plan ya aprobado sin parte: «Aprobar el plan» queda pendiente otra vez, con su línea
  const r = P.correr(['set-batch', A]);
  assert.strictEqual(r.status, 0, r.stderr);
  const m = P.leer();
  assert.strictEqual(m.batch, A);
  assert.ok(m.stepsPending.includes('approve-plan') && !m.stepsCompleted.includes('approve-plan'), JSON.stringify(m));
  assert.strictEqual(m.planApproval, undefined);
  assert.match(fs.readFileSync(path.join(P.estado, 'gates.log'), 'utf8'), /"name":"plan-reopened"/);
  // otra tanda, o `set` con batch: se niegan, como hoy
  assert.strictEqual(P.correr(['set-batch', B]).status, 2);
  assert.strictEqual(P.correr(['set', JSON.stringify({ storyId: '9.7', batch: B })]).status, 2);
  assert.strictEqual(P.leer().batch, A);
});

// ── el diff entero al cerrar ──────────────────────────────────────────────────────────────────────

const FRENO = 'skills/tycon-pipeline/scripts/lib/story-gate.js';
/** Un repo con su origen y una rama con cambios; un marcador con el plan aprobado `modo` (revision o user). */
function cierre({ cambios, modo = 'revision' }) {
  const raiz = tmp('cierre-');
  const origen = path.join(raiz, 'origen.git');
  const repo = path.join(raiz, 'repo');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('remote', 'add', 'origin', origen);
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const story = path.join(repo, 'specs', 'story-9.7-partes.md');
  fs.writeFileSync(story, historia());
  git('add', '.');
  git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'base');
  git('push', '-q', 'origin', 'main');
  git('switch', '-q', '-c', 'feat/x');
  for (const rel of cambios) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), 'x\n');
  }
  git('add', '.');
  const home = tmp('home-');
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const markerPath = path.join(estado, 'active', 'sc.json');
  const m = { storyId: '9.7', storyPath: story, repoPath: repo, startedAt: new Date().toISOString(), batch: A, batchValid: true,
    stepScheme: 2, stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement'], stepsPending: ['prepare-commit'],
    planApproval: modo === 'revision' ? { mode: 'revision', text: 'revisión', at: new Date().toISOString(), revision: { id: 'x', lanzo: 'coord' } } : { mode: 'user', text: 'dale', at: new Date().toISOString() } };
  fs.writeFileSync(markerPath, JSON.stringify(m));
  const freno = () => require(path.join(SCRIPTS, 'lib', 'batch-scope.js')).frenoDelCierre({ markerPath, estado, sid: 'sc' });
  const leer = () => JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  return { repo, home, estado, git, freno, leer, markerPath };
}

test('T21 Cierre_DiffDelicado_PlanDelegado_Frena — @story-8.168 @ac-12', () => {
  // el diff entero trae el freno (y una prueba): delicado
  const K = cierre({ cambios: ['src/combo.js', FRENO, 'tests/combo.test.js'] });
  const f = K.freno();
  assert.ok(f && /diff entero sale delicado/.test(f.texto) && /story-gate\.js/.test(f.texto), JSON.stringify(f));
  const m = K.leer();
  assert.ok(m.stepsPending.includes('approve-plan'), 'el plan vuelve a pendiente con el dueño');
  assert.strictEqual(m.planApproval, undefined);
  // sin red (el origen no contesta): no se mide, y no guarda
  const S = cierre({ cambios: ['src/combo.js'] });
  S.git('remote', 'set-url', 'origin', path.join(S.home, 'no-existe.git'));
  assert.match((S.freno() || {}).texto || '', /no pude traer la rama principal/);
});

test('T22 Cierre_DuenoReaprueba_Pasa — @story-8.168 @ac-12', () => {
  // con el plan aprobado (otra vez) por una persona, el diff delicado no frena
  const K = cierre({ cambios: ['src/combo.js', FRENO], modo: 'user' });
  assert.strictEqual(K.freno(), null);
});

test('T23 Cierre_DiffNoDelicado_Pasa — @story-8.168 @ac-12', () => {
  const K = cierre({ cambios: ['src/combo.js', 'docs/combo.md'] });
  assert.strictEqual(K.freno(), null);
  assert.ok(K.leer().planApproval, 'el plan sigue aprobado');
});

test('T33 Commit_PorFueraDelPaso_Frena — @story-8.168 @ac-12', () => {
  const K = cierre({ cambios: ['src/combo.js', FRENO] });
  // el origin/main local movido a HEAD no esconde nada: se mide contra main recién traído
  K.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const hook = path.join(SCRIPTS, 'on-pre-commit.js');
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'sc', cwd: K.repo, tool_input: { command: 'git commit -m x' } }),
    encoding: 'utf8', cwd: K.repo, env: { ...process.env, HOME: K.home, USERPROFILE: K.home, CLAUDE_CODE_SESSION_ID: 'sc', TYCON_HOME: '', NODE_OPTIONS: '' },
  });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /diff entero sale delicado|cierre/);
});

// ── lo que encontró el pase adversarial de la 8.245 ───────────────────────────────────────────────

const CFG = ['-c', 'user.email=a@b', '-c', 'user.name=a'];

// 🔴 Falla con: un archivo delicado movido de lugar que el cierre cuenta sólo por su ruta nueva.
test('P2 Cierre_RenombreDelDelicado_Frena — @story-8.168 @ac-12', () => {
  const K = cierre({ cambios: ['src/combo.js'] });
  K.git(...CFG, 'commit', '-qm', 'combo');
  K.git('switch', '-q', 'main');
  fs.mkdirSync(path.dirname(path.join(K.repo, FRENO)), { recursive: true });
  fs.writeFileSync(path.join(K.repo, FRENO), '// el freno\n');
  K.git('add', '.');
  K.git(...CFG, 'commit', '-qm', 'el freno en main');
  K.git('push', '-q', 'origin', 'main');
  K.git('switch', '-q', 'feat/x');
  K.git(...CFG, 'merge', '-q', '--no-edit', 'main');
  fs.mkdirSync(path.join(K.repo, 'docs'), { recursive: true });
  K.git('mv', FRENO, 'docs/movido.txt');
  const f = K.freno();
  assert.ok(f && /diff entero sale delicado/.test(f.texto), JSON.stringify(f));
});

// 🔴 Falla con: repetir el commit después de que el cierre devolvió el plan a una persona.
test('P23 Cierre_RepetirElCommitNoLoSaltea — @story-8.168 @ac-12', () => {
  const K = cierre({ cambios: ['src/combo.js', FRENO] });
  assert.match(K.freno().texto, /diff entero sale delicado/);
  const otra = K.freno();
  assert.ok(otra && /volvió a una persona/.test(otra.texto), JSON.stringify(otra));
  const m = K.leer();
  // la coordinadora lo vuelve a aprobar: sigue frenando
  fs.writeFileSync(K.markerPath, JSON.stringify({ ...m, planApproval: { mode: 'revision', text: 'revisión', at: new Date().toISOString() } }));
  assert.match(K.freno().texto, /volvió a una persona/);
  // lo aprueba una persona: pasa
  fs.writeFileSync(K.markerPath, JSON.stringify({ ...m, planApproval: { mode: 'user', text: 'dale', at: new Date().toISOString() } }));
  assert.strictEqual(K.freno(), null);
});

// 🔴 Falla con: un repo cuya rama principal es master, que no puede cerrar nunca.
test('P16 Cierre_RamaPrincipalMaster — @story-8.168 @ac-12', () => {
  const K = cierre({ cambios: ['src/combo.js'] });
  const origen = path.join(path.dirname(K.repo), 'origen.git');
  K.git('push', '-q', 'origin', 'main:master');
  execFileSync('git', ['--git-dir', origen, 'symbolic-ref', 'HEAD', 'refs/heads/master']);
  execFileSync('git', ['--git-dir', origen, 'update-ref', '-d', 'refs/heads/main']);
  K.git('fetch', '-q', '--prune', 'origin');
  assert.throws(() => K.git('rev-parse', '--verify', '-q', 'refs/remotes/origin/main'));
  assert.strictEqual(K.freno(), null);
});

// 🔴 Falla con: un repo puesto bajo una carpeta `tests/`, donde todo parecía una prueba y la parte dejaba pasar todo.
test('P8 Parte_RepoBajoTests_Frena — @story-8.168 @ac-9', () => {
  const C = corrida({ bajo: 'tests' });
  assert.strictEqual(tipo(C.ev('src/grilla.js')), 'batch-out-of-list');
});

// 🔴 Falla con: un comentario entre los archivos de la parte, que cortaba la lista.
test('P3 Parte_ComentarioEnLaLista_NoLaCorta — @story-8.168 @ac-9', () => {
  const sc = require(path.join(SCRIPTS, 'lib', 'story-checks.js'));
  const texto = historia().replace('      - src/combo.js', '      - src/combo.js\n      # el de abajo también\n\n      - src/delicado.js');
  const parte = sc.parsePipelinesBlock(texto).find((p) => p.name === A);
  assert.deepStrictEqual(parte.files, ['src/combo.js', 'src/delicado.js', 'docs/combo.md']);
});

// ── la segunda vuelta del pase adversarial ────────────────────────────────────────────────────────

const scope = () => require(path.join(SCRIPTS, 'lib', 'batch-scope.js'));

// 🔴 Falla con: una ruta con tildes o eñes que git devuelve entre comillas y escapada, y que las reglas de la marca de
// delicada no reconocen (un pipeline de producción con tilde en el nombre pasaba el cierre).
test('Q3 Cierre_RutaConTildes_SeMideTalCual — @story-8.168 @ac-12', () => {
  // una guardada en la rama, una en el índice y una sin seguir: las tres listas
  const K = cierre({ cambios: ['src/combo.js', 'src/canción.js'] });
  K.git(...CFG, 'commit', '-qm', 'lo guardado');
  fs.writeFileSync(path.join(K.repo, 'src', 'añadir.js'), 'x\n');
  K.git('add', '.');
  fs.writeFileSync(path.join(K.repo, 'src', 'publicación.js'), 'x\n');
  const r = scope().cierreDelPlanDelegado({ marker: K.leer(), repo: K.repo, delicada: () => ({ value: false }) });
  assert.deepStrictEqual(r.archivos, ['src/añadir.js', 'src/canción.js', 'src/combo.js', 'src/publicación.js']);
  // de punta a punta: el pipeline de producción con tilde en el nombre sale delicado como su gemelo sin tilde
  fs.writeFileSync(path.join(K.repo, 'azure-pipelines-producción.yml'), 'stages:\n- stage: Production\n  jobs: []\n');
  const f = K.freno();
  assert.ok(f && /diff entero sale delicado/.test(f.texto), JSON.stringify(f));
});

// 🔴 Falla con: un comentario en el renglón de `files:` de la parte, que el lector tomaba como su único archivo y dejaba
// la parte inválida (se medía la historia entera).
test('Q11 Parte_ComentarioEnElRenglonDeFiles_NoEsUnArchivo — @story-8.168 @ac-9', () => {
  for (const renglon of ['    files:   # los de la tanda A', '    files: # el código de la parte']) {
    const texto = historia().replace('    files:\n      - src/combo.js', `${renglon}\n      - src/combo.js`);
    const p = scope().validarParte(texto, A);
    assert.ok(p.valid, `${renglon}: ${p.reason}`);
    assert.deepStrictEqual(p.files, ['src/combo.js', 'docs/combo.md']);
  }
});

// 🔴 Falla con: una rama que sale de `dev` medida contra main, que cuenta lo que dev trae de otras historias (un archivo
// delicado ajeno devolvía el plan a una persona).
test('Q12 Cierre_RamaDeDev_MideContraDev — @story-8.168 @ac-12', () => {
  const K = cierre({ cambios: ['src/combo.js'] });
  K.git(...CFG, 'commit', '-qm', 'combo');
  K.git('switch', '-q', '-c', 'dev', 'main');
  fs.mkdirSync(path.dirname(path.join(K.repo, FRENO)), { recursive: true });
  fs.writeFileSync(path.join(K.repo, FRENO), '// de otra historia\n');
  K.git('add', '.');
  K.git(...CFG, 'commit', '-qm', 'otra historia en dev');
  K.git('push', '-q', 'origin', 'dev');
  K.git('switch', '-q', '-c', 'feat/y', 'dev');
  fs.mkdirSync(path.join(K.repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(K.repo, 'src', 'grilla.js'), 'x\n');
  K.git('add', '.');
  const r = scope().cierreDelPlanDelegado({ marker: K.leer(), repo: K.repo, delicada: () => ({ value: false }) });
  assert.deepStrictEqual(r.archivos, ['src/grilla.js']);
  assert.strictEqual(K.freno(), null);
  // lo delicado que toca la propia rama sigue contando
  fs.writeFileSync(path.join(K.repo, FRENO), '// cambiado en la rama\n');
  const f = K.freno();
  assert.ok(f && /diff entero sale delicado/.test(f.texto) && /story-gate\.js/.test(f.texto), JSON.stringify(f));
});

// 🔴 Falla con: una historia con partes sin `files:` (el formato de antes): la coordinadora aprobaba el plan, medido con la
// historia entera, y después cada edición de código frenaba como fuera de la parte (pase de la 8.245, clase 9).
test('Q9 Parte_SinFiles_PlanDelegadoNoAtaLista — @story-8.168 @ac-9', () => {
  const sinFiles = ['---', 'story: "9.7"', 'title: "partes"', 'status: in-progress', 'files_to_modify:',
    '  - src/combo.js', '  - src/grilla.js', 'pipelines:',
    `  - name: ${A}`, '    status: pending', '    acs: [1]', `  - name: ${B}`, '    status: pending', '    acs: [2]',
    '---', '# Story 9.7', '', '## Acceptance Criteria', '', '1. **Given** algo, **Then** pasa.', ''].join('\n');
  const C = corrida({ texto: sinFiles });
  for (const rel of ['src/combo.js', 'src/grilla.js']) assert.notStrictEqual(tipo(C.ev(rel)), 'batch-out-of-list', rel);
});

// 🔴 Falla con: un marcador roto que el cierre tomaba como «no hay corrida» y dejaba guardar (revisor de fallos
// silenciosos, vuelta 2); sin marcador, no hay nada que cerrar.
test('R1 Cierre_MarcadorQueNoSeLee_Frena — @story-8.168 @ac-12', () => {
  const K = cierre({ cambios: ['src/combo.js', FRENO] });
  fs.writeFileSync(K.markerPath, '{ roto');
  assert.match((K.freno() || {}).texto || '', /no pude leer el marcador de la corrida/);
  fs.rmSync(K.markerPath);
  assert.strictEqual(K.freno(), null);
});

// ── anotar la parte con el plan igual de una persona no lo reabre ─────────────────────────────────────────────────

const crypto = require('crypto');
const { conVentana } = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'tests', 'lib', 'window-passed.js'));
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const PLAN = '# Plan\n\n## Qué hace\n\nCambiar el combo.\n\n## Archivos\n\n- src/combo.js\n';

/** Un repo con la historia de dos partes, una HOME de prueba y marker.js con ella (la sesión `sp`). */
function laboratorio() {
  const repo = tmp('repo-');
  execFileSync('git', ['init', '-q', '-b', 'feat/x', repo]);
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const story = path.join(repo, 'specs', 'story-9.7-partes.md');
  fs.writeFileSync(story, historia());
  const home = tmp('home-');
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'sp', TYCON_LANE_LLM: '0', TYCON_PROFILE: '0' };
  for (const k of ['TYCON_HOME', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_OPTIONS', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS']) delete env[k];
  const correr = (args, ventana) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8', env: ventana ? conVentana(env, ventana) : env });
  const markerPath = path.join(estado, 'active', 'sp.json');
  const leer = () => JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const gates = () => { try { return fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };
  const runDir = path.join(repo, '.advisors', 'pipeline-runs', '9.7-20261115000000');
  const planFile = path.join(runDir, 'step-02-bmad-plan.md');
  /** El marcador de una corrida con el plan aprobado (`aprobacion`), su carpeta y el plan escrito ahí. */
  const conPlan = (aprobacion, extra = {}) => {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(planFile, PLAN);
    const at = new Date().toISOString();
    fs.writeFileSync(markerPath, JSON.stringify({ storyId: '9.7', storyPath: story, repoPath: repo, runDir, startedAt: at, lastTouch: at,
      stepScheme: 2, stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'], stepsPending: ['implement', 'run-tests'],
      planApproval: { at, ...aprobacion }, ...extra }));
  };
  return { repo, story, home, estado, correr, leer, gates, runDir, planFile, markerPath, conPlan };
}

// 🔴 Falla con: la huella que no se guarda al aprobar, `set-batch` que reabre igual con el plan sin cambios, o que deja
// cambiar de parte.
test('T1 SetBatch_PlanIgualDeUnaPersona_NoReabre — @story-8.284 @ac-1 @ac-2 @ac-5', () => {
  const L = laboratorio();
  // la aprobación de una persona (el click en el cuadro) guarda la huella del plan escrito
  assert.strictEqual(L.correr(['set', JSON.stringify({ storyId: '9.7', storyPath: L.story, repoPath: L.repo, runDir: L.runDir })]).status, 0);
  for (const n of ['0', '1', '2']) L.correr(['complete-step', n], {});
  fs.mkdirSync(L.runDir, { recursive: true });
  fs.writeFileSync(L.planFile, PLAN);
  const ap = L.correr(['complete-step', 'approve-plan', '--approved', 'dale'], { via: 'click' });
  assert.strictEqual(ap.status, 0, `${ap.stdout}${ap.stderr}`);
  const aprobado = L.leer();
  assert.strictEqual(aprobado.planApproval.mode, 'user');
  assert.strictEqual(aprobado.planApproval.planSha, sha256(PLAN));
  // la misma huella que la revisión del plan
  assert.strictEqual(aprobado.planApproval.planSha, sha256(pr.planDe(aprobado).texto));
  // anotar la parte con el plan igual: la aprobación queda
  const r = L.correr(['set-batch', A]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /el plan no cambió desde que lo aprobó una persona/);
  const m = L.leer();
  assert.strictEqual(m.batch, A);
  assert.ok(require(path.join(SCRIPTS, 'lib', 'steps.js')).isDone(m, 'approve-plan'), JSON.stringify(m));
  assert.deepStrictEqual(m.stepsCompleted, aprobado.stepsCompleted);
  assert.deepStrictEqual(m.stepsPending, aprobado.stepsPending);
  assert.deepStrictEqual(m.planApproval, aprobado.planApproval);
  const kept = L.gates().filter((g) => g.name === 'plan-kept');
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].batch, A);
  assert.match(kept[0].motivo, /el plan no cambió desde que lo aprobó una persona/);
  assert.ok(!L.gates().some((g) => g.name === 'plan-reopened'));
  // otra tanda y --clear se niegan, como hoy
  assert.strictEqual(L.correr(['set-batch', B]).status, 2);
  assert.strictEqual(L.correr(['set-batch', '--clear']).status, 2);
  assert.strictEqual(L.leer().batch, A);
  // sin plan escrito al aprobar, no guarda huella
  const S = laboratorio();
  S.correr(['set', JSON.stringify({ storyId: '9.7', storyPath: S.story, repoPath: S.repo, runDir: S.runDir })]);
  for (const n of ['0', '1', '2']) S.correr(['complete-step', n], {});
  const sin = S.correr(['complete-step', 'approve-plan', '--approved', 'dale'], { via: 'click' });
  assert.strictEqual(sin.status, 0, `${sin.stdout}${sin.stderr}`);
  assert.strictEqual(S.leer().planApproval.planSha, undefined);
  // con la maqueta aprobada sin cambios, también queda
  const Q = laboratorio();
  const maqueta = path.join(Q.repo, 'maqueta.html');
  fs.writeFileSync(maqueta, '<html>la aprobada</html>');
  Q.conPlan({ mode: 'user', text: 'dale', planSha: sha256(PLAN) }, { mockupApproval: { file: maqueta, sha256: sha256('<html>la aprobada</html>'), mode: 'user' } });
  const q = Q.correr(['set-batch', A]);
  assert.strictEqual(q.status, 0, q.stderr);
  assert.match(q.stdout, /el plan no cambió desde que lo aprobó una persona/);
  assert.ok(Q.leer().planApproval, 'la aprobación queda');
  // una tanda que no está, o una done, se niegan sin tocar la aprobación
  const N = laboratorio();
  N.conPlan({ mode: 'user', text: 'dale', planSha: sha256(PLAN) });
  assert.strictEqual(N.correr(['set-batch', 'Z-no-esta']).status, 2);
  fs.writeFileSync(N.story, historia().replace(`  - name: ${A}\n    status: pending`, `  - name: ${A}\n    status: done`));
  assert.strictEqual(N.correr(['set-batch', A]).status, 2);
  assert.strictEqual(N.leer().batch, undefined);
  assert.ok(N.leer().planApproval, 'la aprobación queda');
});

// 🔴 Falla con: conservar una aprobación con el plan o la maqueta cambiados, sin huella, sin plan legible, o de la
// revisión automática con una parte que no declara su lista (files:): sin esa lista no hay con qué atar el portón.
test('T2 SetBatch_PlanCambiadoSinHuellaODeRevision_Reabre — @story-8.284 @ac-3 @ac-4 @ac-18', () => {
  const casos = [
    ['el plan cambió', (L) => { L.conPlan({ mode: 'user', text: 'dale', planSha: sha256(PLAN) }); fs.writeFileSync(L.planFile, `${PLAN}\nOtro paso.\n`); },
      /el plan cambió desde que lo aprobó una persona/],
    ['sin huella', (L) => L.conPlan({ mode: 'user', text: 'dale' }), /la aprobación es de antes de guardar la huella del plan/],
    ['plan borrado', (L) => { L.conPlan({ mode: 'user', text: 'dale', planSha: sha256(PLAN) }); fs.rmSync(L.planFile); },
      /no pude leer el plan de ahora/],
    ['de la revisión, la parte sin files:', (L) => {
      fs.writeFileSync(L.story, sinFilesEnA(historia()));
      L.conPlan({ mode: 'revision', text: 'revisión', planSha: sha256(PLAN), revision: { id: 'x', lanzo: 'coord' } });
    },
      /la aprobación fue de la revisión automática/],
    ['la maqueta cambió', (L) => {
      const maqueta = path.join(L.repo, 'maqueta.html');
      fs.writeFileSync(maqueta, '<html>otra</html>');
      L.conPlan({ mode: 'user', text: 'dale', planSha: sha256(PLAN) }, { mockupApproval: { file: maqueta, sha256: sha256('<html>la aprobada</html>'), mode: 'user' } });
    }, /la maqueta aprobada cambió o no se puede leer/],
  ];
  for (const [nombre, armar, linea] of casos) {
    const L = laboratorio();
    armar(L);
    const r = L.correr(['set-batch', A]);
    assert.strictEqual(r.status, 0, `${nombre}: ${r.stderr}`);
    assert.match(r.stdout, linea, nombre);
    assert.match(r.stdout, /«Aprobar el plan» queda pendiente otra vez/, nombre);
    const m = L.leer();
    assert.strictEqual(m.batch, A, nombre);
    assert.ok(m.stepsPending.includes('approve-plan') && !m.stepsCompleted.includes('approve-plan'), nombre);
    assert.strictEqual(m.planApproval, undefined, nombre);
    const reabierto = L.gates().filter((g) => g.name === 'plan-reopened');
    assert.strictEqual(reabierto.length, 1, nombre);
    assert.match(reabierto[0].motivo, linea, nombre);
    assert.ok(!L.gates().some((g) => g.name === 'plan-kept'), nombre);
  }
});

// ── anotar la parte con el plan igual de la revisión automática: vale la lista que declara la historia ──────────────

// la historia sin el `files:` de la parte A
const sinFilesEnA = (texto) => texto.replace(/(  - name: A-el-combo\n    status: pending\n    acs: \[1\]\n)    files:\n(?:      - .*\n)+/, '$1');

/** El laboratorio de set-batch con el plan aprobado por la revisión automática que lanzó la coordinadora, sin parte. */
function aprobadoPorLaRevision() {
  const L = laboratorio();
  L.conPlan({ mode: 'revision', text: 'revisión automática', planSha: sha256(PLAN) });
  const p = pr.preparar({ lanza: 'coord', destino: 'sp', estado: L.estado, designada: () => 'coord' });
  assert.strictEqual(p.codigo, 0, p.motivo);
  const pedido = JSON.parse(fs.readFileSync(p.pedido, 'utf8'));
  const c = pr.anotar({ lanza: 'coord', destino: 'sp', estado: L.estado, resultado: { medido: true, modo: 'plan', confirmed: [], pedido: pedido.numero } });
  assert.ok(!c.parte, 'la revisión fue sin parte');
  const m = L.leer();
  m.planApproval.revision = { id: c.id, veredicto: c.veredicto, modelo: c.modelo, lanzo: 'coord' };
  fs.writeFileSync(L.markerPath, JSON.stringify(m));
  L.ev = (rel) => io.evaluate({ filePath: path.join(L.repo, rel), sessionId: 'sp', cwd: L.repo, via: 'Edit', stateDir: L.estado, installedRoots: [] });
  return L;
}

// 🔴 Falla con: anotar la parte después de que la revisión automática aprobó el plan sin parte lo reabre (y la sesión
// queda esperando otra aprobación del mismo plan), o el portón de la parte frena todo porque esa revisión no trae lista.
test('T3 SetBatch_PlanIgualDeLaRevision_NoReabre_YElPortonUsaLaListaDeLaHistoria — @story-8.284', () => {
  const L = aprobadoPorLaRevision();
  const aprobado = L.leer();
  // sin parte, el portón no ata ninguna lista
  assert.notStrictEqual(tipo(L.ev('src/grilla.js')), 'batch-out-of-list');
  const r = L.correr(['set-batch', A]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /el plan no cambió desde que lo aprobó la revisión automática/);
  assert.match(r.stdout, /«Aprobar el plan» sigue hecho/);
  const m = L.leer();
  assert.strictEqual(m.batch, A);
  assert.ok(require(path.join(SCRIPTS, 'lib', 'steps.js')).isDone(m, 'approve-plan'), JSON.stringify(m));
  assert.deepStrictEqual(m.planApproval, aprobado.planApproval, 'la aprobación queda tal cual');
  assert.ok(!L.gates().some((g) => g.name === 'plan-reopened'));
  // la lista que declara la historia para la parte queda anotada con la aprobación que conserva
  const kept = L.gates().filter((g) => g.name === 'plan-kept');
  assert.strictEqual(kept.length, 1);
  assert.deepStrictEqual([kept[0].batch, kept[0].files, kept[0].aprobacion], [A, ['src/combo.js', 'docs/combo.md'], aprobado.planApproval.at]);
  // el portón de la parte usa esa lista: lo de la parte pasa, lo de otra frena
  assert.notStrictEqual(tipo(L.ev('src/combo.js')), 'batch-out-of-list');
  assert.strictEqual(tipo(L.ev('src/grilla.js')), 'batch-out-of-list');
  // la historia suma el archivo a la parte después: no amplía nada (la lista quedó al anotar la parte)
  fs.writeFileSync(L.story, historia({ filesA: ['src/combo.js', 'docs/combo.md', 'src/grilla.js'] }));
  assert.strictEqual(tipo(L.ev('src/grilla.js')), 'batch-out-of-list');
  // un renglón de la lista para otra aprobación no cuenta: sin el de esta, el portón no adivina y frena
  const otro = aprobadoPorLaRevision();
  fs.appendFileSync(path.join(otro.estado, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), sessionId: 'sp', name: 'plan-kept', status: 'ok', story: '9.7', batch: A, files: ['src/grilla.js'], aprobacion: 'otra' })}\n`);
  const mm = otro.leer();
  fs.writeFileSync(otro.markerPath, JSON.stringify({ ...mm, batch: A, batchValid: true }));
  const v = otro.ev('src/combo.js');
  assert.strictEqual(tipo(v), 'batch-out-of-list', JSON.stringify(v));
  assert.match(v.verdict.reason, /no pude leer la lista de la parte/);
});

// 🔴 Falla con: conservar la aprobación de la revisión con el plan cambiado, o sin la lista declarada de la parte.
test('T4 SetBatch_DeLaRevision_PlanCambiadoOParteSinFiles_Reabre — @story-8.284', () => {
  const L = aprobadoPorLaRevision();
  fs.writeFileSync(L.planFile, `${PLAN}\nOtro paso.\n`);
  const r = L.correr(['set-batch', A]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /el plan cambió desde que lo aprobó la revisión automática/);
  assert.match(r.stdout, /«Aprobar el plan» queda pendiente otra vez/);
  assert.strictEqual(L.leer().planApproval, undefined);
  const S = aprobadoPorLaRevision();
  fs.writeFileSync(S.story, sinFilesEnA(historia()));
  const s2 = S.correr(['set-batch', A]);
  assert.strictEqual(s2.status, 0, s2.stderr);
  assert.match(s2.stdout, /la parte no declara una lista de archivos \(files:\) que valga/);
  assert.strictEqual(S.leer().planApproval, undefined);
  assert.ok(!S.gates().some((g) => g.name === 'plan-kept'));
});
