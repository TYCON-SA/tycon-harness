'use strict';
/**
 * approvals.test.js — cada aprobación queda anotada como manual (una persona con nombre) o automática (un
 * agente o una regla), y la de un agente nunca cuenta como la de una persona.
 *
 * T1-T3 ejercen la biblioteca (lib/approvals.js). T4 corre el marcador de verdad (marker.js CLI contra un HOME
 * temporal, como story-gate-cli.test.js). T5, T6 y T8 corren el portón de CI (scripts/ci/tycon-ci-gate.js) sobre un repo
 * de juguete con git. T7 lee las dos guías.
 *
 * 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const GATE = path.join(RAIZ, 'scripts', 'ci', 'tycon-ci-gate.js');
const approvals = require(path.join(SCRIPTS, 'lib', 'approvals.js'));
const { conVentana } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'window-passed.js'));

function tmp(prefijo) { return fs.mkdtempSync(path.join(os.tmpdir(), prefijo)); }
// Commits de juguete con fecha fija y sin el mantenimiento automático de git (guides/test-execution-discipline.md).
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-10-19T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-19T12:00:00Z' };
function gitEn(repo) {
  return (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: GIT_ENV });
}
function lineas(runDir) {
  return fs.readFileSync(path.join(runDir, approvals.FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

// ── T1-T3: la biblioteca ────────────────────────────────────────────────────────────────────────

test('T1 Registro_LineaCompleta @story-2.43 @ac-1', () => {
  const dir = tmp('apr-t1-');
  const l = approvals.anotar(dir, { que: 'plan', tipo: 'manual', quien: 'ana@example.com', via: 'chat', commit: 'abc1234' });
  assert.equal(l.tipo, 'manual');
  const [leida] = lineas(dir);
  assert.deepEqual(Object.keys(leida).sort(), ['commit', 'cuando', 'que', 'quien', 'tipo', 'via']);
  assert.equal(leida.que, 'plan');
  assert.equal(leida.quien, 'ana@example.com');
  assert.equal(leida.commit, 'abc1234');
  assert.match(leida.cuando, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(approvals.validar(leida), []);
});

test('T2 Registro_AgenteNuncaManual @story-2.43 @ac-2', () => {
  const dir = tmp('apr-t2-');
  // Un agente anotado como manual: queda automático.
  const a = approvals.anotar(dir, { que: 'plan', tipo: 'manual', quien: 'agente coordinadora (claude-opus-5-5)', via: 'chat' });
  assert.equal(a.tipo, 'automatica');
  // Un modelo sin la palabra «agente» también es un agente.
  const b = approvals.anotar(dir, { que: 'plan', tipo: 'manual', quien: 'claude-sonnet-5-5', via: 'chat' });
  assert.equal(b.tipo, 'automatica');
  // Una delegación de una persona a un agente: automática, nombrando de quién es la delegación.
  const c = approvals.anotar(dir, { que: 'plan', tipo: 'manual', quien: 'coordinadora', delegacion: 'ana@example.com', via: 'chat' });
  assert.equal(c.tipo, 'automatica');
  assert.equal(c.delegacion, 'ana@example.com');
  // Lo que construye el marcador con --delegated-by.
  const q = approvals.quienDesdeOpciones({ delegatedBy: 'ana@example.com', agent: 'coordinadora (claude-opus-5-5)' });
  assert.deepEqual(q, { tipo: 'automatica', quien: 'agente coordinadora (claude-opus-5-5)', delegacion: 'ana@example.com' });
  // Un registro escrito a mano con un agente como manual no valida.
  assert.ok(approvals.validar({ que: 'plan', cuando: '2026-10-19T10:00:00Z', tipo: 'manual', quien: 'agente x (opus)' })
    .some((p) => p.regla === 'aprobacion-de-agente-como-manual'));
  assert.ok(approvals.validar({ que: 'plan', cuando: '2026-10-19T10:00:00Z', tipo: 'manual', quien: 'ana', delegacion: 'bob' })
    .some((p) => p.regla === 'aprobacion-de-agente-como-manual'));
});

test('T3 Registro_SinQuien_SinNombrar @story-2.43 @ac-2', () => {
  const dir = tmp('apr-t3-');
  const l = approvals.anotar(dir, { que: 'plan', via: 'chat' });
  assert.equal(l.tipo, 'automatica');
  assert.equal(l.quien, approvals.SIN_NOMBRAR);
  // Manual sin quién tampoco pasa por manual.
  const m = approvals.anotar(dir, { que: 'plan', tipo: 'manual', quien: '  ' });
  assert.equal(m.tipo, 'automatica');
  assert.equal(m.quien, approvals.SIN_NOMBRAR);
  assert.deepEqual(approvals.quienDesdeOpciones({}), { tipo: 'automatica', quien: approvals.SIN_NOMBRAR });
});

test('T2 Registro_AgenteNuncaManual — los agentes del repo y los correos (pase adversarial) @story-2.43 @ac-2', () => {
  // Nombres reales de agentes del arnés, sin la palabra «agente» ni un modelo: no pasan por personas.
  for (const q of ['tycon-silent-failure-hunter', 'general-purpose', 'reviewer-bot', 'migration-impact-analyzer', 'Explore']) {
    assert.equal(approvals.normalizar({ que: 'plan', tipo: 'manual', quien: q }).tipo, 'automatica', q);
    assert.ok(approvals.validar({ que: 'plan', cuando: 'x', tipo: 'manual', quien: q }).some((p) => p.regla === 'aprobacion-de-agente-como-manual'), q);
  }
  // Un correo es una persona, aunque su nombre suene a rol; un noreply no.
  assert.equal(approvals.normalizar({ que: 'plan', tipo: 'manual', quien: 'coordinadora@example.org' }).tipo, 'manual');
  assert.equal(approvals.normalizar({ que: 'plan', tipo: 'manual', quien: 'claude.perez@example.org' }).tipo, 'manual');
  assert.equal(approvals.normalizar({ que: 'plan', tipo: 'manual', quien: 'noreply@anthropic.com' }).tipo, 'automatica');
  // un apellido que termina en «bot» es una persona; un bot se nombra como palabra
  for (const persona of ['talbot@example.com', 'abbot@example.com']) assert.equal(approvals.esAgente(persona), false, persona);
  for (const bot of ['ci-bot@example.com', 'bot@example.com', 'release.bot@example.com', 'deploy_bot@example.com']) assert.equal(approvals.esAgente(bot), true, bot);
  // Ante la duda, automática: un usuario suelto que se llama como un rol de agente.
  assert.equal(approvals.normalizar({ que: 'plan', tipo: 'manual', quien: 'coordinadora' }).tipo, 'automatica');
});

test('T3 Registro_SinQuien_SinNombrar — una línea cruda sin quién cuenta como sin nombrar (pase adversarial) @story-2.43 @ac-2', () => {
  const crudas = [{ que: 'plan', cuando: 'x', tipo: 'automatica' }, { que: 'plan', cuando: 'x', tipo: 'automatica', quien: '' }];
  for (const l of crudas) assert.deepEqual(approvals.validar(l), []);
  assert.deepEqual(approvals.resumir(crudas), { manual: 0, automatica: 2, sinNombrar: 2 });
});

test('T4 Marker_AprobacionesQueYaExisten_SeAnotan — la firma por terminal es manual, una línea por AC @story-2.43 @ac-3', () => {
  // runtime-waiver exige una terminal real (el agente no la tiene): se prueba la forma de las líneas que anota.
  const ls = approvals.lineasDeFirmaPorTerminal([2, 5], 'ana');
  assert.deepEqual(ls.map((l) => [l.que, l.tipo, l.quien]), [['AC 2 imposible de verificar en vivo', 'manual', 'ana'], ['AC 5 imposible de verificar en vivo', 'manual', 'ana']]);
  const fuente = fs.readFileSync(path.join(SCRIPTS, 'marker.js'), 'utf8');
  assert.match(fuente, /lineasDeFirmaPorTerminal\(approved, approvedBy\)/, 'runtime-waiver anota con esta función, después de firmar');
});

// ── T4: el marcador anota lo que ya se aprueba ──────────────────────────────────────────────────

// Cada repo de juguete en su carpeta padre propia: varias detecciones del arnés miran los repos hermanos.
function repoPropio(prefijo) { const r = path.join(tmp(prefijo), 'repo'); fs.mkdirSync(r); return r; }

function repoConStory() {
  const repo = repoPropio('apr-repo-');
  const git = gitEn(repo);
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'specs'));
  const story = path.join(repo, 'specs', 'story-9.91-juguete.md');
  fs.writeFileSync(story, [
    '---', 'story: "9.91"', 'title: "juguete"', 'status: in-progress',
    'files_to_modify:', '  - README.md', '---', '', '# Story 9.91', '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  return { repo, story };
}

// La firma del plan y de la maqueta la da el dueño en la ventana de permiso; acá se da por pasada (window-passed.js)
// para probar lo que el marcador anota después.
function markerCli(home, sid, cwd, args) {
  return spawnSync('node', [path.join(SCRIPTS, 'marker.js'), ...args], {
    cwd, encoding: 'utf8',
    env: conVentana({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0' }),
  });
}

function markerHasta3(home, sid, repo, story, storyId = '9.91') {
  const set = markerCli(home, sid, repo, ['set', JSON.stringify({ storyId, storyPath: story, repoPath: repo })]);
  assert.equal(set.status, 0, set.stderr);
  for (const n of ['0', '1', '2']) markerCli(home, sid, repo, ['complete-step', n]);
}

test('T4 Marker_AprobacionesQueYaExisten_SeAnotan @story-2.43 @ac-3', () => {
  const { repo, story } = repoConStory();
  const home = tmp('apr-home-');
  const runDirDe = () => require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '9.91', false, story);

  markerHasta3(home, 's-manual', repo, story);
  let r = markerCli(home, 's-manual', repo, ['complete-step', '3', '--approved', 'dale', '--approved-by', 'ana@example.com']);
  assert.equal(r.status, 0, r.stderr);

  markerHasta3(home, 's-deleg', repo, story);
  r = markerCli(home, 's-deleg', repo, ['complete-step', '3', '--approved', 'aprobado', '--delegated-by', 'ana@example.com',
    '--agent', 'coordinadora (claude-opus-5-5)']);
  assert.equal(r.status, 0, r.stderr);

  markerHasta3(home, 's-auto', repo, story);
  // el plan aprobado solo se muestra igual: escrito, y en la respuesta del agente (plan-visible.test.js)
  const planAuto = '1. El README con el título nuevo del proyecto.\n';
  fs.writeFileSync(path.join(require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '9.91', true, story), 'step-02-bmad-plan.md'), planAuto);
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-repo'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', '-repo', 's-auto.jsonl'),
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `El plan:\n${planAuto}` }] } })}\n`);
  r = markerCli(home, 's-auto', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.equal(r.status, 0, r.stderr);

  const runDir = runDirDe();
  assert.ok(runDir, 'el marcador crea la carpeta de la corrida');
  // la exención de un CRITICAL ya no la anota el paso 7: la deja `waive-critical` con el ok de una persona
  // (critical-waiver.test.js). Un WARNING eximido no deja línea.
  fs.writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify([
    { rule_id: 'SEC-W1', severity: 'WARNING', advisor: 'tycon-plugin-security-basics', file: 'README.md', disposition: 'waived', reason: 'no aplica' },
  ]));
  r = markerCli(home, 's-auto', repo, ['complete-step', '7', '--approved-by', 'ana@example.com']);
  assert.equal(r.status, 0, r.stderr);

  const ls = lineas(runDir);
  assert.equal(ls.length, 3, JSON.stringify(ls));
  const [plan, deleg, auto] = ls;
  assert.deepEqual([plan.que, plan.tipo, plan.quien], ['plan', 'manual', 'ana@example.com']);
  assert.deepEqual([deleg.que, deleg.tipo, deleg.delegacion], ['plan', 'automatica', 'ana@example.com']);
  assert.match(deleg.quien, /coordinadora/);
  assert.deepEqual([auto.que, auto.tipo], ['plan', 'automatica']);
  assert.match(auto.quien, /^regla /);
  for (const l of ls) assert.match(l.commit || '', /^[0-9a-f]{7,40}$/);
});

test('T4 Marker_AprobacionesQueYaExisten_SeAnotan — la maqueta, con el plan y por approve-mockup @story-2.43 @ac-3', () => {
  // En una carpeta padre propia: la detección de pantalla mira también los repos hermanos, y la carpeta temporal del
  // sistema tiene miles (como mockup.test.js).
  const repo = path.join(tmp('apr-mk-'), 'repo');
  fs.mkdirSync(repo);
  const git = gitEn(repo);
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'specs'));
  const story = path.join(repo, 'specs', 'story-9.94-pantalla.md');
  fs.writeFileSync(story, ['---', 'story: "9.94"', 'title: "pantalla"', 'status: in-progress',
    'files_to_modify:', '  - src/components/Facturas.tsx', '---', '', '# Story 9.94', '',
    '## Acceptance Criteria', '', '1. **Given** un cliente **When** abre la lista **Then** ve sus facturas.', '',
    '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
    '| T1 | `Lista_MuestraFacturas` | 1 | e2e | x | y |', ''].join('\n'));
  fs.mkdirSync(path.join(repo, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'components', 'Facturas.tsx'), 'export {}\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const modelo = path.join(repo, 'modelo.json');
  const pantalla = (texto) => fs.writeFileSync(modelo, JSON.stringify({ title: 'Facturas', screens: [{ name: 'Lista', state: 'con facturas', elements: [{ kind: 'heading', text: texto }] }] }));
  pantalla('Facturas de Acme SA');
  const render = () => spawnSync('node', [path.join(SCRIPTS, 'mockup.js'), 'render', '--data', modelo, '--story', story], { encoding: 'utf8' });
  let r = render();
  assert.equal(r.status, 0, r.stderr);
  const home = tmp('apr-home-');
  markerHasta3(home, 's-mk', repo, story, '9.94');
  r = markerCli(home, 's-mk', repo, ['complete-step', '3', '--approved', 'dale', '--approved-by', 'ana@example.com', '--mockup-approved', 'la maqueta también']);
  assert.equal(r.status, 0, r.stderr);
  pantalla('Facturas pendientes de Acme SA');
  r = render();
  assert.equal(r.status, 0, r.stderr);
  r = markerCli(home, 's-mk', repo, ['approve-mockup', '--approved', 'la nueva', '--delegated-by', 'ana@example.com', '--agent', 'coordinadora (claude-opus-5-5)']);
  assert.equal(r.status, 0, r.stderr);
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '9.94', false, story);
  assert.deepEqual(lineas(runDir).map((l) => [l.que, l.tipo, l.delegacion || null]),
    [['plan', 'manual', null], ['maqueta', 'manual', null], ['maqueta', 'automatica', 'ana@example.com']]);
});

test('T4 Marker_AprobacionesQueYaExisten_SeAnotan — una exención sin constancia frena el 7, y si no puede anotar avisa y sigue @story-2.43 @ac-3 @story-8.63 @ac-6', () => {
  const { repo, story } = repoConStory();
  const home = tmp('apr-home-');
  markerHasta3(home, 's-x', repo, story);
  let r = markerCli(home, 's-x', repo, ['complete-step', '3', '--approved', 'dale', '--approved-by', 'ana@example.com']);
  assert.equal(r.status, 0, r.stderr);
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '9.91', false, story);
  // Paso 7 sin findings.json: el 7 corre con críticos, así que sin hallazgos que mirar no cierra
  r = markerCli(home, 's-x', repo, ['complete-step', '7', '--approved-by', 'ana@example.com']);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /falta findings\.json/);
  fs.writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify([{ rule_id: 'SEC-C2', severity: 'CRITICAL', advisor: 'x', file: 'a', disposition: 'waived', reason: 'r' }]));
  // una delegación al cerrar el paso ya no exime: falta la constancia del ok
  r = markerCli(home, 's-x', repo, ['complete-step', '7', '--delegated-by', 'ana@example.com', '--agent', 'coordinadora (claude-opus-5-5)']);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /SEC-C2/);
  assert.equal(lineas(runDir).find((l) => /SEC-C2/.test(l.que)), undefined);

  // Sin dónde escribir (`.advisors` es un archivo): el paso cierra igual y lo avisa.
  const otro = repoConStory();
  fs.writeFileSync(path.join(otro.repo, '.advisors'), 'no soy una carpeta\n');
  markerHasta3(home, 's-y', otro.repo, otro.story);
  r = markerCli(home, 's-y', otro.repo, ['complete-step', '3', '--approved', 'dale', '--approved-by', 'ana@example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no pude anotar la aprobación «plan»/);
});

// ── T5, T6, T8: el portón ───────────────────────────────────────────────────────────────────────

// Un repo con una story que pasa de in-progress a review en HEAD, con su carpeta de corrida (posterior al corte) ya
// commiteada. `conRoster`: la corrida llegó a los revisores. `registro`: las líneas de approvals.jsonl (null = sin
// archivo).
function repoParaElPorton({ registro, conRoster = true, declara = true, exento = false, crudo = '' }) {
  const repo = repoPropio('apr-gate-');
  const git = gitEn(repo);
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'specs'));
  const story = path.join(repo, 'specs', 'story-9.92-juguete.md');
  const fm = (st) => ['---', 'story: "9.92"', 'title: "juguete"', `status: ${st}`, 'dod_runtime_exempt: true',
    'dod_runtime_exempt_reason: "juguete"', ...(exento ? ['advisors_exempt: true', 'advisors_exempt_reason: "juguete"'] : []),
    '---', '', '# Story 9.92', ''].join('\n');
  fs.writeFileSync(story, fm('in-progress'));
  git('add', '.'); git('commit', '-qm', 'base');
  const runDir = path.join(repo, '.advisors', 'pipeline-runs', '9.92-20991231120000');
  fs.mkdirSync(runDir, { recursive: true });
  // La marca la pone el hook de un arnés que ya anota aprobaciones; un roster de un arnés viejo no la trae.
  if (conRoster) fs.writeFileSync(path.join(runDir, 'review-roster.json'), JSON.stringify(declara ? { registro_aprobaciones: 1 } : {}) + '\n');
  if (registro) fs.writeFileSync(path.join(runDir, approvals.FILE), registro.map((l) => JSON.stringify(l)).join('\n') + '\n' + crudo);
  fs.writeFileSync(story, fm('review'));
  git('add', '.'); git('commit', '-qm', 'a review');
  return repo;
}

function porton(repo) {
  const r = spawnSync('node', [GATE, '--repo', repo, '--base', 'HEAD~1'], { encoding: 'utf8' });
  const j = spawnSync('node', [GATE, '--repo', repo, '--base', 'HEAD~1', '--json'], { encoding: 'utf8' });
  return { status: r.status, salida: r.stdout + r.stderr, json: JSON.parse(j.stdout) };
}

const ap = (que, tipo, quien, extra = {}) => ({ que, cuando: '2099-12-31T12:00:00Z', commit: 'abc1234', tipo, quien, via: 'chat', ...extra });

test('T5 Porton_AgenteComoPersona_Frena @story-2.43 @ac-4', () => {
  const repo = repoParaElPorton({ registro: [ap('plan', 'manual', 'agente coordinadora (claude-opus-5-5)')] });
  const { status, salida, json } = porton(repo);
  assert.equal(status, 1, salida);
  const h = json.hallazgos.find((x) => x.regla === 'aprobacion-de-agente-como-manual');
  assert.ok(h, JSON.stringify(json.hallazgos));
  assert.match(h.mensaje, /agente/);
});

test('T6 Porton_Resumen_ManualYAutomatica @story-2.43 @ac-4', () => {
  const repo = repoParaElPorton({ registro: [
    ap('plan', 'manual', 'ana@example.com'),
    ap('maqueta', 'manual', 'ana@example.com'),
    ap('plan', 'automatica', 'agente coordinadora (claude-opus-5-5)', { delegacion: 'ana@example.com' }),
    ap('plan', 'automatica', 'regla risk-class LOW'),
    ap('exencion SEC-C1', 'automatica', approvals.SIN_NOMBRAR),
  ] });
  const { status, salida, json } = porton(repo);
  assert.equal(status, 0, salida);
  assert.deepEqual(json.aprobaciones.map((a) => [a.story, a.manual, a.automatica, a.sinNombrar]), [['9.92', 2, 3, 1]]);
  assert.match(salida, /2 manual(es)? · 3 automáticas/);

  // Sin registro en una corrida que llegó a los revisores: frena.
  const sin = porton(repoParaElPorton({ registro: null }));
  assert.equal(sin.status, 1, sin.salida);
  assert.ok(sin.json.hallazgos.some((x) => x.regla === 'sin-registro-de-aprobaciones'), JSON.stringify(sin.json.hallazgos));
  // Una corrida que no llegó a los revisores no tuvo por qué anotar nada.
  const corta = porton(repoParaElPorton({ registro: null, conRoster: false }));
  assert.ok(!corta.json.hallazgos.some((x) => /aprobaci/.test(x.regla)), JSON.stringify(corta.json.hallazgos));
});

test('T8 Porton_SinLineaDelPlan_Frena @story-2.43 @ac-4', () => {
  const repo = repoParaElPorton({ registro: [ap('maqueta', 'manual', 'ana@example.com')] });
  const { status, salida, json } = porton(repo);
  assert.equal(status, 1, salida);
  assert.ok(json.hallazgos.some((x) => x.regla === 'sin-aprobacion-del-plan'), JSON.stringify(json.hallazgos));
});

test('T10 Porton_CorridaSinDeclarar_Avisa @story-2.43 @ac-4', () => {
  // Un dev con el arnés viejo: su corrida no escribe el registro y su roster no declara la marca. Avisa, no frena.
  const { status, salida, json } = porton(repoParaElPorton({ registro: null, declara: false }));
  assert.equal(status, 0, salida);
  assert.ok(!json.hallazgos.some((x) => /aprobaci/.test(x.regla)), JSON.stringify(json.hallazgos));
  assert.ok(json.avisos.some((x) => x.regla === 'sin-registro-de-aprobaciones'), JSON.stringify(json.avisos));
  assert.match(salida, /sin-registro-de-aprobaciones/);
  // Un registro presente y malo frena igual, declare o no la marca.
  const malo = porton(repoParaElPorton({ registro: [ap('plan', 'manual', 'claude-opus-5-5')], declara: false }));
  assert.equal(malo.status, 1, malo.salida);
  // El roster que escribe el arnés de hoy trae la marca.
  const roster = require(path.join(SCRIPTS, 'lib', 'review-roster.js')).build({ story: '9.92', ledgerLines: [], sessionId: 's' });
  assert.equal(roster.registro_aprobaciones, 1);
});

test('T5 Porton_AgenteComoPersona_Frena — también con advisors_exempt (pase adversarial) @story-2.43 @ac-4', () => {
  const repo = repoParaElPorton({ registro: [ap('plan', 'manual', 'tycon-silent-failure-hunter')], exento: true });
  const { status, salida, json } = porton(repo);
  assert.equal(status, 1, salida);
  assert.ok(json.hallazgos.some((x) => x.regla === 'aprobacion-de-agente-como-manual'), JSON.stringify(json.hallazgos));
  // La exención sí perdona que falte el registro.
  const falta = porton(repoParaElPorton({ registro: null, exento: true }));
  assert.ok(!falta.json.hallazgos.some((x) => /aprobaci/.test(x.regla)), JSON.stringify(falta.json.hallazgos));
});

test('T5 Porton_AgenteComoPersona_Frena — un registro ilegible o una regla que no carga frenan @story-2.43 @ac-4', () => {
  const repo = repoParaElPorton({ registro: [ap('plan', 'manual', 'ana@example.com')], crudo: 'esto no es json\n' });
  const { status, salida, json } = porton(repo);
  assert.equal(status, 1, salida);
  assert.ok(json.hallazgos.some((x) => x.regla === 'registro-de-aprobaciones-invalido'), JSON.stringify(json.hallazgos));
  // Las otras líneas inválidas del AC 4, con el portón real: sin `que`, sin `cuando`, con un tipo desconocido.
  for (const mala of [{ cuando: 'x', tipo: 'automatica', quien: 'regla x' }, { que: 'plan', tipo: 'automatica', quien: 'regla x' }, { que: 'plan', cuando: 'x', tipo: 'humana', quien: 'ana@example.com' }]) {
    const r = porton(repoParaElPorton({ registro: [ap('plan', 'manual', 'ana@example.com'), mala] }));
    assert.equal(r.status, 1, JSON.stringify(mala));
    assert.ok(r.json.hallazgos.some((x) => x.regla === 'registro-de-aprobaciones-invalido'), JSON.stringify(r.json.hallazgos));
  }
  // Sin la regla del tipo (las skills en otro lado): «no lo pude revisar», no verde.
  const sinSkills = tmp('apr-sin-skills-');
  const j = spawnSync('node', [GATE, '--repo', repoParaElPorton({ registro: [ap('plan', 'manual', 'ana@example.com')] }), '--base', 'HEAD~1', '--json'],
    { encoding: 'utf8', env: { ...process.env, TYCON_SKILLS_DIR: sinSkills } });
  assert.equal(j.status, 1, j.stderr);
  assert.ok(JSON.parse(j.stdout).hallazgos.some((x) => x.regla === 'registro-de-aprobaciones-sin-revisar'), j.stdout);
});

// ── T9: el registro viaja ───────────────────────────────────────────────────────────────────────

test('T9 Arranque_GitignoreDejaViajarElRegistro @story-2.43 @ac-6', () => {
  const pipeline = require(path.join(SCRIPTS, 'pipeline.js'));
  const linea = '!**/.advisors/pipeline-runs/*/approvals.jsonl';
  const ignorado = (repo) => spawnSync('git', ['-C', repo, 'check-ignore', '-q', '--', '.advisors/pipeline-runs/9.93-20991231120000/approvals.jsonl']).status === 0;
  const aplicar = (repo) => {
    const { append } = pipeline.computeGitignoreNeeds(pipeline.gitIgnoraProbe(repo));
    if (append.length) fs.appendFileSync(path.join(repo, '.gitignore'), append.join('\n') + '\n');
    return append;
  };
  // Un repo con el bloque estándar de antes del registro de aprobaciones: lo ignora; el arranque agrega sólo la línea, una vez.
  const viejo = tmp('apr-gi-');
  gitEn(viejo)('init', '-q');
  const bloqueViejo = pipeline.GITIGNORE_ADVISORS.filter((l) => l !== linea);
  fs.writeFileSync(path.join(viejo, '.gitignore'), [...bloqueViejo, '.dashboard/'].join('\n') + '\n');
  assert.equal(ignorado(viejo), true);
  assert.deepEqual(aplicar(viejo).filter((l) => !l.startsWith('#')), [linea]);
  assert.equal(ignorado(viejo), false);
  assert.deepEqual(aplicar(viejo), [], 'idempotente');
  // Un repo sin bloque: el bloque estándar entero ya trae la línea.
  const nuevo = tmp('apr-gi-');
  gitEn(nuevo)('init', '-q');
  assert.ok(aplicar(nuevo).includes(linea));
  assert.equal(ignorado(nuevo), false);
  // Un repo que decidió ignorar `.advisors/` entero no se toca (es su decisión; el aviso de siempre lo dice).
  const todo = tmp('apr-gi-');
  gitEn(todo)('init', '-q');
  fs.writeFileSync(path.join(todo, '.gitignore'), '.advisors/\n.dashboard/\n');
  assert.deepEqual(aplicar(todo), []);
});

// ── T7: las guías ───────────────────────────────────────────────────────────────────────────────

test('T7 Guia_ManualOAutomatica @story-2.43 @ac-5', () => {
  for (const rel of [path.join('skills', 'tycon-pipeline', 'steps', 'step-04-approve-plan.md'), path.join('guides', 'ci-gate.md')]) {
    const txt = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
    assert.match(txt, /approvals\.jsonl/, `${rel}: nombra el registro`);
    assert.match(txt, /\*\*manual\*\*/i, `${rel}: define manual`);
    assert.match(txt, /\*\*autom[aá]tica\*\*/i, `${rel}: define automática`);
    assert.match(txt, /--approved-by/, `${rel}: cómo se nombra a la persona`);
    assert.match(txt, /--delegated-by/, `${rel}: cómo se anota la delegación`);
  }
});

// ── T10: un archivo suelto en packs/ no es un paquete ───────────────────────────────────────────────

test('T10 KnownAgents_FileInPacks_NoWarning @story-7.35 @ac-9', () => {
  // un checkout de mentira con la forma del real: approvals.js lee agents/ y packs/*/agents/ desde su propia raíz
  const raiz = tmp('apr-packs-');
  const lib = path.join(raiz, 'skills', 'tycon-pipeline', 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(SCRIPTS, 'lib', 'approvals.js'), path.join(lib, 'approvals.js'));
  fs.mkdirSync(path.join(raiz, 'packs', 'acme', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'packs', 'README.md'), '# paquetes\n');
  fs.writeFileSync(path.join(raiz, 'packs', 'acme', 'agents', 'revisor-de-acme.md'), '---\nname: revisor-de-acme\n---\n');
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(path.join(lib, 'approvals.js'))}).esAgente('revisor-de-acme')))`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'true', 'el agente del paquete sigue contando');
  assert.equal(r.stderr, '', `sin aviso por packs/README.md: ${r.stderr}`);
});

// ── La aprobación llega al repo de la story, y el cierre frena en la máquina si falta ───────────────────────────────

// La story en un repo y el código en otro, cada uno con su git y en su carpeta padre propia.
function dosRepos({ pantalla = false } = {}) {
  const storyRepo = repoPropio('apr-story-');
  const codeRepo = repoPropio('apr-code-');
  for (const r of [storyRepo, codeRepo]) {
    const git = gitEn(r);
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  }
  fs.mkdirSync(path.join(storyRepo, 'specs'));
  const story = path.join(storyRepo, 'specs', 'story-9.95-juguete.md');
  const archivo = pantalla ? 'src/components/Facturas.tsx' : 'README.md';
  const cuerpo = pantalla
    ? ['## Acceptance Criteria', '', '1. **Given** un cliente **When** abre la lista **Then** ve sus facturas.', '',
      '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
      '| T1 | `Lista_MuestraFacturas` | 1 | e2e | x | y |', '']
    : [];
  fs.writeFileSync(story, ['---', 'story: "9.95"', 'title: "juguete"', 'status: in-progress',
    'files_to_modify:', `  - ${archivo}`, '---', '', '# Story 9.95', '', ...cuerpo].join('\n'));
  fs.mkdirSync(path.dirname(path.join(codeRepo, archivo)), { recursive: true });
  fs.writeFileSync(path.join(codeRepo, archivo), pantalla ? 'export {}\n' : 'x\n');
  for (const r of [storyRepo, codeRepo]) { const git = gitEn(r); git('add', '.'); git('commit', '-qm', 'base'); }
  return { storyRepo, codeRepo, story };
}
const enLaStory = (storyRepo, runDir) => path.join(storyRepo, '.advisors', 'pipeline-runs', path.basename(runDir));
const queDe = (runDir) => (fs.existsSync(path.join(runDir, approvals.FILE)) ? lineas(runDir).map((l) => l.que) : []);
const gatesDe = (home) => {
  const p = path.join(home, '.claude', '.tycon-pipeline', 'gates.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('Aprobar_Plan_AnotaEnLosDosRepos @story-8.133 @ac-5', () => {
  const { storyRepo, codeRepo, story } = dosRepos();
  const home = tmp('apr-home-');
  markerHasta3(home, 's-dos', codeRepo, story, '9.95');
  const r = markerCli(home, 's-dos', codeRepo, ['complete-step', '3', '--approved', 'dale', '--approved-by', 'ana@example.com']);
  assert.equal(r.status, 0, r.stderr);
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(codeRepo, '9.95', false, story);
  assert.deepEqual(queDe(runDir), ['plan']);
  assert.deepEqual(queDe(enLaStory(storyRepo, runDir)), ['plan'], 'la línea llega al repo de la story al aprobar');
});

test('Aprobar_Maqueta_AnotaEnLosDosRepos @story-8.133 @ac-6', () => {
  const { storyRepo, codeRepo, story } = dosRepos({ pantalla: true });
  const modelo = path.join(codeRepo, 'modelo.json');
  const pantalla = (texto) => fs.writeFileSync(modelo, JSON.stringify({ title: 'Facturas', screens: [{ name: 'Lista', state: 'con facturas', elements: [{ kind: 'heading', text: texto }] }] }));
  const render = () => spawnSync('node', [path.join(SCRIPTS, 'mockup.js'), 'render', '--data', modelo, '--story', story], { encoding: 'utf8' });
  pantalla('Facturas de Acme SA');
  let r = render();
  assert.equal(r.status, 0, r.stderr);
  const home = tmp('apr-home-');
  markerHasta3(home, 's-mk2', codeRepo, story, '9.95');
  r = markerCli(home, 's-mk2', codeRepo, ['complete-step', '3', '--approved', 'dale', '--approved-by', 'ana@example.com', '--mockup-approved', 'la maqueta también']);
  assert.equal(r.status, 0, r.stderr);
  pantalla('Facturas pendientes de Acme SA');
  r = render();
  assert.equal(r.status, 0, r.stderr);
  r = markerCli(home, 's-mk2', codeRepo, ['approve-mockup', '--approved', 'la nueva', '--approved-by', 'ana@example.com']);
  assert.equal(r.status, 0, r.stderr);
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(codeRepo, '9.95', false, story);
  assert.deepEqual(queDe(runDir), ['plan', 'maqueta', 'maqueta']);
  assert.deepEqual(queDe(enLaStory(storyRepo, runDir)), ['plan', 'maqueta', 'maqueta']);
});

test('Aprobar_ProyeccionFalla_AvisaYSigue @story-8.133 @ac-7', () => {
  const { storyRepo, codeRepo, story } = dosRepos();
  // el repo de la story no tiene dónde escribir la carpeta de la corrida
  fs.writeFileSync(path.join(storyRepo, '.advisors'), 'no soy una carpeta\n');
  const home = tmp('apr-home-');
  markerHasta3(home, 's-falla', codeRepo, story, '9.95');
  const r = markerCli(home, 's-falla', codeRepo, ['complete-step', '3', '--approved', 'dale', '--approved-by', 'ana@example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no llegó al repo de la story/);
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(codeRepo, '9.95', false, story);
  assert.deepEqual(queDe(runDir), ['plan'], 'en el repo del código queda anotada');
  const l = gatesDe(home).find((x) => x.name === 'approval-projection');
  assert.ok(l, 'gates.log lo anota');
  assert.equal(l.status, 'failed');
});

// El cierre: un marcador en «Preparar el commit» con la corrida abierta en el repo del código. Los demás frenos del
// cierre pueden frenar también; cada prueba mira la línea y el mensaje de éste.
const CORRIDA = '9.95-20991231120000';
const CORRIDA_RE = CORRIDA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SIN_DEL_ENTORNO = ['TYCON_NO_DEEP_REVIEW', 'DOD_BYPASS', 'TYCON_5B_EARLY', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'STOP_AUTONOMY'];
function marcadorDelCierre(home, { story, codeRepo, extra = {} }) {
  const activo = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activo, { recursive: true });
  // stable-data: el marcador tiene que estar fresco para marker.js, que lo mide contra el mismo reloj; ninguna
  // verificación compara la hora.
  const ahora = new Date().toISOString();
  fs.writeFileSync(path.join(activo, 's-cierre.json'), JSON.stringify({
    storyId: '9.95', storyPath: story, repoPath: codeRepo, sessionId: 's-cierre', startedAt: ahora, lastTouch: ahora,
    stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8], filesTouched: [], iterations: {}, fileEvents: [],
    clockiStarted: true, dodRuntimeChecked: true,
    adversarialSkip: { motivo: 'LOW', archivos: 1, forzado: false, abandonado: false, runId: null, at: ahora },
    ...extra,
  }));
}
function preparar({ storyRepo, codeRepo, story, registroCodigo = null, registroStory = null, rosterStory = { registro_aprobaciones: 1 }, extra = {} }) {
  const abierta = path.join(codeRepo, '.advisors', 'pipeline-runs', CORRIDA);
  fs.mkdirSync(abierta, { recursive: true });
  fs.writeFileSync(path.join(abierta, 'findings.json'), '[]');
  fs.writeFileSync(path.join(abierta, 'review-roster.json'), JSON.stringify(rosterStory || {}));
  if (registroCodigo !== null) fs.writeFileSync(path.join(abierta, approvals.FILE), registroCodigo);
  const proyectada = path.join(storyRepo, '.advisors', 'pipeline-runs', CORRIDA);
  if (storyRepo !== codeRepo) {
    fs.mkdirSync(proyectada, { recursive: true });
    if (rosterStory) fs.writeFileSync(path.join(proyectada, 'review-roster.json'), JSON.stringify(rosterStory));
    if (registroStory !== null) fs.writeFileSync(path.join(proyectada, approvals.FILE), registroStory);
  }
  const home = tmp('apr-cierre-');
  marcadorDelCierre(home, { story, codeRepo, extra });
  return { home, abierta, proyectada };
}
function cerrar(home, cwd) {
  const env = { ...process.env };
  for (const k of SIN_DEL_ENTORNO) delete env[k];
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'marker.js'), 'complete-step', '8'], {
    cwd, encoding: 'utf8', env: { ...env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 's-cierre', TYCON_LANE_LLM: '0' },
  });
  return { status: r.status, stderr: r.stderr || '', freno: gatesDe(home).filter((x) => x.name === 'approvals-story-repo') };
}
const plan = `${JSON.stringify(ap('plan', 'manual', 'ana@example.com'))}\n`;
const maqueta = `${JSON.stringify(ap('maqueta', 'manual', 'ana@example.com'))}\n`;
const MAQUETA = { mockupApproval: { file: 'maqueta.html', sha256: 'x', mode: 'user', text: 'dale', at: '2099-12-31T12:00:00Z' } };

test('Cierre_CorridaEnVuelo_SePoneAlDia @story-8.133 @ac-8', () => {
  const repos = dosRepos();
  // la corrida anotó el plan sólo en el repo del código (un arnés anterior a esta story)
  const { home, proyectada } = preparar({ ...repos, registroCodigo: plan });
  const r = cerrar(home, repos.codeRepo);
  assert.deepEqual(queDe(proyectada), ['plan'], 'el cierre lo lleva al repo de la story');
  assert.equal(r.freno.length, 1, JSON.stringify(r.freno));
  assert.equal(r.freno[0].status, 'ok');
  assert.doesNotMatch(r.stderr, /aprobaciones en el repo de la story/);
});

test('Cierre_SinPlan_Frena @story-8.133 @ac-9', () => {
  const repos = dosRepos();
  const { home } = preparar({ ...repos, registroCodigo: maqueta });
  const r = cerrar(home, repos.codeRepo);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /complete-step 8 BLOQUEADO — aprobaciones en el repo de la story/);
  assert.match(r.stderr, new RegExp(`${CORRIDA_RE}.*sin-aprobacion-del-plan`));
  assert.match(r.stderr, /complete-step approve-plan --approved "<cita>" --out-of-order/);
  assert.match(r.stderr, /advisors_exempt/);
  assert.equal(r.freno[0].status, 'blocked');
});

test('Cierre_MaquetaAprobadaSinLinea_Frena @story-8.133 @ac-10', () => {
  const repos = dosRepos();
  const { home } = preparar({ ...repos, registroCodigo: plan, extra: MAQUETA });
  const r = cerrar(home, repos.codeRepo);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /aprobaciones en el repo de la story/);
  assert.match(r.stderr, /sin-aprobacion-de-la-maqueta/);
  assert.equal(r.freno[0].status, 'blocked');
});

test('Cierre_CorridaVieja_SeProyectaONombra @story-8.133 @ac-11', () => {
  const VIEJA = '9.95-20991230120000';
  // con su par en el repo del código: se proyecta y no frena por ella
  let repos = dosRepos();
  let c = preparar({ ...repos, registroCodigo: plan });
  const par = path.join(repos.codeRepo, '.advisors', 'pipeline-runs', VIEJA);
  const vieja = path.join(repos.storyRepo, '.advisors', 'pipeline-runs', VIEJA);
  for (const d of [par, vieja]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'review-roster.json'), '{"registro_aprobaciones":1}'); }
  fs.writeFileSync(path.join(par, approvals.FILE), plan);
  let r = cerrar(c.home, repos.codeRepo);
  assert.deepEqual(queDe(vieja), ['plan']);
  assert.equal(r.freno[0].status, 'ok', r.stderr);
  // sin par: frena nombrándola
  repos = dosRepos();
  c = preparar({ ...repos, registroCodigo: plan });
  const sola = path.join(repos.storyRepo, '.advisors', 'pipeline-runs', VIEJA);
  fs.mkdirSync(sola, { recursive: true });
  fs.writeFileSync(path.join(sola, 'review-roster.json'), '{"registro_aprobaciones":1}');
  r = cerrar(c.home, repos.codeRepo);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, new RegExp(VIEJA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(r.stderr, new RegExp(`${CORRIDA_RE}.*sin-`), 'la abierta está al día');
  assert.equal(r.freno[0].status, 'blocked');
});

test('Cierre_CorridaSinDeclarar_NoFrena @story-8.133 @ac-12', () => {
  const repos = dosRepos();
  const { home } = preparar({ ...repos, rosterStory: {} });
  const r = cerrar(home, repos.codeRepo);
  assert.doesNotMatch(r.stderr, /aprobaciones en el repo de la story/);
  assert.equal(r.freno[0].status, 'ok');
});

test('Cierre_RegistroIlegible_Frena @story-8.133 @ac-13', () => {
  const repos = dosRepos();
  const { home } = preparar({ ...repos, registroCodigo: plan, registroStory: `${plan}esto no es json\n` });
  const r = cerrar(home, repos.codeRepo);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /registro-de-aprobaciones-invalido/);
  assert.match(r.stderr, new RegExp(CORRIDA_RE));
  assert.match(r.stderr, /línea\(s\) que no son JSON/);
  assert.equal(r.freno[0].status, 'blocked');
});

test('Cierre_RosterIlegible_Frena @story-8.133 @ac-16', () => {
  const VIEJA = '9.95-20991230120000';
  const repos = dosRepos();
  const { home } = preparar({ ...repos, registroCodigo: plan });
  // una corrida vieja, sólo en el repo de la story, con el roster roto: no se toma por «sin declarar»
  const vieja = path.join(repos.storyRepo, '.advisors', 'pipeline-runs', VIEJA);
  fs.mkdirSync(vieja, { recursive: true });
  fs.writeFileSync(path.join(vieja, 'review-roster.json'), '{ esto no es json');
  const r = cerrar(home, repos.codeRepo);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, new RegExp(`${VIEJA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: review-roster-ilegible`));
  assert.equal(r.freno[0].status, 'blocked');
});

test('Cierre_CopiaFallida_Frena @story-8.133 @ac-16', () => {
  const repos = dosRepos();
  const { home, proyectada } = preparar({ ...repos, registroCodigo: plan });
  // el registro del repo de la story es una carpeta: la copia no puede escribirlo
  fs.mkdirSync(path.join(proyectada, approvals.FILE));
  const r = cerrar(home, repos.codeRepo);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, new RegExp(`${CORRIDA_RE}: proyeccion-fallida — no se pudo`));
  assert.equal(r.freno[0].status, 'blocked');
});

test('Cierre_CarpetaSinListar_Frena @story-8.133 @ac-16', (t) => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) { t.skip('los permisos de carpeta no aplican acá'); return; }
  const repos = dosRepos();
  const { home } = preparar({ ...repos, registroCodigo: plan, rosterStory: null });
  // la carpeta de corridas existe y no se puede listar
  const base = path.join(repos.storyRepo, '.advisors', 'pipeline-runs');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  fs.chmodSync(base, 0o000);
  t.after(() => fs.chmodSync(base, 0o755));
  const r = cerrar(home, repos.codeRepo);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /no pude mirar las aprobaciones en el repo de la story/);
  assert.equal(r.freno[0].status, 'blocked');
});

test('Cierre_StoryFueraDeGit_NoMedido @story-8.133 @ac-16', () => {
  const repos = dosRepos();
  // la story, copiada fuera de todo repo git
  const suelta = path.join(tmp('apr-suelta-'), 'story-9.95-juguete.md');
  fs.copyFileSync(repos.story, suelta);
  const { home } = preparar({ ...repos, story: suelta, registroCodigo: plan });
  const r = cerrar(home, repos.codeRepo);
  assert.match(r.stderr, /aprobaciones en el repo de la story: no medido/);
  assert.doesNotMatch(r.stderr, /BLOQUEADO — aprobaciones en el repo de la story/);
  assert.equal(r.freno[0].status, 'no-medido');
});

test('Cierre_MismoRepo_MaquetaSinLinea_Frena @story-8.133 @ac-10', () => {
  // la story y el código en el mismo repo: el freno por la maqueta vale igual (el portón no la pide)
  const repo = repoPropio('apr-uno-');
  const git = gitEn(repo);
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'specs'));
  const story = path.join(repo, 'specs', 'story-9.95-juguete.md');
  fs.writeFileSync(story, ['---', 'story: "9.95"', 'title: "juguete"', 'status: in-progress', 'files_to_modify:', '  - README.md', '---', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const c = preparar({ storyRepo: repo, codeRepo: repo, story, registroCodigo: plan, extra: MAQUETA });
  let r = cerrar(c.home, repo);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /sin-aprobacion-de-la-maqueta/);
  assert.equal(r.freno[0].status, 'blocked');
  // con la línea, no frena por esto
  fs.writeFileSync(path.join(c.abierta, approvals.FILE), plan + maqueta);
  const home2 = tmp('apr-cierre-');
  marcadorDelCierre(home2, { story, codeRepo: repo, extra: MAQUETA });
  r = cerrar(home2, repo);
  assert.doesNotMatch(r.stderr, /aprobaciones en el repo de la story/);
  assert.equal(r.freno[0].status, 'ok');
});

// Las mismas carpetas que el portón: la raíz del repo y cada subcarpeta de primer nivel, con el mismo filtro.
const pl = () => require(path.join(SCRIPTS, 'pipeline.js'));
const { revisarAprobaciones } = require(GATE);
function corridaEn(base, nombre, { roster = { registro_aprobaciones: 1 }, registro = null } = {}) {
  const d = path.join(base, '.advisors', 'pipeline-runs', nombre);
  fs.mkdirSync(d, { recursive: true });
  if (roster) fs.writeFileSync(path.join(d, 'review-roster.json'), JSON.stringify(roster));
  if (registro !== null) fs.writeFileSync(path.join(d, approvals.FILE), registro);
  return d;
}
function unSoloRepo() {
  const repo = repoPropio('apr-mono-');
  const git = gitEn(repo);
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'specs'));
  const story = path.join(repo, 'specs', 'story-9.95-juguete.md');
  fs.writeFileSync(story, ['---', 'story: "9.95"', 'title: "juguete"', 'status: in-progress', '---', ''].join('\n'));
  fs.mkdirSync(path.join(repo, 'Backend'));
  fs.writeFileSync(path.join(repo, 'Backend', 'README.md'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  return { repo, story, codeRepo: path.join(repo, 'Backend') };
}

test('Cierre_CorridaEnSubproyecto_MismoVeredictoQueElPorton @story-8.133 @ac-17', () => {
  const { repo, story, codeRepo } = unSoloRepo();
  const runDir = corridaEn(codeRepo, CORRIDA, { registro: maqueta });
  const porElPorton = revisarAprobaciones(repo, '9.95', story).hallazgos.map((h) => h.regla);
  assert.deepEqual(porElPorton, ['sin-aprobacion-del-plan']);
  let r = pl().aprobacionesEnElRepoDeLaStory({ runDir, storyPath: story, storyId: '9.95', codeRepo, maquetaAprobada: false });
  assert.deepEqual(r.faltas.map((f) => f.regla), porElPorton, 'el cierre ve la corrida del subproyecto, como el portón');
  // con el plan y la maqueta anotados, la maqueta aprobada no frena
  fs.writeFileSync(path.join(runDir, approvals.FILE), plan + maqueta);
  r = pl().aprobacionesEnElRepoDeLaStory({ runDir, storyPath: story, storyId: '9.95', codeRepo, maquetaAprobada: true });
  assert.deepEqual(r.faltas, []);
});

test('Cierre_ParEnSubcarpetaDelCodigo_SeProyecta @story-8.133 @ac-17', () => {
  const VIEJA = '9.95-20991230120000';
  const { storyRepo, codeRepo, story } = dosRepos();
  const sub = path.join(codeRepo, 'Backend');
  const runDir = corridaEn(sub, CORRIDA, { registro: plan });
  corridaEn(sub, VIEJA, { registro: plan });
  const vieja = corridaEn(storyRepo, VIEJA);
  const r = pl().aprobacionesEnElRepoDeLaStory({ runDir, storyPath: story, storyId: '9.95', codeRepo: sub, maquetaAprobada: false });
  assert.deepEqual(r.faltas, [], JSON.stringify(r.faltas));
  assert.deepEqual(queDe(vieja), ['plan'], 'el par se encuentra en la subcarpeta del repo del código');
});

test('Cierre_CarpetaStoryConId_NoCuenta @story-8.133 @ac-17', () => {
  const { storyRepo, codeRepo, story } = dosRepos();
  const runDir = corridaEn(codeRepo, CORRIDA, { registro: plan });
  corridaEn(storyRepo, 'story-9.95-20991230120000');
  const r = pl().aprobacionesEnElRepoDeLaStory({ runDir, storyPath: story, storyId: '9.95', codeRepo, maquetaAprobada: false });
  assert.deepEqual(r.faltas, [], 'el portón no la mira, el cierre tampoco');
  assert.deepEqual(revisarAprobaciones(storyRepo, '9.95', story).hallazgos, []);
});

test('Cierre_AdvisorsExempt_NoFrenaPorFalta @story-8.133 @ac-18', () => {
  const { storyRepo, codeRepo, story } = dosRepos();
  fs.writeFileSync(story, fs.readFileSync(story, 'utf8').replace('status: in-progress', 'status: in-progress\nadvisors_exempt: true\nadvisors_exempt_reason: "juguete"'));
  const runDir = corridaEn(codeRepo, CORRIDA, { registro: maqueta });
  let r = pl().aprobacionesEnElRepoDeLaStory({ runDir, storyPath: story, storyId: '9.95', codeRepo, maquetaAprobada: false });
  assert.deepEqual(r.faltas, [], 'la exención perdona la falta del plan, como en el portón');
  // un registro ilegible frena igual
  fs.writeFileSync(path.join(enLaStory(storyRepo, runDir), approvals.FILE), `${plan}esto no es json\n`);
  r = pl().aprobacionesEnElRepoDeLaStory({ runDir, storyPath: story, storyId: '9.95', codeRepo, maquetaAprobada: false });
  assert.deepEqual(r.faltas.map((f) => f.regla), ['registro-de-aprobaciones-invalido']);
});

test('Proyeccion_DestinoCRLF_NoDuplica @story-8.133 @ac-19', () => {
  const origen = tmp('apr-crlf-o-');
  const destino = tmp('apr-crlf-d-');
  fs.writeFileSync(path.join(origen, approvals.FILE), plan + maqueta);
  const crlf = (plan + maqueta).replace(/\n/g, '\r\n');
  fs.writeFileSync(path.join(destino, approvals.FILE), crlf);
  assert.deepEqual(approvals.unir(origen, destino), { agregadas: 0 });
  assert.equal(fs.readFileSync(path.join(destino, approvals.FILE), 'utf8'), crlf, 'el destino sin cambios');
});

test('Cierre_CorridaVieja_ArregloDeCorridaVieja @story-8.133 @ac-20', () => {
  const VIEJA = '9.95-20991230120000';
  const repos = dosRepos();
  const c = preparar({ ...repos, registroCodigo: plan });
  corridaEn(repos.storyRepo, VIEJA);
  const r = cerrar(c.home, repos.codeRepo);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, new RegExp(`${VIEJA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: sin-registro-de-aprobaciones`));
  assert.match(r.stderr, /corrida vieja/);
  assert.match(r.stderr, /advisors_exempt/);
  assert.doesNotMatch(r.stderr, /complete-step approve-plan/, 'approve-plan anota en la abierta, no en la vieja');
});

test('Cierre_CorridaAnteriorAlControl_NoFrena', () => {
  // Una corrida que arrancó antes de que el registro se exigiera en el repo de la story no pudo dejarlo ahí: la falta
  // avisa en el portón y no frena en ninguno de los dos. «Antes» lo dicen el nombre Y la historia (su roster entró
  // antes de ese día). Desde el día del control, la misma falta frena.
  const ANTES = '9.95-20261025120000';
  const DESDE = '9.95-20261026120000';
  const { storyRepo, codeRepo, story } = dosRepos();
  const runDir = corridaEn(codeRepo, CORRIDA, { registro: plan });
  const vieja = corridaEn(storyRepo, ANTES);
  const git = gitEn(storyRepo);
  git('add', '.'); git('commit', '-qm', 'corrida vieja');
  const cerrar = () => pl().aprobacionesEnElRepoDeLaStory({ runDir, storyPath: story, storyId: '9.95', codeRepo, maquetaAprobada: false, ref: 'HEAD' });
  assert.equal(approvals.anteriorAlControl(vieja, ANTES, 'HEAD'), true);
  let r = cerrar();
  assert.deepEqual(r.faltas, [], JSON.stringify(r.faltas));
  let porton = revisarAprobaciones(storyRepo, '9.95', story, 'HEAD');
  assert.deepEqual(porton.hallazgos, [], JSON.stringify(porton.hallazgos));
  assert.ok(porton.avisos.some((a) => a.regla === 'sin-registro-de-aprobaciones' && a.mensaje.includes(ANTES)), JSON.stringify(porton.avisos));
  // un registro presente y malo frena igual, sea de la fecha que sea
  fs.writeFileSync(path.join(vieja, approvals.FILE), `${plan}esto no es json\n`);
  r = cerrar();
  assert.deepEqual(r.faltas.map((f) => f.regla), ['registro-de-aprobaciones-invalido']);
  fs.rmSync(path.join(vieja, approvals.FILE));
  // la corrida del día del control frena por la misma falta, en los dos
  corridaEn(storyRepo, DESDE);
  r = cerrar();
  assert.deepEqual(r.faltas.map((f) => [f.corrida, f.regla]), [[DESDE, 'sin-registro-de-aprobaciones']]);
  porton = revisarAprobaciones(storyRepo, '9.95', story, 'HEAD');
  assert.deepEqual(porton.hallazgos.map((h) => h.regla), ['sin-registro-de-aprobaciones']);
});

test('AnteriorAlControl_DentroDeUnGancho_IgualQueFuera', () => {
  // Un gancho de git (pre-commit) exporta GIT_DIR: git toma la carpeta actual como raíz del árbol y la ruta del roster,
  // relativa a la carpeta de la corrida, no coincide con nada. La corrida vieja tiene que seguir siendo anterior ahí.
  const ANTES = '9.95-20261025120000';
  const { storyRepo } = dosRepos();
  const vieja = corridaEn(storyRepo, ANTES);
  const git = gitEn(storyRepo);
  git('add', '.'); git('commit', '-qm', 'corrida vieja');
  assert.equal(approvals.anteriorAlControl(vieja, ANTES, 'HEAD'), true);
  const antes = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    process.env.GIT_DIR = '.git'; // como lo exporta el gancho: relativo a la raíz del repo que commitea
    assert.equal(approvals.anteriorAlControl(vieja, ANTES, 'HEAD'), true, 'con GIT_DIR relativo exportado');
    process.env.GIT_DIR = path.join(storyRepo, '.git');
    assert.equal(approvals.anteriorAlControl(vieja, ANTES, 'HEAD'), true, 'con GIT_DIR exportado');
    process.env.GIT_WORK_TREE = storyRepo;
    assert.equal(approvals.anteriorAlControl(vieja, ANTES, 'HEAD'), true, 'con GIT_DIR y GIT_WORK_TREE exportados');
  } finally {
    for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('Cierre_NombreViejoSinRastro_Frena', () => {
  // La fecha del nombre la elige quien crea la carpeta: sin el rastro en la historia, una corrida con nombre viejo se
  // exige igual. Tampoco alcanza un roster que entró a la historia desde el día del control, ni una ref que no existe.
  const ANTES = '9.95-20261020120000';
  const { storyRepo, codeRepo, story } = dosRepos();
  const runDir = corridaEn(codeRepo, CORRIDA, { registro: plan });
  const vieja = corridaEn(storyRepo, ANTES);
  const cerrar = (ref) => pl().aprobacionesEnElRepoDeLaStory({ runDir, storyPath: story, storyId: '9.95', codeRepo, maquetaAprobada: false, ref });
  assert.equal(approvals.anteriorAlControl(vieja, ANTES, 'HEAD'), false);
  assert.deepEqual(cerrar('HEAD').faltas.map((f) => [f.corrida, f.regla]), [[ANTES, 'sin-registro-de-aprobaciones']]);
  assert.deepEqual(revisarAprobaciones(storyRepo, '9.95', story, 'HEAD').hallazgos.map((h) => h.regla), ['sin-registro-de-aprobaciones']);
  // commiteada hoy, con el nombre viejo: frena igual
  const hoy = { ...process.env, GIT_AUTHOR_DATE: '2026-10-27T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-27T12:00:00Z' };
  for (const a of [['add', '.'], ['commit', '-qm', 'corrida nueva con nombre viejo']]) {
    execFileSync('git', ['-C', storyRepo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: hoy });
  }
  assert.equal(approvals.anteriorAlControl(vieja, ANTES, 'HEAD'), false);
  assert.deepEqual(cerrar('HEAD').faltas.map((f) => f.regla), ['sin-registro-de-aprobaciones']);
  // una ref que no existe no la vuelve anterior
  assert.equal(approvals.anteriorAlControl(vieja, ANTES, 'origin/main'), false);
  assert.deepEqual(cerrar('origin/main').faltas.map((f) => f.regla), ['sin-registro-de-aprobaciones']);
});
