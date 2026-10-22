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

function markerCli(home, sid, cwd, args) {
  return spawnSync('node', [path.join(SCRIPTS, 'marker.js'), ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0' },
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
