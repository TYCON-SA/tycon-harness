'use strict';
/**
 * harness-state.test.js — el programa de instalación (`scripts/setup/harness.js`): su forma, su estado y su versión
 * (T1, T2, T12).
 *
 * Lo que no se puede perder:
 *   T1 · el programa corre con Node ≥ 20 y, con uno más viejo, imprime UNA línea y sale 2 antes de cargar nada; un
 *        subcomando o una opción desconocidos salen 2 con la lista; `--help` sale 0; nombres en inglés y sin nombres
 *        reales (los dos frenos del pre-commit, `spanish-names.js` y `new-names.js`, en 0 sobre `scripts/setup/`).
 *        La tabla por nombre (`layer`, `migrate`, `install --harness-clone`), la ruta del lugar
 *        sólo en place.js y en lo declarado, y el default de `paths.tree` sin el nombre del lugar.
 *   T2 · el estado se escribe atómico y bajo candado (dos escritores a la vez, ninguna escritura perdida); un archivo
 *        ilegible, un `schema` mayor o un `tree` que no existe hacen salir 2 a todo comando salvo `doctor` (rojo),
 *        `startup` (aviso, 0) y `uninstall`; sin archivo, 3 y «no instalado».
 *   T12 · `version`: sin `version.json` → `YYYY.MM.DD+sha7 · agent-skills sha7 · <mode> · <channel> · <sources>`;
 *        `--json` con los campos del estado más `hold`; en `developer` avisa que la versión es la del clon.
 *   T7·módulo / T13·módulo · las piezas que `update` y `channel` usan, probadas a nivel `require()` sobre dos remotos
 *        bare de juguete (fuentes: detectar, mirar, planear, avanzar, volver) y un `tycon.json` de juguete (la política);
 *        el recorrido entero por la línea de comandos vive en `harness-update.test.sh` y `harness-doctor.test.sh`.
 *
 * 🔴 Sin `scripts/setup/harness.js` nada de esto existe; sin `scripts/setup/harness/*.js`
 *    los casos de módulo fallan en el `require`.
 * 🔴 Nada toca el HOME real: cada caso arma su HOME y, cuando hace falta, su arnés de juguete en el temporal. Y eso se
 *    mide: `lib/real-home-guard.js` frena y anota todo intento de escribir o borrar en la casa real, en este proceso y
 *    en los `node` que lanza; el último caso del archivo exige que no haya ninguno (los dos frenos de
 *    nombres, lanzados sin HOME de juguete, anotarían en el registro real de la máquina).
 */
const GUARD = require('./lib/real-home-guard.js');   // primera línea que hace algo
// las suites que lanzan harness.js no bajan el Node del arnés de nodejs.org
process.env.TYCON_HARNESS_NODE = '0';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const HARNESS = path.join(RAIZ, 'scripts', 'setup', 'harness.js');
const SUBCOMMANDS = ['install', 'startup', 'update', 'apply', 'version', 'doctor', 'channel', 'rollback', 'uninstall', 'link', 'relocate'];

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-harness-state-'));
require('./lib/lab-guard.js').labGuard(BASE, 'harness-state');
process.on('exit', () => fs.rmSync(BASE, { recursive: true, force: true }));

function casa(nombre) {
  const h = path.join(BASE, nombre);
  fs.mkdirSync(path.join(h, '.claude', '.tycon-pipeline'), { recursive: true });
  return h;
}
/** Corre harness.js con un HOME de juguete y sin nada del arnés real en el ambiente. */
function run(args, { home = casa('h-' + Math.random().toString(36).slice(2, 8)), env = {}, node = process.execPath } = {}) {
  const r = spawnSync(node, [HARNESS, ...args], {
    encoding: 'utf8', timeout: 30000,
    env: Object.assign({}, process.env, {
      HOME: home, TMPDIR: path.join(BASE, 'tmp'), TYCON_PROFILE: '0', TYCON_NO_NIGHTLY_EXAM: '1', TYCON_NO_GUI_ENV: '1',
      TYCON_SETTINGS_PATH: path.join(home, '.claude', 'settings.json'), CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'),
    }, env),
  });
  return { rc: r.status, out: r.stdout || '', err: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
}
fs.mkdirSync(path.join(BASE, 'tmp'), { recursive: true });
/**
 * El ambiente de un freno del pre-commit lanzado suelto: el de la máquina (PATH, git) con una HOME de juguete y sin
 * `TYCON_HOME`. Los frenos anotan cada commit que miran en el estado de la máquina (`guard-record.js`, `new-names.jsonl`):
 * con el ambiente heredado tal cual, cada corrida de la suite sumaría líneas al registro REAL, el que lee el tablero.
 */
function toolEnv() {
  const home = casa('tool-home');
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
  delete env.TYCON_HOME;
  return env;
}

// ─── T1 · Harness_Cli_NodeFloor_UnknownExit2_NamesInEnglish ────────────────────────────────────────────────────────

test('T1 · un subcomando desconocido sale 2 con la lista de los que existen', () => {
  const r = run(['bogus']);
  assert.strictEqual(r.rc, 2, `rc ${r.rc}: ${r.all}`);
  for (const s of SUBCOMMANDS) assert.ok(r.all.includes(s), `la lista no nombra «${s}»: ${r.all}`);
});

test('T1 · una opción desconocida sale 2 con la lista de opciones del subcomando', () => {
  const r = run(['version', '--bogus']);
  assert.strictEqual(r.rc, 2, `rc ${r.rc}: ${r.all}`);
  assert.ok(/--json/.test(r.all), `la lista no nombra --json: ${r.all}`);
});

test('T1 · --help sale 0 y nombra todos los subcomandos', () => {
  const r = run(['--help']);
  assert.strictEqual(r.rc, 0, `rc ${r.rc}: ${r.all}`);
  for (const s of SUBCOMMANDS) assert.ok(r.out.includes(s), `--help no nombra «${s}»`);
});

test('T1 · con un node por debajo del piso (v18) imprime UNA línea y sale 2 antes de cargar nada', () => {
  // un `node` de mentira: --version dice v18.0.0 y todo lo demás corre con process.versions.node = 18.0.0
  const bin = path.join(BASE, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node-version.js'), 'Object.defineProperty(process.versions, "node", { value: "18.0.0" });\n');
  const wrapper = path.join(bin, 'node');
  fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nif [ "\${1:-}" = "--version" ]; then echo v18.0.0; exit 0; fi\nexec "${process.execPath}" -r "${path.join(bin, 'node-version.js')}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  assert.strictEqual(execFileSync(wrapper, ['--version'], { encoding: 'utf8' }).trim(), 'v18.0.0');
  const r = run(['version'], { node: wrapper });
  assert.strictEqual(r.rc, 2, `rc ${r.rc}: ${r.all}`);
  const lines = r.all.split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, `más de una línea: ${r.all}`);
  assert.ok(/20/.test(lines[0]) && /18\.0\.0/.test(lines[0]), `la línea no dice el piso y la versión: ${lines[0]}`);
});

// El piso de Node 22 corta sólo una instalación nueva, con una línea que dice qué hacer; el arranque, `version` y la cola
// del aplicador (`install --from-existing`, la que corre en cada actualización) siguen tolerando 20.
// 🔴 Sin esto: `install` con Node 20 instala igual (o frena recién en el aplicador, sin decir qué hacer), o el piso
//    nuevo frena en cada arranque a quien todavía no actualizó su Node.
test('T1 · Node 20: install corta con una línea clara y sin escribir nada; startup, version e install --from-existing no', () => {
  const H = require(HARNESS);
  assert.strictEqual(H.INSTALL_NODE_FLOOR, 22);
  assert.strictEqual(H.installNodeProblem({ env: {} }), null, 'con el Node de esta máquina no hay problema');
  const fake = { TYCON_NODE_FLOOR_FAKE_VERSION: 'v20.11.1' };
  for (const args of [['install', '--dry-run'], ['install', '--version', 'latest', '--tool', 'codex', '--dry-run']]) {
    const home = casa('n22-' + args.length);
    const r = run(args, { home, env: fake });
    assert.strictEqual(r.rc, 1, `${args.join(' ')} rc ${r.rc}: ${r.all}`);
    const lines = r.all.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, `${args.join(' ')}: más de una línea: ${r.all}`);
    assert.match(lines[0], /^harness\.js install: Node 20\.11\.1: para instalar el arnés hace falta Node 22 o más nuevo\. Instalá Node 22/, lines[0]);
    for (const d of [path.join(home, '.tycon'), path.join(home, '.claude', 'tycon-harness-state.json')]) assert.ok(!fs.existsSync(d), `${args.join(' ')} escribió ${d}`);
  }
  // espejo: lo que corre en cada arranque o actualización no menciona el piso de la instalación
  for (const args of [['startup'], ['version'], ['install', '--from-existing']]) {
    const r = run(args, { env: fake });
    assert.ok(!/para instalar el arnés hace falta Node 22/.test(r.all), `${args.join(' ')} cortó por el piso de la instalación: ${r.all}`);
  }
});

test('T1 · nombres en inglés y sin nombres reales: los dos frenos del pre-commit en 0 sobre scripts/setup/', () => {
  // un clon compartido del repo bajo prueba (sin copiar objetos) con scripts/setup/ stageado tal como está en el disco
  const copia = path.join(BASE, 'copia');
  execFileSync('git', ['clone', '-q', '--shared', RAIZ, copia], { stdio: 'ignore' });
  fs.rmSync(path.join(copia, 'scripts', 'setup'), { recursive: true, force: true });
  fs.cpSync(path.join(RAIZ, 'scripts', 'setup'), path.join(copia, 'scripts', 'setup'), { recursive: true });
  // la excepción del glosario («startup», «held») va en un commit APARTE y anterior, como manda la guía: el freno cruza
  // las excepciones stageadas con las del commit anterior, así que una agregada en el mismo commit no cuenta
  fs.copyFileSync(path.join(RAIZ, 'scripts', 'lib', 'spanish-words.json'), path.join(copia, 'scripts', 'lib', 'spanish-words.json'));
  const gitEnv = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com' });
  execFileSync('git', ['-C', copia, 'add', 'scripts/lib/spanish-words.json'], { stdio: 'ignore' });
  execFileSync('git', ['-C', copia, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'glosario: excepción de la story 8.13'], { stdio: 'ignore', env: gitEnv });
  execFileSync('git', ['-C', copia, 'add', '-A', 'scripts/setup'], { stdio: 'ignore' });
  for (const tool of ['spanish-names.js', 'new-names.js']) {
    const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'publishing', tool), '--repo', copia], { encoding: 'utf8', timeout: 120000, env: toolEnv() });
    assert.strictEqual(r.status, 0, `${tool} salió ${r.status}:\n${r.stdout}${r.stderr}`);
  }
});

// Harness_Cli_ClosedTable_NewNamesInEnglish: la tabla está cerrada. Las opciones que
// la instalación guiada le suma a `install` (`--dry-run`, `--yes`, `--profile`, `--integrations`, `--packs`) están declaradas;
// una opción inventada sale 2 con la lista, y `--help` no la ofrece. Los
// nombres nuevos de scripts/setup/ (`install-effects.json` y sus claves) los mira el caso de arriba.
test('8.16 · T1 · install sólo acepta las opciones de la tanda mergeada: las de después salen 2 con la lista y --help no las ofrece', () => {
  // --dry-run y --yes (y apply --dry-run), --profile, --integrations y --packs ya están declaradas: no queda
  // ninguna para después. Una opción inventada sale 2 con la lista (la tabla está cerrada)
  const LATER = ['--profiles', '--integration'];
  const help = run(['--help']);
  assert.strictEqual(help.rc, 0, `rc ${help.rc}: ${help.all}`);
  const installLine = help.out.split('\n').find((l) => /^ {2}install\b/.test(l));
  assert.ok(installLine, `--help no lista install: ${help.out.slice(0, 300)}`);
  for (const o of ['--channel', '--local', '--from-existing', '--source', '--dry-run', '--yes', '--profile', '--integrations', '--packs']) assert.ok(installLine.includes(o), `--help perdió ${o} de install: ${installLine}`);
  const applyLine = help.out.split('\n').find((l) => /^ {2}apply\b/.test(l));
  assert.ok(applyLine && applyLine.includes('--dry-run'), `--help no ofrece apply --dry-run: ${applyLine}`);
  for (const o of LATER) {
    assert.ok(!installLine.split(/\s+/).includes(o), `--help ofrece ${o} en install y no existe: ${installLine}`);
    const r = run(['install', o]);
    assert.strictEqual(r.rc, 2, `install ${o}: rc ${r.rc}: ${r.all}`);
    assert.ok(/opción desconocida/.test(r.all) && /--channel/.test(r.all), `install ${o} no dice la lista de opciones: ${r.all}`);
  }
});

// ─── T1 · la tabla de subcomandos ───────────────────────────────────────────────────────────────────────────────────────
// La tabla de subcomandos está cerrada y se mira POR NOMBRE (nunca por cuántos hay): incluye `layer` y
// `install --harness-clone`, y `migrate` con su código. Nombres en
// inglés y sin nombres reales (los dos frenos sobre la rama). La ruta del lugar (la categoría (a) de harness-place.test.js, con los dos
// nombres) sólo en place.js y en lo declarado en harness-place-names.json; el default de `paths.tree` sin el nombre del
// lugar. Los nombres salen de place.js: escribirlos acá sería otra copia.
const PLACE = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'place.js'));
const PLACE_LIST = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'tests', 'fixtures', 'harness-place-names.json'), 'utf8'));
const LAYER_OPTS = ['--check', '--list', '--json', '--public', '--harness-clone'];
// los subcomandos anunciados que todavía NO están: quien los trae los saca de acá.
// `migrate` se exige, con --to-home (MIGRATE_OPTS)
const LATER_SUBCOMMANDS = [];
const MIGRATE_OPTS = ['--to-home', '--dry-run', '--repo'];
/** Los subcomandos de `--help` con sus opciones, por nombre: { nombre: [opciones] }. */
function helpTable(helpOut) {
  const t = {};
  for (const l of helpOut.split('\n')) {
    const m = /^ {2}([a-z][a-z-]*)\b(.*)$/.exec(l);
    if (m) t[m[1]] = m[2].split(/\s+/).filter((w) => w.startsWith('--'));
  }
  return t;
}
/** Lo que la tabla no cumple, por nombre. */
function tableProblems(t) {
  const p = [];
  if (!t.layer) p.push('falta layer');
  else for (const o of LAYER_OPTS) if (!t.layer.includes(o)) p.push(`layer sin ${o}`);
  if (!t.install || !t.install.includes('--harness-clone')) p.push('install sin --harness-clone');
  if (!t.migrate) p.push('falta migrate');
  else for (const o of MIGRATE_OPTS) if (!t.migrate.includes(o)) p.push(`migrate sin ${o}`);
  for (const s of LATER_SUBCOMMANDS) if (t[s]) p.push(`${s} está y es de una tanda posterior`);
  return p;
}
// La expresión de la ruta del lugar es la de harness-place.test.js (LEGACY_PATH_RX / PLACE_PATH_RX, la categoría (a) de
// esa prueba), con los dos nombres juntos; codeOnly, codeFiles y la marca de los envoltorios son copias de las suyas (un
// archivo de pruebas no se puede requerir sin correr sus casos). Si cambian allá, se cambian acá.
const PLACE_NAMES_RX = `(?:${PLACE.PLACE_NAME}|${PLACE.LEGACY_PLACE_NAME})`;
const PLACE_ANY_PATH_RX = new RegExp(`\\.claude[/\\\\]+${PLACE_NAMES_RX}(?![A-Za-z0-9_-])|['"]\\.claude['"],\\s*['"]${PLACE_NAMES_RX}['"]`);
function codeOnly(text) {
  return text.split('\n').filter((l) => !/^\s*(#|\/\/|\*(?:\s|\/|$)|\/\*)/.test(l)).map((l) => {
    const i = l.indexOf(' //');
    if (i < 0) return l;
    const before = l.slice(0, i);
    const quotes = (before.match(/'/g) || []).length + (before.match(/"/g) || []).length + (before.match(/`/g) || []).length;
    return quotes % 2 === 0 ? before : l;
  }).join('\n');
}
/** Los .js/.sh/.ps1 de scripts/ que corren (sin pruebas ni sus fixtures: el mismo filtro que codeFiles de harness-place.test.js). */
function placeSweepFiles(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', 'scripts'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ls-files: ${r.stderr}`);
  return r.stdout.split('\n').filter((f) => /\.(js|sh|ps1)$/.test(f))
    .filter((f) => !/(^|\/)tests?\//.test(f) && !/\.test\./.test(f))
    .filter((f) => fs.existsSync(path.join(root, f)));
}
/** Los archivos que escriben la ruta del lugar fuera de comentarios y no son place.js ni algo declarado. */
function placePathOffenders(root, files, list) {
  const declared = new Set(['scripts/setup/harness/place.js',
    ...['literal_copies', 'recognizers', 'legacy_only', 'other_uses', 'place_text'].flatMap((k) => (list[k] || []).map((e) => e.path))]);
  const out = [];
  for (const f of files) {
    if (declared.has(f)) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch (_) { continue; }
    if (text.includes('\0') || text.split('\n').slice(0, 3).some((l) => l.includes(list.generated[0].mark))) continue;
    const hit = codeOnly(text).split('\n').find((l) => PLACE_ANY_PATH_RX.test(l));
    if (hit) out.push(`${f}: ${hit.trim().slice(0, 140)}`);
  }
  return out;
}

// ─── `install --tool` y `uninstall --tool` entran a la tabla cerrada, con su código ─────
test('8.23 C · AC 1 Harness_Cli_ToolOption_OnlyInstallAndUninstall_NeedsAValue_ClosedValues', () => {
  const t = helpTable(run(['--help']).out);
  for (const cmd of ['install', 'uninstall']) assert.ok(t[cmd] && t[cmd].includes('--tool'), `--help no ofrece ${cmd} --tool: ${JSON.stringify(t[cmd])}`);
  // por nombre: ningún otro subcomando lo ofrece
  for (const [name, opts] of Object.entries(t)) if (!['install', 'uninstall'].includes(name)) assert.ok(!opts.includes('--tool'), `${name} ofrece --tool y no tiene código para eso`);
  // sin valor: 2
  for (const cmd of ['install', 'uninstall']) {
    const r = run([cmd, '--tool']);
    assert.strictEqual(r.rc, 2, `${cmd} --tool sin valor: rc ${r.rc}: ${r.all}`);
    assert.match(r.all, /--tool necesita un valor/);
  }
  // un valor que no es una herramienta: 2, nombra las que valen, y no escribe nada (antes de la red y del estado)
  const home = casa('tool-values');
  const before = fs.readdirSync(path.join(home, '.claude', '.tycon-pipeline')).length;
  const bad = run(['install', '--version', 'latest', '--tool', 'cursor', '--yes'], { home, env: { TYCON_RELEASE_API: 'http://127.0.0.1:9' } });
  assert.strictEqual(bad.rc, 2, `rc ${bad.rc}: ${bad.all}`);
  assert.match(bad.all, /claude o codex/);
  assert.strictEqual(fs.readdirSync(path.join(home, '.claude', '.tycon-pipeline')).length, before, 'un --tool que no vale no escribe nada');
  assert.ok(!fs.existsSync(path.join(home, '.tycon')), 'ni crea la casa del arnés');
  // la opción es repetible y acepta la lista con comas: las dos formas dicen lo mismo en el plan (sin red: --dry-run
  // sale antes por el servidor que no contesta, así que se mira el error de uso, que no aparece)
  for (const args of [['--tool', 'claude', '--tool', 'codex'], ['--tool', 'claude,codex']]) {
    const r = run(['install', '--version', 'latest', ...args, '--dry-run'], { home, env: { TYCON_RELEASE_API: 'http://127.0.0.1:9', TYCON_UPDATE_NETWORK_BUDGET_S: '2' } });
    assert.doesNotMatch(r.all, /--tool «|opción desconocida|necesita un valor/, `install ${args.join(' ')} se rechazó por uso: ${r.all}`);
  }
  // sin arnés instalado, `uninstall --tool` no tiene nada que quitar
  const none = run(['uninstall', '--tool', 'claude', '--yes'], { home: casa('tool-none') });
  assert.strictEqual(none.rc, 0, `rc ${none.rc}: ${none.all}`);
  assert.match(none.all, /nada que quitar/);
});

test('T1 Harness_Cli_LayerAndHarnessClone_ClosedTableByName_EnglishNames_NoRealNames_PlacePathOnlyInPlaceJs', () => {
  // --help: layer con sus opciones e install con --harness-clone, comparados por nombre
  const help = run(['--help']);
  assert.strictEqual(help.rc, 0, `rc ${help.rc}: ${help.all}`);
  assert.deepStrictEqual(tableProblems(helpTable(help.out)), [], `la tabla de --help no es la de la tanda A:\n${help.out}`);
  // la comparación no es de mentira: una tabla sin migrate (o con otro migrate), sin layer, o sin --harness-clone, frena
  const fake = (install, extra, migrate = `  migrate ${MIGRATE_OPTS.join(' <valor> ')}\n`) => helpTable(`  install ${install}\n      la ayuda\n  layer ${LAYER_OPTS.join(' ')}\n${migrate}${extra}`);
  assert.deepStrictEqual(tableProblems(fake('--channel <valor> --harness-clone <valor>', '')), []);
  assert.deepStrictEqual(tableProblems(fake('--channel <valor> --harness-clone <valor>', '', '  migrate --to <valor>\n')), ['migrate sin --to-home', 'migrate sin --dry-run', 'migrate sin --repo']);
  assert.deepStrictEqual(tableProblems(fake('--channel <valor> --harness-clone <valor>', '', '')), ['falta migrate']);
  assert.deepStrictEqual(tableProblems(helpTable('  install --harness-clone <valor>\n')), ['falta layer', 'falta migrate']);
  assert.deepStrictEqual(tableProblems(fake('--channel <valor>', '')), ['install sin --harness-clone']);
  // migrate sin --to-home: 2 y lo dice (la única mudanza que existe es del clon a ~/.tycon)
  const noTo = run(['migrate']);
  assert.strictEqual(noTo.rc, 2, `migrate sin --to-home: rc ${noTo.rc}: ${noTo.all}`);
  assert.match(noTo.all, /--to-home/);
  // layer con una opción que no existe: 2 con la lista de las suyas
  const bad = run(['layer', '--no-such-option']);
  assert.strictEqual(bad.rc, 2, `rc ${bad.rc}: ${bad.all}`);
  assert.ok(/opción desconocida/.test(bad.all), `no dice que la opción no existe: ${bad.all}`);
  for (const o of LAYER_OPTS) assert.ok(bad.all.includes(o), `layer con una opción desconocida no nombra ${o}: ${bad.all}`);
  // migrate todavía no es un subcomando: 2 con la lista, y la lista nombra layer
  for (const s of LATER_SUBCOMMANDS) {
    const r = run([s]);
    assert.strictEqual(r.rc, 2, `${s}: rc ${r.rc}: ${r.all}`);
    assert.ok(/subcomando desconocido/.test(r.all) && /\blayer\b/.test(r.all), `${s} no sale con la lista: ${r.all}`);
  }

  // el default de paths.tree es la carpeta del mecanismo, sin el nombre del lugar (ni el nuevo ni el viejo)
  const cfg = require(path.join(RAIZ, 'scripts', 'lib', 'tycon-config.js'));
  const treeDefault = cfg.DEFAULTS['rutas.tree'];
  assert.ok(typeof treeDefault === 'string' && treeDefault.includes('.tycon-pipeline'), `paths.tree sin default en la carpeta del mecanismo: ${treeDefault}`);
  for (const n of [PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME]) assert.ok(!treeDefault.includes(n), `el default de paths.tree lleva el nombre del lugar «${n}»: ${treeDefault}`);

  // la ruta del lugar, fuera de comentarios, sólo en place.js y en lo declarado
  assert.deepStrictEqual(placePathOffenders(RAIZ, placeSweepFiles(RAIZ), PLACE_LIST), [], 'la ruta del lugar escrita fuera de place.js y de harness-place-names.json');
  // …y el barrido no es de mentira: una sembrada en código aparece; en un comentario, en place.js, en una prueba o en un
  // envoltorio, no; la palabra suelta (un prefijo de temporal) tampoco
  const t = fs.mkdtempSync(path.join(BASE, 'place-sweep-'));
  spawnSync('git', ['init', '-q', t]);
  const seed = {
    'scripts/a.js': `const p = path.join(home, '.claude', '${PLACE.PLACE_NAME}');\n`,
    'scripts/b.sh': `X="$HOME/.claude/${PLACE.LEGACY_PLACE_NAME}/scripts"\n`,
    'scripts/c.ps1': `# corré ~/.claude/${PLACE.PLACE_NAME}/x.ps1\n`,
    'scripts/d.js': `const tmp = '${PLACE.PLACE_NAME}-report-';   // un prefijo de temporal\n`,
    'scripts/setup/harness/place.js': `const x = '.claude/${PLACE.PLACE_NAME}';\n`,
    'scripts/tests/e.test.js': `const p = '~/.claude/${PLACE.PLACE_NAME}';\n`,
    'scripts/f.js': `#!/usr/bin/env node\n// ${PLACE_LIST.generated[0].mark} x\nconst p = '.claude/${PLACE.PLACE_NAME}';\n`,
  };
  for (const [rel, body] of Object.entries(seed)) { fs.mkdirSync(path.dirname(path.join(t, rel)), { recursive: true }); fs.writeFileSync(path.join(t, rel), body); }
  assert.deepStrictEqual(placePathOffenders(t, placeSweepFiles(t), PLACE_LIST).map((x) => x.split(':')[0]), ['scripts/a.js', 'scripts/b.sh'],
    'el barrido no ve una ruta sembrada o cuenta un comentario, place.js, una prueba, un envoltorio o la palabra suelta');
  fs.rmSync(t, { recursive: true, force: true });

  // los dos frenos de nombres sobre la rama (como en harness-place.test.js T1): sin origin/main, o sin commits propios,
  // NO MEDIDO y se dice. El rango trae lo de la rama: scripts/setup/ y las fixtures nuevas entre eso.
  // 🔴 En un árbol armado —el repo privado con el público encima, como lo arma la validación de sus pedidos— la punta
  // es el commit local de esa superposición. Medido desde ahí, todo el público cuenta como «nuevo» y los frenos marcan
  // nombres que ya existían; medido hasta el commit anterior, el privado adelgazado
  // no trae la lista de palabras y el freno no puede mirar. Ahí este caso no mide los frenos sobre la rama, y lo dice.
  const tipSubject = spawnSync('git', ['-C', RAIZ, 'log', '-1', '--format=%s', 'HEAD'], { encoding: 'utf8' });
  if (tipSubject.status === 0 && tipSubject.stdout.includes('[superposición local, no se empuja]')) {
    console.log('⏭ 8.13.1 T1: NO MEDIDO — los frenos de nombres sobre la rama (árbol armado: la punta es la superposición del público)');
    return;
  }
  const base = spawnSync('git', ['-C', RAIZ, 'merge-base', 'origin/main', 'HEAD'], { encoding: 'utf8' });
  const head = spawnSync('git', ['-C', RAIZ, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (base.status !== 0 || base.stdout.trim() === head.stdout.trim()) {
    console.log('⏭ 8.13.1 T1: NO MEDIDO — spanish-names.js y new-names.js sobre la rama (sin origin/main, o la rama no tiene commits propios)');
    return;
  }
  for (const tool of ['spanish-names.js', 'new-names.js']) {
    const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'publishing', tool), '--range', `${base.stdout.trim()}...HEAD`], { cwd: RAIZ, encoding: 'utf8', timeout: 120000, env: toolEnv() });
    assert.strictEqual(r.status, 0, `${tool} --range frena:\n${r.stdout}${r.stderr}`);
  }
});

// ─── los módulos (scripts/setup/harness/*.js) a nivel require(): T2, T7·módulo, T12, T13·módulo ───────────────────

const MODULES = path.join(RAIZ, 'scripts', 'setup', 'harness');
const mod = (name) => require(path.join(MODULES, `${name}.js`));

// git aislado de la máquina: sin configuración global ni del sistema, sin hooks, sin preguntar credenciales
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
};
/** El ambiente que recibe un módulo: HOME de juguete, nada del arnés real, git aislado. */
function labEnv(home, extra) {
  return Object.assign({
    PATH: process.env.PATH, HOME: home, TMPDIR: path.join(BASE, 'tmp'), TYCON_PROFILE: '0', TYCON_NO_NIGHTLY_EXAM: '1', TYCON_NO_GUI_ENV: '1',
  }, GIT_ENV, extra || {});
}
function git(dir, args, extra) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({ PATH: process.env.PATH, HOME: BASE }, GIT_ENV, extra || {}),
  }).trim();
}
const sha7 = (s) => String(s).slice(0, 7);
let seq = 0;
/** Un repo de juguete con remoto bare, copia «autor» (para publicar versiones nuevas) y clones a pedido. */
function repo(name, seed, { commitEnv } = {}) {
  const root = path.join(BASE, `repo-${name}-${++seq}`);
  const seedDir = path.join(root, 'seed');
  fs.mkdirSync(seedDir, { recursive: true });
  seed(seedDir);
  git(seedDir, ['init', '-q', '-b', 'main']);
  git(seedDir, ['add', '-A']);
  git(seedDir, ['commit', '-q', '-m', 'versión 1'], commitEnv);
  const bare = path.join(root, 'remote.git');
  git(root, ['clone', '-q', '--bare', seedDir, bare]);
  const author = path.join(root, 'author');
  git(root, ['clone', '-q', bare, author]);
  return {
    root, bare, author,
    clone(dest) { fs.mkdirSync(path.dirname(dest), { recursive: true }); git(path.dirname(dest), ['clone', '-q', bare, dest]); return dest; },
    /** publica una versión nueva en el remoto (con `force`, reescribe la punta con un amend + push --force) */
    publish(rel, content, { force = false, commitEnv: ce } = {}) {
      git(author, ['fetch', '-q', 'origin']);
      if (!force) git(author, ['reset', '-q', '--hard', 'origin/main']);
      fs.mkdirSync(path.dirname(path.join(author, rel)), { recursive: true });
      fs.writeFileSync(path.join(author, rel), `${content}\n`);
      git(author, ['add', '-A']);
      git(author, force ? ['commit', '-q', '--amend', '-m', `reescrito: ${rel}`] : ['commit', '-q', '-m', `nuevo: ${rel}`], ce);
      git(author, force ? ['push', '-q', '--force', 'origin', 'main'] : ['push', '-q', 'origin', 'main']);
      return git(author, ['rev-parse', 'HEAD']);
    },
  };
}
/** Una máquina de juguete: HOME, un clon del arnés fuera del HOME y ~/.claude/agent-skills como otro clon. */
function lab(name, { commitEnv, gitignore = '.dashboard/\n' } = {}) {
  const home = casa(name);
  const harness = repo(`${name}-harness`, (d) => {
    fs.mkdirSync(path.join(d, 'scripts', 'setup'), { recursive: true });
    fs.writeFileSync(path.join(d, 'README.md'), '# arnés de juguete\n');
    fs.writeFileSync(path.join(d, 'VERSION'), '1\n');
    fs.writeFileSync(path.join(d, '.gitignore'), gitignore);
  }, { commitEnv });
  const skills = repo(`${name}-skills`, (d) => {
    fs.mkdirSync(path.join(d, 'skills', 'tycon-pipeline'), { recursive: true });
    fs.mkdirSync(path.join(d, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(d, 'skills', 'tycon-pipeline', 'SKILL.md'), '# skill de juguete\n');
    fs.writeFileSync(path.join(d, 'agents', 'lab.md'), '# agente de juguete\n');
    fs.writeFileSync(path.join(d, 'VERSION'), '1\n');
  }, { commitEnv });
  const tree = harness.clone(path.join(BASE, `${name}-clones`, 'harness'));
  const skillsDir = skills.clone(path.join(home, '.claude', 'agent-skills'));
  return { home, env: labEnv(home), harness, skills, tree, skillsDir };
}

// La punta de un clon se pregunta una vez mientras el clon no cambie: instalar preguntaba lo mismo 8 veces por clon
// (16 de sus 33 procesos de git) y actualizar, 23 de 82. Cualquier cambio de HEAD, de la rama o de packed-refs vuelve a
// preguntar.
// 🔴 Sin esto: la segunda pregunta lanza otro git (la traza cuenta 2). Y con una memoria que no mira el clon, la punta
//    sale vieja después de un commit, de empaquetar las refs, de soltar HEAD o de cambiar de rama.
test('T12 · sources.head pregunta a git una vez mientras el clon no cambia, y sigue la punta después de cada cambio', () => {
  const sources = mod('sources');
  const L = lab('t12-head-memo');
  const trace = path.join(BASE, 'tmp', `head-memo-${process.pid}.trace`);
  const env = Object.assign({}, L.env, { GIT_TRACE2_EVENT: trace });
  const asks = () => (fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter((l) => l.includes('"event":"start"') && l.includes('"rev-parse","HEAD"')).length : 0);
  const truth = () => git(L.tree, ['rev-parse', 'HEAD']);
  const first = sources.head(L.tree, { env });
  assert.strictEqual(first, truth());
  assert.strictEqual(sources.head(L.tree, { env }), first);
  assert.strictEqual(asks(), 1, 'la segunda pregunta, con el clon igual, no lanza git');
  const commit = (msg) => { fs.writeFileSync(path.join(L.tree, 'VERSION'), `${msg}\n`); git(L.tree, ['commit', '-qam', msg]); };
  commit('dos');
  assert.strictEqual(sources.head(L.tree, { env }), truth(), 'después de un commit');
  git(L.tree, ['pack-refs', '--all']);
  assert.strictEqual(sources.head(L.tree, { env }), truth(), 'con las refs empaquetadas');
  commit('tres');
  assert.strictEqual(sources.head(L.tree, { env }), truth(), 'un commit sobre las refs empaquetadas');
  git(L.tree, ['checkout', '-q', '--detach', 'HEAD~1']);
  assert.strictEqual(sources.head(L.tree, { env }), truth(), 'con HEAD suelto');
  git(L.tree, ['checkout', '-q', '-b', 'otra']);
  commit('cuatro');
  assert.strictEqual(sources.head(L.tree, { env }), truth(), 'en otra rama');
  // la ref reescrita en el mismo archivo, con el mismo tamaño y la misma hora (dos escrituras en el mismo tic del reloj)
  const refFile = path.join(L.tree, '.git', 'refs', 'heads', 'otra');
  const tic = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(refFile, tic, tic);
  assert.strictEqual(sources.head(L.tree, { env }), truth());
  const punta = truth();
  fs.writeFileSync(refFile, `${git(L.tree, ['rev-parse', 'HEAD~1'])}\n`);
  fs.utimesSync(refFile, tic, tic);
  assert.strictEqual(sources.head(L.tree, { env }), truth(), 'la ref cambió aunque su archivo se vea igual');
  fs.writeFileSync(refFile, `${punta}\n`);
  // un worktree (su .git es un archivo): sin memoria, pero bien
  const wt = path.join(BASE, 'tmp', `head-memo-wt-${process.pid}`);
  git(L.tree, ['worktree', 'add', '-q', '--detach', wt, 'HEAD~2']);
  assert.strictEqual(sources.head(wt, { env }), git(wt, ['rev-parse', 'HEAD']), 'un worktree');
  // un ambiente que redirige git a otro repo no usa la memoria del directorio
  assert.strictEqual(sources.head(L.tree, { env: Object.assign({}, env, { GIT_DIR: git(wt, ['rev-parse', '--absolute-git-dir']) }) }), git(wt, ['rev-parse', 'HEAD']), 'con GIT_DIR');
});

// ─── T2 · Harness_State_AtomicUnderLock_BrokenIsNotUninstalled ─────────────────────────────────────────────────────

test('T2 · read sin archivo → missing; fail → 3 y «no instalado: harness.js install»', () => {
  const state = mod('state');
  const home = casa('t2-missing');
  const r = state.read(home);
  assert.strictEqual(r.status, 'missing');
  assert.strictEqual(r.state, null);
  const f = state.fail(r);
  assert.strictEqual(f.code, 3);
  assert.match(f.line, /no instalado: harness\.js install/);
});

test('T2 · JSON roto, schema mayor y tree inexistente: broken / unsupported_schema / tree_missing, 2 con el motivo y nunca «no instalado»', () => {
  const state = mod('state');
  const home = casa('t2-broken');
  const p = state.paths(home);
  fs.writeFileSync(p.file, '{ esto no es json');
  let r = state.read(home);
  assert.strictEqual(r.status, 'broken');
  assert.ok(r.reason, 'broken sin motivo');
  let f = state.fail(r);
  assert.strictEqual(f.code, 2);
  assert.ok(f.line.includes(p.file), `la línea no nombra el archivo: ${f.line}`);
  assert.doesNotMatch(f.line, /no instalado/);

  fs.writeFileSync(p.file, JSON.stringify({ schema: 9, mode: 'managed', tree: home }));
  r = state.read(home);
  assert.strictEqual(r.status, 'unsupported_schema');
  f = state.fail(r);
  assert.strictEqual(f.code, 2);
  assert.match(f.line, /9/);
  assert.match(f.line, /1/);
  assert.doesNotMatch(f.line, /no instalado/);

  const tree = path.join(home, 'no-such-tree');
  fs.writeFileSync(p.file, JSON.stringify(state.defaults({ tree, sources: [], mode: 'managed' })));
  r = state.read(home);
  assert.strictEqual(r.status, 'tree_missing');
  assert.strictEqual(r.state && r.state.tree, tree, 'tree_missing igual devuelve el estado leído');
  f = state.fail(r);
  assert.strictEqual(f.code, 2);
  assert.ok(f.line.includes(tree), `la línea no nombra el árbol: ${f.line}`);
  assert.doesNotMatch(f.line, /no instalado/);

  // un objeto que no es objeto, o sin schema, también es «roto», no «no instalado»
  fs.writeFileSync(p.file, '[1,2]');
  assert.strictEqual(state.read(home).status, 'broken');
  fs.writeFileSync(p.file, '{"mode":"managed"}');
  assert.strictEqual(state.read(home).status, 'broken');
});

test('T2 · defaults trae los campos de §Cómo funciona con schema 1; write es temporal + rename, crea la carpeta y relee ok', () => {
  const state = mod('state');
  assert.strictEqual(state.SCHEMA, 1);
  const home = path.join(BASE, 't2-ok');   // sin .claude/.tycon-pipeline: write la crea
  const tree = path.join(home, 'tree');
  fs.mkdirSync(tree, { recursive: true });
  const src = { name: 'harness', url: 'file:///lab/harness.git', ref: 'main', rewrites: false, dir: tree, commit: 'a'.repeat(40), previous: null };
  const s = state.defaults({ tree, sources: [src], mode: 'managed' });
  for (const k of ['schema', 'mode', 'tree', 'tree_before', 'sources', 'channel', 'version', 'managed', 'hold', 'notice', 'last_fetch', 'last_apply', 'last_health', 'failed', 'bootstrap']) {
    assert.ok(Object.prototype.hasOwnProperty.call(s, k), `defaults sin «${k}»`);
  }
  assert.strictEqual(s.schema, 1);
  assert.strictEqual(s.mode, 'managed');
  assert.strictEqual(s.tree, tree);
  assert.deepStrictEqual(s.sources, [src]);
  assert.deepStrictEqual(s.managed, []);
  assert.strictEqual(s.hold, null);
  assert.ok(s.version && 'number' in s.version && 'installed_at' in s.version, 'version sin number/installed_at');
  assert.ok(s.bootstrap && 'version' in s.bootstrap && 'sha256' in s.bootstrap, 'bootstrap sin version/sha256');

  const p = state.paths(home);
  assert.strictEqual(p.dir, path.join(home, '.claude', '.tycon-pipeline'));
  assert.strictEqual(p.file, path.join(p.dir, 'harness-state.json'));
  assert.strictEqual(p.harnessDir, path.join(p.dir, 'harness'));
  assert.strictEqual(p.lockDir, path.join(p.harnessDir, 'harness.lock'));
  assert.strictEqual(p.log, path.join(p.harnessDir, 'startup.log'));
  assert.strictEqual(p.bootstrapDir, p.harnessDir);

  state.write(home, s);
  assert.deepStrictEqual(fs.readdirSync(p.dir).filter((f) => f.startsWith('harness-state')), ['harness-state.json'], 'quedó un temporal');
  const r = state.read(home);
  assert.strictEqual(r.status, 'ok', r.reason);
  assert.deepStrictEqual(r.state, s);
  assert.ok(fs.readFileSync(p.file, 'utf8').endsWith('\n'), 'el archivo termina sin salto de línea');
});

test('8.54 T7 FirstInstall_SoloAlCrear · first_install {at, version, fresh}: fresca en una carpeta sin uso, no fresca con rastros del pipeline', () => {
  const state = mod('state');
  // el estado de cero trae el campo vacío: lo llena quien instala, y una actualización no lo toca
  assert.strictEqual(state.defaults({ tree: '/t', sources: [] }).first_install, null);
  const limpia = path.join(BASE, 't7-limpia');
  fs.mkdirSync(path.join(limpia, '.claude', '.tycon-pipeline', 'harness'), { recursive: true });   // lo que el propio install crea
  const a = state.firstInstall(limpia, '2026.10.18.50');
  assert.strictEqual(a.fresh, true, 'una carpeta sin uso del pipeline no es instalación nueva');
  assert.strictEqual(a.version, '2026.10.18.50');
  assert.ok(!Number.isNaN(Date.parse(a.at)), `at no es una fecha: ${a.at}`);
  // cada rastro de uso, por separado, la vuelve no fresca: un volcado de corrida, el registro de portones, los revisores
  for (const [nombre, armar] of [
    ['volcado', (d) => { fs.mkdirSync(path.join(d, 'timing-history'), { recursive: true }); fs.writeFileSync(path.join(d, 'timing-history', '1.1-2026-01-01T0000.json'), '{}'); }],
    ['gates', (d) => fs.writeFileSync(path.join(d, 'gates.log'), '{}\n')],
    ['revisores', (d) => fs.mkdirSync(path.join(d, 'advisor-runs'), { recursive: true })],
  ]) {
    const h = path.join(BASE, `t7-${nombre}`);
    const d = path.join(h, '.claude', '.tycon-pipeline');
    fs.mkdirSync(d, { recursive: true });
    armar(d);
    assert.strictEqual(state.firstInstall(h, '1').fresh, false, `con ${nombre} la instalación se dijo nueva`);
  }
  // lo que no se puede mirar cuenta como rastro: «no pude leer» nunca es «instalación nueva»
  const ilegible = path.join(BASE, 't7-ilegible');
  fs.mkdirSync(path.join(ilegible, '.claude', '.tycon-pipeline'), { recursive: true });
  fs.writeFileSync(path.join(ilegible, '.claude', '.tycon-pipeline', 'timing-history'), 'no soy una carpeta');
  assert.strictEqual(state.firstInstall(ilegible, '1').fresh, false, 'una carpeta de volcados ilegible se tomó como sin uso');
  // una carpeta de volcados vacía no es uso (la puede haber creado cualquiera)
  const vacia = path.join(BASE, 't7-vacia');
  fs.mkdirSync(path.join(vacia, '.claude', '.tycon-pipeline', 'timing-history'), { recursive: true });
  assert.strictEqual(state.firstInstall(vacia, '1').fresh, true);
});

test('T2 · candado: mkdir con pid; el segundo no entra y dice «otra sesión»; release lo suelta; LOCK_HELD=1 no toma nada', () => {
  const lock = mod('lock');
  const state = mod('state');
  const home = casa('t2-lock');
  const env = labEnv(home);
  const p = state.paths(home);
  const a = lock.acquire(home, { env });
  assert.deepStrictEqual([a.ok, a.held, a.pid], [true, false, process.pid], JSON.stringify(a));
  assert.ok(fs.statSync(p.lockDir).isDirectory(), 'el candado no es una carpeta');
  assert.strictEqual(fs.readFileSync(path.join(p.lockDir, 'pid'), 'utf8').split('\n')[0], String(process.pid));   // 1.ª línea: el PID (8.23: la 2.ª, la máquina)
  const b = lock.acquire(home, { env });
  assert.strictEqual(b.ok, false);
  assert.match(b.reason, /otra sesión/);
  assert.strictEqual(b.pid, process.pid, 'no dice quién lo tiene');
  lock.release(home);
  assert.ok(!fs.existsSync(p.lockDir), 'release no soltó el candado');
  const c = lock.acquire(home, { env: labEnv(home, { TYCON_HARNESS_LOCK_HELD: '1' }) });
  assert.deepStrictEqual([c.ok, c.held], [true, true], JSON.stringify(c));
  assert.ok(!fs.existsSync(p.lockDir), 'con LOCK_HELD=1 no se toma nada');
});

test('T2 · un candado huérfano (> 10 min) se pisa y queda con el pid nuevo; uno fresco de otro proceso no', () => {
  const lock = mod('lock');
  const state = mod('state');
  const home = casa('t2-stale');
  const env = labEnv(home);
  const p = state.paths(home);
  fs.mkdirSync(p.lockDir, { recursive: true });
  fs.writeFileSync(path.join(p.lockDir, 'pid'), '999999\n');
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(path.join(p.lockDir, 'pid'), old, old);
  fs.utimesSync(p.lockDir, old, old);
  const a = lock.acquire(home, { env });
  assert.strictEqual(a.ok, true, `no pisó el huérfano: ${JSON.stringify(a)}`);
  assert.strictEqual(fs.readFileSync(path.join(p.lockDir, 'pid'), 'utf8').split('\n')[0], String(process.pid));
  assert.ok(!fs.existsSync(`${p.lockDir}.takeover`), 'quedó el mutex de takeover');
  lock.release(home);
  // uno fresco de un proceso VIVO de esta máquina no se pisa (el de un proceso muerto sí, abajo)
  fs.mkdirSync(p.lockDir, { recursive: true });
  fs.writeFileSync(path.join(p.lockDir, 'pid'), `${process.ppid}\n`);
  const b = lock.acquire(home, { env });
  assert.strictEqual(b.ok, false, 'pisó un candado fresco de un proceso vivo');
  assert.strictEqual(b.pid, process.ppid);
  fs.rmSync(p.lockDir, { recursive: true, force: true });
});

test('T13 HarnessLock_DefaultPath_Unchanged @story-8.124 @ac-12 — sin opciones, lock.js usa harness.lock, el formato y la edad de siempre', () => {
  const lock = mod('lock');
  const state = mod('state');
  const home = casa('t13-lock');
  const env = labEnv(home);
  const p = state.paths(home);
  const a = lock.acquire(home, { env });
  assert.strictEqual(a.ok, true, JSON.stringify(a));
  assert.deepStrictEqual(fs.readdirSync(p.lockDir), ['pid'], 'el candado de siempre no lleva más que su pid');
  assert.strictEqual(fs.readFileSync(path.join(p.lockDir, 'pid'), 'utf8'), `${process.pid}\n${os.hostname()}\n`);
  lock.release(home);
  // dueño VIVO con más de 10 minutos: el candado de siempre se libera por edad (el de run-check no: Casos: skills/tycon-pipeline/scripts/tests/marker-run-check.test.js)
  fs.mkdirSync(p.lockDir, { recursive: true });
  fs.writeFileSync(path.join(p.lockDir, 'pid'), `${process.ppid}\n${os.hostname()}\n`);
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(path.join(p.lockDir, 'pid'), old, old);
  fs.utimesSync(p.lockDir, old, old);
  const b = lock.acquire(home, { env });
  assert.strictEqual(b.ok, true, `no lo liberó por edad: ${JSON.stringify(b)}`);
  // un dueño ilegible y fresco: ocupado; la edad de siempre (10 min) manda, no el minuto del de run-check
  lock.release(home);
  fs.mkdirSync(p.lockDir, { recursive: true });
  fs.writeFileSync(path.join(p.lockDir, 'pid'), '');
  const twoMin = new Date(Date.now() - 2 * 60 * 1000);
  fs.utimesSync(path.join(p.lockDir, 'pid'), twoMin, twoMin);
  fs.utimesSync(p.lockDir, twoMin, twoMin);
  assert.strictEqual(lock.acquire(home, { env }).ok, false, 'el ilegible de 2 min se liberó: la edad de siempre cambió');
  // TYCON_HARNESS_LOCK_HELD sigue valiendo para el candado de siempre
  fs.rmSync(p.lockDir, { recursive: true, force: true });
  assert.strictEqual(lock.acquire(home, { env: labEnv(home, { TYCON_HARNESS_LOCK_HELD: '1' }) }).held, true);
});

test('T2 · withLock corre fn y suelta; tomado → onBusy; si fn tira igual suelta; con LOCK_HELD no suelta el del padre', () => {
  const lock = mod('lock');
  const state = mod('state');
  const home = casa('t2-withlock');
  const env = labEnv(home);
  const p = state.paths(home);
  let seen = null;
  assert.strictEqual(lock.withLock(home, (l) => { seen = l; return 'hecho'; }, { env }), 'hecho');
  assert.ok(seen && seen.ok && !seen.held, 'fn no recibió el candado');
  assert.ok(!fs.existsSync(p.lockDir), 'withLock no soltó');
  assert.throws(() => lock.withLock(home, () => { throw new Error('adentro'); }, { env }), /adentro/);
  assert.ok(!fs.existsSync(p.lockDir), 'no soltó tras el error');
  assert.ok(lock.acquire(home, { env }).ok);
  const busy = lock.withLock(home, () => 'no tendría que correr', { env, onBusy: (b) => `ocupado: ${b.reason}` });
  assert.match(busy, /^ocupado: .*otra sesión/);
  lock.release(home);
  // el padre lo tiene: fn corre y el candado del padre (simulado) sigue ahí
  fs.mkdirSync(p.lockDir, { recursive: true });
  fs.writeFileSync(path.join(p.lockDir, 'pid'), '424242\n');
  assert.strictEqual(lock.withLock(home, () => 'con el del padre', { env: labEnv(home, { TYCON_HARNESS_LOCK_HELD: '1' }) }), 'con el del padre');
  assert.strictEqual(fs.readFileSync(path.join(p.lockDir, 'pid'), 'utf8').trim(), '424242', 'soltó el candado del padre');
  fs.rmSync(p.lockDir, { recursive: true, force: true });
});

test('T2 · dos escritores a la vez: dos procesos × 50 escrituras bajo candado, ninguna perdida', async () => {
  const state = mod('state');
  const home = casa('t2-writers');
  const tree = path.join(home, 'tree');
  fs.mkdirSync(tree);
  state.write(home, state.defaults({ tree, sources: [], mode: 'managed' }));
  const writer = path.join(BASE, 'writer.js');
  fs.writeFileSync(writer, `
'use strict';
const [home, n] = process.argv.slice(2);
const state = require(${JSON.stringify(path.join(MODULES, 'state.js'))});
const lock = require(${JSON.stringify(path.join(MODULES, 'lock.js'))});
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let done = 0;
while (done < Number(n)) {
  const ok = lock.withLock(home, () => {
    const r = state.read(home);
    if (r.status !== 'ok') throw new Error('estado ' + r.status + ': ' + r.reason);
    r.state.managed.push({ kind: 'lab', id: process.pid + '-' + done });
    r.state.last_apply = new Date().toISOString();
    state.write(home, r.state);
    return true;
  }, { env: process.env, onBusy: () => false });
  if (ok) done++; else nap(2);
}
`);
  const { spawn } = require('child_process');
  const runWriter = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [writer, home, '50'], { env: labEnv(home), stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, err }));
  });
  const [a, b] = await Promise.all([runWriter(), runWriter()]);
  assert.strictEqual(a.code, 0, a.err);
  assert.strictEqual(b.code, 0, b.err);
  const r = state.read(home);
  assert.strictEqual(r.status, 'ok', r.reason);
  assert.strictEqual(r.state.managed.length, 100, 'se perdieron escrituras');
  assert.strictEqual(new Set(r.state.managed.map((m) => m.id)).size, 100);
  const p = state.paths(home);
  assert.ok(!fs.existsSync(p.lockDir), 'quedó el candado tomado');
  assert.deepStrictEqual(fs.readdirSync(p.dir).filter((f) => f.startsWith('harness-state')), ['harness-state.json'], 'quedó un temporal');
});

// ─── T7·módulo · las fuentes (sources.js) sobre dos remotos bare ───────────────────────────────────────────────────

test('T7·módulo · detect: dos fuentes (harness, agent_skills) con url, ref, rewrites, dir, commit; una sola con skills/ y agents/ en la raíz; otra rama → rewrites', () => {
  const sources = mod('sources');
  const L = lab('t7-detect');
  const list = sources.detect({ tree: L.tree, home: L.home, env: L.env });
  assert.deepStrictEqual(list.map((s) => s.name), ['harness', 'agent_skills']);
  const [h, a] = list;
  assert.strictEqual(h.url, git(L.tree, ['remote', 'get-url', 'origin']));
  assert.strictEqual(h.ref, 'main');
  assert.strictEqual(h.rewrites, false);
  assert.strictEqual(fs.realpathSync(h.dir), fs.realpathSync(L.tree));
  assert.strictEqual(h.commit, git(L.tree, ['rev-parse', 'HEAD']));
  assert.strictEqual(h.previous, null);
  assert.strictEqual(a.url, git(L.skillsDir, ['remote', 'get-url', 'origin']));
  assert.strictEqual(fs.realpathSync(a.dir), fs.realpathSync(L.skillsDir));
  assert.strictEqual(a.commit, git(L.skillsDir, ['rev-parse', 'HEAD']));
  assert.strictEqual(sources.head(L.tree, { env: L.env }), h.commit);
  assert.strictEqual(sources.origin(L.tree, { env: L.env }), h.url);

  // una sola fuente: sin ~/.claude/agent-skills y con skills/ + agents/ en la raíz del clon
  const home2 = casa('t7-detect-single');
  const tree2 = L.harness.clone(path.join(BASE, 't7-detect-single-clones', 'harness'));
  fs.mkdirSync(path.join(tree2, 'skills', 'tycon-pipeline'), { recursive: true });
  fs.mkdirSync(path.join(tree2, 'agents'), { recursive: true });
  const one = sources.detect({ tree: tree2, home: home2, env: L.env });
  assert.deepStrictEqual(one.map((s) => s.name), ['harness']);

  // sin agent-skills y sin skills/ en la raíz: sólo el arnés igual (el requisito lo grita install, no detect)
  const tree3 = L.harness.clone(path.join(BASE, 't7-detect-none-clones', 'harness'));
  assert.deepStrictEqual(sources.detect({ tree: tree3, home: casa('t7-detect-none'), env: L.env }).map((s) => s.name), ['harness']);

  // la rama en la que esté el clon NO cambia la ref ni la vuelve «reescrita»: la ref seguida es main; lo que se reescribe
  // lo decide el remoto público.
  git(tree2, ['checkout', '-q', '-b', 'mirror/sync']);
  const rw = sources.detect({ tree: tree2, home: home2, env: L.env })[0];
  assert.strictEqual(rw.ref, 'main');
  assert.strictEqual(rw.rewrites, false);
});

test('T7·módulo · check: al día / hay nueva / no pude mirar — un origin cambiado o inalcanzable nunca es «al día»', () => {
  const sources = mod('sources');
  const L = lab('t7-check');
  const [h] = sources.detect({ tree: L.tree, home: L.home, env: L.env });
  let c = sources.check(h, { env: L.env, budgetS: 5 });
  assert.strictEqual(c.status, 'up_to_date', JSON.stringify(c));
  assert.strictEqual(c.from, h.commit);
  assert.strictEqual(c.to, h.commit);

  const v2 = L.harness.publish('CHANGES', 'v2');
  c = sources.check(h, { env: L.env, budgetS: 5 });
  assert.strictEqual(c.status, 'new', JSON.stringify(c));
  assert.strictEqual(c.from, h.commit);
  assert.strictEqual(c.to, v2);
  assert.strictEqual(git(L.tree, ['rev-parse', 'HEAD']), h.commit, 'check movió el árbol');

  // el origin del clon ya no es el fijado en el estado: se niega sin salir a la red
  const other = path.join(BASE, 'no-such-remote.git');
  git(L.tree, ['remote', 'set-url', 'origin', other]);
  c = sources.check(h, { env: L.env, budgetS: 5 });
  assert.strictEqual(c.status, 'unknown', JSON.stringify(c));
  assert.match(c.reason, /origin/);
  assert.ok(c.reason.includes(other) && c.reason.includes(h.url), `el motivo no nombra los dos orígenes: ${c.reason}`);

  // origin igual al estado pero inalcanzable: «no pude mirar», con el motivo, dentro del tope
  const h2 = Object.assign({}, h, { url: other });
  const t0 = Date.now();
  c = sources.check(h2, { env: L.env, budgetS: 5 });
  assert.strictEqual(c.status, 'unknown', JSON.stringify(c));
  assert.match(c.reason, /no pude|sin red/);
  assert.ok(Date.now() - t0 < 15000, 'tardó más que el tope');
  const f = sources.fetch(h2, { env: L.env, budgetS: 5 });
  assert.strictEqual(f.ok, false);
  assert.ok(f.reason, 'fetch fallido sin motivo');
});

test('T7·módulo · ref fija: plan + advance con merge --ff-only y previous en refs/tycon/previous/<name>; sucio → stash propio y reaplica; .dashboard/ no trackeado se aparta; divergido → no toca y lo nombra', () => {
  const sources = mod('sources');
  const L = lab('t7-fixed', { gitignore: 'node_modules/\n' });   // .dashboard/ NO ignorado: el caso medido del nocturno
  const [h] = sources.detect({ tree: L.tree, home: L.home, env: L.env });
  const from = h.commit;
  L.harness.publish('README.md', 'v2');
  const to = L.harness.publish('.dashboard/sdlc-stage.json', '{"from":"nocturno"}');
  // lo local: un trackeado modificado que lo publicado NO toca, y el no trackeado que el respaldo local escribe
  fs.writeFileSync(path.join(L.tree, 'VERSION'), '1-local\n');
  fs.mkdirSync(path.join(L.tree, '.dashboard'), { recursive: true });
  fs.writeFileSync(path.join(L.tree, '.dashboard', 'sdlc-stage.json'), '{"from":"local"}\n');

  assert.strictEqual(sources.fetch(h, { env: L.env, budgetS: 5 }).ok, true);
  const p = sources.plan(h, { env: L.env, home: L.home });
  assert.strictEqual(p.ok, true, p.reason);
  assert.deepStrictEqual([p.from, p.to, p.dirty, p.divergent], [from, to, true, false], JSON.stringify(p));

  const a = sources.advance(h, { env: L.env, home: L.home });
  assert.strictEqual(a.ok, true, a.reason);
  assert.deepStrictEqual([a.from, a.to, a.stashed], [from, to, true], JSON.stringify(a));
  assert.deepStrictEqual(a.setAside, ['.dashboard/sdlc-stage.json']);
  assert.strictEqual(git(L.tree, ['rev-parse', 'HEAD']), to);
  assert.strictEqual(git(L.tree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.strictEqual(fs.readFileSync(path.join(L.tree, 'VERSION'), 'utf8'), '1-local\n', 'lo local no se reaplicó');
  assert.strictEqual(fs.readFileSync(path.join(L.tree, '.dashboard', 'sdlc-stage.json'), 'utf8').trim(), '{"from":"nocturno"}', 'lo publicado no ganó');
  assert.match(git(L.tree, ['stash', 'list']), /tycon-harness/, 'lo apartado no quedó recuperable en el stash');
  assert.strictEqual(git(L.tree, ['rev-parse', 'refs/tycon/previous/harness']), from);
  assert.strictEqual(sources.isClean(L.tree, { env: L.env }).clean, false, 'VERSION modificado tendría que verse');

  // al día: plan lo dice y advance no mueve nada
  const again = sources.plan(h, { env: L.env, home: L.home });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.from, again.to);

  // divergido: un commit propio → no toca nada y nombra el motivo
  git(L.tree, ['add', 'VERSION']);
  git(L.tree, ['commit', '-q', '-m', 'commit propio']);
  const mine = git(L.tree, ['rev-parse', 'HEAD']);
  L.harness.publish('CHANGES', 'v4');
  assert.strictEqual(sources.fetch(h, { env: L.env, budgetS: 5 }).ok, true);
  const d = sources.plan(h, { env: L.env, home: L.home });
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.divergent, true);
  assert.match(d.reason, /divergi/);
  const na = sources.advance(h, { env: L.env, home: L.home });
  assert.strictEqual(na.ok, false);
  assert.strictEqual(git(L.tree, ['rev-parse', 'HEAD']), mine, 'advance movió un árbol divergido');

  // en otra rama: tampoco
  git(L.tree, ['checkout', '-q', '-b', 'feature/x']);
  const b = sources.plan(h, { env: L.env, home: L.home });
  assert.strictEqual(b.ok, false);
  assert.match(b.reason, /feature\/x/);
});

// Lo SIN SEGUIR no traba el reset, salvo que choque con una ruta que la versión nueva trae. Lo modificado en lo que
// el arnés sigue traba como siempre.
// 🔴 Si lo sin seguir trabara, `skills/other` sin seguir daría `ok: false` («el árbol tiene cambios fuera
//    de lo ignorado…»), el choque de `README.md` no se nombraría como tal (`colliding`) y desde otra rama el
//    plan daría `ok: true` (`checkout -B` sacaría a la persona de su rama).
test('T7·módulo · ref reescrita: tycon/installed + reset --hard; lo modificado en lo que el arnés sigue traba; lo sin seguir no, salvo el que choca con una ruta nueva (D3); sólo desde tycon/installed o la primera vez (A5); previous sobrevive a un gc; revert vuelve', () => {
  const sources = mod('sources');
  const L = lab('t7-rewrite');
  const [, a0] = sources.detect({ tree: L.tree, home: L.home, env: L.env });
  const src = Object.assign({}, a0, { rewrites: true });
  const from = src.commit;
  const to = L.skills.publish('README.md', 'punta reescrita', { force: true });
  assert.notStrictEqual(to, from);
  assert.strictEqual(sources.fetch(src, { env: L.env, budgetS: 5 }).ok, true);

  // una skill de terceros declarada y una skill propia que nadie declaró ni ignoró: sin seguir, ninguna traba
  fs.mkdirSync(path.join(L.skillsDir, 'skills', 'vendor-x'), { recursive: true });
  fs.writeFileSync(path.join(L.skillsDir, 'skills', 'vendor-x', 'SKILL.md'), '# de terceros\n');
  fs.writeFileSync(path.join(L.home, '.claude', '.tycon-pipeline', 'third-party-state.json'),
    JSON.stringify({ version: 1, entries: { 'skills/vendor-x': { tree: 'x', complete: true, files: {} } } }));
  fs.mkdirSync(path.join(L.skillsDir, 'skills', 'other'), { recursive: true });
  fs.writeFileSync(path.join(L.skillsDir, 'skills', 'other', 'SKILL.md'), '# propia, sin declarar\n');
  let p = sources.plan(src, { env: L.env, home: L.home });
  assert.strictEqual(p.ok, true, `una skill propia sin seguir y sin choque no traba: ${p.reason}`);
  assert.deepStrictEqual([p.from, p.to, p.dirty], [from, to, false]);

  // un archivo sin seguir en una ruta que la versión nueva TRAE: no se toca nada y se nombra la ruta
  fs.writeFileSync(path.join(L.skillsDir, 'README.md'), 'lo mío, sin seguir\n');
  p = sources.plan(src, { env: L.env, home: L.home });
  assert.strictEqual(p.ok, false);
  assert.deepStrictEqual(p.colliding, ['README.md']);
  assert.ok(p.reason.includes('README.md') && /sin seguir/.test(p.reason), `no nombra la ruta que choca: ${p.reason}`);
  assert.ok(!p.reason.includes('skills/other') && !p.reason.includes('vendor-x'), `nombra lo que no choca: ${p.reason}`);
  assert.strictEqual(sources.advance(src, { env: L.env, home: L.home }).ok, false);
  assert.strictEqual(git(L.skillsDir, ['rev-parse', 'HEAD']), from, 'hizo reset con un archivo sin seguir en el camino');
  assert.strictEqual(fs.readFileSync(path.join(L.skillsDir, 'README.md'), 'utf8'), 'lo mío, sin seguir\n', 'pisó el archivo de la persona');
  fs.rmSync(path.join(L.skillsDir, 'README.md'));
  // …también cuando lo sin seguir es un archivo donde la versión nueva trae una carpeta, o al revés
  assert.deepStrictEqual(sources.untrackedInTheWay(L.skillsDir, to, L.env), []);
  fs.mkdirSync(path.join(L.skillsDir, 'README.md'));
  fs.writeFileSync(path.join(L.skillsDir, 'README.md', 'nota.txt'), 'x\n');
  assert.deepStrictEqual(sources.untrackedInTheWay(L.skillsDir, to, L.env), ['README.md/nota.txt']);
  fs.rmSync(path.join(L.skillsDir, 'README.md'), { recursive: true });

  // lo modificado en un archivo que el arnés sigue: traba (el reset lo perdería), y se dice
  fs.writeFileSync(path.join(L.skillsDir, 'VERSION'), 'tocado por la persona\n');
  p = sources.plan(src, { env: L.env, home: L.home });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.dirty, true);
  assert.ok(p.reason.includes('VERSION') && /sin commitear/.test(p.reason), `no nombra lo modificado: ${p.reason}`);
  assert.strictEqual(sources.advance(src, { env: L.env, home: L.home }).ok, false);
  assert.strictEqual(git(L.skillsDir, ['rev-parse', 'HEAD']), from, 'hizo reset con el árbol modificado');
  git(L.skillsDir, ['checkout', '-q', '--', 'VERSION']);

  // desde otra rama con un commit propio (HEAD ya no es el commit registrado): no se toca y se dice
  git(L.skillsDir, ['checkout', '-q', '-b', 'mine']);
  git(L.skillsDir, ['commit', '-q', '--allow-empty', '-m', 'commit propio']);
  p = sources.plan(src, { env: L.env, home: L.home });
  assert.strictEqual(p.ok, false);
  assert.ok(/rama mine/.test(p.reason) && p.reason.includes('tycon/installed'), `no dice la rama: ${p.reason}`);
  assert.strictEqual(sources.advance(src, { env: L.env, home: L.home }).ok, false);
  assert.strictEqual(git(L.skillsDir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'mine', 'sacó a la persona de su rama');
  // espejo: de vuelta en el commit registrado (la primera vez, todavía en main) sí se mueve
  git(L.skillsDir, ['checkout', '-q', 'main']);
  p = sources.plan(src, { env: L.env, home: L.home });
  assert.strictEqual(p.ok, true, p.reason);
  const adv = sources.advance(src, { env: L.env, home: L.home });
  assert.strictEqual(adv.ok, true, adv.reason);
  assert.deepStrictEqual([adv.from, adv.to], [from, to]);
  assert.strictEqual(git(L.skillsDir, ['rev-parse', 'HEAD']), to);
  assert.strictEqual(git(L.skillsDir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'tycon/installed');
  assert.strictEqual(git(L.skillsDir, ['rev-parse', 'refs/tycon/previous/agent_skills']), from);
  assert.ok(fs.existsSync(path.join(L.skillsDir, 'skills', 'vendor-x', 'SKILL.md')), 'el reset se llevó la skill de terceros');
  assert.ok(fs.existsSync(path.join(L.skillsDir, 'skills', 'other', 'SKILL.md')), 'el reset se llevó la skill propia');

  // la rama se reescribe otra vez: ya en tycon/installed se mueve aunque HEAD no sea el commit registrado de `src`
  const to2 = L.skills.publish('README.md', 'punta reescrita, segunda vez', { force: true });
  assert.strictEqual(sources.fetch(src, { env: L.env, budgetS: 5 }).ok, true);
  const adv2 = sources.advance(src, { env: L.env, home: L.home });
  assert.strictEqual(adv2.ok, true, adv2.reason);
  assert.deepStrictEqual([adv2.from, adv2.to], [to, to2]);
  assert.strictEqual(git(L.skillsDir, ['rev-parse', 'refs/tycon/previous/agent_skills']), to);

  // previous sobrevive a un gc. `to` ya no es ancestro de nada (la rama se reescribió): lo único que lo sostiene, además
  // del registro de movimientos (reflog), es la ref — por eso el reflog se vacía ANTES de podar; si no, pasa sin la ref
  const exists = (sha) => { try { git(L.skillsDir, ['cat-file', '-e', `${sha}^{commit}`]); return true; } catch (_) { return false; } };
  git(L.skillsDir, ['reflog', 'expire', '--expire=now', '--all']);
  git(L.skillsDir, ['gc', '-q', '--prune=now']);
  assert.strictEqual(git(L.skillsDir, ['rev-parse', 'refs/tycon/previous/agent_skills']), to);
  assert.strictEqual(exists(to), true, 'el gc se llevó el commit de previous');
  const rv = sources.revert(src, to, { env: L.env });
  assert.strictEqual(rv.ok, true, rv.reason);
  assert.strictEqual(git(L.skillsDir, ['rev-parse', 'HEAD']), to);
  // espejo (la prueba tiene dientes): sin la ref y sin reflog, el mismo gc SÍ se lleva un commit reescrito
  assert.strictEqual(sources.advance(src, { env: L.env, home: L.home }).ok, true);
  git(L.skillsDir, ['update-ref', '-d', 'refs/tycon/previous/agent_skills']);
  git(L.skillsDir, ['reflog', 'expire', '--expire=now', '--all']);
  git(L.skillsDir, ['gc', '-q', '--prune=now']);
  assert.strictEqual(exists(to), false, 'sin la ref ni el reflog el commit tenía que podarse: el caso de arriba no probaría nada');
});

// Un clon del público cuyo HEAD avanzó en `main` ANTES de su
// primera actualización (un `git pull` a mano, o el respaldo en shell) no puede quedar bloqueado para siempre, y el remedio
// impreso (`checkout tycon/installed`) no puede fallar porque esa rama todavía no existe. La regla no cambia —no se saca a una
// persona de una rama propia ni se pisan commits propios—; «la primera vez» vale también para un avance simple.
// 🔴 Sin esto, `offInstalledBranch` devolvería «agent_skills está en la rama main y no en tycon/installed: no se toca
//    (git -C … checkout tycon/installed)» para el clon que sólo hizo `git pull` (el primer `strictEqual(…, null)`), y
//    `sources.ownCommits is not a function`.
test('T7·módulo · ref reescrita, la primera vez con HEAD movido: un avance simple en la rama por defecto pasa; commits propios, otra rama, hacia atrás o archivos seguidos modificados no — y el remedio que se imprime se puede correr', () => {
  const sources = mod('sources');
  const L = lab('t7-first-time');
  const env = L.env;
  const opts = { env, home: L.home };
  let n = 0;
  const clone = () => {
    const dir = L.skills.clone(path.join(BASE, 't7-first-time-clones', `c${++n}`));
    return { name: 'agent_skills', url: git(dir, ['remote', 'get-url', 'origin']), ref: 'main', rewrites: true, dir, commit: git(dir, ['rev-parse', 'HEAD']), previous: null };
  };
  const headOf = (s) => git(s.dir, ['rev-parse', 'HEAD']);
  const branchOf = (s) => git(s.dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // el comando que el mensaje aconseja, corrido tal cual (sin intérprete: cada palabra es un argumento de git)
  const runAdvised = (reason, re) => {
    const m = re.exec(reason);
    assert.ok(m, `el motivo no trae un comando para correr: ${reason}`);
    const words = m[0].split(' ');
    assert.deepStrictEqual(words.slice(0, 2), ['git', '-C']);
    return git(words[2], words.slice(3));
  };
  const CREATE = /git -C \S+ checkout -b tycon\/installed [0-9a-f]{40}/;
  const dead = (reason) => / checkout tycon\/installed/.test(reason);   // el consejo viejo: una rama que no existe

  // (1) un `git pull --ff-only` a mano en main, sin commits propios y con lo seguido limpio: pasa, y la versión siguiente entra
  const pulled = clone();
  const registered = pulled.commit;
  const v2 = L.skills.publish('CHANGES', 'v2');
  git(pulled.dir, ['pull', '-q', '--ff-only', 'origin', 'main']);
  assert.strictEqual(headOf(pulled), v2);
  assert.notStrictEqual(v2, registered);
  assert.strictEqual(sources.ownCommits(pulled.dir, env), 0);
  assert.strictEqual(sources.offInstalledBranch(pulled, opts), null, 'un avance simple en la rama por defecto es «la primera vez»');
  fs.writeFileSync(path.join(pulled.dir, 'NOTA.md'), 'sin seguir: no cuenta como modificado\n');
  assert.strictEqual(sources.offInstalledBranch(pulled, opts), null, 'un archivo sin seguir no traba (D3)');
  const v3 = L.skills.publish('CHANGES', 'v3');
  assert.strictEqual(sources.fetch(pulled, { env, budgetS: 5 }).ok, true);
  const adv = sources.advance(pulled, opts);
  assert.strictEqual(adv.ok, true, adv.reason);
  assert.deepStrictEqual([adv.from, adv.to, headOf(pulled), branchOf(pulled)], [v2, v3, v3, 'tycon/installed']);
  assert.strictEqual(git(pulled.dir, ['rev-parse', 'refs/tycon/previous/agent_skills']), v2);

  // (2) lo mismo con un archivo SEGUIDO modificado: no pasa, dice cuál y cómo apartarlo; apartado, pasa
  const dirty = clone();   // registrado: v3
  const v4 = L.skills.publish('CHANGES', 'v4');
  git(dirty.dir, ['pull', '-q', '--ff-only', 'origin', 'main']);
  fs.writeFileSync(path.join(dirty.dir, 'VERSION'), 'tocado por la persona\n');
  let off = sources.offInstalledBranch(dirty, opts);
  assert.ok(off && off.includes('VERSION') && /sin commitear/.test(off), `no nombra lo modificado: ${off}`);
  assert.ok(!dead(off), `aconseja una rama que no existe: ${off}`);
  runAdvised(off, /git -C \S+ stash push/);
  assert.strictEqual(sources.offInstalledBranch(dirty, opts), null, 'apartado lo modificado, el avance simple pasa');

  // (3) un commit propio en main: no se toca, y el remedio (crear tycon/installed en el commit registrado) funciona y
  //     deja el commit propio en su rama
  const own = clone();   // registrado: v4
  git(own.dir, ['commit', '-q', '--allow-empty', '-m', 'commit propio']);
  const mine = headOf(own);
  assert.strictEqual(sources.ownCommits(own.dir, env), 1);
  off = sources.offInstalledBranch(own, opts);
  assert.ok(off && /rama main/.test(off) && /1 commit/.test(off), `no dice qué hay: ${off}`);
  assert.ok(!dead(off), `aconseja una rama que no existe: ${off}`);
  const v5 = L.skills.publish('CHANGES', 'v5');
  assert.strictEqual(sources.fetch(own, { env, budgetS: 5 }).ok, true);
  const blocked = sources.plan(own, opts);
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.reason, off);
  assert.strictEqual(sources.advance(own, opts).ok, false);
  assert.deepStrictEqual([headOf(own), branchOf(own)], [mine, 'main'], 'movió un clon con commits propios');
  runAdvised(off, CREATE);
  assert.deepStrictEqual([headOf(own), branchOf(own)], [v4, 'tycon/installed']);
  assert.strictEqual(git(own.dir, ['rev-parse', 'main']), mine, 'el commit propio no quedó en su rama');
  assert.strictEqual(sources.offInstalledBranch(own, opts), null);
  assert.strictEqual(sources.advance(own, opts).ok, true);
  assert.strictEqual(headOf(own), v5);
  assert.strictEqual(git(own.dir, ['rev-parse', 'main']), mine, 'el avance tocó la rama de la persona');

  // (4) hacia atrás en main (HEAD publicado, pero no desciende del registrado): no es un avance simple
  const back = clone();   // registrado: v5
  git(back.dir, ['reset', '-q', '--hard', v4]);
  off = sources.offInstalledBranch(back, opts);
  assert.ok(off && /no desciende/.test(off), `no dice qué hay: ${off}`);
  assert.ok(!dead(off), `aconseja una rama que no existe: ${off}`);
  runAdvised(off, CREATE);
  assert.deepStrictEqual([headOf(back), branchOf(back)], [v5, 'tycon/installed']);

  // (5) en una rama propia, aunque no tenga commits propios: no se la saca de su rama
  const other = clone();   // registrado: v5
  const v6 = L.skills.publish('CHANGES', 'v6');
  git(other.dir, ['checkout', '-q', '-b', 'mine']);
  git(other.dir, ['pull', '-q', '--ff-only', 'origin', 'main']);
  assert.strictEqual(headOf(other), v6);
  off = sources.offInstalledBranch(other, opts);
  assert.ok(off && /rama mine/.test(off) && off.includes('tycon/installed'), `no dice la rama: ${off}`);
  assert.ok(!dead(off), `aconseja una rama que no existe: ${off}`);
  runAdvised(off, CREATE);
  assert.strictEqual(git(other.dir, ['rev-parse', 'mine']), v6, 'la rama de la persona se movió');
  assert.strictEqual(sources.offInstalledBranch(other, opts), null);

  // (6) espejo de siempre: cuando tycon/installed YA existe y el clon está en otra rama, el remedio es volver a ella
  git(other.dir, ['checkout', '-q', 'mine']);
  off = sources.offInstalledBranch(other, opts);
  assert.ok(off && /rama mine/.test(off), off);
  runAdvised(off, /git -C \S+ checkout tycon\/installed/);
  assert.strictEqual(branchOf(other), 'tycon/installed');

  // (7) sin rama (HEAD suelto) con un commit propio: crear tycon/installed desde ahí lo dejaría sin rama — primero se
  //     guarda en una rama de la persona; ya en ella, el remedio es el de siempre y el commit queda donde estaba
  const loose = clone();   // registrado: v6
  git(loose.dir, ['checkout', '-q', '--detach']);
  git(loose.dir, ['commit', '-q', '--allow-empty', '-m', 'commit propio, sin rama']);
  const kept = headOf(loose);
  off = sources.offInstalledBranch(loose, opts);
  assert.ok(off && /sin rama/.test(off) && /1 commit/.test(off) && off.includes(`git -C ${loose.dir} checkout -b <nombre>`), `no dice qué hay ni cómo guardarlo: ${off}`);
  assert.ok(!dead(off) && !CREATE.test(off), `aconseja un comando que deja el commit sin rama: ${off}`);
  git(loose.dir, ['checkout', '-q', '-b', 'saved']);
  runAdvised(sources.offInstalledBranch(loose, opts), CREATE);
  assert.deepStrictEqual([branchOf(loose), git(loose.dir, ['rev-parse', 'saved'])], ['tycon/installed', kept]);
});

// `offInstalledBranch` no puede decidir «la rama tycon/installed no existe»
// por un `.ok` falso de git: un ref roto (basura en el archivo, un commit que no está, un tope de tiempo) sale con ese
// mismo `.ok` falso: «no sé» leído como «primera vez» movería el clon. Es la clase de `versionAt`: «no pude leer» no
// es «no hay». Lo mismo con `merge-base --is-ancestor` (un objeto roto no es «no es ancestro») y con HEAD.
// 🔴 Sin esto: `sources.refState is not a function`; y, sobre el mismo repo de
//    juguete, `offInstalledBranch` con el archivo de la ref lleno de basura devolvería `null` («podés moverte»).
test('T7·módulo · una ref en tres estados (existe / no existe / no se pudo leer): una rama tycon/installed ilegible NO es «la primera vez»; un merge-base que falla no es «no es ancestro»; un HEAD ilegible no es «sin versión»', () => {
  const sources = mod('sources');
  const L = lab('t7-ref-state');
  const env = L.env;
  const opts = { env, home: L.home };
  const dir = L.skills.clone(path.join(BASE, 't7-ref-state-clones', 'c1'));
  const v1 = git(dir, ['rev-parse', 'HEAD']);
  const src = { name: 'agent_skills', url: git(dir, ['remote', 'get-url', 'origin']), ref: 'main', rewrites: true, dir, commit: v1, previous: null };
  const REF = 'refs/heads/tycon/installed';
  const file = path.join(dir, '.git', 'refs', 'heads', 'tycon', 'installed');
  const state = () => sources.refState(dir, REF, { env });
  const GARBAGE = 'esto no es un sha\n';

  // los tres estados
  assert.deepStrictEqual(state(), { status: 'absent', sha: null, reason: null }, 'una ref que de verdad no está');
  git(dir, ['branch', 'tycon/installed']);
  assert.deepStrictEqual(state(), { status: 'ok', sha: v1, reason: null }, 'una ref sana');
  const broken = [
    ['basura en el archivo de la ref', () => fs.writeFileSync(file, GARBAGE)],
    ['el archivo de la ref vacío', () => fs.writeFileSync(file, '')],
    ['apunta a un commit que no está en el clon', () => fs.writeFileSync(file, `${'0'.repeat(39)}7\n`)],
  ];
  for (const [what, breakIt] of broken) {
    breakIt();
    const r = state();
    assert.strictEqual(r.status, 'problem', `${what}: es «no se pudo leer», no «no existe» (${JSON.stringify(r)})`);
    assert.strictEqual(r.sha, null);
    assert.ok(r.reason && r.reason.length > 0, `${what}: sin motivo`);
    // …y no depende del idioma de git ni del de la sesión
    assert.strictEqual(sources.refState(dir, REF, { env: Object.assign({}, env, { LC_ALL: 'es_ES.UTF-8', LANG: 'es_ES.UTF-8', LANGUAGE: 'es' }) }).status, 'problem', what);
  }
  // otra operación de git la está escribiendo (quedó su .lock): tampoco es «no existe»
  fs.rmSync(file);
  fs.writeFileSync(`${file}.lock`, '');
  assert.strictEqual(state().status, 'problem', 'con el .lock de la ref puesto');
  fs.rmSync(`${file}.lock`);
  assert.strictEqual(state().status, 'absent', 'sin el archivo ni el .lock: ausente de verdad');
  assert.strictEqual(sources.refState(dir, REF, { env: Object.assign({}, env, { LC_ALL: 'es_ES.UTF-8', LANG: 'es_ES.UTF-8', LANGUAGE: 'es' }) }).status, 'absent');
  // git que no puede correr (la carpeta no es un clon): problema
  assert.strictEqual(sources.refState(L.home, REF, { env }).status, 'problem');
  // un commit, en tres estados
  assert.strictEqual(sources.commitState(dir, v1, { env }).status, 'ok');
  assert.strictEqual(sources.commitState(dir, 'f'.repeat(40), { env }).status, 'absent');
  assert.strictEqual(sources.commitState(L.home, v1, { env }).status, 'problem');

  // offInstalledBranch con la ref corrompida: NO es «podés moverte», y nombra la ref — para update y para rollback
  const v2 = L.skills.publish('CHANGES', 'v2');
  assert.strictEqual(sources.fetch(src, { env, budgetS: 5 }).ok, true);
  fs.writeFileSync(file, GARBAGE);
  for (const extra of [{}, { onlyFromInstalled: true, who: 'rollback' }]) {
    const off = sources.offInstalledBranch(src, Object.assign({}, opts, extra));
    assert.ok(off, `con la ref ilegible devolvió «podés moverte» (${JSON.stringify(extra)})`);
    assert.ok(off.includes(REF) && /no pude leer/.test(off), `no nombra la ref que no se pudo leer: ${off}`);
    assert.ok(!/checkout/.test(off), `aconseja un comando sobre una ref que no se pudo leer: ${off}`);
  }
  let p = sources.plan(src, opts);
  assert.strictEqual(p.ok, false, 'el plan dio vía libre con la rama del mecanismo ilegible');
  assert.ok(p.reason.includes(REF), p.reason);
  assert.strictEqual(sources.advance(src, opts).ok, false);
  assert.strictEqual(git(dir, ['rev-parse', 'HEAD']), v1, 'movió el clon sin saber si la rama existe');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), GARBAGE, 'pisó la ref que no pudo leer');
  // espejo: ausente de verdad → el camino de siempre (la primera vez: pasa, y avanza a tycon/installed)
  fs.rmSync(file);
  assert.strictEqual(sources.offInstalledBranch(src, opts), null);
  const adv = sources.advance(src, opts);
  assert.strictEqual(adv.ok, true, adv.reason);
  assert.deepStrictEqual([git(dir, ['rev-parse', 'HEAD']), git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])], [v2, 'tycon/installed']);

  // parado EN tycon/installed con esa ref rota, HEAD no se puede leer: `check` es «no pude mirar» (ni «al día» ni «nueva»),
  // offInstalledBranch lo dice igual, y plan no da vía libre
  const v3 = L.skills.publish('CHANGES', 'v3');
  fs.writeFileSync(file, GARBAGE);
  const c = sources.check(Object.assign({}, src, { commit: v2 }), { env, budgetS: 5, channel: 'stable' });
  assert.strictEqual(c.status, 'unknown', JSON.stringify(c));
  assert.ok(/HEAD/.test(c.reason), `no dice que no pudo leer HEAD: ${c.reason}`);
  assert.ok(sources.offInstalledBranch(Object.assign({}, src, { commit: v2 }), opts).includes(REF));
  p = sources.plan(Object.assign({}, src, { commit: v2 }), opts);
  assert.strictEqual(p.ok, false);
  assert.ok(p.reason && p.reason.length > 0);
  // espejo: sana otra vez, mira y encuentra la versión nueva
  fs.writeFileSync(file, `${v2}\n`);
  const c2 = sources.check(Object.assign({}, src, { commit: v2 }), { env, budgetS: 5, channel: 'stable' });
  assert.deepStrictEqual([c2.status, c2.from, c2.to], ['new', v2, v3]);

  // la ref remota ilegible no es «no hay nada traído»: plan lo dice con su nombre
  const remote = path.join(dir, '.git', 'refs', 'remotes', 'origin', 'main');
  const packed = git(dir, ['rev-parse', 'refs/remotes/origin/main']);
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  fs.writeFileSync(remote, GARBAGE);
  p = sources.plan(Object.assign({}, src, { commit: v2 }), opts);
  assert.strictEqual(p.ok, false);
  assert.ok(p.reason.includes('refs/remotes/origin/main') && /no pude leer/.test(p.reason), `no nombra la ref remota ilegible: ${p.reason}`);
  fs.writeFileSync(remote, `${packed}\n`);
  assert.strictEqual(sources.plan(Object.assign({}, src, { commit: v2 }), opts).ok, true);

  // la ascendencia, en tres estados: un merge-base que falla (un commit que no está) no es «no es ancestro»
  assert.strictEqual(sources.ancestor(dir, v1, v2, env), true);
  assert.strictEqual(sources.ancestor(dir, v2, v1, env), false);
  assert.strictEqual(sources.ancestor(dir, 'f'.repeat(40), v2, env), null);
  assert.strictEqual(sources.ancestor(L.home, v1, v2, env), null);
  // …y assess de una ref fija no lo lee como «hay nueva»: «no sé»
  const fixed = { name: 'agent_skills', dir, rewrites: false };
  assert.strictEqual(sources.assess(fixed, v1, v2, { env }).status, 'new');
  assert.strictEqual(sources.assess(fixed, v2, v1, { env }).status, 'up_to_date');
  const a = sources.assess(fixed, v1, 'f'.repeat(40), { env, labels: { to: 'origin/main' } });
  assert.strictEqual(a.status, 'unknown', JSON.stringify(a));
  assert.ok(a.reason && /origin\/main/.test(a.reason), `el motivo no nombra la ref: ${a.reason}`);
});

// `untrackedInTheWay` tiene que ver (C) una carpeta sin seguir que es un repo de
// git propio —git la lista como `carpeta/`, con barra final— y (D) una ruta que difiere sólo en la caja o en la forma de
// los acentos, que en el disco de Mac y de Windows es el MISMO archivo: `reset --hard` las pisaría sin avisar. La
// comparación se prueba con RUTAS (vale igual en un disco que sí distingue: ahí frena de más, que es lo aceptado).
// 🔴 Sin esto: `sources.collidingPaths is not a function`; y con el repo anidado, `untrackedInTheWay` devolvería `[]`.
test('T7·módulo · D3, los choques que no son «el mismo texto»: un repo anidado sin seguir (carpeta con barra final), la caja y la forma de los acentos; archivo contra carpeta en los dos sentidos; rutas con espacios y no ASCII', () => {
  const sources = mod('sources');
  const hit = (untracked, incoming) => sources.collidingPaths(untracked, incoming);
  // (C) una carpeta sin seguir (repo anidado): choca con cualquier ruta igual a ella o por debajo, o con un archivo
  //     que se llama como ella o como una de sus carpetas madre
  assert.deepStrictEqual(hit(['skills/mine/'], ['README.md', 'skills/mine/SKILL.md', 'skills/mine/NOTES.md']), [{ path: 'skills/mine/', with: 'skills/mine/SKILL.md' }]);
  assert.deepStrictEqual(hit(['skills/mine/'], ['skills/mine/deep/er/x.md']), [{ path: 'skills/mine/', with: 'skills/mine/deep/er/x.md' }]);
  assert.deepStrictEqual(hit(['skills/mine/'], ['skills/mine']), [{ path: 'skills/mine/', with: 'skills/mine' }]);
  assert.deepStrictEqual(hit(['skills/mine/'], ['skills']), [{ path: 'skills/mine/', with: 'skills' }]);
  // espejo: un repo anidado que NO choca (vecinos, prefijos que no son la carpeta)
  assert.deepStrictEqual(hit(['skills/mine/'], ['skills/other/SKILL.md', 'skills/mine-2/SKILL.md', 'skills/min', 'skills/mine.md']), []);
  // el sentido inverso: lo nuevo es una carpeta y lo sin seguir un archivo con ese nombre; y un archivo bajo lo que la
  // versión nueva trae como archivo
  assert.deepStrictEqual(hit(['docs'], ['docs/a.md']), [{ path: 'docs', with: 'docs/a.md' }]);
  assert.deepStrictEqual(hit(['README.md/nota.txt'], ['README.md']), [{ path: 'README.md/nota.txt', with: 'README.md' }]);
  // (D) la caja: un archivo, y una carpeta que difiere sólo en la caja
  assert.deepStrictEqual(hit(['Notes.md'], ['notes.md']), [{ path: 'Notes.md', with: 'notes.md' }]);
  assert.deepStrictEqual(hit(['skills-own/Mine/SKILL.md'], ['skills-own/mine/SKILL.md']), [{ path: 'skills-own/Mine/SKILL.md', with: 'skills-own/mine/SKILL.md' }]);
  assert.deepStrictEqual(hit(['Docs/'], ['docs/a.md']), [{ path: 'Docs/', with: 'docs/a.md' }]);
  assert.deepStrictEqual(hit(['DOCS'], ['docs/a.md']), [{ path: 'DOCS', with: 'docs/a.md' }]);
  // …y la forma de los acentos (compuesta contra descompuesta), y la «ſ» larga contra la «s»
  assert.deepStrictEqual(hit(['café.md'], ['café.md']), [{ path: 'café.md', with: 'café.md' }]);
  assert.deepStrictEqual(hit(['meſa.md'], ['mesa.md']), [{ path: 'meſa.md', with: 'mesa.md' }]);
  // espejo: nombres realmente distintos no chocan — tampoco un archivo distinto dentro de una carpeta que difiere en la
  // caja (en el disco es la misma carpeta, y ese archivo nadie lo pisa)
  assert.deepStrictEqual(hit(['Notes.md', 'notas.md', 'Skills/x.md'], ['notes.txt', 'note.md', 'skills/y.md']), []);
  // rutas con espacios y no ASCII: enteras, sin comillas ni escapes
  assert.deepStrictEqual(hit(['mis notas/ñandú 1.md', 'otra cosa.md'], ['mis notas/ñandú 1.md']), [{ path: 'mis notas/ñandú 1.md', with: 'mis notas/ñandú 1.md' }]);
  assert.deepStrictEqual(hit([], ['a']), []);

  // con git de verdad: un repo anidado sin seguir, con trabajo sin commitear, contra una versión que trae rutas bajo él
  const L = lab('t7-nested');
  const [, a0] = sources.detect({ tree: L.tree, home: L.home, env: L.env });
  const src = Object.assign({}, a0, { rewrites: true });
  const from = src.commit;
  const nested = path.join(L.skillsDir, 'skills', 'mine');
  fs.mkdirSync(nested, { recursive: true });
  git(nested, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(nested, 'SKILL.md'), 'mi skill\n');
  git(nested, ['add', '-A']);
  git(nested, ['commit', '-q', '-m', 'mi skill']);
  fs.writeFileSync(path.join(nested, 'SKILL.md'), 'TRABAJO SIN COMMITEAR\n');
  fs.writeFileSync(path.join(nested, 'NOTES.md'), 'notas mías\n');
  // rutas con espacios y no ASCII, sin seguir: una choca y la otra no
  fs.mkdirSync(path.join(L.skillsDir, 'mis notas'), { recursive: true });
  fs.writeFileSync(path.join(L.skillsDir, 'mis notas', 'ñandú 1.md'), 'mío\n');
  fs.writeFileSync(path.join(L.skillsDir, 'mis notas', 'otra.md'), 'mío\n');
  L.skills.publish('skills/mine/SKILL.md', 'la del arnés');
  const to = L.skills.publish('mis notas/ñandú 1.md', 'la del arnés');
  assert.strictEqual(sources.fetch(src, { env: L.env, budgetS: 5 }).ok, true);
  assert.deepStrictEqual(sources.untrackedInTheWay(L.skillsDir, to, L.env).sort(), ['mis notas/ñandú 1.md', 'skills/mine/']);
  const p = sources.plan(src, { env: L.env, home: L.home });
  assert.strictEqual(p.ok, false, 'el plan dio vía libre con un repo anidado en el camino');
  assert.ok(p.reason.includes('skills/mine/') && p.reason.includes('skills/mine/SKILL.md') && p.reason.includes('mis notas/ñandú 1.md'), `no nombra las rutas que chocan: ${p.reason}`);
  assert.ok(!p.reason.includes('otra.md'), `nombra lo que no choca: ${p.reason}`);
  assert.strictEqual(sources.advance(src, { env: L.env, home: L.home }).ok, false);
  assert.strictEqual(git(L.skillsDir, ['rev-parse', 'HEAD']), from, 'hizo reset con un repo anidado en el camino');
  assert.strictEqual(fs.readFileSync(path.join(nested, 'SKILL.md'), 'utf8'), 'TRABAJO SIN COMMITEAR\n', 'pisó el trabajo sin commitear del repo anidado');
  assert.strictEqual(fs.readFileSync(path.join(L.skillsDir, 'mis notas', 'ñandú 1.md'), 'utf8'), 'mío\n');
  // espejo: el repo anidado en una carpeta que la versión nueva NO trae: avanza, y queda igual
  const aside = path.join(L.skillsDir, 'skills', 'mine-own');
  fs.renameSync(nested, aside);
  fs.renameSync(path.join(L.skillsDir, 'mis notas', 'ñandú 1.md'), path.join(L.skillsDir, 'mis notas', 'ñandú mío.md'));
  assert.deepStrictEqual(sources.untrackedInTheWay(L.skillsDir, to, L.env), []);
  const adv = sources.advance(src, { env: L.env, home: L.home });
  assert.strictEqual(adv.ok, true, adv.reason);
  assert.strictEqual(git(L.skillsDir, ['rev-parse', 'HEAD']), to);
  assert.strictEqual(fs.readFileSync(path.join(aside, 'SKILL.md'), 'utf8'), 'TRABAJO SIN COMMITEAR\n');
  assert.strictEqual(fs.readFileSync(path.join(aside, 'NOTES.md'), 'utf8'), 'notas mías\n');
  assert.strictEqual(git(aside, ['status', '--porcelain']).replace(/\s+/g, ' '), 'M SKILL.md ?? NOTES.md', 'el repo anidado cambió');
  assert.strictEqual(fs.readFileSync(path.join(L.skillsDir, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'la del arnés\n');
  assert.strictEqual(fs.readFileSync(path.join(L.skillsDir, 'mis notas', 'ñandú 1.md'), 'utf8'), 'la del arnés\n');
  assert.strictEqual(fs.readFileSync(path.join(L.skillsDir, 'mis notas', 'ñandú mío.md'), 'utf8'), 'mío\n');
});

// ─── T13·módulo · la política (channel.js) ─────────────────────────────────────────────────────────────────────────

test('T13·módulo · channel.read: sin nada stable/ask (origen default) y prendido; variables; TYCON_UPDATE=0 apaga; valor fuera del vocabulario es error, no «apagado»', () => {
  const channel = mod('channel');
  const home = casa('t13-read');
  const tree = path.join(home, 'tree');
  fs.mkdirSync(tree);
  let r = channel.read(home, labEnv(home), { tree });
  assert.deepStrictEqual([r.channel, r.apply, r.enabled], ['stable', 'ask', true], JSON.stringify(r));
  assert.deepStrictEqual([r.origins.channel, r.origins.apply], ['default', 'default']);
  assert.deepStrictEqual(r.errors, []);

  r = channel.read(home, labEnv(home, { TYCON_UPDATE_CHANNEL: 'latest', TYCON_UPDATE_APPLY: 'auto' }), { tree });
  assert.deepStrictEqual([r.channel, r.apply, r.enabled], ['latest', 'auto', true], JSON.stringify(r));
  assert.deepStrictEqual([r.origins.channel, r.origins.apply], ['env', 'env']);

  r = channel.read(home, labEnv(home, { TYCON_UPDATE: '0' }), { tree });
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.channel, 'stable');

  r = channel.read(home, labEnv(home, { TYCON_UPDATE_CHANNEL: 'nightly' }), { tree });
  assert.ok(r.errors.length >= 1, 'un valor fuera del vocabulario tiene que ser error');
  assert.match(r.errors.join('\n'), /nightly/);
  assert.match(r.errors.join('\n'), /latest|stable/);
});

test('T13·módulo · channel.set escribe sólo update.channel en ~/.claude/tycon.json y preserva el resto; read lo ve; un valor inválido o un archivo roto no se escriben', () => {
  const channel = mod('channel');
  const home = casa('t13-set');
  const tree = path.join(home, 'tree');
  fs.mkdirSync(tree);
  const file = path.join(home, '.claude', 'tycon.json');
  fs.writeFileSync(file, '{\n  "__comment": "de juguete",\n  "integrations": { "engram": true }\n}\n');
  const w = channel.set(home, 'latest');
  assert.strictEqual(w.ok, true, w.reason);
  assert.strictEqual(w.file, file);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(j.integrations.engram, true, 'pisó el resto del archivo');
  assert.strictEqual(j.__comment, 'de juguete');
  assert.deepStrictEqual(j.update, { channel: 'latest' });
  const r = channel.read(home, labEnv(home), { tree });
  assert.strictEqual(r.channel, 'latest');
  assert.notStrictEqual(r.origins.channel, 'default');
  assert.strictEqual(r.apply, 'ask');

  const bad = channel.set(home, 'nightly');
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /nightly/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).update, { channel: 'latest' });

  // sin archivo: lo crea con sólo update.channel
  fs.rmSync(file);
  assert.strictEqual(channel.set(home, 'stable').ok, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { update: { channel: 'stable' } });

  // roto: no se escribe y se dice
  fs.writeFileSync(file, '{ roto');
  const broken = channel.set(home, 'latest');
  assert.strictEqual(broken.ok, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ roto');
});

// ─── T12 · Harness_Version_DerivedAndStamped_Hold ──────────────────────────────────────────────────────────────────

test('T12 · versionLine sin version.json: YYYY.MM.DD+sha7 · agent-skills sha7 · <mode> · <channel> · <sources>, con la fecha UTC del commit de HEAD', () => {
  const report = mod('report');
  const sources = mod('sources');
  const state = mod('state');
  // el commit es del 4 de marzo a las 23:30 en UTC-3: en UTC ya es 5 de marzo — la fecha es la UTC, no la local
  const L = lab('t12-line', { commitEnv: { GIT_COMMITTER_DATE: '2025-03-04T23:30:00-03:00', GIT_AUTHOR_DATE: '2025-03-04T23:30:00-03:00' } });
  const list = sources.detect({ tree: L.tree, home: L.home, env: L.env });
  const s = state.defaults({ tree: L.tree, sources: list, mode: 'managed' });
  const line = report.versionLine(s, { env: L.env });
  const [h, a] = list;
  assert.ok(line.startsWith(`2025.03.05+${sha7(h.commit)} · agent-skills ${sha7(a.commit)} · managed · stable · `), line);
  assert.match(line, /harness@main/);
  assert.match(line, /agent_skills@main/);
  assert.doesNotMatch(line, /desarrollador/);
  // sin git a mano (un árbol que no es clon): no tira, usa lo que el estado sabe
  const s2 = Object.assign({}, s, { tree: L.home, sources: [Object.assign({}, h, { dir: L.home })] });
  assert.ok(report.versionLine(s2, { env: L.env }).includes(sha7(h.commit)));
});

test('T12 · versionLine con version.json imprime la estampada y sus shas; versionJson da los campos del estado más hold; developer avisa', () => {
  const report = mod('report');
  const sources = mod('sources');
  const state = mod('state');
  const L = lab('t12-stamped');
  const list = sources.detect({ tree: L.tree, home: L.home, env: L.env });
  const s = state.defaults({ tree: L.tree, sources: list, mode: 'managed' });
  s.channel = 'latest';

  const j = report.versionJson(s, { env: L.env });
  for (const k of Object.keys(s)) assert.ok(Object.prototype.hasOwnProperty.call(j, k), `--json sin «${k}»`);
  assert.strictEqual(j.hold, null);
  assert.match(j.version.number, /^\d{4}\.\d{2}\.\d{2}\+[0-9a-f]{7}$/);
  assert.strictEqual(j.version.stamped, false);
  s.hold = { commit: 'c'.repeat(40), at: '2026-10-02T00:00:00.000Z', reason: 'rollback' };
  assert.deepStrictEqual(report.versionJson(s, { env: L.env }).hold, s.hold);
  // la retención la dice también `version`, con el comando para levantarla
  const held = report.versionLine(s, { env: L.env });
  assert.ok(held.includes('retención') && held.includes('rollback --release'), `version sin la retención: ${held}`);
  s.hold = null;
  assert.ok(!report.versionLine(s, { env: L.env }).includes('retención'));

  // la forma del contrato: sin `channel` — el mismo archivo llega a `main` (estable) con el merge
  const stamped = { version: '2026.10.02.1', source: { harness: 'a'.repeat(40), agent_skills: 'b'.repeat(40) } };
  fs.writeFileSync(path.join(L.tree, 'version.json'), `${JSON.stringify(stamped)}\n`);
  const line = report.versionLine(s, { env: L.env });
  assert.ok(line.startsWith('2026.10.02.1 '), line);
  assert.ok(line.includes('a'.repeat(7)) && line.includes('b'.repeat(7)), `sin los shas fuente: ${line}`);
  assert.match(line, / · managed · latest · /);
  const j2 = report.versionJson(s, { env: L.env });
  assert.strictEqual(j2.version.number, '2026.10.02.1');
  assert.strictEqual(j2.version.stamped, true);
  assert.deepStrictEqual(j2.version.source, stamped.source);

  s.mode = 'developer';
  const dev = report.versionLine(s, { env: L.env });
  assert.match(dev, /desarrollador/);
  assert.ok(dev.includes(L.tree), `no nombra el clon: ${dev}`);
  assert.match(dev, / · developer · /);
});

test('T12 · report: log va a startup.log con fecha y rota al pasar 1 MB; setNotice/clearNotice; doctorText/doctorJson; installSummary', () => {
  const report = mod('report');
  const state = mod('state');
  const home = casa('t12-report');
  const p = state.paths(home);
  report.log(home, 'primera línea');
  assert.ok(fs.existsSync(p.log), 'log no creó startup.log');
  assert.match(fs.readFileSync(p.log, 'utf8'), /^\d{4}-\d{2}-\d{2}T[^ ]+ primera línea\n$/);
  fs.appendFileSync(p.log, 'x'.repeat(1024 * 1024 + 1));
  report.log(home, 'tras el tope');
  assert.ok(fs.existsSync(`${p.log}.1`), 'no rotó');
  assert.ok(fs.statSync(p.log).size < 1024, 'el log nuevo no arrancó de cero');
  assert.match(fs.readFileSync(p.log, 'utf8'), /tras el tope/);

  const s = state.defaults({ tree: home, sources: [], mode: 'managed' });
  assert.strictEqual(report.setNotice(s, 'hay versión nueva'), s);
  assert.strictEqual(s.notice, 'hay versión nueva');
  report.clearNotice(s);
  assert.strictEqual(s.notice, null);

  const rep = { mode: 'managed', items: [{ level: 'fail', text: 'estado ilegible' }, { level: 'warn', text: 'máquina del equipo en ask' }, { level: 'ok', text: 'enlace' }] };
  const text = report.doctorText(rep);
  const lines = text.split('\n');
  assert.match(lines[0], /managed/);
  assert.ok(text.includes('estado ilegible') && text.includes('máquina del equipo en ask') && text.includes('enlace'));
  assert.deepStrictEqual(report.doctorJson(rep), { mode: 'managed', fail: ['estado ilegible'], warn: ['máquina del equipo en ask'], ok: ['enlace'] });

  // el cierre cuenta lo que QUEDÓ (las piezas del reporte del aplicador), no los pasos del programa
  const hook = (id) => ({ kind: 'hook', where: '/h/.claude/settings.json', id });
  const effects = { ok: true, effects: [
    { id: 'PreToolUse:@tcg:safety-guard-pre.sh', kind: 'hook', blocks: 'any-repo' },
    { id: 'Stop:@tcg:blocking-meter.js', kind: 'hook', blocks: 'no' },
  ] };
  const pieces = [hook('PreToolUse:@tcg:safety-guard-pre.sh'), hook('Stop:@tcg:blocking-meter.js'), { kind: 'block', where: '/h/.claude/CLAUDE.md', id: 'TYCON_BLOCK:response-style' },
    { kind: 'third-party', where: '/h/x', id: 'una-skill' }];
  const summary = report.installSummary({
    version: '2026.10.02+abcdef0 · agent-skills 1234567 · managed · stable · harness@main', channel: 'stable', apply: 'ask', changed: true,
    pieces, effects, thirdParty: 3, warnings: ['⚠ un aviso del aplicador'], backup: '/h/backups/20261002-000000', log: '/h/startup.log',
  });
  assert.ok(Array.isArray(summary) && summary.length >= 2, 'installSummary devuelve líneas');
  const closing = summary.join('\n');
  assert.ok(closing.includes('abcdef0'), 'la versión');
  assert.ok(!/piezas escritas/.test(closing), 'ya no lista los pasos del programa');
  const order = ['versión: ', 'qué quedó:', '  hooks: 2 (1 puede frenar un comando)', '  bloques en CLAUDE.md: 1', '  skills de terceros: 1 en su lugar, 2 pendientes',
    '⚠ un aviso del aplicador', 'copia de respaldo: /h/backups/20261002-000000 · volver: ', 'registro: /h/startup.log', 'qué sigue:'].map((s) => closing.indexOf(s));
  assert.ok(order.every((i) => i >= 0) && order.every((i, n) => n === 0 || i > order[n - 1]), `el cierre no trae sus partes en orden (${order.join(', ')}):\n${closing}`);
  assert.strictEqual(summary.slice(summary.indexOf('qué sigue:') + 1).length, 3, '«qué sigue» son tres líneas, las últimas');
  // con la lista de efectos rota no se cuenta ningún freno, y se dice por qué
  const blind = report.installSummary({ version: 'x', changed: true, pieces, effects: { ok: false, reason: 'install-effects.json es ilegible' } }).join('\n');
  assert.ok(/hooks: 2 \(no pude contar cuántos frenan: install-effects\.json es ilegible\)/.test(blind) && !/pueden? frenar/.test(blind), blind);
  const same = report.installSummary({ version: 'x', channel: 'stable', apply: 'ask', changed: false, baseline: '/h/backups/primera' });
  assert.match(same.join('\n'), /sin cambios/);
  assert.match(same.join('\n'), /copia de antes de instalar: \/h\/backups\/primera/);
  assert.ok(!/qué sigue/.test(same.join('\n')), 'una segunda ejecución no repite «qué sigue»');
  // a medias
  const failed = report.installFailure({ what: 'el aplicador salió 1', log: '/h/startup.log', backup: '/h/backups/b' }).join('\n');
  for (const s of ['el aplicador salió 1', 'quedó a medias', 'doctor', 'registro: /h/startup.log', 'copia de respaldo: /h/backups/b', 'install otra vez', 'uninstall']) assert.ok(failed.includes(s), `installFailure no dice «${s}»:\n${failed}`);
  assert.ok(!/qué sigue/.test(failed), 'a medias no hay «qué sigue»');
  // los avisos que el aplicador alcanzó a dar antes de fallar también salen, tal cual, debajo de lo que falló
  const failedWithWarnings = report.installFailure({ what: 'el aplicador salió 1', log: '/h/startup.log', backup: '/h/backups/b', warnings: ['⚠ un aviso antes de fallar', '    con su renglón de abajo'] });
  assert.deepStrictEqual(failedWithWarnings.slice(0, 3), ['harness.js install: el aplicador salió 1', '⚠ un aviso antes de fallar', '    con su renglón de abajo'], failedWithWarnings.join('\n'));
  // sin copia de respaldo (no se pudo tomar): se dice, y nunca se promete una carpeta ni un `rollback` sobre ella
  for (const [what, lines] of [
    ['installSummary', report.installSummary({ version: 'x', changed: true, pieces, effects, backup: null, log: '/h/startup.log' })],
    ['installFailure', report.installFailure({ what: 'el aplicador salió 1', log: '/h/startup.log', backup: null })],
  ]) {
    const copies = lines.filter((l) => l.startsWith('copia de respaldo:'));
    assert.deepStrictEqual(copies.length, 1, `${what}: una línea de la copia, también cuando no se pudo tomar`);
    assert.ok(/no se pudo tomar/.test(copies[0]) && /sin copia/.test(copies[0]) && !/rollback/.test(copies[0]) && !/null|undefined/.test(copies[0]), `${what} sin copia: ${copies[0]}`);
    // …y no promete ningún `.bak`: los que quedan no traen lo de antes de instalar
    assert.ok(!/\.bak/.test(copies[0]), `${what} sin copia promete un .bak que no trae lo de antes: ${copies[0]}`);
  }
  // las skills de terceros con el paso apagado: ni «en su lugar» ni «pendientes» (el aplicador no reporta ninguna)
  const off = report.leftCounts([hook('Stop:@tcg:blocking-meter.js')], { effects, thirdParty: 'off' }).join('\n');
  assert.ok(/skills de terceros: el paso está apagado \(TYCON_THIRD_PARTY=0\)/.test(off) && !/pendiente|en su lugar/.test(off), off);
  // los avisos: el renglón marcado y los renglones sangrados que lo siguen («Activalo con:» sin el comando no es un aviso)
  const multi = ['registrando hooks', '⚠ git no tiene core.hooksPath global. Activalo con:', '    git config --global core.hooksPath /h/.git-hooks', 'listo',
    '🔴 2 control(es) NO quedaron instalados:', '  ! uno.js', '   y volvé a abrir la sesión.', '', '  suelto y sangrado, sin aviso arriba'].join('\n');
  assert.deepStrictEqual(report.warningLines(multi), ['⚠ git no tiene core.hooksPath global. Activalo con:', '    git config --global core.hooksPath /h/.git-hooks',
    '🔴 2 control(es) NO quedaron instalados:', '  ! uno.js', '   y volvé a abrir la sesión.'], 'un aviso de varios renglones sale entero, y nada más');
  // el instalador de Windows escribe sus avisos con «! » y «!! »: sólo en Windows cuentan como aviso
  const win = ['! tycon: la configuracion del arnes esta ROTA:', '   detalle', 'Hooks registrados: 28', '!! no pude saber si esta maquina usa Codex', '!nota sin espacio'].join('\r\n');
  assert.deepStrictEqual(report.warningLines(win, { windows: true }), ['! tycon: la configuracion del arnes esta ROTA:', '   detalle', '!! no pude saber si esta maquina usa Codex']);
  assert.deepStrictEqual(report.warningLines(win), [], 'fuera de Windows «! » no es una marca de aviso');
  // un reporte válido y VACÍO no deja «qué quedó» mudo: se dice que el aplicador no reportó ninguna pieza
  const empty = report.installSummary({ version: 'x', changed: true, pieces: [], reported: true, effects }).join('\n');
  assert.ok(/qué quedó:\n {2}el aplicador no reportó ninguna pieza/.test(empty), empty);
  // un aplicador que no entregó su reporte: lo contado es sólo lo del programa, y se dice
  const unreported = report.installSummary({ version: 'x', changed: true, pieces: [{ kind: 'setting', where: '/h/s.json', id: 'cleanupPeriodDays' }], reported: false, effects }).join('\n');
  assert.ok(/qué quedó:\n {2}ajustes de settings\.json: 1\n {2}el aplicador no entregó su reporte de piezas/.test(unreported), unreported);
  assert.ok(!/no entregó su reporte/.test(closing), 'con reporte no se dice que falta');
  // el instalador apagado a propósito no es «un reporte que falta»: se dice lo que pasó
  const offApplier = report.installSummary({ version: 'x', changed: true, pieces: [], reported: false, applierOff: true, effects, thirdParty: null }).join('\n');
  assert.ok(/el instalador está apagado \(TYCON_NO_AUTOINSTALL=1\)/.test(offApplier) && !/no entregó su reporte|pendiente/.test(offApplier), offApplier);
  assert.deepStrictEqual(report.warningLines('uno\n⚠ dos\n  🔴 tres\n⚠ dos\n🛑 cuatro\ncinco ⚠'), ['⚠ dos', '  🔴 tres', '🛑 cuatro'], 'los avisos: las líneas que EMPIEZAN con la marca, sin repetir');
});

// ─── Regresiones ───────────────────────────────────
// Cada caso fija un defecto confirmado.

test('REG-D1 · un clon en una rama de trabajo NO es una ref que se reescribe: ref main, rewrites false, update no lo toca y lo dice', () => {
  const sources = mod('sources');
  const L = lab('reg-d1');
  // la rama de trabajo existe en origin, el dev tiene un commit propio sin pushear y alguien empuja a esa rama
  git(L.harness.author, ['checkout', '-q', '-b', 'feat/mine']);
  fs.writeFileSync(path.join(L.harness.author, 'FEAT.md'), 'v1\n'); git(L.harness.author, ['add', '-A']); git(L.harness.author, ['commit', '-q', '-m', 'feat']);
  git(L.harness.author, ['push', '-q', 'origin', 'feat/mine']);
  git(L.tree, ['fetch', '-q', 'origin']); git(L.tree, ['checkout', '-q', '-b', 'feat/mine', 'origin/feat/mine']);
  fs.writeFileSync(path.join(L.tree, 'MIO.md'), 'propio\n'); git(L.tree, ['add', '-A']); git(L.tree, ['commit', '-q', '-m', 'propio sin pushear']);
  fs.writeFileSync(path.join(L.harness.author, 'FEAT.md'), 'v2\n'); git(L.harness.author, ['commit', '-q', '-am', 'feat v2']); git(L.harness.author, ['push', '-q', 'origin', 'feat/mine']);
  const [h] = sources.detect({ tree: L.tree, home: L.home, env: L.env });
  assert.strictEqual(h.ref, 'main', JSON.stringify(h));
  assert.strictEqual(h.rewrites, false, JSON.stringify(h));
  const before = git(L.tree, ['rev-parse', 'HEAD']);
  sources.fetch(h, { env: L.env });
  const p = sources.plan(h, { env: L.env, home: L.home });
  assert.strictEqual(p.ok, false, 'en otra rama no se avanza');
  assert.match(p.reason, /rama feat\/mine/);
  const a = sources.advance(h, { env: L.env, home: L.home });
  assert.strictEqual(a.ok, false);
  assert.strictEqual(git(L.tree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/mine', 'el clon sigue en su rama');
  assert.strictEqual(git(L.tree, ['rev-parse', 'HEAD']), before);
  assert.ok(fs.existsSync(path.join(L.tree, 'MIO.md')), 'lo propio sigue en el árbol');
});

test('REG-D2 · revert de una fuente que ya reaplicó lo local NO borra los cambios sin commitear del dev', () => {
  const sources = mod('sources');
  const L = lab('reg-d2');
  fs.appendFileSync(path.join(L.tree, 'README.md'), 'cambio local sin commitear\n');
  L.harness.publish('VERSION', '2');
  const [h] = sources.detect({ tree: L.tree, home: L.home, env: L.env });
  sources.fetch(h, { env: L.env });
  const a = sources.advance(h, { env: L.env, home: L.home });
  assert.strictEqual(a.ok, true, a.reason);
  assert.match(fs.readFileSync(path.join(L.tree, 'README.md'), 'utf8'), /cambio local/);
  const r = sources.revert(h, a.from, { env: L.env });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(git(L.tree, ['rev-parse', 'HEAD']), a.from, 'volvió a previous');
  const inTree = /cambio local/.test(fs.readFileSync(path.join(L.tree, 'README.md'), 'utf8'));
  const inStash = /tycon-harness/.test(git(L.tree, ['stash', 'list']));
  assert.ok(inTree || inStash, 'lo local tiene que quedar en el árbol o en un stash propio');
  if (!inTree) assert.match(r.reason || r.note || '', /stash/, 'si quedó en el stash, el resultado lo dice');
});

test('REG-D3 · un ~/.claude/tycon.json ilegible es un error de la política, no «sin valor»: no cae al perfil', () => {
  const channel = mod('channel');
  const home = casa('reg-d3');
  fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), '{ roto');
  const arnes = fs.mkdtempSync(path.join(BASE, 'reg-d3-arnes-'));
  fs.writeFileSync(path.join(arnes, 'perfil-equipo.json'), JSON.stringify({ update: { channel: 'latest', apply: 'auto' } }));
  const env = labEnv(home); delete env.TYCON_PROFILE;
  const p = channel.read(home, env, { tree: arnes });
  assert.ok(p.errors.length > 0, `el archivo roto tiene que ser un error: ${JSON.stringify(p)}`);
  assert.match(p.errors.join(' '), /tycon\.json/);
});

test('REG-D9 · isClean conserva el nombre entero del PRIMER archivo modificado (porcelain sin recortar)', () => {
  const sources = mod('sources');
  const L = lab('reg-d9');
  fs.appendFileSync(path.join(L.tree, 'README.md'), 'x\n');
  const c = sources.isClean(L.tree, { env: L.env });
  assert.strictEqual(c.clean, false);
  assert.deepStrictEqual(c.files, ['README.md']);
  // y una exclusión declarada sobre ese mismo primer archivo lo deja limpio
  const c2 = sources.isClean(L.tree, { env: L.env, excluded: ['README.md'] });
  assert.strictEqual(c2.clean, true, JSON.stringify(c2));
});

test('REG-W6 · channel.set avisa si la copia del freno de producción no conoce la sección update', () => {
  const channel = mod('channel');
  const home = casa('reg-w6');
  const oldLib = path.join(BASE, 'reg-w6-opt-tycon-config.js');
  fs.writeFileSync(oldLib, "const VOCABULARIO = { rutas: {}, ado: {}, telegram: {}, integraciones: {} };\n");
  const r = channel.set(home, 'latest', { guardLib: oldLib });
  assert.strictEqual(r.ok, true, r.reason);
  assert.match(r.warning || '', /freno|install-guard/, JSON.stringify(r));
  const newLib = path.join(BASE, 'reg-w6-opt-new.js');
  fs.writeFileSync(newLib, "const VOCABULARIO = { update: { channel: 'opcion:latest|stable' } };\n");
  const r2 = channel.set(home, 'stable', { guardLib: newLib });
  assert.ok(!r2.warning, 'con la copia al día no hay aviso');
});

test('T19·módulo · Doctor_ManagedVsMachine: el registro es la unión de los reportes, conserva la versión que puso cada pieza y suelta sólo lo que el aplicador sacó', () => {
  const M = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'managed.js'));
  const home = fs.mkdtempSync(path.join(BASE, 't19-'));
  const settings = path.join(home, 'settings.json');
  const hookA = { kind: 'hook', where: settings, id: 'SessionStart:@tcg:a-hook.js' };
  const hookB = { kind: 'hook', where: settings, id: 'PreToolUse:tycon-pipeline/scripts/b-hook.js' };
  const write = (cmds) => fs.writeFileSync(settings, JSON.stringify({ hooks: Object.fromEntries(cmds.map(([ev, c]) => [ev, [{ hooks: [{ type: 'command', command: c }] }]])) }));
  write([['SessionStart', 'node "/Users/Lab-user/tree/scripts/hooks/a-hook.js"'], ['PreToolUse', 'node "/Users/Lab-user/.claude/agent-skills/skills/tycon-pipeline/scripts/b-hook.js"']]);
  const present = (p) => M.present(p, { home, env: { TYCON_SETTINGS_PATH: settings } });
  assert.strictEqual(present(hookA), true);
  assert.strictEqual(present(Object.assign({}, hookA, { id: 'PreToolUse:@tcg:a-hook.js' })), false, 'el evento cuenta');
  let managed = M.merge([], [hookA], { version: 'v1', present });
  managed = M.merge(managed, [hookA, hookB], { version: 'v2', present });
  assert.deepStrictEqual(managed.map((p) => [p.id, p.version]), [[hookA.id, 'v1'], [hookB.id, 'v2']], 'cada pieza con la versión que la puso');
  // el reporte siguiente no trae B, pero B sigue en la máquina: se queda (unión)
  managed = M.merge(managed, [hookA], { version: 'v3', present });
  assert.ok(managed.some((p) => p.id === hookB.id && p.version === 'v2'), 'una pieza presente no se cae por faltar en un reporte');
  // el aplicador sacó B (ya no está en settings.json): se cae del registro
  write([['SessionStart', 'node "/Users/Lab-user/tree/scripts/hooks/a-hook.js"']]);
  managed = M.merge(managed, [hookA], { version: 'v4', present });
  assert.deepStrictEqual(managed.map((p) => p.id), [hookA.id], 'lo que el aplicador sacó se cae');
  // sin reporte (present: null) no se cae nada
  assert.strictEqual(M.merge([hookB], [], { version: 'v5', present: null }).length, 1);
  // reportes inválidos: no se funden
  assert.strictEqual(M.parseReport('{ roto').ok, false);
  assert.strictEqual(M.parseReport('[{"kind":"nada","where":"x","id":"y"}]').ok, false);
  assert.deepStrictEqual(M.parseReport(JSON.stringify([hookA, hookA])).pieces, [hookA], 'sin duplicados');
});

test('T19·módulo · iteración 2 del pase adversarial: sin registrar = sólo lo que el aplicador conoce (también con barras de Windows); un ajuste con otro valor ya no es del arnés', () => {
  const M = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'managed.js'));
  const home = fs.mkdtempSync(path.join(BASE, 't19b-'));
  const tree = path.join(home, 'tree');
  fs.mkdirSync(path.join(tree, 'scripts'), { recursive: true });
  // el aplicador de este árbol conoce un hook del arnés y uno de agent-skills (la forma de su lista canónica)
  fs.writeFileSync(path.join(tree, 'scripts', 'install-tycon-hooks.sh'),
    'HOOKS_CANONICAL=(\n  "SessionStart||@tcg:known-hook.js|aviso de juguete"\n  "PreToolUse|Edit|Write|tycon-pipeline/scripts/known-pre.js|portón de juguete"\n)\n');
  const settings = path.join(home, 'settings.json');
  const cmds = [
    ['SessionStart', `node "${tree}/scripts/hooks/known-hook.js"`],
    ['SessionStart', `bash "${tree}/scripts/hooks/codegraph-like-hook.sh"`],   // lo registra otro instalador opt-in
    ['PreToolUse', 'node "C:/Users/Lab-user/.claude/agent-skills/skills/tycon-pipeline/scripts/known-pre.js"'],   // Windows
  ];
  fs.writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 30, hooks: { SessionStart: [{ hooks: cmds.slice(0, 2).map(([, c]) => ({ type: 'command', command: c })) }], PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: cmds[2][1] }] }] } }));
  const env = { TYCON_SETTINGS_PATH: settings, CLAUDE_MD_PATH: path.join(home, 'CLAUDE.md') };
  const loose = M.unregistered([], { home, env, tree, roots: [tree, 'C:\\Users\\Lab-user\\.claude\\tycon-claude-guides'] });
  const ids = loose.map((u) => u.id).sort();
  assert.deepStrictEqual(ids, ['PreToolUse:tycon-pipeline/scripts/known-pre.js', 'SessionStart:@tcg:known-hook.js'],
    `sólo los hooks que el aplicador conoce, también con barras normales de Windows (salió: ${JSON.stringify(ids)})`);
  // registrados, ya no salen
  const managed = [{ kind: 'hook', where: settings, id: 'SessionStart:@tcg:known-hook.js' }, { kind: 'hook', where: settings, id: 'PreToolUse:tycon-pipeline/scripts/known-pre.js' }];
  assert.deepStrictEqual(M.unregistered(managed, { home, env, tree, roots: [tree] }), []);
  // un ajuste del arnés con su valor: presente sólo si sigue valiendo lo del arnés (el dev lo cambió a 30)
  assert.strictEqual(M.present({ kind: 'setting', where: settings, id: 'cleanupPeriodDays', value: 365 }, { home, env }), false);
  assert.strictEqual(M.present({ kind: 'setting', where: settings, id: 'cleanupPeriodDays', value: 30 }, { home, env }), true);
  assert.strictEqual(M.present({ kind: 'setting', where: settings, id: 'cleanupPeriodDays' }, { home, env }), true, 'sin valor declarado, alcanza la clave');
  assert.strictEqual(M.parseReport(JSON.stringify([{ kind: 'setting', where: settings, id: 'cleanupPeriodDays', value: 365 }])).pieces[0].value, 365, 'el reporte conserva el valor');
  // …y el registro guardado también (merge tiene que armar la pieza con `value`, o el estado lo pierde)
  const setting = { kind: 'setting', where: settings, id: 'cleanupPeriodDays', value: 365 };
  const kept = M.merge([], [setting], { version: 'v1' });
  assert.strictEqual(kept[0].value, 365, 'merge conserva el valor de un ajuste nuevo');
  const again = M.merge(kept, [Object.assign({}, setting, { value: 366 })], { version: 'v2' });
  assert.deepStrictEqual([again[0].value, again[0].version], [366, 'v1'], 'el valor sale del último reporte; la versión, de la primera');
  // un bloque que perdió su marcador de cierre no está en su lugar (el sync lo deja afuera del reporte y no lo toca)
  const md = path.join(home, 'CLAUDE.md');
  const block = { kind: 'block', where: md, id: 'TYCON_BLOCK:lab-block' };
  fs.writeFileSync(md, '<!-- TYCON_BLOCK:lab-block START -->\nregla\n<!-- TYCON_BLOCK:lab-block END -->\n');
  assert.strictEqual(M.present(block, { home, env }), true);
  fs.writeFileSync(md, '<!-- TYCON_BLOCK:lab-block START -->\nregla sin cierre\n');
  assert.strictEqual(M.present(block, { home, env }), false, 'sin el marcador de cierre el bloque no está en su lugar');
});

// ─── el orden de las versiones, el remoto público y la ref de cada canal, a nivel módulo ───────

// 🔴 Sin `scripts/setup/harness/version-order.js` el caso muere en el `require` (MODULE_NOT_FOUND).
test('T31·módulo · version-order: compara por partes numéricas (.10 > .9); la interna +sha7, lo vacío y lo sin forma no se ordenan', () => {
  const VO = mod('version-order');
  assert.deepStrictEqual(VO.parse('2026.09.30.10'), [2026, 9, 30, 10]);
  assert.strictEqual(VO.compare('2026.09.30.10', '2026.09.30.9'), 1, 'como texto «10» < «9»: tiene que ser por número');
  assert.strictEqual(VO.compare('2026.09.30.9', '2026.09.30.10'), -1);
  assert.strictEqual(VO.compare('2026.09.30.2', '2026.09.30.2'), 0);
  assert.strictEqual(VO.compare('2026.10.01.1', '2026.09.30.99'), 1, 'la fecha manda sobre el número del día');
  assert.strictEqual(VO.compare('2027.01.01.1', '2026.12.31.7'), 1);
  // espejo: lo que NO se ordena devuelve null (nunca 0: «no sé» no es «igual»)
  for (const bad of ['2026.09.30+abc1234', '', null, undefined, '2026.09.30', '2026.9.30.x', 'v1', '2026.09.30.1.5', ' 2026.09.30.1', 20260930]) {
    assert.strictEqual(VO.parse(bad), null, `«${bad}» no tiene forma de número publicado`);
    assert.strictEqual(VO.compare(bad, '2026.09.30.1'), null, `«${bad}» no se ordena`);
    assert.strictEqual(VO.compare('2026.09.30.1', bad), null, `contra «${bad}» no se ordena`);
  }
  assert.strictEqual(VO.isOrdered('2026.09.30.1'), true);
  assert.strictEqual(VO.isOrdered('2026.09.30+abc1234'), false);
  // la forma es la MISMA que estampa la publicación (`VERSION_SHAPE` de scripts/publishing/export.js, copiada: este
  // módulo corre desde la copia fija y no puede requerir nada de afuera de su carpeta): mes 01-12, día 01-31, N desde 1
  // sin ceros adelante. 🔴 Con una expresión más laxa (`\d{2}` y `\d+`) estos cuatro se ordenarían.
  for (const bad of ['2026.13.01.1', '2026.10.00.1', '2026.10.03.0', '2026.10.03.01', '2026.00.10.1', '2026.10.32.1']) {
    assert.strictEqual(VO.parse(bad), null, `«${bad}» no es un número que la publicación estampe`);
  }
  const exportJs = fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'export.js'), 'utf8');
  const shape = /const VERSION_SHAPE = (\/.+\/);/.exec(exportJs);
  assert.ok(shape, 'export.js ya no declara VERSION_SHAPE como una expresión en una línea');
  assert.strictEqual(String(VO.PUBLISHED), shape[1], 'version-order.js y export.js tienen que aceptar la misma forma de número');
});

// 🔴 Sin esto: `sources.remoteIdentity` no existe (TypeError: … is not a function) e `isPublicRemote` leería
//    `scripts/publishing/public-repos.json` buscando la URL como texto: con la lista del árbol contestaría siempre «no».
test('T31·módulo · el remoto público se reconoce por la lista del árbol (scripts/setup/public-remotes.json), por identidad: host + ruta, con o sin .git, https o ssh', () => {
  const sources = mod('sources');
  const tree = path.join(BASE, 't31-public-tree');
  fs.mkdirSync(path.join(tree, 'scripts', 'setup'), { recursive: true });
  const listFile = path.join(tree, 'scripts', 'setup', 'public-remotes.json');
  const same = [
    'https://example.com/example-org/example-harness',
    'https://example.com/example-org/example-harness.git',
    'https://example.com/example-org/example-harness/',
    'https://EXAMPLE.com/Example-Org/example-harness.git',
    'git@example.com:example-org/example-harness.git',
    'ssh://git@example.com/example-org/example-harness',
    'https://someone@example.com/example-org/example-harness.git',
  ];
  const id = sources.remoteIdentity(same[0]);
  assert.strictEqual(id, 'example.com/example-org/example-harness');
  for (const u of same) assert.strictEqual(sources.remoteIdentity(u), id, `«${u}» es el mismo remoto`);
  // espejo: otro host, otra organización u otro repo NO son el mismo
  for (const u of ['https://example.org/example-org/example-harness', 'https://example.com/other-org/example-harness', 'https://example.com/example-org/example-harness-fork', 'git@example.com:example-org/other.git']) {
    assert.notStrictEqual(sources.remoteIdentity(u), id, `«${u}» es otro remoto`);
  }
  assert.strictEqual(sources.remoteIdentity(''), null);
  assert.strictEqual(sources.remoteIdentity(null), null);
  // una carpeta local (el laboratorio): con o sin `.git`, con o sin barra final
  const bare = path.join(BASE, 't31-public-remote', 'harness.git');
  fs.mkdirSync(bare, { recursive: true });
  assert.strictEqual(sources.remoteIdentity(bare), sources.remoteIdentity(`${bare}/`));
  assert.strictEqual(sources.remoteIdentity(`file://${bare}`), sources.remoteIdentity(bare));
  assert.notStrictEqual(sources.remoteIdentity(bare), sources.remoteIdentity(path.join(BASE, 't31-public-remote', 'other.git')));

  // sin el archivo (un clon interno): nunca es público, y la lista es null («no hay lista», distinto de «lista vacía»)
  assert.strictEqual(sources.publicRemotes(tree), null);
  assert.strictEqual(sources.isPublicRemote(tree, same[0]), false);
  // con la lista: cualquiera de las formas del mismo remoto es pública; otro remoto, no
  fs.writeFileSync(listFile, `${JSON.stringify({ remotes: [same[0], bare] })}\n`);
  assert.deepStrictEqual(sources.publicRemotes(tree), [same[0], bare]);
  for (const u of same) assert.strictEqual(sources.isPublicRemote(tree, u), true, `«${u}» está en la lista`);
  assert.strictEqual(sources.isPublicRemote(tree, `${bare}/`), true);
  assert.strictEqual(sources.isPublicRemote(tree, 'https://example.com/example-org/example-harness-fork'), false, 'un fork no es el público');
  assert.strictEqual(sources.isPublicRemote(tree, ''), false);
  assert.strictEqual(sources.isPublicRemote(tree, null), false);
  // un archivo roto o con otra forma: no es público (y no tira)
  fs.writeFileSync(listFile, '{ roto');
  assert.strictEqual(sources.isPublicRemote(tree, same[0]), false);
  assert.strictEqual(sources.publicRemotes(tree), null);
  fs.writeFileSync(listFile, JSON.stringify({ remotes: 'https://example.com/example-org/example-harness' }));
  assert.strictEqual(sources.isPublicRemote(tree, same[0]), false);
  // la página de la comparación sale de la URL fijada, nunca de una constante
  assert.strictEqual(sources.webBase('git@example.com:example-org/example-harness.git'), 'https://example.com/example-org/example-harness');
  assert.strictEqual(sources.webBase('https://example.com/example-org/example-harness.git'), 'https://example.com/example-org/example-harness');
  assert.strictEqual(sources.webBase(`${bare}/`), bare);
});

// 🔴 Sin esto: `sources.channelRef` no existe (TypeError); la ref sería siempre `main`.
test('T31·módulo · la ref sale del canal sólo en una fuente que se reescribe: latest → mirror/sync, stable → main; con remoto no público, main siempre', () => {
  const sources = mod('sources');
  assert.strictEqual(sources.channelRef({ rewrites: true }, 'latest'), 'mirror/sync');
  assert.strictEqual(sources.channelRef({ rewrites: true }, 'stable'), 'main');
  assert.strictEqual(sources.channelRef({ rewrites: false }, 'latest'), 'main');
  assert.strictEqual(sources.channelRef({ rewrites: false }, 'stable'), 'main');
  assert.strictEqual(sources.channelRef({ rewrites: true }, undefined), 'main', 'sin canal, el estable');
});

// En Windows el aplicador es el `.ps1`, que no usa Python. Sin máquina Windows
// se mide por módulo (la lista de requisitos por sistema) y por lectura (el `.ps1` no invoca a python).
// 🔴 Sin esto: `harness.js` no exporta `requirementsFor` (TypeError) y la lista de Windows sería
//    ['git', 'python3', 'pwsh']: `install` saldría 1 «falta python3 en el PATH» en una máquina que no lo necesita.
test('A28 · en Windows harness.js no exige python3 (el aplicador de ahí no usa Python); en Mac y Linux sí', () => {
  const H = require(HARNESS);
  assert.deepStrictEqual(H.requirementsFor('win32'), ['git', 'pwsh']);
  // espejo: donde el aplicador es el `.sh`, python3 sigue siendo requisito
  for (const p of ['darwin', 'linux']) assert.deepStrictEqual(H.requirementsFor(p), ['git', 'python3', 'bash'], p);
  // por lectura: el aplicador de Windows no llama a python en ninguna línea que no sea comentario
  const ps1 = fs.readFileSync(path.join(RAIZ, 'scripts', 'install-tycon-hooks.ps1'), 'utf8');
  const calls = ps1.split('\n').filter((l) => !/^\s*#/.test(l) && /(^|[\s&(|;])python3?(\.exe)?\s/i.test(l));
  assert.deepStrictEqual(calls, [], `install-tycon-hooks.ps1 llama a python: ${calls.join(' | ')}`);
});

// 🔴 Sin esto: `report.numberAt` no existe (TypeError); `derive` devolvería `channel` leído de `version.json`.
test('T12 · tanda D: version.json no trae `channel` y su `source` es un mapa con las claves que traiga; numberAt da el número de un commit traído', () => {
  const report = mod('report');
  const sources = mod('sources');
  const state = mod('state');
  const L = lab('t12-stamped-d');
  const list = sources.detect({ tree: L.tree, home: L.home, env: L.env });
  const s = state.defaults({ tree: L.tree, sources: list, mode: 'managed' });
  // el contrato: { version, source: { <fuente>: <sha> } }, sin channel; una sola clave también vale
  fs.writeFileSync(path.join(L.tree, 'version.json'), `${JSON.stringify({ version: '2026.10.03.2', source: { harness: 'c'.repeat(40) } })}\n`);
  const d = report.derive(s, { env: L.env });
  assert.strictEqual(d.number, '2026.10.03.2');
  assert.strictEqual(d.stamped, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(d, 'channel'), 'derive no inventa un canal: la única verdad es la política');
  const line = report.versionLine(s, { env: L.env });
  assert.ok(line.startsWith(`2026.10.03.2 · harness ${'c'.repeat(7)} · managed · `), line);
  assert.ok(!line.includes('agent-skills'), `nombra una fuente que version.json no trae: ${line}`);
  // el canal que imprime es el que le pasan (la política vigente), no el del estado
  assert.match(report.versionLine(s, { env: L.env, channel: 'latest' }), / · managed · latest · /);
  assert.match(report.versionLine(s, { env: L.env }), / · managed · stable · /);
  assert.strictEqual(report.versionJson(s, { env: L.env, channel: 'latest' }).channel, 'latest');
  // numberAt: el número estampado de un commit traído; sin version.json en ese commit, el derivado (fecha UTC + sha7)
  const head = git(L.tree, ['rev-parse', 'HEAD']);
  const derived = report.numberAt(L.tree, head, { env: L.env });
  assert.match(derived.number, new RegExp(`^\\d{4}\\.\\d{2}\\.\\d{2}\\+${sha7(head)}$`));
  assert.deepStrictEqual([derived.stamped, derived.problem], [false, null]);
  const stamped = L.harness.publish('version.json', JSON.stringify({ version: '2026.10.04.1', source: { harness: 'd'.repeat(40) } }));
  git(L.tree, ['fetch', '-q', 'origin']);
  assert.deepStrictEqual(report.numberAt(L.tree, stamped, { env: L.env }), { number: '2026.10.04.1', stamped: true, problem: null });
  assert.strictEqual(sources.versionAt(L.tree, stamped, { env: L.env }).version, '2026.10.04.1');
  assert.strictEqual(sources.versionAt(L.tree, head, { env: L.env }).status, 'absent', 'un commit sin version.json no tiene número');
  // un version.json que no se deja leer NO es «sin número»: numberAt no inventa el derivado, dice el problema
  const broken = L.harness.publish('version.json', '{ "version": roto');
  git(L.tree, ['fetch', '-q', 'origin']);
  const unreadable = report.numberAt(L.tree, broken, { env: L.env });
  assert.deepStrictEqual([unreadable.number, unreadable.stamped], [null, false]);
  assert.match(unreadable.problem, /version\.json/);
});

// `versionAt` no puede devolver `null` tanto si el commit no traía
// `version.json` (legítimo) como si no se podía leer (git falló, tope de tiempo, JSON roto); `assess` ahí decidiría «nueva»
// y `update` haría `reset --hard` a un commit cuyo número nunca leyó: «no bajar» se saltearía sin avisar.
// 🔴 Sin esto: `versionAt` devuelve un texto o `null` (el primer `deepStrictEqual` falla: `null` contra
//    `{ status: 'absent', … }`), y `assess` con el `version.json` de lo traído roto daría `new` en los dos canales.
test('T31·módulo · versionAt distingue número / ausente / problema, y assess con un número que no se pudo leer es «no sé» en los dos canales (nunca «nueva»)', () => {
  const sources = mod('sources');
  const L = lab('t31-version-at');
  const env = L.env;
  const bare = git(L.tree, ['rev-parse', 'HEAD']);                                    // sin version.json
  const v1 = L.harness.publish('version.json', JSON.stringify({ version: '2026.10.04.1', source: {} }));
  const v2 = L.harness.publish('version.json', JSON.stringify({ version: '2026.10.04.2', source: {} }));
  const broken = L.harness.publish('version.json', '{ "version": roto');
  const shapeless = L.harness.publish('version.json', JSON.stringify({ version: 'v1' }));
  const noField = L.harness.publish('version.json', JSON.stringify({ source: {} }));
  const gone = L.harness.publish('OTRO.md', 'sigue');
  git(L.harness.author, ['rm', '-q', 'version.json']);
  git(L.harness.author, ['commit', '-q', '-m', 'sin version.json otra vez']);
  git(L.harness.author, ['push', '-q', 'origin', 'main']);
  const removed = git(L.harness.author, ['rev-parse', 'HEAD']);
  git(L.tree, ['fetch', '-q', 'origin']);
  assert.ok(gone);

  // los tres casos
  assert.deepStrictEqual(sources.versionAt(L.tree, v1, { env }), { status: 'ok', version: '2026.10.04.1', reason: null });
  assert.deepStrictEqual(sources.versionAt(L.tree, bare, { env }), { status: 'absent', version: null, reason: null });
  assert.deepStrictEqual(sources.versionAt(L.tree, removed, { env }), { status: 'absent', version: null, reason: null }, 'borrado después: ausente de verdad');
  const problems = [
    ['JSON roto', broken, /JSON/],
    ['`version` sin la forma del número', shapeless, /forma/],
    ['sin el campo `version`', noField, /forma/],
    ['una rev que no está en el clon', 'f'.repeat(40), /no está en el clon/],
  ];
  for (const [what, rev, why] of problems) {
    const r = sources.versionAt(L.tree, rev, { env });
    assert.strictEqual(r.status, 'problem', `${what}: es un problema, no «ausente» (${JSON.stringify(r)})`);
    assert.strictEqual(r.version, null);
    assert.match(r.reason, why, what);
  }
  // git que no puede correr (la carpeta no es un clon): problema, no ausente
  assert.strictEqual(sources.versionAt(L.home, v1, { env }).status, 'problem');
  // …y no depende del idioma de git ni del de la sesión
  assert.strictEqual(sources.versionAt(L.tree, bare, { env: Object.assign({}, env, { LC_ALL: 'es_ES.UTF-8', LANG: 'es_ES.UTF-8', LANGUAGE: 'es' }) }).status, 'absent');

  // assess: un problema en CUALQUIERA de los dos lados es «no sé», en los dos canales, y el motivo nombra la ref y el archivo
  const src = { name: 'harness', dir: L.tree, rewrites: true };
  for (const channel of ['stable', 'latest']) {
    for (const [from, to, side] of [[v1, broken, 'lo traído'], [broken, v2, 'lo instalado'], [v1, shapeless, 'lo traído'], [v1, 'f'.repeat(40), 'lo traído']]) {
      const a = sources.assess(src, from, to, { env, channel, labels: { from: 'lo instalado (HEAD)', to: 'origin/main' } });
      assert.strictEqual(a.status, 'unknown', `${channel}, problema en ${side}: ${JSON.stringify(a)}`);
      assert.ok(a.reason.includes('version.json'), `el motivo no nombra el archivo: ${a.reason}`);
      assert.ok(a.reason.includes(side === 'lo traído' ? 'origin/main' : 'lo instalado (HEAD)'), `el motivo no nombra la ref: ${a.reason}`);
    }
  }
  // espejos: el ausente LEGÍTIMO sigue como siempre (stable por ancestría, latest aplica), y el número sano compara
  assert.strictEqual(sources.assess(src, bare, v1, { env, channel: 'stable' }).status, 'new');
  assert.strictEqual(sources.assess(src, bare, v1, { env, channel: 'latest' }).status, 'new');
  assert.strictEqual(sources.assess(src, v1, bare, { env, channel: 'stable' }).status, 'older', 'sin número y ya contenida en lo instalado: no se baja');
  assert.strictEqual(sources.assess(src, v1, bare, { env, channel: 'latest' }).status, 'new');
  assert.strictEqual(sources.assess(src, v1, removed, { env, channel: 'latest' }).status, 'new');
  assert.strictEqual(sources.assess(src, v1, v2, { env, channel: 'stable' }).status, 'new');
  assert.strictEqual(sources.assess(src, v2, v1, { env, channel: 'stable' }).status, 'older');
  assert.strictEqual(sources.assess(src, v2, v1, { env, channel: 'latest' }).status, 'older');
  assert.strictEqual(sources.assess(src, v1, v1, { env, channel: 'stable' }).status, 'up_to_date');
  // una fuente de ref fija no lee números: un version.json roto no la frena (va por ancestría, como siempre)
  assert.strictEqual(sources.assess({ name: 'harness', dir: L.tree, rewrites: false }, v1, broken, { env }).status, 'new');
});

// Rama «no se pudo listar lo sin seguir» de `untrackedInTheWay`. Si
// git no puede listar, NO se mueve y se dice: nunca «no hay nada en el camino» (un `[]` dejaría pasar el `reset --hard`).
// (Probado al revés a mano: devolviendo `[]` en esa rama, el caso falla.)
test('T7·módulo · untrackedInTheWay: si git no puede listar lo sin seguir (o el árbol de la versión nueva), devuelve null y plan no mueve nada', () => {
  const sources = mod('sources');
  const L = lab('t7-untracked-null');
  const [, a0] = sources.detect({ tree: L.tree, home: L.home, env: L.env });
  const src = Object.assign({}, a0, { rewrites: true });
  const from = src.commit;
  const to = L.skills.publish('README.md', 'versión nueva');
  assert.strictEqual(sources.fetch(src, { env: L.env, budgetS: 5 }).ok, true);
  fs.writeFileSync(path.join(L.skillsDir, 'NOTA.md'), 'sin seguir, sin choque\n');
  // espejo: todo legible → la lista (vacía: NOTA.md no choca)
  assert.deepStrictEqual(sources.untrackedInTheWay(L.skillsDir, to, L.env), []);
  // el árbol de la versión nueva no se puede leer (esa rev no está) → null
  assert.strictEqual(sources.untrackedInTheWay(L.skillsDir, 'f'.repeat(40), L.env), null);
  // la carpeta no es un clon: `git ls-files` falla → null
  assert.strictEqual(sources.untrackedInTheWay(L.home, to, L.env), null);
  // el índice del clon ilegible: `git ls-files` falla → null, y plan/advance no mueven nada y lo dicen
  const index = path.join(L.skillsDir, '.git', 'index');
  const saved = fs.readFileSync(index);
  fs.writeFileSync(index, 'esto no es un índice de git');
  try {
    assert.strictEqual(sources.untrackedInTheWay(L.skillsDir, to, L.env), null);
    const p = sources.plan(src, { env: L.env, home: L.home });
    assert.strictEqual(p.ok, false, 'con el clon ilegible el plan dio ok');
    assert.ok(p.reason && p.reason.length > 0, 'sin motivo');
    const adv = sources.advance(src, { env: L.env, home: L.home });
    assert.strictEqual(adv.ok, false);
  } finally { fs.writeFileSync(index, saved); }
  assert.strictEqual(git(L.skillsDir, ['rev-parse', 'HEAD']), from, 'se movió con el clon ilegible');
  // espejo: con el índice sano, la misma versión entra y la nota sigue
  assert.strictEqual(sources.advance(src, { env: L.env, home: L.home }).ok, true);
  assert.strictEqual(git(L.skillsDir, ['rev-parse', 'HEAD']), to);
  assert.ok(fs.existsSync(path.join(L.skillsDir, 'NOTA.md')));
});

// ─── T38·módulo: las tres formas de máquina, a nivel require() ────────────────────────────
// Desde la unión de los dos repos internos una máquina tiene una de tres formas: dos clones sin re-apuntar (las skills
// salen del clon viejo), dos clones con el viejo RE-APUNTADO al repo unificado, o un solo árbol. Las piezas del mecanismo
// —`sources.detect`, `report.versionLine`, la política y `repoint.js`— tienen que contestar bien en las tres. El recorrido
// entero por la línea de comandos vive en `harness-repoint.test.sh` y en las secciones T38 de las otras `harness-*`.

/** La máquina del equipo después del corte: el repo del arnés ya es el UNIDO (su historia contiene la del repo viejo de
 *  skills, con un merge de verdad) y `~/.claude/agent-skills` es un clon del repo viejo. */
function unifiedLab(name) {
  const home = casa(name);
  const skills = repo(`${name}-skills`, (d) => {
    fs.mkdirSync(path.join(d, 'skills', 'tycon-pipeline'), { recursive: true });
    fs.mkdirSync(path.join(d, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(d, 'skills', 'tycon-pipeline', 'SKILL.md'), '# skill de juguete\n');
    fs.writeFileSync(path.join(d, 'agents', 'lab.md'), '# agente de juguete\n');
  });
  const harness = repo(`${name}-harness`, (d) => {
    fs.mkdirSync(path.join(d, 'scripts', 'setup'), { recursive: true });
    fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(d, 'README.md'), '# arnés de juguete\n');
  });
  // la unión: el autor del arnés trae la historia del repo viejo y la mergea (historias sin relación), y la publica
  git(harness.author, ['fetch', '-q', skills.bare, 'refs/heads/main:refs/heads/skills-side']);
  git(harness.author, ['merge', '-q', '--no-ff', '--allow-unrelated-histories', '-m', 'la unión', 'skills-side']);
  git(harness.author, ['push', '-q', 'origin', 'main']);
  const tree = harness.clone(path.join(BASE, `${name}-clones`, 'harness'));
  const skillsDir = skills.clone(path.join(home, '.claude', 'agent-skills'));
  return { home, env: labEnv(home), harness, skills, tree, skillsDir };
}
/** El estado de esa máquina y lo que `repoint.run` necesita de quien lo llama (la copia de seguridad, de mentira). */
function repointRig(L) {
  const sources = mod('sources');
  const state = mod('state').defaults({ tree: L.tree, sources: sources.detect({ tree: L.tree, home: L.home, env: L.env }), mode: 'managed' });
  const calls = { backups: [], writes: 0 };
  const opts = (extra) => Object.assign({ backup: (reason) => { calls.backups.push(reason); return { dir: 'copia de mentira' }; }, finish: () => {}, write: () => { calls.writes++; } }, extra || {});
  return { state, calls, opts, ctx: { home: L.home, env: L.env } };
}

test('T38·módulo · las tres formas: detect da dos fuentes con dos clones (re-apuntados o no) y una con un solo árbol; versionLine muestra un commit sólo cuando los dos clones están en el mismo', () => {
  const sources = mod('sources'); const report = mod('report'); const repoint = mod('repoint');
  const L = unifiedLab('t38-shapes');
  const R = repointRig(L);
  // (1) dos clones sin re-apuntar
  assert.deepStrictEqual(R.state.sources.map((s) => s.name), ['harness', 'agent_skills']);
  assert.notStrictEqual(R.state.sources[0].url, R.state.sources[1].url);
  assert.match(report.versionLine(R.state, { env: L.env }), / · agent-skills [0-9a-f]{7} · /, 'con commits distintos se muestran los dos');
  assert.strictEqual(repoint.providesSkills(R.state, R.state.sources[1], { env: L.env }), true, 'las skills salen del clon viejo');
  assert.strictEqual(repoint.providesSkills(R.state, R.state.sources[0], { env: L.env }), false, 'con dos clones el arnés NO es una fuente de skills: tiene que poder seguir a main');
  // (2) re-apuntados: mismo remoto, mismo commit, siguen siendo dos fuentes
  const r = repoint.run(R.ctx, R.state, R.opts({ want: 'unified', manual: true }));
  assert.strictEqual(r.status, 'done', JSON.stringify(r));
  assert.deepStrictEqual(R.calls.backups, ['repoint'], 'la copia de seguridad se toma antes de mover');
  assert.ok(R.calls.writes >= 2, 'el estado se graba antes de mover (la mudanza «en curso») y al terminar');
  const again = sources.detect({ tree: L.tree, home: L.home, env: L.env });
  assert.deepStrictEqual(again.map((s) => s.name), ['harness', 'agent_skills'], 're-apuntado sigue siendo un clon aparte: dos fuentes');
  assert.strictEqual(again[1].url, again[0].url); assert.strictEqual(again[1].commit, again[0].commit);
  assert.strictEqual(R.state.sources[1].url, again[0].url); assert.strictEqual(R.state.sources[1].commit, again[0].commit);
  const line = report.versionLine(R.state, { env: L.env });
  assert.doesNotMatch(line, /agent-skills [0-9a-f]{7}/, `re-apuntado, version muestra un solo commit: ${line}`);
  assert.ok(line.includes(`+${sha7(again[0].commit)} · managed · `), line);
  const j = report.versionJson(R.state, { env: L.env });
  assert.strictEqual(j.version.harness, j.version.agent_skills, '--json trae los dos, iguales');
  assert.strictEqual(repoint.providesSkills(R.state, R.state.sources[1], { env: L.env }), true);
  // …y la vuelta deja las dos fuentes como estaban
  const b = repoint.run(R.ctx, R.state, R.opts({ want: 'separate', manual: true }));
  assert.strictEqual(b.status, 'undone', JSON.stringify(b));
  assert.strictEqual(R.state.repoint, undefined, 'el estado queda sin rastro de la mudanza');
  assert.deepStrictEqual(sources.detect({ tree: L.tree, home: L.home, env: L.env }).map((s) => s.url), [L.harness.bare, L.skills.bare]);
  // (3) un solo árbol: ~/.claude/agent-skills es un enlace al clon del arnés
  const S = unifiedLab('t38-single');
  fs.rmSync(S.skillsDir, { recursive: true, force: true });
  fs.symlinkSync(S.tree, S.skillsDir);
  const one = sources.detect({ tree: S.tree, home: S.home, env: S.env });
  assert.deepStrictEqual(one.map((s) => s.name), ['harness']);
  const st = mod('state').defaults({ tree: S.tree, sources: one, mode: 'managed' });
  assert.strictEqual(repoint.providesSkills(st, one[0], { env: S.env }), true, 'en un solo árbol las skills salen del arnés');
  assert.deepStrictEqual(repoint.run({ home: S.home, env: S.env }, st, { want: 'unified' }), { status: 'none', proceed: true, lines: [], notice: null }, 'con un solo árbol la llave no tiene nada que re-apuntar');
});

test('T38·módulo · repoint: sin copia de seguridad no se muda; hasSkills contesta sí / no / no pude mirar; la llave sale de la política y un valor inválido no es «unified»', () => {
  const repoint = mod('repoint'); const channel = mod('channel');
  const L = unifiedLab('t38-guard');
  const R = repointRig(L);
  const before = { origin: git(L.skillsDir, ['remote', 'get-url', 'origin']), head: git(L.skillsDir, ['rev-parse', 'HEAD']), config: fs.readFileSync(path.join(L.skillsDir, '.git', 'config'), 'utf8') };
  // (error) quien llama no pudo tomar la copia: no se toca nada, y es pasajero (se reintenta)
  const r = repoint.run(R.ctx, R.state, R.opts({ want: 'unified', manual: true, backup: () => null }));
  assert.strictEqual(r.status, 'blocked'); assert.strictEqual(r.proceed, false);
  assert.match(r.notice, /copia de seguridad/);
  assert.strictEqual(R.state.repoint.blocked.transient, true);
  assert.deepStrictEqual({ origin: git(L.skillsDir, ['remote', 'get-url', 'origin']), head: git(L.skillsDir, ['rev-parse', 'HEAD']), config: fs.readFileSync(path.join(L.skillsDir, '.git', 'config'), 'utf8') }, before, 'sin copia de seguridad no se mueve nada');
  assert.strictEqual(git(L.skillsDir, ['for-each-ref', 'refs/tycon']), '', 'no quedan refs de trabajo');
  // con la política en ask nadie muda nada: queda el aviso con el comando
  const w = repoint.run(R.ctx, R.state, R.opts({ want: 'unified', apply: false }));
  assert.strictEqual(w.status, 'waiting'); assert.strictEqual(w.proceed, true); assert.match(w.notice, /update --yes/);
  assert.strictEqual(git(L.skillsDir, ['remote', 'get-url', 'origin']), before.origin);
  // hasSkills, en tres estados
  assert.strictEqual(repoint.hasSkills(L.tree, 'HEAD', { env: L.env }), true);
  assert.strictEqual(repoint.hasSkills(L.tree, 'HEAD~1', { env: L.env }), false, 'el primer padre de la unión es el arnés de antes: sin skills/');
  assert.strictEqual(repoint.hasSkills(L.tree, 'f'.repeat(40), { env: L.env }), null, 'un commit que no está no es «no las trae»');
  assert.strictEqual(repoint.hasSkills(L.home, 'HEAD', { env: L.env }), null, 'una carpeta que no es un clon tampoco');
  // la vista: sólo la raíz y las tres carpetas
  assert.deepStrictEqual(['README.md', 'skills/a/SKILL.md', 'agents/x.md', 'packs/p/pack.json', 'scripts/install-tycon-hooks.sh', '.githooks/pre-commit', '.advisors/x.json'].filter(repoint.inView), ['README.md', 'skills/a/SKILL.md', 'agents/x.md', 'packs/p/pack.json']);
  // la llave: por defecto separate; unified por la variable o por el archivo de la máquina; inválida → error y separate
  const tree = L.tree;
  let p = channel.read(L.home, labEnv(L.home), { tree });
  assert.deepStrictEqual([p.skillsSource, p.skillsSourceOrigin], ['separate', 'default']);
  p = channel.read(L.home, labEnv(L.home, { TYCON_UPDATE_SKILLS_SOURCE: 'unified' }), { tree });
  assert.deepStrictEqual([p.skillsSource, p.skillsSourceOrigin, p.errors.length], ['unified', 'env', 0]);
  fs.writeFileSync(path.join(L.home, '.claude', 'tycon.json'), JSON.stringify({ update: { skills_source: 'unified' } }));
  p = channel.read(L.home, labEnv(L.home), { tree });
  assert.deepStrictEqual([p.skillsSource, p.skillsSourceOrigin], ['unified', 'maquina']);
  p = channel.read(L.home, labEnv(L.home, { TYCON_UPDATE_SKILLS_SOURCE: 'separate' }), { tree });
  assert.strictEqual(p.skillsSource, 'separate', 'la variable le gana al archivo: así una máquina queda con la llave apagada');
  p = channel.read(L.home, labEnv(L.home, { TYCON_UPDATE_SKILLS_SOURCE: 'both' }), { tree });
  assert.strictEqual(p.skillsSource, 'separate', 'un valor fuera del vocabulario no es «unified»');
  assert.ok(p.errors.length >= 1 && /TYCON_UPDATE_SKILLS_SOURCE/.test(p.errors.join('\n')), 'y es un error de la política: con errores nadie mueve nada');
});

test('T38·módulo · doctorItems: en transición calla (lo dice harness.js); pendiente es un aviso; lo que no pudo pasar es rojo —y aviso bajo la comprobación de salud—; re-apuntado es un dato', () => {
  const repoint = mod('repoint');
  const dir = path.join(BASE, 'no-existe', 'agent-skills');
  const base = { sources: [{ name: 'harness', dir: '/x', url: 'u' }, { name: 'agent_skills', dir, url: 'old' }] };
  const levels = (state, want, o) => repoint.doctorItems(state, want, o || {}).map((i) => i.level);
  assert.deepStrictEqual(levels(base, 'separate'), [], 'con la llave apagada y sin mudanza: nada que decir acá');
  assert.deepStrictEqual(levels(base, null), [], 'con la política mal escrita no se opina de la llave');
  assert.deepStrictEqual(levels({ sources: [base.sources[0]] }, 'unified'), [], 'un solo árbol: nada');
  assert.deepStrictEqual(levels(base, 'unified'), ['warn'], 'la llave pide y todavía no se intentó: aviso');
  const blocked = Object.assign({}, base, { repoint: { blocked: { direction: 'unified', cause: 'branch', reason: 'está en la rama x y no en main', fix: 'git checkout main', transient: false, at: 'hoy' } } });
  let items = repoint.doctorItems(blocked, 'unified', {});
  assert.deepStrictEqual(items.map((i) => i.level), ['fail']);
  assert.ok(items[0].text.startsWith(repoint.PHRASE.unified) && /rama x/.test(items[0].text) && /harness\.js update/.test(items[0].text), items[0].text);
  assert.deepStrictEqual(levels(blocked, 'unified', { health: true }), ['warn'], 'bajo la comprobación de salud un intento anotado es historia: no tira abajo una actualización sana');
  const applied = Object.assign({}, base, { repoint: { applied: { at: 'hoy', from: { url: 'old', commit: 'a'.repeat(40) }, to: { url: 'u', commit: 'b'.repeat(40) } } } });
  items = repoint.doctorItems(applied, 'unified', {});
  assert.deepStrictEqual(items.map((i) => i.level), ['ok']); assert.match(items[0].text, /re-apuntados/);
  assert.deepStrictEqual(levels(applied, 'separate'), ['warn'], 'la llave volvió y todavía no se deshizo: aviso');
  const stuck = Object.assign({}, applied, { repoint: Object.assign({}, applied.repoint, { blocked: { direction: 'separate', cause: 'remote', reason: 'el remoto viejo no contesta', transient: true, at: 'hoy' } }) });
  items = repoint.doctorItems(stuck, 'separate', {});
  assert.deepStrictEqual(items.map((i) => i.level), ['fail']); assert.ok(items[0].text.startsWith(repoint.PHRASE.separate), items[0].text);
  assert.deepStrictEqual(levels(Object.assign({}, base, { repoint: { pending: { step: 'forward', at: 'hoy', from: {}, to: {} } } }), 'unified'), ['fail'], 'una mudanza en curso es rojo');
});

// ─── «no se pudo leer» en lo que decide un movimiento del clon ────────────────
// Las consultas a git contestan en tres estados (existe / no existe / no se pudo
// leer). Tenían caso en «no se pudo leer» la función de los tres estados, `offInstalledBranch` con la rama del mecanismo
// rota y los recorridos por la línea de comandos. Acá van los casos de «no se pudo leer», cada uno con
// su ESPEJO: el mismo escenario con la cosa sana, o ausente de verdad, sigue el camino de siempre.
// Cada uno se prueba AL REVÉS, a mano —rompiendo la rama que
// cubre y restaurándola—, y su comentario dice con qué rotura se pone rojo.
//
// Tres maneras de romper, todas en el disco del laboratorio (sin un `git` de mentira):
//   · una REF: basura en su archivo suelto (el patrón de los casos de arriba);
//   · un OBJETO ilegible: basura en su archivo suelto — git se niega a seguir;
//   · un OBJETO ausente: su archivo apartado — git contesta «no está» o falla; en `rev-list --count`, además, puede
//     contestar callado un número de más (medido con git 2.50): por eso de ese estado se afirma sólo que no se mueve.

const GARBAGE_REF = 'esto no es un sha\n';
const INSTALLED_REF = 'refs/heads/tycon/installed';
const ROLLBACK_ONLY = { onlyFromInstalled: true, who: 'rollback' };
const UNREADABLE = { garbage: true };
const MISSING = { garbage: false };
const OBJECT_BREAKS = [['ilegible (basura en su archivo)', UNREADABLE], ['ausente (su archivo apartado)', MISSING]];
const headOf = (dir) => git(dir, ['rev-parse', 'HEAD']);
const branchOf = (dir) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);

/** Un remoto de juguete, un HOME y clones a pedido, cada uno con la forma de una fuente del estado. */
function sourceLab(name, { sourceName = 'agent_skills', rewrites = true } = {}) {
  const home = casa(name);
  const env = labEnv(home);
  const remote = repo(name, (d) => {
    fs.writeFileSync(path.join(d, 'README.md'), '# fuente de juguete\n');
    fs.writeFileSync(path.join(d, 'VERSION'), '1\n');
  });
  let clones = 0;
  const clone = () => {
    const dir = remote.clone(path.join(BASE, `${name}-clones`, `c${++clones}`));
    return { name: sourceName, url: git(dir, ['remote', 'get-url', 'origin']), ref: 'main', rewrites, dir, commit: git(dir, ['rev-parse', 'HEAD']), previous: null };
  };
  return { home, env, opts: { env, home }, remote, clone };
}

/**
 * Rompe un objeto del clon y devuelve la función que lo deja como estaba: `UNREADABLE` → basura en su archivo; `MISSING`
 * → su archivo apartado. El archivo es un enlace duro al del remoto de juguete (`git clone` de una carpeta): se RENOMBRA
 * y se escribe uno nuevo, nunca se escribe encima.
 */
function breakObject(dir, sha, { garbage }) {
  const file = path.join(dir, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  assert.ok(fs.existsSync(file), `el objeto ${sha7(sha)} no está suelto en ${dir}: este laboratorio no lo puede romper`);
  fs.renameSync(file, `${file}.aside`);
  if (garbage) fs.writeFileSync(file, 'esto no es un objeto de git\n');
  return () => { fs.rmSync(file, { force: true }); fs.renameSync(`${file}.aside`, file); };
}

/** Publica en `mirror/sync` del remoto (la rama que lee `latest`), parada sobre `base`, y deja al autor en `main`. */
function publishSync(remote, base, rel, content) {
  git(remote.author, ['fetch', '-q', 'origin']);
  git(remote.author, ['checkout', '-q', '-B', 'mirror/sync', base]);
  fs.writeFileSync(path.join(remote.author, rel), `${content}\n`);
  git(remote.author, ['add', '-A']);
  git(remote.author, ['commit', '-q', '-m', `sync: ${rel}`]);
  git(remote.author, ['push', '-q', '--force', 'origin', 'mirror/sync']);
  const sha = git(remote.author, ['rev-parse', 'HEAD']);
  git(remote.author, ['checkout', '-q', 'main']);
  return sha;
}

// El chequeo de HEAD de `offInstalledBranch`. En el caso de arriba la rama del mecanismo está rota y lo tapa: acá esa
// rama está SANA (git contesta «no existe»: la primera vez) y lo ilegible es HEAD, por la rama en la que está parado.
// 🔴 rojo comprobado al revés: sin la línea `if (!h) return unreadable('HEAD', …)`, `offInstalledBranch` sigue con un
//    HEAD nulo y tira (`Cannot read properties of null (reading 'slice')`) en vez de decir qué no pudo leer.
test('FUP-8.13-D · OffInstalledBranch_HeadUnreadable_NothingMoves: la primera vez (tycon/installed ausente de verdad) con HEAD ilegible no es «podés moverte»: nombra HEAD, no la rama del mecanismo', () => {
  const sources = mod('sources');
  const L = sourceLab('fup-head');
  const src = L.clone();
  const v1 = src.commit;
  const v2 = L.remote.publish('CHANGES', 'v2');
  assert.strictEqual(sources.fetch(src, { env: L.env, budgetS: 5 }).ok, true);
  const mainFile = path.join(src.dir, '.git', 'refs', 'heads', 'main');
  fs.writeFileSync(mainFile, GARBAGE_REF);
  assert.strictEqual(sources.refState(src.dir, INSTALLED_REF, { env: L.env }).status, 'absent', 'la rama rota de al lado no vuelve ilegible a la del mecanismo');
  assert.strictEqual(sources.refState(src.dir, 'HEAD', { env: L.env }).status, 'problem');
  for (const extra of [{}, ROLLBACK_ONLY]) {
    const off = sources.offInstalledBranch(src, Object.assign({}, L.opts, extra));
    assert.ok(off, `con HEAD ilegible devolvió «podés moverte» (${JSON.stringify(extra)})`);
    assert.ok(/no pude leer HEAD/.test(off) && /no se sabe qué hay instalado/.test(off), `no dice que no pudo leer HEAD: ${off}`);
    assert.ok(!off.includes(INSTALLED_REF), `culpa a la rama del mecanismo, que está sana: ${off}`);
    assert.ok(!/checkout/.test(off), `aconseja un comando sin saber qué hay instalado: ${off}`);
  }
  const p = sources.plan(src, L.opts);
  assert.strictEqual(p.ok, false, 'el plan dio vía libre con HEAD ilegible');
  assert.ok(/no pude leer HEAD/.test(p.reason), p.reason);
  assert.strictEqual(sources.advance(src, L.opts).ok, false);
  assert.strictEqual(fs.readFileSync(mainFile, 'utf8'), GARBAGE_REF, 'pisó la ref que no pudo leer');
  assert.strictEqual(sources.refState(src.dir, INSTALLED_REF, { env: L.env }).status, 'absent', 'creó la rama del mecanismo sin saber qué hay instalado');
  // espejo: HEAD sano → el camino de siempre (la primera vez: `update` pasa; `rollback` pide crear la rama; y avanza)
  fs.writeFileSync(mainFile, `${v1}\n`);
  assert.strictEqual(sources.offInstalledBranch(src, L.opts), null);
  const only = sources.offInstalledBranch(src, Object.assign({}, L.opts, ROLLBACK_ONLY));
  assert.ok(only && /todavía no existe/.test(only) && /checkout -b tycon\/installed/.test(only), `el remedio de siempre cambió: ${only}`);
  const adv = sources.advance(src, L.opts);
  assert.strictEqual(adv.ok, true, adv.reason);
  assert.deepStrictEqual([headOf(src.dir), branchOf(src.dir)], [v2, 'tycon/installed']);
});

// El chequeo de ancestría de `offInstalledBranch` («¿HEAD desciende del commit registrado?»), con la rama del mecanismo
// SANA (ausente de verdad). «No sé» no es «no desciende» (aconsejaría crear la rama en otro commit) ni «sí» (se movería).
// 🔴 rojo comprobado al revés: (a) sin la línea `if (descends === null) return …`, el motivo deja de decir que no pudo
//    comparar y aconseja un `checkout -b tycon/installed`; (b) sin la línea `registered.status === 'problem'`, el motivo
//    deja de nombrar el commit registrado que no se pudo leer.
test('FUP-8.13-D · OffInstalledBranch_AncestryUnreadable_NothingMoves: si git no puede decir si HEAD desciende del commit registrado (un commit del medio ilegible o ausente, o el registrado ilegible) no se mueve ni se aconseja nada', () => {
  const sources = mod('sources');
  const L = sourceLab('fup-ancestry');
  const src = L.clone();   // registrado: v1
  const v1 = src.commit;
  const v2 = L.remote.publish('CHANGES', 'v2');
  const v3 = L.remote.publish('CHANGES', 'v3');
  git(src.dir, ['pull', '-q', '--ff-only', 'origin', 'main']);   // un avance simple en la rama por defecto: HEAD = v3
  const v4 = L.remote.publish('CHANGES', 'v4');
  assert.strictEqual(sources.fetch(src, { env: L.env, budgetS: 5 }).ok, true);
  const untouched = (what) => {
    assert.deepStrictEqual([headOf(src.dir), branchOf(src.dir)], [v3, 'main'], `${what}: movió el clon`);
    assert.strictEqual(sources.refState(src.dir, INSTALLED_REF, { env: L.env }).status, 'absent', `${what}: creó la rama del mecanismo`);
  };
  const blocked = (what, reason) => {
    const p = sources.plan(src, L.opts);
    assert.strictEqual(p.ok, false, `${what}: el plan dio vía libre`);
    assert.ok(reason.test(p.reason), `${what}: ${p.reason}`);
    assert.strictEqual(sources.advance(src, L.opts).ok, false, what);
    untouched(what);
  };

  // (a) el commit del medio (v2): la comparación no se puede hacer
  for (const [what, how] of OBJECT_BREAKS) {
    const repair = breakObject(src.dir, v2, how);
    try {
      assert.strictEqual(sources.ancestor(src.dir, v1, v3, L.env), null, what);
      for (const extra of [{}, ROLLBACK_ONLY]) {
        const off = sources.offInstalledBranch(src, Object.assign({}, L.opts, extra));
        assert.ok(off, `${what}: «no sé si desciende» se leyó como «podés moverte» (${JSON.stringify(extra)})`);
        assert.ok(/no pudo comparar/.test(off) && off.includes(`el commit registrado ${sha7(v1)}`) && off.includes(`HEAD (${sha7(v3)})`), `${what}: no nombra lo que no pudo comparar: ${off}`);
        assert.ok(/no se toca nada/.test(off), off);
        assert.ok(!/no desciende/.test(off), `${what}: «no sé» se dijo como «no desciende»: ${off}`);
        assert.ok(!/checkout/.test(off), `${what}: aconseja un comando sin saber de dónde viene HEAD: ${off}`);
      }
      blocked(what, /no pudo comparar/);
    } finally { repair(); }
  }

  // (b) el commit registrado, ilegible: no se sabe si HEAD desciende de él
  let repair = breakObject(src.dir, v1, UNREADABLE);
  try {
    assert.strictEqual(sources.commitState(src.dir, v1, { env: L.env }).status, 'problem');
    const off = sources.offInstalledBranch(src, L.opts);
    assert.ok(off && off.includes(`no pude leer el commit registrado ${sha7(v1)}`) && /no se sabe si HEAD desciende de él/.test(off), `no nombra el commit que no pudo leer: ${off}`);
    assert.ok(!/checkout/.test(off), `aconseja un comando sobre un commit que no pudo leer: ${off}`);
    blocked('el commit registrado ilegible', /no pude leer el commit registrado/);
  } finally { repair(); }
  // espejo de (b): el commit registrado AUSENTE de verdad → se sabe (HEAD no desciende de él): el motivo y el remedio de
  // siempre, sin punto de partida (ese commit no está)
  repair = breakObject(src.dir, v1, MISSING);
  try {
    assert.strictEqual(sources.commitState(src.dir, v1, { env: L.env }).status, 'absent');
    const off = sources.offInstalledBranch(src, L.opts);
    assert.ok(off && /no desciende del registrado/.test(off) && off.endsWith(`git -C ${src.dir} checkout -b tycon/installed)`), `el camino de siempre cambió: ${off}`);
    untouched('el commit registrado ausente');
  } finally { repair(); }

  // espejo de (a): todo legible → HEAD desciende del registrado: un avance simple, y la versión siguiente entra
  assert.strictEqual(sources.ancestor(src.dir, v1, v3, L.env), true);
  assert.strictEqual(sources.offInstalledBranch(src, L.opts), null);
  const adv = sources.advance(src, L.opts);
  assert.strictEqual(adv.ok, true, adv.reason);
  assert.deepStrictEqual([adv.from, adv.to, headOf(src.dir), branchOf(src.dir)], [v3, v4, v4, 'tycon/installed']);
});

// La cuenta de commits propios de `offInstalledBranch` (`rev-list --count HEAD --not --remotes=origin`): «no pude contar»
// no es «ninguno». Con HEAD en un avance simple (desciende del registrado, en la rama por defecto), «ninguno» es
// justamente lo que deja pasar: de ahí sale un `checkout -B` + `reset --hard`.
// 🔴 rojo comprobado al revés: con `ownCommits` devolviendo 0 cuando git falla, `offInstalledBranch` devuelve `null`
//    («podés moverte») con la cuenta sin hacer.
test('FUP-8.13-D · OffInstalledBranch_OwnCommitsUnreadable_NothingMoves: una cuenta de commits propios que git no pudo hacer no es «ninguno»: el avance simple no pasa', () => {
  const sources = mod('sources');
  const L = sourceLab('fup-own');
  const src = L.clone();   // registrado: v1
  const v1 = src.commit;
  const v2 = L.remote.publish('CHANGES', 'v2');
  git(src.dir, ['pull', '-q', '--ff-only', 'origin', 'main']);   // un avance simple: HEAD = v2
  const v3 = L.remote.publish('CHANGES', 'v3');
  const v4 = L.remote.publish('CHANGES', 'v4');
  assert.strictEqual(sources.fetch(src, { env: L.env, budgetS: 5 }).ok, true);
  const untouched = (what) => {
    assert.deepStrictEqual([headOf(src.dir), branchOf(src.dir)], [v2, 'main'], `${what}: movió el clon`);
    assert.strictEqual(sources.refState(src.dir, INSTALLED_REF, { env: L.env }).status, 'absent', `${what}: creó la rama del mecanismo`);
  };

  // v3 (entre lo traído y HEAD) ilegible: la cuenta falla; la ascendencia de HEAD sí se puede leer
  let repair = breakObject(src.dir, v3, UNREADABLE);
  try {
    assert.strictEqual(sources.ancestor(src.dir, v1, v2, L.env), true, 'lo ilegible es la cuenta, no la ascendencia');
    for (const extra of [{}, ROLLBACK_ONLY]) {
      const off = sources.offInstalledBranch(src, Object.assign({}, L.opts, extra));
      assert.ok(off, `una cuenta que no se pudo hacer se leyó como «ningún commit propio» (${JSON.stringify(extra)})`);
      assert.ok(/no pude ver si tiene commits propios/.test(off), `no dice que no pudo contar: ${off}`);
    }
    assert.strictEqual(sources.ownCommits(src.dir, L.env), null);
    const p = sources.plan(src, L.opts);
    assert.strictEqual(p.ok, false, 'el plan dio vía libre sin saber si hay commits propios');
    assert.ok(/no pude ver si tiene commits propios/.test(p.reason), p.reason);
    assert.strictEqual(sources.advance(src, L.opts).ok, false);
    untouched('v3 ilegible');
  } finally { repair(); }
  // v3 ausente: git no falla, cuenta de más y callado (no puede descartar lo que no ve) — tampoco da vía libre
  repair = breakObject(src.dir, v3, MISSING);
  try {
    assert.notStrictEqual(sources.ownCommits(src.dir, L.env), 0, 'con un commit ausente la cuenta dio «ninguno»');
    assert.ok(sources.offInstalledBranch(src, L.opts), 'con un commit ausente devolvió «podés moverte»');
    assert.strictEqual(sources.advance(src, L.opts).ok, false);
    untouched('v3 ausente');
  } finally { repair(); }

  // espejo: todo legible → ningún commit propio: el avance simple pasa y la versión siguiente entra
  assert.strictEqual(sources.ownCommits(src.dir, L.env), 0);
  assert.strictEqual(sources.offInstalledBranch(src, L.opts), null);
  const adv = sources.advance(src, L.opts);
  assert.strictEqual(adv.ok, true, adv.reason);
  assert.deepStrictEqual([adv.from, adv.to, headOf(src.dir), branchOf(src.dir)], [v2, v4, v4, 'tycon/installed']);
});

// `assess` en `stable`, fuente que se reescribe, sin número en ningún lado (los commits no traen `version.json`:
// legítimo): decide la ancestría («si lo instalado ya contiene lo traído, no se baja»). Una ancestría que git no pudo
// contestar no es «no la contiene»: eso sería `new`, y `update` haría `reset --hard` a una versión quizá más vieja.
// 🔴 rojo comprobado al revés: sin la línea `if (contained === null) return { status: 'unknown', … }` de la rama
//    `channel !== 'latest'`, `assess` devuelve `new`.
test('FUP-8.13-D · Assess_StableWithoutNumberAncestryUnreadable_Unknown: en stable y sin número, una ancestría que git no pudo contestar es «no sé» (nunca «nueva»), y nombra las dos refs', () => {
  const sources = mod('sources');
  const L = sourceLab('fup-assess');
  const src = L.clone();   // HEAD = v1
  const v1 = src.commit;
  const v2 = L.remote.publish('CHANGES', 'v2');
  const v3 = L.remote.publish('CHANGES', 'v3');
  assert.strictEqual(sources.fetch(src, { env: L.env, budgetS: 5 }).ok, true);
  const labels = { from: 'lo instalado (HEAD)', to: 'origin/main' };
  const stable = (from, to) => sources.assess(src, from, to, { env: L.env, channel: 'stable', labels });
  const look = () => sources.check(Object.assign({}, src), { env: L.env, budgetS: 5, channel: 'stable' });

  for (const [what, how] of OBJECT_BREAKS) {
    const repair = breakObject(src.dir, v2, how);
    try {
      // sin número de verdad (no es que no se pudo leer): por eso decide la ancestría
      for (const rev of [v1, v3]) assert.strictEqual(sources.versionAt(src.dir, rev, { env: L.env }).status, 'absent', what);
      for (const [from, to] of [[v3, v1], [v1, v3]]) {
        const a = stable(from, to);
        assert.strictEqual(a.status, 'unknown', `${what}, ${sha7(from)} → ${sha7(to)}: ${JSON.stringify(a)}`);
        assert.deepStrictEqual(a.numbers, { from: null, to: null });
        assert.ok(/no pudo comparar/.test(a.reason) && a.reason.includes('origin/main') && a.reason.includes('lo instalado (HEAD)'), `${what}: el motivo no nombra las dos refs: ${a.reason}`);
      }
    } finally { repair(); }
  }
  // por `check`, que es lo que `update` mira: el fetch sale bien, la comparación no → «no pude mirar», y no se mueve
  const repair = breakObject(src.dir, v2, MISSING);
  try {
    const c = look();
    assert.strictEqual(c.status, 'unknown', JSON.stringify(c));
    assert.ok(/no pude mirar/.test(c.reason) && /no pudo comparar origin\/main/.test(c.reason), c.reason);
    assert.strictEqual(headOf(src.dir), v1, 'check movió el clon');
  } finally { repair(); }

  // espejos: todo legible → contenida en lo instalado, no se baja; no contenida, es nueva
  assert.strictEqual(stable(v3, v1).status, 'older');
  assert.strictEqual(stable(v1, v3).status, 'new');
  const c = look();
  assert.deepStrictEqual([c.status, c.from, c.to], ['new', v1, v3], JSON.stringify(c));
});

// `preferSync` (en `latest`: ¿se lee `mirror/sync` o `main`?), por `check`, que es quien la llama. Sus tres «no sé»: la
// ancestría que git no pudo contestar, el número de la rama que no se pudo leer y el número de `main` que no se pudo
// leer. En los tres no se elige rama: ni `to`, ni la ref de la fuente cambian.
// 🔴 rojo comprobado al revés, una línea por vez: (a) sin `if (merged === null) return …` elige la rama y da `new`;
//    (b) sin `if (vs.status === 'problem') return …` elige la rama (`ref: mirror/sync`, con `to`); (c) sin
//    `if (vm.status === 'problem') return …` elige la rama y da `new`.
test('FUP-8.13-D · Check_PreferSyncUnreadable_NoBranchChosen: en latest, si no se puede saber cuál de mirror/sync y main es más nueva (ancestría o número ilegibles) no se elige rama', () => {
  const sources = mod('sources');
  const L = sourceLab('fup-prefer-sync');
  const src = L.clone();   // HEAD = v1
  const v1 = src.commit;
  const v2 = L.remote.publish('CHANGES', 'v2');
  const v3 = L.remote.publish('CHANGES', 'v3');
  const s1 = publishSync(L.remote, v3, 'SYNC', 's1');
  const look = () => { const s = Object.assign({}, src); return { c: sources.check(s, { env: L.env, budgetS: 5, channel: 'latest' }), ref: s.ref }; };
  const undecided = (r, mainTip, what) => {
    assert.strictEqual(r.c.status, 'unknown', `${what}: ${JSON.stringify(r.c)}`);
    assert.deepStrictEqual([r.c.to, r.c.ref, r.ref, r.c.mainTip], [null, 'main', 'main', mainTip], `${what}: eligió rama sin poder comparar (${JSON.stringify(r.c)})`);
    assert.ok(/no pude mirar/.test(r.c.reason), r.c.reason);
    assert.strictEqual(headOf(src.dir), v1, `${what}: check movió el clon`);
  };

  // espejo de (a), primero (y deja los objetos en el clon): las dos puntas sin número y la rama adelante de main → la rama
  let r = look();
  assert.deepStrictEqual([r.c.status, r.c.ref, r.c.to, r.c.mainTip, r.ref], ['new', 'mirror/sync', s1, v3, 'mirror/sync'], JSON.stringify(r.c));
  // (a) sin número en ningún lado decide si main ya contiene la rama, y git no lo puede contestar (un commit ausente)
  const repair = breakObject(src.dir, v2, MISSING);
  try {
    r = look();
    undecided(r, v3, 'ancestría sin contestar');
    assert.ok(/no pudo comparar origin\/mirror\/sync con origin\/main/.test(r.c.reason), r.c.reason);
  } finally { repair(); }

  // (b) el número de la rama no se puede leer (su version.json está y es ilegible)
  const s2 = publishSync(L.remote, s1, 'version.json', '{ "version": roto');
  r = look();
  undecided(r, v3, 'número de mirror/sync ilegible');
  assert.ok(r.c.reason.includes('version.json') && r.c.reason.includes('origin/mirror/sync'), `no nombra la ref y el archivo: ${r.c.reason}`);
  // espejo de (b): la rama con un número sano (main sigue sin número, y no la contiene) → la rama, con su número
  const s3 = publishSync(L.remote, s2, 'version.json', JSON.stringify({ version: '2026.10.04.2', source: {} }));
  r = look();
  assert.deepStrictEqual([r.c.status, r.c.ref, r.c.to, r.c.numbers.to, r.ref], ['new', 'mirror/sync', s3, '2026.10.04.2', 'mirror/sync'], JSON.stringify(r.c));

  // (c) el número de main no se puede leer
  const v4 = L.remote.publish('version.json', '{ "version": roto');
  r = look();
  undecided(r, v4, 'número de main ilegible');
  assert.ok(r.c.reason.includes('version.json') && r.c.reason.includes('origin/main') && !r.c.reason.includes('origin/mirror/sync'), `no nombra la ref y el archivo: ${r.c.reason}`);
  // espejos de (c): main con un número sano y menor → la rama; mayor → main, y se dice
  const v5 = L.remote.publish('version.json', JSON.stringify({ version: '2026.10.04.1', source: {} }));
  r = look();
  assert.deepStrictEqual([r.c.status, r.c.ref, r.c.to, r.c.mainTip], ['new', 'mirror/sync', s3, v5], JSON.stringify(r.c));
  const v6 = L.remote.publish('version.json', JSON.stringify({ version: '2026.10.04.3', source: {} }));
  r = look();
  assert.deepStrictEqual([r.c.status, r.c.ref, r.c.to, r.ref], ['new', 'main', v6, 'main'], JSON.stringify(r.c));
  assert.ok(/latest lee main/.test(r.c.note || ''), `no dice que latest lee main: ${r.c.note}`);
});

// La ref leída DESPUÉS de un `fetch` que salió bien (`fetchRef`): si no se puede leer no es «la rama no está en el
// remoto» (`missing`: en `latest` eso borra la copia local de la rama y lee `main`) ni «traída». Para tener un fetch que
// sale bien y deja una ref que no es un commit, la rama del remoto de juguete apunta a un blob.
// 🔴 rojo comprobado al revés: sin la línea `if (tip.status !== 'ok') return no(…)`, `fetch` devuelve `ok: true` con
//    `to: null`.
test('FUP-8.13-D · Fetch_TipUnreadableAfterFetch_NotFetchedNotMissing: una ref traída que no se puede leer después de un fetch que salió bien no es «traída» ni «el remoto no la tiene»', () => {
  const sources = mod('sources');
  const L = sourceLab('fup-after-fetch');
  const src = L.clone();   // HEAD = v1
  const v1 = src.commit;
  const v2 = L.remote.publish('CHANGES', 'v2');
  const blob = git(L.remote.bare, ['rev-parse', `${v2}:VERSION`]);
  const pointRemote = (branch, sha) => {
    const file = path.join(L.remote.bare, 'refs', 'heads', ...branch.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${sha}\n`);
  };
  const local = (branch) => sources.refState(src.dir, `refs/remotes/origin/${branch}`, { env: L.env });

  // main del remoto apunta a algo que no es un commit: git lo trae sin quejarse, y la ref traída no se deja leer
  pointRemote('main', blob);
  const raw = sources.git(src.dir, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { env: L.env });
  assert.strictEqual(raw.ok, true, `el fetch de git tenía que salir bien (si no, este caso no mide lo que dice): ${raw.err}`);
  const f = sources.fetch(src, { env: L.env, budgetS: 5 });
  assert.deepStrictEqual([f.ok, f.to, f.missing, f.offline, f.timedOut], [false, null, false, false, false], JSON.stringify(f));
  assert.ok(/no pude leer refs\/remotes\/origin\/main/.test(f.reason) && /después del fetch/.test(f.reason), `no nombra la ref que no pudo leer: ${f.reason}`);
  const c = sources.check(Object.assign({}, src), { env: L.env, budgetS: 5 });
  assert.strictEqual(c.status, 'unknown', JSON.stringify(c));
  assert.ok(c.reason.includes('refs/remotes/origin/main'), c.reason);
  const p = sources.plan(src, L.opts);
  assert.strictEqual(p.ok, false, 'el plan dio vía libre con lo traído ilegible');
  assert.ok(/no pude leer refs\/remotes\/origin\/main/.test(p.reason), p.reason);
  assert.strictEqual(sources.advance(src, L.opts).ok, false);
  assert.deepStrictEqual([headOf(src.dir), branchOf(src.dir)], [v1, 'main'], 'movió el clon sin poder leer lo traído');
  // espejo: el remoto sano → traída, y la versión entra
  pointRemote('main', v2);
  const f2 = sources.fetch(src, { env: L.env, budgetS: 5 });
  assert.deepStrictEqual([f2.ok, f2.to, f2.reason], [true, v2, null], JSON.stringify(f2));
  const adv = sources.advance(src, L.opts);
  assert.strictEqual(adv.ok, true, adv.reason);
  assert.deepStrictEqual([headOf(src.dir), branchOf(src.dir)], [v2, 'tycon/installed']);

  // en `latest`, con la rama `mirror/sync`. Espejo sano primero: la rama está y se lee
  const installed = Object.assign({}, src, { commit: v2 });
  const look = () => { const s = Object.assign({}, installed); return { c: sources.check(s, { env: L.env, budgetS: 5, channel: 'latest' }), ref: s.ref }; };
  const s1 = publishSync(L.remote, v2, 'SYNC', 's1');
  let r = look();
  assert.deepStrictEqual([r.c.status, r.c.ref, r.c.to, r.ref], ['new', 'mirror/sync', s1, 'mirror/sync'], JSON.stringify(r.c));
  // la rama traída e ilegible: «no pude mirar»; NO se lee main en su lugar ni se borra la copia local de la rama
  pointRemote('mirror/sync', blob);
  r = look();
  assert.strictEqual(r.c.status, 'unknown', JSON.stringify(r.c));
  assert.ok(r.c.reason.includes('refs/remotes/origin/mirror/sync') && /después del fetch/.test(r.c.reason), `no nombra la ref que no pudo leer: ${r.c.reason}`);
  assert.deepStrictEqual([r.c.to, r.c.ref, r.ref, r.c.mainTip, r.c.note], [null, 'main', 'main', v2, null], `leyó main en lugar de la rama ilegible: ${JSON.stringify(r.c)}`);
  assert.strictEqual(local('mirror/sync').status, 'problem', 'la copia local de la rama no quedó como la dejó el fetch');
  // espejo «ausente de verdad»: el remoto ya no tiene la rama → `latest` lee main, lo dice, y la copia local se va
  git(L.remote.bare, ['update-ref', '-d', 'refs/heads/mirror/sync']);
  r = look();
  assert.deepStrictEqual([r.c.status, r.c.ref, r.c.to, r.ref], ['up_to_date', 'main', v2, 'main'], JSON.stringify(r.c));
  assert.ok(/el remoto no tiene mirror\/sync/.test(r.c.note || ''), `no dice que el remoto no tiene la rama: ${r.c.note}`);
  assert.strictEqual(local('mirror/sync').status, 'absent');
});

// `rev-list --count origin/<ref>..HEAD` de `plan` (ref fija): los commits propios. Una cuenta que git no pudo hacer no es
// «cero» (daría vía libre al `merge --ff-only`) ni «divergió».
// 🔴 rojo comprobado al revés: con `ahead` en 0 cuando la cuenta falla (`counted.ok ? … : 0`), `plan` devuelve `ok: true`.
test('FUP-8.13-D · Plan_FixedRefOwnCountUnreadable_NothingMoves: en una ref fija, si git no pudo contar los commits propios sobre origin el plan no da vía libre ni dice «divergió»', () => {
  const sources = mod('sources');
  const L = sourceLab('fup-count', { sourceName: 'harness', rewrites: false });
  const src = L.clone();   // HEAD = v1
  const v1 = src.commit;
  const v2 = L.remote.publish('CHANGES', 'v2');
  const v3 = L.remote.publish('CHANGES', 'v3');
  assert.strictEqual(sources.fetch(src, { env: L.env, budgetS: 5 }).ok, true);
  const previous = () => sources.refState(src.dir, sources.previousRef(src.name), { env: L.env }).status;
  const untouched = (what) => {
    assert.deepStrictEqual([headOf(src.dir), branchOf(src.dir)], [v1, 'main'], `${what}: movió el clon`);
    assert.strictEqual(previous(), 'absent', `${what}: guardó previous sin haber movido nada`);
  };

  // v2 (entre lo traído y HEAD) ilegible: la cuenta falla
  let repair = breakObject(src.dir, v2, UNREADABLE);
  try {
    const p = sources.plan(src, L.opts);
    assert.strictEqual(p.ok, false, 'una cuenta que git no pudo hacer se leyó como «cero commits propios»');
    assert.strictEqual(p.divergent, false, '«no sé» no es «divergió»');
    assert.ok(/no pude contar los commits propios/.test(p.reason) && p.reason.includes('origin/main') && /no se toca nada/.test(p.reason), p.reason);
    const adv = sources.advance(src, L.opts);
    assert.strictEqual(adv.ok, false);
    assert.ok(/no pude contar/.test(adv.reason), adv.reason);
    untouched('v2 ilegible');
  } finally { repair(); }
  // v2 ausente: git no falla, cuenta de más y callado (no puede descartar lo que no ve) — tampoco da vía libre
  repair = breakObject(src.dir, v2, MISSING);
  try {
    assert.strictEqual(sources.plan(src, L.opts).ok, false, 'con un commit ausente el plan dio vía libre');
    assert.strictEqual(sources.advance(src, L.opts).ok, false);
    untouched('v2 ausente');
  } finally { repair(); }

  // espejo: todo legible → cero commits propios: avanza con merge --ff-only
  const p = sources.plan(src, L.opts);
  assert.strictEqual(p.ok, true, p.reason);
  assert.deepStrictEqual([p.from, p.to, p.divergent], [v1, v3, false]);
  const adv = sources.advance(src, L.opts);
  assert.strictEqual(adv.ok, true, adv.reason);
  assert.deepStrictEqual([headOf(src.dir), branchOf(src.dir), git(src.dir, ['rev-parse', sources.previousRef(src.name)])], [v3, 'main', v1]);
});

// `dirtyTracked` (`git status` de lo que git sigue) en `plan` de una ref fija y en `revert`: «no pude mirar si hay cambios
// sin commitear» no es «no hay». En `revert` es lo que separa a la persona de un `reset --hard` sin copia.
// 🔴 Al revés: (plan) sin la línea `if (dirty === null) return …`, `plan` devuelve `ok: true`;
//    (revert) sin su línea `if (dirty === null) return …`, `revert` sigue hasta el `reset --hard` y el motivo ya no es
//    «no pude mirar si hay cambios sin commitear».
test('FUP-8.13-D · PlanAndRevert_StatusUnreadable_NothingMoves: si git status no puede contestar, ni plan (ref fija) ni revert mueven nada, y lo modificado sin commitear sigue donde estaba', () => {
  const sources = mod('sources');
  const L = sourceLab('fup-status', { sourceName: 'harness', rewrites: false });
  const src = L.clone();   // HEAD = v1
  const v1 = src.commit;
  const v2 = L.remote.publish('CHANGES', 'v2');
  assert.strictEqual(sources.fetch(src, { env: L.env, budgetS: 5 }).ok, true);
  // lo de la persona: un archivo que git sigue, modificado y sin commitear (lo publicado no lo toca)
  const mine = path.join(src.dir, 'VERSION');
  fs.writeFileSync(mine, '1-local\n');
  const index = path.join(src.dir, '.git', 'index');
  const withBrokenIndex = (fn) => {
    const saved = fs.readFileSync(index);
    fs.writeFileSync(index, 'esto no es un índice de git');
    try { fn(); } finally { fs.writeFileSync(index, saved); }
  };

  // plan
  withBrokenIndex(() => {
    const p = sources.plan(src, L.opts);
    assert.strictEqual(p.ok, false, 'el plan dio vía libre sin saber si hay cambios sin commitear');
    assert.ok(/no pude mirar si hay cambios sin commitear/.test(p.reason) && /git status falló/.test(p.reason) && /no se toca nada/.test(p.reason), p.reason);
    assert.strictEqual(sources.advance(src, L.opts).ok, false);
    assert.strictEqual(headOf(src.dir), v1, 'movió el clon sin saber si hay cambios sin commitear');
  });
  // espejo: git status contesta → hay cambios: se apartan, avanza y se reaplican
  const p = sources.plan(src, L.opts);
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.dirty, true);
  const adv = sources.advance(src, L.opts);
  assert.strictEqual(adv.ok, true, adv.reason);
  assert.deepStrictEqual([adv.stashed, adv.kept, headOf(src.dir), fs.readFileSync(mine, 'utf8')], [true, false, v2, '1-local\n']);

  // revert
  withBrokenIndex(() => {
    const rv = sources.revert(src, v1, { env: L.env });
    assert.deepStrictEqual([rv.ok, rv.kept], [false, false], JSON.stringify(rv));
    assert.ok(/no pude mirar si hay cambios sin commitear/.test(rv.reason) && /no se tocó nada/.test(rv.reason), rv.reason);
    assert.strictEqual(headOf(src.dir), v2, 'volvió atrás sin saber si hay cambios sin commitear');
  });
  assert.strictEqual(fs.readFileSync(mine, 'utf8'), '1-local\n', 'el cambio sin commitear de la persona se perdió');
  assert.strictEqual(git(src.dir, ['stash', 'list']), '', 'una vuelta atrás que no se hizo dejó un stash');
  // espejo: git status contesta → vuelve a v1 y lo de la persona se reaplica
  const rv = sources.revert(src, v1, { env: L.env });
  assert.deepStrictEqual([rv.ok, rv.kept], [true, false], JSON.stringify(rv));
  assert.deepStrictEqual([headOf(src.dir), branchOf(src.dir), fs.readFileSync(mine, 'utf8')], [v1, 'main', '1-local\n']);
});

/**
 * Lo que hace falta para llamar a `rollback.restore` y ver qué decidió `planTrees` (que no se exporta): una fuente de ref
 * fija parada en v2 con una copia de seguridad que vuelve a v1, y UN archivo «cerrado» en la copia (con su
 * `sha256_after`), para ver si la vuelta atrás tocó archivos además de árboles. El aplicador es uno de juguete que no
 * devuelve reporte de piezas (el de verdad corre el instalador): sólo cuenta si lo llamaron.
 */
function rollbackLab(name) {
  const crypto = require('crypto');
  const rollback = mod('rollback');
  const state = mod('state');
  const L = sourceLab(name, { sourceName: 'harness', rewrites: false });
  const st = L.clone();
  const v1 = st.commit;
  const v2 = L.remote.publish('CHANGES', 'v2');
  git(st.dir, ['pull', '-q', '--ff-only', 'origin', 'main']);
  Object.assign(st, { commit: v2, previous: v1 });
  const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const BEFORE = '{ "de": "antes del cambio" }\n';
  const AFTER = '{ "de": "después del cambio" }\n';
  const file = path.join(L.home, '.claude', 'settings.json');
  const copyDir = path.join(BASE, `${name}-copy`);
  fs.mkdirSync(path.join(copyDir, 'files'), { recursive: true });
  fs.writeFileSync(path.join(copyDir, 'files', 'settings.json'), BEFORE);
  fs.writeFileSync(file, AFTER);
  const calls = { applier: 0 };
  /** Corre la vuelta atrás al commit `to`, con la fuente `source` (la del laboratorio si no se pasa otra). */
  const restore = (to, source = st) => {
    const s = state.defaults({ tree: st.dir, sources: [Object.assign({}, source)], mode: 'managed' });
    const copy = {
      dir: copyDir, name: 'copy-1',
      manifest: { seq: 1, reason: 'before-update', sources: { harness: to }, files: [{ path: file, existed: true, sha256: sha256(BEFORE), sha256_after: sha256(AFTER), copy: path.join('files', 'settings.json') }] },
    };
    return rollback.restore({ home: L.home, env: L.env, tree: st.dir }, s, copy, { runApplier: () => { calls.applier += 1; return { ok: true, report: null }; } });
  };
  /** La vuelta atrás frenada antes de tocar nada: ni árboles, ni archivos, ni aplicador. */
  const untouched = (r, what) => {
    assert.strictEqual(r.ok, false, `${what}: ${JSON.stringify(r.lines)}`);
    assert.deepStrictEqual(r.moved, [], what);
    assert.ok(/no se tocó nada: ni archivos ni árboles/.test(r.lines[r.lines.length - 1] || ''), `${what}: ${JSON.stringify(r.lines)}`);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), AFTER, `${what}: restauró archivos sin poder mover los árboles`);
    assert.strictEqual(calls.applier, 0, `${what}: corrió el aplicador`);
    assert.deepStrictEqual([headOf(st.dir), branchOf(st.dir)], [v2, 'main'], `${what}: movió el clon`);
  };
  /** La vuelta atrás de siempre: el árbol vuelve a v1 sobre su rama, el archivo vuelve entero y el aplicador corre. */
  const restored = (r) => {
    assert.strictEqual(r.ok, true, JSON.stringify(r.lines));
    assert.deepStrictEqual(r.moved, [{ name: 'harness', from: v2, to: v1 }]);
    assert.deepStrictEqual([headOf(st.dir), branchOf(st.dir), fs.readFileSync(file, 'utf8'), calls.applier], [v1, 'main', BEFORE, 1]);
  };
  return { L, st, v1, v2, restore, untouched, restored };
}

// `planTrees` de rollback.js, su HEAD: ilegible no es «no es un clon de git» (ni «nada que mover»).
// 🔴 Al revés: con el bloqueo de `if (!from)` diciendo siempre «no es un clon de git» (sin mirar
//    `isRepo`), la línea ya no dice que no pudo leer HEAD.
test('FUP-8.13-D · Rollback_PlanTreesHeadUnreadable_NothingTouched: una fuente con HEAD ilegible frena la vuelta atrás entera (ni archivos ni árboles) y dice que no pudo leer HEAD, no que «no es un clon»', () => {
  const R = rollbackLab('fup-rollback-head');
  const mainFile = path.join(R.st.dir, '.git', 'refs', 'heads', 'main');
  fs.writeFileSync(mainFile, GARBAGE_REF);
  let r;
  try {
    r = R.restore(R.v1);
    assert.strictEqual(fs.readFileSync(mainFile, 'utf8'), GARBAGE_REF, 'pisó la ref que no pudo leer');
  } finally { fs.writeFileSync(mainFile, `${R.v2}\n`); }   // sana otra vez: lo que sigue le pregunta a git dónde quedó
  assert.ok(r.lines.some((l) => /no pude leer HEAD/.test(l) && /no se sabe qué hay instalado/.test(l)), `no dice que no pudo leer HEAD: ${JSON.stringify(r.lines)}`);
  assert.ok(!r.lines.some((l) => /no es un clon/.test(l)), `un HEAD ilegible se dijo como «no es un clon»: ${JSON.stringify(r.lines)}`);
  R.untouched(r, 'HEAD ilegible');
  // espejo «ausente de verdad»: la carpeta de la fuente no es un clon → lo dice así, y tampoco toca nada
  r = R.restore(R.v1, Object.assign({}, R.st, { dir: R.L.home }));
  assert.ok(r.lines.some((l) => /no es un clon de git/.test(l)) && !r.lines.some((l) => /no pude leer HEAD/.test(l)), JSON.stringify(r.lines));
  R.untouched(r, 'la fuente no es un clon');
  // espejo sano: vuelve
  R.restored(R.restore(R.v1));
});

// `planTrees` de rollback.js, el commit de la copia: «no pude mirar si está» no es «no está en el clon» ni «está».
// 🔴 Al revés: sin la línea `if (target.status === 'problem') { … }`, la vuelta atrás sigue de largo:
//    restaura el archivo de la copia y recién falla en el `reset --hard`.
test('FUP-8.13-D · Rollback_PlanTreesCopyCommitUnreadable_NothingTouched: si no se puede mirar el commit al que vuelve la copia, la vuelta atrás no toca nada (ni archivos ni árboles) y no dice «no está en el clon»', () => {
  const R = rollbackLab('fup-rollback-commit');
  let repair = breakObject(R.st.dir, R.v1, UNREADABLE);
  try {
    const r = R.restore(R.v1);
    assert.ok(r.lines.some((l) => l.includes(`no pude mirar si el commit ${sha7(R.v1)} de la copia está en el clon`)), `no dice qué no pudo mirar: ${JSON.stringify(r.lines)}`);
    assert.ok(!r.lines.some((l) => /de la copia no está en el clon/.test(l)), `«no pude mirar» se dijo como «no está»: ${JSON.stringify(r.lines)}`);
    R.untouched(r, 'el commit de la copia ilegible');
  } finally { repair(); }
  // espejo «ausente de verdad»: ese commit no está en el clon → lo dice así, y tampoco toca nada
  repair = breakObject(R.st.dir, R.v1, MISSING);
  try {
    const r = R.restore(R.v1);
    assert.ok(r.lines.some((l) => l.includes(`el commit ${sha7(R.v1)} de la copia no está en el clon`)) && !r.lines.some((l) => /no pude mirar/.test(l)), JSON.stringify(r.lines));
    R.untouched(r, 'el commit de la copia ausente');
  } finally { repair(); }
  // espejo sano: vuelve
  R.restored(R.restore(R.v1));
});

// ─── los controles ESPERADOS contra la máquina, a nivel módulo ──────────────────────
// `doctor` no puede comparar sólo con lo que el aplicador reportó (`managed`): un control que el aplicador nunca registra no saldría, y
// diría «todas en su lugar» (aunque al instalador de Windows le faltaran 15).
// 🔴 Sin `expectedControls` en managed.js el caso muere en «M.expectedControls is not a function».

/** Un árbol de juguete con las cuatro fuentes de la cuenta: la lista del `.sh`, la del `.ps1`, las condiciones y lo
 *  excluido en Windows. Lo que se pasa en `null` no se escribe (el archivo falta). */
function expectedLab(name, { ps1 = undefined, conditions = undefined, support = undefined } = {}) {
  const home = fs.mkdtempSync(path.join(BASE, `${name}-`));
  const tree = path.join(home, 'tree');
  fs.mkdirSync(path.join(tree, 'scripts', 'tests', 'fixtures'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'scripts', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'scripts', 'install-tycon-hooks.sh'), [
    'HOOKS_CANONICAL=(',
    '  "SessionStart||@tcg:always-notice.js|aviso de juguete"',
    '  "PreToolUse|Bash|tycon-pipeline/scripts/always-gate.js|portón de juguete"',
    '  "SessionStart||@tcg:nightly-notice.js|aviso de un nocturno de juguete"',
    '  "SessionStart||@tcg:posix-only-heal.sh|reparación que sólo tiene sentido con bash"',
    ')',
    'OPTIN_HOOKS+=( "PreToolUse|Bash|@tcg:toy-guard-pre.sh|freno de juguete, prendido de fábrica" )',
    'OPTIN_HOOKS+=( "PreToolUse|Bash|@tcg:engram-pre-commit.sh|de la integración engram, con su interruptor" )',
    'OPTIN_HOOKS+=( "PreToolUse|Bash|@tcg:toy-session-guard.js|freno de juguete, apagado de fábrica" )',
    '',
  ].join('\n'));
  if (ps1 !== null) {
    fs.writeFileSync(path.join(tree, 'scripts', 'install-tycon-hooks.ps1'), ps1 !== undefined ? ps1 : [
      '$HooksCanonical = @(',
      "    @{ event='SessionStart';     matcher=$null;  relpath='always-notice.js';  source='tcg'; label='aviso de juguete'; async=$false }",
      "    @{ event='PreToolUse';       matcher='Bash'; relpath='tycon-pipeline/scripts/always-gate.js'; label='porton de juguete'; async=$false }",
      "    @{ event='SessionStart';     matcher=$null;  relpath='nightly-notice.js'; source='tcg'; label='aviso de un nocturno'; async=$false }",
      "    @{ event='PreToolUse';       matcher='Bash'; relpath='toy-guard-pre.sh';  source='tcg'; label='freno de juguete'; async=$false }",
      "    @{ event='PostToolUse';      matcher='Write'; relpath='toy-windows-only/scripts/on-create.js'; label='solo lo escribe el de Windows'; async=$false }",
      ')',
      "$SupersededRelpaths = @( 'tycon-pipeline/scripts/gone.js' )",
      '',
    ].join('\n'));
  }
  const hook = (id, when) => ({ kind: 'hook', id, where_pattern: 'settings\\.json$', when });
  if (conditions !== null) {
    fs.writeFileSync(path.join(tree, 'scripts', 'tests', 'fixtures', 'harness-managed-pieces.json'), JSON.stringify(conditions !== undefined ? conditions : { pieces: [
      { kind: 'link', id: 'tycon-claude-guides', when: 'always' },
      hook('SessionStart:@tcg:always-notice.js', 'always'),
      hook('PreToolUse:tycon-pipeline/scripts/always-gate.js', 'always'),
      hook('SessionStart:@tcg:nightly-notice.js', 'integration:nightly'),
      hook('SessionStart:@tcg:posix-only-heal.sh', 'always'),
      hook('PreToolUse:@tcg:toy-guard-pre.sh', 'optin:TYCON_SAFETY_GUARD'),
      hook('PreToolUse:@tcg:engram-pre-commit.sh', 'integration:engram'),
      hook('PreToolUse:@tcg:toy-session-guard.js', 'optin:TYCON_SESSION_GUARD'),
      hook('PostToolUse:toy-windows-only/scripts/on-create.js', 'platform:windows'),
    ] }));
  }
  if (support !== null) {
    fs.writeFileSync(path.join(tree, 'scripts', 'setup', 'windows-support.json'), typeof support === 'string' ? support : JSON.stringify(support !== undefined ? support : {
      native: 'preparing', excluded: [{ id: 'posix-only-heal.sh', kind: 'hook', reason: 'pide python3 y repara la línea de arranque de bash' }],
    }));
  }
  const settings = path.join(home, 'settings.json');
  /** settings.json con esos controles (`<EVENTO>:<ruta>`), escritos como los escribe el aplicador de `platform`. */
  const register = (ids, platform = 'darwin') => {
    const hooks = {};
    for (const id of ids) {
      const i = id.indexOf(':');
      const [event, rel] = [id.slice(0, i), id.slice(i + 1)];
      const root = platform === 'win32' ? 'C:/lab/.claude' : path.join(home, '.claude');
      const file = rel.startsWith('@tcg:') ? `${root}/tycon-claude-guides/scripts/hooks/${rel.slice(5)}` : `${root}/agent-skills/skills/${rel}`;
      // el guion, en el disco (la cuenta mira que exista); la forma de Windows (`C:/lab/…`) no se puede crear acá, y
      // fuera de Windows esa ruta no es absoluta: la cuenta no la puede mirar y no la da por faltante
      if (platform !== 'win32') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); }
      const matcher = /^(PreToolUse|PostToolUse)$/.test(event) ? (rel.includes('on-create.js') ? 'Write' : 'Bash') : undefined;
      (hooks[event] = hooks[event] || []).push(Object.assign(matcher ? { matcher } : {}, { hooks: [{ type: 'command', command: `${rel.endsWith('.sh') ? 'bash' : 'node'} "${file}"` }] }));
    }
    fs.writeFileSync(settings, JSON.stringify({ hooks }));
  };
  const M = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'managed.js'));
  const count = (platform, { integrations = { nightly: true, engram: true, clockify: true }, env = {} } = {}) =>
    M.expectedControls({ platform, tree, integrations, home, env: Object.assign({ TYCON_SETTINGS_PATH: settings }, env) });
  return { home, tree, settings, register, count };
}
const idsOf = (list) => list.map((x) => x.id).sort();

const POSIX_ALL = [
  'SessionStart:@tcg:always-notice.js', 'PreToolUse:tycon-pipeline/scripts/always-gate.js', 'SessionStart:@tcg:nightly-notice.js',
  'SessionStart:@tcg:posix-only-heal.sh', 'PreToolUse:@tcg:toy-guard-pre.sh', 'PreToolUse:@tcg:engram-pre-commit.sh',
];
const WINDOWS_ALL = [
  'SessionStart:@tcg:always-notice.js', 'PreToolUse:tycon-pipeline/scripts/always-gate.js', 'SessionStart:@tcg:nightly-notice.js',
  'PreToolUse:@tcg:toy-guard-pre.sh', 'PostToolUse:toy-windows-only/scripts/on-create.js',
];

test('T96 · Managed_ExpectedControls_MissingCounted_ByPlatformAndConfig: en Mac y Linux la lista sale del .sh; falta lo que se espera y no está; lo apagado no se espera', () => {
  const L = expectedLab('t96-posix');
  for (const platform of ['darwin', 'linux']) {
    // a settings.json le falta UNO de los esperados
    L.register(POSIX_ALL.filter((id) => !id.includes('always-gate.js')));
    let r = L.count(platform);
    assert.strictEqual(r.source, 'install-tycon-hooks.sh', `${platform}: la lista sale del .sh`);
    assert.deepStrictEqual(idsOf(r.expected), [...POSIX_ALL].sort(), `${platform}: lo esperado con todo prendido`);
    assert.deepStrictEqual(idsOf(r.missing), ['PreToolUse:tycon-pipeline/scripts/always-gate.js'], `${platform}: falta el que no está`);
    assert.deepStrictEqual(r.excluded, [], `${platform}: fuera de Windows nada sale como «fuera en Windows»`);
    assert.deepStrictEqual(r.problems, [], `${platform}: ${JSON.stringify(r.problems)}`);
    // el freno apagado de fábrica no se espera (y no está): no cuenta como faltante
    assert.ok(r.off.some((x) => x.id === 'PreToolUse:@tcg:toy-session-guard.js'), `${platform}: el opt-in apagado de fábrica sale en off: ${JSON.stringify(r.off)}`);
    // espejo: con todo registrado no falta nada
    L.register(POSIX_ALL);
    r = L.count(platform);
    assert.deepStrictEqual(r.missing, [], `${platform} espejo: ${JSON.stringify(r.missing)}`);
    assert.strictEqual(r.expected.length, POSIX_ALL.length);
  }
  // una integración apagada: su control no se espera, aunque no esté
  L.register(POSIX_ALL.filter((id) => !id.includes('nightly-notice.js')));
  let r = L.count('linux', { integrations: { nightly: false, engram: true } });
  assert.deepStrictEqual(r.missing, [], `integración apagada: ${JSON.stringify(r.missing)}`);
  assert.ok(r.off.some((x) => x.id === 'SessionStart:@tcg:nightly-notice.js' && /nightly/.test(x.why)), JSON.stringify(r.off));
  // …y su espejo: prendida y sin registrar, falta
  r = L.count('linux');
  assert.deepStrictEqual(idsOf(r.missing), ['SessionStart:@tcg:nightly-notice.js']);
  // un opt-in que nace prendido, apagado por su variable: no se espera; el que nace apagado, prendido: sí
  L.register(POSIX_ALL.filter((id) => !id.includes('toy-guard-pre.sh')));
  r = L.count('darwin', { env: { TYCON_SAFETY_GUARD: '0' } });
  assert.deepStrictEqual(r.missing, [], `opt-in apagado: ${JSON.stringify(r.missing)}`);
  assert.ok(r.off.some((x) => x.id === 'PreToolUse:@tcg:toy-guard-pre.sh' && /TYCON_SAFETY_GUARD/.test(x.why)), JSON.stringify(r.off));
  r = L.count('darwin');
  assert.deepStrictEqual(idsOf(r.missing), ['PreToolUse:@tcg:toy-guard-pre.sh'], 'espejo: sin la variable nace prendido y falta');
  L.register(POSIX_ALL);
  r = L.count('darwin', { env: { TYCON_SESSION_GUARD: '1' } });
  assert.deepStrictEqual(idsOf(r.missing), ['PreToolUse:@tcg:toy-session-guard.js'], 'el opt-in que nace apagado, prendido por su variable, se espera');
  // el de la integración engram: su interruptor, puesto, manda sobre la llave en los dos sentidos
  L.register(POSIX_ALL.filter((id) => !id.includes('engram-pre-commit.sh')));
  assert.deepStrictEqual(idsOf(L.count('darwin', { integrations: { nightly: true, engram: false } }).missing), [], 'llave apagada: no se espera');
  assert.deepStrictEqual(idsOf(L.count('darwin', { integrations: { nightly: true, engram: false }, env: { TYCON_ENGRAM_HOOK: '1' } }).missing), ['PreToolUse:@tcg:engram-pre-commit.sh'], 'interruptor en 1 con la llave apagada: se espera');
  assert.deepStrictEqual(idsOf(L.count('darwin', { env: { TYCON_ENGRAM_HOOK: '0' } }).missing), [], 'interruptor en 0 con la llave prendida: no se espera');
  // la configuración rota (sin saber qué integraciones hay): lo de una integración queda como estaba, ni falta ni «apagado»
  r = L.count('darwin', { integrations: null });
  assert.deepStrictEqual(r.missing, [], `configuración rota: ${JSON.stringify(r.missing)}`);
  assert.deepStrictEqual(idsOf(r.unknown), ['PreToolUse:@tcg:engram-pre-commit.sh', 'SessionStart:@tcg:nightly-notice.js'], JSON.stringify(r.unknown));
});

test('T96 · Managed_ExpectedControls_MissingCounted_ByPlatformAndConfig: en Windows la lista sale del .ps1; lo excluido sale con su motivo y nunca como faltante', () => {
  const L = expectedLab('t96-win');
  L.register(WINDOWS_ALL.filter((id) => !id.includes('always-notice.js')), 'win32');
  let r = L.count('win32');
  assert.strictEqual(r.source, 'install-tycon-hooks.ps1');
  assert.deepStrictEqual(idsOf(r.expected), [...WINDOWS_ALL].sort(), 'lo esperado en Windows: las filas del .ps1 que su condición prende');
  assert.deepStrictEqual(idsOf(r.missing), ['SessionStart:@tcg:always-notice.js'], 'falta el que no está, con la forma de ruta de Windows en los demás');
  assert.deepStrictEqual(r.excluded, [{ id: 'posix-only-heal.sh', reason: 'pide python3 y repara la línea de arranque de bash' }], 'lo excluido, con su motivo');
  assert.ok(!r.missing.some((x) => x.id.includes('posix-only-heal.sh')) && !r.expected.some((x) => x.id.includes('posix-only-heal.sh')), 'lo excluido no se espera ni falta');
  // lo que el .sh registra y el .ps1 no (y nadie excluyó) no es de esta plataforma: no se espera
  assert.ok(!r.expected.some((x) => x.id.includes('engram-pre-commit.sh')));
  assert.deepStrictEqual(r.problems, []);
  // espejo: completo
  L.register(WINDOWS_ALL, 'win32');
  assert.deepStrictEqual(L.count('win32').missing, []);
  // una fila del .ps1 que TAMBIÉN está excluida: gana lo declarado, no falta
  const both = expectedLab('t96-win-both', { support: { excluded: [{ id: 'toy-guard-pre.sh', kind: 'hook', reason: 'sin medir en Windows' }] } });
  both.register(WINDOWS_ALL.filter((id) => !id.includes('toy-guard-pre.sh')), 'win32');
  r = both.count('win32');
  assert.deepStrictEqual(r.missing, [], JSON.stringify(r.missing));
  assert.deepStrictEqual(r.excluded, [{ id: 'toy-guard-pre.sh', reason: 'sin medir en Windows' }]);
  // la lista vacía actual: nada excluido, y no es un problema
  const empty = expectedLab('t96-win-empty', { support: { native: 'preparing', excluded: [] } });
  empty.register(WINDOWS_ALL, 'win32');
  r = empty.count('win32');
  assert.deepStrictEqual([r.excluded, r.problems, r.missing], [[], [], []]);
  // sin el archivo, o ilegible: se dice; nunca «nada excluido» callado
  for (const [name, support] of [['t96-win-nofile', null], ['t96-win-broken', '{ roto']]) {
    const lab = expectedLab(name, { support });
    lab.register(WINDOWS_ALL, 'win32');
    r = lab.count('win32');
    assert.ok(r.problems.some((p) => p.includes('windows-support.json')), `${name}: no dice que no pudo leer lo excluido: ${JSON.stringify(r.problems)}`);
    // espejo: fuera de Windows ese archivo no se mira
    lab.register(POSIX_ALL);
    assert.deepStrictEqual(lab.count('linux').problems, [], `${name}: en Linux no se mira windows-support.json`);
  }
  // el .ps1 sin una lista legible: no hay cuenta, y se dice (no es «0 esperados»)
  const noList = expectedLab('t96-win-nolist', { ps1: '# gemelo de juguete sin lista\nexit 0\n' });
  r = noList.count('win32');
  assert.strictEqual(r.listed, null);
  assert.ok(r.problems.some((p) => p.includes('install-tycon-hooks.ps1')), JSON.stringify(r.problems));
  assert.deepStrictEqual([r.expected, r.missing], [[], []]);
});

test('T96 · Managed_ExpectedControls_MissingCounted_ByPlatformAndConfig: sin la lista de condiciones cuenta todo lo de la lista y lo avisa; con las listas reales del árbol, cada control tiene su condición', () => {
  const L = expectedLab('t96-noconditions', { conditions: null });
  L.register(POSIX_ALL);
  const r = L.count('darwin');
  assert.ok(r.caveat && r.caveat.includes('harness-managed-pieces.json'), `no avisa que contó sin condiciones: ${JSON.stringify(r)}`);
  assert.deepStrictEqual(idsOf(r.missing), ['PreToolUse:@tcg:toy-session-guard.js'], 'sin condiciones, todo lo de la lista se espera');
  // espejo: con la lista de condiciones no hay salvedad
  assert.strictEqual(expectedLab('t96-conditions').count('darwin').caveat, null);
  // las listas REALES: cada control que un aplicador conoce tiene su condición declarada, y la cuenta se puede hacer
  const M = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'managed.js'));
  const home = fs.mkdtempSync(path.join(BASE, 't96-real-'));
  const on = { ado: true, clockify: true, engram: true, codegraph: true, mailbox: true, codex: true, nightly: true, telegram: true };
  for (const platform of ['darwin', 'win32']) {
    const real = M.expectedControls({ platform, tree: RAIZ, integrations: on, home, env: { TYCON_SETTINGS_PATH: path.join(home, 'settings.json') } });
    assert.ok(real.listed >= 25, `${platform}: la lista real se lee (${real.listed})`);
    assert.strictEqual(real.caveat, null, `${platform}: ${real.caveat}`);
    assert.deepStrictEqual(real.undeclared, [], `${platform}: controles de la lista sin condición declarada en harness-managed-pieces.json: ${JSON.stringify(real.undeclared)}`);
    assert.deepStrictEqual(real.problems, [], `${platform}: ${JSON.stringify(real.problems)}`);
    assert.strictEqual(real.missing.length, real.expected.length, `${platform}: en una carpeta vacía falta todo lo esperado`);
    assert.ok(real.missing.every((x) => M.EVENTS.includes(x.event) && x.relpath), `${platform}: cada faltante con su evento y su guion`);
  }
});

// El lector de la lista del `.ps1` no toma una fila COMENTADA: si la tomara, `doctor` la
// contaría como un control esperado que falta (el aplicador no la registra: PowerShell no la lee).
// 🔴 Sin esto, con la fila comentada, `ps1Hooks` devolvería también `PreToolUse:@tcg:toy-guard-pre.sh` y `Stop:@tcg:retired-meter.js`.
test('T96 · Ps1Hooks_CommentedRow_NotExpected: una fila del .ps1 comentada con # no es un control esperado; la misma fila sin comentar, sí', () => {
  const M = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'managed.js'));
  const list = (commented) => [
    '$HooksCanonical = @(',
    "    @{ event='SessionStart';     matcher=$null;  relpath='always-notice.js';  source='tcg'; label='aviso de juguete'; async=$false }",
    `    ${commented ? '# ' : ''}@{ event='PreToolUse';       matcher='Bash'; relpath='toy-guard-pre.sh';  source='tcg'; label='freno de juguete'; async=$false }`,
    // un `#` DENTRO de la etiqueta y un comentario al final de la fila no la apagan
    "    @{ event='PreToolUse';       matcher='Bash'; relpath='tycon-pipeline/scripts/always-gate.js'; label='porton #1 de juguete'; async=$false }   # sigue en la lista",
    "    #@{ event='Stop'; matcher=$null; relpath='retired-meter.js'; source='tcg'; label='retirado, sin espacio tras el #'; async=$false }",
    ')',
    '',
  ].join('\n');
  const ids = (tree) => (M.ps1Hooks(tree) || []).map((h) => `${h.event}:${h.relpath}`).sort();
  const LIVE = ['PreToolUse:tycon-pipeline/scripts/always-gate.js', 'SessionStart:@tcg:always-notice.js'];
  // la fila comentada no está en la lista, ni se espera, ni «falta»
  const off = expectedLab('t96-ps1-commented', { ps1: list(true) });
  assert.deepStrictEqual(ids(off.tree), LIVE, 'las filas comentadas no son de la lista');
  off.register([], 'win32');
  let r = off.count('win32');
  assert.strictEqual(r.listed, 2, `cuenta ${r.listed} filas`);
  assert.deepStrictEqual(idsOf(r.expected), LIVE, `lo esperado: ${JSON.stringify(idsOf(r.expected))}`);
  assert.deepStrictEqual(idsOf(r.missing), LIVE, 'falta sólo lo que el aplicador registraría');
  assert.ok(![...r.expected, ...r.missing, ...r.off, ...r.unknown].some((x) => /toy-guard-pre\.sh|retired-meter\.js/.test(x.id)), 'una fila comentada no sale en ninguna cuenta');
  assert.deepStrictEqual(r.undeclared, [], `una fila comentada tampoco es «sin condición declarada»: ${JSON.stringify(r.undeclared)}`);
  // espejo: la misma fila sin comentar es un control esperado, y falta
  const on = expectedLab('t96-ps1-uncommented', { ps1: list(false) });
  assert.deepStrictEqual(ids(on.tree), [...LIVE, 'PreToolUse:@tcg:toy-guard-pre.sh'].sort(), 'sin comentar, la fila es de la lista');
  on.register(LIVE, 'win32');
  r = on.count('win32');
  assert.deepStrictEqual(idsOf(r.missing), ['PreToolUse:@tcg:toy-guard-pre.sh'], 'sin comentar, se espera y falta');
  // y con la lista real del árbol, el lector lee lo mismo que las filas que empiezan la línea (las que PowerShell lee)
  // la lista real es scripts/setup/hooks-list.json más los hooks de Claude Code de las integraciones de horas (sus
  // manifiestos): en Windows, lo que no excluye
  const INT = require(path.join(RAIZ, 'scripts', 'lib', 'integrations.js'));
  const intHooks = INT.listManifests({ dir: path.join(RAIZ, 'integrations') }).manifests.flatMap((m) => INT.hookEntries(m, { tool: 'claude' }));
  const realList = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'setup', 'hooks-list.json'), 'utf8')).hooks.concat(intHooks);
  const realPairs = new Set(realList.filter((h) => h.platforms.windows !== false).map((h) => `${h.event}:${h.spec}`));
  assert.deepStrictEqual(ids(RAIZ), [...realPairs].sort(), 'la lista real: la lista única, menos lo que excluye de Windows');
});

// La condición `optin:telegram-plugin` mira una CARPETA (`[[ -d … ]]`), como install-tycon-hooks.sh; si mirara «existe» (cualquier cosa, también
// un archivo), con un archivo en esa ruta doctor esperaría
// telegram-zombie-sweep.sh y lo daría por faltante para siempre, aunque el aplicador nunca lo registra.
// 🔴 Sin esto, con un archivo en la ruta del plugin, el control saldría en `expected` y en `missing`.
test('T96 · Managed_TelegramOptIn_NeedsDirectory: un archivo donde va la carpeta del plugin no prende el control; la carpeta, sí', () => {
  const L = expectedLab('t96-telegram', { conditions: { pieces: [
    { kind: 'hook', id: 'SessionStart:@tcg:telegram-zombie-sweep.sh', where_pattern: 'settings\\.json$', when: 'optin:telegram-plugin' },
  ] } });
  fs.writeFileSync(path.join(L.tree, 'scripts', 'install-tycon-hooks.sh'), 'HOOKS_CANONICAL=(\n  "SessionStart||@tcg:telegram-zombie-sweep.sh|barrido de juguete"\n)\n');
  L.register([]);
  const plugin = path.join(L.home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram');
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  const ID = 'SessionStart:@tcg:telegram-zombie-sweep.sh';
  // un ARCHIVO en la ruta de la carpeta: como el .sh, no se espera
  fs.writeFileSync(plugin, 'no soy una carpeta');
  let r = L.count('darwin');
  assert.ok(!r.expected.some((x) => x.id === ID) && !r.missing.some((x) => x.id === ID), `un archivo no prende el control: ${JSON.stringify(r.missing)}`);
  assert.ok(r.off.some((x) => x.id === ID), `sale entre los apagados: ${JSON.stringify(r.off)}`);
  // un enlace colgado tampoco
  fs.rmSync(plugin); fs.symlinkSync(path.join(L.home, 'no-existe'), plugin);
  r = L.count('darwin');
  assert.ok(!r.missing.some((x) => x.id === ID), `un enlace colgado no prende el control: ${JSON.stringify(r.missing)}`);
  // el espejo: la carpeta → se espera, y falta (no está registrado)
  fs.rmSync(plugin); fs.mkdirSync(plugin);
  r = L.count('darwin');
  assert.deepStrictEqual(idsOf(r.missing), [ID], `con la carpeta se espera: ${JSON.stringify(r.missing)}`);
});

// «Está» no es evento + final de ruta: un control es evento + MATCHER + guion, corrido
// con el intérprete de su extensión y con el guion en el disco. Las dos filas PostToolUse de rebuild-before-verify.js
// (`Edit|Write` y `Bash`) son DOS controles: sin una, doctor diría «todos registrados» y el aplicador, que falta una.
// 🔴 Sin esto: sin la fila `Bash` la cuenta sale sin faltantes; `node "…/x.sh"`, un freno bajo otro matcher y un
// comando a un guion borrado también se darían por registrados; y la cuenta sería 1 menos que la del aplicador.
test('T96 · Managed_ExpectedControls_MatcherInterpreterScriptOnDisk: dos matchers son dos controles; otro matcher, otro intérprete o un guion que no está = faltante con su motivo', () => {
  const sh = [
    'HOOKS_CANONICAL=(',
    '  "PostToolUse|Edit|Write|@tcg:two-rows.js|marca, de juguete"',
    '  "PostToolUse|Bash|@tcg:two-rows.js|limpia, de juguete"',
    '  "PreToolUse|Bash|@tcg:toy-guard-pre.sh|freno de juguete"',
    '  "SessionStart||@tcg:always-notice.js|aviso de juguete"',
    ')',
    '',
  ].join('\n');
  const ps1 = [
    '$HooksCanonical = @(',
    "    @{ event='PostToolUse';  matcher='Edit|Write'; relpath='two-rows.js';      source='tcg'; label='marca'; async=$false }",
    "    @{ event='PostToolUse';  matcher='Bash';       relpath='two-rows.js';      source='tcg'; label='limpia'; async=$false }",
    "    @{ event='PreToolUse';   matcher='Bash';       relpath='toy-guard-pre.sh'; source='tcg'; label='freno'; async=$false }",
    "    @{ event='SessionStart'; matcher=$null;        relpath='always-notice.js'; source='tcg'; label='aviso'; async=$false }",
    ')',
    '',
  ].join('\n');
  const always = (id) => ({ kind: 'hook', id, where_pattern: 'settings\\.json$', when: 'always' });
  const conditions = { pieces: ['PostToolUse:@tcg:two-rows.js', 'PreToolUse:@tcg:toy-guard-pre.sh', 'SessionStart:@tcg:always-notice.js'].map(always) };
  const L = expectedLab('t96-matchers', { ps1, conditions, support: { native: 'preparing', excluded: [] } });
  fs.writeFileSync(path.join(L.tree, 'scripts', 'install-tycon-hooks.sh'), sh);
  const hooksDir = path.join(L.home, '.claude', 'tycon-claude-guides', 'scripts', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const f of ['two-rows.js', 'toy-guard-pre.sh', 'always-notice.js']) fs.writeFileSync(path.join(hooksDir, f), '');
  const p = (f) => `${hooksDir}/${f}`.split(path.sep).join('/');
  const FULL = [
    ['PostToolUse', 'Write|Edit', `node "${p('two-rows.js')}"`],   // el matcher en otro orden es el mismo
    ['PostToolUse', 'Bash', `node "${p('two-rows.js')}"`],
    ['PreToolUse', 'Bash', `bash "${p('toy-guard-pre.sh')}"`],
    ['SessionStart', null, `node "${p('always-notice.js')}"`],
  ];
  const write = (rows) => {
    const hooks = {};
    for (const [event, matcher, command] of rows) (hooks[event] = hooks[event] || []).push(Object.assign(matcher ? { matcher } : {}, { hooks: [{ type: 'command', command }] }));
    fs.writeFileSync(L.settings, JSON.stringify({ hooks }));
  };
  const short = (list) => list.map((x) => `${x.event}|${x.matcher || ''}|${x.relpath}`).sort();
  for (const platform of ['darwin', 'win32']) {
    // todo en su lugar: cuatro controles (las dos filas de two-rows.js cuentan por separado), ninguno falta
    write(FULL);
    let r = L.count(platform);
    assert.strictEqual(r.expected.length, 4, `${platform}: cuatro controles, como cuenta el aplicador: ${JSON.stringify(short(r.expected))}`);
    assert.strictEqual(r.listed, 4, `${platform}: cuatro filas en la lista (${r.listed})`);
    assert.deepStrictEqual(r.missing, [], `${platform} todo en su lugar: ${JSON.stringify(r.missing)}`);
    // sin la fila Bash de two-rows.js: falta ESA, con su matcher
    write(FULL.filter((x) => !(x[0] === 'PostToolUse' && x[1] === 'Bash')));
    r = L.count(platform);
    assert.deepStrictEqual(short(r.missing), ['PostToolUse|Bash|@tcg:two-rows.js'], `${platform}: falta la fila Bash: ${JSON.stringify(r.missing)}`);
    assert.ok(/Bash/.test(r.missing[0].label || ''), `${platform}: lo que se muestra nombra el matcher: ${r.missing[0].label}`);
    assert.strictEqual(r.missing[0].why, 'no está registrado', `${platform}: la fila hermana (Edit|Write) es otro control, no «otro matcher»: ${r.missing[0].why}`);
    // el freno bajo otro matcher: no frena los comandos, falta, y se dice por qué
    write(FULL.map((x) => (x[2].includes('toy-guard-pre.sh') ? ['PreToolUse', 'Edit', x[2]] : x)));
    r = L.count(platform);
    assert.deepStrictEqual(short(r.missing), ['PreToolUse|Bash|@tcg:toy-guard-pre.sh'], `${platform}: el freno bajo otro matcher: ${JSON.stringify(r.missing)}`);
    assert.ok(/matcher/.test(r.missing[0].why), `${platform}: el motivo nombra el matcher: ${r.missing[0].why}`);
    // un .sh registrado con node: no corre, falta, y se dice por qué
    write(FULL.map((x) => (x[2].includes('toy-guard-pre.sh') ? ['PreToolUse', 'Bash', `node "${p('toy-guard-pre.sh')}"`] : x)));
    r = L.count(platform);
    assert.deepStrictEqual(short(r.missing), ['PreToolUse|Bash|@tcg:toy-guard-pre.sh'], `${platform}: node con un .sh: ${JSON.stringify(r.missing)}`);
    assert.ok(/node/.test(r.missing[0].why) && /bash/.test(r.missing[0].why), `${platform}: el motivo nombra los dos intérpretes: ${r.missing[0].why}`);
    // un comando que apunta a un guion que no existe: falta, con su motivo
    const gone = `${L.home}/clon-borrado/scripts/hooks/always-notice.js`.split(path.sep).join('/');   // el clon que ya no está
    write(FULL.map((x) => (x[2].includes('always-notice.js') ? ['SessionStart', null, `node "${gone}"`] : x)));
    r = L.count(platform);
    assert.deepStrictEqual(short(r.missing), ['SessionStart||@tcg:always-notice.js'], `${platform}: el guion que no está: ${JSON.stringify(r.missing)}`);
    assert.ok(/disco/.test(r.missing[0].why), `${platform}: el motivo dice que no está en el disco: ${r.missing[0].why}`);
    // el espejo: de nuevo todo en su lugar
    write(FULL);
    assert.deepStrictEqual(L.count(platform).missing, [], `${platform} espejo`);
  }
  // la lista real: las dos filas PostToolUse de rebuild-before-verify.js son dos controles, en las dos plataformas
  const M = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'managed.js'));
  const home = fs.mkdtempSync(path.join(BASE, 't96-real-matchers-'));
  const on = { ado: true, clockify: true, engram: true, codegraph: true, mailbox: true, codex: true, nightly: true, telegram: true };
  for (const platform of ['darwin', 'win32']) {
    const real = M.expectedControls({ platform, tree: RAIZ, integrations: on, home, env: { TYCON_SETTINGS_PATH: path.join(home, 'settings.json') } });
    const rebuild = real.expected.filter((x) => x.id === 'PostToolUse:@tcg:rebuild-before-verify.js').map((x) => x.matcher).sort();
    assert.deepStrictEqual(rebuild, ['Bash|PowerShell', 'Edit|Write'], `${platform}: rebuild-before-verify.js en PostToolUse, dos controles (el de comandos con «Bash|PowerShell», 2026-10-04): ${JSON.stringify(rebuild)}`);
  }
  // los lectores de la lista siguen devolviendo un par evento+guion por entrada (los usa `unregistered`), con sus matchers
  const two = (M.ps1Hooks(L.tree) || []).filter((h) => h.relpath === '@tcg:two-rows.js');
  assert.strictEqual(two.length, 1, 'ps1Hooks: un par por evento+guion');
  assert.deepStrictEqual(two[0].matchers, ['Edit|Write', 'Bash'], `ps1Hooks: con sus dos matchers: ${JSON.stringify(two[0])}`);
  const twoSh = (M.applierHooks(L.tree) || []).filter((h) => h.relpath === '@tcg:two-rows.js');
  assert.deepStrictEqual([twoSh.length, twoSh[0] && twoSh[0].matchers], [1, ['Edit|Write', 'Bash']], `applierHooks: ${JSON.stringify(twoSh)}`);
});

// `profile.resolve` dice el motivo REAL cuando no puede leer
// el perfil — un lector que no carga no es «no conoce el perfil», y uno sin la sección install tampoco es «roto».
test('8.16 C · profile.resolve: el motivo real del lector (falta, no carga, es anterior) y el perfil de un árbol sano', () => {
  const P = mod('profile');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'perfil-lector-'));
  const arbol = (nombre, contenido) => {
    const d = path.join(base, nombre);
    fs.mkdirSync(path.join(d, 'scripts', 'lib'), { recursive: true });
    if (contenido !== null) fs.writeFileSync(path.join(d, 'scripts', 'lib', 'tycon-config.js'), contenido);
    return d;
  };
  const roto = P.resolve({ tree: arbol('roto', 'throw new Error("lector roto a propósito");\n'), home: base, env: {} });
  assert.deepStrictEqual([roto.ok, /no carga/.test(roto.reason), /lector roto a propósito/.test(roto.reason)], [false, true, true], JSON.stringify(roto));
  const viejo = P.resolve({ tree: arbol('viejo', 'module.exports = { VOCABULARIO: { ado: {} } };\n'), home: base, env: {} });
  assert.deepStrictEqual([viejo.ok, /anterior al perfil/.test(viejo.reason)], [false, true], JSON.stringify(viejo));
  const falta = P.resolve({ tree: arbol('falta', null), home: base, env: {} });
  assert.deepStrictEqual([falta.ok, /no trae el lector/.test(falta.reason)], [false, true], JSON.stringify(falta));
  // el árbol de verdad, sin perfil del equipo ni archivo de la máquina: full sin elegir
  const sano = P.resolve({ tree: path.resolve(MODULES, '..', '..', '..'), home: base, env: { TYCON_PROFILE: '0' } });
  assert.deepStrictEqual([sano.ok, sano.value, sano.origin, sano.chosen], [true, 'full', 'sin-valor', false], JSON.stringify(sano));
  fs.rmSync(base, { recursive: true, force: true });
});

// ─── T2 · State_AdditiveFields_OldStateReadsAsInternalNoLayer_ConfigKeysWithOrigin ─────────
// El estado sigue en `schema: 1` y gana campos ADITIVOS: `source` (internal | public), `sources[].kind` (tree | layer),
// `sources[].reference` (sólo layer), `layer`, `migration` y `migration_hold` —que no reusan `tree_before` ni `hold` del estado
// base—. Un estado base, que no trae ninguno, se lee como `source: internal` sin capa: las suites de
// arriba no cambian. La mitad de configuración de T2 vive en tycon-config.test.js.
// 🔴 Sin esto, `read` devolvería el estado tal cual (sin `source`) y no habría `kindOf`
//    ni `layerSources`.

/** Un estado base: los campos de su `defaults`, ninguno de `source`, `layer` ni `migration`. */
function stateOf813(tree) {
  return {
    schema: 1, mode: 'managed', tree, tree_before: null,
    sources: [{ name: 'harness', url: 'file:///lab/harness.git', ref: 'main', rewrites: false, dir: tree, commit: 'a'.repeat(40), previous: null }],
    channel: 'stable', version: { number: null, installed_at: '2026-10-01T00:00:00.000Z' }, managed: [], hold: null, notice: null,
    last_fetch: null, last_apply: null, last_health: null, failed: null, bootstrap: { version: null, sha256: {} },
  };
}

test('8.13.1 · T2 · un estado de la 8.13 sin source se lee como internal sin capa, y leerlo no escribe nada', () => {
  const state = mod('state');
  const home = casa('t2-8131-old');
  const tree = path.join(home, 'tree'); fs.mkdirSync(tree, { recursive: true });
  const p = state.paths(home);
  const text = `${JSON.stringify(stateOf813(tree), null, 2)}\n`;
  fs.writeFileSync(p.file, text);
  const r = state.read(home);
  assert.strictEqual(r.status, 'ok', r.reason);
  assert.strictEqual(r.state.schema, 1);
  assert.strictEqual(r.state.source, 'internal', 'sin «source» es internal');
  for (const k of ['layer', 'migration', 'migration_hold']) assert.strictEqual(r.state[k], null, `sin «${k}» es null`);
  assert.deepStrictEqual(state.layerSources(r.state), [], 'sin capa');
  assert.strictEqual(state.kindOf(r.state.sources[0]), 'tree', 'una fuente sin kind es el árbol');
  assert.strictEqual(r.state.sources[0].kind, undefined, 'la fuente de la 8.13 no se reescribe al leerla');
  assert.strictEqual(fs.readFileSync(p.file, 'utf8'), text, 'leer no escribe');
  // lo del estado base sigue donde estaba
  assert.strictEqual(r.state.tree_before, null);
  assert.strictEqual(r.state.hold, null);
});

test('8.13.1 · T2 · defaults trae source, layer, migration y migration_hold; las dos fuentes (harness árbol, internal capa) se escriben y se leen tal cual', () => {
  const state = mod('state');
  const sources = mod('sources');
  assert.strictEqual(state.SCHEMA, 1, 'sigue schema 1');
  assert.deepStrictEqual([state.TREE_SOURCE, state.LAYER_SOURCE], ['harness', 'internal']);
  // `release`: la versión bajada como archivos, al lado del clon y la capa
  assert.deepStrictEqual([state.SOURCE_VALUES, state.KINDS], [['internal', 'public'], ['tree', 'layer', 'release']]);
  assert.strictEqual(sources.previousRef(state.LAYER_SOURCE), 'refs/tycon/previous/internal', 'la ref de vuelta de la capa');

  const home = casa('t2-8131-new');
  const tree = path.join(home, 'tree'); fs.mkdirSync(tree, { recursive: true });
  const d = state.defaults({ tree, sources: [] });
  assert.deepStrictEqual([d.source, d.layer, d.migration, d.migration_hold], ['internal', null, null, null]);
  assert.strictEqual(state.defaults({ tree, sources: [], source: 'public' }).source, 'public');

  const readClone = path.join(home, '.claude', '.tycon-pipeline', 'harness', 'sources', 'internal');
  const harness = { name: 'harness', kind: 'tree', url: 'file:///lab/public.git', ref: 'mirror/sync', rewrites: true, dir: tree, commit: 'a'.repeat(40), previous: null };
  const internal = { name: 'internal', kind: 'layer', url: 'file:///lab/internal.git', ref: 'main', rewrites: false, dir: readClone, reference: path.join(home, 'own-clone'), commit: 'b'.repeat(40), previous: null };
  const s = state.defaults({ tree, sources: [harness, internal], source: 'public', channel: 'latest' });
  s.layer = { manifest: path.join(home, '.claude', '.tycon-pipeline', 'harness', 'layer.json'), version: '2026.10.06.1', at: '2026-10-06T00:00:00.000Z', minimum: true, lag_hours: 3 };
  s.migration = { tree_before: path.join(home, 'old-clone'), journal: path.join(home, '.claude', '.tycon-pipeline', 'harness', 'migration.json') };
  s.migration_hold = { at: '2026-10-06T00:00:00.000Z', reason: 'rollback' };
  state.write(home, s);
  const r = state.read(home);
  assert.strictEqual(r.status, 'ok', r.reason);
  assert.deepStrictEqual(r.state, s, 'se lee tal cual');
  assert.deepStrictEqual(state.layerSources(r.state).map((x) => x.name), ['internal']);
  assert.deepStrictEqual(r.state.sources.map(state.kindOf), ['tree', 'layer']);
  assert.strictEqual(state.layerSources(r.state)[0].dir, readClone, 'el clon de lectura va en su dir');
  // no reusa los del estado base
  assert.deepStrictEqual([r.state.tree_before, r.state.hold], [null, null]);
});

test('8.13.1 · T2 · un source, un kind o un reference fuera de lugar es un estado roto (2 con el motivo), nunca «no instalado»', () => {
  const state = mod('state');
  const home = casa('t2-8131-bad');
  const tree = path.join(home, 'tree'); fs.mkdirSync(tree, { recursive: true });
  const p = state.paths(home);
  const bad = (mutate) => { const s = stateOf813(tree); mutate(s); fs.writeFileSync(p.file, JSON.stringify(s)); return state.read(home); };
  for (const [what, mutate, word] of [
    ['source: cloud', (s) => { s.source = 'cloud'; }, /source/],
    ['kind: blob', (s) => { s.sources[0].kind = 'blob'; }, /kind/],
    ['reference en un árbol', (s) => { s.sources[0].reference = '/x'; }, /reference/],
    ['layer que no es objeto', (s) => { s.layer = 'sí'; }, /layer/],
    ['migration que no es objeto', (s) => { s.migration = 1; }, /migration/],
    ['migration_hold que no es objeto', (s) => { s.migration_hold = []; }, /migration_hold/],
  ]) {
    const r = bad(mutate);
    assert.strictEqual(r.status, 'broken', `${what}: ${JSON.stringify(r.status)}`);
    assert.match(r.reason || '', word, `${what}: el motivo no nombra el campo: ${r.reason}`);
    const f = state.fail(r);
    assert.strictEqual(f.code, 2);
    assert.doesNotMatch(f.line, /no instalado/);
  }
});

// ─── el candado que no se traba (T38-T40) ──────────────────────────────────────────────────────
// Un candado de dueño muerto no puede trabar los arranques: si sólo se mirara su edad, cada arranque diría «otra sesión está actualizando (candado,
// pid N) — me voy» aunque el PID ya no viva, y el arnés quedaría atrasado.

/** Un PID que seguro ya no vive: el de un proceso que terminó. */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return parseInt(r.stdout, 10);
}

test('T38 · Lock_DeadPidTakenAtOnce_LivePidWaits_UnknownOrReusedPidByAge', () => {
  const lock = mod('lock');
  const state = mod('state');
  const home = casa('t38-lock');
  const env = labEnv(home);
  const p = state.paths(home);
  const put = (content) => { fs.rmSync(p.lockDir, { recursive: true, force: true }); fs.mkdirSync(p.lockDir, { recursive: true }); fs.writeFileSync(path.join(p.lockDir, 'pid'), content); };
  // el candado nuevo dice el PID y la máquina
  const a = lock.acquire(home, { env });
  assert.strictEqual(a.ok, true);
  assert.deepStrictEqual(fs.readFileSync(path.join(p.lockDir, 'pid'), 'utf8').trim().split('\n'), [String(process.pid), os.hostname()]);
  lock.release(home);
  // fresco, de un proceso MUERTO de esta máquina → se pisa en el acto, y lo dice
  const dead = deadPid();
  put(`${dead}\n${os.hostname()}\n`);
  const b = lock.acquire(home, { env });
  assert.strictEqual(b.ok, true, `no pisó el candado de un proceso muerto: ${JSON.stringify(b)}`);
  assert.deepStrictEqual(b.reclaimed, { pid: dead }, 'no dice de quién era el candado que pisó');
  // y lo dice el registro, para cualquier comando que tome el candado
  assert.match(fs.readFileSync(p.log, 'utf8'), new RegExp(`era del pid ${dead}, que ya no existe`), 'el registro no dice qué candado pisó');
  assert.strictEqual(fs.readFileSync(path.join(p.lockDir, 'pid'), 'utf8').split('\n')[0], String(process.pid));
  assert.ok(!fs.existsSync(`${p.lockDir}.takeover`), 'quedó el mutex de takeover');
  lock.release(home);
  // el formato viejo (sólo el PID) es de esta máquina: muerto → se pisa
  put(`${deadPid()}\n`);
  assert.strictEqual(lock.acquire(home, { env }).ok, true, 'no pisó el candado viejo de un proceso muerto');
  lock.release(home);
  // vivo → espera, y el motivo lo dice
  put(`${process.ppid}\n${os.hostname()}\n`);
  const c = lock.acquire(home, { env });
  assert.strictEqual(c.ok, false, 'pisó el candado de un proceso vivo');
  assert.match(c.reason, /vive/);
  // de OTRA máquina (un HOME compartido): no se puede consultar → la regla de la edad: fresco = ocupado
  put(`${deadPid()}\notra-maquina-de-laboratorio\n`);
  assert.strictEqual(lock.acquire(home, { env }).ok, false, 'pisó un candado fresco de otra máquina');
  // sin PID legible: la edad
  put('');
  assert.strictEqual(lock.acquire(home, { env }).ok, false, 'pisó un candado fresco sin PID');
  // el que toma el candado EN NOMBRE de otro proceso (el instalador de Windows lo toma con un `node -e` que termina
  // enseguida): queda a nombre del proceso que lo usa, no del que lo tomó
  fs.rmSync(p.lockDir, { recursive: true, force: true });
  const viaShortLived = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(MODULES, 'lock.js'))}).acquire(${JSON.stringify(home)}, { ownerPid: ${process.pid} })))`], { encoding: 'utf8', env: labEnv(home) });
  assert.strictEqual(JSON.parse(viaShortLived.stdout).ok, true);
  assert.strictEqual(fs.readFileSync(path.join(p.lockDir, 'pid'), 'utf8').split('\n')[0], String(process.pid), 'quedó a nombre del proceso que lo tomó y ya terminó');
  assert.strictEqual(lock.acquire(home, { env }).ok, false, 'el candado del instalador vivo se pisó porque lo tomó un proceso que ya terminó');
  // «vive» sólo cuando vive: un dueño muerto mientras otro tiene el mutex de takeover no se dice vivo
  put(`${deadPid()}\n${os.hostname()}\n`);
  fs.mkdirSync(`${p.lockDir}.takeover`);
  const held = lock.acquire(home, { env });
  assert.strictEqual(held.ok, false);
  assert.doesNotMatch(held.reason, /vive/, `dice «vive» de un proceso muerto: ${held.reason}`);
  fs.rmSync(`${p.lockDir}.takeover`, { recursive: true, force: true });
  fs.rmSync(p.lockDir, { recursive: true, force: true });
});

test('T38 · el candado de bootstrap.js con el dueño muerto: varios arranques a la vez, nunca dos dueños', async () => {
  // (la copia de bootstrap.js tiene que usar el mutex de takeover de lock.js)
  const home = casa('t38-bootstrap-race');
  const hdir = path.join(home, '.claude', '.tycon-pipeline', 'harness');
  const lockDir = path.join(hdir, 'harness.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'pid'), `${deadPid()}\n${os.hostname()}\n`);
  const log = path.join(home, 'holders.log');
  const worker = path.join(home, 'worker.js');
  fs.writeFileSync(worker, `const fs = require('fs');
const B = require(${JSON.stringify(path.join(MODULES, 'bootstrap.js'))});
const l = B.acquireLock();
if (l.ok) {
  fs.appendFileSync(${JSON.stringify(log)}, 'in ' + process.pid + ' ' + Date.now() + '\\n');
  const t = Date.now() + 300; while (Date.now() < t) { /* tiene el candado */ }
  fs.appendFileSync(${JSON.stringify(log)}, 'out ' + process.pid + ' ' + Date.now() + '\\n');
  B.releaseLock(l);
}`);
  const { spawn } = require('child_process');
  const env = labEnv(home);
  await Promise.all(Array.from({ length: 8 }, () => new Promise((res) => spawn(process.execPath, [worker], { env, stdio: 'ignore' }).on('exit', res))));
  const events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')) : [];
  assert.ok(events.length >= 2, 'nadie tomó el candado del dueño muerto');
  let inside = 0; let max = 0;
  for (const [what] of events) { inside += what === 'in' ? 1 : -1; max = Math.max(max, inside); }
  assert.strictEqual(max, 1, `dos arranques tuvieron el candado a la vez:\n${events.map((e) => e.join(' ')).join('\n')}`);
  assert.ok(!fs.existsSync(`${lockDir}.takeover`), 'quedó el mutex de takeover');
});

test('T39 · StartupUpdate_Detached_HookCutDoesNotKillIt_EarlyErrorStillReported_NoInteractiveLogin', () => {
  const D = mod('detach');
  const dir = fs.mkdtempSync(path.join(BASE, 't39-'));
  const script = path.join(dir, 'child.js');
  // el hijo hace lo que le pide su argv y anota su resultado como lo hace harness.js en la corrida desprendida
  fs.writeFileSync(script, [
    "'use strict';",
    `const D = require(${JSON.stringify(path.join(MODULES, 'detach.js'))});`,
    'if (!D.adoptDetachedRun()) throw new Error("no llegó como ejecución desprendida");',
    `if (process.env.${'TYCON_STARTUP_DETACHED'} || process.env.${'TYCON_STARTUP_RESULT'}) throw new Error('la marca quedó en el ambiente: la heredan los nietos');`,
    "const [what, out] = process.argv.slice(2);",
    "if (what === 'throw') throw new Error('roto a propósito');",
    "if (what === 'sleep') { const t = Date.now() + 2500; while (Date.now() < t) { /* trabaja */ } require('fs').writeFileSync(out, 'terminé'); D.writeResult(0, ['listo de fondo']); }",
    "else D.writeResult(Number(what), ['salí con ' + what]);",
  ].join('\n'));
  const env = labEnv(casa('t39-home'));
  const resultFile = (n) => path.join(dir, `result-${n}.json`);
  // rápido: el hook espera y devuelve el código y las líneas del hijo (así un error temprano sigue cayendo al respaldo)
  const r0 = D.runDetached({ script, args: ['0'], env, resultFile: resultFile(0), waitMs: 10000 });
  assert.deepStrictEqual([r0.detached, r0.code, r0.lines], [false, 0, ['salí con 0']]);
  const r3 = D.runDetached({ script, args: ['3'], env, resultFile: resultFile(3), waitMs: 10000 });
  assert.deepStrictEqual([r3.detached, r3.code], [false, 3]);
  const rt = D.runDetached({ script, args: ['throw'], env, resultFile: resultFile('t'), waitMs: 10000 });
  assert.strictEqual(rt.detached, false);
  assert.notStrictEqual(rt.code, 0, 'un hijo que tira no puede salir 0');
  // un hijo que NI SIQUIERA ARRANCA (el programa no está, justo en un cambio de versión) no es «sigue aparte»: sale ≠ 0
  // a los pocos segundos, para que la línea caiga al respaldo y quede anotado
  const t1 = Date.now();
  const rn = D.runDetached({ script: path.join(dir, 'no-existe.js'), args: [], env, resultFile: resultFile('n'), waitMs: 10000, startWaitMs: 1500 });
  assert.deepStrictEqual([rn.detached, rn.notStarted], [false, true], `un hijo que no arrancó se dio por «sigue aparte»: ${JSON.stringify(rn)}`);
  assert.notStrictEqual(rn.code, 0);
  assert.match(rn.lines.join(' '), /no arrancó/);
  assert.ok(Date.now() - t1 < 5000, 'esperó el tope entero por un hijo que no arrancó');
  // y un hijo LENTO para arrancar que se da por no arrancado se corta: no queda actualizando a la vez que el respaldo en
  // shell
  const slowStart = path.join(dir, 'slow-start.js');
  const slowOut = path.join(dir, 'slow-start.txt');
  fs.writeFileSync(slowStart, `const t = Date.now() + 2500; while (Date.now() < t) { /* Node frío, antivirus */ }
require(${JSON.stringify(path.join(MODULES, 'detach.js'))}).adoptDetachedRun();
require('fs').writeFileSync(${JSON.stringify(slowOut)}, 'actualicé igual');`);
  const rs = D.runDetached({ script: slowStart, args: [], env, resultFile: resultFile('slow'), waitMs: 10000, startWaitMs: 800 });
  assert.strictEqual(rs.notStarted, true);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500);
  assert.ok(!fs.existsSync(slowOut), 'el hijo que se dio por no arrancado siguió y actualizó a la vez que el respaldo');
  // largo: el hook vuelve a tiempo y el hijo sigue solo, aunque el proceso del hook muera (lo corre un padre que se va)
  const out = path.join(dir, 'done.txt');
  const parent = path.join(dir, 'parent.js');
  fs.writeFileSync(parent, `const D = require(${JSON.stringify(path.join(MODULES, 'detach.js'))});
const r = D.runDetached({ script: ${JSON.stringify(script)}, args: ['sleep', ${JSON.stringify(out)}], env: process.env, resultFile: ${JSON.stringify(resultFile('s'))}, waitMs: 300 });
process.stdout.write(JSON.stringify(r)); process.exit(0);`);
  const t0 = Date.now();
  const pr = spawnSync(process.execPath, [parent], { encoding: 'utf8', env: Object.assign({}, env), timeout: 15000 });
  const pres = JSON.parse(pr.stdout);
  assert.strictEqual(pres.detached, true, 'el hook no se fue a tiempo');
  assert.strictEqual(pres.code, 0);
  assert.ok(Date.now() - t0 < 2400, `el hook tardó ${Date.now() - t0} ms: esperó al hijo`);
  const until = Date.now() + 8000;
  while (!fs.existsSync(out) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  assert.strictEqual(fs.existsSync(out) && fs.readFileSync(out, 'utf8'), 'terminé', 'la actualización desprendida murió con el hook');
  // el barrido: se lleva sólo los resultados que nadie leyó con más de una hora; lo reciente y lo ajeno quedan
  const sw = fs.mkdtempSync(path.join(BASE, 't39-sweep-'));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const n of ['startup-result.11.json', 'startup-result.12.json.gone', 'startup-result.13.json.started', 'startup-result.14.json.99.tmp']) {
    fs.writeFileSync(path.join(sw, n), 'x'); fs.utimesSync(path.join(sw, n), old, old);
  }
  fs.writeFileSync(path.join(sw, 'startup-result.15.json'), 'x');                          // reciente
  fs.writeFileSync(path.join(sw, 'harness-state.json'), 'x'); fs.utimesSync(path.join(sw, 'harness-state.json'), old, old);   // ajeno
  D.sweep(sw);
  assert.deepStrictEqual(fs.readdirSync(sw).sort(), ['harness-state.json', 'startup-result.15.json'], 'el barrido se llevó de más o de menos');
  // la red del arranque nunca abre un login: ni la terminal ni el gestor de credenciales
  const ne = mod('sources').gitEnv({ PATH: '/x' });
  assert.strictEqual(ne.GIT_TERMINAL_PROMPT, '0');
  assert.strictEqual(ne.GCM_INTERACTIVE, 'never');
});

test('T39b · StartupDetached_WindowsShim_WorkerIsGrandchild_ResultAndStartedFromWorker_AllSpawnsHideWindow', () => {
  // ── En Windows el desprendido no tiene consola y cada git/pwsh/node que lanzara
  // abriría una ventana visible (20 o más por arranque). El relevo: el desprendido lanza al que trabaja SIN desprender y con
  // ventana oculta, y lo espera. Acá se fuerza con TYCON_STARTUP_SHIM=1 (en Windows es lo de siempre).
  const D = mod('detach');
  const dir = fs.mkdtempSync(path.join(BASE, 't39b-'));
  const script = path.join(dir, 'child.js');
  const pidFile = path.join(dir, 'worker.pid');
  fs.writeFileSync(script, [
    "'use strict';",
    `const D = require(${JSON.stringify(path.join(MODULES, 'detach.js'))});`,
    'if (!D.adoptDetachedRun()) throw new Error("no llegó como ejecución desprendida");',
    `if (process.env.${'TYCON_STARTUP_WORKER'}) throw new Error('la marca del relevo quedó en el ambiente');`,
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid) + ' ' + String(process.ppid));`,
    "D.writeResult(0, ['trabajé detrás del relevo']);",
  ].join('\n'));
  const env = Object.assign({}, labEnv(casa('t39b-home')), { TYCON_STARTUP_SHIM: '1' });
  const resultFile = path.join(dir, 'result.json');
  const r = D.runDetached({ script, args: [], env, resultFile, waitMs: 10000 });
  assert.deepStrictEqual([r.detached, r.code, r.lines], [false, 0, ['trabajé detrás del relevo']], JSON.stringify(r));
  const [workerPid, workerPpid] = fs.readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
  assert.notStrictEqual(workerPid, r.pid, 'el que trabajó es el desprendido mismo: no hubo relevo');
  assert.strictEqual(workerPpid, r.pid, 'el que trabajó no es hijo del desprendido (el relevo tiene que esperarlo)');
  // con el relevo apagado, el desprendido trabaja él mismo (sin relevo)
  const env0 = Object.assign({}, env, { TYCON_STARTUP_SHIM: '0' });
  fs.rmSync(pidFile, { force: true });
  const r0 = D.runDetached({ script, args: [], env: env0, resultFile: path.join(dir, 'result0.json'), waitMs: 10000 });
  assert.strictEqual(r0.code, 0);
  assert.strictEqual(Number(fs.readFileSync(pidFile, 'utf8').split(' ')[0]), r0.pid, 'con SHIM=0 tenía que trabajar el desprendido mismo');
  assert.strictEqual(D.wantsShim({ TYCON_STARTUP_SHIM: '1' }), true);
  assert.strictEqual(D.wantsShim({ TYCON_STARTUP_SHIM: '0' }), false);
  assert.strictEqual(D.wantsShim({}), process.platform === 'win32');
  // la red: TODO lo que el programa lanza pide la ventana oculta (una llamada futura sin la opción vuelve a abrir una)
  const files = [path.join(MODULES, '..', 'harness.js'), ...fs.readdirSync(MODULES).filter((f) => f.endsWith('.js')).map((f) => path.join(MODULES, f))];
  const sinHide = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const re = /(?<![\w.])(?:spawnSync|spawn|execFileSync|execFile|execSync)\(/g;   // (`regex.exec(` no es un proceso)
    let m;
    while ((m = re.exec(text))) {
      // la llamada entera: desde el paréntesis hasta el que lo cierra (profundidad)
      let depth = 0, i = m.index + m[0].length - 1;
      for (; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')') { depth--; if (!depth) break; } }
      const call = text.slice(m.index, i + 1);
      const line = text.slice(0, m.index).split('\n').length;
      const lineText = text.split('\n')[line - 1];
      if (/^\s*(\/\/|\*)/.test(lineText)) continue;   // un comentario que nombra la función
      if (!optionsHideWindow(call)) sinHide.push(`${path.relative(MODULES, f)}:${line}`);
    }
  }
  assert.deepStrictEqual(sinHide, [], `llamadas que lanzan procesos sin windowsHide: true EN SUS OPCIONES (en Windows abren una ventana desde el arranque desprendido)`);
  // el escáner mira las opciones, no el texto: uno dentro de `env: Object.assign(...)` no vale (pasó en la primera edición)
  assert.strictEqual(optionsHideWindow("spawnSync('git', ['x'], { windowsHide: true, env })"), true);
  assert.strictEqual(optionsHideWindow("spawnSync('git', ['x'], { env: Object.assign({}, env, { windowsHide: true }) })"), false);
  assert.strictEqual(optionsHideWindow("spawnSync('git', ['x'])"), false);
});

/** ¿La llamada pide windowsHide: true en su objeto de opciones (el último argumento, al primer nivel de llaves)? */
function optionsHideWindow(call) {
  const inner = call.slice(call.indexOf('(') + 1, call.lastIndexOf(')'));
  // el último argumento al nivel 0 de paréntesis/corchetes/llaves
  let depth = 0, start = 0, last = null, quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { last = inner.slice(start, i); start = i + 1; }
  }
  last = inner.slice(start).trim();
  if (!last.startsWith('{')) return false;
  // windowsHide: true al nivel 1 de ESE objeto (no dentro de otro objeto anidado)
  depth = 0; quote = null;
  for (let i = 0; i < last.length; i++) {
    const ch = last[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (depth === 1 && /^windowsHide\s*:\s*true/.test(last.slice(i))) return true;
  }
  return false;
}

test('T3b · CodexHooksHealth_TreeBehindSymlinkAndSpace_BrokenHookFails_UnknownCommandsWarn', () => {
  // ── La comprobación de salud de los hooks de Codex
  // reconoce «los del árbol» sin comparar texto con `state.tree`; hooks.json lleva la ruta RESUELTA (realpath) y, con la
  // HOME o ~/.tycon detrás de un enlace, o con un espacio en la ruta, la comparación de texto no reconocería ninguno y pasaría en silencio.
  const H = mod('health');
  const base = fs.mkdtempSync(path.join(BASE, 't3b-'));
  const real = path.join(base, 'mi arbol');            // con espacio, como «Nombre Apellido» en Windows
  fs.mkdirSync(path.join(real, 'scripts', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(real, 'scripts', 'hooks', 'sano.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(real, 'scripts', 'hooks', 'roto.js'), 'this is not javascript (\n');
  const link = path.join(base, 'enlace');
  fs.symlinkSync(real, link);                            // el estado nombra el árbol por el enlace
  const realResolved = fs.realpathSync(real);            // hooks.json lleva la ruta resuelta, como la escribe el desplegador
  const hooksJson = path.join(base, 'hooks.json');
  const cmd = (f) => `node "${realResolved}/scripts/hooks/${f}"`;
  fs.writeFileSync(hooksJson, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: cmd('sano.js') }, { type: 'command', command: cmd('roto.js') }, { type: 'command', command: cmd('no-esta.js') }] }] } }, null, 1));
  const r = H.check({ home: base, env: labEnv(casa('t3b-home')), platform: process.platform }, { tree: link, report: [], applierOut: '', harnessJs: null, codexHooks: hooksJson, noGit: true, skillsDir: path.join(base, 'skills') });
  const codex = r.failures.filter((f) => /hook de Codex/.test(f));
  assert.ok(codex.some((f) => /roto\.js/.test(f) && /node --check/.test(f)), `el hook roto tenía que fallar: ${JSON.stringify(r.failures)}`);
  assert.ok(codex.some((f) => /no-esta\.js/.test(f) && /no está/.test(f)), `el hook sin archivo tenía que fallar: ${JSON.stringify(r.failures)}`);
  assert.ok(!codex.some((f) => /sano\.js/.test(f)), 'el hook sano no falla');
  // comandos que parecen del arnés y no son de este árbol: se avisa, nunca «todo bien» por no haber mirado
  const otro = path.join(base, 'otro-hooks.json');
  fs.writeFileSync(otro, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /otra/casa/scripts/hooks/x.js' }] }] } }));
  const r2 = H.check({ home: base, env: labEnv(casa('t3b-home2')), platform: process.platform }, { tree: link, report: [], applierOut: '', harnessJs: null, codexHooks: otro, noGit: true, skillsDir: path.join(base, 'skills') });
  assert.ok(r2.warnings.some((w) => /hooks de Codex/.test(w) && /no reconocí/.test(w)), `tenía que avisar que no reconoció ninguno: ${JSON.stringify(r2.warnings)}`);
  assert.strictEqual(r2.failures.filter((f) => /hook de Codex/.test(f)).length, 0);
});

test('T40 · CannotUpdateSince_RecordedByWhoCouldNot_ClearedOnSuccess_SaidFromSecondStart', () => {
  const R = mod('report');
  const home = casa('t40');
  assert.strictEqual(R.readUpdateFailure(home), null);
  R.recordUpdateFailure(home, 'otra sesión tiene el candado (pid 4242, vive)', { now: Date.parse('2026-10-06T10:00:00Z') });
  const one = R.readUpdateFailure(home);
  assert.deepStrictEqual([one.since, one.count, one.reason], ['2026-10-06T10:00:00.000Z', 1, 'otra sesión tiene el candado (pid 4242, vive)']);
  assert.strictEqual(R.updateFailureText(one), null, 'avisa desde el primer arranque fallido (el AC pide desde el segundo)');
  R.recordUpdateFailure(home, 'sin red', { now: Date.parse('2026-10-06T11:00:00Z') });
  const two = R.readUpdateFailure(home);
  assert.deepStrictEqual([two.since, two.count, two.reason], ['2026-10-06T10:00:00.000Z', 2, 'sin red'], 'el «desde» no es el del primer fallo');
  assert.match(R.updateFailureText(two), /no se pudo actualizar desde 2026-10-06.*: sin red/);
  R.clearUpdateFailure(home);
  assert.strictEqual(R.readUpdateFailure(home), null, 'una actualización sana no borró la falla');
  // un archivo roto no tira: se lee como «no sé» y el aviso lo dice
  fs.writeFileSync(mod('state').paths(home).failuresFile, '{roto');
  assert.match(R.updateFailureText(R.readUpdateFailure(home)), /no pude leer/);
  // dos clases: un candado ocupado se borra con cualquier arranque sano que tuvo el candado; lo
  // que es de mirar la red (sin red, sin credencial) sólo con una mirada sana
  R.clearUpdateFailure(home);
  R.recordUpdateFailure(home, 'otra sesión tiene el candado hace 7 min', { kind: 'busy' });
  R.recordUpdateFailure(home, 'otra sesión tiene el candado hace 8 min', { kind: 'busy' });
  R.clearUpdateFailure(home, { kind: 'busy' });
  assert.strictEqual(R.readUpdateFailure(home), null, 'un arranque sano con el candado no borró la falla del candado');
  R.recordUpdateFailure(home, 'sin red');
  R.recordUpdateFailure(home, 'sin red');
  R.clearUpdateFailure(home, { kind: 'busy' });
  assert.strictEqual(R.readUpdateFailure(home).count, 2, 'un arranque que no miró la red borró «sin red»');
  // un choque normal de dos sesiones (candado reciente de un dueño vivo) no es una falla: no se anota
  assert.strictEqual(R.busyIsFailure({ ageMs: 30 * 1000 }), false);
  assert.strictEqual(R.busyIsFailure({ ageMs: 6 * 60 * 1000 }), true);
  // y el aviso síncrono de cada sesión lo lleva a la conversación
  R.clearUpdateFailure(home);
  R.recordUpdateFailure(home, 'sin red', { now: Date.parse('2026-10-06T10:00:00Z') });
  R.recordUpdateFailure(home, 'sin red', { now: Date.parse('2026-10-06T11:00:00Z') });
  const notice = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'hooks', 'branch-guard-notice.js')], { encoding: 'utf8', input: '{}', env: labEnv(home), timeout: 30000 });
  assert.match(notice.stdout + notice.stderr, /no se pudo actualizar desde 2026-10-06/, `el aviso de arranque no lo dice:\n${notice.stdout}${notice.stderr}`);
});

// ─── la red: nada de esta suite tocó la casa real (va último) ──────────────────────────────────────────────────────

test('RealHome_Untouched · ningún caso ni proceso lanzado intentó escribir o borrar en la casa real', () => {
  assert.strictEqual(GUARD.attempts().length, 0, `esta suite intentó tocar la casa real (frenado):\n${GUARD.describe()}`);
});
