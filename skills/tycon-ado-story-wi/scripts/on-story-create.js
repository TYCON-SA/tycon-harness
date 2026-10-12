#!/usr/bin/env node
/**
 * tycon-ado-story-wi — PostToolUse hook (matcher: Write).
 *
 * Cuando el agente hace Write de un archivo `.md`, detecta si es una story
 * Mary+GOLD recién creada SIN `ado_work_item:` en el frontmatter. Si lo es,
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
 * Record) no deben re-disparar. El guard `sin ado_work_item:` es defensa
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
// el arnés por cualquiera de sus dos nombres, como segmento de ruta (story 8.19, AC 12; escritos acá: las skills pueden
// vivir en un clon aparte sin scripts/ al lado — copia declarada en scripts/tests/fixtures/harness-place-names.json)
if (/(^|[\\/])(tycon-claude-guides|tycon-harness)([\\/]|$)/.test(filePath)) process.exit(0);

const fm = extractFrontmatter(content);
if (!fm) process.exit(0);

// Firma Mary+GOLD: una story tiene epic + story + status + approach.
const hasStory = /^story:\s*\S/m.test(fm);
const hasEpic = /^epic:\s*\S/m.test(fm);
const hasStatus = /^status:\s*\S/m.test(fm);
const hasApproach = /^approach:\s*\S/m.test(fm);
if (!(hasStory && hasEpic && hasStatus && hasApproach)) process.exit(0);

// Ya linkeada → nada que hacer (también evita re-trigger en re-writes).
if (/^ado_work_item:\s*\S/m.test(fm)) process.exit(0);

// Extraer story id + título para el reminder.
const storyMatch = fm.match(/^story:\s*"?([^"\n]+)"?/m);
const titleMatch = fm.match(/^title:\s*"?([^"\n]+)"?/m);
const storyId = storyMatch ? storyMatch[1].trim() : path.basename(filePath, '.md');
const title = titleMatch ? titleMatch[1].trim() : '(sin título)';

emit(
  `tycon-ado-story-wi STORY-CREATE-detect: se creó una story Mary+GOLD sin ` +
    `\`ado_work_item:\` en el frontmatter.\n\n` +
    `   • Story: ${storyId} — ${title}\n` +
    `   • Archivo: ${filePath}\n\n` +
    `Acción: crear el work item en Azure DevOps para esta story. Invocá el skill:\n` +
    `   Skill(skill="tycon-ado-story-wi", args="${filePath}")\n\n` +
    `El skill resuelve la config ADO del repo (\`.tycon/ado-config.yaml\`), detecta el ` +
    `tipo de WI por process template, te muestra título/tipo/proyecto destino y PIDE TU ` +
    `CONFIRMACIÓN antes de crear. Tras crear, escribe \`ado_work_item: <id>\` de vuelta ` +
    `en este frontmatter.\n\n` +
    `Si este repo NO trackea en ADO → el skill hace silent-skip al no resolver config ` +
    `(no bloquea nada).\n` +
    `Si se crearon VARIAS stories de una (ej: bmad-create-epics-and-stories), invocá el ` +
    `skill UNA sola vez — escanea el directorio y procesa en batch todas las que falten ` +
    `\`ado_work_item:\`.`,
);

process.exit(0);
