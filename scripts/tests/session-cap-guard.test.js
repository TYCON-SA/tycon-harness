'use strict';
// session-cap-guard.test.js — the brake before each agent command that would open a background Claude session with the
// machine at its cap. Nothing here reads the real HOME: every case builds its own HOME, team profile and sessions.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GUARD = path.join(ROOT, 'scripts', 'hooks', 'session-cap-guard.js');
const COORD = path.join(ROOT, 'scripts', 'tools', 'coordination.js');
const G = require(GUARD);
const C = require(COORD);
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

// stable-data: each session's date is «now minus N minutes», the same account the brake does with its own clock, so the
// result doesn't depend on the day; the time budget case measures the real clock on purpose.
const NOW = Date.now();
const POSIX_PERMS = { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? 'sin permisos POSIX' : false };

// A toy machine: HOME with its Claude folder and the pipeline state, and a team profile with the cap, outside HOME.
function toy({ cap = 5, busy = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capguard-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(claudeDir(home), 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir(home), 'active'), { recursive: true });
  const profile = path.join(root, 'perfil-equipo.json');
  fs.writeFileSync(profile, JSON.stringify(cap == null ? {} : { coordination: { max_working: cap } }));
  const env = { TYCON_PROFILE: profile };
  const t = { root, home, profile, env };
  for (let i = 1; i <= busy; i += 1) session(t, `busy-${i}`, `S${i}`, { status: 'busy' });
  return t;
}
// A session file as Claude Code writes it, alive (this process's pid).
function session(t, sid, name, extra = {}) {
  fs.writeFileSync(path.join(claudeDir(t.home), 'sessions', `${sid}.json`), JSON.stringify({
    pid: process.pid, sessionId: sid, name, nameSource: 'user', status: 'idle', statusUpdatedAt: NOW - 20 * 60000, cwd: t.root, ...extra,
  }));
}
const openedFile = (t) => path.join(C.coordinationDir(t.home), 'opened.json');
const opened = (t) => { try { return JSON.parse(fs.readFileSync(openedFile(t), 'utf8')); } catch { return []; } };
const clearOpened = (t) => fs.rmSync(openedFile(t), { force: true });
const frenos = (t) => { try { return fs.readFileSync(path.join(stateDir(t.home), 'frenos.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

// The hook as Claude Code runs it: the event on stdin, the real HOME of the toy.
function run(t, command, { tool = 'Bash', bg = false } = {}) {
  const event = { hook_event_name: 'PreToolUse', tool_name: tool, session_id: 'caller-sid', cwd: t.root, tool_input: { command, ...(bg ? { run_in_background: true } : {}) } };
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(event), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: t.home, USERPROFILE: t.home, ...t.env },
  });
  return { code: r.status, err: r.stderr || '' };
}

// The background forms of AC 2, each with its tool.
const OTHER_FORMS = [
  ['claude -p x', { bg: true }],
  ['claude -p x &', {}],
  ['nohup claude -p x', {}],
  ['setsid claude -p x', {}],
  ['env claude --bg -n y -- z', {}],
  ['bash -c "claude --bg -n y -- z"', {}],
  ['tmux new -d "claude -p x"', {}],
  ['screen -dm claude -p x', {}],
  ["Start-Process claude -ArgumentList '--bg'", { tool: 'PowerShell' }],
  ['& claude --bg -n y -- z', { tool: 'PowerShell' }],
  ['pwsh -c "claude --bg -n y -- z"', { tool: 'PowerShell' }],
];

test('T1 EnElTope_ClaudeBg_Niega @story-8.178 @ac-1: en el tope, claude --bg se niega con el conteo, los nombres y el comando de open', () => {
  const t = toy({ cap: 5, busy: 5 });
  const r = run(t, 'claude --bg -n x -- hola');
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /5 de 5/);
  for (let i = 1; i <= 5; i += 1) assert.match(r.err, new RegExp(`S${i}`));
  assert.match(r.err, /del perfil del equipo/);
  const cmd = /node (\S+) open --name /.exec(r.err);
  assert.ok(cmd, r.err);
  assert.ok(path.isAbsolute(cmd[1].replace(/^"|"$/g, '')) && /coordination\.js"?$/.test(cmd[1]), cmd[1]);
  assert.doesNotMatch(r.err, /sub(í|i)(le|r) el tope|max_working/i);
  assert.deepStrictEqual(opened(t), []);
});

test('T2 EnElTope_OtrasFormasDeFondo_Niega @story-8.178 @ac-2: las otras formas de dejar una sesión de fondo se niegan igual', () => {
  const t = toy({ cap: 5, busy: 5 });
  for (const [command, how] of OTHER_FORMS) {
    const r = run(t, command, how);
    assert.strictEqual(r.code, 2, `${command}: ${r.err}`);
  }
});

test('T3 DebajoDelTope_Deja @story-8.178 @ac-3: con 4 de 5, todas las formas pasan', () => {
  const t = toy({ cap: 5, busy: 4 });
  for (const [command, how] of [['claude --bg -n x -- hola', {}], ...OTHER_FORMS]) {
    const r = run(t, command, how);
    assert.strictEqual(r.code, 0, `${command}: ${r.err}`);
    clearOpened(t);
  }
});

test('T4 NoAbreSesion_Deja @story-8.178 @ac-4: lo que no abre una sesión de fondo pasa, sin leer el estado', POSIX_PERMS, () => {
  const t = toy({ cap: 5, busy: 5 });
  const sessions = path.join(claudeDir(t.home), 'sessions');
  fs.chmodSync(sessions, 0o000);
  try {
    // con la carpeta ilegible, algo que abre se niega por no poder contar: la carpeta sí se lee cuando abre
    assert.strictEqual(run(t, 'claude --bg -n x -- y').code, 2);
    for (const [command, how] of [
      ['claude attach x', {}], ['claude --version', {}], ['claude mcp list', {}], ['claude -p x', {}],
      [`node ${COORD} open --name a --cwd ${t.root} -- "claude --bg"`, {}], ['grep claude notas.md', {}],
      ['echo "claude --bg"', {}], ['claude logs x &', {}], ['Start-Process notepad', { tool: 'PowerShell' }],
    ]) {
      const r = run(t, command, how);
      assert.strictEqual(r.code, 0, `${command}: ${r.err}`);
    }
  } finally { fs.chmodSync(sessions, 0o755); }
});

// The six machine states of T5. `cap: null` = no value anywhere (factory cap, 3). `deny`: what both paths must say, so
// a state that neither path counts (the Codex thread, the session opened a minute ago) fails instead of agreeing.
const STATES = [
  { name: 'debajo', cap: 3, busy: 2, deny: false },
  { name: 'en el tope', cap: 3, busy: 3, deny: true },
  { name: 'pasado', cap: 3, busy: 4, deny: true },
  { name: 'abierta hace 1 min sin archivo', cap: 3, busy: 2, openedAgo: 1, deny: true },
  { name: 'hilo de Codex activo', cap: 3, busy: 2, codex: true, deny: true },
  { name: 'tope de fábrica', cap: null, busy: 3, deny: true },
];
function stateToy(s) {
  const t = toy({ cap: s.cap, busy: s.busy });
  if (s.cap == null) t.env = { TYCON_PROFILE: '0' };
  if (s.openedAgo) {
    fs.mkdirSync(C.coordinationDir(t.home), { recursive: true });
    fs.writeFileSync(openedFile(t), JSON.stringify([{ name: 'recien', cwd: t.root, at: NOW - s.openedAgo * 60000 }]));
  }
  if (s.codex) {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.join(t.home, '.codex'), { recursive: true });
    const db = new DatabaseSync(path.join(t.home, '.codex', 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, updated_at_ms INTEGER)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('cx1', 'Codex1', NOW - 60000);
    db.close();
  }
  return t;
}
// The calling session of `open`, in bypass, as coordination.test.js leaves it.
function caller(t) {
  const dir = path.join(claudeDir(t.home), 'projects', t.root.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'coord-sid.jsonl'), `${JSON.stringify({ type: 'user', permissionMode: 'bypassPermissions', message: { content: 'hola' } })}\n`);
  return { CLAUDE_CODE_SESSION_ID: 'coord-sid' };
}
function toyLauncher(t) {
  const script = path.join(t.root, 'launcher.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(path.join(t.root, 'launched'))}, 'x');`);
  return { bin: process.execPath, prefix: [script] };
}

test('T5 MismoTopeQueOpen @story-8.178 @ac-5: el freno niega exactamente donde open se niega por el tope', () => {
  for (const s of STATES) {
    const a = stateToy(s);
    const d = G.decidir({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: a.root, tool_input: { command: 'claude --bg -n nueva -- hola' } }, { home: a.home, env: a.env, now: NOW });
    const b = stateToy(s);
    const o = C.open({ home: b.home, env: { ...b.env, ...caller(b) }, now: NOW, cwd: b.root, name: 'nueva', task: 'hola', launcher: toyLauncher(b) });
    const openAtCap = !o.ok && /el tope es/.test(o.message);
    assert.strictEqual(d.deny === true, openAtCap, `${s.name}: freno=${JSON.stringify(d)} open=${o.message}`);
    assert.strictEqual(d.deny === true, s.deny, `${s.name}: se esperaba ${s.deny ? 'negar' : 'dejar'}: ${JSON.stringify(d)}`);
    if (d.deny) assert.strictEqual(d.motivo, 'en-el-tope', s.name);
  }
});

test('T6 NoPudeContar_Niega @story-8.178 @ac-7: con un estado ilegible, lo que abre se niega y se nombra el archivo', () => {
  const cases = [
    ['opened.json', (t) => { fs.mkdirSync(C.coordinationDir(t.home), { recursive: true }); fs.writeFileSync(openedFile(t), '{roto'); }],
    ['ilegible.json', (t) => fs.writeFileSync(path.join(stateDir(t.home), 'active', 'ilegible.json'), '{roto')],
  ];
  for (const [file, breakIt] of cases) {
    const t = toy({ cap: 5, busy: 1 });
    breakIt(t);
    const r = run(t, 'claude --bg -n x -- y');
    assert.strictEqual(r.code, 2, `${file}: ${r.err}`);
    assert.ok(r.err.includes(file), `${file}: ${r.err}`);
    assert.match(r.err, /terminal/);
  }
});

test('T7 NoPudeContar_ComandoQueNoAbre_Deja @story-8.178 @ac-7: con el estado ilegible, lo que no abre pasa', () => {
  const t = toy({ cap: 5, busy: 1 });
  fs.mkdirSync(C.coordinationDir(t.home), { recursive: true });
  fs.writeFileSync(openedFile(t), '{roto');
  fs.writeFileSync(path.join(stateDir(t.home), 'active', 'ilegible.json'), '{roto');
  for (const command of ['claude --version', 'ls']) assert.strictEqual(run(t, command).code, 0, command);
});

test('T8 ExcepcionAlDecidir @story-8.178 @ac-8: si el lector tira, decide la expresión de respaldo', () => {
  const t = toy({ cap: 5, busy: 0 });
  const boom = () => { throw new Error('lector roto'); };
  const ev = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: t.root, tool_input: { command } });
  for (const command of ['claude --bg -n x -- y', 'eval "claude --bg"']) {
    const d = G.decidir(ev(command), { home: t.home, env: t.env, now: NOW, lector: boom });
    assert.strictEqual(d.deny, true, command);
    assert.strictEqual(d.motivo, 'no-pude-decidir', command);
    assert.match(d.message, /no pude decidir/i);
  }
  assert.strictEqual(G.decidir(ev('ls'), { home: t.home, env: t.env, now: NOW, lector: boom }).deny, false);
  assert.deepStrictEqual(opened(t), []);
});

test('T10 Negativa_QuedaEnFrenos @story-8.178 @ac-9: cada negativa deja una línea sin el comando; lo que pasa no anota', () => {
  const t = toy({ cap: 5, busy: 5 });
  assert.strictEqual(run(t, 'claude --bg -n x -- hola-secreto').code, 2);
  assert.strictEqual(run(t, 'ls').code, 0);
  fs.mkdirSync(C.coordinationDir(t.home), { recursive: true });
  fs.writeFileSync(openedFile(t), '{roto');
  assert.strictEqual(run(t, 'claude --bg -n x -- hola-secreto').code, 2);
  const lines = frenos(t);
  assert.deepStrictEqual(lines.map((l) => [l.freno, l.regla, l.veredicto, l.motivo]), [
    ['session-cap-guard', 'tope', 'bloqueo', 'en-el-tope'],
    ['session-cap-guard', 'tope', 'bloqueo', 'no-pude-contar'],
  ]);
  for (const l of lines) assert.ok(!JSON.stringify(l).includes('hola-secreto'), JSON.stringify(l));
  // un comando que abre y pasa debajo del tope tampoco deja línea
  const u = toy({ cap: 5, busy: 1 });
  assert.strictEqual(run(u, 'claude --bg -n x -- hola').code, 0);
  assert.deepStrictEqual(frenos(u), []);
  const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'sources.json'), 'utf8'));
  const blocks = JSON.stringify(sources).match(/"frenos_bloqueos":\{[^}]*\}/);
  assert.ok(blocks && blocks[0].includes('"session-cap-guard"'), 'el freno en frenos_bloqueos');
});

test('T11 Registro_EnLaListaDeGanchos @story-8.178 @ac-10: el freno está en la lista de ganchos y en las piezas', () => {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8'));
  const all = JSON.stringify(list);
  const entries = (Array.isArray(list) ? list : list.hooks || Object.values(list).flat()).filter((h) => h && h.spec === '@tcg:session-cap-guard.js');
  assert.strictEqual(entries.length, 1, all.slice(0, 200));
  const [h] = entries;
  assert.strictEqual(h.event, 'PreToolUse');
  assert.strictEqual(h.matcher, 'Bash|PowerShell');
  assert.strictEqual(h.effect, 'blocks');
  assert.strictEqual(h.platforms && h.platforms.windows, true);
  const pieces = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'fixtures', 'harness-managed-pieces.json'), 'utf8'));
  const piece = JSON.stringify(pieces).includes('"PreToolUse:@tcg:session-cap-guard.js"');
  assert.ok(piece, 'la pieza en harness-managed-pieces.json');
  const p = (Array.isArray(pieces) ? pieces : pieces.pieces || []).find((x) => x.id === 'PreToolUse:@tcg:session-cap-guard.js');
  assert.ok(p && p.windows === true, JSON.stringify(p));
});

test('T12 Envuelto_SeLeeAdentro @story-8.178 @ac-2 @ac-4: lo envuelto se lee por dentro; lo que sólo nombra claude no abre', () => {
  const abren = ['command claude --bg', 'exec claude --bg', 'sudo -u x claude --bg', "sh -c 'claude -p x &'", 'cmd /c claude --bg', 'CLI=claude; $CLI --bg'];
  for (const c of abren) assert.strictEqual(G.abreSesion(c, { herramienta: 'Bash', deFondo: false }).abre, true, c);
  for (const c of ['echo claude --bg', 'cat claude.md']) assert.strictEqual(G.abreSesion(c, { herramienta: 'Bash', deFondo: false }).abre, false, c);
  assert.strictEqual(G.abreSesion('Start-Process notepad', { herramienta: 'PowerShell', deFondo: false }).abre, false);
});

// The forms the adversarial pass found (probes in the run folder), each with what it must say. `ps`: PowerShell.
const FOUND_FORMS = [
  // screen and tmux with joined flags that take a value, or separate -d -m
  ['screen -dmS a claude', true], ['screen -d -m claude', true], ['screen -d -m -S a claude -p x', true],
  ['screen -S a claude', false], ['tmux new -ds a claude', true], ['tmux new-window -d claude', true],
  ['tmux split-window -d claude', true], ['tmux new -s a claude', false],
  // the final & sends the whole pipeline or list to the background; an & inside parentheses too
  ['claude -p x | tee log &', true], ['claude -p x 2>&1 | tee a.log &', true], ['a && claude -p x &', true],
  ['(claude -p x &)', true], ['{ claude -p x & }', true], ['bash -c "(claude -p x &)"', true],
  ['claude -p x 2>&1 | tee log', false], ['(claude -p x)', false],
  // env -S carries the command; cmd's start leaves it running alone
  ['env -S "claude --bg"', true], ['env -S "claude -p x"', false], ['cmd /c start /b claude -p x', true], ['cmd /c claude -p x', false],
  // Start-Process switches before the target; Start-Job options and a block with several statements
  ['Start-Process -NoNewWindow claude -ArgumentList --bg', true, 'ps'], ['Start-Process -PassThru claude', true, 'ps'],
  ['Start-Process -Wait notepad', false, 'ps'], ['Start-Job -Name a -ScriptBlock { claude -p x }', true, 'ps'],
  ['Start-Job { cd x; claude -p y }', true, 'ps'], ['Start-ThreadJob -ScriptBlock { Get-Date }', false, 'ps'],
  // a PowerShell assignment is not a program from outside: claude in the foreground stays foreground
  ['$out = claude -p "x"', false, 'ps'], ['$r = & claude -p x', false, 'ps'], ['$env:X="1"; claude -p x', false, 'ps'],
  ['$claude = Get-Command claude', false, 'ps'], ['$x = claude --bg', true, 'ps'],
];

test('T14 FormasDelPaseAdversarial @story-8.178 @ac-2 @ac-4: cada forma que el pase encontró se lee como corresponde', () => {
  for (const [command, abre, tool] of FOUND_FORMS) {
    const r = G.abreSesion(command, { herramienta: tool === 'ps' ? 'PowerShell' : 'Bash', deFondo: false });
    assert.strictEqual(r.abre === true, abre, `${command}: ${JSON.stringify(r)}`);
  }
  // lo que no se puede leer dentro de una sustitución no se pierde: cae en la expresión de respaldo
  for (const command of ['echo $(eval "claude --bg")', 'x=$(xargs claude)']) {
    assert.strictEqual(G.abreSesion(command, { herramienta: 'Bash', deFondo: false }).abre, true, command);
  }
  // en el tope, el freno de verdad niega una de ellas
  const t = toy({ cap: 5, busy: 5 });
  assert.strictEqual(run(t, 'claude -p x | tee log &').code, 2);
});

test('T16 BloquesDeJob_SinCuelgue @story-8.178 @ac-8: bloques anidados o sin cerrar terminan rápido y deciden por el respaldo', () => {
  assert.strictEqual(G.respaldo('Start-Job {claude}'), true, 'claude pegado a una llave');
  const ps = { herramienta: 'PowerShell', deFondo: false };
  const cases = [
    // anidados con espacio y pegados: antes cada nivel volvía a leer los de adentro y el trabajo crecía como una potencia
    ['Start-Job { '.repeat(4000) + 'claude -p x' + ' }'.repeat(4000), true],
    ['Start-Job {Start-Job {'.repeat(2000) + 'claude' + '}}'.repeat(2000), true],
    // sin cerrar: no es PowerShell válido, decide el respaldo
    ['Start-Job { '.repeat(20000) + 'claude', true],
    ['Start-Job { '.repeat(20000) + 'ls; echo claude.md', false],
    // muchos seguidos, cada uno cerrado
    ['Start-Job { Get-Date } '.repeat(5000) + 'Start-Job {claude -p x}', true],
  ];
  for (const [command, abre] of cases) {
    const t0 = Date.now();
    const r = G.abreSesion(command, ps);
    const ms = Date.now() - t0;
    assert.strictEqual(r.abre === true, abre, `${command.slice(0, 40)}…: ${JSON.stringify(r)}`);
    assert.ok(ms < 10000, `${command.slice(0, 40)}… tardó ${ms} ms`);
  }
});

test('T15 EntradaQueNoEsObjeto @story-8.178 @ac-8: una entrada que no se puede leer niega si nombra a claude y lo anota', () => {
  const t = toy({ cap: 5, busy: 0 });
  const raw = (input) => spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: t.home, USERPROFILE: t.home, ...t.env } });
  for (const input of ['"claude --bg"', '{roto claude --bg']) {
    const r = raw(input);
    assert.strictEqual(r.status, 2, `${input}: ${r.stderr}`);
    assert.match(r.stderr, /no pude leer la entrada/);
  }
  for (const input of ['null', '[1]', '7']) assert.strictEqual(raw(input).status, 0, input);
  assert.deepStrictEqual(frenos(t).map((l) => l.motivo), ['no-pude-decidir', 'no-pude-decidir']);
});

test('T13 AperturasSeguidas_LaSegundaNiega @story-8.178 @ac-11: con 4 de 5, la primera pasa y queda anotada; la segunda se niega', () => {
  const t = toy({ cap: 5, busy: 4 });
  assert.strictEqual(run(t, 'claude --bg -n a -- x').code, 0);
  assert.deepStrictEqual(opened(t).map((o) => o.name), ['a']);
  const second = run(t, 'claude --bg -n b -- y');
  assert.strictEqual(second.code, 2, second.err);
  assert.match(second.err, /5 de 5/);
  const u = toy({ cap: 5, busy: 4 });
  assert.strictEqual(run(u, 'claude -p x &').code, 0);
  const names = opened(u).map((o) => o.name);
  assert.strictEqual(names.length, 1);
  assert.match(names[0], /^sin-nombre-\d{6}/);
  // sin poder anotarla, no contaría: se niega por no poder contar
  if (!POSIX_PERMS.skip) {
    const w = toy({ cap: 5, busy: 1 });
    const dir = C.coordinationDir(w.home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(openedFile(w), '[]');
    fs.chmodSync(dir, 0o555);
    try {
      const r = run(w, 'claude --bg -n c -- z');
      assert.strictEqual(r.code, 2, r.err);
      assert.ok(r.err.includes('opened.json'), r.err);
      assert.deepStrictEqual(frenos(w).map((l) => l.motivo), ['no-pude-contar']);
    } finally { fs.chmodSync(dir, 0o755); }
  }
});

test('T17 ComandoDeOpen_RutaConCaracteresRaros @story-8.178 @ac-1: la carpeta del comando de open llega entera al shell', { skip: process.platform === 'win32' ? 'prueba las comillas de sh' : false }, () => {
  const t = toy({ cap: 5, busy: 5 });
  for (const cwd of ['/tmp/a b\\c', '/tmp/a"b c', '/tmp/a\\" b', '/tmp/a $HOME b', '/tmp/a `id` b']) {
    const d = G.decidir({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command: 'claude --bg -n x -- y' } }, { home: t.home, env: t.env, now: NOW });
    assert.strictEqual(d.deny, true, cwd);
    const quoted = / --cwd (.+) -- <encargo>/.exec(d.message);
    assert.ok(quoted, d.message);
    const r = spawnSync('sh', ['-c', `printf %s ${quoted[1]}`], { encoding: 'utf8' });
    assert.strictEqual(r.stdout, cwd);
  }
});
