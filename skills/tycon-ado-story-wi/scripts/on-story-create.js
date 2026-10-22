#!/usr/bin/env node
/**
 * tycon-ado-story-wi — PostToolUse hook (matcher: Write).
 *
 * Cuando el agente hace Write de un archivo `.md`, detecta si es una story
 * Mary+GOLD recién creada SIN `work_item:` (ni su nombre viejo `ado_work_item:`) en el frontmatter. Si lo es,
 * emite un system-reminder instruyendo crear el work item en Azure DevOps
 * via el skill `tycon-ado-story-wi`.
 *
 * Detección por CONTENIDO, no por path — así funciona en TODOS los proyectos
 * TYCON sin mantener una lista de directorios de stories.
 *
 * El hook NO crea el WI: corre no-interactivo. Solo dispara. La creación
 * efectiva (con confirmación del dev) la hace el agente al leer el reminder.
 *
 * Por qué `Write` y no `Edit|Write`: una story se CREA con un Write (primer
 * volcado del archivo). Los Edit posteriores (status updates, Dev Agent
 * Record) no deben re-disparar. El guard `sin work_item:` es defensa
 * adicional contra re-triggers.
 *
 * Output: system-reminder en stdout o nada. Exit 0 siempre (no bloqueante).
 *
 * Schema del evento Claude Code PostToolUse Write (stdin):
 *   {
 *     "hook_event_name": "PostToolUse",
 *     "tool_name": "Write",
 *     "tool_input": { "file_path": "/abs/path/file.md", "content": "..." },
 *     "session_id": "..."
 *   }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function readEvent() {
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (!stdin) return null;
    return JSON.parse(stdin);
  } catch {
    return null;
  }
}

function emit(reminder) {
  process.stdout.write(`<system-reminder>\n${reminder}\n</system-reminder>\n`);
}

/**
 * Extrae el primer bloque de frontmatter YAML (`---` ... `---`) del contenido.
 * El frontmatter DEBE estar al inicio del archivo (tras un posible BOM).
 * Devuelve el texto del bloque, o null si no hay frontmatter al inicio.
 *
 * Esto descarta automáticamente docs como `story-format.md` (empieza con `#`,
 * los ejemplos de frontmatter están dentro de fences ```yaml).
 */
function extractFrontmatter(content) {
  if (!content) return null;
  const trimmed = content.replace(/^﻿/, '');
  if (!trimmed.startsWith('---')) return null;
  const end = trimmed.indexOf('\n---', 3);
  if (end < 0) return null;
  return trimmed.slice(3, end);
}

// ============================================================
// Main
// ============================================================

const event = readEvent();
if (!event) process.exit(0);
if (event.tool_name !== 'Write') process.exit(0);

const ti = event.tool_input || {};
const filePath = ti.file_path || '';
const content = ti.content || '';

if (!filePath.endsWith('.md')) process.exit(0);

// Skip tooling/config — no son stories de implementación.
const home = os.homedir();
if (filePath.startsWith(path.join(home, '.claude'))) process.exit(0);
// el arnés por cualquiera de sus dos nombres, como segmento de ruta (escritos acá: las skills pueden
// vivir en un clon aparte sin scripts/ al lado — copia declarada en scripts/tests/fixtures/harness-place-names.json)
if (/(^|[\\/])(tycon-claude-guides|tycon-harness)([\\/]|$)/.test(filePath)) process.exit(0);

const fm = extractFrontmatter(content);
if (!fm) process.exit(0);

// Firma Mary+GOLD: una story tiene epic + story + status + approach.
// `[ \t]*` y no `\s*`: un campo vacío seguido de otra clave no cuenta como presente (`\s` cruzaría el salto de línea)
const hasStory = /^story:[ \t]*\S/m.test(fm);
const hasEpic = /^epic:[ \t]*\S/m.test(fm);
const hasStatus = /^status:[ \t]*\S/m.test(fm);
const hasApproach = /^approach:[ \t]*\S/m.test(fm);
if (!(hasStory && hasEpic && hasStatus && hasApproach)) process.exit(0);

// Ya linkeada → nada que hacer (también evita re-trigger en re-writes). El campo, con su nombre o el viejo, y con
// cualquier valor (también `TBD`: alguien ya lo anotó). Los dos nombres los da el lector del arnés; una skill que vive
// en un clon aparte, sin scripts/ al lado, usa los mismos dos escritos acá.
let nombres = ['work_item', 'ado_work_item'];
try {
  const CAMPO = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'platform', 'work-item-field.js'));
  nombres = [CAMPO.NAME, CAMPO.LEGACY];
} catch { /* sin el arnés al lado: los nombres escritos arriba */ }
if (new RegExp(`^(${nombres.join('|')}):[ \\t]*\\S`, 'm').test(fm)) process.exit(0);

// Extraer story id + título para el reminder.
const storyMatch = fm.match(/^story:\s*"?([^"\n]+)"?/m);
const titleMatch = fm.match(/^title:\s*"?([^"\n]+)"?/m);
const storyId = storyMatch ? storyMatch[1].trim() : path.basename(filePath, '.md');
const title = titleMatch ? titleMatch[1].trim() : '(sin título)';

emit(
  `tycon-ado-story-wi STORY-CREATE-detect: se creó una story Mary+GOLD sin ` +
    `\`work_item:\` en el frontmatter.\n\n` +
    `   • Story: ${storyId} — ${title}\n` +
    `   • Archivo: ${filePath}\n\n` +
    `Acción: crear el pedido de trabajo de esta story en la plataforma del equipo. Invocá el skill:\n` +
    `   Skill(skill="tycon-ado-story-wi", args="${filePath}")\n\n` +
    `El skill lee dónde van los pedidos del repo (\`.tycon/work-items.yaml\`, o \`.tycon/ado-config.yaml\` ` +
    `con el nombre viejo), te muestra título, tipo y destino y PIDE TU CONFIRMACIÓN antes de crear; ` +
    `la creación la hace la capa de plataforma. Tras crear, escribe \`work_item: <id>\` de vuelta ` +
    `en este frontmatter.\n\n` +
    `Si este repo no lleva pedidos de trabajo, o la organización no eligió plataforma, el skill lo dice ` +
    `en una línea y sigue (no bloquea nada).\n` +
    `Si se crearon VARIAS stories de una (ej: bmad-create-epics-and-stories), invocá el ` +
    `skill UNA sola vez — escanea el directorio y procesa en batch todas las que falten ` +
    `\`work_item:\`.`,
);

process.exit(0);
