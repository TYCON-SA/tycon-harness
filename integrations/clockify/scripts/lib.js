// integrations/clockify/scripts/lib.js — helpers compartidos por sweep.js, on-prompt.js, touch-activity.js y on-work.js
// Cross-platform (Mac/Linux/Windows). Solo depende de Node stdlib.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude', 'clocki');
// Per-session active timer files: ~/.claude/clocki/active/<sessionId>.json
// Cada sesión escribe SOLO su propio archivo → cero contención read-modify-write
// sobre un archivo compartido (evita la condición de carrera).
const ACTIVE_DIR = path.join(STATE_DIR, 'active');
// Archivo legacy single-file. readActive() lo sigue mergeando
// para no perder timers abiertos durante la transición; los writes nuevos NO lo tocan.
const LEGACY_ACTIVE_PATH = path.join(STATE_DIR, 'active.json');
// Heartbeat per-session: ~/.claude/clocki/heartbeat/<sessionId> — timestamp
// local-bare del último hook de clocki que corrió en esa sesión. Señal de
// LIVENESS independiente del timer: el sweep la usa para NO cerrar timers de
// sesiones vivas cuyo `lastActivity` luzca stale (un timer legacy con lastActivity
// congelado se cerraría estando la sesión viva).
const HEARTBEAT_DIR = path.join(STATE_DIR, 'heartbeat');
const CACHE_PATH = path.join(STATE_DIR, 'project-cache.json');
const SETTINGS_PATH = path.join(STATE_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  idleTimeoutMinutes: 15,
  // Minutos sin heartbeat para dar una sesión por MUERTA y poder cerrar su timer
  // huérfano (sweep.js). Alto a propósito: TODOS los hooks de clocki tocan el
  // heartbeat, así que una sesión realmente viva lo refresca a cada rato — 2h de
  // silencio absoluto no es "está pensando", es que no está. Subilo si trabajás
  // con ventanas abiertas e inactivas por horas y no querés que les cierre el timer
  // (aunque el cierre trimea a lastActivity: no perdés tiempo real, solo tenés que
  // reabrir al volver).
  deadSessionMinutes: 120,
  defaultWorkspaceId: null,
  // 🔴 PRECISION-FIRST keywords: solo imperativos / first-person plural
  // verbos de acción concreta. Quedan fuera: "story", "task", "tarea", "review", "revisar",
  // "plan", "planning", "analyze", "design", "investigar" — generan ruido extremo
  // matcheando charla conversacional ("revisar X", "el plan de Y", "la story quedó bien").
  // Pattern: imperatives + first-person plural en español ("X-emos") y "let's X" en inglés.
  intentKeywords: [
    // ES imperativos
    'implementemos', 'implementar', 'implementá',
    'fixeemos', 'fixear', 'arreglemos', 'arreglá', 'arreglar',
    'refactoricemos', 'refactorizar', 'refactoreá',
    'agreguemos', 'agregá',
    'trabajemos', 'trabajá',
    'codeemos', 'codeá', 'codeemos',
    'empecemos', 'arranquemos', 'arrancá con',
    'creemos', 'creá',
    'corregamos', 'corregir',
    // EN imperatives
    "let's implement", "let's fix", "let's refactor", "let's build", "let's add",
    "let's create", "let's start", "let's code", "let's work on",
    'implement this', 'fix this bug', 'refactor this', 'build this',
    // Phrases específicas TYCON (deben acompañarse de objeto)
    'implementemos la story', 'implementemos el',
    'fix bug', 'bug fix',
  ],
  // 🔴 STOP keywords: detectan fin/transición de trabajo.
  // Si hay timer activo Y prompt contiene alguno, emitir reminder de cierre/transición.
  stopKeywords: [
    'listo', 'ya está', 'ya esta', 'ya quedó', 'ya quedo',
    'terminamos', 'terminé', 'termine', 'finalizado',
    'cerremos', 'cerrá', 'cerralo', 'cerrá timer', 'cerrar timer', 'cerralo',
    'done', "we're done", 'task done', 'task complete',
    'mergeado', 'pusheado', 'commit y push', 'committed',
    'merge a main', '/merge', '/merge-to-main', 'mergear a main',
    'PR creado', 'PR listo',
    '/clocki stop', 'stop timer', 'stop clocki',
    // Cambio de tarea explícito
    'ahora hagamos', 'ahora con', 'siguiente tarea', 'next task',
    'pasemos a', 'cambiemos a',
  ],
};

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function readJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_err) {
    return fallback;
  }
}

function writeJsonAtomic(p, obj) {
  ensureStateDir();
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function ensureActiveDir() {
  if (!fs.existsSync(ACTIVE_DIR)) {
    fs.mkdirSync(ACTIVE_DIR, { recursive: true });
  }
}

// sessionId → path del archivo de esa sesión. Sanitiza separadores por las dudas.
function sessionFilePath(sessionId) {
  const safe = String(sessionId || '_nosession').replace(/[/\\]/g, '_');
  return path.join(ACTIVE_DIR, `${safe}.json`);
}

// Timers de UNA sesión: `{ cwd: entry }`. Es el archivo que esa sesión lee/escribe.
function readSessionActive(sessionId) {
  return readJson(sessionFilePath(sessionId), {});
}

// Escribe (atómico) el archivo de UNA sesión. Si queda vacío, borra el archivo.
// Solo la propia sesión escribe su archivo → no hay race con otras sesiones.
function writeSessionActive(sessionId, obj) {
  ensureActiveDir();
  const p = sessionFilePath(sessionId);
  if (!obj || Object.keys(obj).length === 0) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return;
  }
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// ─── Heartbeat (liveness de sesión) ──────────────────────────────────────────
// Una sesión está "viva" si corrió algún hook de clocki hace < idleTimeout.
// touch-activity / on-prompt / sweep / clocki-enforce escriben su heartbeat en
// cada invocación. Es la señal que distingue "timer idle de sesión muerta"
// (cerrable) de "timer idle de sesión viva trabajando" (NO cerrable).

function ensureHeartbeatDir() {
  if (!fs.existsSync(HEARTBEAT_DIR)) fs.mkdirSync(HEARTBEAT_DIR, { recursive: true });
}

function heartbeatPath(sessionId) {
  const safe = String(sessionId || '_nosession').replace(/[/\\]/g, '_');
  return path.join(HEARTBEAT_DIR, safe);
}

// Marca la sesión como viva AHORA. La llaman TODOS los hooks de clocki. Nunca
// tira — el tracking no debe romper un hook.
function touchHeartbeat(sessionId) {
  if (!sessionId) return;
  try {
    ensureHeartbeatDir();
    fs.writeFileSync(heartbeatPath(sessionId), nowIso(), 'utf8');
  } catch (_err) { /* no-op */ }
}

// Minutos desde el último heartbeat de la sesión. Infinity si no hay heartbeat
// (sesión sin liveness conocida → tratable como muerta). `_legacy` nunca tiene
// heartbeat (no es una sesión real) → Infinity.
function heartbeatIdleMinutes(sessionId) {
  if (!sessionId || sessionId === '_legacy') return Infinity;
  try {
    const raw = fs.readFileSync(heartbeatPath(sessionId), 'utf8').trim();
    if (!raw) return Infinity;
    return minutesBetween(raw, nowIso());
  } catch (_err) {
    return Infinity;  // archivo ausente o ilegible
  }
}

// Housekeeping: borra heartbeats con idle > maxAgeMinutes (default 24h). Mantiene
// el dir chico sin necesidad de un hook SessionEnd.
function cleanStaleHeartbeats(maxAgeMinutes) {
  const limit = maxAgeMinutes || 1440;
  try {
    if (!fs.existsSync(HEARTBEAT_DIR)) return;
    for (const f of fs.readdirSync(HEARTBEAT_DIR)) {
      const p = path.join(HEARTBEAT_DIR, f);
      try {
        const raw = fs.readFileSync(p, 'utf8').trim();
        if (!raw || minutesBetween(raw, nowIso()) > limit) fs.unlinkSync(p);
      } catch (_err) { /* archivo raro — ignorar */ }
    }
  } catch (_err) { /* no-op */ }
}

// Housekeeping: borra los archivos de active/ que quedaron VACÍOS ({}). Cada sesión
// deja el suyo al cerrar su timer y nadie los junta, y se acumulan por decenas. No
// hacen daño, pero entierran la señal: cuesta ver los pocos timers reales entre tantos archivos.
//
// Sólo toca archivos que parsean a objeto vacío Y con mtime viejo (default 24h), para
// no correr una carrera contra una sesión que está justo entre create y write.
// JAMÁS toca un archivo con contenido — ahí puede haber un timer de otra sesión.
function cleanEmptyActiveFiles(maxAgeMinutes) {
  const limit = maxAgeMinutes || 1440;
  let removed = 0;
  try {
    if (!fs.existsSync(ACTIVE_DIR)) return 0;
    for (const f of fs.readdirSync(ACTIVE_DIR)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(ACTIVE_DIR, f);
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length > 0) continue;
        const ageMin = (Date.now() - fs.statSync(p).mtimeMs) / 60000;
        if (ageMin <= limit) continue;
        fs.unlinkSync(p);
        removed++;
      } catch (_err) { /* ilegible: no tocar — puede ser un write a medias */ }
    }
  } catch (_err) { /* no-op */ }
  return removed;
}

/**
 * Migra una entry que vive en el `active.json` legacy al archivo per-session de
 * su sesión, refrescando `lastActivity`.
 *
 * Por qué existe: touch-activity SOLO escribe archivos per-session. Una entry
 * que quedó en el legacy (sesión que abrió el timer con el clocki viejo, o cuyo
 * `start` corrió antes del formato per-session) nunca vería su `lastActivity`
 * actualizado → falso idle → el sweep la cerraría aunque la sesión estuviera
 * VIVA. La migración cierra ese gap: tras el
 * primer touch, la entry vive en per-session y se actualiza normal.
 *
 * Solo migra entries con un sessionId real (no `_legacy` — ése no es una sesión).
 * Retorna true si migró.
 */
function migrateLegacyEntry(sessionId, cwd, entry) {
  if (!sessionId || sessionId === '_legacy' || !cwd || !entry || !entry.entryId) {
    return false;
  }
  // 1. Escribir en el archivo per-session con lastActivity fresco.
  const sessionObj = readSessionActive(sessionId);
  sessionObj[cwd] = { ...entry, lastActivity: nowIso() };
  writeSessionActive(sessionId, sessionObj);
  // 2. Drenar la entry del legacy active.json. Si esto falla, el per-session ya
  //    quedó escrito y readActive() lo prioriza sobre el legacy (ver orden de
  //    merge abajo) → la migración es self-healing: se reintenta en cada touch.
  try {
    const legacy = readJson(LEGACY_ACTIVE_PATH, {});
    const node = legacy[cwd];
    if (node && typeof node === 'object') {
      if (node.entryId) {
        delete legacy[cwd];                 // formato oldest {cwd:entry}
      } else {
        delete node[sessionId];             // formato {cwd:{sid:entry}}
        if (Object.keys(node).length === 0) delete legacy[cwd];
      }
    }
    if (Object.keys(legacy).length === 0) {
      if (fs.existsSync(LEGACY_ACTIVE_PATH)) fs.unlinkSync(LEGACY_ACTIVE_PATH);
    } else {
      writeJsonAtomic(LEGACY_ACTIVE_PATH, legacy);
    }
  } catch (_err) { /* el per-session ya está; el legacy se limpia en otro pase */ }
  return true;
}

/**
 * Vista unificada de TODOS los timers activos, keyada `{ cwd: { sessionId: entry } }`.
 *
 * Mergea el `active.json` legacy single-file — que pudo quedar en formato
 * `{cwd:entry}` (oldest) o `{cwd:{sid:entry}}` (intermedio) — y cada
 * `active/<sessionId>.json` (formato per-session). Tras el merge la
 * estructura es uniforme `{cwd:{sid:entry}}`.
 *
 * 🔴 Orden de merge: legacy PRIMERO, per-session DESPUÉS. Así, si un (cwd,sid)
 * existe en ambos (entry migrada pero el borrado del legacy falló), la copia
 * per-session — fresca — sobrescribe a la legacy — stale. Ver migrateLegacyEntry.
 *
 * Los WRITES nunca pasan por acá: cada sesión escribe su archivo con
 * writeSessionActive(). readActive() es solo-lectura/merge → sin race.
 */
function readActive() {
  const merged = {};
  const add = (cwd, sid, entry) => {
    if (!cwd || !entry || !entry.entryId) return;
    (merged[cwd] = merged[cwd] || {})[sid] = entry;
  };
  // (a) legacy single-file (transición — readonly). PRIMERO → lo pisa per-session.
  const legacy = readJson(LEGACY_ACTIVE_PATH, {});
  for (const [cwd, node] of Object.entries(legacy)) {
    if (!node || typeof node !== 'object') continue;
    if (node.entryId) {
      add(cwd, '_legacy', node);            // formato oldest {cwd:entry}
    } else {
      for (const [sid, entry] of Object.entries(node)) add(cwd, sid, entry);
    }
  }
  // (b) archivos per-session. DESPUÉS → ganan sobre el legacy en caso de conflicto.
  if (fs.existsSync(ACTIVE_DIR)) {
    let files = [];
    try { files = fs.readdirSync(ACTIVE_DIR); } catch (_e) { files = []; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const sid = f.slice(0, -5);
      const data = readJson(path.join(ACTIVE_DIR, f), {});
      for (const [cwd, entry] of Object.entries(data)) add(cwd, sid, entry);
    }
  }
  return merged;
}

// Entry de una sesión dentro de un nodo cwd de la vista unificada, o null.
function getSessionEntry(node, sessionId) {
  if (!node || typeof node !== 'object' || !sessionId) return null;
  const entry = node[sessionId];
  return entry && entry.entryId ? entry : null;
}

// Aplana la vista unificada a una lista `[{ cwd, sessionId, entry }]`. Usado por el sweep.
function flattenActive(active) {
  const out = [];
  if (!active || typeof active !== 'object') return out;
  for (const [cwd, node] of Object.entries(active)) {
    if (!node || typeof node !== 'object') continue;
    for (const [sid, entry] of Object.entries(node)) {
      if (entry && entry.entryId) out.push({ cwd, sessionId: sid, entry });
    }
  }
  return out;
}

/**
 * Busca el timer activo de UNA sesión para `cwd`, con walk-up por parents.
 *
 * Caso de uso: el usuario abre timer en `/Users/x/Proyectos/Repo` (monorepo root)
 * pero hace edits en `/Users/x/Proyectos/Repo/SubProject/src/...`. La key del timer
 * NO matchea el cwd reportado por el hook (que es subdir). Sin walk-up, el sistema
 * cree que no hay timer activo y emite reminders falsos.
 *
 * Opera sobre la vista unificada de `readActive()`. El match está scopeado al
 * `sessionId` — si otra sesión tiene un timer en el mismo cwd, NO se devuelve.
 *
 * Retorna `{ matchedKey, sessionId, entry }` o `null`.
 */
function findActiveEntryForCwd(active, cwd, sessionId) {
  if (!active || !cwd || !sessionId) return null;
  let current = cwd;
  const seen = new Set();
  while (current && current !== '' && !seen.has(current)) {
    seen.add(current);
    const entry = getSessionEntry(active[current], sessionId);
    if (entry) return { matchedKey: current, sessionId, entry };
    // Subir un nivel. path.dirname devuelve el parent, o el mismo dir si ya está en root.
    const parent = path.dirname(current);
    if (parent === current) break;  // raíz alcanzada
    current = normalizeCwd(parent);
  }
  return null;
}

function readSettings() {
  const fromDisk = readJson(SETTINGS_PATH, {});
  const merged = { ...DEFAULT_SETTINGS, ...fromDisk };
  // 🔴 Footgun guard: un `[]` en disco para las listas de keywords NO
  // significa "sin keywords" — significa "no configurado". Sin esta guarda, un
  // settings.json con `intentKeywords: []` (lo que sembraría el installer) dejaría que
  // el consumidor cayera a una lista ANCHA hardcodeada → falsos positivos sobre
  // charla/meta-discusión (ej: "plan", "fix", "add"). Array vacío o no-array → narrow default.
  if (!Array.isArray(merged.intentKeywords) || merged.intentKeywords.length === 0) {
    merged.intentKeywords = DEFAULT_SETTINGS.intentKeywords;
  }
  if (!Array.isArray(merged.stopKeywords) || merged.stopKeywords.length === 0) {
    merged.stopKeywords = DEFAULT_SETTINGS.stopKeywords;
  }
  return merged;
}

function readProjectCache() {
  return readJson(CACHE_PATH, {});
}

// Normaliza un cwd para usarlo como key consistente.
// - lowercase de drive letter en Windows
// - separadores forward-slash uniformes
// - trailing slash removido
function normalizeCwd(cwd) {
  if (!cwd) return '';
  let p = path.normalize(cwd).replace(/\\/g, '/');
  if (process.platform === 'win32' && /^[a-z]:/i.test(p)) {
    p = p[0].toLowerCase() + p.slice(1);
  }
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

// Timestamp actual en hora LOCAL, formato bare `YYYY-MM-DDTHH:MM:SS` (sin offset,
// sin `Z`). Es el formato que espera el MCP de Clockify (`start`/`end` en "Local
// timezone" — el MCP convierte local→UTC al guardar). active.json guarda local bare
// para que `end = lastActivity` se pueda pasar directo al MCP sin conversión.
// 🔴 NO usar `toISOString()` (UTC con Z): pasar ese valor al MCP lo interpreta como
// local y la entry queda corrida por el offset (en Argentina, UTC-3).
function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function readStdinSync() {
  try {
    const data = fs.readFileSync(0, 'utf8');
    return data;
  } catch (_err) {
    return '';
  }
}

function parseHookInput() {
  const raw = readStdinSync();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return {};
  }
}

function minutesBetween(isoA, isoB) {
  const a = new Date(isoA).getTime();
  const b = new Date(isoB).getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.abs(b - a) / 60000;
}

// Emite un bloque de system-reminder por stdout. Claude Code lo inyecta en contexto.
function emitReminder(text) {
  process.stdout.write(`<system-reminder>\n${text.trim()}\n</system-reminder>\n`);
}

module.exports = {
  STATE_DIR,
  ACTIVE_DIR,
  LEGACY_ACTIVE_PATH,
  HEARTBEAT_DIR,
  CACHE_PATH,
  SETTINGS_PATH,
  ensureStateDir,
  ensureActiveDir,
  readJson,
  writeJsonAtomic,
  sessionFilePath,
  readSessionActive,
  writeSessionActive,
  readActive,
  readSettings,
  readProjectCache,
  normalizeCwd,
  nowIso,
  parseHookInput,
  minutesBetween,
  emitReminder,
  findActiveEntryForCwd,
  getSessionEntry,
  flattenActive,
  ensureHeartbeatDir,
  heartbeatPath,
  touchHeartbeat,
  heartbeatIdleMinutes,
  cleanStaleHeartbeats,
  cleanEmptyActiveFiles,
  migrateLegacyEntry,
};
