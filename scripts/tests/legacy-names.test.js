'use strict';

/**
 * legacy-names.test.js — el mapa de renombres y la biblioteca que hace que un nombre viejo siga andando (story 8.9,
 * tanda A2 · 2026-09-30). T16-T23 y T25; la parte bash de T17 y T19, y T26-T27, están en legacy-names-install.test.sh;
 * T24, en exportador-real.test.sh. Story 8.12, tanda R1 (2026-10-01): T1 (los `callers` de cada entrada R contra la
 * medición, y un .yml que nombran sólo Azure DevOps, las guías y su repo), T2 (el `require` y el .ps1 que cambian de
 * carpeta) y T9 (el `role` de los hooks y su sufijo).
 *
 * Lo que no se puede perder:
 *   · Un mapa malo (repetido, un nombre nuevo en castellano, uno que choca, un valor sin su script, un archivo que
 *     llaman de afuera sin su reemplazo) es «no pude mirar» (2), nunca un verde.
 *   · Con el nombre viejo, el script hace lo mismo que con el nuevo y no imprime nada; un interruptor de apagado con el
 *     nombre viejo sigue apagando.
 *   · Un reemplazo es invisible: mismo resultado, mismo código, `require.main` y `argv[1]` del nuevo; y los controles
 *     que exigen casos o paridad no se lo exigen a él.
 *   · El registro de usos: una línea por nombre, script y día, sin valores ni rutas de la máquina, aunque lean mil
 *     veces dos procesos a la vez; en Azure DevOps, además, un warning en la corrida.
 *   · Un archivo de configuración con dos nombres y dos contenidos es un error; uno de estado, gana el nuevo; la
 *     primera escritura lleva lo viejo.
 *   · Todo `require` de un archivo que se copia a /opt con el freno de producción está en la lista de lo que se copia.
 *
 * Los nombres castellanos de los ejemplos se arman por concatenación: esta prueba sale en la copia pública y el freno
 * de nombres en castellano la mira como a cualquier ejecutable (AC 7). En los archivos del laboratorio van literales.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const LIB = path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js');
const SPANISH = path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js');
const lib = () => require(LIB);

// palabras castellanas de los ejemplos, armadas para que el freno no las vea como nombres de esta prueba
const W = { bajar: 'baj' + 'ar', copia: 'co' + 'pia', sin: 'si' + 'n', vieja: 'vie' + 'ja', viejo: 'vie' + 'jo', limpiar: 'limp' + 'iar', todo: 'to' + 'do', nucleo: 'nuc' + 'leo', paquete: 'paqu' + 'ete', motivo: 'moti' + 'vo', datos: 'dat' + 'os' };
const OLD_ENV = 'TYCON_NO_' + W.bajar.toUpperCase();
const NEW_ENV = 'TYCON_NO_DOWNLOAD_LAB';
const OLD_OPT = W.sin + '-' + W.copia;          // la opción vieja, sin los guiones
const NEW_OPT = 'no-copy';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), `legacy-${prefix}-`)); }
function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}
function envWith(extra) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_') && k !== 'TF_BUILD') e[k] = v;
  return { ...e, ...extra };
}
const mapOf = (entries, extra = {}) => ({ __about: 'mapa de laboratorio', retire_after: null, entries, ...extra });

// ── T16 · el validador del mapa ─────────────────────────────────────────────────────────────────────────────────
test('T16 LegacyNames_CheckMap_RejectsBadEntries', () => {
  const repo = tmp('checkmap');
  const carpeta = 'carp' + 'eta';
  write(repo, {
    'scripts/lab/new-tool.js': '#!/usr/bin/env node\nconsole.log(1)\n',
    'scripts/lab/taken.js': '#!/usr/bin/env node\nconsole.log(2)\n',
    'scripts/lab/other-tool.js': '#!/usr/bin/env node\nconsole.log(4)\n',
    [`scripts/lab/${W.viejo}.js`]: '#!/usr/bin/env node\nconsole.log(3)\n',
    // estructura destino (§4): a otra carpeta, a una carpeta anidada que todavía no existe, una guía, un yml
    'scripts/tools/cross-tool.js': '#!/usr/bin/env node\nconsole.log(5)\n',
    [`scripts/${carpeta}/a.js`]: '#!/usr/bin/env node\nconsole.log(6)\n',
    'scripts/nightly/lab-board/tool.js': '#!/usr/bin/env node\nconsole.log(7)\n',
    'guides/decisions/lab-guide.md': '# Guía de laboratorio\n',
    'pipelines/azure-pipelines-lab.yml': 'trigger: none\n',
  });
  const run = (map, extra = [], env = {}) => {
    const f = path.join(repo, `map-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, typeof map === 'string' ? map : JSON.stringify(map));
    return spawnSync(process.execPath, [SPANISH, '--check-map', '--map', f, '--repo', repo, ...extra], { encoding: 'utf8', env: envWith(env) });
  };
  const goodEntries = [
    { kind: 'env', old: OLD_ENV, new: NEW_ENV, batch: 'lab' },
    { kind: 'option', old: OLD_OPT, new: NEW_OPT, where: 'scripts/lab/new-tool.js', batch: 'lab' },
    { kind: 'file', old: `scripts/lab/${W.viejo}-cross.js`, new: 'scripts/tools/cross-tool.js', batch: 'lab', callers: ['machine'] },
    { kind: 'folder', old: `scripts/${carpeta}`, new: 'scripts/nightly/lab-dashboard', batch: 'lab', callers: ['machine'] },
    { kind: 'folder', old: `scripts/${carpeta}-dos`, new: 'scripts/nightly/lab-board', batch: 'lab', callers: ['machine'] },
    { kind: 'file', old: `scripts/${carpeta}-dos/tool.js`, new: 'scripts/nightly/lab-board/tool.js', batch: 'lab', callers: ['machine'] },
    { kind: 'file', old: `guides/${W.vieja}-guia.md`, new: 'guides/decisions/lab-guide.md', batch: 'lab', callers: ['docs'] },
    { kind: 'file', old: `azure-pipelines-${W.viejo}.yml`, new: 'pipelines/azure-pipelines-lab.yml', batch: 'lab', callers: ['ado'] },
    { kind: 'config-file', old: `~/.claude/${W.viejo}.json`, new: '~/.claude/lab-config.json', batch: 'lab' },
  ];
  const goodMap = path.join(repo, 'good-map.json');
  fs.writeFileSync(goodMap, JSON.stringify(mapOf(goodEntries)));
  const shims = spawnSync(process.execPath, [LIB, '--write-shims', '--map', goodMap, '--root', repo], { encoding: 'utf8', env: envWith({ HOME: repo }) });
  assert.strictEqual(shims.status, 0, `los reemplazos se generan (la entrada todavía no movida y la de Azure no llevan): ${shims.stderr}`);
  assert.ok(!fs.existsSync(path.join(repo, `azure-pipelines-${W.viejo}.yml`)), 'callers ado: sin reemplazo');
  assert.ok(fs.existsSync(path.join(repo, `scripts/${carpeta}-dos/tool.js`)), 'la carpeta vieja se recreó para el reemplazo');
  const good = run(mapOf(goodEntries));
  assert.strictEqual(good.status, 0, `un mapa sano pasa (otra carpeta, destino anidado sin crear, carpeta con sólo reemplazos, guía .md, yml de Azure): ${good.stderr}`);
  // el mensaje nombra el mapa de verdad, no la copia temporal del índice que le pasa el pre-commit
  const named = run(mapOf([{ kind: 'value', old: W.nucleo, new: 'core', batch: 'lab' }]), ['--map-name', 'scripts/lib/renames.json']);
  assert.strictEqual(named.status, 2);
  assert.match(named.stderr, /scripts\/lib\/renames\.json/);
  assert.doesNotMatch(named.stderr, /map-[a-z0-9]+\.json/, 'no nombra la copia temporal');
  const broken = run('{ esto no es json');
  assert.strictEqual(broken.status, 2, 'un mapa ilegible es «no pude mirar»');
  assert.match(broken.stderr, /no es JSON válido/);
  const noSkills = run(mapOf([{ kind: 'file', old: 'skills/lab/scripts/on-x.js', new: 'skills/lab/scripts/on-y.js', batch: 'lab', callers: ['machine'], repo: 'agent-skills' }]),
    [], { TYCON_SKILLS_DIR: path.join(repo, 'no-existe', 'skills') });
  assert.strictEqual(noSkills.status, 2, `una entrada de agent-skills sin agent-skills en la máquina es «no pude mirar»: ${noSkills.stderr}`);

  const stale = `scripts/lab/${W.viejo}-stale.js`;
  write(repo, { [stale]: '#!/usr/bin/env node\n// tycon-legacy-shim: scripts/lab/other-tool.js\n' });
  const cases = {
    'reemplazo que apunta a otro archivo': [{ kind: 'file', old: stale, new: 'scripts/lab/new-tool.js', batch: 'lab', callers: ['machine'] }],
    'yml llamado de afuera, sin forma de reemplazo': [
      { kind: 'file', old: `azure-pipelines-${W.viejo}-2.yml`, new: 'pipelines/azure-pipelines-lab.yml', batch: 'lab', callers: ['machine'] },
    ],
    'ni el viejo ni el nuevo existen': [{ kind: 'file', old: `scripts/lab/${W.viejo}-nada.js`, new: 'scripts/lab/nothing.js', batch: 'lab', callers: ['same-repo'] }],
    'ruta con ..': [{ kind: 'file', old: 'scripts/../escape.js', new: 'scripts/lab/new-tool.js', batch: 'lab', callers: ['same-repo'] }],
    'ruta absoluta': [{ kind: 'file', old: '/etc/escape.js', new: 'scripts/lab/new-tool.js', batch: 'lab', callers: ['same-repo'] }],
    'ruta con ./': [{ kind: 'file', old: './scripts/lab/x.js', new: 'scripts/lab/new-tool.js', batch: 'lab', callers: ['same-repo'] }],
    'ruta con caracteres que no son de ruta': [{ kind: 'file', old: 'scripts/lab/a"b;c.js', new: 'scripts/lab/new-tool.js', batch: 'lab', callers: ['same-repo'] }],
    'carpeta con barra final': [{ kind: 'folder', old: `scripts/${carpeta}/`, new: 'scripts/nightly/lab-dashboard', batch: 'lab', callers: ['machine'] }],
    'config-file que sale de la HOME': [{ kind: 'config-file', old: '~/../escape.json', new: '~/.claude/lab-config.json', batch: 'lab' }],
    'opción escrita con --': [{ kind: 'option', old: `--${OLD_OPT}`, new: NEW_OPT, where: 'scripts/lab/new-tool.js', batch: 'lab' }],
    'campo desconocido en una entrada': [{ kind: 'option', old: 'x-lab', new: 'y-lab', where: 'scripts/lab/new-tool.js', batch: 'lab', ['repe' + 'table']: true }],
    'variable repetida con otro repo': [
      { kind: 'env', old: OLD_ENV, new: NEW_ENV, batch: 'lab' },
      { kind: 'env', old: 'TYCON_LAB_OTHER', new: NEW_ENV, batch: 'lab', repo: 'agent-skills' },
    ],
  };
  const r0 = run(mapOf([], { retire_after: '2026-13-45' }));
  assert.strictEqual(r0.status, 2, `una fecha de retiro que no existe sale 2: ${r0.stderr}`);
  assert.match(r0.stderr, /retire_after tiene que ser una fecha AAAA-MM-DD que exista/, 'y lo dice por la fecha, no por otra cosa');
  const r1 = run(mapOf([], { retire_after: '2026-12-01' }));
  assert.strictEqual(r1.status, 0, `una fecha de retiro real pasa: ${r1.stderr}`);
  for (const [name, entries] of Object.entries(cases)) {
    const r = run(mapOf(entries));
    assert.strictEqual(r.status, 2, `${name}: sale 2 (salió ${r.status}: ${r.stderr})`);
    assert.match(r.stderr, /renames|mapa/i, `${name}: el mensaje nombra el mapa`);
  }
  const cases0 = {
    'old repetido en el mismo kind y where': [
      { kind: 'env', old: OLD_ENV, new: NEW_ENV, batch: 'lab' },
      { kind: 'env', old: OLD_ENV, new: 'TYCON_OTHER_LAB', batch: 'lab' },
    ],
    'new en castellano': [{ kind: 'env', old: 'TYCON_LAB_OLD', new: 'TYCON_' + W.limpiar.toUpperCase() + '_' + W.todo.toUpperCase(), batch: 'lab' }],
    'new que choca con un archivo que existe': [
      { kind: 'file', old: `scripts/lab/${W.viejo}.js`, new: 'scripts/lab/taken.js', batch: 'lab', callers: ['same-repo'] },
    ],
    'value sin where': [{ kind: 'value', old: W.nucleo, new: 'core', batch: 'lab' }],
    'file externo sin reemplazo': [
      { kind: 'file', old: `scripts/lab/${W.viejo}-gone.js`, new: 'scripts/lab/new-tool.js', batch: 'lab', callers: ['machine'] },
    ],
  };
  for (const [name, entries] of Object.entries(cases0)) {
    const r = run(mapOf(entries));
    assert.strictEqual(r.status, 2, `${name}: sale 2 (salió ${r.status}: ${r.stderr})`);
    assert.match(r.stderr, /renames|mapa/i, `${name}: el mensaje nombra el mapa`);
  }
});

// ── TEST-W4 · un mapa ilegible en tiempo de ejecución: paso directo, avisado una vez ────────────────────────────
test('LegacyNames_BrokenMap_PassThroughWarnsOnce', () => {
  const dir = tmp('broken-runtime');
  write(dir, { 'renames.json': '{ esto no es json' });
  const code = `const l=require(${JSON.stringify(LIB)});
    process.stdout.write(JSON.stringify([l.readEnv(${JSON.stringify(NEW_ENV)}), l.aliasOptions(['--${OLD_OPT}'], 'scripts/lab/x.js'), l.readEnv(${JSON.stringify(NEW_ENV)})]));`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: envWith({ HOME: dir, TYCON_LEGACY_NAMES_MAP: path.join(dir, 'renames.json'), [NEW_ENV]: 'n' }) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), ['n', [`--${OLD_OPT}`], 'n'], 'paso directo');
  assert.strictEqual((r.stderr.match(/no se deja leer/g) || []).length, 1, `avisa una sola vez: ${r.stderr}`);
});

// ── Tanda C4 (revisor de fallos silenciosos): un mapa que no se puede MIRAR no es un mapa que no está ────────────────
// Sin mapa (no existe) no se dice nada: es la copia pública. Pero un permiso denegado sobre su carpeta se leía igual que
// «no hay mapa», sin aviso, y los frenos que buscan la configuración de una foto vieja por el mapa la daban por ausente.
test('LegacyNames_UnreadableMap_WarnsNotSilent', { skip: process.getuid && process.getuid() === 0 && 'como root el permiso no se niega' }, () => {
  const dir = tmp('unreadable-map');
  write(dir, { 'locked/renames.json': JSON.stringify({ entries: [] }) });
  const code = `const l=require(${JSON.stringify(LIB)}); process.stdout.write(JSON.stringify(l.loadMap()));`;
  const run = (map) => spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: envWith({ HOME: dir, TYCON_LEGACY_NAMES_MAP: map }) });
  const missing = run(path.join(dir, 'no-existe', 'renames.json'));
  assert.strictEqual(missing.status, 0, missing.stderr);
  assert.strictEqual(missing.stdout, 'null');
  assert.strictEqual(missing.stderr, '', 'sin mapa no se avisa nada');
  fs.chmodSync(path.join(dir, 'locked'), 0o000);
  try {
    const locked = run(path.join(dir, 'locked', 'renames.json'));
    assert.strictEqual(locked.status, 0, `paso directo: ${locked.stderr}`);
    assert.strictEqual(locked.stdout, 'null', 'paso directo: sin mapa en tiempo de ejecución');
    assert.match(locked.stderr, /no se deja leer/, `un permiso denegado se avisa: ${locked.stderr}`);
  } finally {
    fs.chmodSync(path.join(dir, 'locked'), 0o755);
  }
});

// ── Tanda C4 (pase adversarial): la basura del sistema no hace «real» una carpeta mudada ─────────────────────────────
// Una carpeta vieja con sólo reemplazos está mudada. Un `.DS_Store` que macOS deja al abrirla en el Finder (git lo ignora)
// la volvía «real» y el control de nombres viejos y el instalador dejaban de verla mudada, en silencio.
test('LegacyNames_OsJunkInOldFolder_StillMoved', () => {
  const root = tmp('junk-folder');
  write(root, { 'new-dir/tool.js': '// real\n' });
  fs.mkdirSync(path.join(root, 'old-dir'), { recursive: true });
  const L = require(LIB);
  const e = { kind: 'folder', old: 'old-dir', new: 'new-dir' };
  assert.strictEqual(L.isMoved(e, root), true, 'carpeta vieja vacía: mudada');
  for (const junk of ['.DS_Store', '._tool.js', 'Thumbs.db', 'desktop.ini']) fs.writeFileSync(path.join(root, 'old-dir', junk), 'x');
  assert.strictEqual(L.isMoved(e, root), true, 'con basura del sistema: sigue mudada');
  fs.writeFileSync(path.join(root, 'old-dir', 'other.js'), '// real\n');
  assert.strictEqual(L.isMoved(e, root), false, 'con un archivo de verdad: no está mudada');
});

// ── T17 · readEnv (JS) ───────────────────────────────────────────────────────────────────────────────────────────
test('T17 LegacyNames_Env_Js', () => {
  const home = tmp('env-home');
  const map = mapOf([{ kind: 'env', old: OLD_ENV, new: NEW_ENV, batch: 'lab' }]);
  const { readEnv } = lib();
  const opts = (env) => ({ env, map, where: 'scripts/lab/x.js', home });
  assert.strictEqual(readEnv(NEW_ENV, opts({ [OLD_ENV]: '1' })), '1', 'sólo la vieja → su valor');
  assert.strictEqual(readEnv(NEW_ENV, opts({ [OLD_ENV]: '1', [NEW_ENV]: '1' })), '1', 'las dos iguales → el valor');
  assert.strictEqual(readEnv(NEW_ENV, opts({ [OLD_ENV]: '0', [NEW_ENV]: '1' })), '1', 'distintas → gana la nueva');
  assert.strictEqual(readEnv(NEW_ENV, opts({})), undefined, 'ninguna → undefined');
  assert.strictEqual(readEnv('TYCON_UNMAPPED_LAB', opts({ TYCON_UNMAPPED_LAB: 'x' })), 'x', 'una variable sin entrada se lee directo');
  const log = fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'legacy-names.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((l) => l.conflict === true), 'la diferencia se anota como conflict');
  // nada impreso: lo prueba el proceso aparte
  const r = spawnSync(process.execPath, ['-e', `const l=require(${JSON.stringify(LIB)});process.stdout.write(String(l.readEnv(${JSON.stringify(NEW_ENV)},{map:${JSON.stringify(map)}})))`],
    { encoding: 'utf8', env: envWith({ HOME: home, [OLD_ENV]: '1' }) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '1');
  assert.strictEqual(r.stderr, '', 'no imprime nada');
});

// ── T18 · un interruptor de apagado con el nombre viejo sigue apagando ───────────────────────────────────────────
test('T18 LegacyNames_KillSwitchOldNameStillDisables', () => {
  const dir = tmp('killswitch');
  const map = path.join(dir, 'renames.json');
  write(dir, {
    'renames.json': mapOf([{ kind: 'env', old: OLD_ENV, new: NEW_ENV, batch: 'lab' }]),
    'tool.js': `const { readEnv } = require(${JSON.stringify(LIB)});\nif (readEnv(${JSON.stringify(NEW_ENV)}) === '1') process.exit(0);\nconsole.log('ACTION');\n`,
  });
  const base = { HOME: dir, TYCON_LEGACY_NAMES_MAP: map };
  const on = spawnSync(process.execPath, [path.join(dir, 'tool.js')], { encoding: 'utf8', env: envWith(base) });
  assert.match(on.stdout, /ACTION/, 'sin interruptor, hace la acción');
  const offOld = spawnSync(process.execPath, [path.join(dir, 'tool.js')], { encoding: 'utf8', env: envWith({ ...base, [OLD_ENV]: '1' }) });
  assert.doesNotMatch(offOld.stdout, /ACTION/, 'con el nombre viejo en 1, no la hace');
  assert.strictEqual(offOld.stderr, '');
});

// ── T19 · aliasOptions (JS) ──────────────────────────────────────────────────────────────────────────────────────
test('T19 LegacyNames_Options_Js', () => {
  const where = 'scripts/lab/tool.js';
  const map = mapOf([
    { kind: 'option', old: OLD_OPT, new: NEW_OPT, where, batch: 'lab' },
    { kind: 'option', old: W.motivo, new: 'reason', where, batch: 'lab', repeatable: true },
    { kind: 'subcommand', old: W.limpiar, new: 'clean', where, batch: 'lab' },
    { kind: 'value', old: W.nucleo, new: 'core', where, batch: 'lab' },
  ]);
  const home = tmp('opts-home');
  const { aliasOptions, LegacyNamesError } = lib();
  const a = (argv) => aliasOptions(argv, where, { map, home });
  assert.deepStrictEqual(a([`--${OLD_OPT}`, 'x']), [`--${NEW_OPT}`, 'x'], 'la opción vieja pasa a la nueva');
  assert.deepStrictEqual(a([`--${OLD_OPT}=1`]), [`--${NEW_OPT}=1`], 'también con =');
  assert.deepStrictEqual(a([W.limpiar, '--package', W.nucleo]), ['clean', '--package', 'core'], 'subcomando y valor');
  assert.deepStrictEqual(a(['clean', '--package', 'core']), ['clean', '--package', 'core'], 'lo nuevo no cambia');
  assert.deepStrictEqual(a(['--other', W.limpiar]), ['--other', W.limpiar], 'un subcomando viejo sólo cuenta en el primer lugar');
  assert.deepStrictEqual(a([`--${W.motivo}`, 'a', '--reason', 'b']), ['--reason', 'a', '--reason', 'b'], 'una opción repetible admite las dos');
  assert.throws(() => a([`--${OLD_OPT}`, `--${NEW_OPT}`]), (e) => e instanceof LegacyNamesError && /la misma opción dos veces/.test(e.message), 'viejo y nuevo de una que no se repite: error de opción');
  assert.deepStrictEqual(aliasOptions([`--${OLD_OPT}`], 'scripts/lab/other.js', { map, home }), [`--${OLD_OPT}`], 'otro script: no toca nada');
  assert.deepStrictEqual(aliasOptions([`--${OLD_OPT}`], where, { map: null, home }), [`--${OLD_OPT}`], 'sin mapa: paso directo');
});

// ── T20 · los reemplazos generados, por extensión ────────────────────────────────────────────────────────────────
test('T20 LegacyNames_Shims_PerExtension', () => {
  const repo = tmp('shims');
  write(repo, {
    'scripts/lab/new-tool.js': [
      '#!/usr/bin/env node',
      "'use strict';",
      "const path = require('path');",
      'if (require.main === module) {',
      "  let input = ''; try { input = require('fs').readFileSync(0, 'utf8'); } catch {}",
      '  console.log(JSON.stringify({ main: require.main === module, argv1: path.basename(process.argv[1]), args: process.argv.slice(2), input, lab: process.env.LAB_VALUE }));',
      '  process.exit(7);',
      '}',
      'module.exports = { answer: 42 };',
      '',
    ].join('\n'),
    'scripts/lab/new-tool.sh': '#!/usr/bin/env bash\necho "sh:$(basename "$0"):$*"\nexit 5\n',
    'scripts/lab/new-tool.command': '#!/usr/bin/env bash\necho "cmd:$(basename "$0"):$*"\nexit 4\n',
    'scripts/lab/new-tool': '#!/bin/sh\necho "bare:$(basename "$0"):$*"\nexit 3\n',
  });
  for (const f of ['new-tool.sh', 'new-tool.command', 'new-tool']) fs.chmodSync(path.join(repo, 'scripts/lab', f), 0o755);
  const oldBase = `scripts/lab/${W.viejo}`;
  const map = path.join(repo, 'renames.json');
  write(repo, {
    'renames.json': mapOf([
      { kind: 'file', old: `${oldBase}.js`, new: 'scripts/lab/new-tool.js', batch: 'lab', callers: ['machine'] },
      { kind: 'file', old: `${oldBase}.sh`, new: 'scripts/lab/new-tool.sh', batch: 'lab', callers: ['products'] },
      { kind: 'file', old: `${oldBase}.command`, new: 'scripts/lab/new-tool.command', batch: 'lab', callers: ['docs'] },
      { kind: 'file', old: oldBase, new: 'scripts/lab/new-tool', batch: 'lab', callers: ['other-repo'] },
      { kind: 'file', old: `scripts/lab/${W.datos}.js`, new: 'scripts/lab/internal.js', batch: 'lab', callers: ['same-repo'] },
    ]),
  });
  const gen = spawnSync(process.execPath, [LIB, '--write-shims', '--map', map, '--root', repo], { encoding: 'utf8', env: envWith({ HOME: repo }) });
  assert.strictEqual(gen.status, 0, gen.stderr);
  assert.ok(!fs.existsSync(path.join(repo, `scripts/lab/${W.datos}.js`)), 'un archivo sólo del mismo repo no lleva reemplazo');
  const { isShim } = lib();
  for (const f of [`${oldBase}.js`, `${oldBase}.sh`, `${oldBase}.command`, oldBase]) {
    const text = fs.readFileSync(path.join(repo, f), 'utf8');
    assert.ok(isShim(text), `${f}: marca en la segunda línea`);
    assert.match(text.split('\n')[1], /tycon-legacy-shim: /);
  }
  const env = envWith({ HOME: repo, LAB_VALUE: 'v' });
  const runJs = (rel) => spawnSync(process.execPath, [path.join(repo, rel), 'a', 'b c'], { input: 'IN', encoding: 'utf8', env });
  const nw = runJs('scripts/lab/new-tool.js');
  const old = runJs(`${oldBase}.js`);
  assert.strictEqual(old.status, 7, 'mismo código');
  assert.strictEqual(old.stdout, nw.stdout, 'misma salida');
  assert.strictEqual(old.stderr, '', 'el reemplazo no imprime nada');
  const parsed = JSON.parse(old.stdout);
  assert.strictEqual(parsed.main, true, 'require.main es el del nuevo');
  assert.strictEqual(parsed.argv1, 'new-tool.js', 'argv[1] es el nuevo');
  assert.strictEqual(parsed.input, 'IN', 'la misma entrada');
  assert.strictEqual(parsed.lab, 'v', 'las mismas variables');
  const req = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(path.join(repo, `${oldBase}.js`))}).answer)`], { encoding: 'utf8', env });
  assert.strictEqual(req.stdout.trim(), '42', 'require del viejo devuelve el módulo nuevo');
  for (const [rel, runner] of [[`${oldBase}.sh`, 'bash'], [`${oldBase}.command`, 'bash'], [oldBase, null]]) {
    const target = rel === oldBase ? 'scripts/lab/new-tool' : rel.replace(`${W.viejo}`, 'new-tool');
    const cmd = (r) => (runner ? spawnSync(runner, [path.join(repo, r), 'a', 'b c'], { encoding: 'utf8', env }) : spawnSync(path.join(repo, r), ['a', 'b c'], { encoding: 'utf8', env }));
    fs.chmodSync(path.join(repo, rel), 0o755);
    const n = cmd(target);
    const o = cmd(rel);
    assert.strictEqual(o.status, n.status, `${rel}: mismo código`);
    assert.strictEqual(o.stdout, n.stdout, `${rel}: misma salida`);
    assert.strictEqual(o.stderr, '', `${rel}: no imprime nada`);
  }
  // latencia extra del reemplazo .js (se anota; el techo es generoso: lo que importa es que se mida)
  const time = (rel) => { const t0 = process.hrtime.bigint(); runJs(rel); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const med = (rel) => { const xs = [1, 2, 3, 4, 5].map(() => time(rel)).sort((x, y) => x - y); return xs[2]; };
  const extra = med(`${oldBase}.js`) - med('scripts/lab/new-tool.js');
  console.log(`# latencia extra del reemplazo .js (mediana de 5): ${Math.round(extra)} ms`);
  assert.ok(extra < 1500, `el reemplazo no puede costar más de 1,5 s (costó ${Math.round(extra)} ms)`);
});

// ── T20 (estructura destino y vuelta 1) · otra carpeta, carpeta que desapareció, .ps1, .md, agent-skills, rutas ──
test('T20 LegacyNames_Shims_CrossFolderPs1MdLoggingAndUnsafePaths', () => {
  const repo = tmp('shims2');
  const skills = tmp('shims2-skills');
  const vieja = 'vie' + 'ja';
  write(repo, {
    'scripts/tools/x-tool.js': '#!/usr/bin/env node\nconsole.log("x:" + process.argv.slice(2).join(","));\nprocess.exit(9);\n',
    'scripts/nightly/lab-dash/tool.sh': '#!/usr/bin/env bash\necho "dash:$*"\nexit 8\n',
    'scripts/lab/new-tool.ps1': 'Write-Output ("ps:" + ($args -join ","))\nexit 6\n',
    'guides/decisions/lab-guide.md': '# Guía de laboratorio\n',
  });
  write(skills, { 'skills/lab/new-tool.js': '#!/usr/bin/env node\nconsole.log("skill:" + process.argv.slice(2).join(","));\n',
    'skills/lab/new-tool.sh': '#!/usr/bin/env bash\necho "skill-sh:$*"\n' });
  const entries = [
    { kind: 'file', old: `scripts/${W.viejo}-x.js`, new: 'scripts/tools/x-tool.js', batch: 'lab', callers: ['machine'] },
    { kind: 'file', old: `scripts/${vieja}-dash/tool.sh`, new: 'scripts/nightly/lab-dash/tool.sh', batch: 'lab', callers: ['products'] },
    { kind: 'file', old: `scripts/lab/${W.viejo}.ps1`, new: 'scripts/lab/new-tool.ps1', batch: 'lab', callers: ['machine'] },
    { kind: 'file', old: `guides/${vieja}-guia.md`, new: 'guides/decisions/lab-guide.md', batch: 'lab', callers: ['docs'] },
    { kind: 'file', old: `skills/lab/${W.viejo}.js`, new: 'skills/lab/new-tool.js', batch: 'lab', callers: ['other-repo'], repo: 'agent-skills' },
    { kind: 'file', old: `skills/lab/${W.viejo}.sh`, new: 'skills/lab/new-tool.sh', batch: 'lab', callers: ['other-repo'], repo: 'agent-skills' },
  ];
  write(repo, { 'renames.json': mapOf(entries) });
  const gen = spawnSync(process.execPath, [LIB, '--write-shims', '--map', path.join(repo, 'renames.json'), '--root', repo, '--skills-root', skills],
    { encoding: 'utf8', env: envWith({ HOME: repo }) });
  assert.strictEqual(gen.status, 0, gen.stderr);
  const env = envWith({ HOME: repo });
  // a otra carpeta: la ruta relativa del viejo al nuevo sube y baja de carpeta
  const xs = [`scripts/${W.viejo}-x.js`, 'scripts/tools/x-tool.js'].map((rel) => spawnSync(process.execPath, [path.join(repo, rel), 'a'], { encoding: 'utf8', env }));
  assert.deepStrictEqual([xs[0].status, xs[0].stdout], [xs[1].status, xs[1].stdout], 'a otra carpeta: misma salida y código');
  // bajo una carpeta renombrada que desapareció entera: se recrea para el reemplazo
  assert.ok(fs.existsSync(path.join(repo, `scripts/${vieja}-dash/tool.sh`)), 'la carpeta vieja se recreó');
  const ds = [`scripts/${vieja}-dash/tool.sh`, 'scripts/nightly/lab-dash/tool.sh'].map((rel) => spawnSync('bash', [path.join(repo, rel), 'b'], { encoding: 'utf8', env }));
  assert.deepStrictEqual([ds[0].status, ds[0].stdout], [ds[1].status, ds[1].stdout], 'bajo carpeta renombrada: misma salida y código');
  const { isShim } = lib();
  // .ps1: marca en la segunda línea y el nuevo por ruta relativa; corrido si hay pwsh
  const ps1 = fs.readFileSync(path.join(repo, `scripts/lab/${W.viejo}.ps1`), 'utf8');
  assert.ok(isShim(ps1), '.ps1: marca en la segunda línea');
  assert.match(ps1, /\$legacyTarget = Join-Path \$PSScriptRoot 'new-tool\.ps1'\n/);
  assert.match(ps1, /& \$legacyTarget @args/);
  assert.match(ps1, /exit \$LASTEXITCODE/);
  if (spawnSync('pwsh', ['-v'], { encoding: 'utf8' }).status === 0) {
    const ps = [`scripts/lab/${W.viejo}.ps1`, 'scripts/lab/new-tool.ps1'].map((rel) => spawnSync('pwsh', ['-NoProfile', '-File', path.join(repo, rel), 'c', 'd'], { encoding: 'utf8', env }));
    assert.deepStrictEqual([ps[0].status, ps[0].stdout], [ps[1].status, ps[1].stdout], '.ps1 corrido: misma salida y código');
  }
  // .md: dos líneas, «Movida a …» con el enlace relativo, y la marca
  const md = fs.readFileSync(path.join(repo, `guides/${vieja}-guia.md`), 'utf8').replace(/\n$/, '').split('\n');
  assert.strictEqual(md.length, 2, `.md: dos líneas (${md.length})`);
  assert.match(md[0], /^Movida a .*\(decisions\/lab-guide\.md\)/);
  assert.strictEqual(md[1], '<!-- tycon-legacy-shim: guides/decisions/lab-guide.md -->');
  assert.ok(isShim(md.join('\n')), '.md: la marca se reconoce');
  // agent-skills: el reemplazo encuentra la biblioteca por TYCON_GUIDES_DIR y anota su uso; en CI además avisa
  const home = tmp('shims2-home');
  const envS = envWith({ HOME: home, TYCON_GUIDES_DIR: RAIZ });
  const sj = spawnSync(process.execPath, [path.join(skills, `skills/lab/${W.viejo}.js`), 'e'], { encoding: 'utf8', env: envS });
  assert.strictEqual(sj.stdout, 'skill:e\n');
  const logFile = path.join(home, '.claude', '.tycon-pipeline', 'legacy-names.jsonl');
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
  assert.match(readLog(), new RegExp(`"old":"skills/lab/${W.viejo}\\.js"`), 'el reemplazo .js de agent-skills anota su uso');
  spawnSync('bash', [path.join(skills, `skills/lab/${W.viejo}.sh`), 'f'], { encoding: 'utf8', env: envS });
  const deadline = Date.now() + 5000;
  while (!readLog().includes(`skills/lab/${W.viejo}.sh`) && Date.now() < deadline) spawnSync('sleep', ['0.2']);
  assert.match(readLog(), new RegExp(`"old":"skills/lab/${W.viejo}\\.sh"`), 'el reemplazo .sh de agent-skills anota su uso (de fondo)');
  const ci = spawnSync(process.execPath, [path.join(skills, `skills/lab/${W.viejo}.js`)], { encoding: 'utf8', env: envWith({ HOME: home, TF_BUILD: 'True' }) });
  assert.match(ci.stderr, /##vso\[task\.logissue type=warning\]/, 'en CI avisa aunque no encuentre la biblioteca');
  // rutas inseguras: ni se generan ni escriben fuera de la raíz; el bash generado cita los nombres
  for (const bad of ['../escape.js', 'scripts/lab/a"b;c.sh']) {
    write(repo, { 'bad.json': mapOf([{ kind: 'file', old: bad, new: 'scripts/tools/x-tool.js', batch: 'lab', callers: ['machine'] }]) });
    const r = spawnSync(process.execPath, [LIB, '--write-shims', '--map', path.join(repo, 'bad.json'), '--root', repo], { encoding: 'utf8', env: envWith({ HOME: repo }) });
    assert.strictEqual(r.status, 2, `${bad}: --write-shims sale 2 (${r.stderr})`);
  }
  assert.ok(!fs.existsSync(path.join(path.dirname(repo), 'escape.js')), 'nada se escribió fuera de la raíz');
  const sh = fs.readFileSync(path.join(repo, `scripts/${vieja}-dash/tool.sh`), 'utf8');
  assert.match(sh, new RegExp(`'scripts/${vieja}-dash/tool\\.sh'`), 'los nombres van entre comillas simples en el bash generado');
});

// ── T26 (en JS, vuelta 1 del pase adversarial) · la migración de la máquina en los casos que se escapaban ──────────
test('T26 LegacyNames_MigrateMachine_PermissionsOrderFormsAndBinaryPlist', () => {
  const base = tmp('migrate');
  const G = path.join(base, 'src', 'guides');
  const H = path.join(base, 'casa');
  const vieja = 'vie' + 'ja';
  const otra = 'ot' + 'ra';
  const corridas = 'corri' + 'das';
  write(G, {
    'scripts/nightly/lab-folder/export-tool.js': '//\n',
    'scripts/metrics/runs.js': '//\n',
    'scripts/other-new/y.js': '//\n',
    'scripts/x/other.js': '//\n',
  });
  fs.mkdirSync(path.join(H, '.claude'), { recursive: true });
  fs.symlinkSync(G, path.join(H, '.claude', 'tycon-claude-guides'));
  const map = mapOf([
    { kind: 'folder', old: `scripts/${vieja}`, new: 'scripts/nightly/lab-folder', batch: 'lab', callers: ['machine'] },
    { kind: 'file', old: `scripts/${vieja}/exportar.js`, new: 'scripts/nightly/lab-folder/export-tool.js', batch: 'lab', callers: ['machine'] },
    { kind: 'file', old: `scripts/metrics/${corridas}.js`, new: 'scripts/metrics/runs.js', batch: 'lab', callers: ['machine'] },
    { kind: 'folder', old: `scripts/${otra}/`, new: 'scripts/other-new', batch: 'lab', callers: ['machine'] },
  ]);
  const link = path.join(H, '.claude', 'tycon-claude-guides');
  const settings = {
    hooks: {
      Stop: [{ hooks: [
        { type: 'command', command: `node "${G}/scripts/${vieja}/exportar.js"` },
        { type: 'command', command: `node "$HOME/.claude/tycon-claude-guides/scripts/metrics/${corridas}.js"` },
        { type: 'command', command: `node "${G}/scripts/metrics/runs.js"` },
        { type: 'command', command: `node "${G}/scripts/${otra}/y.js"` },
      ] }],
    },
    permissions: { allow: [
      `Read(/${G}/scripts/metrics/${corridas}.js)`,
      `Edit(/${G}/scripts/${vieja}/**)`,
      `Bash(node ${G}/scripts/x/other.js:*)`,
      `Bash(node ${link}/scripts/x/other.js:*)`,
      'Bash(git status:*)', 'Bash(git status:*)',
    ] },
  };
  write(H, { '.claude/settings.json': settings });
  const agents = path.join(H, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  const bin = Buffer.concat([Buffer.from('bplist00'), Buffer.from([0x5f, 0x10, 0x7b]), Buffer.from(`${G}/scripts/metrics/${corridas}.js`), Buffer.from([0, 1, 2])]);
  fs.writeFileSync(path.join(agents, 'lab.legacy-names.binary.plist'), bin);
  const { migrateMachine, machineRewrites } = lib();
  const res = migrateMachine({ map, home: H, guides: G, skills: path.join(base, 'no-skills'), env: { LAUNCHCTL_BIN: '/usr/bin/true' } });
  const s = JSON.parse(fs.readFileSync(path.join(H, '.claude', 'settings.json'), 'utf8'));
  const cmds = s.hooks.Stop[0].hooks.map((h) => h.command);
  assert.ok(cmds.includes(`node "${G}/scripts/nightly/lab-folder/export-tool.js"`), `archivo renombrado adentro de una carpeta renombrada: al archivo nuevo, no a una ruta que no existe (${cmds.join(' · ')})`);
  assert.ok(cmds.includes(`node "${G}/scripts/other-new/y.js"`), 'una carpeta con barra final en el mapa también se reescribe');
  assert.strictEqual(cmds.filter((c) => /metrics\/runs\.js/.test(c)).length, 1, `$HOME/… y la ruta real son el mismo hook: queda uno (${cmds.join(' · ')})`);
  const allow = s.permissions.allow;
  assert.ok(allow.includes(`Read(/${G}/scripts/metrics/runs.js)`), `la forma // de los permisos se reescribe (${allow.join(' · ')})`);
  assert.ok(allow.includes(`Edit(/${G}/scripts/nightly/lab-folder/**)`), 'también una carpeta en //');
  assert.ok(allow.includes(`Bash(node ${link}/scripts/x/other.js:*)`) && allow.includes(`Bash(node ${G}/scripts/x/other.js:*)`), 'dos formas de una regla AJENA al renombre quedan como estaban');
  assert.strictEqual(allow.filter((a) => a === 'Bash(git status:*)').length, 2, 'lo que no se reescribió no se deduplica');
  assert.ok(fs.readFileSync(path.join(agents, 'lab.legacy-names.binary.plist')).equals(bin), 'un plist binario no se toca');
  assert.ok(res.notes.some((n) => /binario/.test(n)), `y lo dice (${res.notes.join(' · ')})`);
  // Windows: la raíz llega con \ y el .ps1 escribe los comandos con /; las dos formas se reescriben
  const win = machineRewrites(mapOf([{ kind: 'file', old: `scripts/hooks/${W.viejo}.js`, new: 'scripts/hooks/new-hook.js', batch: 'lab', callers: ['machine'] }]),
    { guides: 'C:\\Users\\x\\tcg', skills: 'C:\\Users\\x\\skills', home: 'C:\\Users\\x', exists: () => true });
  const rw = (t) => win.reduce((acc, r) => acc.replace(r.re, r.to), t);
  assert.strictEqual(rw(`node "C:/Users/x/tcg/scripts/hooks/${W.viejo}.js"`), 'node "C:/Users/x/tcg/scripts/hooks/new-hook.js"');
  assert.strictEqual(rw(`node "C:\\Users\\x\\tcg\\scripts\\hooks\\${W.viejo}.js"`), 'node "C:\\Users\\x\\tcg\\scripts\\hooks\\new-hook.js"');
});

// ── vuelta 2 de revisores · sin respaldo no se reescribe, y se dice; un archivo que no se deja escribir no corta el resto
test('T26 LegacyNames_MigrateMachine_NoBackupNoRewrite', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('NO MEDIDO: como root, una carpeta de sólo lectura igual se escribe'); return; }
  const base = tmp('migrate-ro');
  const G = path.join(base, 'src', 'guides');
  const H = path.join(base, 'casa');
  const corridas = 'corri' + 'das';
  write(G, { 'scripts/metrics/runs.js': '//\n' });
  const map = mapOf([{ kind: 'file', old: `scripts/metrics/${corridas}.js`, new: 'scripts/metrics/runs.js', batch: 'lab', callers: ['machine'] }]);
  const cmd = `node "${G}/scripts/metrics/${corridas}.js"`;
  write(H, { '.claude/settings.json': { hooks: { Stop: [{ hooks: [{ type: 'command', command: cmd }] }] } } });
  fs.mkdirSync(path.join(H, '.codex'), { recursive: true });
  write(H, { '.codex/hooks.json': { hooks: { Stop: [{ hooks: [{ type: 'command', command: cmd }] }] } } });
  const claude = path.join(H, '.claude');
  const before = fs.readFileSync(path.join(claude, 'settings.json'), 'utf8');
  fs.chmodSync(claude, 0o555);
  let res;
  try {
    res = lib().migrateMachine({ map, home: H, guides: G, skills: path.join(base, 'no-skills'), env: {} });
  } finally { fs.chmodSync(claude, 0o755); }
  assert.strictEqual(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'), before, 'sin respaldo, settings.json queda como estaba');
  assert.ok(res.notes.some((n) => n.includes('settings.json') && /no pude respaldarlo/.test(n)), `y lo dice (${res.notes.join(' · ')})`);
  assert.ok(!res.files.some((f) => f.endsWith('settings.json')), 'no cuenta como reescrito');
  assert.ok(fs.readFileSync(path.join(H, '.codex', 'hooks.json'), 'utf8').includes('metrics/runs.js'), 'el archivo siguiente se reescribe igual');
  assert.strictEqual(res.renamed, 1, 'RENAMED cuenta sólo lo reescrito de verdad');
});

// ── vuelta 1 del pase adversarial · claves, estado, opciones con --, y el registro que no puede escribir ─────────
test('LegacyNames_KeysStateDashesAndLogFailure', () => {
  const home = tmp('misc');
  const { readKeys, prepareStateWrite, aliasOptions, LegacyNamesError } = lib();
  const km = mapOf([{ kind: 'key', old: W.motivo, new: 'reason', where: 'cfg.json', batch: 'lab' }]);
  assert.deepStrictEqual(readKeys({ [W.motivo]: { a: 1, b: 2 }, reason: { b: 2, a: 1 } }, 'cfg.json', { map: km, home }), { reason: { b: 2, a: 1 } },
    'el mismo objeto con las claves en otro orden es el mismo valor');
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    write(home, { [`.claude/${W.viejo}.log`]: 'x\n' });
    fs.chmodSync(path.join(home, '.claude', `${W.viejo}.log`), 0o000);
    const sm = mapOf([{ kind: 'state-file', old: `~/.claude/${W.viejo}.log`, new: '~/.claude/lab.log', batch: 'lab' }]);
    assert.throws(() => prepareStateWrite(path.join(home, '.claude', 'lab.log'), { map: sm, home }), LegacyNamesError,
      'si no puede llevar el estado viejo al nuevo, lo dice (no deja el nuevo vacío en silencio)');
    fs.chmodSync(path.join(home, '.claude', `${W.viejo}.log`), 0o644);
  }
  const om = mapOf([{ kind: 'option', old: `--${OLD_OPT}`, new: `--${NEW_OPT}`, where: 'scripts/lab/x.js', batch: 'lab' }]);
  assert.deepStrictEqual(aliasOptions([`--${OLD_OPT}`], 'scripts/lab/x.js', { map: om, home }), [`--${NEW_OPT}`], 'una opción escrita con -- en el mapa igual anda');
  // el registro no puede escribir (la HOME es un archivo): el valor sale igual, y lo dice una vez
  const notDir = path.join(home, 'not-a-dir');
  fs.writeFileSync(notDir, 'x');
  const map = path.join(home, 'renames.json');
  write(home, { 'renames.json': mapOf([{ kind: 'env', old: OLD_ENV, new: NEW_ENV, batch: 'lab' }]) });
  const r = spawnSync(process.execPath, ['-e', `const l=require(${JSON.stringify(LIB)});process.stdout.write(String(l.readEnv(${JSON.stringify(NEW_ENV)}))+String(l.readEnv(${JSON.stringify(NEW_ENV)},{where:'otro.js'})))`],
    { encoding: 'utf8', env: envWith({ HOME: notDir, TYCON_LEGACY_NAMES_MAP: map, [OLD_ENV]: '1' }) });
  assert.strictEqual(r.stdout, '11');
  assert.strictEqual((r.stderr.match(/no pude anotar/g) || []).length, 1, `avisa una sola vez: ${r.stderr}`);
});

// ── T21 · los controles no le exigen casos ni paridad a un reemplazo ────────────────────────────────────────────
test('T21 LegacyNames_ShimMarkerExempt', () => {
  const lab = tmp('exempt');
  const skills = path.join(lab, 'skills');
  write(lab, {
    'scripts/hooks/lab-hook.js': '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>{console.log("ran");process.exit(0)});\n',
    'cases/hooks/lab.json': { hooks: [{ hook: 'lab-hook.js', script: '${TCG}/scripts/hooks/lab-hook.js', event: 'Stop', cases: [{ id: 'lab-runs' }] }] },
    'renames.json': mapOf([{ kind: 'file', old: `scripts/hooks/${W.viejo}-hook.js`, new: 'scripts/hooks/lab-hook.js', batch: 'lab', callers: ['machine'] }]),
  });
  fs.mkdirSync(skills, { recursive: true });
  const gen = spawnSync(process.execPath, [LIB, '--write-shims', '--map', path.join(lab, 'renames.json'), '--root', lab], { encoding: 'utf8', env: envWith({ HOME: lab }) });
  assert.strictEqual(gen.status, 0, gen.stderr);
  // 1 · la cobertura del banco
  const cov = require(path.join(RAIZ, 'build', 'check-hook-coverage.js'));
  const disco = cov.enumerarDisco(cov.raices(lab, skills));
  const r = cov.comparar(disco.scripts, cov.cobertura(path.join(lab, 'cases', 'hooks')), []);
  assert.deepStrictEqual(r.bloqueantes, [], `el reemplazo no pide casos: ${r.bloqueantes.join(' · ')}`);
  // 2 · el banco corre un caso a través del reemplazo igual que a través del nuevo
  const runner = require(path.join(RAIZ, 'scripts', 'controls-bench', 'runner.js'));
  const res = runner.runCase('claude', { script: path.join(lab, `scripts/hooks/${W.viejo}-hook.js`), event: 'Stop' },
    { id: 'via-shim', type: 'must-emit', stdin: {}, expect: { exit: 0, stdout_re: ['ran'] } });
  assert.ok(res && (res.ok === true || res.pass === true || (Array.isArray(res.failures) && res.failures.length === 0)), `el banco pasa por el reemplazo: ${JSON.stringify(res).slice(0, 300)}`);
  // 3 · la paridad Codex: un hook desplegado que todavía apunta al reemplazo cuenta como el nuevo
  const probe = `
    const p = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'lib', 'harness-parity.js'))});
    const pol = require(${JSON.stringify(path.join(RAIZ, 'build', 'deploy-codex-hooks.js'))});
    const ctx = p.buildCtx();
    const esperado = pol.substitute(JSON.parse(require('fs').readFileSync(pol.FRAGMENT, 'utf8')).hooks, pol.TCG, pol.SKILLS);
    const first = Object.values(esperado)[0][0].hooks[0];
    const m = /"(\\/[^"]+)"/.exec(first.command) || /(\\/[^\\s"']+)/.exec(first.command);
    require('fs').writeFileSync(${JSON.stringify(path.join(lab, 'parity-shim.js'))}, '#!/usr/bin/env node\\n// tycon-legacy-shim: ' + m[1] + '\\n');
    first.command = first.command.replace(m[1], ${JSON.stringify(path.join(lab, 'parity-shim.js'))});
    ctx.hooksDeployed = esperado;
    const s = p.collect(ctx).find((x) => x.name === 'hooks');
    process.stdout.write(JSON.stringify(s));`;
  const par = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: envWith({ HOME: lab, CODEX_HOME: path.join(lab, 'codex') }) });
  assert.strictEqual(par.status, 0, par.stderr);
  const s = JSON.parse(par.stdout);
  assert.strictEqual(s.ok, true, `la paridad resuelve el reemplazo a su destino: ${s.detail}`);
});

// ── T22 · el registro de usos: una línea por día, sin valores; warning en CI ────────────────────────────────────
test('T22 LegacyNames_UsageLog_OneLinePerDay_Ci', async () => {
  const home = tmp('usage');
  const map = path.join(home, 'renames.json');
  write(home, { 'renames.json': mapOf([{ kind: 'env', old: OLD_ENV, new: NEW_ENV, batch: 'lab' }]) });
  const code = `const l=require(${JSON.stringify(LIB)});for(let i=0;i<500;i++) l.readEnv(${JSON.stringify(NEW_ENV)},{where:'scripts/lab/usage.js'});`;
  const env = envWith({ HOME: home, TYCON_LEGACY_NAMES_MAP: map, [OLD_ENV]: 'secret-value-123' });
  const run = () => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (st) => resolve({ st, out }));
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert.strictEqual(a.st, 0); assert.strictEqual(b.st, 0);
  assert.strictEqual(a.out + b.out, '', 'fuera de CI no imprime nada');
  const file = path.join(home, '.claude', '.tycon-pipeline', 'legacy-names.jsonl');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.trim().split('\n');
  assert.strictEqual(lines.length, 1, `una sola línea (hay ${lines.length})`);
  const l = JSON.parse(lines[0]);
  assert.deepStrictEqual(Object.keys(l).sort(), ['day', 'kind', 'new', 'old', 'script'].sort());
  assert.strictEqual(l.script, 'scripts/lab/usage.js');
  assert.ok(!text.includes('secret-value-123'), 'nunca el valor');
  assert.ok(!text.includes(home) && !text.includes(os.homedir()), 'nunca una ruta de la máquina');
  const ci = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...env, TF_BUILD: 'True' } });
  assert.match(ci.stdout + ci.stderr, /##vso\[task\.logissue type=warning\][^\n]*TYCON_NO_/, 'en CI, el warning con el nombre viejo');
  assert.ok((ci.stdout + ci.stderr).includes(NEW_ENV), 'y el nuevo');
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, 'y el registro sigue en una línea');
});

// ── T23 · archivos de configuración y de estado con dos nombres ──────────────────────────────────────────────────
test('T23 LegacyNames_ConfigAndStateFiles', () => {
  const home = tmp('files');
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const map = mapOf([
    { kind: 'config-file', old: `~/.claude/${W.viejo}.json`, new: '~/.claude/lab-config.json', batch: 'lab' },
    { kind: 'state-file', old: `~/.claude/${W.viejo}.jsonl`, new: '~/.claude/lab-state.jsonl', batch: 'lab' },
    { kind: 'state-file', old: `~/.claude/${W.viejo}-state.json`, new: '~/.claude/lab-state.json', batch: 'lab' },
    { kind: 'key', old: W.motivo, new: 'reason', where: '~/.claude/lab-config.json', batch: 'lab' },
  ]);
  const { resolveFile, readKeys, prepareStateWrite, LegacyNamesError } = lib();
  const o = { map, home };
  const cfgNew = path.join(dir, 'lab-config.json');
  const cfgOld = path.join(dir, `${W.viejo}.json`);
  assert.strictEqual(resolveFile(cfgNew, o), cfgNew, 'ninguno: el nuevo (para escribir)');
  fs.writeFileSync(cfgOld, '{"a":1}');
  assert.strictEqual(resolveFile(cfgNew, o), cfgOld, 'sólo el viejo: el viejo');
  fs.writeFileSync(cfgNew, '{"a":1}');
  assert.strictEqual(resolveFile(cfgNew, o), cfgNew, 'los dos iguales: el nuevo');
  fs.writeFileSync(cfgNew, '{"a":2}');
  assert.throws(() => resolveFile(cfgNew, o), (e) => e instanceof LegacyNamesError && e.message.includes(cfgNew) && e.message.includes(cfgOld), 'configuración con dos contenidos: error que nombra los dos');
  const stNew = path.join(dir, 'lab-state.jsonl');
  const stOld = path.join(dir, `${W.viejo}.jsonl`);
  fs.writeFileSync(stOld, '{"x":1}\n');
  fs.writeFileSync(stNew, '{"x":2}\n');
  assert.strictEqual(resolveFile(stNew, o), stNew, 'estado con dos contenidos: gana el nuevo');
  fs.unlinkSync(stNew);
  assert.strictEqual(prepareStateWrite(stNew, o), stNew);
  fs.appendFileSync(stNew, '{"x":3}\n');
  assert.strictEqual(fs.readFileSync(stNew, 'utf8'), '{"x":1}\n{"x":3}\n', '.jsonl: el viejo antes');
  assert.strictEqual(fs.readFileSync(stOld, 'utf8'), '{"x":1}\n', 'el viejo intacto');
  const jNew = path.join(dir, 'lab-state.json');
  fs.writeFileSync(path.join(dir, `${W.viejo}-state.json`), '{"count":5}');
  prepareStateWrite(jNew, o);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(jNew, 'utf8')), { count: 5 }, '.json: el viejo como base');
  assert.deepStrictEqual(readKeys({ [W.motivo]: 'm' }, '~/.claude/lab-config.json', o), { reason: 'm' }, 'clave vieja → nueva');
  assert.deepStrictEqual(readKeys({ [W.motivo]: 'm', reason: 'm' }, '~/.claude/lab-config.json', o), { reason: 'm' }, 'iguales');
  assert.throws(() => readKeys({ [W.motivo]: 'm', reason: 'n' }, '~/.claude/lab-config.json', o), LegacyNamesError, 'distintas: error');
  assert.strictEqual(resolveFile(path.join(dir, 'unmapped.json'), o), path.join(dir, 'unmapped.json'), 'sin entrada: el mismo');
});

// ── T24 (la parte sin exportar) · el mapa roto frena la copia y la foto de después, nunca la de antes ────────────
// Un mapa de renombres roto que llegara a main (sin pre-commit ni PR) trabaría los dos frenos de nombres en TODO commit,
// también en el que lo arregla, si la foto de antes frenara. Y la mención de una ruta vieja: ruta completa, no subcadena.
test('T24 Export_BrokenMapBlocksCopyNotTheBeforeSnapshot', () => {
  const exporter = require(path.join(RAIZ, 'scripts', 'publishing', 'export.js'));
  const repo = tmp('broken-map');
  spawnSync('git', ['init', '-q', repo]);
  const obj = spawnSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: '{ esto no es json', encoding: 'utf8' }).stdout.trim();
  const ctx = (extra) => ({ arboles: { arnes: [{ ruta: 'scripts/lib/renames.json', obj, tipo: 'blob' }] }, repos: { arnes: { dir: repo } }, ...extra });
  assert.throws(() => exporter.nombresViejos(ctx({})), (e) => e instanceof exporter.NoPudo && /renames\.json/.test(e.message), 'la copia (y la foto de después) no sale con un mapa roto');
  const before = exporter.nombresViejos(ctx({ estricto: false }));
  assert.strictEqual(before.rutas.length, 0, 'la foto de antes lo mira sin nombres viejos y no frena');
  const viejos = { rutas: [{ fuente: 'arnes', ruta: `scripts/metrics/${'corri' + 'das'}.js`, carpeta: false }] };
  const found = exporter.mencionesViejas([
    ['arnes/scripts/a.sh', `node scripts/metrics/${'corri' + 'das'}.js`],
    ['arnes/scripts/b.sh', `node scripts/metrics/subir-${'corri' + 'das'}.js`],
    ['arnes/guides/nombres-en-ingles.md', `scripts/metrics/${'corri' + 'das'}.js`],
  ], viejos);
  assert.deepStrictEqual(found.map((h) => h.archivo), ['arnes/scripts/a.sh'], 'la ruta completa: subir-…js no cuenta, y la guía de la convención puede nombrarla');
  // otra ruta que TERMINA igual (un archivo de agent-skills) no es la vieja; la vieja con su raíz delante, sí
  const hook = { rutas: [{ fuente: 'arnes', ruta: 'scripts/lib/hook-io.js', carpeta: false }] };
  const m2 = exporter.mencionesViejas([
    ['agent-skills/skills/tycon-pipeline/README.md', 'ver skills/tycon-pipeline/scripts/lib/hook-io.js'],
    ['arnes/scripts/b.sh', 'node ~/.claude/tycon-claude-guides/scripts/lib/hook-io.js'],
    ['arnes/scripts/c.sh', 'node "$TCG/scripts/lib/hook-io.js"'],
    ['arnes/scripts/d.sh', 'node scripts/lib/hook-io.js'],
  ], hook);
  assert.deepStrictEqual(m2.map((h) => h.archivo), ['arnes/scripts/b.sh', 'arnes/scripts/c.sh', 'arnes/scripts/d.sh'], 'sólo la ruta del arnés, no la que termina igual en otro repo');
  // los que leen y protegen los dos nombres a propósito (LEGACY_READERS de spanish-names.js, tanda P) nombran la ruta vieja
  // en la copia también: no son una mención de más (story 8.9, tanda B3b: la copia del núcleo no salía desde la P)
  const lector = [...require(path.join(RAIZ, 'scripts', 'publishing', 'spanish-names.js')).LEGACY_READERS][0];
  const m3 = exporter.mencionesViejas([
    [`arnes/${lector}`, 'node scripts/lib/hook-io.js'],
    [`agent-skills/${lector}`, 'node tycon-claude-guides/scripts/lib/hook-io.js'],
  ], hook);
  assert.deepStrictEqual(m3.map((h) => h.archivo), [`agent-skills/${lector}`], 'el lector del arnés no cuenta; la misma ruta en el otro repo, sí');
  // una entrada todavía no movida (el nuevo no está en el árbol) no es un nombre viejo: su archivo real sale
  const blob = (t) => spawnSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: t, encoding: 'utf8' }).stdout.trim();
  const mapObj = blob(JSON.stringify(mapOf([
    { kind: 'file', old: `scripts/${'vie' + 'jo'}.js`, new: 'scripts/tools/moved.js', batch: 'lab', callers: ['machine'] },
    { kind: 'file', old: `scripts/${'pendien' + 'te'}.js`, new: 'scripts/tools/pending.js', batch: 'lab', callers: ['machine'] },
  ])));
  const vj = exporter.nombresViejos({ arboles: { arnes: [
    { ruta: 'scripts/lib/renames.json', obj: mapObj, tipo: 'blob' },
    { ruta: 'scripts/tools/moved.js', obj: mapObj, tipo: 'blob' },
  ] }, repos: { arnes: { dir: repo } } });
  assert.deepStrictEqual(vj.rutas.map((x) => x.ruta), [`scripts/${'vie' + 'jo'}.js`], 'sólo la entrada ya movida cuenta como nombre viejo');
});

// ── T25 · todo require de lo que se copia a /opt está en lo que se copia ────────────────────────────────────────
test('T25 ProdGuard_ArchivosRequireClosure', () => {
  const sh = fs.readFileSync(path.join(RAIZ, 'scripts', 'production', 'install-guard.sh'), 'utf8');
  const m = /\nARCHIVOS=\(\n([\s\S]*?)\n\)/.exec(sh);
  assert.ok(m, 'encuentro la lista ARCHIVOS');
  const files = m[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const set = new Set(files);
  // el nombre de antes de la biblioteca de constancias: el instalador deja en /opt la biblioteca misma con ese nombre
  // (tanda C1: el freno instalado lo carga así), fuera de ARCHIVOS porque en el repo es un reemplazo
  const r = /\nNOMBRE_VIEJO_CONSTANCIA=(\S+)/.exec(sh);
  if (r) {
    set.add(`scripts/${r[1]}`);
    assert.match(sh, /\ninstalar scripts\/lib\/guard-record\.js\s+"\$DESTINO\/\$NOMBRE_VIEJO_CONSTANCIA"/, 'se instala la biblioteca con el nombre de antes');
  }
  const missing = [];
  for (const rel of files) {
    const abs = path.join(RAIZ, rel);
    const text = fs.readFileSync(abs, 'utf8');
    if (!/\.js$/.test(rel) && !/^#!.*\bnode\b/.test(text)) continue;
    const reqs = [];
    for (const r of text.matchAll(/require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)) reqs.push(path.join(path.dirname(rel), r[2]));
    for (const r of text.matchAll(/require\(\s*path\.join\(\s*__dirname\s*,([^)]*)\)\s*\)/g)) {
      const parts = [...r[1].matchAll(/(['"])([^'"]+)\1/g)].map((x) => x[2]);
      if (parts.length === r[1].split(',').filter((x) => x.trim()).length) reqs.push(path.join(path.dirname(rel), ...parts));
    }
    for (const q of reqs) {
      const n = path.normalize(q).replace(/\\/g, '/');
      // un require que ya trae su extensión no gana otra: en la copia pública el reemplazo del nombre de antes no viaja,
      // y «no existe en el repo» no es «le falta el .js» (exportador-real T24 (c))
      const withExt = /\.js$/.test(n) || fs.existsSync(path.join(RAIZ, n)) ? n : `${n}.js`;
      if (!set.has(withExt)) missing.push(`${rel} → ${withExt}`);
    }
  }
  assert.deepStrictEqual(missing, [], `lo que se copia a /opt requiere archivos que no se copian: ${missing.join(' · ')}`);
  // y cada módulo de la lista tiene su paso de copia: estar en ARCHIVOS sólo lo trae de lo publicado, no lo instala (las
  // plantillas y los datos del instalador se usan de otra forma)
  const sinPaso = files.filter((rel) => /\.js$/.test(rel)).filter((rel) => !new RegExp(`\\ninstalar ${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`).test(sh));
  assert.deepStrictEqual(sinPaso, [], `archivos de ARCHIVOS sin su línea «instalar»: ${sinPaso.join(' · ')}`);
});

// ── story 8.12, tanda R1 ─────────────────────────────────────────────────────────────────────────────────────────
const checkMapLab = (repo, map) => {
  const f = path.join(repo, `map-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(map));
  return spawnSync(process.execPath, [SPANISH, '--check-map', '--map', f, '--repo', repo], { encoding: 'utf8', env: envWith({}) });
};

// ── T9 · el rol de un hook va en su nombre (AC 7) ───────────────────────────────────────────────────────────────
test('T9 Restructure_CheckMap_HookRoleSuffix', () => {
  const repo = tmp('role');
  // la entrada de la tabla de constancia: cargada por la 8.9 antes de la regla del sufijo (la única que acepta role_waiver)
  const waivedOld = 'scripts/hooks/advisor-' + 'vi' + 'da' + '-on-change.js';
  write(repo, {
    'scripts/hooks/lab-check.js': '#!/usr/bin/env node\n',
    'scripts/hooks/lab-check-guard.js': '#!/usr/bin/env node\n',
    'scripts/hooks/advisor-liveness-on-change.js': '#!/usr/bin/env node\n',
    'scripts/tools/lab-tool.js': '#!/usr/bin/env node\n',
  });
  const hook = (extra, newRel = 'scripts/hooks/lab-check.js', old = `scripts/hooks/${W.viejo}-lab.js`) => mapOf([
    { kind: 'file', old, new: newRel, batch: 'lab', callers: ['same-repo'], ...extra },
  ]);
  const cases = [
    ['guard sin el sufijo', hook({ role: 'guard' }), 2, /-guard/],
    ['role none sin sufijo', hook({ role: 'none' }), 0],
    ['guard con su sufijo', hook({ role: 'guard' }, 'scripts/hooks/lab-check-guard.js'), 0],
    ['guard sin sufijo, con role_waiver, en la entrada de la tabla de constancia',
      hook({ role: 'guard', role_waiver: 'cargada por la 8.9 antes de la regla del sufijo' }, 'scripts/hooks/advisor-liveness-on-change.js', waivedOld), 0],
    ['role_waiver en una entrada que no es de la tabla de constancia', hook({ role: 'guard', role_waiver: 'un motivo cualquiera' }), 2, /role_waiver sólo vale/],
    ['role_waiver vacío', hook({ role: 'guard', role_waiver: '' }, 'scripts/hooks/advisor-liveness-on-change.js', waivedOld), 2, /role_waiver/],
    ['role_waiver sin role', hook({ role_waiver: 'x' }, 'scripts/hooks/advisor-liveness-on-change.js', waivedOld), 2, /role/],
    ['role_waiver con role none', hook({ role: 'none', role_waiver: 'x' }, 'scripts/hooks/advisor-liveness-on-change.js', waivedOld), 2, /role_waiver/],
    ['role fuera del vocabulario', hook({ role: 'checker' }), 2, /guard, notice, meter, none|guard\|notice/],
    ['hook sin role', hook({}), 2, /role/],
    ['role fuera de scripts/hooks/', hook({ role: 'none' }, 'scripts/tools/lab-tool.js'), 2, /scripts\/hooks/],
  ];
  for (const [name, map, want, re] of cases) {
    const r = checkMapLab(repo, map);
    assert.strictEqual(r.status, want, `${name}: sale ${want} (salió ${r.status}: ${r.stderr})`);
    if (re) assert.match(r.stderr, re, `${name}: el mensaje dice por qué`);
  }
  fs.rmSync(repo, { recursive: true, force: true });
});

// ── T1 · los llamadores de cada entrada R, los de la medición (AC 1) ─────────────────────────────────────────────
const MEASUREMENT = path.join(RAIZ, 'tasks', 'medicion-8.12-cada-pieza-en-su-carpeta-2026-09-30.md');
const MAP_REAL = path.join(RAIZ, 'scripts', 'lib', 'renames.json');
const TEAM_812 = fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) && fs.existsSync(MAP_REAL) && fs.existsSync(MEASUREMENT);
// lo que nombra Azure DevOps: la medición no lo clasifica siempre, y en ningún otro lado vale
const ADO_NAMED = /^(?:azure-pipelines[^/]*\.yml|ci-templates(?:\/.*)?)$/;
/** old (sin barra final) → llamadores, del §«Detalle por ítem» de la medición. Un ítem sin ruta de destino (un glob, una
 *  pregunta abierta, lo que renombra la 8.9) no es una entrada del mapa. */
function measuredCallers(text) {
  const at = text.indexOf('## Detalle por ítem');
  assert.ok(at >= 0, 'la medición tiene §«Detalle por ítem»');
  const out = new Map();
  let cur = null;
  for (const line of text.slice(at).split('\n').slice(1)) {
    if (/^## /.test(line)) break;
    if (line.startsWith('### ')) {
      const h = /^### (\S+) → (\S+)\s*$/.exec(line);
      cur = h ? h[1].replace(/\/+$/, '') : null;
      continue;
    }
    const c = cur && /^- grupo: .*· callers: (.*)$/.exec(line);
    if (c) out.set(cur, [...c[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  }
  return out;
}
function callersProblems(entries, measured) {
  const problems = [];
  for (const e of entries) {
    if (!e || (e.kind !== 'file' && e.kind !== 'folder') || typeof e.batch !== 'string' || !/^R/.test(e.batch)) continue;
    const key = String(e.old).replace(/\/+$/, '');
    if (!measured.has(key)) { problems.push(`${e.old}: no está en la medición`); continue; }
    const want = [...new Set([...measured.get(key), ...(ADO_NAMED.test(key) ? ['ado'] : [])])].sort();
    const got = [...new Set(e.callers || [])].sort();
    if (want.join(',') !== got.join(',')) problems.push(`${e.old}: callers [${got.join(', ')}] y la medición dice [${want.join(', ')}]`);
  }
  return problems;
}

test('T1 Restructure_CheckMap_CrossFolderEntriesCallersAndAdo — cada entrada R tiene los callers de la medición', { skip: !TEAM_812 && 'copia pública: sin el mapa ni la medición' }, () => {
  const measured = measuredCallers(fs.readFileSync(MEASUREMENT, 'utf8'));
  assert.ok(measured.size >= 50, `la medición trae sus ítems (leí ${measured.size})`);
  const real = JSON.parse(fs.readFileSync(MAP_REAL, 'utf8')).entries;
  assert.deepStrictEqual(callersProblems(real, measured), [], 'el mapa real: callers distintos de los medidos, o una entrada R que la medición no tiene');
  // la comparación sabe fallar (con el mapa real sin entradas R pasa en vacío)
  const [old, callers] = [...measured].find(([k, v]) => k.startsWith('scripts/') && v.includes('same-repo') && v.length > 1);
  const lab = (extra) => [{ kind: 'file', old, new: `scripts/setup/${path.posix.basename(old)}`, batch: 'R1', callers, ...extra }];
  assert.deepStrictEqual(callersProblems(lab({}), measured), [], 'con los callers medidos, pasa');
  const fewer = callersProblems(lab({ callers: callers.filter((c) => c !== 'same-repo') }), measured);
  assert.strictEqual(fewer.length, 1, 'con uno de menos, falla');
  assert.ok(fewer[0].startsWith(`${old}:`), `y nombra la entrada: ${fewer[0]}`);
  assert.strictEqual(callersProblems(lab({ callers: [...callers, 'ado'] }), measured).length, 1, 'ado fuera de un pipeline de Azure: falla');
  assert.deepStrictEqual(callersProblems(lab({ batch: 'C1', callers: ['docs'] }), measured), [], 'una entrada que no es de una tanda R no se compara');
  const unmeasured = callersProblems([{ kind: 'file', old: 'scripts/lab-unmeasured.sh', new: 'scripts/setup/lab-unmeasured.sh', batch: 'R1', callers: ['docs'] }], measured);
  assert.deepStrictEqual(unmeasured, ['scripts/lab-unmeasured.sh: no está en la medición']);
  // los pipelines: la medición más ado
  const yml = [...measured.keys()].find((k) => /^azure-pipelines-.+\.yml$/.test(k));
  const ymlCallers = [...new Set([...measured.get(yml), 'ado'])];
  assert.deepStrictEqual(callersProblems([{ kind: 'file', old: yml, new: `pipelines/${yml}`, batch: 'R6', callers: ymlCallers }], measured), [], `${yml}: con ado, pasa`);
  // la carpeta de plantillas, por su nombre de la medición (sin escribir la ruta vieja: desde la R6 ya se mudó y la copia
  // pública no puede nombrarla)
  const tplKey = [...measured.keys()].find((k) => ADO_NAMED.test(k) && !/\.yml$/.test(k));
  if (tplKey) {
    const ci = [...new Set([...measured.get(tplKey), 'ado'])];
    assert.deepStrictEqual(callersProblems([{ kind: 'folder', old: `${tplKey}/`, new: 'pipelines/templates', batch: 'R6', callers: ci }], measured), [], `${tplKey}: con ado, pasa`);
  }
});

test('T1 Restructure_CheckMap_CrossFolderEntriesCallersAndAdo — un .yml ya mudado que nombran sólo Azure, las guías y su repo no pide reemplazo', () => {
  const repo = tmp('ado-yml');
  write(repo, { 'pipelines/azure-pipelines-lab.yml': 'trigger: none\n' });
  const entry = (callers) => mapOf([{ kind: 'file', old: 'azure-pipelines-lab.yml', new: 'pipelines/azure-pipelines-lab.yml', batch: 'lab', callers }]);
  const ok = checkMapLab(repo, entry(['ado', 'docs', 'same-repo']));
  assert.strictEqual(ok.status, 0, `[ado, docs, same-repo]: pasa sin reemplazo (${ok.stderr})`);
  const bad = checkMapLab(repo, entry(['ado', 'products']));
  assert.strictEqual(bad.status, 2, `[ado, products]: sale 2 (${bad.stderr})`);
  assert.match(bad.stderr, /no hay forma de reemplazo/);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ── T51 · story 8.12, tanda R8 (AC 47) — el mapa contra la medición, en la otra dirección, y sin fecha propia ─────────
// T1 mira de cada entrada R hacia la medición (sus `callers`). Lo que falta para que la story de retiro (tanda E de la 8.9)
// saque del mapa exactamente lo de esta story: que todo ítem de la medición con una ruta de destino tenga su entrada (o lo
// cubra la carpeta que lo contiene), que el `new` sea el destino medido, que ninguna entrada traiga una fecha suya (el
// retiro vive en la raíz del mapa, una sola vez) y que el conteo cierre. Los ítems se clasifican por la FORMA de su
// encabezado, nunca por su ruta: esta prueba no escribe ninguna ruta vieja.
const R_ENTRY_KEYS = new Set(['kind', 'old', 'new', 'batch', 'callers', 'role', 'homonyms', '__nota']);
const DATE_SHAPE = /\d{4}-\d{2}-\d{2}/;
const isREntry = (e) => e && (e.kind === 'file' || e.kind === 'folder') && typeof e.batch === 'string' && /^R/.test(e.batch);
const noSlash = (s) => String(s).replace(/\/+$/, '');

/** Los ítems del §«Detalle por ítem», clasificados por la forma del encabezado `### <origen> → <destino>`. */
function measurementItems(text) {
  const at = text.indexOf('## Detalle por ítem');
  assert.ok(at >= 0, 'la medición tiene §«Detalle por ítem»');
  const items = [];
  const problems = [];
  for (const line of text.slice(at).split('\n').slice(1)) {
    if (/^## /.test(line)) break;
    if (!line.startsWith('### ')) continue;
    const h = /^### (.+?) → (.+?)\s*$/.exec(line);
    if (!h) { problems.push(`encabezado sin «origen → destino»: ${line}`); continue; }
    const [, source, dest] = h;
    let kind;
    if (/ \(glob\)$/.test(source)) kind = 'glob';
    else if (dest === '(queda)') kind = 'stays';
    else if (dest === '(¿borrar?)') kind = 'delete';
    else if (/^\(la 8\.9 lo renombra/.test(dest)) kind = 'renamed-by-8.9';
    else if (dest === '(pregunta abierta)') kind = 'open-question';
    else if (dest.startsWith('(')) { problems.push(`destino entre paréntesis que no conozco: ${line}`); continue; }
    else if (/\s/.test(source) || /\s/.test(dest)) { problems.push(`origen o destino con espacios: ${line}`); continue; }
    else kind = 'path';
    items.push({ source, dest, kind });
  }
  return { items, problems };
}

/** Las entradas R contra los ítems con ruta de destino: en las dos direcciones, y el `new` igual al destino medido. */
function mapVsMeasurement(entries, items) {
  const problems = [];
  const counts = { withEntry: 0, coveredByFolder: 0 };
  const rEntries = entries.filter(isREntry);
  const byOld = new Map(rEntries.map((e) => [noSlash(e.old), e]));
  const used = new Set();
  for (const it of items.filter((i) => i.kind === 'path')) {
    const key = noSlash(it.source);
    const dest = noSlash(it.dest);
    const e = byOld.get(key);
    if (e) {
      used.add(e);
      counts.withEntry++;
      if (noSlash(e.new) !== dest) problems.push(`${it.source}: el mapa dice new \`${e.new}\` y la medición mide \`${it.dest}\``);
      continue;
    }
    // la carpeta más específica que lo contiene (el prefijo más largo), no la primera del mapa
    const folder = rEntries.filter((f) => f.kind === 'folder' && key.startsWith(`${noSlash(f.old)}/`))
      .sort((a, b) => noSlash(b.old).length - noSlash(a.old).length)[0];
    if (folder) {
      counts.coveredByFolder++;
      const want = `${noSlash(folder.new)}${key.slice(noSlash(folder.old).length)}`;
      if (want !== dest) problems.push(`${it.source}: la carpeta del mapa lo lleva a \`${want}\` y la medición mide \`${it.dest}\``);
      continue;
    }
    problems.push(`${it.source} → ${it.dest}: el ítem de la medición no tiene su entrada R en el mapa`);
  }
  for (const e of rEntries) if (!used.has(e)) problems.push(`${e.old}: la entrada R no es un ítem con ruta de destino de la medición`);
  return { problems, counts };
}

/** Ninguna entrada R trae una fecha suya: sólo sus claves, ningún valor con forma de fecha, y `retire_after` en la raíz. */
function ownDateProblems(map) {
  const problems = [];
  if (!Object.prototype.hasOwnProperty.call(map, 'retire_after')) problems.push('la raíz del mapa no tiene retire_after');
  for (const e of map.entries || []) {
    if (e && Object.prototype.hasOwnProperty.call(e, 'retire_after')) problems.push(`${e.old}: retire_after vive en la raíz del mapa, no en una entrada`);
    if (!isREntry(e)) continue;
    for (const [k, v] of Object.entries(e)) {
      if (!R_ENTRY_KEYS.has(k)) { problems.push(`${e.old}: la clave «${k}» no es de una entrada R (${[...R_ENTRY_KEYS].join(' ')})`); continue; }
      // en `old` y `new` una fecha es parte del nombre del archivo (los documentos fechados de decisiones), no de la entrada
      if (k === 'old' || k === 'new') continue;
      // lo mismo con el `glob` de cada homónimo, que también es una ruta; su `reason` sí se mira
      const seen = k === 'homonyms' && Array.isArray(v)
        ? v.map((h) => (h && typeof h === 'object' ? Object.fromEntries(Object.entries(h).filter(([hk]) => hk !== 'glob')) : h))
        : v;
      const m = DATE_SHAPE.exec(JSON.stringify(seen));
      if (m) problems.push(`${e.old}: «${k}» tiene una fecha (${m[0]}): la entrada no lleva fecha propia`);
    }
  }
  return problems;
}

test('T51 Close_MapEntriesCompleteVsMeasurement — toda ruta medida tiene su entrada R, el new es el destino medido, sin fecha propia y el conteo cierra', { skip: !TEAM_812 && 'NO MEDIDO — copia pública sin el mapa' }, () => {
  const { items, problems: parse } = measurementItems(fs.readFileSync(MEASUREMENT, 'utf8'));
  assert.deepStrictEqual(parse, [], 'la medición se lee entera');
  const map = JSON.parse(fs.readFileSync(MAP_REAL, 'utf8'));
  const { problems, counts } = mapVsMeasurement(map.entries, items);
  assert.deepStrictEqual(problems, [], `el mapa contra la medición:\n  ${problems.join('\n  ')}`);
  const dates = ownDateProblems(map);
  assert.deepStrictEqual(dates, [], `entradas con fecha propia:\n  ${dates.join('\n  ')}`);
  // el conteo cerrado de la medición del 2026-09-30, por la forma de cada encabezado
  const byKind = {};
  for (const it of items) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  assert.strictEqual(items.length, 68, 'la medición tiene 68 ítems');
  assert.deepStrictEqual(byKind, { path: 58, stays: 2, delete: 1, 'renamed-by-8.9': 2, 'open-question': 2, glob: 3 }, 'los ítems por la forma de su encabezado');
  assert.strictEqual(map.entries.filter(isREntry).length, 57, '57 entradas R en el mapa');
  assert.deepStrictEqual(counts, { withEntry: 57, coveredByFolder: 1 }, '57 con su entrada y uno cubierto por su carpeta');
  assert.strictEqual(items.length - counts.withEntry, 11, '11 ítems sin entrada propia');
});

test('T51 Close_MapEntriesCompleteVsMeasurement — laboratorio: un ítem sin entrada, un new distinto y una clave con fecha', () => {
  const text = [
    '# Medición de laboratorio', '', '## Detalle por ítem', '',
    '### scripts/lab-a.sh → scripts/setup/lab-a.sh', '- grupo: x · callers: `docs`',
    '### scripts/lab-b.js → scripts/lib/lab-b.js', '',
    '### labfolder/ → inbox/labfolder/', '',
    '### labfolder/inner.yml → inbox/labfolder/inner.yml', '',
    '### scripts/lab-keep.sh → (queda)', '',
    '### scripts/lab-maybe.js → (¿borrar?)', '',
    '### scripts/lab-renamed.sh → (la 8.9 lo renombra; carpeta por la regla 1)', '',
    '### .lab/state/ → (pregunta abierta)', '',
    '### scripts/lab-*.sh (glob) → scripts/setup/*.sh', '',
    '## Otra sección', '', '### fuera → del detalle', '',
  ].join('\n');
  const { items, problems: parse } = measurementItems(text);
  assert.deepStrictEqual(parse, []);
  assert.deepStrictEqual(items.map((i) => i.kind), ['path', 'path', 'path', 'path', 'stays', 'delete', 'renamed-by-8.9', 'open-question', 'glob']);
  const good = () => [
    { kind: 'file', old: 'scripts/lab-a.sh', new: 'scripts/setup/lab-a.sh', batch: 'R1', callers: ['docs'] },
    { kind: 'file', old: 'scripts/lab-b.js', new: 'scripts/lib/lab-b.js', batch: 'R3', callers: ['same-repo'], __nota: 'tanda de laboratorio' },
    { kind: 'folder', old: 'labfolder', new: 'inbox/labfolder', batch: 'R2', callers: ['same-repo'] },
    { kind: 'file', old: 'scripts/other.js', new: 'scripts/tools/other.js', batch: 'C1', callers: ['docs'] },
  ];
  const ok = mapVsMeasurement(good(), items);
  assert.deepStrictEqual(ok.problems, []);
  assert.deepStrictEqual(ok.counts, { withEntry: 3, coveredByFolder: 1 });
  // un ítem sin entrada: lo nombra
  const missing = mapVsMeasurement(good().filter((e) => e.old !== 'scripts/lab-b.js'), items).problems;
  assert.deepStrictEqual(missing, ['scripts/lab-b.js → scripts/lib/lab-b.js: el ítem de la medición no tiene su entrada R en el mapa']);
  // un new distinto del destino medido
  const moved = good();
  moved[0].new = 'scripts/tools/lab-a.sh';
  assert.deepStrictEqual(mapVsMeasurement(moved, items).problems, ['scripts/lab-a.sh: el mapa dice new `scripts/tools/lab-a.sh` y la medición mide `scripts/setup/lab-a.sh`']);
  // la carpeta que lleva lo de adentro a otro lado
  const folder = good();
  folder[2].new = 'inbox/other';
  const fp = mapVsMeasurement(folder, items).problems;
  assert.strictEqual(fp.length, 2, fp.join('\n'));
  assert.ok(fp.some((p) => p.startsWith('labfolder/inner.yml: la carpeta del mapa lo lleva a `inbox/other/inner.yml`')), fp.join('\n'));
  // una entrada R que la medición no tiene
  assert.deepStrictEqual(mapVsMeasurement([...good(), { kind: 'file', old: 'scripts/lab-extra.js', new: 'scripts/lib/lab-extra.js', batch: 'R3', callers: [] }], items).problems,
    ['scripts/lab-extra.js: la entrada R no es un ítem con ruta de destino de la medición']);
  // fecha propia: una clave con fecha, un valor con fecha, retire_after fuera de la raíz o ausente en la raíz
  const lab = (entries, extra = {}) => mapOf(entries, extra);
  assert.deepStrictEqual(ownDateProblems(lab(good())), [], 'el mapa de laboratorio no tiene fecha propia');
  const dated = good();
  dated[0].retire_after = '2099-01-01';
  const dp = ownDateProblems(lab(dated));
  assert.ok(dp.some((p) => p.startsWith('scripts/lab-a.sh: retire_after vive en la raíz')), dp.join('\n'));
  assert.ok(dp.some((p) => p.startsWith('scripts/lab-a.sh: la clave «retire_after» no es de una entrada R')), dp.join('\n'));
  const keyed = good();
  keyed[1].moved_on = '2099-01-01';
  assert.deepStrictEqual(ownDateProblems(lab(keyed)), [`scripts/lab-b.js: la clave «moved_on» no es de una entrada R (${[...R_ENTRY_KEYS].join(' ')})`]);
  const noted = good();
  noted[1].__nota = 'movida el 2099-01-01';
  assert.deepStrictEqual(ownDateProblems(lab(noted)), ['scripts/lab-b.js: «__nota» tiene una fecha (2099-01-01): la entrada no lleva fecha propia']);
  const named = good();
  named[0].old = 'guides/lab-decision-2099-01-01.md';
  named[0].new = 'guides/decisions/lab-decision-2099-01-01.md';
  assert.deepStrictEqual(ownDateProblems(lab(named)), [], 'una fecha en el nombre del archivo no es fecha de la entrada');
  const rootless = lab(good());
  delete rootless.retire_after;
  assert.deepStrictEqual(ownDateProblems(rootless), ['la raíz del mapa no tiene retire_after']);
  // una entrada que no es R puede tener otras claves (las de la 8.9)
  assert.deepStrictEqual(ownDateProblems(lab([...good(), { kind: 'env', old: 'TYCON_LAB_OLD', new: 'TYCON_LAB_NEW', batch: 'C1', where: ['scripts/lab.js'] }])), []);
});

test('T51 Close_MapEntriesCompleteVsMeasurement — laboratorio: un homónimo que nombra un documento fechado no es fecha de la entrada, su motivo sí', () => {
  const entry = (homonyms) => ({ kind: 'file', old: 'lab-x.yml', new: 'pipelines/lab-x.yml', batch: 'R4', callers: ['docs'], homonyms });
  assert.deepStrictEqual(ownDateProblems(mapOf([entry([{ glob: 'guides/decisions/lab-2099-01-01.md', reason: 'otro archivo con el mismo nombre' }])])), [],
    'la fecha del nombre del homónimo es parte de su ruta, como en old/new');
  assert.deepStrictEqual(ownDateProblems(mapOf([entry([{ glob: 'artifacts/lab-*.html', reason: 'agregado el 2099-01-01' }])])),
    ['lab-x.yml: «homonyms» tiene una fecha (2099-01-01): la entrada no lleva fecha propia'], 'una fecha en el motivo del homónimo sí es de la entrada');
});

test('T51 Close_MapEntriesCompleteVsMeasurement — laboratorio: con carpetas anidadas, el ítem lo lleva la carpeta más específica', () => {
  const items = [
    { source: 'labouter/', dest: 'x/labouter/', kind: 'path' },
    { source: 'labouter/inner/', dest: 'y/inner/', kind: 'path' },
    { source: 'labouter/inner/c.js', dest: 'y/inner/c.js', kind: 'path' },
    { source: 'labouter/top.js', dest: 'x/labouter/top.js', kind: 'path' },
  ];
  const entries = [
    { kind: 'folder', old: 'labouter', new: 'x/labouter', batch: 'R1', callers: ['same-repo'] },
    { kind: 'folder', old: 'labouter/inner', new: 'y/inner', batch: 'R1', callers: ['same-repo'] },
  ];
  const r = mapVsMeasurement(entries, items);
  assert.deepStrictEqual(r.problems, [], 'labouter/inner/c.js va con labouter/inner, no con labouter');
  assert.deepStrictEqual(r.counts, { withEntry: 2, coveredByFolder: 2 });
  // y en el otro orden del mapa, lo mismo
  assert.deepStrictEqual(mapVsMeasurement([...entries].reverse(), items).problems, []);
});

// ── T2 ·los reemplazos que cambian de carpeta: el require y el .ps1 (AC 2; los dos huecos de T20 de la 8.9) ─────────
test('T2 Restructure_Shims_ComputedRelativePathAndMdForm', () => {
  const repo = tmp('shims-r1');
  write(repo, {
    'scripts/tools/req-tool.js': [
      '#!/usr/bin/env node',
      "'use strict';",
      "const path = require('path');",
      'if (require.main === module) { console.log("main"); process.exit(3); }',
      'module.exports = { answer: 42, file: path.basename(__filename) };',
      '',
    ].join('\n'),
    'scripts/tools/ps-tool.ps1': 'Write-Output ("ps:" + ($args -join ","))\nexit 6\n',
  });
  const oldJs = `scripts/${W.viejo}-req.js`;
  const oldPs = `scripts/lab/${W.viejo}.ps1`;
  write(repo, { 'renames.json': mapOf([
    { kind: 'file', old: oldJs, new: 'scripts/tools/req-tool.js', batch: 'lab', callers: ['machine'] },
    { kind: 'file', old: oldPs, new: 'scripts/tools/ps-tool.ps1', batch: 'lab', callers: ['machine'] },
  ]) });
  const gen = spawnSync(process.execPath, [LIB, '--write-shims', '--map', path.join(repo, 'renames.json'), '--root', repo], { encoding: 'utf8', env: envWith({ HOME: repo }) });
  assert.strictEqual(gen.status, 0, gen.stderr);
  const env = envWith({ HOME: repo });
  // el require desde otra carpeta: el reemplazo viejo devuelve el módulo nuevo (no a sí mismo, no un error de ruta)
  const req = spawnSync(process.execPath, ['-e', `const m = require(${JSON.stringify(path.join(repo, oldJs))}); console.log(m.answer + ':' + m.file)`], { encoding: 'utf8', env });
  assert.strictEqual(req.status, 0, req.stderr);
  assert.strictEqual(req.stdout.trim(), '42:req-tool.js', 'require del viejo, desde otra carpeta, devuelve el módulo nuevo');
  // el .ps1 desde otra carpeta: la ruta relativa sube y baja, con la marca y el código de salida
  const ps1 = fs.readFileSync(path.join(repo, oldPs), 'utf8');
  assert.ok(lib().isShim(ps1), '.ps1: marca en la segunda línea');
  assert.match(ps1, /\$legacyTarget = Join-Path \$PSScriptRoot '\.\.\/tools\/ps-tool\.ps1'\n/, '.ps1: la ruta relativa al nuevo, desde otra carpeta');
  assert.match(ps1, /& \$legacyTarget @args/);
  assert.match(ps1, /exit \$LASTEXITCODE/);
  if (spawnSync('pwsh', ['-v'], { encoding: 'utf8' }).status === 0) {
    const ps = [oldPs, 'scripts/tools/ps-tool.ps1'].map((rel) => spawnSync('pwsh', ['-NoProfile', '-File', path.join(repo, rel), 'c', 'd'], { encoding: 'utf8', env }));
    assert.deepStrictEqual([ps[0].status, ps[0].stdout], [ps[1].status, ps[1].stdout], '.ps1 corrido desde otra carpeta: misma salida y código');
    assert.strictEqual(ps[1].status, 6);
  } else console.log('# T2: sin pwsh en esta máquina — el .ps1 se verificó por lectura');
  fs.rmSync(repo, { recursive: true, force: true });
});

// ── Story 8.12, tanda R1: la mudanza a scripts/setup/ y scripts/hooks/ ──────────────────────────────────────────────
// T10: las 17 entradas R1 del mapa están mudadas de verdad (el nuevo existe y compila; en el viejo, el reemplazo
// generado que apunta al nuevo, o nada si sólo lo nombra su repo), el mapa real valida, y quienes los llaman por ruta
// (el instalador .sh y .ps1, install-codegraph) apuntan a la carpeta nueva y a un archivo que existe.
test('T10 R1_SetupAndHooks_MovedRequiresAndShims', { skip: !TEAM_812 && 'copia pública: sin el mapa' }, () => {
  const L = lib();
  const r1 = JSON.parse(fs.readFileSync(MAP_REAL, 'utf8')).entries.filter((e) => e.batch === 'R1');
  assert.strictEqual(r1.length, 17, 'las 17 entradas de la R1');
  for (const e of r1) {
    const nuevo = path.join(RAIZ, e.new);
    const viejo = path.join(RAIZ, e.old);
    assert.ok(fs.existsSync(nuevo), `${e.new} existe`);
    assert.ok(/^scripts\/(setup|hooks)\//.test(e.new), `${e.new} cae en scripts/setup/ o scripts/hooks/`);
    if (L.needsShim(e)) {
      const texto = fs.readFileSync(viejo, 'utf8');
      assert.ok(L.isGeneratedShim(e.old, texto), `${e.old} es el reemplazo generado, tal cual`);
      assert.strictEqual(path.resolve(L.shimTarget(viejo)), path.resolve(nuevo), `${e.old} lanza ${e.new}`);
    } else assert.ok(!fs.existsSync(viejo), `${e.old} no deja reemplazo (sólo lo nombra su repo)`);
    const chequeo = e.new.endsWith('.js') ? spawnSync(process.execPath, ['--check', nuevo], { encoding: 'utf8' })
      : e.new.endsWith('.sh') ? spawnSync('bash', ['-n', nuevo], { encoding: 'utf8' }) : { status: 0 };
    assert.strictEqual(chequeo.status, 0, `${e.new} compila (${chequeo.stderr || ''})`);
  }
  assert.strictEqual(r1.filter((e) => L.needsShim(e)).length, 16, '16 de 17 dejan reemplazo (decisión del dueño, AC 8)');
  const cm = spawnSync(process.execPath, [SPANISH, '--check-map'], { encoding: 'utf8', cwd: RAIZ, env: { ...process.env, TF_BUILD: '' } });
  assert.strictEqual(cm.status, 0, `--check-map sobre el mapa real (${cm.stderr})`);
  // quienes los llaman por ruta: la carpeta nueva, y el archivo existe
  const sh = fs.readFileSync(path.join(RAIZ, 'scripts', 'install-tycon-hooks.sh'), 'utf8');
  for (const b of ['sync-claude-md-blocks.sh', 'check-engram-version.sh', 'ensure-sqlite3.sh', 'check-engram-project.sh', 'harness-env-publish.sh']) {
    assert.ok(sh.includes(`"$SCRIPT_DIR/setup/${b}"`), `install-tycon-hooks.sh llama ${b} desde setup/`);
    assert.ok(fs.existsSync(path.join(RAIZ, 'scripts', 'setup', b)), `scripts/setup/${b} existe`);
  }
  const ps = fs.readFileSync(path.join(RAIZ, 'scripts', 'install-tycon-hooks.ps1'), 'utf8');
  for (const b of ['sync-claude-md-blocks.ps1', 'check-engram-version.ps1', 'ensure-sqlite3.ps1']) {
    assert.ok(ps.includes(`Join-Path (Join-Path $PSScriptRoot 'setup') '${b}'`), `install-tycon-hooks.ps1 llama ${b} desde setup/`);
  }
  const cg = fs.readFileSync(path.join(RAIZ, 'scripts', 'setup', 'install-codegraph.sh'), 'utf8');
  assert.ok(cg.includes('"$SCRIPT_DIR/../hooks"') && cg.includes('codegraph-session-hook.sh'), 'install-codegraph.sh registra el hook desde scripts/hooks/');
  const cgp = fs.readFileSync(path.join(RAIZ, 'scripts', 'setup', 'install-codegraph.ps1'), 'utf8');
  assert.ok(cgp.includes("(Split-Path -Parent $ScriptDir) 'hooks'"), 'install-codegraph.ps1 registra el hook desde scripts\\hooks\\');
});

// T10 (cont.): un instalador de scripts/setup/ que no encuentra scripts/hooks/ lo DICE y sale ≠ 0 — bajo `set -e`, un
// `cd` relativo que falla dentro de la asignación mataba el script mudo, antes de su propio mensaje (revisor de fallos
// silenciosos, R1).
test('T10 R1_SetupScripts_MissingHooksDirSaysSo', () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-hooks-'));
  try {
    fs.mkdirSync(path.join(lab, 'scripts', 'setup'), { recursive: true });
    fs.copyFileSync(path.join(RAIZ, 'scripts', 'setup', 'install-instinct-mining.sh'), path.join(lab, 'scripts', 'setup', 'install-instinct-mining.sh'));
    const r = spawnSync('bash', [path.join(lab, 'scripts', 'setup', 'install-instinct-mining.sh'), '--check'], {
      encoding: 'utf8', env: { ...process.env, TYCON_SETTINGS_PATH: path.join(lab, 'settings.json') } });
    assert.notStrictEqual(r.status, 0, 'sin scripts/hooks/ no sigue');
    assert.match(r.stderr, /scripts\/hooks/, `dice qué falta (stderr: «${r.stderr}»)`);
    const cg = fs.readFileSync(path.join(RAIZ, 'scripts', 'setup', 'install-codegraph.sh'), 'utf8');
    assert.match(cg, /HOOK_SCRIPT="\$\(cd "\$SCRIPT_DIR\/\.\.\/hooks" 2>\/dev\/null && pwd\)\/codegraph-session-hook\.sh" \|\| HOOK_SCRIPT=""/,
      'install-codegraph.sh: si scripts/hooks/ no resuelve, cae a su aviso «no encuentro» en vez de morir mudo');
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

// T14: el LaunchAgent de harness-env-publish.sh se arma desde scripts/setup/, el caso del banco copia desde ahí, y el
// control de cobertura ya no le exige casos como hook (vive fuera de scripts/hooks/; en la ruta vieja queda su
// reemplazo, que la cobertura reconoce por la marca). El instalador real NO se corre acá: registraría el LaunchAgent de
// la máquina (la etiqueta es fija); el plist se lee del guion y el caso del banco lo corre la suite del banco.
test('T14 R1_HarnessEnvPublish_LaunchAgentFromSetup', { skip: !TEAM_812 && 'copia pública: sin el mapa' }, () => {
  const sh = fs.readFileSync(path.join(RAIZ, 'scripts', 'install-tycon-hooks.sh'), 'utf8');
  assert.match(sh, /ENV_PUBLISH="\$SCRIPT_DIR\/setup\/harness-env-publish\.sh"/, 'el instalador arma el plist con la ruta de setup/');
  assert.ok(!/ENV_PUBLISH="\$TCG_HOOKS_DIR/.test(sh), 'ya no lo busca en scripts/hooks/');
  const caso = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'controls-bench', 'cases', 'hooks', '21-hooks-sueltos.json'), 'utf8'));
  const scripts = JSON.stringify(caso).match(/\$\{TCG\}\/scripts\/[\w/.-]*harness-env-publish\.sh/g) || [];
  assert.deepStrictEqual([...new Set(scripts)], ['${TCG}/scripts/setup/harness-env-publish.sh'], 'el caso del banco copia desde setup/');
  const cov = spawnSync(process.execPath, [path.join(RAIZ, 'build', 'check-hook-coverage.js')], { encoding: 'utf8', cwd: RAIZ });
  assert.strictEqual(cov.status, 0, `check-hook-coverage en verde (${cov.stdout}${cov.stderr})`);
  assert.ok(!/harness-env-publish/.test(`${cov.stdout}${cov.stderr}`), 'la cobertura no le exige casos como hook');
});

// ── Story 8.12, tanda R2: scripts/tools/ ────────────────────────────────────────────────────────────────────────────
// T21 (AC 18): los pasos de skill de agent-skills corren `tycon-worktree.sh` y `tycon-backfill-followups.js` por la ruta
// VIEJA (`~/.claude/tycon-claude-guides/scripts/<nombre>`) y agent-skills no cambia hasta el retiro. En un arnés de
// juguete —las dos herramientas reales en su ruta nueva y el reemplazo generado en la vieja, con las entradas del mapa
// real— cada comando de esos pasos da, por las dos rutas, la misma salida (rutas y fechas normalizadas) y el mismo
// código, y la ruta vieja deja su línea en legacy-names.jsonl.
test('T21 R2_StepCommands_OldAndNewPath_SameOutput', { skip: !TEAM_812 && 'NO MEDIDO — copia pública sin el mapa' }, () => {
  const L = lib();
  const real = JSON.parse(fs.readFileSync(MAP_REAL, 'utf8')).entries;
  const entries = ['tycon-worktree.sh', 'tycon-backfill-followups.js'].map((b) => real.find((e) => e.batch === 'R2' && e.new === `scripts/tools/${b}`));
  assert.ok(entries.every(Boolean), 'el mapa real trae las dos entradas R2 de scripts/tools/');
  assert.ok(entries.every((e) => L.needsShim(e)), 'las dos dejan reemplazo (las corren pasos de skill de otro repo)');
  const [wt, bf] = entries;
  const lab = tmp('r2-tools');
  const home = tmp('r2-tools-home');
  const parents = [];
  try {
    for (const e of entries) {
      fs.mkdirSync(path.dirname(path.join(lab, e.new)), { recursive: true });
      fs.copyFileSync(path.join(RAIZ, e.new), path.join(lab, e.new));
      fs.chmodSync(path.join(lab, e.new), 0o755);
    }
    write(lab, { 'renames.json': mapOf(entries) });
    const gen = spawnSync(process.execPath, [LIB, '--write-shims', '--map', path.join(lab, 'renames.json'), '--root', lab], { encoding: 'utf8', env: envWith({ HOME: lab }) });
    assert.strictEqual(gen.status, 0, gen.stderr);
    for (const e of entries) assert.ok(L.isGeneratedShim(e.old, fs.readFileSync(path.join(lab, e.old), 'utf8')), `${e.old}: el reemplazo generado`);
    const skillsDir = process.env.TYCON_SKILLS_DIR || path.join(os.homedir(), '.claude', 'agent-skills', 'skills');
    const git = { GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab',
      GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };
    const env = envWith({ HOME: home, TYCON_GUIDES_DIR: RAIZ, TYCON_SKILLS_DIR: skillsDir, TYCON_NO_NIGHTLY_EXAM: '1', ...git });
    const norm = (s, roots) => roots.reduce((acc, r) => acc.split(r).join('<RAIZ>'), s).replace(/\d{4}-\d{2}-\d{2}/g, '<FECHA>');
    const realOf = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const same = (label, a, b) => {
      assert.strictEqual(a.status, b.status, `${label}: mismo código (viejo ${a.status}, nuevo ${b.status})`);
      assert.strictEqual(a.out, b.out, `${label}: misma salida`);
      assert.strictEqual(a.err, b.err, `${label}: mismos errores`);
    };

    // tycon-worktree.sh: el paso 0 de tycon-merge-to-main (`merge-tree <target>`), `list` y un uso malo
    const toyRepo = () => {
      const parent = tmp('r2-wt');
      parents.push(parent);
      const repo = path.join(parent, 'lab-repo');
      fs.mkdirSync(repo);
      for (const args of [['init', '-q', '-b', 'dev'], ['commit', '-q', '--allow-empty', '-m', 'lab'], ['branch', 'main']]) {
        const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
        assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      }
      return { repo, roots: [realOf(parent), parent] };
    };
    const runWt = (rel, t, args) => {
      const r = spawnSync('bash', [path.join(lab, rel), ...args], { cwd: t.repo, encoding: 'utf8', env });
      return { status: r.status, out: norm(r.stdout, t.roots), err: norm(r.stderr, t.roots) };
    };
    const tOld = toyRepo();
    const tNew = toyRepo();
    for (const args of [['merge-tree', 'main'], ['merge-tree', 'main'], ['list'], []]) {
      same(`tycon-worktree.sh ${args.join(' ') || '(sin subcomando)'}`, runWt(wt.old, tOld, args), runWt(wt.new, tNew, args));
    }
    assert.ok(fs.existsSync(path.join(path.dirname(tOld.repo), 'lab-repo--merge')), 'por la ruta vieja, el worktree de merge se creó de verdad');

    // tycon-backfill-followups.js: los tres comandos de tycon-story-followup-link (dry-run, --apply, --render-table)
    const storyRepo = () => {
      const root = tmp('r2-bf');
      parents.push(root);
      const story = (rel, fm) => write(root, { [rel]: `---\n${fm.join('\n')}\n---\n\n# story\n` });
      fs.mkdirSync(path.join(root, '.git'));
      story('specs/stories/4-33-padre.md', ['story: "4.33"', 'epic: 4', 'status: done', 'title: "La madre"']);
      story('specs/stories/4-43-hija.md', ['story: "4.43"', 'epic: 4', 'status: ready-for-dev', 'title: "La hija"',
        'followup_of:', '  - id: "4.33"', '    type: fix', '    summary: "lo que faltó"']);
      return { root, roots: [realOf(root), root] };
    };
    const runBf = (rel, t, args) => {
      const r = spawnSync(process.execPath, [path.join(lab, rel), '--dir', path.join(t.root, 'specs', 'stories'), ...args], { cwd: t.root, encoding: 'utf8', env });
      return { status: r.status, out: norm(r.stdout, t.roots), err: norm(r.stderr, t.roots) };
    };
    const sOld = storyRepo();
    const sNew = storyRepo();
    for (const args of [[], ['--story', '4.33', '--render-table'], ['--apply'], []]) {
      same(`tycon-backfill-followups.js ${args.join(' ') || '(dry-run)'}`, runBf(bf.old, sOld, args), runBf(bf.new, sNew, args));
    }
    const parentStory = (t) => fs.readFileSync(path.join(t.root, 'specs/stories/4-33-padre.md'), 'utf8');
    assert.match(parentStory(sOld), /followed_up_by:/, 'por la ruta vieja, --apply escribió el back-link');
    assert.strictEqual(parentStory(sOld), parentStory(sNew), '--apply deja el mismo archivo por las dos rutas');

    // la ruta vieja deja su línea (el reemplazo .sh la anota de fondo)
    const logFile = path.join(home, '.claude', '.tycon-pipeline', 'legacy-names.jsonl');
    const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
    const deadline = Date.now() + 5000;
    while (!entries.every((e) => readLog().includes(`"old":"${e.old}"`)) && Date.now() < deadline) spawnSync('sleep', ['0.2']);
    for (const e of entries) assert.match(readLog(), new RegExp(`"old":"${e.old.replace(/[.]/g, '\\.')}"`), `${e.old} deja su línea en legacy-names.jsonl`);
    assert.ok(!entries.some((e) => readLog().includes(`"old":"${e.new}"`)), 'la ruta nueva no anota nada');
  } finally {
    for (const d of [lab, home, ...parents]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── Story 8.12, tanda R2 (pase adversarial R2, clases 1, 2, 4 y 5): los restos locales no hacen «real» la carpeta vieja ──
// Tras el pull de la mudanza, git borra lo versionado de la carpeta vieja y deja lo que nunca versionó: el log del
// grabador, los descartados, un `.DS_Store`. Eso no es la carpeta de verdad: la entrada está mudada (el control de nombres
// viejos la cuenta y el instalador reescribe), esté lo que quedó sin seguir o ignorado por un `.gitignore`. Un archivo
// que git sí versiona en la vieja sigue haciéndola real (como antes). Nombres de laboratorio.
test('T19d R2Adversarial_LeftoversInOldFolder_UntrackedOrIgnored_StillMoved — adversarial R2: sólo lo versionado hace real la carpeta vieja', () => {
  const root = tmp('r2-leftover');
  const genv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) genv[k] = v;
  Object.assign(genv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.com',
    GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.com' });
  const git = (...args) => {
    const r = spawnSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], { env: genv, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  try {
    const L = lib();
    const folder = { kind: 'folder', old: 'notions', new: 'inbox/notions', batch: 'lab', callers: ['machine'] };
    const scoped = { kind: 'folder', old: 'scripts/notions-old', new: 'scripts/notions', batch: 'lab', callers: ['machine'] };
    write(root, { 'inbox/notions/README.md': '# lab\n', 'scripts/notions/x.js': '// real\n' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'lab');
    // lo que queda en la máquina después del pull: sin seguir (el .gitignore de la carpeta se fue con ella)
    write(root, { 'notions/observer.log': 'log\n', 'notions/observer.err': '', 'notions/descartados/a.md': 'x\n', 'notions/.DS_Store': 'x',
      'scripts/notions-old/observer.log': 'log\n' });
    assert.strictEqual(L.isMoved(folder, root), true, 'carpeta vieja con restos sin seguir: mudada');
    assert.strictEqual(L.isMoved(scoped, root), true, 'la de varios pedazos, igual');
    const rewrites = L.machineRewrites(mapOf([folder]), { guides: root, skills: null, home: os.homedir() });
    assert.ok(rewrites.length > 0 && rewrites.every((r) => r.to.endsWith('/inbox/notions') || r.to.endsWith('\\inbox\\notions')), 'el instalador reescribe la carpeta mudada');
    assert.strictEqual(L.relativePermissionRewrites(mapOf([scoped]), { guides: root }).length, 1, 'los permisos relativos, también');
    // los mismos restos ignorados por la raíz (el `.gitignore` que se suma con la mudanza): igual de mudada
    write(root, { '.gitignore': '/notions/\n/scripts/notions-old/\n' });
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'ignorar');
    assert.strictEqual(L.isMoved(folder, root), true, 'carpeta vieja con restos ignorados: mudada');
    assert.strictEqual(L.isMoved(scoped, root), true, 'la de varios pedazos ignorada, igual');
    // un archivo que git versiona en la vieja la vuelve real, aunque esté ignorada (se agregó a la fuerza)
    write(root, { 'notions/real.md': 'real\n' });
    git('add', '-f', 'notions/real.md');
    assert.strictEqual(L.isMoved(folder, root), false, 'con un archivo versionado: no está mudada');
    assert.strictEqual(L.machineRewrites(mapOf([folder]), { guides: root, skills: null, home: os.homedir() }).length, 0, 'y el instalador no la toca');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// T19e (pase adversarial R2, revisor de fallos silenciosos): «no es un repo de git» (git no está, o dice «not a git
// repository») se mira en el disco, como antes. Cualquier otro fallo de git —«dubious ownership», un permiso, un repo
// roto— frena con un error que lo dice: «no pude preguntar» no es «no hay nada», y caer callado al disco era volver a
// contar los restos de la máquina como la carpeta de verdad.
test('T19e R2AdversarialSilent_GitFailsForReal_StopsInsteadOfFallingBackToDisk — adversarial R2 / silent: sólo «no es un repo» mira el disco', () => {
  const root = tmp('r2-silent');
  const bin = tmp('r2-silent-bin');
  const fakeGit = (body) => { fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(bin, 'git'), 0o755); };
  const savedPath = process.env.PATH;
  try {
    const L = lib();
    const folder = { kind: 'folder', old: 'notions', new: 'inbox/notions', batch: 'lab', callers: ['machine'] };
    write(root, { 'inbox/notions/README.md': '# lab\n', 'notions/observer.log': 'log\n' });
    // un directorio que no es repo, con el git de verdad: el disco, como hoy (el log de la vieja la hace real)
    assert.strictEqual(L.isMoved(folder, root), false, 'sin repo: mira el disco');
    // git falla de verdad: frena, no cae al disco
    fakeGit(`echo "fatal: detected dubious ownership in repository at '${root}'" >&2\nexit 1`);
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    assert.throws(() => L.isMoved(folder, root), (err) => err instanceof L.LegacyNamesError && /dubious ownership/.test(err.message) && /no pude/.test(err.message),
      'un git que falla de verdad frena y dice por qué');
    // el mismo git de mentira diciendo «no es un repo» (128): el disco
    fakeGit('echo "fatal: not a git repository (or any of the parent directories): .git" >&2\nexit 128');
    assert.strictEqual(L.isMoved(folder, root), false, '«not a git repository»: mira el disco');
    // sin git en la máquina: el disco
    fs.rmSync(path.join(bin, 'git'));
    process.env.PATH = bin;
    assert.strictEqual(L.isMoved(folder, root), false, 'sin git: mira el disco');
  } finally {
    process.env.PATH = savedPath;
    for (const d of [root, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── story 8.18 · pase adversarial del tramo 1 (2026-10-04): quien pregunta dónde están las skills no tapa el error ──
// `skillsRepoRoot()` le pregunta a scripts/lib/skills-dir.js, que desde el hallazgo 19 TIRA cuando su vecina
// canonical-path.js está y no carga (antes contestaba «no es un clon unido» y todos leían las skills INSTALADAS). Acá
// quedaba un `catch` que tragaba ese error y volvía a `~/.claude/agent-skills`. Medido: en un clon unido con un
// `require` roto en canonical-path.js, `--migrate-machine --check` salía 0 sin una línea, mirando lo instalado. El valor
// de siempre es SÓLO para la copia que viaja sin skills-dir.js al lado.
// Y los hallazgos 10 y 11: como módulo principal, la línea de comandos corría ANTES del `module.exports`, y su cadena
// de `require` (skills-dir → canonical-path → este archivo a medio cargar) le hacía escribir a Node dos avisos de
// dependencia circular por stderr en cada corrida.
// «El propio clon» sale de dónde vive el archivo: cada caso arma un clon unido de juguete con su copia de las tres
// bibliotecas, y una HOME de juguete con un agent-skills instalado.
const skillsLabs = [];
test.after(() => { for (const d of skillsLabs) fs.rmSync(d, { recursive: true, force: true }); });
function skillsLab() {
  // realpath: en macOS la carpeta temporal es un enlace, y node resuelve los enlaces de lo que importa
  const dir = fs.realpathSync(tmp('skills-root'));
  skillsLabs.push(dir);
  const clone = path.join(dir, 'clone');
  const home = path.join(dir, 'home');
  const inst = path.join(home, '.claude', 'agent-skills');
  const libDir = path.join(clone, 'scripts', 'lib');
  for (const d of [libDir, path.join(clone, 'skills', 'tycon-pipeline'), path.join(clone, 'agents'), path.join(inst, 'skills', 'tycon-pipeline')]) fs.mkdirSync(d, { recursive: true });
  for (const f of ['legacy-names.js', 'skills-dir.js', 'canonical-path.js']) fs.copyFileSync(path.join(RAIZ, 'scripts', 'lib', f), path.join(libDir, f));
  // lo que canonical-path.js importa viaja con ella (story 8.19: el nombre del lugar vive en scripts/setup/harness/place.js)
  fs.mkdirSync(path.join(clone, 'scripts', 'setup', 'harness'), { recursive: true });
  // place.js toma el nombre de tycon-home.js, a su lado (story 8.23)
  for (const f of ['place.js', 'tycon-home.js']) fs.copyFileSync(path.join(RAIZ, 'scripts', 'setup', 'harness', f), path.join(clone, 'scripts', 'setup', 'harness', f));
  // un mapa con una entrada de agent-skills: es la que hace preguntar dónde están las skills
  const map = path.join(dir, 'map.json');
  fs.writeFileSync(map, JSON.stringify(mapOf([{ kind: 'file', old: 'skills/lab/scripts/on-x.js', new: 'skills/lab/scripts/on-y.js', batch: 'lab', callers: ['machine'], repo: 'agent-skills' }])));
  const env = (extra = {}) => envWith({ HOME: home, USERPROFILE: home, ...extra });
  const script = path.join(libDir, 'legacy-names.js');
  return {
    dir, clone, home, inst, map, libDir,
    /** La raíz de agent-skills que usa la biblioteca del clon de juguete, preguntada desde otro proceso. */
    root(extra, opts = {}) {
      const code = 'process.stdout.write(require(process.argv[1]).expand("probe/x.js", { repo: "agent-skills" }, JSON.parse(process.argv[2])))';
      const r = spawnSync(process.execPath, ['-e', code, script, JSON.stringify(opts)], { encoding: 'utf8', env: env(extra) });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
    /** La línea de comandos, con el archivo como módulo principal. */
    cli(args, extra) {
      const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: env(extra) });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
    /** Le agrega a canonical-path.js un `require` a un archivo que no existe (el cambio bajo prueba que se rompió). */
    breakNeighbor(missing) {
      const f = path.join(libDir, 'canonical-path.js');
      const body = fs.readFileSync(f, 'utf8');
      const anchor = "const path = require('path');";
      assert.ok(body.includes(anchor), 'canonical-path.js: no encontré dónde insertar el require roto');
      fs.writeFileSync(f, body.replace(anchor, `${anchor}\nconst moved = require('./${missing}');`));
    },
  };
}

test('5b-19b LegacyNames_SkillsRoot_NeighborPresentButBroken_ErrorSurfaces — con canonical-path.js rota, la raíz de las skills NO cae a lo instalado en silencio', () => {
  // 🔴 rojo previo: `try { … resolveSkillsDirs(…).repo } catch { return ~/.claude/agent-skills }` → contesta lo instalado
  //    con código 0 y stderr vacío.
  const l = skillsLab();
  assert.deepStrictEqual(l.root(), { code: 0, out: path.join(l.clone, 'probe', 'x.js'), err: '' }, 'control: el clon unido sano contesta el propio clon');
  const sane = l.cli(['--migrate-machine', '--check', '--map', l.map]);
  assert.deepStrictEqual([sane.code, sane.out], [0, 'RENAMED:0\n'], `control: la línea de comandos anda en el clon sano: ${sane.err}`);
  l.breakNeighbor('gone-with-the-rename.js');
  const r = l.root();
  assert.notStrictEqual(r.code, 0, `tenía que tirar y contestó: ${r.out}`);
  assert.strictEqual(r.out, '', 'sin respuesta: nadie se queda con la raíz instalada');
  assert.match(r.err, /gone-with-the-rename\.js/, 'nombra el archivo que falta');
  assert.match(r.err, /canonical-path\.js/, 'y la vecina que no cargó');
  // lo mismo por la línea de comandos: «no pude mirar» (2) y el motivo, no un 0 callado
  for (const mode of ['--migrate-machine', '--migrate-bench']) {
    const c = l.cli([mode, '--check', '--map', l.map]);
    assert.strictEqual(c.code, 2, `${mode} salió ${c.code} con: ${c.out}`);
    assert.strictEqual(c.out, '', `${mode} no informa nada como si hubiera mirado`);
    assert.match(c.err, /gone-with-the-rename\.js/, `${mode} nombra el archivo que falta`);
  }
});

test('5b-19b — los espejos sanos: sin skills-dir.js al lado, lo de siempre; y quien dice dónde están las skills no necesita a la vecina', () => {
  const l = skillsLab();
  l.breakNeighbor('gone-with-the-rename.js');
  // la variable gana sin cargar a la vecina
  const other = path.join(l.dir, 'other');
  fs.mkdirSync(path.join(other, 'skills'), { recursive: true });
  assert.deepStrictEqual(l.root({ TYCON_SKILLS_DIR: other }), { code: 0, out: path.join(other, 'probe', 'x.js'), err: '' });
  // la raíz pasada a mano tampoco le pregunta a nadie
  assert.deepStrictEqual(l.root({}, { skillsRoot: other }), { code: 0, out: path.join(other, 'probe', 'x.js'), err: '' });
  const c = l.cli(['--migrate-machine', '--check', '--map', l.map, '--skills', other]);
  assert.deepStrictEqual([c.code, c.err], [0, ''], '--skills dice dónde están: no hace falta saber si el clon es unido');
  // la copia que viaja SIN skills-dir.js (un laboratorio con la biblioteca sola): ~/.claude/agent-skills, sin error
  fs.rmSync(path.join(l.libDir, 'skills-dir.js'));
  assert.deepStrictEqual(l.root(), { code: 0, out: path.join(l.inst, 'probe', 'x.js'), err: '' });
  const alone = l.cli(['--migrate-machine', '--check', '--map', l.map]);
  assert.deepStrictEqual([alone.code, alone.out, alone.err], [0, 'RENAMED:0\n', '']);
});

test('5b-19b — un skills-dir.js que ESTÁ y rompe al cargarse tampoco se lee como «no está»: el error sale', () => {
  // 🔴 rojo previo: el mismo `catch` → lo instalado, callado.
  const l = skillsLab();
  fs.writeFileSync(path.join(l.libDir, 'skills-dir.js'), 'throw new Error("biblioteca rota a propósito")\n');
  const r = l.root();
  assert.notStrictEqual(r.code, 0, `tenía que tirar y contestó: ${r.out}`);
  assert.strictEqual(r.out, '');
  assert.match(r.err, /biblioteca rota a propósito/);
});

test('5b-10 LegacyNames_AsMainModule_NoCircularDependencyWarnings — la línea de comandos en un clon unido, sin variable, no escribe avisos de dependencia circular', () => {
  // 🔴 rojo previo: el bloque `if (require.main === module)` antes del `module.exports` → 2 avisos por corrida
  //    («Accessing non-existent property … of module exports inside circular dependency»), con el resultado correcto.
  const l = skillsLab();
  const machine = l.cli(['--migrate-machine', '--check', '--map', l.map]);
  assert.doesNotMatch(machine.err, /circular dependency/i, `--migrate-machine: ${machine.err}`);
  assert.deepStrictEqual(machine, { code: 0, out: 'RENAMED:0\n', err: '' });
  const bench = l.cli(['--migrate-bench', '--check', '--map', l.map]);
  assert.doesNotMatch(bench.err, /circular dependency/i, `--migrate-bench: ${bench.err}`);
  assert.deepStrictEqual([bench.code, bench.err], [0, '']);
  assert.match(bench.out, /^por migrar: 0 archivo\(s\) del banco/);
});

test('5b-10 — los espejos sanos: la línea de comandos sigue contestando y fallando igual, e importar el módulo no la corre', () => {
  const l = skillsLab();
  // un error de uso sigue siendo «no pude mirar» (2), con su motivo
  const bad = l.cli(['--no-such-option']);
  assert.deepStrictEqual([bad.code, bad.out], [2, '']);
  assert.match(bad.err, /⛔ legacy-names: opción desconocida: --no-such-option/);
  const none = l.cli([]);
  assert.strictEqual(none.code, 2);
  assert.match(none.err, /falta qué hacer/);
  // importado, exporta todo y no imprime ni termina el proceso
  const code = 'const m = require(process.argv[1]); process.stdout.write(typeof m.readEnv + " " + typeof m.migrateMachine + " sigue")';
  const r = spawnSync(process.execPath, ['-e', code, path.join(l.libDir, 'legacy-names.js')], { encoding: 'utf8', env: envWith({ HOME: l.home, USERPROFILE: l.home }) });
  assert.deepStrictEqual([r.status, r.stdout, r.stderr], [0, 'function function sigue', '']);
});

// ── story 8.19 · T11: las plantillas de los envoltorios nombran SÓLO el lugar, y los versionados son lo que se genera ──
// Las tres plantillas buscaban la biblioteca para anotar un uso en ~/.claude/<nombre viejo>. Desde la 8.19 el lugar es
// ~/.claude/tycon-harness: las plantillas nombran sólo ése (un segundo intento por el viejo no agrega nada: anotar el uso
// nunca rompe), y los envoltorios del repo se regeneran con --write-shims, nunca a mano.
test('T11 Shims_TemplatesPlaceOnly_VersionedEqualGenerated (story 8.19)', () => {
  const L = lib();
  const P = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'place.js'));
  const listed = spawnSync('git', ['-C', RAIZ, 'grep', '-l', '-I', L.SHIM_MARK], { encoding: 'utf8' });
  assert.strictEqual(listed.status, 0, listed.stderr);
  let n = 0;
  for (const rel of listed.stdout.split('\n').filter(Boolean)) {
    const text = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
    if (!L.isShim(text)) continue;
    n++;
    assert.ok(L.isGeneratedShim(rel, text), `${rel}: el envoltorio versionado no es lo que escribe --write-shims (regeneralo)`);
    assert.ok(!text.includes(`.claude/${P.LEGACY_PLACE_NAME}`) && !text.includes(`'.claude', '${P.LEGACY_PLACE_NAME}'`), `${rel}: nombra el lugar viejo`);
  }
  // la copia pública no trae el mapa de renombres ni los envoltorios (story 8.9): ahí la parte de «los versionados» no se
  // puede medir, y se dice; las plantillas, abajo, se prueban igual en las dos
  if (fs.existsSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'))) assert.ok(n > 50, `pocos envoltorios versionados: ${n}`);
  else console.log(`⏭ T11: NO MEDIDO — los envoltorios versionados (no hay scripts/lib/renames.json: la copia pública; ${n} encontrados)`);
  // las tres plantillas, generadas en un repo de laboratorio
  const repo = tmp('t11');
  write(repo, {
    'scripts/lab/new-a.js': 'module.exports = 1;\n',
    'scripts/lab/new-b.sh': '#!/usr/bin/env bash\nexit 0\n',
    'scripts/lab/new-c.ps1': 'exit 0\n',
    'renames.json': JSON.stringify(mapOf([
      { kind: 'file', old: `scripts/lab/${W.viejo}-a.js`, new: 'scripts/lab/new-a.js', batch: 'lab', callers: ['machine'] },
      { kind: 'file', old: `scripts/lab/${W.viejo}-b.sh`, new: 'scripts/lab/new-b.sh', batch: 'lab', callers: ['machine'] },
      { kind: 'file', old: `scripts/lab/${W.viejo}-c.ps1`, new: 'scripts/lab/new-c.ps1', batch: 'lab', callers: ['machine'] },
    ])),
  });
  const gen = spawnSync(process.execPath, [LIB, '--write-shims', '--map', path.join(repo, 'renames.json'), '--root', repo], { encoding: 'utf8', env: envWith({ HOME: repo }) });
  assert.strictEqual(gen.status, 0, gen.stderr);
  for (const ext of ['a.js', 'b.sh', 'c.ps1']) {
    const text = fs.readFileSync(path.join(repo, 'scripts', 'lab', `${W.viejo}-${ext}`), 'utf8');
    assert.ok(text.includes(P.PLACE_NAME), `la plantilla ${ext} no nombra el lugar`);
    assert.ok(!text.includes(P.LEGACY_PLACE_NAME), `la plantilla ${ext} nombra el viejo`);
  }
  // un segundo --write-shims no cambia nada
  const before = ['a.js', 'b.sh', 'c.ps1'].map((e) => fs.readFileSync(path.join(repo, 'scripts', 'lab', `${W.viejo}-${e}`), 'utf8'));
  spawnSync(process.execPath, [LIB, '--write-shims', '--map', path.join(repo, 'renames.json'), '--root', repo], { encoding: 'utf8', env: envWith({ HOME: repo }) });
  assert.deepStrictEqual(['a.js', 'b.sh', 'c.ps1'].map((e) => fs.readFileSync(path.join(repo, 'scripts', 'lab', `${W.viejo}-${e}`), 'utf8')), before);
  fs.rmSync(repo, { recursive: true, force: true });
});
