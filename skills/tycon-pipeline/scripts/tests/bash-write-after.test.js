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
  // las pruebas de siempre miran el deshacer, que se prende con su interruptor; las del modo «sólo anota» lo sacan
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TYCON_WRITE_AFTER_MODE: 'undo' };
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
    if (!comando.includes('>') && !comando.includes('--require')) assert.match(r.ctx, /Corré el del orquestador solo/);
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
  // las llamadas que corren a la vez están en la conversación antes del comando: la herramienta escribe el mensaje entero
  const sinAnotar = { conversacion: false };
  enLaConversacion(l, 'edit-1', 'Edit', { file_path: f });
  correr(l, 'cosa', { hacer: () => {
    evento(l, { tool_use_id: 'edit-1', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: f } }, sinAnotar);
    fs.writeFileSync(f, historia('1.1', 'in-progress', 'cuerpo editado'));
    evento(l, { tool_use_id: 'edit-1', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: f } });
  } });
  assert.match(fs.readFileSync(f, 'utf8'), /cuerpo editado/, 'lo del Edit queda');
  // un Edit sobre otro archivo no cubre esta historia
  const antes = fs.readFileSync(f, 'utf8');
  enLaConversacion(l, 'edit-2', 'Edit', { file_path: l.f('src/x.js') });
  correr(l, 'cosa', { hacer: () => {
    evento(l, { tool_use_id: 'edit-2', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: l.f('src/x.js') } }, sinAnotar);
    fs.writeFileSync(f, historia('1.1', 'done'));
  } });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), antes);
  // otro comando de la misma sesión que es sólo marker.js, corriendo a la vez: dudoso
  enLaConversacion(l, 'mk-1', 'Bash', { command: `node "${MARKER}" update-story-status ${f} review` });
  const r = correr(l, 'cosa', { hacer: () => {
    evento(l, { tool_use_id: 'mk-1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `node "${MARKER}" update-story-status ${f} review` } }, sinAnotar);
    fs.writeFileSync(f, historia('1.1', 'review'));
    evento(l, { tool_use_id: 'mk-1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `node "${MARKER}" update-story-status ${f} review` } });
  } });
  assert.match(fs.readFileSync(f, 'utf8'), /status: review/);
  assert.match(r.ctx, /otro comando de esta sesión corría el del orquestador/);
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
  const enCurso = path.join(l.estado, 'write-photos', 'in-progress');
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
    for (const lee of ['git rev-parse HEAD', 'cat specs/story-1.1-hecha.md | grep status', 'ls specs', 'cd specs && ls']) assert.strictEqual(antes(l, lee).status, 0, `${caso}: leer sigue: ${lee}`);
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

// 🔴 Falla con: con la sesión frenada pasa como «de lectura» un comando que corre otra cosa o escribe — una
//    sustitución entre comillas, un lector que ejecuta un programa por una opción, una opción de git que escribe (o su
//    prefijo), un `sort` o un `uniq` que corre un programa o escribe un archivo, o un git que corre un programa de la
//    configuración del repo (`core.fsmonitor`, `diff.external`, `gpg.program`).
test('WriteAfter_StoppedSession_OnlyTrueReadsRun @story-8.320 @ac-7', () => {
  const { soloLee } = require(HOOK);
  // las opciones abreviadas (git y sort aceptan un prefijo) se arman recortando la entera
  for (const c of ['echo "$(rm -f x)"', 'cat "`sh y.sh`"', 'echo ${X:=y}', 'cat <(sh y.sh)', 'git grep -Osh -e . -- y.sh', 'rg --pre sh . y.sh',
    'git diff --output=specs/a.md', 'git log --output specs/a.md', 'git -c core.pager=sh log', 'git -C . -c x=y status', 'sort -o a b', 'git push', 'git branch -D x',
    'sort -S 1b --compress-program=sh c.txt', `sort ${'--compress-program'.slice(0, 7)}=sh c.txt`, 'sort -uo salida x', `sort ${'--output'.slice(0, 6)}=salida x`, 'uniq entrada salida',
    'printf x | uniq - .git/config', 'git status', 'git diff', 'git -C /r status', 'git log -p --ext', `git log ${'--textconv'.slice(0, 7)}`, 'git show HEAD',
    'git --no-pager log -1', 'less a', 'ls | sort | uniq', 'git ls-files', 'git --no-pager ls-files'])
    assert.strictEqual(soloLee(c), false, c);
  assert.strictEqual(soloLee('ls | sort { Remove-Item x }', { powershell: true }), false, 'un bloque de PowerShell en sort');
  for (const c of ['git -C /r rev-parse HEAD', 'git --no-pager rev-parse --show-toplevel', 'ls | sort', 'ls | sort -rn', 'ls | sort -t , -k 2', 'grep -n x a | sort', 'printf "%s\\n" a'])
    assert.strictEqual(soloLee(c), true, c);
});

// 🔴 Falla con: un comando que llega con otro nombre de herramienta (Monitor) corre con la sesión frenada.
test('WriteAfter_StoppedSession_MonitorAlsoStopped @story-8.320 @ac-7', () => {
  const l = lab();
  require('../lib/protected-photo.js').setBrake(l.estado, 's1', 'prueba');
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 's1', tool_use_id: 'mon-1', cwd: l.repo, hook_event_name: 'PreToolUse', tool_name: 'Monitor', tool_input: { command: 'node x.js' } }), env: l.env, encoding: 'utf8' });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /ESTA SESIÓN ESTÁ FRENADA/);
  // con mayúsculas en el id, es la misma sesión
  assert.ok(require('../lib/protected-photo.js').readBrake(l.estado, 'S1'), 'el id con mayúsculas ve el mismo freno');
});

// 🔴 Falla con: un comando que borra la foto y su registro de inicio deja lo escrito sin deshacer y sin freno; o el
//    segundo evento de después de un comando ya mirado frena la sesión.
test('WriteAfter_PhotoAndRecordDeleted_Stops_DuplicateEventDoesNot @story-8.320 @ac-7', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  const fotos = path.join(l.estado, 'write-photos');
  const r = correr(l, 'cosa', { hacer: () => {
    fs.writeFileSync(f, historia('1.1', 'done'));
    for (const n2 of fs.readdirSync(fotos).filter((x) => x.endsWith('.json'))) fs.rmSync(path.join(fotos, n2));
    fs.rmSync(path.join(fotos, 'in-progress'), { recursive: true, force: true });
  } });
  assert.match(r.ctx, /no pude mirar .*\n.*queda frenada/);
  assert.strictEqual(antes(l, 'cosa').status, 2, 'el siguiente comando frena');
  // ninguna marca de «ya lo miré» vale: un comando que borra su foto y escribe la marca en su registro frena igual
  const lm = lab();
  const fm = lm.f('specs/story-1.1-hecha.md');
  const fotosM = path.join(lm.estado, 'write-photos');
  const rm = correr(lm, 'cosa', { hacer: () => {
    fs.writeFileSync(fm, historia('1.1', 'done'));
    for (const n2 of fs.readdirSync(fotosM).filter((x) => x.endsWith('.json'))) {
      fs.rmSync(path.join(fotosM, n2));
      fs.writeFileSync(path.join(fotosM, 'in-progress', n2), JSON.stringify({ sesion: 's1', mirado: true, fin: Date.now() }));
    }
  } });
  assert.match(rm.ctx, /no pude mirar/, 'la marca fabricada no evita la mirada');
  assert.strictEqual(antes(lm, 'cosa').status, 2, 'la sesión queda frenada');
  // el gancho registrado dos veces: dos eventos de antes y dos de después del mismo comando no frenan
  const l2 = lab();
  const ev = (hook_event_name) => JSON.stringify({ session_id: 's1', tool_use_id: 'dup-1', transcript_path: l2.transcript, cwd: l2.repo, hook_event_name, tool_name: 'Bash', tool_input: { command: 'ls' } });
  for (const e of ['PreToolUse', 'PreToolUse', 'PostToolUse', 'PostToolUse']) assert.strictEqual(spawnSync(process.execPath, [HOOK], { input: ev(e), env: l2.env, encoding: 'utf8' }).status, 0, e);
  assert.strictEqual(require('../lib/protected-photo.js').readBrake(l2.estado, 's1'), null, 'el evento repetido no frena');
});

// 🔴 Falla con: con la carpeta de las fotos sin permiso de escritura, el comando corre sin foto y lo escrito queda.
test('WriteAfter_PhotosFolderNotWritable_CommandDoesNotRun @story-8.320 @ac-7', () => {
  const l = lab();
  const fotos = path.join(l.estado, 'write-photos');
  fs.mkdirSync(path.join(fotos, 'in-progress'), { recursive: true });
  fs.chmodSync(fotos, 0o555);
  try {
    const r = antes(l, 'cosa');
    assert.strictEqual(r.status, 2, r.err);
    assert.match(r.err, /ESTA SESIÓN ESTÁ FRENADA/);
    assert.match(r.err, /arreglar los permisos/, 'el aviso dice qué carpeta arreglar');
    assert.doesNotMatch(r.err, /release-write-after/, 'y no ofrece una firma que no la saca');
    assert.ok(require('../lib/protected-photo.js').readBrake(l.estado, 's1'), 'una carpeta donde no se puede escribir cuenta como freno');
    // lo que sólo lee sigue corriendo, en esta sesión y en otra
    assert.strictEqual(antes(l, 'cat specs/story-1.1-hecha.md').status, 0, 'leer sigue');
    assert.strictEqual(antes(l, 'ls', 'otra').status, 0, 'leer sigue en otra sesión');
    // la liberación no firma nada: el freno es la carpeta
    const lib = spawnSync(process.execPath, [MARKER, 'release-write-after', '--for-session', 's1', '--reason', 'x'], { env: { ...l.env, CLAUDE_CODE_SESSION_ID: 'otra' }, encoding: 'utf8', cwd: l.repo });
    assert.strictEqual(lib.status, 1, lib.stderr);
    assert.match(lib.stderr, /no se saca con una firma/);
  } finally { fs.chmodSync(fotos, 0o755); }
  // sólo la del freno sin escritura: también frena
  fs.mkdirSync(path.join(fotos, 'stopped'), { recursive: true });
  fs.chmodSync(path.join(fotos, 'stopped'), 0o555);
  try { assert.ok(require('../lib/protected-photo.js').readBrake(l.estado, 's1')); } finally { fs.chmodSync(path.join(fotos, 'stopped'), 0o755); }
  // `stopped` como enlace colgado: el freno se prueba escribiendo, y frena
  fs.rmSync(path.join(fotos, 'stopped'), { recursive: true });
  fs.symlinkSync(path.join(l.base, 'no-existe'), path.join(fotos, 'stopped'));
  assert.ok(require('../lib/protected-photo.js').readBrake(l.estado, 's1'), 'un enlace colgado en el lugar del freno frena');
  fs.rmSync(path.join(fotos, 'stopped'));
  // sólo `in-progress` sin escritura: un comando que escribe no corre, y uno que lee sí
  fs.chmodSync(path.join(fotos, 'in-progress'), 0o555);
  try {
    const r2 = antes(l, 'cosa');
    assert.strictEqual(r2.status, 2, r2.err);
    assert.match(r2.err, /no puedo guardar la foto/);
    assert.strictEqual(antes(l, 'ls').status, 0, 'leer sigue');
  } finally { fs.chmodSync(path.join(fotos, 'in-progress'), 0o755); }
});

// 🔴 Falla con: la limpieza diaria borra la foto de un comando que espera su permiso una noche, o no borra las viejas.
test('WriteAfter_Cleanup_KeepsPhotosUnderAWeek @story-8.320 @ac-8', () => {
  const l = lab();
  const fotos = path.join(l.estado, 'write-photos');
  fs.mkdirSync(path.join(fotos, 'in-progress'), { recursive: true });
  const vieja = path.join(fotos, 'otra-vieja.json');
  const deAyer = path.join(fotos, 'otra-ayer.json');
  const registroViejo = path.join(fotos, 'in-progress', 'otra-vieja.json');
  for (const f of [vieja, deAyer, registroViejo]) fs.writeFileSync(f, '{}');
  const dias = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000); // stable-data: las edades se cuentan desde ahora
  fs.utimesSync(vieja, dias(8), dias(8));
  fs.utimesSync(registroViejo, dias(8), dias(8));
  fs.utimesSync(deAyer, dias(1), dias(1));
  // la limpieza va con la foto, y un comando que sólo lee no la saca
  correr(l, 'node -e 1');
  assert.ok(!fs.existsSync(vieja), 'la foto de 8 días se borra');
  assert.ok(!fs.existsSync(registroViejo), 'su registro también');
  assert.ok(fs.existsSync(deAyer), 'la de ayer queda: puede ser de un comando que espera su permiso');
});

// 🔴 Falla con: una edición pedida en el mismo mensaje (todavía sin correr) hace que lo del comando quede callado.
test('WriteAfter_SiblingEditInTheSameMessage_KeptButNoted @story-8.320 @ac-11', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  enLaConversacion(l, 'edit-hermano', 'Edit', { file_path: f });
  const enCurso = path.join(l.estado, 'write-photos', 'in-progress');
  const r = correr(l, 'cosa', { hacer: () => {
    fs.mkdirSync(enCurso, { recursive: true });
    fs.writeFileSync(path.join(enCurso, 's1-edit-hermano.json'), JSON.stringify({ sesion: 's1', id: 'edit-hermano', tool: 'Edit', inicio: Date.now(), fin: null, archivos: [f] }));
    fs.writeFileSync(f, historia('1.1', 'done'));
  } });
  assert.match(r.ctx, /NO LO DESHICE/);
  assert.match(r.ctx, /una edición de esta sesión sobre ese archivo corría a la vez/);
  assert.match(r.gates, /"name":"escritura-dudosa"/);
});

// 🔴 Falla con: la sesión frenada se libera sola con su id en mayúsculas; o `> /dev/nullx` se toma por /dev/null.
test('WriteAfter_ReleaseCaseInsensitive_AndExactDevNull @story-8.320 @ac-7', () => {
  const l = lab();
  require('../lib/protected-photo.js').setBrake(l.estado, 's1', 'prueba');
  const r = spawnSync(process.execPath, [MARKER, 'release-write-after', '--for-session', 'S1', '--reason', 'x'], { env: { ...l.env, CLAUDE_CODE_SESSION_ID: 's1' }, encoding: 'utf8', cwd: l.repo });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /no se libera sola/);
  const { redirigeAArchivo } = require(HOOK);
  assert.strictEqual(redirigeAArchivo('echo x > /dev/null'), false);
  assert.strictEqual(redirigeAArchivo('ls >/dev/null 2>&1'), false);
  for (const c of ['echo x > /dev/nullx', 'echo x > /dev/null.md']) assert.strictEqual(redirigeAArchivo(c), true, c);
});

// 🔴 Falla con: un registro escrito por el comando con el id de una llamada vieja y ya terminada fabrica la excepción
//    (lo escrito queda), o el registro decide por su cuenta que el comando era del orquestador.
test('WriteAfter_OldFinishedCallsDoNotCount @story-8.320 @ac-11', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  const original = fs.readFileSync(f, 'utf8');
  const enCurso = path.join(l.estado, 'write-photos', 'in-progress');
  const resultado = (id) => fs.appendFileSync(l.transcript, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })}\n`);
  // un Edit viejo sobre la historia, ya terminado
  enLaConversacion(l, 'edit-viejo', 'Edit', { file_path: f });
  resultado('edit-viejo');
  const r1 = correr(l, 'cosa', { hacer: () => {
    fs.mkdirSync(enCurso, { recursive: true });
    fs.writeFileSync(path.join(enCurso, 's1-edit-viejo.json'), JSON.stringify({ sesion: 's1', id: 'edit-viejo', tool: 'Edit', inicio: Date.now(), fin: null, archivos: [f] }));
    fs.writeFileSync(f, historia('1.1', 'done'));
  } });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), original, 'el Edit viejo no cuenta');
  assert.match(r1.gates, /"name":"escritura-vista-despues"/);
  // un Bash viejo (`ls`) con un registro que dice ser del orquestador y nombrar la historia
  enLaConversacion(l, 'ls-viejo', 'Bash', { command: 'ls' });
  const r2 = correr(l, 'cosa', { hacer: () => {
    fs.writeFileSync(path.join(enCurso, 's1-ls-viejo.json'), JSON.stringify({ sesion: 's1', id: 'ls-viejo', tool: 'Bash', inicio: Date.now(), fin: null, comando: 'ls', reconocido: true, nombra: [f] }));
    fs.writeFileSync(f, historia('1.1', 'done'));
  } });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), original, 'el registro no decide que el comando era del orquestador');
  assert.doesNotMatch(r2.ctx, /NO LO DESHICE/);
});

// 🔴 Falla con: borrar el marcador de una sesión que ya no vive queda sin deshacer.
test('WriteAfter_DeadSessionsMarker_Restored @story-8.320 @ac-11', () => {
  const l = lab();
  const muerta = path.join(l.estado, 'active', 'muerta.json');
  fs.mkdirSync(path.dirname(muerta), { recursive: true });
  fs.writeFileSync(muerta, JSON.stringify({ storyId: '7.7', lastTouch: '2020-01-01T00:00:00.000Z' }));
  correr(l, 'R=rm; $R x', { hacer: () => fs.rmSync(muerta) });
  assert.ok(fs.existsSync(muerta), 'el marcador de una sesión muerta vuelve');
});

// 🔴 Falla con: la liberación con la firma de una persona no saca el freno o no deja su renglón; o la firma de trámite y
//    «hecho y avisado» la dan: la liberan sólo la persona o la coordinadora designada.
test('WriteAfter_Release_ByAPerson_ClearsTheBrake_NotByTramite @story-8.320 @ac-7', () => {
  const crypto = require('crypto');
  const ow = require(path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
  const { conVentana, arbolDelGuion } = require(path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'tests', 'lib', 'window-passed.js'));
  const foto = require('../lib/protected-photo.js');
  const ARGS = ['release-write-after', '--for-session', 's1', '--reason', 'miré la historia'];
  const cmd = `node ${MARKER} ${ARGS.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  const ahora = Date.now(); // stable-data: el registro de la ventana y el árbol de la prueba son del momento
  const liberar = (l, via) => {
    fs.mkdirSync(ow.carpeta(l.home), { recursive: true });
    const reg = { firma: 'write-after-release', sesion: 'otra', destino: 's1', tool_use_id: 'toolu_01', sha256: crypto.createHash('sha256').update(cmd).digest('hex'), comando: cmd,
      herramienta: { pid: 100, inicio: 'Tue Oct 27 10:00:00 2026' }, ts: new Date(ahora).toISOString(), ...(via ? { via } : {}) };
    fs.writeFileSync(path.join(ow.carpeta(l.home), `write-after-release--${crypto.randomBytes(4).toString('hex')}.json`), JSON.stringify(reg));
    const env = { ...l.env, TYCON_PROFILE: '0', TYCON_LANE_LLM: '0', CLAUDE_CODE_SESSION_ID: 'otra' };
    return spawnSync(process.execPath, [MARKER, ...ARGS], { cwd: l.repo, encoding: 'utf8', env: conVentana(env, { arbol: { arbol: arbolDelGuion(l.home, cmd), pid: 301, ahora: ahora + 60000 } }) });
  };
  for (const via of ['automatica', 'avisado']) {
    const l = lab();
    foto.setBrake(l.estado, 's1', 'prueba');
    const r = liberar(l, via);
    assert.notStrictEqual(r.status, 0, `${via}: ${r.stderr}`);
    assert.ok(foto.readBrake(l.estado, 's1'), `${via}: sigue frenada`);
  }
  const l = lab();
  foto.setBrake(l.estado, 's1', 'prueba');
  const r = liberar(l, undefined);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(foto.readBrake(l.estado, 's1'), null, 'liberada');
  assert.match(fs.readFileSync(path.join(l.estado, 'gates.log'), 'utf8'), /"name":"write-after-release","status":"ok","sesion":"s1"/);
});

// 🔴 Falla con: algo puesto antes en el lugar del freno (una carpeta, o `stopped` como archivo) evita quedar frenada.
test('WriteAfter_BrakeSlotOccupied_StillStops @story-8.320 @ac-7', () => {
  const foto = require('../lib/protected-photo.js');
  const l = lab();
  const frenadas = path.join(l.estado, 'write-photos', 'stopped');
  fs.mkdirSync(path.join(frenadas, 's1.json'), { recursive: true });
  assert.ok(foto.readBrake(l.estado, 's1'), 'una carpeta en el lugar del freno frena');
  foto.clearBrake(l.estado, 's1');
  assert.strictEqual(foto.readBrake(l.estado, 's1'), null, 'liberada, ya no');
  fs.rmSync(frenadas, { recursive: true });
  fs.writeFileSync(frenadas, 'no es una carpeta');
  assert.ok(foto.readBrake(l.estado, 's1'), '`stopped` como archivo frena');
  fs.rmSync(frenadas);
  fs.mkdirSync(frenadas, { recursive: true });
  for (const raro of ['null', '0', '""', '{}']) { fs.writeFileSync(path.join(frenadas, 's1.json'), raro); assert.ok(foto.readBrake(l.estado, 's1'), raro); }
});

// 🔴 Falla con: el comando agrega a la conversación una llamada falsa y el registro de esa llamada, y lo suyo no se
//    deshace; o un comando cualquiera resucita el marcador que otra sesión cerró.
test('WriteAfter_ForgedConversationAndOtherSessionsMarker @story-8.320 @ac-11', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  const original = fs.readFileSync(f, 'utf8');
  enLaConversacion(l, 'toolu_previa', 'Bash', { command: 'ls' });
  correr(l, 'cosa', { hacer: () => {
    enLaConversacion(l, 'toolu_FAKE', 'Write', { file_path: f });
    fs.writeFileSync(path.join(l.estado, 'write-photos', 'in-progress', 's1-toolu_FAKE.json'), JSON.stringify({ sesion: 's1', id: 'toolu_FAKE', tool: 'Write', inicio: Date.now() + 2, fin: null, archivos: [f] }));
    fs.writeFileSync(f, historia('1.1', 'done'));
  } });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), original, 'una llamada agregada durante el comando no cuenta');
  const otra = path.join(l.estado, 'active', 'otra-sesion.json');
  fs.mkdirSync(path.dirname(otra), { recursive: true });
  fs.writeFileSync(otra, '{"storyId":"7.7"}');
  const r = correr(l, 'cosa', { hacer: () => fs.rmSync(otra) });
  assert.ok(!fs.existsSync(otra), 'el marcador que cerró otra sesión no vuelve');
  assert.match(r.ctx, /es el marcador de otra sesión/);
  const propio = path.join(l.estado, 'active', 's1.json');
  fs.writeFileSync(propio, '{"storyId":"1.1"}');
  correr(l, 'R=rm; $R x', { hacer: () => fs.rmSync(propio) });
  assert.ok(fs.existsSync(propio), 'el propio sí vuelve');
});

// 🔴 Falla con: el evento de después borra su foto (un repetido la encontraría vacía y frenaría); el evento de antes no
//    borra la foto vieja de su sesión, o borra la de otra sesión cuyo id empieza igual, o la de un comando recién
//    terminado (un repetido demorado frenaría).
test('WriteAfter_PhotosKeptForARepeatedEvent_AndCleanedPerSession @story-8.320 @ac-7', () => {
  const l = lab();
  const f = l.f('specs/story-1.1-hecha.md');
  const fotos = path.join(l.estado, 'write-photos');
  const ev = (sesion, id, hook_event_name, command) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: sesion, tool_use_id: id, transcript_path: l.transcript, cwd: l.repo, hook_event_name, tool_name: 'Bash', tool_input: { command } }), env: l.env, encoding: 'utf8' });
  const A = 'abcd1234-aaaa-0000-0000-000000000000';
  const B = 'abcd1234-bbbb-0000-0000-000000000000';
  // un comando que escribe, de A: su foto queda después de mirar
  assert.strictEqual(ev(A, 'w-1', 'PreToolUse', 'N=node; $N x.js').status, 0);
  fs.writeFileSync(f, historia('1.1', 'done'));
  assert.strictEqual(ev(A, 'w-1', 'PostToolUse', 'N=node; $N x.js').status, 0);
  const fotoA = path.join(fotos, `${A}-w-1.json`);
  assert.ok(fs.existsSync(fotoA), 'la foto queda después de mirar');
  // otra sesión con el mismo primer tramo arranca un comando: no la toca
  assert.strictEqual(ev(B, 'w-2', 'PreToolUse', 'ls').status, 0);
  assert.ok(fs.existsSync(fotoA), 'la foto de otra sesión no se borra');
  // el comando siguiente de A, enseguida: la foto de un comando recién terminado queda, y un repetido no frena
  assert.strictEqual(ev(A, 'w-3', 'PreToolUse', 'ls').status, 0);
  assert.ok(fs.existsSync(fotoA), 'la de hace menos de un minuto queda');
  assert.strictEqual(ev(A, 'w-1', 'PostToolUse', 'N=node; $N x.js').status, 0);
  assert.strictEqual(require('../lib/protected-photo.js').readBrake(l.estado, A), null, 'el evento repetido de un comando que escribe no frena');
  // pasado el minuto, el comando siguiente de A la borra
  const reg = path.join(fotos, 'in-progress', `${A}-w-1.json`);
  const r = JSON.parse(fs.readFileSync(reg, 'utf8'));
  fs.writeFileSync(reg, JSON.stringify({ ...r, fin: r.fin - 2 * 60 * 1000 }));
  assert.strictEqual(ev(A, 'w-4', 'PreToolUse', 'ls').status, 0);
  assert.ok(!fs.existsSync(fotoA), 'la foto vieja de la sesión se borra');
  // un evento de después sin foto de un comando que sólo lee no frena
  assert.strictEqual(ev(A, 'lee-1', 'PostToolUse', 'cat specs/story-1.1-hecha.md').status, 0);
  assert.strictEqual(require('../lib/protected-photo.js').readBrake(l.estado, A), null, 'una lectura sin foto no frena');
});

// 🔴 Falla con: `>&2archivo` (un archivo, no un descriptor) o `file -C` (compila un archivo) pasan por lectura.
test('WriteAfter_DescriptorRedirectToAFile_AndFileCompile_NotReads @story-8.320 @ac-7', () => {
  const { soloLee, redirigeAArchivo } = require(HOOK);
  for (const c of ['echo hi >&2file', 'echo hi 1>&2file', 'echo hi >&-file']) assert.strictEqual(redirigeAArchivo(c), true, c);
  for (const c of ['ls 2>&1', 'echo x >&2', 'echo x >&2; ls', 'ls 2>&1 | grep x']) assert.strictEqual(redirigeAArchivo(c), false, c);
  assert.strictEqual(soloLee('file -C -m x'), false);
});

// 🔴 Falla con: la guía del freno de mano no dice qué se mira después, qué se deshace, qué no, lo que no ve y cómo se
//    apaga.
test('T12 · SafetyGuide_DescribesWriteAfter @story-8.320 @ac-10', () => {
  const guia = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'guides', 'safety-guard.md'), 'utf8');
  const seccion = guia.slice(guia.indexOf('### La mirada de después'), guia.indexOf('### La ejecución perdida'));
  assert.ok(seccion.length > 200, 'la sección existe');
  for (const parte of ['Qué mira', 'Qué deshace', 'Qué no deshace', 'Cuando no puede mirar', 'Lo que no ve', 'TYCON_STORY_GATE=off', 'release-write-after', '`nohup`'])
    assert.ok(seccion.includes(parte), parte);
});

/** El mismo laboratorio sin el interruptor del deshacer: el modo de la instalación. */
const enModoAnota = (l) => { delete l.env.TYCON_WRITE_AFTER_MODE; return l; };
const renglones = (g) => g.split('\n').filter(Boolean).map((x) => JSON.parse(x));

test('T13 · WriteAfter_LogModeIsTheDefault_RecordsWithoutUndoing @story-8.320 @ac-2', () => {
  const l = enModoAnota(lab());
  const x = guion(l, 'x.js', `const fs=require('fs');const f=${JSON.stringify(l.f('specs/story-1.1-hecha.md'))};fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('in-progress','done'));`);
  const { ctx, gates } = correr(l, `N=node; $N ${x}`);
  assert.match(fs.readFileSync(l.f('specs/story-1.1-hecha.md'), 'utf8'), /status: done/, 'sólo anota: no deshace');
  assert.strictEqual(ctx, '', 'sólo anota: no le avisa al agente');
  const r = renglones(gates).find((x) => x.name === 'escritura-vista-despues');
  assert.ok(r, gates);
  assert.strictEqual(r.status, 'would-undo');
  assert.strictEqual(r.modo, 'anota');
  assert.strictEqual(r.forma, 'otro');
});

test('T14 · WriteAfter_LogMode_NeverStopsTheSession @story-8.320 @ac-7', () => {
  const l = enModoAnota(lab());
  const foto = require('../lib/protected-photo.js');
  // un evento de después sin el de antes (la pieza instalada a mitad de un comando)
  const ev = (hook_event_name, command, id) => JSON.stringify({ session_id: 's1', tool_use_id: id, transcript_path: l.transcript, cwd: l.repo, hook_event_name, tool_name: 'Bash', tool_input: { command } });
  const post = spawnSync(process.execPath, [HOOK], { input: ev('PostToolUse', 'npm test', 'toolu_x1'), env: l.env, encoding: 'utf8' });
  assert.strictEqual(post.status, 0);
  assert.strictEqual(post.stdout.trim(), '', 'sin aviso al agente');
  assert.ok(!foto.readBrake(l.estado, 's1'), 'sin freno');
  assert.ok(renglones(fs.readFileSync(path.join(l.estado, 'gates.log'), 'utf8')).some((r) => r.name === 'mirada-fallida' && r.status === 'logged'));
  // un freno que dejó el modo del deshacer no frena en éste
  foto.setBrake(l.estado, 's1', 'de antes');
  const pre = spawnSync(process.execPath, [HOOK], { input: ev('PreToolUse', 'npm test', 'toolu_x2'), env: l.env, encoding: 'utf8' });
  assert.strictEqual(pre.status, 0, pre.stderr);
});

test('T15 · WriteAfter_ReadOnlyCommand_TakesNoPhoto @story-8.320 @ac-9', () => {
  const l = enModoAnota(lab());
  const foto = require('../lib/protected-photo.js');
  correr(l, 'ls specs | head -3');
  const fotos = fs.existsSync(foto.photosDir(l.estado)) ? fs.readdirSync(foto.photosDir(l.estado)).filter((n) => n.endsWith('.json')) : [];
  assert.deepStrictEqual(fotos, [], 'lo que sólo lee no saca foto');
});

test('T16 · WriteAfter_StartRecords_AreCleaned @story-8.320 @ac-9', () => {
  const l = enModoAnota(lab());
  const foto = require('../lib/protected-photo.js');
  const enCurso = path.join(foto.photosDir(l.estado), 'in-progress');
  fs.mkdirSync(enCurso, { recursive: true });
  const viejo = path.join(enCurso, 'otra-toolu_viejo.json');
  fs.writeFileSync(viejo, JSON.stringify({ sesion: 'otra', id: 'toolu_viejo', tool: 'Bash', inicio: Date.now() - 11 * 60 * 1000, fin: null })); // stable-data: un registro de hace 11 minutos
  correr(l, 'node -e 1');
  assert.ok(!fs.existsSync(viejo), 'el registro de hace más de 10 minutos se borra desde el evento de antes');
});

test('T17 · WriteAfter_CodexDivergenceDeclared @story-8.320 @ac-10', () => {
  const raiz = path.resolve(__dirname, '..', '..', '..', '..');
  const codex = JSON.parse(fs.readFileSync(path.join(raiz, 'adapters', 'codex', 'hooks.json'), 'utf8'));
  assert.ok(codex.divergences.some((d) => (d.scripts || []).includes('on-bash-write-after.js')), 'la asimetría con Codex está declarada');
  assert.ok(!JSON.stringify(codex.hooks || {}).includes('on-bash-write-after.js'), 'en Codex no se registra');
  const deuda = JSON.parse(fs.readFileSync(path.join(raiz, 'scripts', 'controls-bench', 'hook-debt.json'), 'utf8')).debt.find((d) => d.script === 'on-bash-write-after.js');
  assert.ok(deuda && !/todavía no está registrada/.test(deuda.reason), 'la deuda dice lo de hoy');
});
