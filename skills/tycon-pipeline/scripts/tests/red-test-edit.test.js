'use strict';
/**
 * red-test-edit.test.js — una prueba vieja que estaba en rojo no se edita en silencio.
 *
 * El freno `on-red-test-edit.js` (cadena `pre-edit`) mira si el archivo que se va a editar es una prueba que ya existía en
 * `origin/main` y figura en las fallas del último `tests-result.json` de ESTA corrida (`by.session`). Si es así, frena y
 * pide la nota (`marker.js note-red-test`); si además es la prueba de un control, pide la firma del dueño
 * `red-control-test-edit`. Sin reporte, sin `failure_entries` o sin sesión en el reporte, no frena y lo anota como no
 * medido. Todo corre sobre repos de juguete, con la carpeta del estado y la casa de las firmas en carpetas temporales.
 *
 * stable-data: las fechas del marcador y del reporte son de juguete; ninguna se compara con el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const rte = () => require(path.join(SCRIPTS, 'lib', 'red-test-edit.js'));
const hook = () => require(path.join(SCRIPTS, 'on-red-test-edit.js'));
const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Un laboratorio: un repo con forma de arnés (`scripts/tests/`, `scripts/ci/controls-from-base.json`) con `origin/main`
 * apuntando a su primer commit, la carpeta del estado y la casa de las firmas. `reporte` es el `tests-result.json` (o
 * null para no escribirlo); `marcador` el de la sesión `ses-a` (o null).
 */
function laboratorio(t, { reporte, marcador = {}, archivos = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'red-test-edit-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  // la carpeta del estado es la de la casa de juguete: ahí la buscan el freno y `marker.js` (con HOME=base)
  const estado = require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(base);
  const casa = path.join(base, 'casa');
  const skills = path.join(base, 'skills');
  for (const d of [path.join(repo, 'scripts', 'tests'), path.join(repo, 'scripts', 'ci'), path.join(repo, 'scripts', 'lib'), path.join(estado, 'active'), casa, path.join(skills, 'tycon-pipeline', 'scripts', 'tests')]) fs.mkdirSync(d, { recursive: true });
  const escribir = (rel, txt) => { const p = path.join(repo, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
  escribir('scripts/ci/controls-from-base.json', JSON.stringify({ controls: [
    { name: 'freno-de-juguete', script: 'scripts/lib/freno-de-juguete.js', rules: [{ path: 'scripts/lib/reglas-de-juguete.json', optional: true }] },
  ] }, null, 2));
  escribir('scripts/lib/freno-de-juguete.js', 'module.exports = 1;\n');
  escribir('scripts/tests/viejo.test.js', "test('T1 algo', () => {});\n");
  escribir('scripts/tests/verde.test.js', "test('T1 otra', () => {});\n");
  escribir('scripts/tests/office-hours.test.js', "test('T37 la hora declarada', () => {});\n");
  escribir('scripts/tests/del-freno.test.js', "const F = require('../lib/freno-de-juguete.js');\n");
  escribir('scripts/tests/de-las-reglas.test.js', "const R = 'scripts/lib/reglas-de-juguete.json';\n");
  for (const [rel, txt] of Object.entries(archivos)) escribir(rel, txt);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (reporte) {
    fs.mkdirSync(path.join(repo, '.advisors'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.advisors', 'tests-result.json'), JSON.stringify(reporte, null, 2));
  }
  if (marcador) {
    fs.writeFileSync(path.join(estado, 'active', 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', repoPath: repo,
      storyPath: path.join(repo, 'specs', 'story-9.99.md'), stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'], ...marcador }));
  }
  const evento = (rel, sesion = 'ses-a') => ({ session_id: sesion, tool_name: 'Edit', cwd: repo, tool_input: { file_path: path.join(repo, rel), old_string: 'a', new_string: 'b' } });
  const correr = (rel, sesion) => hook().handle(evento(rel, sesion), { stateDir: estado, casa, skillsDir: skills });
  const gates = () => { try { return fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };
  return { base, repo, estado, casa, skills, correr, gates, escribir };
}

/** Un reporte de `suites-json` de la sesión `sesion`, con estas fallas (`[raiz, ruta]`). */
const reporteDe = (sesion, fallas) => ({
  runner: 'suites-json', by: sesion ? { session: sesion, model: 'm' } : { process: 'test-gate.sh' },
  totals: { failed: fallas.length, failures: fallas.map(([, r]) => path.basename(r)), failure_entries: fallas.map(([raiz, ruta]) => ({ raiz, ruta })) },
});

const frena = (r) => !!(r && r.block);

// ── el freno ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('RedOldTest_Edit_Blocked_GivesNoteCommand (T1) @story-8.166 @ac-1', (t) => {
  const lab = laboratorio(t, { reporte: reporteDe('ses-a', [['arnes', 'tests/viejo.test.js']]) });
  const r = lab.correr('scripts/tests/viejo.test.js');
  assert.ok(frena(r), 'una prueba vieja en rojo de esta corrida frena');
  assert.match(r.block, /marker\.js"? note-red-test --test /, 'da el comando de la nota');
  assert.ok(r.block.includes(path.join(lab.repo, 'scripts', 'tests', 'viejo.test.js')), 'con la ruta de la prueba');
  assert.match(r.block, /--reason/);
  // con un espacio en la ruta, el comando la lleva entre comillas (si no, la nota queda en otra ruta)
  const conEspacio = laboratorio(t, { reporte: reporteDe('ses-a', [['arnes', 'tests/con espacio.test.js']]),
    archivos: { 'scripts/tests/con espacio.test.js': "test('T1', () => {});\n" } });
  const re = conEspacio.correr('scripts/tests/con espacio.test.js');
  assert.ok(frena(re));
  assert.ok(re.block.includes(`--test '${path.join(conEspacio.repo, 'scripts', 'tests', 'con espacio.test.js')}'`), re.block);
  // la cadena lo lleva en cualquier paso de una corrida abierta
  const { CHAINS } = require(path.join(SCRIPTS, 'dispatch.js'));
  const e = CHAINS['pre-edit'].find((x) => x.name === 'on-red-test-edit');
  assert.ok(e, 'el freno está en la cadena pre-edit');
  assert.deepStrictEqual(e.steps, ['all']);
  assert.strictEqual(e.effect, 'blocks');
});

test('RedOldTest_WithNote_Passes_AndTravels (T2) @story-8.166 @ac-2', (t) => {
  const lab = laboratorio(t, { reporte: reporteDe('ses-a', [['arnes', 'tests/viejo.test.js']]) });
  const prueba = path.join(lab.repo, 'scripts', 'tests', 'viejo.test.js');
  // la nota, con el comando de verdad
  const env = { ...process.env, HOME: lab.base, USERPROFILE: lab.base, TYCON_SESSION_ID: 'ses-a' };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.CODEX_SESSION_ID;
  const sinMotivo = spawnSync(process.execPath, [MARKER, 'note-red-test', '--test', prueba], { env, encoding: 'utf8' });
  assert.notStrictEqual(sinMotivo.status, 0, 'sin --reason no anota');
  const n = spawnSync(process.execPath, [MARKER, 'note-red-test', '--test', prueba, '--reason', 'dependía de la hora del día'], { env, encoding: 'utf8' });
  assert.strictEqual(n.status, 0, n.stdout + n.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(lab.estado, 'active', 'ses-a.json'), 'utf8'));
  assert.strictEqual(m.redTestNotes.length, 1);
  assert.strictEqual(m.redTestNotes[0].test, prueba);
  assert.strictEqual(m.redTestNotes[0].reason, 'dependía de la hora del día');
  assert.ok(m.redTestNotes[0].at, 'con la hora');
  // con la nota, pasa
  assert.ok(!frena(lab.correr('scripts/tests/viejo.test.js')), 'con la nota, la edición pasa');
  // viaja a los revisores y al mensaje del commit
  const bloque = rte().bloqueParaRevisores(m);
  assert.ok(bloque.includes(prueba) && bloque.includes('dependía de la hora del día'), 'el contexto de los revisores la lleva');
  const renglones = rte().renglonesParaElCommit(m);
  assert.strictEqual(renglones.length, 1);
  assert.ok(renglones[0].includes(prueba) && renglones[0].includes('dependía de la hora del día'), 'un renglón por prueba en el mensaje del commit');
  // y los guiones las usan: el contexto de los revisores y el cierre del commit
  assert.match(fs.readFileSync(path.join(SCRIPTS, 'pipeline.js'), 'utf8'), /bloqueParaRevisores\(/, 'buildAdvisorContext lleva la nota');
  assert.match(fs.readFileSync(MARKER, 'utf8'), /renglonesParaElCommit\(/, 'prepare-commit imprime los renglones');
});

test('ControlTest_AsksOwnerOnlySignature (T3) @story-8.166 @ac-3', (t) => {
  const lab = laboratorio(t, { reporte: reporteDe('ses-a', [['arnes', 'tests/del-freno.test.js'], ['arnes', 'tests/de-las-reglas.test.js']]) });
  for (const rel of ['scripts/tests/del-freno.test.js', 'scripts/tests/de-las-reglas.test.js']) {
    const r = lab.correr(rel);
    assert.ok(frena(r), `${rel}: la prueba de un control frena`);
    const abs = path.join(lab.repo, rel);
    assert.ok(r.block.includes(ow.comoSeFirma('red-control-test-edit', abs)), `${rel}: da la forma de la ventana\n${r.block}`);
    assert.ok(r.block.includes(ow.comoSeFirmaEnLaTerminal('red-control-test-edit', abs, 'ses-a')), `${rel}: y la de la terminal`);
    assert.doesNotMatch(r.block, /note-red-test/, `${rel}: la nota no alcanza`);
  }
  // con una nota igual frena: la de un control pide la firma
  const m = path.join(lab.estado, 'active', 'ses-a.json');
  const marcador = JSON.parse(fs.readFileSync(m, 'utf8'));
  fs.writeFileSync(m, JSON.stringify({ ...marcador, redTestNotes: [{ test: path.join(lab.repo, 'scripts/tests/del-freno.test.js'), reason: 'x', at: '2026-10-27T13:00:00Z' }] }));
  assert.ok(frena(lab.correr('scripts/tests/del-freno.test.js')), 'con nota, la de un control sigue pidiendo la firma');
  // con la firma, pasa
  const abs = path.join(lab.repo, 'scripts', 'tests', 'del-freno.test.js');
  ow.firmarArchivo({ firma: 'red-control-test-edit', via: 'ventana', sesion: 'ses-a', archivo: abs, casa: lab.casa, ahora: Date.now() });
  assert.ok(!frena(lab.correr('scripts/tests/del-freno.test.js')), 'con la firma del dueño, pasa');
  // es sólo del dueño: un perfil que la delega igual no la deja firmar a la coordinadora
  const ds = require(path.join(RAIZ, 'scripts', 'lib', 'delegated-signing.js'));
  const d = ds.delegaSinVentana({ firma: 'escape:red-control-test-edit', sesion: 'coord', destino: 'ses-a', home: lab.casa, estado: lab.estado,
    perfil: () => ({ delegated_signing: ['escape:red-control-test-edit'], owner_only: [], delegated_machines: ['*'] }), huella: () => ({ huella: 'h' }) });
  assert.strictEqual(d.ok, false);
  assert.match(d.motivo, /sólo del dueño|no se delega/);
  // y está en el catálogo como firma de archivo, fuera del grupo que se delega junto
  const SIG = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
  assert.ok(SIG.FIRMAS_DE_ARCHIVO.includes('red-control-test-edit'));
  assert.ok(!SIG.GROUPS['escape-phrases'].includes('escape:red-control-test-edit'), 'no entra al grupo de frases que se delega');
});

// ── lo que no frena ───────────────────────────────────────────────────────────────────────────────────────────────

test('NewGreenOrOtherSession_Silent (T4) @story-8.166 @ac-4', (t) => {
  const lab = laboratorio(t, { reporte: reporteDe('ses-a', [['arnes', 'tests/viejo.test.js']]) });
  lab.escribir('scripts/tests/nueva.test.js', "test('T1 nueva', () => {});\n");
  assert.ok(!frena(lab.correr('scripts/tests/nueva.test.js')), 'una prueba nueva de la corrida no frena');
  assert.ok(!frena(lab.correr('scripts/tests/verde.test.js')), 'una vieja en verde no frena');
  const otra = laboratorio(t, { reporte: reporteDe('ses-b', [['arnes', 'tests/viejo.test.js']]) });
  assert.ok(!frena(otra.correr('scripts/tests/viejo.test.js')), 'el reporte de otra sesión no frena');
  assert.strictEqual(lab.gates().filter((g) => g.name === 'red-test-edit').length, 0, 'y no dice nada');
});

test('NoTestsResult_NotMeasured_InGatesLog (T5) @story-8.166 @ac-5', (t) => {
  const casos = [
    ['sin tests-result.json', laboratorio(t, { reporte: null })],
    ['sin failure_entries', laboratorio(t, { reporte: { runner: 'vitest', by: { session: 'ses-a' }, totals: { failed: 1, failures: ['viejo.test.js'] } } })],
    ['sin sesión en el reporte', laboratorio(t, { reporte: reporteDe(null, [['arnes', 'tests/viejo.test.js']]) })],
  ];
  for (const [como, lab] of casos) {
    assert.ok(!frena(lab.correr('scripts/tests/viejo.test.js')), `${como}: no frena`);
    const g = lab.gates().filter((x) => x.name === 'red-test-edit');
    assert.strictEqual(g.length, 1, `${como}: una línea en gates.log`);
    assert.strictEqual(g[0].status, 'not-measured');
    assert.ok(g[0].reason, `${como}: con el motivo`);
  }
  // el inventario de controles del repo no se lee: no sé si es la prueba de un control → pide la nota igual y lo dice
  const sinInventario = laboratorio(t, { reporte: reporteDe('ses-a', [['arnes', 'tests/del-freno.test.js']]) });
  fs.writeFileSync(path.join(sinInventario.repo, 'scripts', 'ci', 'controls-from-base.json'), '{roto');
  const r = sinInventario.correr('scripts/tests/del-freno.test.js');
  assert.ok(frena(r) && /note-red-test/.test(r.block), 'sin inventario, pide la nota');
  assert.ok(sinInventario.gates().some((g) => g.name === 'red-test-edit' && g.status === 'not-measured' && /control/.test(g.reason)),
    'y anota que no pudo ver si es la prueba de un control');
  // un marcador que no se lee no es «sin corrida»: no frena, pero lo anota
  const ilegible = laboratorio(t, { reporte: reporteDe('ses-a', [['arnes', 'tests/viejo.test.js']]) });
  fs.writeFileSync(path.join(ilegible.estado, 'active', 'ses-a.json'), '{roto');
  assert.strictEqual(ilegible.correr('scripts/tests/viejo.test.js'), null, 'con el marcador ilegible no frena');
  assert.ok(ilegible.gates().some((g) => g.name === 'red-test-edit' && g.status === 'not-measured' && /marcador/.test(g.reason)),
    'y anota que no pudo leer el marcador');
  // un reporte que está y no se lee no es «no hay reporte»: el motivo dice la causa
  const roto = laboratorio(t, { reporte: reporteDe('ses-a', [['arnes', 'tests/viejo.test.js']]) });
  fs.writeFileSync(path.join(roto.repo, '.advisors', 'tests-result.json'), '{roto');
  assert.ok(!frena(roto.correr('scripts/tests/viejo.test.js')), 'con el reporte ilegible no frena');
  assert.ok(roto.gates().some((g) => g.name === 'red-test-edit' && g.status === 'not-measured' && /no es un JSON legible/.test(g.reason)),
    'y anota que el reporte está y no se lee');
});

test('T37Case_Reproduced (T6) @story-8.166 @ac-1 @ac-2', (t) => {
  const lab = laboratorio(t, { reporte: reporteDe('ses-a', [['arnes', 'tests/office-hours.test.js']]) });
  const r = lab.correr('scripts/tests/office-hours.test.js');
  assert.ok(frena(r), 'la edición a su T37 frena');
  const m = path.join(lab.estado, 'active', 'ses-a.json');
  const marcador = JSON.parse(fs.readFileSync(m, 'utf8'));
  fs.writeFileSync(m, JSON.stringify({ ...marcador, redTestNotes: [{ test: path.join(lab.repo, 'scripts', 'tests', 'office-hours.test.js'), reason: 'dependía de la hora', at: '2026-10-31T10:00:00Z' }] }));
  assert.ok(!frena(lab.correr('scripts/tests/office-hours.test.js')), 'con la nota, pasa');
});

// ── modos de falla ────────────────────────────────────────────────────────────────────────────────────────────────

test('SameNameTests_RelativePath (T7) @story-8.166 @ac-7', (t) => {
  const lab = laboratorio(t, {
    reporte: reporteDe('ses-a', [['arnes', 'tests/viejo.test.js'], ['raiz-desconocida', 'tests/verde.test.js']]),
    archivos: { 'skills/tycon-pipeline/scripts/tests/viejo.test.js': "test('T1 homónima', () => {});\n" },
  });
  // la homónima de la otra raíz vive en la carpeta de skills: la falla de `arnes` no la frena
  fs.mkdirSync(path.join(lab.skills, 'tycon-pipeline', 'scripts', 'tests'), { recursive: true });
  const homonima = path.join(lab.skills, 'tycon-pipeline', 'scripts', 'tests', 'viejo.test.js');
  fs.copyFileSync(path.join(lab.repo, 'skills/tycon-pipeline/scripts/tests/viejo.test.js'), homonima);
  assert.ok(frena(lab.correr('scripts/tests/viejo.test.js')), 'la de la falla frena');
  const r = hook().handle({ session_id: 'ses-a', tool_name: 'Edit', cwd: lab.repo, tool_input: { file_path: homonima, old_string: 'a', new_string: 'b' } },
    { stateDir: lab.estado, casa: lab.casa, skillsDir: lab.skills });
  assert.ok(!frena(r), 'la homónima de la otra raíz no frena');
  // la raíz desconocida no frena y queda dicho
  assert.ok(!frena(lab.correr('scripts/tests/verde.test.js')), 'una raíz desconocida no frena');
  assert.ok(lab.gates().some((g) => g.name === 'red-test-edit' && g.status === 'not-measured' && /raíz/.test(g.reason)), 'lo anota como no medido');
  // la ruta de cada raíz, como la resuelven los lectores de suites.json
  const rutas = rte().rutasEnRojo(reporteDe('ses-a', [['arnes', 'tests/a.test.js'], ['agent-skills', 'tycon-pipeline/scripts/tests/b.test.js']]), lab.repo, { skillsDir: lab.skills });
  assert.deepStrictEqual(rutas.rutas, [path.join(lab.repo, 'scripts', 'tests', 'a.test.js'), path.join(lab.skills, 'tycon-pipeline', 'scripts', 'tests', 'b.test.js')]);
});

test('RedSuites_AnyNameInheritedAndSiblings (T7, pase adversarial) @story-8.166 @ac-1 @ac-7', (t) => {
  // una suite de suites.json cuyo nombre no es *.test.* (test-qa-guide.js) también es una prueba: en rojo, frena
  const lab = laboratorio(t, {
    reporte: reporteDe('ses-a', [['arnes', 'tests/test-qa-guide.js']]),
    archivos: { 'scripts/tests/test-qa-guide.js': "require('assert');\n" },
  });
  assert.ok(frena(lab.correr('scripts/tests/test-qa-guide.js')), 'una suite con otro nombre, en rojo, frena');
  assert.ok(!frena(lab.correr('scripts/lib/freno-de-juguete.js')), 'un archivo que no está en las fallas sigue en silencio');
  // la roja heredada (ya estaba roja en la base o en el nocturno) sale de failure_entries y queda por su nombre corto
  const her = laboratorio(t, { reporte: { by: { session: 'ses-a' }, totals: { failed: 0, failure_entries: [], inherited: 1, inherited_suites: ['office-hours.test.js'] } } });
  assert.ok(frena(her.correr('scripts/tests/office-hours.test.js')), 'una prueba vieja roja heredada también pide la nota');
  // la carpeta de skills es la del repo que corrió las pruebas: <repo>/skills en un clon unido
  const unido = laboratorio(t, {
    reporte: reporteDe('ses-a', [['agent-skills', 'tycon-pipeline/scripts/tests/del-repo.test.js']]),
    archivos: { 'skills/tycon-pipeline/scripts/tests/del-repo.test.js': "test('T1', () => {});\n",
      // el repo medido dice dónde están sus skills, como lo pregunta el corredor de suites.json
      'scripts/lib/skills-dir.js': "const path = require('path');\nmodule.exports = { resolveSkillsDirs: () => ({ skills: path.join(__dirname, '..', '..', 'skills'), source: 'own-clone' }) };\n" },
  });
  const delRepo = path.join(unido.repo, 'skills', 'tycon-pipeline', 'scripts', 'tests', 'del-repo.test.js');
  const r = hook().handle({ session_id: 'ses-a', tool_name: 'Edit', cwd: unido.repo, tool_input: { file_path: delRepo, old_string: 'a', new_string: 'b' } },
    { stateDir: unido.estado, casa: unido.casa });
  assert.ok(frena(r), 'la falla de agent-skills se resuelve contra el repo medido, no contra el arnés que corre el freno');
  // un repo hermano: su reporte está en su carpeta y el de la corrida lo nombra en companions[]
  const hermano = laboratorio(t, { reporte: { by: { session: 'ses-a' }, totals: { failed: 0, failure_entries: [] } } });
  const b = path.join(path.dirname(hermano.repo), 'hermano');
  fs.mkdirSync(path.join(b, 'scripts', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(b, 'scripts', 'tests', 'x.test.js'), "test('T1', () => {});\n");
  git(b, 'init', '-q', '-b', 'main'); git(b, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git(b, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'); git(b, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  fs.mkdirSync(path.join(b, '.advisors'), { recursive: true });
  fs.writeFileSync(path.join(b, '.advisors', 'tests-result.json'), JSON.stringify(reporteDe('ses-a', [['arnes', 'tests/x.test.js']])));
  const principal = path.join(hermano.repo, '.advisors', 'tests-result.json');
  fs.writeFileSync(principal, JSON.stringify({ ...JSON.parse(fs.readFileSync(principal, 'utf8')), companions: [{ root: b, artifact: path.join(b, '.advisors', 'tests-result.json') }] }));
  const rh = hook().handle({ session_id: 'ses-a', tool_name: 'Edit', cwd: b, tool_input: { file_path: path.join(b, 'scripts', 'tests', 'x.test.js'), old_string: 'a', new_string: 'b' } },
    { stateDir: hermano.estado, casa: hermano.casa, skillsDir: hermano.skills });
  assert.ok(frena(rh), 'la prueba en rojo de un repo hermano también frena');
  // el reporte del hermano no se lee: no frena a ciegas, pero queda anotado
  fs.writeFileSync(path.join(b, '.advisors', 'tests-result.json'), '{roto');
  const rr = hook().handle({ session_id: 'ses-a', tool_name: 'Edit', cwd: b, tool_input: { file_path: path.join(b, 'scripts', 'tests', 'x.test.js'), old_string: 'a', new_string: 'b' } },
    { stateDir: hermano.estado, casa: hermano.casa, skillsDir: hermano.skills });
  assert.ok(!frena(rr), 'con el reporte del hermano ilegible no frena');
  assert.ok(hermano.gates().some((g) => g.name === 'red-test-edit' && g.status === 'not-measured' && /hermano/.test(g.reason)), 'y anota que no pudo leerlo');
  // el reporte del hermano no dice de qué sesión es: no frena, y lo anota
  fs.writeFileSync(path.join(b, '.advisors', 'tests-result.json'), JSON.stringify(reporteDe(null, [['arnes', 'tests/x.test.js']])));
  const rs = hook().handle({ session_id: 'ses-a', tool_name: 'Edit', cwd: b, tool_input: { file_path: path.join(b, 'scripts', 'tests', 'x.test.js'), old_string: 'a', new_string: 'b' } },
    { stateDir: hermano.estado, casa: hermano.casa, skillsDir: hermano.skills });
  assert.ok(!frena(rs), 'con el reporte del hermano sin sesión no frena');
  assert.ok(hermano.gates().some((g) => g.name === 'red-test-edit' && g.status === 'not-measured' && /hermano/.test(g.reason) && /sesión/.test(g.reason)),
    'y anota que no sabe de qué sesión es');
  // un companions[] que nombra una carpeta que no es la raíz de un repo git no se lee (ni se carga nada de ahí), y lo dice
  const ajena = laboratorio(t, { reporte: { by: { session: 'ses-a' }, totals: { failed: 0, failure_entries: [] },
    companions: [{ root: path.join(b, 'scripts'), artifact: path.join(b, '.advisors', 'tests-result.json') }] } });
  const hs = require(path.join(SCRIPTS, 'on-red-test-edit.js')).reportesHermanos(JSON.parse(fs.readFileSync(path.join(ajena.repo, '.advisors', 'tests-result.json'), 'utf8')), null);
  assert.strictEqual(hs.length, 1, 'una entrada por hermano');
  assert.ok(hs[0].reporte === null && /no es la raíz de un repo git/.test(hs[0].error), 'una raíz que no es la de un repo no se lee y queda su motivo');
});

// ── no-regresión ──────────────────────────────────────────────────────────────────────────────────────────────────

test('AtddFirst_Unchanged (T8) @story-8.166 @ac-8', (t) => {
  const lab = laboratorio(t, { reporte: null, marcador: { stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'], fileEvents: [] } });
  lab.escribir('scripts/tests/primera.test.js', "test('T1 primera', () => {});\n");
  assert.ok(!frena(lab.correr('scripts/tests/primera.test.js')), 'la primera prueba de la corrida, antes del código, no pide nota');
  const { CHAINS } = require(path.join(SCRIPTS, 'dispatch.js'));
  const nombres = CHAINS['pre-edit'].map((x) => x.name);
  assert.ok(nombres.includes('on-atdd-preedit'), 'el freno de pruebas primero sigue en la cadena');
  assert.ok(nombres.indexOf('on-red-test-edit') > nombres.indexOf('on-atdd-preedit'), 'y va después de éste');
});

test('OutsideRun_NoAction (T9) @story-8.166 @ac-9', (t) => {
  const lab = laboratorio(t, { reporte: reporteDe('ses-a', [['arnes', 'tests/viejo.test.js']]), marcador: null });
  assert.strictEqual(lab.correr('scripts/tests/viejo.test.js'), null, 'sin corrida abierta, no actúa');
  assert.strictEqual(lab.gates().length, 0, 'ni anota nada');
});

test('RuleWritten_InStepAndGuide (T10) @story-8.166 @ac-6', () => {
  const FRASE = 'Una prueba que ya existía y estaba en rojo no se edita para que pase: se para y se dice por qué.';
  const paso = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-05-implement.md'), 'utf8');
  assert.ok(paso.includes(FRASE), 'el paso de implementar dice la regla');
  const guia = fs.readFileSync(path.join(RAIZ, 'guides', 'workflow-orchestration.md'), 'utf8');
  const s26 = guia.split(/\n#{2,4} /).find((s) => /^2\.6\b/.test(s.trim()) || /Corrección Autónoma de Errores/.test(s.split('\n')[0]));
  assert.ok(s26, 'la guía tiene su §2.6');
  assert.ok(s26.includes(FRASE), 'y la §2.6 dice la regla, literal');
});
