'use strict';
/**
 * review-roster — el registro de autoría de una story ("revisor ≠ autor").
 * Lo que estos casos fijan es la parte PURA: armar el roster desde el ledger y validarlo. El
 * comportamiento del hook (cuándo se escribe, que apagar la foto no lo apague, que un fallo deje
 * constancia) vive en el banco de controles: `cases/hooks/30-review-roster.json`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../lib/review-roster.js');

const linea = (advisor, extra = {}) => ({ ts: '2026-08-30T21:00:00Z', advisor, repo: '/r', story: '9.4', ...extra });

test('arma el roster desde el ledger: revisores = subagentes, implementador = la sesión', () => {
  const r = R.build({ lines: [linea('a', { model: 'opus' }), linea('b')], story: '9.4', sessionId: 's1' });
  assert.equal(r.implementer.kind, 'sesion-principal');
  assert.equal(r.implementer.session_id, 's1');
  assert.deepEqual(r.reviewers.map((x) => x.agent), ['a', 'b']);
  assert.ok(r.reviewers.every((x) => x.kind === 'subagente'));
  assert.equal(r.reviewers[0].model, 'opus');
  assert.equal(r.reviewers[0].model_source, 'spawn');
});

test('ignora los spawns de OTRA story: una sesión puede tocar varias', () => {
  const r = R.build({ lines: [linea('a'), linea('ajeno', { story: '1.1' })], story: '9.4', sessionId: 's1' });
  assert.deepEqual(r.reviewers.map((x) => x.agent), ['a']);
});

test('ignora las líneas de evento (no son revisores)', () => {
  const r = R.build({ lines: [{ event: 'step5-start', expected: ['a'] }, linea('a')], story: '9.4', sessionId: 's1' });
  assert.equal(r.reviewers.length, 1);
});

test('el re-loop SUMA revisores en vez de pisarlos, y cuenta las iteraciones', () => {
  const uno = R.build({ lines: [linea('a')], story: '9.4', sessionId: 's1' });
  const dos = R.build({ lines: [linea('a'), linea('b')], story: '9.4', sessionId: 's1', previo: uno });
  assert.deepEqual(dos.reviewers.map((x) => x.agent), ['a', 'b']);
  assert.equal(dos.iterations, 2);
});

test('validate: sin revisores no vale', () => {
  const v = R.validate({ version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [] });
  assert.equal(v.ok, false);
  assert.ok(v.problemas.some((p) => p.regla === 'sin-revisores'));
});

test('validate: el que implementó no puede figurar como revisor', () => {
  const v = R.validate({ version: 1, implementer: { kind: 'sesion-principal', session_id: 's1' }, reviewers: [{ agent: 'yo', kind: 'sesion-principal' }] });
  assert.ok(v.problemas.some((p) => p.regla === 'revisor-es-el-autor'));
});

test('validate: un advisor con hallazgos que el roster no lista es incoherencia', () => {
  const base = { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [{ agent: 'a', kind: 'subagente' }] };
  assert.equal(R.validate(base, { advisoresEnFindings: ['a'] }).ok, true);
  assert.ok(R.validate(base, { advisoresEnFindings: ['fantasma'] }).problemas.some((p) => p.regla === 'roster-incoherente'));
});

test('write es idempotente y el archivo queda legible por read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  R.write(dir, { lines: [linea('a')], story: '9.4', sessionId: 's1' });
  const dos = R.write(dir, { lines: [linea('a')], story: '9.4', sessionId: 's1' });
  assert.deepEqual(dos.reviewers.map((x) => x.agent), ['a']); // no duplica
  assert.equal(R.read(dir).story, '9.4');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('la excusa escrita del dev sobrevive al reescribir el roster', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  R.write(dir, { lines: [linea('a')], story: '9.4', sessionId: 's1' });
  const conExcusa = { ...R.read(dir), sin_testigo: 'implementado en la desktop' };
  fs.writeFileSync(path.join(dir, 'review-roster.json'), JSON.stringify(conExcusa));
  const tras = R.write(dir, { lines: [linea('a'), linea('b')], story: '9.4', sessionId: 's1' });
  assert.equal(tras.sin_testigo, 'implementado en la desktop');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('un roster ilegible hace fallar read (no lo tapa devolviendo null)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  fs.writeFileSync(path.join(dir, 'review-roster.json'), '{ no es json');
  assert.throws(() => R.read(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Qué cuenta como revisor ─────────────────────────────────────────────────────────────────
// Los tres primeros fijan la promesa central: no cualquier spawn es un revisor.

test('los agentes de exploración libre NO son revisores', () => {
  const r = R.build({ lines: [linea('general-purpose'), linea('Explore'), linea('claude'), linea('tycon-plugin-security-basics')], story: '9.4', sessionId: 's1' });
  assert.deepEqual(r.reviewers.map((x) => x.agent), ['tycon-plugin-security-basics']);
});

test('sólo cuentan los spawns POSTERIORES al arranque de la ronda de revisión', () => {
  const lines = [
    linea('tycon-story-validator'),                       // paso 1: antes de la ronda
    { event: 'step5-start', iter: 1, expected: ['tycon-plugin-security-basics'] },
    linea('tycon-plugin-security-basics'),
  ];
  const r = R.build({ lines, story: '9.4', sessionId: 's1' });
  assert.deepEqual(r.reviewers.map((x) => x.agent), ['tycon-plugin-security-basics']);
});

test('un spawn SIN story no se adopta como revisor de esta story', () => {
  const r = R.build({ lines: [linea('a', { story: null }), linea('b')], story: '9.4', sessionId: 's1' });
  assert.deepEqual(r.reviewers.map((x) => x.agent), ['b']);
});

test('las fuentes del propio pipeline no cuentan como advisor ausente del roster', () => {
  const base = { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [{ agent: 'a', kind: 'subagente' }] };
  const v = R.validate(base, { advisoresEnFindings: ['mech-check', 'adversarial-verify:algorithmic-correctness', 'pipeline', 'a'] });
  assert.equal(v.ok, true, JSON.stringify(v.problemas));
});

// ── `iterations` = RONDAS de revisión, no escrituras del archivo ─────────────────────────────
// Si el número saliera de `iterPrevias + 1`, contaría cuántas veces se escribió el
// archivo — dos cosas que sólo coinciden si el roster se escribe exactamente una vez por ronda,
// que no es lo que pasa. La constancia diría menos de lo que hubo (un roster con `iterations: 2`
// en una corrida de 3 rondas), y nadie lo notaría porque ningún gate lee el campo.
const ronda = (n, ...advisors) => [{ event: 'step5-start', iter: n }, ...advisors.map((a) => linea(a))];

test('iterations cuenta las rondas del ledger, no las veces que se escribió el roster', () => {
  const lines = [...ronda(1, 'a', 'b'), ...ronda(2, 'c'), ...ronda(3, 'd')];
  const r = R.build({ lines, story: '9.4', sessionId: 's1' });
  assert.equal(r.iterations, 3, 'tres marcas de ronda con spawns → tres rondas');
  assert.equal(r.iterations_source, 'ledger');
});

test('escribir dos veces con el MISMO ledger no inventa una ronda', () => {
  const lines = [...ronda(1, 'a'), ...ronda(2, 'b')];
  const uno = R.build({ lines, story: '9.4', sessionId: 's1' });
  const dos = R.build({ lines, story: '9.4', sessionId: 's1', previo: uno });
  assert.equal(uno.iterations, 2);
  assert.equal(dos.iterations, 2, 'el ledger no cambió: el número tampoco');
});

test('una marca de ronda SIN spawns de esta story no cuenta como ronda', () => {
  // 🔴 Una suite que escribe en el ledger de la sesión viva puede dejar ráfagas de 12 `step5-start`
  // pelados. Contarlos daría 26 rondas donde hubo 2.
  const pelados = Array.from({ length: 12 }, () => ({ event: 'step5-start' }));
  const lines = [...pelados, ...ronda(1, 'a'), ...pelados, ...ronda(2, 'b')];
  const r = R.build({ lines, story: '9.4', sessionId: 's1' });
  assert.equal(r.iterations, 2, `las marcas sin spawn de la story no son rondas (dio ${r.iterations})`);
});

test('sin marcas de ronda en el ledger, el número se declara como lo que es: un proxy', () => {
  // Ledger sin `step5-start` (hook no instalado, o Codex sin el evento): no se puede medir la
  // ronda. Se conserva la cuenta de escrituras — pero DICIENDO que es eso, no un dato medido.
  const uno = R.build({ lines: [linea('a')], story: '9.4', sessionId: 's1' });
  const dos = R.build({ lines: [linea('a'), linea('b')], story: '9.4', sessionId: 's1', previo: uno });
  assert.equal(dos.iterations, 2);
  assert.equal(dos.iterations_source, 'escrituras');
});

// ── El sha sella el contenido REVISADO, no sólo el commit anterior ──────────────────────────
// El HEAD de cuando corrieron los revisores no es falso, pero es INÚTIL para auditar, porque la
// implementación entera vive en el commit siguiente: los archivos que toca la story no existen en
// ese árbol o tienen otro contenido. El campo se llama `base_sha` (que es lo que es) y lo acompaña `tree_sha`,
// el sha del ÁRBOL que los revisores realmente miraron. Ese sí se audita solo: `git ls-tree`
// contra el árbol del commit de la story tiene que dar lo mismo.
test('el roster publica base_sha y tree_sha (el contenido revisado, no sólo su base)', () => {
  const r = R.build({ lines: [linea('a')], story: '9.4', sessionId: 's1', headSha: 'abc1234', treeSha: 'def5678' });
  assert.equal(r.base_sha, 'abc1234');
  assert.equal(r.tree_sha, 'def5678');
});

test('sin poder sellar el árbol revisado, queda en null — nunca un valor inventado', () => {
  const r = R.build({ lines: [linea('a')], story: '9.4', sessionId: 's1', headSha: 'abc1234' });
  assert.equal(r.tree_sha, null);
});

test('treeShaDe: mismo árbol → mismo sello; árbol distinto → sello distinto', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-diff-'));
  const { spawnSync } = require('child_process');
  const g = (...a) => spawnSync('git', ['-C', d, ...a], { stdio: 'ignore' });
  fs.writeFileSync(path.join(d, 'a.txt'), 'base\n');
  g('init', '-q', '-b', 'main', '.'); g('add', '-A');
  g('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');

  const limpio = R.treeShaDe(d);
  fs.writeFileSync(path.join(d, 'a.txt'), 'lo que revisaron\n');
  const sucio1 = R.treeShaDe(d);
  const sucio2 = R.treeShaDe(d);
  fs.writeFileSync(path.join(d, 'a.txt'), 'otra cosa\n');
  const sucio3 = R.treeShaDe(d);

  assert.ok(sucio1, 'con cambios tiene que dar una huella');
  assert.equal(sucio1, sucio2, 'el mismo árbol da la misma huella (si no, no sirve para auditar)');
  assert.notEqual(sucio1, sucio3, 'otro contenido, otra huella');
  assert.notEqual(sucio1, limpio, 'el árbol limpio y el revisado no pueden dar lo mismo');
  fs.rmSync(d, { recursive: true, force: true });
});

test('treeShaDe: fuera de un repo devuelve null, no rompe ni miente', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-norepo-'));
  assert.equal(R.treeShaDe(d), null);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── Las fuentes que escribe el PROPIO pipeline no son un revisor ausente ────────────────────
// Un listado corto de patrones literales dejaría afuera fuentes del propio pipeline, incluida una
// variante escrita distinto de un patrón conocido (`adversarial-verify (3 lentes)` contra
// `adversarial-verify:x`). Entonces el portón de CI daría `roster-incoherente` por «orquestador» y
// «runtime-matrix (smoke AC 14)»: el orquestador no es un revisor, es el pipeline mismo.
// Por eso el patrón reconoce el PREFIJO y no el nombre exacto: una lista literal muerde
// con la próxima variante.
test('las fuentes del propio pipeline se reconocen por prefijo, con sus variantes reales', () => {
  const base = { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [{ agent: 'a', kind: 'subagente' }] };
  const reales = ['orquestador', 'orquestador (smoke AC 15)', 'runtime-matrix (smoke AC 14)',
    'adversarial-verify (3 lentes)', 'adversarial-verify', 'ensayo runtime (no advisor)', 'mech-check', 'pipeline'];
  const v = R.validate(base, { advisoresEnFindings: reales });
  assert.equal(v.ok, true, `estas fuentes las escribe el pipeline, no un spawn: ${JSON.stringify(v.problemas)}`);
});

// Los pases adversariales se registran como `adversarial-verify-fable`, `-opus`, `-sonnet-final`,
// `-sonnet-pase2` y `-5b`. El separador `-` tiene que estar entre los aceptados, o el portón daría
// `roster-incoherente` sobre un cierre sano. Aceptar el guion no abre nada que
// `adversarial-verify:<lo que sea>` no abriera ya.
test('los pases adversariales nombrados con guion también son fuentes del pipeline', () => {
  const base = { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [{ agent: 'a', kind: 'subagente' }] };
  const reales = ['adversarial-verify-fable', 'adversarial-verify-opus', 'adversarial-verify-sonnet-final',
    'adversarial-verify-sonnet-pase2', 'adversarial-verify-5b'];
  const v = R.validate(base, { advisoresEnFindings: reales });
  assert.equal(v.ok, true, `los nombres reales de la 4.4 no son revisores ausentes: ${JSON.stringify(v.problemas)}`);
  const pegado = R.validate(base, { advisoresEnFindings: ['adversarial-verifyx'] });
  assert.equal(pegado.ok, false, '`adversarial-verifyx` (sin separador) no es el pase adversarial y tiene que seguir frenando');
});

test('un advisor INVENTADO sigue siendo incoherencia — el prefijo no abre la puerta a cualquiera', () => {
  const base = { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [{ agent: 'a', kind: 'subagente' }] };
  for (const falso of ['tycon-advisor-inventado', 'orquestadorx', 'runtime-matrixx', 'el orquestador']) {
    const v = R.validate(base, { advisoresEnFindings: [falso] });
    assert.equal(v.ok, false, `"${falso}" no es una fuente del pipeline y tiene que seguir frenando`);
  }
});

// Un revisor llamado DESPUÉS de sellada la ronda (el de la prueba en vivo, paso 7c) también entra al registro: si el
// gancho lo escribiera sólo al completarse la ronda, `write-findings` rechazaría al revisor del 7c como firmante. El caso
// corre en un repo sin commits (la primera historia de un repo recién creado).
test('Roster_RevisorDeLaPruebaEnVivo_Firma @story-8.63 @ac-10', () => {
  const { execFileSync, spawnSync } = require('child_process');
  const SCRIPTS = path.join(__dirname, '..');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-7c-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home); fs.mkdirSync(path.join(repo, 'stories'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });   // sin commits: la primera historia de un repo nuevo
  const story = path.join(repo, 'stories', 'story-1.1-precios.md');
  fs.writeFileSync(story, ['---', 'story: "1.1"', 'title: "precios"', 'status: in-progress', '---', '', '# Story 1.1', ''].join('\n'));
  const sid = 's-7c';
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_AUTO_SNAPSHOT: '0' };
  delete env.TYCON_HOME;
  const set = spawnSync(process.execPath, [path.join(SCRIPTS, 'marker.js'), 'set', JSON.stringify({ storyId: '1.1', storyPath: story, repoPath: repo })], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(set.status, 0, set.stderr);
  const estado = require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(home);
  fs.mkdirSync(path.join(estado, 'advisor-runs'), { recursive: true });
  fs.writeFileSync(path.join(estado, 'advisor-runs', `${sid}.jsonl`),
    `${JSON.stringify({ ts: '2026-10-19T22:00:00Z', event: 'step5-start', iter: 1, expected: ['tycon-silent-failure-hunter'], story: '1.1' })}\n`);
  const spawn = (agente) => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'on-advisor-run.js')], {
      cwd: repo, env, encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Agent', session_id: sid, cwd: repo, tool_input: { subagent_type: agente, prompt: 'x' } }),
    });
    assert.equal(r.status, 0, r.stderr);
  };
  spawn('tycon-silent-failure-hunter');   // completa y sella la ronda
  spawn('tycon-dod-runtime-checker');     // el paso 7c, después del sello
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '1.1', false, story);
  const roster = R.read(runDir);
  assert.ok(roster, 'hay registro de autoría');
  assert.deepEqual(roster.reviewers.map((r) => r.agent).sort(), ['tycon-dod-runtime-checker', 'tycon-silent-failure-hunter']);
  const f = path.join(base, 'f.json');
  fs.writeFileSync(f, JSON.stringify([{ rule_id: 'DODRT-W1', severity: 'WARNING', advisor: 'tycon-dod-runtime-checker', file: 'a', disposition: 'open', reason: 'r' }]));
  const w = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'write-findings', '--story', story, '--repo', repo, '--findings', f], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(w.status, 0, `${w.stdout}${w.stderr}`);
  fs.rmSync(base, { recursive: true, force: true });
});
