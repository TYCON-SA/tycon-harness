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
//
// stable-data: las horas son las del momento (el marcador de otra sesión viva, los commits de la prueba de git con su
// fecha fija); ninguna se compara con una fecha escrita. Crea repos de git en carpetas temporales; nunca toca el real.
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
  // la conversación de la sesión: lo que la herramienta dice que corrió
  const transcript = path.join(base, 'conversacion.jsonl');
  fs.writeFileSync(transcript, '');
  return { base, repo, home, env, estado, transcript, f: (rel) => path.join(repo, rel) };
}

/** Anota en la conversación una llamada a una herramienta, como la escribe Claude Code. */
const enLaConversacion = (l, id, name, input) => fs.appendFileSync(l.transcript, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })}\n`);

let n = 0;
/** Corre el gancho antes, el comando (o `hacer`, en lugar del comando), y el gancho después. */
function correr(l, comando, { hacer = null, evento = 'PostToolUse', sesion = 's1' } = {}) {
  const id = `toolu_${++n}`;
  const ev = (hook_event_name) => JSON.stringify({ session_id: sesion, tool_use_id: id, transcript_path: l.transcript, cwd: l.repo, hook_event_name, tool_name: 'Bash', tool_input: { command: comando } });
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

// ── lo que no se deshace, la familia entera y la carpeta de las fotos ────────────────────────────────────────────────

/**
 * Un evento suelto del gancho (para un Edit o un Write que corre a la vez que el comando). El de antes queda también en
 * la conversación, como lo deja la herramienta, salvo con `conversacion: false`.
 */
function evento(l, ev, { conversacion = true } = {}) {
  if (conversacion && ev.hook_event_name === 'PreToolUse') enLaConversacion(l, ev.tool_use_id, ev.tool_name, ev.tool_input);
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 's1', transcript_path: l.transcript, cwd: l.repo, ...ev }), env: l.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}

// 🔴 Falla con: un cambio hecho mientras otra sesión trabaja en el mismo repo se deshace, pisando lo legítimo.
test('T16 · WriteAfter_OtherLiveSession_NotUndone_Noted @story-8.320 @ac-11', () => {
  const l = lab();
  fs.mkdirSync(path.join(l.estado, 'active'), { recursive: true });
  const recien = new Date().toISOString(); // stable-data: la otra sesión está viva si tocó su marcador hace poco
  fs.writeFileSync(path.join(l.estado, 'active', 'otra-sesion.json'), JSON.stringify({ storyId: '1.1', storyPath: l.f('specs/story-1.1-hecha.md'), repoPath: l.repo, lastTouch: recien, startedAt: recien }));
  const f = l.f('specs/story-1.1-hecha.md');
  const r = correr(l, 'cosa', { hacer: () => fs.writeFileSync(f, historia('1.1', 'review')) });
  assert.match(fs.readFileSync(f, 'utf8'), /status: review/, 'no se deshace');
  assert.match(r.ctx, /NO LO DESHICE/);
  assert.match(r.ctx, /otra sesión trabaja en el mismo repo \(otra-ses\)/);
  assert.match(r.gates, /"name":"escritura-dudosa"/);
});

// 🔴 Falla con: un Edit de la misma sesión, a la vez que un comando, sobre la misma historia, se deshace; o un cambio
//    con marker.js corriendo a la vez en otro comando se deshace sin decirlo.
test('WriteAfter_ParallelToolsOfTheSameSession @story-8.320 @ac-11', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  correr(l, 'cosa', { hacer: () => {
    evento(l, { tool_use_id: 'edit-1', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: f } });
    fs.writeFileSync(f, historia('1.1', 'in-progress', 'cuerpo editado'));
    evento(l, { tool_use_id: 'edit-1', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: f } });
  } });
  assert.match(fs.readFileSync(f, 'utf8'), /cuerpo editado/, 'lo del Edit queda');
  // un Edit sobre otro archivo no cubre esta historia
  const antes = fs.readFileSync(f, 'utf8');
  correr(l, 'cosa', { hacer: () => {
    evento(l, { tool_use_id: 'edit-2', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: l.f('src/x.js') } });
    fs.writeFileSync(f, historia('1.1', 'done'));
  } });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), antes);
  // otro comando de la misma sesión que es sólo marker.js, corriendo a la vez: dudoso
  const r = correr(l, 'cosa', { hacer: () => {
    evento(l, { tool_use_id: 'mk-1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `node "${MARKER}" update-story-status ${f} review` } });
    fs.writeFileSync(f, historia('1.1', 'review'));
    evento(l, { tool_use_id: 'mk-1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `node "${MARKER}" update-story-status ${f} review` } });
  } });
  assert.match(fs.readFileSync(f, 'utf8'), /status: review/);
  assert.match(r.ctx, /otro comando de esta sesión corría marker\.js/);
  // uno de otra sesión no cuenta como de esta
  const antes2 = fs.readFileSync(f, 'utf8');
  correr(l, 'cosa', { hacer: () => {
    spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 's2', tool_use_id: 'edit-9', cwd: l.repo, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: f } }), env: l.env });
    fs.writeFileSync(f, historia('1.1', 'done'));
  } });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), antes2);
});

// 🔴 Falla con: el comando fabrica la excepción y lo suyo no se deshace — un Edit que otro freno negó antes, un
//    registro falso en la carpeta de las fotos, una sesión viva que aparece durante el comando, un marker.js abierto de
//    antes, o un marker.js en paralelo que no nombra la historia.
test('WriteAfter_ExceptionsTheCommandCanForge_DoNotCount @story-8.320 @ac-11', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  const original = fs.readFileSync(f, 'utf8');
  const vuelve = (como) => assert.strictEqual(fs.readFileSync(f, 'utf8'), original, como);
  // un Edit negado por otro freno: empezó antes del comando y nunca terminó
  evento(l, { tool_use_id: 'edit-negado', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: f } });
  correr(l, 'N=sed; $N -i x', { hacer: () => fs.writeFileSync(f, historia('1.1', 'done')) });
  vuelve('Edit negado antes');
  // un registro que escribió el comando mismo: no está en la conversación
  const enCurso = path.join(l.estado, 'write-photos', 'en-curso');
  correr(l, 'cosa', { hacer: () => {
    fs.writeFileSync(path.join(enCurso, 's1-falso.json'), JSON.stringify({ sesion: 's1', id: 'falso', tool: 'Write', inicio: Date.now(), fin: null, archivos: [f] }));
    fs.writeFileSync(path.join(enCurso, 's1-raro.json'), JSON.stringify({ sesion: 's1', id: 'raro', tool: 'Write', inicio: Date.now(), fin: null, archivos: [7] }));
    fs.writeFileSync(f, historia('1.1', 'done'));
  } });
  vuelve('registro falso');
  // un registro con el id de una llamada de verdad pero otro archivo
  enLaConversacion(l, 'edit-otro', 'Edit', { file_path: l.f('src/x.js') });
  correr(l, 'cosa', { hacer: () => {
    fs.writeFileSync(path.join(enCurso, 's1-edit-otro.json'), JSON.stringify({ sesion: 's1', id: 'edit-otro', tool: 'Edit', inicio: Date.now(), fin: null, archivos: [f] }));
    fs.writeFileSync(f, historia('1.1', 'done'));
  } });
  vuelve('registro con otro archivo');
  // una sesión viva que aparece durante el comando
  correr(l, 'cosa', { hacer: () => {
    fs.mkdirSync(path.join(l.estado, 'active'), { recursive: true });
    const recien = new Date().toISOString(); // stable-data: el marcador falso se ve vivo
    fs.writeFileSync(path.join(l.estado, 'active', 'falsa.json'), JSON.stringify({ storyId: '9.9', repoPath: l.repo, lastTouch: recien, startedAt: recien }));
    fs.writeFileSync(f, historia('1.1', 'done'));
  } });
  vuelve('sesión fabricada durante el comando');
  fs.rmSync(path.join(l.estado, 'active', 'falsa.json'));
  // un marker.js abierto de antes (no llegó a su después)
  const mk = `node "${MARKER}" update-story-status ${f} review`;
  evento(l, { tool_use_id: 'mk-abierto', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: mk } });
  correr(l, 'cosa', { hacer: () => fs.writeFileSync(f, historia('1.1', 'done')) });
  vuelve('marker.js abierto de antes');
  // un marker.js en paralelo que sólo lee: no nombra la historia
  const st = `node "${MARKER}" status`;
  correr(l, 'cosa', { hacer: () => {
    evento(l, { tool_use_id: 'mk-status', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: st } });
    fs.writeFileSync(f, historia('1.1', 'done'));
    evento(l, { tool_use_id: 'mk-status', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: st } });
  } });
  vuelve('marker.js status en paralelo');
});

// 🔴 Falla con: alguna forma de la familia que sigue abierta en el freno de antes escribe la historia y queda.
test('T6 · WriteAfter_FamilyForms_AllRestored @story-8.320 @ac-6', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  const antes = fs.readFileSync(f, 'utf8');
  const x = guion(l, 'fam.js', `require('fs').writeFileSync(${JSON.stringify(f)}, ${JSON.stringify(historia('1.1', 'done'))});`);
  const formas = [
    `\${N:-node} ${x}`,                                   // variable con operador
    `CMD=(node); "\${CMD[@]}" ${x}`,                       // arreglo
    `set -- node; "$@" ${x}`,                             // parámetros posicionales
    `node --require=${x} -e 0`,                           // el guion en una opción pegada
    `N="env node"; $N ${x}`,                              // una variable con lanzador
    `R="node ${x}"; $R`,                                  // el comando entero en una variable
    `cat <(node ${x})`,                                   // la sustitución de proceso detrás de un lector
    `find ${l.base} -maxdepth 0 -exec node ${x} \\;`,      // un programa que corre sus argumentos
  ];
  for (const c of formas) {
    correr(l, c);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), antes, c);
  }
});

// 🔴 Falla con: el freno de antes deja borrar, mover o escribir las fotos por consola.
test('WriteAfter_PhotosProtectedByTheGateBefore @story-8.320 @ac-1', () => {
  const l = lab();
  const fotos = path.join(l.estado, 'write-photos');
  fs.mkdirSync(fotos, { recursive: true });
  fs.writeFileSync(path.join(fotos, 's1-x.json'), '{}');
  const GATE = path.resolve(__dirname, '..', 'on-bash-write-gate.js');
  for (const cmd of [`rm -rf ${fotos}`, `rm ${path.join(fotos, 's1-x.json')}`, `echo '{}' > ${path.join(fotos, 's1-x.json')}`, `mv ${fotos} ${path.join(l.base, 'otra')}`, `cd ${l.estado} && rm -rf write-photos`]) {
    const r = spawnSync(process.execPath, [GATE], { input: JSON.stringify({ session_id: 's1', tool_name: 'Bash', cwd: l.repo, tool_input: { command: cmd } }), env: l.env, encoding: 'utf8', cwd: l.repo });
    const dijo = `${r.stdout}${r.stderr}`;
    assert.ok(r.status === 2 || /"deny"|"block"/.test(dijo), `no frenó: ${cmd}\n${dijo}`);
    assert.match(dijo, /fotos de lo protegido|estado del pipeline/i, cmd);
  }
  assert.equal(require('../lib/story-gate.js').signedRecordKind(path.join(fotos, 's1-x.json')), 'write-photos');
  const leer = spawnSync(process.execPath, [GATE], { input: JSON.stringify({ session_id: 's1', tool_name: 'Bash', cwd: l.repo, tool_input: { command: `cat ${path.join(fotos, 's1-x.json')}` } }), env: l.env, encoding: 'utf8', cwd: l.repo });
  assert.ok(leer.status === 0 && !/"deny"|"block"/.test(leer.stdout), `leer se frenó: ${leer.stdout}`);
});

// ── el freno que deja una mirada fallida ─────────────────────────────────────────────────────────────────────────────

/** El gancho de antes, solo: `{ status, err }` (2 si frena). */
function antes(l, comando, sesion = 's1') {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: sesion, tool_use_id: `pre-${++n}`, cwd: l.repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: comando } }), env: l.env, encoding: 'utf8' });
  return { status: r.status, err: r.stderr };
}

// 🔴 Falla con: una mirada que no se pudo hacer deja seguir a la sesión como si nada.
test('T7 · WriteAfter_PhotoUnusable_LogsAndNextCommandStops @story-8.320 @ac-7', () => {
  const casos = {
    'foto alterada': (l) => {
      const dir = path.join(l.estado, 'write-photos');
      for (const n2 of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) { const p = path.join(dir, n2); const j = JSON.parse(fs.readFileSync(p, 'utf8')); j.at = 1; fs.writeFileSync(p, JSON.stringify(j)); }
    },
    'foto borrada': (l) => { for (const n2 of fs.readdirSync(path.join(l.estado, 'write-photos')).filter((x) => x.endsWith('.json'))) fs.rmSync(path.join(l.estado, 'write-photos', n2)); },
  };
  for (const [caso, romper] of Object.entries(casos)) {
    const l = lab();
    const r = correr(l, 'cosa', { hacer: () => romper(l) });
    assert.match(r.ctx, /no pude mirar .*\n.*queda frenada/, caso);
    assert.match(fs.readFileSync(path.join(l.estado, 'hook-errors.log'), 'utf8'), /no se pudo mirar/, caso);
    const frenado = antes(l, `N=node; \${N:-node} x.js`);
    assert.strictEqual(frenado.status, 2, `${caso}: el siguiente comando frena`);
    assert.match(frenado.err, /ESTA SESIÓN ESTÁ FRENADA/);
    assert.match(frenado.err, /release-write-after --for-session s1/);
    for (const lee of ['git status', 'cat specs/story-1.1-hecha.md | grep status', 'git log -1 --oneline', 'cd specs && ls']) assert.strictEqual(antes(l, lee).status, 0, `${caso}: leer sigue: ${lee}`);
    for (const escribe of ['echo x > specs/a.md', 'git commit -m x', 'git push', 'cat a | tee b', `node "${MARKER}" help`]) assert.strictEqual(antes(l, escribe).status, 2, `${caso}: ${escribe}`);
    assert.strictEqual(antes(l, `\${N:-node} x.js`, 'otra').status, 0, `${caso}: otra sesión no queda frenada`);
  }
});

// 🔴 Falla con: lo que no se pudo deshacer queda escrito y la sesión sigue; o la foto que no se pudo sacar no se dice.
test('T8 · WriteAfter_RestoreFailsOrNoPhoto_LogsAndNextCommandStops @story-8.320 @ac-7', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  const r = correr(l, 'cosa', { hacer: () => { fs.writeFileSync(f, historia('1.1', 'done')); fs.rmSync(path.join(l.estado, 'write-photos', 'blobs'), { recursive: true }); } });
  assert.match(r.ctx, /no se pudo deshacer \(no está la copia/);
  assert.match(r.ctx, /queda frenada/);
  assert.strictEqual(antes(l, 'cosa').status, 2);
  const l2 = lab();
  fs.mkdirSync(path.join(l2.estado, 'write-photos'), { recursive: true });
  fs.writeFileSync(path.join(l2.estado, 'write-photos', 'blobs'), 'no es una carpeta');
  const r2 = correr(l2, 'cosa');
  assert.match(r2.ctx, /no pude sacar la foto antes del comando/);
  assert.strictEqual(antes(l2, 'cosa').status, 2);
});

// 🔴 Falla con: la sesión frenada se libera sola, o el guion libera una sesión que no está frenada.
test('WriteAfter_Release_NeverByTheStoppedSession @story-8.320 @ac-7', () => {
  const l = lab();
  require('../lib/protected-photo.js').setBrake(l.estado, 's1', 'prueba');
  const liberar = (propia, extra = []) => spawnSync(process.execPath, [MARKER, 'release-write-after', '--for-session', 's1', '--reason', 'miré la historia', ...extra],
    { env: { ...l.env, CLAUDE_CODE_SESSION_ID: propia }, encoding: 'utf8', cwd: l.repo });
  const propia = liberar('s1');
  assert.strictEqual(propia.status, 2, propia.stderr);
  assert.match(propia.stderr, /la sesión frenada no se libera sola/);
  assert.ok(require('../lib/protected-photo.js').readBrake(l.estado, 's1'), 'sigue frenada');
  // sin terminal, `--terminal` no firma
  const sinTty = liberar('otra', ['--terminal']);
  assert.notStrictEqual(sinTty.status, 0, sinTty.stderr);
  assert.ok(require('../lib/protected-photo.js').readBrake(l.estado, 's1'), 'sigue frenada');
  // otra sesión sin la firma de la ventana no la libera
  const sinFirma = liberar('otra');
  assert.notStrictEqual(sinFirma.status, 0, sinFirma.stderr);
  assert.match(sinFirma.stderr, /🔒 marker\.js: .*(ventana|firma)/i, 'la niega la firma, no otra cosa');
  assert.ok(require('../lib/protected-photo.js').readBrake(l.estado, 's1'), 'sigue frenada');
  const noFrenada = spawnSync(process.execPath, [MARKER, 'release-write-after', '--for-session', 'nadie', '--reason', 'x'], { env: { ...l.env, CLAUDE_CODE_SESSION_ID: 'otra' }, encoding: 'utf8', cwd: l.repo });
  assert.strictEqual(noFrenada.status, 1, noFrenada.stderr);
  assert.match(noFrenada.stderr, /no está frenada/);
});
