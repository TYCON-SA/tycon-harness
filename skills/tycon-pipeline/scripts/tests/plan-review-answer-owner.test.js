'use strict';
/**
 * plan-review-answer-owner.test.js — «seguir sin revisión» y «esperar» a la pregunta de revisar el plan los decide el
 * dueño; «review», no.
 *
 *   ReviewAnswer_SkipOWaitDelPlanSinElDueno_NoSeAnota — sin el click del dueño ni su terminal (sin vía, la delegación, la
 *     ventana, un «aprobado» escrito, la firma de trámite), `anotarRespuesta` no escribe nada
 *   ReviewAnswer_ReviewYLaDelCodigo_SeAnotanSinFirma — «review» al plan y al código, como siempre
 *   ReviewAnswer_ConLaViaDelDueno_SeAnotaYCuenta — con el click: el renglón lleva la vía, cierra la pregunta y elige seguir
 *   ReviewAnswer_RenglonSinElDueno_NoCierraLaPreguntaNiSaltea — un renglón de antes, sin la vía, no saca la pregunta de la
 *     vista ni hace seguir sin revisión: la cuarta vuelta sigue esperando a una persona
 *   Freno_SkipOWaitDelPlan_PidenLaFirmaDelDueno — el freno le ve la firma `plan-review-answer` a `skip` y `wait` del plan,
 *     en cualquier forma; a `review`, ninguna (la del código tiene la suya). En el catálogo: nivel 2, sólo el click del dueño,
 *     la pide la coordinadora para otra sesión y no se delega aunque el perfil la nombre
 *   Freno_SinElClickDelDueno_NoDeja — la coordinadora que anota «skip» o «wait» para otra sesión: el freno le da el cuadro
 *   Freno_ConElClickDeOtroPedido_NoDeja — el click a «wait», a otra versión del plan o a otra firma no sirve para este «skip»
 *   Freno_ConElClickDeEsePedido_Deja — el click a este mismo pedido, en la pestaña de la coordinadora o en la de la sesión
 *   Coordinacion_DuenoAusente_NoMandaAnotarSkipNiWait — con el dueño ausente, la coordinadora no recibe la orden de anotar
 *     «skip» ni «wait» al plan: la pregunta queda a la vista; con «review», sí
 *
 * El laboratorio: tests/lib/review-answer-lab.js. 0 deps (node:test).
 *
 * stable-data: las horas son las de la corrida de la prueba; ninguna se compara con una fecha fija.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('./lib/review-answer-lab.js');

const { laboratorio, salida, SKIP, WAIT, REVIEW, COORD, DESTINO, FIRMA, PR, OW, COPIA } = L;
const SIG = require(path.join(COPIA, 'scripts', 'lib', 'signatures.js'));
const huella = (lab) => PR.huellaDe({ estado: lab.estado, sesion: DESTINO, kind: 'plan' }).huella;
const anotar = (lab, o) => PR.anotarRespuesta({ estado: lab.estado, sesion: DESTINO, kind: 'plan', quien: `coordinadora ${COORD}`, huella: huella(lab), ...o });

test('ReviewAnswer_SkipOWaitDelPlanSinElDueno_NoSeAnota', (t) => {
  const lab = laboratorio(t);
  for (const choice of ['skip', 'wait']) {
    for (const via of [null, 'delegacion', 'ventana', 'mensaje', 'automatica', 'avisado']) {
      const r = anotar(lab, { choice, via });
      assert.strictEqual(r.codigo, 2, `${choice} por ${via}`);
      assert.match(r.motivo, /lo anota sólo una persona, con su click en el cuadro de la firma plan-review-answer o en su terminal/);
    }
  }
  assert.deepStrictEqual(lab.respuestas(), [], 'no se escribió nada');
  assert.deepStrictEqual(lab.abiertas(), [`${DESTINO}/plan`], 'la pregunta sigue a la vista');
  assert.ok(lab.accion().alDueno.llega, 'la cuarta vuelta sigue esperando a una persona');
});

test('ReviewAnswer_ReviewYLaDelCodigo_SeAnotanSinFirma', (t) => {
  const lab = laboratorio(t);
  assert.strictEqual(anotar(lab, { choice: 'review' }).codigo, 0);
  // «review» al código también; «skip» y «wait» al código los mira code-review-answer-owner.test.js
  assert.strictEqual(PR.anotarRespuesta({ estado: lab.estado, sesion: DESTINO, kind: 'code', choice: 'review', quien: `sesión ${DESTINO}`, huella: 'h-code' }).codigo, 0);
  assert.deepStrictEqual(lab.respuestas().map((j) => [j.kind, j.choice, j.via || null]), [['plan', 'review', null], ['code', 'review', null]]);
  assert.deepStrictEqual(lab.abiertas(), [], '«review» cierra la pregunta del plan');
  assert.strictEqual(PR.respuestaDe({ estado: lab.estado, sesion: DESTINO, kind: 'code', huella: 'h-code' }), 'review', 'la del código cuenta como siempre');
});

test('ReviewAnswer_ConLaViaDelDueno_SeAnotaYCuenta', (t) => {
  const lab = laboratorio(t);
  assert.strictEqual(anotar(lab, { choice: 'skip', via: 'click' }).codigo, 0);
  const [r] = lab.respuestas();
  assert.deepStrictEqual([r.choice, r.via, r.quien], ['skip', 'click', `coordinadora ${COORD}`]);
  assert.deepStrictEqual(lab.abiertas(), []);
  assert.strictEqual(PR.eligioSeguir({ estado: lab.estado, destino: DESTINO, huellaPlan: huella(lab) }), true);
  const a = lab.accion();
  assert.deepStrictEqual([a.decision, a.alDueno || null], ['skip', null], JSON.stringify(a));
  // la terminal del dueño también: «esperar» cierra la pregunta
  const otro = laboratorio(t);
  assert.strictEqual(PR.anotarRespuesta({ estado: otro.estado, sesion: DESTINO, kind: 'plan', choice: 'wait', quien: 'terminal del dueño', huella: huella(otro), via: 'terminal' }).codigo, 0);
  assert.deepStrictEqual(otro.abiertas(), []);
});

test('ReviewAnswer_RenglonSinElDueno_NoCierraLaPreguntaNiSaltea', (t) => {
  const lab = laboratorio(t);
  const h = huella(lab);
  // los renglones que dejaba la coordinadora sin el dueño: sin vía
  for (const choice of ['skip', 'wait']) {
    fs.appendFileSync(path.join(lab.estado, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), name: 'review-answer', status: 'ok', sesion: DESTINO, kind: 'plan', choice, quien: `coordinadora ${COORD}`, huella: h, motivo: null })}\n`);
    assert.deepStrictEqual(lab.abiertas(), [`${DESTINO}/plan`], `«${choice}» sin el dueño no saca la pregunta de la vista`);
    assert.strictEqual(PR.eligioSeguir({ estado: lab.estado, destino: DESTINO, huellaPlan: h }), false);
    assert.strictEqual(PR.respuestaDe({ estado: lab.estado, sesion: DESTINO, kind: 'plan', huella: h }), null);
    const a = lab.accion();
    assert.notStrictEqual(a.decision, 'skip', JSON.stringify(a));
    assert.ok(a.alDueno && a.alDueno.llega, 'la cuarta vuelta sigue esperando a una persona');
  }
  assert.strictEqual(PR.lineaDelCuadro({ estado: lab.estado, destino: DESTINO, marker: lab.leer(), config: L.CONFIG }).linea === 'sin revisión (se eligió seguir)', false);
});

test('Freno_SkipOWaitDelPlan_PidenLaFirmaDelDueno', () => {
  const M = '/x/skills/tycon-pipeline/scripts/marker.js';
  const firmas = (resto) => OW.firmasDelComando(`node ${M} review-answer ${resto}`);
  for (const resto of ['--kind plan --choice skip --for-session ses-a', '--kind plan --choice wait', '--choice skip --kind plan',
    '--kind=plan --choice=skip', '--kind plan --choice "$C"', '--kind "$K" --choice skip']) {
    assert.deepStrictEqual(firmas(resto), [FIRMA], resto);
  }
  for (const resto of ['--kind plan --choice review --for-session ses-a', '--kind code --choice review']) {
    assert.deepStrictEqual(firmas(resto), [], resto);
  }
  assert.deepStrictEqual(firmas('--kind code --choice skip'), ['code-review-answer'], 'la del código tiene su firma');
  const s = SIG.SIGNATURES.find((x) => x.id === FIRMA);
  assert.ok(s, 'está en el catálogo');
  assert.deepStrictEqual([s.level, s.clickDelDueno, s.otherSession, s.kind], [2, true, 'yes', 'guion']);
  assert.match(s.terminal, /review-answer --kind plan --choice <skip o wait> --terminal --for-session <id>/);
  assert.strictEqual(SIG.delegable(FIRMA), false, 'no se delega aunque el perfil la nombre');
  assert.ok(SIG.PARA_OTRA_SESION_SIN_DELEGAR.includes(FIRMA));
  assert.ok(s.ifWrong && s.approvesEn, 'dice qué pasa si sale mal y su texto en inglés');
});

test('Freno_SinElClickDelDueno_NoDeja', (t) => {
  const lab = laboratorio(t);
  for (const args of [SKIP, WAIT]) {
    const x = lab.freno(COORD, args);
    assert.strictEqual(x.decision, 'deny', JSON.stringify(x));
    assert.match(x.texto || x.motivo || '', /sólo el click del dueño/);
    assert.match(x.texto || x.motivo || '', /firma plan-review-answer · sesión ses-a · código/, 'le da el cuadro para mostrar');
  }
  // la propia sesión, sin --for-session, tampoco
  const propia = lab.freno(DESTINO, SKIP.slice(0, 5));
  assert.strictEqual(propia.decision, 'deny', JSON.stringify(propia));
  assert.deepStrictEqual(lab.respuestas(), []);
});

test('Freno_ConElClickDeOtroPedido_NoDeja', (t) => {
  const lab = laboratorio(t);
  // el click a «esperar» no sirve para «seguir sin revisión»
  lab.click(WAIT);
  let x = lab.freno(COORD, SKIP);
  assert.strictEqual(x.decision, 'deny', JSON.stringify(x));
  // el click a este mismo pedido sobre otra versión del plan, tampoco
  lab.click(SKIP);
  lab.plan();
  x = lab.freno(COORD, SKIP);
  assert.strictEqual(x.decision, 'deny', JSON.stringify(x));
  assert.match(x.texto || x.motivo || '', /lo que se mostró cambió/);
  // ni el click a otra firma de la misma sesión (el cuadro de aprobar el plan)
  const otro = laboratorio(t);
  const cmd = otro.comando(['complete-step', 'approve-plan', '--approved', 'persona', '--for-session', DESTINO]);
  const c = OW.cuadroPara({ firma: 'plan-approval', comando: cmd, palabras: OW.canonica(cmd), destino: DESTINO, cwd: otro.repo, casa: otro.home, sesion: COORD });
  assert.ok(c && c.pregunta && !c.error, JSON.stringify(c));
  const ts = new Date(Date.now() + 500).toISOString();
  const h = require(path.join(COPIA, 'scripts', 'tests', 'lib', 'window-passed.js')).arbolDelFreno().find((p) => OW.esHerramienta(p));
  L.OA.anotar(otro.home, { tipo: 'click', sesion: COORD, ts, tool_use_id: 'toolu_otra', pregunta: c.pregunta, respuesta: c.opciones[0], herramienta: { pid: h.pid, inicio: h.inicio } });
  x = otro.freno(COORD, SKIP);
  assert.strictEqual(x.decision, 'deny', JSON.stringify(x));
});

test('Freno_ConElClickDeEsePedido_Deja', (t) => {
  // la coordinadora lo pide para ses-a y el dueño clickea en su pestaña; o la propia sesión, en la suya
  for (const [quien, args] of [[COORD, SKIP], [DESTINO, SKIP.slice(0, 5)], [COORD, WAIT]]) {
    const lab = laboratorio(t);
    lab.click(args, { pestana: quien });
    const x = lab.freno(quien, args);
    assert.deepStrictEqual([x.decision, x.via], ['allow', 'click'], `${quien} ${args.join(' ')}: ${JSON.stringify(x).slice(0, 600)}`);
  }
});

test('Coordinacion_DuenoAusente_NoMandaAnotarSkipNiWait', (t) => {
  const lab = laboratorio(t);
  const C = require(path.join(COPIA, 'scripts', 'tools', 'coordination.js'));
  const POL = require(path.join(COPIA, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'review-policy.js'));
  const original = PR.configDeLaOrganizacion;
  t.after(() => { PR.configDeLaOrganizacion = original; });
  // pasados los minutos de «dueño ausente» desde la pregunta
  const tarde = Date.now() + 3 * 3600e3;
  const lineas = (celda) => {
    PR.configDeLaOrganizacion = () => ({ values: POL.normalize({ plan_review: { routine_owner_away: celda } }).values, problems: [] });
    return C.reviewAskLines({ home: lab.home }, COORD, tarde).join('\n');
  };
  for (const celda of ['skip', 'wait']) {
    const n = lineas(celda);
    assert.match(n, new RegExp(`dueño ausente, plan_review.routine_owner_away: ${celda}`), n);
    assert.doesNotMatch(n, /review-answer/, `con «${celda}» no manda anotar nada: ${n}`);
    assert.match(n, /lo anota sólo el click del dueño, y la pregunta queda a la vista/, n);
  }
  assert.match(lineas('review'), /plan-review --for-session ses-a.*review-answer --for-session ses-a --kind plan --choice review/);
});
