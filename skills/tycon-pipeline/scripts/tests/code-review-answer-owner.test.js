'use strict';
/**
 * code-review-answer-owner.test.js — «seguir sin el pase adversarial» y «esperar» a la pregunta de revisar el código los
 * decide el dueño; «review», no.
 *
 *   ReviewAnswerCodigo_SkipOWaitSinElDueno_NoSeAnota — sin el click del dueño ni su terminal (sin vía, la delegación, la
 *     ventana, un «aprobado» escrito, la firma de trámite), `anotarRespuesta` no escribe nada y la pregunta sigue a la vista
 *   ReviewAnswerCodigo_Review_SeAnotaSinFirma — «review» al código, como siempre
 *   ReviewAnswerCodigo_ConLaViaDelDueno_SeAnotaYCuenta — con el click: el renglón lleva la vía y es la respuesta del portón
 *   ReviewAnswerCodigo_RenglonSinElDueno_NoCuenta — un renglón de antes, sin la vía, no cierra la pregunta ni es la
 *     respuesta que lee el portón del pase
 *   Freno_SkipOWaitDelCodigo_PidenCodeReviewAnswer — el freno le ve la firma `code-review-answer` a `skip` y `wait` del
 *     código; a `review`, ninguna. En el catálogo: nivel 2, sólo el click del dueño, la pide la coordinadora para otra
 *     sesión y no se delega
 *   Freno_CodigoSinElClickDelDueno_NoDeja — el freno da el cuadro «¿Seguir sin el pase adversarial sobre este cambio?»
 *   Freno_CodigoConElClickDeOtroPedido_NoDeja — el click a «esperar», al cuadro de otro diff o al de la pregunta del plan no
 *     sirve para este «skip»
 *   Freno_CodigoConElClickDeEsePedido_Deja — el click a este mismo pedido, en la pestaña que corre el comando
 *   Coordinacion_DuenoAusente_NoMandaAnotarSkipNiWaitDelCodigo — con el dueño ausente y la celda en `skip` o `wait`, la
 *     coordinadora no recibe la orden de anotarlo; con `run`, la de anotar «review»
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

const { laboratorio, salida, SKIP, SKIP_CODIGO, WAIT_CODIGO, REVIEW_CODIGO, COORD, DESTINO, FIRMA_CODIGO, PR, OW, COPIA } = L;
const SIG = require(path.join(COPIA, 'scripts', 'lib', 'signatures.js'));
const huella = (lab) => PR.huellaDe({ estado: lab.estado, sesion: DESTINO, kind: 'code' }).huella;
const anotar = (lab, o) => PR.anotarRespuesta({ estado: lab.estado, sesion: DESTINO, kind: 'code', quien: `coordinadora ${COORD}`, huella: huella(lab), ...o });
const deCodigo = (lab) => lab.abiertas().filter((p) => p.endsWith('/code'));
const respuesta = (lab) => PR.respuestaDe({ estado: lab.estado, sesion: DESTINO, kind: 'code', huella: huella(lab) });

test('ReviewAnswerCodigo_SkipOWaitSinElDueno_NoSeAnota', (t) => {
  const lab = laboratorio(t);
  lab.preguntarCodigo();
  for (const choice of ['skip', 'wait']) {
    for (const via of [null, 'delegacion', 'ventana', 'mensaje', 'automatica', 'avisado']) {
      const r = anotar(lab, { choice, via });
      assert.strictEqual(r.codigo, 2, `${choice} por ${via}`);
      assert.match(r.motivo, /lo anota sólo una persona, con su click en el cuadro de la firma code-review-answer o en su terminal/);
    }
  }
  assert.deepStrictEqual(lab.respuestas(), [], 'no se escribió nada');
  assert.deepStrictEqual(deCodigo(lab), [`${DESTINO}/code`], 'la pregunta sigue a la vista');
  assert.strictEqual(respuesta(lab), null, 'el portón del pase no tiene respuesta');
});

test('ReviewAnswerCodigo_Review_SeAnotaSinFirma', (t) => {
  const lab = laboratorio(t);
  lab.preguntarCodigo();
  assert.strictEqual(anotar(lab, { choice: 'review' }).codigo, 0);
  assert.deepStrictEqual(lab.respuestas().map((j) => [j.kind, j.choice, j.via || null]), [['code', 'review', null]]);
  assert.deepStrictEqual(deCodigo(lab), []);
  assert.strictEqual(respuesta(lab), 'review');
});

test('ReviewAnswerCodigo_ConLaViaDelDueno_SeAnotaYCuenta', (t) => {
  const otro = laboratorio(t);
  otro.preguntarCodigo();
  assert.strictEqual(anotar(otro, { choice: 'skip', via: 'click' }).codigo, 0);
  assert.deepStrictEqual(otro.respuestas().map((j) => [j.choice, j.via]), [['skip', 'click']]);
  assert.strictEqual(respuesta(otro), 'skip');
});

test('ReviewAnswerCodigo_RenglonSinElDueno_NoCuenta', (t) => {
  const lab = laboratorio(t);
  lab.preguntarCodigo();
  const h = huella(lab);
  for (const choice of ['skip', 'wait']) {
    fs.appendFileSync(path.join(lab.estado, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), name: 'review-answer', status: 'ok', sesion: DESTINO, kind: 'code', choice, quien: `sesión ${DESTINO}`, huella: h, motivo: null })}\n`);
    assert.deepStrictEqual(deCodigo(lab), [`${DESTINO}/code`], `«${choice}» sin el dueño no saca la pregunta de la vista`);
    assert.strictEqual(respuesta(lab), null, `«${choice}» sin el dueño no es la respuesta del portón`);
  }
});

test('Freno_SkipOWaitDelCodigo_PidenCodeReviewAnswer', () => {
  const M = '/x/skills/tycon-pipeline/scripts/marker.js';
  const firmas = (resto) => OW.firmasDelComando(`node ${M} review-answer ${resto}`);
  for (const resto of ['--kind code --choice skip', '--kind code --choice wait --for-session ses-a', '--choice skip --kind code', '--kind=code --choice=wait', '--kind code --choice "$C"']) {
    assert.deepStrictEqual(firmas(resto), [FIRMA_CODIGO], resto);
  }
  assert.deepStrictEqual(firmas('--kind code --choice review'), [], 'review al código, sin firma');
  assert.deepStrictEqual(firmas('--kind plan --choice skip'), ['plan-review-answer'], 'la del plan sigue con la suya');
  const s = SIG.SIGNATURES.find((x) => x.id === FIRMA_CODIGO);
  assert.ok(s, 'está en el catálogo');
  assert.deepStrictEqual([s.level, s.clickDelDueno, s.otherSession, s.kind], [2, true, 'yes', 'guion']);
  assert.match(s.terminal, /review-answer --kind code --choice <skip o wait> --terminal --for-session <id>/);
  assert.strictEqual(SIG.delegable(FIRMA_CODIGO), false, 'no se delega aunque el perfil la nombre');
  assert.ok(SIG.PARA_OTRA_SESION_SIN_DELEGAR.includes(FIRMA_CODIGO));
  assert.ok(s.ifWrong && s.approvesEn, 'dice qué pasa si sale mal y su texto en inglés');
});

test('Freno_CodigoSinElClickDelDueno_NoDeja', (t) => {
  const lab = laboratorio(t);
  lab.preguntarCodigo();
  for (const args of [SKIP_CODIGO, WAIT_CODIGO]) {
    const x = lab.freno(COORD, args);
    assert.strictEqual(x.decision, 'deny', JSON.stringify(x));
    assert.match(x.texto || x.motivo || '', /sólo el click del dueño/);
    assert.match(x.texto || x.motivo || '', /firma code-review-answer · sesión ses-a · código/, 'le da el cuadro para mostrar');
  }
  assert.match(lab.cuadro(SKIP_CODIGO).pregunta, /^¿Seguir sin el pase adversarial sobre este cambio\?/);
  const propia = lab.freno(DESTINO, SKIP_CODIGO.slice(0, 5));
  assert.strictEqual(propia.decision, 'deny', JSON.stringify(propia));
  assert.deepStrictEqual(lab.respuestas(), []);
});

test('Freno_CodigoConElClickDeOtroPedido_NoDeja', (t) => {
  const lab = laboratorio(t);
  lab.preguntarCodigo();
  // el click a «esperar» no sirve para «seguir sin el pase»
  lab.click(WAIT_CODIGO);
  let x = lab.freno(COORD, SKIP_CODIGO);
  assert.strictEqual(x.decision, 'deny', JSON.stringify(x));
  // el click a este mismo pedido sobre otro diff, tampoco
  lab.click(SKIP_CODIGO);
  lab.cambio();
  x = lab.freno(COORD, SKIP_CODIGO);
  assert.strictEqual(x.decision, 'deny', JSON.stringify(x));
  assert.match(x.texto || x.motivo || '', /lo que se mostró cambió/);
  // ni el click a «seguir sin revisión» del plan
  const otro = laboratorio(t);
  otro.preguntarCodigo();
  otro.click(SKIP);
  x = otro.freno(COORD, SKIP_CODIGO);
  assert.strictEqual(x.decision, 'deny', JSON.stringify(x));
});

test('Freno_CodigoConElClickDeEsePedido_Deja', (t) => {
  for (const [quien, args] of [[COORD, SKIP_CODIGO], [DESTINO, SKIP_CODIGO.slice(0, 5)], [COORD, WAIT_CODIGO]]) {
    const lab = laboratorio(t);
    lab.preguntarCodigo();
    lab.click(args, { pestana: quien });
    const x = lab.freno(quien, args);
    assert.deepStrictEqual([x.decision, x.via], ['allow', 'click'], `${quien} ${args.join(' ')}: ${JSON.stringify(x).slice(0, 600)}`);
  }
  const lab = laboratorio(t);
  lab.preguntarCodigo();
  const x = lab.pedir(COORD, REVIEW_CODIGO);
  assert.strictEqual(x.freno.decision, 'none', salida(x));
});

test('Coordinacion_DuenoAusente_NoMandaAnotarSkipNiWaitDelCodigo', (t) => {
  const lab = laboratorio(t);
  lab.preguntarCodigo();
  const C = require(path.join(COPIA, 'scripts', 'tools', 'coordination.js'));
  const POL = require(path.join(COPIA, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'review-policy.js'));
  const original = PR.configDeLaOrganizacion;
  t.after(() => { PR.configDeLaOrganizacion = original; });
  // pasados los minutos de «dueño ausente» desde la pregunta
  const tarde = Date.now() + 3 * 3600e3;
  const linea = (celda) => {
    PR.configDeLaOrganizacion = () => ({ values: POL.normalize({ deep_review: { small_routine_owner_away: celda } }).values, problems: [] });
    return C.reviewAskLines({ home: lab.home }, COORD, tarde).filter((l) => /revisar el código/.test(l)).join('\n');
  };
  for (const celda of ['skip', 'wait']) {
    const n = linea(celda);
    assert.match(n, new RegExp(`dueño ausente, deep_review.small_routine_owner_away: ${celda}`), n);
    assert.doesNotMatch(n, /review-answer/, `con «${celda}» no manda anotar nada: ${n}`);
    assert.match(n, /lo anota sólo el click del dueño, y la pregunta queda a la vista/, n);
  }
  assert.match(linea('run'), /review-answer --for-session ses-a --kind code --choice review/);
});
