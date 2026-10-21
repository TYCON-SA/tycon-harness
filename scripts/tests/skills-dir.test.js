'use strict';
/**
 * skills-dir.test.js — dónde busca el arnés las skills, y en qué orden (T10 · contrato C3).
 *
 * Los dos repos internos (el arnés y agent-skills) están unidos en uno, con `skills/` y `agents/`
 * en la raíz. Si `resolveSkillsDirs()` sin variable contestara siempre `~/.claude/agent-skills`, una prueba corrida en
 * un clon de trabajo del repo unido leería las skills INSTALADAS en la máquina y daría verde sin haber probado el
 * cambio. La regla: la variable › el propio clon si es unido › lo instalado.
 *
 * Lo que no puede pasar:
 *   · que una máquina con dos repos físicos (arnés sin `skills/` + `~/.claude/agent-skills`) cambie en algo;
 *   · que quien ESCRIBE rutas en la máquina (los desplegadores del lado Codex) empiece a escribir la del clon del
 *     arnés apenas ese clon traiga `skills/`, con el clon de skills de siempre todavía instalado:
 *     para ellos está `resolveInstalledSkillsDirs()`;
 *   · que la forma de pedirlo desde bash conteste una ruta que no existe con código 0.
 *
 * El «propio clon» sale de dónde vive el archivo, así que cada caso arma un clon de juguete con una copia de
 * `scripts/lib/skills-dir.js` (y de lo que importa) y lo corre desde ahí, con una HOME de juguete.
 *
 * Correr: node --test scripts/tests/skills-dir.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib');
// lo que `skills-dir.js` importa para saber si su clon es unido (`isSingleRepo`, de canonical-path.js) y lo que
// importa ése: viajan juntos al clon de juguete
const LIB_FILES = ['skills-dir.js', 'canonical-path.js', 'legacy-names.js'];

const labs = [];
test.after(() => { for (const d of labs) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * Un laboratorio: un clon de juguete y una HOME de juguete.
 *   unified:   el clon trae skills/tycon-pipeline y agents/ (el repo unido)
 *   skillsOnly: el clon trae skills/tycon-pipeline pero NO agents/ (no es unido)
 *   installed: la HOME trae ~/.claude/agent-skills/skills/tycon-pipeline (el clon de skills de siempre)
 */
function lab({ unified = false, skillsOnly = false, installed = false } = {}) {
  // realpath: en macOS la carpeta temporal es un enlace, y node resuelve los enlaces de lo que importa
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-dir-')));
  labs.push(dir);
  const clone = path.join(dir, 'clone');
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(clone, 'scripts', 'lib'), { recursive: true });
  for (const f of LIB_FILES) fs.copyFileSync(path.join(LIB, f), path.join(clone, 'scripts', 'lib', f));
  if (unified || skillsOnly) fs.mkdirSync(path.join(clone, 'skills', 'tycon-pipeline'), { recursive: true });
  if (unified) fs.mkdirSync(path.join(clone, 'agents'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const inst = path.join(home, '.claude', 'agent-skills');
  if (installed) fs.mkdirSync(path.join(inst, 'skills', 'tycon-pipeline'), { recursive: true });
  return { dir, clone, home, inst, script: path.join(clone, 'scripts', 'lib', 'skills-dir.js') };
}

function envOf(l, variable) {
  const env = { ...process.env, HOME: l.home, USERPROFILE: l.home };
  delete env.TYCON_SKILLS_DIR;
  if (variable !== undefined) env.TYCON_SKILLS_DIR = variable;
  return env;
}

/** Llama a una función del módulo del clon de juguete, en otro proceso (la HOME y la variable son las del caso). */
function call(l, { fn = 'resolveSkillsDirs', variable, arg } = {}) {
  const code = 'const m = require(process.argv[1]); const a = JSON.parse(process.argv[3]);'
    + 'process.stdout.write(JSON.stringify(m[process.argv[2]](...a)));';
  const r = spawnSync(process.execPath, ['-e', code, l.script, fn, JSON.stringify(arg === undefined ? [] : [arg])],
    { encoding: 'utf8', env: envOf(l, variable) });
  assert.strictEqual(r.status, 0, `${fn}() no contestó: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** El modo de línea de comandos: lo que usa el instalador desde bash. */
function cli(l, args, variable) {
  const r = spawnSync(process.execPath, [l.script, ...args], { encoding: 'utf8', env: envOf(l, variable) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// ── T10 · el orden: la variable › el propio clon si es unido › lo instalado ─────────────────────────────────────────

test('T10 SkillsDir_OwnCloneFirst_VariableWins_FallbackInstalled — con la variable como RAÍZ, gana la variable (aunque el clon sea unido y haya algo instalado)', () => {
  // 🔴 rojo: mirar el propio clon antes que la variable → sale `clone`.
  const l = lab({ unified: true, installed: true });
  const other = path.join(l.dir, 'other');
  fs.mkdirSync(path.join(other, 'skills', 'x'), { recursive: true });
  const r = call(l, { variable: other });
  assert.deepStrictEqual(r, { repo: other, skills: path.join(other, 'skills'), source: 'variable' });
});

test('T10 — con la variable como CARPETA de skills, gana la variable y la raíz es su padre', () => {
  const l = lab({ unified: true, installed: true });
  const other = path.join(l.dir, 'other');
  fs.mkdirSync(path.join(other, 'skills', 'x'), { recursive: true });
  const r = call(l, { variable: path.join(other, 'skills') });
  assert.deepStrictEqual(r, { repo: other, skills: path.join(other, 'skills'), source: 'variable' });
});

test('T10 — sin variable, en un clon unido: el propio clon, aunque en la máquina haya un agent-skills instalado', () => {
  // 🔴 rojo: sin variable contesta siempre ~/.claude/agent-skills → una prueba
  //    corrida en el clon de trabajo lee las skills instaladas.
  const l = lab({ unified: true, installed: true });
  const r = call(l);
  assert.deepStrictEqual(r, { repo: l.clone, skills: path.join(l.clone, 'skills'), source: 'own-clone' });
});

test('T10 — sin variable, en un clon SIN skills/ (la máquina del equipo de hoy): ~/.claude/agent-skills, como siempre', () => {
  // el espejo sano: con dos repos físicos nada cambia
  const l = lab({ installed: true });
  const r = call(l);
  assert.deepStrictEqual(r, { repo: l.inst, skills: path.join(l.inst, 'skills'), source: 'installed' });
  // y sin nada instalado contesta la misma ruta (no la inventa en otro lado): quien la usa ve que no existe
  const l2 = lab();
  assert.deepStrictEqual(call(l2), { repo: l2.inst, skills: path.join(l2.inst, 'skills'), source: 'installed' });
});

test('T10 — un clon con skills/ pero sin agents/ NO es unido: sigue lo instalado (el criterio es isSingleRepo, no «hay skills/»)', () => {
  // 🔴 rojo: decidir por `fs.existsSync(<clon>/skills)` en vez de importar isSingleRepo.
  const l = lab({ skillsOnly: true, installed: true });
  assert.strictEqual(call(l).source, 'installed');
});

test('T10 — el valor pasado por argumento manda sobre el entorno; vacío es «sin variable»', () => {
  // así lo llaman ~30 lugares: resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || '')
  const l = lab({ unified: true, installed: true });
  const other = path.join(l.dir, 'other');
  fs.mkdirSync(path.join(other, 'skills'), { recursive: true });
  assert.strictEqual(call(l, { arg: '' }).source, 'own-clone', 'vacío no es una ruta: es «sin variable»');
  assert.strictEqual(call(l, { arg: '', variable: other }).source, 'own-clone', 'el argumento vacío manda sobre el entorno');
  assert.strictEqual(call(l, { arg: other }).repo, other);
});

test('T10 — el propio clon de ESTA ejecución: unido → él mismo; si no, lo instalado', () => {
  const { resolveSkillsDirs } = require(path.join(LIB, 'skills-dir.js'));
  const { isSingleRepo } = require(path.join(LIB, 'canonical-path.js'));
  const r = resolveSkillsDirs('');
  if (isSingleRepo(ROOT)) assert.deepStrictEqual(r, { repo: ROOT, skills: path.join(ROOT, 'skills'), source: 'own-clone' });
  else assert.strictEqual(r.source, 'installed');
});

test('T10 — una copia SUELTA del archivo (sin canonical-path.js al lado) no es un clon: contesta lo instalado y no tira', () => {
  // 🔴 rojo: importar canonical-path.js sin más → MODULE_NOT_FOUND en cada lugar que copia este archivo solo:
  //    el freno de producción instalado (/opt/tycon/lib), deploy-codex-copies.test.sh, mirror.test.js, public-ci.test.sh.
  //    Con dos repos físicos esos lugares tienen que seguir funcionando igual.
  const l = lab({ unified: true, installed: true });
  fs.rmSync(path.join(l.clone, 'scripts', 'lib', 'canonical-path.js'));
  assert.deepStrictEqual(call(l), { repo: l.inst, skills: path.join(l.inst, 'skills'), source: 'installed' });
  assert.deepStrictEqual(cli(l, ['--repo']), { code: 0, out: l.inst + '\n', err: '' });
  // y la variable sigue ganando, sin necesitar a nadie
  const other = path.join(l.dir, 'other');
  fs.mkdirSync(path.join(other, 'skills'), { recursive: true });
  assert.strictEqual(call(l, { variable: other }).repo, other);
});

// ── la vecina que ESTÁ y no carga ───────────────────────────────────────────────────────────────────────────────────
// La vecina que ESTÁ y no carga porque a su cadena de `require` le falta un archivo no se lee como «no es unido»: si el
// `catch` dejara pasar todo MODULE_NOT_FOUND como «copia incompleta», en un clon unido un `require` roto en
// legacy-names.js haría que `--source` contestara «installed» con código 0 y que el corredor de suites corriera la
// suite INSTALADA y diera verde. «No es unido» es sólo «canonical-path.js no está»; todo lo demás es un error que se dice.

/** Llama a resolveSkillsDirs() del clon de juguete sin exigir que conteste: devuelve el código de salida y lo que escribió. */
function attempt(l, { variable } = {}) {
  const code = 'process.stdout.write(JSON.stringify(require(process.argv[1]).resolveSkillsDirs()))';
  const r = spawnSync(process.execPath, ['-e', code, l.script], { encoding: 'utf8', env: envOf(l, variable) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
/** Le agrega a una biblioteca del clon de juguete un `require` a un archivo que no existe (el cambio bajo prueba que se rompió). */
function breakRequire(l, file, missing) {
  const f = path.join(l.clone, 'scripts', 'lib', file);
  const body = fs.readFileSync(f, 'utf8');
  const anchor = "const path = require('path');";
  assert.ok(body.includes(anchor), `${file}: no encontré dónde insertar el require roto`);
  fs.writeFileSync(f, body.replace(anchor, `${anchor}\nconst moved = require('./${missing}');`));
}

test('5b-19 SkillsDir_NeighborPresentButBroken_ThrowsNamingTheMissingFile — legacy-names.js ESTÁ y un require suyo no existe: tira y nombra el archivo, no contesta «installed»', () => {
  // 🔴 rojo: `if (e.code === 'MODULE_NOT_FOUND') return false` → contesta «installed» con código 0.
  const l = lab({ unified: true, installed: true });
  assert.strictEqual(attempt(l).code, 0, 'control: el clon sano contesta');
  assert.strictEqual(call(l).source, 'own-clone', 'control: y contesta el propio clon');
  breakRequire(l, 'legacy-names.js', 'renamed-helper-that-moved.js');
  const r = attempt(l);
  assert.notStrictEqual(r.code, 0, `tenía que tirar y contestó: ${r.out}`);
  assert.strictEqual(r.out, '', 'sin respuesta: quien la captura no se queda con las skills instaladas');
  assert.match(r.err, /renamed-helper-that-moved\.js/, 'nombra el archivo que falta');
  assert.match(r.err, /canonical-path\.js/, 'y la vecina que no cargó');
  // lo mismo desde bash: ni «installed» ni código 0
  for (const opt of ['--source', '--skills', '--repo']) {
    const c = cli(l, [opt]);
    assert.notStrictEqual(c.code, 0, `${opt} salió 0 con: ${c.out}`);
    assert.strictEqual(c.out, '', `${opt} no imprime ruta ni regla`);
    assert.match(c.err, /renamed-helper-that-moved\.js/);
  }
});

test('5b-19 — canonical-path.js ESTÁ y falta legacy-names.js (lo que importa): tira y nombra a legacy-names.js', () => {
  // 🔴 rojo: tratar la copia incompleta como «no es un clon» → installed. El caso a propósito —la copia del freno de
  //    producción en /opt— viaja SIN canonical-path.js: ése se prueba arriba.
  const l = lab({ unified: true, installed: true });
  fs.rmSync(path.join(l.clone, 'scripts', 'lib', 'legacy-names.js'));
  const r = attempt(l);
  assert.notStrictEqual(r.code, 0, `tenía que tirar y contestó: ${r.out}`);
  assert.strictEqual(r.out, '');
  assert.match(r.err, /legacy-names\.js/);
  assert.match(r.err, /canonical-path\.js/);
});

test('5b-19 — el require roto en la propia canonical-path.js: también tira y lo nombra', () => {
  const l = lab({ unified: true, installed: true });
  breakRequire(l, 'canonical-path.js', 'gone-with-the-rename.js');
  const r = attempt(l);
  assert.notStrictEqual(r.code, 0, `tenía que tirar y contestó: ${r.out}`);
  assert.match(r.err, /gone-with-the-rename\.js/);
});

test('5b-19 — los espejos sanos: con la vecina rota la variable sigue ganando sin cargarla, y sin la vecina sigue «installed»', () => {
  const l = lab({ unified: true, installed: true });
  breakRequire(l, 'legacy-names.js', 'renamed-helper-that-moved.js');
  const other = path.join(l.dir, 'other');
  fs.mkdirSync(path.join(other, 'skills'), { recursive: true });
  const v = attempt(l, { variable: other });
  assert.deepStrictEqual([v.code, v.err], [0, ''], 'con la variable no hace falta saber si el clon es unido');
  assert.strictEqual(JSON.parse(v.out).repo, other);
  // quien ESCRIBE rutas en la máquina y tiene algo instalado tampoco la necesita
  assert.strictEqual(call(l, { fn: 'resolveInstalledSkillsDirs' }).source, 'installed');
  // la vecina AUSENTE (la copia de /opt): «no es unido», sin error
  fs.rmSync(path.join(l.clone, 'scripts', 'lib', 'canonical-path.js'));
  assert.deepStrictEqual(attempt(l), { code: 0, out: JSON.stringify({ repo: l.inst, skills: path.join(l.inst, 'skills'), source: 'installed' }), err: '' });
});

test('T10 — un canonical-path.js que está pero ROMPE al cargarse no se lee como «no es unido»: el error sale', () => {
  // 🔴 rojo: un `catch` que traga todo → una biblioteca rota en el clon hace que se lean las skills instaladas,
  //    callado: vuelve el verde que no probó nada.
  const l = lab({ unified: true, installed: true });
  fs.writeFileSync(path.join(l.clone, 'scripts', 'lib', 'canonical-path.js'), 'throw new Error("biblioteca rota a propósito")\n');
  const code = 'require(process.argv[1]).resolveSkillsDirs()';
  const r = spawnSync(process.execPath, ['-e', code, l.script], { encoding: 'utf8', env: envOf(l) });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /biblioteca rota a propósito/);
});

// ── I12 · quien ESCRIBE rutas en la máquina sigue escribiendo la instalada mientras exista ──────────────────────────

test('I12 SkillsDir_Installed_TwoClonesKeepInstalledPath — con dos clones, resolveInstalledSkillsDirs() da ~/.claude/agent-skills y no el clon del arnés', () => {
  // 🔴 rojo: que los desplegadores usen resolveSkillsDirs() → apenas el clon del arnés trae skills/, escriben
  //    su ruta en ~/.codex/hooks.json y re-enlazan ~/.codex/skills, con la llave apagada.
  const l = lab({ unified: true, installed: true });
  assert.strictEqual(call(l).source, 'own-clone', 'quien LEE mira su clon');
  assert.deepStrictEqual(call(l, { fn: 'resolveInstalledSkillsDirs' }),
    { repo: l.inst, skills: path.join(l.inst, 'skills'), source: 'installed' });
});

test('I12 — ~/.claude/agent-skills como ENLACE al clon unido: se escribe la ruta del enlace, no la del clon', () => {
  // la máquina de un solo clon: la ruta estable es el enlace (el clon puede vivir en cualquier carpeta)
  const l = lab({ unified: true });
  fs.mkdirSync(path.dirname(l.inst), { recursive: true });
  fs.symlinkSync(l.clone, l.inst, 'junction');
  assert.strictEqual(call(l, { fn: 'resolveInstalledSkillsDirs' }).repo, l.inst);
});

test('I12 — sin nada instalado: el propio clon si es unido; y la variable gana siempre', () => {
  const l = lab({ unified: true });
  assert.deepStrictEqual(call(l, { fn: 'resolveInstalledSkillsDirs' }),
    { repo: l.clone, skills: path.join(l.clone, 'skills'), source: 'own-clone' });
  const l2 = lab({ unified: true, installed: true });
  const other = path.join(l2.dir, 'other');
  fs.mkdirSync(path.join(other, 'skills'), { recursive: true });
  assert.deepStrictEqual(call(l2, { fn: 'resolveInstalledSkillsDirs', variable: other }),
    { repo: other, skills: path.join(other, 'skills'), source: 'variable' });
  // con dos repos físicos las dos funciones contestan lo mismo
  const l3 = lab({ installed: true });
  assert.deepStrictEqual(call(l3, { fn: 'resolveInstalledSkillsDirs' }), call(l3));
});

// ── un lector que arma la ruta a su modo: el medidor de etapas ────────────────────────────────────────────

test('AC 13 SkillsDir_StageMetrics_FindsDiscoveryByTheRule — sin variable, el medidor de etapas usa el descubridor de stories del propio clon unido, no el instalado', (t) => {
  // 🔴 rojo: `process.env.TYCON_SKILLS_DIR || ~/.claude/agent-skills/skills` en scripts/metrics/sdlc-stage-metrics.js
  //    → sin variable busca el descubridor instalado (acá, uno que rompe a propósito), cae al escaneo plano y lo dice
  //    nombrando la carpeta instalada.
  const { isSingleRepo } = require(path.join(LIB, 'canonical-path.js'));
  if (!isSingleRepo(ROOT)) { t.skip('NO MEDIDO — este clon no es unido: con dos repos el descubridor instalado ES la respuesta, y no hay con qué distinguirlo'); return; }
  const { sinGitDelPadre } = require(path.join(LIB, 'clean-git-env.js'));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-dir-metrics-')));
  labs.push(dir);
  const home = path.join(dir, 'home');
  const installedLib = path.join(home, '.claude', 'agent-skills', 'skills', 'tycon-pipeline', 'scripts', 'lib');
  fs.mkdirSync(installedLib, { recursive: true });
  fs.writeFileSync(path.join(installedLib, 'story-discovery.js'),
    'module.exports = { findRepoRoot() { return null; }, discoverStories() { throw new Error("descubridor INSTALADO: roto a propósito"); } };\n');
  // un repo mínimo con una story, con git de verdad: entorno limpio y configuración aislada
  const env = sinGitDelPadre({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  delete env.TYCON_SKILLS_DIR;
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dashboard'));
  fs.writeFileSync(path.join(repo, 'specs', 'story-t1.md'), '---\nstory: T-1\nepic: 1\nstatus: done\n---\n\n# Story T-1\n');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'una story');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'metrics', 'sdlc-stage-metrics.js'), '--repo', repo, '--dashboard', path.join(dir, 'dashboard'), '--json'],
    { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes(installedLib), `no buscó el descubridor instalado: ${r.stderr}`);
  assert.strictEqual(JSON.parse(r.stdout).repos[0].canonical_discovery, true, 'midió con el descubridor del propio clon');
  // el espejo: la variable sigue mandando — apuntada al instalado (roto), cae al de respaldo y lo dice
  const v = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'metrics', 'sdlc-stage-metrics.js'), '--repo', repo, '--dashboard', path.join(dir, 'dashboard'), '--json'],
    { encoding: 'utf8', env: { ...env, TYCON_SKILLS_DIR: path.join(home, '.claude', 'agent-skills', 'skills') } });
  assert.strictEqual(v.status, 0, v.stderr);
  assert.strictEqual(JSON.parse(v.stdout).repos[0].canonical_discovery, false);
  assert.ok(v.stderr.includes(installedLib), 'y nombra la carpeta donde lo buscó');
});

// ── C3 · la forma de pedirlo desde bash ─────────────────────────────────────────────────────────────────────────────

test('C3 SkillsDir_Cli_PrintsPathOrFailsWithReason — --skills, --repo y --source imprimen UNA línea y salen 0', () => {
  const l = lab({ unified: true, installed: true });
  assert.deepStrictEqual(cli(l, ['--skills']), { code: 0, out: path.join(l.clone, 'skills') + '\n', err: '' });
  assert.deepStrictEqual(cli(l, ['--repo']), { code: 0, out: l.clone + '\n', err: '' });
  assert.deepStrictEqual(cli(l, ['--source']), { code: 0, out: 'own-clone\n', err: '' });
  // la variante de quien escribe rutas en la máquina
  assert.deepStrictEqual(cli(l, ['--skills', '--installed']), { code: 0, out: path.join(l.inst, 'skills') + '\n', err: '' });
  assert.deepStrictEqual(cli(l, ['--source', '--installed']), { code: 0, out: 'installed\n', err: '' });
  // y la variable, en sus dos lecturas
  const other = path.join(l.dir, 'other');
  fs.mkdirSync(path.join(other, 'skills', 'x'), { recursive: true });
  assert.strictEqual(cli(l, ['--skills'], other).out, path.join(other, 'skills') + '\n');
  assert.strictEqual(cli(l, ['--repo'], path.join(other, 'skills')).out, other + '\n');
  assert.strictEqual(cli(l, ['--source'], other).out, 'variable\n');
});

test('C3 — si la carpeta de skills resuelta NO existe: sale 1, no imprime ruta y dice el motivo y de dónde salió', () => {
  // 🔴 rojo: imprimir la ruta por defecto y salir 0 → `SK="$(node skills-dir.js --skills)"` queda con una
  //    carpeta que no existe y todo lo que cuelga de ella «no está», en silencio.
  const l = lab();   // ni clon unido ni nada instalado
  const r = cli(l, ['--skills']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.out, '', 'sin ruta en la salida: quien la captura no se queda con una carpeta fantasma');
  assert.ok(r.err.includes(path.join(l.inst, 'skills')), `nombra la carpeta que buscó: ${r.err}`);
  assert.match(r.err, /no existe/);
  assert.match(r.err, /installed/, 'dice de qué regla salió');
  // con la variable apuntando a la nada, lo mismo, y dice que salió de la variable
  const v = cli(lab({ unified: true }), ['--repo'], path.join(l.dir, 'nowhere'));
  assert.strictEqual(v.code, 1);
  assert.strictEqual(v.out, '');
  assert.match(v.err, /TYCON_SKILLS_DIR/);
});

test('C3 — sin opción, con una opción desconocida o con dos a la vez: sale 2 con el uso (no es «no existe»)', () => {
  const l = lab({ unified: true });
  for (const args of [[], ['--nope'], ['--skills', '--repo'], ['--installed']]) {
    const r = cli(l, args);
    assert.strictEqual(r.code, 2, `${JSON.stringify(args)} → ${r.code}`);
    assert.strictEqual(r.out, '');
    assert.match(r.err, /uso: /);
  }
});

test('C3 — importar el módulo no imprime nada ni termina el proceso', () => {
  const l = lab({ unified: true });
  const r = spawnSync(process.execPath, ['-e', 'require(process.argv[1]); process.stdout.write("sigue")', l.script],
    { encoding: 'utf8', env: envOf(l) });
  assert.deepStrictEqual([r.status, r.stdout, r.stderr], [0, 'sigue', '']);
});
