'use strict';

/**
 * suites-for-change.test.js — qué suites corre el control de cada cambio en Azure.
 *
 * El control de `main` corre las ~190 suites una por una y tiene un tope de 45 minutos: las suites más lentas
 * declaran en `suites.json` «gate_only_when_touching» y corren en el control sólo si el cambio
 * toca su carpeta (o la suite misma). Igual corren todas las noches en el banco: no se pierde la medición.
 *
 * Lo que no puede pasar: que una suite deje de correr porque no se pudo saber qué tocó el cambio. «No
 * pude mirar» corre TODO, nunca menos.
 *
 * Correr: node --test scripts/tests/suites-for-change.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'ci', 'suites-for-change.js');
// la regla de las carpetas vive en agent-skills (la del portón de las stories): sin agent-skills, esto no se mide.
// Dónde están las skills lo dice LA función: la variable › este clon si es unido › lo instalado.
const SKILLS = require(path.resolve(__dirname, '..', 'lib', 'skills-dir.js')).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || '').skills;
const HAS_RULE = fs.existsSync(path.join(SKILLS, 'tycon-pipeline', 'scripts', 'lib', 'touched-files.js'));
const NO_RULE = !HAS_RULE && 'NO MEDIDO — sin agent-skills (la regla de las carpetas)';

function lab(changed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suites-for-change-'));
  const suites = {
    diarias: [
      { raiz: 'arnes', ruta: 'tests/fast.test.js', requiere: [] },
      { raiz: 'arnes', ruta: 'tests/slow-copy.test.sh', requiere: ['agent-skills'], gate_only_when_touching: ['scripts/publishing/**'] },
      { raiz: 'agent-skills', ruta: 'tycon-pipeline/scripts/tests/x.test.js', requiere: [] },
    ],
    semanales: [{ raiz: 'arnes', ruta: 'tests/weekly.test.js', requiere: [] }],
  };
  fs.writeFileSync(path.join(dir, 'suites.json'), JSON.stringify(suites));
  if (changed !== null) fs.writeFileSync(path.join(dir, 'changed.txt'), changed.join('\n') + (changed.length ? '\n' : ''));
  return dir;
}
function run(dir, extra = []) {
  const args = [SCRIPT, '--suites', path.join(dir, 'suites.json'), '--scripts', '/R/scripts', '--skills', SKILLS, ...extra];
  if (fs.existsSync(path.join(dir, 'changed.txt'))) args.push('--changed', path.join(dir, 'changed.txt'));
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter(Boolean);
  return { code: r.status, err: r.stderr, run: lines.filter((l) => l.startsWith('RUN\t')).map((l) => l.slice(4)), skip: lines.filter((l) => l.startsWith('SKIP\t')) };
}

test('SuitesForChange_ChangeOutsideTheGate_SkipsTheSlowSuiteAndSaysWhy', { skip: NO_RULE }, () => {
  const r = run(lab(['guides/x.md', 'scripts/hooks/a.js']));
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(r.run, ['/R/scripts/tests/fast.test.js', path.join(SKILLS, 'tycon-pipeline/scripts/tests/x.test.js'), '/R/scripts/tests/weekly.test.js']);
  assert.strictEqual(r.skip.length, 1);
  assert.match(r.skip[0], /^SKIP\tslow-copy\.test\.sh\t.*scripts\/publishing\/\*\*/, 'nombra la suite y la carpeta que la dispara');
});

test('SuitesForChange_ChangeInsideTheGate_RunsIt', { skip: NO_RULE }, () => {
  const r = run(lab(['scripts/publishing/export.js']));
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.run.includes('/R/scripts/tests/slow-copy.test.sh'));
  assert.deepStrictEqual(r.skip, []);
});

test('SuitesForChange_ChangeTouchesTheSuiteItself_RunsIt', { skip: NO_RULE }, () => {
  const r = run(lab(['scripts/tests/slow-copy.test.sh']));
  assert.ok(r.run.includes('/R/scripts/tests/slow-copy.test.sh'), 'quien cambia la suite la quiere ver correr');
});

test('SuitesForChange_UnknownChange_RunsEverything', () => {
  // sin lista de cambios (no se pudo calcular el diff): corre todo y lo dice
  const r = run(lab(null));
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.run.length, 4);
  assert.deepStrictEqual(r.skip, []);
  assert.match(r.err, /corre todo/);
});

test('SuitesForChange_UnreadableChangeList_RunsEverything', () => {
  const dir = lab(null);
  const r = run(dir, ['--changed', path.join(dir, 'no-existe.txt')]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.run.length, 4);
  assert.match(r.err, /corre todo/);
});

test('SuitesForChange_BadGatePattern_RunsTheSuite', { skip: NO_RULE }, () => {
  // un patrón que no es «<carpeta>/**» no se interpreta: la suite corre (nunca se difiere por un patrón roto)
  const dir = lab(['guides/x.md']);
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'suites.json'), 'utf8'));
  s.diarias[1].gate_only_when_touching = ['scripts/*/publishing'];
  fs.writeFileSync(path.join(dir, 'suites.json'), JSON.stringify(s));
  const r = run(dir);
  assert.ok(r.run.includes('/R/scripts/tests/slow-copy.test.sh'));
  assert.match(r.err, /no es una lista de «<carpeta>\/\*\*»/);
});

test('SuitesForChange_UnreadableSuitesJson_Exit2', () => {
  const dir = lab([]);
  fs.writeFileSync(path.join(dir, 'suites.json'), '{ roto');
  const r = run(dir);
  assert.strictEqual(r.code, 2, 'sin la lista de suites no hay qué correr: «no pude mirar»');
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// T11: la raíz `agent-skills` sale de LA función (`resolveSkillsDirs()` de
// scripts/lib/skills-dir.js: la variable › el propio clon si es unido › lo instalado), no de una ruta escrita en
// quien llama. Sin esto, en un clon de trabajo del repo unido la lista apunta a las suites INSTALADAS en la
// máquina y el control da verde sin haber corrido el cambio.
// El «propio clon» sale de dónde vive el guion: cada caso arma un clon de juguete con su copia y una HOME de juguete.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
const LIB = path.resolve(__dirname, '..', 'lib');
const CANARY = 'tycon-pipeline/scripts/tests/canary.test.js';

/**
 * Un clon de trabajo de juguete (con el guion y su biblioteca) y una HOME de juguete.
 *   unified: el clon trae skills/ y agents/, con la canario ROJA · installed: la HOME trae un agent-skills con la canario VERDE
 */
const clones = [];
test.after(() => { for (const d of clones) fs.rmSync(d, { recursive: true, force: true }); });
function workClone({ unified = true, installed = true, suites = null } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suites-for-change-clone-')));
  clones.push(dir);
  const clone = path.join(dir, 'clone');
  const home = path.join(dir, 'home');
  const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  fs.mkdirSync(path.join(clone, 'scripts', 'ci'), { recursive: true });
  fs.mkdirSync(path.join(clone, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(clone, 'scripts', 'ci', 'suites-for-change.js'));
  for (const f of ['skills-dir.js', 'canonical-path.js', 'legacy-names.js']) fs.copyFileSync(path.join(LIB, f), path.join(clone, 'scripts', 'lib', f));
  put(path.join(clone, 'scripts', 'tests', 'fast.test.js'), 'process.exit(0)\n');
  put(path.join(clone, 'scripts', 'tests', 'suites.json'), JSON.stringify(suites || { diarias: [
    { raiz: 'arnes', ruta: 'tests/fast.test.js', requiere: [] },
    { raiz: 'agent-skills', ruta: CANARY, requiere: [] },
  ] }));
  if (unified) {
    put(path.join(clone, 'skills', CANARY), 'console.error("canario del CLON de trabajo: rojo a propósito"); process.exit(1)\n');
    fs.mkdirSync(path.join(clone, 'agents'), { recursive: true });
    // la regla del portón de las stories viaja con las skills del clon (un enlace a la biblioteca de verdad: la
    // regla importa a sus vecinas)
    if (HAS_RULE) fs.symlinkSync(path.join(SKILLS, 'tycon-pipeline', 'scripts', 'lib'), path.join(clone, 'skills', 'tycon-pipeline', 'scripts', 'lib'), 'junction');
  }
  fs.mkdirSync(home, { recursive: true });
  const inst = path.join(home, '.claude', 'agent-skills', 'skills');
  if (installed) put(path.join(inst, CANARY), 'console.log("canario INSTALADO: verde"); process.exit(0)\n');
  return { dir, clone, home, inst };
}
function plan(w, { extra = [], variable, changed } = {}) {
  const env = { ...process.env, HOME: w.home, USERPROFILE: w.home };
  delete env.TYCON_SKILLS_DIR;
  if (variable !== undefined) env.TYCON_SKILLS_DIR = variable;
  const args = [path.join(w.clone, 'scripts', 'ci', 'suites-for-change.js'), '--suites', path.join(w.clone, 'scripts', 'tests', 'suites.json'),
    '--scripts', path.join(w.clone, 'scripts'), ...extra];
  if (changed) { fs.writeFileSync(path.join(w.dir, 'changed.txt'), changed.join('\n') + '\n'); args.push('--changed', path.join(w.dir, 'changed.txt')); }
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  const lines = r.stdout.split('\n').filter(Boolean);
  return { code: r.status, err: r.stderr, run: lines.filter((l) => l.startsWith('RUN\t')).map((l) => l.slice(4)),
    skip: lines.filter((l) => l.startsWith('SKIP\t')), root: lines.filter((l) => l.startsWith('ROOT\t')).map((l) => l.split('\t')), env };
}

test('T11 Suites_CanaryInWorkClone_RunsOwnTree_NotInstalled — sin variable ni --skills, la canario que se lista es la del CLON (roja), no la instalada (verde)', () => {
  // 🔴 Con la raíz escrita en quien llama ($HOME/.claude/agent-skills/skills) se lista la instalada y la
  //    corrida da verde con la canario del clon en rojo.
  const w = workClone();
  const r = plan(w);
  assert.strictEqual(r.code, 0, r.err);
  const mine = path.join(w.clone, 'skills', CANARY);
  assert.deepStrictEqual(r.run, [path.join(w.clone, 'scripts', 'tests', 'fast.test.js'), mine]);
  // la línea dice de qué raíz salió
  assert.deepStrictEqual(r.root, [['ROOT', 'agent-skills', path.join(w.clone, 'skills'), 'own-clone', 'ok']]);
  // y corrida como la corre el control (node <ruta>), sale ROJA: corrió la del clon
  const ran = spawnSync(process.execPath, [r.run[1]], { encoding: 'utf8', env: r.env });
  assert.strictEqual(ran.status, 1, 'la canario del clon de trabajo es roja');
  assert.match(ran.stderr, /canario del CLON de trabajo/);
});

test('T11 — el espejo: con dos repos físicos (el clon sin skills/) se lista la instalada, como siempre, y sale verde', () => {
  const w = workClone({ unified: false });
  const r = plan(w);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.run[1], path.join(w.inst, CANARY));
  assert.deepStrictEqual(r.root, [['ROOT', 'agent-skills', w.inst, 'installed', 'ok']]);
  assert.strictEqual(spawnSync(process.execPath, [r.run[1]], { encoding: 'utf8', env: r.env }).status, 0);
});

test('T11 — la variable gana al propio clon; y --skills, pasado a mano, gana a las dos (y la línea lo dice)', () => {
  const w = workClone();
  const v = plan(w, { variable: path.join(w.home, '.claude', 'agent-skills') });
  assert.strictEqual(v.run[1], path.join(w.inst, CANARY));
  assert.deepStrictEqual(v.root, [['ROOT', 'agent-skills', w.inst, 'variable', 'ok']]);
  const o = plan(w, { extra: ['--skills', w.inst], variable: path.join(w.clone, 'skills') });
  assert.strictEqual(o.run[1], path.join(w.inst, CANARY));
  assert.deepStrictEqual(o.root, [['ROOT', 'agent-skills', w.inst, '--skills', 'ok']]);
});

test('T12 Suites_MissingRoot_NotMeasuredWithReason — la raíz agent-skills no existe: sus suites NO se callan ni se dan por corridas, y se dice el motivo', () => {
  // 🔴 Listar igual y callar deja a quien corre la lista viendo sólo «no está»; sacar la suite de la
  //    lista es peor: un salteo en silencio. La suite se lista (quien la corre la marca «NO se midió» y cuenta como falla) y
  //    acá queda dicho POR QUÉ no está: la raíz y de qué regla salió.
  const w = workClone({ unified: false, installed: false });
  const r = plan(w);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.run.length, 2, 'la suite sigue en la lista: no se saltea en silencio');
  assert.ok(!fs.existsSync(r.run[1]), 'y su archivo no existe: quien corre la lista la cuenta como no medida');
  assert.deepStrictEqual(r.root, [['ROOT', 'agent-skills', w.inst, 'installed', 'missing']]);
  assert.match(r.err, /NO MEDIDA/);
  assert.ok(r.err.includes(w.inst), `nombra la raíz que buscó: ${r.err}`);
  assert.match(r.err, /installed/);
  assert.match(r.err, /1 suite/);
  // el espejo: con la raíz en su lugar no hay aviso
  assert.doesNotMatch(plan(workClone()).err, /NO MEDIDA/);
});

test('T11 — en el repo unido, cambiar la propia suite de skills/ la hace correr aunque no toque su carpeta', { skip: NO_RULE }, () => {
  // 🔴 Si «la propia suite» sólo se reconociera para la raíz `arnes` (scripts/<ruta>), esta no correría.
  const suites = { diarias: [
    { raiz: 'arnes', ruta: 'tests/fast.test.js', requiere: [] },
    { raiz: 'agent-skills', ruta: CANARY, requiere: [], gate_only_when_touching: ['scripts/publishing/**'] },
  ] };
  const w = workClone({ suites });
  const other = plan(w, { changed: ['guides/x.md'] });
  assert.strictEqual(other.code, 0, other.err);
  assert.strictEqual(other.run.length, 1, 'el cambio no toca su carpeta ni la suite: se difiere');
  assert.match(other.skip[0], /^SKIP\tcanary\.test\.js\t/);
  const own = plan(w, { changed: [`skills/${CANARY}`] });
  assert.ok(own.run.includes(path.join(w.clone, 'skills', CANARY)), 'quien cambia la suite la quiere ver correr');
});

// ── la propia suite con `--skills` apuntando a una carpeta de enlaces ──────────────────────────────────────────────────────
// «La propia suite» se busca resolviendo a su ruta real el ARCHIVO entero, no sólo la RAÍZ de las skills. Con `--skills`
// apuntando a una carpeta real que trae un enlace por skill (la forma de `~/.claude/skills` en la máquina de un solo
// árbol), la raíz resuelta es ella misma; resolviendo sólo la raíz, la ruta propia daría `../…` y la suite editada se DIFERIRÍA.
const GATED = { diarias: [
  { raiz: 'arnes', ruta: 'tests/fast.test.js', requiere: [] },
  { raiz: 'agent-skills', ruta: CANARY, requiere: [], gate_only_when_touching: ['scripts/publishing/**'] },
] };
/** Una carpeta REAL fuera del clon, con un enlace por skill hacia las del clon de trabajo. */
function folderWithOneLinkPerSkill(w) {
  const folder = path.join(w.dir, 'skills-by-link');
  fs.mkdirSync(folder);
  fs.symlinkSync(path.join(w.clone, 'skills', 'tycon-pipeline'), path.join(folder, 'tycon-pipeline'), 'junction');
  return folder;
}

test('5b-6c Suites_OwnSuiteTouched_SkillsFolderWithOneLinkPerSkill_Runs — --skills es una carpeta real con un enlace por skill: editar la propia suite la hace correr', { skip: NO_RULE }, () => {
  // 🔴 Con `path.relative(repoRoot, path.join(realDir(skillsRoot), s.ruta))` la ruta sale `../skills-by-link/…` y la suite se saltea.
  const w = workClone({ suites: GATED });
  const folder = folderWithOneLinkPerSkill(w);
  const r = plan(w, { extra: ['--skills', folder], changed: [`skills/${CANARY}`] });
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(r.skip, [], 'quien cambia la suite la quiere ver correr');
  assert.deepStrictEqual(r.run, [path.join(w.clone, 'scripts', 'tests', 'fast.test.js'), path.join(folder, CANARY)]);
  assert.deepStrictEqual(r.root, [['ROOT', 'agent-skills', folder, '--skills', 'ok']]);
});

test('5b-6c — los espejos sanos: por esa carpeta lo no tocado se sigue difiriendo; una suite que ya no está en disco sigue corriendo por la raíz enlazada; y con dos repos físicos no se confunde', { skip: NO_RULE }, () => {
  const w = workClone({ suites: GATED });
  const folder = folderWithOneLinkPerSkill(w);
  // un cambio que no toca ni la carpeta del portón ni la suite: diferida, como siempre
  const other = plan(w, { extra: ['--skills', folder], changed: ['guides/x.md'] });
  assert.strictEqual(other.code, 0, other.err);
  assert.strictEqual(other.run.length, 1);
  assert.match(other.skip[0], /^SKIP\tcanary\.test\.js\t/);
  // y tocar la carpeta del portón la hace correr por cualquier forma de la raíz
  assert.deepStrictEqual(plan(w, { extra: ['--skills', folder], changed: ['scripts/publishing/x.js'] }).skip, []);
  // la suite que el cambio BORRÓ (sigue en suites.json, ya no está en disco), con la raíz entera por un enlace: no hay
  // archivo que resolver, pero la raíz resuelta alcanza. Sigue en la lista: quien la corre la cuenta como no medida.
  const gone = 'tycon-pipeline/scripts/tests/deleted.test.js';
  const w2 = workClone({ suites: { diarias: [{ raiz: 'agent-skills', ruta: gone, requiere: [], gate_only_when_touching: ['scripts/publishing/**'] }] } });
  const link = path.join(w2.dir, 'skills-link');
  fs.symlinkSync(path.join(w2.clone, 'skills'), link, 'junction');
  const deleted = plan(w2, { extra: ['--skills', link], changed: [`skills/${gone}`] });
  assert.deepStrictEqual([deleted.run, deleted.skip], [[path.join(link, gone)], []]);
  // dos repos físicos: una ruta `skills/…` tocada en el repo medido no es la suite del OTRO repo
  const w3 = workClone({ suites: GATED });
  fs.symlinkSync(path.join(SKILLS, 'tycon-pipeline', 'scripts', 'lib'), path.join(w3.inst, 'tycon-pipeline', 'scripts', 'lib'), 'junction');   // la regla del portón viaja con esas skills
  const two = plan(w3, { extra: ['--skills', w3.inst], changed: [`skills/${CANARY}`] });
  assert.strictEqual(two.code, 0, two.err);
  assert.match(two.skip[0], /^SKIP\tcanary\.test\.js\t/);
});

test('SuitesForChange_WithoutTheGateRule_RunsEverything', () => {
  // sin la regla del portón (agent-skills ausente o roto) no se difiere nada: corre todo y lo dice
  const dir = lab(['guides/x.md']);
  const r = spawnSync(process.execPath, [SCRIPT, '--suites', path.join(dir, 'suites.json'), '--scripts', '/R/scripts',
    '--skills', path.join(dir, 'no-skills'), '--changed', path.join(dir, 'changed.txt')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.split('\n').filter((l) => l.startsWith('RUN\t')).length, 4);
  assert.match(r.stderr, /no encontré la regla[^\n]*corre todo/);
});

test('SuitesForChange_RealList_ThroughAPipe_EverySuiteIsPrinted', () => {
  // Con `process.exit()` la salida por una tubería se cortaría a los 8 KB: con la lista real saldrían 140 de 219 líneas y
  // las últimas suites —la copia pública, la máquina limpia— no aparecerían ni como RUN ni como SKIP.
  const real = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'suites.json'), 'utf8'));
  const total = [...real.diarias, ...(real.semanales || [])].filter((s) => s && typeof s.ruta === 'string').length;
  const r = spawnSync(process.execPath, [SCRIPT, '--suites', path.resolve(__dirname, 'suites.json'), '--scripts', '/R/scripts',
    '--skills', path.join(os.tmpdir(), 'sin-skills-de-laboratorio')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.split('\n').filter((l) => /^(RUN|SKIP)\t/.test(l)).length, total, 'una línea por suite, ninguna perdida');
});

// ── `--deps`: una suite sin criterio propio corre sólo si el cambio toca algo de lo que usa su
// código (scripts/ci/suite-deps.js). Un repo de juguete con suites que dependen de cosas distintas; la foto nocturna es de juguete.
const DEPS_SKIP = /el cambio no toca nada de lo que usa su código \(scripts\/ci\/suite-deps\.js\): la corre el banco nocturno$/;
const HOUR = 3600 * 1000;
function depsRepo({ whole = true, missing = false, gated = false, legacy = false, heavy = false, heavyDeps = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suites-for-change-deps-')));
  clones.push(dir);
  const put = (rel, body) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  put('scripts/ci/suites-for-change.js', fs.readFileSync(SCRIPT, 'utf8'));
  const depsLib = path.join(path.dirname(SCRIPT), 'suite-deps.js');
  if (fs.existsSync(depsLib)) put('scripts/ci/suite-deps.js', fs.readFileSync(depsLib, 'utf8'));
  for (const f of ['skills-dir.js', 'canonical-path.js', 'legacy-names.js']) put(`scripts/lib/${f}`, fs.readFileSync(path.join(LIB, f), 'utf8'));
  put('scripts/lib/util.js', 'module.exports = 1;\n');
  put('scripts/hooks/guard.js', "require('./guard-lib.js');\n");
  put('scripts/hooks/guard-lib.js', 'module.exports = 2;\n');
  put('scripts/setup/install.sh', 'echo instala\n');
  put('scripts/sin-uso.js', 'module.exports = 0;\n');
  put('guides/bizuit/a.md', '# a\n');
  put('scripts/publishing/export.js', 'module.exports = 3;\n');
  const names = ['a.test.js', 'b.test.sh', 'd.test.js'];
  put('scripts/tests/a.test.js', "require('../lib/util.js'); const g = 'scripts/hooks/guard.js';\n");
  put('scripts/tests/b.test.sh', 'bash "$RAIZ/scripts/setup/install.sh"; ls "$RAIZ/guides/bizuit"; # antes llamaba a scripts/old/gone.js\n');
  put('scripts/tests/d.test.js', "const e = path.join(ROOT, 'scripts', 'publishing', 'export.js');\n");
  if (whole) { names.push('c.test.js'); put('scripts/tests/c.test.js', "spawnSync('git', ['ls-files']);\n"); }
  const entries = names.map((n) => ({ raiz: 'arnes', ruta: `tests/${n}`, requiere: [] }));
  if (missing) entries.push({ raiz: 'arnes', ruta: 'tests/e.test.js', requiere: [] });
  if (gated) {
    put('scripts/tests/g.test.js', "require('../lib/util.js');\n");
    entries.push({ raiz: 'arnes', ruta: 'tests/g.test.js', requiere: [], gate_only_when_touching: ['scripts/hooks/**'] });
  }
  if (legacy) {
    put('scripts/renames.json', '{}\n');
    put('scripts/tests/legacy-names-x.test.sh', 'jq . "$RAIZ/scripts/renames.json"\n');
    entries.push({ raiz: 'arnes', ruta: 'tests/legacy-names-x.test.sh', requiere: [] });
  }
  const heavyJson = { suites: {} };
  if (heavy) {
    // las pesadas de juguete, con la misma forma que las de verdad: la copia pública mira los .md que viajan
    put('scripts/tests/export-real.test.sh', 'echo copia\n');
    put('scripts/tests/harness-install.test.sh', 'echo instala\n');
    entries.push({ raiz: 'arnes', ruta: 'tests/export-real.test.sh', requiere: [] }, { raiz: 'arnes', ruta: 'tests/harness-install.test.sh', requiere: [] });
    heavyJson.shared = { patterns: ['scripts/publishing/**', 'scripts/lib/**'] };
    heavyJson.suites['export-real.test.sh'] = { patterns: ['scripts/**', 'guides/**'], reads_md: true };
    heavyJson.suites['harness-install.test.sh'] = { patterns: ['scripts/tests/harness-install.test.sh', 'guides/**'] };
  }
  if (heavyDeps) {
    // las pesadas con su campo `deps`. La red (`shared`) es sólo lo del instalador de juguete; la del
    // laboratorio usa lo que nombra su código; la que arma la copia va con su lista (`false`); y la que lista
    // un repo de juguete (`ls-files` de su laboratorio) usa el grafo sin el «depende de todo» (`"graph"`), al lado de
    // otra igual sin el campo, que sigue dependiendo de todo.
    put('scripts/publishing/allow.json', '{}\n');
    put('scripts/tests/export-real.test.sh', 'node "$RAIZ/scripts/publishing/export.js" --allow scripts/publishing/allow.json\n');
    // la del laboratorio nombra, en rutas de juguete, carpetas de datos del repo (como harness-lab.sh y los hooks)
    put('.advisors/dod-runtime/keep.md', '# x\n');
    put('.engram/manifest.json', '{}\n');
    put('scripts/tests/harness-plan.test.sh', 'node "$RAIZ/scripts/lib/util.js"; mkdir -p "$LAB/.advisors/dod-runtime"; cat "$LAB/.engram/manifest.json"\n');
    // una pesada que mira .md y elige por el grafo (como prod-access-guard): su código lee una guía
    put('guides/guard.md', '# guía\n');
    put('scripts/tests/prod-access-guard.test.sh', 'grep -q freno "$RAIZ/guides/guard.md"\n');
    put('scripts/tests/clean-machine.test.sh', 'node "$RAIZ/scripts/lib/util.js"\n');
    put('scripts/tests/harness-profile.test.sh', 'harness_lab_git "$LAB" ls-files; node "$RAIZ/scripts/hooks/guard.js"\n');
    put('scripts/tests/harness-channel.test.sh', 'harness_lab_git "$LAB" ls-files; node "$RAIZ/scripts/hooks/guard.js"\n');
    for (const n of ['export-real.test.sh', 'harness-plan.test.sh', 'clean-machine.test.sh', 'harness-profile.test.sh', 'harness-channel.test.sh', 'prod-access-guard.test.sh']) entries.push({ raiz: 'arnes', ruta: `tests/${n}`, requiere: [] });
    heavyJson.shared = { patterns: ['scripts/setup/**'] };
    heavyJson.suites['export-real.test.sh'] = { patterns: ['scripts/publishing/**', 'scripts/tests/export-real.test.sh'], deps: false, reads_md: true };
    heavyJson.suites['harness-plan.test.sh'] = { patterns: ['scripts/tests/harness-plan.test.sh'] };
    heavyJson.suites['clean-machine.test.sh'] = { patterns: ['scripts/tests/clean-machine.test.sh', 'scripts/hooks/**'], deps: false };
    // la huella de sus líneas que recorren algo, con la función del lector (sin ella todavía, sin huella)
    const reader = fs.existsSync(depsLib) ? require(depsLib) : {};
    const profileSha = reader.wholeRepoSha ? reader.wholeRepoSha(fs.readFileSync(path.join(dir, 'scripts/tests/harness-profile.test.sh'), 'utf8')) : undefined;
    heavyJson.suites['harness-profile.test.sh'] = { patterns: ['scripts/tests/harness-profile.test.sh'], deps: 'graph', graph_whole_lines: 1, graph_whole_sha: profileSha };
    heavyJson.suites['prod-access-guard.test.sh'] = { patterns: ['scripts/tests/prod-access-guard.test.sh'], reads_md: true };
    heavyJson.deps_ignore = { patterns: ['.engram/**', '.advisors/**'] };
    heavyJson.suites['harness-channel.test.sh'] = { patterns: ['scripts/tests/harness-channel.test.sh'] };
  }
  put('scripts/ci/heavy-suites.json', JSON.stringify(heavyJson));
  put('scripts/tests/suites.json', JSON.stringify({ diarias: entries, semanales: [] }));
  nightly(dir, { complete: true, ageHours: 10 });
  return dir;
}
function nightly(dir, { complete, ageHours, raw }) {
  const f = path.join(dir, 'nightly.json');
  fs.writeFileSync(f, raw !== undefined ? raw : JSON.stringify({ kind: 'bash-tests', ts: new Date(Date.now() - ageHours * HOUR).toISOString(), complete, failures: [] }));
}
function depsPlan(dir, changed, { deps = true, docs = null, photo = true, list = true, over = null } = {}) {
  fs.writeFileSync(path.join(dir, 'changed.txt'), `${changed.join('\n')}\n`);
  const args = [path.join(dir, 'scripts', 'ci', 'suites-for-change.js'), '--suites', path.join(dir, 'scripts', 'tests', 'suites.json'),
    '--scripts', path.join(dir, 'scripts'), '--skills', SKILLS, '--heavy', path.join(dir, 'scripts', 'ci', 'heavy-suites.json')];
  if (list) args.push('--changed', path.join(dir, 'changed.txt'));
  if (docs) { fs.writeFileSync(path.join(dir, 'changed-docs.txt'), `${docs.join('\n')}\n`); args.push('--changed-with-docs', path.join(dir, 'changed-docs.txt')); }
  if (deps) args.push('--deps');
  if (deps && photo) args.push('--nightly', path.join(dir, 'nightly.json'));
  // la lista de las que pasan de 45 s (`over` es el contenido del archivo; con `false`, la ruta de uno que no está)
  if (over !== null) {
    const limitFile = path.join(dir, 'scripts', 'ci', 'suites-over-limit.json');
    if (over === false) fs.rmSync(limitFile, { force: true });
    else fs.writeFileSync(limitFile, typeof over === 'string' ? over : JSON.stringify(over));
    args.push('--over-limit', limitFile);
  }
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  return { run: lines.filter((l) => l.startsWith('RUN\t')).map((l) => path.basename(l.slice(4))), skip: lines.filter((l) => l.startsWith('SKIP\t')), err: r.stderr };
}

test('T12 SuiteDeps_RunsOnlyWhatTheChangeTouches — lo que carga, lo que nombra, la carpeta, path.join, la suite misma, otra suite y una legacy-names', { skip: NO_RULE }, () => {
  const dir = depsRepo({ legacy: true });
  const cases = [
    [['scripts/lib/util.js'], ['a.test.js', 'c.test.js'], 'lo que la suite carga (require)'],
    [['scripts/hooks/guard-lib.js'], ['a.test.js', 'c.test.js'], 'lo que carga un guion que la suite nombra'],
    [['guides/bizuit/nueva.md'], ['b.test.sh', 'c.test.js'], 'un archivo nuevo en una carpeta que la suite nombra'],
    [['scripts/publishing/export.js'], ['d.test.js', 'c.test.js'], 'una ruta armada con path.join de pedazos literales'],
    [['scripts/tests/otra.test.js'], ['c.test.js'], 'otra suite: no arrastra a las demás; la que lista el repo corre siempre'],
    [['scripts/tests/b.test.sh'], ['b.test.sh', 'c.test.js'], 'la suite misma'],
    [['scripts/renames.json'], ['c.test.js', 'legacy-names-x.test.sh'], 'una legacy-names corre si el cambio toca lo que usa'],
  ];
  for (const [changed, want, why] of cases) {
    const p = depsPlan(dir, changed);
    assert.deepStrictEqual(p.run.sort(), want.sort(), `${why} (${changed})\n${p.err}`);
    for (const s of p.skip) assert.match(s, DEPS_SKIP, `el motivo exacto (${why})`);
  }
  assert.ok(depsPlan(dir, ['scripts/lib/util.js']).skip.some((s) => s.startsWith('SKIP\tlegacy-names-x.test.sh\t')), 'y si no lo toca, la legacy-names se saltea como cualquiera');
  assert.strictEqual(depsPlan(dir, ['scripts/lib/util.js'], { deps: false }).run.length, 5, 'sin --deps, como siempre: corren todas');
});

test('T13 SuiteDeps_WhenInDoubtRuns — cómo se elige, un borrado, una suite ausente, la que lista el repo, sin lista y sin ninguna', { skip: NO_RULE }, () => {
  const dir = depsRepo();
  const all = ['a.test.js', 'b.test.sh', 'c.test.js', 'd.test.js'];
  // (a) el cambio toca cómo se elige: corre todo, y lo dice
  for (const f of ['scripts/ci/suites-for-change.js', 'scripts/ci/suite-deps.js', 'scripts/ci/heavy-suites.json', 'scripts/ci/suites-over-limit.json', 'pipelines/azure-pipelines-maintainers-pr.yml']) {
    const p = depsPlan(dir, [f]);
    assert.deepStrictEqual(p.run.sort(), all, `(a) ${f}: corre todo`);
    assert.ok(p.err.includes(`toca cómo se eligen las suites (${f}): corre todo`), `(a) ${f}: con el motivo\n${p.err}`);
  }
  // (b) un archivo borrado o movido: corre la suite cuyo código lo nombra
  assert.deepStrictEqual(depsPlan(dir, ['scripts/old/gone.js']).run.sort(), ['b.test.sh', 'c.test.js'], '(b) archivo borrado');
  // (d) la que lista el repo entero corre con cualquier cambio
  assert.ok(depsPlan(dir, ['scripts/tests/otra.test.js']).run.includes('c.test.js'), '(d) git ls-files: siempre');
  // (e) sin lista de cambios: corre todo
  assert.deepStrictEqual(depsPlan(dir, [], { list: false }).run.sort(), all, '(e) sin lista');
  // (c) una suite que no está en disco: RUN (quien la corre dice «NO se midió»)
  const miss = depsRepo({ missing: true });
  assert.ok(depsPlan(miss, ['scripts/lib/util.js']).run.includes('e.test.js'), '(c) suite ausente: RUN');
  // (f) con --deps no queda ninguna: corre todo, con el motivo
  const none = depsRepo({ whole: false });
  const f = depsPlan(none, ['scripts/sin-uso.js']);
  assert.deepStrictEqual(f.run.sort(), ['a.test.js', 'b.test.sh', 'd.test.js'], `(f) ninguna queda: corre todo\n${f.err}`);
  assert.match(f.err, /con --deps no quedaba ninguna suite: corre todo/, '(f) con el motivo');
  assert.strictEqual(f.skip.length, 0);
});

test('T14 SuiteDeps_IncompleteOrOldNightly_SkipsNothing — sin foto completa y reciente del nocturno, --deps no saltea nada', { skip: NO_RULE }, () => {
  const dir = depsRepo();
  const motive = /el nocturno no midió todo: no hay red para lo salteado/;
  const cases = [
    [{ complete: false, ageHours: 10 }, 'foto incompleta'],
    [{ complete: true, ageHours: 40 }, 'foto de hace 40 h'],
    [{ raw: '{ esto no es json' }, 'foto ilegible'],
  ];
  for (const [photo, why] of cases) {
    nightly(dir, photo);
    const p = depsPlan(dir, ['scripts/lib/util.js']);
    assert.strictEqual(p.run.length, 4, `${why}: no saltea nada\n${p.err}`);
    assert.match(p.err, motive, `${why}: con el motivo`);
  }
  const noPhoto = depsPlan(dir, ['scripts/lib/util.js'], { photo: false });
  assert.strictEqual(noPhoto.run.length, 4, 'sin foto: no saltea nada');
  assert.match(noPhoto.err, motive);
  nightly(dir, { complete: true, ageHours: 10 });
  const ok = depsPlan(dir, ['scripts/lib/util.js']);
  assert.deepStrictEqual(ok.run.sort(), ['a.test.js', 'c.test.js'], `foto de hace 10 h y completa: --deps saltea\n${ok.err}`);
  assert.doesNotMatch(ok.err, motive);
});

test('T15 SuiteDeps_OwnGateRulesOverDeps — una suite con gate_only_when_touching sigue su criterio, no --deps', { skip: NO_RULE }, () => {
  const dir = depsRepo({ gated: true });
  const p = depsPlan(dir, ['scripts/lib/util.js']);
  assert.ok(p.skip.some((s) => /^SKIP\tg\.test\.js\tel cambio no toca scripts\/hooks\/\*\*/.test(s)), `fuera de su criterio pero dentro de lo que usa: manda su criterio\n${p.skip.join('\n')}\n${p.err}`);
  assert.ok(depsPlan(dir, ['scripts/hooks/nuevo.js']).run.includes('g.test.js'), 'dentro de su criterio aunque no use el archivo: corre');
});

test('T11 SuitesForChange_MdDoesNotChoose_ExceptHeavyThatReadsMd — un README de la copia no arrastra las pesadas del instalador', { skip: NO_RULE }, () => {
  const dir = depsRepo({ heavy: true });
  const p = depsPlan(dir, ['scripts/ci/x.js'], { docs: ['scripts/ci/x.js', 'scripts/publishing/public-files/README.md', 'guides/nueva.md'] });
  assert.ok(p.run.includes('export-real.test.sh'), `la copia pública mira los .md que viajan: corre\n${p.err}`);
  assert.ok(p.skip.some((s) => s.startsWith('SKIP\tharness-install.test.sh\t')), `la del instalador no corre por un README ni por una guía\n${p.skip.join('\n')}\n${p.err}`);
  // la copia corre por el .md aunque la lista de código no le toque nada
  const onlyDocs = depsPlan(dir, ['adapters/x.json'], { docs: ['adapters/x.json', 'guides/x.md'] });
  assert.ok(onlyDocs.run.includes('export-real.test.sh'), `la copia corre por la guía (.md) de la lista entera\n${onlyDocs.err}`);
  // espejo: sin el .md en la lista entera, la copia no corre por ese cambio
  assert.ok(depsPlan(dir, ['adapters/x.json'], { docs: ['adapters/x.json'] }).skip.some((s) => s.startsWith('SKIP\texport-real.test.sh\t')));
  const real = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'ci', 'heavy-suites.json'), 'utf8'));
  // Las que leen el texto de un .md real del repo, y sólo ésas: la máquina limpia (INSTALL.md y la portada) y el
  // freno de producción (su guía, T33). La copia pública armada (export-real) no está en la lista: el arnés se escribe
  // en GitHub y de ningún repo sale una copia.
  const readers = Object.entries(real.suites).filter(([, e]) => e.reads_md !== undefined).map(([n]) => n).sort();
  assert.deepStrictEqual(readers, ['clean-machine.test.sh', 'prod-access-guard.test.sh'], 'las pesadas que declaran mirar .md');
  for (const n of readers) assert.strictEqual(real.suites[n].reads_md, true, `${n} declara que mira .md`);
});

// Dos huecos de «ante la duda, corre»:
// (b) un borrado o movido se busca por el nombre del archivo CON y SIN extensión: un `require('./state')` o una suite
//     que nombra la CARPETA que se movió tienen que verlo, o la suite rota se saltea;
// (c) una suite (o un archivo que carga) que existe pero no se deja leer no se lee como texto vacío: sin dependencias, SKIP.
const putIn = (dir, rel, body) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const addSuite = (dir, name) => {
  const file = path.join(dir, 'scripts', 'tests', 'suites.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.diarias.push({ raiz: 'arnes', ruta: `tests/${name}`, requiere: [] });
  fs.writeFileSync(file, JSON.stringify(s));
};
const CAN_LOCK = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);

test('5b SuiteDeps_DeletedOrMoved_RequireWithoutExtensionOrWholeFolder_Runs — un borrado se busca también sin extensión y por la carpeta que se fue', { skip: NO_RULE }, () => {
  const dir = depsRepo({ whole: false });
  // require sin extensión de un módulo que la rama renombra (state.js → store.js) sin tocar a quien lo carga
  putIn(dir, 'scripts/nightly/x/main.js', "const s = require('./state');\n");
  putIn(dir, 'scripts/nightly/x/store.js', 'module.exports = 1;\n');
  putIn(dir, 'scripts/tests/main.test.js', "require('../nightly/x/main.js');\n");
  addSuite(dir, 'main.test.js');
  const renamed = depsPlan(dir, ['scripts/nightly/x/state.js', 'scripts/nightly/x/store.js', 'scripts/lib/util.js']);
  assert.ok(renamed.run.includes('main.test.js'), `require('./state') de un módulo que ya no está: corre\n${renamed.skip.join('\n')}`);
  // una suite que recorre una carpeta entera que la rama movió a otro lado
  putIn(dir, 'scripts/gadgets/alpha.js', 'module.exports = 1;\n');
  putIn(dir, 'scripts/tests/widgets.test.sh', 'for f in "$ROOT/scripts/widgets"/*.js; do node "$f"; done\n');
  addSuite(dir, 'widgets.test.sh');
  const moved = depsPlan(dir, ['scripts/widgets/alpha.js', 'scripts/widgets/beta.js', 'scripts/gadgets/alpha.js', 'scripts/lib/util.js']);
  assert.ok(moved.run.includes('widgets.test.sh'), `la carpeta que nombra se movió: corre\n${moved.skip.join('\n')}`);
  // espejo: lo que no nombra nada de lo borrado sigue salteándose
  assert.ok(moved.skip.some((s) => s.startsWith('SKIP\td.test.js\t')), 'd.test.js no nombra nada de eso: se saltea');
});

test('5b SuiteDeps_UnreadableSuiteOrDependency_Runs — una suite o un archivo que carga que existe y no se deja leer corre, y se dice', { skip: NO_RULE || (!CAN_LOCK && 'NO MEDIDO — sin permisos POSIX para dejar un archivo ilegible (Windows o root)') }, () => {
  const dir = depsRepo({ whole: false });
  putIn(dir, 'scripts/tests/locked.test.sh', 'node "$RAIZ/scripts/lib/thing.js"\n');
  putIn(dir, 'scripts/lib/thing.js', 'module.exports = 1;\n');
  addSuite(dir, 'locked.test.sh');
  putIn(dir, 'scripts/tests/carga.test.js', "require('../lib/cerrada.js');\n");
  const locked = putIn(dir, 'scripts/lib/cerrada.js', "require('./thing.js');\n");
  addSuite(dir, 'carga.test.js');
  const suite = path.join(dir, 'scripts', 'tests', 'locked.test.sh');
  fs.chmodSync(suite, 0o000);
  fs.chmodSync(locked, 0o000);
  try {
    const p = depsPlan(dir, ['scripts/lib/util.js']);
    assert.ok(p.run.includes('locked.test.sh'), `la suite que no se deja leer: RUN\n${p.skip.join('\n')}`);
    assert.ok(p.run.includes('carga.test.js'), `la suite que carga un archivo que no se deja leer: RUN\n${p.skip.join('\n')}`);
    assert.match(p.err, /no se deja leer/, 'y lo dice');
  } finally {
    fs.chmodSync(suite, 0o644);
    fs.chmodSync(locked, 0o644);
  }
});

test('5b SuiteDeps_SuiteOverTheSizeCap_Runs — una suite de más de 2 MB no se lee entera: corre', { skip: NO_RULE }, () => {
  const dir = depsRepo({ whole: false });
  putIn(dir, 'scripts/tests/enorme.test.sh', `# nombra scripts/lib/thing.js\n${'#'.repeat(2 * 1024 * 1024 + 10)}\n`);
  addSuite(dir, 'enorme.test.sh');
  const p = depsPlan(dir, ['scripts/lib/util.js']);
  assert.ok(p.run.includes('enorme.test.sh'), `no se pudo leer entera: corre\n${p.skip.join('\n')}`);
});

test('5b SuitesForChange_UnreadableDocsList_SaysSo — la lista entera ilegible: las pesadas que miran .md corren y se dice', { skip: NO_RULE }, () => {
  const dir = depsRepo({ heavy: true });
  fs.writeFileSync(path.join(dir, 'changed.txt'), 'adapters/x.json\n');
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'ci', 'suites-for-change.js'), '--suites', path.join(dir, 'scripts', 'tests', 'suites.json'),
    '--scripts', path.join(dir, 'scripts'), '--skills', SKILLS, '--heavy', path.join(dir, 'scripts', 'ci', 'heavy-suites.json'),
    '--changed', path.join(dir, 'changed.txt'), '--changed-with-docs', path.join(dir, 'no-existe.txt')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /--changed-with-docs[^\n]*no se deja leer/, 'lo dice');
  assert.match(r.stdout, /^RUN\t[^\n]*export-real\.test\.sh$/m, 'la que mira .md corre: no sabe qué .md cambiaron');
});

// T17 — la contraprueba con la historia: rojos reales del banco nocturno cuyo merge
// causante se identificó leyendo las fotos (`scripts/controls-bench/ultimo-suites.json`) y el commit que los arregló.
// Por cada uno: el árbol de ESE merge (sus suites como eran), el cambio de ESE merge (`<merge>^1..<merge>`) y el selector
// actual con --deps. La suite que se puso roja tiene que estar en RUN. Los rojos de entorno quedan afuera.
// Cada suite va con su nombre actual: el que tenía en ese merge, si se renombró, lo dice el mapa de renombres
// (scripts/lib/renames.json). Escribir acá el nombre viejo lo cuenta el control de menciones viejas.
const HISTORY_REDS = [
  // [merge que la rompió, suite roja (nombre actual), motivo en una línea]
  ['428a980ed3b69f89c4eda5fc0dbf5fc6335f53e1', 'legacy-names-c4.test.js', 'un merge movió carpetas en scripts/lib/renames.json'],
  ['428a980ed3b69f89c4eda5fc0dbf5fc6335f53e1', 'legacy-names.test.js', 'el mismo cambio de renames.json'],
  ['61b88a81544cf26df7fb91736f65adfdbf6e6c3a', 'legacy-names-c0.test.js', 'un merge editó renames.json'],
  ['61b88a81544cf26df7fb91736f65adfdbf6e6c3a', 'legacy-names-c3.test.js', 'un merge editó la suite misma'],
  ['93ffc52b292daa2e279611c380121cc629fbb346', 'legacy-names-env.test.js', 'un merge tocó scripts/install-tycon-hooks.sh, que la suite audita'],
  ['7bc9af180e611c8c399fd1df3e3f19149dd28ad6', 'harness-install.test.sh', 'un merge editó el instalador y la suite'],
  // (export-real.test.sh, la copia pública armada, no está en la lista)
  ['5b3b1db06d079cbc5bc733e11c1f66cf3a149c10', 'clean-machine.test.sh', 'un merge editó INSTALL.md (T37)'],
  ['a4d71e835915e878be24007ccdffe8529148e98e', 'suites-coverage.test.js', 'un merge tocó suites.json sin registrar las suites nuevas'],
  ['70804576878a75e024d5cf6f7bf2cbd160e92450', 'install-guard.test.sh', 'story 6.1 trajo el freno de producción con su suite'],
  ['70804576878a75e024d5cf6f7bf2cbd160e92450', 'tycon-prod-sql.test.sh', 'la misma story 6.1'],
];
const REPO = path.resolve(__dirname, '..', '..');
// nombre actual → los nombres con que pudo estar en un árbol viejo (el actual y los `old` del mapa de renombres)
// el mapa de renombres no viaja a la copia pública: ahí los casos de la historia quedan NO MEDIDOS, no rojos (export-real T23)
const RENAMES_FILE = path.join(REPO, 'scripts', 'lib', 'renames.json');
const RENAMES = fs.existsSync(RENAMES_FILE) ? (JSON.parse(fs.readFileSync(RENAMES_FILE, 'utf8')).entries || []) : null;
const namesOf = (suite) => [suite, ...(RENAMES || []).filter((e) => e.kind === 'file' && e.new === `scripts/tests/${suite}`).map((e) => path.posix.basename(e.old))];
const gitOut =(args) => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const NO_HISTORY = (!RENAMES && 'NO MEDIDO — copia pública sin scripts/lib/renames.json (el mapa de renombres no viaja)')
  || (HISTORY_REDS.some(([c]) => gitOut(['cat-file', '-e', `${c}^{commit}`]).status !== 0)
  && 'NO MEDIDO — este clon no trae los merges de la historia (clon superficial o de otro repo)');

// Los rojos de `reds` que el selector actual, con --deps y el heavy-suites.json del repo, habría salteado en la rama.
function historyMissed(reds) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suites-for-change-history-')));
  clones.push(base);
  fs.writeFileSync(path.join(base, 'nightly.json'), JSON.stringify({ ts: new Date().toISOString(), complete: true, failures: [] }));
  const missed = [];
  for (const merge of [...new Set(reds.map(([c]) => c))]) {
    const tree = path.join(base, merge.slice(0, 8));
    fs.mkdirSync(tree);
    const tar = spawnSync('git', ['-C', REPO, 'archive', '--format=tar', merge, '--', '.', ':!.engram'], { maxBuffer: 512 * 1024 * 1024 });
    assert.strictEqual(tar.status, 0, String(tar.stderr));
    const x = spawnSync('tar', ['-x', '-C', tree], { input: tar.stdout });
    assert.strictEqual(x.status, 0, String(x.stderr));
    const diff = gitOut(['diff', '--name-only', '--no-renames', `${merge}^1`, merge]);
    assert.strictEqual(diff.status, 0, diff.stderr);
    const all = diff.stdout.split('\n').filter(Boolean);
    const code = all.filter((f) => !f.endsWith('.md') || /^(agents|skills|packs)\//.test(f));
    fs.writeFileSync(path.join(tree, '..', `${merge}-all.txt`), `${all.join('\n')}\n`);
    fs.writeFileSync(path.join(tree, '..', `${merge}-code.txt`), `${code.join('\n')}\n`);
    const r = spawnSync(process.execPath, [SCRIPT, '--suites', path.join(tree, 'scripts', 'tests', 'suites.json'), '--scripts', path.join(tree, 'scripts'),
      '--skills', SKILLS, '--changed', path.join(base, `${merge}-code.txt`), '--changed-with-docs', path.join(base, `${merge}-all.txt`),
      '--heavy', path.resolve(__dirname, '..', 'ci', 'heavy-suites.json'), '--deps', '--nightly', path.join(base, 'nightly.json')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /toca cómo se eligen las suites/, `${merge}: el caso no mide nada si el cambio toca el selector (corre todo)`);
    const run = r.stdout.split('\n').filter((l) => l.startsWith('RUN\t')).map((l) => path.basename(l.slice(4)));
    // que --deps esté saltando algo en ese árbol: si corriera todo, el caso pasaría sin medir nada
    assert.ok(r.stdout.split('\n').some((l) => DEPS_SKIP.test(l)), `${merge}: --deps no salteó ninguna suite — el caso no mide nada\n${r.stderr}`);
    for (const [c, suite, why] of reds) if (c === merge && !namesOf(suite).some((n) => run.includes(n))) missed.push(`${suite} (${merge.slice(0, 8)}: ${why})`);
    fs.rmSync(tree, { recursive: true, force: true });
  }
  return missed;
}

// Rearmar los árboles cuesta ~25 s: T17 y T27 comparten una sola corrida sobre todos los casos.
let historyResult = null;
const historyAll = () => historyResult || (historyResult = historyMissed(HISTORY_REDS));

test('T17 SuiteDeps_HistoryReds_WouldHaveRun — cada rojo real del nocturno con su merge causante habría corrido en la rama', { skip: NO_RULE || NO_HISTORY }, () => {
  assert.deepStrictEqual(historyAll(), [], 'rojos del nocturno que --deps habría salteado en la rama');
});

test('T11 — un reads_md que no es true ni false es un archivo roto: corre todo', { skip: NO_RULE }, () => {
  const dir = depsRepo({ heavy: true });
  const file = path.join(dir, 'scripts', 'ci', 'heavy-suites.json');
  const h = JSON.parse(fs.readFileSync(file, 'utf8'));
  h.suites['export-real.test.sh'].reads_md = 'si';
  fs.writeFileSync(file, JSON.stringify(h));
  const p = depsPlan(dir, ['adapters/x.json'], { deps: false });
  assert.strictEqual(p.skip.length, 0, p.err);
  assert.match(p.err, /reads_md/);
});

// Las pesadas también se eligen por lo que usan. Corren si el cambio toca sus
// patrones, la red de `shared` o lo que su código usa (scripts/ci/suite-deps.js). Cada pesada declara `deps`: sin poner,
// el grafo entero; `false`, sólo sus patrones (las que recorren lo que se publica o se instala); `"graph"`, el grafo sin
// el «depende de todo» de un `ls-files`/`grep` que corre sobre un repo de juguete. Sin --deps utilizable corren todas.
const HEAVY_DEPS_SKIP = /\tel cambio no toca lo que mide \([^)]*heavy-suites\.json\) ni nada de lo que usa su código \(scripts\/ci\/suite-deps\.js\): la corre el banco nocturno$/;
const HEAVIES = ['export-real.test.sh', 'harness-plan.test.sh', 'clean-machine.test.sh', 'harness-profile.test.sh', 'harness-channel.test.sh', 'prod-access-guard.test.sh'];
const skipOf = (p, name) => p.skip.find((s) => s.startsWith(`SKIP\t${name}\t`)) || '';

test('T24 SuiteDeps_HeavyRunsOnlyIfItUsesTheChange — la pesada del laboratorio corre por lo que usa, no por la publicación', { skip: NO_RULE }, () => {
  const dir = depsRepo({ heavyDeps: true });
  // un .json de la publicación no arrastra a todas las pesadas por `shared`
  const pub = depsPlan(dir, ['scripts/publishing/allow.json']);
  assert.ok(pub.run.includes('export-real.test.sh'), `la copia pública lo usa: corre\n${pub.err}`);
  assert.match(skipOf(pub, 'harness-plan.test.sh'), HEAVY_DEPS_SKIP, `la del laboratorio no lo usa: se saltea, con el motivo\n${pub.skip.join('\n')}`);
  // lo que la pesada usa (su código lo nombra) la corre aunque no esté en sus patrones ni en la red
  const lib = depsPlan(dir, ['scripts/lib/util.js']);
  assert.ok(lib.run.includes('harness-plan.test.sh'), `scripts/lib/util.js: la del laboratorio lo usa, corre\n${lib.skip.join('\n')}`);
  // `deps: false`: sólo sus patrones — lo que su código nombra no la corre, lo de sus patrones sí
  assert.match(skipOf(lib, 'clean-machine.test.sh'), /\tel cambio no toca lo que mide \([^)]*heavy-suites\.json\): la corre el banco nocturno$/, 'deps: false no mira el grafo');
  assert.ok(depsPlan(dir, ['scripts/hooks/nuevo.js']).run.includes('clean-machine.test.sh'), 'deps: false corre por sus patrones');
  // `deps: "graph"`: el `ls-files` de su laboratorio no la hace depender de todo; lo que nombra, sí la corre
  assert.match(skipOf(lib, 'harness-profile.test.sh'), HEAVY_DEPS_SKIP, `"graph": no depende de todo\n${lib.skip.join('\n')}`);
  assert.ok(depsPlan(dir, ['scripts/hooks/guard-lib.js']).run.includes('harness-profile.test.sh'), '"graph": lo que carga un guion que nombra la corre');
  // la misma suite sin el campo sigue dependiendo de todo (el lector no sabe que el repo es de juguete)
  assert.ok(lib.run.includes('harness-channel.test.sh'), 'sin `deps`, un ls-files en la suite la corre siempre');
});

test('T25 SuiteDeps_HeavySharedNet_StillRuns — la red corre todas; sin --deps utilizable, también', { skip: NO_RULE }, () => {
  const dir = depsRepo({ heavyDeps: true });
  const net = depsPlan(dir, ['scripts/setup/install.sh']);
  for (const n of HEAVIES) assert.ok(net.run.includes(n), `un cambio en la red (scripts/setup/**): ${n} corre\n${net.skip.join('\n')}`);
  // sin --deps, sin foto, con la foto vieja o tocando la selección: los patrones solos no alcanzan, corren todas
  const cases = [
    [depsPlan(dir, ['scripts/publishing/allow.json'], { deps: false }), 'sin --deps'],
    [depsPlan(dir, ['scripts/publishing/allow.json'], { photo: false }), 'sin foto nocturna'],
    [depsPlan(dir, ['scripts/publishing/allow.json', 'scripts/ci/suite-deps.js']), 'el cambio toca la selección'],
  ];
  nightly(dir, { complete: false, ageHours: 10 });
  cases.push([depsPlan(dir, ['scripts/publishing/allow.json']), 'foto incompleta']);
  for (const [p, why] of cases) {
    for (const n of HEAVIES) assert.ok(p.run.includes(n), `${why}: ${n} corre\n${p.skip.join('\n')}\n${p.err}`);
    assert.match(p.err, /sin --deps utilizable, \d+ pesada\(s\) que no tocan lo que miden corren igual: sus patrones ya no alcanzan solos \(/, `${why}: y lo dice`);
  }
  // `deps` con otro valor: el archivo está roto, corre todo y se dice
  nightly(dir, { complete: true, ageHours: 10 });
  const file = path.join(dir, 'scripts', 'ci', 'heavy-suites.json');
  const h = JSON.parse(fs.readFileSync(file, 'utf8'));
  h.suites['harness-plan.test.sh'].deps = 'a veces';
  fs.writeFileSync(file, JSON.stringify(h));
  const broken = depsPlan(dir, ['scripts/publishing/allow.json']);
  assert.strictEqual(broken.skip.length, 0, broken.err);
  assert.match(broken.err, /«harness-plan\.test\.sh» trae «deps» que no es true, false ni "graph"/);
});

test('T27 SuiteDeps_HistoryHeavyReds_WouldHaveRun — los rojos de pesadas de la historia, con la red achicada', { skip: NO_RULE || NO_HISTORY }, () => {
  const real = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'ci', 'heavy-suites.json'), 'utf8'));
  for (const p of ['scripts/lib/**', 'scripts/publishing/**', 'pipelines/**', 'skills/**', 'agents/**']) {
    assert.ok(!real.shared.patterns.includes(p), `la contraprueba mide la red achicada: ${p} ya no está en shared`);
  }
  const heavyReds = HISTORY_REDS.filter(([, suite]) => namesOf(suite).some((n) => real.suites[n]));
  // tres: el instalador, la máquina limpia y el freno de producción
  assert.ok(heavyReds.length >= 3, `los rojos de pesadas de la historia (${heavyReds.length})`);
  const missed = historyAll().filter((m) => heavyReds.some(([, suite]) => m.startsWith(`${suite} (`)));
  assert.deepStrictEqual(missed, [], 'rojos de pesadas que la rama habría salteado con la red achicada');
});

test('T38 SuiteDeps_ManualModePrintsDepsAndVerdict — el modo a mano lista lo que usa y dice si el cambio la toca', () => {
  const dir = depsRepo();
  const tool = path.join(dir, 'scripts', 'ci', 'suite-deps.js');
  const run = (...a) => spawnSync(process.execPath, [tool, ...a], { encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'ch.txt'), 'scripts/lib/util.js\n');
  const hit = run(dir, 'scripts/tests/a.test.js', '--changed', path.join(dir, 'ch.txt'));
  assert.strictEqual(hit.status, 0, hit.stderr);
  assert.match(hit.stdout, /^scripts\/tests\/a\.test\.js: \d+ archivo\(s\), \d+ carpeta\(s\)$/m);
  assert.match(hit.stdout, /^ {2}archivo {2}scripts\/lib\/util\.js$/m, 'lista lo que carga');
  assert.match(hit.stdout, /^el cambio la toca: corre$/m);
  fs.writeFileSync(path.join(dir, 'ch.txt'), 'scripts/sin-uso.js\n');
  assert.match(run(dir, 'scripts/tests/a.test.js', '--changed', path.join(dir, 'ch.txt')).stdout, /^el cambio no la toca$/m);
  assert.match(run(dir, 'scripts/tests/c.test.js').stdout, /TODO el repo \(lista los archivos\)/, 'la que lista el repo lo dice');
  const usage = run();
  assert.strictEqual(usage.status, 2);
  assert.match(usage.stderr, /^uso: suite-deps\.js/);
});

// Las carpetas de datos no eligen pesadas por el grafo
// (`deps_ignore`); un borrado de un .md se busca también para la pesada que mira .md; un `"graph"` cuyo código cambió
// (`graph_whole_lines` no coincide) vuelve a depender de todo y lo dice.
test('5b SuiteDeps_HeavyDataFoldersDoNotChoose — .engram/ y .advisors/ no corren pesadas por lo que su código nombra', { skip: NO_RULE }, () => {
  const dir = depsRepo({ heavyDeps: true });
  for (const f of ['.advisors/dod-runtime/keep.md', '.advisors/pipeline-runs/x/findings.json', '.engram/manifest.json']) {
    const p = depsPlan(dir, [f], { docs: [f] });
    assert.match(skipOf(p, 'harness-plan.test.sh'), HEAVY_DEPS_SKIP, `${f}: la del laboratorio no corre por una carpeta de datos\n${p.skip.join('\n')}\n${p.err}`);
  }
  // espejo: lo que sí usa, la sigue corriendo
  assert.ok(depsPlan(dir, ['scripts/lib/util.js']).run.includes('harness-plan.test.sh'));
  // y una pesada que pone esa carpeta en sus patrones, corre
  const file = path.join(dir, 'scripts', 'ci', 'heavy-suites.json');
  const h = JSON.parse(fs.readFileSync(file, 'utf8'));
  h.suites['harness-plan.test.sh'].patterns.push('.engram/**');
  fs.writeFileSync(file, JSON.stringify(h));
  assert.ok(depsPlan(dir, ['.engram/manifest.json']).run.includes('harness-plan.test.sh'), 'en sus patrones: corre');
});

test('5b SuiteDeps_HeavyThatReadsMd_DeletedMdRuns — borrar o mover una guía que la pesada lee la corre', { skip: NO_RULE }, () => {
  const dir = depsRepo({ heavyDeps: true });
  fs.rmSync(path.join(dir, 'guides', 'guard.md'));
  const p = depsPlan(dir, ['scripts/lib/util.js'], { docs: ['scripts/lib/util.js', 'guides/guard.md', 'guides/guard-nueva.md'] });
  assert.ok(p.run.includes('prod-access-guard.test.sh'), `la guía que lee ya no está: corre\n${p.skip.join('\n')}`);
  // espejo: con la guía en su lugar y sin tocarla, se saltea
  fs.writeFileSync(path.join(dir, 'guides', 'guard.md'), '# guía\n');
  assert.match(skipOf(depsPlan(dir, ['scripts/lib/util.js'], { docs: ['scripts/lib/util.js'] }), 'prod-access-guard.test.sh'), HEAVY_DEPS_SKIP);
});

test('SuiteDeps_GraphLinesChanged_DependsOnEverythingAndSaysSo — un «graph» cuyo código cambió vuelve a depender de todo', { skip: NO_RULE }, () => {
  const dir = depsRepo({ heavyDeps: true });
  assert.match(skipOf(depsPlan(dir, ['scripts/lib/util.js']), 'harness-profile.test.sh'), HEAVY_DEPS_SKIP, 'con el número de hoy: graph');
  fs.appendFileSync(path.join(dir, 'scripts', 'tests', 'harness-profile.test.sh'), 'git ls-files "$RAIZ" | wc -l\n');
  const p = depsPlan(dir, ['scripts/lib/util.js']);
  assert.ok(p.run.includes('harness-profile.test.sh'), `una línea nueva que recorre el repo: depende de todo\n${p.skip.join('\n')}`);
  assert.match(p.err, /harness-profile\.test\.sh: graph_whole_lines dice 1 y su código tiene 2 línea\(s\) que recorren el repo: depende de todo hasta que alguien la revise/);
});

// Los caminos de error de los dos campos nuevos y de la revisión del «graph».
test('SuiteDeps_HeavyNewFieldsBrokenOrUnreadable_RunEverythingAndSaySo — deps_ignore o graph_whole_lines mal escritos, un graph sin número o ilegible', { skip: NO_RULE }, () => {
  const file = (dir) => path.join(dir, 'scripts', 'ci', 'heavy-suites.json');
  const edit = (dir, fn) => { const h = JSON.parse(fs.readFileSync(file(dir), 'utf8')); fn(h); fs.writeFileSync(file(dir), JSON.stringify(h)); };
  // archivo roto: corre todo y nombra la clave
  for (const [fn, why] of [
    [(h) => { h.deps_ignore = { patterns: '.engram/**' }; }, /«deps_ignore» no trae una lista «patterns»/],
    [(h) => { h.deps_ignore = { patterns: ['/abs/**'] }; }, /«deps_ignore» trae patrones que no se pueden interpretar/],
    [(h) => { h.suites['harness-profile.test.sh'].graph_whole_lines = '1'; }, /«harness-profile\.test\.sh» trae «graph_whole_lines» que no es un entero desde 0/],
    [(h) => { h.suites['harness-profile.test.sh'].graph_whole_sha = 'abc'; }, /«harness-profile\.test\.sh» trae «graph_whole_sha» que no son 12 caracteres hexadecimales/],
  ]) {
    const dir = depsRepo({ heavyDeps: true });
    edit(dir, fn);
    const p = depsPlan(dir, ['scripts/lib/util.js']);
    assert.strictEqual(p.skip.length, 0, `${why}: corre todo\n${p.err}`);
    assert.match(p.err, why);
  }
  // un «graph» sin número: depende de todo y lo dice
  const none = depsRepo({ heavyDeps: true });
  edit(none, (h) => { delete h.suites['harness-profile.test.sh'].graph_whole_lines; });
  const n = depsPlan(none, ['scripts/lib/util.js']);
  assert.ok(n.run.includes('harness-profile.test.sh'), `sin graph_whole_lines: corre\n${n.skip.join('\n')}`);
  assert.match(n.err, /harness-profile\.test\.sh: graph_whole_lines dice nada y su código tiene 1 línea\(s\) que recorren el repo: depende de todo/);
});

test('SuiteDeps_GraphSuiteUnreadable_RunsAndSaysSo — un «graph» cuyo archivo no se deja leer corre', { skip: NO_RULE || (!CAN_LOCK && 'NO MEDIDO — sin permisos POSIX para dejar un archivo ilegible (Windows o root)') }, () => {
  const dir = depsRepo({ heavyDeps: true });
  const suite = path.join(dir, 'scripts', 'tests', 'harness-profile.test.sh');
  fs.chmodSync(suite, 0o000);
  try {
    const p = depsPlan(dir, ['scripts/lib/util.js']);
    assert.ok(p.run.includes('harness-profile.test.sh'), `ilegible: corre\n${p.skip.join('\n')}`);
    assert.match(p.err, /harness-profile\.test\.sh: graph_whole_lines dice 1 y su código tiene ¿\?/);
  } finally {
    fs.chmodSync(suite, 0o644);
  }
});

// El «graph» se revisa por el contenido de esas líneas, no sólo por cuántas son.
test('SuiteDeps_GraphLineReplaced_DependsOnEverythingAndSaysSo — reemplazar una línea que recorre el repo por otra, mismo número', { skip: NO_RULE }, () => {
  const dir = depsRepo({ heavyDeps: true });
  const suite = path.join(dir, 'scripts', 'tests', 'harness-profile.test.sh');
  const before = depsPlan(dir, ['scripts/lib/util.js']);
  assert.match(skipOf(before, 'harness-profile.test.sh'), HEAVY_DEPS_SKIP, `con la huella de hoy: graph\n${before.err}`);
  fs.writeFileSync(suite, fs.readFileSync(suite, 'utf8').replace('harness_lab_git "$LAB" ls-files', 'git -C "$RAIZ" ls-files'));
  const p = depsPlan(dir, ['scripts/lib/util.js']);
  assert.ok(p.run.includes('harness-profile.test.sh'), `la línea cambió (mismo número): depende de todo\n${p.skip.join('\n')}`);
  assert.match(p.err, /harness-profile\.test\.sh: las líneas que recorren el repo cambiaron \(graph_whole_sha\): depende de todo hasta que alguien la revise/);
});

// ── las que pasan de 45 s y van al nocturno no corren en la rama ──────────────────────────
const OVER_SKIP = /^SKIP\t[^\t]+\tpasa de 45 s: la corre el nocturno$/;
const overOf = (suites) => ({ limit_seconds: 45, weight_set: 'pr', suites });
const TO_NIGHTLY = { nightly: true, why: 'un solo paso largo que no se parte: la corre el banco nocturno' };

test('T29 SuitesOverLimit_NightlyOnes_SkippedInBranch — una suite marcada «nightly» se saltea aunque el cambio la toque, con su motivo', { skip: NO_RULE }, () => {
  const dir = depsRepo({ gated: true, heavy: true });
  // (1) una común, que el cambio toca por lo que carga y por ella misma
  const over = overOf({ 'a.test.js': TO_NIGHTLY });
  for (const changed of [['scripts/lib/util.js'], ['scripts/tests/a.test.js']]) {
    const p = depsPlan(dir, changed, { over });
    assert.ok(!p.run.includes('a.test.js'), `${changed}: no corre en la rama\n${p.err}`);
    assert.match(skipOf(p, 'a.test.js'), OVER_SKIP, `${changed}: el motivo exacto`);
  }
  // el espejo: sin la marca, ese mismo cambio la corre; y otra suite no se entera
  assert.ok(depsPlan(dir, ['scripts/lib/util.js'], { over: overOf({}) }).run.includes('a.test.js'), 'sin la marca corre');
  assert.ok(depsPlan(dir, ['scripts/publishing/export.js'], { over }).run.includes('d.test.js'), 'las demás siguen su criterio');
  // (2) una con criterio propio y una pesada, tocadas en lo que miden
  const p2 = depsPlan(dir, ['scripts/hooks/guard.js', 'scripts/publishing/export.js'], { over: overOf({ 'g.test.js': TO_NIGHTLY, 'export-real.test.sh': TO_NIGHTLY }) });
  assert.match(skipOf(p2, 'g.test.js'), OVER_SKIP, 'la de gate_only_when_touching');
  assert.match(skipOf(p2, 'export-real.test.sh'), OVER_SKIP, 'la pesada');
  assert.doesNotMatch(p2.err, /export-real\.test\.sh, que no está en suites\.json/, 'la pesada salteada no se da por renombrada');
  // (3) una excepción firmada NO saltea: la suite corre como siempre
  const signed = overOf({ 'a.test.js': { exception: { signed_by: 'el dueño del arnés', date: '2026-10-07', why: 'espera al laboratorio común' } } });
  assert.ok(depsPlan(dir, ['scripts/lib/util.js'], { over: signed }).run.includes('a.test.js'), 'con excepción firmada corre');
});

test('T29 — sin saber qué cambió corre también la del nocturno; y con el plan vacío, la del nocturno sigue salteada', { skip: NO_RULE }, () => {
  // sin la suite que lista el repo entero, que corre siempre: así el plan puede quedar vacío
  const dir = depsRepo({ whole: false });
  const over = overOf({ 'a.test.js': TO_NIGHTLY });
  const all = depsPlan(dir, [], { list: false, over });
  assert.ok(all.run.includes('a.test.js'), `sin lista de cambios no se saltea nada\n${all.skip.join('\n')}`);
  // caso (f): nadie usa lo que cambió → corre todo, menos lo que la rama no corre nunca
  const nobody = depsPlan(dir, ['scripts/sin-uso.js'], { over });
  assert.match(nobody.err, /con --deps no quedaba ninguna suite: corre todo/);
  assert.ok(!nobody.run.includes('a.test.js') && nobody.run.includes('b.test.sh'), `corre todo salvo la del nocturno: ${nobody.run}`);
  assert.match(skipOf(nobody, 'a.test.js'), OVER_SKIP);
});

test('T29 — una lista que no se deja leer, mal formada o que no está no saltea ninguna, y se dice', { skip: NO_RULE }, () => {
  const dir = depsRepo();
  for (const [what, over] of [
    ['no es JSON', '{ "suites": '],
    ['una excepción sin firma', overOf({ 'a.test.js': TO_NIGHTLY, 'b.test.sh': { exception: { date: '2026-10-07', why: 'x' } } })],
    ['no está', false],
  ]) {
    const p = depsPlan(dir, ['scripts/lib/util.js'], { over });
    assert.ok(p.run.includes('a.test.js'), `${what}: la marcada corre igual`);
    assert.match(p.err, /suites-over-limit\.json.*no salteo ninguna por el límite/, `${what}: se dice\n${p.err}`);
  }
});

// ── una PARTE se elige por su archivo entero ─────────────
// Una suite partida es un archivo entero con todas sus pruebas y N partes de una línea. Lo registrado son las partes,
// y el selector no las puede mirar como si fueran toda la suite: «la propia suite» es el archivo entero, y el lector
// de dependencias arranca en el entero (con todos sus niveles y su «recorre el repo entero»), no en la parte.
// Sin esto, editar el archivo entero de una suite partida saltea sus partes, y una partida sin criterio propio deja
// de correr con cambios en lo que su código usa.
const PARTS_LIB = path.resolve(__dirname, 'lib');
function partsRepo() {
  const dir = depsRepo({ whole: false });
  const put = (rel, body) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  for (const f of ['suite-parts.js', 'suite-parts.sh']) put(`scripts/tests/lib/${f}`, fs.readFileSync(path.join(PARTS_LIB, f), 'utf8'));
  put('scripts/tests/suite-parts.json', JSON.stringify({ suites: { 'gated.test.js': { parts: 2, seconds: {} }, 'plain.test.js': { parts: 2, seconds: {} } } }));
  // con criterio propio (gate_only_when_touching) · sin criterio: nombra un guion que carga otro · una que recorre el
  // repo entero · una pesada. Las partes, de UNA línea y sin comentario: quien las ata al entero es su nombre.
  put('scripts/tests/gated.test.js', "const test = require('./lib/suite-parts.js').test;\nconst e = path.join(ROOT, 'scripts', 'publishing', 'export.js');\n");
  put('scripts/tests/plain.test.js', "const test = require('./lib/suite-parts.js').test;\nspawnSync('node', ['scripts/hooks/guard.js']);\nspawnSync('bash', ['scripts/setup/install.sh']);\n");
  put('scripts/setup/install.sh', 'node "$RAIZ/scripts/sin-uso.js"\n');
  put('scripts/tests/lister.test.sh', '. "$DIR/lib/suite-parts.sh"\nsuite_parts 2\nif suite_part 1; then git -C "$RAIZ" ls-files; fi\nif suite_part 2; then echo b; fi\n');
  put('scripts/tests/heavyp.test.sh', '. "$DIR/lib/suite-parts.sh"\nsuite_parts 2\nif suite_part 1; then node "$RAIZ/scripts/hooks/guard.js"; fi\nif suite_part 2; then echo b; fi\n');
  const added = [];
  for (const [base, gate] of [['gated.test.js', ['scripts/setup/**']], ['plain.test.js', null], ['lister.test.sh', null], ['heavyp.test.sh', null]]) {
    for (const k of [1, 2]) {
      const part = base.replace(/\.test\./, `.p${k}.test.`);
      put(`scripts/tests/${part}`, base.endsWith('.js') ? "require('./lib/suite-parts.js').runPart(__filename);\n"
        : `#!/usr/bin/env bash\nSUITE_PART=${k}/2 exec bash "$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/${base}"\n`);
      added.push({ raiz: 'arnes', ruta: `tests/${part}`, requiere: [], ...(gate ? { gate_only_when_touching: gate } : {}) });
    }
  }
  const suitesFile = path.join(dir, 'scripts/tests/suites.json');
  const suites = JSON.parse(fs.readFileSync(suitesFile, 'utf8'));
  suites.diarias.push(...added);
  fs.writeFileSync(suitesFile, JSON.stringify(suites));
  // la pesada: sus partes llevan sólo su propio archivo como patrón (el entero NO está entre los patrones)
  fs.writeFileSync(path.join(dir, 'scripts/ci/heavy-suites.json'), JSON.stringify({ shared: { patterns: ['scripts/nada/**'] }, suites: {
    'heavyp.p1.test.sh': { patterns: ['scripts/tests/heavyp.p1.test.sh'] }, 'heavyp.p2.test.sh': { patterns: ['scripts/tests/heavyp.p2.test.sh'] } } }));
  return dir;
}
const partsOf = (p, stem) => p.run.filter((n) => n.startsWith(`${stem}.p`)).sort();
const both = (stem, ext) => [`${stem}.p1.test.${ext}`, `${stem}.p2.test.${ext}`];

test('5b SuiteParts_WholeFileTouched_RunsItsParts — editar el archivo entero corre sus partes: con criterio propio, sin él, y pesada', { skip: NO_RULE }, () => {
  const dir = partsRepo();
  for (const [changed, stem, ext, why] of [
    [['scripts/tests/gated.test.js'], 'gated', 'js', 'con gate_only_when_touching: antes las dos partes salían SKIP'],
    [['scripts/tests/plain.test.js'], 'plain', 'js', 'sin criterio propio'],
    [['scripts/tests/lister.test.sh'], 'lister', 'sh', 'de consola'],
    [['scripts/tests/heavyp.test.sh'], 'heavyp', 'sh', 'pesada, sin el entero entre sus patrones'],
  ]) {
    const p = depsPlan(dir, changed);
    assert.deepStrictEqual(partsOf(p, stem), both(stem, ext), `${why} (${changed})\n${p.skip.join('\n')}\n${p.err}`);
  }
  // sin --deps, la de criterio propio también: ese camino no pasa por las dependencias
  assert.deepStrictEqual(partsOf(depsPlan(dir, ['scripts/tests/gated.test.js'], { deps: false }), 'gated'), both('gated', 'js'), 'sin --deps');
});

test('5b SuiteParts_PartsMachineryTouched_RunsEveryPart — cambiar el reparto o la biblioteca de partes corre las partes que dependen de eso', { skip: NO_RULE }, () => {
  const dir = partsRepo();
  const registry = depsPlan(dir, ['scripts/tests/suite-parts.json']);
  assert.deepStrictEqual(partsOf(registry, 'gated'), both('gated', 'js'), `el reparto (suite-parts.json), con criterio propio\n${registry.skip.join('\n')}`);
  assert.deepStrictEqual(partsOf(registry, 'plain'), both('plain', 'js'), 'el reparto, sin criterio');
  const libJs = depsPlan(dir, ['scripts/tests/lib/suite-parts.js']);
  assert.deepStrictEqual([...partsOf(libJs, 'gated'), ...partsOf(libJs, 'plain')], [...both('gated', 'js'), ...both('plain', 'js')], `la biblioteca de Node\n${libJs.skip.join('\n')}`);
  const libSh = depsPlan(dir, ['scripts/tests/lib/suite-parts.sh']);
  assert.deepStrictEqual([...partsOf(libSh, 'heavyp'), ...partsOf(libSh, 'lister')], [...both('heavyp', 'sh'), ...both('lister', 'sh')], `la biblioteca de consola\n${libSh.skip.join('\n')}`);
});

test('5b SuiteParts_DepsAreTheWholeFiles — una parte depende de lo que usa su archivo entero, a la misma profundidad que una suite sin partir', { skip: NO_RULE }, () => {
  const dir = partsRepo();
  // el entero nombra guard.js, que carga guard-lib.js: desde la parte eso queda un nivel más abajo y tiene que seguirse
  const lib = depsPlan(dir, ['scripts/hooks/guard-lib.js']);
  assert.deepStrictEqual(partsOf(lib, 'plain'), both('plain', 'js'), `lo que carga un guion que el entero nombra\n${lib.skip.join('\n')}`);
  assert.deepStrictEqual(partsOf(lib, 'heavyp'), both('heavyp', 'sh'), 'la pesada, por lo que usa su entero');
  assert.deepStrictEqual(partsOf(lib, 'gated'), [], 'la de criterio propio sigue su criterio: no toca scripts/setup/**');
  // el entero nombra install.sh: lo que ESE guion nombra (sin-uso.js) cuenta, como en una suite sin partir
  const named = depsPlan(dir, ['scripts/sin-uso.js']);
  assert.deepStrictEqual(partsOf(named, 'plain'), both('plain', 'js'), `lo que nombra un guion que el entero nombra\n${named.skip.join('\n')}`);
  // el entero recorre el repo (ls-files): sus partes dependen de todo, como dependía él
  const any = depsPlan(dir, ['scripts/publishing/export.js']);
  assert.deepStrictEqual(partsOf(any, 'lister'), both('lister', 'sh'), `la que lista el repo corre con cualquier cambio\n${any.skip.join('\n')}`);
  // y el espejo: lo que el entero no usa no corre sus partes
  assert.deepStrictEqual(partsOf(any, 'plain'), [], 'un cambio que el entero no usa no la corre');
  assert.deepStrictEqual(partsOf(any, 'heavyp'), [], 'ni a la pesada');
});

// Caso: el archivo entero BORRADO o movido en el mismo cambio. Las partes siguen registradas
// y ya no tienen qué cargar: tienen que correr (y salir rojas), no saltearse hasta el nocturno.
test('5b SuiteParts_WholeFileDeleted_RunsItsParts — borrar o mover el archivo entero corre sus partes, que quedaron sin qué cargar', { skip: NO_RULE }, () => {
  for (const [stem, ext] of [['gated', 'js'], ['plain', 'js'], ['heavyp', 'sh']]) {
    const dir = partsRepo();
    fs.rmSync(path.join(dir, 'scripts', 'tests', `${stem}.test.${ext}`));
    const p = depsPlan(dir, [`scripts/tests/${stem}.test.${ext}`]);
    assert.deepStrictEqual(partsOf(p, stem), both(stem, ext), `${stem}: el entero se fue\n${p.skip.join('\n')}\n${p.err}`);
  }
});

// Qué ES una parte no lo dice sólo el nombre.
test('5b SuiteParts_NameLooksLikeAPartButIsNot_KeepsItsOwnDeps — una suite que sólo se LLAMA como una parte se mira por su propio código', { skip: NO_RULE }, () => {
  const dir = partsRepo();
  const put = (rel, body) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  // una suite común y corriente que se llama odd.p1.test.js, al lado de un odd.test.js que no tiene nada que ver
  put('scripts/tests/odd.p1.test.js', "require('../lib/util.js');\n");
  put('scripts/tests/odd.test.js', "const e = path.join(ROOT, 'scripts', 'publishing', 'export.js');\n");
  const suitesFile = path.join(dir, 'scripts/tests/suites.json');
  const suites = JSON.parse(fs.readFileSync(suitesFile, 'utf8'));
  suites.diarias.push({ raiz: 'arnes', ruta: 'tests/odd.p1.test.js', requiere: [] }, { raiz: 'arnes', ruta: 'tests/odd.test.js', requiere: [] });
  fs.writeFileSync(suitesFile, JSON.stringify(suites));
  const mine = depsPlan(dir, ['scripts/lib/util.js']);
  assert.ok(mine.run.includes('odd.p1.test.js'), `usa util.js de verdad: antes se la ataba a odd.test.js y salía SKIP\n${mine.skip.join('\n')}`);
  const theirs = depsPlan(dir, ['scripts/publishing/export.js']);
  assert.ok(!theirs.run.includes('odd.p1.test.js') && theirs.run.includes('odd.test.js'), 'y lo que usa la otra no la corre a ella');
});

test('5b SuiteParts_PartFileMissing_Runs — una parte registrada que no está en disco corre (y quien la corre dice «NO se midió»), aunque su entero esté', { skip: NO_RULE }, () => {
  const dir = partsRepo();
  fs.rmSync(path.join(dir, 'scripts/tests/plain.p1.test.js'));
  const p = depsPlan(dir, ['scripts/publishing/export.js']);
  assert.ok(p.run.includes('plain.p1.test.js'), `la que falta corre\n${p.skip.join('\n')}`);
  assert.ok(!p.run.includes('plain.p2.test.js'), 'la que está sigue su criterio');
});

test('5b SuiteParts_SkillsRoot_WholeFileTouched_RunsItsParts — una suite partida de la carpeta de skills también se mira por su archivo entero', { skip: NO_RULE }, () => {
  const PARTE = 'tycon-pipeline/scripts/tests/sk.p1.test.js';
  const w = workClone({ suites: { diarias: [
    { raiz: 'arnes', ruta: 'tests/fast.test.js', requiere: [] },
    { raiz: 'agent-skills', ruta: PARTE, requiere: [], gate_only_when_touching: ['scripts/publishing/**'] },
  ] } });
  const put = (rel, body) => { const f = path.join(w.clone, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  put(`skills/${PARTE}`, "require('./lib/suite-parts.js').runPart(__filename);\n");
  put('skills/tycon-pipeline/scripts/tests/sk.test.js', "const test = require('./lib/suite-parts.js').test;\n");
  const other = plan(w, { changed: ['guides/x.md'] });
  assert.match(other.skip.join('\n'), /^SKIP\tsk\.p1\.test\.js\t/m, 'lo que no la toca la difiere');
  const whole = plan(w, { changed: ['skills/tycon-pipeline/scripts/tests/sk.test.js'] });
  assert.ok(whole.run.includes(path.join(w.clone, 'skills', PARTE)), `editar el entero corre la parte\n${whole.skip.join('\n')}`);
});
