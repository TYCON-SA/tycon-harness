'use strict';
/**
 * designate-by-click.test.js — la coordinadora se nombra y se retira con un click del dueño (marker.js designate-relay
 * sin frase y withdraw-relay; firmas `designation-set` y `designation-withdraw`).
 *
 * El arnés no lee la frase: el freno da un cuadro con «Sí» y «No», el id de la sesión y su carpeta, y con el click el
 * guion anota la designación y su confirmación en un solo paso. Lo que tiene que pasar y, sobre todo, lo que no: sin
 * click no se anota nada, un click vencido, usado o de otra pregunta no vale, y nadie la nombra por otra sesión. Donde el
 * click no se puede comprobar, el guion dice por qué y da los dos respaldos. Sin red.
 *
 * El guion corre de verdad con la firma reemplazada (`exigir`, como en delegated-signing-confirm.test.js); el freno, en
 * proceso con el árbol de procesos armado (owner-window.js `decidir`).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const LIB = path.join(RAIZ, 'scripts', 'lib');
const PIPELINE_LIB = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib');
const MARKER = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const ow = require(path.join(LIB, 'owner-window.js'));
const oa = require(path.join(LIB, 'owner-approvals.js'));
const cw = require(path.join(PIPELINE_LIB, 'critical-waivers.js'));
const ds = require(path.join(LIB, 'delegated-signing.js'));
const { arbolDelFreno } = require('./lib/window-passed.js');

const SES = '11111111-2222-3333-4444-555555555555';
const OTRA = '66666666-7777-8888-9999-000000000000';
const AHORA = Date.parse('2026-11-04T13:00:00Z');

// Se carga antes del guion: la firma la devuelve la prueba, y deja dicho con qué la pidió. El rol de la coordinadora
// sale sólo del perfil del árbol del arnés (una variable no lo cambia, a propósito): lo da la prueba.
// El rol de ordenar (`rolDeCoordinar`) corre de verdad, sobre el árbol del arnés de la prueba.
const PRECARGA = `
const fs = require('fs');
const cw = require(process.env.TEST_CW_LIB);
cw.sesionQueReenvia = () => (process.env.TEST_RELAY ? { valor: process.env.TEST_RELAY } : { valor: null, aviso: 'sin perfil en la prueba' });
const rolDeVerdad = cw.rolDeCoordinar;
cw.rolDeCoordinar = (o = {}) => rolDeVerdad({ ...o, arnes: process.env.TEST_HARNESS });
require(process.env.TEST_WINDOW_LIB).exigir = (o) => {
  fs.writeFileSync(process.env.TEST_CALL_FILE, JSON.stringify({ firma: o.firma, propia: o.propia, argv: o.argv }));
  // el perfil del árbol que cambia mientras el cuadro espera el click ('' = se borra)
  if (process.env.TEST_PROFILE_DURING_WAIT !== undefined) {
    const f = require('path').join(process.env.TEST_HARNESS, 'team-profile.json');
    if (process.env.TEST_PROFILE_DURING_WAIT) fs.writeFileSync(f, process.env.TEST_PROFILE_DURING_WAIT); else fs.rmSync(f, { force: true });
  }
  if (o.antes) { const n = o.antes('click', null); if (n && n.codigo) return { codigo: n.codigo, motivo: n.motivo }; }
  // lo que pasa en la máquina mientras la firma espera (otra sesión que queda nombrada)
  if (process.env.TEST_DURING_WAIT) fs.appendFileSync(process.env.TEST_GATES, process.env.TEST_DURING_WAIT);
  return JSON.parse(process.env.TEST_SIGNATURE);
};
`;

function laboratorio(t, { perfil = { approvals: { relay_session: 'coordinadora' } } } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'designa-click-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const casa = path.join(base, 'casa');
  const carpeta = path.join(base, 'proyecto');
  const estado = path.join(casa, '.claude', '.tycon-pipeline');
  fs.mkdirSync(estado, { recursive: true });
  fs.mkdirSync(carpeta, { recursive: true });
  const precarga = path.join(base, 'precarga.js');
  fs.writeFileSync(precarga, PRECARGA);
  const llamada = path.join(base, 'llamada.json');
  // el árbol del arnés de la prueba: el perfil, si lo hay, vive ahí (de ahí sale approvals.relay_session)
  const arnes = path.join(base, 'arnes');
  fs.mkdirSync(arnes);
  let perfilRuta = null;
  if (perfil) { perfilRuta = path.join(arnes, 'team-profile.json'); fs.writeFileSync(perfilRuta, JSON.stringify(perfil)); }
  const rol = perfil && perfil.approvals ? perfil.approvals.relay_session || '' : '';
  const lab = { base, casa, carpeta, estado, llamada };
  lab.correr = (args, { firma = { codigo: 0, via: 'click' }, sesion = SES, durante = [], perfilDurante } = {}) => {
    try { fs.rmSync(llamada); } catch (_) { /* no había */ }
    const env = { PATH: process.env.PATH, HOME: casa, USERPROFILE: casa, TYCON_LANE_LLM: '0', TYCON_PROFILE: perfilRuta || '0',
      ...(perfilDurante !== undefined ? { TEST_PROFILE_DURING_WAIT: perfilDurante } : {}),
      ...(durante.length ? { TEST_DURING_WAIT: durante.map((l) => `${JSON.stringify(l)}\n`).join(''), TEST_GATES: path.join(estado, 'gates.log') } : {}),
      TEST_CALL_FILE: llamada, TEST_SIGNATURE: JSON.stringify(firma), TEST_WINDOW_LIB: path.join(LIB, 'owner-window.js'),
      TEST_CW_LIB: path.join(PIPELINE_LIB, 'critical-waivers.js'), TEST_RELAY: rol, TEST_HARNESS: arnes, ...(sesion ? { CLAUDE_CODE_SESSION_ID: sesion } : {}) };
    return spawnSync(process.execPath, ['-r', precarga, MARKER, ...args], { cwd: carpeta, env, encoding: 'utf8' });
  };
  lab.pidio = () => { try { return JSON.parse(fs.readFileSync(llamada, 'utf8')); } catch (_) { return null; } };
  lab.gates = () => { try { return fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };
  lab.vigente = () => cw.designacionVigente({ dir: estado });
  lab.designarPorFrase = (sesion, ts = '2026-11-04T10:00:00.000Z') => fs.appendFileSync(path.join(estado, 'gates.log'),
    `${JSON.stringify({ name: 'relay-designation', status: 'ok', ts, sesion, rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' })}\n`);
  return lab;
}
const designaciones = (lab) => lab.gates().filter((g) => g.name === 'relay-designation' || g.name === 'relay-designation-confirmed');

/** El freno de verdad sobre un comando de esta sesión, con el árbol de procesos de la prueba. */
function frenar(lab, comando, { sesion = SES } = {}) {
  return ow.decidir({ evento: { session_id: sesion, tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'default', tool_input: { command: comando }, cwd: lab.carpeta },
    escapes: [], arbol: arbolDelFreno(), pid: 201, casa: lab.casa, ahora: AHORA, delegacion: () => ({ ok: false, motivo: 'sin delegación en la prueba' }), clasificar: () => null, comprobar: () => null });
}
const cuadroDe = (lab, firma, comando, sesion = SES) => ow.cuadroPara({ firma, comando, palabras: ow.canonica(comando), destino: sesion, sesion, cwd: lab.carpeta, casa: lab.casa });

// 🔴 Falla con: un nombramiento sin frase que no pide el click, o un cuadro que no dice qué sesión es.
test('DesignateRelay_NoQuote_NoClick_DeniesWithBoxNamingSession (T1)', (t) => {
  const lab = laboratorio(t);
  const r = frenar(lab, `node ${MARKER} designate-relay`);
  assert.strictEqual(r.decision, 'deny', r.texto);
  assert.deepStrictEqual(r.firmas, ['designation-set']);
  assert.ok(r.cuadro && r.cuadro.soloClick, JSON.stringify(r.cuadro));
  // la carpeta va en su propia línea: una ruta larga (las de la CI) no corta la que dice qué pasa
  // la sesión por sus 8 letras y la carpeta por su nombre; lo entero, en el detalle
  assert.ok(r.cuadro.pregunta.includes(`La sesión ${SES.slice(0, 8)} pasa a ser la «coordinadora» de esta máquina · Su carpeta: ${path.basename(lab.carpeta)}.`), r.cuadro.pregunta);
  assert.ok(r.cuadro.detalle.some((l) => l.includes(SES) && l.includes('pasa a ser')), JSON.stringify(r.cuadro.detalle));
  assert.match(r.texto, /Un mensaje escrito no vale, ni un click en otra pestaña/);
  assert.deepStrictEqual(lab.gates(), [], 'nada anotado');
});

// 🔴 Falla con: el cuadro de nombrar sin sus dos descripciones, o con la vía de la ventana.
test('DesignateRelay_Box_HasSoloClickDescriptions (T2)', (t) => {
  const lab = laboratorio(t);
  for (const [firma, cmd] of [['designation-set', `node ${MARKER} designate-relay`], ['designation-withdraw', `node ${MARKER} withdraw-relay`]]) {
    const c = cuadroDe(lab, firma, cmd);
    assert.strictEqual(c.soloClick, true, firma);
    assert.strictEqual(c.descripciones.length, 2, firma);
    assert.ok(c.descripciones.every((d) => d.length > 10), firma);
  }
});

// 🔴 Falla con: un click que nombra sin dejar la confirmación, o que la deja en otro orden.
test('DesignateRelay_Click_WritesDesignationAndConfirmation (T3)', (t) => {
  const lab = laboratorio(t);
  const r = lab.correr(['designate-relay']);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(lab.pidio().firma, 'designation-set');
  assert.deepStrictEqual(designaciones(lab).map((g) => g.name), ['relay-designation', 'relay-designation-confirmed']);
  assert.match(r.stderr, /es la «coordinadora» de esta máquina/);
  assert.match(r.stderr, /guides[\\/]coordination\.md/);
});

// 🔴 Falla con: la designación por click con una cita inventada, o la confirmación atada por la frase.
test('DesignateRelay_Click_DesignationHasVia_NoCita_ConfirmationByTs (T4)', (t) => {
  const lab = laboratorio(t);
  assert.strictEqual(lab.correr(['designate-relay']).status, 0);
  const [d, c] = designaciones(lab);
  assert.strictEqual(d.status, 'ok');
  assert.strictEqual(d.sesion, SES);
  assert.strictEqual(d.rol, 'coordinadora');
  assert.strictEqual(d.via, 'click');
  assert.ok(!('cita' in d), JSON.stringify(d));
  assert.strictEqual(c.designacion_ts, d.ts);
  assert.strictEqual(c.cita_sha, null);
  assert.strictEqual(c.sesion, SES);
});

// 🔴 Falla con: un «No», o la falta de click, que igual nombra.
test('DesignateRelay_NoClickOrNo_WritesNothing_Exit1 (T9)', (t) => {
  const lab = laboratorio(t);
  for (const motivo of ['no hay un click en el cuadro de esta pestaña de los últimos 30 minutos sin usar', 'la persona eligió «No»']) {
    const r = lab.correr(['designate-relay'], { firma: { codigo: 1, motivo } });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(motivo), r.stderr);
    assert.deepStrictEqual(designaciones(lab), []);
  }
});

// 🔴 Falla con: una designación nueva que no reemplaza a la anterior.
test('DesignateRelay_NewSession_ReplacesPrevious (T10)', (t) => {
  const lab = laboratorio(t);
  lab.designarPorFrase(OTRA);
  assert.strictEqual(lab.vigente().sesion, OTRA);
  assert.strictEqual(lab.correr(['designate-relay']).status, 0);
  assert.strictEqual(lab.vigente().sesion, SES);
});

// 🔴 Falla con: `--quote` vacío que pide un click que el guion no usa, o que nombra sin frase.
test('DesignateRelay_EmptyQuote_NoBox_FailsAsToday (T11)', (t) => {
  const lab = laboratorio(t);
  for (const args of [['designate-relay', '--approved-by', 'el dev', '--quote', ''], ['designate-relay', '--approved-by', 'el dev', '--quote']]) {
    const cmd = `node ${MARKER} ${args.map((a) => `'${a}'`).join(' ')}`;
    assert.deepStrictEqual([...ow.firmasDelComando(cmd)], [], cmd);
    const r = lab.correr(args);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /falta la frase del dev/);
    assert.strictEqual(lab.pidio(), null, 'no pidió la firma');
    assert.deepStrictEqual(designaciones(lab), []);
  }
});

// 🔴 Falla con: una retirada que no deja renglón, o que deja vigente a la coordinadora.
test('UndesignateRelay_Click_WritesWithdrawn_VigenteIsNull (T12)', (t) => {
  const lab = laboratorio(t);
  assert.strictEqual(lab.correr(['designate-relay']).status, 0);
  const r = lab.correr(['withdraw-relay']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(lab.pidio().firma, 'designation-withdraw');
  const ult = designaciones(lab).pop();
  assert.deepStrictEqual([ult.name, ult.status, ult.sesion, ult.via], ['relay-designation', 'retirada', SES, 'click']);
  assert.strictEqual(lab.vigente(), null);
  // /coordinate la muestra sin coordinadora
  const co = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'tools', 'coordination.js')], { env: { PATH: process.env.PATH, HOME: lab.casa, USERPROFILE: lab.casa, TYCON_PROFILE: path.join(lab.base, 'team-profile.json'), CLAUDE_CODE_SESSION_ID: SES }, encoding: 'utf8' });
  assert.doesNotMatch(`${co.stdout}${co.stderr}`, new RegExp(`coordinadora[^.\\n]*${SES}`));
});

// 🔴 Falla con: una retirada que, por esperar su firma, le borra en silencio el rol a la sesión nombrada mientras tanto.
test('UndesignateRelay_OtherDesignatedWhileWaiting_DoesNotWithdrawIt', (t) => {
  const lab = laboratorio(t);
  assert.strictEqual(lab.correr(['designate-relay']).status, 0);
  const otra = { name: 'relay-designation', status: 'ok', ts: '2026-11-05T09:00:00.000Z', sesion: OTRA, rol: 'coordinadora', quien: 'la persona', via: 'click' };
  // nombrada con su click, que deja también su confirmación: una línea sin confirmar no desplaza a la confirmada (8.314)
  const r = lab.correr(['withdraw-relay'], { durante: [otra, ds.confirmationRecord({ ...otra, cita: null }, otra.ts, { via: 'click' })] });
  assert.strictEqual(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no se retiró a la coordinadora — esta sesión no es la coordinadora \(la vigente es 66666666/);
  assert.ok(!designaciones(lab).some((g) => g.status === 'retirada'), 'no se anotó la retirada');
  assert.strictEqual(lab.vigente().sesion, OTRA);
  // y una retirada de otra sesión no anula la designación que vino después
  const estado = path.join(lab.estado, 'gates.log');
  fs.appendFileSync(estado, `${JSON.stringify({ name: 'relay-designation', status: 'retirada', ts: '2026-11-05T09:01:00.000Z', sesion: SES, rol: 'coordinadora', via: 'click' })}\n`);
  assert.strictEqual(lab.vigente().sesion, OTRA);
  fs.appendFileSync(estado, `${JSON.stringify({ name: 'relay-designation', status: 'retirada', ts: '2026-11-05T09:02:00.000Z', sesion: OTRA, rol: 'coordinadora', via: 'click' })}\n`);
  assert.strictEqual(lab.vigente(), null);
});

// 🔴 Falla con: retirar desde una sesión que no es la coordinadora, gastando el click.
test('UndesignateRelay_NotTheCoordinator_PrecheckDenies_NoBox (T13)', (t) => {
  const lab = laboratorio(t);
  lab.designarPorFrase(OTRA);
  const c = ow.comprobarConElGuion({ firma: 'designation-withdraw', palabras: ow.canonica(`node ${MARKER} withdraw-relay`), cwd: lab.carpeta, sesion: SES, casa: lab.casa });
  assert.ok(c && c.niega, JSON.stringify(c));
  assert.match(c.niega, new RegExp(`esta sesión no es la coordinadora \\(la vigente es ${OTRA}\\)`));
  assert.strictEqual(designaciones(lab).length, 1, 'nada anotado');
});

// 🔴 Falla con: retirar en una máquina sin coordinadora.
test('UndesignateRelay_NoCoordinator_PrecheckDenies_NoBox (T14)', (t) => {
  const lab = laboratorio(t);
  const c = ow.comprobarConElGuion({ firma: 'designation-withdraw', palabras: ow.canonica(`node ${MARKER} withdraw-relay`), cwd: lab.carpeta, sesion: SES, casa: lab.casa });
  assert.ok(c && c.niega, JSON.stringify(c));
  assert.match(c.niega, /no hay coordinadora en esta máquina/);
  assert.deepStrictEqual(lab.gates(), []);
});

// 🔴 Falla con: la terminal del dueño que no retira.
test('UndesignateRelay_Terminal_Withdraws (T15)', (t) => {
  const lab = laboratorio(t);
  assert.strictEqual(lab.correr(['designate-relay']).status, 0);
  const r = lab.correr(['withdraw-relay', '--terminal'], { firma: { codigo: 0, via: 'terminal' } });
  assert.strictEqual(r.status, 0, r.stderr);
  const ult = designaciones(lab).pop();
  assert.deepStrictEqual([ult.status, ult.via], ['retirada', 'terminal']);
  assert.strictEqual(lab.vigente(), null);
});

// 🔴 Falla con: un click que no se pudo comprobar y el guion que sólo dice «no».
test('DesignateRelay_ClickUnverifiable_SaysWhyAndBothFallbacks (T16)', (t) => {
  const lab = laboratorio(t);
  const motivo = 'la consola que lanzó el guion no tiene la forma medida';
  const r = lab.correr(['designate-relay'], { firma: { codigo: 1, motivo } });
  assert.strictEqual(r.status, 1);
  const e = r.stderr;
  const orden = ['no pude comprobar el click', motivo, 'designate-relay --terminal', "designate-relay --approved-by '<el dev>' --quote '<su frase>'", 'confirm-designation --terminal'];
  const pos = orden.map((p) => { const i = e.indexOf(p); assert.ok(i >= 0, `falta «${p}»:\n${e}`); return i; });
  assert.deepStrictEqual(pos, [...pos].sort((a, b) => a - b), e);
  assert.deepStrictEqual(designaciones(lab), []);
});

// 🔴 Falla con: una sesión sin id que llega a la firma.
test('DesignateRelay_NoSessionId_PrecheckDeniesWithFallbacks (T17)', (t) => {
  const lab = laboratorio(t);
  const r = lab.correr(['designate-relay'], { sesion: null });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /la sesión no dice su identificador/);
  assert.match(r.stderr, /designate-relay --terminal/);
  assert.match(r.stderr, /--quote '<su frase>'/);
  assert.deepStrictEqual(designaciones(lab), []);
});

// 🔴 Falla con: la terminal del dueño que nombra sin la confirmación, o con otra vía.
test('DesignateRelay_Terminal_WritesBothWithViaTerminal (T18)', (t) => {
  const lab = laboratorio(t);
  const r = lab.correr(['designate-relay', '--terminal'], { firma: { codigo: 0, via: 'terminal' } });
  assert.strictEqual(r.status, 0, r.stderr);
  const [d, c] = designaciones(lab);
  assert.strictEqual(d.via, 'terminal');
  assert.strictEqual(c.via, 'terminal');
  assert.strictEqual(c.designacion_ts, d.ts);
});

/** Un click anotado en la pestaña `sesion` para el cuadro `cuadro`, hace `min` minutos. */
function click(lab, cuadro, { sesion = SES, min = 1, tipo = 'click' } = {}) {
  oa.anotar(lab.casa, { tipo, sesion, ts: new Date(AHORA - min * 60000).toISOString(), tool_use_id: 'toolu_9', pregunta: cuadro.pregunta, respuesta: cuadro.opciones[0], texto: 'aprobado' });
}
const buscar = (lab, cuadro, o = {}) => oa.buscar({ casa: lab.casa, sesion: SES, destino: SES, cuadro, ahora: AHORA, validar: () => ({ ok: true }), ...o });

// 🔴 Falla con: un click viejo que todavía nombra.
test('DesignationSet_ClickOlderThan30Min_DoesNotCount (T22)', (t) => {
  const lab = laboratorio(t);
  const c = cuadroDe(lab, 'designation-set', `node ${MARKER} designate-relay`);
  click(lab, c, { min: 31 });
  assert.strictEqual(buscar(lab, c).ok, false);
  click(lab, c, { min: 29 });
  assert.strictEqual(buscar(lab, c).ok, true, 'el de hace 29 minutos sí');
});

// 🔴 Falla con: el mismo click que nombra dos veces.
test('DesignationSet_ClickAlreadyUsed_DoesNotCountTwice (T23)', (t) => {
  const lab = laboratorio(t);
  const c = cuadroDe(lab, 'designation-set', `node ${MARKER} designate-relay`);
  click(lab, c);
  const a = buscar(lab, c);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(oa.consumir(lab.casa, a.aprobacion, { ahora: AHORA, firma: 'designation-set', sesion: SES }).ok, true);
  assert.strictEqual(buscar(lab, c).ok, false);
});

// 🔴 Falla con: el click de nombrar que sirve para retirar, o al revés, o el de otra firma.
test('DesignationFirmas_ClickOfOtherQuestion_DoesNotCount (T24)', (t) => {
  const lab = laboratorio(t);
  const set = cuadroDe(lab, 'designation-set', `node ${MARKER} designate-relay`);
  const retiro = cuadroDe(lab, 'designation-withdraw', `node ${MARKER} withdraw-relay`);
  const plan = cuadroDe(lab, 'plan-approval', `node ${MARKER} complete-step approve-plan --approved "dale"`);
  for (const [dado, pedido] of [[set, retiro], [retiro, set], [plan, set]]) {
    assert.notStrictEqual(dado.pregunta, pedido.pregunta);
    assert.notStrictEqual(dado.sello, pedido.sello);
    // la conversación con el click dado al cuadro de otra pregunta: no contesta éste
    const ts = '2026-11-04T12:59:00.000Z';
    const ruta = path.join(lab.base, `t-${Math.random()}.jsonl`);
    fs.writeFileSync(ruta, [
      { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: { questions: [{ question: dado.pregunta }] } }] } },
      { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
        toolUseResult: { questions: [{ question: dado.pregunta, options: dado.opciones.map((label) => ({ label })) }], answers: { [dado.pregunta]: dado.opciones[0] } },
        permissionDecision: { decision: 'accept', source: 'user_temporary' } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const v = oa.clickEnLaTranscripcion(ruta, { tipo: 'click', sesion: SES, ts, tool_use_id: 'toolu_1', pregunta: dado.pregunta, respuesta: dado.opciones[0] },
      { pregunta: pedido.pregunta, opciones: pedido.opciones, descripciones: pedido.descripciones });
    assert.strictEqual(v.ok, false, JSON.stringify(v));
  }
});

// 🔴 Falla con: la coordinadora que nombra o retira a otra sesión.
test('DesignationFirmas_ForOtherSession_Denied (T26)', (t) => {
  const lab = laboratorio(t);
  for (const sub of ['designate-relay', 'withdraw-relay']) {
    const r = lab.correr([sub, '--for-session', OTRA]);
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /se corre desde la sesión que se nombra/);
    assert.strictEqual(lab.pidio(), null, `${sub}: no pidió la firma`);
  }
  assert.deepStrictEqual(designaciones(lab), []);
});

// 🔴 Falla con: sin approvals.relay_session, un click que no nombra, que anota la confirmación (la firma por delegación),
// que nombra sin el click de la persona, o un comando que no dice en una línea que la sesión ordena y que las firmas
// siguen yendo a la persona. Y con otra coordinadora confirmada en pie, una designación que no la puede reemplazar.
test('DesignateRelay_NoProfile_DesignatesWithoutConfirmation (T27)', (t) => {
  const lab = laboratorio(t, { perfil: null });
  const r = lab.correr(['designate-relay']);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(lab.pidio().firma, 'designation-set', 'nombrar sigue pidiendo el click de la persona');
  const filas = designaciones(lab);
  assert.deepStrictEqual(filas.map((g) => g.name), ['relay-designation'], 'designación sí, confirmación no');
  const [d] = filas;
  assert.deepStrictEqual({ sesion: d.sesion, rol: d.rol, via: d.via, cita: d.cita }, { sesion: SES, rol: cw.ROL_DE_FABRICA, via: 'click', cita: undefined });
  assert.strictEqual(lab.vigente().sesion, SES, 'ordena la máquina');
  assert.strictEqual(cw.designacionConfirmada({ dir: lab.estado }), null, 'sin confirmación no firma por nadie');
  const linea = r.stderr.split('\n').filter((l) => l.includes(SES) && /ordena/.test(l));
  assert.strictEqual(linea.length, 1, r.stderr);
  assert.match(linea[0], /firmas siguen yendo a la (ventana de la )?persona/);
  assert.doesNotMatch(r.stderr, /dueño/);
  // con otra confirmada en pie, la designación sin perfil no se podría confirmar: se niega antes del cuadro, sin anotar
  const enPie = laboratorio(t, { perfil: null });
  otraConfirmada(enPie);
  const antes = designaciones(enPie).length;
  const n = enPie.correr(['designate-relay']);
  assert.strictEqual(n.status, 1, `${n.stdout}${n.stderr}`);
  assert.strictEqual(enPie.pidio(), null, 'no pidió la firma');
  assert.match(n.stderr, /withdraw-relay/);
  assert.strictEqual(designaciones(enPie).length, antes, 'no escribió');
  assert.strictEqual(enPie.vigente().sesion, OTRA);
  // el perfil se va mientras el cuadro espera: no se confirma con el rol que ya no está, ni se nombra
  const sale = laboratorio(t);
  const s = sale.correr(['designate-relay'], { perfilDurante: '' });
  assert.strictEqual(s.status, 1, `${s.stdout}${s.stderr}`);
  assert.match(s.stderr, /el perfil del equipo cambió mientras se esperaba la firma/);
  assert.deepStrictEqual(designaciones(sale), []);
});

// La retirada atada por la misma función que la confirmación (también en delegated-signing-confirm.test.js, T6 y T8).
test('DesignateRelay_Click_IsConfirmedForDelegation', (t) => {
  const lab = laboratorio(t);
  assert.strictEqual(lab.correr(['designate-relay']).status, 0);
  const p = { state: lab.estado, gates: path.join(lab.estado, 'gates.log') };
  // firmar por el dueño pide el rol en el perfil del árbol del arnés: lo da la prueba, como al guion la precarga
  const leer = cw.sesionQueReenvia;
  cw.sesionQueReenvia = () => ({ valor: 'coordinadora' });
  t.after(() => { cw.sesionQueReenvia = leer; });
  assert.strictEqual(ds.confirmedDesignation(p).ok, true);
  assert.strictEqual(oa.coordinadoraConfirmada(lab.casa), SES);
});

// --- historia 8.314: designar y retirar con una designación confirmada en pie -----------------------------------------

/** Otra sesión nombrada con su click, con su confirmación. */
function otraConfirmada(lab) {
  const d = { name: 'relay-designation', status: 'ok', ts: '2026-11-04T09:00:00.000Z', sesion: OTRA, rol: 'coordinadora', quien: 'la persona', via: 'click' };
  fs.appendFileSync(path.join(lab.estado, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(ds.confirmationRecord({ ...d, cita: null }, d.ts, { via: 'click' }))}\n`);
  return d;
}
// el texto de hoy de la firma de retirar, en el catálogo
const APRUEBA_RETIRAR = require(path.join(LIB, 'signatures.js')).SIGNATURES.find((s) => s.id === 'designation-withdraw').approves;
const FRASE = ['designate-relay', '--approved-by', 'el dueño', '--quote', 'Esta sesión es la coordinadora'];

test('T16 Designar_PorClickYPorFrase_SeComprueban @story-8.314 @ac-9 @ac-13 @ac-19', (t) => {
  // por click, con otra confirmada vigente: el click la reemplaza
  const click = laboratorio(t);
  otraConfirmada(click);
  const c = click.correr(['designate-relay']);
  assert.strictEqual(c.status, 0, `${c.stdout}${c.stderr}`);
  assert.strictEqual(click.vigente().sesion, SES);
  assert.strictEqual(click.vigente().pendiente, undefined);
  // por frase, con rol en el perfil: queda pendiente hasta que el dueño la confirme
  const frase = laboratorio(t);
  otraConfirmada(frase);
  const f = frase.correr(FRASE);
  assert.strictEqual(f.status, 0, `${f.stdout}${f.stderr}`);
  assert.strictEqual(frase.vigente().sesion, OTRA);
  assert.strictEqual(frase.vigente().pendiente.sesion, SES);
  assert.match(f.stderr, /pendiente/);
  // por frase, sin rol en el perfil: no se puede confirmar, así que no se escribe
  const sinRol = laboratorio(t, { perfil: null });
  otraConfirmada(sinRol);
  const antes = designaciones(sinRol).length;
  const s = sinRol.correr(FRASE);
  assert.strictEqual(s.status, 1, `${s.stdout}${s.stderr}`);
  assert.match(s.stderr, /retir/);
  assert.strictEqual(designaciones(sinRol).length, antes, 'no escribió');
});

/** El archivo de sesión de Claude Code, con el proceso que la corre. */
const sesionViva = (lab, sid, pid = process.pid) => {
  const dir = path.join(lab.casa, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid.slice(0, 8)}.json`), JSON.stringify({ sessionId: sid, pid, cwd: lab.carpeta, name: sid.slice(0, 8) }));
};

test('T24 Retirar_SesionMuerta_ConFirmaDelDueno @story-8.314 @ac-13', (t) => {
  const retiradas = (lab) => designaciones(lab).filter((g) => g.status === 'retirada');
  const RETIRAR = ['withdraw-relay', '--session', OTRA];
  // la vigente ya no vive (no deja archivo) y la que pide sí: se retira con la firma, y anota quién la pidió
  const lab = laboratorio(t, { perfil: null });
  otraConfirmada(lab);
  sesionViva(lab, SES);
  assert.strictEqual(lab.correr(FRASE).status, 1, 'con la vigente en pie no se designa por frase');
  const r = lab.correr(RETIRAR);
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.strictEqual(lab.pidio().firma, 'designation-withdraw');
  const [ret] = retiradas(lab);
  assert.deepStrictEqual({ sesion: ret.sesion, pedida_por: ret.pedida_por }, { sesion: OTRA, pedida_por: SES });
  assert.strictEqual(lab.vigente(), null);
  assert.strictEqual(lab.correr(FRASE).status, 0, 'designate-relay vuelve a andar');
  // la sesión vive, un archivo de sesión ilegible, la carpeta de sesiones vacía, sin firma: no se retira
  const casos = [
    ['viva', (l) => { sesionViva(l, SES); sesionViva(l, OTRA); }, undefined],
    ['ilegible', (l) => { sesionViva(l, SES); fs.writeFileSync(path.join(l.casa, '.claude', 'sessions', 'rota.json'), '{'); }, undefined],
    ['vacía', (l) => { fs.mkdirSync(path.join(l.casa, '.claude', 'sessions'), { recursive: true }); }, undefined],
    ['sin firma', (l) => { sesionViva(l, SES); }, { codigo: 1, motivo: 'la persona dijo que no' }],
  ];
  for (const [caso, armar, firma] of casos) {
    const l = laboratorio(t, { perfil: null });
    otraConfirmada(l);
    armar(l);
    const n = l.correr(RETIRAR, firma ? { firma } : {});
    assert.strictEqual(n.status, 1, `${caso}: ${n.stdout}${n.stderr}`);
    assert.deepStrictEqual(retiradas(l), [], `${caso}: sin renglón`);
    assert.strictEqual(l.vigente().sesion, OTRA, caso);
  }
  // lo que ve el dueño nombra a la sesión que se retira: el cuadro, el aviso de firma a distancia y la lista
  const comando = `node ${MARKER} withdraw-relay --session ${OTRA}`;
  const cuadro = cuadroDe(lab, 'designation-withdraw', comando);
  assert.ok(cuadro.pregunta.includes(OTRA.slice(0, 8)) && /deja de ser/.test(cuadro.pregunta), cuadro.pregunta);
  assert.ok(!cuadro.pregunta.includes('Su carpeta'), cuadro.pregunta);
  const palabras = ow.canonica(comando);
  assert.strictEqual(ow.retiraA(palabras, SES), OTRA);
  assert.strictEqual(ow.retiraA(ow.canonica(`node ${MARKER} withdraw-relay --session ${SES}`), SES), null, 'la propia sesión es una retirada de siempre');
  assert.strictEqual(ow.retiraA(ow.canonica(`node ${MARKER} withdraw-relay`), SES), null);
  const aviso = (que) => { let texto = null; ow.avisarFirmaADistancia({ firma: 'designation-withdraw', via: 'click', sesion: SES, destino: SES, ahora: AHORA, que, notificar: (x) => { texto = x; } }); return texto; };
  const conOtra = aviso(`la sesión ${OTRA}, que ya no vive, deja de ser la «coordinadora» de esta máquina (la pide la sesión ${SES})`);
  assert.ok(conOtra.includes(OTRA) && /deja de ser/.test(conOtra), conOtra);
  assert.ok(aviso(null).includes(APRUEBA_RETIRAR), 'sin otra sesión, el texto de hoy');
  assert.match(ow.tituloDeLaFirma('designation-withdraw', palabras, SES), /otra sesión/);
  // la forma pegada (hallazgo del pase): el comando la niega y el cuadro no nombra a la otra sesión
  const pegada = laboratorio(t, { perfil: null });
  otraConfirmada(pegada);
  sesionViva(pegada, SES);
  const p = pegada.correr(['withdraw-relay', `--session=${OTRA}`]);
  assert.strictEqual(p.status, 1, `${p.stdout}${p.stderr}`);
  assert.match(p.stderr, /--session <id>/);
  assert.deepStrictEqual(retiradas(pegada), []);
  const cuadroPegado = cuadroDe(pegada, 'designation-withdraw', `node ${MARKER} withdraw-relay --session=${OTRA}`);
  assert.ok(!cuadroPegado.pregunta.includes(OTRA.slice(0, 8)), cuadroPegado.pregunta);
  assert.strictEqual(ow.tituloDeLaFirma('designation-withdraw', ow.canonica(`node ${MARKER} withdraw-relay`), SES), APRUEBA_RETIRAR);
});
