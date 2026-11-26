'use strict';
/**
 * session-approval.test.js — la sentencia de producción pedida por una sesión la aprueba el click del dueño en el
 * cuadro de opciones de esa sesión (scripts/production/session-approval.js), con la verificación de las firmas del dueño.
 *
 * El caso: el cuadro del sistema de la puerta se ve sólo en la pantalla de la Mac; el dueño que sigue la sesión desde el
 * celular no lo ve y la consulta se vence. Acá se prueba lo que decide el verificador: la pregunta trae el servidor, la
 * sentencia entera, la sesión y el código; el click se busca con esa pregunta, sirve una vez y vence a los pocos minutos;
 * sin el proceso de la sesión entre los padres no aprueba. La búsqueda del click (owner-approvals.js `buscar`) tiene sus
 * propias pruebas: acá se reemplaza por un doble que anota con qué la llamaron. Sin red.
 *
 * @story-8.337
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sa = require('../production/session-approval.js');
const oaReal = require('../lib/owner-approvals.js');

const SES = '0123abcd-4567-89ef-0123-456789abcdef';
const BASE = { host: 'acme-sql.example.com', sentencia: 'EXEC dbo.RPT_Ejemplo @ID = 0', maxFilas: 50, sesion: SES };
const AHORA = Date.parse('2026-11-26T15:00:00Z');
// la herramienta (pid 10), su consola (20) y la puerta (30)
const ARBOL = [
  { pid: 10, ppid: 1, inicio: 'Thu Nov 26 10:00:00 2026', comando: 'claude' },
  { pid: 20, ppid: 10, inicio: 'Thu Nov 26 10:01:00 2026', comando: 'zsh -c x' },
  { pid: 30, ppid: 20, inicio: 'Thu Nov 26 10:01:01 2026', comando: 'bash -p /opt/tycon/bin/la-puerta' },
];
const ow = require('../lib/owner-window.js');

/** Un doble de owner-approvals con el `buscar` que se le pida, y las demás funciones reales. */
function oaCon(buscar, { consumir } = {}) {
  const llamadas = [];
  const usadas = [];
  return {
    llamadas, usadas,
    oa: { ...oaReal, coordinadoraConfirmada: () => null,
      buscar: (o) => { llamadas.push(o); return buscar(o); },
      consumir: consumir || ((casa, a) => { usadas.push(a.id); return { ok: true }; }) },
  };
}
const casa = () => fs.mkdtempSync(path.join(os.tmpdir(), 'session-approval-'));

test('T1 · SessionApproval_Question_HasServerStatementSessionAndCode', () => {
  const c = sa.cuadroDe(BASE);
  assert.ok(c.pregunta.includes(BASE.host), 'el servidor');
  assert.ok(c.pregunta.includes(BASE.sentencia), 'la sentencia entera');
  assert.ok(c.pregunta.includes(`sesión ${SES}`), 'la sesión');
  assert.ok(c.pregunta.endsWith(`(firma production-query · sesión ${SES} · código ${sa.codigoDe(BASE)})`), 'el sello al final');
  assert.deepStrictEqual(c.opciones, ['Sí, aprobar', 'No']);
  assert.strictEqual(c.clickDelDueno, true, 'sólo un click, nunca un «aprobado» escrito');
});

test('T2 · SessionApproval_LongStatement_IsShownWhole', () => {
  const larga = `select ${'columna_larga, '.repeat(80)}1 from dbo.Tabla where id = 0`;
  const c = sa.cuadroDe({ ...BASE, sentencia: larga });
  assert.ok(c.pregunta.includes(larga), 'una sentencia de más de 600 letras no se corta');
});

test('T3 · SessionApproval_Code_ChangesWithStatementServerRowsOrSession', () => {
  const c = sa.codigoDe(BASE);
  assert.match(c, /^[0-9a-f]{12}$/);
  assert.notStrictEqual(sa.codigoDe({ ...BASE, sentencia: 'EXEC dbo.RPT_Ejemplo @ID = 1' }), c);
  assert.notStrictEqual(sa.codigoDe({ ...BASE, host: 'otro' }), c);
  assert.notStrictEqual(sa.codigoDe({ ...BASE, maxFilas: 7 }), c);
  assert.notStrictEqual(sa.codigoDe({ ...BASE, sesion: 'otra-sesion' }), c);
});

test('T4 · SessionApproval_NoClick_AsksWithTheExactQuestion', () => {
  const d = oaCon(() => ({ ok: false, motivo: 'no hay un click del dueño en el cuadro' }));
  const r = sa.decidir({ ...BASE, casa: casa(), pid: 30, ahora: AHORA, arbol: ARBOL, oa: d.oa, ow });
  assert.strictEqual(r.estado, 'pedir');
  assert.ok(r.texto.includes(sa.cuadroDe(BASE).pregunta), 'trae la pregunta tal cual');
  assert.ok(r.texto.includes('AskUserQuestion'));
  assert.strictEqual(d.llamadas[0].cuadro.pregunta, sa.cuadroDe(BASE).pregunta, 'busca el click de esta pregunta');
  assert.deepStrictEqual(d.llamadas[0].herramienta, { pid: 10, inicio: ARBOL[0].inicio }, 'del proceso de la sesión que lanzó la puerta');
  assert.strictEqual(d.usadas.length, 0);
});

test('T5 · SessionApproval_ValidClick_IsUsedOnce', () => {
  let usada = false;
  const d = oaCon(() => ({ ok: true, aprobacion: { id: 'a1', ts: new Date(AHORA - 60000).toISOString() } }), {
    consumir: () => { if (usada) return { ok: false, motivo: 'esa aprobación ya la usó otra firma' }; usada = true; return { ok: true }; },
  });
  const c = casa();
  assert.deepStrictEqual(sa.decidir({ ...BASE, casa: c, pid: 30, ahora: AHORA, arbol: ARBOL, oa: d.oa, ow }), { estado: 'aprobada', id: 'a1' });
  const otra = sa.decidir({ ...BASE, casa: c, pid: 30, ahora: AHORA, arbol: ARBOL, oa: d.oa, ow });
  assert.strictEqual(otra.estado, 'pedir', 'el mismo click no sirve dos veces');
  assert.match(otra.texto, /ya la usó/);
});

test('T6 · SessionApproval_OldClick_Expires', () => {
  const d = oaCon(() => ({ ok: true, aprobacion: { id: 'a1', ts: new Date(AHORA - (sa.VENCE_MIN * 60000 + 1000)).toISOString() } }));
  const r = sa.decidir({ ...BASE, casa: casa(), pid: 30, ahora: AHORA, arbol: ARBOL, oa: d.oa, ow });
  assert.strictEqual(r.estado, 'pedir');
  assert.match(r.texto, new RegExp(`más de ${sa.VENCE_MIN} minutos`));
  assert.strictEqual(d.usadas.length, 0, 'un click vencido no se gasta');
});

test('T7 · SessionApproval_NotLaunchedBySession_OrTreeUnreadable_Fails', () => {
  const d = oaCon(() => ({ ok: true, aprobacion: { id: 'a1', ts: new Date(AHORA).toISOString() } }));
  const sinSesion = ARBOL.map((p) => (p.pid === 10 ? { ...p, comando: 'Terminal' } : p));
  assert.strictEqual(sa.decidir({ ...BASE, casa: casa(), pid: 30, ahora: AHORA, arbol: sinSesion, oa: d.oa, ow }).estado, 'error');
  assert.strictEqual(sa.decidir({ ...BASE, casa: casa(), pid: 30, ahora: AHORA, arbol: null, oa: d.oa, ow }).estado, 'error');
  assert.strictEqual(d.llamadas.length, 0, 'sin la sesión entre los padres no se busca ningún click');
});

test('T8 · SessionApproval_UnreadableRecord_IsAnErrorNotAQuestion', () => {
  const d = oaCon(() => ({ ok: false, motivo: 'no encontré la transcripción de la sesión', noLeida: true }));
  const r = sa.decidir({ ...BASE, casa: casa(), pid: 30, ahora: AHORA, arbol: ARBOL, oa: d.oa, ow });
  assert.strictEqual(r.estado, 'error');
});

test('T9 · SessionApproval_RealSearch_WrittenApprovalDoesNotCount', () => {
  // con la búsqueda real: un «aprobado» escrito anotado en la sesión no aprueba una sentencia (sólo el click)
  const c = casa();
  oaReal.anotar(c, { id: 'm1', tipo: 'mensaje', sesion: SES, ts: new Date(AHORA - 60000).toISOString(), texto: 'aprobado', herramienta: { pid: 10, inicio: ARBOL[0].inicio } });
  const r = sa.decidir({ ...BASE, casa: c, pid: 30, ahora: AHORA, arbol: ARBOL, oa: { ...oaReal, coordinadoraConfirmada: () => null }, ow });
  assert.strictEqual(r.estado, 'pedir');
});

test('T11 · SessionApproval_OtherForms_SayFirstWhatTheyDo', () => {
  // fila 286: todas las formas con cuadro pasan por el click en la sesión; las que apagan el freno o no tienen vuelta
  // atrás lo dicen al principio de la pregunta, con el servidor o el grupo
  const de = (forma, host) => sa.cuadroDe({ ...BASE, forma, host, sentencia: 'lo que armó la puerta' }).pregunta;
  assert.ok(de('reclasificar', BASE.host).startsWith(`¿APAGAR EL FRENO para ${BASE.host}`));
  assert.ok(de('borrar-grupo', 'rg-acme-viejo').startsWith('¿BORRAR SIN VUELTA ATRÁS el grupo de recursos rg-acme-viejo'));
  assert.ok(de('open-firewall', BASE.host).startsWith(`¿Abrir el firewall de producción ${BASE.host}`));
  assert.ok(de('azure', BASE.host).includes('Azure'));
  for (const f of Object.keys(sa.FORMAS)) assert.ok(de(f, BASE.host).includes('lo que armó la puerta'), `${f}: lo que se aprueba, entero`);
  assert.throws(() => sa.cuadroDe({ ...BASE, forma: 'otra' }));
});

test('T12 · SessionApproval_Code_DiffersByForm_AndConsultaKeepsItsCode', () => {
  const codigos = Object.keys(sa.FORMAS).map((forma) => sa.codigoDe({ ...BASE, forma }));
  assert.strictEqual(new Set(codigos).size, codigos.length, 'un click a una forma no vale para otra');
  // la consulta conserva su código de antes de la fila 286
  const antes = require('crypto').createHash('sha256').update([BASE.host, BASE.sentencia, '50', SES].join('\0')).digest('hex').slice(0, 12);
  assert.strictEqual(sa.codigoDe(BASE), antes);
  const d = oaCon(() => ({ ok: false, motivo: 'no hay un click' }));
  sa.decidir({ ...BASE, forma: 'borrar-grupo', host: 'rg-acme-viejo', casa: casa(), pid: 30, ahora: AHORA, arbol: ARBOL, oa: d.oa, ow });
  assert.ok(d.llamadas[0].cuadro.pregunta.startsWith('¿BORRAR SIN VUELTA ATRÁS'), 'busca el click de la pregunta de su forma');
  assert.strictEqual(sa.decidir({ ...BASE, forma: 'otra', casa: casa(), pid: 30, ahora: AHORA, arbol: ARBOL, oa: d.oa, ow }).estado, 'error');
});

test('T10 · SessionApproval_Args_StatementAfterSeparatorOnly', () => {
  assert.deepStrictEqual(sa.leerArgs(['--host', 'h', '--session', SES, '--max-rows', '7', '--', 'select 1']),
    { maxFilas: 7, host: 'h', sesion: SES, sentencia: 'select 1' });
  assert.strictEqual(sa.leerArgs(['--host', 'h', '--session', SES, 'select 1']), null, 'sin «--» no hay sentencia');
  assert.strictEqual(sa.leerArgs(['--host', 'h', '--session', SES, '--', 'select 1', 'otra']), null, 'una sola sentencia');
  assert.strictEqual(sa.leerArgs(['--host', 'h', '--other', 'x', '--session', SES, '--', 'select 1']), null);
  // la forma: una de las de la puerta, o nada; un servidor vacío no pasa (un cambio de Azure lo pasaba vacío)
  assert.strictEqual(sa.leerArgs(['--kind', 'azure', '--host', 'azure', '--session', SES, '--', 'az x']).forma, 'azure');
  assert.strictEqual(sa.leerArgs(['--kind', 'other', '--host', 'h', '--session', SES, '--', 'x']), null);
  assert.strictEqual(sa.leerArgs(['--kind', 'azure', '--host', '', '--session', SES, '--', 'az x']), null);
});
