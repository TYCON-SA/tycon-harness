'use strict';

/**
 * delegated-approve.test.js — firmar un cambio de control por delegación (`run-base-controls.sh approve --relayed-by`).
 *
 * La sesión designada firma en nombre del dueño sólo con todas las llaves: el perfil del equipo prende `control-change`
 * y elige esta máquina por su huella, la designación de la sesión está confirmada en la terminal del dueño, la máquina
 * mostró el cambio, el dueño escribió la frase en esa conversación después de la muestra, y el freno de seguridad dejó
 * una ficha para ese mismo comando. Si falta cualquiera, no se firma nada y el motivo lo dice.
 *
 * La casa de la cuenta, la conversación, la huella, el perfil y el reloj se inyectan como parámetros, en proceso: ninguna
 * variable del ambiente elige qué se lee.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.resolve(__dirname, '..');
const DS = require(path.join(SCRIPTS, 'lib', 'delegated-signing.js'));

const D = 'sesion-designada-0001';
const OTRA = 'sesion-que-implementa-0002';
const HUELLA = 'a1b2c3d4e5f60718';
const ENTRIES = [{ path: 'scripts/ci/toy-rules.json', blob: 'b'.repeat(40) }];
const HASH = crypto.createHash('sha256').update(ENTRIES.map((e) => `${e.path}\t${e.blob}\n`).sort().join('')).digest('hex');
const CITA_DESIGNACION = 'Esta sesión es la coordinadora';
const PERFIL = { approvals: { relay_session: 'coordinadora', delegated_signing: ['control-change'], delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] } };
const T0 = Date.parse('2026-10-25T12:00:00.000Z');
const iso = (ms) => new Date(T0 + ms).toISOString();

/** Una casa de cuenta de prueba con la designación (confirmada o no) y la conversación de D. */
function casa({ confirmada = true, turnos = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-'));
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(estado, { recursive: true });
  const designacion = { name: 'relay-designation', status: 'ok', ts: iso(-3600e3), sesion: D, rol: 'coordinadora', quien: 'dueño', cita: CITA_DESIGNACION };
  const lineas = [designacion];
  if (confirmada) lineas.push(DS.confirmationRecord(designacion, iso(-3500e3)));
  fs.writeFileSync(path.join(estado, 'gates.log'), lineas.map((l) => JSON.stringify(l)).join('\n') + '\n');
  conversacion(home, turnos);
  return { home, estado };
}
/** La conversación de D: cada turno `{ texto, cuando, persona }` (los de la persona sin marca de origen). */
function conversacion(home, turnos) {
  const dir = path.join(home, '.claude', 'projects', 'proyecto');
  fs.mkdirSync(dir, { recursive: true });
  const regs = turnos.map((t, i) => ({
    type: t.persona === false ? 'assistant' : 'user', uuid: `u${i}`, parentUuid: i ? `u${i - 1}` : null, timestamp: t.cuando,
    message: { role: t.persona === false ? 'assistant' : 'user', content: t.texto },
  }));
  fs.writeFileSync(path.join(dir, `${D}.jsonl`), regs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const leerGates = (estado) => fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const ARGS = ['--root', '/repo', '--out', '.tycon/control-changes/', '--entries', JSON.stringify(ENTRIES), '--relayed-by', 'coordinadora', '--quote', `Firmá el cambio de control ${HASH.slice(0, 12)}, lo leí`];

/** Lo que pide la firma, con todas las llaves; cada caso de T51 rompe una. */
function pedido(c, extra = {}) {
  return {
    home: c.home, args: ARGS, hash: HASH, entries: ENTRIES,
    profile: () => ({ doc: PERFIL }), fingerprint: () => ({ huella: HUELLA }), now: () => new Date(T0 + 30e3),
    ...extra,
  };
}
/** Todo listo: la muestra anotada, la frase del dueño después y la ficha del freno para D. */
function listo(opts = {}) {
  const c = casa({ turnos: [{ texto: ARGS[9], cuando: iso(10e3) }], ...opts });
  DS.recordShown({ home: c.home, hash: HASH, files: ENTRIES.map((e) => e.path), now: () => new Date(T0) });
  const t = DS.issueToken({ home: c.home, session: D, args: ARGS, now: () => new Date(T0 + 20e3) });
  assert.strictEqual(t.ok, true, t.reason);
  return c;
}

// T49 BaseControls_Pending_AnotaLaMuestraYLosDosComandos @story-8.116 @ac-51
// 🔴 Falla con: `pending` que no anota la muestra en la casa de la cuenta, o que no da el comando de la delegación.
test('8.116 T49 BaseControls_Pending_AnotaLaMuestraYLosDosComandos', () => {
  const c = casa();
  const r = DS.recordShown({ home: c.home, hash: HASH, now: () => new Date(T0) });
  assert.strictEqual(r.ok, true, r.reason);
  const shown = leerGates(c.estado).filter((l) => l.name === 'control-change-shown');
  assert.strictEqual(shown.length, 1);
  assert.strictEqual(shown[0].hash, HASH);
  assert.strictEqual(shown[0].ts, iso(0));
  // dónde vale la muestra: sólo donde el perfil delega la firma en esta máquina
  assert.strictEqual(DS.machineDelegates({ home: c.home, profile: () => ({ doc: PERFIL }), fingerprint: () => ({ huella: HUELLA }) }).ok, true);
  assert.strictEqual(DS.machineDelegates({ home: c.home, profile: () => ({ doc: PERFIL }), fingerprint: () => ({ huella: 'ffffffffffffffff' }) }).ok, false);
  const terminal = `bash scripts/ci/run-base-controls.sh approve --root '/repo' --out '.tycon/control-changes/' --entries '${JSON.stringify(ENTRIES)}'`;
  const delegado = DS.delegatedCommand(terminal, 'coordinadora');
  assert.ok(delegado.startsWith(`${terminal} --relayed-by coordinadora --quote `), delegado);
  assert.match(delegado, /frase del dueño/);
});

// T50 BaseControls_ApproveDelegado_FirmaConLasTresLlaves @story-8.116 @ac-52
// 🔴 Falla con: una firma con las llaves que no escribe el renglón antes que la línea, o una línea sin sus campos.
test('8.116 T50 BaseControls_ApproveDelegado_FirmaConLasTresLlaves', () => {
  const c = listo();
  const r = DS.checkDelegatedApprove(pedido(c));
  assert.strictEqual(r.ok, true, r.reason);
  assert.deepStrictEqual(Object.keys(r.fields).sort(), ['delegated_by', 'maquina', 'quote', 'quote_at', 'signed_by_session', 'via']);
  assert.strictEqual(r.fields.via, 'delegacion');
  assert.strictEqual(r.fields.delegated_by, 'dueño');
  assert.strictEqual(r.fields.signed_by_session, D);
  assert.strictEqual(r.fields.maquina, HUELLA);
  assert.strictEqual(r.fields.quote, ARGS[9]);
  assert.strictEqual(r.fields.quote_at, iso(10e3));
  // el renglón primero, la línea después
  const orden = [];
  const w = DS.writeDelegatedApproval({
    home: c.home, hash: HASH, entries: ENTRIES, fields: r.fields, now: () => new Date(T0 + 31e3),
    appendGates: (obj) => orden.push(['gates', obj]), writeApproval: (line) => orden.push(['linea', JSON.parse(line)]),
  });
  assert.strictEqual(w.ok, true, w.reason);
  assert.deepStrictEqual(orden.map((o) => o[0]), ['gates', 'linea']);
  assert.strictEqual(orden[0][1].name, 'control-change-signed');
  assert.strictEqual(orden[0][1].hash, HASH);
  assert.strictEqual(orden[1][1].hash, HASH);
  assert.strictEqual(orden[1][1].via, 'delegacion');
  assert.strictEqual(orden[1][1].by, 'dueño');
  // sin poder escribir el renglón, no hay línea
  const orden2 = [];
  const w2 = DS.writeDelegatedApproval({
    home: c.home, hash: HASH, entries: ENTRIES, fields: r.fields, now: () => new Date(T0 + 31e3),
    appendGates: () => { throw new Error('EACCES'); }, writeApproval: (line) => orden2.push(line),
  });
  assert.strictEqual(w2.ok, false);
  assert.strictEqual(orden2.length, 0);
});

// T51 BaseControls_ApproveDelegado_FaltaUnaLlave @story-8.116 @ac-53
// 🔴 Falla con: una firma que sale bien con una llave de menos, una ficha vencida o una ficha usada.
test('8.116 T51 BaseControls_ApproveDelegado_FaltaUnaLlave', () => {
  const casos = [
    ['sin control-change', (c) => pedido(c, { profile: () => ({ doc: { approvals: { ...PERFIL.approvals, delegated_signing: ['critical-waiver'] } } }) }), /control-change/],
    ['máquina fuera de la lista', (c) => pedido(c, { fingerprint: () => ({ huella: 'ffffffffffffffff' }) }), /máquina/],
    ['huella ilegible', (c) => pedido(c, { fingerprint: () => ({ error: 'EACCES' }) }), /huella/],
    ['perfil roto', (c) => pedido(c, { profile: () => ({ error: 'no es JSON válido' }) }), /perfil/],
    ['frase de otro', (c) => pedido(c, { args: [...ARGS.slice(0, 9), `Otra frase que nombra ${HASH.slice(0, 12)} y nadie dijo`] }), /ficha|frase/],
    ['rol equivocado', (c) => pedido(c, { args: [...ARGS.slice(0, 7), 'vigilante', ...ARGS.slice(8)] }), /ficha|rol/],
  ];
  for (const [nombre, armar, motivo] of casos) {
    const c = listo();
    const r = DS.checkDelegatedApprove(armar(c));
    assert.strictEqual(r.ok, false, nombre);
    assert.match(r.reason, motivo, `${nombre}: ${r.reason}`);
  }
  // la frase en un turno del agente, anterior a la muestra, sin el hash, corta, o negada después
  const frases = [
    ['del agente', [{ texto: ARGS[9], cuando: iso(10e3), persona: false }], /frase/],
    ['anterior a la muestra', [{ texto: ARGS[9], cuando: iso(-10e3) }], /frase|anterior|muestra/],
    ['negada después', [{ texto: ARGS[9], cuando: iso(10e3) }, { texto: `No firmes ${HASH.slice(0, 12)}, me echo atrás`, cuando: iso(15e3) }], /echó atrás|niega/],
  ];
  for (const [nombre, turnos, motivo] of frases) {
    const c = listo();
    conversacion(c.home, turnos);
    const r = DS.checkDelegatedApprove(pedido(c));
    assert.strictEqual(r.ok, false, nombre);
    assert.match(r.reason, motivo, `${nombre}: ${r.reason}`);
  }
  const sinHash = ['--root', '/repo', '--out', '.tycon/control-changes/', '--entries', JSON.stringify(ENTRIES), '--relayed-by', 'coordinadora', '--quote', 'Firmá el cambio de control que te mandé, lo leí entero'];
  {
    const c = casa({ turnos: [{ texto: sinHash[9], cuando: iso(10e3) }] });
    DS.recordShown({ home: c.home, hash: HASH, files: ENTRIES.map((e) => e.path), now: () => new Date(T0) });
    DS.issueToken({ home: c.home, session: D, args: sinHash, now: () => new Date(T0 + 20e3) });
    const r = DS.checkDelegatedApprove(pedido(c, { args: sinHash }));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /hash|archivo/);
  }
  // sin la muestra
  {
    const c = casa({ turnos: [{ texto: ARGS[9], cuando: iso(10e3) }] });
    DS.issueToken({ home: c.home, session: D, args: ARGS, now: () => new Date(T0 + 20e3) });
    const r = DS.checkDelegatedApprove(pedido(c));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /muestra|pending/);
  }
  // la designación sin confirmar en la terminal: ni ficha ni firma
  {
    const c = casa({ confirmada: false, turnos: [{ texto: ARGS[9], cuando: iso(10e3) }] });
    DS.recordShown({ home: c.home, hash: HASH, now: () => new Date(T0) });
    const t = DS.issueToken({ home: c.home, session: D, args: ARGS, now: () => new Date(T0 + 20e3) });
    assert.strictEqual(t.ok, false);
    assert.match(t.reason, /terminal|confirm/);
    const r = DS.checkDelegatedApprove(pedido(c));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /terminal|confirm/);
  }
  // la conversación de D que no se puede leer
  {
    const c = listo();
    const archivo = path.join(c.home, '.claude', 'projects', 'proyecto', `${D}.jsonl`);
    fs.rmSync(archivo);
    fs.mkdirSync(archivo);
    const r = DS.checkDelegatedApprove(pedido(c));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /conversación|frase/);
  }
  // una designación nueva deja sin valor la confirmación de la anterior
  {
    const c = listo();
    fs.appendFileSync(path.join(c.estado, 'gates.log'), JSON.stringify({ name: 'relay-designation', status: 'ok', ts: iso(5e3), sesion: D, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora, de nuevo' }) + '\n');
    const r = DS.checkDelegatedApprove(pedido(c));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /terminal|confirm/);
  }
  // sin ficha
  {
    const c = casa({ turnos: [{ texto: ARGS[9], cuando: iso(10e3) }] });
    DS.recordShown({ home: c.home, hash: HASH, files: ENTRIES.map((e) => e.path), now: () => new Date(T0) });
    const r = DS.checkDelegatedApprove(pedido(c));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /ficha/);
  }
  // la ficha vencida: más de 60 s
  {
    const c = listo();
    const r = DS.checkDelegatedApprove(pedido(c, { now: () => new Date(T0 + 20e3 + 61e3) }));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /ficha.*(vieja|venc)/);
  }
  // la misma ficha no sirve dos veces
  {
    const c = listo();
    assert.strictEqual(DS.checkDelegatedApprove(pedido(c)).ok, true);
    const r = DS.checkDelegatedApprove(pedido(c));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /ficha.*(usó|usada)/);
  }
  // la ficha de otro comando
  {
    const c = listo();
    const otro = [...ARGS.slice(0, 5), JSON.stringify([{ path: 'otro.json', blob: 'c'.repeat(40) }]), ...ARGS.slice(6)];
    const r = DS.checkDelegatedApprove(pedido(c, { args: otro }));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /ficha/);
  }
  // la ficha de otra sesión
  {
    const c = casa({ turnos: [{ texto: ARGS[9], cuando: iso(10e3) }] });
    DS.recordShown({ home: c.home, hash: HASH, files: ENTRIES.map((e) => e.path), now: () => new Date(T0) });
    fs.mkdirSync(path.join(c.estado, 'signing-tokens'), { recursive: true });
    fs.writeFileSync(path.join(c.estado, 'signing-tokens', 'forjada.json'), JSON.stringify({ session: OTRA, digest: DS.digestOf(ARGS), at: iso(20e3) }));
    const r = DS.checkDelegatedApprove(pedido(c));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /ficha/);
  }
});

// T51 (el juez de la frase) @story-8.116 @ac-53
// 🔴 Falla con: un «NO firmes» del dueño que, recortado, vale como ok; una pregunta en el medio del mensaje que vale como
// ok; o una vuelta atrás posterior que no tumba la firma porque no repite el hash.
test('8.116 T51 BaseControls_ApproveDelegado_JuezDeLaFrase', () => {
  const h = HASH.slice(0, 12);
  const conCita = (quote) => [...ARGS.slice(0, 9), quote];
  const casos = [
    ['«NO firmes» recortado', [{ texto: `NO firmes el cambio ${h} todavía`, cuando: iso(10e3) }], `firmes el cambio ${h} todavía`, /niega/],
    ['«Nunca firmes» recortado', [{ texto: `Nunca firmes el cambio de control ${h}, no lo leí`, cuando: iso(10e3) }], `firmes el cambio de control ${h}`, /niega/],
    ['pregunta en el medio', [{ texto: `firmás el cambio ${h}? decime antes`, cuando: iso(10e3) }], `firmás el cambio ${h}`, /pregunta/],
    ['pregunta con ¿ en el medio', [{ texto: `Mirá, ¿firmo el cambio ${h} o esperamos`, cuando: iso(10e3) }], `firmo el cambio ${h}`, /pregunta/],
    ['sin un sí', [{ texto: `el cambio ${h} lo miro a la noche`, cuando: iso(10e3) }], `el cambio ${h} lo miro`, /no dice que sí/],
    ['un «si» que pone una condición', [{ texto: `si pasan las pruebas, el cambio ${h} va`, cuando: iso(10e3) }], `el cambio ${h} va`, /no dice que sí/],
    ['una reserva con «antes»', [{ texto: `antes de firmar ${h} revisá la prueba`, cuando: iso(10e3) }], `firmar ${h} revisá la prueba`, /frena/],
    ['un freno sin tilde', [{ texto: `espera con el cambio ${h}, firmalo a la noche`, cuando: iso(10e3) }], `el cambio ${h}, firmalo a la noche`, /frena/],
    ['un freno sin «no»', [{ texto: `esperá con el cambio ${h}, firmalo cuando termine la otra`, cuando: iso(10e3) }], `el cambio ${h}, firmalo cuando termine`, /frena/],
    ['vuelta atrás sin el hash', [{ texto: ARGS[9], cuando: iso(10e3) }, { texto: 'pará, no lo firmes todavía', cuando: iso(15e3) }], ARGS[9], /echó atrás|niega/],
  ];
  for (const [nombre, turnos, quote, motivo] of casos) {
    const c = casa({ turnos });
    DS.recordShown({ home: c.home, hash: HASH, now: () => new Date(T0) });
    const t = DS.issueToken({ home: c.home, session: D, args: conCita(quote), now: () => new Date(T0 + 20e3) });
    assert.strictEqual(t.ok, true, `${nombre}: ${t.reason}`);
    const r = DS.checkDelegatedApprove(pedido(c, { args: conCita(quote) }));
    assert.strictEqual(r.ok, false, nombre);
    assert.match(r.reason, motivo, `${nombre}: ${r.reason}`);
  }
  // el ok de verdad sigue valiendo, y otro mensaje posterior que no habla de la firma no lo tumba
  const c = casa({ turnos: [{ texto: ARGS[9], cuando: iso(10e3) }, { texto: 'no, el otro pedido lo vemos mañana', cuando: iso(15e3) }] });
  DS.recordShown({ home: c.home, hash: HASH, now: () => new Date(T0) });
  DS.issueToken({ home: c.home, session: D, args: ARGS, now: () => new Date(T0 + 20e3) });
  const r = DS.checkDelegatedApprove(pedido(c));
  assert.strictEqual(r.ok, true, r.reason);
});

// T52 BaseControls_ApproveDelegado_SesionQueImplementa @story-8.116 @ac-54
// 🔴 Falla con: una ficha para una sesión que no es la designada, o una firma con trabajo propio abierto de D.
test('8.116 T52 BaseControls_ApproveDelegado_SesionQueImplementa', () => {
  // qué comando corre la firma, para el freno: lo que la corre de verdad, también detrás de un prefijo o adentro de un
  // `bash -c`; lo que sólo nombra las palabras, no
  const F = 'bash scripts/ci/run-base-controls.sh approve --relayed-by coordinadora';
  for (const c of [F, `env A=1 ${F}`, `sudo ${F}`, `A=1 ${F}`, `cd /r && ${F}`, `true | ${F}`, `x=$(${F})`, `bash -c '${F}'`, `sh -c "${F}"`, `echo \\' ; ${F}`, `eval '${F}'`, F.replace(' --relayed-by', ' \\\n--relayed-by'), `timeout 5 ${F}`, `sudo -u dev ${F}`, `env -u X ${F}`, `{ ${F}; }`, `if true; then ${F}; fi`, `xargs ${F}`, `echo '${F}' | bash`, `nice -n 5 ${F}`, `! ${F}`, F.replace('bash ', 'bash -o pipefail ')]) {
    assert.strictEqual(DS.executesApprove(c), true, `corre: ${c}`);
  }
  // stable-data: el «git commit» de abajo es un texto que se le pasa al freno, no un commit
  for (const c of ['grep -n approve scripts/ci/run-base-controls.sh --relayed-by', `echo '${F}'`, `git commit -m "${F}"`, 'cat run-base-controls.sh | grep approve --relayed-by']) {
    assert.strictEqual(DS.executesApprove(c), false, `no corre: ${c}`);
  }
  // el evento no es de D: sin ficha
  {
    const c = casa();
    const t = DS.issueToken({ home: c.home, session: OTRA, args: ARGS, now: () => new Date(T0) });
    assert.strictEqual(t.ok, false);
    assert.match(t.reason, /designada/);
    assert.ok(t.reason.includes(OTRA), `el motivo nombra la sesión del evento: ${t.reason}`);
    assert.strictEqual(fs.existsSync(path.join(c.estado, 'signing-tokens')) && fs.readdirSync(path.join(c.estado, 'signing-tokens')).length > 0, false);
  }
  // D con una ejecución abierta (aunque el marcador sea viejo), o con un ad-hoc declarado
  const trabajos = [
    ['ejecución', (estado) => { fs.mkdirSync(path.join(estado, 'active'), { recursive: true }); fs.writeFileSync(path.join(estado, 'active', `${D}.json`), JSON.stringify({ storyId: '9.99', sessionId: D, startedAt: '2026-01-01T00:00:00Z' })); }],
    ['ejecución adoptada', (estado) => { fs.mkdirSync(path.join(estado, 'active'), { recursive: true }); fs.writeFileSync(path.join(estado, 'active', 'otro-nombre.json'), JSON.stringify({ storyId: '9.99', sessionId: D })); }],
    ['ad-hoc', (estado) => { fs.mkdirSync(path.join(estado, 'adhoc'), { recursive: true }); fs.writeFileSync(path.join(estado, 'adhoc', `${D}.json`), JSON.stringify({ reason: 'un arreglo chico', maxFiles: 8, files: [], declaredAt: new Date(T0).toISOString() })); }],
    ['ad-hoc viejo', (estado) => { fs.mkdirSync(path.join(estado, 'adhoc'), { recursive: true }); fs.writeFileSync(path.join(estado, 'adhoc', `${D}.json`), JSON.stringify({ reason: 'de anteayer', declaredAt: '2026-01-01T00:00:00Z', lastTouch: '2026-01-01T00:00:00Z' })); }],
    ['marcador viejo de un solo archivo', (estado) => { fs.mkdirSync(estado, { recursive: true }); fs.writeFileSync(path.join(estado, 'active.json'), JSON.stringify({ storyId: '1.1', sessionId: D })); }],
    ['marcador viejo con la sesión más honda', (estado) => { fs.mkdirSync(estado, { recursive: true }); fs.writeFileSync(path.join(estado, 'active.json'), JSON.stringify({ corridas: { a: { pipeline: { sessionId: D } } } })); }],
    ['ad-hoc con otra forma', (estado) => { fs.mkdirSync(path.join(estado, 'adhoc'), { recursive: true }); fs.writeFileSync(path.join(estado, 'adhoc', `${D}.json`), '{"motivo": "sin reason"'); }],
  ];
  for (const [nombre, abrir] of trabajos) {
    const c = listo();
    abrir(c.estado);
    const r = DS.checkDelegatedApprove(pedido(c));
    assert.strictEqual(r.ok, false, nombre);
    assert.match(r.reason, /la sesión que implementa no firma su propio cambio de control/, nombre);
    const c2 = casa();
    abrir(c2.estado);
    const t = DS.issueToken({ home: c2.home, session: D, args: ARGS, now: () => new Date(T0) });
    assert.strictEqual(t.ok, false, nombre);
  }
  // marcadores que no se pueden leer: no se firma
  {
    const c = listo();
    fs.writeFileSync(path.join(c.estado, 'active'), 'no es una carpeta');
    const r = DS.checkDelegatedApprove(pedido(c));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /marcadores|ejecuci/);
  }
});

// T55 BaseControls_ConstanciaAMano_PorConsola @story-8.116 @ac-56
// 🔴 Falla con: una constancia puesta por consola por otro camino que el guion (copiar a la carpeta, `git mv`,
// `install`, `rsync`, un parche, reponerla de otra rama, el índice) que el freno de escritura deja pasar; o un freno
// que también para mirarla, buscarla o agregarla al commit.
test('8.116 T55 BaseControls_ConstanciaAMano_PorConsola', () => {
  const gate = require(path.join(SCRIPTS, '..', 'skills', 'tycon-pipeline', 'scripts', 'on-bash-write-gate.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'constancias-'));
  fs.writeFileSync(path.join(repo, 'firma.patch'), 'diff --git a/.github/control-changes/x.json b/.github/control-changes/x.json\n');
  fs.writeFileSync(path.join(repo, 'otro.patch'), 'diff --git a/README.md b/README.md\n');
  fs.writeFileSync(path.join(repo, 'firma.txt'), '--- a/x\n+++ b/.tycon/control-changes.jsonl\n');
  fs.writeFileSync(path.join(repo, 'octal.patch'), 'diff --git "a/.tycon/control\\055changes.jsonl" "b/.tycon/control\\055changes.jsonl"\n');
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'forjado', '.tycon', 'control-changes'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'forjado', '.tycon', 'control-changes', 'x.json'), '{}');
  fs.mkdirSync(path.join(repo, 'limpio', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'limpio', 'docs', 'a.md'), 'a');
  fs.mkdirSync(path.join(repo, '.github', 'control-changes'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'forjado'), path.join(repo, 'enlace'));
  const correr = (command) => gate.handle({ tool_name: 'Bash', tool_input: { command }, cwd: repo, session_id: 'prueba' }, { stateDir: path.join(repo, 'estado'), installedRoots: [] });
  const frenan = [
    'cp /tmp/x.json .github/control-changes/',
    'cp -r /tmp/firmas .github/control-changes',
    'git mv firma.json .github/control-changes/abc.json',
    'install -m 644 /tmp/f .tycon/control-changes.jsonl',
    'rsync -a /tmp/firmas/ .github/control-changes/',
    'git apply firma.patch',
    'patch -p1 < firma.patch',
    'git checkout firma -- .tycon/control-changes.jsonl',
    'git restore --source firma -- .tycon/control-changes.jsonl',
    'git update-index --add --cacheinfo 100644,abc,.tycon/control-changes.jsonl',
    // el destino que no es el último argumento, y la carpeta de arriba con las constancias adentro de lo copiado
    'cp -t .github/control-changes/ /tmp/x.json',
    'cp --target-directory=.tycon/control-changes /tmp/x.json',
    'cp -r forjado/. .',
    'cp -r forjado/.tycon .',
    'rsync -a forjado/ .',
    'mv forjado/.tycon .',
    'ln -s /tmp/x.json .github/control-changes/x.json',
    'ditto /tmp/x.json .tycon/control-changes/x.json',
    'scp host:x.json .tycon/control-changes/',
    'scp -r host:forjado/. .',
    // un parche que no se puede leer antes de aplicarlo, o que nombra la constancia de otra forma
    'git am firma.patch',
    'cat firma.patch | git apply',
    'git apply -',
    "printf 'x' > nuevo.diff && git apply nuevo.diff",
    'git apply otro.patch falta.patch',
    'patch -p1 -i firma.txt',
    'git apply octal.patch',
    "git apply <<'EOF'\ndiff --git a/.tycon/control-changes.jsonl b/.tycon/control-changes.jsonl\nEOF",
    // la copia adentro de otro comando: lo que corre adentro se mira igual
    "bash -c 'cp /tmp/x.json .github/control-changes/'",
    'eval cp /tmp/x.json .github/control-changes/',
    'echo $(cp /tmp/x.json .github/control-changes/)',
    'echo `cp /tmp/x.json .github/control-changes/`',
    '{ cp /tmp/x.json .github/control-changes/; }',
    'if true; then cp /tmp/x.json .github/control-changes/; fi',
    'timeout 5 cp /tmp/x.json .github/control-changes/',
    'xargs -I {} cp {} .github/control-changes/ < lista',
    'find /tmp -name x.json -exec cp {} .github/control-changes/ \\;',
    'git checkout firma .tycon/control-changes.jsonl',
    'git -C . checkout firma -- .tycon/control-changes.jsonl',
    'git -c a=b apply firma.patch',
    'git restore -sfirma .tycon/control-changes.jsonl',
    'sleep 1 & cp /tmp/x.json .github/control-changes/',
    'cat firma.patch | patch -p 1 README.md',
    'cp -r enlace/ .',
    // sin la raíz del repo (git no contesta), una carpeta o la de las constancias repuesta desde otra ref no pasa
    'git checkout firma -- .',
    'git restore --source firma limpio',
    'git restore --source HEAD~1 .github',
  ];
  for (const c of frenan) {
    const r = correr(c);
    assert.ok(r && r.block, `frena: ${c}`);
    assert.match(r.block, /constancia de cambio de control no se escribe a mano/, c);
  }
  const pasan = [
    'git apply otro.patch',
    'git add .github/control-changes/x.json',
    'cat .github/control-changes/x.json',
    'grep -r approve .github/control-changes',
    'cp .github/control-changes/x.json /tmp/',
    'cp -r .github/control-changes /tmp/copia',
    'cp -r limpio/. .',
    'rsync -a limpio/ docs/',
    'rsync /tmp/no-existe.txt docs/a.md',
    "git apply <<'EOF'\ndiff --git a/README.md b/README.md\nEOF",
    'bash scripts/ci/run-base-controls.sh approve --root . --out .tycon/control-changes/ --entries x',
    // un archivo suelto repuesto desde otra ref no trae una constancia, aunque git no conteste
    'git restore --source HEAD~1 src/a.ts',
    'git checkout firma -- limpio/docs/a.md',
  ];
  for (const c of pasan) assert.ok(!(correr(c) || {}).block, `pasa: ${c}`);
});

// T54 BaseControls_ApproveDelegado_CasaFalsa @story-8.116 @ac-57
// 🔴 Falla con: una firma que lee la casa de `HOME`, `USERPROFILE` o una variable `TYCON_*` en vez de la de la cuenta.
test('8.116 T54 BaseControls_ApproveDelegado_CasaFalsa', () => {
  const falsa = listo();
  const cuenta = fs.mkdtempSync(path.join(os.tmpdir(), 'cuenta-'));
  const antes = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TYCON_HOME: process.env.TYCON_HOME };
  process.env.HOME = falsa.home; process.env.USERPROFILE = falsa.home; process.env.TYCON_HOME = path.join(falsa.home, '.tycon');
  try {
    const r = DS.checkDelegatedApprove({ ...pedido(falsa), home: undefined, userInfo: () => ({ homedir: cuenta }) });
    assert.strictEqual(r.ok, false);
    assert.ok(!String(r.reason).includes(falsa.home), r.reason);
    assert.strictEqual(DS.accountPaths(cuenta).state.startsWith(cuenta), true);
  } finally {
    for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
