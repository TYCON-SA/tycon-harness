'use strict';
/**
 * vocabulary.test.js — el control de las palabras de las guías (scripts/ci/vocabulary.js).
 * stable-data: los commits de los repos de juguete van con fecha fija y sin mantenimiento.
 *
 * POR QUÉ. Las guías en castellano decían la misma cosa con dos palabras (historia y story, revisor y advisor). Sin un
 * control que cuente, el sinónimo vuelve con el próximo párrafo apurado y nadie lo ve.
 *
 * QUÉ MIDE. Que una palabra nueva frena con archivo, línea y la que va en su lugar (T1, T8); que el código, los enlaces y
 * los nombres de la máquina no cuentan (T2, T11); que la frase que arranca el recorrido y las excepciones declaradas no
 * cuentan, y una excepción mal declarada frena (T3); que el techo sólo baja (T4); que sólo se mide la prosa en castellano
 * (T5); que el glosario y las reglas dicen lo mismo (T6); que el árbol real cabe en su techo (T7); y que unas reglas que
 * no se leen dan «no medido», nunca verde (T12).
 *
 * Correr:   node --test scripts/tests/vocabulary.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'scripts', 'ci', 'vocabulary.js');
const VOC = require(TOOL);
const FIXED = { GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z' };

// las reglas de juguete: las mismas filas que el glosario, con sus excepciones
const RULES = {
  terms: [
    { use: 'historia', avoid: ['story', 'stories'] },
    { use: 'revisor', avoid: ['advisor', 'advisors'] },
    { use: 'ejecución', avoid: ['corrida', 'corridas'] },
    { use: 'arnés', avoid: ['harness'] },
    { use: 'portón', avoid: ['gate', 'gates'] },
    { use: 'historial', avoid: ['historia de git', 'historia del repo', 'historia de la rama'] },
  ],
  exceptions: [{ phrase: 'implementemos la story', reason: 'la frase que arranca el recorrido: la skill la reconoce tal cual' }],
  ceiling: {},
};

function git(dir, args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@acme.example', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { encoding: 'utf8', env: { ...process.env, ...FIXED } });
}
// en un repo de juguete, una excepción que ninguna guía trae frena: por defecto van sin excepciones
const TOY = { ...RULES, exceptions: [] };
/** Un repo de juguete con sus reglas (o el texto crudo de las reglas) y sus archivos, todo en el índice. */
function toyRepo(files, rules = TOY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocabulary-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const all = { 'scripts/ci/vocabulary.json': typeof rules === 'string' ? rules : JSON.stringify(rules), ...files };
  for (const [rel, text] of Object.entries(all)) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, ['add', '-A']);
  return dir;
}
const cli = (dir, ...extra) => spawnSync(process.execPath, [TOOL, '--repo', dir, ...extra], { encoding: 'utf8' });
const words = (text, rules = RULES) => VOC.mentionsIn(text, rules).map((m) => m.word.toLowerCase());

/** El tramo del control en el pre-commit, desde su variable hasta su `fi` de primer nivel. */
function hookBlock() {
  const hook = fs.readFileSync(path.join(ROOT, '.githooks', 'pre-commit-checks'), 'utf8');
  const start = hook.indexOf('VOCABULARY="$REPO_ROOT/scripts/ci/vocabulary.js"');
  assert.ok(start >= 0, 'el pre-commit tiene el bloque del control');
  const end = hook.indexOf('\nfi\n', start);
  assert.ok(end > start, 'el bloque cierra con su fi');
  return hook.slice(start, end + 4);
}
/** Corre el bloque del pre-commit sobre un repo de juguete que trae el guion del control. */
function runHookBlock(dir) {
  fs.copyFileSync(TOOL, path.join(dir, 'scripts', 'ci', 'vocabulary.js'));
  return spawnSync('bash', ['-c', `set -uo pipefail\nREPO_ROOT=${JSON.stringify(dir)}\n${hookBlock()}\nexit 0\n`], { encoding: 'utf8' });
}

test('T1 Vocabulario_TerminoNuevoEnProsa_Frena @story-8.154 @ac-1', () => {
  const dir = toyRepo({ 'guides/x.md': '# Guía\n\nEl revisor mira el cambio.\n' });
  assert.strictEqual(runHookBlock(dir).status, 0, 'sin la palabra, el commit pasa');
  fs.appendFileSync(path.join(dir, 'guides/x.md'), 'Y después corre el advisor.\n');
  git(dir, ['add', 'guides/x.md']);
  const r = runHookBlock(dir);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  const out = r.stdout + r.stderr;
  assert.match(out, /guides\/x\.md:4/, 'archivo y línea');
  assert.match(out, /«advisor» → revisor/, 'la palabra y la que va en su lugar');
});

test('T2 Vocabulario_CodigoEnlacesYNombresNoCuentan @story-8.154 @ac-2', () => {
  const noCuentan = [
    'Se corre con `advisor` y ``story`` entre acentos.',
    '```bash',
    'node advisor.js --story x',
    '```',
    '~~~',
    'gate harness corrida',
    '~~~',
    'Ver [el catálogo](guides/advisor-rules-catalog.md) y advisor-rules-catalog.md.',
    '[ref]: https://example.com/story/advisor',
    'En <https://example.com/gate> y https://example.com/harness.',
  ].join('\n');
  assert.deepStrictEqual(words(noCuentan), [], 'código, bloques, enlaces y nombres de la máquina no cuentan');
  const prosa = [
    'Las Stories y los advisors.',
    'Corridas y GATES.',
    'Se ve en la historia de git, en la historia del repo y en la Historia de la rama.',
  ].join('\n');
  assert.deepStrictEqual(words(prosa), ['stories', 'advisors', 'corridas', 'gates', 'historia de git', 'historia del repo', 'historia de la rama']);
  assert.deepStrictEqual(words('Es una historia, y se entra por la puerta.'), [], '«historia» y «puerta» sueltas no cuentan');
  const m = VOC.mentionsIn('uno\nlos advisors\n', RULES);
  assert.deepStrictEqual(m.map((x) => [x.line, x.use]), [[2, 'revisor']], 'la línea y la palabra que va en su lugar');
  // el texto se mide entero: un término partido por el salto de renglón cuenta, en la línea donde empieza
  const flat = (text) => VOC.mentionsIn(text, RULES).map((x) => [x.line, x.word.toLowerCase().replace(/\s+/g, ' ')]);
  assert.deepStrictEqual(flat('Mirá la historia de\ngit y la historia\ndel repo.'), [[1, 'historia de git'], [2, 'historia del repo']]);
  assert.deepStrictEqual(flat('Se corre `node x\nadvisor.js` y listo.'), [], 'el código entre acentos que sigue en el renglón siguiente no cuenta');
  // los bloques de código de CommonMark: dentro de una cita, un cierre sin texto, y una línea con código de tres acentos
  assert.deepStrictEqual(flat('> ```\n> story en cita\n> ```\nfuera story'), [[4, 'story']], 'el bloque dentro de una cita');
  assert.deepStrictEqual(flat('```\ncódigo\n```js\nstory adentro\n```\nstory afuera'), [[6, 'story']], 'un «```js» adentro no cierra el bloque');
  assert.deepStrictEqual(flat('```foo``` story\nmás story\n```\nfin story\n```'), [[1, 'story'], [2, 'story']], 'una línea con código de tres acentos no abre un bloque');
  assert.deepStrictEqual(flat('[^1]: la story de la nota\n[ref]: https://example.com/story'), [[1, 'story']], 'una nota al pie es prosa; una referencia no');
  // un bloque sin cerrar deja todo lo que sigue sin medir: frena y lo dice, así un techo no baja sin haber barrido
  const abierto = VOC.check({ repo: toyRepo({ 'guides/x.md': 'antes\n```\nadentro story\n' }) });
  assert.ok(!abierto.ok && abierto.problems.some((p) => /guides\/x\.md/.test(p) && /sin cerrar/.test(p)), abierto.problems.join('\n'));
});

test('T3 Vocabulario_FraseGatilloYExcepciones @story-8.154 @ac-3', () => {
  assert.deepStrictEqual(words('Decí «Implementemos la story specs/x.md» y arranca.'), [], 'la frase que arranca el recorrido no cuenta');
  const guia = { 'guides/x.md': 'implementemos la story x\nuna historia (story) es el pedido\n' };
  const conMotivo = { ...RULES, exceptions: [...RULES.exceptions, { phrase: 'una historia (story)', reason: 'la portada presenta el par a propósito' }] };
  const ok = VOC.check({ repo: toyRepo(guia, conMotivo) });
  assert.strictEqual(ok.ok, true, ok.problems.join('\n'));
  assert.deepStrictEqual(ok.perFile, {}, 'la excepción con motivo no cuenta');
  const malas = [
    [{ phrase: 'una historia (story)', reason: '' }, /sin motivo/],
    [{ phrase: 'una * (story)', reason: 'x' }, /comod/],
    [{ phrase: 'una historia (story)', reason: 'x', path: ['guides/x.md'] }, /path/],
  ];
  for (const [e, why] of malas) {
    const r = VOC.check({ repo: toyRepo(guia, { ...RULES, exceptions: [...RULES.exceptions, e] }) });
    assert.ok(!r.ok && r.problems.some((p) => why.test(p)), `${JSON.stringify(e)}: ${r.problems.join('\n')}`);
  }
  // una excepción que ya no encuentra su frase avisa y sale 0: sacar la frase y la excepción juntas endurece, y la
  // revisión desde la base no lo puede ver como un aflojamiento
  const vieja = VOC.check({ repo: toyRepo(guia, { ...conMotivo, exceptions: [...conMotivo.exceptions, { phrase: 'esta frase no está', reason: 'x' }] }) });
  assert.strictEqual(vieja.ok, true, vieja.problems.join('\n'));
  assert.ok(vieja.notes.some((n) => /esta frase no está/.test(n) && /sacala/.test(n)), vieja.notes.join(' · '));
  // la frase que arranca el recorrido, partida por un salto de renglón, sigue siendo la excepción
  assert.deepStrictEqual(words('Decí «implementemos la\nstory specs/x.md» y arranca.'), []);
  // una excepción con archivo vale sólo en su archivo, y su archivo va exacto
  const conArchivo = { ...RULES, exceptions: [...RULES.exceptions, { phrase: 'una historia (story)', reason: 'x', path: 'guides/x.md' }] };
  const otro = VOC.check({ repo: toyRepo({ ...guia, 'guides/y.md': 'una historia (story)\n' }, conArchivo) });
  assert.deepStrictEqual(otro.perFile, { 'guides/y.md': 1 }, JSON.stringify(otro.perFile));
  const comodin = { ...RULES, exceptions: [...RULES.exceptions, { phrase: 'una historia (story)', reason: 'x', path: 'guides/*.md' }] };
  assert.ok(VOC.check({ repo: toyRepo(guia, comodin) }).problems.some((p) => /comod/.test(p)));
});

test('T4 Vocabulario_TechoQueSoloBaja @story-8.154 @ac-4', () => {
  const files = { 'guides/justo.md': 'un advisor\n', 'guides/abajo.md': 'una story\n' };
  const rules = { ...TOY, ceiling: { 'guides/justo.md': 1, 'guides/abajo.md': 3 } };
  const dir = toyRepo(files, rules);
  const r = VOC.check({ repo: dir });
  assert.strictEqual(r.ok, true, r.problems.join('\n'));
  assert.ok(r.notes.some((n) => /guides\/abajo\.md/.test(n) && /\b1\b/.test(n) && /vocabulary\.json/.test(n)), `dice el número que va en el techo: ${r.notes.join(' · ')}`);
  const c = cli(dir);
  assert.strictEqual(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /guides\/abajo\.md/);
  // un archivo nuevo nace con techo 0
  fs.writeFileSync(path.join(dir, 'guides/nuevo.md'), 'el harness\n');
  git(dir, ['add', '-A']);
  const n = cli(dir);
  assert.strictEqual(n.status, 1, n.stdout + n.stderr);
  assert.match(n.stdout + n.stderr, /guides\/nuevo\.md:1/);
  // y uno con techo que lo supera, también
  fs.appendFileSync(path.join(dir, 'guides/justo.md'), 'otro advisor\n');
  git(dir, ['add', '-A']);
  assert.ok(VOC.check({ repo: dir }).problems.some((p) => /guides\/justo\.md/.test(p)));
});

test('T5 Vocabulario_InglesYFueraDeAlcanceNoSeMiden @story-8.154 @ac-5', () => {
  const files = {
    'guides/a.en.md': 'the advisor\n',
    'README.md': 'the advisor\n',
    'skills/s/SKILL.md': 'el advisor\n',
    'guides/s/SKILL.md': 'el advisor\n',
    'scripts/x.js': '// el advisor\n',
    'docs/x.md': 'el advisor\n',
    'INDEX.md': 'el advisor\n',
    'INSTALL.md': 'el advisor\n',
    'README.es.md': 'el advisor\n',
    'guides/b.md': 'el advisor\n',
    'getting-started/one-minute.md': 'the advisor\n',
    'getting-started/one-minute.es.md': 'el advisor\n',
    'getting-started/mac.md': 'el advisor\n',
  };
  const r = VOC.check({ repo: toyRepo(files) });
  assert.deepStrictEqual(Object.keys(r.perFile).sort(), ['INDEX.md', 'INSTALL.md', 'README.es.md', 'getting-started/mac.md', 'getting-started/one-minute.es.md', 'guides/b.md']);
  const all = new Set(Object.keys(files));
  assert.strictEqual(VOC.measured('getting-started/one-minute.md', all), false, 'un X.md con su X.es.md al lado es el inglés del par');
  assert.strictEqual(VOC.measured('getting-started/mac.md', all), true, 'sin par, está en castellano');
});

test('T6 Vocabulario_GlosarioIgualALasReglas @story-8.154 @ac-6', () => {
  const guide = fs.readFileSync(path.join(ROOT, 'guides', 'maintaining', 'vocabulario.md'), 'utf8');
  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'vocabulary.json'), 'utf8'));
  const fromGuide = VOC.glossaryTable(guide);
  const fromRules = rules.terms.map((t) => ({ use: t.use, avoid: [...t.avoid].sort() }));
  assert.deepStrictEqual(fromGuide, fromRules, 'mismos términos y mismas palabras canónicas, en el mismo orden');
  assert.deepStrictEqual(rules.terms.map((t) => t.use), ['historia', 'revisor', 'ejecución', 'arnés', 'portón', 'historial']);
  for (const w of ['pipeline', 'freno', 'puerta']) assert.match(guide, new RegExp(w), `la guía dice por qué «${w}» queda como está`);
  assert.deepStrictEqual(VOC.mentionsIn(guide, rules), [], 'las palabras que no se escriben van entre acentos graves: la guía nace con techo 0');
});

test('T7 Vocabulario_ArbolRealCabeEnSuTecho @story-8.154 @ac-7', (t) => {
  const r = VOC.check({ repo: ROOT, skipThin: true });
  if (r.skipped) { t.skip('el árbol es el repo de mantenimiento adelgazado: lo mide la copia del público'); return; }
  assert.strictEqual(r.ok, true, r.problems.join('\n'));
  assert.deepStrictEqual(r.notes, [], 'el techo es justo lo que hay hoy');
  assert.ok(Object.keys(r.perFile).length > 10, 'el árbol real tiene menciones que contar');
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'controls-from-base.json'), 'utf8'));
  assert.ok(base.controls.some((c) => c.name === 'vocabulary' && c.script === 'scripts/ci/vocabulary.js' && c.rules.includes('scripts/ci/vocabulary.json')), 'en el inventario de controles desde la base, con su regla');
});

test('T8 Vocabulario_PreCommitLoCorre @story-8.154 @ac-1', () => {
  const hook = fs.readFileSync(path.join(ROOT, '.githooks', 'pre-commit-checks'), 'utf8');
  assert.match(hook, /^(?!\s*#).*node "\$VOCABULARY" --repo "\$REPO_ROOT"/m, 'en una línea que corre, no en un comentario');
  const dir = toyRepo({ 'guides/x.md': 'una story\notra story\n' }, { ...TOY, ceiling: { 'guides/x.md': 1 } });
  const r = runHookBlock(dir);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /COMMIT RECHAZADO/);
  // el repo de mantenimiento adelgazado: sus guías propias no se publican y no se miden
  const thin = toyRepo({ '.tycon/internal-forms.json': JSON.stringify({ layout: 'thin' }), 'guides/propia.md': 'el advisor\n' });
  const s = cli(thin, '--skip-thin');
  assert.strictEqual(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /no aplica: las guías las mide el público/);
  assert.ok(!VOC.check({ repo: thin }).ok, 'sin --skip-thin cuenta igual: el archivo solo no apaga el control');
});

test('T11 Vocabulario_NombresDeLaMaquinaQuedan @story-8.154 @ac-2', () => {
  assert.deepStrictEqual(words('Se corre tycon-pipeline, frena ADVISORS-GATE, se instala @tyconsa/harness desde tycon-harness y pasa test-gate.'), []);
  assert.deepStrictEqual(words('story_id, advisors.yaml, corrida-1, harness/x y GATE_X.'), []);
});

test('T12 Vocabulario_ReglasIlegibles_NoMedido @story-8.154 @ac-12', () => {
  for (const [why, rules] of [['rotas', '{ no es json'], ['sin terms', JSON.stringify({ exceptions: [], ceiling: {} })], ['terms vacío', JSON.stringify({ terms: [] })]]) {
    const r = cli(toyRepo({ 'guides/x.md': 'el advisor\n' }, rules));
    assert.strictEqual(r.status, 2, `${why}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /no medido/, why);
  }
  const sin = cli(toyRepo({ 'guides/x.md': 'el advisor\n', 'scripts/ci/vocabulary.json': null }, null));
  assert.strictEqual(sin.status, 2, 'sin reglas no se mide: nunca verde');
  assert.match(sin.stderr, /no medido/);
  // un repo de juguete con el pre-commit del arnés y sin ninguna guía: no hay nada que medir, como tool-names sin
  // integraciones; con una guía y sin reglas, sigue sin medirse
  const vacio = cli(toyRepo({ 'specs/story-1.1.md': 'una story\n', 'scripts/ci/vocabulary.json': null }, null));
  assert.strictEqual(vacio.status, 0, vacio.stdout + vacio.stderr);
  assert.match(vacio.stdout, /nada que medir/);
  // con --repo en una subcarpeta, mide el repo entero: no sale verde con «nada que medir»
  const sub = toyRepo({ 'guides/x.md': 'el advisor\n' });
  const desdeSub = cli(path.join(sub, 'guides'));
  assert.strictEqual(desdeSub.status, 1, desdeSub.stdout + desdeSub.stderr);
  assert.match(desdeSub.stderr, /guides\/x\.md:1/);
});
