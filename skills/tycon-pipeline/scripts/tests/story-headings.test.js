#!/usr/bin/env node
/**
 * story-headings.test.js — los títulos de criterios y de pruebas se leen con cualquier forma, y una story sin
 * criterios nunca cierra en verde.
 *
 * El caso: una story en inglés con «## Acceptance criteria» (minúscula) y «## Tests». Si el título no se reconoce, el
 * control de criterios no lee ninguno, el revisor de cobertura de criterios no entra al set y el paso de revisores
 * cierra en verde sin haber revisado nada. Lo mismo con un criterio escrito en una forma que el lector no conoce
 * (Gherkin, «Dado/Cuando/Entonces», «**AC-1:**», «- **AC1 — título**»).
 *
 * Qué fija: (1) una sola función lee las secciones, con cualquier mayúscula y con ## o ###; (2) las siete formas de
 * criterio viven en una lista y las tres viejas mandan; (3) sin criterios entra siempre el revisor de cobertura de
 * criterios y el pre-commit frena el cierre; (4) ningún otro archivo busca esos títulos o esas formas por su cuenta.
 *
 * Nunca se toca la casa real: lo que escribe estado corre con un HOME falso.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/story-headings.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const ROOT = path.resolve(SCRIPTS, '..', '..', '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const HOOK = path.join(SCRIPTS, 'on-pre-commit.js');
const sc = require(path.join(SCRIPTS, 'lib', 'story-checks.js'));

const fm = (status = 'in-progress') => ['---', 'epic: 1', 'story: "1.1"', 'title: "x"', `status: ${status}`, '---', ''].join('\n');

// Una story de una organización en inglés: título en minúscula, tabla con ## Tests.
const LAB_STORY = `${fm()}
# Story 1.1 — Greeting can be shouted

## Context

The greeting endpoint and the Greeting component return a polite message.

## Acceptance criteria

1. **Given** \`GET /greeting/{name}?shout=true\` **When** it is called **Then** the message is in upper case.
2. **Given** \`GET /greeting/{name}\` without \`shout\` **When** it is called **Then** the message is unchanged.
3. **Given** the Greeting component with \`shout\` set **When** it renders **Then** the heading is in upper case.

## Tests

| ID | Name | AC | Type |
|---|---|---|---|
| T1 | \`test_greeting_shout_upper_case\` | 1 | unit (pytest) |
| T2 | \`test_greeting_returns_message\` | 2 | unit (pytest) |
| T3 | \`greeting renders shouted name\` | 3 | unit (vitest) |

## Tasks

- [ ] 1. Add shout.
`;

const conSeccion = (titulo, cuerpo) => `${fm()}\n# Story 1.1\n\n${titulo}\n\n${cuerpo}\n\n## Tasks\n\n- [ ] 1. x\n`;

function tmp(t, prefijo) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function envLimpio(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ['TYCON_HOME', 'NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID',
    'TYCON_WAIVER_LOG', 'DOD_BYPASS', 'TYCON_PACKS_DIR']) delete env[k];
  return env;
}

// ── La función única ──────────────────────────────────────────────────────────

test('T1 StorySection_Criteria_AnyCaseAndLevel', () => {
  for (const titulo of ['## Acceptance criteria', '### acceptance criteria', '## ACCEPTANCE CRITERIA',
    '## Criterios de aceptación', '## Criterios de aceptacion']) {
    const s = sc.storySection(conSeccion(titulo, '1. **Given** a **When** b **Then** c.'), 'criteria');
    assert.ok(s, `no leyó «${titulo}»`);
    assert.equal(s.level, titulo.indexOf(' '), `nivel de «${titulo}»`);
    assert.match(s.text, /\*\*Given\*\* a/);
  }
  for (const titulo of ['# Acceptance Criteria', '#### Acceptance Criteria']) {
    assert.equal(sc.storySection(conSeccion(titulo, '1. x'), 'criteria'), null, `«${titulo}» no es un título de criterios`);
  }
});

test('T2 StorySection_Criteria_IgnoresFrontmatter', () => {
  const s = ['---', 'story: "1.1"', 'nota: "la sección `## Acceptance Criteria` va abajo"', '---', '', '# Story', '', 'Sin criterios.', ''].join('\n');
  assert.equal(sc.storySection(s, 'criteria'), null);
});

test('T3 StorySection_Tests_AnyCaseAndSuffix', () => {
  const tabla = '| ID | Test | AC |\n|---|---|---|\n| T1 | `A` | 1 |';
  const a = sc.storySection(conSeccion('## Tests', tabla), 'tests');
  const b = sc.storySection(conSeccion('### tests (3 verificaciones)', tabla), 'tests');
  assert.ok(a && b);
  assert.match(a.text, /\| T1 \|/);
  assert.match(b.text, /\| T1 \|/);
  assert.equal(sc.storySection(conSeccion('## Tests corridos', tabla), 'tests'), null, '«Tests corridos» es evidencia, no la tabla de la story');
  assert.equal(sc.storySection(conSeccion('## Tests-result', tabla), 'tests'), null, '«Tests-result» no es la tabla de la story');
});

// ── La story del laboratorio en todos los lectores ───────────────────────────

test('T4 LabStory_AllReaders_SeeThreeCriteria', (t) => {
  assert.deepEqual(sc.parseAcsFromSpec(LAB_STORY), [1, 2, 3]);
  const tabla = sc.parseTestsTable(LAB_STORY);
  assert.equal(tabla.rows.length, 3);

  const repo = tmp(t, 'tycon-8-61-lab-');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const storyPath = path.join(repo, 'specs', 'story-1.1-greeting.md');
  fs.mkdirSync(path.dirname(storyPath), { recursive: true });
  fs.writeFileSync(storyPath, LAB_STORY);
  const r = sc.runStoryChecks({ repo, storyPath, files: [] });
  assert.equal(r.stats.acs, 3);
  assert.ok(!r.ambiguous.some((a) => /No se encontró la sección/.test(a.detail)), JSON.stringify(r.ambiguous));

  const qa = require(path.join(SCRIPTS, 'qa-guide.js'));
  assert.equal(qa.parseAcsWithText(LAB_STORY).length, 3);
  assert.equal(qa.parseTestsFull(LAB_STORY).length, 3);
  const atdd = require(path.join(SCRIPTS, 'lib', 'atdd-preedit.js'));
  assert.equal(atdd.storyDeclaresTests(LAB_STORY), true);

  const matriz = require(path.join(SCRIPTS, 'runtime-matrix.js')).compute({ storyPath, repoRoot: repo, workspaceRoot: repo });
  assert.equal(matriz.structuralError, undefined, matriz.structuralError);
  assert.deepEqual(Object.keys(matriz.perAc).map(Number).sort(), [1, 2, 3]);
});

function correrAdvisors(t, storyText, extra = []) {
  const base = tmp(t, 'tycon-8-61-adv-');
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'specs', 'story-1.1.md'), storyText);
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'module.exports = 1;\n');
  const r = spawnSync(process.execPath, [PIPELINE, 'advisors', '--repo', repo, '--story', path.join(repo, 'specs', 'story-1.1.md'),
    '--files', 'src/app.js', ...extra], { cwd: repo, env: envLimpio(home), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('T5 LabStory_Advisors_IncludesAcCoverage', (t) => {
  const out = correrAdvisors(t, LAB_STORY);
  assert.ok(out.all.includes('tycon-ac-coverage-checker'), JSON.stringify(out.all));
});

function armarCommit(t, storyFinal) {
  const base = tmp(t, 'tycon-8-61-hook-');
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a],
    { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-19T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-19T12:00:00Z' } });
  git('init', '-q', '-b', 'main', '.');
  const rel = 'specs/story-1.1-greeting.md';
  fs.writeFileSync(path.join(repo, rel), storyFinal.replace(/^status: .*$/m, 'status: ready-for-dev'));
  git('add', rel); git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(repo, rel), storyFinal.replace(/^status: .*$/m, 'status: review'));
  git('add', rel);
  return { repo, home, rel };
}

function correrHook({ repo, home }) {
  const env = { ...envLimpio(home), TYCON_CLOSURE_RECORD: 'off', TYCON_ADVISORS_GATE: 'off' };
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: repo, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'headings-test', cwd: repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "story 1.1 a review"' } }),
  });
  return { code: r.status, err: r.stderr || '' };
}

// La carpeta del estado de una HOME, preguntada a quien la decide (como el hook).
function stateDirDe(home) {
  const lib = path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js');
  if (!fs.existsSync(lib)) return path.join(home, '.claude', '.tycon-pipeline');
  const env = { ...process.env }; delete env.TYCON_HOME;
  return execFileSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(lib)}).stateDir(${JSON.stringify(home)}))`],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('T6 LabStory_PreCommitGates_ReadCriteria', (t) => {
  const c = armarCommit(t, LAB_STORY);
  const r = correrHook(c);
  assert.doesNotMatch(r.err, /no encontré los criterios/i, r.err);
  // el portón de la guía de QA la miró: deja su constancia (antes la salteaba por el título en minúscula)
  const log = path.join(stateDirDe(c.home), 'gates.log');
  const lineas = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  assert.ok(lineas.some((l) => l.name === 'qa-guide' && String(l.story || '').endsWith(c.rel)), `sin constancia de la guía de QA:\n${r.err}`);
});

// ── Las cuatro formas (cada caso lleva la marca de su forma: la guardiana T18 la cuenta) ──

const GHERKIN = conSeccion('## Acceptance Criteria', [
  '### Happy Path', '', '```gherkin', 'GIVEN alfa uno', 'WHEN beta uno', 'THEN gama uno', '```', '',
  'GIVEN alfa dos', 'WHEN beta dos', 'THEN gama dos', '', '**Given** alfa tres **When** beta tres **Then** gama tres',
].join('\n'));

test('T7 AcForms_Gherkin_ThreeCriteria @forma-gherkin', () => {
  assert.deepEqual(sc.parseAcsFromSpec(GHERKIN), [1, 2, 3]);
  const textos = sc.acTextsFromSpec(GHERKIN);
  assert.match(textos[1], /alfa uno/);
  assert.match(textos[2], /alfa dos/);
  assert.match(textos[3], /alfa tres/);
});

test('T8 AcForms_Dado_TwoCriteria @forma-dado', () => {
  const s = conSeccion('## Criterios de aceptación', [
    '**Dado** el repositorio clonado', '**Cuando** se ejecuta la story', '**Entonces** existen los archivos', '',
    '**Dado** el directorio creado', '**Cuando** se corre el script', '**Entonces** termina sin errores',
  ].join('\n'));
  assert.deepEqual(sc.parseAcsFromSpec(s), [1, 2]);
  assert.match(sc.acTextsFromSpec(s)[2], /directorio creado/);
});

test('T9 AcForms_BoldAc_UnderGroupHeadings @forma-ac-negrita', () => {
  const s = conSeccion('## Acceptance Criteria', [
    '### Aislamiento de fallos', '', '**AC-1: Aislamiento en el arranque**', '**Given** un servicio que falla',
    '**When** arranca **Then** los otros siguen', '', '### Reintentos', '', '**AC-2: Reintento acotado**',
    '**Given** un error transitorio **When** reintenta **Then** para a los tres intentos',
  ].join('\n'));
  assert.deepEqual(sc.parseAcsFromSpec(s), [1, 2]);
  assert.match(sc.acTextsFromSpec(s)[2], /Reintento acotado/);
});

test('T10 AcForms_TitledBullet_FourCriteria @forma-ac-vineta-titulada', () => {
  const s = conSeccion('## Acceptance Criteria', [
    '### Flujo principal', '',
    '- **AC1 — La celda se pinta distinto**: un artículo sólo para retirar muestra el precio y el aviso.',
    '- **AC2 — El pie cuenta los cuatro estados**: exactos, aproximados, para retirar y sin stock.',
    '- **AC3 — Lo que es para retirar no suma**: el total no incluye esos artículos.',
    '- **AC4: El enlace abre el carrito**: el botón lleva al carrito del comercio.',
  ].join('\n'));
  assert.deepEqual(sc.parseAcsFromSpec(s), [1, 2, 3, 4]);
  assert.match(sc.acTextsFromSpec(s)[3], /no suma/);
});

test('T11 AcForms_OldFormsWin_SameCount @forma-titulo-ac @forma-numerada @forma-vineta-ac', () => {
  const numerada = conSeccion('## Acceptance Criteria', '1. **Given** a.\n2. texto pelado.\n3. **Given** c.');
  const titulos = conSeccion('## Acceptance Criteria', '### AC-1 — uno\n\n1. sub\n2. sub\n\n### AC-2 — dos\n\n1. sub');
  const vinetas = conSeccion('## Acceptance Criteria', '- **AC1**: uno\n- **AC2**: dos');
  const mezcla = conSeccion('## Acceptance Criteria', '1. **Given** a **When** b **Then** c.\n2. otra.\n\nGIVEN algo suelto\nWHEN pasa\nTHEN se ve');
  assert.deepEqual(sc.parseAcsFromSpec(numerada), [1, 2, 3]);
  assert.deepEqual(sc.parseAcsFromSpec(titulos), [1, 2]);
  assert.deepEqual(sc.parseAcsFromSpec(vinetas), [1, 2]);
  assert.deepEqual(sc.parseAcsFromSpec(mezcla), [1, 2], 'con una forma vieja presente, las nuevas no suman');
});

// ── Lo que encontró el pase adversarial ───────────────────────────────────────

test('T20 StorySection_IgnoresHeadingsInsideCodeBlocks', () => {
  const bash = conSeccion('## Acceptance Criteria', '1. corre\n```bash\n# instalar\nnpm i\n```\n2. segundo\n3. tercero');
  assert.deepEqual(sc.parseAcsFromSpec(bash), [1, 2, 3], 'un comentario de bash dentro del bloque no corta la sección');
  const gherkin = conSeccion('## Acceptance Criteria', '```gherkin\n# language: es\nGiven x\nWhen y\nThen z\n\n# otro escenario\nGiven a\nThen b\n```');
  assert.deepEqual(sc.parseAcsFromSpec(gherkin), [1, 2], 'un comentario de Gherkin no corta la sección');
  const ejemplo = `${fm()}\n# Story\n\n## Acceptance Criteria\n\n1. a\n\n\`\`\`markdown\n## Tests\n\`\`\`\n\n## Tests\n\n| ID | Test | AC |\n|---|---|---|\n| T1 | \`A\` | 1 |\n`;
  assert.match(sc.storySection(ejemplo, 'tests').text, /\| T1 \|/, 'un título dentro de un bloque de ejemplo no es la tabla');
});

test('T21 StorySection_Level3Title_WithAcHeadings', () => {
  const s = conSeccion('### Acceptance Criteria', '### AC-1 — uno\ntexto\n\n### AC-2 — dos\ntexto');
  assert.deepEqual(sc.parseAcsFromSpec(s), [1, 2]);
  assert.deepEqual(sc.criteriaOf(s).acs, [1, 2]);
});

test('T22 AcForms_StarBulletAndVariants', () => {
  const casos = [
    ['* **AC1**: a\n* **AC2**: b', [1, 2]],
    ['- **Given** x **When** y **Then** z\n- **Given** a **Then** b', [1, 2]],
    ['given a\nwhen b\nthen c', [1]],
    ['**DADO** x **CUANDO** y **ENTONCES** z', [1]],
    ['Dada una story\nCuando corre\nEntonces pasa\n\nDados dos\nCuando x\nEntonces y', [1, 2]],
  ];
  for (const [cuerpo, esperado] of casos) {
    assert.deepEqual(sc.parseAcsFromSpec(conSeccion('## Acceptance Criteria', cuerpo)), esperado, cuerpo);
  }
});

test('T23 PreCommit_NoCriteria_RecordedAsStructural', () => {
  // la constancia traduce el motivo con REGLA_DE_MOTIVO y lo normaliza con el vocabulario cerrado de guard-record.js
  const { REGLA_DE_MOTIVO } = require(HOOK);
  const { reglaNormalizada } = require(path.join(ROOT, 'scripts', 'lib', 'guard-record.js'));
  assert.equal(REGLA_DE_MOTIVO['no-criteria'], 'matriz-estructural');
  assert.equal(reglaNormalizada('on-pre-commit', REGLA_DE_MOTIVO['no-criteria']), 'matriz-estructural', 'no queda como «otra»');
});

test('T24 Digest_KeepsWholeCriteriaAndTests', () => {
  const { buildStoryDigest } = require(PIPELINE);
  const s = conSeccion('## Acceptance Criteria', [
    '### AC-1 — uno', 'texto del primero', '```bash', '# un comentario', 'ls', '```', 'sigue el primero',
    '', '### AC-2 — dos', 'texto del segundo',
  ].join('\n')) + '\n### Tests\n\n| ID | Test | AC |\n|---|---|---|\n| T1 | `A` | 1 |\n';
  const d = buildStoryDigest(s);
  for (const parte of ['texto del primero', 'sigue el primero', 'texto del segundo', '| T1 |']) {
    assert.ok(d.includes(parte), `el resumen no trae «${parte}»:\n${d}`);
  }
});

test('T25 Criteria_TestsGroupWithoutTable_DoesNotEnd', () => {
  // `### Tests` como grupo de criterios (viñetas, sin tabla): no corta; el de story-format, con su tabla, sí
  const grupo = conSeccion('## Acceptance Criteria', '### Lógica\n- **AC1**: uno\n\n### Tests\n- **AC2**: dos\n\n### General\n- **AC3**: tres') +
    '\n## Tests\n\n| ID | Test | AC |\n|---|---|---|\n| T1 | `A` | 1 |\n';
  assert.deepEqual(sc.parseAcsFromSpec(grupo), [1, 2, 3]);
  const canonica = conSeccion('## Acceptance Criteria', '1. **Given** a.\n2. **Given** b.\n\n### Tests (2 verificaciones)\n\n| ID | Test | AC |\n|---|---|---|\n| 3. | `x` | 1 |');
  assert.deepEqual(sc.parseAcsFromSpec(canonica), [1, 2], 'la tabla de story-format sigue cortando la sección');
});

// ── Falla cerrada ─────────────────────────────────────────────────────────────

const SIN_TITULO = `${fm()}\n# Story 1.1\n\n## Context\n\nAlgo.\n\n### Tests\n\n| ID | Test | AC |\n|---|---|---|\n| T1 | \`A\` | 1 |\n`;
const SIN_FORMA = conSeccion('## Acceptance Criteria', 'El endpoint responde bien y la pantalla lo muestra.');

test('T12 Advisors_NoCriteria_AcCoverageWithReason', (t) => {
  for (const story of [SIN_TITULO, SIN_FORMA]) {
    assert.equal(sc.parseAcsFromSpec(story).length, 0);
    const out = correrAdvisors(t, story);
    assert.ok(out.completitud.includes('tycon-ac-coverage-checker'), JSON.stringify(out.completitud));
    assert.ok((out.completitud_motivos || []).some((m) => /sin criterios detectados/.test(m)), JSON.stringify(out.completitud_motivos));
  }
});

test('T13 Advisors_NoCriteria_NotDiscountedIter2', (t) => {
  const out = correrAdvisors(t, SIN_FORMA, ['--iter', '2']);
  assert.ok(out.all.includes('tycon-ac-coverage-checker'), JSON.stringify(out));
  assert.ok(!(out.mech_discounted || []).some((d) => d.name === 'tycon-ac-coverage-checker'));
});

test('T14 PreCommitGates_NoCriteria_StagedToReview_Blocks', (t) => {
  const c = armarCommit(t, SIN_FORMA);
  const r = correrHook(c);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /no encontré los criterios/i);
  assert.ok(r.err.includes(c.rel), 'el mensaje nombra la story');
  assert.match(r.err, /story-format\.md/, 'el mensaje dice cómo arreglarla');
});

test('T14 (tanda) PreCommitGates_NoCriteria_TandaToDone_Blocks', (t) => {
  // la story sigue in-progress; lo que se cierra es una tanda (`pipelines.<x>.status: done`)
  const base = tmp(t, 'tycon-8-61-tanda-');
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a],
    { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-19T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-19T12:00:00Z' } });
  git('init', '-q', '-b', 'main', '.');
  const rel = 'specs/story-1.1-greeting.md';
  const conTanda = (estado) => SIN_FORMA.replace('---\n\n', `pipelines:\n  back:\n    status: ${estado}\n---\n\n`);
  fs.writeFileSync(path.join(repo, rel), conTanda('in-progress'));
  git('add', rel); git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(repo, rel), conTanda('done'));
  git('add', rel);
  const r = correrHook({ repo, home });
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /no encontré los criterios/i);
});

test('T15 PreCommitGates_NoCriteria_NotStaged_Passes', (t) => {
  const c = armarCommit(t, LAB_STORY);
  fs.writeFileSync(path.join(c.repo, 'specs', 'story-9.9-vieja.md'), SIN_FORMA.replace('story: "1.1"', 'story: "9.9"').replace(/^status: .*$/m, 'status: review'));
  const r = correrHook(c);
  assert.doesNotMatch(r.err, /no encontré los criterios/i, r.err);
});

test('T16 PreCommit_LibMissing_FailsClosed', (t) => {
  const hook = require(HOOK);
  const log = path.join(tmp(t, 'tycon-8-61-log-'), 'hook-errors.log');
  const r = hook.parseAcsFromSpec(LAB_STORY, { cargar: () => { throw new Error('sin biblioteca'); }, logPath: log });
  assert.equal(r, null, 'sin la biblioteca no se cuentan criterios con una expresión propia');
  assert.match(fs.readFileSync(log, 'utf8'), /sin biblioteca/);
});

// ── Que no vuelva ─────────────────────────────────────────────────────────────

// Las expresiones que delatan un lector propio: títulos de criterios o de pruebas de la story, o formas de criterio.
const SENALES = [/acceptance criteria/i, /criterios de aceptaci/i, /(\\s|\[ \\t\]|#)\+?\s?Tests\\b/, /### Tests/, /\\\*\\\*AC/, /\bGIVEN\b/, /\\\*\\\*Dado/];
const CONTEXTO_REGEX = /(\.test\(|\.match\(|\.matchAll\(|\.exec\(|\.split\(\/|\.replace\(\/|new RegExp\(|_RE\s*=\s*\/)/;

function lectoresPropios(raiz, rel = '') {
  const hallados = [];
  const dir = path.join(raiz, rel);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'tests', 'test', '__tests__'].includes(e.name)) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { hallados.push(...lectoresPropios(raiz, r)); continue; }
    if (!/\.(c|m)?js$/.test(e.name) || /\.test\.(c|m)?js$/.test(e.name)) continue;
    if (r.split(path.sep).join('/').endsWith('tycon-pipeline/scripts/lib/story-checks.js')) continue;
    const lineas = fs.readFileSync(path.join(raiz, r), 'utf8').split('\n');
    lineas.forEach((linea, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(linea) || /Tests corridos/.test(linea)) return;
      // la llamada puede estar en la línea de arriba (`body.match(` y la expresión debajo)
      if (!CONTEXTO_REGEX.test(linea) && !(/^\s*\//.test(linea) && CONTEXTO_REGEX.test(lineas[i - 1] || ''))) return;
      if (SENALES.some((s) => s.test(linea))) hallados.push(`${r}:${i + 1}`);
    });
  }
  return hallados;
}

test('T17 Guard_NoOwnHeadingOrFormRegex', (t) => {
  const hallados = [...lectoresPropios(ROOT, 'skills'), ...lectoresPropios(ROOT, 'scripts')];
  assert.deepEqual(hallados, [], 'leen títulos o formas de criterio con una expresión propia (usar story-checks.js):\n' + hallados.join('\n'));
  const plantado = tmp(t, 'tycon-8-61-guard-');
  fs.mkdirSync(path.join(plantado, 'scripts'));
  fs.writeFileSync(path.join(plantado, 'scripts', 'lector.js'), "const ok = /^##\\s+Acceptance Criteria/m.test(s);\n");
  assert.deepEqual(lectoresPropios(plantado, 'scripts'), [path.join('scripts', 'lector.js') + ':1']);
});

test('T18 Guard_AcForms_SevenWithCases', () => {
  assert.equal(sc.AC_FORMS.length, 7);
  const propio = fs.readFileSync(__filename, 'utf8');
  const guia = fs.readFileSync(path.join(ROOT, 'story-format.md'), 'utf8');
  for (const f of sc.AC_FORMS) {
    assert.ok(propio.includes(`@forma-${f.name}`), `la forma «${f.name}» no tiene su caso en esta suite`);
    assert.ok(guia.includes(`\`${f.name}\``), `story-format.md no nombra la forma «${f.name}»`);
  }
});
