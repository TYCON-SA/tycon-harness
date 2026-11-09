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
 *   5. las firmas del dueño por terminal (`complete-step approve-plan --terminal`, `run-base-controls.sh approve
 *      --terminal`), corridas como en su terminal: abren la ventana nueva, nadie escribe, vence y no firman. Sin la
 *      ventana contestaban «aquí no hay una terminal del dueño» y en Windows ninguna story pasaba de «Aprobar el plan».
 *   6. la emergencia (`harness.js sign emergency`): el número del pedido ata el texto que leyó el freno con las comillas y
 *      barras de PowerShell, Bash y cmd; el agente no la firma; sin persona vence; `--commit` coincide con la carpeta.
 *   7. los argumentos que la consola no deja pasar (comillas, `%`, barra final) llegan intactos a la ventana nueva, por el
 *      ambiente, y esa consola sigue contando como nueva.
 *   8. el arreglo rápido por la forma sin JSON: como el agente, no se abre.
 *   9. qué le llega a un programa desde PowerShell 5.1 y 7, con el JSON y con las banderas.
 *  10. la lectura de procesos del click (`leerArbolWindows`): la cadena de un proceso hasta esta sonda, con Git Bash de por
 *      medio, con los acentos de su línea intactos y cada padre arrancado antes que su hijo.
 *  11. sin perfil del equipo, la coordinadora ordena y no firma: `coordination-without-profile.test.js` corre en Windows, y
 *      si sale rojo queda como hallazgo.
 *  12. el comando de la firma de un cambio de control que imprime `run-base-controls.sh pending`, con el guion en una
 *      carpeta con espacio y apóstrofo: lleva la ruta completa con barras `/` (`/c/…` o `C:/…`) y corre en Git Bash desde
 *      otra carpeta (con `classify`, que no firma nada).
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
const CONTROLES = path.join(__dirname, '..', '..', 'ci', 'run-base-controls.sh');
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
  // con estas variables la firma se corta antes de abrir la ventana, y esta sonda no mediría nada de lo que dice medir
  delete env.CI;
  delete env.GITHUB_ACTIONS;

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
  try { abierta = W.abrirVentana({ script: guion, titulo: 'sonda del waiver', env: {} }); } finally {
    if (prev.TYCON_WAIVER_TIMEOUT_S === undefined) delete process.env.TYCON_WAIVER_TIMEOUT_S; else process.env.TYCON_WAIVER_TIMEOUT_S = prev.TYCON_WAIVER_TIMEOUT_S;
  }
  rec.fact('new_window_open', abierta);
  let pos = null;
  try { pos = JSON.parse(fs.readFileSync(salida, 'utf8')); } catch { /* la ventana no llegó a escribir */ }
  rec.fact('new_window', pos);
  if (!pos) rec.finding('waiver:new-window-not-measured', 'waiver', 'la ventana nueva no llegó a contestar: el caso positivo no se midió en este agente');
  else if (!pos.nueva) rec.finding('waiver:new-window-not-recognized', 'waiver', `una ventana NUEVA no pasa por «nueva» (${pos.conectados} conectados${pos.motivo ? `, ${pos.motivo}` : ''}): la persona tampoco podría firmar`);

  // 5 · las firmas del dueño por terminal: abren la ventana nueva y, sin persona, vencen sin firmar
  firmasPorTerminal({ dir, x, env, rec });

  // 6 · la emergencia: el número del pedido ata el texto que leyó el freno, con las comillas y barras de PowerShell y cmd
  emergencia({ dir, env, rec });

  // 7 · los argumentos que la consola no deja pasar llegan intactos a la ventana, y esa consola sigue contando como nueva
  argumentosDificiles({ dir, W, rec });

  // 8 · el arreglo rápido, como el agente: la marca puesta y las palabras por la entrada
  arregloComoElAgente({ x, env, rec });

  // 9 · lo que le llega a un programa desde cada PowerShell, con el JSON y con las banderas
  desdePowerShell({ dir, env, rec });

  // 10 · la lectura de procesos del click: la cadena real, con acentos y con Git Bash de por medio
  lecturaDeProcesos({ dir, env, rec });

  // 11 · sin perfil del equipo, la coordinadora ordena y no firma: su suite, corrida en Windows
  coordinadoraSinPerfil({ env, rec });

  // 12 · el comando impreso de la firma de un cambio de control corre en Git Bash desde otra carpeta
  comandoDeControles({ dir, env, rec });

  return { status: L.STATUS.measured, reason: null };
}

/**
 * Un pedido que afloja la regla de un control de juguete (el inventario mínimo de base-controls.test.sh), el guion copiado
 * a una carpeta con espacio y apóstrofo, y el comando que imprime `pending` corrido desde otra carpeta, como lo copia una
 * sesión parada en otro puesto. Corre con `classify` en lugar de `approve`: mismo guion y mismos argumentos, sin firmar.
 */
function comandoDeControles({ dir, env, rec }) {
  const bash = L.scanPath('bash', { env })[0];
  if (!bash) { rec.finding('waiver:control-change-command-not-measured', 'waiver', 'no encuentro bash en este agente: el comando impreso no se pudo correr'); return; }
  const base = path.join(dir, 'ruta del guion');
  const repo = path.join(base, 'repo');
  const copia = path.join(base, "arnés de O'Brien", 'scripts', 'ci', 'run-base-controls.sh');
  const otro = path.join(base, 'otro puesto');
  for (const d of [path.join(repo, '.githooks'), path.join(repo, 'scripts', 'ci'), path.join(repo, '.github', 'workflows'), path.join(repo, 'docs'), path.dirname(copia), otro]) fs.mkdirSync(d, { recursive: true });
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => L.run('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'user.email=s@s', '-c', 'user.name=s', '-c', 'init.defaultBranch=main', ...a],
    { env: Object.assign({}, env, { GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA }), timeoutMs: 60000 });
  fs.writeFileSync(path.join(repo, '.githooks', 'pre-commit-checks'), '#!/usr/bin/env bash\nbash "$(git rev-parse --show-toplevel)/scripts/ci/toy-check.sh" || exit 1\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'ci', 'toy-check.sh'), '#!/usr/bin/env bash\nexit 0\n# la regla: scripts/ci/toy-rules.json\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'ci', 'toy-rules.json'), '{ "mode": "block", "allow": ["docs/permitido.txt"] }\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'ci', 'controls-from-base.json'), JSON.stringify({
    hook: '.githooks/pre-commit-checks',
    passes: [{ name: 'pre-commit', mode: 'index', cmd: ['bash', '.githooks/pre-commit-checks'] }],
    controls: [{ name: 'toy', script: 'scripts/ci/toy-check.sh', rules: ['scripts/ci/toy-rules.json'] },
      { name: 'base-controls', script: 'scripts/ci/run-base-controls.sh', rules: ['scripts/ci/controls-from-base.json'] }],
    content: [], workflows: [{ path: '.github/workflows/ci.yml', must_contain: ['run-base-controls'] }], approvals: '.tycon/control-changes.jsonl',
  }, null, 2));
  fs.copyFileSync(CONTROLES, path.join(repo, 'scripts', 'ci', 'run-base-controls.sh'));
  fs.writeFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), 'name: ci\njobs: { ci: { steps: [ { run: "bash run-base-controls" } ] } }\n');
  fs.writeFileSync(path.join(repo, 'docs', 'leeme.txt'), 'nada\n');
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'base'); git('checkout', '-q', '-b', 'pedido');
  fs.writeFileSync(path.join(repo, 'scripts', 'ci', 'toy-rules.json'), '{ "mode": "block", "allow": ["docs/permitido.txt", "docs/malo.txt"] }\n');
  git('commit', '-qam', 'afloja');
  fs.copyFileSync(CONTROLES, copia);
  const p = L.run(bash, [copia, 'pending', '--root', repo, '--base', 'main', '--range', 'main...pedido'], { env, cwd: path.dirname(path.dirname(path.dirname(copia))), timeoutMs: 180000 });
  const salida = `${p.stdout || ''}${p.stderr || ''}`;
  const linea = (salida.split(/\r?\n/).find((l) => l.startsWith('la firma, desde la sesión')) || '').replace(/^[^:]*\): /, '');
  // la ruta tal cual, sin el escape del apóstrofo de las comillas simples ('\'')
  const ruta = ((/^bash '((?:[^']|'\\'')*)' approve /.exec(linea) || [])[1] || '').replace(/'\\''/g, "'") || null;
  const fact = { pending: p.exit, ruta };
  if (!ruta) { rec.fact('control_change_command', fact); rec.finding('waiver:control-change-command-not-printed', 'waiver', `pending no imprimió el comando con la ruta entre comillas (salida ${p.exit}): ${salida.slice(0, 300)}`); return; }
  if (ruta.includes('\\')) rec.finding('waiver:control-change-command-backslash', 'waiver', `la ruta del guion trae barras invertidas: ${ruta}`);
  if (!/^(\/[a-z]\/|[A-Za-z]:\/)/.test(ruta)) rec.finding('waiver:control-change-command-unexpected-form', 'waiver', `la ruta del guion no empieza con /c/ ni con C:/: ${ruta}`);
  // el comando va en un archivo: así le llega a bash con sus comillas tal cual, como lo pega una persona
  const guion = path.join(otro, 'pegado.sh');
  fs.writeFileSync(guion, `${linea.replace(' approve ', ' classify ')}\n`);
  const r = L.run(bash, [guion], { env, cwd: otro, timeoutMs: 120000 });
  Object.assign(fact, { classify: r.exit, says: String(r.stdout || r.stderr || '').split(/\r?\n/).filter(Boolean).slice(0, 2) });
  rec.fact('control_change_command', fact);
  if (r.exit !== 0 || !/"clase":/.test(String(r.stdout || ''))) rec.finding('waiver:control-change-command-failed', 'waiver', `el comando impreso, corrido desde otra carpeta, salió ${r.exit}: ${String(r.stderr || r.stdout || '').slice(0, 300)}`);
}

const SIN_PERFIL = path.join(__dirname, '..', 'coordination-without-profile.test.js');

function coordinadoraSinPerfil({ env, rec }) {
  const r = L.run(process.execPath, ['--test', SIN_PERFIL], { env, timeoutMs: 300000 });
  const fallas = String(r.stdout || '').split(/\r?\n/).filter((l) => /^\s*not ok\b|✖/.test(l)).slice(0, 5);
  rec.fact('coordination_without_profile', { exit: r.exit, failures: fallas });
  if (r.exit !== 0) rec.finding('waiver:coordination-without-profile-failed', 'waiver', `coordination-without-profile.test.js salió ${r.exit} en Windows${fallas.length ? `: ${fallas.join(' · ').slice(0, 300)}` : ''}`);
}

const OWNER_WINDOW = path.join(__dirname, '..', '..', 'lib', 'owner-window.js');

function lecturaDeProcesos({ dir, env, rec }) {
  const salida = path.join(dir, 'cadena.json');
  const guion = path.join(dir, 'lee-su-cadena.js');
  fs.writeFileSync(guion, [
    "'use strict';",
    `const ow = require(${JSON.stringify(OWNER_WINDOW)});`,
    'const desde = Date.now();',
    'const arbol = ow.leerArbolWindows();',
    'const ms = Date.now() - desde;',
    'const m = new Map((arbol || []).map((p) => [p.pid, p]));',
    'const cadena = [];',
    'for (let p = m.get(process.pid); p && cadena.length < 12; p = m.get(p.ppid)) cadena.push(p);',
    `require('fs').writeFileSync(${JSON.stringify(salida)}, JSON.stringify({ ms, procesos: arbol && arbol.length, yo: process.pid, sonda: Number(process.argv[3]), cadena }));`,
  ].join('\n'));
  const leer = (prog, args) => {
    try { fs.unlinkSync(salida); } catch { /* lo normal: no existe */ }
    const r = L.run(prog, args, { env, timeoutMs: 120000 });
    try { return JSON.parse(fs.readFileSync(salida, 'utf8')); } catch { return { sinLeer: { exit: r.exit, says: String(r.stderr || '').slice(0, 300) } }; }
  };
  const directa = leer(process.execPath, [guion, 'motivo ñandú', String(process.pid)]);
  rec.fact('process_read', { ms: directa.ms, procesos: directa.procesos, niveles: (directa.cadena || []).length, sinLeer: directa.sinLeer });
  const yo = (directa.cadena || [])[0];
  if (!yo) { rec.finding('waiver:process-read-failed', 'waiver', `no pude leer los procesos: ${JSON.stringify(directa.sinLeer || directa)}`); return; }
  if (!yo.comando.includes('ñandú')) rec.finding('waiver:process-read-accents', 'waiver', `los acentos de la línea no llegaron intactos: ${yo.comando.slice(-60)}`);
  if (!(directa.cadena || []).some((p) => p.pid === directa.sonda)) rec.finding('waiver:process-read-chain', 'waiver', 'la cadena de un hijo directo no llega a la sonda que lo lanzó');
  const desordenado = directa.cadena.find((p, k) => k > 0 && p.inicio > directa.cadena[k - 1].inicio);
  if (desordenado) rec.finding('waiver:process-read-order', 'waiver', `un padre arrancó después que su hijo y la lectura lo dejó en la cadena: ${desordenado.pid}`);
  if (require(OWNER_WINDOW).leerArbol() !== null) rec.finding('waiver:emergency-read-changed', 'waiver', 'la lectura de la emergencia dejó de negarse en Windows');
  const bash = L.scanPath('bash', { env })[0];
  if (!bash) { rec.finding('waiver:process-read-bash-not-measured', 'waiver', 'no encuentro bash en este agente: la cadena con Git Bash no se midió'); return; }
  const porBash = leer(bash, ['-c', `"${process.execPath.replace(/\\/g, '/')}" "${guion.replace(/\\/g, '/')}" 'motivo ñandú' ${process.pid}`]);
  rec.fact('process_read_bash', (porBash.cadena || []).map((p) => ({ ejecutable: p.ejecutable, inicio: p.inicio })));
  const hayBash = (porBash.cadena || []).some((p) => /bash\.exe$/i.test(p.ejecutable || ''));
  if (!hayBash) rec.finding('waiver:process-read-bash', 'waiver', `la cadena no muestra el bash que lanzó al guion: ${JSON.stringify(porBash.sinLeer || porBash.cadena)}`.slice(0, 500));
}

const DIFICILES = ['adhoc', 'set', '{"reason":"subir al 50% & ^ ñ","maxFiles":3}', 'C:\\repo\\', '--terminal'];

function argumentosDificiles({ dir, W, rec }) {
  const salida = path.join(dir, 'ventana-dificil.json');
  const guion = path.join(dir, 'ventana-dificil.js');
  fs.writeFileSync(guion, [
    "'use strict';",
    `const W = require(${JSON.stringify(LIB)});`,
    'W.anotarVentana();',
    `require('fs').writeFileSync(${JSON.stringify(salida)}, JSON.stringify(Object.assign({ argv: process.argv.slice(2) }, W.consolaNueva())));`,
  ].join('\n'));
  const prev = process.env.TYCON_WAIVER_TIMEOUT_S;
  process.env.TYCON_WAIVER_TIMEOUT_S = '90';
  let abierta;
  try { abierta = W.abrirVentana({ script: guion, args: DIFICILES, titulo: 'sonda de los argumentos', env: {} }); } finally {
    if (prev === undefined) delete process.env.TYCON_WAIVER_TIMEOUT_S; else process.env.TYCON_WAIVER_TIMEOUT_S = prev;
  }
  let pos = null;
  try { pos = JSON.parse(fs.readFileSync(salida, 'utf8')); } catch { /* la ventana no llegó a escribir */ }
  rec.fact('hard_args_window', { abierta, pos });
  if (!pos) rec.finding('waiver:hard-args-not-measured', 'waiver', `la ventana con argumentos difíciles no llegó a contestar (${JSON.stringify(abierta)})`);
  else if (JSON.stringify(pos.argv) !== JSON.stringify(DIFICILES)) rec.finding('waiver:hard-args-changed', 'waiver', `los argumentos cambiaron en el camino: ${JSON.stringify(pos.argv)}`);
  else if (!pos.nueva) rec.finding('waiver:hard-args-console-not-new', 'waiver', `con los argumentos por el ambiente, la ventana no pasa por «nueva» (${pos.conectados} conectados)`);
}

function arregloComoElAgente({ x, env, rec }) {
  const a = L.run(process.execPath, [MARKER, 'adhoc', 'set', '--reason', 'sonda de la ventana', '--terminal', '--for-session', 'waiver-agente'], {
    env: Object.assign({}, env, { TYCON_WAIVER_IN_WINDOW: '1' }), input: 'gato luna reloj\n', timeoutMs: 120000,
  });
  const declarado = fs.existsSync(path.join(x.home, '.claude', '.tycon-pipeline', 'adhoc', 'waiver-agente.json'));
  rec.fact('adhoc_agent_like', { exit: a.exit, declarado, says: String(a.stderr || '').split(/\r?\n/).filter(Boolean).slice(0, 3) });
  if (declarado) rec.finding('waiver:adhoc-agent-signed', 'waiver', 'con la marca y las palabras por la entrada, el arreglo rápido SE ABRIÓ: el candado no frena al agente');
  else if (a.exit === 0 || !String(a.stderr || '').includes('🔒')) rec.finding('waiver:adhoc-agent-not-measured', 'waiver', `no se abrió, pero tampoco lo negó el candado: no se midió (salió ${a.exit}): ${String(a.stderr || '').slice(0, 200)}`);
}

function desdePowerShell({ dir, env, rec }) {
  const guion = path.join(dir, 'imprime-argumentos.js');
  fs.writeFileSync(guion, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  const formas = { json: ['{"reason":"motivo con espacios","maxFiles":3}'], banderas: ['--reason', 'motivo con espacios', '--max-files', '3'] };
  for (const nombre of ['powershell', 'pwsh']) {
    const ps = L.scanPath(nombre, { env })[0];
    if (!ps) { rec.fact(`quoting_${nombre}`, 'no está en este agente'); continue; }
    const visto = {};
    for (const [forma, args] of Object.entries(formas)) {
      const citados = args.map((a) => `'${a}'`).join(' ');
      const r = L.run(ps, ['-NoProfile', '-NonInteractive', '-Command', `& '${process.execPath}' '${guion}' ${citados}`], { env, timeoutMs: 60000 });
      const llego = String(r.stdout || '').trim();
      visto[forma] = { intacto: llego === JSON.stringify(args), llego };
    }
    rec.fact(`quoting_${nombre}`, visto);
    if (!visto.banderas.intacto) rec.finding(`waiver:reason-flags-broken-${nombre}`, 'waiver', `${nombre} no pasa intacta la forma con --reason: ${visto.banderas.llego}`);
  }
}

/**
 * La emergencia en Windows (lib/harness-sign.js). El freno lee el comando de la herramienta (PowerShell o Bash) y guarda
 * ese texto exacto como un pedido con número; la persona firma el número, nadie retipea el comando. Mide:
 *   a. por cada comando —con barras invertidas, comillas dobles y la forma de cmd—: frena y da un número; firmado ese
 *      número, el mismo comando pasa UNA vez; un espacio de más no;
 *   b. como el agente (la marca de la ventana y las tres palabras por la entrada): no firma;
 *   c. sin persona: la ventana nueva se abre, vence y no firma;
 *   d. `--commit` en una carpeta de Windows: lo consume el próximo commit de ese repo.
 * Los permisos y pedidos viven en la casa de la cuenta del agente: la sonda borra lo suyo al terminar.
 */
function emergencia({ dir, env, rec }) {
  const S = require(path.join(__dirname, '..', '..', 'lib', 'harness-sign.js'));
  const HARNESS = path.join(__dirname, '..', '..', 'setup', 'harness.js');
  const HOOK = path.join(__dirname, '..', '..', 'hooks', 'safety-guard-pre.sh');
  const bash = L.scanPath('bash', { env })[0];
  const marca = `sonda_${Date.now()}`;
  // la sonda hace de persona: el registro de mentira y el origen dado por bueno (en Windows el árbol no se mira)
  const nadie = { append: () => ({ ok: true, path: '(sonda)' }), signer: 'sonda', levels: {}, origen: () => ({ ok: true }) };
  // la terminal de mentira contesta «s» a «¿Firmás? (s/n)»
  const firmo = (opts) => S.sign({ ...nadie, ...opts, tty: { hay: () => true, preguntar: () => 's' } });
  const limpiar = () => {
    for (const d of [S.carpeta(), path.join(S.carpeta(), 'pedidos')]) {
      let fs0 = [];
      try { fs0 = fs.readdirSync(d); } catch { continue; }
      for (const f of fs0) { const p = path.join(d, f); try { if (fs.statSync(p).isFile() && leer(p).includes(marca)) fs.rmSync(p); } catch { /* ya no está */ } }
    }
  };
  try {
    if (!bash) { rec.finding('waiver:emergency-not-measured', 'waiver', 'no encuentro bash en este agente: el freno de seguridad no se pudo correr'); return; }
    const freno = (herramienta, comando) => L.run(bash, [HOOK], {
      env, input: JSON.stringify({ session_id: 'waiver-emergencia', tool_name: herramienta, tool_input: { command: comando }, cwd: dir }), timeoutMs: 120000,
    });
    // stable-data: son textos que se le pasan al freno, que nunca los corre
    const casos = [
      ['PowerShell', `sqlcmd -S .\\SQLEXPRESS -Q "DROP DATABASE ${marca}_a"`],
      ['PowerShell', `git push --force origin main; Write-Output "${marca}"`],
      ['Bash', `sqlcmd -S .\\\\SQLEXPRESS -Q "DROP DATABASE ${marca}_b"`],
      ['PowerShell', `cmd /c "sqlcmd -S .\\SQLEXPRESS -Q ""DROP DATABASE ${marca}_c"""`],
    ];
    const vistos = [];
    for (const [herramienta, comando] of casos) {
      const a = freno(herramienta, comando);
      const n = /--request ([0-9a-f]{8})/.exec(String(a.stderr || ''));
      const caso = { herramienta, comando, frena: a.exit, numero: n ? n[1] : null };
      vistos.push(caso);
      if (a.exit !== 2 || !n) { rec.finding('waiver:emergency-no-request', 'waiver', `${herramienta}: el freno no frenó con número (salida ${a.exit}): ${String(a.stderr || '').slice(0, 200)}`); continue; }
      const f = firmo({ id: 'emergency', reason: 'sonda de Windows', request: n[1] });
      caso.firma = f.code;
      if (f.code !== 0) { rec.finding('waiver:emergency-not-signed', 'waiver', `${herramienta}: el número del freno no se pudo firmar: ${f.lines.join(' ')}`); continue; }
      caso.otro_texto = freno(herramienta, `${comando} `).exit;
      caso.pasa = freno(herramienta, comando).exit;
      caso.otra_vez = freno(herramienta, comando).exit;
      if (caso.otro_texto !== 2) rec.finding('waiver:emergency-other-text-passed', 'waiver', `${herramienta}: con un espacio de más el comando pasó: el permiso no está atado al texto`);
      if (caso.pasa !== 0) rec.finding('waiver:emergency-text-mismatch', 'waiver', `${herramienta}: firmado el número, el mismo comando sigue frenado: el texto que leyó el freno al frenar y al volver no coincide (${comando})`);
      if (caso.otra_vez !== 2) rec.finding('waiver:emergency-reused', 'waiver', `${herramienta}: el permiso dejó pasar el comando dos veces`);
    }
    rec.fact('emergency_texts', vistos);

    // b · como el agente: la marca de la ventana y las tres palabras por la entrada
    const pedidoB = S.pedir({ comando: `sqlcmd -Q "DROP DATABASE ${marca}_agente"` });
    const b = L.run(process.execPath, [HARNESS, 'sign', 'emergency', '--reason', 'sonda', '--request', pedidoB.numero], {
      env: Object.assign({}, env, { TYCON_WAIVER_IN_WINDOW: '1' }), input: 'gato luna reloj\nfirmo\n', timeoutMs: 120000,
    });
    const firmoB = S.consumir({ comando: `sqlcmd -Q "DROP DATABASE ${marca}_agente"` });
    rec.fact('emergency_agent_like', { exit: b.exit, signed: Boolean(firmoB && firmoB.ok) });
    if (firmoB && firmoB.ok) rec.finding('waiver:emergency-agent-signed', 'waiver', 'con la marca y las palabras por la entrada, la emergencia SE FIRMÓ: el candado no frena al agente');

    // c · sin persona: la ventana se abre, vence y no firma
    const pedidoC = S.pedir({ comando: `sqlcmd -Q "DROP DATABASE ${marca}_nadie"` });
    const c = L.run(process.execPath, [HARNESS, 'sign', 'emergency', '--reason', 'sonda', '--request', pedidoC.numero], {
      env: Object.assign({}, env, { TYCON_WAIVER_TIMEOUT_S: '25' }), timeoutMs: 180000,
    });
    const firmoC = S.consumir({ comando: `sqlcmd -Q "DROP DATABASE ${marca}_nadie"` });
    const diceC = `${c.stdout || ''}${c.stderr || ''}`;
    rec.fact('emergency_no_person', { exit: c.exit, signed: Boolean(firmoC && firmoC.ok), says: diceC.split(/\r?\n/).filter(Boolean).slice(0, 3) });
    if (firmoC && firmoC.ok) rec.finding('waiver:emergency-signed-without-person', 'waiver', 'sin nadie que escriba, la emergencia SE FIRMÓ');
    else if (/aquí no hay una/.test(diceC)) rec.finding('waiver:emergency-no-window', 'waiver', `la emergencia no abrió la ventana nueva: ${diceC.slice(0, 300)}`);
    else if (!/venció/.test(diceC)) rec.finding('waiver:emergency-no-timeout', 'waiver', `la emergencia no venció el plazo como se espera: ${diceC.slice(0, 300)}`);

    // d · --commit en una carpeta de Windows
    const repo = path.join(dir, `repo ${marca}`);
    fs.mkdirSync(repo, { recursive: true });
    L.run('git', ['-C', repo, 'init', '-q'], { env, timeoutMs: 60000 });
    const d = firmo({ id: 'emergency', reason: `sonda de Windows ${marca}`, commit: true, cwd: repo });
    const consumo = L.run(process.execPath, [path.join(__dirname, '..', '..', 'lib', 'harness-sign.js'), 'consume-commit', '--repo', repo], { env, timeoutMs: 60000 });
    rec.fact('emergency_commit', { firma: d.code, consumo: consumo.exit });
    if (d.code !== 0 || consumo.exit !== 0) rec.finding('waiver:emergency-commit-mismatch', 'waiver', `--commit en ${repo}: firma ${d.code}, consumo ${consumo.exit}: el repo del commit no coincide con el de la firma`);
  } finally { limpiar(); }
}

/** Una corrida parada en «Aprobar el plan» (sesión waiver-owner) y su story commiteada, para las firmas por terminal. */
function firmasPorTerminal({ dir, x, env, rec }) {
  const pasos = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'];
  const activos = path.join(x.home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activos, { recursive: true });
  fs.writeFileSync(path.join(activos, 'waiver-owner.json'), JSON.stringify({ sessionId: 'waiver-owner', storyId: '9.9', storyPath: x.story, repo: x.repo, stepScheme: 2, stepsCompleted: pasos.slice(0, 3), stepsPending: pasos.slice(3) }));
  const repo = path.join(dir, 'controles');
  fs.mkdirSync(repo, { recursive: true });
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => L.run('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'user.email=s@s', '-c', 'user.name=s', ...a],
    { env: Object.assign({}, env, { GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA }), timeoutMs: 60000 });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'regla.txt'), 'una regla\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  // como en la terminal del dueño: sin variable de sesión, con la sesión destino en --for-session
  const owner = Object.assign({}, env, { TYCON_WAIVER_TIMEOUT_S: '25' });
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID']) delete owner[k];
  const bash = L.scanPath('bash', { env })[0];
  const casos = [
    ['approve-plan', process.execPath, [MARKER, 'complete-step', 'approve-plan', '--terminal', '--for-session', 'waiver-owner'], () => /plan-approval-signed/.test(leer(path.join(x.home, '.claude', '.tycon-pipeline', 'gates.log')))],
    ['control-change', bash, [CONTROLES, 'approve', '--root', repo, '--file', 'regla.txt', '--out', '.tycon/control-changes.jsonl', '--terminal'], () => fs.existsSync(path.join(repo, '.tycon', 'control-changes.jsonl'))],
    ['adhoc-json', process.execPath, [MARKER, 'adhoc', 'set', '{"reason":"sonda de la ventana","maxFiles":3}', '--terminal', '--for-session', 'waiver-adhoc'], () => fs.existsSync(path.join(activos, '..', 'adhoc', 'waiver-adhoc.json'))],
    ['adhoc-banderas', process.execPath, [MARKER, 'adhoc', 'set', '--reason', 'sonda de la ventana', '--max-files', '3', '--terminal', '--for-session', 'waiver-adhoc'], () => fs.existsSync(path.join(activos, '..', 'adhoc', 'waiver-adhoc.json'))],
  ];
  for (const [nombre, prog, args, firmo] of casos) {
    if (!prog) { rec.finding(`waiver:owner-terminal-${nombre}-not-measured`, 'waiver', 'no encuentro bash en este agente: la firma del portón por terminal no se midió'); continue; }
    const r = L.run(prog, args, { env: owner, cwd: repo, timeoutMs: 180000 });
    const dice = `${r.stdout || ''}${r.stderr || ''}`;
    rec.fact(`owner_terminal_${nombre.replace(/-/g, '_')}`, { exit: r.exit, signed: firmo(), says: dice.split(/\r?\n/).filter(Boolean).slice(0, 3) });
    if (firmo()) rec.finding(`waiver:owner-terminal-${nombre}-signed`, 'waiver', 'sin nadie que escriba, la firma por terminal FIRMÓ');
    else if (/aquí no hay una|terminal interactiva de verdad/.test(dice)) rec.finding(`waiver:owner-terminal-${nombre}-no-window`, 'waiver', `la firma por terminal no abrió la ventana nueva: ${dice.slice(0, 300)}`);
    else if (!/venció/.test(dice)) rec.finding(`waiver:owner-terminal-${nombre}-no-timeout`, 'waiver', `la firma por terminal no venció el plazo como se espera: ${dice.slice(0, 300)}`);
  }
}

function leer(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }

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
  // el reporte sólo los cuenta, y estos hallazgos no ponen rojo el trabajo: sin esto no se leen en la CI
  for (const f of rec.step.findings) say(`  ${JSON.stringify(f).slice(0, 500)}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, measure, emergencia, comandoDeControles };
