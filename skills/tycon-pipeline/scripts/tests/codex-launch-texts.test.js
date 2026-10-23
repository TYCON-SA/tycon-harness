#!/usr/bin/env node
/**
 * codex-launch-texts.test.js — bajo Codex, lo que imprime el pipeline nombra el lanzador de revisores (`reviewers-run`).
 *
 * El caso: con Codex, la salida de `advisors` sólo decía cómo lanzar en `batch_rule` («subagentes VIVOS») y el error de
 * `check-count` preguntaba por `Agent(...)`. Un modelo sin esa herramienta corrió `check-count` nueve veces y se paró en
 * Revisores, con la sección «Bajo Codex» del paso a la vista.
 *
 * Cada prueba corre el pipeline de verdad con HOME temporal: la herramienta se decide por el ambiente (`CODEX_SESSION_ID`
 * sin `CLAUDE_CODE_SESSION_ID` es Codex). Bajo Claude Code la salida no cambia.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/codex-launch-texts.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const REPO_ROOT = path.join(SCRIPTS, '..', '..', '..');
const SID = 'test-codex-launch-texts';

function mkRepo(prefijo = 'cx-texts-') {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefijo)));
  // fecha fija y sin mantenimiento automático: el sha sale siempre igual
  const fechas = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', r, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'user.email=noreply@example.com', '-c', 'user.name=lab', ...a], { stdio: 'ignore', env: { ...process.env, ...fechas } });
  fs.mkdirSync(path.join(r, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(r, 'specs', 'story-1.1.md'), [
    '---', 'epic: 1', 'story: "1.1"', 'title: "restar"', 'status: in-progress', '---',
    '# Story 1.1', '', '## Acceptance Criteria', '1. resta dos números', '',
    '## Tests', '| # | Test |', '|---|---|', '| 1 | T1 |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(r, 'a.js'), 'module.exports = 1;\n');
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'init');
  fs.appendFileSync(path.join(r, 'a.js'), 'module.exports.b = 2;\n');
  return r;
}

function ambiente(home, herramienta) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_PACKS_DEFAULT: 'none', TYCON_AUTO_SNAPSHOT: '0' };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.CODEX_SESSION_ID; delete env.TYCON_SESSION_ID; delete env.CLAUDE_CONFIG_DIR;
  if (herramienta === 'codex') env.CODEX_SESSION_ID = SID;
  else { env.CLAUDE_CODE_SESSION_ID = SID; env.TYCON_SESSION_ID = SID; }
  return env;
}

function correr(herramienta, args, ctx = {}) {
  const home = ctx.home || fs.mkdtempSync(path.join(os.tmpdir(), 'cx-texts-home-'));
  const repo = ctx.repo || mkRepo();
  // `ctx.cwd`: correr desde otra carpeta que el repo, para ver que el comando armado lleva la ruta del repo y no la de
  // donde se corrió
  const story = ctx.sinStory ? [] : ['--story', 'specs/story-1.1.md'];
  const r = spawnSync(process.execPath, [PIPELINE, ...args, '--repo', repo, ...story, '--files', 'a.js'], {
    cwd: ctx.cwd || repo, encoding: 'utf8', timeout: 60000, env: ambiente(home, herramienta),
  });
  return { ...r, home, repo };
}

test('Advisors_BajoCodex_NombraReviewersRun @story-8.108 @ac-1', () => {
  for (const args of [['advisors'], ['smart-reloop', '--iter', '2', '--force-full-reloop']]) {
    const r = correr('codex', args, { cwd: os.tmpdir() });
    assert.strictEqual(r.status, 0, `${args[0]}: ${r.stderr}`);
    const set = JSON.parse(r.stdout);
    assert.ok(set.launch, `${args[0]}: falta el campo launch`);
    assert.match(set.launch, /reviewers-run/);
    assert.ok(set.launch.includes(path.resolve(PIPELINE)), `${args[0]}: el comando trae la ruta absoluta del pipeline.js: ${set.launch}`);
    assert.ok(set.launch.includes(`--repo ${r.repo}`), `${args[0]}: ${set.launch}`);
    assert.ok(set.launch.includes('--story specs/story-1.1.md'), `${args[0]}: ${set.launch}`);
    assert.match(set.batch_rule, /reviewers-run/, `${args[0]}: batch_rule`);
    assert.doesNotMatch(set.batch_rule, /subagentes/i, `${args[0]}: batch_rule le pide al modelo que lance subagentes`);
  }
});

// Los argumentos que recibe el lanzador si se pega el comando en la terminal: el mismo texto, con `printf` en vez de node.
const argumentosDe = (launch) => spawnSync('bash', ['-c', launch.replace(/^node /, 'printf "%s\\n" ')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

test('Advisors_BajoCodex_LaunchSinStoryYConRutaRara @story-8.108 @ac-1', () => {
  // sin --story (el pase adversarial lo confirmó: salía `--story null` y reviewers-run tomaba «null» como ruta)
  const sin = correr('codex', ['advisors'], { sinStory: true, cwd: os.tmpdir() });
  assert.strictEqual(sin.status, 0, sin.stderr);
  const launch = JSON.parse(sin.stdout).launch;
  assert.doesNotMatch(launch, /--story/, `sin --story en la llamada, el comando no lo inventa: ${launch}`);
  assert.doesNotMatch(launch, /\bnull\b|\bundefined\b/, launch);
  // una ruta con espacio y comilla simple llega entera, como un solo argumento
  const raro = mkRepo("cx texts 'q-");
  const r = correr('codex', ['advisors'], { repo: raro, cwd: os.tmpdir() });
  assert.strictEqual(r.status, 0, r.stderr);
  const a = argumentosDe(JSON.parse(r.stdout).launch);
  assert.strictEqual(a[a.indexOf('--repo') + 1], raro, `la ruta del repo llega entera: ${JSON.stringify(a)}`);
  assert.strictEqual(a[a.indexOf('--story') + 1], 'specs/story-1.1.md');
  assert.strictEqual(a[0], path.resolve(PIPELINE));
});

test('Advisors_BajoClaude_SinCambios @story-8.108 @ac-2', () => {
  for (const args of [['advisors'], ['smart-reloop', '--iter', '2', '--force-full-reloop']]) {
    const r = correr('claude', args);
    assert.strictEqual(r.status, 0, `${args[0]}: ${r.stderr}`);
    const set = JSON.parse(r.stdout);
    assert.strictEqual(set.launch, undefined, `${args[0]}: bajo Claude Code no hay launch`);
    assert.match(set.batch_rule, /subagentes VIVOS/, `${args[0]}: el batch_rule de siempre`);
    assert.doesNotMatch(set.batch_rule, /reviewers-run/);
  }
});

test('CheckCount_BajoCodex_PideReviewersRun @story-8.108 @ac-3', () => {
  const a = correr('codex', ['advisors']);
  assert.strictEqual(a.status, 0, a.stderr);
  const r = correr('codex', ['check-count'], { home: a.home, repo: a.repo });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /FALLÓ CERRADO/);
  assert.match(r.stderr, /reviewers-run/);
  assert.ok(r.stderr.includes(path.resolve(PIPELINE)), `trae el comando para pegar: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Agent\(/);
  assert.doesNotMatch(r.stderr, /settings\.json/);
  assert.match(r.stderr, /sin red/);
  assert.match(r.stderr, /no cambia nada/);
});

test('CheckCount_BajoClaude_SinCambios @story-8.108 @ac-3', () => {
  const a = correr('claude', ['advisors']);
  assert.strictEqual(a.status, 0, a.stderr);
  const r = correr('claude', ['check-count'], { home: a.home, repo: a.repo });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /¿Invocaste los Agent\(\.\.\.\) después de correr pipeline\.js advisors\?/);
  assert.match(r.stderr, /settings\.json/);
  assert.doesNotMatch(r.stderr, /reviewers-run/);
});

test('Guias_RedDeLosRevisores @story-8.108 @ac-7', () => {
  const step = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-07-reviewers.md'), 'utf8');
  const codex = step.match(/^### Bajo Codex[^\n]*\n([\s\S]*?)(?=^#{2,3} )/m);
  assert.ok(codex, 'falta la sección «Bajo Codex» del paso de revisores');
  // en la guía de Ollama, la sección de los revisores (no el archivo entero)
  const seccion = (archivo, titulo) => {
    const t = fs.readFileSync(path.join(REPO_ROOT, 'guides', 'integrations', archivo), 'utf8');
    const m = t.match(new RegExp(`^### ${titulo}[^\\n]*\\n([\\s\\S]*?)(?=^#{2,3} )`, 'm'));
    assert.ok(m, `falta la sección «${titulo}» en ${archivo}`);
    return m[1];
  };
  const textos = {
    'step-07-reviewers.md §Bajo Codex': [codex[1], /caja de arena/, /fuera de la caja de arena/],
    'ollama.md §Los revisores los lanza el pipeline': [seccion('ollama.md', 'Los revisores los lanza el pipeline'), /caja de arena/, /fuera de la caja de arena/],
    'ollama.en.md §The pipeline launches the reviewers': [seccion('ollama.en.md', 'The pipeline launches the reviewers'), /sandbox/, /outside the sandbox/],
  };
  for (const [nombre, [t, caja, afuera]] of Object.entries(textos)) {
    assert.match(t, /reviewers-run/, `${nombre}: no nombra reviewers-run`);
    assert.match(t, caja, `${nombre}: no nombra la caja de arena`);
    assert.match(t, afuera, `${nombre}: no dice que se corre fuera de la caja de arena`);
    assert.match(t, /sandbox_workspace_write\.network_access/, `${nombre}: no nombra network_access`);
  }
});
