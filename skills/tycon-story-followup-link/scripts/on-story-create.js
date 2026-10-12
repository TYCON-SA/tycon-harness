#!/usr/bin/env node
/**
 * tycon-story-followup-link — PostToolUse hook (matcher: Write).
 *
 * Cuando el agente hace Write de un archivo `.md` que es una story Mary+GOLD
 * nueva CON campo `followup_of:` en el frontmatter, detecta las stories padre,
 * verifica si ya tienen el back-link `followed_up_by:` apuntando a esta story,
 * y emite un system-reminder para que el agente actualice las padres que
 * falten.
 *
 * El hook NO escribe los back-links — corre no-interactivo, solo dispara. La
 * escritura efectiva (con confirmación del dev) la hace el agente al leer el
 * reminder.
 *
 * Convención: `~/.claude/tycon-harness/story-format.md` §1.2.
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
 */
function extractFrontmatter(content) {
  if (!content) return null;
  const trimmed = content.replace(/^﻿/, '');
  if (!trimmed.startsWith('---')) return null;
  const end = trimmed.indexOf('\n---', 3);
  if (end < 0) return null;
  return trimmed.slice(3, end);
}

/**
 * Parser minimalista de YAML para el campo `followup_of:` — soporta:
 *
 *   followup_of:
 *     - id: "3.2"
 *       type: "fix"
 *       summary: "..."
 *     - id: "13.3.4"
 *       type: "fix"
 *       summary: "..."
 *
 * 0-deps a propósito (el hook no debe requerir npm install). Devuelve array
 * de {id, type, summary} (campos opcionales pueden faltar). Retorna [] si el
 * campo no existe.
 */
function parseFollowupOf(fm) {
  const startMatch = fm.match(/^followup_of:\s*$/m);
  if (!startMatch) return [];
  const startIdx = startMatch.index + startMatch[0].length;
  const rest = fm.slice(startIdx);
  const lines = rest.split('\n').slice(1); // Skip first newline after the field name
  const blockLines = [];
  for (const line of lines) {
    // Línea sin indentación que parece otra clave del frontmatter → fin del bloque
    if (/^[^\s-].*:/.test(line)) break;
    if (/^---\s*$/.test(line)) break;
    blockLines.push(line);
  }
  const items = [];
  let current = null;
  for (const line of blockLines) {
    const startItemMatch = line.match(/^\s*-\s*id:\s*"?([^"\n]+?)"?\s*$/);
    if (startItemMatch) {
      if (current) items.push(current);
      current = { id: startItemMatch[1].trim() };
      continue;
    }
    if (!current) continue;
    const typeMatch = line.match(/^\s*type:\s*"?([^"\n]+?)"?\s*$/);
    if (typeMatch) {
      current.type = typeMatch[1].trim();
      continue;
    }
    const summaryMatch = line.match(/^\s*summary:\s*"?([^"\n]+?)"?\s*$/);
    if (summaryMatch) {
      current.summary = summaryMatch[1].trim();
      continue;
    }
  }
  if (current) items.push(current);
  return items;
}

/**
 * Busca el archivo `.md` en `dir` cuyo frontmatter declara `story: "<parentId>"`.
 * Retorna abspath o null. Convención: el id se matchea contra el campo
 * `story:` del frontmatter, NO contra el filename — porque los filenames usan
 * guiones (`3-2-confirmacion-...`) y los ids usan puntos (`3.2`).
 */
function findParentStoryFile(dir, parentId) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  for (const f of files) {
    const abs = path.join(dir, f);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const fm = extractFrontmatter(content);
    if (!fm) continue;
    const storyMatch = fm.match(/^story:\s*"?([^"\n]+?)"?\s*$/m);
    if (!storyMatch) continue;
    if (storyMatch[1].trim() === parentId) return abs;
  }
  return null;
}

/**
 * Check si el frontmatter de la padre contiene un entry de `followed_up_by:`
 * con `id` == childStoryId. Idempotencia del back-link.
 */
function parentHasBacklink(parentAbs, childStoryId) {
  let content;
  try {
    content = fs.readFileSync(parentAbs, 'utf8');
  } catch {
    return false;
  }
  const fm = extractFrontmatter(content);
  if (!fm) return false;
  const startMatch = fm.match(/^followed_up_by:\s*$/m);
  if (!startMatch) return false;
  const startIdx = startMatch.index + startMatch[0].length;
  const rest = fm.slice(startIdx);
  const lines = rest.split('\n').slice(1);
  for (const line of lines) {
    if (/^[^\s-].*:/.test(line)) break;
    if (/^---\s*$/.test(line)) break;
    const idMatch = line.match(/^\s*-\s*id:\s*"?([^"\n]+?)"?\s*$/);
    if (idMatch && idMatch[1].trim() === childStoryId) return true;
  }
  return false;
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

const home = os.homedir();
if (filePath.startsWith(path.join(home, '.claude'))) process.exit(0);
// el arnés por cualquiera de sus dos nombres, como segmento de ruta (story 8.19, AC 12; escritos acá: las skills pueden
// vivir en un clon aparte sin scripts/ al lado — copia declarada en scripts/tests/fixtures/harness-place-names.json)
if (/(^|[\\/])(tycon-claude-guides|tycon-harness)([\\/]|$)/.test(filePath)) process.exit(0);

const fm = extractFrontmatter(content);
if (!fm) process.exit(0);

const hasStory = /^story:\s*\S/m.test(fm);
const hasEpic = /^epic:\s*\S/m.test(fm);
const hasStatus = /^status:\s*\S/m.test(fm);
if (!(hasStory && hasEpic && hasStatus)) process.exit(0);

const items = parseFollowupOf(fm);
if (items.length === 0) process.exit(0);

const storyMatch = fm.match(/^story:\s*"?([^"\n]+?)"?\s*$/m);
const titleMatch = fm.match(/^title:\s*"?([^"\n]+?)"?\s*$/m);
const childStoryId = storyMatch ? storyMatch[1].trim() : path.basename(filePath, '.md');
const childTitle = titleMatch ? titleMatch[1].trim() : '(sin título)';

const storyDir = path.dirname(filePath);
const parentsMissingBacklink = [];
const parentsNotFound = [];
for (const item of items) {
  if (!item.id) continue;
  const parentAbs = findParentStoryFile(storyDir, item.id);
  if (!parentAbs) {
    parentsNotFound.push(item.id);
    continue;
  }
  if (parentHasBacklink(parentAbs, childStoryId)) continue;
  parentsMissingBacklink.push({ id: item.id, path: parentAbs, item });
}

if (parentsMissingBacklink.length === 0 && parentsNotFound.length === 0) {
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const out = [];
out.push(
  `tycon-story-followup-link STORY-FOLLOWUP-detect: se creó una story con \`followup_of:\` ` +
    `pero las stories PADRE todavía no tienen el back-link \`followed_up_by:\`.\n`,
);
out.push(`   • Story hija: ${childStoryId} — ${childTitle}`);
out.push(`   • Archivo: ${filePath}\n`);

if (parentsMissingBacklink.length > 0) {
  out.push(`Padres a actualizar (agregar back-link \`followed_up_by:\` en su frontmatter):`);
  for (const p of parentsMissingBacklink) {
    const sumExcerpt = (p.item.summary || '').slice(0, 90);
    out.push(`   • ${p.id} → ${p.path}`);
    out.push(`     type: ${p.item.type || '(falta — pedir al dev)'} · summary: ${sumExcerpt}`);
  }
  out.push('');
  out.push(`Acción: para CADA padre, agregar este entry al campo \`followed_up_by:\` del frontmatter:`);
  out.push('');
  out.push('```yaml');
  out.push('followed_up_by:');
  out.push(`  - id: "${childStoryId}"`);
  out.push(`    date: "${today}"`);
  const firstItem = parentsMissingBacklink[0].item;
  out.push(`    type: "${firstItem.type || 'fix'}"`);
  const sum = (firstItem.summary || '...').replace(/"/g, "'");
  out.push(`    summary: "${sum}"`);
  out.push('```');
  out.push('');
  out.push(
    `Notas para el agente:\n` +
      `  1. Si la padre YA tiene un campo \`followed_up_by:\` con OTROS entries, ` +
      `AGREGÁ esta entry como nuevo bullet (no reemplaces el bloque entero).\n` +
      `  2. Si la padre NO tiene \`followed_up_by:\`, agregá el campo nuevo al frontmatter ` +
      `(después de \`followup_of:\` si la padre lo tiene, o después de \`depends_on:\` en ` +
      `cualquier caso).\n` +
      `  3. PEDÍ CONFIRMACIÓN al dev antes de editar cada padre — mostrale el patch propuesto. ` +
      `Si la padre es de un sprint firmado con cliente, el dev puede preferir loguear el ` +
      `cambio en su Change Log también.\n` +
      `  4. Si el \`summary\` del followup_of de la hija no describe bien el cambio, pedí al ` +
      `dev que lo aclare antes de propagarlo a la padre (single-source-of-truth — la prosa ` +
      `del back-link sale del followup_of, no se inventa).`,
  );
}

if (parentsNotFound.length > 0) {
  out.push('');
  out.push(
    `⚠ Padres declarados en \`followup_of:\` pero no encontrados en ${storyDir}: ${parentsNotFound.join(', ')}`,
  );
  out.push(
    `Verificá: (a) el id en \`followup_of:\` está bien escrito y matchea el campo ` +
      `\`story:\` del frontmatter de la padre (NO el filename), (b) la padre está en este ` +
      `mismo directorio. Si la padre vive en otro repo/path, el back-link no se puede ` +
      `mantener automáticamente — documentalo en prosa en la sección "Follow-ups y cambios ` +
      `post-firma" de la padre.`,
  );
}

out.push('');
out.push(
  `Si esto es un falso positivo (la story NO es follow-up sino solo dependency normal), ` +
    `remové el campo \`followup_of:\` y dejá solo \`depends_on:\`. Ver story-format.md §1.2 ` +
    `para la diferencia.`,
);

emit(out.join('\n'));
process.exit(0);
