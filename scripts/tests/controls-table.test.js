'use strict';
/**
 * controls-table.test.js — la tabla de controles armada con los registros de la carpeta de estado (sólo lee).
 *
 * Cada prueba arma su propia casa con los registros que necesita; ninguna lee la casa de quien corre las pruebas.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GUION = path.join(__dirname, '..', 'metrics', 'controls-table.js');
const ct = require(GUION);

function casaNueva(t, registros = {}) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'controls-table-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  const estado = path.join(casa, '.claude', '.tycon-pipeline');
  fs.mkdirSync(estado, { recursive: true });
  for (const [archivo, filas] of Object.entries(registros)) {
    fs.writeFileSync(path.join(estado, archivo), filas.map((f) => (typeof f === 'string' ? f : JSON.stringify(f))).join('\n') + '\n');
  }
  return { casa, estado };
}
const correr = (casa, args = []) => spawnSync(process.execPath, [GUION, '--home', casa, ...args], { encoding: 'utf8', env: { ...process.env, HOME: casa, USERPROFILE: casa } });
const listado = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((f) => `${f}:${fs.statSync(path.join(dir, f)).size}`);

// 🔴 Falla con: un freno contado en la columna equivocada, o una falsa alarma inventada en vez de «no medido».
test('ControlsTable_CuentaPorFrenoYRegla', (t) => {
  const { casa } = casaNueva(t, { 'frenos.jsonl': [
    { ts: '2026-10-30T10:00:00Z', freno: 'safety-guard', regla: 'GIT-C1', veredicto: 'bloqueo' },
    { ts: '2026-10-30T11:00:00Z', freno: 'safety-guard', regla: 'GIT-C1', veredicto: 'bloqueo' },
    { ts: '2026-10-30T12:00:00Z', freno: 'safety-guard', regla: 'GIT-C1', veredicto: 'escape' },
    { ts: '2026-10-30T12:30:00Z', freno: 'test-scope-guard', regla: 'suite-completa', veredicto: 'paso' },
    { ts: '2026-10-30T13:00:00Z', freno: 'push-referencia-fantasma', regla: 'referencia-fantasma', veredicto: 'aviso' },
    'no es json',
  ] });
  const r = ct.tabla({ home: casa, ahora: '2026-10-31T00:00:00Z' });
  assert.deepStrictEqual(r.conteo.controles.map((c) => [c.freno, c.regla, c.bloqueo, c.aviso, c.escape, c.paso]), [
    ['push-referencia-fantasma', 'referencia-fantasma', 0, 1, 0, 0],
    ['safety-guard', 'GIT-C1', 2, 0, 1, 0],
    ['test-scope-guard', 'suite-completa', 0, 0, 0, 1],
  ]);
  assert.strictEqual(r.frenos.malas, 1);
  assert.match(r.md, /\| safety-guard \| GIT-C1 \| 2 \| 0 \| 1 \| 0 \| 0 \| no medido \|/);
  assert.match(r.md, /1 ilegible/);
});

// 🔴 Falla con: una firma delegada contada como de la persona, o las vías mezcladas.
test('ControlsTable_CuentaLasFirmasPorVia', (t) => {
  const { casa } = casaNueva(t, { 'frenos.jsonl': [], 'signatures.jsonl': [
    { ts: '2026-10-30T10:00:00Z', signature: 'save', via: 'window', delegated: false },
    { ts: '2026-10-30T11:00:00Z', signature: 'save', via: 'delegation', delegated: true },
    { ts: '2026-10-30T12:00:00Z', signature: 'extra-round', via: 'terminal', delegated: false },
  ] });
  const r = ct.tabla({ home: casa });
  assert.deepStrictEqual(r.conteo.firmas.map((f) => [f.firma, f.total, f.delegadas, f.vias]), [
    ['extra-round', 1, 0, { terminal: 1 }],
    ['save', 2, 1, { delegation: 1, window: 1 }],
  ]);
  assert.match(r.md, /\| save \| 2 \| 1 \| delegation: 1, window: 1 \|/);
  assert.match(r.md, /Ningún freno anotó/);
});

// 🔴 Falla con: un registro que no existe dicho como cero (no haberlo medido no es no haber frenado).
test('ControlsTable_SinRegistro_DiceNoMedido', (t) => {
  const { casa } = casaNueva(t);
  const r = ct.tabla({ home: casa });
  assert.strictEqual(r.frenos.estado, 'ausente');
  assert.strictEqual(r.firmas.estado, 'ausente');
  assert.match(r.md, /no medido \(no hay frenos\.jsonl\)/);
  assert.match(r.md, /no medido \(no hay signatures\.jsonl\)/);
  assert.doesNotMatch(r.md, /\| 0 \|/);
});

// 🔴 Falla con: --since que no filtra, o un renglón sin fecha que entra igual.
test('ControlsTable_Desde_FiltraPorFecha', (t) => {
  const { casa } = casaNueva(t, { 'frenos.jsonl': [
    { ts: '2026-10-01T10:00:00Z', freno: 'safety-guard', regla: 'GIT-C1', veredicto: 'bloqueo' },
    { ts: '2026-10-30T10:00:00Z', freno: 'safety-guard', regla: 'GIT-C1', veredicto: 'bloqueo' },
    { freno: 'safety-guard', regla: 'GIT-C1', veredicto: 'bloqueo' },
  ] });
  const r = ct.tabla({ home: casa, desde: '2026-10-15' });
  assert.strictEqual(r.conteo.controles[0].bloqueo, 1);
  assert.match(r.md, /desde el 2026-10-15/);
  assert.strictEqual(r.frenos.sinFecha, 1, 'el renglón sin fecha se cuenta aparte');
  assert.match(r.md, /1 sin fecha \(fuera del período\)/);
});

// 🔴 Falla con: el guion que escribe en la carpeta de estado, o que no deja la tabla en --out.
test('ControlsTable_Guion_EscribeSoloElArchivoPedido', (t) => {
  const { casa, estado } = casaNueva(t, { 'frenos.jsonl': [{ ts: '2026-10-30T10:00:00Z', freno: 'safety-guard', regla: 'FS-C1', veredicto: 'bloqueo' }] });
  const antes = listado(estado);
  const out = path.join(casa, 'tabla.md');
  const r = correr(casa, ['--out', out]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /\| safety-guard \| FS-C1 \| 1 \|/);
  assert.deepStrictEqual(listado(estado), antes, 'no tocó la carpeta de estado');
  // sin --out, a la salida; con --json, los conteos
  assert.match(correr(casa).stdout, /# Tabla de controles/);
  assert.strictEqual(JSON.parse(correr(casa, ['--json']).stdout).controles[0].regla, 'FS-C1');
  // un --out que no se puede escribir, o un argumento roto: sale 2
  assert.strictEqual(correr(casa, ['--out', path.join(casa, 'no', 'existe', 't.md')]).status, 2);
  assert.strictEqual(correr(casa, ['--since', 'ayer']).status, 2);
  assert.strictEqual(correr(casa, ['--out']).status, 2);
});

// ── por modelo, las marcas de cada bloqueo, los controles del pipeline y las fallas de los frenos ──────────────────────
const modelos = { 'ses-opus': 'claude-opus-5-5', 'ses-haiku': 'claude-haiku-5-5' };
const modelOf = (sid) => (modelos[sid] ? { model: modelos[sid] } : { model: null, noMedido: 'no encontré la conversación' });
const filaDe = (md, ...celdas) => md.split('\n').find((l) => celdas.every((c) => l.includes(`| ${c} |`)));

// 🔴 Falla con: una sesión contada en el modelo de otra, una sin sesión que se pierde, o un modelo supuesto.
test('T6 ControlsTable_PerModelColumns — una columna por modelo y una «sin modelo», con los conteos exactos', (t) => {
  const f = (veredicto, sesion, sha256) => ({ ts: '2026-11-10T10:00:00Z', freno: 'test-scope-guard', regla: 'suite-completa', veredicto, ...(sesion ? { sesion } : {}), sha256 });
  const { casa } = casaNueva(t, { 'frenos.jsonl': [f('bloqueo', 'ses-opus', 'h1'), f('paso', 'ses-opus', 'h2'), f('bloqueo', 'ses-haiku', 'h3'), f('escape', null, 'h4'), f('bloqueo', 'ses-perdida', 'h5')] });
  const r = ct.tabla({ home: casa, modelOf, ahora: '2026-11-21T00:00:00Z' });
  const m = r.porModelo.get('test-scope-guard');
  assert.deepStrictEqual([...m.keys()].sort(), ['claude-haiku-5-5', 'claude-opus-5-5', 'sin modelo']);
  assert.deepStrictEqual([m.get('claude-opus-5-5').decidio, m.get('claude-opus-5-5').bloqueo, m.get('claude-opus-5-5').paso], [2, 1, 1]);
  assert.strictEqual(m.get('claude-haiku-5-5').bloqueo, 1);
  assert.deepStrictEqual([m.get('sin modelo').decidio, m.get('sin modelo').escape, m.get('sin modelo').bloqueo], [2, 1, 1]);
  assert.ok(filaDe(r.md, 'test-scope-guard', 'claude-opus-5-5'), r.md);
  assert.ok(filaDe(r.md, 'test-scope-guard', 'preferencia (propuesta)', 'sin modelo'), r.md);
});

// 🔴 Falla con: un paso ANTERIOR al bloqueo contado como «pasó después», o (a) y (b) confundidas.
test('T7 ControlsTable_BlockThenSameHashPassed_Marks — las marcas (a), (b) y (c) bien contadas', () => {
  const f = (ts, veredicto, sha256) => ({ ts: `2026-11-10T10:0${ts}:00Z`, freno: 'safety-guard', regla: 'ESC-C3', veredicto, sesion: 'ses-opus', sha256 });
  const filas = [
    f(0, 'paso', 'h-antes'), f(1, 'bloqueo', 'h-antes'),       // el paso es anterior: (c)
    f(2, 'bloqueo', 'h-firma'), f(3, 'paso', 'h-firma'), f(4, 'escape', 'h-firma'), // escape después: (a)
    f(5, 'bloqueo', 'h-sola'), f(6, 'paso', 'h-sola'),         // sólo paso después: (b)
    f(7, 'bloqueo', 'h-nunca'),                                 // no se repite: (c)
    { ts: '2026-11-10T10:08:00Z', freno: 'safety-guard', regla: 'ESC-C3', veredicto: 'bloqueo', sesion: 'ses-opus' }, // sin huella
  ];
  const c = ct.contarPorModelo(filas, new Map([['ses-opus', 'claude-opus-5-5']])).get('safety-guard').get('claude-opus-5-5');
  assert.deepStrictEqual({ a: c.a, b: c.b, c: c.c, sinHuella: c.sinHuella, bloqueo: c.bloqueo }, { a: 1, b: 1, c: 2, sinHuella: 1, bloqueo: 5 });
});

// 🔴 Falla con: un control del pipeline que no frenó listado como control, `bloqueo` sin contar, o uno sin
//    clasificación que no sale en su lista.
test('T8 ControlsTable_PipelineGatesFromGatesLog — los que frenaron como controles; el sin clasificar, aparte', (t) => {
  const g = (name, status, sessionId) => ({ ts: '2026-11-10T10:00:00Z', name, status, sessionId });
  const { casa } = casaNueva(t, { 'gates.log': [g('story-gate', 'blocked', 'ses-opus'), g('story-gate', 'ok', 'ses-opus'), g('ledger-visible', 'bloqueo', 'ses-haiku'), g('solo-ok', 'ok', 'ses-opus')] });
  const r = ct.tabla({ home: casa, modelOf, ahora: '2026-11-21T00:00:00Z', clasificacion: escribirClasificacion(t, { 'story-gate': entradaDe('2027-01-20') }) });
  assert.deepStrictEqual([...r.porGate.keys()].sort(), ['ledger-visible', 'story-gate']);
  const sg = r.porGate.get('story-gate').get('claude-opus-5-5');
  assert.deepStrictEqual([sg.decidio, sg.bloqueo, sg.paso], [2, 1, 1]);
  const sin = r.md.split('### Sin clasificar')[1];
  assert.match(sin, /- ledger-visible/);
  assert.doesNotMatch(sin.split('##')[0], /story-gate|solo-ok/);
});

// 🔴 Falla con: un control que frena con `action` (no con `status`) fuera de la tabla, o un renglón que no es una
//    decisión (no medido, desconocido) contado como que dejó pasar.
test('T8b ControlsTable_PipelineGatesFromGatesLog — frena por `action` también; lo que no es decisión, aparte', (t) => {
  const g = (name, extra) => ({ ts: '2026-11-10T10:00:00Z', name, sessionId: 'ses-opus', ...extra });
  const { casa } = casaNueva(t, { 'gates.log': [
    g('undeclared-changes', { action: 'bloqueo' }), g('undeclared-changes', { action: 'pass', verdict: 'green' }),
    g('smoke-secrets', { action: 'block' }),
    g('red-test-edit', { status: 'blocked' }), g('red-test-edit', { status: 'not-measured' }), g('red-test-edit', { status: 'unknown' }),
    g('red-test-edit', { status: 'warn' }), g('red-test-edit', { status: 'green' }),
  ] });
  const r = ct.tabla({ home: casa, modelOf, ahora: '2026-11-21T00:00:00Z' });
  assert.deepStrictEqual([...r.porGate.keys()].sort(), ['red-test-edit', 'smoke-secrets', 'undeclared-changes']);
  const u = r.porGate.get('undeclared-changes').get('claude-opus-5-5');
  assert.deepStrictEqual([u.decidio, u.bloqueo, u.paso], [2, 1, 1]);
  const e = r.porGate.get('red-test-edit').get('claude-opus-5-5');
  assert.deepStrictEqual({ decidio: e.decidio, bloqueo: e.bloqueo, aviso: e.aviso, paso: e.paso, sinDecision: e.sinDecision },
    { decidio: 3, bloqueo: 1, aviso: 1, paso: 1, sinDecision: 2 });
  assert.match(filaDe(r.md, 'red-test-edit', 'claude-opus-5-5'), /\| 1 \| 0 \| 2 \|$/);
});

function escribirClasificacion(t, entradas) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clasif-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 'c.json');
  fs.writeFileSync(f, JSON.stringify({ __doc: 'de juguete', ...entradas }));
  return f;
}
const entradaDe = (review_before) => ({ tipo: 'preferencia', motivo: 'un trámite', review_before, estado: 'propuesta', ganchos: [] });

// 🔴 Falla con: una falla que frena contada como que deja pasar, o una marca de las cuatro sin leer.
test('T9 ControlsTable_HookFailuresCounted — dos que dejaron pasar y dos que frenaron', (t) => {
  const { casa, estado } = casaNueva(t);
  fs.writeFileSync(path.join(estado, 'hook-errors.log'), [
    '[2026-11-10T10:00:00.000Z] on-bash-write-gate FAILED OPEN: SyntaxError',
    '[2026-11-10T10:01:00.000Z] safety-guard ERR-FAIL-OPEN: no pude leer',
    '[2026-11-10T10:02:00.000Z] on-bash-write-gate FAILED CLOSED: algo',
    '[2026-11-10T10:03:00.000Z] session-cap-guard FRENÓ POR FALLA: no pude contar',
    '[2026-11-10T10:04:00.000Z] constancia-freno NO PUDO ANOTAR: escape fuera de la lista',
    '[2026-11-10T10:05:00.000Z] un-control: no pude leer su lista',
    'renglón sin sello',
  ].join('\n') + '\n');
  const r = ct.tabla({ home: casa, modelOf, ahora: '2026-11-21T00:00:00Z' });
  const p = Object.fromEntries([...r.fallas.porFreno.entries()]);
  assert.deepStrictEqual(p['on-bash-write-gate'], { total: 2, abiertas: 1, cerradas: 1, primera: '2026-11-10T10:00:00.000Z', ultima: '2026-11-10T10:02:00.000Z', recientes: 0, ultimaAbierta: '2026-11-10T10:00:00.000Z', abiertasRecientes: 0 });
  assert.strictEqual(p['safety-guard'].total, 1);
  assert.strictEqual(p['safety-guard'].abiertas, 1);
  assert.strictEqual(p['session-cap-guard'].cerradas, 1);
  assert.deepStrictEqual([p['constancia-freno'].total, p['constancia-freno'].abiertas, p['constancia-freno'].cerradas], [1, 0, 0]);
  assert.deepStrictEqual([p['un-control'].total, p['un-control'].abiertas, p['un-control'].cerradas], [1, 0, 0]);
  assert.ok(filaDe(r.md, 'on-bash-write-gate', '2', '1'), r.md);
});

// 🔴 Falla con: una fecha vigente marcada, o una vencida sin marcar.
test('T10 ControlsTable_ExpiredReviewDate_Marked — sólo la vencida, marcada', (t) => {
  const f = (freno) => ({ ts: '2026-11-10T10:00:00Z', freno, regla: 'r', veredicto: 'bloqueo', sha256: 'h' });
  const { casa } = casaNueva(t, { 'frenos.jsonl': [f('vieja'), f('nueva')] });
  const clasificacion = escribirClasificacion(t, { vieja: entradaDe('2026-11-01'), nueva: entradaDe('2027-01-20') });
  const r = ct.tabla({ home: casa, modelOf, ahora: '2026-11-21T00:00:00Z', clasificacion });
  assert.match(filaDe(r.md, 'vieja', 'sin modelo'), /2026-11-01 — revisión vencida/);
  assert.doesNotMatch(filaDe(r.md, 'nueva', 'sin modelo'), /vencida/);
  assert.match(r.md.split('## Revisión vencida')[1], /- vieja/);
  assert.doesNotMatch(r.md.split('## Revisión vencida')[1], /- nueva/);
});

// 🔴 Falla con: un registro que falta o no se lee contado como cero.
test('T13 ControlsTable_MissingLogs_NotMeasured — «no medido» con el motivo, nunca cero', (t) => {
  const { casa, estado } = casaNueva(t);
  fs.mkdirSync(path.join(estado, 'hook-errors.log')); // una carpeta en vez del archivo: no se puede leer
  const r = ct.tabla({ home: casa, modelOf, ahora: '2026-11-21T00:00:00Z' });
  assert.match(r.md, /gates\.log: no medido \(no hay gates\.log\)/);
  assert.match(r.md.split('## Fallas de los frenos mismos')[1], /no medido \(no se pudo leer hook-errors\.log: EISDIR\)/);
  assert.match(r.md.split('## Por freno y por modelo')[1], /no medido \(no hay frenos\.jsonl\)/);
});

// 🔴 Falla con: la tabla que escribe en la carpeta de estado o fuera de --out.
test('T14 ControlsTable_ReadOnly — la carpeta de estado queda igual, byte por byte', (t) => {
  const { casa, estado } = casaNueva(t, {
    'frenos.jsonl': [{ ts: '2026-11-10T10:00:00Z', freno: 'safety-guard', regla: 'ESC-C3', veredicto: 'bloqueo', sesion: 'ses-x', sha256: 'h' }],
    'gates.log': [{ ts: '2026-11-10T10:00:00Z', name: 'story-gate', status: 'blocked', sessionId: 'ses-x' }],
  });
  const contenido = (d) => fs.readdirSync(d, { recursive: true }).sort().map((f) => {
    const p = path.join(d, f);
    return fs.statSync(p).isFile() ? `${f}:${fs.readFileSync(p, 'base64')}` : `${f}/`;
  });
  const antesEstado = contenido(estado);
  const antesCasa = listado(casa);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tabla-out-')), 't.md');
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
  const r = correr(casa, ['--since', '2026-10-22', '--out', out]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(contenido(estado), antesEstado);
  assert.deepStrictEqual(listado(casa), antesCasa);
  assert.match(fs.readFileSync(out, 'utf8'), /## Por freno y por modelo/);
});

// 🔴 Falla con: un agujero cerrado hace semanas que se ve igual que uno vivo: sin la fecha de la última falla ni cuántas
//    hubo en los últimos 7 días.
test('T9b ControlsTable_HookFailures_OldHoleLooksClosed — la última falla y las de los últimos 7 días', (t) => {
  const { casa, estado } = casaNueva(t);
  fs.writeFileSync(path.join(estado, 'hook-errors.log'), [
    '[2026-10-25T10:00:00.000Z] viejo FAILED OPEN: un defecto ya arreglado',
    '[2026-11-01T10:00:00.000Z] viejo FAILED OPEN: un defecto ya arreglado',
    '[2026-11-10T10:00:00.000Z] vivo FAILED OPEN: otro',
    '[2026-11-20T10:00:00.000Z] vivo FAILED OPEN: otro',
    '[2026-11-20T11:00:00.000Z] viejo FAILED CLOSED: frena por la falla, no deja pasar',
  ].join('\n') + '\n');
  const r = ct.tabla({ home: casa, modelOf, ahora: '2026-11-21T00:00:00.000Z' });
  const viejo = r.fallas.porFreno.get('viejo');
  const vivo = r.fallas.porFreno.get('vivo');
  // su última falla es reciente, pero la última que dejó pasar es vieja: el agujero se cerró
  assert.deepStrictEqual([viejo.ultima, viejo.recientes, viejo.ultimaAbierta, viejo.abiertasRecientes], ['2026-11-20T11:00:00.000Z', 1, '2026-11-01T10:00:00.000Z', 0]);
  assert.deepStrictEqual([vivo.primera, vivo.recientes], ['2026-11-10T10:00:00.000Z', 1]);
  assert.match(filaDe(r.md, 'viejo', '2026-10-25'), /\| 2026-11-01 \| 0 \|$/);
  assert.match(filaDe(r.md, 'vivo', '2026-11-10'), /\| 2026-11-20 \| 1 \|$/);
});
