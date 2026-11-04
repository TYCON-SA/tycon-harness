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

test('T47 Server_DespuesDeLaFoto_LlamaASyncSinPreguntarDeNuevo (un tablero sin números o roto) — @story-8.198 @ac-48', () => {
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

// ── La oficina: el número, la fila que no se esconde, la búsqueda, la línea de arriba y la mano ─────────────────────

const OFFICE = path.join(__dirname, '..', 'tools', 'office.js');
const office = require(OFFICE);
const { buildOffice, buildBoard } = office;
const ONOW = Date.parse('2026-11-04T14:00:00.000Z');

// A /wip result with one row per entry, as office.test.js builds it.
function wip(entries, more = {}) {
  return {
    rows: entries.map((e) => ({ work: e.work || `Story ${e.session}`, state: e.state || 'en curso', end: e.end || '15:00', session: e.session, folder: 'repo-a', ...(e.meanwhile ? { meanwhile: e.meanwhile } : {}) })),
    details: entries.map((e) => ({ sid: e.sid || `sid-${e.session}`, status: 'status' in e ? e.status : 'busy', statusAt: e.statusAt || null })),
    extra: entries.map((e) => e.extra || { kind: 'loose' }),
    free: [], halfway: [], unreadable: [],
    ...more,
  };
}
const kcol = (data, id) => data.kanban.columnas.find((c) => c.id === id);
const cards = (data) => data.kanban.columnas.flatMap((c) => c.tarjetas.map((t) => ({ ...t, col: c.id })));
const numbered = (rows) => buildBoard({ pendientes: rows.map((r, i) => ({ estado: 'espera', grupo: 'Hoy', orden: i, id: `T-${i + 1}`, ...r })) });

test('T8 Office_FilaSinNumero_SinNumeroYAvisoUnaVez — @story-8.198 @ac-7', () => {
  const b = buildBoard({ pendientes: [{ titulo: 'Una', estado: 'espera' }, { titulo: 'Dos', estado: 'espera' }, { titulo: 'Tres', estado: 'espera', id: 'T-3' }] });
  assert.deepStrictEqual(b.filas.map((f) => f.numero), [null, null, 'T-3']);
  const avisos = b.avisos.filter((a) => /sin número/.test(a));
  assert.strictEqual(avisos.length, 1);
  assert.match(avisos[0], /board\.js save --from/);
  const { data } = buildOffice({ wip: wip([]), board: b, nowMs: ONOW });
  assert.strictEqual(cards(data).find((c) => c.titulo === 'Una').numero, 'sin número');
  assert.strictEqual(cards(data).find((c) => c.titulo === 'Tres').numero, 'T-3');
});

test('T9 Kanban_QuienEsSesionVivaQueHaceOtraCosa_LaFilaSeVe — @story-8.198 @ac-8', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Sand', extra: { kind: 'loose', text: 'arreglo Y' } }]), board: numbered([{ titulo: 'Arreglo de Sand', estado: 'curso', quien: 'Sand', nota: 'lo pidió el dueño' }]), nowMs: ONOW });
  const c = kcol(data, 'sinEmpezar').tarjetas.find((t) => t.titulo === 'Arreglo de Sand');
  assert.ok(c, 'la fila tiene su tarjeta en Sin sesión');
  assert.deepStrictEqual([c.numero, c.nota], ['T-1', 'lo pidió el dueño']);
});

test('T28 Kanban_FirmaYEntrando_QuienEsSesionViva_LaFilaSeVe — @story-8.198 @ac-8', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Sand', extra: { kind: 'loose', text: 'arreglo Y' } }]), board: numbered([{ titulo: 'Firma suelta', estado: 'firma', quien: 'Sand' }, { titulo: 'Entra', estado: 'entrando', quien: 'Sand' }]), nowMs: ONOW });
  assert.ok(kcol(data, 'firma').tarjetas.some((t) => t.titulo === 'Firma suelta' && t.numero === 'T-1'));
  assert.ok(kcol(data, 'entrando').tarjetas.some((t) => t.titulo === 'Entra' && t.numero === 'T-2'));
});

test('T10 Kanban_SesionMencionaElNumero_UnaSolaTarjeta — @story-8.198 @ac-9', () => {
  const rows = Array.from({ length: 41 }, (_, i) => ({ titulo: `Fila ${i + 1}`, estado: 'hecho', realIso: '2026-11-01T10:00' }));
  rows[40] = { titulo: 'Arreglo X', estado: 'curso', quien: 'Sand', nota: 'la nota de la fila' };
  const { data } = buildOffice({ wip: wip([{ session: 'Sand', extra: { kind: 'loose', text: 'T-41 · arreglo X' } }]), board: numbered(rows), nowMs: ONOW });
  const with41 = cards(data).filter((c) => c.numero === 'T-41');
  assert.strictEqual(with41.length, 1, 'una sola tarjeta');
  assert.strictEqual(with41[0].quien, 'Sand');
  assert.strictEqual(with41[0].nota, 'la nota de la fila');
});

test('T11 Kanban_FilaConHistoriaYEjecucion_LaEjecucionLlevaElNumero — @story-8.198 @ac-10', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Ana', work: '8.1 · Una', extra: { kind: 'pipeline', title: 'Una', storyId: '8.1', current: 'implement', endAt: ONOW + 3600000 } }]), board: numbered([{ titulo: 'La historia', historia: '8.1', estado: 'curso' }]), nowMs: ONOW });
  const run = cards(data).filter((c) => c.numero === 'T-1');
  assert.strictEqual(run.length, 1);
  assert.strictEqual(run[0].quien, 'Ana');
});

test('T12 Kanban_DosSesionesMismoNumero_LasDosLoLlevan — @story-8.198 @ac-11', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Sand', extra: { kind: 'loose', text: 'T-1 parte uno' } }, { session: 'Pinola', extra: { kind: 'loose', text: 'parte dos de T-1' } }]), board: numbered([{ titulo: 'Grande', estado: 'curso' }]), nowMs: ONOW });
  const with1 = cards(data).filter((c) => c.numero === 'T-1');
  assert.deepStrictEqual(with1.map((c) => c.quien).sort(), ['Pinola', 'Sand']);
  assert.ok(!cards(data).some((c) => c.titulo === 'Grande' && c.col === 'sinEmpezar'));
});

test('T13 Kanban_CambioDeTitulo_ConservaTemaYPedido — @story-8.198 @ac-12', () => {
  const topics = require(path.join(__dirname, '..', 'tools', 'office', 'topics.js'));
  assert.strictEqual(topics.workKey({ tarea: 'T-5', titulo: 'Lo que sea' }), 'tarea:t-5');
  // el pedido recordado por número sigue con otro título; uno recordado por el título viejo vale de respaldo
  const memory = { filas: { 'tarea:t-5': { repo: 'acme/x', numero: 9 }, [topics.workKey({ titulo: 'Título viejo' })]: { repo: 'acme/y', numero: 3 } }, sesiones: {} };
  const b = numbered([{ titulo: 'a' }, { titulo: 'b' }, { titulo: 'c' }, { titulo: 'Título viejo' }, { titulo: 'Título nuevo' }]);
  office.applyRowPrs(b, memory);
  assert.deepStrictEqual(b.filas[4].recordado, { repo: 'acme/x', numero: 9 });
  assert.deepStrictEqual(b.filas[3].recordado, { repo: 'acme/y', numero: 3 });
});

test('T29 Kanban_TarjetaUnida_CambioDeTitulo_ConservaTema — @story-8.198 @ac-9 @ac-12', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Sand', extra: { kind: 'loose', text: 'T-1 arreglo' } }]), board: numbered([{ titulo: 'Un título nuevo', estado: 'curso', tema: 'El tema' }]), nowMs: ONOW });
  const raw = data.kanban.columnas.flatMap((c) => c.tarjetas).find((c) => c.quien === 'Sand');
  assert.strictEqual(raw.clave, 'tarea:t-1');
  assert.strictEqual(raw.tema, 'El tema');
});

test('T14 Kanban_NumeroEnTarjetaTablaYDetalle — @story-8.198 @ac-13', () => {
  const { data } = buildOffice({ wip: wip([]), board: numbered([{ titulo: 'Con número', estado: 'espera' }]), nowMs: ONOW });
  assert.strictEqual(cards(data).find((c) => c.titulo === 'Con número').numero, 'T-1');
  assert.match(JSON.stringify(office.buildTables({ kanban: data.kanban, nowMs: ONOW })), /"numero":"T-1"/);
  // la página lo pinta en la tarjeta del kanban, en los trabajos de la tabla y arriba del detalle
  const code = fs.readFileSync(path.join(__dirname, '..', 'tools', 'office', 'page.js'), 'utf8');
  assert.match(code, /function numeroDe\(/);
  assert.match(code, /function abrirTarjeta[^\n]*numeroDe\(/);
});

test('T15 Task_Existe_UnaLineaYSale0 — @story-8.198 @ac-14', () => {
  const { data } = buildOffice({ wip: wip([]), board: numbered([{ titulo: 'Primera' }, { titulo: 'Segunda', quien: 'Sand', nota: 'va', pedido: { repo: 'acme/x', numero: 4 } }]), nowMs: ONOW });
  const r = office.findTask(data, 'T-2', { dados: { 'T-1': 'Primera', 'T-2': 'Segunda' } });
  assert.strictEqual(r.code, 0);
  assert.match(r.line, /^T-2 · Sin sesión · Segunda · Sand · [^·]+ · va · pedido acme\/x#4$/);
  assert.strictEqual(office.findTask(data, '1', {}).card.titulo, 'Primera');
});

test('T16 Task_NoExisteOBorrada_Sale1ConMotivo — @story-8.198 @ac-15', () => {
  const { data } = buildOffice({ wip: wip([]), board: numbered([{ titulo: 'Primera' }]), nowMs: ONOW });
  const nunca = office.findTask(data, 'T-99', { dados: { 'T-1': 'Primera' } });
  assert.deepStrictEqual([nunca.code, /no está en el tablero/.test(nunca.line)], [1, true]);
  const borrada = office.findTask(data, 'T-3', { dados: { 'T-1': 'Primera', 'T-3': 'Vieja' } });
  assert.deepStrictEqual([borrada.code, /se borró del tablero/.test(borrada.line)], [1, true]);
});

test('T24 Kanban_EnCurso_OrdenPorHoraDeFin — @story-8.198 @ac-25', () => {
  const h = (hh, mm) => new Date(2026, 10, 4, hh, mm).getTime();
  const now = h(18, 20);
  const { data } = buildOffice({
    wip: wip([
      { session: 'A', work: 'a', extra: { kind: 'note', text: 'la de las diecinueve', endAt: h(19, 30) } },
      { session: 'B', work: 'b', extra: { kind: 'note', text: 'la que pasó su hora', endAt: h(18, 0) } },
      { session: 'C', work: 'c', extra: { kind: 'note', text: 'la que no tiene hora' } },
      { session: 'D', work: 'd', extra: { kind: 'note', text: 'la de las dieciocho', endAt: h(18, 45) } },
    ]),
    nowMs: now,
  });
  assert.deepStrictEqual(kcol(data, 'curso').tarjetas.map((t) => t.quien), ['B', 'D', 'A', 'C']);
  const hoy = office.buildTables({ kanban: data.kanban, nowMs: now }).hoy;
  const quienes = hoy.filas.flatMap((f) => f.trabajos.map((w) => w.quien)).filter((q) => ['A', 'B', 'C', 'D'].includes(q));
  assert.deepStrictEqual(quienes, ['B', 'D', 'A', 'C']);
});

test('T25 Kanban_LineaDeArriba_SeArmaDeLasTarjetas — @story-8.198 @ac-26', () => {
  const primera = { titulo: 'Lo primero', numero: 'T-52', quien: 'Sand', hora: 'mié 19:30' };
  const kanban = { columnas: [{ id: 'curso', tarjetas: [primera, { titulo: 'Otra', quien: 'Pinola', hora: 'sin hora' }] }, { id: 'firma', tarjetas: [{ titulo: 'x' }, { titulo: 'y' }] }] };
  const line = office.boardLine(kanban, { trabado: [{ filas: ['a'] }], escritoAt: new Date(2026, 10, 4, 16, 29).getTime(), hourOf: (c) => (c === primera ? 1 : undefined) });
  assert.strictEqual(line, 'Sale primero: T-52 Lo primero · Sand · mié 19:30 · Tu firma: 2 · Trabado: 1 · Tablero escrito a las 16:29');
});

test('T26 Kanban_LineaDeArriba_SinHoraEnCurso — @story-8.198 @ac-27', () => {
  const kanban = { columnas: [{ id: 'curso', tarjetas: [{ titulo: 'Sin hora', quien: 'Sand', hora: 'sin hora estimada' }] }, { id: 'firma', tarjetas: [] }] };
  assert.strictEqual(office.boardLine(kanban, { trabado: [], escritoAt: null, hourOf: () => undefined }), 'Nada con hora en curso · Tu firma: 0 · Trabado: 0');
});

test('T27 Kanban_MetaResumen_NoSeMuestra — @story-8.198 @ac-28', () => {
  const b = buildBoard({ pendientes: [{ titulo: 'Una', estado: 'espera', id: 'T-1' }], meta: { resumen: 'UN RESUMEN VIEJO', teToca: ['firmar algo'] } });
  assert.ok(!('resumen' in b));
  assert.deepStrictEqual(b.teToca, ['firmar algo']);
  const { data } = buildOffice({ wip: wip([]), board: b, nowMs: ONOW });
  assert.ok(!JSON.stringify(data).includes('UN RESUMEN VIEJO'));
  assert.ok(!/t\.resumen/.test(fs.readFileSync(path.join(__dirname, '..', 'tools', 'office', 'page.js'), 'utf8')));
});

test('T40 Office_TableroCambiadoSinElComando_AvisaUnaVez — @story-8.198 @ac-40', () => {
  const sdir = stateDir();
  board.save(sdir, { pendientes: [row('Una')] }, { now: NOW });
  assert.strictEqual(office.boardEditedNotice(sdir), null, 'con la huella igual, nada');
  fs.appendFileSync(boardFile(sdir), ' ');
  assert.match(office.boardEditedNotice(sdir), /^el tablero se editó fuera del comando a las \d\d:\d\d: corré board\.js check$/);
});

test('T47 Server_DespuesDeLaFoto_LlamaASyncSinPreguntarDeNuevo — @story-8.198 @ac-48', () => {
  // los hechos salen de la foto, sin otra consulta: la sesión con su historia y el pedido de la fila que ya contestó
  const b = numbered([{ titulo: 'La historia', historia: '8.1' }, { titulo: 'Con pedido', estado: 'curso', pedido: { repo: 'acme/x', numero: 7 } }]);
  const prAnswers = new Map([['acme/x#7', { pr: { state: 'merged', mergedAt: '2026-11-04T13:12:00Z' } }]]);
  const r = buildOffice({ wip: wip([{ session: 'Ana', work: '8.1 · Una', extra: { kind: 'pipeline', title: 'Una', storyId: '8.1', current: 'implement', endAt: ONOW + 3600000 } }]), board: b, prAnswers, nowMs: ONOW });
  assert.ok(r.facts.some((f) => f.tipo === 'curso' && f.historia === '8.1' && f.quien === 'Ana'));
  assert.ok(r.facts.some((f) => f.tipo === 'merge' && f.tarea === 'T-2' && f.at === Date.parse('2026-11-04T13:12:00Z')));
  assert.strictEqual(r.factsComplete, true);
  // sin la respuesta de un pedido, la lectura no está completa
  assert.strictEqual(buildOffice({ wip: wip([]), board: b, prAnswers: new Map(), nowMs: ONOW }).factsComplete, false);
  // el proceso de la oficina lo pide en cada foto; un sync que tira no corta la foto: queda un aviso
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'tools', 'office', 'server.js'), 'utf8'), /office\.collect\(\{[^\n]*syncBoard: true/);
  const problems = [];
  office.syncBoardFromPhoto('/no/importa', [], true, problems, { sync: () => { throw new Error('roto'); } });
  assert.deepStrictEqual(problems, ['el tablero no se movió solo: roto']);
});

test('T33 Ventanas_LasCuatro_XArribaYSinCerrarAbajo — @story-8.198 @ac-32', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'tools', 'office', 'page.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'tools', 'office', 'page.html'), 'utf8');
  // el detalle y la conversación usan la misma X; el panel de la persona y el de «Pendientes», la suya, con la misma etiqueta
  assert.match(code, /function botonCerrar\(alCerrar\)\{const b=el\("button","close","×"\);b\.type="button";b\.setAttribute\("aria-label","Cerrar"\)/);
  assert.match(code, /function abrirTarjeta[\s\S]*?const cerrar=botonCerrar\(cerrarCharla\)/);
  assert.match(code, /function abrirCharla[\s\S]*?const cerrar=botonCerrar\(cerrarCharla\)/);
  assert.match(code, /panel\.innerHTML='<button class="close" type="button" aria-label="Cerrar">×<\/button>/);
  assert.match(code, /mk\("button","close","×"\);cl\.type="button";cl\.setAttribute\("aria-label","Cerrar"\)/);
  // ningún botón con el texto «Cerrar»: abajo no queda ninguno
  assert.doesNotMatch(code, /el\("button",[^)]*,"Cerrar"\)/);
  assert.doesNotMatch(code, /mk\("button",[^)]*,"Cerrar"\)/);
  // la X va arriba a la derecha en las cuatro: las dos ventanas son .panel3, como los paneles
  assert.match(html, /\.panel3 \.close\{position:absolute;right:8px;top:6px/);
  assert.match(html, /<div class="ventana" id="ventana" hidden><div class="panel3"/);
});

// ── Modelo y esfuerzo de cada sesión ────────────────────────────────────────────────────────────────────────────

const { readSessionTokens } = require(path.join(__dirname, '..', 'lib', 'session-transcript.js'));
// una conversación de Claude de juguete: cada respuesta con su modelo y su esfuerzo
function claudeTalk(answers) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'charla-')), 's.jsonl');
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  fs.writeFileSync(f, answers.map((a, i) => JSON.stringify({ type: 'assistant', uuid: `u${i}`, isSidechain: Boolean(a.agente), ...(a.effort !== undefined ? { effort: a.effort } : {}), ...(a.perTurnEffort !== undefined ? { perTurnEffort: a.perTurnEffort } : {}), message: { id: `m${i}`, model: a.model, usage } })).join('\n') + (answers.length ? '\n' : ''));
  return f;
}
const said = (file) => { const c = office.tokensCard(readSessionTokens(file, new Map(), {})); return `${c.modelo} · ${c.esfuerzo}`; };

test('T17 Transcript_UltimaRespuesta_ModeloYEsfuerzo — @story-8.198 @ac-17', () => {
  const words = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  for (const [k, w] of Object.entries(words)) assert.strictEqual(said(claudeTalk([{ model: 'claude-opus-5-5', perTurnEffort: k, effort: k }])), `Opus 5.5 · ${w}`);
});

test('T18 Transcript_EffortNullPerTurnEffortSi_UsaElQueHay — @story-8.198 @ac-17', () => {
  assert.strictEqual(said(claudeTalk([{ model: 'claude-opus-5-5', effort: null, perTurnEffort: 'medium' }])), 'Opus 5.5 · Medium');
  assert.strictEqual(said(claudeTalk([{ model: 'claude-opus-5-5', effort: 'low' }])), 'Opus 5.5 · Low');
});

test('T19 Transcript_CambioAMitad_ValeLaUltimaRespuesta — @story-8.198 @ac-18', () => {
  assert.strictEqual(said(claudeTalk([{ model: 'claude-opus-5', perTurnEffort: 'high' }, { model: 'claude-opus-5-5', perTurnEffort: 'low' }])), 'Opus 5.5 · Low');
  // la oficina viva lee lo nuevo de la conversación: un cambio después de la primera lectura se ve
  const f = claudeTalk([{ model: 'claude-opus-5-5', perTurnEffort: 'high' }]);
  const counts = new Map();
  assert.strictEqual(office.tokensCard(readSessionTokens(f, counts, {})).esfuerzo, 'High');
  fs.appendFileSync(f, `${JSON.stringify({ type: 'assistant', uuid: 'u9', perTurnEffort: 'low', message: { id: 'm9', model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 1 } } })}\n`);
  const c = office.tokensCard(readSessionTokens(f, counts, {}));
  assert.deepStrictEqual([c.modelo, c.esfuerzo], ['Sonnet 5.5', 'Low']);
});

test('T20 Transcript_SinRespuestaOSinteticoOSinEsfuerzo_SinDato — @story-8.198 @ac-19', () => {
  assert.strictEqual(said(claudeTalk([])), 'sin dato · sin dato');
  assert.strictEqual(said(claudeTalk([{ model: '<synthetic>', perTurnEffort: 'high' }])), 'sin dato · sin dato');
  assert.strictEqual(said(claudeTalk([{ model: 'claude-opus-5-5', perTurnEffort: 'high' }, { model: '<synthetic>', perTurnEffort: 'low' }])), 'Opus 5.5 · High');
  assert.strictEqual(said(claudeTalk([{ model: 'claude-opus-5-5' }])), 'Opus 5.5 · sin dato');
  // el valor de la máquina (settings.json con effortLevel) nunca completa lo que falta: la lectura no lo mira
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-transcript.js'), 'utf8');
  assert.doesNotMatch(src, /effortLevel/);
});

test('T21 Transcript_Codex_ModeloDelTurnoYEsfuerzoVacioSinDato — @story-8.198 @ac-20', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-')), 'r.jsonl');
  const tc = (effort) => JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort } });
  const tokens = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5, output_tokens: 2 }, last_token_usage: { input_tokens: 5 }, model_context_window: 1000 } } });
  fs.writeFileSync(f, `${tc(null)}\n${tokens}\n`);
  const counts = new Map();
  let c = office.tokensCard(readSessionTokens(f, counts, {}));
  assert.deepStrictEqual([c.modelo, c.esfuerzo], ['gpt-6.1-sol', 'sin dato']);
  fs.appendFileSync(f, `${tc('medium')}\n`);
  c = office.tokensCard(readSessionTokens(f, counts, {}));
  assert.deepStrictEqual([c.modelo, c.esfuerzo], ['gpt-6.1-sol', 'Medium']);
});

test('T22 Transcript_Agentes_NoCuentan — @story-8.198 @ac-21', () => {
  assert.strictEqual(said(claudeTalk([{ model: 'claude-opus-5-5', perTurnEffort: 'high' }, { model: 'claude-haiku-5-5', perTurnEffort: 'low', agente: true }])), 'Opus 5.5 · High');
});

test('T23 Transcript_SufijoYModeloDesconocido — @story-8.198 @ac-22', () => {
  assert.strictEqual(said(claudeTalk([{ model: 'claude-opus-5-5[1m]', perTurnEffort: 'max' }])), 'Opus 5.5 (1M) · Max');
  assert.strictEqual(said(claudeTalk([{ model: 'claude-nuevo-9', perTurnEffort: 'low' }])), 'claude-nuevo-9 · Low');
  assert.strictEqual(said(claudeTalk([{ model: 'claude-fable-5-1', perTurnEffort: 'low' }])), 'Fable 5.1 · Low');
});

// ── Las sesiones cerradas, aparte ───────────────────────────────────────────────────────────────────────────────

// la conversación de la coordinadora con tres sesiones: Sand y Pinola viven; Funes, cerrada, habló último
function coordinatorWith(sessions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-'));
  const file = path.join(dir, 'c.jsonl');
  fs.writeFileSync(file, '');
  const env = { files: new Map([['Coordinadora', { file, sid: 'c1' }], ...sessions.map((n) => [n, { file, sid: n }])]), coordinator: { sid: 'c1', name: 'Coordinadora' } };
  return env;
}
const CHARLA = { conVos: [], conSesiones: [
  { sesion: 'Funes', at: Date.parse('2026-11-04T13:30:00Z'), mensajes: [{ de: 'Funes', texto: 'listo', at: 1 }] },
  { sesion: 'Sand', at: Date.parse('2026-11-04T13:20:00Z'), mensajes: [] },
  { sesion: 'Pinola', at: Date.parse('2026-11-04T13:10:00Z'), mensajes: [] },
  { sesion: 'Olvido', at: Date.parse('2026-11-04T13:00:00Z'), mensajes: [] },
] };

test('T30 ConSesiones_VivasPrimeroLuegoCerradas — @story-8.198 @ac-29', () => {
  const env = coordinatorWith(['Sand', 'Pinola']);
  const r = office.markClosedSessions(JSON.parse(JSON.stringify(CHARLA)), env, { lastActivityOf: () => null });
  assert.deepStrictEqual(r.conSesiones.map((s) => [s.sesion, Boolean(s.cerrada)]), [['Sand', false], ['Pinola', false], ['Funes', true], ['Olvido', true]]);
  // la página: las vivas, la línea «Cerradas» y las cerradas en gris
  const code = fs.readFileSync(path.join(__dirname, '..', 'tools', 'office', 'page.js'), 'utf8');
  assert.match(code, /function charlaPorSesion[\s\S]*?"Cerradas"/);
  assert.match(code, /"cerrada"/);
});

test('T31 ConSesiones_Cerrada_UltimaActividadOSinHora — @story-8.198 @ac-30', () => {
  const env = coordinatorWith(['Sand']);
  const at = new Date(2026, 10, 4, 10, 25).getTime();
  const r = office.markClosedSessions(JSON.parse(JSON.stringify(CHARLA)), env, { lastActivityOf: (n) => (n === 'Funes' ? at : null) });
  const funes = r.conSesiones.find((s) => s.sesion === 'Funes');
  const olvido = r.conSesiones.find((s) => s.sesion === 'Olvido');
  assert.strictEqual(funes.ultimaActividad, at);
  assert.strictEqual(olvido.ultimaActividad, null);
  const code = fs.readFileSync(path.join(__dirname, '..', 'tools', 'office', 'page.js'), 'utf8');
  assert.match(code, /"última actividad "/);
  assert.match(code, /"cerrada, sin hora"/);
  assert.doesNotMatch(code, /cerró a las/);
  // la hora sale del último renglón de su conversación, buscada por su nombre en las sesiones de fondo
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
  const jobs = path.join(home, '.claude', 'jobs');
  const talk = path.join(home, 'funes.jsonl');
  fs.writeFileSync(talk, `${JSON.stringify({ type: 'user', timestamp: '2026-11-04T13:00:00.000Z' })}\n${JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T13:25:00.000Z' })}\n`);
  for (const [id, updatedAt, file] of [['a', '2026-11-03T10:00:00Z', '/no/esta.jsonl'], ['b', '2026-11-04T13:26:00Z', talk]]) {
    fs.mkdirSync(path.join(jobs, id), { recursive: true });
    fs.writeFileSync(path.join(jobs, id, 'state.json'), JSON.stringify({ name: 'Funes', updatedAt, linkScanPath: file }));
  }
  assert.strictEqual(office.closedSessionLastAt(home, 'Funes'), Date.parse('2026-11-04T13:25:00.000Z'));
  assert.strictEqual(office.closedSessionLastAt(home, 'Nadie'), null);
});

test('T32 ConSesiones_ElegirCerrada_DiceQueNoRecibe — @story-8.198 @ac-31', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'tools', 'office', 'page.js'), 'utf8');
  assert.match(code, /"Esta sesión está cerrada: no recibe mensajes\."/);
  // la conversación con la sesión cerrada se lee igual: sus mensajes siguen
  const env = coordinatorWith([]);
  const r = office.markClosedSessions(JSON.parse(JSON.stringify(CHARLA)), env, { lastActivityOf: () => null });
  assert.deepStrictEqual(r.conSesiones.find((s) => s.sesion === 'Funes').mensajes, [{ de: 'Funes', texto: 'listo', at: 1 }]);
});

// ── Lo que viaja al sitio ───────────────────────────────────────────────────────────────────────────────────────

test('T51 Sitio_Campos_NumeroModeloEsfuerzoMano — @story-8.198 @ac-55', () => {
  const { pick } = require(path.join(__dirname, '..', 'tools', 'office', 'fields.js'));
  const foto = {
    agents: [{ nombre: 'Sand', estado: 'esperando', mano: 'coordinadora', manoEtiqueta: 'Espera a la Coordinadora', manoPor: 'Espera la Coordinadora', modelo: 'Opus 5.5', esfuerzo: 'High', secreto: 'no viaja' }],
    kanban: { linea: 'Sale primero: T-52 Algo · Sand · 19:30', columnas: [{ id: 'curso', nombre: 'En curso', tarjetas: [{ titulo: 'Algo', numero: 'T-52', quien: 'Sand', hora: '19:30', mano: 'coordinadora' }] }] },
  };
  const sent = pick(JSON.parse(JSON.stringify(foto)), '/home/nadie');
  const a = sent.agents[0];
  assert.deepStrictEqual([a.mano, a.manoEtiqueta, a.manoPor, a.modelo, a.esfuerzo], ['coordinadora', 'Espera a la Coordinadora', 'Espera la Coordinadora', 'Opus 5.5', 'High']);
  assert.ok(!('secreto' in a), 'lo que no está en la lista no viaja');
  const t = sent.kanban.columnas[0].tarjetas[0];
  assert.deepStrictEqual([t.numero, t.mano, sent.kanban.linea], ['T-52', 'coordinadora', 'Sale primero: T-52 Algo · Sand · 19:30']);
  // una mano de una sesión de otro proyecto no saca el título de su firma
  const { data } = buildOffice({ wip: wip([{ session: 'Sand', sid: 'sid-sand', extra: { kind: 'loose', text: 'trabaja' } }]), signatures: [{ id: 'f1', tipo: 'firma', destino: 'sid-sand', title: 'el título secreto', at: ONOW }], otherProjects: new Set(['sid-sand']), nowMs: ONOW });
  assert.strictEqual(data.agents.find((x) => x.nombre === 'Sand').manoPor, 'Otro proyecto');
});

test('T52 Sitio_TarjetaLocalIgualALaDelSitio — @story-8.198 @ac-56', () => {
  const { pick } = require(path.join(__dirname, '..', 'tools', 'office', 'fields.js'));
  const { data } = buildOffice({
    wip: wip([
      { session: 'Sand', sid: 'sid-sand', status: 'idle', extra: { kind: 'note', text: 'T-1 espera el click', waitingFor: 'la Coordinadora', waitingSince: ONOW - 60000 } },
      { session: 'Pinola', sid: 'sid-pin', extra: { kind: 'loose', text: 'trabaja' } },
    ]),
    signatures: [{ id: 'f1', tipo: 'firma', destino: 'sid-pin', title: 'el carril de Pinola', at: ONOW }],
    board: numbered([{ titulo: 'La de Sand', estado: 'curso' }, { titulo: 'Suelta', estado: 'espera' }]),
    nowMs: ONOW,
  });
  const sent = pick(JSON.parse(JSON.stringify(data)), '/home/nadie');
  for (const [i, a] of data.agents.entries()) for (const k of ['mano', 'manoEtiqueta', 'manoPor']) assert.deepStrictEqual(sent.agents[i][k], a[k], `${a.nombre}: «${k}»`);
  assert.ok(data.agents.some((a) => a.mano === 'coordinadora') && data.agents.some((a) => a.mano === 'dueno'));
  for (const [c, col] of data.kanban.columnas.entries()) for (const [t, card] of col.tarjetas.entries()) for (const k of ['numero', 'mano', 'titulo']) assert.deepStrictEqual(sent.kanban.columnas[c].tarjetas[t][k], card[k], `«${card.titulo}»: «${k}»`);
  assert.strictEqual(sent.kanban.linea, data.kanban.linea);
});

// ── La mano levantada ────────────────────────────────────────────────────────────────────────────────────────────

test('T48 Mano_FirmaConDestino_LaLevantaYDiceCual — @story-8.198 @ac-50 @ac-51', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Sand', sid: 'sid-sand', extra: { kind: 'loose', text: 'trabaja' } }]), signatures: [{ id: 'f1', tipo: 'firma', destino: 'sid-sand', title: 'el carril de Sand', at: ONOW }], nowMs: ONOW });
  const sand = data.agents.find((a) => a.nombre === 'Sand');
  assert.deepStrictEqual([sand.mano, sand.manoPor, sand.manoEtiqueta], ['dueno', 'Firma: el carril de Sand', 'Espera tu firma']);
});

test('T49 Mano_FirmaDeTerminalSinDestino_NoMueveANadie — @story-8.198 @ac-52', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Sand', extra: { kind: 'loose', text: 'trabaja' } }]), signatures: [{ id: 'f1', title: 'algo de la terminal', at: ONOW }], nowMs: ONOW });
  assert.ok(data.agents.every((a) => !a.mano));
  assert.ok(kcol(data, 'firma').tarjetas.some((t) => t.quien === 'vos'));
});

test('T50 Mano_EsperaALaCoordinadora_OtroColorYEtiqueta — @story-8.198 @ac-53 @ac-54', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'Sand', status: 'idle', extra: { kind: 'note', text: 'espera el click', waitingFor: 'la Coordinadora', waitingSince: ONOW - 60000 } },
      { session: 'Pinola', status: 'waiting_for_permission', extra: { kind: 'note', text: 'espera', waitingFor: 'la coordinadora', waitingSince: ONOW - 60000 } },
    ]),
    nowMs: ONOW,
  });
  const sand = data.agents.find((a) => a.nombre === 'Sand');
  const pinola = data.agents.find((a) => a.nombre === 'Pinola');
  assert.deepStrictEqual([sand.mano, sand.manoEtiqueta], ['coordinadora', 'Espera a la Coordinadora']);
  assert.deepStrictEqual([pinola.mano, pinola.manoEtiqueta], ['dueno', 'Espera tu firma']);
  assert.strictEqual(cards(data).find((c) => c.quien === 'Sand').mano, 'coordinadora');
});

test('T57 Mano_Baja_FirmaHechaOEsperaVencida — @story-8.198 @ac-50 @ac-53', () => {
  // sin la firma en la lista (firmada o vencida) y con la espera cambiada, la mano baja
  const { data } = buildOffice({ wip: wip([{ session: 'Sand', sid: 'sid-sand', extra: { kind: 'loose', text: 'otra cosa' } }]), signatures: [], nowMs: ONOW });
  assert.ok(!data.agents.find((a) => a.nombre === 'Sand').mano);
  // un destino que no es el id de la sesión del mismo nombre no levanta a nadie
  const other = buildOffice({ wip: wip([{ session: 'Sand', sid: 'sid-sand', extra: { kind: 'loose', text: 'trabaja' } }]), signatures: [{ id: 'f1', tipo: 'firma', destino: 'sid-otra', nombre: 'Sand', title: 'de otra', at: ONOW }], nowMs: ONOW });
  assert.ok(!other.data.agents.find((a) => a.nombre === 'Sand').mano);
});

// ── El globito sobre la cabeza ──────────────────────────────────────────────────────────────────────────────────
// la función del globito, sacada de la página y corrida: es una sola línea, sin nada de la sala
function globoDePagina() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'tools', 'office', 'page.js'), 'utf8');
  const linea = code.split('\n').find((l) => l.startsWith('function globoDe('));
  assert.ok(linea, 'page.js tiene globoDe en una línea');
  return { code, globoDe: new Function(`${linea}\nreturn globoDe;`)() };
}

test('T58 Globo_ColorPorAQuienEspera — @story-8.198 @ac-59', () => {
  const { code, globoDe } = globoDePagina();
  assert.deepStrictEqual(globoDe('dueno'), { icono: '✋', color: '#ff7a00' });
  assert.deepStrictEqual(globoDe('coordinadora'), { icono: '✋', color: '#1f6fff' });
  // la etiqueta no repite la mano en su esquina: ahí queda la marca de su estado
  assert.match(code, /fx\.textContent=FX\[a\.estado\]\|\|""/);
  assert.strictEqual(globoDe(null), null);
  assert.strictEqual(globoDe(undefined), null);
  // el aro del piso toma el color del globito; el brazo no se levanta; no queda nada del cartel
  assert.match(code, /d\.ring\.material\.color\.set\([^)]*globoDe\(/);
  assert.doesNotMatch(code, /zR=2\.(55|75)/);
  assert.doesNotMatch(code, /cartelDe|ponerCartel|data-cartel/);
});

test('T59 Globo_ElSitioSirveElMismoDibujo — @story-8.198 @ac-59', async () => {
  const { code } = globoDePagina();
  const { montar, LEAD } = require('./lib/offices-harness.js');
  const h = await montar();
  try {
    const cookie = await h.entrar(LEAD);
    const servido = await h.pedir('/offices/page.js', { cookie });
    assert.strictEqual(servido.status, 200);
    assert.match(servido.texto, /^function globoDe\(/m);
    assert.strictEqual(servido.texto, code, 'el mismo dibujo que la oficina local');
  } finally { await h.cerrar(); }
});
