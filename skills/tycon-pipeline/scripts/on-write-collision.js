#!/usr/bin/env node
/**
 * tycon-pipeline PreToolUse hook — Write/Edit cross-session collision detection.
 *
 * Defensa en profundidad: actúa cuando la detección entre sesiones de `on-prompt.js`
 * falló (el usuario ignoró el reminder).
 *
 * Triggered ANTES de cada Write|Edit. Detecta el patrón "estoy por crear/modificar
 * un archivo que ya fue tocado por OTRA sesión del pipeline".
 *
 * Lógica:
 *   1. Resolver session_id del evento + file_path del tool_input.
 *   2. Leer TODOS los markers activos no-stale.
 *   3. Para cada marker de OTRA sesión:
 *      a) Si file_path está en m.filesTouched → COLLISION HIGH (otra sesión
 *         creó/modificó este archivo, casi seguro estás por sobreescribir).
 *      b) Si file_path NO está en m.filesTouched pero el archivo EXISTE en
 *         filesystem Y la otra sesión está activa con la misma story → COLLISION
 *         LOW (puede ser file inocente o reciente create).
 *   4. Devolver <system-reminder> con la lista de sesiones en conflicto.
 *
 * Hook output NO bloquea (exit 0 siempre) — es advisory. El agente debe leer
 * el reminder y decidir.
 *
 * `handle(event)` exportable para que el dispatcher
 * lo corra in-process (1 spawn node por evento en vez de 1 por hook). El shim CLI
 * del fondo preserva el comportamiento standalone idéntico (backward compat + tests).
 *
 * Performance: lecturas O(N_markers) con N≤10 sesiones simultáneas en práctica,
 * sub-ms. No agrega latencia perceptible al Write/Edit.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // la carpeta del estado, de una sola pieza
// Las formas de una ruta de Windows. Sin la lib, la comparación de siempre.
let nativePath = (p) => p;
try { ({ nativePath } = require('./lib/path-shape.js')); } catch { /* sin normalización de rutas: se compara el texto */ }

/**
 * ¿Las dos rutas nombran el mismo archivo? Fuera de Windows, texto contra texto, como siempre. En Windows el mismo
 * archivo se escribe de varias formas (`C:\a\b`, `C:/a/b`, `/c/a/b`, con otras mayúsculas): comparadas como texto, lo
 * que anotó una sesión y lo que trae el evento de otra pueden no coincidir y el aviso no sale.
 */
function samePath(a, b, platform = process.platform) {
  if (platform !== 'win32') return a === b;
  return String(nativePath(a, platform)).toLowerCase() === String(nativePath(b, platform)).toLowerCase();
}

const STATE_DIR = path.join(stateDirOf(os.homedir()));
const ACTIVE_DIR = path.join(STATE_DIR, 'active');
const STALE_HOURS = 24;

function listActiveMarkers() {
  if (!fs.existsSync(ACTIVE_DIR)) return [];
  const cutoff = Date.now() - STALE_HOURS * 3600 * 1000;
  let files = [];
  try { files = fs.readdirSync(ACTIVE_DIR); } catch { return []; }
  const markers = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(ACTIVE_DIR, f), 'utf8'));
      if (!m || !m.storyId) continue;
      if (m.lastTouch && new Date(m.lastTouch).getTime() < cutoff) continue;
      markers.push(m);
    } catch { /* ignore */ }
  }
  return markers;
}

/**
 * Handler dispatchable. Recibe el evento RAW de Claude Code y devuelve:
 *   null               → nada que decir (exit 0)
 *   { reminder: text } → advisory (el caller envuelve en <system-reminder>)
 * Nunca bloquea (este hook es advisory).
 */
function handle(rawEvent) {
  const data = rawEvent || {};
  const toolInput = data.tool_input || {};
  const event = {
    sessionId: data.session_id || '_nosession',
    toolName: data.tool_name || '',
    filePath: toolInput.file_path || '',
  };

  if (!event.filePath) return null;
  if (!['Write', 'Edit'].includes(event.toolName)) return null;
  // Solo aplica si EL filepath es absoluto (paths relativos no se pueden comparar
  // con filesTouched que son absolutos).
  if (!path.isAbsolute(event.filePath)) return null;

  const allMarkers = listActiveMarkers();
  const ownMarker = allMarkers.find((m) => m.sessionId === event.sessionId);
  const otherMarkers = allMarkers.filter((m) => m.sessionId !== event.sessionId);

  if (otherMarkers.length === 0) return null;

  // HIGH collision: filePath está en filesTouched de otra sesión.
  const highConflicts = otherMarkers.filter(
    (m) => Array.isArray(m.filesTouched) && m.filesTouched.some((f) => samePath(f, event.filePath)),
  );

  if (highConflicts.length > 0) {
    const lines = highConflicts
      .map((m) => {
        const sid8 = (m.sessionId || '').slice(0, 8);
        return `  • sessionId=${sid8}… storyId=${m.storyId} lastTouch=${m.lastTouch}`;
      })
      .join('\n');
    return {
      reminder:
        `🛑 tycon-pipeline COLLISION (HIGH): el archivo que vas a ${event.toolName.toLowerCase()} ` +
        `ya fue tocado por otra sesión del pipeline:\n\n` +
        `   filePath: ${event.filePath}\n\n` +
        `Sesion${highConflicts.length > 1 ? 'es' : ''} en conflicto:\n` +
        lines +
        `\n\n🔴 Casi seguro estás por sobreescribir trabajo no commiteado. Antes de continuar:\n` +
        `   1. \`git status\` en el repo del archivo — verificá si está sin commitear.\n` +
        `   2. Si es continuación legítima de la otra sesión: \n` +
        `      mem_search query="Story <id> session_summary" para cargar contexto,\n` +
        `      después seteá marker en tu sessionId y NO recrees el archivo.\n` +
        `   3. Si la otra sesión está muerta: \n` +
        `      marker.js clear-session <sessionId>\n\n` +
        `Si confirmás que el Write/Edit es correcto, ignorá este reminder y continuá. ` +
        `Pero NO ignorás "por defecto" — el caso disparador real (Story 4.2 2026-05-20) ` +
        `perdió ~40min por exactamente este patrón.`,
    };
  }

  // LOW collision: archivo no está en filesTouched, pero EXISTE en filesystem Y
  // hay otra sesión con marker activo. Solo emit si el agente está creando (Write)
  // un archivo que ya existe — caso clásico "una sesión lo creó pero su marker no
  // alcanzó a registrarlo aún" (race window).
  if (event.toolName === 'Write' && fs.existsSync(event.filePath)) {
    // Solo si hay marker propio (estoy en un pipeline) — sino es noise.
    if (ownMarker) {
      const lines = otherMarkers
        .map((m) => {
          const sid8 = (m.sessionId || '').slice(0, 8);
          return `  • sessionId=${sid8}… storyId=${m.storyId} repoPath=${m.repoPath} lastTouch=${m.lastTouch}`;
        })
        .join('\n');
      return {
        reminder:
          `⚠️ tycon-pipeline COLLISION (LOW): vas a Write un archivo que YA EXISTE en filesystem, ` +
          `y hay ${otherMarkers.length} sesión${otherMarkers.length > 1 ? 'es' : ''} ` +
          `del pipeline activa${otherMarkers.length > 1 ? 's' : ''}:\n\n` +
          `   filePath: ${event.filePath}\n\n` +
          `Otras sesiones activas:\n` +
          lines +
          `\n\nNo está en filesTouched de esas sesiones pero podría ser:\n` +
          `   • Archivo recién creado por otra sesión cuyo marker aún no se actualizó.\n` +
          `   • Archivo legitimamente compartido (CLAUDE.md, package.json, etc.) — OK.\n\n` +
          `Si querés Edit en vez de Write (preservar contenido existente), considerá Read primero. ` +
          `Si Write es intencional (overwrite total), confirmá que el archivo existente no es de otra sesión.`,
      };
    }
  }

  return null;
}

module.exports = { handle, samePath };

// ── CLI shim (standalone) — preserva el comportamiento standalone ──
if (require.main === module) {
  let raw = null;
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    raw = stdin ? JSON.parse(stdin) : null;
  } catch {
    raw = null;
  }
  const r = handle(raw);
  if (r && r.reminder) {
    process.stdout.write(`<system-reminder>\n${r.reminder}\n</system-reminder>\n`);
  }
  process.exit(0);
}
