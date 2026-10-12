'use strict';
/**
 * review-roster — el registro de autoría de una story (2026-08-30, "revisor ≠ autor").
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

// ── Hallazgos del pase adversarial (2026-08-30) ──────────────────────────────────────────────
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

// ── `iterations` = RONDAS de revisión, no escrituras del archivo (2026-09-06) ─────────────────
// Medido en la story 2.3 del arnés: el roster publicó `iterations: 2` y la corrida tuvo 3 rondas.
// El número salía de `iterPrevias + 1`, o sea que contaba cuántas veces se había escrito el
// archivo — dos cosas que sólo coinciden si el roster se escribe exactamente una vez por ronda,
// que no es lo que pasa. La constancia decía menos de lo que había, y nadie lo notaba porque
// ningún gate lee el campo.
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
  // 🔴 Es el caso REAL: la suite `advisor-set-config.test.js` escribía ráfagas de 12 `step5-start`
  // pelados en el ledger de la sesión viva. Contarlos daría 26 rondas donde hubo 2.
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

// ── El sha sella el contenido REVISADO, no sólo el commit anterior (2026-09-06) ───────────────
// `head_sha` decía `3c759ea` en la 2.3 — el HEAD cuando corrieron los revisores. No es falso: es
// INÚTIL para auditar, porque la implementación entera vive en el commit siguiente. Medido: de los
// 25 archivos que la story tocó, 12 no existen en ese árbol y los otros 13 tienen otro contenido —
// cero idénticos. El campo se llama ahora `base_sha` (que es lo que es) y lo acompaña `tree_sha`,
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

// ── Las fuentes que escribe el PROPIO pipeline no son un revisor ausente (2026-09-06) ────────
// `FUENTES_SINTETICAS` tenía tres patrones. Medido sobre los runs reales del disco, quedaban
// CINCO fuentes afuera — y una es una variante escrita distinto de un patrón que SÍ estaba
// (`adversarial-verify (3 lentes)` contra `adversarial-verify:x`). Con la story 2.1 de
// el arnés el portón de CI daba `roster-incoherente` ×3 por «orquestador» y
// «runtime-matrix (smoke AC 14)»: el orquestador no es un revisor, es el pipeline mismo.
// Por eso el patrón reconoce el PREFIJO y no el nombre exacto: una lista literal vuelve a morder
// con la próxima variante, y este caso ya lo demostró.
test('las fuentes del propio pipeline se reconocen por prefijo, con sus variantes reales', () => {
  const base = { version: 1, implementer: { kind: 'sesion-principal' }, reviewers: [{ agent: 'a', kind: 'subagente' }] };
  const reales = ['orquestador', 'orquestador (smoke AC 15)', 'runtime-matrix (smoke AC 14)',
    'adversarial-verify (3 lentes)', 'adversarial-verify', 'ensayo runtime (no advisor)', 'mech-check', 'pipeline'];
  const v = R.validate(base, { advisoresEnFindings: reales });
  assert.equal(v.ok, true, `estas fuentes las escribe el pipeline, no un spawn: ${JSON.stringify(v.problemas)}`);
});

// Story 4.4 del arnés (2026-09-14): los pases adversariales se registraron como
// `adversarial-verify-fable`, `-opus`, `-sonnet-final` y `-sonnet-pase2` (y otro run, `-5b`). El
// separador `-` no estaba entre los aceptados y el portón dio `roster-incoherente` ×4 sobre un cierre
// sano. Aceptar el guion no abre nada que `adversarial-verify:<lo que sea>` no abriera ya.
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
