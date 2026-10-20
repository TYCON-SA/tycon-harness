#!/usr/bin/env node
/**
 * first-screen-story.test.js — la primera historia con pantalla, sin trabas.
 *
 * Caso: en el laboratorio de la primera historia con pantalla, (1) la guía del tester le pedía al «equipo» la
 * dirección de la app a un dev que trabaja solo, (2) la maqueta y la guía de una historia suelta en `specs/` cayeron en
 * `qa/` de la raíz y no en `specs/qa/`, y (3) el revisor de la historia decidía por terminación de archivo que no había
 * pantalla mientras el cierre, que mira las rutas, la exigía.
 *
 *   T1-T4   la guía de modo primera vez: sin pedidos al equipo y con «Abrir la app:»
 *   T5-T9   una sola regla para la carpeta qa/
 *   T10-T13 el veredicto de pantalla lo calcula el arnés y el revisor lo usa
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/first-screen-story.test.js < /dev/null
 */
'use strict';
// stable-data: la hora de ahora es a propósito: la matriz descarta la evidencia más vieja que el código, y una hora fija
// se pudriría. El código de juguete se fecha una hora antes del humo, que corre en el momento.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const SCRIPTS = path.join(__dirname, '..');
const SKILL = path.join(SCRIPTS, '..');
const ROOT = path.join(SKILL, '..', '..');
const QA = path.join(SCRIPTS, 'qa-guide.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const SMOKE_RUN = path.join(SCRIPTS, 'smoke-run.sh');

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
function escribir(file, txt) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, txt); }
function env(home) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0' };
  delete e.NODE_TEST_CONTEXT;
  return e;
}

/**
 * Una historia de pantalla con un criterio probado con un humo. `firstTime`: la marca `origin: first-time`;
 * `record`: además la constancia que deja el guion del modo primera vez.
 */
function storyCorrida({ pasos, firstTime = false, record = false }) {
  const repo = path.join(tmp('primera-pantalla-'), 'tienda');
  const dodDir = path.join(repo, '.advisors', 'dod-runtime');
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  fs.mkdirSync(dodDir, { recursive: true });
  const code = path.join(repo, 'frontend', 'src', 'main.js');
  escribir(code, 'document.body.textContent = "$ 1.234,50";\n');
  const hace1h = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(code, hace1h, hace1h);
  const storyPath = path.join(repo, 'stories', '1-1-precio.md');
  escribir(storyPath, [
    '---', 'story: "1.1"', 'status: in-progress', ...(firstTime ? ['origin: first-time'] : []),
    'files_to_modify:', '  - frontend/src/main.js', '---', '',
    '## Acceptance Criteria', '', '1. **Given** el producto **Then** el precio se muestra en pesos.', '',
    '### Tests', '', '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|',
    '| T1 | `Precio_EnPesos` | 1 | unit | x | y |', '',
  ].join('\n'));
  escribir(path.join(repo, 'qa', '1.1-pasos.md'), pasos);
  escribir(path.join(repo, 'qa', '1.1-legibilidad.md'), 'veredicto: OK\n');
  const home = tmp('primera-pantalla-home-');
  if (record) require(path.join(SCRIPTS, 'lib', 'first-time-record.js')).writeRecord(home, storyPath, '1.1');
  const smoke = spawnSync('bash', [SMOKE_RUN, dodDir, '1.1', '--acs', '1', '--pass-if', 'en pesos', '--', 'echo', 'en pesos'],
    { env: { ...process.env, HOME: home }, cwd: repo, encoding: 'utf8' });
  assert.equal(smoke.status, 0, `${smoke.stdout}\n${smoke.stderr}`);
  return { repo, storyPath, home };
}

function qa(f, ...flags) {
  const r = spawnSync(process.execPath, [QA, '--story', f.storyPath, ...flags], { encoding: 'utf8', input: '', env: env(f.home), cwd: f.repo });
  return { rc: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const ABRIR = 'Abrir la app: en la carpeta frontend, python3 -m http.server 8000; después abrí http://localhost:8000';
const PASOS = (cabecera, paso) => [
  ...cabecera, 'Usuario por defecto: cualquier visitante', '', '## AC 1', 'El precio se ve en pesos.', '',
  `- ${paso}`, '→ Dice «$ 1.234,50».', '',
].join('\n');
const EQUIPO_RE = /equipo/i;
const ABRIR_RE = /Abrir la app/;

test('FirstScreen_PrimeraVez_PedidoAlEquipo_Frena @story-8.67.1 @ac-1 — un dev solo no tiene a quién pedirle', () => {
  const f = storyCorrida({ pasos: PASOS([ABRIR, ''], 'Pedile al equipo la dirección de la tienda y abrila.'), firstTime: true, record: true });
  const r = qa(f, '--check');
  assert.equal(r.rc, 2, r.out);
  assert.match(r.out, /Pedile al equipo la dirección/, r.out);
  assert.match(r.out, /trabaja sola/, r.out);
});

test('FirstScreen_PrimeraVez_SinAbrirLaApp_Frena @story-8.67.1 @ac-2 — la guía tiene que decir cómo abrir la app', () => {
  const f = storyCorrida({ pasos: PASOS([], 'Abrí la página del producto.'), firstTime: true, record: true });
  const r = qa(f, '--check');
  assert.equal(r.rc, 2, r.out);
  assert.match(r.out, /Abrir la app:/, r.out);
});

test('FirstScreen_PrimeraVez_ConAbrirLaApp_Pasa @story-8.67.1 @ac-2 — con la línea, pasa y la guía la muestra arriba', () => {
  const f = storyCorrida({ pasos: PASOS([ABRIR, ''], 'Abrí la página del producto.'), firstTime: true, record: true });
  const r = qa(f, '--check');
  assert.doesNotMatch(r.out, EQUIPO_RE, r.out);
  assert.doesNotMatch(r.out, /Abrir la app:/, r.out);
  assert.doesNotMatch(r.out, /JERGA/, r.out);
  const out = path.join(f.repo, 'guia.html');
  const g = qa(f, '--out', out);
  assert.equal(g.rc, 0, g.out);
  const html = fs.readFileSync(out, 'utf8');
  const antes = html.indexOf('Antes de empezar');
  assert.ok(antes > 0, 'la guía no trae «Antes de empezar»');
  assert.ok(html.indexOf('http://localhost:8000') > antes, 'la dirección no está en el bloque');
  assert.ok(antes < html.indexOf('AC #1'), '«Antes de empezar» no está antes del primer caso');
});

test('FirstScreen_HistoriaNormal_NoCambia @story-8.67.1 @ac-3 — fuera del modo primera vez, como hoy', () => {
  const pasos = PASOS([], 'Pedile al equipo la dirección de la tienda y abrila.');
  for (const opts of [{ pasos }, { pasos, firstTime: true, record: false }]) {
    const f = storyCorrida(opts);
    const r = qa(f, '--check');
    assert.doesNotMatch(r.out, /trabaja sola/, r.out);
    assert.doesNotMatch(r.out, ABRIR_RE, r.out);
  }
});

// ── La carpeta qa/ ──────────────────────────────────────────────────────────────────────────────────────────────────
const { qaDirFor } = (() => { try { return require(path.join(SCRIPTS, 'lib', 'qa-dir.js')); } catch { return {}; } })();
function repoVacio() { return path.join(tmp('qa-dir-'), 'repo'); }

test('FirstScreen_QaDir_SueltaEnSpecs @story-8.67.1 @ac-4 — historia suelta en specs/ → specs/qa/', () => {
  assert.equal(typeof qaDirFor, 'function', 'falta lib/qa-dir.js');
  const r = repoVacio();
  const s = path.join(r, 'specs', 'story-1.1-x.md'); escribir(s, '---\nstory: "1.1"\n---\n');
  assert.equal(qaDirFor(s, ['1.1']), path.join(r, 'specs', 'qa'));
});

test('FirstScreen_QaDir_CarpetaDeHistorias @story-8.67.1 @ac-4 — carpeta de historias → qa/ al lado', () => {
  assert.equal(typeof qaDirFor, 'function', 'falta lib/qa-dir.js');
  const r = repoVacio();
  const a = path.join(r, 'specs', 'stories', '1-1-x.md'); escribir(a, '');
  const b = path.join(r, 'stories', '1-1-x.md'); escribir(b, '');
  const c = path.join(r, 'docs', 'historias', '1-1-x.md'); escribir(c, '');
  assert.equal(qaDirFor(a, ['1.1']), path.join(r, 'specs', 'qa'));
  assert.equal(qaDirFor(b, ['1.1']), path.join(r, 'qa'));
  assert.equal(qaDirFor(c, ['1.1']), path.join(r, 'docs', 'qa'));
});

test('FirstScreen_QaDir_RepoQueYaUsaLaRaiz @story-8.67.1 @ac-4 — un repo que ya usa qa/ de la raíz no se parte', () => {
  assert.equal(typeof qaDirFor, 'function', 'falta lib/qa-dir.js');
  const r = repoVacio();
  const s = path.join(r, 'specs', 'story-2.1-x.md'); escribir(s, '');
  escribir(path.join(r, 'qa', 'A-1-pasos.md'), 'otra historia\n');
  assert.equal(qaDirFor(s, ['2.1']), path.join(r, 'qa'));
  fs.mkdirSync(path.join(r, 'specs', 'qa'));
  assert.equal(qaDirFor(s, ['2.1']), path.join(r, 'specs', 'qa'));
});

function storySuelta() {
  const repo = path.join(tmp('qa-suelta-'), 'proj');
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, '.advisors', 'dod-runtime'), { recursive: true });
  escribir(path.join(repo, 'frontend', 'src', 'main.js'), 'x\n');
  const storyPath = path.join(repo, 'specs', 'story-3.1-precio.md');
  escribir(storyPath, [
    '---', 'story: "3.1"', 'status: in-progress', 'files_to_modify:', '  - frontend/src/main.js', '---', '',
    '## Acceptance Criteria', '', '1. **Given** algo **Then** otra cosa.', '',
    '### Tests', '', '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|',
    '| T1 | `A_B` | 1 | unit | x | y |', '',
  ].join('\n'));
  return { repo, storyPath };
}

test('FirstScreen_QaDir_TodosUsanLaMisma @story-8.67.1 @ac-4 — la guía, el freno del commit y la maqueta, en specs/qa/', () => {
  const { repo, storyPath } = storySuelta();
  const want = path.join(repo, 'specs', 'qa');
  const gate = require(path.join(SCRIPTS, 'lib', 'atdd-commit-gate.js'));
  const qaGuide = require(QA);
  const mockup = require(path.join(SCRIPTS, 'mockup.js'));
  assert.equal(path.dirname(gate.qaGuidePathFor(storyPath)), want);
  assert.equal(qaGuide.qaLocation(storyPath).qaDir, want);
  assert.equal(path.dirname(mockup.mockupPaths(storyPath).mockup), want);
  for (const rel of ['qa-guide.js', 'lib/atdd-commit-gate.js', 'on-pre-commit.js']) {
    const txt = fs.readFileSync(path.join(SCRIPTS, rel), 'utf8');
    assert.doesNotMatch(txt, /['"]qa['"]/, `${rel} todavía calcula la carpeta qa/ por su cuenta`);
  }
});

test('FirstScreen_QaDir_HistoriaEmpezadaNoSeMuda @story-8.67.1 @ac-5 — lo que ya está en el lugar viejo se sigue encontrando', () => {
  const { repo, storyPath } = storySuelta();
  escribir(path.join(repo, 'qa', '3.1-mockup.html'), '<html></html>\n');
  escribir(path.join(repo, 'qa', '3.1-mockup-approval.json'), '{}\n');
  escribir(path.join(repo, 'specs', 'qa', '9.9-pasos.md'), 'otra historia\n');
  const qaGuide = require(QA);
  const mockup = require(path.join(SCRIPTS, 'mockup.js'));
  assert.equal(qaGuide.qaLocation(storyPath).qaDir, path.join(repo, 'qa'));
  assert.equal(mockup.mockupPaths(storyPath).mockup, path.join(repo, 'qa', '3.1-mockup.html'));
});

// ── El veredicto de pantalla ────────────────────────────────────────────────────────────────────────────────────────
function orgRules(storyPath) {
  const home = tmp('org-rules-home-');
  const args = [PIPELINE, 'org-rules', ...(storyPath ? ['--story', storyPath] : [])];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', input: '', env: env(home), cwd: storyPath ? path.dirname(storyPath) : home });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('FirstScreen_Veredicto_JsEnFrontend_Si @story-8.67.1 @ac-6 — un .js en frontend/ es pantalla para el arnés', () => {
  const { storyPath } = storySuelta();
  const r = orgRules(storyPath);
  assert.ok(r.screen, JSON.stringify(r));
  assert.equal(r.screen.ui, true);
  assert.ok(String(r.screen.why || '').trim(), 'sin el porqué');
});

test('FirstScreen_Veredicto_SoloBackend_No @story-8.67.1 @ac-6 — sólo .cs no es pantalla; sin --story no hay veredicto', () => {
  const repo = path.join(tmp('org-back-'), 'api');
  const s = path.join(repo, 'specs', 'story-4.1-x.md');
  escribir(s, ['---', 'story: "4.1"', 'files_to_modify:', '  - src/Api/Pedidos.cs', '---', '', '# x', ''].join('\n'));
  assert.equal(orgRules(s).screen.ui, false);
  assert.equal(orgRules(null).screen, null);
  const ilegible = orgRules(path.join(repo, 'specs', 'no-existe.md'));
  assert.equal(ilegible.screen, null);
  assert.ok(ilegible.problems.some((p) => /veredicto de pantalla/.test(p)), JSON.stringify(ilegible.problems));
});

test('FirstScreen_Instrucciones_PasoUnoLlevaElVeredicto @story-8.67.1 @ac-6 — el paso 1 pasa el veredicto al revisor', () => {
  const txt = fs.readFileSync(path.join(SKILL, 'steps', 'step-01-validate-story.md'), 'utf8');
  assert.match(txt, /org-rules --story/);
  assert.match(txt, /tiene pantalla según el arnés/);
});

test('FirstScreen_Revisor_NoDeducePorTerminacion @story-8.67.1 @ac-7 — el revisor usa el veredicto, no las terminaciones', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'agents', 'tycon-story-validator.md'), 'utf8');
  assert.doesNotMatch(txt, /la story que nombra `\.tsx`, `\.jsx`, `\.svelte` o `\.vue`/);
  assert.match(txt, /tiene pantalla según el arnés/);
  assert.match(txt, /no recibí el veredicto de pantalla del arnés/);
});
