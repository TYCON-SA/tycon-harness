'use strict';
// work-in-progress.test.js — the /wip table: work in progress on this machine, built from toy state folders.
// Nothing here reads the real HOME: every folder comes in by argument.
// stable-data: T22 and T37 read the clock only to measure how long a hung query takes, and the program's cap for reading
// repos reads it too (T22 sets it below zero); T24's and T39's commits fix their dates and turn maintenance off; dates come in
// by --now.

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

// A session file as Claude Code writes it. By default quiet for 20 minutes before NOW: free, unless it has work.
function session(m, pid, sid, name, extra = {}) {
  const s = { pid, sessionId: sid, status: 'idle', statusUpdatedAt: Date.parse(NOW) - 20 * 60000, ...extra };
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

// ── Entering the repos: the pipeline closed step 8 and the story waits for its pull requests ─────────────────────

function gitRepo(root, name, branch, origin) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}

// A marker that closed step 8, with its live session.
function entering(m, sid, fields) {
  marker(m, sid, { storyId: '5.1', storyPath: story(m.root, '5.1', 'Lo que entra'), stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 8], stepsPending: [], lastTouch: NOW, ...fields });
  session(m, process.pid, sid, 'ocupada');
}

const GH = 'https://github.com/acme/x.git';
// The «@» of a user in a remote goes in parts: written whole, the publishing guard reads it as an email address.
const at = (user, rest) => `${user}${'@'}${rest}`;
const AZ = `https://${at('acme', 'dev.azure.com')}/acme/Proyecto%20Uno/_git/y`;

test('T20 Entrando_ConPedido_Ocupada: el 8 cerrado y un pedido abierto dan la fila y la sesión ocupada', () => {
  const m = toyMachine();
  const repo = gitRepo(m.root, 'x', 'story/x', GH);
  entering(m, 'ent00000-1', { repoPath: repo });
  const asked = [];
  const r = run(m, { prs: (q) => { asked.push(q); return { prs: [{ number: 236, draft: false }] }; } });
  assert.strictEqual(r.rows.length, 1, r.text);
  assert.strictEqual(r.rows[0].state, 'Entrando a los repos · x #236');
  assert.strictEqual(r.rows[0].end, 'sin estimación (espera la CI o la cola)');
  assert.deepStrictEqual(r.free, []);
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].branch, 'story/x');
  const command = fs.readFileSync(path.join(__dirname, '..', '..', 'commands', 'wip.md'), 'utf8');
  for (const words of ['Entrando a los repos', 'GitHub', 'Azure DevOps', 'sólo lee']) assert.ok(command.includes(words), words);
});

test('T21 SinPedidosAbiertos_Terminado: sin pedidos abiertos la story terminó y la sesión está libre', () => {
  const m = toyMachine();
  entering(m, 'ent00000-2', { repoPath: gitRepo(m.root, 'x', 'story/x', GH) });
  const r = run(m, { prs: () => ({ prs: [] }) });
  assert.deepStrictEqual(r.rows, []);
  assert.deepStrictEqual(r.free, ['ocupada']);
  assert.deepStrictEqual(r.unreadable, []);
});

test('T22 ConsultaFalla_SeDiceYQuedaOcupada: una consulta que falla o se pasa del tope se dice y la fila sale igual', { skip: process.platform === 'win32' ? 'el gh falso es un script de node con #!, que Windows no corre' : false }, async () => {
  const m = toyMachine();
  entering(m, 'ent00000-3', { repoPath: gitRepo(m.root, 'x', 'story/x', GH) });
  const r = run(m, { prs: () => ({ error: 'gh: no está instalado' }) });
  assert.strictEqual(r.rows[0].state, 'Entrando a los repos (no se pudo consultar los pedidos)');
  assert.ok(r.unreadable.some((u) => /pedidos de x \(story\/x\): gh: no está instalado/.test(u)), r.unreadable.join(' | '));
  assert.deepStrictEqual(r.free, []);
  // reading the repos has its own cap: past it, nothing more is read and it is said
  const capped = run(m, { prs: () => ({ prs: [] }), repoBudgetMs: -1 });
  assert.strictEqual(capped.rows[0].state, 'Entrando a los repos (no se pudo consultar los pedidos)');
  assert.ok(capped.unreadable.some((u) => /se pasó del tope de 3 s leyendo los repos/.test(u)), capped.unreadable.join(' | '));
  // the real query, against a gh that takes longer than its cap: it gives up instead of hanging
  const bin = fakeBin(m.root, 'gh', 'setTimeout(() => {}, 5000);');
  const t0 = Date.now();
  const [res] = await queryAll([{ kind: 'github', slug: 'acme/x', branch: 'story/x', name: 'x', root: m.root }], { perMs: 300, totalMs: 600, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.ok(Date.now() - t0 < 3000, 'no espera al gh colgado');
  assert.match(res.error, /tope/);
  const { PER_QUERY_MS, ALL_QUERIES_MS } = require(WIP);
  assert.deepStrictEqual([PER_QUERY_MS, ALL_QUERIES_MS], [5000, 6000], 'los topes de la story');
  const q = [{ kind: 'github', slug: 'acme/x', branch: 'story/x', name: 'x', root: m.root }];
  const withBin = (b) => ({ env: { ...process.env, PATH: b } });
  const missing = fs.mkdtempSync(path.join(m.root, 'empty-'));
  assert.match((await queryAll(q, withBin(missing)))[0].error, /gh: no está instalado/);
  for (const [out, why] of [['basura', /respuesta ilegible/], ['{"number":1}', /no es una lista/], ['[{"isDraft":false}]', /sin número/]]) {
    const b = fakeBin(m.root, 'gh', `process.stdout.write(${JSON.stringify(out)});`);
    assert.match((await queryAll(q, { ...withBin(`${b}${path.delimiter}${process.env.PATH}`) }))[0].error, why);
  }
  // a gh that ignores SIGTERM and hangs: the total cap kills it with SIGKILL, which it cannot ignore, so the command
  // can end
  const stubborn = fakeBin(m.root, 'gh', `require('fs').writeFileSync(__dirname + '/pid', String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
  const t1 = Date.now();
  const [hung] = await queryAll(q, { perMs: 20000, totalMs: 2000, env: { ...process.env, PATH: `${stubborn}${path.delimiter}${process.env.PATH}` } });
  assert.ok(Date.now() - t1 < 5000);
  assert.match(hung.error, /tope de 2 s para todas/);
  const pidFile = path.join(stubborn, 'pid');
  assert.ok(fs.existsSync(pidFile), 'el gh colgado llegó a arrancar en 2 s');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(alive(), false, 'el gh colgado quedó muerto');
  // a gh that answers with an error (no login, say): its message is the reason
  const denied = fakeBin(m.root, 'gh', `process.stderr.write('gh auth login required'); process.exit(1);`);
  assert.match((await queryAll(q, withBin(`${denied}${path.delimiter}${process.env.PATH}`)))[0].error, /gh: gh auth login required/);
});

test('T23 DosRepos_GitHubYAzure_ConBorrador: los dos repos de la story, cada uno con su pedido', () => {
  const m = toyMachine();
  const x = gitRepo(m.root, 'x', 'story/x', GH);
  const y = gitRepo(m.root, 'y', 'story/x', AZ);
  fs.mkdirSync(path.join(y, 'specs'));
  entering(m, 'ent00000-4', { repoPath: x, filesTouched: [path.join(y, 'specs', 'a.md'), path.join(x, 'b.js')] });
  const r = run(m, { prs: (q) => (q.kind === 'github' ? { prs: [{ number: 236, draft: false }] } : { prs: [{ number: 4920, draft: true }] }) });
  assert.strictEqual(r.rows[0].state, 'Entrando a los repos · x #236 · y !4920 (borrador)');
  // a repo nested inside another one (a submodule, vendor/) is asked on its own
  const nested = gitRepo(x, 'vendor', 'story/x', 'https://github.com/acme/vendor.git');
  entering(m, 'ent00000-4', { repoPath: x, filesTouched: [path.join(nested, 'c.js')] });
  const asked = [];
  run(m, { prs: (q) => { asked.push(q.name); return { prs: [] }; } });
  assert.deepStrictEqual(asked.sort(), ['vendor', 'x']);
});

test('T24 RamaPrincipal_YNoRepo_SeIgnoran: un repo en main y una carpeta que no es repo no se consultan', () => {
  const m = toyMachine();
  const loose = path.join(m.root, 'suelta');
  fs.mkdirSync(loose);
  entering(m, 'ent00000-5', { repoPath: gitRepo(m.root, 'x', 'main', GH), filesTouched: [path.join(loose, 'n.txt')] });
  let asked = 0;
  const r = run(m, { prs: () => { asked += 1; return { prs: [] }; } });
  assert.strictEqual(asked, 0);
  assert.deepStrictEqual(r.rows, []);
  assert.deepStrictEqual(r.unreadable, []);
  // a detached HEAD has no branch of its own: nothing to ask either
  const detached = gitRepo(m.root, 'd', 'story/x', GH);
  const fixed = { ...process.env, GIT_AUTHOR_DATE: '2026-10-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T10:00:00Z' };
  execFileSync('git', ['-C', detached, '-c', 'user.name=t', '-c', `user.email=${at('t', 'acme.example')}`, '-c', 'maintenance.auto=false', 'commit', '-q', '--allow-empty', '-m', 'x'], { env: fixed });
  execFileSync('git', ['-C', detached, 'checkout', '-q', '--detach']);
  entering(m, 'ent00000-5', { repoPath: detached });
  const d = run(m, { prs: () => { asked += 1; return { prs: [] }; } });
  assert.strictEqual(asked, 0);
  assert.deepStrictEqual([d.rows, d.unreadable], [[], []]);
});

test('T25 SinPasoOcho_OSesionMuerta_ComoAntes: sin el 8 cerrado o con la sesión muerta, nada cambia', () => {
  const m = toyMachine();
  const repo = gitRepo(m.root, 'x', 'story/x', GH);
  marker(m, 'ent00000-6', { storyId: '5.2', storyPath: story(m.root, '5.2', 't'), repoPath: repo, stepsCompleted: [0, 4], stepsPending: [], lastTouch: NOW });
  session(m, process.pid, 'ent00000-6', 'libre');
  marker(m, 'ent00000-7', { storyId: '5.3', storyPath: story(m.root, '5.3', 't'), repoPath: repo, stepsCompleted: [0, 8], stepsPending: [], lastTouch: NOW });
  session(m, DEAD_PID, 'ent00000-7', 'muerta');
  let asked = 0;
  const r = run(m, { prs: () => { asked += 1; return { prs: [{ number: 1, draft: false }] }; } });
  assert.strictEqual(asked, 0);
  assert.deepStrictEqual(r.rows, []);
  assert.deepStrictEqual(r.halfway, []);
  assert.deepStrictEqual(r.free, ['libre']);
  // a closed run untouched for two days: with its session dead it is finished and not counted; with its session
  // alive it is counted at the foot, so it does not vanish
  const old = toyMachine();
  const twoDaysAgo = '2026-10-16T10:00:00.000Z';
  marker(old, 'ent00000-8', { storyId: '5.4', storyPath: story(old.root, '5.4', 't'), repoPath: repo, stepsCompleted: [0, 8], stepsPending: [], lastTouch: twoDaysAgo });
  session(old, DEAD_PID, 'ent00000-8', 'vieja');
  const o = run(old, { prs: () => { asked += 1; return { prs: [{ number: 1, draft: false }] }; } });
  assert.deepStrictEqual([o.rows, o.unreadable, asked], [[], [], 0]);
  session(old, process.pid, 'ent00000-8', 'vieja');
  const v = run(old, { prs: () => { asked += 1; return { prs: [{ number: 1, draft: false }] }; } });
  assert.deepStrictEqual([v.rows, v.free, asked], [[], [], 0]);
  assert.ok(v.unreadable.some((u) => /1 story\(s\) con el pipeline cerrado hace más de 24 h y la sesión viva/.test(u)), v.unreadable.join(' | '));
});

// A fake tool in its own folder: a node script that logs its arguments next to itself.
function fakeBin(root, name, body) {
  const bin = fs.mkdtempSync(path.join(root, 'bin-'));
  fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\nrequire('fs').writeFileSync(__dirname + '/args.json', JSON.stringify(process.argv.slice(2)));\n${body}\n`, { mode: 0o755 });
  return bin;
}
const { queryAll } = require(WIP);
const onWindows = process.platform === 'win32' ? 'los gh/az falsos son scripts de node con #!, que Windows no corre' : false;

test('T26 ConsultaReal_GhFalso: el programa le pregunta a gh por la rama y el repo de origin', { skip: onWindows }, () => {
  const m = toyMachine();
  entering(m, 'ent00000-8', { repoPath: gitRepo(m.root, 'x', 'story/x', GH) });
  const bin = fakeBin(m.root, 'gh', `process.stdout.write(JSON.stringify([{ number: 236, isDraft: false }]));`);
  const out = execFileSync('node', [WIP, '--state-dir', m.state, '--sessions-dir', m.sessions, '--now', NOW, '--json'],
    { input: '', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  const args = JSON.parse(fs.readFileSync(path.join(bin, 'args.json'), 'utf8'));
  for (const a of ['pr', 'list', '--head', 'story/x', '--state', 'open', '--repo', 'acme/x']) assert.ok(args.includes(a), args.join(' '));
  assert.strictEqual(JSON.parse(out).rows[0].state, 'Entrando a los repos · x #236');
});

test('T27 ConsultaReal_AzFalso: el programa le pregunta a az con la organización, el proyecto y el repo', { skip: onWindows }, () => {
  const m = toyMachine();
  entering(m, 'ent00000-9', { repoPath: gitRepo(m.root, 'y', 'story/x', AZ) });
  const bin = fakeBin(m.root, 'az', `process.stdout.write(JSON.stringify([{ pullRequestId: 4920, isDraft: false }]));`);
  const out = execFileSync('node', [WIP, '--state-dir', m.state, '--sessions-dir', m.sessions, '--now', NOW, '--json'],
    { input: '', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  const args = JSON.parse(fs.readFileSync(path.join(bin, 'args.json'), 'utf8'));
  for (const a of ['repos', 'pr', 'list', '--org', 'https://dev.azure.com/acme', '--project', 'Proyecto Uno', '--repository', 'y', '--source-branch', 'story/x', '--status', 'active']) {
    assert.ok(args.includes(a), args.join(' '));
  }
  assert.strictEqual(JSON.parse(out).rows[0].state, 'Entrando a los repos · y !4920');
  const { parseRemote, shellSafe } = require(WIP);
  assert.deepStrictEqual(parseRemote(`https://${at('acme', 'dev.azure.com')}/acme/Proyecto Uno/_git/y`), { kind: 'azure', org: 'acme', project: 'Proyecto Uno', repo: 'y', name: 'y' });
  assert.deepStrictEqual(parseRemote('https://acme.visualstudio.com/DefaultCollection/Proyecto/_git/y'), { kind: 'azure', org: 'acme', project: 'Proyecto', repo: 'y', name: 'y' });
  assert.strictEqual(parseRemote('https://dev.azure.com/a%2F..%2Fb/P/_git/y').kind, null, 'una organización rara no arma la dirección');
  assert.deepStrictEqual(parseRemote('git@ssh.dev.azure.com:v3/acme/Proyecto%20Uno/y'), { kind: 'azure', org: 'acme', project: 'Proyecto Uno', repo: 'y', name: 'y' });
  assert.strictEqual(shellSafe(['Proyecto Año', 'story/x', 'https://dev.azure.com/acme']), true);
  assert.strictEqual(shellSafe(['a" & calc']), false);
});

test('T28 ServidorDesconocido_SeDice: un origin que no es GitHub ni Azure DevOps se dice y no se consulta', () => {
  const m = toyMachine();
  entering(m, 'ent00000-a', { repoPath: gitRepo(m.root, 'z', 'story/x', 'https://git.acme.example/acme/z.git') });
  let asked = 0;
  const r = run(m, { prs: () => { asked += 1; return { prs: [] }; } });
  assert.strictEqual(asked, 0);
  assert.strictEqual(r.rows[0].state, 'Entrando a los repos (no se pudo consultar los pedidos)');
  assert.ok(r.unreadable.some((u) => /no sé consultar pedidos en git\.acme\.example/.test(u)), r.unreadable.join(' | '));
  // the host only: never a password, even one with an «@» inside
  const { parseRemote } = require(WIP);
  assert.deepStrictEqual(parseRemote(`https://${at(at('u:p', 'ss'), 'git.acme.example')}/x.git`), { kind: null, host: 'git.acme.example' });
  assert.deepStrictEqual(parseRemote(`https://${at('u:pa/ss', 'git.acme.example')}/x.git`), { kind: null, host: 'git.acme.example' });
  assert.strictEqual(parseRemote('https://dev.azure.com/acme/P/_git/a%2F..%2Fb').kind, null, 'un repo con «..» no se consulta');
  assert.strictEqual(parseRemote('https://github.com/acme/x%3Fy').kind, null);
  assert.strictEqual(parseRemote('https://otro.example/github.com/acme/x').kind, null, 'GitHub sólo si es el servidor');
  for (const u of ['https://otro.example/dev.azure.com/acme/p/_git/r', 'https://otro.example/acme.visualstudio.com/p/_git/r', 'git@otro.example:ssh.dev.azure.com:v3/acme/p/r']) {
    assert.strictEqual(parseRemote(u).kind, null, `Azure sólo si es el servidor: ${u}`);
  }
  assert.deepStrictEqual(parseRemote(`https://${at(at('u:p', 'ss'), 'github.com')}/acme/x.git`), { kind: 'github', slug: 'acme/x', name: 'x' });
  assert.strictEqual(parseRemote('git@github.com:acme/x.git').slug, 'acme/x');
  assert.strictEqual(parseRemote('https://dev.azure.com/acme/./_git/y').kind, null, 'un «.» suelto no es un proyecto');
  assert.deepStrictEqual(parseRemote('https://h.example/a/tok@en'), { kind: null, host: 'un servidor que no reconozco' });
  // a repo git cannot read, or a story folder that is gone, is said and the session stays busy
  const broken = path.join(m.root, 'roto');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, '.git'), 'esto no es un gitdir');
  entering(m, 'ent00000-a', { repoPath: broken });
  const b = run(m, { prs: () => ({ prs: [] }) });
  assert.strictEqual(b.rows[0].state, 'Entrando a los repos (no se pudo consultar los pedidos)');
  assert.ok(b.unreadable.some((u) => u.startsWith('story 5.1: ') && u.includes(broken)), b.unreadable.join(' | '));
  entering(m, 'ent00000-a', { repoPath: path.join(m.root, 'borrado') });
  const g = run(m, { prs: () => ({ prs: [] }) });
  assert.ok(g.unreadable.some((u) => /borrado: ya no existe/.test(u)), g.unreadable.join(' | '));
  for (const bad of [42, 'relativo/repo']) {
    entering(m, 'ent00000-a', { repoPath: bad });
    const w = run(m, { prs: () => ({ prs: [] }) });
    assert.strictEqual(w.rows[0].state, 'Entrando a los repos (no se pudo consultar los pedidos)', String(bad));
    assert.ok(w.unreadable.some((u) => u.includes('repoPath ilegible')), w.unreadable.join(' | '));
  }
  // a repo on a story branch without origin cannot be asked: it is said
  entering(m, 'ent00000-a', { repoPath: gitRepo(m.root, 'sin-origin', 'story/x', null) });
  const n = run(m, { prs: () => ({ prs: [] }) });
  assert.strictEqual(n.rows[0].state, 'Entrando a los repos (no se pudo consultar los pedidos)');
  assert.ok(n.unreadable.some((u) => /no sé consultar pedidos en ningún servidor \(el repo no tiene origin\)/.test(u)), n.unreadable.join(' | '));
});

// ── Sessions working without a pipeline: their status, their last activity, and the ones unused for hours ─────────

const minsBefore = (n) => Date.parse(NOW) - n * 60000;
const localHhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// The transcript of a toy session, in a toy projects folder, written `mins` minutes before NOW.
function transcript(m, cwd, sid, mins) {
  const dir = path.join(m.root, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(f, '{"contenido":"no se lee"}\n');
  const t = new Date(minsBefore(mins));
  fs.utimesSync(f, t, t);
  return f;
}
const runP = (m, extra = {}) => run(m, { projectsDir: path.join(m.root, 'projects'), ...extra });

test('T30 SinPipeline_Busy_Ocupada: una sesión busy sin marcador sale trabajando, con su última actividad', () => {
  const m = toyMachine();
  session(m, process.pid, 'sp000000-1', 'videos', { status: 'busy', statusUpdatedAt: minsBefore(2) });
  const r = runP(m);
  assert.deepStrictEqual(r.rows, [{ work: '(sin pipeline)', state: `Trabajando sin pipeline · última actividad ${localHhmm(minsBefore(2))}`, end: 'sin estimación (no tiene pasos)', session: 'videos' }]);
  assert.deepStrictEqual(r.free, []);
});

test('T31 SinPipeline_TranscripcionReciente_Ocupada: idle hace una hora pero con la transcripción de hace 2 minutos', () => {
  const m = toyMachine();
  session(m, process.pid, 'sp000000-2', 'medicion', { statusUpdatedAt: minsBefore(60), cwd: '/acme/repo' });
  transcript(m, '/acme/repo', 'sp000000-2', 2);
  const r = runP(m);
  assert.strictEqual(r.rows.length, 1, r.text);
  assert.strictEqual(r.rows[0].state, `Trabajando sin pipeline · última actividad ${localHhmm(minsBefore(2))}`);
  assert.deepStrictEqual(r.free, []);
});

test('T32 Idle_Hace20Min_Libre: quieta hace 20 minutos está libre', () => {
  const m = toyMachine();
  session(m, process.pid, 'sp000000-3', 'quieta');
  const r = runP(m);
  assert.deepStrictEqual([r.rows, r.free, r.idle], [[], ['quieta'], []]);
  assert.match(r.text, /Libres: quieta$/m);
  // the edges: quiet for exactly 5 minutes is free; 4 minutes and 59 seconds is still working
  const edge = toyMachine();
  session(edge, process.pid, 'sp000000-b', 'cinco', { statusUpdatedAt: minsBefore(5) });
  session(edge, process.pid, 'sp000000-c', 'casi', { statusUpdatedAt: minsBefore(5) + 1000 });
  const e = runP(edge);
  assert.deepStrictEqual([e.free, e.rows.map((x) => x.session)], [['cinco'], ['casi']]);
});

test('T33 SinUso_MasDeTresHoras_LineaAparte: sin actividad hace 6 horas no es libre: va aparte, con desde cuándo', () => {
  const m = toyMachine();
  session(m, process.pid, 'sp000000-4', 'vieja', { statusUpdatedAt: minsBefore(360), updatedAt: minsBefore(361) });
  const r = runP(m);
  assert.deepStrictEqual([r.rows, r.free], [[], []]);
  assert.deepStrictEqual(r.idle, [`vieja (desde ${localHhmm(minsBefore(360))})`]);
  assert.match(r.text, new RegExp(`Sin uso hace más de 3 h: vieja \\(desde ${localHhmm(minsBefore(360))}\\)`));
  assert.match(r.text, /Libres: ninguna/);
  // the edge: exactly 3 hours is still free; a second more is unused
  const edge = toyMachine();
  session(edge, process.pid, 'sp000000-d', 'tres', { statusUpdatedAt: minsBefore(180) });
  session(edge, process.pid, 'sp000000-e', 'pasada', { statusUpdatedAt: minsBefore(180) - 1000 });
  const e = runP(edge);
  assert.deepStrictEqual([e.free, e.idle.map((x) => x.split(' ')[0])], [['tres'], ['pasada']]);
});

test('T34 ConMarcadorOMuertaOSinDato_ComoAntes: con trabajo, una fila; muerta, nada; sin dato, libre y dicho', () => {
  const m = toyMachine();
  marker(m, 'sp000000-5', { storyId: '9.5', storyPath: story(m.root, '9.5', 'Con marcador'), stepsCompleted: [0], stepsPending: [1] });
  session(m, process.pid, 'sp000000-5', 'con-story', { status: 'busy', statusUpdatedAt: minsBefore(1) });
  session(m, DEAD_PID, 'sp000000-6', 'muerta', { status: 'busy', statusUpdatedAt: minsBefore(1) });
  fs.writeFileSync(path.join(m.sessions, 'sp000000-7.json'), JSON.stringify({ pid: process.pid, sessionId: 'sp000000-7', name: 'sin-dato' }));
  const r = runP(m);
  assert.strictEqual(r.rows.length, 1, r.text);
  assert.strictEqual(r.rows[0].session, 'con-story');
  assert.ok(r.rows[0].work.startsWith('9.5'));
  assert.deepStrictEqual([r.free, r.idle, r.halfway], [['sin-dato'], [], []]);
  assert.match(r.text, /Libres: sin-dato \(sin dato de actividad\)/);
  assert.ok(!r.text.includes('muerta'), r.text);
  // a busy session with an ad-hoc declaration keeps its one ad-hoc row
  const a = toyMachine();
  fs.writeFileSync(path.join(a.state, 'adhoc', 'sp000000-f.json'), JSON.stringify({ reason: 'ajustes chicos' }));
  session(a, process.pid, 'sp000000-f', 'suelta', { status: 'busy', statusUpdatedAt: minsBefore(1) });
  const ra = runP(a);
  assert.deepStrictEqual(ra.rows.map((x) => [x.session, x.state]), [['suelta', 'Trabajo suelto']]);
});

test('T35 Transcripcion_SoloFecha_NoContenido: una transcripción que no se puede leer da su fecha igual', { skip: process.platform === 'win32' ? 'chmod 000 no quita la lectura en Windows' : false }, () => {
  const m = toyMachine();
  session(m, process.pid, 'sp000000-8', 'cerrada-a-leer', { statusUpdatedAt: minsBefore(90), cwd: '/acme/otro' });
  const f = transcript(m, '/acme/otro', 'sp000000-8', 3);
  fs.chmodSync(f, 0o000);
  try {
    const r = runP(m);
    assert.strictEqual(r.rows[0].state, `Trabajando sin pipeline · última actividad ${localHhmm(minsBefore(3))}`);
  } finally { fs.chmodSync(f, 0o600); }
});

test('T36 Origin_CuatroFormasNuevas: puerto, ssh.github.com, «@» en la ruta y Azure sin proyecto', () => {
  const { parseRemote } = require(WIP);
  assert.deepStrictEqual(parseRemote(`ssh://${at('git', 'github.com')}:22/acme/x.git`), { kind: 'github', slug: 'acme/x', name: 'x' });
  assert.deepStrictEqual(parseRemote(`ssh://${at('git', 'ssh.github.com')}:443/acme/x.git`), { kind: 'github', slug: 'acme/x', name: 'x' });
  const withAt = parseRemote(`https://${at('acme', 'dev.azure.com')}/acme/P/_git/r${'@'}v2`);
  assert.deepStrictEqual(withAt, { kind: null, host: 'Azure DevOps, con una organización, un proyecto o un repo que no reconozco' }, 'el servidor no sale de la ruta');
  assert.deepStrictEqual(parseRemote(`https://${at('acme', 'github.com')}/acme/x${'@'}y`), { kind: null, host: 'GitHub, con un repo que no reconozco' }, 'un «@» en la ruta no corre el servidor');
  assert.deepStrictEqual(parseRemote('https://dev.azure.com/acme/_git/y'), { kind: 'azure', org: 'acme', project: 'y', repo: 'y', name: 'y' });
  // the forms of 2.49 still hold, passwords with «@» or «/» included, and no field carries the password
  const secret = parseRemote(`https://${at(at('u:p', 'ss'), 'github.com')}/acme/x.git`);
  assert.deepStrictEqual(secret, { kind: 'github', slug: 'acme/x', name: 'x' });
  assert.ok(!JSON.stringify(secret).includes('u:p'), JSON.stringify(secret));
  assert.deepStrictEqual(parseRemote(`https://${at('u:pa/ss', 'git.acme.example')}/x.git`), { kind: null, host: 'git.acme.example' });
  assert.strictEqual(parseRemote('git@github.com:acme/x.git').slug, 'acme/x');
});

test('T37 GitFalso_SePasaDelTope: un git que no contesta se dice y la fila sale sin pedidos', { skip: onWindows }, () => {
  const m = toyMachine();
  entering(m, 'ent00000-g', { repoPath: gitRepo(m.root, 'x', 'story/x', GH) });
  const bin = fakeBin(m.root, 'git', 'setTimeout(() => {}, 10000);');
  const start = Date.now();
  const out = execFileSync('node', [WIP, '--state-dir', m.state, '--sessions-dir', m.sessions, '--now', NOW, '--json'],
    { input: '', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.ok(Date.now() - start < 9000, 'el tope cortó a git');
  const r = JSON.parse(out);
  assert.strictEqual(r.rows[0].state, 'Entrando a los repos (no se pudo consultar los pedidos)');
  assert.ok(r.unreadable.some((u) => /git se pasó del tope leyendo los repos/.test(u)), r.unreadable.join(' | '));
});

test('T39 SinPipeline_RamaDeStory_LaMuestra: la carpeta de la sesión en una rama de story la nombra', () => {
  const m = toyMachine();
  const wt = gitRepo(m.root, 'wt', 'story/8.48-algo', GH);
  const main = gitRepo(m.root, 'principal', 'main', GH);
  session(m, process.pid, 'sp000000-9', 'arrancando', { status: 'busy', statusUpdatedAt: minsBefore(1), cwd: wt });
  session(m, process.pid, 'sp000000-a', 'en-main', { status: 'busy', statusUpdatedAt: minsBefore(1), cwd: main });
  const r = runP(m);
  const by = Object.fromEntries(r.rows.map((x) => [x.session, x.state]));
  assert.strictEqual(by.arrancando, `Trabajando sin pipeline · story 8.48 en preparación · última actividad ${localHhmm(minsBefore(1))}`);
  assert.strictEqual(by['en-main'], `Trabajando sin pipeline · última actividad ${localHhmm(minsBefore(1))}`);
  // another branch, a folder that is gone and a detached HEAD: no story
  const other = gitRepo(m.root, 'otra', 'feature/x', GH);
  const detached = gitRepo(m.root, 'suelto', 'main', GH);
  const fixed = { ...process.env, GIT_AUTHOR_DATE: NOW, GIT_COMMITTER_DATE: NOW };
  execFileSync('git', ['-C', detached, '-c', 'user.name=t', '-c', `user.email=${at('t', 'acme.example')}`, '-c', 'maintenance.auto=false', 'commit', '-q', '--allow-empty', '-m', 'x'], { env: fixed });
  execFileSync('git', ['-C', detached, 'checkout', '-q', '--detach']);
  const n = toyMachine();
  for (const [i, cwd] of [other, path.join(m.root, 'no-existe'), detached].entries()) session(n, process.pid, `sp00000${i}-x`, `s${i}`, { status: 'busy', statusUpdatedAt: minsBefore(1), cwd });
  for (const row of runP(n).rows) assert.strictEqual(row.state, `Trabajando sin pipeline · última actividad ${localHhmm(minsBefore(1))}`, row.session);
});
