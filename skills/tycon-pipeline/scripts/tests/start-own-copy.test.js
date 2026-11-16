#!/usr/bin/env node
'use strict';
// stable-data: los commits de los repos de juguete llevan fecha fija (GIT_AUTHOR_DATE / GIT_COMMITTER_DATE); las horas
// de los marcadores son relativas a la corrida.
// start-own-copy.test.js — con otra sesión viva en el checkout, la historia arranca en su propia copia de trabajo:
// `pipeline.js start` se pausa sin escribir nada (PIPE-C6-own-copy) y devuelve el comando de `own-copy.js`, que trae
// main, elige la base, crea la copia y dice dónde quedó la historia; `start` desde la copia arranca como siempre.
//
//   SC1 (T5)  la vuelta entera: pausa sin tocar nada, el comando crea la copia, start desde la copia arranca
//   SC2 (T6)  el nombre ocupado: prueba -2, -3… sin pisar ni reusar
//   SC3 (T7)  la base: HEAD del checkout de la sesión (no el de la carpeta principal); sin commitear sale 3 sin tocar nada
//   SC4 (T8)  fetch o worktree add que fallan: sale 1 y no deja nada
//   SC5 (T9)  el arnés público y agent-skills no piden copia, en las tres situaciones de la máquina; el privado sí
//   SC6 (T10) con coordinadora viva o sin nadie más, como hoy; sin id propio, lo dice
//   SC7 (T11) step-01-start.md le dice al agente qué hacer con la pausa
//
// Corre `pipeline.js` y `own-copy.js` reales con un HOME temporal y repos de juguete con un `origin` local.
// Correr: node --test skills/tycon-pipeline/scripts/tests/start-own-copy.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const OWN_COPY = path.join(SCRIPTS, 'own-copy.js');
const { stateDir } = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js'));
const FECHA = '2026-01-01T10:00:00';
// el público que declara el árbol: sólo se lee la URL, no hay red
const PUBLICO = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'setup', 'public-remotes.json'), 'utf8')).remotes[0];

const historia = (n = '9.9') => ['---', `story: "${n}"`, 'title: "una historia"', 'status: ready-for-dev', '---', `# Story ${n}`, '',
  '## Acceptance Criteria', '', '1. **Given** algo, **Then** resultado.', '', '### Tests', '',
  '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|', '| T1 | `a.caso1` | 1 | unit | x | y |', ''].join('\n');

function git(dir, ...a) {
  return execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...a], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  }).trim();
}

// Un repo con su `origin` (una carpeta bare) y la historia commiteada y subida a main.
function entorno({ nombre = 'producto', origen = null } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'own-copy-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  const bare = path.join(base, 'origen.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const repo = path.join(base, nombre);
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-una-historia.md');
  fs.writeFileSync(story, historia());
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'inicio');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feat/x');
  if (origen) git(repo, 'remote', 'set-url', 'origin', origen);
  const estado = stateDir(home);
  const env = (sid) => {
    const e = { ...process.env, HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none', CLAUDE_CODE_SESSION_ID: sid };
    for (const k of ['CODEX_SESSION_ID', 'TYCON_SKILLS_DIR', 'TYCON_SESSION_GUARD_MIN']) delete e[k];
    if (sid == null) delete e.CLAUDE_CODE_SESSION_ID;
    return e;
  };
  const arrancar = (sid, s = story, r = repo) => spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'start', '--story', s, '--repo', r, '--brief'], { encoding: 'utf8', env: env(sid), input: '', cwd: r });
  const copiar = (s = story, r = repo, sid = 'la-mia') => spawnSync(process.execPath, [OWN_COPY, '--story', s, '--repo', r], { encoding: 'utf8', env: env(sid), input: '', cwd: r });
  const otra = (fields = {}) => {
    fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
    fs.writeFileSync(path.join(estado, 'active', 'otra-sesion.json'), JSON.stringify({ sessionId: 'otra-sesion', storyId: '1.1', stepsPending: ['implement'], lastTouch: new Date().toISOString(), repoPath: repo, ...fields }));
  };
  const marcador = (sid) => { try { return JSON.parse(fs.readFileSync(path.join(estado, 'active', `${sid}.json`), 'utf8')); } catch { return null; } };
  const foto = (r = repo) => ({ head: git(r, 'rev-parse', 'HEAD'), status: git(r, 'status', '--porcelain', '--untracked-files=all'), stash: git(r, 'stash', 'list'), gitignore: fs.existsSync(path.join(r, '.gitignore')) ? fs.readFileSync(path.join(r, '.gitignore'), 'utf8') : null });
  return { base, home, bare, repo, story, estado, env, arrancar, copiar, otra, marcador, foto };
}
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return {}; } };
const pausas = (r) => (json(r).pauses || []).map((p) => p.id);
const acciones = (r) => (json(r).acciones || []).join('\n');
const out = (r) => `${r.stdout}\n${r.stderr}`;

test('SC1 Start_OtherSessionAlive_PausesThenOwnCopyThenStart @story-8.292 @ac-2', () => {
  // 🔴 mutación: crear la copia dentro de start, escribir el .gitignore o el marcador antes de pausar, o no pasar
  // own_copy a la salida breve
  const E = entorno();
  E.otra();
  const antes = E.foto();
  const r = E.arrancar('la-mia');
  assert.deepStrictEqual(pausas(r), ['PIPE-C6-own-copy'], out(r));
  assert.strictEqual(json(r).ready, false);
  const cmd = json(r).own_copy && json(r).own_copy.command;
  assert.match(cmd || '', /own-copy\.js --story .* --repo /, out(r));
  assert.match(json(r).own_copy.because, /otra-ses/);
  assert.deepStrictEqual(E.foto(), antes, 'el checkout compartido no cambió');
  assert.strictEqual(E.marcador('la-mia'), null, 'no hay marcador de la sesión');
  assert.strictEqual(git(E.repo, 'branch', '--list', 'wt/*'), '', 'ninguna rama nueva');

  const c = E.copiar();
  assert.strictEqual(c.status, 0, out(c));
  const copia = json(c);
  assert.strictEqual(copia.path, `${E.repo}--wt-9.9`);
  assert.strictEqual(copia.branch, 'wt/9.9');
  assert.strictEqual(copia.base, 'origin/main');
  assert.strictEqual(copia.story, path.join(copia.path, 'specs', 'story-9.9-una-historia.md'));
  assert.ok(fs.existsSync(copia.story));
  assert.ok(Array.isArray(copia.checklist) && copia.checklist.some((l) => /\.env/.test(l)));
  assert.match(copia.next, /start --story .*--wt-9\.9.* --repo .*--wt-9\.9/);
  assert.deepStrictEqual(E.foto(), antes, 'crear la copia tampoco tocó el checkout');

  const s = E.arrancar('la-mia', copia.story, copia.path);
  assert.ok(!pausas(s).includes('PIPE-C6-own-copy'), out(s));
  assert.strictEqual(json(s).ready, true, out(s));
  const m = E.marcador('la-mia');
  assert.strictEqual(fs.realpathSync(m.repoPath), fs.realpathSync(copia.path));
  assert.ok(fs.realpathSync(m.storyPath).startsWith(fs.realpathSync(copia.path) + path.sep), m.storyPath);
  assert.ok(m.runDir && fs.realpathSync(m.runDir).startsWith(fs.realpathSync(copia.path) + path.sep), m.runDir);
});

test('SC2 OwnCopy_NameTaken_TriesNext @story-8.292 @ac-2', () => {
  // 🔴 mutación: reusar la carpeta o la rama que ya existen, o rendirse en el primer nombre ocupado
  const E = entorno();
  fs.mkdirSync(`${E.repo}--wt-9.9`);
  fs.writeFileSync(path.join(`${E.repo}--wt-9.9`, 'de-otra.txt'), 'no se toca');
  git(E.repo, 'branch', 'wt/9.9-2');
  const c = E.copiar();
  assert.strictEqual(c.status, 0, out(c));
  assert.strictEqual(json(c).path, `${E.repo}--wt-9.9-3`);
  assert.strictEqual(json(c).branch, 'wt/9.9-3');
  assert.strictEqual(fs.readFileSync(path.join(`${E.repo}--wt-9.9`, 'de-otra.txt'), 'utf8'), 'no se toca');
  assert.strictEqual(git(E.repo, 'rev-parse', 'wt/9.9-2'), git(E.repo, 'rev-parse', 'main'), 'la rama ocupada no cambió');
  assert.ok(!fs.existsSync(`${E.repo}--wt-9.9-2`));
});

test('SC3 OwnCopy_StoryOnlyInHead_BaseHead_StoryUncommitted_Exits3 @story-8.292 @ac-3', () => {
  // 🔴 mutación: resolver HEAD en la carpeta principal, o crear la copia (o mover la historia) cuando no está commiteada
  const E = entorno();
  // (a) la sesión trabaja en un worktree con su rama; la carpeta principal queda en otra rama
  const wt = path.join(E.base, 'producto-sesion');
  git(E.repo, 'worktree', 'add', '-q', '-b', 'feat/sesion', wt, 'main');
  const nueva = path.join(wt, 'specs', 'story-8.8-solo-en-mi-rama.md');
  fs.writeFileSync(nueva, historia('8.8'));
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', 'la historia en mi rama');
  const a = E.copiar(nueva, wt);
  assert.strictEqual(a.status, 0, out(a));
  assert.strictEqual(json(a).base, 'HEAD');
  assert.strictEqual(json(a).sha, git(wt, 'rev-parse', 'HEAD'), 'el HEAD del checkout de la sesión');
  assert.notStrictEqual(json(a).sha, git(E.repo, 'rev-parse', 'HEAD'));
  assert.ok(fs.existsSync(json(a).story), 'la historia está en la copia');

  // (b) la historia sin commitear: nada se crea, nada se mueve, nada se guarda en un stash
  const suelta = path.join(E.repo, 'specs', 'story-7.7-sin-commitear.md');
  fs.writeFileSync(suelta, historia('7.7'));
  const antes = E.foto();
  const copiasAntes = fs.readdirSync(E.base).sort();
  const b = E.copiar(suelta);
  assert.strictEqual(b.status, 3, out(b));
  assert.match(json(b).error, /no está commiteada/);
  assert.deepStrictEqual(E.foto(), antes);
  assert.deepStrictEqual(fs.readdirSync(E.base).sort(), copiasAntes);
  assert.ok(fs.existsSync(suelta));
});

test('SC4 OwnCopy_FetchOrAddFails_Exits1AndCleans @story-8.292 @ac-4', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'chmod no niega escribir acá' : false }, () => {
  // 🔴 mutación: seguir sin el fetch, o dejar la rama o la carpeta del intento que falló
  const E = entorno();
  git(E.repo, 'remote', 'set-url', 'origin', path.join(E.base, 'no-existe.git'));
  const a = E.copiar();
  assert.strictEqual(a.status, 1, out(a));
  assert.match(json(a).error, /No pude traer main/);
  assert.strictEqual(git(E.repo, 'branch', '--list', 'wt/*'), '');

  git(E.repo, 'remote', 'set-url', 'origin', E.bare);
  fs.chmodSync(E.base, 0o555);   // la copia va al lado del repo: sin poder escribir ahí, `worktree add` falla
  let b;
  try { b = E.copiar(); } finally { fs.chmodSync(E.base, 0o755); }
  assert.strictEqual(b.status, 1, out(b));
  assert.match(json(b).error, /No pude crear la copia/);
  assert.ok(!fs.existsSync(`${E.repo}--wt-9.9`));
  assert.strictEqual(git(E.repo, 'branch', '--list', 'wt/*'), '', 'no quedó la rama del intento');
  assert.ok(!fs.existsSync(path.join(E.estado, 'active', 'la-mia.json')), 'ningún marcador');
});

test('SC5 Start_HarnessOrAgentSkills_NoPauseWarns @story-8.292 @ac-5', () => {
  // 🔴 mutación: reconocer el arnés con juzgarRepo (sin clon de desarrollo no ve nada; con paths.maintainers cuenta el
  // privado), o por el nombre de la carpeta teniendo origin
  const { sinCopiaPropia } = require(OWN_COPY);
  const E = entorno({ nombre: 'tycon-harness', origen: PUBLICO });
  const copiaPublico = path.join(E.base, 'tycon-harness--wt-X');
  git(E.repo, 'worktree', 'add', '-q', '-b', 'wt/X', copiaPublico, 'main');
  const producto = path.join(E.base, 'tycon-harness-producto', 'tycon-harness');
  fs.mkdirSync(producto, { recursive: true });
  git(producto, 'init', '-q');
  git(producto, 'remote', 'add', 'origin', 'https://dev.azure.com/acme/Producto/_git/backend');
  const privado = path.join(E.base, 'mantenimiento');
  fs.mkdirSync(privado);
  git(privado, 'init', '-q', '-b', 'main');
  git(privado, 'remote', 'add', 'origin', 'https://dev.azure.com/acme/arnes/_git/mantenimiento');
  const skills = path.join(E.base, 'skills-clon');
  fs.mkdirSync(skills);
  git(skills, 'init', '-q');
  git(skills, 'remote', 'add', 'origin', 'https://example.com/acme/skills-viejas.git');
  const conSkills = path.join(E.base, 'con-skills');
  fs.mkdirSync(conSkills);
  git(conSkills, 'init', '-q');
  git(conSkills, 'remote', 'add', 'origin', 'https://example.com/acme/skills-viejas.git');

  const vacia = fs.mkdtempSync(path.join(os.tmpdir(), 'own-copy-home-'));
  const conMaint = fs.mkdtempSync(path.join(os.tmpdir(), 'own-copy-home-'));
  const cfg = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js')).ownPaths({ env: { ...process.env, HOME: conMaint } }).config;
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ paths: { maintainers: privado } }));
  const situaciones = {
    'sin clon ni paths.maintainers': { ...process.env, HOME: vacia, TYCON_SKILLS_DIR: '' },
    'con paths.maintainers': { ...process.env, HOME: conMaint, TYCON_SKILLS_DIR: '' },
    'con TYCON_SKILLS_DIR': { ...process.env, HOME: vacia, TYCON_SKILLS_DIR: skills },
  };
  for (const [nombre, env] of Object.entries(situaciones)) {
    assert.strictEqual(sinCopiaPropia(E.repo, { env }).sin, true, `${nombre}: el público`);
    assert.strictEqual(sinCopiaPropia(copiaPublico, { env }).sin, true, `${nombre}: una copia del público`);
    assert.strictEqual(sinCopiaPropia(producto, { env }).sin, false, `${nombre}: un producto bajo una carpeta llamada como el arnés`);
    assert.strictEqual(sinCopiaPropia(privado, { env }).sin, false, `${nombre}: el privado de mantenimiento`);
    assert.strictEqual(sinCopiaPropia(conSkills, { env }).sin, nombre === 'con TYCON_SKILLS_DIR', `${nombre}: un clon del remoto de agent-skills`);
  }

  // de punta a punta: en el público, con otra sesión viva, start no pausa por la copia, lo dice, y own-copy se niega
  E.otra();
  const r = E.arrancar('la-mia');
  assert.ok(!pausas(r).includes('PIPE-C6-own-copy'), out(r));
  assert.match(acciones(r), /PIPE-C6-own-copy: hay otra sesión viva en este checkout .*una sola sesión toca git a la vez/);
  assert.strictEqual(E.copiar().status, 2);
});

test('SC6 Start_CoordinatorAlive_Or_Alone_AsToday @story-8.292 @ac-6', () => {
  // 🔴 mutación: pedir copia con coordinadora viva, decir algo sin nadie más, o sacar de la cuenta a `_nosession`
  const E = entorno();
  // (b) nadie más: como hoy
  const solo = E.arrancar('la-mia');
  assert.ok(!pausas(solo).includes('PIPE-C6-own-copy'), out(solo));
  assert.strictEqual(json(solo).own_copy, undefined);
  assert.doesNotMatch(acciones(solo), /PIPE-C6-own-copy/);

  // (a) con coordinadora viva: sin pausa y un renglón con la otra sesión
  const E2 = entorno();
  E2.otra();
  const sl = require(path.join(RAIZ, 'scripts', 'lib', 'signature-list.js'));
  const orig = sl.coordinadoraViva;
  const prevHome = process.env.HOME;
  const prevSid = process.env.CLAUDE_CODE_SESSION_ID;
  sl.coordinadoraViva = () => 'la-coordinadora';
  process.env.CLAUDE_CODE_SESSION_ID = 'la-mia';
  let c;
  try { c = require(path.join(SCRIPTS, 'pipeline.js')).copiaPropia({ repo: E2.repo, storyPath: E2.story, home: E2.home }); } finally {
    sl.coordinadoraViva = orig;
    if (prevSid == null) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prevSid;
    process.env.HOME = prevHome;
  }
  assert.strictEqual(c.pause, undefined, JSON.stringify(c));
  assert.match(c.actions.join('\n'), /hay coordinadora/);
  assert.match(c.actions.join('\n'), /otra-ses/);

  // (c) sin id propio: no se saca nada por id, y lo dice
  const sinId = E2.arrancar(null);
  assert.match(acciones(sinId), /_nosession/, out(sinId));

  // (d) otra corrida de la MISMA historia no pide copia: es de PIPE-C0
  const E3 = entorno();
  E3.otra({ storyId: '9.9', storyPath: E3.story, batch: 'otra-tanda' });
  const misma = E3.arrancar('la-mia');
  assert.ok(!pausas(misma).includes('PIPE-C6-own-copy'), out(misma));
  assert.doesNotMatch(acciones(misma), /PIPE-C6-own-copy: hay otra/);

  // (e) TYCON_OWN_COPY=0, la llave de la persona: no pausa y lo dice; escrita por el agente en un comando, la frena
  // el freno de escapes
  const E4 = entorno();
  E4.otra();
  const apagada = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'start', '--story', E4.story, '--repo', E4.repo, '--brief'], { encoding: 'utf8', env: { ...E4.env('la-mia'), TYCON_OWN_COPY: '0' }, input: '', cwd: E4.repo });
  assert.ok(!pausas(apagada).includes('PIPE-C6-own-copy'), out(apagada));
  assert.match(acciones(apagada), /apagado con TYCON_OWN_COPY=0/);
  const freno = spawnSync('bash', [path.join(RAIZ, 'scripts', 'hooks', 'safety-guard-pre.sh')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'la-mia', cwd: E4.repo, tool_input: { command: `TYCON_OWN_COPY=0 node pipeline.js start --story ${E4.story} --repo ${E4.repo}` } }),
    encoding: 'utf8', env: { ...E4.env('la-mia') }, cwd: E4.repo,
  });
  assert.strictEqual(freno.status, 2, out(freno));
  assert.match(out(freno), /ESC-C1/);
  assert.match(out(freno), /TYCON_OWN_COPY/);
});

test('SC7 Step01_TellsAgentToMove @story-8.292 @ac-7', () => {
  // 🔴 mutación: volver a pedir el worktree a mano, o no decir que se vuelve a correr start desde la copia
  const texto = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-01-start.md'), 'utf8');
  const i = texto.indexOf('Stories DISTINTAS en paralelo sobre el mismo repo');
  assert.ok(i >= 0, 'el párrafo sigue');
  const parrafo = texto.slice(i, i + 2500);
  for (const k of ['PIPE-C6-own-copy', 'own_copy.command', 'EnterWorktree', 'path', 'cd <copia> &&', 'decíselo a la persona', 'volvé a correr `start`']) {
    assert.ok(parrafo.toLowerCase().includes(k.toLowerCase()), `falta «${k}»`);
  }
  assert.doesNotMatch(parrafo.split('\n\n')[0], /tycon-worktree\.sh new/, 'ya no pide el worktree a mano');
});
