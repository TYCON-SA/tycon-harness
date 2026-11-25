'use strict';
// office-board-forecast.test.js — what the board keeps so a forecast of what is left can be made: the day each row was
// added, how many tasks a grouped card holds, and one photo per day of how many are left (T-134).
// Nothing reads the real HOME: every case gets its own toy state folder.
// stable-data: every date comes in by argument.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const board = require(path.join(__dirname, '..', 'tools', 'office', 'board.js'));

const NOW = new Date(2026, 10, 21, 10, 40).getTime();
const DAY = 24 * 3600 * 1000;

function stateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-forecast-'));
  fs.mkdirSync(path.join(dir, 'coordination'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const readRows = (sdir) => JSON.parse(fs.readFileSync(path.join(sdir, 'coordination', 'tablero.json'), 'utf8')).pendientes;
const readPhotos = (sdir) => JSON.parse(fs.readFileSync(board.paths(sdir).photos, 'utf8'));
const row = (titulo, more = {}) => ({ titulo, estado: 'espera', grupo: 'Hoy', ...more });
const byTitle = (rows, t) => rows.find((r) => r.titulo === t);

test('T1 Add_WritesTheDayItWasAdded — una fila nueva lleva su fecha de alta, y set no la cambia', (t) => {
  const sdir = stateDir(t);
  assert.strictEqual(board.add(sdir, ['titulo=Nueva', 'estado=espera'], { now: NOW }).code, 0);
  assert.strictEqual(byTitle(readRows(sdir), 'Nueva').alta, '2026-11-21');
  const id = byTitle(readRows(sdir), 'Nueva').id;
  assert.strictEqual(board.set(sdir, id, ['nota=algo'], { now: NOW + 3 * DAY }).code, 0);
  assert.strictEqual(byTitle(readRows(sdir), 'Nueva').alta, '2026-11-21', 'la fecha de alta no se mueve');
});

test('T2 OldRows_TakeTheDateOfTheirNote — una fila vieja sin fecha toma la de su nota; sin fecha en la nota, queda sin', (t) => {
  const sdir = stateDir(t);
  const r = board.save(sdir, { pendientes: [row('Con fecha', { nota: 'Decisión del dueño 10/11 20:05: para la semana próxima.' }), row('Sin fecha', { nota: 'falta medir' }),
    row('Del año pasado', { nota: 'pedido del 28/12' }), row('Con alta', { alta: '2026-11-01', nota: 'del 15/11' })] }, { now: NOW });
  assert.strictEqual(r.code, 0, r.lines.join('\n'));
  const rows = readRows(sdir);
  assert.strictEqual(byTitle(rows, 'Con fecha').alta, '2026-11-10');
  assert.strictEqual(byTitle(rows, 'Sin fecha').alta, undefined, 'no se inventa una fecha');
  assert.strictEqual(byTitle(rows, 'Del año pasado').alta, '2025-12-28', 'una fecha que caería en el futuro es del año anterior');
  assert.strictEqual(byTitle(rows, 'Con alta').alta, '2026-11-01', 'la que ya tiene fecha la conserva');
});

// Pase adversarial (21/11): la primera fecha que no existe cortaba la búsqueda, y una fecha con su año se salteaba.
test('T8 OldRows_SkipImpossibleDates_AndReadTheYear — una fecha que no existe no corta la búsqueda; dd/mm/aaaa vale con su año', (t) => {
  const sdir = stateDir(t);
  const r = board.save(sdir, { pendientes: [row('Fracción', { nota: 'chance 50/50, pedida el 18/11' }), row('Imposible', { nota: '31/11 no existe, alta 12/11' }),
    row('Con año', { nota: 'creada 10/11/2026; revisar 20/11' }), row('Año corto', { nota: 'del 3/10/25' }), row('Año futuro', { nota: 'para el 1/12/2026' })] }, { now: NOW });
  assert.strictEqual(r.code, 0, r.lines.join('\n'));
  const rows = readRows(sdir);
  assert.strictEqual(byTitle(rows, 'Fracción').alta, '2026-11-18');
  assert.strictEqual(byTitle(rows, 'Imposible').alta, '2026-11-12');
  assert.strictEqual(byTitle(rows, 'Con año').alta, '2026-11-10');
  assert.strictEqual(byTitle(rows, 'Año corto').alta, '2025-10-03');
  assert.strictEqual(byTitle(rows, 'Año futuro').alta, undefined, 'una fecha con año que todavía no llegó no es su alta');
});

// Pase adversarial (21/11): con el cambio de hora a medianoche (America/Santiago), ese día no tenía 00:00 y se rechazaba.
test('T9 Alta_DayWithoutMidnight_IsAValidDay — un día sin medianoche por el cambio de hora sigue siendo un día', () => {
  const { spawnSync } = require('child_process');
  const code = `const b=require(${JSON.stringify(path.join(__dirname, '..', 'tools', 'office', 'board.js'))});`
    + 'console.log(JSON.stringify(b.rowProblems([{titulo:"x",estado:"espera",alta:"2026-09-06"}],{ultimo:0})))';
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, TZ: 'America/Santiago' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), []);
});

test('T3 Alta_BadForm_NotSaved — una fecha de alta que no existe no se guarda', (t) => {
  const sdir = stateDir(t);
  const r = board.save(sdir, { pendientes: [row('Mala', { alta: '2026-02-30' })] }, { now: NOW });
  assert.strictEqual(r.code, 2);
  assert.match(r.lines.join('\n'), /alta/);
});

test('T4 GroupedCard_CountsEachLineOfItsNote — una tarjeta agrupada cuenta un pendiente por renglón de su nota', () => {
  assert.strictEqual(board.taskCount(row('Una')), 1);
  assert.strictEqual(board.taskCount(row('Vacía', { nota: '  \n ' })), 1);
  assert.strictEqual(board.taskCount(row('Tres', { nota: '- el aviso\n- la prueba\n\n- el texto' })), 3);
  assert.strictEqual(board.taskCount(row('Hecha', { estado: 'hecho', realIso: '2026-11-20T10:00', nota: 'a\nb' })), 0, 'una hecha no queda');
});

test('T5 EachWrite_KeepsTodaysPhoto — cada guardado deja la foto del día con cuántas filas y tareas quedan; otro día, otra foto', (t) => {
  const sdir = stateDir(t);
  board.save(sdir, { pendientes: [row('A', { nota: 'x\ny' }), row('B'), row('C', { estado: 'hecho', realIso: '2026-11-21T09:00' })] }, { now: NOW });
  assert.deepStrictEqual(readPhotos(sdir)['2026-11-21'], { filas: 2, tareas: 3, hora: '2026-11-21T10:40' });
  const b = byTitle(readRows(sdir), 'B').id;
  board.close(sdir, b, { now: NOW + 60 * 1000 });
  assert.strictEqual(readPhotos(sdir)['2026-11-21'].tareas, 2, 'la del día queda con lo último');
  board.add(sdir, ['titulo=D', 'estado=espera'], { now: NOW + DAY });
  const photos = readPhotos(sdir);
  assert.deepStrictEqual(Object.keys(photos).sort(), ['2026-11-21', '2026-11-22']);
  assert.strictEqual(photos['2026-11-22'].tareas, 3);
});

test('T6 Photo_WithoutChanges_TakenByTheOffice — sin cambios en el tablero, la foto del día sale igual (la pide la oficina)', (t) => {
  const sdir = stateDir(t);
  board.save(sdir, { pendientes: [row('A'), row('B')] }, { now: NOW });
  const r = board.photo(sdir, { now: NOW + 2 * DAY });
  assert.strictEqual(r.written, true);
  assert.strictEqual(readPhotos(sdir)['2026-11-23'].filas, 2);
  assert.strictEqual(board.photo(sdir, { now: NOW + 2 * DAY + 60000 }).written, false, 'la misma cuenta el mismo día no se reescribe');
});

test('T7 Photo_UnreadableBoard_NotTaken — con el tablero ilegible no deja una foto en cero', (t) => {
  const sdir = stateDir(t);
  fs.writeFileSync(path.join(sdir, 'coordination', 'tablero.json'), '{ roto');
  const r = board.photo(sdir, { now: NOW });
  assert.strictEqual(r.written, false);
  assert.ok(r.aviso, 'dice por qué');
  assert.ok(!fs.existsSync(board.paths(sdir).photos));
});
