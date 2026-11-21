'use strict';
// bash-write-after.test.js — la segunda capa del freno de escrituras por consola (on-bash-write-after.js): la foto de
// lo protegido antes del comando y la mirada de después, por contenido.
//
// Lo que no se puede perder:
//   · la foto trae sólo lo protegido: historias, constancias y marcadores; el código no;
//   · una historia que no está en borrador, cambiada por un intérprete que el shell resuelve al correr, vuelve a lo que
//     tenía, aunque el guion le devuelva el tamaño y la hora; queda el renglón en gates.log y el aviso al agente;
//   · un borrador que deja de serlo vuelve; una historia nueva fuera de borrador se borra; el cuerpo de un borrador no;
//   · una constancia nueva se borra y una borrada vuelve;
//   · lo que escribe marker.js (o un guion de este arnés) no se deshace; un comando que lo mezcla con otro, sí, entero.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HOOK = path.resolve(__dirname, '..', 'on-bash-write-after.js');
const MARKER = path.resolve(__dirname, '..', 'marker.js');
const historia = (id, status, cuerpo = 'cuerpo') => `---\nstory: "${id}"\ntitle: Historia ${id}\nstatus: ${status}\n---\n\n# ${id}\n\n${cuerpo}\n`;

function lab() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'write-after-'));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.tycon', 'control-changes'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'specs', 'story-1.1-hecha.md'), historia('1.1', 'in-progress'));
  fs.writeFileSync(path.join(repo, 'specs', 'story-1.2-borrador.md'), historia('1.2', 'draft'));
  fs.writeFileSync(path.join(repo, 'src', 'x.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, '.tycon', 'control-changes', 'c1.json'), '{"ok":true}\n');
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
  const estado = require(path.resolve(__dirname, '..', 'lib', 'state-dir.js')).stateDir(home);
  return { base, repo, home, env, estado, f: (rel) => path.join(repo, rel) };
}

let n = 0;
/** Corre el gancho antes, el comando (o `hacer`, en lugar del comando), y el gancho después. */
function correr(l, comando, { hacer = null, evento = 'PostToolUse', sesion = 's1' } = {}) {
  const id = `toolu_${++n}`;
  const ev = (hook_event_name) => JSON.stringify({ session_id: sesion, tool_use_id: id, cwd: l.repo, hook_event_name, tool_name: 'Bash', tool_input: { command: comando } });
  const pre = spawnSync(process.execPath, [HOOK], { input: ev('PreToolUse'), env: l.env, encoding: 'utf8' });
  assert.strictEqual(pre.status, 0, pre.stderr);
  if (hacer) hacer(); else spawnSync('bash', ['-c', comando], { cwd: l.repo, env: l.env, encoding: 'utf8' });
  const post = spawnSync(process.execPath, [HOOK], { input: ev(evento), env: l.env, encoding: 'utf8' });
  assert.strictEqual(post.status, 0, post.stderr);
  const ctx = post.stdout.trim() ? JSON.parse(post.stdout).hookSpecificOutput.additionalContext : '';
  return { ctx, gates: fs.existsSync(path.join(l.estado, 'gates.log')) ? fs.readFileSync(path.join(l.estado, 'gates.log'), 'utf8') : '' };
}
const guion = (l, nombre, cuerpo) => { const f = path.join(l.base, nombre); fs.writeFileSync(f, cuerpo); return f; };

test('T1 · WriteAfter_PhotoTaken_ProtectedOnly @story-8.320 @ac-1 @ac-4', () => {
  const l = lab();
  fs.mkdirSync(path.join(l.estado, 'active'), { recursive: true });
  fs.writeFileSync(path.join(l.estado, 'active', 's1.json'), '{}');
  const foto = require('../lib/protected-photo.js');
  const f = foto.takePhoto({ roots: [fs.realpathSync(l.repo)], stateDir: l.estado });
  const rutas = Object.keys(f.files).map((a) => path.basename(a)).sort();
  assert.deepStrictEqual(rutas, ['c1.json', 's1.json', 'story-1.1-hecha.md', 'story-1.2-borrador.md']);
  assert.ok(foto.photoIntact(f));
  assert.ok(!foto.photoIntact({ ...f, files: {} }), 'una foto cambiada no coincide con su huella');
});

test('T2 · WriteAfter_StoryChangedByNodeInVariable_Restored @story-8.320 @ac-2', () => {
  const l = lab();
  const antes = fs.readFileSync(l.f('specs/story-1.1-hecha.md'), 'utf8');
  const x = guion(l, 'x.js', `const fs=require('fs');const f=${JSON.stringify(l.f('specs/story-1.1-hecha.md'))};fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('in-progress','done'));`);
  const r = correr(l, `N=node; \${N:-node} ${x}`);
  assert.strictEqual(fs.readFileSync(l.f('specs/story-1.1-hecha.md'), 'utf8'), antes, 'la historia vuelve');
  assert.match(r.ctx, /SE DESHIZO/);
  assert.match(r.ctx, /story-1\.1-hecha\.md: se cambió; volvió a lo que tenía/);
  const renglon = JSON.parse(r.gates.trim().split('\n').pop());
  assert.strictEqual(renglon.name, 'escritura-vista-despues');
  assert.strictEqual(renglon.sesion, 's1');
  assert.ok(!r.gates.includes('cuerpo'), 'el registro no lleva el contenido');
});

test('T13 · WriteAfter_SameSizeAndTimeRestored_StillUndone @story-8.320 @ac-2', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  const antes = fs.readFileSync(f, 'utf8');
  const x = guion(l, 'y.js', `const fs=require('fs');const f=${JSON.stringify(f)};const s=fs.statSync(f);fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('in-progress','in-progresz'));fs.utimesSync(f,s.atime,s.mtime);`);
  const r = correr(l, `P=node; $P ${x}`);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), antes);
  assert.match(r.ctx, /se cambió/);
});

test('T14 · WriteAfter_DraftLeavesDraft_AndNewStoryNotDraft_Undone @story-8.320 @ac-2 @ac-4', () => {
  const l = lab();
  const borrador = l.f('specs/story-1.2-borrador.md');
  const antes = fs.readFileSync(borrador, 'utf8');
  correr(l, 'cosa', { hacer: () => fs.writeFileSync(borrador, historia('1.2', 'ready-for-dev')) });
  assert.strictEqual(fs.readFileSync(borrador, 'utf8'), antes, 'el borrador que deja de serlo vuelve');
  const nueva = l.f('specs/story-1.3-nueva.md');
  const r = correr(l, 'cosa', { hacer: () => fs.writeFileSync(nueva, historia('1.3', 'review')) });
  assert.ok(!fs.existsSync(nueva), 'la historia nueva fuera de borrador se borra');
  assert.match(r.ctx, /se creó fuera de borrador .*lo borré/);
  const r3 = correr(l, 'cosa', { hacer: () => fs.writeFileSync(borrador, historia('1.2', 'draft', 'otro cuerpo')) });
  assert.match(fs.readFileSync(borrador, 'utf8'), /otro cuerpo/, 'el cuerpo de un borrador se edita libre');
  assert.strictEqual(r3.ctx, '');
  const r4 = correr(l, 'cosa', { hacer: () => fs.writeFileSync(l.f('specs/story-1.4-otra.md'), historia('1.4', 'draft')) });
  assert.ok(fs.existsSync(l.f('specs/story-1.4-otra.md')), 'una historia nueva en borrador queda');
  assert.strictEqual(r4.ctx, '');
});

test('T3 · WriteAfter_ConstanciaCreatedOrDeleted_Restored @story-8.320 @ac-3', () => {
  const l = lab();
  const nueva = l.f('.tycon/control-changes/c2.json');
  const r = correr(l, `$S -c 'open("${nueva}","w").write("{}")'`, { hacer: () => fs.writeFileSync(nueva, '{}') });
  assert.ok(!fs.existsSync(nueva), 'la constancia nueva no queda');
  assert.match(r.ctx, /c2\.json: se creó; lo borré/);
  const vieja = l.f('.tycon/control-changes/c1.json');
  correr(l, 'cosa', { hacer: () => fs.rmSync(vieja) });
  assert.strictEqual(fs.readFileSync(vieja, 'utf8'), '{"ok":true}\n', 'la borrada vuelve');
  const jsonl = l.f('.github/control-changes.jsonl');
  correr(l, 'cosa', { hacer: () => { fs.mkdirSync(path.dirname(jsonl), { recursive: true }); fs.writeFileSync(jsonl, '{}\n'); } });
  assert.ok(!fs.existsSync(jsonl), 'el registro de constancias creado se borra');
});

test('T4 · WriteAfter_DraftAndCode_Untouched @story-8.320 @ac-4', () => {
  const l = lab();
  const r = correr(l, 'cosa', { hacer: () => { fs.writeFileSync(l.f('src/x.js'), 'module.exports = 2;\n'); fs.writeFileSync(l.f('README.md'), 'hola\n'); } });
  assert.strictEqual(fs.readFileSync(l.f('src/x.js'), 'utf8'), 'module.exports = 2;\n');
  assert.strictEqual(r.ctx, '');
  assert.strictEqual(r.gates, '');
});

test('T5 · WriteAfter_MarkerJsAndInstalledScript_NotUndone @story-8.320 @ac-5', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  const r = correr(l, `cd ${l.repo} && node "${MARKER}" update-story-status ${f} review`, { hacer: () => fs.writeFileSync(f, historia('1.1', 'review')) });
  assert.match(fs.readFileSync(f, 'utf8'), /status: review/, 'lo de marker.js queda');
  assert.strictEqual(r.ctx, '');
  // un marcador que se borra por un programa que no es del arnés vuelve; con marker.js, no
  fs.mkdirSync(path.join(l.estado, 'active'), { recursive: true });
  const marca = path.join(l.estado, 'active', 's1.json');
  fs.writeFileSync(marca, '{"story":"1.1"}');
  correr(l, `node "${MARKER}" clear`, { hacer: () => fs.rmSync(marca) });
  assert.ok(!fs.existsSync(marca));
  fs.writeFileSync(marca, '{"story":"1.1"}');
  correr(l, 'R=rm; $R marca', { hacer: () => fs.rmSync(marca) });
  assert.strictEqual(fs.readFileSync(marca, 'utf8'), '{"story":"1.1"}');
});

test('T15 · WriteAfter_MixedRecognizedAndOther_UndoneWithAdvice @story-8.320 @ac-5', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  const antes = fs.readFileSync(f, 'utf8');
  for (const comando of [`node "${MARKER}" update-story-status ${f} review; \${N:-node} x.js`, `node "${MARKER}" update-story-status ${f} review > ${f}`, `node --require ./x.js "${MARKER}" help`, `node --require=./x.js "${MARKER}" help`]) {
    const r = correr(l, comando, { hacer: () => fs.writeFileSync(f, historia('1.1', 'review')) });
    assert.strictEqual(fs.readFileSync(f, 'utf8'), antes, comando);
    if (!comando.includes('>') && !comando.includes('--require')) assert.match(r.ctx, /marker\.js en un comando aparte/);
  }
});

test('WriteAfter_PostToolUseFailure_AlsoUndone @story-8.320 @ac-12', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  const antes = fs.readFileSync(f, 'utf8');
  correr(l, 'cosa; exit 1', { hacer: () => fs.writeFileSync(f, historia('1.1', 'done')), evento: 'PostToolUseFailure' });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), antes);
});

test('WriteAfter_KillSwitch_DoesNothing', () => {
  const l = lab();
  l.env.TYCON_STORY_GATE = 'off';
  const f = l.f('specs/story-1.1-hecha.md');
  correr(l, 'cosa', { hacer: () => fs.writeFileSync(f, historia('1.1', 'done')) });
  assert.match(fs.readFileSync(f, 'utf8'), /status: done/);
});

test('WriteAfter_TamperedPhoto_NotUsedToRestore @story-8.320 @ac-7', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  correr(l, 'cosa', { hacer: () => {
    fs.writeFileSync(f, historia('1.1', 'done'));
    const dir = path.join(l.estado, 'write-photos');
    for (const n2 of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const p = path.join(dir, n2); const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const k of Object.keys(j.files).filter((x) => x.endsWith('story-1.1-hecha.md'))) j.files[k].sha = require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      fs.writeFileSync(p, JSON.stringify(j));
    }
  } });
  assert.match(fs.readFileSync(f, 'utf8'), /status: done/, 'una foto alterada no restaura');
  assert.match(fs.readFileSync(path.join(l.estado, 'hook-errors.log'), 'utf8'), /no se pudo mirar: la foto .* no coincide con su huella/);
});

// ── lo que encontró el pase adversarial ──────────────────────────────────────────────────────────────────────────────

// 🔴 Falla con: algo delante de marker.js (una asignación, otro `node`, una redirección que el lector no ve) que hace
//    pasar el comando como «todo reconocido».
test('WriteAfter_RecognizedOnlyWhenNothingChangesWhatRuns @story-8.320 @ac-5', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  const antes = fs.readFileSync(f, 'utf8');
  const falso = path.join(l.base, 'bin', 'node');
  fs.mkdirSync(path.dirname(falso), { recursive: true });
  fs.writeFileSync(falso, '#!/bin/sh\n');
  for (const comando of [`NODE_OPTIONS=--require=./x.js node "${MARKER}" help`, `PATH=${path.dirname(falso)}:$PATH node "${MARKER}" help`,
    `${falso} "${MARKER}" help`, `echo hola >&${f}; node "${MARKER}" help`, `echo $'\\'' > ${f}; echo '; node "${MARKER}" help'`]) {
    correr(l, comando, { hacer: () => fs.writeFileSync(f, historia('1.1', 'done')) });
    assert.strictEqual(fs.readFileSync(f, 'utf8'), antes, comando);
  }
  // `2>&1` y `>&2` no son archivos; `$HOME/…` hasta marker.js, sí es marker.js
  fs.symlinkSync(path.resolve(__dirname, '..', '..', '..', '..'), path.join(l.home, 'arnes'));
  const conCasa = `node "$HOME/arnes/skills/tycon-pipeline/scripts/marker.js" update-story-status ${f} review 2>&1 >&2`;
  correr(l, conCasa, { hacer: () => fs.writeFileSync(f, historia('1.1', 'review')) });
  assert.match(fs.readFileSync(f, 'utf8'), /status: review/, conCasa);
});

// 🔴 Falla con: la historia cambiada por un enlace, o un `.md` ilegible al lado que apaga la mirada entera.
test('WriteAfter_LinkOrUnreadable_Restored @story-8.320 @ac-2', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  const antes = fs.readFileSync(f, 'utf8');
  const afuera = path.join(l.base, 'afuera.md');
  correr(l, 'cosa', { hacer: () => { fs.writeFileSync(afuera, historia('1.1', 'done')); fs.rmSync(f); fs.symlinkSync(afuera, f); } });
  assert.ok(!fs.lstatSync(f).isSymbolicLink(), 'el enlace se va');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), antes);
  // una historia nueva que es un enlace a una hecha: el arnés la lee por el enlace
  const nueva = l.f('specs/story-1.7-enlace.md');
  correr(l, 'cosa', { hacer: () => fs.symlinkSync(afuera, nueva) });
  assert.ok(!fs.existsSync(nueva) && !(() => { try { return fs.lstatSync(nueva); } catch (_) { return null; } })(), 'el enlace nuevo se borra');
  const ilegible = l.f('specs/zz.md');
  fs.writeFileSync(ilegible, 'x');
  fs.chmodSync(ilegible, 0o000);
  const x = guion(l, 'z.js', `require('fs').writeFileSync(${JSON.stringify(f)}, ${JSON.stringify(historia('1.1', 'done'))});`);
  correr(l, `N=node; \${N:-node} ${x}`);
  fs.chmodSync(ilegible, 0o644);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), antes, 'un .md ilegible al lado no apaga la mirada');
});

// 🔴 Falla con: un borrador que sale de borrador con una clave citada delante, o una historia que deja de declararse.
test('WriteAfter_QuotedStatusOrLostIdentity_Restored @story-8.320 @ac-2', () => {
  const l = lab();
  const b = l.f('specs/story-1.2-borrador.md');
  const antesB = fs.readFileSync(b, 'utf8');
  correr(l, 'cosa', { hacer: () => fs.writeFileSync(b, '---\nstory: "1.2"\n"status": draft\nstatus: done\n---\n') });
  assert.strictEqual(fs.readFileSync(b, 'utf8'), antesB);
  const f = l.f('specs/story-1.1-hecha.md');
  const antes = fs.readFileSync(f, 'utf8');
  const r = correr(l, 'cosa', { hacer: () => fs.writeFileSync(f, antes.replace('story:', 'storyx:').replace('in-progress', 'done')) });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), antes);
  assert.match(r.ctx, /dejó de ser una historia/);
});

// 🔴 Falla con: un `.md` que ya existía y se vuelve historia se borra entero, en vez de volver a lo que tenía.
test('WriteAfter_ExistingMdBecomesStory_RestoredNotDeleted @story-8.320 @ac-2', () => {
  const l = lab();
  const notas = l.f('specs/notas.md');
  fs.writeFileSync(notas, 'mis notas sin commitear\n');
  correr(l, 'cosa', { hacer: () => fs.writeFileSync(notas, historia('1.9', 'ready-for-dev')) });
  assert.strictEqual(fs.readFileSync(notas, 'utf8'), 'mis notas sin commitear\n');
  correr(l, 'cosa', { hacer: () => fs.writeFileSync(notas, 'otras notas\n') });
  assert.strictEqual(fs.readFileSync(notas, 'utf8'), 'otras notas\n', 'un .md que no es historia se edita libre');
});

// 🔴 Falla con: con la carpeta de historias cambiada por un enlace, deshacer borra y escribe en la carpeta de afuera.
test('WriteAfter_StoryDirSwappedForLink_TouchesNothingOutside @story-8.320 @ac-2', () => {
  const l = lab();
  const afuera = path.join(l.base, 'otro-lugar');
  fs.mkdirSync(afuera);
  fs.writeFileSync(path.join(afuera, 'story-5.1-ajena.md'), historia('5.1', 'done'));
  const r = correr(l, 'cosa', { hacer: () => { fs.renameSync(l.f('specs'), l.f('specs.viejo')); fs.symlinkSync(afuera, l.f('specs')); } });
  assert.deepStrictEqual(fs.readdirSync(afuera), ['story-5.1-ajena.md'], 'lo de afuera queda como estaba');
  assert.match(r.ctx, /no se pudo deshacer \(su carpeta ya no es la de la foto/);
});

// 🔴 Falla con: un cambio de rama que trae historias se deshace y deja el árbol cambiado.
test('WriteAfter_GitCheckout_NotUndone_ButOtherContentIs @story-8.320 @ac-2', () => {
  const l = lab();
  const fecha = '2026-01-01T00:00:00Z';
  const git = (...a) => execFileSync('git', ['-C', l.repo, '-c', 'user.name=lab', '-c', 'user.email=lab@example.invalid', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a],
    { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  git('add', '-A'); git('commit', '-qm', 'base'); git('checkout', '-qb', 'otra');
  fs.writeFileSync(l.f('specs/story-1.1-hecha.md'), historia('1.1', 'done'));
  fs.writeFileSync(l.f('specs/story-1.5-nueva.md'), historia('1.5', 'review'));
  git('add', '-A'); git('commit', '-qm', 'otra'); git('checkout', '-q', '-');
  correr(l, 'git checkout -q otra');
  assert.match(fs.readFileSync(l.f('specs/story-1.1-hecha.md'), 'utf8'), /status: done/, 'lo que trajo git queda');
  assert.ok(fs.existsSync(l.f('specs/story-1.5-nueva.md')));
  // lo que no coincide con lo commiteado sí se deshace, aunque el comando sea git
  correr(l, 'git status', { hacer: () => fs.writeFileSync(l.f('specs/story-1.1-hecha.md'), historia('1.1', 'otra-cosa')) });
  assert.match(fs.readFileSync(l.f('specs/story-1.1-hecha.md'), 'utf8'), /status: done/);
});

// 🔴 Falla con: `cd -- <otro repo>` o `cd "<ruta con espacio>"` no suman ese repo a la foto.
test('WriteAfter_CdWithOptionsOrQuotes_RepoWatched @story-8.320 @ac-1', () => {
  const l = lab();
  const otro = lab();
  const conEspacio = path.join(otro.base, 'repo con espacio');
  fs.renameSync(otro.repo, conEspacio);
  const f = path.join(conEspacio, 'specs', 'story-1.1-hecha.md');
  const antes = fs.readFileSync(f, 'utf8');
  for (const cd of [`cd -- "${conEspacio}"`, `cd -P "${conEspacio}"`, `pushd "${conEspacio}"`]) {
    correr(l, `${cd} && cosa`, { hacer: () => fs.writeFileSync(f, historia('1.1', 'done')) });
    assert.strictEqual(fs.readFileSync(f, 'utf8'), antes, cd);
  }
});
