'use strict';
/**
 * tycon-home.test.js — la única raíz de las rutas del arnés y el techo de «.claude».
 *
 * El arnés vive en `~/.tycon`, fuera de la carpeta de cualquier herramienta. Si cada pieza resolviera un pedazo de la
 * ruta con `.claude` adentro, «.claude» aparecería más de mil veces en el código: la ruta se pide a UN lugar y el resto
 * no la escribe a mano.
 *
 * Qué fija:
 *   T1  cada función de tycon-home.js da lo de hoy; `home()` sale de `os.homedir()` + `.tycon`; `TYCON_HOME` relativa o
 *       vacía es un error que la nombra; el archivo corre copiado suelto (sin el resto del arnés).
 *   T2  las piezas que viajan con el arnés piden su ruta a tycon-home.js y dan la misma ruta que la fórmula de siempre; las
 *       dos que viajan al freno (tycon-config.js, skills-dir.js) dan la misma ruta que tycon-home.js sin pedírsela;
 *       cada variable parcial sigue ganando en su pedazo.
 *   T3  el techo de «.claude»: lo que no es un enchufe de Claude Code ni está en legacy-home-names.json no sube; si baja,
 *       la prueba pide bajar el techo. Re-medir: node scripts/tests/tycon-home.test.js --measure
 * 🔴 Nada toca el HOME real: cada caso arma su HOME en el temporal, en un proceso hijo.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME_JS = path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js');
// el nombre del lugar se lee de su definición, no se escribe: coincide con el del repo público, que vive en un solo
// archivo (T36 de mirror-pipeline.test.sh)
const { PLACE_NAME } = require(HOME_JS);
const CEILING_FILE = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'dot-claude-ceiling.json');
const LEGACY_FILE = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'legacy-home-names.json');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
// `--measure` sólo imprime el techo medido: no registra las pruebas (si no, su salida se mezcla con el JSON)
const MEASURE = process.argv.includes('--measure');
const it = MEASURE ? () => {} : test;

/** Corre `code` en un proceso hijo con el HOME de juguete y devuelve lo que imprime como JSON. */
function inChild(code, { home, env = {} } = {}) {
  const childEnv = Object.assign({}, process.env, env);
  delete childEnv.NODE_TEST_CONTEXT;   // una prueba de node --test adentro de otra daría verde falso
  for (const k of ['TYCON_HOME', 'TYCON_GUIDES_DIR', 'TCG', 'TYCON_SKILLS_DIR']) if (!(k in env)) delete childEnv[k];
  if (home) { childEnv.HOME = home; childEnv.USERPROFILE = home; }
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: childEnv });
  assert.strictEqual(r.status, 0, `el proceso hijo falló:\n${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout);
}
const req = (rel) => JSON.stringify(path.join(ROOT, ...rel.split('/')));

/** Un clon de juguete del arnés: lo que el criterio de «clon válido» pide. */
function fakeClone(dir) {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/sh\n');
  return fs.realpathSync(dir);
}

// ── T33 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
it('T33 NodeDelArnes_Rutas_YCopiasDeclaradas @story-8.39 @ac-2 @ac-26', () => {
  const home = fs.realpathSync(tmp('tycon-home-t33-'));
  const abs = path.join(home, 'otra-casa');
  const got = inChild(`const H = require(${JSON.stringify(HOME_JS)});
    const p = (o) => { const x = H.harnessNode(o); return { dir: x.dir, current: x.current, bin: x.bin, versions: x.versions, v: x.binIn(require('path').join(x.versions, 'v1')) }; };
    console.log(JSON.stringify({ posix: p({ platform: 'darwin' }), win: p({ platform: 'win32' }), own: p({ platform: 'linux', env: { TYCON_HOME: ${JSON.stringify(abs)} } }) }))`, { home });
  assert.strictEqual(got.posix.dir, path.join(home, '.tycon', 'node'));
  assert.strictEqual(got.posix.current, path.join(home, '.tycon', 'node', 'current'));
  assert.strictEqual(got.posix.bin, path.join(home, '.tycon', 'node', 'current', 'bin', 'node'), 'posix: bin/node por current');
  assert.strictEqual(got.win.bin, path.join(home, '.tycon', 'node', 'current', 'node.exe'), 'Windows: node.exe suelto por current');
  assert.strictEqual(got.posix.v, path.join(home, '.tycon', 'node', 'versions', 'v1', 'bin', 'node'));
  assert.strictEqual(got.own.dir, path.join(abs, 'node'), 'TYCON_HOME manda');
  // cada copia escrita de la regla dice lo mismo (fixtures/harness-node-copies.json)
  const copies = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'fixtures', 'harness-node-copies.json'), 'utf8')).copies;
  assert.ok(copies.length >= 4, 'las cuatro copias declaradas');
  for (const c of copies) {
    const text = fs.readFileSync(path.join(ROOT, ...c.file.split('/')), 'utf8');
    for (const n of c.needles) assert.ok(text.includes(n), `${c.file}: no trae «${n}» (la regla de la ruta del Node del arnés)`);
  }
});

// ── T1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
it('T1 TyconHome_PerFunctionTodayValues_HomeFromOsHomedir_RelativeRefused_NoDeps', () => {
  const home = fs.realpathSync(tmp('tycon-home-t1-'));
  const clone = fakeClone(path.join(home, 'clon'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(clone, path.join(home, '.claude', PLACE_NAME), 'dir');
  const got = inChild(`const H = require(${JSON.stringify(HOME_JS)}); const h = ${JSON.stringify(home)};
    console.log(JSON.stringify({ harness: H.harnessDir(h), state: H.stateDir(h), config: H.configFile(h), backups: H.backupsDir(h),
      skills: H.installedSkillsDir(h), place: H.placePath(h), legacy: H.legacyPlacePath(h), home: H.home(), osHome: require('os').homedir() }));`, { home });
  const claude = path.join(home, '.claude');
  assert.strictEqual(got.harness, clone, 'harnessDir() = lo que resuelve hoy el lugar');
  assert.strictEqual(got.state, path.join(claude, '.tycon-pipeline'));
  assert.strictEqual(got.config, path.join(claude, 'tycon.json'));
  assert.strictEqual(got.backups, path.join(claude, '.tycon-pipeline', 'harness', 'backups'));
  assert.strictEqual(got.skills, path.join(claude, 'agent-skills'));
  assert.strictEqual(got.place, path.join(claude, PLACE_NAME));
  assert.strictEqual(got.legacy, path.join(claude, 'tycon-claude-guides'));
  assert.strictEqual(got.home, path.join(got.osHome, '.tycon'), 'home() sale de os.homedir()');
  // sin nada en el lugar, harnessDir() no inventa una carpeta
  const empty = fs.realpathSync(tmp('tycon-home-t1-empty-'));
  assert.strictEqual(inChild(`console.log(JSON.stringify(require(${JSON.stringify(HOME_JS)}).harnessDir(${JSON.stringify(empty)})))`, { home: empty }), null);

  // HOME y USERPROFILE distintos: manda el que lee os.homedir() en esta plataforma (en Windows, USERPROFILE)
  const a = fs.realpathSync(tmp('tycon-home-t1-a-')); const b = fs.realpathSync(tmp('tycon-home-t1-b-'));
  const two = inChild(`const H = require(${JSON.stringify(HOME_JS)}); console.log(JSON.stringify({ home: H.home(), osHome: require('os').homedir() }))`,
    { env: { HOME: a, USERPROFILE: b } });
  assert.strictEqual(two.home, path.join(process.platform === 'win32' ? b : a, '.tycon'));
  assert.strictEqual(two.home, path.join(two.osHome, '.tycon'));

  // TYCON_HOME: absoluta vale; relativa o vacía es un error que la nombra
  const abs = path.join(home, 'otra');
  assert.strictEqual(inChild(`console.log(JSON.stringify(require(${JSON.stringify(HOME_JS)}).home()))`, { home, env: { TYCON_HOME: abs } }), abs);
  for (const bad of ['relativa/x', '', '   ']) {
    const r = inChild(`const H = require(${JSON.stringify(HOME_JS)});
      try { H.home(); console.log(JSON.stringify({ threw: false })); } catch (e) { console.log(JSON.stringify({ threw: true, name: e.name, msg: e.message })); }`,
    { home, env: { TYCON_HOME: bad } });
    assert.ok(r.threw, `TYCON_HOME=${JSON.stringify(bad)} no frenó`);
    assert.strictEqual(r.name, 'TyconHomeError');
    assert.ok(r.msg.includes('TYCON_HOME'), `el error no nombra la variable: ${r.msg}`);
  }

  // sin dependencias: sólo módulos de Node, y corre copiado suelto a un temporal
  const src = fs.readFileSync(HOME_JS, 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(requires)].sort(), ['fs', 'os', 'path'], `tycon-home.js carga algo más que Node: ${requires.join(', ')}`);
  const loose = tmp('tycon-home-t1-loose-');
  fs.copyFileSync(HOME_JS, path.join(loose, 'tycon-home.js'));
  const l = inChild(`console.log(JSON.stringify(require(${JSON.stringify(path.join(loose, 'tycon-home.js'))}).stateDir(${JSON.stringify(home)})))`, { home });
  assert.strictEqual(l, path.join(claude, '.tycon-pipeline'));
  for (const d of [home, empty, a, b, loose]) fs.rmSync(d, { recursive: true, force: true });
});

// ── T2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
it('T2 FivePieces_AskTyconHome_PartialVarsStillWin_SameOutputs', () => {
  const home = fs.realpathSync(tmp('tycon-home-t2-'));
  const claude = path.join(home, '.claude');
  const clone = fakeClone(path.join(home, 'clon'));
  const other = fakeClone(path.join(home, 'otro-clon'));
  fs.mkdirSync(path.join(claude, 'agent-skills', 'skills'), { recursive: true });
  fs.symlinkSync(clone, path.join(claude, PLACE_NAME), 'dir');
  const skillsVar = path.join(home, 'mis-skills');
  fs.mkdirSync(path.join(skillsVar, 'skills'), { recursive: true });

  const got = inChild(`
    const P = require(${req('scripts/setup/harness/place.js')});
    const S = require(${req('scripts/setup/harness/state.js')});
    const SN = require(${req('scripts/setup/harness/snapshot.js')});
    const C = require(${req('scripts/lib/tycon-config.js')});
    const K = require(${req('scripts/lib/skills-dir.js')});
    const HP = require(${req('skills/tycon-pipeline/scripts/lib/harness-path.js')});
    const h = ${JSON.stringify(home)};
    console.log(JSON.stringify({ place: P.placePath(h), legacy: P.legacyPlacePath(h), resolved: P.resolvePlace({ home: h }).dir,
      state: S.paths(h).dir, backups: SN.backupsRoot(h), config: C.rutaMaquina(h),
      skills: K.resolveInstalledSkillsDirs('').repo, skillsVar: K.resolveInstalledSkillsDirs(${JSON.stringify(skillsVar)}).source,
      hp: HP.resolver({ home: h, env: {} }).dir, hpVar: HP.resolver({ home: h, env: { TYCON_GUIDES_DIR: ${JSON.stringify(other)} } }).dir }));`, { home });
  // la fórmula de siempre, escrita acá a propósito: es contra lo que se compara
  assert.strictEqual(got.place, path.join(claude, PLACE_NAME));
  assert.strictEqual(got.legacy, path.join(claude, 'tycon-claude-guides'));
  assert.strictEqual(got.resolved, clone);
  assert.strictEqual(got.state, path.join(claude, '.tycon-pipeline'));
  assert.strictEqual(got.backups, path.join(claude, '.tycon-pipeline', 'harness', 'backups'));
  assert.strictEqual(got.config, path.join(claude, 'tycon.json'));
  assert.strictEqual(got.skills, path.join(claude, 'agent-skills'));
  assert.strictEqual(got.hp, clone);
  // cada variable parcial gana en su pedazo
  assert.strictEqual(got.skillsVar, 'variable', 'TYCON_SKILLS_DIR ya no gana');
  assert.strictEqual(got.hpVar, other, 'TYCON_GUIDES_DIR ya no gana');

  // cada pieza pide la ruta: ninguna escribe a mano la carpeta que da tycon-home.js
  const asks = {
    'scripts/setup/harness/place.js': /require\(['"]\.\/tycon-home(?:\.js)?['"]\)/,
    'scripts/setup/harness/state.js': /require\(['"]\.\/tycon-home(?:\.js)?['"]\)/,
    'scripts/setup/harness/snapshot.js': /backupsDir\(/,
    'skills/tycon-pipeline/scripts/lib/harness-path.js': /tycon-home\.js/,
  };
  for (const [f, rx] of Object.entries(asks)) assert.ok(rx.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f}: no le pide la ruta a tycon-home.js`);
  // las dos piezas que viajan con tycon-home.js al lado (la copia fija del programa) no escriben su ruta
  const handWritten = {
    'scripts/setup/harness/state.js': /['"]\.claude['"],\s*['"]\.tycon-pipeline['"]/,
    'scripts/setup/harness/place.js': /['"]\.claude['"]/,
  };
  for (const [f, rx] of Object.entries(handWritten)) assert.ok(!rx.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f}: sigue armando la ruta a mano`);

  // tycon-config.js y skills-dir.js viajan también al freno de producción y no le piden la ruta a tycon-home.js (cambiarlas
  // obligaría a reinstalar el freno): dan la misma ruta que tycon-home.js.
  const sameAsHome = inChild(`const H = require(${JSON.stringify(HOME_JS)}); const h = ${JSON.stringify(home)};
    console.log(JSON.stringify({ config: H.configFile(h), skills: H.installedSkillsDir(h) }));`, { home });
  assert.deepStrictEqual({ config: got.config, skills: got.skills }, sameAsHome, 'tycon-config.js o skills-dir.js se desfasaron de tycon-home.js');

  // harness-path.js en un clon de skills APARTE (sin scripts/ al lado): sigue con su copia declarada, y resuelve igual
  const sep = tmp('tycon-home-t2-sep-');
  const hpCopy = path.join(sep, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'harness-path.js');
  fs.mkdirSync(path.dirname(hpCopy), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'harness-path.js'), hpCopy);
  const sepGot = inChild(`console.log(JSON.stringify(require(${JSON.stringify(hpCopy)}).resolver({ home: ${JSON.stringify(home)}, env: {} }).dir))`, { home });
  assert.strictEqual(sepGot, clone, 'harness-path.js sin tycon-home.js al lado dejó de resolver');
  // y si tycon-home.js ESTÁ al lado y no carga, harness-path.js tira: no sigue callado con su copia
  const brokenHome = path.join(sep, 'scripts', 'setup', 'harness', 'tycon-home.js');
  fs.mkdirSync(path.dirname(brokenHome), { recursive: true });
  fs.writeFileSync(brokenHome, 'module.exports = {;\n');
  const broken = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(hpCopy)})`], { encoding: 'utf8', env: Object.assign({}, process.env, { NODE_TEST_CONTEXT: '' }) });
  assert.notStrictEqual(broken.status, 0, 'harness-path.js cargó con un tycon-home.js roto al lado');
  assert.ok(/SyntaxError/.test(broken.stderr), `el error no dice qué falló:\n${broken.stderr.slice(0, 300)}`);
  for (const d of [home, sep]) fs.rmSync(d, { recursive: true, force: true });
});

// ── T2b: la copia fija del programa nunca queda con un módulo que pide otro que todavía no llegó ──────────────────
// place.js, state.js y snapshot.js cargan ./tycon-home.js: si la copia los llevara en orden alfabético —tycon-home.js
// después—, una copia cortada a mitad dejaría `rollback`/`uninstall` de emergencia rotos
it('T2b FixedCopy_DepsBeforeDependents_CutAnywhereStillLoads', () => {
  const H = require(path.join(ROOT, 'scripts', 'setup', 'harness.js'));
  const files = H.fixedCopyFiles(ROOT);
  const order = files.map((f) => f.id);
  const ids = new Set(order);
  for (const [i, f] of files.entries()) {
    if (!f.id.startsWith('program/')) continue;
    const src = fs.readFileSync(f.src, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      let dep = path.posix.normalize(path.posix.join(path.posix.dirname(f.id), m[1]));
      if (!dep.endsWith('.js')) dep += '.js';
      if (!ids.has(dep)) continue;   // fuera de la copia (lo carga el árbol, no la copia)
      assert.ok(order.indexOf(dep) < i, `${f.id} carga ${dep}, que la copia fija lleva DESPUÉS: una copia cortada en el medio no arranca`);
    }
  }
  assert.strictEqual(order[order.length - 1], 'program/harness.js', 'el programa va último (segunda vuelta de la 8.13, M3)');
  assert.ok(order.indexOf('program/harness/tycon-home.js') < order.indexOf('program/harness/place.js'), 'tycon-home.js antes que place.js');

  // y de verdad: el programa de la copia arranca cortando la copia después de cada archivo (lo que se mide es que
  // ningún prefijo deja un require sin su archivo)
  const lab = tmp('tycon-home-t2b-');
  for (let cut = 1; cut <= files.length; cut++) {
    const dir = path.join(lab, String(cut));
    for (const f of files.slice(0, cut)) { fs.mkdirSync(path.dirname(path.join(dir, f.id)), { recursive: true }); fs.copyFileSync(f.src, path.join(dir, f.id)); }
    // sólo los que cargan con la copia sola (los que piden algo de fuera, como ../../lib/tycon-config.js, no cargan suelto:
    // se cargan del árbol, cuando lo hay)
    const prog = files.slice(0, cut).filter((f) => f.id.startsWith('program/harness/') && !/require\(\s*['"]\.\.\//.test(fs.readFileSync(f.src, 'utf8')));
    for (const f of prog) {
      const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(dir, f.id))})`], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, `cortada después de ${files[cut - 1].id}: ${f.id} no carga:\n${r.stderr.split('\n').slice(0, 4).join('\n')}`);
    }
  }
  fs.rmSync(lab, { recursive: true, force: true });
});

// ── T5 · T6: el estado pide su ruta; los lectores del árbol, la suya ───────────────────────────────────────────────
// La carpeta del estado armada a mano: `path.join(…, '.claude', '.tycon-pipeline' …)` o una ruta '…/.claude/.tycon-pipeline'
const STATE_BUILDER = /['"]\.claude['"]\s*,\s*['"]\.tycon-pipeline['"]|['"`][^'"`\n]*\.claude[\\/]+\.tycon-pipeline(?:[\\/][^'"`\n]*)?['"`]\s*\)|HOME_TYCON\s*,\s*['"]\.tycon-pipeline['"]/;
/** Las líneas de código (sin comentarios ni mensajes) que arman la carpeta del estado a mano. */
function stateBuilders(text) {
  return text.split('\n').map((l, i) => [l, i + 1])
    .filter(([l]) => !/^\s*(\/\/|\*|\/\*|#)/.test(l) && STATE_BUILDER.test(l) && /path\.(join|resolve)\(|HOME_TYCON/.test(l))
    .map(([, n]) => n);
}
it('T5 StateWriters_AskStateDir_SamePaths_FrenoLeftForD', () => {
  const L = legacy();
  const exempt = new Set([...L.entries.map((e) => e.path), ...(L.until_d || []).map((e) => e.path)]);
  for (const e of L.until_d || []) assert.ok(e.why && fs.existsSync(path.join(ROOT, e.path)), `until_d: ${e.path} sin motivo o no existe`);
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '-z', '--', 'scripts', 'skills', 'build'], { encoding: 'utf8' });
  if (r.status !== 0) { console.log('⏭ T5: NO MEDIDO — sin git'); return; }
  const handWritten = [];
  for (const f of r.stdout.split('\0').filter((x) => /\.(js|cjs|mjs)$/.test(x))) {
    if (IS_TEST(f) || exempt.has(f)) continue;
    let text; try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { continue; }
    const lines = stateBuilders(text);
    if (!lines.length) continue;
    // la única excepción: la ruta de siempre como RESPALDO de un archivo que viaja suelto, al lado de la carga de
    // tycon-home.js «si está» (una vez por archivo)
    const fallbackOnly = lines.length === 1 && /tycon-home\.js/.test(text) && /existsSync/.test(text);
    if (!fallbackOnly) handWritten.push(`${f}: líneas ${lines.join(', ')}`);
  }
  assert.deepStrictEqual(handWritten, [], `arman la carpeta del estado a mano (pedíselas a tycon-home.js stateDir()):\n${handWritten.join('\n')}`);

  // la línea del respaldo de los que viajan sueltos se evalúa SOLA, con y sin tycon-home.js al lado, y da la misma ruta:
  // no puede depender de un `fs` u `os` que el archivo declara más abajo o adentro de una función (si dependiera de ellos,
  // la carga de branch-guard-notice.js y de la librería legacy-names.js de las skills reventaría)
  const vm = require('vm');
  const home0 = fs.realpathSync(tmp('tycon-home-t5-decl-'));
  const expected = path.join(home0, '.claude', '.tycon-pipeline');
  const looseOnes = [];
  for (const f of r.stdout.split('\0').filter((x) => /\.(js|cjs|mjs)$/.test(x))) {
    if (IS_TEST(f)) continue;
    const line = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').find((l) => l.startsWith('const stateDirOf = (() => {'));
    if (!line) continue;
    looseOnes.push(f);
    for (const withHome of [true, false]) {
      const dir = withHome ? path.dirname(path.join(ROOT, f)) : tmp('tycon-home-t5-solo-');
      const sandbox = { require, __dirname: dir, path, result: null, process };
      const prevHome = process.env.HOME; process.env.HOME = home0;
      try {
        vm.runInNewContext(`${line.replace(/^const stateDirOf =/, 'result =')}`, sandbox);
        assert.strictEqual(typeof sandbox.result, 'function', `${f}: el respaldo no da una función`);
        assert.strictEqual(sandbox.result(home0), expected, `${f}: ${withHome ? 'con' : 'sin'} tycon-home.js al lado da otra ruta`);
      } finally { process.env.HOME = prevHome; }
    }
  }
  assert.ok(looseOnes.length >= 10, `pocos archivos sueltos encontrados (${looseOnes.length}): la búsqueda no está viendo lo que dice mirar`);
  fs.rmSync(home0, { recursive: true, force: true });

  // el ayudante de las skills: en el repo unido, lo de tycon-home.js; en un clon de skills aparte, la ruta de siempre
  const home = fs.realpathSync(tmp('tycon-home-t5-'));
  const helper = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js');
  const unified = inChild(`console.log(JSON.stringify(require(${JSON.stringify(helper)}).stateDir()))`, { home });
  assert.strictEqual(unified, path.join(home, '.claude', '.tycon-pipeline'));
  const sep = tmp('tycon-home-t5-sep-');
  const copy = path.join(sep, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js');
  fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.copyFileSync(helper, copy);
  assert.strictEqual(inChild(`console.log(JSON.stringify(require(${JSON.stringify(copy)}).stateDir()))`, { home }), unified, 'el ayudante suelto da otra ruta');
  // la carpeta de Claude Code (sus archivos de sesión), igual: unido y suelto dan la misma
  const claudeUnified = inChild(`console.log(JSON.stringify(require(${JSON.stringify(helper)}).claudeDir()))`, { home });
  assert.strictEqual(claudeUnified, path.join(home, '.claude'));
  assert.strictEqual(inChild(`console.log(JSON.stringify(require(${JSON.stringify(copy)}).claudeDir()))`, { home }), claudeUnified, 'el claudeDir suelto da otra ruta');
  for (const d of [home, sep]) fs.rmSync(d, { recursive: true, force: true });
});

it('T6 TreeReaders_AskMaintainedDir_SameToday_NightlyWritersUntouched', () => {
  const H = require(HOME_JS);
  // hoy, el árbol de quien pregunta (el clon que se mantiene, o nada). Con una HOME de laboratorio: con la
  // de la máquina la respuesta dependería de cómo está instalado el arnés ahí (en una máquina con la versión bajada, el
  // clon declarado en su configuración), no del árbol
  const casa = fs.realpathSync(tmp('tycon-home-t6-'));
  assert.strictEqual(H.maintainedDir(casa, ROOT), ROOT);
  fs.rmSync(casa, { recursive: true, force: true });
  for (const f of ['scripts/hooks/retro-pending.js', 'scripts/hooks/retro-staleness-notice.js', 'scripts/hooks/dependencies-notice.js']) {
    assert.ok(/maintainedDir\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f}: no le pide el árbol que se mantiene a tycon-home.js`);
  }
  // los escritores del nocturno siguen escribiendo en el repo (es mantenimiento: viaja por git). No viajan a la copia
  // pública (scripts/nightly/ es del repo interno): ahí esta mitad queda NO MEDIDA, no roja (export-real T23)
  const writers = ['scripts/nightly/watcher/vigilante.js', 'scripts/nightly/dependencies/nightly-dependencies.js'].filter((f) => fs.existsSync(path.join(ROOT, f)));
  if (!writers.length) console.log('  ℹ NO MEDIDO — copia pública sin los escritores del nocturno (scripts/nightly/ no viaja)');
  for (const f of writers) {
    assert.ok(/['"]\.dashboard['"]/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f}: dejó de escribir en .dashboard/ del repo`);
  }
});

// ── T3: el techo de «.claude» ──────────────────────────────────────────────────────────────────────────────────────
// ── el clon de mantenimiento que declara la máquina ────────────────────────────────────────────────────────────────
// `maintainedPath` contesta null para todo lo que no sirve; quien reconoce los repos del arnés o lee de ese clon la
// configuración del merge tiene que poder decir «declara uno y no sirve», que no es «no declara ninguno».
it('T78 (story 8.26) · maintainersClone: distingue «no declara» de «declara y no sirve», y nunca tira', () => {
  const H = require(HOME_JS);
  const lab = tmp('tycon-home-maintainers-');
  const env = (root) => ({ TYCON_HOME: root });
  const write = (name, text) => { const root = path.join(lab, name); fs.mkdirSync(root, { recursive: true }); if (text !== null) fs.writeFileSync(path.join(root, 'config.json'), text); return root; };
  const clone = path.join(lab, 'clone'); fs.mkdirSync(clone);
  assert.deepStrictEqual(H.maintainersClone({ env: env(write('none', null)) }), { declared: false, path: null, problem: null }, 'sin archivo: no declara, sin problema');
  assert.deepStrictEqual(H.maintainersClone({ env: env(write('other', JSON.stringify({ paths: { maintained: clone } }))) }), { declared: false, path: null, problem: null }, 'otra clave no es ésta');
  assert.deepStrictEqual(H.maintainersClone({ env: env(write('ok', JSON.stringify({ paths: { maintainers: ` ${clone} ` } }))) }), { declared: true, path: clone, problem: null });
  const gone = H.maintainersClone({ env: env(write('gone', JSON.stringify({ paths: { maintainers: path.join(lab, 'no-such') } }))) });
  assert.strictEqual(gone.declared, true); assert.match(gone.problem, /no está/);
  const file = path.join(lab, 'a-file'); fs.writeFileSync(file, 'x');
  assert.match(H.maintainersClone({ env: env(write('file', JSON.stringify({ paths: { maintainers: file } }))) }).problem, /no está/, 'un archivo no es una carpeta');
  const rel = H.maintainersClone({ env: env(write('rel', JSON.stringify({ paths: { maintainers: 'clones/x' } }))) });
  assert.strictEqual(rel.declared, true); assert.match(rel.problem, /absoluta/);
  const broken = H.maintainersClone({ env: env(write('broken', '{ "paths": ')) });
  assert.strictEqual(broken.declared, false); assert.match(broken.problem, /no se puede leer/);
  // el problema nunca cita el contenido del archivo (trae un permiso en texto plano)
  const secret = H.maintainersClone({ env: env(write('secret', '{ "github": { "token": "no-se-imprime" }, "paths": ')) });
  assert.doesNotMatch(String(secret.problem), /no-se-imprime/);
  for (const v of ['', 'relativa']) {
    const r = H.maintainersClone({ env: { TYCON_HOME: v } });
    assert.strictEqual(r.declared, false); assert.match(r.problem, /TYCON_HOME/, `TYCON_HOME «${v}» se dice`);
  }
  for (const v of [null, 7, [], {}, '   ']) {
    assert.strictEqual(H.maintainersClone({ env: env(write(`odd-${typeof v}-${String(v).length}`, JSON.stringify({ paths: { maintainers: v } }))) }).declared, false);
  }
});

const SWEEP_DIRS = ['scripts', 'skills', 'agents', 'build', 'adapters', 'integrations'];
const NOT_CODE = /\.(md|txt|png|jpe?g|gif|svg|ico|pdf|woff2?|ttf|trx|bpmn|vdw|xlsx|docx|pptx)$/i;
const IS_TEST = (f) => /(^|\/)(tests?|__tests__|fixtures)\//.test(f) || /\.test\.[a-z0-9]+$/.test(f) || /controls-bench\/cases\//.test(f);
// los enchufes de Claude Code, que se quedan en ~/.claude aunque el arnés se mude
const PLUG_AFTER = /^(?:\.json\b|(?:['"`]\s*,\s*['"`]|[\\/]+)(?:settings\.json|settings\.local\.json|CLAUDE\.md|skills|agents|commands|projects|plugins|channels)\b)/;

// la línea del respaldo de los que viajan sueltos, que T5 evalúa con vm: entera y exacta, salvo el tramo hasta el lector
const FALLBACK_LINE = /^const stateDirOf = \(\(\) => \{ const lib = path\.join\(__dirname, ((?:'[^'\\]+', )*)'tycon-home\.js'\); return require\('fs'\)\.existsSync\(lib\) \? require\(lib\)\.stateDir : \(h\) => path\.join\(h \|\| require\('os'\)\.homedir\(\), '\.claude', '\.tycon-pipeline'\); \}\)\(\);$/;
/** ¿Es la línea del respaldo, y su tramo lleva de verdad al lector de rutas de `root`? */
function isFallbackLine(root, f, line) {
  const m = FALLBACK_LINE.exec(line);
  if (!m) return false;
  const parts = [...m[1].matchAll(/'([^'\\]+)'/g)].map((x) => x[1]);
  // se arma como la arma la línea: path.join pega una parte absoluta en vez de volver a la raíz
  return path.join(root, path.dirname(f), ...parts, 'tycon-home.js') === path.join(root, 'scripts', 'setup', 'harness', 'tycon-home.js');
}

/** Las apariciones de «.claude» que no son un enchufe, por archivo, en los archivos rastreados de `root`. */
function measure(root, exempt) {
  // «sin git» es también una copia sin .git propio DENTRO de otro repo (un HOME versionado): ahí ls-files sale bien con la
  // lista vacía y el techo bajaría entero de mentira. Se mide sólo en la raíz de su repo.
  const top = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0 || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(root)) return null;
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', ...SWEEP_DIRS], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  // en el árbol armado de los nocturnos (lo privado con el público encima) se mide sólo lo que trajo la superposición
  const brought = require(path.join(ROOT, 'scripts', 'publishing', 'internal-history.js')).broughtByOverlay(root);
  if (brought && brought.size === 0) throw new Error('la superposición no trajo nada: no hay qué medir');
  const files = {};
  for (const f of r.stdout.split('\0').filter(Boolean)) {
    if (NOT_CODE.test(f) || IS_TEST(f) || exempt.has(f) || (brought && !brought.has(f))) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch (_) { continue; }
    if (text.includes('\0')) continue;
    // los envoltorios de los nombres viejos (legacy-names.js --write-shims) no son código propio: se regeneran solos y
    // llevan el nombre de ANTES del renombre, que la copia publicada no puede nombrar (sin esto, el techo contaría
    // los nombres viejos)
    if (text.split('\n').slice(0, 3).some((l) => l.includes(SHIM_MARK))) continue;
    const lines = [];
    let n = 0;
    text.split('\n').forEach((line, i) => {
      if (isFallbackLine(root, f, line)) return;
      // una RUTA: «.claude» que no viene pegado a un identificador ni a un dominio (`r.tools.claude` y `code.claude.com`
      // no son rutas)
      const rx = /(?<![A-Za-z0-9_.-])\.claude(?![A-Za-z0-9_])/g;
      let m; let hit = false;
      while ((m = rx.exec(line))) if (!PLUG_AFTER.test(line.slice(m.index + m[0].length))) { n++; hit = true; }
      if (hit) lines.push(i + 1);
    });
    if (n) files[f] = { n, lines };
  }
  return files;
}
const legacy = () => JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
const exemptSet = (L) => new Set(L.entries.map((e) => e.path));
// la marca de los envoltorios, de su lista declarada (harness-place-names.json → generated): nunca escrita a mano
const SHIM_MARK = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'fixtures', 'harness-place-names.json'), 'utf8')).generated[0].mark;
/** El veredicto contra el techo: lo que subió (con sus líneas) y lo que bajó. */
function judge(measured, ceiling) {
  const up = []; const down = [];
  for (const [f, { n, lines }] of Object.entries(measured)) {
    const was = ceiling.files[f] || 0;
    if (n > was) up.push(`${f}: ${was} → ${n} (líneas ${lines.join(', ')})`);
    else if (n < was) down.push(`${f}: ${was} → ${n}`);
  }
  for (const [f, was] of Object.entries(ceiling.files)) if (!measured[f]) down.push(`${f}: ${was} → 0`);
  const total = Object.values(measured).reduce((a, x) => a + x.n, 0);
  return { up, down, total };
}
/** El veredicto del techo en `root`, o null sin git. Se mide donde se escribe el código, también en el público. */
function ceilingVerdict(root, ceiling, exempt) {
  const measured = measure(root, exempt);
  if (!measured) return null;
  // en el árbol armado, un archivo donde el privado conserva el suyo no se midió: su techo no se compara
  const brought = require(path.join(ROOT, 'scripts', 'publishing', 'internal-history.js')).broughtByOverlay(root);
  const files = brought ? Object.fromEntries(Object.entries(ceiling.files).filter(([f]) => brought.has(f))) : ceiling.files;
  return judge(measured, { ...ceiling, files });
}
function ceilingJson(measured, previous) {
  const files = Object.fromEntries(Object.entries(measured).sort(([a], [b]) => a.localeCompare(b)).map(([f, x]) => [f, x.n]));
  return Object.assign({}, previous, { total: Object.values(files).reduce((a, b) => a + b, 0), files });
}

it('T3 DotClaudeCeiling_NeverRises_ClassBAndLegacyExempt', () => {
  const L = legacy();
  for (const e of L.entries) {
    assert.ok(e.path && fs.existsSync(path.join(ROOT, e.path)), `legacy-home-names.json: ${e.path} no existe`);
    assert.ok(e.why && e.why.length > 10, `legacy-home-names.json: ${e.path} sin motivo`);
    assert.ok(e.retire_with, `legacy-home-names.json: ${e.path} sin cuándo se retira`);
  }
  const ceiling = JSON.parse(fs.readFileSync(CEILING_FILE, 'utf8'));
  const v = ceilingVerdict(ROOT, ceiling, exemptSet(L));
  if (!v) { console.log('⏭ T3: NO MEDIDO — sin git (la copia instalada): el techo se mide en el repo'); return; }
  assert.deepStrictEqual(v.up, [], `«.claude» subió fuera de los enchufes de Claude Code (pedile la ruta a scripts/setup/harness/tycon-home.js):\n${v.up.join('\n')}`);
  assert.deepStrictEqual(v.down, [], `«.claude» bajó: bajá el techo (node scripts/tests/tycon-home.test.js --measure > ${path.relative(ROOT, CEILING_FILE)}):\n${v.down.join('\n')}`);
  assert.strictEqual(ceiling.total, Object.values(ceiling.files).reduce((a, b) => a + b, 0), 'el total del techo no es la suma de sus archivos');

  // sembradas en un repo de juguete: una aparición nueva frena nombrándola; una sacada pide bajar el techo;
  // un enchufe y un archivo exento no cuentan; las pruebas no cuentan
  const t = tmp('tycon-home-t3-');
  spawnSync('git', ['init', '-q', t]);
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(t, rel)), { recursive: true }); fs.writeFileSync(path.join(t, rel), text); };
  put('scripts/a.js', "const s = path.join(home, '.claude', '.tycon-pipeline');\nconst c = path.join(home, '.claude', 'settings.json');\n");
  put('scripts/b.sh', 'X="$HOME/.claude/tycon.json"\nY="$HOME/.claude/CLAUDE.md"\nZ="$HOME/.claude.json"\n');
  put('scripts/exento.js', "const s = '.claude/.tycon-pipeline';\n");
  put('scripts/tests/c.test.js', "const s = '.claude/x';\n");
  put('scripts/doc.md', '~/.claude/x\n');
  // lo que no es una ruta no cuenta: una propiedad y un dominio
  put('scripts/no-ruta.js', "const a = r.tools.claude;\nconst u = 'https://code.claude.com/docs';\nconst o = cfg.claude;\n");
  // un envoltorio de nombre viejo (por su marca) no cuenta: su nombre no puede salir en lo publicado
  put('scripts/nombre-viejo.js', `#!/usr/bin/env node\n// ${SHIM_MARK} scripts/lib/x.js\nconst p = '~/.claude/tycon-harness';\n`);
  spawnSync('git', ['-C', t, 'add', '-A']);
  const ex = new Set(['scripts/exento.js']);
  // una carpeta sin .git propio dentro de este repo no se mide (no es «bajó todo»)
  fs.mkdirSync(path.join(t, 'adentro', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(t, 'adentro', 'scripts', 'x.sh'), 'X="$HOME/.claude/tycon.json"\n');
  assert.strictEqual(measure(path.join(t, 'adentro'), ex), null, 'una copia sin .git propio adentro de otro repo se midió');
  const base = measure(t, ex);
  assert.deepStrictEqual(Object.fromEntries(Object.entries(base).map(([f, x]) => [f, x.n])), { 'scripts/a.js': 1, 'scripts/b.sh': 1 });
  const ceil = ceilingJson(base, {});
  assert.deepStrictEqual(judge(base, ceil), { up: [], down: [], total: 2 });
  put('scripts/a.js', "const s = path.join(home, '.claude', '.tycon-pipeline');\nconst n = '~/.claude/nuevo';\n");
  spawnSync('git', ['-C', t, 'add', '-A']);
  const rose = judge(measure(t, ex), ceil);
  assert.deepStrictEqual(rose.up, ['scripts/a.js: 1 → 2 (líneas 1, 2)'], 'una aparición nueva no frena nombrándola');
  put('scripts/b.sh', 'Y="$HOME/.claude/CLAUDE.md"\n');
  spawnSync('git', ['-C', t, 'add', '-A']);
  const fell = judge(measure(t, ex), ceil);
  assert.deepStrictEqual(fell.down, ['scripts/b.sh: 1 → 0'], 'una aparición sacada no pide bajar el techo');
  fs.rmSync(t, { recursive: true, force: true });
});

it('T3b DotClaudeCeiling_OnlyWhatTravels @story-8.112 @ac-4 — en el árbol armado, mide sólo lo que trajo la superposición', (t) => {
  // 🔴 rojo: el informe del banco que guarda el privado sube el techo de una prueba del público
  const { overlayLab } = require('./lib/overlay-lab.js');
  const lab = overlayLab({ privado: { 'scripts/controls-bench/ultimo-banco.json': '{"ruta":"~/.claude/x"}\n' }, publico: { 'scripts/x.js': "const d = '~/.claude/x';\n" } });
  t.after(lab.cleanup);
  assert.deepStrictEqual(Object.keys(measure(lab.root, new Set())), ['scripts/x.js'], 'sólo cuenta lo que trajo el público');
  lab.git(['checkout', '--quiet', lab.tip]);
  assert.deepStrictEqual(Object.keys(measure(lab.root, new Set())), ['scripts/controls-bench/ultimo-banco.json'], 'sin superposición, el árbol entero');
});

it('T3c DotClaudeCeiling_MeasuredWithoutPublicRepos @story-8.128 @ac-3 — sin public-repos.json el techo se mide igual', () => {
  // 🔴 rojo: en el público el techo no se medía y una ruta nueva entraba sin que la frenara ningún pedido
  const t = tmp('tycon-home-t3c-');
  spawnSync('git', ['init', '-q', t]);
  fs.mkdirSync(path.join(t, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(t, 'scripts', 'a.js'), "const d = '~/.claude/nuevo';\n");
  spawnSync('git', ['-C', t, 'add', '-A']);
  assert.ok(!fs.existsSync(path.join(t, 'scripts', 'publishing', 'public-repos.json')));
  assert.deepStrictEqual(ceilingVerdict(t, { files: {} }, new Set()).up, ['scripts/a.js: 0 → 1 (líneas 1)'], 'la suba no se nombró');
  const sinGit = tmp('tycon-home-t3c-sin-git-');
  assert.strictEqual(ceilingVerdict(sinGit, { files: {} }, new Set()), null, 'sin git es «no medido», no un veredicto');
  fs.rmSync(t, { recursive: true, force: true });
  fs.rmSync(sinGit, { recursive: true, force: true });
});

it('T3d DotClaudeCeiling_ExactFallbackLineOnly @story-8.128 @ac-4 — sólo la línea de respaldo exacta, con su tramo al lector, no cuenta', () => {
  // 🔴 rojo: la línea que T5 ya evalúa subía el techo en cada archivo que la copiaba
  const t = tmp('tycon-home-t3d-');
  spawnSync('git', ['init', '-q', t]);
  const line = (parts) => `const stateDirOf = (() => { const lib = path.join(__dirname, ${parts}); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();\n`;
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(t, rel)), { recursive: true }); fs.writeFileSync(path.join(t, rel), text); };
  put('scripts/hooks/exacta.js', line("'..', 'setup', 'harness', 'tycon-home.js'"));
  put('scripts/hooks/parecida.js', line("'..', 'setup', 'harness', 'tycon-home.js'").replace("'.tycon-pipeline'", "'.tycon-pipelinE'"));
  put('scripts/hooks/a-otro-lado.js', line("'..', '..', 'setup', 'harness', 'tycon-home.js'"));
  // path.join pega una parte absoluta detrás de __dirname: nunca llega al lector
  put('scripts/hooks/absoluta.js', line(`'${path.join(t, 'scripts', 'setup', 'harness')}', 'tycon-home.js'`));
  // una coma dentro de una parte es parte del nombre, no un separador
  put('scripts/setup/harness/coma.js', line("'a, b', 'hooks', '..', 'tycon-home.js'"));
  spawnSync('git', ['-C', t, 'add', '-A']);
  const m = measure(t, new Set());
  assert.deepStrictEqual(Object.fromEntries(Object.entries(m).map(([f, x]) => [f, x.n])), { 'scripts/hooks/a-otro-lado.js': 1, 'scripts/hooks/absoluta.js': 1, 'scripts/hooks/parecida.js': 1, 'scripts/setup/harness/coma.js': 1 });
  fs.rmSync(t, { recursive: true, force: true });
});

it('T3e DotClaudeCeiling_PrivateOwnFile_NotCompared @story-8.128 @ac-6 — en el árbol armado, el techo de un archivo que el privado conserva no pide bajar', (t) => {
  // 🔴 rojo: el privado conserva su propio archivo, no se mide, y el techo del público pedía bajarlo
  const { overlayLab } = require('./lib/overlay-lab.js');
  const lab = overlayLab({ privado: { 'scripts/propio.json': '{}\n' }, publico: { 'scripts/x.js': "const d = '~/.claude/x';\n" } });
  t.after(lab.cleanup);
  const v = ceilingVerdict(lab.root, { files: { 'scripts/x.js': 1, 'scripts/propio.json': 2 } }, new Set());
  assert.deepStrictEqual([v.up, v.down], [[], []], 'el archivo del privado no se compara');
  lab.git(['checkout', '--quiet', lab.tip]);
  assert.deepStrictEqual(ceilingVerdict(lab.root, { files: { 'scripts/propio.json': 2 } }, new Set()).down, ['scripts/propio.json: 2 → 0'], 'sin superposición se compara como siempre');
});

// ── T37: el retiro tiene fecha y story ─────────────────────────────────────────────────────────────────────────────
// Cada ruta vieja declarada en legacy-home-names.json —las `entries` que definen la ruta de hoy y las `until_d` que
// quedan como respaldo— lleva `retire_after` (una fecha, la regla de 30 días que declara `__retiro`) y `retired_by` (la
// story que la retira, escrita aunque no implementada). El techo de «.claude» no baja a cero de una: lo baja esa story,
// por tandas; acá se exige que la deuda esté declarada, no que esté pagada.
it('T37 Retirement_CeilingZero_DatesSet_StoryWritten', () => {
  const L = legacy();
  const all = [...L.entries, ...(L.until_d || [])];
  assert.ok(all.length >= 20, `legacy-home-names.json: ${all.length} rutas viejas declaradas (esperaba las 4 + las 16 de la D)`);
  const stories = new Set();
  for (const e of all) {
    assert.match(String(e.retire_after || ''), /^\d{4}-\d{2}-\d{2}$/, `legacy-home-names.json: ${e.path} sin fecha de retiro (retire_after AAAA-MM-DD)`);
    assert.ok(e.retire_after >= '2026-11-07', `legacy-home-names.json: ${e.path} tiene una fecha anterior a los 30 días de la publicación de la E (2026-11-07)`);
    assert.ok(e.retired_by, `legacy-home-names.json: ${e.path} sin la story que lo retira (retired_by)`);
    stories.add(String(e.retired_by));
  }
  assert.ok(typeof L.__retiro === 'string' && L.__retiro.includes('8.15'), 'legacy-home-names.json: falta __retiro con la regla de la 8.15');
  // la story de retiro existe y nombra lo que retira. Las stories no viajan a la copia pública (specs/** queda afuera):
  // ahí esta parte no se mide, y se dice
  if (!fs.existsSync(path.join(ROOT, 'specs'))) { console.log('⏭ T37: NO MEDIDO (la story de retiro) — la copia pública no trae specs/; se mide en el repo interno'); return; }
  for (const id of stories) {
    const matches = fs.readdirSync(path.join(ROOT, 'specs')).filter((f) => f.startsWith(`story-${id}-`) && f.endsWith('.md'));
    assert.strictEqual(matches.length, 1, `specs/: la story de retiro ${id} tiene que existir una vez (hay ${matches.length})`);
    const text = fs.readFileSync(path.join(ROOT, 'specs', matches[0]), 'utf8');
    // se exige la story ESCRITA; su estado sigue su propio ciclo (draft → ready-for-dev → in-progress → review → done)
    // y esta prueba no vence con él: sólo exige un estado legible
    assert.match(text, /^status:\s*(draft|ready-for-dev|in-progress|review|done)\s*$/m, `${matches[0]}: la story de retiro tiene que tener un estado legible en su frontmatter`);
    for (const needle of ['legacy-home-names.json', 'dot-claude-ceiling.json', 'tycon-claude-guides', '.tycon-pipeline']) {
      assert.ok(text.includes(needle), `${matches[0]}: no nombra «${needle}»`);
    }
  }
});

if (require.main === module && process.argv.includes('--measure')) {
  const L = legacy();
  const m = measure(ROOT, exemptSet(L));
  if (!m) { console.error('sin git: el techo se mide en el repo'); process.exit(1); }
  const previous = fs.existsSync(CEILING_FILE) ? JSON.parse(fs.readFileSync(CEILING_FILE, 'utf8')) : {};
  delete previous.total; delete previous.files;
  process.stdout.write(`${JSON.stringify(ceilingJson(m, previous), null, 2)}\n`);
}
