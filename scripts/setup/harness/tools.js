'use strict';
// tools.js — qué herramientas enchufa el arnés en esta máquina: Claude Code, Codex, o las dos (story 8.23, tanda C).
//
// ── EL CASO (2026-10-06) ──────────────────────────────────────────────────────────────────────────────────────────
// Un dev que sólo usa Codex no podía instalar el arnés: el instalador escribía en la carpeta de Claude Code aunque no
// estuviera, la actualización la disparaba sólo el arranque de Claude Code, y el lado Codex se armaba leyendo archivos
// de Claude (`~/.claude/CLAUDE.md`, `~/.claude.json`). Desde acá el arnés pregunta qué herramientas HAY y enchufa sólo
// esas.
//
// ── QUÉ HAY ACÁ ───────────────────────────────────────────────────────────────────────────────────────────────────
//   · detect()   una herramienta está INSTALADA si su ejecutable está en el PATH o existe su configuración propia —la
//                que el arnés nunca crea: `~/.claude.json` (Claude Code) y `auth.json` en la carpeta de Codex—. Lo que
//                el arnés despliega (`settings.json`, `hooks.json`, los perfiles) NO cuenta: «ya desplegado» no es
//                «instalada» (AC 24), y una máquina no se detectaría a sí misma.
//   · choose()   cuáles se enchufan: las de `--tool` si vino (la persona las fija, estén o no); si no, por cada una su
//                llave (`integrations.claude` / `integrations.codex`): prendida → sí; apagada A PROPÓSITO → no; `detect`
//                o sin decir → lo que diga detect().
//   · plugged()  cuáles tiene enchufadas una máquina YA instalada: `state.tools`. Se decide en `install` (y en la
//                mudanza) y queda escrito: no se vuelve a detectar en cada arranque, porque el PATH de un arranque
//                (launchd, una app gráfica) no es el de la persona —la señal no puede vivir sólo en el entorno
//                (caso 2026-09-04)—. Un estado sin `tools` (las máquinas de antes) se lee como siempre: Claude Code, y
//                Codex si ya está desplegado.
//
// `TYCON_TOOLS_DETECT_PATH`: variable de PRUEBA. Reemplaza al PATH sólo para detectar (el PATH de quien corre una suite
// puede traer las dos herramientas de verdad, y el `node` que la suite necesita vive en la misma carpeta).
//
// Núcleo autónomo: sólo módulos de Node y vecinos de esta carpeta (viaja con la copia fija del programa). Nunca tira.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOLS = Object.freeze(['claude', 'codex']);
const LABELS = Object.freeze({ claude: 'Claude Code', codex: 'Codex' });
const DETECT = 'detect';

const exists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };

/** La carpeta de Codex: `CODEX_HOME`, o `~/.codex`. */
function codexHome({ home = os.homedir(), env = process.env } = {}) {
  return env.CODEX_HOME || path.join(home, '.codex');
}

/**
 * ¿La ruta `p` sirve como el ejecutable que se encontró en el PATH? Un archivo ejecutable, sí. En Windows, además, lo que
 * existe y no es una carpeta: el PowerShell 7 de la Microsoft Store vive en `…\AppData\Local\Microsoft\WindowsApps\
 * pwsh.exe` como un alias de ejecución (un punto de reanálisis), y sobre él Node falla en `statSync` (EACCES/UNKNOWN)
 * aunque `spawnSync('pwsh')` lo ejecute. Medido en una máquina Windows 11 del equipo (2026-10-14): `pwsh --version`
 * daba 7.6.7 y `doctor` decía «falta pwsh en el PATH». No hay falso positivo: quien lo encuentra lo ejecuta después
 * (`versionOf` en harness.js) y uno que no arranca sigue contando como faltante. `fsApi` se inyecta sólo en las pruebas.
 */
function runnableAt(p, platform = process.platform, fsApi = fs) {
  try { fsApi.accessSync(p, fs.constants.X_OK); if (fsApi.statSync(p).isFile()) return true; } catch (_) { /* abajo */ }
  if (platform !== 'win32') return false;
  try { return !fsApi.lstatSync(p).isDirectory(); } catch (_) { return false; }
}

/** ¿`name` está en esa lista de carpetas? La ruta, o null (sin shell; en Windows con las extensiones de un ejecutable). */
function findIn(name, pathValue, platform = process.platform, fsApi = fs) {
  const dirs = String(pathValue || '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
  for (const d of dirs) for (const ext of exts) {
    const p = path.join(d, name + ext);
    if (runnableAt(p, platform, fsApi)) return p;
  }
  return null;
}

/** La configuración propia de cada herramienta: la que crea ELLA al usarse, nunca el arnés. */
function ownConfig(tool, { home = os.homedir(), env = process.env } = {}) {
  return tool === 'claude' ? path.join(home, '.claude.json') : path.join(codexHome({ home, env }), 'auth.json');
}

/**
 * Qué herramientas hay en la máquina.
 * @returns {{claude:{installed:boolean, by:'path'|'config'|null, where:string|null}, codex:{…}}}
 */
function detect({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const lookIn = Object.prototype.hasOwnProperty.call(env, 'TYCON_TOOLS_DETECT_PATH') ? env.TYCON_TOOLS_DETECT_PATH : (env.PATH || env.Path || '');
  const out = {};
  for (const tool of TOOLS) {
    const bin = findIn(tool, lookIn, platform);
    const cfg = ownConfig(tool, { home, env });
    if (bin) out[tool] = { installed: true, by: 'path', where: bin };
    else if (exists(cfg)) out[tool] = { installed: true, by: 'config', where: cfg };
    else out[tool] = { installed: false, by: null, where: null };
  }
  return out;
}

/**
 * `--tool` como vino (una lista: la opción es repetible, y cada valor puede traer varias separadas por coma).
 * @returns {{ok:true, tools:string[]|null}|{ok:false, reason:string}}  `tools: null` = no vino.
 */
function parseOption(raw) {
  if (raw === undefined || raw === null) return { ok: true, tools: null };
  const values = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => String(v).split(',')).map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (!values.length) return { ok: false, reason: `--tool necesita una herramienta: ${TOOLS.join(' o ')}` };
  const unknown = values.filter((v) => !TOOLS.includes(v));
  if (unknown.length) return { ok: false, reason: `--tool «${unknown[0]}»: tiene que ser ${TOOLS.join(' o ')}` };
  return { ok: true, tools: TOOLS.filter((t) => values.includes(t)) };
}

/**
 * Cuáles se enchufan, y por qué cada una.
 * @param {{option:string[]|null, keys:object, detected:object}} p  `keys[tool]` = `{ value: true|false|'detect', origin }`
 *   (de `tycon-config.js toolKeys`; sin dato, `detect`). `origin: 'apagado'` es «nadie dijo nada», no «apagada a propósito».
 *   `always`: las que van sí o sí (una instalación desde un clon vive en la carpeta de Claude Code: no se saca).
 * @returns {{tools:string[], why:object, off:string[]}}  `why[tool]`: 'option' | 'always' | 'key' | 'detected'; `off`: las
 *   que la llave apagó a propósito estando instaladas (para decirlo).
 */
function choose({ option = null, keys = {}, detected = {}, always = [] } = {}) {
  const why = {};
  const off = [];
  if (option) {
    const tools = TOOLS.filter((t) => option.includes(t) || always.includes(t));
    for (const t of tools) why[t] = option.includes(t) ? 'option' : 'always';
    return { tools, why, off };
  }
  const tools = [];
  for (const t of TOOLS) {
    if (always.includes(t)) { tools.push(t); why[t] = 'always'; continue; }
    const k = keys[t] || { value: DETECT, origin: 'apagado' };
    const said = k.origin !== 'apagado' && k.origin !== undefined;
    if (k.value === true) { tools.push(t); why[t] = 'key'; continue; }
    if (k.value === false && said) { if (detected[t] && detected[t].installed) off.push(t); continue; }
    if (detected[t] && detected[t].installed) { tools.push(t); why[t] = 'detected'; }
  }
  return { tools, why, off };
}

/** Por qué se enchufa una herramienta, para el plan. */
function reason(tool, choice, detected) {
  const w = choice.why[tool];
  if (w === 'option') return 'pedida con --tool';
  if (w === 'always') return 'va siempre: la instalación desde un clon vive en su carpeta';
  if (w === 'key') return `prendida con integrations.${tool}`;
  const d = detected[tool] || {};
  return d.by === 'path' ? `detectada: ${tool} en el PATH` : `detectada: su configuración ${d.where}`;
}

/** La línea del plan: «herramientas a enchufar: Claude Code (detectada: claude en el PATH) · Codex (pedida con --tool)». */
function planLine(choice, detected) {
  const parts = choice.tools.map((t) => `${LABELS[t]} (${reason(t, choice, detected)})`);
  const off = choice.off.length ? ` — sin enchufar, apagada con su llave: ${choice.off.map((t) => `${LABELS[t]} (integrations.${t})`).join(', ')}` : '';
  return `herramientas a enchufar: ${parts.join(' · ')}${off}`;
}

/** «Claude Code y Codex», «Codex», … */
function names(tools) { return tools.map((t) => LABELS[t]).join(' y '); }

/**
 * Cómo se instala cada herramienta en ese sistema y cómo se inicia sesión: las órdenes de la documentación de cada una
 * (code.claude.com/docs/en/setup y el README de openai/codex). Se muestran, nunca se corren. El paquete de npm tiene
 * una copia (`agentLines` de scripts/setup/npm/index.js) y npm-package.test.js mide que digan lo mismo.
 */
function agentLines(platform = process.platform) {
  const win = platform === 'win32';
  return [
    `  Claude Code: ${win ? 'irm https://claude.ai/install.ps1 | iex   (en PowerShell)' : 'curl -fsSL https://claude.ai/install.sh | bash'} — después corré claude y seguí el navegador para iniciar sesión`,
    `  Codex: ${win ? 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"' : 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'} — después corré codex y elegí «Sign in with ChatGPT»`,
  ];
}

/** Lo que dice `install` cuando no hay ninguna (AC 21): sale 1 sin escribir, con cómo instalar cada una. */
function noneFound(platform = process.platform) {
  return ['no encontré Claude Code ni Codex en esta máquina (ni su ejecutable en el PATH ni su configuración propia). El arnés trabaja con uno de los dos; instalá uno y volvé a correr la misma línea:',
    ...agentLines(platform), 'O decí cuál enchufar con --tool claude|codex. No escribí nada'].join('\n');
}

/** ¿El lado Codex de la máquina ya está desplegado? (un `hooks.json` o un perfil en su carpeta: lo que deja el arnés) */
function codexDeployed({ home = os.homedir(), env = process.env } = {}) {
  const c = codexHome({ home, env });
  if (exists(path.join(c, 'hooks.json'))) return true;
  try { return fs.readdirSync(c).some((f) => f.endsWith('.config.toml')); } catch (_) { return false; }
}

/**
 * Las herramientas enchufadas de una máquina instalada. Con `state.tools` (una lista válida), ésa. Sin ella —un estado
 * de antes de la tanda C—, lo de siempre: Claude Code, y Codex si ya está desplegado.
 */
function plugged(state, { home = os.homedir(), env = process.env } = {}) {
  const t = state && Array.isArray(state.tools) ? TOOLS.filter((x) => state.tools.includes(x)) : null;
  if (t && t.length) return t;
  return codexDeployed({ home, env }) ? ['claude', 'codex'] : ['claude'];
}

// ── el enchufe de Codex (AC 22, 23) ───────────────────────────────────────────────────────────────────────────────
// Un solo camino, en Node, para Mac, Linux y Windows: los desplegadores del árbol (`build/deploy-codex-all.js`: los
// perfiles y subagentes de los revisores, `hooks.json`, los servidores MCP con `writable_roots`, y los enlaces de
// `~/.codex/skills`) y las reglas en `AGENTS.md` (`scripts/setup/agents-md-blocks.js`). Hasta la tanda C esto lo hacía
// el aplicador en shell, adentro del enchufe de Claude Code: una máquina sin Claude Code no tenía cómo recibirlo.

const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;
const NOTICE_RE = /TRUST|🛑|⚠/;

/** El archivo de reglas de Codex (`CODEX_AGENTS_MD_PATH` lo fija; si no, en su carpeta). */
function agentsMdPath({ home = os.homedir(), env = process.env } = {}) {
  return env.CODEX_AGENTS_MD_PATH || path.join(codexHome({ home, env }), 'AGENTS.md');
}

/** Las carpetas de skills adonde puede apuntar un enlace del arnés en `~/.codex/skills`: las del árbol y las instaladas. */
function skillRoots({ tree, home = os.homedir() }) {
  const roots = [path.join(tree, 'skills'), path.join(require('./tycon-home.js').installedSkillsDir(home), 'skills')];
  for (const r of [...roots]) { try { const real = fs.realpathSync(r); if (!roots.includes(real)) roots.push(real); } catch (_) { /* no está */ } }
  return roots;
}

// ── el registro de los revisores de la capa del equipo en Codex (story 8.25, tanda A2b · AC 30 e, h) ──────────────
// La capa del equipo no trae traducciones a Codex: la máquina las genera desde el `.md` de cada revisor (build/generate.js
// --deploy-only) directo a `$CODEX_HOME`, y anota acá el nombre y el hash de cada archivo que escribió. De este registro
// salen el borrado de lo que la capa saca (sólo si el archivo sigue siendo el que se escribió), las piezas de Codex que
// `uninstall` y `doctor` cuentan, y la paridad. Vive en la carpeta del estado, al lado del sello del despliegue (que no lo toca).
const CODEX_TEAM_RECORD = 'codex-team-deploy.json';
const TEAM_AGENT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** La ruta del registro en esta máquina (la carpeta del estado). */
function codexTeamRecordPath({ home = os.homedir() } = {}) {
  return path.join(require('./tycon-home.js').stateDir(home), CODEX_TEAM_RECORD);
}

/** ¿Una entrada del registro tiene la forma de un archivo de la capa en Codex? `<n>.config.toml` o `agents/<n>.toml`, sin «..». */
function teamRecordEntryOk(rel, entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.agent !== 'string' || !SHA256.test(String(entry.sha256 || ''))) return false;
  const n = entry.agent;
  if (!TEAM_AGENT_NAME.test(n) || n.includes('..')) return false;
  return rel === `${n}.config.toml` || rel === `agents/${n}.toml`;
}

/**
 * Lee el registro y valida cada entrada ANTES de que nadie borre nada con ella: `{ codex_home, files: { rel: { agent, sha256 } },
 * invalid: [rel], problem }`. Sin archivo: vacío. Ilegible: vacío con `problem` (nadie borra a ciegas). Nunca tira.
 */
function readCodexTeamRecord(file) {
  const empty = { codex_home: null, files: {}, invalid: [], invalidRaw: {}, problem: null };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? empty : Object.assign(empty, { problem: `${file}: ${(e && (e.code || e.message)) || e}` }); }
  let j;
  try { j = JSON.parse(raw); } catch (e) { return Object.assign(empty, { problem: `${file} es ilegible (${e.message})` }); }
  if (!j || typeof j !== 'object' || !j.files || typeof j.files !== 'object' || Array.isArray(j.files)) return Object.assign(empty, { problem: `${file} no tiene la forma del registro` });
  const files = {};
  const invalid = [];
  const invalidRaw = {};
  for (const [rel, entry] of Object.entries(j.files)) {
    if (teamRecordEntryOk(rel, entry)) files[rel] = { agent: entry.agent, sha256: entry.sha256 };
    else { invalid.push(rel); invalidRaw[rel] = entry; }
  }
  return { codex_home: typeof j.codex_home === 'string' ? j.codex_home : null, files, invalid, invalidRaw, problem: null };
}

/**
 * Escribe el registro de una vez (temporal + rename): una escritura cortada no deja un registro a medias, y un rename que falla
 * no deja el temporal. `keep`: las entradas que no tienen la forma de un archivo de la capa —nadie las borra— se conservan tal
 * cual, para que no se pierda su rastro.
 */
function writeCodexTeamRecord(file, { codexHome: ch, files, keep = {} }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ schema: 1, codex_home: ch, files: Object.assign({}, keep, files), at: new Date().toISOString() }, null, 1)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (_) { /* queda el temporal */ } throw e; }
}

/**
 * Lo que el enchufe de Codex deja en la máquina y es del arnés, con la forma del registro (`{ kind: 'codex', where, id }`):
 * un perfil y un subagente por cada revisor que el árbol trae generado, y los de la capa del equipo que el despliegue
 * escribió (su registro), `hooks.json` y `config.toml`, los enlaces de `~/.codex/skills` que apuntan a las skills del arnés
 * (los que la persona puso a mano no), y `AGENTS.md` si trae bloques. Sólo lo que EXISTE. Nunca tira.
 */
function codexPieces({ tree, home = os.homedir(), env = process.env } = {}) {
  const dir = codexHome({ home, env });
  const out = [];
  const add = (rel) => { if (!out.some((p) => p.id === rel)) out.push({ kind: 'codex', where: path.join(dir, ...rel.split('/')), id: rel }); };
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
  const tomls = (sub) => { try { return fs.readdirSync(path.join(tree, 'adapters', 'codex', sub)).filter((f) => f.endsWith('.toml')).sort(); } catch (_) { return []; } };
  for (const f of tomls('agents')) { const rel = `${f.slice(0, -'.toml'.length)}.config.toml`; if (isFile(path.join(dir, rel))) add(rel); }
  for (const f of tomls('agents-native')) { const rel = `agents/${f}`; if (isFile(path.join(dir, 'agents', f))) add(rel); }
  // los de la capa del equipo, del registro del despliegue (sólo los de ESTA carpeta de Codex)
  // un registro que no se lee no es «no hay revisores de la capa»: el problema viaja en el resultado (`teamRecordProblem`) y
  // quien lo usa lo dice (el enchufe de Codex lo suma a sus avisos)
  const rec = readCodexTeamRecord(codexTeamRecordPath({ home }));
  if (rec.problem) out.teamRecordProblem = `el registro de los revisores de la capa en Codex no se lee (${rec.problem}): sus archivos no se cuentan ni se quitan solos`;
  else if (!rec.codex_home || path.resolve(rec.codex_home) === path.resolve(dir)) for (const rel of Object.keys(rec.files).sort()) if (isFile(path.join(dir, ...rel.split('/')))) add(rel);
  for (const rel of ['hooks.json', 'config.toml']) if (isFile(path.join(dir, rel))) add(rel);
  const roots = skillRoots({ tree, home });
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'skills')).sort(); } catch (_) { names = []; }
  for (const n of names) {
    let target = null;
    try { target = fs.readlinkSync(path.join(dir, 'skills', n)); } catch (_) { continue; }   // no es un enlace: de la persona
    if (roots.some((r) => target.startsWith(r + path.sep))) add(`skills/${n}`);
  }
  const agents = agentsMdPath({ home, env });
  try { if (fs.readFileSync(agents, 'utf8').includes('<!-- TYCON_BLOCK:')) out.push({ kind: 'codex', where: agents, id: 'AGENTS.md' }); } catch (_) { /* no está */ }
  return out;
}

/**
 * Enchufa (o re-enchufa) a Codex desde `tree`. `force`: despliega aunque la huella diga «al día» (una instalación).
 * @returns {{ok:boolean, out:string, pieces:object[], warnings:string[], reason:string|null}}
 */
function plugCodex({ tree, home = os.homedir(), env = process.env, log = null, snapshotDir = null, force = false } = {}) {
  const { spawnSync } = require('child_process');
  const say = (l) => { try { if (log) log(`codex: ${l}`); } catch (_) { /* el registro no frena */ } };
  const deploy = path.join(tree, 'build', 'deploy-codex-all.js');
  const blocks = path.join(tree, 'scripts', 'setup', 'agents-md-blocks.js');
  if (!fs.existsSync(deploy)) {
    const reason = `esta versión no trae el despliegue de Codex (${deploy})`;
    say(reason);
    return { ok: false, out: '', pieces: [], warnings: [], reason };
  }
  // (forma con enlaces, story 8.33: los desplegadores arman sus rutas con `__dirname`; así nombran ~/.tycon/harness)
  const childEnv = Object.assign({}, require('./tycon-home.js').keepLinkPathsEnv(env));
  if (snapshotDir) childEnv.TYCON_HARNESS_SNAPSHOT_DIR = snapshotDir; else delete childEnv.TYCON_HARNESS_SNAPSHOT_DIR;
  for (const k of ['TYCON_REPORT_PIECES', 'TYCON_PLAN_PIECES']) delete childEnv[k];   // las piezas las cuenta codexPieces
  const run = (script, args) => {
    const r = spawnSync(process.execPath, [script, ...args], { windowsHide: true, encoding: 'utf8', env: childEnv, timeout: DEPLOY_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
    return { ok: r.status === 0 && !r.error, status: r.status, text, error: r.error };
  };
  const outs = [];
  const d = run(deploy, force ? ['--force'] : []);
  if (d.text) outs.push(d.text);
  say(`despliegue ${deploy} → ${d.ok ? 'ok' : `rc ${d.status}${d.error ? ` (${d.error.message})` : ''}`}${d.text ? ` · ${d.text.split('\n').slice(-3).join(' | ').slice(0, 400)}` : ''}`);
  let reason = d.ok ? null : `el despliegue de Codex salió ${d.status === null ? 'matado' : d.status}`;
  // las reglas: un árbol de antes de la tanda C no trae el escritor; ahí AGENTS.md queda como esté, y se dice
  if (fs.existsSync(blocks)) {
    const b = run(blocks, []);
    if (b.text) outs.push(b.text);
    say(`reglas ${blocks} → ${b.ok ? 'ok' : `rc ${b.status}`}${b.text ? ` · ${b.text.split('\n').slice(-2).join(' | ').slice(0, 300)}` : ''}`);
    if (!b.ok && !reason) reason = `las reglas de Codex (AGENTS.md) no se pudieron escribir (rc ${b.status === null ? 'matado' : b.status})`;
    // el escritor sale 0 siempre (un hook de arranque nunca frena): lo que no pudo lo dice por su salida, y acá se lee
    // (pase adversarial de la C, clase 30: sin esto «las reglas no se pudieron escribir» no salía nunca)
    const cannot = b.text.split('\n').find((l) => /^⚠ tycon: AGENTS\.md de Codex: /.test(l.trim()));   // «no pude…», «sin bloques en…»: cualquier motivo
    if (cannot && !reason) reason = cannot.trim().replace(/^⚠ tycon: /, '');
  } else say(`esta versión no trae ${blocks}: AGENTS.md queda como está`);
  const out = outs.join('\n');
  const warnings = out.split('\n').map((l) => l.trim()).filter((l) => NOTICE_RE.test(l));
  const pieces = codexPieces({ tree, home, env });
  if (pieces.teamRecordProblem) { warnings.push(`⚠ tycon/codex: ${pieces.teamRecordProblem}`); say(pieces.teamRecordProblem); }
  return { ok: reason === null, out, pieces, warnings, reason };
}

// ── el aviso previo (AC 24) ───────────────────────────────────────────────────────────────────────────────────────
// `detect` sigue a la herramienta INSTALADA, no a «ya desplegada»: una máquina con `codex` instalado y sin enchufar
// pasa a recibir sus enchufes en la próxima instalación (o en la mudanza), NO sola en un arranque. Antes de eso se le
// dice, en el arranque y en `doctor`. Una herramienta apagada a propósito con su llave no se nombra.
const NOTICE_HEAD = 'herramienta sin enchufar: ';
const NOTICE_TAIL = /(?:^| · )herramienta sin enchufar: [^·]*(?= · |$)/;

/** Las herramientas instaladas en la máquina que el arnés NO enchufa y cuya llave no las apaga a propósito. */
function unplugged({ state, detected, keys = {}, home = os.homedir(), env = process.env } = {}) {
  const have = plugged(state, { home, env });
  return TOOLS.filter((t) => {
    if (have.includes(t) || !(detected[t] && detected[t].installed)) return false;
    const k = keys[t];
    return !(k && k.value === false && k.origin !== 'apagado' && k.origin !== undefined);
  });
}

/** El texto del aviso (una línea), o null si no hay nada que avisar. */
function unpluggedNotice(p) {
  const tools = unplugged(p);
  if (!tools.length) return null;
  return `${NOTICE_HEAD}${tools.map((t) => `${LABELS[t]} está instalado en esta máquina y el arnés no lo enchufa; se enchufa con harness.js install --tool ${t} (o en la próxima instalación)`).join('; ')}`;
}

/** ¿Dos listas de herramientas son la misma? (sin importar el orden) */
function same(a, b) {
  const x = TOOLS.filter((t) => (a || []).includes(t)); const y = TOOLS.filter((t) => (b || []).includes(t));
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

/** ¿El estado dice a propósito qué enchufa? (`tools` escrito por la tanda C) */
function recorded(state) {
  return Boolean(state && Array.isArray(state.tools) && state.tools.some((x) => TOOLS.includes(x)));
}

module.exports = {
  TOOLS, LABELS, DETECT,
  codexHome, runnableAt, findIn, ownConfig, detect, parseOption, choose, reason, planLine, names, agentLines, noneFound, codexDeployed, plugged, recorded, same,
  agentsMdPath, codexPieces, plugCodex, unplugged, unpluggedNotice, NOTICE_HEAD, NOTICE_TAIL,
  CODEX_TEAM_RECORD, TEAM_AGENT_NAME, codexTeamRecordPath, readCodexTeamRecord, writeCodexTeamRecord,
};
