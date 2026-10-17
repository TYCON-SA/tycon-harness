'use strict';

/**
 * pr-suites-shards.test.js — la validación de los pedidos de merge (pipelines/azure-pipelines-maintainers-pr.yml) corre sus suites
 * en trabajos paralelos: lo que dice el YAML (2026-10-04).
 *
 * Hasta ese día era UN job en serie: lint, banco, ~217 suites (cada roja reintentada una vez) y el veredicto, con un tope
 * de 60 minutos. Con rojos y reintentos no entraba: las corridas 11761 y 11788 se cortaron sin veredicto, y un job
 * cortado no dice nada. Ahora: `Validar` (lint + la lista de suites que corren) → `Bench` y una matriz `Suites` a la vez
 * → `Verdict`, que junta lo de todos y da el veredicto. Lo que se mide acá, porque todos los errores posibles son mudos:
 *   · que la matriz tenga un número de trabajos y los pasos pidan «<i> de OTRO número»: suites que nadie corre;
 *   · que un trabajo que no terminó se lea como verde, o que el veredicto no se dé porque un trabajo se cortó;
 *   · que el reintento de una vez por roja se pierda al repartir: la intermitente y la firme se siguen distinguiendo;
 *   · que un cambio de sólo documentación cree trabajos que fallan;
 *   · (story 8.22, tramo C) que la cantidad de trabajos no salga del peso de lo que corre, o que la matriz y algún
 *     `--of` lean cosas distintas: todos salen de la matriz que publica «Qué suites corren».
 *
 * 🔴 SE CORREN LOS PASOS REALES DEL YAML, extraídos por su `displayName` (como nightly-suites-shards.test.js, del que
 * copia la forma): si alguien edita el paso, este caso lo ejercita editado. Corren sobre un arnés de juguete en una
 * carpeta temporal, con los artefactos de mentira donde Azure los deja. Sin red y sin Azure.
 *
 * Correr: node --test scripts/tests/pr-suites-shards.test.js
 */

const nodeTest = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findGitBash } = require('../lib/git-bash.js');

const ROOT = path.resolve(__dirname, '..', '..');
const YAML = path.join(ROOT, 'pipelines/azure-pipelines-maintainers-pr.yml');
const PLAN_STEP = 'Qué suites corren';
const RUN_STEP = 'Correr las suites de este trabajo';
const JOIN_STEP = 'Juntar lo que midió cada trabajo';
const VERDICT_STEP = 'Veredicto: ¿algún rojo NUEVO?';
// story 8.22, tramo C: el parámetro es el MÁXIMO de trabajos; cuántos corren lo calcula «Qué suites corren» y lo publica como
// la matriz misma (`suites.matrix`). De esa salida salen la matriz del job Suites y los cuatro `--of`.
const MAX_EXPR = '${{ parameters.suiteShards }}';
const MATRIX_OUTPUT = "dependencies.Validar.outputs['suites.matrix']";
const HAS_CODE = "eq(dependencies.Validar.outputs['change.hayCodigo'], 'si')";

// Los pasos que corren las suites viven en una plantilla que usan dos trabajos, el de suites y el del banco (story 8.22,
// tramo I). Los jobs se leen del pipeline; un paso se busca en los dos archivos, y «el código» es el de los dos.
const TEMPLATE = path.join(ROOT, 'pipelines/templates/run-suites.yml');
const TEMPLATE_USE = '      - template: /pipelines/templates/run-suites.yml\n';
// Story 8.26, tanda C (AC 11 y 43): la foto nocturna y lo privado de la validación los trae una plantilla, una vez.
const SNAPSHOT_TEMPLATE = path.join(ROOT, 'pipelines/templates/fetch-snapshot.yml');
const SNAPSHOT_STEP = 'La foto nocturna y lo privado de la validación';
const SNAPSHOT_PICK_STEP = 'La foto nocturna que trajo Validar';
const BENCH = 'bench';
// La validación y sus plantillas son del privado (story 8.41, tanda F2): la copia pública no las trae. Ahí cada caso se
// saltea con este motivo, en vez de abortar al cargar.
const NO_PIPELINE = !(fs.existsSync(YAML) && fs.existsSync(TEMPLATE))
  && 'NO MEDIDO — no están pipelines/azure-pipelines-maintainers-pr.yml y su plantilla run-suites.yml (la copia pública no trae los pipelines del equipo)';
function test(name, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return nodeTest(name, { ...opts, skip: NO_PIPELINE || opts.skip }, fn);
}
const text = NO_PIPELINE ? '' : fs.readFileSync(YAML, 'utf8');
const lines = text.split('\n');
const template = NO_PIPELINE ? '' : fs.readFileSync(TEMPLATE, 'utf8');
const snapshotTemplate = fs.existsSync(SNAPSHOT_TEMPLATE) ? fs.readFileSync(SNAPSHOT_TEMPLATE, 'utf8') : '';
const stepLines = [...lines, ...template.split('\n'), ...snapshotTemplate.split('\n')];
const code = stepLines.filter((l) => !l.trim().startsWith('#'));
const BASH = findGitBash();
const NO_BASH = !BASH.path && `NO MEDIDO — no encontré bash (${BASH.reason})`;
const slash = (p) => p.replace(/\\/g, '/');

/** El texto de cada job del YAML, por nombre, en orden. */
function jobs() {
  const found = {};
  let current = null;
  for (const line of lines) {
    const m = line.match(/^ {2}- job: (\w+)\s*$/);
    if (m) { current = m[1]; found[current] = []; }
    if (current) found[current].push(line);
  }
  return Object.fromEntries(Object.entries(found).map(([name, body]) => [name, body.join('\n')]));
}

/** El cuerpo de un `- script: |`, buscado por el displayName del paso y sin su sangría. */
function stepBody(displayName) {
  const at = stepLines.findIndex((l) => l.includes(`displayName: '${displayName}'`));
  assert.ok(at >= 0, `no encontré el paso «${displayName}» ni en el pipeline ni en la plantilla de las suites`);
  let start = at;
  while (start >= 0 && !/^\s*-\s+script:\s*\|/.test(stepLines[start])) start -= 1;
  assert.ok(start >= 0, `el paso «${displayName}» no es un script`);
  const body = stepLines.slice(start + 1, at);
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return `${body.map((l) => l.slice(indent)).join('\n')}\n`;
}

/** El llamado a `suites-shard.js <sub>`, entero: su renglón y los que lo continúan (`\\` al final). */
function shardCall(sub) {
  const found = [];
  code.forEach((l, i) => {
    if (!new RegExp(`suites-shard\\.js ${sub}\\b`).test(l)) return;
    let whole = l.trim();
    for (let j = i; /\\\s*$/.test(code[j]) && j + 1 < code.length; j += 1) whole += ` ${code[j + 1].trim()}`;
    found.push(whole);
  });
  assert.strictEqual(found.length, 1, `un solo llamado a suites-shard.js ${sub} (encontré ${found.length})`);
  return found[0];
}

/** El máximo de trabajos que declara el parámetro `suiteShards` (un número, story 8.22 tramo C). */
function maxShards() {
  const at = code.findIndex((l) => /^\s*-\s+name:\s*suiteShards\s*$/.test(l));
  assert.ok(at >= 0, 'el pipeline no declara el parámetro suiteShards');
  const own = [];
  for (let i = at + 1; i < code.length && /^\s+(?!-\s)\S/.test(code[i]); i += 1) own.push(code[i]);
  const def = own.map((l) => l.match(/^\s*default:\s*([1-9]\d*)\s*$/)).find(Boolean);
  assert.ok(def, 'suiteShards tiene que traer su máximo por defecto: default: 2');
  assert.ok(own.some((l) => /^\s*type:\s*number\s*$/.test(l)), 'suiteShards es un número (type: number): el máximo');
  return Number(def[1]);
}

/** Reemplaza lo que Azure reemplaza antes de correr el paso; lo que quede sin reemplazar es un error del caso. */
function expand(body, values) {
  let out = values.max === undefined ? body : body.split(MAX_EXPR).join(String(values.max));
  const macros = {
    'Build.SourcesDirectory': values.sources, 'Build.ArtifactStagingDirectory': values.staging,
    'Agent.TempDirectory': values.temp, 'Pipeline.Workspace': values.workspace, 'Build.BuildId': '4242',
    SUITES_SHARD: values.shard, SUITES_OF: values.of, todoElRepo: values.everything, baseDelCambio: values.base,
  };
  for (const [name, value] of Object.entries(macros)) {
    if (value !== undefined) out = out.split(`$(${name})`).join(slash(String(value)));
  }
  const left = out.match(/\$\((?:[A-Z][A-Za-z]*\.[A-Za-z.]+|[A-Z][A-Z_]+|todoElRepo|hayCodigo|baseDelCambio)\)|\$\{\{[^}]*\}\}/g);
  assert.deepStrictEqual(left, null, `el paso usa algo de Azure que este caso no reemplaza: ${left}`);
  return out;
}

// ── un arnés de juguete ──────────────────────────────────────────────────────────────────────────────────────────
const toys = [];
nodeTest.after(() => { for (const d of toys) fs.rmSync(d, { recursive: true, force: true }); });

// 🔴 LA FOTO NOCTURNA ES DE JUGUETE. «Qué suites corren» lee la red de `--deps` con
// `git show origin/main:scripts/controls-bench/ultimo-suites.json`, parado en el arnés de verdad: la foto que haya dejado
// el último nocturno de `main`. El 2026-10-08 ese nocturno cortó una suite por su tope y la foto quedó `complete: false`;
// con eso `--deps` no saltea nada, las pesadas corren igual y la prueba que espera verlas salteadas se puso roja en
// `main` sin que nadie tocara código (ni la prueba ni el pipeline estaban mal). Una prueba no puede depender de cómo
// salió el nocturno de anoche: cada clon de juguete trae un `git` que contesta ESA pregunta con la foto del caso y le
// pasa todo lo demás al git de verdad. `photo`: un objeto (se escribe tal cual) o null (origin/main no trae la foto).
// Story 8.26, tanda C (AC 43): desde la tanda C «Qué suites corren» no le pregunta más a git: lee la foto que trajo el
// paso de la plantilla fetch-snapshot.yml, en la carpeta temporal (`runPlan` la deja ahí). El git de juguete sigue: es el
// que contesta ese paso cuando el repo propio es de Azure (`git show origin/main:…`, la foto de suites y la del banco).
const FRESH_PHOTO = () => ({ kind: 'bash-tests', ts: new Date().toISOString(), failures: [], complete: true });
const PHOTO_ASK = 'origin/main:scripts/controls-bench/ultimo-suites.json';
const BENCH_PHOTO_ASK = 'origin/main:scripts/controls-bench/ultimo-banco.json';
// El registro de suites de main, que «Juntar lo que midió cada trabajo» pide para decidir qué no viaja (story 8.26, tanda C):
// el git de juguete contesta con el `suites.json` del clon de juguete (main = la rama), o falla si el caso lo pide.
const REGISTRY_ASK = 'origin/main:scripts/tests/suites.json';
// Un reporte del banco de juguete, sin rojos: la copia pública no trae las fotos del banco de verdad (son datos de los
// nocturnos) y esta prueba viaja con la validación.
const TOY_BENCH = () => ({ ts: new Date().toISOString(), tool: 'both', ran: 1, failed: 0, results: {} });
const REAL_GIT = BASH.path ? String(spawnSync(BASH.path, ['-c', 'command -v git'], { encoding: 'utf8' }).stdout || '').trim() : '';
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
function toyGit(dir, photo) {
  const bin = path.join(dir, 'bin');
  const file = path.join(dir, 'nightly-photo.json');
  fs.mkdirSync(bin, { recursive: true });
  if (photo === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, `${JSON.stringify(photo)}\n`);
  const bench = path.join(dir, 'nightly-bench.json');
  if (photo === null) fs.rmSync(bench, { force: true });
  else fs.writeFileSync(bench, `${JSON.stringify(TOY_BENCH())}\n`);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/usr/bin/env bash',
    '# git de juguete (pr-suites-shards.test.js): contesta sólo las fotos nocturnas de origin/main; el resto, el git de verdad.',
    `if [ "\${1:-}" = show ] && [ "\${2:-}" = "${PHOTO_ASK}" ]; then`,
    `  [ -f "${slash(file)}" ] || { echo "fatal: path 'scripts/controls-bench/ultimo-suites.json' does not exist in 'origin/main'" >&2; exit 128; }`,
    `  cat "${slash(file)}"; exit 0`,
    'fi',
    `if [ "\${1:-}" = show ] && [ "\${2:-}" = "${BENCH_PHOTO_ASK}" ]; then`,
    `  [ -f "${slash(bench)}" ] || { echo "fatal: path 'scripts/controls-bench/ultimo-banco.json' does not exist in 'origin/main'" >&2; exit 128; }`,
    `  cat "${slash(bench)}"; exit 0`,
    'fi',
    `if [ "\${1:-}" = show ] && [ "\${2:-}" = "${REGISTRY_ASK}" ]; then`,
    `  [ -f "${slash(path.join(dir, 'no-main-registry'))}" ] && { echo "fatal: invalid object name 'origin/main'" >&2; exit 128; }`,
    `  cat "${slash(path.join(dir, 'repo', 'scripts', 'tests', 'suites.json'))}"; exit 0`,
    'fi',
    `exec "${REAL_GIT}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
}

/**
 * `suites`: [[nombre, cuerpo o null si no está en el clon]]. Devuelve la carpeta con el clon, su HOME y su espacio.
 * `photo`: la foto nocturna que va a leer el plan (por defecto, una completa y de ahora; ver toyGit).
 */
function toy(suites, { exclusive = [], photo = FRESH_PHOTO() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-shards-'));
  toys.push(dir);
  toyGit(dir, photo);
  fs.mkdirSync(path.join(dir, 'repo', 'scripts', 'tests'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'home', '.claude', 'agent-skills', 'skills'), { recursive: true });
  const entries = [];
  for (const [name, body] of suites) {
    entries.push(Object.assign({ raiz: 'arnes', ruta: `tests/${name}`, requiere: [] }, exclusive.includes(name) ? { exclusive: true } : {}));
    // Cada suite de juguete se declara de «todo el repo» (scripts/ci/suite-deps.js la ve listar los archivos): así corre
    // con cualquier cambio, como corrían todas antes de `--deps` (story 8.22), y estas pruebas siguen midiendo el reparto.
    const whole = name.endsWith('.js') ? '// recorre el repo entero (git ls-files)\n' : '# recorre el repo entero (git ls-files)\n';
    if (body !== null) fs.writeFileSync(path.join(dir, 'repo', 'scripts', 'tests', name), whole + body.split('@DIR@').join(slash(dir)));
  }
  fs.writeFileSync(path.join(dir, 'repo', 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: entries, semanales: [] }));
  // El criterio de las dos suites más largas, el de verdad (scripts/ci/heavy-suites.json).
  fs.mkdirSync(path.join(dir, 'repo', 'scripts', 'ci'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'ci', 'heavy-suites.json'), path.join(dir, 'repo', 'scripts', 'ci', 'heavy-suites.json'));
  return dir;
}

const STEP_TIMEOUT_MS = 180000;
function bash(dir, script, name, env = {}) {
  const file = path.join(dir, `${name}.sh`);
  fs.writeFileSync(file, script);
  // Parado en el arnés de verdad (los guiones del paso son los reales), con el clon y la HOME de juguete. Las variables
  // del agente que el paso lee se fijan acá: esta suite puede correr dentro de una corrida de Azure.
  // Con tope: un paso que se cuelga (o un tope del propio paso que deja de cortar) no puede colgar esta suite en la
  // máquina de quien la corre. Ningún paso de juguete tarda más de unos segundos.
  const r = spawnSync(BASH.path, [file], {
    cwd: ROOT, encoding: 'utf8', timeout: STEP_TIMEOUT_MS, killSignal: 'SIGKILL',
    env: {
      ...process.env, HOME: path.join(dir, 'home'), TF_BUILD: '', SYSTEM_PULLREQUEST_TARGETBRANCH: '', AGENT_JOBSTATUS: 'Succeeded',
      // story 8.26, tanda C: el repo propio y el interruptor del freno los fija cada caso (esta suite corre también en
      // una corrida de Azure, que trae los suyos)
      BUILD_REPOSITORY_PROVIDER: '', HARNESS_SUITES_BLOCK: '', HARNESS_PRIVATE_REPO: '', SYSTEM_PULLREQUEST_ISFORK: '',
      // el git de juguete del clon va primero: contesta la foto nocturna y delega el resto (ver toyGit)
      [PATH_KEY]: `${path.join(dir, 'bin')}${path.delimiter}${process.env[PATH_KEY] || ''}`,
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const workspace = (dir) => path.join(dir, 'workspace');
const artifacts = (dir) => path.join(workspace(dir), 'artifacts');

/**
 * Corre «Qué suites corren» con la lista de cambios que se le pase (null: no se pudo acotar) y publica la lista. Devuelve
 * también la matriz que publicó (`matrix`, el texto tal cual) y cuántos trabajos dice (`of`). Por defecto fuerza el
 * máximo (`SUITES_JOB_BUDGET=1`: cada suite de juguete pasa el presupuesto), para que estas pruebas sigan midiendo el
 * reparto entre varios trabajos; `{ SUITES_JOB_BUDGET: '' }` deja el presupuesto de verdad.
 */
function runPlan(dir, max, changed = ['scripts/lab.js'], env = {}) {
  const temp = path.join(dir, 'temp-validar');
  const staging = path.join(dir, 'staging-validar');
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(staging, { recursive: true });
  if (changed) {
    fs.writeFileSync(path.join(temp, 'cambiados.txt'), changed.map((l) => `${l}\n`).join(''));
    // la lista de código, como la arma «Qué trae este cambio» (story 8.22: los .md no eligen suites)
    const code = changed.filter((l) => !l.endsWith('.md') || /^(agents|skills|packs)\//.test(l));
    fs.writeFileSync(path.join(temp, 'cambiados-codigo.txt'), code.map((l) => `${l}\n`).join(''));
  }
  // la foto que trajo «La foto nocturna y lo privado de la validación» (la del caso; sin foto, no está)
  const photo = path.join(dir, 'nightly-photo.json');
  fs.mkdirSync(path.join(temp, 'snapshot'), { recursive: true });
  if (fs.existsSync(photo)) fs.copyFileSync(photo, path.join(temp, 'snapshot', 'nightly-suites.json'));
  else fs.rmSync(path.join(temp, 'snapshot', 'nightly-suites.json'), { force: true });
  const body = expand(stepBody(PLAN_STEP), { max, sources: path.join(dir, 'repo'), staging, temp, everything: changed ? 'no' : 'si' });
  const r = bash(dir, body, 'plan', { SUITES_JOB_BUDGET: '1', ...env });
  const published = r.out.match(/^##vso\[task\.setvariable variable=matrix;isOutput=true\](.*)$/m);
  const matrix = published ? published[1] : null;
  let of = null;
  try { of = matrix ? Object.keys(JSON.parse(matrix)).length : null; } catch { of = null; }
  // Lo que hacen el paso de publicar y las dos bajadas: la carpeta con el nombre del artefacto, donde la busca cada job.
  const plan = path.join(staging, 'suites-plan');
  if (fs.existsSync(plan)) {
    fs.cpSync(plan, path.join(artifacts(dir), 'suites-plan-a1'), { recursive: true });
    fs.cpSync(plan, path.join(workspace(dir), 'suites-plan', 'suites-plan-a1'), { recursive: true });
  }
  return { ...r, plan, matrix, of };
}

/** Corre el trabajo `shard` de `of` (el SUITES_OF de su pata de la matriz) y «publica» lo que dejó, como hace Azure. */
function runShard(dir, shard, of, { publish = true, env = {} } = {}) {
  const staging = path.join(dir, `staging-${shard}`);
  const temp = path.join(dir, `temp-${shard}`);
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  const body = expand(stepBody(RUN_STEP), { of, shard, sources: path.join(dir, 'repo'), staging, temp, workspace: workspace(dir) });
  const r = bash(dir, body, `run-${shard}`, env);
  const artifact = path.join(artifacts(dir), `suites-shard-${shard}-a1`);
  if (publish && fs.existsSync(path.join(staging, 'suites-shard'))) fs.cpSync(path.join(staging, 'suites-shard'), artifact, { recursive: true });
  return { ...r, artifact };
}

/**
 * Lo que publica el job Bench: un reporte sin rojos, igual a la foto del banco que el veredicto usa de comparación
 * (`placeSnapshot`), así el banco no trae ningún rojo nuevo y lo que se mira son las suites.
 */
function publishBench(dir) {
  const d = path.join(artifacts(dir), 'bench-a1');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'banco.json'), JSON.stringify(TOY_BENCH()));
}

/**
 * La foto que el job Verdict bajó (story 8.26, tanda C, AC 43): la que trajo Validar, en `<temp>/snapshot/`. `suites`: la
 * foto de suites (por defecto una sin rojas); `null` en las dos = no llegó.
 */
function placeSnapshot(temp, { suites = FRESH_PHOTO(), bench = TOY_BENCH() } = {}) {
  const d = path.join(temp, 'snapshot');
  fs.mkdirSync(d, { recursive: true });
  for (const [name, value] of [['nightly-suites.json', suites], ['nightly-bench.json', bench]]) {
    if (value === null) fs.rmSync(path.join(d, name), { force: true });
    else fs.writeFileSync(path.join(d, name), JSON.stringify(value));
  }
}

/**
 * Corre los dos pasos del job Verdict, en orden, como Azure: el veredicto corre aunque el primero haya fallado. `matrix`
 * es la salida de Validar, que el job lee como variable (SUITES_MATRIX).
 */
function runVerdict(dir, matrix, env = {}, snapshot = {}) {
  const temp = path.join(dir, 'temp-verdict');
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  placeSnapshot(temp, snapshot);
  const values = { sources: path.join(dir, 'repo'), temp, workspace: workspace(dir) };
  const join = bash(dir, expand(stepBody(JOIN_STEP), values), 'join', { SUITES_MATRIX: matrix === null ? '' : matrix, ...env });
  const verdict = bash(dir, expand(stepBody(VERDICT_STEP), values), 'verdict', env);
  const rep = path.join(temp, 'suites.json');
  return { join, verdict, report: fs.existsSync(rep) ? JSON.parse(fs.readFileSync(rep, 'utf8')) : null };
}

/** Los nombres de las suites del trabajo `shard`, preguntándole al guion con la lista que armó Validar. */
function namesOf(dir, shard, shards) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'suites-shard.js'), 'list', '--shard', String(shard), '--of', String(shards),
    '--only', path.join(dir, 'staging-validar', 'suites-plan', 'run.txt'), '--exclusive-apart', '--skills', '/S', '--scripts', path.join(dir, 'repo', 'scripts')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean).map((l) => path.posix.basename(slash(l)));
}

const GREEN_SH = 'echo "  ok   — todo bien"\nexit 0\n';
const RED_SH = 'echo "MAL  — el chequeo dos no dio"\necho "FALLARON 1 chequeo(s)"\nexit 1\n';
// Roja la primera vez, verde la segunda: anota sus pasadas en un archivo del arnés de juguete.
const FLAKY_SH = 'C="@DIR@/flaky.count"; n=$(cat "$C" 2>/dev/null || echo 0); echo $((n+1)) > "$C"; [ "$n" -ge 1 ] || { echo "MAL — la primera vez"; exit 1; }\nexit 0\n';
const SIX = [
  ['lab-green-a.test.sh', GREEN_SH], ['lab-green-b.test.js', 'process.exit(0);\n'], ['lab-red.test.sh', RED_SH],
  ['lab-absent.test.sh', null], ['lab-flaky.test.sh', FLAKY_SH], ['lab-green-c.test.sh', GREEN_SH],
];

// ── la forma del YAML ────────────────────────────────────────────────────────────────────────────────────────────
test('PrShards_MatrixAndEveryOfFromSameOutput', () => {
  // story 8.22, tramo C (AC 14): cuántos trabajos sale del peso del plan, y la matriz y los cuatro `--of` leen la MISMA
  // salida de Validar. Si dos de ellos leyeran cosas distintas, habría suites que ningún trabajo corre.
  assert.strictEqual(maxShards(), 2, 'el máximo es 2: a una corrida le tocan dos carriles');
  assert.doesNotMatch(code.join('\n'), /length\(parameters\.suiteShards\)|each shard in parameters\.suiteShards/,
    'ningún paso arma la matriz ni pide --of con el parámetro: el parámetro es sólo el máximo');

  const { Validar: validate, Suites: suites, Verdict: verdict } = jobs();
  assert.match(validate, new RegExp(`\\n {8}displayName: '${PLAN_STEP}'\\n {8}condition: [^\\n]+\\n {8}name: suites\\n`), 'el paso del plan tiene nombre: los otros jobs leen su salida por él');
  const plan = stepBody(PLAN_STEP);
  assert.ok(plan.includes('echo "##vso[task.setvariable variable=matrix;isOutput=true]$MATRIX"'), 'el plan publica la matriz como salida del job');
  assert.match(plan, /node scripts\/ci\/suites-shard\.js jobs --max "\$\{\{ parameters\.suiteShards \}\}" --only "\$OUT\/run\.txt" --weight-set pr /,
    'calcula cuántos con el peso de lo que corre, los pesos de la 170 y el máximo del parámetro');
  assert.match(plan, /MATRIX="\$\(node scripts\/ci\/suites-shard\.js matrix --of "\$JOBS_NEEDED"\)"/, 'arma la matriz con ese número');
  assert.match(plan, /OF="\$\(node scripts\/ci\/suites-shard\.js of --matrix "\$MATRIX"\)"/, 'y su --of sale de la matriz, no del número');

  assert.match(suites, new RegExp(`\\n {4}strategy:\\n {6}matrix: \\$\\[ ${MATRIX_OUTPUT.replace(/[.[\]'$]/g, (c) => `\\${c}`)} \\]\\n`),
    'la matriz del job Suites es la salida de Validar');
  assert.match(verdict, new RegExp(`\\n {4}variables:\\n {6}SUITES_MATRIX: \\$\\[ ${MATRIX_OUTPUT.replace(/[.[\]'$]/g, (c) => `\\${c}`)} \\]\\n`),
    'el veredicto lee la misma salida');
  assert.match(stepBody(JOIN_STEP), /OF="\$\(node scripts\/ci\/suites-shard\.js of --matrix "\$\{SUITES_MATRIX:-\}"\)"/, 'y saca su --of de ella');

  // Cada --of de los tres pasos que le piden algo al repartidor, y con la lista de las que corren.
  const ofs = code.filter((l) => /suites-shard\.js (list|plan|merge)\b/.test(l));
  assert.strictEqual(ofs.length, 3, `el plan, cada trabajo y el veredicto le piden su parte al guion: ${ofs.map((l) => l.trim()).join(' | ')}`);
  const [inPlan, inShard, inVerdict] = ['plan', 'list', 'merge'].map((sub) => ofs.find((l) => new RegExp(`suites-shard\\.js ${sub}\\b`).test(l)));
  assert.ok(inPlan && inShard && inVerdict, 'uno de cada uno');
  assert.ok(inPlan.includes('plan --of "$OF"') && inVerdict.includes('merge --of "$OF"'), 'Validar y el veredicto: el --of de la matriz');
  assert.ok(inShard.includes('list --shard "$(SUITES_SHARD)" --of "$(SUITES_OF)"'), 'cada trabajo: el número y la cuenta de su pata de la matriz');
  for (const l of ofs) assert.ok(l.includes('--only "'), `un paso reparte sin la lista de las que corren (--only): ${l.trim()}`);
  const picking = code.filter((l) => /--shard\b/.test(l));
  assert.strictEqual(picking.length, 1, 'un solo paso elige trabajo');
});

test('PrShards_PlanStep_AsksForAsManyJobsAsThePlanWeighs', { skip: NO_BASH }, () => {
  // Con el presupuesto de verdad (725 s por trabajo), seis suites de juguete de 3 s entran en uno: 1 trabajo + el banco.
  const dir = toy(SIX);
  const r = runPlan(dir, maxShards(), ['scripts/lab.js'], { SUITES_JOB_BUDGET: '' });
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(JSON.parse(r.matrix), { shard_1: { SUITES_SHARD: '1', SUITES_OF: '1' } }, 'un plan chico pide un solo trabajo');
  assert.match(r.out, /suites: 1 trabajo\(s\) de un máximo de 2/);
  assert.match(r.out, /repartidas en 1 trabajo\(s\)/);
  // A mano, con un presupuesto chico, el máximo.
  assert.strictEqual(runPlan(toy(SIX), maxShards()).of, 2);
});

test('SuitesShard_JobCountUnknown_UsesMax', { skip: NO_BASH }, () => {
  // AC 15: si no se pudo calcular cuántos, corren todos los del máximo, y se dice. Nunca menos por no saber.
  const r = runPlan(toy(SIX), maxShards(), ['scripts/lab.js'], { SUITES_JOB_BUDGET: 'ilegible' });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.of, 2, `con el cálculo roto, el máximo\n${r.out}`);
  // (story 8.26, tanda C, AC 45: el aviso con texto fijo y cuentas; el motivo, en la línea de abajo)
  assert.match(r.out, /##vso\[task\.logissue type=warning\]suites: no pude calcular cuántos trabajos hacen falta — uso el máximo, 2[^\n]*\n {3}el cálculo: .*--budget/);
  // Con menos suites que el máximo, el máximo posible es una por trabajo: pedir 2 para 1 dejaba la corrida sin medir
  // (el reparto se niega a armar un trabajo vacío). Revisión del tramo C.
  const one = runPlan(toy([['lab-green-a.test.sh', GREEN_SH]]), maxShards(), ['scripts/lab.js'], { SUITES_JOB_BUDGET: 'ilegible' });
  assert.strictEqual(one.code, 0, one.out);
  assert.strictEqual(one.of, 1, `una sola suite, un solo trabajo, aunque el cálculo falle\n${one.out}`);
  assert.match(one.out, /uso el máximo, 1 \(hay 1 suite\(s\)\)/);
});

test('T48 PrShards_JobCountUnknownWithExclusiveSuites_CountsOnlyTheOnesTheSuitesJobsShare — con el cálculo roto, el máximo cuenta sólo las suites que se reparten', { skip: NO_BASH }, () => {
  // Pase adversarial del tramo I (2026-10-08, tres lentes, el mismo hallazgo): con el cálculo de cuántos trabajos roto,
  // el respaldo contaba TODAS las suites del plan, también las que corren solas, que ya no se reparten (van al trabajo
  // del banco). Con 1 común y 1 exclusiva pedía 2 trabajos, el reparto se negaba a armar uno vacío y la validación
  // entera quedaba roja sin medir nada: ni las suites ni el banco arrancan si Validar falla.
  const broken = { SUITES_JOB_BUDGET: 'ilegible' };
  const plan = (common, alone, { noSplit = false } = {}) => {
    const names = [...common, ...alone];
    const dir = toy(names.map((n) => [n, GREEN_SH]), { exclusive: alone });
    // `noSplit`: un `node` de juguete, delante del de verdad, al que le falla SÓLO el guion que separa las que corren
    // solas (como el `git` de juguete de la foto nocturna). Todo lo demás lo corre el node de verdad.
    if (noSplit) {
      const real = String(spawnSync(BASH.path, ['-c', 'command -v node'], { encoding: 'utf8' }).stdout || '').trim();
      assert.ok(real, 'hay un node en el PATH de bash');
      fs.writeFileSync(path.join(dir, 'bin', 'node'), ['#!/usr/bin/env bash',
        'case "${1:-}" in *suites-exclusive.js) echo "suites-exclusive: de juguete, no pude separar" >&2; exit 1 ;; esac',
        `exec "${real}" "$@"`, ''].join('\n'), { mode: 0o755 });
    }
    return runPlan(dir, maxShards(), ['scripts/lab.js'], broken);
  };
  const one = plan(['lab-a.test.sh'], ['lab-solo-a.test.sh', 'lab-solo-b.test.sh']);
  assert.strictEqual(one.code, 0, `1 común y 2 que corren solas: un trabajo de suites, no un rojo\n${one.out}`);
  assert.strictEqual(one.of, 1, one.out);
  assert.match(one.out, /uso el máximo, 1 \(hay 1 suite\(s\)\) · 2 corren solas, en el trabajo del banco/);
  assert.match(one.out, /trabajo del banco: 2 suite\(s\) que corren solas/, 'y el reparto se arma');

  const three = plan(['lab-a.test.sh', 'lab-b.test.sh', 'lab-c.test.sh'], ['lab-solo-a.test.sh']);
  assert.strictEqual(three.code, 0, three.out);
  assert.strictEqual(three.of, 2, `3 comunes: el máximo del parámetro\n${three.out}`);

  // todas corren solas: igual se pide UN trabajo de suites, que termina sin correr ninguna (AC 37)
  const none = plan([], ['lab-solo-a.test.sh', 'lab-solo-b.test.sh']);
  assert.strictEqual(none.code, 0, none.out);
  assert.strictEqual(none.of, 1, none.out);
  assert.match(none.out, /uso el máximo, 1 \(hay 0 suite\(s\)\) · 2 corren solas, en el trabajo del banco/);

  // sin poder separarlas tampoco: la cuenta de todas, como antes de este tramo, y sin decir cuántas corren solas (no
  // lo sabe). Con 3 comunes y 1 sola alcanza para el máximo; con 1 y 1, el reparto se niega y es «no se midieron»:
  // rojo, nunca un verde armado a ciegas.
  const blind = plan(['lab-a.test.sh', 'lab-b.test.sh', 'lab-c.test.sh'], ['lab-solo-a.test.sh'], { noSplit: true });
  assert.strictEqual(blind.code, 0, blind.out);
  assert.strictEqual(blind.of, 2, blind.out);
  assert.match(blind.out, /uso el máximo, 2 \(hay 4 suite\(s\)\) · no pude separar las que corren solas: cuento todas\n {3}el cálculo: .* · separar las que corren solas: suites-exclusive: de juguete, no pude separar$/m,
    'cuenta las cuatro y dice por qué no las separó: el motivo del separador no se pierde detrás del otro');
  const blindOne = plan(['lab-a.test.sh'], ['lab-solo-a.test.sh'], { noSplit: true });
  assert.notStrictEqual(blindOne.code, 0, blindOne.out);
  assert.match(blindOne.out, /##vso\[task\.logissue type=error\]suites: no pude repartir la lista en 2 trabajo\(s\) — NO se midieron/);
  assert.strictEqual(blindOne.matrix, null, 'sin matriz publicada: los trabajos de suites no arrancan');
});

test('PrShards_Jobs_ValidateThenBenchAndSuitesThenAVerdictThatAlwaysRuns', () => {
  const all = jobs();
  assert.deepStrictEqual(Object.keys(all), ['Validar', 'Bench', 'Suites', 'Verdict'], 'los cuatro jobs, en orden');
  const { Validar: validate, Bench: bench, Suites: suites, Verdict: verdict } = all;

  // La decisión «¿trae código?» sale del paso del cambio hacia los otros jobs.
  assert.match(validate, /\n {8}displayName: 'Qué trae este cambio'\n {8}name: change\n/, 'el paso del cambio tiene nombre: los otros jobs lo leen por él');
  assert.ok(stepBody('Qué trae este cambio').includes('echo "##vso[task.setvariable variable=hayCodigo;isOutput=true]$HAY_CODIGO"'),
    'y publica hayCodigo como salida del job');
  for (const [name, body] of [['Bench', bench], ['Suites', suites]]) {
    assert.match(body, /\n {4}dependsOn: Validar\n/, `${name} espera a Validar`);
    assert.ok(body.includes(`\n    condition: and(succeeded(), ${HAS_CODE})\n`), `${name} corre sólo si el cambio trae código`);
  }
  assert.match(verdict, /\n {4}dependsOn: \[Validar, Bench, Suites\]\n/, 'el veredicto espera a todos');
  assert.ok(verdict.includes(`\n    condition: and(always(), ${HAS_CODE})\n`),
    'y corre aunque el banco o un trabajo de suites hayan fallado o los haya cortado el tope — salvo un cambio sin código');

  // Los topes: 40 por trabajo de suites (45 hasta el cierre de la story 8.22; de dónde sale el número, en T33), 10 el veredicto.
  assert.match(suites, /\n {4}timeoutInMinutes: 40\n/, 'cada trabajo de suites tiene 40 minutos de tope');
  assert.ok(suites.endsWith(`${TEMPLATE_USE}`) || suites.includes(`${TEMPLATE_USE}\n`), 'los pasos del trabajo de suites son los de la plantilla');
  assert.match(verdict, /\n {4}timeoutInMinutes: 10\n/, 'el veredicto, 10');

  // Lo que viaja de un job a otro: la lista (con el intento), lo de cada trabajo (siempre, con el intento) y el banco.
  assert.match(validate, /- publish: '\$\(Build\.ArtifactStagingDirectory\)\/suites-plan'\n {8}artifact: 'suites-plan-a\$\(System\.JobAttempt\)'\n/);
  assert.match(template, /- publish: '\$\(Build\.ArtifactStagingDirectory\)\/suites-shard'\n {4}artifact: 'suites-shard-\$\(SUITES_SHARD\)-a\$\(System\.JobAttempt\)'\n {4}displayName: '[^']+'\n {4}condition: always\(\)\n/,
    'cada trabajo publica lo que midió aunque haya rojas o lo corten, con el intento en el nombre');
  assert.match(bench, /- publish: '\$\(Build\.ArtifactStagingDirectory\)\/bench'\n {8}artifact: 'bench-a\$\(System\.JobAttempt\)'\n {8}displayName: '[^']+'\n {8}condition: always\(\)\n/);
  assert.match(template, /itemPattern: 'suites-plan-a\*\/\*\*'\n {6}targetPath: '\$\(Pipeline\.Workspace\)\/suites-plan'\n/, 'cada trabajo baja sólo la lista');
  assert.match(verdict, /continueOnError: true\n(?: {8}.*\n)*? {10}targetPath: '\$\(Pipeline\.Workspace\)\/artifacts'\n/, 'el veredicto baja todo');

  // El veredicto, en modo Azure, con el modo aviso decidido por el interruptor (story 8.26, tanda C, AC 14), y el reintento
  // de una vez por roja.
  assert.match(stepBody(VERDICT_STEP), /node scripts\/ci\/pr-verdict\.js [^\n]*--ado[^\n]*; RC=\$\?/);
  assert.ok(stepBody(VERDICT_STEP).includes('node scripts/ci/suites-block.js'), 'el modo aviso lo decide el interruptor');
  assert.doesNotMatch(stepBody(VERDICT_STEP), /pr-verdict\.js [^\n]*--suites-warn/, 'nunca fijo en el llamado');
  assert.match(verdict, new RegExp(`displayName: '${VERDICT_STEP.replace(/[?¿]/g, '.')}'\\n {8}condition: succeededOrFailed\\(\\)\\n`));
  assert.ok(stepBody(RUN_STEP).includes('se reintenta una vez'), 'cada roja se reintenta una vez');
  assert.ok(stepBody(JOIN_STEP).includes('--retries "$MERGED/retries.json"'), 'y las dos pasadas llegan al reporte');
  assert.doesNotMatch(code.join('\n'), /^[^#]*git (commit|push|add)\b/m, 'el pipeline de los pedidos de merge nunca escribe en el repo');
});

test('PrShards_DocsOnlyChange_SkipsEveryJobButValidateWithoutFailing', () => {
  // Sin código, hoy corre sólo el lint y el paso que lo dice: ningún job puede quedar en rojo por no tener qué medir.
  const all = jobs();
  for (const name of ['Bench', 'Suites', 'Verdict']) assert.ok(all[name].includes(HAS_CODE), `${name} se saltea sin código`);
  assert.match(all.Validar, /displayName: 'Sin código: el banco y las suites no corren'\n {8}condition: and\(succeeded\(\), ne\(variables\['hayCodigo'\], 'si'\)\)\n/);
  for (const step of [PLAN_STEP, 'Publicar la lista de suites del cambio']) {
    assert.match(all.Validar, new RegExp(`displayName: '${step}'\\n {8}condition: and\\(succeeded\\(\\), eq\\(variables\\['hayCodigo'\\], 'si'\\)\\)\\n`), `${step}: sólo con código`);
  }
  assert.ok(!/\n {4}condition:/.test(all.Validar), 'Validar corre siempre: es el lint');
});

test('PrShards_SkillsFolder_IsNamedOncePerJob', () => {
  // La ruta de las skills se escribe UNA vez por job (SK=…) y todo lo demás usa $SK: si algún día se muda, es un renglón.
  for (const [name, body] of Object.entries(jobs())) {
    const own = body.split('\n').filter((l) => !l.trim().startsWith('#'));
    const fixed = own.filter((l) => l.includes('.claude/agent-skills/skills'));
    assert.ok(fixed.length <= 1, `${name}: la carpeta de skills escrita ${fixed.length} veces`);
    for (const l of fixed) assert.match(l.trim(), /^SK="\$HOME\/\.claude\/agent-skills\/skills"$/, `${name}: ${l.trim()}`);
  }
});

// ── los pasos, corridos de verdad ────────────────────────────────────────────────────────────────────────────────
test('PrShards_AllShardsFinish_TheVerdictTellsFirmFromIntermittent', { skip: NO_BASH }, () => {
  const dir = toy(SIX);
  const plan = runPlan(dir, maxShards());
  assert.strictEqual(plan.code, 0, plan.out);
  const shards = plan.of;
  assert.match(plan.out, /trabajo 1 de 2:.*\n.*trabajo 2 de 2:/, 'el plan muestra el reparto');
  const seen = [];
  for (let i = 1; i <= shards; i += 1) {
    const r = runShard(dir, i, shards);
    assert.strictEqual(r.code, 0, `trabajo ${i}: una roja no rompe el trabajo\n${r.out}`);
    assert.ok(fs.existsSync(path.join(r.artifact, 'finished')), `trabajo ${i}: pasó por toda su lista\n${r.out}`);
    seen.push(...(r.out.match(/^(✅|🟠|⏭) \S+|^❌ \S+ — roja también/gm) || []));
  }
  assert.deepStrictEqual([...seen].sort(), ['⏭ lab-absent.test.sh', '✅ lab-green-a.test.sh', '✅ lab-green-b.test.js', '✅ lab-green-c.test.sh',
    '❌ lab-red.test.sh — roja también', '🟠 lab-flaky.test.sh'].sort(), 'entre los dos trabajos, cada suite sale una vez con su marca de siempre');

  publishBench(dir);
  const v = runVerdict(dir, plan.matrix);
  assert.strictEqual(v.join.code, 0, v.join.out);
  assert.deepStrictEqual([...v.report.failures].sort(), ['lab-absent.test.sh(ausente)', 'lab-red.test.sh']);
  assert.deepStrictEqual(v.report.reintentos, { 'lab-flaky.test.sh': { primera: 'rojo', segunda: 'verde' }, 'lab-red.test.sh': { primera: 'rojo', segunda: 'rojo' } },
    'las dos pasadas de cada roja, de los dos trabajos, en el reporte');
  assert.strictEqual(v.report.corridas, 5);
  assert.strictEqual(v.report.complete, true);
  assert.match(v.verdict.out, /INTERMITENTE en el agente: lab-flaky\.test\.sh/);
  assert.match(v.verdict.out, /ROJO NUEVO.*lab-red\.test\.sh.*MODO AVISO/);
  assert.doesNotMatch(v.verdict.out, /NO SE MIDIERON/);
  assert.strictEqual(v.verdict.code, 0, `en modo aviso, un rojo nuevo de suite no frena\n${v.verdict.out}`);
});

// Cada suite se anota como viva, espera un segundo, cuenta cuántas hay vivas en ese momento y se borra.
const LIVE_SH = 'N=$(basename "$0"); L="@DIR@/live"; mkdir -p "$L"; touch "$L/$N"; sleep 1; ls "$L" | wc -l | tr -d " " > "@DIR@/seen.$N"; rm -f "$L/$N"\nexit 0\n';
const LIVE = ['lab-p1.test.sh', 'lab-p2.test.sh', 'lab-p3.test.sh', 'lab-p4.test.sh', 'lab-solo.test.sh'];

test('PrShards_SuitesRunInParallel_ExclusiveAloneInTheBenchJob_UnreadableListRunsOneByOne', { skip: NO_BASH }, () => {
  // 2026-10-05 (pedido del dueño: la validación en 15 min o menos): en serie, un trabajo de 214 suites tardaba 18 min
  const shards = maxShards();
  const peaks = (dir) => Object.fromEntries(LIVE.map((n) => [n, Number(fs.readFileSync(path.join(dir, `seen.${n}`), 'utf8').trim())]));
  // desde el tramo I (story 8.22) la exclusiva la corre el trabajo del banco, después del banco: los de suites, ninguna
  const runAll = (dir) => { const outs = []; for (const i of [...Array(shards).keys()].map((n) => n + 1).concat(BENCH)) { const r = runShard(dir, i, shards, { env: { SUITES_JOBS: '4' } }); assert.strictEqual(r.code, 0, r.out); assert.ok(fs.existsSync(path.join(r.artifact, 'finished')), r.out); outs.push(r.out); } return outs.join('\n'); };

  const dir = toy(LIVE.map((n) => [n, LIVE_SH]), { exclusive: ['lab-solo.test.sh'] });
  assert.strictEqual(runPlan(dir, shards).code, 0);
  const out = runAll(dir);
  assert.match(out, /suites \(trabajo bench\): 0 de a 4 a la vez, y 1 exclusiva\(s\) de a una al final/, out);
  assert.strictEqual((out.match(/, y 0 exclusiva\(s\) de a una al final/g) || []).length, shards, `ningún trabajo de suites corre una exclusiva\n${out}`);
  const seen = peaks(dir);
  assert.ok(Math.max(...['lab-p1.test.sh', 'lab-p2.test.sh', 'lab-p3.test.sh', 'lab-p4.test.sh'].map((n) => seen[n])) >= 2, `las comunes corren a la vez: ${JSON.stringify(seen)}`);
  assert.strictEqual(seen['lab-solo.test.sh'], 1, `la exclusiva corre sola: ${JSON.stringify(seen)}`);
  assert.strictEqual((out.match(/^✅ lab-/gm) || []).length, LIVE.length, 'cada suite sale una vez');

  // sin poder separar las exclusivas, todas de a una — más lento, nunca una mezcla que se pise
  assert.match(stepBody(RUN_STEP), /if ! node scripts\/ci\/suites-exclusive\.js [^\n]+; then\n[^\n]+corren todas de a una"\n\s+JOBS=1; cp "\$LIST" "\$PAR"; : > "\$EXC"\n/, 'el paso cae a de a una si no pudo separar');
});

test('SuitesExclusive_SplitsByRouteEnd_CouldNotReadIsNotNoneExclusive', () => {
  const ex = require(path.join(ROOT, 'scripts', 'ci', 'suites-exclusive.js'));
  const cfg = { diarias: [{ raiz: 'arnes', ruta: 'tests/a.test.sh' }, { raiz: 'arnes', ruta: 'tests/solo.test.sh', exclusive: true }], semanales: [{ raiz: 'agent-skills', ruta: 'x/tests/b.test.js', exclusive: true }] };
  const lines = ['/r/scripts/tests/a.test.sh', '/r/scripts/tests/solo.test.sh', 'C:\\r\\skills\\x\\tests\\b.test.js', '/r/scripts/tests/notsolo.test.sh'];
  assert.deepStrictEqual(ex.split(cfg, lines), { parallel: ['/r/scripts/tests/a.test.sh', '/r/scripts/tests/notsolo.test.sh'], exclusive: ['/r/scripts/tests/solo.test.sh', 'C:\\r\\skills\\x\\tests\\b.test.js'] }, 'cada línea a una sola salida; también con barras de Windows; un nombre que sólo termina igual no cuenta');
  assert.throws(() => ex.split({ diarias: [], semanales: [] }, lines), /ninguna suite/);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'suites-exclusive-'));
  try {
    const list = path.join(d, 'list.txt'); fs.writeFileSync(list, `${lines.join('\n')}\n`);
    const run = (cfgPath) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'suites-exclusive.js'), cfgPath, list, path.join(d, 'p'), path.join(d, 'e')], { encoding: 'utf8' });
    fs.writeFileSync(path.join(d, 'ok.json'), JSON.stringify(cfg));
    assert.strictEqual(run(path.join(d, 'ok.json')).status, 0);
    assert.strictEqual(fs.readFileSync(path.join(d, 'e'), 'utf8'), '/r/scripts/tests/solo.test.sh\nC:\\r\\skills\\x\\tests\\b.test.js\n');
    fs.writeFileSync(path.join(d, 'broken.json'), '{');
    const broken = run(path.join(d, 'broken.json'));
    assert.deepStrictEqual([broken.status, /no pude separar/.test(broken.stderr)], [1, true], 'ilegible: sale 1 y lo dice');
    assert.strictEqual(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'suites-exclusive.js')], { encoding: 'utf8' }).status, 2, 'sin argumentos: uso');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('DEF-8.7-C PrShards_SuiteThatSaysItDidNotMeasure_IsNotShownGreen_AndDoesNotStopTheVerdict — en la validación no sale con ✅, y no frena', { skip: NO_BASH }, () => {
  // En la validación de cada cambio la máquina limpia no mide nunca, a propósito (su T34): contarla como no medida
  // haría salir 2 a todas las validaciones. Se dice en su línea y el veredicto queda como estaba. Lo que la cuenta como
  // NO MEDIDA es el nocturno (caso DEF-8.7-C de nightly-suites-shards.test.js), que es el reporte que viaja.
  const dir = toy([['lab-says-not-measured.test.sh', 'echo "⏭ lab-says-not-measured: NO MEDIDO — no hay docker"\nexit 0\n'], ['lab-green-a.test.sh', GREEN_SH]]);
  const plan = runPlan(dir, maxShards());
  assert.strictEqual(plan.code, 0, plan.out);
  let out = '';
  for (let i = 1; i <= plan.of; i += 1) { const r = runShard(dir, i, plan.of); assert.strictEqual(r.code, 0, r.out); out += r.out; }
  assert.match(out, /^⏭ lab-says-not-measured\.test\.sh — NO se midió \(la suite lo dice, no frena\): no hay docker$/m);
  assert.doesNotMatch(out, /^✅ lab-says-not-measured\.test\.sh/m);
  assert.match(out, /^✅ lab-green-a\.test\.sh/m);
  publishBench(dir);
  const v = runVerdict(dir, plan.matrix);
  assert.strictEqual(v.join.code, 0, v.join.out);
  assert.deepStrictEqual(v.report.failures, [], 'no es una roja');
  assert.strictEqual(v.verdict.code, 0, `no frena: el veredicto sigue verde\n${v.verdict.out}`);
});

test('PrShards_ShardThatPublishedNothing_TheVerdictDeclaresItsSuitesNotMeasured', { skip: NO_BASH }, () => {
  const shards = maxShards();
  const dir = toy(SIX);
  const plan = runPlan(dir, shards);
  const missing = 2;
  for (let i = 1; i <= shards; i += 1) runShard(dir, i, shards, { publish: i !== missing });
  publishBench(dir);
  const lost = namesOf(dir, missing, shards);
  assert.ok(lost.length > 0);

  const v = runVerdict(dir, plan.matrix);
  assert.match(v.join.out, new RegExp(`##vso\\[task\\.logissue type=error\\].*trabajo ${missing} de ${shards}`), 'la corrida lo denuncia como error');
  assert.deepStrictEqual([...v.report.unmeasured].sort(), lost.map((n) => `${n}(no-medida)`).sort());
  assert.match(v.verdict.out, new RegExp(`${lost.length} suite\\(s\\) NO SE MIDIERON`), 'el veredicto las declara no medidas');
  for (const name of lost) assert.doesNotMatch(v.verdict.out, new RegExp(`ROJO NUEVO[^\\n]*${name.replace(/\./g, '\\.')}`), `${name} no es un rojo nuevo`);
  assert.strictEqual(v.verdict.code, 2, `no medido no es verde: el veredicto sale 2\n${v.verdict.out}`);
  assert.match(v.verdict.out, /No se pudo dar el veredicto: no medido no es verde/);
});

test('PrShards_BenchReportMissing_TheJoinGoesRedAndTheVerdictIsStillGiven', { skip: NO_BASH }, () => {
  const shards = maxShards();
  const dir = toy(SIX);
  const plan = runPlan(dir, shards);
  for (let i = 1; i <= shards; i += 1) runShard(dir, i, shards);
  const v = runVerdict(dir, plan.matrix);
  assert.notStrictEqual(v.join.code, 0, `sin el reporte del banco, el banco no se midió: rojo\n${v.join.out}`);
  assert.match(v.join.out, /##vso\[task\.logissue type=error\].*banco NO se midió/);
  assert.ok(v.report, 'las suites se juntan igual');
  assert.match(v.verdict.out, /sin rojos nuevos que frenen|ROJO NUEVO/, 'y el veredicto se da con lo que sí se midió');
});

test('PrShards_DownloadWithTrouble_TheJoinGoesRed', { skip: NO_BASH }, () => {
  const shards = maxShards();
  const dir = toy(SIX);
  const plan = runPlan(dir, shards);
  for (let i = 1; i <= shards; i += 1) runShard(dir, i, shards);
  publishBench(dir);
  const v = runVerdict(dir, plan.matrix, { AGENT_JOBSTATUS: 'SucceededWithIssues' });
  assert.notStrictEqual(v.join.code, 0, v.join.out);
  assert.match(v.join.out, /##vso\[task\.logissue type=error\].*cuenta como NO MEDIDO/);
});

test('PrShards_NoPlan_NoSuitesAreJudgedAsGreen', { skip: NO_BASH }, () => {
  // Validar falló antes de dejar la lista: el veredicto no puede salir verde con el banco solo.
  const dir = toy(SIX);
  publishBench(dir);
  const v = runVerdict(dir, null);
  assert.notStrictEqual(v.join.code, 0, v.join.out);
  assert.match(v.join.out, /##vso\[task\.logissue type=error\].*lista de suites del cambio/);
  assert.strictEqual(v.report, null);
});

test('PrShards_VerdictWithoutAReadableMatrix_SuitesAreNotMeasured', { skip: NO_BASH }, () => {
  // story 8.22, tramo C: el veredicto saca su --of de la matriz que publicó Validar. Sin poder leerla no sabe qué
  // reparto esperar: «no se midieron», rojo — nunca juntar con un número inventado.
  const dir = toy(SIX);
  const plan = runPlan(dir, maxShards());
  for (let i = 1; i <= plan.of; i += 1) runShard(dir, i, plan.of);
  publishBench(dir);
  for (const broken of [null, '{"shard_1":{"SUITES_SHARD":"1","SUITES_OF":"2"}}']) {
    const v = runVerdict(dir, broken);
    assert.notStrictEqual(v.join.code, 0, v.join.out);
    assert.match(v.join.out, /##vso\[task\.logissue type=error\]No pude leer cuántos trabajos de suites armó Validar.*NO se midieron/);
    assert.strictEqual(v.report, null);
  }
});

test('PrShards_PlanStep_RunsEverythingWhenTheChangeIsUnknown', { skip: NO_BASH }, () => {
  const shards = maxShards();
  const dir = toy(SIX);
  const r = runPlan(dir, shards, null);
  assert.strictEqual(r.code, 0, r.out);
  const run = fs.readFileSync(path.join(r.plan, 'run.txt'), 'utf8').split('\n').filter(Boolean).map((l) => path.posix.basename(slash(l)));
  assert.deepStrictEqual(run.sort(), SIX.map(([n]) => n).sort(), '«no pude saber qué trae el cambio» corre todas');
});

// ── segunda parte: las dos suites más largas, sólo si el cambio toca lo que miden ─────────────────────────────────
// Desde la story 8.26 (tanda I) queda una sola de las dos más largas: la copia pública armada (export-real) se retiró,
// porque de ningún repo sale ya una copia. Los casos conservan su nombre (el reparto en partes los usa).
const HEAVY_TOY = [['clean-machine.test.sh', GREEN_SH], ['lab-green-a.test.sh', GREEN_SH],
  ['lab-green-b.test.js', 'process.exit(0);\n'], ['lab-red.test.sh', RED_SH]];
const planned = (r, file) => fs.readFileSync(path.join(r.plan, file), 'utf8').split('\n').filter(Boolean).map((l) => path.posix.basename(slash(l.split('\t')[0])));

test('PrShards_HeavySuites_TheStepsPassTheCriterionAndTheVerdictGetsWhatDidNotRun', () => {
  assert.ok(stepBody(PLAN_STEP).includes('--heavy "$(Build.SourcesDirectory)/scripts/ci/heavy-suites.json"'), 'el plan aplica el criterio de las dos más largas');
  // story 8.22, tramo B: con la lista del cambio, el de las dependencias de cada suite (scripts/ci/suite-deps.js), la
  // lista de código para elegir y la entera para la pesada que mira .md, y la foto nocturna de origin/main como red
  // (story 8.26, tanda C, AC 43: la foto, la que trajo Validar; ya no `git show origin/main:…` en este paso)
  for (const piece of ['--deps', '--changed "$LISTA_CODIGO_SUITES"', '--changed-with-docs "$CAMB"', '--nightly "$FOTO"', '$(Agent.TempDirectory)/snapshot/nightly-suites.json']) {
    assert.ok(stepBody(PLAN_STEP).includes(piece), `el plan pasa ${piece}`);
  }
  assert.ok(!stepBody(PLAN_STEP).includes('git show origin/main:scripts/controls-bench'), 'el plan no lee la foto por su cuenta');
  assert.ok(stepBody(JOIN_STEP).includes('--not-run "${PLAN_DIR}skip.txt"'), 'y el reporte anota las que no corrieron');
});

test('PrShards_HeavySuites_ChangeThatDoesNotShip_SkipsBothAndTheVerdictSaysSo', { skip: NO_BASH }, () => {
  // (2026-10-06: las guías y los guiones viajan en la copia y ya corren la copia pública de verdad; esto no viaja)
  const shards = maxShards();
  const dir = toy(HEAVY_TOY);
  const r = runPlan(dir, shards, ['specs/story-9.9-lab.md', 'tasks/lab.md']);
  const plan = r;
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(planned(r, 'skip.txt').sort(), ['clean-machine.test.sh']);
  assert.ok(!planned(r, 'run.txt').includes('clean-machine.test.sh'));
  for (let i = 1; i <= shards; i += 1) assert.strictEqual(runShard(dir, i, shards).code, 0);
  publishBench(dir);
  const v = runVerdict(dir, plan.matrix);
  assert.strictEqual(v.join.code, 0, v.join.out);
  assert.match(v.report.notRun['clean-machine.test.sh'], /no toca lo que mide/);
  assert.match(v.verdict.out, /no corrió: el cambio no toca lo que mide — clean-machine\.test\.sh/);
  assert.doesNotMatch(v.verdict.out, /(ROJO NUEVO|ya estaba rojo)[^\n]*clean-machine/, 'ni roja ni excusada: no corrió');
  assert.strictEqual(v.verdict.code, 0, v.verdict.out);
});

test('PrShards_HeavySuites_NightlyPhotoIncompleteOldOrMissing_NothingIsSkippedAndTheStepSaysWhy', { skip: NO_BASH }, () => {
  // El mismo cambio que arriba saltea las dos. Sin red —el nocturno no midió todo, la foto es vieja, o origin/main no
  // la trae— no se saltea ninguna, y el paso dice por qué: es lo que pasó en `main` el 2026-10-08, y se leía como una
  // prueba rota. Acá la foto la pone el caso (toyGit), no el nocturno de anoche.
  const old = new Date(Date.now() - 40 * 3600 * 1000).toISOString();
  const cases = [
    ['el nocturno no midió todo', { kind: 'bash-tests', ts: new Date().toISOString(), failures: ['clean-machine.test.sh(no-medida)'], complete: false }, /--deps no saltea nada[^\n]*complete: false/],
    ['la foto es de hace 40 h', { kind: 'bash-tests', ts: old, failures: [], complete: true }, /--deps no saltea nada[^\n]*hace 40 h/],
    ['no llegó la foto', null, /##vso\[task\.logissue type=warning\]suites: no pude leer la foto nocturna[^\n]*--deps no saltea nada/],
  ];
  for (const [what, photo, says] of cases) {
    const r = runPlan(toy(HEAVY_TOY, { photo }), maxShards(), ['specs/story-9.9-lab.md', 'tasks/lab.md']);
    assert.strictEqual(r.code, 0, `${what}\n${r.out}`);
    assert.deepStrictEqual(planned(r, 'skip.txt'), [], `${what}: sin red no se saltea ninguna\n${r.out}`);
    for (const heavy of ['clean-machine.test.sh']) assert.ok(planned(r, 'run.txt').includes(heavy), `${what}: ${heavy} corre\n${r.out}`);
    assert.match(r.out, says, `${what}: el paso dice por qué no saltea`);
  }
});

test('PrShards_ToyGit_OnlyAnswersTheNightlyPhoto', { skip: NO_BASH }, () => {
  // El git de juguete no puede tapar al de verdad: cualquier otra pregunta la contesta el git de la máquina.
  const dir = toy(SIX);
  const r = bash(dir, `git show "${PHOTO_ASK}"\ngit rev-parse --is-inside-work-tree\ngit --version\n`, 'toy-git');
  assert.strictEqual(r.code, 0, r.out);
  const lines = r.out.split('\n').filter(Boolean);
  assert.strictEqual(JSON.parse(lines[0]).complete, true, 'la foto es la del caso');
  assert.strictEqual(lines[1], 'true', 'lo demás es el git de verdad, parado en el arnés');
  assert.match(lines[2], /^git version /);
});

test('PrShards_HeavySuites_PublishingChangeOrFailedDiff_RunsBoth', { skip: NO_BASH }, () => {
  const shards = maxShards();
  const publishing = runPlan(toy(HEAVY_TOY), shards, ['scripts/publishing/export.js']);
  assert.strictEqual(publishing.code, 0, publishing.out);
  for (const name of ['clean-machine.test.sh']) assert.ok(planned(publishing, 'run.txt').includes(name), `scripts/publishing/ corre ${name}`);
  // El diff del pedido de merge falló («Qué trae este cambio» dejó todo=si): corren todas, nunca «no hace falta».
  // (story 8.22: el motivo lo trae «Qué trae este cambio» en motivoTodo y el paso lo repite)
  const failed = runPlan(toy(HEAVY_TOY), shards, null, { SYSTEM_PULLREQUEST_TARGETBRANCH: 'refs/heads/main', MOTIVOTODO: 'el diff contra origin/main falló: x' });
  assert.strictEqual(failed.code, 0, failed.out);
  assert.match(failed.out, /suites: corren todas — el diff contra origin\/main falló: x/);
  assert.deepStrictEqual(planned(failed, 'skip.txt'), []);
  for (const name of ['clean-machine.test.sh']) assert.ok(planned(failed, 'run.txt').includes(name), `con el diff fallido corre ${name}`);
});

test('PrShards_ShardNumberOutsideTheMatrix_GoesRedWithoutRunningAnything', { skip: NO_BASH }, () => {
  const shards = maxShards();
  const dir = toy(SIX);
  const plan = runPlan(dir, shards);
  const r = runShard(dir, shards + 1, shards);
  assert.notStrictEqual(r.code, 0, r.out);
  assert.match(r.out, /##vso\[task\.logissue type=error\]/);
  assert.doesNotMatch(r.out, /✅/);
});

// story 8.22, tramo F (AC 21): las suites que pasan de 45 s y van al nocturno las saltea la validación de cada rama. El
// selector las conoce por --over-limit; el banco nocturno no lee esa lista: corre todas. (El salteo mismo lo mide
// suites-for-change.test.js, T29; acá, que el pipeline se lo pida. Desde la story 8.26, tanda C, esta prueba viaja con la
// validación; el nocturno no: su mitad ahí no se mide.)
const NIGHTLY_BENCH = path.join(ROOT, 'pipelines/azure-pipelines-banco.yml');
test('T29 PrSuites_PlanStepPassesTheOverLimitList_NightlyDoesNot — la validación le pasa la lista al selector; el nocturno no la lee', () => {
  const pr = fs.readFileSync(YAML, 'utf8');
  const call = pr.slice(pr.indexOf('node scripts/ci/suites-for-change.js --suites'));
  assert.match(call.slice(0, call.indexOf('> "$PLAN"')), /--over-limit "\$\(Build\.SourcesDirectory\)\/scripts\/ci\/suites-over-limit\.json"/, `el paso «${PLAN_STEP}» pasa --over-limit`);
});
test('T29 PrSuites_NightlyDoesNotReadTheOverLimitList', { skip: !fs.existsSync(NIGHTLY_BENCH) && 'NO MEDIDO — la copia pública no trae el pipeline nocturno del banco' }, () => {
  assert.ok(!fs.readFileSync(NIGHTLY_BENCH, 'utf8').includes('suites-over-limit'), 'el nocturno corre todas: no lee la lista');
});

// ── story 8.22, tramo I (AC 37 y 38): las suites que corren solas, en el carril del banco ──────────────────────────
// Medido el 2026-10-08 con cuatro validaciones de un solo archivo: la copia pública de verdad tardaba 370 a 383 s sola,
// al final de un trabajo de suites, mientras el trabajo del banco terminaba a los ~5 min y dejaba su carril ocioso.
const SOLO = ['lab-p1.test.sh', 'lab-p2.test.sh', 'lab-p3.test.sh', 'lab-solo-green.test.sh', 'lab-solo-red.test.sh'];
const SOLO_EXCLUSIVE = ['lab-solo-green.test.sh', 'lab-solo-red.test.sh'];
const soloToy = () => toy(SOLO.map((n) => [n, n === 'lab-solo-red.test.sh' ? RED_SH : LIVE_SH]), { exclusive: SOLO_EXCLUSIVE });
const everyJob = (of) => [...Array(of).keys()].map((n) => n + 1);

test('T48 PrShards_BenchJobRunsTheExclusiveSuitesAndTheVerdictJoinsThem — el trabajo del banco corre las que corren solas y el veredicto las junta', { skip: NO_BASH }, () => {
  // La forma: el trabajo del banco corre el banco, publica su reporte y DESPUÉS corre los pasos de la plantilla, con su
  // nombre de trabajo y la cuenta que publicó Validar. Un rojo del banco no las saltea.
  const { Bench: bench, Suites: suites } = jobs();
  assert.match(bench, /\n {4}variables:\n {6}SUITES_SHARD: bench\n {6}SUITES_OF: \$\[ dependencies\.Validar\.outputs\['suites\.of'\] \]\n/, 'el trabajo del banco es el «bench» del reparto, con la cuenta de Validar');
  assert.ok(stepBody(PLAN_STEP).includes('echo "##vso[task.setvariable variable=of;isOutput=true]$OF"'), 'Validar publica la cuenta sola: el trabajo del banco no es una pata de la matriz');
  const use = `${TEMPLATE_USE}        parameters:\n          condicion: succeededOrFailed()\n`;
  assert.ok(bench.includes(use), 'el trabajo del banco usa la plantilla, y corre sus suites aunque el banco haya salido rojo');
  assert.ok(bench.indexOf(use) > bench.indexOf("displayName: 'Publicar el reporte del banco'"), 'después del banco y de publicar su reporte');
  assert.ok(!suites.includes('condicion:'), 'los trabajos de suites corren la plantilla con su condición de siempre');
  assert.match(template, /\n {2}- name: condicion\n {4}type: string\n {4}default: 'succeeded\(\)'\n/, 'que es succeeded()');
  for (const step of ['Bajar la lista de suites del cambio', RUN_STEP]) {
    assert.ok(template.includes(`    displayName: '${step}'\n    condition: \${{ parameters.condicion }}\n`), `«${step}» corre con la condición que le pasa el trabajo`);
  }
  assert.match(bench, /- template: \/pipelines\/templates\/fetch-repos\.yml\n {8}parameters:\n {10}agentSkills: true\n {10}productos: true\n/, 'y trae los mismos repos que un trabajo de suites');
  // Una suite no puede dar otro resultado según en qué trabajo le tocó: los dos arrancan con los mismos pasos (el clon
  // entero con su credencial, node, los repos), sin contar los comentarios.
  const before = (job, mark) => { const own = job.slice(job.indexOf('\n    steps:\n'), job.indexOf(mark)); return own.split('\n').map((l) => l.replace(/\s+#.*$/, '')).filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n'); };
  assert.strictEqual(before(bench, '\n      - script: |'), before(suites, `\n${TEMPLATE_USE}`), 'el trabajo del banco prepara lo mismo que un trabajo de suites');
  // Los cuatro llamados al repartidor separan las que corren solas: si uno no lo hiciera, una suite correría dos veces
  // o ninguna.
  for (const sub of ['jobs', 'plan', 'list', 'merge']) assert.ok(shardCall(sub).includes(' --exclusive-apart '), `suites-shard.js ${sub} separa las que corren solas: ${shardCall(sub)}`);

  // Corrido de verdad: tres comunes y dos que corren solas, una verde y una roja.
  const dir = soloToy();
  const plan = runPlan(dir, maxShards());
  assert.strictEqual(plan.code, 0, plan.out);
  assert.match(plan.out, /trabajo del banco: 2 suite\(s\) que corren solas/, 'el plan dice cuáles van al trabajo del banco');
  assert.match(plan.out, /^##vso\[task\.setvariable variable=of;isOutput=true\](\d+)$/m);
  assert.strictEqual(Number(plan.out.match(/variable=of;isOutput=true\](\d+)$/m)[1]), plan.of, 'la cuenta que lee el trabajo del banco es la de la matriz');
  const inSuites = [];
  for (const i of everyJob(plan.of)) {
    const r = runShard(dir, i, plan.of, { env: { SUITES_JOBS: '4' } });
    assert.strictEqual(r.code, 0, r.out);
    inSuites.push(...(r.out.match(/^(?:✅|❌|🟠) \S+/gm) || []));
  }
  assert.deepStrictEqual(inSuites.sort(), ['✅ lab-p1.test.sh', '✅ lab-p2.test.sh', '✅ lab-p3.test.sh'], 'los trabajos de suites corren las comunes, y ninguna de las que corren solas');
  const b = runShard(dir, BENCH, plan.of, { env: { SUITES_JOBS: '4' } });
  assert.strictEqual(b.code, 0, `una roja no rompe el trabajo del banco\n${b.out}`);
  assert.deepStrictEqual((b.out.match(/^✅ \S+|^❌ \S+ — roja también/gm) || []).sort(), ['✅ lab-solo-green.test.sh', '❌ lab-solo-red.test.sh — roja también'], 'el trabajo del banco corre las dos, con su reintento');
  assert.match(b.out, /suites \(trabajo bench\): 0 de a 4 a la vez, y 2 exclusiva\(s\) de a una al final/, 'de a una');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'seen.lab-solo-green.test.sh'), 'utf8').trim(), '1', 'la que corre sola no tuvo a ninguna otra viva');
  assert.ok(fs.existsSync(path.join(b.artifact, 'finished')), 'y publica que pasó por toda su lista');

  publishBench(dir);
  const v = runVerdict(dir, plan.matrix);
  assert.strictEqual(v.join.code, 0, v.join.out);
  assert.match(v.join.out, /trabajo del banco: terminó · 2 corrida\(s\) · 1 en rojo o ausente\(s\)/, 'el veredicto junta lo del trabajo del banco');
  assert.strictEqual(v.report.corridas, SOLO.length, 'entre los trabajos de suites y el del banco corrió el plan entero, cada suite una vez');
  assert.deepStrictEqual(v.report.failures, ['lab-solo-red.test.sh']);
  assert.strictEqual(v.report.complete, true);
  assert.match(v.verdict.out, /ROJO NUEVO.*lab-solo-red\.test\.sh/);
  assert.doesNotMatch(v.verdict.out, /NO SE MIDIERON/);

  // Un plan sin suites que corren solas: el trabajo del banco no corre ninguna, no falla, y el veredicto no lo espera.
  const plain = toy(SIX);
  const p = runPlan(plain, maxShards());
  assert.doesNotMatch(p.out, /trabajo del banco/, 'el plan no nombra al trabajo del banco');
  for (const i of everyJob(p.of)) assert.strictEqual(runShard(plain, i, p.of).code, 0);
  const none = runShard(plain, BENCH, p.of);
  assert.strictEqual(none.code, 0, none.out);
  assert.match(none.out, /suites \(trabajo bench\): a este trabajo no le toca ninguna suite de este plan — no corre ninguna/);
  assert.doesNotMatch(none.out, /##vso\[task\.logissue/, 'no es un error ni un aviso');
  publishBench(plain);
  const pv = runVerdict(plain, p.matrix);
  assert.strictEqual(pv.join.code, 0, pv.join.out);
  assert.doesNotMatch(pv.join.out, /trabajo del banco/, 'y el veredicto junta lo mismo que antes');
  assert.strictEqual(pv.report.corridas, 5);
});

test('T49 PrShards_BenchJobThatDoesNotFinishItsSuites_TheyAreNotMeasured — si el trabajo del banco no termina sus suites, son no medidas', { skip: NO_BASH }, () => {
  const notMeasured = SOLO_EXCLUSIVE.map((n) => `${n}(no-medida)`).sort();
  const upTo = (cut) => {
    const dir = soloToy();
    const plan = runPlan(dir, maxShards());
    for (const i of everyJob(plan.of)) assert.strictEqual(runShard(dir, i, plan.of).code, 0);
    cut(dir, plan);
    publishBench(dir);
    return runVerdict(dir, plan.matrix);
  };
  // (1) el trabajo del banco no publicó nada: lo cortaron, o falló antes de llegar a sus suites
  // (2) publicó, pero sin la marca de haber pasado por toda su lista: lo cortaron a mitad de camino
  const cuts = {
    'no publicó nada': (dir, plan) => { runShard(dir, BENCH, plan.of, { publish: false }); },
    'publicó sin terminar su lista': (dir, plan) => {
      const r = runShard(dir, BENCH, plan.of);
      // como lo deja un corte antes de que termine la primera: los archivos del arranque, vacíos, y sin la marca
      fs.rmSync(path.join(r.artifact, 'finished'));
      for (const f of ['ran.txt', 'failures.txt', 'done.txt']) fs.writeFileSync(path.join(r.artifact, f), '');
      fs.writeFileSync(path.join(r.artifact, 'retries.json'), '{}\n');
    },
  };
  for (const [what, cut] of Object.entries(cuts)) {
    const v = upTo(cut);
    assert.match(v.join.out, /##vso\[task\.logissue type=error\]El trabajo del banco de las suites no terminó: .*2 suite\(s\) quedan como NO MEDIDAS, no como verdes/, `${what}: la corrida lo denuncia\n${v.join.out}`);
    assert.deepStrictEqual([...v.report.unmeasured].sort(), notMeasured, `${what}: sus suites son no medidas`);
    assert.strictEqual(v.report.complete, false, what);
    assert.match(v.verdict.out, /2 suite\(s\) NO SE MIDIERON/, what);
    assert.doesNotMatch(v.verdict.out, /ROJO NUEVO[^\n]*lab-solo/, `${what}: ni rojas ni verdes`);
    assert.strictEqual(v.verdict.code, 2, `${what}: no medido no es verde\n${v.verdict.out}`);
  }

  // Sin poder separar las que corren solas dentro del trabajo, corren todas de a una y el paso lo dice (como siempre).
  assert.match(stepBody(RUN_STEP), /if ! node scripts\/ci\/suites-exclusive\.js [^\n]+; then\n[^\n]+corren todas de a una"\n\s+JOBS=1; cp "\$LIST" "\$PAR"; : > "\$EXC"\n/);
  // Y si el repartidor no puede armar la lista del trabajo del banco, el paso sale rojo sin correr nada: no medidas.
  const dir = soloToy();
  const plan = runPlan(dir, maxShards());
  fs.writeFileSync(path.join(dir, 'repo', 'scripts', 'tests', 'suites.json'), '{ esto no es JSON');
  const broken = runShard(dir, BENCH, plan.of);
  assert.notStrictEqual(broken.code, 0, broken.out);
  assert.match(broken.out, /##vso\[task\.logissue type=error\]No se pudo armar la lista del trabajo bench de \d+: sus suites NO se midieron/);
  assert.doesNotMatch(broken.out, /^(✅|❌|🟠|⏭) lab-/m, 'ninguna suite corrió');
  assert.ok(!fs.existsSync(path.join(broken.artifact, 'finished')), 'y no deja la marca de terminado');
});

// AC 38 (b): un banco COLGADO no puede llevarse puesto el trabajo. Si lo cortara el tope del trabajo, Azure cancela lo
// que sigue —las suites que corren solas no correrían— y esa hora de carril se pierde. El paso del banco corre con su
// propio tope (scripts/ci/run-capped.js): colgado, se corta, el paso sale rojo «NO se midió» y el trabajo sigue.
const BENCH_STEP = 'Banco de controles (--tool both)';
function runBench(runner, env = {}) {
  const dir = toy([['lab-a.test.sh', GREEN_SH]]);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'scripts', 'controls-bench'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'controls-bench', 'runner.js'), runner);
  fs.copyFileSync(path.join(ROOT, 'scripts', 'ci', 'run-capped.js'), path.join(repo, 'scripts', 'ci', 'run-capped.js'));
  const staging = path.join(dir, 'staging-bench');
  const temp = path.join(dir, 'temp-bench');
  fs.mkdirSync(temp, { recursive: true });
  const started = Date.now();
  const r = bash(dir, expand(stepBody(BENCH_STEP), { sources: repo, staging, temp }), 'bench-step', env);
  return { ...r, seconds: (Date.now() - started) / 1000, report: path.join(staging, 'bench', 'banco.json') };
}
// El runner de juguete deja su reporte donde se lo piden (--json) y sale con el código que se le diga.
const TOY_RUNNER = (exit) => `const fs = require('fs'); const at = process.argv.indexOf('--json');\nfs.writeFileSync(process.argv[at + 1], '{"kind":"toy"}');\nconsole.log('banco de juguete'); process.exit(${exit});\n`;

test('T48 PrShards_BenchThatHangs_IsCutByItsOwnCapAndTheJobGoesOn — un banco colgado se corta por su tope y no se lleva puestas las suites', { skip: NO_BASH }, () => {
  const { Bench: bench } = jobs();
  assert.match(bench, /\n {4}timeoutInMinutes: 40\n/, 'el trabajo: 10 min del banco más la suma de los topes de las suites que corren solas');
  // 🔴 La cuenta, con los archivos de verdad (2026-10-11): el tope del trabajo es su PEOR caso —el banco colgado hasta
  // su tope y cada suite que corre sola colgada hasta el suyo—. Cuando una suite más pasó a correr sola la cuenta dejó
  // de entrar (43,6 min contra 40) y nadie lo vio hasta hacerla a mano. Si vuelve a pasar, esto se pone rojo: se le da
  // tope propio a alguna (`suite_cap.per_suite` del juego `pr`) o lo decide el dueño; el número del YAML no se sube solo.
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'suites.json'), 'utf8'));
  const alone = Object.values(registry).filter(Array.isArray).flat().filter((s) => s && s.exclusive === true).map((s) => path.basename(s.ruta));
  // 🔴 Cuántas son depende de DÓNDE corre esta prueba (2026-10-11): en el repo del equipo son 7; en la copia pública
  // quedan 4, porque tres no viajan (la copia de verdad, la capa de verdad y el laboratorio guiado de Windows). Exigir
  // «al menos 6» dejó esta prueba roja en la copia sin llegar a hacer la cuenta, y con el freno de suites prendido eso
  // frena todo pedido al repo público. El piso es que haya alguna: sin ninguna, la cuenta de abajo no mide nada.
  assert.ok(alone.length >= 1, `suites.json no trae ninguna suite que corra sola: la cuenta del tope no mide nada (${alone.join(' ')})`);
  const asked = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'suites-shard.js'), 'caps', '--weight-set', 'pr'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(asked.status, 0, asked.stderr);
  const capOf = new Map(asked.stdout.trim().split('\n').map((l) => l.split('\t')).map(([name, seconds]) => [name, Number(seconds)]));
  for (const name of alone) assert.ok(capOf.get(name) > 0, `${name} corre sola y el repartidor le da un tope`);
  const BENCH_CAP = 600;
  const worst = BENCH_CAP + alone.reduce((sum, name) => sum + capOf.get(name), 0);
  assert.ok(worst <= 40 * 60, `el peor caso del trabajo del banco no entra en sus 40 min: ${(worst / 60).toFixed(1)} min (${BENCH_CAP} s del banco + ${alone.map((n) => `${n} ${capOf.get(n)}`).join(' + ')})`);
  // las dos de tope propio: tardan 1 y 3 s en la validación, y 60 s les dejan margen de sobra (las dos viajan a la copia;
  // si un día alguna no viajara, acá no hay nada que fijar para ella)
  for (const name of ['clean-machine.test.sh', 'instinct-executor.test.sh']) {
    if (alone.includes(name)) assert.strictEqual(capOf.get(name), 60, `${name} tiene su tope propio de 60 s`);
  }
  const step = stepBody(BENCH_STEP);
  assert.match(step, /node scripts\/ci\/run-capped\.js --seconds "\$CAP" --mark "\$MARK" -- node scripts\/controls-bench\/runner\.js /, 'el runner corre con tope');
  assert.match(step, /CAP="\$\{BENCH_CAP_SECONDS:-600\}"/, 'de 10 minutos, si nadie dice otra cosa');

  // colgado: se corta a los 2 s de la prueba, sale rojo y lo dice; no deja un reporte a medias
  const hung = runBench('setInterval(() => {}, 1000);\n', { BENCH_CAP_SECONDS: '2' });
  assert.notStrictEqual(hung.code, 0, hung.out);
  assert.ok(hung.seconds < 30, `no espera al runner colgado (${hung.seconds} s)`);
  assert.match(hung.out, /##vso\[task\.logissue type=error\]El banco pasó su tope de 2 s y se cortó: NO se midió/);
  assert.ok(!fs.existsSync(hung.report), 'sin reporte: el veredicto lo cuenta como banco no medido');
  // colgado después de escribir un reporte: el reporte de un banco cortado no vale
  const late = runBench(`const fs = require('fs'); fs.writeFileSync(process.argv[process.argv.indexOf('--json') + 1], '{}');\nsetInterval(() => {}, 1000);\n`, { BENCH_CAP_SECONDS: '2' });
  assert.notStrictEqual(late.code, 0, late.out);
  assert.ok(!fs.existsSync(late.report), 'el reporte de un banco cortado se descarta');

  // sano, y con rojos: el contrato de siempre — el paso sale 0 con su reporte y el veredicto decide
  for (const exit of [0, 1]) {
    const fine = runBench(TOY_RUNNER(exit));
    assert.strictEqual(fine.code, 0, fine.out);
    assert.match(fine.out, new RegExp(`banco medido \\(código del runner: ${exit}\\)`));
    assert.ok(fs.existsSync(fine.report));
    assert.doesNotMatch(fine.out, /##vso\[task\.logissue/);
  }
  // un tope que no es un número de segundos: se avisa y vale el de siempre (nunca «sin tope»)
  const odd = runBench(TOY_RUNNER(0), { BENCH_CAP_SECONDS: 'mucho' });
  assert.strictEqual(odd.code, 0, odd.out);
  assert.match(odd.out, /##vso\[task\.logissue type=warning\].*BENCH_CAP_SECONDS no es un número de segundos.*uso 600/);
});

// Los pasos de bash de los pipelines corren también en ESTA prueba, con el bash de la máquina: en la Mac, el 3.2. Ahí `$VAR`
// pegado a un carácter que no es ASCII parte la variable (el control de scripts/ci/check-bash32-quoting.sh, que el
// pre-commit pasa sólo sobre los .sh). Caso 2026-10-15: un «($CAP)» con comillas angulares en el paso del banco dejó roja la
// prueba del banco colgado en toda Mac (`CAP` más un byte: unbound variable), y en Azure, con bash 5, no se veía.
// ROJO PREVIO: con el «$CAP» de antes en pipelines/azure-pipelines-maintainers-pr.yml, este caso sale rojo nombrando la línea 671.
test('T48 PrShards_PipelineBashSteps_NoVariableGluedToNonAscii — ningún pipeline pega $VAR a un carácter no ASCII', { skip: NO_BASH }, () => {
  const yamls = fs.readdirSync(path.join(ROOT, 'pipelines'), { recursive: true }).map(String).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join('pipelines', f));
  assert.ok(yamls.length > 0, 'no encontré pipelines que mirar: el caso no mide nada');
  const lint = path.join(ROOT, 'scripts', 'ci', 'check-bash32-quoting.sh');
  // Control negativo: un paso roto TIENE que salir 1. Si el control no pudo mirar (sin perl, por ejemplo, sale 0 callado),
  // este caso lo delata en vez de dar el verde de abajo sin haber mirado nada. El ejemplo se arma por partes: así este
  // archivo no trae la secuencia rota.
  const roto = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bash32-yml-')), 'roto.yml');
  fs.writeFileSync(roto, `steps:\n  - bash: |\n      CAP=1\n      echo "«$${'CAP'}»"\n`);
  const neg = spawnSync(BASH.path, [lint, roto], { cwd: ROOT, encoding: 'utf8' });
  assert.ifError(neg.error);   // bash no se pudo lanzar: que el rojo diga por qué, no un mensaje vacío
  assert.strictEqual(neg.status, 1, `el control no marcó un paso roto: no está mirando (${neg.stdout}${neg.stderr})`);
  const r = spawnSync(BASH.path, [lint, ...yamls], { cwd: ROOT, encoding: 'utf8' });
  assert.ifError(r.error);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
});

// story 8.22, cierre (AC 29): el tope de cada trabajo de suites baja de los 45 min de antes a 40. El número lo decidió
// el dueño del arnés el 2026-10-08 con lo medido a la vista —el trabajo más largo dura 26,0 min con un cambio de un
// archivo (el del instalador) y 31,4 en una validación que corre casi todo—: una suite colgada cuesta menos carril, y un
// trabajo sano no se corta. Y el pipeline ya no dice que la organización tiene 2 carriles: son 4 hospedados, de los que a
// una corrida le tocan 2 en la práctica. (El valor exacto lo fija el caso «cada trabajo de suites tiene 40 minutos de
// tope», más arriba; acá van los límites entre los que puede moverse sin volver a preguntar, y que la historia lo cuente.)
// Los topes que un job nombra a su nivel, se escriban como se escriban: con un comentario al lado, con espacios de más, con
// la clave entre comillas o con un parámetro. (Pase adversarial del cierre: contando sólo `timeoutInMinutes: <número>` a
// secas, un segundo tope escrito de otra forma en el mismo job no se veía y «UN tope» pasaba con dos.)
const jobTops = (job) => [...job.matchAll(/^ {4}["']?timeoutInMinutes["']?[ \t]*:(.*)$/gm)].map((m) => m[1].trim());

test('T33 PrPipeline_SuitesTimeoutBelow45AndFourLanes — el tope del trabajo de suites baja de 45 y el pipeline habla de 4 carriles', () => {
  const pr = fs.readFileSync(YAML, 'utf8');
  const from = pr.indexOf('\n  - job: Suites');
  assert.ok(from >= 0, 'el pipeline tiene el job Suites');
  const next = pr.indexOf('\n  - job:', from + 1);
  const job = pr.slice(from, next < 0 ? undefined : next);
  const written = jobTops(job);
  assert.strictEqual(written.length, 1, `el job Suites trae UN tope propio (encontré ${written.length}: ${JSON.stringify(written)})`);
  assert.match(written[0], /^\d+$/, `y es un número a secas, sin comentario ni parámetro (encontré «${written[0]}»)`);
  const tops = written.map(Number);
  // cómo se cuenta, con casos de juguete: un segundo tope escrito de cualquier otra forma también cuenta
  for (const extra of ['timeoutInMinutes: 90 # sube', 'timeoutInMinutes : 90', 'timeoutInMinutes:  90', 'timeoutInMinutes: "90"', '"timeoutInMinutes": 90', 'timeoutInMinutes: ${{ parameters.tope }}']) {
    assert.strictEqual(jobTops(`\n  - job: Suites\n    ${extra}\n    strategy:\n    timeoutInMinutes: 40\n`).length, 2, `«${extra}» es un segundo tope`);
  }
  assert.deepStrictEqual(jobTops('\n  - job: Suites\n    timeoutInMinutes: 40\n    steps:\n      - script: x\n        timeoutInMinutes: 5\n'), ['40'], 'el tope de un paso no es el del job');
  assert.ok(tops[0] < 45, `el tope del job Suites (${tops[0]} min) es menor que los 45 de antes`);
  assert.ok(tops[0] >= 20, `y no baja de 20: menos que eso corta trabajos sanos (${tops[0]} min)`);
  assert.match(job, new RegExp(`45 → ${tops[0]} \\(2026-10-08`), 'la historia del tope, en el job, cuenta el cambio con su fecha');
  assert.match(job, /26,0 min[\s\S]*31,4/, 'y lo medido con que se decidió');
  assert.doesNotMatch(pr, /los 2 carriles de toda la organización/, 'ya no dice que la organización tiene 2 carriles');
  assert.match(pr, /4 carriles hospedados/, 'dice que son 4 carriles hospedados');
  assert.match(pr, /a una corrida le tocan 2 (carriles )?en la práctica/, 'y que a una corrida le tocan 2 en la práctica');
});

// ── Story 8.26, tanda C: la validación con un repo de GitHub como propio ────────────────────────────────────────────
/** Corre el paso que trae la foto (Validar). Devuelve el código, la salida y las dos carpetas donde la deja. */
function runFetch(dir, env) {
  const temp = path.join(dir, 'temp-fetch');
  const staging = path.join(dir, 'staging-fetch');
  for (const d of [temp, staging]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  const body = expand(stepBody(SNAPSHOT_STEP), { sources: path.join(dir, 'repo'), staging, temp });
  const r = bash(dir, body, 'fetch', env);
  return { ...r, temp: path.join(temp, 'snapshot'), staging: path.join(staging, 'snapshot') };
}
/** Un repo «privado» de juguete (el interno hasta el corte, el de mantenimiento después) con su foto y su lista. */
function privateRepo(dir, { photo = true, list = true } = {}) {
  const repo = path.join(dir, 'org', 'lab', '_git', 'private');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete env[k];
  const g = (...a) => spawnSync('git', a, { cwd: repo, env, encoding: 'utf8' });
  fs.mkdirSync(path.join(repo, 'scripts', 'nightly', 'dependencies'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'nightly', 'dependencies', 'repos.json'), '{"repos":[{"ruta":"Lab/A","ado":"LabProj/A"}]}\n');
  // la lista privada con que el freno de publicación mira el pedido (tanda F2): inventada, como todo acá
  if (list) {
    fs.mkdirSync(path.join(repo, 'scripts', 'publishing'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts', 'publishing', 'denylist.json'), GUARD_LIST);
  }
  if (photo) {
    fs.mkdirSync(path.join(repo, 'scripts', 'controls-bench'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts', 'controls-bench', 'ultimo-suites.json'), JSON.stringify({ ...FRESH_PHOTO(), failures: ['lab-red.test.sh'] }));
    fs.writeFileSync(path.join(repo, 'scripts', 'controls-bench', 'ultimo-banco.json'), JSON.stringify(TOY_BENCH()));
  }
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('-c', 'user.email=lab@lab', '-c', 'user.name=lab', 'commit', '-q', '-m', 'privado');
  return { SYSTEM_COLLECTIONURI: `file://${slash(path.join(dir, 'org'))}/`, HARNESS_PRIVATE_REPO: 'lab/_git/private', SYSTEM_ACCESSTOKEN: 'lab-token' };
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('T11 Validation_AzureSelf_SnapshotFromOriginMain_RegistryFromTheCheckout', { skip: NO_BASH }, () => {
  const dir = toy(SIX);
  fs.mkdirSync(path.join(dir, 'repo', 'scripts', 'nightly', 'dependencies'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'repo', 'scripts', 'nightly', 'dependencies', 'repos.json'), '{"repos":[]}\n');
  const r = runFetch(dir, { BUILD_REPOSITORY_PROVIDER: 'TfsGit' });
  assert.strictEqual(r.code, 0, r.out);
  for (const d of [r.temp, r.staging]) {
    assert.strictEqual(readJson(path.join(d, 'nightly-suites.json')).complete, true, `${d}: la foto de suites de origin/main`);
    assert.ok(readJson(path.join(d, 'nightly-bench.json')).results, `${d}: la del banco`);
    assert.deepStrictEqual(readJson(path.join(d, 'product-repos.json')), { repos: [] }, `${d}: la lista de productos del checkout`);
  }
  // sin foto en origin/main: no es rojo acá (el veredicto dirá «sin foto»), y se dice con texto fijo
  const none = toy(SIX, { photo: null });
  const n = runFetch(none, { BUILD_REPOSITORY_PROVIDER: 'TfsGit' });
  assert.strictEqual(n.code, 0, n.out);
  assert.match(n.out, /##vso\[task\.logissue type=warning\]no pude traer la foto nocturna/);
  assert.ok(!fs.existsSync(path.join(n.temp, 'nightly-suites.json')));
});

test('T11 Validation_GithubSelf_PrivateOnceOutsideTheCheckout_RedWithoutTheVariableOrTheRepo', { skip: NO_BASH }, () => {
  const dir = toy(SIX);
  const priv = privateRepo(dir);
  const r = runFetch(dir, { BUILD_REPOSITORY_PROVIDER: 'GitHub', ...priv });
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(readJson(path.join(r.temp, 'nightly-suites.json')).failures, ['lab-red.test.sh'], 'la foto del repo privado, no la de origin/main del árbol');
  assert.deepStrictEqual(readJson(path.join(r.staging, 'product-repos.json')).repos.map((x) => x.ruta), ['Lab/A'], 'y su lista de productos');
  assert.ok(!fs.existsSync(path.join(dir, 'repo', 'scripts', 'nightly')), 'nada de lo privado entra en el checkout');
  // sin la variable de la definición: rojo, no «sin foto»
  const noVar = runFetch(dir, { BUILD_REPOSITORY_PROVIDER: 'GitHub', ...priv, HARNESS_PRIVATE_REPO: '' });
  assert.notStrictEqual(noVar.code, 0, noVar.out);
  assert.match(noVar.out, /##vso\[task\.logissue type=error\]falta la variable HARNESS_PRIVATE_REPO/);
  // el repo privado no se deja leer: rojo, con texto fijo en el aviso (el error de git va en la línea común)
  const noRepo = runFetch(dir, { BUILD_REPOSITORY_PROVIDER: 'GitHub', ...priv, HARNESS_PRIVATE_REPO: 'lab/_git/no-such' });
  assert.notStrictEqual(noRepo.code, 0, noRepo.out);
  assert.match(noRepo.out, /##vso\[task\.logissue type=error\]no pude traer lo privado de la validación/);
  assert.ok(!noRepo.out.split('\n').some((l) => l.includes('##vso') && l.includes('no-such')), 'el aviso no nombra el repo');
  // un pedido desde una copia ajena (fork): rojo antes de traer nada (la segunda capa del AC 46; revisor de seguridad)
  const fork = runFetch(dir, { BUILD_REPOSITORY_PROVIDER: 'GitHub', ...priv, SYSTEM_PULLREQUEST_ISFORK: 'True' });
  assert.notStrictEqual(fork.code, 0, fork.out);
  assert.match(fork.out, /##vso\[task\.logissue type=error\]pedido desde una copia ajena/);
  assert.ok(!fs.existsSync(path.join(fork.temp, 'nightly-suites.json')), 'no trajo nada');
  // el repo privado sin la foto: no es rojo acá (el veredicto sale «sin foto»), se avisa
  const bare = toy(SIX);
  const noPhoto = runFetch(bare, { BUILD_REPOSITORY_PROVIDER: 'GitHub', ...privateRepo(bare, { photo: false }) });
  assert.strictEqual(noPhoto.code, 0, noPhoto.out);
  assert.match(noPhoto.out, /##vso\[task\.logissue type=warning\]no pude traer la foto nocturna/);
});

// ── Story 8.26, tanda F2 (AC 23): el freno de publicación sobre el pedido ──────────────────────────────────────────
// El paso REAL del YAML, con el freno de verdad copiado a un clon de juguete que hace de checkout del pedido. Lo único
// de mentira es quien lee el título y el cuerpo: el paso llama a `scripts/ci/pr-texts.js` de su checkout, y acá ese
// archivo es un doble que no sale a la red (el de verdad se mide contra una API de juguete en pr-texts.test.js).
const GUARD_STEP = 'El freno de publicación sobre el pedido';
const GUARD_TERM = 'Zorblax';   // inventado
const GUARD_LIST = `${JSON.stringify({ terminos: [{ patron: GUARD_TERM, categoria: 'cliente' }], permitidos: [] }, null, 2)}\n`;
const GUARD_PIECES = ['scripts/hooks/public-push-guard.js', 'scripts/lib/az-pr.js', 'scripts/lib/gh-pr.js', 'scripts/lib/harness-repo.js', 'scripts/lib/legacy-names.js',
  'scripts/lib/guard-record.js', 'scripts/publishing/detector.js', 'scripts/publishing/internal-history.js', 'scripts/setup/harness/tycon-home.js'];
const GUARD_WHO = { name: 'Mantenedor De Prueba', email: '4242+mantenedor@users.noreply.github.com' };
const TEXTS_STANDIN = [
  '#!/usr/bin/env node',
  '// doble de scripts/ci/pr-texts.js (pr-suites-shards.test.js): deja el título y el cuerpo que el caso le da por el entorno',
  "const fs = require('fs'); const path = require('path');",
  "const out = process.argv[process.argv.indexOf('--out') + 1];",
  "fs.writeFileSync(path.join(process.env.TOY_CALLS, 'pr-texts.args'), process.argv.slice(2).join(' '));",
  "if (process.env.TOY_TEXTS_FAIL) { process.stderr.write('pr-texts de juguete: no pude leer\\n'); process.exit(2); }",
  'fs.mkdirSync(out, { recursive: true });',
  "fs.writeFileSync(path.join(out, 'pr-title.txt'), process.env.TOY_TITLE || '');",
  "fs.writeFileSync(path.join(out, 'pr-body.txt'), process.env.TOY_BODY || '');",
  '',
].join('\n');

/** El checkout de un pedido, de juguete: `main` (y `origin/main`) con una base limpia, y el freno copiado adentro. */
function guardLab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-guard-'));
  toys.push(dir);
  const repo = path.join(dir, 'repo');
  for (const d of [repo, path.join(dir, 'home'), path.join(dir, 'calls')]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', HOME: path.join(dir, 'home') };
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete env[k];
  const git = (args, who = GUARD_WHO) => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8',
      env: { ...env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email } });
    assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  /** Un commit con SÓLO esos archivos (el freno copiado al clon no entra en ningún commit). `null` borra. */
  const commit = (files, message, who) => {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(repo, rel);
      if (content === null) { git(['rm', '--quiet', '--', rel]); continue; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      git(['add', '--', rel]);
    }
    git(['commit', '--quiet', '--allow-empty', '-m', message], who);
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '--quiet', '--initial-branch=main']);
  commit({ 'README.md': 'un repo de juguete\n' }, 'base');
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  for (const p of GUARD_PIECES) {
    fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, p), path.join(repo, p));
  }
  fs.mkdirSync(path.join(repo, 'scripts', 'ci'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'ci', 'pr-texts.js'), TEXTS_STANDIN);
  /** Una rama nueva desde main con esos commits; devuelve la punta. */
  const branch = (name, commits) => {
    git(['checkout', '--quiet', '-B', name, 'main']);
    let tip = null;
    for (const [files, message, who] of commits) tip = commit(files, message, who);
    return tip;
  };
  return { dir, repo, git, commit, branch, calls: path.join(dir, 'calls') };
}

/** Corre el paso del freno sobre el pedido cuya punta es `head`. `list`: si la lista llegó a la carpeta temporal. */
function runGuard(lab, head, env = {}, { list = true } = {}) {
  const temp = path.join(lab.dir, 'temp-guard');
  fs.rmSync(temp, { recursive: true, force: true });
  fs.rmSync(path.join(lab.calls, 'pr-texts.args'), { force: true });
  fs.mkdirSync(path.join(temp, 'private-list'), { recursive: true });
  if (list) fs.writeFileSync(path.join(temp, 'private-list', 'denylist.json'), GUARD_LIST);
  else fs.rmSync(path.join(temp, 'private-list'), { recursive: true, force: true });
  const body = expand(stepBody(GUARD_STEP), { sources: lab.repo, temp, base: 'origin/main' });
  const r = bash(lab.dir, body, 'guard', {
    BUILD_REPOSITORY_PROVIDER: 'GitHub', BUILD_REPOSITORY_NAME: 'acme/widgets', BUILD_REASON: 'PullRequest', BUILD_SOURCEBRANCH: 'refs/pull/12/merge',
    SYSTEM_PULLREQUEST_PULLREQUESTNUMBER: '12', SYSTEM_PULLREQUEST_SOURCECOMMITID: head, SYSTEM_PULLREQUEST_SOURCEBRANCH: 'una-rama',
    TOY_CALLS: lab.calls, TOY_TITLE: 'docs: una guía', TOY_BODY: 'Un cuerpo limpio.\n', TOY_TEXTS_FAIL: '', TYCON_PUBLISH_DENYLIST: '', TYCON_PUBLIC_PUSH_LIMIT_MS: '',
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', ...env,
  });
  const notices = r.out.split('\n').filter((l) => l.includes('##vso['));
  const texts = fs.existsSync(path.join(lab.calls, 'pr-texts.args')) ? fs.readFileSync(path.join(lab.calls, 'pr-texts.args'), 'utf8') : null;
  return { ...r, notices, texts, temp };
}
const guardRed = (r, notice, what) => {
  assert.strictEqual(r.code, 1, `${what}: el paso tenía que salir rojo\n${r.out}`);
  assert.strictEqual(r.notices.length, 1, `${what}: un solo aviso\n${r.out}`);
  assert.match(r.notices[0], notice, what);
  assert.ok(!r.out.toLowerCase().includes(GUARD_TERM.toLowerCase()), `${what}: la salida trae el término\n${r.out}`);
  assert.ok(!fs.existsSync(path.join(r.temp, 'private-list')), `${what}: la lista no queda en el disco al terminar el paso`);
};

test('T23 PrValidation_GuardOnEveryCommitBranchTitleBody_NoListIsRed_PublicNoticeFixed', { skip: NO_BASH }, () => {
  const lab = guardLab();
  const FOUND = /^##vso\[task\.logissue type=error\]freno de publicación: 1 cosa\(s\) de este pedido no pueden estar en el repo público — NO se mergea: cerrar el pedido, borrar la rama y pedir la purga/;
  // el gemelo verde, primero: un pedido limpio pasa, con su línea de cuentas, y sin ningún aviso
  const clean = lab.branch('limpia', [[{ 'guides/nueva.md': 'una guía limpia\n' }, 'docs: una guía']]);
  const ok = runGuard(lab, clean);
  assert.strictEqual(ok.code, 0, ok.out);
  assert.deepStrictEqual(ok.notices, []);
  assert.match(ok.out, /^public-push-guard: verdict=pass findings=0 commits=1 branch=1 title=1 body=1$/m);
  assert.match(ok.texts, /^--repo acme\/widgets --number 12 --out \S+pr-texts --credential-from \S+repo$/, 'le pide el título y el cuerpo de ESE pedido, con la credencial del checkout');
  assert.ok(!fs.existsSync(path.join(ok.temp, 'private-list')) && !fs.existsSync(path.join(ok.temp, 'pr-texts')), 'ni la lista ni los textos quedan en el disco');

  // el término sólo en un commit INTERMEDIO (el siguiente lo saca): la punta está limpia, la historia del pedido no
  const net = lab.branch('neta', [[{ 'scripts/a.js': `// para ${GUARD_TERM}\n` }, 'feat: primera versión'], [{ 'scripts/a.js': '// ya sin nada\n' }, 'feat: corregido']]);
  const middle = runGuard(lab, net);
  guardRed(middle, FOUND, 'un commit intermedio');
  assert.match(middle.out, /scripts\/a\.js:1 \(commit [0-9a-f]{10}\)/, 'el lugar, en una línea común del registro');
  assert.ok(!middle.notices[0].includes('scripts/a.js'), 'el aviso no lleva el lugar: sólo texto fijo y la cuenta');
  // en un mensaje · en el título · en el cuerpo · en el nombre de la rama
  const msg = lab.branch('mensaje', [[{ 'scripts/b.js': '// limpio\n' }, `fix: un arreglo\n\npara el caso de ${GUARD_TERM}`]]);
  guardRed(runGuard(lab, msg), FOUND, 'un mensaje');
  guardRed(runGuard(lab, clean, { TOY_TITLE: `docs: lo de ${GUARD_TERM}` }), FOUND, 'el título');
  guardRed(runGuard(lab, clean, { TOY_BODY: `Una línea.\nOtra, con ${GUARD_TERM}.\n` }), FOUND, 'el cuerpo');
  guardRed(runGuard(lab, clean, { SYSTEM_PULLREQUEST_SOURCEBRANCH: `refs/heads/feature/${GUARD_TERM.toLowerCase()}-x` }), FOUND, 'la rama');
  // un pedido de SÓLO documentación: el paso no mira si hay código
  const docs = lab.branch('docs', [[{ 'guides/nota.md': `una nota sobre ${GUARD_TERM}\n` }, 'docs: una nota']]);
  guardRed(runGuard(lab, docs), FOUND, 'sólo documentación');
  // el autor con un correo que no es `noreply`: identidad (y el correo no aparece en la salida)
  const who = lab.branch('autor', [[{ 'guides/c.md': 'limpio\n' }, 'docs: c', { name: 'Mantenedor De Prueba', email: 'alguien@example.com' }]]);
  const identity = runGuard(lab, who);
  guardRed(identity, /freno de publicación: 2 cosa\(s\)/, 'el autor y el committer');
  assert.ok(!identity.out.includes('alguien@example.com'));

  // 🔴 sin lista: rojo, con texto fijo — nunca «sin hallazgos»
  const NO_LOOK = /^##vso\[task\.logissue type=error\]freno de publicación: no pude mirar este pedido \(el motivo, en el registro de este paso\) — no medido no es verde$/;
  const blind = runGuard(lab, docs, {}, { list: false });
  guardRed(blind, NO_LOOK, 'sin lista');
  assert.match(blind.out, /sin la lista/);
  // …y una lista que la corrida trae en una variable NO reemplaza a la del paso (el paso fija de dónde sale)
  const elsewhere = path.join(lab.dir, 'otra-lista.json');
  fs.writeFileSync(elsewhere, `${JSON.stringify({ terminos: [{ patron: 'OtraCosa9', categoria: 'cliente' }], permitidos: [] })}\n`);
  guardRed(runGuard(lab, docs, { TYCON_PUBLISH_DENYLIST: elsewhere }), FOUND, 'con otra lista en el entorno, manda la del paso');
  // sin poder leer el título y el cuerpo: rojo, y el freno ni corre
  const unread = runGuard(lab, clean, { TOY_TEXTS_FAIL: '1' });
  guardRed(unread, /^##vso\[task\.logissue type=error\]freno de publicación: no pude leer el título y el cuerpo del pedido/, 'el título y el cuerpo no se pudieron leer');
  assert.ok(!/public-push-guard: verdict=/.test(unread.out));
  // una corrida de un pedido sin su número: no se puede saber qué título mirar
  guardRed(runGuard(lab, clean, { SYSTEM_PULLREQUEST_PULLREQUESTNUMBER: '' }), /la corrida es de un pedido y no sé su número/, 'un pedido sin número');
  // una base que git no conoce no es «un pedido sin commits»
  const temp = path.join(lab.dir, 'temp-guard');
  fs.mkdirSync(path.join(temp, 'private-list'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'private-list', 'denylist.json'), GUARD_LIST);
  const noBase = bash(lab.dir, expand(stepBody(GUARD_STEP), { sources: lab.repo, temp, base: 'origin/no-existe' }), 'guard-no-base', {
    BUILD_REPOSITORY_PROVIDER: 'GitHub', BUILD_REASON: 'Manual', BUILD_SOURCEBRANCH: 'refs/heads/limpia', SYSTEM_PULLREQUEST_PULLREQUESTNUMBER: '', SYSTEM_PULLREQUEST_SOURCECOMMITID: '',
    SYSTEM_PULLREQUEST_SOURCEBRANCH: '', TOY_CALLS: lab.calls, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', TYCON_PUBLIC_PUSH_LIMIT_MS: '' });
  assert.strictEqual(noBase.code, 1, noBase.out);
  assert.match(noBase.out, /##vso\[task\.logissue type=error\]freno de publicación: no pude mirar este pedido/);
});

test('T63 PrValidation_AzureSelfDoesNotJudge_UnknownProviderJudges_ManualRunLooksAtCommitsAndBranch', { skip: NO_BASH }, () => {
  const lab = guardLab();
  const dirty = lab.branch('sucia', [[{ 'guides/nota.md': `una nota sobre ${GUARD_TERM}\n` }, 'docs: una nota']]);
  // con el repo propio en Azure (el interno): «no aplica», 0, sin leer la lista ni pedir el título
  const azure = runGuard(lab, dirty, { BUILD_REPOSITORY_PROVIDER: 'TfsGit' });
  assert.strictEqual(azure.code, 0, azure.out);
  assert.match(azure.out, /freno de publicación: no aplica/);
  assert.deepStrictEqual(azure.notices, []);
  assert.strictEqual(azure.texts, null, 'no pidió el título ni el cuerpo');
  assert.ok(!/public-push-guard: verdict=/.test(azure.out), 'el freno no corrió');
  // 🔴 sólo ESE proveedor: vacío, o uno que no se conoce, se juzga (falla cerrado)
  for (const provider of ['', 'Bitbucket', 'tfsgit ', 'GitHubEnterprise', '$(Build.Repository.Provider)']) {
    const r = runGuard(lab, dirty, { BUILD_REPOSITORY_PROVIDER: provider });
    assert.strictEqual(r.code, 1, `«${provider}» tenía que juzgarse\n${r.out}`);
    assert.match(r.notices.join('\n'), /1 cosa\(s\) de este pedido/);
  }
  // una corrida a mano sobre una rama (no es un pedido): mira los commits y la rama, dice que no hubo título ni cuerpo
  const manual = { BUILD_REASON: 'Manual', BUILD_SOURCEBRANCH: 'refs/heads/sucia', SYSTEM_PULLREQUEST_PULLREQUESTNUMBER: '', SYSTEM_PULLREQUEST_SOURCECOMMITID: '', SYSTEM_PULLREQUEST_SOURCEBRANCH: '' };
  lab.git(['checkout', '--quiet', 'sucia']);
  const byHand = runGuard(lab, dirty, manual);
  assert.strictEqual(byHand.code, 1, byHand.out);
  assert.strictEqual(byHand.texts, null);
  assert.match(byHand.out, /guides\/nota\.md:1/);
  const clean = lab.branch('limpia', [[{ 'guides/otra.md': 'limpia\n' }, 'docs: otra']]);
  const cleanByHand = runGuard(lab, clean, { ...manual, BUILD_SOURCEBRANCH: 'refs/heads/limpia' });
  assert.strictEqual(cleanByHand.code, 0, cleanByHand.out);
  assert.match(cleanByHand.out, /sin título ni cuerpo que mirar/);
  assert.match(cleanByHand.out, /^public-push-guard: verdict=pass findings=0 commits=1 branch=1 title=0 body=0$/m);
  // …y el nombre de ESA rama se mira (sale de la corrida, no del pedido)
  lab.git(['branch', '-f', `feature/${GUARD_TERM.toLowerCase()}-y`, clean]);
  const named = runGuard(lab, clean, { ...manual, BUILD_SOURCEBRANCH: `refs/heads/feature/${GUARD_TERM.toLowerCase()}-y` });
  assert.strictEqual(named.code, 1, named.out);
  assert.match(named.out, /el nombre de la rama del pedido/);
  // los literales que Azure deja cuando una variable no existe no son un número de pedido ni una rama
  const literal = runGuard(lab, clean, { ...manual, BUILD_SOURCEBRANCH: 'refs/heads/limpia', SYSTEM_PULLREQUEST_PULLREQUESTNUMBER: '$(System.PullRequest.PullRequestNumber)',
    SYSTEM_PULLREQUEST_SOURCEBRANCH: '$(System.PullRequest.SourceBranch)', SYSTEM_PULLREQUEST_SOURCECOMMITID: '$(System.PullRequest.SourceCommitId)' });
  assert.strictEqual(literal.code, 0, literal.out);
  assert.strictEqual(literal.texts, null);
});

test('T63 PrValidation_WhatTheGuardSays_GoesToTheLogWithoutHashes_AndAVerdictWithoutItsCountLineIsRed', { skip: NO_BASH }, () => {
  const lab = guardLab();
  // 🔴 Una ruta del pedido la escribe quien lo abre, y el freno imprime el LUGAR de cada hallazgo: una ruta que trae una
  // orden de Azure (`##vso[…]`) no puede llegar al registro como una orden. Corriendo el paso, no leyendo el YAML.
  const order = 'docs/##vso[task.setvariable variable=hayCodigo]no.md';
  const tip = lab.branch('con-una-orden', [[{ [order]: `una nota sobre ${GUARD_TERM}\n` }, 'docs: una nota']]);
  const r = runGuard(lab, tip);
  guardRed(r, /freno de publicación: 1 cosa\(s\) de este pedido/, 'una ruta con una orden de Azure');
  assert.ok(r.out.includes('docs/♯♯vso[task.setvariable variable=hayCodigo]no.md:1'), `el lugar sale, con los # cambiados\n${r.out}`);
  assert.deepStrictEqual(r.out.split('\n').filter((l) => /##(vso)?\[/.test(l)), r.notices, 'la única línea que Azure puede leer como orden es el aviso fijo');

  // El paso no se fía del código de salida del freno: sin su línea de cuentas en verde, el pedido NO consta como mirado.
  // Se cambia el freno del checkout por uno que sale con lo que se le pida y dice lo que se le pida.
  const guardFile = path.join(lab.repo, 'scripts', 'hooks', 'public-push-guard.js');
  fs.writeFileSync(guardFile, "process.stdout.write(process.env.TOY_GUARD_OUT || ''); process.exit(Number(process.env.TOY_GUARD_RC || 0));\n");
  const clean = lab.branch('limpia', [[{ 'guides/nueva.md': 'una guía limpia\n' }, 'docs: una guía']]);
  const PASS = 'public-push-guard: verdict=pass findings=0 commits=1 branch=1 title=1 body=1\n';
  const fake = (rc, out) => runGuard(lab, clean, { TOY_GUARD_RC: String(rc), TOY_GUARD_OUT: out });
  const ok = fake(0, PASS);
  assert.strictEqual(ok.code, 0, `el control: con la línea de cuentas en verde, pasa\n${ok.out}`);
  const NOT_LOOKED = /^##vso\[task\.logissue type=error\]freno de publicación: el freno terminó sin su línea de cuentas — este pedido NO consta como mirado$/;
  for (const [what, out] of [['sin decir nada', ''], ['con otra cosa', 'todo bien\n'], ['con una línea de hallazgos', 'public-push-guard: verdict=findings findings=3 commits=1 branch=1 title=1 body=1\n'],
    ['con una línea de «no pude mirar»', 'public-push-guard: verdict=blind findings=0 commits=0 branch=0 title=0 body=0\n'], ['con la línea en verde y después otra', `${PASS}public-push-guard: verdict=blind findings=0 commits=0 branch=0 title=0 body=0\n`]]) {
    const x = fake(0, out);
    assert.strictEqual(x.code, 1, `el freno salió 0 ${what}: el paso tenía que salir rojo\n${x.out}`);
    assert.strictEqual(x.notices.length, 1, x.out);
    assert.match(x.notices[0], NOT_LOOKED, what);
  }
  // el título y el cuerpo: en un pedido tienen que constar como mirados. Un freno que pasa sin haberlos mirado no miró
  // lo que el paso le pidió; en una corrida a mano (sin pedido) lo que consta es que no los había
  const NOT_READ = 'public-push-guard: verdict=pass findings=0 commits=1 branch=1 title=0 body=0\n';
  for (const [what, out] of [['sin el título ni el cuerpo', NOT_READ], ['sin el cuerpo', 'public-push-guard: verdict=pass findings=0 commits=1 branch=1 title=1 body=0\n'],
    // …y el nombre de la rama, que en un pedido también es texto publicado (figura en su página)
    ['sin el nombre de la rama', 'public-push-guard: verdict=pass findings=0 commits=1 branch=0 title=1 body=1\n'], ['con la línea de antes, sin el campo de la rama', 'public-push-guard: verdict=pass findings=0 commits=1 title=1 body=1\n']]) {
    const x = fake(0, out);
    assert.strictEqual(x.code, 1, `un pedido «mirado» ${what}: rojo\n${x.out}`);
    assert.match(x.notices[0], NOT_LOOKED, what);
  }
  const byHand = { BUILD_REASON: 'Manual', BUILD_SOURCEBRANCH: 'refs/heads/limpia', SYSTEM_PULLREQUEST_PULLREQUESTNUMBER: '', SYSTEM_PULLREQUEST_SOURCECOMMITID: '', SYSTEM_PULLREQUEST_SOURCEBRANCH: '' };
  assert.strictEqual(runGuard(lab, clean, { ...byHand, TOY_GUARD_RC: '0', TOY_GUARD_OUT: NOT_READ }).code, 0, 'a mano, sin título ni cuerpo que mirar, eso es verde');
  assert.strictEqual(runGuard(lab, clean, { ...byHand, TOY_GUARD_RC: '0', TOY_GUARD_OUT: PASS }).code, 1, 'y a mano, una línea que dice haber mirado un título que no hay no cierra');
  // 🔴 un pedido sin su commit: no se cae a HEAD (ahí HEAD es el merge de prueba que arma GitHub, que no es del pedido)
  for (const env of [{ SYSTEM_PULLREQUEST_SOURCECOMMITID: '' }, { SYSTEM_PULLREQUEST_SOURCECOMMITID: '$(System.PullRequest.SourceCommitId)' }, { SYSTEM_PULLREQUEST_SOURCECOMMITID: '', SYSTEM_PULLREQUEST_PULLREQUESTNUMBER: '' }]) {
    const x = runGuard(lab, clean, { ...env, TOY_GUARD_RC: '0', TOY_GUARD_OUT: PASS });
    assert.strictEqual(x.code, 1, `${JSON.stringify(env)}\n${x.out}`);
    assert.match(x.notices[0], /^##vso\[task\.logissue type=error\]freno de publicación: la corrida es de un pedido y no sé cuál es su commit/);
    assert.strictEqual(x.texts, null, 'ni pide el título: frena antes');
  }
  // 🔴 un pedido sin el nombre de su rama (la variable vacía, o el literal que Azure deja cuando no existe): tampoco se
  // sale verde — ese nombre figura en la página del pedido, y sin él quedaría sin mirar y nadie lo diría (pase
  // adversarial de la tanda F2). Aunque el freno diga que pasó.
  for (const branch of ['', '$(System.PullRequest.SourceBranch)']) {
    const x = runGuard(lab, clean, { SYSTEM_PULLREQUEST_SOURCEBRANCH: branch, TOY_GUARD_RC: '0', TOY_GUARD_OUT: PASS });
    assert.strictEqual(x.code, 1, `un pedido con la rama «${branch}»\n${x.out}`);
    assert.match(x.notices[0], /^##vso\[task\.logissue type=error\]freno de publicación: la corrida es de un pedido y no sé el nombre de su rama/);
    assert.strictEqual(x.texts, null, 'ni pide el título: frena antes');
  }
  // a mano sobre algo que no es una rama (una marca): no hay nombre de rama que mirar, y la línea de cuentas lo dice
  const onATag = { ...byHand, BUILD_SOURCEBRANCH: 'refs/tags/v1' };
  assert.strictEqual(runGuard(lab, clean, { ...onATag, TOY_GUARD_RC: '0', TOY_GUARD_OUT: 'public-push-guard: verdict=pass findings=0 commits=1 branch=0 title=0 body=0\n' }).code, 0, 'a mano y sin rama: verde con branch=0');
  assert.strictEqual(runGuard(lab, clean, { ...onATag, TOY_GUARD_RC: '0', TOY_GUARD_OUT: NOT_READ }).code, 1, 'una línea que dice haber mirado una rama que no se le pasó no cierra');
  // con hallazgos (1): la cuenta sale de la línea de cuentas, y sólo si son cifras; si no, «?» — nunca otro texto
  assert.match(fake(1, 'public-push-guard: verdict=findings findings=3 commits=1 branch=1 title=1 body=1\n').notices[0], /freno de publicación: 3 cosa\(s\) de este pedido/);
  for (const out of ['', 'public-push-guard: verdict=findings findings=muchas commits=1\n', 'public-push-guard: verdict=findings findings=3; rm -rf x commits=1\n', 'findings=7\n']) {
    const x = fake(1, out);
    assert.strictEqual(x.code, 1, x.out);
    assert.match(x.notices[0], /^##vso\[task\.logissue type=error\]freno de publicación: \? cosa\(s\) de este pedido no pueden estar/, `«${out.trim()}»`);
  }
  // cualquier otro código (2, uno de una señal): «no pude mirar», aunque el freno haya dicho que pasó
  for (const rc of [2, 3, 137]) {
    const x = fake(rc, PASS);
    assert.strictEqual(x.code, 1, x.out);
    assert.match(x.notices[0], /^##vso\[task\.logissue type=error\]freno de publicación: no pude mirar este pedido/, `código ${rc}`);
  }
});

test('T23 PrValidation_TheStepRunsAlways_InValidar_AndTheListNeverReachesAnArtifact', { skip: NO_BASH }, () => {
  const all = jobs();
  const validar = all.Validar;
  // en el trabajo que corre siempre, sin condición, después de traer lo privado y antes del lint
  const at = validar.indexOf(`displayName: '${GUARD_STEP}'`);
  assert.ok(at > 0, 'el paso está en Validar');
  for (const name of ['Bench', 'Suites', 'Verdict']) assert.ok(!all[name].includes(GUARD_STEP), `${name} no lo repite`);
  assert.match(validar, new RegExp(`\\n {8}displayName: '${GUARD_STEP}'\\n\\n`), 'sin `condition:` ni ninguna otra clave: corre siempre');
  assert.ok(validar.indexOf('/pipelines/templates/fetch-snapshot.yml') < at, 'después de «La foto nocturna y lo privado»: de ahí sale la lista');
  assert.ok(at < validar.indexOf("displayName: 'Controles de lint (siempre)'"), 'antes del lint');
  assert.doesNotMatch(stepBody(GUARD_STEP), /hayCodigo|todoElRepo/, 'no depende de que el cambio traiga código');
  // de dónde sale la lista: una carpeta temporal del trabajo, que el paso borra al terminar
  assert.match(stepBody(GUARD_STEP), /LISTDIR="\$\(Agent\.TempDirectory\)\/private-list"/);
  assert.match(stepBody(GUARD_STEP), /trap 'rm -rf "\$LISTDIR" "\$TEXTS"' EXIT/);
  assert.match(stepBody(GUARD_STEP), /TYCON_PUBLISH_DENYLIST="\$LISTDIR\/denylist\.json" node scripts\/hooks\/public-push-guard\.js range /);
  // 🔴 la lista no figura en ningún artefacto: ningún `publish` de la validación nombra esa carpeta ni la temporal
  const live = (s) => s.split('\n').filter((l) => !l.trim().startsWith('#'));
  const publishes = [...live(text), ...live(template), ...live(snapshotTemplate)].filter((l) => /^\s*-?\s*(publish|targetPath|PathtoPublish|artifact):/.test(l) || /PublishPipelineArtifact|PublishBuildArtifacts/.test(l));
  assert.ok(publishes.length >= 3, 'la prueba encuentra los `publish` de la validación');
  for (const l of publishes) assert.doesNotMatch(l, /private-list|Agent\.TempDirectory/, `un artefacto no sale de la carpeta temporal: ${l.trim()}`);
  for (const file of [text, template, snapshotTemplate]) assert.doesNotMatch(file.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), /(cp|mv)[^\n]*denylist[^\n]*\$OUT|\$OUT[^\n]*denylist/, 'la lista no se copia a la carpeta que se publica');

  // y corriendo el paso que la trae: con GitHub como propio queda en la carpeta temporal y NO en la que se publica
  const dir = toy(SIX);
  const r = runFetch(dir, { BUILD_REPOSITORY_PROVIDER: 'GitHub', ...privateRepo(dir) });
  assert.strictEqual(r.code, 0, r.out);
  const brought = path.join(dir, 'temp-fetch', 'private-list', 'denylist.json');
  assert.strictEqual(fs.readFileSync(brought, 'utf8'), GUARD_LIST, 'la lista del repo privado, en la carpeta temporal del trabajo');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const published of [...walk(r.staging), ...walk(r.temp)]) {
    assert.ok(!/denylist/.test(published), `${published}: la lista no va con la foto`);
    assert.ok(!fs.readFileSync(published, 'utf8').includes(GUARD_TERM), `${published}: nada de la lista en lo que se publica`);
  }
  assert.ok(!r.out.includes(GUARD_TERM), 'ni en el registro del paso');
  // el repo privado sin la lista: se avisa acá (texto fijo), y el paso del freno saldrá rojo
  const bare = toy(SIX);
  const none = runFetch(bare, { BUILD_REPOSITORY_PROVIDER: 'GitHub', ...privateRepo(bare, { list: false }) });
  assert.strictEqual(none.code, 0, none.out);
  assert.match(none.out, /##vso\[task\.logissue type=warning\]no pude traer la lista privada: el freno de publicación sobre el pedido va a salir rojo/);
  assert.ok(!fs.existsSync(path.join(bare, 'temp-fetch', 'private-list')), 'sin lista no queda una carpeta vacía que parezca una');
  // una lista de un intento anterior no sobrevive a una corrida que no la trajo; y con Azure como propio no se trae
  const stale = toy(SIX);
  fs.mkdirSync(path.join(stale, 'repo', 'scripts', 'nightly', 'dependencies'), { recursive: true });
  fs.writeFileSync(path.join(stale, 'repo', 'scripts', 'nightly', 'dependencies', 'repos.json'), '{"repos":[]}\n');
  const azure = runFetch(stale, { BUILD_REPOSITORY_PROVIDER: 'TfsGit' });
  assert.strictEqual(azure.code, 0, azure.out);
  assert.ok(!fs.existsSync(path.join(stale, 'temp-fetch', 'private-list')));
});

test('T43 Validation_OneSnapshotFourReaders_EveryJobUsesWhatValidarBrought', () => {
  const all = jobs();
  // la trae Validar, una vez, y la publica; los otros tres la bajan
  assert.match(all.Validar, /- template: \/pipelines\/templates\/fetch-snapshot\.yml\n\s+parameters:\n\s+step: fetch\n/, 'Validar trae la foto');
  for (const name of ['Bench', 'Suites', 'Verdict']) {
    assert.match(all[name], /- template: \/pipelines\/templates\/fetch-snapshot\.yml\n\s+parameters:\n\s+step: download\n/, `${name} baja la que trajo Validar`);
  }
  assert.match(snapshotTemplate, /artifact: 'snapshot-a\$\(System\.JobAttempt\)'/, 'se publica con el intento en el nombre');
  const live = (s) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  // los cuatro lectores: ninguno lee la del checkout ni le pregunta a git
  assert.ok(stepBody(PLAN_STEP).includes('FOTO="$(Agent.TempDirectory)/snapshot/nightly-suites.json"'), 'la red de --deps');
  assert.ok(live(stepBody(RUN_STEP)).includes('"$(Agent.TempDirectory)/snapshot/nightly-suites.json"'), 'las rojas de anoche que no se reintentan');
  assert.ok(stepBody(JOIN_STEP).includes('--previous "$(Agent.TempDirectory)/snapshot/nightly-suites.json"'), 'la comparación del reporte');
  for (const flag of ['--suites-snapshot "$(Agent.TempDirectory)/snapshot/nightly-suites.json"', '--bench-snapshot "$(Agent.TempDirectory)/snapshot/nightly-bench.json"']) {
    assert.ok(stepBody(VERDICT_STEP).includes(flag), `el veredicto: ${flag}`);
  }
  for (const s of [PLAN_STEP, RUN_STEP, JOIN_STEP, VERDICT_STEP]) {
    assert.doesNotMatch(live(stepBody(s)), /scripts\/controls-bench\/ultimo-/, `${s}: no lee la foto del checkout ni de origin/main`);
  }
  // los repos de los productos, con la lista que trajo Validar (en el árbol público no está)
  for (const name of ['Bench', 'Suites']) {
    assert.match(all[name], /fetch-repos\.yml\n\s+parameters:\n(?:\s+\w+: .*\n)*\s+productRegistry: '\$\(Agent\.TempDirectory\)\/snapshot\/product-repos\.json'\n/, `${name}: la lista de productos que trajo Validar`);
  }
});

test('T43 Validation_PickStep_TakesTheHighestAttempt_SaysWhenNothingArrived', { skip: NO_BASH }, () => {
  const dir = toy(SIX);
  const ws = workspace(dir);
  for (const [a, v] of [['snapshot-a1', 'uno'], ['snapshot-a2', 'dos']]) {
    fs.mkdirSync(path.join(ws, 'snapshot', a), { recursive: true });
    fs.writeFileSync(path.join(ws, 'snapshot', a, 'nightly-suites.json'), JSON.stringify({ intento: v }));
    fs.writeFileSync(path.join(ws, 'snapshot', a, 'fetched.txt'), 'nightly-suites.json\n');
  }
  const temp = path.join(dir, 'temp-pick');
  fs.mkdirSync(temp, { recursive: true });
  const step = expand(stepBody(SNAPSHOT_PICK_STEP), { sources: path.join(dir, 'repo'), temp, workspace: ws });
  const r = bash(dir, step, 'pick');
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(readJson(path.join(temp, 'snapshot', 'nightly-suites.json')).intento, 'dos', 'la del intento más alto');
  fs.rmSync(path.join(ws, 'snapshot'), { recursive: true, force: true });
  fs.rmSync(path.join(temp, 'snapshot'), { recursive: true, force: true });
  const none = bash(dir, step, 'pick-none');
  assert.strictEqual(none.code, 0, none.out);
  assert.match(none.out, /##vso\[task\.logissue type=warning\]no llegó la foto que trajo Validar/);
});

test('T43 Verdict_NoSnapshotArrived_IsUndecidedNotGreen', { skip: NO_BASH }, () => {
  const dir = toy([['lab-green-a.test.sh', GREEN_SH]]);
  const plan = runPlan(dir, maxShards());
  for (let i = 1; i <= plan.of; i += 1) runShard(dir, i, plan.of);
  publishBench(dir);
  const v = runVerdict(dir, plan.matrix, {}, { suites: null, bench: null });
  assert.strictEqual(v.verdict.code, 2, v.verdict.out);
  assert.match(v.verdict.out, /no pude decidir: sin foto/);
});

test('T14 Verdict_Switch_OnBlocksNewSuiteRed_OffWarns_DefaultByProvider', { skip: NO_BASH }, () => {
  const dir = toy([['lab-green-a.test.sh', GREEN_SH], ['lab-red.test.sh', RED_SH]]);
  const plan = runPlan(dir, maxShards());
  for (let i = 1; i <= plan.of; i += 1) runShard(dir, i, plan.of);
  publishBench(dir);
  // la foto sin rojas: lab-red es un rojo NUEVO de suite
  const cases = [
    ['la 170 sin interruptor: aviso', { BUILD_REPOSITORY_PROVIDER: 'TfsGit' }, 0],
    ['GitHub sin interruptor: frena (falla cerrado)', { BUILD_REPOSITORY_PROVIDER: 'GitHub' }, 1],
    ['la 170 con el interruptor prendido: frena', { BUILD_REPOSITORY_PROVIDER: 'TfsGit', HARNESS_SUITES_BLOCK: '1' }, 1],
    ['GitHub con el interruptor apagado: aviso', { BUILD_REPOSITORY_PROVIDER: 'GitHub', HARNESS_SUITES_BLOCK: 'false' }, 0],
  ];
  for (const [what, env, code] of cases) {
    const v = runVerdict(dir, plan.matrix, env);
    assert.strictEqual(v.verdict.code, code, `${what}\n${v.verdict.out}`);
    if (code === 0) assert.match(v.verdict.out, /##vso\[task\.logissue type=warning\]suites en modo aviso por interruptor/, `${what}: lo dice`);
    else assert.match(v.verdict.out, /ROJO NUEVO/, what);
  }
});

test('T14 SuitesBlock_ValuesAndDefault_UnknownValueFailsClosed', () => {
  const ask = (env) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'suites-block.js')], {
    encoding: 'utf8', env: { ...process.env, HARNESS_SUITES_BLOCK: '', BUILD_REPOSITORY_PROVIDER: '', ...env } });
  const cases = [
    [{}, 'off'], [{ BUILD_REPOSITORY_PROVIDER: 'TfsGit' }, 'off'], [{ BUILD_REPOSITORY_PROVIDER: 'GitHub' }, 'on'],
    [{ HARNESS_SUITES_BLOCK: 'on' }, 'on'], [{ HARNESS_SUITES_BLOCK: 'TRUE' }, 'on'], [{ HARNESS_SUITES_BLOCK: '1' }, 'on'],
    [{ HARNESS_SUITES_BLOCK: '0', BUILD_REPOSITORY_PROVIDER: 'GitHub' }, 'off'], [{ HARNESS_SUITES_BLOCK: 'off' }, 'off'],
    // Azure deja el literal si la variable no existe y se la nombró como macro: no es un valor, cuenta como sin interruptor
    [{ HARNESS_SUITES_BLOCK: '$(HARNESS_SUITES_BLOCK)', BUILD_REPOSITORY_PROVIDER: 'GitHub' }, 'on'],
  ];
  for (const [env, want] of cases) {
    const r = ask(env);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), want, JSON.stringify(env));
  }
  const odd = ask({ HARNESS_SUITES_BLOCK: 'quizás' });
  assert.strictEqual(odd.stdout.trim(), 'on', 'un valor que no se entiende frena: falla cerrado');
  assert.match(odd.stderr, /no entiendo/);
});

test('T11 Validation_JoinPassesBothRegistries_NotTravellingNamedInTheVerdict', { skip: NO_BASH }, () => {
  const join = stepBody(JOIN_STEP);
  assert.ok(join.includes('REG=(--registry "$(Build.SourcesDirectory)/scripts/tests/suites.json" --registry "$BASE_REGISTRY")'), 'el registro de la rama y el de main, juntos');
  // corrido: la foto nombra una suite que ningún registro trae
  const dir = toy([['lab-green-a.test.sh', GREEN_SH]]);
  const plan = runPlan(dir, maxShards());
  for (let i = 1; i <= plan.of; i += 1) runShard(dir, i, plan.of);
  publishBench(dir);
  const v = runVerdict(dir, plan.matrix, {}, { suites: { ...FRESH_PHOTO(), ran: ['lab-green-a.test.sh', 'lab-maintainers.test.sh'] } });
  assert.strictEqual(v.join.code, 0, v.join.out);
  assert.deepStrictEqual(v.report.notTravelling, ['lab-maintainers.test.sh'], v.join.out);
  assert.match(v.verdict.out, /no corrió: no viaja — lab-maintainers\.test\.sh/);
  assert.strictEqual(v.verdict.code, 0, v.verdict.out);
  // sin el registro de main no se da nada por «no viaja» (una suite que el cambio borró no se disfraza): sale desaparecida
  fs.writeFileSync(path.join(dir, 'no-main-registry'), '');
  const blind = runVerdict(dir, plan.matrix, {}, { suites: { ...FRESH_PHOTO(), ran: ['lab-green-a.test.sh', 'lab-maintainers.test.sh'] } });
  assert.strictEqual(blind.join.code, 0, blind.join.out);
  assert.match(blind.join.out, /no pude leer el registro de suites de origin\/main: ninguna suite se da por «no viaja»/);
  assert.deepStrictEqual([blind.report.notTravelling, blind.report.disappeared], [undefined, ['lab-maintainers.test.sh']], blind.join.out);
});
