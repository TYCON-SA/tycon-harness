#!/usr/bin/env node
'use strict';
// adversarial-multi-repo.test.js — el pase adversarial mira el código de cada repo de la historia contra su propia base
// (historia 8.330).
//
// Caso: una historia con el código en dos repos. El pase recibía un solo repo y una sola base (la de `origin/main`):
// lo que la historia cambió en el otro repo no entraba a ninguna lente, y en un repo con `master` la base no existía.
//
//   T1  freeze-adversarial devuelve cada repo con su sello y su base, calculada después de traer el remoto
//   T2  un hermano con sólo `master` toma la base de `origin/master`; un repo sin rama principal sale con base nula y
//       su motivo, sin frenar
//
// Correr: node --test adversarial-multi-repo.test.js < /dev/null (desde skills/tycon-pipeline/scripts/tests)

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}
// las copias congeladas son de sólo lectura: se devuelve el permiso antes de borrar
after(() => { for (const d of tmpDirs) { try { execFileSync('chmod', ['-R', 'u+w', d]); } catch { /* ya no está */ } fs.rmSync(d, { recursive: true, force: true }); } });

const FECHA = '2026-01-01T10:00:00';
function repoDeJuguete(nombre, archivos) {
  const repo = path.join(tmp(`amr-${nombre}-`), nombre);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  }).trim();
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  for (const [rel, txt] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), txt);
  }
  git('add', '.');
  git('commit', '-qm', 'inicio');
  return { repo, git };
}
// Un remoto `origin` (un repo vacío aparte) con la rama principal `rama` en el commit de ahora, y un commit más en la rama
// de trabajo. El repo no trae la rama del remoto: sólo la ve quien la trae (`git fetch`). Devuelve la base esperada.
function conRemoto(r, rama) {
  const remoto = path.join(tmp('amr-remoto-'), 'origen.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', rama, remoto]);
  r.git('remote', 'add', 'origin', remoto);
  r.git('push', '-q', 'origin', `HEAD:${rama}`);
  r.git('update-ref', '-d', `refs/remotes/origin/${rama}`);
  const base = r.git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(r.repo, 'trabajo.txt'), 'un commit de la rama de trabajo\n');
  r.git('add', '.');
  r.git('commit', '-qm', 'trabajo');
  return base;
}

// La corrida de juguete: la historia en un repo, el código en otro y un hermano (Front) con archivos declarados, con
// una HOME propia.
function corridaConHermano(sid) {
  const base = tmp('amr-corrida-');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  const front = repoDeJuguete('Front', { 'src/x.js': 'module.exports = 1;\n' });
  const historias = repoDeJuguete('historias', {
    'specs/story-9.9-repos.md': ['---', 'story: "9.9"', 'title: "repos"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '  - Front/src/x.js', '---',
      '# Story 9.9', '', '## Acceptance Criteria', '', '1. **Given** algo, **Then** resultado.', '', '### Tests', '',
      '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|', '| T1 | `a.caso1` | 1 | unit | x | y |', '',
      '## Tasks / Subtasks', '', '- [ ] Task 1: hacerlo (AC: 1)', '', '## Change Log', '', '- hoy: escrita', ''].join('\n'),
  });
  const codigo = repoDeJuguete('codigo', { 'src/a.js': 'module.exports = 1;\n' });
  fs.mkdirSync(path.join(codigo.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(codigo.repo, '.tycon', 'advisors.yaml'), `evidence:\n  companion_repos:\n    - ${path.relative(codigo.repo, front.repo)}\n`);
  codigo.git('add', '.');
  codigo.git('commit', '-qm', 'declara el hermano');
  const story = path.join(historias.repo, 'specs', 'story-9.9-repos.md');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off' };
  for (const k of ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID']) delete env[k];
  const correr = (script, args) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env, input: '', cwd: codigo.repo });
  const r = correr('pipeline.js', ['start', '--story', story, '--repo', codigo.repo, '--brief']);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  return { home, historias, codigo, front, story, sid, correr };
}
const salida = (r) => `${r.stdout}\n${r.stderr}`;
const congelar = (C) => {
  const r = C.correr('marker.js', ['freeze-adversarial']);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { r, json };
};
const delRepo = (json, repo) => ((json && json.repos) || []).find((x) => x.repo === repo);

// 🔴 mutación: calcular la base sin traer el remoto, o una sola base para todos los repos.
test('T1 FreezeAdversarial_ReposConSuBase: el repo de la corrida y el hermano tocado, cada uno con su sello y la base de su rama principal', () => {
  const C = corridaConHermano('s-amr-t1');
  const baseCodigo = conRemoto(C.codigo, 'main');
  const baseFront = conRemoto(C.front, 'main');
  const { r, json } = congelar(C);
  assert.strictEqual(r.status, 0, salida(r));
  for (const [repo, base] of [[C.codigo.repo, baseCodigo], [C.front.repo, baseFront]]) {
    const x = delRepo(json, repo);
    assert.ok(x, `devuelve ${repo}: ${r.stdout}`);
    assert.match(String(x.sello), /^[0-9a-f]{40,64}$/, 'con su sello');
    assert.strictEqual(x.sello, json.sellos[repo], 'el mismo sello que `sellos`');
    assert.strictEqual(x.base, base, `la base de ${path.basename(repo)} es el punto común con su rama principal, traída del remoto`);
  }
});

// 🔴 mutación: buscar sólo `origin/main`, o frenar el congelado por un repo sin rama principal.
test('T2 FreezeAdversarial_HermanoConMaster_SinRama_BaseNula: con sólo `master`, su base; sin rama principal, base nula con el motivo y sin frenar', () => {
  const C = corridaConHermano('s-amr-t2');
  conRemoto(C.codigo, 'main');
  const baseFront = conRemoto(C.front, 'master');
  const { r, json } = congelar(C);
  assert.strictEqual(r.status, 0, salida(r));
  assert.strictEqual(delRepo(json, C.front.repo).base, baseFront, 'la base del hermano sale de origin/master');
  // el repo de la historia no tiene remoto: sale igual, sin base y con el motivo
  const hist = delRepo(json, C.historias.repo);
  assert.ok(hist, `el repo de la historia también sale: ${r.stdout}`);
  assert.strictEqual(hist.base, null);
  assert.match(String(hist.sin_base), /origin/, `el motivo dice qué faltó: ${hist.sin_base}`);
});
