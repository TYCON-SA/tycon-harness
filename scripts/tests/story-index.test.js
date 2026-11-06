'use strict';
/**
 * story-index.test.js — los dos índices de historias (`specs/epics.md` y `specs/sprint-status.yaml`) salen del
 * frontmatter de cada historia, y nadie los edita a mano.
 *
 * El caso: dos ramas que suman una historia cada una chocaban en esos dos archivos aunque cada una sólo sumó su renglón,
 * y el índice escrito a mano se desfasaba del frontmatter. `scripts/tools/story-index.js` los arma; el pre-commit del
 * repo de historias frena el índice editado a mano en una rama (`--guard`), y main los regenera después de cada merge
 * (`--regenerate-on-main`).
 *
 * El repo de juguete vive en `fixtures/story-index/`: sus historias son `.md.tpl` (así no cuentan como historias del
 * arnés) y cada prueba las copia a una carpeta temporal como `.md`. Los esperados están escritos a mano y se comparan
 * byte por byte.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const TOOL = path.join(REPO, 'scripts', 'tools', 'story-index.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'story-index');
const NUMBER = path.join(REPO, 'skills', 'tycon-create-story', 'scripts', 'story-number.js');
const TR = require(path.join(REPO, 'scripts', 'lib', 'team-repos.js'));
const { sinGitDelPadre } = require(path.join(REPO, 'scripts', 'lib', 'clean-git-env.js'));

const FECHA = '2026-11-06T12:00:00Z';
const EPICS = 'specs/epics.md';
const SPRINT = 'specs/sprint-status.yaml';
const AZURE_URL = 'https://dev.azure.com/acme/arnes/_git/historias';

function tmp(nombre) { return fs.mkdtempSync(path.join(os.tmpdir(), `story-index-${nombre}-`)); }

/** El entorno de un laboratorio: su HOME, sin la configuración de la máquina ni las variables de un hook de git. */
function entorno(home, extra = {}) {
  const env = sinGitDelPadre();
  for (const k of ['NODE_TEST_CONTEXT', 'TYCON_HOME', 'TYCON_STORY_SCAN_BUDGET_MS']) delete env[k];
  return {
    ...env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA, ...extra,
  };
}

function git(cwd, args, home) {
  const r = spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, env: entorno(home), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Copia el juguete a una carpeta temporal: las historias pierden el `.tpl`. Devuelve la carpeta. */
function juguete(nombre, { sinEsperados = true } = {}) {
  const dir = tmp(nombre);
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  for (const f of fs.readdirSync(path.join(FIXTURE, 'specs'))) {
    fs.copyFileSync(path.join(FIXTURE, 'specs', f), path.join(dir, 'specs', f.replace(/\.tpl$/, '')));
  }
  if (!sinEsperados) {
    fs.copyFileSync(path.join(FIXTURE, 'expected-epics.md'), path.join(dir, EPICS));
    fs.copyFileSync(path.join(FIXTURE, 'expected-sprint-status.yaml'), path.join(dir, SPRINT));
  }
  return dir;
}

function correr(args, { home, cwd, env } = {}) {
  const h = home || tmp('home');
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: cwd || REPO, env: entorno(h, env), encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const leer = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const esperado = (nombre) => fs.readFileSync(path.join(FIXTURE, nombre), 'utf8');
const historia = (epic, story, title, status) => `---\nepic: ${epic}\nstory: "${story}"\ntitle: "${title}"\nstatus: ${status}\n---\n\n# Story ${story}: ${title}\n`;

test('StoryIndex_BuildsBothIndexesFromFrontmatter (T1) @story-8.226 @ac-1', () => {
  const dir = juguete('t1');
  const r = correr(['--repo', dir, '--write']);
  assert.strictEqual(r.code, 0, r.out);
  const sprint = leer(dir, SPRINT);
  assert.match(sprint, /^ {2}1-2-alfa: done$/m);
  assert.match(sprint, /^ {2}2-17-1-epsilon: in-progress$/m, 'la 2.17.1 queda 2-17-1-<slug>');
  assert.match(sprint, /^ {2}1-10-beta: draft$/m, 'draft sigue siendo draft');
  assert.match(sprint, /^ {2}1-9-gamma: backlog$/m, 'backlog sigue siendo backlog');
  assert.match(leer(dir, EPICS), /\| 1\.2 \| Alfa \| done \| `specs\/story-1\.2-alfa\.md` \|/);
});

test('StoryIndex_FixedOrderMatchesExpectedOutput (T2) @story-8.226 @ac-2', () => {
  const dir = juguete('t2');
  assert.strictEqual(correr(['--repo', dir, '--write']).code, 0);
  assert.strictEqual(leer(dir, EPICS), esperado('expected-epics.md'));
  assert.strictEqual(leer(dir, SPRINT), esperado('expected-sprint-status.yaml'));
  const orden = leer(dir, SPRINT).split('\n').filter((l) => /^ {2}\d/.test(l)).map((l) => l.trim().split(':')[0]);
  assert.deepStrictEqual(orden.slice(0, 3), ['1-2-alfa', '1-9-gamma', '1-10-beta'], '1.9 antes que 1.10');
  assert.ok(orden.indexOf('2-17-delta') < orden.indexOf('2-17-1-epsilon'), '2.17.1 después de 2.17');
  assert.strictEqual(correr(['--repo', dir, '--write']).code, 0);
  assert.strictEqual(leer(dir, EPICS), esperado('expected-epics.md'), 'dos corridas dan lo mismo');
});

test('StoryIndex_EpicProseComesFromIntroFile (T3) @story-8.226 @ac-3', () => {
  const dir = juguete('t3');
  assert.strictEqual(correr(['--repo', dir, '--write']).code, 0);
  const epics = leer(dir, EPICS);
  assert.match(epics, /## Épica 1 — Uno\n\nLa épica uno junta lo primero\.\nTiene dos renglones de prosa\.\n/);
  assert.match(epics, /## Épica 2\n\n> sin introducción: falta en specs\/epics-intro\.md\n/);
  assert.ok(leer(dir, SPRINT).startsWith('# Generado por scripts/tools/story-index.js'), 'la cabecera la escribe el guion');
});

test('StoryIndex_CheckReportsWhetherIndexIsCurrent (T4) @story-8.226 @ac-4', () => {
  const dir = juguete('t4', { sinEsperados: false });
  assert.strictEqual(correr(['--repo', dir, '--check']).code, 0, 'al día');
  fs.writeFileSync(path.join(dir, 'specs', 'story-1.2-alfa.md'), historia(1, '1.2', 'Alfa', 'review'));
  const r = correr(['--repo', dir, '--check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /1-2-alfa/, 'nombra la diferencia');
});

test('StoryIndex_UnreadableOrPartialScanDoesNotWrite (T5) @story-8.226 @ac-5 @ac-5.1', () => {
  const casos = [
    ['sin-status', 'story-1.20-rota.md', '---\nepic: 1\nstory: "1.20"\ntitle: "Rota"\n---\n', /story-1\.20-rota\.md.*status/],
    ['sin-epic', 'story-1.21-sin.md', '---\nstory: "1.21"\ntitle: "Sin"\nstatus: draft\n---\n', /story-1\.21-sin\.md.*epic/],
    ['fuera', 'story-ev-1.md', '---\nepic: 1\nstory: "EV-1"\ntitle: "Insumo"\nstatus: draft\n---\n', /story-ev-1\.md.*fuera del patrón/],
  ];
  for (const [nombre, archivo, texto, motivo] of casos) {
    const dir = juguete(`t5-${nombre}`);
    fs.writeFileSync(path.join(dir, 'specs', archivo), texto);
    const r = correr(['--repo', dir, '--write']);
    assert.strictEqual(r.code, 1, `${nombre}: ${r.out}`);
    assert.match(r.out, motivo, nombre);
    assert.ok(!fs.existsSync(path.join(dir, EPICS)) && !fs.existsSync(path.join(dir, SPRINT)), `${nombre}: no escribe nada`);
  }
  const dir = juguete('t5-partial', { sinEsperados: false });
  const w = correr(['--repo', dir, '--write'], { env: { TYCON_STORY_SCAN_BUDGET_MS: '-1' } });
  assert.strictEqual(w.code, 1, w.out);
  assert.match(w.out, /escaneo quedó incompleto/);
  const c = correr(['--repo', dir, '--check'], { env: { TYCON_STORY_SCAN_BUDGET_MS: '-1' } });
  assert.strictEqual(c.code, 1, 'incompleto no es «al día»');
  assert.strictEqual(leer(dir, EPICS), esperado('expected-epics.md'), 'no tocó lo escrito');
});

test('StoryIndex_ExistingReadersKeepWorking (T6) @story-8.226 @ac-6', () => {
  const home = tmp('home');
  const numero = (dir) => {
    git(dir, ['init', '-q'], home); git(dir, ['add', '-A'], home); git(dir, ['commit', '-qm', 'juguete'], home);
    const r = spawnSync(process.execPath, [NUMBER, 'next', '--repo', dir, '--epic', '1', '--no-fetch'], { env: entorno(home), encoding: 'utf8' });
    return JSON.parse(r.stdout).next;
  };
  const generado = juguete('t6-gen');
  assert.strictEqual(correr(['--repo', generado, '--write']).code, 0);
  const aMano = juguete('t6-esp', { sinEsperados: false });
  const n = numero(generado);
  assert.strictEqual(n, numero(aMano), 'el mismo número con el índice generado que con el esperado');
  assert.strictEqual(String(n), '1.12', 'la historia mínima 1.11 reserva su número');
  assert.match(leer(generado, EPICS), /^## Épica 1\b/m, 'el encabezado que lee el tablero nocturno');
});

// ── el freno del pre-commit del repo de historias ────────────────────────────────────────────────

/** El perfil instalado de juguete: team-repos.json con la clave del repo de historias. */
function perfil(modo) {
  const f = path.join(tmp('perfil'), 'team-repos.json');
  const repo = (r) => ({ platform: 'azure', org: 'acme', project: 'arnes', repo: r });
  fs.writeFileSync(f, JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' }, profile: repo('perfil'), operations: repo('ops'),
    ...(modo ? { story_index: { repos: [{ repo: repo('historias'), mode: modo }] } } : {}) }));
  return f;
}

/** Un repo de historias con main y su índice generado, y su origin en Azure. */
function repoConIndice(nombre, home) {
  const dir = juguete(nombre);
  assert.strictEqual(correr(['--repo', dir, '--write']).code, 0);
  git(dir, ['init', '-q'], home); git(dir, ['remote', 'add', 'origin', AZURE_URL], home);
  git(dir, ['add', '-A'], home); git(dir, ['commit', '-qm', 'base'], home);
  return dir;
}

const guard = (dir, home, teamRepos) => correr(['--repo', dir, '--guard', ...(teamRepos ? ['--team-repos', teamRepos] : [])], { home, cwd: dir });

test('PreCommit_GeneratedIndexIsNotHandEditedOnBranch (T9) @story-8.226 @ac-8', () => {
  const home = tmp('home');
  const tr = perfil('generated');
  const dir = repoConIndice('t9', home);
  git(dir, ['checkout', '-qb', 'story/x'], home);
  fs.appendFileSync(path.join(dir, SPRINT), '  1-99-a-mano: draft\n');
  git(dir, ['add', SPRINT], home);
  let r = guard(dir, home, tr);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /story-index\.js --repo .* --write/, 'dice el comando que los regenera');
  // igual al generado: pasa
  git(dir, ['checkout', '-q', 'HEAD', '--', SPRINT], home);
  fs.writeFileSync(path.join(dir, 'specs', 'story-1.30-nueva.md'), historia(1, '1.30', 'Nueva', 'draft'));
  assert.strictEqual(correr(['--repo', dir, '--write']).code, 0);
  git(dir, ['add', '-A'], home);
  assert.strictEqual(guard(dir, home, tr).code, 0, 'el regenerado pasa');
  // un merge en curso pasa
  fs.appendFileSync(path.join(dir, EPICS), 'a mano\n'); git(dir, ['add', EPICS], home);
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), `${git(dir, ['rev-parse', 'HEAD'], home)}\n`);
  assert.strictEqual(guard(dir, home, tr).code, 0, 'merge en curso');
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'));
  // main pasa; una rama desprendida cuenta como rama
  git(dir, ['stash', '-q'], home); git(dir, ['checkout', '-q', 'main'], home); git(dir, ['stash', 'pop', '-q', '--index'], home);
  assert.match(git(dir, ['diff', '--cached', '--name-only'], home), /epics\.md/, 'el índice a mano sigue preparado');
  assert.strictEqual(guard(dir, home, tr).code, 0, 'en main pasa');
  git(dir, ['checkout', '-q', '--detach'], home);
  assert.match(git(dir, ['diff', '--cached', '--name-only'], home), /epics\.md/);
  assert.strictEqual(guard(dir, home, tr).code, 1, 'desprendida cuenta como rama');
  // --mode dice el modo del repo (lo lee la skill que crea historias)
  assert.match(correr(['--repo', dir, '--mode', '--team-repos', tr], { home, cwd: dir }).out, /^generated$/m);
  assert.match(correr(['--repo', dir, '--mode', '--team-repos', perfil('manual')], { home, cwd: dir }).out, /^manual$/m);
  // sin perfil legible avisa y no frena; con manual no hace nada
  r = guard(dir, home, path.join(tmp('nada'), 'team-repos.json'));
  assert.strictEqual(r.code, 0); assert.match(r.out, /no pude leer/);
  assert.strictEqual(guard(dir, home, perfil('manual')).code, 0);
});

test('PreCommit_TwoBranchesEachAddAStoryWithoutConflict (T9) @story-8.226 @ac-8', () => {
  const home = tmp('home');
  const dir = repoConIndice('t9b', home);
  for (const [rama, n] of [['a', '1.40'], ['b', '1.41']]) {
    git(dir, ['checkout', '-qb', rama, 'main'], home);
    fs.writeFileSync(path.join(dir, 'specs', `story-${n}-r${rama}.md`), historia(1, n, `R${rama}`, 'draft'));
    git(dir, ['add', '-A'], home); git(dir, ['commit', '-qm', rama], home);
  }
  git(dir, ['checkout', '-q', 'main'], home);
  git(dir, ['merge', '-q', '--no-edit', 'a'], home);
  git(dir, ['merge', '-q', '--no-edit', 'b'], home);
  assert.strictEqual(correr(['--repo', dir, '--write']).code, 0);
  assert.match(leer(dir, SPRINT), /1-40-ra: draft\n {2}1-41-rb: draft/, 'las dos ramas entran sin choque y main regenera');
});

// ── la regeneración en main ──────────────────────────────────────────────────────────────────────

/** Un remoto desnudo con main y su índice al día, y un clon que hace de máquina del pipeline. */
function remotoYClon(nombre, home) {
  const semilla = repoConIndice(nombre, home);
  const remoto = `${tmp(`${nombre}-remoto`)}/r.git`;
  git(path.dirname(remoto), ['clone', '-q', '--bare', semilla, remoto], home);
  const clon = `${tmp(`${nombre}-clon`)}/c`;
  git(path.dirname(clon), ['clone', '-q', remoto, clon], home);
  return { semilla, remoto, clon };
}
const regenerar = (clon, home, extra = []) => correr(['--repo', clon, '--regenerate-on-main', ...extra], { home, cwd: clon });

test('StoryIndex_RegenerationOnMain (T16) @story-8.226 @ac-9', () => {
  const home = tmp('home');
  const { remoto, clon } = remotoYClon('t16', home);
  const antes = git(clon, ['ls-remote', remoto, 'main'], home);
  let r = regenerar(clon, home);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(git(clon, ['ls-remote', remoto, 'main'], home), antes, 'sin cambios no commitea');
  fs.writeFileSync(path.join(clon, 'specs', 'story-2.18-nueva.md'), historia(2, '2.18', 'Nueva', 'draft'));
  git(clon, ['add', '-A'], home); git(clon, ['commit', '-qm', 'merge de la historia'], home); git(clon, ['push', '-q', 'origin', 'main'], home);
  r = regenerar(clon, home);
  assert.strictEqual(r.code, 0, r.out);
  const msg = git(clon, ['log', '-1', '--format=%s', 'origin/main'], home);
  assert.match(msg, /\[skip ci\]/);
  assert.deepStrictEqual(git(clon, ['show', '--name-only', '--format=', 'origin/main'], home).split('\n').sort(), [EPICS, SPRINT]);
  fs.writeFileSync(path.join(clon, 'specs', 'story-2.19-rota.md'), '---\nepic: 2\nstory: "2.19"\n---\n');
  git(clon, ['add', '-A'], home); git(clon, ['commit', '-qm', 'rota'], home); git(clon, ['push', '-q', 'origin', 'main'], home);
  const tope = git(clon, ['ls-remote', remoto, 'main'], home);
  r = regenerar(clon, home);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /story-2\.19-rota\.md/);
  assert.strictEqual(git(clon, ['ls-remote', remoto, 'main'], home), tope, 'un frontmatter ilegible no escribe');
});

test('StoryIndex_RegenerationOnMainSkipsHandWrittenIndex (T16) @story-8.226 @ac-9', () => {
  const home = tmp('home');
  const { remoto, clon } = remotoYClon('t16b', home);
  fs.writeFileSync(path.join(clon, SPRINT), 'development_status:\n  1-2-alfa: done   # escrito a mano\n');
  fs.writeFileSync(path.join(clon, 'specs', 'story-2.18-nueva.md'), historia(2, '2.18', 'Nueva', 'draft'));
  git(clon, ['add', '-A'], home); git(clon, ['commit', '-qm', 'todavía a mano'], home); git(clon, ['push', '-q', 'origin', 'main'], home);
  const tope = git(clon, ['ls-remote', remoto, 'main'], home);
  const r = regenerar(clon, home);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /todavía se escribe a mano/);
  assert.strictEqual(git(clon, ['ls-remote', remoto, 'main'], home), tope, 'un índice sin migrar no se pisa');
});

test('StoryIndex_TwoMergesInARow (T17) @story-8.226 @ac-9', () => {
  const home = tmp('home');
  const { remoto, clon } = remotoYClon('t17', home);
  fs.writeFileSync(path.join(clon, 'specs', 'story-2.20-a.md'), historia(2, '2.20', 'A', 'draft'));
  git(clon, ['add', '-A'], home); git(clon, ['commit', '-qm', 'a'], home); git(clon, ['push', '-q', 'origin', 'main'], home);
  // otro merge entra después de que el clon trajo main: el primer empuje choca
  const otro = `${tmp('t17-otro')}/o`;
  git(path.dirname(otro), ['clone', '-q', remoto, otro], home);
  fs.writeFileSync(path.join(otro, 'specs', 'story-2.21-b.md'), historia(2, '2.21', 'B', 'draft'));
  git(otro, ['add', '-A'], home); git(otro, ['commit', '-qm', 'b'], home);
  const r = regenerar(clon, home, ['--before-push', `git -C ${JSON.stringify(otro)} push -q origin main`]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(git(clon, ['show', 'origin/main:specs/sprint-status.yaml'], home), /2-20-a: draft\n {2}2-21-b: draft/);
  // otro merge entra antes de cada empuje: al tercer choque deja el índice como estaba
  fs.writeFileSync(path.join(clon, 'specs', 'story-2.22-c.md'), historia(2, '2.22', 'C', 'draft'));
  git(clon, ['add', '-A'], home); git(clon, ['commit', '-qm', 'c'], home); git(clon, ['push', '-q', 'origin', 'main'], home);
  const o = JSON.stringify(otro);
  const siempre = `git -C ${o} pull -q --rebase origin main && git -C ${o} commit -q --allow-empty -m otro && git -C ${o} push -q origin main`;
  const res = regenerar(clon, home, ['--before-push', siempre]);
  assert.strictEqual(res.code, 1, res.out);
  assert.match(res.out, /3 intentos/);
  git(clon, ['fetch', '-q', 'origin'], home);
  assert.doesNotMatch(git(clon, ['show', 'origin/main:specs/sprint-status.yaml'], home), /2-22-c/, 'el índice queda como estaba');
});

// ── la migración y la clave del repo ─────────────────────────────────────────────────────────────

test('StoryIndex_MigrationReport (T18) @story-8.226 @ac-11', () => {
  const dir = juguete('t18');
  fs.writeFileSync(path.join(dir, SPRINT), [
    '# a mano', 'development_status:', '  epic-1: in-progress',
    '  1-2-alfa: in-progress   # se cerró en la demo', '  1-9-gamma: backlog', '1-50-perdida: ready-for-dev   # quedó sin archivo', '',
  ].join('\n'));
  const informe = path.join(dir, 'specs', 'qa', 'migracion.md');
  const r = correr(['--repo', dir, '--migrate', '--report', informe]);
  assert.strictEqual(r.code, 0, r.out);
  const txt = fs.readFileSync(informe, 'utf8');
  assert.match(txt, /1-2-alfa.*in-progress.*done/, 'estado distinto: gana el frontmatter');
  assert.match(txt, /1-50-perdida/, 'entrada sin archivo');
  const minima = leer(dir, 'specs/story-1.50-perdida.md');
  assert.match(minima, /^story: "1\.50"$/m);
  assert.match(minima, /^status: ready-for-dev$/m);
  assert.match(minima, /quedó sin archivo/, 'la nota pasa a su Change Log');
  assert.match(leer(dir, 'specs/story-1.2-alfa.md'), /## Change Log\n\n- .*se cerró en la demo/, 'la nota de una historia con archivo también');
  assert.match(leer(dir, SPRINT), /^ {2}1-50-perdida: ready-for-dev$/m, 'los índices quedan regenerados');
  assert.match(leer(dir, SPRINT), /^ {2}1-2-alfa: done$/m);
});

test('TeamRepos_StoryIndexKeyPerRepo (T19) @story-8.226 @ac-7 @ac-8', () => {
  const repo = { platform: 'azure', org: 'acme', project: 'arnes', repo: 'historias' };
  const base = { version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' }, profile: { ...repo, repo: 'perfil' }, operations: { ...repo, repo: 'ops' } };
  const ok = TR.parse(JSON.stringify({ ...base, story_index: { repos: [{ repo, mode: 'generated' }] } }));
  assert.deepStrictEqual(ok.problems, []);
  assert.strictEqual(TR.storyIndexFor(ok.data, repo).mode, 'generated');
  assert.strictEqual(TR.storyIndexFor(ok.data, { ...repo, repo: 'otro' }).mode, 'manual', 'sin entrada: manual');
  const mal = TR.parse(JSON.stringify({ ...base, story_index: { repos: [{ repo, mode: 'automagico' }] } }));
  assert.ok(mal.ok, 'un modo mal escrito no invalida el archivo entero');
  assert.ok((mal.sectionProblems.story_index || []).some((p) => p.path === 'story_index.repos.0.mode'), 'otro valor es un problema');
  assert.strictEqual(TR.storyIndexFor(mal.data, repo).mode, 'manual', 'y cae a manual');
});
