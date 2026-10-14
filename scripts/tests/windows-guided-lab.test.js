'use strict';

/**
 * windows-guided-lab.test.js — los ensayos que siguen la página pública de Windows, con EL PROGRAMA DE VERDAD, en modo
 * de laboratorio (story 8.28: T7, T11 y T16).
 *
 * `windows-guided.test.js` prueba las piezas con datos de juguete. Acá se corre el recorrido entero, como lo corre el
 * pipeline de Windows: `rehearse.js init`, `step onboarding`, `step count-hooks` y `step update`, sobre un ÁRBOL
 * PUBLICADO DE JUGUETE armado desde el árbol de trabajo —los archivos versionados (y los nuevos de la story que
 * todavía no lo están), sin los dos archivos de la capa del equipo, con `version.json`, y con la página y el guion de
 * entrada puestos en su destino con el nombre de un repo de juguete—. Lo sirve el GitHub de juguete como repo PÚBLICO,
 * sin permiso (lo declara la ficha, `lab.auth: none`: la página baja el guion sin credencial); la capa del equipo, el
 * Azure DevOps de juguete, con su permiso de juguete.
 *
 * 🔴 Imitar al exportador vale SÓLO acá. Ese árbol trae además lo interno (`specs/`, `onboarding/`…): NO es lo que se
 * publica. Un verde de esta suite dice que los guiones andan con el programa de verdad; que la copia publicada instala
 * lo dicen el modo de laboratorio sobre la copia del exportador y el pipeline de Windows.
 *
 * Tarda minutos (instala dos veces, con su capa, y abre sesiones). Necesita `git` y `pwsh`: sin ellos se saltea, con
 * constancia. En Windows no corre: ahí corre el ensayo de verdad, y lo que sólo existe en Windows —la línea de arranque
 * con `pwsh`, el PowerShell 5.1, las uniones, las rutas con barra invertida del paso `verify`— lo mide el pipeline.
 * Nunca toca la carpeta de usuario de quien la corre.
 *
 * Correr: env -u NODE_TEST_CONTEXT node --test scripts/tests/windows-guided-lab.test.js
 * Para leer el reporte que deja: TYCON_WINDOWS_GUIDED_KEEP=<carpeta> env -u NODE_TEST_CONTEXT node --test …
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'scripts', 'tests', 'windows');
const L = require(path.join(DIR, 'lab.js'));
const T = require(path.join(DIR, 'team-lab.js'));
const TL = require(path.join(DIR, 'toy-lab.js'));
const GI = require(path.join(DIR, 'guided-install.js'));
const G = require(path.join(DIR, 'guided-page.js'));

const has = (bin) => L.scanPath(bin).length > 0;
// los repos de juguete se arman sin los hooks de git de quien corre la suite (su carpeta global de hooks no es del juguete)
const NO_HOOKS = path.join(os.tmpdir(), 'windows-guided-no-git-hooks');
const SKIP = (process.platform === 'win32' && 'el recorrido de juguete es del modo de laboratorio: en Windows corre el ensayo de verdad')
  || (!has('git') && 'NO MEDIDO — sin git')
  || (!has('pwsh') && 'NO MEDIDO — sin pwsh: la página pide PowerShell 7')
  || (!fs.existsSync(path.join(ROOT, 'getting-started', 'windows.md')) && !fs.existsSync(path.join(ROOT, 'scripts', 'publishing', 'public-files', 'getting-started', 'windows.md')) && 'NO MEDIDO — este árbol no trae la página pública de instalación');
const git = (args, cwd) => spawnSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', `core.hooksPath=${NO_HOOKS}`, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const node = (args, opts = {}) => spawnSync(process.execPath, args, Object.assign({ encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, opts));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const TOY = Object.freeze({ org: 'acme-lab', repo: 'arnes-lab', version: '2030.06.01.1' });
// los archivos de la story que todavía pueden no estar versionados, nombrados uno por uno: nada de lo suelto que haya
// en la carpeta de quien prueba entra al árbol de juguete
const NEW_FILES = Object.freeze([
  'scripts/tests/windows/guided-steps.json', 'scripts/tests/windows/guided-page.js', 'scripts/tests/windows/toy-lab.js', 'scripts/tests/windows/release-photo.js',
  'scripts/tests/windows/guided-install.js', 'scripts/tests/windows/guided-update.js',
]);
// la capa del equipo no viaja en una copia publicada: con ellos adentro, la capa choca
const NOT_PUBLISHED = Object.freeze(['perfil-equipo.json', 'scripts/metrics/corridas-buzon.json']);

/**
 * El árbol publicado de juguete, como un repo de git de un commit: `{ tree, commit }`. Es la única imitación del
 * exportador de toda la story, y vive sólo en esta suite.
 */
function toyPublishedTree(base) {
  const tree = path.join(base, 'toy-published');
  const listed = git(['-C', ROOT, 'ls-files', '-z']);
  assert.strictEqual(listed.status, 0, `git ls-files: ${listed.stderr}`);
  const files = [...new Set([...listed.stdout.split('\0').filter(Boolean), ...NEW_FILES])].filter((rel) => !NOT_PUBLISHED.includes(rel));
  let copied = 0;
  for (const rel of files) {
    const from = path.join(ROOT, rel);
    let st;
    try { st = fs.lstatSync(from); } catch (_) { continue; }   // borrado en el árbol de trabajo
    if (!st.isFile()) continue;
    const to = path.join(tree, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied++;
  }
  assert.ok(copied > 1000, `sólo ${copied} archivos copiados: el árbol de juguete no es el arnés`);
  // la página y el guion de entrada: en su lugar (el repo público, o el árbol del equipo con lo público encima) traen el
  // nombre público puesto, «<organización>/<repo>» como lo dice scripts/setup/public-remotes.json, y se cambia por el de
  // juguete; los papeles viejos del exportador (scripts/publishing/public-files/) traían en su lugar dos marcadores, y se
  // leen sólo si la página no está en su lugar
  const placed = fs.existsSync(path.join(ROOT, 'getting-started', 'windows.md'));
  const source = placed ? ROOT : path.join(ROOT, 'scripts', 'publishing', 'public-files');
  let named = (text) => text.split('{{public-org}}').join(TOY.org).split('{{public-repo}}').join(TOY.repo);
  if (placed) {
    const real = G.namesOf(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'public-remotes.json'), 'utf8'));
    assert.strictEqual(real.problem, undefined, `scripts/setup/public-remotes.json: ${real.problem}`);
    const from = `${real.org}/${real.repo}`;
    named = (text) => { assert.ok(text.includes(from), `el nombre público (${from}) no está donde se lo busca`); return text.split(from).join(`${TOY.org}/${TOY.repo}`); };
  }
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true }); fs.writeFileSync(path.join(tree, rel), text); };
  put('version.json', `{ "version": "${TOY.version}" }\n`);
  put('getting-started/windows.md', named(fs.readFileSync(path.join(source, 'getting-started', 'windows.md'), 'utf8')));
  put('scripts/setup/get-harness.ps1', named(fs.readFileSync(path.join(source, 'scripts', 'setup', 'get-harness.ps1'), 'utf8')));
  put('scripts/setup/public-remotes.json', `{ "remotes": ["https://github.com/${TOY.org}/${TOY.repo}"] }\n`);
  assert.strictEqual(git(['init', '-q', '-b', 'main'], tree).status, 0);
  assert.strictEqual(git(['add', '-A'], tree).status, 0);
  // lo que el .gitignore del arnés pudiera dejar afuera, adentro igual: es lo que una copia publicada trae
  assert.strictEqual(git(['add', '-f', 'version.json', 'getting-started/windows.md', 'scripts/setup/get-harness.ps1', 'scripts/setup/public-remotes.json'], tree).status, 0);
  const committed = git(['commit', '-q', '-m', 'toy published tree'], tree);
  assert.strictEqual(committed.status, 0, committed.stderr);
  return { tree, commit: git(['rev-parse', 'HEAD'], tree).stdout.trim() };
}

/** Un laboratorio sobre el árbol de juguete, con sus fuentes: `{ lab, out, state }`. */
function labOn(base, toy, name, scenario) {
  const src = path.join(base, `${name}-sources`); const lab = path.join(base, `${name}-lab`); const out = path.join(base, `${name}-out`);
  const built = node([path.join(DIR, 'build-sources.js'), '--output', src, '--harness', toy.tree, '--single-repo', '--harness-ref', 'HEAD']);
  assert.strictEqual(built.status, 0, built.stderr || built.stdout);
  const init = node([path.join(DIR, 'rehearse.js'), 'init', '--lab', lab, '--out', out, '--sources', src, '--scenario', scenario, '--allow-temp']);
  assert.strictEqual(init.status, 0, init.stderr || init.stdout);
  return { lab, out, state: T.readState(lab) };
}
const step = (l, name, extra = []) => {
  const r = node([path.join(DIR, 'rehearse.js'), 'step', name, '--lab', l.lab, '--out', l.out, '--allow-temp', ...extra]);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  return readJson(L.stepFile(l.out, name));
};
const mainOf = (l) => git(['-C', l.state.remotes.harness.dir, 'rev-parse', 'refs/heads/main']).stdout.trim();

let base = null;
let toy = null;
let onboarding = null;   // el laboratorio del alta, que T11 vuelve a mirar

test.before(() => {
  if (SKIP) return;
  base = process.env.TYCON_WINDOWS_GUIDED_KEEP ? path.resolve(process.env.TYCON_WINDOWS_GUIDED_KEEP) : fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'windows-guided-lab-'));
  fs.mkdirSync(base, { recursive: true });
  toy = toyPublishedTree(base);
});
test.after(() => { if (base && !process.env.TYCON_WINDOWS_GUIDED_KEEP) fs.rmSync(base, { recursive: true, force: true }); });

// ═══ T7 · el alta, siguiendo la página, con el programa de verdad ══════════════════════════════════════════════

test('GuidedInstall_LabRun_ToyPublishedTree_FollowsThePage', { skip: SKIP }, () => {
  onboarding = labOn(base, toy, 'onboarding', 'onboarding');
  assert.strictEqual(onboarding.state.remotes.harness.target, toy.commit, 'lo que se ensaya es el árbol de juguete');
  const s = step(onboarding, 'onboarding');
  assert.strictEqual(s.status, 'measured', s.reason);
  assert.strictEqual(s.facts.guided, true, 'eligió el ensayo que sigue la página: el árbol trae version.json');
  assert.deepStrictEqual([s.facts.page.file, s.facts.page.mark, s.facts.page.page_steps, s.facts.rehearsed_version], ['getting-started/windows.md', 'guided:base', 7, TOY.version]);
  const v = s.facts.variants.guided;
  assert.ok(v && !v.not_run && !v.threw, `la variante guided corrió (${v && (v.not_run || v.threw)})`);
  // los comandos de la página, en su orden, cada uno con su código de salida
  const steps = v.commands.map((c) => c.step);
  assert.deepStrictEqual([...new Set(steps)], ['tools', 'download', 'plan', 'install', 'git-hooks', 'verify']);
  const ran = v.commands.filter((c) => !c.not_comparable && !c.skipped);
  for (const c of ran) assert.ok(Number.isInteger(c.exit) && typeof c.seconds === 'number', `${c.step}: «${c.text}» con su código y sus segundos`);
  const by = (id) => v.commands.filter((c) => c.step === id);
  assert.deepStrictEqual(by('download').map((c) => c.exit), [0, 0]);
  assert.deepStrictEqual([by('plan')[0].exit, by('install')[0].exit], [0, 0], `el plan y la instalación salieron 0: ${by('install')[0].err}`);
  // en una máquina limpia la instalación ya puso la carpeta global de hooks de git (2026-10-14: antes no la ponía nadie, y
  // una máquina instalada o mudada sin este paso quedaba sin el freno antes de publicar): el primero sale 0 con la carpeta
  // del arnés, y el segundo —el de la página para cuando no devuelve nada— no hace falta
  const gh = by('git-hooks');
  assert.strictEqual(gh[0].exit, 0, `el primero sale 0: la instalación ya la puso (${gh[0].out || gh[0].err})`);
  assert.ok(/\.git-hooks\s*$/.test(String(gh[0].out || '')), `y devuelve la carpeta del arnés: «${gh[0].out}»`);
  assert.ok(gh[1].skipped && gh[1].exit === undefined, `el segundo no corre: ${gh[1].skipped || `salió ${gh[1].exit}`}`);
  for (const c of ran) for (const e of c.expected || []) if (e.comparable !== false) assert.strictEqual(e.ok, true, `${c.step}: ${e.what} — esperado ${e.expected}, dio ${e.measured}`);
  // lo que no se puede comparar fuera de Windows se dice, no se saltea callado
  assert.ok(by('verify').some((c) => /sólo resuelve en Windows/.test(c.not_comparable || '')), 'el diagnóstico por la ruta con barras invertidas: no comparable, con su motivo');
  assert.ok(by('verify').some((c) => (c.expected || []).some((e) => e.comparable === false && /skills de terceros/.test(e.why))), 'la cuenta de skills: no comparable, con su motivo');
  // el único cambio del laboratorio, y el ambiente: nada de lo que una persona no tiene
  assert.deepStrictEqual(by('download')[0].lab_changed.from, 'https://api.github.com');
  assert.ok(v.commands.filter((c) => c.lab_changed).length === 1, 'ningún otro comando se toca');
  const changes = s.facts.lab_changes;
  assert.deepStrictEqual([changes.api_origin.where, changes.execution_policy.launched_with, typeof changes.execution_policy.effective], ['download[0]', 'Bypass', 'string']);
  for (const k of TL.ENV_NEVER) assert.ok(!(k in changes.env_set) && !(k in changes.env_set_with_team), `${k} no se pone`);
  assert.deepStrictEqual(changes.never_set, TL.ENV_NEVER);
  // la máquina quedó con la versión publicada, en la carpeta de usuario del laboratorio
  assert.strictEqual(v.version, TOY.version);
  const home = path.join(onboarding.lab, 'users', 'guided');
  assert.ok(L.samePath(v.home, home));
  assert.strictEqual(TL.installedVersion(path.join(home, '.tycon', 'harness')), TOY.version);
  assert.ok(!fs.existsSync(path.join(home, '.tycon', 'harness', '.git')), 'una versión bajada: archivos, sin git');
  assert.ok(!('repos' in v.installed), 'la foto no trae nada de git');
  assert.deepStrictEqual(v.installed.links.map((l) => l.ok), [true, true, true, true], JSON.stringify(v.installed.links));
  // las dos primeras sesiones, cada una con si se desprendió y cuánto tardó la espera
  assert.deepStrictEqual(v.sessions.map((x) => [x.label, x.form]), [['primera-1', 'default-shell'], ['primera-2', 'bash-c']]);
  for (const x of v.sessions) {
    assert.ok(x.hooks.some((h) => h.startup === 'new' && h.exit === 0), `${x.label}: disparó la línea de arranque que dejó el instalador`);
    assert.ok(typeof x.wait.detached === 'boolean' && typeof x.wait.waited_ms === 'number', `${x.label}: si se desprendió y cuánto esperó`);
    assert.notStrictEqual(x.wait.ended_by, 'not-finished', `${x.label}: el trabajo desprendido terminó`);
    assert.strictEqual(x.version, TOY.version);
  }
  // lo no ensayado, dicho; y ningún permiso de juguete escrito
  assert.ok(s.facts.not_rehearsed.some((n) => n.step === 'report') && s.facts.not_rehearsed.some((n) => /parte 2/.test(n.what)) && s.facts.not_rehearsed.some((n) => /límite de pedidos/.test(n.what)));
  // 🔴 el alta entera SIN permiso de GitHub, con el programa de verdad: el repo se sirvió como público, ningún pedido al
  // GitHub de juguete llevó una credencial (ni la bajada del guion, ni el guion, ni la instalación, ni las sesiones de
  // después), y en la máquina no quedó guardado ningún permiso de GitHub — sólo el del Azure DevOps del equipo
  assert.match(s.facts.toy_servers.github.repo, /^público, sin permiso/);
  assert.match(changes.token, /^TYCON_GITHUB_TOKEN: no se pone en ningún paso/);
  const requests = fs.readFileSync(path.join(onboarding.lab, 'guided', 'onboarding', 'servers', 'github-requests.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(requests.length >= 5 && requests.some((r) => /\/contents\/scripts\/setup\/get-harness\.ps1/.test(r.path)) && requests.some((r) => /\/tarball\//.test(r.path)), `el GitHub de juguete atendió la bajada del guion y la del comprimido (${requests.length} pedidos)`);
  assert.deepStrictEqual(requests.filter((r) => r.auth).map((r) => r.path), [], 'ningún pedido llevó credencial');
  const config = readJson(path.join(home, '.tycon', 'config.json'));
  assert.strictEqual(config.github, undefined, 'sin permiso de GitHub guardado: nadie lo pidió');
  const everything = fs.readdirSync(onboarding.out, { recursive: true }).map((f) => path.join(onboarding.out, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const secret of [config.azure.token]) { assert.ok(secret && secret.length > 15); assert.ok(!everything.includes(secret), 'ningún archivo del reporte trae un permiso de juguete'); }
  assert.ok(!s.findings.some((f) => /secret-printed/.test(f.id)));
  // lab-state.json: el contrato de siempre, y un ambiente sin red
  const state = readJson(path.join(onboarding.lab, 'lab-state.json'));
  const mv = state.measured_variant;
  assert.deepStrictEqual(Object.keys(mv).sort(), ['clone', 'env', 'home', 'id', 'path_first', 'settings', 'skills']);
  assert.deepStrictEqual([mv.id, mv.path_first, L.samePath(mv.clone, path.join(home, '.tycon', 'harness')), mv.skills === mv.clone, s.facts.measured_variant], ['guided', null, true, true, 'guided']);
  assert.match(mv.env.TYCON_RELEASE_API, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(mv.env.TYCON_AZURE_API, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.strictEqual(mv.env.TYCON_AZURE_GIT_CREDENTIAL, '0');
  for (const k of TL.ENV_NEVER) assert.ok(!(k in mv.env) || mv.env[k] === null, `${k}: tampoco en la sesión que mide después`);
  // y sobre esa instalación, count-hooks mide
  const counted = step(onboarding, 'count-hooks');
  assert.strictEqual(counted.status, 'measured', counted.reason);
  assert.strictEqual(counted.facts.variant, 'guided');
  assert.ok(counted.facts.result.expected_total > 20 && counted.facts.result.in_place > 20, 'contó los hooks de la instalación guiada');
  // el remoto del laboratorio quedó en el commit que se ensaya
  assert.strictEqual(mainOf(onboarding), toy.commit);
  // cada comando de la página quedó anotado, y lo que el laboratorio cambió lo dice la variante que corrió
  assert.ok(ran.every((c) => typeof c.started === 'string'), 'cada comando deja dicho cuándo arrancó, antes de esperarlo');
  assert.deepStrictEqual([Object.keys(changes.by_variant), L.samePath(changes.by_variant.guided.user_folder, home), changes.launched_with, typeof changes.always], [['guided'], true, TL.LAUNCHED_WITH, 'object']);
  // y el reporte que lee una persona: se arma sin tirar y trae lo que la corrida midió
  const finished = node([path.join(DIR, 'rehearse.js'), 'finish', '--out', onboarding.out]);
  assert.strictEqual(finished.status, 0, finished.stderr || finished.stdout);
  const md = fs.readFileSync(path.join(onboarding.out, 'windows-report.md'), 'utf8');
  for (const said of [/## El alta, siguiendo la página pública/, /\| Paso \| Quién \| Comando \| Salió \| Esperado contra medido \|/, /\| install \| la máquina \| .*get-harness\.ps1.* \| 0 \|/, /\*\*La capa del equipo\*\*/, /Cómo quedó la máquina con la capa puesta: \d+ hook\(s\)/, /## Lo que el laboratorio cambió/, /- onboarding · guided: carpeta de usuario /, /## No ensayado/, new RegExp(`\\| una copia publicada del arnés \\| .* \\| ${TOY.version.replace(/\./g, '\\.')} \\|`)]) assert.match(md, said);
  assert.ok(!md.includes(config.azure.token));
  assert.match(md, /- TYCON_GITHUB_TOKEN: no se pone en ningún paso/, 'el reporte dice que ningún paso llevó un permiso de GitHub');
});

// ═══ T11 · la capa del equipo, encima ══════════════════════════════════════════════════════════════════════════

test('GuidedTeam_LabRun_ToyAzure_StacksTheLayer', { skip: SKIP }, () => {
  // primero lo que NO depende de la instalación del alta (arma su propio laboratorio): si la prueba anterior quedó
  // roja, esto se mide igual. Un servidor de juguete que no levanta no es un hallazgo de la máquina: es no haber
  // podido ensayar
  const down = labOn(base, toy, 'down', 'onboarding');
  for (const [which, start] of [['el Azure DevOps de juguete', { azure: () => ({ problem: 'el Azure DevOps de juguete no dejó su archivo de puertos en 10 s' }) }], ['el GitHub de juguete', { github: () => ({ problem: 'el GitHub de juguete no levantó: EACCES' }) }]]) {
    const rec = L.recorder('onboarding', down.out);
    const result = GI.measure({ lab: down.lab, out: down.out, state: down.state, allowTemp: true, rec, start });
    assert.deepStrictEqual([result.status, new RegExp(`^no pude ensayar: ${which}`).test(result.reason)], ['error', true], result.reason);
    assert.deepStrictEqual(rec.step.findings, [], 'sin hallazgos: no se midió ninguna máquina');
    assert.ok(!fs.existsSync(path.join(down.lab, 'users')), 'sin instalar nada');
    assert.ok(!fs.existsSync(path.join(down.lab, 'guided', 'onboarding')), 'y sin dejar la carpeta del paso: se puede volver a intentar');
    assert.strictEqual(mainOf(down), toy.commit);
  }
  // y de verdad: un servidor que no deja su archivo de puertos se dice a los pocos segundos, no se espera para siempre
  const never = TL.startAzure({ dir: path.join(base, 'never'), bare: path.join(base, 'no-such.git'), env: Object.assign({}, process.env, { NODE_OPTIONS: '--require ./no-such-module.js' }), pat: 'x', waitMs: 1500 });
  assert.match(never.problem, /el Azure DevOps de juguete no dejó su archivo de puertos/);
  assert.match(never.problem, /lo que dijo: .*no-such-module/, 'con lo que el servidor dijo al caerse: uno que murió al arrancar no es uno lento');

  assert.ok(onboarding, 'lo que sigue corre sobre la instalación del alta (la prueba anterior)');
  const s = readJson(L.stepFile(onboarding.out, 'onboarding'));
  const team = s.facts.variants.guided.team;
  assert.deepStrictEqual(team.commands.map((c) => [c.text, c.exit]), [['harness.js config set azure.token', 0], ['harness.js install --version latest --team <team-url> --yes', 0]]);
  // el estado dice de qué repo y qué commit es la capa, y el árbol la trae apilada
  assert.deepStrictEqual([team.state.host, team.state.repo, /^[0-9a-f]{40}$/.test(team.state.commit), team.stacked.commit === team.state.commit, team.stacked.profile_in_tree], ['azure', TL.TEAM_URL, true, true, true]);
  assert.strictEqual(team.state.commit, s.facts.toy_servers.azure.team_commit, 'el commit del repo del equipo de juguete');
  // la configuración muestra con origen en el perfil lo que el perfil manda
  assert.strictEqual(team.profile_origin['ado.org'], 'perfil');
  assert.ok(Object.keys(team.profile_origin).some((k) => /^integra[a-z]*\./.test(k)), 'las integraciones, con origen en el perfil');
  // la versión trae la capa con su commit, y el diagnóstico la nombra
  assert.strictEqual(team.version_json.team.commit, team.state.commit);
  assert.match(team.doctor_line, /^capa del equipo equipo-lab /);
  assert.deepStrictEqual(team.doctor.fail, []);
  for (const id of ['guided:team:install-failed', 'guided:team:not-stacked', 'guided:team:version-without-team', 'guided:team:doctor-line']) assert.ok(!s.findings.some((f) => f.id.endsWith(id)), `sin ${id}`);
  // 8.29 · T15 GuidedTeam_LabRun_PacksComeFromProfile @story-8.29 @ac-13 — los paquetes: la página instala con
  // `--packs all` y eso queda escrito en la máquina, pero desde la story 8.29 el perfil del equipo gana al leer. Con el
  // programa de verdad: los paquetes figuran entre lo que sale del perfil y el ensayo ya no informa el hallazgo
  // (hasta la 8.29 salía en toda corrida con la capa: `guided:team:profile-origin`, «packs.default: maquina»)
  assert.ok(!s.findings.some((f) => f.id.endsWith('guided:team:profile-origin')), 'sin guided:team:profile-origin: los paquetes salen del perfil');
  assert.strictEqual(team.profile_origin['packs.default'], 'perfil', 'los paquetes, con origen en el perfil');
  // y una sesión más, con su espera
  assert.deepStrictEqual([team.session.label, typeof team.session.wait.detached, team.session.wait.ended_by !== 'not-finished'], ['con-la-capa', 'boolean', true]);
  // la máquina CON la capa puesta se juzga como antes de sumarla: su foto contra la anterior, y su sesión
  const guided = s.facts.variants.guided;
  assert.ok(guided.after_team && guided.after_team.settings && guided.after_team.doctor && !('repos' in guided.after_team), 'la foto de después de la capa, entera');
  assert.ok(Array.isArray(guided.changed_by_team), 'y lo que cambió, con su gravedad');
  for (const d of guided.changed_by_team) assert.ok(s.findings.some((f) => f.id === `onboarding:guided:team:${d.id}` && f.severity === d.severity), `team:${d.id} salió como hallazgo`);
  assert.deepStrictEqual(guided.after_team.doctor.fail, [], 'con la capa de juguete, el diagnóstico sigue sin rojos');
  assert.ok(!s.findings.some((f) => /team:session:.*(startup-line-failed|unreadable-settings)/.test(f.id)));
  assert.strictEqual(guided.answers.usable, true);
  // un laboratorio que no se pudo armar se puede volver a intentar (los dos intentos del principio fueron sobre el
  // mismo); uno que YA corrió, no: es de una sola corrida, y repetir el paso —o pedir otra variante— se dice claro
  // (antes fallaba más adelante, con un motivo vacío). Va al final: pisa el resultado del paso
  const again = step(onboarding, 'onboarding', ['--only', 'guided-ps51']);
  assert.deepStrictEqual([again.status, /ya corrió sobre este laboratorio/.test(again.reason), /init/.test(again.reason)], ['error', true, true], again.reason);
  assert.strictEqual(mainOf(onboarding), toy.commit);
});

// ═══ T16 · la máquina con una versión anterior llega sola a la nueva ═══════════════════════════════════════════

test('GuidedUpdate_LabRun_Auto_ReachesTheNewVersionByItself', { skip: SKIP }, () => {
  const update = labOn(base, toy, 'update', 'update');
  const s = step(update, 'update', ['--only', 'auto,ask']);
  assert.strictEqual(s.status, 'measured', s.reason);
  assert.strictEqual(s.facts.guided, true);
  const v = s.facts.variants.auto;
  assert.ok(v && !v.not_run && !v.threw, `la variante auto corrió (${v && (v.not_run || v.threw)})`);
  // la sesión de antes y la máquina de antes (ya con la capa) también se juzgan: sin hallazgos que rompan
  assert.strictEqual(v.settled.label, 'antes');
  assert.ok(!s.findings.some((f) => /^update:auto:before:/.test(f.id) && f.severity === 'breaks'), s.findings.filter((f) => /before:/.test(f.id)).map((f) => f.id).join(', '));
  // dos versiones de juguete, las dos mayores que la que se ensaya; la máquina se instaló en la primera
  const [before, published] = [TL.nextVersion(TOY.version, 1), TL.nextVersion(TOY.version, 2)];
  assert.deepStrictEqual([v.version_before, v.version_published], [before, published]);
  assert.deepStrictEqual(v.install.commands.filter((c) => c.step === 'install').map((c) => c.exit), [0]);
  // con la capa del equipo (que manda aplicar sola), fuera de su ventana, abriendo sesiones: llega sola
  assert.strictEqual(v.team.state.host, 'azure');
  assert.strictEqual(v.out_of_window.done, true);
  assert.strictEqual(v.updated_by_itself, true, `quedó en ${v.version_after}; sesiones: ${JSON.stringify(v.sessions.map((x) => [x.label, x.version, x.wait]))}`);
  // «se actualizó» es el número de version.json del árbol instalado, nunca git
  const tree = path.join(update.lab, 'users', 'update-auto', '.tycon', 'harness');
  assert.deepStrictEqual([v.version_after, TL.installedVersion(tree), fs.existsSync(path.join(tree, '.git'))], [published, published, false]);
  assert.strictEqual(v.by_hand, undefined, 'nadie la actualizó a mano');
  assert.deepStrictEqual(v.sessions.map((x) => x.form), ['bash-c', 'default-shell', 'default-shell', 'default-shell']);
  for (const x of v.sessions) assert.notStrictEqual(x.wait.ended_by, 'not-finished', `${x.label}: el trabajo desprendido terminó`);
  assert.strictEqual(v.sessions[v.sessions.length - 1].version, published);
  // la foto y el humo, antes y después; ningún hallazgo de git; y la versión cambió
  assert.ok(!('repos' in v.before) && !('repos' in v.after));
  assert.ok(v.before_smoke.rows.length > 20 && v.after_smoke.rows.length > 20, 'el humo de cada hook, antes y después');
  assert.ok(!s.findings.some((f) => /:repo:|version:not-applied|version:unreadable/.test(f.id)), s.findings.map((f) => f.id).join(', '));
  assert.ok(s.findings.some((f) => f.id === 'update:auto:version:changed' && f.severity === 'noise'));
  assert.deepStrictEqual([v.answers.updated, v.answers.version.before, v.answers.version.after], [true, before, published]);
  assert.match(s.facts.same_machine_note, /pwsh-missing/);

  // ── la máquina que pregunta (sin la capa), con el programa de verdad: no cambia de versión, el estado guarda el aviso
  // QUE NOMBRA la versión publicada, el hook de avisos se lo dice a la persona en la sesión siguiente, y `update --yes`
  // sin una terminal se niega
  const a = s.facts.variants.ask;
  assert.ok(a && !a.not_run && !a.threw, `la variante ask corrió (${a && (a.not_run || a.threw)})`);
  const [askBefore, askPublished] = [TL.nextVersion(TOY.version, 3), TL.nextVersion(TOY.version, 4)];
  assert.deepStrictEqual([a.version_before, a.version_published, a.version_after, a.changed_by_itself, a.team], [askBefore, askPublished, askBefore, false, undefined]);
  assert.ok(a.what_the_dev_is_told.state_notice.includes(askPublished), `el aviso del estado nombra la versión publicada: ${a.what_the_dev_is_told.state_notice}`);
  assert.ok(a.what_the_dev_is_told.hook_said && a.what_the_dev_is_told.hook_said.includes(askPublished), `y un hook de la sesión siguiente se lo dice a la persona: ${a.what_the_dev_is_told.hook_said}`);
  assert.deepStrictEqual([a.by_hand.without_a_terminal, a.by_hand.refused_cleanly, a.by_hand.version], [true, true, askBefore], `sin una terminal se niega y lo dice: ${a.by_hand.said}`);
  assert.deepStrictEqual(a.sessions.map((x) => x.label), ['una', 'otra']);
  assert.deepStrictEqual(s.findings.filter((f) => f.variant === 'ask' && /update:ask:/.test(f.id)).map((f) => f.id), [], 'ninguno de los cuatro hallazgos de la máquina que pregunta');
  assert.deepStrictEqual(Object.keys(s.facts.lab_changes.by_variant).sort(), ['ask', 'auto'], 'cada variante dice lo suyo en lo que el laboratorio cambió');
  // el remoto del laboratorio quedó en el commit que se ensaya, con las publicaciones en el medio
  assert.strictEqual(mainOf(update), toy.commit);
  // y el reporte que lee una persona, armado con lo que esta corrida midió de verdad (las fotos, el humo, las sesiones)
  const finished = node([path.join(DIR, 'rehearse.js'), 'finish', '--out', update.out]);
  assert.strictEqual(finished.status, 0, finished.stderr || finished.stdout);
  const md = fs.readFileSync(path.join(update.out, 'windows-report.md'), 'utf8');
  const rx = (number) => number.replace(/\./g, '\\.');
  for (const said of [
    /## La actualización, sobre una máquina instalada con la página/,
    new RegExp(`\\| auto — .* \\| ${rx(before)} \\| ${rx(published)} \\| ${rx(published)} \\| sí \\|`),
    new RegExp(`\\| ask — .* \\| ${rx(askBefore)} \\| ${rx(askPublished)} \\| ${rx(askBefore)} \\| no cambió \\(pregunta\\) \\|`),
    /\| antes \| default-shell \| salió 0 /, /\| después-4 \| default-shell \| salió 0 /, /\| otra \| default-shell \| salió 0 /,
    /Antes: \d+ hook\(s\) · línea de arranque .* · doctor /, /Después: \d+ hook\(s\) · línea de arranque .* · doctor /,
    /\*\*Lo que se le dijo a la persona\*\*/, new RegExp(`el aviso en el estado: .*${rx(askPublished)}`),
    /`harness\.js update --yes` lanzado sin una terminal: salió \d+ y quedó la versión .* \(se negó y dijo por qué: es lo esperado\)/,
    /- update · auto: carpeta de usuario /, /- update · ask: carpeta de usuario /, /## No ensayado/,
  ]) assert.match(md, said);
  assert.doesNotMatch(md, /no se midió|NO SE PUDO ENSAYAR/, 'nada de lo que esta corrida midió sale como «no se midió»');
});
