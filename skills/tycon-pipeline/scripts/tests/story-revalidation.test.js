'use strict';
/**
 * story-revalidation.test.js — un cambio técnico de la historia después de un plan rechazado lo revalida la vuelta
 * siguiente de la revisión del plan, en vez de vencer las constancias y repetir la validación y la adversarial.
 *
 * Lo que no se puede perder:
 *   - con las dos constancias guardando su texto, un cambio sólo técnico (pruebas, tareas, notas de desarrollo, la lista
 *     de archivos del encabezado) y una revisión del plan rechazada después: el portón de la adversarial no la relanza y
 *     `validators` no vuelve a lanzar al validador;
 *   - un criterio, la sección de la historia, otra clave del encabezado, una sección desconocida, una constancia sin su
 *     texto, sin rechazo o con el rechazo de antes: vence como siempre;
 *   - la vuelta del plan ve el cambio y, si aprueba con la historia tal como la vio, escribe las dos constancias nuevas;
 *     si rechaza, o la historia cambió otra vez, no escribe nada.
 *
 * Todo corre en laboratorios (HOME aislado, repos temporales) con nombres inventados (acme).
 * stable-data: las horas de las constancias y de los rechazos son las de la corrida; ninguna se compara con un reloj fijo.
 */
// sin el perfil del equipo: la prueba fija su ambiente (scripts/tests/lib/without-team-profile.js)
require('../../../../scripts/tests/lib/without-team-profile.js');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const { harnessCopy } = require('../../../../scripts/tests/lib/harness-copy.js');
const MARKER = path.join(harnessCopy(), 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const SRV = () => require(path.join(SCRIPTS, 'lib', 'story-revalidation.js'));
const VR = () => require(path.join(SCRIPTS, 'lib', 'validation-record.js'));
const SR = () => require(path.join(SCRIPTS, 'lib', 'story-review-record.js'));
const PR = () => require(path.join(SCRIPTS, 'lib', 'plan-review.js'));
const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));
const AGENTE = 'tycon-story-adversarial-reviewer';

function escribir(file, txt) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, txt); }

/** Una historia de laboratorio con criterios, pruebas, tareas y notas: 8 archivos (riesgo normal: la adversarial corre). */
function historia(id) {
  return [
    '---', `story: "${id}"`, `title: "historia de laboratorio ${id}"`, 'status: ready-for-dev', 'approach: "[MODIFY]"',
    'files_to_modify:', ...Array.from({ length: 8 }, (_, i) => `  - src/m${i}.js`), '---', '',
    `# Story ${id}: la tienda de acme`, '', 'Status: ready-for-dev', '',
    '## Story', '', 'Como cliente de acme, quiero guardar un pedido, para ver su total.', '',
    '## Acceptance Criteria', '',
    '1. **Given** un pedido **When** se guarda **Then** queda con su total.',
    '2. **Given** un pedido vacío **When** se guarda **Then** se rechaza con un mensaje.', '',
    '### Tests', '', '| # | Test | AC |', '|---|---|---|', '| T1 | `Pedido_ConTotal` | 1 |', '| T2 | `Pedido_Vacio_SeRechaza` | 2 |', '',
    '## Tasks / Subtasks', '', '1. Guardar el total.', '',
    '## Dev Notes', '', '### Que hay que hacer (la delta)', '', 'El total se calcula en src/m0.js.', '',
    '### Lo que NO hay que hacer', '', 'No tocar la tabla de precios.', '',
    '## Dev Agent Record', '', '### Change Log', '', '| Fecha | Cambio |', '|---|---|', '| hoy | Story escrita. |', '',
  ].join('\n');
}

const tmp = (t, p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `revalida-${p}-`))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

/** Un repo con la historia 9.4, su HOME y las dos constancias escritas sobre el texto de hoy. */
function lab(t) {
  const repo = tmp(t, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  const story = path.join(repo, 'specs', 'story-9.4.md');
  escribir(story, historia('9.4'));
  for (let i = 0; i < 8; i++) escribir(path.join(repo, 'src', `m${i}.js`), `module.exports = ${i};\n`);
  const home = tmp(t, 'home');
  VR().writeRecord(home, story, { resultado: 'verde', validadores: ['tycon-story-validator', AGENTE] });
  SR().writeRecord(home, story, { resultado: 'limpio', hallazgos: [], riesgo: 'NORMAL' });
  const l = { repo, story, home, estado: stateDir(home), sid: 'ses-lab' };
  // la corrida abierta de la sesión sobre esta historia: el rechazo se ata a ella
  escribir(path.join(l.estado, 'active', `${l.sid}.json`), JSON.stringify({ storyId: '9.4', storyPath: story, repoPath: repo, startedAt: new Date(Date.now() - 3600000).toISOString() }));
  /**
   * Un renglón de la revisión del plan de esa historia, `ms` milisegundos desde ahora (negativo: antes), de la corrida de
   * la sesión `sid` (`otraCorrida`: con otra hora de arranque).
   */
  l.revision = (veredicto, { ms = 1000, storyId = '9.4', sid = l.sid, otraCorrida = false } = {}) => {
    const m = JSON.parse(fs.readFileSync(path.join(l.estado, 'active', `${sid}.json`), 'utf8'));
    const corrida = { storyId: '9.4', startedAt: otraCorrida ? new Date(0).toISOString() : m.startedAt };
    fs.appendFileSync(path.join(l.estado, 'gates.log'), `${JSON.stringify({ ts: new Date(Date.now() + ms).toISOString(), name: 'plan-review', status: 'ok', story: storyId, veredicto, destino: sid, corrida })}\n`);
  };
  l.cambiar = (de, a) => { const s = fs.readFileSync(story, 'utf8'); assert.ok(s.includes(de), `la historia de la prueba no trae ${de}`); fs.writeFileSync(story, s.replace(de, a)); };
  return l;
}

function env(home) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_PACKS_DEFAULT: 'none', TYCON_PROFILE: '0' };
  for (const k of ['NODE_TEST_CONTEXT', 'TYCON_STORY_REVIEW', 'CLAUDE_CODE_SESSION_ID']) delete e[k];
  return e;
}
function run(cmd, l) {
  const r = spawnSync(process.execPath, [PIPELINE, cmd, '--story', l.story, '--repo', l.repo], { encoding: 'utf8', env: env(l.home), cwd: l.repo, input: '' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { json = null; }
  return { rc: r.status, out: `${r.stdout}\n${r.stderr}`, json };
}

// Lo que pasó en una historia real: la revisión del plan rechazó, la sesión corrigió una prueba y un archivo de la
// historia, y las dos constancias vencieron. Antes de la vuelta 2, `validators` dio vencida la revisión y corrió la
// adversarial; su corrección venció la validación, y un segundo `validators` corrió el validador.
// 🔴 Falla con: vencer igual con un cambio técnico tras el rechazo, o relanzar al validador o al revisor de historias.
test('Revalidacion_CambioTecnicoTrasPlanRechazado_NoRelanzaNiValida', (t) => {
  const l = lab(t);
  l.revision('rechazado');
  l.cambiar('| T2 | `Pedido_Vacio_SeRechaza` | 2 |', '| T2 | `Pedido_Vacio_SeRechaza` | 2 |\n| T3 | `Pedido_TotalConDescuento` | 1 |');
  l.cambiar('  - src/m7.js\n', '  - src/m7.js\n  - src/m8.js\n');
  l.cambiar('El total se calcula en src/m0.js.', 'El total se calcula en src/m0.js, con el descuento de src/m8.js.');
  const g = run('story-review-gate', l);
  assert.strictEqual(g.rc, 0, g.out);
  assert.strictEqual(g.json.run, false, `la adversarial no se relanza: ${g.out}`);
  assert.strictEqual(g.json.record, 'por-revalidar', g.out);
  assert.match(g.json.linea, /a revalidar por la vuelta del plan/);
  const v = run('validators', l);
  assert.strictEqual(v.rc, 0, v.out);
  assert.strictEqual(v.json.validacion_previa.estado, 'por-revalidar', v.out);
  assert.ok(v.json.validacion_previa.omitidos.includes('tycon-story-validator'), `el validador no se vuelve a lanzar: ${v.out}`);
  assert.ok(!v.json.lanzamientos.some((x) => x.agente === AGENTE), `el revisor de historias no se relanza: ${v.out}`);
});

// 🔴 Falla con: dejar a revalidar un cambio de comportamiento, una sección que no se reconoce, una constancia sin su texto
//    o un cambio sin un plan rechazado después de la constancia.
test('Revalidacion_LoQueSigueVenciendo', (t) => {
  const vence = (nombre, preparar) => {
    const l = lab(t);
    preparar(l);
    const g = run('story-review-gate', l);
    assert.strictEqual(g.rc, 0, `${nombre}: ${g.out}`);
    assert.strictEqual(g.json.run, true, `${nombre}: la adversarial corre otra vez: ${g.out}`);
    assert.strictEqual(g.json.record, 'stale', `${nombre}: ${g.out}`);
  };
  const prueba = (l) => l.cambiar('| T2 | `Pedido_Vacio_SeRechaza` | 2 |', '| T2 | `Pedido_Vacio_SeRechazaConMensaje` | 2 |');
  vence('un criterio', (l) => { l.revision('rechazado'); l.cambiar('queda con su total.', 'queda con su total y su fecha.'); });
  vence('la historia', (l) => { l.revision('rechazado'); l.cambiar('para ver su total.', 'para pagarlo después.'); });
  vence('otra clave del encabezado', (l) => { l.revision('rechazado'); l.cambiar('title: "historia de laboratorio 9.4"', 'title: "otra cosa"'); });
  vence('una sección desconocida', (l) => { l.revision('rechazado'); l.cambiar('## Tasks / Subtasks', '## Alcance extra\n\nTambién exporta a PDF.\n\n## Tasks / Subtasks'); });
  vence('un grupo de criterios sin nombre conocido', (l) => { l.revision('rechazado'); l.cambiar('### Tests', '### La matriz\n\n3. **Given** x **When** y **Then** z.\n\n### Tests'); });
  vence('sin rechazo', (l) => { l.revision('aprobado'); prueba(l); });
  vence('el rechazo de antes de la constancia', (l) => { l.revision('rechazado', { ms: -60000 }); prueba(l); });
  vence('el rechazo de otra historia', (l) => { l.revision('rechazado', { storyId: '9.5' }); prueba(l); });
  vence('el rechazo de otra corrida', (l) => { l.revision('rechazado', { otraCorrida: true }); prueba(l); });
  vence('un aprobado después del rechazo', (l) => { l.revision('rechazado'); l.revision('aprobado', { ms: 2000 }); prueba(l); });
  vence('una salvaguarda de las notas', (l) => { l.revision('rechazado'); l.cambiar('No tocar la tabla de precios.', 'Se puede tocar la tabla de precios.'); });
  vence('una prueba que se va', (l) => { l.revision('rechazado'); l.cambiar('| T2 | `Pedido_Vacio_SeRechaza` | 2 |\n', ''); });
  vence('un título con sangría', (l) => { l.revision('rechazado'); l.cambiar('El total se calcula en src/m0.js.', 'El total se calcula en src/m0.js.\n\n  ## Acceptance Criteria\n\n3. **Given** x **When** y **Then** z.'); });
  vence('una revisión saltada por riesgo bajo', (l) => {
    SR().writeRecord(l.home, l.story, { resultado: 'saltado', motivo: 'riesgo-bajo', hallazgos: [], riesgo: 'LOW' });
    VR().writeRecord(l.home, l.story, { resultado: 'verde', validadores: ['tycon-story-validator'] });
    l.revision('rechazado');
    prueba(l);
  });
  vence('una constancia sin su texto', (l) => {
    l.revision('rechazado');
    const f = SR().recordFile(l.home, l.story);
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete r.texto;
    fs.writeFileSync(f, JSON.stringify(r));
    prueba(l);
  });
});

// 🔴 Falla con: decidir el tipo por el título de arriba (las pruebas son técnicas aunque vivan bajo los criterios), o
//    tomar como título lo que está dentro de un bloque de código.
test('Revalidacion_Partes_ElTituloMasCercanoDecide', () => {
  const tipos = (viejo, nuevo) => SRV().cambios(viejo, nuevo).map((c) => `${c.tipo}: ${c.parte}`);
  const base = '## Acceptance Criteria\n\n1. x\n\n### Tests\n\n| T1 |\n\n## Dev Notes\n\n### Archivos a crear/modificar\n\n```\n# no es título\n```\n';
  assert.deepStrictEqual(tipos(base, base.replace('| T1 |', '| T1 |\n| T2 |')), ['tecnico: ## Acceptance Criteria > ### Tests']);
  assert.deepStrictEqual(tipos(base, base.replace('1. x', '1. y')), ['comportamiento: ## Acceptance Criteria']);
  assert.deepStrictEqual(tipos(base, base.replace('# no es título', '# no es título\notra')), ['tecnico: ## Dev Notes > ### Archivos a crear/modificar']);
  // un título de comportamiento que se renombra a uno técnico cuenta como comportamiento: se va una parte que lo era
  assert.ok(tipos(base, base.replace('## Acceptance Criteria', '## Tests')).some((x) => x.startsWith('comportamiento')));
  // una salvaguarda, con cualquier nombre después, y una prueba que se va bajo un subtítulo de las pruebas
  const notas = '## Dev Notes\n\n### Salvaguarda de estado (obligatoria antes de implementar)\n\nCopiar el estado antes.\n';
  assert.deepStrictEqual(tipos(notas, notas.replace('Copiar el estado antes.', 'No hace falta copiar.')).map((x) => x.split(':')[0]), ['comportamiento']);
  const sub = '## Acceptance Criteria\n\n### Tests\n\n#### Backend\n\n| T1 |\n| T2 |\n';
  assert.deepStrictEqual(tipos(sub, sub.replace('| T2 |\n', '')).map((x) => x.split(':')[0]), ['comportamiento']);
  // un renglón «```x```» no abre un bloque (Markdown): el título que sigue sigue siendo título
  const linea = '## Dev Notes\n\n```x```\n\n### Lo que NO hay que hacer\n\nNo tocar precios.\n';
  assert.deepStrictEqual(tipos(linea, linea.replace('No tocar precios.', 'Tocar precios.')).map((x) => x.split(':')[0]), ['comportamiento']);
});

/**
 * La revisión del plan de verdad (preparar y anotar en proceso), sobre una corrida con el plan cerrado: el laboratorio de
 * plan-review.test.js reducido a una sesión que revisa su propio plan.
 */
function labPlan(t) {
  const l = lab(t);
  const sid = 'ses-revalida';
  const git = (...a) => execFileSync('git', ['-C', l.repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore' });
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('add', '.'); git('commit', '-qm', 'base');
  const e = { ...env(l.home), CLAUDE_CODE_SESSION_ID: sid };
  const m = (args) => spawnSync(process.execPath, [MARKER, ...args], { cwd: l.repo, encoding: 'utf8', env: e });
  const set = m(['set', JSON.stringify({ storyId: '9.4', storyPath: l.story, repoPath: l.repo })]);
  assert.strictEqual(set.status, 0, set.stderr);
  for (const n of ['0', '1', '2']) m(['complete-step', n]);
  const runDir = require(PIPELINE).resolveRunDir(l.repo, '9.4', true, l.story);
  fs.writeFileSync(path.join(runDir, 'step-02-bmad-plan.md'), '# Plan\n\n## Pasos\n\n1. Calcular el total en src/m0.js.\n2. Sumar la prueba del descuento.\n');
  const config = PR().configDeLaOrganizacion().values;
  l.sid = sid;
  l.preparar = () => PR().preparar({ lanza: sid, estado: l.estado, home: l.home, config });
  l.anotar = (p, resultado) => PR().anotar({ lanza: sid, estado: l.estado, home: l.home, resultado: { pedido: p.args.pedido, ...resultado }, modelo: 'opus', proveedor: 'anthropic' });
  return l;
}
// el resultado del pase con la lente del cambio medida (adversarial-verify.workflow.js la suma cuando viene el cambio)
const APROBADO = { modo: 'plan', medido: true, confirmed: [], hallazgos_sin_veredicto: 0, a_verificar_aparte: 0, lentes_sin_medir: [],
  lentes: [{ lens: 'suposicion-falsa', estado: 'medida', count: 0 }, { lens: 'cambio-de-historia', estado: 'medida', count: 0 }] };
const RECHAZADO = { ...APROBADO, confirmed: [{ lens: 'cambio-de-historia', severity: 'bug', file: 'plan', summary: 'el cambio de la prueba toca el criterio 1', repro: 'x', confidence: 'high' }] };
const SIN_LA_LENTE = { ...APROBADO, lentes: [{ lens: 'suposicion-falsa', estado: 'medida', count: 0 }] };
// la lente del cambio encontró algo y su verificador lo refutó: el veredicto sale aprobado, pero no revalida
const REFUTADO = { ...APROBADO, lentes: [{ lens: 'suposicion-falsa', estado: 'medida', count: 0 }, { lens: 'cambio-de-historia', estado: 'medida', count: 1 }] };

// 🔴 Falla con: lanzar la vuelta sin el cambio a la vista, escribir las constancias con una vuelta rechazada o con la
//    historia cambiada otra vez, o no escribirlas cuando la vuelta aprueba.
test('PlanReview_VueltaQueRevalida_EscribeLasConstanciasSoloAlAprobar', (t) => {
  const cambiarPrueba = (l) => l.cambiar('| T2 | `Pedido_Vacio_SeRechaza` | 2 |', '| T2 | `Pedido_Vacio_SeRechaza` | 2 |\n| T3 | `Pedido_TotalConDescuento` | 1 |');
  // aprobada: las dos constancias nuevas, atadas a la revisión del plan
  const a = labPlan(t);
  a.revision('rechazado');
  cambiarPrueba(a);
  const p = a.preparar();
  assert.strictEqual(p.codigo, 0, p.motivo);
  assert.match(p.args.cambioDeHistoria || '', /\+ \| T3 \| `Pedido_TotalConDescuento`/, 'la vuelta ve el cambio, aparte de la historia');
  assert.doesNotMatch(p.args.storyTexto, /Cambio de la historia/, 'la historia va como está: el cambio lo juzga su propia lente');
  // el cuadro de quien firma lo dice mientras ninguna vuelta lo revalidó
  const cuadro = PR().lineaDelCuadro({ estado: a.estado, destino: a.sid, marker: JSON.parse(fs.readFileSync(path.join(a.estado, 'active', `${a.sid}.json`), 'utf8')), home: a.home });
  assert.match(cuadro.linea, /ninguna vuelta del plan la revalidó/, cuadro.linea);
  const c = a.anotar(p, APROBADO);
  assert.strictEqual(c.veredicto, 'aprobado', JSON.stringify(c));
  assert.deepStrictEqual(c.revalidacion && c.revalidacion.kinds, ['validacion', 'revision'], JSON.stringify(c.revalidacion));
  assert.strictEqual(VR().readRecord(a.home, a.story).estado, 'current');
  const rev = SR().readRecord(a.home, a.story);
  assert.strictEqual(rev.estado, 'current');
  assert.strictEqual(rev.record.resultado, 'revalidada');
  assert.strictEqual(rev.record.origen.revision_del_plan, c.id);
  // aprobada sin la lente del cambio medida: no reemplaza la revalidación
  const n = labPlan(t);
  n.revision('rechazado');
  cambiarPrueba(n);
  const cn = n.anotar(n.preparar(), SIN_LA_LENTE);
  assert.strictEqual(cn.veredicto, 'aprobado', JSON.stringify(cn));
  assert.strictEqual(cn.revalidacion, undefined, 'sin la lente del cambio no se escriben constancias');
  assert.strictEqual(SR().readRecord(n.home, n.story).estado, 'stale');
  // la lente del cambio encontró algo, aunque su verificador lo refutó: tampoco
  const f = labPlan(t);
  f.revision('rechazado');
  cambiarPrueba(f);
  const cf = f.anotar(f.preparar(), REFUTADO);
  assert.strictEqual(cf.veredicto, 'aprobado', JSON.stringify(cf));
  assert.strictEqual(cf.revalidacion, undefined, 'un hallazgo de la lente del cambio, refutado o no, no revalida');
  // rechazada: no escribe nada y siguen a revalidar
  const r = labPlan(t);
  r.revision('rechazado');
  cambiarPrueba(r);
  const cr = r.anotar(r.preparar(), RECHAZADO);
  assert.strictEqual(cr.veredicto, 'rechazado', JSON.stringify(cr));
  assert.strictEqual(cr.revalidacion, undefined);
  assert.strictEqual(SR().readRecord(r.home, r.story).estado, 'stale');
  // la historia cambió otra vez mientras corría: sin veredicto y sin constancias
  const s = labPlan(t);
  s.revision('rechazado');
  cambiarPrueba(s);
  const ps = s.preparar();
  s.cambiar('1. Guardar el total.', '1. Guardar el total y la fecha.');
  const cs = s.anotar(ps, APROBADO);
  assert.strictEqual(cs.veredicto, 'sin-veredicto', JSON.stringify(cs));
  assert.strictEqual(cs.revalidacion, undefined);
  assert.strictEqual(VR().readRecord(s.home, s.story).estado, 'stale');
});
