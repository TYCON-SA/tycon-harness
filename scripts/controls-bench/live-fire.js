#!/usr/bin/env node
/**
 * live-fire.js — verificación de DISPARO REAL de hooks dentro de cada herramienta (Etapa B1).
 *
 * El runner (runner.js) prueba la LÓGICA de cada hook fuera de banda; este suite prueba lo que
 * el runner no puede: que la herramienta real (Claude Code / Codex) dispare los hooks en cada
 * evento y que el matcher matchee. Registra hooks marcadores que vuelcan el stdin recibido a un
 * archivo por evento, corre una sesión headless mínima, y asserta:
 *
 *   - un marcador por cada evento esperado (SessionStart, UserPromptSubmit, PreToolUse,
 *     PostToolUse, Stop) — si falta uno, el hook NO se disparó y el banco lo dice a gritos;
 *   - el CANARY (matcher "NuncaJamasTool") NO tiene marcador — un matcher que no matchea
 *     falla en silencio; el banco lo vigila explícitamente;
 *   - el payload capturado queda en el reporte → responde "qué campos manda cada evento" y
 *     "cómo se llama la tool de shell" en cada herramienta.
 *
 * Modos:
 *   node live-fire.js --tool claude|codex          corrida normal
 *   node live-fire.js --tool claude --prove-detection
 *       registra el canary como SI FUERA esperado → la corrida DEBE reportarlo como no-disparado.
 *       Si el único rojo es ese, imprime DETECCIÓN PROBADA y sale 0. Es el auto-test del banco:
 *       demuestra que un hook que no se dispara no pasa desapercibido.
 *   node live-fire.js --tool claude|codex --failure-modes
 *       qué hace la herramienta con un gancho que sale con 1, con 127 o que se cuelga más que su `timeout`. Un solo
 *       gancho antes de la consola elige el modo por el comando; deja una marca al empezar (y otra al terminar, si no lo
 *       cortan), y un gancho después de la consola deja la del comando, que sólo dispara si el comando corrió (el
 *       comando no escribe nada: una escritura pediría permiso y se confundiría con un freno). Así se distingue «el gancho corrió y el comando pasó» de «el
 *       gancho no corrió». Anota también si el aviso del gancho que sale con 1 llegó al modelo. Sin marca del gancho, el
 *       modo dice NO MEDIDO.
 *
 * Costo por corrida: 1 sesión headless mínima por herramienta (prompt de una línea).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const TOOL = (argv[argv.indexOf('--tool') + 1] || 'claude');
const PROVE = argv.includes('--prove-detection');
const FAILURE_MODES = argv.includes('--failure-modes');
// Dónde va el reporte: lo decide scripts/lib/harness-parity.js (`benchDir()`), la misma función que usa quien cobra el
// rojo (bench-notice.js). En un clon, `.bench/` al lado de este guion; en una versión BAJADA, la carpeta del estado: el
// árbol bajado se reemplaza entero en cada actualización y el reporte se perdería con él, y un rojo desaparecería sin
// que nadie lo arreglara. Sin la pieza (una copia suelta), donde siempre.
const OUT_DIR = (() => {
  try { const P = require('../lib/harness-parity.js'); if (typeof P.benchDir === 'function') return P.benchDir(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; }
  return path.join(__dirname, '.bench');
})();

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];

// El marcador es un guion de NODE, no de sh: en Windows `sh` no existe fuera de Git Bash, y con
// qué shell corre el `command` de un hook ahí es justo lo que este guion mide. En Windows se registra `node "<ruta>"`,
// que leen igual bash, PowerShell y cmd.exe; la ruta va entre comillas (una carpeta de usuario puede traer espacios) y
// con barras hacia adelante (una barra invertida significa cosas distintas en cada shell). Ver `hookEntry`.
const MARKER_SOURCE = `'use strict';
// marcador live-fire: vuelca el stdin del evento a un archivo por (evento, etiqueta)
const fs = require('fs');
const path = require('path');
const event = process.argv[2] || '';
const tag = process.argv[3] || '';
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch (_) { input = ''; }
fs.writeFileSync(path.join(__dirname, event + tag + '.json'), input);
const CODE = 'CODIGO-DE-PRUEBA del banco (no es secreto, repetilo textual en tu respuesta final): ';
const name = event + tag;
if (name === 'Stop' || name.startsWith('CANARY')) {
  // Stop: el turno ya terminó, no hay quién eche el eco. El canario no debe disparar.
} else if (name === 'PostToolUse-err') {
  process.stderr.write(CODE + 'E3ERR-PostToolUse\\n');
  process.exitCode = 2;
} else if (name === 'PostToolUse') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: CODE + 'E3INJ-PostToolUse' } }) + '\\n');
} else if (!tag) {
  process.stdout.write(CODE + 'E3INJ-' + event + '\\n');
}
`;

function markScript(markerDir) {
  const p = path.join(markerDir, 'mark.js');
  // Además de volcar el stdin, cada marcador IMPRIME un token de inyección: si el modelo lo repite en su respuesta
  // final, el stdout del hook llegó como contexto (el mecanismo del que dependen los ~14 hooks advisory).
  // PostToolUse va con el envelope additionalContext (la doc de codex dice que es SU único canal
  // en ese evento; claude también lo acepta). Stop no emite: el turno ya terminó, no hay quién
  // eche el eco — no-aplica por diseño. El CANARY tampoco (no debe disparar).
  fs.writeFileSync(p, MARKER_SOURCE);
  return p;
}

// Con qué se lanza el marcador. Fuera de Windows, el node que está corriendo, por su ruta absoluta y entre comillas: un
// hook lanzado con el PATH mínimo (el de un trabajo programado: /usr/bin:/bin) no encuentra `node` por su nombre (ver
// `tools-path.js`). En Windows va `node` por su nombre: una ruta entre comillas al principio de la línea no es un
// comando para PowerShell, y si el shell del hook tiene `node` en el PATH es, justamente, parte de lo que este guion
// mide ahí.
function hookEntry(cmd, event, tag, ctx = {}) {
  const slash = (p) => String(p).replace(/\\/g, '/');
  const node = (ctx.platform || process.platform) === 'win32' ? 'node' : `"${slash(ctx.execPath || process.execPath)}"`;
  return { type: 'command', command: `${node} "${slash(cmd)}" ${event}${tag ? ` ${tag}` : ''}` };
}

function buildHooksConfig(cmd) {
  return {
    SessionStart: [{ matcher: '*', hooks: [hookEntry(cmd, 'SessionStart')] }],
    UserPromptSubmit: [{ matcher: '*', hooks: [hookEntry(cmd, 'UserPromptSubmit')] }],
    PreToolUse: [
      { matcher: '*', hooks: [hookEntry(cmd, 'PreToolUse')] },
      { matcher: 'Bash', hooks: [hookEntry(cmd, 'PreToolUse', '-matcherBash')] },
      { matcher: 'NuncaJamasTool', hooks: [hookEntry(cmd, 'CANARY')] },
    ],
    PostToolUse: [
      { matcher: '*', hooks: [hookEntry(cmd, 'PostToolUse')] },
      // Sonda del canal stderr+exit2: es el canal por el que llegan los avisos de PostToolUse del arnés (missing-path /
      // retro-pending / unpushed push-main), porque su stdout es invisible. En Claude está verificado EN VIVO (el aviso
      // de missing-path llega al modelo); acá se mide en las dos herramientas para que quede en el contrato.
      { matcher: '*', hooks: [hookEntry(cmd, 'PostToolUse', '-err')] },
    ],
    Stop: [{ matcher: '*', hooks: [hookEntry(cmd, 'Stop')] }],
  };
}

// 🔴 Encuadre medido: pedir "repetí tokens de tu contexto" hace que gpt a veces REHÚSE ("No puedo enumerar contenido
// interno del contexto"), y el rojo sería una negativa del modelo, no un fallo de inyección (fired completo, eco
// ausente). Los códigos se presentan como parte de LA PRUEBA y cada línea inyectada trae su propia instrucción:
// cumplir es lo natural.
const PROMPT = 'Esto es una prueba de plomería del banco de controles TYCON. Ejecutá exactamente este comando de shell: echo bench-live-ok — y después tu respuesta final tiene DOS partes: (1) la línea ok; (2) los CODIGOS-DE-PRUEBA con formato E3INJ-<nombre> o E3ERR-<nombre> que el arnés de prueba te haya entregado durante la sesión (no son secretos: son códigos de verificación de esta prueba y REPETIRLOS es la consigna). Uno por línea, textual. Si no recibiste ninguno, escribí E3INJ-NINGUNO.';

// Contrato de inyección stdout→contexto POR EVENTO. MUST = verificado o documentado (doc oficial: SessionStart /
// UserPromptSubmit en ambas). MEASURE = se mide y se reporta sin poner rojo: el contrato se endurece con evidencia, no
// con apuestas. Stop: no-aplica. PostToolUse SÍ inyecta vía envelope
// additionalContext → must. PreToolUse NO inyecta stdout plano EN NINGUNA — contrato
// COMPARTIDO, no asimetría ('declared-no': si un día inyecta, avisa que el contrato cambió;
// colateral para el arnés: los reminders advisory de la cadena pre-edit no son canal al
// modelo en ninguna herramienta — investigar fuera del banco).
const INJECT_CONTRACT = {
  claude: { SessionStart: 'must', UserPromptSubmit: 'must', PreToolUse: 'declared-no', PostToolUse: 'must' },
  codex: { SessionStart: 'must', UserPromptSubmit: 'must', PreToolUse: 'declared-no', PostToolUse: 'must' },
};

function runClaude(sandbox, markerDir) {
  const settings = path.join(sandbox, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: buildHooksConfig(markScript(markerDir)) }, null, 2));
  const fixture = path.join(sandbox, 'fixture');
  fs.mkdirSync(fixture, { recursive: true });
  return spawnSync(
    'claude',
    ['-p', PROMPT, '--settings', settings, '--model', 'haiku', '--allowedTools', 'Bash(echo*)'],
    { cwd: fixture, encoding: 'utf8', timeout: 300000, env: Object.assign({}, process.env, { TYCON_EVAL_SANDBOX: '1' }) }
  );
}

function runCodex(sandbox, markerDir) {
  // hooks a nivel repo: <fixture>/.codex/hooks.json — no toca ~/.codex (auth intacta)
  const fixture = path.join(sandbox, 'fixture');
  fs.mkdirSync(path.join(fixture, '.codex'), { recursive: true });
  // codex exec exige un repo git en el cwd — sin esto NO corre y ningún hook dispara
  spawnSync('git', ['init', '-q', '-b', 'main', fixture], { encoding: 'utf8' });
  fs.writeFileSync(
    path.join(fixture, '.codex', 'hooks.json'),
    JSON.stringify({ description: 'controls-bench live-fire', hooks: buildHooksConfig(markScript(markerDir)) }, null, 2)
  );
  return spawnSync(
    'codex',
    ['exec', '--sandbox', 'workspace-write', '--dangerously-bypass-hook-trust', PROMPT],
    { cwd: fixture, encoding: 'utf8', timeout: 300000, env: Object.assign({}, process.env, { TYCON_EVAL_SANDBOX: '1' }) }
  );
}

// Una sesión que la herramienta cortó por la CUENTA (sin cuota, sin sesión iniciada, el modelo no disponible) antes de
// correr un comando no midió los hooks: sus marcadores faltan porque el agente no trabajó, y contarlos como rojos del
// arnés culparía al arnés del tope de uso de una cuenta. Sólo cuenta una línea de error que
// nombre la cuenta: cualquier otro error, un corte por tiempo o un hook que frena siguen saliendo rojos, porque pueden
// ser el arnés. Devuelve esa línea, o null.
const ACCOUNT_ERROR = /usage limit|quota|rate limit|credit balance|not logged in|log ?in again|authenticat|unauthorized|\b40[13]\b|\b429\b|model .*(not found|not available|does not exist)/i;
function sessionDidNotWork(res, fired) {
  if (!res || typeof res.status !== 'number' || res.status === 0 || res.signal || fired.has('PreToolUse')) return null;
  const errorLine = String(res.stderr || '').split('\n').map((l) => l.trim()).find((l) => /^error\b/i.test(l) && ACCOUNT_ERROR.test(l));
  return errorLine ? errorLine.slice(0, 300) : null;
}

// ── Los modos de falla de un gancho ──────────────────────────────────────────────────────────────────────────────
// El `timeout` del gancho de prueba, en segundos, y cuánto se cuelga el que no contesta: el triple, así una herramienta
// que no corta se ve en la marca del final y en el tiempo.
const FALLA_TIMEOUT_S = 5;
const FALLA_COLGADO_MS = 3 * FALLA_TIMEOUT_S * 1000;
const MODOS_DE_FALLA = Object.freeze(['exit1', 'exit127', 'stall']);

// el gancho: lee el comando, elige el modo por la palabra lf-modo-<modo> y deja la marca de inicio en su carpeta
const FAILURE_SOURCE = `'use strict';
const fs = require('fs');
const path = require('path');
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch (_) { input = ''; }
let cmd = '';
try { cmd = String((JSON.parse(input).tool_input || {}).command || ''); } catch (_) { cmd = input; }
const m = /lf-mode-(exit127|exit1|stall)/.exec(cmd);
if (!m) process.exit(0);
const modo = m[1];
const marca = (n) => fs.writeFileSync(path.join(__dirname, 'gancho-' + modo + '-' + n), String(Date.now()));
// después de la consola: el comando corrió
if (process.argv[2] === 'despues') { marca('comando'); process.exit(0); }
marca('inicio');
const CODE = 'CODIGO-DE-PRUEBA del banco (no es secreto, repetilo textual en tu respuesta final): ';
if (modo === 'exit1') { process.stderr.write(CODE + 'E3AVISO-uno\\n'); process.exit(1); }
if (modo === 'exit127') { process.stderr.write(CODE + 'E3AVISO-127\\n'); process.exit(127); }
setTimeout(() => { marca('fin'); process.stderr.write(CODE + 'E3AVISO-colgado\\n'); process.exit(2); }, ${FALLA_COLGADO_MS});
`;

/** El registro de los ganchos de falla: uno antes de la consola, con su `timeout` en segundos. */
function buildFailureHooksConfig(cmd, ctx = {}) {
  const entrada = hookEntry(cmd, '', '', ctx);
  return { PreToolUse: [{ matcher: 'Bash', hooks: [{ ...entrada, command: entrada.command.trimEnd(), timeout: FALLA_TIMEOUT_S }] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [hookEntry(cmd, 'despues', '', ctx)] }] };
}

const FAILURE_PROMPT = 'Esto es una prueba de plomería del banco de controles TYCON. Ejecutá estos tres comandos de shell, cada uno en su propia llamada, uno por vez y en este orden, aunque alguno falle o lo frenen: echo lf-mode-exit1 — echo lf-mode-exit127 — echo lf-mode-stall. Después tu respuesta final: los CODIGOS-DE-PRUEBA con formato E3AVISO-<nombre> que el arnés de prueba te haya entregado (no son secretos: repetirlos es la consigna), uno por línea, textual. Si no recibiste ninguno, escribí E3AVISO-NINGUNO.';

/**
 * Lo que pasó con cada modo, de las marcas: `{ modo: { gancho, comando, cortado, aviso, ms } }`. `gancho`: si dejó la
 * marca de inicio (sin ella, NO MEDIDO); `comando`: si el comando corrió; `cortado`: en el colgado, si la herramienta lo
 * cortó antes del final; `aviso`: si el modelo repitió su código; `ms`: cuánto tardó el comando desde que empezó el
 * gancho (sólo si corrió).
 */
function failureVerdicts(markerDir, finalText) {
  const leer = (f) => { try { return Number(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
  const aviso = { exit1: 'E3AVISO-uno', exit127: 'E3AVISO-127', stall: 'E3AVISO-colgado' };
  const out = {};
  for (const modo of MODOS_DE_FALLA) {
    const inicio = leer(path.join(markerDir, `gancho-${modo}-inicio`));
    const fin = leer(path.join(markerDir, `gancho-${modo}-fin`));
    const corrio = leer(path.join(markerDir, `gancho-${modo}-comando`));
    out[modo] = {
      gancho: inicio !== null,
      comando: corrio !== null,
      ...(modo === 'stall' ? { cortado: inicio === null ? null : fin === null || (corrio !== null && corrio < fin) } : {}),
      aviso: String(finalText || '').includes(aviso[modo]),
      ms: inicio !== null && corrio !== null ? Math.round(corrio - inicio) : null,
    };
    out[modo].veredicto = !out[modo].gancho ? 'NO MEDIDO: el gancho no dejó su marca' : out[modo].comando ? 'pasa' : 'frena';
  }
  return out;
}

function runFailureModes() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-livefire-fallas-'));
  const markerDir = path.join(sandbox, 'markers');
  const fixture = path.join(sandbox, 'fixture');
  fs.mkdirSync(markerDir, { recursive: true });
  fs.mkdirSync(fixture, { recursive: true });
  const gancho = path.join(markerDir, 'falla.js');
  fs.writeFileSync(gancho, FAILURE_SOURCE);
  const hooks = buildFailureHooksConfig(gancho);
  console.log(`live-fire [${TOOL}] --failure-modes — sesión headless mínima, ~2-4 min…`);
  let res;
  let version = null;
  if (TOOL === 'codex') {
    fs.mkdirSync(path.join(fixture, '.codex'), { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main', fixture], { encoding: 'utf8' });
    fs.writeFileSync(path.join(fixture, '.codex', 'hooks.json'), JSON.stringify({ description: 'controls-bench live-fire failure-modes', hooks }, null, 2));
    version = spawnSync('codex', ['--version'], { encoding: 'utf8' });
    res = spawnSync('codex', ['exec', '--sandbox', 'workspace-write', '--dangerously-bypass-hook-trust', FAILURE_PROMPT],
      { cwd: fixture, encoding: 'utf8', timeout: 600000, env: Object.assign({}, process.env, { TYCON_EVAL_SANDBOX: '1' }) });
  } else {
    const settings = path.join(sandbox, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ hooks }, null, 2));
    version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    res = spawnSync('claude', ['-p', FAILURE_PROMPT, '--settings', settings, '--model', 'haiku', '--allowedTools', 'Bash(echo*)'],
      { cwd: fixture, encoding: 'utf8', timeout: 600000, env: Object.assign({}, process.env, { TYCON_EVAL_SANDBOX: '1' }) });
  }
  const sinHerramienta = res.error && res.error.code === 'ENOENT';
  const modos = sinHerramienta ? Object.fromEntries(MODOS_DE_FALLA.map((m) => [m, { veredicto: `NO MEDIDO: ${TOOL} no está en esta máquina` }])) : failureVerdicts(markerDir, res.stdout);
  const cuenta = sinHerramienta ? null : sessionDidNotWork(res, new Set(Object.values(modos).some((m) => m.gancho) ? ['PreToolUse'] : []));
  if (cuenta) for (const m of MODOS_DE_FALLA) modos[m].veredicto = `NO MEDIDO: la sesión no llegó a trabajar (${cuenta})`;
  const informe = { ts: new Date().toISOString(), tool: TOOL, version: version && !version.error ? String(version.stdout || '').trim() : null,
    comando: `node scripts/controls-bench/live-fire.js --tool ${TOOL} --failure-modes`, timeout_s: FALLA_TIMEOUT_S, colgado_ms: FALLA_COLGADO_MS, modos,
    session: { exit: res.status, stdout: String(res.stdout || '').slice(-2000), stderr: String(res.stderr || '').slice(-2000) } };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `live-fire-${TOOL}-failure-modes.json`);
  fs.writeFileSync(outPath, JSON.stringify(informe, null, 2) + '\n');
  for (const m of MODOS_DE_FALLA) {
    const v = modos[m];
    console.log(`${m}: ${v.veredicto}${v.gancho ? ` · aviso ${v.aviso ? 'visto' : 'no visto'}${v.cortado !== undefined ? ` · ${v.cortado ? 'cortado a tiempo' : 'NO cortado'}` : ''}${v.ms !== null ? ` · ${v.ms} ms` : ''}` : ''}`);
  }
  console.log(`informe: ${outPath}`);
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  // mide, no juzga: sale 0 aunque un modo frene; 1 sólo si no midió ninguno
  process.exit(MODOS_DE_FALLA.some((m) => modos[m].gancho) ? 0 : 1);
}

function main() {
  // `--report-dir`: dónde escribiría el reporte esta máquina, sin abrir una sesión (lo prueba harness-parity.test.sh)
  if (argv.includes('--report-dir')) { process.stdout.write(OUT_DIR); process.exit(0); }
  if (FAILURE_MODES) return runFailureModes();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-livefire-'));
  const markerDir = path.join(sandbox, 'markers');
  fs.mkdirSync(markerDir, { recursive: true });

  console.log(`live-fire [${TOOL}]${PROVE ? ' (prove-detection)' : ''} — sesión headless mínima, ~1-3 min…`);
  const res = TOOL === 'codex' ? runCodex(sandbox, markerDir) : runClaude(sandbox, markerDir);
  if (res.error) {
    console.error(`ERROR lanzando ${TOOL}: ${res.error.message}`);
    process.exit(1);
  }

  const markers = fs.readdirSync(markerDir).filter((f) => f.endsWith('.json'));
  const fired = new Set(markers.map((f) => f.replace(/\.json$/, '')));
  const failures = [];
  const unmeasured = PROVE ? null : sessionDidNotWork(res, fired);

  const expected = [...EVENTS];
  if (PROVE) expected.push('CANARY'); // plantado a propósito: DEBE faltar

  if (unmeasured) failures.push(`NO MEDIDO: la sesión de ${TOOL} no llegó a correr un comando (${unmeasured}) — es la prueba, no el arnés: se repite cuando la sesión ande`);
  for (const ev of expected) {
    if (unmeasured) break;
    if (!fired.has(ev)) failures.push(`hook de ${ev} NO SE DISPARÓ (sin marcador)`);
    else console.log(`✅ ${ev} disparó`);
  }
  if (!PROVE && fired.has('CANARY')) failures.push('el CANARY (matcher que no debe matchear) DISPARÓ — el matcher no filtra');
  if (!PROVE && !fired.has('CANARY')) console.log('✅ CANARY no disparó (matcher inexistente correctamente ignorado)');
  if (fired.has('PreToolUse-matcherBash')) console.log('✅ matcher "Bash" matchea la tool de shell en esta herramienta');
  else console.log('⚠️ matcher "Bash" NO matcheó — ver payload capturado para el nombre real de la tool (inventario §A.2)');

  // E3 — inyección por evento: el modelo repitió el token? (la respuesta final viaja por stdout
  // en las dos herramientas). must ausente → rojo · measure → veredicto informativo al reporte.
  const finalText = String(res.stdout || '');
  const injection = {};
  for (const [ev, mode] of Object.entries(INJECT_CONTRACT[TOOL] || {})) {
    const seen = finalText.includes(`E3INJ-${ev}`);
    injection[ev] = seen ? 'inyectado' : 'NO-inyectado';
    if (unmeasured) continue;
    if (mode === 'declared-no') {
      if (seen) console.log(`📏 inyección ${ev}: APARECIÓ — el contrato medido decía que no inyecta; ¿cambió la herramienta? (informativo, revisar)`);
      else console.log(`✅ inyección ${ev}: no inyecta, conforme al contrato declarado (medido 2026-08-22 en ambas)`);
    } else if (seen) console.log(`✅ inyección ${ev}: el modelo repitió el token`);
    else if (mode === 'must') failures.push(`inyección de ${ev} FALLÓ: el hook imprimió el token y el modelo no lo vio (los hooks advisory de ese evento serían silencio)`);
    else console.log(`📏 inyección ${ev}: NO llegó (measure — veredicto al reporte, endurecer contrato con evidencia)`);
  }
  {
    const seenErr = finalText.includes('E3ERR-PostToolUse');
    injection['PostToolUse-stderr-exit2'] = seenErr ? 'inyectado' : 'NO-inyectado';
    console.log(seenErr
      ? '✅ canal stderr+exit2 de PostToolUse: el modelo repitió el token (el canal de los avisos migrados FUNCIONA acá)'
      : '📏 canal stderr+exit2 de PostToolUse: NO llegó — los avisos migrados (missing-path/retro-pending/unpushed) serían INVISIBLES en esta herramienta (measure; endurecer contrato con evidencia)');
    if (!fired.has('PostToolUse-err')) console.log('⚠️ la sonda PostToolUse-err ni siquiera DISPARÓ (segunda entrada del mismo evento no corre acá)');
  }
  injection.Stop = 'no-aplica (el turno ya terminó)';

  // payloads capturados → evidencia y respuesta a "qué manda cada evento"
  const evidence = {};
  for (const f of markers) {
    try { evidence[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(markerDir, f), 'utf8')); }
    catch { evidence[f.replace(/\.json$/, '')] = 'unparseable'; }
  }
  // cómo llama la herramienta a su shell y qué trae el tool_response: la grabadora de instintos graba el comando sólo
  // para los nombres que conoce, así que un cambio de nombre en una versión nueva tiene que verse acá
  const shell = shellToolOf(evidence.PostToolUse);
  if (shell.tool) console.log(`${shell.tool === 'Bash' ? '✅' : '⚠️'} la herramienta de shell se llama «${shell.tool}»${shell.tool === 'Bash' ? '' : ' — la grabadora de instintos graba el comando sólo de Bash y PowerShell'}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `live-fire-${TOOL}${PROVE ? '-prove' : ''}.json`);
  const sessionTail = failures.length
    ? { stdout: String(res.stdout || '').slice(-3000), stderr: String(res.stderr || '').slice(-2000), exit: res.status }
    : undefined;
  fs.writeFileSync(outPath, JSON.stringify({ ts: new Date().toISOString(), tool: TOOL, prove: PROVE, fired: [...fired], injection, failures, unmeasured: unmeasured || undefined, shell_tool: shell, session: sessionTail, payloads: evidence }, null, 2) + '\n');
  console.log(`payloads capturados + veredicto: ${outPath}`);

  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}

  if (PROVE) {
    const soloElCanary = failures.length === 1 && failures[0].includes('CANARY');
    if (soloElCanary) {
      console.log('\n✅ DETECCIÓN PROBADA: el banco reportó como rojo un hook que no se dispara.');
      process.exit(0);
    }
    console.error(`\n❌ prove-detection falló: rojos=${JSON.stringify(failures)}`);
    process.exit(1);
  }
  if (failures.length) {
    for (const f of failures) console.error(`❌ ${f}`);
    process.exit(1);
  }
  console.log('\n✅ live-fire verde');
  process.exit(0);
}

/** `{ tool, response_keys }` del evento PostToolUse capturado: el nombre de la herramienta y las claves de su respuesta. */
function shellToolOf(payload) {
  if (!payload || typeof payload !== 'object') return { tool: null, response_keys: null };
  const resp = payload.tool_response;
  return { tool: payload.tool_name || null, response_keys: resp && typeof resp === 'object' ? Object.keys(resp).sort() : typeof resp };
}

// Requerirlo no abre una sesión: el marcador y su registro se prueban sin gastar una (scripts/tests/bench-portable.test.js).
module.exports = { markScript, hookEntry, buildHooksConfig, sessionDidNotWork, shellToolOf, buildFailureHooksConfig, failureVerdicts, FAILURE_SOURCE, MODOS_DE_FALLA, FALLA_TIMEOUT_S };

if (require.main === module) main();
