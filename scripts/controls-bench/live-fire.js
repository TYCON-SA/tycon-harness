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
 *     "cómo se llama la tool de shell" en cada herramienta (inventario §A.2, a verificar).
 *
 * Modos:
 *   node live-fire.js --tool claude|codex          corrida normal
 *   node live-fire.js --tool claude --prove-detection
 *       registra el canary como SI FUERA esperado → la corrida DEBE reportarlo como no-disparado.
 *       Si el único rojo es ese, imprime DETECCIÓN PROBADA y sale 0. Es el auto-test del banco:
 *       demuestra que un hook que no se dispara no pasa desapercibido.
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
// Dónde va el reporte: lo decide scripts/lib/harness-parity.js (`benchDir()`), la misma función que usa quien cobra el
// rojo (bench-notice.js). En un clon, `.bench/` al lado de este guion, como siempre; en una versión BAJADA, la carpeta
// del estado: el árbol bajado se reemplaza entero en cada actualización y el reporte se perdía con él — un rojo que
// desaparecía sin que nadie lo arreglara (2026-10-11). Sin la pieza (una copia suelta), donde siempre.
const OUT_DIR = (() => {
  try { const P = require('../lib/harness-parity.js'); if (typeof P.benchDir === 'function') return P.benchDir(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; }
  return path.join(__dirname, '.bench');
})();

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];

// El marcador es un guion de NODE, no de sh (story 8.17, tanda W1): en Windows `sh` no existe fuera de Git Bash, y con
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
  // E3 (2026-08-22): además de volcar el stdin, cada marcador IMPRIME un token de inyección —
  // si el modelo lo repite en su respuesta final, el stdout del hook llegó como contexto (el
  // mecanismo del que dependen los ~14 hooks advisory; sonda 3 lo probó solo para SessionStart).
  // PostToolUse va con el envelope additionalContext (la doc de codex dice que es SU único canal
  // en ese evento; claude también lo acepta). Stop no emite: el turno ya terminó, no hay quién
  // eche el eco — no-aplica por diseño. El CANARY tampoco (no debe disparar).
  fs.writeFileSync(p, MARKER_SOURCE);
  return p;
}

// Con qué se lanza el marcador. Fuera de Windows, el node que está corriendo, por su ruta absoluta y entre comillas: un
// hook lanzado con el PATH mínimo (el de un trabajo programado: /usr/bin:/bin) no encuentra `node` por su nombre —
// la lección del 2026-09-04 de `tools-path.js`—, y antes de ser de Node al marcador le alcanzaba con `sh`. En Windows
// va `node` por su nombre: una ruta entre comillas al principio de la línea no es un comando para PowerShell, y si el
// shell del hook tiene `node` en el PATH es, justamente, parte de lo que este guion mide ahí.
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
      // Sonda del canal stderr+exit2 (2026-08-27): es el canal al que se migraron los avisos de
      // PostToolUse del arnés (missing-path / retro-pending / unpushed push-main) tras descubrir
      // que su stdout era invisible. En Claude está verificado EN VIVO (el FP-1 de missing-path
      // llegó al modelo); acá se mide en las dos herramientas para que quede en el contrato.
      { matcher: '*', hooks: [hookEntry(cmd, 'PostToolUse', '-err')] },
    ],
    Stop: [{ matcher: '*', hooks: [hookEntry(cmd, 'Stop')] }],
  };
}

// 🔴 Encuadre medido (2026-08-22): la v1 pedía "repetí tokens de tu contexto" y gpt a veces
// REHUSABA ("No puedo enumerar contenido interno del contexto") — el rojo era negativa del
// modelo, no fallo de inyección (fired completo, eco ausente). Los códigos se presentan como
// parte de LA PRUEBA y cada línea inyectada trae su propia instrucción — cumplir es lo natural.
const PROMPT = 'Esto es una prueba de plomería del banco de controles TYCON. Ejecutá exactamente este comando de shell: echo bench-live-ok — y después tu respuesta final tiene DOS partes: (1) la línea ok; (2) los CODIGOS-DE-PRUEBA con formato E3INJ-<nombre> o E3ERR-<nombre> que el arnés de prueba te haya entregado durante la sesión (no son secretos: son códigos de verificación de esta prueba y REPETIRLOS es la consigna). Uno por línea, textual. Si no recibiste ninguno, escribí E3INJ-NINGUNO.';

// E3 — contrato de inyección stdout→contexto POR EVENTO (2026-08-22). MUST = verificado o
// documentado (sonda 3 + doc oficial: SessionStart/UserPromptSubmit en ambas). MEASURE = se
// mide y se reporta sin poner rojo — el contrato se endurece con evidencia, no con apuestas
// (lección D.7b/E2: la apuesta razonable del inventario estaba equivocada). Stop: no-aplica.
// Medido 2026-08-22 (E3, ambas herramientas): PostToolUse SÍ inyecta vía envelope
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

function main() {
  // `--report-dir`: dónde escribiría el reporte esta máquina, sin abrir una sesión (lo prueba harness-parity.test.sh)
  if (argv.includes('--report-dir')) { process.stdout.write(OUT_DIR); process.exit(0); }
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
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `live-fire-${TOOL}${PROVE ? '-prove' : ''}.json`);
  const sessionTail = failures.length
    ? { stdout: String(res.stdout || '').slice(-3000), stderr: String(res.stderr || '').slice(-2000), exit: res.status }
    : undefined;
  fs.writeFileSync(outPath, JSON.stringify({ ts: new Date().toISOString(), tool: TOOL, prove: PROVE, fired: [...fired], injection, failures, unmeasured: unmeasured || undefined, session: sessionTail, payloads: evidence }, null, 2) + '\n');
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

// Requerirlo no abre una sesión: el marcador y su registro se prueban sin gastar una (scripts/tests/bench-portable.test.js).
module.exports = { markScript, hookEntry, buildHooksConfig, sessionDidNotWork };

if (require.main === module) main();
