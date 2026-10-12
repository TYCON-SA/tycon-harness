#!/usr/bin/env node
'use strict';
/**
 * pipeline-skeleton.js — el esqueleto mecánico del pipeline de stories, sobre un repo de ejemplo de Node, con la
 * instalación que dejó el paso `install` (story 8.17, tanda W6 · AC 49, T74).
 *
 * POR QUÉ EXISTE. Instalar el arnés en Windows no alcanza: lo que el equipo usa todos los días es el pipeline de
 * stories, y sus guiones se escribieron en una Mac. La máquina limpia de Linux ya corre su esqueleto mecánico (T27 de
 * `scripts/tests/clean-machine/scenarios/core.sh`); este paso corre los mismos cinco, con las mismas expectativas,
 * en el agente Windows:
 *   lint         `lint-story-frontmatter.js` sobre la story del repo de ejemplo                      → sale 0
 *   start        `pipeline.js start --story … --repo …`                                             → sale 0 con ready: true
 *   mech-check   `pipeline.js mech-check`                                                           → sale 0 sin CRITICAL
 *   advisors     `pipeline.js advisors --files src/greeting.js test/greeting.test.js`               → sale 0, sin paquetes
 *                                                                                                    ni revisores del paquete
 *   test-gate    `test-gate.sh <repo> <story>`, con el bash de Git (`findGitBash()`)               → sale 0 y deja
 *                                                                                                    tests-result.json:
 *                                                                                                    node-test, todo verde
 * Los guiones salen de la instalación (el enlace `~/.claude/agent-skills` y el lugar del arnés, `place.js`, de la
 * carpeta de usuario de laboratorio), como los llama el pipeline; el repo de ejemplo es el de la máquina limpia
 * (`scripts/tests/fixtures/example-repo`), armado como ahí: la story en `specs/`, rama `story/1.1` y un commit.
 *
 * CÓMO FALLA. Cada paso que no sale como en Linux es un HALLAZGO con su nombre (`skeleton:<paso>`), con su salida y
 * su código. «No medido»: no hay instalación (el paso `install` no dejó ninguna) o la copia no trae el pipeline de
 * stories. «Error»: no se pudo armar el repo de ejemplo, o la carpeta de usuario no es la del laboratorio.
 * Nada corre contra la carpeta de usuario real: el ambiente es el del laboratorio (`lab.js`, `labEnv`).
 *
 * Uso: node scripts/tests/windows/pipeline-skeleton.js --lab <laboratorio> --out <carpeta del reporte>
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');
const PLACE = require('../../setup/harness/place.js');   // el lugar del arnés y su nombre viejo (story 8.19)

const NAME = 'pipeline-skeleton';
const CHECKS = Object.freeze(['lint', 'start', 'mech-check', 'advisors', 'test-gate']);
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'example-repo');
const GIT_BASH = path.join(__dirname, '..', '..', 'lib', 'git-bash.js');
const STORY_REL = path.join('specs', 'story-1.1-greeting.md');
const FILES = ['src/greeting.js', 'test/greeting.test.js'];
const PARSE_CAP = 8 * 1024 * 1024;   // lo que se lee para entender un JSON; en el reporte va recortado
const KEEP_CAP = 1500;
const MINUTES = 60 * 1000;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const parse = (text) => { try { return JSON.parse(text); } catch (_) { return null; } };
// para bash, en Windows, la ruta con barras `/`: el bash de Git las lee igual y no hay escapes que perder
const forBash = (p, platform) => (L.isWin(platform) ? String(p).replace(/\\/g, '/') : p);

/** El repo de ejemplo, como `make_example_repo` de la máquina limpia. `null` si quedó, o el motivo. */
function makeExampleRepo(dir, env) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
    for (const part of ['package.json', 'src', 'test']) fs.cpSync(path.join(FIXTURE, part), path.join(dir, part), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE, 'story-1.1.md.tpl'), path.join(dir, STORY_REL));
  } catch (e) { return `no pude copiar el repo de ejemplo (${FIXTURE}): ${e.code || e.message}`; }
  const git = ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', '-c', 'commit.gpgsign=false'];
  for (const args of [['init', '-q'], ['checkout', '-q', '-b', 'story/1.1'], ['add', '-A'], ['commit', '-q', '-m', 'el repo de ejemplo']]) {
    const r = L.run('git', [...git, ...args], { cwd: dir, env, timeoutMs: MINUTES });
    if (r.error || r.exit !== 0) return `git ${args[0]} salió ${r.error || r.exit}: ${L.firstLine(r.stderr) || L.firstLine(r.stdout)}`;
  }
  return null;
}

/** Lo que queda de un paso: su código, si salió como en Linux y por qué no, y su salida recortada. */
function record(r, ok, why) {
  return { exit: r.exit, error: r.error, ok: Boolean(ok), why: ok ? null : (why || null), ms: r.ms, stdout: L.clip(r.stdout, KEEP_CAP), stderr: L.clip(r.stderr, KEEP_CAP) };
}

/** Un hallazgo por cada paso que no salió como en Linux, o que no corrió. Función pura. */
function findingsOf(checks) {
  const out = [];
  for (const name of CHECKS) {
    const c = checks[name];
    if (!c) { out.push({ id: `skeleton:${name}:not-run`, kind: 'pipeline-skeleton', detail: `${name}: no corrió`, closes: 'W6' }); continue; }
    if (!c.ok) out.push({ id: `skeleton:${name}`, kind: 'pipeline-skeleton', detail: `${name} salió ${c.error || c.exit}${c.why ? ` — ${c.why}` : ''}`, closes: 'W6' });
  }
  return out;
}

/** Los cinco pasos sobre el repo de ejemplo. Devuelve `{ checks, testsResult }`. */
function runChecks({ pipe, harness, repo, env, platform, gitBash }) {
  const story = path.join(repo, STORY_REL);
  const node = (args, timeoutMs = 5 * MINUTES) => L.run(process.execPath, args, { cwd: repo, env, timeoutMs, cap: PARSE_CAP });
  const checks = {};

  let r = node([path.join(harness, 'scripts', 'lib', 'lint-story-frontmatter.js'), story], 2 * MINUTES);
  checks.lint = record(r, r.exit === 0, L.firstLine(r.stderr) || L.firstLine(r.stdout));

  r = node([path.join(pipe, 'pipeline.js'), 'start', '--story', story, '--repo', repo]);
  let d = parse(r.stdout);
  checks.start = record(r, r.exit === 0 && d && d.ready === true, d ? `ready: ${d.ready}; ${JSON.stringify(d.pauses || d.error || null).slice(0, 300)}` : 'la salida no es JSON');

  r = node([path.join(pipe, 'pipeline.js'), 'mech-check', '--repo', repo, '--story', story]);
  d = parse(r.stdout);
  const critical = d ? (d.findings || []).filter((f) => f.severity === 'CRITICAL') : null;
  checks['mech-check'] = record(r, r.exit === 0 && critical && critical.length === 0, critical ? `${critical.length} CRITICAL: ${critical.map((f) => `${f.rule} ${f.detail || ''}`).join(' · ').slice(0, 300)}` : 'la salida no es JSON');

  r = node([path.join(pipe, 'pipeline.js'), 'advisors', '--repo', repo, '--story', story, '--files', ...FILES]);
  d = parse(r.stdout);
  // `tycon-plugin-tests-coverage` y `tycon-plugin-security-basics` son del núcleo: los del paquete son los `-conventions`
  const packReviewers = d ? (d.all || []).filter((a) => /^tycon-plugin-.*-conventions$/.test(a)) : null;
  const packs = d && Array.isArray(d.packs) ? d.packs : null;
  checks.advisors = record(r, r.exit === 0 && packs && packs.length === 0 && packReviewers.length === 0, d ? `paquetes: ${packs ? packs.length : 'sin lista'}; revisores del paquete: ${(packReviewers || []).join(',') || 'ninguno'}` : 'la salida no es JSON');

  let testsResult = null;
  if (!gitBash.path) {
    checks['test-gate'] = { exit: null, error: 'sin-bash', ok: false, why: `no hay bash de Git: ${gitBash.reason}`, ms: 0, stdout: '', stderr: '' };
  } else {
    const resultFile = path.join(repo, '.advisors', 'tests-result.json');
    fs.rmSync(resultFile, { force: true });
    r = L.run(gitBash.path, [forBash(path.join(pipe, 'test-gate.sh'), platform), forBash(repo, platform), forBash(story, platform)], { cwd: repo, env, timeoutMs: 15 * MINUTES, cap: PARSE_CAP });
    try { const t = readJson(resultFile); testsResult = { runner: t.runner, suite_green: t.suite_green, totals: t.totals || null }; } catch (_) { testsResult = null; }
    const tt = testsResult && testsResult.totals;
    const allGreen = Boolean(testsResult && testsResult.runner === 'node-test' && testsResult.suite_green === true && tt && tt.total > 0 && tt.passed === tt.total && tt.failed === 0);
    checks['test-gate'] = record(r, r.exit === 0 && allGreen, testsResult ? `tests-result.json dice «${[testsResult.runner, testsResult.suite_green, JSON.stringify(tt)].join('|')}» (esperado node-test, verde, todas pasan)` : `no quedó tests-result.json; ${L.firstLine(r.stderr) || L.firstLine(r.stdout)}`);
  }
  return { checks, testsResult };
}

function measure({ lab, platform = process.platform, baseEnv = process.env, rec }) {
  let state;
  try { state = readJson(path.join(lab, 'lab-state.json')); } catch (_) { state = null; }
  const variant = state && state.measured_variant;
  if (!variant) return { status: L.STATUS.notMeasured, reason: 'ninguna instalación dejó con qué correr el pipeline de stories (ver el paso install)' };
  const problem = L.labHomeProblem(variant.home, { labRoot: lab, platform, allowTemp: Boolean(state.allow_temp) });
  if (problem) return { status: L.STATUS.error, reason: `no pude medir: ${problem}` };
  if (!variant.clone || !fs.existsSync(path.join(variant.clone, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js'))) {
    return { status: L.STATUS.notMeasured, reason: 'la copia instalada no trae el pipeline de stories (skills/tycon-pipeline): no hay esqueleto que correr' };
  }
  let cover = {};
  try { cover = L.readCover(variant.clone, { fence: 'bash' }) || {}; } catch (_) { cover = {}; }
  rec.setRedactor(L.redactor({ publicUrl: cover.url, secrets: L.secretValues(baseEnv) }));

  // los guiones, por los enlaces que deja el instalador, como los llama el pipeline; sin enlace, desde el clon (y se anota)
  const claude = path.join(variant.home, '.claude');
  let pipe = path.join(claude, 'agent-skills', 'skills', 'tycon-pipeline', 'scripts');
  if (!fs.existsSync(path.join(pipe, 'pipeline.js'))) { rec.note('no está el enlace ~/.claude/agent-skills: el esqueleto corre desde el clon'); pipe = path.join(variant.clone, 'skills', 'tycon-pipeline', 'scripts'); }
  // primero el lugar, después el nombre viejo (una instalación anterior a la 8.19 sólo tiene ése)
  let harness = [PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME].map((n) => path.join(claude, n))
    .find((h) => fs.existsSync(path.join(h, 'scripts', 'lib', 'lint-story-frontmatter.js')));
  if (!harness) { rec.note(`no está el lugar ~/.claude/${PLACE.PLACE_NAME}: el lint corre desde el clon`); harness = variant.clone; }

  const env = L.labEnv(variant.home, { base: baseEnv, extra: Object.assign({}, variant.env || {}, { TYCON_SESSION_ID: 'windows-pipeline-skeleton' }), platform });
  L.setEnv(env, 'CLAUDE_CODE_SESSION_ID', null);   // la sesión de quien lanza no es la del laboratorio
  // Lanzado desde `node --test` (la prueba de este paso), el `node --test` del repo de ejemplo heredaría la marca del
  // corredor de afuera y le hablaría a él en su protocolo, no en TAP: test-gate.sh leería cero pruebas.
  L.setEnv(env, 'NODE_TEST_CONTEXT', null);
  if (variant.path_first) { const k = L.pathKey(env); env[k] = `${variant.path_first}${path.delimiter}${env[k] || ''}`; }
  const seen = L.run(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], { env, timeoutMs: 30000, cap: 600 });
  if (seen.exit !== 0 || !L.samePath(L.realOrSelf(seen.stdout.trim()), L.realOrSelf(variant.home), platform)) return { status: L.STATUS.error, reason: `no pude medir: os.homedir() devuelve «${seen.stdout.trim()}», no la carpeta de laboratorio` };

  const repo = path.join(lab, 'work', 'skeleton-repo');
  const made = makeExampleRepo(repo, env);
  if (made) return { status: L.STATUS.error, reason: `no pude medir: no pude armar el repo de ejemplo en ${repo}: ${made}` };
  rec.fact('variant', variant.id);
  rec.fact('repo', repo);
  rec.fact('scripts', { pipeline: pipe, harness });

  // el bash con que el arnés corre un guion de bash en esta máquina (W1): en Windows, el de Git, nunca el de WSL
  let gitBash;
  try { gitBash = require(GIT_BASH).findGitBash({ platform, env: baseEnv }); } catch (e) { gitBash = { path: null, reason: `no pude cargar scripts/lib/git-bash.js: ${e.message}` }; }
  rec.fact('bash', gitBash);

  const { checks, testsResult } = runChecks({ pipe, harness, repo, env, platform, gitBash });
  rec.fact('checks', checks);
  rec.fact('tests_result', testsResult);
  for (const f of findingsOf(checks)) rec.finding(f.id, f.kind, f.detail, f.closes);
  return { status: L.STATUS.measured, reason: null };
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value' });
  if (args.problem || !args.lab || !args.out) { process.stderr.write(`pipeline-skeleton.js: ${args.problem || 'faltan --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  const lab = path.resolve(args.lab);
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`pipeline-skeleton.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const rec = L.recorder(NAME, path.resolve(args.out));
  let result;
  try { result = measure({ lab, rec }); } catch (e) { result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` }; }
  rec.finish(result.status, result.reason);
  const checks = rec.step.facts.checks || {};
  const line = CHECKS.map((c) => `${c} ${checks[c] ? (checks[c].ok ? 'ok' : `NO (${checks[c].error || checks[c].exit})`) : '—'}`).join(' · ');
  process.stdout.write(`pipeline-skeleton: ${result.status === L.STATUS.measured ? `medido — ${line} · ${rec.step.findings.length} hallazgo(s)` : result.reason}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, CHECKS, makeExampleRepo, findingsOf, runChecks, measure };
