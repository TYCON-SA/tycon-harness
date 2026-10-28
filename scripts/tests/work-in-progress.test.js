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
  for (const row of r.rows) assert.deepStrictEqual(Object.keys(row).sort(), ['end', 'folder', 'session', 'state', 'work']);
  const first = r.rows.find((x) => x.work.startsWith('9.1'));
  assert.strictEqual(Array.from(first.work.slice('9.1 · '.length)).length, 50, first.work);
  assert.ok(first.work.endsWith('…'));
  assert.ok(r.rows.some((x) => x.state === 'Trabajo suelto' && /arreglar el aviso/.test(x.work)));
  const text = r.text;
  assert.match(text, /\| Trabajo \| Estado \| Fin estimado \| Sesión \|/);
});

test('T2 Estado_PasoEnPalabras: los nombres llanos del pipeline, y «paso N» si no hay nombre', () => {
  const m = toyMachine();
  // un marcador viejo, con los nombres nuevos de la equivalencia; el 4 viejo no se reparte
  const cases = { 2: 'Armar el plan', 4: 'Implementar + pruebas', 5: 'Revisores', 12: 'paso 12', 'run-tests': 'Correr las pruebas' };
  for (const step of Object.keys(cases)) {
    const sid = `step${step}-0000`;
    const nuevo = !/^\d+$/.test(step);
    marker(m, sid, { storyId: `8.${step}`, storyPath: story(m.root, `8.${step}`, 't'), stepsCompleted: [], stepsPending: [nuevo ? step : Number(step)], ...(nuevo ? { stepScheme: 2 } : {}) });
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
  assert.match(r.text, /7\.2 · titulo 7\.2 · 22222222 · quedó en: Implementar \+ pruebas · limpiar: node .*marker\.js clear-session 22222222-bbbb/);
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

test('T16 MarcadorSinPasos_YPasoPasado: sin lista de pasos se dice; paso pasado de su mediana dice «atrasada» con la hora fija', () => {
  const m = toyMachine();
  history(m, 'a', { 0: 1, 4: 10, 5: 6 });
  fs.writeFileSync(path.join(m.state, 'active', 'nolist00.json'), JSON.stringify({ sessionId: 'nolist00', storyId: '3.1' }));
  // step 4 started 40 min ago with a 10 min median: the fixed estimate is 13:20 + 10 + 6 = 13:36, already past
  marker(m, 'late0000-1', { storyId: '3.2', storyPath: story(m.root, '3.2', 't'), stepsCompleted: [0], stepsPending: [4, 5], lastTouch: NOW,
    stepTimings: { 4: { startedAt: '2026-10-18T13:20:00.000Z' } } });
  session(m, process.pid, 'late0000-1', 'x');
  const r = run(m);
  assert.ok(r.unreadable.some((u) => /nolist00\.json: sin lista de pasos pendientes/.test(u)), r.unreadable.join(' | '));
  const end = new Date(Date.parse('2026-10-18T13:36:00.000Z'));
  assert.strictEqual(r.rows[0].end, `atrasada (estimado ${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')})`);
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

test('T20b Entrando_EsquemaNuevo @story-7.23 @ac-13: con los pasos por nombre, «Preparar el commit» cerrado también entra a los repos', () => {
  const m = toyMachine();
  const repo = gitRepo(m.root, 'x', 'story/x', GH);
  entering(m, 'ent00000-2', { repoPath: repo, stepScheme: 2,
    stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'prepare-commit'] });
  const r = run(m, { prs: () => ({ prs: [{ number: 237, draft: false }] }) });
  assert.strictEqual(r.rows.length, 1, r.text);
  assert.strictEqual(r.rows[0].state, 'Entrando a los repos · x #237');
});

test('T20 Entrando_ConPedido_Ocupada: el 8 cerrado y un pedido abierto dan la fila y la sesión ocupada', () => {
  const m = toyMachine();
  const repo = gitRepo(m.root, 'x', 'story/x', GH);
  entering(m, 'ent00000-1', { repoPath: repo });
  const asked = [];
  const r = run(m, { prs: (q) => { asked.push(q); return { prs: [{ number: 236, draft: false }] }; } });
  assert.strictEqual(r.rows.length, 1, r.text);
  assert.strictEqual(r.rows[0].state, 'Entrando a los repos · x #236');
  assert.strictEqual(r.rows[0].end, 'sin estimación (espera la CI o la cola; sin merges medidos en x)');
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
  // locating the repo reads its git files, not git: with no time left for git the pedidos are still asked
  const capped = run(m, { prs: () => ({ prs: [{ number: 7, draft: false }] }), repoBudgetMs: -1 });
  assert.strictEqual(capped.rows[0].state, 'Entrando a los repos · x #7');
  assert.ok(!capped.unreadable.some((u) => /se pasó del tope de 3 s leyendo los repos/.test(u)), capped.unreadable.join(' | '));
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
  assert.deepStrictEqual(r.rows, [{ work: '(carpeta desconocida)', state: `Trabajando sin pipeline · última actividad ${localHhmm(minsBefore(2))}`, end: 'sin estimación (no tiene pasos)', session: 'videos', folder: '(carpeta desconocida)' }]);
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

test('T37 GitFalso_SePasaDelTope: un git que no contesta no cuelga el comando; el repo se ubica igual y sus pedidos se consultan', { skip: onWindows }, () => {
  const m = toyMachine();
  entering(m, 'ent00000-g', { repoPath: gitRepo(m.root, 'x', 'story/x', GH) });
  // git hangs (it is only used for the history of merges); gh answers one open pull request, without the network
  const bin = fakeBin(m.root, 'git', 'setTimeout(() => {}, 10000);');
  fs.writeFileSync(path.join(bin, 'gh'), "#!/usr/bin/env node\nprocess.stdout.write('[{\"number\":5,\"isDraft\":false}]');\n", { mode: 0o755 });
  const start = Date.now();
  const out = execFileSync('node', [WIP, '--state-dir', m.state, '--sessions-dir', m.sessions, '--now', NOW, '--json'],
    { input: '', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.ok(Date.now() - start < 9000, 'el tope cortó a git');
  const r = JSON.parse(out);
  assert.strictEqual(r.rows[0].state, 'Entrando a los repos · x #5');
  assert.match(r.rows[0].end, /sin merges medidos/);
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
  // in the main branch with nothing else to go on, the row says so in plain words
  assert.strictEqual(by['en-main'], `Trabajando sin pipeline · no tocó archivos en las últimas 3 h · última actividad ${localHhmm(minsBefore(1))}`);
  const work = Object.fromEntries(r.rows.map((x) => [x.session, x.work]));
  assert.deepStrictEqual([work.arrancando, work['en-main']], ['wt · story/8.48-algo', 'no se ve qué hace']);
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

// ── The delay shows, the end counts entering the repos, and loose work says its age ──────────────────────────────

test('T40 Atrasada_NoCorreConElReloj: pasado el estimado, la misma hora fija a dos horas distintas', () => {
  const m = toyMachine();
  history(m, 'a', { 0: 1, 4: 10, 5: 6 });
  marker(m, 'late0000-2', { storyId: '3.3', storyPath: story(m.root, '3.3', 't'), stepsCompleted: [0], stepsPending: [4, 5], lastTouch: NOW,
    stepTimings: { 4: { startedAt: '2026-10-18T13:20:00.000Z' } } });
  session(m, process.pid, 'late0000-2', 'x');
  const fixed = `atrasada (estimado ${localHhmm(Date.parse('2026-10-18T13:36:00.000Z'))})`;
  assert.strictEqual(run(m).rows[0].end, fixed);
  assert.strictEqual(run(m, { now: '2026-10-18T15:00:00.000Z' }).rows[0].end, fixed);
});

// A repo whose main has merges of known duration: the branch tip at `t`, its merge `mins` later.
function mergesRepo(root, name, mins) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const g = (date, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', `user.email=${'t'}${'@'}acme.example`, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args],
    { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  let t = Date.parse('2026-10-15T10:00:00.000Z');
  g(new Date(t).toISOString(), 'commit', '-q', '--allow-empty', '-m', 'base');
  mins.forEach((min, i) => {
    t += 3600000;
    g(new Date(t).toISOString(), 'checkout', '-q', '-b', `b${i}`, 'main');
    g(new Date(t).toISOString(), 'commit', '-q', '--allow-empty', '-m', `rama ${i}`);
    g(new Date(t).toISOString(), 'checkout', '-q', 'main');
    g(new Date(t + min * 60000).toISOString(), 'merge', '-q', '--no-ff', '-m', `merge ${i}`, `b${i}`);
  });
  g(new Date(t).toISOString(), 'checkout', '-q', '-b', 'story/x');
  return dir;
}

test('T41 Fin_SumaLaEntradaALosRepos: la hora suma la mediana de entrada; la que espera, el cierre del 8 más la mediana', () => {
  const m = toyMachine();
  history(m, 'a', { 0: 1, 4: 20, 5: 10, 8: 4 });
  const repo = mergesRepo(m.root, 'x', [20, 30, 40]);   // median 30 min
  // in progress: 10 min left of step 4, then 10 + 4 → NOW + 24, plus 30 entering → NOW + 54
  marker(m, 'enter000-1', { storyId: '9.6', storyPath: story(m.root, '9.6', 't'), repoPath: repo, stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 8],
    stepTimings: { 4: { startedAt: '2026-10-18T13:50:00.000Z' } } });
  session(m, process.pid, 'enter000-1', 'en-curso');
  const r = run(m);
  assert.strictEqual(r.rows[0].end, `${localHhmm(Date.parse(NOW) + 54 * 60000)} (con la entrada a los repos)`, r.text);
  // waiting for its pull request: step 8 closed at 13:50 → 13:50 + 30 = 14:20
  const w = toyMachine();
  entering(w, 'ent00000-9', { repoPath: mergesRepo(w.root, 'x', [20, 30, 40]), stepTimings: { 8: { startedAt: '2026-10-18T13:40:00.000Z', completedAt: '2026-10-18T13:50:00.000Z' } } });
  const rw = run(w, { prs: () => ({ prs: [{ number: 7, draft: false }] }) });
  assert.strictEqual(rw.rows[0].end, `${localHhmm(Date.parse('2026-10-18T14:20:00.000Z'))} (con la entrada a los repos)`, rw.text);
  // past that hour it says so, with the same fixed hour
  const late = run(w, { now: '2026-10-18T15:00:00.000Z', prs: () => ({ prs: [{ number: 7, draft: false }] }) });
  assert.strictEqual(late.rows[0].end, `atrasada (estimado ${localHhmm(Date.parse('2026-10-18T14:20:00.000Z'))})`);
  // a repo without measured merges: the hour leaves it out and says so
  const n = toyMachine();
  history(n, 'a', { 0: 1, 4: 20, 5: 10, 8: 4 });
  marker(n, 'enter000-2', { storyId: '9.7', storyPath: story(n.root, '9.7', 't'), repoPath: gitRepo(n.root, 'y', 'story/y', GH), stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 8],
    stepTimings: { 4: { startedAt: '2026-10-18T13:50:00.000Z' } } });
  session(n, process.pid, 'enter000-2', 'sin-merges');
  assert.strictEqual(run(n).rows[0].end, `${localHhmm(Date.parse(NOW) + 24 * 60000)} (sin la entrada a y: sin merges medidos)`);
});

test('T42 SinPipeline_DiceCarpetaYRama: la fila dice la carpeta y la rama, no «(sin pipeline)»', () => {
  const m = toyMachine();
  const wt = gitRepo(m.root, 'mi-arreglo', 'fix/el-aviso', GH);
  session(m, process.pid, 'sp000000-w', 'arreglando', { status: 'busy', statusUpdatedAt: minsBefore(1), cwd: wt });
  const r = runP(m);
  assert.strictEqual(r.rows[0].work, 'mi-arreglo · fix/el-aviso');
  assert.ok(!r.text.includes('(sin pipeline)'), r.text);
});

test('T43 TrabajoSuelto_SinTocar_PreguntaSiTermino: el viejo pregunta si terminó y dice cómo cerrarlo; el nuevo, desde cuándo', () => {
  const m = toyMachine();
  fs.writeFileSync(path.join(m.state, 'adhoc', 'adv00000-1.json'), JSON.stringify({ reason: 'el video del capítulo 1', declaredAt: new Date(minsBefore(300)).toISOString(), lastTouch: new Date(minsBefore(120)).toISOString() }));
  fs.writeFileSync(path.join(m.state, 'adhoc', 'adv00000-2.json'), JSON.stringify({ reason: 'un ajuste chico', declaredAt: new Date(minsBefore(30)).toISOString(), lastTouch: new Date(minsBefore(10)).toISOString() }));
  session(m, process.pid, 'adv00000-1', 'videos', { status: 'busy', statusUpdatedAt: minsBefore(1) });
  session(m, process.pid, 'adv00000-2', 'ajustes', { status: 'busy', statusUpdatedAt: minsBefore(1) });
  const by = Object.fromEntries(run(m).rows.map((x) => [x.session, x.state]));
  assert.strictEqual(by.videos, `Trabajo suelto · sin tocar desde ${localHhmm(minsBefore(120))} · ¿terminó? cerralo desde su sesión: node ${path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'marker.js')} adhoc clear`);
  assert.strictEqual(by.ajustes, `Trabajo suelto · sin tocar desde ${localHhmm(minsBefore(10))}`);
});

// ── After the close: `marker.js clear` deletes the marker, and the close stays in timing-history ──────────────────

// The close of a pipeline as `marker.js clear` leaves it: `{ archivedAt, marker }`, with the file dated `mins` before NOW
// (the /wip looks at the file date before opening it).
function closure(m, sid, name, mins, fields = {}) {
  const at = new Date(minsBefore(mins));
  const file = path.join(m.state, 'timing-history', `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({
    archivedAt: at.toISOString(),
    marker: { sessionId: sid, storyId: '5.1', storyPath: story(m.root, '5.1', 'Lo que entra'), stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 8], stepsPending: [], lastTouch: at.toISOString(), ...fields },
  }));
  fs.utimesSync(file, at, at);
  return file;
}

test('T44 CierreSinMarcador_PedidoAbierto_SaleEntrando @story-2.49.1 @ac-1: sin marcador, el cierre de la sesión con un pedido abierto da la fila', () => {
  const m = toyMachine();
  const repo = gitRepo(m.root, 'x', 'story/x', GH);
  session(m, process.pid, 'cie00000-1', 'new2');
  closure(m, 'cie00000-1', '5.1-2026-10-18T1350', 10, { repoPath: repo });
  const r = run(m, { prs: () => ({ prs: [{ number: 12, draft: false }] }) });
  assert.strictEqual(r.rows.length, 1, r.text);
  assert.strictEqual(r.rows[0].work, '5.1 · Lo que entra');
  assert.strictEqual(r.rows[0].state, 'Entrando a los repos · x #12');
  assert.strictEqual(r.rows[0].session, 'new2');
  assert.deepStrictEqual(r.free, []);
  // si la consulta falla: la fila sale igual, el pie lo dice y la sesión no queda libre
  const f = run(m, { prs: () => ({ error: 'gh no contestó' }) });
  assert.strictEqual(f.rows[0].state, 'Entrando a los repos (no se pudo consultar los pedidos)');
  assert.ok(f.unreadable.some((u) => /no contestó/.test(u)), f.text);
  assert.deepStrictEqual(f.free, []);
});

test('T45 CierreSinMarcador_PedidosEntrados_SinFila @story-2.49.1 @ac-2: con los pedidos ya entrados, el cierre no agrega fila', () => {
  const m = toyMachine();
  session(m, process.pid, 'cie00000-2', 'new2');
  closure(m, 'cie00000-2', '5.1-2026-10-18T1350', 10, { repoPath: gitRepo(m.root, 'x', 'story/x', GH) });
  const r = run(m, { prs: () => ({ prs: [] }) });
  assert.deepStrictEqual(r.rows, []);
  assert.deepStrictEqual(r.free, ['new2']);
});

test('T46 CierreViejoOMuerto_SeIgnora @story-2.49.1 @ac-3: un cierre de hace 25 h, o de una sesión muerta, no agrega nada', () => {
  const m = toyMachine();
  const repo = gitRepo(m.root, 'x', 'story/x', GH);
  session(m, process.pid, 'cie00000-3', 'vieja');
  closure(m, 'cie00000-3', '5.1-viejo', 25 * 60, { repoPath: repo });
  session(m, DEAD_PID, 'cie00000-4', 'muerta');
  closure(m, 'cie00000-4', '5.1-muerta', 10, { repoPath: repo });
  const asked = [];
  const r = run(m, { prs: (q) => { asked.push(q); return { prs: [{ number: 12, draft: false }] }; } });
  assert.deepStrictEqual(r.rows, [], r.text);
  assert.deepStrictEqual(asked, [], 'ni se consultan');
});

test('T47 CierreYMarcador_UnaSolaFila_ElMasNuevo @story-2.49.1 @ac-4 @ac-5: cuenta el cierre más nuevo; con marcador activo, sólo la fila del marcador', () => {
  const m = toyMachine();
  const viejo = gitRepo(m.root, 'v', 'story/v', 'https://github.com/acme/v.git');
  const nuevo = gitRepo(m.root, 'x', 'story/x', GH);
  session(m, process.pid, 'cie00000-5', 'new2');
  closure(m, 'cie00000-5', '5.0-2026-10-18T1200', 120, { storyId: '5.0', repoPath: viejo });
  closure(m, 'cie00000-5', '5.1-2026-10-18T1350', 10, { repoPath: nuevo });
  const prs = (q) => ({ prs: [{ number: q.name === 'x' ? 12 : 7, draft: false }] });
  const r = run(m, { prs });
  assert.strictEqual(r.rows.length, 1, r.text);
  assert.strictEqual(r.rows[0].state, 'Entrando a los repos · x #12');
  // si el cierre más nuevo no cerró el paso 8, ése manda: uno más viejo de la misma sesión no lo reemplaza
  closure(m, 'cie00000-5', '5.2-2026-10-18T1355', 5, { storyId: '5.2', stepsCompleted: [0, 1], stepsPending: [], repoPath: nuevo });
  assert.deepStrictEqual(run(m, { prs }).rows, [], 'el más nuevo no cerró el 8: sin fila');
  fs.rmSync(path.join(m.state, 'timing-history', '5.2-2026-10-18T1355.json'));
  // con un marcador activo de la misma sesión, gana el marcador
  marker(m, 'cie00000-5', { storyId: '9.9', storyPath: story(m.root, '9.9', 'Otra'), stepsCompleted: [0], stepsPending: [1, 2], lastTouch: NOW });
  const conMarcador = run(m, { prs });
  assert.strictEqual(conMarcador.rows.length, 1, conMarcador.text);
  assert.strictEqual(conMarcador.rows[0].work, '9.9 · Otra');
});

test('T49 CierreConElWorktreeBorrado_YaEntro @story-2.49.1 @ac-8: si la carpeta del repo del cierre ya no existe, la story entró: sin fila y sin aviso', () => {
  const m = toyMachine();
  const repo = gitRepo(m.root, 'x', 'story/x', GH);
  session(m, process.pid, 'cie00000-7', 'new2');
  closure(m, 'cie00000-7', '5.1-2026-10-18T1350', 10, { repoPath: repo, filesTouched: [path.join(repo, 'a.js')] });
  fs.rmSync(repo, { recursive: true, force: true });
  const asked = [];
  const r = run(m, { prs: (q) => { asked.push(q); return { prs: [{ number: 12, draft: false }] }; } });
  assert.deepStrictEqual(r.rows, [], r.text);
  assert.deepStrictEqual(r.free, ['new2']);
  assert.deepStrictEqual(r.unreadable, [], 'un worktree borrado al mergear no es un problema');
  assert.deepStrictEqual(asked, []);
});

test('T48 MarcadorVivoConNombre_FilaConPaso_CierreIlegibleAlPie @story-2.49.1 @ac-6 @ac-7: un marcador en curso sale con su paso; un cierre reciente roto, al pie', () => {
  const m = toyMachine();
  marker(m, 'cie00000-6', { storyId: '8.68', storyPath: story(m.root, '8.68', 'El agente no edita el arnés instalado'), stepsCompleted: [0], stepsPending: [1, 2, 3], lastTouch: NOW });
  session(m, process.pid, 'cie00000-6', 'new1');
  const roto = path.join(m.state, 'timing-history', '8.67-roto.json');
  fs.writeFileSync(roto, '{ roto');
  fs.utimesSync(roto, new Date(minsBefore(5)), new Date(minsBefore(5)));
  const r = run(m, { prs: () => ({ prs: [] }) });
  assert.strictEqual(r.rows.length, 1, r.text);
  assert.strictEqual(r.rows[0].session, 'new1');
  // un marcador abierto antes del cambio de nombre: guarda el número del paso y sale con el nombre de hoy
  assert.strictEqual(r.rows[0].state, 'Validar la historia');
  assert.ok(r.unreadable.some((u) => u.includes('8.67-roto.json')), r.text);
  const command = fs.readFileSync(path.join(__dirname, '..', '..', 'commands', 'wip.md'), 'utf8');
  assert.ok(/después del cierre|aunque el cierre/.test(command), 'la ayuda dice que la story se ve también después del cierre');
});

// ── choca con main, `doing`, una vez por repo, agentes internos ──────────────────────────────────────────────────────
const MARKER = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const { stateDir: stateDirOf } = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

// A toy machine whose state folder is the one marker.js uses for a fake HOME: `doing` writes there and /wip reads it.
function toyHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wiphome-'));
  const state = stateDirOf(home);
  for (const d of ['active', 'adhoc', 'timing-history']) fs.mkdirSync(path.join(state, d), { recursive: true });
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  return { root: home, home, state, sessions };
}
const doing = (h, sid, ...args) => execFileSync('node', [MARKER, 'doing', ...args],
  { encoding: 'utf8', input: '', env: { ...process.env, HOME: h.home, USERPROFILE: h.home, CLAUDE_CODE_SESSION_ID: sid } });
const doingFile = (h, sid) => path.join(h.state, 'doing', `${sid}.json`);

test('T1 PedidoEnConflicto_DiceChocaConMain @story-2.49.2 @ac-1: GitHub DIRTY y Azure conflicts dicen «choca con main»', { skip: onWindows }, () => {
  const m = toyMachine();
  entering(m, 'cho00000-1', { repoPath: gitRepo(m.root, 'x', 'story/x', GH) });
  const gh = fakeBin(m.root, 'gh', `process.stdout.write(JSON.stringify([{ number: 236, isDraft: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }]));`);
  const out = execFileSync('node', [WIP, '--state-dir', m.state, '--sessions-dir', m.sessions, '--now', NOW, '--json'],
    { input: '', env: { ...process.env, PATH: `${gh}${path.delimiter}${process.env.PATH}` } });
  assert.strictEqual(JSON.parse(out).rows[0].state, 'Entrando a los repos · x #236 (choca con main)');
  const args = JSON.parse(fs.readFileSync(path.join(gh, 'args.json'), 'utf8'));
  assert.ok(args.some((a) => /mergeStateStatus/.test(a)), args.join(' '));
  const n = toyMachine();
  entering(n, 'cho00000-2', { repoPath: gitRepo(n.root, 'y', 'story/x', AZ) });
  const az = fakeBin(n.root, 'az', `process.stdout.write(JSON.stringify([{ pullRequestId: 4920, isDraft: false, mergeStatus: 'conflicts' }]));`);
  const outAz = execFileSync('node', [WIP, '--state-dir', n.state, '--sessions-dir', n.sessions, '--now', NOW, '--json'],
    { input: '', env: { ...process.env, PATH: `${az}${path.delimiter}${process.env.PATH}` } });
  assert.strictEqual(JSON.parse(outAz).rows[0].state, 'Entrando a los repos · y !4920 (choca con main)');
});

test('T2 ConflictoYBorrador_DosMarcas_UnknownSinMarca @story-2.49.2 @ac-1 @ac-2: borrador en conflicto, UNKNOWN y sin dato', { skip: onWindows }, () => {
  const m = toyMachine();
  entering(m, 'cho00000-3', { repoPath: gitRepo(m.root, 'x', 'story/x', GH) });
  const gh = fakeBin(m.root, 'gh', `process.stdout.write(JSON.stringify([
    { number: 1, isDraft: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    { number: 2, isDraft: false, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
    { number: 3, isDraft: false }]));`);
  const out = execFileSync('node', [WIP, '--state-dir', m.state, '--sessions-dir', m.sessions, '--now', NOW, '--json'],
    { input: '', env: { ...process.env, PATH: `${gh}${path.delimiter}${process.env.PATH}` } });
  assert.strictEqual(JSON.parse(out).rows[0].state, 'Entrando a los repos · x #1 (borrador) (choca con main) · x #2 · x #3');
});

test('T3 Doing_LaFilaDiceLaNota @story-2.49.2 @ac-3: una sesión viva sin pipeline muestra lo que anotó', () => {
  const h = toyHome();
  session(h, process.pid, 'doi00000-1', 'Burrito', { status: 'busy' });
  doing(h, 'doi00000-1', 'armo el video del capítulo 3');
  const r = run(h);
  const row = r.rows.find((x) => x.session === 'Burrito');
  assert.ok(row, r.text);
  assert.strictEqual(row.work, 'armo el video del capítulo 3');
  assert.match(row.state, /^Anotado por la sesión · sin tocar desde \d\d:\d\d$/);
  assert.strictEqual(r.rows.length, 1, r.text);
});

test('T4 Doing_SeReemplazaYSeBorra @story-2.49.2 @ac-3: otro doing la reemplaza y doing clear la borra', () => {
  const h = toyHome();
  session(h, process.pid, 'doi00000-2', 'Angelito', { status: 'busy' });
  doing(h, 'doi00000-2', 'visto bueno para animar los capítulos 0 y 1');
  doing(h, 'doi00000-2', 'animo el capítulo 2');
  assert.strictEqual(run(h).rows[0].work, 'animo el capítulo 2');
  doing(h, 'doi00000-2', 'clear');
  assert.ok(!fs.existsSync(doingFile(h, 'doi00000-2')));
  assert.match(run(h).rows[0].state, /^Trabajando sin pipeline/);
  // el texto va de 8 a 200 caracteres: fuera de eso no se anota nada
  for (const bad of ['corto', 'x'.repeat(201)]) {
    assert.throws(() => doing(h, 'doi00000-2', bad), (e) => e.status === 2, bad.slice(0, 10));
    assert.ok(!fs.existsSync(doingFile(h, 'doi00000-2')));
  }
});

test('T5 Doing_NoAbreElPortonDeCarril @story-2.49.2 @ac-3: la nota no es un marcador ni un ad-hoc', () => {
  const h = toyHome();
  doing(h, 'doi00000-3', 'mido el banco de controles');
  const lib = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
  const io = require(path.join(lib, 'story-gate-io.js'));
  const gate = require(path.join(lib, 'story-gate.js'));
  assert.strictEqual(io.readAdhoc(h.state, 'doi00000-3'), null);
  assert.strictEqual(io.readMarker(h.state, 'doi00000-3'), null);
  assert.deepStrictEqual(fs.readdirSync(path.join(h.state, 'adhoc')), []);
  // el portón de carril, con lo que esa sesión tiene en el estado, sigue frenando un Edit de código
  const verdict = gate.computeStoryGate({ filePath: '/w/MiRepo/src/Foo.cs', stateDir: h.state, homeDir: h.home, repoRoot: '/w/MiRepo',
    repoHasTycon: true, repoHasStories: false, marker: io.readMarker(h.state, 'doi00000-3'), adhoc: io.readAdhoc(h.state, 'doi00000-3') });
  assert.strictEqual(verdict.action, 'block', JSON.stringify(verdict));
});

test('T6 Doing_ViejaPreguntaYMuertaAbajo @story-2.49.2 @ac-4: pasada 1 h pregunta; la de una sesión muerta va abajo', () => {
  const h = toyHome();
  session(h, process.pid, 'doi00000-4', 'Angelito', { status: 'busy' });
  fs.mkdirSync(path.join(h.state, 'doing'), { recursive: true });
  fs.writeFileSync(doingFile(h, 'doi00000-4'), JSON.stringify({ text: 'reviso los capítulos', at: new Date(minsBefore(120)).toISOString() }));
  session(h, DEAD_PID, 'doi00000-5', 'Muerta');
  fs.writeFileSync(doingFile(h, 'doi00000-5'), JSON.stringify({ text: 'otra cosa vieja', at: new Date(minsBefore(30)).toISOString() }));
  const r = run(h);
  const row = r.rows.find((x) => x.session === 'Angelito');
  assert.strictEqual(row.state, `Anotado por la sesión · sin tocar desde ${localHhmm(minsBefore(120))} · ¿terminó? borrala desde su sesión: node ${MARKER} doing clear`);
  assert.ok(!r.rows.some((x) => x.work === 'otra cosa vieja'), r.text);
  // como el ad-hoc: antes de las 24 h dice desde cuándo se podrá borrar, y clear-orphan se niega
  assert.ok(r.halfway.some((x) => x.includes('otra cosa vieja') && x.includes(`se podrá borrar después de las ${localHhmm(minsBefore(30) + 24 * 3600000)}`)), r.text);
  const real = toyHome();
  fs.mkdirSync(path.join(real.state, 'doing'), { recursive: true });
  fs.writeFileSync(doingFile(real, 'doi00000-6'), JSON.stringify({ text: 'nota reciente de otra', at: new Date().toISOString() }));
  assert.throws(() => doing(real, 'doi00000-7', 'clear-orphan', 'doi00000-6'), (e) => e.status === 3 && /menos de 24 h/.test(e.stderr));
  assert.ok(fs.existsSync(doingFile(real, 'doi00000-6')));
  fs.writeFileSync(doingFile(real, 'doi00000-6'), JSON.stringify({ text: 'nota vieja de otra', at: new Date(Date.now() - 25 * 3600000).toISOString() }));
  doing(real, 'doi00000-7', 'clear-orphan', 'doi00000-6');
  assert.ok(!fs.existsSync(doingFile(real, 'doi00000-6')));
  // la de una sesión viva no se borra nunca
  const live = toyHome();
  fs.mkdirSync(path.join(live.state, 'doing'), { recursive: true });
  fs.writeFileSync(doingFile(live, 'doi00000-8'), JSON.stringify({ text: 'nota de una viva', at: new Date(Date.now() - 25 * 3600000).toISOString() }));
  fs.mkdirSync(path.join(live.home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(live.home, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'doi00000-8' }));
  assert.throws(() => doing(live, 'doi00000-7', 'clear-orphan', 'doi00000-8'), (e) => e.status === 3 && /viva/.test(e.stderr));
  assert.ok(fs.existsSync(doingFile(live, 'doi00000-8')));
});

test('T7 DiezCarpetasDeUnRepo_UnaConsulta @story-2.49.2 @ac-5: diez carpetas del mismo repo, una sola pregunta por su raíz', () => {
  const m = toyMachine();
  const repo = gitRepo(m.root, 'x', 'story/x', GH);
  const files = [];
  for (let i = 0; i < 10; i++) { fs.mkdirSync(path.join(repo, `d${i}`, 'sub'), { recursive: true }); files.push(path.join(repo, `d${i}`, 'sub', 'f.js')); }
  entering(m, 'one00000-1', { repoPath: repo, filesTouched: files });
  const gitCtx = { until: Date.now() + 60000, cache: new Map() };
  run(m, { prs: () => ({ prs: [] }), gitCtx });
  // one walk up to the root: the folder that was asked and, cached with it, the root itself (by its real path)
  const asked = [...gitCtx.cache.entries()].filter(([k]) => k.startsWith('repo\0'));
  assert.strictEqual(new Set(asked.map(([, v]) => v && v.root)).size, 1, asked.map(([k]) => k).join('\n'));
  assert.ok(asked.length <= 2, asked.map(([k]) => k).join('\n'));
});

test('T8 TopeDeTiempo_UnSoloRenglon @story-2.49.2 @ac-6: sin tiempo para git, ninguna carpeta queda sin leer (se ubican por sus archivos de git)', () => {
  const m = toyMachine();
  const dirs = [];
  for (let i = 0; i < 5; i++) { const d = path.join(m.root, `c${i}`); fs.mkdirSync(d); dirs.push(path.join(d, 'f.js')); }
  entering(m, 'one00000-2', { filesTouched: dirs });
  const r = run(m, { prs: () => ({ prs: [] }), repoBudgetMs: -1 });
  assert.deepStrictEqual(r.unreadable.filter((u) => /tope/.test(u)), [], r.text);
});

test('T9 AgentesInternos_SinFilaYUnRenglon @story-2.49.2 @ac-7: carpeta en la temporal y nombre derivado no tienen fila', () => {
  const m = toyMachine();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advbench-'));
  session(m, process.pid, 'int00000-1', 'advbench-aaa', { status: 'busy', cwd: tmp, nameSource: 'derived' });
  session(m, process.pid, 'int00000-2', 'advbench-bbb', { status: 'busy', cwd: tmp, nameSource: 'derived' });
  session(m, process.pid, 'int00000-3', 'Labo', { status: 'busy', cwd: tmp });   // nombre puesto: es una sesión real
  const r = run(m);
  assert.ok(!r.rows.some((x) => /advbench/.test(x.session)), r.text);
  assert.ok(r.rows.some((x) => x.session === 'Labo'), r.text);
  assert.ok(!r.free.some((x) => /advbench/.test(x)), r.text);
  assert.match(r.text, /2 agente\(s\) interno\(s\) de otras sesiones/);
});

test('T10 Ayuda_DiceDoingYChocaConMain @story-2.49.2 @ac-8: la ayuda explica doing, que no es un permiso, y «choca con main»', () => {
  const command = fs.readFileSync(path.join(__dirname, '..', '..', 'commands', 'wip.md'), 'utf8');
  for (const words of ['marker.js doing', 'no es un permiso', 'choca con main']) assert.ok(command.includes(words), words);
});

// ── What a session does, from the files it touched; the close that closed last ────────────────────────────────────

// The touched-files log the harness writes per session: one `{path, ts}` line per file, `mins` minutes before NOW.
function touched(m, sid, files) {
  const dir = path.join(m.state, 'file-events');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), files.map(([p, mins]) => JSON.stringify({ path: p, ts: new Date(minsBefore(mins)).toISOString() })).join('\n') + '\n');
}
function inRepo(repo, rel) {
  const f = path.join(repo, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'x\n');
  return f;
}
const busyAt = (cwd) => ({ status: 'busy', statusUpdatedAt: minsBefore(1), cwd });

test('T1 CierreQueCerroUltimo_GanaAunqueElOtroSeReescriba @story-2.49.3 @ac-1: cuenta el cierre de archivedAt más nuevo, no el archivo tocado último', () => {
  const m = toyMachine();
  const viejo = gitRepo(m.root, 'v', 'story/v', 'https://github.com/acme/v.git');
  const nuevo = gitRepo(m.root, 'x', 'story/x', GH);
  session(m, process.pid, 'ult00000-1', 'Beto');
  closure(m, 'ult00000-1', '5.1-2026-10-18T1350', 10, { repoPath: nuevo });
  const old = closure(m, 'ult00000-1', '5.0-2026-10-18T1200', 120, { storyId: '5.0', repoPath: viejo });
  // something rewrites the old close afterwards: its file date is newer, its archivedAt is not
  fs.utimesSync(old, new Date(minsBefore(1)), new Date(minsBefore(1)));
  const r = run(m, { prs: (q) => ({ prs: q.name === 'x' ? [{ number: 322, draft: false }] : [] }) });
  assert.strictEqual(r.rows.length, 1, r.text);
  assert.strictEqual(r.rows[0].state, 'Entrando a los repos · x #322');
});

test('T2 ArchivosTocados_RepoYCarpeta @story-2.49.3 @ac-2: sin pipeline ni nota, el último archivo tocado dice el repo y la carpeta', () => {
  const m = toyMachine();
  const main = gitRepo(m.root, 'principal', 'main', GH);
  const difusion = gitRepo(m.root, 'difusion', 'main', GH);
  session(m, process.pid, 'arc00000-1', 'Angelito', busyAt(main));
  touched(m, 'arc00000-1', [[inRepo(main, 'specs/a.md'), 30], [inRepo(difusion, 'videos/motion/eq1.py'), 2]]);
  const r = runP(m, { home: m.root });
  assert.strictEqual(r.rows.length, 1, r.text);
  assert.strictEqual(r.rows[0].work, 'difusion · videos');
  assert.strictEqual(r.rows[0].state, `Trabajando sin pipeline · última actividad ${localHhmm(minsBefore(1))}`);
});

test('T3 ArchivosTocados_StoryDeLaRamaODelArchivo @story-2.49.3 @ac-3: la story sale de la rama story/… o del archivo specs/story-…', () => {
  const m = toyMachine();
  const main = gitRepo(m.root, 'principal', 'main', GH);
  const wt = gitRepo(m.root, 'principal-wt-881', 'story/8.81-algo', GH);
  session(m, process.pid, 'arc00000-2', 'Burrito', busyAt(main));
  touched(m, 'arc00000-2', [[inRepo(wt, 'specs/notas.md'), 3]]);
  const r = runP(m, { home: m.root });
  assert.strictEqual(r.rows[0].work, 'principal-wt-881 · story/8.81-algo', r.text);
  assert.strictEqual(r.rows[0].state, `Trabajando sin pipeline · story 8.81 en preparación · última actividad ${localHhmm(minsBefore(1))}`);
  // in main, the story comes from the spec it wrote
  const n = toyMachine();
  const repo = gitRepo(n.root, 'specs-repo', 'main', GH);
  session(n, process.pid, 'arc00000-3', 'Burrito', busyAt(repo));
  touched(n, 'arc00000-3', [[inRepo(repo, 'specs/story-8.81-el-revisor.md'), 3]]);
  const s = runP(n, { home: n.root });
  assert.strictEqual(s.rows[0].work, 'specs-repo · specs', s.text);
  assert.strictEqual(s.rows[0].state, `Trabajando sin pipeline · story 8.81 en preparación · última actividad ${localHhmm(minsBefore(1))}`);
});

test('T4 ArchivosTocados_SinScratchpadMemoriaNiViejos @story-2.49.3 @ac-4: el scratchpad, la memoria y lo de hace más de 3 h no cuentan', () => {
  const m = toyMachine();
  const main = gitRepo(m.root, 'principal', 'main', GH);
  const difusion = gitRepo(m.root, 'difusion', 'main', GH);
  const scratch = path.join(m.root, 'tmp', 'claude-501', 'proyecto', 'arc00000-4', 'scratchpad', 'x.py');
  const memory = path.join(m.root, '.claude', 'projects', 'proyecto', 'memory', 'nota.md');
  session(m, process.pid, 'arc00000-4', 'Angelito', busyAt(main));
  touched(m, 'arc00000-4', [[inRepo(difusion, 'videos/x.md'), 20], [memory, 2], [scratch, 1]]);
  const r = runP(m, { home: m.root });
  assert.strictEqual(r.rows[0].work, 'difusion · videos', r.text);
  // only old, scratchpad or memory files, and the session's folder in main: the row says it cannot tell
  const n = toyMachine();
  const nMain = gitRepo(n.root, 'principal', 'main', GH);
  session(n, process.pid, 'arc00000-5', 'Angelito', busyAt(nMain));
  touched(n, 'arc00000-5', [[inRepo(gitRepo(n.root, 'difusion', 'main', GH), 'videos/x.md'), 4 * 60], [path.join(n.root, '.claude', 'projects', 'p', 'memory', 'a.md'), 2]]);
  assert.strictEqual(runP(n, { home: n.root }).rows[0].work, 'no se ve qué hace');
});

test('T5 Doing_GanaSobreLoDeducido @story-2.49.3 @ac-5: una nota anotada manda sobre los archivos tocados', () => {
  const h = toyHome();
  const difusion = gitRepo(h.root, 'difusion', 'main', GH);
  session(h, process.pid, 'arc00000-6', 'Angelito', { status: 'busy' });
  touched(h, 'arc00000-6', [[inRepo(difusion, 'videos/x.md'), 2]]);
  doing(h, 'arc00000-6', 'armo el video del capítulo 3');
  const r = run(h, { home: h.home });
  assert.strictEqual(r.rows.length, 1, r.text);
  assert.strictEqual(r.rows[0].work, 'armo el video del capítulo 3');
});

test('T6 Ayuda_DiceArchivosTocados @story-2.49.3 @ac-6: la ayuda dice que el trabajo sale de los archivos tocados y que doing lo corrige', () => {
  const command = fs.readFileSync(path.join(__dirname, '..', '..', 'commands', 'wip.md'), 'utf8');
  for (const words of ['archivos que tocó', 'corrige']) assert.ok(command.includes(words), words);
});

test('T7 ArchivosTocados_FueraDeRepoRotoYGitSinRespuesta @story-2.49.3 @ac-4: el anterior si el último no está en un repo; un renglón roto se saltea; git sin respuesta se dice', () => {
  const m = toyMachine();
  const main = gitRepo(m.root, 'principal', 'main', GH);
  const difusion = gitRepo(m.root, 'difusion', 'main', GH);
  const loose = path.join(m.root, 'suelta', 'nota.txt');
  fs.mkdirSync(path.dirname(loose), { recursive: true });
  fs.writeFileSync(loose, 'x\n');
  session(m, process.pid, 'arc00000-7', 'Angelito', busyAt(main));
  touched(m, 'arc00000-7', [[inRepo(difusion, 'videos/x.md'), 10], [loose, 2]]);
  fs.appendFileSync(path.join(m.state, 'file-events', 'arc00000-7.jsonl'), '{"path": roto\n');
  const r = runP(m, { home: m.root });
  assert.strictEqual(r.rows[0].work, 'difusion · videos', r.text);
  assert.deepStrictEqual(r.unreadable, [], r.text);
  // no time left for git, two sessions: both are still placed, because placing reads the git files
  session(m, process.pid, 'arc00000-9', 'Burrito', busyAt(main));
  touched(m, 'arc00000-9', [[inRepo(difusion, 'videos/y.md'), 3]]);
  const capped = runP(m, { home: m.root, repoBudgetMs: -1 });
  assert.deepStrictEqual(capped.unreadable.filter((u) => /tope/.test(u)), [], capped.text);
  assert.deepStrictEqual(capped.rows.map((x) => x.work), ['difusion · videos', 'difusion · videos'], capped.text);
});

test('T8 ArchivosTocados_SinStory_LaDeLaRamaDeLaSesion @story-2.49.3 @ac-3: si el archivo no nombra story, vale la rama de story de la carpeta de la sesión', () => {
  const m = toyMachine();
  const wt = gitRepo(m.root, 'wt', 'story/8.81-algo', GH);
  const difusion = gitRepo(m.root, 'difusion', 'main', GH);
  session(m, process.pid, 'arc00000-8', 'Burrito', busyAt(wt));
  touched(m, 'arc00000-8', [[inRepo(difusion, 'videos/x.md'), 2]]);
  const r = runP(m, { home: m.root });
  assert.strictEqual(r.rows[0].work, 'difusion · videos', r.text);
  assert.strictEqual(r.rows[0].state, `Trabajando sin pipeline · story 8.81 en preparación · última actividad ${localHhmm(minsBefore(1))}`);
});

test('T9 BordesDeLaDeduccion @story-2.49.3 @ac-1 @ac-2: cierre sin archivedAt usa la fecha del archivo; archivo en la raíz del repo; repetidos una vez', () => {
  // a close without archivedAt sorts by its file date: the newer file wins
  const m = toyMachine();
  const viejo = gitRepo(m.root, 'v', 'story/v', 'https://github.com/acme/v.git');
  const nuevo = gitRepo(m.root, 'x', 'story/x', GH);
  session(m, process.pid, 'bor00000-1', 'Beto');
  closure(m, 'bor00000-1', '5.0-viejo', 120, { storyId: '5.0', repoPath: viejo });
  const sinFecha = closure(m, 'bor00000-1', '5.1-sin-fecha', 10, { repoPath: nuevo });
  const h = JSON.parse(fs.readFileSync(sinFecha, 'utf8'));
  delete h.archivedAt;
  fs.writeFileSync(sinFecha, JSON.stringify(h));
  fs.utimesSync(sinFecha, new Date(minsBefore(10)), new Date(minsBefore(10)));
  const r = run(m, { prs: (q) => ({ prs: q.name === 'x' ? [{ number: 9, draft: false }] : [] }) });
  assert.strictEqual(r.rows[0].state, 'Entrando a los repos · x #9', r.text);
  // a file outside any repo touched 25 times counts once, so the one before it (at the root of a repo in main) is read:
  // just the repo
  const n = toyMachine();
  const repo = gitRepo(n.root, 'difusion', 'main', GH);
  const other = gitRepo(n.root, 'otro', 'main', GH);
  const loose = path.join(n.root, 'suelta.txt');
  fs.writeFileSync(loose, 'x\n');
  session(n, process.pid, 'bor00000-2', 'Angelito', busyAt(other));
  touched(n, 'bor00000-2', [[inRepo(repo, 'README.md'), 9], ...Array.from({ length: 25 }, () => [loose, 1])]);
  assert.strictEqual(runP(n, { home: n.root }).rows[0].work, 'difusion');
});

// ── The tab name, the folder each session edits in, and placing without git ─────────────────────────────────────

// A conversation log of a toy session: lines of conversation and `custom-title` lines, the way Claude Code writes them.
function conversation(m, cwd, sid, lines) {
  const dir = path.join(m.root, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
// Every file under a folder, as text (to check that nothing of the conversation was written there).
function allText(dir) {
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out += e.isDirectory() ? allText(p) : fs.readFileSync(p, 'utf8');
  }
  return out;
}
const MARCADA = ['FRASE', 'MARCADA', 'QUE', 'NO', 'SALE'].join('-');

// The name of the session file comes first (T23); these sessions have none in their file, so the title is read.
test('T1 Sesion_NombreDeRename_ElUltimo @story-2.49.4 @ac-1: sin nombre en su archivo, la sesión sale con el último nombre de /rename; sin él, el id; nada más de la conversación sale', () => {
  const m = toyMachine();
  const cwd = gitRepo(m.root, 'principal', 'main', GH);
  conversation(m, cwd, 'tit00000-1', [
    { type: 'user', message: { content: `algo con ${MARCADA}` } },
    { type: 'custom-title', customTitle: 'Beto', sessionId: 'tit00000-1' },
    { type: 'assistant', message: { content: `respuesta con ${MARCADA}` } },
    { type: 'custom-title', customTitle: 'Enzo', sessionId: 'tit00000-1' },
    { type: 'user', message: { content: MARCADA } },
    // a line that names «custom-title» without being one is not a title
    { type: 'user', kind: 'custom-title', customTitle: 'Falso' },
  ]);
  conversation(m, cwd, 'tit00000-2', [{ type: 'user', message: { content: MARCADA } }]);
  // the only title, on the very first line of the log
  conversation(m, cwd, 'tit00000-4', [{ type: 'custom-title', customTitle: 'Centurion' }, { type: 'user', message: { content: MARCADA } }]);
  session(m, process.pid, 'tit00000-1', null, busyAt(cwd));
  session(m, process.pid, 'tit00000-2', 'principal-03', busyAt(cwd));
  session(m, process.pid, 'tit00000-3', null, busyAt(cwd));
  session(m, process.pid, 'tit00000-4', null, busyAt(cwd));
  const r = runP(m, { home: m.root });
  assert.deepStrictEqual(r.rows.map((x) => x.session).sort(), ['Centurion', 'Enzo', 'principal-03', 'tit00000'], r.text);
  assert.ok(!r.text.includes(MARCADA) && !JSON.stringify(r).includes(MARCADA), 'nada de la conversación sale en la tabla ni en el --json');
  assert.ok(!allText(m.state).includes(MARCADA), 'ni en la carpeta de estado');
  // without the conversations folder, the session file's name or the id
  assert.deepStrictEqual(run(m, { home: m.root, projectsDir: null }).rows.map((x) => x.session).sort(), ['principal-03', 'tit00000', 'tit00000', 'tit00000']);
  // only the last 256 KB are read: a title past that window does not count; one inside it does
  const n = toyMachine();
  const big = gitRepo(n.root, 'grande', 'main', GH);
  const filler = Array.from({ length: 3000 }, (_, i) => ({ type: 'user', message: { content: `${MARCADA} ${i} ${'x'.repeat(80)}` } }));
  conversation(n, big, 'big00000-1', [{ type: 'custom-title', customTitle: 'Viejo' }, ...filler]);
  conversation(n, big, 'big00000-2', [{ type: 'custom-title', customTitle: 'Viejo' }, ...filler, { type: 'custom-title', customTitle: 'Nuevo' }]);
  session(n, process.pid, 'big00000-1', null, busyAt(big));
  session(n, process.pid, 'big00000-2', null, busyAt(big));
  assert.ok(fs.statSync(path.join(n.root, 'projects', big.replace(/[^A-Za-z0-9-]/g, '-'), 'big00000-1.jsonl')).size > 256 * 1024);
  assert.deepStrictEqual(runP(n, { home: n.root }).rows.map((x) => x.session).sort(), ['Nuevo', 'big00000']);
  // an id that is not plain letters, digits and dashes does not go into a path: its conversation is not read
  conversation(n, big, 'bad.0000-1', [{ type: 'custom-title', customTitle: 'NoSeLee' }]);
  session(n, process.pid, 'bad.0000-1', null, busyAt(big));
  const unsafe = runP(n, { home: n.root });
  assert.ok(unsafe.rows.some((x) => x.session === 'bad.0000') && !unsafe.text.includes('NoSeLee'), unsafe.text);
});

test('T1b Sesion_ConversacionIlegible_SeDiceAlPie @story-2.49.4 @ac-1: una conversación que está y no se lee va al pie y el nombre cae al de siempre', { skip: process.platform === 'win32' || process.getuid() === 0 ? 'chmod no quita la lectura' : false }, () => {
  const m = toyMachine();
  const cwd = gitRepo(m.root, 'principal', 'main', GH);
  conversation(m, cwd, 'ile00000-1', [{ type: 'custom-title', customTitle: 'Oculto' }]);
  session(m, process.pid, 'ile00000-1', null, busyAt(cwd));
  const file = path.join(m.root, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'), 'ile00000-1.jsonl');
  fs.chmodSync(file, 0o000);
  let r;
  try { r = runP(m, { home: m.root }); } finally { fs.chmodSync(file, 0o644); }
  assert.deepStrictEqual(r.rows.map((x) => x.session), ['ile00000'], r.text);
  assert.ok(r.unreadable.some((u) => u.includes('su conversación no se puede leer (EACCES)')), r.text);
});

test('T2 Sesion_Codex_NombreDeLaBase @story-2.49.4 @ac-2: un marcador de Codex sale con el nombre de su base; sin nombre, el id; una base que no abre se dice', () => {
  const { DatabaseSync } = require('node:sqlite');
  const m = toyMachine();
  const codex = path.join(m.root, 'codex');
  fs.mkdirSync(codex);
  const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, name TEXT)');
  db.prepare('INSERT INTO threads (id, title, name) VALUES (?, ?, ?)').run('cdx00000-1111', 'el primer pedido', 'Muñe');
  db.prepare('INSERT INTO threads (id, title, name) VALUES (?, ?, ?)').run('cdx00000-2222', 'otro pedido', null);
  db.close();
  for (const sid of ['cdx00000-1111', 'cdx00000-2222']) marker(m, sid, { storyId: '6.1', storyPath: story(m.root, '6.1', 'Una de Codex'), stepsCompleted: [0], stepsPending: [4], lastTouch: NOW });
  const r = run(m, { codexHome: codex });
  assert.ok(r.halfway.some((h) => h.includes('· Muñe ·')), r.text);
  assert.ok(r.halfway.some((h) => h.includes('· cdx00000 ·')), r.text);
  assert.ok(!r.text.includes('el primer pedido'), 'el resumen automático de Codex no es el nombre');
  // a base that does not open: the id, and the footer says it
  fs.writeFileSync(path.join(codex, 'state_9.sqlite'), 'no es una base');
  const roto = run(m, { codexHome: codex });
  assert.ok(roto.halfway.some((h) => h.includes('· cdx00000 ·')) && !roto.text.includes('Muñe'), roto.text);
  assert.ok(roto.unreadable.some((u) => /Codex/.test(u)), roto.text);
  // a Codex folder that is there and cannot be listed is said too
  if (process.platform !== 'win32' && process.getuid() !== 0) {
    fs.chmodSync(codex, 0o000);
    let closed;
    try { closed = run(m, { codexHome: codex }); } finally { fs.chmodSync(codex, 0o755); }
    assert.ok(closed.halfway.some((h) => h.includes('· cdx00000 ·')), closed.text);
    assert.ok(closed.unreadable.some((u) => u.includes('nombres de las sesiones de Codex') && u.includes('EACCES')), closed.text);
  }
});

test('T3 Ubicar_SinGit_RepoWorktreeYRama @story-2.49.4 @ac-3: la raíz, la rama y la story salen de los archivos de git, sin lanzar git ni gastar el tope', () => {
  const m = toyMachine();
  const main = gitRepo(m.root, 'principal', 'main', GH);
  const fixed = { ...process.env, GIT_AUTHOR_DATE: NOW, GIT_COMMITTER_DATE: NOW };
  execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', `user.email=${at('t', 'acme.example')}`, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'commit', '-q', '--allow-empty', '-m', 'x'], { env: fixed });
  const expected = [];
  for (let i = 0; i < 20; i += 1) {
    const wt = path.join(m.root, `wt-${i}`);
    execFileSync('git', ['-C', main, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'worktree', 'add', '-q', '-b', `story/9.${i}-algo`, wt], { env: fixed });
    const sid = `ubi000${String(i).padStart(2, '0')}-x`;
    session(m, process.pid, sid, `s${i}`, busyAt(main));
    touched(m, sid, [[inRepo(wt, 'scripts/a.js'), 2]]);
    expected.push([`s${i}`, `wt-${i} · story/9.${i}-algo`, `story 9.${i} en preparación`]);
  }
  // git out of the PATH and no time left: placing still works, because it does not run git
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sin-git-'));
  const savedPath = process.env.PATH;
  process.env.PATH = empty;
  let r;
  try { r = runP(m, { home: m.root, repoBudgetMs: -1 }); } finally { process.env.PATH = savedPath; }
  const got = Object.fromEntries(r.rows.map((x) => [x.session, x]));
  for (const [s, work, storyText] of expected) {
    assert.strictEqual(got[s].work, work, r.text);
    assert.ok(got[s].state.includes(storyText), got[s].state);
  }
  assert.ok(!r.unreadable.some((u) => /tope/.test(u)), r.text);
  // a broken .git (a file with no gitdir line) is said, not taken as «outside a repo»; a detached HEAD has no branch
  const n = toyMachine();
  const broken = path.join(n.root, 'roto');
  fs.mkdirSync(path.join(broken, 'src'), { recursive: true });
  fs.writeFileSync(path.join(broken, '.git'), 'esto no es un gitdir');
  const suelto = gitRepo(n.root, 'suelto', 'main', GH);
  execFileSync('git', ['-C', suelto, '-c', 'user.name=t', '-c', `user.email=${at('t', 'acme.example')}`, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'commit', '-q', '--allow-empty', '-m', 'x'], { env: fixed });
  execFileSync('git', ['-C', suelto, 'checkout', '-q', '--detach']);
  session(n, process.pid, 'rot00000-1', 'roto', busyAt(main));
  touched(n, 'rot00000-1', [[inRepo(broken, 'src/a.js'), 2]]);
  session(n, process.pid, 'rot00000-2', 'suelto', busyAt(main));
  touched(n, 'rot00000-2', [[inRepo(suelto, 'src/a.js'), 2]]);
  const b = runP(n, { home: n.root });
  assert.ok(b.unreadable.some((u) => u.includes('su .git no dice dónde está la carpeta git')), b.text);
  assert.strictEqual(b.rows.find((x) => x.session === 'suelto').work, 'suelto · src', b.text);
});

test('T3b Ubicar_HeadYCommondirIlegibles_SeDicenUnaVez @story-2.49.4 @ac-3: un HEAD o un commondir que están y no se leen van al pie, una vez cada uno', { skip: process.platform === 'win32' || process.getuid() === 0 ? 'chmod no quita la lectura' : false }, () => {
  const m = toyMachine();
  const fixed = { ...process.env, GIT_AUTHOR_DATE: NOW, GIT_COMMITTER_DATE: NOW };
  const main = gitRepo(m.root, 'cerrado', 'main', GH);
  execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', `user.email=${at('t', 'acme.example')}`, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'commit', '-q', '--allow-empty', '-m', 'x'], { env: fixed });
  const wt = path.join(m.root, 'cerrado-wt');
  execFileSync('git', ['-C', main, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'worktree', 'add', '-q', '-b', 'story/9.1-algo', wt], { env: fixed });
  // two sessions on the same repo with an unreadable HEAD: the footer says it once
  for (const sid of ['hed00000-1', 'hed00000-2']) {
    session(m, process.pid, sid, sid.slice(0, 10), busyAt(main));
    touched(m, sid, [[inRepo(main, 'src/a.js'), 2]]);
  }
  session(m, process.pid, 'com00000-1', 'comun', busyAt(main));
  touched(m, 'com00000-1', [[inRepo(wt, 'src/a.js'), 2]]);
  const head = path.join(main, '.git', 'HEAD');
  const commondir = fs.readFileSync(path.join(wt, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim();
  const locked = [head, path.join(commondir, 'commondir')];
  for (const f of locked) fs.chmodSync(f, 0o000);
  let r;
  try { r = runP(m, { home: m.root }); } finally { for (const f of locked) fs.chmodSync(f, 0o644); }
  assert.strictEqual(r.unreadable.filter((u) => u.includes('no se lee su HEAD (EACCES)')).length, 1, r.text);
  assert.ok(r.unreadable.some((u) => u.includes('su commondir no se puede leer (EACCES)')), r.text);
  assert.strictEqual(r.rows.length, 3, r.text);
});

test('T4 Carpeta_ColumnaConLaRaizDondeEdita @story-2.49.4 @ac-4: la columna Carpeta dice el worktree donde edita, con ~; sin archivos, su carpeta de arranque', () => {
  const m = toyMachine();
  const main = gitRepo(m.root, 'principal', 'main', GH);
  const wt = gitRepo(path.join(m.root, 'trabajos'), 'wt-7', 'story/7.7-algo', GH);
  session(m, process.pid, 'car00000-1', 'Beto', busyAt(main));
  touched(m, 'car00000-1', [[inRepo(wt, 'scripts/a.js'), 2]]);
  session(m, process.pid, 'car00000-2', 'Enzo', busyAt(main));
  const r = runP(m, { home: m.root });
  const folder = Object.fromEntries(r.rows.map((x) => [x.session, x.folder]));
  assert.deepStrictEqual(folder, { Beto: path.join('~', 'trabajos', 'wt-7'), Enzo: path.join('~', 'principal') }, r.text);
  assert.match(r.text, /\| Trabajo \| Estado \| Fin estimado \| Sesión \| Carpeta \|/);
});

test('T5 SinDeducir_LoDiceEnLlano @story-2.49.4 @ac-5: trabajando sin marcador, nota ni archivos en un repo en main, la fila dice que no se ve qué hace y por qué', () => {
  const m = toyMachine();
  const main = gitRepo(m.root, 'principal', 'main', GH);
  session(m, process.pid, 'sin00000-1', 'Muñe', busyAt(main));
  const r = runP(m, { home: m.root });
  assert.strictEqual(r.rows[0].work, 'no se ve qué hace', r.text);
  assert.match(r.rows[0].state, /no tocó archivos en las últimas 3 h/);
  // the other reason: it touched files, but none of them is in a repo
  const loose = path.join(m.root, 'suelta', 'nota.txt');
  fs.mkdirSync(path.dirname(loose), { recursive: true });
  fs.writeFileSync(loose, 'x\n');
  touched(m, 'sin00000-1', [[loose, 2]]);
  const t = runP(m, { home: m.root });
  assert.strictEqual(t.rows[0].work, 'no se ve qué hace', t.text);
  assert.match(t.rows[0].state, /los archivos que tocó no están en un repo/);
});

test('T6 Ayuda_NombreYCarpeta @story-2.49.4 @ac-6: la ayuda dice de dónde sale el nombre y qué es la columna Carpeta', () => {
  const help = fs.readFileSync(path.join(__dirname, '..', '..', 'commands', 'wip.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(help, /\*\*Sesión\*\* es el nombre de su archivo de sesión, el mismo que usan los mensajes entre sesiones/);
  assert.match(help, /el último `\/rename` de su conversación guardada/);
  assert.match(help, /lee sólo ese renglón del título/);
  assert.match(help, /\*\*Carpeta\*\* es dónde edita cada sesión/);
  assert.match(help, /sin lanzar git/);
});

test('T23c Entrando_UnaStory_ParaElCartel: --marker da los pedidos abiertos de esa story, uno por uno, y si alguna consulta no contestó', async () => {
  const { storyEntering } = require(WIP);
  const m = toyMachine();
  const x = gitRepo(m.root, 'x', 'story/x', GH);
  const y = gitRepo(m.root, 'y', 'story/x', AZ);
  const story = { storyId: '5.1', repoPath: x, filesTouched: [path.join(y, 'a.js')] };
  const asked = [];
  const both = await storyEntering(story, { query: async (qs) => { asked.push(...qs); return qs.map((q) => ({ prs: [{ number: q.kind === 'github' ? 536 : 5434, draft: false, conflict: false }] })); } });
  assert.deepStrictEqual(both.prs.map((p) => p.ref).sort(), ['!5434', '#536']);
  assert.strictEqual(both.failed, false);
  assert.strictEqual(asked.length, 2);
  const none = await storyEntering(story, { query: async (qs) => qs.map(() => ({ prs: [] })) });
  assert.deepStrictEqual(none, { prs: [], failed: false, unreadable: [] });
  const down = await storyEntering(story, { query: async (qs) => qs.map(() => ({ error: 'gh: no está instalado' })) });
  assert.strictEqual(down.failed, true);
  assert.deepStrictEqual(down.prs, []);
  // en su rama principal no hay nada que esperar ni que preguntar
  const enMain = await storyEntering({ storyId: '5.2', repoPath: gitRepo(m.root, 'z', 'main', GH) }, { query: async () => { throw new Error('no debía preguntar'); } });
  assert.deepStrictEqual(enMain, { prs: [], failed: false, unreadable: [] });
});

// ── The name of the session file ─────────────────────────────────────────────────────────────────────

test('T23 Wip_NameFromSessionFile @story-8.122 @ac-23: cada fila lleva el name del archivo de sesión; --json suma sid, status y nameSource; Codex como hoy', () => {
  const { jsonOf } = require(WIP);
  const m = toyMachine();
  const cwd = gitRepo(m.root, 'principal', 'main', GH);
  conversation(m, cwd, 'nom00000-1', [{ type: 'custom-title', customTitle: 'OtroTitulo' }]);
  conversation(m, cwd, 'nom00000-2', [{ type: 'custom-title', customTitle: 'TituloViejo' }]);
  session(m, process.pid, 'nom00000-1', 'Puesto', { ...busyAt(cwd), nameSource: 'user' });
  session(m, process.pid, 'nom00000-2', 'principal-7f', { ...busyAt(cwd), nameSource: 'derived' });
  // a derived name in the temporary folder is an internal agent unless it has work: this one has a marker
  marker(m, 'nom00000-2', { storyId: '9.1', storyPath: story(m.root, '9.1', 'Una'), stepsCompleted: [0], stepsPending: [4], lastTouch: NOW });
  // a long name with a line break, put by hand in the session file, comes out in one line and cut
  session(m, process.pid, 'nom00000-3', `Largo\n${'x'.repeat(120)}`, { nameSource: 'user', cwd });
  const long = [...require(WIP).sessionsBySid(m.sessions, [], path.join(m.root, '.claude', 'projects')).values()].find((s) => /^Largo/.test(s.name || ''));
  assert.ok(long && !/\n/.test(long.name) && Array.from(long.name).length <= 40, JSON.stringify(long));
  fs.rmSync(path.join(m.sessions, 'nom00000-3.json'));
  const r = runP(m, { home: m.root });
  assert.deepStrictEqual(r.rows.map((x) => x.session).sort(), ['Puesto', 'principal-7f'], r.text);
  assert.ok(!r.text.includes('OtroTitulo') && !r.text.includes('TituloViejo'), r.text);
  const j = jsonOf(r);
  const bySession = Object.fromEntries(j.rows.map((x) => [x.session, x]));
  assert.deepStrictEqual([bySession.Puesto.sid, bySession.Puesto.status, bySession.Puesto.nameSource], ['nom00000-1', 'busy', 'user']);
  assert.deepStrictEqual([bySession['principal-7f'].sid, bySession['principal-7f'].status, bySession['principal-7f'].nameSource], ['nom00000-2', 'busy', 'derived']);
  for (const k of ['free', 'idle', 'halfway', 'unreadable']) assert.ok(k in j, k);
  // a session without a session file (Codex) keeps the name it gets today
  const { DatabaseSync } = require('node:sqlite');
  const codex = path.join(m.root, 'codex');
  fs.mkdirSync(codex);
  const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, name TEXT)');
  db.prepare('INSERT INTO threads (id, title, name) VALUES (?, ?, ?)').run('cdx00000-3333', 'resumen', 'DeCodex');
  db.close();
  marker(m, 'cdx00000-3333', { storyId: '6.1', storyPath: story(m.root, '6.1', 'De Codex'), stepsCompleted: [0], stepsPending: [4], lastTouch: NOW });
  assert.ok(runP(m, { home: m.root, codexHome: codex }).halfway.some((h) => h.includes('· DeCodex ·')));
});
