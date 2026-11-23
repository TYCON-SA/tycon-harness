'use strict';
/**
 * carry-night-results.test.js — el nocturno lleva a main lo pendiente de `night-results`, sin repetir, sin perder y sin
 * aceptar lo que no tiene la forma de un resultado.
 *
 * Un remoto desnudo de juguete hace de repo: la máquina del examen publica con `result-travel.js` desde su casa
 * temporal, y un checkout aparte hace de trabajo del pipeline. El guion se corre de verdad, con `node`.
 *
 * Correr: node --test scripts/tests/carry-night-results.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CARRY = path.join(ROOT, 'scripts', 'ci', 'carry-night-results.js');

const DIRS = [];
test.after(() => { for (const d of DIRS) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p = 'carry-night-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); DIRS.push(d); return d; };

// La casa de la suite: temporal y nunca la de la persona.
const REAL_HOME = os.userInfo().homedir;
const SUITE_HOME = tmp('carry-night-casa-');
if (path.resolve(SUITE_HOME) === path.resolve(REAL_HOME)) throw new Error('carry-night-results.test.js: la casa de la suite es la HOME real; no arranco');
process.env.HOME = SUITE_HOME;
delete process.env.TYCON_HOME;
const GITCFG = path.join(SUITE_HOME, 'gitconfig');
fs.writeFileSync(GITCFG, '');
process.env.GIT_CONFIG_GLOBAL = GITCFG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
// los commits de la suite salen siempre iguales: fecha fija y sin el mantenimiento automático de git
process.env.GIT_AUTHOR_DATE = '2026-11-18T00:00:00Z';
process.env.GIT_COMMITTER_DATE = '2026-11-18T00:00:00Z';

const RT = require(path.join(ROOT, 'scripts', 'lib', 'result-travel.js'));
const EXAM_REL = 'scripts/controls-bench/ultimo-examen.json';
const GUIDES_REL = 'scripts/controls-bench/ultimo-guias.json';
const REPORT_REL = '.dashboard/weekly-review/latest.json';
const LIST_REL = 'guides/guide-update-proposals.md';
const LIST_BASE = '# Guide Update Proposals\n\nPropuestas.\n\n---\n';

function git(dir, args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const write = (dir, rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exam = (ts) => json({ kind: 'examen-periodico', estado: 'completo', ts, fin: ts, criterio: 0 });
const section = (date, n, text = 'propuesta') => `## Revisión semanal ${date} — ${text} — ⏳ PENDIENTE\n<!-- revision-semanal:${date}:${n} -->\n\n${text}\n\n---\n`;

/** El remoto con main, la máquina que publica y el checkout del pipeline. */
function world(mainFiles = {}) {
  const raiz = tmp();
  const casa = path.join(raiz, 'casa');
  fs.mkdirSync(path.join(casa, '.claude', '.tycon-pipeline'), { recursive: true });
  const remote = path.join(raiz, 'remoto.git');
  const machine = path.join(raiz, 'maquina');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', machine]);
  git(machine, ['config', 'user.email', 'lab@example.com']); git(machine, ['config', 'user.name', 'Lab']);
  write(machine, LIST_REL, LIST_BASE);
  for (const [rel, body] of Object.entries(mainFiles)) write(machine, rel, body);
  git(machine, ['add', '-A']); git(machine, ['commit', '-q', '-m', 'base']);
  git(machine, ['remote', 'add', 'origin', remote]); git(machine, ['push', '-q', '-u', 'origin', 'main']);
  const w = { raiz, casa, remote, machine };
  w.checkout = () => {
    const d = path.join(raiz, `pipeline-${Math.random().toString(16).slice(2)}`);
    execFileSync('git', ['clone', '-q', remote, d]);
    return d;
  };
  w.publish = (piece, files) => {
    const r = RT.publish({ repo: machine, piece, files, message: `chore: ${piece}`, home: casa, log: () => {} });
    assert.strictEqual(r.ok, true, r.motivo);
    return r.entry;
  };
  return w;
}
function carry(dir, extra = []) {
  const env = { ...process.env };
  delete env.TYCON_HOME;
  const r = spawnSync(process.execPath, [CARRY, '--repo', dir, ...extra], { encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const carried = (dir) => JSON.parse(read(dir, RT.CARRIED));
// sin recortar la salida: la primera línea empieza con el espacio de la columna del índice
const changed = (dir) => spawnSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).stdout
  .split('\n').filter(Boolean).map((l) => l.slice(3)).sort();
/** Una entrada armada a mano en la rama, para los casos que la máquina nunca publicaría. */
function rawEntry(w, id, entry, files) {
  const d = path.join(w.raiz, `cruda-${id}`);
  const has = spawnSync('git', ['-C', w.remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${RT.BRANCH}`]).status === 0;
  if (has) execFileSync('git', ['clone', '-q', '-b', RT.BRANCH, w.remote, d]);
  else { execFileSync('git', ['init', '-q', '-b', RT.BRANCH, d]); git(d, ['remote', 'add', 'origin', w.remote]); }
  git(d, ['config', 'user.email', 'lab@example.com']); git(d, ['config', 'user.name', 'Lab']);
  write(d, `runs/${id}/entry.json`, typeof entry === 'string' ? entry : json(entry));
  for (const [rel, body] of Object.entries(files)) write(d, `runs/${id}/files/${rel}`, body);
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'a mano']); git(d, ['push', '-q', 'origin', `HEAD:refs/heads/${RT.BRANCH}`]);
}

test('T21 Carry_PendingEntries_ReachMainWithRecord @story-8.312 @ac-14', () => {
  const w = world({ [EXAM_REL]: exam('2026-11-10T05:00:00.000Z') });
  const e1 = w.publish('exam', [{ path: EXAM_REL, mode: 'replace', text: exam('2026-11-17T05:10:00.000Z') }]);
  const e2 = w.publish('guides', [{ path: GUIDES_REL, mode: 'replace', text: json({ kind: 'casos-de-guia', ts: '2026-11-17T05:15:00.000Z', guias: [] }) }]);
  const e3 = w.publish('weekly', [{ path: REPORT_REL, mode: 'replace', text: json({ schema: 1, hecho: '2026-11-17T05:20:00.000Z', estado: 'hecho' }) },
    { path: LIST_REL, mode: 'append', text: section('2026-11-17', 1) }]);
  const d = w.checkout();
  const r = carry(d);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(read(d, EXAM_REL), /2026-11-17T05:10/, 'el examen nuevo');
  assert.match(read(d, GUIDES_REL), /casos-de-guia/);
  assert.match(read(d, REPORT_REL), /2026-11-17T05:20/);
  assert.ok(read(d, LIST_REL).startsWith(LIST_BASE) && read(d, LIST_REL).includes('<!-- revision-semanal:2026-11-17:1 -->'), 'la sección al final de la lista');
  const c = carried(d);
  for (const id of [e1, e2, e3]) assert.strictEqual(c.entries[id].status, 'carried', id);
  assert.deepStrictEqual(changed(d), [RT.CARRIED, REPORT_REL, LIST_REL, EXAM_REL, GUIDES_REL].sort(), 'sólo las cinco rutas, listas para el guardado');
});

test('T22 Carry_SecondRun_ChangesNothing @story-8.312 @ac-15', () => {
  const w = world();
  w.publish('exam', [{ path: EXAM_REL, mode: 'replace', text: exam('2026-11-17T05:10:00.000Z') }]);
  const d = w.checkout();
  assert.strictEqual(carry(d).code, 0);
  git(d, ['add', '-A']); git(d, ['-c', 'user.email=l@e', '-c', 'user.name=L', 'commit', '-q', '-m', 'guardado']);
  const r = carry(d);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(changed(d), [], 'la segunda corrida no cambia ningún archivo');
});

test('T23 Carry_SectionAlreadyInList_NotRepeated @story-8.312 @ac-15', () => {
  const w = world({ [LIST_REL]: LIST_BASE + section('2026-11-17', 1) });
  w.publish('weekly', [{ path: LIST_REL, mode: 'append', text: section('2026-11-17', 1) + section('2026-11-17', 2, 'otra') }]);
  const d = w.checkout();
  assert.strictEqual(carry(d).code, 0);
  const lista = read(d, LIST_REL);
  assert.strictEqual(lista.split('<!-- revision-semanal:2026-11-17:1 -->').length, 2, 'la que ya estaba aparece una vez');
  assert.strictEqual(lista.split('<!-- revision-semanal:2026-11-17:2 -->').length, 2, 'la nueva entra');
});

test('T24 Carry_OlderThanMain_NotApplied @story-8.312 @ac-16', () => {
  const w = world({ [EXAM_REL]: exam('2026-11-20T05:00:00.000Z') });
  const id = w.publish('exam', [{ path: EXAM_REL, mode: 'replace', text: exam('2026-11-17T05:10:00.000Z') }]);
  const d = w.checkout();
  assert.strictEqual(carry(d).code, 0);
  assert.match(read(d, EXAM_REL), /2026-11-20T05:00/, 'main conserva el suyo');
  assert.strictEqual(carried(d).entries[id].status, 'carried', 'y la entrada queda tratada');
});

test('T16 Carry_TwoNights_NewestFileBothSections @story-8.312 @ac-16', () => {
  const w = world();
  w.publish('exam', [{ path: EXAM_REL, mode: 'replace', text: exam('2026-11-17T05:10:00.000Z') }]);
  w.publish('weekly', [{ path: LIST_REL, mode: 'append', text: section('2026-11-17', 1, 'primera') }]);
  w.publish('exam', [{ path: EXAM_REL, mode: 'replace', text: exam('2026-11-20T05:10:00.000Z') }]);
  w.publish('weekly', [{ path: LIST_REL, mode: 'append', text: section('2026-11-24', 1, 'segunda') }]);
  const d = w.checkout();
  assert.strictEqual(carry(d).code, 0);
  assert.match(read(d, EXAM_REL), /2026-11-20T05:10/, 'queda el examen de ts mayor');
  const lista = read(d, LIST_REL);
  assert.ok(lista.includes('revision-semanal:2026-11-17:1') && lista.includes('revision-semanal:2026-11-24:1'), 'las secciones de las dos revisiones');
  assert.ok(lista.indexOf('2026-11-17:1') < lista.indexOf('2026-11-24:1'), 'en orden');
});

test('T25 Carry_SaveFails_NextNightRetries @story-8.312 @ac-16', () => {
  const w = world();
  const id = w.publish('exam', [{ path: EXAM_REL, mode: 'replace', text: exam('2026-11-17T05:10:00.000Z') }]);
  const d = w.checkout();
  assert.strictEqual(carry(d).code, 0);
  // el guardado falló: lo escrito no llegó a main y la noche siguiente parte de main otra vez
  git(d, ['checkout', '-q', '--', '.']); git(d, ['clean', '-qfd']);
  assert.ok(!fs.existsSync(path.join(d, RT.CARRIED)));
  assert.strictEqual(carry(d).code, 0);
  assert.match(read(d, EXAM_REL), /2026-11-17T05:10/, 'la entrada se aplica igual');
  assert.strictEqual(carried(d).entries[id].status, 'carried');
});

test('T26 Carry_InvalidEntry_RejectedOthersPass @story-8.312 @ac-17', () => {
  const w = world();
  const sana = w.publish('exam', [{ path: EXAM_REL, mode: 'replace', text: exam('2026-11-17T05:10:00.000Z') }]);
  const mk = (id, piece, files) => ({ schema: 1, id, piece, ts: '2026-11-18T00:00:00.000Z', files });
  rawEntry(w, '20261118T000001000Z-exam-aaaaa1', mk('20261118T000001000Z-exam-aaaaa1', 'exam', [{ path: 'scripts/hooks/bench-notice.js', mode: 'replace' }]),
    { 'scripts/hooks/bench-notice.js': 'process.exit(0)\n' });
  rawEntry(w, '20261118T000002000Z-guides-aaaaa2', mk('20261118T000002000Z-guides-aaaaa2', 'guides', [{ path: GUIDES_REL, mode: 'replace' }]),
    { [GUIDES_REL]: json({ kind: 'otra-cosa', ts: '2026-11-18T00:00:00.000Z' }) });
  rawEntry(w, '20261118T000003000Z-weekly-aaaaa3', mk('20261118T000003000Z-weekly-aaaaa3', 'weekly', [{ path: LIST_REL, mode: 'append' }]),
    { [LIST_REL]: '## Cualquier cosa\n\nsin marca\n' });
  rawEntry(w, '20261118T000004000Z-weekly-aaaaa4', mk('20261118T000004000Z-weekly-aaaaa4', 'weekly', [{ path: REPORT_REL, mode: 'replace' }]),
    { [REPORT_REL]: json({ schema: 1, hecho: '2026-11-18T00:00:00.000Z', relleno: 'x'.repeat(2 * 1024 * 1024 + 10) }) });
  const d = w.checkout();
  const r = carry(d);
  assert.strictEqual(r.code, 0, r.out);
  const c = carried(d);
  for (const id of ['20261118T000001000Z-exam-aaaaa1', '20261118T000002000Z-guides-aaaaa2', '20261118T000003000Z-weekly-aaaaa3', '20261118T000004000Z-weekly-aaaaa4']) {
    assert.strictEqual(c.entries[id].status, 'rejected', id);
    assert.ok(c.entries[id].reason, `${id} con su motivo`);
  }
  assert.strictEqual(c.entries[sana].status, 'carried', 'la sana se aplica');
  assert.ok(!fs.existsSync(path.join(d, GUIDES_REL)) && !fs.existsSync(path.join(d, REPORT_REL)), 'nada de las rechazadas');
  assert.match(r.out, /rechaz/i, 'la corrida lo avisa');
});

test('T33 Carry_FutureDate_RejectedRealOneApplies @story-8.312 @ac-17', () => {
  // una fecha futura ganaría siempre la comparación de fechas y dejaría afuera a los resultados reales
  const w = world();
  const futura = '20991231T000000000Z-exam-aaaaa5';
  rawEntry(w, futura, { schema: 1, id: futura, piece: 'exam', ts: '2026-11-18T00:00:00.000Z', files: [{ path: EXAM_REL, mode: 'replace' }] },
    { [EXAM_REL]: exam('2099-12-31T00:00:00.000Z') });
  const real = w.publish('exam', [{ path: EXAM_REL, mode: 'replace', text: exam('2026-11-18T05:10:00.000Z') }]);
  const d = w.checkout();
  const r = carry(d);
  assert.strictEqual(r.code, 0, r.out);
  const c = carried(d);
  assert.strictEqual(c.entries[futura].status, 'rejected', 'la del futuro queda rechazada');
  assert.match(c.entries[futura].reason, /futur|posterior/i, c.entries[futura].reason);
  assert.strictEqual(c.entries[real].status, 'carried');
  assert.match(read(d, EXAM_REL), /2026-11-18T05:10/, 'el examen real llega al disco');
});

test('T35 Carry_BranchWithoutRuns_ExitsZeroEmptyRecord @story-8.312 @ac-18', () => {
  // cualquiera con permiso de escritura puede empujar a la rama: una sin entradas es «nada que llevar», no un nocturno rojo
  const w = world();
  const d0 = path.join(w.raiz, 'sin-runs');
  execFileSync('git', ['init', '-q', '-b', RT.BRANCH, d0]);
  git(d0, ['config', 'user.email', 'lab@example.com']); git(d0, ['config', 'user.name', 'Lab']);
  write(d0, 'README.md', 'nada\n');
  git(d0, ['add', '-A']); git(d0, ['commit', '-q', '-m', 'sin entradas']);
  git(d0, ['push', '-q', w.remote, `HEAD:refs/heads/${RT.BRANCH}`]);
  const d = w.checkout();
  const r = carry(d);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(carried(d), { schema: 1, entries: {} });
  assert.deepStrictEqual(changed(d), [RT.CARRIED]);
  // pero lo dice como advertencia del nocturno: una rama vaciada o reescrita a la fuerza no es lo mismo que «no hay rama»
  assert.match(r.out, /##vso\[task\.logissue type=warning\][^\n]*sin runs\//, r.out);
});

test('T32 Carry_NoBranchExitsZero_UnreadableBranchFails @story-8.312 @ac-18', () => {
  const w = world();
  const d = w.checkout();
  const r = carry(d);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(carried(d), { schema: 1, entries: {} }, 'sin la rama deja carried.json vacío');
  assert.doesNotMatch(r.out, /##vso\[task\.logissue/, 'sin la rama no hay advertencia');
  assert.deepStrictEqual(changed(d), [RT.CARRIED]);
  git(d, ['remote', 'set-url', 'origin', path.join(w.raiz, 'no-existe.git')]);
  const r2 = carry(d);
  assert.notStrictEqual(r2.code, 0, 'un remoto que no se puede leer hace fallar el paso');
  assert.match(r2.out, /no pude/i);
});
