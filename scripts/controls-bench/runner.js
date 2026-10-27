#!/usr/bin/env node
/**
 * controls-bench — banco de pruebas de controles del arnés TYCON
 *
 * Corre los casos de los hooks contra los scripts REALES, alimentándolos por stdin con el
 * payload de evento en la forma de cada herramienta (claude | codex). Tres tipos de caso:
 *   - must-block      → el pecado que el control existe para atrapar (exit 2 / decision:block)
 *   - must-not-block  → el caso legítimo parecido (exit 0, sin bloqueo)
 *   - must-run        → constancia: corrió y dejó evidencia. "Salió limpio" sin constancia = falla.
 *   - must-emit       → variante de must-run para hooks de aviso (stdout-context esperado)
 *   - must-stay-quiet → variante de must-not-block para hooks de aviso (stdout vacío/limpio)
 *
 * Cada caso corre en un sandbox: HOME temporal + fixture dir como cwd. Los scripts reales no
 * se tocan; el estado real de ~/.claude NO se contamina.
 *
 * En Windows el sandbox fija además USERPROFILE —es lo que mira
 * `os.homedir()` ahí; HOME sola deja a cada hook escribiendo en la carpeta real—, y la
 * preparación de los casos y los hooks `.sh` corren con el bash de Git for Windows que encuentra
 * `scripts/lib/git-bash.js`, nunca con el shell por defecto (`cmd.exe`) ni con `bash` a secas (puede
 * ser el lanzador de WSL). Sin Git for Windows el banco dice NO MEDIDO y sale 2: no imprime un
 * verde. En Linux y en Mac nada de esto cambia: el entorno de cada caso y el comando con que se
 * lanza son los de siempre (lo fija scripts/tests/bench-portable.test.js).
 *
 * Uso:
 *   node runner.js [--tool claude|codex|both] [--only <substr>] [--baseline write|check]
 *                  [--json <path>] [--list] [--verbose]
 *
 * Baseline (línea de base Claude): --baseline write fija baseline/claude.json;
 * --baseline check compara la corrida actual contra la fijada y falla si un verde se puso rojo.
 *
 * Paridad: con --tool both se comparan veredictos POR CASO entre herramientas.
 * Un caso puede declarar "tools": ["claude"] con "asymmetry": "<motivo>" — la asimetría se
 * permite; el silencio no.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const { sinGitDelPadre } = require('../lib/clean-git-env.js');
const { findGitBash, ENV_VAR: GIT_BASH_VAR } = require('../lib/git-bash.js');

const BENCH_DIR = __dirname;
const TCG = path.resolve(BENCH_DIR, '..', '..');            // el arnés
const PLACE_NAME = (() => { try { return require(path.join(TCG, 'scripts', 'setup', 'harness', 'place.js')).PLACE_NAME; } catch (_) { return null; } })();
const REAL_HOME = os.homedir();
// agent-skills se ubica por el único lector (scripts/lib/skills-dir.js): TYCON_SKILLS_DIR —raíz del clon o su
// carpeta skills/— o, sin ella, ~/.claude/agent-skills. Así el banco puede juzgar un clon de agent-skills
// (un cambio en curso) sin tocar el checkout compartido. Sin la lib (clon viejo): el default.
// 🔴 Sólo «skills-dir.js no está» cae a la ruta instalada. Una biblioteca que está y no carga, o que tira porque su vecina
// no carga (SKILLS_DIR_NEIGHBOR_BROKEN), NO es «clon viejo»: un `catch` genérico se tragaría las dos y el banco
// mediría las skills INSTALADAS con código 0 (ver
// scripts/tests/skills-dir-readers.test.js). Se mira si el archivo está, y no el código del error: un MODULE_NOT_FOUND
// de un `require` de ADENTRO de skills-dir.js también lleva su ruta en el mensaje.
const SKILLS = (() => {
  const lib = path.join(__dirname, '..', 'lib', 'skills-dir.js');
  if (!fs.existsSync(lib)) return path.join(REAL_HOME, '.claude', 'agent-skills');
  return require(lib).resolveSkillsDirs(process.env.TYCON_SKILLS_DIR).repo;
})();
// La carpeta de casos se puede apuntar a otro lado SOLO para probar al propio corredor
// (scripts/tests/bench-unmeasured.test.sh). Sin la variable, usa la carpeta de casos del banco.
const CASES_DIR = process.env.TYCON_BENCH_CASES_DIR || path.join(BENCH_DIR, 'cases', 'hooks');
// ¿Está instalado el freno de producción en ESTA máquina? Algunos casos sólo se pueden medir donde
// NO lo está: sus costuras de prueba se apagan a propósito con /opt/tycon presente, para que una
// sesión hija no pueda apagar el freno con una variable de entorno.
const FRENO_INSTALADO = (() => { try { return fs.statSync('/opt/tycon').isDirectory(); } catch { return false; } })();
// Igual que CASES_DIR: la línea de base se puede apuntar a otro archivo SOLO para probar al
// propio corredor, y así el test nunca toca la foto real del equipo.
const BASELINE_FILE = process.env.TYCON_BENCH_BASELINE || path.join(BENCH_DIR, 'baseline', 'claude.json');
const OUT_DIR = path.join(BENCH_DIR, '.bench');
// Lo que no anda en Windows, declarado: un hueco por caso, con lo que lo cierra. Igual que
// CASES_DIR, se puede apuntar a otro archivo SOLO para probar al propio corredor.
// La lista de huecos conocidos describe los casos de VERDAD: con otra lista de casos (TYCON_BENCH_CASES_DIR, las de juguete
// de las pruebas) no hay huecos declarados salvo que se pase su propia lista. Sin esto, una lista de juguete se
// compararía contra la lista real, cada hueco quedaría «sin caso que lo mida» y el banco
// saldría 1 con todo en verde.
const KNOWN_GAPS_FILE = process.env.TYCON_BENCH_KNOWN_GAPS
  || (process.env.TYCON_BENCH_CASES_DIR ? null : path.join(TCG, 'scripts', 'tests', 'windows', 'known-gaps.json'));

// ---------- args ----------
const argv = process.argv.slice(2);
function argVal(flag, dflt) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const TOOL = argVal('--tool', 'claude');
const ONLY = argVal('--only', null);
const BASELINE_MODE = argVal('--baseline', null);
const JSON_OUT = argVal('--json', null);
const LIST = argv.includes('--list');
const { nombreDeReporte } = require('./report-name.js');
const VERBOSE = argv.includes('--verbose');

// ---------- helpers ----------
function subst(str, vars) {
  return String(str).replace(/\$\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `\${${k}}`));
}
function substDeep(obj, vars) {
  if (typeof obj === 'string') return subst(obj, vars);
  if (Array.isArray(obj)) return obj.map((x) => substDeep(x, vars));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = substDeep(v, vars);
    return out;
  }
  return obj;
}

/** Payload base del evento en la forma de cada herramienta.
 *  Verificado contra la doc oficial de hooks de Codex: los campos comunes
 *  (session_id, cwd, hook_event_name, transcript_path) y los específicos (tool_name,
 *  tool_input, prompt, stop_hook_active) usan LOS MISMOS nombres que Claude Code.
 *  Diferencias: Codex agrega turn_id + model; el resto coincide. */
function buildStdin(tool, event, extra, vars) {
  const base = {
    session_id: 'bench-' + Math.random().toString(36).slice(2, 10),
    cwd: vars.FIXTURE,
    hook_event_name: event,
    permission_mode: 'default',
  };
  if (tool === 'codex') {
    base.turn_id = 'turn-1';
    base.model = 'gpt-5.6-terra';
  }
  const stdin = Object.assign(base, substDeep(extra || {}, vars));
  // la conversación, donde la guarda Claude Code: <home>/.claude/projects/<carpeta>/<sesión>.jsonl. Es la que escribe
  // conversation-fixture.js, y los frenos leen sólo la que nombra la entrada
  if (!(extra && 'transcript_path' in extra)) {
    stdin.transcript_path = path.join(vars.SANDBOX_HOME, '.claude', 'projects', '-bench', `${stdin.session_id}.jsonl`);
  }
  return stdin;
}

// ---------- portabilidad: Windows ----------
// La plataforma, el entorno y el sistema de archivos llegan por `ctx` y sin él salen de la máquina: así la lógica de
// Windows se prueba desde Linux (scripts/tests/bench-portable.test.js) sin tocar `process.platform`.
const platformOf = (ctx) => (ctx && ctx.platform) || process.platform;
const toSlash = (p) => String(p).replace(/\\/g, '/');

/**
 * «No pude medir» no es «el control falló». Lo tira lo que en Windows necesita el bash de Git y no lo tiene; `runCase`
 * lo devuelve como `nomedido`, que no es verde ni rojo. Sin esto el error caería al `catch` como un rojo común, y quien
 * lee «falló» como una respuesta —el auditor de vacuidad: «falla con un control mudo, entonces prueba algo»— sacaría
 * un verde de un caso que nunca corrió.
 */
class NotMeasured extends Error {}
const missingGitBash = (shell) => new NotMeasured(`NO MEDIDO: falta Git for Windows — ${shell.reason}`);

let shellOfThisMachine = null;
/** El bash con que el banco prepara los casos y corre los hooks `.sh`: `{ path, source, reason }` de `findGitBash()`. */
function benchShell(ctx) {
  if (ctx && (ctx.platform || ctx.env || ctx.exists)) return findGitBash(ctx);
  if (!shellOfThisMachine) shellOfThisMachine = findGitBash();
  return shellOfThisMachine;
}

/**
 * Las formas en que puede llegar una misma ruta. En Windows: `C:\a\b` (la nativa), `C:/a/b` (la
 * que escribe casi todo guion) y `/c/a/b` (la de Git Bash). Fuera de Windows hay una sola, y las tres valen esa.
 */
function pathShapes(p, platform) {
  if (platform !== 'win32') return { BACKSLASH: p, SLASH: p, MSYS: p };
  const slash = toSlash(p);
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(slash);
  return {
    BACKSLASH: slash.replace(/\//g, '\\'),
    SLASH: slash,
    MSYS: drive ? `/${drive[1].toLowerCase()}${drive[2] || '/'}` : slash,
  };
}

/**
 * 🔴 TODO lo que el banco le pasa a BASH —por una variable de entorno o pegado en el texto de un guion— va con barras
 * hacia adelante (`D:/a/b`), que en Windows entienden bash y node por igual. Una sola función, para que no haya dos reglas.
 * Con otra regla fallan dos cosas:
 *   · pegada en el texto de un guion, una `\` es un escape de bash y la ruta pierde sus barras;
 *   · por una variable sobrevive… hasta que la palabra trae un comodín: en `cp $TCG/scripts/x/*.js`, bash lee cada `\`
 *     como un escape del patrón, no encuentra nada, y la preparación de los casos falla.
 * `keys`: qué claves del mapa son rutas (sin `keys`, todas). Devuelve una copia; fuera de Windows, el mismo objeto.
 * Lo que va a un proceso de Node (el evento, el entorno de un hook `.js`) NO pasa por acá: sigue con la ruta nativa.
 */
const BASH_PATH_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'TCG', 'SKILLS', 'FIXTURE',
  'SANDBOX_HOME', 'TYCON_GUIDES_DIR', GIT_BASH_VAR];
function forBash(map, ctx, keys = BASH_PATH_KEYS) {
  if (platformOf(ctx) !== 'win32') return map;
  const out = Object.assign({}, map);
  for (const k of keys || Object.keys(out)) if (typeof out[k] === 'string') out[k] = toSlash(out[k]);
  return out;
}

// Lo que cualquier proceso de Windows necesita de su entorno para arrancar. No hay carpetas de usuario acá: ésas
// las pone el sandbox.
const WINDOWS_SYSTEM_VARS = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)',
  'ProgramData', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'];

/**
 * El entorno base de un caso: lo que ve el hook antes de lo que declaren el hook y el caso.
 * Fuera de Windows es, clave por clave, el de siempre. En Windows suma la carpeta de usuario como la busca cada
 * programa (USERPROFILE, y debajo APPDATA y LOCALAPPDATA), el temporal como lo busca Windows (TEMP y TMP), las
 * variables de sistema, y la ruta del bash hallado, para que un hook que lo necesite no vuelva a buscarlo.
 */
function isolationEnv({ sandbox, vars, ctx }) {
  const platform = platformOf(ctx);
  const from = (ctx && ctx.env) || process.env;
  const env = {
    PATH: from.PATH, HOME: vars.SANDBOX_HOME, TMPDIR: sandbox, TCG: vars.TCG, SKILLS: vars.SKILLS, GIT_CONFIG_NOSYSTEM: '1',
    FIXTURE: vars.FIXTURE, SANDBOX_HOME: vars.SANDBOX_HOME, TYCON_GUIDES_DIR: vars.TCG, LANG: 'en_US.UTF-8',
  };
  if (platform !== 'win32') return env;
  const win = path.win32;
  for (const k of Object.keys(from)) {
    if (k.toLowerCase() === 'path') env.PATH = from[k];
    if (WINDOWS_SYSTEM_VARS.some((w) => w.toLowerCase() === k.toLowerCase())) env[k] = from[k];
  }
  env.USERPROFILE = vars.SANDBOX_HOME;
  env.APPDATA = win.join(vars.SANDBOX_HOME, 'AppData', 'Roaming');
  env.LOCALAPPDATA = win.join(vars.SANDBOX_HOME, 'AppData', 'Local');
  env.TEMP = sandbox;
  env.TMP = sandbox;
  const shell = benchShell(ctx);
  if (shell.path) env[GIT_BASH_VAR] = shell.path;
  return env;
}

/**
 * En Windows, la carpeta de usuario la decide USERPROFILE: un caso que cambia HOME sin decir nada de USERPROFILE
 * quiere cambiar la carpeta de usuario, y se le sigue. Fuera de Windows no toca nada.
 */
function followHome(env, declared, ctx) {
  if (platformOf(ctx) !== 'win32') return env;
  if ('HOME' in declared && !('USERPROFILE' in declared)) env.USERPROFILE = env.HOME;
  return env;
}

/**
 * El entorno con que corre el hook de un caso: el del laboratorio, más lo que declaren el hook y el caso. Si el hook
 * es un guion de bash, en Windows sus rutas van con barras hacia adelante (`forBash`): las del laboratorio y las que
 * el caso declara con una variable del banco (`"X": "${FIXTURE}/ps.txt"`). A un hook de Node le llegan nativas.
 */
function hookEnv({ sandbox, vars, hookDef, caseDef, bash, ctx }) {
  const declaredVars = bash ? forBash(vars, ctx, null) : vars;
  const base = isolationEnv({ sandbox, vars, ctx });
  const env = Object.assign(bash ? forBash(base, ctx) : base, substDeep(hookDef.env || {}, declaredVars), substDeep(caseDef.env || {}, declaredVars));
  return followHome(env, Object.assign({}, hookDef.env || {}, caseDef.env || {}), ctx);
}

function interpreterFor(script, ctx) {
  if (script.endsWith('.sh')) {
    // Fuera de Windows, `bash` por su nombre, como siempre. En Windows `bash` a secas puede ser el lanzador de WSL:
    // va la ruta del de Git, y el guion con barras hacia adelante (la forma que bash lee sin sorpresas).
    if (platformOf(ctx) !== 'win32') return ['bash', script];
    const shell = benchShell(ctx);
    if (!shell.path) throw missingGitBash(shell);
    return [shell.path, toSlash(script)];
  }
  if (script.endsWith('.py')) return ['python3', script];
  return [process.execPath, script];
}

/**
 * Un comando de la preparación de un caso. Fuera de Windows va al shell por defecto, como siempre. En Windows el
 * shell por defecto es `cmd.exe`, que no entiende `mkdir -p` ni `printf`: va al bash de Git, y por un ARCHIVO —no por
 * `-c`— para no sumar otra capa de comillas entre Node, Windows y bash.
 */
function runSetup(cmd, { vars, env, ctx, index }) {
  if (platformOf(ctx) !== 'win32') {
    execSync(subst(cmd, vars), { cwd: vars.FIXTURE, env, stdio: VERBOSE ? 'inherit' : 'pipe' });
    return;
  }
  const shell = benchShell(ctx);
  if (!shell.path) throw missingGitBash(shell);
  const shellVars = forBash(vars, ctx, null);   // el texto del guion: toda variable del banco es una ruta
  const file = path.join(path.dirname(vars.FIXTURE), `setup-${index}.sh`);
  fs.writeFileSync(file, `${subst(cmd, shellVars)}\n`);
  const r = spawnSync(shell.path, [toSlash(file)], { cwd: vars.FIXTURE, env, encoding: 'utf8', stdio: VERBOSE ? 'inherit' : 'pipe' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`Command failed: ${cmd}\n${r.stderr || ''}`.trim());
}

/**
 * Lo que la preparación de un caso recibe por el entorno, además del de la máquina. Fuera de Windows, lo de siempre.
 * En Windows suma las carpetas de usuario y el temporal del laboratorio, y —como la preparación corre en bash— todas
 * sus rutas van con barras hacia adelante (`forBash`).
 */
function setupEnv(vars, ctx) {
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: vars.SANDBOX_HOME, TCG: vars.TCG, SKILLS: vars.SKILLS,
    FIXTURE: vars.FIXTURE, SANDBOX_HOME: vars.SANDBOX_HOME,
  };
  if (platformOf(ctx) !== 'win32') return env;
  // las mismas carpetas que aísla el caso (`isolationEnv`): la preparación tampoco hereda las de la máquina
  const win = path.win32;
  env.USERPROFILE = vars.SANDBOX_HOME;
  env.APPDATA = win.join(vars.SANDBOX_HOME, 'AppData', 'Roaming');
  env.LOCALAPPDATA = win.join(vars.SANDBOX_HOME, 'AppData', 'Local');
  env.TEMP = win.dirname(vars.FIXTURE);
  env.TMP = env.TEMP;
  return forBash(env, ctx);
}

/**
 * Dónde nacen los laboratorios. Fuera de Windows, `os.tmpdir()` tal cual. En Windows, esa carpeta por su nombre LARGO:
 * `os.tmpdir()` suele venir con la carpeta de usuario en su nombre corto (el de ocho letras, `NOMBRE~1`), que no es la misma cadena que devuelven git
 * y `realpath` para la misma carpeta — un control que compara rutas daría rojo por el laboratorio, no por él.
 */
function sandboxRoot(ctx) {
  const tmp = (ctx && ctx.tmpdir) || os.tmpdir();
  if (platformOf(ctx) !== 'win32') return tmp;
  try { return ((ctx && ctx.realpath) || fs.realpathSync.native)(tmp); } catch (_) { return tmp; }
}

/**
 * Las variables con que se escribe un archivo del caso (`files`). Fuera de Windows, las de siempre. En Windows una
 * ruta nativa trae barras invertidas, y pegada tal cual rompe el archivo: en un JSON (`"C:\Users"` no se puede leer:
 * un `_marker.json` ilegible deja casos rojos) van escapadas, que es como las escribiría el propio control;
 * en lo demás —un guion de bash, un yaml— van con barras hacia adelante, que Windows también entiende.
 */
function fileVars(name, vars, ctx) {
  if (platformOf(ctx) !== 'win32') return vars;
  const json = /\.jsonl?$/i.test(String(name));
  const out = {};
  for (const [k, v] of Object.entries(vars)) out[k] = json ? String(v).replace(/\\/g, '\\\\') : toSlash(v);
  return out;
}

/** Lo que los casos llaman por su nombre y tiene que estar en el PATH con que corren. Sólo se mira en Windows. */
const CASE_TOOLS = ['git', 'node'];
function missingOnPath(ctx) {
  if (platformOf(ctx) !== 'win32') return [];
  const env = (ctx && ctx.env) || process.env;
  const exists = (ctx && ctx.exists) || ((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  const key = Object.keys(env).filter((k) => k.toLowerCase() === 'path').find((k) => env[k]) || 'PATH';
  const dirs = String(env[key] || '').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  return CASE_TOOLS.filter((t) => !dirs.some((d) => ['.exe', '.cmd', '.bat'].some((ext) => exists(path.win32.join(d, t + ext)))));
}

/**
 * Los rojos DECLARADOS del banco en Windows: `{ gaps: Map<caso, { closes, note, match }>, invalid, problem }`.
 *
 * Un hueco declara un caso (`bench:red:<guion>::<id>`), la tanda que lo cierra (`closes`) y POR QUÉ falla (`match`:
 * una expresión que TODOS los motivos de la falla tienen que cumplir). Un caso que está acá y falla por ese motivo es
 * un «rojo conocido»: se imprime aparte, no cuenta como rojo y no pone roja la corrida.
 *
 * 🔴 Sólo por ese motivo. Si el hueco se buscara por el NOMBRE del caso, un caso declarado quedaría «conocido» fallara
 * por lo que fallara: con su guion borrado, con su preparación rota o con el caso mal escrito, el banco saldría 0 y la
 * lista podría tapar un rojo nuevo. Por eso un caso declarado que falla por OTRO motivo es un rojo a secas (y lo
 * dice); uno que sale VERDE, o que ya no tiene caso que lo mida, es una lista vieja, y también es un rojo: el hueco
 * se saca.
 *
 * Un hueco sin tanda, sin `match` o con un `match` que no es una expresión válida no tapa nada (`invalid`); una lista
 * ilegible, tampoco (`problem`). Fuera de Windows no se mira: la lista es de lo que no anda en Windows.
 */
function knownGaps(ctx) {
  const none = { gaps: new Map(), invalid: [], problem: null };
  if (platformOf(ctx) !== 'win32' || !KNOWN_GAPS_FILE) return none;
  let text;
  try { text = fs.readFileSync(KNOWN_GAPS_FILE, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? none : { ...none, problem: e.message }; }
  let doc;
  try { doc = JSON.parse(text); } catch (e) { return { ...none, problem: e.message }; }
  if (!doc || !Array.isArray(doc.gaps)) return { ...none, problem: 'no trae «gaps»' };
  const gaps = new Map();
  const invalid = [];
  for (const g of doc.gaps) {
    const m = /^bench:red:(.+)$/.exec(String((g && g.id) || ''));
    if (!m) continue;   // un hueco de otro paso de la medición: no es del banco
    let match = null;
    try { match = typeof g.match === 'string' && g.match ? new RegExp(g.match) : null; } catch (_) { match = null; }
    if (match && /^W[1-8]$/.test(String(g.closes || ''))) gaps.set(m[1], { closes: g.closes, note: String(g.note || ''), match });
    else invalid.push(m[1]);
  }
  return { gaps, invalid, problem: null };
}

/**
 * ¿Hay con qué medir en esta máquina? `null` si sí; si no, el motivo en una línea. Sólo puede decir que no en Windows:
 *   · sin el bash de Git no se puede preparar un caso ni correr un hook de bash;
 *   · con el bash pero sin `git` o `node` en el PATH de los casos, cada caso falla por el entorno y no por el control.
 *     Pasa en un agente con Git instalado en su carpeta por defecto y fuera del PATH: cientos de rojos y de verdes que
 *     no dicen nada. Los hooks y las preparaciones los llaman por su nombre.
 */
function cannotMeasure(ctx) {
  if (platformOf(ctx) !== 'win32') return null;
  const shell = benchShell(ctx);
  if (!shell.path) return `falta Git for Windows — ${shell.reason}`;
  const missing = missingOnPath(ctx);
  if (!missing.length) return null;
  const what = missing.map((t) => `\`${t}\``).join(' y ');
  const head = missing.includes('git') ? 'falta Git for Windows en el PATH' : `falta ${missing.join(' y ')} en el PATH`;
  return `${head} — el bash de Git está (${shell.path}), pero ${what} no ${missing.length > 1 ? 'están' : 'está'} en el PATH con que corren los casos, y los hooks y las preparaciones ${missing.length > 1 ? 'los' : 'lo'} llaman por su nombre`;
}

function mkFixture(caseDef, vars, ctx) {
  // files: { "ruta/relativa": "contenido" }  ·  setup: [comandos shell, cwd=fixture]
  for (const [rel, content] of Object.entries(caseDef.files || {})) {
    const p = path.join(vars.FIXTURE, subst(rel, vars));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, subst(content, fileVars(rel, vars, ctx)));
  }
  // lo que el caso declara con una variable del banco también va a bash: por la misma función
  const declared = substDeep(caseDef.env || {}, forBash(vars, ctx, null));
  for (const [index, cmd] of (caseDef.setup || []).entries()) {
    // `sinGitDelPadre`: el `git` del setup de un caso NO puede escribir en el repo que lanzó el
    // banco. Ver `lib/clean-git-env.js`, que usa también el corredor de advisors.
    const env = sinGitDelPadre(setupEnv(vars, ctx), declared);
    runSetup(cmd, { vars, env: followHome(env, declared, ctx), ctx, index });
  }
}

// Claves de `expect` que el chequeo recorre con `for…of`. Una LISTA es el único tipo que
// significa lo que el autor quiso decir.
const EXPECT_LISTAS = ['stderr_re', 'stdout_re', 'stdout_not_re', 'stderr_not_re', 'file_exists', 'file_absent',
  'file_contains', 'file_not_contains', 'dir_has_file'];

function checkExpect(expect, res, vars, failures) {
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  // 🔴 UN CASO MAL ESCRITO TIENE QUE FALLAR, NO PASAR. Estas claves se recorren con `for…of`; escribirlas como
  // STRING en vez de lista no es un error de tipos en JS: itera CARÁCTER POR CARÁCTER, y cada letra suelta usada como
  // expresión regular matchea casi cualquier salida. O sea que el caso pasa SIEMPRE, diga lo que diga — un caso que
  // no puede fallar, contado como cobertura.
  for (const k of EXPECT_LISTAS) {
    if (k in expect && !Array.isArray(expect[k])) {
      failures.push(`caso MAL ESCRITO: \`expect.${k}\` tiene que ser una lista y es ${typeof expect[k]} — un string se itera letra por letra y el caso pasaría siempre`);
    }
  }
  if ('exit' in expect && res.status !== expect.exit)
    failures.push(`exit=${res.status} esperado=${expect.exit}${stderr ? ` · stderr: ${stderr.slice(0, 200)}` : ''}`);
  for (const re of expect.stderr_re || [])
    if (!new RegExp(subst(re, vars), 'im').test(stderr)) failures.push(`stderr no matchea /${re}/`);
  for (const re of expect.stdout_re || [])
    if (!new RegExp(subst(re, vars), 'im').test(stdout)) failures.push(`stdout no matchea /${re}/`);
  for (const re of expect.stdout_not_re || [])
    if (new RegExp(subst(re, vars), 'im').test(stdout)) failures.push(`stdout matchea /${re}/ y no debía`);
  for (const re of expect.stderr_not_re || [])
    if (new RegExp(subst(re, vars), 'im').test(stderr)) failures.push(`stderr matchea /${re}/ y no debía`);
  if (expect.stdout_empty && stdout.trim() !== '') failures.push(`stdout no vacío: ${stdout.slice(0, 120)}`);
  for (const f of expect.file_exists || []) {
    const p = subst(f, vars);
    if (!fs.existsSync(p)) failures.push(`falta evidencia: ${p}`);
  }
  for (const f of expect.file_absent || []) {
    const p = subst(f, vars);
    if (fs.existsSync(p)) failures.push(`existe y no debía: ${p}`);
  }
  for (const fc of expect.file_contains || []) {
    const p = subst(fc.path, vars);
    if (!fs.existsSync(p)) { failures.push(`falta evidencia: ${p}`); continue; }
    const body = fs.readFileSync(p, 'utf8');
    if (!new RegExp(subst(fc.re, vars), 'im').test(body)) failures.push(`${p} no matchea /${fc.re}/`);
  }
  for (const fc of expect.file_not_contains || []) {
    const p = subst(fc.path, vars);
    if (!fs.existsSync(p)) continue;
    const body = fs.readFileSync(p, 'utf8');
    if (new RegExp(subst(fc.re, vars), 'im').test(body)) failures.push(`${p} matchea /${fc.re}/ y no debía`);
  }
  // glob mínimo: dir + sufijo (evidencia con nombre variable, ej long/<ISO>.md)
  for (const g of expect.dir_has_file || []) {
    const dir = subst(g.dir, vars);
    const okDir = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(g.suffix || ''));
    if (!okDir) failures.push(`sin archivos *${g.suffix || ''} en ${dir}`);
  }
}

function runCase(tool, hookDef, caseDef, ctx) {
  const sandbox = fs.mkdtempSync(path.join(sandboxRoot(ctx), 'tycon-bench-'));
  const SANDBOX_HOME = path.join(sandbox, 'home');
  const FIXTURE = path.join(sandbox, 'fixture');
  fs.mkdirSync(path.join(SANDBOX_HOME, '.claude'), { recursive: true });
  fs.mkdirSync(FIXTURE, { recursive: true });
  // 🔴 El git del SANDBOX no hereda el de la máquina. Un caso puede estar rojo en el nocturno de Azure y verde en la
  // Mac del dev por una diferencia que no tiene nada que ver con el control: `git init --bare` toma el nombre de la
  // rama de `init.defaultBranch`, y en macOS lo fija el gitconfig del SISTEMA que trae Xcode
  // (/Library/Developer/CommandLineTools/…/gitconfig → main) mientras que en el agente Linux no existe y git cae en
  // `master`. El remoto queda con HEAD apuntando a una rama inexistente, el clon no puede hacer checkout y el `push
  // origin main` muere con «src refspec main does not match any». Es el caso de «un test que pasa sólo en la máquina
  // del autor». Acá se corta de raíz: el sandbox ignora el gitconfig del sistema (GIT_CONFIG_NOSYSTEM, en los dos
  // entornos) y trae el suyo, así que un caso se comporta igual en cualquier máquina. Red:
  // bench-git-deterministic.test.sh.
  fs.writeFileSync(path.join(SANDBOX_HOME, '.gitconfig'), '[init]\n\tdefaultBranch = main\n');
  const vars = { TCG, SKILLS, HOME: SANDBOX_HOME, SANDBOX_HOME, FIXTURE, REAL_HOME };
  // el nombre del lugar del arnés, de place.js: los casos gemelos con el nombre público lo usan como
  // `${PLACE_NAME}` y nunca lo escriben (el nombre del repo público vive sólo en public-repos.json)
  if (PLACE_NAME) vars.PLACE_NAME = PLACE_NAME;
  // La misma carpeta del caso, escrita de las tres formas en que puede llegar una ruta en Windows (fuera de Windows,
  // las tres son la de siempre): las usan los casos de los portones que deciden por ruta.
  for (const [shape, value] of Object.entries(pathShapes(FIXTURE, platformOf(ctx)))) vars[`FIXTURE_${shape}`] = value;
  const failures = [];
  let res = { status: null, stdout: '', stderr: '' };
  try {
    mkFixture(caseDef, vars, ctx);
    const script = subst(caseDef.script || hookDef.script, vars);
    if (!fs.existsSync(script)) throw new Error(`script no existe: ${script}`);
    const stdin = buildStdin(tool, hookDef.event, caseDef.stdin, vars);
    // un caso puede pasarle argumentos al guion (`args`, con las variables del banco), después de la ruta: así se lanza
    // un hook como lo registra el aplicador, por ejemplo el piso de Node con `--gate <freno>`
    const [bin, ...pre] = [...interpreterFor(script, ctx), ...(caseDef.args || hookDef.args || []).map((a) => subst(String(a), vars))];
    const opciones = {
      input: JSON.stringify(stdin),
      cwd: FIXTURE,
      encoding: 'utf8',
      timeout: (caseDef.timeout_s || 20) * 1000,
      env: hookEnv({ sandbox, vars, hookDef, caseDef, bash: script.endsWith('.sh'), ctx }),
    };
    res = spawnSync(bin, [...pre], opciones);
    // 🔴 Un TIEMPO AGOTADO no es "el control falló": es "no pude medirlo". Contarlo como rojo y como regresión vs la
    // línea de base haría que, como el corte son 20 s por caso, bastara con que la máquina estuviera cargada —la
    // corrida completa son cientos de casos, y el dev suele estar trabajando— para que dos casos del grabador de
    // instintos aparecieran rojos, aunque corridos solos dan verde. El aviso del arranque gritaría "regresiones"
    // durante días sin un solo defecto detrás, que es como se le enseña a la gente a no mirarlo.
    // Se reintenta UNA vez (un tropiezo se ayuda; una caída no se amplifica — misma regla que el
    // reintento del registro de avisos) y recién ahí se declara NO MEDIDO, que no es verde ni
    // rojo: es su propio estado, contado y dicho aparte.
    if (res.error && res.error.code === 'ETIMEDOUT') {
      res = spawnSync(bin, [...pre], opciones);
      if (res.error && res.error.code === 'ETIMEDOUT') {
        return {
          pass: false,
          nomedido: true,
          failures: [`NO MEDIDO: se agotaron los ${(caseDef.timeout_s || 20)} s dos veces (¿máquina cargada?) — no dice nada sobre el control`],
          exit: null,
        };
      }
    }
    // 🔴 Un hook que SE VA SIN LEER su entrada no es un rojo. Los hooks "quiet" —el opt-in apagado, el comando que no es
    // el suyo— salen en las primeras líneas, antes de leer stdin. Si el corredor todavía está escribiendo la entrada
    // cuando el proceso cierra, el sistema devuelve EPIPE: en una Mac el buffer del pipe se lo traga y nunca se ve; en
    // ubuntu aparece como "ERROR: spawnSync bash EPIPE" y una paridad rota, sobre un caso que en las dos herramientas
    // hace exactamente lo que promete. El proceso SÍ corrió y SÍ terminó (hay `status`): se evalúa lo que hizo, como a
    // cualquier otro.
    if (res.error && res.error.code === 'EPIPE' && res.status !== null) res.error = null;
    if (res.error) throw res.error;

    const expect = caseDef.expect || {};
    switch (caseDef.type) {
      case 'must-block': {
        const jsonBlock = /"decision"\s*:\s*"block"|"permissionDecision"\s*:\s*"deny"/.test(res.stdout || '');
        if (res.status !== 2 && !jsonBlock)
          failures.push(`NO bloqueó (exit=${res.status}, sin decision:block)`);
        checkExpect(expect, res, vars, failures);
        break;
      }
      case 'must-not-block': {
        if (res.status === 2) failures.push(`bloqueó y no debía · stderr: ${(res.stderr || '').slice(0, 200)}`);
        else if (res.status !== 0) failures.push(`exit=${res.status} (esperado 0)`);
        if (/"decision"\s*:\s*"block"/.test(res.stdout || '')) failures.push('emitió decision:block y no debía');
        checkExpect(expect, res, vars, failures);
        break;
      }
      case 'must-run':
      case 'must-emit': {
        if (res.status !== 0 && !('exit' in expect)) failures.push(`exit=${res.status} (esperado 0)`);
        // `stderr_re` TAMBIÉN es evidencia: los avisos de varios hooks salen por stderr, y rechazar como "sin
        // constancia" un must-run que los asserta obligaría a inventar un archivo para probar algo que el stderr ya
        // prueba.
        const hasEvidence = ['stdout_re', 'stderr_re', 'file_exists', 'file_contains', 'dir_has_file', 'file_absent', 'file_not_contains'].some(
          (k) => (expect[k] || []).length > 0
        );
        if (!hasEvidence) failures.push('caso sin aserción de evidencia — "salió limpio" sin constancia = falla del CASO');
        checkExpect(expect, res, vars, failures);
        break;
      }
      case 'must-stay-quiet': {
        if (res.status !== 0) failures.push(`exit=${res.status} (esperado 0)`);
        checkExpect(Object.assign({ stdout_empty: !expect.stdout_not_re && !expect.stdout_re }, expect), res, vars, failures);
        break;
      }
      default:
        failures.push(`type desconocido: ${caseDef.type}`);
    }
  } catch (e) {
    if (e instanceof NotMeasured) return { pass: false, nomedido: true, failures: [e.message], exit: null };
    failures.push(`ERROR: ${e.message}`);
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }
  return { pass: failures.length === 0, failures, exit: res.status };
}

// ---------- main ----------
// 🔴 La identidad de un caso es `<archivo del script>::<id>`, NO la prosa del hook. Si la clave incluyera la
// descripción para humanos ("branch-guard-notice.js (repos del arnés fuera de main, …)"), editar esa frase —que pasa
// cada vez que la pieza crece— renombraría todos sus casos: los viejos figurarían como DESAPARECIDOS de la línea de
// base y se contarían como regresiones, y los nuevos entrarían sin historia. El nombre del archivo del script sí es
// estable: cambiarlo ES un cambio. `script::id` da una clave única por caso (el id solo no alcanza: hay repetidos,
// algunos dentro del mismo archivo). La prosa sigue en `--list`, como texto.
function claveDeCaso(h, c) {
  return `${path.basename(String(h.script || h.hook))}::${c.id}`;
}
function loadCaseFiles() {
  if (!fs.existsSync(CASES_DIR)) return [];
  return fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8'));
      const defs = Array.isArray(raw.hooks) ? raw.hooks : [raw];
      for (const d of defs) d.__file = f;
      return defs;
    });
}

function main(ctx) {
  const platform = platformOf(ctx);
  const hookDefs = loadCaseFiles();
  if (LIST) {
    for (const h of hookDefs)
      for (const c of h.cases) console.log(`${claveDeCaso(h, c)} [${c.type}] tools=${(c.tools || ['claude', 'codex']).join(',')}  — ${h.hook}`);
    return 0;
  }
  // 🔴 En Windows sin Git for Windows —o con él fuera del PATH— no hay con qué medir (`cannotMeasure`): no se mide
  // NADA, y eso se dice antes de correr el primero. Un banco que corre los casos de Node, falla los demás uno por uno y
  // cierra con un resumen es un reporte que alguien va a leer como «casi todo verde».
  const why = cannotMeasure(ctx);
  if (why) {
    console.log(`🟡 NO MEDIDO: ${why}`);
    console.log('   El banco prepara cada caso y corre los hooks de bash con el bash de Git, y los casos llaman a `git` y a `node` por su nombre: sin eso no hay nada que medir. No se corrió ningún caso.');
    return 2;
  }
  const tools = TOOL === 'both' ? ['claude', 'codex'] : [TOOL];
  const results = {}; // caseKey -> { tool -> {pass, failures} }
  let ran = 0, failed = 0, skipped = 0, nomedido = 0, known = 0;
  const declared = knownGaps(ctx);
  if (declared.problem) console.log(`⚠️ known-gaps.json no se pudo leer (${declared.problem}): ningún rojo cuenta como conocido.`);
  if (declared.invalid.length) console.log(`⚠️ known-gaps.json: ${declared.invalid.length} hueco(s) mal declarado(s) —sin la tanda que lo cierra (closes) o sin el motivo con que falla (match)— no tapan nada: ${declared.invalid.join(', ')}`);

  for (const h of hookDefs) {
    for (const c of h.cases) {
      const key = claveDeCaso(h, c);
      if (ONLY && !key.includes(ONLY)) continue;
      const caseTools = c.tools || h.tools || ['claude', 'codex'];
      results[key] = results[key] || { type: c.type, asymmetry: c.asymmetry || null, tools: {} };
      // 🔴 Un caso puede declarar en qué sistema operativo tiene sentido (`"so": ["darwin"]`, en el caso o en el hook),
      // porque el banco corre de noche en Azure DevOps sobre Linux. Un hook que sólo existe en macOS (launchctl) no
      // tiene nada que probar en ubuntu — pero saltearlo tiene que quedar DICHO y contado, como las asimetrías entre
      // herramientas: un caso que desaparece en silencio es exactamente lo que este banco persigue.
      const so = c.so || h.so || null;
      if (so && !so.includes(platform)) {
        for (const t of tools) results[key].tools[t] = { skipped: true, so: platform };
        skipped++;
        console.log(`⏭ [${platform}] ${key} — declarado sólo para ${so.join('/')}: salteado con constancia`);
        continue;
      }
      // 🔴 Lo mismo, por otra razón: el caso necesita las costuras de prueba del freno de producción
      // (`TYCON_PROD_ROOT`, `TYCON_PROD_SESSION_SINCE`), y ésas se apagan donde el freno ESTÁ instalado
      // — es una decisión de seguridad, no un olvido: una sesión hija con esas variables apagaría el freno entero.
      // Con el freno instalado esos casos quedarían en rojo en esa máquina y verdes donde no está (Azure). No se
      // puede medir acá, y eso se DICE: un caso que desaparece en silencio es lo que este banco persigue.
      if ((c.sin_freno_instalado || h.sin_freno_instalado) && FRENO_INSTALADO) {
        for (const t of tools) results[key].tools[t] = { skipped: true, motivo: 'el freno de producción está instalado en esta máquina: sus costuras de prueba no existen acá' };
        skipped++;
        console.log(`⏭ ${key} — no se puede medir con el freno instalado (sus costuras se apagan): salteado con constancia`);
        continue;
      }
      for (const t of tools) {
        if (!caseTools.includes(t)) {
          if (!c.asymmetry && !h.asymmetry)
            results[key].tools[t] = { pass: false, failures: ['excluido de esta herramienta SIN asimetría declarada — el silencio no se acepta'] , skipped: false };
          else { results[key].tools[t] = { skipped: true }; skipped++; }
          continue;
        }
        const r = runCase(t, h, c, ctx);
        results[key].tools[t] = r;
        ran++;
        // NO MEDIDO va a su propio balde: no es rojo (no dice nada del control) y no es verde
        // (tampoco dice que ande). Se cuenta y se dice, como los `skip-con-asimetría`.
        // Un rojo es «conocido» sólo si el caso está declarado Y falla por el motivo declarado: todos sus motivos.
        const listed = !r.pass && !r.nomedido ? declared.gaps.get(key) : null;
        const gap = listed && r.failures.length && r.failures.every((f) => listed.match.test(String(f))) ? listed : null;
        if (r.nomedido) nomedido++;
        else if (gap) { known++; r.known_gap = { closes: gap.closes, note: gap.note }; }
        else if (!r.pass) failed++;
        const mark = r.nomedido ? '🟡' : (r.pass ? '✅' : (gap ? '🟠' : '❌'));
        const why = gap ? `ROJO CONOCIDO (lo cierra ${gap.closes}: ${gap.note}) | `
          : (listed ? `está en known-gaps.json y falla por OTRO motivo (el declarado: /${listed.match.source}/): es un rojo nuevo | ` : '');
        console.log(`${mark} [${t}] ${key}${r.pass ? '' : ' — ' + why + r.failures.join(' | ')}`);
      }
    }
  }

  // La lista está vieja: un hueco cuyo caso corrió y salió verde, o que ya no tiene caso que lo mida (no está en la
  // lista de casos, o en este sistema se saltea). Los que deja afuera `--only` no se juzgan.
  let staleGaps = 0;
  const listedCases = new Set(hookDefs.flatMap((h) => h.cases.map((c) => claveDeCaso(h, c))));
  for (const [key, gap] of declared.gaps) {
    if (ONLY && !key.includes(ONLY)) continue;
    const all = Object.values((results[key] && results[key].tools) || {});
    const ranHere = all.filter((r) => r && !r.skipped && !r.nomedido);
    if (ranHere.length && ranHere.every((r) => r.pass)) {
      staleGaps++;
      console.log(`🔻 HUECO QUE YA NO SE REPRODUCE: ${key} (lo cerraba ${gap.closes}) salió verde — ya no falla: sacalo de known-gaps.json`);
    } else if (!listedCases.has(key) || (all.length && all.every((r) => r && r.skipped))) {
      staleGaps++;
      console.log(`🔻 HUECO SIN CASO QUE LO MIDA: ${key} (lo cerraba ${gap.closes}) ${listedCases.has(key) ? 'se saltea en este sistema' : 'no está en la lista de casos'} — sacalo de known-gaps.json`);
    }
  }

  // paridad por caso (--tool both)
  let parityBreaks = 0;
  if (TOOL === 'both') {
    for (const [key, r] of Object.entries(results)) {
      const a = r.tools.claude, b = r.tools.codex;
      if (!a || !b || a.skipped || b.skipped) continue;
      if (a.pass !== b.pass) {
        parityBreaks++;
        console.log(`⚠️ PARIDAD ROTA ${key}: claude=${a.pass ? 'verde' : 'rojo'} codex=${b.pass ? 'verde' : 'rojo'}`);
      }
    }
  }

  // baseline
  let baselineRegressions = 0;
  if (BASELINE_MODE === 'write') {
    const snap = {};
    for (const [key, r] of Object.entries(results)) if (r.tools.claude && !r.tools.claude.skipped) snap[key] = r.tools.claude.pass;
    fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ fixed_at: new Date().toISOString(), tool: 'claude', cases: snap }, null, 2) + '\n');
    console.log(`\n📌 Línea de base Claude fijada: ${Object.keys(snap).length} casos → ${path.relative(TCG, BASELINE_FILE)}`);
  } else if (BASELINE_MODE === 'check' && fs.existsSync(BASELINE_FILE)) {
    const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).cases;
    for (const [key, wasPass] of Object.entries(base)) {
      // 🔴 Con `--only`, la comparación mira SÓLO los casos que se corrieron. Sin esto, una corrida acotada de 6
      // casos declararía cientos de "desaparecidos": todos los que el filtro dejó afuera. Un rojo por construcción
      // es la clase de rojo que enseña a no mirar.
      if (ONLY && !key.includes(ONLY)) continue;
      const now = results[key] && results[key].tools.claude;
      // un rojo conocido ya está dicho como tal: no es además una regresión
      if (wasPass && now && !now.skipped && !now.nomedido && !now.pass && !now.known_gap) {
        baselineRegressions++;
        console.log(`🔻 REGRESIÓN vs baseline: ${key} era verde y ahora es rojo`);
      }
      if (!now) { baselineRegressions++; console.log(`🔻 caso de la baseline DESAPARECIÓ: ${key}`); }
    }
  }

  // reporte
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    ts: new Date().toISOString(), tool: TOOL, ran, failed, skipped, nomedido, parityBreaks, baselineRegressions,
    results,
  };
  if (platform === 'win32') Object.assign(report, { knownGaps: known, staleGaps });
  // 🔴 El nombre lo decide el ALCANCE de la corrida, no sólo la herramienta. Una corrida `--only` de 7 casos que
  // escribiera en `last-run-<tool>.json` —la foto completa— se mostraría en el aviso del arranque como el estado
  // general del banco, con todos los demás casos desaparecidos y sin que nada lo dijera. Es el mismo criterio que
  // usa el examen de revisores (`report-name.js`). `--json` sigue mandando por encima: pisar la foto completa se
  // puede, pero hay que pedirlo.
  const { nombre } = nombreDeReporte({ tool: TOOL, only: ONLY ? [ONLY] : [], prefijo: 'last-run' });
  const outPath = JSON_OUT || path.join(OUT_DIR, nombre);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${failed + staleGaps === 0 ? '✅' : '❌'} ${ran} corridos · ${failed} rojos ·${platform === 'win32' ? ` ${known} rojos conocidos (known-gaps.json) ·` : ''} ${nomedido} NO MEDIDOS · ${skipped} skip-con-asimetría · paridad rota: ${parityBreaks} · regresiones vs baseline: ${baselineRegressions}`);
  if (nomedido > 0) console.log(`🟡 ${nomedido} caso(s) NO MEDIDO(s): se les agotó el tiempo dos veces (o les faltó con qué correr: lo dice cada uno). No son rojos, pero la ejecución NO está completa — volver a correrla con la máquina libre.`);
  console.log(`reporte: ${outPath}`);
  return failed + parityBreaks + baselineRegressions + staleGaps > 0 ? 1 : 0;
}

// Exportado para el AUDITOR DE VACUIDAD:
// vacuity-audit.js reutiliza runCase/loadCaseFiles para correr cada caso afirmativo contra un
// script que no hace nada — un caso que pasa igual no prueba nada. Dos ejecutores del mismo caso
// serían el drift de mañana.
// Lo de Windows se exporta para probarlo con la plataforma inyectada (scripts/tests/bench-portable.test.js).
module.exports = { runCase, loadCaseFiles, main, interpreterFor, isolationEnv, setupEnv, hookEnv, forBash, pathShapes, benchShell, sandboxRoot, fileVars, missingOnPath, cannotMeasure };

// 🔴 `process.exitCode`, NO `process.exit()`. Este guión lo ejecuta otro proceso y le parsea la
// salida; en Node las escrituras a una tubería son ASINCRÓNICAS y `process.exit()` mata el proceso
// con parte de lo escrito todavía en el aire: un informe de ~10 KB llega cortado en 8192 bytes y el consumidor lo
// lee como «no pude», nunca como un error. `main` acá es sincrónica y no deja manejadores abiertos, así que con
// `exitCode` el proceso termina solo, cuando termina de escribir.
if (require.main === module) process.exitCode = main();
