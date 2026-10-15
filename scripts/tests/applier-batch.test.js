'use strict';
/**
 * applier-batch.test.js — la tanda del aplicador: varios pasos de Node en un solo proceso, cada uno con la misma
 * respuesta que su llamada suelta (story 8.36 · AC 1-3 · T1-T3).
 *
 * EL CASO (2026-10-14). El aplicador de Windows (`install-tycon-hooks.ps1`) corre en cada arranque de sesión y lanzaba
 * ~16 procesos de Node; en Windows cada uno cuesta ~50-100 ms sólo en lanzarse desde PowerShell. La tanda
 * (`scripts/setup/applier-batch.js`) corre varios de esos pasos en un solo proceso. Lo que no puede pasar: que un paso
 * conteste distinto que su llamada suelta. Si contesta distinto, el aplicador hace otra cosa.
 *
 * Cómo mide:
 *   · T1: cada paso de la lista cerrada, en una HOME de juguete con cada estado que el aplicador conoce, corrido suelto
 *     (`node <guion> <args>`) y en la tanda, sobre dos copias iguales de la HOME: mismo código, misma salida, misma
 *     salida de error (con la HOME escrita como <HOME>), y lo que dejan en el disco, igual. También todos juntos, en el
 *     orden en que los corre el aplicador.
 *   · T2: la mecánica, en el mismo proceso con una lista de pasos de prueba: un paso que tira y uno que llama a
 *     `process.exit(3)` cuentan como un Node caído, el siguiente corre, y las variables puestas para un paso vuelven.
 *   · T3: un paso fuera de la lista: la tanda sale 2 y no corre ninguno (ni escribe su resultado).
 *
 * Correr: node --test scripts/tests/applier-batch.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BATCH = path.join(ROOT, 'scripts', 'setup', 'applier-batch.js');
const SCRIPTS = {
  'skills-dir': path.join(ROOT, 'scripts', 'lib', 'skills-dir.js'),
  'tycon-config': path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'),
  'legacy-names': path.join(ROOT, 'scripts', 'lib', 'legacy-names.js'),
  'apply-hooks': path.join(ROOT, 'scripts', 'setup', 'apply-hooks.js'),
  // tanda B (story 8.36, Task 6): los enlaces y el paso de terceros
  'canonical-path': path.join(ROOT, 'scripts', 'lib', 'canonical-path.js'),
  'install-third-party': path.join(ROOT, 'scripts', 'publishing', 'install-third-party.js'),
};

const labs = [];
test.after(() => { for (const d of labs) fs.rmSync(d, { recursive: true, force: true }); });

/** Una carpeta de laboratorio nueva (con la ruta real: en macOS /tmp es un enlace). */
function lab(name) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `applier-batch-${name}-`)));
  labs.push(d);
  return d;
}

/** Una HOME de juguete armada por `setup(home)`, en dos copias iguales: una para la llamada suelta, otra para la tanda. */
function twoHomes(name, setup) {
  const base = lab(name);
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  for (const h of [a, b]) { fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); setup(h); }
  return [a, b];
}

/** El ambiente de una corrida: sólo lo necesario, con la HOME de juguete (nada del ambiente de quien corre la prueba). */
function envFor(home, extra = {}) {
  return Object.assign({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: os.tmpdir(), LANG: process.env.LANG || 'en_US.UTF-8' }, extra);
}

/** La llamada suelta: `node <guion> <args>`, con el ambiente del paso aplicado. */
function separate(step, home) {
  const env = envFor(home);
  for (const [k, v] of Object.entries(step.env || {})) { if (v === null) delete env[k]; else env[k] = v; }
  const r = spawnSync(process.execPath, [SCRIPTS[step.script], ...step.args.map((x) => x.split('<HOME>').join(home))], { cwd: home, env, encoding: 'utf8' });
  return { rc: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** La tanda: un plan con los pasos, su resultado leído del archivo `--out`. */
function batch(steps, home, { extraArgs = [] } = {}) {
  const dir = lab('plan');
  const plan = path.join(dir, 'plan.json');
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(plan, JSON.stringify({ steps: steps.map((s, i) => ({ id: s.id || `p${i}`, script: s.script, args: s.args.map((x) => x.split('<HOME>').join(home)), env: s.env || {} })) }));
  const r = spawnSync(process.execPath, [BATCH, '--plan', plan, '--out', out, ...extraArgs], { cwd: home, env: envFor(home), encoding: 'utf8' });
  let res = null;
  try { res = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (_) { res = null; }
  return { rc: r.status, stdout: r.stdout, stderr: r.stderr, res, outExists: fs.existsSync(out) };
}

/** Lo que cambia sólo por la carpeta: la HOME escrita como <HOME>, y el sello de hora de un respaldo. */
function norm(s, home) {
  return String(s == null ? '' : s).split(home).join('<HOME>').replace(/(\.bak[.-][A-Za-z-]*)\d[\dT:.Z-]*/g, '$1<SELLO>');
}

/** Lo que quedó en la HOME: cada archivo con su contenido normalizado (los respaldos, por su nombre). */
function snapshot(home) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const p = path.join(d, e.name);
      const rel = norm(path.relative(home, p), home);
      if (e.isSymbolicLink()) out[rel] = `(enlace) → ${norm(fs.readlinkSync(p), home)}`;   // los enlaces del lugar: a dónde apuntan
      else if (e.isDirectory()) walk(p);
      else out[rel] = /\.bak/.test(e.name) ? '(respaldo)' : norm(fs.readFileSync(p, 'utf8'), home);
    }
  };
  walk(home);
  return out;
}

function assertSame(step, a, b, label) {
  const s = separate(step, a);
  const t = batch([step], b);
  assert.strictEqual(t.rc, 0, `${label}: la tanda salió ${t.rc}: ${t.stderr}`);
  const got = t.res && t.res.steps && t.res.steps[step.id || 'p0'];
  assert.ok(got, `${label}: la tanda no trajo el resultado del paso`);
  assert.strictEqual(got.rc, s.rc, `${label}: código (suelto ${s.rc}, tanda ${got.rc}) — tanda dijo: ${got.stderr}`);
  assert.strictEqual(norm(got.stdout, b), norm(s.stdout, a), `${label}: salida distinta`);
  assert.strictEqual(norm(got.stderr, b), norm(s.stderr, a), `${label}: salida de error distinta`);
  assert.deepStrictEqual(snapshot(b), snapshot(a), `${label}: lo que quedó en la HOME es distinto`);
  return { s, got };
}

// ── los estados ─────────────────────────────────────────────────────────────────────────────────────────────────
const sane = () => {};
const brokenConfig = (h) => fs.writeFileSync(path.join(h, '.claude', 'tycon.json'), '{ esto no es JSON');
const minimalProfile = (h) => fs.writeFileSync(path.join(h, '.claude', 'tycon.json'), JSON.stringify({ install: { profile: 'minimal' } }));
const installedSkills = (h) => { fs.mkdirSync(path.join(h, '.claude', 'agent-skills', 'skills', 'tycon-pipeline'), { recursive: true }); };
const emptySettings = (h) => fs.writeFileSync(path.join(h, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n');
const brokenSettings = (h) => fs.writeFileSync(path.join(h, '.claude', 'settings.json'), '{ "hooks": ');
const brokenMap = (h) => fs.writeFileSync(path.join(h, 'renames.json'), '{ roto');

const SKILLS = path.join(ROOT, 'skills');
const applyStep = { script: 'apply-hooks', args: ['--settings', '<HOME>/.claude/settings.json', '--hooks-dir', path.join(ROOT, 'scripts', 'hooks'), '--skills', SKILLS, '--platform', 'windows', '--json-out', '<HOME>/apply.json'] };
const legacyStep = { script: 'legacy-names', args: ['--migrate-machine', '--guides', ROOT, '--skills', ROOT] };

test('T1 Batch_SameAsSeparateCall — cada paso de la lista, en cada estado, igual que su llamada suelta', () => {
  const cases = [
    ['skills-dir --skills, instaladas', installedSkills, { script: 'skills-dir', args: ['--skills', '--installed'], env: { TYCON_SKILLS_DIR: '' } }],
    ['skills-dir --source, instaladas', installedSkills, { script: 'skills-dir', args: ['--source', '--installed'], env: { TYCON_SKILLS_DIR: '' } }],
    ['skills-dir --skills, sin instalar (el propio clon)', sane, { script: 'skills-dir', args: ['--skills', '--installed'], env: { TYCON_SKILLS_DIR: '' } }],
    ['skills-dir --skills, la carpeta no existe', sane, { script: 'skills-dir', args: ['--skills', '--installed'], env: { TYCON_SKILLS_DIR: '<HOME>/no-existe' } }],
    ['skills-dir sin qué pedir (uso)', sane, { script: 'skills-dir', args: [] }],
    ['tycon-config integrations --json, sana', sane, { script: 'tycon-config', args: ['integrations', '--json'] }],
    ['tycon-config integrations --json, rota', brokenConfig, { script: 'tycon-config', args: ['integrations', '--json'] }],
    ['tycon-config get install.profile, sin valor', sane, { script: 'tycon-config', args: ['get', 'install.profile'] }],
    ['tycon-config get install.profile, minimal', minimalProfile, { script: 'tycon-config', args: ['get', 'install.profile'] }],
    ['tycon-config get install.profile, rota', brokenConfig, { script: 'tycon-config', args: ['get', 'install.profile'] }],
    ['tycon-config get de una clave mal escrita (uso)', sane, { script: 'tycon-config', args: ['get', 'NoEsClave'] }],
    ['legacy-names --migrate-machine, sin mapa', emptySettings, legacyStep],
    ['legacy-names --migrate-machine, mapa ilegible', (h) => { emptySettings(h); brokenMap(h); }, { script: 'legacy-names', args: [...legacyStep.args, '--map', '<HOME>/renames.json'] }],
    ['legacy-names, opción desconocida', sane, { script: 'legacy-names', args: ['--does-not-exist'] }],
    ['apply-hooks, settings.json vacío', emptySettings, applyStep],
    ['apply-hooks, settings.json vacío y configuración rota', (h) => { emptySettings(h); brokenConfig(h); }, applyStep],
    ['apply-hooks, perfil minimal', (h) => { emptySettings(h); minimalProfile(h); }, applyStep],
    ['apply-hooks, settings.json roto', brokenSettings, applyStep],
    ['apply-hooks, -Check', emptySettings, { script: 'apply-hooks', args: [...applyStep.args, '--check'] }],
  ];
  for (const [label, setup, step] of cases) {
    const [a, b] = twoHomes('t1', setup);
    assertSame(step, a, b, label);
  }
});

test('T1d Batch_LinkAndThirdPartySteps_SameAsSeparateCall — los enlaces y el paso de terceros (tanda B), en cada estado', () => {
  const PLACE = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'place.js'));
  const placeIn = (h) => path.join(h, '.claude', PLACE.PLACE_NAME);
  const placed = (h) => { fs.symlinkSync(ROOT, placeIn(h), 'dir'); };
  const dangling = (h) => { fs.symlinkSync(path.join(h, 'no-esta'), placeIn(h), 'dir'); };
  const otherClone = (h) => { fs.mkdirSync(path.join(h, 'otro-clon', 'scripts'), { recursive: true }); fs.symlinkSync(path.join(h, 'otro-clon'), placeIn(h), 'dir'); };
  const repoLinked = (h) => { fs.symlinkSync(ROOT, path.join(h, '.claude', 'agent-skills'), 'dir'); };
  const off = { TYCON_THIRD_PARTY: '0' };
  const cases = [
    ['el lugar del arnés, por estrenar', sane, { script: 'canonical-path', args: ['--ensure-link', '--clone', ROOT] }],
    ['el lugar del arnés, ya puesto', placed, { script: 'canonical-path', args: ['--ensure-link', '--clone', ROOT] }],
    ['el lugar del arnés, colgado', dangling, { script: 'canonical-path', args: ['--ensure-link', '--clone', ROOT] }],
    ['el lugar del arnés, con -Check', sane, { script: 'canonical-path', args: ['--ensure-link', '--clone', ROOT, '--check'] }],
    ['el lugar del arnés, con un -Link que no se puede cumplir (sale 2)', sane, { script: 'canonical-path', args: ['--ensure-link', '--clone', ROOT, '--link', '<HOME>/no-esta'] }],
    ['el enlace de agent-skills, por estrenar', placed, { script: 'canonical-path', args: ['--ensure-repo-links', '--clone', ROOT, '--only', 'agent-skills'] }],
    ['el enlace de agent-skills, con -Check', placed, { script: 'canonical-path', args: ['--ensure-repo-links', '--clone', ROOT, '--only', 'agent-skills', '--check'] }],
    ['los enlaces de agents y skills, por estrenar', (h) => { placed(h); repoLinked(h); }, { script: 'canonical-path', args: ['--ensure-repo-links', '--clone', ROOT, '--only', 'entries'] }],
    ['el enlace de agent-skills, ya puesto', (h) => { placed(h); repoLinked(h); }, { script: 'canonical-path', args: ['--ensure-repo-links', '--clone', ROOT, '--only', 'agent-skills'] }],
    ['terceros prendido sobre un clon de juguete', (h) => { placed(h); fs.mkdirSync(path.join(h, 'juguete', 'skills'), { recursive: true }); }, { script: 'install-third-party', args: ['--repo', '<HOME>/juguete'] }],
    ['--only mal escrito (uso)', sane, { script: 'canonical-path', args: ['--ensure-repo-links', '--clone', ROOT, '--only', 'otra-cosa'] }],
    ['el aviso, sin el lugar', sane, { script: 'canonical-path', args: [] }],
    ['el aviso, con el lugar en otro clon', otherClone, { script: 'canonical-path', args: [] }],
    ['las piezas del lugar', placed, { script: 'canonical-path', args: ['--place-pieces', '--home', '<HOME>'] }],
    ['terceros apagado', (h) => { placed(h); repoLinked(h); }, { script: 'install-third-party', args: ['--repo', ROOT], env: off }],
    ['terceros, revisión sin red (-Check)', (h) => { placed(h); repoLinked(h); }, { script: 'install-third-party', args: ['--repo', ROOT, '--check'] }],
    ['terceros, opción desconocida', sane, { script: 'install-third-party', args: ['--no-such-option'] }],
  ];
  for (const [label, setup, step] of cases) {
    const [a, b] = twoHomes('t1d', setup);
    assertSame(step, a, b, label);
  }
});

test('T1b Batch_SameAsSeparateCall_InApplierOrder — la lectura y la aplicación, juntas, como las corre el aplicador', () => {
  const read = [
    { id: 'place', script: 'canonical-path', args: ['--ensure-link', '--clone', ROOT] },
    { id: 'links', script: 'canonical-path', args: ['--ensure-repo-links', '--clone', ROOT, '--only', 'agent-skills'] },
    { id: 'notice', script: 'canonical-path', args: [] },
    { id: 'skills', script: 'skills-dir', args: ['--skills', '--installed'], env: { TYCON_SKILLS_DIR: '' } },
    { id: 'source', script: 'skills-dir', args: ['--source', '--installed'], env: { TYCON_SKILLS_DIR: '' } },
    { id: 'integrations', script: 'tycon-config', args: ['integrations', '--json'] },
    { id: 'profile', script: 'tycon-config', args: ['get', 'install.profile'] },
    { id: 'pieces', script: 'canonical-path', args: ['--place-pieces', '--home', '<HOME>'] },
  ];
  const apply = [
    { id: 'third', script: 'install-third-party', args: ['--repo', ROOT, '--check'] },
    { id: 'entries', script: 'canonical-path', args: ['--ensure-repo-links', '--clone', ROOT, '--only', 'entries'] },
    Object.assign({ id: 'legacy' }, legacyStep), Object.assign({ id: 'apply' }, applyStep),
  ];
  for (const [label, setup] of [['sana', (h) => { installedSkills(h); emptySettings(h); }], ['configuración rota', (h) => { installedSkills(h); emptySettings(h); brokenConfig(h); }]]) {
    const [a, b] = twoHomes('t1b', setup);
    for (const plan of [read, apply]) {
      const want = plan.map((s) => separate(s, a));
      const t = batch(plan, b);
      assert.strictEqual(t.rc, 0, `${label}: la tanda salió ${t.rc}: ${t.stderr}`);
      plan.forEach((s, i) => {
        const got = t.res.steps[s.id];
        assert.strictEqual(got.rc, want[i].rc, `${label} · ${s.id}: código`);
        assert.strictEqual(norm(got.stdout, b), norm(want[i].stdout, a), `${label} · ${s.id}: salida`);
        assert.strictEqual(norm(got.stderr, b), norm(want[i].stderr, a), `${label} · ${s.id}: salida de error`);
      });
    }
    assert.deepStrictEqual(snapshot(b), snapshot(a), `${label}: lo que quedó en la HOME es distinto`);
  }
});

test('T1c Batch_ChunksKeepOrderAcrossChannels — cada trozo con su canal, en el orden en que se escribió', () => {
  const [, b] = twoHomes('t1c', brokenConfig);
  const t = batch([{ id: 'x', script: 'tycon-config', args: ['integrations', '--json'] }, { id: 'y', script: 'skills-dir', args: [] }], b);
  for (const id of ['x', 'y']) {
    const got = t.res.steps[id];
    assert.ok(Array.isArray(got.chunks) && got.chunks.length > 0, `${id}: sin trozos`);
    assert.ok(got.chunks.every((c) => typeof c === 'string' && /^[oe]/.test(c)), `${id}: cada trozo es un texto con su canal en la primera letra`);
    assert.strictEqual(got.chunks.filter((c) => c[0] === 'o').map((c) => c.slice(1)).join(''), got.stdout, `${id}: la salida no es la suma de sus trozos`);
    assert.strictEqual(got.chunks.filter((c) => c[0] === 'e').map((c) => c.slice(1)).join(''), got.stderr, `${id}: la salida de error no es la suma de sus trozos`);
  }
});

test('T2 Batch_StepThrows_OthersRunEnvRestored — tirar y process.exit cuentan como un Node caído; el resto corre', () => {
  const { runPlan } = require(BATCH);
  const before = process.env.TYCON_SKILLS_DIR;
  process.env.TYCON_SKILLS_DIR = 'valor-de-antes';
  const exitCodeBefore = process.exitCode;
  const seen = [];
  const registry = {
    throws: () => () => { process.stdout.write('antes de tirar\n'); throw new Error('se cayó a propósito'); },
    exits: () => () => { process.stderr.write('saliendo\n'); process.exit(3); },
    exitsZero: () => () => { process.exitCode = 5; process.exit(); },
    sane: () => (argv) => { seen.push(process.env.TYCON_SKILLS_DIR); process.stdout.write(`sano ${argv.join(' ')}\n`); return 0; },
  };
  let res;
  try {
    res = runPlan({ steps: [
      { id: 'a', script: 'throws', args: [], env: { TYCON_SKILLS_DIR: '' } },
      { id: 'b', script: 'exits', args: [], env: { TYCON_SKILLS_DIR: null } },
      { id: 'c', script: 'exitsZero', args: [] },
      { id: 'd', script: 'sane', args: ['uno', 'dos'] },
    ] }, registry);
  } finally {
    var after = process.env.TYCON_SKILLS_DIR;
    var exitCodeAfter = process.exitCode;
    if (before === undefined) delete process.env.TYCON_SKILLS_DIR; else process.env.TYCON_SKILLS_DIR = before;
    process.exitCode = exitCodeBefore;
  }
  assert.strictEqual(res.steps.a.rc, 1, 'el que tira sale 1');
  assert.match(res.steps.a.stderr, /se cayó a propósito/, 'el que tira deja su mensaje por la salida de error');
  assert.strictEqual(res.steps.a.stdout, 'antes de tirar\n', 'lo que escribió antes de tirar queda');
  assert.strictEqual(res.steps.b.rc, 3, 'process.exit(3) sale 3');
  assert.strictEqual(res.steps.b.stderr, 'saliendo\n');
  assert.strictEqual(res.steps.c.rc, 5, 'process.exit() sin código sale con el process.exitCode que dejó el paso');
  assert.strictEqual(res.steps.d.rc, 0, 'el sano corre después de los caídos');
  assert.strictEqual(res.steps.d.stdout, 'sano uno dos\n');
  assert.deepStrictEqual(seen, ['valor-de-antes'], 'el sano ve la variable como estaba: las de los pasos anteriores volvieron');
  assert.strictEqual(after, 'valor-de-antes', 'la variable vuelve a su valor al terminar');
  assert.strictEqual(exitCodeAfter, exitCodeBefore, 'el process.exitCode de un paso no se queda en la tanda');
});

test('T3 Batch_UnknownStep_Refused — un paso fuera de la lista: sale 2 y no corre ninguno', () => {
  const [, b] = twoHomes('t3', sane);
  const t = batch([applyStep, { script: 'no-esta-en-la-lista', args: [] }], b);
  assert.strictEqual(t.rc, 2, `salió ${t.rc}`);
  assert.match(t.stderr, /no-esta-en-la-lista/, 'nombra el paso');
  assert.strictEqual(t.outExists, false, 'no escribe el resultado');
  assert.strictEqual(fs.existsSync(path.join(b, '.claude', 'settings.json')), false, 'no corrió el paso que sí está en la lista');
  const noPlan = spawnSync(process.execPath, [BATCH, '--out', path.join(b, 'x.json')], { env: envFor(b), encoding: 'utf8' });
  assert.strictEqual(noPlan.status, 2, 'sin --plan, sale 2');
});

test('T2b Batch_OddReturns_CountAsFailure — un código que no es entero o una promesa no se leen como éxito; la escritura con Buffer y con callback se atrapa', () => {
  const { captured } = require(BATCH);
  const odd = captured(() => { process.exit('x'); });
  assert.strictEqual(odd.rc, 1, 'process.exit con un código que no es entero sale 1');
  const prom = captured(() => Promise.resolve(0));
  assert.strictEqual(prom.rc, 1, 'un paso que devuelve una promesa sale 1');
  assert.match(prom.stderr, /promesa/, 'y lo dice por la salida de error');
  let called = 0;
  const buf = captured(() => { process.stdout.write(Buffer.from('con buffer\n')); process.stderr.write('con callback\n', () => { called++; }); process.stdout.write('con encoding\n', 'utf8', () => { called++; }); return 0; });
  assert.strictEqual(buf.stdout, 'con buffer\ncon encoding\n');
  assert.strictEqual(buf.stderr, 'con callback\n');
  assert.strictEqual(called, 2, 'los callbacks de write se llaman');
});

test('T3b Batch_BadPlan_RefusedBeforeRunning — un plan mal armado no corre ningún paso', () => {
  const { runPlan } = require(BATCH);
  let ran = 0;
  const registry = { sane: () => () => { ran++; return 0; } };
  const bad = [
    ['sin steps', {}],
    ['un paso sin id', { steps: [{ script: 'sane', args: [] }] }],
    ['un id vacío', { steps: [{ id: '', script: 'sane', args: [] }] }],
    ['un id repetido', { steps: [{ id: 'a', script: 'sane', args: [] }, { id: 'a', script: 'sane', args: [] }] }],
    ['argumentos que no son textos', { steps: [{ id: 'a', script: 'sane', args: [1] }] }],
    ['argumentos que no son lista', { steps: [{ id: 'a', script: 'sane', args: 'x' }] }],
    ['variables que no son objeto', { steps: [{ id: 'a', script: 'sane', args: [], env: ['X'] }] }],
    ['una variable con un número', { steps: [{ id: 'a', script: 'sane', args: [], env: { X: 1 } }] }],
  ];
  for (const [label, plan] of bad) {
    assert.throws(() => runPlan(plan, registry), (e) => e instanceof Error && e.constructor.name === 'PlanError', label);
  }
  assert.strictEqual(ran, 0, 'ningún paso corrió');
});

test('T3c Batch_PlanFileAndOutErrors — plan que no es JSON o que no existe: 2; con marca de codificación: corre; sin dónde escribir: 1 y nada corrido', () => {
  const [, b] = twoHomes('t3c', sane);
  const run = (plan, out) => spawnSync(process.execPath, [BATCH, '--plan', plan, '--out', out], { cwd: b, env: envFor(b), encoding: 'utf8' });
  fs.writeFileSync(path.join(b, 'basura.json'), 'esto no es JSON');
  const junk = run(path.join(b, 'basura.json'), path.join(b, 'r1.json'));
  assert.strictEqual(junk.status, 2, 'plan que no es JSON: sale 2');
  assert.strictEqual(fs.existsSync(path.join(b, 'r1.json')), false, 'y no escribe el resultado');
  const missing = run(path.join(b, 'no-esta.json'), path.join(b, 'r2.json'));
  assert.strictEqual(missing.status, 2, 'plan que no existe: sale 2');
  const step = { id: 'p', script: 'tycon-config', args: ['get', 'install.profile'], env: {} };
  fs.writeFileSync(path.join(b, 'bom.json'), `﻿${JSON.stringify({ steps: [step] })}`);
  const bom = run(path.join(b, 'bom.json'), path.join(b, 'r3.json'));
  assert.strictEqual(bom.status, 0, `plan con marca de codificación: corre (${bom.stderr})`);
  const res = JSON.parse(fs.readFileSync(path.join(b, 'r3.json'), 'utf8'));
  assert.strictEqual(res.complete, true, 'el resultado de una tanda entera dice complete: true');
  // lo que sale el paso suelto en el mismo ambiente: 3 sin perfil; 0 donde el árbol trae un perfil del equipo que lo fija
  // (la corrida nocturna pone el público encima del privado, y ése trae perfil-equipo.json con install.profile)
  assert.strictEqual(res.steps.p.rc, separate(step, b).rc, 'y trae el paso, con lo mismo que sale suelto');
  const applyPlan = { steps: [{ id: 'a', script: 'apply-hooks', args: applyStep.args.map((x) => x.split('<HOME>').join(b)), env: {} }] };
  fs.writeFileSync(path.join(b, 'apply.json'), JSON.stringify(applyPlan));
  const noWhere = run(path.join(b, 'apply.json'), path.join(b, 'no-existe', 'r4.json'));
  assert.strictEqual(noWhere.status, 1, 'sin dónde escribir el resultado: sale 1');
  assert.match(noWhere.stderr, /no corrí ningún paso/, 'y dice que no corrió nada');
  assert.strictEqual(fs.existsSync(path.join(b, '.claude', 'settings.json')), false, 'y no corrió el paso');
});

test('T3d Batch_CutMidway_DoneStepsStayRecorded — si deja de poder anotar, se corta ahí y lo anotado queda', () => {
  const { runPlan } = require(BATCH);
  const ran = [];
  const registry = { step: () => (argv) => { ran.push(argv[0]); return 0; } };
  const written = [];
  let calls = 0;
  assert.throws(() => runPlan({ steps: [{ id: 'a', script: 'step', args: ['a'] }, { id: 'b', script: 'step', args: ['b'] }, { id: 'c', script: 'step', args: ['c'] }] }, registry, (sofar) => {
    calls++;
    if (calls === 3) throw new Error('disco lleno (laboratorio)');
    written.push(Object.keys(sofar).join(','));
  }), /disco lleno/);
  assert.deepStrictEqual(ran, ['a', 'b'], 'el tercero no corre');
  assert.deepStrictEqual(written, ['', 'a'], 'quedó anotado el arranque y el primero');
});

test('T3e Batch_FinalWriteFails_SaysHowManyRan — si falla la escritura final, dice cuántos corrieron y cuántos quedaron anotados', () => {
  const [, b] = twoHomes('t3e', sane);
  const plan = path.join(b, 'p.json');
  const out = path.join(b, 'r.json');
  fs.writeFileSync(plan, JSON.stringify({ steps: [{ id: 'p', script: 'tycon-config', args: ['get', 'install.profile'], env: {} }] }));
  // la escritura final es la tercera (arranque, después del paso, final): se rompe con un renombrado que falla esa vez
  const wrap = path.join(b, 'wrap.js');
  fs.writeFileSync(wrap, `const fs = require('fs'); const r = fs.renameSync; let n = 0;
fs.renameSync = (a, d) => { if (++n === 3) throw Object.assign(new Error('lab'), { code: 'EIO' }); return r(a, d); };
process.exitCode = require(${JSON.stringify(BATCH)}).main(process.argv.slice(2));\n`);
  const r = spawnSync(process.execPath, [wrap, '--plan', plan, '--out', out], { cwd: b, env: envFor(b), encoding: 'utf8' });
  assert.strictEqual(r.status, 1, `sale 1 (${r.stderr})`);
  assert.match(r.stderr, /corrí 1 paso\(s\) y quedan anotados 1/, 'el conteo es el de lo que corrió');
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(res.complete, false, 'el resultado que quedó dice que no terminó');
  assert.strictEqual(res.steps.p.rc, separate({ script: 'tycon-config', args: ['get', 'install.profile'], env: {} }, b).rc, 'y trae el paso que sí corrió, con lo mismo que sale suelto');
});
