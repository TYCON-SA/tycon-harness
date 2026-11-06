'use strict';
// live-handles.test.js — el detector de consultas y temporizadores vivos en las pruebas de formularios.
//
// Lo que no se puede perder:
//   · falla la prueba que dejó algo vivo, con el tipo, los milisegundos o la dirección, y el archivo y la línea; la siguiente
//     arranca limpia;
//   · se mira cuando la prueba ya terminó del todo (después de todos sus afterEach), y después de desmontar: lo que la
//     pantalla o la prueba limpian no cuenta;
//   · la simulación de fetch de la prueba se envuelve, no se reemplaza: `.mock.calls`, `mockResolvedValue` y `jest.spyOn`
//     andan igual, y el detector sigue viendo sus consultas;
//   · una excepción ampara sólo por formulario, archivo y nombre, con motivo y fecha vigente; la regla es una sola para el
//     detector y el informe;
//   · el informe nunca dice «0» de lo que no miró, y en modo freno no deja pasar callado un formulario sin detector;
//   · la plantilla de formularios lo prende sólo con el modo, y cambiar la lista no versiona formularios.
//
// Corre jest de verdad sobre formularios de juguete (fixtures/live-handles/). jest no está en el arnés: se instala una vez en
// una carpeta de caché (TYCON_LIVE_HANDLES_DEPS la cambia). Sin red, cada prueba que lo necesita sale NO MEDIDO.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SETUP_DIR = path.join(ROOT, 'scripts', 'ci', 'test-setup');
const CONFIG = path.join(SETUP_DIR, 'jest.live-handles.config.js');
const REPORT = path.join(SETUP_DIR, 'report.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'live-handles');
const PACKS = process.env.TYCON_PACKS_DIR || path.join(ROOT, 'packs');
const TEMPLATE = path.join(PACKS, 'bizuit', 'templates', 'pipelines', 'forms-ci.yml');

const DEPS = {
  jest: '29.7.0',
  'jest-environment-jsdom': '29.7.0',
  'jest-junit': '16.0.0',
  '@testing-library/react': '14.3.1',
  react: '18.3.1',
  'react-dom': '18.3.1',
  'ts-node': '10.9.2',
  typescript: '5.4.5',
};

/** La carpeta con jest y compañía instalados, o `{ skip }` con por qué no. Se instala una sola vez. */
const deps = (() => {
  let memo = null;
  return () => {
    if (memo) return memo;
    const sum = crypto.createHash('sha1').update(JSON.stringify(DEPS)).digest('hex').slice(0, 10);
    const dir = process.env.TYCON_LIVE_HANDLES_DEPS || path.join(os.tmpdir(), `tycon-live-handles-deps-${sum}`);
    const done = path.join(dir, '.ready');
    if (!fs.existsSync(done)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'live-handles-deps', private: true, dependencies: DEPS }));
      const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: dir, encoding: 'utf8', timeout: 600000 });
      if (r.status !== 0) {
        memo = { skip: `NO MEDIDO: no pude instalar jest en ${dir} (${(r.stderr || r.error || '').toString().trim().split('\n').slice(-1)[0]})` };
        return memo;
      }
      fs.writeFileSync(done, 'listo\n');
    }
    memo = { dir, modules: path.join(dir, 'node_modules'), jest: path.join(dir, 'node_modules', 'jest', 'bin', 'jest.js') };
    return memo;
  };
})();

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `live-handles-${name}-`));

/** Copia un formulario de juguete a una carpeta temporal y le enchufa las dependencias. */
function form(name, { into = tmp(name), as = name, modules = deps().modules } = {}) {
  const dir = path.join(into, as);
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  fs.symlinkSync(modules, path.join(dir, 'node_modules'), 'dir');
  const toy = path.join(dir, 'vendor', 'toy-lib');
  if (fs.existsSync(toy)) fs.cpSync(toy, path.join(dir, 'third_party', 'node_modules', 'toy-lib'), { recursive: true });
  return fs.realpathSync(dir);
}

/** Un formulario hecho a mano: `files` es { ruta: contenido }. */
function handForm(into, name, files, { modules = deps().modules } = {}) {
  const dir = path.join(into, name);
  for (const [f, txt] of Object.entries({ 'package.json': JSON.stringify({ name, private: true }), ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), txt);
  }
  fs.symlinkSync(modules, path.join(dir, 'node_modules'), 'dir');
  return fs.realpathSync(dir);
}

const records = (out) => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/**
 * jest en la carpeta del formulario, con el detector (o sin él, `detector: false`). Devuelve el resultado de cada prueba
 * por su nombre, el de cada archivo, lo anotado y la salida.
 */
function jest(dir, files, { mode = 'block', detector = true, declared = null, today = null, formName = path.basename(dir), extra = [], env = {} } = {}) {
  const out = path.join(dir, '..', `${formName}-live-handles.jsonl`);
  const json = path.join(dir, '..', `${formName}-jest.json`);
  fs.rmSync(out, { force: true });
  const args = [deps().jest, '--ci', '--runInBand', '--json', `--outputFile=${json}`, ...extra, ...files];
  if (detector) args.splice(1, 0, `--config=${CONFIG}`);
  const vars = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), LIVE_HANDLES_MODE: mode, LIVE_HANDLES_FORM: formName, LIVE_HANDLES_OUT: out, ...env };
  if (declared) vars.LIVE_HANDLES_DECLARED = declared;
  if (today) vars.LIVE_HANDLES_TODAY = today;
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', env: vars, timeout: 180000 });
  const res = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : { testResults: [] };
  const tests = {};
  for (const f of res.testResults) for (const a of f.assertionResults) tests[`${path.relative(dir, f.name)} › ${a.fullName}`] = a;
  const byName = (name) => Object.entries(tests).filter(([k]) => k.endsWith(` › ${name}`)).map(([, v]) => v);
  return { status: r.status, out: r.stdout + r.stderr, tests, byName, files: res.testResults, records: records(out), outFile: out };
}

const one = (r, name) => {
  const found = r.byName(name);
  assert.strictEqual(found.length, 1, `esperaba una prueba «${name}»; hay ${found.length}. Salida:\n${r.out.slice(-3000)}`);
  return found[0];
};
const failed = (r, name) => one(r, name).status === 'failed';
const message = (r, name) => one(r, name).failureMessages.join('\n');

function needDeps(t) {
  const d = deps();
  if (d.skip) { t.skip(d.skip); return false; }
  return true;
}

function report(args, env = {}) {
  const r = spawnSync(process.execPath, [REPORT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** El guion de un paso Bash@3 de la plantilla, por su displayName. */
function stepScript(yml, displayName) {
  const lines = yml.split('\n');
  const at = lines.findIndex((l) => l.includes(`displayName: '${displayName}'`));
  assert.ok(at >= 0, `la plantilla no tiene el paso «${displayName}»`);
  const s = lines.findIndex((l, i) => i > at && /^\s+script: \|\s*$/.test(l));
  const indent = lines[s + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = s + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && l.match(/^\s*/)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

function needTemplate(t) {
  if (!fs.existsSync(TEMPLATE)) {
    t.skip('NO MEDIDO: sin el paquete bizuit (viaja con el perfil del equipo); se mide con TYCON_PACKS_DIR apuntando al repo del perfil');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- el detector

test('T1 Detector_SondeoSinCorte_FallaEsaPrueba @story-8.197 @ac-1 — falla la que dejó el sondeo; la siguiente pasa', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/polling.test.js']);
  assert.ok(failed(r, 'leaves the polling alive'), r.out);
  const m = message(r, 'leaves the polling alive');
  assert.match(m, /quedó vivo al terminar/);
  assert.match(m, /setTimeout\(1000 ms\)/);
  assert.match(m, /src\/Polling\.js:\d+/);
  assert.strictEqual(one(r, 'the next one starts clean').status, 'passed');
});

test('T2 Detector_IntervaloSinLimpiar_Falla @story-8.197 @ac-1', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/interval.test.js']);
  assert.ok(failed(r, 'leaves the interval alive'), r.out);
  assert.match(message(r, 'leaves the interval alive'), /setInterval\(500 ms\).*src\/Ticker\.js:\d+/);
});

test('T3 Detector_ConsultaSinResponder_Falla @story-8.197 @ac-2 — con la dirección recortada y la línea', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/pending-fetch.test.js']);
  const m = message(r, 'leaves a request without an answer');
  assert.match(m, /fetch https:\/\/api\.example\.test\/items /);
  assert.doesNotMatch(m, /token=secret/, 'la dirección se recorta desde «?»');
  assert.match(m, /src\/Loader\.js:\d+/);
});

test('T4 Detector_LimpiaAlDesmontar_Pasa @story-8.197 @ac-3', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/cleans-up.test.js']);
  assert.strictEqual(one(r, 'clears its interval on unmount').status, 'passed', r.out);
  assert.strictEqual(one(r, 'stops its polling on unmount').status, 'passed', r.out);
});

test('T5 Detector_ConsultaCancelada_NoCuenta @story-8.197 @ac-4', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/aborted.test.js']);
  assert.strictEqual(one(r, 'cancels its request on unmount').status, 'passed', r.out);
});

test('T6 Detector_FetchSimulado_LasPruebasVenLoMismo @story-8.197 @ac-5 — con y sin el detector', (t) => {
  if (!needDeps(t)) return;
  const dir = form('screens');
  const con = jest(dir, ['tests/mocked-fetch.test.js']);
  const sin = jest(dir, ['tests/mocked-fetch.test.js'], { detector: false });
  assert.strictEqual(one(sin, 'reads mock.calls and mockResolvedValue').status, 'passed', sin.out);
  assert.strictEqual(one(con, 'reads mock.calls and mockResolvedValue').status, 'passed', con.out);
});

test('T20 Detector_FetchReasignadoSinResponder_Falla @story-8.197 @ac-2 @ac-5 — el jest.fn que pone la prueba', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/reassigned-fetch.test.js']);
  const m = message(r, 'a reassigned jest.fn that never answers');
  assert.match(m, /fetch https:\/\/api\.example\.test\/items/);
  assert.doesNotMatch(m, /mock\.calls|Expected/, 'la prueba ve su llamada: falla sólo por el detector');
});

test('T31 Detector_SpyOnFetch_SigueViendoYRestaura @story-8.197 @ac-5', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/spy.test.js']);
  const m = message(r, 'a spied fetch that never answers');
  assert.match(m, /quedó vivo al terminar/);
  assert.match(m, /fetch https:\/\/api\.example\.test\/items/);
  assert.doesNotMatch(m, /toHaveBeenCalledWith/, 'el espía ve su llamada');
  assert.strictEqual(one(r, 'mockRestore brings back the original').status, 'passed', r.out);
});

test('T7 Detector_TemporizadoresSimulados_Pendiente_Falla @story-8.197 @ac-6', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/fake-timers.test.js']);
  assert.match(message(r, 'leaves a fake timer pending'), /temporizadores simulados pendientes: 1 \(jest\.getTimerCount\(\)\)/);
});

test('T27 Detector_TemporizadoresSimulados_SinPendientes_Pasa @story-8.197 @ac-6', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/fake-timers-ok.test.js']);
  for (const name of ['fake timers without anything pending', 'goes back to real timers at the end',
    'clears them in its own afterEach leaves one for its afterEach', 'the next one starts without pending timers']) {
    assert.strictEqual(one(r, name).status, 'passed', `${name}\n${r.out.slice(-2000)}`);
  }
});

test('T8 Detector_DeTerceros_InformaOrigenYCuenta @story-8.197 @ac-7', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/third-party.test.js']);
  assert.match(message(r, 'a library leaves its own timer'), /setTimeout\(5000 ms\).*de node_modules: toy-lib/);
});

test('T21 Detector_FalsosPositivos_Pasa @story-8.197 @ac-3 — resuelta, rechazada, afterEach propio, vencido, sin sondeo', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/false-positives.test.js']);
  for (const name of ['a request that already answered', 'a request that already failed',
    'an interval its own top-level afterEach clears', 'a timer that already fired', 'a screen without polling']) {
    assert.strictEqual(one(r, name).status, 'passed', `${name}\n${r.out.slice(-2000)}`);
  }
});

test('T22 Detector_FueraDeUnaPrueba_SeInformaAparte @story-8.197 @ac-21 — no se le atribuye a una prueba; en block falla el archivo', (t) => {
  if (!needDeps(t)) return;
  const dir = form('screens');
  const block = jest(dir, ['tests/outside.test.js']);
  assert.strictEqual(one(block, 'a healthy test').status, 'passed', block.out);
  assert.strictEqual(block.files[0].status, 'failed', 'en block el archivo falla');
  assert.match(block.files[0].message, /creado fuera de una prueba/);
  assert.match(block.files[0].message, /tests\/outside\.test\.js:\d+/);
  const warn = jest(dir, ['tests/outside.test.js'], { mode: 'warn' });
  assert.strictEqual(warn.files[0].status, 'passed', warn.out);
  const outside = warn.records.filter((x) => x.event === 'outside');
  assert.strictEqual(outside.length, 1);
  assert.strictEqual(outside[0].handles.length, 2);
});

test('T10 Detector_SinTestingLibrary_MiraYLoDice @story-8.197 @ac-9', (t) => {
  if (!needDeps(t)) return;
  const into = tmp('no-rtl');
  const modules = path.join(into, 'modules');
  fs.mkdirSync(modules);
  for (const e of fs.readdirSync(deps().modules)) {
    if (e !== '@testing-library') fs.symlinkSync(path.join(deps().modules, e), path.join(modules, e));
  }
  const dir = handForm(into, 'plain', {
    'jest.config.js': "module.exports = { testEnvironment: 'jsdom' };",
    'a.test.js': "test('one', () => { setInterval(() => {}, 1000); });\ntest('two', () => {});",
    'b.test.js': "test('three', () => {});",
  }, { modules });
  const r = jest(dir, ['a.test.js', 'b.test.js'], { formName: 'plain' });
  assert.ok(failed(r, 'one'), r.out);
  assert.strictEqual(r.records.filter((x) => x.event === 'no-testing-library').length, 2, 'una línea por archivo, no por prueba');
});

test('T30 Detector_ErrorPropio_EnWarnNoRompeLaPrueba @story-8.197 @ac-23', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/internal-error.test.js'], { mode: 'warn' });
  assert.strictEqual(one(r, 'the detector breaks inside').status, 'passed', r.out);
  const err = r.records.filter((x) => x.event === 'internal-error');
  assert.ok(err.length >= 1, `anotó el error interno: ${JSON.stringify(r.records)}`);
});

// ---------------------------------------------------------------- lo que confirmó el pase adversarial

test('T32 Detector_FetchBorradoOReDefinido_SigueViendo @story-8.197 @ac-2 @ac-5 — delete en afterEach y defineProperty', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/fetch-deleted.test.js']);
  assert.strictEqual(one(r, 'assigns a fetch that answers').status, 'passed', r.out);
  assert.match(message(r, 'after the delete, a fetch that never answers'), /fetch https:\/\/api\.example\.test\/never/);
  assert.match(message(r, 'defineProperty with a fetch that never answers'), /fetch https:\/\/api\.example\.test\/defined/);
});

test('T33 Detector_TemporizadoresLegacy_VuelveARealesYSigueViendo @story-8.197 @ac-1 @ac-6', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/legacy-timers.test.js']);
  assert.strictEqual(one(r, 'legacy fake timers and back to the real ones').status, 'passed', r.out);
  assert.match(message(r, 'a real timer after that'), /setTimeout\(60000 ms\) tests\/legacy-timers\.test\.js:\d+/);
});

test('T34 Detector_ArchivoConSuEntorno_LoDiceYFrena @story-8.197 @ac-8 @ac-11 — @jest-environment en la cabecera', (t) => {
  if (!needDeps(t)) return;
  const dir = form('screens');
  const r = jest(dir, ['tests/own-environment.test.js', 'tests/polling.test.js']);
  const rec = r.records.filter((x) => x.event === 'no-detector-file');
  assert.strictEqual(rec.length, 1, JSON.stringify(r.records));
  assert.strictEqual(rec[0].file, 'tests/own-environment.test.js');
  const rep = report(['--results', path.dirname(dir), '--forms', 'screens', '--mode', 'block']);
  assert.strictEqual(rep.status, 1, rep.out);
  assert.match(rep.out, /type=error\]screens: tests\/own-environment\.test\.js — sin el detector/);
});

test('T35 Config_PresetConEntorno_UsaElDelPreset @story-8.197 @ac-8', (t) => {
  if (!needDeps(t)) return;
  const dir = handForm(tmp('preset'), 'with-preset', {
    'jest.config.js': "module.exports = { preset: './preset/jest-preset.js' };",
    'preset/jest-preset.js': "module.exports = { testEnvironment: 'jsdom' };",
    'dom.test.js': "test('dom', () => { expect(typeof document).toBe('object'); });",
  });
  assert.match(loadConfig(dir).base, /jest-environment-jsdom/);
  const r = jest(dir, ['dom.test.js'], { formName: 'with-preset' });
  assert.strictEqual(one(r, 'dom').status, 'passed', r.out.slice(-2000));
});

test('T36 Detector_RequestConSignalCancelado_NoCuenta @story-8.197 @ac-4', (t) => {
  if (!needDeps(t)) return;
  const r = jest(form('screens'), ['tests/request-signal.test.js']);
  assert.strictEqual(one(r, 'a request cancelled through its own signal').status, 'passed', r.out);
});

test('T37 Detector_EntornoNode_ClearTimeoutConNumero_NoCuenta @story-8.197 @ac-3', (t) => {
  if (!needDeps(t)) return;
  const dir = handForm(tmp('node-env'), 'node-env', {
    'jest.config.js': "module.exports = { testEnvironment: 'node' };",
    'n.test.js': "test('clears by its number', () => { const t = setTimeout(() => {}, 1000); clearTimeout(Number(t)); });",
  });
  const r = jest(dir, ['n.test.js'], { formName: 'node-env' });
  assert.strictEqual(one(r, 'clears by its number').status, 'passed', r.out);
});

test('T38 Declared_ListaMalFormadaOFechaImposible_LoDice @story-8.197 @ac-14', () => {
  const declared = require(path.join(SETUP_DIR, 'declared.js'));
  const dir = tmp('declared');
  const f = path.join(dir, 'pending-live-handles.json');
  fs.writeFileSync(f, JSON.stringify([{ form: 'a' }]));
  assert.match(declared.read(f).error, /tiene que ser \{ "entries"/);
  fs.writeFileSync(f, JSON.stringify({ entry: [] }));
  assert.match(declared.read(f).error, /tiene que ser/);
  const st = declared.status({ form: 'a', file: 'b', test: 'c', reason: 'd', expires: '2026-02-30' }, '2026-01-01');
  assert.strictEqual(st.state, 'malformed');
  assert.strictEqual(declared.today({ LIVE_HANDLES_TODAY: '2026-13-01' }).length, 10);
  assert.notStrictEqual(declared.today({ LIVE_HANDLES_TODAY: '2026-13-01' }), '2026-13-01');
});

test('T39 Report_FechaDeLaEjecucion_LaQueUsoJest @story-8.197 @ac-13 @ac-14 — el informe no cambia de día', () => {
  const repo = tmp('repo-date');
  fs.mkdirSync(path.join(repo, 'screens', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'screens', 'tests', 'a.test.js'), '');
  const declaredPath = path.join(repo, 'pending-live-handles.json');
  fs.writeFileSync(declaredPath, JSON.stringify({ entries: [
    { form: 'screens', file: 'tests/a.test.js', test: 'x', reason: 'r', expires: '2029-12-31' },
  ] }));
  const dir = results({ screens: [{ ...START, file: 'tests/a.test.js', today: '2030-01-01' }, LOOKED(1)] });
  const r = report(['--repo', repo, '--results', dir, '--forms', 'screens', '--mode', 'block', '--declared', declaredPath]);
  assert.match(r.out, /tests\/a\.test\.js › x: vencida/);
});

test('T40 Report_AnotacionIlegible_NoEsLimpio @story-8.197 @ac-10', () => {
  const dir = tmp('results-bad');
  fs.writeFileSync(path.join(dir, 'screens-live-handles.jsonl'), `${JSON.stringify(START)}\n{"event":"test","fi\n${JSON.stringify(LOOKED(2))}\n`);
  const r = report(['--results', dir, '--forms', 'screens', '--mode', 'block']);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /screens: 1 anotación\(es\) ilegibles/);
  assert.doesNotMatch(r.out, /ninguna con algo vivo/);
});

// ---------------------------------------------------------------- las excepciones

function declaredFile(dir, entries) {
  const f = path.join(dir, '..', 'pending-live-handles.json');
  fs.writeFileSync(f, JSON.stringify({ entries }));
  return f;
}
const entry = (o) => ({ form: 'screens', file: 'tests/exceptions/a.test.js', reason: 'una biblioteca de terceros', expires: '2099-01-01', ...o });

test('T14 Detector_Excepciones_VigenteVencidaSinMotivoSinVence @story-8.197 @ac-13 @ac-14 — por archivo y nombre completo', (t) => {
  if (!needDeps(t)) return;
  const dir = form('screens');
  const declared = declaredFile(dir, [
    entry({ test: 'current' }),
    entry({ test: 'expired', expires: '2000-01-01' }),
    entry({ test: 'without reason', reason: '' }),
    entry({ test: 'without expires', expires: undefined }),
  ]);
  const r = jest(dir, ['tests/exceptions'], { declared });
  assert.strictEqual(r.tests['tests/exceptions/a.test.js › current'].status, 'passed', r.out);
  assert.strictEqual(r.tests['tests/exceptions/b.test.js › current'].status, 'failed', 'el mismo nombre en otro archivo no está amparado');
  for (const name of ['expired', 'without reason', 'without expires']) assert.ok(failed(r, name), name);
  assert.ok(r.records.some((x) => x.event === 'test' && x.test === 'current' && x.excused), 'la amparada queda anotada como excepción');
});

test('T23 Detector_Excepciones_MismoArchivoEnOtroFormulario_NoAmpara @story-8.197 @ac-13', (t) => {
  if (!needDeps(t)) return;
  const into = tmp('two-forms');
  const a = form('screens', { into });
  const b = form('screens', { into, as: 'screens-copy' });
  const declared = declaredFile(a, [entry({ test: 'current' })]);
  const ra = jest(a, ['tests/exceptions/a.test.js'], { declared });
  const rb = jest(b, ['tests/exceptions/a.test.js'], { declared });
  assert.strictEqual(one(ra, 'current').status, 'passed', ra.out);
  assert.strictEqual(one(rb, 'current').status, 'failed', 'en el otro formulario la excepción no ampara');
});

test('T26 Excepciones_VenceHoy_DetectorEInformeCoinciden @story-8.197 @ac-13 @ac-14', (t) => {
  if (!needDeps(t)) return;
  const dir = form('screens');
  const declared = declaredFile(dir, [
    entry({ file: 'tests/exceptions/today.test.js', test: 'expires today', expires: '2026-11-05' }),
    entry({ file: 'tests/exceptions/today.test.js', test: 'expired yesterday', expires: '2026-11-04' }),
  ]);
  const r = jest(dir, ['tests/exceptions/today.test.js'], { declared, today: '2026-11-05' });
  assert.strictEqual(one(r, 'expires today').status, 'passed', r.out);
  assert.strictEqual(one(r, 'expired yesterday').status, 'failed');
  const rep = report(['--repo', path.dirname(dir), '--results', path.dirname(dir), '--forms', 'screens', '--mode', 'block',
    '--declared', declared, '--today', '2026-11-05']);
  assert.match(rep.out, /expires today.*vigente/);
  assert.match(rep.out, /expired yesterday.*vencida/);
});

// ---------------------------------------------------------------- la configuración

const CONFIG_FORMS = {
  'cfg-js': { 'jest.config.js': "module.exports = { setupFilesAfterEnv: ['<rootDir>/own-setup.js'] };" },
  'cfg-cjs': { 'jest.config.cjs': "module.exports = { setupFilesAfterEnv: ['<rootDir>/own-setup.js'] };", 'package.json': JSON.stringify({ name: 'cfg-cjs', type: 'module' }) },
  'cfg-mjs': { 'jest.config.mjs': "export default { setupFilesAfterEnv: ['<rootDir>/own-setup.js'] };" },
  'cfg-ts': { 'jest.config.ts': "const config: { setupFilesAfterEnv: string[] } = { setupFilesAfterEnv: ['<rootDir>/own-setup.js'] };\nexport default config;" },
  'cfg-json': { 'jest.config.json': JSON.stringify({ setupFilesAfterEnv: ['<rootDir>/own-setup.js'] }) },
  'cfg-pkg': { 'package.json': JSON.stringify({ name: 'cfg-pkg', jest: { setupFilesAfterEnv: ['<rootDir>/own-setup.js'] } }) },
};
const OWN_SETUP = 'globalThis.__ownSetupSawDetector = !!globalThis.__tyconLiveHandles;';
const ORDER_TEST = "test('order', () => { expect(globalThis.__ownSetupSawDetector).toBe(false); expect(globalThis.__tyconLiveHandles).toBeDefined(); });";

const hashTree = (dir) => {
  const h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(dir).sort()) {
    if (f === 'node_modules') continue;
    const p = path.join(dir, f);
    h.update(f);
    h.update(fs.statSync(p).isDirectory() ? hashTree(p) : fs.readFileSync(p));
  }
  return h.digest('hex');
};

function loadConfig(dir) {
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(CONFIG)})().then((c) => process.stdout.write(JSON.stringify({ c, base: process.env.LIVE_HANDLES_BASE_ENV })), (e) => { console.error(e.stack); process.exit(1); })`],
    { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('T9 Config_UsaLaDelFormularioMasElDetector @story-8.197 @ac-8 — las seis formas, rootDir y entorno propios', (t) => {
  if (!needDeps(t)) return;
  const into = tmp('configs');
  for (const [name, files] of Object.entries(CONFIG_FORMS)) {
    const dir = handForm(into, name, { 'own-setup.js': OWN_SETUP, 'order.test.js': ORDER_TEST, ...files });
    const before = hashTree(dir);
    const { c } = loadConfig(dir);
    assert.strictEqual(fs.realpathSync(c.rootDir), dir, `${name}: rootDir`);
    assert.strictEqual(c.setupFilesAfterEnv[c.setupFilesAfterEnv.length - 1], path.join(SETUP_DIR, 'live-handles.js'), `${name}: el detector va al final`);
    const r = jest(dir, ['order.test.js'], { formName: name });
    assert.strictEqual(one(r, 'order').status, 'passed', `${name}\n${r.out.slice(-2000)}`);
    assert.strictEqual(hashTree(dir), before, `${name}: nada del formulario cambia`);
  }
  const own = handForm(into, 'cfg-rootdir', {
    'jest.config.js': "module.exports = { rootDir: 'src', testEnvironment: 'jsdom' };",
    'src/dom.test.js': "test('dom', () => { expect(typeof document).toBe('object'); });",
  });
  const { c, base } = loadConfig(own);
  assert.strictEqual(fs.realpathSync(c.rootDir), path.join(own, 'src'));
  assert.match(base, /jest-environment-jsdom/);
  const r = jest(own, ['src/dom.test.js'], { formName: 'cfg-rootdir' });
  assert.strictEqual(one(r, 'dom').status, 'passed', r.out.slice(-2000));
});

test('T17 Config_NoSeCarga_CorreSinDetectorYLoDice @story-8.197 @ac-8 — --probe falla y lo anota', (t) => {
  if (!needDeps(t)) return;
  const into = tmp('broken');
  const dir = handForm(into, 'broken', { 'jest.config.js': "throw new Error('configuración rota');" });
  const out = path.join(into, 'broken-live-handles.jsonl');
  const r = spawnSync(process.execPath, [CONFIG, '--probe'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, LIVE_HANDLES_OUT: out } });
  assert.notStrictEqual(r.status, 0);
  const rec = records(out).filter((x) => x.event === 'no-detector');
  assert.strictEqual(rec.length, 1);
  assert.match(rec[0].reason, /configuración rota/);
  const ok = handForm(into, 'fine', { 'jest.config.js': 'module.exports = {};' });
  assert.strictEqual(spawnSync(process.execPath, [CONFIG, '--probe'], { cwd: ok, env: { PATH: process.env.PATH } }).status, 0);
});

// ---------------------------------------------------------------- el informe

function results(forms) {
  const dir = tmp('results');
  for (const [f, recs] of Object.entries(forms)) {
    if (recs) fs.writeFileSync(path.join(dir, `${f}-live-handles.jsonl`), recs.map((x) => JSON.stringify(x)).join('\n') + '\n');
  }
  return dir;
}
const START = { event: 'file', file: 'tests/a.test.js' };
const LOOKED = (n) => ({ event: 'looked', file: 'tests/a.test.js', count: n, tests: [] });
const FLAGGED = { event: 'test', file: 'tests/a.test.js', test: 'leaves the polling alive', excused: false,
  handles: [{ kind: 'setTimeout', ms: 1000, where: 'src/Polling.js:12' }] };

test('T11 Report_ModoWarn_NoFallaEInforma @story-8.197 @ac-10 — sale 0 y nombra la prueba, por formulario', () => {
  const dir = results({ screens: [START, FLAGGED, LOOKED(2)], other: [START, LOOKED(3)] });
  const r = report(['--results', dir, '--forms', 'screens other', '--mode', 'warn', '--review', '2099-01-01']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /screens: 1 prueba\(s\) con algo vivo/);
  assert.match(r.out, /leaves the polling alive.*setTimeout\(1000 ms\) src\/Polling\.js:12/);
  assert.match(r.out, /other: miró 3 prueba\(s\), ninguna con algo vivo/);
});

test('T13 Report_WarnSinFechaRojo_VencidaAmarillo @story-8.197 @ac-12', () => {
  const dir = results({ screens: [START, LOOKED(1)] });
  const sinFecha = report(['--results', dir, '--forms', 'screens', '--mode', 'warn', '--review', '']);
  assert.strictEqual(sinFecha.status, 2, sinFecha.out);
  assert.match(sinFecha.out, /sin fecha/);
  const vencida = report(['--results', dir, '--forms', 'screens', '--mode', 'warn', '--review', '2000-01-01', '--today', '2026-11-05']);
  assert.strictEqual(vencida.status, 0, vencida.out);
  assert.match(vencida.out, /##vso\[task\.complete result=SucceededWithIssues;\]/);
  assert.match(vencida.out, /venció la revisión del modo aviso el 2000-01-01/);
});

test('T19 Report_NoMedidoYNoMirado @story-8.197 @ac-8 @ac-10 — nunca «0» de lo que no miró', () => {
  const dir = results({
    probed: null,
    skipped: [{ event: 'not-looked', reason: 'sin configuración de jest' }],
    broken: [{ event: 'no-detector', reason: 'configuración rota' }],
    clean: [START, LOOKED(4)],
  });
  const r = report(['--results', dir, '--forms', 'probed skipped broken clean', '--mode', 'warn', '--review', '2099-01-01']);
  assert.match(r.out, /probed: no medido/);
  assert.doesNotMatch(r.out, /probed: (miró|0)/);
  assert.match(r.out, /skipped: no mirado — sin configuración de jest/);
  assert.match(r.out, /broken: sin el detector — configuración rota/);
  assert.match(r.out, /clean: miró 4 prueba\(s\), ninguna con algo vivo/);
});

test('T29 Report_ModoBlock_SinDetectorONoMedido_Rojo @story-8.197 @ac-11 — en block el control no se apaga callado', () => {
  const dir = results({
    a: [{ event: 'no-detector', reason: 'configuración rota' }],
    b: null,
    c: [{ event: 'not-looked', reason: 'sin node_modules' }],
    d: [{ event: 'not-looked', reason: 'sin configuración de jest' }],
    e: [START, LOOKED(2), { event: 'internal-error', message: 'x' }],
  });
  const r = report(['--results', dir, '--forms', 'a b c d e', '--mode', 'block']);
  assert.strictEqual(r.status, 1, r.out);
  for (const f of ['a', 'b', 'c', 'e']) assert.match(r.out, new RegExp(`type=error\\]${f}: `), f);
  assert.match(r.out, /type=warning\]d: no mirado/);
});

test('T24 Report_Excepciones_NoExisteYNoSeVio @story-8.197 @ac-14 — ninguna ampara', () => {
  const repo = tmp('repo');
  fs.mkdirSync(path.join(repo, 'screens', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'screens', 'tests', 'a.test.js'), '');
  const declared = path.join(repo, 'pending-live-handles.json');
  fs.writeFileSync(declared, JSON.stringify({ entries: [
    { form: 'screens', file: 'tests/nope.test.js', test: 'x', reason: 'r', expires: '2099-01-01' },
    { form: 'screens', file: 'tests/a.test.js', test: 'ghost', reason: 'r', expires: '2099-01-01' },
    { form: 'screens', file: 'tests/a.test.js', test: 'no reason', expires: '2099-01-01' },
  ] }));
  const dir = results({ screens: [START, { event: 'looked', file: 'tests/a.test.js', count: 1, tests: ['real one'] }] });
  const r = report(['--repo', repo, '--results', dir, '--forms', 'screens', '--mode', 'block', '--declared', declared]);
  assert.match(r.out, /tests\/nope\.test\.js › x: no existe/);
  assert.match(r.out, /tests\/a\.test\.js › ghost: no se vio en esta ejecución/);
  assert.match(r.out, /tests\/a\.test\.js › no reason: no ampara — falta reason/);
});

// ---------------------------------------------------------------- la plantilla y el paso real

test('T16 Plantilla_TraerArnesPublicaTestSetupYLaPruebaLoUsa @story-8.197 @ac-8 @ac-15', (t) => {
  assert.ok(fs.existsSync(CONFIG) && fs.existsSync(REPORT), 'test-setup vive en scripts/ci, que TraerArnes publica');
  if (!needTemplate(t)) return;
  const y = fs.readFileSync(TEMPLATE, 'utf8');
  const fetchStage = y.slice(y.indexOf('- stage: TraerArnes'), y.indexOf('- stage: HarnessGate'));
  assert.match(fetchStage, /targetPath: '\$\(Agent\.BuildDirectory\)\/tcg\/scripts\/ci'/);
  const run = stepScript(y, 'Run tests with coverage');
  assert.match(run, /arnes-ci\/test-setup/);
  const rep = y.slice(y.indexOf("displayName: 'Live handles report'") - 300);
  assert.match(rep, /condition: and\(eq\(variables\['DetectForms\.hasTests'\], 'true'\), in\(variables\['liveHandlesMode'\], 'warn', 'block'\)\)/);
  assert.ok(y.indexOf("displayName: 'Live handles report'") < y.indexOf("displayName: 'Verdict"), 'el informe va antes de Verdict');
});

test('T15 Pipeline_ModoOffOSinVariable_ComoHoy @story-8.197 @ac-15 — de fábrica off', (t) => {
  if (!needTemplate(t)) return;
  const y = fs.readFileSync(TEMPLATE, 'utf8');
  assert.match(y, /- name: liveHandlesMode\n\s+value: 'off'/);
  const run = stepScript(y, 'Run tests with coverage');
  assert.match(run, /case "\$\{LIVE_HANDLES_MODE_VAR:-\}" in\s*\n\s*warn\|block\)/);
});

test('T25 Plantilla_ListaEnLosFiltrosDelDisparo @story-8.197 @ac-22', (t) => {
  if (!needTemplate(t)) return;
  const y = fs.readFileSync(TEMPLATE, 'utf8');
  const trigger = y.slice(y.indexOf('trigger:'), y.indexOf('\npr:'));
  const pr = y.slice(y.indexOf('\npr:'), y.indexOf('\nparameters:') > 0 ? y.indexOf('\nparameters:') : y.indexOf('\nvariables:'));
  assert.match(trigger, /- 'pending-live-handles\.json'/);
  assert.match(pr, /- 'pending-live-handles\.json'/);
});

/** Corre el guion real de «Run tests with coverage» en un repo de juguete. */
function runTestStep(repo, forms, mode) {
  const y = fs.readFileSync(TEMPLATE, 'utf8');
  const agentTmp = tmp('agent');
  fs.symlinkSync(path.join(ROOT, 'scripts', 'ci'), path.join(agentTmp, 'arnes-ci'), 'dir');
  const bin = path.join(agentTmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\n[ "$1" = jest ] && shift\nexec "${process.execPath}" "${deps().jest}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  fs.chmodSync(path.join(bin, 'npx'), 0o755);
  const script = stepScript(y, 'Run tests with coverage')
    .replaceAll('$(DetectForms.formsToTest)', forms.join(' '))
    .replaceAll('$(Agent.TempDirectory)', agentTmp);
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME, TMPDIR: os.tmpdir() };
  if (mode !== undefined) env.LIVE_HANDLES_MODE_VAR = mode;
  return spawnSync('bash', ['-c', script], { cwd: repo, encoding: 'utf8', env, timeout: 300000 });
}

test('T18 Pipeline_PasoReal_ExportaProbeYCorre @story-8.197 @ac-8 @ac-10 @ac-15 @ac-22 — el guion de la plantilla, de verdad', (t) => {
  if (!needDeps(t) || !needTemplate(t)) return;
  const repo = tmp('step-repo');
  form('screens', { into: repo, as: 'good' });
  handForm(repo, 'broken', { 'jest.config.js': "throw new Error('configuración rota');", 'x.test.js': "test('x', () => {});" });
  handForm(repo, 'noconfig', { 'x.test.js': "test('x', () => {});" });
  const r = runTestStep(repo, ['good', 'broken', 'noconfig'], 'warn');
  const out = (f) => records(path.join(repo, 'test-results', `${f}-live-handles.jsonl`));
  assert.ok(out('good').some((x) => x.event === 'test' && x.test === 'leaves the polling alive'), `${r.stdout}\n${r.stderr}`);
  assert.ok(out('good').some((x) => x.event === 'file'), 'el bueno corrió con el detector');
  assert.ok(out('broken').some((x) => x.event === 'no-detector'), 'el roto corre sin --config y lo anota');
  assert.ok(out('noconfig').some((x) => x.event === 'not-looked' && /configuración de jest/.test(x.reason)), 'el saltado: no mirado');
  assert.ok(fs.existsSync(path.join(repo, 'test-results', 'good-results.xml')), 'jest-junit escribió el junit');

  const off = tmp('step-off');
  form('screens', { into: off, as: 'good' });
  runTestStep(off, ['good'], undefined);
  assert.deepStrictEqual(records(path.join(off, 'test-results', 'good-live-handles.jsonl')), [], 'sin la variable: como hoy, sin el detector');
  assert.ok(fs.existsSync(path.join(off, 'test-results', 'good-results.xml')), 'las pruebas corrieron igual');
});

test('T12 Report_ModoBlock_Falla @story-8.197 @ac-11 — rojo en el junit, y el «Verdict» real lo juzga', (t) => {
  if (!needDeps(t) || !needTemplate(t)) return;
  const repo = tmp('verdict-repo');
  form('screens', { into: repo, as: 'good' });
  fs.unlinkSync(path.join(repo, 'good', 'tests', 'outside.test.js'));
  for (const f of fs.readdirSync(path.join(repo, 'good', 'tests'))) {
    if (f !== 'polling.test.js' && f.endsWith('.test.js')) fs.unlinkSync(path.join(repo, 'good', 'tests', f));
  }
  fs.rmSync(path.join(repo, 'good', 'tests', 'exceptions'), { recursive: true });
  runTestStep(repo, ['good'], 'block');
  const xml = fs.readFileSync(path.join(repo, 'test-results', 'good-results.xml'), 'utf8');
  assert.match(xml, /failures="1"/);
  const y = fs.readFileSync(TEMPLATE, 'utf8');
  const verdict = stepScript(y, 'Verdict (0 tests = red, unless declared debt)')
    .replaceAll('$(DetectForms.hasTests)', 'true').replaceAll('$(Build.Reason)', 'PullRequest').replaceAll('$(DetectForms.formsToTest)', 'good');
  // La deuda declarada vacía, con el nombre que lee el veredicto de la plantilla.
  const debt = verdict.match(/\[ ! -f ([\w.-]+\.json) \]/)[1];
  fs.writeFileSync(path.join(repo, debt), JSON.stringify({ sin_pruebas: [], con_pruebas_en_rojo: [] }));
  const v = spawnSync('bash', ['-c', verdict], { cwd: repo, encoding: 'utf8' });
  assert.strictEqual(v.status, 1, v.stdout + v.stderr);
  assert.match(v.stdout, /good: 1 pruebas en rojo/);
});
