'use strict';
/**
 * run-signatures.test.js — las firmas de una corrida, tomadas del registro común (`signatures.jsonl`): las de sus
 * sesiones dentro de su ventana, con ocho campos, los ids de sesión acortados, los textos saneados y con tope.
 *
 * Todo en proceso: las casas del registro se pasan como parámetro, así ninguna prueba toca el registro de la cuenta.
 *
 * stable-data: las horas son fijas; ninguna prueba crea commits.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RS = require('../lib/run-signatures.js');
const { logPath } = require('../lib/signature-log.js');

const S1 = '11111111-aaaa-4bbb-8ccc-000000000001';
const S0 = '00000000-aaaa-4bbb-8ccc-000000000000';
const OTRA = '22222222-aaaa-4bbb-8ccc-000000000002';
const COORD = 'dddddddd-0000-4000-8000-0000000000d1';
const DESDE = Date.parse('2026-11-08T10:00:00Z');
const HASTA = Date.parse('2026-11-08T12:00:00Z');
const CAMPOS = ['cuando', 'firma', 'nivel', 'via', 'delegada', 'quien', 'pedida_por', 'razon'];

function casaNueva(t) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'run-signatures-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  return casa;
}

function escribir(casa, renglones) {
  const p = logPath(casa);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, renglones.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return p;
}

const firma = (o) => ({
  ts: '2026-11-08T11:00:00.000Z', signature: 'plan-approval', level: 1, covers: ['plan-approval'], via: 'click', delegated: false,
  signer: 'persona', ordered_by: S1, target: S1, machine: 'maquina', reason: 'plan de la 2.78', source: 'marker.js', ...o,
});

test('T1 2.78-DeCorrida_EligePorSesionYVentana @story-2.78 @ac-1 @ac-2', (t) => {
  const casa = casaNueva(t);
  escribir(casa, [
    firma({ ts: '2026-11-08T11:30:00.000Z', via: 'notified', signature: 'pending-approval', signer: `sesión ${COORD}, en una pestaña sin permisos (hecho y avisado)`, ordered_by: COORD }),
    firma({ ts: '2026-11-08T10:30:00.000Z' }),
    firma({ ts: '2026-11-08T11:00:00.000Z', via: 'delegation', delegated: true, signature: 'extra-round', signer: `coordinadora (sesión ${COORD})`, ordered_by: COORD }),
    firma({ ts: '2026-11-08T10:45:00.000Z', target: OTRA }),
    firma({ ts: '2026-11-08T09:59:59.000Z' }),
    firma({ ts: '2026-11-08T10:50:00.000Z', target: null }),
  ]);
  const r = RS.deCorrida({ sesiones: [S1], desde: DESDE, hasta: HASTA, casas: [casa] });
  assert.strictEqual(r.estado, 'leido');
  assert.strictEqual(r.ilegibles, 0);
  assert.strictEqual(r.recortadas, 0);
  assert.deepStrictEqual(r.lineas.map((l) => l.cuando), ['2026-11-08T10:30:00.000Z', '2026-11-08T11:00:00.000Z', '2026-11-08T11:30:00.000Z']);
  for (const l of r.lineas) assert.deepStrictEqual(Object.keys(l), CAMPOS);
  assert.strictEqual(r.lineas[0].pedida_por, null, 'pedida por la sesión de la corrida: no se dice');
  assert.strictEqual(r.lineas[1].pedida_por, 'dddddddd');
  assert.strictEqual(r.lineas[1].delegada, true);

  // la corrida adoptada y la restaurada: las sesiones anteriores también son suyas
  const ad = RS.deVolcado({ archivedAt: '2026-11-08T12:00:00.000Z', marker: { sessionId: OTRA, adoptedFrom: S1, startedAt: '2026-11-08T10:00:00.000Z' } }, { casas: [casa] });
  assert.ok(ad.lineas.some((l) => l.cuando === '2026-11-08T10:30:00.000Z'), JSON.stringify(ad));
  assert.ok(ad.lineas.some((l) => l.cuando === '2026-11-08T10:45:00.000Z'), 'la de la sesión propia también');
  const re = RS.deVolcado({ archivedAt: '2026-11-08T12:00:00.000Z', marker: { sessionId: OTRA, restoredFrom: S1, startedAt: '2026-11-08T10:00:00.000Z' } }, { casas: [casa] });
  assert.strictEqual(re.lineas.length, 4);

  // dos casas: la repetida una vez, sin marca; la que sólo está en la segunda, con otra_casa
  const cuenta = casaNueva(t);
  const home = casaNueva(t);
  const comun = firma({ ts: '2026-11-08T10:10:00.000Z' });
  escribir(cuenta, [comun]);
  escribir(home, [comun, firma({ ts: '2026-11-08T10:20:00.000Z', signature: 'save' })]);
  const dos = RS.deCorrida({ sesiones: [S1], desde: DESDE, hasta: HASTA, casas: [cuenta, home] });
  assert.strictEqual(dos.lineas.length, 2);
  assert.ok(!('otra_casa' in dos.lineas[0]), JSON.stringify(dos.lineas[0]));
  assert.strictEqual(dos.lineas[1].otra_casa, true);
});

test('T2 2.78-DeCorrida_SaneaYCorta @story-2.78 @ac-3', (t) => {
  const casa = casaNueva(t);
  const ruta = path.join(os.homedir(), 'Proyectos', 'Cliente', 'secreto.txt');
  // el correo y la credencial se arman por partes: escritos enteros, el freno de publicación los toma por reales
  const CORREO = ['ana', 'ejemplo.com'].join('@');
  const CLAVE = 'hunter2hunter2';
  const sucio = `${ruta} a ${CORREO} con ${['PASS', 'WORD'].join('')}=${CLAVE} y la sesión ${COORD}`;
  escribir(casa, [
    firma({ reason: `${sucio} ${'x'.repeat(500)}`, signer: sucio, ordered_by: OTRA, extra: 'no sale' }),
    firma({ ts: '2026-11-08T11:10:00.000Z', via: 'telepatia' }),
    firma({ ts: '2026-11-08T11:20:00.000Z', signature: 'plan approval; rm -rf' }),
  ]);
  const r = RS.deCorrida({ sesiones: [S1], desde: DESDE, hasta: HASTA, casas: [casa] });
  assert.strictEqual(r.estado, 'leido');
  assert.strictEqual(r.lineas.length, 1);
  assert.strictEqual(r.ilegibles, 2, 'la vía desconocida y la firma sin forma de id');
  const [l] = r.lineas;
  assert.deepStrictEqual(Object.keys(l), CAMPOS);
  assert.ok(!('motivo' in l));
  for (const txt of [l.razon, l.quien]) {
    assert.ok(!txt.includes(os.homedir()), txt);
    assert.ok(!txt.includes(CORREO), txt);
    assert.ok(!txt.includes(CLAVE), txt);
    assert.ok(!txt.includes(COORD), txt);
    assert.ok(txt.includes('dddddddd'), `el id corto queda: ${txt}`);
    assert.ok(!txt.includes('<sesión>'), txt);
  }
  assert.ok(l.razon.length <= 300, l.razon.length);
  assert.ok(l.quien.length <= 160, l.quien.length);
  assert.strictEqual(l.pedida_por, '22222222');

  // el id de la firma también pasa por el acortador: un renglón con un id de sesión entero no lo lleva a la página
  const conId = casaNueva(t);
  escribir(conId, [firma({ signature: `x-${COORD}` })]);
  const ci = RS.deCorrida({ sesiones: [S1], desde: DESDE, hasta: HASTA, casas: [conId] });
  assert.strictEqual(ci.lineas.length, 1, JSON.stringify(ci));
  assert.strictEqual(ci.lineas[0].firma, 'x-dddddddd');

  // cortar no parte un emoji por la mitad
  const emojis = casaNueva(t);
  escribir(emojis, [firma({ reason: '😀'.repeat(400), signer: '😀'.repeat(400) })]);
  const em = RS.deCorrida({ sesiones: [S1], desde: DESDE, hasta: HASTA, casas: [emojis] });
  const SUELTO = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  for (const txt of [em.lineas[0].razon, em.lineas[0].quien]) assert.ok(!SUELTO.test(txt), `sin medio emoji: ${JSON.stringify(txt.slice(-3))}`);
});

test('T3 2.78-DeCorrida_TopeEIlegibles @story-2.78 @ac-4', (t) => {
  const casa = casaNueva(t);
  const base = Date.parse('2026-11-08T10:01:00Z');
  const muchas = Array.from({ length: 230 }, (_, i) => firma({ ts: new Date(base + i * 1000).toISOString(), reason: 'r'.repeat(50) }));
  // fuera de orden: las mezcla
  const mezcladas = muchas.map((x, i) => [((i * 7919) % 230), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  // dos renglones rotos iguales en el mismo archivo son dos renglones: cada uno cuenta
  escribir(casa, [...mezcladas.slice(0, 100), '{ esto no es json', ...mezcladas.slice(100), 'tampoco', 'tampoco']);
  const r = RS.deCorrida({ sesiones: [S1], desde: DESDE, hasta: HASTA, casas: [casa] });
  assert.strictEqual(r.lineas.length, 200);
  assert.strictEqual(r.recortadas, 30);
  assert.strictEqual(r.ilegibles, 3);
  assert.strictEqual(r.lineas[0].cuando, new Date(base + 30 * 1000).toISOString(), 'quedan las más recientes');
  assert.strictEqual(r.lineas[199].cuando, new Date(base + 229 * 1000).toISOString());

  const grande = casaNueva(t);
  escribir(grande, Array.from({ length: 120 }, (_, i) => firma({ ts: new Date(base + i * 1000).toISOString(), reason: 'z'.repeat(600), signer: 'q'.repeat(400), ordered_by: OTRA })));
  const g = RS.deCorrida({ sesiones: [S1], desde: DESDE, hasta: HASTA, casas: [grande] });
  assert.ok(g.lineas.length < 120 && g.lineas.length > 0, g.lineas.length);
  assert.ok(Buffer.byteLength(JSON.stringify(g.lineas)) <= 64 * 1024);
  assert.strictEqual(g.recortadas, 120 - g.lineas.length);
  assert.strictEqual(g.lineas[g.lineas.length - 1].cuando, new Date(base + 119 * 1000).toISOString());
});

test('T4 2.78-DeCorrida_AusenteYNoMedido @story-2.78 @ac-5', (t) => {
  const vacia = casaNueva(t);
  assert.deepStrictEqual(RS.deCorrida({ sesiones: [S1], desde: DESDE, hasta: HASTA, casas: [vacia] }).estado, 'ausente');

  const cerrada = casaNueva(t);
  const p = escribir(cerrada, [firma({})]);
  fs.chmodSync(p, 0o000);
  // la carpeta temporal puede borrarse antes: devolverle el permiso es sólo por si queda
  t.after(() => { try { fs.chmodSync(p, 0o600); } catch (_) { /* ya no está */ } });
  const sinPermiso = RS.deCorrida({ sesiones: [S1], desde: DESDE, hasta: HASTA, casas: [cerrada] });
  if (process.getuid && process.getuid() === 0) t.diagnostic('corre como root: el archivo sin permiso se puede leer');
  else {
    assert.strictEqual(sinPermiso.estado, 'no_medido');
    assert.match(sinPermiso.motivo, /no pude leer/);
  }

  const llena = casaNueva(t);
  escribir(llena, [firma({})]);
  const sinSaneador = RS.deCorrida({ sesiones: [S1], desde: DESDE, hasta: HASTA, casas: [llena], sanear: null });
  assert.strictEqual(sinSaneador.estado, 'no_medido');
  assert.match(sinSaneador.motivo, /el saneado \(tokens-digest\.js\) no está en esta máquina/);
  assert.ok(!sinSaneador.lineas || sinSaneador.lineas.length === 0);

  const sinArranque = RS.deVolcado({ archivedAt: '2026-11-08T12:00:00.000Z', marker: { sessionId: S1 } }, { casas: [llena] });
  assert.strictEqual(sinArranque.estado, 'no_medido');
  assert.match(sinArranque.motivo, /hora de arranque/);

  // sin saber dónde está la casa de la cuenta no se dice «ausente»: no se pudo mirar donde escribe appendSignature
  const sinCuenta = RS.deCorrida({ sesiones: [S1], desde: DESDE, hasta: HASTA, casas: () => RS.casasPorDefecto(() => { throw new Error('sin casa'); }) });
  assert.strictEqual(sinCuenta.estado, 'no_medido', JSON.stringify(sinCuenta));
  assert.match(sinCuenta.motivo, /casa de la cuenta/);

  // nunca tira, ni con basura
  assert.doesNotThrow(() => RS.deVolcado(null));
  assert.strictEqual(RS.deVolcado(null).estado, 'no_medido');

  // las dos suites nuevas están registradas: sin eso, el portón no las corre
  const registro = require('./suites.json');
  const rutas = [...registro.diarias, ...registro.semanales].map((s) => `${s.raiz}:${s.ruta}`);
  for (const r of ['arnes:tests/run-signatures.test.js', 'agent-skills:tycon-pipeline/scripts/tests/marker-archive-signatures.test.js']) assert.ok(rutas.includes(r), `${r} en suites.json`);
});
