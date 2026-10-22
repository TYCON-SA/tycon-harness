#!/usr/bin/env node
/**
 * unit.test.js — suite node:test de la capa determinista del harness TYCON.
 *
 * Cubre las funciones más evadibles o sutiles (isGitCommit, matchGlob, advisorsRunSinceStart, parsers de story) y
 * corre solo: con `node --test` (0 deps), cableada a install-tycon-hooks.sh (SessionStart, <2s). Una regresión en la
 * capa determinista se detecta el mismo día, no en la próxima auditoría.
 *
 * Correr: node --test ~/.claude/agent-skills/skills/tycon-pipeline/scripts/tests/unit.test.js
 */

// Estas pruebas llaman a los hooks del cierre con el HOME real (y el instalador las corre en
// cada arranque). Sin esto, sus decisiones de mentira se anotarían en ~/.claude/.tycon-pipeline/frenos.jsonl, que
// sube al buzón y alimenta la métrica «evidencias rechazadas por los hooks del cierre» del tablero.
process.env.TYCON_CLOSURE_RECORD = 'off';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

// Un repo sin `packs:` activa los paquetes que diga `packs.default` (afuera, sin perfil: ninguno).
// Esta suite corre el pipeline con una HOME aislada y cuenta con «todos los instalados»: lo declara.
process.env.TYCON_PACKS_DEFAULT = (process.env.TYCON_PACKS_DEFAULT || '').trim() || 'all';   // recortada, como el cargador
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const { isGitCommit, parseAcsFromSpec } = require(path.join(SCRIPTS, 'on-pre-commit.js'));
const { matchGlob, advisorAffectedByDelta, buildStoryDigest, parseFrontmatterList, computeRiskClass,
  computeDepGate, writeFollowups, computeFollowupsStatus, parseFollowupsSection,
  computeDeepReviewGate, findRepoRootsForStory, computePreflightFrontmatter, computeModelHint,
  computeToolingExpected, writeFindings, computeFindingsStatus, resolveRunDir,
  computeGitignoreNeeds,
  normalizeFindingRecord } = require(path.join(SCRIPTS, 'pipeline.js'));
const checks = require(path.join(SCRIPTS, 'lib', 'story-checks.js'));

// ── isGitCommit — corpus de detección + evasión ──────────────────────────────
test('isGitCommit detecta commits directos y variantes', () => {
  const POSITIVE = [
    'git commit -m "x"',
    'git commit -F /tmp/msg',
    'git -C /repo commit -m x',
    'git -c user.email=a@b commit',
    'cd /repo && git commit -m x',
    'ENV=val git commit -m x',
    'FOO="bar baz" git commit',
    '$(git commit -m x)',
    '( git commit -m x )',
    'bash -c "git commit -m x"',          // wrapper de shell
    "sh -c 'git commit --amend'",
    'zsh -c "cd /x && git commit -m y"',
    '/usr/bin/git commit -m x',
    'true; git commit -m x',
    'echo hi | git commit -F -',
  ];
  for (const cmd of POSITIVE) {
    assert.equal(isGitCommit(cmd), true, `debería detectar: ${cmd}`);
  }
});

test('isGitCommit NO da falsos positivos', () => {
  const NEGATIVE = [
    'git log --grep=commit',
    'git status',
    'echo "git commit"',
    'git diff HEAD',
    'npm test -- commit',
    'git commitish-tool',          // comando que arranca igual pero no es commit
    'cat docs/git-commit-conventions.md',
    'git show --stat',
  ];
  for (const cmd of NEGATIVE) {
    assert.equal(isGitCommit(cmd), false, `NO debería detectar: ${cmd}`);
  }
});

// ── matchGlob — globs vs paths ────────────────────────────────────────────────
test('matchGlob casos núcleo', () => {
  const CASES = [
    ['Services/Foo.cs', '**/*.cs', true],
    ['Foo.cs', '**/*.cs', true],
    ['a/b/c/Foo.cs', '**/*.cs', true],
    ['Foo.ts', '**/*.cs', false],
    ['tests/e2e/x.spec.ts', '**/tests/e2e/**/*.spec.ts', true],
    ['src/tests/e2e/deep/x.spec.ts', '**/tests/e2e/**/*.spec.ts', true],
    ['src/Hubs/ChatHub.cs', '**/Hubs/*.cs', true],
    ['src/NotHubs/ChatHub.cs', '**/Hubs/*.cs', false],
    ['x/lib/llm/client.ts', '**/lib/llm/**', true],
    ['foo.test.ts', '**/*.test.ts', true],
    ['src/a.tsx', '**/*.{ts,tsx}', true],
    ['bar.cs', '*.cs', true], // pattern sin / matchea basename
  ];
  for (const [f, p, expected] of CASES) {
    assert.equal(matchGlob(f, p), expected, `matchGlob('${f}', '${p}') esperaba ${expected}`);
  }
});

test('advisorAffectedByDelta respeta excludePaths y always', () => {
  // silent-failure-hunter excluye tests → delta solo-tests = NO afectado.
  const r1 = advisorAffectedByDelta('tycon-silent-failure-hunter', ['src/__tests__/a.test.ts']);
  assert.equal(r1.affected, false, 'delta solo-tests no toca surface del hunter');
  const r2 = advisorAffectedByDelta('tycon-silent-failure-hunter', ['src/Service.cs']);
  assert.equal(r2.affected, true);
  const r3 = advisorAffectedByDelta('tycon-story-validator', []);
  assert.equal(r3.affected, true, 'always:true re-corre aunque el delta sea vacío');
  const r4 = advisorAffectedByDelta('advisor-inexistente', ['x.cs']);
  assert.equal(r4.affected, true, 'sin surface declarada → rerun conservador');
});

// ── advisorsRunSinceStart — los 3 estados del log (CF-2) ─────────────────────
test('advisorsRunSinceStart: sin log / step5-start solo / completo', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-test-'));
  const runsDir = path.join(tmpHome, '.claude', '.tycon-pipeline', 'advisor-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const sid = 'unittest-session';
  const logPath = path.join(runsDir, `${sid}.jsonl`);

  // Cargar pipeline.js con HOME + SID controlados (el módulo resuelve paths al cargar).
  const prevHome = process.env.HOME;
  const prevSid = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.HOME = tmpHome;
  process.env.CLAUDE_CODE_SESSION_ID = sid;
  delete require.cache[require.resolve(path.join(SCRIPTS, 'pipeline.js'))];
  const pl = require(path.join(SCRIPTS, 'pipeline.js'));
  try {
    // Estado 1: sin log
    let s = pl.advisorsRunSinceStart();
    assert.equal(s.sawStart, false);
    assert.deepEqual(s.ran, []);

    // Estado 2: step5-start con expected, CERO spawns → fail-closed en check-count
    fs.writeFileSync(logPath, JSON.stringify({ ts: 'x', event: 'step5-start', expected: ['a', 'b'] }) + '\n');
    s = pl.advisorsRunSinceStart();
    assert.equal(s.sawStart, true);
    assert.deepEqual(s.expected, ['a', 'b']);
    assert.deepEqual(s.ran, [], 'cero spawns debe reportarse como ran=[] (NO null/fallback)');

    // Estado 3: completo
    fs.appendFileSync(logPath, JSON.stringify({ ts: 'x', advisor: 'a' }) + '\n' + JSON.stringify({ ts: 'x', advisor: 'b' }) + '\n');
    s = pl.advisorsRunSinceStart();
    assert.deepEqual(s.ran.sort(), ['a', 'b']);
  } finally {
    process.env.HOME = prevHome;
    if (prevSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prevSid;
    delete require.cache[require.resolve(path.join(SCRIPTS, 'pipeline.js'))];
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ── Superficie auditada por advisor (advisorAffectedByDelta) ─────────────────
// Un `.js` de producción despierta a los advisors de código; un test `.js`/`.sh` no. Los dos
// casos van juntos a propósito: el primero evita que los re-loops salteen al cazador cuando su propio fix es un `.js`;
// el segundo impide cerrarlo con `**/*`, que convertiría cada test agregado en superficie de fallos silenciosos.
test('superficie: un .js de producción despierta a security-basics y al cazador de fallos silenciosos', () => {
  for (const advisor of ['tycon-plugin-security-basics', 'tycon-silent-failure-hunter']) {
    const r = advisorAffectedByDelta(advisor, ['/repo/scripts/metrics/medidor.js']);
    assert.equal(r.affected, true, `${advisor} se saltearía con un .js en el delta: ${r.reason}`);
  }
  assert.equal(advisorAffectedByDelta('tycon-silent-failure-hunter', ['/repo/lib/a.mjs']).affected, true);
});

test('superficie: un test .js o una suite .sh NO despiertan al cazador de fallos silenciosos', () => {
  for (const f of ['/repo/tests/medidor.test.js', '/repo/scripts/tests/medidor.test.sh', '/repo/src/__tests__/x.js']) {
    const r = advisorAffectedByDelta('tycon-silent-failure-hunter', [f]);
    assert.equal(r.affected, false, `un test no es superficie de fallos silenciosos: ${f} → ${r.reason}`);
  }
});

// ── Parsers de story (lib/story-checks.js) ────────────────────────────────────
const SAMPLE_STORY = `---
story: "9.9"
status: ready-for-dev
files_to_modify:
  - src/Foo.cs
  - src/Bar.cs
pipelines:
  A-backend:
    status: done
  B-frontend:
    status: pending
    tests_pending:
      - "E2E flujo completo"
---
## Acceptance Criteria

1. **Given** una orden, **When** avanza, **Then** queda en cola.
2. **Given** otra cosa, **When** pasa, **Then** resulta.

### Tests

| T-ID | Test | AC | Nivel | Resultado |
|------|------|----|-------|-----------|
| T1 | Avanza la orden | 1 | unit | cola contiene orden |
| T2 | Otra cosa pasa | 2 | integration | resultado ok |
`;

test('parseAcsFromSpec extrae ACs canónicos', () => {
  assert.deepEqual(checks.parseAcsFromSpec(SAMPLE_STORY), [1, 2]);
  // El parser legacy de on-pre-commit devuelve formato '#N' — mantener contrato.
  assert.deepEqual(parseAcsFromSpec(SAMPLE_STORY), ['#1', '#2']);
});

// El waiver runtime muestra qué dice el AC, además de la RAZÓN por la que no se puede correr y el test que lo cubre:
// sin eso, el usuario firma sobre algo sin nombre.
test('acTextsFromSpec cita el texto de cada AC para el prompt del waiver', () => {
  const t = checks.acTextsFromSpec(SAMPLE_STORY);
  assert.equal(t[1], 'Given una orden, When avanza, Then queda en cola.', 'AC1 citado y sin markdown');
  assert.equal(t[2], 'Given otra cosa, When pasa, Then resulta.');
  // La tabla de Tests NO se traga dentro del último AC (el heading la corta).
  assert.ok(!/T-ID/.test(t[2]), 'la tabla de Tests no contamina el texto del AC');

  // Estilo heading + blockquote + bloque de código: se cita la prosa, no el ruido.
  const conHeadings = `## Acceptance Criteria

### AC-1: el gate bloquea

**Given** un \`marker\` en rojo, **When** el turno termina, **Then** NO deja cerrar.

> Nota lateral: esto se decidió el 2026-01-01 y no se toca acá.

\`\`\`js
const x = 1;
\`\`\`

### AC-2: el escape queda logueado

**Given** el flag, **When** se usa, **Then** entra en \`bypass.log\`.
`;
  const th = checks.acTextsFromSpec(conHeadings);
  assert.match(th[1], /^el gate bloquea Given un marker en rojo/, 'toma el título del heading + la prosa');
  assert.ok(!/Nota lateral/.test(th[1]), 'el blockquote no entra');
  assert.ok(!/const x/.test(th[1]), 'el bloque de código no entra');
  assert.match(th[2], /el escape queda logueado/);

  // Tope de largo: un AC kilométrico no rompe el prompt de la terminal.
  const largo = `## Acceptance Criteria\n\n1. **Given** ${'x'.repeat(2000)}, **Then** algo.\n`;
  const tl = checks.acTextsFromSpec(largo, { maxChars: 120 });
  assert.ok(tl[1].length <= 120, `recorta a maxChars (fue ${tl[1].length})`);
  assert.match(tl[1], /…$/, 'y avisa que recortó');

  // Best-effort: sin sección de ACs devuelve {} y el llamador cae a su texto de siempre.
  assert.deepEqual(checks.acTextsFromSpec('# Story sin ACs\n\ntexto suelto\n'), {});
  assert.deepEqual(checks.acTextsFromSpec(''), {});
});

test('parseAcsFromSpec: headings ### AC-N autoritativos, sin fantasmas de sub-items (caso R-9 FRESNO)', () => {
  const headingStory = `## Acceptance Criteria

### AC-1 — Alta del cupón

**Given** el panel, **When** se guarda un cupón, **Then**:
1. El código queda en \`MAYÚSCULAS\`.
2. Un código repetido se rechaza.

### AC-2 — Validación del código

**Given** un carrito, **When** se aplica un código, **Then**:
1. Se normaliza antes de buscar.
6. **Actualizar el texto de ayuda** — sub-item numerado con bold que NO es un AC.

### Tests

| # | Test | AC | Nivel |
|---|------|----|-------|
| T1 | Alta_CodigoRepetido | 1 | integration |
| T4 | Aplicar_FormatoInvalido | 2.6 | unit |
`;
  // Sin el fix: universo [6] (fantasma del sub-item bold) en vez de [1,2].
  assert.deepEqual(checks.parseAcsFromSpec(headingStory), [1, 2],
    'headings AC-N son autoritativos; sub-items numerados (con o sin bold) no cuentan');
  const t = checks.parseTestsTable(headingStory);
  assert.deepEqual(t.rows.find((r) => r.tid === 'T4').acRefs, [2],
    'notación sub-AC N.M en columna AC dedicada resuelve al AC padre N (antes: [])');
});

// ── Regresión del subconteo de ACs, con la FORMA de stories reales ───────────
// Los nueve fixtures son stories de ejemplo inventadas (una tienda genérica: pedidos, remitos,
// bolsas), escritas para esta prueba y editadas en su archivo: nada las regenera (ver tests/fixtures/regen.js).
// Conservan sólo la forma que se mide —prefijos de renglón, títulos, numeración, la tabla de pruebas—, fijada en
// tests/fixtures/stories-shape.json.
// Cada uno cubre un modo de falla del parser: subcontar los ACs, o callarse del todo.
const FIX = path.join(__dirname, 'fixtures', 'stories');
const readFix = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');

const CORPUS_REAL = [
  // archivo                                        acs  modo de falla que cubre
  ['ac-4-21-headings-de-grupo-42-numerados.md', 42, 'headings de GRUPO + 42 numerados: daba 11, con 31 ACs invisibles'],
  ['ac-4-8-numerados-estilos-mezclados.md', 13, 'mezcla `N. **Given**` con numerado pelado: daba 11 de 13'],
  ['ac-4-9-numerados-estilos-mezclados.md', 8, 'idem: daba 6 de 8'],
  ['ac-4-10-numerados-estilos-mezclados.md', 6, 'idem: daba 4 de 6'],
  ['ac-1-4-numerados-estilos-mezclados.md', 7, 'idem: daba 6 de 7'],
  ['ac-r9-headings-autoritativos-subitems.md', 8, 'ANTI-REGRESIÓN del fix 2026-07-10: numeración REINICIA bajo cada heading ⇒ mandan los headings'],
  ['ac-5-2-headings-con-subitems-de-uno-solo.md', 6, 'sub-items de UN SOLO heading también forman corrida creciente ⇒ no alcanza con "es una corrida"'],
  ['ac-4-6-literal-citado-en-frontmatter.md', 6, 'el literal `## Acceptance Criteria` citado en el frontmatter: daba 0, mudo'],
  ['ac-5-3-literal-citado-en-frontmatter.md', 6, 'idem: daba 0, mudo'],
];

for (const [file, esperados, modo] of CORPUS_REAL) {
  test(`parseAcsFromSpec cuenta bien ${file.replace(/^ac-|\.md$/g, '')} — ${modo}`, () => {
    const acs = checks.parseAcsFromSpec(readFix(file));
    assert.equal(acs.length, esperados, `esperaba ${esperados} ACs, contó ${acs.length}: [${acs.join(',')}]`);
  });
}

test('el universo de ACs cubre TODO AC citado por la tabla de Tests (invariante de las 9 stories de juguete)', () => {
  // La verdad de campo independiente del parser de ACs: si un test declara cubrir el AC #N,
  // el AC #N existe. Un AC citado y no parseado es exactamente el falso verde —
  // ACCOV-C5 lo daría por cubierto porque ni lo ve.
  for (const [file] of CORPUS_REAL) {
    const content = readFix(file);
    const acs = checks.parseAcsFromSpec(content);
    const table = checks.parseTestsTable(content);
    const citados = [...new Set(table.rows.flatMap((r) => r.acRefs))].filter((n) => n > 0);
    const invisibles = citados.filter((n) => !acs.includes(n));
    assert.deepEqual(invisibles, [], `${file}: la tabla cita ACs que el parser no ve: [${invisibles.join(',')}]`);
  }
});

// Las stories de juguete son inventadas: ninguna dice de qué story sale ni manda a regenerarla.
test('ToyStories_AreInvented_NoneDeclaresAnOriginAndRegenHasNoCases', () => {
  for (const [file] of CORPUS_REAL) {
    const cabecera = readFix(file).split('\n').slice(0, 12).join('\n');
    assert.doesNotMatch(cabecera, /derivado de|NO editar a mano|Regenerar con/i,
      `${file}: la cabecera dice de dónde sale o manda a regenerarla; tiene que ser una story inventada, editable en el archivo`);
    assert.match(cabecera, /inventad[oa]/i, `${file}: la cabecera no dice que es una story de ejemplo inventada`);
  }
  const regen = fs.readFileSync(path.join(__dirname, 'fixtures', 'regen.js'), 'utf8');
  const casos = (regen.match(/const CASOS = \[([\s\S]*?)\];/) || [null, null])[1];
  assert.notEqual(casos, null, 'regen.js ya no declara CASOS con la forma de siempre: revisar esta prueba');
  assert.equal(casos.replace(/\/\/[^\n]*/g, '').trim(), '', 'regen.js todavía regenera stories de juguete desde las reales');
  assert.doesNotMatch(regen, /\.md'\],?\s*$/m, 'regen.js nombra el archivo de origen de una story');
});

// Con una cantidad de argumentos equivocada el guion no sale 0 diciendo «no hay nada que regenerar», como sin
// argumentos: quien olvidó el origen recibiría un verde y no se derivaría nada.
test('RegenFixture_WrongArgumentCount_ExitsTwoWithUsage', () => {
  const regen = path.join(__dirname, 'fixtures', 'regen.js');
  const correr = (...args) => require('child_process').spawnSync(process.execPath, [regen, ...args], { encoding: 'utf8' });
  const sinArgumentos = correr();
  assert.equal(sinArgumentos.status, 0, sinArgumentos.stderr);
  assert.match(sinArgumentos.stdout, /no hay fixtures que regenerar/);
  for (const args of [['solo-el-destino.md'], ['a.md', 'b.md', 'c.md']]) {
    const r = correr(...args);
    assert.equal(r.status, 2, `con ${args.length} argumento(s) no es «nada que hacer»: ${r.stdout}`);
    assert.match(r.stderr, /uso: .*regen\.js <fixture-de-destino\.md> <story-de-origen\.md>/);
    assert.doesNotMatch(r.stdout, /no hay fixtures que regenerar/);
  }
  // con los dos argumentos y un origen que no existe: falla diciendo cuál falta, sin escribir el destino
  const falta = correr('zz-no-se-escribe.md', path.join(os.tmpdir(), 'no-existe-origen.md'));
  assert.equal(falta.status, 1);
  assert.match(falta.stderr, /FALTA el origen/);
  assert.ok(!fs.existsSync(path.join(FIX, 'zz-no-se-escribe.md')), 'no dejó un fixture a medias');
});

// La forma que miden las pruebas de arriba, fijada caso por caso. Reinventar el texto de
// una story de juguete no puede cambiar qué criterios se cuentan ni qué criterios cita cada fila de su tabla de pruebas.
const FORMA_DE_LAS_STORIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stories-shape.json'), 'utf8'));
test('ToyStories_ShapeUnchanged_SameCriteriaAndSameTestRows', () => {
  assert.deepEqual(Object.keys(FORMA_DE_LAS_STORIES.stories).sort(), CORPUS_REAL.map(([f]) => f).sort(),
    'la foto de la forma cubre exactamente las stories de juguete de hoy');
  for (const [file] of CORPUS_REAL) {
    const content = readFix(file);
    const tabla = checks.parseTestsTable(content);
    const forma = { acs: checks.parseAcsFromSpec(content), filas: tabla.rows.map((r) => [r.tid, r.acRefs]), lineas: content.split('\n').length };
    assert.deepEqual(forma, FORMA_DE_LAS_STORIES.stories[file], `${file}: cambió la forma que mide la prueba`);
  }
});

test('parseAcsFromSpec ignora el frontmatter al buscar la sección', () => {
  // El regex viejo no estaba anclado a principio de línea y el frontmatter va primero:
  // ganaba la cita en backticks y la "sección" quedaba siendo el resto del frontmatter.
  const story = `---
story: "9.9"
files_to_create:
  - "algo.ts"   # documenta el \`## Acceptance Criteria\` de la spec
---
## Acceptance Criteria

1. **Given** algo, **When** pasa, **Then** anda.
2. Otro criterio, sin bold.
`;
  assert.deepEqual(checks.parseAcsFromSpec(story), [1, 2],
    'la cita del literal dentro del frontmatter no debe secuestrar la sección');
});

test('parseAcsFromSpec: sin sección AC devuelve [] y acSectionOf lo distingue de sección vacía', () => {
  assert.deepEqual(checks.parseAcsFromSpec('# Story\n\nsin ACs\n'), []);
  assert.equal(checks.acSectionOf('# Story\n\nsin ACs\n'), null);
  assert.equal(typeof checks.acSectionOf('## Acceptance Criteria\n\nprosa sin numerar\n'), 'string',
    'sección presente pero sin ACs extraíbles ≠ sección ausente');
});

test('parseTestsTable acepta el heading Tests en H2 y avisa en vez de callarse', () => {
  const tabla = '\n| T-ID | Test | AC |\n|---|---|---|\n| T1 | hace algo | 1 |\n| T2 | hace otra | 2 |\n';
  const h3 = checks.parseTestsTable('## Acceptance Criteria\n1. **a** x\n\n### Tests' + tabla);
  const h2 = checks.parseTestsTable('## Acceptance Criteria\n1. **a** x\n\n## Tests' + tabla);
  // Sin el aviso, un H2 daría found:false, rows:[] en silencio, y downstream eso no se lee como "no pude parsear"
  // sino como "no hay tests".
  assert.equal(h2.found, true, 'la tabla bajo `## Tests` tiene que encontrarse');
  assert.equal(h2.rows.length, h3.rows.length, 'H2 y H3 deben producir las mismas filas');
  assert.deepEqual(h2.rows.map((r) => r.acRefs), h3.rows.map((r) => r.acRefs));
  assert.ok(h2.warnings.some((w) => /H2/.test(w)), 'debe avisar que el nivel del heading no es el de story-format §6');
  assert.deepEqual(h3.warnings, [], 'el H3 canónico no genera ruido');
});

test('parseTestsTable avisa cuando hay heading Tests pero ninguna fila legible', () => {
  const t = checks.parseTestsTable('## Acceptance Criteria\n1. **a** x\n\n### Tests\n\n(pendiente de redactar)\n');
  assert.equal(t.rows.length, 0);
  assert.ok(t.warnings.length > 0, 'una tabla ilegible tiene que distinguirse de una story sin tests');
  assert.ok(t.warnings.some((w) => /CERO tests/.test(w)));
});

test('runStoryChecks NO se calla cuando no puede parsear los ACs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storychecks-'));
  // Story cuyo frontmatter cita el literal y cuya sección real no existe: sin el aviso, el check sale sin emitir
  // NADA, y "sin findings" se lee como verde.
  fs.writeFileSync(path.join(tmp, 'story.md'), `---
story: "1.1"
files_to_create:
  - "x.ts"   # ver el \`## Acceptance Criteria\` de la spec madre
---
# Story sin sección de ACs
`);
  const r = checks.runStoryChecks({ repo: tmp, storyPath: path.join(tmp, 'story.md') });
  const señal = [...r.findings, ...r.ambiguous].filter((x) => x.rule === 'ACCOV-C5');
  assert.ok(señal.length > 0, 'ACCOV-C5 debe emitir algo (finding o ambiguous), nunca silencio');
  assert.ok(/Acceptance Criteria/.test(señal[0].detail));
});

// ── ACCOV-C1 sobre suites BASH ───────────────────────────────────────────────
// El arnés declara sus suites en bash (`scripts/tests/*.test.sh`, registradas en
// `scripts/tests/suites.json`). `TEST_FILE_RE` tiene que conocerlas: si no, `walkFiles` no las abre y
// ACCOV-C1 da CRITICAL falso por «test declarado sin implementación»: marca ausentes los T-ID con letra rotulados
// en la suite, mientras los T-ID numéricos «pasan» por coincidencia de substring en otras suites `.js`.
// 🔴 Los dos casos van juntos a propósito: el primero exige que la suite bash CUENTE; el
// segundo, que siga sin contar cuando el T-ID no está. Sin el segundo, meter `**/*` en el
// patrón también pondría verde el primero — y ahí el control dejaría de controlar.
function mkStoryConSuiteBash(tmp, { conElTid }) {
  fs.mkdirSync(path.join(tmp, 'scripts', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'story.md'), `---
story: "9.1"
status: in-progress
---
# Story 9.1

## Acceptance Criteria

1. **Given** algo, **Then** otra cosa.

### Tests (1 verificaciones)

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T2b | \`NotificacionEncolada_EsResultado\` | 1 | unit | x | y |
`);
  fs.writeFileSync(path.join(tmp, 'scripts', 'tests', 'medidor.test.sh'), conElTid
    ? '#!/usr/bin/env bash\n# ── T2b (AC1) · la notificación encolada es un resultado ──\nok "T2b · medido una vez"\n'
    : '#!/usr/bin/env bash\n# una suite que NO cubre ese caso\nok "otra cosa"\n');
}

test('ACCOV-C1: una suite BASH con el T-ID rotulado cuenta como implementación', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accov-bash-'));
  mkStoryConSuiteBash(tmp, { conElTid: true });
  const r = checks.runStoryChecks({ repo: tmp, storyPath: path.join(tmp, 'story.md') });
  const c1 = r.findings.filter((f) => f.rule === 'ACCOV-C1');
  assert.equal(c1.length, 0,
    `CRITICAL falso: el T-ID está rotulado en la suite .test.sh — ${c1.map((f) => f.detail).join(' | ')}`);
});

test('ACCOV-C1: sin el T-ID, la suite bash NO alcanza (el control sigue controlando)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accov-bash-neg-'));
  mkStoryConSuiteBash(tmp, { conElTid: false });
  const r = checks.runStoryChecks({ repo: tmp, storyPath: path.join(tmp, 'story.md') });
  const c1 = r.findings.filter((f) => f.rule === 'ACCOV-C1');
  assert.equal(c1.length, 1, 'ACCOV-C1 debe seguir marcando el test declarado que nadie implementó');
  assert.ok(/T2b/.test(c1[0].detail), `el finding no cita el T-ID ausente: ${c1[0].detail}`);
});

// ── ACCOV-C1 con tests en un repo COMPAÑERO ──────────────────────────────────
// El arnés declara tests de integración que viven en agent-skills (T8b/T8c). Sin declarar
// el compañero, CRITICAL falso; declarado en `.tycon/advisors.yaml → evidence.companion_repos`,
// el test cuenta. Los dos casos van juntos: el negativo impide "cerrarlo" mirando el disco entero.
function mkStoryConTestEnOtroRepo({ declarar }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accov-comp-'));
  const repo = path.join(base, 'producto'); const otro = path.join(base, 'companero');
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  fs.mkdirSync(path.join(otro, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'story.md'), `---
story: "9.2"
status: in-progress
---
# Story 9.2

## Acceptance Criteria

1. **Given** algo, **Then** otra cosa.

### Tests (1 verificaciones)

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T8b | \`archivador_sin_el_script\` | 1 | integration (companero) | x | y |
`);
  fs.writeFileSync(path.join(otro, 'tests', 'archivador.test.js'), "// T8b (AC7) · sin el script en esta máquina\ntest('T8b', () => {});\n");
  if (declarar) fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), `evidence:\n  companion_repos:\n    - ${otro}\n`);
  return repo;
}

test('ACCOV-C1: un test que vive en un repo compañero DECLARADO cuenta como implementación', () => {
  const repo = mkStoryConTestEnOtroRepo({ declarar: true });
  const r = checks.runStoryChecks({ repo, storyPath: path.join(repo, 'story.md') });
  const c1 = r.findings.filter((f) => f.rule === 'ACCOV-C1');
  assert.equal(c1.length, 0, `CRITICAL falso con el compañero declarado — ${c1.map((f) => f.detail).join(' | ')}`);
});

test('ACCOV-C1: sin declarar el compañero, el test de al lado NO cuenta (el control sigue controlando)', () => {
  const repo = mkStoryConTestEnOtroRepo({ declarar: false });
  const r = checks.runStoryChecks({ repo, storyPath: path.join(repo, 'story.md') });
  const c1 = r.findings.filter((f) => f.rule === 'ACCOV-C1');
  assert.equal(c1.length, 1, 'un repo vecino sin declarar no es evidencia (mirar el disco entero apagaría el control)');
});

test('evidence.companion_repos: `~/` se expande al home', () => {
  const ev = require(path.join(SCRIPTS, 'lib', 'evidence-config.js'));
  const casa = fs.mkdtempSync(path.join(os.homedir(), '.tycon-test-comp-'));
  try {
    const r = ev.parseEvidenceText(`evidence:\n  companion_repos:\n    - ~/${path.basename(casa)}\n`, '/repo/cualquiera');
    assert.deepEqual(r.roots, [casa], `no expandió ~: roots=${JSON.stringify(r.roots)} missing=${JSON.stringify(r.missing)}`);
  } finally { fs.rmSync(casa, { recursive: true, force: true }); }
});

test('parseTestsTable detecta columna AC y refs', () => {
  const t = checks.parseTestsTable(SAMPLE_STORY);
  assert.equal(t.found, true);
  assert.equal(t.hasAcColumn, true);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0].acRefs, [1]);
  assert.equal(t.rows[0].tid, 'T1');
  assert.equal(t.rows[1].nivel, 'integration');
});

test('parsePipelinesBlock extrae status por pipeline', () => {
  const p = checks.parsePipelinesBlock(SAMPLE_STORY);
  assert.equal(p.length, 2);
  assert.equal(p.find((x) => x.name === 'A-backend').status, 'done');
  assert.equal(p.find((x) => x.name === 'B-frontend').status, 'pending');
});

// Se leen las dos formas del bloque `pipelines:`, la de MAPA y la de LISTA —la que documenta story-format.md §1.1
// y valida VAL-C6—. Sin la de LISTA el parser devuelve [] → DEFTR-C1 ciego y ACCOV-C5 sin poder honrar los
// acs_pending.
const SAMPLE_STORY_LIST = `---
story: "4.18"
status: in-progress
pipelines:
  - name: A-checker
    status: done
    acs: [0, 1, 2, 3]
    tasks: [1, 2, 3]
  - name: B-eval
    status: pending
    acs_pending: [8]
    tasks_pending: [7]
    tests_pending: ["M1"]
---
## Acceptance Criteria

1. **Given** x, **When** y, **Then** z.
8. **Given** la medición, **When** corre, **Then** registra.

### Tests

| # | Test | AC | Nivel |
|---|------|----|-------|
| T1 | Uno | 1 | unit |
`;

test('parsePipelinesBlock: forma de LISTA (story-format §1.1) — antes devolvía []', () => {
  const p = checks.parsePipelinesBlock(SAMPLE_STORY_LIST);
  assert.equal(p.length, 2, 'las 2 tandas de la forma lista se leen');
  const a = p.find((x) => x.name === 'A-checker');
  const b = p.find((x) => x.name === 'B-eval');
  assert.equal(a.status, 'done');
  assert.deepEqual(a.acs, [0, 1, 2, 3]);
  assert.equal(b.status, 'pending');
  assert.deepEqual(b.acsPending, [8]);
});

test('deferredAcs: AC en acs_pending de un pipeline no-done cuenta como diferido', () => {
  assert.deepEqual([...checks.deferredAcs(SAMPLE_STORY_LIST)], [8]);
  // un pipeline `done` NO difiere sus acs
  assert.equal(checks.deferredAcs(SAMPLE_STORY_LIST).has(0), false);
});

test('ACCOV-C5: un AC diferido en acs_pending NO se marca como sin-cobertura', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accov-c5-'));
  fs.writeFileSync(path.join(tmp, 'story.md'), SAMPLE_STORY_LIST);
  fs.writeFileSync(path.join(tmp, 'x.spec.js'), '// @ac-1 test uno\n');
  try {
    const r = checks.runStoryChecks({ repo: tmp, storyPath: path.join(tmp, 'story.md') });
    const c5 = [...r.findings, ...r.ok].filter((f) => f.rule === 'ACCOV-C5');
    assert.ok(c5.length >= 1, `ACCOV-C5 corrió (findings=${JSON.stringify(r.findings)} ok=${JSON.stringify(r.ok)})`);
    // AC8 está en acs_pending de B (pending) → NO debe aparecer como finding fail.
    const fail = r.findings.find((f) => f.rule === 'ACCOV-C5');
    assert.equal(fail, undefined, `AC8 diferido no debe fallar C5; findings: ${JSON.stringify(r.findings.filter((f) => f.rule === 'ACCOV-C5'))}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// La story del arnés vive en el privado y el código en el público: la deuda se anota en el tasks/todo.md del repo de
// la story. Mirar sólo el del código daba DEFTR-C1 en falso (8.87, 7.40 C y D1).
test('DEFTR-C1: la deuda anotada en el tasks/todo.md del repo de la STORY cuenta cuando el código vive en otro repo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deftr-c1-'));
  const codigo = path.join(tmp, 'codigo');
  const stories = path.join(tmp, 'stories');
  for (const r of [codigo, stories]) fs.mkdirSync(path.join(r, '.git'), { recursive: true });
  fs.mkdirSync(path.join(stories, 'specs'));
  const story = path.join(stories, 'specs', 'story-9.91.md');
  fs.writeFileSync(story, '---\nstory: "9.91"\npipelines:\n  - name: A-hecha\n    status: done\n    acs: [1]\n'
    + '  - name: B-pendiente\n    status: pending\n    acs_pending: [2]\n---\n\n## Acceptance Criteria\n\n1. uno\n2. dos\n');
  const deftr = () => {
    const r = checks.runStoryChecks({ repo: codigo, storyPath: story });
    return { falla: r.findings.find((f) => f.rule === 'DEFTR-C1'), ok: r.ok.find((f) => f.rule === 'DEFTR-C1') };
  };
  try {
    const sinNada = deftr();
    assert.ok(sinNada.falla, 'sin la deuda anotada en ningún repo, DEFTR-C1 sigue frenando');
    assert.match(sinNada.falla.detail, /ni en el del código ni en el de la story/);
    fs.mkdirSync(path.join(stories, 'tasks'));
    // la deuda de OTRA story cuyo número empieza igual no cuenta
    fs.writeFileSync(path.join(stories, 'tasks', 'todo.md'), '- [ ] [DEF-9.911-B] Tanda B de la story 9.911\n- [ ] [DEF-9.91.2-A] la 9.91.2\n');
    assert.ok(deftr().falla, 'una línea de la 9.911 o de la 9.91.2 no cubre la deuda de la 9.91');
    fs.writeFileSync(path.join(stories, 'tasks', 'todo.md'), '- [ ] [DEF-9.91-B] Tanda B de la story 9.91 (AC#2)\n');
    const conDeuda = deftr();
    assert.equal(conDeuda.falla, undefined, `la deuda del repo de la story cuenta: ${JSON.stringify(conDeuda.falla)}`);
    assert.ok(conDeuda.ok, 'y queda la constancia de que pasó');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('computeDeepReviewGate: --story inválido → run:true legible, NO stack trace', () => {
  // Un rc sin `criteria` haría tirar TypeError con stack (fail-ugly en un gate = bypass); el gate falla en voz alta,
  // legible, con run por default seguro.
  const g = computeDeepReviewGate({ repo: os.tmpdir(), story: '/no/existe/story.md', files: ['a.mjs'] });
  assert.equal(g.run, true, 'default seguro: corre');
  assert.match(g.reason, /no computable/);
});

test('parseFrontmatterList extrae listas yaml', () => {
  assert.deepEqual(parseFrontmatterList(SAMPLE_STORY, 'files_to_modify'), ['src/Foo.cs', 'src/Bar.cs']);
  assert.deepEqual(parseFrontmatterList(SAMPLE_STORY, 'no_existe'), []);
});

test('buildStoryDigest conserva secciones operativas y descarta narrativa', () => {
  const story = SAMPLE_STORY + '\n## Dev Notes\n\nblah narrativa larga\n\n## Tasks\n\n- [ ] tarea 1\n';
  const d = buildStoryDigest(story);
  assert.ok(d.includes('Acceptance Criteria'));
  assert.ok(d.includes('| T1 |'));
  assert.ok(d.includes('tarea 1'), 'Tasks se conserva');
  assert.ok(!d.includes('blah narrativa'), 'Dev Notes se descarta');
});

test('computeRiskClass: pipelines multi-tanda → NORMAL', () => {
  const tmp = path.join(os.tmpdir(), `risk-test-${process.pid}.md`);
  fs.writeFileSync(tmp, SAMPLE_STORY);
  try {
    const r = computeRiskClass({ story: tmp, files: [] });
    assert.equal(r.risk, 'NORMAL', 'tiene bloque pipelines → NORMAL');
  } finally { fs.unlinkSync(tmp); }
});

test('computeRiskClass: story chica sin firmas ni SQL → LOW', () => {
  const tmp = path.join(os.tmpdir(), `risk-test2-${process.pid}.md`);
  fs.writeFileSync(tmp, `---\nstory: "1.1"\nstatus: ready-for-dev\nfiles_to_modify:\n  - src/Foo.cs\n---\n## Acceptance Criteria\n1. x\n`);
  try {
    const r = computeRiskClass({ story: tmp, files: [] });
    assert.equal(r.risk, 'LOW');
    assert.equal(r.auto_approve_plan, true);
  } finally { fs.unlinkSync(tmp); }
});

// ── computeDeepReviewGate — Step 5b gate ─────────────────────────────────────
test('computeDeepReviewGate: NORMAL→run(sonnet), LOW→skip, overrides, repo config', () => {
  const realHome = os.homedir();
  // HOME temporal: el caso LOW deja su constancia con `logGate`, que resuelve os.homedir() al
  // escribir. Sin esto cada corrida agrega una línea falsa al gates.log real.
  const prevHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-home-'));
  process.env.HOME = tmpHome;
  const normal = path.join(os.tmpdir(), `dr-normal-${process.pid}.md`);
  const low = path.join(os.tmpdir(), `dr-low-${process.pid}.md`);
  fs.writeFileSync(normal, SAMPLE_STORY); // tiene pipelines: → NORMAL
  fs.writeFileSync(low, `---\nstory: "1.1"\nstatus: ready-for-dev\nfiles_to_modify:\n  - src/Foo.cs\n---\n## Acceptance Criteria\n1. x\n`);
  const base = { repo: os.tmpdir() }; // sin .tycon/advisors.yaml → deepReviewConfig null
  try {
    // NORMAL → run, modelo sonnet por default
    let g = computeDeepReviewGate({ ...base, story: normal, files: [] });
    assert.equal(g.run, true, 'NORMAL corre');
    assert.equal(g.model, 'sonnet', 'default sonnet');

    // LOW → skip
    g = computeDeepReviewGate({ ...base, story: low, files: [] });
    assert.equal(g.run, false, 'LOW skip');
    // La constancia `deep-review-gate` de un repo de prueba va a la HOME temporal, nunca al gates.log real del dev
    // (sin esto se llenaría de líneas falsas). Evidencia POSITIVA: «el real no creció» no vale, las sesiones reales
    // escriben ahí al mismo tiempo.
    const logTmp = path.join(process.env.HOME, '.claude', '.tycon-pipeline', 'gates.log');
    assert.ok(process.env.HOME !== realHome && fs.existsSync(logTmp)
      && fs.readFileSync(logTmp, 'utf8').includes('"deep-review-gate"'),
      'la línea deep-review-gate del caso LOW quedó en la HOME temporal de la prueba');

    // LOW + --deep-review → fuerza on
    g = computeDeepReviewGate({ ...base, story: low, files: [], deepReview: true });
    assert.equal(g.run, true, '--deep-review fuerza on aun en LOW');

    // NORMAL + --no-deep-review → kill-switch gana sobre todo
    g = computeDeepReviewGate({ ...base, story: normal, files: [], noDeepReview: true });
    assert.equal(g.run, false, '--no-deep-review kill-switch');

    // --ultracode → run + modelo opus
    g = computeDeepReviewGate({ ...base, story: normal, files: [], ultracode: true });
    assert.equal(g.run, true);
    assert.equal(g.model, 'opus', 'ultracode sube a opus');

    // repo config deep_review: off gana sobre NORMAL (pero no sobre kill-switch)
    const cfgRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-cfg-'));
    fs.mkdirSync(path.join(cfgRepo, '.tycon'));
    fs.writeFileSync(path.join(cfgRepo, '.tycon', 'advisors.yaml'), 'deep_review: off\n');
    g = computeDeepReviewGate({ repo: cfgRepo, story: normal, files: [] });
    assert.equal(g.run, false, '.tycon/advisors.yaml deep_review: off apaga aun en NORMAL');
    fs.rmSync(cfgRepo, { recursive: true, force: true });
  } finally {
    fs.unlinkSync(normal); fs.unlinkSync(low);
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ── computeModelHint — sugerencia de modelo por complejidad ──────────────────
const HEAVY_STORY = `---
story: "9.9"
status: ready-for-dev
approach: "[CREATE]"
files_to_create:
  - src/a1.cs
  - src/a2.cs
  - src/a3.cs
  - src/a4.cs
  - src/a5.cs
  - src/a6.cs
files_to_modify:
  - src/m1.cs
  - src/m2.cs
  - src/m3.cs
  - src/m4.cs
  - src/m5.cs
  - src/m6.cs
  - src/m7.cs
pipelines:
  A:
    status: pending
---
## Acceptance Criteria
1. x
`;

test('ModelHint_HeavyStory_SuggestsOpus @story-7.35 @ac-13 — computeModelHint: LOW→sonnet, NORMAL común→opus, NORMAL pesada→opus', () => {
  const low = path.join(os.tmpdir(), `mh-low-${process.pid}.md`);
  const normal = path.join(os.tmpdir(), `mh-normal-${process.pid}.md`);
  const heavy = path.join(os.tmpdir(), `mh-heavy-${process.pid}.md`);
  fs.writeFileSync(low, `---\nstory: "1.1"\nstatus: ready-for-dev\nfiles_to_modify:\n  - src/Foo.cs\n---\n## Acceptance Criteria\n1. x\n`);
  fs.writeFileSync(normal, SAMPLE_STORY); // pipelines: → NORMAL, pero 1 sola señal pesada
  fs.writeFileSync(heavy, HEAVY_STORY);   // 13 files + CREATE amplio + multi-tanda = 3 señales
  try {
    let h = computeModelHint({ story: low, files: [] });
    assert.equal(h.recommended_session_model, 'sonnet', 'LOW → sonnet');
    assert.ok(h.also_ok.includes('opus'), 'LOW: opus también ok (no molestar)');

    h = computeModelHint({ story: normal, files: [] });
    assert.equal(h.recommended_session_model, 'opus', 'NORMAL con <2 señales → opus');
    assert.equal(h.heavy, false);

    h = computeModelHint({ story: heavy, files: [] });
    assert.equal(h.recommended_session_model, 'opus', 'NORMAL con ≥2 señales pesadas → opus: el arnés no sugiere fable solo');
    assert.doesNotMatch(h.reason, /fable/i, h.reason);
    assert.equal(h.heavy, true);
    assert.ok(h.heavy_signal_count >= 2, `esperaba ≥2 señales, hubo ${h.heavy_signal_count}`);
  } finally { fs.unlinkSync(low); fs.unlinkSync(normal); fs.unlinkSync(heavy); }
});

test('computeDeepReviewGate: escalación por complejidad — la story pesada va con opus; fable sólo con el flag explícito', () => {
  const heavy = path.join(os.tmpdir(), `dr-heavy-${process.pid}.md`);
  fs.writeFileSync(heavy, HEAVY_STORY);
  const base = { repo: os.tmpdir() };
  try {
    // Story pesada sin flags → opus automático, sin ofrecer otro modelo
    let g = computeDeepReviewGate({ ...base, story: heavy, files: [] });
    assert.equal(g.run, true);
    assert.equal(g.model, 'opus', 'story pesada escala a opus automático');

    // --deep-review-fable = pedido explícito de quien corre el pipeline → fable
    g = computeDeepReviewGate({ ...base, story: heavy, files: [], deepReviewFable: true });
    assert.equal(g.model, 'fable', '--deep-review-fable → fable');

    // ultracode + pesada → opus (fable NUNCA automático, ni con ultracode)
    g = computeDeepReviewGate({ ...base, story: heavy, files: [], ultracode: true });
    assert.equal(g.model, 'opus', 'ultracode NO sube a fable solo');
  } finally { fs.unlinkSync(heavy); }
});

test('DeepReviewGate_NuncaOfreceFable — ninguna combinación del portón ofrece Fable ni manda a preguntar por él', () => {
  const heavy = path.join(os.tmpdir(), `dr-heavy-nf-${process.pid}.md`);
  const normal = path.join(os.tmpdir(), `dr-normal-nf-${process.pid}.md`);
  fs.writeFileSync(heavy, HEAVY_STORY);
  fs.writeFileSync(normal, '---\nstory: "1.1"\n---\n# x\n');
  const base = { repo: os.tmpdir(), files: [] };
  const combinaciones = [
    { story: heavy }, { story: normal }, { story: heavy, ultracode: true }, { story: heavy, deepReviewOpus: true },
    { story: heavy, deepReview: true }, { story: heavy, modelQuestion: { value: 'ask', origin: 'maquina' } },
    { story: heavy, orgModels: { declared: true, data: { mandatory_ceiling: true, ceiling: 'fable', adversarial: { fable_question: 'ask' } } } },
  ];
  try {
    // ninguna parte de la salida nombra a Fable, con cualquier nombre de campo: ni una oferta, ni un aviso, ni una pregunta
    const sinFable = (g, donde) => {
      assert.notEqual(g.model, 'fable', `${donde}: sin el flag explícito nunca elige fable`);
      assert.doesNotMatch(JSON.stringify(g), /fable/i, `${donde}: la salida no nombra a Fable`);
      assert.doesNotMatch(JSON.stringify(g), /requires_user_approval|preguntar al user/, `${donde}: no manda a preguntar por un modelo`);
    };
    for (const c of combinaciones) sinFable(computeDeepReviewGate({ ...base, ...c }), JSON.stringify(c).slice(0, 120));
    // y por el comando real, con la story pesada
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'pipeline.js'), 'deep-review-gate', '--repo', os.tmpdir(), '--story', heavy], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    sinFable(JSON.parse(r.stdout), 'el comando deep-review-gate');
    assert.doesNotMatch(r.stderr, /fable/i, 'el comando tampoco lo dice por la salida de error');
  } finally { fs.unlinkSync(heavy); fs.unlinkSync(normal); }
});

// ── computeToolingExpected — PIPE-C9 tooling esperado ────────────────────────
test('computeToolingExpected: codegraph solo si hay .codegraph/, workflow-tool siempre, engram salvo con su integración apagada', () => {
  const conCg = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-cg-'));
  const sinCg = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-nocg-'));
  fs.mkdirSync(path.join(conCg, '.codegraph'));
  try {
    // `integrations: null` = no se sabe: la suite corre en cada arranque, también en una máquina con
    // engram apagada; lo que da la configuración de la máquina se prueba abajo, con un arnés de juguete.
    let t = computeToolingExpected(conCg, { integrations: null });
    const names = t.expected.map((e) => e.name);
    assert.ok(names.includes('codegraph'), 'repo con .codegraph/ → espera codegraph');
    assert.ok(names.includes('engram'), 'engram esperado mientras no se sepa que su integración está apagada');
    assert.ok(names.includes('workflow-tool'), 'tool Workflow siempre esperada (Step 5b)');
    assert.ok(t.expected.every((e) => e.if_unavailable && e.fallback), 'cada entry trae aviso + fallback');
    assert.ok(t.expected.every((e) => typeof e.raise_it === 'string' && e.raise_it.length > 0), 'cada entry trae playbook raise_it (intentar levantarlo)');
    const cg = t.expected.find((e) => e.name === 'codegraph');
    assert.ok('binary_found' in cg && 'cli_fallback' in cg, 'codegraph trae binary_found + cli_fallback (no se asserta el valor: depende de la máquina)');

    // sin decir las integraciones, la función lee la configuración de la máquina que corre la prueba: con CodeGraph
    // prendido ahí, lo esperaría aunque el repo no tenga índice
    t = computeToolingExpected(sinCg, { integrations: null });
    assert.ok(!t.expected.some((e) => e.name === 'codegraph'), 'sin .codegraph/ → NO espera codegraph');

    // Genérico: MCP servers declarados en .mcp.json del repo (caso codebase_memory en un producto del equipo)
    fs.writeFileSync(path.join(sinCg, '.mcp.json'), JSON.stringify({ mcpServers: { 'codebase_memory': { command: 'x' } } }));
    t = computeToolingExpected(sinCg, { integrations: null });
    const cm = t.expected.find((e) => e.name === 'codebase_memory');
    assert.ok(cm, 'MCP declarado en .mcp.json del repo → esperado');
    assert.equal(cm.mcp_prefix, 'mcp__codebase_memory__');
  } finally {
    fs.rmSync(conCg, { recursive: true, force: true });
    fs.rmSync(sinCg, { recursive: true, force: true });
  }
});

// ── Las skills de terceros que el pipeline invoca, desde el manifiesto ───────────────────────────────────────
test('T19 ToolingExpected_SkillsThePipelineInvokes — cada skill con used_by tycon-pipeline, con presente y acción; el manifiesto ilegible no calla', () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-skills-'));
  const repo = path.join(lab, 'repo');
  const skills = path.join(lab, 'skills');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(skills, 'bmad-agent-dev'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'bmad-agent-dev', 'SKILL.md'), 'name: bmad-agent-dev\n');
  const manifest = path.join(lab, 'third-party-skills.json');
  fs.writeFileSync(manifest, JSON.stringify({
    retirement: 'done', own: [], origins: {},
    derived: [{ target: 'skills/acme-story', repo: 'agent-skills', used_by: ['tycon-pipeline'] }],
    third_party: [
      { target: 'skills/bmad-dev-story', install: 'download', used_by: ['tycon-pipeline'] },
      { target: 'skills/bmad-agent-dev', install: 'download', used_by: ['tycon-pipeline'] },
      { target: 'skills/acme-docs', install: 'official-plugin', plugin: 'acme-docs@acme-marketplace', used_by: ['tycon-pipeline'] },
      { target: 'skills/zorblax-extra', install: 'download', used_by: [] },
    ],
  }));
  try {
    let t = computeToolingExpected(repo, { skillsDir: skills, manifestPath: manifest });
    const byName = Object.fromEntries(t.expected.map((e) => [e.name, e]));
    assert.equal(byName['skill:bmad-dev-story'].present, false, 'falta en la carpeta de skills → presente: false');
    assert.match(byName['skill:bmad-dev-story'].action, /instalador/);
    assert.equal(byName['skill:bmad-agent-dev'].present, true);
    assert.equal(byName['skill:bmad-agent-dev'].action, null);
    assert.match(byName['skill:acme-docs'].action, /plugin.*acme-docs@acme-marketplace/);
    assert.equal(byName['skill:acme-story'].present, false, 'la derivada también');
    assert.ok(!byName['skill:zorblax-extra'], 'sólo las que usa el pipeline');
    assert.ok(t.expected.every((e) => e.if_unavailable && e.fallback && e.raise_it), 'cada entrada trae aviso, alternativa y playbook');

    fs.writeFileSync(manifest, '{ roto');
    t = computeToolingExpected(repo, { skillsDir: skills, manifestPath: manifest });
    const m = t.expected.find((e) => e.name === 'third-party-manifest');
    assert.ok(m, 'manifiesto ilegible → una entrada que lo dice');
    assert.equal(m.present, false);
    assert.match(m.why, /no pude leer|ilegible/);
  } finally {
    fs.rmSync(lab, { recursive: true, force: true });
  }
});

// ── engram se espera sólo si su integración no está apagada ──────────────────────────────────────────────────
// Sin esto, `tooling-expected` espera engram siempre; en una máquina de afuera, con la integración
// apagada, el arranque del pipeline avisa que falta una herramienta que nadie pidió.
test('ToolingExpected_EngramFollowsItsIntegration — apagada no se espera; prendida, rota, lector viejo o sin arnés sí (no saber no es «apagada»)', () => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-integ-'));
  const repo = path.join(lab, 'repo');
  const home = path.join(lab, 'home');   // vacía: sin el enlace al arnés, y lejos de la HOME de quien corre la suite
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  const names = (opts) => computeToolingExpected(repo, opts).expected.map((e) => e.name);
  // un arnés de juguete: lo que `lib/harness-path.js` reconoce como clon, con el lector que se le escriba (o sin lector)
  const harness = (name, readerSource) => {
    const dir = path.join(lab, name);
    fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'install-tycon-hooks.sh'), '');
    if (readerSource !== null) fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'tycon-config.js'), readerSource);
    return { env: { TYCON_GUIDES_DIR: dir }, home };
  };
  const reader = (engram) => `module.exports = { leer: () => ({}), integraciones: () => (${JSON.stringify({ ado: false, engram })}) };`;
  try {
    // por la opción (objeto o null)
    const off = names({ integrations: { engram: false } });
    assert.ok(!off.includes('engram'), 'engram apagada → no se espera');
    assert.ok(off.includes('workflow-tool'), 'espejo: lo que no depende de una integración se sigue esperando');
    assert.ok(names({ integrations: { engram: true } }).includes('engram'), 'engram prendida → se espera');
    assert.ok(names({ integrations: null }).includes('engram'), 'null (no se sabe) → como hoy: se espera');
    assert.ok(names({ integrations: {} }).includes('engram'), 'una respuesta que no la nombra → como hoy');
    // por defecto: el lector de configuración del arnés
    assert.ok(!names(harness('off', reader(false))).includes('engram'), 'el arnés dice engram apagada → no se espera');
    assert.ok(names(harness('off-mirror', reader(false))).includes('workflow-tool'), 'espejo: con engram apagada por el arnés, lo demás se sigue esperando');
    assert.ok(names(harness('on', reader(true))).includes('engram'), 'el arnés dice engram prendida → se espera');
    const broken = "module.exports = { leer: () => { throw new Error('configuración rota'); }, integraciones: () => ({ engram: false }) };";
    assert.ok(names(harness('broken', broken)).includes('engram'), 'configuración rota → como hoy (no se lee como «apagada»)');
    assert.ok(names(harness('old', 'module.exports = { leer: () => ({}) };')).includes('engram'), 'lector anterior a las integraciones → como hoy');
    assert.ok(names(harness('no-reader', null)).includes('engram'), 'arnés sin lector de configuración → como hoy');
    assert.ok(names({ env: {}, home }).includes('engram'), 'arnés no encontrado → como hoy');
  } finally {
    fs.rmSync(lab, { recursive: true, force: true });
  }
});

// ── El manifiesto de terceros, por los dos nombres de su carpeta ─────────────────────────────────────────────
test('T43 ThirdPartyManifestPath_NewFolderFirst — la carpeta nueva del arnés primero; la vieja sólo con un arnés atrasado', () => {
  const { thirdPartyManifestPath } = require(path.join(SCRIPTS, 'pipeline.js'));
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-manifest-'));
  const put = (h, dir) => { fs.mkdirSync(path.join(h, 'scripts', dir), { recursive: true }); fs.writeFileSync(path.join(h, 'scripts', dir, 'third-party-skills.json'), '{}'); };
  try {
    const fresh = path.join(lab, 'fresh'); put(fresh, 'publishing');
    const both = path.join(lab, 'both'); put(both, 'publishing'); put(both, 'publicacion');
    const stale = path.join(lab, 'stale'); put(stale, 'publicacion');
    const none = path.join(lab, 'none'); fs.mkdirSync(none);
    assert.equal(thirdPartyManifestPath(fresh), path.join(fresh, 'scripts', 'publishing', 'third-party-skills.json'));
    assert.equal(thirdPartyManifestPath(both), path.join(both, 'scripts', 'publishing', 'third-party-skills.json'), 'con las dos: la nueva');
    assert.equal(thirdPartyManifestPath(stale), path.join(stale, 'scripts', 'publicacion', 'third-party-skills.json'), 'arnés atrasado: la vieja');
    assert.equal(thirdPartyManifestPath(none), path.join(none, 'scripts', 'publishing', 'third-party-skills.json'), 'sin ninguna: la nueva (el aviso la nombra)');
    assert.equal(thirdPartyManifestPath(null), null);
  } finally {
    fs.rmSync(lab, { recursive: true, force: true });
  }
});


// ── Reconstrucción de Edit (CF-5) en on-frontmatter-write ────────────────────
test('reconstrucción Edit no rompe con $& en new_string', () => {
  // El handler usa oldContent.replace(oldStr, () => newStr) — verificar el contrato.
  const oldContent = 'status: ready-for-dev';
  const newStr = 'status: done $& $1';
  const result = oldContent.replace('ready-for-dev', () => newStr);
  assert.ok(result.includes('$&'), 'el $& debe quedar LITERAL (no interpretado)');
});

// ── Validación de --files, descuento MECH-2,
// hints de re-loop ──
const { validateFilesExist, computeMechDiscount, reloopHintsFor, MECH_DISCOUNTABLE, computeSmartReloop } =
  require(path.join(SCRIPTS, 'pipeline.js'));

test('computeSmartReloop: delta vacío en re-loop → suspect_empty_delta + warning (snapshot post-fixes)', () => {
  // Guard: un smart-reloop con delta vacío casi siempre = snapshot tomado
  // DESPUÉS de los fixes → NO debe degradar a "todo skip" en silencio, debe advertir.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reloop-guard-'));
  const f1 = path.join(tmp, 'a.mjs');
  fs.writeFileSync(f1, '// código');
  // snapshot ts en el FUTURO respecto al mtime del archivo → nada cambió "desde la foto" → delta vacío.
  const futureTs = new Date(Date.now() + 60000).toISOString();
  const marker = { filesTouched: [f1], fileEvents: [], iterations: { '1': { ts: futureTs, filesSnapshot: [f1] } } };
  const fakeHome = path.join(tmp, 'home');
  fs.mkdirSync(path.join(fakeHome, '.claude/.tycon-pipeline/active'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.claude/.tycon-pipeline/active/guard-smoke.json'), JSON.stringify(marker));
  const prevHome = process.env.HOME;
  const prevSess = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.HOME = fakeHome;
  process.env.CLAUDE_CODE_SESSION_ID = 'guard-smoke';
  try {
    const out = computeSmartReloop({ repo: tmp, story: 'x', files: [f1], iter: 2, forceFullReloop: false, costTier: null });
    assert.deepEqual(out.delta_files, [], 'delta vacío por snapshot post-fixes');
    assert.equal(out.suspect_empty_delta, true, 'el guard marca el delta vacío como sospechoso');
    assert.ok(out.warning && /snapshot/i.test(out.warning), 'warning accionable menciona el snapshot');
  } finally {
    process.env.HOME = prevHome;
    if (prevSess === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevSess;
  }
});

test('validateFilesExist: vacío y fantasma abortan; reales y override pasan', () => {
  const realFile = __filename;
  // vacío → error (la variante zsh empty-removal del caso 9.4)
  assert.ok(validateFilesExist({ repo: '/tmp', files: [], allowMissingFiles: false }));
  // fantasma → error con hint de quoting
  const err = validateFilesExist({ repo: '/tmp', files: ['/no/existe/a.cs /tampoco/b.tsx'], allowMissingFiles: false });
  assert.ok(err && err.includes('word-splitea'));
  // reales → null
  assert.equal(validateFilesExist({ repo: '/tmp', files: [realFile], allowMissingFiles: false }), null);
  // story fantasma → error
  assert.ok(validateFilesExist({ repo: '/tmp', files: [realFile], story: '/no/existe/story.md', allowMissingFiles: false }));
  // override → null aunque falte todo
  assert.equal(validateFilesExist({ repo: '/tmp', files: [], allowMissingFiles: true }), null);
});

test('computeMechDiscount: story ilegible (ambiguo MECH) → CERO descuentos', () => {
  const all = ['tycon-ac-coverage-checker', 'tycon-deferral-tracker', 'tycon-feature-wiring-checker'];
  const r = computeMechDiscount(all, { repo: '/tmp', story: '/tmp/no-such-story-unit.md', files: [], iter: 2 });
  // runStoryChecks devuelve ambiguous=[{rule:'MECH'}] → fail-closed sin descuentos
  assert.equal(r, null);
});

test('computeMechDiscount: minIter — nada se descuenta en iter 1', () => {
  // La matriz NO debe descontar ningún advisor en iter 1 (el juicio LLM per-item/engram
  // corre siempre en el primer pase — regresión CRITICAL atrapada por los verificadores).
  for (const cfg of Object.values(MECH_DISCOUNTABLE)) {
    assert.ok(cfg.minIter >= 2, `minIter debe ser ≥2, encontrado ${cfg.minIter}`);
  }
  // feature-wiring jamás es descontable
  assert.ok(!('tycon-feature-wiring-checker' in MECH_DISCOUNTABLE));
});

test('reloopHintsFor: iter1 null, iter2 deep→sonnet, cost-tier deep gana', () => {
  const list = ['tycon-spec-first-checker', 'tycon-plugin-security-basics'];
  assert.equal(reloopHintsFor(list, 1), null);
  const h = reloopHintsFor(list, 2);
  assert.deepEqual(h, { 'tycon-spec-first-checker': 'sonnet' });
  // precedencia: --cost-tier deep suprime los hints (escape hatch paranoico)
  assert.equal(reloopHintsFor(list, 2, 'deep'), null);
});

// ── adopciones BMAD: dep-gate / next-story / review follow-ups ─────
const { execFileSync } = require('child_process');

function mkTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-depgate-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.co']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  return dir;
}

test('computeDepGate: paquete nuevo no declarado → pause; declarado → pass; churn de coma/bump NO flaggea', () => {
  const dir = mkTmpRepo();
  fs.writeFileSync(path.join(dir, 'package.json'),
    '{\n  "dependencies": {\n    "react": "^18.0.0"\n  }\n}\n');
  fs.mkdirSync(path.join(dir, 'specs', 'stories'), { recursive: true });
  const story = path.join(dir, 'specs', 'stories', '2-3-x.md');
  fs.writeFileSync(story, '---\nstory: 2-3-x\n---\nUsamos zod para validar.\n');
  execFileSync('git', ['-C', dir, 'add', 'package.json', 'specs']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'base']);
  // zod (declarado) + axios (NO). react recibe coma → NO debe flaggear (churn).
  fs.writeFileSync(path.join(dir, 'package.json'),
    '{\n  "dependencies": {\n    "react": "^18.0.0",\n    "zod": "^3.22.0",\n    "axios": "^1.6.0"\n  }\n}\n');
  const r = computeDepGate({ repo: dir, story });
  assert.equal(r.gate, 'pause');
  assert.deepEqual(r.new_deps.sort(), ['axios', 'zod']);
  assert.deepEqual(r.declared, ['zod']);
  assert.deepEqual(r.undeclared, ['axios']);
  assert.ok(!r.new_deps.includes('react'), 'react (churn de coma) NO debe contarse como nueva');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('@story-7.26 computeDepGate: en una story de dos repos mira también el repo hermano declarado', () => {
  // El diff incluye también el repo del frontend hermano: un paquete nuevo ahí tiene que verse.
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-depgate-dos-')));
  const back = path.join(raiz, 'Back');
  const front = path.join(raiz, 'Front');
  for (const d of [back, front]) { fs.mkdirSync(d); execFileSync('git', ['-C', d, 'init', '-q']); execFileSync('git', ['-C', d, 'config', 'user.email', 't@t.co']); execFileSync('git', ['-C', d, 'config', 'user.name', 't']); }
  fs.mkdirSync(path.join(back, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(back, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - Front\n');
  fs.mkdirSync(path.join(back, 'specs'), { recursive: true });
  const story = path.join(back, 'specs', 's.md');
  fs.writeFileSync(story, '---\nstory: 9.9\n---\nUsamos zod.\n');
  execFileSync('git', ['-C', back, 'add', '-A']); execFileSync('git', ['-C', back, 'commit', '-qm', 'base']);
  fs.writeFileSync(path.join(front, 'package.json'), '{\n  "dependencies": {\n    "react": "^18.0.0"\n  }\n}\n');
  execFileSync('git', ['-C', front, 'add', '-A']); execFileSync('git', ['-C', front, 'commit', '-qm', 'base']);
  fs.writeFileSync(path.join(front, 'package.json'), '{\n  "dependencies": {\n    "react": "^18.0.0",\n    "zod": "^3.22.0",\n    "axios": "^1.6.0"\n  }\n}\n');
  const r = computeDepGate({ repo: back, story });
  assert.equal(r.gate, 'pause', JSON.stringify(r));
  assert.deepEqual(r.undeclared, ['axios']);
  assert.deepEqual(r.declared, ['zod']);
  assert.ok(r.repos.includes(front), 'dice qué repos miró');
  // un hermano declarado que no está en disco no desaparece callado
  fs.writeFileSync(path.join(back, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - Front\n    - NoExiste\n');
  const r2 = computeDepGate({ repo: back, story });
  assert.ok((r2.repos_no_medidos || []).some((n) => n.repo === 'NoExiste'), JSON.stringify(r2));
  // cada repo por separado: quitar `axios` del backend y agregarlo en el frontend ES una dependencia nueva del frontend
  fs.writeFileSync(path.join(back, '.tycon', 'advisors.yaml'), 'evidence:\n  companion_repos:\n    - Front\n');
  fs.writeFileSync(path.join(back, 'package.json'), '{\n  "dependencies": {\n    "axios": "^1.6.0"\n  }\n}\n');
  execFileSync('git', ['-C', back, 'add', '-A']); execFileSync('git', ['-C', back, 'commit', '-qm', 'axios en el back']);
  fs.writeFileSync(path.join(back, 'package.json'), '{\n  "dependencies": {\n  }\n}\n');
  const r3 = computeDepGate({ repo: back, story });
  assert.ok(r3.undeclared.includes('axios'), `quitado en un repo y agregado en el otro sigue siendo nuevo: ${JSON.stringify(r3)}`);
  fs.rmSync(raiz, { recursive: true, force: true });
});

test('computeDepGate: sin dependencias nuevas → pass; repo sin git → no-medido (story 8.76: no es un skip mudo)', () => {
  const dir = mkTmpRepo();
  fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "dependencies": {\n    "react": "^18.0.0"\n  }\n}\n');
  execFileSync('git', ['-C', dir, 'add', 'package.json']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'base']);
  assert.equal(computeDepGate({ repo: dir, story: null }).gate, 'pass');
  fs.rmSync(dir, { recursive: true, force: true });
  const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-nogit-'));
  assert.equal(computeDepGate({ repo: noGit, story: null }).gate, 'no-medido');
  fs.rmSync(noGit, { recursive: true, force: true });
});

test('computeDepGate: .csproj compacto con varias PackageReference en una línea (matchAll)', () => {
  const dir = mkTmpRepo();
  fs.writeFileSync(path.join(dir, 'a.csproj'), '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.0.0" /></ItemGroup></Project>\n');
  execFileSync('git', ['-C', dir, 'add', 'a.csproj']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'base']);
  fs.writeFileSync(path.join(dir, 'a.csproj'), '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.0.0" /><PackageReference Include="Polly" Version="8.0.0" /></ItemGroup></Project>\n');
  const r = computeDepGate({ repo: dir, story: null });
  assert.ok(r.new_deps.includes('Polly'), 'Polly (2da ref en la misma línea) debe detectarse');
  assert.ok(!r.new_deps.includes('Serilog'), 'Serilog (ya existía) NO es nueva');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFollowups + followups-status: idempotente, preserva [x], acepta shape Step6', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-followups-'));
  const story = path.join(dir, '2-3.md');
  fs.writeFileSync(story, '---\nstory: 2-3\nstatus: review\n---\n\n## Story\nBody.\n');
  // 1ra escritura: 2 findings shape directo.
  const f1 = path.join(dir, 'f1.json');
  fs.writeFileSync(f1, JSON.stringify([
    { severity: 'CRITICAL', ruleId: 'SEC-C3', file: 'src/x.cs', line: 42, summary: 'Secret' },
    { severity: 'WARNING', ruleId: 'DOTNET-W3', file: 'src/y.cs', summary: 'Falta token' },
  ]));
  let r = writeFollowups({ story, findings: f1 });
  assert.equal(r.total, 2); assert.equal(r.open, 2);
  let st = computeFollowupsStatus({ story });
  assert.equal(st.open, 2); assert.equal(st.has_section, true);

  // dev marca SEC-C3 resuelto a mano.
  fs.writeFileSync(story, fs.readFileSync(story, 'utf8').replace('- [ ] **[CRITICAL]** SEC-C3', '- [x] **[CRITICAL]** SEC-C3'));
  // 2da escritura: shape Step6 (rule_id/disposition) + 1 nuevo. Debe preservar SEC-C3 [x].
  const f2 = path.join(dir, 'f2.json');
  fs.writeFileSync(f2, JSON.stringify([
    { rule_id: 'SEC-C3', severity: 'CRITICAL', file: 'src/x.cs', disposition: 'open', reason: 'Secret' },
    { rule_id: 'DOTNET-W3', severity: 'WARNING', file: 'src/y.cs', disposition: 'open', reason: 'Falta token' },
    { rule_id: 'TEST-C2', severity: 'CRITICAL', file: 'src/z.cs', disposition: 'fixed', reason: 'ya cubierto' },
  ]));
  r = writeFollowups({ story, findings: f2 });
  assert.equal(r.total, 3);
  st = computeFollowupsStatus({ story });
  const byKey = Object.fromEntries(st.items.map((i) => [i.key, i.checked]));
  assert.equal(byKey['SEC-C3|src/x.cs'], true, 'SEC-C3 resuelto a mano debe preservarse [x]');
  assert.equal(byKey['TEST-C2|src/z.cs'], true, 'disposition:fixed → [x] automático');
  assert.equal(byKey['DOTNET-W3|src/y.cs'], false);
  // no duplica la sección
  const heads = (fs.readFileSync(story, 'utf8').match(/## Review Follow-ups \(Advisors\)/g) || []).length;
  assert.equal(heads, 1, 'la sección no debe duplicarse en re-escrituras');
  // no toca el frontmatter
  assert.ok(/^---\nstory: 2-3\nstatus: review\n---/.test(fs.readFileSync(story, 'utf8')), 'frontmatter intacto');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('followups-status: story sin sección → has_section false, 0 open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-nofu-'));
  const story = path.join(dir, 's.md');
  fs.writeFileSync(story, '---\nstory: 1-1\n---\nbody\n');
  const st = computeFollowupsStatus({ story });
  assert.equal(st.has_section, false);
  assert.equal(st.open, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── BUG-PIPELINE-005: writeFollowups NO debe dropear items ABIERTOS ausentes ──
test('writeFollowups preserva items ABIERTOS que no vienen en el nuevo set (BUG-005)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-fu005-'));
  const story = path.join(dir, '1-14.md');
  fs.writeFileSync(story, '---\nstory: 1-14\nstatus: review\n---\n\n## Story\nBody.\n');
  // 1ra escritura: 2 findings abiertos (uno de ellos es un item gated tipo TEST-W4a).
  const f1 = path.join(dir, 'f1.json');
  fs.writeFileSync(f1, JSON.stringify([
    { severity: 'WARNING', ruleId: 'SEC-C5', file: 'src/a.cs', summary: 'log injection' },
    { severity: 'WARNING', ruleId: 'TEST-W4a', file: 'src/b.cs', summary: 'guard gated smoke T10' },
  ]));
  writeFollowups({ story, findings: f1 });
  // 2da escritura: nuevo set SIN TEST-W4a (el advisor dejó de reportarlo — es deferred/gated).
  const f2 = path.join(dir, 'f2.json');
  fs.writeFileSync(f2, JSON.stringify([
    { rule_id: 'SEC-C5', severity: 'WARNING', file: 'src/a.cs', disposition: 'fixed', reason: 'sanitizado' },
    { rule_id: 'SPEC-C4', severity: 'CRITICAL', file: 'docs/s.md', disposition: 'fixed', reason: 'AC actualizado' },
  ]));
  const r = writeFollowups({ story, findings: f2 });
  const st = computeFollowupsStatus({ story });
  const byKey = Object.fromEntries(st.items.map((i) => [i.key, i.checked]));
  // La regresión: TEST-W4a NO puede desaparecer, y debe seguir ABIERTO [ ].
  assert.ok('TEST-W4a|src/b.cs' in byKey, 'TEST-W4a (abierto, ausente del nuevo set) NO debe dropearse — BUG-005');
  assert.equal(byKey['TEST-W4a|src/b.cs'], false, 'TEST-W4a debe seguir ABIERTO [ ] (no se resolvió por omisión)');
  assert.equal(byKey['SEC-C5|src/a.cs'], true, 'SEC-C5 disposition:fixed → [x]');
  assert.equal(byKey['SPEC-C4|docs/s.md'], true, 'SPEC-C4 nuevo fixed → [x]');
  assert.equal(st.total, 3, 'SEC-C5 + SPEC-C4 + TEST-W4a preservado');
  assert.equal(r.open, 1, 'solo TEST-W4a queda abierto');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── BUG-PIPELINE-004: findRepoRootsForStory layout-agnóstico (docs/ y --repo) ──
test('findRepoRootsForStory resuelve el repo-root con stories en docs/ (BUG-004)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-rr004-'));
  const repo = path.join(dir, 'BackEnd');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });              // repo-root marker (dir)
  const storyDir = path.join(repo, 'docs', 'omni', 'epic');
  fs.mkdirSync(storyDir, { recursive: true });
  const story = path.join(storyDir, 'story-1-14.md');
  fs.writeFileSync(story, '---\nstory: 1-14\n---\nbody\n');

  // Sin --repo: el walk-up debe encontrar BackEnd/.git, NO el path del .md.
  const roots = findRepoRootsForStory(story);
  assert.ok(roots.includes(repo), `walk-up debe resolver ${repo}; obtuvo ${JSON.stringify(roots)}`);
  assert.ok(!roots.some((r) => r.endsWith('.md')), 'ningún root puede ser el propio .md (bug original)');
  // El candidate dir de evidencia queda bien formado.
  assert.ok(roots.map((r) => path.join(r, '.advisors', 'dod-runtime')).includes(
    path.join(repo, '.advisors', 'dod-runtime')), 'candidate dir de evidencia correcto');

  // Con --repo explícito (aunque apunte al contenedor): igual resuelve el root real por walk-up.
  const roots2 = findRepoRootsForStory(story, dir);
  assert.ok(roots2.includes(repo), '--repo contenedor no rompe: walk-up sigue hallando BackEnd');

  // `.git` como FILE (worktree) también cuenta.
  const wt = path.join(dir, 'Worktree');
  fs.mkdirSync(path.join(wt, 'specs', 'stories'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /somewhere\n');
  const wtStory = path.join(wt, 'specs', 'stories', '2-1.md');
  fs.writeFileSync(wtStory, '---\nstory: 2-1\n---\n');
  assert.ok(findRepoRootsForStory(wtStory).includes(wt), 'worktree (.git file) debe resolver como root');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('computePreflightFrontmatter: PRE-1 satisfecha con evidencia bajo docs/ (BUG-004 e2e)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-pf004-'));
  const repo = path.join(dir, 'BackEnd');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const evDir = path.join(repo, '.advisors', 'dod-runtime');
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, '1-14-202607052120Z.md'), '# evidence\nverdict=PASS failed=0\n');
  const storyDir = path.join(repo, 'docs', 'omni');
  fs.mkdirSync(storyDir, { recursive: true });
  const story = path.join(storyDir, 'story-1-14.md');
  // Story que declara runtime tests (dispara el gate) + status in-progress → target review.
  fs.writeFileSync(story, '---\nstory: 1-14\nstatus: in-progress\n---\n\ntests_done_smoke: [T9]\n');

  const res = computePreflightFrontmatter({ storyPath: story, targetStatus: 'review', repo });
  const pre1 = res.preconditions.find((p) => p.id === 'PRE-1-evidence-file-exists');
  assert.ok(pre1, 'PRE-1 presente');
  assert.equal(pre1.satisfied, true, 'evidencia bajo docs/ layout debe encontrarse (era falso negativo BUG-004)');
  assert.equal(res.ready_to_edit, true, 'ready_to_edit true con evidencia presente');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── findings.json determinista ───────────────────────────────────────────────
test('normalizeFindingRecord: severity/disposition inválidos → defaults; aliases ruleId/summary', () => {
  const n = normalizeFindingRecord({ ruleId: 'X-1', severity: 'blah', disposition: 'nope', summary: '  a   b ' });
  assert.equal(n.rule_id, 'X-1');            // alias ruleId → rule_id
  assert.equal(n.severity, 'WARNING');       // inválido → WARNING
  assert.equal(n.disposition, 'open');       // inválido → open
  assert.equal(n.reason, 'a b');             // summary → reason, whitespace colapsado
  const c = normalizeFindingRecord({ rule_id: 'Y', severity: 'critical', disposition: 'FIXED' });
  assert.equal(c.severity, 'CRITICAL');
  assert.equal(c.disposition, 'fixed');
});

test('resolveRunDir: prefiere dir con archivos sobre stray vacío; create cuando no hay', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
  const base = path.join(repo, '.advisors', 'pipeline-runs');
  // stray vacío (mtime NUEVO) + dir real con un archivo (mtime más viejo)
  const stray = path.join(base, '9.9-manual');
  const real = path.join(base, '9.9-20260101');
  fs.mkdirSync(stray, { recursive: true });
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'step-06-consolidated-report.md'), '# report');
  // el stray se creó DESPUÉS → dir mtime más nuevo, pero NO tiene archivos → debe perder
  const picked = resolveRunDir(repo, '9.9', false);
  assert.equal(path.basename(picked), '9.9-20260101', 'gana el dir con contenido, no el stray vacío más nuevo');
  // sin candidatos + create=true → crea uno
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'runs2-'));
  const created = resolveRunDir(empty, '1.1', true);
  assert.ok(created && fs.existsSync(created), 'create=true crea el run dir');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

test('writeFindings + findings-status: escribe validado, status pasa de missing(exit3) a present', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  const runDir = path.join(repo, '.advisors', 'pipeline-runs', '2.2-20260101');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'step-06-consolidated-report.md'), '# report'); // marca el run real
  const story = path.join(repo, 'story-2-2.md');
  fs.writeFileSync(story, '---\nstory: "2.2"\nstatus: review\n---\n## Acceptance Criteria\n1. x\n');

  // BEFORE: falta → exists false (el CLI mapea a exit 3)
  const before = computeFindingsStatus({ story, repo });
  assert.equal(before.exists, false, 'findings.json falta antes de escribirlo');

  // write via array inline (simula --findings archivo)
  const findingsFile = path.join(repo, 'in.json');
  fs.writeFileSync(findingsFile, JSON.stringify([
    { rule_id: 'DOTNET-W3', severity: 'WARNING', advisor: 'a', file: 'f.cs', disposition: 'fixed', reason: 'r' },
    // un crítico eximido necesita la constancia del ok de una persona (critical-waiver.test.js): acá, arreglado
    { ruleId: 'SEC-C1', severity: 'critical', disposition: 'fixed', summary: 's' },
  ]));
  const w = writeFindings({ story, repo, findings: findingsFile });
  assert.equal(w.wrote, true);
  assert.equal(w.total, 2);
  assert.equal(w.counts.critical, 1);
  assert.equal(w.counts.warning, 1);
  assert.ok(w.path.endsWith(path.join('2.2-20260101', 'findings.json')), 'escribe en el run dir real, no en uno nuevo');

  // AFTER: presente + válido
  const after = computeFindingsStatus({ story, repo });
  assert.equal(after.exists, true);
  assert.equal(after.valid, true);
  assert.equal(after.count, 2);

  // el archivo escrito es un array JSON parseable con el shape canónico
  const written = JSON.parse(fs.readFileSync(w.path, 'utf8'));
  assert.equal(written[1].rule_id, 'SEC-C1');
  assert.equal(written[1].severity, 'CRITICAL');
  assert.equal(written[1].disposition, 'fixed');
  fs.rmSync(repo, { recursive: true, force: true });
});

// ── REGRESIÓN: `marker.js set` NO debe borrar los campos que no enumera ──────────────────────
// Si el objeto que construye `cmdSet` fuera un whitelist cerrado, todo lo NO enumerado se perdería en
// silencio — `checks`, `checksProvenance`, `dodRuntimeChecked`, `deepReviewDone`, `clockiStarted`,
// `autonomous`, `stepTimings`… O sea que un `set` mid-pipeline BORRARÍA la evidencia de verificación
// (los checks con provenance `run-check` y el gate de DoD), obligando a re-correr suites enteras o
// —peor— tentando a re-poner los greens con `set-check --manual`, justo lo que la capa
// anti-green-falso existe para impedir. Parchar campo por campo (`fileEvents`, `iterations`) no alcanza:
// `cmdSet` conserva de raíz todo lo que no enumera.
// Agravante: `cmdGet` emite el marker COMPLETO, así que el patrón `get | editar | set` parece seguro y sería
// destructivo (borraría los checks `run-check` y el flag de DoD).
test('marker set: preserva los campos no enumerados (checks, dodRuntimeChecked, flags)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-set-'));
  const activeDir = path.join(fakeHome, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const SID = 'set-preserve-smoke';
  const markerFile = path.join(activeDir, `${SID}.json`);

  // Marker "mid-pipeline": con toda la evidencia que un run real acumula.
  const previo = {
    storyId: '4.17',
    storyPath: 'specs/story.md',
    repoPath: '/tmp/repo',
    sessionId: SID,
    startedAt: '2026-07-24T15:00:00.000Z',
    lastTouch: '2026-07-24T15:00:00.000Z',
    stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7],
    stepsPending: [8],
    filesTouched: ['/tmp/repo/src/a.ts'],
    iterations: { '1': { ts: '2026-07-24T16:00:00.000Z', filesSnapshot: [] } },
    fileEvents: [{ path: '/tmp/repo/src/a.ts', ts: '2026-07-24T16:00:00.000Z' }],
    checks: { build: 'green', tests: 'green', acmatrix: 'green' },
    checksProvenance: { build: 'run-check', tests: 'run-check', acmatrix: 'run-check' },
    dodRuntimeChecked: true,
    deepReviewDone: true,
    clockiStarted: true,
    autonomous: true,
    stepTimings: { 5: { ms: 1234 } },
  };
  fs.writeFileSync(markerFile, JSON.stringify(previo));

  // `set` que solo quiere corregir el storyPath (el caso habitual).
  const out = require('child_process').execFileSync(
    process.execPath,
    [path.join(SCRIPTS, 'marker.js'), 'set', JSON.stringify({ storyId: '4.17', storyPath: '/abs/specs/story.md' })],
    { env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: SID }, encoding: 'utf8' }
  );
  const after = JSON.parse(out);

  assert.equal(after.storyPath, '/abs/specs/story.md', 'aplica el campo que se quiso cambiar');
  assert.deepEqual(after.checks, previo.checks, 'PRESERVA checks (provenance run-check, cara de re-generar)');
  assert.deepEqual(after.checksProvenance, previo.checksProvenance, 'PRESERVA checksProvenance');
  assert.equal(after.dodRuntimeChecked, true, 'PRESERVA dodRuntimeChecked (gate de DoD)');
  assert.equal(after.deepReviewDone, true, 'PRESERVA deepReviewDone (el 5b no se re-corre)');
  assert.equal(after.clockiStarted, true, 'PRESERVA clockiStarted (no re-abre timer)');
  assert.equal(after.autonomous, true, 'PRESERVA autonomous');
  assert.deepEqual(after.stepTimings, previo.stepTimings, 'PRESERVA stepTimings');
  // y sigue respetando lo que ya funcionaba
  assert.deepEqual(after.fileEvents, previo.fileEvents, 'sigue preservando fileEvents (HOLE-1)');
  assert.deepEqual(after.iterations, previo.iterations, 'sigue preservando iterations (SPEED-1)');
  assert.deepEqual(after.stepsCompleted, previo.stepsCompleted);

  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── mark-adversarial-launched — 3 invariantes frágiles + anti-leak ───────────────────────────
// El comando sostiene el join de step-05b y la
// detección de orfandad; un refactor que rompa cualquiera de estos invariantes falla EN SILENCIO
// (el 5b no corre y nadie se entera, o el join cuelga). Cada test cubre un camino del review.
function markerEnv(sid, fakeHome) {
  return { env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8' };
}
function writeFakeMarker(fakeHome, sid, extra) {
  const activeDir = path.join(fakeHome, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const marker = {
    storyId: 'A', storyPath: 'specs/a.md', repoPath: '/tmp/repo', sessionId: sid,
    startedAt: '2026-07-30T10:00:00.000Z', lastTouch: '2026-07-30T10:00:00.000Z',
    stepsCompleted: [0, 1, 2, 3, 4], stepsPending: [5], filesTouched: [], iterations: {}, fileEvents: [],
    ...extra,
  };
  fs.writeFileSync(path.join(activeDir, `${sid}.json`), JSON.stringify(marker));
  return marker;
}
const MARKER = path.join(SCRIPTS, 'marker.js');

// ── REGRESIÓN: `update-story-status` con `$` en el frontmatter ───────────────────────────────────────────────
// String.prototype.replace lee `$'`, `$&`, `` $` `` y `$1` en el TEXTO de reemplazo: un título con `$'` pegaría el
// resto del archivo adentro del frontmatter. Lo hacen PIPE-C5 al arrancar el pipeline y el Step 8.
test('update-story-status: un `$` en el frontmatter o en el cuerpo queda tal cual (reemplazo con función)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-status-dollar-'));
  const story = path.join(fakeHome, 'story-lab.md');
  const fm = [
    '---',
    'story: "9.99"',
    "title: \"El freno lee $'x' y \\$HOME como el shell; también $& y $1 y $`\"",
    'status: ready-for-dev  # nota que se conserva',
    '---',
  ].join('\n');
  const body = "\n# Story de laboratorio\n\nEl cuerpo nombra $' y $& y no se toca.\n";
  fs.writeFileSync(story, `${fm}${body}`);
  execFileSync(process.execPath, [MARKER, 'update-story-status', story, 'in-progress'], markerEnv('status-dollar', fakeHome));
  const after = fs.readFileSync(story, 'utf8');
  assert.strictEqual(after, `${fm.replace('status: ready-for-dev', 'status: in-progress')}${body}`,
    'sólo cambia el valor de status: ni el título ni el cuerpo ni el comentario');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── update-story-status cambia también la línea `Status:` del cuerpo ─────────────────────────────────────────
// La guía del formato pide `Status:` bajo el título; si el arranque (PIPE-C5) cambiara sólo el frontmatter, la historia
// quedaría con dos estados distintos, que el validador marca.
test('UpdateStoryStatus_TambienElCuerpo @story-8.62 @ac-1', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-status-body-'));
  const cambiar = (nombre, texto) => {
    const story = path.join(fakeHome, nombre);
    fs.writeFileSync(story, texto);
    execFileSync(process.execPath, [MARKER, 'update-story-status', story, 'in-progress'], markerEnv('status-body', fakeHome));
    return fs.readFileSync(story, 'utf8');
  };
  const fm = '---\nstory: "9.97"\nstatus: ready-for-dev\n---\n';
  // con la línea del cuerpo: cambian las dos
  assert.strictEqual(cambiar('a.md', `${fm}\n# Story 9.97: x\n\nStatus: ready-for-dev\n\n## Story\n`),
    '---\nstory: "9.97"\nstatus: in-progress\n---\n\n# Story 9.97: x\n\nStatus: in-progress\n\n## Story\n');
  // sin la línea: sólo el frontmatter, el cuerpo igual
  const sinLinea = '\n# Story 9.97: x\n\n## Story\n\nEl estado está arriba.\n';
  assert.strictEqual(cambiar('b.md', `${fm}${sinLinea}`), `${fm.replace('ready-for-dev', 'in-progress')}${sinLinea}`);
  // un `Status:` dentro de un bloque de código o más abajo no se toca
  const conBloque = '\n# Story 9.97: x\n\n```\nStatus: ready-for-dev\n```\n\n## Notas\n\nStatus: ready-for-dev\n';
  assert.strictEqual(cambiar('c.md', `${fm}${conBloque}`), `${fm.replace('ready-for-dev', 'in-progress')}${conBloque}`);
  // un ejemplo con `# Story` dentro de un bloque de código ANTES del título real no se toca; el real sí
  const ejemploAntes = '\n```\n# Story 0.0: ejemplo\n\nStatus: x\n```\n\n# Story 9.97: x\n\nStatus: ready-for-dev\n';
  assert.strictEqual(cambiar('e.md', `${fm}${ejemploAntes}`),
    `${fm.replace('ready-for-dev', 'in-progress')}${ejemploAntes.replace('Status: ready-for-dev', 'Status: in-progress')}`);
  // lo mismo con un bloque de código con ~~~
  const ejemploTilde = ejemploAntes.replace(/```/g, '~~~');
  assert.strictEqual(cambiar('f.md', `${fm}${ejemploTilde}`),
    `${fm.replace('ready-for-dev', 'in-progress')}${ejemploTilde.replace('Status: ready-for-dev', 'Status: in-progress')}`);
  // con saltos de línea de Windows también cambian las dos, y los \r se quedan
  const crlf = (t) => t.replace(/\n/g, '\r\n');
  assert.strictEqual(cambiar('d.md', crlf(`${fm}\n# Story 9.97: x\n\nStatus: ready-for-dev\n`)),
    crlf('---\nstory: "9.97"\nstatus: in-progress\n---\n\n# Story 9.97: x\n\nStatus: in-progress\n'));
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── update-pipeline-status: el estado de una tanda del bloque `pipelines:` lo escribe el orquestador, no una mano ──
const PIPES_FM = [
  '---',
  'story: "9.98"',
  'status: review',
  'pipelines:',
  '  - name: A-medir',
  '    status: pending',
  '    acs: [1, 2]',
  '  - name: B-conectar',
  '    status: in-progress  # nota que se conserva',
  '    # comentario entre claves',
  '    acs: [3]',
  '---',
].join('\n');
const PIPES_BODY = '\n# Story de laboratorio\n\n  - name: A-medir\n    status: pending\n';
function pipesStory(tag) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), `mk-pipes-${tag}-`));
  const story = path.join(fakeHome, 'story-lab.md');
  fs.writeFileSync(story, `${PIPES_FM}${PIPES_BODY}`);
  return { fakeHome, story };
}

test('update-pipeline-status: cambia sólo la tanda nombrada y conserva el comentario y el cuerpo', () => {
  const { fakeHome, story } = pipesStory('one');
  execFileSync(process.execPath, [MARKER, 'update-pipeline-status', story, 'B-conectar', 'done'], markerEnv('pipes-one', fakeHome));
  const after = fs.readFileSync(story, 'utf8');
  assert.strictEqual(after, `${PIPES_FM.replace('status: in-progress  #', 'status: done  #')}${PIPES_BODY}`,
    'sólo cambia el status de B-conectar: ni A-medir, ni la story, ni el cuerpo');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('update-pipeline-status --all: pasa todas las tandas y deja el status de la story', () => {
  const { fakeHome, story } = pipesStory('all');
  const out = execFileSync(process.execPath, [MARKER, 'update-pipeline-status', story, '--all', 'done'], markerEnv('pipes-all', fakeHome));
  const after = fs.readFileSync(story, 'utf8');
  const fm = after.split('\n---\n')[0];
  assert.strictEqual((fm.match(/^ {4}status: done/gm) || []).length, 2, 'las dos tandas quedan en done');
  assert.match(fm, /^status: review$/m, 'el status de la story no se toca');
  assert.ok(after.endsWith(PIPES_BODY), 'el cuerpo no se toca');
  assert.match(String(out), /A-medir/);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('update-pipeline-status: una tanda que no existe sale 2, nombra las que hay y no escribe', () => {
  const { fakeHome, story } = pipesStory('missing');
  const r = require('child_process').spawnSync(process.execPath, [MARKER, 'update-pipeline-status', story, 'Z-no-existe', 'done'], { ...markerEnv('pipes-missing', fakeHome), encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /A-medir/);
  assert.match(r.stderr, /B-conectar/);
  assert.strictEqual(fs.readFileSync(story, 'utf8'), `${PIPES_FM}${PIPES_BODY}`);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('update-pipeline-status: un estado inválido sale 2 y no escribe', () => {
  const { fakeHome, story } = pipesStory('invalid');
  const r = require('child_process').spawnSync(process.execPath, [MARKER, 'update-pipeline-status', story, 'A-medir', 'terminada'], { ...markerEnv('pipes-invalid', fakeHome), encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /done \| in-progress \| blocked \| pending/);
  assert.strictEqual(fs.readFileSync(story, 'utf8'), `${PIPES_FM}${PIPES_BODY}`);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('mark-adversarial-launched: guard same-session exit 2, --relaunch lo abre y queda en bypass.log', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-adv-guard-'));
  const SID = 'adv-guard';
  writeFakeMarker(fakeHome, SID);
  const first = JSON.parse(execFileSync(process.execPath, [MARKER, 'mark-adversarial-launched', 'wf_1', '4'], markerEnv(SID, fakeHome)));
  assert.equal(first.runId, 'wf_1');
  assert.equal(first.launchedAtStep, 4);
  // 2do lanzamiento misma sesión SIN --relaunch → exit 2 (el 5b corre UNA vez).
  assert.throws(
    () => execFileSync(process.execPath, [MARKER, 'mark-adversarial-launched', 'wf_2', '4'], markerEnv(SID, fakeHome)),
    (e) => e.status === 2,
    'el guard anti-doble-lanzamiento debe fallar con exit 2'
  );
  // --relaunch: overwrite permitido + auditado.
  const re = JSON.parse(execFileSync(process.execPath, [MARKER, 'mark-adversarial-launched', 'wf_3', '5b', '--relaunch'], markerEnv(SID, fakeHome)));
  assert.equal(re.runId, 'wf_3');
  assert.equal(re.launchedAtStep, '5b', "step '5b' se registra literal, no cae a 4");
  const bypass = fs.readFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'bypass.log'), 'utf8');
  assert.ok(bypass.includes('ADVERSARIAL_RELAUNCH'), 'el relanzamiento queda en bypass.log');
  // step inválido → exit 2 (no cae a 4 en silencio).
  assert.throws(
    () => execFileSync(process.execPath, [MARKER, 'mark-adversarial-launched', 'wf_4', 'banana', '--relaunch'], markerEnv(SID, fakeHome)),
    (e) => e.status === 2
  );
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('mark-adversarial-launched: huérfano cross-session → overwrite con el sessionId nuevo, resto intacto', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-adv-orf-'));
  const SID = 'adv-nueva';
  // Marker adoptado: adversarial de una sesión MUERTA (el caso que adopt-session produce).
  writeFakeMarker(fakeHome, SID, {
    adversarial: { launchedAtStep: 4, runId: 'wf_viejo', sessionId: 'sesion-muerta', launchedAt: '2026-07-30T10:05:00.000Z' },
    checks: { build: 'green' },
  });
  const out = execFileSync(process.execPath, [MARKER, 'mark-adversarial-launched', 'wf_nuevo', '5b'], markerEnv(SID, fakeHome));
  assert.ok(out.includes('huérfano'), 'anuncia la adopción del huérfano');
  const after = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'active', `${SID}.json`), 'utf8'));
  assert.equal(after.adversarial.runId, 'wf_nuevo');
  assert.equal(after.adversarial.sessionId, SID, 'el relanzamiento queda a nombre de la sesión actual');
  assert.deepEqual(after.checks, { build: 'green' }, 'el resto del marker queda intacto');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── mark-adversarial-result ──────────────────────────────────────────────────────────────────
// Una segunda ronda adversarial corrida DESPUÉS del cierre formal de los revisores puede encontrar defectos graves
// y llegar al merge sin otra ronda. Ningún registro lo mostraría: sólo las iteraciones de revisores dejan línea en
// gates.log. Este comando deja la del pase adversarial, con su veredicto derivado de un NÚMERO (hallazgos
// confirmados), no de prosa.
function gatesLines(fakeHome) {
  const f = path.join(fakeHome, '.claude', '.tycon-pipeline', 'gates.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
// El 5b se anota con `--result <archivo>`: el JSON del pase, medido, con sus N confirmados.
function resultadoMedido(dir, n) {
  const archivo = path.join(dir, `resultado-${n}-${process.hrtime.bigint()}.json`);
  fs.writeFileSync(archivo, JSON.stringify({
    confirmed: Array.from({ length: n }, (_v, k) => ({ lens: 'l', summary: `h${k}` })),
    lentes: ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => ({ lens: l, estado: 'medida', count: 0 })), lentes_sin_medir: [], detalle: [], medido: true,
  }));
  return archivo;
}

test('mark-adversarial-result: deja el pase en gates.log con su veredicto, y lo suma al marker', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-adv-res-'));
  const SID = 'adv-res';
  writeFakeMarker(fakeHome, SID);
  execFileSync(process.execPath, [MARKER, 'mark-adversarial-result', '3', '--type', '5b', '--result', resultadoMedido(fakeHome, 3), '--run', 'wf_9', '--model', 'sonnet', '--tests', '0', '--deferred', '3', '--reason', 'código preexistente, story aparte'], markerEnv(SID, fakeHome));
  execFileSync(process.execPath, [MARKER, 'mark-adversarial-result', '0', '--type', 'revision'], markerEnv(SID, fakeHome));
  const pases = gatesLines(fakeHome).filter((g) => g.name === 'adversarial-pass');
  assert.equal(pases.length, 2, 'una línea por pase');
  assert.equal(pases[0].storyId, 'A');
  assert.equal(pases[0].confirmados, 3);
  assert.equal(pases[0].veredicto, 'no-listo', 'con hallazgos confirmados, lo revisado no estaba listo');
  assert.equal(pases[0].tipo, '5b');
  assert.equal(pases[0].runId, 'wf_9');
  assert.equal(pases[0].modelo, 'sonnet');
  assert.equal(pases[1].veredicto, 'listo', 'cero confirmados es listo');
  const m = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'active', `${SID}.json`), 'utf8'));
  assert.equal((m.adversarialPasses || []).length, 2, 'el marker guarda los pases de la corrida');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('mark-adversarial-result: sin número válido, con tipo desconocido, o sin story conocida → exit 2 y nada escrito', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-adv-res-mal-'));
  const SID = 'adv-res-mal';
  writeFakeMarker(fakeHome, SID);
  for (const args of [['x'], ['-1'], ['2', '--type', 'banana'], []]) {
    assert.throws(
      () => execFileSync(process.execPath, [MARKER, 'mark-adversarial-result', ...args], { ...markerEnv(SID, fakeHome), stdio: 'pipe' }),
      (e) => e.status === 2, `args ${JSON.stringify(args)} → exit 2`,
    );
  }
  // Fuera del pipeline (sin marker) el pase también se anota, pero tiene que decir de qué story es.
  const SIN = 'adv-sin-marker';
  assert.throws(
    () => execFileSync(process.execPath, [MARKER, 'mark-adversarial-result', '1', '--type', 'revision'], { ...markerEnv(SIN, fakeHome), stdio: 'pipe' }),
    (e) => e.status === 2, 'sin marker y sin --story no se sabe de qué story es',
  );
  assert.equal(gatesLines(fakeHome).filter((g) => g.name === 'adversarial-pass').length, 0, 'ningún intento inválido deja línea');
  execFileSync(process.execPath, [MARKER, 'mark-adversarial-result', '1', '--type', 'revision', '--story', '7.7', '--tests', '0', '--deferred', '1', '--reason', 'follow-up'], markerEnv(SIN, fakeHome));
  const l = gatesLines(fakeHome).filter((g) => g.name === 'adversarial-pass');
  assert.equal(l.length, 1);
  assert.equal(l[0].storyId, '7.7', 'con --story queda anotado aunque no haya corrida del pipeline');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── El findings.json del Step 6 lo exige el FRENO, no una instrucción del step ───────────────────
// `pipeline.js findings-status` es la «pre-condición mecánica del Step 8». Si su único enforcement viviera en el
// markdown del step, o sea en algo que el orquestador tiene que acordarse de correr, algunas corridas no dejarían
// el archivo. Sin él, «no escribí» y «no encontré nada» son indistinguibles y el criterio de poda del catálogo
// decide retiros con media muestra.
// 🔴 Sin el freno en marker.js, los tres primeros casos salen exit 0.
function repoConRunDir(fakeHome, { findings }) {
  const repo = path.join(fakeHome, 'repo');
  const runDir = path.join(repo, '.advisors', 'pipeline-runs', '9.9-20260918-000000');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const storyPath = path.join(repo, 'specs', 'story-9.9.md');
  fs.writeFileSync(storyPath, '---\nstory: "9.9"\nepic: "9"\nstatus: in-progress\n---\n\n# Story 9.9\n');
  if (findings !== null) fs.writeFileSync(path.join(runDir, 'findings.json'), findings);
  return { repo, runDir, storyPath };
}

test('complete-step 8: run dir SIN findings.json → BLOQUEA y dice el comando que lo escribe', () => {
  const { spawnSync } = require('node:child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-find-falta-'));
  const SID = 'find-falta';
  const f = repoConRunDir(fakeHome, { findings: null });
  writeFakeMarker(fakeHome, SID, { storyId: '9.9', storyPath: f.storyPath, repoPath: f.repo,
    stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8] });
  const r = spawnSync(process.execPath, [MARKER, 'complete-step', '8'], { ...markerEnv(SID, fakeHome) });
  assert.notEqual(r.status, 0, 'sin el artefacto no se cierra el step');
  assert.match(r.stderr, /FALTA el findings\.json/);
  assert.match(r.stderr, /write-findings --story/, 'dice el comando exacto, no «escribilo»');
  const l = gatesLines(fakeHome).filter((g) => g.name === 'findings-json');
  assert.equal(l.length, 1, 'el bloqueo queda medido');
  assert.equal(l[0].action, 'bloqueo');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('complete-step 8: findings.json que no es un array JSON → BLOQUEA (un archivo roto no es evidencia)', () => {
  const { spawnSync } = require('node:child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-find-roto-'));
  const SID = 'find-roto';
  const f = repoConRunDir(fakeHome, { findings: '{"no": "es un array"}' });
  writeFakeMarker(fakeHome, SID, { storyId: '9.9', storyPath: f.storyPath, repoPath: f.repo,
    stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8] });
  const r = spawnSync(process.execPath, [MARKER, 'complete-step', '8'], { ...markerEnv(SID, fakeHome) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /NO es un array JSON válido/);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('complete-step 8: findings.json VACÍO (`[]`) pasa este gate — un run sin hallazgos igual lo escribe', () => {
  const { spawnSync } = require('node:child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-find-vacio-'));
  const SID = 'find-vacio';
  const f = repoConRunDir(fakeHome, { findings: '[]' });
  writeFakeMarker(fakeHome, SID, { storyId: '9.9', storyPath: f.storyPath, repoPath: f.repo,
    stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8] });
  const r = spawnSync(process.execPath, [MARKER, 'complete-step', '8'], { ...markerEnv(SID, fakeHome) });
  assert.doesNotMatch(r.stderr || '', /findings\.json/, 'con el artefacto presente este gate no dice nada');
  assert.equal(gatesLines(fakeHome).filter((g) => g.name === 'findings-json').length, 0);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('complete-step 8: SIN run dir no bloquea por findings, pero lo DICE y lo anota («no pude mirar» ≠ «está»)', () => {
  const { spawnSync } = require('node:child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-find-sinrd-'));
  const SID = 'find-sinrd';
  const repo = path.join(fakeHome, 'repo'); fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const storyPath = path.join(repo, 'specs', 'story-9.9.md');
  fs.writeFileSync(storyPath, '---\nstory: "9.9"\nepic: "9"\nstatus: in-progress\n---\n\n# Story 9.9\n');
  writeFakeMarker(fakeHome, SID, { storyId: '9.9', storyPath, repoPath: repo,
    stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8] });
  const r = spawnSync(process.execPath, [MARKER, 'complete-step', '8'], { ...markerEnv(SID, fakeHome) });
  assert.doesNotMatch(r.stderr || '', /BLOQUEADO — FALTA el findings/, 'sin run dir no hay dónde buscar: no frena por eso');
  assert.match(r.stderr || '', /no pude mirar el findings\.json/);
  const l = gatesLines(fakeHome).filter((g) => g.name === 'findings-json');
  assert.equal(l.length, 1); assert.equal(l[0].action, 'no-medido');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── La salida del portón de cierre para una story EXENTA dice un comando que existe ──────────────
// Ni «setear marker.dodRuntimeChecked=true manualmente con set» (Step 8) ni «set dodRuntimeChecked a mano» (rechazo
// de UI) son un comando: el dev lo descubriría probando. Los mensajes indican uno que existe, sin agregar
// una salida nueva (una salida más fácil es un freno más flojo).
test('dod: el bloqueo del Step 8 indica el camino real de la exención, y ese camino funciona', () => {
  const { spawnSync } = require('node:child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dod-exenta-'));
  const SID = 'dod-exenta';
  writeFakeMarker(fakeHome, SID, { storyPath: '/no/existe/story.md', stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8] });
  const r = spawnSync(process.execPath, [MARKER, 'complete-step', '8'], { ...markerEnv(SID, fakeHome) });
  assert.equal(r.status, 2, 'sin DoD sigue bloqueando');
  assert.doesNotMatch(r.stderr, /manualmente con set|a mano/, 'no manda a editar el estado a mano');
  assert.match(r.stderr, /dod_runtime_exempt_reason/, 'pide el motivo de la exención');
  assert.match(r.stderr, /mark-dod-runtime-checked '\{"verdict":"PASS","evidencePath":"exenta:/, 'y el comando exacto');
  // El comando que el mensaje indica, tal cual, destraba una story sin UI.
  const cmd = r.stderr.match(/mark-dod-runtime-checked '(\{"verdict":"PASS","evidencePath":"exenta:[^']*\})'/);
  assert.ok(cmd, 'el comando se puede copiar del mensaje');
  const ok = spawnSync(process.execPath, [MARKER, 'mark-dod-runtime-checked', cmd[1]], { ...markerEnv(SID, fakeHome) });
  assert.equal(ok.status, 0);
  const m = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'active', `${SID}.json`), 'utf8'));
  assert.equal(m.dodRuntimeChecked, true);
  assert.match(m.dodRuntime.evidencePath, /^exenta:/, 'la exención queda escrita como tal, no como una verificación');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── Código que entra DESPUÉS de la última ronda de revisores ──────────────────────────────────────
// Caso: una migración escrita cinco horas después de la última ronda entra al commit sin otra; si trae un error de
// sintaxis, frena el despliegue.
const postRev = require(path.join(SCRIPTS, 'lib', 'post-revision.js'));

test('post-revision: nombra el código stageado que se editó después de la última ronda, y nada más', () => {
  const repo = '/r/PluginHost';
  const r = postRev.archivosSinRevisar({
    iterations: { 1: { ts: '2026-09-10T20:27:00.000Z' }, 3: { ts: '2026-09-10T21:39:39.000Z' }, 2: { ts: '2026-09-10T21:14:37.000Z' } },
    events: [
      { path: `${repo}/custom-forms/Services/PluginManager.cs`, ts: '2026-09-10T21:05:00.000Z' },       // antes de la ronda 3
      { path: `${repo}/custom-forms/database/054_Cleanup.sql`, ts: '2026-09-11T02:07:31.000Z' },       // el caso real
      { path: `${repo}/custom-forms/Services/Retry.cs`, ts: '2026-09-10T21:00:00.000Z' },
      { path: `${repo}/custom-forms/Services/Retry.cs`, ts: '2026-09-10T22:51:00.000Z' },              // re-editado después
      { path: `${repo}/spec/stories/story-7.7.md`, ts: '2026-09-11T02:10:00.000Z' },                  // la story: no es código
      { path: `${repo}/custom-forms/Services/NoStageado.cs`, ts: '2026-09-11T02:00:00.000Z' },        // tocado pero fuera del commit
    ],
    staged: ['custom-forms/Services/PluginManager.cs', 'custom-forms/database/054_Cleanup.sql',
      'custom-forms/Services/Retry.cs', 'spec/stories/story-7.7.md'],
    repoRoot: repo,
  });
  assert.equal(r.iter, 3, 'compara contra la última ronda');
  assert.deepEqual(r.archivos, ['custom-forms/Services/Retry.cs', 'custom-forms/database/054_Cleanup.sql']);
  assert.match(postRev.mensaje(r), /054_Cleanup\.sql/);
  assert.match(postRev.mensaje(r), /smart-reloop --iter 4/);
  // Sin rondas registradas no hay con qué comparar: no es una corrida del pipeline.
  assert.equal(postRev.archivosSinRevisar({ iterations: {}, events: [], staged: ['a.cs'], repoRoot: repo }), null);
});

test('post-revision: END-TO-END — el hook de commit avisa, no frena, y lo mide', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'postrev-'));
  const repo = path.join(fakeHome, 'repo');
  fs.mkdirSync(path.join(repo, 'database'), { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const SID = 'sess-postrev';
  writeFakeMarker(fakeHome, SID, { repoPath: repo, storyId: '7.7', iterations: { 1: { ts: '2026-09-10T21:39:39.000Z', filesSnapshot: [] } } });
  fs.writeFileSync(path.join(repo, 'database', '054_Cleanup.sql'), 'PRINT (SELECT 1);\n');
  execFileSync(process.execPath, [path.join(SCRIPTS, 'on-edit.js')], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', session_id: SID,
      tool_input: { file_path: path.join(repo, 'database', '054_Cleanup.sql') } }),
    env: { ...process.env, HOME: fakeHome }, encoding: 'utf8', stdio: 'pipe',
  });
  git('add', 'database/054_Cleanup.sql');
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, 'on-pre-commit.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: SID, cwd: repo,
      tool_input: { command: 'git commit -m "x"' } }),
    env: { ...process.env, HOME: fakeHome }, cwd: repo, encoding: 'utf8',
  });
  assert.match(res.stderr || '', /tycon-post-revision/, 'el aviso sale por stderr');
  assert.match(res.stderr || '', /054_Cleanup\.sql/, 'y nombra el archivo que nadie revisó');
  assert.equal(res.status, 0, 'avisa, no frena');
  const e = gatesLines(fakeHome).find((g) => g.name === 'post-revision-commit');
  assert.ok(e, 'queda medido en gates.log');
  assert.equal(e.storyId, '7.7');
  assert.deepEqual(e.archivos, ['database/054_Cleanup.sql']);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('marker.adversarial: sobrevive a set (misma story) + complete-step, y se RESETEA al cambiar de story', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-adv-life-'));
  const SID = 'adv-life';
  writeFakeMarker(fakeHome, SID, { deepReviewDone: true, checks: { build: 'green' } });
  execFileSync(process.execPath, [MARKER, 'mark-adversarial-launched', 'wf_1', '4'], markerEnv(SID, fakeHome));
  // set de la MISMA story (corrección de path) → preserva.
  const same = JSON.parse(execFileSync(process.execPath, [MARKER, 'set', JSON.stringify({ storyId: 'A', storyPath: '/abs/a.md' })], markerEnv(SID, fakeHome)));
  assert.equal(same.adversarial.runId, 'wf_1', 'set misma story preserva adversarial');
  execFileSync(process.execPath, [MARKER, 'complete-step', '6'], markerEnv(SID, fakeHome));
  const afterStep = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'active', `${SID}.json`), 'utf8'));
  assert.equal(afterStep.adversarial.runId, 'wf_1', 'complete-step preserva adversarial');
  // set de OTRA story sin clear (pipeline cancelado y se encadena la siguiente) → RESET del ciclo
  // de vida (sin esto, la story B hereda deepReviewDone=true → su 5b se saltea ENTERO en silencio,
  // checks.build=green heredado → gates mintiendo).
  const other = JSON.parse(execFileSync(process.execPath, [MARKER, 'set', JSON.stringify({ storyId: 'B', storyPath: 'specs/b.md' }), '--replace'], markerEnv(SID, fakeHome)));
  assert.equal(other.adversarial, undefined, 'story nueva NO hereda adversarial');
  assert.equal(other.deepReviewDone, undefined, 'story nueva NO hereda deepReviewDone (su 5b debe correr)');
  assert.equal(other.checks, undefined, 'story nueva NO hereda checks verdes');
  assert.deepEqual(other.stepsCompleted, [], 'story nueva arranca sin steps completados');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('marker: el storyPath RELATIVO del marker se resuelve contra repoPath (no contra el cwd)', () => {
  // 🔴 `pipeline.js start` guarda `storyPath` RELATIVO al repo. Tres sitios lo resuelven contra el repo en vez de
  // hacer `fs.existsSync(marker.storyPath)` crudo, que falla salvo que el proceso corra parado justo en la raíz
  // del repo: el gate de `complete-step 8`, el check de la guía de QA, y el fallback de `runtime-waiver` — que
  // además culparía al marker ("el marker no lo tiene") cuando el marker SÍ lo tiene, solo que relativo.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-relpath-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-relrepo-'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'specs', 'story.md'), '---\nstory: "9.9"\nstatus: review\n---\n# x\n');
  const activeDir = path.join(fakeHome, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const SID = 'relpath-smoke';
  fs.writeFileSync(path.join(activeDir, `${SID}.json`), JSON.stringify({
    storyId: '9.9', storyPath: 'specs/story.md', repoPath: repo, sessionId: SID,
    lastTouch: new Date().toISOString(), stepsCompleted: [], stepsPending: [8],
  }));

  // `runtime-waiver` sin argumento, corriendo desde un cwd que NO es el repo (el caso habitual).
  // Tiene que pasar el chequeo de existencia y morir recién en el candado de TTY — o sea que
  // ENCONTRÓ la story. Si no, muere antes, en "no encuentro la story".
  let salida = '';
  try {
    require('child_process').execFileSync(
      process.execPath, [path.join(SCRIPTS, 'marker.js'), 'runtime-waiver'],
      { env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: SID }, cwd: os.tmpdir(), encoding: 'utf8', stdio: 'pipe' }
    );
  } catch (e) {
    salida = `${e.stdout || ''}${e.stderr || ''}`;
  }
  assert.ok(!/no encuentro la story/.test(salida), `resolvió el path relativo contra repoPath — salida:\n${salida}`);
  assert.match(salida, /BLOQUEADO — acá no hay una terminal/, 'llegó hasta el candado TTY (que es donde debe morir sin terminal)');

  // Y el mensaje de error, cuando de verdad no hay story, NO manda a un flag inexistente.
  fs.writeFileSync(path.join(activeDir, `${SID}.json`), JSON.stringify({
    storyId: '9.9', storyPath: 'specs/no-existe.md', repoPath: repo, sessionId: SID,
    lastTouch: new Date().toISOString(), stepsCompleted: [], stepsPending: [8],
  }));
  let err = '';
  try {
    require('child_process').execFileSync(
      process.execPath, [path.join(SCRIPTS, 'marker.js'), 'runtime-waiver'],
      { env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: SID }, cwd: os.tmpdir(), encoding: 'utf8', stdio: 'pipe' }
    );
  } catch (e) {
    err = `${e.stdout || ''}${e.stderr || ''}`;
  }
  // Lo que se prohíbe es PRESCRIBIR el flag (`--story <algo>`), no mencionarlo: el mensaje
  // dice "no hay flag `--story`" a propósito, para desarmar la expectativa del que ya se lo cree.
  // (Un guard que busca un LITERAL también encuentra el texto que habla de ese literal.)
  assert.ok(!/--story\s+[<`'"]/.test(err), 'el mensaje NO prescribe un flag `--story` que no existe');
  assert.match(err, /no hay flag/, 'y desarma explícitamente esa expectativa');
  assert.match(err, /POSICIONAL/, 'dice que el argumento es posicional');
  assert.match(err, /specs\/no-existe\.md/, 'y muestra QUÉ recibió, en vez de culpar al marker');

  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

// ── Freno ATDD (tests antes que código) ─────────────────────────────────────────────────────────────────────
// Sin gate mecánico el ATDD sería la regla que se saltea: detectarlo dependería de un humano leyendo el
// transcript. Estos tests son la red del gate — y sí, se escribieron ANTES de dar el gate por bueno, que es
// exactamente lo que el gate exige.
const atdd = require(path.join(SCRIPTS, 'lib', 'atdd-order.js'));

test('atdd: clasificación de paths test vs implementación', () => {
  for (const p of [
    'mcp/tests/unit/cableado.test.js', 'src/__tests__/foo.ts', 'a/foo.spec.tsx',
    'Proyecto.Tests/FooTests.cs', 'pkg/foo_test.go', 'app/test_foo.py', 'x/spec/bar.js',
  ]) {
    assert.ok(atdd.isTestPath(p), `${p} es test`);
    assert.ok(!atdd.isImplPath(p), `${p} NO cuenta como implementación`);
  }
  for (const p of ['mcp/src/generation/ir.ts', 'src/App.tsx', 'Features/Svc.cs', 'lib/x.mjs']) {
    assert.ok(atdd.isImplPath(p), `${p} es implementación`);
    assert.ok(!atdd.isTestPath(p), `${p} NO es test`);
  }
  // Docs, specs y datos NO son implementación — una story de doctrina no puede quedar bloqueada.
  for (const p of ['specs/story.md', 'catalog/x.yaml', 'database/001.sql', 'fixtures/golden.json']) {
    assert.ok(!atdd.isImplPath(p), `${p} no gatea`);
  }
  // Windows: los eventos llegan con backslash.
  assert.ok(atdd.isTestPath('mcp\\tests\\unit\\foo.test.js'), 'path de Windows');
});

test('atdd: BLOQUEA cuando el código va primero (el caso de la Story 3.21)', () => {
  const r = atdd.computeAtddOrder([
    { path: '/r/mcp/src/generation/ir.ts', ts: '2026-07-27T18:00:00.000Z' },
    { path: '/r/mcp/tests/unit/cableado.test.js', ts: '2026-07-27T19:00:00.000Z' },
  ]);
  assert.equal(r.verdict, 'blocked');
  assert.match(r.reason, /CÓDIGO/);
  // El mensaje tiene que decir QUÉ pasó, POR QUÉ frena y CÓMO seguir — incluido el escape explícito.
  const msg = atdd.atddBlockMessage(r);
  assert.match(msg, /ir\.ts/);
  assert.match(msg, /cableado\.test\.js/);
  assert.match(msg, /--no-atdd/, 'ofrece el escape consciente');
  assert.match(msg, /bypass\.log/, 'y dice que queda registrado');
});

test('atdd: verde cuando el test va primero', () => {
  const r = atdd.computeAtddOrder([
    { path: '/r/mcp/tests/unit/cableado.test.js', ts: '2026-07-27T18:00:00.000Z' },
    { path: '/r/mcp/src/generation/ir.ts', ts: '2026-07-27T19:00:00.000Z' },
  ]);
  assert.equal(r.verdict, 'green');
});

test('atdd: empate de timestamp desempata por orden de registro (el orden real del hook)', () => {
  const ts = '2026-07-27T18:00:00.000Z';
  assert.equal(atdd.computeAtddOrder([
    { path: '/r/tests/a.test.js', ts }, { path: '/r/src/a.ts', ts },
  ]).verdict, 'green');
  assert.equal(atdd.computeAtddOrder([
    { path: '/r/src/a.ts', ts }, { path: '/r/tests/a.test.js', ts },
  ]).verdict, 'blocked');
});

test('atdd: NO bloquea los casos que serían falsos positivos', () => {
  // Refactor con red preexistente: toca código y ningún test. Es legítimo — avisa, no bloquea.
  // Un gate con falsos positivos se termina desactivando.
  assert.equal(atdd.computeAtddOrder([{ path: '/r/src/a.ts', ts: '2026-07-27T18:00:00.000Z' }]).verdict, 'warn-no-tests');

  // 🔴 Los archivos de FUERA del repo de la story no cuentan como implementación.
  // Ejemplo: la Task 1 es una SALVAGUARDA —verificar que las anclas que la story cita sigan existiendo— y su
  // sonda de diagnóstico es un `.mjs` en el scratchpad de la sesión, fuera del repo. Contarla como "primer
  // archivo de código" bloquearía una corrida cuyo orden real, dentro del repo, es correcto. Es la MISMA clase
  // de falso positivo que las stories `.md` bajo `specs/`.
  // Toda story que arranque con una salvaguarda o una medición va a escribir un script de
  // diagnóstico antes que cualquier test — y eso NO es implementar primero.
  {
    const fuera = '/private/tmp/claude-501/xyz/scratchpad/sonda-anclas.mjs';
    const evs = [
      { path: fuera, ts: '2026-08-04T19:40:00.000Z' },
      { path: '/r/tests/a.test.js', ts: '2026-08-04T21:15:00.000Z' },
      { path: '/r/src/a.ts', ts: '2026-08-04T21:20:00.000Z' },
    ];
    assert.equal(atdd.computeAtddOrder(evs).verdict, 'blocked', 'sin repoPath: el comportamiento de siempre (compat)');
    const conRepo = atdd.computeAtddOrder(evs, '/r');
    assert.equal(conRepo.verdict, 'green', 'con repoPath: la sonda de afuera no cuenta, el orden real es correcto');
    assert.equal(conRepo.firstImpl, '/r/src/a.ts', 'y el primer código es el de ADENTRO');
    // Y no se vuelve un colador: si el código de adentro va primero, sigue bloqueando.
    assert.equal(atdd.computeAtddOrder([
      { path: fuera, ts: '2026-08-04T19:40:00.000Z' },
      { path: '/r/src/a.ts', ts: '2026-08-04T21:00:00.000Z' },
      { path: '/r/tests/a.test.js', ts: '2026-08-04T21:15:00.000Z' },
    ], '/r').verdict, 'blocked', 'el filtro no afloja el gate: adentro, código antes que test sigue bloqueando');
  }
  // Story de doctrina/specs: cero código → nada que gatear.
  assert.equal(atdd.computeAtddOrder([
    { path: '/r/skill/generation.md', ts: '2026-07-27T18:00:00.000Z' },
    { path: '/r/specs/story.md', ts: '2026-07-27T18:30:00.000Z' },
  ]).verdict, 'green');
  // Sin evidencia no se puede AFIRMAR una violación — pero tampoco se calla.
  assert.equal(atdd.computeAtddOrder([]).verdict, 'warn-unknown');
  assert.equal(atdd.computeAtddOrder(undefined).verdict, 'warn-unknown');
  // Eventos corruptos se ignoran sin romper.
  assert.equal(atdd.computeAtddOrder([{ path: 42 }, null, { ts: 'x' }]).verdict, 'warn-unknown');
});


test('@story-7.26 atdd: en una story de dos repos cuenta el repo hermano declarado (antes: «ningún fileEvent cae dentro»)', () => {
  // La story puede vivir en el backend y el código en el frontend: con una sola raíz, toda edición del hermano
  //    queda afuera y el portón no gatea nada.
  const ts = (m) => `2026-10-15T12:${String(m).padStart(2, '0')}:00.000Z`;
  const raices = ['/back', '/front'];
  const primeroElCodigo = [{ path: '/front/src/pantalla.tsx', ts: ts(1) }, { path: '/front/src/pantalla.test.tsx', ts: ts(2) }];
  assert.equal(atdd.computeAtddOrder(primeroElCodigo, '/back').verdict, 'warn-unknown', 'con una sola raíz, el hermano no cuenta');
  assert.equal(atdd.computeAtddOrder(primeroElCodigo, raices).verdict, 'blocked', 'con el hermano, el código antes que el test frena');
  const primeroElTest = [{ path: '/front/src/pantalla.test.tsx', ts: ts(1) }, { path: '/front/src/pantalla.tsx', ts: ts(2) }];
  assert.equal(atdd.computeAtddOrder(primeroElTest, raices).verdict, 'green');
  const conSonda = [{ path: '/tmp/sonda.mjs', ts: ts(0) }, ...primeroElTest];
  assert.equal(atdd.computeAtddOrder(conSonda, raices).verdict, 'green', 'lo de fuera de las dos raíces sigue sin contar');
});
test('atdd: el gate corre de verdad en `complete-step 4` y el bypass queda logueado', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atdd-home-'));
  const SID = 'sess-atdd-1';
  const stateDir = path.join(fakeHome, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(stateDir, 'active'), { recursive: true });
  const markerPath = path.join(stateDir, 'active', `${SID}.json`);
  const escribirMarker = () => fs.writeFileSync(markerPath, JSON.stringify({
    storyId: '9.9', storyPath: 'specs/x.md', stepsPending: [4], stepsCompleted: [], lastTouch: new Date().toISOString(),
    fileEvents: [
      { path: '/r/src/a.ts', ts: '2026-07-27T18:00:00.000Z' },
      { path: '/r/tests/a.test.js', ts: '2026-07-27T19:00:00.000Z' },
    ],
  }), 'utf8');
  const correr = (extra) => {
    const args = [path.join(SCRIPTS, 'marker.js'), 'complete-step', '4', ...extra];
    try {
      const out = require('child_process').execFileSync(process.execPath, args, {
        env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: SID },
        cwd: os.tmpdir(), encoding: 'utf8', stdio: 'pipe',
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };

  escribirMarker();
  const bloqueado = correr([]);
  assert.notEqual(bloqueado.code, 0, 'sin el flag, BLOQUEA de verdad (exit != 0)');
  assert.match(bloqueado.out, /BLOQUEADO/);
  assert.match(bloqueado.out, /a\.ts/);

  escribirMarker();
  const conFlag = correr(['--no-atdd']);
  assert.equal(conFlag.code, 0, 'con --no-atdd pasa');
  const bypassLog = fs.readFileSync(path.join(stateDir, 'bypass.log'), 'utf8');
  assert.match(bypassLog, /ATDD_BYPASS/, 'y el bypass queda registrado, no es silencioso');
  const gatesLog = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8');
  assert.match(gatesLog, /"name":"atdd"/, 'el veredicto queda medido en gates.log');

  fs.rmSync(fakeHome, { recursive: true, force: true });
});


const commitGate = require(path.join(SCRIPTS, 'lib', 'atdd-commit-gate.js'));

test('atdd-commit-gate: bloquea sólo la inversión inequívoca, y sólo si el repo lo pidió', () => {
  // 🔴 Los veredictos se DERIVAN de computeAtddOrder, no se fabrican a mano. Inventar `{blocking:true, firstCode}` —
  // una forma que la función real nunca devuelve (usa `{verdict:'blocked', firstImpl}`)— pasaría en verde
  // mientras el gate está mudo.
  // Es exactamente el defecto que el test-primero previene: con el test escrito antes, el contrato
  // hay que ir a leerlo.
  const ev = (p, ts) => ({ path: p, ts: new Date(ts).toISOString() });
  const inverted = atdd.computeAtddOrder([ev('/r/a.ts', 1000), ev('/r/a.test.ts', 2000)]);
  const clean = atdd.computeAtddOrder([ev('/r/a.test.ts', 1000), ev('/r/a.ts', 2000)]);
  const noTests = atdd.computeAtddOrder([ev('/r/a.ts', 1000)]);
  assert.equal(inverted.verdict, 'blocked');
  assert.equal(clean.verdict, 'green');
  assert.equal(noTests.verdict, 'warn-no-tests');

  assert.equal(commitGate.computeCommitGate({ verdict: inverted, mode: 'warn' }).action, 'warn',
    'default = avisa (un gate que bloquea de más se termina apagando)');
  assert.equal(commitGate.computeCommitGate({ verdict: inverted, mode: 'block' }).action, 'block',
    'el repo puede subir la vara a bloqueo');
  assert.equal(commitGate.computeCommitGate({ verdict: clean, mode: 'block' }).action, 'pass',
    'orden correcto pasa siempre');
  assert.equal(commitGate.computeCommitGate({ verdict: noTests, mode: 'block' }).action, 'pass',
    'código sin tests NO bloquea: un refactor con red preexistente es legítimo');
  assert.equal(commitGate.computeCommitGate({ verdict: inverted, mode: 'off' }).action, 'pass',
    'opt-out total');
  assert.match(commitGate.computeCommitGate({ verdict: inverted, mode: 'warn' }).message, /a\.test\.ts/,
    'el mensaje nombra los dos archivos, para poder actuar');
  assert.match(commitGate.computeCommitGate({ verdict: inverted, mode: 'warn' }).message, /a\.ts/);
});

test('atdd-commit-gate: registra eventos de edición aunque NO haya marker de pipeline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-'));
  commitGate.recordFileEvent(dir, 'sess-1', '/repo/src/a.ts', 1000);
  commitGate.recordFileEvent(dir, 'sess-1', '/repo/src/a.test.ts', 2000);
  commitGate.recordFileEvent(dir, 'sess-2', '/repo/src/otro.ts', 1500);
  // El `ts` se normaliza a ISO: computeAtddOrder descarta los que no sean string.
  assert.equal(typeof commitGate.readFileEvents(dir, 'sess-1')[0].ts, 'string');

  const eventos = commitGate.readFileEvents(dir, 'sess-1');
  assert.equal(eventos.length, 2, 'sólo los de su sesión');
  assert.equal(eventos[0].path, '/repo/src/a.ts');
  assert.ok(eventos[0].ts < eventos[1].ts, 'conserva el orden con timestamp');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('atdd-commit-gate: al commitear se limpian SOLO los eventos de ese repo', () => {
  // Una sesión toca varios repos (hoy: BackEnd, FrontEnd y el propio harness). Si al commitear en
  // uno se borraran todos, el commit siguiente en OTRO repo quedaría sin gate.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev2-'));
  commitGate.recordFileEvent(dir, 's', '/repos/back/src/a.ts', 1);
  commitGate.recordFileEvent(dir, 's', '/repos/front/src/b.ts', 2);
  commitGate.recordFileEvent(dir, 's', '/repos/back/src/a.test.ts', 3);

  commitGate.pruneFileEvents(dir, 's', '/repos/back');

  const quedan = commitGate.readFileEvents(dir, 's');
  assert.equal(quedan.length, 1, 'sobrevive lo del otro repo');
  assert.equal(quedan[0].path, '/repos/front/src/b.ts');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('atdd-commit-gate: el veredicto se computa SOLO sobre los archivos del repo que se commitea', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev3-'));
  commitGate.recordFileEvent(dir, 's', '/repos/otro/src/x.ts', 1);       // ruido de otro repo
  commitGate.recordFileEvent(dir, 's', '/repos/back/src/a.test.ts', 2);  // test primero ✅
  commitGate.recordFileEvent(dir, 's', '/repos/back/src/a.ts', 3);

  const eventos = commitGate.eventsForRepo(dir, 's', '/repos/back');
  assert.equal(eventos.length, 2);
  const veredicto = atdd.computeAtddOrder(eventos);
  assert.ok(!veredicto.blocking, 'dentro del repo el orden fue correcto');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('atdd-commit-gate: END-TO-END — editar código y DESPUÉS el test avisa al commitear', () => {
  // Ejercita los binarios de verdad (on-edit.js + on-pre-commit.js), no las funciones sueltas:
  // el hueco que cubre no es una función mal escrita sino un cableado que no existe.
  const { execFileSync } = require('node:child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atddE2E-'));
  const repo = path.join(fakeHome, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const SID = 'sess-e2e';

  const edit = (file) => execFileSync(process.execPath, [path.join(SCRIPTS, 'on-edit.js')], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: SID,
      tool_input: { file_path: path.join(repo, file) },
    }),
    env: { ...process.env, HOME: fakeHome }, encoding: 'utf8', stdio: 'pipe',
  });

  edit('src/a.ts');        // ← código primero
  edit('src/a.test.ts');   // ← test después: la inversión

  // spawnSync y no execFileSync: en modo `warn` el hook sale con 0, y execFileSync sólo devuelve
  // stderr cuando TIRA. Con execFileSync el assert del mensaje pasaba en verde sin haberlo visto.
  const { spawnSync } = require('node:child_process');
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, 'on-pre-commit.js')], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: SID, cwd: repo,
      tool_input: { command: 'git commit -m "x"' },
    }),
    env: { ...process.env, HOME: fakeHome }, cwd: repo, encoding: 'utf8',
  });
  assert.match(res.stderr || '', /ATDD/, 'el aviso sale por stderr, que es lo que ve el agente');
  assert.match(res.stderr || '', /a\.test\.ts/, 'y nombra el test que llegó tarde');
  assert.equal(res.status, 0, 'en modo warn NO bloquea el commit');

  const gatesLog = fs.readFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8');
  assert.match(gatesLog, /"name":"atdd-commit"/, 'el veredicto queda medido');
  assert.match(gatesLog, /"action":"warn"/, 'default = avisa');
  assert.match(gatesLog, /a\.test\.ts/, 'nombra el test que llegó tarde');
  // El namespace por repo lo llevan TODOS los escritores del
  // log, no sólo marker.js — el capturer agrupa por `repoPath` y una entry sin él se mezcla entre repos.
  const atddEntry = gatesLog.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.name === 'atdd-commit');
  assert.ok(atddEntry && atddEntry.repoPath, 'la entry atdd-commit lleva repoPath');
  assert.equal(fs.realpathSync(atddEntry.repoPath), fs.realpathSync(repo));

  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── Guía de QA: el commit avisa si la story cambió y la guía no ──────────────────────────────
// Salirse del pipeline apaga una garantía EN SILENCIO: pasa con el gate de ATDD, con el aviso de "story sin
// pipeline" y con la guía de QA — que la genera un paso del pipeline (`qa-guide.js`, regla DODRT-C7).
// Trabajando a mano se escribiría una a mano, con otro formato y sin derivar de los ACs. El commit AVISA,
// no la genera solo: generarla solo volvería a esconder que te saliste del pipeline.

test('qa-guide gate: avisa cuando falta la guía o quedó vieja, y calla cuando está al día', () => {
  const g = commitGate.computeQaGuideStatus;

  assert.equal(g({ hasAcs: true, guideExists: false, guideOlderThanStory: false }), 'missing');
  assert.equal(g({ hasAcs: true, guideExists: true, guideOlderThanStory: true }), 'stale');
  assert.equal(g({ hasAcs: true, guideExists: true, guideOlderThanStory: false }), 'ok');
  // Una story sin criterios de aceptación no tiene nada que guiar (specs, docs, config).
  assert.equal(g({ hasAcs: false, guideExists: false, guideOlderThanStory: false }), 'ok');
});

// ── La guía sólo se exige si hay algo que una PERSONA pueda operar ───────────────────────────────
// Ejemplo: un paquete cuyo único cliente es un agente, sin una sola pantalla. Una guía que hable de "usuarios" y
// "roles" inexistentes, mientras lo que de verdad verifica los criterios es un smoke contra el binario publicado,
// no sirve de nada. Un aviso que pide algo sin sentido se aprende a ignorar, y se lleva puestos a los que sí
// importan.

test('qa-guide gate: sin superficie operable a mano NO se pide la guía; con superficie sí', () => {
  const g = commitGate.computeQaGuideStatus;
  const base = { hasAcs: true, guideExists: false, guideOlderThanStory: false };

  assert.equal(g({ ...base, handOperable: false }), 'ok', 'librería sin pantalla ni endpoints → sin aviso');
  assert.equal(g({ ...base, handOperable: true }), 'missing', 'con superficie operable el aviso sigue igual que antes');
  // Aditivo: omitir el campo preserva EXACTO el comportamiento anterior.
  assert.equal(g(base), 'missing', 'sin declarar handOperable, el default es pedirla (no se afloja nada)');
});

test('qa-guide gate: el repo puede apagarla o forzarla desde .tycon/advisors.yaml', () => {
  const g = commitGate.computeQaGuideStatus;
  const base = { hasAcs: true, guideExists: false, guideOlderThanStory: false, handOperable: true };

  assert.equal(g({ ...base, mode: 'off' }), 'ok', "'off' apaga el aviso aunque haya superficie");
  assert.equal(g({ ...base, handOperable: false, mode: 'always' }), 'missing', "'always' la exige aunque no haya superficie");
  assert.equal(g({ ...base, mode: 'auto' }), 'missing', "'auto' se comporta como el default");

  const m = commitGate.qaGuideMode;
  assert.equal(m('qa_guide: off\n'), 'off');
  assert.equal(m('e2e:\n  gate: x\nqa_guide: always\n'), 'always');
  assert.equal(m('# qa_guide: off\ne2e:\n  gate: x\n'), 'auto', 'un comentario NO cuenta como declaración');
  assert.equal(m(undefined), 'auto', 'sin archivo → auto');
  assert.equal(m('qa_guide: cualquierada\n'), 'auto', 'valor inválido → auto, no rompe el commit');

  // 🔴 ANIDADO NO APAGA. Un regex que ignorara la indentación (`^\s*qa_guide`) haría que la llave puesta por error
  // dentro de otro bloque apague igual que la puesta a propósito al tope, así que un typo sería indistinguible
  // de una decisión — y el efecto (se cae el aviso de guía + un tercio del aviso de evidencia) es
  // silencioso.
  assert.equal(m('e2e:\n  gate: x.sh\n  qa_guide: off\n'), 'auto',
    'anidada dentro de e2e: NO apaga — en YAML no es una llave del documento');
  assert.equal(m('e2e:\n  forms:\n    - dir: a\n      qa_guide: off\n'), 'auto',
    'anidada en un item de lista tampoco');
  assert.equal(m('e2e:\n  gate: x.sh\n  qa_guide: always\n'), 'auto',
    'y tampoco FUERZA la guía desde adentro de otro bloque');
  // No-regresión del uso legítimo: al tope sigue valiendo, esté donde esté en el archivo.
  assert.equal(m('e2e:\n  gate: x.sh\nqa_guide: off\n'), 'off',
    'al primer nivel, después de otro bloque, sigue apagando');
  assert.equal(m('qa_guide: off  # nada operable a mano en este repo\n'), 'off',
    'con comentario inline sigue funcionando');
});

test('qa-guide gate: detecta superficie operable por UI, por HTTP, y se calla sólo si no hay ninguna', () => {
  const h = commitGate.storyIsHandOperable;
  const story = (fm, body = 'texto') => `---\n${fm}\n---\n\n${body}\n`;

  assert.equal(h(story('files_to_modify:\n  - "src/components/Tabla.tsx"')), true, 'UI por extensión');
  assert.equal(h(story('files_to_modify:\n  - "CeiboFrontEnd/x.ts"')), true, 'UI por ruta conocida');
  assert.equal(h(story('files_to_modify:\n  - "x.md"', 'Escenario E2E-1: el usuario abre...')), true, 'E2E declarado en el cuerpo');
  assert.equal(h(story('files_to_modify:\n  - "src/Features/Pedidos/Api/Endpoints.cs"')), true, 'backend con endpoints');
  assert.equal(h(story('files_to_modify:\n  - "src/lib/x.ts"', 'Se prueba con `curl http://localhost:5001/api/x`')), true, 'HTTP en el cuerpo');

  // Un MCP: serialización, catálogo YAML y doctrina en markdown.
  assert.equal(
    h(story('files_to_modify:\n  - "mcp/src/generation/serialize.ts"\n  - "mcp/catalog/curated/email.yaml"',
            'El generador emite el email como sendTask.')),
    false,
    'librería sin pantalla ni superficie HTTP → NO es operable a mano',
  );
  // Fail-safe: ante texto vacío o basura, pedirla igual (nunca callarse por no saber).
  assert.equal(h(''), true, 'sin texto → default ruidoso');
  assert.equal(h(null), true, 'entrada inválida → default ruidoso');
});

test('qa-guide gate: el mensaje trae el comando exacto para generarla', () => {
  const msg = commitGate.qaGuideMessage('missing', {
    storyPath: '/r/specs/e/stories/S1.md',
    guidePath: '/r/specs/e/qa/S1-guia-qa.html',
  });
  assert.match(msg, /qa-guide\.js --story/, 'dice CÓMO generarla, no sólo que falta');
  assert.match(msg, /S1\.md/);
  assert.equal(commitGate.qaGuideMessage('ok', {}), '', 'sin hallazgo, sin ruido');
});

test('qa-guide gate: deriva el path de la guía igual que qa-guide.js (hermano qa/ de stories/)', () => {
  assert.equal(
    commitGate.qaGuidePathFor('/r/specs/route-filters/stories/S1-lookup.md'),
    path.join('/r/specs/route-filters/qa', 'S1-lookup-guia-qa.html'),
  );
});

// ── Gate de evidencia de story ────────────────────────────────────────────────────────────────
// Trabajando a mano se pueden pasar TRES cosas distintas sobre la misma story: no generar el archivo de pasos de
// tester, saltear un AC sin verificar, y dejar sin registrar la verificación en navegador. Sin el gate, las tres
// las caza una persona leyendo la guía, no el harness.
// Mismo criterio que los otros gates: AVISA por default, bloquea sólo si el repo lo pide.

const evGate = require(path.join(SCRIPTS, 'lib', 'story-evidence-gate.js'));

test('story-evidence: detecta ACs sin verificar, pasos faltantes y UI sin navegador', () => {
  const todoBien = evGate.computeStoryEvidenceGate({
    pendientes: [], acsSinPasos: [], isUi: true, hasBrowserEvidence: true, mode: 'warn',
  });
  assert.equal(todoBien.action, 'pass');
  assert.deepEqual(todoBien.hallazgos, []);

  const salteados = evGate.computeStoryEvidenceGate({
    pendientes: [4], acsSinPasos: [], isUi: false, hasBrowserEvidence: false, mode: 'warn',
  });
  assert.equal(salteados.action, 'warn');
  assert.match(salteados.hallazgos.join(' '), /AC 4/, 'nombra el AC salteado');

  const sinPasos = evGate.computeStoryEvidenceGate({
    pendientes: [], acsSinPasos: [1, 2], isUi: false, hasBrowserEvidence: false, mode: 'warn',
  });
  assert.match(sinPasos.hallazgos.join(' '), /pasos de tester/i);
  assert.match(sinPasos.hallazgos.join(' '), /1, 2/);

  const uiSinNavegador = evGate.computeStoryEvidenceGate({
    pendientes: [], acsSinPasos: [], isUi: true, hasBrowserEvidence: false, mode: 'warn',
  });
  assert.match(uiSinNavegador.hallazgos.join(' '), /navegador/i);

  // Una story que NO es de interfaz no necesita evidencia de navegador.
  const backend = evGate.computeStoryEvidenceGate({
    pendientes: [], acsSinPasos: [], isUi: false, hasBrowserEvidence: false, mode: 'warn',
  });
  assert.equal(backend.action, 'pass');
});

test('story-evidence: el repo puede subir la vara a bloqueo, y apagarlo del todo', () => {
  const args = { pendientes: [4], acsSinPasos: [], isUi: false, hasBrowserEvidence: false };
  assert.equal(evGate.computeStoryEvidenceGate({ ...args, mode: 'block' }).action, 'block');
  assert.equal(evGate.computeStoryEvidenceGate({ ...args, mode: 'off' }).action, 'pass');
});

test('story-evidence: sabe qué ACs se quedaron sin pasos de tester', () => {
  const pasos = ['## AC 1', 'Hacé esto.', '- Abrí la pantalla.', '  → Se ve la lista.'].join('\n');
  assert.deepEqual(evGate.acsSinPasos([1, 2, 3], pasos), [2, 3]);
  assert.deepEqual(evGate.acsSinPasos([1], pasos), []);
  assert.deepEqual(evGate.acsSinPasos([1, 2], null), [1, 2], 'sin archivo, faltan todos');
});

// 🔴 La escotilla del repo para la guía de QA (`qa_guide: off`, y el `auto` que mira si hay algo operable a mano)
// la respetan los DOS controles: el que genera la guía y el que pide los pasos de tester. Si sólo la respetara
// uno, `storyIsHandOperable` daría `false` para una story de un producto sin pantalla, el generador de la guía
// se callaría bien... y el control de pasos la acusaría igual.
//
// Es exactamente el modo de falla que la calibración de esta familia existe para evitar: un aviso
// que pide algo sin sentido se aprende a ignorar, y se lleva puestos a los que sí importan. Peor
// todavía cuando la escotilla documentada parece existir y sólo funciona a medias — el dev la
// declara, el aviso sigue saliendo, y la conclusión que saca es que el arnés no se puede callar.
// ── La foto del estado auditado se toma sola ─────────────────────────────────────────────────────
// 🔴 La foto (`snapshot-iter N`) no puede depender de que el orquestador se acuerde de tomarla en el único
// momento correcto — ronda de advisors terminada, ANTES del primer fix. Si se olvida, el síntoma es un delta
// vacío en el re-loop y la recuperación a mano es `--force-full-reloop`, o sea el set completo de advisors
// donde el delta real eran dos archivos. El dato para no depender de la memoria ya existe y la foto lo cruza
// sola.
const ronda = require(path.join(SCRIPTS, 'lib', 'advisor-round.js'));

const L = (o) => JSON.stringify(o);

test('advisor-round: la ronda se declara completa sólo cuando corrieron TODOS los esperados', () => {
  const start = L({ event: 'step5-start', expected: ['a', 'b', 'c'], iter: 1 });

  const aMedias = ronda.rondaCompleta([start, L({ advisor: 'a' }), L({ advisor: 'b' })]);
  assert.equal(aMedias.completa, false, 'falta uno → la foto NO se toma todavía');
  assert.deepEqual(aMedias.faltan, ['c']);
  assert.equal(aMedias.iter, 1);

  const entera = ronda.rondaCompleta([start, L({ advisor: 'a' }), L({ advisor: 'b' }), L({ advisor: 'c' })]);
  assert.equal(entera.completa, true);
  assert.deepEqual(entera.faltan, []);
  assert.equal(entera.iter, 1);

  // Repetir un advisor no completa la ronda: se cuenta por advisor distinto, no por spawn.
  const repetido = ronda.rondaCompleta([start, L({ advisor: 'a' }), L({ advisor: 'a' }), L({ advisor: 'a' })]);
  assert.equal(repetido.completa, false, 'tres spawns del MISMO advisor no son tres advisors');
  assert.deepEqual(repetido.faltan, ['b', 'c']);
});

test('advisor-round: manda el ÚLTIMO step5-start — una ronda vieja no completa la nueva', () => {
  const lineas = [
    L({ event: 'step5-start', expected: ['a', 'b'], iter: 1 }),
    L({ advisor: 'a' }), L({ advisor: 'b' }),
    L({ event: 'step5-start', expected: ['a', 'b'], iter: 2 }), // re-loop: arranca de cero
    L({ advisor: 'a' }),
  ];
  const r = ronda.rondaCompleta(lineas);
  assert.equal(r.completa, false, 'los spawns de la iteración anterior NO cuentan para ésta');
  assert.equal(r.iter, 2, 'y la iteración es la del último arranque');
  assert.deepEqual(r.faltan, ['b']);
});

// 🔴 EL TEST QUE MÁS VALE DE ESTE BLOQUE. Sin él, el arreglo REINTRODUCE el bug que viene a cerrar:
// una vez completa, la ronda queda completa para siempre, así que cualquier spawn posterior —un
// agente ad-hoc, una búsqueda— volvería a disparar la foto, ahora con los fixes ya aplicados
// adentro. Que es EXACTAMENTE el estado que produce el delta vacío del re-loop.
test('advisor-round: la foto se toma UNA vez por ronda, no en cada spawn posterior', () => {
  const base = [
    L({ event: 'step5-start', expected: ['a', 'b'], iter: 1 }),
    L({ advisor: 'a' }), L({ advisor: 'b' }),
  ];

  const reciencompleta = ronda.rondaCompleta(base);
  assert.equal(reciencompleta.completa, true);
  assert.equal(reciencompleta.yaFotografiada, false, 'todavía no se sacó → hay que sacarla');

  const despues = ronda.rondaCompleta([...base, L({ event: 'auto-snapshot', iter: 1 })]);
  assert.equal(despues.completa, true);
  assert.equal(despues.yaFotografiada, true, 'ya se sacó → NO se vuelve a sacar');

  // Caso: después de la foto el orquestador arregla y spawnea otra cosa.
  const conSpawnPosterior = ronda.rondaCompleta([
    ...base, L({ event: 'auto-snapshot', iter: 1 }), L({ advisor: 'general-purpose' }),
  ]);
  assert.equal(conSpawnPosterior.yaFotografiada, true,
    '🔴 un spawn posterior NO puede re-disparar la foto: ahí los fixes ya están adentro');

  // Y la ronda SIGUIENTE arranca sin foto, aunque la anterior la tenga.
  const nuevaRonda = ronda.rondaCompleta([
    ...base, L({ event: 'auto-snapshot', iter: 1 }),
    L({ event: 'step5-start', expected: ['a'], iter: 2 }), L({ advisor: 'a' }),
  ]);
  assert.equal(nuevaRonda.completa, true);
  assert.equal(nuevaRonda.yaFotografiada, false, 'la foto de la ronda anterior no cuenta para ésta');
  assert.equal(nuevaRonda.iter, 2);
});

test('advisor-round: nunca inventa una ronda que nadie declaró', () => {
  assert.equal(ronda.rondaCompleta([]).completa, false, 'log vacío');
  assert.equal(ronda.rondaCompleta([L({ advisor: 'a' })]).completa, false, 'spawns sin step5-start');
  assert.equal(ronda.rondaCompleta([L({ event: 'step5-start', iter: 1 })]).completa, false,
    'step5-start sin set esperado → no hay contra qué comparar');
  assert.equal(ronda.rondaCompleta([L({ event: 'step5-start', expected: [], iter: 1 })]).completa, false,
    'set esperado vacío tampoco cuenta como ronda completa');
  assert.equal(ronda.rondaCompleta(null).completa, false, 'entrada inválida no rompe');

  // Una línea corrupta en el medio no puede tirar abajo la detección.
  const conBasura = ronda.rondaCompleta([
    L({ event: 'step5-start', expected: ['a'], iter: 3 }), '{roto', '', L({ advisor: 'a' }),
  ]);
  assert.equal(conBasura.completa, true, 'una línea ilegible se saltea, no rompe la ronda');
  assert.equal(conBasura.iter, 3);
});

test('story-evidence: los pasos de tester se piden SOLO si la guía de QA aplica', () => {
  // El repo apagó la guía → no se piden pasos, aunque la story sea operable a mano.
  assert.equal(evGate.pidePasosDeTester({ qaGuideMode: 'off', handOperable: true }), false);

  // El repo la forzó → se piden igual, aunque no haya nada que operar (es una decisión explícita).
  assert.equal(evGate.pidePasosDeTester({ qaGuideMode: 'always', handOperable: false }), true);

  // `auto` (el default): manda si hay una superficie que una persona pueda manejar.
  assert.equal(evGate.pidePasosDeTester({ qaGuideMode: 'auto', handOperable: true }), true,
    'story con superficie operable — es el caso de la 4.40, adoptar un proceso en TEST');
  assert.equal(evGate.pidePasosDeTester({ qaGuideMode: 'auto', handOperable: false }), false,
    'EL BUG: un producto sin pantalla ni endpoints no tiene pasos de tester que escribir');

  // Fail-open hacia el comportamiento de hoy: sin datos, se pide (nunca se calla por accidente).
  assert.equal(evGate.pidePasosDeTester({}), true, 'sin modo ni señal → se pide, como hasta hoy');
  assert.equal(evGate.pidePasosDeTester(), true, 'llamada sin argumentos → se pide');
  assert.equal(evGate.pidePasosDeTester({ qaGuideMode: 'cualquier-cosa', handOperable: false }), false,
    'un valor inválido cae en auto, igual que qaGuideMode()');
});

test('story-evidence: reconoce una corrida de navegador en el ledger', () => {
  assert.equal(evGate.looksLikeBrowserRun('node specs/x/smoke/verify.cjs'), true);
  assert.equal(evGate.looksLikeBrowserRun('npx playwright test e2e/'), true);
  assert.equal(evGate.looksLikeBrowserRun('curl -sf http://localhost:5002/api/health'), false);
  assert.equal(evGate.looksLikeBrowserRun('dotnet test --filter X'), false);
});

test('story-evidence: sólo se controla cuando la story se declara terminada, no en cada commit', () => {
  // El gate corre cuando alguien AFIRMA que la story está lista (la transición a `review`/`done`, el mismo
  // disparador que ya usa el gate de DoD), no en CUALQUIER commit que toque una story con ACs: en el commit donde
  // la story recién se escribe no hay, por definición, nada verificado. Un gate que grita siempre se vuelve
  // ruido, y el ruido se ignora.
  assert.equal(evGate.shouldCheckEvidence('in-progress', 'review'), true);
  assert.equal(evGate.shouldCheckEvidence('review', 'done'), true);
  assert.equal(evGate.shouldCheckEvidence('ready-for-dev', 'in-progress'), false);
  assert.equal(evGate.shouldCheckEvidence(null, 'ready-for-dev'), false, 'story recién creada');
  assert.equal(evGate.shouldCheckEvidence('done', 'done'), false, 'sin cambio de estado');
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Waivers PORTABLES — el problema y por qué el anclaje cambia.
//
// Un waiver atado al `matrixHash`, que pinnea los veredictos + las REFS DE EVIDENCIA de TODOS los ACs, no viaja:
// esa evidencia vive en `.advisors/` (gitignoreado) → en otra máquina, o en CI, no existe: los veredictos cambian,
// el hash cambia, y el waiver NO engancha. O sea que la aprobación del humano —lo ÚNICO de toda la cadena que
// una máquina no puede recomputar— sería lo único que no viaja, y habría que rehacerla en cada máquina.
//
// El anclaje correcto es lo que el humano REALMENTE aprobó: la DECLARACIÓN de que ese AC no se
// puede ejercer corriendo (su `reason` + `covered_by` del frontmatter `runtime_not_verifiable`).
// Eso vive en la story, viaja con el repo, y es idéntico en toda máquina. Y se vence justo cuando
// tiene que vencerse: si alguien reescribe la justificación.
//
// El log firmado además se lee del REPO (`<repo>/.tycon/runtime-waivers.jsonl`, commiteado) y no
// sólo del home. NO se usa el frontmatter para esto a propósito: un ack que el agente puede escribir es un
// agujero.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const waiverLib = require(path.join(SCRIPTS, 'lib', 'runtime-waiver.js'));

// 🔴 RED DE SEGURIDAD, no adorno. Si `appendWaiver` ignora `logPath`, un test escribe entries de prueba en el log
// REAL del usuario (`~/.claude/.tycon-pipeline/runtime-waivers.jsonl`), firmadas con `approvedBy` y `tty:true` —
// o sea, indistinguibles de aprobaciones humanas de verdad, en el mismo archivo que existe para que nadie pueda
// fabricar una. El guard de abajo hace que un test que apunte (o degrade) al log real EXPLOTE en vez de
// contaminarlo.
const LOG_REAL = path.join(os.homedir(), '.claude', '.tycon-pipeline', 'runtime-waivers.jsonl');
function appendWaiverSeguro(e) {
  const destino = e.logPath;
  assert.ok(destino, 'test mal escrito: appendWaiver SIEMPRE con logPath explícito en tests');
  assert.notEqual(path.resolve(destino), path.resolve(LOG_REAL), 'un test JAMÁS escribe en el log real de waivers');
  const antes = fs.existsSync(LOG_REAL) ? fs.statSync(LOG_REAL).size : -1;
  const out = waiverLib.appendWaiver(e);
  const despues = fs.existsSync(LOG_REAL) ? fs.statSync(LOG_REAL).size : -1;
  assert.equal(despues, antes, 'appendWaiver tocó el log REAL del usuario — bug, no test');
  return out;
}

function tmpRepoConWaiver(entries) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'waiver-repo-'));
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  const logPath = path.join(repo, '.tycon', 'runtime-waivers.jsonl');
  for (const e of entries) appendWaiverSeguro({ ...e, logPath });
  return { repo, logPath };
}

test('declHashFor: misma declaración → mismo hash; reescribirla → distinto', () => {
  const a = waiverLib.declHashFor('es doctrina del skill', 'T11');
  const b = waiverLib.declHashFor('es doctrina del skill', 'T11');
  const c = waiverLib.declHashFor('es doctrina del skill (reescrito)', 'T11');
  const d = waiverLib.declHashFor('es doctrina del skill', 'T12');
  assert.equal(a, b, 'determinístico: la misma declaración da el mismo hash en cualquier máquina');
  assert.notEqual(a, c, 'si cambia la RAZÓN, el waiver tiene que vencerse');
  assert.notEqual(a, d, 'si cambia el test que lo cubre, también');
});

test('waiver anclado a la declaración cuenta aunque el matrixHash sea OTRO (portabilidad)', () => {
  const decl = waiverLib.declHashFor('es doctrina del skill', 'T11');
  const { repo } = tmpRepoConWaiver([{
    story: '3.32', acs: [7], matrixHash: 'hash-de-la-maquina-A', approvedBy: 'deva',
    nowIso: new Date().toISOString(), declHashByAc: { 7: decl },
  }]);
  // Otra máquina: el matrixHash es distinto (no hay evidencia local), la declaración es la misma.
  const out = waiverLib.waivedAcs('3.32', {
    matrixHash: 'hash-de-la-maquina-B',
    declHashByAc: { 7: decl },
    repoRoot: repo,
  });
  assert.ok(out.has(7), 'la aprobación viaja: engancha por declaración, no por la foto de la evidencia');
});

test('si se reescribe la justificación del AC, el waiver deja de contar', () => {
  const declVieja = waiverLib.declHashFor('es doctrina del skill', 'T11');
  const { repo } = tmpRepoConWaiver([{
    story: '3.32', acs: [7], matrixHash: 'x', approvedBy: 'deva',
    nowIso: new Date().toISOString(), declHashByAc: { 7: declVieja },
  }]);
  const out = waiverLib.waivedAcs('3.32', {
    matrixHash: 'x',
    declHashByAc: { 7: waiverLib.declHashFor('ahora dice otra cosa', 'T11') },
    repoRoot: repo,
  });
  assert.ok(!out.has(7), 'cambió lo que se aprobó → hay que volver a aprobarlo');
});

test('los waivers viejos (sólo matrixHash) siguen contando — no se rompe lo ya aprobado', () => {
  const { repo } = tmpRepoConWaiver([{
    story: '9.9', acs: [3], matrixHash: 'hash-viejo', approvedBy: 'deva',
    nowIso: new Date().toISOString(),
  }]);
  const out = waiverLib.waivedAcs('9.9', { matrixHash: 'hash-viejo', declHashByAc: {}, repoRoot: repo });
  assert.ok(out.has(3), 'formato legacy: sigue enganchando por matrixHash');
  const otra = waiverLib.waivedAcs('9.9', { matrixHash: 'otro', declHashByAc: {}, repoRoot: repo });
  assert.ok(!otra.has(3), 'y sigue siendo local: con otro matrixHash no cuenta (por eso no viajaba)');
});

test('waivedAcs mantiene la firma vieja (story, matrixHash) — los callers existentes no se tocan', () => {
  const { repo } = tmpRepoConWaiver([{
    story: '8.8', acs: [2], matrixHash: 'h', approvedBy: 'deva', nowIso: new Date().toISOString(),
  }]);
  const prev = process.env.TYCON_WAIVER_LOG;
  process.env.TYCON_WAIVER_LOG = path.join(repo, '.tycon', 'runtime-waivers.jsonl');
  try {
    const out = waiverLib.waivedAcs('8.8', 'h');
    assert.ok(out.has(2), 'la firma de 2 strings sigue funcionando');
  } finally {
    if (prev === undefined) delete process.env.TYCON_WAIVER_LOG; else process.env.TYCON_WAIVER_LOG = prev;
  }
});

test('la cadena del log del repo se verifica igual: una línea manoseada invalida lo que sigue', () => {
  // Las firmas nuevas se escriben sin padre, así que el registro de esta prueba se arma ENCADENADO, como lo escribe
  // `lineal`: es el formato de los registros existentes, y lo que se afirma es lo mismo.
  const decl = waiverLib.declHashFor('r', 'T1');
  const { repo, logPath } = registroDePrueba(lineal([
    firma('1.1', [1], { matrixHash: 'a', declHashByAc: { 1: decl } }),
    firma('1.2', [2], { matrixHash: 'b', declHashByAc: { 2: decl } }),
  ]));
  const lineas = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const manoseada = JSON.parse(lineas[0]);
  manoseada.acs = [1, 2, 3]; // alguien se auto-aprueba dos ACs más
  fs.writeFileSync(logPath, [JSON.stringify(manoseada), lineas[1]].join('\n') + '\n');
  const out = waiverLib.waivedAcs('1.2', { matrixHash: 'b', declHashByAc: { 2: decl }, repoRoot: repo });
  assert.ok(!out.has(2), 'cadena rota → no cuenta ningún waiver posterior');
});

// ── Las firmas sobreviven a unir ramas ───────────────────────────────────────────────────────────
// Dos ramas que firman enganchando con la MISMA línea: al unirlas, la segunda dejaría de enganchar con la anterior
// y desde ahí toda firma se descartaría en silencio. Estas pruebas arman los registros a mano (en carpetas
// temporales, nunca el real) con el hash y el canónico del verificador lineal, copiados acá: son la vara de lo
// que ya está firmado.
const crypto717 = require('crypto');
const sha717 = (s) => crypto717.createHash('sha256').update(s).digest('hex');
function canonicalDeAntes(e) {
  const base = [e.ts, String(e.story), [...e.acs].sort((a, b) => a - b), e.matrixHash, e.approvedBy || null];
  if (e.declHashByAc !== undefined) {
    base.push(Object.keys(e.declHashByAc).sort((a, b) => Number(a) - Number(b)).map((k) => [Number(k), e.declHashByAc[k]]));
  }
  return JSON.stringify(base);
}
let relojDePrueba = Date.parse('2026-10-07T10:00:00Z');
function firma(story, acs, extra = {}) {
  relojDePrueba += 1000;
  return { ts: new Date(relojDePrueba).toISOString(), story, acs, matrixHash: 'm', approvedBy: 'deva', tty: true, ...extra };
}
/** La entrada `e` enganchada con el `chain` padre (vacío = raíz). */
function colgadaDe(padre, e) { return { ...e, chain: sha717(padre + canonicalDeAntes(e)).slice(0, 16) }; }
/** Una lista encadenada, el formato de los registros existentes: cada firma con la anterior. */
function lineal(entries) {
  let prev = '';
  return entries.map((e) => { const x = colgadaDe(prev, e); prev = x.chain; return x; });
}
/** El verificador lineal: el prefijo que engancha línea con línea. */
function verificadorDeAntes(lineas) {
  const out = []; let prev = '';
  for (const l of lineas) {
    let e; try { e = JSON.parse(l); } catch { break; }
    if (e.chain !== sha717(prev + canonicalDeAntes(e)).slice(0, 16)) break;
    out.push(e); prev = e.chain;
  }
  return out;
}
function registroDePrueba(entries, { crudo } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'firmas-717-'));
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  const logPath = path.join(repo, '.tycon', 'runtime-waivers.jsonl');
  assert.notEqual(path.resolve(logPath), path.resolve(LOG_REAL), 'un test JAMÁS escribe en el log real de waivers');
  fs.writeFileSync(logPath, crudo !== undefined ? crudo : entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { repo, logPath };
}
const storiesValidas = (logPath) => waiverLib.verifyChain(logPath).entries.map((e) => e.story);

test('Waiver_ParallelBranches_BothValid — dos ramas que firmaron sobre el mismo padre valen las dos (T1)', () => {
  const [b0, b1] = lineal([firma('11.1', [1]), firma('11.2', [1])]);
  const a = colgadaDe(b1.chain, firma('11.5', [3]));      // una rama
  const b = colgadaDe(b1.chain, firma('11.3', [7]));      // otra rama, sobre la MISMA línea
  for (const orden of [[b0, b1, a, b], [b0, b1, b, a]]) {
    const { repo, logPath } = registroDePrueba(orden);
    const v = waiverLib.verifyChain(logPath);
    assert.equal(v.ok, true, `las dos ramas unidas valen: ${JSON.stringify(v.discarded)}`);
    assert.deepStrictEqual(v.entries.map((e) => e.story).sort(), ['11.1', '11.2', '11.3', '11.5']);
    assert.ok(waiverLib.waivedAcs('11.3', { matrixHash: 'm', declHashByAc: {}, repoRoot: repo }).has(7));
    assert.ok(waiverLib.waivedAcs('11.5', { matrixHash: 'm', declHashByAc: {}, repoRoot: repo }).has(3));
  }
});

test('Waiver_Append_IsRoot — la firma nueva va sin padre y vale aunque el registro esté roto (T2)', () => {
  const base = lineal([firma('1.1', [1]), firma('1.2', [2]), firma('1.3', [3])]);
  const editada = [base[0], { ...base[1], acs: [2, 9] }, base[2]];
  const casos = {
    valido: base.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'con la línea 2 editada': editada.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'con la primera línea rota': '{esto no es json\n' + base.slice(1).map((e) => JSON.stringify(e)).join('\n') + '\n',
  };
  for (const [nombre, crudo] of Object.entries(casos)) {
    const { logPath } = registroDePrueba(null, { crudo });
    const e = appendWaiverSeguro({ story: '1.9', acs: [4], matrixHash: 'm', approvedBy: 'deva', nowIso: new Date().toISOString(), logPath });
    assert.equal(e.chain, sha717('' + canonicalDeAntes(e)).slice(0, 16), `${nombre}: la firma nueva es raíz`);
    assert.ok(storiesValidas(logPath).includes('1.9'), `${nombre}: la firma nueva vale`);
  }
});

test('Waiver_EditedEntry_DescendantsDiscarded — una edición a mano descarta lo que cuelga de ella (T3)', () => {
  const l = lineal([firma('2.1', [1]), firma('2.2', [2]), firma('2.3', [3]), firma('2.4', [4])]);
  const { logPath } = registroDePrueba([l[0], { ...l[1], acs: [2, 5] }, l[2], l[3]]);
  const v = waiverLib.verifyChain(logPath);
  assert.deepStrictEqual(v.entries.map((e) => e.story), ['2.1']);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
  assert.deepStrictEqual(v.discarded.map((d) => [d.line, d.motivo]),
    [[2, 'sin-padre'], [3, 'cuelga-de-descartada'], [4, 'cuelga-de-descartada']]);
});

test('Waiver_InventedOrCopiedChain_Discarded — un chain inventado o copiado de otra línea no vale (T4)', () => {
  const l = lineal([firma('3.1', [1]), firma('3.2', [2])]);
  const inventada = { ...firma('3.3', [9]), chain: 'deadbeefdeadbeef' };
  const copiada = { ...firma('3.4', [9]), chain: l[1].chain };
  const { logPath } = registroDePrueba([...l, inventada, copiada]);
  const v = waiverLib.verifyChain(logPath);
  assert.deepStrictEqual(v.entries.map((e) => e.story), ['3.1', '3.2']);
  assert.deepStrictEqual(v.discarded.map((d) => [d.line, d.motivo]), [[3, 'sin-padre'], [4, 'sin-padre']]);
});

test('Waiver_Root_AnyPosition — una raíz vale primera, después de firmas válidas y después de una línea rota (T5)', () => {
  const l = lineal([firma('4.1', [1]), firma('4.2', [2])]);
  const raiz = colgadaDe('', firma('4.9', [9]));
  for (const crudo of [
    [raiz, ...l].map((e) => JSON.stringify(e)).join('\n') + '\n',
    [...l, raiz].map((e) => JSON.stringify(e)).join('\n') + '\n',
    '{rota\n' + JSON.stringify(raiz) + '\n',
  ]) {
    const { logPath } = registroDePrueba(null, { crudo });
    assert.ok(storiesValidas(logPath).includes('4.9'), `la raíz vale: ${crudo.slice(0, 40)}`);
  }
});

test('Waiver_ParentAfterChild_Discarded — el padre tiene que estar antes que el hijo (T6)', () => {
  const padre = colgadaDe('', firma('5.1', [1]));
  const hijo = colgadaDe(padre.chain, firma('5.2', [2]));
  const { logPath } = registroDePrueba([hijo, padre]);
  const v = waiverLib.verifyChain(logPath);
  assert.deepStrictEqual(v.entries.map((e) => e.story), ['5.1']);
  assert.deepStrictEqual(v.discarded.map((d) => [d.line, d.motivo]), [[1, 'padre-posterior']]);
});

test('Waiver_LegacyLinearLog_SameEntries — un registro lineal se lee igual que antes (T7)', () => {
  const armado = lineal([firma('6.1', [1]), firma('6.2', [2], { declHashByAc: { 2: 'x' } }), firma('6.3', [3])]);
  const { logPath } = registroDePrueba(armado);
  const delRepo = path.join(SCRIPTS, '..', '..', '..', '.tycon', 'runtime-waivers.jsonl');
  for (const lp of [logPath, ...(fs.existsSync(delRepo) ? [delRepo] : [])]) {
    const lineas = fs.readFileSync(lp, 'utf8').split('\n').filter(Boolean);
    const antes = verificadorDeAntes(lineas);
    assert.ok(antes.length > 0, `el registro de referencia tiene firmas: ${lp}`);
    const ahora = waiverLib.verifyChain(lp).entries;
    // el armado es lineal entero: se lee igual. El del repo sigue recibiendo firmas, y las nuevas pueden ser hermanas
    // (dos ramas que firmaron sobre la misma punta) que el verificador lineal no sabe leer: lo que él lee
    // tiene que leerse igual y en el mismo orden, y lo nuevo va después.
    if (lp === logPath) assert.deepStrictEqual(ahora, antes, `mismas entradas y mismo orden: ${lp}`);
    else assert.deepStrictEqual(ahora.slice(0, antes.length), antes, `lo que leía el verificador de antes, igual y en el mismo orden: ${lp}`);
  }
});

test('Waiver_RevertAndCherryPick_Survive — con firmas nuevas, ni el revert ni el cherry-pick rompen (T8)', () => {
  const base = lineal([firma('7.0', [1])]);
  const dir = registroDePrueba(base).logPath;
  const firmar = (story) => appendWaiverSeguro({ story, acs: [1], matrixHash: 'm', approvedBy: 'deva', nowIso: new Date(relojDePrueba += 1000).toISOString(), logPath: dir });
  const sa = firmar('7.1'); const sb = firmar('7.2'); const sc = firmar('7.3');
  // revert de la firma de 7.1: su línea sale del archivo
  const { logPath: revert } = registroDePrueba([...base, sb, sc]);
  assert.deepStrictEqual(storiesValidas(revert), ['7.0', '7.2', '7.3']);
  // cherry-pick de la firma de 7.2 a main, y la unión deduplicada deja la de 7.2 antes que la de 7.1
  const { logPath: cherry } = registroDePrueba([...base, sb, sa, sc]);
  assert.deepStrictEqual(storiesValidas(cherry), ['7.0', '7.2', '7.1', '7.3']);
});

test('Waiver_DeletedThenRestored_Valid — borrar una línea no revoca la firma: pegada otra vez, vale (T9)', () => {
  const l = lineal([firma('8.1', [1]), firma('8.2', [2]), firma('8.3', [3])]);
  const { logPath } = registroDePrueba([l[0], l[2], l[1]]);    // la firma de 8.2 se borró y se volvió a pegar al final
  assert.deepStrictEqual(storiesValidas(logPath), ['8.1', '8.2']);
  const v = waiverLib.verifyChain(logPath);
  assert.deepStrictEqual(v.discarded.map((d) => [d.line, d.motivo]), [[2, 'padre-posterior']],
    'la 8.3 cuelga de la 8.2, que ahora está más abajo — se dice por qué');
});

test('Waiver_Bom_Ignored — la marca de orden de bytes de Windows no rompe la primera línea (T10)', () => {
  const l = lineal([firma('9.1', [1]), firma('9.2', [2])]);
  const { logPath } = registroDePrueba(null, { crudo: '﻿' + l.map((e) => JSON.stringify(e)).join('\r\n') + '\r\n' });
  assert.deepStrictEqual(storiesValidas(logPath), ['9.1', '9.2']);
});

test('Waiver_VerifyChain_ShapeCompatible — la forma de siempre más `discarded` con la línea física (T11)', () => {
  const l = lineal([firma('10.1', [1]), firma('10.2', [2])]);
  const crudo = [JSON.stringify(l[0]), '', 'no-json', JSON.stringify({ ...l[1], acs: [2, 3] })].join('\n') + '\n';
  const { logPath } = registroDePrueba(null, { crudo });
  const v = waiverLib.verifyChain(logPath);
  assert.equal(v.ok, false);
  assert.equal(v.total, 3, 'las vacías no cuentan, como hoy');
  assert.equal(v.brokenAt, 1, 'índice de la primera descartada, contando como hoy');
  assert.deepStrictEqual(v.entries.map((e) => e.story), ['10.1']);
  assert.deepStrictEqual(v.discarded.map((d) => [d.line, d.motivo]), [[3, 'json'], [4, 'sin-padre']]);
  assert.equal(v.discarded[0].entry, null);
  assert.equal(v.discarded[1].entry.story, '10.2');
});

// ── Pase adversarial (5b) — lo que confirmó ejecutando el código ───────────────────────────────────
test('5b-1 Waiver_Append_SinSaltoFinal — la firma nueva no se pega a una última línea sin salto (recorte a mano)', () => {
  const l = lineal([firma('12.1', [1])]);
  const { logPath } = registroDePrueba(null, { crudo: JSON.stringify(l[0]) });   // sin '\n' final
  appendWaiverSeguro({ story: '12.2', acs: [2], matrixHash: 'm', approvedBy: 'deva', nowIso: new Date().toISOString(), logPath });
  assert.deepStrictEqual(storiesValidas(logPath), ['12.1', '12.2'], 'las dos firmas valen');
});

test('5b-2 Waiver_DeclHashNull_NoTumbaElRegistro — una línea con declHashByAc:null se descarta, no hace caer al lector', () => {
  const buena = colgadaDe('', firma('13.1', [1]));
  const mala = { ...firma('13.9', [1]), declHashByAc: null, chain: 'abc' };
  const { repo, logPath } = registroDePrueba([mala, buena]);
  const v = waiverLib.verifyChain(logPath);
  assert.deepStrictEqual(v.entries.map((e) => e.story), ['13.1']);
  assert.deepStrictEqual(v.discarded.map((d) => [d.line, d.motivo]), [[1, 'json']]);
  assert.ok(waiverLib.waivedAcs('13.1', { matrixHash: 'm', declHashByAc: {}, repoRoot: repo }).has(1), 'las demás firmas siguen contando');
});

test('5b-3 Waiver_SinAcs_SeAtribuyeASuStory — una línea JSON sin lista de AC sigue diciendo de qué story es', () => {
  const { repo, logPath } = registroDePrueba([{ ...firma('14.1', [1]), acs: 'uno', chain: 'abc' }]);
  const v = waiverLib.verifyChain(logPath);
  assert.equal(v.discarded[0].motivo, 'json');
  assert.equal(v.discarded[0].entry && v.discarded[0].entry.story, '14.1', 'la entrada leída se conserva');
  const d = waiverLib.discardedFor('14.1', { matrixHash: 'm', declHashByAc: {}, repoRoot: repo });
  assert.deepStrictEqual(d.lines.map((x) => [x.line, x.motivo]), [[1, 'json']], 'el aviso de cadena la ve');
});

test('5b-4 Waiver_ClaveDeAcRenombrada_NoSalteaLaDeclaracion — «03» en vez de «3» no cae al camino viejo por matrixHash', () => {
  const declVieja = waiverLib.declHashFor('razón vieja', 'T1');
  const e = colgadaDe('', firma('15.1', [3], { matrixHash: 'mh', declHashByAc: { 3: declVieja } }));
  const renombrada = { ...e, declHashByAc: { '03': declVieja } };      // canonical() normaliza la clave: el chain sigue valiendo
  const { repo } = registroDePrueba([renombrada]);
  const hoy = waiverLib.declHashFor('razón nueva', 'T1');
  const out = waiverLib.waivedAcs('15.1', { matrixHash: 'mh', declHashByAc: { 3: hoy }, repoRoot: repo });
  assert.ok(!out.has(3), 'la declaración cambió: la firma no vale aunque el matrixHash coincida');
});

test('5b-6 Waiver_HomeLog_LineaDeOtroRepo — una línea rota de otro producto con el mismo número no prende el aviso', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'home-717-'));
  const home = path.join(tmp, 'w.jsonl');
  fs.writeFileSync(home, JSON.stringify({ ...firma('16.1', [1], { matrixHash: 'otro-repo' }), chain: 'abc' }) + '\n');
  const prev = process.env.TYCON_WAIVER_LOG;
  process.env.TYCON_WAIVER_LOG = home;
  try {
    const d = waiverLib.discardedFor('16.1', { matrixHash: 'este-repo', declHashByAc: { 1: 'x' } });
    assert.deepStrictEqual(d.lines, [], 'del registro de la HOME sólo cuentan las líneas que engancharían con esta story');
  } finally {
    if (prev === undefined) delete process.env.TYCON_WAIVER_LOG; else process.env.TYCON_WAIVER_LOG = prev;
  }
});

// el registro de incidentes y las fichas son del repo interno: la copia pública trae la página pública en su lugar →
// NO MEDIDO ahí, no rojo (export-real T23). El repo interno se reconoce por perfil-equipo.json en su raíz.
const RAIZ_DOCS = path.join(SCRIPTS, '..', '..', '..');
test('Docs_IncidentAndHeader — el caso, la cabecera y la ficha dicen lo mismo (T20)', { skip: !fs.existsSync(path.join(RAIZ_DOCS, 'perfil-equipo.json')) && 'NO MEDIDO — copia pública: el registro de incidentes y las fichas no viajan' }, () => {
  const raiz = RAIZ_DOCS;
  const log = fs.readFileSync(path.join(raiz, 'guides', 'maintaining', 'incident-log.md'), 'utf8');
  assert.match(log, /^## case-firmas-ramas-paralelas-2026-10-07$/m, 'la entrada del incident-log existe');
  const cabecera = fs.readFileSync(path.join(SCRIPTS, 'lib', 'runtime-waiver.js'), 'utf8').split("'use strict'")[1].split('*/')[0];
  assert.match(cabecera, /QUÉ FRENA/, 'la cabecera dice qué frena');
  assert.match(cabecera, /QUÉ NO FRENA/, 'y qué no');
  assert.match(cabecera, /case-firmas-ramas-paralelas-2026-10-07/, 'y cita el caso');
  const piezas = fs.readFileSync(path.join(raiz, 'guides', 'piezas-del-arnes.md'), 'utf8');
  assert.match(piezas, /runtime-waiver\.js — el registro de firmas/, 'la ficha de la pieza existe');
  // La ficha se publica: dice la regla y su porqué, sin enlazar el caso. El camino de vuelta es
  // la tabla del registro, que anota qué guía y qué sección lo citaba.
  // la ficha corta y su detalle (guides/maintaining/piezas-en-detalle.md, mismo título) se leen juntos
  const cortar = (txt) => { const i = txt.indexOf('runtime-waiver.js — el registro de firmas'); return i < 0 ? '' : txt.slice(i).split(/\n## /)[0]; };
  const detalle = path.join(raiz, 'guides', 'maintaining', 'piezas-en-detalle.md');
  const ficha = cortar(piezas) + '\n' + (fs.existsSync(detalle) ? cortar(fs.readFileSync(detalle, 'utf8')) : '');
  assert.match(ficha, /La cadena se lee como \*\*árbol\*\*/, 'la ficha dice la regla: la cadena se lee como árbol');
  assert.match(ficha, /dos ramas que firmaron en paralelo y se unen valen las dos/, 'y qué evita: dos ramas en paralelo valen las dos');
  assert.ok(!/incident-log(?:\.md)?#/.test(ficha), 'sin enlazar el caso');
  assert.match(log, /\| `case-firmas-ramas-paralelas-2026-10-07` \| `guides\/piezas-del-arnes\.md` \| [^|\n]*runtime-waiver\.js[^|\n]*\|/, 'y el registro anota que esta ficha citaba el caso');
});

// ── atdd-preedit — el portón PREVENTIVO (deniega la edición, no la lamenta) ─────────────────────
// Sin este portón, un pipeline puede implementar tasks completas antes de escribir ningún test. Los otros dos frenos
// (complete-step 4 y el commit) son post-mortem; éste corre en el PreToolUse Edit|Write y deniega el primer
// archivo de código si no hay test tocado antes.
const preedit = require(path.join(SCRIPTS, 'lib', 'atdd-preedit.js'));

test('atdd-preedit: BLOQUEA el primer código sin test previo (el caso del compañero)', () => {
  const r = preedit.computeAtddPreEdit({
    filePath: '/repo/src/features/validator.cs',
    repoPath: '/repo',
    priorPaths: ['/repo/specs/stories/3-1-x.md'],  // sólo la story editada, cero tests
    storyHasTests: true,
    stepsCompleted: [0, 1, 2, 3],
  });
  assert.equal(r.action, 'block');
  const msg = preedit.preEditBlockMessage({ filePath: '/repo/src/features/validator.cs', storyId: '3.1', storyPath: '/repo/specs/stories/3-1-x.md' });
  assert.match(msg, /DENEGADA/, 'el mensaje dice que la edición NO ocurrió');
  assert.match(msg, /set-flag atddBypass true/, 'ofrece el escape consciente exacto');
});

test('atdd-preedit: PASA en cuanto un test fue tocado antes (el portón se abre para la corrida)', () => {
  const r = preedit.computeAtddPreEdit({
    filePath: '/repo/src/svc.ts',
    repoPath: '/repo',
    priorPaths: ['/repo/tests/svc.test.ts'],
    storyHasTests: true,
    stepsCompleted: [0, 1, 2, 3],
  });
  assert.equal(r.action, 'pass');
});

test('atdd-preedit: NO bloquea los casos que serían falsos positivos', () => {
  const base = { repoPath: '/repo', priorPaths: [], storyHasTests: true, stepsCompleted: [0, 1, 2, 3] };
  // step 4 ya cerrado → fixes post-implementación, pasa
  assert.equal(preedit.computeAtddPreEdit({ ...base, filePath: '/repo/src/a.ts', stepsCompleted: [0, 1, 2, 3, 4] }).action, 'pass');
  // story sin tabla ### Tests → sin contrato ATDD
  assert.equal(preedit.computeAtddPreEdit({ ...base, filePath: '/repo/src/a.ts', storyHasTests: false }).action, 'pass');
  // archivo fuera del repo de la story (ej: editar el harness mid-pipeline)
  assert.equal(preedit.computeAtddPreEdit({ ...base, filePath: '/otro/src/a.ts' }).action, 'pass');
  // prefijo tramposo: /repo-viejo NO es /repo
  assert.equal(preedit.computeAtddPreEdit({ ...base, filePath: '/repo-viejo/src/a.ts' }).action, 'pass');
  // no-código (.md, .json, .sql) pasa siempre
  assert.equal(preedit.computeAtddPreEdit({ ...base, filePath: '/repo/docs/x.md' }).action, 'pass');
  assert.equal(preedit.computeAtddPreEdit({ ...base, filePath: '/repo/db/m.sql' }).action, 'pass');
  // el archivo de TEST mismo pasa (es exactamente lo que queremos que escriba)
  assert.equal(preedit.computeAtddPreEdit({ ...base, filePath: '/repo/tests/a.test.ts' }).action, 'pass');
  // bypass declarado
  assert.equal(preedit.computeAtddPreEdit({ ...base, filePath: '/repo/src/a.ts', bypassed: true }).action, 'pass');
});

test('atdd-preedit: storyDeclaresTests — mismo criterio que el sub-paso 4.0, fail-open', () => {
  assert.ok(preedit.storyDeclaresTests('# Story\n\n### Tests\n\n| T-ID | AC |'));
  assert.ok(preedit.storyDeclaresTests('## Tests\ntabla'));
  assert.ok(!preedit.storyDeclaresTests('# Story sin tabla'));
  assert.ok(!preedit.storyDeclaresTests(''));       // no se pudo leer → NO bloquear
  assert.ok(!preedit.storyDeclaresTests(null));
});

test('atdd-preedit handler: end-to-end con marker real — bloquea, y con test previo deja pasar', () => {
  // El handler (on-atdd-preedit.js) lee marker + story + eventos de disco: se monta un entorno real.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atdd-preedit-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'specs', 'stories'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'active'), { recursive: true });
  const storyPath = path.join(repo, 'specs', 'stories', '9-9-demo.md');
  fs.writeFileSync(storyPath, '---\nstory: "9.9"\n---\n\n### Tests\n\n| T-ID | AC |\n');
  const marker = {
    storyId: '9.9', storyPath, repoPath: repo, sessionId: 'S1',
    stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5],
    fileEvents: [{ path: storyPath, ts: '2026-07-30T10:00:00.000Z' }],
  };
  fs.writeFileSync(path.join(stateDir, 'active', 'S1.json'), JSON.stringify(marker));

  const handler = require(path.join(SCRIPTS, 'on-atdd-preedit.js'));
  const ev = (fp) => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'S1', tool_input: { file_path: fp } });

  // 1) primer código sin test → block
  const r1 = handler.handle(ev(path.join(repo, 'src', 'svc.cs')), { stateDir });
  assert.ok(r1 && r1.block, 'primer código sin test → bloquea');
  assert.match(r1.block, /DENEGADA/);

  // 2) escribir un TEST → pasa
  const r2 = handler.handle(ev(path.join(repo, 'tests', 'svc.test.cs')), { stateDir });
  assert.equal(r2, null, 'el archivo de test pasa');

  // 3) con el test ya registrado en fileEvents, el código pasa
  marker.fileEvents.push({ path: path.join(repo, 'tests', 'SvcTests.cs'), ts: '2026-07-30T10:01:00.000Z' });
  fs.writeFileSync(path.join(stateDir, 'active', 'S1.json'), JSON.stringify(marker));
  const r3 = handler.handle(ev(path.join(repo, 'src', 'svc.cs')), { stateDir });
  assert.equal(r3, null, 'con test previo el portón está abierto');

  // 4) flag atddBypass en el marker → pasa aunque no haya test
  marker.fileEvents = [{ path: storyPath, ts: '2026-07-30T10:00:00.000Z' }];
  marker.atddBypass = true;
  fs.writeFileSync(path.join(stateDir, 'active', 'S1.json'), JSON.stringify(marker));
  const r4 = handler.handle(ev(path.join(repo, 'src', 'svc.cs')), { stateDir });
  assert.equal(r4, null, 'bypass declarado → pasa (y quedó en bypass.log del state dir)');

  // 5) sin marker (sesión sin pipeline) → nunca bloquea
  const r5 = handler.handle({ ...ev(path.join(repo, 'src', 'svc.cs')), session_id: 'OTRA' }, { stateDir });
  assert.equal(r5, null, 'fuera del pipeline no frena — decisión DevA 2026-07-30');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('atdd: la story .md bajo specs/ NO cuenta como test (causa raíz del gate ciego, 2026-07-30)', () => {
  // Si el firstTest fuera el .md de la propia story, el gate saldría green siempre: cualquier path bajo specs/
  // matchearía la heurística de directorio. Un "test" exige extensión de código.
  assert.ok(!atdd.isTestPath('/repo/specs/stories/3-1-x.md'), 'la story no es un test');
  assert.ok(!atdd.isTestPath('/repo/specs/sprint-status.yaml'), 'el sprint status tampoco');
  assert.ok(!atdd.isTestPath('/repo/tests/fixtures/golden.json'), 'una fixture tampoco');
  assert.ok(atdd.isTestPath('/repo/x/spec/bar.js'), 'código bajo spec/ sigue siendo test');
  // El escenario completo: editar la story primero y el código después DEBE bloquear.
  const r = atdd.computeAtddOrder([
    { path: '/repo/specs/stories/3-1-x.md', ts: '2026-07-30T10:00:00.000Z' },
    { path: '/repo/src/svc.cs', ts: '2026-07-30T10:05:00.000Z' },
    { path: '/repo/tests/SvcTests.cs', ts: '2026-07-30T11:00:00.000Z' },
  ]);
  assert.equal(r.verdict, 'blocked', 'editar la story primero ya no disfraza la inversión');
});

// ── Fixes de una revisión adversarial — cada test mata un hallazgo ───────────────────────────────
test('atdd: proyectos .NET "Foo.Tests/" cuentan como dir de tests (falso positivo F1 del review)', () => {
  // El heurístico tiene que aceptar `Tests/` sin barra antes, porque los proyectos TYCON son `Tycon.X.API.Tests/`:
  // ATDD bien hecho (WhenUserLogsIn.cs primero) quedaría DENEGADO por el portón.
  for (const p of [
    '/repo/apinetcore/Tycon.X.API.Tests/WhenUserLogsIn.cs',
    '/repo/apinetcore/Tycon.X.API.Tests/Fixtures/DbFixture.cs',
    '/repo/apinetcore/Tycon.X.API.Tests/Helpers/TestHelper.cs',
  ]) {
    assert.ok(atdd.isTestPath(p), `${p} es test`);
    assert.ok(!atdd.isImplPath(p), `${p} NO es implementación`);
  }
  // .mts/.cts: mismo formato de módulo contaba como test (a.spec.mts) pero no como impl (a.mts).
  assert.ok(atdd.isImplPath('/repo/src/a.mts'), '.mts es implementación');
  assert.ok(atdd.isTestPath('/repo/src/a.spec.mts'), '.spec.mts es test');
});

// ── Suites bash como test (versión acotada) ────────────────────────────────────────────────────
// Una story que escribe su suite `.test.sh` ANTES que el código no debe frenarse en el portón pre-edit: si éste no
// la ve como test, hay que declarar `atddBypass` a mano, y con el bypass el orden test-antes-que-código deja de
// verificarse. Versión ACOTADA a propósito:
// `.sh` NO entra a CODE_EXTS — si entrara, todo script de pipeline o de hook pasaría a ser código que
// exige un test previo, y un portón que frena trabajo legítimo se apaga.
test('atdd: una suite .test.sh cuenta como test, y un script .sh sigue sin ser implementación', () => {
  for (const p of [
    '/repo/scripts/tests/pedidos-de-trabajo.test.sh', 'tests/foo.spec.sh', 'C:\\repo\\scripts\\tests\\x.test.sh',
  ]) {
    assert.ok(atdd.isTestPath(p), `${p} es test`);
    assert.ok(!atdd.isImplPath(p), `${p} NO es implementación`);
  }
  // Por NOMBRE, no por carpeta: un ayudante bash bajo tests/ (el doble de `az`) no es una suite, y
  // tocarlo primero no puede habilitar el código.
  for (const p of ['/repo/scripts/ci/publicar-bump.sh', '/repo/scripts/tests/lib/lab-helper.sh', '/repo/scripts/tests/contest.sh']) {
    assert.ok(!atdd.isTestPath(p), `${p} NO es test`);
    assert.ok(!atdd.isImplPath(p), `${p} no gatea`);
  }
  // La suite bash primero, el .js después → el portón pre-edit deja pasar.
  const d = preedit.computeAtddPreEdit({
    filePath: '/r/scripts/nocturno-dependencias/pedidos-de-trabajo.js', repoPath: '/r',
    priorPaths: ['/r/scripts/tests/pedidos-de-trabajo.test.sh'], storyHasTests: true, stepsCompleted: [],
  });
  assert.equal(d.action, 'pass', 'la suite bash escrita antes habilita el código');
  const v = atdd.computeAtddOrder([
    { path: '/r/scripts/tests/pedidos-de-trabajo.test.sh', ts: '2026-09-13T21:00:00.000Z' },
    { path: '/r/scripts/nocturno-dependencias/pedidos-de-trabajo.js', ts: '2026-09-13T21:10:00.000Z' },
  ]);
  assert.equal(v.verdict, 'green', 'el orden se verifica, no se asume');
  // Espejo: el código primero y la suite bash después sigue bloqueando.
  const inv = atdd.computeAtddOrder([
    { path: '/r/scripts/nocturno-dependencias/pedidos-de-trabajo.js', ts: '2026-09-13T21:00:00.000Z' },
    { path: '/r/scripts/tests/pedidos-de-trabajo.test.sh', ts: '2026-09-13T21:10:00.000Z' },
  ]);
  assert.equal(inv.verdict, 'blocked', 'la suite bash después del código no lo lava');
});

test('atdd-preedit: isInside es case-insensitive (APFS/NTFS — mismo archivo, otro casing)', () => {
  assert.ok(preedit.isInside('/Users/x/SourceCode/Repo', '/users/x/sourcecode/repo/src/a.ts'));
  assert.ok(!preedit.isInside('/Users/x/Repo', '/Users/x/Repo-viejo/src/a.ts'), 'el guard de segmento se mantiene');
});

test('atdd-preedit handler: tests escritos ANTES del marker cuentan (unión con el .jsonl — F2)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atdd-jsonl-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'specs', 'stories'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'active'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'file-events'), { recursive: true });
  const storyPath = path.join(repo, 'specs', 'stories', '9-9-demo.md');
  fs.writeFileSync(storyPath, '---\nstory: "9.9"\n---\n\n### Tests\n\n| T-ID | AC |\n');
  // El test se escribió en el Step 0, ANTES de crear el marker: vive SOLO en el .jsonl de sesión.
  fs.writeFileSync(path.join(stateDir, 'file-events', 'S2.jsonl'),
    JSON.stringify({ path: path.join(repo, 'tests', 'svc.test.ts'), ts: '2026-07-30T09:00:00.000Z' }) + '\n');
  fs.writeFileSync(path.join(stateDir, 'active', 'S2.json'), JSON.stringify({
    storyId: '9.9', storyPath, repoPath: repo, sessionId: 'S2',
    stepsCompleted: [0, 1, 2, 3], stepsPending: [4], fileEvents: [],
  }));
  const handler = require(path.join(SCRIPTS, 'on-atdd-preedit.js'));
  const r = handler.handle({ hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'S2',
    tool_input: { file_path: path.join(repo, 'src', 'svc.ts') } }, { stateDir });
  assert.equal(r, null, 'ATDD impecable pre-marker NO se deniega');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('atdd-preedit handler: storyPath RELATIVO se resuelve contra repoPath (F4 — antes apagaba el portón)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atdd-rel-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'specs', 'stories'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'active'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'specs', 'stories', '9-9-demo.md'),
    '---\nstory: "9.9"\n---\n\n### Tests\n\n| T-ID | AC |\n');
  fs.writeFileSync(path.join(stateDir, 'active', 'S3.json'), JSON.stringify({
    storyId: '9.9', storyPath: 'specs/stories/9-9-demo.md', repoPath: repo, sessionId: 'S3',
    stepsCompleted: [0, 1, 2, 3], stepsPending: [4], fileEvents: [],
  }));
  const handler = require(path.join(SCRIPTS, 'on-atdd-preedit.js'));
  const r = handler.handle({ hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'S3',
    tool_input: { file_path: path.join(repo, 'src', 'svc.ts') } }, { stateDir });
  assert.ok(r && r.block, 'la story relativa SE LEE y el portón bloquea (antes: pass con razón falsa)');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('atdd-preedit handler: los bloqueos y bypasses dejan rastro auditable (mata M17/M18)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atdd-audit-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'specs', 'stories'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'active'), { recursive: true });
  const storyPath = path.join(repo, 'specs', 'stories', '9-9-demo.md');
  fs.writeFileSync(storyPath, '---\nstory: "9.9"\n---\n\n### Tests\n\n| T-ID | AC |\n');
  const mk = { storyId: '9.9', storyPath, repoPath: repo, sessionId: 'S4',
    stepsCompleted: [0, 1, 2, 3], stepsPending: [4], fileEvents: [] };
  fs.writeFileSync(path.join(stateDir, 'active', 'S4.json'), JSON.stringify(mk));
  const handler = require(path.join(SCRIPTS, 'on-atdd-preedit.js'));
  const ev = (fp) => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'S4', tool_input: { file_path: fp } });

  // Bloqueo → entrada en gates.log
  const r1 = handler.handle(ev(path.join(repo, 'src', 'a.ts')), { stateDir });
  assert.ok(r1 && r1.block);
  const gates = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8');
  assert.match(gates, /"name":"atdd-preedit"/, 'el bloqueo queda medido en gates.log');

  // Bypass que EVITA un bloqueo → una entrada en bypass.log…
  mk.atddBypass = true;
  fs.writeFileSync(path.join(stateDir, 'active', 'S4.json'), JSON.stringify(mk));
  assert.equal(handler.handle(ev(path.join(repo, 'src', 'a.ts')), { stateDir }), null);
  const bypassLog = fs.readFileSync(path.join(stateDir, 'bypass.log'), 'utf8');
  assert.match(bypassLog, /ATDD_PREEDIT_BYPASS/, 'el bypass usado queda en bypass.log');

  // …pero una edición que pasaría IGUAL (un .md) NO agrega ruido al log (F6).
  assert.equal(handler.handle(ev(path.join(repo, 'docs', 'x.md')), { stateDir }), null);
  const lineas = fs.readFileSync(path.join(stateDir, 'bypass.log'), 'utf8').trim().split('\n');
  assert.equal(lineas.length, 1, 'sólo el bypass que evitó un bloqueo real se loguea');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('atdd-preedit handler: bordes que los mutantes destaparon (M10/M11/M14)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atdd-bordes-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'specs', 'stories'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'active'), { recursive: true });
  const conTests = path.join(repo, 'specs', 'stories', '9-9-a.md');
  const sinTests = path.join(repo, 'specs', 'stories', '9-9-b.md');
  fs.writeFileSync(conTests, '---\nstory: "9.9"\n---\n\n### Tests\n\n| T-ID |\n');
  fs.writeFileSync(sinTests, '---\nstory: "9.9"\n---\n\nSolo docs.\n');
  const write = (m) => fs.writeFileSync(path.join(stateDir, 'active', 'S5.json'), JSON.stringify(m));
  const base = { storyId: '9.9', storyPath: conTests, repoPath: repo, sessionId: 'S5',
    stepsCompleted: [0, 1, 2, 3], stepsPending: [4], fileEvents: [] };
  const handler = require(path.join(SCRIPTS, 'on-atdd-preedit.js'));
  const ev = (fp) => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'S5', tool_input: { file_path: fp } });
  const code = path.join(repo, 'src', 'a.ts');

  write(base);
  assert.ok(handler.handle(ev(code), { stateDir })?.block, 'control positivo: bloquea');

  // El CABLEADO story→gate: una story sin tabla ### Tests NO bloquea.
  write({ ...base, storyPath: sinTests });
  assert.equal(handler.handle(ev(code), { stateDir }), null, 'story sin ### Tests → pasa');

  // M10 — el kill-switch por env apaga la capa.
  write(base);
  process.env.TYCON_ATDD_PREEDIT_GATE = 'off';
  try {
    assert.equal(handler.handle(ev(code), { stateDir }), null, 'TYCON_ATDD_PREEDIT_GATE=off → pasa');
  } finally { delete process.env.TYCON_ATDD_PREEDIT_GATE; }

  // M11 — evento sin file_path no rompe ni bloquea.
  assert.equal(handler.handle({ hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 'S5', tool_input: {} }, { stateDir }), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── snapshot-iter deja constancia en gates.log (el conteo de iteraciones) ──
// 🔴 El registro de iteraciones no puede depender de que el orquestador invoque `check-count` cada vuelta: si no,
// gates.log queda con 1 entry `check:'advisors'` para 6 iteraciones reales. snapshot-iter es
// el ancla: lo dispara solo el auto-snapshot de on-advisor-run.js al completarse cada ronda.
test('snapshot-iter: cada iteración deja su constancia automática en gates.log (fin del undercount)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-iterlog-'));
  const activeDir = path.join(fakeHome, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const SID = 'iterlog-smoke';
  fs.writeFileSync(path.join(activeDir, `${SID}.json`), JSON.stringify({
    storyId: '1.14', storyPath: '/r/specs/s.md', repoPath: '/r', sessionId: SID,
    filesTouched: ['/r/src/a.ts'],
  }));
  const snap = (n) => require('child_process').execFileSync(
    process.execPath, [path.join(SCRIPTS, 'marker.js'), 'snapshot-iter', String(n)],
    { env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: SID }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  snap(1);
  snap(2);
  snap(2); // re-snapshot del mismo N: permitido (idempotente en el marker) — escribe otra línea

  const gl = fs.readFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.name === 'advisors-iter');
  assert.equal(gl.length, 3, 'cada invocación deja su línea — sin depender de que nadie se acuerde');
  assert.deepEqual(gl.map((e) => e.iter), [1, 2, 2]);
  // El conteo que consume el capturer: iters DISTINTOS por repoPath+storyId (el re-snapshot no infla).
  assert.equal(new Set(gl.map((e) => e.iter)).size, 2, 'distinct = iteraciones reales');
  for (const e of gl) {
    assert.equal(e.storyId, '1.14', 'la constancia dice de qué story es');
    assert.equal(e.repoPath, '/r', 'y de qué repo (namespace anti-colisión de ids)');
  }
  fs.rmSync(fakeHome, { recursive: true, force: true });
});


// ── La FOTO de la iteración no se fecha tarde ─────────────────────────────────────────────────
// 🔴 La foto automática de una iteración sale a las 16:52:52 (spawn del último revisor) y `reductor.js` se arregla
// a las 16:58:16; si una llamada MANUAL «al cierre del step» la re-fechara a las 17:03:17, el arreglo quedaría
// adentro de la foto → el delta de la iteración siguiente saldría VACÍO → `security-basics` y
// `silent-failure-hunter` se saltearían por «superficie no tocada».
// Este test es esa secuencia, de punta a punta: marker + registro de spawns reales → snapshot-iter
// → smart-reloop. Las dos capas del arreglo se verifican por separado, porque cubren cosas
// distintas: la guarda de `snapshot-iter` cierra el caso en origen, y el corte de `computeSmartReloop`
// es la única que sigue en pie con TYCON_SNAPSHOT_GUARD=0 o con una foto escrita a mano en el marker.
test('foto de iteración: la llamada manual no pisa la automática, y el re-loop vuelve a correr seguridad', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'foto-tardia-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'foto-repo-'));
  const SID = 'foto-replay-2-5';
  const stateDir = path.join(fakeHome, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(stateDir, 'active'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'advisor-runs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });

  const cp = require('child_process');
  const git = (...a) => cp.execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  const reductor = path.join(repo, 'src', 'reductor.js');
  const storyPath = path.join(repo, 'specs', 'story.md');
  fs.writeFileSync(reductor, 'function reducir(x) { return x; }\nmodule.exports = { reducir };\n');
  fs.writeFileSync(storyPath, '---\nstory: "2.5"\nepic: 2\nstatus: in-progress\n---\n# Story 2.5\n\n## Acceptance criteria\n- AC1: reducir\n\n### Tests\n| Test | AC |\n|---|---|\n| t1 | AC1 |\n');
  git('add', '-A');
  cp.execFileSync('git', ['-C', repo, '-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base'], { stdio: 'ignore' });
  fs.appendFileSync(reductor, '// fix del hallazgo\n');

  // Las horas REALES de la corrida. El mtime se fija con utimes y no con `touch -t`: con `touch` la
  // hora es LOCAL y el caso dejaría de reproducir la corrida según el huso de la máquina.
  const T_ULTIMO_REVISOR = '2026-09-15T16:52:52.354Z';
  const T_FOTO_AUTO = '2026-09-15T16:52:52.654Z';
  const T_EDICION = '2026-09-15T16:58:16.000Z';
  const T_FOTO_TARDIA = '2026-09-15T17:03:17.869Z';
  const seg = Date.parse(T_EDICION) / 1000;
  fs.utimesSync(reductor, seg, seg);

  const markerPath = path.join(stateDir, 'active', `${SID}.json`);
  const escribirMarker = (fotoTs) => fs.writeFileSync(markerPath, JSON.stringify({
    storyId: '2.5', storyPath, repoPath: repo, sessionId: SID,
    lastTouch: T_FOTO_TARDIA, stepsCompleted: [0, 1, 2, 3, 4], stepsPending: [5],
    filesTouched: [reductor],
    fileEvents: [{ path: reductor, ts: T_EDICION }],
    iterations: { 11: { ts: fotoTs, filesSnapshot: [reductor] } },
  }, null, 2));
  escribirMarker(T_FOTO_AUTO);

  fs.writeFileSync(path.join(stateDir, 'advisor-runs', `${SID}.jsonl`), [
    JSON.stringify({ ts: '2026-09-15T16:52:30.000Z', event: 'step5-start', iter: 11, expected: ['tycon-plugin-tests-coverage', 'tycon-plugin-security-basics'], mode: 'smart-reloop' }),
    JSON.stringify({ ts: '2026-09-15T16:52:40.000Z', advisor: 'tycon-plugin-tests-coverage', story: '2.5', repo }),
    JSON.stringify({ ts: T_ULTIMO_REVISOR, advisor: 'tycon-plugin-security-basics', story: '2.5', repo }),
    JSON.stringify({ ts: '2026-09-15T16:52:52.500Z', event: 'auto-snapshot', iter: 11 }),
  ].join('\n') + '\n');

  const env = { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: SID };
  // el tope de vueltas al máximo (el ajuste de la máquina): acá se mide la foto de la vuelta 12, no el tope
  fs.mkdirSync(path.join(fakeHome, '.claude', '.tycon-pipeline'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'review-max-rounds.json'), '{ "max_rounds": 99 }\n');
  const correr = (script, args, extraEnv) => cp.spawnSync(
    process.execPath, [path.join(SCRIPTS, script), ...args],
    { env: { ...env, ...(extraEnv || {}) }, cwd: repo, encoding: 'utf8' },
  );

  // ── Capa 1 — la llamada manual del «cierre del step», con el arreglo ya adentro ──
  const snap = correr('marker.js', ['snapshot-iter', '11']);
  assert.equal(snap.status, 0, 'el estado queda CORRECTO (la foto buena sigue) → no frena al que encadena smart-reloop');
  const m1 = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(m1.iterations['11'].ts, T_FOTO_AUTO, 'la foto automática NO se pisa');
  const gates = () => fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const conservada = gates().find((e) => e.name === 'advisors-iter' && e.foto === 'conservada');
  assert.ok(conservada, 'la decisión queda en gates.log — el orquestador llamó esto con >/dev/null 2>&1');
  assert.equal(conservada.ultimo_revisor, T_ULTIMO_REVISOR);
  assert.ok(conservada.posteriores.some((p) => p.path === reductor), 'y dice QUÉ archivo no vio ningún revisor');

  // La vuelta 12 es de las que piden la nota de «repensar el enfoque» (de la 3 en adelante), y pedir otra vez la 12 cuenta como la 13.
  for (const it of ['12', '13']) {
    const nota = correr('marker.js', ['rethink', '--iter', it, '--repo', repo, '--story', storyPath,
      '--repeated', 'Volvió el mismo hallazgo de seguridad en las vueltas anteriores, siempre sobre el mismo archivo',
      '--keep', 'Sigue igual: el arreglo es chico y el diseño de fondo no cambia entre vueltas']);
    assert.equal(nota.status, 0, nota.stderr);
  }

  // ── La consecuencia: el re-loop de la iteración 12 vuelve a mirar seguridad ──
  const rl = correr('pipeline.js', ['smart-reloop', '--iter', '12', '--repo', repo, '--story', storyPath, '--files', reductor]);
  assert.equal(rl.status, 0, rl.stderr);
  const out = JSON.parse(rl.stdout);
  assert.ok(out.delta_files.includes(reductor), 'el arreglo entra al delta');
  assert.ok(out.rerun.includes('tycon-plugin-security-basics'), 'y el revisor de seguridad vuelve a correr');
  assert.ok(!out.suspect_empty_delta, 'ya no hay delta vacío que empuje a --force-full-reloop');

  // ── Capa 2 — sola, sobre una foto tardía que la guarda no pudo impedir ──
  // (TYCON_SNAPSHOT_GUARD=0, una foto escrita a mano, o una máquina con el arnés atrasado.)
  escribirMarker(T_FOTO_TARDIA);
  const rl2 = correr('pipeline.js', ['smart-reloop', '--iter', '12', '--repo', repo, '--story', storyPath, '--files', reductor], { TYCON_SNAPSHOT_GUARD: '0' });
  assert.equal(rl2.status, 0, rl2.stderr);
  const out2 = JSON.parse(rl2.stdout);
  assert.equal(out2.suspect_late_snapshot, true, 'se detecta que la foto se fechó después del último revisor');
  // Se nombra lo que había tapado — y NADA más. (El mismo archivo puede venir dos veces, con la ruta
  // cruda y con la resuelta: en macOS `/var` es un symlink a `/private/var` y la fuente `git` devuelve
  // realpath. Es una rareza vieja de `delta_files`, no de esta capa: duplicar una ruta cuesta cero
  // —el mismo revisor— y colapsarla acá escondería un dato que el delta ya publica así.)
  assert.ok(out2.late_snapshot_files.length >= 1, 'y se nombra lo que había tapado');
  assert.ok(out2.late_snapshot_files.every((f) => f.endsWith(`${path.sep}src${path.sep}reductor.js`)), 'y sólo eso');
  assert.ok(out2.rerun.includes('tycon-plugin-security-basics'), 'el corte por último revisor rescata al revisor de seguridad');
  // 🔴 El aviso sale por stderr, no sólo dentro del JSON: si el orquestador filtra el JSON con un `python3 -c`,
  // la advertencia de delta vacío existiría sin que nadie la lea.
  assert.match(rl2.stderr, /foto de la iteración 11 se fechó DESPUÉS del último revisor/);

  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

// ── La guarda de la foto: las salidas y los límites (lib/late-snapshot.js) ────────────────────────
test('foto de iteración: sin registro de revisores no finge verificar, y los reportes no frenan', () => {
  const ft = require(path.join(SCRIPTS, 'lib', 'late-snapshot.js'));
  const ledger = (extra) => [
    JSON.stringify({ ts: '2026-09-15T16:52:30.000Z', event: 'step5-start', iter: 3, expected: ['tycon-plugin-security-basics'] }),
    JSON.stringify({ ts: '2026-09-15T16:52:52.354Z', advisor: 'tycon-plugin-security-basics', story: '2.5' }),
    ...(extra || []),
  ];

  // Sin registro (retomar la corrida en otra sesión sin copiar advisor-runs/<sid>.jsonl):
  // «no medido» se DICE, nunca se lee como «está todo bien».
  const sinLedger = ft.codigoDespuesDelUltimoRevisor({ ledgerLineas: [], marker: {}, repoRoot: null, iter: 3 });
  assert.equal(sinLedger.medible, false);
  assert.ok(sinLedger.motivo && sinLedger.motivo.length > 0, 'y con el motivo escrito');

  // Un spawn ad-hoc DESPUÉS de la ronda no mueve el corte: no es un revisor.
  const conAdhoc = ft.ultimoRevisorDeLaRonda(ledger([
    JSON.stringify({ ts: '2026-09-15T17:10:00.000Z', advisor: 'general-purpose', story: '2.5' }),
  ]));
  assert.equal(conAdhoc.iso, '2026-09-15T16:52:52.354Z', 'el corte lo fija el último REVISOR, no cualquier subagente');

  // Escribir los reportes de los revisores, la story y el README entre la foto y el cierre es lo
  // NORMAL de cada iteración: si eso frenara, el control se apaga en una semana.
  const marker = {
    filesTouched: [],
    fileEvents: [
      { path: '/r/.advisors/pipeline-runs/x/step-05-advisor-reports-iter4/r.md', ts: '2026-09-15T16:58:00.000Z' },
      { path: '/r/specs/story.md', ts: '2026-09-15T16:59:00.000Z' },
      { path: '/r/README.md', ts: '2026-09-15T17:00:00.000Z' },
    ],
    iterations: { 3: { ts: '2026-09-15T16:52:52.654Z', filesSnapshot: [] } },
  };
  const soloPapeles = ft.codigoDespuesDelUltimoRevisor({ ledgerLineas: ledger(), marker, repoRoot: null, iter: 3 });
  assert.equal(soloPapeles.medible, true);
  assert.deepEqual(soloPapeles.posteriores, [], 'reportes, specs y README no son código: la foto se toma igual');

  // Un `.js` en el medio SÍ cuenta — y la fuente queda dicha.
  marker.fileEvents.push({ path: '/r/src/reductor.js', ts: '2026-09-15T16:58:16.000Z' });
  const conCodigo = ft.codigoDespuesDelUltimoRevisor({ ledgerLineas: ledger(), marker, repoRoot: null, iter: 3 });
  assert.deepEqual(conCodigo.posteriores.map((e) => e.path), ['/r/src/reductor.js']);
  assert.equal(conCodigo.posteriores[0].fuente, 'fileEvents');
  assert.equal(conCodigo.fotoPrevia.ts, '2026-09-15T16:52:52.654Z', 'y se devuelve la foto previa para decidir si se conserva');
});

test('marker set: el cambio de story RESETEA atddBypass (F1 — el permiso no se hereda)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-bypass-'));
  const activeDir = path.join(fakeHome, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const SID = 'bypass-reset-smoke';
  fs.writeFileSync(path.join(activeDir, `${SID}.json`), JSON.stringify({
    storyId: '1.1', storyPath: '/r/specs/s.md', repoPath: '/r', sessionId: SID, atddBypass: true,
    filesTouched: ['/r/src/a.js'], filesTouchedAt: { '/r/src/a.js': { hash: 'deadbeef', ts: 1 } },
  }));
  const out = require('child_process').execFileSync(
    process.execPath,
    [path.join(SCRIPTS, 'marker.js'), 'set', JSON.stringify({ storyId: '2.2', storyPath: '/r/specs/s2.md', stepsPending: [0] })],
    { env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: SID }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const after = JSON.parse(out);
  assert.equal(after.atddBypass, undefined, 'la story nueva arranca con el portón PRENDIDO');
  // los sellos de contenido son ciclo de vida de la corrida: no viajan a la story siguiente
  assert.deepEqual(after.filesTouched, [], 'los archivos tocados no se heredan');
  assert.deepEqual(after.filesTouchedAt, {}, 'los sellos de contenido tampoco');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('marker complete-step 4: el flag atddBypass satisface el gate (F3 — un solo escape, no dos)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-cs4-'));
  const activeDir = path.join(fakeHome, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const SID = 'cs4-bypass-smoke';
  const mk = {
    storyId: '1.1', storyPath: '/r/specs/s.md', repoPath: '/r', sessionId: SID,
    stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5],
    fileEvents: [
      { path: '/r/src/impl.ts', ts: '2026-07-30T10:00:00.000Z' },   // código primero…
      { path: '/r/tests/a.test.ts', ts: '2026-07-30T11:00:00.000Z' }, // …test después = blocked
    ],
  };
  const run = (flag) => require('child_process').execFileSync(
    process.execPath,
    [path.join(SCRIPTS, 'marker.js'), 'complete-step', '4'],
    { env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: SID }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  // Sin flag → bloquea (control).
  fs.writeFileSync(path.join(activeDir, `${SID}.json`), JSON.stringify(mk));
  assert.throws(() => run(), /BLOQUEADO/, 'sin bypass el cierre frena');
  // Con atddBypass=true (el escape que dictó el portón) → pasa, sin exigir --no-atdd aparte.
  fs.writeFileSync(path.join(activeDir, `${SID}.json`), JSON.stringify({ ...mk, atddBypass: true }));
  run();
  const bypassLog = fs.readFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'bypass.log'), 'utf8');
  assert.match(bypassLog, /ATDD_BYPASS/, 'y queda auditado igual que --no-atdd');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// test-scope — deducir QUÉ suite mirar en un repo con más de un proyecto, y
// FRENAR cuando no se puede.
//
// Ejemplo: en el cierre de una story, si el gate elige solo el proyecto .NET, falla en 1,3s (NETSDK1045 — la
// máquina tiene otro SDK) y deja `tests-result.json` en rojo con el id de la story puesto, aunque la story no
// haya tocado un solo archivo .NET. Eso no es un gate: es evidencia falsa.
// ─────────────────────────────────────────────────────────────────────────────
const testScope = require(path.join(SCRIPTS, 'lib', 'test-scope.js'));

const CAND2 = [{ dir: 'apinetcore', runner: 'dotnet' }, { dir: 'mcp', runner: 'node-test' }];

test('test-scope: los archivos declarados salen limpios de comentarios inline y comillas', () => {
  const story = [
    '---',
    'story: "4.30"',
    'depends_on: ["4.17", "4.28"]',
    'files_to_create:',
    '  - "mcp/src/intent/huella.ts"              # AC1 — la huella de identidades',
    '  - mcp/tests/unit/huella.test.js   # sin comillas, con comentario',
    'files_to_modify:',
    "  - 'mcp/src/tools/persist.ts'   # AC3",
    'status: review',
    '---',
    'cuerpo, con un - guion suelto que NO es de la lista',
  ].join('\n');
  assert.deepEqual(testScope.parseDeclaredFiles(story), [
    'mcp/src/intent/huella.ts',
    'mcp/tests/unit/huella.test.js',
    'mcp/src/tools/persist.ts',
  ]);
});

test('test-scope: todos los archivos bajo un solo proyecto → deduce ESE alcance', () => {
  const r = testScope.deduceScope({ files: ['mcp/src/a.ts', 'mcp/tests/a.test.js'], candidates: CAND2 });
  assert.equal(r.scope, 'mcp');
  assert.equal(r.ambiguous, false);
  assert.equal(r.votes.apinetcore, 0);
});

test('@story-8.48 @ac-12 test-scope: archivos en DOS proyectos → corren los dos, no elige uno solo', () => {
  const r = testScope.deduceScope({ files: ['mcp/src/a.ts', 'apinetcore/Api/Svc.cs'], candidates: CAND2 });
  assert.equal(r.scope, null);
  assert.equal(r.ambiguous, false);
  assert.deepEqual(r.scopes, ['apinetcore', 'mcp']);
});

test('test-scope: archivos que no caen bajo ningún proyecto NO votan → ambiguo', () => {
  // Una story docs-only. No debe terminar corriendo .NET "porque el .csproj ganó
  // la detección por estar primero": ese es el defecto que el freno cierra.
  const r = testScope.deduceScope({ files: ['specs/x.md', 'tasks/todo.md'], candidates: CAND2 });
  assert.equal(r.scope, null);
  assert.equal(r.ambiguous, true);
});

test('test-scope: con proyecto en la RAÍZ, los archivos de otras carpetas no lo eligen por descarte', () => {
  // Ejemplo: el repo tiene `<repo>.sln` en la raíz además de `apinetcore/` y `mcp/`. Con la regla ingenua ("si no
  // cae en ningún subproyecto, es de la raíz"), tres archivos de documentación sueltos deducirían el proyecto .NET —
  // exactamente el falso alcance que el freno existe para frenar.
  const cands = [{ dir: '.', runner: 'dotnet' }, { dir: 'apinetcore', runner: 'dotnet' }, { dir: 'mcp', runner: 'node-test' }];
  const docs = testScope.deduceScope({ files: ['tasks/todo.md', 'processes/x/y.md'], candidates: cands });
  assert.equal(docs.scope, null, 'documentación en otra carpeta NO elige el proyecto de la raíz');
  assert.equal(docs.ambiguous, true);
  // Un archivo EN la raíz sí es del proyecto de la raíz (no se rompió el caso legítimo).
  const raiz = testScope.deduceScope({ files: ['Program.cs', 'Directory.Build.props'], candidates: cands });
  assert.equal(raiz.scope, '.');
  assert.equal(raiz.ambiguous, false);
});

// ── Territorio del candidato .sln ─────────────────────────────────────────────────────────────
// Ejemplo: un backend tiene un `.sln` en la raíz + `tools/chat-gateway` (vitest). Una story declara
// `src/<Producto>/OrdersRepository.cs` y `tests/<Producto>.Tests/...Tests.cs` — archivos DEL proyecto raíz, pero
// en subcarpetas, así que la regla "la raíz vota sólo por archivos sin '/'" los dejaría sin voto: 0 votos →
// freno falso (exit 4), destrabado a mano. El territorio NO relaja el freno: lee el manifest que ya existe — las
// rutas de proyecto del .sln.
const CAND_ROOT_SLN = [
  { dir: '.', runner: 'dotnet', territory: ['src/NimboBackend', 'tests/NimboBackend.Tests'] },
  { dir: 'tools/chat-gateway', runner: 'vitest' },
];

test('test-scope: archivos bajo el territorio del .sln de la raíz → votan la raíz (caso 1.8 exacto)', () => {
  const r = testScope.deduceScope({
    files: [
      'src/NimboBackend/Features/Orders/OrdersRepository.cs',
      'tests/NimboBackend.Tests/Features/Orders/OrdersRepositoryPrimaryKeyTests.cs',
    ],
    candidates: CAND_ROOT_SLN,
  });
  assert.equal(r.scope, '.', 'los archivos del proyecto raíz eligen la raíz aunque vivan en subcarpetas');
  assert.equal(r.ambiguous, false);
  assert.match(r.reason, /territorio del \.sln/, 'la elección dice DE DÓNDE salió');
});

test('test-scope: con territorio presente, la documentación sigue SIN votar → frena (re-assert 2026-08-13)', () => {
  // El territorio es estructura declarada por el .sln, no un "todo lo demás es de la raíz":
  // los docs no caen bajo ningún dir de proyecto y siguen sin elegir nada.
  const r = testScope.deduceScope({ files: ['tasks/todo.md', 'docs/nimbo/x.md'], candidates: CAND_ROOT_SLN });
  assert.equal(r.scope, null, 'documentación no vota ni con territorio declarado');
  assert.equal(r.ambiguous, true);
});

test('@story-8.48 @ac-12 test-scope: territorio raíz + archivo de OTRO proyecto → corren los dos', () => {
  const r = testScope.deduceScope({
    files: ['src/NimboBackend/Program.cs', 'tools/chat-gateway/src/spool.ts'],
    candidates: CAND_ROOT_SLN,
  });
  assert.equal(r.ambiguous, false, 'dos proyectos tocados → se corren los dos, con o sin territorio');
  assert.equal(r.scope, null);
  assert.equal(r.scopes.length, 2);
});

test('test-scope: un candidato explícito le GANA el archivo al territorio de otro', () => {
  // Proyecto híbrido: `src/App` es csproj declarado por el .sln raíz Y candidato node propio.
  // El candidato explícito se evalúa antes — el territorio jamás le roba archivos.
  const cands = [
    { dir: '.', runner: 'dotnet', territory: ['src/App'] },
    { dir: 'src/App', runner: 'vitest' },
  ];
  const r = testScope.deduceScope({ files: ['src/App/x.ts'], candidates: cands });
  assert.equal(r.scope, 'src/App');
  assert.equal(r.votes['.'], 0, 'el territorio no pisa a un candidato explícito');
});

test('test-scope: discoverCandidates arma el territorio parseando el .sln (y descarta solution-folders)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tscope-terr-'));
  fs.mkdirSync(path.join(tmp, 'src', 'App'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'App', 'App.csproj'), '<Project/>');
  fs.mkdirSync(path.join(tmp, 'tests', 'App.Tests'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'tests', 'App.Tests', 'App.Tests.csproj'), '<Project/>');
  fs.mkdirSync(path.join(tmp, 'gw'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'gw', 'package.json'), '{"name":"g","devDependencies":{"vitest":"^2"}}');
  // Formato real de .sln: rutas con backslash + una línea de solution-folder (sin .csproj)
  // que NO debe dar territorio + una referencia ..\ fuera del repo que se descarta.
  fs.writeFileSync(path.join(tmp, 'App.sln'), [
    'Microsoft Visual Studio Solution File, Format Version 12.00',
    'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "carpeta", "carpeta", "{AAA}"',
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App\\App.csproj", "{BBB}"',
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App.Tests", "tests\\App.Tests\\App.Tests.csproj", "{CCC}"',
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Ajena", "..\\otra\\Ajena.csproj", "{DDD}"',
  ].join('\n'));

  const c = testScope.discoverCandidates(tmp);
  const root = c.find((x) => x.dir === '.');
  assert.deepEqual(root.territory, ['src/App', 'tests/App.Tests'],
    'el territorio sale de las rutas .csproj del .sln — ni solution-folders ni referencias fuera del repo');
  assert.equal(c.find((x) => x.dir === 'gw').territory, undefined, 'los candidatos node no llevan territorio');
  // End-to-end con el mismo camino que consume test-gate.sh:
  const r = testScope.deduceScope({ files: ['src/App/Repo.cs', 'tests/App.Tests/RepoTests.cs'], candidates: c });
  assert.equal(r.scope, '.');
  assert.equal(r.ambiguous, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('test-scope: DOS .sln en el mismo dir → el territorio es la UNIÓN, no el último que pisa (pase adversarial 2026-08-28)', () => {
  // Ejemplo: un repo tiene `X.sln` + `X_release.sln` en la raíz y el _release no declara el proyecto de tests. Con
  // asignación (en vez de unión) el orden de readdirSync decide qué territorio sobrevive → freno falso sobre los
  // tests o, PEOR, en un cambio mixto la elección del OTRO candidato con un .cs cambiado adentro.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tscope-2sln-'));
  fs.mkdirSync(path.join(tmp, 'src', 'A'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'A', 'A.csproj'), '<Project/>');
  fs.mkdirSync(path.join(tmp, 'src', 'B'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'B', 'B.csproj'), '<Project/>');
  fs.mkdirSync(path.join(tmp, 'web'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'web', 'package.json'), '{"name":"w","devDependencies":{"vitest":"^2"}}');
  fs.writeFileSync(path.join(tmp, 'A.sln'),
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "A", "src\\A\\A.csproj", "{AAA}"\n');
  fs.writeFileSync(path.join(tmp, 'B.sln'),
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "B", "src\\B\\B.csproj", "{BBB}"\n');

  const c = testScope.discoverCandidates(tmp);
  const root = c.find((x) => x.dir === '.');
  assert.deepEqual(root.territory, ['src/A', 'src/B'], 'la unión de los dos .sln, gane quien gane el orden de lectura');

  // Un archivo del proyecto que solo declara el PRIMER sln → vota la raíz (sin eso: 0 votos, freno falso).
  const solo = testScope.deduceScope({ files: ['src/A/Repo.cs'], candidates: c });
  assert.equal(solo.scope, '.');
  // Mixto raíz + node → corren las dos (sin eso: podría salir 'web' sola con un .cs cambiado adentro).
  const mixto = testScope.deduceScope({ files: ['src/A/Repo.cs', 'web/app.ts'], candidates: c });
  assert.deepEqual(mixto.scopes, ['.', 'web'], 'jamás la suite node sola con un .cs de la raíz tocado');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('test-scope: .sln ilegible/vacío → territorio por fallback (los .csproj que cubre) — y sin datos, freno', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tscope-terrfb-'));
  fs.writeFileSync(path.join(tmp, 'App.sln'), ''); // vacío: el parseo no encuentra rutas
  fs.mkdirSync(path.join(tmp, 'src', 'App'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'App', 'App.csproj'), '<Project/>');
  fs.mkdirSync(path.join(tmp, 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'mcp', 'package.json'), '{"name":"m","scripts":{"test":"node --test"}}');

  const c = testScope.discoverCandidates(tmp);
  const root = c.find((x) => x.dir === '.');
  assert.deepEqual(root.territory, ['src/App'],
    'sin rutas parseables, el territorio cae a los dirs de .csproj cubiertos por la solución');
  // Y si TAMPOCO hubiera csproj visibles, territory queda undefined → deduceScope frena como
  // siempre: el error degrada al freno, nunca a elegir (cubierto por los tests del freno de arriba).
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('test-scope: sin archivos → ambiguo (nunca "el primero que aparezca")', () => {
  const r = testScope.deduceScope({ files: [], candidates: CAND2 });
  assert.equal(r.scope, null);
  assert.equal(r.ambiguous, true);
});

test('test-scope: un solo proyecto con tests → no hay nada que deducir ni que frenar', () => {
  const r = testScope.deduceScope({ files: [], candidates: [{ dir: '.', runner: 'vitest' }] });
  assert.equal(r.multi, false);
  assert.equal(r.ambiguous, false, 'un repo mono-stack NO se frena — la decisión 4 es sobre ambigüedad');
});

test('test-scope: descubre los proyectos con tests de un repo multi-stack real', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tscope-disc-'));
  fs.mkdirSync(path.join(tmp, 'apinetcore', 'Api'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'apinetcore', 'Api', 'Api.csproj'), '<Project/>');
  fs.mkdirSync(path.join(tmp, 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'mcp', 'package.json'), '{"name":"m","scripts":{"test":"node --test"}}');
  // Ruido que NO debe generar candidatos: node_modules (por los DOS caminos — el package.json
  // y el .csproj: el mutante M4 destapó que sólo se probaba el primero) y un subdir sin runner.
  fs.mkdirSync(path.join(tmp, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'node_modules', 'x', 'package.json'), '{"scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(tmp, 'node_modules', 'x', 'Vendored.csproj'), '<Project/>');
  fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
  const c = testScope.discoverCandidates(tmp);
  // 🔴 `apinetcore/Api` y no `apinetcore`: el candidato es la carpeta donde
  // `dotnet test` PUEDE correr — la que contiene el .sln/.csproj — no la primera del camino.
  // Colapsar al primer segmento devolvería `apinetcore`, que en este fixture no tiene
  // ni solución ni proyecto: `dotnet test` ahí sale MSB1003. Ver el test del contenedor, abajo.
  assert.deepEqual(c.map((x) => x.dir), ['apinetcore/Api', 'mcp']);
  assert.equal(c.find((x) => x.dir === 'mcp').runner, 'node-test');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── El contenedor que no es proyecto + jest ──────────────────────────────────
// Ejemplo: un repo tiene `custom-forms/backend-api-dotnet/` (.NET, con .sln) y `custom-forms/runtime-app/` (jest).
// Si el descubrimiento colapsa el .sln al primer segmento del camino, el candidato es
// `custom-forms`, que NO es un proyecto sino la carpeta que contiene a los dos. El gate corre
// `dotnet test` ahí, sale MSB1003 ("especifique un archivo de proyecto o solución") y deja
// `tests-result.json` en ROJO con el id de la story puesto — de código que la story sí tocaba,
// pero por un comando que no puede funcionar nunca: una constancia en rojo que parece verificación.
// Y el frontend es invisible por partida doble si jest no está en la lista de runners, o si los
// package.json solo se buscan en la raíz y un nivel abajo.
test('test-scope: .sln anidado → el candidato es la carpeta de la solución, no el contenedor', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tscope-nest-'));
  fs.mkdirSync(path.join(tmp, 'custom-forms', 'backend-api-dotnet', 'App.Tests'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'custom-forms', 'backend-api-dotnet', 'App.sln'), '');
  fs.writeFileSync(path.join(tmp, 'custom-forms', 'backend-api-dotnet', 'App.Tests', 'App.Tests.csproj'), '<Project/>');

  const c = testScope.discoverCandidates(tmp);
  const dotnet = c.filter((x) => x.runner === 'dotnet').map((x) => x.dir);

  assert.deepEqual(dotnet, ['custom-forms/backend-api-dotnet'],
    'el candidato es donde vive el .sln; el .csproj de adentro NO agrega un candidato aparte');
  assert.ok(!dotnet.includes('custom-forms'),
    'jamás el contenedor: `dotnet test` ahí es MSB1003');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('test-scope: jest es un runner, y se descubre aunque esté anidado', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tscope-jest-'));
  fs.mkdirSync(path.join(tmp, 'custom-forms', 'runtime-app'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'custom-forms', 'runtime-app', 'package.json'),
    '{"name":"rt","scripts":{"test":"jest"},"devDependencies":{"jest":"^29.0.0"}}');

  assert.equal(testScope.nodeRunnerOfPkg('{"devDependencies":{"jest":"^29"}}'), 'jest');
  // vitest sigue ganando si por alguna razón están los dos declarados
  assert.equal(testScope.nodeRunnerOfPkg('{"devDependencies":{"vitest":"^2","jest":"^29"}}'), 'vitest');

  const c = testScope.discoverCandidates(tmp);
  assert.deepEqual(c, [{ dir: 'custom-forms/runtime-app', runner: 'jest' }]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('test-scope: story que toca backend Y frontend del mismo contenedor → ambiguo, FRENA', () => {
  // Es el caso del contenedor: toca los dos proyectos. Lo correcto NO es elegir el contenedor
  // ni uno de los dos al azar: es frenar y pedir el alcance, que es lo que el gate ya sabe hacer.
  const cands = [
    { dir: 'custom-forms/backend-api-dotnet', runner: 'dotnet' },
    { dir: 'custom-forms/runtime-app', runner: 'jest' },
  ];
  const r = testScope.deduceScope({
    files: [
      'custom-forms/backend-api-dotnet/BizuitCustomForms.WebApi/Controllers/PluginAdminController.cs',
      'custom-forms/runtime-app/components/migration-sql-modal.tsx',
    ],
    candidates: cands,
  });
  assert.equal(r.ambiguous, false, 'dos proyectos tocados → se corren los dos');
  assert.equal(r.scope, null);
  assert.match(r.reason, /2 proyectos/);
});

// ── test-gate.sh — los dos caminos, por el binario de VERDAD ─────────────────
function mkMultiStackRepo(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgate-'));
  fs.mkdirSync(path.join(tmp, 'apinetcore', 'Api'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'apinetcore', 'Api', 'Api.csproj'), '<Project/>');
  fs.mkdirSync(path.join(tmp, 'mcp', 'tests'), { recursive: true });
  // OJO: `node --test tests/` (dir como arg) rompe en Node 23.11 ("Cannot find module");
  // sin args auto-descubre `tests/` y funciona en 20/22/23.
  fs.writeFileSync(path.join(tmp, 'mcp', 'package.json'),
    '{"name":"m","version":"1.0.0","scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(tmp, 'mcp', 'tests', 'ok.test.js'),
    "const {test}=require('node:test');test('ok',()=>{});");
  for (const [rel, body] of Object.entries(files || {})) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), body);
  }
  return tmp;
}

function runTestGate(repo, storyArg, fakeHome) {
  const { spawnSync } = require('child_process');
  return spawnSync('bash', [path.join(SCRIPTS, 'test-gate.sh'), repo, storyArg], {
    env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: 'tgate-none' },
    encoding: 'utf8',
  });
}

test('test-gate.sh: repo multi-stack sin poder deducir → FRENA (exit 4) y deja constancia DEL FRENO', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgate-home-'));
  const repo = mkMultiStackRepo();
  const r = runTestGate(repo, '9.9', fakeHome);   // $2 es un id: no hay archivos declarados que mirar
  assert.equal(r.status, 4, `esperaba el freno, salió ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /FRENADO|NO PUEDO SABER/, 'el freno se anuncia, no es silencioso');
  assert.doesNotMatch(r.stdout + r.stderr, /dotnet test/, 'y sobre todo: NO corrió el proyecto equivocado');
  const art = JSON.parse(fs.readFileSync(path.join(repo, '.advisors', 'tests-result.json'), 'utf8'));
  assert.equal(art.halted, true);
  assert.equal(art.suite_green, false, 'un freno jamás se lee como verde');
  assert.equal(art.story_id, '9.9', 'la constancia dice de qué story es el freno');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('test-gate.sh: deduce el alcance desde los archivos que declara la story y corre ESA suite', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgate-home-'));
  const repo = mkMultiStackRepo({
    'specs/s.md': ['---', 'story: "4.30"', 'files_to_create:',
      '  - "mcp/src/huella.ts"   # AC1', 'files_to_modify:',
      '  - "mcp/tests/ok.test.js"', '---', 'cuerpo'].join('\n'),
  });
  const r = runTestGate(repo, path.join(repo, 'specs', 's.md'), fakeHome);
  assert.equal(r.status, 0, `esperaba verde, salió ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /DEDUCIDO/, 'y dice de dónde salió el alcance');
  assert.doesNotMatch(r.stdout + r.stderr, /dotnet test/);
  const art = JSON.parse(fs.readFileSync(path.join(repo, '.advisors', 'tests-result.json'), 'utf8'));
  assert.equal(art.runner, 'node-test');
  assert.equal(art.story_id, '4.30', 'el id sale del frontmatter cuando $2 es una ruta');
  assert.equal(art.scope, 'mcp');
  assert.equal(art.scope_source, 'story');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('T18 TestGate_SuitesJson_DeferredInTestsResult — story 7.15: la diferida queda en tests-result.json; si la story toca la carpeta, corre', () => {
  // test-gate.sh necesita pasarle al runner lo que toca la story: si no, la diferible corre
  //    siempre (primer caso), o el parser no lleva `deferred_suites` a totals.
  const { execFileSync } = require('child_process');
  const armarArnes = () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tgate-arnes-'));
    const w = (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), body);
    };
    w('scripts/tests/suites.json', JSON.stringify({ diarias: [
      { raiz: 'arnes', ruta: 'tests/verde.test.sh', requiere: [] },
      { raiz: 'arnes', ruta: 'tests/diferible.test.sh', requiere: [], gate_only_when_touching: ['scripts/lab-pub/**'] },
    ] }));
    w('scripts/tests/verde.test.sh', 'exit 0\n');
    w('scripts/tests/diferible.test.sh', 'echo "corrió la diferible"; exit 1\n');
    w('specs/no-toca.md', ['---', 'epic: 9', 'story: "9.1"', 'status: in-progress', 'files_to_modify:',
      '  - "scripts/hooks/x.js"', '---', ''].join('\n'));
    w('specs/toca.md', ['---', 'epic: 9', 'story: "9.2"', 'status: in-progress', 'files_to_modify:',
      '  - "scripts/lab-pub/y.js"', '---', ''].join('\n'));
    const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'ignore' });
    g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'base');
    return repo;
  };
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgate-home-'));
  // Con base explícita (como la del marcador en una corrida del pipeline). Sin ella, la base cae a HEAD por
  // defecto y el gate —a propósito— no difiere nada (caso de abajo).
  const conBase = (repo, story) => {
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const { spawnSync } = require('child_process');
    return spawnSync('bash', [path.join(SCRIPTS, 'test-gate.sh'), repo, story], {
      env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: 'tgate-none', TYCON_COVERAGE_BASE: head },
      encoding: 'utf8',
    });
  };

  const a = armarArnes();
  const r1 = conBase(a, path.join(a, 'specs', 'no-toca.md'));
  assert.equal(r1.status, 0, `la story no toca publicación: verde sin la diferible\n${r1.stdout}\n${r1.stderr}`);
  const art1 = JSON.parse(fs.readFileSync(path.join(a, '.advisors', 'tests-result.json'), 'utf8'));
  assert.equal(art1.runner, 'suites-json');
  assert.equal(art1.totals.deferred, 1);
  assert.match(art1.totals.deferred_suites[0].suite, /diferible\.test\.sh$/);
  assert.ok(art1.totals.workers >= 1 && typeof art1.totals.wall_ms === 'number', 'workers y wall_ms llegan a totals');
  assert.ok(fs.existsSync(path.join(a, '.advisors', 'dod-runtime', '9.1-tests-result.json')), 'la copia que viaja sigue saliendo');

  // Decide el cambio REAL, no la lista de la story: `toca.md` declara publicación y
  // además la corrida cambia un archivo ahí (sin eso, la diferible se difiere: touched-files.test.js T1).
  const b = armarArnes();
  fs.mkdirSync(path.join(b, 'scripts', 'lab-pub'), { recursive: true });
  fs.writeFileSync(path.join(b, 'scripts', 'lab-pub', 'y.js'), 'module.exports = 1;\n');
  const r2 = conBase(b, path.join(b, 'specs', 'toca.md'));
  assert.notEqual(r2.status, 0, 'la corrida toca publicación: la diferible corre y su rojo cuenta');
  const art2 = JSON.parse(fs.readFileSync(path.join(b, '.advisors', 'tests-result.json'), 'utf8'));
  assert.equal(art2.totals.deferred, 0);
  assert.deepEqual(art2.totals.failures, ['diferible.test.sh']);
  assert.ok(fs.existsSync(path.join(b, '.advisors', 'dod-runtime', '9.2-tests-result.json')));

  // 🔴 Sin marcador ni TYCON_COVERAGE_BASE la base cae a HEAD y lo commiteado
  //    no se ve → «no sé» → corre todo, aunque la story diga que no toca publicación.
  const c = armarArnes();
  const r3 = runTestGate(c, path.join(c, 'specs', 'no-toca.md'), fakeHome);
  assert.notEqual(r3.status, 0, 'con la base por defecto (HEAD) no se difiere: la diferible corre');
  assert.match(r3.stdout + r3.stderr, /no pude saber qué archivos toca la story/);

  for (const d of [a, b, c, fakeHome]) fs.rmSync(d, { recursive: true, force: true });
});

test('test-gate.sh: repo con jest → lo corre de verdad y deja los totales', (t) => {
  // Sin jest instalado en la máquina el test no puede correr: se SALTEA anunciándolo (no se
  // finge verde). El resto de la red cubre la detección y la deducción sin depender de npx.
  const probe = require('child_process').spawnSync('npx', ['--no-install', 'jest', '--version'],
    { encoding: 'utf8', timeout: 60000 });
  if (probe.status !== 0) {
    t.skip('jest no está instalado en esta máquina — se saltea el camino de integración');
    return;
  }

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgate-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tgate-jest-'));
  fs.mkdirSync(path.join(repo, '__tests__'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'),
    '{"name":"j","version":"1.0.0","scripts":{"test":"jest"},"devDependencies":{"jest":"^29.0.0"}}');
  fs.writeFileSync(path.join(repo, '__tests__', 'ok.test.js'), "test('ok', () => { expect(1).toBe(1); });");

  const r = require('child_process').spawnSync('bash', [path.join(SCRIPTS, 'test-gate.sh'), repo, '10.2'], {
    env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: 'tgate-none' },
    encoding: 'utf8',
  });

  assert.notEqual(r.status, 3, `no debe decir "no hay stack de tests":\n${r.stderr}`);
  assert.equal(r.status, 0, `esperaba verde, salió ${r.status}\n${r.stdout}\n${r.stderr}`);

  const art = JSON.parse(fs.readFileSync(path.join(repo, '.advisors', 'tests-result.json'), 'utf8'));
  assert.equal(art.runner, 'jest');
  assert.equal(art.suite_green, true);
  assert.equal(art.totals.total, 1, 'los totales salen del JSON de jest, no de parsear texto');
  assert.equal(art.totals.passed, 1);
  assert.equal(art.totals.failed, 0);

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('test-gate.sh: alcance que NO tiene proyecto .NET adentro → FRENA, no corre dotnet a ciegas', () => {
  // La otra mitad del caso 10.2: aunque alguien pase el contenedor a mano, el gate no puede
  // lanzar un `dotnet test` que sale MSB1003 y dejar eso escrito como si fuera un resultado.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgate-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tgate-cont-'));
  fs.mkdirSync(path.join(repo, 'custom-forms', 'backend', 'App.Tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'custom-forms', 'backend', 'App.sln'), '');
  fs.writeFileSync(path.join(repo, 'custom-forms', 'backend', 'App.Tests', 'App.Tests.csproj'), '<Project/>');

  const r = require('child_process').spawnSync(
    'bash', [path.join(SCRIPTS, 'test-gate.sh'), repo, '10.2', 'custom-forms'],
    { env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: 'tgate-none' }, encoding: 'utf8' }
  );

  assert.equal(r.status, 4, `esperaba el freno, salió ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /FRENADO|no tiene .*proyecto/i, 'el freno dice por qué');
  const art = JSON.parse(fs.readFileSync(path.join(repo, '.advisors', 'tests-result.json'), 'utf8'));
  assert.equal(art.halted, true);
  assert.equal(art.suite_green, false, 'un freno jamás se lee como verde');

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// suite-freshness — ¿el verde de la suite completa sigue midiendo ESTE código?
// (Un verde del Step 4 puede quedar stale tras iteraciones de fixes; step-07b lo chequea al converger.)
// ─────────────────────────────────────────────────────────────────────────────
const suiteFreshness = require(path.join(SCRIPTS, 'lib', 'suite-freshness.js'));

function mkGitRepo(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfresh-'));
  const g = (args) => require('child_process').execFileSync('git', ['-C', tmp, ...args],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@tycon.local']);
  g(['config', 'user.name', 'tycon-tests']);
  for (const [rel, body] of Object.entries(files || {})) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), body);
  }
  return { tmp, g };
}

test('suite-freshness: el hash es estable, cambia con el CÓDIGO y NO con docs ni commits', () => {
  const { tmp, g } = mkGitRepo({
    'src/App/Repo.cs': 'class Repo {}',
    'docs/story.md': '# story',
  });
  const a = suiteFreshness.codeState(tmp);
  assert.equal(a.git, true);
  assert.equal(a.code_files, 1, 'sólo el .cs cuenta como código');
  assert.equal(suiteFreshness.codeState(tmp).state_hash, a.state_hash, 'mismo estado → mismo hash');

  // Editar DOCUMENTACIÓN no invalida el verde: la suite no la ejecuta.
  fs.writeFileSync(path.join(tmp, 'docs/story.md'), '# story v2 con más texto');
  assert.equal(suiteFreshness.codeState(tmp).state_hash, a.state_hash, 'un .md no cambia la huella');

  // 🔴 La propiedad que justifica hashear index+working tree y NO comparar contra HEAD:
  // add + commit SIN tocar código deja la huella IGUAL. (Contra HEAD, cada commit de la
  // story dispararía un stale falso y una suite completa de más — justo lo que la regla 2
  // de test-execution-discipline prohíbe pagar al pedo.)
  g(['add', '-A']);
  assert.equal(suiteFreshness.codeState(tmp).state_hash, a.state_hash, 'git add no cambia la huella');
  g(['commit', '-q', '-m', 'story']);
  assert.equal(suiteFreshness.codeState(tmp).state_hash, a.state_hash, 'git commit tampoco');

  // Editar CÓDIGO sí — incluidos los tests.
  fs.writeFileSync(path.join(tmp, 'src/App/Repo.cs'), 'class Repo { /* fix iter 2 */ }');
  const b = suiteFreshness.codeState(tmp);
  assert.notEqual(b.state_hash, a.state_hash, 'un .cs editado cambia la huella');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('suite-freshness: la huella se mide SIEMPRE desde la raíz del repo — subdir y raíz dan el mismo hash (pase adversarial 2026-08-28)', () => {
  // test-gate.sh reasigna $REPO al subdir del alcance (`mcp/`). Si el artefacto se midiera desde ahí y el check del
  // step-07b desde la raíz, daría STALE falso SIEMPRE en repos con alcance de subcarpeta = una suite completa extra
  // por story sin un solo cambio. Por eso la huella se mide desde la raíz en los dos lados.
  const { tmp } = mkGitRepo({
    'apinetcore/Api/Svc.cs': 'class Svc {}',
    'mcp/src/a.ts': 'export const a = 1;',
  });
  const desdeRaiz = suiteFreshness.codeState(tmp);
  const desdeSubdir = suiteFreshness.codeState(path.join(tmp, 'mcp'));
  assert.equal(desdeSubdir.state_hash, desdeRaiz.state_hash, 'mismo frame: el subdir no cambia la huella');
  assert.equal(desdeRaiz.code_files, 2);

  // El ciclo del bug: artefacto grabado "desde el subdir" (como hace test-gate con scope) →
  // check desde la raíz tiene que dar FRESCO, no el falso stale sistemático.
  const art = path.join(tmp, '.advisors', 'tests-result.json');
  fs.mkdirSync(path.dirname(art), { recursive: true });
  fs.writeFileSync(art, JSON.stringify({ ts: 't', suite_green: true, code_state: desdeSubdir }));
  const chk = require('child_process').spawnSync('node',
    [path.join(SCRIPTS, 'lib', 'suite-freshness.js'), 'check', tmp], { encoding: 'utf8' });
  assert.equal(chk.status, 0, `esperaba FRESCO:\n${chk.stdout}${chk.stderr}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('suite-freshness: un cambio SOLO en un manifest (.csproj/.sql) también invalida el verde', () => {
  const { tmp } = mkGitRepo({ 'src/App/App.csproj': '<Project/>', 'src/App/Repo.cs': 'class R {}' });
  const a = suiteFreshness.codeState(tmp);
  assert.equal(a.code_files, 2, 'el .csproj cuenta: un bump de PackageReference cambia el resultado de la suite');
  fs.writeFileSync(path.join(tmp, 'src/App/App.csproj'), '<Project><ItemGroup/></Project>');
  assert.notEqual(suiteFreshness.codeState(tmp).state_hash, a.state_hash);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('suite-freshness: sin git no inventa una huella — dice git:false y el check da SIN DATOS', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfresh-nogit-'));
  fs.writeFileSync(path.join(tmp, 'a.cs'), 'class A {}');
  const s = suiteFreshness.codeState(tmp);
  assert.equal(s.git, false);
  assert.equal(s.state_hash, null, 'nunca un hash inventado: un fresco falso es peor que no saber');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('suite-freshness check: el ciclo completo de step-07b por el CLI de verdad (fresco → stale → sin datos)', () => {
  const { tmp } = mkGitRepo({ 'src/App/Repo.cs': 'class Repo {}' });
  const check = () => require('child_process').spawnSync('node',
    [path.join(SCRIPTS, 'lib', 'suite-freshness.js'), 'check', tmp], { encoding: 'utf8' });

  // Sin artefacto → 6 (no hay corrida que validar; el DoD checker sigue de red).
  assert.equal(check().status, 6);

  // Artefacto verde con la huella actual (lo que escribe test-gate.sh al cerrar) → 0 FRESCO.
  const art = path.join(tmp, '.advisors', 'tests-result.json');
  fs.mkdirSync(path.dirname(art), { recursive: true });
  const writeArt = (extra) => fs.writeFileSync(art, JSON.stringify({
    ts: '2026-08-28T00:00:00Z', suite_green: true,
    code_state: suiteFreshness.codeState(tmp), ...extra,
  }));
  writeArt();
  let r = check();
  assert.equal(r.status, 0, `esperaba FRESCO:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /FRESCO/);

  // Fix de iteración 2 → 5 STALE, y el mensaje dice qué hacer.
  fs.writeFileSync(path.join(tmp, 'src/App/Repo.cs'), 'class Repo { /* T12 endurecido */ }');
  r = check();
  assert.equal(r.status, 5, 'código cambiado tras el verde → STALE');
  assert.match(r.stdout, /re-correr test-gate/);

  // Un verde viejo sin code_state (corrida anterior a este control) → 6, no un veredicto inventado.
  writeArt({ code_state: undefined });
  assert.equal(check().status, 6);

  // Una corrida en ROJO no se "valida por frescura": lo que corresponde es correr el gate.
  writeArt({ suite_green: false });
  assert.equal(check().status, 6);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('test-gate.sh: el artefacto registra code_state (la huella que step-07b compara)', () => {
  // Fixture node-test CON git: el gate corre la suite y la huella queda escrita con git:true.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgate-home-'));
  const { tmp } = mkGitRepo({
    'package.json': '{"name":"m","version":"1.0.0","scripts":{"test":"node --test"}}',
    'tests/ok.test.js': "const {test}=require('node:test');test('ok',()=>{});",
  });
  const r = runTestGate(tmp, '1.8', fakeHome);
  assert.equal(r.status, 0, `esperaba verde, salió ${r.status}\n${r.stdout}\n${r.stderr}`);
  const art = JSON.parse(fs.readFileSync(path.join(tmp, '.advisors', 'tests-result.json'), 'utf8'));
  assert.equal(art.code_state.git, true, 'la corrida deja su huella de código');
  assert.match(art.code_state.state_hash, /^[0-9a-f]{64}$/);
  // Y el check inmediato da FRESCO: gate → check es exactamente la secuencia del cierre.
  const chk = require('child_process').spawnSync('node',
    [path.join(SCRIPTS, 'lib', 'suite-freshness.js'), 'check', tmp], { encoding: 'utf8' });
  assert.equal(chk.status, 0, `gate recién corrido tiene que dar FRESCO:\n${chk.stdout}${chk.stderr}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// complete-step 4 — el verde de `tests` tiene que venir de la suite COMPLETA
//
// Un verde parcial no puede pasar por control: p. ej., el check queda verde con 872 de 2400 tests (los que la
// story declara, corridos a mano vía `run-check tests -- node --test <lista>`) aunque la única corrida completa
// salga en rojo con 13 fallas.
// ─────────────────────────────────────────────────────────────────────────────
function completeStep4With(provenance) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-cs4prov-'));
  const activeDir = path.join(fakeHome, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const SID = 'cs4-prov-smoke';
  fs.writeFileSync(path.join(activeDir, `${SID}.json`), JSON.stringify({
    storyId: '1.1', storyPath: '/r/specs/s.md', repoPath: '/r', sessionId: SID,
    stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5],
    fileEvents: [],   // sin eventos → el gate ATDD avisa y sigue: no contamina este control
    checks: provenance === null ? {} : { tests: 'green' },
    checksProvenance: provenance === null ? {} : { tests: provenance },
  }));
  const run = () => require('child_process').execFileSync(
    process.execPath,
    [path.join(SCRIPTS, 'marker.js'), 'complete-step', '4'],
    { env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: SID }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  return { run, fakeHome };
}

test('run-check tests: TYCON_TEST_GATE=1 marca provenance `test-gate`; sin él, `run-check`', () => {
  // El cable entre test-gate.sh y el freno de complete-step 4. Sin este test el mecanismo
  // entero se podía romper sin que nada se pusiera rojo (mutante M7: `prov` clavado en
  // 'run-check' sobrevivía porque los tests del freno escribían el marker a mano).
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-prov-'));
  const activeDir = path.join(fakeHome, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const SID = 'run-check-prov';
  const mkPath = path.join(activeDir, `${SID}.json`);
  const runCheck = (name, env) => {
    fs.writeFileSync(mkPath, JSON.stringify({ storyId: '1.1', repoPath: '/r', sessionId: SID }));
    require('child_process').execFileSync(
      process.execPath,
      [path.join(SCRIPTS, 'marker.js'), 'run-check', name, '--', 'true'],
      { env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_SESSION_ID: SID, ...env }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(fs.readFileSync(mkPath, 'utf8')).checksProvenance;
  };
  assert.equal(runCheck('tests', { TYCON_TEST_GATE: '1' }).tests, 'test-gate');
  assert.equal(runCheck('tests', { TYCON_TEST_GATE: '' }).tests, 'run-check',
    'una corrida a mano NO se disfraza de gate');
  assert.equal(runCheck('build', { TYCON_TEST_GATE: '1' }).build, 'run-check',
    'la marca es sólo para `tests` — no se filtra a los otros checks');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('complete-step 4: verde de tests por run-check a mano (suite parcial) → BLOQUEA', () => {
  const { run, fakeHome } = completeStep4With('run-check');
  assert.throws(() => run(), /BLOQUEADO/, 'un verde parcial no cierra el step');
  const gates = fs.readFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8');
  assert.match(gates, /tests-scope/, 'y el bloqueo queda auditado');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('complete-step 4: verde de tests por test-gate (suite completa) → pasa', () => {
  const { run, fakeHome } = completeStep4With('test-gate');
  run();
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('complete-step 4: escape consciente `--force-manual` → pasa (queda logueado por set-check)', () => {
  const { run, fakeHome } = completeStep4With('manual-forced');
  run();
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('complete-step 4: tests AUSENTE no bloquea (ausencia ≠ verde falso)', () => {
  const { run, fakeHome } = completeStep4With(null);
  run();
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── detector de story-de-UI — el lado FE se declara por repo, no por producto en el harness ──
// Ningún nombre de producto va EN DURO en marker.js / on-pre-commit.js / qa-guide.js / atdd-commit-gate.js. La señal
// es: extensiones FE genéricas (.tsx/.jsx/.vue/.svelte) · paths genéricos (front-end, src/app/,
// src/components/) · tokens DECLARADOS en .tycon/advisors.yaml → evidence.fe_paths · escenarios E2E.
function uiFixtureRepo(fePathsYaml) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'uisig-'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  if (fePathsYaml) {
    fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), fePathsYaml);
  }
  return repo;
}
const qaGuide = require(path.join(SCRIPTS, 'qa-guide.js'));
const atddGate = require(path.join(SCRIPTS, 'lib', 'atdd-commit-gate.js'));
const fmOf = (s) => (s.split(/^---\s*$/m)[1] || '');

test('detector UI: fe_paths declarado marca UI aunque el path no tenga extensión FE ni nombre Ceibo', () => {
  const repo = uiFixtureRepo('evidence:\n  fe_paths:\n    - mi-ui-app\n');
  const story = '---\nstory: "1.1"\nfiles_to_modify:\n  - mi-ui-app/src/panel.ts\n---\n\n## Acceptance Criteria\n1. algo\n';
  assert.equal(qaGuide.isUiStory(story, fmOf(story), repo), true, 'qa-guide.isUiStory debe honrar fe_paths');
  assert.equal(atddGate.storyIsHandOperable(story, repo), true, 'atdd-commit-gate debe honrar fe_paths');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('detector UI: un repo FE se reconoce genérico por nombre (sin config) — Ceibo no pierde cobertura', () => {
  const story = '---\nstory: "1.1"\nfiles_to_modify:\n  - CeiboFrontEnd/src/x.ts\n---\ncuerpo sin e2e\n';
  assert.equal(qaGuide.isUiStory(story, fmOf(story)), true);
  assert.equal(atddGate.storyIsHandOperable(story), true);
});

test('detector UI: backend puro NO es UI (con o sin config presente)', () => {
  const repo = uiFixtureRepo('evidence:\n  fe_paths:\n    - mi-ui-app\n');
  const story = '---\nstory: "1.1"\nfiles_to_modify:\n  - src/Feature.cs\n---\ncuerpo sin escenarios\n';
  assert.equal(qaGuide.isUiStory(story, fmOf(story), repo), false);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ── El detector lee las LISTAS antes que la prosa ─────────────────────────────────────────────
// Una story de backend con sólo `.cs` en sus listas y una ruta HTTP terminada en `/frontend` en el driver no es de
// pantalla: tratarla como tal pediría pruebas de navegador que no pueden existir y la guía del tester la
// bloquearía sin salida. La prosa (título, driver, comentarios) cuenta sólo si la
// story no declara archivos a tocar; las listas, los campos estructurados y las tandas mandan.
const uiStory = (fmBody, body = 'cuerpo sin escenarios\n') => `---\nstory: "9.1"\nepic: 9\n${fmBody}---\n\n${body}`;
const uiDetect = (s, repo) => require(path.join(SCRIPTS, 'lib', 'ui-signal.js')).storyTouchesUi(s, repo);
const LISTAS_CS = 'files_to_create:\n  - src/AcmeBackend/Estado/EstadoEndpoint.cs\nfiles_to_modify:\n  - src/AcmeBackend/AcmePlugin.cs\n';

test('detector UI: una ruta HTTP terminada en /frontend en el driver no hace de pantalla a una story con sólo .cs en sus listas', () => {
  const casos = [
    'driver: "GET /api/admin/algo/frontend responde sin sesion"\n',
    'driver: "el front-end necesita saber si hay sesion"\n',
    'driver: "como hace src/app/ del otro producto"\n',
    'blocks:\n  - "9.2"  # la pantalla del frontend\n',
  ];
  for (const c of casos) {
    const s = uiStory(c + LISTAS_CS);
    assert.equal(uiDetect(s), false, `no es pantalla: ${c.trim()}`);
    assert.equal(qaGuide.isUiStory(s, fmOf(s)), false, `qa-guide tampoco: ${c.trim()}`);
  }
});

test('detector UI: sin listas de archivos, el título que nombra el frente sigue marcando pantalla', () => {
  const titulo = 'title: "Frontend: panel de estado"\n';
  assert.equal(uiDetect(uiStory(titulo)), true, 'sin listas');
  assert.equal(uiDetect(uiStory(titulo + 'files_to_modify: []\n')), true, 'lista vacía');
  assert.equal(uiDetect(uiStory(titulo + 'files_to_modify: TBD\n')), true, 'TBD no declara archivos');
  assert.equal(uiDetect(uiStory(titulo + 'files_to_modify: null\n')), true, 'null no declara archivos');
  assert.equal(uiDetect(uiStory(titulo + 'files_to_reference:\n  - src/AcmeBackend/Lectura.cs\n')), true,
    'una lista de lectura no declara archivos a tocar');
  assert.equal(uiDetect(uiStory('driver: "GET /api/admin/algo/frontend responde"\n')), false,
    'sin listas, una ruta HTTP como única mención no es pantalla');
});

test('detector UI: una tanda de pipelines que nombra el frente marca pantalla aunque las listas sean de backend', () => {
  const casos = [
    'pipelines:\n  B-frontend:\n    status: pending\n',
    'Pipelines:\n  B-frontend:\n    status: pending\n',
    'tandas:\n  - nombre: B-frontend\n',
    'repo: acme-frontend\n',
    'repos:\n  - AcmeBackend\n  - AcmeFrontEnd\n',
    'target_repos: [AcmeFrontEnd]\n',
    'target_repo: AcmeFrontEnd\n',
    'tags:\n  - backend\n  - frontend\n',
  ];
  for (const c of casos) assert.equal(uiDetect(uiStory(LISTAS_CS + c)), true, `es pantalla: ${c.trim()}`);
});

// Un script no es una pantalla: un gate de un repo que se llama FrontEnd no hace de pantalla a la story que lo toca.
// Lo que decide es la extensión o la carpeta del archivo; el nombre del repo sigue contando para el resto.
test('detector UI: un script o un archivo de CI dentro de un repo del frente no marca pantalla', () => {
  const casos = [
    'files_to_modify:\n  - "(AcmeFrontEnd) scripts/e2e-gate.sh"\n',
    'files_to_modify:\n  - "(AcmeFrontEnd) scripts/e2e-gate.test.js"\n',
    'files_to_modify:\n  - AcmeFrontEnd/azure-pipelines.yml\n',
    'files_to_modify:\n  - AcmeFrontEnd/tools/medir.py\n',
    'files_to_modify:\n  - AcmeFrontEnd/.github/workflows/ci.yml\n',
  ];
  for (const c of casos) assert.equal(uiDetect(uiStory(c)), false, `no es pantalla: ${c.trim()}`);
  assert.equal(uiDetect(uiStory('files_to_modify:\n  - "(AcmeFrontEnd) src/hooks/useAlgo.ts"\n')), true,
    'un .ts del frente sigue siendo pantalla por el nombre del repo');
  assert.equal(uiDetect(uiStory('files_to_modify:\n  - "(AcmeFrontEnd) scripts/e2e-gate.sh"\n  - "(AcmeFrontEnd) src/hooks/useAlgo.ts"\n')), true,
    'con un archivo del frente en otra entrada, la story sigue siendo de pantalla');
  assert.equal(uiDetect(uiStory('files_to_modify:\n  - AcmeFrontEnd/scripts/Panel.tsx\n')), true,
    'una extensión de pantalla manda aunque esté en scripts/');
  assert.equal(uiDetect(uiStory('files_to_modify:\n  - AcmeFrontEnd/src/components/scripts/carga.ts\n')), true,
    'bajo una carpeta de pantalla manda la carpeta');
  assert.equal(uiDetect(uiStory('files_to_modify:\n  - AcmeFrontEnd/scripts/build-form.ts\n')), false,
    'un .ts de la carpeta de scripts del repo es un script');
  assert.equal(uiDetect(uiStory('files_to_modify:\n  - AcmeFrontEnd/tools/arrancar.cmd\n  - AcmeFrontEnd/tools/arrancar.psm1\n')), false,
    'otras extensiones de script');
  assert.equal(uiDetect(uiStory('files_to_modify:\n  frontend:\n    - scripts/e2e-gate.sh\n')), true,
    'la llave que agrupa por repo sigue nombrando el frente (lado seguro)');
});

// Un id de escenario de navegador cuenta como fila de la tabla de pruebas de la story; citado en la prosa, en el
// frontmatter o en otra tabla (dependencias, trazabilidad) puede ser de otra story.
test('detector UI: un «E2E-n» marca pantalla sólo como fila de la tabla de pruebas de la story', () => {
  const fm = LISTAS_CS;
  assert.equal(uiDetect(uiStory(fm, '## Tests\n\n| ID | Test |\n|---|---|\n| E2E-1 | el panel abre |\n')), true, 'fila de la tabla de pruebas');
  assert.equal(uiDetect(uiStory(fm, '### Tests (3)\n\n| ID | Test |\n|---|---|\n| `E2E-2.1` | flujo |\n')), true, 'con el id entre comillas');
  assert.equal(uiDetect(uiStory(fm, 'La prueba E2E-4.5.9 de la otra story quedó como fixme.\n')), false, 'citado en la prosa');
  assert.equal(uiDetect(uiStory(fm, 'E2E-1: el usuario abre el panel\n')), true, 'encabezando la línea');
  assert.equal(uiDetect(uiStory(fm, '- E2E-2: filtra la lista\n')), true, 'tras una viñeta');
  assert.equal(uiDetect(uiStory(fm, '**Escenario E2E-3**: guarda el formulario\n')), true, 'tras «Escenario», en negrita');
  assert.equal(uiDetect(uiStory(fm + 'notas:\n  - summary: "los tests E2E-6.1.20 de la 6.1 se rompieron"\n')), false, 'citado en el frontmatter');
  assert.equal(uiDetect(uiStory(fm, '## Dependencies\n\n| Escenario | Prueba |\n|---|---|\n| `E2E-2.4.HW.1` — hardware | AT-1 |\n')), false,
    'fila de otra tabla');
  assert.equal(uiDetect(uiStory(fm, '## Tests\n\nCorre con Playwright E2E contra la app.\n')), true, 'la mención de Playwright E2E sigue marcando');
});

test('detector UI: las listas con otra llave (files, files_to_reference, files_to_delete) cuentan', () => {
  const casos = [
    'files:\n  - AcmeFrontEnd/src/x.ts\n',
    'files_to_reference:\n  - AcmeFrontEnd/src/x.ts\n',
    'files_to_delete:\n  - AcmeFrontEnd/src/x.ts\n',
    'Files_To_Modify:\n  - AcmeFrontEnd/src/x.ts\n',
    'tanda:\n  files:\n    - AcmeFrontEnd/src/x.ts\n',
    'files_to_modify: ["AcmeFrontEnd/src/x.ts", "src/AcmeBackend/A.cs"]\n',
    'files_to_modify:\n  - action: modify\n    path: AcmeFrontEnd/src/x.ts\n',
    'files_to_modify: |\n  src/AcmeBackend/A.cs\n  AcmeFrontEnd/src/x.ts\n',
    'files_to_modify: [src/pages/Panel.tsx, src/AcmeBackend/A.cs]\n',
    'files_to_modify:\n  - action: modify\n    path: src/pages/Panel.tsx\n',
  ];
  for (const c of casos) assert.equal(uiDetect(uiStory(c)), true, `es pantalla: ${c.trim()}`);
});

test('detector UI: un .md bajo una carpeta de frente no es pantalla; un .ts en la misma carpeta sí', () => {
  const noUi = [
    'files_to_modify:\n  - ../AcmeFrontEnd/CLAUDE.md\n',
    'files_to_modify:\n  - "(Acme/FrontEnd) CLAUDE.md"\n',
    'files_to_modify:\n  - AcmeFrontEnd/notas.txt\n',
    'files_to_modify: ["AcmeFrontEnd/CLAUDE.md"]\n',
  ];
  for (const c of noUi) assert.equal(uiDetect(uiStory(c)), false, `documento, no pantalla: ${c.trim()}`);
  const ui = [
    'files_to_modify:\n  - AcmeFrontEnd/src/x.ts\n',
    'files_to_modify:\n  - AcmeFrontEnd/docs/intro.mdx\n',
    'files_to_modify:\n  - AcmeFrontEnd/src/pages/acerca.md\n',
    'files_to_modify:\n  - README.md y AcmeFrontEnd/src/hooks/useX.ts\n',
    'files_to_modify: [AcmeFrontEnd/CLAUDE.md, AcmeFrontEnd/src/x.ts]\n',
  ];
  for (const c of ui) assert.equal(uiDetect(uiStory(c)), true, `pantalla: ${c.trim()}`);
});

test('detector UI: el nombre declarado en fe_paths sólo en la prosa no marca si hay listas; sin listas sí', () => {
  const repo = uiFixtureRepo('evidence:\n  fe_paths:\n    - acme-panel\n');
  const driver = 'driver: "el acme-panel consume este endpoint"\n';
  assert.equal(uiDetect(uiStory(driver + LISTAS_CS), repo), false, 'con listas de backend, la prosa no decide');
  assert.equal(uiDetect(uiStory(driver), repo), true, 'sin listas, la prosa de respaldo sí');
  assert.equal(uiDetect(uiStory('files_to_modify:\n  - acme-panel/src/Estado.ts\n'), repo), true, 'en la lista, sí');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('detector UI: una nota de pipelines que dice que el frente es otra story sigue marcando (lado seguro, dicho)', () => {
  const s = uiStory(LISTAS_CS + 'pipelines:\n  A-backend:\n    status: in-progress\n    note: "el frontend es la 7.9"\n');
  assert.equal(uiDetect(s), true, 'una nota de la tanda cuenta: mejor sobre-detectar que dejar pasar una pantalla');
});

// Formas de escribir las listas que el detector podría leer mal.
// Ninguna está en el corpus medido salvo la prosa dentro de una lista; cada caso lleva su gemelo que no cambia.
test('detector UI: una lista agrupada por repo con la llave del frente marca pantalla (en bloque, como item-mapa y entre llaves)', () => {
  const casos = [
    'files_to_modify:\n  frontend:\n    - src/hooks/useX.ts\n  backend:\n    - Api/X.cs\n',
    'files_to_modify:\n  - frontend:\n    - src/lib/api.ts\n  - Api/X.cs\n',
    'files_to_modify:\n  - FrontEnd: src/pages/Home.ts\n  - Api: src/X.cs\n',
    'files_to_modify:\n  Front-End:\n    - src/lib/api.ts\n  Api:\n    - src/X.cs\n',
    'files_to_modify: {frontend: [src/hooks/useX.ts], backend: [Api/X.cs]}\n',
  ];
  for (const c of casos) assert.equal(uiDetect(uiStory(c)), true, `es pantalla: ${c.trim()}`);
  const repo = uiFixtureRepo('evidence:\n  fe_paths:\n    - acme-panel\n');
  assert.equal(uiDetect(uiStory('files_to_modify:\n  acme-panel:\n    - src/Estado.ts\n  AcmeBackend:\n    - Api/X.cs\n'), repo), true,
    'el nombre declarado como llave de la lista también');
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(uiDetect(uiStory('files_to_modify:\n  backend:\n    - Api/X.cs\n')), false, 'gemelo: agrupada sólo con backend');
});

test('detector UI: la prosa dentro de una lista de archivos (why:, description:, una nota pegada a la ruta) no marca pantalla', () => {
  const noUi = [
    'files_to_modify:\n  - path: Api/X.cs\n    why: el frontend necesita este campo\n',
    'files_to_modify:\n  - path: AcmeFrontEnd/CLAUDE.md\n    description: documentar la regla del frontend\n',
    'files_to_modify:\n  - "Api/X.cs — el Frontend de la 4.2 lo consume"\n',
  ];
  for (const c of noUi) assert.equal(uiDetect(uiStory(c)), false, `prosa en la lista, no pantalla: ${c.trim()}`);
  const ui = [
    'files_to_modify:\n  - path: AcmeFrontEnd/src/x.ts\n    why: un campo nuevo\n',
    'files_to_modify:\n  - "(Acme/FrontEnd) src/hooks/useX.ts"\n',
    'files_to_modify:\n  - "Api/X.cs y AcmeFrontEnd/src/x.ts"\n',
  ];
  for (const c of ui) assert.equal(uiDetect(uiStory(c)), true, `gemelo, pantalla: ${c.trim()}`);
});

test('detector UI: un # dentro de comillas no corta la entrada; un comentario de verdad sí', () => {
  assert.equal(uiDetect(uiStory('files_to_modify: ["Api/X.cs (AC #2)", "AcmeFrontEnd/src/x.ts"]\n')), true, 'corchetes');
  assert.equal(uiDetect(uiStory('files_to_modify:\n  - "Api/X.cs #2 y AcmeFrontEnd/src/x.ts"\n')), true, 'item entre comillas');
  assert.equal(uiDetect(uiStory('files_to_modify:\n  - Api/X.cs  # lo usa el frontend\n')), false, 'gemelo: comentario YAML');
});

test('detector UI: un número de story, una versión o N/A no cuentan como archivo declarado', () => {
  const titulo = 'title: "Frontend: panel de estado"\n';
  for (const c of ['files_to_modify:\n  - TBD (se define en la story 7.2)\n', 'files_to_modify:\n  - N/A por ahora\n',
    'files_to_modify:\n  - "pendiente: la v2.0 sobre Node.js"\n']) {
    assert.equal(uiDetect(uiStory(titulo + c)), true, `no declara archivos, la prosa cuenta: ${c.trim()}`);
  }
  assert.equal(uiDetect(uiStory('files_to_modify:\n  - AcmeFrontEnd/CLAUDE.md (regla de la story 7.6)\n')), false,
    'un documento con una nota que nombra otra story sigue siendo sólo documento');
  assert.equal(uiDetect(uiStory(titulo + 'files_to_modify:\n  - src/AcmeBackend/A.cs\n')), false, 'gemelo: un archivo de verdad apaga la prosa');
});

test('detector UI: un documento con ancla, número de línea, puntuación final o espacios en el nombre sigue siendo documento', () => {
  const noUi = ['AcmeFrontEnd/CLAUDE.md#reglas', 'AcmeFrontEnd/CLAUDE.md:12', 'AcmeFrontEnd/CLAUDE.md.',
    '"AcmeFrontEnd/CLAUDE.md;"', 'AcmeFrontEnd/docs/Guia de uso.md'];
  for (const e of noUi) assert.equal(uiDetect(uiStory(`files_to_modify:\n  - ${e}\n`)), false, `documento: ${e}`);
  assert.equal(uiDetect(uiStory('files_to_modify:\n  - AcmeFrontEnd/src/x.ts:12\n')), true, 'gemelo: código con número de línea');
});

test('detector UI: files-to-modify y filesToModify también son listas de archivos', () => {
  for (const k of ['files-to-modify', 'filesToModify', 'filesToCreate']) {
    assert.equal(uiDetect(uiStory(`${k}:\n  - AcmeFrontEnd/src/x.ts\n`)), true, `${k} con el frente`);
    assert.equal(uiDetect(uiStory(`title: "Frontend: panel"\n${k}:\n  - src/AcmeBackend/A.cs\n`)), false,
      `${k} declara archivos: la prosa no decide`);
  }
});

// T7-T8: los controles de marker.js con el veredicto nuevo, y la baja dicha en una línea.
function uiMarkerFixture(tag, fmBody) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), `mk-ui718-${tag}-`));
  const repo = path.join(fakeHome, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const storyPath = path.join(repo, 'specs', 'story-9.1.md');
  fs.writeFileSync(storyPath, uiStory('status: in-progress\n' + fmBody, '# Story 9.1\n\n## Acceptance Criteria\n\n1. responde 200.\n'));
  const SID = `ui718-${tag}`;
  writeFakeMarker(fakeHome, SID, { storyId: '9.1', storyPath, repoPath: repo,
    stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8] });
  return { fakeHome, SID, storyPath };
}
const BAJA_RE = /se trata como SIN pantalla/g;

test('marker: una story de backend con /frontend en el driver acepta el PASS sin evidencia de navegador', () => {
  const { spawnSync } = require('node:child_process');
  const f = uiMarkerFixture('pass', 'driver: "GET /api/admin/algo/frontend responde sin sesion"\n' + LISTAS_CS);
  const r = spawnSync(process.execPath, [MARKER, 'mark-dod-runtime-checked', '{"verdict":"PASS"}'], { ...markerEnv(f.SID, f.fakeHome) });
  assert.equal(r.status, 0, `no tiene que rechazar: ${r.stderr}`);
  assert.doesNotMatch(r.stderr || '', /RECHAZADO — story de UI/);
  const m = JSON.parse(fs.readFileSync(path.join(f.fakeHome, '.claude', '.tycon-pipeline', 'active', `${f.SID}.json`), 'utf8'));
  assert.equal(m.dodRuntimeChecked, true);
  fs.rmSync(f.fakeHome, { recursive: true, force: true });
});

test('marker: la baja por prosa se avisa en una línea', () => {
  const { spawnSync } = require('node:child_process');
  const comandos = [
    ['mark-dod-runtime-checked', '{"verdict":"PASS"}'],
    ['set-check', 'dod', 'green', '--manual'],
    ['complete-step', '8'],
  ];
  const correr = (f, args) => spawnSync(process.execPath, [MARKER, ...args], { ...markerEnv(f.SID, f.fakeHome) });
  // La baja por la prosa (la ruta HTTP del driver) y la baja por un documento del frente en las listas.
  const bajas = [
    ['prosa', 'driver: "GET /api/admin/algo/frontend responde sin sesion"\n' + LISTAS_CS, /en la prosa/],
    ['doc', 'files_to_modify:\n  - ../AcmeFrontEnd/CLAUDE.md\n  - src/AcmeBackend/AcmePlugin.cs\n', /en documentos \(\.md\/\.txt\)/],
  ];
  for (const [tag, fm, motivo] of bajas) {
    for (const args of comandos) {
      const f = uiMarkerFixture(`${tag}-${args[0]}`, fm);
      const r = correr(f, args);
      const n = ((r.stderr || '').match(BAJA_RE) || []).length;
      assert.equal(n, 1, `${tag} · ${args.join(' ')}: la baja se dice UNA vez (dijo ${n})\n${r.stderr}`);
      assert.match(r.stderr, motivo, `${tag} · ${args.join(' ')}: con su motivo`);
      assert.match(r.stderr, /declará sus archivos en files_to_modify/);
      fs.rmSync(f.fakeHome, { recursive: true, force: true });
    }
  }
  // Controles: una story de backend sin ninguna mención y una de pantalla de verdad no dicen nada.
  const controles = [['backend', LISTAS_CS], ['pantalla', 'files_to_modify:\n  - src/pages/Panel.tsx\n']];
  for (const [tag, fm] of controles) {
    for (const args of comandos) {
      const f = uiMarkerFixture(`ctl-${tag}-${args[0]}`, fm);
      const r = correr(f, args);
      assert.doesNotMatch(r.stderr || '', BAJA_RE, `${tag} · ${args.join(' ')}: no hay baja que decir`);
      fs.rmSync(f.fakeHome, { recursive: true, force: true });
    }
  }
});

// ── evidencia DoD de los hooks — repo del producto + companions declarados, no hermanos por
// vecindad: los story-id
// COLISIONAN entre productos (una "1.4" existe en varios repos), así que un `1.4-*.md` de un
// hermano NO declarado satisfaría el check de evidencia del producto equivocado.
const opcHook = require(path.join(SCRIPTS, 'on-pre-commit.js'));
const ofwHook = require(path.join(SCRIPTS, 'on-frontmatter-write.js'));
function dodFixture(declareCompanion) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dodev-'));
  const repoA = path.join(ws, 'RepoA');
  fs.mkdirSync(path.join(repoA, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repoA, 'specs', 'stories'), { recursive: true });
  const repoB = path.join(ws, 'RepoB');
  fs.mkdirSync(path.join(repoB, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repoB, 'specs', 'stories'), { recursive: true }); // hermano estilo spec-repo
  const bDod = path.join(repoB, '.advisors', 'dod-runtime');
  fs.mkdirSync(bDod, { recursive: true });
  fs.writeFileSync(path.join(bDod, '1.4-2026-08-14T00-00-00Z.md'), '# evidencia de OTRO producto — AC #1\n');
  if (declareCompanion) {
    fs.mkdirSync(path.join(repoA, '.tycon'), { recursive: true });
    fs.writeFileSync(path.join(repoA, '.tycon', 'advisors.yaml'),
      'evidence:\n  companion_repos:\n    - RepoB\n');
  }
  return { ws, repoA, repoB };
}

test('findDodEvidence: evidencia de un hermano NO declarado con el mismo story-id NO se atribuye', () => {
  const f = dodFixture(false);
  assert.equal(opcHook.findDodEvidence(f.repoA, '1.4'), null);
  fs.rmSync(f.ws, { recursive: true, force: true });
});

test('findDodEvidence: companion declarado, repo propio y subproyecto SÍ aportan', () => {
  const f = dodFixture(true);
  const found = opcHook.findDodEvidence(f.repoA, '1.4');
  assert.ok(found && found.path.includes('RepoB'), 'companion declarado debe aportar');
  // repo propio
  const aDod = path.join(f.repoA, '.advisors', 'dod-runtime');
  fs.mkdirSync(aDod, { recursive: true });
  fs.writeFileSync(path.join(aDod, '2.2-2026-08-14T00-00-00Z.md'), '# propia\n');
  assert.ok(opcHook.findDodEvidence(f.repoA, '2.2'), 'evidencia del propio repo debe seguir contando');
  // subproyecto (monorepo, 1 nivel)
  const subDod = path.join(f.repoA, 'webapp', '.advisors', 'dod-runtime');
  fs.mkdirSync(subDod, { recursive: true });
  fs.writeFileSync(path.join(subDod, '3.3-2026-08-14T00-00-00Z.md'), '# del subproyecto\n');
  assert.ok(opcHook.findDodEvidence(f.repoA, '3.3'), 'evidencia de un subproyecto del repo debe contar');
  fs.rmSync(f.ws, { recursive: true, force: true });
});

test('findRepoRoots (on-frontmatter-write): repo de la story + companions declarados — no todos los hermanos git', () => {
  const f = dodFixture(false);
  const story = path.join(f.repoA, 'specs', 'stories', '1-4-x.md');
  fs.writeFileSync(story, '---\nstory: "1.4"\n---\n');
  const roots = ofwHook.findRepoRoots(story);
  assert.ok(roots.some((r) => path.resolve(r) === path.resolve(f.repoA)), 'el repo de la story tiene que estar');
  assert.ok(!roots.some((r) => r.includes('RepoB')), `hermano NO declarado no puede estar: ${JSON.stringify(roots)}`);
  fs.rmSync(f.ws, { recursive: true, force: true });
});

test('findRepoRoots (on-frontmatter-write): companion declarado SÍ entra', () => {
  const f = dodFixture(true);
  const story = path.join(f.repoA, 'specs', 'stories', '1-4-x.md');
  fs.writeFileSync(story, '---\nstory: "1.4"\n---\n');
  const roots = ofwHook.findRepoRoots(story);
  assert.ok(roots.some((r) => r.includes('RepoB')), JSON.stringify(roots));
  fs.rmSync(f.ws, { recursive: true, force: true });
});

// ── Casos de una revisión ciega ──────────────────────────────────────────────
const ecLib = require(path.join(SCRIPTS, 'lib', 'evidence-config.js'));
const uiLib = require(path.join(SCRIPTS, 'lib', 'ui-signal.js'));

test('F2: el detector de UI encuentra fe_paths aunque le pasen un SUBDIR del repo (cwd de un commit anidado)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'uisub-'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), 'evidence:\n  fe_paths:\n    - mi-lab\n');
  const sub = path.join(repo, 'mi-lab');
  fs.mkdirSync(sub, { recursive: true });
  const story = '---\nstory: "1.1"\nfiles_to_modify:\n  - mi-lab/src/panel.ts\n---\ncuerpo sin e2e\n';
  assert.equal(uiLib.storyTouchesUi(story, repo), true, 'con el repo root anda');
  assert.equal(uiLib.storyTouchesUi(story, sub), true, 'con un SUBDIR del repo tiene que subir hasta .git y andar igual');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('F3: el parser del bloque evidence acepta formatos YAML válidos (same-indent, flow style, quotes+comentario)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ecfmt-'));
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  const w = (yaml) => { fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), yaml); return ecLib.parseEvidenceConfig(repo); };
  // (a) items al MISMO indent que la key (YAML válido)
  let r = w('evidence:\n  companion_repos:\n  - NoExisteA\n');
  assert.deepEqual(r.missing, ['NoExisteA'], `same-indent: ${JSON.stringify(r)}`);
  // (b) flow style inline
  r = w('evidence:\n  companion_repos: [NoExisteB]\n  fe_paths: [tokenB]\n');
  assert.deepEqual(r.missing, ['NoExisteB'], `flow companion: ${JSON.stringify(r)}`);
  assert.deepEqual(r.fePaths, ['tokenB'], `flow fe_paths: ${JSON.stringify(r)}`);
  // (c) quoteado + comentario inline: el comentario se pela ANTES que las quotes
  r = w('evidence:\n  fe_paths:\n    - "tokenC"  # el FE\n');
  assert.deepEqual(r.fePaths, ['tokenC'], `quotes+comment: ${JSON.stringify(r)}`);
  // (d) el formato block clásico sigue andando
  r = w('evidence:\n  fe_paths:\n    - tokenD\n');
  assert.deepEqual(r.fePaths, ['tokenD']);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ── El gate E2E del merge cubre las apps que la entrega TOCÓ ──────────────────────────────
//
// Ejemplo: el `FrontEnd` de un producto es un monorepo de 4 apps. Si `.tycon/advisors.yaml` sólo pudiera declarar
// UNA (`frontend_dir`), el merge de una story —una entrega de pedidos y catálogo— correría los E2E de stock: no
// fallaría, ejercería otra cosa. Un control que mira la app equivocada es indistinguible de un control que
// anda.
test('GateMerge_CubreLasAppsTocadas', () => {
  const pipeline = require(path.join(SCRIPTS, 'pipeline.js'));
  const { e2eConfig, selectE2eApps } = pipeline;

  const mkApp = (repo, app) => {
    fs.mkdirSync(path.join(repo, app, 'tests', 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(repo, app, 'playwright.config.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(repo, app, 'tests', 'e2e', 'x.spec.ts'), '// spec\n');
  };

  // ── (a) monorepo que declara TRES apps ────────────────────────────────────────────────
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eapps-'));
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  for (const a of ['totora-encargos', 'totora-reserva', 'totora-catalogo']) mkApp(repo, a);
  fs.writeFileSync(
    path.join(repo, '.tycon', 'advisors.yaml'),
    'e2e:\n  frontend_dirs:\n    - totora-encargos\n    - totora-reserva\n    - totora-catalogo\n'
  );

  const cfg = e2eConfig(repo);
  assert.deepEqual(
    (cfg.frontend_dirs || []).map((d) => path.basename(d)),
    ['totora-encargos', 'totora-reserva', 'totora-catalogo'],
    'el resolver tiene que devolver las TRES apps declaradas'
  );
  assert.equal(
    path.basename(cfg.frontend_dir), 'totora-encargos',
    'frontend_dir (escalar) se mantiene para los consumidores viejos: la primera de la lista'
  );

  // ── (b) EL RENGLÓN DE LA STORY: una entrega que toca pedidos y catálogo ejerce LAS DOS ────
  const tocadas = selectE2eApps(cfg, [
    'totora-encargos/src/components/PedidosDelDiaSection.tsx',
    'totora-catalogo/tests/e2e/story-a2-catalogo-detalle-de-ruta.spec.ts',
    'docs/algo.md',
  ]);
  assert.deepEqual(
    tocadas.map((d) => path.basename(d)),
    ['totora-encargos', 'totora-catalogo'],
    'con una entrega de pedidos + catálogo el gate tiene que correr esas DOS, no stock'
  );

  // ── (c) sin lista de cambios (no se pudo computar) → TODAS, nunca menos ────────────────
  assert.equal(selectE2eApps(cfg, undefined).length, 3, 'sin delta se corren todas (fail-safe)');
  assert.equal(selectE2eApps(cfg, []).length, 3, 'lista vacía = desconocido → todas');

  // ── (d) una entrega que no toca ninguna app declarada no corre E2E de nadie ────────────
  assert.deepEqual(selectE2eApps(cfg, ['README.md', 'scripts/deploy.sh']), [],
    'sin app tocada no hay E2E que correr');

  // ── (e) compatibilidad hacia atrás: el escalar de siempre sigue funcionando ────────────
  const viejo = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eold-'));
  fs.mkdirSync(path.join(viejo, '.tycon'), { recursive: true });
  mkApp(viejo, 'totora-reserva');
  fs.writeFileSync(
    path.join(viejo, '.tycon', 'advisors.yaml'),
    'e2e:\n  frontend_dir: totora-reserva\n'
  );
  const cfgViejo = e2eConfig(viejo);
  assert.equal(path.basename(cfgViejo.frontend_dir), 'totora-reserva');
  assert.deepEqual((cfgViejo.frontend_dirs || []).map((d) => path.basename(d)),
    ['totora-reserva'], 'el escalar se normaliza a una lista de uno');
  assert.deepEqual(
    selectE2eApps(cfgViejo, ['totora-reserva/src/x.tsx']).map((d) => path.basename(d)),
    ['totora-reserva']
  );

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(viejo, { recursive: true, force: true });
});

// ── Los caminos que un test con sólo paths relativos NO ejercería ─────────────────────────────
//
// Un test que sólo pasa paths REPO-RELATIVOS no atrapa el modo de falla más grave: con paths ABSOLUTOS —que es lo
// que `marker.filesTouched` guarda, y step-07c lo declara fuente válida de `--changed`— la selección daría `[]`, el
// consumidor no lo rescataría (`[] || x` devuelve `[]` en JS) y el gate saldría 0 SIN correr un solo E2E. Un
// control diciendo verde sin haber ejercido nada: exactamente lo que esta función existe para impedir.
test('GateMerge_NormalizaLaFormaDeLosPaths', () => {
  const { e2eConfig, selectE2eApps } = require(path.join(SCRIPTS, 'pipeline.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'e2enorm-'));
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  for (const a of ['totora-encargos', 'totora-reserva', 'totora-catalogo']) {
    fs.mkdirSync(path.join(repo, a, 'tests', 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(repo, a, 'playwright.config.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(repo, a, 'tests', 'e2e', 'x.spec.ts'), '// spec\n');
  }
  fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'),
    'e2e:\n  frontend_dirs: [totora-encargos, totora-reserva, totora-catalogo]  # las 3 con navegador\n' +
    '  shared_paths:\n    - totora-encargos/src\n');
  const cfg = e2eConfig(repo);
  const bn = (r) => r.map((d) => path.basename(d)).sort();

  // (a) flow style CON comentario inline: no debe guardar "[<app>," como dir basura.
  assert.deepEqual(bn(cfg.frontend_dirs), ['totora-catalogo', 'totora-encargos', 'totora-reserva'],
    `flow+comentario inline: ${JSON.stringify(cfg.frontend_dirs)}`);

  // (b) EL BUG: paths ABSOLUTOS (la forma de marker.filesTouched) tienen que seleccionar igual.
  assert.deepEqual(
    bn(selectE2eApps(cfg, [path.join(repo, 'totora-catalogo', 'tests', 'e2e', 'x.spec.ts')])),
    ['totora-catalogo'],
    'con path ABSOLUTO tiene que seleccionar la app — devolver [] hace que el gate corra 0 suites y salga verde');

  // (c) relativo a un ANCESTRO del repo (lo que da `git diff` si la raíz git está más arriba).
  assert.deepEqual(
    bn(selectE2eApps(cfg, [path.basename(repo) + '/totora-reserva/tests/e2e/x.spec.ts'])),
    ['totora-reserva']);

  // (d) entrecomillado + escapes octales de git (core.quotePath viene ON por default).
  assert.deepEqual(
    bn(selectE2eApps(cfg, ['"totora-catalogo/src/p\\303\\241gina.tsx"'])),
    ['totora-catalogo'], 'los paths con acentos llegan escapados de git diff');

  // (e) CÓDIGO COMPARTIDO: en este monorepo lo común vive dentro de totora-encargos/src y las
  //     otras apps lo importan — tocarlo tiene que ejercer LAS TRES, no sólo pedidos.
  assert.deepEqual(bn(selectE2eApps(cfg, ['totora-encargos/src/components/Algo.tsx'])),
    ['totora-catalogo', 'totora-encargos', 'totora-reserva'],
    'un cambio en el código compartido deja de ejercer sólo su carpeta');

  // (f) NADA cae dentro del repo → "no sé", NO "ninguna app": se corren todas (fail-safe).
  assert.equal(selectE2eApps(cfg, ['/tmp/otro-repo/x.ts', '../fuera/y.ts']).length, 3,
    'entrada 100% fuera del repo = indecidible → todas, nunca cero');

  // (g) cambios REALES del repo que no son de ninguna app → sigue siendo "ninguna tocada".
  assert.deepEqual(selectE2eApps(cfg, ['README.md']), []);

  fs.rmSync(repo, { recursive: true, force: true });
});

// ── symlinks: el caso PARCIAL que pierde una app en silencio ──────────────────────────────────
//
// En macOS `/tmp` es symlink a `/private/tmp` y el TMPDIR real vive bajo `/var/folders`. Si el
// `--repo` y los paths de `--changed` vienen resueltos distinto, `path.relative` los ve fuera del
// repo. Lo grave es el caso PARCIAL: el fail-safe "no sé → todas" sólo dispara si fallan TODOS,
// así que con UN path mal resuelto se perdería esa app sin un solo aviso.
// ── Avisar antes de implementar una spec vieja ────────────────────────────────────────────────
//
// Ejemplo: una story lleva 2.5 meses en `ready-for-dev`. Al revalidarla aparecen correcciones de fondo — entre
// ellas que el esqueleto manda a llamar `PluginManager.GetLoadedPlugin(name)`, un método que NO EXISTE. Sin
// revalidar, la story manda a escribir código que no compila. El spec no envejece solo: el código que cita se
// mueve abajo.
test('SpecStale_AvisaSegunAntiguedadYSeApagaAlRevalidar', () => {
  const { computeSpecStaleness } = require(path.join(SCRIPTS, 'pipeline.js'));
  const hoy = Date.parse('2026-08-25T12:00:00Z');
  const hace = (d) => new Date(hoy - d * 86400000).toISOString().slice(0, 10);

  // (a) vieja → avisa, y dice cuántos días y de qué campo salió
  const v = computeSpecStaleness({ created: hace(90) }, hoy);
  assert.ok(v, '90 días con default 75 tiene que avisar');
  assert.equal(v.dias_sin_revalidar, 90);
  assert.equal(v.campo_usado, 'created');
  assert.match(v.aviso, /archivo:línea/, 'el aviso tiene que decir QUÉ reverificar, no sólo que es vieja');
  assert.match(v.aviso, /revalidated/, 'y cómo apagarlo');

  // (b) reciente → silencio
  assert.equal(computeSpecStaleness({ created: hace(10) }, hoy), null);

  // (c) EL RENGLÓN: `revalidated` gana sobre `created` — una story escrita hace un año pero
  //     revalidada la semana pasada NO vuelve a avisar. Sin esto el aviso sería permanente y
  //     el equipo aprendería a ignorarlo.
  assert.equal(computeSpecStaleness({ created: hace(400), revalidated: hace(5) }, hoy), null);
  const rv = computeSpecStaleness({ created: hace(400), revalidated: hace(200) }, hoy);
  assert.equal(rv.campo_usado, 'revalidated');
  assert.equal(rv.dias_sin_revalidar, 200, 'la cuenta arranca en la última revalidación, no en el nacimiento');

  // (d) sin fecha legible NO se inventa antigüedad (una story sin `created:` no es "infinitamente vieja")
  assert.equal(computeSpecStaleness({}, hoy), null);
  assert.equal(computeSpecStaleness({ created: 'TBD' }, hoy), null);
  assert.equal(computeSpecStaleness({ created: '' }, hoy), null);

  // (e) tolera comillas y timestamp completo (las stories escriben las dos formas)
  assert.ok(computeSpecStaleness({ created: '"2026-01-01"' }, hoy));
  assert.ok(computeSpecStaleness({ created: '2026-01-01T10:00:00Z' }, hoy));

  // (f) umbral configurable, y 0 lo apaga del todo
  const prev = process.env.TYCON_STALE_SPEC_DAYS;
  try {
    process.env.TYCON_STALE_SPEC_DAYS = '5';
    assert.ok(computeSpecStaleness({ created: hace(10) }, hoy), 'con umbral 5, 10 días avisa');
    process.env.TYCON_STALE_SPEC_DAYS = '0';
    assert.equal(computeSpecStaleness({ created: hace(9999) }, hoy), null, '0 = apagado');
  } finally {
    if (prev === undefined) delete process.env.TYCON_STALE_SPEC_DAYS;
    else process.env.TYCON_STALE_SPEC_DAYS = prev;
  }
});

// ── La config del PROPIO control es compartida SIEMPRE ───────────────────────────────────────────
//
// Un commit que da de alta el tier crítico en el frontend de un producto y sólo toca `.tycon/advisors.yaml` +
// `.tycon/e2e-critical-specs.txt`, que no caen bajo ninguna app ni bajo `shared_paths`, daría `[]` ("0 apps
// tocadas") y se mergearía a main sin que el tier corra. NO es el fail-safe (hay archivos tocados), es la misma
// clase de bug que motivó `shared_paths`, un nivel más arriba. Sin este test, una edición que rompa el manifest
// se mergea sin que el tier la vea.
test('GateMerge_LaConfigDelControlEsCompartida', () => {
  const { e2eConfig, selectE2eApps } = require(path.join(SCRIPTS, 'pipeline.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eself-'));
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  for (const a of ['totora-encargos', 'totora-reserva', 'totora-catalogo']) {
    fs.mkdirSync(path.join(repo, a, 'tests', 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(repo, a, 'playwright.config.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(repo, a, 'tests', 'e2e', 'x.spec.ts'), '// spec\n');
  }
  // Manifest en una ruta NO estándar a propósito: el gate tiene que cubrir la ruta que el repo
  // DECLARA (`cfg.critical_manifest`), no adivinar `.tycon/e2e-critical-specs.txt`.
  fs.mkdirSync(path.join(repo, 'qa'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'qa', 'criticos.txt'), 'x.spec\n');
  fs.writeFileSync(
    path.join(repo, '.tycon', 'advisors.yaml'),
    'e2e:\n  frontend_dirs:\n    - totora-encargos\n    - totora-reserva\n    - totora-catalogo\n' +
    '  critical_manifest: qa/criticos.txt\n'
    // Sin `shared_paths`: el repo NO declaró nada. Es exactamente el caso de un repo sin declarar.
  );
  const cfg = e2eConfig(repo);
  const bn = (xs) => xs.map((d) => path.basename(d));

  // (a) EL RENGLÓN DEL GAP: tocar sólo la config del control ejerce TODAS las apps.
  assert.equal(selectE2eApps(cfg, ['.tycon/advisors.yaml']).length, 3,
    'editar advisors.yaml tiene que correr las 3 apps, no "0 apps tocadas"');
  assert.equal(selectE2eApps(cfg, ['qa/criticos.txt']).length, 3,
    'editar el manifest declarado (ruta no estándar) tiene que correr las 3 apps');
  assert.equal(selectE2eApps(cfg, [path.join(repo, '.tycon', 'advisors.yaml')]).length, 3,
    'también con path ABSOLUTO (lo que guarda marker.filesTouched)');

  // (b) Sin depender de que el repo lo declare — un repo sin shared_paths.
  assert.deepEqual(cfg.shared_paths, [], 'precondición: el repo NO declaró shared_paths');

  // (c) Lo que NO es config del control sigue sin disparar nada (no se volvió "todo es shared").
  assert.deepEqual(selectE2eApps(cfg, ['README.md', 'docs/x.md']), [],
    'un cambio de docs sigue sin correr E2E');
  assert.deepEqual(bn(selectE2eApps(cfg, ['totora-catalogo/src/x.tsx'])), ['totora-catalogo'],
    'la selección por app sigue siendo quirúrgica');

  // (d) Repo SIN manifest: sólo advisors.yaml es propio; no revienta por critical_manifest null.
  fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'),
    'e2e:\n  frontend_dirs:\n    - totora-encargos\n    - totora-reserva\n    - totora-catalogo\n');
  const cfg2 = e2eConfig(repo);
  assert.equal(cfg2.critical_manifest, null);
  assert.equal(selectE2eApps(cfg2, ['.tycon/advisors.yaml']).length, 3);
  assert.deepEqual(selectE2eApps(cfg2, ['qa/criticos.txt']), [],
    'sin manifest declarado, ese archivo es uno más');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('GateMerge_SymlinksNoPierdenApps', () => {
  const { e2eConfig, selectE2eApps } = require(path.join(SCRIPTS, 'pipeline.js'));
  const real = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'e2esym-'));
  fs.mkdirSync(path.join(real, '.tycon'), { recursive: true });
  for (const a of ['totora-encargos', 'totora-catalogo']) {
    fs.mkdirSync(path.join(real, a, 'tests', 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(real, a, 'playwright.config.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(real, a, 'tests', 'e2e', 'x.spec.ts'), '// spec\n');
  }
  fs.writeFileSync(path.join(real, '.tycon', 'advisors.yaml'),
    'e2e:\n  frontend_dirs:\n    - totora-encargos\n    - totora-catalogo\n');

  // Un alias por symlink que apunta al mismo repo — el equivalente de /tmp vs /private/tmp.
  const alias = path.join(fs.realpathSync(os.tmpdir()), `e2esym-alias-${process.pid}`);
  try { fs.unlinkSync(alias); } catch { /* no existía */ }
  fs.symlinkSync(real, alias);

  const bn = (r) => r.map((d) => path.basename(d)).sort();
  const cfg = e2eConfig(real);

  // El caso PARCIAL: uno de los dos paths viene por el alias. Sin el alias, devolvería sólo 1 de 2.
  assert.deepEqual(
    bn(selectE2eApps(cfg, [
      path.join(real, 'totora-encargos', 'tests', 'e2e', 'x.spec.ts'),
      path.join(alias, 'totora-catalogo', 'tests', 'e2e', 'x.spec.ts'),
    ])),
    ['totora-catalogo', 'totora-encargos'],
    'un path por symlink no puede perder su app: el fail-safe no cubre el caso parcial');

  // Y el repo declarado POR el alias con los archivos por la ruta real (el espejo del caso).
  assert.deepEqual(
    bn(selectE2eApps(e2eConfig(alias), [path.join(real, 'totora-catalogo', 'tests', 'e2e', 'x.spec.ts')])),
    ['totora-catalogo']);

  // Un archivo BORRADO en el diff (no existe en disco) sigue seleccionando por su ruta.
  assert.deepEqual(
    bn(selectE2eApps(cfg, [path.join(real, 'totora-catalogo', 'src', 'borrado.tsx')])),
    ['totora-catalogo'], 'un archivo eliminado no se puede resolver, pero su ruta sigue diciendo la app');

  fs.unlinkSync(alias);
  fs.rmSync(real, { recursive: true, force: true });
});

// ── lib/session-id.js — la identidad de la sesión, resuelta en UN solo lugar ──────────────────
// Caso: bajo Codex el CLI resolvería `_nosession` mientras los hooks escriben bajo el session_id real que Codex
// manda en cada payload → el estado quedaría partido en dos SIN dar error: el marker arrancaría huérfano y
// `check-count` leería un ledger vacío ("CERO spawns registrados") con los advisors realmente
// corridos, lo que empujaría al `--trust-ran` y de ahí al `--force-manual`. El eslabón que ata las dos puntas
// es `CODEX_SESSION_ID`, que Codex exporta al ambiente de todo shell del modelo con el MISMO
// valor del payload — o sea que no hace falta que nadie exporte nada.
const sidLib = require(path.join(SCRIPTS, 'lib', 'session-id.js'));

// Corre `fn` con un ambiente de sesión controlado y restaura el original pase lo que pase.
function withSessionEnv(vars, fn) {
  const KEYS = ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID'];
  const prev = {};
  for (const k of KEYS) { prev[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

test('session-id: la precedencia va payload → Claude Code → override del banco → Codex → sentinel', () => {
  // El payload del hook gana sobre todo: es el id de la sesión que DISPARÓ el evento.
  withSessionEnv({ CLAUDE_CODE_SESSION_ID: 'cc', TYCON_SESSION_ID: 'banco', CODEX_SESSION_ID: 'cdx' }, () => {
    assert.equal(sidLib.resolveSessionId('del-payload'), 'del-payload');
    assert.equal(sidLib.resolveSessionId(), 'cc');
  });
  // Sin Claude Code, el override explícito del banco manda sobre el id nativo: un banco que no
  // puede fijar la identidad de la sesión no puede aislar sus casos.
  withSessionEnv({ TYCON_SESSION_ID: 'banco', CODEX_SESSION_ID: 'cdx' }, () => {
    assert.equal(sidLib.resolveSessionId(), 'banco');
  });
  // Sesión Codex pelada: el id nativo es lo único que hay, y alcanza.
  withSessionEnv({ CODEX_SESSION_ID: 'cdx' }, () => {
    assert.equal(sidLib.resolveSessionId(), 'cdx');
  });
  // Sin ninguno → sentinel (nunca vacío, nunca undefined).
  withSessionEnv({}, () => {
    assert.equal(sidLib.resolveSessionId(), '_nosession');
    assert.equal(sidLib.resolveSessionId(null), '_nosession');
  });
  // Como nombre de archivo, las barras se sanean (un id con `/` escribiría fuera del state dir).
  withSessionEnv({ CODEX_SESSION_ID: 'a/b\\c' }, () => {
    assert.equal(sidLib.sessionIdFileKey(), 'a_b_c');
  });
});

test('session-id: bajo Codex el marker NO cae en _nosession (regresión pasada 1 dorada)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sid-codex-'));
  const CDX = '00000000-0000-4000-8000-000000000001';
  // Ambiente de una sesión Codex de verdad: sin las dos primeras variables de la cadena.
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, CODEX_SESSION_ID: CDX };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.TYCON_SESSION_ID;

  require('child_process').execFileSync(
    process.execPath,
    [path.join(SCRIPTS, 'marker.js'), 'set', JSON.stringify({ storyId: '7.2', storyPath: '/tmp/r/s.md', repoPath: '/tmp/r' })],
    { env, encoding: 'utf8' },
  );

  const activeDir = path.join(fakeHome, '.claude', '.tycon-pipeline', 'active');
  const escritos = fs.readdirSync(activeDir).filter((f) => f.endsWith('.json'));
  assert.deepEqual(escritos, [`${CDX}.json`],
    'el marker tiene que vivir bajo el id de la sesión Codex, no bajo el sentinel');
  assert.ok(!fs.existsSync(path.join(activeDir, '_nosession.json')),
    'un marker en _nosession es el estado huérfano que rompió la primera pasada dorada');

  // Y la vuelta: el MISMO ambiente lo encuentra (las dos puntas convergen).
  const leido = JSON.parse(require('child_process').execFileSync(
    process.execPath, [path.join(SCRIPTS, 'marker.js'), 'get'], { env, encoding: 'utf8' },
  ));
  assert.equal(leido.storyId, '7.2');
  assert.equal(leido.sessionId, CDX);

  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('session-id: el ledger que escribe el hook es el que lee el CLI bajo Codex', () => {
  // La falla real de la pasada 1 en su forma exacta: el hook `on-advisor-run` registra el spawn
  // usando el `session_id` del payload; `check-count` cuenta ese ledger resolviendo el id desde
  // el ambiente. Si las dos puntas no dan el mismo valor, los advisors corren de verdad y el
  // conteo informa CERO — con toda honestidad, mirando el archivo equivocado.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sid-ledger-'));
  const CDX = '00000000-0000-4000-8000-000000000002';
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, CODEX_SESSION_ID: CDX, TYCON_AUTO_SNAPSHOT: '0' };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.TYCON_SESSION_ID;

  // Punta 1 — el hook, con el payload tal cual lo manda Codex (session_id propio, spawn nativo).
  const payload = JSON.stringify({
    session_id: CDX,
    tool_name: 'collaborationspawn_agent',
    tool_input: { agent_type: 'tycon-plugin-security-basics', task_name: 'sonda-libre' },
  });
  require('child_process').execFileSync(
    process.execPath, [path.join(SCRIPTS, 'on-advisor-run.js')],
    { env, input: payload, encoding: 'utf8' },
  );

  // Punta 2 — el CLI, que solo tiene el ambiente.
  const ledgerDir = path.join(fakeHome, '.claude', '.tycon-pipeline', 'advisor-runs');
  const archivos = fs.readdirSync(ledgerDir);
  assert.deepEqual(archivos, [`${CDX}.jsonl`],
    'el hook tiene que escribir bajo el mismo id que el CLI va a leer');
  const desdeElAmbiente = withSessionEnv({ CODEX_SESSION_ID: CDX }, () => sidLib.sessionIdFileKey());
  assert.equal(`${desdeElAmbiente}.jsonl`, archivos[0]);

  // Y el spawn quedó registrado por su identidad real (agent_type), no por la etiqueta libre.
  const filas = fs.readFileSync(path.join(ledgerDir, archivos[0]), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].advisor, 'tycon-plugin-security-basics');

  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── ADVISORS-GATE: findAdvisorsEvidence ───────────────────────────────────────────────────────
test('findAdvisorsEvidence: corrida del pipeline en el repo, o gates.log advisors=green con repoPath de ESTE repo; sin namespace no cuenta', () => {
  const { findAdvisorsEvidence } = require(path.join(SCRIPTS, 'on-pre-commit.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-repo-'));
  const otro = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-otro-'));
  for (const r of [repo, otro]) fs.mkdirSync(path.join(r, '.git'));
  const gl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adv-gl-')), 'gates.log');
  // (0) nada → no hay constancia
  let r = findAdvisorsEvidence(repo, 'S1', { gatesLog: gl });
  assert.equal(r.found, false); assert.ok(r.searched.length >= 2);
  // (1) gates.log: misma "S1" pero de OTRO repo → no cuenta; línea legacy sin repoPath → no cuenta
  fs.writeFileSync(gl, [
    JSON.stringify({ ts: 't', check: 'advisors', status: 'green', storyId: 'S1', repoPath: otro }),
    JSON.stringify({ ts: 't', check: 'advisors', status: 'green', storyId: 'S1' }),
    JSON.stringify({ ts: 't', check: 'advisors', status: 'red:exit=2', storyId: 'S1', repoPath: repo }),
  ].join('\n') + '\n');
  assert.equal(findAdvisorsEvidence(repo, 'S1', { gatesLog: gl }).found, false, 'otro repo / legacy / rojo no cuentan');
  // (2) gates.log: advisors green de ESTE repo → cuenta
  fs.appendFileSync(gl, JSON.stringify({ ts: 't', check: 'advisors', status: 'green', storyId: 'S1', repoPath: repo }) + '\n');
  r = findAdvisorsEvidence(repo, 'S1', { gatesLog: gl });
  assert.equal(r.found, true); assert.equal(r.via, 'gates.log');
  // (3) corrida del pipeline en el repo (findings.json o reportes del Step 5) → cuenta sin gates.log
  const run = path.join(otro, '.advisors', 'pipeline-runs', 'S1-20260824-1200');
  fs.mkdirSync(path.join(run, 'step-05-advisor-reports'), { recursive: true });
  assert.equal(findAdvisorsEvidence(otro, 'S1', { gatesLog: path.join(otro, 'nope.log') }).found, false, 'dir sin reportes ni findings no cuenta');
  fs.writeFileSync(path.join(run, 'step-05-advisor-reports', 'tycon-plugin-security-basics.md'), '# ok\n');
  r = findAdvisorsEvidence(otro, 'S1', { gatesLog: path.join(otro, 'nope.log') });
  assert.equal(r.found, true); assert.equal(r.via, 'pipeline-run');
  // (4) "S10" no matchea "S1-" (prefijo con guion)
  fs.mkdirSync(path.join(otro, '.advisors', 'pipeline-runs', 'S10-x'), { recursive: true });
  fs.writeFileSync(path.join(otro, '.advisors', 'pipeline-runs', 'S10-x', 'findings.json'), '[]');
  assert.equal(findAdvisorsEvidence(otro, 'S10', { gatesLog: path.join(otro, 'nope.log') }).via, 'pipeline-run');
});

// ── El namespace por repo lo llevan TODOS los escritores de gates.log ────────────────────────────
// El namespace no sale sólo de marker.js: on-pre-commit / on-atdd-preedit / story-gate-io /
// smoke-run.sh escriben el mismo gates.log, y sin `repoPath` el capturer mezcla entries entre repos.
// Estos tests ejercitan los binarios reales.
test('gates.log namespace: on-atdd-preedit.js escribe repoPath del marker al bloquear', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preedit-ns-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-ns-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const story = path.join(repo, 'specs', 'story-1-1.md');
  fs.writeFileSync(story, '# Story 1.1\n\n### Tests\n\n| T-ID | AC |\n|---|---|\n| T1 | 1 |\n');
  fs.mkdirSync(path.join(stateDir, 'active'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'active', 'sess-ns.json'), JSON.stringify({
    storyId: '1.1', storyPath: story, repoPath: repo, stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8], fileEvents: [],
  }));
  const { handle } = require(path.join(SCRIPTS, 'on-atdd-preedit.js'));
  const r = handle({
    hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 'sess-ns',
    tool_input: { file_path: path.join(repo, 'src', 'a.ts') },
  }, { stateDir });
  assert.ok(r && r.block, 'código sin test previo → bloquea');
  const entry = fs.readFileSync(path.join(stateDir, 'gates.log'), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).find((e) => e.name === 'atdd-preedit');
  assert.ok(entry && entry.repoPath, 'atdd-preedit lleva repoPath');
  assert.equal(fs.realpathSync(entry.repoPath), fs.realpathSync(repo));
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('gates.log namespace: smoke-run.sh espeja repoPath (el repo dueño del evidence-dir)', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-ns-'));
  const repo = path.join(fakeHome, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const evidence = path.join(repo, '.advisors', 'dod-runtime');
  const res = spawnSync('bash', [path.join(SCRIPTS, 'smoke-run.sh'), evidence, '9.9', '--acs', '1', '--pass-if', 'el comando termina bien', '--', 'true'], {
    env: { ...process.env, HOME: fakeHome }, cwd: os.tmpdir(), encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const entry = fs.readFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).find((e) => e.type === 'smoke-run' && e.story === '9.9');
  assert.ok(entry && entry.repoPath, 'el espejo lleva repoPath');
  assert.equal(fs.realpathSync(entry.repoPath), fs.realpathSync(repo));
  assert.deepEqual(entry.acs, [1]); assert.equal(entry.exit, 0);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── El ledger no se lleva la credencial ───────────────────────────────────────────────────────
// Un ledger con claves de API VIVAS (una ACTIVA, con permiso de envío) o JWT escritos adentro frena un pull
// request en gitleaks. El ledger vive en
// `.advisors/dod-runtime/`, que el .gitignore canónico deja VIAJAR por git a propósito.
// La convención "pasá la credencial por variable" existe y se puede violar: el tapado es
// mecánico justamente por eso.
test('smoke-run.sh: tapa la clave de API del cmd y deja el endpoint legible', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-sec-'));
  const repo = path.join(fakeHome, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const evidence = path.join(repo, '.advisors', 'dod-runtime');
  // Inventada y armada por partes: una clave de verdad no puede viajar en la copia pública.
  // Lo que se prueba es el tapado, no el valor.
  const CLAVE = ['lab', 'NoEsUnaClaveReal', 'SoloParaEstaPrueba', '0123456789'].join('_');
  const res = spawnSync('bash', [path.join(SCRIPTS, 'smoke-run.sh'), evidence, '9.8', '--acs', '1', '--pass-if', 'el comando termina bien', '--',
    'curl', '-sf', '-H', `X-Api-Key: ${CLAVE}`, 'http://localhost:5002/api/messaging/contact-window-status'], {
    env: { ...process.env, HOME: fakeHome }, cwd: os.tmpdir(), encoding: 'utf8',
  });
  const entry = fs.readFileSync(path.join(evidence, '9.8-smoke-ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))[0];
  assert.ok(!entry.cmd.includes(CLAVE), 'la clave NO puede quedar en el ledger');
  assert.match(entry.cmd, /X-Api-Key: \$API_KEY/, 'se ve QUÉ credencial era');
  assert.match(entry.cmd, /contact-window-status/, 'el endpoint sigue legible: el cmd sirve para auditar');
  assert.match(res.stderr, /taparon/, 'avisa para que quien lo escribió use una variable');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('smoke-run.sh: tapa el JWT del header Authorization', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-jwt-'));
  const repo = path.join(fakeHome, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const evidence = path.join(repo, '.advisors', 'dod-runtime');
  // Por partes: escrito entero tiene la forma de un token de sesión, y el escaneo de secretos
  // de GitHub —que no lee las excepciones del equipo— lo marcaría en la copia pública. En ejecución es el de siempre.
  const JWT = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abc123def456ghi'].join('.');
  spawnSync('bash', [path.join(SCRIPTS, 'smoke-run.sh'), evidence, '9.7', '--acs', '2', '--pass-if', 'el comando termina bien', '--',
    'curl', '-s', '-H', `Authorization: Bearer ${JWT}`, 'http://localhost:5000/api/x'], {
    env: { ...process.env, HOME: fakeHome }, cwd: os.tmpdir(), encoding: 'utf8',
  });
  const entry = fs.readFileSync(path.join(evidence, '9.7-smoke-ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))[0];
  assert.ok(!entry.cmd.includes(JWT), 'el JWT NO puede quedar en el ledger');
  // `Authorization: Bearer` es una forma de la lista cerrada: se tapa con ***.
  assert.match(entry.cmd, /Bearer \*\*\*/);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// 🔴 El que protege de que el tapado se vuelva ruido: un comando SIN credencial tiene que salir
// intacto y SIN aviso. Si el tapado se pasa de celoso, nadie lee más el aviso y volvemos a cero.
test('smoke-run.sh: un cmd sin credencial queda intacto y no avisa', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-limpio-'));
  const repo = path.join(fakeHome, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const evidence = path.join(repo, '.advisors', 'dod-runtime');
  const res = spawnSync('bash', [path.join(SCRIPTS, 'smoke-run.sh'), evidence, '9.6', '--acs', '3', '--pass-if', 'el comando termina bien', '--',
    'curl', '-sf', 'http://localhost:5001/api/acciones/pendientes?page=1&pageSize=3'], {
    env: { ...process.env, HOME: fakeHome }, cwd: os.tmpdir(), encoding: 'utf8',
  });
  const entry = fs.readFileSync(path.join(evidence, '9.6-smoke-ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))[0];
  assert.match(entry.cmd, /pendientes\?page=1/, 'el comando limpio no se toca');
  assert.ok(!/\$API_KEY|\$TOKEN|\$CRED|\$VAL|\*\*\*/.test(entry.cmd), 'no inventa tapados donde no hay credencial');
  assert.ok(!/taparon/.test(res.stderr), 'sin credencial no hay aviso');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// El tapado NO puede romper el cruce con el espejo: runtime-matrix aparea por ts+story+acs+exit,
// nunca por cmd. Si alguien cambiara eso, este test lo caza.
test('smoke-run.sh: tapar el cmd no toca los campos con los que se cruza el espejo', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-par-'));
  const repo = path.join(fakeHome, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const evidence = path.join(repo, '.advisors', 'dod-runtime');
  spawnSync('bash', [path.join(SCRIPTS, 'smoke-run.sh'), evidence, '9.5', '--acs', '4,5', '--pass-if', 'el comando termina bien', '--',
    'bash', '-c', 'curl -H "X-Api-Key: omni_AbCdEfGh_1234567890123456789012345" http://x; true'], {
    env: { ...process.env, HOME: fakeHome }, cwd: os.tmpdir(), encoding: 'utf8',
  });
  const led = fs.readFileSync(path.join(evidence, '9.5-smoke-ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))[0];
  const esp = fs.readFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'smoke-run' && e.story === '9.5');
  assert.ok(esp, 'el espejo se escribió igual');
  assert.equal(led.ts, esp.ts, 'mismo ts → el cruce sigue apareando');
  assert.deepEqual(led.acs, esp.acs);
  assert.equal(led.exit, esp.exit);
  assert.ok(!led.cmd.includes('omni_AbCdEfGh'), 'y la clave no viajó');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// 🔴 Las formas que un tapado ingenuo dejaría pasar. La peor, `client_secret` y `access_token` — el par
// estándar de OAuth — porque `\bsecret` nunca calza dentro de `client_secret`: `_` es carácter de
// palabra. Cada fila de acá es una de esas fugas; si alguien vuelve a poner el `\b`, se caen.
const FORMAS_QUE_DEBEN_TAPARSE = [
  ['client_secret=abcdefghij1234567890', 'OAuth: secreto de cliente'],
  ['access_token=abcdefghij1234567890', 'OAuth: token de acceso'],
  ['refresh_token=abcdefghij1234567890', 'OAuth: token de refresco'],
  ['-d {"password":"hunter2XYZ"}', 'clave en cuerpo JSON'],
  ['-H Authorization: Basic YWRtaW46c3VwZXJzZWNyZXQ=', 'esquema Basic'],
  ['PGPASSWORD=miClaveLarga', 'credencial por variable de entorno'],
  ['?api_key=abcdefghij1234567890', 'clave en la URL'],
];

for (const [fragmento, queEs] of FORMAS_QUE_DEBEN_TAPARSE) {
  test(`smoke-run.sh: tapa ${queEs}`, () => {
    const { execFileSync, spawnSync } = require('node:child_process');
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-forma-'));
    const repo = path.join(fakeHome, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const evidence = path.join(repo, '.advisors', 'dod-runtime');
    spawnSync('bash', [path.join(SCRIPTS, 'smoke-run.sh'), evidence, '9.4', '--acs', '1', '--pass-if', 'el comando termina bien', '--',
      'echo', fragmento], { env: { ...process.env, HOME: fakeHome }, cwd: os.tmpdir(), encoding: 'utf8' });
    const entry = fs.readFileSync(path.join(evidence, '9.4-smoke-ledger.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))[0];
    // `***` es el tapado de la lista cerrada: PGPASSWORD=… cae ahí.
    assert.match(entry.cmd, /\$VAL|\$CRED|\$TOKEN|\$API_KEY|\*\*\*/, `${queEs}: el valor tiene que quedar tapado`);
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });
}

test('smoke-run.sh: tapa el par usuario:clave de curl -u', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-u-'));
  const repo = path.join(fakeHome, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const evidence = path.join(repo, '.advisors', 'dod-runtime');
  spawnSync('bash', [path.join(SCRIPTS, 'smoke-run.sh'), evidence, '9.3', '--acs', '1', '--pass-if', 'el comando termina bien', '--',
    'curl', '-u', 'admin:claveSecreta123', 'http://localhost:1/x'], {
    env: { ...process.env, HOME: fakeHome }, cwd: os.tmpdir(), encoding: 'utf8' });
  const entry = fs.readFileSync(path.join(evidence, '9.3-smoke-ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))[0];
  assert.ok(!entry.cmd.includes('claveSecreta123'), 'la clave no puede quedar');
  assert.match(entry.cmd, /\$USUARIO:\$VAL/);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── on-frontmatter-write: el gate acepta la evidencia del e2e-gate.sh GENÉRICO ─────────
// El hook acepta el literal `failed=0` (formato del macro backend) y el gate genérico escribe `- failed: 0`: si no
// aceptara los dos, ninguna story verificada con el gate genérico podría pasar a review/done por Edit (la deriva
// de contrato que la cabecera del propio gate advierte). Este test FALLA si el hook acepta sólo `failed=0`.
test('on-frontmatter-write: hasFreshPlaywrightPass acepta "failed=0" (macro) y "- failed: 0" (gate genérico)', () => {
  const { hasFreshPlaywrightPass } = require(path.join(SCRIPTS, 'on-frontmatter-write.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-pw-'));
  const dir = path.join(root, '.advisors', 'dod-runtime');
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, body) => fs.writeFileSync(path.join(dir, name), body);

  write('G-9-e2e-gate-1.md', '# E2E Gate\n\nverdict=PASS\n\n## Playwright Run\n- verdict: PASS\n- total: 1\n- passed: 1\n- failed: 0\n- skipped: 0\n');
  assert.equal(hasFreshPlaywrightPass([root], 'G-9', null).pass, true, 'formato del gate genérico (- failed: 0) debe pasar');

  fs.unlinkSync(path.join(dir, 'G-9-e2e-gate-1.md'));
  write('G-9-20260101.md', '## Playwright Run\n\nverdict=PASS failed=0 passed=3 skipped=0\n');
  assert.equal(hasFreshPlaywrightPass([root], 'G-9', null).pass, true, 'formato del macro (failed=0) debe seguir pasando');

  fs.unlinkSync(path.join(dir, 'G-9-20260101.md'));
  write('G-9-e2e-gate-2.md', '# E2E Gate\n\nverdict=PASS\n\n## Playwright Run\n- verdict: PASS\n- failed: 1\n');
  assert.equal(hasFreshPlaywrightPass([root], 'G-9', null).pass, false, 'failed: 1 NO debe pasar');

  fs.unlinkSync(path.join(dir, 'G-9-e2e-gate-2.md'));
  write('G-9-e2e-gate-3.md', '# E2E Gate\n\nverdict=PASS\n\n## Playwright Run\n- verdict: PASS\n- failed: 10\n');
  assert.equal(hasFreshPlaywrightPass([root], 'G-9', null).pass, false, 'failed: 10 NO debe pasar (\\b)');
});

// ── El piso de frescura de la evidencia se decide por CONTENIDO ───────────────────────────────
// 🔴 La fecha del disco sube sola con un checkout/rebase/stash pop del mismo contenido (bloqueo falso) y la fecha
// del commit deja pasar un `pull` con un commit ajeno más viejo que la evidencia (verde falso), se pone en «hoy»
// con un rebase o un amend, y un commit posterior a la corrida —el orden normal del pipeline— la invalida.
// Por eso acá cada toque deja hash + hora en el marker.
const sha1De = (f) => require('crypto').createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const enero = Date.parse('2026-01-15T13:00:00Z');
// repo git efímero con identidad configurada; `g` corre git adentro sin ruido
const repoGit = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'piso-git-'));
  const g = (...args) => require('node:child_process').execFileSync('git', ['-C', d, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'b@b'); g('config', 'user.name', 'b'); g('config', 'commit.gpgsign', 'false');
  return { d, g };
};

test('piso: el contenido que la sesión dejó vale por la hora de ESE toque, aunque git lo haya reescrito hoy', () => {
  const { fechaDeCambio } = require(path.join(SCRIPTS, 'on-frontmatter-write.js'));
  const { d, g } = repoGit();
  const f = path.join(d, 'app.js');
  fs.writeFileSync(f, 'v1\n'); g('add', '-A'); g('commit', '-q', '-m', 'v1');
  const registro = { [f]: { hash: sha1De(f), ts: enero } };
  g('checkout', '-q', '-b', 'otra'); fs.writeFileSync(f, 'v2\n'); g('commit', '-qam', 'v2');
  g('checkout', '-q', 'main');                                   // git reescribe app.js con v1: mtime = hoy
  assert.equal(fs.readFileSync(f, 'utf8'), 'v1\n');
  assert.equal(fechaDeCambio(f, registro), enero, 'mismo contenido que el toque → la hora del toque, no la del disco');
  fs.rmSync(d, { recursive: true, force: true });
});

test('piso: un pull que trae OTRO contenido sube el piso a la fecha del disco (el verde falso de la fecha del commit)', () => {
  const { fechaDeCambio } = require(path.join(SCRIPTS, 'on-frontmatter-write.js'));
  const origen = repoGit(); const fo = path.join(origen.d, 'app.js');
  fs.writeFileSync(fo, 'v1\n'); origen.g('add', '-A'); origen.g('commit', '-q', '-m', 'v1');
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'piso-clon-'));
  require('node:child_process').execFileSync('git', ['clone', '-q', origen.d, path.join(dl, 'repo')]);
  const f = path.join(dl, 'repo', 'app.js');
  const registro = { [f]: { hash: sha1De(f), ts: enero } };   // la sesión tocó v1 en enero
  // en el origen, un colega commitea v2 con fecha VIEJA (febrero); el clon lo trae hoy
  fs.writeFileSync(fo, 'v2\n');
  require('node:child_process').execFileSync('git', ['-C', origen.d, 'commit', '-qam', 'v2'],
    { env: { ...process.env, GIT_AUTHOR_DATE: '2026-02-01T10:00:00', GIT_COMMITTER_DATE: '2026-02-01T10:00:00' } });
  require('node:child_process').execFileSync('git', ['-C', path.join(dl, 'repo'), 'pull', '-q']);
  assert.equal(fs.readFileSync(f, 'utf8'), 'v2\n');
  const t = fechaDeCambio(f, registro);
  assert.ok(t > Date.now() - 60 * 1000, `dio ${new Date(t).toISOString()}: el contenido cambió HOY por el pull, no en febrero`);
  fs.rmSync(origen.d, { recursive: true, force: true }); fs.rmSync(dl, { recursive: true, force: true });
});

test('piso: un rebase, un --amend o un commit posterior a la corrida NO mueven el piso si el contenido es el mismo', () => {
  const { fechaDeCambio } = require(path.join(SCRIPTS, 'on-frontmatter-write.js'));
  const { d, g } = repoGit();
  const f = path.join(d, 'app.js');
  fs.writeFileSync(f, 'base\n'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'story'); fs.writeFileSync(f, 'mio\n');
  const registro = { [f]: { hash: sha1De(f), ts: enero } };   // la sesión editó; la evidencia vino después
  g('commit', '-qam', 'mio');                                    // commit POSTERIOR a la evidencia
  assert.equal(fechaDeCambio(f, registro), enero, 'commitear lo ya probado no lo vuelve viejo');
  g('commit', '-q', '--amend', '--no-edit', '--allow-empty');
  assert.equal(fechaDeCambio(f, registro), enero, 'un amend tampoco');
  g('checkout', '-q', 'main'); fs.writeFileSync(path.join(d, 'otro.js'), 'x\n'); g('add', '-A'); g('commit', '-q', '-m', 'otro');
  g('checkout', '-q', 'story'); g('rebase', '-q', 'main');       // git reescribe app.js con el mismo contenido
  assert.equal(fs.readFileSync(f, 'utf8'), 'mio\n');
  assert.equal(fechaDeCambio(f, registro), enero, 'un rebase que deja el mismo contenido tampoco');
  fs.rmSync(d, { recursive: true, force: true });
});

test('piso: sin sello (marker viejo, archivo tocado por Bash) o con contenido cambiado por otro, manda la fecha del disco', () => {
  const { fechaDeCambio } = require(path.join(SCRIPTS, 'on-frontmatter-write.js'));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'piso-sin-sello-'));
  const f = path.join(d, 'gen.js'); fs.writeFileSync(f, 'a\n');
  assert.ok(fechaDeCambio(f, {}) > Date.now() - 60 * 1000, 'sin sello: la fecha del disco');
  assert.ok(fechaDeCambio(f, undefined) > Date.now() - 60 * 1000, 'sin registro: la fecha del disco');
  const registro = { [f]: { hash: 'no-es-este-contenido', ts: enero } };
  assert.ok(fechaDeCambio(f, registro) > Date.now() - 60 * 1000, 'otro contenido: cambió después del toque, la fecha del disco');
  assert.equal(fechaDeCambio(path.join(d, 'no-existe.js'), registro), 0, 'un archivo borrado no sube el piso');
  fs.rmSync(d, { recursive: true, force: true });
});

test('piso: un archivo IGNORADO por git cuenta igual que cualquiera (con sello y sin sello)', () => {
  const { fechaDeCambio } = require(path.join(SCRIPTS, 'on-frontmatter-write.js'));
  const { d, g } = repoGit();
  fs.writeFileSync(path.join(d, '.gitignore'), 'gen.js\n'); g('add', '-A'); g('commit', '-q', '-m', 'ign');
  const f = path.join(d, 'gen.js'); fs.writeFileSync(f, 'g\n');
  assert.ok(fechaDeCambio(f, {}) > Date.now() - 60 * 1000, 'ignorado y sin sello: la fecha del disco (no desaparece)');
  assert.equal(fechaDeCambio(f, { [f]: { hash: sha1De(f), ts: enero } }), enero, 'ignorado con sello: la hora del toque');
  fs.rmSync(d, { recursive: true, force: true });
});

test('computeFreshnessFloor: lee los sellos del marker, toma el MÁXIMO, y los .md y specs no cuentan', () => {
  const { computeFreshnessFloor } = require(path.join(SCRIPTS, 'on-frontmatter-write.js'));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'piso-marker-'));
  const a = path.join(d, 'a.js'); const b = path.join(d, 'b.js'); const md = path.join(d, 'nota.md');
  fs.writeFileSync(a, 'a\n'); fs.writeFileSync(b, 'b\n'); fs.writeFileSync(md, 'm\n');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'piso-home-'));
  const dirM = path.join(home, '.claude', '.tycon-pipeline', 'active'); fs.mkdirSync(dirM, { recursive: true });
  const febrero = Date.parse('2026-02-10T10:00:00Z');
  fs.writeFileSync(path.join(dirM, 'sello-s1.json'), JSON.stringify({
    filesTouched: [a, b, md],
    filesTouchedAt: { [a]: { hash: sha1De(a), ts: enero }, [b]: { hash: sha1De(b), ts: febrero }, [md]: { hash: sha1De(md), ts: Date.now() } },
  }));
  const homeViejo = process.env.HOME; process.env.HOME = home;
  const piso = computeFreshnessFloor('sello-s1');
  process.env.HOME = homeViejo;
  assert.equal(piso, febrero, 'el máximo de los sellos de código; el .md (tocado hoy) no cuenta');
  fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
});

test('el piso no cuesta procesos: 30 archivos con sello se resuelven sin git', () => {
  const { computeFreshnessFloor } = require(path.join(SCRIPTS, 'on-frontmatter-write.js'));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'piso-perf-'));
  const nombres = Array.from({ length: 30 }, (_, i) => path.join(d, `f${i}.js`));
  const at = {};
  for (const n of nombres) { fs.writeFileSync(n, 'x\n'); at[n] = { hash: sha1De(n), ts: enero }; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'piso-perf-home-'));
  const dirM = path.join(home, '.claude', '.tycon-pipeline', 'active'); fs.mkdirSync(dirM, { recursive: true });
  fs.writeFileSync(path.join(dirM, 'perf-s1.json'), JSON.stringify({ filesTouched: nombres, filesTouchedAt: at }));
  const homeViejo = process.env.HOME; process.env.HOME = home;
  const t0 = Date.now(); const piso = computeFreshnessFloor('perf-s1'); const ms = Date.now() - t0;
  process.env.HOME = homeViejo;
  assert.equal(piso, enero);
  assert.ok(ms < 500, `tardó ${ms} ms con 30 archivos: el hook corre en CADA escritura de frontmatter`);
  fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
});

test('la hora de la evidencia sale de ADENTRO del archivo: un merge que la rejuvenece no la vuelve fresca (crítico D5)', () => {
  const { hasFreshPlaywrightPass, tiempoDeEvidencia } = require(path.join(SCRIPTS, 'on-frontmatter-write.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evid-'));
  const dir = path.join(root, '.advisors', 'dod-runtime'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '7.7-smoke-evidencia.md');
  const generado = '2026-03-01T10:00:00.000Z';
  fs.writeFileSync(f, `# evidencia\n**Generado**: ${generado} · smoke 2026-03-01T09:50:00Z\n\n## Playwright Run\nverdict=PASS\nfailed=0\n`);
  // el archivo tiene fecha de HOY (un merge lo reescribió); la corrida es de marzo
  assert.equal(tiempoDeEvidencia(f, fs.readFileSync(f, 'utf8')), Date.parse(generado), 'la hora de generación, no la del archivo');
  const pisoAbril = Date.parse('2026-04-01T00:00:00Z');
  assert.deepEqual(hasFreshPlaywrightPass([root], '7.7', pisoAbril), { pass: false, stale: true }, 'código cambiado en abril: la corrida de marzo es STALE aunque el archivo sea de hoy');
  assert.deepEqual(hasFreshPlaywrightPass([root], '7.7', Date.parse('2026-02-01T00:00:00Z')), { pass: true }, 'código de febrero: la corrida de marzo lo cubre');
  // 🔴 El formato REAL de e2e-gate.sh —el único productor de evidencia Playwright del pipeline—:
  // sello compacto en el nombre y en el encabezado, sin «Generado» ni ISO con guiones.
  const real = path.join(dir, '7.7-e2e-gate-20260301T100000Z.md');
  fs.writeFileSync(real, '# E2E Gate — 7.7 — 20260301T100000Z\n\n## Playwright Run\n```\nverdict=PASS\n- failed: 0\n```\n');
  assert.equal(tiempoDeEvidencia(real, fs.readFileSync(real, 'utf8')), Date.parse(generado), 'el sello compacto del nombre/encabezado se lee');
  fs.rmSync(f);   // dejar sólo la de e2e-gate para el veredicto
  assert.deepEqual(hasFreshPlaywrightPass([root], '7.7', pisoAbril), { pass: false, stale: true }, 'la evidencia de e2e-gate.sh también queda STALE');

  // sin hora adentro, manda la fecha del archivo (como siempre)
  const g = path.join(dir, '7.8-smoke-evidencia.md');
  fs.writeFileSync(g, '## Playwright Run\nverdict=PASS\nfailed=0\n');
  assert.ok(Math.abs(tiempoDeEvidencia(g, fs.readFileSync(g, 'utf8')) - fs.statSync(g).mtimeMs) < 1000);
  // una fecha FUTURA adentro (una `revision:` de octubre) no rejuvenece: vale la menor
  const h = path.join(dir, '7.9-smoke-evidencia.md');
  fs.writeFileSync(h, '## Playwright Run\nverdict=PASS\nfailed=0\nrevision: 2030-10-15T00:00:00Z\n');
  assert.ok(tiempoDeEvidencia(h, fs.readFileSync(h, 'utf8')) <= fs.statSync(h).mtimeMs + 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('on-edit (hook REAL) deja el sello hash+hora del archivo tocado en el marker', () => {
  const { sessionIdFileKey } = require(path.join(SCRIPTS, 'lib', 'session-id.js'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sello-hook-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sello-hook-repo-'));
  require('node:child_process').execFileSync('git', ['-C', repo, 'init', '-q']);
  const f = path.join(repo, 'src', 'servicio.js'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'contenido editado\n');
  const sid = 'sesion-sello';
  const dirM = path.join(home, '.claude', '.tycon-pipeline', 'active'); fs.mkdirSync(dirM, { recursive: true });
  const markerPath = path.join(dirM, `${sessionIdFileKey(sid)}.json`);
  fs.writeFileSync(markerPath, JSON.stringify({ storyId: '1.1', repoPath: repo, filesTouched: [], fileEvents: [], iterations: {}, checks: {} }));
  const payload = JSON.stringify({ tool_name: 'Edit', session_id: sid, cwd: repo, tool_input: { file_path: f, old_string: 'x', new_string: 'y' } });
  const r = require('node:child_process').spawnSync(process.execPath, [path.join(SCRIPTS, 'on-edit.js')], { input: payload, encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.ok(m.filesTouched.includes(f), 'el archivo entró a filesTouched');
  assert.ok(m.filesTouchedAt && m.filesTouchedAt[f], 'y tiene su sello');
  assert.equal(m.filesTouchedAt[f].hash, sha1De(f), 'el hash es el del contenido que dejó la edición');
  assert.ok(Date.now() - m.filesTouchedAt[f].ts < 60 * 1000, 'con la hora de ahora');
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

// ── El detector de specs Playwright acepta también `e2e/` ────────────────────────────────────
//
// Si el patrón fuera sólo `(^|/)tests/e2e/`, el layout `<app>/e2e/` devolvería `{}` — "este repo no tiene E2E" —
// en vez del aviso de gate sin declarar. Es un layout real: 9 specs + config en `<app>/e2e/`. El aviso es el
// ÚNICO mecanismo por el que un repo se entera de que le falta declarar el gate, así que un layout no
// contemplado no da error: da silencio, y el repo se queda sin E2E creyendo que no tiene.
test('GateE2E_DetectaSpecsEnE2eSinTests', () => {
  const { e2eConfig } = require(path.join(SCRIPTS, 'pipeline.js'));
  const mk = (layout) => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'e2edetect-'));
    fs.mkdirSync(path.join(repo, 'app', layout), { recursive: true });
    fs.writeFileSync(path.join(repo, 'app', 'playwright.config.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(repo, 'app', layout, 'x.spec.ts'), '// spec\n');
    return repo;
  };

  // (a) EL RENGLÓN: layout `<app>/e2e/`, que se detecta.
  const conE2e = mk('e2e');
  const cfgE2e = e2eConfig(conE2e);
  assert.equal(cfgE2e.gap, true, '`<app>/e2e/*.spec.ts` tiene que disparar el aviso de gate sin declarar');
  assert.match(cfgE2e.warning, /NO declara `e2e\.gate`/, 'el aviso tiene que decir qué falta');

  // (b) No-regresión: el layout de siempre (`tests/e2e/`) sigue detectándose.
  const conTests = mk(path.join('tests', 'e2e'));
  assert.equal(e2eConfig(conTests).gap, true, '`tests/e2e/` tiene que seguir detectándose');

  // (c) Un repo SIN specs de navegador sigue devolviendo {} — el aviso no se volvió ruido.
  const sinE2e = fs.mkdtempSync(path.join(os.tmpdir(), 'e2enone-'));
  fs.mkdirSync(path.join(sinE2e, 'src'), { recursive: true });
  fs.writeFileSync(path.join(sinE2e, 'src', 'x.spec.ts'), '// unit test, no e2e\n');
  assert.deepEqual(e2eConfig(sinE2e), {}, 'sin playwright.config ni carpeta e2e → {} (silencio correcto)');

  // (d) Con el gate YA declarado no hay gap: el aviso es sólo para el que se olvidó.
  fs.mkdirSync(path.join(conE2e, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(conE2e, '.tycon', 'advisors.yaml'),
    'e2e:\n  gate: scripts/e2e-gate.sh\n  frontend_dir: app\n');
  const cfgDeclarado = e2eConfig(conE2e);
  assert.ok(!cfgDeclarado.gap, 'con gate declarado no hay gap');
  assert.ok(cfgDeclarado.gate, 'y se resuelve el gate del repo');

  for (const r of [conE2e, conTests, sinE2e]) fs.rmSync(r, { recursive: true, force: true });
});

// ── El script del gate y `.tycon/` entero cuentan como compartidos ───────────────────────────
//
// Sin esto, `--changed scripts/e2e-gate.sh` devolvería `[]` ("ninguna de las apps declaradas fue tocada"). O sea:
// se podría MODIFICAR el ejecutor de las pruebas de navegador y mergear sin que corriera una sola prueba.
// Y la lista de "archivos propios del control" son PREFIJOS, no rutas exactas: con rutas exactas habría que
// acordarse de agregar cada config nueva, el mismo modo de falla que la config del propio control, un nivel más abajo.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// PIPE-C2 · el preflight NO puede pisar lo que el repo ya decidió sobre .advisors/.dashboard
//
// 🔴 Si PIPE-C2 decidiera si falta `.advisors/` buscando una línea EXACTAMENTE igual, un repo que lo ignora con
//    `**/.advisors/*` + `!**/.advisors/dod-runtime/` —el patrón que deja viajar la evidencia de
//    cierre— lo daría por ausente y appendearía `.advisors/` en CADA `start`. Y ese patrón
//    ANULA la negación: git no re-incluye archivos dentro de un directorio excluido, o sea que
//    la evidencia de cierre dejaría de viajar y el medidor SDLC la leería como 0%.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('PipeC2_LePreguntaAGitYNoAlTexto', () => {
  // 🔴 LOS ONCE: decidir por TEXTO («¿el .gitignore menciona `.advisors`?») se equivocaría del lado CARO.
  //    Cada fila de abajo es un .gitignore plausible donde el texto dice «ya está cubierta» y `git check-ignore`
  //    dice que NO: negación suelta, subruta, archivo suelto, comodín de extensión, ruta anclada, espacio
  //    escapado, comentario pegado al final de la línea. Con una versión textual, TODAS devolverían
  //    [] y el repo commitearía los artefactos efímeros de advisors.
  //
  // 🔴 Y se prueba contra GIT DE VERDAD, no contra una reimplementación de sus reglas: si el
  //    criterio se probara con un motor propio, el test daría verde exactamente en los casos en
  //    que el motor propio se equivoca igual que el código.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-c2-'));
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });

  const probe = (rel) => {
    try {
      execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--', rel], { stdio: 'ignore' });
      return true;
    } catch (e) { return e && e.status === 1 ? false : null; }
  };
  const con = (gitignore) => {
    fs.writeFileSync(path.join(repo, '.gitignore'), gitignore);
    return computeGitignoreNeeds(probe);
  };

  // (1) los que NO ignoran nada aunque nombren la carpeta: hay que agregar el bloque canónico.
  const NO_ALCANZAN = [
    ['negación suelta', '!**/.advisors/dod-runtime/\n.dashboard/\n'],
    ['negación suelta simple', '!.advisors/\n.dashboard/\n'],
    ['sólo la evidencia', '.advisors/dod-runtime/\n.dashboard/\n'],
    ['un archivo suelto', '.advisors/tests-result.json\n.dashboard/\n'],
    ['comodín de extensión', '.advisors/*.json\n.dashboard/\n'],
    ['subruta profunda', 'docs/.advisors/algo.md\n.dashboard/\n'],
    ['subruta de un subproyecto', 'src/.advisors/\n.dashboard/\n'],
    ['ruta anclada a otra carpeta', '/src/.advisors/\n.dashboard/\n'],
    ['comentario pegado al final', '.advisors/ # no viajan\n.dashboard/\n'],
    ['espacio escapado', '.advisors\\ \n.dashboard/\n'],
    ['nombre parecido', '.advisors-viejo/\n.dashboard/\n'],
  ];
  for (const [nombre, gi] of NO_ALCANZAN) {
    const { append } = con(gi);
    assert.ok(append.includes('**/.advisors/*'),
      `«${nombre}»: git NO ignora los artefactos efímeros, así que falta la regla y hay que ponerla`);
    assert.ok(!append.includes('.advisors/'),
      `«${nombre}»: y lo que se agrega NUNCA es \`.advisors/\` a secas — esa línea anula la negación`);
  }

  // (2) los que SÍ alcanzan: no se toca nada.
  for (const [nombre, gi] of [
    ['el par canónico', '**/.advisors/*\n!**/.advisors/dod-runtime/\n.dashboard/\n'],
    ['la línea simple de siempre', '.advisors/\n.dashboard/\n'],
    ['sin barra final', '.advisors\n.dashboard\n'],
    ['comodín de carpeta', '.advisors/**\n.dashboard/\n'],
  ]) {
    assert.deepEqual(con(gi).append, [], `«${nombre}»: git ya los ignora, no hay nada que agregar`);
  }

  // (3) el .gitignore vacío: van las dos.
  const vacio = con('');
  assert.ok(vacio.append.includes('**/.advisors/*') && vacio.append.includes('.dashboard/'));

  // (4) se decide carpeta por carpeta.
  assert.deepEqual(con('**/.advisors/*\n!**/.advisors/dod-runtime/\n').append, ['.dashboard/'],
    '.advisors cubierta, .dashboard no: se agrega sólo la que falta');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('PipeC2_AvisaCuandoLaEvidenciaDeCierreNoViaja', () => {
  // 🔴 El caso que el preflight no debe INSTALAR: `.advisors/` a secas ignora también
  //    `.advisors/dod-runtime/`, así que la evidencia de cierre no viaja y el medidor SDLC la lee
  //    como 0%.
  // 🔴 Quedarse en «ya está cubierta» y no decir nada dejaría al repo midiendo 0% para siempre sin que nadie sepa
  //    por qué. Y NO se reescribe solo: pisar la decisión del repo en silencio sería
  //    el mismo pecado del otro lado.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-c2-aviso-'));
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, '.gitignore'), '.advisors/\n.dashboard/\n');
  const probe = (rel) => {
    try {
      execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--', rel], { stdio: 'ignore' });
      return true;
    } catch (e) { return e && e.status === 1 ? false : null; }
  };
  const { append, notices } = computeGitignoreNeeds(probe);
  assert.deepEqual(append, [], 'no se toca el archivo: el repo ya decidió');
  assert.equal(notices.length, 1, `tiene que avisar UNA vez y trajo ${JSON.stringify(notices)}`);
  assert.match(notices[0], /evidencia de cierre/, 'y el aviso dice cuál es el problema');
  assert.match(notices[0], /No lo cambio solo/, 'y que la decisión es de una persona');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('PipeC2_NoPuderPreguntarNoEsFalta', () => {
  // 🔴 Tratar el `null` del probe como «falta» → en un directorio que no es repo git
  //    (o sin git instalado) el preflight appendearía a ciegas sobre un .gitignore que no leyó.
  //    «No pude mirar» y «miré y falta» no se escriben igual.
  const { append, notices } = computeGitignoreNeeds(() => null);
  assert.deepEqual(append, [], 'sin poder preguntar no se toca nada');
  assert.equal(notices.length, 2, 'y se deja constancia de las dos carpetas');
  for (const n of notices) assert.match(n, /no pude preguntarle a git/i);
});

test('GateMerge_ElScriptDelGateYLaCarpetaTyconSonCompartidos', () => {
  const { e2eConfig, selectE2eApps } = require(path.join(SCRIPTS, 'pipeline.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'e2egate-'));
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'e2e-gate.sh'), '#!/usr/bin/env bash\n');
  for (const a of ['app-uno', 'app-dos']) {
    fs.mkdirSync(path.join(repo, a, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(repo, a, 'playwright.config.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(repo, a, 'e2e', 'x.spec.ts'), '// spec\n');
  }
  // Sin `shared_paths:` a propósito — como el repo del framework, que no declara ninguno.
  fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'),
    'e2e:\n  gate: scripts/e2e-gate.sh\n  frontend_dirs:\n    - app-uno\n    - app-dos\n');
  const cfg = e2eConfig(repo);
  const bn = (xs) => xs.map((d) => path.basename(d));
  assert.deepEqual(cfg.shared_paths, [], 'precondición: el repo NO declara shared_paths');

  // (a) EL RENGLÓN DEL FIX: tocar el script del gate ejerce TODAS las apps.
  assert.equal(selectE2eApps(cfg, ['scripts/e2e-gate.sh']).length, 2,
    'modificar el ejecutor de las pruebas tiene que correr las pruebas, no "0 apps tocadas"');
  assert.equal(selectE2eApps(cfg, [path.join(repo, 'scripts', 'e2e-gate.sh')]).length, 2,
    'también con path ABSOLUTO (lo que guarda marker.filesTouched)');

  // (b) `.tycon/` entero como PREFIJO: una config futura entra sin que nadie la agregue.
  assert.equal(selectE2eApps(cfg, ['.tycon/advisors.yaml']).length, 2, 'no-regresión: la config del control');
  assert.equal(selectE2eApps(cfg, ['.tycon/e2e-critical-specs.txt']).length, 2,
    'un manifest nuevo bajo .tycon/ entra solo, sin declararlo');
  assert.equal(selectE2eApps(cfg, ['.tycon/precondiciones-futuras.yaml']).length, 2,
    'cualquier config futura bajo .tycon/ también');

  // (c) El gate por DEFAULT del harness (fuera del repo) NO convierte todo en compartido.
  fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'),
    'e2e:\n  frontend_dirs:\n    - app-uno\n    - app-dos\n');
  const cfgDefault = e2eConfig(repo);
  assert.ok(!cfgDefault.gate.startsWith(repo), 'precondición: el gate por default vive fuera del repo');
  assert.deepEqual(selectE2eApps(cfgDefault, ['README.md']), [],
    'con el gate del harness, un cambio ajeno sigue sin correr nada');

  // (d) La selección quirúrgica no se rompió: no se volvió "todo es compartido".
  assert.deepEqual(bn(selectE2eApps(cfg, ['app-uno/src/x.tsx'])), ['app-uno']);
  assert.deepEqual(selectE2eApps(cfg, ['README.md', 'docs/x.md']), [],
    'un cambio de docs sigue sin correr E2E');
  assert.deepEqual(selectE2eApps(cfg, ['scripts/deploy.sh']), [],
    'otro script de scripts/ que NO es el gate declarado no dispara nada');

  fs.rmSync(repo, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// La evidencia de cierre nace en el repo de la STORY, no en el del código.
// Ejemplo: stories en Project, código en Backend/FrontEnd/Web. Si el pipeline dejara la
// evidencia donde corre (el código), el portón de CI de Project —que sólo mira su checkout—
// daría rojo en cada pull request y habría que copiarla a mano.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
function repoTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-q', d], { stdio: 'ignore' });
  return fs.realpathSync(d);
}

test('EvidenciaNaceEnElRepoDeLaStory_AunqueElCodigoEsteEnOtro', () => {
  const { evidenceDirForStory } = require(path.join(SCRIPTS, 'lib', 'evidence-config.js'));
  const project = repoTmp('evid-project-');
  const codeRepo = repoTmp('evid-site-');
  fs.mkdirSync(path.join(project, 'specs', 'stories'), { recursive: true });
  const story = path.join(project, 'specs', 'stories', '8-8.md');
  fs.writeFileSync(story, '---\nstory: "8.8"\nstatus: in-progress\n---\n');

  // (1) 🔴 El destino es el repo de la story, no `<cwd>/.advisors/dod-runtime` = el repo del código.
  const cruzado = evidenceDirForStory(story, codeRepo);
  assert.equal(cruzado.dir, path.join(project, '.advisors', 'dod-runtime'), 'va al repo de la story');
  assert.equal(cruzado.crossRepo, true, 'y sabe que son dos repos');
  assert.equal(cruzado.storyRepo, project);
  assert.equal(cruzado.warning, null, 'sin nada que avisar: se resolvió');

  // (2) mismo repo: el directorio de siempre, sin drama.
  const mismo = evidenceDirForStory(story, project);
  assert.equal(mismo.dir, path.join(project, '.advisors', 'dod-runtime'));
  assert.equal(mismo.crossRepo, false);

  // (3) story fuera de git: cae al repo de trabajo Y LO DICE (un fallback mudo se lee como decisión).
  const suelta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evid-suelta-')), 'x.md');
  fs.writeFileSync(suelta, '---\nstory: "1.1"\n---\n');
  const fallback = evidenceDirForStory(suelta, codeRepo);
  assert.equal(fallback.dir, path.join(codeRepo, '.advisors', 'dod-runtime'));
  assert.equal(fallback.source, 'fallback-repo');
  assert.match(fallback.warning, /portón de CI/, 'avisa que el portón no la va a ver');

  // (4) el comando del CLI devuelve lo mismo (es lo que consume el step 7c).
  const out = execFileSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'evidence-dir',
    '--story', story, '--repo', codeRepo, '--plain'], { encoding: 'utf8' }).trim();
  assert.equal(out, cruzado.dir, 'el CLI --plain imprime el mismo destino');
  const json = JSON.parse(execFileSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'evidence-dir',
    '--story', story, '--repo', codeRepo], { encoding: 'utf8' }));
  assert.equal(json.cross_repo, true);
  // Project sin .gitignore: git no ignora nada → no hay aviso de "se la traga".
  assert.ok(!json.gitignore_notices, 'sin .gitignore que se la trague no hay aviso');
  // Project que se la TRAGA: el aviso viaja con la respuesta — es lo que hacía rojo al portón.
  fs.writeFileSync(path.join(project, '.gitignore'), '.advisors/\n');
  const traga = JSON.parse(execFileSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'evidence-dir',
    '--story', story, '--repo', codeRepo], { encoding: 'utf8' }));
  assert.ok(Array.isArray(traga.gitignore_notices) && /evidencia de cierre/.test(traga.gitignore_notices[0]),
    'si el repo de la story se traga la evidencia, el comando lo dice');

  for (const d of [project, codeRepo, path.dirname(suelta)]) fs.rmSync(d, { recursive: true, force: true });
});

test('PipeC2_ElRegistroDeRevisoresTambienViaja_ProbadoContraGit', () => {
  // 🔴 El segundo muro: el portón exige, para `done`, el run dir con
  //    `review-roster.json` + `findings.json` en el repo de la story — y si ningún repo de la
  //    organización los trackea, `**/.advisors/*` + `!dod-runtime/` los sigue ignorando.
  //    Se prueba contra git de verdad (check-ignore), no contra una lectura del texto.
  const { GITIGNORE_ADVISORS, computeGitignoreNeeds } = require(path.join(SCRIPTS, 'pipeline.js'));
  const repo = repoTmp('pipe-c2-roster-');
  const ignora = (rel) => {
    try { execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--', rel], { stdio: 'ignore' }); return true; }
    catch (e) { return e && e.status === 1 ? false : null; }
  };
  fs.writeFileSync(path.join(repo, '.gitignore'), GITIGNORE_ADVISORS.join('\n') + '\n');
  const viaja = [
    '.advisors/dod-runtime/8.8-20260905T190000Z.md',
    '.advisors/pipeline-runs/8.8-20260905120000/review-roster.json',
    '.advisors/pipeline-runs/8.8-20260905120000/findings.json',
  ];
  const noViaja = [
    '.advisors/tests-result.json',
    '.advisors/pipeline-runs/8.8-20260905120000/step-05-advisor-reports/security.md',
    '.advisors/pipeline-runs/8.8-20260905120000/advisor-context.md',
    '.advisors/runtime-matrix/cache.json',
  ];
  for (const f of viaja) assert.equal(ignora(f), false, `${f} tiene que VIAJAR`);
  for (const f of noViaja) assert.equal(ignora(f), true, `${f} NO tiene que viajar`);

  // El par canónico viejo (sin la re-inclusión del roster) NO se reescribe solo, pero AVISA que
  // el registro de revisores no viaja — y avisa UNA vez, con las dos cosas si faltan las dos.
  fs.writeFileSync(path.join(repo, '.gitignore'), '**/.advisors/*\n!**/.advisors/dod-runtime/\n.dashboard/\n');
  const viejo = computeGitignoreNeeds(ignora);
  assert.deepEqual(viejo.append, [], 'ya decidió: no se toca');
  assert.equal(viejo.notices.length, 1);
  assert.match(viejo.notices[0], /registro de revisores/);
  assert.doesNotMatch(viejo.notices[0], /evidencia de cierre de cada story NO viaja/, 'la evidencia sí viaja acá: no se acusa de más');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.advisors/\n.dashboard/\n');
  const todo = computeGitignoreNeeds(ignora);
  assert.equal(todo.notices.length, 1, 'un solo aviso aunque falten las dos');
  assert.match(todo.notices[0], /evidencia de cierre/);
  assert.match(todo.notices[0], /registro de revisores/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('ProyeccionDelRunDirAlRepoDeLaStory_SoloRosterYFindings', () => {
  const { projectRunToStoryRepo } = require(path.join(SCRIPTS, 'pipeline.js'));
  const project = repoTmp('proj-story-');
  const codeRepo = repoTmp('proj-code-');
  fs.mkdirSync(path.join(project, 'specs'), { recursive: true });
  const story = path.join(project, 'specs', '8-8.md');
  fs.writeFileSync(story, '---\nstory: "8.8"\n---\n');
  const runDir = path.join(codeRepo, '.advisors', 'pipeline-runs', '8.8-20260905120000');
  fs.mkdirSync(path.join(runDir, 'step-05-advisor-reports'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'review-roster.json'), '{"version":1}');
  fs.writeFileSync(path.join(runDir, 'findings.json'), '[]');
  fs.writeFileSync(path.join(runDir, 'step-05-advisor-reports', 'sec.md'), 'pesado');

  const r = projectRunToStoryRepo(runDir, story);
  const dest = path.join(project, '.advisors', 'pipeline-runs', '8.8-20260905120000');
  assert.equal(r.projected, true);
  assert.equal(r.dest, dest, 'mismo nombre de corrida, en el repo de la story');
  assert.ok(fs.existsSync(path.join(dest, 'review-roster.json')) && fs.existsSync(path.join(dest, 'findings.json')));
  assert.ok(!fs.existsSync(path.join(dest, 'step-05-advisor-reports')), 'los reportes pesados NO se proyectan');

  // Mismo repo → no hace nada (no se duplica el run dir sobre sí mismo).
  const mismo = projectRunToStoryRepo(runDir, path.join(codeRepo, 'specs-x.md'));
  fs.writeFileSync(path.join(codeRepo, 'specs-x.md'), '---\nstory: "9.9"\n---\n');
  assert.equal(projectRunToStoryRepo(runDir, path.join(codeRepo, 'specs-x.md')).projected, false);
  assert.equal(mismo.projected, false);

  // write-findings de verdad, con la story en otro repo: proyecta y lo dice.
  const out = JSON.parse(execFileSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'write-findings',
    '--story', story, '--repo', codeRepo, '--findings', '-'], { encoding: 'utf8', input: '[]' }));
  assert.ok(out.wrote && out.projected_to_story_repo, `write-findings proyecta al repo de la story: ${JSON.stringify(out)}`);
  assert.ok(fs.existsSync(path.join(out.projected_to_story_repo, 'findings.json')));

  for (const d of [project, codeRepo]) fs.rmSync(d, { recursive: true, force: true });
});

test('PipeC2_LaSondaRealLePreguntaAGit_NoDevuelveNullSiempre', () => {
  // 🔴 Los casos de arriba prueban `computeGitignoreNeeds` con una sonda escrita en el test; la sonda de
  //    PRODUCCIÓN (`gitIgnoraProbe`) se prueba aparte: si usara `execFileSync` sin requerirlo, tiraría
  //    ReferenceError adentro del try y devolvería `null` para TODO — o sea el preflight diría "no pude
  //    preguntarle a git" en cada repo y no tocaría ni avisaría nada.
  //    Un test que prueba el criterio con una sonda propia no prueba la sonda.
  const { gitIgnoraProbe } = require(path.join(SCRIPTS, 'pipeline.js'));
  const repo = repoTmp('pipe-c2-sonda-');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.dashboard/\n');
  const probe = gitIgnoraProbe(repo);
  assert.equal(probe('.dashboard/__sonda-pipe-c2__'), true, 'ignorada → true');
  assert.equal(probe('.advisors/pipeline-runs/__sonda-pipe-c2__'), false, 'no ignorada → false (NO null)');
  assert.equal(gitIgnoraProbe(path.join(repo, 'no-existe'))('x'), null, 'sin repo → null, que es lo único que significa "no pude"');
  fs.rmSync(repo, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Tres defectos que los tests de arriba no cazan, porque prueban el criterio con
// sondas propias y funciones nuevas, no el camino real. Cada caso reproduce el defecto.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test('Marker_PersisteEvidenceDir_YLoReseteaAlCambiarDeStory', () => {
  // 🔴 `cmdSet` preserva lo EXISTENTE (spread) y también tiene que tomar lo que trae el payload: si `start` manda
  //    `evidenceDir` y el marker sale sin él, la prosa promete un `get → evidenceDir` falso.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-evid-'));
  const SID = 'mk-evid';
  const set = (payload) => JSON.parse(execFileSync(process.execPath, [MARKER, 'set', JSON.stringify(payload)], markerEnv(SID, fakeHome)));
  const conDir = set({ storyId: 'A', storyPath: '/abs/a.md', repoPath: '/tmp/code', evidenceDir: '/tmp/specs/.advisors/dod-runtime', stepsPending: [0, 1, 2, 3] });
  assert.equal(conDir.evidenceDir, '/tmp/specs/.advisors/dod-runtime', 'set guarda evidenceDir');
  const get = JSON.parse(execFileSync(process.execPath, [MARKER, 'get'], markerEnv(SID, fakeHome)));
  assert.equal(get.evidenceDir, '/tmp/specs/.advisors/dod-runtime', 'y get lo devuelve');
  // set de la MISMA story sin el campo → se conserva (como cualquier otro campo de la corrida)
  assert.equal(set({ storyId: 'A', storyPath: '/abs/a.md' }).evidenceDir, '/tmp/specs/.advisors/dod-runtime');
  // set de OTRA story → se resetea: es estado de corrida, y la story B puede vivir en otro repo
  assert.equal(set({ storyId: 'B', storyPath: '/abs/b.md', stepsPending: [0, 1, 2, 3] }).evidenceDir, null, 'story nueva NO hereda el destino de la anterior');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('PipeC2_EsIdempotenteConSuPropioBloque_SondaReal', () => {
  // 🔴 La sonda de lo efímero no puede ser hijo DIRECTO de `pipeline-runs/`, que el bloque re-incluye: con el
  //    bloque puesto no estaría ignorada → "sin decisión" → el bloque se agregaría de nuevo en CADA start. Y por el
  //    mismo hueco viajarían archivos sueltos bajo `pipeline-runs/` (`timing-dump-*.json`). Se prueba con la sonda REAL.
  const { GITIGNORE_ADVISORS, computeGitignoreNeeds, gitIgnoraProbe } = require(path.join(SCRIPTS, 'pipeline.js'));
  const repo = repoTmp('pipe-c2-idem-');
  fs.writeFileSync(path.join(repo, '.gitignore'), GITIGNORE_ADVISORS.join('\n') + '\n.dashboard/\n');
  const r1 = computeGitignoreNeeds(gitIgnoraProbe(repo));
  assert.deepEqual(r1.append, [], `con el bloque puesto no se agrega nada: ${JSON.stringify(r1.append)}`);
  assert.deepEqual(r1.notices, [], `ni se avisa nada: ${JSON.stringify(r1.notices)}`);
  const ignora = gitIgnoraProbe(repo);
  assert.equal(ignora('.advisors/pipeline-runs/timing-dump-2026-06-18T2350.json'), true, 'un archivo suelto bajo pipeline-runs/ NO viaja');
  assert.equal(ignora('.advisors/pipeline-runs/8.8-20260905120000/review-roster.json'), false, 'el roster de una corrida sí');
  assert.equal(ignora('.advisors/pipeline-runs/8.8-20260905120000/advisor-context.md'), true, 'lo demás de la corrida no');
  // El bloque de la primera versión del día (sin las dos líneas del medio) tampoco se re-agrega:
  // la sonda a nieto lo lee como "ya decidió" (esos repos se corrigen por PR, no por append).
  const viejo = GITIGNORE_ADVISORS.filter((l) => l !== '**/.advisors/pipeline-runs/*' && l !== '!**/.advisors/pipeline-runs/*/');
  fs.writeFileSync(path.join(repo, '.gitignore'), viejo.join('\n') + '\n.dashboard/\n');
  assert.deepEqual(computeGitignoreNeeds(gitIgnoraProbe(repo)).append, [], 'el bloque viejo del mismo día tampoco se re-agrega');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('RosterProyectado_ElFrenoLocalDelRepoDeLaStoryLoAcepta', () => {
  // 🔴 Al commitear el `done` en el repo de la story, `revisarRosterLocal` no puede cruzar el roster contra el
  //    ledger de spawns filtrando por repo = cwd (la story), porque los spawns están
  //    estampados con el repo del CÓDIGO → `sin-testigo`, exit 2, con el testigo en la misma máquina.
  const { projectRunToStoryRepo } = require(path.join(SCRIPTS, 'pipeline.js'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-proj-home-'));
  const project = repoTmp('roster-proj-story-');
  const code = repoTmp('roster-proj-code-');
  const runsDir = path.join(fakeHome, '.claude', '.tycon-pipeline', 'advisor-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const spawns = [
    { ts: '2026-09-05T20:00:00.000Z', advisor: 'tycon-plugin-security-basics', model: 'opus', repo: code, story: '8.8' },
    { ts: '2026-09-05T20:00:01.000Z', advisor: 'tycon-plugin-react-conventions', model: 'sonnet', repo: code, story: '8.8' },
  ];
  fs.writeFileSync(path.join(runsDir, 'sid-x.jsonl'), spawns.map((s) => JSON.stringify(s)).join('\n') + '\n');
  const runDir = path.join(code, '.advisors', 'pipeline-runs', '8.8-20260905200000');
  fs.mkdirSync(runDir, { recursive: true });
  const rlib = require(path.join(SCRIPTS, 'lib', 'review-roster.js'));
  rlib.write(runDir, { lines: spawns, story: '8.8', sessionId: 'sid-x', headSha: 'abc1234' });
  fs.writeFileSync(path.join(runDir, 'findings.json'), '[]\n');
  fs.mkdirSync(path.join(project, 'specs'), { recursive: true });
  const story = path.join(project, 'specs', '8-8.md');
  fs.writeFileSync(story, '---\nstory: "8.8"\nstatus: review\n---\n');
  const pr = projectRunToStoryRepo(runDir, story);
  assert.equal(pr.projected, true);
  const proyectado = JSON.parse(fs.readFileSync(path.join(pr.dest, 'review-roster.json'), 'utf8'));
  assert.equal(proyectado.projected_from && proyectado.projected_from.repo, code, 'el roster proyectado dice de dónde viene');

  // El freno REAL, en un proceso con el HOME falso (el ledger vive bajo ~/.claude/.tycon-pipeline).
  const freno = (cwd) => JSON.parse(execFileSync(process.execPath, ['-e',
    `const r = require(${JSON.stringify(path.join(SCRIPTS, 'on-pre-commit.js'))}).revisarRosterLocal(${JSON.stringify(cwd)}, '8.8'); process.stdout.write(JSON.stringify(r));`],
  { encoding: 'utf8', env: { ...process.env, HOME: fakeHome } }));
  assert.equal(freno(project), null, `en el repo de la story el roster proyectado PASA: ${JSON.stringify(freno(project))}`);
  assert.equal(freno(code), null, 'y en el repo del código sigue pasando como siempre');
  // El mismo roster SIN la anotación → sin-testigo.
  delete proyectado.projected_from;
  fs.writeFileSync(path.join(pr.dest, 'review-roster.json'), JSON.stringify(proyectado));
  const sin = freno(project);
  assert.equal(sin && sin.reason, 'sin-testigo', 'sin la anotación el freno no encuentra el testigo (era el defecto)');
  for (const d of [fakeHome, project, code]) fs.rmSync(d, { recursive: true, force: true });
});


// ── UNA definición de «evidencia de cierre» para las cuatro capas ─────────────────────────────
// Si el freno del Edit aceptara cualquier `<id>-*.md` — matriz y self-audit incluidos — mientras el del
// commit y el portón de CI los excluyen, una story podría pasar el Edit, figurar «cubierta» en el
// tablero, y rebotar en el commit y en el pull request. Por eso los cuatro importan el mismo criterio
// (`lib/closing-evidence.js`; el portón lleva una copia con test de paridad).
// 🔴 `hasDodEvidence` con un directorio que SOLO tiene la matriz tiene que devolver false.
test('hasDodEvidence: la matriz por AC sola NO es evidencia de cierre (mismo criterio que el commit y el portón)', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dodev-matriz-'));
  const dod = path.join(ws, '.advisors', 'dod-runtime');
  fs.mkdirSync(dod, { recursive: true });
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dod, '7.7-runtime-matrix.md'), '| AC | evidencia |\n| 1 | (sin evidencia) |\n');
  fs.writeFileSync(path.join(dod, '7.7-self-audit-iter2.md'), '# self audit\n');
  fs.writeFileSync(path.join(dod, '7.7-manual-test-plan.md'), '# plan\n');
  assert.equal(ofwHook.hasDodEvidence([ws], '7.7'), false,
    'matriz + self-audit + plan manual: ninguno es la prueba, los tres son la declaración');
  fs.writeFileSync(path.join(dod, '7.7-dod-runtime-checker.md'), '# DoD runtime\nAC #1 ✅\n');
  assert.equal(ofwHook.hasDodEvidence([ws], '7.7'), true, 'con el informe de cierre real, sí');
  // y el ledger de smokes SOLO también alcanza
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dodev-ledger-'));
  fs.mkdirSync(path.join(ws2, '.advisors', 'dod-runtime'), { recursive: true });
  fs.mkdirSync(path.join(ws2, '.git'), { recursive: true });
  fs.writeFileSync(path.join(ws2, '.advisors', 'dod-runtime', '7.8-smoke-ledger.jsonl'), '{"story":"7.8","acs":[1],"exit":0}\n');
  assert.equal(ofwHook.hasDodEvidence([ws2], '7.8'), true, '64 pruebas anotadas por la máquina son evidencia, aunque nadie haya redactado el informe');
  fs.rmSync(ws2, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

test('las dos capas del skill (Edit y commit) deciden con la MISMA función', () => {
  const lib = require(path.join(SCRIPTS, 'lib', 'closing-evidence.js'));
  for (const [f, esperado] of [
    ['1.1-runtime-matrix.md', false], ['1.1-self-audit.md', false], ['1.1-self-audit-iter3.md', false],
    ['1.1-manual-test-plan.md', false],
    // 🔴 El ledger de smokes CUENTA: es el registro crudo de cada
    // prueba que corrió con su resultado — más difícil de falsear que un informe redactado.
    ['1.1-smoke-ledger.jsonl', true], ['1.1-smoke-driver.mjs', false],
    ['1.1-2026-08-31T10-00-00Z.md', true], ['1.1-dod-runtime-checker.md', true], ['1.1-e2e-gate-20260831T100000Z.md', true],
  ]) {
    assert.equal(lib.esEvidenciaDeCierre(f), esperado, f);
  }
});

// ── El gate de evidencia elige por cuánto DOCUMENTA, no por orden alfabético ──────────────────
// `findDodEvidence` no elige el nombre lexicográficamente mayor, y `parseAcsFromEvidence` entiende más que
// `AC #N`: dos generadores del mismo pipeline escriben tags distintos (el gate E2E escribe `@ac-N`). Con
// `e2e-gate-` (letra e) y `full-dod-runtime-` (letra f) compitiendo contra un
// timestamp, ganaría el que cayera — y si ganara el de `@ac-N`, el gate leería 0 criterios y
// bloquearía un commit legítimo.
// 🔴 (1) `@ac-3` se reconoce; (2) con dos candidatos, no gana el alfabético.
test('parseAcsFromEvidence entiende también los tags @ac-N del gate E2E', () => {
  const acs = opcHook.parseAcsFromEvidence('## Tests corridos\n- login @story-m-10 @ac-1 @ac-3\n- AC #2 ok\n');
  assert.deepEqual(acs.sort(), ['#1', '#2', '#3'], `dio ${JSON.stringify(acs)}`);
});

test('findDodEvidence elige el candidato que documenta MÁS criterios, no el de nombre mayor', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dodev-lex-'));
  const dod = path.join(ws, '.advisors', 'dod-runtime');
  fs.mkdirSync(dod, { recursive: true }); fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  // 🔴 El nombre que compite es `full-dod-runtime-` (letra f), que gana alfabéticamente sobre
  // `e2e-gate-` (letra e)... y documenta 1. Con el timestamp plano (dígito), que pierde alfabéticamente contra
  // `e2e-gate-`, un código con orden alfabético también elegiría bien y el test no reproduciría nada.
  fs.writeFileSync(path.join(dod, 'M-10-full-dod-runtime-20260827T001549Z.md'), 'AC #1 ✅\n');
  // ...mientras el gate E2E documenta 9, pero en `@ac-N`
  fs.writeFileSync(path.join(dod, 'M-10-e2e-gate-20260827T001549Z.md'),
    '## Tests corridos\n' + [1,2,3,4,5,6,7,8,9].map((n) => `- t${n} @story-m-10 @ac-${n}`).join('\n') + '\n');
  const best = opcHook.findDodEvidence(ws, 'M-10');
  assert.ok(best, 'tiene que encontrar evidencia');
  assert.equal(best.filename, 'M-10-e2e-gate-20260827T001549Z.md',
    `eligió ${best.filename}: el que documenta 9 criterios pierde contra el que documenta 1 por una letra`);
  assert.equal(opcHook.parseAcsFromEvidence(best.content).length, 9);
  fs.rmSync(ws, { recursive: true, force: true });
});

// 🔴 Una corrida FALLIDA no compite: sin esto, la
// narrativa de enero con verdict=FAIL y cinco «AC #N ❌» le gana a la de junio con tres ✅.
test('findDodEvidence: una evidencia vieja y FALLIDA con más ACs no le gana a la real y nueva', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dodev-fail-'));
  const dod = path.join(ws, '.advisors', 'dod-runtime');
  fs.mkdirSync(dod, { recursive: true }); fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dod, '7.1-20260101T000000Z.md'), '# DoD\nverdict=FAIL\nAC #1 ❌\nAC #2 ❌\nAC #3 ❌\nAC #4 ❌\nAC #5 ❌\n');
  fs.writeFileSync(path.join(dod, '7.1-20260601T000000Z.md'), '# DoD\n- verdict: PASS\nAC #1 ✅\nAC #2 ✅\nAC #3 ✅\n');
  const best = opcHook.findDodEvidence(ws, '7.1');
  assert.equal(best.filename, '7.1-20260601T000000Z.md', `eligió ${best.filename}: la corrida fallida no compite`);
  assert.equal(best.fallido, false);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('findDodEvidence: si la ÚNICA evidencia declara FAIL, se devuelve marcada como fallida', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dodev-onlyfail-'));
  const dod = path.join(ws, '.advisors', 'dod-runtime');
  fs.mkdirSync(dod, { recursive: true }); fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dod, '7.1-e2e-gate-20260101T000000Z.md'), '# E2E Gate\n\nverdict=FAIL\n- @story-7-1 @ac-1 uno\n');
  const best = opcHook.findDodEvidence(ws, '7.1');
  assert.equal(best.fallido, true);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('evidenciaDeclaraFail entiende los tres formatos del pipeline y no se confunde con prosa', () => {
  assert.equal(opcHook.evidenciaDeclaraFail('verdict=FAIL\n'), true, 'gate E2E');
  assert.equal(opcHook.evidenciaDeclaraFail('- VERDICT: **FAIL**\n'), true, 'narrativa en negrita');
  assert.equal(opcHook.evidenciaDeclaraFail('## Verdict global\n\nFAIL\n'), true, 'sección final');
  assert.equal(opcHook.evidenciaDeclaraFail('- VERDICT: PASS\n- ASSERT FAIL: x esperado y\n'), false, 'un assert fallido dentro de un PASS no es el veredicto');
  assert.equal(opcHook.evidenciaDeclaraFail('si el verdict fuera FAIL habría que…'), false, 'prosa');
});

test('findDodEvidence: a igual cantidad de criterios, gana el más reciente por fecha real', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dodev-mtime-'));
  const dod = path.join(ws, '.advisors', 'dod-runtime');
  fs.mkdirSync(dod, { recursive: true }); fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  const viejo = path.join(dod, 'M-10-zzz-viejo.md'), nuevo = path.join(dod, 'M-10-aaa-nuevo.md');
  fs.writeFileSync(viejo, 'AC #1 ✅\n'); fs.writeFileSync(nuevo, 'AC #1 ✅\n');
  const t0 = new Date('2026-01-01T00:00:00Z'), t1 = new Date('2026-06-01T00:00:00Z');
  fs.utimesSync(viejo, t0, t0); fs.utimesSync(nuevo, t1, t1);
  assert.equal(opcHook.findDodEvidence(ws, 'M-10').filename, 'M-10-aaa-nuevo.md', 'el nombre «zzz» no puede ganarle a la fecha');
  fs.rmSync(ws, { recursive: true, force: true });
});

// ── `review → done` también se juzga — AVISANDO, hasta que se decida frenar ─────────────────
// `isCriticalStatusTransition` considera crítica no sólo la ENTRADA a {review, done} desde afuera sino también
// `review → done`: si no, esa transición no dispara advisors, ni roster, ni evidencia — el hook sale 0 y mudo aunque
// el roster esté mal. En los repos de producto lo tapa el portón del pull request; en
// el arnés no lo tapa nadie. Entra avisando hasta que se decida frenar (contra el historial frenaría el 100 %,
// porque el roster y la proyección de evidencia tienen días), y con TYCON_REVIEW_A_DONE=block pasa a bloquear.
// 🔴 El hook no puede salir 0 sin una palabra ante `review → done` sin evidencia ni revisores.
function repoConTransicion(desde, hasta) {
  const { execFileSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rad-home-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  const story = (st) => `---\nstory: "7.1"\nepic: "7"\nstatus: ${st}\ntests_pending_runtime:\n  - E1\n---\n\n# Story 7.1\n\n## Acceptance Criteria\n1. algo\n\n## Tests\n| E1 | Playwright | login |\n`;
  fs.writeFileSync(path.join(repo, 'specs', 'story-7.1.md'), story(desde));
  g('add', '-A'); g('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(repo, 'specs', 'story-7.1.md'), story(hasta));
  g('add', '-A');
  return { home, repo };
}
function correrHook(f, env) {
  const { spawnSync } = require('node:child_process');
  return spawnSync(process.execPath, [path.join(SCRIPTS, 'on-pre-commit.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'rad-s1', cwd: f.repo,
      tool_input: { command: 'git commit -m "cierra"' } }),
    env: { ...process.env, HOME: f.home, ...(env || {}) }, cwd: f.repo, encoding: 'utf8',
  });
}

test('review → done sin evidencia ni revisores: AVISA por stderr y deja pasar (default)', () => {
  const f = repoConTransicion('review', 'done');
  const r = correrHook(f);
  assert.equal(r.status, 0, `en modo aviso no bloquea (stderr: ${(r.stderr || '').slice(0, 200)})`);
  assert.match(r.stderr || '', /review → done|review -> done/, 'dice que es la transición interna la que está juzgando');
  assert.match(r.stderr || '', /7\.1/, 'nombra la story');
  const gl = fs.readFileSync(path.join(f.home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8');
  assert.match(gl, /"name":"review-a-done"/, 'queda medido en gates.log');
  assert.match(gl, /"action":"warn"/);
  fs.rmSync(f.home, { recursive: true, force: true });
});

test('review → done con TYCON_REVIEW_A_DONE=block: BLOQUEA como una transición crítica (y el valor de antes de la story 8.9 sigue valiendo)', () => {
  // `block` es el valor vigente; el valor viejo sigue frenando hasta el retiro
  for (const valor of ['block', 'freno']) {
    const f = repoConTransicion('review', 'done');
    const r = correrHook(f, { TYCON_REVIEW_A_DONE: valor });
    assert.equal(r.status, 2, `con TYCON_REVIEW_A_DONE=${valor} bloquea (stderr: ${(r.stderr || '').slice(0, 200)})`);
    fs.rmSync(f.home, { recursive: true, force: true });
  }
  // cualquier otro valor no frena: sigue avisando
  const f = repoConTransicion('review', 'done');
  assert.equal(correrHook(f, { TYCON_REVIEW_A_DONE: '1' }).status, 0, 'un valor que no es block no frena');
  fs.rmSync(f.home, { recursive: true, force: true });
});

// El valor viejo frena igual, pero el hook tiene que anotar el uso: el registro es lo que decide el retiro del nombre viejo.
// Con `freno`, el registro de usos de la HOME no puede quedar vacío. Necesita el arnés (es quien anota): sin él, se dice.
test('el valor de antes en las dos llaves del portón frena Y se anota el uso; `block` no anota nada', (t) => {
  const arnes = process.env.TYCON_GUIDES_DIR;
  if (!arnes || !fs.existsSync(path.join(arnes, 'scripts', 'lib', 'legacy-names.js')) || !fs.existsSync(path.join(arnes, 'scripts', 'install-tycon-hooks.sh'))) {
    t.skip('NO MEDIDO — sin TYCON_GUIDES_DIR apuntando a un arnés: el uso lo anota la biblioteca del arnés');
    return;
  }
  const usos = (home) => {
    const fl = path.join(home, '.claude', '.tycon-pipeline', 'legacy-names.jsonl');
    return fs.existsSync(fl) ? fs.readFileSync(fl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  // cada llave en el caso que la lee: la transición review → done, y un registro de revisores que no cuadra
  const casos = [
    ['TYCON_REVIEW_A_DONE', () => repoConTransicion('review', 'done'), correrHook],
    ['TYCON_ROSTER_NAMES', () => repoConRosterYFindings({ reviewers: ['tycon-plugin-security-basics'], firmantes: ['tycon-plugin-security-basics', 'tycon-fantasma'] }), hook713],
  ];
  for (const [llave, armar, correr] of casos) {
    for (const [valor, anota] of [['freno', true], ['block', false]]) {
      const f = armar();
      assert.equal(correr(f, { [llave]: valor, TYCON_GUIDES_DIR: arnes }).status, 2, `${llave}=${valor} frena`);
      const u = usos(f.home).filter((x) => x.kind === 'value' && x.old === 'freno' && x.new === 'block');
      assert.equal(u.length > 0, anota, `${llave}=${valor}: ${anota ? 'se anota el uso' : 'no anota nada'} — ${JSON.stringify(usos(f.home))}`);
      fs.rmSync(f.home, { recursive: true, force: true });
    }
  }
});

// 🔴 La ventana de medición vence SOLA: la fecha «revisar el 20/09» no puede vivir sólo en una ficha del inbox
// donde nada la mira. El propio aviso trae cuántas veces habló y, pasado el día, exige la decisión; sin eso
// no traería ni la cuenta ni la fecha, con TYCON_TODAY después del 20 o sin él.
test('review → done antes del vencimiento: el aviso trae la cuenta y la fecha en que se decide', () => {
  const f = repoConTransicion('review', 'done');
  const gl = path.join(f.home, '.claude', '.tycon-pipeline', 'gates.log');
  fs.mkdirSync(path.dirname(gl), { recursive: true });
  fs.writeFileSync(gl, ['{"name":"review-a-done","action":"warn","storyId":"1.1"}', '{"name":"review-a-done","action":"warn","storyId":"2.2"}', '{"name":"otro","action":"warn"}'].join('\n') + '\n');
  const r = correrHook(f, { TYCON_TODAY: '2026-09-15' });
  assert.equal(r.status, 0);
  assert.match(r.stderr || '', /Van 2 aviso\(s\)/, 'cuenta sólo los review-a-done previos, no otras líneas');
  assert.match(r.stderr || '', /2026-09-20/, 'dice cuándo se decide');
  assert.doesNotMatch(r.stderr || '', /VENCIÓ/);
  fs.rmSync(f.home, { recursive: true, force: true });
});

test('review → done después del vencimiento: el aviso dice que VENCIÓ, cuánto habló y qué decidir', () => {
  const f = repoConTransicion('review', 'done');
  const gl = path.join(f.home, '.claude', '.tycon-pipeline', 'gates.log');
  fs.mkdirSync(path.dirname(gl), { recursive: true });
  fs.writeFileSync(gl, '{"name":"review-a-done","action":"warn","storyId":"1.1"}\n');
  const r = correrHook(f, { TYCON_TODAY: '2026-09-21' });
  assert.equal(r.status, 0, 'sigue sin frenar: la decisión es del dev, no del calendario');
  assert.match(r.stderr || '', /VENCIÓ el 2026-09-20/);
  assert.match(r.stderr || '', /habló 1 vez/);
  assert.match(r.stderr || '', /TYCON_REVIEW_A_DONE=block/, 'nombra la decisión que hay que tomar');
  fs.rmSync(f.home, { recursive: true, force: true });
});

test('review → done sin gates.log previo: la cuenta arranca en 0 y no revienta', () => {
  const f = repoConTransicion('review', 'done');
  const r = correrHook(f, { TYCON_TODAY: '2026-09-15' });
  assert.equal(r.status, 0);
  assert.match(r.stderr || '', /Van 0 aviso\(s\)/);
  fs.rmSync(f.home, { recursive: true, force: true });
});

// 🔴 El «sólo aviso» no puede marcarse por spec ANTES de calcular la transición de pipelines: si no,
// `review → done` + `pipelines.X: in-progress → done` en el mismo commit —la última tanda de una story entregada
// en tandas— bajaría a aviso también la violación del Trigger 2, que bloquea sola.
// Tiene que dar exit 2, no exit 0 con «⚠️ AVISO».
function repoConTransicionYPipelines(desde, hasta, pipeDesde, pipeHasta) {
  const { execFileSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rad-pipe-home-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  const story = (st, ps) => `---\nstory: "7.2"\nepic: "7"\nstatus: ${st}\npipelines:\n  entrega-2:\n    status: ${ps}\ntests_pending_runtime:\n  - E1\n---\n\n# Story 7.2\n\n## Acceptance Criteria\n1. algo\n\n## Tests\n| E1 | Playwright | login |\n`;
  fs.writeFileSync(path.join(repo, 'specs', 'story-7.2.md'), story(desde, pipeDesde));
  g('add', '-A'); g('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(repo, 'specs', 'story-7.2.md'), story(hasta, pipeHasta));
  g('add', '-A');
  return { home, repo };
}

test('review → done + pipelines.X → done en el mismo commit, sin evidencia: BLOQUEA (el Trigger 2 no baja a aviso)', () => {
  const f = repoConTransicionYPipelines('review', 'done', 'in-progress', 'done');
  const r = correrHook(f, { TYCON_ADVISORS_GATE: 'off' });   // aislar: que llegue al Trigger 2
  assert.equal(r.status, 2, `la transición de pipelines bloqueaba sola y tiene que seguir bloqueando (stderr: ${(r.stderr || '').slice(0, 300)})`);
  assert.match(r.stderr || '', /pipelines/, 'nombra la transición de pipelines como motivo');
  fs.rmSync(f.home, { recursive: true, force: true });
});

test('review → done + pipelines.X → done, con el gate de advisors prendido: también BLOQUEA', () => {
  const f = repoConTransicionYPipelines('review', 'done', 'in-progress', 'done');
  const r = correrHook(f);
  assert.equal(r.status, 2, `stderr: ${(r.stderr || '').slice(0, 300)}`);
  fs.rmSync(f.home, { recursive: true, force: true });
});

test('review → done con el bloque pipelines QUIETO: sigue siendo sólo aviso (la intención se preserva)', () => {
  const f = repoConTransicionYPipelines('review', 'done', 'done', 'done');
  const r = correrHook(f);
  assert.equal(r.status, 0, `sin transición de pipelines es la interna pura: aviso (stderr: ${(r.stderr || '').slice(0, 300)})`);
  assert.match(r.stderr || '', /AVISO/);
  fs.rmSync(f.home, { recursive: true, force: true });
});

test('in-progress → done sigue siendo crítica y bloquea, con o sin la variable', () => {
  const f = repoConTransicion('in-progress', 'done');
  const r = correrHook(f);
  assert.equal(r.status, 2, 'la entrada a done desde afuera no cambió');
  fs.rmSync(f.home, { recursive: true, force: true });
});

// ── Las vueltas MANUALES de revisores también cuentan ───────────────────────────────────────
// 🔴 Una story con 5 vueltas de revisores (16 invocaciones, documentadas en su reporte consolidado) daría la
// métrica `advisor_rerun_loop_iterations` = 2 si las vueltas 3, 4 y 5 fueran re-invocaciones manuales de dos o
// tres revisores puntuales después del pase adversarial: como nunca completan una ronda formal, no dejarían
// rastro.
test('vuelta manual: después del sello, el primer revisor abre la vuelta N.1', () => {
  const { vueltaManual } = require(path.join(SCRIPTS, 'lib', 'advisor-round.js'));
  const t = (s) => `2026-09-06T10:${s}:00.000Z`;
  const base = [
    L({ event: 'step5-start', expected: ['a', 'b'], iter: 2 }),
    L({ ts: t('00'), advisor: 'a', story: '1.1' }), L({ ts: t('00'), advisor: 'b', story: '1.1' }),
    L({ event: 'auto-snapshot', iter: 2 }),
  ];
  const r = vueltaManual([...base, L({ ts: t('20'), advisor: 'a', story: '1.1' })]);
  assert.deepEqual(r, { abre: true, iter: '2.1', k: 1 });
  // 🔴 sólo los revisores de la ronda abren vueltas: el capturador, el DoD checker y el validador de OTRA story no
  assert.equal(vueltaManual([...base, L({ ts: t('20'), advisor: 'tycon-retrospective-capturer', story: null })]).abre, false, 'el capturador no es una vuelta');
  assert.equal(vueltaManual([...base, L({ ts: t('20'), advisor: 'tycon-dod-runtime-checker', story: '1.1' })]).abre, false, 'el DoD checker del 7c no es una vuelta');
  // un revisor que NO estuvo en la ronda formal (un especialista que entró después) SÍ abre ([13])
  assert.deepEqual(vueltaManual([...base, L({ ts: t('20'), advisor: 'worker-lifecycle-reviewer', story: '1.1' })]), { abre: true, iter: '2.1', k: 1 }, 'un especialista fuera del expected también es una vuelta');
  // un chequeador que corrió DENTRO de la ventana formal sigue sin ser revisor ([18])
  const conChequeador = [base[0], base[1], L({ ts: t('00'), advisor: 'tycon-ac-coverage-checker', story: '1.1' }), base[2], base[3]];
  assert.equal(vueltaManual([...conChequeador, L({ ts: t('20'), advisor: 'tycon-ac-coverage-checker', story: '1.1' })]).abre, false, 'haber corrido en la ronda no lo vuelve revisor');
  assert.equal(vueltaManual([...base, L({ ts: t('20'), advisor: 'a', story: '9.9' })]).abre, false, 'otra story no es esta ronda');
  assert.equal(vueltaManual([...base, L({ ts: t('20'), advisor: 'a', story: null })]).abre, false, 'sin story atribuida tampoco (crítico D6)');
  // sin el sello, la ronda sigue siendo la formal: no hay vuelta manual
  const sinSello = vueltaManual(base.slice(0, 3).concat([L({ ts: t('20'), advisor: 'a', story: '1.1' })]));
  assert.equal(sinSello.abre, false);
  // un agente de exploración no es un revisor
  assert.equal(vueltaManual([...base, L({ ts: t('20'), advisor: 'Explore', story: '1.1' })]).abre, false);
});

test('vuelta manual: otro revisor se SUMA a la vuelta abierta; el MISMO revisor de nuevo la cierra y abre N.2', () => {
  const { vueltaManual } = require(path.join(SCRIPTS, 'lib', 'advisor-round.js'));
  const t = (s) => `2026-09-06T10:${s}:00.000Z`;
  const base = [
    L({ event: 'step5-start', expected: ['a', 'b'], iter: 2 }),
    L({ ts: t('00'), advisor: 'a', story: '1.1' }), L({ ts: t('00'), advisor: 'b', story: '1.1' }),
    L({ event: 'auto-snapshot', iter: 2 }),
    L({ ts: t('20'), advisor: 'a', story: '1.1' }), L({ event: 'manual-iter', iter: '2.1' }),
  ];
  const suma = vueltaManual([...base, L({ ts: t('21'), advisor: 'b', story: '1.1' })]);
  assert.equal(suma.abre, false, 'b es otro revisor: misma vuelta 2.1');
  assert.equal(suma.iter, '2.1');
  const repite = vueltaManual([...base, L({ ts: t('21'), advisor: 'b', story: '1.1' }), L({ ts: t('35'), advisor: 'a', story: '1.1' })]);
  assert.deepEqual(repite, { abre: true, iter: '2.2', k: 2 }, 'a vuelve a correr 15 min después: vuelta nueva');
  // dentro de la ventana de fan-out (90 s) el mismo revisor es paralelismo, no una vuelta
  const fanout = vueltaManual([...base, L({ ts: '2026-09-06T10:20:30.000Z', advisor: 'a', story: '1.1' })]);
  assert.equal(fanout.abre, false, 'a otra vez a los 30 s: fan-out, no vuelta');
  // una story distinta no abre ni cierra nada acá
  const otra = vueltaManual([...base, L({ ts: t('35'), advisor: 'a', story: '9.9' })]);
  assert.equal(otra.abre, false);
  // un re-loop formal nuevo resetea: hasta su sello no hay vueltas manuales
  const reloop = vueltaManual([...base, L({ event: 'step5-start', expected: ['a'], iter: 3 }), L({ ts: t('40'), advisor: 'a', story: '1.1' })]);
  assert.equal(reloop.abre, false);
});

test('vuelta manual: el hook REAL sella manual-iter en el ledger y escribe advisors-iter manual en gates.log', () => {
  const { sessionIdFileKey } = require(path.join(SCRIPTS, 'lib', 'session-id.js'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vuelta-manual-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vuelta-repo-'));
  require('node:child_process').execFileSync('git', ['-C', repo, 'init', '-q']);
  const sid = 'sesion-vuelta-manual';
  const dirLedger = path.join(home, '.claude', '.tycon-pipeline', 'advisor-runs');
  fs.mkdirSync(dirLedger, { recursive: true });
  const ledger = path.join(dirLedger, `${sessionIdFileKey(sid)}.jsonl`);
  fs.writeFileSync(ledger, [
    L({ event: 'step5-start', expected: ['tycon-plugin-security-basics'], iter: 1 }),
    L({ ts: '2026-09-06T10:00:00.000Z', advisor: 'tycon-plugin-security-basics', story: null, repo }),
    L({ event: 'auto-snapshot', iter: 1 }),
  ].join('\n') + '\n');
  const payload = JSON.stringify({ tool_name: 'Task', session_id: sid, cwd: repo, tool_input: { subagent_type: 'tycon-plugin-security-basics', prompt: 'revisá de nuevo el candado' } });
  const r = require('node:child_process').spawnSync(process.execPath, [path.join(SCRIPTS, 'on-advisor-run.js')], {
    input: payload, encoding: 'utf8', env: { ...process.env, HOME: home, TYCON_SPAWN_GOVERNANCE: '0' },
  });
  assert.equal(r.status, 0, r.stderr);
  const sellos = fs.readFileSync(ledger, 'utf8').split('\n').filter((l) => l.includes('"manual-iter"'));
  assert.equal(sellos.length, 1, 'un sello manual-iter en el ledger');
  assert.equal(JSON.parse(sellos[0]).iter, '1.1');
  // 🔴 el sello no es un spawn: summarize() cuenta 2 spawns reales, no 3 (#31)
  const { summarize } = require(path.join(SCRIPTS, 'lib', 'advisor-ledger.js'));
  assert.equal(summarize(fs.readFileSync(ledger, 'utf8'), sid).spawns, 2, 'el sello manual-iter no cuenta como spawn');
  const gates = fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const manual = gates.filter((g) => g.name === 'advisors-iter' && g.manual === true);
  assert.equal(manual.length, 1, 'una línea advisors-iter manual en gates.log');
  assert.equal(manual[0].iter, '1.1');
  assert.equal(manual[0].sessionId, sessionIdFileKey(sid));
  // 🔴 Con la foto apagada, tampoco se cuenta (mismo interruptor, declarado)
  const r2 = require('node:child_process').spawnSync(process.execPath, [path.join(SCRIPTS, 'on-advisor-run.js')], {
    input: payload, encoding: 'utf8', env: { ...process.env, HOME: home, TYCON_SPAWN_GOVERNANCE: '0', TYCON_AUTO_SNAPSHOT: '0' },
  });
  assert.equal(r2.status, 0);
  assert.equal(fs.readFileSync(ledger, 'utf8').split('\n').filter((l) => l.includes('"manual-iter"')).length, 1, 'apagado: no sella otra vuelta');
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

// ── La HORA DE ARRANQUE de cada paso ─────────────────────────────────────────────────────────────
// `complete-step` anota el arranque además del fin (`{completedAt}`): si anotara sólo el fin, la
// duración de un paso sería «del fin del anterior al fin de éste», y el tiempo muerto antes de
// empezar caería entero en el paso siguiente.
function markerDe27(home, sid, extra) {
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'r27-'));
  const story = path.join(repo, 'story.md');
  fs.writeFileSync(story, '---\nstory: "9.9"\nstatus: in-progress\n---\n# x\n');
  const m = {
    storyId: '9.9', storyPath: story, repoPath: repo, sessionId: sid,
    startedAt: '2026-09-16T10:00:00.000Z', lastTouch: '2026-09-16T10:00:00.000Z',
    stepsCompleted: [0], stepsPending: [1, 2, 3, 4, 5, 6, 7, 8], clockiStarted: true, adoMarkedActive: true,
    ...extra,
  };
  const file = path.join(dir, `${sid}.json`);
  fs.writeFileSync(file, JSON.stringify(m));
  return { file, repo };
}
const correr27 = (home, sid, script, args) => require('node:child_process').spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
  encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0' },
});

test('2.7 next anota el arranque del paso que devuelve y no lo mueve', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h27-'));
  const sid = 'next-arranque-27';
  const { file, repo } = markerDe27(home, sid);
  const r = correr27(home, sid, 'pipeline.js', ['next']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).next_step, 'validate-story');   // el paso viejo 1, por su nombre de máquina
  const m1 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(m1.stepTimings && m1.stepTimings['1'] && m1.stepTimings['1'].startedAt, 'next deja el arranque del paso 1');
  const t1 = m1.stepTimings['1'].startedAt;
  // una segunda consulta no lo mueve
  const r2 = correr27(home, sid, 'pipeline.js', ['next']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stepTimings['1'].startedAt, t1, 'la segunda consulta no mueve el arranque');
  // y no anota nada de los pasos que no devolvió
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).stepTimings).join(','), '1');
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

test('2.7 start-step y complete-step conservan el arranque', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h27b-'));
  const sid = 'start-step-27';
  const { file, repo } = markerDe27(home, sid);
  const r = correr27(home, sid, 'marker.js', ['start-step', '1']);
  assert.equal(r.status, 0, r.stderr);
  const t1 = JSON.parse(fs.readFileSync(file, 'utf8')).stepTimings['1'].startedAt;
  assert.ok(t1, 'start-step anota el arranque');
  // repetir no lo mueve
  assert.equal(correr27(home, sid, 'marker.js', ['start-step', '1']).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stepTimings['1'].startedAt, t1);
  // complete-step deja los dos campos
  const c = correr27(home, sid, 'marker.js', ['complete-step', '1']);
  assert.equal(c.status, 0, c.stderr);
  const st = JSON.parse(fs.readFileSync(file, 'utf8')).stepTimings['1'];
  assert.equal(st.startedAt, t1, 'complete-step NO pisa el arranque');
  assert.ok(st.completedAt, 'complete-step anota el fin');
  // un paso completo no se vuelve a arrancar
  assert.equal(correr27(home, sid, 'marker.js', ['start-step', '1']).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).stepTimings['1'], st, 'un paso completo no se re-arranca');
  // un número de paso inválido no escribe nada y sale ≠ 0
  const mal = correr27(home, sid, 'marker.js', ['start-step', 'x']);
  assert.notEqual(mal.status, 0);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

test('2.7 set preserva el arranque dentro de stepTimings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h27c-'));
  const sid = 'set-arranque-27';
  const { file, repo } = markerDe27(home, sid, { stepTimings: { 1: { startedAt: '2026-09-16T10:01:00.000Z', completedAt: '2026-09-16T10:05:00.000Z' } } });
  const r = correr27(home, sid, 'marker.js', ['set', JSON.stringify({ storyId: '9.9', storyPath: path.join(repo, 'story.md') })]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stepTimings['1'].startedAt, '2026-09-16T10:01:00.000Z');
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

test('2.7 timing-report muestra el arranque como evento propio: el hueco previo no queda dentro del paso', () => {
  // 🔴 Sin el evento `step-N-start`, el delta de `step-2-done` es 30 min (incluye 20 de
  //    hueco antes de arrancar); con él, el arranque parte ese tramo en 20 + 10.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h27d-'));
  const sid = 'timing-report-27';
  const { repo } = markerDe27(home, sid, {
    startedAt: '2026-09-16T10:00:00.000Z',
    stepsCompleted: [0, 1, 2],
    stepTimings: {
      1: { completedAt: '2026-09-16T10:10:00.000Z' },                                         // vieja: sin arranque
      2: { startedAt: '2026-09-16T10:30:00.000Z', completedAt: '2026-09-16T10:40:00.000Z' },  // medida
    },
  });
  const r = correr27(home, sid, 'pipeline.js', ['timing-report']);
  assert.equal(r.status, 0, r.stderr);
  const t = JSON.parse(r.stdout).timeline;
  const labels = t.map((e) => e.label);
  assert.deepEqual(labels, ['pipeline-start', 'step-1-done', 'step-2-start', 'step-2-done'], labels.join(','));
  assert.equal(t.find((e) => e.label === 'step-2-start').delta_min, 20, 'el hueco queda antes del arranque');
  assert.equal(t.find((e) => e.label === 'step-2-done').delta_min, 10, 'el paso dura lo que dura');
  assert.ok(!labels.includes('step-1-start'), 'un paso sin arranque no inventa uno');
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

test('2.7 cambiar de story en la misma sesión NO hereda los arranques de la anterior', () => {
  // 🔴 `set` tiene que resetear stepTimings: `anotarArranque` se niega si ya hay arranque, así que la story nueva
  //    heredaría los de la vieja y la cuenta los tomaría como medidos.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h27e-'));
  const sid = 'cambio-story-27';
  const { file, repo } = markerDe27(home, sid, { stepTimings: { 1: { startedAt: '2026-09-16T08:00:00.000Z', completedAt: '2026-09-16T08:10:00.000Z' } } });
  const r = correr27(home, sid, 'marker.js', ['set', JSON.stringify({ storyId: '9.10', storyPath: path.join(repo, 'story.md'), stepsPending: [0, 1, 2, 3, 4, 5, 6, 7, 8] }), '--replace']);
  assert.equal(r.status, 0, r.stderr);
  const st = JSON.parse(fs.readFileSync(file, 'utf8')).stepTimings || {};
  assert.ok(!st['1'], `no queda el paso 1 de la story anterior: ${JSON.stringify(st)}`);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

test('2.7 una corrida nueva nace con el arranque del paso 0, y complete-step 0 lo conserva', () => {
  // 🔴 `pipeline.js start` cierra el paso 0 sin arrancarlo y `next` no lo devuelve nunca → en toda corrida real el
  //    paso 0 saldría «estimado» y la corrida «parcial».
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h27f-'));
  const sid = 'paso0-27';
  fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'r27f-'));
  fs.writeFileSync(path.join(repo, 'story.md'), '---\nstory: "9.11"\nstatus: in-progress\n---\n');
  const r = correr27(home, sid, 'marker.js', ['set', JSON.stringify({ storyId: '9.11', storyPath: path.join(repo, 'story.md'), repoPath: repo, stepsPending: [0, 1, 2, 3, 4, 5, 6, 7, 8] })]);
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(home, '.claude', '.tycon-pipeline', 'active', `${sid}.json`);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(m.stepTimings && m.stepTimings['0'] && m.stepTimings['0'].startedAt, `paso 0 con arranque: ${JSON.stringify(m.stepTimings)}`);
  assert.equal(correr27(home, sid, 'marker.js', ['complete-step', '0']).status, 0);
  const st0 = JSON.parse(fs.readFileSync(file, 'utf8')).stepTimings['0'];
  assert.equal(st0.startedAt, m.stepTimings['0'].startedAt);
  assert.ok(st0.completedAt);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

test('2.7 los sub-pasos (0b, 0c, 5b, 7c) también anotan su arranque', () => {
  // 🔴 Si `next` sólo anotara pasos enteros, los ~30 min del pase
  //    adversarial (5b) caerían como «tiempo entre pasos», fuera del trabajo.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h27g-'));
  const sid = 'subpasos-27';
  const { file, repo } = markerDe27(home, sid, { stepsCompleted: [0, 1, 2, 3, 4, 5], stepsPending: [6, 7, 8] });
  const r = correr27(home, sid, 'pipeline.js', ['next']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).next_step, 'adversarial-pass');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).stepTimings['5b'].startedAt, 'next anota el arranque del 5b (en el número viejo del marcador viejo)');
  assert.equal(correr27(home, sid, 'marker.js', ['start-step', 'live-check']).status, 0);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).stepTimings['7c'].startedAt, 'start-step live-check anota el 7c del marcador viejo');
  assert.notEqual(correr27(home, sid, 'marker.js', ['start-step', '5z']).status, 0, 'un paso inventado no');
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});


// ── promote-probe + el freno de mark-adversarial-result ─────────────────────────────────────
// El step-05b dice «agregá un test de regresión por cada bug confirmado»; si nada lo verifica, el
// verificador borra su prueba (p. ej. una de integración 200-donde-debía-403, perdida) y el pipeline sigue. Por eso
// la prueba guardada se promueve a la suite con
// `promote-probe`, y el pase no se anota sin que cada confirmado tenga prueba o motivo de diferido.
function repoConProbe(fakeHome, sid) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-repo-'));
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  const probeDir = path.join(repo, '.advisors', 'pipeline-runs', 'A-x', 'step-05b-probes', 'false-negative-classification-1');
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(path.join(probeDir, 'ZZProbeRutas.cs.txt'), '// prueba: espera 403, recibe 200\n');
  fs.writeFileSync(path.join(probeDir, 'COMO-SE-CORRIO.txt'), 'dotnet test --filter …\n');
  writeFakeMarker(fakeHome, sid, { repoPath: repo });
  return { repo, probeDir };
}

test('promote-probe: copia la prueba guardada a la suite y la anota en el marker (no en gates.log)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  const SID = 'pp-ok';
  const { repo, probeDir } = repoConProbe(fakeHome, SID);
  const r = JSON.parse(execFileSync(process.execPath, [MARKER, 'promote-probe', probeDir, '--file', 'ZZProbeRutas.cs.txt', '--a', 'tests/PermisosDeEntregaTests.cs'], markerEnv(SID, fakeHome)));
  assert.equal(r.dest, 'tests/PermisosDeEntregaTests.cs');
  assert.equal(r.promovidas, 1);
  assert.equal(fs.readFileSync(path.join(repo, 'tests', 'PermisosDeEntregaTests.cs'), 'utf8'), '// prueba: espera 403, recibe 200\n', 'mismo contenido, sin el .txt');
  const m = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'active', `${SID}.json`), 'utf8'));
  assert.equal(m.adversarialRegressions.length, 1);
  assert.equal(gatesLines(fakeHome).length, 0, 'promover NO es evaluar un control: nada en gates.log (el tablero lo contaría como control sin estado)');
  fs.rmSync(fakeHome, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

test('promote-probe se niega: fuera del repo, nombre de probe (invisible para el pipeline), destino existente, origen ausente', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mal-'));
  const SID = 'pp-mal';
  const { repo, probeDir } = repoConProbe(fakeHome, SID);
  fs.writeFileSync(path.join(repo, 'tests', 'Existente.cs'), 'x');
  for (const [a, dest] of [
    ['ZZProbeRutas.cs.txt', '../afuera/T.cs'],
    ['ZZProbeRutas.cs.txt', 'tests/ZZProbeRutas.cs'],
    ['ZZProbeRutas.cs.txt', 'tests/__probe_x.test.ts'],
    ['ZZProbeRutas.cs.txt', 'tests/Existente.cs'],
    ['NoExiste.cs.txt', 'tests/Nuevo.cs'],
  ]) {
    assert.throws(
      () => execFileSync(process.execPath, [MARKER, 'promote-probe', probeDir, '--file', a, '--a', dest], { ...markerEnv(SID, fakeHome), stdio: 'pipe' }),
      (e) => e.status === 2, `${a} → ${dest} debe salir 2`,
    );
  }
  assert.ok(!fs.existsSync(path.join(repo, 'tests', 'ZZProbeRutas.cs')), 'nada escrito');
  assert.equal(fs.readFileSync(path.join(repo, 'tests', 'Existente.cs'), 'utf8'), 'x', 'el existente no se pisa');
  assert.equal(gatesLines(fakeHome).length, 0);
  fs.rmSync(fakeHome, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

test('mark-adversarial-result con confirmados exige pruebas + diferidos = N, motivo si difiere, y cuenta lo PROMOVIDO', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gate-'));
  const SID = 'pp-gate';
  const { repo, probeDir } = repoConProbe(fakeHome, SID);
  const malos = [
    ['3', '--type', '5b'],                                                          // sin --tests
    ['3', '--type', '5b', '--tests', '1', '--deferred', '1', '--reason', 'm'],    // 1+1 ≠ 3
    ['3', '--type', '5b', '--tests', '0', '--deferred', '3'],                     // diferidos sin motivo
    ['3', '--type', '5b', '--tests', '1', '--deferred', '2', '--reason', 'm'],    // dice 1 prueba, promovidas 0
  ];
  for (const args of malos) {
    assert.throws(
      () => execFileSync(process.execPath, [MARKER, 'mark-adversarial-result', ...args, '--result', resultadoMedido(fakeHome, 3)], { ...markerEnv(SID, fakeHome), stdio: 'pipe' }),
      (e) => e.status === 2, `${JSON.stringify(args)} → exit 2`,
    );
  }
  assert.equal(gatesLines(fakeHome).filter((g) => g.name === 'adversarial-pass').length, 0, 'ningún pase anotado');
  execFileSync(process.execPath, [MARKER, 'promote-probe', probeDir, '--file', 'ZZProbeRutas.cs.txt', '--a', 'tests/R.cs'], markerEnv(SID, fakeHome));
  const ok = JSON.parse(execFileSync(process.execPath, [MARKER, 'mark-adversarial-result', '3', '--type', '5b', '--result', resultadoMedido(fakeHome, 3), '--tests', '1', '--deferred', '2', '--reason', 'código preexistente → story 10.2'], markerEnv(SID, fakeHome)));
  assert.equal(ok.pruebas, 1); assert.equal(ok.diferidos, 2); assert.equal(ok.veredicto, 'no-listo');
  const linea = gatesLines(fakeHome).find((g) => g.name === 'adversarial-pass');
  assert.equal(linea.motivo, 'código preexistente → story 10.2', 'el motivo del diferido queda en el registro');
  // cero confirmados: nada que exigir
  execFileSync(process.execPath, [MARKER, 'mark-adversarial-result', '0', '--type', '5b', '--result', resultadoMedido(fakeHome, 0)], markerEnv(SID, fakeHome));
  fs.rmSync(fakeHome, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

// ── 10b del skill de merge: qué sha recibe el latido en cada modo ────────────────────────────────
// 🔴 El 10b no puede decir «--merge <sha del merge>» para los dos modos. En modo `pr` el merge lo hace Azure
// DESPUÉS, así que el ledger de retro-pending.js anota la PUNTA DE LA SOURCE; con el sha del merge el archivo se
// escribe, el gate sigue bloqueando hasta agotar los 3 bloqueos y queda un metrics-*.json de más en
// la serie que leen el nocturno SDLC (first_pass_ratio) y la vista de corridas. Vale para todos los repos que
// mergean por PR.
// El texto es lo único que el agente lee, así que el texto es lo que se prueba — y el comando que
// deja escrito se EJECUTA acá, para que no se pudra (mismo patrón que las suites que extraen el paso
// real de un pipeline en vez de reimplementarlo).
const MERGE_SKILL = path.join(__dirname, '..', '..', '..', 'tycon-merge-to-main', 'SKILL.md');

function bloque10b() {
  const s = fs.readFileSync(MERGE_SKILL, 'utf8');
  const i = s.indexOf('**10b');
  assert.ok(i >= 0, 'el SKILL.md de tycon-merge-to-main no tiene el bloque 10b');
  const fin = s.indexOf('\n## ', i);
  return s.slice(i, fin < 0 ? s.length : fin);
}

test('10b: en modo pr el latido recibe la punta de la source, no el sha del merge de Azure', () => {
  // 🔴 Un texto que dijera «--merge <sha del merge>» sin distinguir modo hace fallar las cuatro aserciones de abajo.
  const b = bloque10b();
  assert.ok(!/--merge <sha del merge>/.test(b),
    '10b sigue mandando «--merge <sha del merge>»: en modo pr ese sha no existe todavía');
  assert.match(b, /PUNTA DE LA SOURCE/,
    '10b no nombra la punta de la source como el sha del modo pr');
  assert.match(b, /el que anotó el ledger/,
    '10b no dice que el sha que paga la deuda es el que anotó el ledger');
  // El modo `push` no se toca: ahí el sha SÍ es el del merge recién pusheado.
  assert.match(b, /En modo `push` ese sha es el del merge/,
    '10b dejó de decir qué sha va en modo push');
});

// La opción con la que el 10b le pregunta a retro-pending.js es del ARNÉS (`--judge`) y el nombre viejo anda por
// alias. El SKILL.md la nombra con el viejo a propósito —referencia entre
// repos: un arnés anterior sólo entiende ése—, y el viejo sale del mapa del arnés, nunca escrito
// acá (el freno y el termómetro cuentan los nombres de lo que se publica, pruebas incluidas).
const RETRO_PENDING = 'scripts/hooks/retro-pending.js';
function opcionesDelJuicio() { // null = no encontré el mapa del arnés
  const cands = [process.env.TYCON_GUIDES_DIR, path.join(os.homedir(), '.claude', 'tycon-harness'), path.join(os.homedir(), '.claude', 'tycon-claude-guides'),
    path.join(os.homedir(), 'SourceCode', 'tycon-claude-guides')].filter(Boolean);
  for (const dir of cands) {
    let map;
    try { map = JSON.parse(fs.readFileSync(path.join(dir, 'scripts', 'lib', 'renames.json'), 'utf8')); } catch (_) { continue; }
    const e = (map.entries || []).find((x) => x && x.kind === 'option' && x.where === RETRO_PENDING && x.new === 'judge');
    return e ? ['judge', e.old] : ['judge'];   // sin la entrada (retirada): sólo el nombre nuevo
  }
  return null;
}

test('10b: la pregunta a retro-pending.js queda acotada al modo push (en pr lee la ventana de un fetch, no del push)', (t) => {
  // 🔴 Preguntarle siempre a retro-pending.js es un error: en modo pr puede devolver un rango de cientos de commits —
  // la ventana del último fetch, no la del merge—. Un `exento` salido de ahí saltea el latido con la deuda viva.
  const b = bloque10b();
  assert.match(b, /SÓLO en modo `push`/, '10b no acota la pregunta al modo push');
  assert.match(b, /En modo `pr` NO se pregunta/, '10b no dice que en modo pr no se pregunta');
  const ops = opcionesDelJuicio();
  if (!ops) return t.skip('NO MEDIDO — sin el mapa del arnés (TYCON_GUIDES_DIR · ~/.claude/tycon-harness o el nombre viejo · ruta canónica): no sé con qué nombre de opción pregunta el 10b');
  const re = new RegExp(`retro-pending\\.js --(?:${ops.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}) <repo>`);
  assert.match(b, re, `10b dejó de mandar a preguntarle a retro-pending.js (--${ops.join(' o --')})`);
});

test('10b: el comando que rescata el sha del ledger CORRE — devuelve la entrada del repo, saltea la exenta, y sin entrada sale 3', () => {
  // 🔴 Romper el one-liner del SKILL.md (o borrarlo) pone este caso en rojo.
  const b = bloque10b();
  const m = b.match(/^\s*(node -e '.*retro-pending\.jsonl.*') <repo>$/m);
  assert.ok(m, '10b no deja escrito el comando que saca el sha del ledger');
  const cmd = m[1];

  const home = fs.mkdtempSync(path.join(os.tmpdir(), '10b-ledger-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), '10b-repo-'));
  const otro = fs.mkdtempSync(path.join(os.tmpdir(), '10b-otro-'));
  fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline'), { recursive: true });
  const ledger = path.join(home, '.claude', '.tycon-pipeline', 'retro-pending.jsonl');
  fs.writeFileSync(ledger, [
    // de otro repo: no se devuelve
    { ts: '2026-09-17T10:00:00Z', repoPath: otro, sha: 'aaaaaaaaaaaa', branch: 'main' },
    // la buena
    { ts: '2026-09-17T11:00:00Z', repoPath: repo, sha: '238213401a82', branch: 'main' },
    // exenta y POSTERIOR: no se paga, y no puede ganarle a la buena por ser la última
    { ts: '2026-09-17T12:00:00Z', repoPath: repo, sha: 'ffffffffffff', branch: 'main', exento: 'solo-tests-docs' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');

  const { spawnSync } = require('child_process');
  const correr = (dir) => spawnSync('bash', ['-c', `${cmd} "${dir}"`], { encoding: 'utf8', env: { ...process.env, HOME: home } });

  const ok = correr(repo);
  assert.equal(ok.status, 0, `esperaba exit 0: ${ok.stderr}`);
  assert.equal(ok.stdout.trim(), '238213401a82', 'no devolvió la entrada no exenta de ese repo');

  const vacio = correr(fs.mkdtempSync(path.join(os.tmpdir(), '10b-nada-')));
  assert.equal(vacio.status, 3, 'un repo sin entrada tiene que salir 3, no 0 con salida vacía');
  assert.equal(vacio.stdout.trim(), '', 'sin entrada no se imprime ningún sha');

  for (const d of [home, repo, otro]) fs.rmSync(d, { recursive: true, force: true });
});

// ── 9b del skill de merge: ramas efímeras y de dónde salen org/proyecto/repo ─────────────────────
// 🔴 Con el flujo de pull request las ramas source son EFÍMERAS (`story/N.M`, `fix/<slug>`): un step con
// `--delete-source-branch false` fijo y la justificación «dev es de larga vida» acierta para `dev`
// y falla para todo lo demás (quedan ramas `story/*` vivas después del merge).
// Y `org`/`proyecto`/`repo` escritos a ojo son como se termina apuntando `az` al proyecto
// equivocado (`Acme` contra `Acme Logistica`).
// El texto es lo único que el agente lee, así que el texto es lo que se prueba.
const PASO_9B = path.join(__dirname, '..', '..', '..', 'tycon-merge-to-main', 'steps', 'step-09b-create-pr.md');
const leer9b = () => fs.readFileSync(PASO_9B, 'utf8');

test('9b: la rama source efímera se borra al completar, y la lista de larga vida está en UN solo lugar', () => {
  // 🔴 Si los tres `--delete-source-branch` dijeran `false` y no existiera ninguna lista, las cuatro aserciones fallarían.
  const s = leer9b();
  assert.ok(!/--delete-source-branch false/.test(s),
    '9b sigue con `--delete-source-branch false` fijo: una rama efímera queda viva después del merge');
  assert.match(s, /RAMAS_DE_LARGA_VIDA="[^"]*\bdev\b[^"]*"/,
    '9b no declara la lista de ramas de larga vida');
  // Los TRES puntos donde `az` manda la opción usan la variable: si uno se olvida, el `az` que
  // gana es el último y la rama sobrevive sin que nada avise.
  assert.equal((s.match(/--delete-source-branch "\$BORRAR_SOURCE"/g) || []).length, 3,
    '9b no usa $BORRAR_SOURCE en los tres --delete-source-branch (update de 9b.2, create y update de 9b.3)');
  // Un solo lugar: la lista no puede estar también en el SKILL.md.
  const skill = fs.readFileSync(MERGE_SKILL, 'utf8');
  assert.ok(!/RAMAS_DE_LARGA_VIDA|dev develop main/.test(skill),
    'la lista de ramas de larga vida quedó duplicada en el SKILL.md: dos copias se separan solas');
});

test('9b: org/proyecto/repo se derivan del remoto origin con identidadAzure(), no a ojo', () => {
  // 🔴 Un step que escribe `--org <org> --project <proj>` como marcadores y sólo dice, en un edge case, que «sale de
  // git remote get-url origin» —sin comando— no pasa.
  const s = leer9b();
  assert.match(s, /identidadAzure/, '9b no usa el parser del arnés');
  assert.ok(!/--org <org>|--project <proj>|--repository <repo-name>/.test(s),
    '9b todavía tiene org/proyecto/repo como marcadores para completar a ojo');
  assert.match(s, /read -r ORG; read -r PROJ; read -r REPO_NAME/,
    '9b no lee los tres valores del parser');
  // La URL del remoto es texto de afuera: no se evalúa como comando.
  assert.ok(!/eval "\$\(node/.test(s), '9b evalúa la salida del parser: la URL del remoto es texto de afuera');
  assert.match(s, /exit 3/, '9b no dice qué pasa si el remoto no es de Azure DevOps');
});

test('9b: el PR con conflictos tiene su edge case, y se verifica leyendo mergeStatus', () => {
  const s = leer9b();
  assert.match(s, /CONFLICTOS con el target/, '9b no cubre el PR con conflictos');
  assert.match(s, /mergeStatus/, '9b no dice cómo se detecta un PR que no puede mergear');
  assert.match(s, /git -C <repo> merge origin\/<target>/, '9b no propone cómo destrabarlo');
  assert.match(s, /queued/, '9b no dice cómo verificar que se destrabó (ADO recalcula la mezcla)');
});

// El parser que el step manda usar tiene que existir y entender las tres formas de remoto del equipo.
// Sin esto, el step quedaría escrito contra una función que alguien movió o renombró.
test('9b: identidadAzure() existe en el arnés y entiende las tres formas de remoto', (t) => {
  // Por el nombre actual del criterio (`harness-repo.js`): con otro nombre no lo encontraría en ningún lado y
  // saldría verde sin mirar nada.
  const lib = [process.env.TYCON_GUIDES_DIR, process.env.TCG, process.cwd(), path.join(os.homedir(), '.tycon', 'harness')].filter(Boolean)
    .map((d) => path.join(d, 'scripts', 'lib', 'harness-repo.js')).find((f) => fs.existsSync(f));
  if (!lib) return t.skip('NO MEDIDO: no encontré scripts/lib/harness-repo.js (TYCON_GUIDES_DIR · TCG · cwd · ~/.tycon/harness)');
  const { identidadAzure } = require(lib);
  assert.deepEqual(identidadAzure('https://org-del-equipo.visualstudio.com/Totora/_git/Backend'),
    { org: 'org-del-equipo', proyecto: 'totora', repo: 'backend', nombre: 'Backend' });
  assert.deepEqual(identidadAzure('https://org-del-equipo@dev.azure.com/org-del-equipo/tycon-claude-guides/_git/tycon-claude-guides'),
    { org: 'org-del-equipo', proyecto: 'tycon-claude-guides', repo: 'tycon-claude-guides', nombre: 'tycon-claude-guides' });
  assert.equal(identidadAzure('git@github.com:alguien/repo.git'), null,
    'un remoto que no es de Azure tiene que dar null para que 9b salga por el Step 9');
});

// ── El cruce findings↔roster también corre EN LA MÁQUINA ─────────────────────────────────────
// `roster-incoherente` es una regla del portón con contraparte local: `revisarRosterLocal` hace el cruce INVERSO
// (roster contra el ledger de spawns) y llama a `rlib.validate(roster)` CON los firmantes de `findings.json`. Sin
// eso, el dev se enteraría recién con el pull request abierto, y el mensaje del portón encima le diría que
// esto "corre en el pre-commit de cada máquina" — lo mandaría a buscar un hook salteado que nunca existió.
//
// El veredicto tiene que ser IDÉNTICO al del portón, y el portón AVISA:
// avisar en los dos lados, y frenar en los dos con TYCON_ROSTER_NAMES=block.
// 🔴 La transición importa: `review → done` entra por el canal REVIEW-A-DONE, que hoy AVISA
// entero (TYCON_REVIEW_A_DONE), así que ahí ni `roster-fabricado` frena y no se puede medir
// nada de esta pieza. La que frena es la ENTRADA a `done` desde afuera — `in-progress → done`.
function repoConRosterYFindings({ firmantes, reviewers, previos }) {
  const { execFileSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r713-home-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  const story = (st) => `---\nstory: "7.13"\nepic: "7"\nstatus: ${st}\n---\n\n# Story 7.13\n\n## Acceptance Criteria\n1. algo\n`;
  const spec = path.join(repo, 'specs', 'story-7.13.md');

  // El run dir con la constancia de los revisores y los hallazgos firmados.
  const runDir = path.join(repo, '.advisors', 'pipeline-runs', '7.13-20260922120000');
  fs.mkdirSync(path.join(runDir, 'step-05-advisor-reports'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'step-05-advisor-reports', 'sec.md'), '# reporte\n');
  const rev = (agent) => ({ agent, kind: 'subagente', model: null, model_source: 'heredado', ts: null, iter: 1 });
  const roster = {
    version: 1, story: '7.13', written_by: 'on-advisor-run.js', ts: '2026-09-22T12:00:00Z',
    base_sha: null, tree_sha: null,
    implementer: { kind: 'sesion-principal', session_id: 'impl-1', model: 'claude-opus-5' },
    reviewers: reviewers.map(rev), iterations: 1, iterations_source: 'ledger',
    ...(previos ? { agentes_previos: previos.map(rev) } : {}),
  };
  fs.writeFileSync(path.join(runDir, 'review-roster.json'), `${JSON.stringify(roster, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'findings.json'), `${JSON.stringify(firmantes.map((a, i) => ({
    rule_id: `X-${i}`, severity: 'WARNING', advisor: typeof a === 'string' ? a : a.advisor,
    ...(typeof a === 'string' ? {} : { tramo: a.tramo }),
    file: 'x.js', disposition: 'open', reason: 'r',
  })), null, 2)}\n`);

  // El TESTIGO: el ledger de spawns de esta máquina. Sin él el freno da `sin-testigo` y nunca
  // llega a mirar los firmantes — el cruce inverso (AC 10) se prueba quitándolo.
  const runsDir = path.join(home, '.claude', '.tycon-pipeline', 'advisor-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, 'sid-x.jsonl'), [...reviewers, ...(previos || [])]
    .map((a) => JSON.stringify({ ts: '2026-09-22T12:00:00.000Z', advisor: a, model: null, repo, story: '7.13' }))
    .join('\n') + '\n');

  fs.writeFileSync(spec, story('in-progress'));
  g('add', '-A'); g('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');
  fs.writeFileSync(spec, story('done'));
  g('add', '-A');
  return { home, repo };
}
const hook713 = (f, env) => require('node:child_process').spawnSync(process.execPath,
  [path.join(SCRIPTS, 'on-pre-commit.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'r713-s1',
      cwd: f.repo, tool_input: { command: 'git commit -m "cierra"' } }),
    env: { ...process.env, HOME: f.home, ...(env || {}) },
    cwd: f.repo, encoding: 'utf8',
  });

// 🔴 El freno local tiene que mirar los firmantes: sin eso sale limpio con y sin la llave.
test('PreCommit_FindingsNombraRevisorAusente_AvisaYFrenaConLaLlave', () => {
  const f = repoConRosterYFindings({
    reviewers: ['tycon-plugin-security-basics', 'tycon-silent-failure-hunter'],
    firmantes: ['tycon-plugin-security-basics', 'tycon-fantasma'],
  });
  const aviso = hook713(f);
  assert.match(aviso.stderr || '', /roster-incoherente/, 'el freno local usa el MISMO nombre de regla que el portón');
  assert.match(aviso.stderr || '', /tycon-fantasma/, 'y nombra al firmante');
  assert.match(aviso.stderr || '', /7\.13-20260922120000/, 'y la corrida (el AC pide las dos cosas)');
  assert.equal(aviso.status, 0, 'por default AVISA y deja commitear — igual que el portón desde f1d764a');

  const freno = hook713(f, { TYCON_ROSTER_NAMES: 'block' });
  assert.equal(freno.status, 2, 'con la llave puesta frena, igual que el portón');
  assert.equal(hook713(f, { TYCON_ROSTER_NAMES: 'freno' }).status, 2, 'el valor de antes de la story 8.9 sigue frenando hasta el retiro');
  assert.match(freno.stderr || '', /tycon-fantasma/);
  fs.rmSync(f.home, { recursive: true, force: true });
});

// El firmante con la vuelta pegada y el del paso 1 NO son revisores ausentes: son los dos falsos
// positivos que frenaron aquel pull request. Acá se fija que el freno local tampoco los levante.
test('PreCommit_VueltaPegadaYHallazgoDelPaso1_NoSonRevisorAusente', () => {
  const f = repoConRosterYFindings({
    reviewers: ['tycon-silent-failure-hunter'],
    previos: ['tycon-sibling-pattern-reviewer'],
    firmantes: [
      { advisor: 'tycon-silent-failure-hunter', tramo: 'revision' },
      { advisor: 'tycon-sibling-pattern-reviewer', tramo: 'previo' },
      { advisor: 'pase adversarial', tramo: 'pipeline' },
    ],
  });
  const r = hook713(f, { TYCON_ROSTER_NAMES: 'block' });   // con la llave: si levantara algo, frena
  assert.equal(r.status, 0, `ninguno de los tres es un revisor ausente (stderr: ${(r.stderr || '').slice(0, 400)})`);
  assert.ok(!/roster-incoherente/.test(r.stderr || ''), 'y no se nombra la regla');
  fs.rmSync(f.home, { recursive: true, force: true });
});

// AC 10 — el cruce INVERSO no se toca: un roster que lista a alguien que el ledger nunca vio
// spawnear sigue siendo `roster-fabricado`, y eso SÍ frena. Son dos cruces distintos.
test('CruceInverso_RosterFabricado_SigueFrenando', () => {
  const f = repoConRosterYFindings({
    reviewers: ['tycon-plugin-security-basics'],
    firmantes: ['tycon-plugin-security-basics'],
  });
  // El roster gana un revisor que el ledger no tiene: exactamente lo que el cruce inverso caza.
  const rp = path.join(f.repo, '.advisors', 'pipeline-runs', '7.13-20260922120000', 'review-roster.json');
  const roster = JSON.parse(fs.readFileSync(rp, 'utf8'));
  roster.reviewers.push({ agent: 'revisor-inventado', kind: 'subagente', model: null, model_source: 'heredado', ts: null, iter: 1 });
  fs.writeFileSync(rp, `${JSON.stringify(roster, null, 2)}\n`);
  require('node:child_process').execFileSync('git', ['-C', f.repo, 'add', '-A'], { stdio: 'ignore' });
  const r = hook713(f);
  assert.equal(r.status, 2, 'roster-fabricado frena, y no lo ablanda el canal de aviso de los nombres');
  assert.match(r.stderr || '', /revisor-inventado/);
  fs.rmSync(f.home, { recursive: true, force: true });
});

// ── Un `findings.json` corrupto no puede APAGAR el cruce en silencio ─────────────────────────
// `firmantesDeFindings` no puede tragar CUALQUIER error de lectura —archivo ausente y archivo corrupto por
// igual— y devolver null: con null el cruce `roster-incoherente` simplemente NO CORRE y el commit
// pasa como si estuviera todo bien. El `catch` externo de `revisarRosterLocal` está documentado
// como fail-open «porque el portón de CI sigue mirando», pero el portón también depende de que
// `advisoresEnFindings` no trague el error con un `try/catch` mudo: un archivo corrupto apagaría el chequeo en los
// DOS lados sin dejar rastro.
//
// Ausente ≠ corrupto: el primero es normal (los hallazgos se escriben después) y sigue mudo; el
// segundo deja rastro por stderr. Ninguno de los dos frena.
// 🔴 Con el JSON roto no puede quedar mudo: se imprime algo.
test('FindingsCorrupto_NoApagaElCruceEnSilencio', () => {
  const f = repoConRosterYFindings({
    reviewers: ['tycon-plugin-security-basics'],
    firmantes: ['tycon-plugin-security-basics'],
  });
  const fj = path.join(f.repo, '.advisors', 'pipeline-runs', '7.13-20260922120000', 'findings.json');

  // (a) corrupto → avisa por stderr y NO frena
  fs.writeFileSync(fj, '[{ esto no es json');
  require('node:child_process').execFileSync('git', ['-C', f.repo, 'add', '-A'], { stdio: 'ignore' });
  const roto = hook713(f);
  assert.match(roto.stderr || '', /findings\.json/, 'nombra el archivo que no pudo leer');
  assert.equal(roto.status, 0, 'no frena: un archivo ilegible no es una incoherencia');

  // (b) JSON válido pero que NO es una lista ni `{findings: […]}`: mismo trato que el corrupto —
  // el cruce no corre, y eso se dice. Es el tercer camino de «no pude leer».
  fs.writeFileSync(fj, '{"status":"ok"}');
  require('node:child_process').execFileSync('git', ['-C', f.repo, 'add', '-A'], { stdio: 'ignore' });
  const noEsLista = hook713(f);
  assert.match(noEsLista.stderr || '', /findings\.json/, 'un JSON que no es lista también deja rastro');
  assert.equal(noEsLista.status, 0, 'y tampoco frena');

  // (b2) 🔴 PARIDAD con el portón: la forma `{findings: [...]}` SÍ vale, y el cruce corre igual que
  // allá. Si la máquina no leyera `data.findings` como el portón, para esa forma el servidor avisaría
  // `roster-incoherente` y la máquina se saltaría el cruce entero. Dos veredictos sobre el mismo commit es un rojo.
  fs.writeFileSync(fj, JSON.stringify({ findings: [{ rule_id: 'X-1', advisor: 'tycon-fantasma-envuelto', tramo: 'revision' }] }));
  require('node:child_process').execFileSync('git', ['-C', f.repo, 'add', '-A'], { stdio: 'ignore' });
  const envuelto = hook713(f, { TYCON_ROSTER_NAMES: 'aviso' });
  assert.match(envuelto.stderr || '', /roster-incoherente/, 'con `{findings: […]}` el cruce CORRE, igual que en el portón');
  assert.match(envuelto.stderr || '', /tycon-fantasma-envuelto/, 'y nombra al firmante');
  // 🔴 Este hallazgo trae `tramo`, o sea que `write-findings` lo validó contra el registro al
  // escribirlo: la incoherencia es REAL y frena sin llave. Es la regla volviendo a frenar sola
  // para lo que nació validado, sin día de corte.
  assert.equal(envuelto.status, 2, 'un hallazgo validado al escribirse frena, sin necesidad de la llave');

  // …y el MISMO firmante ausente, pero del formato viejo (sin `tramo`): nadie lo validó, así que
  // sigue avisando. Es lo que evita repetir el frenón de aquel pull request con las 12 corridas viejas que
  // todavía hay en disco.
  fs.writeFileSync(fj, JSON.stringify([{ rule_id: 'X-1', advisor: 'tycon-fantasma-viejo' }]));
  require('node:child_process').execFileSync('git', ['-C', f.repo, 'add', '-A'], { stdio: 'ignore' });
  const viejo = hook713(f);
  assert.match(viejo.stderr || '', /tycon-fantasma-viejo/, 'el del formato viejo igual se ve');
  assert.equal(viejo.status, 0, 'pero avisa y deja commitear');

  // (c) ausente → sigue mudo (es el caso normal: los hallazgos se escriben después del roster)
  fs.rmSync(fj);
  require('node:child_process').execFileSync('git', ['-C', f.repo, 'add', '-A'], { stdio: 'ignore' });
  const sin = hook713(f);
  assert.ok(!/findings\.json/.test(sin.stderr || ''), 'el archivo ausente no genera ruido');
  assert.equal(sin.status, 0);
  fs.rmSync(f.home, { recursive: true, force: true });
});

// ── La constancia del cierre carga la lib del arnés por su nombre actual ────────────────────────
// El reemplazo de la lib vieja, bajo Azure (TF_BUILD), escribe un aviso por stderr. Si `closing-record.js` cargara
// la lib por el nombre viejo, el hook cambiaría su salida según estuviera o no la lib, y el caso de
// guard-record.test.sh del arnés («sin la lib el hook decide igual, misma salida») saldría rojo SÓLO en Azure.
// Con la lib nueva y el reemplazo presentes, el caso (a) no tiene que dar el aviso por stderr.
// Un arnés de mentira (TYCON_GUIDES_DIR) con libs de mentira: el reemplazo imita al de verdad (avisa bajo TF_BUILD).
// El nombre viejo sale de la tabla de closing-record, nunca escrito acá.
test('Constancia_Cierre_LibNueva_SinRuidoBajoAzure_YLaViejaSoloSiFalta', () => {
  const { NOMBRES_DE_LA_LIB } = require(path.join(SCRIPTS, 'lib', 'closing-record.js'));
  const { spawnSync } = require('node:child_process');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'closing-record-lib-'));
  const libFalsa = (destino) => `const fs = require('fs'); module.exports = { anotar: (d) => { `
    + `fs.appendFileSync(${JSON.stringify(destino)}, JSON.stringify(d) + '\\n'); return { escrito: true }; } };\n`;
  const reemplazoFalso = (destino) => `if (/^true$/i.test(process.env.TF_BUILD || '')) process.stderr.write('##vso[task.logissue type=warning]nombre viejo\\n');\n`
    + libFalsa(destino);
  function correr(caso, { nueva, vieja }) {
    const arnes = path.join(raiz, caso, 'arnes');
    const home = path.join(raiz, caso, 'home');
    const anotado = path.join(raiz, caso, 'anotado.jsonl');
    const resultado = path.join(raiz, caso, 'resultado.json');
    fs.mkdirSync(path.join(arnes, 'scripts', 'lib'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(arnes, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/bash\n');   // así se reconoce un clon
    if (nueva) fs.writeFileSync(path.join(arnes, 'scripts', 'lib', NOMBRES_DE_LA_LIB.nuevo), libFalsa(anotado));
    if (vieja) fs.writeFileSync(path.join(arnes, 'scripts', 'lib', NOMBRES_DE_LA_LIB.viejo), reemplazoFalso(anotado));
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_') && k !== 'TF_BUILD' && k !== 'TCG') env[k] = v;
    Object.assign(env, { HOME: home, TYCON_GUIDES_DIR: arnes, TF_BUILD: 'True' });
    const js = `const cr = require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'closing-record.js'))});`
      + `const r = cr.anotarCierre({ freno: 'on-frontmatter-write', regla: 'evidencia-ok', veredicto: 'paso', huella: 'h' });`
      + `require('fs').writeFileSync(${JSON.stringify(resultado)}, JSON.stringify({ r, lib: cr.rutaDeLaLib() }));`;
    const p = spawnSync(process.execPath, ['-e', js], { encoding: 'utf8', env, timeout: 20000 });
    const lineas = fs.existsSync(anotado) ? fs.readFileSync(anotado, 'utf8').trim().split('\n').filter(Boolean) : [];
    return { p, lineas, salida: JSON.parse(fs.readFileSync(resultado, 'utf8')) };
  }
  try {
    // (a) la lib nueva y el reemplazo del nombre viejo, como en un arnés al día: carga la nueva, sin ruido, y anota
    const a = correr('a', { nueva: true, vieja: true });
    assert.equal(a.p.status, 0, a.p.stderr);
    assert.equal(a.p.stdout, '', 'nada a stdout');
    assert.equal(a.p.stderr, '', 'nada a stderr: el aviso del reemplazo no se dispara');
    assert.equal(path.basename(a.salida.lib), NOMBRES_DE_LA_LIB.nuevo, 'carga la lib por su nombre nuevo');
    assert.deepEqual(a.salida.r, { escrito: true });
    assert.equal(a.lineas.length, 1, 'y anota la decisión');
    // (b) sólo el nombre viejo, como en un arnés atrasado: también anota
    const b = correr('b', { nueva: false, vieja: true });
    assert.equal(b.p.status, 0, b.p.stderr);
    assert.equal(path.basename(b.salida.lib), NOMBRES_DE_LA_LIB.viejo, 'sin la nueva, el nombre viejo');
    assert.deepEqual(b.salida.r, { escrito: true });
    assert.equal(b.lineas.length, 1, 'el arnés atrasado también anota');
    // (c) ninguna: no anota, no dice nada, y apunta al nombre nuevo
    const c = correr('c', { nueva: false, vieja: false });
    assert.equal(c.p.stderr, '', 'sin lib, sin ruido');
    assert.deepEqual(c.salida.r, { escrito: false, motivo: 'sin-lib' });
    assert.equal(path.basename(c.salida.lib), NOMBRES_DE_LA_LIB.nuevo);
    assert.equal(c.lineas.length, 0);
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }
});

// ── el paso 7c se indica ANTES del freno del paso 8 ──────────────────────────────────────────────
// `next` no puede dar el 7c por salteado cuando la story está exenta o no declara pruebas de runtime, y mandar al
// paso 8: el cierre del paso 8 exige la constancia del 7c SIEMPRE (`dodRuntimeChecked`): también para la
// exenta, que la deja con `mark-dod-runtime-checked` y «exenta: …». Si no, el dev choca contra el freno
// después de haber obedecido a `next`. El freno anda; el orden lo tiene que decir quien da el orden.
function enElSiete(home, sid, cuerpo, extra) {
  const { file, repo } = markerDe27(home, sid, {
    stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8], deepReviewDone: true, ...extra,
  });
  if (cuerpo) fs.writeFileSync(path.join(repo, 'story.md'), cuerpo);
  const r = correr27(home, sid, 'pipeline.js', ['next']);
  assert.equal(r.status, 0, r.stderr);
  return { d: JSON.parse(r.stdout), file, repo };
}
const EXENTA = '---\nstory: "9.9"\nstatus: in-progress\ndod_runtime_exempt: true\ndod_runtime_exempt_reason: "sin interfaz"\n---\n# x\n';

test('next: una story exenta sin su constancia manda al 7c, con el comando de la exención', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h7c-a-'));
  // 🔴 next_step no puede ser '8' con una precondición sin cumplir que nadie lee.
  const { d, repo } = enElSiete(home, 'siete-c-exenta', EXENTA);
  assert.equal(d.next_step, 'live-check');
  assert.match(d.note, /mark-dod-runtime-checked/);
  assert.match(d.note, /exenta: /);
  assert.ok(d.steps.find((s) => s.step === 'live-check').skip_mechanical, 'el motivo del salteo sigue a la vista');
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

test('next: una story sin pruebas de runtime declaradas manda al 7c (el cierre del paso 8 no acepta ese salteo)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h7c-b-'));
  const { d, repo } = enElSiete(home, 'siete-c-sin-runtime', null);
  assert.equal(d.next_step, 'live-check');
  assert.ok(!/exenta: /.test(d.note), 'sin exención declarada no se ofrece el atajo de la exenta');
  assert.match(d.note, /step-10-live-check\.md/);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

test('next: con la constancia del 7c sigue el paso 8, exenta o no (el espejo)', () => {
  for (const [sid, cuerpo] of [['siete-c-hecho-exenta', EXENTA], ['siete-c-hecho', null]]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h7c-c-'));
    const { d, repo } = enElSiete(home, sid, cuerpo, { dodRuntimeChecked: true });
    assert.equal(d.next_step, 'prepare-commit', sid);
    assert.equal(d.preconditions.find((p) => p.id === 'dodRuntimeChecked').satisfied, true);
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ── el 0b (Clockify) con la integración apagada ──────────────────────────────────────────────────
// En una máquina sin Clockify (la copia pública, sin perfil del equipo) el paso dice «saltear», y `next` no puede
// repetirlo hasta que alguien marque `clockiStarted` a mano: la bandera diría «timer abierto» sin timer.
// Con la integración clockify apagada, el 0b es un salteo mecánico como el 0c sin pedido de trabajo.
const HARNESS_HERE_0B = path.resolve(SCRIPTS, '..', '..', '..');
function nextWithoutClockify(sid, extra) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h0b-'));
  const { repo } = markerDe27(home, sid, { clockiStarted: false });
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^TYCON_(CLOCKIFY|PROFILE|GUIDES_DIR)|^TCG$/.test(k)) env[k] = v;
  Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_PROFILE: '0', TYCON_GUIDES_DIR: HARNESS_HERE_0B, ...extra });
  const r = require('node:child_process').spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'next'], { encoding: 'utf8', env });
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('next: sin herramienta de horas el 0b es un salteo mecánico (no espera la bandera)', (t) => {
  if (!fs.existsSync(path.join(HARNESS_HERE_0B, 'scripts', 'lib', 'work-signal.js'))) { t.skip('sin el evento de trabajo en este árbol: no hay herramienta que medir'); return; }
  const d = nextWithoutClockify('cero-b-apagada');
  assert.equal(d.next_step, 'validate-story', 'sin herramienta de horas el aviso de trabajo no frena la secuencia');
  assert.ok(!(d.start_parts || []).some((p) => p.part === 'time-tracking'), 'y la parte no aparece en start_parts');
  const c = nextWithoutClockify('cero-b-prendida', { TYCON_CLOCKIFY: '1' });
  assert.ok((c.start_parts || []).some((p) => p.part === 'time-tracking'), 'control: con la llave vieja prendida (Clockify) la parte sigue esperando su bandera');
  assert.match(c.note, /^ANTES, lo que falta del Arranque/);
});

test('next: el salteo del 0c sin pedido de trabajo sigue siendo un salteo (no pide constancia)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h7c-d-'));
  const sid = 'cero-c-salteo';
  const { repo } = markerDe27(home, sid, { adoMarkedActive: false });
  const r = correr27(home, sid, 'pipeline.js', ['next']);
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.next_step, 'validate-story', 'el pedido en ADO sin `ado_work_item:` no frena la secuencia');
  assert.ok(!(d.start_parts || []).some((p) => p.part === 'ado'), 'y la parte no aparece en start_parts');
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
});

// ── el tamaño de la corrida: liviana (sólo documentación) o completa ─────────────────────────────────
function story732(files, extra = '') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 's732-'));
  const story = path.join(repo, 'story.md');
  const lista = (k, xs) => (xs.length ? `${k}:\n${xs.map((f) => `  - ${f}`).join('\n')}\n` : '');
  fs.writeFileSync(story, `---\nstory: "9.32"\nstatus: ready-for-dev\n${lista('files_to_modify', files)}${extra}---\n# x\n\n## Acceptance Criteria\n\n1. a\n`);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), 'x\n');
  }
  return { repo, story };
}

test('7.32-Portón_LivianaSinPase: el portón del pase da run:false con «corrida liviana»', () => {
  const { repo, story } = story732(['guides/a.md', 'guides/b.md', 'guides/c.md', 'guides/d.md', 'guides/e.md', 'guides/f.md', 'guides/g.md']);
  const g = computeDeepReviewGate({ story, repo, files: ['guides/a.md'], filesDeclarado: true });
  assert.equal(g.run, false);
  assert.match(g.reason, /corrida liviana/);
  // el kill-switch y el forzado siguen mandando
  assert.equal(computeDeepReviewGate({ story, repo, files: ['guides/a.md'], filesDeclarado: true, deepReview: true }).run, true);
});

test('7.32-Revisores_Baratos: en una liviana todos los revisores van en el modelo barato y los de completitud quedan', () => {
  const { repo, story } = story732(['guides/a.md']);
  const { aplicarTamanoALosRevisores } = require(path.join(SCRIPTS, 'pipeline.js'));
  const set = { all: ['tycon-ac-coverage-checker', 'tycon-deferral-tracker', 'tycon-plugin-security-basics'] };
  aplicarTamanoALosRevisores(set, { story, repo });
  assert.equal(set.run_size, 'liviana');
  assert.deepEqual(Object.values(set.model_hints), ['haiku', 'haiku', 'haiku']);
  assert.ok(set.all.includes('tycon-ac-coverage-checker') && set.all.includes('tycon-deferral-tracker'), 'completitud en el set');
  // con modelos por revisor de la organización, el mismo modelo barato
  const conOrg = { all: ['tycon-ac-coverage-checker'], reviewer_models: { 'tycon-ac-coverage-checker': { model: 'opus', origin: 'organization' } } };
  aplicarTamanoALosRevisores(conOrg, { story, repo });
  assert.equal(conOrg.reviewer_models['tycon-ac-coverage-checker'].model, 'haiku');
  // por línea de comandos: el set sale con los modelos baratos y la completitud adentro
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h732-adv-'));
  const r = require('node:child_process').spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'advisors', '--repo', repo, '--story', story, '--files', 'guides/a.md'],
    { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'adv-732' } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.run_size, 'liviana');
  for (const a of out.all) assert.equal(out.model_hints[a] || (out.reviewer_models && out.reviewer_models[a].model), 'haiku', `${a} en el barato`);
  assert.ok(out.all.includes('tycon-ac-coverage-checker'), 'la completitud corre igual');
});

test('7.32-Arranque_AnunciaYGuarda: start --brief dice tamaño, motivo y tiempo, y quedan en el marcador', () => {
  const { repo, story } = story732(['guides/a.md']);
  for (const c of [['init', '-q'], ['config', 'user.email', 't@t.co'], ['config', 'user.name', 't'], ['add', '.'], ['commit', '-qm', 'base'], ['checkout', '-qb', 'feat/x']]) {
    execFileSync('git', ['-C', repo, ...c], { stdio: 'ignore' });
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h732-start-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(path.resolve(SCRIPTS, '..', '..', '..'), path.join(home, '.claude', 'agent-skills'));
  const r = require('node:child_process').spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'start', '--repo', repo, '--story', story, '--brief'],
    { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'start-732', TYCON_LANE_LLM: '0' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const b = JSON.parse(r.stdout);
  assert.equal(b.tamano, 'liviana');
  assert.match(b.tamano_por, /sólo documentación/);
  assert.equal(b.estimado_min, 45);
  assert.match(b.estimado_de, /estimado sin historia/);
  assert.ok(b.acciones.some((a) => /^TAMAÑO: corrida liviana .* estimado 45 min/.test(a)), 'el anuncio en una línea');
  const m = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'active', 'start-732.json'), 'utf8'));
  assert.equal(m.size, 'liviana');
  assert.match(m.size_reason, /sólo documentación/);
  assert.equal(m.estimate_min, 45);
});

test('7.32-Forzado_ConMotivo: set-size sin motivo rechaza, con motivo guarda, a liviana con código deja bypass.log', () => {
  const { story } = story732(['scripts/x.js']);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h732-size-'));
  writeFakeMarker(home, 'size-732', { storyPath: story, repoPath: path.dirname(story), size: 'completa' });
  const run = (...a) => require('node:child_process').spawnSync(process.execPath, [MARKER, 'set-size', ...a], markerEnv('size-732', home));
  const sinMotivo = run('liviana');
  assert.equal(sinMotivo.status, 2);
  assert.match(sinMotivo.stderr, /falta el motivo/);
  const file = path.join(home, '.claude', '.tycon-pipeline', 'active', 'size-732.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).size, 'completa', 'sin motivo no escribe');
  const ok = run('liviana', '--reason', 'sólo cambia un comentario');
  assert.equal(ok.status, 0, ok.stderr);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(m.size, 'liviana');
  assert.equal(m.sizeForced.reason, 'sólo cambia un comentario');
  assert.ok(m.sizeForced.by, 'quién');
  const log = fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'bypass.log'), 'utf8');
  assert.match(log, /SIZE_FORCED_LIGHT_WITH_CODE/);
  // el forzado manda en el portón por línea de comandos
  const g = require('node:child_process').spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'deep-review-gate', '--repo', path.dirname(story), '--story', story, '--files', 'scripts/x.js'],
    { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'size-732' } });
  assert.equal(JSON.parse(g.stdout).run, false, g.stderr);
});

test('7.32-CodigoComoHoy: una story de código sale con el mismo riesgo, modelo y pase que antes', () => {
  const chica = story732(['scripts/a.js', 'scripts/b.js']);
  const grande = story732(['scripts/a.js', 'scripts/b.js', 'scripts/c.js', 'scripts/d.js', 'scripts/e.js', 'scripts/f.js', 'scripts/g.js']);
  const rcC = computeRiskClass({ story: chica.story, repo: chica.repo, files: [] });
  assert.equal(rcC.risk, 'LOW');
  const rcG = computeRiskClass({ story: grande.story, repo: grande.repo, files: [] });
  assert.equal(rcG.risk, 'NORMAL');
  assert.equal(rcG.criteria.find((c) => c.name === 'superficie-chica').detail, '7 archivos en scope (límite 6; 0 archivos = scope no declarado → NORMAL)');
  assert.equal(computeModelHint({ story: grande.story, repo: grande.repo, files: [] }).recommended_session_model, 'opus');
  const g = computeDeepReviewGate({ story: grande.story, repo: grande.repo, files: ['scripts/a.js', 'scripts/b.js', 'scripts/c.js', 'scripts/d.js', 'scripts/e.js', 'scripts/f.js', 'scripts/g.js'], filesDeclarado: true });
  assert.equal(g.run, true);
  assert.match(g.reason, /risk-class NORMAL/);
  // y una de texto con más de 12 archivos y muchos ACs no pide el modelo mayor
  const texto = story732(Array.from({ length: 14 }, (_, i) => `guides/g${i}.md`));
  const mh = computeModelHint({ story: texto.story, repo: texto.repo, files: [] });
  assert.equal(mh.signals.find((s) => s.name === 'superficie-grande').hit, false);
  assert.equal(computeRiskClass({ story: texto.story, repo: texto.repo, files: [] }).risk, 'LOW');
});

test('7.32-Paso4_TandasJuntas: next en el paso 4 de una liviana dice que las tandas van juntas', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h732-next-'));
  const sid = 'next-732';
  markerDe27(home, sid, { size: 'liviana', stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8] });
  const r = correr27(home, sid, 'pipeline.js', ['next']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.next_step, 'implement');
  assert.match(out.note, /las tandas van juntas en esta corrida/);
  // en una completa, nada
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'h732-next2-'));
  markerDe27(home2, sid, { size: 'completa', stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8] });
  assert.doesNotMatch(JSON.parse(correr27(home2, sid, 'pipeline.js', ['next']).stdout).note, /tandas van juntas/);
});

test('7.32-Cierre_SinLa170: el cierre de una liviana no pide la validación pesada salvo que el dev la nombre', () => {
  const { notaDelTamano } = require(path.join(SCRIPTS, 'pipeline.js'));
  const paso8 = { step: 'prepare-commit' };
  assert.match(notaDelTamano({ size: 'liviana' }, paso8), /no pidas la validación pesada/);
  assert.match(notaDelTamano({ size: 'liviana', heavyValidationRequested: true }, paso8), /pedila antes del merge/);
  assert.equal(notaDelTamano({ size: 'completa' }, paso8), null);
  // la bandera la escribe set-flag
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h732-flag-'));
  writeFakeMarker(home, 'flag-732', { size: 'liviana' });
  const r = require('node:child_process').spawnSync(process.execPath, [MARKER, 'set-flag', 'heavyValidationRequested', 'true'], markerEnv('flag-732', home));
  assert.equal(r.status, 0, r.stderr);
});

test('7.32-DiffReal_Manda: una story que declara un .md y un diff que toca código no sale liviana', () => {
  const { repo, story } = story732(['guides/a.md']);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'x\n');
  const g = computeDeepReviewGate({ story, repo, files: [path.join(repo, 'guides/a.md'), path.join(repo, 'src/a.js')], filesDeclarado: true });
  assert.notEqual(g.risk, 'liviana');
  assert.doesNotMatch(String(g.reason), /corrida liviana/);
  const rc = computeRiskClass({ story, repo, files: Array.from({ length: 10 }, (_, i) => `src/f${i}.js`) });
  assert.equal(rc.run_size, 'completa');
  assert.equal(rc.criteria.find((c) => c.name === 'superficie-chica').pass, false);
});

// ── Python, Svelte y Vue son código ─────────────────────────────────────────────────────────────────────────────
// Un diff de sólo Python o sólo Svelte lleva los revisores de seguridad, de fallos silenciosos y de cobertura de
// pruebas, como uno de JS/TS; y el control de criterios encuentra las pruebas de pytest y de Go.
const { computeAdvisorSet: computeAdvisorSet848, detectStack: detectStack848 } = require(path.join(SCRIPTS, 'pipeline.js'));
const packs848 = require(path.join(SCRIPTS, 'lib', 'packs.js'));
function repo848(archivos) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-848-'));
  for (const [rel, contenido] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), contenido);
  }
  return repo;
}

test('@story-8.48 @ac-3 T6 DetectStack_OnlyPy_NotOnlyDocs', () => {
  const repo = repo848({ 'app/util.py': 'def f():\n    try:\n        return 1\n    except ValueError:\n        raise\n' });
  const det = detectStack848(repo, ['app/util.py']);
  assert.equal(det.onlyDocs, false);
  assert.equal(det.codeModified, true);
  assert.equal(det.pyModified, true);
  const set = computeAdvisorSet848({ repo, story: null, files: ['app/util.py'] });
  for (const r of ['tycon-plugin-security-basics', 'tycon-plugin-tests-coverage', 'tycon-silent-failure-hunter']) {
    assert.ok(set.all.includes(r), `${r} entra con un diff de sólo .py (set: ${set.all.join(', ')})`);
  }
});

test('@story-8.48 @ac-3 @ac-4 T7 DetectStack_OnlySvelteOrVue_CodeReviewers', () => {
  for (const [f, bandera] of [['src/App.svelte', 'svelteModified'], ['src/App.vue', 'vueModified']]) {
    const repo = repo848({ [f]: '<script>\n  async function cargar() { try { await fetch("/x") } catch (e) { throw e } }\n</script>\n' });
    const det = detectStack848(repo, [f]);
    assert.equal(det.onlyDocs, false, f);
    assert.equal(det[bandera], true, f);
    assert.equal(det.tsxModified, false, `${f} no se hace pasar por JS/TS: los paquetes de React no lo reciben`);
    const set = computeAdvisorSet848({ repo, story: null, files: [f] });
    assert.ok(set.all.includes('tycon-plugin-security-basics'), `${f}: ${set.all.join(', ')}`);
    assert.ok(set.all.includes('tycon-plugin-tests-coverage'), f);
    // un paquete que pide esa bandera la ve
    assert.equal(packs848.evaluarCondicion({ detection: bandera }, { det, files: [f] }), true);
  }
  for (const b of ['pyModified', 'svelteModified', 'vueModified']) {
    assert.ok(packs848.BANDERAS.includes(b), `${b} es una bandera válida en un manifiesto`);
    assert.equal(packs848.validarCondicion({ detection: b }, packs848.BANDERAS), null, b);
  }
  // un .py en cualquier carpeta, no sólo routers/ o main.py
  assert.equal(packs848.evaluarCondicion({ detection: 'pyModified' }, { det: detectStack848(repo848({ 'app/util.py': 'x = 1\n' }), ['app/util.py']), files: ['app/util.py'] }), true);
});

test('@story-8.48 @ac-5 T21 StoryChecks_PytestAndGoTests_Found', () => {
  const repo = repo848({
    'story.md': `---
story: "9.48"
status: in-progress
---
# Story 9.48

## Acceptance Criteria

1. **Given** algo, **Then** otra cosa.
2. **Given** algo más, **Then** otra.
3. **Given** Go, **Then** también.

### Tests (3 verificaciones)

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | \`test_rechaza_texto_true\` | 1 | unit | x | y |
| T2 | \`AceptaBooleanoDeVerdad\` | 2 | unit | x | y |
| T3 | \`TestHandlerDevuelve422\` | 3 | unit | x | y |
`,
    'backend/tests/api/test_flags.py': '# T1\ndef test_rechaza_texto_true():\n    assert True\n',
    // una línea por elemento: pegadas con «\n» delante, las marcas parecen una dirección de correo al freno de publicar
    'backend/tests/api/helpers_flags.py': ['@pytest.mark.story("9.48")', '@pytest.mark.ac(2)', 'def test_acepta():', '    pass', ''].join('\n'),
    'svc/handler_test.go': 'func TestHandlerDevuelve422(t *testing.T) {}\n',
  });
  const r = checks.runStoryChecks({ repo, storyPath: path.join(repo, 'story.md') });
  const c1 = r.findings.filter((x) => x.rule === 'ACCOV-C1');
  assert.deepEqual(c1, [], `sin críticos falsos de ACCOV-C1: ${JSON.stringify(c1)}`);
});

// ── `set-models` acepta un nivel y guarda el modelo de Claude ───────────────────────────────────────────
test('T12 SetModels_AceptaNivel @story-2.70 @ac-5', () => {
  for (const [pedido, guardado] of [['strong', 'opus'], ['opus', 'opus'], ['economy', 'haiku']]) {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-set-models-270-'));
    const sid = 'set-models-270';
    writeFakeMarker(fakeHome, sid, {});
    execFileSync(process.execPath, [MARKER, 'set-models', `adversarial=${pedido}`], markerEnv(sid, fakeHome));
    const m = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude', '.tycon-pipeline', 'active', `${sid}.json`), 'utf8'));
    assert.deepStrictEqual(m.modelRequests.values, { adversarial: guardado }, pedido);
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
  // un valor que no es nivel ni nombre sigue rechazado, y el mensaje lista los niveles
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-set-models-270-'));
  writeFakeMarker(fakeHome, 'set-models-270b', {});
  const r = require('child_process').spawnSync(process.execPath, [MARKER, 'set-models', 'adversarial=medio'], markerEnv('set-models-270b', fakeHome));
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /economy, balanced, strong, max/);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// ── 7.40 B2: el paso 0b y el 9 llaman al evento neutro de trabajo ──────────────────────────────────
// El núcleo no sabe con qué herramienta se registran las horas: `pipeline.js work-signal` le pasa el evento a la
// integración elegida (scripts/lib/work-signal.js del arnés) y `next` saltea el 0b cuando no hay ninguna. Cada caso arma
// su HOME, su casa del arnés y una integración de mentira; el arnés es este mismo árbol (TYCON_GUIDES_DIR).
const ARNES_740 = path.resolve(SCRIPTS, '..', '..', '..');

function integracionDeMentira740() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-int-'));
  fs.mkdirSync(path.join(dir, 'fake', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fake', 'integration.json'), JSON.stringify({ name: 'fake', label: 'De mentira', kind: 'timeTracking', onWork: 'scripts/on-work.js', hooks: [], dispatch: [], settings: [] }));
  fs.writeFileSync(path.join(dir, 'fake', 'scripts', 'on-work.js'), [
    "let raw = ''; process.stdin.on('data', (c) => { raw += c; }); process.stdin.on('end', () => {",
    "  const ev = JSON.parse(raw);",
    "  const seconds = process.env.B2_SECONDS === '' ? undefined : Number(process.env.B2_SECONDS || 1080);",
    "  process.stdout.write(JSON.stringify(ev.event === 'stop' ? (seconds === undefined ? {} : { seconds }) : { action: `abrí ${ev.storyId} — ${ev.title} en ${ev.sessionId}` }) + '\\n');",
    "});",
  ].join('\n'));
  return dir;
}

const correr740 = (home, sid, script, args, extra = {}) => {
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0',
    TYCON_GUIDES_DIR: ARNES_740, TYCON_HOME: path.join(home, '.tycon'), TYCON_PROFILE: '0', ...extra };
  delete env.TYCON_CLOCKIFY;
  if (!('TYCON_TIME_TRACKING' in extra)) delete env.TYCON_TIME_TRACKING;
  return require('node:child_process').spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env });
};

test('Step0b_NoIntegration_SkippedWithReason @story-7.40 @ac-3', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-0b-'));
  const sid = 'b2-paso-0b';
  const ints = integracionDeMentira740();
  const { file, repo } = markerDe27(home, sid, { clockiStarted: undefined, adoMarkedActive: true });
  const paso0b = (extra) => {
    const r = correr740(home, sid, 'pipeline.js', ['next'], { TYCON_INTEGRATIONS_DIR: ints, ...extra });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    return { next: out.next_step, parte: (out.start_parts || []).find((p) => p.part === 'time-tracking'), out };
  };
  try {
    // sin herramienta elegida (sin clave, o `none`): la parte no aparece en start_parts, y no se pide ninguna bandera
    for (const extra of [{}, { TYCON_TIME_TRACKING: 'none' }]) {
      const { next, parte, out } = paso0b(extra);
      assert.equal(parte, undefined, 'sin herramienta de horas el aviso de trabajo no aparece en start_parts');
      assert.doesNotMatch(out.note, /aviso de trabajo/, 'ni la nota lo pide');
      assert.equal(next, 'validate-story', 'y no frena la secuencia');
    }
    // una desconocida es ninguna, y tampoco aparece
    assert.equal(paso0b({ TYCON_TIME_TRACKING: 'harvest' }).parte, undefined);
    // con una elegida, la parte va en start_parts, antes del paso que sigue
    const elegida = correr740(home, sid, 'pipeline.js', ['next'], { TYCON_INTEGRATIONS_DIR: ints, TYCON_TIME_TRACKING: 'fake' });
    const out = JSON.parse(elegida.stdout);
    assert.equal(out.next_step, 'validate-story');
    assert.equal(out.start_parts.find((p) => p.part === 'time-tracking').name, 'el aviso de trabajo');
    assert.match(out.note, /^ANTES, lo que falta del Arranque: el aviso de trabajo/);
    // la bandera nueva lo da por hecho
    assert.equal(correr740(home, sid, 'marker.js', ['set-flag', 'workSignalStarted', 'true']).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).workSignalStarted, true);
    assert.equal(paso0b({ TYCON_TIME_TRACKING: 'fake' }).parte, undefined, 'con la bandera la parte ya no se pide');
    // y la vieja de una corrida en vuelo también: no se reabre el reloj
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete m.workSignalStarted; m.clockiStarted = true;
    fs.writeFileSync(file, JSON.stringify(m));
    assert.equal(paso0b({ TYCON_TIME_TRACKING: 'fake' }).parte, undefined, 'clockiStarted de antes sigue valiendo');
    // set-flag con el nombre viejo escribe la nueva y avisa
    delete m.clockiStarted; fs.writeFileSync(file, JSON.stringify(m));
    const vieja = correr740(home, sid, 'marker.js', ['set-flag', 'clockiStarted', 'true']);
    assert.equal(vieja.status, 0, vieja.stderr);
    assert.match(vieja.stderr, /workSignalStarted/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).workSignalStarted, true);
  } finally {
    for (const d of [home, repo, ints]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('Step9_SumsSecondsFromStop @story-7.40 @ac-2', () => {
  const { completedWorkHours } = require(path.join(SCRIPTS, 'pipeline.js'));
  assert.equal(completedWorkHours(0, { seconds: 1080 }), 0.3, '1080 s son 0,3 h');
  assert.equal(completedWorkHours(2, { seconds: 1080 }), 2.3, 'se suma a lo que ya tenía');
  assert.equal(completedWorkHours(2, {}), null, 'sin segundos no suma: no se inventa');
  assert.equal(completedWorkHours(2, { seconds: -5 }), null);
  assert.equal(completedWorkHours(2, null), null);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-9-'));
  const sid = 'b2-paso-9';
  const ints = integracionDeMentira740();
  const { repo } = markerDe27(home, sid, {});
  fs.writeFileSync(path.join(repo, 'story.md'), '---\nstory: "9.9"\ntitle: "Una historia de laboratorio"\nstatus: in-progress\n---\n# x\n');
  const senal = (evento, extra) => {
    const r = correr740(home, sid, 'pipeline.js', ['work-signal', evento], { TYCON_INTEGRATIONS_DIR: ints, TYCON_TIME_TRACKING: 'fake', ...extra });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  try {
    // stop con 1080 s: los segundos y las horas para CompletedWork
    const conSegundos = senal('stop', { B2_SECONDS: '1080' });
    assert.equal(conSegundos.seconds, 1080);
    assert.equal(conSegundos.hours, 0.3);
    // stop sin segundos: nada que sumar
    const sinSegundos = senal('stop', { B2_SECONDS: '' });
    assert.equal(sinSegundos.seconds, undefined);
    assert.equal(sinSegundos.hours, undefined);
    // start le pasa a la integración la historia, el título y la sesión del marker, y trae la acción para el agente
    assert.equal(senal('start', {}).action, `abrí 9.9 — Una historia de laboratorio en ${sid}`);
    // sin herramienta elegida: no corre nada
    const ninguna = correr740(home, sid, 'pipeline.js', ['work-signal', 'stop'], { TYCON_INTEGRATIONS_DIR: ints, TYCON_TIME_TRACKING: 'none' });
    assert.equal(ninguna.status, 0, ninguna.stderr);
    const n = JSON.parse(ninguna.stdout);
    assert.equal(n.ran, false);
    assert.equal(n.hours, undefined);
    // un evento que no es del pipeline: uso mal escrito
    assert.equal(correr740(home, sid, 'pipeline.js', ['work-signal', 'sweep'], { TYCON_INTEGRATIONS_DIR: ints }).status, 2);
    // el paso 9 corre después del merge, con el marker ya borrado: la story por argumento
    fs.rmSync(path.join(home, '.claude', '.tycon-pipeline', 'active', `${sid}.json`));
    assert.equal(correr740(home, sid, 'pipeline.js', ['work-signal', 'stop'], { TYCON_INTEGRATIONS_DIR: ints, TYCON_TIME_TRACKING: 'fake' }).status, 1, 'sin marker ni story no sabe de qué historia');
    const r9 = correr740(home, sid, 'pipeline.js', ['work-signal', 'stop', '--story', path.join(repo, 'story.md'), '--repo', repo], { TYCON_INTEGRATIONS_DIR: ints, TYCON_TIME_TRACKING: 'fake', B2_SECONDS: '1080' });
    assert.equal(r9.status, 0, r9.stderr);
    assert.equal(JSON.parse(r9.stdout).hours, 0.3);
    // la sesión sale de la misma cadena que el marker: bajo Codex llega la suya, no ninguna
    const conStory = (story, extra) => {
      const r = correr740(home, sid, 'pipeline.js', ['work-signal', 'start', '--story', story, '--repo', repo], { TYCON_INTEGRATIONS_DIR: ints, TYCON_TIME_TRACKING: 'fake', ...extra });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const codex = correr740(home, sid, 'pipeline.js', ['work-signal', 'start', '--story', path.join(repo, 'story.md'), '--repo', repo],
      { TYCON_INTEGRATIONS_DIR: ints, TYCON_TIME_TRACKING: 'fake', CODEX_SESSION_ID: 'cdx-1', CLAUDE_CODE_SESSION_ID: '' });
    assert.equal(codex.status, 0, codex.stderr);
    assert.match(JSON.parse(codex.stdout).action, / en cdx-1$/, 'la sesión de Codex llega a la integración');
    // una story guardada en Windows (CRLF y marca de orden de bytes) se lee igual
    const crlf = path.join(repo, 'story-crlf.md');
    fs.writeFileSync(crlf, '﻿---\r\nstory: "9.9"\r\ntitle: "Con finales de Windows"\r\nstatus: in-progress\r\n---\r\n# x\r\n');
    assert.match(conStory(crlf, {}).action, /^abrí 9\.9 — Con finales de Windows en /);
    // una clave vacía es vacía: no se lleva la de abajo
    const vacia = path.join(repo, 'story-vacia.md');
    fs.writeFileSync(vacia, '---\nstory: "9.9"\ntitle:\nstatus: ready\n---\n# x\n');
    assert.doesNotMatch(conStory(vacia, {}).action, /status/, 'el título vacío no toma el renglón siguiente');
    const sinId = path.join(repo, 'story-sin-id.md');
    fs.writeFileSync(sinId, '---\nstory:\ntitle: algo\n---\n# x\n');
    assert.equal(correr740(home, sid, 'pipeline.js', ['work-signal', 'stop', '--story', sinId], { TYCON_INTEGRATIONS_DIR: ints, TYCON_TIME_TRACKING: 'fake' }).status, 1, 'sin id no inventa uno con la clave de abajo');
    // el evento del arnés presente y que no carga se dice como tal, no como «no está»
    const roto = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-arnes-roto-'));
    fs.mkdirSync(path.join(roto, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(roto, 'scripts', 'install-tycon-hooks.sh'), '');   // lo que lo hace un clon del arnés
    fs.writeFileSync(path.join(roto, 'scripts', 'lib', 'work-signal.js'), "throw new Error('roto a propósito');\n");
    const r = correr740(home, sid, 'pipeline.js', ['work-signal', 'stop', '--story', path.join(repo, 'story.md')], { TYCON_GUIDES_DIR: roto });
    fs.rmSync(roto, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no carga \(roto a propósito\)/);
    assert.doesNotMatch(r.stderr, /no trae el evento/);
  } finally {
    for (const d of [home, repo, ints]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── El cierre de una ejecución que trabajó sin anotar pasos ─────────────────────────────────────────────────────
// `marker.js clear` avisa y deja RUN_CLOSED_WITHOUT_STEPS en bypass.log cuando la ejecución tocó archivos y no completó
// ningún paso después del arranque. Nunca frena el cierre.
function cerrarSinPasos(extra) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cierre-sin-pasos-'));
  const sid = 'sid-cierre-sin-pasos';
  writeFakeMarker(home, sid, { storyId: 'S9', repoPath: path.join(home, 'no-existe'), stepsCompleted: [0], stepsPending: [1, 2, 3], ...extra });
  const r = require('child_process').spawnSync(process.execPath, [MARKER, 'clear'],
    { env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_NO_RUN_CHANGE: '1' }, encoding: 'utf8' });
  const state = path.join(home, '.claude', '.tycon-pipeline');
  let bypass = '';
  try { bypass = fs.readFileSync(path.join(state, 'bypass.log'), 'utf8'); } catch { /* sin constancia */ }
  const lineas = bypass.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.kind === 'RUN_CLOSED_WITHOUT_STEPS');
  return { home, sid, r, state, lineas };
}
const TRES = ['/tmp/proy/src/a.js', '/tmp/proy/src/b.js', '/tmp/proy/README.md'];

test('CierreSinPasos_EsquemaNuevo @story-7.23 @ac-8 — con los pasos por nombre, el Arranque solo también avisa; un paso más, no', () => {
  const solo = cerrarSinPasos({ filesTouched: TRES, stepScheme: 2, stepsCompleted: ['start'], stepsPending: ['validate-story', 'plan'] });
  const mas = cerrarSinPasos({ filesTouched: TRES, stepScheme: 2, stepsCompleted: ['start', 'validate-story'], stepsPending: ['plan'] });
  try {
    assert.match(solo.r.stderr, /no anotó/);
    assert.equal(solo.lineas.length, 1);
    assert.doesNotMatch(mas.r.stderr, /no anotó/);
    assert.equal(mas.lineas.length, 0);
  } finally { for (const c of [solo, mas]) fs.rmSync(c.home, { recursive: true, force: true }); }
});

test('CierreSinPasos_Avisa @story-7.33 @ac-1', () => {
  const c = cerrarSinPasos({ filesTouched: TRES });
  try {
    assert.match(c.r.stderr, /tocó 3 archivo/);
    assert.match(c.r.stderr, /no anotó/);
    assert.match(c.r.stderr, /\d+ min/);
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

test('CierreSinPasos_Constancia @story-7.33 @ac-2', () => {
  const c = cerrarSinPasos({ filesTouched: TRES });
  try {
    assert.equal(c.lineas.length, 1, 'una sola constancia');
    const l = c.lineas[0];
    assert.equal(l.storyId, 'S9');
    assert.equal(l.files, 3);
    assert.deepEqual(l.sample, TRES);
    assert.ok(Number.isInteger(l.minutes) && l.minutes > 0, `minutos: ${l.minutes}`);
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

test('CierreConPasos_NoAvisa @story-7.33 @ac-3', () => {
  const c = cerrarSinPasos({ filesTouched: TRES, stepsCompleted: [0, 1, 2] });
  try {
    assert.doesNotMatch(c.r.stderr, /no anotó/);
    assert.equal(c.lineas.length, 0);
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

test('CierreSinArchivos_NoAvisa @story-7.33 @ac-3', () => {
  const c = cerrarSinPasos({ filesTouched: ['/tmp/proy/.advisors/pipeline-runs/x/step-01-validator.md'], stepsCompleted: [0, '0b'] });
  try {
    assert.doesNotMatch(c.r.stderr, /no anotó/);
    assert.equal(c.lineas.length, 0);
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

test('CierreSinPasos_NoFrena @story-7.33 @ac-4', () => {
  const c = cerrarSinPasos({ filesTouched: TRES });
  try {
    assert.equal(c.r.status, 0, c.r.stderr);
    assert.ok(!fs.existsSync(path.join(c.state, 'active', `${c.sid}.json`)), 'el marcador se borró');
    const hist = fs.readdirSync(path.join(c.state, 'timing-history'));
    assert.ok(hist.some((f) => f.startsWith('S9-')), `archivado: ${hist}`);
  } finally { fs.rmSync(c.home, { recursive: true, force: true }); }
});

test('CierreSinPasos_SinHoraYGitRoto_AvisaIgualYNoFrena @story-7.33 @ac-1 @ac-4', () => {
  const repo = mkTmpRepo();
  const c = cerrarSinPasos({ filesTouched: TRES, repoPath: repo, baseSha: 'no-es-un-commit', startedAt: undefined });
  try {
    assert.equal(c.r.status, 0, c.r.stderr);
    assert.match(c.r.stderr, /tocó 3 archivo\(s\) en \? min/);
    assert.equal(c.lineas.length, 1);
    assert.equal(c.lineas[0].minutes, null);
    assert.ok(!fs.existsSync(path.join(c.state, 'active', `${c.sid}.json`)), 'el marcador se borró');
  } finally {
    for (const d of [c.home, repo]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('CierreSinPasos_CuentaLoCambiadoEnGit @story-7.33 @ac-1 @ac-2', () => {
  const repo = mkTmpRepo();
  fs.writeFileSync(path.join(repo, 'a.js'), 'uno\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'a.js'), 'dos\n');
  fs.writeFileSync(path.join(repo, 'nuevo.js'), 'tres\n');
  fs.mkdirSync(path.join(repo, '.advisors'));
  fs.writeFileSync(path.join(repo, '.advisors', 'x.md'), 'no cuenta\n');
  const c = cerrarSinPasos({ filesTouched: [], repoPath: repo, baseSha: base });
  try {
    assert.match(c.r.stderr, /tocó 2 archivo/);
    assert.equal(c.lineas.length, 1);
    assert.deepEqual([...c.lineas[0].sample].sort(), ['a.js', 'nuevo.js']);
  } finally {
    for (const d of [c.home, repo]) fs.rmSync(d, { recursive: true, force: true });
  }
});
