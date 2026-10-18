'use strict';
// work-in-progress.test.js — the /wip table: work in progress on this machine, built from toy state folders.
// Nothing here reads the real HOME: every folder comes in by argument.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const WIP = path.join(__dirname, '..', 'tools', 'work-in-progress.js');
const { buildWip } = require(WIP);

const NOW = '2026-10-18T14:00:00.000Z';
const DEAD_PID = 999999;

function toyMachine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wip-'));
  const state = path.join(root, 'state');
  const sessions = path.join(root, 'sessions');
  for (const d of ['active', 'adhoc', 'timing-history']) fs.mkdirSync(path.join(state, d), { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  return { root, state, sessions };
}

function story(root, id, title) {
  const p = path.join(root, `story-${id}.md`);
  fs.writeFileSync(p, `---\nstory: "${id}"\ntitle: "${title}"\n---\n# Story\n`);
  return p;
}

function marker(m, sid, fields) {
  fs.writeFileSync(path.join(m.state, 'active', `${sid}.json`), JSON.stringify({ sessionId: sid, ...fields }));
}

function session(m, pid, sid, name) {
  const s = { pid, sessionId: sid, status: 'busy' };
  if (name) s.name = name;
  fs.writeFileSync(path.join(m.sessions, `${sid}.json`), JSON.stringify(s));
}

// One archived run where every main step from 0 to 8 lasted `mins[step]` minutes, measured (start and end marked).
function history(m, name, mins) {
  let t = Date.parse('2026-10-10T10:00:00.000Z');
  const startedAt = new Date(t).toISOString();
  const stepTimings = {};
  for (const [step, min] of Object.entries(mins)) {
    const s = t;
    t += min * 60000;
    stepTimings[step] = { startedAt: new Date(s).toISOString(), completedAt: new Date(t).toISOString() };
  }
  fs.writeFileSync(path.join(m.state, 'timing-history', `${name}.json`),
    JSON.stringify({ archivedAt: new Date(t).toISOString(), marker: { startedAt, stepTimings } }));
}

const run = (m, extra = {}) => buildWip({ stateDir: m.state, sessionsDir: m.sessions, now: NOW, ...extra });

test('T1 Tabla_UnaFilaPorTrabajo: dos marcadores y un ad-hoc dan tres filas de cuatro columnas', () => {
  const m = toyMachine();
  const long = 'Un título bastante largo que pasa holgadamente de los cincuenta caracteres permitidos';
  marker(m, 'aaaaaaaa-1', { storyId: '9.1', storyPath: story(m.root, '9.1', long), stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 8] });
  marker(m, 'bbbbbbbb-2', { storyId: '9.2', storyPath: story(m.root, '9.2', 'Corto'), stepsCompleted: [0], stepsPending: [1, 2] });
  fs.writeFileSync(path.join(m.state, 'adhoc', 'cccccccc-3.json'), JSON.stringify({ reason: 'arreglar el aviso del arranque' }));
  for (const [i, sid] of ['aaaaaaaa-1', 'bbbbbbbb-2', 'cccccccc-3'].entries()) session(m, process.pid, sid, `s${i}`);
  const r = run(m);
  assert.strictEqual(r.rows.length, 3);
  for (const row of r.rows) assert.deepStrictEqual(Object.keys(row).sort(), ['end', 'session', 'state', 'work']);
  const first = r.rows.find((x) => x.work.startsWith('9.1'));
  assert.strictEqual(Array.from(first.work.slice('9.1 · '.length)).length, 50, first.work);
  assert.ok(first.work.endsWith('…'));
  assert.ok(r.rows.some((x) => x.state === 'Trabajo suelto' && /arreglar el aviso/.test(x.work)));
  const text = r.text;
  assert.match(text, /\| Trabajo \| Estado \| Fin estimado \| Sesión \|/);
});

test('T2 Estado_PasoEnPalabras: los nombres llanos del pipeline, y «paso N» si no hay nombre', () => {
  const m = toyMachine();
  const cases = { 2: 'Armar el plan', 4: 'Implementar y correr las pruebas', 5: 'Revisores', 12: 'paso 12' };
  for (const [step, name] of Object.entries(cases)) {
    const sid = `step${step}-0000`;
    marker(m, sid, { storyId: `8.${step}`, storyPath: story(m.root, `8.${step}`, 't'), stepsCompleted: [], stepsPending: [Number(step)] });
    session(m, process.pid, sid, null);
  }
  const r = run(m);
  for (const [step, name] of Object.entries(cases)) {
    assert.strictEqual(r.rows.find((x) => x.work.startsWith(`8.${step} `)).state, name);
  }
});

test('T3 Fin_MedianaDePasosMedidos: paso en curso a la mitad, medianas de pasos medidos', () => {
  const m = toyMachine();
  // medians: step 4 → 20 min, step 5 → 10 min, step 8 → 4 min
  history(m, 'a', { 0: 1, 4: 10, 5: 10, 8: 2 });
  history(m, 'b', { 0: 1, 4: 20, 5: 10, 8: 4 });
  history(m, 'c', { 0: 1, 4: 30, 5: 10, 8: 6 });
  // an estimated run (no startedAt anywhere) must not move the medians
  fs.writeFileSync(path.join(m.state, 'timing-history', 'd.json'), JSON.stringify({ marker: {
    startedAt: '2026-10-10T10:00:00.000Z',
    stepTimings: { 4: { completedAt: '2026-10-10T15:00:00.000Z' }, 5: { completedAt: '2026-10-10T19:00:00.000Z' } } } }));
  // step 4 started 10 min before NOW → 10 min left, then 10 + 4 → ends at NOW + 24 min
  marker(m, 'dddddddd-4', { storyId: '9.4', storyPath: story(m.root, '9.4', 't'), stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 8],
    stepTimings: { 4: { startedAt: '2026-10-18T13:50:00.000Z' } } });
  session(m, process.pid, 'dddddddd-4', 'x');
  const r = run(m);
  const row = r.rows[0];
  const expected = new Date(Date.parse(NOW) + 24 * 60000);
  const hhmm = `${String(expected.getHours()).padStart(2, '0')}:${String(expected.getMinutes()).padStart(2, '0')}`;
  assert.strictEqual(row.end, hhmm);
});

test('T4 Fin_SinDatos_LoDice: sin mediana del paso 8 no hay hora', () => {
  const m = toyMachine();
  history(m, 'a', { 0: 1, 4: 10, 5: 10 });
  marker(m, 'eeeeeeee-5', { storyId: '9.5', storyPath: story(m.root, '9.5', 't'), stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 8] });
  session(m, process.pid, 'eeeeeeee-5', 'x');
  const row = run(m).rows[0];
  assert.strictEqual(row.end, 'sin datos (Preparar el commit)');
});

test('T5 Sesion_NombreIdCortoYMedioCamino: sólo lo vivo en la tabla; lo demás abajo, con cómo limpiarlo', () => {
  const m = toyMachine();
  const mk = (sid, id) => marker(m, sid, { storyId: id, storyPath: story(m.root, id, `titulo ${id}`), stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5] });
  mk('11111111-aaaa', '7.1'); mk('22222222-bbbb', '7.2'); mk('33333333-cccc', '7.3');
  session(m, process.pid, '11111111-aaaa', 'coordinadora');
  session(m, DEAD_PID, '33333333-cccc', 'vieja');
  // 22222222 has no session file: a closed Claude session leaves none
  const adhoc = path.join(m.state, 'adhoc', '44444444-dddd.json');
  fs.writeFileSync(adhoc, JSON.stringify({ reason: 'ajuste viejo' }));
  const r = run(m);
  assert.deepStrictEqual(r.rows.map((x) => x.session), ['coordinadora']);
  assert.strictEqual(r.halfway.length, 3);
  assert.match(r.text, /Quedaron a medio camino \(sesión cerrada o sin rastro\): 3/);
  assert.match(r.text, /7\.2 · titulo 7\.2 · 22222222 · quedó en: Implementar y correr las pruebas · limpiar: node .*marker\.js clear-session 22222222-bbbb/);
  assert.match(r.text, /7\.3 · titulo 7\.3 · 33333333 · .*clear-session 33333333-cccc/);
  assert.match(r.text, /ad-hoc «ajuste viejo» · 44444444 · se podrá limpiar después de las \d\d:\d\d/);
  assert.ok(fs.existsSync(adhoc), 'no limpia nada solo');
  assert.strictEqual(fs.readdirSync(path.join(m.state, 'active')).length, 3);
});

test('T6 Libres_AlPie: las vivas sin trabajo; sin libres, «ninguna»', () => {
  const m = toyMachine();
  marker(m, '44444444-dddd', { storyId: '6.1', storyPath: story(m.root, '6.1', 't'), stepsCompleted: [], stepsPending: [1] });
  session(m, process.pid, '44444444-dddd', 'ocupada');
  fs.writeFileSync(path.join(m.sessions, 'b.json'), JSON.stringify({ pid: process.pid, sessionId: '55555555-eeee', name: 'libre-uno' }));
  fs.writeFileSync(path.join(m.sessions, 'c.json'), JSON.stringify({ pid: process.pid, sessionId: '66666666-ffff' }));
  fs.writeFileSync(path.join(m.sessions, 'd.json'), JSON.stringify({ pid: DEAD_PID, sessionId: '77777777-0000', name: 'muerta' }));
  const r = run(m);
  assert.deepStrictEqual(r.free.sort(), ['66666666', 'libre-uno']);
  assert.match(r.text, /Libres: .*libre-uno/);

  const empty = toyMachine();
  marker(empty, '88888888-1111', { storyId: '6.2', storyPath: story(empty.root, '6.2', 't'), stepsCompleted: [], stepsPending: [1] });
  session(empty, process.pid, '88888888-1111', 'sola');
  assert.match(run(empty).text, /Libres: ninguna/);
});

test('T7 Ilegible_SeDice: marcador roto y story inexistente van al pie con su motivo', () => {
  const m = toyMachine();
  fs.writeFileSync(path.join(m.state, 'active', '99999999-roto.json'), '{ no es json');
  marker(m, 'aaaa0000-2222', { storyId: '5.5', storyPath: path.join(m.root, 'no-existe.md'), stepsCompleted: [], stepsPending: [4] });
  session(m, process.pid, 'aaaa0000-2222', 'x');
  const r = run(m);
  assert.strictEqual(r.rows.length, 1, 'el marcador roto no inventa fila');
  assert.match(r.rows[0].work, /título ilegible/);
  assert.ok(r.unreadable.some((u) => /99999999-roto\.json/.test(u)));
  assert.ok(r.unreadable.some((u) => /no-existe\.md/.test(u)));
  assert.match(r.text, /No se pudo leer:/);
});

test('T9 CLI_JsonYSinEstado: --json y salida 2 sin carpeta de estado', () => {
  const m = toyMachine();
  const out = execFileSync('node', [WIP, '--state-dir', m.state, '--sessions-dir', m.sessions, '--now', NOW, '--json'], { input: '' });
  assert.deepStrictEqual(JSON.parse(out).rows, []);
  let code = 0;
  try { execFileSync('node', [WIP, '--state-dir', path.join(m.root, 'nada'), '--sessions-dir', m.sessions], { input: '', stdio: 'pipe' }); }
  catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
});

test('T10 Terminados_YViejos_NoCuentan: terminados y viejos no cuentan como en curso', () => {
  const m = toyMachine();
  marker(m, 'done0000-1', { storyId: '4.1', storyPath: story(m.root, '4.1', 't'), stepsCompleted: [0, 8], stepsPending: [], lastTouch: NOW });
  marker(m, 'old00000-2', { storyId: '4.2', storyPath: story(m.root, '4.2', 't'), stepsCompleted: [0], stepsPending: [4], lastTouch: '2026-10-16T10:00:00.000Z' });
  session(m, process.pid, 'done0000-1', 'a'); session(m, process.pid, 'old00000-2', 'b');
  const r = run(m);
  assert.deepStrictEqual(r.rows, []);
  assert.strictEqual(r.halfway.length, 0);
  assert.ok(r.unreadable.some((u) => /más de 24 h/.test(u)), r.unreadable.join('\n'));
  assert.ok(fs.existsSync(path.join(m.state, 'active', 'old00000-2.json')), 'sólo lee: no borra el viejo');
});

test('T11 JsonRaro_SeDice: JSON que no es objeto, sesión sin id o pid raro se dicen y no tumban', () => {
  const m = toyMachine();
  fs.writeFileSync(path.join(m.state, 'active', 'null0000.json'), 'null');
  fs.writeFileSync(path.join(m.state, 'adhoc', 'arr00000.json'), '[1]');
  fs.writeFileSync(path.join(m.sessions, 's1.json'), JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(path.join(m.sessions, 's2.json'), JSON.stringify({ pid: 'abc', sessionId: 'badpid00-1' }));
  const r = run(m);
  for (const re of [/null0000\.json: no es un objeto/, /arr00000\.json: no es un objeto/, /s1\.json: sin sessionId/, /s2\.json: pid ilegible/]) {
    assert.ok(r.unreadable.some((u) => re.test(u)), `${re} en ${r.unreadable.join(' | ')}`);
  }
});

test('T12 SesionRepetida_ManaLaViva: sesión repetida se queda con la viva', () => {
  const m = toyMachine();
  marker(m, 'dup00000-1', { storyId: '4.3', storyPath: story(m.root, '4.3', 't'), stepsCompleted: [], stepsPending: [4], lastTouch: NOW });
  fs.writeFileSync(path.join(m.sessions, 'a.json'), JSON.stringify({ pid: process.pid, sessionId: 'dup00000-1', name: 'viva' }));
  fs.writeFileSync(path.join(m.sessions, 'z.json'), JSON.stringify({ pid: DEAD_PID, sessionId: 'dup00000-1', name: 'muerta' }));
  assert.strictEqual(run(m).rows[0].session, 'viva');
});

test('T13 CrlfYSaltos_EnLaTabla: CRLF, saltos de línea y barras en la tabla', () => {
  const m = toyMachine();
  const p = path.join(m.root, 'crlf.md');
  fs.writeFileSync(p, '---\r\nstory: "4.4"\r\ntitle: "Con CRLF"\r\n---\r\n# S\r\n');
  marker(m, 'crlf0000-1', { storyId: '4.4', storyPath: p, stepsCompleted: [], stepsPending: [4], lastTouch: NOW });
  fs.writeFileSync(path.join(m.state, 'adhoc', 'nl000000-2.json'), JSON.stringify({ reason: 'una\nlínea | partida' }));
  session(m, process.pid, 'crlf0000-1', 'x'); session(m, process.pid, 'nl000000-2', 'y');
  const r = run(m);
  assert.ok(r.rows.some((x) => x.work === '4.4 · Con CRLF'), JSON.stringify(r.rows));
  const line = r.text.split('\n').find((l) => l.includes('una línea'));
  assert.ok(line && line.includes('\\|'), r.text);
});

test('T14 SinArranque_HoraAproximada: paso en curso sin arranque dice que la hora es aproximada', () => {
  const m = toyMachine();
  history(m, 'a', { 0: 1, 4: 10 });
  marker(m, 'noarr000-1', { storyId: '4.5', storyPath: story(m.root, '4.5', 't'), stepsCompleted: [0], stepsPending: [4], lastTouch: NOW,
    stepTimings: { 0: { completedAt: '2026-10-18T13:55:00.000Z' } } });
  session(m, process.pid, 'noarr000-1', 'x');
  assert.match(run(m).rows[0].end, /^\d\d:\d\d \(aprox\.\)$/);
});

test('T15 ArgumentosInvalidos_Salen2: argumentos inválidos salen con 2', () => {
  const m = toyMachine();
  for (const args of [['--now', 'ayer'], ['--state-dir']]) {
    let code = 0;
    try { execFileSync('node', [WIP, '--sessions-dir', m.sessions, ...args], { input: '', stdio: 'pipe' }); } catch (e) { code = e.status; }
    assert.strictEqual(code, 2, args.join(' '));
  }
});

test('T16 MarcadorSinPasos_YPasoPasado: sin lista de pasos se dice; paso pasado de su mediana no resta de más', () => {
  const m = toyMachine();
  history(m, 'a', { 0: 1, 4: 10, 5: 6 });
  fs.writeFileSync(path.join(m.state, 'active', 'nolist00.json'), JSON.stringify({ sessionId: 'nolist00', storyId: '3.1' }));
  // step 4 started 40 min ago with a 10 min median: it counts as 0 left, then step 5 adds 6 min
  marker(m, 'late0000-1', { storyId: '3.2', storyPath: story(m.root, '3.2', 't'), stepsCompleted: [0], stepsPending: [4, 5], lastTouch: NOW,
    stepTimings: { 4: { startedAt: '2026-10-18T13:20:00.000Z' } } });
  session(m, process.pid, 'late0000-1', 'x');
  const r = run(m);
  assert.ok(r.unreadable.some((u) => /nolist00\.json: sin lista de pasos pendientes/.test(u)), r.unreadable.join(' | '));
  const end = new Date(Date.parse(NOW) + 6 * 60000);
  assert.strictEqual(r.rows[0].end, `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`);
});

test('T17 Wip_AdhocRecomiendaClearOrphan: el viejo trae el comando; el nuevo, desde cuándo', () => {
  const m = toyMachine();
  const at = (h) => new Date(Date.parse(NOW) - h * 3600 * 1000).toISOString();
  fs.writeFileSync(path.join(m.state, 'adhoc', 'old00000-a.json'), JSON.stringify({ reason: 'viejo', lastTouch: at(30) }));
  fs.writeFileSync(path.join(m.state, 'adhoc', 'new00000-b.json'), JSON.stringify({ reason: 'nuevo', lastTouch: at(2) }));
  const r = run(m);
  assert.match(r.text, /ad-hoc «viejo» · old00000 · limpiar: node .*marker\.js adhoc clear-orphan old00000-a/);
  const when = new Date(Date.parse(NOW) + 22 * 3600 * 1000);
  const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  assert.ok(r.text.includes(`ad-hoc «nuevo» · new00000 · se podrá limpiar después de las ${hhmm}`), r.text);
});

test('T18 Wip_AdhocFechaDeRespaldo: lastTouch ilegible usa declaredAt', () => {
  const m = toyMachine();
  const at = (h) => new Date(Date.parse(NOW) - h * 3600 * 1000).toISOString();
  fs.writeFileSync(path.join(m.state, 'adhoc', 'bad00000-c.json'), JSON.stringify({ reason: 'fecha rota', lastTouch: 'ayer', declaredAt: at(30) }));
  assert.match(run(m).text, /ad-hoc «fecha rota» · bad00000 · limpiar: .*adhoc clear-orphan bad00000-c/);
});

test('T19 SesionesPorDefecto_LaCarpetaDeClaudeCode: sin --sessions-dir lee las sesiones de la carpeta de Claude Code del HOME', () => {
  const m = toyMachine();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wip-home-'));
  const sessions = path.join(require('../../skills/tycon-pipeline/scripts/lib/state-dir.js').claudeDir(home), 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  marker(m, 'dddddddd-4', { storyId: '9.4', storyPath: story(m.root, '9.4', 'Por defecto'), stepsCompleted: [0], stepsPending: [1] });
  fs.writeFileSync(path.join(sessions, 'dddddddd-4.json'), JSON.stringify({ pid: process.pid, sessionId: 'dddddddd-4', status: 'busy', name: 'la-del-home' }));
  const r = buildWip({ home, stateDir: m.state, now: NOW });
  assert.ok(r.rows.some((x) => x.session === 'la-del-home'), JSON.stringify(r.rows));
  fs.rmSync(home, { recursive: true, force: true });
});
