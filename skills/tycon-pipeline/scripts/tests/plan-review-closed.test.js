'use strict';
/**
 * plan-review-closed.test.js — la revisión del plan se lanza sobre el plan cerrado.
 *
 *   PlanReview_SinPlanCerradoOConPreguntaAbierta_NoSeLanza — con «Armar el plan» abierto, o con una pregunta sin
 *     contestar a la persona, la preparación se niega y no deja pedido
 *   PlanReview_LaHistoriaCambiaMientrasCorre_UnSoloReintentoEntreLosDos — el plan o la historia que cambian mientras
 *     corre la dejan sin veredicto, y se relanza una sola vez entre los dos
 *
 * Una casa y un repo de juguete por prueba, con los guiones de verdad; la coordinadora designada y confirmada en el
 * registro. 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const DS = require(path.join(RAIZ, 'scripts', 'lib', 'delegated-signing.js'));
const PR = () => require(path.join(SCRIPTS, 'lib', 'plan-review.js'));
const POL = () => require(path.join(SCRIPTS, 'lib', 'review-policy.js'));

const COORD = 'ses-coord';
const DESTINO = 'ses-a';
const HUELLA = 'a1b2c3d4e5f60718';
const PERFIL = { relay_session: 'coordinadora', delegated_signing: ['plan-approval'], owner_only: [], delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] };
const delegacion = (o) => DS.delegaSinVentana({ ...o, perfil: () => PERFIL, huella: () => ({ huella: HUELLA }) });
const PLAN = '# Plan\n\n## Qué hace\n\nCambia el título del README.\n\n## Archivos\n\n- README.md\n\n## Pasos\n\n1. Tocar el README.md.\n';
const APROBADO = { modo: 'plan', medido: true, confirmed: [], hallazgos_sin_veredicto: 0, a_verificar_aparte: 0, lentes_sin_medir: [] };
const cfgCon = (raw = {}) => POL().normalize(raw).values;

/** El repo y la casa: dos corridas abiertas con «Armar el plan» cerrado, el plan de ses-a escrito y la coordinadora. */
function laboratorio(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-cerrado-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(home);
  // stable-data: la fecha del commit de juguete es fija
  const fecha = { GIT_AUTHOR_DATE: '2026-11-20T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-20T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: { ...process.env, ...fecha } });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const historia = (n) => {
    const f = path.join(repo, 'specs', `story-${n}-juguete.md`);
    fs.writeFileSync(f, ['---', `story: "${n}"`, 'title: "juguete"', 'status: in-progress', 'files_to_modify:', '  - README.md', '---', '', `# Story ${n}`, ''].join('\n'));
    return f;
  };
  const stories = { [DESTINO]: historia('9.91'), [COORD]: historia('9.92') };
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_PROFILE: '0' };
  for (const k of ['TYCON_HOME', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_OPTIONS', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS']) delete env[k];
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  const lab = { repo, home, estado, stories };
  lab.marker = (sid, args) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8', env: { ...env, CLAUDE_CODE_SESSION_ID: sid } });
  lab.marcador = (sid) => path.join(estado, 'active', `${sid}.json`);
  lab.leer = (sid) => JSON.parse(fs.readFileSync(lab.marcador(sid), 'utf8'));
  for (const [sid, storyId] of [[DESTINO, '9.91'], [COORD, '9.92']]) {
    const set = lab.marker(sid, ['set', JSON.stringify({ storyId, storyPath: stories[sid], repoPath: repo })]);
    assert.strictEqual(set.status, 0, set.stderr);
    for (const n of ['0', '1', '2']) lab.marker(sid, ['complete-step', n]);
  }
  lab.planFile = path.join(require(PIPELINE).resolveRunDir(repo, '9.91', true, stories[DESTINO]), 'step-02-bmad-plan.md');
  fs.writeFileSync(lab.planFile, PLAN);
  const d = { name: 'relay-designation', status: 'ok', ts: '2026-10-27T08:00:00.000Z', sesion: COORD, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DS.confirmationRecord(d, '2026-10-27T08:01:00.000Z'))}\n`);
  lab.preparar = () => PR().preparar({ lanza: COORD, destino: DESTINO, estado, home, delegacion });
  /** Prepara, deja que `antesDeAnotar` cambie algo y anota el resultado del pase. */
  lab.revisar = (antesDeAnotar) => {
    const p = lab.preparar();
    assert.strictEqual(p.codigo, 0, p.motivo);
    if (antesDeAnotar) antesDeAnotar();
    return PR().anotar({ lanza: COORD, destino: DESTINO, estado, resultado: { pedido: p.args.pedido, ...APROBADO }, modelo: 'opus', proveedor: 'anthropic' });
  };
  return lab;
}
// 🔴 Falla con: la revisión que se lanza con el plan todavía abierto, o con una pregunta sin contestar a la persona, y se
//    pierde (medido: cuatro lanzamientos para un plan, media hora).
test('PlanReview_SinPlanCerradoOConPreguntaAbierta_NoSeLanza', (t) => {
  const lab = laboratorio(t);
  const preparar = lab.preparar;
  // con «Armar el plan» abierto
  const m = lab.leer(DESTINO);
  // el plan cerrado, con el nombre de hoy o el de la numeración vieja («2»)
  const esPlan = (s) => s === 'plan' || s === '2';
  const sinPlan = { ...m, stepsCompleted: (m.stepsCompleted || []).filter((s) => !esPlan(String(s))), stepsPending: [...(m.stepsPending || [])] };
  fs.writeFileSync(lab.marcador(DESTINO), JSON.stringify(sinPlan));
  const abierto = preparar();
  assert.strictEqual(abierto.codigo, 2);
  assert.match(abierto.motivo, /no está cerrado: se lanza la revisión después de cerrar «Armar el plan»/);
  assert.ok(!fs.existsSync(path.join(lab.estado, 'plan-review', COORD, `${DESTINO}.pending.json`)), 'no deja pedido');
  fs.writeFileSync(lab.marcador(DESTINO), JSON.stringify(m));
  // con una pregunta a la persona sin contestar
  const ask = lab.marker(DESTINO, ['review-ask', '--kind', 'plan']);
  assert.strictEqual(ask.status, 0, ask.stderr);
  const conPregunta = preparar();
  assert.strictEqual(conPregunta.codigo, 2);
  assert.match(conPregunta.motivo, /hay una pregunta abierta a la persona/);
  // contestada, se lanza
  const ans = lab.marker(COORD, ['review-answer', '--kind', 'plan', '--choice', 'review', '--for-session', DESTINO]);
  assert.strictEqual(ans.status, 0, ans.stderr);
  assert.strictEqual(preparar().codigo, 0);
});

// 🔴 Falla con: un cambio en la historia mientras corre la revisión que no la invalida (aprueba lo que ya no está), o que
//    suma un reintento propio aparte del del plan: entre los dos se relanza una sola vez.
test('PlanReview_LaHistoriaCambiaMientrasCorre_UnSoloReintentoEntreLosDos', (t) => {
  const lab = laboratorio(t);
  const config = cfgCon({ plan_review: { routine: 'always' } });
  const accion = () => PR().accionDelPlan({ estado: lab.estado, sesion: DESTINO, marker: lab.leer(DESTINO), config, home: lab.home });
  const historia = lab.stories[DESTINO];
  let c = lab.revisar(() => fs.appendFileSync(historia, '\nAC 9. sumado mientras corría.\n'));
  assert.strictEqual(c.veredicto, 'sin-veredicto');
  assert.match(c.motivo, /la historia cambió mientras corría la revisión/);
  assert.strictEqual(c.reintentar, true);
  assert.strictEqual(accion().reintento, true);
  // la segunda vez cambia el plan: ya se reintentó una vez, llega a la persona
  c = lab.revisar(() => fs.writeFileSync(lab.planFile, `${PLAN}7. cambió mientras corría\n`));
  assert.strictEqual(c.reintentar, undefined, 'entre el plan y la historia se reintenta una sola vez');
  const a = accion();
  assert.strictEqual(a.comando, undefined);
  assert.strictEqual(a.alDueno.llega, true);
  assert.match(a.alDueno.motivo, /cambió mientras corría la revisión, dos veces/);
});

// 🔴 Falla con: un ajuste del registro de la historia (su «Change Log», el estado) que tira la revisión del
//    plan, o un cambio en lo que se construye (un criterio, una sección con otro nombre) que no la tira.
test('PlanReview_RedaccionDelRegistro_NoTiraLaRevision_LoQueSeConstruyeSi', (t) => {
  const lab = laboratorio(t);
  const historia = lab.stories[DESTINO];
  const original = fs.readFileSync(historia, 'utf8');
  // esta prueba lanza más de tres vueltas: la persona las responde (la cuarta vuelta la mide la prueba de abajo)
  const responder = () => PR().anotarRespuesta({ estado: lab.estado, sesion: DESTINO, kind: 'plan', choice: 'review', quien: 'la persona de la prueba', ahora: Date.now() + 1 });
  const conRegistro = (s) => `${s.replace('status: in-progress', 'status: review')}\n## Acceptance Criteria\n\nAC 1. el README dice x.   \n\n\n## Dev Agent Record\n\n### Change Log\n\n- 2026-11-20: hallazgos de la vuelta anterior.\n`;
  const base = conRegistro(original);
  fs.writeFileSync(historia, base);
  // el registro de después y el estado: la revisión vale
  for (const [nombre, cambiar] of [
    ['el Change Log', () => base.replace('hallazgos de la vuelta anterior.', 'hallazgos de la vuelta anterior, corregidos.')],
    ['el estado', () => base.replace('status: review', 'status: in-progress')],
  ]) {
    responder();
    const c = lab.revisar(() => fs.writeFileSync(historia, cambiar()));
    assert.strictEqual(c.veredicto, 'aprobado', nombre);
    fs.writeFileSync(historia, base);
  }
  // lo que se construye: un criterio, una sección con otro nombre, o lo que va antes del registro
  for (const [nombre, cambiar] of [
    ['un criterio', () => base.replace('AC 1. el README dice x.', 'AC 1. el README dice y.')],
    ['otra sección', () => `${base}\n## Notas sueltas\n\nalgo\n`],
    ['un título dentro de un bloque de código', () => base.replace('## Dev Agent Record', '```\n## Dev Agent Record\n```\n\n## Dev Agent Record')],
  ]) {
    responder();
    const c = lab.revisar(() => fs.writeFileSync(historia, cambiar()));
    assert.strictEqual(c.veredicto, 'sin-veredicto', nombre);
    assert.match(c.motivo, /la historia cambió mientras corría/, nombre);
    fs.writeFileSync(historia, base);
  }
});

// 🔴 Falla con: una cuarta vuelta de la revisión del plan de la misma historia que se lanza sola (por cualquier motivo,
//    también con la persona ausente), o que sigue frenada después de su respuesta o de la vuelta extra firmada.
test('PlanReview_CuartaVuelta_LaDecideUnaPersona', (t) => {
  const lab = laboratorio(t);
  const config = cfgCon({ plan_review: { routine: 'always' } });
  const accion = () => PR().accionDelPlan({ estado: lab.estado, sesion: DESTINO, marker: lab.leer(DESTINO), config, home: lab.home });
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(lab.planFile, `${PLAN}${i + 1}. vuelta ${i}\n`);
    assert.strictEqual(lab.revisar().veredicto, 'aprobado', `vuelta ${i}`);
  }
  fs.writeFileSync(lab.planFile, `${PLAN}9. otra versión\n`);
  // la cuarta: la preparación se niega sin dejar pedido, y la acción pide la pregunta
  const lanzadas = () => fs.readFileSync(path.join(lab.estado, 'gates.log'), 'utf8').split('\n').filter((l) => l.includes('"plan-review-launch"')).length;
  const p = lab.preparar();
  assert.strictEqual(p.codigo, 2);
  assert.match(p.motivo, /ya van 3 vueltas .*la próxima la decide una persona/);
  assert.strictEqual(lanzadas(), 3, 'no lanza');
  const a = accion();
  assert.strictEqual(a.comando, 'marker.js review-ask --kind plan');
  assert.deepStrictEqual(a.cuartaVuelta, { vueltas: 3 });
  assert.strictEqual(a.alDueno.llega, true);
  // la persona ausente no la destraba
  const ausente = lab.marker(DESTINO, ['owner-away', 'set']);
  assert.strictEqual(lab.preparar().codigo, 2, `con la marca de ausente (${ausente.status})`);
  // con su «review», sale; la quinta vuelve a preguntar
  const ask = lab.marker(DESTINO, ['review-ask', '--kind', 'plan']);
  assert.strictEqual(ask.status, 0, ask.stderr);
  const ans = lab.marker(COORD, ['review-answer', '--kind', 'plan', '--choice', 'review', '--for-session', DESTINO]);
  assert.strictEqual(ans.status, 0, ans.stderr);
  assert.strictEqual(lab.revisar().veredicto, 'aprobado');
  assert.strictEqual(lab.preparar().codigo, 2, 'la quinta vuelve a preguntar');
  // la vuelta extra firmada para esta historia también es la respuesta de la persona; la de otra historia, no
  const gates = path.join(lab.estado, 'gates.log');
  // la hora del renglón no cuenta: vale el orden del registro
  const firma = (story, via = 'ventana') => fs.appendFileSync(gates, `${JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', story, name: 'extra-round-signed', status: 'ok', via, sesion: COORD, destino: DESTINO })}\n`);
  firma('9.91', 'delegacion');
  assert.strictEqual(lab.preparar().codigo, 2, 'la vuelta extra firmada por delegación no es la respuesta de una persona');
  firma('9.92');
  assert.strictEqual(lab.preparar().codigo, 2, 'la vuelta extra de otra historia no cuenta');
  firma('9.91');
  assert.strictEqual(lab.preparar().codigo, 0, 'la vuelta extra de esta historia sí');
});

// 🔴 Falla con: una forma de Markdown que el corte lee distinto que quien la lee (un bloque de código suelto o mezclado,
//    un título subrayado o con sangría, un comentario, una sección de registro de nivel 1) y que esconde de la huella un
//    cambio en lo que se construye; o un BOM, el estado o el registro que la cambian.
test('HuellaDeConstruccion_LoDudosoCuenta_ElRegistroNo', () => {
  const h = PR().huellaDeConstruccion;
  const base = '---\nstory: "1"\nstatus: draft\n---\n# Story 1\n\n## Acceptance Criteria\n\nAC 1. x\n\n## Dev Agent Record\n\n### Change Log\n\n- algo\n';
  const cuenta = {
    'un bloque de código suelto en el registro': `${base}\`\`\`\n\n## Cambios de comportamiento\n\nhace A\n`,
    'un título subrayado': `${base}\nCambios de comportamiento\n-------------------------\n\nhace A\n`,
    'un título con sangría': `${base}\n   ## Cambios de comportamiento\n\nhace A\n`,
    'código en línea que parece un bloque': `${base}\n\`\`\`x\`\`\` nota\n\n## Criterios nuevos\n\nhace A\n`,
    'bloques mezclados': '# T\n\n## Tasks\n\`\`\`\n~~~\n## Change Log\n\`\`\`\n\n## AC\n1. hace A\n',
    'un comentario': '# T\n<!--\n## Change Log\n-->\n1. hace A\n',
    'el registro de nivel 1': '# Change Log\n\n## AC\nhace A\n',
    'un bloque de cuatro que trae uno de tres': '# T\n\n## AC\n\`\`\`\`md\n\`\`\`\n## Change Log\n\`\`\`\`\nhace A\n',
  };
  for (const [nombre, texto] of Object.entries(cuenta)) assert.notStrictEqual(h(texto.replace('hace A', 'hace B')), h(texto), nombre);
  // el registro de después, el estado y el BOM: no cambian
  assert.strictEqual(h(base.replace('- algo', '- otra cosa')), h(base), 'el Change Log');
  const conAjustes = base.replace('## Dev Agent Record', '## Ajustes después de la firma\n\n- [ ] cambiar el ejemplo\n\n## Dev Agent Record');
  assert.strictEqual(h(conAjustes), h(base), 'un ajuste anotado para después de la firma');
  assert.strictEqual(h(base.replace('status: draft', 'status: done')), h(base), 'el estado');
  assert.strictEqual(h(`\uFEFF${base}`), h(base), 'el BOM');
  assert.strictEqual(h(base.replace(/\n/g, '\r\n')), h(base), 'los fines de renglón');
  // lo demás, sí
  assert.notStrictEqual(h(base.replace('AC 1. x', 'AC 1. y')), h(base), 'un criterio');
  assert.notStrictEqual(h(base.replace('AC 1. x', 'AC 1. x ')), h(base), 'un espacio en lo que se construye');
});
