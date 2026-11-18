'use strict';

/**
 * start-own-copy.test.js — con otra sesión viva en el mismo checkout, la historia arranca en su propia copia de trabajo
 * (los casos, abajo).
 *
 * Lo que no se puede perder:
 *   - Sin coordinadora y fuera del arnés, `start` crea `<principal>--wt-<clave>` con la rama `wt/<clave>` (o la primera
 *     clave libre) y deja el marcador y la corrida en la copia; el checkout compartido no cambia.
 *   - La copia nace de origin/main si la historia está ahí igual, si no de HEAD; una historia sin commitear pausa sin
 *     tocar nada (ni copia, ni stash, ni archivos movidos).
 *   - Si traer main o crear la copia falla, pausa, saca lo que dejó y no escribe marcador.
 *   - En el arnés, en sus copias y en agent-skills no crea copia y lo dice; con coordinadora viva o sin nadie más, como hoy.
 *
 * Todo corre con un HOME de laboratorio (el arnés de la máquina no se toca), repos de juguete con un origin local y git
 * sin hooks.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const SID = 'lab-copia-propia-8292';
const OTRA = 'aaaa1111-otra-sesion';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `copia-${p}-`)));

function laboratorio() {
  const home = tmp('home');
  // `start` llama a marker.js por ~/.claude/agent-skills: el de este árbol (no el de la máquina)
  const skills = path.join(home, '.claude', 'agent-skills');
  fs.mkdirSync(path.dirname(skills), { recursive: true });
  fs.symlinkSync(RAIZ, skills, 'junction');
  return { home, lab: tmp('lab') };
}
function entorno(home, extra = {}) {
  const env = { ...process.env };
  for (const k of ['TYCON_GUIDES_DIR', 'TCG', 'NODE_TEST_CONTEXT', 'TYCON_SKILLS_DIR', 'TYCON_HOME', 'TYCON_STATE_DIR', 'TYCON_SUITE_TURN',
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'TYCON_SESSION_GUARD_MIN']) delete env[k];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_SESSION_ID: SID, TYCON_AUTO_SNAPSHOT: '0',
    TYCON_PACKS_DEFAULT: 'none', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'acme@example.invalid', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'acme@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-15T12:00:00Z', GIT_COMMITTER_DATE: '2026-01-15T12:00:00Z',
  }, extra);
  return env;
}
const git = (home, dir, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args],
  { env: entorno(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const stateDir = (home) => require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(home);

/** Un repo `nombre` dentro de `lab`, clonado de un origin local, con la historia commiteada y empujada a main. */
function producto(L, nombre = 'producto', { historiaEnMain = true } = {}) {
  const origin = path.join(L.lab, `${nombre}-origin.git`);
  git(L.home, L.lab, 'init', '-q', '--bare', '-b', 'main', origin);
  const d = path.join(L.lab, nombre);
  git(L.home, L.lab, 'clone', '-q', origin, d);
  git(L.home, d, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'README.md'), '# acme\n');
  if (historiaEnMain) historia(d);
  git(L.home, d, 'add', '-A');
  git(L.home, d, 'commit', '-q', '-m', 'inicio');
  git(L.home, d, 'push', '-q', 'origin', 'main');
  // se trabaja en una rama de trabajo, como manda PIPE-C1 (en main, start pausa)
  git(L.home, d, 'checkout', '-q', '-b', 'trabajo');
  return d;
}
function historia(dir) {
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  const f = path.join(dir, 'specs', 'story-1-1.md');
  fs.writeFileSync(f, ['---', 'epic: 1', 'story: "1.1"', 'title: "enPesos"', 'status: ready-for-dev', '---', '',
    '# Story 1.1: enPesos', '', '### Tests (1 verificaciones)', '', '| # | Test | AC |', '|---|---|---|', '| T1 | `X` | 1 |', ''].join('\n'));
  return f;
}
/** Otra sesión viva en `repo`, por su marcador del pipeline. stable-data: `start` mide la vida de un marcador contra el
 * reloj real, así que el marcador tiene que ser de ahora. */
function otraViva(home, repo, sid = OTRA) {
  const dir = path.join(stateDir(home), 'active');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ sessionId: sid, storyId: '2.2', repoPath: repo, stepsPending: ['plan'], lastTouch: new Date().toISOString() }));
}
const clave = (story) => require(path.join(SCRIPTS, 'lib', 'run-dir.js')).runDirKey('1.1', story).key;
function start(L, story, repo, extra) {
  const r = spawnSync(process.execPath, [PIPELINE, 'start', '--story', story, '--repo', repo], { env: entorno(L.home, extra), encoding: 'utf8', cwd: repo });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* no es JSON */ }
  assert.ok(json, `start no devolvió JSON: ${r.stdout}${r.stderr}`);
  return { json, status: r.status };
}
const miMarcador = (home) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir(home), 'active', `${SID}.json`), 'utf8')); } catch (_) { return null; } };
const foto = (L, d) => ({ head: git(L.home, d, 'rev-parse', 'HEAD'), rama: git(L.home, d, 'rev-parse', '--abbrev-ref', 'HEAD'), status: git(L.home, d, 'status', '--porcelain'), stash: git(L.home, d, 'stash', 'list') });

test('SC1 Start_OtherSessionAlive_CreatesOwnCopy @story-8.292 @ac-2', () => {
  // 🔴 mutación: seguir en el checkout compartido (sin copia), o escribir el marcador contra el checkout
  const L = laboratorio();
  const d = producto(L);
  const story = path.join(d, 'specs', 'story-1-1.md');
  otraViva(L.home, d);
  const antes = foto(L, d);
  const { json, status } = start(L, story, d);
  assert.strictEqual(status, 0, JSON.stringify(json));
  assert.strictEqual(json.ready, true, JSON.stringify(json));
  const k = clave(story);
  const w = json.work_copy;
  assert.ok(w, JSON.stringify(json));
  assert.strictEqual(w.path, `${d}--wt-${k}`);
  assert.strictEqual(w.branch, `wt/${k}`);
  assert.strictEqual(w.base, 'origin/main');
  assert.strictEqual(w.created, true);
  assert.match(w.because, /aaaa1111/);
  assert.ok(Array.isArray(w.checklist) && w.checklist.length, 'el checklist de la copia');
  assert.ok(json.actions_done.some((a) => /PIPE-C10/.test(a) && a.includes(w.path)), json.actions_done.join('\n'));
  assert.strictEqual(git(L.home, w.path, 'rev-parse', '--abbrev-ref', 'HEAD'), w.branch);
  const m = miMarcador(L.home);
  assert.strictEqual(fs.realpathSync(m.repoPath), fs.realpathSync(w.path));
  assert.ok(fs.realpathSync(m.storyPath).startsWith(fs.realpathSync(w.path) + path.sep), m.storyPath);
  assert.ok(!m.runDir || fs.realpathSync(path.dirname(path.dirname(path.dirname(m.runDir)))) === fs.realpathSync(w.path), m.runDir);
  assert.deepStrictEqual(foto(L, d), antes, 'el checkout compartido no cambia');
});

test('SC2 Start_CopyNameTaken_TriesNext @story-8.292 @ac-2', () => {
  // 🔴 mutación: pisar o reusar la carpeta o la rama que ya existen
  const L = laboratorio();
  const d = producto(L);
  const story = path.join(d, 'specs', 'story-1-1.md');
  const k = clave(story);
  fs.mkdirSync(`${d}--wt-${k}`);
  fs.writeFileSync(path.join(`${d}--wt-${k}`, 'de-otro.txt'), 'x');
  git(L.home, d, 'branch', `wt/${k}-2`);
  otraViva(L.home, d);
  const { json } = start(L, story, d);
  assert.strictEqual(json.work_copy.path, `${d}--wt-${k}-3`, JSON.stringify(json));
  assert.strictEqual(json.work_copy.branch, `wt/${k}-3`);
  assert.deepStrictEqual(fs.readdirSync(`${d}--wt-${k}`), ['de-otro.txt'], 'la carpeta ajena no se toca');
  assert.ok(!fs.existsSync(`${d}--wt-${k}-2`), 'la rama ajena no se usa');
});

test('SC3 Start_StoryOnlyInHead_BaseHead_StoryUncommitted_Pauses @story-8.292 @ac-3', () => {
  // 🔴 mutación: copiar o guardar en un stash la historia sin commitear, o nacer siempre de origin/main
  // (a) la historia commiteada sólo en la rama del checkout
  const L = laboratorio();
  const d = producto(L, 'producto', { historiaEnMain: false });
  git(L.home, d, 'checkout', '-q', '-b', 'mi-rama');
  const story = historia(d);
  git(L.home, d, 'add', '-A');
  git(L.home, d, 'commit', '-q', '-m', 'la historia');
  otraViva(L.home, d);
  const a = start(L, story, d).json;
  assert.strictEqual(a.work_copy && a.work_copy.base, 'HEAD', JSON.stringify(a));
  assert.ok(fs.existsSync(path.join(a.work_copy.path, 'specs', 'story-1-1.md')));
  // (b) la historia sin commitear
  const L2 = laboratorio();
  const d2 = producto(L2, 'producto', { historiaEnMain: false });
  const s2 = historia(d2);
  otraViva(L2.home, d2);
  const antes = foto(L2, d2);
  const b = start(L2, s2, d2).json;
  assert.strictEqual(b.ready, false, JSON.stringify(b));
  assert.ok(b.pauses.some((p) => p.id === 'PIPE-C10-own-copy' && /commite/.test(p.detail)), JSON.stringify(b.pauses));
  assert.ok(!b.work_copy);
  assert.deepStrictEqual(foto(L2, d2), antes, 'ni stash, ni archivos movidos');
  assert.deepStrictEqual(fs.readdirSync(L2.lab).filter((x) => x.includes('--wt-')), [], 'ninguna copia');
  assert.strictEqual(miMarcador(L2.home), null, 'ningún marcador');
  // (c) la historia en otro repo: la copia es del repo del código, desde origin/main, con la misma ruta de la historia
  const L3 = laboratorio();
  const d3 = producto(L3, 'producto', { historiaEnMain: false });
  const specs = path.join(L3.lab, 'specs-repo');
  fs.mkdirSync(specs);
  git(L3.home, specs, 'init', '-q');
  const s3 = historia(specs);
  otraViva(L3.home, d3);
  const c = start(L3, s3, d3).json;
  assert.strictEqual(c.work_copy && c.work_copy.base, 'origin/main', JSON.stringify(c));
  const m = miMarcador(L3.home);
  assert.strictEqual(fs.realpathSync(m.repoPath), fs.realpathSync(c.work_copy.path));
  assert.strictEqual(fs.realpathSync(m.storyPath), fs.realpathSync(s3));
});

test('SC4 Start_WorktreeAddFails_PausesAndCleans @story-8.292 @ac-4', { skip: process.getuid && process.getuid() === 0 ? 'como root se escribe en todo' : false }, () => {
  // 🔴 mutación: dejar la carpeta o la rama del intento, escribir el marcador, o seguir en el checkout compartido
  // (a) origin inalcanzable
  const L = laboratorio();
  const d = producto(L);
  const story = path.join(d, 'specs', 'story-1-1.md');
  git(L.home, d, 'remote', 'set-url', 'origin', path.join(L.lab, 'no-existe.git'));
  otraViva(L.home, d);
  const ramas = git(L.home, d, 'branch', '--list');
  const a = start(L, story, d).json;
  assert.strictEqual(a.ready, false, JSON.stringify(a));
  const pa = a.pauses.find((p) => p.id === 'PIPE-C10-own-copy');
  assert.ok(pa && /origin|main/i.test(pa.detail), JSON.stringify(a.pauses));
  assert.strictEqual(miMarcador(L.home), null);
  assert.strictEqual(git(L.home, d, 'branch', '--list'), ramas);
  // (b) `worktree add` no puede crear la carpeta (la carpeta de al lado no se puede escribir)
  const L2 = laboratorio();
  const d2 = producto(L2);
  const s2 = path.join(d2, 'specs', 'story-1-1.md');
  otraViva(L2.home, d2);
  const ramas2 = git(L2.home, d2, 'branch', '--list');
  fs.chmodSync(L2.lab, 0o555);
  let b;
  try { b = start(L2, s2, d2).json; } finally { fs.chmodSync(L2.lab, 0o755); }
  assert.strictEqual(b.ready, false, JSON.stringify(b));
  assert.ok(b.pauses.some((p) => p.id === 'PIPE-C10-own-copy'), JSON.stringify(b.pauses));
  assert.deepStrictEqual(fs.readdirSync(L2.lab).filter((x) => x.includes('--wt-')), []);
  assert.strictEqual(git(L2.home, d2, 'branch', '--list'), ramas2, 'la rama del intento no queda');
  assert.strictEqual(miMarcador(L2.home), null);
});

test('SC5 Start_HarnessOrAgentSkills_NoCopyWarns @story-8.292 @ac-5', () => {
  // 🔴 mutación: crear la copia en el arnés, en una copia suya o en agent-skills
  for (const nombre of ['tycon-harness', 'agent-skills']) {
    const L = laboratorio();
    const d = producto(L, nombre);
    const story = path.join(d, 'specs', 'story-1-1.md');
    otraViva(L.home, d);
    const { json } = start(L, story, d);
    assert.ok(!json.work_copy, `${nombre}: ${JSON.stringify(json)}`);
    assert.ok((json.warnings || []).some((w) => /otra sesión viva en este checkout/.test(w) && /una sola sesión toca git a la vez/.test(w) && /coordinala o esperala/.test(w)), `${nombre}: ${JSON.stringify(json.warnings)}`);
    assert.strictEqual(fs.realpathSync(miMarcador(L.home).repoPath), fs.realpathSync(d), `${nombre}: sigue como hoy`);
  }
  // una copia del arnés (`tycon-harness--wt-x`) tampoco
  const L = laboratorio();
  const d = producto(L, 'tycon-harness');
  const copia = `${d}--wt-x`;
  git(L.home, d, 'worktree', 'add', '-q', '-b', 'wt/x', copia);
  otraViva(L.home, copia);
  const { json } = start(L, path.join(copia, 'specs', 'story-1-1.md'), copia);
  assert.ok(!json.work_copy, JSON.stringify(json));
  assert.ok((json.warnings || []).some((w) => /una sola sesión toca git a la vez/.test(w)), JSON.stringify(json.warnings));
});

test('SC6 Start_CoordinatorAlive_Or_Alone_AsToday @story-8.292 @ac-6', () => {
  // 🔴 mutación: crear la copia con la coordinadora viva, o sumar work_copy cuando no hay nadie más
  // (a) coordinadora designada y viva (su sesión con el pid de este proceso)
  const L = laboratorio();
  const d = producto(L);
  const story = path.join(d, 'specs', 'story-1-1.md');
  otraViva(L.home, d);
  const st = stateDir(L.home);
  fs.mkdirSync(st, { recursive: true });
  fs.writeFileSync(path.join(st, 'gates.log'), `${JSON.stringify({ name: 'relay-designation', status: 'ok', sesion: 'coord-1', cita: 'designada', ts: new Date().toISOString() })}\n`);
  const sessions = path.join(L.home, '.claude', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'coord-1.json'), JSON.stringify({ sessionId: 'coord-1', pid: process.pid, cwd: L.lab }));
  const a = start(L, story, d).json;
  assert.ok(!a.work_copy, JSON.stringify(a));
  assert.ok((a.warnings || []).some((w) => /aaaa1111/.test(w) && /coordinadora/.test(w)), JSON.stringify(a.warnings));
  assert.strictEqual(fs.realpathSync(miMarcador(L.home).repoPath), fs.realpathSync(d));
  // (b) nadie más: como hoy, sin work_copy ni aviso de otra sesión
  const L2 = laboratorio();
  const d2 = producto(L2);
  const b = start(L2, path.join(d2, 'specs', 'story-1-1.md'), d2).json;
  assert.strictEqual(b.ready, true, JSON.stringify(b));
  assert.ok(!('work_copy' in b), JSON.stringify(b));
  assert.ok(!(b.warnings || []).some((w) => /otra sesión/.test(w)));
  assert.strictEqual(fs.realpathSync(miMarcador(L2.home).repoPath), fs.realpathSync(d2));
  // (c) un repo sin origin (local): no hay main que traer; como hoy, con el aviso, y nada creado
  // 🔴 mutación: pausar con PIPE-C10-own-copy (las corridas de juguete de otras suites no arrancarían)
  const L3 = laboratorio();
  const d3 = producto(L3);
  git(L3.home, d3, 'remote', 'remove', 'origin');
  otraViva(L3.home, d3);
  const c = start(L3, path.join(d3, 'specs', 'story-1-1.md'), d3).json;
  assert.strictEqual(c.ready, true, JSON.stringify(c));
  assert.ok(!c.work_copy, JSON.stringify(c));
  assert.ok((c.warnings || []).some((w) => /aaaa1111/.test(w) && /no tiene origin/.test(w)), JSON.stringify(c.warnings));
  assert.ok(!fs.readdirSync(path.dirname(d3)).some((n) => n.includes('--wt-')), 'no se creó ninguna copia');
});

test('SC8 Start_RepeatedFromCheckout_ReusesItsCopy @story-8.292 @ac-2', () => {
  // 🔴 mutación: crear otra copia y dejar la primera, con su corrida, sin dueño
  const L = laboratorio();
  const d = producto(L);
  const story = path.join(d, 'specs', 'story-1-1.md');
  otraViva(L.home, d);
  const uno = start(L, story, d).json;
  assert.strictEqual(uno.work_copy.created, true, JSON.stringify(uno));
  const dos = start(L, story, d).json;
  assert.strictEqual(dos.ready, true, JSON.stringify(dos));
  assert.strictEqual(dos.work_copy.path, uno.work_copy.path);
  assert.strictEqual(dos.work_copy.branch, uno.work_copy.branch);
  assert.strictEqual(dos.work_copy.created, false);
  assert.strictEqual(fs.readdirSync(path.dirname(d)).filter((n) => n.includes('--wt-')).length, 1, 'una sola copia');
  assert.strictEqual(fs.realpathSync(miMarcador(L.home).repoPath), fs.realpathSync(uno.work_copy.path));
  // con el marcador propio ilegible no se sabe qué copia tenía: abre otra, y lo dice
  // 🔴 mutación: tomar el marcador roto como «no había copia» sin avisar
  fs.writeFileSync(path.join(stateDir(L.home), 'active', `${SID}.json`), '{roto');
  const tres = start(L, story, d).json;
  assert.ok((tres.warnings || []).some((w) => /no pude leer el marcador de esta sesión/.test(w)), JSON.stringify(tres.warnings));
});

test('SC9 Start_OneSourceUnreadable_SaysSo @story-8.292 @ac-6', { skip: process.getuid && process.getuid() === 0 ? 'como root se lee todo' : false }, () => {
  // 🔴 mutación: avisar sólo si fallan las dos fuentes: con una ilegible y la otra sin nadie, seguir callado
  const L = laboratorio();
  const d = producto(L);
  const projects = path.join(L.home, '.claude', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  fs.chmodSync(projects, 0o000);
  try {
    const r = start(L, path.join(d, 'specs', 'story-1-1.md'), d).json;
    assert.strictEqual(r.ready, true, JSON.stringify(r));
    assert.ok(!r.work_copy, JSON.stringify(r));
    assert.ok((r.warnings || []).some((w) => /no pude ver si hay otra sesión/.test(w)), JSON.stringify(r.warnings));
  } finally { fs.chmodSync(projects, 0o755); }
});

test('SC7 Step01_TellsAgentToMove @story-8.292 @ac-7', () => {
  // 🔴 mutación: volver a pedir el worktree a mano, o mandar a EnterWorktree (no entra a una copia hermana)
  const doc = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-01-start.md'), 'utf8');
  const parrafo = doc.slice(doc.indexOf('**Stories DISTINTAS en paralelo sobre el mismo repo**'), doc.indexOf('### PIPE-C1'));
  assert.ok(parrafo.length > 100, 'el párrafo existe');
  assert.match(parrafo, /work_copy/);
  assert.match(parrafo, /cd <copia> &&/);
  assert.match(parrafo, /ruta absoluta/);
  assert.match(parrafo, /EnterWorktree/);
  assert.match(parrafo, /decíselo a la persona/i);
  assert.match(parrafo, /checklist/);
  assert.match(parrafo, /PIPE-C10-own-copy/);
  assert.doesNotMatch(parrafo, /tycon-worktree\.sh new/);
});
