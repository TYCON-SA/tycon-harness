'use strict';

/**
 * suite-parts.test.js — una suite que pasa de 45 s se parte SIN mover sus pruebas (story 8.22, tramo F, AC 34).
 *
 * El archivo de la suite queda entero y, corrido a mano, corre todo. Cada parte es un archivo `<suite>.p<k>.test.<js|sh>`
 * de una línea, registrado en suites.json, que carga el entero y corre sólo lo suyo:
 *   · Node (scripts/tests/lib/suite-parts.js): las pruebas se reparten por su duración medida (scripts/tests/suite-parts.json),
 *     la más larga primero y a la parte más liviana;
 *   · consola (scripts/tests/lib/suite-parts.sh): el archivo marca sus bloques con `suite_part <k>`.
 *
 * Lo que no puede pasar, y se mide acá:
 *   · que una prueba no corra en ninguna parte, o corra en dos (el conteo ya no sería el del archivo entero);
 *   · que una parte quede sin registrar, o que el entero siga registrado al lado de sus partes (correría dos veces);
 *   · que la variable con que una parte de consola pide su bloque la herede un proceso hijo (otra suite partida, lanzada
 *     desde adentro, correría un solo bloque sin que nadie lo pida);
 *   · que una parte pese más que el límite, o pierda el criterio con que se elegía el entero.
 *
 * Correr: node --test scripts/tests/suite-parts.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TESTS = path.join(ROOT, 'scripts', 'tests');
const LIB_JS = path.join(TESTS, 'lib', 'suite-parts.js');
const LIB_SH = path.join(TESTS, 'lib', 'suite-parts.sh');
const REGISTRY = path.join(TESTS, 'suite-parts.json');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suite-parts-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const put = (dir, rel, body) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
// sin la variable de quien corre esta prueba: una parte de esta misma suite no puede contagiar a las de juguete
const cleanEnv = () => { const e = { ...process.env }; delete e.SUITE_PART; delete e.NODE_TEST_CONTEXT; return e; };
const node = (file) => spawnSync(process.execPath, [file], { encoding: 'utf8', env: cleanEnv() });
const bash = (file, env = {}) => spawnSync('bash', [file], { encoding: 'utf8', env: { ...cleanEnv(), ...env } });
// las pruebas que corrieron, en orden, leídas de la salida TAP de `node archivo`
const ran = (out) => out.split('\n').map((l) => l.match(/^(?:not )?ok \d+ - (.*?)(?: # .*)?$/)).filter(Boolean).map((m) => m[1]);

// ── T40 · Node ──────────────────────────────────────────────────────────────────────────────────────────────
function nodeLab(parts, seconds) {
  const dir = fs.mkdtempSync(path.join(tmp, 'node-'));
  put(dir, 'lib/suite-parts.js', fs.readFileSync(LIB_JS, 'utf8'));
  put(dir, 'toy.test.js', `'use strict';
const test = require('./lib/suite-parts.js').test;
const assert = require('node:assert');
const fs = require('fs');
test.after(() => fs.appendFileSync(process.env.AFTER_LOG || '/dev/null', 'after\\n'));
for (const name of ['uno', 'dos', 'larga', 'cuatro', 'cinco', 'sin medir', 'siete']) test(name, () => assert.ok(true));
test.skip('salteada a mano', () => assert.fail('no corre'));
`);
  for (let k = 1; k <= parts + 1; k++) put(dir, `toy.p${k}.test.js`, "require('./lib/suite-parts.js').runPart(__filename);\n");
  put(dir, 'suite-parts.json', JSON.stringify({ suites: { 'toy.test.js': { parts, seconds } } }));
  return dir;
}
const TOY_SECONDS = { uno: 1, dos: 1, larga: 10, cuatro: 1, cinco: 1, siete: 1, 'salteada a mano': 1 };
const TOY_ALL = ['uno', 'dos', 'larga', 'cuatro', 'cinco', 'sin medir', 'siete', 'salteada a mano'];

test('T40 SuiteParts_Node_DisjointCompleteAndBalanced — entero corre todo; las partes no se pisan, entre todas corren todo y la más larga queda sola', () => {
  const dir = nodeLab(3, TOY_SECONDS);
  const whole = node(path.join(dir, 'toy.test.js'));
  assert.strictEqual(whole.status, 0, whole.stdout + whole.stderr);
  assert.deepStrictEqual(ran(whole.stdout), TOY_ALL, 'corrido a mano, el archivo entero corre todas, en su orden');
  const byPart = [1, 2, 3].map((k) => {
    const r = node(path.join(dir, `toy.p${k}.test.js`));
    assert.strictEqual(r.status, 0, `parte ${k}: ${r.stdout}${r.stderr}`);
    return ran(r.stdout);
  });
  const all = byPart.flat();
  assert.strictEqual(all.length, TOY_ALL.length, `entre las tres, el mismo número de pruebas que el entero: ${JSON.stringify(byPart)}`);
  assert.deepStrictEqual([...all].sort(), [...TOY_ALL].sort(), 'cada prueba en una parte, y sólo en una');
  for (const [i, names] of byPart.entries()) {
    assert.ok(names.length > 0, `la parte ${i + 1} corre algo`);
    assert.deepStrictEqual(names, TOY_ALL.filter((n) => names.includes(n)), `dentro de la parte ${i + 1}, el orden del archivo`);
  }
  assert.deepStrictEqual(byPart.find((names) => names.includes('larga')), ['larga'], 'la más larga (10 s contra 1 s las demás) queda sola en su parte');
  // la que no tiene duración medida entra con la mediana (1 s): las otras dos partes quedan parejas, 3 s y 4 s
  const others = byPart.filter((names) => !names.includes('larga')).map((names) => names.length).sort();
  assert.deepStrictEqual(others, [3, 4], `las otras siete, repartidas parejo: ${JSON.stringify(byPart)}`);
});

test('T40 — el `after` del archivo corre en cada parte, y `test.skip` cuenta como una prueba más', () => {
  const dir = nodeLab(3, TOY_SECONDS);
  const log = path.join(dir, 'after.log');
  for (const k of [1, 2, 3]) {
    const r = spawnSync(process.execPath, [path.join(dir, `toy.p${k}.test.js`)], { encoding: 'utf8', env: { ...cleanEnv(), AFTER_LOG: log } });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  }
  assert.strictEqual(fs.readFileSync(log, 'utf8'), 'after\nafter\nafter\n');
  const skipped = [1, 2, 3].map((k) => node(path.join(dir, `toy.p${k}.test.js`)).stdout).filter((out) => /ok \d+ - salteada a mano # SKIP/.test(out));
  assert.strictEqual(skipped.length, 1, 'la salteada a mano sale salteada, en una sola parte');
});

test('T40 — una parte que no existe, una suite sin anotar o un archivo de reparto roto salen 2 con el motivo, sin correr nada', () => {
  const dir = nodeLab(3, TOY_SECONDS);
  const beyond = node(path.join(dir, 'toy.p4.test.js'));
  assert.strictEqual(beyond.status, 2, beyond.stdout + beyond.stderr);
  assert.match(beyond.stderr, /toy\.test\.js tiene 3 partes: no hay parte 4/);
  assert.deepStrictEqual(ran(beyond.stdout), [], 'no corre ninguna prueba');
  fs.writeFileSync(path.join(dir, 'suite-parts.json'), JSON.stringify({ suites: {} }));
  const unknown = node(path.join(dir, 'toy.p1.test.js'));
  assert.strictEqual(unknown.status, 2);
  assert.match(unknown.stderr, /toy\.test\.js no figura en .*suite-parts\.json/);
  fs.writeFileSync(path.join(dir, 'suite-parts.json'), '{ "suites": ');
  const broken = node(path.join(dir, 'toy.p1.test.js'));
  assert.strictEqual(broken.status, 2);
  assert.match(broken.stderr, /suite-parts\.json no se deja leer/);
  put(dir, 'otra-cosa.test.js', "require('./lib/suite-parts.js').runPart(__filename);\n");
  const badName = node(path.join(dir, 'otra-cosa.test.js'));
  assert.strictEqual(badName.status, 2);
  assert.match(badName.stderr, /no es una parte \(<suite>\.p<k>\.test\.js\)/);
});

test('T40 — el reparto: la más larga primero y a la parte más liviana; sin ninguna duración, parejo por cantidad', () => {
  const { assign } = require(LIB_JS);
  assert.deepStrictEqual(assign(['a', 'b', 'c', 'd', 'e'], { a: 5, b: 4, c: 3, d: 3, e: 3 }, 2), [0, 1, 1, 0, 1], 'cada una, de la más larga a la más corta, a la parte que va más liviana: 5+3 = 8 contra 4+3+3 = 10');
  assert.deepStrictEqual(assign(['a', 'b', 'c', 'd'], {}, 2), [0, 1, 0, 1], 'sin duraciones, todas pesan lo mismo');
  assert.deepStrictEqual(assign(['a', 'x', 'b'], { a: 2, b: 4 }, 2), [1, 1, 0], 'la sin medir lleva la mediana de las medidas (3 s)');
  assert.deepStrictEqual(assign(['a', 'a', 'b'], { a: 2, b: 9 }, 2), [1, 1, 0], 'dos pruebas con el mismo nombre: cada una es una');
  assert.deepStrictEqual(assign([], {}, 3), []);
});

// ── T41 · consola ───────────────────────────────────────────────────────────────────────────────────────────
function shellLab() {
  const dir = fs.mkdtempSync(path.join(tmp, 'sh-'));
  put(dir, 'lib/suite-parts.sh', fs.readFileSync(LIB_SH, 'utf8'));
  put(dir, 'toy.test.sh', `#!/usr/bin/env bash
set -uo pipefail
. "$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/lib/suite-parts.sh"
suite_parts 3
echo "antes de los bloques"
if suite_part 1; then
echo "ok bloque 1"
bash -c 'echo "hijo: \${SUITE_PART:-sin variable}"'
fi
if suite_part 2; then
echo "ok bloque 2"
fi
if suite_part 3; then
echo "ok bloque 3"
fi
echo "después de los bloques"
`);
  for (const k of [1, 2, 3, 4]) put(dir, `toy.p${k}.test.sh`, `#!/usr/bin/env bash\nSUITE_PART=${k}/3 exec bash "$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/toy.test.sh"\n`);
  return dir;
}
const blocks = (out) => out.split('\n').filter((l) => l.startsWith('ok bloque'));

test('T41 SuiteParts_Shell_BlocksByPart — entera corre los tres bloques; cada parte, el suyo; y el proceso hijo no ve la variable', () => {
  const dir = shellLab();
  const whole = bash(path.join(dir, 'toy.test.sh'));
  assert.strictEqual(whole.status, 0, whole.stdout + whole.stderr);
  assert.deepStrictEqual(blocks(whole.stdout), ['ok bloque 1', 'ok bloque 2', 'ok bloque 3']);
  for (const k of [1, 2, 3]) {
    const r = bash(path.join(dir, `toy.p${k}.test.sh`));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.deepStrictEqual(blocks(r.stdout), [`ok bloque ${k}`], `la parte ${k} corre sólo su bloque`);
    assert.match(r.stdout, /antes de los bloques[\s\S]*después de los bloques/, 'lo de afuera de los bloques corre en todas');
  }
  assert.match(bash(path.join(dir, 'toy.p1.test.sh')).stdout, /hijo: sin variable/, 'lo que la suite lanza no hereda la variable');
});

test('T41 — una parte que no existe, una variable mal escrita o un entero que declara otra cantidad salen 2 con el motivo', () => {
  const dir = shellLab();
  const beyond = bash(path.join(dir, 'toy.p4.test.sh'));
  assert.strictEqual(beyond.status, 2, beyond.stdout + beyond.stderr);
  assert.match(beyond.stderr, /SUITE_PART=4\/3/);
  assert.deepStrictEqual(blocks(beyond.stdout), []);
  // (con un cero adelante el número vale lo mismo y el texto no: antes pasaba la validación, no corría ningún bloque y
  // salía verde — pase adversarial del tramo F)
  for (const bad of ['dos', '0/3', '1/', '/3', '1/3/5', '2/5', '01/3', '1/03', '00/3', '+1/3', ' 1/3']) {
    const r = bash(path.join(dir, 'toy.test.sh'), { SUITE_PART: bad });
    assert.strictEqual(r.status, 2, `SUITE_PART=${bad}: ${r.stdout}${r.stderr}`);
    assert.deepStrictEqual(blocks(r.stdout), [], `SUITE_PART=${bad}: no corre ningún bloque`);
  }
  assert.match(bash(path.join(dir, 'toy.test.sh'), { SUITE_PART: '2/5' }).stderr, /declara 3 partes y le pidieron la 2 de 5/);
});

// ── T42 · las suites partidas de verdad ─────────────────────────────────────────────────────────────────────
const LIST = JSON.parse(fs.readFileSync(path.join(TESTS, 'suites.json'), 'utf8'));
const ENTRIES = [...(LIST.diarias || []), ...(LIST.semanales || [])].filter((e) => e && e.raiz === 'arnes');
const WEIGHTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'suites-weights.json'), 'utf8'));
const HEAVY = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'heavy-suites.json'), 'utf8'));
const OVER = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'suites-over-limit.json'), 'utf8'));
const LIMIT = OVER.limit_seconds;
const realContext = () => ({
  dir: TESTS,
  registry: JSON.parse(fs.readFileSync(REGISTRY, 'utf8')),
  entries: ENTRIES.map((e) => ({ ...e, name: path.basename(e.ruta) })),
  weights: { pr: WEIGHTS.pr.weights, nightly: WEIGHTS.weights },
  heavy: HEAVY.suites,
  limit: LIMIT,
  // las que pasan del límite con una decisión anotada (scripts/ci/suites-over-limit.json): una parte que es un solo paso
  // largo no se puede partir más, y lleva su excepción firmada como cualquier suite
  decided: new Set(Object.keys(OVER.suites || {})),
});

test('T42 — una parte que pasa del límite frena, salvo que lleve su decisión anotada (un solo paso largo no se parte más)', () => {
  const { layoutProblems } = require(LIB_JS);
  const over = (c) => { c.weights.pr['uno.p1.test.js'] = 57; };
  assert.ok(layoutProblems(toyLayout(over)).some((p) => /uno\.p1\.test\.js pesa 57 s: pasa de 45 s/.test(p)), 'sin decisión, frena');
  assert.deepStrictEqual(layoutProblems(toyLayout((c) => { over(c); c.decided = new Set(['uno.p1.test.js']); })), [], 'con su decisión anotada, no');
  assert.ok(layoutProblems(toyLayout((c) => { over(c); c.decided = new Set(['dos.p1.test.sh']); })).some((p) => /uno\.p1\.test\.js pesa 57 s/.test(p)), 'la decisión de otra parte no la cubre');
});

test('T42 SuiteParts_RealSuites_AllPartsRegisteredAndUnderLimit — cada suite partida: sus partes 1 a N registradas, livianas y con el mismo criterio; el entero, sin registrar', () => {
  const { layoutProblems } = require(LIB_JS);
  const ctx = realContext();
  const problems = layoutProblems(ctx);
  assert.deepStrictEqual(problems, [], problems.join('\n'));
  // y el lector de dependencias llega al entero desde cada parte: un cambio en el entero corre sus partes
  const deps = require(path.join(ROOT, 'scripts', 'ci', 'suite-deps.js'));
  const cache = new Map();
  for (const [base, spec] of Object.entries(ctx.registry.suites)) {
    for (let k = 1; k <= spec.parts; k++) {
      const part = base.replace(/\.test\.(js|sh)$/, `.p${k}.test.$1`);
      const d = deps.suiteDeps(ROOT, `scripts/tests/${part}`, cache);
      assert.ok(d.wholeRepo || d.files.has(`scripts/tests/${base}`), `${part}: su código no lleva a scripts/tests/${base}`);
    }
  }
});

// Pase adversarial del tramo F: que el lector LLEGUE al entero no alcanza si el selector no lo usa. Con el selector de
// verdad sobre este repo: un cambio en el archivo entero de cada suite partida corre TODAS sus partes.
test('T42 — con el selector de verdad, editar el archivo entero de cada suite partida corre todas sus partes', () => {
  const skills = require(path.join(ROOT, 'scripts', 'lib', 'skills-dir.js')).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR || '').skills;
  if (!fs.existsSync(path.join(skills, 'tycon-pipeline', 'scripts', 'lib', 'touched-files.js'))) return;   // sin la regla del portón el selector corre todo: no mide nada
  const { partitioned } = require(LIB_JS);
  const photo = path.join(tmp, 'photo.json');
  fs.writeFileSync(photo, JSON.stringify({ kind: 'bash-tests', ts: new Date().toISOString(), complete: true, failures: [] }));
  // UNA corrida del selector con todos los archivos enteros en el cambio: «lo propio» se mira parte por parte, así que
  // alcanza. Con una corrida por suite, esta prueba sola tardaba 129 s en el agente de la validación (#12355).
  const all = [...partitioned(TESTS)];
  const list = path.join(tmp, 'changed.txt');
  fs.writeFileSync(list, all.map(([base]) => `scripts/tests/${base}\n`).join(''));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'suites-for-change.js'), '--suites', path.join(TESTS, 'suites.json'), '--scripts', path.join(ROOT, 'scripts'),
    '--changed', list, '--changed-with-docs', list, '--deps', '--nightly', photo, '--heavy', path.join(ROOT, 'scripts', 'ci', 'heavy-suites.json'),
    '--over-limit', path.join(ROOT, 'scripts', 'ci', 'suites-over-limit.json')], { encoding: 'utf8', env: cleanEnv() });
  assert.strictEqual(r.status, 0, r.stderr);
  const run = new Set(r.stdout.split('\n').filter((l) => l.startsWith('RUN\t')).map((l) => path.basename(l.slice(4))));
  assert.ok(all.length > 0, 'el reparto de verdad trae suites partidas: sin ninguna, esta prueba no mide nada');
  for (const [base, parts] of all) {
    const missing = Array.from({ length: parts }, (_, i) => base.replace(/\.test\.(js|sh)$/, `.p${i + 1}.test.$1`)).filter((p) => !run.has(p));
    assert.deepStrictEqual(missing, [], `${base}: editarlo no corre estas partes\n${r.stdout.split('\n').filter((l) => l.includes(base.replace(/\.test\..*/, '.p'))).join('\n')}`);
  }
});

function toyLayout(mutate) {
  const dir = fs.mkdtempSync(path.join(tmp, 'layout-'));
  put(dir, 'lib/suite-parts.js', fs.readFileSync(LIB_JS, 'utf8'));
  put(dir, 'lib/suite-parts.sh', fs.readFileSync(LIB_SH, 'utf8'));
  put(dir, 'uno.test.js', "const test = require('./lib/suite-parts.js').test;\ntest('a', () => {});\ntest('b', () => {});\n");
  put(dir, 'dos.test.sh', '. "$DIR/lib/suite-parts.sh"\nsuite_parts 2\nif suite_part 1; then echo a; fi\nif suite_part 2; then echo b; fi\n');
  for (const k of [1, 2]) {
    put(dir, `uno.p${k}.test.js`, "require('./lib/suite-parts.js').runPart(__filename);\n");
    put(dir, `dos.p${k}.test.sh`, `#!/usr/bin/env bash\n# parte ${k} de 2 de scripts/tests/dos.test.sh\nSUITE_PART=${k}/2 exec bash "$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/dos.test.sh"\n`);
  }
  const parts = ['uno.p1.test.js', 'uno.p2.test.js', 'dos.p1.test.sh', 'dos.p2.test.sh'];
  const ctx = {
    dir,
    registry: { suites: { 'uno.test.js': { parts: 2, seconds: { a: 1, b: 1 } } } },   // la de consola dice sus partes en su archivo
    entries: parts.map((name) => ({ name, raiz: 'arnes', ruta: `tests/${name}`, requiere: [] })),
    weights: { pr: Object.fromEntries(parts.map((p) => [p, 20])), nightly: Object.fromEntries(parts.map((p) => [p, 25])) },
    heavy: {},
    limit: 45,
  };
  if (mutate) mutate(ctx, dir);
  return ctx;
}

test('T42 — el reparto de juguete bien armado no tiene problemas', () => {
  const { layoutProblems } = require(LIB_JS);
  assert.deepStrictEqual(layoutProblems(toyLayout()), []);
});

test('T42 — rojo previo: una parte sin registrar, el entero registrado junto a sus partes, una parte de más o de menos', () => {
  const { layoutProblems } = require(LIB_JS);
  const cases = [
    ['una parte sin registrar', (c) => { c.entries = c.entries.filter((e) => e.name !== 'uno.p2.test.js'); }, /uno\.p2\.test\.js no está en suites\.json/],
    ['el entero registrado', (c) => { c.entries.push({ name: 'uno.test.js', raiz: 'arnes', ruta: 'tests/uno.test.js', requiere: [] }); }, /uno\.test\.js está partida y sigue en suites\.json/],
    ['falta el archivo de una parte', (c, d) => fs.rmSync(path.join(d, 'dos.p2.test.sh')), /dos\.p2\.test\.sh no existe/],
    ['un archivo de parte de más', (c, d) => put(d, 'uno.p3.test.js', "require('./lib/suite-parts.js').runPart(__filename);\n"), /uno\.p3\.test\.js sobra: uno\.test\.js tiene 2 partes/],
    ['una parte de una suite que no está anotada', (c, d) => put(d, 'tres.p1.test.js', "require('./lib/suite-parts.js').runPart(__filename);\n"), /tres\.p1\.test\.js es una parte de tres\.test\.js, que no figura/],
    ['el entero no existe', (c, d) => fs.rmSync(path.join(d, 'uno.test.js')), /uno\.test\.js figura como partida y no existe/],
    ['menos de dos partes', (c) => { c.registry.suites['uno.test.js'].parts = 1; }, /uno\.test\.js: «parts» tiene que ser un entero de 2 o más/],
  ];
  for (const [what, mutate, expected] of cases) {
    const problems = layoutProblems(toyLayout(mutate));
    assert.ok(problems.some((p) => expected.test(p)), `${what}: esperaba ${expected}, salió:\n${problems.join('\n') || '(nada)'}`);
  }
});

test('T42 — rojo previo: una parte pesada de más o sin peso, y partes con distinto criterio', () => {
  const { layoutProblems } = require(LIB_JS);
  const cases = [
    ['una parte pasa del límite', (c) => { c.weights.pr['uno.p1.test.js'] = 46; }, /uno\.p1\.test\.js pesa 46 s: pasa de 45 s/],
    ['una parte sin peso en la validación', (c) => { delete c.weights.pr['dos.p2.test.sh']; }, /dos\.p2\.test\.sh no tiene peso en el juego de la validación/],
    ['una parte sin peso en el nocturno', (c) => { delete c.weights.nightly['dos.p2.test.sh']; }, /dos\.p2\.test\.sh no tiene peso en el juego del nocturno/],
    ['el entero conserva su peso', (c) => { c.weights.pr['uno.test.js'] = 90; }, /uno\.test\.js está partida y conserva su peso/],
    ['una parte con otro gate', (c) => { c.entries[0].gate_only_when_touching = ['scripts/lib/**']; }, /las partes de uno\.test\.js no llevan el mismo criterio en suites\.json/],
    ['una parte con otro requiere', (c) => { c.entries[2].requiere = ['red']; }, /las partes de dos\.test\.sh no llevan el mismo criterio en suites\.json/],
    ['pesada en una parte sola', (c) => { c.heavy['dos.p1.test.sh'] = { patterns: ['scripts/setup/**'] }; }, /las partes de dos\.test\.sh no llevan el mismo criterio en heavy-suites\.json/],
    ['el entero sigue como pesada', (c) => { c.heavy['dos.test.sh'] = { patterns: ['scripts/setup/**'] }; }, /dos\.test\.sh está partida y sigue en heavy-suites\.json/],
  ];
  for (const [what, mutate, expected] of cases) {
    const problems = layoutProblems(toyLayout(mutate));
    assert.ok(problems.some((p) => expected.test(p)), `${what}: esperaba ${expected}, salió:\n${problems.join('\n') || '(nada)'}`);
  }
});

test('T42 — rojo previo: un entero que no usa la biblioteca, una parte que no es la línea de siempre, y bloques que no son 1 a N', () => {
  const { layoutProblems } = require(LIB_JS);
  const cases = [
    ['el entero de Node con el test de node', (c, d) => put(d, 'uno.test.js', "const test = require('node:test');\ntest('a', () => {});\n"), /uno\.test\.js no toma `test` de lib\/suite-parts\.js/],
    ['una parte de Node con otra cosa adentro', (c, d) => put(d, 'uno.p1.test.js', "require('./uno.test.js');\n"), /uno\.p1\.test\.js no es la línea de una parte/],
    ['el entero de consola dejó de declarar sus partes', (c, d) => put(d, 'dos.test.sh', 'echo a\n'), /dos\.p1\.test\.sh es una parte de dos\.test\.sh, que no declara sus partes/],
    ['el entero de consola declara sus partes sin cargar la biblioteca', (c, d) => put(d, 'dos.test.sh', 'suite_parts 2\nif suite_part 1; then echo a; fi\nif suite_part 2; then echo b; fi\n'), /dos\.test\.sh no carga lib\/suite-parts\.sh/],
    ['el entero de consola declara una parte de más', (c, d) => put(d, 'dos.test.sh', '. "$DIR/lib/suite-parts.sh"\nsuite_parts 3\nif suite_part 1; then echo a; fi\nif suite_part 2; then echo b; fi\n'), /dos\.p3\.test\.sh no existe/],
    ['una de consola anotada en el registro', (c) => { c.registry.suites['dos.test.sh'] = { parts: 2 }; }, /dos\.test\.sh: en suite-parts\.json van sólo las de Node/],
    ['falta un bloque', (c, d) => put(d, 'dos.test.sh', '. "$DIR/lib/suite-parts.sh"\nsuite_parts 2\nif suite_part 1; then echo a; fi\n'), /dos\.test\.sh no tiene ningún bloque de la parte 2/],
    ['un bloque de una parte que no hay', (c, d) => put(d, 'dos.test.sh', '. "$DIR/lib/suite-parts.sh"\nsuite_parts 2\nif suite_part 1; then echo a; fi\nif suite_part 2; then echo b; fi\nif suite_part 3; then echo c; fi\n'), /dos\.test\.sh tiene un bloque de la parte 3 y sus partes son 2/],
    ['una parte de consola que pide otra cosa', (c, d) => put(d, 'dos.p1.test.sh', '#!/usr/bin/env bash\nSUITE_PART=2/2 exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dos.test.sh"\n'), /dos\.p1\.test\.sh no es la línea de una parte/],
  ];
  for (const [what, mutate, expected] of cases) {
    const problems = layoutProblems(toyLayout(mutate));
    assert.ok(problems.some((p) => expected.test(p)), `${what}: esperaba ${expected}, salió:\n${problems.join('\n') || '(nada)'}`);
  }
});

// ── Revisores del tramo F (fallos silenciosos, vuelta 1): lo que rompía «cada prueba en una parte, y sólo en una» sin
// que nadie se enterara ───────────────────────────────────────────────────────────────────────────────────────────
function lateLab() {
  const dir = fs.mkdtempSync(path.join(tmp, 'late-'));
  put(dir, 'lib/suite-parts.js', fs.readFileSync(LIB_JS, 'utf8'));
  put(dir, 'toy.test.js', `'use strict';
const test = require('./lib/suite-parts.js').test;
test('uno', () => {});
test('dos', () => {});
Promise.resolve().then(() => test('tardía', () => {}));
`);
  for (const k of [1, 2]) put(dir, `toy.p${k}.test.js`, "require('./lib/suite-parts.js').runPart(__filename);\n");
  put(dir, 'suite-parts.json', JSON.stringify({ suites: { 'toy.test.js': { parts: 2, seconds: {} } } }));
  return dir;
}

test('T40 — una prueba registrada DESPUÉS de cargar el archivo no se puede repartir: cada parte sale roja y dice cuál fue', () => {
  const dir = lateLab();
  const whole = node(path.join(dir, 'toy.test.js'));
  assert.strictEqual(whole.status, 0, 'entero corre como siempre, también la tardía');
  assert.deepStrictEqual(ran(whole.stdout).sort(), ['dos', 'tardía', 'uno']);
  for (const k of [1, 2]) {
    const r = node(path.join(dir, `toy.p${k}.test.js`));
    assert.notStrictEqual(r.status, 0, `parte ${k}: antes corría la tardía en las dos partes y salía verde\n${r.stdout}`);
    assert.match(r.stdout + r.stderr, /«tardía» se registró después de cargar toy\.test\.js: una prueba así no se puede repartir/, `parte ${k}`);
  }
});

test('T40 — más partes que pruebas: la parte que no recibe ninguna sale 2 y lo dice, en vez de un verde con cero pruebas', () => {
  const dir = lateLab();
  put(dir, 'toy.test.js', "'use strict';\nconst test = require('./lib/suite-parts.js').test;\ntest('uno', () => {});\ntest('dos', () => {});\n");
  put(dir, 'toy.p3.test.js', "require('./lib/suite-parts.js').runPart(__filename);\n");
  put(dir, 'suite-parts.json', JSON.stringify({ suites: { 'toy.test.js': { parts: 3, seconds: {} } } }));
  const empty = node(path.join(dir, 'toy.p3.test.js'));
  assert.strictEqual(empty.status, 2, empty.stdout + empty.stderr);
  assert.match(empty.stderr, /la parte 3 de toy\.test\.js no recibió ninguna prueba \(2 pruebas para 3 partes\)/);
  assert.deepStrictEqual(ran(empty.stdout), []);
  assert.deepStrictEqual(ran(node(path.join(dir, 'toy.p1.test.js')).stdout), ['uno'], 'las partes que sí reciben corren lo suyo');
  // y un archivo que no registra ninguna prueba al cargarse
  put(dir, 'toy.test.js', "'use strict';\nrequire('./lib/suite-parts.js');\n");
  const none = node(path.join(dir, 'toy.p1.test.js'));
  assert.strictEqual(none.status, 2, none.stdout + none.stderr);
  assert.match(none.stderr, /la parte 1 de toy\.test\.js no recibió ninguna prueba \(0 pruebas para 3 partes\)/);
});

const CAN_LOCK = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);
test('T42 — un archivo que existe y no se deja leer no se da por «no existe» ni por «no está partida»: se dice el motivo', { skip: !CAN_LOCK && 'NO MEDIDO — sin permisos que quitar (Windows o root)' }, () => {
  const { layoutProblems, partitioned } = require(LIB_JS);
  // una parte ilegible
  let ctx = toyLayout((c, d) => fs.chmodSync(path.join(d, 'uno.p1.test.js'), 0o000));
  let problems = layoutProblems(ctx);
  assert.ok(problems.some((p) => /uno\.p1\.test\.js no se deja leer \(EACCES\)/.test(p)), problems.join('\n'));
  assert.ok(!problems.some((p) => /uno\.p1\.test\.js no existe/.test(p)), 'no se confunde con que falte');
  fs.chmodSync(path.join(ctx.dir, 'uno.p1.test.js'), 0o644);
  // una suite de consola ilegible: no se sabe si declara partes
  ctx = toyLayout((c, d) => fs.chmodSync(path.join(d, 'dos.test.sh'), 0o000));
  problems = layoutProblems(ctx);
  assert.ok(problems.some((p) => /dos\.test\.sh no se deja leer \(EACCES\): no sé si corre por partes/.test(p)), problems.join('\n'));
  put(ctx.dir, 'suite-parts.json', JSON.stringify(ctx.registry));
  assert.throws(() => partitioned(ctx.dir), /dos\.test\.sh no se deja leer \(EACCES\)/, 'la regla de registro tampoco la da por «no partida»');
  fs.chmodSync(path.join(ctx.dir, 'dos.test.sh'), 0o644);
});

// Revisor de cobertura (vuelta 1): `test.todo` y `test.only` también se reparten, como `test.skip`.
test('T40 — `test.todo` y `test.only` se reparten como cualquier prueba: cada una en una sola parte, con su marca', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'kinds-'));
  put(dir, 'lib/suite-parts.js', fs.readFileSync(LIB_JS, 'utf8'));
  put(dir, 'toy.test.js', `'use strict';
const test = require('./lib/suite-parts.js').test;
test('común', () => {});
test.todo('pendiente');
test.only('sola', () => {});
test.skip('salteada', () => { throw new Error('no corre'); });
`);
  for (const k of [1, 2]) put(dir, `toy.p${k}.test.js`, "require('./lib/suite-parts.js').runPart(__filename);\n");
  put(dir, 'suite-parts.json', JSON.stringify({ suites: { 'toy.test.js': { parts: 2, seconds: {} } } }));
  const outs = [1, 2].map((k) => { const r = node(path.join(dir, `toy.p${k}.test.js`)); assert.strictEqual(r.status, 0, r.stdout + r.stderr); return r.stdout; });
  const names = outs.flatMap(ran);
  assert.deepStrictEqual([...names].sort(), ['común', 'pendiente', 'salteada', 'sola'], `cada una en una parte, y sólo en una: ${JSON.stringify(outs.map(ran))}`);
  const all = outs.join('\n');
  assert.match(all, /ok \d+ - pendiente # TODO/, 'la pendiente sale como pendiente');
  assert.match(all, /ok \d+ - salteada # SKIP/, 'la salteada sale como salteada');
  assert.strictEqual((all.match(/ok \d+ - sola/g) || []).length, 1, 'la marcada `only` corre una vez');
});

// ── Pase adversarial del tramo F (5b): lo menor de las dos bibliotecas ──────────────────────────────────────────────
test('T40 — en una parte, `test()` devuelve algo que se puede encadenar, como el de node: una suite que hace `test(…).then(…)` no revienta al cargar', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'chain-'));
  put(dir, 'lib/suite-parts.js', fs.readFileSync(LIB_JS, 'utf8'));
  put(dir, 'toy.test.js', "'use strict';\nconst test = require('./lib/suite-parts.js').test;\ntest('uno', () => {}).then(() => {}).catch(() => {}).finally(() => {});\ntest('dos', () => {});\n");
  for (const k of [1, 2]) put(dir, `toy.p${k}.test.js`, "require('./lib/suite-parts.js').runPart(__filename);\n");
  put(dir, 'suite-parts.json', JSON.stringify({ suites: { 'toy.test.js': { parts: 2, seconds: {} } } }));
  const outs = [1, 2].map((k) => { const r = node(path.join(dir, `toy.p${k}.test.js`)); assert.strictEqual(r.status, 0, `parte ${k}: ${r.stdout}${r.stderr}`); return ran(r.stdout); });
  assert.deepStrictEqual(outs.flat().sort(), ['dos', 'uno']);
});

test('T40 — una duración de suite-parts.json que no es de ninguna prueba del archivo se avisa (un nombre que cambió reparte con la mediana)', () => {
  const dir = nodeLab(3, { ...TOY_SECONDS, 'una que ya no existe': 9, 'otra vieja': 2 });
  const r = node(path.join(dir, 'toy.p1.test.js'));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /2 duraciones de .*suite-parts\.json no son de ninguna prueba de toy\.test\.js: «una que ya no existe», «otra vieja»/);
  assert.doesNotMatch(node(path.join(nodeLab(3, TOY_SECONDS), 'toy.p1.test.js')).stderr, /no son de ninguna prueba/, 'sin claves de más, calla');
});

test('T42 — una suite de consola que declara sus partes con un comentario al final de la línea sigue contando como partida', () => {
  const { layoutProblems, partitioned } = require(LIB_JS);
  const ctx = toyLayout((c, d) => put(d, 'dos.test.sh', '. "$DIR/lib/suite-parts.sh"\nsuite_parts 2   # dos mitades\nif suite_part 1; then echo a; fi\nif suite_part 2; then echo b; fi\n'));
  assert.deepStrictEqual(layoutProblems(ctx), []);
  put(ctx.dir, 'suite-parts.json', JSON.stringify(ctx.registry));
  assert.strictEqual(partitioned(ctx.dir).get('dos.test.sh'), 2);
});

test('T42 — ninguna duración del reparto de verdad difiere del nombre de su prueba sólo en las barras (un nombre mal copiado reparte con la mediana)', () => {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const flat = (x) => x.replace(/\\/g, '');
  for (const [base, spec] of Object.entries(registry.suites)) {
    const text = fs.readFileSync(path.join(TESTS, base), 'utf8');
    // los nombres escritos tal cual en el archivo (los armados con variables no se pueden mirar sin cargarlo)
    const literal = [...text.matchAll(/^test(?:\.(?:skip|todo|only))?\((['"`])((?:\\.|(?!\1).)*)\1/gm)].map((m) => m[2].replace(/\\(.)/g, '$1'));
    const exact = new Set(literal);
    const almost = Object.keys(spec.seconds || {}).filter((k) => !exact.has(k) && literal.some((name) => flat(name) === flat(k)));
    assert.deepStrictEqual(almost, [], `${base}: estas claves de suite-parts.json son de una prueba que existe, con las barras mal`);
  }
});
