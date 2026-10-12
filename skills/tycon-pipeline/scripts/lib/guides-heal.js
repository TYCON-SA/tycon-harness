'use strict';
/**
 * guides-heal.js — repara el CLON ATRASADO (o TRABADO) del arnés desde un hook que ya
 * está enchufado en todas las máquinas (on-prompt.js, UserPromptSubmit, registrado desde mayo).
 *
 * El problema que resuelve, medido el 2026-09-03 en la máquina de un dev del equipo:
 *
 *   La línea de arranque de cada sesión hace `git pull` del arnés y después corre el
 *   instalador que vive ADENTRO de esa carpeta. Ese `git pull` se niega a avanzar si un archivo
 *   modificado localmente también cambió en origin — y el capturador de retrospectivas deja
 *   `guides/guide-update-proposals.md` modificado y sin commitear en la máquina donde corre. Ese
 *   archivo cambió 15 veces en origin/main en seis días. Resultado: el pull falló todos los días,
 *   el error iba a /dev/null (a propósito: una red caída no puede romper el arranque), y el
 *   instalador siguió corriendo… en su versión del 27/08, que no conoce los hooks nuevos.
 *   272 commits atrás, sin una sola línea de error. El freno de story-a-mano (que viaja por
 *   agent-skills, que SÍ se actualizaba) llegó; el hook que lo abre (que registra el instalador)
 *   no. El dev chocó contra un freno que no se podía abrir por su camino previsto.
 *
 *   El arreglo durable —la línea de arranque con `--autostash`, que la escribe el instalador— NO
 *   puede llegar a esas máquinas: viaja por el pull que está bloqueado. Es el mismo callejón del
 *   `harness-bootstrap-heal.sh` del 27/08, por la otra puerta. La salida es la misma: entrar por
 *   la carpeta que sí se actualiza (agent-skills lleva `--autostash` en su pull desde el
 *   principio) y por un hook que ya está registrado.
 *
 * Qué hace, UNA vez por sesión (sello por session id):
 *   0. Si el clon quedó TRABADO —conflicto abierto (`UU`) que dejó un autostash del arranque que no
 *      pudo reaplicarse; git guarda lo local en el stash pero deja los marcadores en el archivo, y
 *      desde ahí ningún pull entra ("unmerged files")—, limpia SÓLO esos archivos (`checkout HEAD --
 *      <ellos>`), y sólo si verificó que están en ese stash, que tienen los marcadores adentro, y que
 *      no hay un merge/rebase del dev en curso. El resto del árbol no se toca: lo que el dev haya
 *      seguido editando después de quedar trabado sigue ahí (hallazgos H1 y H8 de las dos pasadas
 *      adversariales del 2026-09-03: sin esto la línea de arranque arreglada volvía a trabar el clon
 *      a los pocos días, y la primera versión de la limpieza —un reset --hard— borraba ese trabajo).
 *      En ese estado el pull del arranque murió ANTES de fetchear, así que acá sí se hace un fetch.
 *   1. Si el clon no existe, no está en main, o no está atrás de origin/main → silencio.
 *      origin/main ya está fresco: el `git pull` del arranque hace el fetch aunque el merge falle
 *      (salvo trabado — punto 0). Sólo si nadie hizo fetch en 3 días hace uno (con timeout de 15 s).
 *      Ésas son las dos únicas salidas a la red de esta pieza.
 *   2. Si divergió (commits locales que no están en origin) → NO toca nada, avisa.
 *   3. Si sólo está atrás → guarda aparte lo local (stash propio, sólo si hay cambios), avanza con
 *      `merge --ff-only origin/main` (local, sin red) y reaplica. Si la reaplicación choca, git deja
 *      lo local a salvo en el stash y el árbol en conflicto: se limpia y se avisa. Si el avance
 *      falla (p. ej. un archivo no trackeado que origin agrega), se restaura lo local y se nombra
 *      el archivo.
 *   4. Corre el instalador NUEVO en segundo plano (el que acaba de bajar), así la máquina queda
 *      enchufada sin esperar a la próxima sesión. Los hooks nuevos igual quedan activos recién al
 *      abrir la siguiente: Claude Code lee settings.json al arrancar. Detached a propósito: la
 *      regla H11 de on-prompt.js prohíbe trabajo pesado o reescrituras de settings por prompt.
 *      En Windows corre el .ps1 sólo si hay `pwsh` (el instalador lo requiere; con PowerShell 5.1
 *      moriría en la primera línea y el aviso mentiría).
 *   5. Deja constancia en <stateDir>/guides-heal/<sid>.json y devuelve el aviso para el dev.
 *
 * Por qué NO usa TYCON_GUIDES_DIR: el banco de pruebas la apunta al repo REAL para que otros hooks
 * lean sus scripts; un merge automático contra el repo real desde un caso del banco sería un efecto
 * colateral. El override del banco es TYCON_GUIDES_HEAL_REPO, explícito. Sin override, el clon es
 * el que apunta el lugar ~/.claude/tycon-harness (o el nombre viejo) bajo el HOME de la sesión (lib/harness-path.js,
 * modo «sólo enlace») — en el sandbox no existe, y no hacer nada es lo correcto.
 *
 * Fail-open total. Off: TYCON_GUIDES_HEAL=0. Caso: incident-log#arnes-que-se-bloquea-a-si-mismo-2026-09-03.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir: stateDirOf } = require('./state-dir.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
const { execFileSync, spawn } = require('child_process');

const FETCH_STALE_DAYS = 3;
const STAMP_TTL_DAYS = 7;
const STASH_MSG = 'tycon-guides-heal';
// El autostash lo crea git ("autostash") o esta pieza (STASH_MSG): los dos son "lo local, guardado".
const OUR_STASH_RE = /autostash|tycon-guides-heal/i;

/**
 * Rutas cuyo contenido NO es trabajo de nadie: lo genera una pieza del arnés y lo publicado manda.
 * Sólo estas se apartan solas cuando traban el avance; cualquier otro archivo sin trackear se
 * respeta y se avisa (2026-09-06: una máquina 158 commits atrás por `.dashboard/sdlc-stage-*.json`).
 */
const REGENERABLES = [/^\.dashboard\//];

function lines(s) { return String(s || '').split('\n').filter(Boolean); }

function makeGit(env) {
  return function git(dir, args, opts = {}) {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: opts.timeout || 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, env, { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }),
    }).trim();
  };
}

function repoDir(env) {
  // Sólo el enlace bajo el HOME de la sesión, NUNCA TYCON_GUIDES_DIR (story 8.3, AC 5): bajo el banco la
  // variable apunta al repo real. Si el enlace no resuelve, la ruta nominal del enlace: no existe, y `heal`
  // no hace nada, que es lo correcto.
  if (env.TYCON_GUIDES_HEAL_REPO) return env.TYCON_GUIDES_HEAL_REPO;
  const hp = require('./harness-path.js');
  return hp.soloEnlace({ home: os.homedir() }).dir || hp.enlace(os.homedir());
}

/** El estado del mecanismo de instalación (story 8.13): `'ok'` si existe y es legible con `schema ≥ 1`, `'broken'` si
 *  existe y no se puede leer, `null` si no existe. */
function harnessState(stateDir) {
  const p = path.join(stateDir, 'harness-state.json');
  try { if (!fs.existsSync(p)) return null; } catch { return null; }
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    return s && typeof s.schema === 'number' && s.schema >= 1 ? 'ok' : 'broken';
  } catch { return 'broken'; }
}

function stampPath(stateDir, sessionId) {
  const safe = String(sessionId || '_nosession').replace(/[/\\]/g, '_');
  return path.join(stateDir, 'guides-heal', `${safe}.json`);
}

function pruneStamps(dir) {
  try {
    const cutoff = Date.now() - STAMP_TTL_DAYS * 86400000;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* otro proceso */ }
    }
  } catch { /* sin dir todavía */ }
}

function fetchIfStale(git, dir) {
  let mtime = 0;
  try { mtime = fs.statSync(path.join(dir, '.git', 'FETCH_HEAD')).mtimeMs; } catch { /* nunca hizo fetch */ }
  if (Date.now() - mtime < FETCH_STALE_DAYS * 86400000) return;
  try { git(dir, ['fetch', '--quiet', 'origin', 'main'], { timeout: 15000 }); } catch { /* sin red: seguimos con lo que hay */ }
}

function count(git, dir, range) {
  const n = parseInt(git(dir, ['rev-list', '--count', range]), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Archivos en conflicto con sus etapas del índice (1 base · 2 la de HEAD · 3 la otra). Con `-z`: una ruta con espacio
 *  llega entera, sin las comillas que le pone `status --porcelain`. `inHead: false` = DU/UA/DD: HEAD no lo tiene, y
 *  `checkout HEAD --` sobre él falla ENTERO (story 8.5.1 del arnés). */
function unmergedStages(git, dir) {
  const stages = new Map();
  for (const rec of git(dir, ['ls-files', '-u', '-z']).split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const p = rec.slice(tab + 1);
    if (!stages.has(p)) stages.set(p, new Set());
    stages.get(p).add(rec.slice(0, tab).split(' ')[2]);
  }
  return [...stages].map(([file, s]) => ({ file, inHead: s.has('2') }));
}

function unmergedFiles(git, dir) {
  return unmergedStages(git, dir).map((u) => u.file);
}

/** Una ruta o una carpeta lista para pegar en la shell: tal cual si es `[\w./-]+`; si no, entre comillas simples (la
 *  misma regla que el aviso de arranque del arnés, branch-guard-notice.js, que tiene su copia). */
function sh(s) {
  return /^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function stashTop(git, dir) {
  try { return lines(git(dir, ['stash', 'list']))[0] || ''; } catch { return ''; }
}

function operationInProgress(dir) {
  return ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
    .some((f) => fs.existsSync(path.join(dir, '.git', f)));
}

function hasConflictMarkers(dir, file) {
  try { return /^<{7}( |$)/m.test(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return false; }
}

/**
 * Destraba el clon que quedó con el conflicto abierto de un autostash (del arranque o nuestro).
 * Toca SÓLO los archivos en conflicto, y sólo si ya están guardados: cada uno tiene que estar en el
 * stash de arriba y tener los marcadores de git adentro (sin marcadores = el dev lo resolvió a mano
 * y le falta el `git add`: no se pisa). No puede haber un merge/rebase del dev a medias. Se limpian
 * con `checkout HEAD -- <esos>` y NO con `reset --hard`: el resto del árbol —lo que el dev haya
 * seguido editando después de quedar trabado— no se mira ni se toca (hallazgo H8 de la segunda
 * pasada adversarial: el reset borraba ese trabajo, que no estaba en ningún stash).
 * @returns {null | {stuck: true, unstuck: boolean, files: string[], reason?: string}}
 */
function unstick(git, dir) {
  const stages = unmergedStages(git, dir);
  const files = stages.map((u) => u.file);
  if (!files.length) return null;
  const top = stashTop(git, dir);
  if (!OUR_STASH_RE.test(top)) return { stuck: true, unstuck: false, files, reason: 'el conflicto no viene de un autostash' };
  if (operationInProgress(dir)) return { stuck: true, unstuck: false, files, reason: 'hay un merge/rebase en curso' };
  let stashFiles;
  try { stashFiles = new Set(lines(git(dir, ['stash', 'show', '--name-only', 'stash@{0}']))); } catch { return { stuck: true, unstuck: false, files, reason: 'no pude leer el stash' }; }
  if (!files.every((f) => stashFiles.has(f))) return { stuck: true, unstuck: false, files, reason: 'hay conflictos en archivos que no están en el stash' };
  // Los que HEAD no tiene (DU: lo publicado borró un archivo que el dev había tocado) no traen marcadores: git deja la
  // versión del stash entera. No se les piden, y salen del índice con `rm --cached` (el archivo del dev queda en el
  // disco). A los demás, los marcadores y `checkout HEAD --`, como siempre. Un comando por tipo: si van juntos y uno no
  // aplica, git no hace ninguno (story 8.5.1 del arnés).
  const gone = stages.filter((u) => !u.inHead).map((u) => u.file);
  const kept = stages.filter((u) => u.inHead).map((u) => u.file);
  if (!kept.every((f) => hasConflictMarkers(dir, f))) return { stuck: true, unstuck: false, files, reason: 'parece resuelto a mano — falta git add' };
  // Dos pasos, cada uno con su motivo: si el primero anda y el segundo falla, el clon YA cambió y hay que decirlo
  // (revisor de fallas silenciosas, story 8.5.1: con un solo try, «el checkout falló» y «No la toco» eran falsos).
  if (gone.length) {
    try { git(dir, ['rm', '-q', '--cached', '--', ...gone], { timeout: 15000 }); } catch { return { stuck: true, unstuck: false, files, gone: [], reason: 'el rm --cached falló' }; }
  }
  if (kept.length) {
    try { git(dir, ['checkout', '-q', 'HEAD', '--', ...kept], { timeout: 15000 }); } catch {
      return gone.length
        ? { stuck: true, unstuck: false, partial: true, files, gone, reason: `saqué del índice ${gone.join(', ')} (lo publicado los borró; tu versión quedó en el disco), pero el checkout de ${kept.join(', ')} falló` }
        : { stuck: true, unstuck: false, files, gone: [], reason: 'el checkout falló' };
    }
  }
  return { stuck: true, unstuck: true, files, gone };
}

/** Lo que traba el avance: trackeados modificados que también cambian, y no-trackeados que origin agrega. */
function collidingFiles(git, dir) {
  try {
    const local = new Set(lines(git(dir, ['diff', '--name-only', 'HEAD'])));
    const untracked = new Set(lines(git(dir, ['ls-files', '--others', '--exclude-standard'])));
    const upstream = lines(git(dir, ['diff', '--name-only', 'HEAD', 'origin/main']));
    return { tracked: upstream.filter((f) => local.has(f)), untracked: upstream.filter((f) => untracked.has(f)) };
  } catch {
    return { tracked: [], untracked: [] };
  }
}

/**
 * Avanza a origin/main sin red: stash propio (sólo si hay cambios trackeados), merge --ff-only, pop.
 *
 * 🔴 Y los NO TRACKEADOS que lo publicado agrega (2026-09-06). git se niega a pisar un archivo no
 * trackeado —«untracked working tree files would be overwritten by merge»— y `stash push` SIN `-u`
 * no los ve: `--autostash` tampoco. Resultado medido: una máquina del equipo quedó 158 commits
 * atrás, trabada sesión tras sesión por `.dashboard/sdlc-stage-<fecha>.json`, que el respaldo local
 * del medidor escribe al arrancar y el nocturno commitea. El caso se repite en TODA máquina que
 * abra sesión antes de que llegue el arreglo del respaldo — y ese arreglo viaja por el pull que
 * este archivo destraba, así que sin esto el círculo no se corta solo.
 * Se guardan SÓLO esos archivos (pathspec), en su propio stash, y NO se reaplican: lo que viene de
 * lo publicado es lo bueno (lo escribió el nocturno), y lo local queda recuperable con `stash list`.
 *
 * @returns {{kept: boolean, guardados: string[]}} kept = lo local no se pudo reaplicar y quedó en el
 *   stash · guardados = los no trackeados que se apartaron para poder avanzar
 */
function advance(git, dir) {
  const dirty = lines(git(dir, ['status', '--porcelain', '--untracked-files=no'])).length > 0;
  let stashed = false;
  const guardados = [];
  // primero los no trackeados que chocan: si no, el merge ni arranca. SÓLO los REGENERABLES: un
  // archivo que el dev escribió es trabajo suyo y no se toca (caso H5, que sigue avisando y dando el
  // comando). Lo de `.dashboard/` no es trabajo de nadie: lo produce el nocturno, se commitea para
  // que todas las máquinas lean la misma foto, y el respaldo local lo re-escribe en cada arranque —
  // por eso trababa el clon sesión tras sesión y ninguna mano lo iba a mover.
  for (const f of collidingFiles(git, dir).untracked.filter((x) => REGENERABLES.some((re) => re.test(x)))) {
    try {
      git(dir, ['stash', 'push', '-q', '-u', '-m', `${STASH_MSG} (no trackeado que lo publicado agrega)`, '--', f]);
      guardados.push(f);
    } catch { /* no se pudo apartar: el merge dirá que no puede, y se avisa con el detalle */ }
  }
  if (dirty) { git(dir, ['stash', 'push', '-q', '-m', STASH_MSG]); stashed = true; }
  try {
    git(dir, ['merge', '-q', '--ff-only', 'origin/main'], { timeout: 30000 });
  } catch (e) {
    if (stashed) { try { git(dir, ['stash', 'pop', '-q']); } catch { /* queda en el stash; se avisa */ } }
    e.guardados = guardados;   // lo apartado sigue a salvo en el stash aunque el merge no haya entrado
    throw e;
  }
  if (!stashed) return { kept: false, guardados };
  try {
    git(dir, ['stash', 'pop', '-q']);
    return { kept: false, guardados };
  } catch {
    // El pop chocó: git deja el índice en conflicto y el stash guardado. Se limpia; lo local
    // sigue en el stash (verificado por el fixture: reset --hard no lo toca).
    try { git(dir, ['reset', '-q', '--hard', 'HEAD'], { timeout: 15000 }); } catch { /* se avisa igual */ }
    return { kept: true, guardados };
  }
}

/**
 * La guarda (story 8.18 del arnés, AC 34). Desde la unión de los dos repos internos el clon del arnés trae `skills/`, y
 * en una máquina de un solo árbol es EL LUGAR del que salen las skills (`~/.claude/agent-skills` y `~/.claude/skills`
 * apuntan a él). Si `main` vuelve a un árbol de antes de la unión —el plan de retorno—, avanzar ese clon deja a la
 * máquina sin skills: sin pipeline, sin revisores, y sin esta misma sanadora. Esta pieza es el tercer actualizador (los
 * otros dos, `harness.js update` y el respaldo en shell del arranque, tienen la misma guarda): no avanza, y lo dice.
 * En la máquina de dos clones las skills salen del OTRO clon, y éste sigue a `main` como siempre.
 *
 * Tres respuestas, como `bringsSkills`: `comes: true` · `false` · `null` = no se pudo mirar (`error` dice qué y por qué).
 * Antes eran dos: si `~/.claude/agent-skills` no se dejaba resolver (un enlace a una carpeta sin permisos, un disco que
 * no responde) daba «son dos clones», y la sanadora avanzaba a una punta sin skills (story 8.18 del arnés, tramo 3 ·
 * segunda vuelta del revisor de fallos silenciosos). Un ENOENT sí es una respuesta: ese enlace no está.
 * @returns {{comes: boolean|null, error: string|null}}
 */
function skillsOrigin(dir, home) {
  const gone = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
  const blindOf = (p, e) => `${p} (${(e && (e.code || e.message)) || e})`;
  const real = (p) => { try { return { at: fs.realpathSync(p) }; } catch (e) { return gone(e) ? { at: null } : { error: blindOf(p, e) }; } };
  // «Es el mismo clon» se decide por QUÉ carpeta es (dispositivo e inodo), no por cómo está escrita su ruta: en un
  // disco que no distingue mayúsculas, un enlace escrito con otra caja nombra el mismo clon, y letra por letra daba
  // «son dos clones» — la guarda no corría (story 8.18 del arnés, tramo 3: la clase 14 del pase adversarial, acá).
  // Si el disco no da esa identidad, vale la ruta real, como antes.
  const identity = (p) => { try { const st = fs.statSync(p, { bigint: true }); return { id: st.ino ? `${st.dev}:${st.ino}` : null }; } catch (e) { return { error: blindOf(p, e) }; } };
  const d = real(dir);
  if (d.error) return { comes: null, error: d.error };
  if (!d.at) return { comes: false, error: null };
  const dId = identity(d.at);
  if (dId.error) return { comes: null, error: dId.error };
  const isClone = (p) => {
    if (!dId.id) return { yes: p === d.at };
    const i = identity(p);
    return i.error ? { error: i.error } : { yes: i.id ? i.id === dId.id : p === d.at };
  };
  // un «sí» por cualquiera de los dos caminos alcanza; un «no pude mirar» sólo pesa si ninguno dijo que sí
  let blind = null;
  const agentSkills = real(path.join(home, '.claude', 'agent-skills'));
  if (agentSkills.error) blind = agentSkills.error;
  else if (agentSkills.at) {
    const c = isClone(agentSkills.at);
    if (c.yes) return { comes: true, error: null };
    if (c.error) blind = c.error;
  }
  // ~/.claude/skills → <clon>/skills (o más adentro): alguna carpeta madre ES el clon
  const skills = real(path.join(home, '.claude', 'skills'));
  if (skills.error) blind = blind || skills.error;
  else if (skills.at) {
    for (let p = path.dirname(skills.at); ; p = path.dirname(p)) {
      const c = isClone(p);
      if (c.yes) return { comes: true, error: null };
      if (c.error) { blind = blind || c.error; break; }
      if (path.dirname(p) === p) break;
    }
  }
  return blind ? { comes: null, error: blind } : { comes: false, error: null };
}
/** Lo mismo, en `true` / `false` / `null` = no se pudo mirar (no es «de acá no salen»). */
function skillsComeFrom(dir, home) { return skillsOrigin(dir, home).comes; }
const SKILLS_MARK = 'skills/tycon-pipeline';
/**
 * ¿El árbol de ese commit trae `skills/tycon-pipeline`? Tres respuestas, como `hasSkills()` de repoint.js del arnés:
 * `true` (lo trae) · `false` (git contestó y no lo trae) · `null` (git no pudo contestar: NO se sabe; `error` trae lo
 * que dijo). Antes eran dos —con `cat-file -e`, que sale ≠ 0 en los dos casos—, y «no pude mirar» se leía como «no lo
 * trae»: con el árbol de HEAD sin leer la sanadora entendía «de esta copia no salen las skills» y avanzaba, a una punta
 * sin skills (story 8.18, tramo 3 · revisor de fallos silenciosos, 2026-10-04).
 * @returns {{brings: boolean|null, error: string|null}}
 */
function bringsSkills(git, dir, rev) {
  try {
    const out = git(dir, ['ls-tree', '-d', '--name-only', `${rev}^{tree}`, '--', SKILLS_MARK]);
    return { brings: lines(out).map((l) => l.trim()).includes(SKILLS_MARK), error: null };
  } catch (e) {
    const said = lines((e && e.stderr) || (e && e.message)).map((l) => l.trim()).find(Boolean);
    return { brings: null, error: said || 'git no contestó' };
  }
}

function hasCmd(name) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function runInstallerDetached(dir, logDir, env) {
  const win = process.platform === 'win32';
  const installer = path.join(dir, 'scripts', win ? 'install-tycon-hooks.ps1' : 'install-tycon-hooks.sh');
  if (!fs.existsSync(installer)) return false;
  if (env.TYCON_NO_AUTOINSTALL === '1') return false;
  if (win && !hasCmd('pwsh')) return false; // el .ps1 requiere PowerShell ≥6.2; con 5.1 moriría al arrancar
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, `installer-${Date.now()}.log`), 'a');
    const [bin, args] = win
      ? ['pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer]]
      : ['bash', [installer]];
    const child = spawn(bin, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true, env });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Consejo manual que funciona en el estado real del clon (git rechaza `stash` sobre un índice en conflicto). */
function manualAdvice(git, dir, collide) {
  const unmerged = unmergedStages(git, dir);
  const stuck = unmerged.length > 0 && OUR_STASH_RE.test(stashTop(git, dir));
  const d = sh(dir);
  const steps = [];
  // El mismo consejo que el aviso de arranque (branch-guard-notice.js): un comando por tipo de conflicto, citado, y
  // `git stash` si lo que el dev tocó después de trabarse choca con lo publicado (story 8.5.1 del arnés).
  if (stuck) {
    const gone = unmerged.filter((u) => !u.inHead).map((u) => sh(u.file));
    const kept = unmerged.filter((u) => u.inHead).map((u) => sh(u.file));
    if (gone.length) steps.push(`git -C ${d} rm --cached -- ${gone.join(' ')}   # los que lo publicado borró: tu versión queda en el disco y en el stash`);
    if (kept.length) steps.push(`git -C ${d} checkout HEAD -- ${kept.join(' ')}   # sólo los archivos en conflicto; lo tuyo ya está en el stash (git stash list)`);
    const inConflict = new Set(unmerged.map((u) => u.file));
    if (collide && collide.tracked.some((f) => !inConflict.has(f))) steps.push(`git -C ${d} stash   # lo que tocaste después y lo publicado cambia`);
  } else steps.push(`git -C ${d} stash`);
  if (collide && collide.untracked.length) steps.push(`mové o borrá: ${collide.untracked.join(', ')}   # no trackeados que lo publicado agrega`);
  steps.push(`git -C ${d} merge --ff-only origin/main`);
  return steps.join('\n   ');
}

/**
 * @param {{sessionId: string, stateDir: string, env?: NodeJS.ProcessEnv, home?: string}} p  `home`: la carpeta de la
 *   persona (para saber de qué clon salen las skills); por defecto, la de la sesión
 * @returns {string|null} aviso para el dev (null = nada que decir)
 */
function heal({ sessionId, stateDir, env = process.env, home = os.homedir() } = {}) {
  if (env.TYCON_GUIDES_HEAL === '0') return null;
  const dir = repoDir(env);
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const git = makeGit(env);

  const stamp = stampPath(stateDir, sessionId);
  if (fs.existsSync(stamp)) return null;
  // El sello se escribe ANTES de trabajar: si algo cuelga o falla, no se reintenta en cada prompt.
  const record = (r) => {
    try {
      fs.mkdirSync(path.dirname(stamp), { recursive: true });
      fs.writeFileSync(stamp, JSON.stringify(Object.assign({ at: new Date().toISOString(), repo: dir }, r)) + '\n');
    } catch { /* fail-open */ }
  };
  record({ result: 'started' });
  if (!fs.existsSync(stamp)) return null; // no pude sellar → no arriesgo repetir el trabajo en cada prompt
  pruneStamps(path.dirname(stamp));

  // story 8.13 (tanda A, AC 9): con el estado del mecanismo de instalación nuevo (`harness-state.json`, lo escribe
  // `scripts/setup/harness.js` del arnés) la actualización de los dos repos la hace `harness.js startup` desde la copia fija
  // de arranque, y esta sanadora se hace a un lado: registra `delegated` y no toca git. Un estado ILEGIBLE tampoco es «sin
  // estado» (8.3 AC 2): también se hace a un lado, y lo registra como `broken` — arreglarlo es de `harness.js doctor`. Sin
  // estado, lo de hoy. La referencia entre repos tolera las dos situaciones hasta el retiro (regla «entre repos» de la 8.9).
  const hs = harnessState(stateDir);
  if (hs) { record({ result: 'delegated', state: hs }); return null; }

  let branch;
  try { branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { record({ result: 'no-git' }); return null; }
  if (branch !== 'main') { record({ result: 'not-main', branch }); return null; } // eso ya lo grita branch-guard-notice

  // 0. Trabado por un autostash que no pudo reaplicarse (del arranque, o de una corrida anterior).
  let un = null;
  try { un = unstick(git, dir); } catch { un = null; }
  const unstuckLine = un && un.unstuck
    ? `\n   Estaba TRABADO: el arranque había guardado tus cambios aparte y dejado ${un.files.join(', ')} en conflicto — lo destrabé; lo tuyo sigue en \`git -C ${sh(dir)} stash list\`${un.gone && un.gone.length ? ` (y ${un.gone.join(', ')}, que lo publicado borró, quedó en el disco sin trackear)` : ''}.`
    : '';
  if (un && !un.unstuck) {
    record({ result: 'stuck', files: un.files, reason: un.reason, ...(un.partial ? { partial: true, gone: un.gone } : {}) });
    return `🔧 TYCON — tu copia del arnés está TRABADA: ${un.files.join(', ')} en conflicto (${un.reason}). ${un.partial ? 'La destrabé a medias y no sigo' : 'No la toco'}. A mano: git -C ${sh(dir)} status`;
  }

  // Trabado, el pull del arranque muere ANTES de fetchear ("unmerged files") → origin/main puede
  // estar viejo. Es el único estado en que se sabe con certeza que no hubo fetch: acá sí se sale a
  // la red (hallazgo H9 de la segunda pasada: sin esto, "al día pero trabada" podía ser falso y el
  // instalador nuevo se posponía una sesión).
  if (un && un.unstuck) {
    try { git(dir, ['fetch', '--quiet', 'origin', 'main'], { timeout: 15000 }); } catch { /* sin red: seguimos con lo que hay */ }
  }

  let behind = 0;
  try { behind = count(git, dir, 'HEAD..origin/main'); } catch { record({ result: 'no-origin' }); return null; }
  if (behind === 0) {
    fetchIfStale(git, dir);
    try { behind = count(git, dir, 'HEAD..origin/main'); } catch { behind = 0; }
    if (behind === 0) {
      if (un && un.unstuck) {
        record({ result: 'unstuck', files: un.files });
        return `🔧 TYCON — tu copia del arnés estaba al día pero TRABADA.${unstuckLine}\n   Decíselo al dev en una línea.`;
      }
      record({ result: 'up-to-date' });
      return null;
    }
  }

  // La guarda (story 8.18, AC 34): si de este clon salen las skills y lo publicado ya no las trae, no se avanza. Y si
  // no se pudo MIRAR —el árbol de HEAD o el de lo publicado— tampoco: no saber no es «no las trae» ni «de acá no salen».
  // Y si no se pudo mirar DE DÓNDE salen las skills, tampoco se avanza: puede ser de esta copia.
  const origin = skillsOrigin(dir, home);
  if (origin.comes === null) {
    record({ result: 'skills-unknown', rev: null, what: 'origin', error: origin.error, behind, unstuck: !!(un && un.unstuck) });
    return `🔧 TYCON — no pude mirar si de esta copia salen las skills de esta máquina: no se pudo resolver ${origin.error}. La copia es el arnés (${dir}), está ${behind} commit(s) atrás de lo publicado, y sin saberlo no la avanzo: las skills siguen.${unstuckLine}\n   Decíselo al dev en una línea. Cuando esa ruta se pueda mirar, la próxima sesión decide sola.`;
  }
  if (origin.comes) {
    const here = bringsSkills(git, dir, 'HEAD');
    const published = here.brings === false ? null : bringsSkills(git, dir, 'origin/main');
    const blind = here.brings === null ? { rev: 'HEAD', what: 'esta copia', error: here.error }
      : (published && published.brings === null ? { rev: 'origin/main', what: 'lo publicado', error: published.error } : null);
    if (blind) {
      record({ result: 'skills-unknown', rev: blind.rev, error: blind.error, behind, unstuck: !!(un && un.unstuck) });
      return `🔧 TYCON — no pude mirar si ${blind.what} (${blind.rev}) trae las skills: git no leyó su árbol (${blind.error}). De esta copia del arnés (${dir}) salen las skills de esta máquina, y sin saberlo no la avanzo: las skills siguen.${unstuckLine}\n   Decíselo al dev en una línea. Cuando este comando conteste, la próxima sesión decide sola; el error se ve con:\n   git -C ${sh(dir)} ls-tree -d --name-only '${blind.rev}^{tree}' -- ${SKILLS_MARK}`;
    }
    if (here.brings && published && published.brings === false) {
      record({ result: 'no-skills', behind, unstuck: !!(un && un.unstuck) });
      return `🔧 TYCON — la versión nueva no trae las skills: no se aplica. Lo publicado del arnés (origin/main, ${behind} commit(s) adelante) ya no trae skills/tycon-pipeline, y de esta copia (${dir}) salen las skills de esta máquina: no la avanzo, y las skills siguen.${unstuckLine}\n   Decíselo al dev en una línea: es un retorno de main; cuando lo publicado vuelva a traerlas, se actualiza sola.`;
    }
  }

  let ahead = 0;
  try { ahead = count(git, dir, 'origin/main..HEAD'); } catch { /* 0 */ }
  let headDate = '';
  try { headDate = git(dir, ['log', '-1', '--format=%ad', '--date=short']); } catch { /* opcional */ }
  const collide = collidingFiles(git, dir);
  const porElCapturer = collide.tracked.some((b) => b.endsWith('guide-update-proposals.md'));
  const trabas = [
    collide.tracked.length ? `${collide.tracked.join(', ')} — modificado en esta máquina${porElCapturer ? ' (guide-update-proposals.md lo escribió el capturador de retrospectivas, no vos)' : ''}` : '',
    collide.untracked.length ? `${collide.untracked.join(', ')} — no trackeado acá y lo publicado lo agrega` : '',
  ].filter(Boolean);
  const why = trabas.length ? `\n   Lo que traba el avance: ${trabas.join('; ')}.` : '';
  const head = `🔧 TYCON — tu copia del arnés está ${behind} commit(s) atrás de lo publicado (parada en el ${headDate || '?'}) y el arranque no la actualiza — en silencio.`;

  if (ahead > 0) {
    record({ result: 'diverged', behind, ahead, blockers: collide, unstuck: !!(un && un.unstuck) });
    return `${head}${why}${unstuckLine}\n   Además tiene ${ahead} commit(s) locales que no están en origin: no la toco. Resolvelo a mano: git -C ${dir} status`;
  }

  let adv;
  try {
    adv = advance(git, dir);
  } catch (e) {
    const first = String((e && e.stderr) || (e && e.message) || '').split('\n').find((l) => l.trim()) || 'sin detalle';
    record({ result: 'pull-failed', behind, blockers: collide, error: first, unstuck: !!(un && un.unstuck) });
    return `${head}${why}${unstuckLine}\n   Intenté actualizarla y no pude: ${first}\n   A mano:\n   ${manualAdvice(git, dir, collide)}`;
  }

  const installerRan = runInstallerDetached(dir, path.join(stateDir, 'guides-heal'), env);
  record({ result: 'healed', behind, blockers: collide, stashed: adv.kept, installerRan, unstuck: !!(un && un.unstuck) });

  return [
    `🔧 TYCON — tu copia del arnés estaba ${behind} commit(s) atrás de lo publicado (parada en el ${headDate || '?'}): el arranque intentaba actualizarla y no podía, en silencio.${why}${unstuckLine}`,
    `   La acabo de poner al día${installerRan ? ' y el instalador nuevo está corriendo en segundo plano' : ''}.`,
    adv.kept ? `   ⚠️ Lo que tenías modificado no se pudo reaplicar sobre lo nuevo: quedó a salvo en \`git -C ${dir} stash list\` (recuperalo con stash pop, o descartalo con stash drop).` : '',
    adv.guardados && adv.guardados.length ? `   ℹ️ Aparté ${adv.guardados.join(', ')} (estaban sin trackear acá y lo publicado los agrega: era lo que trababa el avance). Lo que viene de lo publicado es lo bueno; tu copia quedó guardada en \`git -C ${dir} stash list\`.` : '',
    `   Los controles nuevos quedan activos al abrir la PRÓXIMA sesión (Claude Code lee los hooks al arrancar). Decíselo al dev en una línea.`,
  ].filter(Boolean).join('\n');
}

module.exports = { heal, unstick, collidingFiles, advance, manualAdvice, repoDir, stampPath, harnessState, skillsComeFrom, skillsOrigin, FETCH_STALE_DAYS, STASH_MSG, REGENERABLES };

if (require.main === module) {
  const stateDir = path.join(stateDirOf(os.homedir()));
  const { resolveSessionId } = require('./session-id.js');
  const notice = heal({ sessionId: resolveSessionId(null), stateDir });
  if (notice) process.stdout.write(notice + '\n');
}
