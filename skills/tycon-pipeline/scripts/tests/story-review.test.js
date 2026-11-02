'use strict';

/**
 * story-review.test.js — la revisión adversarial de la historia antes de programar.
 *
 * Lo que no se puede perder:
 *   - el portón (`story-review-gate`) reusa `risk-class` y la resolución de modelos: LOW se saltea con motivo, NORMAL
 *     corre, una constancia vigente no se relanza, `TYCON_STORY_REVIEW=0` la apaga;
 *   - la constancia la escribe sólo `story-review-record`, en la carpeta de estado (el portón de escrituras la niega),
 *     con vocabulario cerrado, y vale mientras la huella de la historia sin las secciones de avance sea la misma;
 *   - lo que no se midió es `null`, nunca `0`, y `no-medido` no cuenta como revisada;
 *   - `validators` suma el revisor sólo cuando corresponde; si no, su salida es la de siempre;
 *   - el cierre de la corrida trae `revision_previa`.
 *
 * Todo corre en laboratorios (HOME aislado, árbol del arnés vacío, repos temporales) con nombres inventados (acme).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const RECORD = path.join(SCRIPTS, 'lib', 'story-review-record.js');
const AGENTE = 'tycon-story-adversarial-reviewer';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `revision-previa-${p}-`));
const lib = () => require(RECORD);

function escribir(file, txt) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, txt); }

/** El entorno de un laboratorio: HOME propio y un árbol del arnés vacío (sin configuración de la organización). Sin
 * arnés, la lista de paquetes de la organización se declara acá: con paquetes instalados al lado, `validators` frena. */
function env(home, extra = {}) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, TYCON_GUIDES_DIR: tmp('arbol'), TYCON_LANE_LLM: '0', TYCON_PACKS_DEFAULT: 'none', ...extra };
  for (const k of ['NODE_TEST_CONTEXT', 'TYCON_STORY_REVIEW', 'CLAUDE_CODE_SESSION_ID']) if (!(k in extra)) delete e[k];
  return e;
}

/** Una historia de laboratorio: `archivos` archivos declarados (más de 6 → NORMAL; 1 o 2 → LOW). */
function historia(id, archivos) {
  return [
    '---', `story: "${id}"`, `title: "historia de laboratorio ${id}"`, 'status: ready-for-dev', 'approach: "[MODIFY]"',
    'files_to_modify:', ...Array.from({ length: archivos }, (_, i) => `  - src/m${i}.js`), '---', '',
    `# Story ${id}: la tienda de acme`, '', 'Status: ready-for-dev', '',
    '## Acceptance Criteria', '',
    '1. **Given** un pedido **When** se guarda **Then** queda con su total.',
    '2. **Given** un pedido vacío **When** se guarda **Then** se rechaza con un mensaje.', '',
    '### Tests', '', '| # | Test | AC |', '|---|---|---|', '| T1 | `Pedido_ConTotal` | 1 |', '| T2 | `Pedido_Vacio_SeRechaza` | 2 |', '',
    '## Tasks / Subtasks', '', '1. Guardar el total.', '',
    '## Dev Agent Record', '', '### Agent Model Used', '', '(sin implementar)', '',
    '### Change Log', '', '| Fecha | Cambio |', '|---|---|', '| 2026-10-21 | Story escrita. |', '',
  ].join('\n');
}

/** Un repo de laboratorio con una historia; `riesgo`: 'normal' | 'low'. */
function lab(riesgo = 'normal') {
  const repo = tmp('repo');
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  const story = path.join(repo, 'specs', 'story-9.4.md');
  escribir(story, historia('9.4', riesgo === 'low' ? 2 : 8));
  for (let i = 0; i < 8; i++) escribir(path.join(repo, 'src', `m${i}.js`), `module.exports = ${i};\n`);
  return { repo, story, home: tmp('home') };
}

function run(cmd, l, args = [], extra = {}) {
  const r = spawnSync(process.execPath, [PIPELINE, cmd, '--story', l.story, '--repo', l.repo, ...args],
    { encoding: 'utf8', env: env(l.home, extra), cwd: l.repo, input: '' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { json = null; }
  return { rc: r.status, out: `${r.stdout}\n${r.stderr}`, json };
}
const gate = (l, extra) => run('story-review-gate', l, [], extra);
const record = (l, args, extra) => run('story-review-record', l, args, extra);

// ── el portón ────────────────────────────────────────────────────────────────────────────────────────────────────

test('StoryReviewGate_RiesgoNormal_Corre @story-8.84 @ac-1 — una historia NORMAL sin constancia corre', () => {
  const l = lab('normal');
  const r = gate(l);
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.json.run, true, r.out);
  assert.equal(r.json.record, 'none', r.out);
  assert.equal(r.json.riesgo, 'NORMAL', r.out);
  assert.equal(r.json.model, 'sonnet', r.out);
  assert.match(r.json.model_reason, /valor de hoy/, r.out);
});

test('StoryReviewGate_RiesgoBajo_SaltaConMotivo @story-8.84 @ac-2 — LOW no corre y dice por qué', () => {
  const l = lab('low');
  const r = gate(l);
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.json.run, false, r.out);
  assert.equal(r.json.motivo, 'riesgo-bajo', r.out);
  assert.ok(Array.isArray(r.json.criterios) && r.json.criterios.some((c) => c.name === 'superficie-chica'), r.out);
});

test('StoryReviewRecord_Saltado_EscribeConstancia @story-8.84 @ac-2 @ac-6 @ac-11 — el salteo deja constancia con su motivo', () => {
  const l = lab('low');
  const r = record(l, ['--result', 'saltado', '--reason', 'riesgo-bajo', '--risk', 'LOW']);
  assert.equal(r.rc, 0, r.out);
  const leida = lib().readRecord(l.home, l.story);
  assert.equal(leida.record.resultado, 'saltado');
  assert.equal(leida.record.motivo, 'riesgo-bajo');
  assert.equal(leida.record.riesgo, 'LOW');

  const n = lab('normal');
  const g = gate(n, { TYCON_STORY_REVIEW: '0' });
  assert.equal(g.json.run, false, g.out);
  assert.equal(g.json.motivo, 'apagado', g.out);
  const r2 = record(n, ['--result', 'saltado', '--reason', 'apagado']);
  assert.equal(r2.rc, 0, r2.out);
  assert.equal(lib().readRecord(n.home, n.story).record.motivo, 'apagado');
});

test('StoryReviewGate_ConstanciaVigente_NoLanza @story-8.84 @ac-3 @ac-4 — con la huella de hoy no se relanza', () => {
  const l = lab('normal');
  const w = record(l, ['--result', 'corregido', '--model', 'sonnet', '--model-reason', 'sonnet (valor de hoy)',
    '--findings', JSON.stringify([{ regla: 'SADV-C3', criterio: '2', severidad: 'CRITICAL', destino: 'corregido' }])]);
  assert.equal(w.rc, 0, w.out);
  const r = gate(l);
  assert.equal(r.json.run, false, r.out);
  assert.equal(r.json.record, 'current', r.out);
  assert.equal(r.json.linea, 'revisión previa vigente: corregido, 1 hallazgos, sonnet', r.out);
});

test('StoryReviewHuella_CambiarUnCriterio_Invalida @story-8.84 @ac-4 — criterio, prueba o tarea cambian la huella', () => {
  for (const [de, a] of [
    ['queda con su total.', 'queda con su total y su fecha.'],
    ['`Pedido_ConTotal`', '`Pedido_ConTotalYFecha`'],
    ['1. Guardar el total.', '1. Guardar el total y la fecha.'],
  ]) {
    const l = lab('normal');
    assert.equal(record(l, ['--result', 'limpio', '--model', 'sonnet']).rc, 0);
    fs.writeFileSync(l.story, fs.readFileSync(l.story, 'utf8').replace(de, a));
    const r = gate(l);
    assert.equal(r.json.record, 'stale', `${de} → ${a}\n${r.out}`);
    assert.equal(r.json.run, true, r.out);
  }
});

test('StoryReviewHuella_ChangeLogYEstado_NoInvalidan @story-8.84 @ac-4 — el avance del trabajo no la invalida', () => {
  const l = lab('normal');
  assert.equal(record(l, ['--result', 'limpio', '--model', 'sonnet']).rc, 0);
  let t = fs.readFileSync(l.story, 'utf8');
  t = t.replace('| 2026-10-21 | Story escrita. |', '| 2026-10-21 | Story escrita. |\n| 2026-10-22 | Implementada. |')
    .replace('(sin implementar)', 'opus')
    .replace('status: ready-for-dev', 'status: in-progress')
    .replace('Status: ready-for-dev', 'Status: in-progress');
  t += '\n## Review Follow-ups (Advisors)\n\n- [ ] algo\n';
  fs.writeFileSync(l.story, t);
  const r = gate(l);
  assert.equal(r.json.record, 'current', r.out);
});

test('StoryReviewHuella_AvanceDeTandasYCasillas_NoInvalidan @story-8.84 @ac-4 — el estado de una tanda, una casilla tildada y un bloque de código en el registro', () => {
  const H = lib().huella;
  const base = historia('9.4', 8).replace('approach: "[MODIFY]"', 'approach: "[MODIFY]"\npipelines:\n  - name: A\n    status: pending')
    .replace('1. Guardar el total.', '- [ ] 1. Guardar el total.');
  const avance = base.replace('    status: pending', '    status: done').replace('- [ ] 1. Guardar', '- [x] 1. Guardar')
    .replace('(sin implementar)', '(sin implementar)\n\n```bash\n# corrí las pruebas\nnpm test\n```\n\nNotas del avance.');
  assert.equal(H(avance), H(base));
});

test('StoryReviewHuella_TitulosYStatusDentroDeCodigo_NoEngañan @story-8.84 @ac-4 — un bloque de código no abre ni cierra secciones', () => {
  const H = lib().huella;
  const conEjemplo = (n) => historia('9.4', 8).replace('## Tasks / Subtasks',
    `## Dev Notes\n\n\`\`\`md\n## Change Log\n\`\`\`\n\nEl límite es ${n}.\n\n\`\`\`http\nStatus: 200\n\`\`\`\n\n## Tasks / Subtasks`);
  assert.notEqual(H(conEjemplo(10)), H(conEjemplo(99)), 'un criterio cambiado debajo de un ejemplo cuenta');
  assert.notEqual(H(conEjemplo(10)), H(conEjemplo(10).replace('Status: 200', 'Status: 404')), 'un Status: dentro de un ejemplo cuenta');
});

test('StoryReviewRecord_MismaHistoriaOtraMayuscula_MismaConstancia @story-8.84 @ac-11 — en un disco sin mayúsculas, una sola clave', { skip: process.platform === 'linux' }, () => {
  const l = lab('normal');
  const otra = path.join(path.dirname(l.story), path.basename(l.story).toUpperCase());
  if (!fs.existsSync(otra)) return;   // disco que distingue mayúsculas: no hay nada que probar
  assert.equal(lib().recordFile(l.home, otra), lib().recordFile(l.home, l.story));
});

test('StoryReviewGate_SaltadoPorApagado_CorreAlPrenderla @story-8.84 @ac-6 — un salteo no cuenta como revisión vigente', () => {
  const l = lab('normal');
  assert.equal(record(l, ['--result', 'saltado', '--reason', 'apagado']).rc, 0);
  const r = gate(l);
  assert.equal(r.json.run, true, r.out);
});

test('StoryReviewRecord_TokensVacios_SonNull @story-8.84 @ac-17 — un valor vacío no es cero', () => {
  const l = lab('normal');
  assert.equal(record(l, ['--result', 'limpio', '--tokens', '', '--duration-ms', ' ']).rc, 0);
  const rec = lib().readRecord(l.home, l.story).record;
  assert.equal(rec.tokens, null);
  assert.equal(rec.duracion_ms, null);
  assert.equal(rec.medido, false);
});

test('StoryReviewRecord_Pendiente_NoEsVigenteHastaResolver @story-8.84 @ac-10 — pendiente queda escrita y se lee como tal', () => {
  const l = lab('normal');
  assert.equal(record(l, ['--result', 'pendiente', '--findings', JSON.stringify([{ regla: 'SADV-C1', criterio: '1', severidad: 'CRITICAL', destino: 'preguntado' }])]).rc, 0);
  assert.equal(lib().readRecord(l.home, l.story).record.resultado, 'pendiente');
  // no se relanza (una sola pasada), pero tampoco pasa por revisada: la pregunta sigue abierta
  const g = gate(l);
  assert.equal(g.json.run, false, g.out);
  assert.equal(g.json.pendiente, true, g.out);
  assert.match(g.json.linea, /pendiente.*respuesta/, g.out);
});

test('Models_PedidoDelRevisorDeHistorias_NoSeAvisaPerdidoEnElPaso5 @story-8.84 @ac-14 — pedido por su nombre, corre en el paso 1', () => {
  const M = require(path.join(SCRIPTS, 'lib', 'models.js'));
  const warnings = [];
  M.resolveReviewers({ org: null, requests: { [AGENTE]: 'opus' }, set: ['tycon-plugin-security-basics'], warnings });
  assert.ok(!warnings.some((w) => w.key === `request-unused:${AGENTE}`), JSON.stringify(warnings));
});

test('ComoFunciona_PasoUno_NombraAlRevisor @story-8.84 @ac-3 — la página del arnés lo lista aunque la máquina lo tenga apagado', () => {
  const PIPE = require(PIPELINE);
  // corre en este proceso: la lista de paquetes se declara como en env(), por si la máquina no tiene arnés
  const puestas = { TYCON_STORY_REVIEW: '0', TYCON_PACKS_DEFAULT: 'none' };
  const prev = Object.fromEntries(Object.keys(puestas).map((k) => [k, process.env[k]]));
  Object.assign(process.env, puestas);
  try {
    const d = tmp('hiw');
    const s = path.join(d, 'story.md');
    fs.writeFileSync(s, '---\nstory: "9.9"\n---\n\n# Story 9.9\n');
    assert.ok(PIPE.computeValidadores({ story: s, repo: d, todos: true }).validadores.includes(AGENTE));
  } finally {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('StoryReviewRecord_Resultados_VocabularioCerrado @story-8.84 @ac-11 — fuera de la lista no escribe', () => {
  const l = lab('normal');
  const r1 = record(l, ['--result', 'revisado']);
  assert.equal(r1.rc, 2, r1.out);
  const r2 = record(l, ['--result', 'saltado']);
  assert.equal(r2.rc, 2, r2.out);
  assert.match(r2.out, /--reason/, r2.out);
  assert.equal(lib().readRecord(l.home, l.story).estado, 'none');
});

test('StoryReviewRecord_AgenteNoLaEscribeAMano @story-8.84 @ac-11 — la constancia vive donde el portón niega escribir', () => {
  const l = lab('normal');
  const f = lib().recordFile(l.home, l.story);
  const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));
  const sd = stateDir(l.home);
  assert.ok(f.startsWith(sd + path.sep), `${f} no está bajo ${sd}`);
  const { computeStoryGate } = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
  const v = computeStoryGate({ filePath: f, stateDir: sd, homeDir: l.home, repoRoot: null, repoHasTycon: false, repoHasStories: false, marker: null, adhoc: null });
  assert.equal(v.action, 'block');
  assert.equal(v.kind, 'state-dir');
  // y el único que la escribe es el comando: el texto del guion la nombra sólo por writeRecord
  const src = fs.readFileSync(PIPELINE, 'utf8');
  assert.match(src, /story-review-record/);
  assert.ok((src.match(/writeRecord\(/g) || []).length >= 1);
});

test('StoryReviewRecord_RevisorMuerto_NoMedido @story-8.84 @ac-12 — no-medido no cuenta como revisada', () => {
  const l = lab('normal');
  assert.equal(record(l, ['--result', 'no-medido']).rc, 0);
  const r = gate(l);
  assert.equal(r.json.run, true, r.out);
  assert.equal(r.json.record, 'unmeasured', r.out);
});

// ── validators ───────────────────────────────────────────────────────────────────────────────────────────────────

test('Validators_SinConstanciaVigente_SumaElRevisor @story-8.84 @ac-3 — un lanzamiento más, en el mismo mensaje', () => {
  const l = lab('normal');
  const r = run('validators', l);
  assert.equal(r.rc, 0, r.out);
  const lz = r.json.lanzamientos.find((x) => x.agente === AGENTE);
  assert.ok(lz, r.out);
  assert.equal(lz.modelo, 'sonnet');
  assert.ok(lz.prompt.includes(l.story), lz.prompt);
  assert.match(lz.prompt, /en paralelo/, lz.prompt);
  assert.ok(lz.nota, r.out);
  assert.ok(r.json.validadores.includes(AGENTE), r.out);
});

test('Validators_ConConstanciaVigenteOLow_NoSumaElRevisor @story-8.84 @ac-3 @ac-19 — si no corresponde, la salida es la de siempre', () => {
  const low = lab('low');
  const r1 = run('validators', low);
  assert.equal(r1.rc, 0, r1.out);
  assert.ok(!r1.json.lanzamientos.some((x) => x.agente === AGENTE), r1.out);
  assert.ok(!r1.json.validadores.includes(AGENTE), r1.out);
  assert.equal(r1.json.revision_previa, undefined, r1.out);

  const n = lab('normal');
  assert.equal(record(n, ['--result', 'limpio', '--model', 'sonnet']).rc, 0);
  const r2 = run('validators', n);
  assert.ok(!r2.json.lanzamientos.some((x) => x.agente === AGENTE), r2.out);
  assert.deepEqual(Object.keys(r2.json).sort(), Object.keys(r1.json).sort());
});

// ── el modo primera vez y las guías de pasos ─────────────────────────────────────────────────────────────────────

test('ModoPrimeraVez_NoCorreElRevisor @story-8.84 @ac-5 — first-time.md no lo menciona', () => {
  const f = path.join(RAIZ, 'skills', 'tycon-create-story', 'first-time.md');
  const t = fs.readFileSync(f, 'utf8');
  assert.doesNotMatch(t, /story-review|adversarial|SADV/i);
});

test('GuiasDePasos_PasoSeisYPasoUno @story-8.84 @ac-1 @ac-3 @ac-9 @ac-10 @ac-13 — el orden, la pregunta única y validar de nuevo', () => {
  const wf = fs.readFileSync(path.join(RAIZ, 'skills', 'tycon-create-story', 'workflow.md'), 'utf8');
  const paso6 = wf.slice(wf.indexOf('<step n="6"'));
  const iVal = paso6.indexOf('tycon-story-validator');
  const iW17 = paso6.indexOf('VAL-W17');
  const iGate = paso6.indexOf('story-review-gate');
  const iRec = paso6.indexOf('story-review-record');
  const iReady = paso6.indexOf('"ready-for-dev"');
  assert.ok(iVal >= 0 && iW17 > iVal && iGate > iW17 && iRec > iGate && iReady > iRec,
    `orden: validador ${iVal}, VAL-W17 ${iW17}, portón ${iGate}, constancia ${iRec}, ready-for-dev ${iReady}`);
  assert.match(paso6, /ONE question|una sola pregunta/i);
  assert.match(paso6, /Change Log/);

  const s1 = fs.readFileSync(path.join(RAIZ, 'skills', 'tycon-pipeline', 'steps', 'step-02-validate-story.md'), 'utf8');
  assert.match(s1, /story-review-gate/);
  assert.match(s1, /story-review-record/);
  assert.match(s1, /no-medido/);
  assert.match(s1, /una sola pregunta/i);
  assert.match(s1, /se vuelve a correr|re-correr el validador|volver a correr el validador/i);
});

// ── el modelo y la configuración ─────────────────────────────────────────────────────────────────────────────────

test('TeamRepos_AdversarialStory_ClaveValidada @story-8.84 @ac-14 @ac-15 — la clave entra en la lista cerrada', () => {
  const TR = require(path.join(RAIZ, 'scripts', 'lib', 'team-repos.js'));
  const base = (story) => JSON.stringify({ version: 1, models: { adversarial: { story } } });
  const ok = TR.parse(base('haiku'));
  const sec = ok.sectionProblems && ok.sectionProblems.models;
  assert.ok(!sec || !sec.length, JSON.stringify(sec));
  assert.ok(!(ok.problems || []).some((p) => String(p.path).startsWith('models')), JSON.stringify(ok.problems));
  const mal = TR.parse(base('gpt-9'));
  const todos = [...(mal.problems || []), ...((mal.sectionProblems && mal.sectionProblems.models) || [])];
  assert.ok(todos.some((p) => p.path === 'models.adversarial.story'), JSON.stringify(todos));
});

test('Sitio_TablaPaseAdversarial_TieneElRenglon @story-8.84 @ac-14 — un renglón con su valor por defecto, en los dos idiomas', () => {
  const oc = fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'org-config.js'), 'utf8');
  assert.match(oc, /trabajo\(adv, T\('pantalla\.unaHistoriaAntesDeProgramar'\), 'adversarial', 'story', T\('pantalla\.glosa\.historiaAntesDeProgramar'\)\)/);
  const texts = require(path.join(RAIZ, 'scripts', 'site', 'texts.js'));
  const t = texts.TEXTOS['pantalla.unaHistoriaAntesDeProgramar'];
  assert.ok(t && t.es && t.en, JSON.stringify(t));
  const { DEFAULTS } = require(path.join(SCRIPTS, 'lib', 'models.js'));
  assert.equal(DEFAULTS.adversarial.story, 'sonnet');
});

// ── la medición ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Una corrida de laboratorio con marcador y su cierre; devuelve el volcado del historial. */
function cerrarCorrida(l) {
  const sid = `lab-revision-${crypto.randomBytes(4).toString('hex')}`;
  const e = env(l.home, { CLAUDE_CODE_SESSION_ID: sid });
  // stable-data: la hora de arranque sólo filtra el registro de lanzamientos de la corrida; ninguna aserción la mira

  const set = spawnSync(process.execPath, [MARKER, 'set', JSON.stringify({ storyId: '9.4', storyPath: l.story, repoPath: l.repo, startedAt: new Date().toISOString() })],
    { encoding: 'utf8', env: e, cwd: l.repo });
  assert.equal(set.status, 0, `${set.stdout}\n${set.stderr}`);
  const c = spawnSync(process.execPath, [MARKER, 'clear', '--discard'], { encoding: 'utf8', env: e, cwd: l.repo });
  assert.equal(c.status, 0, `${c.stdout}\n${c.stderr}`);
  const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));
  const dir = path.join(stateDir(l.home), 'timing-history');
  const f = fs.readdirSync(dir).filter((x) => x.startsWith('9.4-')).sort().pop();
  return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
}

test('Volcado_ConConstancia_TraeRevisionPrevia @story-8.84 @ac-16 @ac-17 — el cierre trae la revisión previa', () => {
  const l = lab('normal');
  assert.equal(record(l, ['--result', 'corregido', '--model', 'sonnet', '--tokens', '8000', '--duration-ms', '40000',
    '--findings', JSON.stringify([
      { regla: 'SADV-C3', criterio: '2', severidad: 'CRITICAL', destino: 'corregido' },
      { regla: 'SADV-W1', criterio: '1', severidad: 'WARNING', destino: 'corregido' },
      { regla: 'SADV-W1', criterio: '2', severidad: 'WARNING', destino: 'descartado' },
    ])]).rc, 0);
  const d = cerrarCorrida(l);
  const rp = d.revision_previa;
  assert.ok(rp, JSON.stringify(d).slice(0, 400));
  assert.equal(rp.resultado, 'corregido');
  assert.equal(rp.modelo, 'sonnet');
  assert.equal(rp.tokens, 8000);
  assert.equal(rp.duracion_ms, 40000);
  assert.deepEqual(rp.hallazgos.por_regla, { 'SADV-C3': 1, 'SADV-W1': 2 });
  assert.deepEqual(rp.hallazgos.por_destino, { corregido: 2, descartado: 1 });
});

test('Volcado_SinConstanciaOSinMedir_EsNull @story-8.84 @ac-16 @ac-17 — lo no medido es null, nunca 0', () => {
  const sin = lab('normal');
  const d = cerrarCorrida(sin);
  assert.equal(d.revision_previa, null);
  assert.equal(d.revision_previa_nota, 'sin revisión previa');

  const l = lab('normal');
  assert.equal(record(l, ['--result', 'limpio', '--model', 'sonnet']).rc, 0);
  const rec = lib().readRecord(l.home, l.story).record;
  assert.equal(rec.tokens, null);
  assert.equal(rec.duracion_ms, null);
  assert.equal(rec.medido, false);
  const d2 = cerrarCorrida(l);
  assert.equal(d2.revision_previa.tokens, null);
  assert.equal(d2.revision_previa.duracion_ms, null);
});

// ── el revisor, el adaptador y el catálogo ───────────────────────────────────────────────────────────────────────

test('AdaptadorCodexYCatalogo_AlDia @story-8.84 @ac-18 @ac-19 — el .toml sale del .md y el catálogo cuenta las cinco reglas', () => {
  const md = fs.readFileSync(path.join(RAIZ, 'agents', `${AGENTE}.md`));
  const sha = crypto.createHash('sha256').update(md).digest('hex');
  for (const sub of ['agents', 'agents-native']) {
    const toml = fs.readFileSync(path.join(RAIZ, 'adapters', 'codex', sub, `${AGENTE}.toml`), 'utf8');
    assert.ok(toml.includes(sha), `${sub}: el source_sha256 no es el del .md`);
  }
  const cat = fs.readFileSync(path.join(RAIZ, 'guides', 'advisor-rules-catalog.md'), 'utf8');
  for (const id of ['SADV-C1', 'SADV-C2', 'SADV-C3', 'SADV-W1', 'SADV-W2']) assert.match(cat, new RegExp(`\\|\\s*\\*\\*${id}\\*\\*\\s*\\|`), id);
  const c = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'lib', 'rules-catalog-count.js'), '--root', RAIZ], { encoding: 'utf8' });
  assert.equal(c.status, 0, `${c.stdout}\n${c.stderr}`);
});

test('Examen_SadvCuatroMustFlagYUnLimpio @story-8.84 @ac-7 @ac-8 @ac-18 — el banco tiene los cinco casos y el examen dio 5 de 5', () => {
  const casos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'controls-bench', 'cases', 'advisors', `${AGENTE}.json`), 'utf8'));
  const ids = casos.cases.map((c) => c.id).sort();
  assert.deepEqual(ids, ['limpio-historia-completa', 'sadv-c1-dos-criterios-chocan', 'sadv-c2-la-columna-no-existe', 'sadv-c3-falla-sin-criterio', 'sadv-w1-supuesto-sin-marcar']);
  assert.equal(casos.cases.filter((c) => c.type === 'must-flag').length, 4);
  // el banco juzga el renglón final con el lector de veredictos: tiene que reconocer las reglas SADV
  const { veredictoDe } = require(path.join(RAIZ, 'scripts', 'lib', 'validator-verdict.js'));
  assert.deepEqual(veredictoDe('Veredicto: hallazgos (SADV-C2, SADV-W1) · bloquea: sí').reglas, ['SADV-C2', 'SADV-W1']);
  const examen = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'controls-bench', 'reviewer-exams', `${AGENTE}.json`), 'utf8'));
  assert.equal(examen.passed, 5);
  assert.equal(examen.total, 5);
  // el examen es del revisor de hoy: un cambio al .md sin volver a examinarlo deja esto en rojo
  assert.ok(examenVale(examen.hash, path.join(RAIZ, 'agents', `${AGENTE}.md`)), 'el examen es de otra versión del revisor: correr reviewer-change-check.js run');
});

/** El hash de git de un archivo (el que guarda el examen). */
function blob(f) {
  return spawnSync('git', ['hash-object', f], { encoding: 'utf8' }).stdout.trim();
}

/**
 * El examen vale para el revisor de hoy: es de esta misma versión, o de una que sólo difiere en la línea `description:`
 * (la misma regla con que el control de cambios de revisores excusa ese cambio: el examen no lee la descripción).
 */
function examenVale(hash, archivo) {
  if (hash === blob(archivo)) return true;
  const antes = spawnSync('git', ['cat-file', '-p', hash], { cwd: RAIZ, encoding: 'utf8' });
  if (antes.status !== 0) return false;
  const { onlyDescriptionChanged } = require(path.join(RAIZ, 'scripts', 'controls-bench', 'reviewer-change-check.js'));
  return onlyDescriptionChanged(antes.stdout, fs.readFileSync(archivo, 'utf8'));
}

test('NoRegresion_ValidadorYCincoB @story-8.84 @ac-19 — el examen del validador pasa todos sus casos', () => {
  const examen = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'controls-bench', 'reviewer-exams', 'tycon-story-validator.json'), 'utf8'));
  const casos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'controls-bench', 'cases', 'advisors', 'tycon-story-validator.json'), 'utf8')).cases;
  assert.equal(examen.total, casos.length, 'el examen no corrió todos los casos del revisor');
  assert.equal(examen.passed, examen.total);
  assert.ok(examenVale(examen.hash, path.join(RAIZ, 'agents', 'tycon-story-validator.md')), 'el validador cambió sin volver a examinarlo');
  const md = fs.readFileSync(path.join(RAIZ, 'agents', 'tycon-story-validator.md'), 'utf8');
  assert.doesNotMatch(md, /SADV/);
});
