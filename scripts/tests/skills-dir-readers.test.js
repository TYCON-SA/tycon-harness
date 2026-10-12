'use strict';
/**
 * skills-dir-readers.test.js — quien le pregunta a `skills-dir.js` dónde están las skills no se traga su error
 * (story 8.18, deuda `[DEF-8.18-lectores-que-tragan]` · 2026-10-04).
 *
 * EL CASO. `resolveSkillsDirs()` ahora TIRA cuando la biblioteca que le dice si el clon es unido (`canonical-path.js`)
 * está y no carga: antes contestaba «no es unido» y se leían las skills INSTALADAS en la máquina, callado. El pase
 * adversarial del tramo 1 encontró que varios lectores envuelven la llamada y siguen con el valor de siempre —un
 * `catch` genérico, o `2>/dev/null || true` desde bash—: con la biblioteca rota decían «agent-skills no está en esta
 * máquina», o directamente «todo verde», sin nombrar la causa. «No pude mirar» nunca es «no hay».
 *
 * Acá se miden los dos guiones de prueba que no tienen otra suite donde vivir:
 *   · `integrations-off.test.sh`   — con la biblioteca rota sale distinto de 0 con «NO MEDIDO — no pude resolver la
 *                                    carpeta de skills: <causa>»; antes decía «agent-skills no está en esta máquina».
 *   · `third-party-origin.test.sh` — con la biblioteca rota sale 2 (NO MEDIDO) ANTES de preguntarle nada a la red;
 *                                    antes seguía con la carpeta vacía y podía terminar en «todo verde».
 *   · `clean-machine.test.sh`      — el bloque del modo interno, recortado (la suite entera usa docker): con la
 *                                    biblioteca rota dice «no pude resolver la carpeta de skills: <causa>»; antes,
 *                                    «modo interno sin agent-skills».
 *   · `legacy-names-install.test.sh` — con la biblioteca rota dice la causa y sale distinto de 0; antes caía a
 *                                    `~/.claude/agent-skills` y medía las skills instaladas.
 *   · `controls-bench/runner.js`   — el respaldo a la ruta instalada queda sólo para «skills-dir.js no está» (el clon
 *                                    viejo); lo demás tira. Antes un `catch` genérico se tragaba todo.
 *   · `third-party-real.test.sh`   — con la biblioteca rota sale 2 (NO MEDIDO) con la causa, aunque esté parada en un
 *                                    repo de git (pase adversarial del tramo 2, clase 12: con la carpeta vacía,
 *                                    `git -C ""` operaba sobre ese repo y la guarda «no encontré agent-skills» pasaba).
 *   · los lectores de las suites largas (githook-livefire, export-real, mirror-pipeline): por la forma de la llamada,
 *     porque correrlas con la biblioteca rota no cabe en una prueba (clases 4 y 7 del mismo pase).
 * Los demás lectores de la deuda se miden donde ya vive cada uno: `public-ci.test.sh`, `profile-equivalence.test.sh`
 * y `eol.test.js`.
 *
 * Cada caso arma un clon de juguete con una copia del guion, de `scripts/lib/skills-dir.js` y de lo que importa, y
 * una HOME de juguete: nada toca la máquina ni la red (`GIT_ALLOW_PROTOCOL=file`). Cada «esto NO pasa» lleva su
 * espejo: la carpeta que de verdad no está se sigue diciendo como «no está», y con la biblioteca sana el guion pasa
 * de la resolución.
 *
 * Correr: node --test scripts/tests/skills-dir-readers.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sinGitDelPadre } = require('../lib/clean-git-env.js');

const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib');
// lo que `skills-dir.js` importa para saber si su clon es unido, y lo que importa ése: viajan juntos
const LIB_FILES = ['skills-dir.js', 'canonical-path.js', 'legacy-names.js'];
const BROKEN = 'biblioteca rota a propósito';

const labs = [];
test.after(() => { for (const d of labs) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * Un clon de juguete con el guion `script` (ruta relativa a la raíz) y una HOME de juguete.
 *   unified:   el clon trae skills/tycon-pipeline y agents/ (el repo unido)
 *   installed: la HOME trae ~/.claude/agent-skills/skills/tycon-pipeline (adonde caería quien se traga el error)
 *   broken:    canonical-path.js está y rompe al cargarse
 */
function lab(script, { unified = false, installed = false, broken = false, extra = [] } = {}) {
  // realpath: en macOS la carpeta temporal es un enlace, y node resuelve los enlaces de lo que importa
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-readers-')));
  labs.push(dir);
  const clone = path.join(dir, 'clone');
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(clone, 'scripts', 'lib'), { recursive: true });
  for (const f of LIB_FILES) fs.copyFileSync(path.join(LIB, f), path.join(clone, 'scripts', 'lib', f));
  if (broken) fs.writeFileSync(path.join(clone, 'scripts', 'lib', 'canonical-path.js'), `throw new Error("${BROKEN}")\n`);
  if (unified) {
    fs.mkdirSync(path.join(clone, 'skills', 'tycon-pipeline'), { recursive: true });
    fs.mkdirSync(path.join(clone, 'agents'), { recursive: true });
  }
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
  const inst = path.join(home, '.claude', 'agent-skills');
  if (installed) fs.mkdirSync(path.join(inst, 'skills', 'tycon-pipeline'), { recursive: true });
  const target = path.join(clone, script);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(ROOT, script), target);
  // lo que el guion importa además de la biblioteca (rutas relativas a la raíz): viaja con él
  for (const f of extra) {
    fs.mkdirSync(path.dirname(path.join(clone, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(clone, f));
  }
  return { dir, clone, home, inst, target };
}

/** Corre el guion del clon de juguete: sin la variable, con la HOME de juguete y sin poder salir a la red. */
function run(l, args = [], { cmd = 'bash', env: more = {}, cwd = l.dir } = {}) {
  const env = { ...sinGitDelPadre(process.env), HOME: l.home, USERPROFILE: l.home, TMPDIR: path.join(l.home, 'tmp'),
    GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', TYCON_NO_NIGHTLY_EXAM: '1', TYCON_NO_GUI_ENV: '1', ...more };
  delete env.TYCON_SKILLS_DIR;
  delete env.TYCON_GUIDES_DIR;
  const r = spawnSync(cmd === 'node' ? process.execPath : cmd, [l.target, ...args], { encoding: 'utf8', env, cwd, timeout: 120000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Un repo de git con un commit, al lado del clon de juguete: la carpeta donde está parada la prueba. */
function gitRepoBeside(l) {
  const work = path.join(l.dir, 'work');
  fs.mkdirSync(work);
  const env = { ...sinGitDelPadre(process.env), HOME: l.home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.email=l@l', '-c', 'user.name=l', 'commit', '-q', '--allow-empty', '-m', 'base']]) {
    const r = spawnSync('git', ['-C', work, ...args], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  }
  return work;
}

/** El guion vive en este repo (en una copia que no lo trae, la prueba lo dice y no mide). */
function present(t, script) {
  if (fs.existsSync(path.join(ROOT, script))) return true;
  t.skip(`NO MEDIDO: ${script} no viaja en esta copia`);
  return false;
}

// ── integrations-off.test.sh ────────────────────────────────────────────────────────────────────────────────────────

const INTEGRATIONS = 'scripts/tests/integrations-off.test.sh';

test('SkillsReaders_IntegrationsOff_BrokenNeighbor — con la biblioteca vecina rota dice «no pude resolver» con la causa y sale distinto de 0', (t) => {
  // 🔴 rojo previo: `2>/dev/null || true` → la carpeta queda vacía y el guion dice «agent-skills no está en esta
  //    máquina»: manda a instalar algo que está, y calla que la biblioteca del clon no carga.
  if (!present(t, INTEGRATIONS)) return;
  const r = run(lab(INTEGRATIONS, { unified: true, installed: true, broken: true }));
  assert.notStrictEqual(r.code, 0, r.out);
  assert.match(r.out, /NO MEDIDO — no pude resolver la carpeta de skills: /, r.out);
  assert.ok(r.out.includes(BROKEN), `nombra la causa: ${r.out}`);
  assert.doesNotMatch(r.out, /agent-skills no está en esta máquina/, 'no lo confunde con «no está»');
  assert.doesNotMatch(r.out, /✅/, 'y no mide nada después');
});

test('SkillsReaders_IntegrationsOff_TrulyAbsent — el espejo: la carpeta que de verdad no está se sigue diciendo «no está»', (t) => {
  if (!present(t, INTEGRATIONS)) return;
  const r = run(lab(INTEGRATIONS));   // biblioteca sana, clon sin skills/, nada instalado
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /NO MEDIDO — agent-skills no está en esta máquina/, r.out);
  assert.doesNotMatch(r.out, /no pude resolver/, r.out);
});

// ── third-party-origin.test.sh ──────────────────────────────────────────────────────────────────────────────────────

const ORIGIN = 'scripts/tests/third-party-origin.test.sh';

test('SkillsReaders_ThirdPartyOrigin_BrokenNeighbor — con la biblioteca vecina rota sale 2 (NO MEDIDO) con la causa, antes de preguntarle nada a la red', (t) => {
  // 🔴 rojo previo: `2>/dev/null` → la carpeta queda vacía, T9 dice «no encontré … (sin ubicar)» sin sumar nada, y el
  //    guion puede cerrar con «todo verde».
  if (!present(t, ORIGIN)) return;
  const r = run(lab(ORIGIN, { unified: true, installed: true, broken: true }));
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /NO MEDIDO — no pude resolver la carpeta de skills: /, r.out);
  assert.ok(r.out.includes(BROKEN), `nombra la causa: ${r.out}`);
  assert.doesNotMatch(r.out, /T20|T9|todo verde/, 'corta antes de medir: no hay ningún veredicto debajo');
});

test('SkillsReaders_ThirdPartyOrigin_HealthyNeighbor — el espejo: con la biblioteca sana pasa de la resolución y mira el propio clon', (t) => {
  if (!present(t, ORIGIN)) return;
  const l = lab(ORIGIN, { unified: true, installed: true });
  const r = run(l);
  assert.doesNotMatch(r.out, /no pude resolver/, r.out);
  // el clon de juguete no trae la skill derivada: T9 lo dice nombrando la carpeta que resolvió, que es el propio clon
  assert.ok(r.out.includes(`en agent-skills (${l.clone})`), `resolvió el propio clon: ${r.out}`);
});

// ── third-party-real.test.sh ────────────────────────────────────────────────────────────────────────────────────────

const THIRD_REAL = 'scripts/tests/third-party-real.test.sh';

test('SkillsReaders_ThirdPartyReal_BrokenNeighbor — con la biblioteca vecina rota sale 2 (NO MEDIDO) con la causa, aunque esté parada en un repo de git', (t) => {
  // 🔴 rojo previo (pase adversarial del tramo 2, clase 12): la carpeta salía del lector sin mirar su código de salida.
  //    Con la biblioteca rota quedaba vacía, y `git -C ""` opera sobre el repo donde está parada la prueba: la guarda
  //    «no encontré agent-skills» pasaba y la prueba seguía —con el commit suelto del retiro escribiendo objetos ahí—.
  //    En este laboratorio seguía hasta el manifiesto y salía 1 con un rojo que no nombraba la causa.
  if (!present(t, THIRD_REAL)) return;
  const l = lab(THIRD_REAL, { unified: true, installed: true, broken: true });
  const r = run(l, [], { cwd: gitRepoBeside(l) });
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /NO MEDIDO — no pude resolver la carpeta de skills: /, r.out);
  assert.ok(r.out.includes(BROKEN), `nombra la causa: ${r.out}`);
  assert.doesNotMatch(r.out, /manifiesto|retiro|❌/, 'corta antes de mirar nada: no hay ningún veredicto debajo');
});

test('SkillsReaders_ThirdPartyReal_HealthyNeighbor — el espejo: con la biblioteca sana resuelve el propio clon y su guarda decide', (t) => {
  if (!present(t, THIRD_REAL)) return;
  const l = lab(THIRD_REAL, { unified: true, installed: true });
  const r = run(l);
  assert.doesNotMatch(r.out, /no pude resolver/, r.out);
  // el clon de juguete no es un repo de git: la guarda de siempre lo dice, nombrando la carpeta que resolvió
  assert.strictEqual(r.code, 2, r.out);
  assert.ok(r.out.includes(`no encontré agent-skills en ${l.clone}`), `resolvió el propio clon: ${r.out}`);
});

// ── los lectores de bash dentro de suites largas: la forma de la llamada ───────────────────────────────────────────

test('SkillsReaders_ShellReaders_DoNotSwallow — los lectores de las suites largas miran el código de salida y dicen la causa', (t) => {
  // 🔴 rojo previo (pase adversarial del tramo 2, clases 4, 7 y 12): `2>/dev/null`, `|| true` o `|| echo <ruta
  //    instalada>`. Con la biblioteca rota, githook-livefire seguía con el pre-commit INSTALADO (C-06 a C-08) y salteaba
  //    C-23/C-24 con un aviso, y terminaba en «todo verde»; export-real y mirror-pipeline lo decían como «agent-skills
  //    no está». Estas suites tardan minutos y arman repos enteros: correrlas con la biblioteca rota no cabe en una
  //    prueba; se mide la forma de cada llamada. third-party-real tiene además su prueba de conducta, arriba.
  const readers = ['scripts/tests/githook-livefire.test.sh', 'scripts/tests/export-real.test.sh',
    'scripts/tests/mirror-pipeline.test.sh', THIRD_REAL].filter((f) => fs.existsSync(path.join(ROOT, f)));
  if (!readers.length) { t.skip('NO MEDIDO: las suites no viajan en esta copia'); return; }
  let calls = 0;
  for (const f of readers) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/resolveSkillsDirs\(/.test(line) || /^\s*#/.test(line)) return;
      calls += 1;
      const where = `${f}:${i + 1}`;
      assert.doesNotMatch(line, /2>\s*\/dev\/null|\|\|\s*true|\|\|\s*echo/, `${where}: se traga el error de la biblioteca`);
      assert.match(line, /^\s*if ! [A-Z_]+="\$\(node -e /, `${where}: no mira el código de salida del lector`);
      const after = lines.slice(i, i + 4).join('\n');
      assert.match(after, /no pude resolver la carpeta de skills: /, `${where}: al fallar no dice la causa`);
    });
  }
  // el espejo: la prueba encontró los lectores que dice mirar (dos en githook-livefire, uno en cada una de las otras)
  assert.ok(calls >= readers.length + 1, `encontré ${calls} llamada(s) en ${readers.length} suite(s)`);
});

// ── las suites del renombre: dónde está agent-skills lo contesta la regla común, no cada una a su modo ──────────────

test('SkillsReaders_LegacyNamesSuites_UseCommonRule — las suites del renombre ubican agent-skills por la regla común, no por la ruta instalada escrita a mano', (t) => {
  // 🔴 rojo previo (medido el 2026-10-04, sin variables y con una HOME vacía, en un clon unido): c4 salteaba 4 pruebas
  //    con «sin agent-skills», d1 salteaba 3 y d2 una, con las skills en su propia raíz. Y en una máquina con el clon de
  //    skills de antes todavía instalado, medían ESE clon y no el de trabajo. Cada una tenía su `skillsRoot()` con
  //    `~/.claude/agent-skills` escrito; la regla es una sola (la variable › el propio clon si es unido › lo instalado).
  // c3 se sumó en el arreglo X3 (pase adversarial del tramo 2, clase 3): era la quinta con la ruta escrita a mano.
  const suites = ['c3', 'c4', 'd1', 'd2', 'f'].map((s) => `scripts/tests/legacy-names-${s}.test.js`).filter((f) => fs.existsSync(path.join(ROOT, f)));
  if (!suites.length) { t.skip('NO MEDIDO: las suites del renombre no viajan en esta copia'); return; }
  for (const f of suites) {
    const body = /function skillsRoot\(\) \{[\s\S]*?\n\}/.exec(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.ok(body, `${f}: no encontré su skillsRoot() (si cambió de forma, re-apuntar esta prueba)`);
    assert.match(body[0], /resolveSkillsDirs\(process\.env\.TYCON_SKILLS_DIR \|\| ''\)/, `${f}: skillsRoot() le pregunta a scripts/lib/skills-dir.js`);
    assert.doesNotMatch(body[0], /homedir\(\)|agent-skills'/, `${f}: skillsRoot() no escribe la ruta instalada a mano`);
    assert.doesNotMatch(body[0], /\bcatch\b/, `${f}: y no se traga el error de la biblioteca`);
  }
});

// ── clean-machine.test.sh: el bloque que ubica agent-skills, recortado (la suite entera usa docker) ─────────────────

const CLEAN = 'scripts/tests/clean-machine.test.sh';

/**
 * Corre SÓLO el bloque del modo interno que le pregunta a la biblioteca dónde está agent-skills, sacado del guion tal
 * como está (desde la línea `SK_REPO=` hasta el `fi` de «modo interno sin agent-skills»), con un `unable` como el del
 * guion: la suite entera necesita docker y no se corre acá. Si el bloque cambió de forma, el recorte lo dice.
 */
function runCleanBlock(l) {
  const src = fs.readFileSync(l.target, 'utf8');
  const m = /^[ \t]*(?:if ! )?SK_REPO="\$\(node [\s\S]*?modo interno sin agent-skills[^\n]*\n[ \t]*fi\n/m.exec(src);
  assert.ok(m, `${CLEAN}: no encontré el bloque que ubica agent-skills (si cambió de forma, re-apuntar esta prueba)`);
  const harness = path.join(l.dir, 'clean-block.sh');
  fs.writeFileSync(harness, [
    'set -uo pipefail',
    'unable() { echo "⏭ clean-machine: NO MEDIDO — $1"; exit 1; }',
    `ROOT=${JSON.stringify(l.clone)}`,
    `T=${JSON.stringify(path.join(l.dir, 't'))}; mkdir -p "\${T}"`,
    m[0],
    'echo "RESOLVED:${SK_REPO}"',
    '',
  ].join('\n'));
  return run({ ...l, target: harness });
}

test('SkillsReaders_CleanMachine_BrokenNeighbor — con la biblioteca vecina rota el modo interno dice «no pude resolver» con la causa, no «sin agent-skills»', (t) => {
  // 🔴 rojo previo: `2>/dev/null || true` → la carpeta queda vacía y el guion dice «modo interno sin agent-skills
  //    (TYCON_SKILLS_DIR o ~/.claude/agent-skills)»: manda a buscar un repo que está, y calla la causa.
  if (!present(t, CLEAN)) return;
  const r = runCleanBlock(lab(CLEAN, { unified: true, installed: true, broken: true }));
  assert.notStrictEqual(r.code, 0, r.out);
  assert.match(r.out, /NO MEDIDO — no pude resolver la carpeta de skills: /, r.out);
  assert.ok(r.out.includes(BROKEN), `nombra la causa: ${r.out}`);
  assert.doesNotMatch(r.out, /modo interno sin agent-skills/, 'no lo confunde con «no está»');
  assert.doesNotMatch(r.out, /RESOLVED:/, 'y no sigue con una carpeta');
});

test('SkillsReaders_CleanMachine_HealthyAndAbsent — el espejo: con la biblioteca sana resuelve el propio clon, y la carpeta que no está se sigue diciendo «sin agent-skills»', (t) => {
  if (!present(t, CLEAN)) return;
  const sane = lab(CLEAN, { unified: true, installed: true });
  const syntax = spawnSync('bash', ['-n', sane.target], { encoding: 'utf8' });
  assert.strictEqual(syntax.status, 0, `el guion entero se deja leer por bash: ${syntax.stderr}`);
  const r = runCleanBlock(sane);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes(`RESOLVED:${sane.clone}`), `resolvió el propio clon: ${r.out}`);
  const absent = runCleanBlock(lab(CLEAN));   // biblioteca sana, clon sin skills/, nada instalado
  assert.strictEqual(absent.code, 1, absent.out);
  assert.match(absent.out, /NO MEDIDO — modo interno sin agent-skills/, absent.out);
  assert.doesNotMatch(absent.out, /no pude resolver/, absent.out);
});

// ── legacy-names-install.test.sh ────────────────────────────────────────────────────────────────────────────────────

const INSTALL = 'scripts/tests/legacy-names-install.test.sh';
const INSTALL_EXTRA = ['scripts/tests/lib/fake-home.sh'];

test('SkillsReaders_LegacyNamesInstall_BrokenNeighbor — con la biblioteca vecina rota dice la causa y sale distinto de 0, sin caer a la ruta instalada', (t) => {
  // 🔴 rojo previo: `2>/dev/null` y, con la salida vacía, `SKILLS_REPO="$HOME/.claude/agent-skills"`: medía las skills
  //    INSTALADAS en vez de las del clon, y con nada seleccionado cerraba «todo verde».
  if (!present(t, INSTALL)) return;
  const r = run(lab(INSTALL, { unified: true, installed: true, broken: true, extra: INSTALL_EXTRA }), ['--only', 'NINGUNA']);
  assert.notStrictEqual(r.code, 0, r.out);
  assert.match(r.out, /NO MEDIDO — no pude resolver la carpeta de skills: /, r.out);
  assert.ok(r.out.includes(BROKEN), `nombra la causa: ${r.out}`);
  assert.doesNotMatch(r.out, /todo verde/, 'corta antes de medir: no hay ningún veredicto debajo');
});

test('SkillsReaders_LegacyNamesInstall_HealthyNeighbor — el espejo: con la biblioteca sana pasa de la resolución', (t) => {
  if (!present(t, INSTALL)) return;
  const r = run(lab(INSTALL, { unified: true, installed: true, extra: INSTALL_EXTRA }), ['--only', 'NINGUNA']);
  assert.strictEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /no pude resolver/, r.out);
  assert.match(r.out, /legacy-names-install: todo verde/, r.out);
});

// ── controls-bench/runner.js ────────────────────────────────────────────────────────────────────────────────────────

const RUNNER = 'scripts/controls-bench/runner.js';
const RUNNER_EXTRA = ['scripts/controls-bench/report-name.js', 'scripts/lib/clean-git-env.js', 'scripts/lib/git-bash.js'];

/** `runner.js --list` sobre una carpeta de casos vacía: lo único que puede fallar es dónde están las skills. */
function runBench(l) {
  const cases = path.join(l.dir, 'cases');
  fs.mkdirSync(cases, { recursive: true });
  return run(l, ['--list'], { cmd: 'node', env: { TYCON_BENCH_CASES_DIR: cases } });
}

test('SkillsReaders_BenchRunner_BrokenNeighbor — con la biblioteca vecina rota el banco no arranca con las skills instaladas: tira con la causa', (t) => {
  // 🔴 rojo previo: `catch { return ~/.claude/agent-skills }` → con la vecina rota el banco medía las skills
  //    INSTALADAS y no las del clon, con código 0 y sin nombrar la causa.
  if (!present(t, RUNNER)) return;
  const r = runBench(lab(RUNNER, { unified: true, installed: true, broken: true, extra: RUNNER_EXTRA }));
  assert.notStrictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes(BROKEN), `nombra la causa: ${r.out}`);
});

test('SkillsReaders_BenchRunner_LibraryLoadsBroken — skills-dir.js que está y no carga tampoco es «no está»: tira', (t) => {
  // 🔴 rojo previo: el mismo `catch` genérico leía un `require` roto adentro de skills-dir.js como «clon viejo».
  if (!present(t, RUNNER)) return;
  const l = lab(RUNNER, { unified: true, installed: true, extra: RUNNER_EXTRA });
  fs.writeFileSync(path.join(l.clone, 'scripts', 'lib', 'skills-dir.js'), "require('./falta-a-proposito.js');\n");
  const r = runBench(l);
  assert.notStrictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes('falta-a-proposito'), `nombra lo que falta: ${r.out}`);
});

test('SkillsReaders_BenchRunner_HealthyAndMissingLibrary — el espejo: con la biblioteca sana arranca, y sin skills-dir.js (el clon viejo) cae a la ruta instalada como siempre', (t) => {
  if (!present(t, RUNNER)) return;
  const sane = runBench(lab(RUNNER, { unified: true, installed: true, extra: RUNNER_EXTRA }));
  assert.strictEqual(sane.code, 0, sane.out);
  const old = lab(RUNNER, { installed: true, extra: RUNNER_EXTRA });
  fs.rmSync(path.join(old.clone, 'scripts', 'lib', 'skills-dir.js'));
  const r = runBench(old);
  assert.strictEqual(r.code, 0, r.out);
});
