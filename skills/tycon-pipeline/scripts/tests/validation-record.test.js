'use strict';

/**
 * validation-record.test.js — una historia que no cambió desde su última validación verde no se vuelve a validar.
 *
 * Lo que no se puede perder:
 *   - la constancia la escribe sólo `validation-record`, en la carpeta de estado, con vocabulario cerrado (verde · rojo)
 *     y la lista de validadores que corrieron;
 *   - vale mientras la huella de la historia sea la misma que la de la revisión previa: el avance del trabajo (el estado,
 *     el Change Log) no la invalida, un criterio cambiado sí;
 *   - `validators` saca de la lista sólo los validadores que corrieron en verde sobre esta misma huella, y lo dice;
 *     un rojo, una historia cambiada o una constancia ilegible validan de nuevo.
 *
 * Todo corre en laboratorios (HOME aislado, árbol del arnés vacío, repos temporales) con nombres inventados (acme).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const RECORD = path.join(SCRIPTS, 'lib', 'validation-record.js');
const VALIDADOR = 'tycon-story-validator';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `validacion-previa-${p}-`));
const lib = () => require(RECORD);

function escribir(file, txt) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, txt); }

function env(home, extra = {}) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, TYCON_GUIDES_DIR: tmp('arbol'), TYCON_LANE_LLM: '0', TYCON_PACKS_DEFAULT: 'none', TYCON_STORY_REVIEW: '0', ...extra };
  for (const k of ['NODE_TEST_CONTEXT', 'CLAUDE_CODE_SESSION_ID']) if (!(k in extra)) delete e[k];
  return e;
}

function historia(status = 'ready-for-dev') {
  return [
    '---', 'story: "9.5"', 'title: "historia de laboratorio 9.5"', `status: ${status}`, 'approach: "[MODIFY]"',
    'files_to_modify:', '  - src/m0.js', '---', '',
    '# Story 9.5: la tienda de acme', '', `Status: ${status}`, '',
    '## Acceptance Criteria', '',
    '1. **Given** un pedido **When** se guarda **Then** queda con su total.', '',
    '### Tests', '', '| # | Test | AC |', '|---|---|---|', '| T1 | `Pedido_ConTotal` | 1 |', '',
    '## Tasks / Subtasks', '', '1. Guardar el total.', '',
    '## Change Log', '', '| Fecha | Cambio |', '|---|---|', '| 2026-10-26 | Story escrita. |', '',
  ].join('\n');
}

function lab() {
  const repo = tmp('repo');
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  const story = path.join(repo, 'specs', 'story-9.5.md');
  escribir(story, historia());
  escribir(path.join(repo, 'src', 'm0.js'), 'module.exports = 0;\n');
  return { repo, story, home: tmp('home') };
}

function run(cmd, l, args = []) {
  const r = spawnSync(process.execPath, [PIPELINE, cmd, '--story', l.story, '--repo', l.repo, ...args],
    { encoding: 'utf8', env: env(l.home), cwd: l.repo, input: '' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { json = null; }
  return { rc: r.status, out: `${r.stdout}\n${r.stderr}`, json };
}
const validators = (l) => run('validators', l);
const record = (l, args) => run('validation-record', l, args);

test('Validators_SinConstancia_ValidaComoSiempre — sin validación previa, el validador corre', () => {
  const l = lab();
  const r = validators(l);
  assert.equal(r.rc, 0, r.out);
  assert.ok(r.json.validadores.includes(VALIDADOR), r.out);
  assert.equal(r.json.validacion_previa.estado, 'none', r.out);
  assert.equal(r.json.validacion_previa.omitidos.length, 0, r.out);
});

test('Validators_VerdeYSinCambios_NoVuelveAValidar — la misma huella en verde saca al validador y lo dice', () => {
  const l = lab();
  const w = record(l, ['--result', 'verde', '--validators', VALIDADOR]);
  assert.equal(w.rc, 0, w.out);
  const r = validators(l);
  assert.equal(r.rc, 0, r.out);
  assert.ok(!r.json.validadores.includes(VALIDADOR), r.out);
  assert.equal(r.json.validacion_previa.estado, 'current', r.out);
  assert.deepEqual(r.json.validacion_previa.omitidos, [VALIDADOR], r.out);
  assert.match(r.json.validacion_previa.linea, /^validación previa vigente: verde, .*tycon-story-validator/, r.out);
});

test('Validators_AvanceDelTrabajo_NoInvalida — el estado y el Change Log no cambian la huella', () => {
  const l = lab();
  assert.equal(record(l, ['--result', 'verde', '--validators', VALIDADOR]).rc, 0);
  escribir(l.story, historia('in-progress').replace('| 2026-10-26 | Story escrita. |', '| 2026-10-26 | Story escrita. |\n| 2026-10-27 | Arranca. |'));
  const r = validators(l);
  assert.ok(!r.json.validadores.includes(VALIDADOR), r.out);
  assert.equal(r.json.validacion_previa.estado, 'current', r.out);
});

test('Validators_HistoriaCambiada_ValidaDeNuevo — un criterio cambiado vuelve a validar', () => {
  const l = lab();
  assert.equal(record(l, ['--result', 'verde', '--validators', VALIDADOR]).rc, 0);
  escribir(l.story, historia().replace('queda con su total', 'queda con su total y su fecha'));
  const r = validators(l);
  assert.ok(r.json.validadores.includes(VALIDADOR), r.out);
  assert.equal(r.json.validacion_previa.estado, 'stale', r.out);
  assert.equal(r.json.validacion_previa.omitidos.length, 0, r.out);
});

test('Validators_ValidacionRoja_ValidaDeNuevo — un rojo no cuenta como validada', () => {
  const l = lab();
  assert.equal(record(l, ['--result', 'rojo', '--validators', VALIDADOR]).rc, 0);
  const r = validators(l);
  assert.ok(r.json.validadores.includes(VALIDADOR), r.out);
  assert.equal(r.json.validacion_previa.omitidos.length, 0, r.out);
});

test('ValidationRecord_SoloOmiteLosQueCorrieron — un validador que no estaba en la constancia se lanza igual', () => {
  const salida = {
    validadores: [VALIDADOR, 'acme-sibling-reviewer'],
    lanzamientos: [{ agente: 'acme-sibling-reviewer', prompt: 'p' }],
  };
  const out = lib().omitirVigentes(salida, { estado: 'current', record: { resultado: 'verde', validadores: [VALIDADOR] } });
  assert.deepEqual(out.validadores, ['acme-sibling-reviewer']);
  assert.deepEqual(out.lanzamientos.map((x) => x.agente), ['acme-sibling-reviewer']);
  assert.deepEqual(out.omitidos, [VALIDADOR]);
  // con la constancia vieja o roja, nada se omite
  for (const c of [{ estado: 'stale', record: { resultado: 'verde', validadores: [VALIDADOR] } }, { estado: 'current', record: { resultado: 'rojo', validadores: [VALIDADOR] } }, { estado: 'none', record: null }]) {
    assert.deepEqual(lib().omitirVigentes(salida, c).omitidos, []);
  }
});

test('ValidationRecord_VocabularioCerrado — fuera de verde · rojo, o sin validadores, no escribe', () => {
  const l = lab();
  for (const args of [['--result', 'limpio', '--validators', VALIDADOR], ['--result', 'verde'], ['--result', 'verde', '--validators', '']]) {
    const r = record(l, args);
    assert.equal(r.rc, 2, `${args.join(' ')}\n${r.out}`);
  }
  assert.equal(lib().readRecord(l.home, l.story).estado, 'none');
});

test('ValidationRecord_ViveEnLaCarpetaDeEstado — donde el portón de escrituras niega escribir a mano', () => {
  const l = lab();
  const f = lib().recordFile(l.home, l.story);
  const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));
  assert.ok(f.startsWith(stateDir(l.home) + path.sep), f);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ no es json');
  assert.equal(lib().readRecord(l.home, l.story).estado, 'none');
});

test('Guias_ValidarLaHistoriaYCrearLaHistoria_DejanLaConstancia — los dos pasos que validan la anotan', () => {
  const paso = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-02-validate-story.md'), 'utf8');
  assert.match(paso, /validation-record --story/);
  assert.match(paso, /validacion_previa/);
  const crear = fs.readFileSync(path.join(RAIZ, 'skills', 'tycon-create-story', 'workflow.md'), 'utf8');
  assert.match(crear, /validation-record --story/);
});

// Dos copias de un mismo repo (dos clones de un mismo origin) o dos repos distintos, cada uno con su historia 9.5.
function conOrigin(origen) {
  const repo = tmp('copia');
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', origen], { stdio: 'ignore' });
  const story = path.join(repo, 'specs', 'story-9.5.md');
  escribir(story, historia());
  return { repo, story };
}

test('ValidationRecord_OtherCopySameRepo_Recognized @story-8.277 @ac-7 — la constancia escrita en una copia vale en otra del mismo repo', () => {
  const home = tmp('home');
  const a = conOrigin('https://example.com/acme/historias.git');
  const b = conOrigin('git@example.com:acme/historias');
  lib().writeRecord(home, a.story, { resultado: 'verde', validadores: [VALIDADOR] });
  assert.equal(lib().readRecord(home, b.story).estado, 'current');
});

test('ValidationRecord_FingerprintChanged_NotRecognized @story-8.277 @ac-8 — con la huella cambiada en la otra copia, no la reconoce', () => {
  const home = tmp('home');
  const a = conOrigin('https://example.com/acme/historias.git');
  const b = conOrigin('https://example.com/acme/historias.git');
  lib().writeRecord(home, a.story, { resultado: 'verde', validadores: [VALIDADOR] });
  escribir(b.story, historia().replace('queda con su total', 'queda con su total y su fecha'));
  assert.equal(lib().readRecord(home, b.story).estado, 'stale');
});

test('ValidationRecord_SameNumberOtherRepo_Separate @story-8.277 @ac-9 — el mismo número en otro repo, o en otro repo sin origin, no la ve', () => {
  const home = tmp('home');
  const a = conOrigin('https://example.com/acme/historias.git');
  const otro = conOrigin('https://example.com/acme/otras.git');
  lib().writeRecord(home, a.story, { resultado: 'verde', validadores: [VALIDADOR] });
  assert.equal(lib().readRecord(home, otro.story).estado, 'none', 'otro origin');
  // sin origin, la clave es la raíz real del repo: otro repo sin origin no la ve, el mismo sí
  const s1 = lab();
  const s2 = lab();
  lib().writeRecord(home, s1.story, { resultado: 'verde', validadores: [VALIDADOR] });
  assert.equal(lib().readRecord(home, s2.story).estado, 'none', 'otro repo sin origin');
  assert.equal(lib().readRecord(home, s1.story).estado, 'current', 'el mismo repo sin origin');
});

test('ValidationRecord_OldKey_StillRead @story-8.277 @ac-20 — una constancia con la clave de antes se sigue leyendo', () => {
  const home = tmp('home');
  const a = conOrigin('https://example.com/acme/historias.git');
  const vieja = lib().recordFileViejo(home, a.story);
  assert.notEqual(vieja, lib().recordFile(home, a.story), 'la clave cambió');
  const { huella } = require(path.join(SCRIPTS, 'lib', 'story-review-record.js'));
  escribir(vieja, JSON.stringify({ path: fs.realpathSync(a.story), resultado: 'verde', validadores: [VALIDADOR], huella: huella(historia()), hora: '2026-11-14T22:01:18.549Z' }));
  assert.equal(lib().readRecord(home, a.story).estado, 'current');
});

test('ValidationRecord_RelativeOrigin_ResolvedPerRepo @story-8.277 @ac-9 — (pase de la 8.277) un origin local relativo se resuelve contra su repo', () => {
  const home = tmp('home');
  // dos repos distintos, cada uno en su carpeta con su «../compartido.git» al lado: son dos remotas distintas
  const enSuCarpeta = () => {
    const repo = path.join(tmp('padre'), 'proj');
    spawnSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
    spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', '../compartido.git'], { stdio: 'ignore' });
    const story = path.join(repo, 'specs', 'story-9.5.md');
    escribir(story, historia());
    return { repo, story };
  };
  const a = enSuCarpeta();
  const b = enSuCarpeta();
  lib().writeRecord(home, a.story, { resultado: 'verde', validadores: [VALIDADOR] });
  assert.equal(lib().readRecord(home, b.story).estado, 'none', 'otro repo con la misma remota relativa no la ve');
  assert.equal(lib().readRecord(home, a.story).estado, 'current', 'el mismo repo sí');
});
