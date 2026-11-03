'use strict';
/**
 * claude-versions.js — qué versión de Claude Code usa esta persona y si alcanza para que su click firme.
 *
 * El click en el cuadro de opciones vale sólo si la transcripción dice quién lo contestó (`permissionDecision`), y las
 * versiones viejas no lo escriben. La consola y la extensión de VS Code se actualizan por separado: `claude update` no
 * toca la extensión. Sin este módulo, la persona ve que el click no firmó y no sabe qué actualizar.
 *
 * Se mira sólo lo que esa sesión usa, según `CLAUDE_CODE_ENTRYPOINT`:
 * - `cli` (terminal y de fondo) y `sdk-cli` (`claude -p`): la consola. La extensión no se mira.
 * - `claude-vscode`: la extensión y la consola.
 * - Sin esa variable (Codex, o fuera de una sesión): nada, y no se pide Claude instalado.
 *
 * La versión de lo que corre sale de `AI_AGENT`, no de lo instalado: una extensión actualizada sigue corriendo la versión
 * anterior hasta recargar la ventana, y leer lo instalado diría «bien» con el click roto. La consola de una sesión de
 * VS Code no es lo que corre: se le pregunta a `claude --version`.
 *
 * Lo que no se puede leer es «no sé», nunca «bien»: VS Code abierto desde el Dock puede no tener `claude` en su PATH, así
 * que no encontrarla no prueba que falte.
 *
 * Límite: una sesión lanzada desde otra de VS Code hereda `claude-vscode` y corre la consola, así que esta versión se
 * atribuye a la extensión. Pasa sólo en `claude -p`, donde nadie contesta un cuadro.
 *
 * Casos: scripts/tests/claude-versions.test.js.
 */
const os = require('os');
const { spawnSync } = require('child_process');

// Medido en las transcripciones: hasta 2.1.292 el dato nunca está, desde 2.1.296 sí. De 2.1.293 a 2.1.295 no hay datos.
const MIN_VERSION = '2.1.296';

const CONSOLE_VERSION_TIMEOUT_MS = 3000;

const NAMES = { console: 'consola de Claude', extension: 'extensión de VS Code' };
const STEPS = {
  console: 'actualizala en una terminal con `claude update`',
  extension: 'actualizala en el panel de extensiones de VS Code (Claude Code → Actualizar) y recargá la ventana (Developer: Reload Window); `claude update` no la toca',
};

const CONSOLE_ENTRYPOINTS = ['cli', 'sdk-cli'];
const VSCODE_ENTRYPOINT = 'claude-vscode';
// `claude -p` no tiene quien lea el aviso ni conteste un cuadro: al arrancar no se dice nada.
const STARTUP_ENTRYPOINTS = ['cli', VSCODE_ENTRYPOINT];

const SHAPE = /^(\d+)\.(\d+)\.(\d+)$/;

/** ¿`version` es anterior a la mínima? Una versión que no se entiende no es vieja: es «no sé». */
function isOlder(version, floor = MIN_VERSION) {
  const a = SHAPE.exec(String(version || ''));
  const b = SHAPE.exec(floor);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]);
  }
  return false;
}

/** La versión que corre esta sesión, de `AI_AGENT` (`claude-code_2-1-310_agent`), o null. */
function runningVersion(env = process.env) {
  const m = /^claude-code_(\d+)-(\d+)-(\d+)(?:_|$)/.exec(String(env.AI_AGENT || ''));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** La versión de la consola según ella misma, o null si no se pudo leer. */
function consoleVersion({ env = process.env, platform = process.platform, run = spawnSync } = {}) {
  // en Windows la consola puede ser `claude.cmd`, que sólo arranca con shell, y con shell el comando va entero en un texto.
  // `cmd` busca primero en la carpeta actual: esto corre al abrir una sesión, y un `claude.cmd` plantado en el repo se
  // ejecutaría. Por eso corre desde la carpeta de la persona, y con la variable que le saca a `cmd` esa búsqueda.
  const windows = platform === 'win32';
  const r = run(windows ? 'claude --version' : 'claude', windows ? [] : ['--version'], { encoding: 'utf8', cwd: os.homedir(), env: windows ? { ...env, NoDefaultCurrentDirectoryInExePath: '1' } : env, timeout: CONSOLE_VERSION_TIMEOUT_MS, windowsHide: true, shell: windows, stdio: ['ignore', 'pipe', 'ignore'] });
  if (!r || r.error || r.status !== 0) return null;
  const m = /^\s*(\d+\.\d+\.\d+)/.exec(String(r.stdout || ''));
  return m ? m[1] : null;
}

function reading(version) {
  if (!version) return { status: 'unknown', version: null };
  return { status: isOlder(version) ? 'old' : 'fine', version };
}

/**
 * Lo que usa esta sesión: `{ entrypoint, pieces }`, con `pieces.console` y `pieces.extension` en
 * `{ status: old | fine | unknown | unused, version }`. `pieces` es null sin una forma de entrar que se conozca.
 */
function versionsInUse({ env = process.env, platform = process.platform, run = spawnSync } = {}) {
  const entrypoint = String(env.CLAUDE_CODE_ENTRYPOINT || '');
  const running = runningVersion(env);
  if (CONSOLE_ENTRYPOINTS.includes(entrypoint)) {
    return { entrypoint, pieces: { console: reading(running), extension: { status: 'unused', version: null } } };
  }
  if (entrypoint === VSCODE_ENTRYPOINT) {
    return { entrypoint, pieces: { console: reading(consoleVersion({ env, platform, run })), extension: reading(running) } };
  }
  return { entrypoint, pieces: null };
}

const piecesOf = (pieces) => Object.keys(NAMES).map((key) => ({ key, ...pieces[key] }));
const lateText = (key, version) => `tu ${NAMES[key]} está en ${version}, y por debajo de ${MIN_VERSION} tu click en el cuadro no firma: ${STEPS[key]}`;

/** Las líneas del arranque: sólo lo que está por debajo de la mínima. No frena nada. Off: TYCON_CLAUDE_VERSION_NOTICE=0. */
function startupNotice({ env = process.env, platform = process.platform, run = spawnSync } = {}) {
  if (env.TYCON_CLAUDE_VERSION_NOTICE === '0') return [];
  if (!STARTUP_ENTRYPOINTS.includes(String(env.CLAUDE_CODE_ENTRYPOINT || ''))) return [];
  const { pieces } = versionsInUse({ env, platform, run });
  return piecesOf(pieces).filter((p) => p.status === 'old').map((p) => `🔔 TYCON — decile a la persona en una línea: ${lateText(p.key, p.version)}. No frena el trabajo.`);
}

/** Las líneas de `harness.js doctor`: `{ level: ok | warn, text }`. Todas empiezan igual para que `/tycon-harness` las liste. */
function doctorItems({ env = process.env, platform = process.platform, run = spawnSync } = {}) {
  const { entrypoint, pieces } = versionsInUse({ env, platform, run });
  if (!pieces) {
    // esta línea la lee el modelo: de una variable que no es de las conocidas sólo se copia lo que parece un nombre
    if (entrypoint) return [{ level: 'warn', text: `Claude — no sé cuál usás: no conozco la forma de entrar «${/^[\w-]{1,40}$/.test(entrypoint) ? entrypoint : 'otra'}»` }];
    // en Codex, o en una terminal fuera de una sesión, no hay versión de Claude que juzgar: no es un «no sé» ni un «bien»
    return [{ level: 'ok', text: 'Claude — no aplica acá: esto no corrió dentro de una sesión de Claude, y no miré ninguna versión' }];
  }
  return piecesOf(pieces).map((p) => {
    if (p.status === 'unused') return { level: 'ok', text: `Claude — ${NAMES[p.key]}: no la usás` };
    if (p.status === 'unknown') return { level: 'warn', text: `Claude — ${NAMES[p.key]}: no sé qué versión es, no la pude leer` };
    if (p.status === 'old') return { level: 'warn', text: `Claude — ${lateText(p.key, p.version)}` };
    return { level: 'ok', text: `Claude — ${NAMES[p.key]}: ${p.version}` };
  });
}

/**
 * Qué decirle a la persona cuando su click no firmó porque falta el dato, según el renglón de la transcripción. Vacío si
 * ese renglón no trae versión o no es vieja: ahí actualizar no es la salida.
 */
function clickHint(record) {
  const version = record && record.version;
  if (!isOlder(version)) return '';
  const entrypoint = String(record.entrypoint || '');
  if (entrypoint === VSCODE_ENTRYPOINT) return `. ${lateText('extension', version)}`;
  if (CONSOLE_ENTRYPOINTS.includes(entrypoint)) return `. ${lateText('console', version)}`;
  return `. Tu Claude Code está en ${version}, y por debajo de ${MIN_VERSION} tu click en el cuadro no firma: actualizalo`;
}

module.exports = { MIN_VERSION, isOlder, runningVersion, consoleVersion, versionsInUse, startupNotice, doctorItems, clickHint };
