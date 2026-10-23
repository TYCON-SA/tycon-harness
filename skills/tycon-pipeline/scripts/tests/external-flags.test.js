#!/usr/bin/env node
'use strict';
// external-flags.test.js — las banderas que dicen que algo de afuera se hizo (el aviso de trabajo, el pedido en ADO)
// las pone el arnés cuando hizo el trabajo, nunca el modelo con `set-flag`. Cada bandera de `VALID_FLAGS` está
// clasificada: una nueva sin clasificar hace fallar T18.
//
// Corre los comandos reales con un HOME temporal, el id de sesión fijado y un `az` falso al frente del PATH.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/external-flags.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');

function entorno({ ado = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'external-flags-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(bin);
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-banderas.md');
  fs.writeFileSync(story, [
    '---', 'story: "9.9"', 'title: "banderas"', 'status: ready-for-dev', ...(ado ? ['ado_work_item: 123'] : []),
    'files_to_modify:', '  - src/a.js', '---', '# Story 9.9', '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  // el estado del pedido de la plataforma de juguete (T17)
  const estadoAz = path.join(base, 'estado');
  const env = (sid, extra) => ({
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '',
    TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '', PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    ...(extra || {}),
  });
  const correr = (script, args, sid, extra) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: env(sid, extra), input: '', cwd: repo,
  });
  const dir = () => [path.join(home, '.tycon', 'state'), path.join(home, '.claude', '.tycon-pipeline')].find((d) => fs.existsSync(path.join(d, 'active')));
  const leer = (sid) => JSON.parse(fs.readFileSync(path.join(dir(), 'active', `${sid}.json`), 'utf8'));
  const crudo = (sid) => fs.readFileSync(path.join(dir(), 'active', `${sid}.json`), 'utf8');
  const arrancar = (sid) => {
    const r = correr('pipeline.js', ['start', '--story', story, '--repo', repo, '--brief'], sid);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  };
  const ponerEstado = (s) => fs.writeFileSync(estadoAz, s);
  const leerEstado = () => fs.readFileSync(estadoAz, 'utf8').trim();
  return { base, bin, correr, leer, crudo, arrancar, ponerEstado, leerEstado };
}

test('T15 SetFlag_HechosExternos_SaleDos @story-8.93 @ac-8 — el modelo no pone las banderas de hechos externos', () => {
  const E = entorno();
  const sid = 's-t15';
  E.arrancar(sid);
  const antes = E.crudo(sid);
  for (const flag of ['workSignalStarted', 'adoMarkedActive', 'clockiStarted']) {
    const r = E.correr('marker.js', ['set-flag', flag, 'true'], sid);
    assert.strictEqual(r.status, 2, `${flag}: ${r.stderr}`);
    assert.match(r.stderr, /start-warning/, `${flag} nombra la salida`);
    assert.match(r.stderr, flag === 'adoMarkedActive' ? /ado-mark-active/ : /work-signal start/, `${flag} nombra el comando del arnés`);
  }
  assert.strictEqual(E.crudo(sid), antes, 'el marcador no cambió');
  // tampoco por `set`: se descarta y lo dice
  const m = E.leer(sid);
  const s = E.correr('marker.js', ['set', JSON.stringify({ ...m, adoMarkedActive: true, clockiStarted: true })], sid);
  assert.strictEqual(s.status, 0, s.stderr);
  assert.match(s.stderr, /adoMarkedActive.*no se escribe con set/);
  assert.notStrictEqual(E.leer(sid).adoMarkedActive, true);
  assert.notStrictEqual(E.leer(sid).workSignalStarted, true);
  // una bandera de estado de la ejecución se sigue poniendo
  assert.strictEqual(E.correr('marker.js', ['set-flag', 'waitingForHuman', 'true'], sid).status, 0);
});

// Una plataforma de juguete para la capa (`TYCON_PLATFORM`): contesta `work-item.update` según el estado de un archivo,
// como lo haría un conector real, y anota si escribió.
function plataforma(E) {
  const dir = path.join(E.base, 'plataformas', 'juguete');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'integration.json'), JSON.stringify({
    name: 'juguete', label: 'Juguete', kind: 'platform', connector: 'scripts/connector.js', operations: ['work-item.update'],
    capabilities: { completedHours: 'field', workItemType: 'native', autoComplete: 'native' },
  }));
  const st = path.join(E.base, 'estado');
  fs.writeFileSync(path.join(dir, 'scripts', 'connector.js'), `
const fs = require('fs');
function run(op, args) {
  const previo = fs.readFileSync(${JSON.stringify(st)}, 'utf8').trim();
  if (previo === 'falla') return { ok: false, reason: 'sin_credencial', detail: 'la sesión de la plataforma venció' };
  const base = { id: args.id, previo, warnings: [] };
  if (previo === 'Active') return { ok: true, value: { ...base, estado: previo, changed: false } };
  if (previo === 'Closed' && args.reopen !== true) return { ok: true, value: { ...base, estado: previo, changed: false, pideReabrir: true } };
  fs.writeFileSync(${JSON.stringify(st)}, 'Active');
  return { ok: true, value: { ...base, estado: 'Active', changed: true } };
}
module.exports = { run };
`);
  return { TYCON_PLATFORM: 'juguete', TYCON_INTEGRATIONS_DIR: path.join(E.base, 'plataformas') };
}

test('T17 AdoMarkActive_TransicionaYMarca @story-8.93 @ac-8 — la capa pasa el pedido a activo y recién ahí se marca', () => {
  const caso = (sid, estado, extra = []) => {
    const E = entorno();
    const env = plataforma(E);
    E.arrancar(sid);
    E.ponerEstado(estado);
    return { E, env, r: E.correr('pipeline.js', ['ado-mark-active', ...extra], sid, env) };
  };
  // New → Active: marca
  let { E, r } = caso('s-t17a', 'New');
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.strictEqual(E.leerEstado(), 'Active');
  assert.strictEqual(E.leer('s-t17a').adoMarkedActive, true);
  assert.match(r.stdout, /New → Active/);
  // ya activo: marca sin escribir
  ({ E, r } = caso('s-t17b', 'Active'));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(E.leer('s-t17b').adoMarkedActive, true);
  // cerrado: pide confirmación, no toca ni marca; con --reopen pasa y marca
  let env;
  ({ E, r, env } = caso('s-t17c', 'Closed'));
  assert.strictEqual(r.status, 3, r.stderr + r.stdout);
  assert.match(r.stdout + r.stderr, /pide confirmación/);
  assert.match(r.stdout + r.stderr, /--reopen/);
  assert.strictEqual(E.leerEstado(), 'Closed');
  assert.notStrictEqual(E.leer('s-t17c').adoMarkedActive, true);
  r = E.correr('pipeline.js', ['ado-mark-active', '--reopen'], 's-t17c', env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(E.leerEstado(), 'Active');
  assert.strictEqual(E.leer('s-t17c').adoMarkedActive, true);
  // la capa dice que no (sin credencial): no marca y nombra la salida
  ({ E, r } = caso('s-t17d', 'falla'));
  assert.strictEqual(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /start-warning ado/);
  assert.notStrictEqual(E.leer('s-t17d').adoMarkedActive, true);
  // una historia que no se puede leer no es «no tiene pedido»: sale 1 diciéndolo, sin llamar a la capa
  if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
    ({ E, r } = caso('s-t17e', 'New'));
    const st = E.leer('s-t17e').storyPath;
    fs.chmodSync(st, 0o000);
    try {
      const x = E.correr('pipeline.js', ['ado-mark-active'], 's-t17e', plataforma(E));
      assert.strictEqual(x.status, 1, x.stderr);
      assert.match(x.stderr, /no pude leer el pedido de trabajo/);
      assert.doesNotMatch(x.stderr, /no tiene pedido/);
    } finally { fs.chmodSync(st, 0o644); }
  }
  // el núcleo no habla con ninguna plataforma: ni el comando ni la biblioteca nombran una
  const lib = fs.readFileSync(path.join(SCRIPTS, 'lib', 'external-flags.js'), 'utf8');
  assert.doesNotMatch(lib, /['"]az(\.cmd)?['"]|\bgh\b|boards work-item/, 'external-flags.js no llama a una plataforma');
});

test('T18 Flags_CadaUnaClasificada @story-8.93 @ac-9 — cada bandera está en exactamente una lista', () => {
  const { VALID_FLAGS, EXTERNAL_FLAGS, RUN_FLAGS } = require(path.join(SCRIPTS, 'lib', 'external-flags.js'));
  assert.ok(Array.isArray(VALID_FLAGS) && VALID_FLAGS.length > 0);
  for (const f of VALID_FLAGS) {
    const enExt = EXTERNAL_FLAGS.includes(f);
    const enRun = Object.prototype.hasOwnProperty.call(RUN_FLAGS, f);
    assert.ok(enExt !== enRun, `${f}: en exactamente una lista (externa: ${enExt}, de la ejecución: ${enRun})`);
    if (enRun) assert.ok(String(RUN_FLAGS[f]).trim().length > 10, `${f}: la lista de la ejecución dice por qué el modelo la puede poner`);
  }
  assert.deepStrictEqual([...EXTERNAL_FLAGS].sort(), ['adoMarkedActive', 'workSignalStarted']);
});

// ── T16: la integración de juguete y la conversación de juguete ──────────────────────────────────────────────────────
function integracion(E, comportamiento) {
  const dir = path.join(E.base, 'integraciones', 'juguete');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'integration.json'), JSON.stringify({
    name: 'juguete', label: 'Juguete', kind: 'timeTracking',
    offer: { does: 'registra horas de juguete', needs: 'nada' }, onWork: 'scripts/on-work.js', hooks: [], settings: [],
  }));
  const salida = {
    bien: 'console.log(JSON.stringify({ ok: true }));',
    falla: 'console.error("juguete: la API devolvió 500"); process.exit(1);',
    accion: 'console.log(JSON.stringify({ action: "abrí la entrada con la herramienta mcp__juguete__abrir" }));',
  }[comportamiento];
  fs.writeFileSync(path.join(dir, 'scripts', 'on-work.js'), `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{${salida}});\n`);
  return { TYCON_TIME_TRACKING: 'juguete', TYCON_INTEGRATIONS_DIR: path.join(E.base, 'integraciones') };
}
// una conversación encadenada: el work-signal, una llamada MCP con su resultado y la llamada en curso
function conversacion(E, sid, resultadoMcp, { error = false, emision = 'node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js work-signal start', herramienta = 'mcp__juguete__abrir' } = {}) {
  const dir = path.join(E.base, 'home', '.claude', 'projects', 'repo');
  fs.mkdirSync(dir, { recursive: true });
  let padre = null;
  let n = 0;
  const regs = [];
  const poner = (r) => { const uuid = `u${++n}`; regs.push({ ...r, uuid, parentUuid: padre, sessionId: sid }); padre = uuid; };
  const uso = (id, name, input) => poner({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id, texto, err) => poner({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: texto, ...(err ? { is_error: true } : {}) }] } });
  uso('t1', 'Bash', { command: emision });
  res('t1', '{"ran":true,"action":"abrí la entrada con la herramienta mcp__juguete__abrir"}');
  uso('t2', herramienta, { description: '9.9' });
  res('t2', resultadoMcp, error);
  uso('t3', 'Bash', { command: 'node pipeline.js work-signal start --action-done entry-777' });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), regs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('T16 WorkSignal_FormasLegitimasDelAviso @story-8.93 @ac-8 — PowerShell, redirecciones, rutas con espacio y la entrada ya abierta cuentan', () => {
  const EF = require(path.join(SCRIPTS, 'lib', 'external-flags.js'));
  const regs = (herramienta, cmd, accion, llamada, resultado) => {
    const out = [{ message: { content: [{ type: 'tool_use', id: 'e1', name: herramienta, input: { command: cmd } }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: JSON.stringify({ ran: true, action: accion }) }] } }];
    if (llamada) out.push({ message: { content: [{ type: 'tool_use', id: 'm1', name: llamada, input: {} }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'm1', content: resultado }] } });
    return out;
  };
  const ABRIR = 'abrí la entrada con mcp__clockify__create-clockify-time-entry';
  const ok = (r) => assert.strictEqual(r.ok, true, JSON.stringify(r));
  for (const [herr, cmd] of [
    ['PowerShell', 'node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js work-signal start'],
    ['Bash', 'node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js work-signal start 2>&1'],
    ['Bash', 'node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js work-signal start 2>/dev/null'],
    ['PowerShell', 'node "C:\\Users\\Ana Pérez\\.claude\\agent-skills\\skills\\tycon-pipeline\\scripts\\pipeline.js" work-signal start'],
    ['PowerShell', '& node "$HOME\\.claude\\agent-skills\\skills\\tycon-pipeline\\scripts\\pipeline.js" work-signal start'],
  ]) ok(EF.enRegistros(regs(herr, cmd, ABRIR, 'mcp__clockify__create-clockify-time-entry', '{"id":"69a1b2c3d4"}'), '69a1b2c3d4'));
  // la sesión ya tenía una entrada abierta de otra historia: la cierra con update y abre otra con create, del mismo servidor
  const YA = 'ya hay una entrada abierta (e-viejo-123): si es de otra historia, cerrala con mcp__clockify__update-clockify-time-entry';
  ok(EF.enRegistros(regs('Bash', 'node pipeline.js work-signal start', YA, 'mcp__clockify__create-clockify-time-entry', '{"id":"nuevo-4567"}'), 'nuevo-4567'));
  // de la misma historia: no hay nada que hacer, y la acción misma trae su id
  ok(EF.enRegistros(regs('Bash', 'node pipeline.js work-signal start', YA), 'e-viejo-123'));
  // los gemelos que no: un echo con redirección, y otra herramienta de otro servidor
  assert.strictEqual(EF.enRegistros(regs('Bash', 'echo node pipeline.js work-signal start 2>&1', ABRIR, 'mcp__clockify__create-clockify-time-entry', '{"id":"69a1b2c3d4"}'), '69a1b2c3d4').ok, false);
  assert.strictEqual(EF.enRegistros(regs('Bash', 'node pipeline.js work-signal start', ABRIR, 'mcp__memoria__guardar', '69a1b2c3d4'), '69a1b2c3d4').ok, false);
});

test('T16 WorkSignal_EmiteYMarca @story-8.93 @ac-8 — el aviso de trabajo marca sólo con evidencia', () => {
  // contesta bien: marca
  let E = entorno({ ado: false });
  E.arrancar('s-t16a');
  let r = E.correr('pipeline.js', ['work-signal', 'start'], 's-t16a', integracion(E, 'bien'));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(E.leer('s-t16a').workSignalStarted, true);

  // avisa falla: no marca
  E = entorno({ ado: false });
  E.arrancar('s-t16b');
  r = E.correr('pipeline.js', ['work-signal', 'start'], 's-t16b', integracion(E, 'falla'));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.notStrictEqual(E.leer('s-t16b').workSignalStarted, true);

  // devuelve una acción: no marca y nombra --action-done
  E = entorno({ ado: false });
  const acc = integracion(E, 'accion');
  E.arrancar('s-t16c');
  r = E.correr('pipeline.js', ['work-signal', 'start'], 's-t16c', acc);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.notStrictEqual(E.leer('s-t16c').workSignalStarted, true);
  assert.match(r.stderr + r.stdout, /--action-done/);

  // un id inventado: no está en ningún resultado de la conversación
  conversacion(E, 's-t16c', '{"id":"entry-777","description":"9.9"}');
  r = E.correr('pipeline.js', ['work-signal', 'start', '--action-done', 'entry-999'], 's-t16c', acc);
  assert.strictEqual(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /entry-999/);
  assert.notStrictEqual(E.leer('s-t16c').workSignalStarted, true);

  // un id corto, o uno que es parte de otra palabra: no
  assert.strictEqual(E.correr('pipeline.js', ['work-signal', 'start', '--action-done', '7'], 's-t16c', acc).status, 1);
  assert.strictEqual(E.correr('pipeline.js', ['work-signal', 'start', '--action-done', 'entry-77'], 's-t16c', acc).status, 1);
  assert.notStrictEqual(E.leer('s-t16c').workSignalStarted, true);

  // el id que devolvió la herramienta: marca
  r = E.correr('pipeline.js', ['work-signal', 'start', '--action-done', 'entry-777'], 's-t16c', acc);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.strictEqual(E.leer('s-t16c').workSignalStarted, true);

  // un aviso de trabajo que sólo se nombra (un echo) u otra herramienta que repite el id: no
  for (const [caso, op] of [['echo', { emision: 'echo "node pipeline.js work-signal start"' }], ['otra herramienta', { herramienta: 'mcp__memoria__guardar' }]]) {
    const F = entorno({ ado: false });
    const accF = integracion(F, 'accion');
    F.arrancar('s-t16f');
    conversacion(F, 's-t16f', '{"id":"entry-777"}', op);
    const x = F.correr('pipeline.js', ['work-signal', 'start', '--action-done', 'entry-777'], 's-t16f', accF);
    assert.strictEqual(x.status, 1, `${caso}: ${x.stderr}`);
    assert.notStrictEqual(F.leer('s-t16f').workSignalStarted, true, caso);
  }

  // un resultado con error no cuenta
  E = entorno({ ado: false });
  const acc2 = integracion(E, 'accion');
  E.arrancar('s-t16d');
  conversacion(E, 's-t16d', 'entry-777', { error: true });
  r = E.correr('pipeline.js', ['work-signal', 'start', '--action-done', 'entry-777'], 's-t16d', acc2);
  assert.strictEqual(r.status, 1, r.stderr + r.stdout);
  assert.notStrictEqual(E.leer('s-t16d').workSignalStarted, true);

  // Codex, sin conversación que leer: marca, avisa y deja la constancia sin verificar
  E = entorno({ ado: false });
  const acc3 = integracion(E, 'accion');
  E.arrancar('s-t16e');
  r = E.correr('pipeline.js', ['work-signal', 'start', '--action-done', 'entry-777'], 's-t16e',
    { ...acc3, CLAUDE_CODE_SESSION_ID: '', CODEX_SESSION_ID: 's-t16e' });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /sin verificar/);
  assert.strictEqual(E.leer('s-t16e').workSignalStarted, true);
  assert.strictEqual(E.leer('s-t16e').workSignalVerified, false, 'el marcador dice que quedó sin verificar');
  // y se dice hasta el cierre, como los avisos del Arranque
  const S = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  assert.ok(S.startWarningLines(E.leer('s-t16e')).some((l) => /sin verificar/.test(l)), 'el aviso sale en next y en el cierre');
});
