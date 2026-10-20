#!/usr/bin/env node
/**
 * reloop-rethink.test.js — en la tercera vuelta de revisores el pipeline pide repensar el enfoque antes de seguir
 * arreglando: `smart-reloop --iter N` (N >= 3) no devuelve el set hasta que la corrida tenga la nota de esa vuelta,
 * y la nota se guarda con `marker.js rethink`.
 *
 * Todo corre pipeline.js y marker.js de verdad sobre una corrida de juguete, con HOME temporal (la máquina real no se
 * toca y la prueba no depende de nada instalado).
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso dice la mutación que lo pone en rojo.
 *    · T1 — que la tercera vuelta devuelva el set sin nota, o que --force-full-reloop pase de largo.
 *    · T2 — que el freno se adelante a la segunda vuelta.
 *    · T3 — que una nota vacía, corta o sin su "qué cambia / por qué sigue igual" se guarde.
 *    · T4 — que la nota de la vuelta 3 valga para la 4.
 *    · T5 — que el informe o el archivo de la retrospectiva no traigan las notas, o que traigan un 0 sin notas.
 *    · T6 — que la guía no diga la regla o no nombre el comando.
 *    · T7 — que `advisors --iter N` (N >= 3) devuelva el set sin la nota.
 *    · T8 — que --story relativa dé una carpeta en el freno y otra en `marker.js rethink`.
 *    · T9 — que una nota a mano más corta que el mínimo no frene, que la retro la cuente, o que se descarte sin aviso.
 *    · T10 — que un marcador de máquina o de sesión en un campo de la nota llegue al informe o a la retro.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/reloop-rethink.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

// Un repo sin `packs:` toma los paquetes de `packs.default`; esta suite cuenta con «todos los instalados».
process.env.TYCON_PACKS_DEFAULT = (process.env.TYCON_PACKS_DEFAULT || '').trim() || 'all';

const SCRIPTS = path.join(__dirname, '..');
const SKILL = path.join(SCRIPTS, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const HEARTBEAT = path.resolve(SKILL, '..', '..', 'scripts', 'metrics', 'retro-heartbeat.js');
const SID = 'test-rethink';
const RUN = '9.9-20261018000000';

const REPETIDO = 'Volvió el mismo hallazgo de cobertura en las tres vueltas, siempre sobre el mismo archivo';
const CAMBIO = 'Cambia el enfoque: el cálculo pasa a una función pura y deja de leer el estado de la sesión';
const IGUAL = 'Sigue igual: los hallazgos eran de estilo y ya están cerrados, no cambia el diseño de fondo';

/** Repo git real con una story y la carpeta de una corrida. */
function mkRepo({ findings = null } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'rethink-repo-'));
  const fecha = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', r, ...a], { stdio: 'ignore', env: { ...process.env, ...fecha } });
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.writeFileSync(path.join(r, 'src', 'a.js'), '// base\n');
  fs.writeFileSync(path.join(r, 'story.md'),
    ['---', 'story: 9.9', 'epic: 9', 'status: in-progress', '---', '', '## Acceptance Criteria', '- AC1: x', ''].join('\n'));
  const run = path.join(r, '.advisors', 'pipeline-runs', RUN);
  fs.mkdirSync(run, { recursive: true });
  if (findings) fs.writeFileSync(path.join(run, 'findings.json'), JSON.stringify(findings, null, 2));
  else fs.writeFileSync(path.join(run, '.keep'), '');
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '.'); git('commit', '-qm', 'base');
  return { repo: r, run };
}

const hallazgo = (rule, file, iter) => ({
  rule_id: rule, severity: 'CRITICAL', advisor: `tycon-plugin-tests-coverage (iter ${iter})`, iter, file, disposition: 'fixed', reason: 'cobertura',
});

// el tope de vueltas al máximo (el ajuste de la máquina): acá se mide la nota de «repensar», que pide la tercera vuelta y
// las siguientes
const home = () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'rethink-home-'));
  fs.mkdirSync(path.join(h, '.claude', '.tycon-pipeline'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', '.tycon-pipeline', 'review-max-rounds.json'), '{ "max_rounds": 99 }\n');
  return h;
};
const env = (h) => ({ ...process.env, HOME: h, USERPROFILE: h, CLAUDE_CODE_SESSION_ID: SID, TYCON_TODAY: '2026-10-18' });

function reloop(repo, iter, extra = []) {
  const h = home();
  const r = spawnSync(process.execPath,
    [PIPELINE, 'smart-reloop', '--iter', String(iter), '--repo', repo, '--story', path.join(repo, 'story.md'), '--files', 'src/a.js', ...extra],
    { encoding: 'utf8', env: env(h) });
  return r;
}

function rethink(repo, args) {
  return spawnSync(process.execPath, [MARKER, 'rethink', ...args, '--repo', repo, '--story', path.join(repo, 'story.md')],
    { encoding: 'utf8', env: env(home()) });
}

const nota = (repo, iter, extra = ['--change', CAMBIO]) => rethink(repo, ['--iter', String(iter), '--repeated', REPETIDO, ...extra]);

// ── T1 ───────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si la tercera vuelta sin nota devuelve el set (salida 0), o si --force-full-reloop la deja pasar.
test('T1 · Reloop_TerceraSinNota_Frena', () => {
  const { repo } = mkRepo({ findings: [
    hallazgo('TEST-C1', 'src/a.js', 1), hallazgo('TEST-C1', 'src/a.js', 2), hallazgo('SEC-C2', 'src/b.js', 2),
  ] });
  for (const extra of [[], ['--force-full-reloop']]) {
    const r = reloop(repo, 3, extra);
    assert.notEqual(r.status, 0, `tendría que frenar ${extra.join(' ')}: ${r.stdout.slice(0, 200)}`);
    assert.doesNotMatch(r.stdout, /"rerun"/, 'no tiene que devolver el set');
    assert.match(r.stderr, /TEST-C1/, 'dice qué hallazgo volvió');
    assert.match(r.stderr, /src\/a\.js/);
    assert.doesNotMatch(r.stderr, /SEC-C2/, 'un hallazgo de una sola vuelta no volvió');
    assert.match(r.stderr, /marker\.js rethink --iter 3/, 'dice el comando de la nota');
  }
  // sin findings.json no se puede saber qué volvió, y lo dice en vez de inventar
  const { repo: sinInforme } = mkRepo();
  const s = reloop(sinInforme, 3);
  assert.notEqual(s.status, 0);
  assert.match(s.stderr, /No puedo saber/);
  assert.match(s.stderr, /marker\.js rethink --iter 3/);
});

// ── T2 ───────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si el freno se adelanta a la segunda vuelta (o a la primera).
test('T2 · Reloop_SegundaVuelta_SigueIgual', () => {
  const { repo } = mkRepo({ findings: [hallazgo('TEST-C1', 'src/a.js', 1), hallazgo('TEST-C1', 'src/a.js', 2)] });
  for (const iter of [1, 2]) {
    const r = reloop(repo, iter);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Array.isArray(JSON.parse(r.stdout).rerun), `iter ${iter}: devuelve el set`);
  }
});

// ── T3 ───────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si una nota vacía, de menos de 40 caracteres, sin --repeated o sin decidir entre --change y --keep se guarda.
test('T3 · Rethink_NotaCorta_Rechazada', () => {
  const { repo, run } = mkRepo();
  const corta = 'cambio poco';
  const justo = 'x'.repeat(39);
  const casos = [
    ['campo vacío', ['--iter', '3', '--repeated', '', '--change', CAMBIO], /--repeated/],
    ['nota de 10 caracteres', ['--iter', '3', '--repeated', REPETIDO, '--change', corta], /--change.*40/s],
    ['39 caracteres', ['--iter', '3', '--repeated', justo, '--change', CAMBIO], /--repeated.*40/s],
    ['sin --repeated', ['--iter', '3', '--change', CAMBIO], /--repeated/],
    ['ni --change ni --keep', ['--iter', '3', '--repeated', REPETIDO], /--change.*--keep|--keep.*--change/s],
    ['--change y --keep juntos', ['--iter', '3', '--repeated', REPETIDO, '--change', CAMBIO, '--keep', IGUAL], /--change.*--keep|--keep.*--change/s],
    ['--story-change corto', ['--iter', '3', '--repeated', REPETIDO, '--change', CAMBIO, '--story-change', 'la story'], /--story-change/],
    ['sin --iter', ['--repeated', REPETIDO, '--change', CAMBIO], /--iter/],
  ];
  for (const [nombre, args, motivo] of casos) {
    const r = rethink(repo, args);
    assert.notEqual(r.status, 0, `${nombre}: tendría que rechazarse`);
    assert.match(r.stderr, motivo, nombre);
    assert.ok(!fs.existsSync(path.join(run, 'rethink', 'iter-3.json')), `${nombre}: no se guarda nada`);
  }
  // 40 justos, con --keep y con --story-change: se guarda con su hora
  const ok = rethink(repo, ['--iter', '3', '--repeated', 'y'.repeat(40), '--keep', IGUAL, '--story-change', CAMBIO]);
  assert.equal(ok.status, 0, ok.stderr);
  const guardada = JSON.parse(fs.readFileSync(path.join(run, 'rethink', 'iter-3.json'), 'utf8'));
  assert.equal(guardada.iter, 3);
  assert.equal(guardada.keep, IGUAL);
  assert.equal(guardada.change, undefined);
  assert.equal(guardada.story_change, CAMBIO);
  assert.ok(Number.isFinite(Date.parse(guardada.at)), 'trae su hora');
});

// ── T4 ───────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si la nota de la vuelta 3 vale para la 4, o si con la nota la 3 no sigue como hoy.
test('T4 · Reloop_ConNota_Sigue_YLaCuarta_PideOtra', () => {
  const { repo } = mkRepo({ findings: [hallazgo('TEST-C1', 'src/a.js', 1), hallazgo('TEST-C1', 'src/a.js', 2)] });
  const n = nota(repo, 3);
  assert.equal(n.status, 0, n.stderr);
  const tres = reloop(repo, 3);
  assert.equal(tres.status, 0, tres.stderr);
  assert.ok(Array.isArray(JSON.parse(tres.stdout).rerun), 'con la nota devuelve el set');
  const otra = mkRepo({ findings: [hallazgo('TEST-C1', 'src/a.js', 1), hallazgo('TEST-C1', 'src/a.js', 2)] });
  assert.equal(nota(otra.repo, 3).status, 0);
  const forzada = reloop(otra.repo, 3, ['--force-full-reloop']);
  assert.equal(forzada.status, 0, forzada.stderr);
  assert.ok(Array.isArray(JSON.parse(forzada.stdout).rerun), 'forzada, con la nota, también devuelve el set');
  const cuatro = reloop(repo, 4);
  assert.notEqual(cuatro.status, 0, 'la cuarta pide su propia nota');
  assert.match(cuatro.stderr, /marker\.js rethink --iter 4/);
  assert.equal(nota(repo, 4, ['--keep', IGUAL]).status, 0);
  assert.equal(reloop(repo, 4).status, 0);
});

// ── T5 ───────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si write-findings no trae las notas y la cantidad de vueltas, si el archivo de la retrospectiva no suma
// `rethink_notes`, o si sin notas ese campo aparece (un 0 falso).
test('T5 · Informe_TraeLasNotas', () => {
  const { repo, run } = mkRepo();
  assert.equal(nota(repo, 3).status, 0);
  assert.equal(nota(repo, 4, ['--keep', IGUAL]).status, 0);
  const archivo = path.join(repo, 'in.json');
  fs.writeFileSync(archivo, JSON.stringify([hallazgo('TEST-C1', 'src/a.js', 4)]));
  const w = spawnSync(process.execPath, [PIPELINE, 'write-findings', '--story', path.join(repo, 'story.md'), '--repo', repo, '--findings', archivo],
    { encoding: 'utf8', env: env(home()) });
  assert.equal(w.status, 0, w.stderr + w.stdout);
  const informe = JSON.parse(w.stdout);
  assert.equal(informe.rethink.rounds, 4);
  assert.deepEqual(informe.rethink.notes.map((x) => x.iter), [3, 4]);
  assert.match(informe.note, /2 notas de repensar/);
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(path.join(run, 'findings.json'), 'utf8'))), 'findings.json sigue siendo el array de siempre');

  const latido = (r) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rethink-out-'));
    const h = spawnSync(process.execPath, [HEARTBEAT, '--repo', r, '--merge', 'HEAD', '--story', '9.9', '--out', out],
      { encoding: 'utf8', env: env(home()) });
    assert.equal(h.status, 0, h.stderr);
    return JSON.parse(fs.readFileSync(h.stdout.trim(), 'utf8'));
  };
  const doc = latido(repo);
  assert.deepEqual(doc.rethink_notes.map((x) => x.iter), [3, 4]);
  assert.equal(doc.rethink_notes[0].change, CAMBIO);
  assert.ok(doc.metrics.advisor_rerun_loop_iterations, 'la métrica de vueltas sigue al lado');

  const { repo: limpio } = mkRepo();
  assert.ok(!('rethink_notes' in latido(limpio)), 'sin notas el campo no aparece');
});

// ── T6 ───────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si el paso del re-loop o la regla D.i de la portada no dicen la regla y no nombran `marker.js rethink`.
test('T6 · Guia_TerceraVueltaRepensar', () => {
  const paso = fs.readFileSync(path.join(SKILL, 'steps', 'step-07b-rerun-advisors-if-fixes.md'), 'utf8');
  const portada = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(paso, /marker\.js rethink/);
  assert.match(paso, /tercera vuelta/i);
  assert.match(paso, /--repeated/);
  assert.match(paso, /--change/);
  assert.match(paso, /--keep/);
  const ini = portada.indexOf('**D.i');
  const fin = portada.indexOf('**E.i');
  assert.ok(ini >= 0 && fin > ini, 'la portada tiene su regla D.i');
  const reglaDi = portada.slice(ini, fin);
  assert.match(reglaDi, /marker\.js rethink/);
  assert.match(reglaDi, /tercera vuelta/i);
});

// ── T7 ───────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si `advisors --iter 3` devuelve el set completo sin la nota (es el fallback del re-loop), o si la vuelta 2 frena.
test('T7 · Advisors_TerceraSinNota_Frena', () => {
  const { repo } = mkRepo({ findings: [hallazgo('TEST-C1', 'src/a.js', 1), hallazgo('TEST-C1', 'src/a.js', 2)] });
  const adv = (iter) => spawnSync(process.execPath,
    [PIPELINE, 'advisors', '--iter', String(iter), '--repo', repo, '--story', path.join(repo, 'story.md'), '--files', 'src/a.js'],
    { encoding: 'utf8', env: env(home()) });
  const sin = adv(3);
  assert.notEqual(sin.status, 0, `tendría que frenar: ${sin.stdout.slice(0, 200)}`);
  assert.doesNotMatch(sin.stdout, /"all"/, 'no devuelve el set');
  assert.match(sin.stderr, /marker\.js rethink --iter 3/);
  assert.equal(adv(2).status, 0, 'la segunda vuelta sigue como hoy');
  assert.equal(nota(repo, 3).status, 0);
  assert.equal(adv(3).status, 0, 'con la nota sigue');
});

// ── T8 ───────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si con --story relativa (y otro directorio de trabajo) el freno busca la corrida donde la nota no está.
test('T8 · Story_Relativa_MismaCarpeta', () => {
  const { repo, run } = mkRepo({ findings: [hallazgo('TEST-C1', 'src/a.js', 1), hallazgo('TEST-C1', 'src/a.js', 2)] });
  const otro = fs.mkdtempSync(path.join(os.tmpdir(), 'rethink-cwd-'));
  const h = home();
  const marcar = spawnSync(process.execPath, [MARKER, 'rethink', '--iter', '3', '--repeated', REPETIDO, '--change', CAMBIO, '--repo', repo, '--story', 'story.md'],
    { encoding: 'utf8', env: env(h), cwd: otro });
  assert.equal(marcar.status, 0, marcar.stderr);
  assert.ok(fs.existsSync(path.join(run, 'rethink', 'iter-3.json')), 'marker guarda en la corrida del repo');
  const gate = spawnSync(process.execPath, [PIPELINE, 'smart-reloop', '--iter', '3', '--repo', repo, '--story', 'story.md', '--files', 'src/a.js'],
    { encoding: 'utf8', env: env(h), cwd: otro });
  assert.equal(gate.status, 0, `el freno tiene que ver la misma nota: ${gate.stderr}`);
});

// ── T9 ───────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si una nota escrita a mano de menos de 40 caracteres deja pasar el freno, la retro la cuenta como válida,
// o write-findings y la retro la descartan sin decir «nota ilegible/incompleta de la vuelta 3».
test('T9 · NotaACamino_Corta_NoCuenta_YSeDice', () => {
  const { repo, run } = mkRepo();
  fs.mkdirSync(path.join(run, 'rethink'), { recursive: true });
  fs.writeFileSync(path.join(run, 'rethink', 'iter-3.json'), JSON.stringify({ iter: 3, repeated: 'corto', change: 'corto', at: '2026-10-18T00:00:00Z' }));
  const r = reloop(repo, 3);
  assert.notEqual(r.status, 0, 'el freno sigue frenando');
  assert.match(r.stderr, /La nota que hay en la corrida no sirve/);
  const archivo = path.join(repo, 'in.json');
  fs.writeFileSync(archivo, JSON.stringify([hallazgo('TEST-C1', 'src/a.js', 3)]));
  const w = spawnSync(process.execPath, [PIPELINE, 'write-findings', '--story', path.join(repo, 'story.md'), '--repo', repo, '--findings', archivo],
    { encoding: 'utf8', env: env(home()) });
  assert.equal(w.status, 0, w.stderr + w.stdout);
  const informe = JSON.parse(w.stdout);
  assert.equal(informe.rethink, undefined, 'no se cuenta como nota válida');
  assert.ok((informe.warnings || []).some((x) => /nota ilegible\/incompleta de la vuelta 3/.test(x)), JSON.stringify(informe.warnings));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rethink-out-'));
  const h = spawnSync(process.execPath, [HEARTBEAT, '--repo', repo, '--merge', 'HEAD', '--story', '9.9', '--out', out], { encoding: 'utf8', env: env(home()) });
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stderr, /nota ilegible\/incompleta de la vuelta 3/);
  const doc = JSON.parse(fs.readFileSync(h.stdout.trim(), 'utf8'));
  assert.equal(doc.rethink_notes, undefined, 'la retro no la cuenta');
  assert.equal(doc.rethink_notes_rotas[0].iter, 3);
});

// ── T10 ──────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si una ruta de máquina o un id de sesión metido en repeated / change / keep / story_change llega tal cual
// a la salida de write-findings o al archivo de la retro.
test('T10 · Nota_CamposSaneados', () => {
  const { repo } = mkRepo();
  // la ruta de máquina se arma por partes: escrita entera, el freno de publicación la toma por una de verdad
  const ruta = ['', 'Users', 'zzdev', 'Clientes', 'Acme SA', 'secreto.cs'].join('/');
  const ses = '12345678-1234-1234-1234-123456789abc';
  const campo = (t) => `${t} en ${ruta} sesión ${ses} para que pase el mínimo`;
  assert.equal(rethink(repo, ['--iter', '3', '--repeated', campo('r'), '--change', campo('c'), '--story-change', campo('s')]).status, 0);
  assert.equal(rethink(repo, ['--iter', '4', '--repeated', campo('r'), '--keep', campo('k')]).status, 0);
  const archivo = path.join(repo, 'in.json');
  fs.writeFileSync(archivo, JSON.stringify([hallazgo('TEST-C1', 'src/a.js', 4)]));
  const w = spawnSync(process.execPath, [PIPELINE, 'write-findings', '--story', path.join(repo, 'story.md'), '--repo', repo, '--findings', archivo],
    { encoding: 'utf8', env: env(home()) });
  assert.equal(w.status, 0, w.stderr);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rethink-out-'));
  const h = spawnSync(process.execPath, [HEARTBEAT, '--repo', repo, '--merge', 'HEAD', '--story', '9.9', '--out', out], { encoding: 'utf8', env: env(home()) });
  assert.equal(h.status, 0, h.stderr);
  const retro = fs.readFileSync(h.stdout.trim(), 'utf8');
  for (const [nombre, texto] of [['write-findings', w.stdout], ['retro', retro]]) {
    assert.doesNotMatch(texto, /zzdev|Acme SA|secreto\.cs/, `${nombre}: ruta de máquina`);
    assert.doesNotMatch(texto, new RegExp(ses), `${nombre}: id de sesión`);
  }
  const inf = JSON.parse(w.stdout).rethink.notes;
  for (const k of ['repeated', 'change', 'story_change']) assert.ok(inf[0][k], `write-findings trae ${k}`);
  assert.ok(inf[1].keep, 'write-findings trae keep');
  const doc = JSON.parse(retro);
  for (const k of ['repeated', 'change', 'story_change']) assert.ok(doc.rethink_notes[0][k], `la retro trae ${k}`);
  assert.ok(doc.rethink_notes[1].keep);
});

// ── T11 ──────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si write-findings descarta el `iter` del hallazgo (cuando el firmante no lo trae anotado): repeatedFindings
// devuelve known:false y el freno no puede decir qué hallazgo volvió.
test('T11 · WriteFindings_ConservaIter_YRepeatedLoUsa', () => {
  const { repo, run } = mkRepo();
  const archivo = path.join(repo, 'in.json');
  const f = (iter) => ({ rule_id: 'TEST-C1', severity: 'CRITICAL', advisor: 'tycon-plugin-tests-coverage', iter, file: 'src/a.js', disposition: 'fixed', reason: 'cobertura' });
  fs.writeFileSync(archivo, JSON.stringify([f(1), f(2)]));
  const w = spawnSync(process.execPath, [PIPELINE, 'write-findings', '--story', path.join(repo, 'story.md'), '--repo', repo, '--findings', archivo],
    { encoding: 'utf8', env: env(home()) });
  assert.equal(w.status, 0, w.stderr + w.stdout);
  const escrito = JSON.parse(fs.readFileSync(path.join(run, 'findings.json'), 'utf8'));
  assert.deepEqual(escrito.map((x) => x.iter), [1, 2]);
  const rep = require(path.join(SCRIPTS, 'lib', 'rethink.js')).repeatedFindings(run);
  assert.equal(rep.known, true, JSON.stringify(rep));
  assert.deepEqual(rep.items.map((x) => x.iters), [[1, 2]]);
});

// ── T12 ──────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si una nota guardada como iter-3.json pero que dice `iter: 4` vale para la vuelta 3: smart-reloop devuelve
// el set (salida 0), readNote dice ok, o listNotes la publica como la vuelta 4.
test('T12 · Nota_IterInternoDistinto_NoVale', () => {
  const { repo, run } = mkRepo();
  fs.mkdirSync(path.join(run, 'rethink'), { recursive: true });
  fs.writeFileSync(path.join(run, 'rethink', 'iter-3.json'), JSON.stringify({ iter: 4, repeated: REPETIDO, change: CAMBIO, at: '2026-10-18T00:00:00Z' }));
  const rt = require(path.join(SCRIPTS, 'lib', 'rethink.js'));
  const r = rt.readNote(run, 3);
  assert.equal(r.ok, false);
  assert.match(r.reason, /vuelta 3 pero dice ser de la vuelta 4/);
  assert.deepEqual(rt.listNotes(run), []);
  const g = reloop(repo, 3);
  assert.notEqual(g.status, 0, 'el freno sigue');
  assert.match(g.stderr, /La nota que hay en la corrida no sirve.*vuelta 4/s);
});

// ── T13 ──────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si la retro elige la carpeta por prefijo / la más nueva aunque esté vacía: con una corrida real y otra vacía
// más nueva de la misma story, o con una story de prefijo parecido (9.9-1), omite o toma las notas equivocadas.
test('T13 · Retro_LeeSoloLaCarpetaExactaDeLaCorrida', () => {
  const { repo, run } = mkRepo();
  fs.mkdirSync(path.join(run, 'rethink'), { recursive: true });
  fs.writeFileSync(path.join(run, 'rethink', 'iter-3.json'), JSON.stringify({ iter: 3, repeated: REPETIDO, change: CAMBIO, at: '2026-10-18T00:00:00Z' }));
  const base = path.join(repo, '.advisors', 'pipeline-runs');
  fs.mkdirSync(path.join(base, '9.9-20261019000000'), { recursive: true }); // vacía y más nueva
  const otra = path.join(base, '9.9-1-20261020000000', 'rethink'); // otra story con prefijo parecido
  fs.mkdirSync(otra, { recursive: true });
  fs.writeFileSync(path.join(otra, 'iter-3.json'), JSON.stringify({ iter: 3, repeated: 'OTRA ' + REPETIDO, change: CAMBIO, at: '2026-10-18T00:00:00Z' }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rethink-out-'));
  const h = spawnSync(process.execPath, [HEARTBEAT, '--repo', repo, '--merge', 'HEAD', '--story', '9.9', '--out', out], { encoding: 'utf8', env: env(home()) });
  assert.equal(h.status, 0, h.stderr);
  const doc = JSON.parse(fs.readFileSync(h.stdout.trim(), 'utf8'));
  assert.ok(doc.rethink_notes && doc.rethink_notes.length === 1, JSON.stringify(doc.rethink_notes));
  assert.doesNotMatch(doc.rethink_notes[0].repeated, /^OTRA/);
});

// ── T14 ──────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si una vuelta ≥3 recibe el set sin su nota porque quien llama declaró una vuelta menor: `advisors` sin
// --iter, o `smart-reloop --iter 1/2`, con dos fotos de iteración guardadas en el marcador (la vuelta real es la 3).
test('T14 · Freno_UsaLaVueltaEfectiva_NoLaDeclarada', () => {
  const { repo } = mkRepo({ findings: [hallazgo('TEST-C1', 'src/a.js', 1), hallazgo('TEST-C1', 'src/a.js', 2)] });
  const h = home();
  const activo = path.join(require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(h), 'active');
  fs.mkdirSync(activo, { recursive: true });
  fs.writeFileSync(path.join(activo, `${SID}.json`), JSON.stringify({
    sessionId: SID, repoPath: repo, iterations: { 1: { ts: '2026-10-18T00:00:00Z', filesSnapshot: [] }, 2: { ts: '2026-10-18T00:01:00Z', filesSnapshot: [] } },
  }));
  const story = path.join(repo, 'story.md');
  const corre = (cmd, extra) => spawnSync(process.execPath, [PIPELINE, cmd, '--repo', repo, '--story', story, '--files', 'src/a.js', ...extra],
    { encoding: 'utf8', env: env(h) });
  for (const [cmd, extra] of [['advisors', []], ['smart-reloop', ['--iter', '1']], ['smart-reloop', ['--iter', '2']], ['advisors', ['--iter', '2']]]) {
    const r = corre(cmd, extra);
    assert.notEqual(r.status, 0, `${cmd} ${extra.join(' ')} tendría que frenar: ${r.stdout.slice(0, 160)}`);
    assert.doesNotMatch(r.stdout, /"rerun"|"all"/, 'no devuelve el set');
    assert.match(r.stderr, /marker\.js rethink --iter 3/, 'pide la nota de la vuelta efectiva');
    if (extra.length) assert.match(r.stderr, new RegExp(`Pediste la vuelta ${extra[1]}, pero el marcador`), 'dice las dos vueltas');
  }
  assert.equal(nota(repo, 3).status, 0);
  assert.equal(corre('advisors', []).status, 0, 'con la nota de la vuelta 3 sigue');
});

// ── T15 ──────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si --run-dir toma cualquier carpeta: la nota de OTRA story (o de una carpeta cualquiera) deja pasar el freno.
test('T15 · RunDir_AjenoNoVale', () => {
  const { repo, run } = mkRepo();
  const ajena = fs.mkdtempSync(path.join(os.tmpdir(), 'rethink-ajena-'));
  fs.mkdirSync(path.join(ajena, 'rethink'), { recursive: true });
  fs.writeFileSync(path.join(ajena, 'rethink', 'iter-3.json'), JSON.stringify({ iter: 3, repeated: REPETIDO, change: CAMBIO, at: '2026-10-18T00:00:00Z' }));
  const otraStory = path.join(repo, '.advisors', 'pipeline-runs', '7.7-20261018000000');
  fs.mkdirSync(path.join(otraStory, 'rethink'), { recursive: true });
  fs.writeFileSync(path.join(otraStory, 'rethink', 'iter-3.json'), JSON.stringify({ iter: 3, repeated: REPETIDO, change: CAMBIO, at: '2026-10-18T00:00:00Z' }));
  for (const rd of [ajena, otraStory]) {
    const r = reloop(repo, 3, ['--run-dir', rd]);
    assert.notEqual(r.status, 0, `--run-dir ${rd} tendría que frenar: ${r.stdout.slice(0, 160)}`);
    assert.doesNotMatch(r.stdout, /"rerun"/);
    assert.match(r.stderr, /no es la carpeta de corrida de esta story/);
  }
  assert.equal(nota(repo, 3).status, 0);
  assert.equal(reloop(repo, 3, ['--run-dir', run]).status, 0, 'la carpeta de esta story sí vale');
});

// ── T16 ──────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si el aviso de una nota rota (informe, `rethink_notes_rotas` de la retro, salida de error) lleva tal cual una
// ruta de máquina o un id de sesión que venía dentro de la nota.
test('T16 · AvisoDeNotaRota_Saneado', () => {
  const { repo, run } = mkRepo();
  // la ruta de máquina se arma por partes: escrita entera, el freno de publicación la toma por una de verdad
  const ruta = ['', 'Users', 'zzdev', 'Clientes', 'Acme SA', 'secreto.cs'].join('/');
  const ses = '12345678-1234-1234-1234-123456789abc';
  fs.mkdirSync(path.join(run, 'rethink'), { recursive: true });
  fs.writeFileSync(path.join(run, 'rethink', 'iter-3.json'), JSON.stringify({ iter: `${ruta} ${ses}`, repeated: REPETIDO, change: CAMBIO, at: `${ruta} ${ses}` }));
  const archivo = path.join(repo, 'in.json');
  fs.writeFileSync(archivo, JSON.stringify([hallazgo('TEST-C1', 'src/a.js', 3)]));
  const w = spawnSync(process.execPath, [PIPELINE, 'write-findings', '--story', path.join(repo, 'story.md'), '--repo', repo, '--findings', archivo],
    { encoding: 'utf8', env: env(home()) });
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /nota ilegible\/incompleta de la vuelta 3/, 'el aviso sigue saliendo');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rethink-out-'));
  const h = spawnSync(process.execPath, [HEARTBEAT, '--repo', repo, '--merge', 'HEAD', '--story', '9.9', '--out', out], { encoding: 'utf8', env: env(home()) });
  assert.equal(h.status, 0, h.stderr);
  const retro = fs.readFileSync(h.stdout.trim(), 'utf8');
  assert.match(retro, /rethink_notes_rotas/);
  for (const [nombre, texto] of [['write-findings', w.stdout], ['retro', retro], ['stderr de la retro', h.stderr]]) {
    assert.doesNotMatch(texto, /zzdev|Acme SA|secreto\.cs/, `${nombre}: ruta de máquina`);
    assert.doesNotMatch(texto, new RegExp(ses), `${nombre}: id de sesión`);
  }
  // una nota válida con `at` sucio tampoco lo lleva
  fs.writeFileSync(path.join(run, 'rethink', 'iter-3.json'), JSON.stringify({ iter: 3, repeated: REPETIDO, change: CAMBIO, at: `${ruta} ${ses}` }));
  const w2 = spawnSync(process.execPath, [PIPELINE, 'write-findings', '--story', path.join(repo, 'story.md'), '--repo', repo, '--findings', archivo],
    { encoding: 'utf8', env: env(home()) });
  assert.doesNotMatch(w2.stdout, /zzdev|Acme SA|secreto\.cs/, 'el campo at también se sanea');
});

// ── T17 ──────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si un marcador de sesión que existe y no se puede leer deja pasar el set: no se sabe cuántas vueltas
// lleva la corrida, y ante la duda el freno frena (y dice por qué).
test('T17 · Marcador_Ilegible_Frena', () => {
  const { repo } = mkRepo();
  const h = home();
  const activo = path.join(require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(h), 'active');
  fs.mkdirSync(activo, { recursive: true });
  const story = path.join(repo, 'story.md');
  const corre = (cmd, extra) => spawnSync(process.execPath, [PIPELINE, cmd, '--repo', repo, '--story', story, '--files', 'src/a.js', ...extra],
    { encoding: 'utf8', env: env(h) });
  for (const roto of ['{"iterations": {"1": ', 'null', '[]']) {
    fs.writeFileSync(path.join(activo, `${SID}.json`), roto);
    for (const [cmd, extra] of [['advisors', []], ['smart-reloop', ['--iter', '1']]]) {
      const r = corre(cmd, extra);
      assert.notEqual(r.status, 0, `${cmd} con el marcador ${JSON.stringify(roto)} tendría que frenar: ${r.stdout.slice(0, 160)}`);
      assert.doesNotMatch(r.stdout, /"rerun"|"all"/, 'no devuelve el set');
      assert.match(r.stderr, /marcador de la sesión/, 'dice que el marcador no se puede leer');
    }
  }
  // sin marcador (no existe) sigue andando: lo que vale es la carpeta de la corrida
  fs.rmSync(path.join(activo, `${SID}.json`));
  assert.equal(corre('smart-reloop', ['--iter', '1']).status, 0);
});

// ── T18 ──────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si, sin marcador, pedir la vuelta 1 en la tercera vuelta de la corrida devuelve el set: la carpeta de la
// corrida anota cada vuelta servida (rethink/served.json) y una vuelta igual o menor que la última servida cuenta como la siguiente.
test('T18 · SinMarcador_Iter1EnLaTerceraVuelta_FrenaPorServed', () => {
  const { repo, run } = mkRepo({ findings: [hallazgo('TEST-C1', 'src/a.js', 1), hallazgo('TEST-C1', 'src/a.js', 2)] });
  const h = home();
  const story = path.join(repo, 'story.md');
  const corre = (cmd, extra) => spawnSync(process.execPath, [PIPELINE, cmd, '--repo', repo, '--story', story, '--files', 'src/a.js', ...extra],
    { encoding: 'utf8', env: env(h) });
  assert.equal(corre('advisors', ['--iter', '1']).status, 0);
  assert.equal(corre('smart-reloop', ['--iter', '2']).status, 0);
  const served = JSON.parse(fs.readFileSync(path.join(run, 'rethink', 'served.json'), 'utf8'));
  assert.deepEqual(served.served, [1, 2], 'la carpeta anota las vueltas servidas');
  for (const [cmd, extra] of [['smart-reloop', ['--iter', '1']], ['advisors', []], ['advisors', ['--iter', '1']]]) {
    const r = corre(cmd, extra);
    assert.notEqual(r.status, 0, `${cmd} ${extra.join(' ')} en la tercera vuelta tendría que frenar: ${r.stdout.slice(0, 160)}`);
    assert.doesNotMatch(r.stdout, /"rerun"|"all"/);
    assert.match(r.stderr, /marker\.js rethink --iter 3/, 'pide la nota de la vuelta 3');
    assert.match(r.stderr, /ya se sirvió la vuelta 2/, 'dice por qué cuenta la tercera');
  }
  // con la nota de la vuelta 3 sale la 3, y cualquier pedido siguiente (aunque repita la 3) es la 4 y pide su nota
  assert.equal(nota(repo, 3).status, 0);
  assert.equal(corre('smart-reloop', ['--iter', '1']).status, 0, 'con la nota de la 3 sale la 3');
  const cuarta = corre('smart-reloop', ['--iter', '3']);
  assert.notEqual(cuarta.status, 0, 'pedir la 3 ya servida es la 4: pide su nota');
  assert.match(cuarta.stderr, /marker\.js rethink --iter 4/);
  // un registro de vueltas servidas ilegible frena: no se sabe cuántas van
  fs.writeFileSync(path.join(run, 'rethink', 'served.json'), '{roto');
  const r = corre('smart-reloop', ['--iter', '1']);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /"rerun"/);
  assert.match(r.stderr, /served\.json/);
});

// ── T19 ──────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si el `iter` que lleva guardada una foto del marcador no cuenta como vuelta: una foto con iter 3 hace
// que pedir la vuelta 1 sea la tercera.
test('T19 · Marcador_IterGuardado_CuentaLaVuelta', () => {
  const { repo } = mkRepo({ findings: [hallazgo('TEST-C1', 'src/a.js', 1), hallazgo('TEST-C1', 'src/a.js', 2)] });
  const h = home();
  const activo = path.join(require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(h), 'active');
  fs.mkdirSync(activo, { recursive: true });
  fs.writeFileSync(path.join(activo, `${SID}.json`), JSON.stringify({ sessionId: SID, repoPath: repo, iterations: { 1: { iter: 3, ts: '2026-10-18T00:00:00Z', filesSnapshot: [] } } }));
  const r = spawnSync(process.execPath, [PIPELINE, 'smart-reloop', '--iter', '1', '--repo', repo, '--story', path.join(repo, 'story.md'), '--files', 'src/a.js'],
    { encoding: 'utf8', env: env(h) });
  assert.notEqual(r.status, 0, r.stdout.slice(0, 160));
  assert.doesNotMatch(r.stdout, /"rerun"/);
  assert.match(r.stderr, /marker\.js rethink --iter 3/);
});

// ── T20 ──────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si --run-dir toma la carpeta de OTRA corrida de la misma story: tiene que ser exactamente la que
// `resolveRunDir` da para esta story y este repo (lo mismo en `marker.js rethink --run-dir`, que además no escribe nada).
test('T20 · RunDir_OtraCorridaDeLaMismaStory_NoVale', () => {
  const { repo, run } = mkRepo();
  const otra = path.join(repo, '.advisors', 'pipeline-runs', '9.9-20260101000000');
  fs.mkdirSync(path.join(otra, 'rethink'), { recursive: true });
  fs.writeFileSync(path.join(otra, 'rethink', 'iter-3.json'), JSON.stringify({ iter: 3, repeated: REPETIDO, change: CAMBIO, at: '2026-10-18T00:00:00Z' }));
  const futuro = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(run, '.keep'), futuro, futuro); // la corrida propia es la más nueva: es la que elige resolveRunDir
  const r = reloop(repo, 3, ['--run-dir', otra]);
  assert.notEqual(r.status, 0, `tendría que frenar: ${r.stdout.slice(0, 160)}`);
  assert.doesNotMatch(r.stdout, /"rerun"/);
  assert.match(r.stderr, /no es la carpeta de corrida de esta story/);
  const m = rethink(repo, ['--iter', '4', '--repeated', REPETIDO, '--change', CAMBIO, '--run-dir', otra]);
  assert.notEqual(m.status, 0, 'marker.js rethink no escribe en otra corrida');
  assert.match(m.stderr, /no es la carpeta de corrida de esta story/);
  assert.ok(!fs.existsSync(path.join(otra, 'rethink', 'iter-4.json')), 'no se escribió la nota');
  // la propia, por su ruta exacta o por un enlace que apunta a ella, sí vale
  const m2 = rethink(repo, ['--iter', '3', '--repeated', REPETIDO, '--change', CAMBIO, '--run-dir', run]);
  assert.equal(m2.status, 0, m2.stderr);
  assert.ok(fs.existsSync(path.join(run, 'rethink', 'iter-3.json')));
  assert.equal(reloop(repo, 3, ['--run-dir', run]).status, 0);
});

// ── T21 ──────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si, sin --story, el freno no usa la story del marcador (deja pasar la vuelta 3 con --iter 1), o si sin
// --story y sin story en el marcador devuelve el set en vez de frenar diciendo qué pasarle.
test('T21 · 🔴 sale rojo si sin --story el freno ignora la story del marcador o deja pasar sin saber la corrida', () => {
  const { repo } = mkRepo({ findings: [hallazgo('TEST-C1', 'src/a.js', 1), hallazgo('TEST-C1', 'src/a.js', 2)] });
  const h = home();
  const story = path.join(repo, 'story.md');
  const conStory = (cmd, extra) => spawnSync(process.execPath, [PIPELINE, cmd, '--repo', repo, '--story', story, '--files', 'src/a.js', ...extra],
    { encoding: 'utf8', env: env(h) });
  const sinStory = (cmd, extra) => spawnSync(process.execPath, [PIPELINE, cmd, '--repo', repo, '--files', 'src/a.js', ...extra],
    { encoding: 'utf8', env: env(h) });
  // sin marcador y sin --story no hay corrida: con --iter 1 o 2 (o ninguno) pasa como siempre; con --iter 3 frena y dice qué pasar
  for (const [cmd, extra] of [['smart-reloop', ['--iter', '1']], ['advisors', []]]) {
    const r = sinStory(cmd, extra);
    assert.equal(r.status, 0, `${cmd} fuera de una corrida con vuelta 1 tiene que pasar: ${r.stderr.slice(0, 200)}`);
  }
  for (const cmd of ['smart-reloop', 'advisors']) {
    assert.equal(sinStory(cmd, ['--iter', '2']).status, 0);
    const r = sinStory(cmd, ['--iter', '3']);
    assert.notEqual(r.status, 0, `${cmd} sin corrida con --iter 3 tendría que frenar: ${r.stdout.slice(0, 160)}`);
    assert.doesNotMatch(r.stdout, /"rerun"|"all"/);
    assert.match(r.stderr, /--story/, 'dice qué pasarle');
  }
  assert.equal(conStory('advisors', ['--iter', '1']).status, 0);
  assert.equal(conStory('smart-reloop', ['--iter', '2']).status, 0);
  // marcador con la story: sin --story usa la del marcador y ve las vueltas servidas
  const activo = path.join(require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(h), 'active');
  fs.mkdirSync(activo, { recursive: true });
  // las vueltas 1 y 2 lanzaron sus revisores (las fotos que el arnés toma al lanzar el último)
  fs.writeFileSync(path.join(activo, `${SID}.json`), JSON.stringify({ sessionId: SID, repoPath: repo, storyPath: story, iterations: { 1: { files: {} }, 2: { files: {} } } }));
  const r = sinStory('smart-reloop', ['--iter', '1']);
  assert.notEqual(r.status, 0, r.stdout.slice(0, 160));
  assert.doesNotMatch(r.stdout, /"rerun"/);
  assert.match(r.stderr, /marker\.js rethink --iter 3/);
  // marcador sin story y sin --story: no hay corrida; con --iter 3 frena
  fs.writeFileSync(path.join(activo, `${SID}.json`), JSON.stringify({ sessionId: SID, repoPath: repo }));
  assert.equal(sinStory('smart-reloop', ['--iter', '1']).status, 0);
  const sin = sinStory('smart-reloop', ['--iter', '3']);
  assert.notEqual(sin.status, 0);
  assert.doesNotMatch(sin.stdout, /"rerun"/);
  assert.match(sin.stderr, /--story/);
});

// ── T22 ──────────────────────────────────────────────────────────────────────────────────────────
// 🔴 sale rojo si, con las vueltas 1 y 2 servidas, pedir otra vez `--iter 2` devuelve el set: pedir una vuelta ya
// servida cuenta como una vuelta nueva (la 3) y pide su nota.
test('T22 · 🔴 sale rojo si pedir otra vez una vuelta ya servida devuelve el set sin la nota de la siguiente', () => {
  const { repo } = mkRepo({ findings: [hallazgo('TEST-C1', 'src/a.js', 1), hallazgo('TEST-C1', 'src/a.js', 2)] });
  const h = home();
  const story = path.join(repo, 'story.md');
  const corre = (cmd, extra) => spawnSync(process.execPath, [PIPELINE, cmd, '--repo', repo, '--story', story, '--files', 'src/a.js', ...extra],
    { encoding: 'utf8', env: env(h) });
  assert.equal(corre('smart-reloop', ['--iter', '1']).status, 0);
  assert.equal(corre('smart-reloop', ['--iter', '2']).status, 0);
  const r = corre('smart-reloop', ['--iter', '2']);
  assert.notEqual(r.status, 0, r.stdout.slice(0, 160));
  assert.doesNotMatch(r.stdout, /"rerun"|"all"/);
  assert.match(r.stderr, /marker\.js rethink --iter 3/);
  assert.match(r.stderr, /ya se sirvió la vuelta 2/);
});

// 🔴 sale rojo si, con una story cuyo número no sirve para nombrar la carpeta de la corrida y sin marcador, el set se
// entrega una y otra vez con un aviso: sin carpeta donde contar las vueltas, `--iter 1` repetido puede ser la tercera
// vuelta, y ante la duda el freno frena (diciendo por qué).
test('T23 · 🔴 sale rojo si sin carpeta de corrida donde contar las vueltas el set se entrega igual', () => {
  const { repo } = mkRepo({ findings: [] });
  const h = home();
  const rara = path.join(repo, 'story-rara.md');
  fs.writeFileSync(rara, '---\nstory: "9 9"\ntitle: "x"\n---\n# Story\n');
  const correr = (cmd, extra) => spawnSync(process.execPath, [PIPELINE, cmd, '--repo', repo, '--story', rara, '--files', 'src/a.js', ...extra],
    { encoding: 'utf8', env: env(h) });
  // sin corrida (la story no da carpeta): las vueltas 1 y 2 pasan como siempre, desde la 3 frena
  for (const [cmd, extra] of [['smart-reloop', ['--iter', '1']], ['advisors', []]]) {
    const r = correr(cmd, extra);
    assert.equal(r.status, 0, `${cmd} ${extra.join(' ')} fuera de una corrida con vuelta 1 tiene que pasar: ${r.stderr.slice(0, 200)}`);
  }
  for (const cmd of ['smart-reloop', 'advisors']) {
    assert.equal(correr(cmd, ['--iter', '2']).status, 0);
    const r = correr(cmd, ['--iter', '3']);
    assert.notEqual(r.status, 0, `${cmd} --iter 3 sin carpeta de corrida tendría que frenar: ${r.stdout.slice(0, 160)}`);
    assert.doesNotMatch(r.stdout, /"rerun"|"all"/);
    assert.match(r.stderr, /carpeta de (la )?corrida/);
  }
});

// 🔴 sale rojo si el freno corre antes de la validación propia del comando: una --story que no existe da el error del
// comando (exit 2, «--story NO existe»), no el del freno (exit 3).
test('T24 · 🔴 sale rojo si --story inexistente da el error del freno en vez del propio del comando', () => {
  const { repo } = mkRepo({ findings: [] });
  const h = home();
  for (const cmd of ['smart-reloop', 'advisors']) {
    for (const iter of ['1', '3']) {
      const r = spawnSync(process.execPath, [PIPELINE, cmd, '--repo', repo, '--story', path.join(repo, 'no-existe.md'), '--files', 'src/a.js', '--iter', iter],
        { encoding: 'utf8', env: env(h) });
      assert.equal(r.status, 2, `${cmd} --iter ${iter}: ${r.stderr.slice(0, 200)}`);
      assert.match(r.stderr, /--story NO existe/);
    }
  }
});
