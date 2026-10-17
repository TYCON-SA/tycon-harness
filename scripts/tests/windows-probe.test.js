'use strict';

/**
 * windows-probe.test.js — los guiones que miden el arnés en Windows (story 8.17, tanda W0 · T1 a T5, T12 y T13).
 *
 * Lo que se mide acá NO es Windows: es que los guiones de medición (`scripts/tests/windows/`) y el pipeline que los
 * corre (`pipelines/azure-pipelines-windows.yml`) hagan lo que dicen. Lo que no se puede perder:
 *   T1  · el pipeline no se dispara solo (sin push, sin pull request, sin horario), mide en `windows-latest`, tiene sus
 *         dos trabajos y sus dos parámetros, no nombra ningún secreto salvo bajo `realSession`, y la copia llega al
 *         agente por `git clone` de un bundle, nunca por una copia de archivos.
 *   T2  · una herramienta que no está es un HECHO; un buscador que falla por otra cosa es un ERROR del paso; dos `bash`
 *         en el PATH salen los dos, en orden.
 *   T3  · contra la lista leída del instalador de bash, el `settings.json` que deja hoy el de Windows: los 18 que faltan
 *         y los 2 que correrían dos veces, por nombre; y el mal ubicado, el repetido y el que nombra un archivo que no existe.
 *   T4  · el veredicto: rojo con un reporte vacío, con un hallazgo fuera de la lista, con un hueco que ya no se
 *         reproduce y con un paso que vence su tope; verde sólo con todo medido y la lista al día.
 *   T5  · los nombres nuevos, en inglés; `run.js` se niega —sin escribir nada— a medir fuera de un laboratorio o sobre
 *         la carpeta de usuario real; y cada paso lleva `TYCON_NO_NIGHTLY_EXAM=1`.
 *   T12 · sin la sesión real el paso dice «no medido» y la corrida no cambia de color; la credencial no aparece nunca.
 *   T13 · los quince «no se sabe» del análisis, cada uno como hecho con su corrida o como «no medido» con su motivo.
 *   T74 · (W6) el paso `pipeline-skeleton`: el esqueleto mecánico del pipeline de stories sobre el repo de ejemplo de
 *         Node, en el modo de laboratorio; cada paso que no sale como en Linux es un hallazgo con su nombre.
 *   Y un recorrido entero en modo de laboratorio sobre un arnés de juguete (bundle → clon → bloque de la portada →
 *   contar → disparar → reporte): es lo que el agente Windows corre de verdad (T6 a T10), sin el instalador real.
 *
 * Sin dependencias y sin el instalador real: nunca toca la carpeta de usuario de quien la corre. El recorrido de
 * juguete es del modo de laboratorio y se saltea en Windows (ahí mide la corrida de verdad).
 *
 * Correr: node --test scripts/tests/windows-probe.test.js
 */

// story 8.39 (decisión 20): los laboratorios que lanzan harness.js no bajan el Node del arnés de nodejs.org (lo heredan)
process.env.TYCON_HARNESS_NODE = '0';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'scripts', 'tests', 'windows');
const FIXTURES = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'windows');
const PIPELINE = path.join(ROOT, 'pipelines', 'azure-pipelines-windows.yml');
const L = require(path.join(DIR, 'lab.js'));
// el lugar del arnés y el nombre viejo (story 8.19): el instalador de juguete deja lo que deja el de verdad
const PLACE = require(path.join(__dirname, '..', 'setup', 'harness', 'place.js'));
const { PLACE_NAME, LEGACY_PLACE_NAME } = PLACE;
const inventory = require(path.join(DIR, 'inventory.js'));
const count = require(path.join(DIR, 'count-hooks.js'));
const run = require(path.join(DIR, 'run.js'));
const session = require(path.join(DIR, 'session-probe.js'));
const facts = require(path.join(DIR, 'facts.js'));
const fire = require(path.join(DIR, 'fire-registered.js'));

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const node = (args, opts = {}) => spawnSync(process.execPath, args, Object.assign({ encoding: 'utf8', timeout: 120000 }, opts));
const tmp = (name) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `windows-probe-${name}-`));
const listing = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(path.relative(dir, p)); if (e.isDirectory()) walk(p); } }; if (fs.existsSync(dir)) walk(dir); return out.sort(); };
const has = (bin) => L.scanPath(bin).length > 0;

// ═══ T1 ════════════════════════════════════════════════════════════════════════════════════════════════════════

test('WindowsPipeline_Yaml_NoPushNoPr_TwoJobs_BundleIsCloned', { skip: !fs.existsSync(PIPELINE) && 'NO MEDIDO — este árbol no trae pipelines/azure-pipelines-windows.yml (vive en el repo del equipo)' }, () => {
  const yml = fs.readFileSync(PIPELINE, 'utf8');
  const code = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');   // lo que Azure lee: sin los comentarios
  // no se dispara solo
  assert.match(code, /^trigger: none\b/m, 'trigger: none');
  assert.match(code, /^pr: none\b/m, 'pr: none');
  assert.doesNotMatch(code, /^\s*schedules:/m, 'sin horario: lo suma W7');
  // sin recursos que lo disparen: el único es el del arnés en GitHub (story 8.26 B), sin disparador propio
  const resources = code.match(/^resources:\n((?:\s+\S.*\n)+)/m);
  if (resources) {
    assert.deepStrictEqual([...resources[1].matchAll(/-\s+repository:\s*(\S+)/g)].map((m) => m[1]), ['arnes'], 'el único recurso es el del arnés');
    assert.doesNotMatch(resources[1], /^\s*(trigger|pipelines|builds|containers|packages|webhooks):/m, 'y no dispara el pipeline');
  }
  // los dos trabajos, y dónde mide
  const jobs = [...code.matchAll(/^ {2}- job: (\w+)/gm)].map((m) => m[1]);
  // los dos de la medición, y detrás los dos de los ensayos del equipo (su contrato: windows-rehearsal.test.js, R1)
  assert.deepStrictEqual(jobs, ['Bundle', 'Windows', 'Sources', 'Rehearsal'], `los trabajos, en orden: ${jobs.join(', ')}`);
  const windows = code.slice(code.indexOf('- job: Windows'), code.indexOf('- job: Sources'));
  const bundle = code.slice(code.indexOf('- job: Bundle'), code.indexOf('- job: Windows'));
  assert.match(windows, /vmImage: 'windows-latest'/, 'el trabajo que mide corre en windows-latest');
  assert.match(bundle, /vmImage: 'ubuntu-latest'/, 'el bundle se arma en Linux');
  assert.match(windows, /dependsOn: Bundle\b/, 'Windows espera al bundle');
  // los parámetros
  const params = code.slice(code.indexOf('parameters:'), code.indexOf('jobs:'));
  assert.match(params, /- name: scenario\n\s+displayName: .*\n\s+type: string\n\s+default: measure\n/, 'scenario: sin decir nada, la medición de siempre');
  assert.match(bundle, /condition: in\('\$\{\{ parameters\.scenario \}\}', 'measure', 'all'\)/, 'la medición corre con measure y con all');
  assert.match(windows, /condition: and\(eq\(dependencies\.Bundle\.result, 'Succeeded'\), in\('\$\{\{ parameters\.scenario \}\}', 'measure', 'all'\)\)/, 'Windows dice qué resultado de Bundle acepta: Bundle tiene condición propia');
  assert.match(params, /- name: harnessRef\n\s+displayName: .*\n\s+type: string\n\s+default: ''/, 'harnessRef: texto, vacío por defecto');
  assert.match(params, /- name: realSession\n\s+displayName: .*\n\s+type: boolean\n\s+default: false/, 'realSession: falso por defecto');
  // la copia: exportada por build-bundle.sh, entregada como artefacto y CLONADA en el agente
  assert.match(bundle, /bash scripts\/tests\/windows\/build-bundle\.sh /, 'el trabajo de Linux arma el bundle con build-bundle.sh');
  // agent-skills de antes de la unión, clonado por el trabajo en una carpeta propia (no la plantilla: desde la 8.18
  // enlaza ~/.claude/agent-skills al arnés); sólo lo usa un commit de antes de la unión
  assert.doesNotMatch(bundle, /template: \/pipelines\/templates\/(?:fetch|traer)-repos\.yml/, 'Bundle no toma agent-skills de la plantilla');
  assert.match(bundle, /clone --quiet "\$\{ORG\}AgentSkills\/_git\/AgentSkills" "\$SK" 2>&1\); then\s+echo "##vso\[task\.logissue type=error\]No se pudo clonar AgentSkills: [^\n]*\$ERR[^\n]*"\s+exit 1/, 'clona el repo viejo; un clon fallido sale rojo con su motivo');
  assert.match(bundle, /export TYCON_SKILLS_DIR="\$\(Agent\.TempDirectory\)\/agent-skills"/, 'y se lo pasa a build-bundle.sh');
  assert.match(windows, /run\.js init .*--bundle /, 'el agente crea el laboratorio desde el bundle');
  for (const copy of ['CopyFiles@', 'Copy-Item', 'robocopy', 'xcopy', 'cp -R', 'cp -r', 'ExtractFiles@']) assert.ok(!windows.includes(copy), `el trabajo de Windows no copia archivos (${copy}): clona`);
  // … y `init` clona de verdad: el origen del clon es el bundle
  const base = tmp('t1');
  try {
    const toy = path.join(base, 'toy');
    fs.mkdirSync(toy);
    fs.writeFileSync(path.join(toy, 'a.txt'), 'hola\n');
    const git = (args, cwd) => spawnSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', ...args], { cwd, encoding: 'utf8' });
    git(['init', '-q'], toy); git(['add', '-A'], toy); git(['commit', '-q', '-m', 'x'], toy); git(['checkout', '-q', '-B', 'main'], toy);
    const file = path.join(base, 'harness.bundle');
    assert.strictEqual(git(['bundle', 'create', '-q', file, 'HEAD', 'main'], toy).status, 0, 'no pude armar el bundle de la prueba');
    const made = run.initLab({ lab: path.join(base, 'lab'), out: path.join(base, 'out'), bundle: file, allowTemp: true });
    assert.ok(made.ok, `init: ${made.reason}`);
    const origin = spawnSync('git', ['-C', path.join(base, 'lab', 'source'), 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
    assert.strictEqual(fs.realpathSync(origin.stdout.trim()), fs.realpathSync(file), 'la copia del laboratorio es un clon del bundle');
    assert.ok(fs.existsSync(path.join(base, 'lab', L.LAB_MARK)), 'el laboratorio lleva su marca');
    assert.strictEqual(run.initLab({ lab: path.join(base, 'lab2'), out: path.join(base, 'out2'), bundle: path.join(base, 'no-such.bundle'), allowTemp: true }).ok, false, 'sin bundle no hay laboratorio');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
  // los pasos de la medición, cada uno por run.js (que los corre bajo su tope), y el reporte como artefacto
  for (const s of run.STEPS) assert.match(windows, new RegExp(`run\\.js step ${s.name} `), `el paso ${s.name} corre por run.js`);
  // el esqueleto del pipeline de stories (W6 · T74): sobre la instalación que dejó `install`, antes del reporte
  assert.ok(windows.indexOf('run.js step install ') < windows.indexOf('run.js step pipeline-skeleton '), 'el esqueleto corre después de instalar');
  assert.ok(windows.indexOf('run.js step pipeline-skeleton ') < windows.indexOf('run.js finish '), 'y antes de escribir el reporte');
  assert.match(fs.readFileSync(path.join(DIR, 'run.js'), 'utf8'), /clean-machine', 'run-capped\.js'/, 'run.js corre cada paso bajo run-capped.js');
  assert.match(windows, /run\.js finish /, 'el reporte se escribe');
  assert.match(windows, /run\.js verdict /, 'el veredicto decide el color');
  // la lista de huecos propuesta, impresa en el registro y conservando la de los pasos no medidos: hoy nadie puede bajar el artefacto
  assert.match(windows, /run\.js propose-gaps "\$\(report\)\\windows-report\.json" --keep scripts\\tests\\windows\\known-gaps\.json\n\s+displayName: .*\n\s+workingDirectory: .*\n\s+condition: always\(\)/, 'el paso que imprime la lista propuesta corre siempre');
  assert.match(windows, /PublishPipelineArtifact@1[\s\S]*artifact: windows-report/, 'el reporte se publica como artefacto windows-report');
  assert.ok(windows.indexOf('artifact: windows-report') < windows.indexOf('run.js verdict'), 'el reporte se publica ANTES del veredicto: una corrida roja también lo entrega');
  // ningún secreto ni grupo de variables, salvo la credencial bajo realSession; nada tolerante; no escribe en ningún repo
  assert.doesNotMatch(code, /^\s*- group:/m, 'sin grupos de variables');
  assert.doesNotMatch(code, /continueOnError/, 'ningún paso tolerante');
  assert.doesNotMatch(code, /git (push|commit)\b/, 'no escribe en ningún repo');
  assert.doesNotMatch(code, /persistCredentials: true/, 'no guarda la credencial del repo');
  const secret = code.split('\n').map((l, i) => ({ l, i })).filter((x) => /\$\(windowsSessionCredential\)/.test(x.l));
  assert.strictEqual(secret.length, 1, 'la credencial se nombra una sola vez');
  const guard = code.split('\n').slice(0, secret[0].i).reverse().find((l) => /\$\{\{ if /.test(l));
  assert.match(guard || '', /eq\(parameters\.realSession, true\)/, 'la credencial sólo llega al paso bajo realSession: true');
  assert.doesNotMatch(code.replace(/\$\(System\.AccessToken\)/g, ''), /AccessToken|PAT\b/, 'sin otras credenciales');
});

// ── story 8.26, tanda D · `init --same-tree` ──────────────────────────────────────────────────────────────────────────
// Cuando lo que se mide y los guiones que miden salen del mismo repo, tienen que ser el mismo commit: si no, se estaría
// midiendo un árbol con los guiones de otro, y el reporte no lo diría.
test('Probe_Init_SameTree_BundleMustBeTheScriptsCommit_LabelSaysIt', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const base = tmp('same-tree');
  try {
    const toy = path.join(base, 'toy');
    fs.mkdirSync(toy);
    fs.writeFileSync(path.join(toy, 'a.txt'), 'hola\n');
    const git = (args, cwd) => spawnSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', ...args], { cwd, encoding: 'utf8' });
    git(['init', '-q'], toy); git(['add', '-A'], toy); git(['commit', '-q', '-m', 'x'], toy); git(['checkout', '-q', '-B', 'main'], toy);
    const commit = git(['rev-parse', 'HEAD'], toy).stdout.trim();
    const dir = path.join(base, 'bundle'); fs.mkdirSync(dir);
    const file = path.join(dir, 'harness.bundle');
    assert.strictEqual(git(['bundle', 'create', '-q', file, 'HEAD', 'main'], toy).status, 0);
    const info = (copyCommit) => fs.writeFileSync(path.join(dir, 'bundle-info.json'), `${JSON.stringify({ mode: 'source', copy_commit: copyCommit })}\n`);
    info(commit);
    const init = (n, extra) => run.initLab(Object.assign({ lab: path.join(base, `lab${n}`), out: path.join(base, `out${n}`), bundle: file, allowTemp: true, meta: { harness_ref: 'github' } }, extra));
    const untouched = (n) => !fs.existsSync(path.join(base, `lab${n}`)) && !fs.existsSync(path.join(base, `out${n}`));
    // el mismo commit: hay laboratorio, y la etiqueta de lo medido dice de dónde y qué commit
    const ok = init(1, { sameTree: true, scripts: () => ({ sha: commit }) });
    assert.ok(ok.ok, ok.reason);
    assert.deepStrictEqual([ok.meta.harness_ref, ok.meta.copy_commit], [`github:${commit}`, commit]);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(base, 'out1', 'run.json'), 'utf8')).harness_ref, `github:${commit}`);
    // otro commit: no hay laboratorio, y no queda nada a medias
    const other = init(2, { sameTree: true, scripts: () => ({ sha: 'f'.repeat(40) }) });
    assert.strictEqual(other.ok, false);
    assert.match(other.reason, /el árbol de los guiones \(f{10}\) no es el commit que se mide \([0-9a-f]{10}\)/);
    assert.ok(untouched(2), 'ni el laboratorio ni el reporte');
    // sin poder leer el commit de los guiones, o sin que el bundle diga el suyo: tampoco (no saber no es «coinciden»)
    assert.match(init(3, { sameTree: true, scripts: () => ({ problem: 'git no contestó' }) }).reason, /no pude leer el commit del árbol de los guiones: git no contestó/);
    fs.rmSync(path.join(dir, 'bundle-info.json'));
    assert.match(init(4, { sameTree: true, scripts: () => ({ sha: commit }) }).reason, /no sé qué commit se mide/);
    assert.ok(untouched(3) && untouched(4));
    // la información dice el commit de los guiones pero el bundle trae otro: el clon manda, y no hay medición
    info('e'.repeat(40));
    const lying = init(5, { sameTree: true, scripts: () => ({ sha: 'e'.repeat(40) }) });
    assert.strictEqual(lying.ok, false);
    assert.match(lying.reason, /el clon del bundle quedó en [0-9a-f]{10} y no en el commit del árbol de los guiones \(e{10}\)/);
    // sin la opción nada de esto se mira (con la fuente de siempre se mide un commit con los guiones de otra rama)
    info(commit);
    const plain = init(6, { scripts: () => ({ sha: 'f'.repeat(40) }) });
    assert.ok(plain.ok, plain.reason);
    assert.strictEqual(plain.meta.harness_ref, 'github');
    // el commit de este árbol se lee de verdad; y por la línea de comandos, contra un bundle de juguete, frena y lo dice
    const mine = run.scriptsCommit();
    assert.ok(mine.sha ? /^[0-9a-f]{40}$/.test(mine.sha) : typeof mine.problem === 'string', JSON.stringify(mine));
    const cli = node([path.join(DIR, 'run.js'), 'init', '--lab', path.join(base, 'lab7'), '--out', path.join(base, 'out7'), '--bundle', file, '--harness-ref', 'github', '--allow-temp', '--same-tree']);
    assert.strictEqual(cli.status, 2);
    assert.match(cli.stderr, /no pude medir: (el árbol de los guiones|no pude leer el commit del árbol de los guiones)/);
    assert.ok(untouched(7));
    // la etiqueta sin un nombre de fuente: «tree» y el commit
    assert.strictEqual(run.sameTreeLabel(null, commit), `tree:${commit}`);
    // el commit de un árbol es el de SU repo: una carpeta con un .git que no es un repo, dentro de otro repo, no
    // contesta con el commit del de arriba (pase adversarial de la tanda)
    assert.deepStrictEqual(run.scriptsCommit(undefined, toy), { sha: commit });
    const inside = path.join(toy, 'adentro');
    fs.mkdirSync(path.join(inside, '.git'), { recursive: true });
    assert.match(run.scriptsCommit(undefined, inside).problem, /no es la raíz de un clon de git/);
    assert.match(run.scriptsCommit(undefined, path.join(base, 'no-such-dir')).problem, /no es un clon de git/);
    // llegar al árbol por un enlace es llegar a ese árbol: git contesta la ruta real, y se compara la real
    const link = path.join(base, 'enlace-al-arbol');
    fs.symlinkSync(toy, link, 'junction');
    assert.deepStrictEqual(run.scriptsCommit(undefined, link), { sha: commit });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ T2 ════════════════════════════════════════════════════════════════════════════════════════════════════════

test('Probe_Inventory_AbsentToolIsAFact_FailedLookupIsAnError', () => {
  const where = {
    git: ['C:\\Program Files\\Git\\cmd\\git.exe'], node: ['C:\\nodejs\\node.exe'], pwsh: ['C:\\PowerShell\\7\\pwsh.exe'],
    bash: ['C:\\Windows\\System32\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'], az: ['C:\\azure\\wbin\\az', 'C:\\azure\\wbin\\az.cmd'],
  };
  // un buscador de mentira con la forma de `where`: 0 = está, 1 = no encontrado, otra cosa = no pudo preguntar
  const finder = (name) => {
    if (name === 'python3') return { status: 2, stdout: '', stderr: 'ERROR: acceso denegado', error: null };
    return where[name] ? { status: 0, stdout: `${where[name].join('\r\n')}\r\n`, stderr: '', error: null } : { status: 1, stdout: '', stderr: 'INFO: no se encontró', error: null };
  };
  const asked = [];
  const runner = (bin, args) => { asked.push(`${bin} ${args.join(' ')}`); return { exit: 0, error: null, stdout: /git\.exe$/.test(bin) && args[0] === 'config' ? 'system\tfile:C:/Git/etc/gitconfig\ttrue\n' : `${path.win32.basename(bin)} 1.2.3\n`, stderr: '', ms: 1 }; };
  const r = inventory.measure({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\agent', PATH: '' }, finder, runner, exists: (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe', homedir: () => 'C:\\Users\\agent' });
  const t = r.facts.tools;
  // la herramienta que no está: un hecho, sin error
  assert.strictEqual(t.jq.state, 'absent');
  assert.deepStrictEqual(t.jq.locations, []);
  assert.ok(!r.problems.some((p) => /jq/.test(p)), '«no está» no es un problema del paso');
  // el buscador que falló por otra cosa: «no pude preguntar», y es un error del paso
  assert.strictEqual(t.python3.state, 'error');
  assert.match(t.python3.reason, /no pude preguntar dónde está python3/);
  assert.ok(r.problems.some((p) => /python3/.test(p)), 'un buscador que falla es un error del paso');
  // los dos bash, en orden, y cuál es el lanzador de WSL
  assert.deepStrictEqual(t.bash.locations, where.bash);
  assert.deepStrictEqual(t.bash.wsl_launcher, [true, false]);
  assert.strictEqual(t.bash.versions.length, 2, 'la versión de cada bash');
  assert.strictEqual(r.facts.git_bash.path, 'C:\\Program Files\\Git\\bin\\bash.exe', 'el bash de Git, junto a git');
  assert.strictEqual(r.facts.git_bash.first_bash_is_wsl_launcher, true);
  // `az` sin extensión y con `.cmd`: en Windows corre la que tiene extensión, y de ésa es la versión
  assert.deepStrictEqual([t.az.launch_kinds, t.az.launch_kind, t.az.versions[0].location], [['no-extension', 'cmd'], 'cmd', 'C:\\azure\\wbin\\az.cmd']);
  assert.strictEqual(r.facts.autocrlf.effective, 'true');
  // lo que la medición no puede hacer sin ella: un requisito ausente es un error; sin `where`, mira el PATH y lo dice
  const none = inventory.measure({ platform: 'win32', env: { PATH: '' }, finder: () => ({ status: 1, stdout: '', stderr: '', error: null }), runner, exists: () => false, homedir: () => 'C:\\Users\\agent' });
  for (const need of ['git', 'node', 'pwsh']) assert.ok(none.problems.some((p) => p.includes(`falta ${need}`)), `sin ${need} no hay medición`);
  assert.strictEqual(inventory.locate('whatever', { finder: () => ({ status: null, stdout: '', stderr: '', error: 'ENOENT' }), env: { PATH: '' } }).finder, 'path-scan');
  assert.strictEqual(inventory.locate('x', { finder: () => ({ status: null, stdout: '', stderr: '', error: 'ETIMEDOUT' }) }).state, 'error', 'un buscador que se cuelga no es «no está»');
  // el guion entero, en esta máquina: escribe su paso y sale 0
  const out = tmp('t2');
  try {
    const r2 = node([path.join(DIR, 'inventory.js'), '--out', out]);
    assert.strictEqual(r2.status, 0, r2.stderr);
    const step = JSON.parse(fs.readFileSync(path.join(out, 'steps', 'inventory.json'), 'utf8'));
    assert.strictEqual(step.name, 'inventory');
    assert.ok(['measured', 'error'].includes(step.status));
    for (const name of inventory.TOOLS) assert.ok(step.facts.tools[name], `el inventario trae ${name}`);
    assert.strictEqual(step.facts.tools.node.state, 'present');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

// ═══ T3 ════════════════════════════════════════════════════════════════════════════════════════════════════════

test('Probe_CountHooks_NamesMissingDuplicatedMisplacedAndDangling', () => {
  const allOn = { ado: true, clockify: true, engram: true, codegraph: true, mailbox: true, codex: true, nightly: true, telegram: true };
  const allOff = Object.fromEntries(Object.keys(allOn).map((k) => [k, false]));
  const HOME = 'C:/lab/profile'; const CLONE = 'C:/lab/work/harness-clone';
  // desde la W3 la lista esperada sale de la lista única del clon (scripts/setup/hooks-list.json), decidida con la
  // función del aplicador para Windows: con todo prendido, y la de una instalación pública
  const win = (integrations, env, exists) => count.expectedFromList(ROOT, { integrations, env, home: HOME, exists, platform: 'win32' });
  const team = win(allOn, { TYCON_SESSION_GUARD: '1' }, () => true);
  assert.deepStrictEqual(team.problems, []);
  const pub = win(allOff, {}, () => false);
  assert.deepStrictEqual(pub.problems, []);
  assert.ok(pub.hooks.length < team.hooks.length && pub.hooks.length > 20, `pública ${pub.hooks.length}, con todo prendido ${team.hooks.length}`);
  for (const h of pub.hooks) assert.ok(team.hooks.some((x) => x.event === h.event && x.relpath === h.relpath), `${h.relpath}: lo de la pública está en la de todo prendido`);
  assert.ok(pub.skipped.some((s) => /integración/.test(s.why)), 'los hooks de una integración apagada se dicen');
  assert.ok(team.skipped.some((s) => s.relpath === '@tcg:harness-bootstrap-heal.sh' && /fuera en Windows/.test(s.why)), 'lo que Windows excluye no se espera, y se dice');
  assert.strictEqual(win(allOff, { TYCON_SAFETY_GUARD: '0' }, () => false).hooks.length, pub.hooks.length - 1, 'un opt-in apagado por su variable sale de la lista');
  // sin la lista (un clon de antes de la W3) no hay lista que dar: se lee el instalador, como en W0
  assert.strictEqual(count.expectedFromList(path.join(ROOT, 'scripts', 'tests')), null);
  const edit = team.hooks.find((h) => h.relpath === 'tycon-pipeline/scripts/hook-pre-edit.js');
  assert.deepStrictEqual([edit.event, edit.matcher], ['PreToolUse', 'Edit|Write'], 'un matcher con | se lee entero');

  // el settings.json que deja HOY el instalador de Windows, contra la lista de todo prendido
  const today = count.compare(team.hooks, fixture('settings-ps1-today.json'), { superseded: team.superseded, home: HOME, clone: CLONE, exists: () => true, platform: 'win32' });
  // Los 18 que faltaban el 2026-10-03, por nombre. La lista del instalador de bash está viva y esta fixture es una foto:
  // si un hook de éstos se retira del instalador, deja de esperarse (y de faltar); si se suma uno nuevo, falta también.
  const MISSING_AT_BASELINE = [
    'PostToolUse:tycon-pipeline/scripts/on-skill-invoke.js', 'PreToolUse:@tcg:push-phantom-ref-notice.js', 'PreToolUse:@tcg:pr-one-per-repo-guard.js',
    'PreToolUse:@tcg:pr-auto-complete-guard.js', 'PreToolUse:tycon-pipeline/scripts/on-bash-write-gate.js', 'Stop:@tcg:large-read-meter.js',
    'SessionStart:@tcg:harness-bootstrap-heal.sh', 'SessionStart:@tcg:dependencies-notice.js', 'SessionStart:@tcg:lane-llm-notice.js',
    'PostToolUse:@tcg:missing-path-notice.js', 'UserPromptSubmit:@tcg:rebuild-before-verify.js', 'PostToolUse:@tcg:artifact-archive.js',
    'PreToolUse:@tcg:safety-guard-pre.sh', 'PreToolUse:@tcg:test-scope-guard-pre.sh', 'PreToolUse:@tcg:engram-pre-commit.sh',
    'SessionStart:@tcg:telegram-zombie-sweep.sh', 'PreToolUse:@tcg:session-collision-guard.js', 'SessionStart:@tcg:session-collision-guard.js',
  ];
  assert.strictEqual(MISSING_AT_BASELINE.length, 18);
  const missing = today.missing.map((m) => m.hook);
  const expectedNames = team.hooks.map((h) => `${h.event}:${h.relpath}`);
  for (const name of MISSING_AT_BASELINE) assert.ok(missing.includes(name) || !expectedNames.includes(name), `falta, por nombre: ${name}`);
  const brakesMissing = ['PreToolUse:@tcg:safety-guard-pre.sh', 'PreToolUse:@tcg:test-scope-guard-pre.sh', 'PreToolUse:tycon-pipeline/scripts/on-bash-write-gate.js'];
  for (const name of brakesMissing) assert.ok(missing.includes(name), `los frenos que el de Windows no registra, por nombre: ${name}`);
  // con la lista de hoy (45 registros), la cuenta exacta del análisis: faltan 18
  if (team.hooks.length === 45) assert.deepStrictEqual(missing.slice().sort(), MISSING_AT_BASELINE.slice().sort(), `faltan ${missing.length}: ${missing.join(', ')}`);
  else assert.ok(missing.length >= 12, `la lista del instalador cambió (${team.hooks.length} registros) y faltan ${missing.length}`);
  assert.deepStrictEqual(today.superseded.map((s) => s.hook).sort(), ['PostToolUse:tycon-ado-story-wi/scripts/on-story-create.js', 'PostToolUse:tycon-story-followup-link/scripts/on-story-create.js'], 'los 2 que correrían dos veces, por nombre');
  // Desde que los frenos miran también la herramienta PowerShell (main 05c1a625: matcher `Bash|PowerShell`), lo que la
  // foto vieja del .ps1 registra con `Bash` está en su evento pero con otro matcher: «mal ubicado», por nombre. Nada en
  // otro evento.
  assert.strictEqual(today.in_place, team.hooks.length - missing.length - today.misplaced.length);
  for (const m of today.misplaced) assert.strictEqual(m.found.event, m.expected.event, `${m.hook}: en su evento, con otro matcher`);
  assert.deepStrictEqual([today.duplicated.length, today.unexpected.length, today.dangling.length], [0, 0, 0]);
  assert.deepStrictEqual(today.startup_line, { count: 1, events: ['SessionStart'], is_async: [true] });
  assert.deepStrictEqual(today.runners, { node: 29 }, 'el de Windows sólo sabe escribir node');
  const ids = count.findingsOf(today).map((f) => f.id);
  assert.strictEqual(ids.length, missing.length + 2 + today.misplaced.length, 'un hallazgo por cada hook que falta, por cada uno que corre dos veces y por cada uno con otro matcher');
  assert.ok(ids.includes('hooks:missing:PreToolUse:@tcg:safety-guard-pre.sh') && ids.includes('hooks:superseded:PostToolUse:tycon-ado-story-wi/scripts/on-story-create.js'));
  assert.strictEqual(new Set(ids).size, ids.length, 'un id por hallazgo');

  // un hook en otro evento, uno repetido, uno del arnés fuera de la lista que además nombra un archivo que no existe
  const expected = [{ event: 'Stop', matcher: '', relpath: '@tcg:response-style-meter.js' }, { event: 'Stop', matcher: '', relpath: '@tcg:blocking-meter.js' }];
  const odd = count.compare(expected, fixture('settings-misplaced.json'), { superseded: [], home: HOME, clone: CLONE, exists: (f) => !/retired-notice/.test(f), platform: 'win32' });
  assert.deepStrictEqual(odd.misplaced, [{ hook: 'Stop:@tcg:response-style-meter.js', expected: { event: 'Stop', matcher: '' }, found: { event: 'PostToolUse', matcher: '' } }]);
  assert.deepStrictEqual(odd.duplicated, [{ hook: 'Stop:@tcg:blocking-meter.js', matcher: '', times: 2 }]);
  assert.deepStrictEqual(odd.dangling, [{ hook: 'Stop:@tcg:retired-notice.js', file: 'C:/lab/work/harness-clone/scripts/hooks/retired-notice.js' }]);
  assert.deepStrictEqual(odd.unexpected.map((u) => u.hook), ['Stop:@tcg:retired-notice.js']);
  assert.deepStrictEqual([odd.missing.length, odd.registered_foreign, odd.startup_line.count], [0, 1, 0], 'el hook ajeno no se cuenta; sin línea de arranque');
  assert.ok(count.findingsOf(odd).some((f) => f.id === 'hooks:startup-line-count'));

  // una lista que no se puede leer entera no se usa: lo dice
  assert.ok(count.expectedHooks('echo nada', {}).problems.length >= 3, 'sin las piezas del instalador: problemas, no una lista vacía');
  // …y una lista única que no pasa su validación tampoco: un `when` que el aplicador no conoce es un problema, no un
  // opt-in callado (la misma validación del aplicador, que con esa lista no escribe nada)
  const toy = fs.mkdtempSync(path.join(os.tmpdir(), 'count-hooks-list-'));
  try {
    fs.mkdirSync(path.join(toy, 'scripts', 'setup'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', 'apply-hooks.js'), path.join(toy, 'scripts', 'setup', 'apply-hooks.js'));
    const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8'));
    list.hooks.find((h) => h.spec === '@tcg:safety-guard-pre.sh').when = 'si uname es Linux';
    fs.writeFileSync(path.join(toy, 'scripts', 'setup', 'hooks-list.json'), JSON.stringify(list));
    assert.match(count.expectedFromList(toy, { integrations: allOff, env: {}, home: HOME, exists: () => false, platform: 'win32' }).problems.join(' '),
      /safety-guard-pre\.sh: when/, 'una condición que la lista no sabe decir es un problema, no un opt-in callado');
  } finally { fs.rmSync(toy, { recursive: true, force: true }); }
});

// La 8.16 C (perfiles) decide los opt-in en una línea aparte, `_OP=0; _optin_por_perfil VAR [freno] || _OP=$?`, y el
// `if` pregunta `"$_OP" == 0`. El 182 #11872 salió «no sé evaluar la condición» con esa forma: el lector la sigue con
// la misma regla que el instalador (en minimal sólo con VAR=1; VAR=0 apaga; perfil ilegible: los frenos se registran
// y lo demás queda como está).
test('Probe_CountHooks_ProfileOptinForm_FollowsInstallerRule', () => {
  const head = 'HOOKS_CANONICAL=(\n  "Stop||@tcg:a.js|a"\n)\nKNOWN_MATCHER_TOKENS = { "Bash" }\nSUPERSEDED_RELPATHS = { "x" }\n_hook_de_integracion() {\n  case "$1" in\n    *) return 1 ;;\n  esac\n}\nOPTIN_HOOKS=()\n';
  const block = (v, brake, rel, cond = '"$_OP" == 0') => `_OP=0; _optin_por_perfil ${v}${brake ? ' freno' : ''} || _OP=$?\nif [[ ${cond} ]]; then\n  OPTIN_HOOKS+=(\n    "PreToolUse|Bash|@tcg:${rel}|x"\n  )\nfi\n`;
  const text = head + block('TYCON_SAFETY_GUARD', true, 'freno.sh') + block('TYCON_TG_ZOMBIE_SWEEP', false, 'tg.sh', '-d "$HOME/.claude/tg" && "$_OP" == 0');
  const names = (o) => { const r = count.expectedHooks(text, Object.assign({ integrations: {}, home: 'H', exists: () => true }, o)); assert.deepStrictEqual(r.problems, [], JSON.stringify(r.problems)); return r.hooks.map((h) => h.relpath).filter((p) => p !== '@tcg:a.js').sort(); };
  assert.deepStrictEqual(names({ env: {} }), ['@tcg:freno.sh', '@tcg:tg.sh'], 'full (sin elegir): los dos, como antes de los perfiles');
  assert.deepStrictEqual(names({ env: { TYCON_SAFETY_GUARD: '0' } }), ['@tcg:tg.sh'], 'la variable en 0 apaga');
  assert.deepStrictEqual(names({ env: {}, profile: { state: 'rota', value: null } }), ['@tcg:freno.sh'], 'perfil ilegible: el freno se registra, el otro queda como está');
  assert.deepStrictEqual(names({ env: {}, exists: () => false }), ['@tcg:freno.sh'], 'la otra cláusula del && sigue contando');
  const minimal = count.expectedHooks(text, { integrations: {}, env: { TYCON_SAFETY_GUARD: '1' }, home: 'H', exists: () => true, profile: { state: 'ok', value: 'minimal' } });
  assert.match(minimal.problems.join(' '), /perfil minimal/, 'minimal: lo dice, no compara contra la lista de full');
  const orphan = text.replace(/^_OP=0; _optin_por_perfil TYCON_SAFETY_GUARD freno \|\| _OP=\$\?\n/m, '');
  assert.match(count.expectedHooks(orphan, { integrations: {}, env: {}, home: 'H', exists: () => true }).problems.join(' '), /no sé evaluar la condición/, 'sin la línea que decide _OP: problema, no un sí callado');
  // y contra el instalador de la 8.16 C de verdad, si está a mano
  const real = process.env.COUNT_HOOKS_C_INSTALLER;
  if (real) {
    const allOff = { ado: false, clockify: false, engram: false, codegraph: false, mailbox: false, codex: false, nightly: false, telegram: false };
    const r = count.expectedHooks(fs.readFileSync(real, 'utf8'), { integrations: allOff, env: {}, home: 'H', exists: () => false });
    assert.deepStrictEqual(r.problems, []);
    for (const b of ['@tcg:safety-guard-pre.sh', '@tcg:test-scope-guard-pre.sh']) assert.ok(r.hooks.some((h) => h.relpath === b), `${b} esperado con el perfil del equipo`);
  }
});

// Pase adversarial de la corrida 8.17-W0-20261005T0153 (clases 1, 12 y 17): el id de un hallazgo es lo que se declara
// en known-gaps.json. Un archivo esperado dos veces en el mismo evento con matchers distintos (rebuild-before-verify.js
// en PostToolUse: Edit|Write y Bash) daba un solo id y uno de los dos registros quedaba sin medir; y un archivo
// esperado en dos eventos salía con los nombres cruzados si estaba corrido de matcher.
// Pase adversarial de la W3W4 (clases 1 y 12, 2026-10-05): desde la W4 un .sh se registra en Windows con la ruta del bash
// de Git ENTRE COMILLAS («"C:/…/bash.exe" "…/x.sh"»), y el lector sólo entendía un intérprete como palabra suelta: daba
// los frenos por faltantes estando registrados, y no veía un .sh repetido ni uno colgado. 🔴 rojo previo: missing con los
// dos frenos, duplicated y dangling vacíos.
test('Probe_CountHooks_QuotedGitBashInterpreter_IsReadAsRegistered', () => {
  const HOME = 'C:/lab/profile'; const CLONE = 'C:/lab/work/harness-clone';
  const GB = '"C:/Program Files/Git/bin/bash.exe"';
  const sh = (name) => `${GB} "${CLONE}/scripts/hooks/${name}"`;
  assert.deepStrictEqual(count.commandFile(sh('safety-guard-pre.sh')), { runner: 'bash', file: `${CLONE}/scripts/hooks/safety-guard-pre.sh` });
  const expected = [{ event: 'PreToolUse', matcher: 'Bash|PowerShell', relpath: '@tcg:safety-guard-pre.sh' }, { event: 'PreToolUse', matcher: 'Bash|PowerShell', relpath: '@tcg:test-scope-guard-pre.sh' }];
  const settings = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [
    { type: 'command', command: sh('safety-guard-pre.sh') }, { type: 'command', command: sh('test-scope-guard-pre.sh') },
    { type: 'command', command: sh('safety-guard-pre.sh') }, { type: 'command', command: sh('gone.sh') },
  ] }] } };
  const r = count.compare(expected, settings, { superseded: [], home: HOME, clone: CLONE, exists: (f) => !/gone\.sh/.test(f), platform: 'win32' });
  assert.deepStrictEqual(r.missing, [], 'los dos frenos están registrados');
  assert.strictEqual(r.duplicated.length, 1, 'el repetido se ve');
  assert.strictEqual(r.dangling.length, 1, 'el que nombra un guion que no existe se ve');
});

test('Probe_CountHooks_SameFileTwiceInAnEvent_IdsCarryTheMatcher_MisplacedPrefersTheSameEvent', () => {
  const HOME = 'C:/lab/profile'; const CLONE = 'C:/lab/work/harness-clone';
  const cmd = (f) => ({ type: 'command', command: `node "${CLONE}/scripts/hooks/${f}"` });
  const opts = { superseded: [], home: HOME, clone: CLONE, exists: () => true, platform: 'win32' };
  const twice = [{ event: 'PostToolUse', matcher: 'Edit|Write', relpath: '@tcg:rebuild-before-verify.js' }, { event: 'PostToolUse', matcher: 'Bash', relpath: '@tcg:rebuild-before-verify.js' }, { event: 'Stop', matcher: '', relpath: '@tcg:blocking-meter.js' }];
  // ninguno de los dos registros: dos hallazgos, cada uno con su matcher; el que está una sola vez no cambia de nombre
  const none = count.compare(twice, { hooks: { Stop: [{ hooks: [cmd('blocking-meter.js')] }] } }, opts);
  assert.deepStrictEqual(none.missing.map((m) => m.hook), ['PostToolUse:@tcg:rebuild-before-verify.js [Edit|Write]', 'PostToolUse:@tcg:rebuild-before-verify.js [Bash]']);
  const ids = count.findingsOf(none).map((f) => f.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'un id por registro');
  // falta sólo uno: el id dice cuál; si mañana falta el otro, es otro id (un hallazgo nuevo, y el viejo, vencido)
  const onlyEdit = count.compare(twice, { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [cmd('rebuild-before-verify.js')] }], Stop: [{ hooks: [cmd('blocking-meter.js')] }] } }, opts);
  const onlyBash = count.compare(twice, { hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [cmd('rebuild-before-verify.js')] }], Stop: [{ hooks: [cmd('blocking-meter.js')] }] } }, opts);
  assert.notDeepStrictEqual(count.findingsOf(onlyEdit).map((f) => f.id), count.findingsOf(onlyBash).map((f) => f.id));
  // dos registros sobrantes del mismo archivo en el mismo evento: dos nombres
  const extra = count.compare([], { hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [cmd('rebuild-before-verify.js')] }, { matcher: 'Bash', hooks: [cmd('rebuild-before-verify.js')] }] } }, opts);
  assert.deepStrictEqual(extra.unexpected.map((u) => u.hook).sort(), ['PostToolUse:@tcg:rebuild-before-verify.js [Bash]', 'PostToolUse:@tcg:rebuild-before-verify.js [Edit|Write]']);
  // un archivo esperado en Stop y en PostToolUse (Bash): está sólo en PostToolUse con otro matcher → el corrido es el
  // de PostToolUse y el que falta es el de Stop, no al revés
  const two = [{ event: 'Stop', matcher: '', relpath: '@tcg:retro-pending.js' }, { event: 'PostToolUse', matcher: 'Bash', relpath: '@tcg:retro-pending.js' }];
  const crossed = count.compare(two, { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [cmd('retro-pending.js')] }] } }, opts);
  assert.deepStrictEqual(crossed.misplaced.map((m) => m.hook), ['PostToolUse:@tcg:retro-pending.js']);
  assert.deepStrictEqual(crossed.missing.map((m) => m.hook), ['Stop:@tcg:retro-pending.js']);
});

// ═══ T4 ════════════════════════════════════════════════════════════════════════════════════════════════════════

// La lista se escribe desde una corrida de `measure`, pero también la leen el banco y los ensayos (los huecos
// `bench:red:…` de W1, con su `match`): proponer desde una medición no los borra — conserva los huecos declarados de
// los pasos que esa corrida no mide, tal cual, y reemplaza los de los pasos que sí midió.
test('Probe_ProposeGaps_KeepsTheDeclaredGapsOfStepsTheReportDoesNotMeasure', () => {
  const report = fixture('report-no-session.json');
  const bench = { id: 'bench:red:x.sh::y', step: 'bench', closes: 'W4', match: '^stdout no matchea', note: 'medido en la corrida 1' };
  const stale = { id: 'hooks:missing:Stop:@tcg:old.js', step: 'count-hooks', closes: 'W4', note: 'de una corrida vieja' };
  const kept = run.proposeGaps(report, { baseline: null, gaps: [bench, stale] });
  assert.deepStrictEqual(kept.gaps.find((g) => g.id === bench.id), bench, 'el hueco del banco queda tal cual, con su match');
  assert.ok(!kept.gaps.some((g) => g.id === stale.id), 'un hueco de un paso que la corrida midió se reemplaza por lo que midió');
  assert.deepStrictEqual(kept.gaps.filter((g) => g.step !== 'bench').map((g) => g.id).sort(), run.proposeGaps(report).gaps.map((g) => g.id).sort());
  assert.ok(kept.baseline && kept.baseline.run === '4242');
  // un paso que aparece pero no midió («no medido» o «error») tampoco dice nada de sus huecos: se conservan
  const session = { id: 'session:x', step: 'session-probe', closes: 'W5', note: 'medido en la VM' };
  assert.strictEqual(report.steps.find((s) => s.name === 'session-probe').status, 'not-measured', 'la fixture trae la sesión sin medir');
  assert.ok(run.proposeGaps(report, { baseline: null, gaps: [session] }).gaps.some((g) => g.id === session.id), 'el hueco de un paso no medido queda');
  const failed = clone(report); Object.assign(failed.steps.find((s) => s.name === 'count-hooks'), { status: 'error', reason: 'x', findings: [] });
  assert.ok(run.proposeGaps(failed, { baseline: null, gaps: [stale] }).gaps.some((g) => g.id === stale.id), 'y el de un paso en error también');
  // por la línea de comandos: --keep <known-gaps.json>
  const base = tmp('keep');
  try {
    fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify(report));
    fs.writeFileSync(path.join(base, 'gaps.json'), JSON.stringify({ baseline: null, gaps: [bench] }));
    const r = node([path.join(DIR, 'run.js'), 'propose-gaps', path.join(base, 'report.json'), '--keep', path.join(base, 'gaps.json')]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).gaps.some((g) => g.id === bench.id));
    const bad = node([path.join(DIR, 'run.js'), 'propose-gaps', path.join(base, 'report.json'), '--keep', path.join(base, 'no-such.json')]);
    assert.notStrictEqual(bad.status, 0, 'una lista para conservar que no se puede leer no pasa como vacía');
    fs.writeFileSync(path.join(base, 'no-gaps.json'), JSON.stringify({ baseline: null }));
    const noGaps = node([path.join(DIR, 'run.js'), 'propose-gaps', path.join(base, 'report.json'), '--keep', path.join(base, 'no-gaps.json')]);
    assert.notStrictEqual(noGaps.status, 0, 'una lista sin «gaps» tampoco');
    assert.match(noGaps.stderr + noGaps.stdout, /no trae «gaps»/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Probe_Verdict_EmptyReportRed_NewFindingRed_StaleGapRed_CappedStepRed', () => {
  const report = fixture('report-no-session.json');
  const declared = run.proposeGaps(report);
  assert.ok(declared.baseline && declared.baseline.run === '4242', 'la lista propuesta lleva su corrida de base');
  assert.ok(declared.gaps.length === 5 && declared.gaps.every((g) => run.BATCHES.includes(g.closes) && g.step), 'cada hueco, con su tanda y su paso');

  // verde: todo medido (la sesión, «no medido» con su motivo) y la lista al día
  const green = run.verdict(report, declared);
  assert.strictEqual(green.color, 'green', JSON.stringify(green));
  assert.deepStrictEqual([green.mode, green.new_findings.length, green.known.length, green.not_measured.length], ['against-known-gaps', 0, 5, 1]);

  // 1 · vacío
  for (const empty of [{ steps: [] }, {}, null]) {
    const v = run.verdict(empty, declared);
    assert.strictEqual(v.color, 'red');
    assert.match(v.errors.join(' '), /no trae ningún paso/);
  }
  // 2 · un hallazgo que no está en la lista
  const extra = clone(report);
  extra.steps[2].findings.push({ id: 'hooks:missing:Stop:@tcg:new-one.js', kind: 'hook-missing', detail: 'nuevo' });
  const v2 = run.verdict(extra, declared);
  assert.strictEqual(v2.color, 'red');
  assert.deepStrictEqual(v2.new_findings.map((f) => `${f.step}/${f.id}`), ['count-hooks/hooks:missing:Stop:@tcg:new-one.js'], 'nombra el hallazgo y su paso');
  // 3 · un hueco que ya no se reproduce
  const fixed = clone(report);
  fixed.steps[1].findings = [];
  const v3 = run.verdict(fixed, declared);
  assert.strictEqual(v3.color, 'red');
  assert.match(v3.stale_gaps.join(' '), /^eol:sh-with-cr .*borrarlo/, 'nombra el hueco que hay que borrar');
  //     … pero de un paso que no midió no se dice que su hueco «ya no se reproduce»
  const unknown = clone(report);
  Object.assign(unknown.steps[1], { status: 'not-measured', reason: 'x', findings: [] });
  assert.deepStrictEqual(run.verdict(unknown, declared).stale_gaps, []);
  // 4 · un paso que vence su tope (corrido de verdad, bajo run-capped.js)
  const base = tmp('t4');
  try {
    const slow = path.join(base, 'slow-step.js');
    fs.writeFileSync(slow, 'setTimeout(() => {}, 60000);\n');
    const capped = run.runStep('install', { out: path.join(base, 'out'), cap: 1, script: slow, quiet: true });
    assert.strictEqual(capped.status, 'error');
    assert.match(capped.reason, /el paso install venció su tope de 1 s/);
    const late = clone(report);
    late.steps[1] = capped;
    const v4 = run.verdict(late, declared);
    assert.strictEqual(v4.color, 'red');
    assert.ok(v4.errors.some((e) => /^install: .*venció su tope/.test(e)), 'nombra el paso');
    // un guion que se cae sin dejar su resultado también es un error con nombre; y lo parcial que dejó no se pierde
    const crash = path.join(base, 'crash-step.js');
    fs.writeFileSync(crash, `require(${JSON.stringify(path.join(DIR, 'lab.js'))}).recorder('count-hooks', process.argv[process.argv.indexOf('--out') + 1]).fact('half', 1); process.exit(3);\n`);
    const crashed = run.runStep('count-hooks', { out: path.join(base, 'out'), script: crash, quiet: true });
    assert.deepStrictEqual([crashed.status, crashed.facts.half], ['error', 1]);
    assert.match(crashed.reason, /terminó \(salió 3\) sin dejar su resultado/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
  // un paso que falta, un estado que no existe, un hueco sin tanda, y la lista ilegible: rojo
  const short = clone(report); short.steps.pop();
  assert.deepStrictEqual(run.verdict(short, declared).missing_steps, ['session-probe']);
  const odd = clone(report); odd.steps[0].status = 'ok';
  assert.match(run.verdict(odd, declared).errors.join(' '), /estado desconocido/);
  const loose = clone(declared); loose.gaps[0].closes = '?';
  assert.strictEqual(run.verdict(report, loose).color, 'red');
  assert.strictEqual(run.verdict(report, null).color, 'red', 'sin la lista no hay verde');

  // la PRIMERA medición (lista sin línea de base): los hallazgos no ponen roja la corrida; no haber podido medir, sí
  const first = run.verdict(report, { baseline: null, gaps: [] });
  assert.deepStrictEqual([first.color, first.mode, first.new_findings.length], ['green', 'first-measurement', 5]);
  const broken = clone(report); Object.assign(broken.steps[0], { status: 'error', reason: 'no pude medir: falta git en la máquina' });
  assert.strictEqual(run.verdict(broken, { baseline: null, gaps: [] }).color, 'red');
  assert.strictEqual(run.verdict({ steps: [] }, { baseline: null, gaps: [] }).color, 'red');
  // la lista versionada nace vacía y sin línea de base: se escribe desde la primera corrida
  const shipped = JSON.parse(fs.readFileSync(path.join(DIR, 'known-gaps.json'), 'utf8'));
  assert.ok(Array.isArray(shipped.gaps) && Object.prototype.hasOwnProperty.call(shipped, 'baseline'));
  for (const g of shipped.gaps) assert.ok(g.id && g.step && run.BATCHES.includes(g.closes), `${g.id}: cada hueco dice su paso y su tanda`);
  // sin línea de base, los únicos huecos escritos son los del banco (`bench:red:…`, tanda W1): los lee además
  // scripts/controls-bench/runner.js y cada uno trae el motivo con que falla su caso, medido en una corrida
  if (shipped.baseline === null) for (const g of shipped.gaps) assert.ok(g.step === 'bench' && /^bench:red:/.test(g.id) && g.match && /corrida \d+/.test(g.note || ''), `${g.id}: sin línea de base sólo hay huecos del banco, con su motivo y su corrida`);
  // el resumen legible sale de cualquier reporte, también del rojo
  const md = run.renderMarkdown(Object.assign(clone(extra), { verdict: v2 }));
  assert.match(md, /## Veredicto: ROJO/);
  assert.match(md, /Hallazgos NUEVOS[\s\S]*hooks:missing:Stop:@tcg:new-one\.js/);
  assert.match(md, /## Lo que no se sabía sin una máquina Windows/);
});

// ═══ T5 ════════════════════════════════════════════════════════════════════════════════════════════════════════

test('Probe_NamesInEnglish_RefusesRealUserFolder', async (t) => {
  const mine = [...fs.readdirSync(DIR).map((f) => path.join(DIR, f)), ...fs.readdirSync(FIXTURES).map((f) => path.join(FIXTURES, f)), __filename, path.join(__dirname, 'windows-rehearsal.test.js'), path.join(__dirname, 'windows-portable.test.js')];

  await t.test('los nombres que lee la máquina están en inglés', (t2) => {
    let sn;
    try { sn = require(path.join(ROOT, 'scripts', 'publishing', 'spanish-names.js')); } catch (e) { t.diagnostic(`NO MEDIDO — no pude cargar el freno de nombres: ${e.message}`); return; }
    const det = sn.makeDetector(sn.loadWords(fs.readFileSync(path.join(ROOT, sn.WORDS_PATH), 'utf8'), sn.WORDS_PATH));
    // sin el diccionario inglés el detector no distingue (el agente Linux de Azure no lo trae: corrida 11874), como en
    // spanish-names.test.js: NO MEDIDO con su motivo, nunca un falso rojo ni un verde vacío
    if (!det.dictionary) { t2.skip(`NO MEDIDO: esta máquina no tiene ${det.dictPath} — sin él el detector de castellano no distingue`); return; }
    const names = new Set(mine.map((f) => path.basename(f).replace(/\.(test\.)?(js|json|sh)$/, '')));
    for (const f of mine.filter((x) => /\.(js|sh)$/.test(x))) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/'--([a-z][a-z-]+)'/g)) names.add(m[1]);                  // las opciones
      for (const m of text.matchAll(/\b(TYCON_WINDOWS_[A-Z_]+)\b/g)) names.add(m[1]);          // las variables nuevas
    }
    for (const k of [...Object.keys(fixture('report-complete.json')), ...Object.keys(fixture('report-complete.json').run), ...Object.keys(JSON.parse(fs.readFileSync(path.join(DIR, 'known-gaps.json'), 'utf8'))), ...run.STEPS.map((s) => s.name)]) names.add(k.replace(/^__/, ''));
    assert.ok(names.size > 30, `sólo ${names.size} nombres leídos: el lector no leyó nada`);
    const spanish = [...names].filter((n) => det.isSpanish(n).spanish);
    assert.deepStrictEqual(spanish, [], `nombres en castellano en lo que lee la máquina: ${spanish.join(', ')}`);
    assert.strictEqual(det.isSpanish('contar-hooks').spanish, true, 'control positivo: el detector reconoce un nombre en castellano');
  });

  // Pase adversarial de la corrida 8.17-W0-20261005T0153 (clase 19): la organización de Azure escrita en un fixture y una
  // credencial de mentira escrita entera frenaban al exportador, y con ellos la medición `measure` y la copia pública.
  await t.test('el detector de publicación no frena ningún archivo del instrumento', (t2) => {
    const config = path.join(ROOT, 'scripts', 'publishing', 'denylist.json');
    if (!fs.existsSync(config)) { t2.skip('NO MEDIDO — sin la lista privada (copia pública): ahí el detector no tiene con qué mirar'); return; }
    const files = mine.filter((f) => fs.statSync(f).isFile());
    const r = node([path.join(ROOT, 'scripts', 'publishing', 'detector.js'), '--config', config, '--json', ...files]);
    let found;
    try { found = JSON.parse(r.stdout); } catch (e) { assert.fail(`el detector no devolvió JSON (salió ${r.status}): ${r.stderr}`); }
    const hits = (found.hallazgos || []).map((h) => `${h.archivo}:${h.linea} · ${h.categoria}`);
    assert.deepStrictEqual(hits, [], `el detector frena: ${hits.join(', ')}`);
    assert.strictEqual(r.status, 0, r.stderr);
  });

  await t.test('los dos frenos de nombres, sobre los archivos de la tanda (índice temporal: no toca el del repo)', (t2) => {
    const team = fs.existsSync(path.join(ROOT, 'perfil-equipo.json')) && fs.existsSync(path.join(ROOT, '.git'));
    if (!team) { t2.skip('NO MEDIDO — sin el repo del equipo (copia pública o sin git): ahí los frenos no tienen lista'); return; }
    const base = tmp('t5-index');
    try {
      // los frenos dejan una línea de conteos en ~/.claude/.tycon-pipeline: con una carpeta de usuario de la prueba, no
      // escriben en la de quien la corre. agent-skills (su otra fuente) se les dice por variable.
      const skills = process.env.TYCON_SKILLS_DIR || path.join(os.homedir(), '.claude', 'agent-skills', 'skills');
      const env = Object.assign({}, process.env, { GIT_INDEX_FILE: path.join(base, 'index'), HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home') });
      if (fs.existsSync(skills)) env.TYCON_SKILLS_DIR = skills;
      fs.mkdirSync(env.HOME);
      const git = (args) => spawnSync('git', args, { cwd: ROOT, env, encoding: 'utf8' });
      assert.strictEqual(git(['read-tree', 'HEAD']).status, 0, 'no pude armar el índice temporal');
      const added = git(['add', '--', ...[...mine, PIPELINE].filter((f) => fs.existsSync(f)).map((f) => path.relative(ROOT, f))]);
      assert.strictEqual(added.status, 0, `no pude sumar los archivos al índice temporal: ${added.stderr}`);
      for (const brake of ['spanish-names.js', 'new-names.js']) {
        const r = node([path.join(ROOT, 'scripts', 'publishing', brake), '--repo', ROOT], { env, cwd: ROOT });
        assert.strictEqual(r.status, 0, `${brake} salió ${r.status}: ${(r.stderr || r.stdout).split('\n').slice(0, 6).join(' | ')}`);
      }
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  await t.test('nada nombra el repo público ni trae una dirección sin marcador', (t2) => {
    const files = [...mine, PIPELINE].filter((x) => fs.existsSync(x));
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const urls = [...text.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.{}-]+\/[A-Za-z0-9_.{}-]+)/g)].map((m) => m[1]).filter((u) => !/^(\{\{public-org\}\}\/\{\{public-repo\}\}|acme\/)/.test(u));
      assert.deepStrictEqual(urls, [], `${path.relative(ROOT, f)} nombra un repo de GitHub: ${urls.join(', ')}`);
    }
    // el nombre mismo (el de public-repos.json, leído con el lector del exportador y nunca impreso): la carpeta en que
    // clona el bloque de la portada se llama igual, así que es fácil escribirlo sin querer en una fixture
    const own = path.join(ROOT, 'scripts', 'publishing', 'public-repos.json');
    if (!fs.existsSync(own)) { t2.diagnostic('NO MEDIDO — sin public-repos.json (copia pública): el nombre no se puede comparar'); return; }
    const name = require(path.join(ROOT, 'scripts', 'publishing', 'export.js')).readPublicRepo(own);
    // el repo como repo: «<org>/<repo>». El nombre suelto coincide con el de la carpeta donde se instala el arnés
    // (~/.claude/<repo>) y con el del comando que deja el paquete de npm, que estas pruebas nombran a propósito
    const needle = `${name.org}/${name.repo}`.toLowerCase();
    assert.ok(String(name.repo).length > 3 && String(name.org).length > 1, 'el lector del exportador no devolvió el nombre');
    // Una sola excepción, desde el corte (story 8.26, AC 61): el recurso «arnes» del pipeline nombra el repo público,
    // porque `resources` de Azure no acepta variables ni parámetros. Sólo esa línea, y sólo en el pipeline
    const resourceLine = new RegExp(`^\\s+name:\\s*${String(name.org).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${String(name.repo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im');
    const textOf = (f) => { const t = fs.readFileSync(f, 'utf8'); return f === PIPELINE ? t.replace(resourceLine, '') : t; };
    const naming = files.filter((f) => textOf(f).toLowerCase().includes(needle)).map((f) => path.relative(ROOT, f));
    assert.deepStrictEqual(naming, [], 'estos archivos nombran el repo público: ese nombre vive sólo en public-repos.json');
  });

  await t.test('nada trae una ruta con forma de carpeta de usuario: la frena el detector del exportador, y con él el bundle', (t2) => {
    let rule;
    try { rule = require(path.join(ROOT, 'scripts', 'publishing', 'detector.js')).PATRONES_GENERICOS.find((r) => r.nombre === 'ruta-de-maquina'); } catch (e) { rule = null; }
    if (!rule) { t2.skip('NO MEDIDO — no pude cargar la regla del detector'); return; }
    for (const f of [...mine, PIPELINE].filter((x) => fs.existsSync(x))) {
      const found = fs.readFileSync(f, 'utf8').match(new RegExp(rule.regex.source, rule.regex.flags)) || [];
      assert.deepStrictEqual(found, [], `${path.relative(ROOT, f)} trae una ruta de máquina: el exportador rechaza la copia y el trabajo Bundle no arma nada`);
    }
    assert.ok(new RegExp(rule.regex.source, rule.regex.flags).test(['', 'Users', 'someone', '.claude'].join('/')), 'control positivo: la regla reconoce una carpeta de usuario');
  });

  await t.test('run.js se niega a medir fuera de un laboratorio, y no escribe', () => {
    const base = tmp('t5');
    try {
      const out = path.join(base, 'out');
      const real = os.homedir();
      // la carpeta de usuario real, una carpeta sin la marca, y una dentro del .claude real: se niega las tres veces
      for (const [lab, why] of [[real, /carpeta de usuario real/], [path.join(base, 'not-a-lab'), /no tiene la marca del laboratorio/], [path.join(real, '.claude', 'windows-lab'), /dentro de la carpeta \.claude real/]]) {
        const before = listing(lab === real ? path.join(real, '.claude', '.tycon-pipeline', 'harness') : lab);
        const r = node([path.join(DIR, 'run.js'), 'step', 'install', '--lab', lab, '--out', out, '--allow-temp']);
        assert.strictEqual(r.status, 2, `${lab}: salió ${r.status}`);
        assert.match(r.stderr, why);
        assert.ok(!fs.existsSync(out), 'no escribió ni la carpeta del reporte');
        assert.deepStrictEqual(listing(lab === real ? path.join(real, '.claude', '.tycon-pipeline', 'harness') : lab), before, 'no escribió en la carpeta');
      }
      assert.match(run.labRootProblem(path.dirname(real)) || '', /la contiene/, 'un laboratorio que contiene la carpeta de usuario real tampoco');
      assert.match(run.labRootProblem('C:\\Users\\agent\\AppData\\Local\\Temp\\lab', { realHome: 'C:\\Users\\agent', tmpdir: 'C:\\Users\\agent\\AppData\\Local\\Temp', platform: 'win32' }) || '', /bajo la carpeta temporal/, 'en Windows, el laboratorio va fuera de %TEMP%');
      assert.strictEqual(run.labRootProblem('D:\\a\\1\\tycon-lab', { realHome: 'C:\\Users\\agent', tmpdir: 'C:\\Users\\agent\\AppData\\Local\\Temp', platform: 'win32' }), null);
      // la carpeta de usuario de cada variante: dentro del laboratorio, con su marca, y nunca la real
      const lab = path.join(base, 'lab');
      fs.mkdirSync(lab); fs.writeFileSync(path.join(lab, L.LAB_MARK), '{}\n');
      assert.strictEqual(L.labHomeProblem(path.join(lab, 'users', 'lab-user'), { labRoot: lab }), null);
      assert.match(L.labHomeProblem(real, { labRoot: lab }), /carpeta de usuario real/);
      assert.match(L.labHomeProblem(path.join(base, 'elsewhere'), { labRoot: lab }), /no está dentro del laboratorio/);
      assert.match(L.labHomeProblem(path.join(base, 'x', 'home'), { labRoot: path.join(base, 'x') }), /no tiene la marca/);
      // los guiones de los pasos, llamados sueltos, tampoco miden sin la marca
      for (const script of ['install-probe.js', 'fire-registered.js', 'pipeline-skeleton.js']) {
        const r = node([path.join(DIR, script), '--lab', path.join(base, 'not-a-lab'), '--out', out]);
        assert.strictEqual(r.status, 2, `${script} salió ${r.status}`);
        assert.ok(!fs.existsSync(out), `${script} no escribió`);
      }
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  await t.test('el ambiente de cada paso lleva TYCON_NO_NIGHTLY_EXAM=1 y la carpeta de laboratorio', () => {
    const env = run.stepEnv({ PATH: '/bin', GIT_DIR: '/somewhere/.git', TYCON_NO_NIGHTLY_EXAM: '0' });
    assert.strictEqual(env.TYCON_NO_NIGHTLY_EXAM, '1');
    assert.ok(!('GIT_DIR' in env), 'el git de quien lanza no entra');
    const lab = L.labEnv('C:\\lab\\users\\lab-user', { base: { Path: 'C:\\bin', userprofile: 'C:\\Users\\agent' }, platform: 'win32' });
    assert.deepStrictEqual([lab.TYCON_NO_NIGHTLY_EXAM, lab.HOME, lab.userprofile, lab.HOMEDRIVE, lab.HOMEPATH], ['1', 'C:\\lab\\users\\lab-user', 'C:\\lab\\users\\lab-user', 'C:', '\\lab\\users\\lab-user']);
    assert.ok(!('USERPROFILE' in lab), 'en Windows los nombres no distinguen caja: se pisa la clave que ya está');
    assert.strictEqual(L.pathKey(lab), 'Path');
  });
});

// ═══ T12 ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test('Probe_Session_OffSaysNotMeasured_SecretNeverInReport', () => {
  // inventada, y armada al correr: escrita entera tiene forma de llave y el detector de publicación la frena
  const SECRET = ['sk', 'ant', 'fake', 'credential', '0123456789'].join('-');
  const base = tmp('t12');
  try {
    // sin pedirla: «no medido: falta la sesión real», aunque la credencial esté en el ambiente
    const out = path.join(base, 'out');
    const r = node([path.join(DIR, 'session-probe.js'), '--out', out], { env: Object.assign({}, process.env, { [session.CREDENTIAL_VAR]: SECRET }) });
    assert.strictEqual(r.status, 0, r.stderr);
    const step = JSON.parse(fs.readFileSync(path.join(out, 'steps', 'session-probe.json'), 'utf8'));
    assert.strictEqual(step.status, 'not-measured');
    assert.match(step.reason, /^falta la sesión real/);
    assert.match(r.stdout, /no medido: falta la sesión real/);
    assert.ok(!`${r.stdout}${r.stderr}${JSON.stringify(step)}`.includes(SECRET), 'la credencial no aparece en la salida ni en el paso');
    // …y la corrida no cambia de color por eso
    const report = fixture('report-no-session.json');
    report.steps[report.steps.findIndex((s) => s.name === 'session-probe')] = step;
    const v = run.verdict(report, run.proposeGaps(report));
    assert.deepStrictEqual([v.color, v.not_measured.length], ['green', 1]);
    // pedida y sin credencial (o con la variable de Azure sin definir): «no medido», con el motivo
    const recorder = (name) => L.recorder('session-probe', path.join(base, name));
    for (const credential of [null, '', '$(windowsSessionCredential)']) {
      const m = session.measure({ lab: base, realSession: true, credential, rec: recorder('none') });
      assert.strictEqual(m.status, 'not-measured');
      assert.match(m.reason, /falta la credencial del asistente/);
    }
    // pedida y con credencial, con un lanzador de mentira que la repite en todo lo que devuelve: no llega al reporte
    const lab = path.join(base, 'lab');
    fs.mkdirSync(lab); fs.writeFileSync(path.join(lab, L.LAB_MARK), '{}\n');
    const seen = [];
    const runner = (bin, args, opts) => {
      seen.push(opts.env.ANTHROPIC_API_KEY);
      assert.ok(![bin, ...args].join(' ').includes(SECRET), 'la credencial no viaja por la línea de comandos');
      if (args.includes('-p')) {   // la «sesión»: dispara el marcador como lo haría el asistente
        const settings = JSON.parse(fs.readFileSync(path.join(opts.env.HOME, '.claude', 'settings.json'), 'utf8'));
        const [, marker, , log] = /^node "([^"]+)" (\S+) "([^"]+)"$/.exec(settings.hooks.PreToolUse[0].hooks[0].command);
        for (const [label, tool] of [['any', 'Bash'], ['matcher-Bash', 'Bash'], ['any', 'PowerShell'], ['matcher-PowerShell', 'PowerShell']]) {
          spawnSync(process.execPath, [marker, label, log], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: `echo ${SECRET}` }, cwd: opts.cwd, transcript_path: path.join(opts.cwd, 't.jsonl') }) });
        }
      }
      return { exit: 0, error: null, timed_out: false, stdout: `ok ${SECRET}`, stderr: `warn ${SECRET}`, ms: 5 };
    };
    const rec = recorder('real');
    const fakeBin = path.join(base, 'bin'); fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const m = session.measure({ lab, realSession: true, credential: SECRET, allowTemp: true, rec, runner, baseEnv: Object.assign({}, process.env, { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, [session.CREDENTIAL_VAR]: SECRET }) });
    assert.strictEqual(m.status, 'measured', m.reason);
    rec.finish(m.status, m.reason);
    const written = fs.readFileSync(path.join(base, 'real', 'steps', 'session-probe.json'), 'utf8');
    assert.ok(seen.length >= 4 && seen.every((s) => s === SECRET), 'la credencial llega al asistente por su ambiente');
    assert.ok(!written.includes(SECRET), 'la credencial no queda en el paso');
    assert.ok(written.includes(L.REDACTED_SECRET), 'donde estaba, queda la marca');
    const answers = JSON.parse(written).facts.answers;
    assert.deepStrictEqual(answers.terminal_tool_names, ['Bash', 'PowerShell']);
    assert.strictEqual(answers.bash_matcher_sees_powershell_tool, false, 'el matcher Bash no vio la herramienta PowerShell');
    assert.ok(Array.isArray(answers.hook_shell) && answers.hook_shell.length === 1);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
  // el que tapa: la credencial y la dirección del repo público, en sus tres formas, en claves y valores
  const clean = L.redactor({ publicUrl: 'https://example.com/acme/toy-harness', secrets: [SECRET] });
  assert.deepStrictEqual(clean({ a: `x ${SECRET} y`, b: ['git clone https://example.com/acme/toy-harness.git', 'acme/toy-harness', 'C:\\work\\toy-harness\\scripts'], 'https://example.com/acme/toy-harness': 1 }),
    { a: `x ${L.REDACTED_SECRET} y`, b: [`git clone ${L.REDACTED_URL}`, L.REDACTED_SLUG, `C:\\work\\${L.REDACTED_NAME}\\scripts`], [L.REDACTED_URL]: 1 });
  assert.deepStrictEqual(L.secretValues({ MY_TOKEN: 'abcdefgh12345', SYSTEM_ACCESSTOKEN: 'zyxwvuts98765', EXAMPLE_PAT_TEAM: 'patpatpat123', SERVICE_API_KEY: 'keykeykey123', SHORT_TOKEN: 'abc', PATH: '/usr/bin:/bin', PWD: '/work/some/folder', OLDPWD: '/work/other/folder' }).sort(),
    ['abcdefgh12345', 'keykeykey123', 'patpatpat123', 'zyxwvuts98765'], 'las credenciales por el nombre de su variable; PATH y PWD no son credenciales');
});

// ═══ T13 ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test('Facts_EveryUnknownIsAFactWithRunOrNotMeasuredWithReason', () => {
  const full = fixture('report-complete.json');
  const bare = fixture('report-no-session.json');
  for (const [name, report] of [['completo', full], ['sin sesión real', bare]]) {
    const points = facts.points(report);
    assert.deepStrictEqual(points.map((p) => p.n), Array.from({ length: 15 }, (_, i) => i + 1), `${name}: los quince puntos, en orden`);
    for (const p of points) {
      assert.ok(['fact', 'not-measured'].includes(p.state), `${name} #${p.n}: estado ${p.state}`);
      assert.ok(p.text && p.text.length > 10, `${name} #${p.n}: sin texto`);
      if (p.state === 'fact') assert.strictEqual(p.run, '4242', `${name} #${p.n}: un hecho lleva su número de corrida`);
      else assert.strictEqual(p.run, null, `${name} #${p.n}: un «no medido» no lleva corrida`);
    }
    const md = facts.render(report);
    assert.strictEqual((md.match(/^\| \d+ \| /gm) || []).length, 15, `${name}: una fila por punto`);
    assert.strictEqual((md.match(/\*\*Hecho \(corrida 4242\)\*\*/g) || []).length, points.filter((p) => p.state === 'fact').length);
    assert.strictEqual((md.match(/\*\*No medido\*\* — \S/g) || []).length, points.filter((p) => p.state === 'not-measured').length, `${name}: cada «no medido», con su motivo`);
    assert.deepStrictEqual(facts.assumptions(report).map((s) => s.id), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
  }
  // con la sesión, los tres primeros son hechos; sin ella, «no medido» por la sesión
  assert.deepStrictEqual(facts.points(full).slice(0, 3).map((p) => p.state), ['fact', 'fact', 'fact']);
  for (const p of facts.points(bare).slice(0, 3)) { assert.strictEqual(p.state, 'not-measured'); assert.match(p.text, /falta la sesión real/); }
  // los que W0 no contesta dicen quién los contesta
  const later = facts.points(full).filter((p) => [10, 11, 13, 14, 15].includes(p.n));
  assert.deepStrictEqual(later.map((p) => p.state), Array(5).fill('not-measured'));
  assert.match(later.map((p) => p.text).join(' | '), /W1.*W6.*W8.*nadie en esta story.*W8/);
  // un supuesto que la corrida contradice se marca
  const other = clone(full);
  other.steps[0].facts.autocrlf = { set: true, entries: ['system\tfile:x\tinput'], effective: 'input' };
  other.steps.find((s) => s.name === 'session-probe').facts.answers.hook_shell = ['pwsh'];
  const verdicts = Object.fromEntries(facts.assumptions(other).map((s) => [s.id, s.verdict]));
  assert.deepStrictEqual([verdicts.S1, verdicts.S5, verdicts.S2], ['contradicted', 'contradicted', 'not-measured']);
  assert.match(facts.render(other), /S5 .*CONTRADICHO/);
  assert.strictEqual(Object.fromEntries(facts.assumptions(bare).map((s) => [s.id, s.verdict])).S1, 'not-measured');
  // un paso en error no se cuenta como hecho: dice el motivo
  const failed = clone(bare);
  Object.assign(failed.steps[3], { status: 'error', reason: 'no pude medir: el paso fire-registered venció su tope de 2400 s', facts: {} });
  const p4 = facts.points(failed)[3];
  assert.deepStrictEqual([p4.state, p4.run], ['not-measured', null]);
  assert.match(p4.text, /error en el paso fire-registered: no pude medir/);
  // el guion: escribe el markdown; un reporte vacío o ilegible no es un archivo de hechos
  const base = tmp('t13');
  try {
    const ok = node([path.join(DIR, 'facts.js'), path.join(FIXTURES, 'report-complete.json')]);
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.strictEqual(ok.stdout, facts.render(full));
    fs.writeFileSync(path.join(base, 'empty.json'), '{"steps":[]}');
    fs.writeFileSync(path.join(base, 'broken.json'), '{');
    for (const f of ['empty.json', 'broken.json', 'missing.json']) {
      const r = node([path.join(DIR, 'facts.js'), path.join(base, f)]);
      assert.strictEqual(r.status, 2, `${f}: salió ${r.status}`);
      assert.strictEqual(r.stdout, '', `${f}: no escribe hechos`);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// Pase adversarial de la corrida 8.17-W0-20261005T0153 (clases 8 y 14): «no pude preguntar» no es un hecho, y una
// instalación que no dejó ningún enlace contradice el supuesto del junction más que una a la que le falta uno.
test('Facts_CouldNotAskIsNotAFact_NoLinksAtAllContradictsS7', () => {
  const report = fixture('report-complete.json');
  const inv = report.steps.find((s) => s.name === 'inventory');
  for (const n of ['az', 'claude']) inv.facts.tools[n] = { state: 'error', reason: 'el buscador salió 1' };
  const q = facts.points(report).find((p) => /`claude` y `az`/.test(p.question));
  assert.notStrictEqual(q.state, 'fact', `con los dos en error no hay hecho: ${q.text}`);
  const install = clone(fixture('report-complete.json'));
  const variants = install.steps.find((s) => s.name === 'install').facts.variants;
  const [first, ...rest] = Object.keys(variants);
  for (const l of variants[first].links) Object.assign(l, { present: false, to_clone: false });
  for (const k of rest) delete variants[k];
  assert.strictEqual(facts.assumptions(install).find((a) => a.id === 'S7').verdict, 'contradicted', 'ningún enlace creado contradice S7');
});

// ═══ el recorrido entero, en modo de laboratorio, sobre un arnés de juguete ════════════════════════════════════

const TOY_URL = 'https://example.com/acme/toy-harness';
const TOY = {
  '.github/README.md': `# Arnés de juguete\n\n<!-- install:clone -->\n\`\`\`bash\ngit clone ${TOY_URL} toy-clone && node toy-clone/scripts/setup/harness.js install\n\`\`\`\n\n\`\`\`powershell\ngit clone ${TOY_URL} toy-clone; node toy-clone/scripts/setup/harness.js install\n\`\`\`\n<!-- /install:clone -->\n`,
  // un instalador con las piezas que lee count-hooks.js; no se ejecuta nunca
  'scripts/install-tycon-hooks.sh': `#!/usr/bin/env bash
_hook_de_integracion() {
  case "$1" in
    *"|@tcg:toy-integration.js|"*) _INTEG_DE=NOCTURNOS ;;
    *) return 1 ;;
  esac
}
HOOKS_CANONICAL=(
  "UserPromptSubmit||tycon-pipeline/scripts/on-prompt.js|de las skills"
  "PreToolUse|Bash|@tcg:toy-brake.js|el freno de juguete"
  "Stop||@tcg:toy-notice.js|se espera en Stop; el instalador de juguete lo deja en SessionStart"
  "PostToolUse|Edit|Write|@tcg:toy-missing.js|el instalador de juguete no lo registra"
  "SessionStart||@tcg:toy-integration.js|de una integración apagada: no se espera"
)
OPTIN_HOOKS=()
if [[ "\${TYCON_SAFETY_GUARD:-1}" != "0" ]]; then
  OPTIN_HOOKS+=(
    "PreToolUse|Bash|@tcg:safety-guard-pre.sh|el freno en bash de juguete (depende de jq)"
  )
fi
KNOWN_MATCHER_TOKENS = {"Edit", "Write", "Bash"}
SUPERSEDED_RELPATHS = {
    "tycon-pipeline/scripts/on-edit.js",
}
`,
  'scripts/install-tycon-hooks.ps1': '# el gemelo de juguete: no se ejecuta\n',
  'scripts/lib/tycon-config.js': 'if (process.argv[2] === "integrations") console.log(JSON.stringify({ ado: false, clockify: false, engram: false, codegraph: false, mailbox: false, codex: false, nightly: false, telegram: false })); else process.exit(2);\n',
  'scripts/hooks/toy-brake.js': 'let d = ""; process.stdin.on("data", (c) => { d += c; }).on("end", () => { let j = {}; try { j = JSON.parse(d); } catch (e) { process.exit(3); } if (/rm -rf \\//.test((j.tool_input || {}).command || "")) { console.error("toy-brake: frenado"); process.exit(2); } });\n',
  'scripts/hooks/toy-notice.js': 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n',
  'scripts/hooks/safety-guard-pre.sh': '#!/usr/bin/env bash\n# de juguete: como el de verdad de hoy, sin jq deja pasar todo\ncommand -v jq >/dev/null 2>&1 || exit 0\ncmd=$(jq -r \'.tool_input.command // ""\')\ncase "$cmd" in *"rm -rf /"*) echo "safety-guard de juguete: frenado" >&2; exit 2 ;; esac\nexit 0\n',
  'skills/tycon-pipeline/scripts/on-prompt.js': 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n',
  'agents/toy-reviewer.md': '# revisor de juguete\n',
  'scripts/controls-bench/cases/hooks/01-toy.json': JSON.stringify({ hooks: [
    { hook: 'toy-brake.js', script: '${TCG}/scripts/hooks/toy-brake.js', event: 'PreToolUse', matcher: 'Bash', cases: [
      { id: 'block-rm-root', type: 'must-block', stdin: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, expect: { exit: 2 } },
      { id: 'pass-echo', type: 'must-not-block', stdin: { tool_name: 'Bash', tool_input: { command: 'echo hola' } }, expect: { exit: 0 } }] },
    { hook: 'safety-guard-pre.sh', script: '${TCG}/scripts/hooks/safety-guard-pre.sh', event: 'PreToolUse', matcher: 'Bash', cases: [
      { id: 'block-rm-root', type: 'must-block', stdin: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, expect: { exit: 2 } },
      { id: 'pass-in-a-repo', type: 'must-not-block', setup: ['git init -q'], stdin: { tool_name: 'Bash', tool_input: { command: 'echo hola' } }, expect: { exit: 0 } }] },
  ] }, null, 2),
  'scripts/setup/harness/bootstrap.js': `const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawnSync } = require('child_process');
const dir = path.join(os.homedir(), '.claude', '.tycon-pipeline', 'harness');
let tree = null; for (const n of ${JSON.stringify([PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME])}) { try { tree = fs.realpathSync(path.join(os.homedir(), '.claude', n)); break; } catch (_) { /* el que sigue, como el real (8.19 A) */ } }
if (!tree) { fs.appendFileSync(path.join(dir, 'startup.log'), 'x bootstrap: el enlace no resuelve\\n'); process.exit(1); }
const r = spawnSync(process.execPath, [path.join(tree, 'scripts', 'setup', 'harness.js'), 'startup'], { stdio: 'inherit' }); process.exit(r.status === null ? 1 : r.status);
`,
  'scripts/setup/harness/bootstrap-fallback.sh': '#!/bin/sh\necho "x respaldo en shell: bootstrap.js no arrancó harness.js" >> "$HOME/.claude/.tycon-pipeline/harness/startup.log"\nexit 0\n',
  // el programa de instalación de juguete: deja lo que deja el de verdad, con tres defectos puestos a propósito
  'scripts/setup/harness.js': `#!/usr/bin/env node
const fs = require('fs'); const os = require('os'); const path = require('path');
const tree = path.resolve(__dirname, '..', '..'); const home = os.homedir(); const dot = path.join(home, '.claude');
const pipe = path.join(dot, '.tycon-pipeline'); const fixed = path.join(pipe, 'harness'); const q = (p) => p.replace(/\\\\/g, '/');
const LINKS = { ${JSON.stringify(PLACE.PLACE_NAME)}: tree, ${JSON.stringify(PLACE.LEGACY_PLACE_NAME)}: tree, 'agent-skills': tree, agents: path.join(tree, 'agents'), skills: path.join(tree, 'skills') };
const cmd = process.argv[2];
if (cmd === 'install') {
  fs.mkdirSync(fixed, { recursive: true });
  for (const [name, target] of Object.entries(LINKS)) { const p = path.join(dot, name); fs.rmSync(p, { recursive: true, force: true }); fs.symlinkSync(target, p, 'junction'); }
  for (const f of ['bootstrap.js', 'bootstrap-fallback.sh']) fs.copyFileSync(path.join(__dirname, 'harness', f), path.join(fixed, f));
  const hook = (rel) => ({ type: 'command', command: 'node "' + q(tree) + '/scripts/hooks/' + rel + '"' });
  fs.writeFileSync(path.join(dot, 'settings.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/.tycon-pipeline/harness/bootstrap.js" || bash "$HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh"', async: true }, hook('toy-notice.js')] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "' + q(home) + '/.claude/agent-skills/skills/tycon-pipeline/scripts/on-prompt.js"' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [hook('toy-brake.js'), { type: 'command', command: 'bash "' + q(tree) + '/scripts/hooks/safety-guard-pre.sh"' }] }],
    Stop: [{ hooks: [hook('toy-gone.js')] }],
  } }, null, 2));
  const pa = process.argv.indexOf('--profile');
  fs.writeFileSync(path.join(pipe, 'harness-state.json'), JSON.stringify({ mode: 'managed', channel: 'stable', sources: [{ name: 'harness' }], version: { number: '0.0.1' }, tree, profile: { value: pa > 0 ? process.argv[pa + 1] : 'minimal', origin: pa > 0 ? 'flag' : 'default' } }));
  fs.writeFileSync(path.join(dot, 'CLAUDE.md'), '@~/.claude/${PLACE.PLACE_NAME}/README.md\\n');
  fs.writeFileSync(path.join(pipe, 'install-env.json'), JSON.stringify({ exam: process.env.TYCON_NO_NIGHTLY_EXAM || null, home, cwd: process.cwd() }));
  console.log('arnés de juguete instalado · managed');
} else if (cmd === 'version') console.log('0.0.1 · stable · managed');
else if (cmd === 'doctor') console.log(JSON.stringify({ mode: 'managed', fail: [], warn: ['de juguete'], ok: ['Node'] }));
else if (cmd === 'startup') fs.appendFileSync(path.join(fixed, 'startup.log'), 'x startup: TYCON_UPDATE=' + (process.env.TYCON_UPDATE || '') + '\\n');
else if (cmd === 'uninstall') { for (const name of Object.keys(LINKS)) fs.rmSync(path.join(dot, name), { recursive: true, force: true }); fs.rmSync(path.join(pipe, 'harness-state.json'), { force: true }); console.log('desinstalado'); }
else process.exit(2);
`,
};

test('Probe_LabRun_ToyHarness_BundleCloneInstallCountFireReport', { skip: (process.platform === 'win32' && 'el recorrido de juguete es del modo de laboratorio: en Windows mide la corrida de verdad') || (!has('git') && 'NO MEDIDO — sin git') || (!has('bash') && 'NO MEDIDO — sin bash') }, () => {
  const base = tmp('lab');
  try {
    // el arnés de juguete, como un repo; y su bundle, armado por build-bundle.sh
    const toy = path.join(base, 'toy');
    for (const [rel, text] of Object.entries(TOY)) { const p = path.join(toy, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
    const git = (args, cwd) => spawnSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', ...args], { cwd, encoding: 'utf8' });
    git(['init', '-q'], toy); git(['add', '-A'], toy);
    assert.strictEqual(git(['commit', '-q', '-m', 'el arnés de juguete'], toy).status, 0);
    const made = spawnSync('bash', [path.join(DIR, 'build-bundle.sh'), '--output', path.join(base, 'bundle'), '--source', toy], { encoding: 'utf8' });
    assert.strictEqual(made.status, 0, `build-bundle.sh: ${made.stdout}${made.stderr}`);
    assert.deepStrictEqual(fs.readdirSync(path.join(base, 'bundle')).sort(), ['bundle-info.json', 'harness.bundle'], 'en la carpeta del bundle no queda nada más');
    assert.strictEqual(git(['status', '--porcelain'], toy).stdout, '', 'build-bundle.sh no toca el repo que empaqueta');
    assert.strictEqual(spawnSync('bash', [path.join(DIR, 'build-bundle.sh'), '--output', path.join(base, 'b2'), '--source', path.join(base, 'no-such-repo')], { encoding: 'utf8' }).status, 1, 'sin repo: sale 1');
    assert.strictEqual(spawnSync('bash', [path.join(DIR, 'build-bundle.sh')], { encoding: 'utf8' }).status, 2, 'sin --output: uso');

    // la corrida entera
    const lab = path.join(base, 'lab'); const out = path.join(base, 'out');
    const realBefore = listing(path.join(os.homedir(), '.claude', '.tycon-pipeline', 'harness'));
    // el arnés de juguete se juzga con una lista propia, sin línea de base: la versionada es la del arnés de verdad
    const toyGaps = path.join(base, 'toy-gaps.json');
    fs.writeFileSync(toyGaps, JSON.stringify({ baseline: null, gaps: [] }));
    const r = node([path.join(DIR, 'run.js'), 'all', '--lab', lab, '--out', out, '--bundle', path.join(base, 'bundle', 'harness.bundle'), '--run-id', '777', '--harness-ref', 'refs/heads/toy', '--allow-temp', '--gaps', toyGaps],
      { env: Object.assign({}, process.env, { TYCON_NO_NIGHTLY_EXAM: '0' }), timeout: 600000 });
    const report = JSON.parse(fs.readFileSync(path.join(out, 'windows-report.json'), 'utf8'));
    const step = (name) => report.steps.find((s) => s.name === name);
    const why = `${r.stdout}\n${r.stderr}`.split('\n').slice(-25).join('\n');
    assert.deepStrictEqual(report.steps.map((s) => s.name), run.STEPS.map((s) => s.name), why);
    // el arnés de juguete no trae el pipeline de stories: el esqueleto sale «no medido» con su motivo, nunca verde vacío
    assert.deepStrictEqual(report.steps.map((s) => s.status), ['measured', 'measured', 'measured', 'measured', 'not-measured', 'not-measured'], `${JSON.stringify(report.steps.map((s) => s.reason))}\n${why}`);
    assert.match(step('pipeline-skeleton').reason, /no trae el pipeline de stories/);
    assert.deepStrictEqual([report.run.id, report.run.harness_ref, report.run.lab_mode, report.run.bundle.mode], ['777', 'refs/heads/toy', true, 'source']);
    // primera medición: hay hallazgos y la corrida es verde, porque pudo medir todo
    assert.deepStrictEqual([r.status, report.verdict.color, report.verdict.mode], [0, 'green', 'first-measurement'], why);
    assert.ok(report.verdict.new_findings.length >= 6, `hallazgos: ${report.verdict.new_findings.map((f) => f.id).join(', ')}`);
    for (const s of report.steps) assert.strictEqual(s.capped_by, 'run-capped.js', `${s.name} corrió bajo su tope`);

    // install: el bloque de la portada, tal cual, en las dos carpetas de usuario; nada en la carpeta real
    const ins = step('install').facts;
    assert.strictEqual(ins.cover.block, `git clone ${L.REDACTED_URL} toy-clone && node toy-clone/scripts/setup/harness.js install`, 'el bloque bash de la portada, sin tocar (la dirección, tapada en el reporte)');
    assert.deepStrictEqual(Object.keys(ins.variants), ['plain', 'accent', 'team']);
    for (const id of ['plain', 'accent', 'team']) {
      const v = ins.variants[id];
      assert.strictEqual(v.run.exit, 0, `${id}: ${v.run.stderr}`);
      assert.ok(L.isInside(v.home, lab) && L.isInside(v.clone, lab), `${id}: todo dentro del laboratorio`);
      assert.deepStrictEqual([v.seen_homes.node_is_lab, v.doctor.readable, v.doctor.fail.length, v.settings.hooks_total], [true, true, 0, 6]);
      assert.deepStrictEqual(v.links.map((l) => [l.name, l.present, l.to_clone]), [[PLACE.PLACE_NAME, true, true], [PLACE.LEGACY_PLACE_NAME, true, true], ['agent-skills', true, true], ['agents', true, true], ['skills', true, true]]);
      assert.deepStrictEqual([v.eol.total, v.eol.with_cr], [3, 0], 'los tres .sh del arnés de juguete, contados uno por uno');
      const envSeen = JSON.parse(fs.readFileSync(path.join(v.home, '.claude', '.tycon-pipeline', 'install-env.json'), 'utf8'));
      assert.deepStrictEqual([envSeen.exam, fs.realpathSync(envSeen.home)], ['1', fs.realpathSync(v.home)], `${id}: el instalador corrió con TYCON_NO_NIGHTLY_EXAM=1 y la carpeta de laboratorio`);
    }
    assert.match(ins.variants.accent.home, /usuario de práctica$/, 'la segunda carpeta de usuario lleva espacio y acento');
    assert.ok(L.isInside(ins.variants.accent.clone, ins.variants.accent.home), '…y su clon vive adentro');
    // el equipo usa el perfil completo (la portada instala el mínimo, desde la 8.16 D): la variante «team» instala con
    // el bloque de la portada tal cual y después pasa a --profile full --yes, y es la que se cuenta y se dispara
    const team = ins.variants.team;
    assert.ok(team && team.profile_switch, 'corre la variante del equipo');
    assert.deepStrictEqual([team.run.exit, team.profile_switch.exit, team.profile_switch.profile, team.profile_switch.installed, team.profile_switch.applied], [0, 0, 'full', 'full', true]);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(team.home, '.claude', '.tycon-pipeline', 'harness-state.json'), 'utf8')).profile.value, 'full', 'quedó instalada con el perfil completo');
    assert.deepStrictEqual([ins.measured_variant, ins.variants.accent.uninstall.exit, ins.variants.accent.uninstall.links_left], ['team', 0, []]);
    assert.strictEqual(spawnSync('git', ['-C', ins.variants.plain.clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), report.run.copy_commit, 'lo instalado es un clon de la copia del bundle');
    assert.deepStrictEqual(listing(path.join(os.homedir(), '.claude', '.tycon-pipeline', 'harness')), realBefore, 'la carpeta de usuario real quedó como estaba');
    assert.ok(!step('install').findings.some((f) => f.id === 'homes:wrote-to-real-home'));

    // count-hooks: contra la lista leída del instalador de la copia
    const cnt = step('count-hooks');
    assert.deepStrictEqual(cnt.findings.map((f) => f.id).sort(), ['hooks:dangling:Stop:@tcg:toy-gone.js', 'hooks:misplaced:Stop:@tcg:toy-notice.js', 'hooks:missing:PostToolUse:@tcg:toy-missing.js', 'hooks:unexpected:Stop:@tcg:toy-gone.js']);
    assert.deepStrictEqual([cnt.facts.result.expected_total, cnt.facts.result.in_place, cnt.facts.result.startup_line.count], [5, 3, 1]);
    assert.deepStrictEqual(cnt.facts.result.runners, { node: 4, bash: 1 });

    // fire-registered: cada hook, por cada forma; los frenos con su caso del banco; los frenos en bash con y sin jq; la línea de arranque
    const fr = step('fire-registered');
    const forms = fr.facts.forms.map((f) => f.id);
    assert.ok(forms.includes('bash-c') && forms.includes('bash-file') && forms.includes('default-shell'), forms.join(', '));
    assert.strictEqual(fr.facts.hooks_fired, 5);
    const rows = fr.facts.fires;
    const of = (hook, kase, form) => rows.find((x) => x.hook === hook && x.case === kase && x.form === form);
    for (const form of ['bash-c', 'bash-file', 'default-shell']) {
      assert.deepStrictEqual([of('@tcg:toy-brake.js', 'must-block', form).exit, of('@tcg:toy-brake.js', 'must-block', form).blocked], [2, true], `${form}: el freno frena`);
      assert.deepStrictEqual([of('@tcg:toy-brake.js', 'must-not-block', form).exit, of('@tcg:toy-brake.js', 'must-not-block', form).blocked], [0, false], `${form}: y deja pasar lo legítimo`);
      assert.strictEqual(of('tycon-pipeline/scripts/on-prompt.js', 'generic', form).exit, 0);
      assert.ok(of('@tcg:toy-gone.js', 'generic', form).exit !== 0, `${form}: el hook sin archivo no sale 0`);
      assert.ok(fr.findings.some((f) => f.id === `fire:fails:Stop:@tcg:toy-gone.js:${form}`));
    }
    assert.ok(fr.findings.some((f) => f.id === 'fire:no-portable-case:PreToolUse:@tcg:safety-guard-pre.sh'), 'un freno sin sus dos casos disparables es un hallazgo');
    if (forms.includes('pwsh-command')) {
      // lo que la medición ya sabe de PowerShell: el 2 con que frena un hook no sale de `pwsh` como 2 (con pwsh 7.5,
      // `-Command` lo convierte en 1 y `-File` en 0): lanzado así, el freno no frena
      for (const form of ['pwsh-command', 'pwsh-file']) assert.deepStrictEqual([of('@tcg:toy-brake.js', 'must-block', form).exit === 2, of('@tcg:toy-brake.js', 'must-block', form).blocked], [false, false], form);
      assert.ok(fr.findings.some((f) => f.id === 'fire:brake-passes:PreToolUse:@tcg:toy-brake.js:pwsh-command') && fr.findings.some((f) => f.id === 'fire:brake-passes:PreToolUse:@tcg:toy-brake.js:pwsh-file'));
    }
    const brakes = fr.facts.bash_brakes;
    assert.deepStrictEqual(brakes.map((b) => [b.hook, b.exists]), [['@tcg:safety-guard-pre.sh', true], ['@tcg:test-scope-guard-pre.sh', false]]);
    if (brakes[0].with_agent_path.jq_seen) {
      assert.strictEqual(brakes[0].with_agent_path.blocked, true, 'con jq, frena');
      if (!brakes[0].without_jq.not_measured) {
        assert.deepStrictEqual([brakes[0].without_jq.jq_seen, brakes[0].without_jq.blocked, brakes[0].without_jq.exit], ['', false, 0], 'sin jq, deja pasar');
        assert.ok(fr.findings.some((f) => f.id === 'brakes:safety-guard-pre.sh:passes-without-jq'));
      }
    } else assert.ok(fr.findings.some((f) => f.id === 'brakes:safety-guard-pre.sh:passes-with-agent-path'), 'sin jq en la máquina: no frena, y es un hallazgo');
    const startup = fr.facts.startup;
    assert.deepStrictEqual([startup.registered, startup.is_async, startup.link_restored, startup.settings_changed], [true, true, true, false]);
    for (const form of ['bash-c', 'bash-file', 'default-shell']) {
      const s = startup.by_form.find((x) => x.form === form);
      assert.deepStrictEqual([s.healthy.bootstrap_ran, s.broken.bootstrap_said_broken, s.broken.fallback_ran], [true, true, true], `${form}: arranca y, rota, cae al respaldo`);
      // los dos nombres del lugar (8.19 A): romper sólo el viejo dejaba arrancar por el nuevo y el respaldo no corría
      assert.deepStrictEqual(s.broken_links, [PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME], `${form}: rompe los dos nombres`);
    }
    for (const n of [PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME]) assert.ok(fs.existsSync(path.join(ins.variants[ins.measured_variant].home, '.claude', n, 'scripts')), `el enlace ${n} roto a propósito quedó repuesto`);

    // el reporte: lo que se publica no nombra la dirección del repo de la portada, y trae su resumen legible
    const published = listing(out).filter((f) => fs.statSync(path.join(out, f)).isFile());
    assert.ok(published.includes('windows-report.json') && published.includes('windows-report.md') && published.includes('settings-plain.json'), published.join(', '));
    for (const f of published) assert.ok(!fs.readFileSync(path.join(out, f), 'utf8').includes('toy-harness'), `${f} nombra el repo de la portada (su dirección o su nombre)`);
    const md = fs.readFileSync(path.join(out, 'windows-report.md'), 'utf8');
    for (const title of ['## Veredicto: VERDE', '## Los pasos', '## Qué trae la máquina', '## Cómo quedó la instalación', '## Los hooks registrados', '## Los hooks, disparados tal como quedaron registrados', '## Lo que no se sabía sin una máquina Windows', '## Los supuestos de la story']) assert.ok(md.includes(title), `el resumen trae «${title}»`);
    assert.match(md, /modo de laboratorio: esto NO es un Windows/);

    // con la lista escrita desde esta corrida, la misma corrida es verde; y un laboratorio no se usa dos veces
    const gaps = path.join(base, 'known-gaps.json');
    const proposed = node([path.join(DIR, 'run.js'), 'propose-gaps', path.join(out, 'windows-report.json')]);
    assert.strictEqual(proposed.status, 0, proposed.stderr);
    fs.writeFileSync(gaps, proposed.stdout);
    assert.strictEqual(node([path.join(DIR, 'run.js'), 'finish', '--out', out, '--gaps', gaps]).status, 0);
    const again = JSON.parse(fs.readFileSync(path.join(out, 'windows-report.json'), 'utf8')).verdict;
    assert.deepStrictEqual([again.mode, again.new_findings.length, again.stale_gaps.length, again.invalid_gaps.length, again.color], ['against-known-gaps', 0, 0, 0, 'green'], JSON.stringify(again));
    assert.strictEqual(node([path.join(DIR, 'run.js'), 'verdict', '--out', out]).status, 0);
    const twice = node([path.join(DIR, 'run.js'), 'init', '--lab', lab, '--out', out, '--bundle', path.join(base, 'bundle', 'harness.bundle'), '--allow-temp']);
    assert.strictEqual(twice.status, 2);
    assert.match(twice.stderr, /el laboratorio es de una sola corrida/);
    assert.strictEqual(node([path.join(DIR, 'run.js'), 'verdict', '--out', path.join(base, 'no-report')]).status, 2, 'sin reporte no hay veredicto verde');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ T74 (en el modo de laboratorio) ═══════════════════════════════════════════════════════════════════════════
// El paso `pipeline-skeleton` corre el esqueleto mecánico del pipeline de stories —el lint de la story, `pipeline.js
// start`, `mech-check`, `advisors` y `test-gate.sh`— sobre el repo de ejemplo de Node, con la instalación que dejó el
// paso `install`. Acá esa instalación es de mentira: un clon de este repo (su HEAD, como el bundle) y los dos enlaces
// que deja el instalador. En el agente Windows corre de verdad (T74); en Linux, la máquina limpia (T75 / T27).
test('Win_PipelineSkeleton_OnExampleNodeRepo', { skip: (process.platform === 'win32' && 'modo de laboratorio: en Windows mide la corrida de verdad') || (!has('git') && 'NO MEDIDO — sin git') || (!has('bash') && 'NO MEDIDO — sin bash') }, async (t) => {
  const skeleton = require(path.join(DIR, 'pipeline-skeleton.js'));

  await t.test('sobre una instalación con el pipeline: los cinco pasos salen como en Linux, y queda tests-result.json', () => {
    const base = tmp('skeleton');
    try {
      const lab = path.join(base, 'lab');
      const home = path.join(lab, 'users', 'lab-user');
      const copy = path.join(lab, 'work', 'clone');
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(lab, L.LAB_MARK), '{}\n');
      const cl = spawnSync('git', ['clone', '-q', '--local', ROOT, copy], { encoding: 'utf8' });
      assert.strictEqual(cl.status, 0, `no pude clonar el repo: ${cl.stderr}`);
      for (const name of ['tycon-claude-guides', 'agent-skills']) fs.symlinkSync(copy, path.join(home, '.claude', name));
      // como la copia pública: sin perfil, ningún paquete de revisores activo
      L.writeJsonAtomic(path.join(lab, 'lab-state.json'), { schema: L.SCHEMA, allow_temp: true, measured_variant: { id: 'plain', home, clone: copy, settings: null, env: { TYCON_PACKS_DEFAULT: 'none' } } });
      const activeDir = path.join(os.homedir(), '.claude', '.tycon-pipeline', 'active');
      const realBefore = listing(activeDir);
      const out = path.join(base, 'out');
      const r = node([path.join(DIR, 'pipeline-skeleton.js'), '--lab', lab, '--out', out], { timeout: 600000 });
      assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
      const step = JSON.parse(fs.readFileSync(L.stepFile(out, 'pipeline-skeleton'), 'utf8'));
      const why = JSON.stringify({ reason: step.reason, findings: step.findings }, null, 1);
      assert.deepStrictEqual([step.name, step.status], ['pipeline-skeleton', 'measured'], why);
      assert.deepStrictEqual(step.findings, [], why);
      assert.deepStrictEqual(Object.keys(step.facts.checks), skeleton.CHECKS, 'los cinco pasos, en orden');
      for (const name of skeleton.CHECKS) assert.deepStrictEqual([name, step.facts.checks[name].exit, step.facts.checks[name].ok], [name, 0, true], why);
      const tr = step.facts.tests_result;
      assert.deepStrictEqual([tr.runner, tr.suite_green, tr.totals.total > 0 && tr.totals.passed === tr.totals.total && tr.totals.failed === 0], ['node-test', true, true], 'queda tests-result.json con todo verde');
      assert.ok(L.isInside(step.facts.repo, lab) && fs.existsSync(path.join(step.facts.repo, '.advisors', 'tests-result.json')), 'el repo de ejemplo vive en el laboratorio y ahí queda tests-result.json');
      assert.deepStrictEqual(listing(activeDir), realBefore, 'la carpeta de usuario real quedó como estaba');
      assert.ok(fs.existsSync(path.join(home, '.claude', '.tycon-pipeline')), 'el estado del pipeline quedó en la carpeta de laboratorio');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  await t.test('cada paso que no sale como en Linux es un hallazgo con su nombre; sin instalación, «no medido»', () => {
    const ok = (extra) => Object.assign({ exit: 0, error: null, ok: true }, extra || {});
    const checks = { lint: ok(), start: ok(), 'mech-check': ok(), advisors: ok(), 'test-gate': ok({ exit: 1, ok: false, why: 'tests-result.json dice «|false|false»' }) };
    assert.deepStrictEqual(skeleton.findingsOf(checks).map((f) => [f.id, f.closes]), [['skeleton:test-gate', 'W6']]);
    assert.match(skeleton.findingsOf(checks)[0].detail, /test-gate.*salió 1/);
    assert.deepStrictEqual(skeleton.findingsOf({ lint: ok() }).map((f) => f.id), ['skeleton:start:not-run', 'skeleton:mech-check:not-run', 'skeleton:advisors:not-run', 'skeleton:test-gate:not-run'], 'un paso que no corrió también');
    const base = tmp('skeleton-none');
    try {
      const lab = path.join(base, 'lab');
      fs.mkdirSync(lab); fs.writeFileSync(path.join(lab, L.LAB_MARK), '{}\n');
      const out = path.join(base, 'out');
      assert.strictEqual(node([path.join(DIR, 'pipeline-skeleton.js'), '--lab', lab, '--out', out]).status, 0);
      const step = JSON.parse(fs.readFileSync(L.stepFile(out, 'pipeline-skeleton'), 'utf8'));
      assert.deepStrictEqual([step.status, step.findings.length], ['not-measured', 0]);
      assert.match(step.reason, /ninguna instalación/);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

test('Probe_LabRun_PowershellBlockOfTheCover_RunsUnderPwsh', { skip: (process.platform === 'win32' && 'modo de laboratorio') || (!has('git') && 'NO MEDIDO — sin git') || (!has('pwsh') && 'NO MEDIDO — sin pwsh en esta máquina') }, () => {
  // el camino que usa el agente Windows: la valla `powershell` de la portada, corrida por pwsh desde un archivo
  const base = tmp('pwsh');
  try {
    const toy = path.join(base, 'toy');
    for (const [rel, text] of Object.entries(TOY)) { const p = path.join(toy, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
    const git = (args, cwd) => spawnSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', ...args], { cwd, encoding: 'utf8' });
    git(['init', '-q'], toy); git(['add', '-A'], toy); git(['commit', '-q', '-m', 'el arnés de juguete'], toy); git(['checkout', '-q', '-B', 'main'], toy);
    const bundle = path.join(base, 'harness.bundle');
    assert.strictEqual(git(['bundle', 'create', '-q', bundle, 'HEAD', 'main'], toy).status, 0);
    const lab = path.join(base, 'lab'); const out = path.join(base, 'out');
    assert.strictEqual(node([path.join(DIR, 'run.js'), 'init', '--lab', lab, '--out', out, '--bundle', bundle, '--allow-temp']).status, 0);
    const r = node([path.join(DIR, 'run.js'), 'step', 'install', '--lab', lab, '--out', out, '--fence', 'powershell', '--allow-temp'], { timeout: 300000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const step = JSON.parse(fs.readFileSync(path.join(out, 'steps', 'install.json'), 'utf8'));
    assert.strictEqual(step.status, 'measured', step.reason);
    assert.strictEqual(step.facts.cover.block, `git clone ${L.REDACTED_URL} toy-clone; node toy-clone/scripts/setup/harness.js install`, 'la valla powershell, sin tocar');
    for (const id of ['plain', 'accent']) {
      const v = step.facts.variants[id];
      assert.deepStrictEqual([v.run.exit, v.seen_homes.pwsh_is_lab, v.settings.hooks_total], [0, true, 6], `${id}: ${v.not_run || v.run.stderr}`);
    }
    // un bloque que falla: el código que se anota es el del programa, no el que PowerShell le pone a su -Command
    const probe = require(path.join(DIR, 'install-probe.js'));
    const failed = probe.runBlock({ block: 'node -e "process.exit(7)"', fence: 'powershell', work: path.join(base, 'work con espacio y ñ'), scratch: path.join(base, 'scratch'), env: process.env, id: 'x', pwsh: L.scanPath('pwsh')[0] });
    assert.strictEqual(failed.exit, 7);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Probe_LabRun_TeamProfileSwitchFails_FindingW4_MeasuresAnotherVariant', { skip: (process.platform === 'win32' && 'modo de laboratorio') || (!has('git') && 'NO MEDIDO — sin git') || (!has('bash') && 'NO MEDIDO — sin bash') }, () => {
  // si el paso al perfil completo falla —o sale 0 sin aplicarse—, queda el hallazgo W4 y la medición sigue con otra
  // variante: nunca se cuenta un perfil mínimo como si fuera el del equipo sin decirlo
  const HARNESS = 'scripts/setup/harness.js';
  const CASES = [
    { name: 'sale 3', finding: 'install:team:profile-full-failed', detail: /salió 3/, exit: 3, installed: 'minimal',
      edit: (t) => t.replace("if (cmd === 'install') {", "if (cmd === 'install' && process.argv.includes('--profile')) { console.error('perfil roto'); process.exit(3); }\nif (cmd === 'install') {") },
    { name: 'sale 0 sin aplicarlo', finding: 'install:team:profile-full-not-applied', detail: /salió 0 pero el estado dice perfil minimal/, exit: 0, installed: 'minimal',
      edit: (t) => t.replace("pa > 0 ? process.argv[pa + 1] : 'minimal'", "'minimal'") },
  ];
  for (const c of CASES) {
    const base = tmp('team-fails');
    try {
      const broken = Object.assign({}, TOY, { [HARNESS]: c.edit(TOY[HARNESS]) });
      assert.notStrictEqual(broken[HARNESS], TOY[HARNESS], `${c.name}: el juguete roto quedó armado`);
      const toy = path.join(base, 'toy');
      for (const [rel, text] of Object.entries(broken)) { const p = path.join(toy, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
      const git = (args, cwd) => spawnSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', ...args], { cwd, encoding: 'utf8' });
      git(['init', '-q'], toy); git(['add', '-A'], toy); git(['commit', '-q', '-m', 'el arnés de juguete, con el perfil roto'], toy); git(['checkout', '-q', '-B', 'main'], toy);
      const bundle = path.join(base, 'harness.bundle');
      assert.strictEqual(git(['bundle', 'create', '-q', bundle, 'HEAD', 'main'], toy).status, 0);
      const lab = path.join(base, 'lab'); const out = path.join(base, 'out');
      assert.strictEqual(node([path.join(DIR, 'run.js'), 'init', '--lab', lab, '--out', out, '--bundle', bundle, '--allow-temp']).status, 0);
      const r = node([path.join(DIR, 'run.js'), 'step', 'install', '--lab', lab, '--out', out, '--fence', 'bash', '--allow-temp'], { timeout: 300000 });
      assert.strictEqual(r.status, 0, `${c.name}: ${r.stderr}`);
      const step = JSON.parse(fs.readFileSync(path.join(out, 'steps', 'install.json'), 'utf8'));
      assert.strictEqual(step.status, 'measured', `${c.name}: ${step.reason}`);
      const team = step.facts.variants.team;
      assert.deepStrictEqual([team.run.exit, team.profile_switch.exit, team.profile_switch.profile, team.profile_switch.installed, team.profile_switch.applied], [0, c.exit, 'full', c.installed, false], c.name);
      if (c.exit) assert.match(team.profile_switch.output, /perfil roto/, 'la salida del cambio de perfil queda en el reporte');
      const f = step.findings.find((x) => x.id === c.finding);
      assert.ok(f, `${c.name}: el hallazgo del perfil: ${step.findings.map((x) => x.id).join(', ')}`);
      assert.match(JSON.stringify(f), c.detail, c.name);
      assert.strictEqual(step.facts.measured_variant, 'plain', `${c.name}: la medición sigue con la primera variante que quedó usable`);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

test('Probe_Fire_PayloadsAndBenchCases', () => {
  // la entrada de cada evento es legítima y trae lo común del banco; los casos del banco se leen por hook y evento
  const p = fire.payload('PreToolUse', fire.genericInput('PreToolUse', 'Edit|Write', '/repo'), { cwd: '/repo', home: '/home/lab' });
  assert.deepStrictEqual([p.hook_event_name, p.tool_name, p.cwd, p.session_id], ['PreToolUse', 'Edit', '/repo', 'tycon-windows-probe']);
  assert.deepStrictEqual(fire.genericInput('SessionStart', '', '/repo'), { source: 'startup' });
  assert.deepStrictEqual(fire.genericInput('PostToolUse', 'Bash', '/repo').tool_response, { stdout: 'hola\n', stderr: '', interrupted: false });
  assert.strictEqual(fire.hookName('C:\\work\\toy-clone\\scripts\\hooks\\x.js', 'win32'), '@tcg:x.js');
  assert.strictEqual(fire.hookName('C:/lab/profile/.claude/agent-skills/skills/clocki/scripts/on-prompt.js', 'win32'), 'clocki/scripts/on-prompt.js');
  const cases = fire.benchCases(path.join(ROOT, 'scripts', 'controls-bench', 'cases', 'hooks'), process.platform);
  const guard = cases['@tcg:safety-guard-pre.sh::PreToolUse'];
  assert.ok(guard && guard.brakes && guard.block && guard.pass, 'el freno de mano tiene sus dos casos disparables en el banco');
  assert.match(guard.block.stdin.tool_input.command, /\S/, 'el comando del caso viaja como texto en la entrada');
  const gate = cases['tycon-pipeline/scripts/on-pre-commit.js::PreToolUse'];
  assert.ok(gate && gate.brakes && !gate.block, 'un freno cuyos casos preparan un repo por shell queda sin caso disparable (lo mide el banco en Windows)');
  assert.strictEqual(fire.benchCases(path.join(ROOT, 'no-such-folder'), process.platform), null);
});

// Pase adversarial de la corrida 8.17-W0-20261005T0153 (clases 2 y 4): un hook que frena la entrada legítima con el
// JSON de bloqueo y sale 0 no daba hallazgo; y el mismo archivo registrado dos veces en un evento daba un solo id.
test('Probe_Fire_JsonBlockIsAFinding_SameFileTwiceHasTwoIds', { skip: !has('bash') && 'NO MEDIDO — sin bash' }, () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-lab-'));
  try {
    const home = path.join(lab, 'home'); const clone = path.join(lab, 'clone');
    const hooks = path.join(clone, 'scripts', 'hooks');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(lab, L.LAB_MARK), '');
    const read = 'let d = ""; process.stdin.on("data", (c) => { d += c; }).on("end", () => { let j = {}; try { j = JSON.parse(d); } catch (e) {} ';
    fs.writeFileSync(path.join(hooks, 'blockjs.js'), `${read}console.log(JSON.stringify({ decision: "block", reason: "siempre" })); });\n`);
    fs.writeFileSync(path.join(hooks, 'denyjs.js'), `${read}console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } })); });\n`);
    fs.writeFileSync(path.join(hooks, 'twice.js'), `${read}process.exit(j.tool_name === "Bash" ? 1 : 0); });\n`);
    const cmd = (f) => ({ type: 'command', command: `node "${path.join(hooks, f).split(path.sep).join('/')}"` });
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ hooks: {
      Stop: [{ hooks: [cmd('blockjs.js')] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [cmd('denyjs.js')] }],
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [cmd('twice.js')] }, { matcher: 'Bash', hooks: [cmd('twice.js')] }],
    } }));
    fs.writeFileSync(path.join(lab, 'lab-state.json'), JSON.stringify({ allow_temp: true, measured_variant: { id: 'plain', home, settings, clone, env: {} } }));
    const rec = L.recorder('fire-registered', path.join(lab, 'out'));
    const r = fire.measure({ lab, rec });
    assert.notStrictEqual(r.status, L.STATUS.error, r.reason);
    const ids = rec.step.findings.map((f) => f.id);
    assert.ok(ids.some((id) => id.startsWith('fire:fails:Stop:@tcg:blockjs.js:')), `frenar con el JSON de bloqueo y salir 0 es un hallazgo: ${ids.join(', ')}`);
    assert.ok(ids.some((id) => id.startsWith('fire:fails:PreToolUse:@tcg:denyjs.js:')), 'también con permissionDecision deny');
    assert.ok(ids.some((id) => id.startsWith('fire:fails:PostToolUse:@tcg:twice.js [Bash]:')), 'el registro que falla, con su matcher en el id');
    assert.ok(!ids.some((id) => id.startsWith('fire:fails:PostToolUse:@tcg:twice.js [Edit|Write]:')), 'el que anda no aparece');
  } finally { fs.rmSync(lab, { recursive: true, force: true }); }
});

test('Probe_Cover_PrefersUnattendedBlock_FallsBackToCore', () => {
  const L = require(path.join(DIR, 'lab.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-'));
  try {
    fs.mkdirSync(path.join(dir, '.github'));
    const url = 'https://example.com/acme/toy';
    // desde la story 8.23 (tanda E) los bloques que clonan son install:clone / install:clone-unattended (install:core es la
    // portada sin git, que esta sonda no corre)
    const core = `<!-- install:clone -->\n\`\`\`bash\ngit clone ${url} toy && node toy/scripts/setup/harness.js install\n\`\`\`\n<!-- /install:clone -->\n`;
    const unattended = `<!-- install:clone-unattended -->\n\`\`\`bash\ngit clone ${url} toy && node toy/scripts/setup/harness.js install --yes\n\`\`\`\n<!-- /install:clone-unattended -->\n`;
    fs.writeFileSync(path.join(dir, '.github', 'README.md'), `# x\n\n${core}\n${unattended}`);
    const both = L.readUnattendedCover(dir, { fence: 'bash' });
    assert.strictEqual(both.marker, 'install:clone-unattended');
    assert.match(both.block, /install --yes/);
    fs.writeFileSync(path.join(dir, '.github', 'README.md'), `# x\n\n${core}`);
    const only = L.readUnattendedCover(dir, { fence: 'bash' });
    assert.strictEqual(only.marker, 'install:clone');
    assert.doesNotMatch(only.block, /--yes/);
    fs.writeFileSync(path.join(dir, '.github', 'README.md'), '# sin bloques\n');
    assert.ok(L.readUnattendedCover(dir, { fence: 'bash' }).problem, 'sin ninguno de los dos bloques tiene que decirlo');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// story 8.25 (A1a-azure) · TZ14 = Windows_MigrateAzure_NoCredentialSaid_AndHappyPathWithToyPat_Pipeline182: lo que mide la 182
// es la mudanza en Windows con la capa del equipo servida por un Azure DevOps de juguete —sin credencial lo dice y no escribe;
// con el PAT de juguete apila la capa—. Eso sólo lo mide el agente de la 182 (por número de corrida). Acá se fija que el
// guión de la sonda DECLARA ese escenario con sus hallazgos nombrados y sin ningún nombre real: si alguien lo recorta, esta
// prueba lo dice antes de encolar nada.
test('Probe_Migrate_DeclaresAzureScenario_TZ14', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'windows', 'migrate-probe.js'), 'utf8');
  assert.match(src, /toy-azure-server\.js/, 'la sonda levanta el Azure DevOps de juguete');
  assert.match(src, /https:\/\/dev\.azure\.com\/acme\/proyecto\/_git\/equipo-lab/, 'el repo del equipo es de juguete (acme), nunca uno real');
  assert.doesNotMatch(src, /dev\.azure\.com\/(?!acme\b)/, 'ninguna organización real de Azure en la sonda');
  for (const id of ['migrate:azure-no-credential-silent', 'migrate:azure-no-credential-wrote', 'migrate:azure-no-credential-no-how',
    'migrate:azure-no-credential-not-refused', 'migrate:azure-plan-without-layer', 'migrate:azure-plan-fuses-profile',
    'migrate:azure-dry-run-fails', 'migrate:azure-dry-run-wrote']) {
    assert.ok(src.includes(`'${id}'`), `la sonda nombra el hallazgo ${id}`);
  }
  assert.match(src, /rec\.fact\('azure_no_credential'/, 'la rama «sin credencial» queda como hecho (dijo / no dijo / no vale)');
  // la versión de juguete sale sin los dos archivos de la capa, como la copia pública (182 #12528: con la llave del buzón adentro,
  // la mudanza se negaba a apilar la capa — el arnés bien; la sonda armaba una versión que en producción no existe)
  for (const layerPath of ["'perfil-equipo.json'", "'scripts', 'metrics', 'corridas-buzon.json'"]) {
    assert.ok(src.includes(`fs.rmSync(path.join(author, ${layerPath}), { force: true })`), `la sonda saca ${layerPath} del árbol antes de publicar la versión de juguete`);
  }
  assert.ok(src.includes("'migrate:azure-pat-printed'"), 'la sonda busca el PAT de juguete en toda la salida: si aparece, es hallazgo');
});

// story 8.25 (A1b) · T14 = Windows_NoCloneAndMigrate_WithTeamRepo_Pipeline182, su mitad `no-clone`: la instalación sin clon en
// Windows CON la capa del equipo —el Azure de juguete (install, el refresco en el lugar, update, rollback, doctor, uninstall) y
// el GitHub de juguete con dos repos (install)—. Lo mide sólo el agente de la 182; acá se fija que la sonda lo DECLARA, con su
// propio entorno (sin el perfil del laboratorio, que taparía la capa; el arranque sin desprenderse; el gestor de credenciales
// del agente apagado), la versión de juguete sin los archivos de la capa, los hallazgos nombrados y ningún nombre real.
test('Probe_NoClone_DeclaresTeamScenario_T14', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'windows', 'no-clone-probe.js'), 'utf8');
  assert.match(src, /toy-azure-server\.js/, 'la sonda levanta el Azure DevOps de juguete');
  assert.match(src, /https:\/\/dev\.azure\.com\/acme\/proyecto\/_git\/equipo-lab/, 'el repo del equipo es de juguete (acme), nunca uno real');
  assert.doesNotMatch(src, /dev\.azure\.com\/(?!acme\b)/, 'ninguna organización real de Azure en la sonda');
  assert.doesNotMatch(src, /https:\/\/[^\s'"`/]+@/, 'ninguna URL con usuario@ escrita entera (el detector de la copia la lee como un correo)');
  for (const k of ["TYCON_PROFILE: ''", "TYCON_STARTUP_DETACH: '0'", "TYCON_AZURE_GIT_CREDENTIAL: '0'"]) assert.ok(src.includes(k), `la sección de la capa corre con ${k}`);
  assert.match(src, /config', 'set', 'azure\.token'/, 'el PAT de juguete se guarda por el comando real (config set azure.token, por stdin)');
  for (const layerPath of ["'perfil-equipo.json'", "'scripts', 'metrics', 'corridas-buzon.json'"]) {
    assert.ok(src.includes(`fs.rmSync(path.join(author, ${layerPath}), { force: true })`), `la sonda saca ${layerPath} del árbol antes de publicar la versión de juguete`);
  }
  for (const id of ['no-clone:team-install-fails', 'no-clone:team-not-stacked', 'no-clone:team-refresh-fails', 'no-clone:team-update-lost',
    'no-clone:team-rollback-state', 'no-clone:team-doctor-line', 'no-clone:team-uninstall-cache', 'no-clone:team-pat-printed',
    'no-clone:team-locked-half', 'no-clone:team-github-install-fails']) {
    assert.ok(src.includes(`'${id}'`), `la sonda nombra el hallazgo ${id}`);
  }
  assert.match(src, /rec\.fact\('team_refresh'/, 'el refresco en el lugar queda como hecho');
  // 182 #12551: el archivo tomado deja LEER (si no, el arranque ni corre el refresco) y el GitHub de juguete arma el comprimido sin
  // la conversión de finales de línea del agente (Git for Windows trae core.autocrlf=true; GitHub de verdad no convierte)
  assert.ok(src.includes("holdOpen(path.join(tree, 'perfil-equipo.json'), env0, 'Read')"), 'el perfil se toma dejando leerlo');
  assert.match(src, /GIT_CONFIG_KEY_0: 'core\.autocrlf', GIT_CONFIG_VALUE_0: 'false'/, 'el GitHub de juguete del equipo, sin autocrlf');
});

// story 8.25 (A2b) · T28 = Windows_NoClone_TeamLayerA2_ReviewersNestedSkillCodexTomls_…_Pipeline182: en una carpeta de usuario
// NUEVA con Claude Code y Codex enchufados, la capa de la A2 de juguete (un paquete con un revisor `base` y uno `condicional`, una
// skill de una carpeta y una anidada a tres, nombres inventados) servida por el Azure de juguete: install --team, los revisores en
// ~/.claude/agents y sus dos traducciones en $CODEX_HOME (ninguna en adapters/), la anidada por su ruta, un commit que saca un
// revisor y una skill (fuera de la ventana: sin enlaces colgando ni carpetas vacías), doctor sin fail, y uninstall sin ninguna
// traducción de la capa. Lo mide sólo el agente de la 182 (con harnessRef de la rama); acá se fija que la sonda lo DECLARA, que la
// capa de juguete pasa los validadores de la máquina, y que nada nombra un revisor o un cliente reales.
test('Probe_NoClone_DeclaresTeamA2Scenario_T28', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'windows', 'no-clone-probe.js'), 'utf8');
  assert.match(src, /function measureTeamA2\(/, 'la sonda tiene la sección de la capa de la A2');
  assert.match(src, /measureTeamA2\(\{/, '…y la corre');
  for (const k of ["TYCON_CLAUDE: '1'", "TYCON_CODEX: '1'", "TYCON_PROFILE: ''", "TYCON_STARTUP_DETACH: '0'", "TYCON_AZURE_GIT_CREDENTIAL: '0'"]) {
    assert.ok(new RegExp(`function measureTeamA2[\\s\\S]*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(src), `la sección de la A2 corre con ${k}`);
  }
  for (const id of ['no-clone:team-a2-install-fails', 'no-clone:team-a2-claude-missing', 'no-clone:team-a2-codex-missing', 'no-clone:team-a2-in-adapters',
    'no-clone:team-a2-refresh-left', 'no-clone:team-a2-dangling', 'no-clone:team-a2-empty-dirs', 'no-clone:team-a2-doctor-red', 'no-clone:team-a2-uninstall-left']) {
    assert.ok(src.includes(`'${id}'`), `la sonda nombra el hallazgo ${id}`);
  }
  assert.match(src, /no medido[^'`]*Claude Code cargue la skill|Claude Code cargue la skill[^'`]*no medido/, 'lo que no se mide ahí, dicho');
  // la capa de juguete: la escribe team-lab.js y pasa los validadores de la máquina (pertenencia, conjunto y contenido)
  const TL = require(path.join(ROOT, 'scripts', 'tests', 'windows', 'team-lab.js'));
  const TEAM = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-a2-'));
  try {
    const files = TL.writeTeamLayerA2(dir);
    const crypto = require('crypto');
    const entries = files.map((p) => { const b = fs.readFileSync(path.join(dir, p)); return { path: p, mode: '100644', type: 'blob', sha: crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'), size: b.length }; });
    const pt = TEAM.planTeam(entries, {});
    assert.deepEqual(pt.problems, [], 'la capa de juguete de la A2 pasa planTeam');
    assert.deepEqual(TEAM.contentProblems(dir, pt.files), [], 'y contentProblems');
    assert.ok(files.some((p) => /^skills\/[^/]+\/[^/]+\/[^/]+\/SKILL\.md$/.test(p)), 'trae una skill anidada a tres');
    assert.ok(files.some((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p)), 'y una de una carpeta');
    const pack = JSON.parse(fs.readFileSync(path.join(dir, files.find((p) => p.startsWith('packs/'))), 'utf8'));
    assert.deepEqual(pack.reviewers.map((r) => r.group).sort(), ['base', 'condicional']);
    const without = TL.writeTeamLayerA2(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-a2-b-')), { second: false });
    assert.equal(without.length, files.length - 2, 'el commit siguiente saca un revisor y una skill');
    // nombres inventados: todo lo de la capa lleva «lab» en su nombre, salvo las tres rutas fijas de la A1
    const fixed = ['team-layer.json', 'perfil-equipo.json', 'scripts/metrics/corridas-buzon.json'];
    for (const p of files) assert.ok(fixed.includes(p) || /(^|\/)[^/]*lab[^/]*(\/|$)/.test(p), `${p}: nombre inventado`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// story 8.25 (A2c) · T37 = Windows_NoClone_LayerSkillWithDataFiles_LegacyConfigMigratedToUserProfile_DoctorWarnsOwnFolder_Pipeline182:
// en una carpeta de usuario NUEVA, la capa de juguete trae la skill de la lista fija (su nombre de la lista; el contenido,
// inventado) con sus dos archivos de datos: install --team los apila y la skill se ve en ~/.claude/skills; una carpeta propia con
// un `.bizuit-config.yaml` de juguete y un `update`: la conexión llega a %USERPROFILE%\.bizuit-sdd\config.yaml y el original queda;
// doctor avisa la carpeta propia. Lo mide sólo el agente de la 182 (con harnessRef de la rama); acá se fija que la sonda lo
// DECLARA, que la capa de juguete pasa los validadores de la máquina con la lista fija real, y que los permisos se dicen «no medido».
test('Probe_NoClone_DeclaresSkillDataScenario_T37', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'windows', 'no-clone-probe.js'), 'utf8');
  assert.match(src, /function measureTeamSkillData\(/, 'la sonda tiene la sección de la skill con datos');
  assert.match(src, /measureTeamSkillData\(\{/, '…y la corre');
  for (const k of ["TYCON_CLAUDE: '1'", "TYCON_PROFILE: ''", "TYCON_STARTUP_DETACH: '0'", "TYCON_AZURE_GIT_CREDENTIAL: '0'", "BIZUIT_SDD_HOME: ''"]) {
    assert.ok(new RegExp(`function measureTeamSkillData[\\s\\S]*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(src), `la sección corre con ${k}`);
  }
  for (const id of ['no-clone:team-a2c-install-fails', 'no-clone:team-a2c-data-missing', 'no-clone:team-a2c-skill-invisible', 'no-clone:team-a2c-not-moved',
    'no-clone:team-a2c-original-gone', 'no-clone:team-a2c-doctor-red', 'no-clone:team-a2c-own-not-warned', 'no-clone:team-a2c-content-printed']) {
    assert.ok(src.includes(`'${id}'`), `la sonda nombra el hallazgo ${id}`);
  }
  assert.match(src, /permissions: 'no medido en Windows'/, 'los permisos, «no medido»');
  assert.match(src, /Se saca\s+\/\/ ese enlace SIN seguirlo/, 'el enlace de ~/.claude/skills se saca sin vaciar su destino');
  assert.doesNotMatch(src.slice(src.indexOf('function measureTeamSkillData(')), /fs\.rmSync\(own/, 'nada se borra dentro de ~/.claude/skills');
  // la capa de juguete: pasa los validadores de la máquina con la lista fija REAL de la versión
  const TL = require(path.join(ROOT, 'scripts', 'tests', 'windows', 'team-lab.js'));
  const TEAM = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-a2c-'));
  try {
    const files = TL.writeTeamLayerA2c(dir);
    const crypto = require('crypto');
    const entries = files.map((p) => { const b = fs.readFileSync(path.join(dir, p)); return { path: p, mode: '100644', type: 'blob', sha: crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'), size: b.length }; });
    const pt = TEAM.planTeam(entries, {});
    assert.deepEqual(pt.problems, [], 'la capa de juguete de la A2c pasa planTeam');
    assert.deepEqual(TEAM.contentProblems(dir, pt.files), [], 'y contentProblems');
    assert.ok(TEAM.extrasEntryFor(`${TL.LAYER_A2C.skill}/VERSION`), 'su skill es de la lista fija');
    for (const d of ['VERSION', 'templates/shared-styles.css']) assert.ok(files.includes(`${TL.LAYER_A2C.skill}/${d}`), `trae ${d}`);
    const E = TEAM.extrasEntryFor(`${TL.LAYER_A2C.skill}/VERSION`);
    assert.equal(`${E.dataHome.dir}/${E.dataHome.file}`, `${TL.LAYER_A2C.home}/${TL.LAYER_A2C.file}`, 'la casa que mira la sonda es la de la lista');
    assert.ok(E.legacyData.includes(TL.LAYER_A2C.legacy), 'y la conexión vieja, la de la lista');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// story 8.34 · T1 (en Windows) y T16 = Windows182_NoClone_TraceCounts: contra el GitHub REAL y sin permiso, el sondeo del tope
// anónimo de la API (las rutas públicas no lo mueven; un 304 sin permiso sí) y el registro de pedidos (`TYCON_HTTP_TRACE`) de la
// instalación (1 consulta: la verificación), de mirar (0) y de mirar con la API en un puerto cerrado (anda); en Windows,
// get-harness.ps1 con la API cerrada. Lo mide sólo el agente de la 182 (TF_BUILD): acá se fija que la sonda lo DECLARA, que no
// sale a la red fuera de ese agente, que las rutas son las reales (ninguna variable de juguete) y que no toca tareas programadas.
test('Probe_NoClone_DeclaresRealGithubScenario_8_34_T16', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'windows', 'no-clone-probe.js'), 'utf8');
  assert.match(src, /function measureRealGithub\(/, 'la sonda tiene la sección del GitHub real');
  assert.match(src, /measureRealGithub\(\{/, '…y la corre');
  const sec = src.slice(src.indexOf('function measureRealGithub('));
  assert.match(sec, /if \(!baseEnv\.TF_BUILD && baseEnv\.TYCON_PROBE_REAL_GITHUB !== '1'\) return/, 'fuera del agente de la 182 no sale a la red');
  assert.match(sec, /TYCON_HTTP_TRACE: trace/, 'cuenta con el registro de pedidos');
  assert.match(sec, /for \(const k of \['TYCON_RELEASE_API', 'TYCON_RELEASE_GIT', 'TYCON_RELEASE_RAW', 'TYCON_RELEASE_ARCHIVE'\]\) delete env\[k\]/, 'las rutas son las reales');
  assert.match(sec, /TYCON_RELEASE_API: 'http:\/\/127\.0\.0\.1:9', TYCON_RELEASE_GIT: 'https:\/\/github\.com'/, 'mira con la API en un puerto cerrado');
  for (const k of ["TYCON_NO_NIGHTLY_EXAM: '1'", "TYCON_NO_GUI_ENV: '1'"]) assert.ok(sec.includes(k), `sin tareas programadas (${k})`);
  for (const id of ['no-clone:real-public-route-charged', 'no-clone:real-info-refs-unreadable', 'no-clone:real-install-fails', 'no-clone:real-install-api',
    'no-clone:real-check-fails', 'no-clone:real-check-api', 'no-clone:real-check-needs-api', 'no-clone:real-get-harness-needs-api']) {
    assert.ok(sec.includes(`'${id}'`), `la sonda nombra el hallazgo ${id}`);
  }
  assert.match(sec, /rec\.fact\('real_github_spike'/, 'el sondeo queda como hecho (T1, con el número de corrida)');
  // sin permiso y sin red hacia el GitHub real, en esta máquina: no sale a la red
  const facts = {}; const notes = [];
  const P = require(path.join(ROOT, 'scripts', 'tests', 'windows', 'no-clone-probe.js'));
  const env = Object.assign({}, process.env); delete env.TF_BUILD; delete env.TYCON_PROBE_REAL_GITHUB;
  const r = P.measureRealGithub({ base: os.tmpdir(), program: ROOT, baseEnv: env, platform: process.platform, rec: { fact: (k, v) => { facts[k] = v; }, note: (n) => notes.push(n), finding: () => {} } });
  assert.match(String(r), /no medido fuera del agente de la 182/, 'sin TF_BUILD devuelve «no medido» sin medir nada');
  assert.deepEqual(facts, {}, 'y no anota hechos');
});

test('Probe_MailboxUpload_LeavesMeasuredSettingsAsTheyWere — medir la subida al buzón no deja hooks en la instalación medida', { skip: !has('pwsh') && 'NO MEDIDO — sin pwsh' }, () => {
  // la 182 #13698 (2026-10-17): la medición vuelve a correr el aplicador con el buzón prendido sobre la misma HOME, y el
  // aviso del correo (un hook «sólo con el buzón») quedaba registrado en una instalación que no lo tiene; el conteo de
  // hooks lo daba por inesperado. La medición mide la subida: lo que el aplicador escriba en settings.json se devuelve.
  const base = tmp('mailbox-settings');
  try {
    const home = path.join(base, 'home'); const clone = path.join(base, 'clone');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(clone, 'scripts'), { recursive: true });
    const settings = path.join(home, '.claude', 'settings.json');
    const before = `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node a.js' }] }] } }, null, 2)}\n`;
    fs.writeFileSync(settings, before);
    // el aplicador de juguete registra un hook más, como el de verdad con el buzón prendido
    fs.writeFileSync(path.join(clone, 'scripts', 'install-tycon-hooks.ps1'), "$p = Join-Path $env:HOME '.claude/settings.json'\nSet-Content -Path $p -Value '{\"hooks\":{\"SessionStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node owner-email-notice.js\"}]}]}}'\nexit 0\n");
    const probe = require(path.join(DIR, 'install-probe.js'));
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
    const facts = probe.measureMailboxUpload({ home, clone, env, pwsh: L.scanPath('pwsh')[0], scratch: path.join(base, 'scratch'), waitMs: 200 });
    assert.ok(Array.isArray(facts.problems), JSON.stringify(facts));
    assert.strictEqual(fs.readFileSync(settings, 'utf8'), before, 'settings.json quedó como antes de medir');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
