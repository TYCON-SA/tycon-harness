'use strict';
/**
 * waiver-probe.js — en Windows, ¿el agente puede firmar un waiver?
 *
 * ── POR QUÉ EXISTE ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * Un dev del equipo en Windows no puede firmar por terminal: `marker.js runtime-waiver` pide /dev/tty, que en Windows no existe.
 * Por eso el comando abre una ventana de consola NUEVA y visible donde la persona aprueba y escribe una frase al azar; sólo esa
 * ventana firma, y vence a los 5 minutos. Esta sonda mide, en el agente Windows y sin ninguna persona, lo que le importa
 * al candado: que desde un proceso como el del agente no se firma.
 *
 *   1. el comando con la marca de la ventana y la respuesta por la entrada (lo que haría el agente para saltear la ventana):
 *      tiene que frenar (salida 2) sin escribir nada;
 *   2. el comando normal: abre la ventana, nadie escribe, vence el plazo (bajado a 25 s para la sonda) y no se firma; y no
 *      queda vivo ningún proceso del comando;
 *   3. la consola del proceso de la sonda (la del agente) no pasa por «consola nueva».
 * Si la ventana ni siquiera arranca el comando en este agente, el paso 2 lo dice como hallazgo (no se probó la espera).
 *
 * Fuera de Windows no mide nada (no medido). Uso: node scripts/tests/windows/waiver-probe.js --lab <laboratorio> --out <carpeta del reporte>
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');

const NAME = 'waiver';
const SKILLS = path.join(__dirname, '..', '..', '..', 'skills', 'tycon-pipeline', 'scripts');
const MARKER = path.join(SKILLS, 'marker.js');
const LIB = path.join(SKILLS, 'lib', 'runtime-waiver.js');
const say = (s) => process.stdout.write(`${s}\n`);

/** Una story de juguete con un AC declarado imposible de verificar corriendo: lo que el waiver firmaría. */
function armar(dir) {
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const story = path.join(repo, 'specs', 'story-9.9.md');
  fs.writeFileSync(story, ['---', 'story: 9.9', 'status: in-progress', 'runtime_not_verifiable:', '  - ac: 1',
    '    reason: "sonda del waiver"', '    covered_by: T1', '---', '', '## Acceptance Criteria', '', '1. algo', ''].join('\n'));
  return { home, repo, story, firmas: path.join(repo, '.tycon', 'runtime-waivers.jsonl') };
}

/** Los procesos vivos cuyo comando nombra `aguja`, con PowerShell; null si no se pudo preguntar. */
function vivosCon(aguja, env) {
  const ps = L.scanPath('pwsh', { env })[0] || L.scanPath('powershell', { env })[0];
  if (!ps) return null;
  const q = aguja.replace(/'/g, "''");
  const r = L.run(ps, ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${q}') -and $_.ProcessId -ne $PID }).Count`], { env, timeoutMs: 60000 });
  if (r.exit !== 0) return null;
  const n = Number(String(r.stdout).trim().split(/\r?\n/).pop());
  return Number.isFinite(n) ? n : null;
}

function measure({ lab, platform = process.platform, baseEnv = process.env, rec }) {
  if (platform !== 'win32') return { status: L.STATUS.notMeasured, reason: 'sólo mide en Windows: la ventana de la firma es de ahí' };
  const dir = path.join(lab, 'waiver');
  fs.mkdirSync(dir, { recursive: true });
  const x = armar(dir);
  const env = Object.assign({}, baseEnv, { HOME: x.home, USERPROFILE: x.home, TF_BUILD: '', CLAUDE_CODE_SESSION_ID: 'waiver-probe' });
  delete env.TYCON_WAIVER_IN_WINDOW;
  delete env.TYCON_WAIVER_PLATFORM;

  // 1 · como el agente: la marca puesta y las respuestas por la entrada
  const a = L.run(process.execPath, [MARKER, 'runtime-waiver', x.story], {
    env: Object.assign({}, env, { TYCON_WAIVER_IN_WINDOW: '1' }), input: 'si\nsi\ngato luna reloj\n', timeoutMs: 120000,
  });
  rec.fact('agent_like', { exit: a.exit, signed: fs.existsSync(x.firmas), says: String(a.stderr || '').split(/\r?\n/).filter(Boolean).slice(0, 3) });
  if (fs.existsSync(x.firmas)) rec.finding('waiver:agent-signed', 'waiver', 'con la marca y las respuestas por la entrada, el comando FIRMÓ: el candado no frena al agente');
  else if (a.exit !== 2 || !/BLOQUEADO/.test(String(a.stderr || ''))) rec.finding('waiver:agent-not-blocked-clearly', 'waiver', `no firmó, pero no frenó con el candado (salida ${a.exit}): ${String(a.stderr || '').slice(0, 200)}`);

  // 2 · sin persona: la ventana se abre, nadie escribe, vence. Va con `--terminal`: sin él, el comando lo toma por una
  //     sesión y pide el ok en la ventana de permiso, que no abre ninguna consola
  const b = L.run(process.execPath, [MARKER, 'runtime-waiver', x.story, '--terminal'], {
    env: Object.assign({}, env, { TYCON_WAIVER_TIMEOUT_S: '25' }), timeoutMs: 180000,
  });
  const dice = String(b.stderr || '');
  const arranco = /la ventana arrancó: pid \d+/.test(dice);
  const quedan = vivosCon(x.story, env);
  rec.fact('no_person', { exit: b.exit, signed: fs.existsSync(x.firmas), window_started: arranco, left_running: quedan, says: dice.split(/\r?\n/).filter(Boolean).slice(0, 3) });
  if (fs.existsSync(x.firmas)) rec.finding('waiver:signed-without-person', 'waiver', 'sin nadie que escriba, el comando FIRMÓ');
  else if (b.exit === 0) rec.finding('waiver:no-person-exit-0', 'waiver', `sin persona salió 0 sin firmar: tiene que salir ≠ 0 (${dice.slice(0, 200)})`);
  if (!/venció/.test(dice)) rec.finding('waiver:no-timeout', 'waiver', `sin persona no venció el plazo como se espera: ${dice.slice(0, 300)}`);
  else if (!arranco) rec.finding('waiver:window-not-started', 'waiver', 'venció, pero la ventana no llegó a arrancar el comando en este agente: la espera no se probó');
  if (quedan === null) rec.finding('waiver:cannot-list-processes', 'waiver', 'no pude preguntarle a PowerShell por los procesos que quedaron');
  else if (quedan > 0) rec.finding('waiver:left-running', 'waiver', `después del plazo quedaron ${quedan} proceso(s) del comando vivos`);

  // 3 · la consola de la sonda (la del agente) no es «la ventana nueva»
  const W = require(LIB);
  const c = W.consolaNueva();
  rec.fact('agent_console', c);
  if (c.nueva) rec.finding('waiver:agent-console-is-new', 'waiver', `la consola del agente pasa por «nueva» (${c.conectados} conectados): el candado no la distingue`);

  // 4 · el caso POSITIVO: una ventana nueva de verdad SÍ pasa por «nueva». Sin esto, el paso 3 sale
  //     bien también cuando la cuenta da 1 en todas partes —y entonces la persona tampoco podría firmar—.
  const salida = path.join(dir, 'ventana-nueva.json');
  const guion = path.join(dir, 'ventana-nueva.js');
  fs.writeFileSync(guion, [
    "'use strict';",
    `const W = require(${JSON.stringify(LIB)});`,
    'W.anotarVentana();',
    `require('fs').writeFileSync(${JSON.stringify(salida)}, JSON.stringify(Object.assign({ stdinIsTTY: process.stdin.isTTY === true }, W.consolaNueva())));`,
  ].join('\n'));
  // la ventana se abre con la MISMA función que usa el comando de la firma (comillas, marca y archivo del proceso
  // incluidos): una forma propia de llamar a `start` medía otra cosa
  const prev = { TYCON_WAIVER_TIMEOUT_S: process.env.TYCON_WAIVER_TIMEOUT_S };
  process.env.TYCON_WAIVER_TIMEOUT_S = '90';
  let abierta;
  try { abierta = W.abrirVentana({ script: guion, titulo: 'sonda del waiver' }); } finally {
    if (prev.TYCON_WAIVER_TIMEOUT_S === undefined) delete process.env.TYCON_WAIVER_TIMEOUT_S; else process.env.TYCON_WAIVER_TIMEOUT_S = prev.TYCON_WAIVER_TIMEOUT_S;
  }
  rec.fact('new_window_open', abierta);
  let pos = null;
  try { pos = JSON.parse(fs.readFileSync(salida, 'utf8')); } catch { /* la ventana no llegó a escribir */ }
  rec.fact('new_window', pos);
  if (!pos) rec.finding('waiver:new-window-not-measured', 'waiver', 'la ventana nueva no llegó a contestar: el caso positivo no se midió en este agente');
  else if (!pos.nueva) rec.finding('waiver:new-window-not-recognized', 'waiver', `una ventana NUEVA no pasa por «nueva» (${pos.conectados} conectados${pos.motivo ? `, ${pos.motivo}` : ''}): la persona tampoco podría firmar`);

  return { status: L.STATUS.measured, reason: null };
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value', '--allow-temp': 'flag' });
  if (args.problem || !args.lab || !args.out) { process.stderr.write(`waiver-probe.js: ${args.problem || 'faltan --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  const lab = path.resolve(args.lab);
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`waiver-probe.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const rec = L.recorder(NAME, path.resolve(args.out));
  let result;
  try { result = measure({ lab, rec }); } catch (e) {
    result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` };
  }
  rec.finish(result.status, result.reason);
  say(`${NAME}: ${result.status === L.STATUS.measured ? `medido — ${rec.step.findings.length} hallazgo(s)` : result.reason}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, measure };
