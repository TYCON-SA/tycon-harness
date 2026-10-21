'use strict';
// startup-line.js — la LÍNEA DE ARRANQUE del arnés en settings.json: la nueva y la migración de las viejas.
//
// Cada dev puede tener escrita a mano una variante de la línea que hace `git pull` en los dos repos y llama al instalador
// (variantes conocidas: con o sin `engram sync --import`, con o sin la llamada al instalador, con o sin `--ff-only
// --autostash`, flags en cualquier orden, clon en `~/.claude` o en otra carpeta, `async` o no, y la forma que deja el
// `harness-bootstrap-heal.sh` viejo cuando le pega la llamada al instalador a una línea nueva). La nueva llama a la copia
// fija de arranque (`~/.claude/.tycon-pipeline/harness/bootstrap.js`) y, si no sale 0, al respaldo en shell.
//
// Reconoce por ESTRUCTURA, no por igualdad de texto: la línea se parte en pasos (`;`, `&&`, `||`, salto de línea) y cada
// paso tiene que ser uno de los conocidos —`engram sync --import`, `cd <repo>`, `git pull <flags>`, `git -C <repo> pull`,
// la llamada al instalador, `true`, redirecciones—; con los pulls de LOS DOS repos. Un paso de más (algo que el dev puso
// ahí) hace la forma desconocida: no se toca, y el aviso trae la línea entera y el texto de la nueva. En Windows la forma
// es `pwsh … -Command "…"` con `Set-Location` y `& …install-tycon-hooks.ps1`. Las formas conocidas, una por variante
// medida, viven en scripts/tests/fixtures/startup-lines.json y la prueba harness-startup-line.test.js las cruza todas.
//
// Pasos que la hacen DESCONOCIDA: una segunda llamada a otro instalador, una
// redirección a un archivo (sólo se ignoran las que descartan salida) y `engram sync --import` con argumentos propios.
//
// Reemplaza UNA sola vez: copia `settings.json.bak.<ts>`, escritura atómica (temporal + rename, 3 reintentos ante EPERM),
// `async: true`; una segunda corrida no cambia nada. Antes de todo, el piso de Node: el llamador pasa `nodeOk` (medido con
// el `node` del PATH de la sesión: `checkNode`); si no alcanza, la línea vieja se queda —sigue haciendo el pull— y avisa.
//
// Núcleo público: sin dependencias y sin `require` de nada que la copia pública no traiga. Puro respecto del HOME: recibe
// `home` y `platform`; nunca lee `os.homedir()` adentro salvo como default.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const NODE_FLOOR = 20;
const BOOTSTRAP_MARK = '.tycon-pipeline/harness/bootstrap.js';

const NEW_LINE = {
  posix: 'node "$HOME/.claude/.tycon-pipeline/harness/bootstrap.js" || bash "$HOME/.claude/.tycon-pipeline/harness/bootstrap-fallback.sh"',
  // Barras normales y comillas como el resto del .ps1 (install-tycon-hooks.ps1:421); adentro de la -Command (comillas
  // dobles) van comillas simples. Y SIN NINGÚN `$`: en Windows, Claude Code le pasa el comando de un hook a
  // Git Bash («Git Bash on Windows, or PowerShell when Git Bash isn't installed», documentación de hooks), y bash expande
  // lo que empieza con `$` dentro de comillas dobles. Con `if ($LASTEXITCODE -ne 0)` bash se
  // come la variable, PowerShell falla con «The term '-ne' is not recognized», la línea sale 1 en cada sesión y el
  // respaldo no se dispara nunca.
  // `a || b` es de PowerShell 7 (un requisito del arnés en Windows): corre el respaldo si node no sale 0, o si no está.
  windows: 'pwsh -NoProfile -ExecutionPolicy Bypass -Command "node \'<HOME>/.claude/.tycon-pipeline/harness/bootstrap.js\' || & \'<HOME>/.claude/.tycon-pipeline/harness/bootstrap-fallback.ps1\'"',
};
/** La forma ANTERIOR de la línea nueva de Windows: llama a la copia fija
 *  pero no corre bien por Git Bash. Se reconoce entera, con cualquier carpeta de usuario y la misma en los dos lados. */
const SUPERSEDED_WINDOWS_RX = /^pwsh -NoProfile -ExecutionPolicy Bypass -Command "node '(.+)\/\.claude\/\.tycon-pipeline\/harness\/bootstrap\.js'; if \(\$LASTEXITCODE -ne 0\) \{ & '\1\/\.claude\/\.tycon-pipeline\/harness\/bootstrap-fallback\.ps1' \}"$/;
function isSuperseded(command) { return typeof command === 'string' && SUPERSEDED_WINDOWS_RX.test(command); }

/** Los ids de las formas conocidas (los mismos de la fixture). */
const FORM_IDS = ['canonical-posix', 'canonical-windows', 'sourcecode-clone-no-engram', 'no-engram', 'no-installer', 'no-ff', 'heal-appended', 'installer-only'];

function isWindows(platform) { return platform === 'win32' || platform === 'windows'; }

/** La línea nueva para esa plataforma. `{ command, async: true }`. */
function newLine(home, platform) {
  if (isWindows(platform)) {
    // la ruta va entre comillas simples de PowerShell: una comilla simple adentro se duplica (un HOME «O'Brien»)
    const h = String(home || os.homedir()).replace(/\\/g, '/').replace(/\/+$/, '').replace(/'/g, "''");
    return { command: NEW_LINE.windows.replace(/<HOME>/g, () => h), async: true };
  }
  return { command: NEW_LINE.posix, async: true };
}

/** ¿Es la línea nueva (llama a la copia fija)? Lo usa harness-bootstrap-heal.sh por grep con la misma marca. */
function isNew(command) { return typeof command === 'string' && command.includes(BOOTSTRAP_MARK); }

// ── el análisis por estructura ───────────────────────────────────────────────────────────────────────────────────────

const REPO_RX = /(tycon-claude-guides|agent-skills)/;
// sólo las redirecciones que DESCARTAN salida (a /dev/null, a otro descriptor, $null): una redirección a un archivo es un
// paso del dev y hace la forma desconocida
const REDIR_RX = /\s*(?:\d?>>?\s*(?:\/dev\/null|&\d)|\*>\s*\$null|\|\s*Out-Null)/g;   // >/dev/null · 2>&1 · 2>/dev/null · *> $null
const PULL_FLAGS_RX = /^((?:\s+--?[\w-]+(?:=\S+)?)*)\s*$/;

function unquote(s) { return String(s || '').replace(/^["']|["']$/g, ''); }
function repoOf(p) {
  const m = REPO_RX.exec(unquote(p));
  return m ? (m[1] === 'tycon-claude-guides' ? 'harness' : 'agent_skills') : null;
}
function isLinkPath(p) { return /(?:^|[\\/])\.claude[\\/]tycon-claude-guides\/?$/.test(unquote(p)); }
function flagsOf(s) { const m = PULL_FLAGS_RX.exec(s || ''); return m ? m[1].trim().split(/\s+/).filter(Boolean) : null; }

/**
 * Parte una línea en pasos y los reconoce. Devuelve `null` si algún paso no es de los conocidos, o la descripción:
 * { platform, engram, installer, installerDir, pulls: { harness: [flags], agent_skills: [flags] }, bootstrap }.
 */
function analyze(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  // La línea vieja de Windows empieza con `pwsh` o con `powershell`: se registra con el PowerShell que haya, y con
  // sólo el 5.1 queda `powershell`. Sin reconocerla, esa máquina se quedaría con la línea vieja para
  // siempre. La nueva se escribe siempre con `pwsh`.
  const win = /^\s*(?:pwsh|powershell)(?:\.exe)?\s/.test(command);
  let body = command;
  if (win) {
    const m = /^\s*(?:pwsh|powershell)(?:\.exe)?((?:\s+-\w+(?:\s+[A-Za-z]\w*)?)*?)\s+-Command\s+"([\s\S]*)"\s*$/.exec(command);
    if (!m) return null;
    body = m[2].replace(/try\s*\{/g, ';').replace(/\}\s*catch\s*\{\s*\}/g, ';').replace(/if\s*\(\s*\$LASTEXITCODE\s+-ne\s+0\s*\)\s*\{/g, ';').replace(/[{}]/g, ';');
  }
  const steps = body.split(win ? /\s*[;\n]\s*/ : /\s*(?:;|&&|\|\||\n)\s*/).map((s) => s.replace(REDIR_RX, '').trim()).filter(Boolean);
  const d = { platform: win ? 'windows' : 'posix', engram: false, installer: false, installerDir: null, pulls: {}, bootstrap: 0, cds: [] };
  let pendingCd = null;   // el `cd <repo>` que espera su `git pull`
  for (const step of steps) {
    let m;
    if (step === 'true') continue;
    if (/^engram\s+sync\s+--import$/.test(step)) { d.engram = true; pendingCd = null; continue; }   // con argumentos propios: del dev
    if ((m = /^(?:cd|Set-Location)\s+(\S+)$/.exec(step))) { pendingCd = unquote(m[1]); d.cds.push(pendingCd); continue; }
    if ((m = /^git\s+pull((?:\s+\S+)*)$/.exec(step))) {
      const flags = flagsOf(m[1]); if (!flags || pendingCd === null) return null;
      d.pulls[pendingCd] = flags; pendingCd = null; continue;
    }
    if ((m = /^git\s+-C\s+(\S+)\s+pull((?:\s+\S+)*)$/.exec(step))) {
      const flags = flagsOf(m[2]); if (!flags) return null;
      d.pulls[unquote(m[1])] = flags; pendingCd = null; continue;
    }
    if ((m = /^(?:bash\s+|&\s+)?("[^"]+"|'[^']+'|\S+)$/.exec(step)) && /[\\/]scripts[\\/]install-tycon-hooks\.(?:sh|ps1)$/.test(unquote(m[1]))) {
      if (d.installer) return null;   // una segunda llamada a OTRO instalador es un paso del dev
      d.installer = true; d.installerDir = unquote(m[1]).replace(/[\\/]scripts[\\/]install-tycon-hooks\.(?:sh|ps1)$/, ''); pendingCd = null; continue;
    }
    if ((m = /^(?:node|bash|&)\s+(\S+)$/.exec(step)) && /\.tycon-pipeline[\\/]harness[\\/]bootstrap(?:\.js|-fallback\.(?:sh|ps1))$/.test(unquote(m[1]))) {
      d.bootstrap++; pendingCd = null; continue;
    }
    return null;   // un paso que no es del arnés: la forma es desconocida
  }
  // los pulls, por repo: por el nombre en la ruta o, si la carpeta no lo trae, porque es la del instalador
  const byRepo = {};
  for (const [dir, flags] of Object.entries(d.pulls)) {
    let repo = repoOf(dir);
    if (!repo && d.installerDir && unquote(dir) === d.installerDir) repo = 'harness';
    if (!repo || byRepo[repo]) return null;   // un pull de otro repo, o dos del mismo
    byRepo[repo] = { dir, flags };
  }
  d.pulls = byRepo;
  return d;
}

/** El id de la forma conocida (los de la fixture) o `null`. La línea nueva pura NO es una forma vieja: `null`. */
function classify(command) {
  const d = analyze(command);
  if (!d) return null;
  if (d.bootstrap > 0) {
    // lo que deja el bootstrap-heal viejo: la nueva + la llamada al instalador pegada atrás
    return d.bootstrap === 2 && d.installer && d.platform === 'posix' && !d.engram && !Object.keys(d.pulls).length ? 'heal-appended' : null;
  }
  // la que crea harness-bootstrap-heal.sh viejo cuando no había ninguna línea del arnés: sólo la llamada al instalador
  if (d.installer && !d.engram && !Object.keys(d.pulls).length && d.platform === 'posix' && REPO_RX.test(d.installerDir || '')) return 'installer-only';
  if (!d.pulls.harness || !d.pulls.agent_skills) return null;
  if (d.platform === 'windows') return 'canonical-windows';
  if (!d.installer) return 'no-installer';
  const protectedPull = (f) => f.includes('--ff-only') && f.includes('--autostash');
  if (!protectedPull(d.pulls.harness.flags) || !protectedPull(d.pulls.agent_skills.flags)) return 'no-ff';
  if (!d.engram) return isLinkPath(d.pulls.harness.dir) ? 'no-engram' : 'sourcecode-clone-no-engram';
  return 'canonical-posix';
}

/** ¿La línea nombra el mecanismo del arnés (los repos, el instalador o la copia fija)? Para avisar sobre lo desconocido. */
function mentionsHarness(command) {
  return typeof command === 'string' && (isNew(command) || (REPO_RX.test(command) && /git\s+(?:-C\s+\S+\s+)?pull|install-tycon-hooks/.test(command)));
}

// ── el piso de Node, con el node del PATH de la sesión ───────────────────────────────────────────────────────────────

/** `{ ok, version }` según el `node` que resuelve ese PATH (`version: null` si no hay). */
function checkNode({ env = process.env } = {}) {
  const r = spawnSync('node', ['-e', 'process.stdout.write(process.versions.node)'], { windowsHide: true, env, encoding: 'utf8', timeout: 10000, shell: false });
  if (r.error || r.status !== 0 || !r.stdout) return { ok: false, version: null };
  const version = r.stdout.trim();
  return { ok: parseInt(version.split('.')[0], 10) >= NODE_FLOOR, version };
}

// ── la migración ─────────────────────────────────────────────────────────────────────────────────────────────────────

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Escritura atómica: temporal en la misma carpeta + rename; tres reintentos ante EPERM (Windows). */
function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.settings.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text);
  let last = null;
  for (let i = 0; i < 3; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) { last = e; if (e.code !== 'EPERM') break; }
  }
  try { fs.unlinkSync(tmp); } catch (_) { /* nada */ }
  throw last;
}

/**
 * Migra la línea de arranque de `settingsPath` a la nueva, UNA sola vez.
 * Devuelve `{ changed, reason, before, after, backup }`. Nunca tira: un error va en `reason` con `changed: false`.
 * Opciones: `home`, `platform`, `nodeOk` (si falta se mide con `nodeVersion` o el node de este proceso), `nodeVersion`,
 * `addIfMissing` (sin ninguna línea del arnés, registra la nueva: lo usa `install`), `backup` (la copia `.bak.<ts>` de
 * siempre; bajo `harness.js` —`backup: false` o `TYCON_HARNESS_SNAPSHOT_DIR` puesta— no se hace: el mecanismo ya tomó la
 * suya antes).
 */
function migrate(settingsPath, { home, platform = process.platform, nodeOk, nodeVersion, addIfMissing = false, backup } = {}) {
  const target = newLine(home, platform);
  const base = { changed: false, before: null, after: target.command, backup: null };
  // la opción viaja fuera de `base` (que es lo que se devuelve): commit la lee de acá
  Object.defineProperty(base, 'withBackup', { value: backup === undefined ? !process.env.TYCON_HARNESS_SNAPSHOT_DIR : Boolean(backup), enumerable: false, configurable: true });
  const version = nodeVersion || process.versions.node;
  if (nodeOk === undefined) nodeOk = parseInt(String(version).split('.')[0], 10) >= NODE_FLOOR;
  if (!nodeOk) {
    return Object.assign(base, { reason: `Node ${version || '?'} < ${NODE_FLOOR}: la línea de arranque no se migra; instalá Node ${NODE_FLOOR}+ y volvé a correr el instalador (la línea vieja sigue haciendo el pull)` });
  }
  if (!fs.existsSync(settingsPath)) {
    if (!addIfMissing) return Object.assign(base, { reason: `${settingsPath} no existe: nada que migrar` });
    // Una HOME que nunca usó Claude Code (`install` en una máquina limpia): el archivo nace con la
    // línea nueva. Sin esto el aplicador crearía después su esqueleto y la línea no quedaría en ningún lado.
    try { fs.mkdirSync(path.dirname(settingsPath), { recursive: true }); } catch (e) {
      return Object.assign(base, { reason: `no pude crear ${path.dirname(settingsPath)} (${e.message}): la línea de arranque no se registró` });
    }
    const fresh = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: target.command, async: true }] }] } };
    return commit(settingsPath, '', fresh, Object.assign(base, { reason: `línea de arranque registrada en ${settingsPath} (archivo nuevo, async: true)` }));
  }
  const raw = fs.readFileSync(settingsPath, 'utf8');
  let s;
  if (raw.trim() === '') {
    // Existe pero está VACÍO (una escritura truncada, un `touch`): el aplicador lo lee como `{}` y le escribe sus hooks,
    // así que acá vale lo mismo. Dado por «ilegible», `install` dejaría la máquina instalada y sin línea de arranque.
    if (!addIfMissing) return Object.assign(base, { reason: `${settingsPath} está vacío: nada que migrar` });
    s = {};
  } else {
    try { s = JSON.parse(raw); } catch (e) { return Object.assign(base, { reason: `${settingsPath} ilegible (${e.message}): la línea de arranque no se toca` }); }
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return Object.assign(base, { reason: `${settingsPath} no es un objeto: la línea de arranque no se toca` });

  const entries = (s.hooks && Array.isArray(s.hooks.SessionStart)) ? s.hooks.SessionStart : [];
  const known = [];      // { entry, hook, id }
  const unknown = [];    // { hook }
  const alreadyNew = [];
  for (const entry of entries) {
    for (const hook of (entry && Array.isArray(entry.hooks)) ? entry.hooks : []) {
      const cmd = hook && typeof hook.command === 'string' ? hook.command : '';
      if (!cmd) continue;
      const id = classify(cmd);
      if (id) known.push({ entry, hook, id });
      else if (isNew(cmd)) alreadyNew.push(hook);
      else if (mentionsHarness(cmd)) unknown.push({ hook });
    }
  }
  // la línea nueva en su forma anterior (Windows): pasa a la de ahora, conservando lo demás del hook
  const refreshed = isWindows(platform) ? alreadyNew.filter((h) => isSuperseded(h.command)) : [];
  const staleBefore = refreshed.length ? refreshed[0].command : null;
  for (const h of refreshed) { h.command = target.command; h.async = true; }
  if (known.length === 0) {
    if (unknown.length) {
      const before = unknown[0].hook.command;
      return Object.assign(base, { before, reason: `la línea de arranque del arnés en ${settingsPath} no la reconozco y no la toco (forma desconocida). La línea entera:\n  ${before}\nLa nueva, para ponerla a mano:\n  ${target.command}` });
    }
    if (alreadyNew.length === 1 && refreshed.length) {
      return commit(settingsPath, raw, s, Object.assign(base, { before: staleBefore, reason: 'línea de arranque de Windows actualizada a la forma que corre igual por Git Bash, cmd o PowerShell (sin `$`)' }));
    }
    if (alreadyNew.length === 1) return Object.assign(base, { before: alreadyNew[0].command, reason: 'la línea de arranque ya es la nueva (sin cambios)' });
    if (alreadyNew.length > 1) {   // varias nuevas repetidas: queda la primera
      const extra = new Set(alreadyNew.slice(1));
      for (const entry of entries) if (entry && Array.isArray(entry.hooks)) entry.hooks = entry.hooks.filter((h) => !extra.has(h));
      s.hooks.SessionStart = entries.filter((e) => !(e && Array.isArray(e.hooks) && e.hooks.length === 0));
      return commit(settingsPath, raw, s, Object.assign(base, { before: alreadyNew[0].command, reason: `${alreadyNew.length - 1} línea(s) de arranque nueva(s) repetida(s) quitada(s): queda una` }));
    }
    if (!addIfMissing) return Object.assign(base, { reason: `sin línea de arranque del arnés en ${settingsPath}: nada que migrar` });
    // registrarla (install)
    if (!s.hooks || typeof s.hooks !== 'object') s.hooks = {};
    if (!Array.isArray(s.hooks.SessionStart)) s.hooks.SessionStart = [];
    s.hooks.SessionStart.push({ hooks: [{ type: 'command', command: target.command, async: true }] });
    return commit(settingsPath, raw, s, Object.assign(base, { reason: `línea de arranque registrada en ${settingsPath} (async: true)` }));
  }
  // la primera forma conocida pasa a ser la nueva; las demás (duplicados de otra variante) se quitan: es UNA línea
  const first = known[0];
  const before = first.hook.command;
  first.hook.command = target.command;
  first.hook.async = true;
  if (!first.hook.type) first.hook.type = 'command';
  for (const k of known.slice(1)) {
    k.entry.hooks = k.entry.hooks.filter((h) => h !== k.hook);
  }
  if (alreadyNew.length) {   // una o más nuevas ya estaban al lado de una vieja: queda una sola
    const drop = new Set(alreadyNew);
    for (const entry of entries) if (entry && Array.isArray(entry.hooks)) entry.hooks = entry.hooks.filter((h) => !drop.has(h));
  }
  s.hooks.SessionStart = entries.filter((e) => !(e && Array.isArray(e.hooks) && e.hooks.length === 0));
  const dropped = known.length - 1 + alreadyNew.length;
  const reason = `línea de arranque migrada (${first.id} → la nueva, async: true)${dropped ? `; ${dropped} línea(s) repetida(s) del arnés quitada(s)` : ''}${unknown.length ? `; ${unknown.length} línea(s) del arnés que no reconozco quedaron como estaban` : ''}`;
  return commit(settingsPath, raw, s, Object.assign(base, { before, reason }));
}

function commit(settingsPath, raw, s, result) {
  const withBackup = result.withBackup !== false;
  try {
    let backup = null;
    // un archivo que todavía no existe no tiene qué respaldar
    if (withBackup && fs.existsSync(settingsPath)) { backup = `${settingsPath}.bak.${stamp()}`; fs.copyFileSync(settingsPath, backup); }
    writeAtomic(settingsPath, JSON.stringify(s, null, 2) + '\n');
    return Object.assign(result, { changed: true, backup });
  } catch (e) {
    return Object.assign(result, { changed: false, reason: `no pude escribir ${settingsPath} (${e.message}): la línea de arranque no se tocó` });
  }
}

module.exports = { NODE_FLOOR, NEW_LINE, BOOTSTRAP_MARK, FORM_IDS, newLine, isNew, isSuperseded, classify, analyze, mentionsHarness, checkNode, migrate };
