'use strict';
// office-task-numbers.test.js — the board command (board.js) and what the office does with the task numbers: every row
// gets a short fixed number, the board is written only through the command, and it moves by itself with the facts.
// office.test.js is at the size the gate can read, so these cases live here. Nothing reads the real HOME: every case
// gets its own toy state folder.
// stable-data: every date comes in by argument.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const BOARD_JS = path.join(__dirname, '..', 'tools', 'office', 'board.js');
const board = require(BOARD_JS);

const NOW = new Date(2026, 10, 4, 10, 40).getTime();

function stateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
  fs.mkdirSync(path.join(dir, 'coordination'), { recursive: true });
  return dir;
}
const boardFile = (sdir) => path.join(sdir, 'coordination', 'tablero.json');
const readRows = (sdir) => JSON.parse(fs.readFileSync(boardFile(sdir), 'utf8')).pendientes;
const writeRaw = (sdir, raw) => fs.writeFileSync(boardFile(sdir), JSON.stringify(raw, null, 2));
const fromFile = (sdir, raw) => { const f = path.join(sdir, 'mio.json'); fs.writeFileSync(f, JSON.stringify(raw)); return f; };
const row = (titulo, more = {}) => ({ titulo, estado: 'espera', grupo: 'Hoy', ...more });
const byTitle = (rows, t) => rows.find((r) => r.titulo === t);

function cli(sdir, args, { home = sdir } = {}) {
  try {
    const out = execFileSync(process.execPath, [BOARD_JS, ...args, '--state-dir', sdir], { encoding: 'utf8', env: { ...process.env, HOME: home, TYCON_HOME: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}

// ── El número lo pone el tablero ────────────────────────────────────────────────────────────────────────────────────

test('T1 Save_TableroSinNumeros_NumeraEnOrdenDeLaOficina — @story-8.198 @ac-1', () => {
  const sdir = stateDir();
  const r = board.save(sdir, { pendientes: [row('C', { grupo: 'Esta semana', orden: 1 }), row('B', { orden: 2 }), row('A', { orden: 1 })] }, { now: NOW });
  assert.strictEqual(r.code, 0, r.lines.join('\n'));
  const rows = readRows(sdir);
  assert.deepStrictEqual(['A', 'B', 'C'].map((t) => byTitle(rows, t).id), ['T-1', 'T-2', 'T-3']);
  assert.strictEqual(board.readNumbers(sdir).ultimo, 3);
});

test('T2 Save_FilaNueva_TomaElSiguienteAunqueSeHayaBorrado — @story-8.198 @ac-2', () => {
  const sdir = stateDir();
  board.save(sdir, { pendientes: Array.from({ length: 9 }, (_, i) => row(`F${i + 1}`, { orden: i })) }, { now: NOW });
  const kept = readRows(sdir).filter((r) => Number(r.id.slice(2)) <= 5);
  const r = board.save(sdir, { pendientes: [...kept, row('Nueva')] }, { now: NOW });
  assert.strictEqual(r.code, 0, r.lines.join('\n'));
  assert.strictEqual(byTitle(readRows(sdir), 'Nueva').id, 'T-10');
});

test('T3 Save_FilaConId_CambiaTitulo_ConservaId — @story-8.198 @ac-3', () => {
  const sdir = stateDir();
  board.save(sdir, { pendientes: [row('A'), row('B'), row('C'), row('D', { orden: 9 })] }, { now: NOW });
  const rows = readRows(sdir).map((r) => (r.id === 'T-4' ? { ...r, titulo: 'Otro', nota: 'x', estado: 'curso' } : r));
  assert.strictEqual(board.save(sdir, { pendientes: rows }, { now: NOW }).code, 0);
  assert.strictEqual(byTitle(readRows(sdir), 'Otro').id, 'T-4');
});

test('T4 Save_SinIdConTituloDeUnaQueSePerdio_LoRecupera — @story-8.198 @ac-4', () => {
  const sdir = stateDir();
  board.save(sdir, { pendientes: Array.from({ length: 7 }, (_, i) => row(i === 6 ? 'Arreglo X' : `F${i}`, { orden: i })) }, { now: NOW });
  const rest = readRows(sdir).filter((r) => r.id !== 'T-7');
  const r = board.save(sdir, { pendientes: [...rest, row('Arreglo X')] }, { now: NOW });
  assert.strictEqual(byTitle(readRows(sdir), 'Arreglo X').id, 'T-7');
  assert.match(r.lines.join('\n'), /recuper[^\n]*T-7/);
});

test('T5 Save_IdRepetido_NoEscribeYSale2 — @story-8.198 @ac-5', () => {
  const sdir = stateDir();
  board.save(sdir, { pendientes: [row('A'), row('B'), row('C', { orden: 5 })] }, { now: NOW });
  const before = fs.readFileSync(boardFile(sdir), 'utf8');
  const r = board.save(sdir, { pendientes: [row('A', { id: 'T-3' }), row('B', { id: 'T-3' })] }, { now: NOW });
  assert.strictEqual(r.code, 2);
  assert.strictEqual(fs.readFileSync(boardFile(sdir), 'utf8'), before);
  assert.match(r.lines.join('\n'), /T-3[^\n]*A|A[^\n]*T-3/);
  assert.match(r.lines.join('\n'), /B/);
});

test('T6 Save_IdMalFormadoOMasAltoQueElUltimo_Sale2 — @story-8.198 @ac-5', () => {
  const sdir = stateDir();
  board.save(sdir, { pendientes: Array.from({ length: 10 }, (_, i) => row(`F${i}`, { orden: i })) }, { now: NOW });
  const before = fs.readFileSync(boardFile(sdir), 'utf8');
  for (const id of ['X-3', 'T-99']) {
    const r = board.save(sdir, { pendientes: [row('A', { id })] }, { now: NOW });
    assert.strictEqual(r.code, 2, id);
    assert.strictEqual(fs.readFileSync(boardFile(sdir), 'utf8'), before, id);
  }
});

test('T7 Save_DosAlMismoTiempo_UnoEsperaOFalla — @story-8.198 @ac-6', async () => {
  const sdir = stateDir();
  board.save(sdir, { pendientes: [row('Base')] }, { now: NOW });
  const run = (titulo) => new Promise((resolve) => {
    const p = spawn(process.execPath, [BOARD_JS, 'add', `titulo=${titulo}`, 'estado=espera', 'grupo=Hoy', '--state-dir', sdir], { stdio: 'ignore' });
    p.on('exit', (code) => resolve(code));
  });
  const codes = await Promise.all(['Uno', 'Dos', 'Tres', 'Cuatro'].map(run));
  const rows = readRows(sdir);
  const ids = rows.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'ningún número repetido');
  assert.strictEqual(rows.length, 1 + codes.filter((c) => c === 0).length, 'un tablero entero');
  // una escritura a mano entre la lectura y el renombre: no escribe y lo dice
  const r = board.save(sdir, { pendientes: rows }, { now: NOW, beforeRename: () => fs.appendFileSync(boardFile(sdir), ' ') });
  assert.strictEqual(r.code, 2);
  assert.match(r.lines.join('\n'), /el tablero cambió mientras guardaba: volvé a correrlo/);
});

// ── El comando ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('T34 Board_Reglas_PedidoEstadoRealEstimada_NoEscribe — @story-8.198 @ac-35', () => {
  const cases = [
    [row('P', { pedido: { repo: 'acme/x', numero: '12a' } }), /pedido/],
    [row('E', { estado: 'pausa' }), /estado/],
    [row('H', { estado: 'hecho' }), /realIso/],
    [row('S', { estimadaIso: '2026-11-04T18:00' }), /estimadaIso/],
  ];
  for (const [bad, rule] of cases) {
    const sdir = stateDir();
    board.save(sdir, { pendientes: [row('Sana')] }, { now: NOW });
    const before = fs.readFileSync(boardFile(sdir), 'utf8');
    const r = board.save(sdir, { pendientes: [...readRows(sdir), bad] }, { now: NOW });
    assert.strictEqual(r.code, 2, bad.titulo);
    assert.strictEqual(fs.readFileSync(boardFile(sdir), 'utf8'), before, bad.titulo);
    assert.match(r.lines.join('\n'), new RegExp(`${bad.titulo}`));
    assert.match(r.lines.join('\n'), rule);
  }
});

test('T35 Board_AddSetClose_UnaFila — @story-8.198 @ac-35 @ac-36', () => {
  const sdir = stateDir();
  board.save(sdir, { pendientes: [row('A'), row('B'), row('C', { orden: 3 }), row('D', { orden: 4 })] }, { now: NOW });
  assert.strictEqual(cli(sdir, ['add', 'titulo=Nueva', 'estado=curso', 'grupo=Hoy']).code, 0);
  assert.strictEqual(byTitle(readRows(sdir), 'Nueva').id, 'T-5');
  assert.strictEqual(cli(sdir, ['set', 'T-3', 'nota=va bien']).code, 0);
  assert.strictEqual(readRows(sdir).find((r) => r.id === 'T-3').nota, 'va bien');
  assert.strictEqual(cli(sdir, ['close', 'T-3']).code, 0);
  const t3 = readRows(sdir).find((r) => r.id === 'T-3');
  assert.strictEqual(t3.estado, 'hecho');
  assert.match(t3.realIso, /^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
  assert.strictEqual(cli(sdir, ['close', '4', '--real', '2026-11-03T15:00']).code, 0);
  assert.strictEqual(readRows(sdir).find((r) => r.id === 'T-4').realIso, '2026-11-03T15:00');
  assert.strictEqual(cli(sdir, ['set', 'T-1', 'estado=pausa']).code, 2);
});

test('T36 Board_QuienSesionVivaSinNumero_GuardaYAvisa — @story-8.198 @ac-37', () => {
  const sdir = stateDir();
  board.save(sdir, { pendientes: [row('A'), row('B'), row('C'), row('D'), row('E', { orden: 5 })] }, { now: NOW });
  const rows = readRows(sdir).map((r) => (r.id === 'T-5' ? { ...r, estado: 'curso', quien: 'Sand' } : r));
  const r = board.save(sdir, { pendientes: rows }, { now: NOW, live: [{ nombre: 'Sand', texto: 'arreglo Y' }] });
  assert.strictEqual(r.code, 0);
  assert.match(r.lines.join('\n'), /Sand no dice T-5 en lo que hace: encargáselo con el número, o la fila se ve en Sin sesión/);
  const ok = board.save(sdir, { pendientes: rows }, { now: NOW, live: [{ nombre: 'Sand', texto: 'T-5 · arreglo' }] });
  assert.doesNotMatch(ok.lines.join('\n'), /no dice/);
});

test('T37 Board_Check_ValidaSinEscribir — @story-8.198 @ac-41', () => {
  const sdir = stateDir();
  board.save(sdir, { pendientes: [row('Sana')] }, { now: NOW });
  const sane = fs.readFileSync(boardFile(sdir), 'utf8');
  assert.strictEqual(cli(sdir, ['check']).code, 0);
  assert.strictEqual(fs.readFileSync(boardFile(sdir), 'utf8'), sane);
  const bad = { pendientes: [...readRows(sdir), row('Mala', { estado: 'pausa' })] };
  writeRaw(sdir, bad);
  const badText = fs.readFileSync(boardFile(sdir), 'utf8');
  const r = cli(sdir, ['check']);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /Mala[^\n]*estado/);
  assert.strictEqual(fs.readFileSync(boardFile(sdir), 'utf8'), badText);
});

// ── Se arma solo: sync ──────────────────────────────────────────────────────────────────────────────────────────────

const synced = (rows) => { const sdir = stateDir(); board.save(sdir, { pendientes: rows }, { now: NOW }); return sdir; };
const at = (h, m) => new Date(2026, 10, 4, h, m).getTime();

test('T41 Sync_SesionArrancaHistoria_FilaEnCursoOAgrega — @story-8.198 @ac-42', () => {
  const sdir = synced([row('Historia uno', { historia: '8.1' }), row('Siete', { orden: 7 }), row('a'), row('b'), row('c'), row('d'), row('e')]);
  const t7 = readRows(sdir).find((r) => r.titulo === 'Siete').id;
  const r = board.sync(sdir, [
    { tipo: 'curso', clave: 'curso:s1:1', historia: '8.1', quien: 'Pinola', at: at(9, 0) },
    { tipo: 'curso', clave: 'curso:s2:1', historia: '8.2', quien: 'Sand', titulo: 'Historia dos', at: at(9, 5) },
    { tipo: 'curso', clave: 'curso:s3:1', tarea: t7, quien: 'Funes', at: at(9, 6) },
  ], { complete: true, now: NOW });
  assert.strictEqual(r.code, 0, r.lines.join('\n'));
  const rows = readRows(sdir);
  assert.deepStrictEqual([byTitle(rows, 'Historia uno').estado, byTitle(rows, 'Historia uno').quien], ['curso', 'Pinola']);
  const nueva = rows.find((x) => x.historia === '8.2');
  assert.ok(nueva && /^T-\d+$/.test(nueva.id) && nueva.estado === 'curso' && nueva.quien === 'Sand' && nueva.titulo === 'Historia dos');
  assert.deepStrictEqual([byTitle(rows, 'Siete').estado, byTitle(rows, 'Siete').quien], ['curso', 'Funes']);
});

test('T42 Sync_SesionEsperaAlDueno_FilaEnFirmaYVuelve — @story-8.198 @ac-43', () => {
  const sdir = synced([row('H', { historia: '8.1', estado: 'curso', quien: 'Sand' })]);
  board.sync(sdir, [{ tipo: 'firma', clave: 'firma:s1:900', historia: '8.1', quien: 'Sand', at: at(9, 0) }], { complete: true, now: NOW });
  assert.strictEqual(readRows(sdir)[0].estado, 'firma');
  board.sync(sdir, [{ tipo: 'curso', clave: 'curso:s1:930', historia: '8.1', quien: 'Sand', at: at(9, 30) }], { complete: true, now: NOW });
  assert.strictEqual(readRows(sdir)[0].estado, 'curso');
  board.sync(sdir, [{ tipo: 'firma', clave: 'firma:s1:firma-registro', historia: '8.1', quien: 'Sand', at: at(9, 40) }], { complete: true, now: NOW });
  assert.strictEqual(readRows(sdir)[0].estado, 'firma');
});

test('T43 Sync_PedidoEntroAMain_HechoConLaHoraDelMerge — @story-8.198 @ac-44', () => {
  const sdir = synced([row('H', { estado: 'curso', pedido: { repo: 'acme/x', numero: 7 } })]);
  board.sync(sdir, [{ tipo: 'merge', clave: 'merge:acme/x#7', pedido: { repo: 'acme/x', numero: 7 }, at: at(10, 12) }], { complete: true, now: NOW });
  const r0 = readRows(sdir)[0];
  assert.deepStrictEqual([r0.estado, r0.realIso], ['hecho', '2026-11-04T10:12']);
});

test('T44 Sync_PedidoAbandonadoOEjecucionCortada_NotaYRiesgo — @story-8.198 @ac-45', () => {
  const sdir = synced([row('P', { estado: 'curso', pedido: { repo: 'acme/x', numero: 7 } }), row('C', { estado: 'curso', historia: '8.3', orden: 2 })]);
  board.sync(sdir, [
    { tipo: 'abandonado', clave: 'abandonado:acme/x#7', pedido: { repo: 'acme/x', numero: 7 }, at: at(9, 15) },
    { tipo: 'cortada', clave: 'cortada:s9:925', historia: '8.3', at: at(9, 25) },
  ], { complete: true, now: NOW });
  const rows = readRows(sdir);
  assert.deepStrictEqual([byTitle(rows, 'P').estado, byTitle(rows, 'P').nota], ['riesgo', 'pedido abandonado a las 09:15']);
  assert.deepStrictEqual([byTitle(rows, 'C').estado, byTitle(rows, 'C').nota], ['riesgo', 'la ejecución se cortó a las 09:25']);
});

test('T45 Sync_CorreccionAMano_NoSePisaSinHechoNuevo — @story-8.198 @ac-46', () => {
  const sdir = synced([row('H', { historia: '8.1' })]);
  const f1 = { tipo: 'curso', clave: 'curso:s1:900', historia: '8.1', quien: 'Sand', at: at(9, 0) };
  board.sync(sdir, [f1], { complete: true, now: NOW });
  assert.strictEqual(cli(sdir, ['set', 'T-1', 'estado=espera']).code, 0);
  board.sync(sdir, [f1], { complete: true, now: NOW });
  assert.strictEqual(readRows(sdir)[0].estado, 'espera', 'el mismo hecho no pisa la corrección');
  board.sync(sdir, [{ tipo: 'firma', clave: 'firma:s1:950', historia: '8.1', quien: 'Sand', at: at(9, 50) }], { complete: true, now: NOW });
  assert.strictEqual(readRows(sdir)[0].estado, 'firma', 'un hecho nuevo la mueve');
  // deja de esperar: vuelve a curso una sola vez, y un set posterior queda
  const back = { tipo: 'curso', clave: 'curso:s1:1000', historia: '8.1', quien: 'Sand', at: at(10, 0) };
  board.sync(sdir, [back], { complete: true, now: NOW });
  assert.strictEqual(readRows(sdir)[0].estado, 'curso');
  assert.strictEqual(cli(sdir, ['set', 'T-1', 'estado=firma']).code, 0);
  for (let i = 0; i < 3; i++) board.sync(sdir, [back], { complete: true, now: NOW });
  assert.strictEqual(readRows(sdir)[0].estado, 'firma');
});

test('T46 Sync_Limites_NoBorraNoCambiaTituloNiHoraNiReabre — @story-8.198 @ac-47', () => {
  const sdir = synced([
    row('Prometida', { historia: '8.1', pronosticoIso: '2026-11-04T18:00' }),
    row('Cerrada', { historia: '8.2', estado: 'hecho', realIso: '2026-11-03T12:00', orden: 2 }),
    row('Quieta', { orden: 3 }),
  ]);
  board.sync(sdir, [
    { tipo: 'curso', clave: 'curso:s1:1', historia: '8.1', quien: 'Sand', titulo: 'Otro título', at: at(9, 0) },
    { tipo: 'curso', clave: 'curso:s2:1', historia: '8.2', quien: 'Pinola', at: at(9, 0) },
  ], { complete: true, now: NOW });
  const rows = readRows(sdir);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual([byTitle(rows, 'Prometida').pronosticoIso, byTitle(rows, 'Prometida').estado], ['2026-11-04T18:00', 'curso']);
  assert.strictEqual(byTitle(rows, 'Cerrada').estado, 'hecho');
  assert.strictEqual(byTitle(rows, 'Quieta').estado, 'espera');
  const log = board.readFacts(sdir);
  assert.ok(log.some((e) => e.id === byTitle(rows, 'Prometida').id && e.clave === 'curso:s1:1'));
  assert.match(board.lastFactLine(sdir, byTitle(rows, 'Prometida').id), /curso:s1:1/);
});

test('T47 Sync_TableroSinNumerosORoto_NoEscribeYAvisa — @story-8.198 @ac-48', () => {
  for (const raw of [{ pendientes: [row('Sin número', { historia: '8.1' })] }, { pendientes: [row('Vieja', { historia: '8.1', id: 'T-1', estimadaIso: '2026-11-04T18:00' })] }]) {
    const sdir = stateDir();
    writeRaw(sdir, raw);
    const before = fs.readFileSync(boardFile(sdir), 'utf8');
    const r = board.sync(sdir, [{ tipo: 'curso', clave: 'curso:s1:1', historia: '8.1', quien: 'Sand', at: at(9, 0) }], { complete: true, now: NOW });
    assert.strictEqual(fs.readFileSync(boardFile(sdir), 'utf8'), before);
    assert.strictEqual(r.written, false);
    assert.match(r.aviso, /board\.js check/);
  }
});

test('T54 Sync_LecturaIncompleta_NoAplicaHechosPorFalta — @story-8.198 @ac-57', () => {
  const sdir = synced([
    row('Firma', { historia: '8.1', estado: 'firma', quien: 'Sand' }),
    row('Pedido', { estado: 'curso', pedido: { repo: 'acme/x', numero: 7 }, orden: 2 }),
    row('Corte', { historia: '8.3', estado: 'curso', orden: 3 }),
    row('Arranca', { historia: '8.4', orden: 4 }),
  ]);
  board.sync(sdir, [
    { tipo: 'curso', clave: 'curso:s1:1', historia: '8.1', quien: 'Sand', at: at(9, 0) },
    { tipo: 'abandonado', clave: 'abandonado:acme/x#7', pedido: { repo: 'acme/x', numero: 7 }, at: at(9, 0) },
    { tipo: 'cortada', clave: 'cortada:s3:1', historia: '8.3', at: at(9, 0) },
    { tipo: 'curso', clave: 'curso:s4:1', historia: '8.4', quien: 'Funes', at: at(9, 0) },
  ], { complete: false, now: NOW });
  const rows = readRows(sdir);
  assert.deepStrictEqual(['Firma', 'Pedido', 'Corte', 'Arranca'].map((t) => byTitle(rows, t).estado), ['firma', 'curso', 'curso', 'curso']);
});

test('T55 Sync_VariasFilasOVariosPedidos_UnaSolaYElUltimo — @story-8.198 @ac-58', () => {
  const sdir = synced([
    row('Vieja', { historia: '8.1', orden: 1 }), row('Nueva', { historia: '8.1', orden: 2 }),
    row('Hecha', { historia: '8.2', estado: 'hecho', realIso: '2026-11-03T10:00', orden: 3 }),
    row('Sin ancla', { orden: 4 }),
  ]);
  board.sync(sdir, [
    { tipo: 'curso', clave: 'curso:s1:1', historia: '8.1', quien: 'Sand', at: at(9, 0) },
    { tipo: 'curso', clave: 'curso:s2:1', historia: '8.2', quien: 'Pinola', at: at(9, 0) },
  ], { complete: true, now: NOW });
  let rows = readRows(sdir);
  assert.deepStrictEqual([byTitle(rows, 'Vieja').estado, byTitle(rows, 'Nueva').estado], ['curso', 'espera']);
  assert.strictEqual(rows.filter((x) => x.historia === '8.2').length, 1, 'con todas hechas no agrega');
  assert.strictEqual(byTitle(rows, 'Sin ancla').estado, 'espera');
  // dos pedidos de la misma fila: hecho sólo con los dos entrados, con la hora del último
  const s2 = synced([row('Dos pedidos', { historia: '8.5', estado: 'curso' })]);
  const facts = board.mergeFacts([{ historia: '8.5', pedidos: [{ repo: 'acme/x', numero: 1, state: 'merged', mergedAt: at(9, 0) }, { repo: 'acme/y', numero: 2, state: 'open' }] }]);
  board.sync(s2, facts, { complete: true, now: NOW });
  assert.strictEqual(readRows(s2)[0].estado, 'curso');
  const both = board.mergeFacts([{ historia: '8.5', pedidos: [{ repo: 'acme/x', numero: 1, state: 'merged', mergedAt: at(9, 0) }, { repo: 'acme/y', numero: 2, state: 'merged', mergedAt: at(9, 45) }] }]);
  board.sync(s2, both, { complete: true, now: NOW });
  rows = readRows(s2);
  assert.deepStrictEqual([rows[0].estado, rows[0].realIso], ['hecho', '2026-11-04T09:45']);
});

test('T56 Sync_YAdd_ALaVez_NoDuplicaLaFila — @story-8.198 @ac-47 @ac-58', async () => {
  const sdir = synced([row('Otra')]);
  const factFile = path.join(sdir, 'hechos.json');
  fs.writeFileSync(factFile, JSON.stringify([{ tipo: 'curso', clave: 'curso:s1:1', historia: '8.9', quien: 'Sand', titulo: 'Historia nueve', at: at(9, 0) }]));
  const go = (args) => new Promise((resolve) => { const p = spawn(process.execPath, [BOARD_JS, ...args, '--state-dir', sdir], { stdio: 'ignore' }); p.on('exit', resolve); });
  await Promise.all([go(['sync', '--facts', factFile, '--complete']), go(['add', 'titulo=Historia nueve', 'historia=8.9', 'estado=curso', 'grupo=Hoy'])]);
  assert.strictEqual(readRows(sdir).filter((r) => r.historia === '8.9').length, 1);
});
