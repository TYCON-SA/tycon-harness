'use strict';
/**
 * delegated-approval-person.test.js — el plan de una historia delicada lo aprueba una persona, y el click o el
 * «aprobado» del dueño a ESTE pedido gana a la firma de trámite.
 *
 * Dos reglas: el plan delicado no sale por la delegación, ni como trámite, ni por «hecho y avisado», aunque el perfil
 * liste `plan-approval:delicada` (lib/plan-review.js `antesDeAprobar`); y si la persona aprobó este pedido, la firma es
 * suya y queda con su vía, también donde el perfil la volvería trámite (scripts/lib/owner-window.js `decidir`). La
 * aprobación de otro pedido no gana nada. El laboratorio, con un perfil que lista la forma: lib/approval-lab.js.
 */
const { laboratorio, aprobadoPorTramite, salida, DEL_CASO, POR_LA_REVISION, PLAN, COORD, DESTINO, PR } = require('./lib/approval-lab.js');
const test = require('node:test');
const assert = require('node:assert');

test('PlanDelicado_PerfilQueLoVuelveTramite_NoSeApruebaSinPersona', (t) => {
  const lab = laboratorio(t, { delicada: true });
  // el comando del caso y el mismo con la cita de la maqueta: ninguno aprueba sin persona
  for (const args of [DEL_CASO, POR_LA_REVISION]) {
    const x = lab.pedir(args);
    assert.ok(!(x.freno.decision === 'allow' && x.freno.via === 'automatica'), `no sale como firma de trámite: ${salida(x)}`);
    if (x.r) assert.notStrictEqual(x.r.status, 0, salida(x));
    if (args === POR_LA_REVISION) assert.match(salida(x), /plan delicado \(nivel 2\)/, salida(x));
    const m = lab.leer();
    assert.strictEqual(m.planApproval, undefined, `el plan delicado no quedó aprobado: ${salida(x)}`);
    assert.strictEqual(m.mockupApproval, undefined, 'la maqueta no quedó aprobada');
    assert.strictEqual(lab.aprobaciones(), '', 'nada en el registro de aprobaciones');
  }
  // con el «aprobado» del dueño a este pedido, sí: queda a su nombre
  const conPersona = ['complete-step', 'approve-plan', '--approved', 'aprobado por el dueño', '--mockup-approved', 'el dueño vio la maqueta', '--for-session', DESTINO];
  lab.aprobado(`${lab.pregunta(conPersona)}\n\n${PLAN}`);
  const x = lab.pedir(conPersona);
  assert.deepStrictEqual([x.freno.decision, x.freno.via], ['allow', 'mensaje'], salida(x));
  assert.strictEqual(x.r.status, 0, salida(x));
  const pa = lab.leer().planApproval;
  assert.deepStrictEqual([pa.mode, pa.via], ['user', 'mensaje'], JSON.stringify(pa));
});

test('PlanDelicado_ElPerfilQueLoDelega_NoLoApruebaSinPersona', (t) => {
  const lab = laboratorio(t, { delicada: true });
  const marker = lab.leer();
  // la coordinadora para otra sesión, y la propia sesión: con la revisión aprobada y el perfil que lista la forma
  for (const firmante of [COORD, DESTINO]) {
    const a = PR.antesDeAprobar({ estado: lab.estado, firmante, destino: DESTINO, marker, home: lab.home });
    assert.strictEqual(a.codigo, 2, `${firmante}: ${JSON.stringify(a)}`);
    assert.match(a.motivo, /plan delicado \(nivel 2\)/, firmante);
  }
});

test('AprobadoDelDueno_GanaALaFirmaDeTramite', (t) => {
  const lab = laboratorio(t);
  aprobadoPorTramite(lab);
  const maqueta = (cita) => ['approve-mockup', '--approved', cita, '--for-session', DESTINO];
  // un «aprobado» a otro pedido (el sello de su pregunta es de otro comando) no gana nada: sale como trámite
  lab.aprobado(lab.pregunta(maqueta('persona: otra cita')));
  let x = lab.pedir(maqueta('persona: el dueño aprobó la maqueta'));
  assert.deepStrictEqual([x.freno.decision, x.freno.via], ['allow', 'automatica'], salida(x));
  // el de este pedido gana a la firma de trámite, y la maqueta queda con la vía de la persona
  lab.aprobado(lab.pregunta(maqueta('persona: de nuevo, con su aprobado')));
  x = lab.pedir(maqueta('persona: de nuevo, con su aprobado'));
  assert.deepStrictEqual([x.freno.decision, x.freno.via], ['allow', 'mensaje'], salida(x));
  assert.strictEqual(x.r.status, 0, salida(x));
  assert.strictEqual(lab.leer().mockupApproval.via, 'mensaje', JSON.stringify(lab.leer().mockupApproval));
});
