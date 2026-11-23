'use strict';
/**
 * mockup-approval-person.test.js — la maqueta queda con `mode: "user"` sólo con la vía de una persona, y
 * `--replace-delegated` reemplaza una firma hecha por delegación sólo con el click o el «aprobado» del dueño a ESE pedido.
 *
 * marker.js: la maqueta (con el plan o con `approve-mockup`) guarda la vía de su firma y su modo sale de ella; su cita no
 * es la opción que sigue (`--mockup-approved --for-session <s>` no deja «--for-session»); y `--replace-delegated`, en
 * `complete-step approve-plan` y en `approve-mockup`, vuelve a firmar a nombre de la persona lo que se aprobó sin ella,
 * guarda lo que reemplazó y no mueve la hora del paso. Sin la persona, o con la aprobación de otro pedido, no escribe
 * nada. El laboratorio, con un perfil que lista plan-approval:delicada: lib/approval-lab.js.
 */
const { laboratorio, aprobadoPorTramite, salida, pasoDelPlan, DEL_CASO, POR_LA_REVISION, PLAN, DESTINO } = require('./lib/approval-lab.js');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

test('PlanDelicado_ConElAprobadoDelDueno_LaMaquetaQuedaASuNombre', (t) => {
  const lab = laboratorio(t, { delicada: true });
  const args = ['complete-step', 'approve-plan', '--approved', 'aprobado por el dueño', '--mockup-approved', 'el dueño vio la maqueta', '--for-session', DESTINO];
  lab.aprobado(`${lab.pregunta(args)}\n\n${PLAN}`);
  const x = lab.pedir(args);
  assert.deepStrictEqual([x.freno.decision, x.freno.via], ['allow', 'mensaje'], salida(x));
  assert.strictEqual(x.r.status, 0, salida(x));
  const m = lab.leer();
  assert.deepStrictEqual([m.planApproval.mode, m.planApproval.via], ['user', 'mensaje'], JSON.stringify(m.planApproval));
  assert.deepStrictEqual([m.mockupApproval.mode, m.mockupApproval.via], ['user', 'mensaje'], JSON.stringify(m.mockupApproval));
});

test('Maqueta_SinPersona_NoQuedaComoUser', (t) => {
  const lab = laboratorio(t);
  const m = aprobadoPorTramite(lab);
  assert.notStrictEqual(m.mockupApproval.mode, 'user', JSON.stringify(m.mockupApproval));
  assert.strictEqual(m.mockupApproval.mode, 'automatica', JSON.stringify(m.mockupApproval));
  assert.strictEqual(m.mockupApproval.via, 'delegacion', 'la constancia dice la vía');
  const linea = lab.aprobaciones().trim().split('\n').map((l) => JSON.parse(l)).find((a) => a.que === 'maqueta');
  assert.strictEqual(linea.tipo, 'automatica', JSON.stringify(linea));
});

test('Maqueta_SinPersona_ApprovedByNoLaVuelveManual', (t) => {
  const lab = laboratorio(t);
  const NOMBRE = 'alguien@acme.test';
  const lineas = () => lab.aprobaciones().trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const registro = (archivo) => { try { return fs.readFileSync(path.join(lab.estado, archivo), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
  // con el plan y como trámite, con un nombre escrito en el comando; después approve-mockup, igual
  for (const args of [[...POR_LA_REVISION, '--approved-by', NOMBRE],
    ['approve-mockup', '--approved', 'vi la maqueta', '--approved-by', NOMBRE, '--for-session', DESTINO]]) {
    const x = lab.pedir(args);
    assert.deepStrictEqual([x.freno.decision, x.freno.via], ['allow', 'automatica'], salida(x));
    assert.strictEqual(x.r.status, 0, salida(x));
    assert.strictEqual(lab.leer().mockupApproval.mode, 'automatica', args[0]);
    const maquetas = lineas().filter((a) => a.que === 'maqueta');
    assert.ok(maquetas.length, args[0]);
    for (const a of maquetas) {
      assert.strictEqual(a.tipo, 'automatica', `${args[0]}: el registro de aprobaciones dice persona sin persona: ${JSON.stringify(a)}`);
      assert.strictEqual(a.quien, 'arnés (firma de trámite)', `${args[0]}: firmó el arnés, no el nombre escrito: ${JSON.stringify(a)}`);
    }
  }
  // ni el registro de las aprobaciones de gates.log ni el registro común de firmas dicen persona
  assert.ok(!registro('gates.log').some((g) => g.name === 'approval' && (g.tipo === 'manual' || g.quien === NOMBRE)), JSON.stringify(registro('gates.log').filter((g) => g.name === 'approval')));
  const firmas = registro('signatures.jsonl').filter((f) => f.signature === 'plan-approval');
  assert.ok(firmas.length >= 2 && firmas.every((f) => f.via === 'automatic' && f.signer === 'arnés (firma de trámite)'), JSON.stringify(firmas));
});

test('MockupApproved_SinCita_NoTomaLaOpcionSiguiente', (t) => {
  const lab = laboratorio(t);
  const x = lab.pedir(DEL_CASO);
  const m = lab.leer();
  assert.ok(!m.mockupApproval || m.mockupApproval.text !== '--for-session', `la cita no es la opción siguiente: ${JSON.stringify(m.mockupApproval)}`);
  assert.strictEqual(m.mockupApproval, undefined, salida(x));
  assert.strictEqual(m.planApproval, undefined, 'sin cita de la maqueta no se cierra el plan');
  assert.match(salida(x), /--mockup-approved/, 'dice qué falta');
});

test('ReemplazaDelegada_SinAprobacion_NoEscribeNada', (t) => {
  const lab = laboratorio(t);
  aprobadoPorTramite(lab);
  const antes = lab.foto();
  for (const args of [
    ['approve-mockup', '--replace-delegated', '--approved', 'persona: el dueño aprobó la maqueta', '--for-session', DESTINO],
    ['complete-step', 'approve-plan', '--replace-delegated', '--approved', 'revisión', '--mockup-approved', 'el dueño vio la maqueta', '--for-session', DESTINO],
    ['complete-step', 'approve-plan', '--replace-delegated', '--approved', 'aprobado por el dueño', '--mockup-approved', 'el dueño vio la maqueta', '--for-session', DESTINO],
  ]) {
    const x = lab.pedir(args);
    if (x.r) assert.notStrictEqual(x.r.status, 0, `${args[0]}: ${salida(x)}`);
    assert.strictEqual(lab.foto(), antes, `${args.join(' ')}: no escribió nada\n${salida(x)}`);
  }
});

test('ReemplazaDelegada_AprobadoDeOtroPedido_NoSirve', (t) => {
  const lab = laboratorio(t);
  aprobadoPorTramite(lab);
  const antes = lab.foto();
  // el dueño aprobó otra cita: el sello de la pregunta es de otro comando
  const otro = ['approve-mockup', '--replace-delegated', '--approved', 'persona: otra cita', '--for-session', DESTINO];
  lab.aprobado(lab.pregunta(otro));
  const x = lab.pedir(['approve-mockup', '--replace-delegated', '--approved', 'persona: el dueño aprobó la maqueta', '--for-session', DESTINO]);
  assert.notStrictEqual(x.freno.via, 'mensaje', salida(x));
  if (x.r) assert.notStrictEqual(x.r.status, 0, salida(x));
  assert.strictEqual(lab.foto(), antes, `no escribió nada\n${salida(x)}`);
});

test('ReemplazaDelegada_ConElAprobadoDeEsePedido_DejaLaViaDeLaPersona', (t) => {
  const lab = laboratorio(t);
  const previa = aprobadoPorTramite(lab);
  // la maqueta: el «aprobado» a este pedido gana a la firma de trámite
  const maqueta = ['approve-mockup', '--replace-delegated', '--approved', 'persona: el dueño aprobó la maqueta', '--for-session', DESTINO];
  lab.aprobado(lab.pregunta(maqueta));
  let x = lab.pedir(maqueta);
  assert.deepStrictEqual([x.freno.decision, x.freno.via], ['allow', 'mensaje'], salida(x));
  assert.strictEqual(x.r.status, 0, salida(x));
  let m = lab.leer();
  assert.deepStrictEqual([m.mockupApproval.mode, m.mockupApproval.via], ['user', 'mensaje'], JSON.stringify(m.mockupApproval));
  assert.strictEqual(m.mockupApproval.reemplaza.via, 'delegacion', 'guarda la firma que reemplazó');
  assert.strictEqual(m.planApproval.via, 'delegacion', 'la maqueta no toca el plan');
  // el plan: lo mismo, sin mover la hora del paso
  const plan = ['complete-step', 'approve-plan', '--replace-delegated', '--approved', 'aprobado por el dueño', '--mockup-approved', 'el dueño vio la maqueta', '--for-session', DESTINO];
  lab.aprobado(`${lab.pregunta(plan)}\n\n${PLAN}`);
  x = lab.pedir(plan);
  assert.deepStrictEqual([x.freno.decision, x.freno.via], ['allow', 'mensaje'], salida(x));
  assert.strictEqual(x.r.status, 0, salida(x));
  m = lab.leer();
  assert.deepStrictEqual([m.planApproval.mode, m.planApproval.via, m.planApproval.text], ['user', 'mensaje', 'aprobado por el dueño'], JSON.stringify(m.planApproval));
  assert.strictEqual(m.planApproval.reemplaza.via, 'delegacion', JSON.stringify(m.planApproval));
  assert.deepStrictEqual([m.mockupApproval.mode, m.mockupApproval.via], ['user', 'mensaje'], JSON.stringify(m.mockupApproval));
  assert.strictEqual(pasoDelPlan(m).completedAt, pasoDelPlan(previa).completedAt, 'el paso conserva su hora');
  const manuales = lab.aprobaciones().trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a.tipo === 'manual').map((a) => a.que);
  assert.deepStrictEqual(manuales.sort(), ['maqueta', 'maqueta', 'plan'], lab.aprobaciones());
  // ya es de una persona: no hay firma por delegación que reemplazar
  const otra = lab.pedir(['approve-mockup', '--replace-delegated', '--approved', 'persona: de nuevo', '--for-session', DESTINO]);
  if (otra.r) assert.notStrictEqual(otra.r.status, 0, salida(otra));
});

// ── el cuadro para --replace-delegated en la pestaña que trabaja, sin una aprobación previa ──
const { harnessCopy } = require('../../../../scripts/tests/lib/harness-copy.js');
const { conVentana, arbolDelFreno, arbolDelGuion } = require('../../../../scripts/tests/lib/window-passed.js');
const OW = require(path.join(harnessCopy(), 'scripts', 'lib', 'owner-window.js'));
const OA = require(path.join(harnessCopy(), 'scripts', 'lib', 'owner-approvals.js'));

// el guion del comando: la palabra que sigue a `node`
const args0 = (cmd) => cmd.split(' ')[1];

/** El click del dueño en el cuadro de `cmd`, en la pestaña de ses-a: la transcripción con el cuadro contestado y el renglón del gancho. */
function clickDelDueno(lab, cmd, ahora) {
  const c = OW.cuadroPara({ firma: 'plan-approval', comando: cmd, palabras: OW.canonica(cmd), destino: DESTINO, cwd: lab.repo, casa: lab.home, sesion: DESTINO });
  assert.ok(c && c.pregunta && !c.error, JSON.stringify(c));
  const ts = new Date(ahora).toISOString();
  const id = `toolu_click_${ahora}`;
  const opciones = c.opciones.map((label, i) => ({ label, ...(Array.isArray(c.descripciones) ? { description: c.descripciones[i] } : {}) }));
  const dir = path.join(lab.home, '.claude', 'projects', '-r-proyecto');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${DESTINO}.jsonl`), `${[
    { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: c.pregunta, options: opciones }] } }] } },
    { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      toolUseResult: { questions: [{ question: c.pregunta, options: opciones }], answers: { [c.pregunta]: c.opciones[0] } },
      permissionDecision: { decision: 'accept', source: 'user_temporary' } },
  ].map((r) => JSON.stringify(r)).join('\n')}\n`);
  const h = arbolDelFreno().find((x) => OW.esHerramienta(x));
  OA.anotar(lab.home, { tipo: 'click', sesion: DESTINO, ts, tool_use_id: id, pregunta: c.pregunta, respuesta: c.opciones[0], herramienta: { pid: h.pid, inicio: h.inicio } });
}

/** La pestaña de ses-a, sin delegación: el freno como su gancho (`pedir`) y el guion de verdad si lo deja (`correr`). */
function pestanaDeLaSesion(lab, args) {
  const cmd = lab.comando(args);
  // stable-data: la hora sólo ordena los pedidos de esta prueba después de los del laboratorio; ninguna fecha fija
  let ahora = Date.now() + 600000;
  return {
    cmd,
    hora: () => ahora,
    pedir: () => {
      ahora += 5000;
      return OW.decidir({ evento: { session_id: DESTINO, tool_use_id: `toolu_r${ahora}`, hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'default', cwd: lab.repo, tool_input: { command: cmd } },
        escapes: [], arbol: arbolDelFreno(), pid: 201, casa: lab.home, ahora, clasificar: () => null, delegacion: () => ({ ok: false, motivo: 'sin delegación en esta pestaña' }), huellaDeLaMaquina: () => ({ huella: 'a1b2c3d4e5f60718' }) });
    },
    correr: () => spawnSync(process.execPath, [args0(cmd), ...args], { cwd: lab.repo, encoding: 'utf8',
      env: conVentana({ ...lab.env, CLAUDE_CODE_SESSION_ID: DESTINO }, { arbol: { arbol: arbolDelGuion(lab.home, cmd), pid: 301, ahora: ahora + 60000 } }) }),
  };
}
const REEMPLAZO = ['approve-mockup', '--replace-delegated', '--approved', 'persona: el dueño aprobó la maqueta'];

test('ReemplazaDelegada_SinAprobacionPrevia_ElSiDelDuenoEnLaVentanaAlcanza', (t) => {
  const lab = laboratorio(t);
  aprobadoPorTramite(lab);
  const antes = lab.foto();
  // sin persona (la coordinadora, por la delegación o como trámite), la corrida real no escribe nada
  const sinPersona = lab.pedir([...REEMPLAZO, '--for-session', DESTINO]);
  if (sinPersona.r) assert.notStrictEqual(sinPersona.r.status, 0, salida(sinPersona));
  assert.strictEqual(lab.foto(), antes, `sin persona no se escribió nada\n${salida(sinPersona)}`);
  // (a) en la pestaña de la sesión, sin una aprobación previa, el freno le pregunta a la persona: no la niega antes
  const p = pestanaDeLaSesion(lab, REEMPLAZO);
  const a = p.pedir();
  assert.strictEqual(a.decision, 'ask', `${a.decision}: ${a.texto}`);
  // (b) con su «sí» en la ventana de este comando, escribe a su nombre, con la vía de la ventana
  const r = p.correr();
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = lab.leer();
  assert.deepStrictEqual([m.mockupApproval.mode, m.mockupApproval.via], ['user', 'ventana'], JSON.stringify(m.mockupApproval));
  assert.strictEqual(m.mockupApproval.reemplaza.via, 'delegacion', JSON.stringify(m.mockupApproval));
});

test('ReemplazaDelegada_SinAprobacionPrevia_ConElClickDeEsePedido', (t) => {
  const lab = laboratorio(t);
  aprobadoPorTramite(lab);
  const p = pestanaDeLaSesion(lab, REEMPLAZO);
  // el click del dueño en el cuadro de este pedido gana a la firma de trámite, y escribe con la vía del click
  clickDelDueno(lab, p.cmd, p.hora() + 1000);
  const b = p.pedir();
  assert.deepStrictEqual([b.decision, b.via], ['allow', 'click'], b.texto);
  const r = p.correr();
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const m = lab.leer();
  assert.deepStrictEqual([m.mockupApproval.mode, m.mockupApproval.via], ['user', 'click'], JSON.stringify(m.mockupApproval));
  assert.strictEqual(m.mockupApproval.reemplaza.via, 'delegacion', JSON.stringify(m.mockupApproval));
});
