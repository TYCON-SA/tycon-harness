'use strict';
/**
 * pre-commit-story-outside.test.js — el freno del commit avisa cuando una historia cuyo id no entra en el patrón pasa a
 * `review` o `done`: no la juzga, y lo dice.
 *
 * Sin el aviso, una historia `VH-1b` que se cierra sale 0 y muda, y nadie distingue «se juzgó y pasó» de «no se miró».
 * El aviso no frena: sale 0 igual. Las pruebas corren el hook de verdad (on-pre-commit.js por stdin, como lo llama Claude
 * Code) sobre un repo de git armado en una carpeta temporal, con una HOME temporal.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HOOK = path.resolve(__dirname, '..', 'on-pre-commit.js');

function historia(id, status) {
  return [
    '---',
    `story: "${id}"`,
    `status: ${status}`,
    '---',
    '',
    `# Story ${id} — fixture`,
    '',
    '## Acceptance Criteria',
    '',
    '1. **Given** un catálogo **When** se abre el listado **Then** lo muestra con su nombre.',
    '',
    '### Tests',
    '',
    '| ID | Test | AC | Nivel | Escenario | Esperado |',
    '|---|---|---|---|---|---|',
    '| E1 | `listado.spec.ts::muestra` | 1 | e2e | Playwright contra la app | y |',
    '',
  ].join('\n');
}

// El repo con las historias de `base` commiteadas y las de `cambios` preparadas (null = no existe en la base).
function armar(t, base, cambios) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-outside-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const fecha = '2026-01-01T00:00:00Z';
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'maintenance.auto=false',
    '-c', 'gc.auto=0', ...a], { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  git('init', '-q', '-b', 'main', '.');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  for (const [rel, contenido] of Object.entries(base)) fs.writeFileSync(path.join(repo, rel), contenido);
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  for (const [rel, contenido] of Object.entries(cambios)) fs.writeFileSync(path.join(repo, rel), contenido);
  git('add', '-A');
  return { repo, home };
}

function correrHook({ repo, home }) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_CLOSURE_RECORD: 'off', TYCON_ADVISORS_GATE: 'off' };
  delete env.TYCON_HOME; delete env.NODE_TEST_CONTEXT; delete env.GIT_INDEX_FILE;
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: repo, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'outside-test', cwd: repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "cierre"' } }),
  });
  return { code: r.status, err: r.stderr || '' };
}

const AVISO = /no se juzgó/;
// El aviso entero de una historia: su ruta, su id, que no se juzgó y dónde se declara el patrón.
function avisoEntero(err, rel, id) {
  const renglon = err.split('\n').find((l) => l.includes(rel));
  assert.ok(renglon, `no hay aviso para ${rel}:\n${err}`);
  assert.ok(renglon.includes(`«${id}»`), `el aviso no nombra el id ${id}: ${renglon}`);
  assert.match(renglon, AVISO);
  assert.match(err, /stories\.id_pattern/);
  assert.match(err, /\.tycon\/advisors\.yaml/);
}

// T8 Freno_IdFueraDelPatron_PasaADone_Avisa @story-8.194 @ac-9
// 🔴 Falla con: el freno sale 0 sin decir nada cuando el id no entra en el patrón, o el aviso sólo mira `review → done`.
test('T8 Freno_IdFueraDelPatron_PasaADone_Avisa @story-8.194 @ac-9', (t) => {
  const r = correrHook(armar(t,
    { 'specs/vh-1b.md': historia('VH-1b', 'review'), 'specs/oc-1.md': historia('OC-1', 'in-progress') },
    { 'specs/vh-1b.md': historia('VH-1b', 'done'), 'specs/oc-1.md': historia('OC-1', 'review'), 'specs/ag-1.md': historia('AG-1', 'done') }));
  assert.strictEqual(r.code, 0, r.err);
  avisoEntero(r.err, 'specs/vh-1b.md', 'VH-1b');
  avisoEntero(r.err, 'specs/oc-1.md', 'OC-1');
  avisoEntero(r.err, 'specs/ag-1.md', 'AG-1');
});

// T9 Freno_IdFueraDelPatron_SinCambioDeEstado_NoAvisa @story-8.194 @ac-10
// 🔴 Falla con: avisar por cualquier cambio a una historia fuera del patrón → el aviso molesta en cada commit.
test('T9 Freno_IdFueraDelPatron_SinCambioDeEstado_NoAvisa @story-8.194 @ac-10', (t) => {
  const r = correrHook(armar(t, { 'specs/vh-1b.md': historia('VH-1b', 'review') },
    { 'specs/vh-1b.md': historia('VH-1b', 'review') + '\nUna nota más.\n' }));
  assert.strictEqual(r.code, 0, r.err);
  assert.doesNotMatch(r.err, AVISO);
});

// T10 Freno_IdEnElPatron_SinEvidencia_FrenaComoHoy @story-8.194 @ac-11
// 🔴 Falla con: el aviso nombra una historia que sí se juzga, o cambia el freno de las que entran en el patrón.
test('T10 Freno_IdEnElPatron_SinEvidencia_FrenaComoHoy @story-8.194 @ac-11', (t) => {
  const r = correrHook(armar(t, { 'specs/story-9.9.md': historia('9.9', 'in-progress') },
    { 'specs/story-9.9.md': historia('9.9', 'done') }));
  assert.strictEqual(r.code, 2, r.err);
  assert.doesNotMatch(r.err, AVISO);
});

// T11 Freno_UnaFueraYOtraAdentro_AvisaYFrena @story-8.194 @ac-12
// 🔴 Falla con: el aviso va después del freno de las de adentro, o el aviso cambia el código de salida.
test('T11 Freno_UnaFueraYOtraAdentro_AvisaYFrena @story-8.194 @ac-12', (t) => {
  const r = correrHook(armar(t,
    { 'specs/vh-1b.md': historia('VH-1b', 'review'), 'specs/story-9.9.md': historia('9.9', 'in-progress') },
    { 'specs/vh-1b.md': historia('VH-1b', 'done'), 'specs/story-9.9.md': historia('9.9', 'done') }));
  assert.strictEqual(r.code, 2, r.err);
  avisoEntero(r.err, 'specs/vh-1b.md', 'VH-1b');
  assert.ok(!r.err.split('\n').some((l) => AVISO.test(l) && l.includes('story-9.9.md')), r.err);
});

// T12 Freno_MdQueNoEsHistoria_NoAvisa @story-8.194 @ac-13
// 🔴 Falla con: tomar por historia un `.md` sin `story:` o sin `status:` → avisos por guías y notas.
test('T12 Freno_MdQueNoEsHistoria_NoAvisa @story-8.194 @ac-13', (t) => {
  const r = correrHook(armar(t, {},
    { 'specs/guia.md': '---\nstatus: done\n---\n# guía\n', 'specs/nota.md': '---\nstory: "VH-2"\n---\n# nota\n' }));
  assert.strictEqual(r.code, 0, r.err);
  assert.doesNotMatch(r.err, AVISO);
  // un archivo que no se pudo leer (no es texto) se saltea sin cortar la lista: la historia de al lado sigue avisando
  const { storiesOutsidePattern } = require(HOOK);
  const leidos = { 'specs/x.md': null, 'specs/vh-1b.md': historia('VH-1b', 'done') };
  assert.deepStrictEqual(storiesOutsidePattern(['specs/x.md', 'specs/vh-1b.md'], (f) => leidos[f], () => '', null),
    [{ file: 'specs/vh-1b.md', id: 'VH-1b' }]);
  // un archivo cuya lectura falla no tapa a los demás, y queda dicho: callar se vería igual que «no había nada»
  const lee = (f) => { if (f === 'specs/roto.md') throw new Error('sin permiso'); return leidos[f]; };
  assert.deepStrictEqual(storiesOutsidePattern(['specs/roto.md', 'specs/vh-1b.md'], lee, () => '', null),
    [{ file: 'specs/roto.md', error: 'sin permiso' }, { file: 'specs/vh-1b.md', id: 'VH-1b' }]);
});
