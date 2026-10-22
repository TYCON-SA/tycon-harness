'use strict';
/**
 * integration-effects.test.js — los textos de los hooks de una integración salen de su manifiesto, y la lista de efectos
 * que lee la instalación junta el archivo con los manifiestos.
 * stable-data: crea commits sólo en un repo temporal y no lee el reloj.
 *
 * POR QUÉ. La lista de efectos (`scripts/setup/install-effects.json`) y los textos del sitio traían, escritos en el núcleo,
 * el título y el qué hace de cada hook de las integraciones: el núcleo nombraba la herramienta. Ahora cada hook lleva sus
 * textos en el manifiesto (`install`) y un solo lector (`managed.readEffects`) los junta con el archivo.
 *
 * QUÉ MIDE. Que cada hook de una integración aparece una sola vez, con los textos de su manifiesto, en la lista, en el
 * modelo de «Cómo trabaja», en el perfil mínimo del aplicador y en la lista leída de una versión de git (T66); y que las
 * entradas de las otras integraciones siguen idénticas a las del archivo (T18).
 *
 * Correr:   node --test scripts/tests/integration-effects.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const M = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'managed.js'));
const INT = require(path.join(ROOT, 'scripts', 'lib', 'integrations.js'));
const FILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'install-effects.json'), 'utf8'));
const MANIFESTS = INT.listManifests({ dir: path.join(ROOT, 'integrations') }).manifests;
// cada hook de una integración que corre en Claude Code, con su id de la lista de efectos y sus textos del manifiesto
const HOOKS = MANIFESTS.flatMap((m) => m.hooks.filter((h) => !h.tools || h.tools.includes('claude'))
  .map((h) => ({ id: `${h.event}:${INT.INT_PREFIX}${m.name}/${h.script}`, install: h.install, m })));

test('T66 HookTexts_FromManifest @story-7.40 @ac-32', () => {
  assert.ok(HOOKS.length >= 4, `hay hooks de integraciones (${HOOKS.length})`);
  const eff = M.readEffects(ROOT);
  assert.ok(eff.ok, eff.reason);
  for (const h of HOOKS) {
    assert.ok(h.install && h.install.title && h.install.en && h.install.en.title && h.install.does && h.install.en.does, `${h.id}: el manifiesto trae sus textos`);
    const e = eff.effects.filter((x) => x.id === h.id);
    assert.strictEqual(e.length, 1, `${h.id}: una sola vez en la lista`);
    assert.strictEqual(e[0].title, h.install.title);
    assert.strictEqual(e[0].does, h.install.does);
    assert.deepStrictEqual(e[0].en, h.install.en);
    assert.strictEqual(e[0].windows, h.m.hooks.find((x) => h.id.endsWith(`/${x.script}`) && h.id.startsWith(`${x.event}:`)).platforms.windows === true);
  }
  // ni el archivo ni los textos del sitio los traen
  assert.ok(!FILE.effects.some((e) => String(e.id || '').includes(INT.INT_PREFIX)), 'install-effects.json sin entradas de integraciones');
  const texts = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'texts.js'), 'utf8');
  assert.ok(!texts.includes(`'control.${INT.INT_PREFIX}`), 'texts.js sin los controles de las integraciones');
  for (const m of MANIFESTS) for (const d of m.dispatch) {
    assert.ok(!texts.includes(`'control.${d.name}'`), `texts.js sin el control «${d.name}» de una integración`);
    assert.ok(d.control && d.control.es && d.control.en, `«${d.name}»: el manifiesto dice qué hace su control`);
  }
  // «Cómo trabaja»: cada control de una integración dice qué hace desde su manifiesto, en los dos idiomas
  const HW = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'how-it-works.js'));
  const { controls } = HW.readControls(ROOT);
  for (const h of HOOKS) {
    const raw = h.m.hooks.find((x) => h.id === `${x.event}:${INT.INT_PREFIX}${h.m.name}/${x.script}`);
    assert.ok(raw.control && raw.control.es && raw.control.en, `${h.id}: el manifiesto dice qué hace su control`);
    const c = controls.find((x) => x.spec === h.id.slice(h.id.indexOf(':') + 1));
    if (!c) continue;   // un hook de un despachador no se muestra suelto
    assert.deepStrictEqual(c.control, raw.control, `${c.spec}: el texto del manifiesto`);
  }
  for (const m of MANIFESTS) for (const d of m.dispatch) {
    const c = controls.find((x) => x.spec === d.name);
    assert.ok(c, `el control «${d.name}» está en el modelo`);
    assert.deepStrictEqual(c.control, d.control);
  }
  // el aplicador: el perfil mínimo cuenta los hooks de los manifiestos que lo declaran
  const AH = require(path.join(ROOT, 'scripts', 'setup', 'apply-hooks.js'));
  const min = AH.loadMinimalIds(path.join(ROOT, 'scripts', 'setup', 'install-effects.json'));
  for (const h of HOOKS) assert.strictEqual(min.has(h.id), h.install.profiles.includes('minimal'), `${h.id} en el perfil mínimo`);
  // la lista de una versión leída de git trae los mismos hooks: la diferencia con la versión nueva no los da por sacados
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-git-'));
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  fs.mkdirSync(path.join(repo, 'scripts', 'setup'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', 'install-effects.json'), path.join(repo, 'scripts', 'setup', 'install-effects.json'));
  for (const m of MANIFESTS) {
    const rel = path.relative(ROOT, m.dir);
    fs.mkdirSync(path.join(repo, rel), { recursive: true });
    fs.copyFileSync(path.join(m.dir, 'integration.json'), path.join(repo, rel, 'integration.json'));
  }
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'x');
  const at = M.effectsAtCommit(repo, 'HEAD', { tree: ROOT });
  assert.ok(at.ok, at.reason);
  assert.deepStrictEqual(at.effects.map((e) => e.id).sort(), eff.effects.map((e) => e.id).sort());
  // una versión de antes de la mudanza (las entradas en el archivo, sin textos en los manifiestos): se leen igual
  const old = M.mergeEffects({ effects: [...FILE.effects, ...eff.effects.filter((e) => String(e.id || '').includes(INT.INT_PREFIX))] }, []);
  assert.ok(old.ok, old.reason);
});

test('T66b HookTexts_BrokenOrUnreadable_AreSaid @story-7.40 @ac-32', () => {
  const eff = M.readEffects(ROOT);
  const one = eff.effects.find((e) => String(e.id || '').includes(INT.INT_PREFIX));
  // un hook que está en el archivo y en su manifiesto es un id repetido: la entrada del manifiesto se deja afuera y se dice
  const dup = M.mergeEffects({ effects: FILE.effects.concat([one]) }, [one]);
  assert.ok(dup.ok && dup.problems.some((p) => /está también/.test(p)), JSON.stringify(dup.problems));
  assert.strictEqual(dup.effects.filter((e) => e.id === one.id).length, 1);
  // una entrada de manifiesto que no vale no tira abajo la lista: se deja afuera y se dice
  const bad = M.mergeEffects({ effects: FILE.effects }, [Object.assign({}, one, { group: 'horas' })]);
  assert.ok(bad.ok && bad.problems.length === 1 && !bad.effects.some((e) => e.id === one.id), JSON.stringify(bad.problems));
  // la validación del manifiesto: `install`, `control` y `offer` mal escritos lo dejan roto, con su motivo
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-ints-'));
  const hook = { event: 'PostToolUse', matcher: '', script: 'scripts/x.js', platforms: { windows: true }, label: 'x' };
  const man = (name, m) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'integration.json'), JSON.stringify({ name, label: name, kind: 'timeTracking', hooks: [], dispatch: [], skills: [], settings: [], ...m })); };
  man('a1', { hooks: [{ ...hook, install: { does: 'x' } }] });
  man('a2', { hooks: [{ ...hook, install: { title: 't', id: 'x' } }] });
  man('a3', { hooks: [{ ...hook, tools: ['codex'], install: { title: 't' } }] });
  man('a4', { hooks: [{ ...hook, control: { es: 'x' } }] });
  man('a5', { dispatch: [{ on: 'post-edit', name: 'n', script: 'scripts/x.js', control: 'x' }] });
  man('a6', { offer: { does: 'x' } });
  man('a7', { kind: 'toggle', name: 'instincts', offer: { does: 'x', needs: 'y' } });
  fs.renameSync(path.join(dir, 'a7'), path.join(dir, 'instincts'));
  // los textos de `install` con las reglas de la lista de efectos: uno malo deja roto el manifiesto, no la lista
  man('a8', { hooks: [{ ...hook, install: { ...one, id: undefined, kind: undefined, when: undefined, windows: undefined, group: 'horas' } }] });
  man('a9', { kind: 'notify', hooks: [{ ...hook, install: { title: 't' } }] });
  const listing = INT.listManifests({ dir });
  const broken = Object.fromEntries(listing.problems.map((b) => [b.name, b.reasons.join('; ')]));
  for (const [n, rx] of [['a1', /install/], ['a2', /install\.id/], ['a3', /Claude Code/], ['a4', /control/], ['a5', /control/], ['a6', /offer/], ['instincts', /offer/], ['a8', /group/], ['a9', /horas o de prender/]]) {
    assert.match(broken[n] || '', rx, `${n}: ${JSON.stringify(broken)}`);
  }
  // un árbol con un manifiesto roto: la lista sale, sin sus hooks, y lo dice
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-tree-'));
  fs.mkdirSync(path.join(tree, 'scripts', 'setup'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', 'install-effects.json'), path.join(tree, 'scripts', 'setup', 'install-effects.json'));
  fs.mkdirSync(path.join(tree, 'scripts', 'lib'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'scripts', 'lib', 'integrations.js'), path.join(tree, 'scripts', 'lib', 'integrations.js'));
  fs.mkdirSync(path.join(tree, 'integrations', 'rota'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'integrations', 'rota', 'integration.json'), '{rota');
  const r = M.readEffects(tree);
  assert.ok(r.ok && r.problems.some((p) => /rota/.test(p)), JSON.stringify(r.problems));
  // la biblioteca que está y no carga: se dice
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-tree-'));
  fs.mkdirSync(path.join(t2, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(t2, 'scripts', 'lib', 'integrations.js'), 'throw new Error("rota");');
  assert.ok(M.manifestEffects(t2).problems.some((p) => /no pude cargar/.test(p)));
  // una versión de git con un manifiesto sin la clave `hooks` (opcional, como en el disco): se lee, sin hooks de él
  {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-git-'));
    const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    fs.mkdirSync(path.join(repo, 'scripts', 'setup'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', 'install-effects.json'), path.join(repo, 'scripts', 'setup', 'install-effects.json'));
    fs.mkdirSync(path.join(repo, 'integrations', 'x'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'integrations', 'x', 'integration.json'), JSON.stringify({ name: 'x', label: 'X', kind: 'notify' }));
    git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'x');
    const at = M.effectsAtCommit(repo, 'HEAD', { tree: ROOT });
    assert.ok(at.ok, at.reason);
  }
  // una versión de git con un manifiesto ilegible, o con `hooks` que no es una lista: la diferencia no se arma a medias
  for (const [content, rx] of [['{rota', /ilegible/], [JSON.stringify({ name: 'x', hooks: 'y' }), /lista de hooks/]]) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-git-'));
    const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    fs.mkdirSync(path.join(repo, 'scripts', 'setup'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', 'install-effects.json'), path.join(repo, 'scripts', 'setup', 'install-effects.json'));
    fs.mkdirSync(path.join(repo, 'integrations', 'x'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'integrations', 'x', 'integration.json'), content);
    git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'x');
    const at = M.effectsAtCommit(repo, 'HEAD', { tree: ROOT });
    assert.ok(!at.ok && rx.test(at.reason), at.reason);
    // y sin una biblioteca que sepa leerlos, tampoco
    const sin = M.effectsAtCommit(repo, 'HEAD', { tree: fs.mkdtempSync(path.join(os.tmpdir(), 'effects-nolib-')) });
    assert.ok(!sin.ok && /no pude cargar/.test(sin.reason), sin.reason);
  }
});

test('T66c HowItWorks_ControlWithoutText_ShowsLabelAndSaysIt @story-7.40 @ac-32', () => {
  // un árbol con el arnés real y un manifiesto cuyo hook no trae `control`
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-hiw-'));
  for (const d of ['scripts', 'skills']) fs.symlinkSync(path.join(ROOT, d), path.join(tree, d), 'dir');
  fs.mkdirSync(path.join(tree, 'integrations'));
  for (const m of MANIFESTS) {
    const rel = path.basename(m.dir);
    fs.cpSync(m.dir, path.join(tree, 'integrations', rel), { recursive: true });
  }
  const target = MANIFESTS.find((m) => m.hooks.some((h) => h.control));
  const file = path.join(tree, 'integrations', path.basename(target.dir), 'integration.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const h = raw.hooks.find((x) => x.control);
  delete h.control;
  fs.writeFileSync(file, JSON.stringify(raw));
  const HW = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'how-it-works.js'));
  const { controls, problems } = HW.readControls(tree);
  const spec = `${INT.INT_PREFIX}${raw.name}/${h.script}`;
  const c = controls.find((x) => x.spec === spec);
  assert.ok(c, spec);
  assert.deepStrictEqual(c.control, { es: h.label, en: h.label });
  assert.ok(problems.some((p) => p.spec === spec && /control/.test(p.message)), JSON.stringify(problems));
  // la página se arma igual
  const TAB = require(path.join(ROOT, 'scripts', 'site', 'tabs', 'how-it-works.js'));
  const html = TAB.renderPage(HW.buildModel({ treeDir: tree, profileDir: null }), { idioma: 'es', publicRepo: null, version: 'v' });
  assert.ok(html.length > 0);
});

test('T66d Harness_IncompleteEffects_AreSaidAndNothingIsDropped @story-7.40 @ac-32', () => {
  const H = require(path.join(ROOT, 'scripts', 'setup', 'harness.js'));
  // un árbol con el arnés real (cada pieza enlazada) y lo que se cambia en cada caso
  const treeWith = ({ brokenManifest = false, brokenLib = false } = {}) => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-h-'));
    for (const d of ['skills', 'build', 'claude-md-blocks', 'adapters', 'agents', 'packs']) if (fs.existsSync(path.join(ROOT, d))) fs.symlinkSync(path.join(ROOT, d), path.join(tree, d), 'dir');
    fs.mkdirSync(path.join(tree, 'scripts', 'lib'), { recursive: true });
    for (const e of fs.readdirSync(path.join(ROOT, 'scripts'))) if (e !== 'lib') fs.symlinkSync(path.join(ROOT, 'scripts', e), path.join(tree, 'scripts', e));
    for (const e of fs.readdirSync(path.join(ROOT, 'scripts', 'lib'))) {
      if (brokenLib && e === 'integrations.js') fs.writeFileSync(path.join(tree, 'scripts', 'lib', e), 'throw new Error("rota");');
      else fs.symlinkSync(path.join(ROOT, 'scripts', 'lib', e), path.join(tree, 'scripts', 'lib', e));
    }
    fs.cpSync(path.join(ROOT, 'integrations'), path.join(tree, 'integrations'), { recursive: true });
    if (brokenManifest) { fs.mkdirSync(path.join(tree, 'integrations', 'rota')); fs.writeFileSync(path.join(tree, 'integrations', 'rota', 'integration.json'), '{rota'); }
    return tree;
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_PROFILE: '0' };
  for (const k of ['TYCON_TIME_TRACKING', 'TYCON_CLOCKIFY', 'TYCON_INTEGRATIONS_DIR']) delete env[k];
  const ctx = { home, env, opts: { yes: true }, platform: process.platform };
  const broken = treeWith({ brokenManifest: true });
  // el doctor dice el manifiesto que no pudo leer
  const said = [];
  H.doctorConfigItems(ctx, broken, { managed: [] }, { ok: false }, (lvl, l) => said.push(`${lvl} ${l}`), {});
  assert.ok(said.some((l) => /^warn .*rota.*sus hooks no se cuentan/.test(l)), said.join('\n'));
  // la quita por perfil no quita nada con la lista incompleta
  const log = [];
  assert.strictEqual(H.dropForProfile(ctx, { managed: [] }, broken, { report: [] }, (l) => log.push(l), 'minimal'), null);
  assert.ok(log.some((l) => /no quito nada/.test(l) && /rota/.test(l)), log.join('\n'));
  // la diferencia de versión: con la lista instalada incompleta no compara; con la nueva incompleta, lo dice
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-git-'));
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  fs.mkdirSync(path.join(repo, 'scripts', 'setup'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', 'install-effects.json'), path.join(repo, 'scripts', 'setup', 'install-effects.json'));
  fs.cpSync(path.join(ROOT, 'integrations'), path.join(repo, 'integrations'), { recursive: true });
  const target = MANIFESTS.find((m) => m.hooks.some((x) => x.install));
  const mf = path.join(repo, 'integrations', path.basename(target.dir), 'integration.json');
  const raw = JSON.parse(fs.readFileSync(mf, 'utf8'));
  raw.hooks.find((x) => x.install).install.group = 'horas';
  fs.writeFileSync(mf, JSON.stringify(raw));
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'x');
  const u = { fresh: [{ src: { name: 'harness', dir: repo }, c: { to: 'HEAD' } }] };
  const before = H.behaviorDiff(ctx, { tree: broken }, u);
  assert.ok(before.length === 1 && /instalada/.test(before[0]) && /rota/.test(before[0]), before.join('\n'));
  const after = H.behaviorDiff(ctx, { tree: ROOT }, u);
  assert.ok(after.some((l) => /de la versión nueva, .*group/.test(l)), after.join('\n'));
  // la pregunta de la instalación: sin poder cargar la biblioteca, no ofrece herramientas de horas y lo dice
  const noLib = treeWith({ brokenLib: true });
  const q = H.installQuestions(Object.assign({}, ctx, { opts: { yes: true, profile: 'full' } }), noLib, null);
  assert.ok((q.head || []).some((l) => /no pude cargar scripts\/lib\/integrations\.js/.test(l)), JSON.stringify(q.head || q.lines));
});

test('T18 OtherIntegrationsEffects_Unchanged @story-7.40 @ac-15', () => {
  const eff = M.readEffects(ROOT);
  assert.ok(eff.ok, eff.reason);
  const ids = eff.effects.map((e) => `${e.kind}:${e.id || e.id_pattern}`);
  assert.strictEqual(new Set(ids).size, ids.length, 'ningún id dos veces');
  // las del archivo, idénticas y en su orden; las de los manifiestos, una vez cada una
  const fromFile = eff.effects.filter((e) => !String(e.id || '').includes(INT.INT_PREFIX));
  assert.deepStrictEqual(fromFile, FILE.effects);
  const own = new Set(MANIFESTS.map((m) => m.name));
  for (const k of ['engram', 'codegraph', 'mailbox', 'codex', 'nightly']) {
    assert.ok(!own.has(k), `${k} no es una integración de manifiesto`);
    const mine = eff.effects.filter((e) => e.when === `integration:${k}`);
    assert.deepStrictEqual(mine, FILE.effects.filter((e) => e.when === `integration:${k}`), `${k}: sus entradas no cambian`);
  }
  for (const h of HOOKS) assert.strictEqual(eff.effects.filter((e) => e.id === h.id).length, 1, h.id);
  // la lista de integraciones que ofrece la instalación: las mismas, sin la llave vieja de la herramienta de horas
  const keys = M.readIntegrations(ROOT).map((x) => x.key);
  const timeNames = MANIFESTS.filter((m) => m.kind === 'timeTracking').map((m) => m.name);
  for (const n of timeNames) assert.ok(!keys.includes(n), `la instalación no ofrece la llave vieja «${n}»`);
  for (const k of ['engram', 'codegraph', 'codex']) assert.ok(keys.includes(k), `ofrece ${k}`);
});
